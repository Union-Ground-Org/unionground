// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fnBody, migrationFiles, stripComments } from "./helpers/migration.js";

const root = resolve(import.meta.dirname, "..");
const migration = (name) => readFileSync(resolve(root, `supabase/migrations/${name}.sql`), "utf8");
const compact = (source) => stripComments(source).replace(/\s+/g, " ").toLowerCase();

// 20260822010000 redefines switch_my_chapter and handle_new_member, and
// 20260826158000 redefines member_has_role again, so the pins read the last
// migration that defines each function (comments stripped first).
const definingMigrations = (schema, name) => migrationFiles().filter((entry) =>
  new RegExp(String.raw`create\s+(?:or\s+replace\s+)?function\s+"?${schema}"?\.\s*"?${name}"?\s*\(`, "i")
    .test(stripComments(entry.sql)));

const liveDefinition = (schema, name) => {
  const defined = definingMigrations(schema, name);
  if (defined.length === 0) throw new Error(`no migration defines ${schema}.${name}`);
  return defined[defined.length - 1];
};

const liveSwitchChapter = liveDefinition("public", "switch_my_chapter");
const liveMemberHasRole = liveDefinition("public", "member_has_role");
const liveHandleNewMember = liveDefinition("private", "handle_new_member");
const invitation = migration("20260821011000_emailed_password_invitation_finalize");
const workflows = migration("20260821012000_mobile_ship_complete_workflows");
const reissue = migration("20260821013000_member_password_reissue");
const reissueAttemptLease = migration("20260901080000_member_password_reissue_attempt_lease");
const g3BoundaryRepair = migrationFiles()
  .find(({ name }) => name === "20260901201000_g3_native_member_journey_boundaries.sql")?.sql ?? "";
const dbContract = JSON.parse(readFileSync(resolve(root, "scripts/db-contract.json"), "utf8"));

describe("mobile multi-chapter identity", () => {
  it("switches only to an active membership and keeps role authorization chapter-explicit", () => {
    const switchBody = fnBody(liveSwitchChapter.sql, "public.switch_my_chapter").toLowerCase();
    const roleBody = fnBody(liveMemberHasRole.sql, "public.member_has_role").toLowerCase();
    expect(switchBody).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(switchBody).toContain("m.status = 'active'");
    expect(switchBody).toContain("set chapter_id = target.chapter_id");
    expect(roleBody).toContain("public.member_role_chapters");
    expect(roleBody).toContain("join public.chapters selected on selected.id = p.chapter_id");
    expect(roleBody).toContain("chapter_role.chapter_id = selected.id");
    expect(roleBody).not.toContain("rc.chapter_id");
    expect(roleBody).toContain("private.mfa_satisfied()");
  });

  it("creates only an empty profile and valid chapter membership for a new Auth user", () => {
    const body = compact(fnBody(liveHandleNewMember.sql, "private.handle_new_member()"));
    expect(body).toContain("insert into public.member_profiles");
    expect(body).toContain("insert into public.member_chapter_memberships");
    expect(body).toContain("values (new.id, member_chapter, 'active'");
    for (const invented of ["member_cases", "member_messages", "member_notifications", "member_rights_progress", "member_action_log"]) {
      expect(body).not.toContain(invented);
    }
  });

  it("clears chapter-scoped native context before refreshing the switched workspace", () => {
    const provider = readFileSync(resolve(root, "apps/mobile/src/state/AppProvider.tsx"), "utf8");
    const switchBlock = provider.slice(
      provider.indexOf("const switchChapter"),
      provider.indexOf("const setChapterPinned"),
    );
    // Union Ground carries no dues, so there is no dues context to clear;
    // the chapter-scoped state it does hold (live channels, the dashboard and
    // the staff scope) must all be dropped before the switched workspace loads.
    expect(switchBlock).not.toContain("setDuesContext");
    const refresh = switchBlock.indexOf("await fetchDashboard(session)");
    expect(refresh).toBeGreaterThan(-1);
    for (const reset of ["liveChannelStore.resetForSession()", "setDashboard(null)", "setOrganizationStaffScope(null)"]) {
      expect(switchBlock, reset).toContain(reset);
      expect(switchBlock.indexOf(reset), reset).toBeLessThan(refresh);
    }
  });

  it("reads the definitions in force, not the superseded 20260821010000 text", () => {
    expect(liveSwitchChapter.name).toBe("20260822010000_mi1_organization_scope_foundation.sql");
    expect(liveMemberHasRole.name).toBe("20260826158000_mi1_role_transition_and_contract_repairs.sql");
    expect(liveHandleNewMember.name).toBe("20260925965000_member_recovery_and_chapter_grant_tenant_check.sql");
    for (const [schema, name] of [
      ["public", "switch_my_chapter"],
      ["public", "member_has_role"],
      ["private", "handle_new_member"],
    ]) {
      const defined = definingMigrations(schema, name).map((entry) => entry.name);
      expect(defined, `${schema}.${name}`).toContain("20260821010000_mobile_multichapter_identity.sql");
      expect(defined.length, `${schema}.${name}`).toBeGreaterThan(1);
    }
  });
});

