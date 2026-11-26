// @vitest-environment node
//
// BUG-UG-CASEWORK-AUDIT-READER-KIND-VOCABULARY-DRIFT-20260918
//
// Static half pins that list_casework_audit_events validates p_kind against
// casework_audit_events_event_type_check rather than a parallel literal list.
// Live half (SUPABASE_DB_URL on the disposable loopback target) proves
// p_kind => 'macro_saved' returns the selected-organization row, an unknown
// kind still raises 22023, and a scratch reader without a.organization_id = org
// returns both tenants then restores byte-identical.
//
// SEC-UG-CASEWORK-AUDIT-READER-CASE-RESTRICTION-NOT-ENFORCED-20260920
//
// Live half also proves a coordinator-only caller sees a restricted case's
// audit row through the reader exactly when the policy-governed table read
// does: denied before a case-access grant, visible while granted, denied again
// after revocation.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const NAME = "20260919010000_casework_audit_reader_kind_vocabulary";
const GATE = "20260924140200_casework_audit_reader_case_restriction_gate";
const sql = stripComments(loadMigrationSql(NAME));
const gateSql = stripComments(loadMigrationSql(GATE));
const policySql = stripComments(loadMigrationSql("20260917103000_case_child_row_restriction_gate"));
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const FIVE = ["macro_saved", "macro_applied", "note_added", "note_mentioned", "case_assigned"];
const UNGATED_ROLE_DISJUNCTION =
  "private.has_organization_role(a.organization_id, array['coordinator', 'advisor', 'admin', 'vp'])";
const squash = (text) => text.replace(/\s+/g, " ").trim();

function lastFnMigration(name) {
  const matches = migrationFiles().filter((file) => {
    try {
      fnBody(file.sql, name);
      return true;
    } catch {
      return false;
    }
  });
  const last = matches.at(-1);
  if (!last) throw new Error(`no migration defines ${name}`);
  return last;
}

