// @vitest-environment node
//
// Restore-everything lane L7b AUTOMATION-2, live on a disposable database:
//   REQ-UG-MINUTES-PRE-EVENT-DISPATCH-20261001
//   REQ-UG-SCHEDULED-EXPORTS-PARITY-20261001
//   REQ-UG-RETENTION-DEFAULT-POLICIES-20261001
//   REQ-UG-TRUSTED-SOURCE-STALENESS-CHECK-20261001
// Every case runs inside one transaction that is rolled back.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

async function seed(client) {
  const ids = Object.fromEntries([
    "org", "otherOrg", "admin", "adminSession", "coordinator", "coordinatorSession",
    "steward", "stewardSession", "member", "memberSession",
  ].map((key) => [key, randomUUID()]));
  ids.chapter = `l7b-${ids.org}`;
  ids.otherChapter = `l7b-other-${ids.org}`;
  const people = [
    [ids.admin, ids.adminSession, ["admin"]],
    [ids.coordinator, ids.coordinatorSession, ["coordinator"]],
    [ids.steward, ids.stewardSession, ["steward"]],
    [ids.member, ids.memberSession, []],
  ];
  for (const [user, session] of people) {
    await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
    await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
    await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic L7b factor','totp','verified',now(),now())", [randomUUID(), user]);
  }
  await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [ids.org, `l7b-${ids.org}`, ids.admin]);
  await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [ids.otherOrg, `l7b-other-${ids.org}`, ids.admin]);
  await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9940)", [ids.chapter, ids.org]);
  await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9941)", [ids.otherChapter, ids.org]);
  await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [ids.org]);
  for (const [user, , roles] of people) {
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.org, user]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, ids.chapter]);
    await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user, ids.chapter, `L7b Person ${user.slice(0, 8)}`]);
    for (const role of roles) {
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$2)", [ids.org, user, role]);
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing", [user, role, ids.chapter]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing", [user, role, ids.chapter]);
    }
  }
  return ids;
}

async function withFixture(run) {
  const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "l7b-automation-proof" });
  await client.connect();
  await client.query("begin");
  try {
    await client.query("set local statement_timeout = '60s'");
    const ids = await seed(client);
    const sessions = {
      [ids.admin]: ids.adminSession,
      [ids.coordinator]: ids.coordinatorSession,
      [ids.steward]: ids.stewardSession,
      [ids.member]: ids.memberSession,
    };
    const as = async (user, role = "authenticated") => {
      await client.query("reset role");
      await client.query("select set_config('request.jwt.claims',$1,true)",
        [JSON.stringify({ role, sub: user, session_id: sessions[user], aal: "aal2" })]);
      await client.query(`set local role ${role}`);
    };
    // pg_cron runs the jobs as the database owner with no JWT at all.
    const asScheduler = async () => {
      await client.query("reset role");
      await client.query("select set_config('request.jwt.claims','',true)");
    };
    const asService = async () => {
      await client.query("reset role");
      await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "service_role" })]);
      await client.query("set local role service_role");
    };
    let savepoint = 0;
    const refused = async (statement, params) => {
      const label = `l7b_${++savepoint}`;
      await client.query(`savepoint ${label}`);
      let caught;
      try { await client.query(statement, params); } catch (error) { caught = error; }
      finally { await client.query(`rollback to savepoint ${label}`); await client.query(`release savepoint ${label}`); }
      expect(caught, "statement should have been refused").toBeDefined();
      return caught;
    };
    const one = async (sql, params) => (await client.query(sql, params)).rows[0];
    const setSwitch = async (key, value) => {
      await asScheduler();
      await client.query(
        "insert into public.organization_setting_values(organization_id,setting_key,value) values($1,$2,$3::jsonb) on conflict (organization_id,setting_key) do update set value=excluded.value",
        [ids.org, key, JSON.stringify(value)]);
    };
    await run(client, ids, { as, asScheduler, asService, refused, one, setSwitch });
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

async function minutes(client, ids, as, { title = "June minutes", visibility = "chapter", action = "save" } = {}) {
  await as(ids.admin);
  const saved = (await client.query(
    "select public.save_institutional_record(null,'minutes',$1,'Agenda and minutes body',now(),$2,$3) as v",
    [title, visibility, action])).rows[0].v;
  return saved;
}