describe("emailed-password account delivery", () => {
  it("prepares the exact banned identity and consumes the lease only after activation", () => {
    const prepare = compact(invitation).split("create or replace function public.finalize_member_invitation(")[1]
      .split("create or replace function public.complete_member_invitation_activation(")[0];
    const complete = compact(invitation).split("create or replace function public.complete_member_invitation_activation(")[1]
      .split("create or replace function public.fail_member_invitation_accept(")[0];
    expect(prepare).toContain("from auth.users u");
    expect(prepare).toContain("u.raw_user_meta_data ->> 'union_base_invitation_id'");
    expect(prepare).toContain("u.raw_app_meta_data ->> 'union_ground_provisioning'");
    expect(prepare).toContain("u.banned_until > pg_catalog.clock_timestamp()");
    expect(prepare).toContain("insert into public.member_role_chapters");
    expect(prepare).not.toContain("status = 'accepted'");
    expect(complete).toContain("'active'");
    expect(complete).toContain("u.banned_until is null or u.banned_until <=");
    expect(complete).toContain("from public.member_chapter_memberships m");
    expect(complete).toContain("status = 'accepted'");
    expect(`${prepare}${complete}`).not.toContain("'password',");
    expect(`${prepare}${complete}`).not.toMatch(/\bpassword\s+text\b/);
  });

  it("makes stale leases distinguish pending deletion from active completion", () => {
    const recovery = fnBody(invitation, "get_member_invitation_recovery_user").toLowerCase();
    expect(recovery).toContain("invitation_row.auth_user_id is null or u.id = invitation_row.auth_user_id");
    expect(recovery).toContain("raw_app_meta_data ->> 'union_ground_provisioning'");
    expect(recovery).toContain("'provisioning', user_row.provisioning");
    const source = compact(invitation);
    expect(source).toContain("drop constraint member_invitations_state_check");
    expect(source).toContain("status = 'accepting' and token_hash is not null and accepting_at is not null");
    expect(source).not.toContain("status = 'accepting' and token_hash is not null and accepting_at is not null and auth_user_id is null");
  });

  it("keeps password reissue auditable, chapter-scoped, MFA-gated, and secret-free", () => {
    const begin = fnBody(reissue, "begin_member_password_reissue").toLowerCase();
    const finish = fnBody(reissue, "finalize_member_password_reissue").toLowerCase();
    expect(begin).toContain("private.member_has_chapter_role(chapter, array['admin'])");
    expect(begin).toContain("m.chapter_id = chapter");
    expect(begin).toContain("private.consume_member_signin_recovery_limit");
    expect(begin).toContain("set actor = caller, attempts = least(attempts + 1, 20)");
    expect(begin).toContain("operation.actor <> caller");
    expect(begin).toContain("operation.updated_at > pg_catalog.clock_timestamp() - interval '15 minutes'");
    expect(finish).toContain("from auth.users u");
    expect(finish).toContain("operation.actor <> caller");
    expect(finish).toContain("m.user_id = operation.target_user");
    expect(finish).toContain("m.chapter_id = operation.chapter_id");
    expect(finish).toContain("m.status = 'active'");
    expect(finish).toContain("u.raw_app_meta_data ->> 'union_ground_password_reissue_operation_id'");
    expect(finish).toContain("u.banned_until is null or u.banned_until <=");
    expect(compact(reissue)).toContain("revoke all on private.member_password_reissues from public, anon, authenticated, service_role");
    expect(compact(reissue)).not.toMatch(/\bpassword\s+text\b/);
  });

  it("serializes provider attempts and charges rate limits only after the live-lease check", () => {
    const begin = fnBody(reissueAttemptLease, "begin_member_password_reissue").toLowerCase();
    const source = compact(reissueAttemptLease);
    const liveRead = begin.indexOf("from private.member_password_reissues");
    const leaseCheck = begin.indexOf("operation.updated_at > pg_catalog.clock_timestamp() - interval '15 minutes'");
    const rateLimit = begin.indexOf("private.consume_member_signin_recovery_limit");
    const targetLimit = begin.indexOf("'target:' || p_target_user::text, 'target-day'");
    expect(source).toContain("language plpgsql security definer set search_path = ''");
    expect(begin).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(begin).toContain("where target_user = p_target_user and status = 'delivering' for update");
    expect(begin).toMatch(/for update;\s*live_operation_found := found;/);
    expect(liveRead).toBeGreaterThan(-1);
    expect(leaseCheck).toBeGreaterThan(liveRead);
    expect(rateLimit).toBeGreaterThan(leaseCheck);
    expect(targetLimit).toBeGreaterThan(begin.indexOf("if not live_operation_found"));
    expect(begin).not.toContain("operation.actor <> caller");
    expect(begin).toContain("set actor = caller, attempts = least(attempts + 1, 20)");
    expect(begin).toContain("caller is null or not private.mfa_satisfied()");
    expect(begin).toContain("private.member_has_chapter_role(chapter, array['admin'])");
    expect(begin).toContain("p_target_user is null or p_target_user = caller");
    expect(begin).toContain("m.user_id = p_target_user and m.chapter_id = chapter and m.status = 'active'");
    expect(begin).toContain("live_operation_found and operation.chapter_id <> chapter");
    expect(begin).toContain("password reissue already in progress");
    expect(source).toContain("revoke all on function public.begin_member_password_reissue(uuid) from public, anon, authenticated, service_role");
    expect(source).toContain("grant execute on function public.begin_member_password_reissue(uuid) to authenticated");
  });
});

