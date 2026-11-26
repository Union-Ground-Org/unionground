// @vitest-environment node
// #7664: broad-publisher fixtures hold the chapter/global lead grant; scoped steward controls remain unchanged.
//
// BUG-UG-BROADCAST-READ-COUNTS-FOR-PER-RECEIPT-READ-SLOW-AT-SCALE-20261106 (#7357)
// public.get_broadcast_read_counts_for (the steward desk's read counts for a
// page of broadcasts) took 4.4 s on SAMPLE at 1,002 accounts: for each
// broadcast asked for it ran the security-definer audience check
// private.member_scoped_notice_in_audience once per receipt, and
// private.can_read_member_broadcast plus the publisher checks once per
// broadcast. 20261106225000 takes the readable set once and counts the
// receipts in one aggregate, as 20261106223000 did for
// public.get_broadcast_read_counts (#7347).
//
// 1. On a small fixture with unit, committee, ended-committee, retracted,
//    foreign, ownerless, unknown and repeated ids, each hat gets exactly what
//    the 20261102005607 body returns, including refusals and bad id lists.
// 2. At 1,000 accounts plus 200 in another organization, with 240 broadcasts
//    over two years and about 90,000 receipts, a chapter lead and an
//    organization lead asking for the 100 newest get the predecessor's
//    counts in under 1 s (runner-scaled), and the audience check runs at most
//    once per broadcast, never once per receipt as the predecessor did.
// Everything runs in one transaction that is rolled back.
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const PREDECESSOR = new URL("../supabase/migrations/20261102005607_unit_committee_scoped_access.sql", import.meta.url);
const COUNTS = "select public.get_broadcast_read_counts_for($1::text[]) value";
const SCALE_MEMBERS = 1000;
const OTHER_MEMBERS = 200;
const SCALE_BROADCASTS = 240;
const OTHER_BROADCASTS = 60;

// The predecessor definition exactly as 20261102005607 installed it.
function predecessor() {
  const sql = readFileSync(PREDECESSOR, "utf8");
  const start = sql.indexOf("create or replace function public.get_broadcast_read_counts_for(p_broadcast_ids text[])");
  const end = sql.indexOf("\n$function$;\n", start);
  if (start < 0 || end < 0) throw new Error("predecessor get_broadcast_read_counts_for not found");
  return sql.slice(start, end + "\n$function$;\n".length);
}

const id = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

