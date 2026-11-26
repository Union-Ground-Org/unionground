// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stripComments } from "./helpers/migration.js";

const migration = stripComments(readFileSync(new URL(
  "../supabase/migrations/20260813170000_post_integration_service_health.sql",
  import.meta.url,
), "utf8")).replace(/\s+/g, " ").toLowerCase();
const searchMigration = stripComments(readFileSync(new URL(
  "../supabase/migrations/20260904223603_compass_private_source_minimization.sql",
  import.meta.url,
), "utf8")).replace(/\s+/g, " ").toLowerCase();
const verifier = readFileSync(new URL("../scripts/verify-db-contract.mjs", import.meta.url), "utf8");
const rpcVerifier = readFileSync(new URL("../scripts/verify-rpc-behaviour.mjs", import.meta.url), "utf8");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("post-integration service health reconciliation", () => {
  it("removes unintended service-role reachability from browser-only boundaries", () => {
    for (const signature of [
      "public.create_admin_chapter(text, text, text, integer)",
      "public.create_member_invitation(text, text, text, text, text, text)",
      "public.get_steward_workload_intelligence(integer)",
      "public.get_admin_governance_requests()",
    ]) {
      expect(migration).toContain(`revoke execute on function ${signature} from service_role`);
    }
    for (const table of ["member_invitations", "member_invitation_audit"]) {
      expect(migration).toContain(`revoke all on table public.${table} from service_role`);
    }
  });

  it("reinstalls the uniform restrictive MFA policy on every late RLS table", () => {
    for (const table of [
      "member_report_preferences",
      "member_case_assignment_audit",
      "member_weekly_questions",
      "member_weekly_question_supports",
      "member_peer_contact_keys",
      "member_peer_contact_requests",
      "member_peer_conversations",
      "member_peer_messages",
      "member_experimental_content",
    ]) expect(migration).toContain(`'${table}'`);
    expect(migration).toContain("as restrictive for all to authenticated");
    expect(migration).toContain("using ((select private.mfa_satisfied()))");
    expect(migration).toContain("with check ((select private.mfa_satisfied()))");
  });

  it("accepts only resolved MFA delegates with exact execution scopes", () => {
    expect(Object.keys(contract.mfaCoverage.directGuards)).toEqual([
      "public.generate_mfa_recovery_codes()",
      "public.authorize_member_account_deletion(p_confirmation text)",
    ]);
    expect(contract.mfaCoverage.termNeedles).not.toContain("auth.mfa_amr_claims");
    // The chapter-records context (REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030) is the 28th
    // and the chapter seniority staff gate (REQ-UG-STEWARD-SENIORITY-LIST-AND-BID-TRACKER-20261030) the 29th;
    // the chapter-finance context (REQ-UG-TREASURER-ROLE-SCOPED-TO-FINANCIAL-DUTIES-20261031) is the 30th;
    // the release-calendar caller check (REQ-UG-RELEASE-DATE-CONTROL-WITHOUT-MIGRATION-20261112) is the 31st;
    // the reward-economy reader gate (SEC-UG-REWARD-ECONOMY-EDITABLE-ACROSS-ORGANIZATIONS-20261111, #8307),
    // split from the now platform-operator-only write gate, is the 32nd.
    expect(Object.keys(contract.mfaCoverage.guardedDelegates)).toHaveLength(32);
    expect(contract.mfaCoverage.guardedDelegates).toHaveProperty("private.platform_setting_release_caller(p_actor text)");
    expect(contract.mfaCoverage.guardedDelegates).toHaveProperty("private.assert_reward_economy_reader()");
    expect(contract.mfaCoverage.guardedDelegates).toHaveProperty("private.chapter_finance_context(p_org uuid, p_chapter text)");
    expect(contract.mfaCoverage.guardedDelegates).toHaveProperty(
      "private.seniority_staff_can_manage(p_chapter text)",
      "Non-executable chapter seniority and bid staff gate (REQ-UG-STEWARD-SENIORITY-LIST-AND-BID-TRACKER-20261030) performs the direct MFA check, then requires a steward or coordinator role on the chapter or organization-wide in its organization before any seniority or bid read or write.",
    );
    expect(contract.mfaCoverage.guardedDelegates).toHaveProperty(
      "private.institutional_context(p_require_staff boolean)",
    );
    expect(contract.mfaCoverage.guardedDelegates).toHaveProperty(
      "private.platform_announcement_context(p_platform boolean, p_admin boolean, p_containment boolean)",
      "Non-executable selected-tenant gate requires MFA and live membership; publisher context additionally requires a verified factor, live AAL2 session, active dedicated grant, and no recovery/reset/account ban.",
    );
    expect(contract.mfaCoverage.guardedDelegates).toHaveProperty(
      "private.compass_platform_operator()",
      "Non-executable platform AI helper requires current MFA, a live AAL2 session, verified factor and explicit active platform authority; it confers no tenant data access.",
    );
    expect(contract.mfaCoverage.guardedDelegates).toHaveProperty(
      "private.casework_procedure_actor(p_write boolean)",
    );
    expect(contract.mfaCoverage.guardedDelegates).toHaveProperty(
      "private.dues_require_financial_hat(p_selected_hat text)",
    );
    expect(contract.mfaCoverage.guardedDelegates).toHaveProperty(
      "private.require_member_operations_admin()",
      "Non-executable member-operations gate performs direct MFA, derives the selected organization, and requires its current Admin role before any member-administration, welcome, or import RPC reads or writes.",
    );
    expect(contract.mfaCoverage.guardedDelegates).toHaveProperty(
      "private.casework_require_mfa()",
      "Non-executable casework assurance gate performs the direct MFA check before any authenticated casework definer RPC bypasses RLS.",
    );
    expect(contract.mfaCoverage.guardedDelegates).toHaveProperty(
      "private.cr108_require_operator()",
      "Non-executable CR-108 guard performs direct MFA, active selected-organization derivation, and current Admin/VP role checks before any automation read or mutation.",
    );
    expect(contract.mfaCoverage.guardedDelegates).toHaveProperty(
      "private.automation_v3_require_author()",
      "Non-executable shared automation guard delegates to the selected-organization MFA gate and then requires an active Steward, Coordinator, Advisor, Admin, or President role before authoring reads or mutations.",
    );
    expect(contract.mfaCoverage.guardedDelegates).toHaveProperty(
      "private.automation_v3_require_approver()",
      "Non-executable shared automation approval guard first applies the author MFA gate, then requires a current organization-wide Admin or President grant before review, activation, or execution.",
    );
    expect(contract.mfaCoverage.guardedDelegates).toHaveProperty(
      "private.require_administrative_evidence_staff()",
      "Non-executable administrative-evidence guard performs direct MFA, active selected-organization derivation, and current Admin-role checks before any Field Notes or Action Lab read or mutation.",
    );
    expect(contract.mfaCoverage.guardedDelegates).toHaveProperty(
      "private.dues_require_financial_hat(p_selected_hat text)",
      "Non-executable Dues gate performs a direct MFA check, derives the active organization, and requires the matching server-assigned Admin or VP financial identity before a financial read or mutation proceeds.",
    );
    // 20261030203101: the staff-only event draft gate, not executable by any
    // API role (REQ-UG-EVENTS-RSVP-CHECK-IN-AND-VISIBILITY-20261030).
    expect(contract.mfaCoverage.guardedDelegates).toHaveProperty(
      "private.member_event_draft_chapter()",
      "Non-executable staff-only event draft gate (REQ-UG-EVENTS-RSVP-CHECK-IN-AND-VISIBILITY-20261030): checks private.mfa_satisfied() and the event-writer role before list_member_event_drafts, save_member_event_draft and delete_member_event_draft read or write.",
    );
    expect(contract.mfaCoverage.executableGuardedDelegates).toEqual({
      "private.can_read_member_broadcast(p_broadcast_id text)": {
        roles: ["authenticated"],
        reason: "Authenticated RLS and receipt policies require this broadcast visibility predicate; it forces MFA and hides ownerless legacy rows.",
      },
      "private.has_organization_role(p_organization_id uuid, p_roles text[])": {
        roles: ["authenticated"],
        reason: "Authenticated RLS policies require this organization-hat predicate; it forces MFA and the staff enrolment rule after proving an active membership and grant.",
      },
      "private.is_organization_member(p_organization_id uuid)": {
        roles: ["authenticated"],
        reason: "Authenticated RLS policies require this membership predicate; it forces MFA and rejects a null organization wildcard.",
      },
      "private.member_has_chapter_role(p_chapter_id text, p_roles text[])": {
        roles: ["authenticated"],
        reason: "Authenticated RLS policies require this selected-chapter predicate; it enforces MFA, active tenant/chapter membership, and either an explicit tenant role or exact chapter mapping without admitting a foreign organization.",
      },
      "private.member_has_chapter_staff_grant(p_chapter_id text, p_roles text[])": {
        roles: ["authenticated"],
        reason: "#7665 (20261109060229): the same chapter role test as private.member_has_chapter_role, also admitting a unit or in-date committee scope; it calls private.mfa_satisfied() first, and authenticated RLS policies execute it.",
      },
    });
    expect(verifier).toContain("MFA direct guard ${sig} contains ${needle}");
    expect(verifier).toContain("MFA guard delegate ${sig} resolves");
    expect(verifier).toContain("contains a direct assurance proof");
    expect(verifier).toContain("is not directly executable by API roles");
    expect(verifier).toContain("MFA executable guard delegate ${sig} has exact API-role EXECUTE");
  });

  it("creates active synthetic ballots with the required open campaign state", () => {
    expect(rpcVerifier).toContain("active, campaign_state, order_index");
    expect(rpcVerifier).toContain("true, 'open', 990101");
    expect(rpcVerifier).toContain("true, 'open', 990102");
    expect(rpcVerifier).toContain("active, campaign_state, order_index");
    expect(rpcVerifier).toContain("now() + interval '1 day', true, 'open', $1");
    expect(rpcVerifier).toContain("async function addProbeTotp(userId, label)");
    expect(rpcVerifier).toContain("await addProbeTotp(taskActor.user_id, \"task\")");
    expect(rpcVerifier).toContain("await addProbeTotp(libraryStaff.id, \"library\")");
    expect(rpcVerifier).toContain("await addProbeTotp(foreignStaff, \"workload-foreign\")");
  });

  it("bounds Compass ranking with indexable caller and chapter predicates", () => {
    expect(searchMigration).toContain("d.chapter_id = private.current_member_chapter()");
    expect(searchMigration).not.toContain("from public.member_cases");
    expect(searchMigration).toContain("security invoker");
    const entry = contract.functions.find((candidate) => candidate.sig === "public.search_member_kb(p_query text, p_limit integer)");
    expect(entry.bodyContains).toContain("d.chapter_id = private.current_member_chapter()");
    expect(entry.bodyContains).not.toContain("c.user_id = (select auth.uid())");
    expect(entry.bodyForbids).toContain("from public.member_cases");
  });
});
