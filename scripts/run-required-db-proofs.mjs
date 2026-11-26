import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { createRequiredDbProofOutcome } from "./lib/required-db-proof-outcome.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
// The required proof files are discovered, not listed. Owner ruling of October
// 28, 2026, 6:49 PM ET (pipeline loosening, wave 5): the hand list of
// [file, case floor] pairs that stood here was edited by 111 commits in 14 days
// and conflicted on re-merges, because every delivery that added or grew a
// proof edited it. Every tests/*-db.test.js(x) file is now planned unless
// MANUAL_ONLY_DB_PROOF_FILES below says why it stays out, plus the few proof
// files named before the -db suffix was the convention. Two fixed floors keep
// a proof from disappearing silently: the planned file count may not fall
// below REQUIRED_DB_PROOF_FILE_FLOOR, and the executed case count may not fall
// below REQUIRED_DB_PROOF_FLOOR. Both were measured on October 28, 2026 and
// only need an edit when a proof is retired on purpose. Adding a proof needs no floor edit.
export const NAMED_PROOF_FILES = Object.freeze([
  "tests/connection-suggestions-migration.test.js",
  "tests/mi1-expected-organization-guard-lineage-repair.test.js",
  "tests/mi1-casework-rls-helper-acl-repair.test.js",
  "tests/institutional-records.test.js",
  "tests/member-engagement-completion-migration.test.js",
  "tests/organization-survey-ancestor-postgres.test.js",
  "tests/password-signin-success-refund-postgres.test.js",
]);
// 274 planned files and 2,581 collected cases on October 28, 2026; the
// org-start guide proof added 1 and 9, the staff feature guide proof 1 and 10.
export const REQUIRED_DB_PROOF_FILE_FLOOR = 276;
export const REQUIRED_DB_PROOF_FLOOR = 2600;
// The scanner proof's cases, deferred with it when the lane is not provisioned.
export const PIPELINE_PROOF_CASES = 1;


// TEST-UG-RUN-DB-TEST-GATE-INVENTORY-GAP-20260920. PROOF_FILES is a named
// list, so requiredDbProofFlagEnv() below only ever opens the gates those files
// read. A live suite outside that list can read its own RUN_*_DB_TESTS gate that
// no CI job and no proof lane sets, and it then skips in every run forever with
// nothing failing. Every such gate is dispositioned here with the reason it
// stays out of the required lane and how it is exercised instead.
// tests/required-db-proof-runner.test.js derives the real inventory from the
// test tree and fails on any gate that is neither opened by
// requiredDbProofFlagEnv nor named here, so a new permanently-skipped suite
// cannot land silently and deleting a disposition below fails the same test.
export const MANUAL_ONLY_DB_GATES = {
  RUN_LOCAL_DB_TESTS:
    "Legacy shared gate for tests/mi1-organization-coordination-db.test.js, tests/member-support-db.test.js and tests/compass-authoritative-knowledge.test.js; each applies its own migration text to a hand-prepared local database, so it is run by hand (RUN_LOCAL_DB_TESTS=1 SUPABASE_DB_URL=<owned disposable> npx vitest run <file>) rather than against the shared required-proof schema.",
  RUN_REPOSITORY_CONVENTIONS_DB_TESTS:
    "One case inside the otherwise offline tests/repository-conventions.test.js applies a deliberately failing migration to prove it leaves no partial change; opening it in the required lane would run that failure against the schema every other proof file shares.",
  RUN_CASE_SEARCH_DB_TESTS:
    "tests/member-case-search-db.test.js seeds a large token-tagged case corpus to compare search results with RLS visibility; run by hand via `npm run verify:case-search-db` against an owned disposable stack.",
};

// Every tests/*-db.test.js(x) file the required lane does not plan, with the
// reason it stays out and how it is run instead. The gate inventory above only
// sees files that read a RUN_*_DB_TESTS gate; a proof gated on
// SUPABASE_DB_URL or REQUIRE_DB_REPAIR_PROOFS alone skips in every plain run
// without reading one. tests/required-db-proof-runner.test.js fails on a
// -db file that is neither planned nor listed here, and on an entry that is
// planned or names no file. Shrink this list by promoting, never by deleting.
export const MANUAL_ONLY_DB_PROOF_FILES = {
  "tests/password-reset-recovery-claim-db.test.js":
    "Runs automatically in root CI against its own temporary socket-only PostgreSQL instance. Its isolated recovery-claim schema and real role/lock-order checks must not replace the shared required-proof schema; no hosted URL or external database is accepted.",
  "tests/legacy-agency-chapters-db.test.js":
    "Runs automatically in the root test lane against its own temporary socket-only PostgreSQL instance. It rebuilds a minimal schema to exercise refusal and rollback cases and must not run against the shared required-proof schema; no hosted URL or external database is accepted.",
  "tests/compass-ai-governance-db.test.js":
    "Static migration pins only, despite the name: it opens no connection and already runs in the plain vitest lane.",
  "tests/member-case-search-db.test.js":
    "Seeds a large token-tagged case corpus (RUN_CASE_SEARCH_DB_TESTS); run by hand via `npm run verify:case-search-db`.",
  "tests/member-support-db.test.js":
    "Applies its own migration text to a hand-prepared local database (RUN_LOCAL_DB_TESTS), so it cannot share the required-proof schema; run by hand.",
  "tests/mi1-organization-coordination-db.test.js":
    "Applies its own migration text to a hand-prepared local database (RUN_LOCAL_DB_TESTS), so it cannot share the required-proof schema; run by hand.",
};

export const PIPELINE_PROOF_FILE = "tests/private-file-pipeline-db.test.js";

