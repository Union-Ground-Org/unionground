// CONTENT-UG-HAT-USER-FACING-TERM-20261018: product copy says "role",
// never "hat", for a staff role, with no exceptions. The SAMPLE origin's
// identity switcher was the last: its visible intro and failure lines moved to
// "role" in UB-UG-DEMO-INTRO-SAYS-ROLE-20261107, and its accessible
// names and fallback line in UB-UG-DEMO-SWITCHER-NAME-SAYS-ROLE-20261108,
// so screen-reader users hear "Switch role" too. `{hat}` placeholders are data,
// not copy.
import { describe, expect, it } from "vitest";
import { catalogue, t as translate } from "../src/lib/i18n.js";
import { STAFF_PLANES } from "../src/lib/staffPlanes.js";

const SAMPLE_SWITCHER_KEYS = new Set([]);

const saysHat = (value) => typeof value === "string" && /\bhats?\b/iu.test(value.replace(/\{hat\}/gu, ""));

describe("no hat in product copy", () => {
  it("names the demo switcher with role for screen readers, in English and Spanish", () => {
    expect(translate("en", "demo.hatsLabel")).toBe("Switch role");
    expect(translate("en", "desktopRail.switchHatCurrent", { hat: "Member" })).toBe("Switch role, current: Member");
    expect(translate("en", "demo.staffLinkFallback")).toContain("use Switch role");
    expect(translate("es", "demo.hatsLabel")).toBe("Cambiar de rol");
    expect(translate("es", "desktopRail.switchHatCurrent", { hat: "Miembro" })).toBe("Cambiar de rol, actual: Miembro");
  });

  it("words the demo's visible intro and failure lines with role, in English and Spanish", () => {
    expect(translate("en", "demo.hatIntro")).toBe("Try another role to see the tools and work it has.");
    expect(translate("en", "demo.hatSwitchFailed")).toBe("Could not switch roles. Try again.");
    for (const key of ["demo.hatIntro", "demo.hatSwitchFailed"]) expect(translate("es", key)).toMatch(/\brol(es)?\b/u);
  });

  it("leaves no English catalogue string outside the SAMPLE switcher saying hat", () => {
    const offenders = Object.entries(catalogue.en).filter(([key, value]) => saysHat(value) && !SAMPLE_SWITCHER_KEYS.has(key));
    expect(offenders).toEqual([]);
  });

  it("keeps every allowlisted key real, so the exception cannot outlive its string", () => {
    for (const key of SAMPLE_SWITCHER_KEYS) expect(catalogue.en[key], key).toBeTypeOf("string");
  });

  // Round 1 review (r1g1): the scan above strips {hat}, so also render the
  // sentences with every label the product puts into {hat}.
  it("never says hat once a real role label fills {hat}", () => {
    const labels = ["demo.hatMember", ...STAFF_PLANES.map((plane) => plane.labelKey)].map((key) => translate("en", key));
    expect(labels).toEqual(["Worker", "Organizer", "Committee", "Campaign lead", "Advisor", "Admin", "Campaign chair"]);
    for (const hat of labels) {
      const refused = translate("en", "demo.hatRouteRefused", { hat, destination: "Home" });
      expect(refused).toBe(`Your ${hat} role cannot open that page. Opening Home instead.`);
      expect(refused).not.toMatch(/\bhats?\b/iu);
      expect(translate("en", "staffAuthoring.wearHat", { hat })).toBe(`Act as ${hat} here`);
    }
  });

  it("says role in the strings members and staff read on the product", () => {
    expect(catalogue.en["mfa.staffHatsRestore"]).toBe("Restore my staff roles");
    expect(catalogue.en["demo.hatRouteRefused"]).toBe("Your {hat} role cannot open that page. Opening {destination} instead.");
    expect(catalogue.en["staffAuthoring.wearHat"]).toBe("Act as {hat} here");
    expect(catalogue.en["qa.forbidden"]).toBe("You cannot do that in this role.");
    // The alternate shell's role group reaches production staff accounts (round 1 review r1s1).
    expect(catalogue.en["altShell.groupHats"]).toBe("Roles");
  });
});
