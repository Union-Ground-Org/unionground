// @vitest-environment node
// REQ-UG-REACTIVATION-WELCOME-BACK-20261001: live proof of
// public.record_member_home_return() and its one-date-per-account store on an
// owned disposable database. Every fixture rolls back with the outer
// transaction.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const SWITCH = "features.home.reactivation_welcome_back";
const LIMIT = "limits.home.reactivation_after_days";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("member Home welcome back on an owned disposable database", () => {
  let db;
  const ids = Object.fromEntries(["org", "member", "memberSession", "other", "otherSession"].map((key) => [key, randomUUID()]));
  const chapter = `welcome-back-${ids.org}`;
  let actor = "member";
  let aal = "aal2";

  async function call() {
    await db.query("savepoint return_call");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: ids[actor], role: "authenticated", session_id: ids[`${actor}Session`], aal })]);
      await db.query("set local role authenticated");
      const result = await db.query("select public.record_member_home_return() data");
      await db.query("reset role");
      await db.query("release savepoint return_call");
      return { code: "", data: result.rows[0]?.data };
    } catch (error) {
      await db.query("rollback to savepoint return_call");
      await db.query("release savepoint return_call");
      return { code: error.code, message: error.message };
    }
  }

  // The welcome-back reader counts the Eastern day (private.eastern_day(),
  // 20261117121800); the database runs in UTC, so a UTC fixture day is a day
  // ahead every evening from 7 PM Eastern (#9180).
  const today = async () => (await db.query("select (now() at time zone 'America/New_York')::date d")).rows[0].d;
  const mark = async (userKey) => (await db.query("select last_active_on from private.member_home_return_marks where user_id=$1", [ids[userKey]])).rows;
  const setMark = (userKey, daysAgo) => db.query(
    "insert into private.member_home_return_marks(user_id,last_active_on) values($1,(now() at time zone 'America/New_York')::date - $2::integer) on conflict (user_id) do update set last_active_on=excluded.last_active_on",
    [ids[userKey], daysAgo],
  );

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false });
    await db.connect();
    await db.query("begin");
    for (const [user, session] of [["member", "memberSession"], ["other", "otherSession"]]) {
      await db.query("insert into auth.users(id,email) values($1,$2)", [ids[user], `${ids[user]}@example.invalid`]);
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [ids[session], ids[user]]);
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Return proof','totp','verified',now(),now())", [randomUUID(), ids[user]]);
    }
    await db.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [ids.org, `welcome-${ids.org}`, ids.member]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9970)", [chapter, ids.org]);
    for (const user of ["member", "other"]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.org, ids[user]]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [ids[user], chapter]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [ids[user], chapter]);
    }
  }, 60000);

  beforeEach(async () => { actor = "member"; aal = "aal2"; await db.query("savepoint return_test"); });
  afterEach(async () => { await db.query("rollback to savepoint return_test"); });
  afterAll(async () => { await db?.query("rollback").catch(() => {}); await db?.end(); });

  it("registers the member-visible switch (on) and the 21-day limit", async () => {
    const { rows } = await db.query("select key, value_kind, default_value, minimum, maximum, category, member_visible from public.platform_setting_definitions where key in ($1,$2) order by key", [SWITCH, LIMIT]);
    expect(rows).toEqual([
      { key: SWITCH, value_kind: "boolean", default_value: true, minimum: null, maximum: null, category: "home", member_visible: true },
      { key: LIMIT, value_kind: "integer", default_value: 21, minimum: 7, maximum: 365, category: "home", member_visible: false },
    ]);
  });

  it("records one date on the first visit without greeting a brand-new account", async () => {
    expect((await call()).data).toEqual({ enabled: true, welcomeBack: false, afterDays: 21 });
    expect(await mark("member")).toEqual([{ last_active_on: await today() }]);
    expect((await call()).data.welcomeBack).toBe(false);
  });

  it("welcomes back after more than 21 days, exactly once, and overwrites the date", async () => {
    await setMark("member", 22);
    expect((await call()).data).toEqual({ enabled: true, welcomeBack: true, afterDays: 21 });
    expect(await mark("member")).toEqual([{ last_active_on: await today() }]);
    expect((await call()).data.welcomeBack).toBe(false);
  });

  it("does not welcome back at exactly the threshold", async () => {
    await setMark("member", 21);
    expect((await call()).data.welcomeBack).toBe(false);
  });

  it("honours the organization's limit", async () => {
    await db.query("insert into public.organization_setting_values(organization_id,setting_key,value,updated_by) values($1,$2,'7'::jsonb,$3)", [ids.org, LIMIT, ids.member]);
    await setMark("member", 8);
    expect((await call()).data).toEqual({ enabled: true, welcomeBack: true, afterDays: 7 });
  });

  it("neither reads nor writes anything when the switch is off", async () => {
    await db.query("insert into public.organization_setting_values(organization_id,setting_key,value,updated_by) values($1,$2,'false'::jsonb,$3)", [ids.org, SWITCH, ids.member]);
    await setMark("member", 40);
    expect((await call()).data).toEqual({ enabled: false, welcomeBack: false });
    expect((await mark("member"))[0].last_active_on).not.toEqual(await today());
  });

  it("keeps each account's date to itself", async () => {
    await setMark("other", 40);
    await call();
    expect((await mark("other"))[0].last_active_on).not.toEqual(await today());
    actor = "other";
    expect((await call()).data.welcomeBack).toBe(true);
  });

  it("refuses callers without MFA assurance or an active organization", async () => {
    aal = "aal1";
    expect((await call()).code).toBe("42501");
    aal = "aal2";
    await db.query("update public.organization_memberships set status='revoked', revoked_at=now() where user_id=$1", [ids.member]);
    expect((await call()).code).toBe("42501");
    expect(await mark("member")).toEqual([]);
  });

  it("stores one date per account, unreachable to clients, and deletes it with the account", async () => {
    const columns = (await db.query("select column_name from information_schema.columns where table_schema='private' and table_name='member_home_return_marks' order by ordinal_position")).rows.map((row) => row.column_name);
    expect(columns).toEqual(["user_id", "last_active_on"]);
    const grants = (await db.query(`select
      has_table_privilege('authenticated','private.member_home_return_marks','SELECT') a_select,
      has_table_privilege('authenticated','private.member_home_return_marks','INSERT') a_insert,
      has_function_privilege('anon','public.record_member_home_return()','EXECUTE') anon_exec,
      has_function_privilege('service_role','public.record_member_home_return()','EXECUTE') service_exec`)).rows[0];
    expect(grants).toEqual({ a_select: false, a_insert: false, anon_exec: false, service_exec: false });
    const manifest = (await db.query("select delete_disposition, export_disposition from private.account_lifecycle_manifest where schema_name='private' and table_name='member_home_return_marks'")).rows;
    expect(manifest).toEqual([{ delete_disposition: "cascade", export_disposition: "excluded_with_reason" }]);
    await call();
    await db.query("delete from auth.users where id=$1", [ids.other]);
    expect(await mark("other")).toEqual([]);
  });
});
