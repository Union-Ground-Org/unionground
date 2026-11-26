// @vitest-environment node
//
// REQ-UG-DORMANT-68-AUDIT-SINKS-SURFACED-20260917
//
// Five audit tables were written by SQL and read by nothing:
//   public.coordinator_case_audit                        (20260810200000)
//   public.member_invitation_audit                       (20260812105000)
//   public.organization_automation_definition_reviews    (20260911070000)
//   public.member_case_assignment_audit                  (20260810210000)
//   public.casework_audit_events                         (20260828210000)
//
// The static half pins the migration's SECURITY DEFINER / empty search_path /
// PUBLIC-revoked / exact-role-grant shape and the fact that no reader returns a
// row image, free text, or unbounded jsonb. The live half runs on a DISPOSABLE
// loopback stack only (assertDisposableProofUrl refuses anything else) and
// proves the RLS scoping: an organization's staff sees its own evidence and
// never another organization's, a member sees none of it, and a policy-less
// sink refuses a caller without its writer's role.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "dormant_audit_sinks_read_rpcs";
const sql = stripComments(loadMigrationSql(MIGRATION));

const READERS = [
  {
    rpc: "list_coordinator_case_audit",
    signature: "integer, timestamptz, bigint, text, timestamptz, timestamptz, uuid",
    table: "coordinator_case_audit",
  },
  {
    rpc: "list_member_invitation_audit",
    signature: "integer, timestamptz, uuid, text, timestamptz, timestamptz, text",
    table: "member_invitation_audit",
  },
  {
    rpc: "list_organization_automation_definition_reviews",
    signature: "integer, timestamptz, uuid, text, timestamptz, timestamptz, uuid",
    table: "organization_automation_definition_reviews",
  },
  {
    rpc: "list_member_case_assignment_audit",
    signature: "integer, timestamptz, bigint, text, timestamptz, timestamptz, uuid",
    table: "member_case_assignment_audit",
  },
  {
    rpc: "list_casework_audit_events",
    signature: "integer, timestamptz, bigint, text, timestamptz, timestamptz, uuid",
    table: "casework_audit_events",
  },
];

