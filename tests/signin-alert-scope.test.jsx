import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthScreen } from "../src/components/AuthScreen.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(["en", "es"])("password alert stays beside its recovery link (%s)", (lang) => {
  it("keeps a reset path visible after a rejected password", async () => {
    const copy = catalogue[lang];
    const grant = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", grant);
    const client = { auth: { setSession: vi.fn() } };
    const { container } = render(<LanguageProvider lang={lang}><AuthScreen client={client} lang={lang} /></LanguageProvider>);
    fireEvent.change(screen.getByLabelText(copy["auth.email"]), { target: { value: "member@example.invalid" } });
    fireEvent.change(screen.getByLabelText(copy["auth.password"]), { target: { value: "wrong-password" } });
    fireEvent.submit(container.querySelector("form"));

    const alert = await screen.findByRole("alert");
    const reset = screen.getByRole("link", { name: copy["auth.forgotPassword"] });
    expect(alert).toHaveTextContent(copy["auth.passwordFailed"]);
    expect(reset).toBeVisible();
    expect(reset).toHaveAttribute("href", "/reset-password");
    expect(alert.compareDocumentPosition(reset) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(client.auth.setSession).not.toHaveBeenCalled();
  });
});
