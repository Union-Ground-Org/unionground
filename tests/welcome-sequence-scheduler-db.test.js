// @vitest-environment node
//
// REQ-UG-WELCOME-SEQUENCE-SCHEDULER-20261001 (CR-110)
//
// The old app sent due welcome-sequence messages every 15 minutes
// (de7df4b57c^:vercel.ts:52, app/api/cron/email-dispatch) and a welcome email
// on a member's first sign-in (app/auth/confirm/route.ts:271). 20261003031000
// restores both on the engagement outbox, behind two organization switches,
// and gives welcome mail its own "welcome" email choice on W1-URGENT-A's
// opt-out and one-click unsubscribe. The static half pins the migration; the
// live half runs the real minute tick with no JWT, as pg_cron does, on a
// disposable database inside one rolled-back transaction.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const MIGRATION = "supabase/migrations/20261003031000_welcome_sequence_scheduler.sql";
const migration = readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8");

describe("welcome sequence scheduler (static)", () => {
  it("registers both switches default ON with old-app citations", () => {
    expect(migration).toContain("('features.automation.welcome_sequence_auto', 'boolean', 'Send welcome steps automatically',");
    expect(migration).toContain("('features.automation.first_signin_welcome_email', 'boolean', 'Welcome email on first sign-in',");
    expect(migration).toContain("de7df4b57c^:vercel.ts:52");
    expect(migration).toContain("de7df4b57c^:app/auth/confirm/route.ts:271");
    expect(migration.match(/'true', null, null, null, \d+, 'automation', false\)/g)).toHaveLength(2);
  });

  it("rides the mirrored minute dispatch job instead of adding an unmonitored one", () => {
    expect(migration).toContain("command := 'select private.dispatch_due_member_messaging(); select private.dispatch_due_workflow_reminders(200); select private.run_welcome_automation(50);')");
    expect(migration).not.toMatch(/cron\.schedule\(/);
  });

  it("guards each re-declared function behind a reviewed predecessor digest", () => {
    const guard = migration.slice(migration.indexOf("do $predecessor$"), migration.indexOf("$predecessor$;"));
    for (const signature of [
      "private.engagement_email_category(text)", "private.engagement_email_opted_out(uuid, text)",
      "private.preserve_engagement_email_preferences()", "private.engagement_email_unsubscribe_token(uuid, text)",
      "public.apply_engagement_email_unsubscribe(text)", "public.get_engagement_delivery_payload(uuid, uuid)",
      "public.queue_due_welcome_messages(uuid)",
    ]) expect(guard).toMatch(new RegExp(`\\('${signature.replace(/[().]/g, "\\$&")}', '[0-9a-f]{64}'\\)`));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("welcome sequence scheduler on a disposable database", () => {
  let db;
  const ID = {
    org: randomUUID(), admin: randomUUID(), campaign: randomUUID(),
    plain: randomUUID(), annOff: randomUUID(), welcomeOff: randomUUID(), welcomeOn: randomUUID(),
    newcomer: randomUUID(), newcomerEs: randomUUID(), neverSigned: randomUUID(), veteran: randomUUID(), newcomerOff: randomUUID(),
  };
  ID.chapter = `welcome-sched-${ID.org.slice(0, 8)}`;
  const q = (sql, values = []) => db.query(sql, values);
  const cron = async (sql, values = []) => { await q("select set_config('request.jwt.claims','',true)"); return q(sql, values); };
  const outbox = async (userId, sourceKind) => (await q(
    "select state, last_error_code, locale, subject_snapshot, action_path_snapshot from public.engagement_delivery_outbox where recipient_user_id=$1 and delivery_kind='welcome' and source_kind=$2",
    [userId, sourceKind],
  )).rows;
  const setSwitch = (key, value) => q(
    "insert into public.organization_setting_values(organization_id, setting_key, value) values ($1,$2,$3::jsonb) on conflict (organization_id, setting_key) do update set value=excluded.value",
    [ID.org, key, JSON.stringify(value)],
  );

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "welcome-sequence-scheduler-proof" });
    await db.connect();
    await q("begin");
    await q("set local statement_timeout = '120s'");
    const sequenceMembers = [ID.plain, ID.annOff, ID.welcomeOff, ID.welcomeOn];
    const signinMembers = [ID.newcomer, ID.newcomerEs, ID.neverSigned, ID.veteran, ID.newcomerOff];
    const everyone = [ID.admin, ...sequenceMembers, ...signinMembers];
    for (const id of everyone) await q("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await q("insert into public.organizations(id,slug,name,created_by) values ($1,$2,$3,$4)", [ID.org, `welcome-sched-${ID.org.slice(0, 8)}`, `Welcome proof local ${ID.org.slice(0, 8)}`, ID.admin]);
    await q("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values ($1,$1,$1,$2,false,92611)", [ID.chapter, ID.org]);
    for (const id of everyone) {
      await q("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [ID.org, id]);
      await q("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [id, ID.chapter]);
      await q("update public.member_profiles set chapter_id=$2 where id=$1", [id, ID.chapter]);
    }
    const prefs = { [ID.annOff]: { announcements: false }, [ID.welcomeOff]: { welcome: false }, [ID.welcomeOn]: { announcements: false, welcome: true }, [ID.newcomerOff]: { welcome: false } };
    for (const [id, value] of Object.entries(prefs)) await q("update public.member_profiles set notification_prefs = notification_prefs || $2::jsonb where id=$1", [id, JSON.stringify(value)]);
    await q("update public.member_profiles set language='es' where id=$1", [ID.newcomerEs]);
    // Sequence members joined before the scheduler was installed; that never
    // blocks their due steps, only the first-sign-in email.
    await q("update public.organization_memberships set created_at = (select first_signin_since from private.welcome_automation_state) - interval '1 day' where organization_id=$1 and user_id = any($2::uuid[])", [ID.org, [...sequenceMembers, ID.veteran, ID.admin]]);
    await q("update auth.users set last_sign_in_at = now() where id = any($1::uuid[])", [[ID.newcomer, ID.newcomerEs, ID.veteran, ID.newcomerOff, ...sequenceMembers]]);
    await q("insert into public.organization_welcome_campaigns(id,organization_id,name,state,created_by) values ($1,$2,'Welcome','active',$3)", [ID.campaign, ID.org, ID.admin]);
    await q("insert into public.organization_welcome_campaign_steps(organization_id,campaign_id,position,delay_days,locale,subject,body,active) values ($1,$2,0,0,'en','Hello','First step',true),($1,$2,1,7,'en','Week one','Second step',true)", [ID.org, ID.campaign]);
    for (const id of sequenceMembers) {
      await q("insert into public.member_welcome_enrollments(organization_id,campaign_id,member_user_id,state,next_step_position,next_due_at,enrolled_by) values ($1,$2,$3,'active',0,now()-interval '1 hour',$4)", [ID.org, ID.campaign, id, ID.admin]);
    }
  }, 120_000);

  afterAll(async () => {
    if (db) {
      await q("rollback").catch(() => {});
      await db.end();
    }
  });

  it("sends due welcome steps on the tick with no staff action, honoring the welcome choice", async () => {
    await q("savepoint steps");
    const result = (await cron("select private.run_welcome_automation(50) r")).rows[0].r;
    expect(result.welcomeSteps).toBe(2);
    expect(await outbox(ID.plain, "welcome_campaign")).toEqual([expect.objectContaining({ state: "queued", subject_snapshot: "Hello" })]);
    expect(await outbox(ID.welcomeOn, "welcome_campaign")).toHaveLength(1);
    // Unset welcome follows announcements=false; an explicit welcome=false is off.
    expect(await outbox(ID.annOff, "welcome_campaign")).toEqual([]);
    expect(await outbox(ID.welcomeOff, "welcome_campaign")).toEqual([]);
    const enrollments = (await q("select member_user_id, next_step_position from public.member_welcome_enrollments where campaign_id=$1", [ID.campaign])).rows;
    expect(enrollments.every((row) => row.next_step_position === 1)).toBe(true);
    const audit = (await q("select action, metadata from public.organization_audit_ledger where organization_id=$1 and event_type='welcome_messages_queued'", [ID.org])).rows;
    expect(audit).toEqual([{ action: "send", metadata: { count: 2, status: "scheduled" } }]);
    // The next step is not due for 7 days: a second tick sends nothing.
    expect((await cron("select private.run_welcome_automation(50) r")).rows[0].r.welcomeSteps).toBe(0);
    await q("rollback to savepoint steps");
  });

  it("leaves due steps for staff while the organization's scheduler switch is off", async () => {
    await q("savepoint steps_off");
    await setSwitch("features.automation.welcome_sequence_auto", false);
    expect((await cron("select private.run_welcome_automation(50) r")).rows[0].r.welcomeSteps).toBe(0);
    expect(await outbox(ID.plain, "welcome_campaign")).toEqual([]);
    await q("rollback to savepoint steps_off");
  });

  it("queues one first-sign-in welcome per newcomer, in their language, never for veterans or the opted out", async () => {
    await q("savepoint first");
    const result = (await cron("select private.run_welcome_automation(50) r")).rows[0].r;
    expect(result.firstSignin).toBe(2);
    expect(await outbox(ID.newcomer, "first_signin_welcome")).toEqual([expect.objectContaining({ state: "queued", locale: "en", action_path_snapshot: "/m", subject_snapshot: expect.stringMatching(/^Welcome to Welcome proof local /) })]);
    expect(await outbox(ID.newcomerEs, "first_signin_welcome")).toEqual([expect.objectContaining({ state: "queued", locale: "es", subject_snapshot: expect.stringMatching(/^Te damos la bienvenida a /) })]);
    expect(await outbox(ID.newcomerOff, "first_signin_welcome")).toEqual([expect.objectContaining({ state: "suppressed", last_error_code: "recipient_opted_out" })]);
    expect(await outbox(ID.neverSigned, "first_signin_welcome")).toEqual([]);
    expect(await outbox(ID.veteran, "first_signin_welcome")).toEqual([]);
    expect(await outbox(ID.plain, "first_signin_welcome")).toEqual([]);
    expect((await cron("select private.run_welcome_automation(50) r")).rows[0].r.firstSignin).toBe(0);
    await q("rollback to savepoint first");
  });

  it("sends no first-sign-in welcome while that switch is off", async () => {
    await q("savepoint first_off");
    await setSwitch("features.automation.first_signin_welcome_email", false);
    expect((await cron("select private.run_welcome_automation(50) r")).rows[0].r.firstSignin).toBe(0);
    expect(await outbox(ID.newcomer, "first_signin_welcome")).toEqual([]);
    await q("rollback to savepoint first_off");
  });

  it("delivers welcome mail under the welcome category and its one-click link turns only welcome off", async () => {
    await q("savepoint deliver");
    await cron("select private.run_welcome_automation(50)");
    const lease = randomUUID();
    const claimed = (await q("select public.claim_engagement_delivery_batch($1, 100, 300) rows", [lease])).rows[0].rows;
    const row = claimed.find((entry) => entry.recipientUserId === ID.newcomer && entry.deliveryKind === "welcome");
    expect(row).toBeTruthy();
    const payload = (await q("select public.get_engagement_delivery_payload($1,$2) p", [row.id, lease])).rows[0].p;
    expect(payload).toMatchObject({ available: true, category: "welcome", transactional: false, path: "/m" });
    expect(payload.body).toContain("Read the contract");
    expect(payload.unsubscribeToken.split(".").slice(0, 2)).toEqual([ID.newcomer, "welcome"]);
    await q("set local role service_role");
    const applied = (await q("select public.apply_engagement_email_unsubscribe($1) r", [payload.unsubscribeToken])).rows[0].r;
    await q("reset role");
    expect(applied).toEqual({ applied: true, category: "welcome" });
    const prefs = (await q("select notification_prefs from public.member_profiles where id=$1", [ID.newcomer])).rows[0].notification_prefs;
    expect(prefs.welcome).toBe(false);
    expect(prefs.announcements).not.toBe(false);
    // An older writer that omits the key cannot re-subscribe the member.
    await q("update public.member_profiles set notification_prefs = '{\"deadlines\": true}'::jsonb where id=$1", [ID.newcomer]);
    expect((await q("select notification_prefs->'welcome' w from public.member_profiles where id=$1", [ID.newcomer])).rows[0].w).toBe(false);
    // Lease-time re-check: the queued row is now suppressed at send.
    expect((await q("select public.get_engagement_delivery_payload($1,$2) p", [row.id, lease])).rows[0].p).toEqual({ available: false, suppressed: true, reason: "recipient_opted_out" });
    await q("rollback to savepoint deliver");
  });

  it("keeps the staff Queue due messages action working through the shared loop", async () => {
    await q("savepoint staff");
    const session = randomUUID();
    await q("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, ID.admin]);
    await q("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), ID.admin]);
    await q("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'admin',$2)", [ID.org, ID.admin]);
    await q("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: ID.admin, role: "authenticated", session_id: session, aal: "aal2" })]);
    await q("set local role authenticated");
    const result = (await q("select public.queue_due_welcome_messages($1) r", [randomUUID()])).rows[0].r;
    await q("reset role");
    expect(result).toEqual({ queuedCount: 2 });
    expect(await outbox(ID.plain, "welcome_campaign")).toHaveLength(1);
    await q("rollback to savepoint staff");
  });
});
