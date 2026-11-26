// BUG-UG-STEWARD-DEADLINE-LIST-OVERDUE-EASTERN-DAY-20261102 (#6745):
// on a disposable database, list_steward_case_deadlines calls a clock overdue
// by its moment or missed status (never its calendar day), and the case's own
// date deadline by the Eastern day; an undated note takes the Eastern day.
// Everything runs in one transaction that rolls back, so now() is fixed for
// the whole proof.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const EASTERN_TODAY = "(now() at time zone 'America/New_York')::date";

live("steward deadline overdue and Eastern-day note dates", () => {
  let client;
  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "steward-deadline-overdue-proof" });
    await client.connect();
    await client.query("set statement_timeout = '20s'");
    await client.query("begin");
  });
  afterAll(async () => {
    await client?.query("rollback").catch(() => {});
    await client?.end();
  });
  const asOwner = async () => { await client.query("reset role"); await client.query("select set_config('request.jwt.claims','',true)"); };
  const actAs = async (userId) => {
    await asOwner();
    const session = randomUUID();
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, userId]);
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: session })]);
    await client.query("set local role authenticated");
  };
  const capture = async (statement, args = []) => {
    await client.query("savepoint cell");
    try {
      const result = await client.query(statement, args);
      await client.query("release savepoint cell");
      return { ok: true, value: result.rows[0]?.v ?? null, code: "" };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      return { ok: false, value: null, code: error.code || "", message: error.message };
    }
  };

  it("flags clocks by moment or missed status and the case deadline by the Eastern day", async () => {
    const org = randomUUID();
    const chapter = `sdo-${org}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$3)", [org, `sdo-${org}`, `Overdue Proof ${org}`]);
    await client.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,'Overdue Local',$1,'proof',$2,9982)", [chapter, org]);
    const person = async (role = null) => {
      await asOwner();
      const id = randomUUID();
      await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
      await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id, chapter, `Proof ${id.slice(0, 8)}`]);
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [org, id]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, chapter]);
      await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
      if (role) {
        await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
        await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
      }
      return id;
    };
    const steward = await person("steward");
    const member = await person();

    await actAs(member);
    const created = await capture("select public.create_member_case('Shift swap refused',current_date + 40,'Scheduling','Art 7') as v");
    expect(created.ok, created.message).toBe(true);
    const caseId = created.value.caseId;
    // A member's own undated note takes the Eastern day.
    // (Through add_my_case_update since 20261104075000, the member's own note path.)
    const own = await capture(`select ((public.add_my_case_update($1, 'Typed now')) ->> 'occurredOn')::date = ${EASTERN_TODAY} as v`, [caseId]);
    expect(own.ok, own.message).toBe(true);
    expect(own.value).toBe(true);

    await asOwner();
    await client.query("update public.member_cases set steward_user_id=$2, steward_name='Proof steward', assigned_at=now() where id=$1", [caseId, steward]);
    const caseRow = (await client.query("select organization_id, chapter_id from public.member_cases where id=$1", [caseId])).rows[0];
    await client.query(`insert into public.casework_deadlines(case_id, organization_id, chapter_id, kind, label, due_at, status, created_by) values
      ($1,$2,$3,'filing','Passed a minute ago', now() - interval '1 minute', 'active', $4),
      ($1,$2,$3,'response','Missed but later', now() + interval '1 minute', 'missed', $4),
      ($1,$2,$3,'hearing','Still ahead', now() + interval '1 minute', 'active', $4)`, [caseId, caseRow.organization_id, caseRow.chapter_id, steward]);

    const flags = async () => {
      await actAs(steward);
      const result = await capture("select public.list_steward_case_deadlines() as v");
      expect(result.ok, result.message).toBe(true);
      return Object.fromEntries(result.value.rows.map((row) => [row.kind, row.overdue]));
    };

    await asOwner();
    await client.query(`update public.member_cases set deadline = ${EASTERN_TODAY} where id=$1`, [caseId]);
    expect(await flags()).toEqual({ filing: true, response: true, hearing: false, case: false });

    await asOwner();
    await client.query(`update public.member_cases set deadline = ${EASTERN_TODAY} - 1 where id=$1`, [caseId]);
    expect((await flags()).case).toBe(true);

    // The steward's undated note takes the Eastern day too.
    await actAs(steward);
    const undated = await capture("select public.steward_add_case_note($1,'Same-day follow-up',null) as v", [caseId]);
    expect(undated.ok, undated.message).toBe(true);
    expect(undated.value.occurredOn).toBe((await client.query(`select (${EASTERN_TODAY})::text as d`)).rows[0].d);
  });
});