describe("casework audit reader kind vocabulary (static)", () => {
  it("re-emits the reader against the table CHECK and restates the original grants", () => {
    expect(findMigrationName(NAME) > "20260917144000_casework_macros_case_note_mentions.sql").toBe(true);
    expect(sql).toContain("pg_catalog.pg_get_constraintdef(c.oid)");
    expect(sql).toContain("casework_audit_events_event_type_check");
    const helper = fnBody(sql, "private.casework_audit_event_kinds()");
    expect(helper).toContain("set search_path = ''");
    expect(helper).not.toMatch(/security definer/i);
    const reader = fnBody(sql, "public.list_casework_audit_events(");
    expect(reader).toMatch(/security definer/i);
    expect(reader).toMatch(/set search_path (?:=|to) ''/i);
    expect(reader).toContain("private.casework_audit_event_kinds()");
    expect(reader).toContain("private.audit_sink_read_bounds(");
    expect(reader).toContain("private.casework_staff_can_access(a.case_id)");
    expect(reader).not.toContain("p_kind <> all (array[");
    expect(sql).toContain(
      "revoke all on function public.list_casework_audit_events(integer, timestamptz, bigint, text, timestamptz, timestamptz, uuid)\n  from public, anon, authenticated, service_role;",
    );
    expect(sql).toContain(
      "grant execute on function public.list_casework_audit_events(integer, timestamptz, bigint, text, timestamptz, timestamptz, uuid)\n  to authenticated;",
    );
    expect(sql).toContain(
      "revoke all on function private.casework_audit_event_kinds()\n  from public, anon, authenticated, service_role;",
    );
    expect(sql).not.toMatch(/grant execute on function private\.casework_audit_event_kinds/);
  });

  it("pins the CHECK-derived helper and the reader needles in the db contract", () => {
    const helper = contract.functions.find((entry) => entry.sig === "private.casework_audit_event_kinds()");
    expect(helper?.secdef).toBe(false);
    expect(helper?.exec).toBe("");
    expect(helper?.bodyMd5).toBe("702b0fd1cdcc77df3d101e9cedae44a4");
    expect(helper?.bodyContains).toEqual(expect.arrayContaining([
      "pg_catalog.pg_get_constraintdef(c.oid)",
      "casework_audit_events_event_type_check",
    ]));
    const reader = contract.functions.find((entry) => entry.sig.startsWith("public.list_casework_audit_events("));
    expect(reader?.secdef).toBe(true);
    expect(reader?.exec).toBe("authenticated");
    expect(reader?.bodyMd5).toBe("dd460c3b5189465a459da7b4be5c5a26");
    expect(reader?.bodyContains).toContain("private.casework_audit_event_kinds()");
    expect(reader?.bodyContains).toContain("private.has_organization_role(a.organization_id, array['advisor', 'admin', 'vp'])");
    expect(reader?.bodyContains).toContain("private.has_organization_role(a.organization_id, array['coordinator'])");
    expect(reader?.bodyContains).toContain("public.staff_can_see_user(c.user_id, 'coordinator')");
    expect(reader?.bodyContains).toContain("private.member_case_visible_to_caller(a.case_id)");
    expect(reader?.bodyContains).toContain("private.casework_staff_can_read(a.case_id)");
    expect(reader?.bodyContains).not.toContain(UNGATED_ROLE_DISJUNCTION);
    expect(reader?.bodyForbids).toContain("p_kind <> all (array[");
    expect(reader?.bodyForbids).toContain(UNGATED_ROLE_DISJUNCTION);
  });

  it("gates the last reader definition on parent-case visibility without delegating to member_cases RLS", () => {
    expect(findMigrationName(GATE) > `${NAME}.sql`).toBe(true);
    const last = lastFnMigration("public.list_casework_audit_events(");
    expect(last.name).toBe("20261102005607_unit_committee_scoped_access.sql");
    const reader = fnBody(last.sql, "public.list_casework_audit_events(");
    expect(reader).toMatch(/security definer/i);
    expect(reader).toMatch(/set search_path (?:=|to) ''/i);
    expect(reader).toContain("private.has_organization_role(a.organization_id, array['advisor', 'admin', 'vp'])");
    expect(reader).toContain("private.has_organization_role(a.organization_id, array['coordinator'])");
    expect(reader).toContain("public.staff_can_see_user(c.user_id, 'coordinator')");
    expect(reader).toContain("private.member_case_visible_to_caller(a.case_id)");
    expect(reader).toContain("private.casework_staff_can_read(a.case_id)");
    expect(reader).not.toContain(UNGATED_ROLE_DISJUNCTION);
    expect(reader).not.toMatch(/\b(insert|update|delete)\s+/i);
    expect(gateSql).toContain(
      "revoke all on function public.list_casework_audit_events(integer, timestamptz, bigint, text, timestamptz, timestamptz, uuid)\n  from public, anon, authenticated, service_role;",
    );
    expect(gateSql).toContain(
      "grant execute on function public.list_casework_audit_events(integer, timestamptz, bigint, text, timestamptz, timestamptz, uuid)\n  to authenticated;",
    );
    expect(gateSql).not.toMatch(/grant execute on function public\.list_casework_audit_events[^;]*to[^;]*anon/i);
    expect(gateSql).not.toMatch(/grant execute on function public\.list_casework_audit_events[^;]*to[^;]*service_role/i);

    const coordinatorStart = reader.indexOf("private.has_organization_role(a.organization_id, array['coordinator'])");
    const staffAccessStart = reader.indexOf("private.casework_staff_can_read(a.case_id)");
    expect(coordinatorStart).toBeGreaterThan(-1);
    expect(staffAccessStart).toBeGreaterThan(coordinatorStart);
    const coordinatorBranch = reader.slice(coordinatorStart, staffAccessStart);
    expect(coordinatorBranch).toContain("public.staff_can_see_user(c.user_id, 'coordinator')");
    expect(coordinatorBranch).toContain("private.member_case_visible_to_caller(a.case_id)");
    expect(coordinatorBranch).toMatch(/a\.case_id is null/i);

    // The table policy may delegate the parent-case check to member_cases RLS.
    // This reader may not: it is SECURITY DEFINER, so the policy's unqualified
    // EXISTS would be true for every case row that exists. It states the same
    // gate instead -- caller-aware chapter scope ANDed with the definer
    // restriction helper 20260917104000/20260917105000 installed.
    const policy = policySql.slice(
      policySql.indexOf("create policy casework_audit_events_staff_read"),
      policySql.indexOf(";", policySql.indexOf("create policy casework_audit_events_staff_read")),
    );
    const policyProbe = squash("or exists ( select 1 from public.member_cases c where c.id = casework_audit_events.case_id )");
    const delegatedProbe = squash("or exists ( select 1 from public.member_cases c where c.id = a.case_id )");
    expect(squash(policy)).toContain(policyProbe);
    expect(squash(reader)).not.toContain(delegatedProbe);
    expect(squash(reader)).toContain(squash(`exists (
      select 1
      from public.member_cases c
      where c.id = a.case_id
        and public.staff_can_see_user(c.user_id, 'coordinator')
    )
    and private.member_case_visible_to_caller(a.case_id)`));

    // The helper is the union of the three member_cases SELECT policies'
    // restriction branches, and this migration reuses it rather than
    // re-emitting it or any other definer object.
    // 20260925995000 (DEBT-UG-MEMBER-CASE-VISIBILITY-PREDICATE-SINGLE-SOURCE)
    // made the helper a by-id wrapper over the single row-typed predicate
    // private.member_case_row_visible; the branches live there now.
    const helperMigration = lastFnMigration("private.member_case_visible_to_caller(");
    const helper = fnBody(helperMigration.sql, "private.member_case_visible_to_caller(");
    expect(helper).toContain("security definer");
    expect(helper).toContain("set search_path = ''");
    expect(helper).toContain("private.member_case_row_visible(c)");
    const predicateMigration = lastFnMigration("private.member_case_row_visible(");
    const predicate = fnBody(predicateMigration.sql, "private.member_case_row_visible(");
    for (const branch of [
      "not p_case.is_restricted",
      "p_case.user_id = (select auth.uid())",
      "p_case.steward_user_id = (select auth.uid())",
      "p_case.coordinator_user_id = (select auth.uid())",
      "private.has_organization_role(p_case.organization_id, array['advisor','admin','vp'])",
      "private.casework_actor_has_active_grant(p_case.id)",
    ]) expect(predicate).toContain(branch);
    expect(gateSql).not.toMatch(/create or replace function private\./);
    expect(gateSql).not.toMatch(/create policy|drop policy/);
  });
});

