// @vitest-environment node
//
// BUG-UG-DEMO-MEMBER-FORMS-ACCESS-READ-NEVER-ANSWERS-20261124 (#9781)
// Member Forms reads public.list_member_draft_sharing once per saved draft.
// It ran private.draft_steward_covers_member on every member profile in the
// database (1,049 calls on the demo for 4 stewards, about 5 s with three
// drafts). 20261124160100 runs the helper only on holders of an organization
// steward grant in the caller's organization or a steward role in the
// caller's chapter, the only people the helper can accept.
//
// 1. For a member, a chapter steward (on an own draft), a member of another
//    chapter and a member of another organization, the function returns
//    exactly the list the full profile scan returns: same people, order and
//    shared flags.
// 2. With 300 members in five chapters plus 60 in another organization, one
//    call runs the helper only on the steward candidates, never once per
//    profile.
// Everything runs in one transaction that is rolled back.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const MEMBERS = 300;
const OTHER = 60;
const PREFIX = "d9781000";
const id = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const user = (n) => id(PREFIX, n);
const chapterOf = (n) => (n > MEMBERS ? 6 : ((n - 1) % 5) + 1);
const chapter = (c) => `${PREFIX}-ch-${c}`;

// The list as the full profile scan built it (the body 20261102005607 left),
// read with the caller's claims.
const FULL_SCAN = `select coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',person.id,'name',person.full_name,'shared',
    exists(select 1 from private.member_draft_steward_shares share where share.form_id=$1 and share.steward_id=person.id
      and share.organization_id=private.current_member_organization() and share.chapter_id=(select chapter_id from caller))) order by person.full_name,person.id)
  from (select p.id,p.full_name from public.member_profiles p
    where p.id<>(select auth.uid()) and private.draft_steward_covers_member(p.id,(select auth.uid()),(select chapter_id from caller))
    order by p.full_name,p.id limit 100) person),'[]'::jsonb) as list`;

