import { describe, expect, it } from "vitest";
import { t } from "../src/lib/i18n.js";
import { USTED_MARKERS } from "./i18nRegisterMarkers.js";

describe("help copy gives a next step", () => {
  it.each([
    ["en", "Ask your campaign administrator, or use Messages.", null, "Already invited? Open your invitation email first."],
    ["es", "Pregunta a la administración de tu campaña o usa Mensajes.", null, "¿Ya te invitaron? Abre primero el correo de invitación."],
  ])("guides %s readers when they need a committee contact or an invitation", (lang, steward, support, invitation) => {
    expect(t(lang, "today.findStewardEmpty")).toContain(steward);
    // Union Ground publishes no support mailbox yet, so the site guide names none.
    expect(support).toBeNull();
    expect(t(lang, "siteGuide.helpBody")).not.toContain("@");
    expect(t(lang, "requestInvite.haveInvitation")).toBe(invitation);
  });

  it("keeps all three Spanish next steps in the established tú register", () => {
    for (const key of ["today.findStewardEmpty", "siteGuide.helpBody", "requestInvite.haveInvitation"]) {
      expect(t("es", key), key).not.toMatch(USTED_MARKERS);
    }
  });
});