async function meeting(client, ids, asScheduler, { startsIn = "2 hours", chapter = ids.chapter } = {}) {
  await asScheduler();
  const id = `l7b-meeting-${randomUUID().slice(0, 12)}`;
  await client.query(
    "insert into public.member_events(id,title,starts_at,location,summary,check_in_code,order_index,chapter_id) values($1,'General meeting',now()+$2::interval,'Hall','Monthly meeting','SG-L7B123',(select coalesce(max(order_index),0)+1 from public.member_events where chapter_id=$3),$3)",
    [id, startsIn, chapter]);
  return id;
}

live("pre-meeting minutes notice", () => {
  it("waits for publication, then notifies the chapter once through the events kind", async () => {
    await withFixture(async (client, ids, { as, asScheduler, one, refused }) => {
      const record = await minutes(client, ids, as);
      const eventId = await meeting(client, ids, asScheduler);
      await as(ids.admin);
      const workspace = (await one("select public.get_minutes_pre_event_notices() as v")).v;
      expect(workspace).toMatchObject({ enabled: true, defaultHours: 24 });
      expect(workspace.events.map((event) => event.id)).toContain(eventId);
      expect((await refused("select public.save_minutes_pre_event_notice($1,$2,'all_members',0)", [record.id, eventId])).code).toBe('22023');
      const saved = (await one("select public.save_minutes_pre_event_notice($1,$2,'all_members',3) as v", [record.id, eventId])).v;
      expect(saved).toMatchObject({ recordId: record.id, eventId, audience: "all_members", hoursBefore: 3, status: "scheduled" });

      await asScheduler();
      await client.query("select private.dispatch_minutes_pre_event_notices(50)");
      expect((await one("select status from private.meeting_minutes_event_notices where record_id=$1", [record.id])).status).toBe("scheduled");

      await as(ids.admin);
      await client.query("select public.save_institutional_record($1,'minutes',$2,'Agenda and minutes body',now(),'chapter','publish',false,null,$3)", [record.id, record.title, record.version]);
      await asScheduler();
      expect((await one("select private.dispatch_minutes_pre_event_notices(50) as n")).n).toBeGreaterThanOrEqual(1);
      const sent = await one("select status, outcome, recipient_count from private.meeting_minutes_event_notices where record_id=$1", [record.id]);
      expect(sent).toEqual({ status: "sent", outcome: "delivered", recipient_count: 4 });
      const notices = (await client.query(
        "select user_id, kind, title, body from public.member_notifications where title = 'Meeting materials are ready' and user_id = any($1::uuid[])",
        [[ids.admin, ids.coordinator, ids.steward, ids.member]])).rows;
      expect(notices).toHaveLength(4);
      expect(notices.every((row) => row.kind === "events" && row.body.includes("General meeting"))).toBe(true);

      await client.query("select private.dispatch_minutes_pre_event_notices(50)");
      expect((await one("select count(*)::int n from public.member_notifications where title = 'Meeting materials are ready' and user_id = $1", [ids.member])).n).toBe(1);
    });
  });

  it("tells only the chapter's staff for stewards_only and keeps a staff-only record away from members", async () => {
    await withFixture(async (client, ids, { as, asScheduler, refused, one }) => {
      const record = await minutes(client, ids, as, { title: "Staff minutes", visibility: "staff", action: "publish" });
      const eventId = await meeting(client, ids, asScheduler, { startsIn: "1 hour" });
      await as(ids.admin);
      const refusal = await refused("select public.save_minutes_pre_event_notice($1,$2,'all_members',null)", [record.id, eventId]);
      expect(refusal.code).toBe("22023");
      await client.query("select public.save_minutes_pre_event_notice($1,$2,'stewards_only',null)", [record.id, eventId]);
      await asScheduler();
      await client.query("select private.dispatch_minutes_pre_event_notices(50)");
      const recipients = (await client.query(
        "select user_id from public.member_notifications where title = 'Meeting materials are ready' and user_id = any($1::uuid[]) order by user_id",
        [[ids.admin, ids.coordinator, ids.steward, ids.member]])).rows.map((row) => row.user_id);
      expect(recipients.sort()).toEqual([ids.admin, ids.coordinator, ids.steward].sort());
      expect((await one("select recipient_count from private.meeting_minutes_event_notices where record_id=$1", [record.id])).recipient_count).toBe(3);
    });
  });

  it("refuses members, other chapters' meetings and a switched-off organization, and expires instead of announcing a started meeting", async () => {
    await withFixture(async (client, ids, { as, asScheduler, refused, one, setSwitch }) => {
      const record = await minutes(client, ids, as);
      const eventId = await meeting(client, ids, asScheduler);
      const otherEvent = await meeting(client, ids, asScheduler, { chapter: ids.otherChapter });
      await as(ids.member);
      expect((await refused("select public.save_minutes_pre_event_notice($1,$2,'all_members',null)", [record.id, eventId])).code).toBe("42501");
      await as(ids.admin);
      expect((await refused("select public.save_minutes_pre_event_notice($1,$2,'all_members',null)", [record.id, otherEvent])).code).toBe("P0002");
      expect((await refused("select public.save_minutes_pre_event_notice($1,$2,'specific_unit',null)", [record.id, eventId])).code).toBe("22023");
      expect((await refused("select public.save_minutes_pre_event_notice($1,$2,'all_members',337)", [record.id, eventId])).code).toBe("22023");
      await client.query("select public.save_minutes_pre_event_notice($1,$2,'all_members',1)", [record.id, eventId]);

      // Draft minutes and the meeting already under way: expired, never sent.
      await asScheduler();
      await client.query("update public.member_events set starts_at = now() - interval '5 minutes' where id=$1", [eventId]);
      await client.query("select private.dispatch_minutes_pre_event_notices(50)");
      expect(await one("select status, outcome from private.meeting_minutes_event_notices where record_id=$1", [record.id]))
        .toEqual({ status: "expired", outcome: "record_not_published" });

      await setSwitch("features.automation.minutes_pre_event_notice", false);
      const fresh = await meeting(client, ids, asScheduler);
      await as(ids.admin);
      expect((await one("select public.get_minutes_pre_event_notices() as v")).v.enabled).toBe(false);
      expect((await refused("select public.save_minutes_pre_event_notice($1,$2,'all_members',null)", [record.id, fresh])).code).toBe("42501");
      await as(ids.admin);
      expect((await one("select public.clear_minutes_pre_event_notice($1) as v", [record.id])).v).toEqual({ recordId: record.id, removed: true });
    });
  });
});

