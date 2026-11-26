// @vitest-environment node
//
// BUG-UG-COUNTS-AND-STATUSES-DISAGREE-BETWEEN-PAGES-20261122 (#9533),
// finding B-55. The President's Leadership team listed the whole organization,
// because her organization vp grant makes public.get_staff_roster answer
// organization-wide. 20261124175100 adds p_chapter_only (default false):
//
// 1. Without it every caller gets exactly what the 20261106130000 body gives,
//    refusals included, so nobody loses the list they read today.
// 2. With it an organization-wide caller gets the answer a leader holding only
//    a role in the same chapter gets: that chapter's staff only.
// 3. A chapter-only caller gets the same answer either way, and a refused
//    caller stays refused, so the argument can narrow but never widen.
// 4. One function, signed-in callers only, as before.
// Everything runs in one transaction that is rolled back.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const PREDECESSOR = new URL("../supabase/migrations/20261106130000_staff_roster_engagement_snapshot_setwise_member_access.sql", import.meta.url);
const ORGANIZATION_WIDE = "select public.get_staff_roster() value";
const CHAPTER_ONLY = "select public.get_staff_roster(p_chapter_only => true) value";
// Explicit false and null mean the same as no argument.
const EXPLICIT_FALSE = "select public.get_staff_roster(p_chapter_only => false) value";
const EXPLICIT_NULL = "select public.get_staff_roster(p_chapter_only => null) value";
const PREFIX = "b9533000";
const MEMBERS = 30;

const id = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const chapterOf = (n) => `${PREFIX}-ch-${((n - 1) % 5) + 1}`;

// The predecessor definition exactly as 20261106130000 installed it.
function predecessor() {
  const sql = readFileSync(PREDECESSOR, "utf8");
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.get_staff_roster()");
  const end = sql.indexOf("\n$function$\n", start);
  if (start < 0 || end < 0) throw new Error("predecessor get_staff_roster not found");
  return sql.slice(start, end + "\n$function$\n".length);
}

