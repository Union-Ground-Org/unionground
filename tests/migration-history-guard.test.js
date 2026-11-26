// Covers the comparison logic behind `npm run verify:migrations`.
//
// Each case here is a failure that actually happened to this project on
// 2026-07-26, when a dev-branch build died on the third of 44 migrations and
// exposed that production's history could not be replayed at all.
import { describe, expect, it } from "vitest";
import {
  addedMigrationVersions,
  localMigrations,
  localRepoOrderingFailures,
  normalise,
  repoOnlyOrderingFailures,
  report,
} from "../scripts/verify-migration-history.mjs";

const L = (file, sql) => [file.slice(0, 14), { file, hash: normalise(sql) }];
const R = (version, name, sql) => [version, { name, hash: normalise(sql) }];

describe("normalise", () => {
  it("ignores comments and whitespace", () => {
    const a = "create table t (\n  id int\n);";
    const b = "-- a comment\ncreate table t (id int)";
    expect(normalise(a)).toBe(normalise(b));
  });

  it("does not ignore a changed identifier", () => {
    // The live case: the recorded migration inserted into
    // member_ballot_votes.created_at, which does not exist, while the deployed
    // function used submitted_at. A whitespace-only diff would have hidden it.
    const a = "insert into v (ballot_id, user_id, submitted_at) values (1,2,now())";
    const b = "insert into v (ballot_id, user_id, created_at) values (1,2,now())";
    expect(normalise(a)).not.toBe(normalise(b));
  });

  it("treats a comment-only file as a no-op, matching a NULL statements array", () => {
    expect(normalise("-- production history alias, intentionally a no-op\n")).toBeNull();
    expect(normalise(null)).toBeNull();
  });

  // The three cases below were false PASSes until 2026-07-26, when an
  // adversarial review found this function stripping comments with the naive
  // `/--[^\n]*/g` regex that tests/helpers/migration.js was written to warn
  // against, and flattening literal contents along with everything else.
  it("does not treat a -- inside a quoted literal as a comment", () => {
    // The old regex deleted from the hyphens to end of line, taking the rest of
    // the statement with it — so the two below hashed identically and a real
    // change to the trailing clause was invisible.
    const a = "insert into t (code, tier) values ('a--b', 'member')";
    const b = "insert into t (code, tier) values ('a--b', 'steward')";
    expect(normalise(a)).not.toBe(normalise(b));
  });

  it("keeps case and spacing INSIDE a literal significant", () => {
    // Identifiers are case- and space-insensitive here by design; literals are
    // data. 'Chapter steward' is a canon role label — collapsing it to
    // 'chaptersteward' made a genuine content change hash clean.
    expect(normalise("update t set role = 'Chapter steward'"))
      .not.toBe(normalise("update t set role = 'chaptersteward'"));
    expect(normalise("update t set role = 'Chapter steward'"))
      .not.toBe(normalise("update t set role = 'chapter steward'"));
  });

  it("still ignores identifier case, wrapping and trailing semicolons", () => {
    // The property that has to survive the fix: the platform and CLI apply
    // paths disagree about all three, and a comment added to an applied
    // migration must not manufacture drift against its recorded statements.
    expect(normalise("CREATE TABLE T (\n  ID INT\n);")).toBe(normalise("create table t (id int)"));
    expect(normalise("select 1; -- note added later\n")).toBe(normalise("select 1"));
  });

  it("reads a dollar-quoted body as one opaque literal", () => {
    // An odd apostrophe inside a dollar-quoted JSON fixture must not leave the
    // rest of the file read as a string, where the trailing semicolons the CLI
    // drops when it records statements would count as drift.
    const file = "insert into t select * from jsonb_array_elements($j$[\"it's\"]$j$);\ncommit;\n";
    const recorded = "insert into t select * from jsonb_array_elements($j$[\"it's\"]$j$)\ncommit";
    expect(normalise(file)).toBe(normalise(recorded));
    expect(normalise("select $j$[\"a\"]$j$")).not.toBe(normalise("select $j$[\"A\"]$j$"));
  });
});