live("scheduled export parity", () => {
  async function schedule(client, ids, asScheduler, config) {
    await asScheduler();
    const id = randomUUID();
    await client.query(
      "insert into public.organization_coordination_records(id,organization_id,kind,title,status,visibility,config,created_by,idempotency_key) values($1,$2,'network_export_schedule','Nightly export','active','staff',$3::jsonb,$4,$5)",
      [id, ids.org, JSON.stringify({ cadence: "daily", format: "csv", deliveryMode: "internal_download", nextRunAt: new Date(Date.now() - 60_000).toISOString(), ...config }), ids.admin, randomUUID()]);
    return id;
  }

  it("keeps the restored datasets behind the organization switch and records skipped runs", async () => {
    await withFixture(async (client, ids, { asScheduler, asService, refused, one, setSwitch }) => {
      await asScheduler();
      const refusal = await refused(
        "insert into public.organization_coordination_records(organization_id,kind,title,status,visibility,config,created_by,idempotency_key) values($1,'network_export_schedule','Directory','active','staff',$2::jsonb,$3,$4)",
        [ids.org, JSON.stringify({ cadence: "daily", format: "csv", deliveryMode: "internal_download", nextRunAt: new Date().toISOString(), dataset: "members_directory" }), ids.admin, randomUUID()]);
      expect(refusal.code).toBe("23514");
      expect((await refused(
        "insert into public.organization_coordination_records(organization_id,kind,title,status,visibility,config,created_by,idempotency_key) values($1,'network_export_schedule','Bad','active','staff',$2::jsonb,$3,$4)",
        [ids.org, JSON.stringify({ cadence: "daily", format: "csv", deliveryMode: "internal_download", nextRunAt: new Date().toISOString(), dataset: "payroll" }), ids.admin, randomUUID()])).code).toBe("23514");

      await setSwitch("features.automation.scheduled_dataset_exports", true);
      const scheduleId = await schedule(client, ids, asScheduler, { dataset: "events" });
      await setSwitch("features.automation.scheduled_dataset_exports", false);
      await asService();
      await client.query("select public.run_due_organization_coordination_exports(now(), 50)");
      await asScheduler();
      expect(await one("select dataset, status, delivery_note, row_count from public.organization_coordination_export_runs where schedule_id=$1", [scheduleId]))
        .toEqual({ dataset: "events", status: "skipped", delivery_note: "dataset_disabled", row_count: 0 });
    });
  });

  it("exports the directory as name, role and chapter to admins only, and events without check-in codes", async () => {
    await withFixture(async (client, ids, { as, asScheduler, asService, refused, one, setSwitch }) => {
      await setSwitch("features.automation.scheduled_dataset_exports", true);
      const directory = await schedule(client, ids, asScheduler, { dataset: "members_directory" });
      const events = await schedule(client, ids, asScheduler, { dataset: "events", format: "json" });
      await meeting(client, ids, asScheduler);
      await asService();
      expect((await one("select public.run_due_organization_coordination_exports(now(), 50) as v")).v.processed).toBeGreaterThanOrEqual(2);
      await asScheduler();
      const directoryRun = await one("select id, status, row_count from public.organization_coordination_export_runs where schedule_id=$1", [directory]);
      expect(directoryRun).toMatchObject({ status: "ready", row_count: 4 });

      await as(ids.admin);
      const payload = (await one("select public.get_organization_coordination_export_payload($1) as v", [directoryRun.id])).v;
      expect(payload.dataset).toBe("members_directory");
      expect(payload.content.split("\n")[0]).toBe('"name","role","chapter"');
      expect(payload.content).toContain('"admin"');
      expect(payload.content).not.toContain("@example.invalid");
      expect(payload.table.columns).toEqual(["name", "role", "chapter"]);
      expect(payload.table.rows).toHaveLength(4);

      await as(ids.coordinator);
      expect((await refused("select public.get_organization_coordination_export_payload($1)", [directoryRun.id])).code).toBe("42501");
      expect((await refused("select public.run_organization_coordination_export($1,'csv',$2)", [directory, randomUUID()])).code).toBe("42501");
      const manual = (await one("select public.run_organization_coordination_export($1,'json',$2) as v", [events, randomUUID()])).v;
      expect(manual).toMatchObject({ status: "ready", dataset: "events", rowCount: 1 });
      const eventsPayload = (await one("select public.get_organization_coordination_export_payload($1) as v", [manual.runId])).v;
      const rows = JSON.parse(eventsPayload.content);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ title: "General meeting", location: "Hall" });
      expect(JSON.stringify(rows)).not.toContain("SG-L7B123");
    });
  });

  it("settles queued email and SFTP runs through the service seam and keeps them downloadable", async () => {
    await withFixture(async (client, ids, { as, asScheduler, asService, refused, one }) => {
      const emailSchedule = await schedule(client, ids, asScheduler, { deliveryMode: "email_unset" });
      const sftpSchedule = await schedule(client, ids, asScheduler, { deliveryMode: "sftp_unset" });
      await asService();
      await client.query("select public.run_due_organization_coordination_exports(now(), 50)");
      await asScheduler();
      expect((await one("select status from public.organization_coordination_export_runs where schedule_id=$1", [emailSchedule])).status).toBe("queued");

      await as(ids.admin);
      expect((await refused("select public.claim_organization_export_deliveries(10)")).code).toBe("42501");
      await asService();
      const claimed = (await one("select public.claim_organization_export_deliveries(10) as v")).v
        .filter((item) => item.organizationId === ids.org);
      expect(claimed).toHaveLength(2);
      const email = claimed.find((item) => item.deliveryMode === "email_unset");
      const sftp = claimed.find((item) => item.deliveryMode === "sftp_unset");
      expect(email.recipient).toEqual({ email: `${ids.admin}@example.invalid`, lang: "en" });
      expect((await one("select public.claim_organization_export_deliveries(10) as v")).v.filter((item) => item.organizationId === ids.org)).toEqual([]);
      expect((await refused("select public.complete_organization_export_delivery($1,'not_configured',null)", [email.runId])).code).toBe("22023");
      await client.query("select public.complete_organization_export_delivery($1,'delivered',null)", [email.runId]);
      await client.query("select public.complete_organization_export_delivery($1,'not_configured','sftp_transport_unavailable')", [sftp.runId]);
      expect((await refused("select public.complete_organization_export_delivery($1,'delivered',null)", [email.runId])).code).toBe("22023");
      await asScheduler();
      expect((await client.query(
        "select schedule_id, status, delivery_note, delivered_at is not null as delivered from public.organization_coordination_export_runs where schedule_id = any($1::uuid[]) order by status",
        [[emailSchedule, sftpSchedule]])).rows).toEqual([
        { schedule_id: emailSchedule, status: "delivered", delivery_note: null, delivered: true },
        { schedule_id: sftpSchedule, status: "not_configured", delivery_note: "sftp_transport_unavailable", delivered: false },
      ]);
      await as(ids.admin);
      for (const runId of [email.runId, sftp.runId]) {
        const payload = (await one("select public.get_organization_coordination_export_payload($1) as v", [runId])).v;
        expect(payload.content.split("\n")[0]).toBe("id,kind,title,status,visibility,updated_at");
      }
    });
  });
});

