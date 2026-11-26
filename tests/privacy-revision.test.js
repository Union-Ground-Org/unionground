import { describe, expect, it } from "vitest";
import { t } from "../src/lib/i18n.js";
import { compareLegalVersions, currentLegalVersions, legalChangeNotice, legalInstrument } from "../src/lib/legalInstruments.js";
import { telemetry } from "../src/lib/telemetryDisclosure.js";

// The privacy notice as it stood at `version`: later changelog rows (the
// material 1.4.0 of the first legal release, for one) are not yet written.
const privacyAsOf = (version) => {
  const privacy = legalInstrument("privacy-policy");
  return { ...privacy, version, changelog: privacy.changelog.filter((change) => compareLegalVersions(change.version, version) <= 0) };
};

describe("privacy analytics clarification", () => {
  it("distinguishes the amended text without re-prompting a 1.0.0 acceptance", () => {
    const privacy = legalInstrument("privacy-policy");
    const storage = privacy.changelog.find(change => change.version === "1.0.2");
    expect(storage).toMatchObject({ version: "1.0.2", material: false });
    // The 1.0.x revisions alone stay nonmaterial; 1.1.0 (training) is material.
    const historicalPrivacy = {
      ...privacy,
      version: "1.0.2",
      changelog: privacy.changelog.filter((change) => compareLegalVersions(change.version, "1.1.0") < 0),
    };
    const analytics = privacy.changelog.find(change => change.version === "1.0.1");
    expect(analytics).toMatchObject({ material: false });
    expect(privacy.changelog.find((change) => change.version === "1.0.0")).toMatchObject({ material: true });
    const accepted = Object.fromEntries(Object.keys(currentLegalVersions()).map((key) => [key, "1.0.0"]));
    expect(legalChangeNotice(accepted, [historicalPrivacy])).toEqual({ notice: false, reacceptanceRequired: false, instruments: [] });
    expect(legalChangeNotice({ ...accepted, "privacy-policy": "1.0.1" }, [historicalPrivacy])).toEqual({ notice: false, reacceptanceRequired: false, instruments: [] });
    expect(legalChangeNotice({ ...accepted, "privacy-policy": "0.1.0" }, [historicalPrivacy]).instruments).toEqual(["privacy-policy"]);
    for (const lang of ["en", "es"]) {
      const note = t(lang, analytics.noteKey);
      expect(note).toContain("PostHog");
      expect(note).toContain("1.0.0");
      expect(note).not.toBe(analytics.noteKey);
      const storageNote = t(lang, storage.noteKey);
      expect(storageNote).toContain("PKCE");
      expect(storageNote).toContain("1.0.1");
      const auth = telemetry.storage.find(row => row.id === "auth");
      expect(auth.keys).toEqual(expect.arrayContaining(["sb-{project}-auth-token-flow-{id}-code-verifier", "sb-{project}-auth-token-flows-code-verifier"]));
      expect(auth.purpose[lang]).toContain("5");
      expect(auth.purpose[lang]).toContain("PKCE");
    }
  });

  // #6247: member-product analytics is material, so a 1.1.0 acceptance is asked again.
  it("asks a 1.1.0 acceptance again for privacy 1.2.0", () => {
    const privacy = legalInstrument("privacy-policy");
    expect(privacy.changelog.find(change => change.version === "1.2.0")).toMatchObject({ date: "2026-10-28", material: true, noteKey: "legal.changelog.note.memberProductAnalytics" });
    const accepted = { ...currentLegalVersions(), "privacy-policy": "1.1.0" };
    expect(legalChangeNotice(accepted, [privacy])).toMatchObject({ reacceptanceRequired: true, instruments: ["privacy-policy"] });
    for (const lang of ["en", "es"]) expect(t(lang, "legal.changelog.note.memberProductAnalytics")).toContain("PostHog");
  });

  it("discloses public-page heatmaps as a material 1.2.1 revision", () => {
    const privacy = legalInstrument("privacy-policy");
    expect(privacy.changelog.find(change => change.version === "1.2.1")).toMatchObject({ version: "1.2.1", date: "2026-10-29", material: true, noteKey: "legal.changelog.note.publicPageHeatmaps" });
    expect(legalChangeNotice({ ...currentLegalVersions(), "privacy-policy": "1.2.0" }, [privacy]))
      .toMatchObject({ reacceptanceRequired: true, instruments: ["privacy-policy"] });
    for (const lang of ["en", "es"]) {
      const text = telemetry.copy[lang].analytics;
      expect(text).toContain(lang === "en" ? "cookieless heatmaps" : "mapas de calor sin cookies");
      expect(text).toContain(lang === "en" ? "Text and inputs stay masked" : "El texto y los campos de entrada permanecen enmascarados");
      expect(text).toContain(lang === "en" ? "Heatmaps exclude the worker workspace and mobile apps" : "Los mapas de calor excluyen el espacio de trabajo y las aplicaciones móviles");
      expect(text).toContain(lang === "en" ? "window dimensions" : "dimensiones de la ventana");
      expect(t(lang, "legal.changelog.note.publicPageHeatmaps")).toContain("PostHog");
    }
  });

  // REQ-UG-NAVIGATION-PINNED-SHORTCUTS-20261030: the device-only menu
  // pin key is a nonmaterial storage disclosure, like 1.0.2's PKCE storage.
  it("discloses the menu pin key as a nonmaterial 1.3.1 revision", () => {
    const privacy = legalInstrument("privacy-policy");
    expect(privacy.changelog.find(change => change.version === "1.3.1")).toMatchObject({ version: "1.3.1", date: "2026-10-30", material: false, noteKey: "legal.changelog.note.navigationPins" });
    expect(legalChangeNotice({ ...currentLegalVersions(), "privacy-policy": "1.3.0" }, [privacyAsOf("1.3.1")]))
      .toMatchObject({ reacceptanceRequired: false });
    const nav = telemetry.storage.find(row => row.id === "nav");
    expect(nav.keys).toEqual(["ug-nav-usage:v1:{user}:{organization}", "ug-nav-pins:v1:{user}:{organization}"]);
    for (const lang of ["en", "es"]) {
      const note = t(lang, "legal.changelog.note.navigationPins");
      expect(note).not.toBe("legal.changelog.note.navigationPins");
      expect(note).toContain("1.3.0");
      expect(nav.purpose[lang]).toContain(lang === "en" ? "sign-out" : "cerrar sesión");
    }
  });

  // REQ-UG-OFFICER-MEMBER-ROSTER-AND-EXPORT-20261030: the officer
  // member-list export follows the existing chapter and role limits, so the
  // recipients sentence is a nonmaterial 1.3.2 revision.
  it("discloses the officer member-list export as a nonmaterial 1.3.2 revision", () => {
    const privacy = legalInstrument("privacy-policy");
    expect(privacy.changelog.find(change => change.version === "1.3.2")).toMatchObject({ version: "1.3.2", date: "2026-10-30", material: false, noteKey: "legal.changelog.note.officerRosterExport" });
    for (const accepted of ["1.3.0", "1.3.1"]) {
      expect(legalChangeNotice({ ...currentLegalVersions(), "privacy-policy": accepted }, [privacyAsOf("1.3.2")]))
        .toMatchObject({ reacceptanceRequired: false });
    }
    for (const lang of ["en", "es"]) {
      const note = t(lang, "legal.changelog.note.officerRosterExport");
      expect(note).toContain(lang === "en" ? "may export the worker list they can already see" : "pueden exportar la lista de trabajadores que ya pueden ver");
      expect(note).toContain(lang === "en" ? "without email addresses or contact details a worker did not share" : "sin correos electrónicos ni datos de contacto que un trabajador no compartió");
      expect(note).toContain(lang === "en" ? "every export is logged" : "cada exportación queda registrada");
      expect(note).toContain("1.3.0");
    }
  });

  // OPS-UG-FIRST-LEGAL-RELEASE-FOLDS-SIX-PENDING-DECLARATIONS-20261112:
  // the civic Census Bureau notice is material, so a member who accepted any
  // 1.3.x is asked once to accept 1.4.0, and 1.4.0 itself asks nothing more.
  it("asks a member on any 1.3 privacy notice to accept the material 1.4.0 once", () => {
    const privacy = legalInstrument("privacy-policy");
    expect(privacy.version).toBe("1.4.0");
    expect(privacy.changelog.find((change) => change.version === "1.4.0")).toMatchObject({ material: true });
    for (const accepted of ["1.3.0", "1.3.1", "1.3.2", "1.3.3"]) {
      expect(legalChangeNotice({ ...currentLegalVersions(), "privacy-policy": accepted }, [privacy]))
        .toEqual({ notice: true, reacceptanceRequired: true, instruments: ["privacy-policy"] });
    }
    expect(legalChangeNotice(currentLegalVersions(), [privacy])).toEqual({ notice: false, reacceptanceRequired: false, instruments: [] });
  });

  it("discloses the optional native chart cache without another acceptance", () => {
    const privacy = legalInstrument("privacy-policy");
    const chart = privacy.changelog.find((change) => change.noteKey === "legal.changelog.note.nativePulseCharts");
    const chartAt = privacy.changelog.indexOf(chart);
    const atChart = { ...privacy, version: chart.version, changelog: privacy.changelog.slice(0, chartAt + 1) };
    expect(chart).toMatchObject({ date: "2026-11-01", material: false, noteKey: "legal.changelog.note.nativePulseCharts" });
    expect(legalChangeNotice({ ...currentLegalVersions(), "privacy-policy": privacy.changelog[chartAt - 1].version }, [atChart])).toMatchObject({ reacceptanceRequired: false });
    const entry = telemetry.storage.find(row => row.id === 'native-pulse-chart-picture');
    expect(entry.keys).toEqual(['ug-pulse-chart-export-v1/chart.png']);
    for (const lang of ['en', 'es']) {
      const note = t(lang, 'legal.changelog.note.nativePulseCharts');
      expect(note).toContain('PNG'); expect(note).toContain('1.3.0');
      expect(entry.purpose[lang]).toContain('4 MiB');
    }
  });

  it.each(["en", "es"])("discloses signed-in first-party counts and their switch in %s", (lang) => {
    const text = telemetry.copy[lang].analytics;
    expect(text).toContain("PostHog");
    expect(text).toContain(lang === "en" ? "first-party" : "propios");
    expect(text).toContain(lang === "en" ? "user identifier" : "identificador de usuario");
    expect(text).toContain(lang === "en" ? "Product analytics" : "Analítica del producto");
    expect(text).toContain(lang === "en" ? "this browser" : "este navegador");
  });
});