live("broadcast read counts for a page at organization scale (#7357)", () => {
  let db;

  async function call(caller, ids, { aal = "aal2" } = {}) {
    await db.query("savepoint call");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: caller.id, role: "authenticated", aal, session_id: caller.session })]);
      await db.query("set local role authenticated");
      // The hosted authenticated role's limit.
      await db.query("set local statement_timeout = '30s'");
      const started = performance.now();
      const { rows } = await db.query(COUNTS, [ids]);
      return { ms: performance.now() - started, value: rows[0].value };
    } catch (error) {
      return { error: error.code, message: error.message };
    } finally {
      await db.query("rollback to savepoint call");
      await db.query("reset role");
    }
  }

  async function audienceCalls(run) {
    const read = async () => (await db.query(
      `select coalesce(sum(calls),0)::integer calls from pg_stat_xact_user_functions
        where schemaname = 'private' and funcname = 'member_scoped_notice_in_audience'`,
    )).rows[0].calls;
    const before = await read();
    const result = await run();
    return { result, audience: (await read()) - before };
  }

  // n members in five chapters of one organization (chapter = n mod 5), plus
  // `other` members in a sixth chapter of a second organization.
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
    return { callers: await grantStaff(prefix, organization, staff), otherOrganization };
  }

  // Organization, chapter and unit- or committee-scoped roles; callers get a
  // verified factor and an aal2 session each.
  async function grantStaff(prefix, organization, staff) {
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
      if (grant.scope) {
        await db.query("insert into private.chapter_role_scopes(user_id,chapter_id,role,unit_id,committee_id) values ($1,$2,$3,$4,$5)",
          [userId, `${prefix}-ch-${grant.chapter}`, grant.chapterRole, grant.scope.unit ?? null, grant.scope.committee ?? null]);
      }
    }
    const callers = {};
    for (const grant of staff.filter((entry) => entry.caller)) {
      const userId = id(prefix, grant.n);
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,secret,created_at,updated_at) values (gen_random_uuid(),$1,'scale','totp','verified','scale',now(),now())", [userId]);
      callers[grant.caller] = { id: userId, session: id(`${prefix.slice(0, 7)}5`, grant.n) };
    }
    return callers;
  }

  async function insertBroadcast(prefix, n, { organization, chapter, scope, unit = null, committee = null, retracted = false, ageDays }) {
    const broadcastId = `${prefix}-b-${n}`;
    await db.query(`insert into public.member_broadcasts(id,sender,title,body,published_at,order_index,organization_id,chapter_id,audience_scope,access_unit_id,access_committee_id,retracted_at)
      values ($1,'Chapter steward','Fixture notice','Fixture body',now() - make_interval(days => $2::integer),$3,$4,$5,$6,$7,$8,case when $9 then now() end)`,
    [broadcastId, ageDays, 735_700_000 + n, organization, chapter && `${prefix}-ch-${chapter}`, scope, unit, committee, retracted]);
    return broadcastId;
  }

  async function sessions(callers) {
    for (const caller of Object.values(callers)) {
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),'aal2')", [caller.session, caller.id]);
    }
  }

  let small;
  let smallBroadcasts;
  let smallIds;
  let scale;
  let scaleIds;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "broadcast-read-counts-for-scale-proof" });
    await db.connect();
    await db.query("begin");
    // #8568: the predecessor reads the session day and the current reader the
    // Eastern day; compare them on one day, the Eastern one.
    await db.query("set local timezone to 'America/New_York'");
    await db.query("set local statement_timeout = '120s'");
    await db.query("set local track_functions = 'all'");
    // Fixture rows only; triggers resume before sessions and every call.
    await db.query("set local session_replication_role = replica");

    const smallOrg = id("b7357fff", 1);
    const unit = id("b7357a01", 1);
    const committee = id("b7357a02", 1);
    const endedCommittee = id("b7357a02", 2);
    const chapterOne = "b7357000-ch-1";
    const seeded = await seedOrganization("b7357000", smallOrg, 30, { other: 6 });
    // Chapter one holds members 1, 6, 11, 16, 21 and 26.
    await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values ($1,$2,$3,'Fixture unit')", [unit, smallOrg, chapterOne]);
    await db.query(`insert into private.chapter_committees(id,chapter_id,name,purpose,starts_on,ends_on) values
      ($1,$3,'Fixture committee','Fixture purpose',current_date - 30,null),
      ($2,$3,'Ended committee','Fixture purpose',current_date - 30,current_date - 1)`, [committee, endedCommittee, chapterOne]);
    const members = (container, table, column, ns) => db.query(`insert into private.${table}(${column},chapter_id,user_id) select $1,$2,u from unnest($3::uuid[]) u`,
      [container, chapterOne, ns.map((n) => id("b7357000", n))]);
    await members(unit, "chapter_unit_members", "unit_id", [1, 6, 21]);
    await members(committee, "chapter_committee_members", "committee_id", [1, 11, 26]);
    await members(endedCommittee, "chapter_committee_members", "committee_id", [1, 16]);
    small = await grantStaff("b7357000", smallOrg, [
      { n: 1, chapterRole: "vp", chapter: 1, caller: "chapterLead" },
      { n: 2, organizationRole: "vp", caller: "orgLead" },
      { n: 6, chapterRole: "steward", chapter: 1, scope: { unit }, caller: "unitSteward" },
    // Committee-only scope remains valid for coordinators.
      { n: 11, chapterRole: "coordinator", chapter: 1, scope: { committee }, caller: "committeeCoordinator" },
      { n: 7, chapterRole: "vp", chapter: 2, caller: "chapterTwoLead" },
      { n: 3, chapterRole: "coordinator", chapter: 3, caller: "coordinator" },
      { n: 16, caller: "member" },
      { n: 31, chapterRole: "vp", chapter: 6, caller: "foreignLead" },
    ]);
    // Member 21 left the organization; member 26 left chapter one. Their
    // receipts stay and must not be counted where they left the audience.
    await db.query("update public.organization_memberships set status = 'revoked', revoked_at = now() where user_id = $1", [id("b7357000", 21)]);
    await db.query("update public.member_chapter_memberships set status = 'revoked', revoked_at = now() where user_id = $1", [id("b7357000", 26)]);

    smallBroadcasts = {
      organization: await insertBroadcast("b7357000", 1, { organization: smallOrg, chapter: 2, scope: "organization", ageDays: 1 }),
      chapterOne: await insertBroadcast("b7357000", 2, { organization: smallOrg, chapter: 1, scope: "chapter", ageDays: 2 }),
      chapterTwo: await insertBroadcast("b7357000", 3, { organization: smallOrg, chapter: 2, scope: "chapter", ageDays: 3 }),
      unit: await insertBroadcast("b7357000", 4, { organization: smallOrg, chapter: 1, scope: "chapter", unit, ageDays: 4 }),
      committee: await insertBroadcast("b7357000", 5, { organization: smallOrg, chapter: 1, scope: "chapter", committee, ageDays: 5 }),
      endedCommittee: await insertBroadcast("b7357000", 6, { organization: smallOrg, chapter: 1, scope: "chapter", committee: endedCommittee, ageDays: 6 }),
      retracted: await insertBroadcast("b7357000", 7, { organization: smallOrg, chapter: 1, scope: "chapter", retracted: true, ageDays: 7 }),
      foreign: await insertBroadcast("b7357000", 8, { organization: seeded.otherOrganization, chapter: 6, scope: "organization", ageDays: 1 }),
      ownerless: await insertBroadcast("b7357000", 9, { organization: null, chapter: null, scope: null, ageDays: 1 }),
    };
    const older = [];
    for (let n = 10; n < 32; n += 1) {
      older.push(await insertBroadcast("b7357000", n, { organization: smallOrg, chapter: 1, scope: "chapter", ageDays: n }));
    }
    // Every kind of notice, an unknown id, and a repeated id.
    smallIds = [...Object.values(smallBroadcasts), ...older, "b7357000-b-unknown", smallBroadcasts.chapterOne];
    // Every account has read every notice; the audience decides what counts.
    await db.query(`insert into public.member_broadcast_receipts(broadcast_id,user_id,read_at)
      select b.id, u.id, now() from public.member_broadcasts b
      cross join auth.users u
      where b.id like 'b7357000-b-%' and u.id::text like 'b7357000-%'`);

    const scaleOrg = id("c7357fff", 1);
    scale = (await seedOrganization("c7357000", scaleOrg, SCALE_MEMBERS, {
      other: OTHER_MEMBERS,
      staff: [
        ...Array.from({ length: 45 }, (_, index) => ({ n: index + 1, chapterRole: index === 0 ? "vp" : "steward", chapter: (index % 5) + 1 })),
        { n: 1, caller: "chapterLead" },
        { n: 46, organizationRole: "vp", caller: "orgLead" },
      ],
    })).callers;
    // Two years of notices, one every three days: every third reaches the
    // whole organization, the rest one chapter each.
    await db.query(`insert into public.member_broadcasts(id,sender,title,body,published_at,order_index,organization_id,chapter_id,audience_scope)
      select 'c7357000-b-'||n,'Chapter steward','Scale notice','Scale body',now() - make_interval(days => 3*n),735800000+n,$1,
        'c7357000-ch-'||((n%5)+1),case when n%3=0 then 'organization' else 'chapter' end
      from generate_series(1, $2::integer) n`, [scaleOrg, SCALE_BROADCASTS]);
    await db.query(`insert into public.member_broadcasts(id,sender,title,body,published_at,order_index,organization_id,chapter_id,audience_scope)
      select 'c7357000-o-'||n,'Chapter steward','Other notice','Other body',now() - make_interval(days => 3*n),735900000+n,$1,'c7357000-ch-6','organization'
      from generate_series(1, $2::integer) n`, [id("c735700f", 9), OTHER_BROADCASTS]);
    // Four in five audience members read each notice: about 90,000 receipts.
    await db.query(`insert into public.member_broadcast_receipts(broadcast_id,user_id,read_at)
      select 'c7357000-b-'||n,('c7357000-0000-4000-8000-'||lpad(u::text,12,'0'))::uuid,now()
      from generate_series(1, $1::integer) n
      cross join generate_series(1, $2::integer) u
      where (u+n)%5 <> 0 and (n%3=0 or ((u-1)%5)+1 = (n%5)+1)`, [SCALE_BROADCASTS, SCALE_MEMBERS]);
    await db.query(`insert into public.member_broadcast_receipts(broadcast_id,user_id,read_at)
      select 'c7357000-o-'||n,('c7357000-0000-4000-8000-'||lpad((${SCALE_MEMBERS}+u)::text,12,'0'))::uuid,now()
      from generate_series(1, $1::integer) n cross join generate_series(1, $2::integer) u`, [OTHER_BROADCASTS, OTHER_MEMBERS]);
    // Fifty members have since left the organization.
    await db.query(`update public.organization_memberships set status = 'revoked', revoked_at = now()
      where user_id in (select ('c7357000-0000-4000-8000-'||lpad(u::text,12,'0'))::uuid from generate_series(951, 1000) u)`);
    // A full page: the 100 newest of the organization's notices.
    scaleIds = Array.from({ length: 100 }, (_, index) => `c7357000-b-${index + 1}`);

    await db.query("set local session_replication_role = origin");
    await sessions(small);
    await sessions(scale);
    await db.query(`analyze public.member_broadcasts, public.member_broadcast_receipts, public.member_profiles, public.organization_memberships,
      public.member_chapter_memberships, public.member_role_chapters, public.organization_role_grants, public.chapters,
      private.chapter_unit_members, private.chapter_committee_members, private.chapter_committees, private.chapter_role_scopes`);
    // Preserve the historical broad controls.
    await migrateLegacyStewardFixtures(db);
  }, runnerTimeout(120_000));

  afterAll(async () => {
    await db?.query("rollback").catch(() => {});
    await db?.end();
  });

  const badLists = { empty: [], tooMany: Array.from({ length: 101 }, (_, index) => `b7357000-b-${index}`), missing: null };

  it("gives every hat exactly the counts and refusals the predecessor gave", async () => {
    const run = async () => {
      const results = {};
      for (const [who, caller] of Object.entries(small)) results[who] = await call(caller, smallIds);
      results.chapterLeadAal1 = await call(small.chapterLead, smallIds, { aal: "aal1" });
      for (const [name, ids] of Object.entries(badLists)) results[`chapterLead_${name}`] = await call(small.chapterLead, ids);
      return results;
    };
    const installed = await run();

    // Chapter one's lead: every notice asked for that it may read and
    // publish to, newest first, once each. Counts keep only readers still in
    // each audience: member 21 left the organization, member 26 left chapter
    // one, and the ended committee's notice reaches nobody, the lead
    // included.
    const counts = Object.fromEntries((installed.chapterLead.value ?? []).map((row) => [row.broadcastId, row.readCount]));
    expect(installed.chapterLead.error).toBeUndefined();
    expect(installed.chapterLead.value).toHaveLength(26);
    expect(installed.chapterLead.value[0].broadcastId).toBe(smallBroadcasts.chapterOne);
    expect(counts[smallBroadcasts.chapterOne]).toBe(4);
    expect(counts[smallBroadcasts.unit]).toBe(2);
    expect(counts[smallBroadcasts.committee]).toBe(2);
    expect(counts[smallBroadcasts.retracted]).toBe(4);
    for (const hidden of ["organization", "chapterTwo", "endedCommittee", "foreign", "ownerless"]) {
      expect(counts, hidden).not.toHaveProperty(smallBroadcasts[hidden]);
    }
    // The organization lead sees the organization notice (29 of 30 still
    // members) and chapter two's.
    expect(installed.orgLead.value.map((row) => row.broadcastId)).toEqual([smallBroadcasts.organization, smallBroadcasts.chapterTwo]);
    expect(installed.orgLead.value[0].readCount).toBe(29);
    // Scoped stewards see only their own container's notice.
    expect(installed.unitSteward.value).toEqual([{ broadcastId: smallBroadcasts.unit, readCount: 2 }]);
    // Committee-only scope remains valid for coordinators.
    // The retired committee-only steward
    // fixture is now a coordinator, which has no notice-publisher authority.
    expect(installed.committeeCoordinator).toMatchObject({ error: "42501" });
    for (const who of ["coordinator", "member", "chapterLeadAal1"]) {
      expect(installed[who], who).toMatchObject({ error: "42501" });
    }
    for (const name of Object.keys(badLists)) {
      expect(installed[`chapterLead_${name}`], name).toMatchObject({ error: "22023" });
    }
    expect(installed.foreignLead.value.map((row) => row.broadcastId)).not.toContain(smallBroadcasts.organization);

    await db.query("savepoint predecessor");
      // Restore the historical pre-backfill scope shape inside this rollback-only before-image.
      await db.query("delete from private.chapter_role_scopes where legacy_chapter_coverage");
    try {
      await db.query(predecessor());
      const before = await run();
      for (const who of Object.keys(installed)) {
        expect({ value: installed[who].value, error: installed[who].error }, who).toEqual({ value: before[who].value, error: before[who].error });
      }
    } finally {
      await db.query("rollback to savepoint predecessor");
    }
  }, runnerTimeout(60_000));

  it("answers a publisher's full page in under 1 s at 1,000 accounts with the predecessor's counts", async () => {
    const budget = runnerTimeout(1_000);
    const installed = {};
    const broadcasts = (await db.query("select count(*)::integer n from public.member_broadcasts")).rows[0].n;
    for (const who of ["chapterLead", "orgLead"]) {
      await call(scale[who], scaleIds);
      const { result, audience } = await audienceCalls(() => call(scale[who], scaleIds));
      expect(result.error, who).toBeUndefined();
      expect(result.value.length, who).toBeGreaterThan(0);
      // The readable set checks each broadcast's audience once; the
      // predecessor checked it again for every receipt it counted.
      expect(audience, who).toBeLessThanOrEqual(broadcasts);
      expect(result.ms, who).toBeLessThan(budget);
      installed[who] = result.value;
    }
    // The organization lead's page holds both kinds of notice.
    expect(installed.orgLead.some((row) => row.readCount > 700)).toBe(true);
    expect(installed.orgLead.some((row) => row.readCount < 200)).toBe(true);

    await db.query("savepoint predecessor");
      // Restore the historical pre-backfill scope shape inside this rollback-only before-image.
      await db.query("delete from private.chapter_role_scopes where legacy_chapter_coverage");
    try {
      await db.query(predecessor());
      for (const who of ["chapterLead", "orgLead"]) {
        const before = await call(scale[who], scaleIds);
        expect(before.value, who).toEqual(installed[who]);
      }
    } finally {
      await db.query("rollback to savepoint predecessor");
    }
  }, runnerTimeout(120_000));
});