live("retention default policies", () => {
  it("shows every retention policy with execution off until an admin enables it", async () => {
    await withFixture(async (client, ids, { as, one }) => {
      await as(ids.admin);
      const engine = (await one("select public.get_organization_retention_engine() as v")).v;
      const byClass = Object.fromEntries(engine.policies.map((policy) => [policy.dataClass, policy]));
      expect(byClass.member_notifications).toMatchObject({ retentionDays: 365, configured: false, executionEnabled: false, defaultExecutionEnabled: false });
      expect(byClass.ai_assistant_conversations).toMatchObject({ retentionDays: 180, executionEnabled: false });
      expect(byClass.ai_usage_counters).toMatchObject({ retentionDays: 30, executionEnabled: false });
      expect(byClass.organization_page_views).toMatchObject({ retentionDays: 180, executionEnabled: false });
      expect(byClass.member_message_bodies).toMatchObject({ retentionDays: 1095, executionEnabled: false, defaultExecutionEnabled: false });
    });
  });

  it("seeds visible disabled policies without deleting data, then deletes only after explicit admin enablement", async () => {
    await withFixture(async (client, ids, { as, asScheduler, one }) => {
      await asScheduler();
      await client.query("insert into public.member_notifications(user_id,organization_id,title,body,created_at) values ($1,$2,'Old','old',now()-interval '400 days'),($1,$2,'New','new',now()-interval '10 days')", [ids.member,ids.org]);
      const oldThread = (await one("insert into public.member_guide_threads(user_id,title,created_at,updated_at) values ($1,'Old chat',now()-interval '300 days',now()-interval '300 days') returning id", [ids.member])).id;
      await client.query("insert into public.member_guide_messages(user_id,thread_id,role,body,created_at) values ($1,$2,'user','old question',now()-interval '300 days')", [ids.member, oldThread]);
      await client.query("insert into public.member_ai_requests(user_id,created_at) values ($1,now()-interval '40 days')", [ids.member]);
      await client.query("insert into public.organization_page_views(organization_id,path,hat,day,view_count) values ($1,'/m/home','member',current_date-200,3),($1,'/m/home','member',current_date-5,2)", [ids.org]);
      await client.query("insert into public.organization_failed_login_attempts(organization_id,member_user_id,identity_hash,method,source,user_agent,occurred_at) values ($1,$2,repeat('a',64),'password','web-saas','Proof',now()-interval '120 days'),($1,$2,repeat('b',64),'password','web-saas','Proof',now()-interval '3 days')", [ids.org, ids.member]);

      await client.query("insert into public.organization_setting_values(organization_id,setting_key,value) values($1,'security.failed_login_retention_days','150'::jsonb)", [ids.org]);
      // The scheduler seeds at most 100 policies per call across all active
      // fixture organizations. Drain the bounded seed backlog before testing
      // idempotence; every scheduler call stays in this rolled-back fixture.
      const seedCalls = (await one("select ceil(count(*) * 10.0 / 100)::int + 1 n from public.organizations where status='active'" )).n;
      for (let batch = 0; batch < seedCalls; batch += 1) {
        const seeded = (await one("select private.run_due_organization_retention_jobs(100) as v")).v;
        expect(seeded.defaultPoliciesRecorded).toBeLessThanOrEqual(100);
        if (seeded.defaultPoliciesRecorded === 0) break;
      }
      expect((await one("select count(*)::int n from public.organization_failed_login_attempts where organization_id=$1", [ids.org])).n).toBe(2);
      await client.query("update public.organization_setting_values set value='90'::jsonb where organization_id=$1 and setting_key='security.failed_login_retention_days'", [ids.org]);
      const result = (await one("select private.run_due_organization_retention_jobs(100) as v")).v;
      expect(result.defaultPoliciesRecorded).toBe(0);
      expect(result.failedSigninsExpired).toBeGreaterThanOrEqual(1);
      const policies = (await client.query(
        "select data_class, retention_days, execution_enabled, updated_by from public.organization_retention_policies where organization_id=$1 order by data_class", [ids.org])).rows;
      expect(policies).toHaveLength(10);
      expect(policies.every((p) => p.execution_enabled === false && p.updated_by === null)).toBe(true);
      expect(policies.find((p) => p.data_class === 'organization_page_views').retention_days).toBe(180);
      expect((await one("select count(*)::int n from public.organization_retention_runs where organization_id=$1", [ids.org])).n).toBe(0);
      expect((await one("select count(*)::int n from public.member_notifications where user_id=$1 and title in ('Old','New')", [ids.member])).n).toBe(2);
      expect((await one("select count(*)::int n from public.organization_page_views where organization_id=$1", [ids.org])).n).toBe(2);
      await as(ids.admin);
      for (const [dataClass, days] of [['member_notifications',365],['ai_assistant_conversations',180],['ai_usage_counters',30],['organization_page_views',180]]) {
        await client.query("select public.upsert_organization_retention_policy($1,$2,true,$3)", [dataClass, days, `ENABLE ${dataClass}`]);
      }
      await asScheduler();
      await client.query("select private.run_due_organization_retention_jobs(100)");
      const runs = (await client.query(
        "select data_class, status, deleted_count, requested_by from public.organization_retention_runs where organization_id=$1 and mode='scheduled' order by data_class", [ids.org])).rows;
      expect(runs).toEqual([
        { data_class: "ai_assistant_conversations", status: "completed", deleted_count: 2, requested_by: null },
        { data_class: "ai_usage_counters", status: "completed", deleted_count: 1, requested_by: null },
        { data_class: "member_notifications", status: "completed", deleted_count: 1, requested_by: null },
        { data_class: "organization_page_views", status: "completed", deleted_count: 1, requested_by: null },
      ]);
      expect((await one("select count(*)::int n from public.member_notifications where user_id=$1 and title in ('Old','New')", [ids.member])).n).toBe(1);
      expect((await one("select count(*)::int n from public.organization_page_views where organization_id=$1", [ids.org])).n).toBe(1);
      expect((await one("select count(*)::int n from public.organization_failed_login_attempts where organization_id=$1", [ids.org])).n).toBe(1);
      expect((await one("select count(*)::int n from public.organization_retention_policies where organization_id=$1", [ids.otherOrg])).n).toBe(10);
    });
  });

  it("retains immutable assistant scope across chapter changes and protects unattributed history", async () => {
    await withFixture(async (client, ids, { as, asScheduler, one, refused }) => {
      await asScheduler();
      const elsewhere = `scope-${ids.otherOrg}`;
      await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9950)", [elsewhere, ids.otherOrg]);
      const thread = (await one("insert into public.member_guide_threads(user_id,title,created_at,updated_at) values($1,'Owned A',now()-interval '300 days',now()-interval '300 days') returning id,organization_id", [ids.member]));
      expect(thread.organization_id).toBe(ids.org);
      await client.query("insert into public.member_guide_messages(user_id,thread_id,role,body,created_at) values($1,$2,'user','Org A question',now()-interval '300 days')", [ids.member,thread.id]);
      await client.query("insert into public.member_ai_requests(user_id,created_at) values($1,now()-interval '300 days')", [ids.member]);
      await client.query("insert into public.member_notifications(user_id,title,body,created_at) values($1,'Unattributed','protected',now()-interval '400 days')", [ids.member]);
      // A restored pre-scope row has no trustworthy tenant. Preserve it rather
      // than guessing its organization from today's chapter selection.
      await client.query("set local session_replication_role = replica");
      const legacy = (await one("insert into public.member_guide_threads(user_id,title,created_at,updated_at) values($1,'Legacy',now()-interval '300 days',now()-interval '300 days') returning id", [ids.member])).id;
      await client.query("set local session_replication_role = origin");
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')",[ids.otherOrg,ids.member]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",[ids.member,elsewhere]);
      await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [ids.member,elsewhere]);
      expect((await refused("update public.member_guide_threads set organization_id=$2 where id=$1", [thread.id,ids.otherOrg])).code).toBe('42501');
      expect((await one("select private.retention_eligible_count($1,'ai_assistant_conversations',180) n", [ids.org])).n).toBe(2);
      expect((await one("select private.retention_eligible_count($1,'ai_assistant_conversations',180) n", [ids.otherOrg])).n).toBe(0);
      expect((await one("select private.retention_eligible_count($1,'ai_usage_counters',30) n", [ids.otherOrg])).n).toBe(0);
      expect((await one("select private.retention_eligible_count($1,'member_notifications',365) n", [ids.org])).n).toBe(0);
      await as(ids.member);
      expect((await client.query("select id from public.member_guide_threads where id=any($1::uuid[])", [[thread.id,legacy]])).rows).toEqual([]);
      await as(ids.admin);
      for (const [key,days] of [['ai_assistant_conversations',180],['ai_usage_counters',30],['member_notifications',365]]) {
        await client.query("select public.upsert_organization_retention_policy($1,$2,true,$3)",[key,days,`ENABLE ${key}`]);
      }
      await asScheduler();
      await client.query("select private.run_due_organization_retention_jobs(100)");
      expect((await one("select count(*)::int n from public.member_guide_threads where id=$1",[thread.id])).n).toBe(0);
      expect((await one("select count(*)::int n from public.member_guide_threads where id=$1",[legacy])).n).toBe(1);
      expect((await one("select count(*)::int n from public.member_notifications where user_id=$1 and title='Unattributed'",[ids.member])).n).toBe(1);
    });
  });

  it("redacts messages and unsent drafts only in the conversation organization", async () => {
    await withFixture(async (client, ids, { as, asScheduler, one }) => {
      await asScheduler();
      const own = randomUUID(), foreign = randomUUID();
      await client.query("insert into public.member_conversations(id,user_id,title,organization_id) values($1,$3,'Own',$4),($2,$3,'Foreign',$5)", [own,foreign,ids.member,ids.org,ids.otherOrg]);
      const ownMessage = randomUUID(), foreignMessage = randomUUID();
      await client.query("insert into public.member_messages(id,conversation_id,user_id,sender_kind,sender_name,body,created_at) values($1,$3,$5,'member','Fixture','own body',now()-interval '1200 days'),($2,$4,$5,'member','Fixture','foreign body',now()-interval '1200 days')", [ownMessage,foreignMessage,own,foreign,ids.member]);
      const ownDraft = randomUUID(), foreignDraft = randomUUID();
      await client.query("insert into public.member_scheduled_messages(id,actor_id,conversation_id,recipient_id,sender_kind,body,scheduled_for,created_at) values($1,$3,$4,$6,'member','own draft',now()+interval '1 day',now()-interval '1200 days'),($2,$3,$5,$6,'member','foreign draft',now()+interval '1 day',now()-interval '1200 days')",[ownDraft,foreignDraft,ids.member,own,foreign,ids.steward]);
      expect((await one("select private.retention_eligible_count($1,'member_message_bodies',1095) n",[ids.org])).n).toBe(2);
      await as(ids.admin);
      await client.query("select public.upsert_organization_retention_policy('member_message_bodies',1095,true,'ENABLE member_message_bodies')");
      await asScheduler();
      await client.query("select private.run_due_organization_retention_jobs(100)");
      const messages = (await client.query("select id,redacted_at is not null redacted from public.member_messages where id=any($1::uuid[]) order by id",[[ownMessage,foreignMessage]])).rows;
      expect(messages.find(row=>row.id===ownMessage).redacted).toBe(true);
      expect(messages.find(row=>row.id===foreignMessage).redacted).toBe(false);
      expect((await one("select redacted_at is not null redacted from public.member_scheduled_messages where id=$1",[ownDraft])).redacted).toBe(true);
      expect((await one("select body from public.member_scheduled_messages where id=$1",[foreignDraft])).body).toBe('foreign draft');
    });
  });

  it("requires the confirmation phrase on first enablement and every re-enable", async () => {
    await withFixture(async (client, ids, { as, refused, one }) => {
      await as(ids.admin);
      expect((await refused("select public.upsert_organization_retention_policy('member_notifications',200,true,null)")).code).toBe("22023");
      await client.query("select public.upsert_organization_retention_policy('member_notifications',200,true,'ENABLE member_notifications')");
      await client.query("select public.upsert_organization_retention_policy('member_notifications',200,false,null)");
      expect((await refused("select public.upsert_organization_retention_policy('member_notifications',200,true,null)")).code).toBe("22023");
      await client.query("select public.upsert_organization_retention_policy('member_notifications',200,true,'ENABLE member_notifications')");
      expect((await refused("select public.upsert_organization_retention_policy('member_message_bodies',1095,true,null)")).code).toBe("22023");
      const engine = (await one("select public.get_organization_retention_engine() as v")).v;
      expect(engine.policies.find((policy) => policy.dataClass === "member_notifications")).toMatchObject({ configured: true, retentionDays: 200, executionEnabled: true });
    });
  });
});

