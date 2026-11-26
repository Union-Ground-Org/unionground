// @vitest-environment node
//
// BUG-UG-STEWARD-CASE-LATEST-UPDATES-ROW-POLICY-SLOW-AT-SCALE-20261106 (#7360)
// 20261107152000 sends an authenticated caller of list_case_latest_updates
// through private.case_latest_updates_readable, which evaluates
// private.chapter_case_readable once per requested case and carries the read
// policies of member_cases, member_case_updates and member_profiles verbatim.
// The direct invoker read it replaces ran member_case_updates_select's EXISTS
// as a set over every case in the database, chapter_case_readable twice each.
//
// Every hat, at aal2 and aal1, and a PIN-restricted session, on a
// fixture with restricted, assigned and unassigned cases, a closed chapter
// policy, an explicit access grant, a private-identity case, another
// organization, a learning-period row and mentions across both organizations:
// 1. the function returns exactly the rows, totals and mention names the
//    direct invoker read (the predecessor body, verbatim) returns, and
//    service_role, which holds no select on member_case_updates, is refused by both;
// 2. the read policies of the three tables are exactly the ones the helper
//    copies (the migration's preflight pins the same digests);
// 3. at 1,000 accounts and 1,200 more cases, a 200-case desk evaluates case
//    readability at most once per requested case and answers under a second,
//    where the direct read evaluates it at least twice per requested case.
// Everything runs in one transaction that is rolled back.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const PREFIX = "f7361000";
const id = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const user = (n) => id(PREFIX, n);
const chapter = (n) => `${PREFIX}-ch-${n}`;
const BULK_MEMBERS = 1_000;
const BULK_CASES = 1_200;
const DESK = 200;

// The predecessor body of public.list_case_latest_updates, verbatim, read as
// the caller: row security decides which updates and mention names it sees.
const DIRECT_READ = `select ranked.case_id, ranked.id, ranked.body, ranked.created_at, ranked.total_count, ranked.mentions
  from (
    select u.case_id, u.id, u.body, u.created_at,
      pg_catalog.row_number() over (partition by u.case_id order by u.created_at desc, u.id desc) as rn,
      pg_catalog.count(*) over (partition by u.case_id) as total_count,
      coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object('userId', p.id, 'fullName', p.full_name)
          order by p.full_name)
        from public.member_profiles p
        where p.id = any(u.mentioned_user_ids)
      ), '[]'::jsonb) as mentions
    from public.member_case_updates u
    where u.case_id = any($1::uuid[])
  ) ranked
  where ranked.rn <= least(greatest(coalesce($2::integer, 20), 1), 100)
  order by ranked.case_id, ranked.created_at, ranked.id`;
const LISTED = "select case_id, id, body, created_at, total_count, mentions from public.list_case_latest_updates($1::uuid[], $2::integer)";

// The read policies 20261107152000 copies, by table (its preflight digests).
const REVIEWED_POLICY_DIGESTS = {
  "public.member_case_updates": "d76d00553b955bb152a1e351c069570b",
  "public.member_cases": "f0515710857e41930ad54b767d05edf1",
  "public.member_profiles": "8178be60ab8a4a8132b40605961805c7",
};