describe("two-sided handshakes and privacy-safe leadership workflows", () => {
  it("requires both chapter signatures and binds retries to the same transition actor and record", () => {
    const request = fnBody(workflows, "request_chapter_handshake").toLowerCase();
    const respond = fnBody(workflows, "respond_chapter_handshake").toLowerCase();
    const countersign = fnBody(workflows, "countersign_chapter_handshake").toLowerCase();
    const share = fnBody(workflows, "share_chapter_handshake_document").toLowerCase();
    for (const body of [request, respond, countersign, share]) {
      expect(body).toContain("idempotency key already used");
      expect(body).toContain("prior_event.actor <> caller");
    }
    expect(respond).toContain("receiver_signed_by = case when p_decision = 'accept' then caller");
    expect(countersign).toContain("requester_signed_by = caller");
    expect(countersign).toContain("receiver_signed_by is null");
    expect(countersign).toContain("status = 'active'");
    expect(share).toContain("item.status <> 'active'");
    expect(share).toContain("item.data_scope <> 'docs_only'");
    expect(share).toContain("d.status = 'published'");
  });

  it("keeps handshake reads staff-only and makes an active shared document readable to either staff chapter", () => {
    const source = compact(workflows);
    const participantPolicies = [
      "chapter_handshakes_read_participant",
      "chapter_handshake_events_read_participant",
      "chapter_handshake_documents_read_participant",
    ];
    for (const policy of participantPolicies) {
      const start = source.indexOf(`create policy ${policy}`);
      expect(start).toBeGreaterThan(-1);
      const body = source.slice(start, start + 1200);
      expect(body).toContain("private.member_has_chapter_role");
      expect(body).toContain("'steward','coordinator','advisor','admin','vp'");
    }
    expect(source).toContain("alter policy chapter_documents_read on public.chapter_documents");
    expect(workflows).toContain("20260808040000_vp_draft_documents_read");
    expect(source).toContain("hd.document_id = chapter_documents.id");
    expect(source).toContain("h.status = 'active'");
    expect(source).toContain("status = 'published'");
    expect(source).toContain("private.current_member_chapter() in (h.chapter_id, h.receiving_chapter_id)");
  });

  it("suppresses small health cohorts and bounds history and connection setup", () => {
    const portfolio = fnBody(workflows, "get_chapter_health_portfolio").toLowerCase();
    const history = fnBody(workflows, "get_appointment_history").toLowerCase();
    const setup = fnBody(workflows, "request_chapter_connection_setup").toLowerCase();
    expect(portfolio).toContain("coalesce(latest.member_count, 0) < 10");
    expect(portfolio).toContain("coalesce(latest.member_count, 0) >= 10");
    expect(history).toContain("p_limit not between 1 and 50");
    expect(history).toContain("e.detail - 'calendarreason' - 'busyreason'");
    expect(history).toContain("'nextbefore', case when history_count = p_limit then next_before else null end");
    expect(history).toContain("(history.created_at, history.id) < (p_before, p_before_id)");
    expect(history).toContain("'nextbeforeid', case when history_count = p_limit then next_before_id else null end");
    expect(setup).toContain("status, provider_label, public_message, requested_by");
    expect(setup).toContain("'setup requested. an operator must verify");
    expect(setup).toContain("'notion','enterprise'");
  });
});