const ID = {
  org: "50901900-0000-4000-8000-000000000001",
  orgB: "50901900-0000-4000-8000-000000000002",
  admin: "50901900-0000-4000-8000-000000000101",
  memberB: "50901900-0000-4000-8000-000000000102",
  session: "50901900-0000-4000-8000-000000000301",
  case: "50901900-0000-4000-8000-000000000401",
  caseB: "50901900-0000-4000-8000-000000000402",
  macro: "50901900-0000-4000-8000-000000000501",
  macroB: "50901900-0000-4000-8000-000000000502",
  coordinator: "50901900-0000-4000-8000-000000000103",
  memberA: "50901900-0000-4000-8000-000000000104",
  coordinatorSession: "50901900-0000-4000-8000-000000000302",
  restrictedCase: "50901900-0000-4000-8000-000000000403",
  grant: "50901900-0000-4000-8000-000000000601",
};
const CHAPTER = "audit-kinds-proof";
const CHAPTER_B = "audit-kinds-proof-b";
const READER_REGPROCEDURE = "public.list_casework_audit_events(integer, timestamp with time zone, bigint, text, timestamp with time zone, timestamp with time zone, uuid)";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("casework audit reader kind vocabulary on a disposable database", () => {
  let client;

  async function asAdmin(statement) {
    return asUser(ID.admin, ID.session, statement);
  }

  async function asUser(sub, sessionId, statement) {
    await client.query("savepoint audit_kinds_probe");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub,
        role: "authenticated",
        session_id: sessionId,
        aal: "aal2",
      })]);
      await client.query("set local role authenticated");
      const result = await client.query(statement);
      await client.query("reset role");
      await client.query("release savepoint audit_kinds_probe");
      return { code: "", rows: result.rows, message: "" };
    } catch (error) {
      await client.query("rollback to savepoint audit_kinds_probe");
      return { code: error.code || "?", message: error.message || "", rows: [] };
    }
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "casework-audit-reader-kinds-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '15s'");

    await client.query("insert into auth.users (id, email) values ($1, 'audit-kinds-admin@example.invalid')", [ID.admin]);
    await client.query(
      "insert into public.organizations (id, slug, name, created_by) values ($1, 'audit-kinds-proof', 'Audit kinds proof', $2)",
      [ID.org, ID.admin],
    );
    await client.query(
      "insert into public.chapters (id, name, slug, organization_id, is_default, order_index) values ($1, $1, $1, $2, false, 9919)",
      [CHAPTER, ID.org],
    );
    await client.query("insert into public.org_security_policy (id, organization_id, require_staff_mfa) values (true, $1, true)", [ID.org]);
    await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [ID.org, ID.admin]);
    await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [ID.admin, CHAPTER]);
    await client.query("update public.member_profiles set chapter_id = $2 where id = $1", [ID.admin, CHAPTER]);
    await client.query(
      "insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, 'admin', $2), ($1, $2, 'coordinator', $2)",
      [ID.org, ID.admin],
    );
    await client.query(
      "insert into auth.sessions (id, user_id, aal, created_at, updated_at) values ($1, $2, 'aal2', now(), now())",
      [ID.session, ID.admin],
    );
    await client.query(
      `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
       values (gen_random_uuid(), $1, 'audit-kinds-totp', 'totp', 'verified', now(), now())`,
      [ID.admin],
    );
    await client.query(
      "insert into public.member_cases (id, user_id, reference, title, case_type, step, status) values ($1, $2, 'AUDIT-KINDS-1', 'Audit kinds proof case', 'other', 'Intake', 'active')",
      [ID.case, ID.admin],
    );
    await client.query(
      `insert into public.casework_audit_events
         (organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata, created_at)
       values ($1, $2, null, $3, 'macro_saved', 'macro', $4, '{}'::jsonb, '2026-09-18T12:00:00Z')`,
      [ID.org, CHAPTER, ID.admin, ID.macro],
    );

    // Same admin is granted on a second organization that also has a
    // macro_saved row. Selected org stays ID.org via member_profiles.chapter_id.
    await client.query(
      "insert into public.organizations (id, slug, name, created_by) values ($1, 'audit-kinds-proof-b', 'Audit kinds proof B', $2)",
      [ID.orgB, ID.admin],
    );
    await client.query(
      "insert into public.chapters (id, name, slug, organization_id, is_default, order_index) values ($1, $1, $1, $2, false, 9920)",
      [CHAPTER_B, ID.orgB],
    );
    await client.query("insert into public.org_security_policy (id, organization_id, require_staff_mfa) values (true, $1, true)", [ID.orgB]);
    await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [ID.orgB, ID.admin]);
    await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [ID.admin, CHAPTER_B]);
    await client.query(
      "insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, 'admin', $2), ($1, $2, 'coordinator', $2)",
      [ID.orgB, ID.admin],
    );
    await client.query("insert into auth.users (id, email) values ($1, 'audit-kinds-member-b@example.invalid')", [ID.memberB]);
    await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [ID.orgB, ID.memberB]);
    await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [ID.memberB, CHAPTER_B]);
    await client.query("update public.member_profiles set chapter_id = $2 where id = $1", [ID.memberB, CHAPTER_B]);
    // Case org is derived from the owner's chapter. The same admin stewards
    // it so casework_staff_can_access still admits the row after the tenant
    // predicate is dropped; has_organization_role does not, because it is
    // selected-organization-bound.
    await client.query(
      `insert into public.member_cases
         (id, user_id, reference, title, case_type, step, status, steward_user_id)
       values ($1, $2, 'AUDIT-KINDS-B', 'Audit kinds proof case B', 'other', 'Intake', 'active', $3)`,
      [ID.caseB, ID.memberB, ID.admin],
    );
    await client.query(
      `insert into public.casework_audit_events
         (organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata, created_at)
       values ($1, $2, $3, $4, 'macro_saved', 'macro', $5, '{}'::jsonb, '2026-09-18T13:00:00Z')`,
      [ID.orgB, CHAPTER_B, ID.caseB, ID.admin, ID.macroB],
    );

    // Coordinator-only caller in ID.org, and a restricted case owned by a
    // member of the same chapter with one audit row.
    await client.query(
      "insert into auth.users (id, email) values ($1, 'audit-kinds-coordinator@example.invalid'), ($2, 'audit-kinds-member-a@example.invalid')",
      [ID.coordinator, ID.memberA],
    );
    for (const user of [ID.coordinator, ID.memberA]) {
      await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [ID.org, user]);
      await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [user, CHAPTER]);
      await client.query("update public.member_profiles set chapter_id = $2 where id = $1", [user, CHAPTER]);
    }
    await client.query(
      "insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, 'coordinator', $3)",
      [ID.org, ID.coordinator, ID.admin],
    );
    await client.query(
      "insert into auth.sessions (id, user_id, aal, created_at, updated_at) values ($1, $2, 'aal2', now(), now())",
      [ID.coordinatorSession, ID.coordinator],
    );
    await client.query(
      `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
       values (gen_random_uuid(), $1, 'audit-kinds-coordinator-totp', 'totp', 'verified', now(), now())`,
      [ID.coordinator],
    );
    await client.query(
      `insert into public.member_cases
         (id, user_id, reference, title, case_type, step, status, is_restricted, restriction_reason, restricted_at, restricted_by)
       values ($1, $2, 'AUDIT-KINDS-R', 'Audit kinds restricted case', 'other', 'Intake', 'active', true,
               'restricted for proof', now(), $3)`,
      [ID.restrictedCase, ID.memberA, ID.admin],
    );
    await client.query(
      `insert into public.casework_audit_events
         (organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata, created_at)
       values ($1, $2, $3, $4, 'note_added', 'case', $3, '{}'::jsonb, '2026-09-18T14:00:00Z')`,
      [ID.org, CHAPTER, ID.restrictedCase, ID.admin],
    );
  }, 30000);

  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end();
    }
  });

  it("accepts p_kind macro_saved and returns that CHECK member", async () => {
    const kinds = await client.query("select private.casework_audit_event_kinds() as kinds");
    for (const kind of FIVE) {
      expect(kinds.rows[0].kinds, kind).toContain(kind);
    }

    const result = await asAdmin("select public.list_casework_audit_events(p_kind => 'macro_saved') as page");
    expect(result.code, result.message).toBe("");
    expect(result.rows[0].page).toHaveLength(1);
    expect(result.rows[0].page.map((row) => row.kind)).toEqual(["macro_saved"]);
    expect(result.rows[0].page[0]).toMatchObject({
      source: "casework_audit_events",
      organizationId: ID.org,
      kind: "macro_saved",
      entityId: ID.macro,
    });
  });

  it("keeps a one-row page across two granted organizations; a tenant-unbound scratch copy returns both", async () => {
    const page = await asAdmin("select public.list_casework_audit_events(p_kind => 'macro_saved') as page");
    expect(page.code, page.message).toBe("");
    expect(page.rows[0].page).toHaveLength(1);
    expect(page.rows[0].page[0].organizationId).toBe(ID.org);

    const original = (await client.query(
      "select pg_get_functiondef($1::regprocedure) as def",
      [READER_REGPROCEDURE],
    )).rows[0].def;
    const mutant = original.replace(/a\.organization_id = org\s+and\s+/, "");
    expect(mutant, "scratch copy must drop the tenant bound").not.toBe(original);
    try {
      await client.query(mutant);
      const leaked = await asAdmin("select public.list_casework_audit_events(p_kind => 'macro_saved') as page");
      expect(leaked.code, leaked.message).toBe("");
      expect(leaked.rows[0].page).toHaveLength(2);
      expect(leaked.rows[0].page.map((row) => row.organizationId).sort()).toEqual([ID.org, ID.orgB].sort());
    } finally {
      await client.query(original);
    }

    const restored = await asAdmin("select public.list_casework_audit_events(p_kind => 'macro_saved') as page");
    expect(restored.code, restored.message).toBe("");
    expect(restored.rows[0].page).toHaveLength(1);
    expect(restored.rows[0].page[0].organizationId).toBe(ID.org);
    const md5 = (await client.query(
      "select md5(pg_get_functiondef($1::regprocedure)) as body",
      [READER_REGPROCEDURE],
    )).rows[0].body;
    expect(md5).toBe("dd460c3b5189465a459da7b4be5c5a26");
  });

  it("hides a restricted case's audit row from a coordinator until granted, matching the table policy", async () => {
    async function coordinatorSees() {
      const rpc = await asUser(
        ID.coordinator,
        ID.coordinatorSession,
        `select public.list_casework_audit_events(p_case_id => '${ID.restrictedCase}') as page`,
      );
      expect(rpc.code, rpc.message).toBe("");
      const table = await asUser(
        ID.coordinator,
        ID.coordinatorSession,
        `select count(*)::int as n from public.casework_audit_events where case_id = '${ID.restrictedCase}'`,
      );
      expect(table.code, table.message).toBe("");
      return { rpc: rpc.rows[0].page.length, table: table.rows[0].n };
    }

    expect(await coordinatorSees()).toEqual({ rpc: 0, table: 0 });

    await client.query(
      `insert into public.casework_access_grants (id, case_id, organization_id, chapter_id, grantee_user_id, granted_by, reason)
       values ($1, $2, $3, $4, $5, $6, 'audit reader proof grant')`,
      [ID.grant, ID.restrictedCase, ID.org, CHAPTER, ID.coordinator, ID.admin],
    );
    expect(await coordinatorSees()).toEqual({ rpc: 1, table: 1 });

    await client.query(
      "update public.casework_access_grants set revoked_at = now(), revoked_by = $2 where id = $1",
      [ID.grant, ID.admin],
    );
    expect(await coordinatorSees()).toEqual({ rpc: 0, table: 0 });

    // The admin caller keeps the unconditional organization-role branch.
    const admin = await asAdmin(`select public.list_casework_audit_events(p_case_id => '${ID.restrictedCase}') as page`);
    expect(admin.code, admin.message).toBe("");
    expect(admin.rows[0].page).toHaveLength(1);
  });

  it("still raises 22023 for a kind the CHECK does not admit", async () => {
    const result = await asAdmin("select public.list_casework_audit_events(p_kind => 'invite_sent') as page");
    expect(result.code).toBe("22023");
    expect(result.message).toMatch(/unknown casework audit event kind/i);
  });
});
