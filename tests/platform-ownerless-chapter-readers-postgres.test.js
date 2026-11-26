// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { offlinePostgres } from "./tamarack-postgres-helper.mjs";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

// SEC-UG-PLATFORM-BOUNDARY-OWNERLESS-CHAPTER-READERS-20261028 (#6326):
// a legacy chapter with no owning organization is not the platform, so every
// reader the boundary touches keeps its ordinary behavior there, including a
// caller whose selected organization resolves to NULL.
const boundary = loadMigrationSql("20261028080000_");
const scope = loadMigrationSql("20260822010000_");
// #6369 redefines the advisor overview; the test reads the newest body.
const advisor = loadMigrationSql("20261028170000_");
// #6682 re-emits the advisor overview and coordinator KPIs over its scoped read
// oracle; the database contract pins that generation's digests.
const scopedAccess = loadMigrationSql("20261102005607_");
// #7206 replaced get_advisor_overview's member_profiles access predicate.
const desksAtScale = loadMigrationSql("20261106221000_");
// #7593 replaces the coordinator KPI reader. Keep its unstripped declaration
// for the installed-definition digest, which includes SQL comments.
const coordinatorKpis = loadMigrationSql("coordinator_kpis_scope_once");
// #8205 bounds the Advisor aggregates. The digest pins that current body;
// the historical ownerless execution fixture above remains unchanged.
const advisorTenantScope = loadMigrationSql("advisor_overview_tenant_scope");
// #7663 re-emits the advisor overview with the steward unit rule.
const stewardUnits = loadMigrationSql("stewards_require_unit_with_carry_over");
// #8568 part B re-emits the advisor overview and coordinator KPIs reading the
// Eastern day; the contract digests pin that generation.
const easternDesks = loadMigrationSql("deadlines_and_desks_eastern_day");
// #9446 part 4a re-emits the advisor overview and coordinator KPIs counting
// each case's deadline on its own zone; the contract digests pin that generation.
const caseZones = loadMigrationSql("case_deadline_time_zones");
const advisorActiveChapterMembers = loadMigrationSql("advisor_overview_active_chapter_members");
// #6809 and #7180 change the workload cohort predicate. Exercise and digest the same
// installed generation as the database contract, preserving its SQL comments.
const workloadConfiguration = loadMigrationSql("20261106215000_");
// #7665 swaps the workload reader's chapter role helper for the staff-grant one;
// the contract digest pins that generation.
const unitStewards = loadMigrationSql("20261109060229_");
const caller = "11111111-1111-4111-8111-111111111111";
const platformOrg = "22222222-2222-4222-8222-222222222222";
const unionOrg = "33333333-3333-4333-8333-333333333333";
const space = "44444444-4444-4444-8444-444444444444";
const poll = "55555555-5555-4555-8555-555555555555";
const pay = "66666666-6666-4666-8666-666666666666";
const hours = "77777777-7777-4777-8777-777777777777";
const chapters = ["legacy", "union", "platform"];
const owners = { legacy: null, union: unionOrg, platform: platformOrg };