describe("G3 appointment participant and selected-chapter boundaries", () => {
  it("rebinds the supervisor list to the active chapter-role helper", () => {
    expect(g3BoundaryRepair).not.toBe("");
    const report = fnBody(g3BoundaryRepair, "list_chapter_appointments").toLowerCase();
    expect(report).toContain("private.current_member_chapter()");
    expect(report).toContain("not private.mfa_satisfied()");
    expect(report).toContain("private.member_has_chapter_role(caller_chapter, array['coordinator','advisor','admin'])");
    expect(report).not.toContain("public.member_has_role");
    expect(report).not.toContain("from public.member_roles r");
  });

  it("pins the repaired selected-chapter supervisor definition in the DB contract", () => {
    const entry = dbContract.functions.find(
      ({ sig }) => sig === "public.list_chapter_appointments(p_after_starts timestamp with time zone, p_after_id uuid, p_limit integer)",
    );
    expect(entry).toBeDefined();
    expect(entry.bodyContains).toContain("private.mfa_satisfied()");
    expect(entry.bodyContains).toContain("private.member_has_chapter_role(caller_chapter, array['coordinator','advisor','admin'])");
    expect(entry.bodyContains).not.toContain("member_has_role(array['coordinator', 'advisor', 'admin'])");
    expect(entry.bodyContains).not.toContain("r.chapter_id is null or r.chapter_id = caller_chapter");
  });

  it("limits history to the member, the active assigned steward, or supervising chapter staff", () => {
    expect(g3BoundaryRepair).not.toBe("");
    const history = fnBody(g3BoundaryRepair, "get_appointment_history").toLowerCase();
    expect(history).toContain("caller = appointment.user_id");
    expect(history).toMatch(/appointment\.chapter_id\s*=\s*private\.current_member_chapter\(\)/);
    expect(history).toContain("caller = appointment.steward_id");
    expect(history).toContain("private.member_has_chapter_role(appointment.chapter_id, array['steward'])");
    expect(history).toContain("private.member_has_chapter_role(appointment.chapter_id, array['coordinator','advisor','admin'])");
    expect(history).not.toContain("array['steward','coordinator','advisor','admin']");
  });

  it("replaces the pre-multi-chapter appointment and event read policies", () => {
    const source = stripComments(g3BoundaryRepair).toLowerCase();
    expect(source).toContain("drop policy if exists member_appointments_select_participant on public.member_appointments");
    expect(source).toContain("drop policy if exists member_appointment_events_select_participant on public.member_appointment_events");
    expect(source).toContain("private.member_has_chapter_role(member_appointments.chapter_id, array['steward'])");
    expect(source).toContain("private.member_has_chapter_role(a.chapter_id, array['steward'])");
    expect(source).toContain("member_appointments.chapter_id = private.current_member_chapter()");
    expect(source).toContain("a.chapter_id = private.current_member_chapter()");
    expect(source).not.toMatch(/from public\.member_roles r[\s\S]*r\.role = 'steward'/);
  });
});
