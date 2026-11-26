// Verifies that supabase/migrations/ and the live project's recorded migration
// history describe the same thing.
//
// This exists because on 2026-07-26 they did not. The repo held 66 files, the
// project held 44 rows, and only 36 were shared. Roughly 24 migrations had
// reached production through untracked `execute_sql` and appeared in no
// migration row at all; three had run on production and existed in no file.
// Nothing surfaced it, because nothing had ever tried to replay the history
// from zero. The first attempt — creating a dev branch — died on the third
// statement, and two further fatals were waiting behind it.
//
// Three failure classes are checked, each of which occurred for real:
//
//   1. MEMBERSHIP  — a version on one side and not the other. This is the
//      untracked-execute_sql signature and the one that actually broke branch
//      creation and any rebuild-from-migrations.
//   2. CONTENT     — the same version whose recorded SQL differs from the file.
//      Seen live: 20260726000000's recorded text inserted into
//      member_ballot_votes.created_at, a column that does not exist, while the
//      deployed function correctly used submitted_at. A PL/pgSQL body installs
//      without validating column references, so this class installs clean and
//      only fails when the function is finally called.
//   3. ORDERING    — a repo-only version sorts before the newest applied
//      version. It would be skipped by a forward-only deployment even though
//      a from-zero replay succeeds.
//   4. DUPLICATE   — two versions carrying identical DDL. Harmless on a project
//      where only one of them ever executed, fatal on replay, where both do.
//
// Transport is `pg` over SUPABASE_DB_URL, matching verify-db-contract.mjs.
//
//   SUPABASE_DB_URL='postgresql://...' npm run verify:migrations
//
// SUPABASE_DB_URL unset -> SKIP, exit 0, so CI without the secret stays green.
// REQUIRE_DB_VERIFY turns that skip into a hard failure; see
// lib/require-db-verify.mjs for the values that arm it.
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { assertExactTarget, postgresSslForTarget, postgresConnectionStringForTarget } from "./lib/assert-exact-target.mjs";
import { canonicaliseSql } from "./lib/sql-text.mjs";
import { requireDbVerify } from "./lib/require-db-verify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = process.env.DB_MIGRATIONS_DIR
  || join(HERE, "..", "supabase", "migrations");
const contractPath = process.env.DB_CONTRACT_PATH || join(HERE, "db-contract.json");
const contract = JSON.parse(readFileSync(contractPath, "utf8"));

// Preserve exact identities already recorded by a hosted database. Renumbering
// them after a concurrent Main migration would break that database's history.
// These pins apply only to repository addition ordering: live membership,
// content, ordering and duplicate checks below remain mandatory. Pin filename
// and raw hash so this cannot admit new or edited backdated SQL.
const DEPLOYED_LINEAGE_PINS = new Map([
  // Restore an accidentally removed deployed migration.
  ["20260824233000", {
    file: "20260824233000_uniondemo_org_seed.sql",
    sourceHash: "ef2a03640a297d6a03a6e2f33f86f5364bde474c3423a96abcb45ff360710e36",
  }],
  // Applied to SAMPLE before Main gained 20260929034500. The application,
  // exact statement hashes and preserved history are retained in
  // docs/learning-content-sample-application-20260929.md. These entries do
  // not assert production application or authorize an out-of-order rollout.
  ["20260928233000", {
    file: "20260928233000_governed_learning_content.sql",
    sourceHash: "1a181808b16001f7f4456bcdace35f807b2616744858f3d0f6a6eb9f63dd3888",
  }],
  ["20260928233100", {
    file: "20260928233100_learning_content_recovered_drafts.sql",
    sourceHash: "fbfc76be5a785664f1c246c6950dc0c0aeef48024e4e808fa1fe910b5a03731b",
  }],
]);

