// @vitest-environment node
//
// Offline unit tests for the database half of scripts/load-union-catalog.mjs
// (spec 2026-09-24 union catalog design §2.6): the staging insert builder,
// the retire preview, the content hash, the exclusion sweep, the
// withdrawal guard, the staged-row digest, the verify outcome wording and the
// activation error rewrite. The release-row CHECKs (releaseRecordViolations) are
// tested in tests/union-catalog-plan.test.js. The live load, verify and
// activate cycle, including the second-load path (changed, unchanged, retired
// and un-retired rows) and the rollback, is proven against Postgres by
// tests/union-catalog-db.test.js. Fixture values are fictional.
import { describe, expect, it } from "vitest";
import {
  BATCH_SIZE,
  KEY_COLUMNS,
  RELEASE_COLUMNS,
  RETIRE_LIMITS,
  STAGING_DIGEST_SQL,
  contentSha256,
  exclusionMatchCount,
  formatVerify,
  isOwnActivationError,
  parseArgs,
  retirePreviewSql,
  rowKeyOf,
  stagingSql,
  sanitizedActivationError,
  stagingValues,
  unfitRowDiagnosisSql,
  withdrawalDecision,
} from "../scripts/load-union-catalog.mjs";
import { RELEASE_TABLES } from "../scripts/union-catalog/catalog-shape.mjs";
import { ExclusionMatcher } from "../scripts/union-catalog/privacy-filter.mjs";
import { exclusionList } from "./helpers/union-catalog-fixture.mjs";

const RELEASE_ID = "00000000-0000-4000-8000-000000000001";

function contact(overrides = {}) {
  return {
    contact_key: "olms-900000001~website-0123456789ab",
    catalog_key: "olms-900000001",
    contact_kind: "website",
    value: "https://exampleworkers1.example/",
    label: null,
    basis: "own_site",
    source_url: "https://exampleworkers1.example/",
    as_of: null,
    ...overrides,
  };
}

describe("load-union-catalog SQL builders", () => {
  it("covers every release table with its key columns first", () => {
    expect(Object.keys(RELEASE_COLUMNS)).toEqual([...RELEASE_TABLES]);
    for (const table of RELEASE_TABLES) {
      for (const key of KEY_COLUMNS[table]) expect(RELEASE_COLUMNS[table], table).toContain(key);
    }
    expect(RELEASE_COLUMNS.organizations).toHaveLength(41);
    // 41 release columns plus one hash per row, 500 rows, stays under the
    // 65,535 bind-parameter ceiling of the Postgres wire protocol.
    expect(1 + BATCH_SIZE * (RELEASE_COLUMNS.organizations.length + 1)).toBeLessThan(65535);
  });

  it("stages rows by (release, table, row key) with the release columns as jsonb and their hash, never a live table", () => {
    const sql = stagingSql(2);
    expect(sql).toMatch(/^insert into private\.catalog_staging \(release_id, table_name, row_key, content, content_sha256\)\nvalues \(\$1, \$2, \$3, \$4::jsonb, \$5\),\n {7}\(\$1, \$2, \$6, \$7::jsonb, \$8\)$/);
    for (const table of RELEASE_TABLES) expect(sql).not.toContain(`catalog_${table}`);
    expect(sql).not.toMatch(/\b(?:on conflict|update|delete)\b/);
    // 3 bind parameters per row plus 2 stays far under the 65,535 ceiling.
    expect(2 + BATCH_SIZE * 3).toBeLessThan(65535);
  });

  it("passes the release id and table name once, then key, content JSON and hash per row", () => {
    const row = contact();
    const values = stagingValues("contacts", [row, contact({ contact_key: "olms-900000001~phone-0123456789ab", contact_kind: "phone", value: "802-555-0100" })], RELEASE_ID);
    expect(values).toHaveLength(2 + 2 * 3);
    expect(values.slice(0, 2)).toEqual([RELEASE_ID, "contacts"]);
    expect(values[2]).toBe(row.contact_key);
    expect(JSON.parse(values[3])).toEqual(row);
    expect(values[4]).toBe(contentSha256("contacts", row));
    expect(values[5]).toBe("olms-900000001~phone-0123456789ab");
    // Absent release columns are staged as null so activation writes every column.
    const { label: _label, ...withoutLabel } = row;
    expect(JSON.parse(stagingValues("contacts", [withoutLabel], RELEASE_ID)[3])).toEqual(row);
    // The composite key of document_subunits is joined with "|", as the activation retire step expects.
    expect(rowKeyOf("document_subunits", { document_key: "olms-900000001~0123456789abcdef", subunit_key: "olms-900000001~chapter-0123456789ab" }))
      .toBe("olms-900000001~0123456789abcdef|olms-900000001~chapter-0123456789ab");
    // text[] stays an array inside the JSON.
    const organization = Object.fromEntries(RELEASE_COLUMNS.organizations.map((c) => [c, null]));
    organization.aka = ["EWL 1"];
    expect(JSON.parse(stagingValues("organizations", [organization], RELEASE_ID)[3]).aka).toEqual(["EWL 1"]);
  });

  it("hashes release columns only, independent of key order and of absent-versus-null", () => {
    const row = contact();
    const hash = contentSha256("contacts", row);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const reordered = Object.fromEntries(Object.entries(row).reverse());
    expect(contentSha256("contacts", reordered)).toBe(hash);
    const { label: _label, ...withoutLabel } = row;
    expect(contentSha256("contacts", withoutLabel)).toBe(hash);
    expect(contentSha256("contacts", { ...row, first_release_id: RELEASE_ID })).toBe(hash);
    expect(contentSha256("contacts", contact({ label: "Main office" }))).not.toBe(hash);
  });

  it("previews retirement over live rows only, by anti-join, and counts exclusion matches without naming them", () => {
    const preview = retirePreviewSql("subunits");
    expect(preview).toContain("count(*) filter (where k.subunit_key is null)::integer as retiring");
    expect(preview).toContain("left join unnest($1::text[]) as k(subunit_key) on k.subunit_key = t.subunit_key");
    expect(preview).toContain("where t.retired_release_id is null");
    expect(preview).not.toMatch(/\b(?:update|delete)\b/);

    const release = Object.fromEntries(RELEASE_TABLES.map((t) => [t, []]));
    release.contacts = [contact({ label: "Main office" }), contact({ contact_key: "olms-900000001~social-0123456789ab", label: "Main office" })];
    expect(exclusionMatchCount(release, new ExclusionMatcher(exclusionList()))).toBe(0);
    expect(exclusionMatchCount(release, new ExclusionMatcher(exclusionList(["Main office"])))).toBe(2);
  });
});

