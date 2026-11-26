// @vitest-environment node
// REQ-UG-HOME-NUDGES-20261001: live proof of public.get_member_home_nudges()
// on an owned disposable database. Every fixture rolls back with the outer
// transaction.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("member Home nudges on an owned disposable database", () => {
  let db;
  const ids = Object.fromEntries(["org", "member", "memberSession", "other", "otherSession", "step1", "step2", "step3", "plan"].map((key) => [key, randomUUID()]));
  const chapter = `nudges-${ids.org}`;
  let actor = "member";
  let aal = "aal2";

  async function call() {
    await db.query("savepoint nudge_call");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: ids[actor], role: "authenticated", session_id: ids[`${actor}Session`], aal })]);
      await db.query("set local role authenticated");
      const result = await db.query("select public.get_member_home_nudges() data");
      await db.query("reset role");
      await db.query("release savepoint nudge_call");
      return { code: "", data: result.rows[0]?.data };
    } catch (error) {
      await db.query("rollback to savepoint nudge_call");
      await db.query("release savepoint nudge_call");
      return { code: error.code, message: error.message };
    }
  }

  const setting = (key, value) => db.query(
    "insert into public.organization_setting_values(organization_id,setting_key,value,updated_by) values($1,$2,$3::jsonb,$4) on conflict (organization_id,setting_key) do update set value=excluded.value",
    [ids.org, key, JSON.stringify(value), ids.member],
  );
  const guideSwitches = [
    "features.guidance_onboarding.progressive_disclosure",
    "features.guidance_onboarding.hud_tooltips",
    "features.guidance_onboarding.badge_achievements",
  ];
  // Only when the guide's definitions are installed (they are below this layer).
  const guideSetting = (key, value) => db.query(
    `insert into public.organization_setting_values(organization_id,setting_key,value,updated_by)
     select $1,$2,$3::jsonb,$4 where exists (select 1 from public.platform_setting_definitions where key=$2)
     on conflict (organization_id,setting_key) do update set value=excluded.value`,
    [ids.org, key, JSON.stringify(value), ids.member],
  );
  const plan = (status, completed) => db.query(
    `insert into public.member_onboarding_plans(id,organization_id,member_user_id,status,completed_step_ids,started_at,completed_at)
     values($1,$2,$3,$4,$5::uuid[],case when $4='not_started' then null else now() end,case when $4='completed' then now() else null end)`,
    [ids.plan, ids.org, ids.member, status, completed.map((key) => ids[key])],
  );

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false });
    await db.connect();
    await db.query("begin");
    for (const [user, session] of [["member", "memberSession"], ["other", "otherSession"]]) {
      await db.query("insert into auth.users(id,email) values($1,$2)", [ids[user], `${ids[user]}@example.invalid`]);
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [ids[session], ids[user]]);
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Nudge proof','totp','verified',now(),now())", [randomUUID(), ids[user]]);
    }
    await db.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [ids.org, `nudges-${ids.org}`, ids.member]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9980)", [chapter, ids.org]);
    for (const user of ["member", "other"]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.org, ids[user]]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [ids[user], chapter]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [ids[user], chapter]);
    }
    for (const [index, key] of ["step1", "step2", "step3"].entries()) {
      await db.query("insert into public.organization_onboarding_steps(id,organization_id,title,position,active) values($1,$2,$3,$4,true)", [ids[key], ids.org, `Step ${index + 1}`, index * 10]);
    }
    // The real onboarding guide (REQ-UG-PROGRESSIVE-DISCLOSURE-AND-FEATURE-DRIP-20261001,
    // 20261002120000) is installed below this migration and defaults on, so a
    // member with an unfinished plan is in the guided first run and is offered
    // no nudge. These proofs exercise the nudges themselves, so this
    // organization turns the guide's navigation, card and badge switches off;
    // the guided-run case below turns them back on.
    for (const key of guideSwitches) await guideSetting(key, false);
  }, 60000);

  beforeEach(async () => { actor = "member"; aal = "aal2"; await db.query("savepoint nudge_test"); });
  afterEach(async () => { await db.query("rollback to savepoint nudge_test"); });
  afterAll(async () => { await db?.query("rollback").catch(() => {}); await db?.end(); });

  it("registers two member-visible switches (on) and the 28-day snooze", async () => {
    const { rows } = await db.query("select key, default_value, minimum, maximum, category, member_visible from public.platform_setting_definitions where key in ('features.home.passkey_nudge','features.home.onboarding_nudge','limits.home.nudge_snooze_days') order by key");
    expect(rows).toEqual([
      { key: "features.home.onboarding_nudge", default_value: true, minimum: null, maximum: null, category: "home", member_visible: true },
      { key: "features.home.passkey_nudge", default_value: true, minimum: null, maximum: null, category: "home", member_visible: true },
      { key: "limits.home.nudge_snooze_days", default_value: 28, minimum: 1, maximum: 365, category: "home", member_visible: true },
    ]);
  });

  it("reports the caller's unfinished onboarding counting active steps only", async () => {
    await plan("in_progress", ["step1"]);
    expect((await call()).data).toEqual({ passkey: true, onboarding: { completed: 1, total: 3 }, guidedFirstRun: false, snoozeDays: 28 });
    await db.query("update public.organization_onboarding_steps set active=false where id=$1", [ids.step3]);
    expect((await call()).data.onboarding).toEqual({ completed: 1, total: 2 });
  });

  it("offers no onboarding nudge without a plan, after completion, or for another member", async () => {
    expect((await call()).data.onboarding).toBeNull();
    await plan("completed", ["step1", "step2", "step3"]);
    expect((await call()).data.onboarding).toBeNull();
    actor = "other";
    expect((await call()).data.onboarding).toBeNull();
  });

  it("enforces both switches, the passkey-enrollment setting and the snooze limit", async () => {
    await plan("in_progress", []);
    await setting("features.home.onboarding_nudge", false);
    await setting("limits.home.nudge_snooze_days", 7);
    expect((await call()).data).toEqual({ passkey: true, onboarding: null, guidedFirstRun: false, snoozeDays: 7 });
    await setting("features.passkey_enrollment", false);
    expect((await call()).data.passkey).toBe(false);
    await setting("features.passkey_enrollment", true);
    await setting("features.home.passkey_nudge", false);
    expect((await call()).data.passkey).toBe(false);
  });

  it("offers nothing while the guided first run is active", async () => {
    await plan("in_progress", []);
    // The real guide with its default-on switches: an unfinished plan is the
    // guided first run, so no nudge competes with it.
    const installed = (await db.query("select to_regprocedure('public.get_member_onboarding_guide()') is not null as present")).rows[0].present;
    if (installed) {
      for (const key of guideSwitches) await guideSetting(key, true);
      expect((await call()).data).toEqual({ passkey: false, onboarding: null, guidedFirstRun: true, snoozeDays: 28 });
      for (const key of guideSwitches) await guideSetting(key, false);
    }
    // Stand-in for 's guide (or the real one when it is installed);
    // the savepoint restores whatever was there.
    await db.query(`create or replace function public.get_member_onboarding_guide() returns jsonb language sql stable security definer set search_path = ''
      as $$ select '{"progressiveDisclosureActive": true, "onboardingComplete": false, "showHud": true}'::jsonb $$`);
    await db.query("grant execute on function public.get_member_onboarding_guide() to authenticated");
    expect((await call()).data).toEqual({ passkey: false, onboarding: null, guidedFirstRun: true, snoozeDays: 28 });
    await db.query(`create or replace function public.get_member_onboarding_guide() returns jsonb language sql stable security definer set search_path = ''
      as $$ select '{"progressiveDisclosureActive": false, "onboardingComplete": true, "showHud": true}'::jsonb $$`);
    expect((await call()).data).toMatchObject({ passkey: true, guidedFirstRun: false, onboarding: { completed: 0, total: 3 } });
  });

  it("refuses callers without MFA assurance or an active organization", async () => {
    aal = "aal1";
    expect((await call()).code).toBe("42501");
    aal = "aal2";
    await db.query("update public.organization_memberships set status='revoked', revoked_at=now() where user_id=$1", [ids.member]);
    expect((await call()).code).toBe("42501");
  });

  it("is executable by signed-in members only", async () => {
    const { rows } = await db.query(`select
      has_function_privilege('anon','public.get_member_home_nudges()','EXECUTE') anon,
      has_function_privilege('authenticated','public.get_member_home_nudges()','EXECUTE') authed,
      has_function_privilege('service_role','public.get_member_home_nudges()','EXECUTE') service`);
    expect(rows[0]).toEqual({ anon: false, authed: true, service: false });
  });
});
