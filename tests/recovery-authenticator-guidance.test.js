import { describe, expect, it } from "vitest";
import { t } from "../src/lib/i18n.js";

describe("recovery-code authenticator guidance", () => {
  it.each([
    ["en", "Settings > Security", "Turn on two-step sign-in", /when asked|the next time you sign in/],
    ["es", "Ajustes > Seguridad", "Activar el inicio de sesión en dos pasos", /cuando se te pida|la próxima vez que entres/],
  ])("names the existing manual enrollment action before and after recovery (%s)", (lang, settings, action, automatic) => {
    for (const key of ["reset.recoveryIntro", "reset.completedRecovery"]) {
      const guidance = t(lang, key);
      expect(guidance).toContain(settings);
      expect(guidance).toContain(action);
      expect(guidance).not.toMatch(automatic);
      // The signed-out page cannot know the saved language used after sign-in.
      for (const signedInLanguage of ["en", "es"]) {
        for (const control of ["nav.settings", "morehub.security", "mfa.enable"]) {
          expect(guidance).toContain(t(signedInLanguage, control));
        }
      }
    }
    expect(t(lang, "reset.completedRecovery")).toContain(lang === "en" ? "Recovery codes" : "Códigos de recuperación");
  });
});