describe("platform boundary keeps ownerless legacy chapters working", () => {
  let database, db;
  beforeAll(async () => {
    database = await offlinePostgres();
    db = database.client;
    // Minimal real PostgreSQL fixture. Session, MFA, role holdings and the
    // vote/case visibility helpers are input controls; the selected-organization
    // resolver (20260822010000), the readers and the kind predicates are the
    // unmodified migration declarations. No shared or hosted DB is accepted.
    await db.query(`
      create schema auth; create schema private;
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('proof.user',true),'')::uuid $$;
      create function private.mfa_satisfied() returns boolean language sql stable as $$
        select current_setting('proof.mfa',true) = 'true' $$;
      create function public.member_has_role(text[]) returns boolean language sql stable as $$
        select current_setting('proof.staff',true) = 'true' $$;
      create function private.member_has_chapter_role(text, text[]) returns boolean language sql stable as $$
        select current_setting('proof.staff',true) = 'true' $$;
      create function private.workload_rebalancing(text) returns jsonb language sql stable as $$
        select '{"stewards":[],"suggestions":[]}'::jsonb $$;
      create function private.current_mobile_staff_organization() returns uuid language sql stable as $$ select null::uuid $$;
      create function private.staff_mfa_required(uuid) returns boolean language sql stable as $$ select false $$;
      create function private.has_second_factor(uuid) returns boolean language sql stable as $$ select true $$;
      create function private.can_read_vote_campaign(uuid, text) returns boolean language sql stable as $$ select true $$;
      create function private.can_manage_vote_campaign(uuid, text) returns boolean language sql stable as $$ select false $$;
      create function private.organization_feature_enabled(uuid, text) returns boolean language sql stable as $$ select true $$;
      create function public.staff_can_see_user(uuid, text) returns boolean language sql stable as $$ select true $$;
      create function private.casework_staff_can_access(integer) returns boolean language sql stable as $$ select true $$;
      create function private.member_reward_effect_enabled(uuid, text) returns boolean language sql stable as $$ select true $$;
      create table public.organizations(id uuid primary key, kind text, status text default 'active');
      create table public.chapters(id text primary key, organization_id uuid);
      create table public.member_profiles(id uuid primary key, chapter_id text, language text default 'en');
      create table public.member_chapter_memberships(user_id uuid, chapter_id text, status text);
      create table public.organization_memberships(user_id uuid, organization_id uuid, status text);
      create table public.organization_role_grants(organization_id uuid, user_id uuid, role text);
      create function private.current_member_chapter() returns text language sql stable as $$
        select chapter_id from public.member_profiles where id=auth.uid() $$;
      create table public.chapter_spaces(id uuid primary key, chapter_id text);
      create function private.can_read_chapter_space(s public.chapter_spaces) returns boolean language sql stable as $$
        select s.chapter_id = private.current_member_chapter() $$;
      create table public.chapter_channel_polls(id uuid primary key, space_id uuid, chapter_id text, question text, closes_at timestamptz);
      create table public.chapter_channel_poll_options(id uuid primary key, poll_id uuid, label text, position integer);
      create table public.chapter_channel_poll_votes(poll_id uuid, option_id uuid, user_id uuid, primary key(poll_id,user_id));
      create table public.chapter_tasks(id serial, chapter_id text, deleted_at timestamptz, created_at timestamptz default now(),
        done_at timestamptz, due_date date, status text, blocked boolean default false, milestone boolean default false,
        workstream text, assignee_name text);
      create table public.member_workload_logs(id uuid, user_id uuid, created_at timestamptz,
        priority int, pending int, unread_docs int, todos int, referrals int, ce_activities int,
        assistance_requests int, aged_cases int, employment text default 'full_time', ot_hours numeric default 0, workload_configuration jsonb);
      create table public.member_roles(user_id uuid, chapter_id text, role text);
      create table public.member_cases(id serial, user_id uuid, organization_id uuid, chapter_id text, status text,
        deadline date, step text default 'Step 1', articles text default '');
      create table public.casework_access_grants(case_id integer, grantee_user_id uuid, revoked_at timestamptz);
      create table public.member_ballots(id text primary key, title text, quorum_target int, active boolean, closes_at timestamptz,
        organization_id uuid, chapter_id text, campaign_state text default 'open', ballot_type text default 'standard',
        target_officer_id uuid, target_officer_name text, target_officer_role text, removal_reason text,
        removal_outcome text, removal_outcome_recorded_at timestamptz);
      create table public.member_ballot_options(id text, ballot_id text, label text, label_es text, order_index int);
      create table public.member_ballot_choices(ballot_id text, option_id text);
      create table public.member_ballot_receipts(receipt_code text, counted boolean, issued_at timestamptz, ballot_id text);
      create table public.public_site_records(id text, sort_order int, published_at timestamptz, title_en text, title_es text,
        body_en text, body_es text, region_en text, region_es text, url text, is_published boolean, kind text, organization_id uuid);
    `);
    await db.query(fnBody(scope, "private.current_member_organization"));
    for (const name of ["private.organization_is_union", "private.chapter_belongs_to_union",
      "private.chapter_belongs_to_platform", "private.organization_is_platform",
      "public.get_channel_poll_tally", "public.chapter_task_report", "public.get_steward_workload_intelligence",
      "public.get_advisor_overview", "private.can_manage_chapter_health", "public.get_ballot_tally",
      "public.get_officer_removal_ballot_details", "public.verify_ballot_receipt", "public.get_coordinator_kpis",
      "public.get_reward_cross_chapter_cards"]) {
      await db.query(fnBody(boundary, name));
    }
    await db.query(fnBody(advisor, "public.get_advisor_overview"));
    await db.query(fnBody(workloadConfiguration, "public.get_steward_workload_intelligence"));
  }, 120_000);
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    // The caller is an active member of every chapter and of both owning
    // organizations, so the real resolver follows only the selected chapter:
    // NULL on 'legacy', the union on 'union', the platform on 'platform'.
    await db.query(`rollback;
      truncate public.chapter_channel_poll_votes, public.chapter_channel_poll_options, public.chapter_channel_polls,
        public.chapter_spaces, public.chapter_tasks, public.member_workload_logs, public.member_roles, public.member_cases,
        public.casework_access_grants, public.member_chapter_memberships, public.organization_memberships,
        public.organization_role_grants, public.member_ballots, public.member_ballot_options, public.member_ballot_choices,
        public.member_ballot_receipts, public.public_site_records, public.member_profiles, public.chapters, public.organizations;
      begin;
      select set_config('proof.user','${caller}',true), set_config('proof.mfa','true',true), set_config('proof.staff','true',true);
      insert into public.organizations(id, kind) values ('${platformOrg}','platform'),('${unionOrg}','union');
      insert into public.chapters values ('platform','${platformOrg}'),('union','${unionOrg}'),('legacy',null);
      insert into public.member_profiles(id, chapter_id) values ('${caller}','legacy');
      insert into public.member_chapter_memberships select '${caller}', id, 'active' from public.chapters;
      insert into public.organization_memberships select '${caller}', id, 'active' from public.organizations;
    `);
  });
  const value = async (sql, params = []) => (await db.query(`select ${sql} value`, params)).rows[0].value;
  const refuses = async (sql, params = []) => {
    await db.query("savepoint refusal");
    await expect(db.query(`select ${sql}`, params)).rejects.toMatchObject({ code: "42501", message: "platform organization is private" });
    await db.query("rollback to savepoint refusal");
  };
  const moveTo = async chapter => {
    await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [chapter, caller]);
    expect(await value("private.current_member_organization()")).toBe(owners[chapter]);
  };
  const stable = report => ({ ...report, generatedAt: undefined });

  it("returns ownerless and union poll totals, and withholds only platform totals", async () => {
    const tallies = {};
    for (const chapter of chapters) {
      await db.query("delete from public.chapter_channel_poll_votes; delete from public.chapter_channel_poll_options; delete from public.chapter_channel_polls; delete from public.chapter_spaces");
      await db.query(`
        insert into public.chapter_spaces values ('${space}',$1);
        insert into public.chapter_channel_polls values ('${poll}','${space}',$1,'Priority?',null);
        insert into public.chapter_channel_poll_options values ('${pay}','${poll}','Pay',0),('${hours}','${poll}','Hours',1);
        insert into public.chapter_channel_poll_votes values ('${poll}','${hours}','${platformOrg}'),('${poll}','${pay}','${caller}');
      `.replaceAll("$1", `'${chapter}'`));
      await moveTo(chapter);
      tallies[chapter] = await value("public.get_channel_poll_tally($1)", [poll]);
    }
    const counted = { total: 2, mine: pay, options: [{ id: pay, votes: 1 }, { id: hours, votes: 1 }] };
    expect(tallies.legacy).toMatchObject(counted);
    expect(tallies.union).toEqual(tallies.legacy);
    expect(tallies.platform).toMatchObject({ total: null, mine: pay, options: [{ id: pay, votes: null }, { id: hours, votes: null }] });
  });

  it("reports ownerless and union chapter tasks, and refuses only a platform chapter", async () => {
    for (const chapter of chapters) {
      await db.query(`insert into public.chapter_tasks(chapter_id,status,workstream,assignee_name,done_at)
        values ($1,'done','Organizing','Ana',now()),($1,'open','Organizing','',null)`, [chapter]);
    }
    const reports = {};
    for (const chapter of ["legacy", "union"]) {
      await moveTo(chapter);
      reports[chapter] = await value("public.chapter_task_report(null,null)");
    }
    expect(reports.legacy).toMatchObject({ chapterId: "legacy", totals: { total: 2, done: 1, open: 1 } });
    expect(stable({ ...reports.union, chapterId: "legacy" })).toEqual(stable(reports.legacy));
    await moveTo("platform");
    await refuses("public.chapter_task_report(null,null)");
  });

  it("forecasts ownerless and union steward workload, and refuses only a platform chapter", async () => {
    for (const chapter of chapters) {
      await db.query("insert into public.member_profiles(id, chapter_id) select md5($1 || n)::uuid, $1 from generate_series(1,25) n", [chapter]);
      await db.query(`
        insert into public.member_workload_logs(id,user_id,created_at,priority,pending,unread_docs,todos,
          referrals,ce_activities,assistance_requests,aged_cases)
          select gen_random_uuid(), p.id, date_trunc('week', now()) - make_interval(weeks => w) + interval '1 day',
            w + 1, 2, 2, 2, 2, 2, 2, 2
          from public.member_profiles p cross join (values (1),(2)) weeks(w)
          where p.chapter_id = $1 and p.id <> $2`, [chapter, caller]);
    }
    const reports = {};
    for (const chapter of ["legacy", "union"]) {
      await moveTo(chapter);
      reports[chapter] = await value("public.get_steward_workload_intelligence(12)");
    }
    expect(reports.legacy).toMatchObject({ available: true, eligibleWeeks: 2, reason: null,
      rebalancing: { stewards: [], suggestions: [] } });
    expect(reports.legacy.categories).toHaveLength(8);
    expect(stable(reports.union)).toEqual(stable(reports.legacy));
    await moveTo("platform");
    await refuses("public.get_steward_workload_intelligence(12)");
  });

  it("serves a legacy advisor whose organization resolves to NULL, with ownerless rows counted and platform rows not", async () => {
    const member = tag => `md5('${tag}')::uuid`;
    await db.query(`
      insert into public.member_profiles(id, chapter_id)
        select md5('u' || n)::uuid, 'union' from generate_series(1,2) n
        union all select md5('l' || n)::uuid, 'legacy' from generate_series(1,3) n
        union all select md5('p' || n)::uuid, 'platform' from generate_series(1,4) n
        union all select ${member("none")}, null;
      insert into public.member_cases(user_id, organization_id, chapter_id, status) values
        (md5('l1')::uuid, null, 'legacy', 'active'), (md5('u1')::uuid, '${unionOrg}', 'union', 'resolved'),
        (md5('p1')::uuid, '${platformOrg}', 'platform', 'active'), (md5('p2')::uuid, '${platformOrg}', 'platform', 'active');
      -- Counted: a chapter and an organization-wide legacy steward with no
      -- organization membership, and a union steward. Not counted: an
      -- organization-wide steward who belongs only to the platform, and a
      -- steward role on a platform chapter (even with a union membership).
      insert into public.member_roles values
        (${member("s-legacy")}, 'legacy', 'steward'), (${member("s-legacy-wide")}, null, 'steward'),
        (${member("s-union")}, 'union', 'steward'),
        (${member("s-platform")}, null, 'steward'), (${member("s-platform-chapter")}, 'platform', 'steward');
      insert into public.organization_memberships values
        (${member("s-union")}, '${unionOrg}', 'active'), (${member("s-platform")}, '${platformOrg}', 'active'),
        (${member("s-platform-chapter")}, '${unionOrg}', 'active');
      insert into public.member_ballots(id, title, quorum_target, active, closes_at, organization_id, chapter_id) values
        ('legacy-ballot', 'Legacy ballot', 5, false, now() - interval '2 days', null, 'legacy'),
        ('platform-ballot', 'Platform ballot', 5, false, now() - interval '1 day', '${platformOrg}', 'platform');
      insert into public.member_ballot_choices values ('legacy-ballot', 'yes'), ('platform-ballot', 'yes'), ('platform-ballot', 'no');
    `);
    const expected = { membersCovered: 7, openGrievances: 1, resolvedGrievances: 1, stewardCount: 3,
      turnout: { title: "Legacy ballot", totalVotes: 1, quorumTarget: 5 }, atRisk: { unstaffed: false } };
    await moveTo("legacy");
    const legacy = await value("public.get_advisor_overview()");
    expect(legacy).toMatchObject(expected);
    await moveTo("union");
    expect(await value("public.get_advisor_overview()")).toEqual(legacy);
    await moveTo("platform");
    await refuses("public.get_advisor_overview()");
  });

  it("counts an ownerless chapter steward whose only membership is the platform's (#6369)", async () => {
    const member = tag => `md5('${tag}')::uuid`;
    // The caller is the legacy chapter's advisor. Its one chapter steward holds
    // only a platform membership; the role still belongs to the ownerless
    // chapter, so it counts. An org-wide platform-only steward still does not.
    await db.query(`
      insert into public.member_roles values
        ('${caller}', 'legacy', 'advisor'),
        (${member("s-legacy-mixed")}, 'legacy', 'steward'), (${member("s-platform-wide")}, null, 'steward');
      insert into public.organization_memberships values
        (${member("s-legacy-mixed")}, '${platformOrg}', 'active'), (${member("s-platform-wide")}, '${platformOrg}', 'active');
    `);
    await moveTo("legacy");
    expect(await value("public.get_advisor_overview()")).toMatchObject({ stewardCount: 1, atRisk: { unstaffed: false } });
  });

  it("serves legacy ballots to a caller whose organization resolves to NULL, and withholds platform ballots", async () => {
    await db.query(`
      insert into public.member_ballots(id, title, quorum_target, active, closes_at, organization_id, chapter_id, ballot_type,
        target_officer_name, removal_reason) values
        ('legacy-removal', 'Remove officer', 5, false, now() - interval '1 day', null, 'legacy', 'officer_removal', 'Pat', 'Absent'),
        ('platform-removal', 'Remove officer', 5, false, now() - interval '1 day', '${platformOrg}', 'platform', 'officer_removal', 'Sam', 'Absent');
      insert into public.member_ballot_options values ('yes', 'legacy-removal', 'Yes', 'Sí', 0), ('no', 'legacy-removal', 'No', 'No', 1),
        ('yes', 'platform-removal', 'Yes', 'Sí', 0);
      insert into public.member_ballot_choices values ('legacy-removal', 'yes'), ('legacy-removal', 'yes'), ('platform-removal', 'yes');
      insert into public.member_ballot_receipts values ('SG-AB12-CD34', true, now(), 'legacy-removal'),
        ('SG-AB12-CD35', true, now(), 'platform-removal');
    `);
    const ids = [["legacy-removal", "platform-removal"]];
    await moveTo("legacy");
    expect(await value("public.get_officer_removal_ballot_details($1)", ids)).toMatchObject({ enabled: false,
      items: [{ ballotId: "legacy-removal", targetName: "Pat", reason: "Absent" }] });
    expect((await value("public.get_officer_removal_ballot_details($1)", ids)).items).toHaveLength(1);
    expect(await value("public.get_ballot_tally('legacy-removal')")).toMatchObject({ totalVotes: 2,
      options: [{ optionId: "yes", votes: 2 }, { optionId: "no", votes: 0 }] });
    await refuses("public.get_ballot_tally('platform-removal')");
    expect(await value("public.verify_ballot_receipt('SG-AB12-CD34')")).toMatchObject({ found: true, ballotTitle: "Remove officer" });
    expect(await value("public.verify_ballot_receipt('SG-AB12-CD35')")).toEqual({ found: false });
    await moveTo("union");
    expect(await value("public.get_officer_removal_ballot_details($1)", ids)).toMatchObject({ enabled: true,
      items: [{ ballotId: "legacy-removal" }] });
    await moveTo("platform");
    await refuses("public.get_officer_removal_ballot_details($1)", ids);
  });

  it("gives a legacy coordinator whose organization resolves to NULL the KPIs of granted cases", async () => {
    await db.query(`
      insert into public.member_cases(user_id, organization_id, chapter_id, status, step, articles) values
        (md5('u1')::uuid, '${unionOrg}', 'union', 'active', 'Step 2', '12');
      insert into public.casework_access_grants select id, '${caller}', null from public.member_cases;
    `);
    await moveTo("legacy");
    expect(await value("public.get_coordinator_kpis()")).toMatchObject({ openCases: 1, resolved: 0,
      byStep: [{ step: "Step 2", count: 1 }], byArticle: [{ articles: "12", count: 1 }] });
    await moveTo("platform");
    await refuses("public.get_coordinator_kpis()");
  });

  it("keeps ownerless chapter reward cards and drops only platform ones", async () => {
    await db.query(`insert into public.public_site_records(id, sort_order, published_at, title_en, is_published, kind, organization_id) values
      ('legacy', 1, now(), 'Legacy local', true, 'chapter', null), ('union', 2, now(), 'Union local', true, 'chapter', '${unionOrg}'),
      ('platform', 0, now(), 'Platform local', true, 'chapter', '${platformOrg}')`);
    expect((await value("public.get_reward_cross_chapter_cards('en')")).map(card => card.title)).toEqual(["Legacy local", "Union local"]);
  });

  it("lets a legacy chapter role manage ownerless and union chapter health, never platform", async () => {
    const managed = {};
    for (const chapter of chapters) managed[chapter] = await value("private.can_manage_chapter_health($1)", [chapter]);
    expect(managed).toEqual({ legacy: true, union: true, platform: false });
    await db.query("select set_config('proof.staff','false',true)");
    expect(await value("private.can_manage_chapter_health('legacy')")).toBe(false);
  });

  it("pins every installed reader with a body digest in the database contract", async () => {
    const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
    const pinned = contract.functions.filter(entry => entry.bodyMd5 && [
      "public.get_steward_workload_intelligence(", "public.get_ballot_tally(", "public.get_officer_removal_ballot_details(",
      "public.verify_ballot_receipt(", "public.get_coordinator_kpis(", "public.get_reward_cross_chapter_cards(",
      "public.get_advisor_overview(", "public.get_channel_poll_tally(", "public.chapter_task_report(",
      "private.can_manage_chapter_health(",
    ].some(prefix => entry.sig.startsWith(prefix)));
    expect(pinned.map(entry => entry.sig)).toContain("public.get_steward_workload_intelligence(p_weeks integer)");
    // Install the current generations for the digest only: their scope helpers
    // are outside this fixture, so body validation is off inside a savepoint.
    await db.query("savepoint scoped_generation; set local check_function_bodies = off");
    for (const name of ["public.get_advisor_overview", "public.get_coordinator_kpis"]) await db.query(fnBody(scopedAccess, name));
    await db.query(fnBody(desksAtScale, "public.get_advisor_overview"));
    await db.query(fnBody(coordinatorKpis, "public.get_coordinator_kpis"));
    await db.query(fnBody(advisorTenantScope, "public.get_advisor_overview"));
    await db.query(fnBody(stewardUnits, "public.get_advisor_overview"));
    for (const name of ["public.get_advisor_overview", "public.get_coordinator_kpis"]) await db.query(fnBody(easternDesks, name));
    for (const name of ["public.get_advisor_overview", "public.get_coordinator_kpis"]) await db.query(fnBody(caseZones, name));
    await db.query(fnBody(advisorActiveChapterMembers, "public.get_advisor_overview"));
    await db.query(fnBody(unitStewards, "public.get_steward_workload_intelligence"));
    const installed = [];
    for (const entry of pinned) {
      const name = entry.sig.slice(0, entry.sig.indexOf("("));
      installed.push([entry.sig, await value(`(select md5(pg_get_functiondef(p.oid)) from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace where n.nspname || '.' || p.proname = $1)`, [name])]);
    }
    await db.query("rollback to savepoint scoped_generation");
    expect(installed).toEqual(pinned.map(entry => [entry.sig, entry.bodyMd5]));
  });
});