export function discoverRequiredDbProofFiles(root = ROOT) {
  const directory = join(root, "tests");
  const discovered = existsSync(directory)
    ? readdirSync(directory).filter((name) => /-db\.test\.jsx?$/.test(name)).map((name) => `tests/${name}`)
    : [];
  return [...new Set([...discovered, ...NAMED_PROOF_FILES])]
    .filter((file) => !Object.hasOwn(MANUAL_ONLY_DB_PROOF_FILES, file))
    .sort();
}
export const PROOF_FILES = Object.freeze(discoverRequiredDbProofFiles());

// The real four-kind ClamAV pipeline proof needs the scanner lane that
// .github/workflows/ci.yml provisions (TLS fixtures + a pinned clamd). Ruleset
// 21326765 runs ci.yml@refs/heads/Main for pull requests, so a candidate that
// introduces or changes that lane cannot exercise it before merge. The proof is
// therefore required whenever the lane is provisioned OR the workflow revision
// demands it (PRIVATE_FILE_SCANNER_PROOF_REQUIRED=1, which ci.yml sets); only
// when neither holds is exactly this one proof deferred, loudly, and the floor
// lowered by exactly one. Demanding the proof without provisioning the lane is
// an error, never a skip.
export function scannerLaneProvisioned(env = process.env) {
  return Boolean((env.PRIVATE_FILE_PIPELINE_SCANNER_DIR ?? "").trim()) && Boolean((env.PRIVATE_FILE_PIPELINE_CLAMD_PORT ?? "").trim());
}

export function requiredDbProofPlan(env = process.env, files = PROOF_FILES) {
  if (files.length < REQUIRED_DB_PROOF_FILE_FLOOR) {
    throw new Error(`Expected at least ${REQUIRED_DB_PROOF_FILE_FLOOR} required DB proof files, discovered ${files.length}; a proof file disappeared. Restore it or declare it in MANUAL_ONLY_DB_PROOF_FILES with its reason`);
  }
  const provisioned = scannerLaneProvisioned(env);
  const demanded = env.PRIVATE_FILE_SCANNER_PROOF_REQUIRED === "1";
  if (provisioned) return { files: [...files], floor: REQUIRED_DB_PROOF_FLOOR, deferred: [] };
  if (demanded) {
    throw new Error("PRIVATE_FILE_SCANNER_PROOF_REQUIRED=1 but the scanner lane is not provisioned (PRIVATE_FILE_PIPELINE_SCANNER_DIR and PRIVATE_FILE_PIPELINE_CLAMD_PORT); refusing to defer the real four-kind ClamAV pipeline proof");
  }
  return {
    files: files.filter((file) => file !== PIPELINE_PROOF_FILE),
    floor: REQUIRED_DB_PROOF_FLOOR - PIPELINE_PROOF_CASES,
    deferred: [PIPELINE_PROOF_FILE],
  };
}

// Pull-request runs plan only the proofs related to the change (Main cost
// audit R4, approved November 6, 2026): the full plan took 1,841 s on every
// database-touching pull-request run and again in the merge group, and HEADGREEN
// still runs the full plan and its fixed floors on every merge_group and push.
// The workflow names its event, base and head in REQUIRED_DB_PROOF_EVENT,
// REQUIRED_DB_PROOF_BASE and REQUIRED_DB_PROOF_HEAD; without them (a local run
// or an older workflow revision) the full plan runs. The related plan and its
// reduced floor are accepted only when GitHub itself reports pull_request.
// Related means the root-tests job's needle selection in ci.yml: a planned file
// that changed, or whose text names a changed path or its basename. A change
// to migrations, the DB contract or any DB proof plans every proof: schema-wide
// invariants cannot be selected by textual references to the changed file.
// The runner, shared proof setup, dependency lock and changes wider than
// DB_PROOF_WHOLE_PLAN_PATH_LIMIT paths also plan every proof.
export const DB_PROOF_RELATED_EVENT = "pull_request";
export const DB_PROOF_WHOLE_PLAN_PATH_LIMIT = 400;
const WHOLE_DB_PROOF_PLAN_PATHS = [
  /^scripts\/run-required-db-proofs\.mjs$/,
  /^scripts\/db-proof-shard-count\.mjs$/,
  /^scripts\/lib\/required-db-proof-outcome\.mjs$/,
  /^scripts\/lib\/db-contract/,
  /^scripts\/db-contract\.json$/,
  /^supabase\/migrations\//,
  /^supabase\/config\.toml$/,
  /^tests\/[^/]+-db\.test\.jsx?$/,
  /^tests\/helpers\//,
  /^tests\/setup\.js$/,
  /^package(-lock)?\.json$/,
  /^vite\.config\./,
  /^vitest\./,
];

export function requiredDbProofScope(env = process.env) {
  const event = (env.REQUIRED_DB_PROOF_EVENT ?? "").trim();
  if (!event) return { mode: "full" };
  if (event !== env.GITHUB_EVENT_NAME) {
    throw new Error(`REQUIRED_DB_PROOF_EVENT=${event} does not match GITHUB_EVENT_NAME=${env.GITHUB_EVENT_NAME ?? "(unset)"}; the related proof plan is accepted only on a real pull_request run`);
  }
  if (event !== DB_PROOF_RELATED_EVENT) return { mode: "full", event };
  const base = (env.REQUIRED_DB_PROOF_BASE ?? "").trim();
  const head = (env.REQUIRED_DB_PROOF_HEAD ?? "").trim();
  if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) {
    throw new Error("A pull_request proof run needs REQUIRED_DB_PROOF_BASE and REQUIRED_DB_PROOF_HEAD as full commit SHAs");
  }
  return { mode: "related", event, base, head };
}

