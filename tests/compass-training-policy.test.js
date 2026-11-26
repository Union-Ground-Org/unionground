// @vitest-environment node
import { describe, expect, it } from "vitest";
import { catalogue } from "../src/lib/i18n/allLanguages.js";
import { currentLegalVersions, latestMaterialLegalVersion, legalChangeNotice, legalInstrument } from "../src/lib/legalInstruments.js";

describe("optional Compass training policy", () => {
  it("publishes the material notice separately from training consent", () => {
    const current = currentLegalVersions();
    // 1.1.0 is the material training notice for each; the first legal release
    // added nonmaterial 1.1.1 patches to the terms of use and the AI disclosure.
    for (const key of ["terms-of-use", "ai-disclosure", "retention-schedule"]) {
      expect(latestMaterialLegalVersion(legalInstrument(key))).toBe("1.1.0");
    }
    expect(current["retention-schedule"]).toBe("1.1.0");
    expect([current["terms-of-use"], current["ai-disclosure"]]).toEqual(["1.1.1", "1.1.1"]);
    // Privacy moved on to 1.3.1 for the device-only menu pin key, to 1.3.2
    // for the officer member-list export, to 1.3.3 for saved Pulse charts, and to
    // 1.4.0 for the civic Census Bureau notice (the first legal release); the
    // training and heatmap notices stay in its changelog and published text.
    expect(current["privacy-policy"]).toBe("1.4.0");
    expect(current["accessibility-statement"]).toBe("1.0.0");
    expect(legalChangeNotice(Object.fromEntries(Object.keys(current).map(key => [key, "1.0.0"]))).reacceptanceRequired).toBe(true);
    expect(catalogue.en["legal.aiDisclosure.sent.body"]).toContain("Accepting these policies does not opt you into training");
    expect(catalogue.es["legal.aiDisclosure.sent.body"]).toContain("Aceptar estas políticas no supone consentir el entrenamiento");
  });
  it("gives both locales the purpose, default-off choices, exclusions, limit and deletion path", () => {
    const en = catalogue.en["legal.aiDisclosure.sent.body"];
    const es = catalogue.es["legal.aiDisclosure.sent.body"];
    for (const phrase of ["off by default", "both the member", "organization administrator", "model training", "minimizer unchanged", "case facts", "180 days", "100 samples", "Supabase project", "account deletion", "organization archive", "separate owner decision"]) expect(en).toContain(phrase);
    for (const phrase of ["desactivada", "tanto el miembro", "administradora", "entrenar modelos", "minimizador sin cambios", "hechos de casos", "180 días", "100 muestras", "proyecto Supabase", "eliminación de la cuenta", "archivo de la organización", "decisión independiente"]) expect(es).toContain(phrase);
  });
});
