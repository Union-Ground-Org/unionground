// @vitest-environment node
//
// BUG-UG-ADMIN-DESK-AND-ENGAGEMENT-STUDIO-STATEMENT-TIMEOUT-AT-SCALE-20261106 (#7170)
// public.get_staff_roster (the admin desk) and public.get_staff_engagement_snapshot
// (the engagement studio's first read) filtered member_profiles with the
// per-row private.chapter_member_readable(id): five public.staff_can_see_user
// calls per profile in the database. At 1,000 accounts both ran past the 30 s
// statement limit on SAMPLE. 20261106130000 replaces only that predicate with
// its set-wise form (the caller's own row or private.staff_visible_member_ids
// for the same five roles, once per statement).
//
// 1. On a small mixed fixture the installed bodies return exactly what the
//    20261102005607 bodies return, for every caller, refusals included.
// 2. At 1,000 accounts plus 200 in another organization both reads answer in
//    under 2 s (runner-scaled) with a fixed number of visibility helper calls;
//    the old bodies make about 5,000 staff_can_see_user calls per read here.
// Everything runs in one transaction that is rolled back.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const PREDECESSOR = new URL("../supabase/migrations/20261102005607_unit_committee_scoped_access.sql", import.meta.url);
const ROSTER = "select public.get_staff_roster() value";
const SNAPSHOT = "select public.get_staff_engagement_snapshot() value";
const SCALE_MEMBERS = 1000;
const OTHER_MEMBERS = 200;