live("the President's Leadership team lists her open chapter (#9533)", () => {
  let db;
  const callers = {};

  async function call(user, sql) {
    await db.query("savepoint call");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user.id, role: "authenticated", aal: "aal2", session_id: user.session })]);
      await db.query("set local role authenticated");
      const { rows } = await db.query(sql);
      return { value: rows[0].value };
    } catch (error) {
      return { error: error.code };
    } finally {
      await db.query("rollback to savepoint call");
      await db.query("reset role");
    }
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "vp-leadership-team-chapter-roster-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '120s'");
    await db.query("set local session_replication_role = replica");
    const organization = id("b9533fff", 1);
    const otherOrganization = id("b9533ffe", 1);
    const user = (n) => `'${PREFIX}-0000-4000-8000-'||lpad((${n})::text,12,'0')`;
    await db.query(`insert into public.organizations(id,slug,name,status) values ($1,'roster-9533','roster-9533','active'),($2,'roster-9533-other','roster-9533-other','active')`, [organization, otherOrganization]);
    // Chapters 1-5 in the organization, chapter 6 in another one.
    await db.query(`insert into public.chapters(id,name,region,is_default,order_index,organization_id,slug)
      select '${PREFIX}-ch-'||n,'Roster chapter '||n,'roster',false,9800+n,case when n <= 5 then $1::uuid else $2::uuid end,'${PREFIX}-ch-'||n
      from generate_series(1, 6) n`, [organization, otherOrganization]);
    // Members 1-30 in chapters 1-5 (member n in chapter ((n-1) mod 5)+1);
    // members 31-34 in the other organization's chapter 6.
    const chapter = `case when n > ${MEMBERS} then 6 else ((n - 1) % 5) + 1 end`;
    await db.query(`insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
      select (${user("n")})::uuid,'authenticated','authenticated','${PREFIX}-'||n||chr(64)||'example.invalid',
        '{"provider":"email","providers":["email"]}','{}',now(),now(),false,false
      from generate_series(1, $1::integer) n`, [MEMBERS + 4]);
    await db.query(`insert into public.member_profiles(id,first_name,full_name,initials,chapter_id,role_line,member_since,language,
        notification_prefs,dnd_enabled,quiet_hours_timezone,urgent_notifications_enabled,shortcut_keys,work_widget_order,created_at,updated_at)
      select (${user("n")})::uuid,'Roster','Roster member '||lpad(n::text,3,'0'),'RM','${PREFIX}-ch-'||(${chapter}),'Member',2020,'en',
        '{}',false,'UTC',true,'{}','{}',now(),now()
      from generate_series(1, $1::integer) n`, [MEMBERS + 4]);
    await db.query(`insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,joined_at)
      select (${user("n")})::uuid,'${PREFIX}-ch-'||(${chapter}),'active',true,now() from generate_series(1, $1::integer) n`, [MEMBERS + 4]);
    await db.query(`insert into public.organization_memberships(organization_id,user_id,status)
      select case when n > $2::integer then $3::uuid else $1::uuid end,(${user("n")})::uuid,'active'
      from generate_series(1, $4::integer) n`, [organization, MEMBERS, otherOrganization, MEMBERS + 4]);
    const staff = [
      // The President: an organization vp grant, chapter 1 open.
      { n: 6, organizationRole: "vp", caller: "president" },
      { n: 1, organizationRole: "admin", caller: "orgAdmin" },
      // Organization vp plus a chapter admin role (chapter 3): the person a
      // body-only rule would have cut off from the organization-wide list.
      { n: 8, organizationRole: "vp", chapterRole: "admin", chapter: 3, caller: "vpAndChapterAdmin" },
      // A leader holding only a chapter role in the President's chapter.
      { n: 16, chapterRole: "admin", chapter: 1, caller: "chapterOneAdmin" },
      { n: 2, chapterRole: "coordinator", chapter: 2, caller: "chapterCoordinator" },
      { n: 3, chapterRole: "admin", chapter: 3, caller: "chapterAdmin" },
      { n: 4, chapterRole: "steward", chapter: 4, caller: "chapterSteward" },
      { n: 20, caller: "member" },
      { n: 11, chapterRole: "steward", chapter: 1 },
      { n: 21, chapterRole: "coordinator", chapter: 1 },
      { n: 7, chapterRole: "advisor", chapter: 2 },
      { n: 12, chapterRole: "steward", chapter: 2 },
      { n: 25, chapterRole: "steward", chapter: 5 },
      { n: 31, chapterRole: "admin", chapter: 6 },
    ];
    for (const grant of staff) {
      const userId = id(PREFIX, grant.n);
      if (grant.organizationRole) {
        await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [organization, userId, grant.organizationRole]);
      }
      if (grant.chapterRole) {
        for (const table of ["member_roles", "member_role_chapters"]) {
          await db.query(`insert into public.${table}(user_id,role,chapter_id,granted_by) values ($1,$2,$3,$1)`, [userId, grant.chapterRole, `${PREFIX}-ch-${grant.chapter}`]);
        }
      }
      if (grant.caller) {
        await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,secret,created_at,updated_at) values (gen_random_uuid(),$1,'roster','totp','verified','roster',now(),now())", [userId]);
        callers[grant.caller] = { id: userId, session: id("b9533555", grant.n), chapter: chapterOf(grant.n) };
      }
    }
    await db.query("set local session_replication_role = origin");
    for (const caller of Object.values(callers)) {
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),'aal2')", [caller.session, caller.id]);
    }
  }, runnerTimeout(60_000));

  afterAll(async () => {
    await db?.query("rollback").catch(() => {});
    await db?.end();
  });

  it("answers every caller exactly as the predecessor does without the argument, or with false or null", async () => {
    const installed = {};
    const explicit = {};
    for (const [who, caller] of Object.entries(callers)) {
      installed[who] = await call(caller, ORGANIZATION_WIDE);
      explicit[who] = { false: await call(caller, EXPLICIT_FALSE), null: await call(caller, EXPLICIT_NULL) };
    }
    await db.query("savepoint predecessor");
    try {
      await db.query("drop function public.get_staff_roster(boolean)");
      await db.query(predecessor());
      for (const [who, caller] of Object.entries(callers)) {
        const predecessorAnswer = await call(caller, ORGANIZATION_WIDE);
        expect(installed[who], who).toEqual(predecessorAnswer);
        expect(explicit[who].false, `${who} false`).toEqual(predecessorAnswer);
        expect(explicit[who].null, `${who} null`).toEqual(predecessorAnswer);
      }
    } finally {
      await db.query("rollback to savepoint predecessor");
    }
    // The fixture reaches the branches the comparison is meant to cover.
    const chapters = (who) => new Set(installed[who].value.map((person) => person.chapterId));
    expect(chapters("president").size).toBe(5);
    expect(chapters("vpAndChapterAdmin").size).toBe(5);
    expect(chapters("chapterAdmin")).toEqual(new Set([`${PREFIX}-ch-3`]));
    expect(installed.member.error).toBe("42501");
    expect(installed.chapterSteward.error).toBe("42501");
  }, runnerTimeout(60_000));

  it("lists only the President's open chapter, as a chapter-only leader there sees it", async () => {
    const wide = await call(callers.president, ORGANIZATION_WIDE);
    const narrow = await call(callers.president, CHAPTER_ONLY);
    expect(narrow.error).toBeUndefined();
    expect(narrow.value.map((person) => person.chapterId)).toEqual(narrow.value.map(() => `${PREFIX}-ch-1`));
    expect(narrow.value.map((person) => person.userId).sort()).toEqual([1, 6, 11, 16, 21].map((n) => id(PREFIX, n)).sort());
    expect(narrow.value.length).toBeLessThan(wide.value.length);
    // Her organization-wide grant still shows on her own row.
    expect(narrow.value.find((person) => person.userId === callers.president.id).roles).toEqual(["vp"]);
    // The same list a leader holding only a chapter-1 role gets today.
    expect(narrow).toEqual(await call(callers.chapterOneAdmin, ORGANIZATION_WIDE));
  }, runnerTimeout(30_000));

  it("never widens: chapter-only callers read the same list and refused callers stay refused", async () => {
    for (const who of ["chapterOneAdmin", "chapterCoordinator", "chapterAdmin"]) {
      expect(await call(callers[who], CHAPTER_ONLY), who).toEqual(await call(callers[who], ORGANIZATION_WIDE));
    }
    for (const who of ["member", "chapterSteward"]) {
      expect(await call(callers[who], CHAPTER_ONLY), who).toEqual({ error: "42501" });
    }
    // An organization-wide caller asking for the chapter view gets their own
    // open chapter (organization admin, chapter 1; vp plus chapter admin,
    // chapter 3), never another organization's.
    for (const who of ["orgAdmin", "vpAndChapterAdmin"]) {
      const narrow = await call(callers[who], CHAPTER_ONLY);
      expect(new Set(narrow.value.map((person) => person.chapterId)), who).toEqual(new Set([callers[who].chapter]));
    }
  }, runnerTimeout(30_000));

  it("refuses a signed-out caller in every form", async () => {
    for (const sql of [ORGANIZATION_WIDE, CHAPTER_ONLY, EXPLICIT_FALSE, EXPLICIT_NULL]) {
      await db.query("savepoint anon_call");
      try {
        await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "anon" })]);
        await db.query("set local role anon");
        await expect(db.query(sql), sql).rejects.toMatchObject({ code: "42501" });
      } finally {
        await db.query("rollback to savepoint anon_call");
        await db.query("reset role");
      }
    }
  });

  it("keeps one roster function, readable by signed-in callers only", async () => {
    const { rows } = await db.query(`select p.oid::regprocedure::text signature,
        has_function_privilege('anon', p.oid, 'execute') anon,
        has_function_privilege('authenticated', p.oid, 'execute') authenticated,
        has_function_privilege('service_role', p.oid, 'execute') service_role,
        p.prosecdef secdef
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'get_staff_roster'`);
    expect(rows).toEqual([{ signature: "get_staff_roster(boolean)", anon: false, authenticated: true, service_role: false, secdef: true }]);
  });
});
