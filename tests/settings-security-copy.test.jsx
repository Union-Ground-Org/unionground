// REQ-UG-PASSWORD-RULE-AND-TWO-STEP-ERROR-COPY-20261006: the
// 24-character rule comes with a passphrase example, and a rejected two-step
// code leads with code expiry instead of blaming the phone clock, in English
// and Spanish. The 24-character minimum itself is unchanged (an owner security
// decision).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider, useLang } from "../src/lib/LanguageContext.jsx";
import { PasswordChangeForm } from "../src/views/SettingsView.jsx";
import { MfaSettings } from "../src/components/MfaSettings.jsx";
import { catalogue } from "../src/lib/i18n.js";

function PasswordForm({ client }) {
  const { t } = useLang();
  return <PasswordChangeForm client={client} t={t} />;
}

function enrollClient() {
  return {
    auth: {
      mfa: {
        listFactors: vi.fn().mockResolvedValue({ data: { all: [], totp: [] }, error: null }),
        enroll: vi.fn().mockResolvedValue({ data: { id: "f1", totp: { qr_code: "", secret: "S" } }, error: null }),
        challenge: vi.fn().mockResolvedValue({ data: { id: "c1" }, error: null }),
        verify: vi.fn().mockResolvedValue({ error: { message: "Invalid TOTP code entered" } }),
        unenroll: vi.fn().mockResolvedValue({ error: null }),
      },
    },
  };
}

describe("security settings copy", () => {
  for (const [lang, rule, example, expiry] of [
    ["en", "Use at least 24 characters.", "“copper kettle mountain parade”", "Codes change every 30 seconds"],
    ["es", "Usa al menos 24 caracteres.", "“tetera cobre montaña desfile”", "Los códigos cambian cada 30 segundos"],
  ]) {
    it(`explains the password rule with a passphrase example that itself meets the rule (${lang})`, () => {
      render(<LanguageProvider lang={lang}><PasswordForm client={{ auth: { updateUser: vi.fn() } }} /></LanguageProvider>);
      const text = document.querySelector(".auth-rule").textContent;
      expect(text.startsWith(rule)).toBe(true);
      expect(text).toContain(example);
      expect(example.slice(1, -1).length).toBeGreaterThanOrEqual(24);
      expect(document.querySelector('input[name="password"]').getAttribute("minLength")).toBe("24");
    });

    it(`leads a rejected two-step code with code expiry, not the phone clock (${lang})`, async () => {
      render(<LanguageProvider lang={lang}><MfaSettings client={enrollClient()} /></LanguageProvider>);
      fireEvent.click(await screen.findByRole("button", { name: catalogue[lang]["mfa.enable"] }));
      await screen.findByText(catalogue[lang]["mfa.secretLabel"]);
      fireEvent.change(screen.getByLabelText(catalogue[lang]["mfa.codeLabel"]), { target: { value: "000000" } });
      fireEvent.click(screen.getByRole("button", { name: catalogue[lang]["mfa.verify"] }));
      await waitFor(() => expect(document.querySelector(".auth-message")).toBeTruthy());
      const message = document.querySelector(".auth-message").textContent;
      expect(message.startsWith(expiry)).toBe(true);
      expect(message).not.toMatch(/wasn't accepted|no se aceptó/);
    });
  }

  it("never promises that a fixed number of words meets the minimum", () => {
    // Four short words ("coffee water bread milk") are only 23 characters.
    expect("coffee water bread milk".length).toBeLessThan(24);
    for (const lang of ["en", "es"]) {
      expect(catalogue[lang]["auth.passwordRule"]).not.toMatch(/four or five|cuatro o cinco/);
      expect(catalogue[lang]["auth.passwordRule"]).toMatch(/until it reaches 24 characters|hasta llegar a 24 caracteres/);
    }
  });

  it("does not blame length when the provider refuses a password the form already accepted", () => {
    // The fields enforce minLength=24, so this line only shows for provider,
    // network or reauthentication failures.
    for (const lang of ["en", "es"]) expect(catalogue[lang]["auth.passwordChangeFailed"]).not.toMatch(/24/);
  });

  it("keeps the sign-out remedy for the stale-session refusal and the neutral line for everything else", () => {
    // A lost response can follow a change the server already made, so neither
    // line promises the old password still works.
    for (const lang of ["en", "es"]) {
      expect(catalogue[lang]["auth.passwordChangeReauth"]).not.toMatch(/24|still works|sigue funcionando/);
      expect(catalogue[lang]["auth.passwordChangeFailed"]).not.toMatch(/sign out|cierra sesión|still works|sigue funcionando|could not be changed|No se pudo cambiar/);
    }
    expect(catalogue.en["auth.passwordChangeReauth"]).toMatch(/sign out, sign in again/);
    expect(catalogue.es["auth.passwordChangeReauth"]).toMatch(/cierra sesión, vuelve a iniciar sesión/);
  });
});