function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || "").trim()}`);
  return result.stdout;
}

// Compared from the merge base, as the scope job does, so commits that reached
// Main after the branch point do not count as this change.
export function changedPathsForDbProofs(base, head, runGit = git) {
  const mergeBase = runGit(["merge-base", base, head]).trim();
  return runGit(["diff", "--name-only", "-z", "--no-renames", mergeBase, head, "--"]).split("\0").filter(Boolean);
}

export function dbProofNeedles(changed) {
  const needles = new Set();
  for (const path of changed) {
    needles.add(path);
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!/^index\./.test(name) && name !== "package.json" && name !== "README.md" && name.length >= 8) needles.add(name);
  }
  return [...needles];
}

// Returns the plan unchanged when the change needs every proof. Otherwise the
// related files keep the full plan's order
// and always include the pristine proofs, which own the first phase, and
// the scanner pipeline proof, whose artifact the workflow uploads. The floor is
// the pristine floor plus the cases the related shared-phase files collect, so
// a related file whose cases skip still fails the run.
export function dbProofChangeNeedsWholePlan(changed) {
  return changed.length > DB_PROOF_WHOLE_PLAN_PATH_LIMIT
    || changed.some((path) => NAMED_PROOF_FILES.includes(path)
      || WHOLE_DB_PROOF_PLAN_PATHS.some((pattern) => pattern.test(path)));
}

export function relatedDbProofPlan(plan, changed, {
  readText = (file) => readFileSync(resolve(ROOT, file), "utf8"),
  collect = collectRequiredDbProofCases,
} = {}) {
  if (dbProofChangeNeedsWholePlan(changed)) {
    return { ...plan, scope: "full", changed: changed.length };
  }
  const always = new Set([...PRISTINE_DB_PROOFS, PIPELINE_PROOF_FILE]);
  const changedSet = new Set(changed);
  const needles = dbProofNeedles(changed);
  const files = plan.files.filter((file) => {
    if (always.has(file) || changedSet.has(file)) return true;
    const text = readText(file);
    return needles.some((needle) => text.includes(needle));
  });
  const shared = files.filter((file) => !PRISTINE_DB_PROOFS.includes(file));
  if (shared.length === 0) {
    throw new Error("The related DB proof plan has no shared-fixture proof; refusing to hand Vitest an empty file list");
  }
  const collected = collect({ ...plan, files: shared });
  const empty = shared.filter((file) => !(collected.byFile[file] > 0));
  if (empty.length) throw new Error(`Related DB proof files collected no case: ${empty.join(", ")}`);
  return { ...plan, files, floor: PRISTINE_DB_PROOF_FLOOR + collected.total, scope: "related", changed: changed.length };
}

// Every RUN_*_DB_TESTS flag the proof files gate their cases on. main() hands
// these to each phase, and collectRequiredDbProofCases() hands the same set to
// `vitest list`, so the collected count is the count a live run executes.
export function requiredDbProofFlagEnv(plan) {
  return {
    RUN_EXPECTED_ORG_GUARD_DB_TESTS: "1",
    RUN_FORMS_DISCARD_DB_TESTS: "1",
    RUN_CASEWORK_RLS_ACL_DB_TESTS: "1",
    RUN_SENSITIVE_CONTENT_DB_TESTS: "1",
    RUN_MFA_EVENT_BOUNDARY_DB_TESTS: "1",
    RUN_DB_BOUNDARY_TENANCY_DB_TESTS: "1",
    RUN_SAMPLE_STAFF_RPC_BOUNDARY_DB_TESTS: "1",
    RUN_CBA_INGEST_DB_TESTS: "1",
    RUN_OPTIONAL_PROVIDER_DB_TESTS: "1",
    RUN_G5_ATTACHMENT_REMOVAL_ORACLE_DB_TESTS: "1",
    RUN_TASK_FILES_RECONCILE_ROUTE_DB_TESTS: "1",
    RUN_PUBLIC_TABLE_GRANTS_DB_TESTS: "1",
    RUN_G5_NATIVE_PUSH_LINEAGE_DB_TESTS: "1",
    RUN_COMPASS_RETRIEVAL_DB_TESTS: "1",
    RUN_DATABASE_ASSURANCE_DB_TESTS: "1",
    RUN_PRIVATE_FILE_AUTHORIZATION_DB_TESTS: "1",
    RUN_PRIVATE_FILE_WORKFLOW_GATE_DB_TESTS: "1",
    RUN_PRIVATE_FILE_STORAGE_DB_TESTS: "1",
    RUN_CHAPTER_POST_REFERENTIAL_DB_TESTS: "1",
    RUN_PRIVATE_SPACE_MEMBERSHIP_DB_TESTS: "1",
    RUN_MESSAGE_PRESERVATION_DB_TESTS: "1",
    RUN_NATIVE_MESSAGE_ACTIONS_DB_TESTS: "1",
    RUN_ACCOUNT_LIFECYCLE_DB_TESTS: "1",
    RUN_CASE_HISTORY_DB_TESTS: "1",
    RUN_CASE_BULK_STEP_DB_TESTS: "1",
    RUN_CASE_MACRO_DB_TESTS: "1",
    RUN_MEMBER_INVITATION_RATE_LIMIT_DB_TESTS: "1",
    RUN_KNOWLEDGE_CONVERSION_PROVENANCE_DB_TESTS: "1",
    RUN_CRON_JOB_HEALTH_SYNC_DB_TESTS: "1",
    RUN_AUTH_BOOKKEEPING_LOCK_SCOPE_DB_TESTS: "1",
    RUN_RLS_HOME_POLICY_COST_DB_TESTS: "1",
    RUN_RETURNED_SEALED_FORM_RESIGN_DB_TESTS: "1",
    RUN_FORMS_TEMPLATE_SIGNATURE_DB_TESTS: "1",
    RUN_STEWARD_DESK_SCALE_DB_TESTS: "1",
    RUN_MEMBERSHIP_CARD_NONCE_DB_TESTS: "1",
    RUN_ADMIN_MFA_LEGAL_HOLD_DB_TESTS: "1",
    RUN_CHAPTER_VERIFICATION_IDENTITY_DB_TESTS: "1",
    RUN_CASEWORK_MACRO_AUDIENCE_DB_TESTS: "1",
    RUN_MFA_RESET_PENDING_NOTICE_DB_TESTS: "1",
    RUN_ORG_STRUCTURE_IMPORT_DB_TESTS: "1",
    // TEST-UG-DB-PROOFS-PROMOTE-REMAINING-MANUAL-SUITES-20260925.
    RUN_INSTITUTIONAL_EXPORT_AUDIT_DB_TESTS: "1",
    RUN_MEMBER_SAVED_VIEWS_DB_TESTS: "1",
    RUN_APPOINTMENT_BOUNDARY_DB_TESTS: "1",
    RUN_MEMBER_STEWARD_COMPOSITION_DB_TESTS: "1",
    RUN_LIVE_POLL_CHAPTER_SCOPE_DB_TESTS: "1",
    RUN_SURVEY_PUBLISH_ATOMICITY_DB_TESTS: "1",
    RUN_COORDINATION_TRANSITION_OWNERSHIP_DB_TESTS: "1",
    RUN_MEMBER_ACCESS_EVENT_AUDIENCE_DB_TESTS: "1",
    RUN_APPOINTMENT_HISTORY_DB_TESTS: "1",
    RUN_UNION_CATALOG_DB_TESTS: "1",
    RUN_UNION_CATALOG_RESEARCH_DB_TESTS: "1",
    RUN_CATALOG_SETUP_PLACEMENT_DB_TESTS: "1",
    RUN_ORGANIZATION_CLAIM_DB_TESTS: "1",
    RUN_ORGANIZATION_CLAIM_DELETION_DB_TESTS: "1",
    RUN_OPEN_SIGNUP_ORGANIZATION_DB_TESTS: "1",
    RUN_ORGANIZATION_FOUNDER_INVITATION_DB_TESTS: "1",
    RUN_END_MEMBER_AUTH_SESSIONS_DB_TESTS: "1",
    RUN_MEMBER_SINCE_DEFAULT_DB_TESTS: "1",
    RUN_NATIVE_SESSION_MANAGEMENT_DB_TESTS: "1",
    RUN_UNIONGROUND_STAFF_ROSTER_DB_TESTS: "1",
    RUN_UNIONGROUND_SIBLING_DISPATCH_DB_TESTS: "1",
    RUN_UNIONGROUND_ORGANIZING_CONTENT_DB_TESTS: "1",
    RUN_CALENDAR_FEED_CANCELLATION_DB_TESTS: "1",
    ...(plan.deferred.length === 0 ? { RUN_PRIVATE_FILE_PIPELINE_DB_TESTS: "1" } : {}),
  };
}

// Collection only: `vitest list` evaluates the proof files' describe bodies and
// never runs a case or a hook, so no database is needed. Several files validate
// SUPABASE_DB_URL while they are collected, so an ambient URL is always
// replaced by this placeholder inside the owned disposable loopback range;
// nothing connects to it. Three files gate on REQUIRE_DB_REPAIR_PROOFS, which
// main() inherits from its caller and the collector therefore sets itself.
// A skipped case is not listed, so a gate the runner forgets to open shows up
// here as a missing case rather than as a silent skip. It empties a file only
// when every case in that file is gated; a file that mixes offline pins with
// gated live cases just collects fewer, so tests/required-db-proof-runner.test.js
// also asserts that every RUN_*_DB_TESTS gate a planned file reads is opened by
// requiredDbProofFlagEnv. Collection loads vite.config.mjs, whose build marker
// needs an exact commit SHA, so it works in a git checkout and not in a tarball
// copy; that failure is reported through the thrown message.
export const REQUIRED_DB_PROOF_COLLECTION_URL = "postgresql://postgres:postgres@127.0.0.1:55999/postgres";

export function collectRequiredDbProofCases(plan) {
  const listDir = mkdtempSync(join(tmpdir(), "required-db-proof-collection-"));
  try {
    const listPath = join(listDir, "cases.json");
    const result = spawnSync(process.execPath, [
      // --no-isolate: Main run 39839722613 (October 22, 2026) timed the floor
      // test out at 120 s on GitHub's 2-vCPU runner, because a fresh module
      // graph for each of the ~260 files cost about 59 s of a two-CPU budget.
      // One shared graph lists the identical 2,409 cases (same files, same
      // names) in about 9 s. A file that changed process.env while it was
      // collected could open another file's gate here, but every RUN_*_DB_TESTS
      // gate is already opened above and asserted by the runner test.
      // Vitest 5 lists through static parsing by default, which cannot see
      // aliased databaseIt calls or expand runtime-generated proof cases.
      // Collect the cases the opened gates actually register, without hooks.
      resolve(ROOT, "node_modules/vitest/vitest.mjs"), "list", ...plan.files, `--json=${listPath}`, "--no-isolate", "--no-static-parse",
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        SUPABASE_DB_URL: REQUIRED_DB_PROOF_COLLECTION_URL,
        EXPECTED_ORG_GUARD_DB_URL: REQUIRED_DB_PROOF_COLLECTION_URL,
        CASEWORK_RLS_ACL_DB_URL: REQUIRED_DB_PROOF_COLLECTION_URL,
        REQUIRE_DB_REPAIR_PROOFS: "1",
        ...requiredDbProofFlagEnv(plan),
      },
      encoding: "utf8",
    });
    if (result.status !== 0 || !existsSync(listPath)) {
      throw new Error(`Required DB proof collection failed (exit ${result.status ?? "without a status"}): ${(result.stderr || result.stdout || "").trim()}`);
    }
    const byFile = Object.fromEntries(plan.files.map(file => [file, 0]));
    for (const entry of JSON.parse(readFileSync(listPath, "utf8"))) {
      const file = plan.files.find(candidate => resolve(ROOT, candidate) === resolve(ROOT, entry.file));
      if (!file) throw new Error(`Required DB proof collection listed a file outside the plan: ${entry.file}`);
      byFile[file] += 1;
    }
    return { total: Object.values(byFile).reduce((sum, count) => sum + count, 0), byFile };
  } finally {
    rmSync(listDir, { recursive: true, force: true });
  }
}

export function assertDisposableProofUrl(rawUrl) {
  if (!rawUrl) throw new Error("SUPABASE_DB_URL is required for DB repair proofs");
  const url = new URL(rawUrl);
  const routingOverrides = new Set(["host", "hostaddr", "port"]);
  for (const [key] of url.searchParams) {
    if (routingOverrides.has(key.toLowerCase())) {
      throw new Error("DB repair proofs reject URL host, hostaddr, and port routing overrides");
    }
  }
  // Reject every routing override before any caller constructs a pg.Client.
  // With these libpq/node-postgres overrides unavailable, the URL authority is
  // the effective destination. A Unix-domain socket cannot equal either host.
  const port = Number(url.port);
  if (!["postgres:", "postgresql:"].includes(url.protocol)
      || !["127.0.0.1", "localhost"].includes(url.hostname)
      || !Number.isInteger(port)
      || port < 55000
      || port > 59999) {
    throw new Error("DB repair proofs require the owned disposable loopback Supabase target on ports 55000-59999");
  }
  return rawUrl;
}

// The two Storage-surface proofs read {API_URL, ANON_KEY, SERVICE_ROLE_KEY} from
// PRIVATE_FILE_STORAGE_STATUS_FILE. CI exports one; a local operator running the
// documented disposable recipe has only CI_DB_WORKDIR, so one is materialized
// here from the stack this run already owns. It is written inside the run's own
// temp directory and deleted with it, and the keys are never printed. The
// API origin is re-derived from SUPABASE_DB_URL (api.port === db.port - 1, the
// offsets scripts/prepare-ci-disposable-db.mjs writes) and refused unless it is
// loopback, so a status file can never point these proofs at a shared or hosted
// Supabase.
export function assertDisposableStorageStatus(status, databaseUrl) {
  const api = new URL(String(status?.API_URL ?? ""));
  const database = new URL(databaseUrl);
  if (!["http:", "https:"].includes(api.protocol)
      || !["127.0.0.1", "localhost"].includes(api.hostname)
      || Number(api.port) !== Number(database.port) - 1) {
    throw new Error("Storage proofs require the owned disposable loopback Supabase API origin");
  }
  for (const key of ["ANON_KEY", "SERVICE_ROLE_KEY"]) {
    if (typeof status?.[key] !== "string" || status[key].length === 0) {
      throw new Error(`Disposable Supabase status is missing ${key}`);
    }
  }
  return { API_URL: status.API_URL, ANON_KEY: status.ANON_KEY, SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY };
}

function resolveStorageStatusFile(databaseUrl, reportDir) {
  const provided = (process.env.PRIVATE_FILE_STORAGE_STATUS_FILE ?? "").trim();
  if (provided) {
    assertDisposableStorageStatus(JSON.parse(readFileSync(provided, "utf8")), databaseUrl);
    return provided;
  }
  const workdir = (process.env.CI_DB_WORKDIR ?? "").trim();
  if (!workdir) {
    throw new Error("PRIVATE_FILE_STORAGE_STATUS_FILE or CI_DB_WORKDIR is required for the Storage boundary proofs");
  }
  const status = spawnSync(resolve(ROOT, "node_modules/.bin/supabase"), [
    "--workdir", workdir, "status", "-o", "json",
  ], { cwd: ROOT, encoding: "utf8" });
  if (status.status !== 0) {
    // stdout can carry the keys; only the diagnostic stream is surfaced.
    throw new Error(`supabase status failed for the disposable stack: ${(status.stderr || "").trim()}`);
  }
  const path = join(reportDir, "private-file-storage-status.json");
  writeFileSync(path, JSON.stringify(assertDisposableStorageStatus(JSON.parse(status.stdout), databaseUrl)), { mode: 0o600 });
  return path;
}

export function assessRequiredDbProofReport(report, floor = REQUIRED_DB_PROOF_FLOOR) {
  const total = Number(report?.numTotalTests ?? 0);
  const passed = Number(report?.numPassedTests ?? 0);
  const failed = Number(report?.numFailedTests ?? 0);
  const pending = Number(report?.numPendingTests ?? 0) + Number(report?.numTodoTests ?? 0);
  // `floor` is REQUIRED_DB_PROOF_FLOOR (or a phase's share of it); every
  // planned file must also collect at least one case, which
  // tests/required-db-proof-runner.test.js checks by collection.
  if (total < floor) throw new Error(`Expected at least ${floor} required DB proofs, observed ${total}`);
  if (pending > 0) throw new Error(`Required DB proof run contained ${pending} skipped or pending test(s)`);
  if (failed > 0 || passed !== total) {
    throw new Error(`Required DB proof run failed: ${passed}/${total} passed, ${failed} failed`);
  }
  return { passed, total };
}

export function requiredDbProofVitestArgs(reportPath, files = PROOF_FILES) {
  return [
    "run",
    ...files,
    // These files share one disposable schema and several intentionally hold
    // transactions open. Serialize the outer files; individual proofs still
    // create their own concurrent database clients where concurrency matters.
    "--pool=threads",
    "--maxWorkers=1",
    "--reporter=./scripts/lib/required-db-proof-json-reporter.mjs",
    `--outputFile=${reportPath}`,
  ];
}

// Print diagnostics before runRequiredDbProofPhases throws for the process
// status and main deletes the raw JSON. An absent or broken report must not
// replace that status with a parsing error.
export function readRequiredDbProofPhaseReport(reportPath, status, phaseName, write = line => process.stderr.write(line)) {
  let report = null;
  let problem = "missing";
  try {
    if (existsSync(reportPath)) {
      report = JSON.parse(readFileSync(reportPath, "utf8"));
      problem = "malformed structure";
    }
  } catch (error) {
    if (status === 0) throw error;
    problem = error instanceof SyntaxError ? "malformed JSON" : `unreadable (${error.code ?? "read error"})`;
  }
  if (status === 0) return report;

  const prefix = `DB PROOF (${phaseName})`;
  if (!report || typeof report !== "object" || !Array.isArray(report.testResults)) {
    write(`${prefix}: ${problem} phase JSON report at ${reportPath}\n`);
    write(`${prefix} TOTALS: unavailable\n`);
    return null;
  }
  const oneLine = value => typeof value === "string" ? stripVTControlCharacters(value).trim().replace(/[\r\n]+/g, " ") : "";
  const firstError = messages => messages.filter(value => typeof value === "string")
    .map(value => stripVTControlCharacters(value).trim().split(/\r\n?|\n/)[0]).find(Boolean) || "No error message reported";
  const failures = assertion => Array.isArray(assertion?.failureMessages) ? assertion.failureMessages : [];
  const duration = value => Number.isFinite(value) && value >= 0 ? `${value} ms` : "unknown";
  for (const suite of report.testResults) {
    const assertions = Array.isArray(suite?.assertionResults) ? suite.assertionResults : [];
    const failed = assertions.filter(assertion => assertion?.status === "failed");
    const suiteErrors = Array.isArray(suite?.suiteErrors) ? suite.suiteErrors : [];
    if (suite?.status !== "failed" && !failed.length && !suiteErrors.length && !(suite?.status !== "passed" && suite?.message)) continue;
    const file = oneLine(suite?.name) || "(unknown file)";
    const elapsed = Number.isFinite(suite?.startTime) && Number.isFinite(suite?.endTime) ? suite.endTime - suite.startTime : undefined;
    const suiteError = firstError([suite?.message, ...suiteErrors.map(error => error.message), ...failed.flatMap(failures)]);
    write(`${prefix} FAIL FILE: ${file} | ${suiteError} | duration: ${duration(elapsed)}\n`);
    for (const error of suiteErrors) {
      write(`${prefix} FAIL HOOK: ${file} | ${oneLine(error.suite)} | ${oneLine(error.hook)} | ${firstError([error.message])}\n`);
    }
    for (const assertion of failed) {
      const ancestors = Array.isArray(assertion.ancestorTitles) ? assertion.ancestorTitles : [];
      const name = oneLine(assertion.fullName) || [...ancestors, assertion.title].map(oneLine).filter(Boolean).join(" ") || "(unnamed test)";
      const error = firstError([...failures(assertion), suite?.message]);
      write(`${prefix} FAIL TEST: ${file} | ${name} | ${error} | duration: ${duration(assertion.duration)}\n`);
    }
  }
  const count = key => Number.isSafeInteger(report[key]) && report[key] >= 0 ? report[key] : "unknown";
  write(`${prefix} TOTALS: ${count("numTotalTests")} total, ${count("numPassedTests")} passed, ${count("numFailedTests")} failed, ${count("numPendingTests")} pending, ${count("numTodoTests")} todo\n`);
  return report;
}

// Bootstrap refuses once any organization exists. The retirement-window
// verifier scans global case/form documents, so its empty Storage fixture
// also requires a pristine stack. Run these before any suite commits fixtures;
// each restores its state and leaves the stack pristine.
// Vitest serializes files but sorts them by its own sequencer; placing a
// filename first in its arguments is insufficient.
// The retained seed-removal probes also require empty Storage. Their real
// environment guard must run before the upload pipeline commits file fixtures.
export const PRISTINE_DB_PROOFS = [
  "tests/connected-automation-v2-db.test.js",
  "tests/case-dashboard-aggregates-db.test.js",
  "tests/physical-db-baseline-retirement-window-db.test.js",
];
// One bootstrap case, six dashboard cases and one retirement-window case.
export const PRISTINE_DB_PROOF_FLOOR = 8;

// CI time audit of November 10, 2026: the full plan ran about 23
// minutes on one worker, because the files share one schema. ci.yml can run a
// whole plan as a matrix of DB_PROOF_SHARDS_FOR_WHOLE_PLAN jobs, each on its
// own disposable stacks (scripts/db-proof-shard-count.mjs, read from the
// trusted base, decides when), and names the job's place in
// REQUIRED_DB_PROOF_SHARD and REQUIRED_DB_PROOF_SHARDS.
// Without them (a local run, a related pull-request plan or an older workflow
// revision) the whole plan runs in this one process exactly as before.
export const DB_PROOF_SHARDS_FOR_WHOLE_PLAN = 4;
export const DB_PROOF_SHARD_LIMIT = 8;

// Shard zero always owns the pristine proofs, which need a stack no other file
// has touched, and the scanner pipeline proof, whose artifact only that job
// uploads; it also runs the assurance steps after the proofs.
// OPS-UG-DB-PROOF-SHARD-STABLE-PLACEMENT-20261113 (G109 of the November
// 13, 2026 audit follow-through): every other file's shard depends on that
// file alone, so adding, removing or reweighing one proof moves no other
// proof and cannot bring back a hidden cross-proof dependency like 's
// between files that never shared a job. A weighted file takes its home shard
// below (on fewer shards, home h is shard 1 + (h - 1) mod (count - 1)); every
// other file takes the shard the first 32 bits of the SHA-256 of its path name,
// modulo the shard count. Weights are seconds: the files below took 35 to
// 285 s each in merge group run 42809292286 (November 10, 2026), every other
// file a median 0.3 s and a mean 3.8 s, and the homes spread them over shards
// one to three. A stale entry only unbalances the shards; it never drops or
// repeats a file, and tests/required-db-proof-runner.test.js fails when a
// weighted file leaves the plan or has no home.
export const DB_PROOF_SHARD_WEIGHT_SECONDS = Object.freeze({
  "tests/account-lifecycle-trigger-inventory-db.test.js": 285,
  "tests/pre-bot-seed-removal-db.test.js": 137,
  "tests/account-lifecycle-manifest-db.test.js": 64,
  "tests/conflict-refusal-http-db.test.js": 40,
  "tests/organization-structure-import-db.test.js": 39,
  "tests/production-residue-seed-lanes-db.test.js": 37,
});
export const DB_PROOF_DEFAULT_WEIGHT_SECONDS = 3;
// Home shards on DB_PROOF_SHARDS_FOR_WHOLE_PLAN jobs: about 285, 289 and 278
// weighted seconds on shards one, two and three, beside shard zero's pristine
// phase and assurance steps.
export const DB_PROOF_HOME_SHARDS = Object.freeze({
  "tests/account-lifecycle-trigger-inventory-db.test.js": 1,
  "tests/organization-structure-import-db.test.js": 2,
  "tests/pre-bot-seed-removal-db.test.js": 3,
  "tests/account-lifecycle-manifest-db.test.js": 2,
  "tests/conflict-refusal-http-db.test.js": 3,
  "tests/production-residue-seed-lanes-db.test.js": 3,
});

export function requiredDbProofShard(env = process.env) {
  const rawIndex = (env.REQUIRED_DB_PROOF_SHARD ?? "").trim();
  const rawCount = (env.REQUIRED_DB_PROOF_SHARDS ?? "").trim();
  if (!rawIndex && !rawCount) return { index: 0, count: 1 };
  const index = /^\d+$/.test(rawIndex) ? Number(rawIndex) : NaN;
  const count = /^\d+$/.test(rawCount) ? Number(rawCount) : NaN;
  if (!(count >= 1 && count <= DB_PROOF_SHARD_LIMIT && index >= 0 && index < count)) {
    throw new Error(`REQUIRED_DB_PROOF_SHARD=${rawIndex || "(unset)"} and REQUIRED_DB_PROOF_SHARDS=${rawCount || "(unset)"} must name shard 0 to N-1 of N, with N from 1 to ${DB_PROOF_SHARD_LIMIT}`);
  }
  return { index, count };
}

// The shard one file takes among `count`, from the file alone.
export function dbProofShardOf(file, count) {
  if (count === 1 || PRISTINE_DB_PROOFS.includes(file) || file === PIPELINE_PROOF_FILE) return 0;
  const home = DB_PROOF_HOME_SHARDS[file];
  if (home !== undefined) return 1 + ((home - 1) % (count - 1));
  return createHash("sha256").update(file).digest().readUInt32BE(0) % count;
}

// Deterministic and stable: every file lands in exactly one shard, chosen by
// that file alone, and each shard keeps the plan's order.
export function partitionDbProofFiles(files, count) {
  return Array.from({ length: count }, (_, shard) => files.filter((file) => dbProofShardOf(file, count) === shard));
}

// The scope job sizes the matrix before any stack starts. Merge groups and
// pushes always plan every proof; a pull request does only when its change
// needs the whole plan (relatedDbProofPlan), and a related plan of a few files
// keeps one job rather than paying for four pairs of stacks.
export function dbProofShardCount(event, changed) {
  return event !== DB_PROOF_RELATED_EVENT || dbProofChangeNeedsWholePlan(changed) ? DB_PROOF_SHARDS_FOR_WHOLE_PLAN : 1;
}

// One shard's share of a plan. The fixed case floor is checked here against
// the whole plan's collected cases, and the shard's floor becomes the cases
// its own files collect, so the shards' executed cases sum to at least the
// fixed floor; a file that collects nothing fails every shard. plan_digest
// lets a reader confirm that every shard of a run partitioned the same plan.
export function shardDbProofPlan(plan, shard, collect = collectRequiredDbProofCases) {
  if (shard.count === 1) return plan;
  const collected = collect(plan);
  const empty = plan.files.filter((file) => !(collected.byFile[file] > 0));
  if (empty.length) throw new Error(`Required DB proof files collected no case: ${empty.join(", ")}`);
  if (collected.total < plan.floor) {
    throw new Error(`Expected at least ${plan.floor} required DB proofs across every shard, collected ${collected.total}`);
  }
  const files = partitionDbProofFiles(plan.files, shard.count)[shard.index];
  const plan_digest = createHash("sha256").update(JSON.stringify({ files: plan.files, count: shard.count })).digest("hex");
  return {
    ...plan,
    files,
    floor: files.reduce((sum, file) => sum + collected.byFile[file], 0),
    pristineCases: files.filter((file) => PRISTINE_DB_PROOFS.includes(file)).reduce((sum, file) => sum + collected.byFile[file], 0),
    shard: { index: shard.index, count: shard.count, planned_files: plan.files.length, planned_floor: plan.floor, collected_cases: collected.total, plan_digest },
  };
}

export function requiredDbProofPhases(plan) {
  const pristine = PRISTINE_DB_PROOFS.filter(file => plan.files.includes(file));
  const shared = plan.files.filter(file => !PRISTINE_DB_PROOFS.includes(file));
  // A shard's floor is its collected cases, so its pristine share is the
  // pristine files' collected cases, never less than the fixed pristine floor.
  const pristineShare = pristine.length ? plan.pristineCases ?? PRISTINE_DB_PROOF_FLOOR : 0;
  return [
    ...(pristine.length ? [{ name: "pristine-bootstrap", files: PRISTINE_DB_PROOFS, floor: Math.max(PRISTINE_DB_PROOF_FLOOR, pristineShare) }] : []),
    ...(shared.length ? [{ name: "shared-fixtures", files: shared, floor: plan.floor - pristineShare }] : []),
  ];
}

export function runRequiredDbProofPhases(plan, runPhase, observePhase = () => {}) {
  // A shard other than zero holds no pristine proof and may hold no file at
  // all; the unsharded plan and shard zero hold every pristine proof once.
  const pristineCount = pristine => plan.files.filter(file => file === pristine).length;
  if (PRISTINE_DB_PROOFS.some(pristine => pristineCount(pristine) !== (plan.shard?.index > 0 ? 0 : 1))
      || new Set(plan.files).size !== plan.files.length) {
    throw new Error("Required DB proof inventory must contain each file exactly once, including every pristine proof");
  }
  const phases = requiredDbProofPhases(plan);
  if (!plan.shard && phases.length !== 2) throw new Error("The unsharded required DB proof plan has no shared-fixture proof");
  const aggregate = { numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 };
  for (const phase of phases) {
    let result;
    let accepted = false;
    try {
      result = runPhase(phase);
      const { status, report } = result;
      if (status !== 0) throw new Error(`Required DB proof test process exited ${status ?? "without a status"} (${phase.name})`);
      assessRequiredDbProofReport(report, phase.floor);
      const expected = phase.files.map(file => resolve(ROOT, file)).sort();
      const observed = (report?.testResults ?? []).map(result => resolve(ROOT, result.name)).sort();
      if (JSON.stringify(observed) !== JSON.stringify(expected)) {
        throw new Error(`Required DB proof file inventory mismatch (${phase.name})`);
      }
      for (const key of Object.keys(aggregate)) aggregate[key] += Number(report[key] ?? 0);
      accepted = true;
    } finally {
      // Observe even a nonzero process, missing/malformed report or failed
      // inventory check before the caller deletes private phase JSON files.
      observePhase({ phase, result, accepted });
    }
  }
  return assessRequiredDbProofReport(aggregate, plan.floor);
}

function main() {
  const reportDir = mkdtempSync(join(tmpdir(), "required-db-proofs-"));
  const artifactDir = process.env.DB_ASSURANCE_ARTIFACT_DIR
    || (process.env.RUNNER_TEMP ? join(process.env.RUNNER_TEMP, "database-assurance") : `${reportDir}-sanitized`);
  let outcome;
  let passed = false;
  try {
    outcome = createRequiredDbProofOutcome({ artifactDir, root: ROOT });
    if (process.env.REQUIRE_DB_REPAIR_PROOFS !== "1") {
      throw new Error("REQUIRE_DB_REPAIR_PROOFS=1 is required; this command may not silently become an optional lane");
    }
    const scope = requiredDbProofScope(process.env);
    const fullPlan = requiredDbProofPlan(process.env);
    const shard = requiredDbProofShard(process.env);
    const selectedPlan = scope.mode === "related"
      ? relatedDbProofPlan(fullPlan, changedPathsForDbProofs(scope.base, scope.head))
      : fullPlan;
    const plan = shardDbProofPlan(selectedPlan, shard);
    if (plan.shard) {
      const line = `SHARD ${plan.shard.index} of 0-${plan.shard.count - 1}: ${plan.files.length} of ${plan.shard.planned_files} planned required DB proof files, ${plan.floor} of ${plan.shard.collected_cases} collected cases (fixed floor ${plan.shard.planned_floor} checked on the whole plan); plan digest ${plan.shard.plan_digest}.`;
      process.stdout.write(`${line}\n${plan.files.map((file) => `  ${file}\n`).join("")}`);
      if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `### Required DB proofs\n${line}\n`, { flag: "a" });
    }
    if (plan.scope === "related") {
      const line = `RELATED: ${plan.files.length} of ${fullPlan.files.length} required DB proof files for ${plan.changed} changed paths (pull_request); the merge group runs every proof.`;
      process.stdout.write(`${line}\n${plan.files.map((file) => `  ${file}\n`).join("")}`);
      if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `### Required DB proofs\n${line}\n`, { flag: "a" });
    } else if (plan.scope === "full") {
      process.stdout.write(`FULL: ${plan.files.length} required DB proof files; ${plan.changed} changed paths touch the proof setup or exceed ${DB_PROOF_WHOLE_PLAN_PATH_LIMIT}.\n`);
    }
    outcome.plan(plan, requiredDbProofPhases(plan).map((phase) => phase.name));
    if (plan.deferred.length) {
      process.stdout.write(`DEFERRED: ${plan.deferred.join(", ")} — the real four-kind ClamAV pipeline proof needs the scanner lane (PRIVATE_FILE_PIPELINE_SCANNER_DIR, PRIVATE_FILE_PIPELINE_CLAMD_PORT) that this workflow revision does not provision; it is required (PRIVATE_FILE_SCANNER_PROOF_REQUIRED=1) on the first Main run after this change merges.\n`);
    }
    const databaseUrl = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    const storageStatusFile = resolveStorageStatusFile(databaseUrl, reportDir);
    const summary = runRequiredDbProofPhases(plan, (phase) => {
      const reportPath = join(reportDir, `${phase.name}.json`);
      const result = spawnSync(process.execPath, [
        resolve(ROOT, "node_modules/vitest/vitest.mjs"),
        ...requiredDbProofVitestArgs(reportPath, phase.files),
      ], {
        cwd: ROOT,
        env: {
          ...process.env,
          SUPABASE_DB_URL: databaseUrl,
          EXPECTED_ORG_GUARD_DB_URL: databaseUrl,
          CASEWORK_RLS_ACL_DB_URL: databaseUrl,
          ...requiredDbProofFlagEnv(plan),
          PRIVATE_FILE_STORAGE_STATUS_FILE: storageStatusFile,
          // The pipeline proof commits synthetic feature/audit fixtures that only
          // the owned disposable stack's destruction clears. Declaring the duty
          // here is what makes the proof required rather than opt-in.
          PRIVATE_FILE_PIPELINE_DISPOSABLE_CONFIRM: "reset-after-proof",
        },
        encoding: "utf8",
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      const report = readRequiredDbProofPhaseReport(reportPath, result.status, phase.name);
      return { status: result.status, report };
    }, observation => outcome.phase(observation));
    passed = true;
    process.stdout.write(`PASS: ${summary.passed}/${summary.total} required disposable DB proofs ran; none skipped.${plan.deferred.length ? ` DEFERRED (not counted): ${plan.deferred.join(", ")} — scanner lane not provisioned by this workflow revision; required on the first Main run after this change merges.` : ""}\n`);
  } finally {
    try {
      outcome?.finish(passed);
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