describe("dormant audit sink readers (static)", () => {
  it("sorts after the pg_net tick request-id migration it was written against and adds one reader per sink", () => {
    expect(findMigrationName(MIGRATION) > "20260915180000_pg_net_tick_request_id_idempotency.sql").toBe(true);
    for (const { rpc, table } of READERS) {
      expect(sql, rpc).toContain(`create or replace function public.${rpc}(`);
      expect(sql, table).toContain(`from public.${table} a`);
    }
  });

  it("keeps every reader a definer with an empty search_path and a session-derived organization", () => {
    for (const { rpc } of READERS) {
      const body = sql.slice(sql.indexOf(`create or replace function public.${rpc}(`));
      const declaration = body.slice(0, body.indexOf("$function$;") + "$function$;".length);
      expect(declaration, rpc).toContain("security definer");
      expect(declaration, rpc).toContain("set search_path = ''");
      expect(declaration, rpc).toContain("stable");
      expect(declaration, rpc).toContain("private.mi1_require_selected_organization()");
      // A tenant key is never an argument, so it can never be a wildcard.
      expect(declaration, rpc).not.toMatch(/p_organization_id/);
      expect(declaration, rpc).toContain("private.audit_sink_read_bounds(");
    }
  });

  it("revokes PUBLIC, anon and service_role and grants execute to authenticated only", () => {
    for (const { rpc, signature } of READERS) {
      expect(sql, rpc).toContain(
        `revoke all on function public.${rpc}(${signature})\n  from public, anon, authenticated, service_role;`,
      );
      expect(sql, rpc).toContain(`grant execute on function public.${rpc}(${signature})\n  to authenticated;`);
    }
    expect(sql).toContain(
      "revoke all on function private.audit_sink_read_bounds(integer, timestamptz, boolean, timestamptz, timestamptz)\n  from public, anon, authenticated, service_role;",
    );
    expect(sql).not.toMatch(/grant execute on function private\.audit_sink_read_bounds/);
  });

  it("returns authorized record links and never a row image, free text, or unbounded jsonb", () => {
    for (const leak of [
      "before_value", "after_value", "a.reason", "a.detail", "a.note",
      "a.metadata", "actor_name", "before_assignment'", "after_assignment'",
    ]) {
      expect(sql, leak).not.toContain(`'${leak}`);
    }
    expect(sql).not.toMatch(/'reason',|'note',|'detail',|'metadata',|'actorName',/);
    // The one place an assignment image is read is the derived kind, which
    // yields a token rather than the image itself.
    expect(sql).toContain("a.after_assignment->>'stewardUserId'");
    expect(sql).toContain("'kind', derived.kind");
  });

  it("gates the two older case sinks on exactly their table policy, not the wider casework helper", () => {
    for (const rpc of ["list_coordinator_case_audit", "list_member_case_assignment_audit"]) {
      const body = sql.slice(sql.indexOf(`create or replace function public.${rpc}(`));
      const declaration = body.slice(0, body.indexOf("$function$;") + "$function$;".length);
      // coordinator_case_audit_select_coordinator and
      // member_case_assignment_audit_select_coordinator admit only
      // staff_can_see_user(<member>, 'coordinator'); a reader that also admitted
      // private.casework_staff_can_access would show the case steward and
      // non-coordinator organization staff rows the table itself refuses them.
      expect(declaration, rpc).toContain("public.staff_can_see_user(");
      expect(declaration, rpc).not.toContain("private.casework_staff_can_access(");
    }
    const events = sql.slice(sql.indexOf("create or replace function public.list_casework_audit_events("));
    expect(events.slice(0, events.indexOf("$function$;"))).toContain("private.casework_staff_can_access(a.case_id)");
  });

  it("pages on a (created_at, id) keyset rather than an offset", () => {
    expect(sql).not.toMatch(/\boffset\b/i);
    expect(sql.split("(a.created_at, a.id) < (p_before, p_before_id)")).toHaveLength(READERS.length + 1);
    expect(sql.split("order by a.created_at desc, a.id desc")).toHaveLength(READERS.length + 1);
    expect(sql).toContain("greatest(1, least(coalesce(p_limit, 50), 200))");
  });
});

const ID = {
  orgA: "50906800-0000-4000-8000-000000000001",
  orgB: "50906800-0000-4000-8000-000000000002",
  staffA: "50906800-0000-4000-8000-000000000101",
  memberA: "50906800-0000-4000-8000-000000000102",
  staffB: "50906800-0000-4000-8000-000000000201",
  memberB: "50906800-0000-4000-8000-000000000202",
  sessionStaffA: "50906800-0000-4000-8000-000000000301",
  sessionMemberA: "50906800-0000-4000-8000-000000000302",
  sessionStaffB: "50906800-0000-4000-8000-000000000303",
  sessionMemberB: "50906800-0000-4000-8000-000000000304",
  adminOnlyA: "50906800-0000-4000-8000-000000000103",
  stewardOnlyA: "50906800-0000-4000-8000-000000000104",
  sessionAdminOnlyA: "50906800-0000-4000-8000-000000000305",
  sessionStewardOnlyA: "50906800-0000-4000-8000-000000000306",
  caseA: "50906800-0000-4000-8000-000000000401",
  caseB: "50906800-0000-4000-8000-000000000402",
  invitationA: "50906800-0000-4000-8000-000000000501",
  invitationB: "50906800-0000-4000-8000-000000000502",
  definitionA: "50906800-0000-4000-8000-000000000601",
  definitionB: "50906800-0000-4000-8000-000000000602",
  entityA: "50906800-0000-4000-8000-000000000701",
  entityB: "50906800-0000-4000-8000-000000000702",
};

