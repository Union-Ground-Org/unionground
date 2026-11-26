// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentSha256, planRelease, readRelease, stagingValues } from "../scripts/load-union-catalog.mjs";
import { localeViolations, legacyLocale, researchLocale } from "../scripts/union-catalog/catalog-locale.mjs";
import { releaseViolations, rowViolations } from "../scripts/union-catalog/catalog-shape.mjs";
import { assertReleasePrivacy } from "../scripts/union-catalog/privacy-filter.mjs";
import { translateResearch } from "../scripts/union-catalog/translate-research-export.mjs";
import { writeBaseRelease } from "./helpers/union-catalog-research-fixture.mjs";
import { AMERICAS_COUNTRIES, combinedAmericasRelease, fixtureLocale, sampleKey } from "./helpers/union-catalog-americas-fixture.mjs";

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixtures() {
  const dir = mkdtempSync(join(tmpdir(), "catalog-country-"));
  dirs.push(dir);
  const base = readRelease(writeBaseRelease(dir).dir);
  return { base, combined: combinedAmericasRelease(base) };
}

describe("country-aware release boundary", () => {
  it("preserves the legacy hash and staging shape; every added locale field changes the new hash", () => {
    const row = { contact_key: "ug-sampleca00~website", catalog_key: "ug-sampleca00", contact_kind: "website",
      value: "https://sampleca.example/", label: null, basis: "own_site", source_url: "https://sampleca.example/", as_of: null };
    // Frozen hash of the original eight-column projection.
    expect(contentSha256("contacts", row)).toBe("576cd394efbc6ad300f15488a34528602b873db8d29d85bfdf7890bc9cd6cb7f");
    expect(JSON.parse(stagingValues("contacts", [row], "fixture")[3])).toEqual(row);
    const localized = { ...row, ...fixtureLocale() };
    expect(contentSha256("contacts", localized)).not.toBe(contentSha256("contacts", row));
    for (const field of ["country", "subdivision", "postal_code", "language", "timezone", "locale_unknowns"]) {
      expect(contentSha256("contacts", { ...localized, [field]: null })).not.toBe(contentSha256("contacts", localized));
    }
  });

  it("validates assigned ISO codes, BCP 47, IANA zones and reasons without inferring missing evidence", () => {
    expect(localeViolations(fixtureLocale())).toEqual([]);
    expect(localeViolations(legacyLocale())).toEqual([]);
    for (const patch of [{ country: "ZZ" }, { subdivision: "CA-ZZ" }, { subdivision: "MX-JAL" },
      { postal_code: "x\n" }, { language: "fr_XX" }, { timezone: "America/Invented" }, { timezone: "america/toronto" },
      { timezone: null }, { locale_unknowns: { language: "some person's name" } }]) {
      expect(localeViolations({ ...fixtureLocale(), ...patch }).length).toBeGreaterThan(0);
    }
    expect(researchLocale({ country: "MX" })).toEqual({ ...legacyLocale(), country: "MX" });
    expect(researchLocale({})).toEqual({});
    expect(() => researchLocale({ country: 42 })).toThrow(/country/);
    expect(localeViolations({ ...fixtureLocale(), language: "de-1996-t-de-1996" })).toEqual([]);
  });

  it("keeps the accepted base intact while every synthetic Americas body has locale and sourced registry identity", () => {
    const { base, combined } = fixtures();
    expect(releaseViolations(combined.release)).toEqual([]);
    expect(assertReleasePrivacy(combined.release)).toBe(true);
    expect(new Set(AMERICAS_COUNTRIES).size).toBe(55);
    expect(AMERICAS_COUNTRIES).toContain("GD");
    for (const [table, rows] of Object.entries(base.release).filter(([, value]) => Array.isArray(value))) {
      expect(combined.release[table].slice(0, rows.length)).toEqual(rows);
    }
    const org = combined.release.organizations.find((row) => row.catalog_key === sampleKey("CA"));
    expect(org).toMatchObject({ olms_file_number: null, country: "CA", state: null, zip5: null, postal_code: "K1A 0B1" });
    expect(rowViolations("organizations", { ...org, state: "ON" })).toContain("non-US rows must use subdivision/postal_code and leave state/zip5 null");
    expect(rowViolations("identifiers", { ...combined.release.identifiers[0], namespace: "olms" }).length).toBeGreaterThan(0);
  });

  it("retains validated research context on ug facts/categories while absent base identities stay held", () => {
    const { combined } = fixtures();
    const key = sampleKey("CA");
    const record = { id: "fixture", tier: 2, kind: "contract", url: "https://sampleca.example/contract.pdf", host: "sampleca.example",
      asOf: "2026-11-12", bodyId: key, candidates: [], unresolved: [], packetSha256: "a".repeat(64), locale: fixtureLocale() };
    const result = translateResearch({ base: combined.release, facts: [record],
      categories: [{ id: "category", bodyId: key, category: "contracts", outcome: "captured_publication", evaluatedOn: "2026-11-12", locale: fixtureLocale() }],
      inventory: [{ id: "fixture", withdrawn: false }], gateContract: "usability_contract_v5.category_gate" });
    expect(result.research_facts[0]).toMatchObject({ catalog_key: key, ...fixtureLocale() });
    expect(result.research_categories[0]).toMatchObject({ catalog_key: key, ...fixtureLocale() });
    expect(releaseViolations({ ...combined.release, research_facts: result.research_facts, research_categories: result.research_categories })).toEqual([]);
  });

  it("admits a sourced numeric registry identifier without admitting an email or person-shaped token", () => {
    const { combined } = fixtures();
    combined.release.identifiers[0].identifier = "8025550100";
    expect(planRelease(combined).label).toBe(combined.manifest.label);
    combined.release.identifiers[0].identifier = "person@example.org";
    expect(() => planRelease(combined)).toThrow(/identifier is not a bounded registry identifier/);
  });
});
