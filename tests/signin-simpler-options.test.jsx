import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthScreen } from "../src/components/AuthScreen.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(["en", "es"])("password-only sign-in options (%s)", (lang) => {
  it("keeps recovery as the first link after the form and publishes no federated control", () => {
    const copy = catalogue[lang];
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<LanguageProvider lang={lang}><AuthScreen client={{ auth: { setSession: vi.fn() } }} lang={lang} /></LanguageProvider>);
    const card = screen.getByRole("region", { name: copy["auth.passwordTitle"] });
    const view = within(card);
    expect(view.getByLabelText(copy["auth.password"])).toBeVisible();
    expect(view.getAllByRole("link")[0]).toHaveAttribute("href", "/reset-password");
    expect(view.getByText(copy["auth.recoveryHelp"])).toBeVisible();
    for (const key of ["appleCta", "googleCta", "ssoCta", "passkeyCta", "pinUsePin", "otherMethods"]) {
      const name = copy[`auth.${key}`];
      expect(name, key).toBeTruthy();
      expect(view.queryByRole("button", { name })).toBeNull();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