live("trusted source health check", () => {
  it("rolls up stale, pending and failed sources hourly and shows them to knowledge staff only", async () => {
    await withFixture(async (client, ids, { as, asScheduler, refused, one, setSwitch }) => {
      await asScheduler();
      const fileId = (await one(
        "insert into public.organization_knowledge_files(organization_id,title,file_name,byte_size,storage_path,review_status,scan_status,index_status,updated_at) values($1,'Old contract','contract.pdf',100,$2,'approved','clean','failed',now()-interval '400 days') returning id",
        [ids.org, `${ids.org}/contract.pdf`])).id;
      await client.query(
        "insert into public.organization_knowledge_sources(organization_id,file_id,source_kind,label,health,last_ingest_at,created_at) values($1,$2,'steward_file','Contract source','failed',now()-interval '300 days',now()-interval '300 days')",
        [ids.org, fileId]);
      await client.query(
        "insert into public.member_kb_articles(slug,kind,title,article_ref,body,chapter_id,status,content_origin,created_by,updated_by,verified_by,verified_at,updated_at) values($1,'rights','Weingarten rights','Art. 1','Body',$2,'published','authored',$3,$3,$3,now()-interval '200 days',now()-interval '200 days')",
        [`l7b-${ids.org}`, ids.chapter, ids.admin]);

      expect((await one("select private.run_knowledge_source_health_checks(500) as n")).n).toBeGreaterThanOrEqual(1);
      const health = await one(
        "select article_total, article_stale, document_total, document_stale, document_failed, source_total, source_stale, source_failed, stale_days from private.organization_knowledge_source_health where organization_id=$1",
        [ids.org]);
      expect(health).toEqual({
        article_total: 1, article_stale: 1, document_total: 1, document_stale: 1, document_failed: 1,
        source_total: 1, source_stale: 1, source_failed: 1, stale_days: 180,
      });
      // Not again within the hour.
      await client.query("select private.run_knowledge_source_health_checks(500)");

      await as(ids.admin);
      const read = (await one("select public.get_knowledge_source_health() as v")).v;
      expect(read).toMatchObject({ enabled: true, staleDays: 180, articles: { total: 1, stale: 1 }, sources: { failed: 1 } });
      expect(read.attention.map((item) => [item.kind, item.reason]).sort()).toEqual([["article", "stale"], ["document", "failed"], ["source", "failed"]]);
      await as(ids.member);
      expect((await refused("select public.get_knowledge_source_health()")).code).toBe("42501");

      await setSwitch("features.intelligence.trusted_source_health_check", false);
      await setSwitch("limits.intelligence.trusted_source_stale_days", 365);
      await asScheduler();
      await client.query("update private.organization_knowledge_source_health set checked_at = now() - interval '2 hours' where organization_id=$1", [ids.org]);
      await client.query("select private.run_knowledge_source_health_checks(500)");
      expect((await one("select stale_days from private.organization_knowledge_source_health where organization_id=$1", [ids.org])).stale_days).toBe(180);
      await as(ids.admin);
      expect((await one("select public.get_knowledge_source_health() as v")).v).toMatchObject({ enabled: false, staleDays: 365, attention: [] });
    });
  });
});
