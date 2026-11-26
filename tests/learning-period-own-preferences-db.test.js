// @vitest-environment node
//
// REQ-UG-LEARNING-PERIOD-PREFERENCE-TABLES-JOURNAL-20261104 (#7027):
// the five smaller own-preference areas the design marks practice (My
// Reports, workload reminders, platform updates, the Compass workspace and a
// chapter space's notifications) are journalled during the learning period
// and undone by the person who made them, once; a repeat undo changes
// nothing. SMS consent stays real: it is never journalled.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { stripComments } from "./helpers/migration.js";
import { releaseLearningPeriodHold } from "./helpers/learningPeriodHold.js";

const FILE = "20261105182000_learning_period_own_preference_tables.sql";
const sql = readFileSync(`supabase/migrations/${FILE}`, "utf8");
const code = stripComments(sql);
const WRITERS = {
  "public.save_my_report_preferences": ["own_report_preferences", "public.member_report_preferences"],
  "public.set_workload_reminder_preferences": ["own_workload_reminder", "private.workload_reminder_preferences"],
  "public.set_my_platform_announcement_preference": ["own_platform_update_preference", "private.platform_announcement_preferences"],
  "public.save_compass_workspace_preferences": ["own_compass_workspace", "public.compass_workspace_preferences"],
  "private.save_channel_notification_settings": ["own_channel_notifications", "public.chapter_space_notification_settings"],
};

function latestDefinitions() {
  const latest = new Map();
  for (const file of readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).sort()) {
    for (const fn of parseFunctions(readFileSync(`supabase/migrations/${file}`, "utf8"))) latest.set(fn.name, fn.source);
  }
  return latest;
}

