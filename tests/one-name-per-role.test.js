// @vitest-environment node
// #9529, a review note: the role key vp is shown as "President" by the
// role switcher (demo.hatVp) but Pulse called the same hat "Vice president".
// The server treats the Pulse hats vp and president alike
// (supabase/migrations/20261113148000_pulse_layout_store.sql, pulse_layout_options),
// and the web passes the worn hat, so a person wearing the President hat read
// "Vice president". One name for one role, in English and Spanish.
import { describe, expect, it } from "vitest";
import "../src/lib/i18n/allLanguages.js";
import { catalogue } from "../src/lib/i18n.js";

describe("one name for one role", () => {
  it("names the vp hat in Pulse the way the role switcher does", () => {
    for (const lang of ["en", "es"]) {
      expect(catalogue[lang]["pulse.hats.vp"], lang).toBe(catalogue[lang]["demo.hatVp"]);
      expect(catalogue[lang]["pulse.hats.vp"], lang).not.toMatch(/vice|vicepresiden/i);
    }
    expect(catalogue.en["pulse.hats.vp"]).toBe("Campaign chair");
    expect(catalogue.es["pulse.hats.vp"]).toBe("Presidencia de campaña");
    // The server treats the Pulse hats vp and president alike, so both read the same.
    for (const lang of ["en", "es"]) expect(catalogue[lang]["pulse.hats.president"], lang).toBe(catalogue[lang]["pulse.hats.vp"]);
  });

  // The phone's live staff picker said Chapter Advisor and Chapter
  // Administrator where the switchers and the pay sentences say Advisor and
  // Admin. The phone needs a Spanish word that is not the English one, so the
  // one Spanish name for admin is "Administrador" everywhere.
  it("names advisor, admin and vp the same in Pulse, the switcher and the pay sentences", () => {
    for (const lang of ["en", "es"]) {
      for (const role of ["advisor", "admin", "vp"]) {
        const hat = `demo.hat${role === "vp" ? "Vp" : role.charAt(0).toUpperCase() + role.slice(1)}`;
        expect(catalogue[lang][`pulse.hats.${role}`], `${lang} ${role}`).toBe(catalogue[lang][hat]);
        for (const key of ["pay.publisherRestricted", "pay.publisherHelp"]) {
          expect(catalogue[lang][key], `${lang} ${key}`).toContain(catalogue[lang][hat]);
        }
      }
    }
    expect(["demo.hatAdvisor", "demo.hatAdmin", "demo.hatVp"].map((key) => catalogue.es[key])).toEqual(["Asesor", "Administrador", "Presidencia de campaña"]);
  });
});
