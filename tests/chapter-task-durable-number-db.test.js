// @vitest-environment node
//
// BUG-UG-LOCAL-VERIFY-SCRIPTS-FAIL-BEFORE-TASK-EDITS-20261103 (#6982):
// verify:rpc probe 10 in the required DB lane. The whole verify:rpc suite
// stays quarantined behind ALLOW_ROLLBACK_SYNTHETIC_IDENTITIES (see
// TEST-UG-RPC-BEHAVIOUR-NO-FICTION-20260816), so this file carries its
// durable visible key check: hard-purging the highest-numbered task must not
// let create_chapter_task hand that number out again.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("chapter task numbers on a disposable database", () => {
  let c;
  let world;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "chapter-task-durable-number-proof" });
    await c.connect();
  });
  afterAll(async () => { await c?.end(); });

  beforeEach(async () => {
    await c.query("begin");
    const org = { id: randomUUID(), chapter: `durable-number-${randomUUID().slice(0, 8)}` };
    const steward = { id: randomUUID(), session: randomUUID() };
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org.id, org.chapter]);
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98317)", [org.chapter, org.id]);
    await c.query("insert into public.chapter_workstreams(chapter_id,name) values ($1,'General') on conflict do nothing", [org.chapter]);
    await c.query("insert into auth.users(id,email) values ($1,$2)", [steward.id, `${steward.id}@example.invalid`]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org.id, steward.id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [steward.id, org.chapter]);
    await c.query("update public.member_profiles set chapter_id=$2 where id=$1", [steward.id, org.chapter]);
    await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'steward',$2)", [org.id, steward.id]);
    await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'steward',$2) on conflict do nothing", [steward.id, org.chapter]);
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), steward.id]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [steward.session, steward.id]);
    world = { org, steward };
  });
  afterEach(async () => { await c.query("rollback"); });

  async function create(title) {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(
      { role: "authenticated", sub: world.steward.id, session_id: world.steward.session, aal: "aal2" })]);
    await c.query("set local role authenticated");
    const task = (await c.query(
      "select id, task_number, chapter_id from public.create_chapter_task(pg_catalog.jsonb_build_object('title', $1::text))",
      [title],
    )).rows[0];
    await c.query("reset role");
    return task;
  }

  it("never reuses a hard-purged task's number", async () => {
    const first = await create("Durable key proof 1");
    expect(first.chapter_id).toBe(world.org.chapter);
    await c.query("delete from public.chapter_tasks where id = $1", [first.id]);
    const second = await create("Durable key proof 2");
    expect(Number(second.task_number)).toBeGreaterThan(Number(first.task_number));
  });
});
