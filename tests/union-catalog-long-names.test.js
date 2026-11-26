// @vitest-environment node
// REQ-UG-CATALOG-ORGANIZATION-NAMES-OVER-200-CHARACTERS-20261114 (#8743).
import { describe, expect, it } from "vitest";
import { ORGANIZATION_NAME_MAX, rowViolations } from "../scripts/union-catalog/catalog-shape.mjs";
import { buildCatalogRelease } from "../scripts/union-catalog/privacy-filter.mjs";
import { baseFixture, filterOptions } from "./helpers/union-catalog-fixture.mjs";
import { addAmericasSnapshot, exportKey, exportLedgerId } from "./helpers/union-catalog-americas-fixture.mjs";
import { LONG_NAMES, longName, withLongNames } from "./helpers/union-catalog-long-names.mjs";

describe("organization names longer than 200 characters (#8743)", () => {
  it("exports a name of up to 1,000 characters unshortened and holds a longer one", () => {
    expect(ORGANIZATION_NAME_MAX).toBe(1000);
    expect([LONG_NAMES.MX.length, LONG_NAMES.BR.length, LONG_NAMES.AR.length]).toEqual([622, 1000, 1001]);
    const built = buildCatalogRelease(filterOptions(withLongNames(addAmericasSnapshot(baseFixture()))));
    const byKey = new Map(built.release.organizations.map((row) => [row.catalog_key, row]));
    expect(byKey.get(exportKey("MX")).name).toBe(LONG_NAMES.MX);
    expect(byKey.get(exportKey("BR")).name).toBe(LONG_NAMES.BR);
    expect(byKey.has(exportKey("AR"))).toBe(false);
    expect(built.dropReport["organizations.name:too_long"]).toBe(1);
    expect(built.dropReport["organizations:name_unusable"]).toBe(1);
    for (const row of byKey.values()) expect(row.search_text.length).toBeLessThanOrEqual(4000);
  });

  it("checks the row bound at 1,000 characters, and still at least 2 after trimming", () => {
    const built = buildCatalogRelease(filterOptions(baseFixture()));
    const row = built.release.organizations[0];
    expect(rowViolations("organizations", { ...row, name: LONG_NAMES.BR })).toEqual([]);
    expect(rowViolations("organizations", { ...row, name: LONG_NAMES.AR }).join()).toMatch(/name trimmed length 1001 is outside 2\.\.1000/);
    expect(rowViolations("organizations", { ...row, name: " x " }).join()).toMatch(/name trimmed length 1 is outside 2\.\.1000/);
  });

  // Final review of #8755, r4s2: a name-only parent reference is read at the
  // organization name limit, so a long registered name still keys the edge.
  it("keys a name-only parent reference by a long registered name and stores no label over 300", () => {
    const fixture = addAmericasSnapshot(baseFixture());
    fixture.enriched[exportLedgerId("CA")].name = LONG_NAMES.MX;
    const mx = fixture.enriched[exportLedgerId("MX")];
    const { parent_catalog_key: _unused, ...nameOnly } = mx.parentBodies[0];
    mx.parentBodies = [{ ...nameOnly, name: LONG_NAMES.MX }];
    const built = buildCatalogRelease(filterOptions(fixture));
    const edges = built.release.edges.filter((edge) => edge.child_key === exportKey("MX") && edge.edge_kind === "parent_body");
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ parent_key: exportKey("CA"), parent_label: null });
    expect(rowViolations("edges", edges[0])).toEqual([]);
    expect(built.dropReport["edges.parent_label:too_long"]).toBeUndefined();

    // One that names no exported organization stays label-only, so a label
    // over the stored limit is still dropped as too long.
    mx.parentBodies = [{ ...nameOnly, name: longName(622, "Confederacion Sin Registro de Ejemplo") }];
    const unresolved = buildCatalogRelease(filterOptions(fixture));
    expect(unresolved.release.edges.some((edge) => edge.child_key === exportKey("MX") && edge.edge_kind === "parent_body")).toBe(false);
    expect(unresolved.dropReport["edges.parent_label:too_long"]).toBe(1);
  });

  it("leaves a legacy export unchanged", () => {
    const before = buildCatalogRelease(filterOptions(baseFixture()));
    expect(before.dropReport["organizations.name:too_long"]).toBeUndefined();
    expect(before.release.organizations.every((row) => row.name.length <= 200)).toBe(true);
  });
});
