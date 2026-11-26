// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, latestFnBody, loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";
import { expectMi1OrganizationRlsContract } from "./helpers/mi1Contract.js";

const SNAPSHOT_MIGRATION = "20260822010000_mi1_organization_scope_foundation";
const sql = loadMigrationSql(SNAPSHOT_MIGRATION);
const code = stripComments(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

function body(name) {
  return stripComments(fnBody(sql, name));
}

// Ordering checks must fail when either anchor is absent: a bare indexOf returns
// -1 for a missing needle, and -1 satisfies toBeLessThan against any found index.
function expectAnchorOrder(text, before, after) {
  const beforeIndex = text.indexOf(before);
  const afterIndex = text.indexOf(after);
  expect(beforeIndex, `missing anchor: ${before}`).toBeGreaterThan(-1);
  expect(afterIndex, `missing anchor: ${after}`).toBeGreaterThan(-1);
  expect(beforeIndex).toBeLessThan(afterIndex);
}

// Three of the predicates this migration introduced are re-declared by later
// migrations, so for those three `body()` returns a SUPERSEDED snapshot and any
// claim made from it is a claim about history, not about the database. Claims
// about how they behave today go through `liveBody()` below.
const REDECLARED_PREDICATES = [
  "private.is_organization_member",
  "private.has_organization_role",
  "public.member_has_role",
];

// The live body: the last create-or-replace in apply order, read through the
// shared helper so a fourth re-declaration moves these assertions with it.
const liveBody = latestFnBody;

describe("MI1 organization-scope reserved migration", () => {
  it("is the only 20260822010000 file and was created through the reserved name", () => {
    const matches = migrationNames().filter((name) => name.startsWith("20260822010000"));
    expect(matches).toEqual(["20260822010000_mi1_organization_scope_foundation.sql"]);
    expect(sql).toContain("npx supabase migration new mi1_organization_scope_foundation");
    expect(sql).toContain("CLI 2.109.1");
  });

  it("creates empty-safe tenant primitives and never seeds an organization", () => {
    for (const table of [
      "organizations",
      "organization_memberships",
      "organization_role_grants",
      "organization_audit_events",
    ]) {
      expect(code).toContain(`create table public.${table}`);
      expect(code).toContain(`alter table public.${table} enable row level security`);
      expect(code).toContain(`revoke all on public.${table} from public, anon, authenticated`);
      expect(code).toContain(`grant select on public.${table} to authenticated`);
    }
    const beforeBootstrap = code.slice(0, code.indexOf("public.bootstrap_first_organization"));
    expect(beforeBootstrap).not.toMatch(/insert into public\.organizations/i);
    expect(code).toContain("constraint organization_audit_events_metadata_keys");
    expect(code).toContain("organization audit events are append-only");
  });

  it("replaces global chapter uniqueness with per-organization equivalents and contains orphans", () => {
    expect(code).toContain("drop constraint if exists chapters_name_key");
    expect(code).toContain("drop index if exists public.chapters_one_default_idx");
    expect(code).toContain("chapters_organization_name_idx");
    expect(code).toContain("chapters_organization_slug_idx");
    expect(code).toContain("chapters_organization_default_idx");
    expect(code).toContain("chapters_orphan_name_idx");
    expect(code).toContain("ownerless chapter writes are prohibited");
    expect(code).toContain("legacy chapter reassignment is operator disposition");
  });

  it("adds organization-owned broadcast audience without backfilling legacy rows", () => {
    expect(code).toContain("add column organization_id uuid");
    expect(code).toContain("add column audience_scope text");
    expect(code).toContain("member_broadcasts_audience_complete");
    expect(code).toContain("ownerless broadcast writes are prohibited");
    expect(code).not.toMatch(/update\s+public\.member_broadcasts\s+set\s+organization_id/i);
  });
});

describe("authorization helpers", () => {
  it("never treats a null organization id as a wildcard", () => {
    expect(liveBody("private.is_organization_member")).toContain("p_organization_id is null then false");
    expect(liveBody("private.has_organization_role")).toContain("p_organization_id is null then false");
    const current = body("private.current_member_organization");
    expect(current).toContain("c.organization_id");
    expect(current).toContain("public.member_chapter_memberships cm");
    expect(current).toContain("public.organization_memberships om");
    expect(current).toContain("public.organizations o");
    expect(current).toContain("o.status = 'active'");
    expect(current).toContain("cm.status = 'active'");
    expect(current).toContain("om.status = 'active'");
  });

  it("binds shared organization predicates to the active selected tenant", () => {
    // 20260903040000 moved both predicates off private.current_member_organization()
    // onto the non-raising mobile-staff resolver; this reads that last
    // declaration, not the 20260822010000 snapshot above.
    for (const name of ["private.is_organization_member", "private.has_organization_role"]) {
      expect(liveBody(name), name).toContain(
        "p_organization_id is distinct from (select private.current_mobile_staff_organization()) then false",
      );
    }
    expect(liveBody("private.has_organization_role")).toContain(
      "private.staff_mfa_required(p_organization_id)",
    );
  });

  it("never states a live fact about a re-declared predicate from the superseded 20260822010000 snapshot", () => {
    const source = readFileSync(new URL(import.meta.url), "utf8");
    for (const name of REDECLARED_PREDICATES) {
      expect(liveBody(name), name).not.toBe(body(name));
      expect(source.match(new RegExp(String.raw`\bbody\("${name}"\)`, "g")), name).toBeNull();
    }
    // The contradiction this guard exists to prevent: the same last-declared
    // body is read by tests/mi1-role-transition-repairs-static.test.js, which
    // asserts the organization-grant join IS there.
    expect(liveBody("public.member_has_role")).toContain("public.organization_role_grants organization_role");
  });

  it("accepts explicit organization grants in the generic role helper and isolates the orphan NULL-chapter path", () => {
    // 20260826158000 is the last declaration: it added the organization-wide
    // grant branch beside the selected-chapter one.
    const role = liveBody("public.member_has_role");
    expect(role).toContain("public.organization_role_grants organization_role");
    expect(role).toContain("public.member_role_chapters chapter_role");
    expect(role).toContain("selected.organization_id is not null");
    expect(role).toContain("selected_org.status = 'active'");
    expect(role).toContain("private.current_member_organization()) is null");
    expect(role).toContain("private.mfa_satisfied()");
    expect(role).toContain("private.staff_mfa_required()");

    const chapterRole = body("private.member_has_chapter_role");
    expect(chapterRole).toContain("c.organization_id = (select private.current_member_organization())");
    expect(chapterRole).toContain("private.has_organization_role(c.organization_id, p_roles)");
    expect(chapterRole).toContain("private.staff_mfa_required(c.organization_id)");
    expect(chapterRole).toContain("private.has_second_factor((select auth.uid()))");
    expect(chapterRole).toContain("c.organization_id is not null");
    expect(chapterRole).toContain("c.organization_id is null");
  });

  it("keeps the latest membership projection pin while gating NULL roles to orphan chapters", () => {
    const memberships = body("public.get_my_chapter_memberships");
    expect(memberships).toContain("from public.member_role_chapters rc");
    expect(memberships).toContain("from public.member_roles r");
    expect(memberships).toContain("r.chapter_id is null");
    expect(memberships).toContain("r.user_id = m.user_id");
    expect(memberships).toContain("and c.organization_id is null");
    expect(memberships).toContain("public.organization_role_grants g");
    expect(memberships).toContain("private.current_member_organization() is null");
    expect(memberships).toContain("join public.organizations o");
    expect(memberships).toContain("o.status = 'active'");
    expect(memberships).toContain("om.organization_id = c.organization_id");
    expect(memberships).toContain("and not exists (");
  });

  it("binds background-safe staff visibility to the actor's active selected tenant", () => {
    const visibility = body("private.staff_actor_can_see_user");
    expect(visibility).toContain("actor_chapter.organization_id = target_chapter.organization_id");
    expect(visibility).toContain("actor_membership.user_id = actor_profile.id");
    expect(visibility).toContain("actor_membership.chapter_id = actor_chapter.id");
    expect(visibility).toContain("actor_membership.status = 'active'");
  });

  it("denies foreign chapter switching and grants", () => {
    const chapterSwitch = body("public.switch_my_chapter");
    expect(chapterSwitch).toContain("foreign chapter switching denied");
    expect(chapterSwitch).not.toContain("private.is_organization_member(target_org)");
    expect(chapterSwitch).toContain("om.organization_id = target_org");
    expect(chapterSwitch).toContain("om.user_id = caller");
    expect(chapterSwitch).toContain("o.status = 'active'");
    expectAnchorOrder(
      chapterSwitch,
      "member-chapter:",
      "current_org := private.current_member_organization()",
    );
    const grant = body("public.grant_member_chapter_membership");
    expect(grant).toContain("private.has_organization_role(target_org, array['admin'])");
    const grantOrganizationLock = grant.indexOf("organization-role:");
    const grantMemberLock = grant.indexOf("member-chapter:");
    const grantPlausibility = grant.indexOf("org_admin := private.has_organization_role");
    const grantReauthorization = grant.lastIndexOf("org_admin := private.has_organization_role");
    expect(grantOrganizationLock).toBeGreaterThan(-1);
    expect(grantMemberLock).toBeGreaterThan(-1);
    expect(grantPlausibility).toBeGreaterThan(-1);
    expect(grantPlausibility).toBeLessThan(grantOrganizationLock);
    expect(grantOrganizationLock).toBeLessThan(grantMemberLock);
    expect(grantMemberLock).toBeLessThan(grantReauthorization);
    const chapterRole = body("public.set_member_chapter_role");
    expect(chapterRole).toContain("active organization membership required");
    const chapterRoleLock = chapterRole.indexOf("organization-role:");
    const chapterRolePlausibility = chapterRole.indexOf("org_admin := private.has_organization_role");
    const chapterRoleReauthorization = chapterRole.lastIndexOf("org_admin := private.has_organization_role");
    expect(chapterRoleLock).toBeGreaterThan(-1);
    expect(chapterRolePlausibility).toBeGreaterThan(-1);
    expect(chapterRolePlausibility).toBeLessThan(chapterRoleLock);
    expect(chapterRoleLock).toBeLessThan(chapterRoleReauthorization);
    expect(chapterRoleLock).toBeLessThan(chapterRole.indexOf("active chapter membership required"));
    expect(body("private.forbid_new_ownerless_member_roles")).toContain("organization-wide hats must use organization_role_grants");
  });

  it("limits ownerless SAMPLE roles to signed app metadata and admin/VP writes", () => {
    const guard = body("private.forbid_new_ownerless_member_roles");
    expect(guard).toContain("new.role in ('admin', 'vp')");
    expect(guard).toContain("auth.jwt() ->> 'role'");
    expect(guard).toContain("service_role");
    expect(guard).toContain("raw_app_meta_data");
    expect(guard).toContain("sample");
    expect(guard).toContain("surface");
    expect(guard).not.toContain("raw_user_meta_data");
    expect(code).toMatch(/create trigger member_roles_forbid_new_ownerless\s+before insert or update/);
  });

  it("preserves the final organization admin across chapter-membership revocation", () => {
    const revoke = body("public.revoke_member_chapter_membership");
    const organizationLock = revoke.indexOf("organization-role:");
    const memberLock = revoke.indexOf("member-chapter:");
    const plausibility = revoke.indexOf("org_admin := private.has_organization_role");
    const reauthorization = revoke.lastIndexOf("org_admin := private.has_organization_role");
    expect(organizationLock).toBeGreaterThan(-1);
    expect(memberLock).toBeGreaterThan(-1);
    expect(plausibility).toBeGreaterThan(-1);
    expect(plausibility).toBeLessThan(organizationLock);
    expect(organizationLock).toBeLessThan(memberLock);
    expect(memberLock).toBeLessThan(reauthorization);
    expect(revoke).toContain("public.organization_role_grants");
    expect(revoke).toContain("m.chapter_id <> p_chapter_id");
    expect(revoke).toContain("cannot remove the last organization admin");
    expect(revoke).toContain("c.organization_id = target_org");
    expectAnchorOrder(
      revoke,
      "select m.chapter_id into replacement_chapter",
      "update public.member_chapter_memberships",
    );
    expectAnchorOrder(
      revoke,
      "insert into public.member_admin_audit",
      "update public.member_chapter_memberships",
    );
    expect(revoke).toContain("organization_id\n  ) values");
  });

  it("fails every tenant lock-ordering check when its anchor statement is absent", () => {
    const chapterSwitch = body("public.switch_my_chapter");
    const revoke = body("public.revoke_member_chapter_membership");
    const orderings = [
      [chapterSwitch, "member-chapter:", "current_org := private.current_member_organization()"],
      [
        revoke,
        "select m.chapter_id into replacement_chapter",
        "update public.member_chapter_memberships",
      ],
      [revoke, "insert into public.member_admin_audit", "update public.member_chapter_memberships"],
    ];
    for (const [text, before, after] of orderings) {
      expect(() => expectAnchorOrder(text, before, after), before).not.toThrow();
      const withoutAnchor = text.split(before).join("");
      expect(withoutAnchor).not.toContain(before);
      expect(withoutAnchor).toContain(after);
      expect(() => expectAnchorOrder(withoutAnchor, before, after), before).toThrow();
    }
  });

  it("serializes chapter creation before its authoritative admin recheck", () => {
    const create = body("public.create_admin_chapter");
    const orgLock = create.indexOf("organization-role:");
    const chapterLock = create.indexOf("chapters:admin");
    expect(orgLock).toBeGreaterThan(-1);
    expect(orgLock).toBeLessThan(chapterLock);
    expect(orgLock).toBeLessThan(create.lastIndexOf("private.has_organization_role"));
    expect(create).toContain("org_id is distinct from locked_org");
  });

  it("guards deletion requests and Auth deletion with sorted tenant locks", () => {
    const assertion = body("private.assert_member_account_deletion_allowed");
    expect(assertion).toContain("select distinct m.organization_id");
    expect(assertion).toContain("order by m.organization_id");
    expect(assertion).toContain("m.user_id = p_user_id");
    expect(assertion).toContain("m.status = 'active'");
    expect(assertion).toContain("o.status = 'active'");
    expect(assertion).toContain("organization-role:");
    expect(assertion).toContain("backup.user_id <> p_user_id");
    expect(assertion).toContain("cannot remove the last organization admin");
    expect(body("private.guard_auth_user_deletion")).toContain(
      "private.assert_member_account_deletion_allowed(old.id)",
    );
    expect(body("private.guard_member_account_deletion_request")).toContain(
      "private.assert_member_account_deletion_allowed(caller)",
    );
    expect(code).toContain("auth_users_preserve_final_organization_admin");
    expect(code).toContain("member_account_deletions_preserve_final_organization_admin");
    expect(code).toContain("drop constraint organization_audit_events_actor_user_id_fkey");
    expect(code).toContain("alter column actor_user_id set not null");
    expect(code).toMatch(
      /create trigger organization_role_grants_require_active_membership\s+before insert or update of organization_id, user_id, role/,
    );
    expect(body("private.forbid_organization_audit_mutation")).not.toContain("return new");
  });

  it("reauthorizes all invitation administration under organization-to-member locks", () => {
    const helper = body("private.require_member_invitation_admin_chapter");
    const orgLock = helper.indexOf("organization-role:");
    const memberLock = helper.indexOf("member-chapter:");
    expect(orgLock).toBeGreaterThan(-1);
    expect(memberLock).toBeGreaterThan(-1);
    expect(orgLock).toBeLessThan(memberLock);
    expect(memberLock).toBeLessThan(helper.lastIndexOf("private.member_has_chapter_role"));
    expect(helper).toContain("locked_chapter is distinct from selected_chapter");
    for (const name of [
      "public.create_member_invitation",
      "public.resend_member_invitation",
      "public.revoke_member_invitation",
      "public.record_member_invitation_delivery",
      "public.get_member_invitations",
    ]) {
      expect(body(name), name).toContain("private.require_member_invitation_admin_chapter()");
      expect(body(name), name).toContain("private.member_has_chapter_role(caller_chapter, array['admin'])");
    }
  });

  it("keeps legacy staff readers inside active selected-tenant memberships", () => {
    const projection = body("private.organization_member_roles");
    expect(projection).toContain("public.organization_role_grants g");
    expect(projection).toContain("public.member_role_chapters rc");
    expect(projection).toContain("c.organization_id = p_organization_id");
    expect(projection).toContain("om.organization_id = p_organization_id");
    for (const name of [
      "public.get_admin_member_directory",
      "public.admin_search_members",
      "public.get_staff_roster",
      "public.get_admin_org_structure",
      "public.get_admin_mfa_status",
    ]) {
      const reader = body(name);
      expect(reader, name).toContain("caller_org uuid := private.current_member_organization()");
      expect(reader, name).toContain("caller_chapter text := private.current_member_chapter()");
      expect(reader, name).toContain("private.member_has_chapter_role(");
      expect(reader, name).toContain("caller_org");
    }
  });

  it("owns every new reward grant and scopes mutations, PII queues, RLS, and effects", () => {
    const rewardGuard = body("private.forbid_ownerless_reward_grant_write");
    expect(rewardGuard).toContain("ownerless reward grant writes are prohibited");
    expect(rewardGuard).toContain("legacy reward grants are quarantined");
    expect(rewardGuard).toContain("reward grant organization is immutable");
    for (const name of [
      "public.claim_reward_without_shipping_legacy",
      "public.claim_reward",
      "public.set_reward_shipping_address",
      "public.grant_reward",
      "public.revoke_reward",
      "public.fulfill_reward_without_evidence_legacy",
      "public.fulfill_reward",
      "public.get_admin_reward_queue_without_shipping_legacy",
      "public.get_admin_reward_queue",
      "private.member_reward_effect_enabled",
      "public.get_member_reward_effects",
    ]) {
      expect(body(name), name).toContain("organization_id");
    }
    expect(code).not.toMatch(/update\s+public\.member_reward_grants\s+set\s+organization_id/i);
    expect(code).toMatch(/create policy member_reward_grants_select_own[\s\S]*organization_id = private\.current_member_organization\(\)/);
  });

  it("provides an audited selected-tenant path for organization-wide role changes", () => {
    const role = body("public.set_member_organization_role");
    expect(role).toContain("private.current_member_organization()");
    expect(role).toContain("private.has_organization_role(locked_org, array['admin'])");
    expect(role).toContain("active organization membership required");
    expect(role).toContain("cannot remove the last organization admin");
    expect(role).toContain("public.organization_audit_events");
    const lock = role.indexOf("organization-role:");
    const plausibility = role.indexOf("private.has_organization_role(locked_org, array['admin'])");
    const reauthorization = role.lastIndexOf("private.has_organization_role(locked_org, array['admin'])");
    expect(lock).toBeGreaterThan(-1);
    expect(plausibility).toBeGreaterThan(-1);
    expect(plausibility).toBeLessThan(lock);
    expect(lock).toBeLessThan(role.indexOf("target_org := private.current_member_organization()"));
    expect(lock).toBeLessThan(reauthorization);
    expect(lock).toBeLessThan(role.indexOf("active organization membership required"));
    expect(code).toContain(
      "grant execute on function public.set_member_organization_role(uuid, text, boolean)\n  to authenticated",
    );
  });

  it("delegates staff visibility to the shared selected-org and MFA controls", () => {
    const visibility = body("public.staff_can_see_user");
    expect(visibility).toContain("target_chapter.organization_id = (select private.current_member_organization())");
    expect(visibility).toContain("private.has_organization_role(target_chapter.organization_id, array[p_role])");
    expect(visibility).toContain("private.member_has_chapter_role(target_chapter.id, array[p_role])");
    expect(visibility).toContain("private.mfa_satisfied()");
    expect(visibility).toContain("private.has_second_factor((select auth.uid()))");
  });

  it("derives new admin-audit ownership and filters both RPC and direct RLS reads", () => {
    expect(code).toContain("add column organization_id uuid");
    expect(code).toContain("member_admin_audit_organization_created_idx");

    const assign = body("private.assign_member_admin_audit_organization");
    expect(assign).toContain("public.member_chapter_memberships cm");
    expect(assign).toContain("public.organization_memberships om");
    expect(assign).toContain("active audit organization required");
    expect(assign).toContain("audit organization is derived from actor");
    expect(assign).toContain("new.organization_id := active_org");

    const audit = body("public.get_admin_audit");
    expect(audit).toContain("audit_org uuid := private.current_member_organization()");
    expect(audit).toContain("or audit_org is null");
    expect(audit).toContain("m.organization_id is not null");
    expect(audit).toContain("m.organization_id = audit_org");
    expect(audit).not.toContain("m.organization_id is not distinct from audit_org");
    expect(code).toMatch(/alter policy member_admin_audit_select_admin[\s\S]*organization_id is not null[\s\S]*organization_id = private\.current_member_organization\(\)/);
    expect(code).toContain("member_admin_audit_assign_organization");
  });

  it("fails survey task conversion closed outside the caller chapter", () => {
    const source = body("public.create_chapter_task_from_source");
    const memberLock = source.indexOf("member-chapter:");
    expect(memberLock).toBeGreaterThan(-1);
    expect(memberLock).toBeLessThan(source.indexOf("select p.chapter_id, c.organization_id into caller_chapter, caller_org"));
    expect(memberLock).toBeLessThan(source.indexOf("private.member_has_chapter_role("));
    expect(source).toContain("private.member_has_chapter_role(\n    caller_chapter");
    expect(source).toContain("s.chapter_id is not null");
    expect(source).toContain("s.chapter_id = caller_chapter");
  });
});

describe("bootstrap", () => {
  it("is service-role only, locked, idempotent, and empty-account safe", () => {
    const bootstrap = body("public.bootstrap_first_organization");
    expect(bootstrap).toContain("auth.jwt() ->> 'role'");
    expect(bootstrap).toContain("service_role");
    expect(bootstrap).toContain("pg_advisory_xact_lock");
    expect(bootstrap).toContain("organization already exists");
    expect(bootstrap).toContain("provisioned user required");
    expect(bootstrap).toContain("first_organization_bootstrap");
    expect(bootstrap).not.toContain("insert into auth.users");
    expect(bootstrap).not.toContain("member_cases");
    expect(bootstrap).not.toContain("member_messages");
    expect(bootstrap).not.toContain("member_notifications");
  });

  it("grants execute only to service_role", () => {
    expect(code).toContain(
      "revoke all on function public.bootstrap_first_organization(text, text, uuid, text, text, text, uuid)\n  from public, anon, authenticated",
    );
    expect(code).toContain(
      "grant execute on function public.bootstrap_first_organization(text, text, uuid, text, text, text, uuid)\n  to service_role",
    );
  });
});

describe("db-contract lockstep", () => {
  it("records the new tenant functions, policies, and table count", () => {
    expectMi1OrganizationRlsContract(contract);
    expect(contract.policyCoverage.unconditionalPolicyAllowlist).not.toContain("chapters.chapters_select_all");
    expect(contract.policyCoverage.unconditionalPolicyAllowlist).not.toContain(
      "member_broadcasts.member_broadcasts_read_authenticated",
    );
    expect(contract.functions.some((entry) => entry.sig.startsWith("public.bootstrap_first_organization("))).toBe(true);
    expect(contract.functionsAbsent.some((entry) => entry.sig === "public.publish_member_broadcast(text, text, text)")).toBe(true);
    // chapter_records_read_staff is one OR branch of chapter_records_select since 20261028210000.
    expect(contract.policies.some((entry) => entry.name === "chapter_records_select"
      && entry.qual.includes("can_read_chapter_contact_record(chapter_id)"))).toBe(true);
    expect(contract.policiesForbidden.some((entry) => entry.table === "chapter_records" && entry.namePattern.includes("staff_"))).toBe(true);
    expect(contract.tableGrants.some((entry) => entry.table === "public.organizations" && entry.privileges === "SELECT")).toBe(true);
  });
});

describe("organization audit event vocabulary", () => {
  function eventTypes(source) {
    const definitions = [...source.matchAll(
      /add constraint organization_audit_events_event_type_check check \(event_type in \(([\s\S]*?)\)\)/g,
    )];
    expect(definitions.length).toBeGreaterThan(0);
    return [...definitions.at(-1)[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  }

  it("admits organization_export_completed on the current event_type CHECK", () => {
    const original = [
      "first_organization_bootstrap",
      "organization_membership_granted",
      "organization_membership_revoked",
      "organization_role_granted",
      "organization_role_revoked",
      "staff_mfa_policy_changed",
    ];
    for (const eventType of original) {
      expect(code).toContain(`'${eventType}'`);
    }
    const latest = eventTypes(loadMigrationSql("20260924030100_institutional_export_durable_audit"));
    expect(latest.slice(0, original.length)).toEqual(original);
    expect(latest.at(-1)).toBe("organization_export_completed");
    expect(latest).toContain("dues_stripe_oauth_recovery_required");
    expect(new Set(latest).size).toBe(latest.length);
  });
});
