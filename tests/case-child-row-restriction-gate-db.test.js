// @vitest-environment node
//
// SEC-UG-COORDINATOR-CASE-POLICIES-AUTHOR-ONLY-20260917
//
// public.member_cases.is_restricted hides a case row from an in-scope
// coordinator who holds no casework_access_grants row (20260828210000 +
// 20260829001850). Its child rows never gained that gate, so the notes, the
// contacts, the outcome, both audit trails, the attachment metadata and the
// attachment bytes of a hidden case stayed readable one table across.
// 20260917103000 repairs all seven read paths.
//
// The offline half pins the migration text and the db-contract needles so the
// suite still guards the SQL without a database. The live half is the part
// that matters: a policy predicate is only ever proved by evaluating it, and
// the failure being repaired is precisely one that reads correct in isolation.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const sql = stripComments(loadMigrationSql("case_child_row_restriction_gate"));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const flat = squash(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("case child-row restriction gate migration", () => {
  it("sorts after the pg_net tick request-id migration it was written against and takes a bounded lock", () => {
    expect(findMigrationName("case_child_row_restriction_gate")
      > "20260915180000_pg_net_tick_request_id_idempotency.sql").toBe(true);
    expect(sql).toContain("set local lock_timeout = '5s';");
  });

  it("makes the coordinator's note read require the parent case row", () => {
    expect(flat).toContain(
      "create policy member_case_updates_select_coordinator on public.member_case_updates"
      + " for select to authenticated using ( public.staff_can_see_user(user_id, 'coordinator')"
      + " and exists ( select 1 from public.member_cases c where c.id = member_case_updates.case_id ) );",
    );
    // The scope conjunct is load-bearing in the other direction: the EXISTS
    // alone is also true for the member who owns the case, which would newly
    // expose every staff-authored note on it to them.
    expect(flat).toContain("public.staff_can_see_user(user_id, 'coordinator') and exists");
  });

  it("makes the coordinator's attachment read require the parent case row without touching the owner branch", () => {
    expect(flat).toContain(
      "member_case_files.user_id = (select auth.uid()) or ( public.staff_can_see_user(member_case_files.user_id, 'coordinator')"
      + " and exists ( select 1 from public.member_cases c where c.id = member_case_files.case_id ) )",
    );
    // The two-phase upload guards from 20260905005500 survive the re-emission.
    expect(flat).toContain("member_case_files.confirmed_at is not null");
    expect(flat).toContain("member_case_files.removal_requested_at is null");
  });

  it("states the gate for the definer Storage predicate, which is exempt from RLS", () => {
    expect(flat).toContain("create or replace function private.member_case_restriction_cleared(p_case_id uuid)");
    expect(flat).toContain("security definer set search_path = ''");
    for (const branch of [
      "not c.is_restricted",
      "c.user_id = (select auth.uid())",
      "c.steward_user_id = (select auth.uid())",
      "c.coordinator_user_id = (select auth.uid())",
      "private.has_organization_role(c.organization_id, array['advisor','admin','vp'])",
      "private.casework_actor_has_active_grant(c.id)",
    ]) expect(flat).toContain(branch);
    expect(flat).toContain("private.member_case_restriction_cleared(f.case_id)");
    // No client role may reach it; its only caller is a definer function.
    expect(flat).toContain(
      "revoke all on function private.member_case_restriction_cleared(uuid) from public, anon, authenticated, service_role;",
    );
    expect(flat).not.toContain("grant execute on function private.member_case_restriction_cleared");
  });

  it("puts the sibling owner-column policies behind the same parent-visibility gate", () => {
    for (const [policy, table] of [
      ["coordinator_case_audit_select_coordinator", "coordinator_case_audit"],
      ["member_case_contacts_select_coordinator", "member_case_contacts"],
      ["member_case_outcomes_select_coordinator", "member_case_outcomes"],
    ]) {
      expect(flat).toContain(
        `create policy ${policy} on public.${table} for select to authenticated using ( `
        + "public.staff_can_see_user(user_id, 'coordinator') and exists ( select 1 from public.member_cases c "
        + `where c.id = ${table}.case_id ) );`,
      );
    }
    // member_case_assignment_audit already resolves its case under RLS and is
    // not in this repair; naming it here would be a silent scope change.
    expect(flat).not.toContain("member_case_assignment_audit_select_coordinator");
  });

  it("splits only the plain organization-coordinator branch of the casework audit read", () => {
    expect(flat).toContain("private.has_organization_role(organization_id, array['advisor','admin','vp'])");
    expect(flat).toContain("private.has_organization_role(organization_id, array['coordinator'])");
    expect(flat).toContain("case_id is null or exists ( select 1 from public.member_cases c where c.id = casework_audit_events.case_id )");
    // The four-role array is exactly the leak; it must not survive anywhere.
    expect(flat).not.toContain("array['coordinator','advisor','admin','vp']");
    // The gated branch and both retained-case paths are preserved verbatim.
    expect(flat).toContain("(case_id is not null and private.casework_staff_can_access(case_id))");
    expect(flat).toContain("(case_id is null and private.account_lifecycle_retained_case_scope_allows('casework_audit', id::text, chapter_id))");
  });

  it("pins the repaired shapes in the database contract", () => {
    // Since 20261028210000 the coordinator read was one OR branch of the
    // merged member_case_updates_select policy; since 20261106226000 (#7360)
    // the policy is only the readable-parent EXISTS, which that branch already
    // implied. The whole qual, not a needle list: a branch that admits a note
    // without its readable parent case would restore the leak.
    const notes = contract.policies.find((entry) => (
      entry.table === "member_case_updates" && entry.name === "member_case_updates_select"
    ));
    expect(squash(notes.qual)).toBe(squash(
      "(EXISTS ( SELECT 1 FROM member_cases c"
      + " WHERE ((c.id = member_case_updates.case_id) AND private.chapter_case_readable(c.*))))",
    ));
    const files = contract.policies.find((entry) => (
      entry.table === "member_case_files" && entry.name === "member_case_files_select_owner_or_coordinator"
    ));
    expect(squash(files.qual)).toContain(squash(
      "staff_can_see_user(user_id, 'coordinator'::text) AND (EXISTS ( SELECT 1"
      + " FROM member_cases c WHERE (c.id = member_case_files.case_id)))",
    ));
    expect(squash(files.qual)).toContain("private.chapter_case_readable(c.*)");
    const bytes = contract.functions.find((entry) => (
      entry.sig === "private.can_read_member_case_object(p_bucket text, p_name text)"
    ));
    // The combined parent oracle now enforces restrictions, role containers
    // and private grievance identities before any attachment bytes are read.
    expect(bytes.bodyContains).toContain("private.chapter_case_readable(c)");
    const helper = contract.functions.find((entry) => (
      entry.sig === "private.member_case_restriction_cleared(p_case_id uuid)"
    ));
    expect(helper).toMatchObject({ secdef: true, exec: "" });
    for (const [table, name] of [
      ["coordinator_case_audit", "coordinator_case_audit_select_coordinator"],
      ["member_case_contacts", "member_case_contacts_select_coordinator"],
      // Since 20261106216000 the coordinator read is the second OR branch of
      // the merged member_case_outcomes_select policy (#7195).
      ["member_case_outcomes", "member_case_outcomes_select"],
    ]) {
      const entry = contract.policies.find((row) => row.table === table && row.name === name);
      const coordinator = `(staff_can_see_user(user_id, 'coordinator'::text) AND (EXISTS ( SELECT 1 FROM member_cases c WHERE (c.id = ${table}.case_id))))`;
      // Article updates retain this full coordinator restriction as one
      // branch, alongside the existing scoped staff editor predicate.
      const expected = table === "coordinator_case_audit"
        ? `(${coordinator} OR ((action = 'case_updated'::text) AND (before_value ? 'articles'::text) AND (after_value ? 'articles'::text) AND ((before_value -> 'articles'::text) IS DISTINCT FROM (after_value -> 'articles'::text)) AND (NOT ((before_value - 'articles'::text) IS DISTINCT FROM (after_value - 'articles'::text))) AND private.casework_staff_can_access(case_id)))`
        : table === "member_case_outcomes"
          ? `(((user_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1 FROM member_cases c WHERE ((c.id = member_case_outcomes.case_id) AND (c.user_id = ( SELECT auth.uid() AS uid)))))) OR ${coordinator})`
          : coordinator;
      expect(squash(entry.qual), name).toBe(squash(expected));
    }
    const events = contract.policies.find((entry) => (
      entry.table === "casework_audit_events" && entry.name === "casework_audit_events_staff_read"
    ));
    for (const needle of [
      "private.has_organization_role(organization_id, ARRAY['coordinator'::text])",
      "c.id = casework_audit_events.case_id",
      "private.casework_staff_can_read(case_id)",
    ]) expect(events.qual).toContain(needle);
    expect(events.qual).not.toContain(
      "private.has_organization_role(organization_id, ARRAY['coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text])",
    );
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("a restricted case's notes, attachments and bytes follow the case row", () => {
  let client;
  const id = Object.fromEntries([
    "owner", "coordinator", "steward", "ownerSession", "coordinatorSession", "stewardSession",
    "advisor", "advisorSession", "org", "openCase", "restrictedCase",
  ].map((key) => [key, randomUUID()]));
  const chapter = `case-gate-${id.org}`;
  const notes = (caseId) => client.query(
    "select body from public.member_case_updates where case_id = $1 order by body",
    [caseId],
  ).then((result) => result.rows.map((row) => row.body));
  const files = (caseId) => client.query(
    "select filename from public.member_case_files where case_id = $1 order by filename",
    [caseId],
  ).then((result) => result.rows.map((row) => row.filename));
  const cases = () => client.query("select reference from public.member_cases order by reference")
    .then((result) => result.rows.map((row) => row.reference));
  const contacts = (caseId) => client.query(
    "select summary from public.member_case_contacts where case_id = $1 order by summary",
    [caseId],
  ).then((result) => result.rows.map((row) => row.summary));
  const outcomes = (caseId) => client.query(
    "select summary from public.member_case_outcomes where case_id = $1",
    [caseId],
  ).then((result) => result.rows.map((row) => row.summary));
  const auditTrail = (caseId) => client.query(
    "select action from public.coordinator_case_audit where case_id = $1 order by action",
    [caseId],
  ).then((result) => result.rows.map((row) => row.action));
  const caseworkEvents = (caseId) => client.query(
    "select event_type from public.casework_audit_events where case_id = $1 order by event_type",
    [caseId],
  ).then((result) => result.rows.map((row) => row.event_type));
  // The private predicate is not executable by a client role, so the byte
  // question is asked as the owner of the definer function while the JWT
  // claims — which is what auth.uid() actually reads — remain the actor's.
  const bytes = async (actor, session, objectName) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal: "aal2" }),
    ]);
    const answer = await client.query(
      "select private.can_read_member_case_object('case-files', $1) as readable",
      [objectName],
    );
    return answer.rows[0].readable;
  };
  // Every repaired read path in one shot, so a regression names all of them.
  const readEverything = async (caseId, actor, session) => {
    await act(actor, session);
    const answer = {
      notes: await notes(caseId),
      files: await files(caseId),
      contacts: await contacts(caseId),
      outcomes: await outcomes(caseId),
      auditTrail: await auditTrail(caseId),
      caseworkEvents: await caseworkEvents(caseId),
      bytes: await bytes(actor, session, `${caseId}/evidence.txt`),
    };
    await act(actor, session);
    return answer;
  };
  const act = async (actor, session) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "case-child-row-restriction-gate-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    const people = [
      [id.owner, id.ownerSession],
      [id.coordinator, id.coordinatorSession],
      [id.steward, id.stewardSession],
    ];
    for (const [user, session] of people) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic case-gate factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [id.org, `case-gate-${id.org}`, id.owner]);
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9901)", [chapter, id.org]);
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [id.org]);
    for (const [user] of people) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, user]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
      await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
    }
    // A plain chapter coordinator and a plain steward. Neither holds
    // advisor/admin/vp, which is its own restriction bypass on member_cases.
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)", [id.org, id.coordinator]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$2)", [id.org, id.steward]);

    // Both cases are owned by the member and assigned to the steward. Neither
    // names the test coordinator in coordinator_user_id, so the coordinator
    // reaches them only through the chapter-scope widening under repair.
    // is_restricted is seeded at INSERT because the restriction columns carry a
    // BEFORE UPDATE staff guard; this proof is about the read policies, and the
    // restriction and grant write paths have their own coverage.
    for (const [caseId, reference, restricted] of [
      [id.openCase, "CASE-GATE-OPEN", false],
      [id.restrictedCase, "CASE-GATE-RESTRICTED", true],
    ]) {
      await client.query(
        `insert into public.member_cases(
           id,user_id,reference,title,case_type,organization_id,chapter_id,steward_user_id,
           is_restricted,restriction_reason,restricted_at,restricted_by)
         values($1,$2,$3,$3,'other',$4,$5,$6,$7,$8,$9,$10)`,
        [caseId, id.owner, reference, id.org, chapter, id.steward,
          restricted, restricted ? "sensitive investigation" : null,
          restricted ? new Date() : null, restricted ? id.owner : null],
      );
      for (const suffix of ["a", "b"]) {
        await client.query("insert into public.member_case_updates(case_id,user_id,body) values($1,$2,$3)", [caseId, id.owner, `${reference} note ${suffix}`]);
      }
      await client.query(
        `insert into public.member_case_files(
           id,case_id,user_id,bucket_id,object_name,filename,mime_type,size_bytes,uploaded_by,confirmed_at)
         values($1,$2,$3,'case-files',$4,$5,'text/plain',9,$3,now())`,
        [randomUUID(), caseId, id.owner, `${caseId}/evidence.txt`, `${reference}.txt`],
      );
      await client.query(
        `insert into public.member_case_contacts(
           case_id,user_id,coordinator_id,contact_type,direction,summary,contacted_at)
         values($1,$2,$3,'meeting','internal',$4,now())`,
        [caseId, id.owner, id.coordinator, `${reference} contact`],
      );
      await client.query(
        "insert into public.member_case_outcomes(case_id,user_id,outcome,summary,recorded_by) values($1,$2,'settled',$3,$4)",
        [caseId, id.owner, `${reference} outcome`, id.coordinator],
      );
      await client.query(
        `insert into public.coordinator_case_audit(case_id,user_id,actor_id,action,after_value)
         values($1,$2,$3,'note_added',$4::jsonb)`,
        [caseId, id.owner, id.coordinator, JSON.stringify({ body: `${reference} note a` })],
      );
      await client.query(
        `insert into public.casework_audit_events(
           organization_id,chapter_id,case_id,actor_user_id,event_type,entity_type,entity_id)
         values($1,$2,$3,$4,$5,'member_case',$3)`,
        [id.org, chapter, caseId, id.coordinator, restricted ? "restriction_changed" : "step_advanced"],
      );
    }

    // #8589 re-final: committed data gives every steward grant its migration

    // assignments; an organization grant reaches only chapters it has one in.

    await migrateLegacyStewardFixtures(client);
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("gives an in-scope coordinator the unrestricted case and nothing from the restricted one", async () => {
    await act(id.coordinator, id.coordinatorSession);
    // The oracle for the whole file: the coordinator's chapter widening DOES
    // cover this member, so every zero below is the restriction gate and not a
    // fixture that simply put the actor out of scope. This is the exact
    // predicate the three repaired read paths used to rely on alone.
    expect((await client.query("select public.staff_can_see_user($1,'coordinator') as ok", [id.owner])).rows[0].ok).toBe(true);
    expect(await cases()).toEqual(["CASE-GATE-OPEN"]);
    expect(await notes(id.openCase)).toEqual(["CASE-GATE-OPEN note a", "CASE-GATE-OPEN note b"]);
    expect(await files(id.openCase)).toEqual(["CASE-GATE-OPEN.txt"]);
    expect(await contacts(id.openCase)).toEqual(["CASE-GATE-OPEN contact"]);
    expect(await outcomes(id.openCase)).toEqual(["CASE-GATE-OPEN outcome"]);
    expect(await auditTrail(id.openCase)).toEqual(["note_added"]);
    expect(await caseworkEvents(id.openCase)).toEqual(["step_advanced"]);
    expect(await bytes(id.coordinator, id.coordinatorSession, `${id.openCase}/evidence.txt`)).toBe(true);

    await act(id.coordinator, id.coordinatorSession);
    // The whole point: the case row is gone, and so is every child row that
    // used to be reachable without it. Asserted as ONE object so a regression
    // reports every path that leaked, not just the first.
    expect(await readEverything(id.restrictedCase, id.coordinator, id.coordinatorSession)).toEqual({
      notes: [], files: [], contacts: [], outcomes: [], auditTrail: [], caseworkEvents: [], bytes: false,
    });
  });

  it("restores all three reads for an active casework access grant and withdraws them on revoke", async () => {
    await client.query("reset role");
    const grant = randomUUID();
    await client.query(
      `insert into public.casework_access_grants(id,case_id,organization_id,chapter_id,grantee_user_id,granted_by,reason)
       values($1,$2,$3,$4,$5,$6,'escalation cover for the assigned coordinator')`,
      [grant, id.restrictedCase, id.org, chapter, id.coordinator, id.owner],
    );

    await act(id.coordinator, id.coordinatorSession);
    expect(await cases()).toEqual(["CASE-GATE-OPEN", "CASE-GATE-RESTRICTED"]);
    expect(await notes(id.restrictedCase)).toEqual(["CASE-GATE-RESTRICTED note a", "CASE-GATE-RESTRICTED note b"]);
    expect(await files(id.restrictedCase)).toEqual(["CASE-GATE-RESTRICTED.txt"]);
    expect(await contacts(id.restrictedCase)).toEqual(["CASE-GATE-RESTRICTED contact"]);
    expect(await outcomes(id.restrictedCase)).toEqual(["CASE-GATE-RESTRICTED outcome"]);
    expect(await auditTrail(id.restrictedCase)).toEqual(["note_added"]);
    expect(await caseworkEvents(id.restrictedCase)).toEqual(["restriction_changed"]);
    expect(await bytes(id.coordinator, id.coordinatorSession, `${id.restrictedCase}/evidence.txt`)).toBe(true);

    await client.query("reset role");
    await client.query("update public.casework_access_grants set revoked_at=now(), revoked_by=$2 where id=$1", [grant, id.owner]);
    expect(await readEverything(id.restrictedCase, id.coordinator, id.coordinatorSession)).toEqual({
      notes: [], files: [], contacts: [], outcomes: [], auditTrail: [], caseworkEvents: [], bytes: false,
    });
  });

  it("leaves the case owner's own reads intact", async () => {
    await act(id.owner, id.ownerSession);
    expect(await cases()).toEqual(["CASE-GATE-OPEN", "CASE-GATE-RESTRICTED"]);
    expect(await notes(id.restrictedCase)).toEqual(["CASE-GATE-RESTRICTED note a", "CASE-GATE-RESTRICTED note b"]);
    expect(await files(id.restrictedCase)).toEqual(["CASE-GATE-RESTRICTED.txt"]);
    expect(await bytes(id.owner, id.ownerSession, `${id.restrictedCase}/evidence.txt`)).toBe(true);
  });

  it("leaves an organization advisor's unconditional casework audit read intact", async () => {
    // advisor/admin/vp are a member_cases restriction bypass and hold no
    // member_cases read of their own, so the split branch must not gate them.
    await client.query("reset role");
    await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [id.advisor, `${id.advisor}@example.invalid`]);
    await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [id.advisorSession, id.advisor]);
    await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic case-gate factor','totp','verified',now(),now())", [randomUUID(), id.advisor]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, id.advisor]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id.advisor, chapter]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id.advisor, chapter]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'advisor',$2)", [id.org, id.advisor]);

    await act(id.advisor, id.advisorSession);
    expect(await cases()).toEqual([]);
    expect(await caseworkEvents(id.restrictedCase)).toEqual(["restriction_changed"]);
  });

  it("leaves the assigned steward's own caseload intact", async () => {
    await act(id.steward, id.stewardSession);
    expect(await cases()).toEqual(["CASE-GATE-OPEN", "CASE-GATE-RESTRICTED"]);
    expect(await notes(id.restrictedCase)).toEqual(["CASE-GATE-RESTRICTED note a", "CASE-GATE-RESTRICTED note b"]);
  });
});
