// @vitest-environment node
//
// BUG-UG-EVENT-RSVP-CHECKIN-POLICY-SCOPE-PER-EVENT-20261108 (#7499)
// public.get_member_home_bootstrap took 1.3 to 1.7 s for the demo staff hats
// on SAMPLE (1,002 accounts, 265 events): its member_event_rsvps and
// member_event_checkins reads run under member_event_rsvps_select_own and
// member_event_checkins_select_own, whose EXISTS over member_events called
// private.member_can_access_event_scope once per row. 20261108020000 resolves
// the caller's event scope once per statement.
//
// 1. Every hat (member, same-region member, member of a chapter with no
//    region, member of two chapters, steward, coordinator, admin, aal1
//    session, revoked organization, revoked chapter, a profile chapter the
//    caller is not a member of, another organization) sees exactly the RSVP
//    and check-in rows the 20260901153739 policies showed it, over
//    own-chapter, same-region public, cross-agency, other-region and
//    other-organization events with every flag combination.
// 2. At 1,000 accounts with 224 events and Tamarack-sized RSVP and check-in
//    history, the bootstrap's two event reads run
//    private.member_can_access_event_scope_for_user a fixed number of times
//    per statement (three per chapter of the caller's organization, per
//    policy), not once per event, and answer in under 1 s (runner-scaled)
//    with the predecessor's rows.
// Everything runs in one transaction that is rolled back.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const PREDECESSOR = new URL("../supabase/migrations/20260901153739_event_organization_isolation.sql", import.meta.url);
const TABLES = ["member_event_rsvps", "member_event_checkins"];
const BOOTSTRAP = "select public.get_member_home_bootstrap(now() - interval '7 days', array['member_event_rsvps','member_event_checkins']) as payload";
const P = "a7499000";
const MEMBERS = 1000;
const OTHER_MEMBERS = 50;
const CHAPTERS = 6;
// Chapter 7 is the other organization's; it shares chapter one's region name.
const REGIONS = ["north", "north", "south", null, "south", "east", "north"];
// Each chapter holds EVENTS_PER_KIND events of each flag combination.
const KINDS = [[false, false], [true, false], [false, true], [true, true]];
const EVENTS_PER_KIND = 8;

// Both policies exactly as 20260901153739 installed them.
function predecessor() {
  const sql = readFileSync(PREDECESSOR, "utf8");
  return TABLES.map((table) => {
    const name = `${table}_select_own`;
    const start = sql.indexOf(`drop policy if exists ${name} on public.${table};`);
    const end = sql.indexOf("\n  );\n", start);
    if (start < 0 || end < 0) throw new Error(`predecessor ${name} not found`);
    return sql.slice(start, end + "\n  );".length);
  }).join("\n");
}

const id = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const user = (n) => id(P, n);
const chapter = (n) => `${P}-ch-${n}`;