describe("load-union-catalog withdrawal guard", () => {
  const preview = (organizations, subunits) => ({
    organizations: { live: 1000, retiring: organizations },
    subunits: { live: 1000, retiring: subunits },
  });

  it("allows retirement up to 3% of organizations and 10% of sub-units", () => {
    expect(RETIRE_LIMITS).toEqual({ organizations: 0.03, subunits: 0.1 });
    const decision = withdrawalDecision(preview(30, 100));
    expect(decision).toMatchObject({ organizationsShare: 0.03, subunitsShare: 0.1, total: 130, overLimit: false, refusal: null });
    expect(withdrawalDecision({ organizations: { live: 0, retiring: 0 }, subunits: { live: 0, retiring: 0 } }).refusal).toBeNull();
  });

  it("refuses beyond either limit unless --allow-retire covers every retiring row", () => {
    const organizations = withdrawalDecision(preview(31, 0));
    expect(organizations.overLimit).toBe(true);
    expect(organizations.refusal).toMatch(/^withdrawal guard: 31 of 1000 live organizations \(3\.1%\) and 0 of 1000 live sub-units \(0\.0%\) would retire; the limits are 3\.0% and 10\.0%\. Re-run with --allow-retire 31/);
    expect(withdrawalDecision(preview(0, 101)).refusal).toMatch(/withdrawal guard/);
    expect(withdrawalDecision(preview(31, 101), 132).refusal).toBeNull();
    expect(withdrawalDecision(preview(31, 101), 131).refusal).toMatch(/132 rows in all, more than --allow-retire 131/);
    // An explicit ceiling applies even under the percentage limits.
    expect(withdrawalDecision(preview(5, 5), 9).refusal).toMatch(/more than --allow-retire 9/);
  });

  it("parses --allow-retire as a whole number for load and activate only", () => {
    expect(parseArgs(["node", "x", "load", "--release", "/r", "--allow-retire", "40"]).allowRetire).toBe(40);
    expect(parseArgs(["node", "x", "load", "--release", "/r"]).allowRetire).toBeNull();
    expect(() => parseArgs(["node", "x", "load", "--release", "/r", "--allow-retire", "-1"])).toThrow(/whole number/);
    expect(() => parseArgs(["node", "x", "load", "--release", "/r", "--allow-retire", "3%"])).toThrow(/whole number/);
    expect(parseArgs(["node", "x", "activate", "--release", "/r", "--allow-retire", "4"]).allowRetire).toBe(4);
    expect(() => parseArgs(["node", "x", "verify", "--release", "/r", "--allow-retire", "4"])).toThrow(/load and activate only/);
  });
});

