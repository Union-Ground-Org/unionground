// BUG-UG-CASE-NOTE-DATE-MISSING-FROM-EXPORTS-20261102 (#6746): on a
// disposable database, the member's account data export and the one-call
// Home bootstrap both carry the date the member gave each case note
// (occurred_on), null on an undated note. Everything rolls back.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("case note dates in the member's exports", () => {
  let client;
  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "case-note-date-export-proof" });
    await client.connect();
    await client.query("set statement_timeout = '30s'");
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

  it("exports occurredOn on each own case update and returns occurred_on from the bootstrap", async () => {
    const org = randomUUID();
    const chapter = `cnd-${org}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$3)", [org, `cnd-${org}`, `Note Date Proof ${org}`]);
    await client.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,'Note Date Local',$1,'proof',$2,9983)", [chapter, org]);
    const member = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [member, `${member}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2, full_name='Proof member' where id=$1", [member, chapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [org, member]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [member, chapter]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), member]);

    await actAs(member);
    const caseId = (await client.query("select public.create_member_case('Overtime pay late',current_date + 30,'Pay','Art 12') as v")).rows[0].v.caseId;
    // The member's own note goes through add_my_case_update since 20261104075000.
    const dated = (await client.query("select (public.add_my_case_update($1, 'Called payroll', date '2026-10-05')) ->> 'id' as id", [caseId])).rows[0].id;
    // A note from before the date column existed carries no date; only such a
    // legacy row has occurred_on null, so the fixture writes it as the owner.
    await asOwner();
    const undated = (await client.query("insert into public.member_case_updates(case_id,user_id,body,occurred_on) values ($1,$2,'Older-style note',null) returning id", [caseId, member])).rows[0].id;
    await actAs(member);

    const exported = (await client.query("select public.get_member_data_export() as v")).rows[0].v;
    const updates = Object.fromEntries((exported.cases ?? []).find((item) => item.id === caseId).updates.map((row) => [row.id, row]));
    expect(updates[dated]).toMatchObject({ body: "Called payroll", occurredOn: "2026-10-05" });
    expect(updates[undated]).toHaveProperty("occurredOn", null);

    const boot = (await client.query("select public.get_member_home_bootstrap(now() - interval '7 days', array['member_case_updates']) as v")).rows[0].v;
    const rows = Object.fromEntries(boot.member_case_updates.map((row) => [row.id, row]));
    expect(rows[dated].occurred_on).toBe("2026-10-05");
    expect(rows[undated]).toHaveProperty("occurred_on", null);
  });
});