live("list_case_latest_updates evaluates case readability once per requested case (#7360)", () => {
  let db;
  let callers;
  let caseIds;
  let deskIds;

  async function as(caller, run, { aal = "aal2", role = "authenticated" } = {}) {
    await db.query("savepoint call");
    try {
      const claims = caller ? { sub: caller.id, role, aal, session_id: caller.session } : { role };
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
      await db.query(`set local role ${role}`);
      return await run();
    } finally {
      await db.query("rollback to savepoint call");
      await db.query("reset role");
    }
  }
  const read = async (sql, ids, perCase = 20) => (await db.query(sql, [ids, perCase])).rows;
  const both = (ids, perCase) => async () => ({ listed: await read(LISTED, ids, perCase), direct: await read(DIRECT_READ, ids, perCase) });
  const readableCalls = async () => (await db.query(
    "select coalesce(sum(calls),0)::integer calls from pg_stat_xact_user_functions where schemaname = 'private' and funcname = 'chapter_case_readable'",
  )).rows[0].calls;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "case-latest-updates-setwise-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '180s'");
    await db.query("set local track_functions = 'all'");
    await db.query("set local session_replication_role = replica");

    // Members 1-40 in five chapters of one organization (chapter = n mod 5),
    // 41-46 in a sixth chapter of a second organization, and the bulk members
    // 101-1100 across the first five chapters.
    const orgId = id("f7361fff", 1);
    const otherOrg = id("f7361fff", 2);
    await db.query("insert into public.organizations(id,slug,name,status) values ($1,'setwise-7360','setwise-7360','active'),($2,'setwise-7360-other','setwise-7360-other','active')", [orgId, otherOrg]);
    await db.query(`insert into public.chapters(id,name,region,is_default,order_index,organization_id,slug)
      select '${PREFIX}-ch-'||n,'Setwise chapter '||n,'scale',false,9700+n,case when n <= 5 then $1::uuid else $2::uuid end,'${PREFIX}-ch-'||n
      from generate_series(1, 6) n`, [orgId, otherOrg]);
    const members = `select n from generate_series(1, 46) n union all select n from generate_series(101, ${100 + BULK_MEMBERS}) n`;
    const userSql = `('${PREFIX}-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid`;
    const chapterSql = "case when n between 41 and 46 then 6 else ((n - 1) % 5) + 1 end";
    await db.query(`insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
      select ${userSql},'authenticated','authenticated','${PREFIX}-'||n||chr(64)||'example.invalid','{"provider":"email","providers":["email"]}','{}',now(),now(),false,false
      from (${members}) m`);
    await db.query(`insert into public.member_profiles(id,first_name,full_name,initials,chapter_id,role_line,member_since,language,
        notification_prefs,dnd_enabled,quiet_hours_timezone,urgent_notifications_enabled,shortcut_keys,work_widget_order,created_at,updated_at)
      select ${userSql},'Setwise','Setwise member '||lpad(n::text,4,'0'),'SM','${PREFIX}-ch-'||(${chapterSql}),'Member',2020,'en','{}',false,'UTC',true,'{}','{}',now(),now()
      from (${members}) m`);
    await db.query(`insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,joined_at)
      select ${userSql},'${PREFIX}-ch-'||(${chapterSql}),'active',true,now() from (${members}) m`);
    await db.query(`insert into public.organization_memberships(organization_id,user_id,status)
      select case when n between 41 and 46 then $2::uuid else $1::uuid end,${userSql},'active' from (${members}) m`, [orgId, otherOrg]);

    // Hats: member n sits in chapter ((n - 1) % 5) + 1.
    const hats = {
      chapterSteward: { n: 1, chapterRole: "steward", chapter: 1 },
      orgSteward: { n: 2, organizationRole: "steward" },
      chapterCoordinator: { n: 3, chapterRole: "coordinator", chapter: 3 },
      orgCoordinator: { n: 4, organizationRole: "coordinator" },
      advisor: { n: 5, organizationRole: "advisor" },
      admin: { n: 7, organizationRole: "admin" },
      vp: { n: 8, organizationRole: "vp" },
      grantedSteward: { n: 28, chapterRole: "steward", chapter: 3 },
      owner: { n: 11 },
      member: { n: 12 },
      foreignCoordinator: { n: 41, chapterRole: "coordinator", chapter: 6, organization: otherOrg },
      pinOwner: { n: 16 },
    };
    callers = {};
    for (const [who, hat] of Object.entries(hats)) {
      const userId = user(hat.n);
      if (hat.organizationRole) {
        await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [hat.organization ?? orgId, userId, hat.organizationRole]);
      }
      if (hat.chapterRole) {
        for (const table of ["member_roles", "member_role_chapters"]) {
          await db.query(`insert into public.${table}(user_id,role,chapter_id,granted_by) values ($1,$2,$3,$1)`, [userId, hat.chapterRole, chapter(hat.chapter)]);
        }
      }
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,secret,created_at,updated_at) values (gen_random_uuid(),$1,'setwise','totp','verified','setwise',now(),now())", [userId]);
      callers[who] = { id: userId, session: id("f7361555", hat.n) };
    }

    // Cases: [n, owner, chapter, fields].
    const cases = [
      [1, 11, 1, {}],
      [2, 16, 1, { steward: 1 }],
      [3, 21, 1, { restricted: true, steward: 1 }],
      [4, 13, 3, { restricted: true, coordinator: 3 }],
      [5, 18, 3, { restricted: true }],
      [6, 23, 3, {}],
      [7, 14, 4, {}],
      [8, 19, 4, { restricted: true }],
      [9, 12, 2, { marked: true }],
      [10, 42, 6, { organization: otherOrg }],
      [11, 15, 5, { steward: 2 }],
      [12, 11, 3, {}],
    ];
    caseIds = [];
    for (const [n, owner, at, fields] of cases) {
      const caseId = id("f7361ca5", n);
      caseIds.push(caseId);
      await db.query(`insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,status,
          is_restricted,restriction_reason,restricted_at,steward_user_id,coordinator_user_id)
        values ($1,$2,$3,'Setwise case','other',$4,$5,'active',$6,case when $6 then 'Fixture restriction' end,case when $6 then now() end,$7,$8)`,
      [caseId, user(owner), `setwise-7360-${n}`, fields.organization ?? orgId, chapter(at), fields.restricted ?? false,
        fields.steward ? user(fields.steward) : null, fields.coordinator ? user(fields.coordinator) : null]);
      if (fields.marked) await db.query("insert into private.case_identity_privacy(case_id) values ($1)", [caseId]);
    }
    await db.query("insert into private.chapter_access_policies(chapter_id,steward_grievances) values ($1,false)", [chapter(4)]);
    await db.query(`insert into public.casework_access_grants(id,case_id,organization_id,chapter_id,grantee_user_id,reason,granted_at)
      values (gen_random_uuid(),$1,$2,$3,$4,'Setwise grant',now())`, [id("f7361ca5", 5), orgId, chapter(3), callers.grantedSteward.id]);

    // Updates: two by the case owner and one by another member, each naming
    // someone (the owner, a member of another chapter, the chapter steward, a
    // member of the other organization); case one also has a row undone
    // during a learning period. Same created_at on two rows tests the id tie.
    const mentionSets = [[11], [13, 1], [41, 13, 11]];
    let u = 0;
    for (const [n, owner] of cases) {
      const writers = [[owner, false], [owner, false], [owner === 11 ? 12 : 11, false], ...(n === 1 ? [[owner, true]] : [])];
      for (const [index, [writer, undone]] of writers.entries()) {
        u += 1;
        await db.query(`insert into public.member_case_updates(id,case_id,user_id,body,created_at,learning_undone_at,mentioned_user_ids)
          values ($1,$2,$3,'Setwise note',timestamptz '2026-11-01 12:00:00+00' - make_interval(mins => $4::integer),$5,$6::uuid[])`,
        [id("f736100a", u), id("f7361ca5", n), user(writer), index === 1 ? u - 1 : u, undone ? new Date() : null,
          mentionSets[index % 3].map(user)]);
      }
    }

    // Bulk: 1,200 more cases owned by the bulk members, steward member 2
    // assigned to the first 200 (the desk), two updates each.
    await db.query(`insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,status,is_restricted,steward_user_id)
      select ('f7361cb5-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
        ('${PREFIX}-0000-4000-8000-'||lpad((101 + (n - 1) % ${BULK_MEMBERS})::text,12,'0'))::uuid,
        'setwise-7360-bulk-'||n,'Setwise bulk case','other',$1,'${PREFIX}-ch-'||(((101 + (n - 1) % ${BULK_MEMBERS}) - 1) % 5 + 1),'active',false,
        case when n <= ${DESK} then $2::uuid end
      from generate_series(1, ${BULK_CASES}) n`, [orgId, callers.orgSteward.id]);
    await db.query(`insert into public.member_case_updates(id,case_id,user_id,body,created_at,mentioned_user_ids)
      select gen_random_uuid(), c.id, c.user_id, 'Setwise bulk note', now() - make_interval(mins => k), array[c.user_id]
      from public.member_cases c cross join generate_series(1, 2) k where c.reference like 'setwise-7360-bulk-%'`);
    deskIds = (await db.query(
      "select id from public.member_cases where reference like 'setwise-7360-bulk-%' and steward_user_id = $1 order by id", [callers.orgSteward.id],
    )).rows.map((row) => row.id);

    await db.query("set local session_replication_role = origin");
    for (const caller of Object.values(callers)) {
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),'aal2')", [caller.session, caller.id]);
    }
    // The PIN-restricted session reads nothing through any of the tables.
    await db.query("insert into private.member_pin_sessions(session_id,user_id) values ($1,$2)", [callers.pinOwner.session, callers.pinOwner.id]);
    await db.query("analyze public.member_cases, public.member_case_updates, public.member_profiles");

    // #8589 re-final: committed data gives every steward grant its migration

    // assignments; an organization grant reaches only chapters it has one in.

    await migrateLegacyStewardFixtures(db);
  }, runnerTimeout(180_000));

  afterAll(async () => {
    await db?.query("rollback").catch(() => {});
    await db?.end();
  });

  it("gives every caller exactly the rows, totals and mention names of the direct read", async () => {
    const results = {};
    for (const [who, caller] of Object.entries(callers)) {
      results[who] = await as(caller, both(caseIds));
      results[`${who}Aal1`] = await as(caller, both(caseIds), { aal: "aal1" });
      results[`${who}PerCase1`] = await as(caller, both(caseIds, 1));
    }
    for (const [who, { listed, direct }] of Object.entries(results)) expect(listed, who).toEqual(direct);
    // service_role holds no select on member_case_updates: both refuse it alike.
    for (const sql of [LISTED, DIRECT_READ]) {
      await expect(as(null, () => read(sql, caseIds), { role: "service_role" })).rejects.toThrow("permission denied for table member_case_updates");
    }

    // Not vacuous: stewards and coordinators read notes with mention names,
    // a name the reader may not learn is dropped, the other organization's
    // case reaches only its own coordinator, every aal1 and PIN session reads
    // nothing, and the learning-period row reaches nobody.
    for (const who of ["owner", "chapterSteward", "orgSteward", "chapterCoordinator", "orgCoordinator", "grantedSteward"]) {
      expect(results[who].listed.length, who).toBeGreaterThan(0);
    }
    const named = (rows) => new Set(rows.flatMap((row) => row.mentions.map((mention) => mention.userId)));
    expect(named(results.orgCoordinator.listed)).toContain(user(13));
    expect(named(results.orgCoordinator.listed)).not.toContain(user(41));
    expect(named(results.owner.listed)).toEqual(new Set([user(11)]));
    const otherCase = id("f7361ca5", 10);
    expect(new Set(results.foreignCoordinator.listed.map((row) => row.case_id))).toEqual(new Set([otherCase]));
    expect(named(results.foreignCoordinator.listed)).toEqual(new Set([user(41)]));
    for (const who of Object.keys(callers).filter((name) => name !== "foreignCoordinator")) {
      expect(results[who].listed.map((row) => row.case_id), who).not.toContain(otherCase);
    }
    for (const who of Object.keys(callers)) expect(results[`${who}Aal1`].listed, who).toEqual([]);
    expect(results.pinOwner.listed).toEqual([]);
    expect(await as(callers.pinOwner, async () => (await db.query("select private.member_pin_session_restricted() r")).rows[0].r)).toBe(true);
    const undone = id("f736100a", 4);
    for (const [who, { listed }] of Object.entries(results)) expect(listed.map((row) => row.id), who).not.toContain(undone);
    expect(results.chapterSteward.listed.every((row) => Number(row.total_count) >= 1)).toBe(true);
    expect(results.chapterStewardPerCase1.listed.length).toBeLessThan(results.chapterSteward.listed.length);
  }, runnerTimeout(120_000));

  it("copies read policies that are exactly the installed ones", async () => {
    await db.query("savepoint digests");
    try {
      await db.query("set local search_path = pg_catalog");
      const { rows } = await db.query(`select p.polrelid::regclass::text tbl, md5(string_agg(concat_ws(':', p.polname, p.polcmd, p.polpermissive,
          p.polroles::regrole[]::text, pg_get_expr(p.polqual, p.polrelid)), chr(10) order by p.polname)) digest
        from pg_policy p
        where p.polrelid in ('public.member_cases'::regclass, 'public.member_case_updates'::regclass, 'public.member_profiles'::regclass)
          and p.polcmd in ('r', '*')
        group by 1 order by 1`);
      expect(Object.fromEntries(rows.map((row) => [row.tbl, row.digest]))).toEqual(REVIEWED_POLICY_DIGESTS);
    } finally {
      await db.query("rollback to savepoint digests");
    }
    const { rows: [fn] } = await db.query(`select p.prosecdef, p.provolatile, pg_catalog.has_function_privilege('anon', p.oid, 'execute') anon_exec,
        pg_catalog.has_function_privilege('authenticated', p.oid, 'execute') authenticated_exec
      from pg_proc p where p.oid = 'private.case_latest_updates_readable(uuid[],integer)'::regprocedure`);
    expect(fn).toEqual({ prosecdef: true, provolatile: "s", anon_exec: false, authenticated_exec: true });
  }, runnerTimeout(30_000));

  it("evaluates readability at most once per requested case on a 200-case desk at 1,000 accounts", async () => {
    expect(deskIds).toHaveLength(DESK);
    const { rows: [scale] } = await db.query("select (select count(*) from public.member_profiles)::integer profiles, (select count(*) from public.member_cases)::integer cases");
    expect(scale.profiles).toBeGreaterThanOrEqual(BULK_MEMBERS);
    expect(scale.cases).toBeGreaterThan(BULK_CASES);
    const measure = (sql) => as(callers.orgSteward, async () => {
      await read(sql, deskIds);
      const before = await readableCalls();
      const started = performance.now();
      const rows = await read(sql, deskIds);
      return { rows, ms: performance.now() - started, calls: (await readableCalls()) - before };
    });
    const listed = await measure(LISTED);
    const direct = await measure(DIRECT_READ);
    expect(listed.rows).toEqual(direct.rows);
    expect(listed.rows).toHaveLength(2 * DESK);
    expect(listed.calls).toBeLessThanOrEqual(DESK);
    expect(direct.calls).toBeGreaterThanOrEqual(2 * DESK);
    expect(listed.ms).toBeLessThan(runnerTimeout(1_000));
  }, runnerTimeout(120_000));
});