// Comment- and whitespace-insensitive. Two files that differ only by line
// wrapping or commentary describe the same migration; two that differ by a
// single identifier do not. Semicolons are stripped because the platform and
// CLI apply paths disagree about trailing ones.
//
// The canonicaliser is shared with the test suite's migration helper rather
// than reimplemented here. It used to be `.replace(/--[^\n]*/g, "")`, which
// deletes the rest of the line whenever a `--` appears inside a quoted literal
// and so dropped real SQL from the hash, and it lowercased and space-stripped
// literal CONTENTS, so `'Chapter steward'` and `'chaptersteward'` hashed the
// same. Both were false-PASS classes: drift the checker could not see.
export function normalise(sql) {
  if (sql === null || sql === undefined) return null;
  // Dollar-quoted bodies are compared byte for byte: without that, a quote or
  // `--` inside a dollar-quoted JSON fixture flips how the rest of the file is
  // read, and the trailing semicolons the CLI drops when it records statements
  // then read as content.
  const stripped = canonicaliseSql(sql, { dollarQuotes: true });
  // A file that is nothing but comments is a deliberate no-op alias, which is
  // the same thing as a NULL statements array on the remote side.
  if (stripped === "") return null;
  return createHash("md5").update(stripped).digest("hex");
}

export function localMigrations() {
  const out = new Map();
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"))) {
    const version = file.slice(0, file.indexOf("_"));
    if (!/^\d{14}$/.test(version)) {
      throw new Error(`Migration filename does not start with a 14-digit version: ${file}`);
    }
    if (out.has(version)) {
      throw new Error(`Duplicate local migration version ${version}: ${file} and ${out.get(version).file}`);
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    out.set(version, {
      file,
      hash: normalise(sql),
      sourceHash: createHash("sha256").update(sql).digest("hex"),
    });
  }
  return out;
}

function isPinnedDeployedLineage(local, version) {
  const expected = DEPLOYED_LINEAGE_PINS.get(version);
  const actual = local.get(version);
  return expected !== undefined
    && actual?.file === expected.file
    && actual?.sourceHash === expected.sourceHash;
}

export function repoOnlyOrderingFailures(local, addedVersions) {
  const added = new Set(addedVersions);
  const baselineVersions = [...local.keys()].filter((version) => !added.has(version)).sort();
  const newestBaseline = baselineVersions.at(-1);
  if (!newestBaseline) return [];
  return [...added].sort()
    .filter((version) => version <= newestBaseline && !isPinnedDeployedLineage(local, version))
    .map((version) => (
      `ORDERING: ${version} (${local.get(version)?.file || "unknown file"}) is repo-only but does not sort after `
      + `the newest migration already present at the comparison base, ${newestBaseline}.`
    ));
}

// The version is the leading 14 digits of the filename, whatever directory
// prefix git printed in front of it.
export function addedMigrationVersions(diffOutput) {
  return diffOutput.trim().split("\n").filter(Boolean)
    .map((name) => name.split("/").at(-1)?.slice(0, 14))
    .filter(Boolean);
}

// `runGit` is injectable so the rename case can be covered without a scratch
// repository: with rename detection left on, a renumbered migration is reported
// as R and --diff-filter=A never sees the backdated version at all.
export function localRepoOrderingFailures(local, {
  env = process.env,
  runGit = (args) => execFileSync("git", args, { cwd: join(HERE, ".."), encoding: "utf8" }),
} = {}) {
  if (env.DB_MIGRATIONS_DIR) return [];
  const baseRef = env.MIGRATION_BASE_REF || env.CI_BASE_SHA || env.ASSURANCE_BASE_REF;
  if (!baseRef) return [];
  const names = runGit([
    "diff", "--no-renames", "--name-only", "--diff-filter=A", `${baseRef}...HEAD`, "--", "supabase/migrations/*.sql",
  ]);
  return repoOnlyOrderingFailures(local, addedMigrationVersions(names));
}

async function remoteMigrations(client) {
  const { rows } = await client.query(
    `select version, name, array_to_string(statements, E'\n') as sql
       from supabase_migrations.schema_migrations
      order by version`,
  );
  return new Map(rows.map((r) => [r.version, { name: r.name, hash: normalise(r.sql) }]));
}

