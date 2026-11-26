// @vitest-environment node
//
// REQ-UG-RELEASE-DATE-CONTROL-WITHOUT-MIGRATION-20261112 (#8580).
//
// Offline half: the migration's grants and what its two functions may write.
// Live half (disposable loopback only): a platform operator, or the database
// owner route scripts/release-calendar.mjs uses, sets, moves, holds and
// releases a switch that was held before, with an audit row each time; nobody
// else can; only release_at changes, so a held switch still reads off until
// its time and stored organization values are untouched.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTROL_FUNCTIONS, STATE_SQL } from "../scripts/release-calendar.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";

// Found by name: the controller assigns the stamp when the change is pushed.
const MIGRATIONS = readdirSync("supabase/migrations").filter((name) => name.endsWith("_platform_setting_release_control.sql"));
if (MIGRATIONS.length !== 1) throw new Error(`expected one platform_setting_release_control migration, found ${MIGRATIONS.length}`);
const MIGRATION = `supabase/migrations/${MIGRATIONS[0]}`;
const code = stripComments(readFileSync(MIGRATION, "utf8")).replace(/\s+/g, " ");
const SET = "public.set_platform_setting_release(text, timestamptz, text, text)";
const SHIFT = "public.shift_platform_setting_releases(date, integer, jsonb, text, text)";

