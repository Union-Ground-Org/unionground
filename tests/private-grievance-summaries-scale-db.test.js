// @vitest-environment node
//
// BUG-UG-STEWARD-SHARED-ACCESS-PANEL-TIMEOUT-AT-SCALE-20261106 (#7209)
// public.list_private_grievance_summaries (the steward desk's shared-access
// panel) took 12 s on SAMPLE at 1,002 accounts and 274 cases with no case
// marked private: the planner drove it from public.member_cases and ran the
// steward-scope and readability helpers for every case of the organization
// before the join to private.case_identity_privacy removed them all.
// 20261106200000 walks only the marked cases of the caller's organization.
//
// 1. On a small fixture each caller sees exactly the summaries it should, and
//    the installed body returns exactly what the 20261104075000 body returns.
// 2. At 1,000 accounts plus 200 in another organization, with 274 cases, a
//    steward's read answers in under 1 s (runner-scaled) with and without
//    private cases, and runs the steward scope only for marked cases; the old
//    body runs it for every case of the organization.
// Everything runs in one transaction that is rolled back.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const PREDECESSOR = new URL("../supabase/migrations/20261104075000_learning_period_case_records.sql", import.meta.url);
const SUMMARIES = "select public.list_private_grievance_summaries() value";
const SCALE_MEMBERS = 1000;
const OTHER_MEMBERS = 200;
const SCALE_CASES = 274;

// The predecessor definition exactly as 20261104075000 installed it.
function predecessor() {
  const sql = readFileSync(PREDECESSOR, "utf8");
  const start = sql.indexOf("create or replace function public.list_private_grievance_summaries()");
  const end = sql.indexOf("\n$function$;\n", start);
  if (start < 0 || end < 0) throw new Error("predecessor list_private_grievance_summaries not found");
  return sql.slice(start, end + "\n$function$;\n".length);
}

const id = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

