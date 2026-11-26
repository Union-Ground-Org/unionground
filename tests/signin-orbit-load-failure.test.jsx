import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AltSignedOut from "../src/alt/AltSignedOut.jsx";
import { AuthScreen } from "../src/components/AuthScreen.jsx";
import { RootErrorBoundary } from "../src/components/RootErrorBoundary.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";

// Gate round 1 on #8669 (UX-UG-SIGN-IN-FORM-WITH-ORBIT-STORY-SIDE-20261113):
// at desktop width a failed download of the decorative orbit must leave the
// sign-in form in place. The orbit module's import rejects here as a chunk
// that will not load does; the screen sits under the real root boundary, as
// in main.jsx, so an escaped failure would replace the form with its fallback.
vi.mock("../src/components/SignInOrbit.jsx", () => Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/SignInOrbit.js")));

const captureViewError = vi.fn();
vi.mock("../src/lib/deferredObservability.js", async (importOriginal) => ({
  ...(await importOriginal()),
  captureViewError: (error) => captureViewError(error),
}));

const signInCalls = [];
beforeEach(() => {
  signInCalls.length = 0;
  captureViewError.mockClear();
  vi.stubGlobal("matchMedia", vi.fn((query) => ({ media: query, matches: query.includes("min-width"), addEventListener() {}, removeEventListener() {} })));
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (String(url).includes("/api/auth-password-signin")) {
      signInCalls.push(JSON.parse(init.body));
      return { ok: false, status: 401, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({ providers: {}, released: { apple: false, google: false, sso: false } }) };
  }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("a failed orbit download at desktop width", () => {
  it("draws no orbit, reports the failure once, and keeps the form usable", async () => {
    const client = { auth: { setSession: vi.fn(), signInWithPasskey: vi.fn() } };
    const { container } = render(
      <RootErrorBoundary fallback={<p>root crash</p>}>
        <LanguageProvider lang="en"><AltSignedOut><AuthScreen client={client} lang="en" /></AltSignedOut></LanguageProvider>
      </RootErrorBoundary>,
    );
    await waitFor(() => expect(captureViewError).toHaveBeenCalledTimes(1));
    // Vitest wraps the rejected module factory in its own error; the failed import is what arrives.
    expect(captureViewError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(screen.queryByText("root crash")).toBeNull();
    expect(container.querySelector(".sgauth-orbit")).toBeNull();
    expect(container.querySelector(".ug-signin-story-stage")).toBeEmptyDOMElement();

    fireEvent.change(container.querySelector('input[name="email"]'), { target: { value: "member@tamarack.example" } });
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: "not-the-right-one" } });
    const submit = screen.getByRole("button", { name: catalogue.en["auth.passwordCta"] });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent(catalogue.en["auth.passwordFailed"]);
    expect(signInCalls).toEqual([{ email: "member@tamarack.example", password: "not-the-right-one" }]);
    expect(screen.queryByText("root crash")).toBeNull();
  });
});
