// @vitest-environment node
// BUG-UG-ACCOUNT-LIFECYCLE-REGRESSION-20260831 is an explicit recurrence of
// closed UB-HUB-02, whose fix enumerated a fixed table list and then silently
// fell out of date as later product domains added auth.users references. A
// locally-runnable proof script would repeat that shape: it only fails when
// somebody remembers to run it. These two cases promote the schema-wide
// invariants into the required disposable-DB proof set, so the FIRST migration
// that adds an unmanaged restrictive auth.users foreign key, or a member-owned
// cascading relation with no reviewed export disposition, fails CI.
//
// The proof bodies deliberately live in the two verifier scripts rather than
// being copied here: one source of truth, runnable by hand against the same
// disposable stack (npm run verify:account-lifecycle-manifest:local and
// npm run verify:account-deletion-finalization:local).
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { reviewedGraph, reviewedForeignKeys, deriveRelations } from "../scripts/account-case-graph-inventory.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

// The verifiers run catalogue-wide proofs, sized to the runner. The manifest
// one used to take 57 s locally, or 128 s once autovacuum had analyzed
// pg_proc (84 to 315 s on GitHub's 2-vCPU ubuntu-24.04 runner, two timeouts
// at a fixed 300 s on PR #8440): the account-lifecycle trigger-surface scan it
// runs about nine times changed plan with those statistics. Since
// 20261112231000 the scan keeps one plan, and the verifier took 45 s locally
// with pg_proc analyzed (#8458).
const VERIFIER_MS = runnerTimeout(150_000);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databaseIt = process.env.RUN_ACCOUNT_LIFECYCLE_DB_TESTS === "1" ? it : it.skip;

function assertNewProviderCapabilitiesDisabled() {
  const project = process.env.CI_DB_PROJECT_ID;
  if (!/^unionground-lab-ci-[a-f0-9]{12}$/.test(project ?? "")) throw new Error("Owned Auth proof project required");
  const inspected = spawnSync("docker", ["inspect", "--format", "{{json .Config}}", `supabase_auth_${project}`], {
    encoding: "utf8", timeout: 15000,
  });
  if (inspected.status !== 0) throw new Error("Owned Auth configuration could not be inspected");
  // Retain only the capability decision: Config.Env also contains local keys.
  const config = JSON.parse(inspected.stdout);
  if (config.Labels?.["com.supabase.cli.project"] !== project || !config.Image?.endsWith("/gotrue:v2.197.0")) {
    throw new Error("Auth capability proof requires the pinned owned GoTrue 2.197 image");
  }
  for (const key of ["GOTRUE_MFA_RECOVERY_CODES_ENROLL_ENABLED", "GOTRUE_MFA_RECOVERY_CODES_VERIFY_ENABLED", "GOTRUE_EXPERIMENTAL_SCIM_ENABLED"]) {
    const value = config.Env.find(entry => entry.startsWith(`${key}=`))?.slice(key.length + 1);
    // GoTrue 2.197 defaults these capabilities to false. Recovery verification
    // transaction locks a recovery-set row before its DML; enabling that flow
    // needs a separate admission review, rather than inheriting these DML gates.
    if (value !== undefined && value !== "false") throw new Error("New provider capabilities must remain disabled for this adoption");
  }
}

function runVerifier(script, databaseUrl) {
  const result = spawnSync(process.execPath, [resolve(ROOT, "scripts", script)], {
    cwd: ROOT,
    // Only the disposable loopback target is ever reachable from these proofs;
    // the verifiers refuse a non-loopback host on their own as well.
    env: { ...process.env, SUPABASE_DB_URL: databaseUrl, DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout || ""}${result.stderr || ""}`.trim() };
}

databaseIt("keeps newly added provider capabilities disabled until their lock admission is reviewed", () => {
  assertNewProviderCapabilitiesDisabled();
});

databaseIt("keeps the account-lifecycle manifest schema-wide: no unmanaged restrictive or unreviewed cascading auth.users reference", () => {
  const databaseUrl = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  expect(reviewedGraph.tables.length).toBeGreaterThan(0);
  expect(deriveRelations(reviewedForeignKeys.foreign_keys, reviewedGraph.seeds)).toEqual(reviewedGraph.tables);
  const { status, output } = runVerifier("verify-account-lifecycle-manifest-local.mjs", databaseUrl);
  expect(status, output).toBe(0);
  expect(output, output).toContain("PASS: zero unmanaged restrictive FKs");
  // The reviewed verified-key registry adds one account-owned graph relation;
  // the POMS removal (20261003070000) withdraws three; member_profile_details
  // (20261008100000) adds one; steward_private_reminders (20261009000500)
  // adds one more. Bot directory containment adds its ledger trigger host.
  // Platform announcements (20261029141540) add seven guarded relations.
  // Chapter units (20261030201200) add three: chapter_units,
  // organization_local_profiles and member_invitation_units; organization
  // HTML forms (20261030201500) add one; ballot nominations (20261030214501,
  // REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030) add one more;
  // the chapter seniority list, bid windows and bids (20261030224501) add three;
  // booking notes (20261030234501,
  // REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030) one more;
  // member requests (20261030235900, #6634) add public.member_requests;
  // standing handshake offers (20261101224749) add two:
  // chapter_handshake_offers and chapter_partner_invitation_requests;
  // saved chart specs (20261102001534) add one owned relation and gate;
  // #6682's unit/committee scoped access adds seven;
  // #6688's chapter financial documents and requests add two;
  // Pulse weekly snapshots (#6694) add one organization-owned gate;
  // workload category visibility and order (#6910) one more;
  // the learning period engine (#6940) adds two: the period and its journal;
  // the onboarding skip reasons (#7013) add one plan-owned gate;
  // the learning period events slice (#6944) adds five held-copy tables;
  // the learning period message slice (#6945) adds public.civic_member_messages,
  // whose sent journal takes the case-graph lock.
  expect(output, output).toContain(`PASS: installed case-graph writer closure and ${reviewedGraph.tables.length} statement gates are complete`);
  expect(output, output).toContain("PASS: implicit FK catalogue, handoff statement and recipient row-key mutations are detected");
  expect(output, output).toContain("PASS: missing indirect trigger-root statement gate is detected");
  expect(output, output).toContain("PASS: Auth bookkeeping trigger, function, column and G_A negative controls are detected");
  expect(output, output).toContain(`PASS: all ${reviewedGraph.tables.length} catalogue relation entries serialize with Auth deletion in both orders`);
  expect(output, output).toContain("PASS: concurrent committed grant revocation denies retained history");
  expect(output, output).toContain("PASS: mid-grant revocation and deletion serialize without 40P01");
  for (const writer of ['addendum', 'withdrawal', 'revokingStaff', 'handoff', 'survey']) {
    for (const order of ['writer-first', 'deletion-first']) {
      expect(output, output).toContain(`PASS: case-graph ${writer} ${order} serializes with fresh authorization`);
    }
  }
  for (const order of ["owner-first", "staff-first"]) {
    expect(output, output).toContain(`PASS: overlapping ${order} deletion clears retained inputs and denies re-provisioned JWT`);
  }
}, VERIFIER_MS);

databaseIt("keeps irreversible account deletion durably reconcilable after a failed finalizer", () => {
  const databaseUrl = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  const { status, output } = runVerifier("verify-account-deletion-finalization-local.mjs", databaseUrl);
  expect(status, output).toBe(0);
  expect(output, output).toContain("PASS: simultaneous marker/finalizer failures leave a durable processing record");
  expect(output, output).toContain("PASS: concurrent actual-key rotation never completes a live identity");
}, VERIFIER_MS);
