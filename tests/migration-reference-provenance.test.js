// @vitest-environment node
//
// DOCS-UG-CASEWORK-RESTRICTION-GATE-MIGRATION-REFERENCES-STALE-20260921
//
// The casework restriction gates cite each other by migration number, in the
// prose a future consolidation of the four member_cases restriction predicates
// is meant to follow. Three of those citations were written before merge and
// never updated: the read-side gate was reviewed as 20260917010000 and the
// coordinator write-side gate as 20260917020000, and both were renumbered to
// 20260917103000 / 20260917104000 when they landed, so
// `ls supabase/migrations | grep -E '^2026091701|^2026091702'` is empty.
// Whoever consolidates the predicates was being pointed at filenames that do
// not exist, and nothing failed: verify:migrations hashes comment-stripped SQL,
// so a citation cannot rot loudly on its own.
//
// This is the guard. Every migration version a restriction-gate file cites in
// prose has to name a migration that is in the tree, wherever the prose can
// still change: the proofs, and any gate production has not applied yet.
//
// The two gates that carried the stale numbers (20260917104000 and
// 20260917105000) are applied history, kept as it shipped. Their prose is
// frozen, so
// the two citations are documented here as the exact set those gates carry
// (reviewed 20260917010000 landed as 20260917103000, reviewed 20260917020000 as
// 20260917104000), and this file fails if that frozen set ever changes in
// either direction. There is no deployed-baseline record to pin it to.
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrationNames, stripComments } from "./helpers/migration.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(repoRoot, "supabase", "migrations");
const testsDir = join(repoRoot, "tests");

// A 14-digit migration version, refused when it is only a slice of a longer
// digit run. The trailing boundary cannot be `\b`: a citation written as a
// whole filename ("20260917103000_case_child_row_restriction_gate.sql") runs on
// into an underscore, which `\b` counts as a word character, so the word-
// boundary form silently skips exactly the citations that name a file.
const VERSION = /(?<![0-9])20\d{12}(?![0-9])/g;

const versionsInTree = new Set(migrationNames().map((name) => name.slice(0, 14)));

// The imported, frozen history: every migration before Union Ground's own
// lane, which starts at 20261014000000. Every migration from that boundary on
// is Union Ground's and can still be edited.
const UNIONGROUND_LANE_START = "20261014000000";
const appliedNames = new Set(
  [...migrationNames()].filter((name) => name.slice(0, 14) < UNIONGROUND_LANE_START),
);
const isAppliedMigration = (path) => path.endsWith(".sql") && appliedNames.has(basename(path));

// The stale citations frozen inside applied gates. Each names the version the
// gate was reviewed under; the file it points at landed renumbered.
const FROZEN_CITATIONS = [
  "supabase/migrations/20260917104000_coordinator_case_write_restriction_gate.sql:26 cites 20260917010000",
  "supabase/migrations/20260917105000_case_attachment_lifecycle_restriction_gate.sql:3 cites 20260917020000",
];

// The restriction gates and the proofs that pin them. Discovered rather than
// listed so a gate added later is covered the day it lands.
const gateFiles = [
  ...readdirSync(migrationsDir)
    .filter((name) => name.endsWith("_restriction_gate.sql"))
    .map((name) => join(migrationsDir, name)),
  ...readdirSync(testsDir)
    .filter((name) => name.endsWith("-restriction-gate-db.test.js"))
    .map((name) => join(testsDir, name)),
].sort();

// What the prose cites. For SQL, a version that also survives comment
// stripping is that statement's own live subject rather than a cross-reference,
// so it is blanked here and left to the text pins that already cover it; the
// blanking preserves newlines, so reported line numbers stay the file's own.
function prose(path) {
  const text = readFileSync(path, "utf8");
  if (!path.endsWith(".sql")) return text;
  const executable = new Set(stripComments(text).match(VERSION) ?? []);
  return text.replace(VERSION, (version) => (executable.has(version) ? "" : version));
}

