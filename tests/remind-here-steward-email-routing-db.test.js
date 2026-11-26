// @vitest-environment node
//
// REQ-UG-REMIND-HERE-20261001
// REQ-UG-STEWARD-EMAIL-AUTO-ROUTING-20261001
//
// Live proof on a disposable database for
// supabase/migrations/20261003033000_remind_here_and_steward_email_routing.sql:
//   * /remind here: only channel staff who can post in the channel create one,
//     the organization switch is enforced at creation and at fire time, the
//     channel's CURRENT staff (and nobody outside the tenant, the channel or
//     the staff two-step) are notified once through the notification pipeline
//     (topic preference, quiet hours), and the note never leaves its row except
//     through a re-authorized read;
//   * steward email: a signed email routes to exactly one case of its own
//     chapter or to an unpublished knowledge draft only when its sender is a
//     reviewer of that chapter and the switch is on; every unclear email stays
//     in the manual queue with a hold code, every route is audited, and the
//     attached email is staff-only.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const MIGRATION = "20261003033000_remind_here_and_steward_email_routing.sql";
const migration = readFileSync(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), "utf8");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("remind here and steward email routing migration (static)", () => {
  it("is registered in the required database proof lane", () => {
    expect(PROOF_FILES).toContain("tests/remind-here-steward-email-routing-db.test.js");
  });

  it("pins the new RPCs and the private receipt table in the database contract", () => {
    for (const sig of [
      "public.create_channel_here_reminder(p_space_id uuid, p_remind_at timestamp with time zone, p_note text)",
      "public.list_channel_here_reminders(p_limit integer)",
      "public.list_case_steward_emails(p_case_id uuid)",
    ]) {
      expect(contract.functions).toContainEqual(expect.objectContaining({ sig, secdef: true, exec: "authenticated" }));
    }
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(contract.tableGrants).toContainEqual({ table: "private.channel_here_reminder_deliveries", role, privileges: "" });
    }
  });

  it("adds the three switches with the old defaults without overwriting a registry row", () => {
    expect(migration).toMatch(/\('features\.messaging\.remind_here', 'boolean'[\s\S]*?'true', null, null, null, 90, 'messaging', true\)/);
    expect(migration).toMatch(/\('features\.messaging\.steward_email_auto_route_cases', 'boolean'[\s\S]*?'false', null, null, null, 100, 'messaging', false\)/);
    expect(migration).toMatch(/\('features\.messaging\.steward_email_auto_route_knowledge', 'boolean'[\s\S]*?'false', null, null, null, 110, 'messaging', false\)/);
    expect(migration).toMatch(/110, 'messaging', false\)\s*\non conflict \(key\) do nothing;/);
  });

  it("keeps the here-reminder notification free of the note and the channel in both languages", () => {
    const rows = [...migration.matchAll(/\('reminder\.here', '(en|es)', '([^']+)', '([^']+)'\)/g)];
    expect(rows).toHaveLength(2);
    for (const [, , title, body] of rows) expect(`${title} ${body}`).not.toMatch(/\{(?!name\})/);
  });

  it("puts every new writer behind the case-graph gate first", () => {
    for (const name of [
      "public.create_channel_here_reminder(",
      "private.dispatch_due_here_reminders(",
      "private.route_steward_email_intake(",
      "public.ingest_steward_email(",
    ]) {
      const start = migration.indexOf(`function ${name}`);
      expect(start, name).toBeGreaterThan(-1);
      const body = migration.slice(migration.indexOf("$function$", start) + "$function$".length);
      expect(body.trimStart(), name).toMatch(/^begin\s+perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);/);
    }
  });
});

