// @vitest-environment node
// BUG-UG-MEMBER-SUPPORT-RPCS-REQUIRE-HOME-CHAPTER-FOR-CHAPTERLESS-STAFF-20260921.
//
// tests/member-support-db.test.js proves the behaviour against a live database,
// but that suite is gated behind RUN_LOCAL_DB_TESTS, so these static pins are
// what keeps the repair from silently regressing in the ordinary lane.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./helpers/migration.js";

const root = resolve(import.meta.dirname, "..");
const migrationDir = resolve(root, "supabase/migrations");
const migrationName = "20260924200000_member_support_chapterless_org_resolution.sql";
const migration = readFileSync(resolve(migrationDir, migrationName), "utf8");
const contract = JSON.parse(readFileSync(resolve(root, "scripts/db-contract.json"), "utf8"));

const everyMigration = readdirSync(migrationDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(resolve(migrationDir, name), "utf8"))
  .join("\n");

// The fifteen member-support RPCs the record names, in the order the original
// migration declares them.
const MEMBER_SUPPORT_RPCS = [
  "get_member_support_workspace",
  "save_member_emergency_checklist",
  "alert_member_emergency_steward",
  "resolve_member_emergency_checklist",
  "create_member_accommodation_request",
  "transition_member_accommodation_request",
  "record_member_hr_contact",
  "save_organization_hr_directory",
  "save_organization_onboarding_step",
  "start_member_onboarding_plan",
  "complete_member_onboarding_step",
  "create_member_mentorship_pair",
  "transition_member_mentorship_pair",
  "add_member_mentorship_note",
  "save_member_mentorship_goal",
];

function latestBody(qualifiedName) {
  const declaration = new RegExp(`create(?: or replace)? function ${qualifiedName.replace(".", "\\.")}\\(`, "gi");
  const matches = [...everyMigration.matchAll(declaration)];
  expect(matches.length, `${qualifiedName} must be defined`).toBeGreaterThan(0);
  const start = matches.at(-1).index;
  const end = everyMigration.indexOf("$function$;", start);
  expect(end, `${qualifiedName} must have a complete SQL body`).toBeGreaterThan(start);
  return stripComments(everyMigration.slice(start, end)).replace(/\s+/g, " ");
}

describe("member support resolves a chapterless single-organization staff session", () => {
  it("routes every member-support RPC through the widened organization gate", () => {
    for (const rpc of MEMBER_SUPPORT_RPCS) {
      const body = latestBody(`public.${rpc}`);
      expect(body, `${rpc} must resolve the organization through the member-support gate`)
        .toContain("private.member_support_selected_organization()");
      expect(body, `${rpc} must no longer require a home chapter`)
        .not.toContain("private.mi1_require_selected_organization()");
    }
  });

  it("keeps the gate's authentication and MFA vocabulary while delegating to the w2 resolver", () => {
    const gate = latestBody("private.member_support_selected_organization");
    expect(gate).toContain("private.mfa_satisfied()");
    expect(gate).toContain("'mfa required'");
    expect(gate).toContain("'authentication required'");
    // Zero or MORE THAN ONE active organization resolves null there and raises,
    // so a multi-organization caller stays fail-closed.
    expect(gate).toContain("private.mi1_w2_selected_organization()");
    expect(migration).toContain("revoke all on function private.member_support_selected_organization()");
  });

  it("widens the event guard every member-support write passes through", () => {
    const guard = latestBody("private.member_support_record_event");
    expect(guard).toContain("private.member_support_selected_organization()");
    expect(guard).not.toContain("private.current_member_organization()");
    expect(guard).toContain("'organization is derived from the session'");
  });

  it("refuses a handoff with an explicit chapter-required message instead of a generic refusal", () => {
    const handoff = latestBody("public.initiate_member_handoff");
    expect(handoff).toContain("Select a chapter before transferring responsibility for a member.");
    // The foreign-chapter branch keeps its opaque refusal.
    expect(handoff).toContain("private.mi1_w2_same_org_chapter(org, chapter)");
    expect(handoff).toContain("'not authorized'");
  });

  it("emits one organization-level selected membership row for chapterless single-organization staff", () => {
    const memberships = latestBody("public.get_my_chapter_memberships");
    expect(memberships).toContain("'chapterId', null");
    expect(memberships).toContain("'selected', true");
    expect(memberships).toContain("from public.organization_memberships om");
    // The fallback is reachable only with no active chapter membership at all.
    expect(memberships).toContain("from public.member_chapter_memberships cm where cm.user_id = om.user_id and cm.status = 'active'");
    // ... and only for exactly one active organization.
    expect(memberships).toContain("join public.organizations peer_org on peer_org.id = peer.organization_id and peer_org.status = 'active'");
    expect(memberships).toContain(") = 1");
  });

  it("re-reviews every definer the account-lifecycle surface reaches", () => {
    for (const object of [
      "member_support_selected_organization()",
      "mi1_w2_selected_organization()",
      "member_support_record_event(",
      "create_member_accommodation_request(",
      "transition_member_accommodation_request(",
    ]) {
      expect(migration, `${object} must carry a reviewed definition hash`).toContain(object);
    }
    expect(migration).toContain("insert into private.account_lifecycle_trigger_review");
    expect(migration).toContain("private.account_lifecycle_referential_action_trigger_issues()");
  });

  it("re-applies the case-graph transaction entry a create-or-replace would have dropped", () => {
    // 20260907151000 wraps every case-graph writer so private.lock_case_graph
    // runs before the function's own declarations evaluate. Re-creating those
    // bodies drops the wrapper, so this migration has to put it back.
    expect(migration).toContain("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);");
    expect(migration).toContain("member support case graph writer source changed");
    for (const rpc of MEMBER_SUPPORT_RPCS.filter((name) => name !== "get_member_support_workspace")) {
      expect(migration, `${rpc} must be re-wrapped`).toMatch(new RegExp(`\\('public\\.${rpc}\\([^)]*\\)', '[a-f0-9]{64}'\\)`));
    }
    expect(migration).toMatch(/\('public\.initiate_member_handoff\([^)]*\)', '[a-f0-9]{64}'\)/);
    expect(migration).toMatch(/\('private\.member_support_record_event\([^)]*\)', '[a-f0-9]{64}'\)/);
  });

  it("keeps the database contract in lockstep with the widened gate", () => {
    const gate = contract.functions.find((entry) => entry.sig === "private.member_support_selected_organization()");
    expect(gate, "the new gate needs a contract entry").toBeTruthy();
    expect(gate.exec, "the gate must not be directly executable").toBe("");
    expect(contract.mfaCoverage.guardedDelegates["private.member_support_selected_organization()"],
      "the gate must carry the MFA coverage the RPCs now inherit from it").toBeTruthy();
    for (const rpc of MEMBER_SUPPORT_RPCS) {
      const entry = contract.functions.find((candidate) => candidate.sig.startsWith(`public.${rpc}(`));
      expect(entry, `${rpc} contract entry`).toBeTruthy();
      expect(entry.bodyContains, `${rpc} contract body pin`).toContain("private.member_support_selected_organization()");
    }
  });
});
