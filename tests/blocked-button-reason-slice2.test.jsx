// #9458 web slice 2: W1-7 create account, W1-5 delete phrase. (W3b-1 Set PIN is
// left out of Union Ground with the member PIN.)
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { openSignupCatalogue } from "../src/lib/i18n/openSignup.js";
import { OpenSignupView } from "../src/views/OpenSignupView.jsx";
import { DeleteAccountDialog } from "../src/views/ProductHubView.jsx";

const described = node => (node.getAttribute("aria-describedby") || "").split(" ").filter(Boolean)
  .map(id => document.getElementById(id)?.textContent || "").join(" ");
const type = (name, value) => fireEvent.change(document.querySelector(`[name="${name}"]`), { target: { value } });
const wrap = (lang, node) => render(<LanguageProvider lang={lang}>{node}</LanguageProvider>);

describe.each(["en", "es"])("web slice 2 (%s)", lang => {
  const T = (key, params) => t(lang, key, params);

  it("W1-7: Create account names what is still missing, and an expired check", async () => {
    const widget = { render: vi.fn((_node, options) => { widget.options = options; return "w"; }), reset: vi.fn(), remove: vi.fn() };
    const fetcher = vi.fn();
    const view = l => <LanguageProvider lang={l}><OpenSignupView available siteKey="k" fetcher={fetcher} loadWidget={() => Promise.resolve(widget)} /></LanguageProvider>;
    const { container, rerender } = render(view(lang));
    const send = screen.getByRole("button", { name: T("signup.submit") });
    expect(send).toBeEnabled();
    expect(described(send)).toContain(`${T("signup.missing.email")} ${T("signup.missing.agree")} ${T("signup.missing.state")} ${T("signup.missing.check")}`);
    type("email", "person@example.invalid");
    fireEvent.click(container.querySelector('[name="acceptedTerms"]'));
    type("residenceState", "CA");
    expect(described(send)).toContain(`${T("signup.missing.age")} ${T("signup.missing.check")}`);
    fireEvent.click(container.querySelector('[name="ageAttested"]'));
    fireEvent.click(send);
    expect(screen.getByRole("alert")).toHaveTextContent(T("signup.missing.check"));
    container.querySelector("form").requestSubmit();
    await waitFor(() => expect(widget.render).toHaveBeenCalled());
    act(() => widget.options.callback("token"));
    expect(send).not.toHaveAttribute("aria-disabled");
    act(() => widget.options["expired-callback"]());
    expect(described(send)).toContain(T("signup.missing.checkExpired"));
    const other = lang === "en" ? "es" : "en";
    rerender(view(other));
    expect(described(send)).toContain(t(other, "signup.missing.check"));
    expect(described(send)).not.toContain(t(other, "signup.missing.checkExpired"));
    expect(fetcher).not.toHaveBeenCalled();
    expect(openSignupCatalogue[lang]["signup.missing.checkExpired"]).toBe(T("signup.missing.checkExpired"));
  });

  it("W1-5: Delete permanently says the phrase must match exactly, without changing the match", () => {
    const onDelete = vi.fn();
    wrap(lang, <DeleteAccountDialog t={T} onClose={vi.fn()} onDelete={onDelete} onIndeterminateClose={vi.fn()} />);
    const remove = screen.getByRole("button", { name: T("hub.lifecycle.deletePermanent") });
    const box = screen.getByRole("textbox");
    expect(box).toHaveAttribute("autocapitalize", "characters");
    expect(described(remove)).toBe(T("hub.lifecycle.deletePhraseEmpty"));
    fireEvent.change(box, { target: { value: "delete my account " } });
    expect(described(remove)).toBe(T("hub.lifecycle.deletePhraseMismatch"));
    fireEvent.click(remove);
    expect(screen.getByRole("alert")).toHaveTextContent(T("hub.lifecycle.deletePhraseMismatch"));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: "DELETE MY ACCOUNT" } });
    expect(remove).not.toHaveAttribute("aria-disabled");
  });

});