// `<label>:<line> cites <version>` for every cited version with no migration
// behind it. All of them, not the first: a renumbering typically breaks several
// citations at once and one repair pass should see the whole set.
function staleCitations(label, text) {
  const out = [];
  text.split("\n").forEach((line, index) => {
    for (const version of line.match(VERSION) ?? []) {
      if (!versionsInTree.has(version)) out.push(`${label}:${index + 1} cites ${version}`);
    }
  });
  return out;
}

describe("restriction-gate migration-number provenance", () => {
  it("scans every restriction gate and its proof, so a green run cannot be vacuous", () => {
    const scanned = gateFiles.map((path) => relative(repoRoot, path));
    expect(scanned).toEqual(
      expect.arrayContaining([
        "supabase/migrations/20260917103000_case_child_row_restriction_gate.sql",
        "supabase/migrations/20260917104000_coordinator_case_write_restriction_gate.sql",
        "supabase/migrations/20260917105000_case_attachment_lifecycle_restriction_gate.sql",
        "supabase/migrations/20260918200000_coordinator_kpis_restriction_gate.sql",
        "tests/case-attachment-lifecycle-restriction-gate-db.test.js",
        "tests/case-child-row-restriction-gate-db.test.js",
        "tests/coordinator-case-write-restriction-gate-db.test.js",
        "tests/coordinator-kpis-restriction-gate-db.test.js",
      ]),
    );
    // The set is only a cover if the scanned files actually cite migrations.
    const cited = gateFiles.flatMap((path) => prose(path).match(VERSION) ?? []);
    expect(cited.length).toBeGreaterThan(20);
  });

  it("cites only migrations that exist in the tree, wherever the prose can still change", () => {
    const stale = gateFiles
      .filter((path) => !isAppliedMigration(path))
      .flatMap((path) => staleCitations(relative(repoRoot, path), prose(path)));
    expect(stale).toEqual([]);
  });

  it("keeps the applied gates' historical citations frozen to the documented set", () => {
    const applied = gateFiles.filter(isAppliedMigration).map((path) => relative(repoRoot, path));
    expect(applied).toEqual(
      expect.arrayContaining(FROZEN_CITATIONS.map((entry) => entry.slice(0, entry.indexOf(":")))),
    );
    // Applied gates stay byte-identical, so this set cannot
    // shrink by editing them; it must not grow either.
    const stale = gateFiles
      .filter(isAppliedMigration)
      .flatMap((path) => staleCitations(relative(repoRoot, path), prose(path)));
    expect(stale.sort()).toEqual([...FROZEN_CITATIONS].sort());
  });

  it("treats only the imported history as frozen", () => {
    const names = [...migrationNames()];
    expect(appliedNames.size).toBeGreaterThan(600);
    expect(appliedNames.size).toBeLessThan(names.length);
    for (const name of names) {
      expect(appliedNames.has(name), name).toBe(name.slice(0, 14) < UNIONGROUND_LANE_START);
    }
    for (const entry of FROZEN_CITATIONS) expect(appliedNames.has(basename(entry.slice(0, entry.indexOf(":"))))).toBe(true);
    expect(isAppliedMigration(join(migrationsDir, "20991231000000_not_applied_restriction_gate.sql"))).toBe(false);
    expect(isAppliedMigration(join(testsDir, "case-child-row-restriction-gate-db.test.js"))).toBe(false);
  });

  it("names the citation when a cited migration is absent", () => {
    const fixture = [
      "-- 20260917103000 is the read-side gate, and it is in the tree.",
      "-- 20260917010000 is the number it was reviewed under, and it never landed.",
    ].join("\n");
    expect(staleCitations("fixture.sql", fixture)).toEqual(["fixture.sql:2 cites 20260917010000"]);
  });

  it("catches a citation written as a whole filename, not just a bare version", () => {
    const fixture = 'expect(name > "20260917020000_coordinator_case_write_restriction_gate.sql").toBe(true);';
    expect(staleCitations("fixture.test.js", fixture)).toEqual(["fixture.test.js:1 cites 20260917020000"]);
  });

  it("does not read a longer digit run as a migration version", () => {
    expect(staleCitations("fixture.sql", "-- 202609170100001 and 120260917010000 are not versions")).toEqual([]);
  });
});
