// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("20260828021500_mi1_member_access_history"));

function latestFunction(name) {
  const latest = migrationFiles()
    .filter(({ sql: text }) => new RegExp(`function\\s+${name.replaceAll(".", "\\.")}\\s*\\(`, "i").test(text))
    .at(-1);
  expect(latest, `${name} must have a latest generation`).toBeTruthy();
  return stripComments(fnBody(latest.sql, name));
}

describe("CR-086 access history persistence", () => {
  it("creates an organization-scoped empty table with RPC-only writes", () => {
    expect(sql).toContain("create table public.member_access_events");
    expect(sql).toContain("organization_id uuid not null");
    expect(sql).toContain("revoke all on public.member_access_events from public, anon, authenticated");
    // The birth grant was table-wide, which handed the subject the actor_user_id
    // that list_my_access_history deliberately never projects. Shipped migrations
    // are never edited, so this pin still describes this file; the narrowing lives
    // in 20260925570500_member_access_event_actor_projection.sql and is pinned by
    // tests/member-access-event-actor-projection-db.test.js.
    expect(sql).toContain("grant select on public.member_access_events to authenticated");
    expect(sql).not.toMatch(/insert into public\.member_access_events\s+values/i);
  });

  it("lets the subject list their own events and forbids self-records", () => {
    expect(sql).toContain("create function public.list_my_access_history(");
    expect(sql).toContain("create function public.record_member_access_event(");
    expect(sql).toContain("private.mi1_require_expected_selected_organization(p_expected_organization_id)");
    expect(sql).toContain("p_subject_user_id is not distinct from caller");
    expect(sql).toContain("cannot record self access");
  });

  it("retains actor history and rejects subjects outside the selected organization", () => {
    expect(sql).toContain("actor_user_id uuid references auth.users(id) on delete set null");
    expect(sql).toContain("membership.organization_id = org");
    expect(sql).toContain("membership.user_id = p_subject_user_id");
    expect(sql).toContain("membership.status = 'active'");
    expect(sql).toContain("subject not authorized");
  });

  it("keeps action/entity pairs coherent and returns clean input errors", () => {
    expect(sql).toContain("p_action in ('viewed_profile', 'updated_profile') and p_entity_type <> 'member'");
    expect(sql).toContain("p_action in ('viewed_case', 'updated_case') and p_entity_type <> 'case'");
    expect(sql).toContain("pg_catalog.char_length(p_entity_id) not between 1 and 80");
    expect(sql).toContain("p_entity_type = 'case' and p_entity_id is null");
    expect(sql).toContain("raise exception 'invalid entity' using errcode = '22023'");
  });

  it("projects live organization-role changes without inventing a historical actor role", () => {
    expect(sql).toContain("'staff'::text as \"actorRole\"");
    expect(sql).toContain("from public.organization_audit_events a");
    expect(sql).toContain("a.event_type in ('organization_role_granted', 'organization_role_revoked')");
    expect(sql).toContain("a.metadata ->> 'userId' = caller::text");
    expect(sql).not.toContain("from public.member_admin_audit a");
    expect(sql).not.toContain("order by r.role limit 1");
  });

  it("keeps the clause audit vocabulary when widening organization_audit_events", () => {
    expect(sql).toContain("'contract_clause_created'");
    expect(sql).toContain("'member_access_recorded'");
    expect(sql).toContain("'clauseId'");
  });

  it("normalizes the latest access-event refusals to one 42501 outcome", () => {
    const body = latestFunction("public.record_member_access_event");
    expect(body).not.toContain("subject not authorized");
    expect(body).toContain("raise exception 'not authorized' using errcode = '42501'");
    expect(body).toContain("membership.user_id = p_subject_user_id");
    expect(body).toContain("membership.status = 'active'");
    expect(body).toContain("cannot record self access");

    const authorizationRaises = [...body.matchAll(
      /raise exception '([^']*)' using errcode = '42501'/g,
    )];
    const unauthorized = authorizationRaises
      .map((match) => match[1])
      .filter((message) => message !== "mfa required");
    expect(unauthorized.length).toBeGreaterThanOrEqual(2);
    expect(new Set(unauthorized)).toEqual(new Set(["not authorized"]));

    const selfAt = body.indexOf("cannot record self access");
    const membershipAt = body.indexOf("from public.organization_memberships membership");
    expect(selfAt).toBeGreaterThan(-1);
    expect(membershipAt).toBeGreaterThan(selfAt);
  });

  it("carries the bounded entity id into the latest access-event tenant-audit metadata", () => {
    const body = latestFunction("public.record_member_access_event");
    expect(body).toContain("errcode = '42501'");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("private.mi1_write_tenant_audit");

    const audit = body.slice(body.indexOf("private.mi1_write_tenant_audit"));
    expect(audit.toLowerCase()).toContain("'entitytype'");
    expect(audit.toLowerCase()).toContain("'entityid'");
    expect(audit).toContain("'entityId', nullif(p_entity_id, '')");
    expect(audit).toContain("'entityType', p_entity_type");
  });

  it("keeps the case-graph entry lock ahead of the access-event initializer", () => {
    const body = latestFunction("public.record_member_access_event");
    const lock = body.indexOf("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(body.indexOf("private.mi1_require_expected_selected_organization"));
    expect(lock).toBeLessThan(body.indexOf("insert into public.member_access_events"));
  });

  it("projects the organization_audit_events entity id from metadata", () => {
    const body = latestFunction("public.list_organization_audit_ledger");
    const marker = "'source', 'organization_audit_events'";
    const at = body.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const objectStart = body.lastIndexOf("pg_catalog.jsonb_build_object(", at);
    const objectEnd = body.indexOf("from public.organization_audit_events e", at);
    const branch = body.slice(objectStart, objectEnd);
    expect(branch).toContain("when e.event_type = 'member_access_recorded'");
    expect(branch).toContain("and e.metadata ->> 'entityType' in ('member', 'case')");
    expect(branch).toContain("then e.metadata ->> 'entityType'");
    expect(branch).toContain("else 'organization'");
    expect(branch).toContain("'entityId', e.metadata ->> 'entityId'");
    expect(branch).toContain("'source', 'organization_audit_events'");
  });
});
