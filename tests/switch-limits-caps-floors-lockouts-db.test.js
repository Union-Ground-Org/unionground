// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

// #8568: fixture dates are built on the Eastern day, the day the readers count;
// the session's current_date is the UTC day, tomorrow from 7 PM Eastern.

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const keys = [
  ["limits.notifications.member_hourly", 12, 1, 60],
  ["limits.notifications.member_daily", 50, 1, 200],
  ["limits.notifications.member_weekly_nudges", 5, 1, 50],
  ["limits.notifications.organization_daily", 20000, 100, 100000],
  ["limits.analytics.anonymity_floor", 25, 25, 200],
  ["limits.intelligence.connection_issue_floor", 25, 15, 200],
  ["limits.analytics.chapter_health_cohort_floor", 25, 25, 100],
  ["limits.security.invitation_admin_hourly", 10, 1, 50],
  ["limits.security.invitation_chapter_daily", 50, 1, 250],
  ["limits.security.invitation_resend_admin_hourly", 20, 1, 100],
  ["limits.security.invitation_resend_per_invite_hourly", 3, 1, 15],
  ["limits.security.invitation_accept_per_15_minutes", 20, 1, 100],
  ["limits.security.event_checkin_wrong_codes", 10, 1, 50],
  ["limits.security.event_checkin_lock_minutes", 15, 5, 1440],
  ["limits.security.mfa_recovery_failures", 5, 1, 25],
  ["limits.security.mfa_recovery_lock_minutes", 15, 5, 1440],
];

