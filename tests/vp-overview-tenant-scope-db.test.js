// @vitest-environment node
//
// SEC-UG-VP-OVERVIEW-TENANT-SCOPE-20260920
//
// public.get_vp_overview is SECURITY DEFINER, so table RLS never bounded it.
// upcomingEvents, turnout and priorities had no tenant predicate, and the
// member, grievance, attention and trend reads used a legacy member_roles
// chapter that is NULL for an organization-granted VP, widening them to every
// tenant. 20260924160200 bounds every read to the caller's selected
// organization and chapter, refuses when either is unresolved, and drops
// cancelled events.
//
// The offline half pins the migration text and the db-contract needles. The
// live half seeds two organizations and proves an organization-granted VP in
// A observes none of B's ids, titles or member names, never sees a cancelled
// event, and that a caller with no resolvable tenant is refused.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, latestFnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("vp_overview_tenant_scope"));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const body = squash(stripComments(fnBody(sql, "public.get_vp_overview")));
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("vp overview tenant-scope migration", () => {
  it("is one bounded transaction in the assigned stamp range", () => {
    const name = findMigrationName("vp_overview_tenant_scope");
    expect(name).toBe("20260924160200_vp_overview_tenant_scope.sql");
    const statements = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    expect(statements.trimStart().startsWith("begin;")).toBe(true);
    expect(statements.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("set local lock_timeout = '5s';");
    expect(squash(sql)).not.toMatch(/\b(grant|revoke|create policy|alter table|create index)\b/);
  });

  it("refuses an unresolved tenant and bounds every read without the legacy fallback", () => {
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("not public.member_has_role(array['vp', 'admin'])");
    expect(body).toContain("if caller_org is null or caller_chapter is null then raise exception 'organization required' using errcode = '42501'");
    expect(body).not.toContain("public.member_roles");
    expect(body).not.toContain("caller_chapter is null or");
    expect(body).toContain("and ev.cancelled_at is null");
    expect(body).toContain("and event_chapter.organization_id = caller_org");
    expect(body).toContain("private.member_can_access_event_scope(ev.chapter_id, ev.is_public, ev.is_public_across_agencies)");
    expect(body).toContain("and (b.chapter_id is null or b.chapter_id = caller_chapter)");
    expect(body.match(/and \(chapter_id is null or chapter_id = caller_chapter\)/g)).toHaveLength(2);
    // Ballot tallies keep counting anonymous choices (UB-VOTE-04).
    expect(body).toContain("select pg_catalog.count(*) as n from public.member_ballot_choices where ballot_id = b.id");
  });

  it("pins the tenant predicates in the database contract", () => {
    const entry = contract.functions.find((row) => row.sig === "public.get_vp_overview()");
    // 20261028080000  grants EXECUTE to authenticated only; hosted service_role reaches it as a member of authenticated.
    expect(entry).toMatchObject({ secdef: true, exec: "authenticated" });
    // The contract pins the live definition, which 20261005090000 replaced.
    const latest = squash(stripComments(latestFnBody("public.get_vp_overview()")));
    for (const needle of entry.bodyContains) expect(latest).toContain(squash(needle));
    expect(entry.bodyContains).toEqual(expect.arrayContaining([
      "if caller_org is null or caller_chapter is null then",
      "and ev.cancelled_at is null",
      "and event_chapter.organization_id = caller_org",
    ]));
    expect(entry.bodyForbids).toEqual(expect.arrayContaining(["public.member_roles", "caller_chapter is null or"]));
  });
});

// BUG-UG-VP-TURNOUT-QUORUM-NONSENSE-20261003: a new organization's
// President desk showed "37930 of 12000 needed for quorum". The chapter-only
// rule above still admitted every tenant's organization-wide ballots,
// including quarantined ownerless ones. 20261005090000 adds the owner bound.
describe("vp overview ballot organization scope migration", () => {
  const name = findMigrationName("vp_overview_ballot_organization_scope");
  const repair = stripComments(loadMigrationSql("vp_overview_ballot_organization_scope"));
  const repaired = squash(stripComments(fnBody(repair, "public.get_vp_overview()")));

  it("replaces only the reviewed predecessor in one bounded transaction", () => {
    expect(name).toBe("20261005090000_vp_overview_ballot_organization_scope.sql");
    expect(repair.trimStart().startsWith("begin;")).toBe(true);
    expect(repair.trimEnd().endsWith("commit;")).toBe(true);
    expect(repair).toContain("set local lock_timeout = '5s';");
    expect(squash(repair)).toContain("if installed is distinct from '6df60cc1d4e7d8b84482d5b6bfeaae63' then");
    expect(squash(repair)).not.toMatch(/\b(grant|revoke|create policy|alter table|create index)\b/);
  });

  it("adds the organization bound to turnout and priorities and changes nothing else", () => {
    const predecessor = body.replace(/\$function\$|\$\$/g, "");
    const added = [
      "and b.organization_id = caller_org",
      "and organization_id = caller_org",
      "and organization_id = caller_org",
    ];
    let stripped = repaired.replace(/\$function\$|\$\$/g, "");
    for (const needle of added) {
      expect(stripped).toContain(needle);
      stripped = stripped.replace(` ${needle}`, "");
    }
    const tail = (text) => text.slice(text.indexOf("declare"));
    expect(tail(stripped)).toBe(tail(predecessor));
    expect(repaired).toMatch(/where \(b\.active = false or b\.closes_at < pg_catalog\.now\(\)\) and b\.campaign_state <> 'draft' and b\.organization_id = caller_org and \(b\.chapter_id is null/);
  });

  it("pins the repaired definition by md5 in the database contract", () => {
    const entry = contract.functions.find((row) => row.sig === "public.get_vp_overview()");
    // The unit/committee delivery composes scope and identity checks into the
    // same tenant-bound overview; its exact live body and source stay pinned.
    //  (20261106221000) swapped only its member_profiles access
    // predicate for the set-wise form.
    // and 7:58 PM: both scope representations are pinned.
    //  part B (deadlines_and_desks_eastern_day) reads the Eastern day for
    // the overdue count only, and  part 4a (case_deadline_time_zones)
    // counts it on each case's own zone.  (20261124123000) counts members
    // and the trend over the Admin page's population and keeps upcoming events
    // to the caller's chapter.
    // Gate round 1 of: join years before the first year shown count in it.
    expect(entry).toMatchObject({ bodyMd5: "48e2b01322a1332aa2e0e9fb68f894af", sourceMd5: "0036c48f5809a7ca6db656e32a766f35" });
    //  (20261108201000) replaces the per-case leadership wrapper with one caller gate.
    expect(squash(latestFnBody("public.get_vp_overview"))).toContain("private.member_event_scope_allows");
    expect(squash(latestFnBody("public.get_vp_overview"))).not.toContain("private.chapter_case_leadership_readable");
    expect(entry.bodyContains).toEqual(expect.arrayContaining(["and b.organization_id = caller_org", "and organization_id = caller_org"]));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("get_vp_overview never crosses the caller's tenant", () => {
  let client;
  const id = Object.fromEntries([
    "orgA", "orgB", "vp", "vpSession", "ownerA", "ownerASession", "ownerB", "ownerBSession",
    "untenanted", "untenantedSession", "caseA", "caseB",
    "admin", "adminSession", "noYear", "noYearSession",
  ].map((key) => [key, randomUUID()]));
  const tag = id.orgA.slice(0, 8);
  const chapterA = `vpscope-a-${tag}`;
  const chapterB = `vpscope-b-${tag}`;
  //: a second chapter of the President's own organization, whose public
  // event starts first and must still stay off "Next on the chapter calendar".
  const chapterA2 = `vpscope-a2-${tag}`;
  const ev = { a: `vpscope-ev-a-${tag}`, cancelled: `vpscope-ev-x-${tag}`, b: `vpscope-ev-b-${tag}`, a2: `vpscope-ev-a2-${tag}` };
  const ballot = { a: `vpscope-bal-a-${tag}`, b: `vpscope-bal-b-${tag}` };
  const survey = { a: `vpscope-sur-a-${tag}`, b: `vpscope-sur-b-${tag}` };
  const wide = {
    quarantined: `vpscope-bal-q-${tag}`, foreignBallot: `vpscope-bal-fw-${tag}`, quarantinedLive: `vpscope-bal-ql-${tag}`,
    quarantinedSurvey: `vpscope-sur-q-${tag}`, foreignSurvey: `vpscope-sur-fw-${tag}`,
  };
  const B_TEXT = [chapterB, ev.b, ballot.b, survey.b, id.caseB, "CASE-VPSCOPE-B", "Foreign Owner VPScope",
    "Foreign event VPScope", "Foreign ballot VPScope", "Foreign survey VPScope"];

  const act = async (actor, session) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
  };

  const attempt = async (sqlText, params = []) => {
    await client.query("savepoint vp_scope");
    try {
      const result = await client.query(sqlText, params);
      await client.query("release savepoint vp_scope");
      return { ok: true, rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint vp_scope");
      return { ok: false, code: error.code, message: error.message };
    }
  };

  const overview = async () => (await client.query("select public.get_vp_overview() as value")).rows[0].value;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "vp-overview-tenant-scope-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    const people = [
      [id.vp, id.vpSession, id.orgA, chapterA, "VP VPScope"],
      [id.ownerA, id.ownerASession, id.orgA, chapterA, "Own Owner VPScope"],
      [id.ownerB, id.ownerBSession, id.orgB, chapterB, "Foreign Owner VPScope"],
      [id.untenanted, id.untenantedSession, id.orgA, chapterA, "Untenanted VPScope"],
      [id.admin, id.adminSession, id.orgA, chapterA, "Admin VPScope"],
      [id.noYear, id.noYearSession, id.orgA, chapterA, "No Year VPScope"],
    ];
    for (const [user, session] of people) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic vp-scope factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    for (const [org, chapter, order] of [[id.orgA, chapterA, 9931], [id.orgB, chapterB, 9932]]) {
      await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [org, `vpscope-${org}`, id.vp]);
      await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,$3)", [chapter, org, order]);
      await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [org]);
    }
    for (const [user, , org, chapter, name] of people) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, user]);
      // The untenanted caller keeps its profile chapter and its organization
      // grant but has no active chapter membership, so no tenant resolves.
      if (user !== id.untenanted) {
        await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
      }
      await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user, chapter, name]);
    }
    // Organization grants only: no public.member_roles row, which is exactly
    // the shape that left the legacy caller_chapter NULL.
    for (const user of [id.vp, id.untenanted]) {
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'vp',$2)", [id.orgA, user]);
    }
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)", [id.orgA, id.admin]);
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9934)", [chapterA2, id.orgA]);
    // Join years: two earlier years, one this year, and one member with none
    // (a new account's default). The untenanted profile has a year but no
    // active chapter membership, so it is not a member of chapter A.
    await client.query(`
      update public.member_profiles set member_since = case id
        when $1::uuid then pg_catalog.date_part('year', now())::int - 3
        when $2::uuid then pg_catalog.date_part('year', now())::int
        when $3::uuid then pg_catalog.date_part('year', now())::int - 1
        when $4::uuid then null
        when $5::uuid then pg_catalog.date_part('year', now())::int - 2
      end
      where id in ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)
    `, [id.vp, id.ownerA, id.admin, id.noYear, id.untenanted]);

    for (const [caseId, owner, org, chapter, reference, deadline] of [
      [id.caseA, id.ownerA, id.orgA, chapterA, "CASE-VPSCOPE-A", 300],
      [id.caseB, id.ownerB, id.orgB, chapterB, "CASE-VPSCOPE-B", 400],
    ]) {
      await client.query(
        `insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,step,articles,status,deadline)
         values($1,$2,$3,$3,'other',$4,$5,'Step 2','Article 5','active',current_date - $6::integer)`,
        [caseId, owner, reference, org, chapter, deadline],
      );
    }

    await client.query(`
      insert into public.member_events
        (id, title, starts_at, location, summary, check_in_code, order_index, chapter_id, is_public, is_public_across_agencies, cancelled_at)
      values
        ($1, 'Own event VPScope', now() + interval '2 minutes', 'A', 'Own', 'SG-VPA1', 9931, $4, false, false, null),
        ($2, 'Cancelled event VPScope', now() + interval '90 seconds', 'A', 'Cancelled', 'SG-VPA2', 9932, $4, false, false, now()),
        ($3, 'Foreign event VPScope', now() + interval '1 minute', 'B', 'Foreign', 'SG-VPB1', 9933, $5, true, true, null),
        ($6, 'Sibling chapter event VPScope', now() + interval '30 seconds', 'A2', 'Sibling', 'SG-VPA3', 9934, $7, true, true, null)
    `, [ev.a, ev.cancelled, ev.b, chapterA, chapterB, ev.a2, chapterA2]);

    const base = -900000 - Number.parseInt(tag.slice(0, 4), 16);
    // Organization-wide rows the pilot's President saw: a quarantined ownerless
    // ballot (the legacy 37930-of-12000 shape) and another organization's own
    // union-wide ballot and survey, each newer or earlier-ordered than A's.
    // The write guard refuses an ownerless insert, so the fixture bypasses
    // triggers for these rows only; the transaction rolls back.
    await client.query("set local session_replication_role = replica");
    await client.query(`
      insert into public.member_ballots(id,title,closes_at,active,order_index,chapter_id,campaign_state,quorum_target,organization_id)
      values ($1,'Quarantined ballot VPScope',now() - interval '10 seconds',false,$4 - 10,null,'closed',12000,null),
             ($2,'Foreign wide ballot VPScope',now() - interval '20 seconds',false,$4 - 11,null,'closed',12000,$5),
             ($3,'Quarantined live ballot VPScope',now() + interval '7 days',true,$4 - 12,null,'open',12000,null)
    `, [wide.quarantined, wide.foreignBallot, wide.quarantinedLive, base, id.orgB]);
    await client.query(`
      insert into public.member_surveys(id,title,closes_at,active,order_index,chapter_id,campaign_state,organization_id)
      values ($1,'Quarantined survey VPScope',now() + interval '7 days',true,$3 - 13,null,'open',null),
             ($2,'Foreign wide survey VPScope',now() + interval '7 days',true,$3 - 14,null,'open',$4)
    `, [wide.quarantinedSurvey, wide.foreignSurvey, base, id.orgB]);
    await client.query("set local session_replication_role = origin");
    await client.query(`
      insert into public.member_ballots(id,title,closes_at,active,order_index,chapter_id,campaign_state,quorum_target)
      values ($1,'Own ballot VPScope',now() - interval '2 minutes',false,$3,$4,'closed',10),
             ($2,'Foreign ballot VPScope',now() - interval '1 minute',false,$3 - 1,$5,'closed',10)
    `, [ballot.a, ballot.b, base, chapterA, chapterB]);
    await client.query(`
      insert into public.member_surveys(id,title,closes_at,active,order_index,chapter_id,campaign_state)
      values ($1,'Own survey VPScope',now() + interval '7 days',true,$3,$4,'open'),
             ($2,'Foreign survey VPScope',now() + interval '7 days',true,$3 - 1,$5,'open')
    `, [survey.a, survey.b, base, chapterA, chapterB]);
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("shows an organization-granted VP none of another organization's rows", async () => {
    await act(id.vp, id.vpSession);
    const result = await overview();
    const text = JSON.stringify(result);
    for (const needle of B_TEXT) expect(text, `leaked ${needle}`).not.toContain(needle);

    expect(result.upcomingEvents.map((row) => row.id)).toEqual([ev.a]);
    expect(result.turnout).toMatchObject({ title: "Own ballot VPScope" });
    expect(result.priorities.map((row) => row.id)).toContain(survey.a);
    expect(result.attention.map((row) => row.id)).toEqual([id.caseA]);
    expect(result.attention[0].memberName).toBe("Own Owner VPScope");
    expect(result.activeGrievances).toBe(1);
  });

  it("never reports another organization's or a quarantined organization-wide ballot as turnout or priority", async () => {
    await act(id.vp, id.vpSession);
    const result = await overview();
    const text = JSON.stringify(result);
    for (const value of Object.values(wide)) expect(text, `leaked ${value}`).not.toContain(value);
    expect(text).not.toContain("12000");
    expect(result.turnout).toMatchObject({ title: "Own ballot VPScope", quorumTarget: 10 });
    expect(result.priorities.map((row) => row.id)).toEqual([survey.a]);
  });

  it("never paints the caller's own cancelled event as upcoming", async () => {
    await act(id.vp, id.vpSession);
    const result = await overview();
    expect(result.upcomingEvents.map((row) => row.id)).not.toContain(ev.cancelled);
  });

  it("counts members and the trend inside the caller's chapter only", async () => {
    await client.query("reset role");
    //: a member is an active chapter membership held by an active
    // member of the organization, as Admin's Organization & chapters counts.
    const expected = (await client.query(
      `select count(distinct m.user_id)::integer as n
         from public.member_chapter_memberships m
         join public.organization_memberships o
           on o.user_id = m.user_id and o.organization_id = $2 and o.status = 'active'
        where m.chapter_id = $1 and m.status = 'active'`,
      [chapterA, id.orgA],
    )).rows[0].n;
    expect(expected).toBe(4);
    await act(id.vp, id.vpSession);
    const result = await overview();
    expect(result.memberCount).toBe(expected);
    expect(result.newThisYear).toBe(1);
    const year = new Date().getUTCFullYear();
    const last = result.membershipTrend[result.membershipTrend.length - 1];
    expect(Number(last.year)).toBe(year);
    expect(Number(last.count)).toBe(expected);
  });

  //  (B-55): the demo President read 256 members where Admin read 246,
  // and the trend 255. One population for all three.
  it("gives the President the Admin page's member count, and the trend ends on it", async () => {
    await act(id.admin, id.adminSession);
    const admin = (await client.query("select public.get_admin_org_structure() as value")).rows[0].value;
    const chapters = Array.isArray(admin) ? admin : admin.chapters;
    const adminCount = chapters.find((chapter) => chapter.id === chapterA).memberCount;
    await act(id.vp, id.vpSession);
    const result = await overview();
    expect(result.memberCount).toBe(adminCount);
    expect(Number(result.membershipTrend.at(-1).count)).toBe(adminCount);
    // A profile whose home chapter is A without an active membership is not
    // counted; a member with no join year still is.
    expect(adminCount).toBe(4);
  });

  // Gate round 1 of  (r1g1, r2g1): a join year before the first year
  // shown was dropped by the window, so a chapter whose members all joined
  // earlier had an empty trend beside a full member count.
  const withJoinYears = async (years, check) => {
    await client.query("reset role");
    await client.query("savepoint vp_years");
    try {
      for (const [user, year] of years) {
        await client.query("update public.member_profiles set member_since = $2 where id = $1", [user, year]);
      }
      await act(id.vp, id.vpSession);
      await check(await overview());
    } finally {
      await client.query("reset role");
      await client.query("rollback to savepoint vp_years");
      await client.query("release savepoint vp_years");
    }
  };

  it("keeps every member in the trend when all of them joined before the first year shown", async () => {
    const year = new Date().getUTCFullYear();
    await withJoinYears([[id.vp, year - 8], [id.ownerA, year - 12], [id.admin, year - 6], [id.noYear, year - 30]], async (result) => {
      expect(result.memberCount).toBe(4);
      expect(result.membershipTrend.length).toBeGreaterThan(0);
      expect(Number(result.membershipTrend[0].year)).toBe(year - 5);
      expect(Number(result.membershipTrend[0].count)).toBe(4);
      expect(Number(result.membershipTrend.at(-1).count)).toBe(result.memberCount);
    });
  });

  it("puts older, unknown, in-window and future join years in one trend that ends on the member count", async () => {
    const year = new Date().getUTCFullYear();
    await withJoinYears([[id.vp, year - 9], [id.ownerA, year + 1], [id.admin, year - 2], [id.noYear, null]], async (result) => {
      expect(result.memberCount).toBe(4);
      const points = result.membershipTrend.map((row) => [Number(row.year), Number(row.count)]);
      // The older and the unknown year start at the first year shown; the
      // future year counts in this year.
      expect(points).toEqual([[year - 5, 2], [year - 2, 3], [year, 4]]);
      expect(result.newThisYear).toBe(0);
    });
  });

  //  and: "Next on the chapter calendar" listed another
  // chapter's public event of the same organization.
  it("lists only the caller's chapter's events, not a sibling chapter's public one", async () => {
    await act(id.vp, id.vpSession);
    const result = await overview();
    expect(result.upcomingEvents.map((row) => row.id)).toEqual([ev.a]);
    expect(JSON.stringify(result.upcomingEvents)).not.toContain("Sibling chapter event VPScope");
  });

  it("refuses a caller whose tenant does not resolve instead of scanning the database", async () => {
    await act(id.untenanted, id.untenantedSession);
    expect((await client.query("select private.current_member_organization() as org")).rows[0].org).toBeNull();
    const refused = await attempt("select public.get_vp_overview() as value");
    expect(refused).toMatchObject({ ok: false, code: "42501" });
  });
});