describe("load-union-catalog verify stamp and activation errors", () => {
  it("digests the staged rows of one release in key order, over each row's hash and a hash of its stored content", () => {
    expect(STAGING_DIGEST_SQL).toMatch(/^select pg_catalog\.encode\(pg_catalog\.sha256\(/);
    expect(STAGING_DIGEST_SQL).toContain("s.table_name || ' ' || s.row_key || ' ' || s.content_sha256 || ' '");
    expect(STAGING_DIGEST_SQL).toContain("pg_catalog.sha256(pg_catalog.convert_to(s.content::text, 'UTF8'))");
    expect(STAGING_DIGEST_SQL).toContain("order by s.table_name, s.row_key");
    expect(STAGING_DIGEST_SQL).toMatch(/from private\.catalog_staging as s\n where s\.release_id = \$1$/);
  });

  it("words a PASS from the state it left the release in", () => {
    const report = (overrides) => ({ label: "20260901-01", rows: {}, notes: [], problems: [], ...overrides });
    const last = (overrides) => formatVerify(report(overrides)).at(-1);
    expect(last({ status: "active", previousStatus: "active", verifiedAt: null })).toMatch(/It is the active release; nothing was stamped\.$/);
    expect(last({ status: "staged", previousStatus: "staged", verifiedAt: new Date() })).toMatch(/The release is verified; activate it next\.$/);
    expect(last({ status: "staged", previousStatus: "failed", verifiedAt: new Date() })).toMatch(/was marked failed and is now staged again and verified/);
    expect(last({ status: "retired", previousStatus: "retired", verifiedAt: new Date() })).toMatch(/activate it to roll back\.$/);
    expect(formatVerify(report({ status: "failed", problems: ["x"] })).join("\n")).not.toContain("PASS");
  });

  it("prints the function's own refusals as raised and rewrites every other database error without its message, detail or cause", () => {
    for (const message of [
      "invalid catalog release label",
      "catalog release is not staged",
      "catalog release is not verified; run catalog:verify first",
      "catalog release has no staged rows; load it again",
      "catalog release staged rows changed after catalog:verify; run catalog:verify again",
      "withdrawal guard: 1 of 5 live organizations and 1 of 3 live sub-units would retire; re-run activate with --allow-retire 2",
    ]) expect(isOwnActivationError({ code: "22023", message }), message).toBe(true);
    expect(isOwnActivationError({ code: "P0001", message: "catalog activation left {organizations} out of step with the staged release" })).toBe(true);
    expect(isOwnActivationError({ code: "22P02", message: 'invalid input syntax for type integer: "Example 802-555-0177"' })).toBe(false);
    expect(isOwnActivationError({ code: "22023", message: "cannot call populate_record on Example 802-555-0177" })).toBe(false);

    const original = Object.assign(new Error('new row for relation "catalog_organizations" violates check constraint "catalog_organizations_name_check"'), {
      code: "23514", schema: "private", table: "catalog_organizations", constraint: "catalog_organizations_name_check",
      detail: "Failing row contains (Example 802-555-0177)",
    });
    const safe = sanitizedActivationError(original, "organizations olms-900000001");
    expect(safe.message).toBe("activation refused by the database (SQLSTATE 23514, constraint catalog_organizations_name_check, table private.catalog_organizations, staged row organizations olms-900000001); nothing was applied. Load and verify the release again.");
    expect(safe.code).toBe("23514");
    expect(safe).not.toHaveProperty("detail");
    expect(safe.cause).toBeUndefined();
    expect(sanitizedActivationError({ code: "22P02", message: "Example 802-555-0177" }).message).toBe(
      "activation refused by the database (SQLSTATE 22P02, staged row not located); nothing was applied. Load and verify the release again.",
    );
  });

  it("diagnoses the unfit row with a DO block over temporary copies of the seven tables, for a validated release id only", () => {
    const sql = unfitRowDiagnosisSql(RELEASE_ID);
    for (const table of RELEASE_TABLES) {
      expect(sql, table).toContain(`create temporary table catalog_probe_${table} (like private.catalog_${table} including defaults including constraints);`);
      expect(sql, table).toContain(`insert into pg_temp.catalog_probe_${table} select * from pg_catalog.jsonb_populate_record(null::private.catalog_${table}, r.content);`);
    }
    expect(sql).toContain(`where s.release_id = '${RELEASE_ID}'`);
    expect(sql).toContain("perform pg_catalog.set_config('catalog_diagnosis.unfit_row', r.table_name || ' ' || r.row_key, true);");
    expect(sql).not.toMatch(/insert into private\.|update private\.|delete from/);
    expect(() => unfitRowDiagnosisSql("x'; drop table private.catalog_staging; --")).toThrow(/release id/);
  });
});