live("draft sharing lists stewards from steward candidates only (#9781)", () => {
  let db;
  let organization;
  let otherOrganization;
  const forms = {};
  const callers = {};

  async function claims(caller) {
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: caller.id, role: "authenticated", aal: "aal2", session_id: caller.session })]);
  }

  async function installed(caller, form) {
    await db.query("savepoint call");
    try {
      await claims(caller);
      await db.query("set local role authenticated");
      const { rows } = await db.query("select public.list_member_draft_sharing($1) as list", [form]);
      return rows[0].list;
    } finally {
      await db.query("rollback to savepoint call");
      await db.query("reset role");
    }
  }

  async function fullScan(caller, form) {
    await db.query("savepoint scan");
    try {
      await claims(caller);
      const { rows } = await db.query(`with caller as (select chapter_id from public.member_profiles where id = (select auth.uid())) ${FULL_SCAN}`, [form]);
      return rows[0].list;
    } finally {
      await db.query("rollback to savepoint scan");
    }
  }

  async function helperCalls(run) {
    const calls = async () => Number((await db.query(
      // The exact helper (Sol pre-read note 3): its oid, not a name match.
      "select coalesce(sum(calls),0)::integer as n from pg_stat_xact_user_functions where funcid = 'private.draft_steward_covers_member(uuid,uuid,text)'::regprocedure",
    )).rows[0].n);
    const before = await calls();
    const result = await run();
    return { result, calls: (await calls()) - before };
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "draft-sharing-steward-candidates-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '120s'");
    await db.query("set local track_functions = 'all'");
    await db.query("set local session_replication_role = replica");

    organization = id(`${PREFIX.slice(0, 7)}f`, 1);
    otherOrganization = id(`${PREFIX.slice(0, 7)}f`, 2);
    await db.query("insert into public.organizations(id,slug,name,status) values ($1,$2,$2,'active'),($3,$4,$4,'active')",
      [organization, `sharing-${PREFIX}`, otherOrganization, `sharing-${PREFIX}-other`]);
    await db.query(`insert into public.chapters(id,name,region,is_default,order_index,organization_id,slug)
      select '${PREFIX}-ch-'||n,'Sharing chapter '||n,'sharing',false,9700+n,case when n <= 5 then $1::uuid else $2::uuid end,'${PREFIX}-ch-'||n
      from generate_series(1, 6) n`, [organization, otherOrganization]);
    const userSql = (n) => `('${PREFIX}-0000-4000-8000-'||lpad((${n})::text,12,'0'))::uuid`;
    const chapterSql = `case when n > ${MEMBERS} then 6 else ((n - 1) % 5) + 1 end`;
    await db.query(`insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
      select ${userSql("n")},'authenticated','authenticated','${PREFIX}-'||n||chr(64)||'example.invalid','{"provider":"email","providers":["email"]}','{}',now(),now(),false,false
      from generate_series(1, $1::integer) n`, [MEMBERS + OTHER]);
    await db.query(`insert into public.member_profiles(id,first_name,full_name,initials,chapter_id,role_line,member_since,language,
        notification_prefs,dnd_enabled,quiet_hours_timezone,urgent_notifications_enabled,shortcut_keys,work_widget_order,created_at,updated_at)
      select ${userSql("n")},'Sharing','Sharing member '||lpad(n::text,5,'0'),'SM','${PREFIX}-ch-'||(${chapterSql}),'Member',2020,'en','{}',false,'UTC',true,'{}','{}',now(),now()
      from generate_series(1, $1::integer) n`, [MEMBERS + OTHER]);
    await db.query(`insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,joined_at)
      select ${userSql("n")},'${PREFIX}-ch-'||(${chapterSql}),'active',true,now() from generate_series(1, $1::integer) n`, [MEMBERS + OTHER]);
    await db.query(`insert into public.organization_memberships(organization_id,user_id,status)
      select case when n > $2::integer then $3::uuid else $1::uuid end,${userSql("n")},'active' from generate_series(1, $4::integer) n`,
    [organization, MEMBERS, otherOrganization, MEMBERS + OTHER]);
    // Chapter stewards: members 1 to 10 (two per chapter), one in the other
    // organization (301). An organization steward (11, chapter one). A
    // coordinator in chapter one (16) holds no steward role.
    const chapterRole = async (n, role) => {
      for (const table of ["member_roles", "member_role_chapters"]) {
        await db.query(`insert into public.${table}(user_id,role,chapter_id,granted_by) values ($1,$2,$3,$1)`, [user(n), role, chapter(chapterOf(n))]);
      }
    };
    for (let n = 1; n <= 10; n += 1) await chapterRole(n, "steward");
    await chapterRole(MEMBERS + 1, "steward");
    await chapterRole(16, "coordinator");
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'steward',$2)", [organization, user(11)]);
    const caller = (key, n) => { callers[key] = { id: user(n), session: id(`${PREFIX.slice(0, 7)}5`, n) }; };
    caller("member", 21); // chapter one
    caller("steward", 6); // a chapter-one steward, on an own draft
    caller("otherChapter", 22); // chapter two
    caller("otherOrganization", MEMBERS + 6); // chapter six, the other organization
    // Every caller and every steward holds a verified second factor (an
    // organization steward needs one where staff MFA is required).
    const withFactor = new Set([...Object.values(callers).map((entry) => entry.id), ...[1, 2, 3, 4, 5, 7, 8, 9, 10, 11, MEMBERS + 1].map(user)]);
    for (const entry of [...withFactor].map((factorUser) => ({ id: factorUser }))) {
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,secret,created_at,updated_at) values (gen_random_uuid(),$1,'sharing','totp','verified','sharing',now(),now())", [entry.id]);
    }
    for (const [key, entry] of Object.entries(callers)) {
      const formId = id(`${PREFIX.slice(0, 7)}a`, Object.keys(forms).length + 1);
      await db.query(`insert into public.member_forms(id,user_id,template_key,template_version,status,answers,step,created_at,updated_at)
        values ($1,$2,'grievance',1,'draft','{"summary":"Fixture"}'::jsonb,1,now(),now())`, [formId, entry.id]);
      forms[key] = formId;
    }
    // The member's draft is already shared with one chapter-one steward.
    await db.query("insert into private.member_draft_steward_shares(form_id,steward_id,organization_id,chapter_id) values ($1,$2,$3,$4)",
      [forms.member, user(1), organization, chapter(1)]);
    await db.query("set local session_replication_role = origin");
    for (const entry of Object.values(callers)) {
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),'aal2')", [entry.session, entry.id]);
    }
    await db.query("analyze public.member_profiles, public.member_role_chapters, public.organization_role_grants, public.member_chapter_memberships, public.organization_memberships");
    await migrateLegacyStewardFixtures(db);
  }, runnerTimeout(120_000));

  afterAll(async () => {
    await db?.query("rollback").catch(() => {});
    await db?.end();
  });

  it("returns exactly the full scan's list to a member, a steward, another chapter's member and another organization's member", async () => {
    for (const key of ["member", "steward", "otherChapter", "otherOrganization"]) {
      const expected = await fullScan(callers[key], forms[key]);
      const list = await installed(callers[key], forms[key]);
      expect(list, key).toEqual(expected);
    }
    // The fixture is not empty: chapter one's member sees its two chapter
    // stewards and the organization steward, one already shared; never the
    // coordinator or another chapter's or organization's steward.
    const member = await installed(callers.member, forms.member);
    expect(member.map((row) => row.id).sort()).toEqual([user(1), user(6), user(11)].sort());
    expect(member.find((row) => row.id === user(1)).shared).toBe(true);
    expect(member.filter((row) => row.shared)).toHaveLength(1);
    const steward = await installed(callers.steward, forms.steward);
    expect(steward.map((row) => row.id)).not.toContain(user(6));
    expect((await installed(callers.otherOrganization, forms.otherOrganization)).map((row) => row.id)).toEqual([user(MEMBERS + 1)]);
  });

  it("runs the steward check on the steward candidates only, not on every profile", async () => {
    const profiles = Number((await db.query("select count(*) from public.member_profiles")).rows[0].count);
    expect(profiles).toBeGreaterThan(MEMBERS + OTHER - 1);
    const { result, calls } = await helperCalls(() => installed(callers.member, forms.member));
    expect(result).toHaveLength(3);
    // Candidates for chapter one in this organization: its two chapter
    // stewards (1 and 6) and the organization steward (11), so the helper
    // runs exactly three times (the full scan ran it once per profile).
    expect(calls).toBe(3);
  });
});
