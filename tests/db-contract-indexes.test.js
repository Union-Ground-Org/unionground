// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assessContractIndexes } from "../scripts/verify-db-contract.mjs";

describe("contract index catalog checks", () => {
  const entry = { table: "member_cases", name: "member_cases_org_idx", defContains: ["USING btree (organization_id)"] };
  const def = "CREATE INDEX member_cases_org_idx ON public.member_cases USING btree (organization_id)";
  const liveRow = (overrides = {}) => ({ name: entry.name, tbl: "member_cases", def, valid: true, ready: true, ...overrides });
  const failedChecks = (rows, entries = [entry]) => assessContractIndexes(entries, rows)
    .filter((result) => !result.ok)
    .map((result) => result.name);

  it("passes a matching index only when it is valid and ready", () => {
    expect(failedChecks([liveRow()])).toEqual([]);
  });

  it("fails a matching index that is invalid, unready, or both", () => {
    expect(failedChecks([liveRow({ valid: false })]))
      .toEqual([`index ${entry.name} is valid (pg_index.indisvalid)`]);
    expect(failedChecks([liveRow({ ready: false })]))
      .toEqual([`index ${entry.name} is ready (pg_index.indisready)`]);
    expect(failedChecks([liveRow({ valid: false, ready: false })])).toEqual([
      `index ${entry.name} is valid (pg_index.indisvalid)`,
      `index ${entry.name} is ready (pg_index.indisready)`,
    ]);
  });

  it("fails when the pg_index row is missing, so validity reads as null", () => {
    const results = assessContractIndexes([entry], [liveRow({ valid: null, ready: null })]);
    expect(results.filter((result) => !result.ok).map((result) => result.observed)).toEqual(["MISSING", "MISSING"]);
    const { valid: _valid, ready: _ready, ...withoutCatalog } = liveRow();
    expect(failedChecks([withoutCatalog])).toHaveLength(2);
  });

  it("still fails a missing index, a wrong table and a wrong definition", () => {
    expect(failedChecks([])).toEqual([`index ${entry.name} exists`]);
    expect(failedChecks([liveRow({ tbl: "member_messages" })])).toEqual([`index ${entry.name} table`]);
    expect(failedChecks([liveRow({ def: def.replace("organization_id", "member_id") })]))
      .toEqual([`index ${entry.name} definition contains USING btree (organization_id)`]);
  });

  it("resolves a same-name index in another schema to the pinned table", () => {
    const privateTwin = liveRow({ tbl: "private.member_cases", valid: false, ready: false });
    expect(failedChecks([privateTwin, liveRow()])).toEqual([]);
    expect(failedChecks([liveRow(), privateTwin], [{ ...entry, table: "private.member_cases" }])).toEqual([
      `index ${entry.name} is valid (pg_index.indisvalid)`,
      `index ${entry.name} is ready (pg_index.indisready)`,
    ]);
    expect(failedChecks([privateTwin])).toContain(`index ${entry.name} table`);
  });

  it("joins pg_index validity and readiness into the live index query", () => {
    const verifierSource = readFileSync(fileURLToPath(new URL("../scripts/verify-db-contract.mjs", import.meta.url)), "utf8");
    expect(verifierSource).toContain("x.indisvalid as valid");
    expect(verifierSource).toContain("x.indisready as ready");
    expect(verifierSource).toContain("left join pg_catalog.pg_index x");
  });
});