live("private grievance summaries at organization scale (#7209)", () => {
  let db;

  async function call(caller, { aal = "aal2" } = {}) {
    await db.query("savepoint call");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: caller.id, role: "authenticated", aal, session_id: caller.session })]);
      await db.query("set local role authenticated");
      // The hosted authenticated role's limit.
      await db.query("set local statement_timeout = '30s'");
      const started = performance.now();
      const { rows } = await db.query(SUMMARIES);
      return { ms: performance.now() - started, value: rows[0].value };
    } catch (error) {
      return { error: error.code, message: error.message };
    } finally {
      await db.query("rollback to savepoint call");
      await db.query("reset role");
    }
  }

  async function scopeCalls(run) {
    const read = async () => (await db.query(
      `select coalesce(sum(calls),0)::integer calls from pg_stat_xact_user_functions
        where schemaname = 'private' and funcname = 'chapter_grievance_steward_scope'`,
    )).rows[0].calls;
    const before = await read();
    const result = await run();
    return { result, scope: (await read()) - before };
  }

  // n members in five chapters of one organization (chapter = n mod 5), plus
  // `other` members in a sixth chapter of a second organization; cases are
  // owned by members and placed in their owner's chapter.
  async function seedOrganization(prefix, organization, members, { other = 0, staff = [] } = {}) {
    const user = (n) => `'${prefix}-0000-4000-8000-'||lpad((${n})::text,12,'0')`;
    const otherOrganization = id(`${prefix.slice(0, 7)}f`, 9);
    await db.query(`insert into public.organizations(id,slug,name,status) values ($1,$2,$2,'active'),($3,$4,$4,'active')`,
      [organization, `scale-${prefix}`, otherOrganization, `scale-${prefix}-other`]);
    await db.query(`insert into public.chapters(id,name,region,is_default,order_index,organization_id,slug)
      select '${prefix}-ch-'||n,'Scale chapter '||n,'scale',false,9900+n,
        case when n <= 5 then $1::uuid else $2::uuid end,'${prefix}-ch-'||n
      from generate_series(1, 6) n`, [organization, otherOrganization]);
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
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,secret,created_at,updated_at) values (gen_random_uuid(),$1,'scale','totp','verified','scale',now(),now())", [userId]);
      callers[grant.caller] = { id: userId, session: id(`${prefix.slice(0, 7)}5`, grant.n) };
    }
    return { callers, otherOrganization };
  }

  async function insertCase(prefix, organization, n, owner, chapter, fields = {}) {
    const caseId = id(`${prefix.slice(0, 7)}c`, n);
    await db.query(`insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,status,
        is_restricted,restriction_reason,restricted_at,learning_undone_at,steward_user_id)
      values ($1,$2,$3,'Fixture case','other',$4,$5,$6,$7,case when $7 then 'Fixture restriction' end,case when $7 then now() end,$8,$9)`,
    [caseId, owner, `${prefix}-${n}`, organization, `${prefix}-ch-${chapter}`, fields.status ?? "active",
      fields.restricted ?? false, fields.undone ? new Date() : null, fields.steward ?? null]);
    if (fields.marked ?? true) await db.query("insert into private.case_identity_privacy(case_id) values ($1)", [caseId]);
    return caseId;
  }

  async function sessions(callers) {
    for (const caller of Object.values(callers)) {
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),'aal2')", [caller.session, caller.id]);
    }
  }

  let small;
  let smallCases;
  let scale;
  let scaleCase;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "private-grievance-summaries-scale-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '120s'");
    await db.query("set local track_functions = 'all'");
    // Fixture rows only; triggers resume before sessions and every call.
    await db.query("set local session_replication_role = replica");

    const smallOrg = id("b7209fff", 1);
    const seeded = await seedOrganization("b7209000", smallOrg, 30, {
      other: 6,
      staff: [
        { n: 1, chapterRole: "steward", chapter: 1, caller: "chapterSteward" },
        { n: 2, organizationRole: "steward", caller: "orgSteward" },
        { n: 3, chapterRole: "coordinator", chapter: 1, caller: "coordinator" },
        { n: 11, caller: "member" },
        { n: 31, caller: "foreignMember" },
      ],
    });
    small = seeded.callers;
    // Stewards may not see grievances in chapter 4.
    await db.query("insert into private.chapter_access_policies(chapter_id,steward_grievances) values ('b7209000-ch-4',false)");
    const owner = (n) => id("b7209000", n); // member n sits in chapter ((n - 1) % 5) + 1
    smallCases = {
      chapterOne: await insertCase("b7209000", smallOrg, 1, owner(11), 1),
      chapterOneResolved: await insertCase("b7209000", smallOrg, 2, owner(16), 1, { status: "resolved" }),
      chapterTwo: await insertCase("b7209000", smallOrg, 3, owner(12), 2),
      restricted: await insertCase("b7209000", smallOrg, 4, owner(21), 1, { restricted: true }),
      undone: await insertCase("b7209000", smallOrg, 5, owner(26), 1, { undone: true }),
      closedToStewards: await insertCase("b7209000", smallOrg, 6, owner(14), 4),
      assignedToSteward: await insertCase("b7209000", smallOrg, 7, owner(6), 1, { steward: small.chapterSteward.id }),
      unmarked: await insertCase("b7209000", smallOrg, 8, owner(11), 1, { marked: false }),
      otherOrganization: await insertCase("b7209000", seeded.otherOrganization, 9, owner(31), 6),
    };

    const scaleOrg = id("c7209fff", 1);
    scale = (await seedOrganization("c7209000", scaleOrg, SCALE_MEMBERS, {
      other: OTHER_MEMBERS,
      staff: [
        ...Array.from({ length: 45 }, (_, index) => ({ n: index + 1, chapterRole: "steward", chapter: (index % 5) + 1 })),
        { n: 1, caller: "chapterSteward" },
        { n: 46, organizationRole: "steward", caller: "orgSteward" },
      ],
    })).callers;
    // 274 cases owned by members 103, 106, ... in their own chapters.
    await db.query(`insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,status)
      select ('c7209ca5-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
        ('c7209000-0000-4000-8000-'||lpad((100+n*3)::text,12,'0'))::uuid,'scale-'||n,'Scale case','other',$1,
        'c7209000-ch-'||(((100+n*3-1)%5)+1),case when n%4=0 then 'resolved' else 'active' end
      from generate_series(1, $2::integer) n`, [scaleOrg, SCALE_CASES]);
    scaleCase = (n) => id("c7209ca5", n);
    // The other organization's 600 cases are all marked private, so the marks
    // outnumber the organization's own cases as the planner saw on SAMPLE.
    await db.query(`insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,status)
      select ('c7209ca6-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
        ('c7209000-0000-4000-8000-'||lpad((${SCALE_MEMBERS}+1+n%${OTHER_MEMBERS})::text,12,'0'))::uuid,'other-'||n,'Other case','other',$1,
        'c7209000-ch-6','active'
      from generate_series(1, 600) n`, [id("c720900f", 9)]);
    await db.query("insert into private.case_identity_privacy(case_id) select ('c7209ca6-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1, 600) n");

    await db.query("set local session_replication_role = origin");
    await sessions(small);
    await sessions(scale);
    // #8589 re-final: committed data gives every steward grant its migration
    // assignments; an organization grant reaches only chapters it has one in.
    await migrateLegacyStewardFixtures(db);
    await db.query(`analyze public.member_cases, private.case_identity_privacy, public.member_profiles, public.organization_memberships,
      public.member_chapter_memberships, public.member_role_chapters, public.organization_role_grants, public.chapters`);
  }, runnerTimeout(120_000));

  afterAll(async () => {
    await db?.query("rollback").catch(() => {});
    await db?.end();
  });

  it("lists exactly the private cases each caller may know of, as the predecessor did", async () => {
    const summary = (key, status = "active") => ({ id: smallCases[key], status });
    const installed = {};
    for (const [who, caller] of Object.entries(small)) installed[who] = await call(caller);
    installed.chapterStewardAal1 = await call(small.chapterSteward, { aal: "aal1" });

    // Chapter one's steward: the private cases of chapter one it cannot open,
    // never a restricted, undone, unmarked, assigned or other chapter's case.
    expect(installed.chapterSteward).toMatchObject({ value: [summary("chapterOne"), summary("chapterOneResolved", "resolved")] });
    // The organization steward also sees chapter two and the case assigned to
    // the chapter steward; chapter four keeps grievances from stewards.
    expect(installed.orgSteward.value).toEqual(
      [summary("chapterOne"), summary("chapterOneResolved", "resolved"), summary("chapterTwo"), summary("assignedToSteward")]
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
    for (const who of ["coordinator", "member", "foreignMember", "chapterStewardAal1"]) {
      expect(installed[who], who).toMatchObject({ value: [] });
    }

    await db.query("savepoint predecessor");
    try {
      await db.query(predecessor());
      for (const [who, caller] of Object.entries(small)) {
        const before = await call(caller);
        expect({ value: installed[who].value, error: installed[who].error }, who).toEqual({ value: before.value, error: before.error });
      }
      const aal1 = await call(small.chapterSteward, { aal: "aal1" });
      expect(aal1.value).toEqual(installed.chapterStewardAal1.value);
    } finally {
      await db.query("rollback to savepoint predecessor");
    }
  }, runnerTimeout(60_000));

  it("answers a steward in under 1 s at 1,000 accounts with and without private cases", async () => {
    const budget = runnerTimeout(1_000);
    const measure = async (who) => {
      await call(scale[who]);
      return scopeCalls(() => call(scale[who]));
    };

    // No case is marked private (SAMPLE today): no steward-scope work at all.
    for (const who of ["chapterSteward", "orgSteward"]) {
      const { result, scope } = await measure(who);
      expect(result.error, who).toBeUndefined();
      expect(result.value, who).toEqual([]);
      // The predecessor ran the steward scope for each of the 274 cases.
      expect(scope, who).toBe(0);
      expect(result.ms, who).toBeLessThan(budget);
    }

    // Every 23rd case is marked: the scope runs for those 11 cases only.
    await db.query("savepoint marked");
    try {
      await db.query(`insert into private.case_identity_privacy(case_id)
        select ('c7209ca5-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(23, $1::integer, 23) n`, [SCALE_CASES]);
      const marked = Array.from({ length: 11 }, (_, index) => (index + 1) * 23);
      const status = (n) => (n % 4 === 0 ? "resolved" : "active");
      const expected = {
        // Chapter one holds the cases whose owner (100 + 3n) is 1 mod 5.
        chapterSteward: marked.filter((n) => (100 + n * 3 - 1) % 5 === 0),
        orgSteward: marked,
      };
      for (const who of ["chapterSteward", "orgSteward"]) {
        const { result, scope } = await measure(who);
        expect(result.error, who).toBeUndefined();
        expect(result.value, who).toEqual(expected[who].map((n) => ({ id: scaleCase(n), status: status(n) })));
        expect(scope, who).toBeLessThanOrEqual(marked.length);
        expect(result.ms, who).toBeLessThan(budget);
      }
      expect(expected.chapterSteward.length).toBeGreaterThan(0);
    } finally {
      await db.query("rollback to savepoint marked");
    }
  }, runnerTimeout(90_000));
});