describe("report", () => {
  it("passes when both sides agree", () => {
    const sql = "create table t (id int);";
    const local = new Map([L("20260101000000_thing.sql", sql)]);
    const remote = new Map([R("20260101000000", "thing", sql)]);
    expect(report(local, remote)).toEqual([]);
  });

  it("flags a migration that exists only in the repo", () => {
    // The untracked-execute_sql signature: DDL reached the database without
    // ever being recorded, so ~24 versions lived only in the repo.
    const local = new Map([L("20260101000000_thing.sql", "create table t (id int);")]);
    const findings = report(local, new Map());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/^MEMBERSHIP: 20260101000000/);
    expect(findings[0]).toMatch(/execute_sql/);
  });

  it("flags a migration that exists only on the project", () => {
    const remote = new Map([R("20260101000000", "thing", "create table t (id int);")]);
    const findings = report(new Map(), remote);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/cannot rebuild/);
  });

  it("separately flags a new local migration that is backdated behind deployed history", () => {
    const local = new Map([
      L("20260101000000_applied.sql", "select 1;"),
      L("20260101500000_backdated.sql", "select 2;"),
    ]);
    const remote = new Map([
      R("20260101000000", "applied", "select 1;"),
      R("20260102000000", "latest", "select 3;"),
    ]);
    const findings = report(local, remote);

    expect(findings.some((finding) => finding.startsWith("ORDERING: 20260101500000"))).toBe(true);
  });

  it("flags the same version whose content diverged", () => {
    const local = new Map([L("20260101000000_thing.sql", "insert into v (submitted_at) values (now());")]);
    const remote = new Map([R("20260101000000", "thing", "insert into v (created_at) values (now());")]);
    const findings = report(local, remote);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/^CONTENT: 20260101000000/);
  });

  it("explains a no-op alias facing recorded SQL", () => {
    const local = new Map([L("20260101000000_thing.sql", "-- no-op alias\n")]);
    const remote = new Map([R("20260101000000", "thing", "create table t (id int);")]);
    expect(report(local, remote)[0]).toMatch(/no-op alias but the project recorded real SQL/);
  });

  it("flags two versions carrying identical DDL", () => {
    // The collision that broke branch creation: the same DDL recorded twice,
    // harmless on a project where only one copy ever ran, fatal on replay.
    const sql = "create table demo_members (id uuid primary key);";
    const local = new Map([L("20260101000000_a.sql", sql), L("20260102000000_a.sql", sql)]);
    const remote = new Map([R("20260101000000", "a", sql), R("20260102000000", "a", sql)]);
    const findings = report(local, remote);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/^DUPLICATE: versions 20260101000000, 20260102000000/);
  });

  it("does not call two no-op aliases duplicates of each other", () => {
    const local = new Map([L("20260101000000_a.sql", "-- alias\n"), L("20260102000000_b.sql", "-- alias\n")]);
    const remote = new Map([R("20260101000000", "a", null), R("20260102000000", "b", null)]);
    expect(report(local, remote)).toEqual([]);
  });
});

