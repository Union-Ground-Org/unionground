import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthScreen } from "../src/components/AuthScreen.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";

afterEach(() => vi.unstubAllGlobals());

// Upstream's sign-in card leads with Apple and Google and folds the password
// form, PIN, single sign-on and passkey behind one disclosure. This edition
// signs in with email and password only, so the card has no disclosure; the
// password form shows directly and its reset link follows a failed sign-in.
describe("sign-in method disclosure", () => {
  it.each(["en", "es"])("makes password reset the next link after a failed sign-in (%s)", async (lang) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const { container } = render(<LanguageProvider lang={lang}><AuthScreen client={{ auth: {} }} lang={lang} /></LanguageProvider>);
    expect(screen.queryByRole("button", { name: catalogue[lang]["auth.otherMethods"] })).toBeNull();
    fireEvent.change(container.querySelector('input[name="email"]'), { target: { value: "member@example.invalid" } });
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: "wrong-password" } });
    fireEvent.submit(container.querySelector("form"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(catalogue[lang]["auth.passwordFailed"]);
    const nextLink = Array.from(container.querySelectorAll("a")).find(link =>
      alert.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(nextLink).toHaveAttribute("href", "/reset-password");
  });
});