describe("learning period own-preference tables migration (offline)", () => {
  it("journals every writer after its write, with the graph lock first", () => {
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    const functions = parseFunctions(sql);
    for (const [name, [kind, table]] of Object.entries(WRITERS)) {
      const source = functions.find((fn) => fn.name === name).source;
      if (name === "private.save_channel_notification_settings") {
        // Its own first statement, unchanged: the lock for the person whose row it writes.
        expect(source.replace(/^[\s\S]*?\bbegin\b\s*/i, "").startsWith("perform private.lock_case_graph(array[p_user_id], array[]::uuid[]);"), name).toBe(true);
      } else {
        expect(helperFirst(source), name).toBe(true);
      }
      expect(source, name).toContain(`private.learning_preference_journal('${kind}', '${table}'`);
      expect(source.indexOf(`private.learning_preference_state('${table}'`), name).toBeGreaterThan(-1);
      expect(source.indexOf(`private.learning_preference_state('${table}'`), name)
        .toBeLessThan(source.indexOf(`private.learning_preference_journal('${kind}'`));
      expect(code).toMatch(new RegExp(`\\('${kind}', 'settings', 'reverse', '${table.replace(".", "\\.")}', false, 'private\\.learning_undo_own_preference',`));
    }
    for (const fn of functions.filter((item) => item.name.startsWith("private.learning_undo_") || item.name === "private.learning_preference_journal")) {
      expect(helperFirst(fn.source), fn.name).toBe(true);
    }
  });

  it("keeps SMS consent real: no kind names its table and its writer never journals", () => {
    expect(code).not.toMatch(/'(public|private)\.member_sms_preferences'/);
    const latest = latestDefinitions();
    for (const name of ["public.set_my_sms_consent", "public.record_twilio_inbound_consent"]) {
      expect(latest.has(name), name).toBe(true);
      expect(latest.get(name), name).not.toMatch(/private\.learning_[a-z_]*journal/);
    }
  });

  it("lists only its own handler and hands every other one to the dispatcher it found installed", () => {
    const dispatch = parseFunctions(sql).find((fn) => fn.name === "private.learning_dispatch").source;
    const own = new Set([...code.matchAll(/'(private\.learning_undo_[a-z_]+)'/g)].map((match) => match[1]));
    expect([...own]).toEqual(["private.learning_undo_own_preference"]);
    expect(dispatch).toContain("when 'private.learning_undo_own_preference' then return private.learning_undo_own_preference(p_mode, p_entry);");
    expect(dispatch).toContain("else return private.learning_dispatch_before_preferences(p_handler, p_mode, p_entry);");
    expect(dispatch).not.toContain("private.learning_undo_own_profile");
    expect(code).toContain("alter function private.learning_dispatch(text, text, jsonb) rename to learning_dispatch_before_preferences;");
    expect(code).toContain("$assert_learning_dispatch_complete$");
  });

  it("checks the keyword limit on a channel undo only when it puts keywords back (20261105191500)", () => {
    const latest = latestDefinitions().get("private.learning_undo_own_preference");
    const original = parseFunctions(sql).find((fn) => fn.name === "private.learning_undo_own_preference").source;
    const guard = "if present and coalesce(image -> 'keywords', '[]'::jsonb)\n           is distinct from coalesce(current_state -> 'keywords', '[]'::jsonb) then";
    expect(latest).toContain(guard);
    expect(latest.indexOf(guard)).toBeLessThan(latest.indexOf("'limits.messaging.keyword_alerts_per_member'"));
    // Otherwise the body 20261105182000 installed.
    const strip = (text) => stripComments(text).replace(/^create (or replace )?function/, "").replace(/\s+/g, " ");
    expect(strip(latest).replace(strip(guard), "if present then")).toBe(strip(original));
  });

  it("never rewrites an audit row, and deletes only the person's own preference row", () => {
    expect(code).not.toMatch(/(update|delete from)\s+public\.(organization_audit_ledger|organization_audit_events)\b/);
    const deletes = [...code.matchAll(/delete from\s+((?:public|private)\.[a-z_]+)/g)].map((match) => match[1]);
    expect(new Set(deletes)).toEqual(new Set(Object.values(WRITERS).map(([, table]) => table)));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("learning period own-preference tables on a disposable database", () => {
  let c;
  let w;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "learning-period-own-preferences-proof" });
    await c.connect();
  });
  afterAll(async () => { await c?.end(); });

  async function call(text, values = [], user = null) {
    await c.query("savepoint call");
    try {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(user
        ? { role: "authenticated", sub: user.id, session_id: user.session, aal: "aal2" }
        : { role: "anon" })]);
      await c.query(user ? "set local role authenticated" : "set local role anon");
      const rows = (await c.query(text, values)).rows;
      await c.query("reset role");
      await c.query("release savepoint call");
      return { ok: true, rows };
    } catch (error) {
      await c.query("rollback to savepoint call");
      await c.query("release savepoint call");
      return { ok: false, code: error.code, message: error.message, detail: error.detail };
    }
  }
  const one = async (...args) => {
    const result = await call(...args);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    return result.rows[0] ? Object.values(result.rows[0])[0] : undefined;
  };
  const q = async (text, values = []) => (await c.query(text, values)).rows;

  async function person(chapter, orgRoles = []) {
    const user = { id: randomUUID(), session: randomUUID() };
    await c.query("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [w.org, user.id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, chapter]);
    await c.query("update public.member_profiles set chapter_id=$2, full_name='Proof Person', language='en' where id=$1", [user.id, chapter]);
    for (const role of orgRoles) {
      await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [w.org, user.id, role]);
      await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [user.id, role, chapter]);
      await c.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [user.id, role, chapter]);
    }
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    return user;
  }

  beforeEach(async () => {
    await c.query("begin");
    await releaseLearningPeriodHold(c);
    const suffix = randomUUID().slice(0, 8);
    w = { org: randomUUID(), a: `learning-prefs-a-${suffix}`, space: randomUUID() };
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [w.org, `learning-prefs-${suffix}`]);
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98417)", [w.a, w.org]);
    w.admin = await person(w.a, ["admin"]);
    w.member = await person(w.a);
    w.other = await person(w.a);
    // stamp_product_identity takes the space's chapter and creator from auth.uid().
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: w.admin.id, role: "authenticated" })]);
    await c.query("insert into public.chapter_spaces (id, name, visibility) values ($1, 'Shop floor', 'chapter')", [w.space]);
    await c.query("select set_config('request.jwt.claims', '', true)");
  });
  afterEach(async () => { await c.query("rollback"); });

  const start = () => one("select public.start_organization_learning_period() as r", [], w.admin);
  const entries = async (table, target) => q("select id, action_kind, state, version, actor_user_id from private.learning_action_journal where target_table = $1 and target_id = $2 order by created_at, id", [table, target]);
  const undo = (user, entry, version = 1) => call("select public.undo_my_learning_action($1, $2) as r", [entry, version], user);
  const undone = async (user, entry, version = 1) => {
    const result = await undo(user, entry, version);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    return result.rows[0].r;
  };

  it("undoes a My Reports change once, only for the person who made it", async () => {
    await start();
    const layout = { order: ["dues", "votes"], hidden: ["hours"], custom: [] };
    await one("select public.save_my_report_preferences($1::jsonb) as r", [JSON.stringify(layout)], w.member);
    const [entry] = await entries("public.member_report_preferences", w.member.id);
    expect(entry).toMatchObject({ action_kind: "own_report_preferences", state: "active", actor_user_id: w.member.id });
    expect(await undo(w.other, entry.id)).toMatchObject({ ok: false, code: "P0002" });
    expect(await undone(w.member, entry.id)).toMatchObject({ status: "undone" });
    // The save created the row, so the undo removes it: My Reports reads "never set" again.
    expect(await q("select config from public.member_report_preferences where user_id = $1", [w.member.id])).toEqual([]);
    expect(await one("select public.get_my_report_preferences() as r", [], w.member)).toBeNull();
    // Repeat undo: nothing changes.
    expect(await undone(w.member, entry.id)).toMatchObject({ status: "already_undone" });
    expect((await entries("public.member_report_preferences", w.member.id)).map((item) => item.state)).toEqual(["undone"]);

    // An earlier layout comes back exactly.
    await one("select public.save_my_report_preferences($1::jsonb) as r", [JSON.stringify(layout)], w.member);
    await one("select public.save_my_report_preferences($1::jsonb) as r", [JSON.stringify({ order: ["votes"], hidden: [], custom: [] })], w.member);
    const later = (await entries("public.member_report_preferences", w.member.id)).at(-1);
    expect(await undone(w.member, later.id)).toMatchObject({ status: "undone", undoneCount: 1 });
    expect((await q("select config from public.member_report_preferences where user_id = $1", [w.member.id]))[0].config).toEqual(layout);
  });

  it("undoes a workload reminder change, and a reminder the sweep sent neither blocks it nor is taken back", async () => {
    // A schedule saved before the period is real.
    await one("select public.set_workload_reminder_preferences(false, 'weekly', 1, 9, 'America/New_York') as r", [], w.member);
    await start();
    await one("select public.set_workload_reminder_preferences(true, 'weekly', 2, 8, 'America/Chicago') as r", [], w.member);
    const [entry] = await entries("private.workload_reminder_preferences", w.member.id);
    expect(entry).toMatchObject({ action_kind: "own_workload_reminder", state: "active" });
    // What the sweep writes after it delivers a reminder.
    await c.query("update private.workload_reminder_preferences set last_sent_at = now(), next_due_at = now() + interval '7 days' where user_id = $1", [w.member.id]);
    expect(await undone(w.member, entry.id)).toMatchObject({ status: "undone" });
    const row = (await q("select enabled, cadence, weekday, local_hour, timezone, next_due_at, last_sent_at is not null as sent from private.workload_reminder_preferences where user_id = $1", [w.member.id]))[0];
    expect(row).toEqual({ enabled: false, cadence: "weekly", weekday: 1, local_hour: 9, timezone: "America/New_York", next_due_at: null, sent: true });
    expect(await undone(w.member, entry.id)).toMatchObject({ status: "already_undone" });

    // Undoing a later change puts the earlier schedule back, with its next reminder worked out again.
    await one("select public.set_workload_reminder_preferences(true, 'monthly', 3, 10, 'America/Denver') as r", [], w.member);
    await one("select public.set_workload_reminder_preferences(false, 'monthly', 3, 10, 'America/Denver') as r", [], w.member);
    const later = (await entries("private.workload_reminder_preferences", w.member.id)).at(-1);
    expect(await undone(w.member, later.id)).toMatchObject({ undoneCount: 1 });
    expect((await q("select enabled, cadence, next_due_at > now() as due from private.workload_reminder_preferences where user_id = $1", [w.member.id]))[0])
      .toEqual({ enabled: true, cadence: "monthly", due: true });
  });

  it("undoes a workload reminder the change created by removing it", async () => {
    await start();
    await one("select public.set_workload_reminder_preferences(true, 'weekly', 2, 8, 'America/Chicago') as r", [], w.member);
    const [entry] = await entries("private.workload_reminder_preferences", w.member.id);
    expect(await undone(w.member, entry.id)).toMatchObject({ status: "undone" });
    expect(await q("select 1 from private.workload_reminder_preferences where user_id = $1", [w.member.id])).toEqual([]);
    expect(await undone(w.member, entry.id)).toMatchObject({ status: "already_undone" });
  });

  it("undoes hiding platform updates once", async () => {
    const read = async () => (await q("select hidden from private.platform_announcement_preferences where organization_id = $1 and user_id = $2", [w.org, w.member.id]))[0] ?? null;
    await start();
    await one("select public.set_my_platform_announcement_preference(true) as r", [], w.member);
    const [entry] = await entries("private.platform_announcement_preferences", `${w.org}:${w.member.id}`);
    expect(entry).toMatchObject({ action_kind: "own_platform_update_preference", state: "active" });
    expect(await undone(w.member, entry.id)).toMatchObject({ status: "undone" });
    // The change created the row, so the undo removes it.
    expect(await read()).toBeNull();
    expect(await undone(w.member, entry.id)).toMatchObject({ status: "already_undone" });
    // A choice that existed before comes back as it was.
    await one("select public.set_my_platform_announcement_preference(true) as r", [], w.member);
    await one("select public.set_my_platform_announcement_preference(false) as r", [], w.member);
    const later = (await entries("private.platform_announcement_preferences", `${w.org}:${w.member.id}`)).at(-1);
    expect(await undone(w.member, later.id)).toMatchObject({ undoneCount: 1 });
    expect(await read()).toEqual({ hidden: true });
  });

  it("undoes a Compass workspace change once, back to the earlier modules", async () => {
    await start();
    await one("select public.save_compass_workspace_preferences($1::jsonb, $2::jsonb) as r", ['["cases","inbox"]', '["polls"]'], w.member);
    await one("select public.save_compass_workspace_preferences($1::jsonb, $2::jsonb) as r", ['["tasks"]', "[]"], w.member);
    const list = await entries("public.compass_workspace_preferences", `${w.org}:${w.member.id}`);
    expect(list.map((item) => item.action_kind)).toEqual(["own_compass_workspace", "own_compass_workspace"]);
    expect(await undone(w.member, list[1].id)).toMatchObject({ undoneCount: 1 });
    const read = async () => (await q("select module_order, hidden_modules from public.compass_workspace_preferences where organization_id = $1 and user_id = $2", [w.org, w.member.id]))[0];
    expect(await read()).toEqual({ module_order: ["cases", "inbox"], hidden_modules: ["polls"] });
    // The first save created the row, so its undo removes it.
    expect(await undone(w.member, list[0].id)).toMatchObject({ undoneCount: 1 });
    expect(await read()).toBeUndefined();
    expect(await undone(w.member, list[0].id)).toMatchObject({ status: "already_undone" });
  });

  it("undoes a chapter space's mute, level and keyword changes, newest first", async () => {
    await start();
    const target = `${w.space}:${w.member.id}`;
    const row = async () => (await q("select notification_level, muted, keywords from public.chapter_space_notification_settings where space_id = $1 and user_id = $2", [w.space, w.member.id]))[0] ?? null;
    await one("select public.set_channel_mute($1, true, null) as r", [w.space], w.member);
    const [mute] = await entries("public.chapter_space_notification_settings", target);
    expect(mute).toMatchObject({ action_kind: "own_channel_notifications", state: "active" });
    expect(await undone(w.member, mute.id)).toMatchObject({ status: "undone" });
    // No row was the defaults, and the channel writer keeps no row for them.
    expect(await row()).toBeNull();
    expect(await undone(w.member, mute.id)).toMatchObject({ status: "already_undone" });

    await one("select public.set_channel_notification_level($1, 'all') as r", [w.space], w.member);
    await one("select public.set_channel_keyword_alerts($1, $2::text[]) as r", [w.space, "{grievance,overtime}"], w.member);
    const [level, keywords] = (await entries("public.chapter_space_notification_settings", target)).filter((item) => item.state === "active");
    expect(await undone(w.member, keywords.id)).toMatchObject({ undoneCount: 1 });
    expect(await row()).toEqual({ notification_level: "all", muted: false, keywords: [] });
    // Undoing the earlier change takes nothing else with it now.
    expect(await undone(w.member, level.id)).toMatchObject({ undoneCount: 1 });
    expect(await row()).toBeNull();
  });

  it("refuses a channel undo cleanly once the space is archived, and changes nothing", async () => {
    await start();
    await one("select public.set_channel_mute($1, true, null) as r", [w.space], w.member);
    const [entry] = await entries("public.chapter_space_notification_settings", `${w.space}:${w.member.id}`);
    await c.query("update public.chapter_spaces set archived_at = now() where id = $1", [w.space]);
    expect(await undo(w.member, entry.id)).toMatchObject({ ok: false, code: "55000", message: "this practice action can no longer be undone" });
    expect((await q("select muted from public.chapter_space_notification_settings where space_id = $1 and user_id = $2", [w.space, w.member.id]))[0].muted).toBe(true);
    expect((await entries("public.chapter_space_notification_settings", `${w.space}:${w.member.id}`))[0].state).toBe("active");
  });

  it("refuses a channel undo that changes a part whose switch is now off, and allows one that does not", async () => {
    const setSwitch = (key, value) => c.query(
      `insert into public.organization_setting_values (organization_id, setting_key, value) values ($1, $2, $3::jsonb)
       on conflict (organization_id, setting_key) do update set value = excluded.value`, [w.org, key, JSON.stringify(value)]);
    const target = `${w.space}:${w.member.id}`;
    const row = async () => (await q("select notification_level, muted, keywords from public.chapter_space_notification_settings where space_id = $1 and user_id = $2", [w.space, w.member.id]))[0] ?? null;
    await one("select public.set_channel_notification_level($1, 'all') as r", [w.space], w.member);
    await start();
    await one("select public.set_channel_notification_level($1, 'none') as r", [w.space], w.member);
    await one("select public.set_channel_mute($1, true, null) as r", [w.space], w.member);
    const [level, mute] = await entries("public.chapter_space_notification_settings", target);
    await setSwitch("features.messaging.channel_notification_levels", false);
    await setSwitch("features.messaging.channel_mute", false);
    // Each undo needs the switch for the part it changes, as its setter does.
    expect(await undo(w.member, mute.id)).toMatchObject({ ok: false, code: "42501", detail: "feature-disabled" });
    expect(await undo(w.member, level.id)).toMatchObject({ ok: false, code: "42501", detail: "feature-disabled" });
    expect(await row()).toEqual({ notification_level: "none", muted: true, keywords: [] });
    // The mute switch back on: the mute undo changes only the mute, so the level switch does not matter.
    await setSwitch("features.messaging.channel_mute", true);
    expect(await undone(w.member, mute.id)).toMatchObject({ undoneCount: 1 });
    expect(await row()).toEqual({ notification_level: "none", muted: false, keywords: [] });
    expect(await undo(w.member, level.id)).toMatchObject({ ok: false, code: "42501", detail: "feature-disabled" });
  });

  it("checks the keyword limit only for a channel undo that puts keywords back (20261105191500)", async () => {
    const target = `${w.space}:${w.member.id}`;
    const row = async () => (await q("select notification_level, muted, keywords from public.chapter_space_notification_settings where space_id = $1 and user_id = $2", [w.space, w.member.id]))[0] ?? null;
    await one("select public.set_channel_keyword_alerts($1, $2::text[]) as r", [w.space, "{grievance,overtime,safety}"], w.member);
    await start();
    await one("select public.set_channel_notification_level($1, 'all') as r", [w.space], w.member);
    await c.query(
      `insert into public.organization_setting_values (organization_id, setting_key, value) values ($1, 'limits.messaging.keyword_alerts_per_member', '1'::jsonb)
       on conflict (organization_id, setting_key) do update set value = excluded.value`, [w.org]);
    // A lower limit no longer blocks an undo that keeps today's keywords.
    const [level] = await entries("public.chapter_space_notification_settings", target);
    expect(await undone(w.member, level.id)).toMatchObject({ undoneCount: 1 });
    expect(await row()).toEqual({ notification_level: "mentions", muted: false, keywords: ["grievance", "overtime", "safety"] });
    // Putting three keywords back is still over the limit of one.
    await one("select public.set_channel_keyword_alerts($1, $2::text[]) as r", [w.space, "{grievance}"], w.member);
    const keywords = (await entries("public.chapter_space_notification_settings", target)).find((item) => item.state === "active");
    expect(await undo(w.member, keywords.id)).toMatchObject({ ok: false, code: "22023", detail: "keyword-limit" });
    expect((await row()).keywords).toEqual(["grievance"]);
  });

  it("journals nothing while no learning period runs, and nothing for an unchanged choice", async () => {
    await one("select public.save_my_report_preferences($1::jsonb) as r", ['{"order":["dues"],"hidden":[],"custom":[]}'], w.member);
    await one("select public.set_channel_mute($1, true, null) as r", [w.space], w.member);
    expect(await entries("public.member_report_preferences", w.member.id)).toEqual([]);
    expect(await entries("public.chapter_space_notification_settings", `${w.space}:${w.member.id}`)).toEqual([]);
    await start();
    await one("select public.set_channel_mute($1, true, null) as r", [w.space], w.member);
    expect(await entries("public.chapter_space_notification_settings", `${w.space}:${w.member.id}`)).toEqual([]);
  });

  it("refuses an undo once the person may no longer write the choice", async () => {
    await start();
    await one("select public.save_compass_workspace_preferences($1::jsonb, $2::jsonb) as r", ['["inbox"]', "[]"], w.member);
    const [entry] = await entries("public.compass_workspace_preferences", `${w.org}:${w.member.id}`);
    await c.query("update public.organization_memberships set status = 'revoked', revoked_at = now() where organization_id = $1 and user_id = $2", [w.org, w.member.id]);
    expect((await undo(w.member, entry.id)).ok).toBe(false);
    expect((await entries("public.compass_workspace_preferences", `${w.org}:${w.member.id}`))[0].state).toBe("active");
  });

  it("still undoes an earlier slice's action through the hand-off to the installed dispatcher", async () => {
    const chain = await q("select pg_get_functiondef(p.oid) as d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname like 'learning\\_dispatch%'");
    const own = chain.map((fn) => fn.d).find((d) => d.includes("when 'private.learning_undo_own_preference' then")) ?? "";
    expect(own).toContain("private.learning_dispatch_before_preferences(p_handler, p_mode, p_entry)");
    expect(own).not.toContain("private.learning_undo_own_profile'");
    await start();
    await one("select public.update_my_member_profile($1, '{\"language\": \"es\"}'::jsonb) as r", [w.member.id], w.member);
    const [entry] = await entries("public.member_profiles", w.member.id);
    expect(entry.action_kind).toBe("own_settings_update");
    expect(await undone(w.member, entry.id)).toMatchObject({ status: "undone" });
    expect((await q("select language from public.member_profiles where id = $1", [w.member.id]))[0].language).toBe("en");
  });
});