live("event RSVP and check-in reads resolve the caller's event scope once per statement (#7499)", () => {
  let db;

  async function as(caller, run, { aal = "aal2" } = {}) {
    await db.query("savepoint call");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: caller.id, role: "authenticated", aal, session_id: caller.session })]);
      await db.query("set local role authenticated");
      // The hosted authenticated role's limit.
      await db.query("set local statement_timeout = '30s'");
      return await run();
    } finally {
      await db.query("rollback to savepoint call");
      await db.query("reset role");
    }
  }

  const rowsOf = (caller) => as(caller, async () => {
    const result = {};
    for (const table of TABLES) {
      result[table] = (await db.query(`select event_id from public.${table} where user_id = $1 order by event_id`, [caller.id])).rows.map((row) => row.event_id);
    }
    return result;
  }, { aal: caller.aal });

  const bootstrap = (caller) => as(caller, async () => {
    const started = performance.now();
    const { rows } = await db.query(BOOTSTRAP);
    const ms = performance.now() - started;
    const ids = (table) => rows[0].payload[table].map((row) => row.event_id).sort();
    return { ms, member_event_rsvps: ids("member_event_rsvps"), member_event_checkins: ids("member_event_checkins") };
  });

  async function scopeCalls(run) {
    const calls = async () => (await db.query(
      `select coalesce(sum(calls),0)::integer calls from pg_stat_xact_user_functions
        where schemaname = 'private' and funcname = 'member_can_access_event_scope_for_user'`,
    )).rows[0].calls;
    const before = await calls();
    const result = await run();
    return { result, scope: (await calls()) - before };
  }

  let hats;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "event-rsvp-checkin-scope-once-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '120s'");
    await db.query("set local track_functions = 'all'");

    const organization = id(`${P.slice(0, 7)}f`, 1);
    const other = id(`${P.slice(0, 7)}f`, 2);
    // Fixture rows only; triggers resume before the analyze.
    await db.query("set local session_replication_role = replica");
    await db.query("insert into public.organizations(id,slug,name,status) values ($1,'k7499-scale','k7499-scale','active'),($2,'k7499-other','k7499-other','active')", [organization, other]);
    await db.query(`insert into public.chapters(id,name,region,is_default,order_index,organization_id,slug)
      select '${P}-ch-'||n,'Scale chapter '||n,($4::text[])[n],false,9700+n,case when n <= $3 then $1::uuid else $2::uuid end,'${P}-ch-'||n
      from generate_series(1, $3 + 1) n`, [organization, other, CHAPTERS, REGIONS]);
    // Member n is in chapter ((n - 1) mod 6) + 1; the other organization's
    // members are in chapter 7.
    const home = `case when n > ${MEMBERS} then ${CHAPTERS + 1} else ((n - 1) % ${CHAPTERS}) + 1 end`;
    const uid = `('${P}-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid`;
    await db.query(`insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
      select ${uid},'authenticated','authenticated','${P}-'||n||chr(64)||'example.invalid','{"provider":"email","providers":["email"]}','{}',now(),now(),false,false
      from generate_series(1, $1::integer) n`, [MEMBERS + OTHER_MEMBERS]);
    await db.query(`insert into public.member_profiles(id,first_name,full_name,initials,chapter_id,role_line,member_since,language,
        notification_prefs,dnd_enabled,quiet_hours_timezone,urgent_notifications_enabled,shortcut_keys,work_widget_order,created_at,updated_at)
      select ${uid},'Scale','Scale member '||lpad(n::text,5,'0'),'SM','${P}-ch-'||(${home}),'Member',2020,'en','{}',false,'UTC',true,'{}','{}',now(),now()
      from generate_series(1, $1::integer) n`, [MEMBERS + OTHER_MEMBERS]);
    await db.query(`insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,joined_at)
      select ${uid},'${P}-ch-'||(${home}),'active',true,now() from generate_series(1, $1::integer) n`, [MEMBERS + OTHER_MEMBERS]);
    await db.query(`insert into public.organization_memberships(organization_id,user_id,status)
      select case when n > $2::integer then $3::uuid else $1::uuid end,${uid},'active' from generate_series(1, $4::integer) n`,
    [organization, MEMBERS, other, MEMBERS + OTHER_MEMBERS]);
    // Member 13 also belongs to chapter 3.
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,joined_at) values ($1,$2,'active',false,now())", [user(13), chapter(3)]);
    // Member 8's profile names chapter 2, but its only active membership is chapter 1.
    await db.query("update public.member_chapter_memberships set chapter_id = $2 where user_id = $1", [user(8), chapter(1)]);
    for (const [n, role] of [[19, "steward"], [25, "coordinator"], [31, "admin"]]) {
      for (const table of ["member_roles", "member_role_chapters"]) {
        await db.query(`insert into public.${table}(user_id,role,chapter_id,granted_by) values ($1,$2,$3,$1)`, [user(n), role, chapter(1)]);
      }
    }
    await db.query("update public.organization_memberships set status = 'revoked', revoked_at = now() where user_id = $1", [user(43)]);
    await db.query("update public.member_chapter_memberships set status = 'revoked', revoked_at = now() where user_id = $1", [user(55)]);

    // 32 events per chapter, 8 of each flag combination; 224 in all.
    await db.query(`insert into public.member_events(id,title,starts_at,location,summary,order_index,chapter_id,is_public,is_public_across_agencies)
      select '${P}-ev-'||c||'-'||k||'-'||e,'Scale event','2026-12-01T17:00:00Z','Hall','Scale event',970000+c*100+k*10+e,'${P}-ch-'||c,
             ($1::boolean[])[k],($2::boolean[])[k]
      from generate_series(1, $3::integer) c, generate_series(1, 4) k, generate_series(1, $4::integer) e`,
    [KINDS.map(([pub]) => pub), KINDS.map(([, across]) => across), CHAPTERS + 1, EVENTS_PER_KIND]);
    // History: every member answered and checked in to six events of the 224.
    await db.query(`insert into public.member_event_rsvps(event_id,user_id,status)
      select ev.id, ${uid}, 'going' from generate_series(1, $1::integer) n
      cross join lateral (select id from public.member_events where id like '${P}-ev-%' order by md5(id || n) limit 6) ev`, [MEMBERS + OTHER_MEMBERS]);
    await db.query(`insert into public.member_event_checkins(event_id,user_id)
      select ev.id, ${uid} from generate_series(1, $1::integer) n
      cross join lateral (select id from public.member_events where id like '${P}-ev-%' order by md5(n || id) limit 6) ev`, [MEMBERS + OTHER_MEMBERS]);

    const callers = {
      member: 1, sameRegion: 2, noRegion: 4, twoChapters: 13, profileNotMember: 8, steward: 19, coordinator: 25, admin: 31,
      aal1Session: 37, revokedOrganization: 43, revokedChapter: 55, otherOrganization: MEMBERS + 1,
    };
    hats = {};
    for (const [hat, n] of Object.entries(callers)) {
      const session = id(`${P.slice(0, 7)}5`, n);
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,secret,created_at,updated_at) values (gen_random_uuid(),$1,'scale','totp','verified','scale',now(),now())", [user(n)]);
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),$3)", [session, user(n), hat === "aal1Session" ? "aal1" : "aal2"]);
      // Each hat answered and checked in to every event, so the policies alone decide what it reads back.
      for (const table of TABLES) {
        await db.query(`insert into public.${table}(event_id,user_id) select id, $1 from public.member_events where id like '${P}-ev-%' on conflict do nothing`, [user(n)]);
      }
      hats[hat] = { id: user(n), session, aal: hat === "aal1Session" ? "aal1" : "aal2" };
    }
    await db.query("set local session_replication_role = origin");
    await db.query(`analyze public.member_events, public.member_event_rsvps, public.member_event_checkins, public.member_profiles,
      public.member_chapter_memberships, public.organization_memberships, public.chapters, public.organizations, public.member_roles, public.member_role_chapters`);
  }, runnerTimeout(120_000));

  afterAll(async () => {
    await db?.query("rollback").catch(() => {});
    await db?.end();
  });

  async function everyHat() {
    const result = {};
    for (const [hat, caller] of Object.entries(hats)) result[hat] = await rowsOf(caller);
    return result;
  }

  it("shows every hat exactly the RSVP and check-in rows the predecessor policies showed it", async () => {
    const installed = await everyHat();
    // Events of chapter c and flag combination k (0 none, 1 public, 2 across, 3 both).
    const count = (hat, table, c, k) => installed[hat][table].filter((eventId) => eventId.startsWith(`${P}-ev-${c}-${k + 1}-`)).length;
    for (const table of TABLES) {
      // Chapter one (north): its own 32; chapter two (north) public or
      // across, 24; chapters three to six across only, 16 each.
      expect(installed.member[table], table).toHaveLength(32 + 24 + 4 * 16);
      expect(count("member", table, 2, 0), table).toBe(0);
      expect(count("member", table, 3, 1), table).toBe(0);
      expect(count("member", table, 7, 2), table).toBe(0);
      expect(installed.sameRegion[table], table).toHaveLength(32 + 24 + 4 * 16);
      // A chapter with no region widens only through across.
      expect(installed.noRegion[table], table).toHaveLength(32 + 5 * 16);
      // The other organization's chapter shares chapter one's region name and
      // still reaches only its own events.
      expect(installed.otherOrganization[table], table).toHaveLength(32);
      expect(installed.otherOrganization[table].every((eventId) => eventId.startsWith(`${P}-ev-7-`)), table).toBe(true);
      for (const hat of ["aal1Session", "revokedOrganization", "revokedChapter", "profileNotMember"]) {
        expect(installed[hat][table], `${hat} ${table}`).toEqual([]);
      }
    }

    await db.query("savepoint predecessor");
    try {
      await db.query(predecessor());
      const before = await everyHat();
      for (const hat of Object.keys(installed)) expect(installed[hat], hat).toEqual(before[hat]);
    } finally {
      await db.query("rollback to savepoint predecessor");
    }
  }, runnerTimeout(60_000));

  it("resolves the caller's event scope a fixed number of times per bootstrap at 1,000 accounts, in under 1 s", async () => {
    const budget = runnerTimeout(1_000);
    // Three flag combinations for each of the caller's organization's chapters, in each of the two policies.
    const perCall = 2 * 3 * CHAPTERS;
    const installed = {};
    for (const hat of ["member", "twoChapters", "steward", "coordinator", "admin", "otherOrganization"]) {
      await bootstrap(hats[hat]);
      const { result, scope } = await scopeCalls(() => bootstrap(hats[hat]));
      expect(result.member_event_rsvps.length, hat).toBeGreaterThan(0);
      expect(result.member_event_checkins.length, hat).toBeGreaterThan(0);
      expect(scope, hat).toBeLessThanOrEqual(perCall);
      expect(result.ms, hat).toBeLessThan(budget);
      installed[hat] = result;
    }

    await db.query("savepoint predecessor");
    try {
      await db.query(predecessor());
      for (const hat of Object.keys(installed)) {
        const { result, scope } = await scopeCalls(() => bootstrap(hats[hat]));
        expect(result.member_event_rsvps, hat).toEqual(installed[hat].member_event_rsvps);
        expect(result.member_event_checkins, hat).toEqual(installed[hat].member_event_checkins);
        // The predecessor checked the scope once for every row it returned
        // (240 for an organization member, 64 for the other organization's).
        const rows = result.member_event_rsvps.length + result.member_event_checkins.length;
        expect(scope, hat).toBeGreaterThanOrEqual(rows);
        expect(rows, hat).toBeGreaterThan(perCall);
      }
    } finally {
      await db.query("rollback to savepoint predecessor");
    }
  }, runnerTimeout(120_000));
});