describe("repo-only ordering", () => {
  it("rejects a newly added migration backdated behind the comparison base without a database connection", () => {
    const local = new Map([
      L("20260101000000_first.sql", "select 1;"),
      L("20260103000000_latest_base.sql", "select 3;"),
      L("20260102000000_backdated.sql", "select 2;"),
    ]);
    expect(repoOnlyOrderingFailures(local, ["20260102000000"]))
      .toEqual([expect.stringMatching(/^ORDERING: 20260102000000.*20260103000000/) ]);
  });

  it("allows every repo-only migration to sort after the comparison base", () => {
    const local = new Map([
      L("20260101000000_base.sql", "select 1;"),
      L("20260102000000_forward.sql", "select 2;"),
    ]);
    expect(repoOnlyOrderingFailures(local, ["20260102000000"])).toEqual([]);
  });

  it("allows only the byte-pinned deployed lineage restoration to be backdated", () => {
    const version = "20260824233000";
    const local = localMigrations();
    expect(repoOnlyOrderingFailures(local, [version])).toEqual([]);

    const altered = new Map(local);
    altered.set(version, { ...altered.get(version), sourceHash: "0".repeat(64) });
    expect(repoOnlyOrderingFailures(altered, [version]))
      .toEqual([expect.stringMatching(/^ORDERING: 20260824233000/)]);
  });

  it.each(["20260928233000", "20260928233100"])("preserves SAMPLE identity %s without admitting changed or renamed SQL", (version) => {
    const local = localMigrations();
    expect(repoOnlyOrderingFailures(local, [version])).toEqual([]);
    for (const change of [{ sourceHash: "0".repeat(64) }, { file: `${version}_different.sql` }]) {
      const altered = new Map(local);
      altered.set(version, { ...local.get(version), ...change });
      expect(repoOnlyOrderingFailures(altered, [version]))
        .toEqual([expect.stringMatching(new RegExp(`^ORDERING: ${version}`))]);
    }
  });

  it.each(["20260928233000", "20260928233100"])("still rejects missing or changed live history for SAMPLE-pinned identity %s", (version) => {
    const local = localMigrations();
    const remote = new Map([...local].map(([v, entry]) => [v, { name: entry.file, hash: entry.hash }]));
    remote.delete(version);
    expect(report(local, remote)).toEqual([
      expect.stringMatching(new RegExp(`^MEMBERSHIP: ${version}`)),
      expect.stringMatching(new RegExp(`^ORDERING: ${version}`)),
    ]);
    remote.set(version, { name: local.get(version).file, hash: "altered" });
    expect(report(local, remote)).toEqual([expect.stringMatching(new RegExp(`^CONTENT: ${version}`))]);
  });
});

// The rename case used to be covered by reading the guard's source text and
// asserting it contained the git argument list, which held whether or not that
// list was ever reached and never ran the step that turns the reported paths
// into versions. These drive the guard itself with rename-shaped git output.
describe("added migrations reported by git", () => {
  const RENAME_SHAPED_OUTPUT = [
    // A renumbering shows up as a plain addition of the new path only while
    // rename detection is off; with it on, git reports R and --diff-filter=A
    // drops the backdated version entirely.
    "supabase/migrations/20260102000000_renumbered.sql",
    "supabase/migrations/20260204000000_forward.sql",
    "",
  ].join("\n");

  const local = () => new Map([
    L("20260101000000_first.sql", "select 1;"),
    L("20260103000000_latest_base.sql", "select 3;"),
    L("20260102000000_renumbered.sql", "select 2;"),
    L("20260204000000_forward.sql", "select 4;"),
  ]);

  it("reads a version out of each added path git printed", () => {
    expect(addedMigrationVersions(RENAME_SHAPED_OUTPUT))
      .toEqual(["20260102000000", "20260204000000"]);
  });

  it("asks git for additions with renames disabled and flags the backdated one", () => {
    const calls = [];
    const findings = localRepoOrderingFailures(local(), {
      env: { MIGRATION_BASE_REF: "origin/main" },
      runGit: (args) => {
        calls.push(args);
        return RENAME_SHAPED_OUTPUT;
      },
    });

    expect(calls).toEqual([[
      "diff", "--no-renames", "--name-only", "--diff-filter=A", "origin/main...HEAD",
      "--", "supabase/migrations/*.sql",
    ]]);
    expect(findings).toEqual([
      expect.stringMatching(/^ORDERING: 20260102000000 \(20260102000000_renumbered\.sql\).*20260103000000/),
    ]);
  });

  it("does not consult git without a comparison base or with the migrations dir overridden", () => {
    const runGit = () => {
      throw new Error("git should not have been consulted");
    };
    expect(localRepoOrderingFailures(local(), { env: {}, runGit })).toEqual([]);
    expect(localRepoOrderingFailures(local(), {
      env: { MIGRATION_BASE_REF: "origin/main", DB_MIGRATIONS_DIR: "/tmp/migrations" },
      runGit,
    })).toEqual([]);
  });
});