live("organization switch limits on an owned disposable database", () => {
  let db;
  const orgs = [randomUUID(), randomUUID()];
  const users = [randomUUID(), randomUUID()];
  const sessions = [randomUUID(), randomUUID()];
  const chapters = orgs.map((org) => `switch-limits-${org.slice(0, 8)}`);
  const setting = (org, key, value) => db.query(
    `insert into public.organization_setting_values(organization_id, setting_key, value, updated_by)
     values($1,$2,$3::jsonb,$4)
     on conflict (organization_id, setting_key) do update set value = excluded.value`,
    [orgs[org], key, JSON.stringify(value), users[org]],
  );
  const asRole = async (role, user, sql, params = []) => {
    await db.query("savepoint switch_role_call");
    try {
      const claims = role === "service_role"
        ? { role }
        : { sub: users[user], role, session_id: sessions[user], aal: "aal2" };
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
      await db.query(`set local role ${role}`);
      const result = await db.query(sql, params);
      await db.query("reset role");
      await db.query("release savepoint switch_role_call");
      return { value: result.rows[0]?.value, code: "" };
    } catch (error) {
      await db.query("rollback to savepoint switch_role_call");
      await db.query("release savepoint switch_role_call");
      return { value: null, code: error.code, message: error.message };
    }
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    for (let index = 0; index < 2; index += 1) {
      await db.query("insert into auth.users(id,email) values($1,$2)", [users[index], `${users[index]}@example.invalid`]);
      await db.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [orgs[index], chapters[index], users[index]]);
      await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,$3)", [chapters[index], orgs[index], 9800 + index]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [orgs[index], users[index]]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [users[index], chapters[index]]);
      await db.query("update public.member_profiles set chapter_id=$2,notification_prefs='{}' where id=$1", [users[index], chapters[index]]);
      await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)", [orgs[index], users[index]]);
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [sessions[index], users[index]]);
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Switch proof','totp','verified',now(),now())", [randomUUID(), users[index]]);
    }
  }, 60000);
  beforeEach(async () => { await db.query("savepoint switch_case"); });
  afterEach(async () => { await db.query("rollback to savepoint switch_case"); });
  afterAll(async () => { await db?.query("rollback").catch(() => {}); await db?.end(); });

  it("registers all defaults and nonzero safety bounds", async () => {
    const { rows } = await db.query(`select key, (default_value #>> '{}')::integer as default_value,
      minimum, maximum, category, member_visible
      from public.platform_setting_definitions where key = any($1) order by key`, [keys.map(([key]) => key)]);
    expect(rows).toHaveLength(keys.length);
    for (const [key, fallback, minimum, maximum] of keys) {
      const row = rows.find((entry) => entry.key === key);
      expect(row).toMatchObject({ default_value: fallback, minimum, maximum, member_visible: key === "limits.notifications.member_weekly_nudges" });
      expect(row.category).toBe(key.split(".")[1]);
    }
  });

  it("refuses values below and above every registry bound", async () => {
    for (const [key, , minimum, maximum] of keys) {
      const { rows } = await db.query(`select
        private.setting_value_valid(d.value_kind, to_jsonb($2::integer), d.minimum, d.maximum, d.allowed_values) as below,
        private.setting_value_valid(d.value_kind, to_jsonb($3::integer), d.minimum, d.maximum, d.allowed_values) as above
        from public.platform_setting_definitions d where d.key=$1`, [key, minimum - 1, maximum + 1]);
      expect(rows[0], key).toEqual({ below: false, above: false });
    }
  });

  it("resolves each organization limit independently", async () => {
    await setting(0, "limits.analytics.anonymity_floor", 30);
    await setting(1, "limits.analytics.anonymity_floor", 60);
    const { rows } = await db.query("select private.organization_limit($1,'limits.analytics.anonymity_floor') a, private.organization_limit($2,'limits.analytics.anonymity_floor') b", orgs);
    expect(rows[0]).toEqual({ a: 30, b: 60 });
  });

  it("enforces different weekly nudge caps and keeps organization counters separate", async () => {
    await db.query("update private.notification_controls set outbound_enabled=true where id");
    await setting(0, "limits.notifications.member_weekly_nudges", 1);
    await setting(1, "limits.notifications.member_weekly_nudges", 2);
    for (const [index, expected] of [[0, ["pending", "skipped"]], [1, ["pending", "pending", "skipped"]]]) {
      const statuses = [];
      for (let attempt = 0; attempt < expected.length; attempt += 1) {
        const inserted = await db.query("insert into public.member_notifications(user_id,kind,title,body) values($1,'events','Switch proof','Local only') returning id", [users[index]]);
        const delivered = await db.query("select status from public.member_notification_deliveries where notification_id=$1 and channel='email'", [inserted.rows[0].id]);
        statuses.push(delivered.rows[0]?.status);
      }
      expect(statuses).toEqual(expected);
    }
    const { rows } = await db.query(`select organization_id, sum(enqueued)::integer as count
      from private.organization_notification_outbound_counters
      where organization_id = any($1) group by organization_id`, [orgs]);
    expect(rows).toEqual(expect.arrayContaining([
      { organization_id: orgs[0], count: 1 }, { organization_id: orgs[1], count: 2 },
    ]));
  });

  it("enforces member-hour and organization-day caps at the enqueue trigger", async () => {
    await db.query("update private.notification_controls set outbound_enabled=true where id");
    await setting(0, "limits.notifications.member_hourly", 1);
    const enqueue = async () => {
      const { rows } = await db.query("insert into public.member_notifications(user_id,kind,title,body) values($1,'deadlines','Switch proof','Local only') returning id", [users[0]]);
      const delivery = await db.query("select status,last_error from public.member_notification_deliveries where notification_id=$1 and channel='email'", [rows[0].id]);
      return delivery.rows[0];
    };
    expect((await enqueue()).status).toBe("pending");
    expect(await enqueue()).toMatchObject({ status: "skipped", last_error: "rate limited: recipient hour" });

    await setting(0, "limits.notifications.member_hourly", 60);
    await setting(0, "limits.notifications.organization_daily", 100);
    await db.query(`update private.organization_notification_outbound_counters
      set enqueued=100 where organization_id=$1 and day=(now() at time zone 'America/New_York')::date`, [orgs[0]]);
    expect(await enqueue()).toMatchObject({ status: "skipped", last_error: "rate limited: org day" });
  });

  it("retains channel-message delivery with tenant caps and recipient preferences", async () => {
    await db.query("update private.notification_controls set outbound_enabled=true where id");
    await setting(0, "limits.notifications.member_hourly", 1);
    const enqueue = async () => {
      const inserted = await db.query("insert into public.member_notifications(user_id,kind,title,body) values($1,'messages','Channel reminder','Local only') returning id", [users[0]]);
      return (await db.query("select status,last_error from public.member_notification_deliveries where notification_id=$1 and channel='email'", [inserted.rows[0].id])).rows;
    };
    expect(await enqueue()).toEqual([{ status: "pending", last_error: null }]);
    expect(await enqueue()).toEqual([{ status: "skipped", last_error: "rate limited: recipient hour" }]);
    await db.query("update public.member_profiles set notification_prefs=$2::jsonb where id=$1", [users[0], JSON.stringify({ messages: false })]);
    expect(await enqueue()).toEqual([]);
  });

  it("uses the tenant floors in authenticated analytics and chapter health reads", async () => {
    // Both floors are never below 25 (#7010); each tenant's own higher value applies.
    await setting(0, "limits.analytics.anonymity_floor", 30);
    await setting(0, "limits.analytics.chapter_health_cohort_floor", 26);
    await setting(1, "limits.analytics.anonymity_floor", 40);
    for (const [index, floor] of [[0, 30], [1, 40]]) {
      const snapshot = await asRole("authenticated", index, "select public.get_organization_analytics_snapshot() value");
      expect(snapshot, snapshot.message).toMatchObject({ code: "", value: { organizationId: orgs[index], privacyThreshold: floor } });
      const workspace = await asRole("authenticated", index, "select public.get_organization_analytics_workspace() value");
      expect(workspace, workspace.message).toMatchObject({ code: "", value: { organizationId: orgs[index], privacyThreshold: floor, chapterHealthFloor: index === 0 ? 26 : 25 } });
    }
  });

  it("uses separate organization acceptance buckets without revealing a token lookup", async () => {
    await setting(0, "limits.security.invitation_accept_per_15_minutes", 1);
    await setting(1, "limits.security.invitation_accept_per_15_minutes", 2);
    const hashes = orgs.map((org) => createHash("sha256").update(`switch-accept:${org}`).digest("hex"));
    const scope = createHash("sha256").update("switch-accept:network").digest("hex");
    for (let index = 0; index < 2; index += 1) {
      await db.query(`insert into public.member_invitations
        (normalized_email, full_name, first_name, initials, chapter_id, token_hash, expires_at)
        values($1,'Switch Proof','Switch','SP',$2,$3,now()+interval '1 day')`,
      [`switch-${index}-${orgs[index]}@example.invalid`, chapters[index], hashes[index]]);
    }
    const call = (hash) => asRole("service_role", 0,
      "select public.consume_member_invitation_accept_limit_for_token($1,$2) value", [scope, hash]);
    expect((await call(hashes[0])).value).toMatchObject({ allowed: true, remaining: 0 });
    expect((await call(hashes[0])).value).toMatchObject({ allowed: false, remaining: 0 });
    expect((await call(hashes[1])).value).toMatchObject({ allowed: true, remaining: 1 });
    expect((await call(hashes[1])).value).toMatchObject({ allowed: true, remaining: 0 });
    expect((await call(hashes[1])).value).toMatchObject({ allowed: false, remaining: 0 });
  });

  it("keeps the reviewed guards while reading every remaining setting at its enforcement site", async () => {
    const pins = [
      ["public.freeze_chapter_connection_issue_aggregates(text,text)", "limits.intelligence.connection_issue_floor", "private.chapter_connection_require_hat"],
      ["public.get_chapter_health_portfolio()", "limits.analytics.chapter_health_cohort_floor", "private.can_manage_chapter_health"],
      // Unit-required creation lives in the seven-argument core.
      ["public.create_member_invitation(text,text,text,text,text,text,uuid)", "limits.security.invitation_admin_hourly", "private.member_has_chapter_role"],
      ["public.resend_member_invitation(uuid,text)", "limits.security.invitation_resend_per_invite_hourly", "private.member_has_chapter_role"],
      ["public.check_in_to_event(text,text)", "limits.security.event_checkin_wrong_codes", "private.member_can_access_event_scope"],
      ["public.claim_mfa_recovery_code(text)", "limits.security.mfa_recovery_failures", "private.current_member_session_id"],
    ];
    for (const [signature, key, guard] of pins) {
      const { rows } = await db.query("select pg_get_functiondef($1::regprocedure) as definition", [signature]);
      expect(rows[0].definition, signature).toContain(key);
      expect(rows[0].definition, signature).toContain(guard);
    }
  });
});
