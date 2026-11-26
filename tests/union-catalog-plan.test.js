// @vitest-environment node
//
// `scripts/load-union-catalog.mjs plan` (spec 2026-09-24 union catalog design
// §2.6): no database, row counts, drop counts by reason and never values, the
// offline union_orgs match rate, candidate sub-unit renames, and the artifact
// and count checks that make a plan falsifiable. Fixtures are fictional.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareReleases,
  formatPlan,
  parseArgs,
  parseRegistryExport,
  planRelease,
  readRelease,
  registryMatch,
} from "../scripts/load-union-catalog.mjs";
import {
  RELEASE_COUNTS_MAX_BYTES,
  RELEASE_DROP_REPORT_MAX_BYTES,
  jsonbSizeUpperBound,
  releaseRecordViolations,
} from "../scripts/union-catalog/catalog-shape.mjs";
import { REPOSITORY_ROOT, exportRelease } from "../scripts/union-catalog/export-release.mjs";
import { LOCAL_ID, TEST_SALT, baseFixture } from "./helpers/union-catalog-fixture.mjs";

const dirs = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(process.env.CI_DB_TEMP_ROOT || tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function buildRelease(mutate = () => {}) {
  const root = tempDir("union-catalog-plan-");
  const fixture = baseFixture();
  mutate(fixture);
  const snapshot = join(root, "snapshot");
  mkdirSync(join(snapshot, "build"), { recursive: true });
  mkdirSync(join(snapshot, "documents"), { recursive: true });
  writeFileSync(join(snapshot, "build", "enriched.json"), JSON.stringify(fixture.enriched));
  writeFileSync(join(snapshot, "build", "source-data.json"), JSON.stringify({ "index-data.json": { records: fixture.ledger } }));
  writeFileSync(join(snapshot, "documents", "index.json"), JSON.stringify({ generated: null, documents: fixture.documents }));
  const exclusions = join(root, "catalog-exclusions.json");
  writeFileSync(exclusions, JSON.stringify({ schema: "catalog-exclusions/1", salt: TEST_SALT, hashes: [] }));
  const release = join(root, "release");
  exportRelease({ sourceDir: snapshot, outDir: release, label: "20260924-01", env: { CATALOG_EXCLUSIONS_FILE: exclusions } });
  return release;
}

describe("load-union-catalog plan", () => {
  it("reports row counts and drop counts by reason, passes every gate and writes nothing", () => {
    const lines = formatPlan(planRelease(readRelease(buildRelease())));
    const text = lines.join("\n");
    expect(text).toMatch(/^release {10}20260924-01 \(privacy-filter\/1\)$/m);
    expect(text).toMatch(/^ {2}organizations {8}4$/m);
    expect(text).toMatch(/^ {2}subunits {13}2$/m);
    expect(text).toMatch(/^ {2}documents\.url:http_only +1$/m);
    expect(text).toContain("union_orgs match: not computed");
    expect(text).toContain("candidate sub-unit renames: not computed");
    expect(lines.at(-1)).toBe("PLAN: release 20260924-01 passes every row check, foreign key and privacy gate. Nothing was written.");
    // Keys and counts only: no dataset value reaches the plan output.
    for (const value of ["Northside", "Fixtureperson", "Exampleville", "exampleworkers1.example"]) expect(text).not.toContain(value);
  });

  it("computes the union_orgs match rate offline from a registry export", () => {
    const current = readRelease(buildRelease());
    const registryRows = parseRegistryExport(JSON.stringify([
      { id: "atlas-a", olms_file_number: 900000001 },
      { id: "atlas-b", olms_file_number: "900000002" },
      { id: "atlas-c", olms_file_number: null },
      { id: "atlas-d", olmsFileNumber: 123 },
    ]));
    expect(registryMatch(current.release, registryRows)).toEqual({
      registryRows: 4,
      registryRowsWithoutFileNumber: 1,
      catalogOrganizationsWithFileNumber: 4,
      matched: 2,
      matchRate: 0.5,
      catalogWithoutRegistryRow: 2,
      catalogMatchingSeveralRegistryRows: 0,
      registryRowsWithoutCatalogEntry: 1,
    });
    const text = formatPlan(planRelease(current, { registryRows })).join("\n");
    expect(text).toMatch(/matched {31}2 \(50\.0%\)/);
    expect(() => parseRegistryExport("{\"nope\":1}")).toThrow(/registry export/);
  });

  it("lists candidate sub-unit renames against the previous release by key only", () => {
    const previous = readRelease(buildRelease()).release;
    const current = readRelease(buildRelease((f) => {
      f.enriched[LOCAL_ID].subunits[1].name = "Retiree Chapter";
    }));
    const comparison = compareReleases(previous, current.release);
    expect(comparison.subunitsRetired).toBe(1);
    expect(comparison.subunitsAdded).toBe(1);
    expect(comparison.candidateRenames).toHaveLength(1);
    const [pair] = comparison.candidateRenames;
    expect(pair.from).toMatch(/^olms-900000001~retiree_chapter-[0-9a-f]{12}$/);
    expect(pair.to).toMatch(/^olms-900000001~retiree_chapter-[0-9a-f]{12}$/);
    expect(pair.from).not.toBe(pair.to);
    const text = formatPlan(planRelease(current, { previousRelease: previous })).join("\n");
    expect(text).toContain("candidate sub-unit renames 1");
    expect(text).toContain(`${pair.from} -> ${pair.to}`);
    expect(text).toContain("load would refuse without --allow-retire");
    expect(text).not.toContain("Retiree");
  });

  it("refuses a release whose artifact does not match its manifest", () => {
    const dir = buildRelease();
    appendFileSync(join(dir, "catalog-release.json.gz"), Buffer.from([0]));
    expect(() => readRelease(dir)).toThrow(/does not match its manifest/);
  });

  it("refuses a release whose counts disagree with its manifest", () => {
    const current = readRelease(buildRelease());
    current.manifest.counts.subunits += 1;
    expect(() => planRelease(current)).toThrow(/counts disagree with the manifest/);
  });

  it("refuses a release row that would violate a table constraint", () => {
    const current = readRelease(buildRelease());
    current.release.subunits[0].kind = "guild";
    expect(() => planRelease(current)).toThrow(/subunits olms-900000001~chapter-[0-9a-f]{12}: kind "guild" is not one of/);
  });

  it("refuses a release that carries person contact data outside a contact value", () => {
    const current = readRelease(buildRelease());
    current.release.subunits[0].location = "Call 802-555-0179";
    expect(() => planRelease(current)).toThrow(/F8 privacy gate: subunits\.location/);
  });

  it("refuses a manifest whose catalog_releases row would fail a CHECK", () => {
    const current = readRelease(buildRelease());
    expect(releaseRecordViolations(current.manifest)).toEqual([]);
    const report = {};
    for (let i = 0; i < 400; i += 1) report[`organizations.fictional_field_${i}:too_long`] = 1000 + i;
    current.manifest.dropReport = report;
    expect(() => planRelease(current)).toThrow(/catalog_releases constraint:\n {2}- dropReport \(400 keys\) may take [0-9]+ bytes as jsonb; the cap is 16384/);
    current.manifest.dropReport = {};
    current.manifest.counts = [];
    expect(() => planRelease(current)).toThrow(/counts is not a JSON object/);
  });

  it("runs from the command line; load, verify and activate refuse to run without a guarded database target", () => {
    const dir = buildRelease();
    const script = join(REPOSITORY_ROOT, "scripts", "load-union-catalog.mjs");
    const plan = spawnSync(process.execPath, [script, "plan", "--release", dir], { encoding: "utf8" });
    expect(plan.status).toBe(0);
    expect(plan.stdout).toContain("PLAN: release 20260924-01 passes");
    const { SUPABASE_DB_URL: _unset, DB_VERIFY_DISPOSABLE_CONFIRM: _unconfirmed, ...env } = process.env;
    for (const mode of ["load", "verify", "activate"]) {
      const result = spawnSync(process.execPath, [script, mode, "--release", dir], { encoding: "utf8", env });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("FAIL: SUPABASE_DB_URL is required for load, verify and activate");
      const loopback = spawnSync(process.execPath, [script, mode, "--release", dir], {
        encoding: "utf8",
        env: { ...env, SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:55999/postgres" },
      });
      expect(loopback.status).toBe(1);
      expect(loopback.stderr).toContain("FAIL: Loopback database verification requires DB_VERIFY_DISPOSABLE_CONFIRM=pr-ci-disposable");
    }
    expect(() => parseArgs(["node", "load-union-catalog.mjs", "purge", "--release", dir])).toThrow(/Usage/);
    expect(() => parseArgs(["node", "load-union-catalog.mjs", "plan"])).toThrow(/--release/);
  });
});

describe("catalog_releases CHECKs (releaseRecordViolations)", () => {
  const SHA = "a".repeat(64);
  const valid = () => ({
    label: "20260924-01",
    releaseSchema: "union-catalog-release/1",
    filterVersion: "privacy-filter/1",
    sourceSha256: SHA,
    sourceBuiltAt: "2026-09-24T23:24:00.000Z",
    artifact: { sha256: SHA },
    counts: { organizations: 4, byTier: { local: 3, sub_local: 1 } },
    dropReport: { "documents.url:http_only": 1 },
  });
  const oversized = (entries) => Object.fromEntries(Array.from({ length: entries }, (_, i) => [`k${i}`, 1]));

  it("accepts a well-formed manifest", () => {
    expect(releaseRecordViolations(valid())).toEqual([]);
  });

  it.each([
    ["label", (m) => { m.label = "2026-09-24"; }, /^label does not match/],
    ["schema_version", (m) => { m.releaseSchema = "union-catalog-release/2"; }, /^releaseSchema \(schema_version\) is not union-catalog-release\/1$/],
    ["filter_version", (m) => { m.filterVersion = "privacy-filter/v1"; }, /^filterVersion \(filter_version\) does not match/],
    ["source_sha256", (m) => { m.sourceSha256 = SHA.toUpperCase(); }, /^sourceSha256 is not a lowercase hex sha256$/],
    ["artifact_sha256", (m) => { m.artifact = { sha256: SHA.slice(1) }; }, /^artifact\.sha256 is not a lowercase hex sha256$/],
    ["source_built_at", (m) => { delete m.sourceBuiltAt; }, /^sourceBuiltAt \(source_built_at\) is not a timestamp$/],
    ["counts array", (m) => { m.counts = [1, 2]; }, /^counts is not a JSON object$/],
    ["counts null", (m) => { m.counts = null; }, /^counts is not a JSON object$/],
    ["counts size", (m) => { m.counts = oversized(200); }, /^counts \(200 keys\) may take [0-9]+ bytes as jsonb; the cap is 4096$/],
    ["drop_report null", (m) => { m.dropReport = null; }, /^dropReport is not a JSON object or array$/],
    ["drop_report size", (m) => { m.dropReport = oversized(800); }, /^dropReport \(800 keys\) may take [0-9]+ bytes as jsonb; the cap is 16384$/],
  ])("names a %s violation by field only", (_, mutate, expected) => {
    const manifest = valid();
    mutate(manifest);
    const problems = releaseRecordViolations(manifest);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(expected);
  });

  it("bounds jsonb size at or above what Postgres 17 measured for the same fictional values", () => {
    // pg_column_size('<value>'::jsonb) on local Postgres 17.6.
    const measured = [
      [{}, 8],
      [{ a: 1 }, 28],
      [{ a: 1, b: 2 }, 44],
      [{ a: 0 }, 26],
      [{ a: 123456789 }, 32],
      [{ a: 1234567890123 }, 34],
      [{ a: { b: 1 } }, 44],
    ];
    for (const [value, size] of measured) {
      expect(jsonbSizeUpperBound(value)).toBeGreaterThanOrEqual(size);
      expect(jsonbSizeUpperBound(value)).toBeLessThanOrEqual(size * 1.6);
    }
    // The caps sit where the table CHECKs put them.
    expect(RELEASE_COUNTS_MAX_BYTES).toBe(4096);
    expect(RELEASE_DROP_REPORT_MAX_BYTES).toBe(16384);
  });
});