function body(name) {
  const start = code.indexOf(`create function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const open = code.indexOf("as $function$", start) + "as $function$".length;
  return code.slice(open, code.indexOf("$function$", open));
}

describe("release calendar control migration (offline)", () => {
  it("is one atomic migration whose functions are callable only through the authenticated grant", () => {
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    for (const signature of [SET, SHIFT]) {
      expect(code).toContain(`revoke all on function ${signature} from public, anon, authenticated, service_role;`);
      expect(code).toContain(`grant execute on function ${signature} to authenticated;`);
    }
    expect(code).toContain("revoke all on function private.platform_setting_release_caller(text) from public, anon, authenticated, service_role;");
    expect(code).toContain("revoke all on table private.platform_setting_release_changes from public, anon, authenticated, service_role;");
    expect(code).toContain("alter table private.platform_setting_release_changes force row level security;");
  });

  it("checks the caller first and writes only release_at and the audit", () => {
    for (const name of ["public.set_platform_setting_release", "public.shift_platform_setting_releases"]) {
      const text = body(name);
      const begin = text.indexOf(" begin ");
      expect(text.slice(begin).trimStart().startsWith("begin caller := private.platform_setting_release_caller(p_actor);"), name).toBe(true);
      expect(text, name).not.toMatch(/organization_setting_values|default_value|organization_editable|member_visible/);
      const updates = [...text.matchAll(/update ([a-z_.]+) set ([a-z_]+) =/g)].map((match) => `${match[1]}.${match[2]}`);
      expect(updates, name).toEqual(["public.platform_setting_definitions.release_at"]);
      const inserts = [...text.matchAll(/insert into ([a-z_.]+)/g)].map((match) => match[1]);
      expect(inserts, name).toEqual(["private.platform_setting_release_changes"]);
      expect(text, name).not.toMatch(/delete from/);
    }
    const caller = body("private.platform_setting_release_caller");
    expect(caller).toContain("coalesce(private.mfa_satisfied(), false) and private.compass_platform_operator()");
    expect(caller).toContain("pg_catalog.current_setting('role') <> 'none'");
    expect(caller).toContain("not pg_catalog.pg_has_role(session_user, 'postgres', 'MEMBER')");
  });

  it("never moves an undated hold or a released switch, and keeps the Eastern time of day", () => {
    const text = body("public.shift_platform_setting_releases");
    expect(text).toContain("and d.release_at > pg_catalog.now() and pg_catalog.isfinite(d.release_at)");
    expect(text).toContain("d.release_at >= (p_from::timestamp at time zone 'America/New_York')");
    expect(text).toContain("(held.release_at at time zone 'America/New_York' + pg_catalog.make_interval(weeks => p_weeks)) at time zone 'America/New_York'");
  });

  it("probes exactly the signatures the migration grants (the operations script's readiness check)", () => {
    expect(CONTROL_FUNCTIONS).toEqual([SET, SHIFT]);
    for (const signature of CONTROL_FUNCTIONS) expect(STATE_SQL).toContain(`pg_catalog.to_regprocedure('${signature}') is not null`);
  });

  it("moves exactly the locked, validated set and never selects the holds a second time", () => {
    const text = body("public.shift_platform_setting_releases");
    expect(text.split("and d.release_at >= (p_from::timestamp at time zone 'America/New_York')")).toHaveLength(2);
    expect(text).toContain("for held in select e.key, (e.value #>> '{}')::timestamptz as release_at from pg_catalog.jsonb_each(seen) e order by e.key loop");
  });

  it("moves nothing unless the locked holds are exactly the previewed ones", () => {
    const text = body("public.shift_platform_setting_releases");
    const check = text.indexOf("if seen is distinct from previewed then raise exception 'the calendar changed since the preview' using errcode = 'PT409';");
    expect(check).toBeGreaterThan(-1);
    expect(text.indexOf("for update ) s;")).toBeGreaterThan(-1);
    expect(text.indexOf("for update ) s;")).toBeLessThan(check);
    expect(check).toBeLessThan(text.indexOf("update public.platform_setting_definitions"));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

const SWITCH = "features.engagement_voice.bargaining_survey_template";
const SECOND = "features.civic.watchlist";
const THIRD = "features.automation.default_recipes";
const UNDATED = "features.intelligence.weekly_digest";
const RELEASED = "features.tasks.coop_checkoff_lists";
const NEVER_HELD = "features.passkey_enrollment";
const APPLE = "features.identity_providers.apple";
const INTEGER = "limits.casework.deadline_red_days";
const at = (text) => `${text} America/New_York`;

// Calendar days as text, moved by whole days.
const addDays = (day, days) => {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
};
// The first start of daylight saving time (second Sunday in March) after a day.
function daylightSavingStart(after) {
  for (let year = Number(after.slice(0, 4)); ; year += 1) {
    const firstSunday = 1 + ((7 - new Date(Date.UTC(year, 2, 1)).getUTCDay()) % 7);
    const start = `${year}-03-${String(firstSunday + 7).padStart(2, "0")}`;
    if (start > after) return start;
  }
}

// The first end of daylight saving time (first Sunday in November) after a day.
function daylightSavingEnd(after) {
  for (let year = Number(after.slice(0, 4)); ; year += 1) {
    const end = `${year}-11-${String(1 + ((7 - new Date(Date.UTC(year, 10, 1)).getUTCDay()) % 7)).padStart(2, "0")}`;
    if (end > after) return end;
  }
}

live("release calendar control on a disposable database", () => {
  let c;
  let today;
  const ahead = (days) => addDays(today, days);
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "release-calendar-control-proof" });
    await c.connect();
    // Every date below is relative to the database's own Eastern day, so the
    // proof never expires.
    today = (await c.query("select (pg_catalog.now() at time zone 'America/New_York')::date::text d")).rows[0].d;
  });
  afterAll(async () => { await c?.end(); });

  const q = async (text, values = []) => (await c.query(text, values)).rows;
  // As an API caller: claims and role for the statement, inside a savepoint.
  async function call(text, values = [], as = null) {
    await c.query("savepoint call");
    try {
      const claims = as?.id ? { role: "authenticated", sub: as.id, session_id: as.session, aal: as.aal ?? "aal2" } : as?.claims ?? null;
      if (claims) await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      if (as?.role || as?.id) await c.query(`set local role ${as.role ?? "authenticated"}`);
      const rows = (await c.query(text, values)).rows;
      await c.query("reset role");
      await c.query("select set_config('request.jwt.claims', '', true)");
      await c.query("release savepoint call");
      return { ok: true, rows };
    } catch (error) {
      await c.query("rollback to savepoint call");
      await c.query("release savepoint call");
      return { ok: false, code: error.code, message: error.message };
    }
  }

  async function person({ operator = false, admin = false, aal = "aal2" } = {}) {
    const user = { id: randomUUID(), session: randomUUID(), aal };
    await q("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
    await q("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await q("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,$3,now(),now())", [user.session, user.id, aal]);
    if (operator) await q("insert into private.compass_platform_operators(user_id, granted_note) values ($1, 'release calendar proof operator')", [user.id]);
    if (admin) {
      const org = { id: randomUUID(), chapter: `release-calendar-${randomUUID().slice(0, 8)}` };
      await q("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org.id, org.chapter]);
      await q("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98313)", [org.chapter, org.id]);
      await q("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org.id, user.id]);
      await q("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, org.chapter]);
      await q("update public.member_profiles set chapter_id=$2 where id=$1", [user.id, org.chapter]);
      await q("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'admin',$2)", [org.id, user.id]);
      await q("insert into public.member_roles(user_id,role,chapter_id) values ($1,'admin',$2) on conflict do nothing", [user.id, org.chapter]);
      user.org = org;
    }
    return user;
  }

  // A reviewed migration's first hold, as the hold migrations write it.
  const migrationHold = (key, time) => q("update public.platform_setting_definitions set release_at = $2 where key = $1", [key, time]);
  const releaseAt = async (key) => (await q("select release_at::text t from public.platform_setting_definitions where key = $1", [key]))[0].t;
  const eastern = async (key) => (await q("select (release_at at time zone 'America/New_York')::text t from public.platform_setting_definitions where key = $1", [key]))[0].t;
  const changes = (key) => q(`select action, previous_release_at::text previous, new_release_at::text next, reason,
      actor_user_id::text actor, actor_name, session_role from private.platform_setting_release_changes
    where setting_key = $1 order by id`, [key]);
  const setRelease = "select public.set_platform_setting_release($1, $2::timestamptz, $3, $4) r";
  const shift = "select public.shift_platform_setting_releases($1::date, $2, $3::jsonb, $4, $5) r";
  // What a preview would show for a shift from that day: key -> release time.
  const previewed = async (from) => (await q(`select coalesce(jsonb_object_agg(d.key, d.release_at::text), '{}'::jsonb) p
    from public.platform_setting_definitions d where d.value_kind = 'boolean' and d.key like 'features.%'
      and d.release_at > now() and isfinite(d.release_at) and d.release_at >= ($1::date::timestamp at time zone 'America/New_York')`, [from]))[0].p;

  it("lets an operator set, move, hold and release a held switch with one audit row each, touching nothing else", async () => {
    await c.query("begin");
    try {
      const operator = await person({ operator: true });
      const admin = await person({ admin: true });
      await q("insert into public.organization_setting_values(organization_id,setting_key,value) values ($1,$2,'true'::jsonb)", [admin.org.id, SWITCH]);
      await migrationHold(SWITCH, "infinity");
      const enabled = async () => (await q("select private.organization_feature_enabled($1,$2) e", [admin.org.id, SWITCH]))[0].e;
      expect(await enabled()).toBe(false);

      const first = ahead(30);
      const dated = await call(setRelease, [SWITCH, at(`${first} 09:00`), "Neuro Map week", null], operator);
      expect(dated).toMatchObject({ ok: true, rows: [{ r: { key: SWITCH, held: true, updated: true } }] });
      expect(await eastern(SWITCH)).toBe(`${first} 09:00:00`);
      // Still held: only the date moved.
      expect(await enabled()).toBe(false);

      expect((await call(setRelease, [SWITCH, at(`${addDays(first, 7)} 09:00`), "slips a week", null], operator)).ok).toBe(true);
      expect(await eastern(SWITCH)).toBe(`${addDays(first, 7)} 09:00:00`);
      expect((await call(setRelease, [SWITCH, "infinity", "no date yet", null], operator)).ok).toBe(true);
      expect(await releaseAt(SWITCH)).toBe("infinity");
      // The same time again changes nothing and writes no audit row.
      expect(await call(setRelease, [SWITCH, "infinity", "again", null], operator)).toMatchObject({ ok: true, rows: [{ r: { updated: false } }] });

      // Released now: the stored organization value is honored again, untouched.
      expect(await call(setRelease, [SWITCH, (await q("select now()::text t"))[0].t, "release", null], operator))
        .toMatchObject({ ok: true, rows: [{ r: { held: false, updated: true } }] });
      expect(await enabled()).toBe(true);
      expect((await q("select value from public.organization_setting_values where organization_id=$1 and setting_key=$2", [admin.org.id, SWITCH]))[0].value).toBe(true);
      // A released switch that was held before can be held again by the operator.
      expect((await call(setRelease, [SWITCH, at(`${ahead(58)} 09:00`), "held again", null], operator)).ok).toBe(true);
      expect(await enabled()).toBe(false);

      const audit = await changes(SWITCH);
      expect(audit.map((row) => [row.action, row.reason, row.actor, row.actor_name])).toEqual([
        ["set", "Neuro Map week", operator.id, null],
        ["set", "slips a week", operator.id, null],
        ["set", "no date yet", operator.id, null],
        ["set", "release", operator.id, null],
        ["set", "held again", operator.id, null],
      ]);
      expect(audit[0].previous).toBe("infinity");
      expect(audit[2].next).toBe("infinity");
    } finally {
      await c.query("rollback");
    }
  });

  it("refuses everyone but an operator with a stepped-up session, and the database owner only with a name", async () => {
    await c.query("begin");
    try {
      await migrationHold(SWITCH, "infinity");
      const admin = await person({ admin: true });
      const stale = await person({ operator: true, aal: "aal1" });
      const revoked = await person({ operator: true });
      await q("update private.compass_platform_operators set revoked_at = now() where user_id = $1", [revoked.id]);
      const operator = await person({ operator: true });
      const args = [SWITCH, at(`${ahead(30)} 09:00`), "proof", null];

      for (const [label, as] of [["organization admin", admin], ["aal1 operator", stale], ["revoked operator", revoked]]) {
        expect(await call(setRelease, args, as), label).toMatchObject({ ok: false, code: "42501", message: "platform operator required" });
        expect(await call(shift, [ahead(30), 1, {}, "proof", null], as), label).toMatchObject({ ok: false, code: "42501" });
      }
      // No grant at all for these roles.
      for (const role of ["anon", "service_role"]) {
        const claims = { role };
        expect(await call(setRelease, args, { role, claims }), role).toMatchObject({ ok: false, code: "42501" });
        expect(await call(shift, [ahead(30), 1, {}, "proof", null], { role, claims }), role).toMatchObject({ ok: false, code: "42501" });
      }
      // The authenticated role with no account, with or without claims, is not the owner route.
      expect(await call(setRelease, args, { role: "authenticated" })).toMatchObject({ ok: false, code: "42501", message: "platform operator required" });
      expect(await call(setRelease, [SWITCH, at(`${ahead(30)} 09:00`), "proof", "Someone"], { role: "authenticated", claims: { role: "authenticated" } }))
        .toMatchObject({ ok: false, code: "42501", message: "platform operator required" });
      // An operator is named by the account, never by a typed name.
      expect(await call(setRelease, [SWITCH, at(`${ahead(30)} 09:00`), "proof", "Someone"], operator)).toMatchObject({ ok: false, code: "22023" });

      // The owner route (no JWT, no SET ROLE, a postgres member) needs the person's name.
      expect(await call(setRelease, args)).toMatchObject({ ok: false, code: "22023", message: "actor name required" });
      expect(await call(setRelease, [SWITCH, at(`${ahead(30)} 09:00`), "owner route", "Alex Rivera"])).toMatchObject({ ok: true });
      expect(await changes(SWITCH)).toEqual([{
        action: "set", previous: "infinity", next: (await releaseAt(SWITCH)), reason: "owner route",
        actor: null, actor_name: "Alex Rivera", session_role: "postgres",
      }]);
    } finally {
      await c.query("rollback");
    }
  });

  it("refuses a switch never held, a non-switch key, a missing time and a missing reason", async () => {
    await c.query("begin");
    try {
      const operator = await person({ operator: true });
      await migrationHold(SWITCH, "infinity");
      expect(await call(setRelease, [NEVER_HELD, at(`${ahead(30)} 09:00`), "proof", null], operator))
        .toMatchObject({ ok: false, code: "55000" });
      expect(await releaseAt(NEVER_HELD)).toBe(null);
      expect(await call(setRelease, [INTEGER, at(`${ahead(30)} 09:00`), "proof", null], operator)).toMatchObject({ ok: false, code: "22023" });
      expect(await call(setRelease, ["features.release_calendar_proof.none", at(`${ahead(30)} 09:00`), "proof", null], operator)).toMatchObject({ ok: false, code: "22023" });
      expect(await call(setRelease, [SWITCH, null, "proof", null], operator)).toMatchObject({ ok: false, code: "22023" });
      expect(await call(setRelease, [SWITCH, "-infinity", "proof", null], operator)).toMatchObject({ ok: false, code: "22023" });
      expect(await call(setRelease, [SWITCH, at(`${ahead(30)} 09:00`), "  ", null], operator)).toMatchObject({ ok: false, code: "22023" });
      expect(await call(setRelease, [SWITCH, at(`${ahead(30)} 09:00`), "a\nb", null], operator)).toMatchObject({ ok: false, code: "22023" });
      for (const weeks of [0, 9, -9, null]) {
        expect(await call(shift, [ahead(30), weeks, {}, "proof", null], operator), String(weeks)).toMatchObject({ ok: false, code: "22023" });
      }
      for (const expected of [null, [], "x"]) {
        expect(await call(shift, [ahead(30), 1, JSON.stringify(expected), "proof", null], operator), JSON.stringify(expected)).toMatchObject({ ok: false, code: "22023" });
      }
      expect(await releaseAt(SWITCH)).toBe("infinity");
      expect(await changes(SWITCH)).toEqual([]);
    } finally {
      await c.query("rollback");
    }
  });

  it("shifts every dated hold from a day on by whole weeks in Eastern time, and nothing else", async () => {
    await c.query("begin");
    try {
      const operator = await person({ operator: true });
      // Around the next start of daylight saving time at least a month away.
      const dst = daylightSavingStart(ahead(30));
      const day = (offset) => addDays(dst, offset);
      await migrationHold(SWITCH, at(`${day(-6)} 09:00`));
      await migrationHold(SECOND, at(`${day(-13)} 09:00`));
      await migrationHold(THIRD, at(`${day(-9)} 00:00`));
      await migrationHold(UNDATED, "infinity");
      await migrationHold(RELEASED, at(`${ahead(-30)} 09:00`));
      const before = { second: await releaseAt(SECOND), undated: await releaseAt(UNDATED), released: await releaseAt(RELEASED) };

      const moved = await call(shift, [day(-9), 1, await previewed(day(-9)), "everything slips a week", null], operator);
      expect(moved.ok).toBe(true);
      const keys = moved.rows[0].r.moved.map((row) => row.key);
      expect(keys).toContain(SWITCH);
      expect(keys).toContain(THIRD);
      expect(keys).not.toContain(SECOND);
      expect(keys).not.toContain(UNDATED);
      expect(keys).not.toContain(RELEASED);
      // Across the clock change the release stays at 9:00 AM Eastern.
      expect(await eastern(SWITCH)).toBe(`${day(1)} 09:00:00`);
      expect(await eastern(THIRD)).toBe(`${day(-2)} 00:00:00`);
      expect({ second: await releaseAt(SECOND), undated: await releaseAt(UNDATED), released: await releaseAt(RELEASED) }).toEqual(before);

      expect((await call(shift, [day(-13), -2, await previewed(day(-13)), "two weeks earlier", null], operator)).ok).toBe(true);
      expect(await eastern(SWITCH)).toBe(`${day(-13)} 09:00:00`);
      expect(await eastern(SECOND)).toBe(`${day(-27)} 09:00:00`);

      const audit = await q(`select action, setting_key, batch_id::text batch from private.platform_setting_release_changes
        where setting_key = any($1) order by id`, [[SWITCH, SECOND, THIRD, UNDATED, RELEASED]]);
      expect(audit.every((row) => row.action === "shift")).toBe(true);
      expect(audit.filter((row) => row.setting_key === SWITCH)).toHaveLength(2);
      expect(audit.filter((row) => row.setting_key === UNDATED || row.setting_key === RELEASED)).toEqual([]);
      const first = audit.filter((row) => row.setting_key === SWITCH || row.setting_key === THIRD).slice(0, 2);
      expect(first[0].batch).toBe(first[1].batch);
    } finally {
      await c.query("rollback");
    }
  });

  // #8783: a new Eastern time in the spring-forward gap refuses the whole
  // shift before anything is written; the fall-back hour moves as before.
  it("refuses a shift into the spring-forward gap before writing anything, naming the switch and the time, and moves across the fall-back hour (#8783)", async () => {
    await c.query("begin");
    try {
      const operator = await person({ operator: true });
      const dst = daylightSavingStart(ahead(30));
      const before = addDays(dst, -7);
      await migrationHold(SWITCH, at(`${before} 02:30`));
      await migrationHold(SECOND, at(`${addDays(dst, -6)} 09:00`));
      const untouched = { switch: await releaseAt(SWITCH), second: await releaseAt(SECOND) };
      const refused = await call(shift, [before, 1, await previewed(before), "slips a week", null], operator);
      expect(refused).toEqual({
        ok: false,
        code: "22023",
        message: `${SWITCH} would move to ${dst} 02:30, which does not exist in Eastern time (the clocks spring forward that night); nothing moved`,
      });
      // The owner route of the operations script gets the same refusal.
      expect(await call(shift, [before, 1, await previewed(before), "slips a week", "Synthetic Operator"]))
        .toEqual({ ...refused });
      expect({ switch: await releaseAt(SWITCH), second: await releaseAt(SECOND) }).toEqual(untouched);
      expect(await q("select count(*)::int n from private.platform_setting_release_changes where setting_key = any($1)", [[SWITCH, SECOND]]))
        .toEqual([{ n: 0 }]);
      // Two weeks lands after the gap: both move and keep their wall times.
      expect((await call(shift, [before, 2, await previewed(before), "slips two weeks", null], operator)).ok).toBe(true);
      expect(await eastern(SWITCH)).toBe(`${addDays(dst, 7)} 02:30:00`);
      expect(await eastern(SECOND)).toBe(`${addDays(dst, 8)} 09:00:00`);

      // The fall-back hour happens twice; a time in it exists and keeps its wall time.
      const end = daylightSavingEnd(ahead(30));
      await migrationHold(THIRD, at(`${addDays(end, -7)} 01:30`));
      await migrationHold(SWITCH, at(`${addDays(end, -6)} 09:00`));
      await migrationHold(SECOND, null);
      const from = addDays(end, -7);
      expect((await call(shift, [from, 1, await previewed(from), "slips a week across the fall-back", null], operator)).ok).toBe(true);
      expect(await eastern(THIRD)).toBe(`${end} 01:30:00`);
      expect(await eastern(SWITCH)).toBe(`${addDays(end, 1)} 09:00:00`);
    } finally {
      await c.query("rollback");
    }
  });

  it("moves nothing when the holds changed after the preview", async () => {
    await c.query("begin");
    try {
      const operator = await person({ operator: true });
      await migrationHold(SWITCH, at(`${ahead(30)} 09:00`));
      await migrationHold(SECOND, at(`${ahead(37)} 09:00`));
      const shown = await previewed(ahead(30));
      const untouched = { switch: await releaseAt(SWITCH), second: await releaseAt(SECOND) };
      const shiftWith = (expected) => call(shift, [ahead(30), 1, expected, "slips a week", null], operator);

      // Another hold gets a date in the window after the preview.
      await migrationHold(THIRD, at(`${ahead(44)} 09:00`));
      expect(await shiftWith(shown)).toMatchObject({ ok: false, code: "PT409", message: "the calendar changed since the preview" });
      await migrationHold(THIRD, null);
      // A previewed hold moved after the preview.
      await migrationHold(SECOND, at(`${ahead(38)} 09:00`));
      expect(await shiftWith(shown)).toMatchObject({ ok: false, code: "PT409" });
      await migrationHold(SECOND, untouched.second);
      // A previewed hold that is no longer there.
      expect(await shiftWith({ ...shown, [UNDATED]: untouched.second })).toMatchObject({ ok: false, code: "PT409" });

      expect({ switch: await releaseAt(SWITCH), second: await releaseAt(SECOND) }).toEqual(untouched);
      expect(await q("select count(*)::int n from private.platform_setting_release_changes where setting_key = any($1)", [[SWITCH, SECOND, THIRD]]))
        .toEqual([{ n: 0 }]);
      // The preview as it stands moves both.
      expect(await shiftWith(shown)).toMatchObject({ ok: true, rows: [{ r: { count: 2 } }] });
    } finally {
      await c.query("rollback");
    }
  });

  it("is found by the operations script's own readiness probe, with nothing injected", async () => {
    const state = (await q(STATE_SQL))[0].state;
    expect(state.control).toBe(true);
    expect(state.rows.find((row) => row.key === APPLE)).toMatchObject({ release_at: "infinity", eastern: null, held: true });
  });

  // Two sessions: another session dates a hold while the shift waits for a row
  // lock. Its committed change is outside the shift's validated set, so it must
  // not move (a second selection would have picked it up). The other session's
  // writes commit, so the rows are put back in the finally block.
  it("moves only the previewed holds when another session dates a hold during the shift", async () => {
    const other = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "release-calendar-control-proof-other" });
    await other.connect();
    const original = await q("select key, release_at::text release_at from public.platform_setting_definitions where key = any($1)", [[SWITCH, THIRD]]);
    const pid = (await q("select pg_backend_pid() p"))[0].p;
    try {
      await other.query("update public.platform_setting_definitions set release_at = $2 where key = $1", [SWITCH, at(`${ahead(30)} 09:00`)]);
      await c.query("begin");
      try {
        const operator = await person({ operator: true });
        const shown = await previewed(ahead(30));
        expect(Object.keys(shown)).toContain(SWITCH);
        expect(Object.keys(shown)).not.toContain(THIRD);
        // The other session holds the previewed row and dates a second hold.
        await other.query("begin");
        await other.query("update public.platform_setting_definitions set release_at = release_at where key = $1", [SWITCH]);
        await other.query("update public.platform_setting_definitions set release_at = $2 where key = $1", [THIRD, at(`${ahead(37)} 09:00`)]);
        const shifting = call(shift, [ahead(30), 1, shown, "slips a week", null], operator);
        let waiting = false;
        for (let attempt = 0; attempt < 200 && !waiting; attempt += 1) {
          waiting = (await other.query("select wait_event_type = 'Lock' w from pg_stat_activity where pid = $1", [pid])).rows[0]?.w === true;
          if (!waiting) await new Promise((resolve) => { setTimeout(resolve, 25); });
        }
        expect(waiting, "the shift waits for the other session's row lock").toBe(true);
        await other.query("commit");
        const result = await shifting;
        expect(result.ok, result.message).toBe(true);
        expect(result.rows[0].r.moved.map((row) => row.key)).toEqual(Object.keys(shown).sort());
        expect(await eastern(SWITCH)).toBe(`${ahead(37)} 09:00:00`);
        expect(await eastern(THIRD)).toBe(`${ahead(37)} 09:00:00`);
        expect(await q("select count(*)::int n from private.platform_setting_release_changes where setting_key = $1", [THIRD])).toEqual([{ n: 0 }]);
      } finally {
        await c.query("rollback");
      }
    } finally {
      await other.query("rollback").catch(() => {});
      for (const row of original) await other.query("update public.platform_setting_definitions set release_at = $2 where key = $1", [row.key, row.release_at]);
      await other.end();
    }
  }, 30_000);

  it("moves an entry-screen key the same way, and a time in the past releases it", async () => {
    await c.query("begin");
    try {
      const operator = await person({ operator: true });
      await migrationHold(APPLE, "infinity");
      const state = async () => (await q("select public.get_entry_screen_release_state() s"))[0].s.apple;
      expect(await state()).toBe(false);
      expect((await call(setRelease, [APPLE, at(`${ahead(-30)} 09:00`), "already past", null], operator)).ok).toBe(true);
      expect(await state()).toBe(true);
      expect((await call(setRelease, [APPLE, "infinity", "held again", null], operator)).ok).toBe(true);
      expect(await state()).toBe(false);
    } finally {
      await c.query("rollback");
    }
  });
});