const ID = {
  orgA: "50917000-0000-4000-8000-00000000000a",
  orgB: "50917000-0000-4000-8000-00000000000b",
  adminA: "50917000-0000-4000-8000-000000000101",
  stewardA: "50917000-0000-4000-8000-000000000102",
  coordinatorA: "50917000-0000-4000-8000-000000000103",
  memberA: "50917000-0000-4000-8000-000000000104",
  stewardNoFactor: "50917000-0000-4000-8000-000000000105",
  stewardTwo: "50917000-0000-4000-8000-000000000106",
  memberTwo: "50917000-0000-4000-8000-000000000107",
  stewardB: "50917000-0000-4000-8000-000000000201",
  memberB: "50917000-0000-4000-8000-000000000202",
  spaceChapter: "50917000-0000-4000-8000-000000000401",
  spacePrivate: "50917000-0000-4000-8000-000000000402",
  spaceB: "50917000-0000-4000-8000-000000000403",
};
const SESSION = Object.fromEntries(["adminA", "stewardA", "coordinatorA", "memberA", "stewardB", "stewardTwo"].map((key, index) => [key, `50917000-0000-4000-8000-0000000003${String(index).padStart(2, "0")}`]));
const CHAPTER_A = "l8-proof-a";
const CHAPTER_B = "l8-proof-b";
const NOTE = "Bring the overtime binder to the stand-down review";
const HERE_TITLE_SUFFIX = "set a reminder for channel staff";
const emailOf = (key) => `l8-${key.toLowerCase()}@example.invalid`;
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("remind here and steward email routing on a disposable database", () => {
  let db;
  const q = (sql, params) => db.query(sql, params);

  async function as(key, work) {
    await q("savepoint act_as");
    try {
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: ID[key], role: "authenticated", session_id: SESSION[key], aal: "aal2",
      })]);
      await q("set local role authenticated");
      const result = await work();
      await q("reset role");
      await q("select set_config('request.jwt.claims', '', true)");
      await q("release savepoint act_as");
      return result;
    } catch (error) {
      await q("rollback to savepoint act_as");
      await q("reset role");
      throw error;
    }
  }
  async function asService(work) {
    await q("savepoint act_as");
    try {
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
      await q("set local role service_role");
      const result = await work();
      await q("reset role");
      await q("select set_config('request.jwt.claims', '', true)");
      await q("release savepoint act_as");
      return result;
    } catch (error) {
      await q("rollback to savepoint act_as");
      await q("reset role");
      throw error;
    }
  }
  const setSwitch = (org, key, value) => q(
    `insert into public.organization_setting_values(organization_id,setting_key,value) values($1,$2,$3::jsonb)
     on conflict (organization_id, setting_key) do update set value = excluded.value`, [org, key, JSON.stringify(value)]);
  const hereNotices = async (userId) => (await q(
    "select title,body,kind from public.member_notifications where user_id=$1 and title like $2 order by created_at,id",
    [userId, `%${HERE_TITLE_SUFFIX}`],
  )).rows;

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "remind-here-steward-email-routing-proof",
    });
    await db.connect();
    await q("begin");
    await q("set local statement_timeout = '60s'");
    await q("set local lock_timeout = '15s'");
    // Only this proof's reminders are due inside the transaction.
    await q("update public.member_message_reminders set remind_at = now() + interval '300 days' where status = 'scheduled'");
    await q("update private.notification_controls set outbound_enabled = true where id");
    const users = Object.keys(ID).filter((key) => !key.startsWith("org") && !key.startsWith("space"));
    for (const key of users) {
      await q("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [ID[key], emailOf(key)]);
    }
    await q("insert into public.organizations(id,slug,name,created_by) values($1,'l8-proof-a','L8 proof one',$2),($3,'l8-proof-b','L8 proof two',$4)",
      [ID.orgA, ID.adminA, ID.orgB, ID.stewardB]);
    await q("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9941),($3,$3,$3,$4,false,9942)",
      [CHAPTER_A, ID.orgA, CHAPTER_B, ID.orgB]);
    const placement = [
      [ID.orgA, CHAPTER_A, ["adminA", "stewardA", "coordinatorA", "memberA", "stewardNoFactor", "stewardTwo", "memberTwo"]],
      [ID.orgB, CHAPTER_B, ["stewardB", "memberB"]],
    ];
    for (const [org, chapter, members] of placement) {
      for (const key of members) {
        await q("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, ID[key]]);
        await q("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [ID[key], chapter]);
        await q("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [ID[key], chapter, `Proof ${key}`]);
      }
    }
    for (const [org, key, role] of [
      [ID.orgA, "adminA", "admin"], [ID.orgA, "stewardA", "steward"], [ID.orgA, "coordinatorA", "coordinator"],
      [ID.orgA, "stewardNoFactor", "steward"], [ID.orgA, "stewardTwo", "steward"], [ID.orgB, "stewardB", "steward"],
    ]) {
      await q("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$2)", [org, ID[key], role]);
    }
    for (const key of ["adminA", "stewardA", "coordinatorA", "stewardTwo", "stewardB"]) {
      await q(`insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
               values(gen_random_uuid(),$1,'l8-totp','totp','verified',now(),now())`, [ID[key]]);
    }
    for (const key of Object.keys(SESSION)) {
      await q("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [SESSION[key], ID[key]]);
    }
    // private.stamp_product_identity stamps chapter_id and created_by from the
    // creating session, so each channel is created under its creator's claims.
    for (const [space, creator, name, visibility] of [
      [ID.spaceChapter, "adminA", "l8 general", "chapter"],
      [ID.spacePrivate, "stewardA", "l8 private", "private"],
      [ID.spaceB, "stewardB", "l8 other tenant", "chapter"],
    ]) {
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ID[creator], role: "authenticated" })]);
      await q("insert into public.chapter_spaces(id,name,visibility) values($1,$2,$3)", [space, name, visibility]);
    }
    await q("select set_config('request.jwt.claims', '', true)");
    await q("insert into public.chapter_space_members(space_id,user_id) values($1,$2),($1,$3)", [ID.spacePrivate, ID.stewardA, ID.memberA]);

    // #8589 re-final: committed data gives every steward grant its migration

    // assignments; an organization grant reaches only chapters it has one in.

    await migrateLegacyStewardFixtures(db);
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await q("rollback").catch(() => {});
      await db.end();
    }
  });

  describe("/remind here", () => {
    let reminderId;
    const soon = () => new Date(Date.now() + 3_600_000).toISOString();
    const create = (key, space, at, note = NOTE) => as(key, async () => (await q(
      "select public.create_channel_here_reminder($1,$2::timestamptz,$3) r", [space, at, note])).rows[0].r);

    it("registers the switch ON and member-visible, with the old app's no-flag default", async () => {
      const row = (await q("select default_value, category, member_visible from public.platform_setting_definitions where key='features.messaging.remind_here'")).rows[0];
      expect(row).toEqual({ default_value: true, category: "messaging", member_visible: true });
      const member = await as("memberA", async () => (await q("select public.get_member_organization_configuration() c")).rows[0].c);
      expect(member.switches["features.messaging.remind_here"]).toBe(true);
      expect(member.switches).not.toHaveProperty("features.messaging.steward_email_auto_route_cases");
    });

    it("lets channel staff who can post in the channel set one, audited, and coalesces a retry", async () => {
      const at = soon();
      const created = await create("stewardA", ID.spaceChapter, at);
      expect(created).toMatchObject({ status: "scheduled", coalesced: false });
      reminderId = created.id;
      const retry = await create("stewardA", ID.spaceChapter, at);
      expect(retry).toMatchObject({ id: reminderId, coalesced: true });
      const row = (await q("select audience, source_kind, source_ref, status, note from public.member_message_reminders where id=$1", [reminderId])).rows[0];
      expect(row).toEqual({ audience: "here", source_kind: "space", source_ref: ID.spaceChapter, status: "scheduled", note: NOTE });
      const audit = (await q("select domain, event_type, action, actor_user_id, metadata from public.organization_audit_ledger where entity_id=$1", [reminderId])).rows;
      expect(audit).toEqual([{ domain: "messages", event_type: "message.remind_here.created", action: "create", actor_user_id: ID.stewardA,
        metadata: { sourceKind: "space", sourceId: ID.spaceChapter } }]);
    });

    it("refuses members, other tenants, unreadable channels, staff without two-step and bad input", async () => {
      await expect(create("memberA", ID.spaceChapter, soon())).rejects.toMatchObject({ code: "42501", detail: "staff-required" });
      await expect(create("stewardB", ID.spaceChapter, soon())).rejects.toMatchObject({ code: "42501", message: "channel unavailable" });
      await expect(create("stewardTwo", ID.spacePrivate, soon())).rejects.toMatchObject({ code: "42501", message: "channel unavailable" });
      await expect(create("stewardA", randomUUID(), soon())).rejects.toMatchObject({ code: "42501", message: "channel unavailable" });
      await expect(create("stewardA", ID.spaceChapter, new Date(Date.now() - 60_000).toISOString())).rejects.toMatchObject({ code: "22023" });
      await expect(create("stewardA", ID.spaceChapter, new Date(Date.now() + 400 * 86_400_000).toISOString())).rejects.toMatchObject({ code: "22023" });
      await expect(create("stewardA", ID.spaceChapter, soon(), "   ")).rejects.toMatchObject({ code: "22023" });
      await expect(create("stewardA", ID.spaceChapter, soon(), "x".repeat(501))).rejects.toMatchObject({ code: "22023" });
      // A browser cannot write the table directly.
      await expect(as("stewardA", () => q("insert into public.member_message_reminders(owner_id,source_kind,source_ref,audience,note,remind_at,status) values($1,'space',$2,'here','x',now()+interval '1 hour','scheduled')",
        [ID.stewardA, ID.spaceChapter]))).rejects.toMatchObject({ code: "42501" });
    });

    it("enforces the organization switch on creation", async () => {
      await setSwitch(ID.orgA, "features.messaging.remind_here", false);
      await expect(create("stewardA", ID.spaceChapter, soon(), "another")).rejects.toMatchObject({ code: "42501", detail: "feature-disabled" });
      await setSwitch(ID.orgA, "features.messaging.remind_here", true);
    });

    it("notifies the channel's current staff once, through the pipeline, without the note", async () => {
      // adminA turned the Channel mentions topic off: in-app only, no email or push.
      await q("update public.member_profiles set notification_prefs = notification_prefs || '{\"messages\": false}'::jsonb where id=$1", [ID.adminA]);
      await q("update public.member_message_reminders set remind_at = now() - interval '1 minute' where id=$1", [reminderId]);
      const result = (await q("select private.dispatch_due_here_reminders(50) r")).rows[0].r;
      expect(result).toMatchObject({ delivered: 1, failed: 0, error: false });
      const status = (await q("select status, delivered_at is not null as delivered from public.member_message_reminders where id=$1", [reminderId])).rows[0];
      expect(status).toEqual({ status: "delivered", delivered: true });

      for (const key of ["adminA", "stewardA", "coordinatorA", "stewardTwo"]) {
        const rows = await hereNotices(ID[key]);
        expect(rows, key).toEqual([{ title: `Proof stewardA ${HERE_TITLE_SUFFIX}`, body: "Open Messages, then Reminders, to read it.", kind: "messages" }]);
      }
      // Not a member, not staff without the required two-step, not another tenant.
      for (const key of ["memberA", "memberTwo", "stewardNoFactor", "stewardB", "memberB"]) expect(await hereNotices(ID[key]), key).toEqual([]);
      // The note never left its row.
      const copies = (await q("select count(*)::int n from public.member_notifications where title like $1 or body like $1", [`%${NOTE.slice(0, 20)}%`])).rows[0].n;
      expect(copies).toBe(0);
      const columns = (await q("select column_name from information_schema.columns where table_schema='private' and table_name='channel_here_reminder_deliveries' order by ordinal_position")).rows.map((row) => row.column_name);
      expect(columns).toEqual(["reminder_id", "recipient_id", "delivered_at", "delivery_status", "suppression_reason"]);

      const outbound = async (key) => (await q(
        "select count(*)::int n from public.member_notification_deliveries d join public.member_notifications n on n.id=d.notification_id where d.user_id=$1 and n.title like $2",
        [ID[key], `%${HERE_TITLE_SUFFIX}`])).rows[0].n;
      expect(await outbound("stewardA")).toBeGreaterThan(0);
      expect(await outbound("adminA")).toBe(0);

      const audit = (await q("select event_type, action, metadata from public.organization_audit_ledger where entity_id=$1 and event_type like '%delivered'", [reminderId])).rows;
      expect(audit).toEqual([{ event_type: "message.remind_here.delivered", action: "send", metadata: { sourceKind: "space", sourceId: ID.spaceChapter, deliveredCount: 4, suppressedCount: 0 } }]);

      // A second tick changes nothing.
      expect((await q("select private.dispatch_due_here_reminders(50) r")).rows[0].r).toMatchObject({ delivered: 0, failed: 0 });
      expect(await hereNotices(ID.stewardA)).toHaveLength(1);
    });

    it("records mute and level-none suppression per recipient without notifying them", async () => {
      await q("savepoint here_preference_proof");
      try {
        await as("stewardA", () => q("select public.set_channel_mute($1, true, null)", [ID.spaceChapter]));
        await as("coordinatorA", () => q("select public.set_channel_notification_level($1, 'none')", [ID.spaceChapter]));
        const before = Object.fromEntries(await Promise.all(["adminA", "stewardA", "coordinatorA", "stewardTwo"].map(async (key) => [key, (await hereNotices(ID[key])).length])));
        const id = (await create("stewardA", ID.spaceChapter, soon(), "preferences proof note")).id;
        await q("update public.member_message_reminders set remind_at = now() - interval '1 minute' where id=$1", [id]);
        expect((await q("select private.dispatch_due_here_reminders(50) r")).rows[0].r).toMatchObject({ delivered: 1, failed: 0, error: false });
        const receipts = (await q("select recipient_id, delivery_status, suppression_reason from private.channel_here_reminder_deliveries where reminder_id=$1", [id])).rows;
        expect(receipts).toEqual(expect.arrayContaining([
          { recipient_id: ID.stewardA, delivery_status: "suppressed", suppression_reason: "muted" },
          { recipient_id: ID.coordinatorA, delivery_status: "suppressed", suppression_reason: "level_none" },
          { recipient_id: ID.adminA, delivery_status: "delivered", suppression_reason: null },
          { recipient_id: ID.stewardTwo, delivery_status: "delivered", suppression_reason: null },
        ]));
        expect(receipts).toHaveLength(4);
        expect((await hereNotices(ID.stewardA)).length).toBe(before.stewardA);
        expect((await hereNotices(ID.coordinatorA)).length).toBe(before.coordinatorA);
        expect((await hereNotices(ID.adminA)).length).toBe(before.adminA + 1);
        expect((await hereNotices(ID.stewardTwo)).length).toBe(before.stewardTwo + 1);
        const audit = (await q("select metadata from public.organization_audit_ledger where entity_id=$1 and event_type='message.remind_here.delivered'", [id])).rows[0];
        expect(audit.metadata).toMatchObject({ deliveredCount: 2, suppressedCount: 2 });
      } finally {
        await q("rollback to savepoint here_preference_proof");
        await q("release savepoint here_preference_proof");
      }
    });

    it("holds quiet hours at claim time like every other channel notice", async () => {
      await q(`update public.member_profiles
                  set quiet_hours_timezone = 'America/New_York',
                      quiet_hours_start = ((now() at time zone 'America/New_York') - interval '1 hour')::time,
                      quiet_hours_end = ((now() at time zone 'America/New_York') + interval '1 hour')::time,
                      urgent_notifications_enabled = false
                where id=$1`, [ID.stewardTwo]);
      expect((await q("select private.member_focus_blocks($1,'messages') b", [ID.stewardTwo])).rows[0].b).toBe(true);
      const pending = (await q(
        "select d.id, d.user_id from public.member_notification_deliveries d join public.member_notifications n on n.id=d.notification_id where d.channel='email' and d.status='pending' and n.title like $1 and d.user_id = any($2::uuid[])",
        [`%${HERE_TITLE_SUFFIX}`, [ID.stewardTwo, ID.stewardA]])).rows;
      expect(pending.map((row) => row.user_id).sort()).toEqual([ID.stewardA, ID.stewardTwo].sort());
      const claimed = new Set((await q("select public.claim_notification_deliveries('email', 500) rows")).rows[0].rows.map((row) => row.deliveryId));
      for (const row of pending) expect(claimed.has(row.id), row.user_id).toBe(row.user_id === ID.stewardA);
    });

    it("lets each recipient read the note through a fresh access check, and nobody else", async () => {
      const read = (key) => as(key, async () => (await q("select public.list_channel_here_reminders(50) r")).rows[0].r);
      const coordinator = await read("coordinatorA");
      expect(coordinator).toEqual([expect.objectContaining({
        id: reminderId, note: NOTE, spaceId: ID.spaceChapter, spaceName: "l8 general", authorName: "Proof stewardA", mine: false,
      })]);
      expect((await read("stewardA"))[0]).toMatchObject({ id: reminderId, mine: true });
      expect(await read("memberA")).toEqual([]);
      expect(await read("stewardB")).toEqual([]);
      // Losing the staff role ends the read immediately.
      await q("delete from public.organization_role_grants where organization_id=$1 and user_id=$2", [ID.orgA, ID.coordinatorA]);
      expect(await read("coordinatorA")).toEqual([]);
      await q("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)", [ID.orgA, ID.coordinatorA]);
      // The owner sees it as a channel reminder with nothing to open or snooze.
      const owner = await as("stewardA", async () => (await q("select public.list_connected_workflow_reminders(null, 25, 'open') r")).rows[0].r);
      expect(owner.items.find((item) => item.id === reminderId)).toMatchObject({
        kind: "channel_here", audience: "here", note: NOTE, status: "delivered", available: true, href: null, title: "l8 general",
      });
      // Cancelling withdraws it from every recipient.
      await as("stewardA", () => q("select public.act_on_connected_workflow_reminder($1,'cancel',null)", [reminderId]));
      expect(await read("coordinatorA")).toEqual([]);
    });

    it("reaches only the private channel's own staff, and re-checks the switch and creator at fire time", async () => {
      const privateReminder = (await create("stewardA", ID.spacePrivate, soon(), "private agenda")).id;
      const switchedOff = (await create("stewardA", ID.spaceChapter, new Date(Date.now() + 7_200_000).toISOString(), "switched off later")).id;
      const leaver = (await create("stewardTwo", ID.spaceChapter, soon(), "creator leaves")).id;
      await q("update public.member_message_reminders set remind_at = now() - interval '1 minute' where id = any($1::uuid[])", [[privateReminder, switchedOff, leaver]]);
      await q("delete from public.organization_role_grants where organization_id=$1 and user_id=$2", [ID.orgA, ID.stewardTwo]);

      const before = Object.fromEntries(await Promise.all(["adminA", "stewardA", "coordinatorA"].map(async (key) => [key, (await hereNotices(ID[key])).length])));
      // Private channel first, with the switch on.
      await q("update public.member_message_reminders set remind_at = now() + interval '1 day' where id=$1", [switchedOff]);
      expect((await q("select private.dispatch_due_here_reminders(50) r")).rows[0].r).toMatchObject({ delivered: 1, failed: 1 });
      expect((await hereNotices(ID.stewardA)).length).toBe(before.stewardA + 1);
      expect((await hereNotices(ID.adminA)).length).toBe(before.adminA);
      expect((await hereNotices(ID.coordinatorA)).length).toBe(before.coordinatorA);
      expect((await q("select status from public.member_message_reminders where id=$1", [leaver])).rows[0].status).toBe("failed");

      await setSwitch(ID.orgA, "features.messaging.remind_here", false);
      await q("update public.member_message_reminders set remind_at = now() - interval '1 minute' where id=$1", [switchedOff]);
      expect((await q("select private.dispatch_due_here_reminders(50) r")).rows[0].r).toMatchObject({ delivered: 0, failed: 1 });
      expect((await q("select status from public.member_message_reminders where id=$1", [switchedOff])).rows[0].status).toBe("failed");
      expect((await hereNotices(ID.stewardA)).length).toBe(before.stewardA + 1);
      await setSwitch(ID.orgA, "features.messaging.remind_here", true);
    });

    it("exports the audience with the owner's reminders and drops receipts with the recipient", async () => {
      const exported = (await q("select private.account_lifecycle_export_member_message_reminders($1) e", [ID.stewardA])).rows[0].e;
      expect(exported.find((row) => row.id === reminderId)).toMatchObject({ audience: "here", source_kind: "space", note: NOTE });
      const receipts = async () => (await q("select count(*)::int n from private.channel_here_reminder_deliveries where recipient_id=$1", [ID.coordinatorA])).rows[0].n;
      expect(await receipts()).toBeGreaterThan(0);
      const fk = (await q(`select confdeltype from pg_constraint where conrelid='private.channel_here_reminder_deliveries'::regclass and contype='f' order by conname`)).rows.map((row) => row.confdeltype);
      expect(fk).toEqual(["c", "c"]);
    });
  });

  describe("steward email routing", () => {
    let caseOne;
    let caseRestricted;
    let caseB;
    let sequence = 0;
    const ingest = async (from, subject, text, chapter = CHAPTER_A, authenticated = true) => {
      sequence += 1;
      const digest = (await q("select encode(extensions.digest($1, 'sha256'), 'hex') d", [`l8-proof-${sequence}-${randomUUID()}`])).rows[0].d;
      const result = await asService(async () => (await q("select public.ingest_steward_email($1,$2,$3,$4,$5,now(),$6) r", [digest, chapter, from, subject, text, authenticated])).rows[0].r);
      const row = (await q("select * from public.steward_email_intakes where provider_message_digest=$1", [digest])).rows[0];
      return { result, row };
    };
    const memberCase = async (owner, reference, { steward = null, restricted = false } = {}) => {
      const id = randomUUID();
      await q(`insert into public.member_cases(id,user_id,reference,title,case_type,step,status,steward_user_id,is_restricted,restricted_by,restriction_reason,restricted_at)
               values($1,$2,$3,'Night shift grievance','other','Step 1','active',$4,$5,
                      case when $5 then $4::uuid end, case when $5 then 'Proof restriction' end, case when $5 then now() end)`,
      [id, owner, reference, steward, restricted]);
      return id;
    };

    beforeAll(async () => {
      caseOne = await memberCase(ID.memberA, "GR-2026-40917", { steward: ID.stewardA });
      caseRestricted = await memberCase(ID.memberTwo, "GR-2026-40918", { steward: ID.adminA, restricted: true });
      caseB = await memberCase(ID.memberB, "GR-2026-40919", { steward: ID.stewardB });
      await memberCase(ID.memberA, "GR-2026-40920");
      await memberCase(ID.memberTwo, "GR-2026-40920");
    });

    it("ships both switches OFF (old intake default) and leaves an email in the queue", async () => {
      const rows = (await q("select key, default_value, member_visible from public.platform_setting_definitions where key like 'features.messaging.steward_email_auto_route_%' order by key")).rows;
      expect(rows).toEqual([
        { key: "features.messaging.steward_email_auto_route_cases", default_value: false, member_visible: false },
        { key: "features.messaging.steward_email_auto_route_knowledge", default_value: false, member_visible: false },
      ]);
      const { result, row } = await ingest(emailOf("stewardA"), "Evidence for GR-2026-40917", "Timeline attached. #knowledge");
      expect(result).toEqual({ accepted: true, duplicate: false });
      expect(row).toMatchObject({ status: "pending", routed_case_id: null, knowledge_article_id: null, auto_routed_at: null, auto_route_hold: null });
    });

    it("attaches a steward's evidence email to exactly that case, staff-only and audited", async () => {
      await setSwitch(ID.orgA, "features.messaging.steward_email_auto_route_cases", true);
      const unverified = await ingest(emailOf("stewardA"), "GR-2026-40917", "Evidence attached.", CHAPTER_A, false);
      expect(unverified.row).toMatchObject({ status: "pending", routed_case_id: null, sender_authenticated: false, auto_route_hold: "sender_unverified" });
      const { row } = await ingest(emailOf("stewardA").toUpperCase(), "Fwd: discipline letter", "Case GR-2026-40917: adding this as evidence.\n> quoted GR-2026-40920 timeline");
      expect(row).toMatchObject({ status: "accepted", routed_case_id: caseOne, knowledge_article_id: null, auto_route_hold: null, reviewed_by: null });
      expect(row.auto_routed_at).not.toBeNull();
      const event = (await q("select event_type, entity_type, entity_id, actor_user_id, metadata from public.casework_audit_events where case_id=$1 and entity_type='steward_email'", [caseOne])).rows;
      expect(event).toEqual([{ event_type: "entity_linked", entity_type: "steward_email", entity_id: row.id, actor_user_id: ID.stewardA, metadata: { source: "steward_email", automatic: true } }]);
      const ledger = (await q("select domain, event_type, action, entity_type, entity_id, metadata from public.organization_audit_ledger where metadata->>'sourceId'=$1", [row.id])).rows;
      expect(ledger).toEqual([{ domain: "casework", event_type: "casework.steward_email_attached", action: "create", entity_type: "case", entity_id: caseOne,
        metadata: { sourceKind: "steward_email", sourceId: row.id, outcome: "routed" } }]);
      // No member-visible case note, no body copy.
      expect((await q("select count(*)::int n from public.member_case_updates where case_id=$1", [caseOne])).rows[0].n).toBe(0);
      // Staff who can open the case read it; the member who owns the case does not.
      const staff = await as("stewardA", async () => (await q("select public.list_case_steward_emails($1) r", [caseOne])).rows[0].r);
      expect(staff).toEqual([expect.objectContaining({ id: row.id, subject: "Fwd: discipline letter" })]);
      await expect(as("memberA", () => q("select public.list_case_steward_emails($1)", [caseOne]))).rejects.toMatchObject({ code: "P0002" });
      await expect(as("stewardB", () => q("select public.list_case_steward_emails($1)", [caseOne]))).rejects.toMatchObject({ code: "P0002" });
      const queue = await as("stewardA", async () => (await q("select public.list_steward_email_intakes('accepted', 50) r")).rows[0].r);
      expect(queue.find((item) => item.id === row.id)).toMatchObject({ routedCase: { id: caseOne, reference: "GR-2026-40917" }, knowledgeDraft: false, routeHold: null });
    });

    it("keeps every unclear email in the manual queue with a hold code", async () => {
      const cases = [
        [emailOf("stewardA"), "GR-2026-40917 status", "Just checking in.", null],
        ["someone@example.invalid", "GR-2026-40917", "Evidence attached.", "sender_unknown"],
        [emailOf("memberA"), "GR-2026-40917", "Evidence attached.", "sender_not_steward"],
        [emailOf("stewardNoFactor"), "GR-2026-40917", "Evidence attached.", "sender_not_steward"],
        [emailOf("stewardA"), "GR-2026-40919", "Evidence attached.", "case_not_found"],
        [emailOf("stewardA"), "GR-2026-40920", "Evidence attached.", "case_ambiguous"],
        [emailOf("stewardA"), "GR-2026-40917 and GR-2026-40918", "Evidence for both.", "case_ambiguous"],
        [emailOf("stewardA"), "2026-40918", "Case note follows.", "case_access"],
      ];
      for (const [from, subject, text, hold] of cases) {
        const { row } = await ingest(from, subject, text);
        expect(row, subject).toMatchObject({ status: "pending", routed_case_id: null, auto_routed_at: null, auto_route_hold: hold });
      }
      expect((await q("select count(*)::int n from public.casework_audit_events where case_id = any($1::uuid[]) and entity_type='steward_email'", [[caseRestricted, caseB]])).rows[0].n).toBe(0);
      // The assigned steward of the restricted case (an admin) routes it.
      const { row } = await ingest(emailOf("adminA"), "2026-40918", "Case note follows.");
      expect(row).toMatchObject({ status: "accepted", routed_case_id: caseRestricted });
    });

    it("never routes another tenant's email into this tenant, and honours that tenant's switch", async () => {
      const { row } = await ingest(emailOf("stewardB"), "GR-2026-40919", "Evidence attached.", CHAPTER_B);
      expect(row).toMatchObject({ status: "pending", routed_case_id: null, auto_route_hold: null });
      await setSwitch(ID.orgB, "features.messaging.steward_email_auto_route_cases", true);
      const second = await ingest(emailOf("stewardB"), "GR-2026-40919", "Evidence attached.", CHAPTER_B);
      expect(second.row).toMatchObject({ status: "accepted", routed_case_id: caseB });
    });

    it("turns a #knowledge email into an unpublished draft, never a published article", async () => {
      const { row: off } = await ingest(emailOf("stewardA"), "Overtime rules", "#knowledge How overtime is assigned.");
      expect(off).toMatchObject({ status: "pending", knowledge_article_id: null });
      await setSwitch(ID.orgA, "features.messaging.steward_email_auto_route_knowledge", true);
      const { row } = await ingest(emailOf("stewardA"), "Overtime rules", "#knowledge How overtime is assigned.\n> quoted reply line");
      expect(row).toMatchObject({ status: "accepted", routed_case_id: null });
      const article = (await q("select status, verified_by, verified_at, created_by, chapter_id, kind, title, body, content_origin, keywords from public.member_kb_articles where id=$1", [row.knowledge_article_id])).rows[0];
      expect(article).toEqual({
        status: "draft", verified_by: null, verified_at: null, created_by: ID.stewardA, chapter_id: CHAPTER_A,
        kind: "faq", title: "Overtime rules", body: "#knowledge How overtime is assigned.", content_origin: "authored", keywords: ["email-intake"],
      });
      const revisions = (await q("select status, changed_by, verified_by from public.member_kb_article_revisions where article_id=$1", [row.knowledge_article_id])).rows;
      expect(revisions).toEqual([{ status: "draft", changed_by: ID.stewardA, verified_by: null }]);
      // Members never read a draft.
      const memberRead = await as("memberA", async () => (await q("select count(*)::int n from public.member_kb_articles where id=$1", [row.knowledge_article_id])).rows[0].n);
      expect(memberRead).toBe(0);
      const ledger = (await q("select domain, event_type, entity_type, metadata from public.organization_audit_ledger where entity_id=$1", [row.knowledge_article_id])).rows;
      expect(ledger).toEqual([{ domain: "knowledge", event_type: "knowledge.steward_email_draft_created", entity_type: "document",
        metadata: { sourceKind: "steward_email", sourceId: row.id, reviewStatus: "draft", outcome: "routed" } }]);
      // A member's #knowledge email is held, not drafted.
      const { row: held } = await ingest(emailOf("memberA"), "Tip", "knowledge base idea");
      expect(held).toMatchObject({ status: "pending", knowledge_article_id: null, auto_route_hold: "sender_not_steward" });
    });

    it("keeps replay control: a re-delivered email is a duplicate and is not routed again", async () => {
      const digest = (await q("select encode(extensions.digest('l8-replay', 'sha256'), 'hex') d")).rows[0].d;
      const send = () => asService(async () => (await q("select public.ingest_steward_email($1,$2,$3,'GR-2026-40917','Evidence again.',now(),true) r", [digest, CHAPTER_A, emailOf("stewardA")])).rows[0].r);
      expect(await send()).toEqual({ accepted: true, duplicate: false });
      expect(await send()).toEqual({ accepted: true, duplicate: true });
      expect((await q("select count(*)::int n from public.casework_audit_events where case_id=$1 and entity_type='steward_email'", [caseOne])).rows[0].n).toBe(2);
      await expect(as("stewardA", () => q("select public.ingest_steward_email($1,$2,$3,'x','y',now())", [digest, CHAPTER_A, emailOf("stewardA")])))
        .rejects.toMatchObject({ code: "42501" });
    });
  });
});
