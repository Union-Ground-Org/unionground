import { describe, expect, it } from "vitest";
import { catalogue } from "../src/lib/i18n.js";
import { GUIDE_COPY_EN } from "../apps/mobile/src/features/guideLayers/guideCopy.ts";
import { MEMBER_FEATURES } from "../src/features/onboardingGuideEngine/memberLayers.js";

// REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030, finding 110: the
// Settings guide printed the heading "Never" and, on its own line, "Share your
// sign-in with anyone.", which read as an instruction. The line now carries
// the prohibition by itself in English and Spanish, and the phone's English
// copy stays equal to the shared catalogue.
const KEY = "guideEngine.fg.member.neverSignIn";

describe("Settings guide sign-in line (#6578 finding 110)", () => {
  it("reads as one prohibition on its own line", () => {
    expect(catalogue.en[KEY]).toBe("Your sign-in is yours alone: don't share it with anyone.");
    expect(catalogue.es[KEY]).toBe("Tu acceso es solo tuyo: no lo compartas con nadie.");
    for (const lang of ["en", "es"]) expect(catalogue[lang][KEY]).not.toMatch(/^(Share|Compartir)\b/);
  });

  it("keeps the phone's English copy equal to the shared line", () => {
    expect(GUIDE_COPY_EN[KEY]).toBe(catalogue.en[KEY]);
  });

  it("is still the Settings guide's never line", () => {
    const settings = MEMBER_FEATURES.find((entry) => entry.feature === "settings");
    expect(settings.never).toContain(KEY);
  });
});