const SESSION_FOR = {
  [ID.staffA]: ID.sessionStaffA,
  [ID.memberA]: ID.sessionMemberA,
  [ID.staffB]: ID.sessionStaffB,
  [ID.memberB]: ID.sessionMemberB,
  [ID.adminOnlyA]: ID.sessionAdminOnlyA,
  [ID.stewardOnlyA]: ID.sessionStewardOnlyA,
};

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("dormant audit sink readers (RLS scoping on a disposable database)", () => {
  let client;

  async function callAs(userId, statement, values = []) {
    await client.query("savepoint audit_sink_probe");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: userId,
        role: "authenticated",
        session_id: SESSION_FOR[userId],
        aal: "aal2",
      })]);
      await client.query("set local role authenticated");
      const result = await client.query(statement, values);
      await client.query("reset role");
      await client.query("rollback to savepoint audit_sink_probe");
      return { code: "", rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint audit_sink_probe");
      return { code: error.code || "?", message: error.message || "", rows: [] };
    }
  }

  async function read(userId, rpc, args = "") {
    const result = await callAs(userId, `select public.${rpc}(${args}) as page`);
    return { ...result, page: result.rows[0]?.page ?? null };
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "audit-sinks-surfaced-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");

    await client.query(
      `insert into auth.users (id, email) values
        ($1, 'sink-staff-a@example.test'), ($2, 'sink-member-a@example.test'),
        ($3, 'sink-staff-b@example.test'), ($4, 'sink-member-b@example.test')`,
      [ID.staffA, ID.memberA, ID.staffB, ID.memberB],
    );
    await client.query(
      `insert into public.organizations (id, slug, name, created_by) values
        ($1, 'sink-org-a', 'Sink Org A', $3), ($2, 'sink-org-b', 'Sink Org B', $4)`,
      [ID.orgA, ID.orgB, ID.staffA, ID.staffB],
    );
    // Transaction-only Tamarack chapters replace the retired legacy IDs. Product
    // setup uses the bootstrap RPCs; nothing here is committed.
    await client.query("set local session_replication_role = replica");
    await client.query("insert into public.chapters (id,name,slug,order_index,organization_id) values ('tamarack-audit-sinks-surfaced-a','Tamarack audit-sinks-surfaced A','tamarack-audit-sinks-surfaced-a',901,$1)", [ID.orgA]);
    await client.query("insert into public.chapters (id,name,slug,order_index,organization_id) values ('tamarack-audit-sinks-surfaced-b','Tamarack audit-sinks-surfaced B','tamarack-audit-sinks-surfaced-b',901,$1)", [ID.orgB]);
    await client.query("insert into public.chapter_workstreams(chapter_id,name) values ('tamarack-audit-sinks-surfaced-a','General'), ('tamarack-audit-sinks-surfaced-b','General') on conflict(chapter_id,name) do nothing");
    await client.query("set local session_replication_role = origin");
    await client.query(
      `update public.member_profiles set chapter_id = fixture.chapter_id
       from (values ($1::uuid, 'tamarack-audit-sinks-surfaced-a'::text), ($2::uuid, 'tamarack-audit-sinks-surfaced-a'::text),
                    ($3::uuid, 'tamarack-audit-sinks-surfaced-b'::text), ($4::uuid, 'tamarack-audit-sinks-surfaced-b'::text)) fixture(id, chapter_id)
       where member_profiles.id = fixture.id`,
      [ID.staffA, ID.memberA, ID.staffB, ID.memberB],
    );
    await client.query(
      `insert into public.member_chapter_memberships (user_id, chapter_id, status, pinned, last_selected_at)
       values ($1,'tamarack-audit-sinks-surfaced-a','active',true,now()), ($2,'tamarack-audit-sinks-surfaced-a','active',true,now()),
              ($3,'tamarack-audit-sinks-surfaced-b','active',true,now()), ($4,'tamarack-audit-sinks-surfaced-b','active',true,now())
       on conflict (user_id, chapter_id) do update set status = 'active', revoked_at = null, last_selected_at = now()`,
      [ID.staffA, ID.memberA, ID.staffB, ID.memberB],
    );
    await client.query(
      `insert into public.organization_memberships (organization_id, user_id)
       values ($1,$3),($1,$4),($2,$5),($2,$6)`,
      [ID.orgA, ID.orgB, ID.staffA, ID.memberA, ID.staffB, ID.memberB],
    );
    await client.query(
      `insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
       values ($1,$3,'admin',$3),($1,$3,'coordinator',$3),($1,$3,'vp',$3),
              ($2,$4,'admin',$4),($2,$4,'coordinator',$4),($2,$4,'vp',$4)`,
      [ID.orgA, ID.orgB, ID.staffA, ID.staffB],
    );
    await client.query(
      `insert into auth.sessions (id, user_id, aal, created_at, updated_at) values
        ($1,$2,'aal2',now(),now()), ($3,$4,'aal2',now(),now()),
        ($5,$6,'aal2',now(),now()), ($7,$8,'aal2',now(),now())`,
      [ID.sessionStaffA, ID.staffA, ID.sessionMemberA, ID.memberA,
       ID.sessionStaffB, ID.staffB, ID.sessionMemberB, ID.memberB],
    );
    await client.query(
      `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
       values (gen_random_uuid(), $1, 'sink-a-totp', 'totp', 'verified', now(), now()),
              (gen_random_uuid(), $2, 'sink-b-totp', 'totp', 'verified', now(), now()),
              (gen_random_uuid(), $3, 'sink-ma-totp', 'totp', 'verified', now(), now()),
              (gen_random_uuid(), $4, 'sink-mb-totp', 'totp', 'verified', now(), now())`,
      [ID.staffA, ID.staffB, ID.memberA, ID.memberB],
    );

    await client.query(
      `insert into public.member_cases
         (id, user_id, reference, title, case_type, articles, step, status, organization_id, chapter_id)
       values ($1,$2,'SINK-A-1','Sink case A','grievance','Article 5','step_1','active',$3,'tamarack-audit-sinks-surfaced-a'),
              ($4,$5,'SINK-B-1','Sink case B','grievance','Article 5','step_1','active',$6,'tamarack-audit-sinks-surfaced-b')`,
      [ID.caseA, ID.memberA, ID.orgA, ID.caseB, ID.memberB, ID.orgB],
    );

    await client.query(
      `insert into public.coordinator_case_audit
         (case_id, user_id, actor_id, action, before_value, after_value, reason, created_at)
       values ($1,$2,$3,'note_added','{}'::jsonb,'{"secret":"note body"}'::jsonb,'private reason','2026-09-01T08:00:00Z'),
              ($1,$2,$3,'contact_logged',null,'{"secret":"contact summary body"}'::jsonb,null,'2026-09-03T08:00:00Z'),
              ($4,$5,$6,'note_added',null,'{"secret":"other org"}'::jsonb,null,'2026-09-02T08:00:00Z')`,
      [ID.caseA, ID.memberA, ID.staffA, ID.caseB, ID.memberB, ID.staffB],
    );
    await client.query(
      `insert into public.member_case_assignment_audit
         (case_id, actor_id, actor_name, before_assignment, after_assignment, created_at)
       values ($1,$2,'Private Name','{"stewardUserId":null,"coordinatorUserId":null}'::jsonb,
               '{"stewardUserId":"50906800-0000-4000-8000-000000000101","coordinatorUserId":null}'::jsonb,
               '2026-09-01T09:00:00Z'),
              ($1,$2,'Private Name','{"stewardUserId":"50906800-0000-4000-8000-000000000101","coordinatorUserId":null}'::jsonb,
               '{"stewardUserId":null,"coordinatorUserId":null}'::jsonb,
               '2026-09-04T09:00:00Z'),
              ($3,$4,'Other Name','{"stewardUserId":null,"coordinatorUserId":null}'::jsonb,
               '{"stewardUserId":"50906800-0000-4000-8000-000000000201","coordinatorUserId":null}'::jsonb,
               '2026-09-02T09:00:00Z')`,
      [ID.caseA, ID.staffA, ID.caseB, ID.staffB],
    );
    await client.query(
      `insert into public.casework_audit_events
         (organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata, created_at)
       values ($1,'tamarack-audit-sinks-surfaced-a',$2,$3,'alert_created','alert',$4,'{"secret":"alert payload"}'::jsonb,'2026-09-01T10:00:00Z'),
              ($1,'tamarack-audit-sinks-surfaced-a',$2,$3,'draft_saved','draft',$4,'{}'::jsonb,'2026-09-05T10:00:00Z'),
              ($5,'tamarack-audit-sinks-surfaced-b',$6,$7,'alert_created','alert',$8,'{}'::jsonb,'2026-09-02T10:00:00Z')`,
      [ID.orgA, ID.caseA, ID.staffA, ID.entityA, ID.orgB, ID.caseB, ID.staffB, ID.entityB],
    );
    await client.query(
      `insert into public.member_invitations
         (id, normalized_email, full_name, first_name, initials, chapter_id, locale, status, token_hash, expires_at, invited_by)
       values ($1,'sink-invite-a@example.test','Sink Invite A','Sink','SA','tamarack-audit-sinks-surfaced-a','en','pending',repeat('1',64),now() + interval '7 days',$3),
              ($2,'sink-invite-b@example.test','Sink Invite B','Sink','SB','tamarack-audit-sinks-surfaced-b','en','pending',repeat('2',64),now() + interval '7 days',$4)`,
      [ID.invitationA, ID.invitationB, ID.staffA, ID.staffB],
    );
    await client.query(
      `insert into public.member_invitation_audit (invitation_id, chapter_id, actor, action, detail, created_at)
       values ($1,'tamarack-audit-sinks-surfaced-a',$3,'invite_requested','{"secret":"invite detail"}'::jsonb,'2026-09-01T11:00:00Z'),
              ($1,'tamarack-audit-sinks-surfaced-a',$3,'invite_revoked','{}'::jsonb,'2026-09-06T11:00:00Z'),
              ($2,'tamarack-audit-sinks-surfaced-b',$4,'invite_requested','{}'::jsonb,'2026-09-02T11:00:00Z')`,
      [ID.invitationA, ID.invitationB, ID.staffA, ID.staffB],
    );
    await client.query(
      `insert into public.organization_automation_definition_reviews
         (organization_id, definition_id, definition_version, action, actor_id, note, snapshot_digest, created_at)
       values ($1,$2,1,'submitted',$3,'private review note',repeat('a',64),'2026-09-01T12:00:00Z'),
              ($1,$2,2,'approved',$3,null,repeat('b',64),'2026-09-07T12:00:00Z'),
              ($4,$5,1,'submitted',$6,null,repeat('c',64),'2026-09-02T12:00:00Z')`,
      [ID.orgA, ID.definitionA, ID.staffA, ID.orgB, ID.definitionB, ID.staffB],
    );
  }, 180_000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback");
    await client.end();
  });

  it("returns only the caller's own organization for every sink", async () => {
    for (const { rpc } of READERS) {
      const a = await read(ID.staffA, rpc);
      expect(a.code, `${rpc}: ${a.message}`).toBe("");
      expect(a.page.length, rpc).toBe(2);
      expect(a.page.every((row) => row.organizationId === ID.orgA), rpc).toBe(true);

      const b = await read(ID.staffB, rpc);
      expect(b.code, `${rpc}: ${b.message}`).toBe("");
      expect(b.page.length, rpc).toBe(1);
      expect(b.page.every((row) => row.organizationId === ID.orgB), rpc).toBe(true);
    }
  });

  it("carries authorized record links only — no row image, free text, or bounded payload", async () => {
    for (const { rpc } of READERS) {
      const page = (await read(ID.staffA, rpc)).page;
      const serialized = JSON.stringify(page);
      for (const secret of [
        "note body", "private reason", "contact summary body", "alert payload",
        "invite detail", "private review note", "Private Name", "secret",
      ]) {
        expect(serialized, `${rpc} leaked ${secret}`).not.toContain(secret);
      }
      for (const row of page) {
        expect(Object.keys(row).sort(), rpc).toEqual(expect.arrayContaining([
          "actorUserId", "createdAt", "id", "kind", "organizationId", "source",
        ]));
        expect(row, rpc).not.toHaveProperty("metadata");
        expect(row, rpc).not.toHaveProperty("detail");
        expect(row, rpc).not.toHaveProperty("note");
      }
    }
  });

  it("refuses the two policy-less sinks for a caller without the writer's role", async () => {
    const invitations = await read(ID.memberA, "list_member_invitation_audit");
    expect(invitations.code).toBe("42501");
    expect(invitations.message).toMatch(/organization admin role required/);

    const reviews = await read(ID.memberA, "list_organization_automation_definition_reviews");
    expect(reviews.code).toBe("42501");
    expect(reviews.message).toMatch(/automation approver role required/);
  });

  it("shows the two older case sinks to no one their table policy refuses", async () => {
    // Org A staff who are NOT coordinators: an admin-only officer and the
    // steward assigned to case A. The tables' SELECT policies admit only
    // staff_can_see_user(<member>, 'coordinator'), so both must read an empty
    // page from the readers exactly as they read zero rows from the tables.
    await client.query(
      `insert into auth.users (id, email) values ($1, 'sink-admin-only-a@example.test'), ($2, 'sink-steward-only-a@example.test')`,
      [ID.adminOnlyA, ID.stewardOnlyA],
    );
    await client.query(
      "update public.member_profiles set chapter_id = 'tamarack-audit-sinks-surfaced-a' where id = any($1::uuid[])",
      [[ID.adminOnlyA, ID.stewardOnlyA]],
    );
    await client.query(
      `insert into public.member_chapter_memberships (user_id, chapter_id, status, pinned, last_selected_at)
       values ($1,'tamarack-audit-sinks-surfaced-a','active',true,now()), ($2,'tamarack-audit-sinks-surfaced-a','active',true,now())
       on conflict (user_id, chapter_id) do update set status = 'active', revoked_at = null, last_selected_at = now()`,
      [ID.adminOnlyA, ID.stewardOnlyA],
    );
    await client.query(
      "insert into public.organization_memberships (organization_id, user_id) values ($1,$2),($1,$3)",
      [ID.orgA, ID.adminOnlyA, ID.stewardOnlyA],
    );
    await client.query(
      `insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
       values ($1,$2,'admin',$2),($1,$3,'steward',$2)`,
      [ID.orgA, ID.adminOnlyA, ID.stewardOnlyA],
    );
    await client.query(
      `insert into auth.sessions (id, user_id, aal, created_at, updated_at)
       values ($1,$2,'aal2',now(),now()), ($3,$4,'aal2',now(),now())`,
      [ID.sessionAdminOnlyA, ID.adminOnlyA, ID.sessionStewardOnlyA, ID.stewardOnlyA],
    );
    await client.query(
      `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
       values (gen_random_uuid(), $1, 'sink-ao-totp', 'totp', 'verified', now(), now()),
              (gen_random_uuid(), $2, 'sink-so-totp', 'totp', 'verified', now(), now())`,
      [ID.adminOnlyA, ID.stewardOnlyA],
    );
    await client.query("update public.member_cases set steward_user_id = $1 where id = $2", [ID.stewardOnlyA, ID.caseA]);

    for (const userId of [ID.adminOnlyA, ID.stewardOnlyA]) {
      for (const [rpc, table] of [
        ["list_coordinator_case_audit", "coordinator_case_audit"],
        ["list_member_case_assignment_audit", "member_case_assignment_audit"],
      ]) {
        const viaTable = await callAs(userId, `select count(*)::int as n from public.${table}`);
        expect(viaTable.code, `${table}: ${viaTable.message}`).toBe("");
        expect(viaTable.rows[0].n, `${table} via RLS`).toBe(0);
        const viaReader = await read(userId, rpc);
        expect(viaReader.code, `${rpc}: ${viaReader.message}`).toBe("");
        expect(viaReader.page, `${rpc} must not exceed the table policy`).toEqual([]);
      }
    }
    // The coordinator still reads both sinks, so the narrowing cost nothing.
    expect((await read(ID.staffA, "list_coordinator_case_audit")).page).toHaveLength(2);
    expect((await read(ID.staffA, "list_member_case_assignment_audit")).page).toHaveLength(2);
  });

  it("returns an empty page rather than another member's casework evidence", async () => {
    for (const rpc of [
      "list_coordinator_case_audit",
      "list_member_case_assignment_audit",
      "list_casework_audit_events",
    ]) {
      const page = await read(ID.memberA, rpc);
      expect(page.code, `${rpc}: ${page.message}`).toBe("");
      expect(page.page, rpc).toEqual([]);
    }
  });

  it("filters by kind, by date range, and by case", async () => {
    const byKind = await read(ID.staffA, "list_casework_audit_events", "p_kind => 'draft_saved'");
    expect(byKind.page.map((row) => row.kind)).toEqual(["draft_saved"]);

    const byRange = await read(
      ID.staffA,
      "list_coordinator_case_audit",
      "p_since => '2026-09-02T00:00:00Z', p_until => '2026-09-04T00:00:00Z'",
    );
    expect(byRange.page.map((row) => row.kind)).toEqual(["contact_logged"]);

    const byCase = await read(
      ID.staffA,
      "list_member_case_assignment_audit",
      `p_case_id => '${ID.caseB}'`,
    );
    expect(byCase.page).toEqual([]);

    const derived = await read(ID.staffA, "list_member_case_assignment_audit");
    expect(derived.page.map((row) => row.kind)).toEqual(["unassigned", "assigned"]);

    const byDerivedKind = await read(ID.staffA, "list_member_case_assignment_audit", "p_kind => 'assigned'");
    expect(byDerivedKind.page.map((row) => row.kind)).toEqual(["assigned"]);
  });

  it("pages newest-first on the keyset cursor without repeating or skipping a row", async () => {
    const first = await read(ID.staffA, "list_member_invitation_audit", "p_limit => 1");
    expect(first.page).toHaveLength(1);
    expect(first.page[0].kind).toBe("invite_revoked");
    const next = await read(
      ID.staffA,
      "list_member_invitation_audit",
      `p_limit => 1, p_before => '${first.page[0].createdAt}', p_before_id => '${first.page[0].id}'`,
    );
    expect(next.page).toHaveLength(1);
    expect(next.page[0].kind).toBe("invite_requested");
    expect(next.page[0].id).not.toBe(first.page[0].id);
  });

  it("clamps the page size and refuses a bad kind, an inverted range, and a half cursor", async () => {
    const clamped = await read(ID.staffA, "list_casework_audit_events", "p_limit => 0");
    expect(clamped.page).toHaveLength(1);

    const badKind = await read(ID.staffA, "list_casework_audit_events", "p_kind => 'invite_sent'");
    expect(badKind.code).toBe("22023");

    const inverted = await read(
      ID.staffA,
      "list_casework_audit_events",
      "p_since => '2026-09-09T00:00:00Z', p_until => '2026-09-01T00:00:00Z'",
    );
    expect(inverted.code).toBe("22023");

    const half = await read(ID.staffA, "list_casework_audit_events", "p_before => '2026-09-09T00:00:00Z'");
    expect(half.code).toBe("22023");
    expect(half.message).toMatch(/cursor requires both/);
  });

  it("refuses an unauthenticated and an anon caller outright", async () => {
    for (const { rpc } of READERS) {
      await client.query("savepoint anon_probe");
      let code = "";
      try {
        await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
        await client.query("set local role anon");
        await client.query(`select public.${rpc}()`);
        await client.query("reset role");
      } catch (error) {
        code = error.code;
      }
      await client.query("rollback to savepoint anon_probe");
      expect(code, rpc).toBe("42501");
    }
  });
});