export function report(local, remote) {
  const failures = [];

  // 1. MEMBERSHIP
  const localOnly = [...local.keys()].filter((v) => !remote.has(v)).sort();
  const remoteOnly = [...remote.keys()].filter((v) => !local.has(v)).sort();
  for (const v of localOnly) {
    failures.push(
      `MEMBERSHIP: ${v} (${local.get(v).file}) exists in the repo but not in the project's history. `
      + "Its DDL likely reached the database through execute_sql without a migration row.",
    );
  }
  for (const v of remoteOnly) {
    failures.push(
      `MEMBERSHIP: ${v} (${remote.get(v).name}) exists in the project's history but has no local file. `
      + "The repo cannot rebuild this database.",
    );
  }

  // 2. ORDERING. Membership already makes the comparison fail, but this
  // dedicated diagnostic prevents a backdated new file from being mistaken
  // for ordinary unapplied forward work.
  const newestRemote = [...remote.keys()].sort().at(-1);
  if (newestRemote) {
    for (const v of localOnly.filter((version) => version < newestRemote)) {
      failures.push(
        `ORDERING: ${v} (${local.get(v).file}) is newer work whose version sorts before `
        + `the latest recorded migration ${newestRemote}. Renumber it after the deployed history before release.`,
      );
    }
  }

  // 3. CONTENT
  for (const [v, l] of [...local].sort()) {
    const r = remote.get(v);
    if (!r) continue;
    if (l.hash !== r.hash) {
      const detail = l.hash === null
        ? "the local file is a no-op alias but the project recorded real SQL"
        : r.hash === null
          ? "the project recorded no SQL but the local file is not a no-op alias"
          : `local ${l.hash.slice(0, 8)} vs recorded ${r.hash.slice(0, 8)}`;
      failures.push(`CONTENT: ${v} (${l.file}) differs from the recorded statements — ${detail}.`);
    }
  }

  // 4. DUPLICATE — only meaningful among non-no-op migrations.
  const byHash = new Map();
  for (const [v, r] of remote) {
    if (r.hash === null) continue;
    if (!byHash.has(r.hash)) byHash.set(r.hash, []);
    byHash.get(r.hash).push(v);
  }
  for (const [, versions] of byHash) {
    if (versions.length > 1) {
      failures.push(
        `DUPLICATE: versions ${versions.sort().join(", ")} carry identical DDL. `
        + "A replay executes all of them and the second will collide. "
        + "Null the redundant rows' statements and make the local files no-op aliases.",
      );
    }
  }

  return failures;
}

async function main() {
  let local;
  try {
    local = localMigrations();
    const localOrderFailures = localRepoOrderingFailures(local);
    if (localOrderFailures.length > 0) {
      for (const failure of localOrderFailures) console.error(`FAIL: ${failure}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    if (requireDbVerify()) {
      console.error("FAIL: SUPABASE_DB_URL not set but REQUIRE_DB_VERIFY=1 — this lane must verify the live history.");
      process.exit(1);
    }
    if (process.env.GITHUB_ACTIONS === "true") {
      console.log("::warning title=verify:migrations skipped::SUPABASE_DB_URL is not set, so migration history was NOT verified in this run.");
    }
    console.log("SKIP: SUPABASE_DB_URL not set — migration history was not verified.");
    process.exit(0);
  }

  try {
    assertExactTarget(contract.target, connectionString, {
      disposableConfirm: process.env.DB_VERIFY_DISPOSABLE_CONFIRM,
    });
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: postgresConnectionStringForTarget(connectionString),
    ssl: postgresSslForTarget(connectionString),
    application_name: "verify-migration-history",
  });

  let failures;
  let remote;
  try {
    await client.connect();
    remote = await remoteMigrations(client);
    failures = report(local, remote);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }

  console.log(`local files: ${local.size}   recorded rows: ${remote.size}`);
  if (failures.length > 0) {
    console.error(`\nFAIL: migration history and repo disagree (${failures.length} finding${failures.length === 1 ? "" : "s"}):\n`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error("\nThe project cannot be rebuilt from its migrations while this is true.");
    process.exit(1);
  }
  console.log("PASS: every migration matches by version and by content, with no duplicate DDL.");
}

// Only run when invoked directly. verify-db-contract.mjs calls process.exit at
// import time, which is why its sibling lane could not reuse anything from it
// and kept a duplicate copy of the target guard. This module stays importable
// so `normalise` and `report` can be covered by tests without a live database.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