// The predecessor definition exactly as 20261102005607 installed it.
function predecessor(name) {
  const sql = readFileSync(PREDECESSOR, "utf8");
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}()`);
  const end = sql.indexOf("\n$function$\n", start);
  if (start < 0 || end < 0) throw new Error(`predecessor ${name} not found`);
  return sql.slice(start, end + "\n$function$\n".length);
}

const id = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

live("staff roster and engagement snapshot at organization scale (#7170)", () => {
  let db;

  async function call(user, sql) {
    await db.query("savepoint call");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user.id, role: "authenticated", aal: "aal2", session_id: user.session })]);
      await db.query("set local role authenticated");
      // The hosted authenticated role's limit.
      await db.query("set local statement_timeout = '30s'");
      const started = performance.now();
      const { rows } = await db.query(sql);
      return { ms: performance.now() - started, value: rows[0].value };
    } catch (error) {
      return { error: error.code, message: error.message };
    } finally {
      await db.query("rollback to savepoint call");
      await db.query("reset role");
    }
  }

  async function helperCalls(run) {
    const read = async () => Object.fromEntries((await db.query(
      `select funcname, calls::integer from pg_stat_xact_user_functions
        where schemaname in ('public','private') and funcname in ('staff_can_see_user','chapter_member_readable')`,
    )).rows.map((row) => [row.funcname, row.calls]));
    const before = await read();
    const result = await run();
    const after = await read();
    const delta = (name) => (after[name] ?? 0) - (before[name] ?? 0);
    return { result, staffCanSeeUser: delta("staff_can_see_user"), chapterMemberReadable: delta("chapter_member_readable") };
  }

  // n members in five chapters of one organization (chapter = n mod 5), with
  // a verified factor and an aal2 session for every caller the test uses.
  async function seedOrganization(prefix, organization, members, { other = 0, staff = [] } = {}) {
    const user = (n) => `'${prefix}-0000-4000-8000-'||lpad((${n})::text,12,'0')`;
    await db.query(`insert into public.organizations(id,slug,name,status) values ($1,$2,$2,'active')`, [organization, `scale-${prefix}`]);
    const otherOrganization = id(`${prefix.slice(0, 7)}f`, 9);
    if (other) await db.query(`insert into public.organizations(id,slug,name,status) values ($1,$2,$2,'active')`, [otherOrganization, `scale-${prefix}-other`]);
    await db.query(`insert into public.chapters(id,name,region,is_default,order_index,organization_id,slug)
      select '${prefix}-ch-'||n,'Scale chapter '||n,'scale',false,9900+n,
        case when n <= 5 then $1::uuid else $2::uuid end,'${prefix}-ch-'||n
      from generate_series(1, case when $3::integer > 0 then 6 else 5 end) n`, [organization, otherOrganization, other]);
    const chapter = `case when n > ${members} then 6 else ((n - 1) % 5) + 1 end`;
    await db.query(`insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
      select (${user("n")})::uuid,'authenticated','authenticated','${prefix}-'||n||chr(64)||'example.invalid',
        '{"provider":"email","providers":["email"]}','{}',now(),now(),false,false
      from generate_series(1, $1::integer) n`, [members + other]);
    await db.query(`insert into public.member_profiles(id,first_name,full_name,initials,chapter_id,role_line,member_since,language,
        notification_prefs,dnd_enabled,quiet_hours_timezone,urgent_notifications_enabled,shortcut_keys,work_widget_order,created_at,updated_at)
      select (${user("n")})::uuid,'Scale','Scale member '||lpad(n::text,5,'0'),'SM','${prefix}-ch-'||(${chapter}),'Member',2020,'en',
        '{}',false,'UTC',true,'{}','{}',now(),now()
      from generate_series(1, $1::integer) n`, [members + other]);
    await db.query(`insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,joined_at)
      select (${user("n")})::uuid,'${prefix}-ch-'||(${chapter}),'active',true,now() from generate_series(1, $1::integer) n`, [members + other]);
    await db.query(`insert into public.organization_memberships(organization_id,user_id,status)
      select case when n > $2::integer then $3::uuid else $1::uuid end,(${user("n")})::uuid,'active'
      from generate_series(1, $4::integer) n`, [organization, members, otherOrganization, members + other]);
    for (const grant of staff) {
      const userId = id(prefix, grant.n);
      if (grant.organizationRole) {
        await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [organization, userId, grant.organizationRole]);
      }
      if (grant.chapterRole) {
        for (const table of ["member_roles", "member_role_chapters"]) {
          await db.query(`insert into public.${table}(user_id,role,chapter_id,granted_by) values ($1,$2,$3,$1)`, [userId, grant.chapterRole, `${prefix}-ch-${grant.chapter}`]);
        }
      }
    }
    // Callers: a verified factor and an aal2 session each.
    const callers = {};
    for (const grant of staff.filter((entry) => entry.caller)) {
      const userId = id(prefix, grant.n);
      const session = id(`${prefix.slice(0, 7)}5`, grant.n);
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,secret,created_at,updated_at) values (gen_random_uuid(),$1,'scale','totp','verified','scale',now(),now())", [userId]);
      callers[grant.caller] = { id: userId, session };
    }
    return callers;
  }

  async function sessions(callers) {
    for (const caller of Object.values(callers)) {
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),'aal2')", [caller.session, caller.id]);
    }
  }

  let small;
  let scale;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "staff-roster-engagement-scale-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '120s'");
    await db.query("set local track_functions = 'all'");
    // Fixture rows only; triggers resume before sessions and every call.
    await db.query("set local session_replication_role = replica");
    small = await seedOrganization("b7170000", id("b7170fff", 1), 30, {
      other: 6,
      staff: [
        { n: 1, organizationRole: "admin", caller: "orgAdmin" },
        { n: 2, chapterRole: "coordinator", chapter: 2, caller: "chapterCoordinator" },
        { n: 3, chapterRole: "admin", chapter: 3, caller: "chapterAdmin" },
        { n: 4, chapterRole: "steward", chapter: 4, caller: "chapterSteward" },
        { n: 5, organizationRole: "steward", caller: "orgSteward" },
        { n: 6, organizationRole: "vp", caller: "orgVp" },
        { n: 7, chapterRole: "advisor", chapter: 2 },
        { n: 12, chapterRole: "steward", chapter: 2 },
        { n: 20, caller: "member" },
      ],
    });
    // One member whose profile chapter sits in the other organization, so the
    // roster's located chapter and the visibility predicate disagree.
    await db.query("update public.member_profiles set chapter_id='b7170000-ch-6' where id=$1", [id("b7170000", 11)]);
    for (const table of ["member_roles", "member_role_chapters"]) {
      await db.query(`insert into public.${table}(user_id,role,chapter_id,granted_by) values ($1,'coordinator','b7170000-ch-1',$1)`, [id("b7170000", 11)]);
    }
    scale = await seedOrganization("c7170000", id("c7170fff", 1), SCALE_MEMBERS, {
      other: OTHER_MEMBERS,
      staff: [
        ...Array.from({ length: 70 }, (_, index) => ({ n: index + 1, chapterRole: index < 60 ? "steward" : "coordinator", chapter: (index % 5) + 1 })),
        // Member 61 already holds the coordinator role in chapter 1 above.
        { n: 61, caller: "chapterCoordinator" },
        { n: SCALE_MEMBERS, organizationRole: "admin", caller: "orgAdmin" },
      ],
    });
    await db.query("set local session_replication_role = origin");
    await sessions(small);
    await sessions(scale);
    await db.query(`analyze public.member_profiles, public.organization_memberships, public.member_chapter_memberships,
      public.member_roles, public.member_role_chapters, public.organization_role_grants, public.chapters`);
  }, runnerTimeout(120_000));

  afterAll(async () => {
    await db?.query("rollback").catch(() => {});
    await db?.end();
  });

  it("returns exactly the predecessor's rows and refusals for every caller", async () => {
    const installed = {};
    for (const [who, caller] of Object.entries(small)) {
      installed[who] = { roster: await call(caller, ROSTER), snapshot: await call(caller, SNAPSHOT) };
    }
    await db.query("savepoint predecessor");
    try {
      // 20261124175100 (#9533) gave the roster an optional p_chapter_only
      // argument; drop it so the zero-argument predecessor is the only one.
      await db.query("drop function public.get_staff_roster(boolean)");
      await db.query(predecessor("get_staff_roster"));
      await db.query(predecessor("get_staff_engagement_snapshot"));
      for (const [who, caller] of Object.entries(small)) {
        const roster = await call(caller, ROSTER);
        const snapshot = await call(caller, SNAPSHOT);
        expect({ value: installed[who].roster.value, error: installed[who].roster.error }, `${who} roster`).toEqual({ value: roster.value, error: roster.error });
        expect({ value: installed[who].snapshot.value, error: installed[who].snapshot.error }, `${who} snapshot`).toEqual({ value: snapshot.value, error: snapshot.error });
      }
    } finally {
      await db.query("rollback to savepoint predecessor");
    }
    // The fixture reaches every branch the comparison is meant to cover.
    expect(installed.orgAdmin.roster.value.length).toBeGreaterThan(0);
    expect(installed.chapterCoordinator.roster.value.length).toBeGreaterThan(0);
    expect(installed.chapterAdmin.roster.value.length).toBeGreaterThan(0);
    expect(installed.orgAdmin.snapshot.value.members).toHaveLength(30);
    expect(installed.orgSteward.snapshot.value.members.length).toBe(30);
    expect(installed.member.roster.error).toBe("42501");
    expect(installed.chapterSteward.roster.error).toBe("42501");
    expect(installed.chapterCoordinator.snapshot.error).toBe("42501");
    expect(installed.member.snapshot.error).toBe("42501");
  }, runnerTimeout(60_000));

  it("answers both reads at 1,000 accounts well inside the 30 s limit with fixed visibility work", async () => {
    const budget = runnerTimeout(2_000);
    const cases = [
      ["orgAdmin", ROSTER, (value) => expect(value).toHaveLength(71)],
      ["orgAdmin", SNAPSHOT, (value) => {
        expect(value.members).toHaveLength(SCALE_MEMBERS);
        expect(value.members.every((member) => member.name.startsWith("Scale member "))).toBe(true);
      }],
      ["chapterCoordinator", ROSTER, (value) => expect(value).toHaveLength(14)],
    ];
    for (const [who, sql, check] of cases) {
      await call(scale[who], sql);
      const { result, staffCanSeeUser, chapterMemberReadable } = await helperCalls(() => call(scale[who], sql));
      expect(result.error, `${who} ${sql}`).toBeUndefined();
      check(result.value);
      // The predecessor made one chapter_member_readable and up to five
      // staff_can_see_user calls per profile: about 1,200 and 5,000 here.
      expect(chapterMemberReadable, `${who} ${sql}`).toBe(0);
      expect(staffCanSeeUser, `${who} ${sql}`).toBeLessThan(20);
      expect(result.ms, `${who} ${sql}`).toBeLessThan(budget);
    }
  }, runnerTimeout(90_000));
});
