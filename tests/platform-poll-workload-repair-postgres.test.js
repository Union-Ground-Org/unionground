// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { offlinePostgres } from "./tamarack-postgres-helper.mjs";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

const boundary = loadMigrationSql("20261028080000_");
const polls = loadMigrationSql("20260820150000_");
// #6809 and #7180 change the workload cohort predicate. Exercise and digest the same
// installed generation as the database contract, preserving its SQL comments.
const workloadConfiguration = loadMigrationSql("20261106215000_");
const member = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const poll = "33333333-3333-4333-8333-333333333333";
const option = "44444444-4444-4444-8444-444444444444";
const second = "55555555-5555-4555-8555-555555555555";

describe("platform poll participation and legacy workload compatibility", () => {
  let database, db;
  beforeAll(async () => {
    database = await offlinePostgres();
    db = database.client;
    // Minimal real PostgreSQL fixture. Session/MFA/space entitlement are input
    // controls; the vote/tally/workload functions and kind predicates are the
    // unmodified migration declarations. No shared or hosted DB is accepted.
    await db.query(`
      create schema auth; create schema private;
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('proof.user',true),'')::uuid $$;
      create function private.mfa_satisfied() returns boolean language sql stable as $$
        select current_setting('proof.mfa',true) = 'true' $$;
      create table public.organizations(id uuid primary key, kind text);
      create table public.chapters(id text primary key, organization_id uuid);
      create table public.member_profiles(id uuid primary key, chapter_id text);
      create function private.current_member_chapter() returns text language sql stable as $$
        select chapter_id from public.member_profiles where id=auth.uid() $$;
      create function private.quarterly_survey_gate_locks_caller() returns boolean language sql stable as $$
        select current_setting('proof.locked',true) = 'true' $$;
      create table public.chapter_spaces(id uuid primary key, chapter_id text);
      create function private.can_read_chapter_space(s public.chapter_spaces) returns boolean language sql stable as $$
        select s.chapter_id = private.current_member_chapter() $$;
      create table public.chapter_channel_polls(id uuid primary key, space_id uuid, chapter_id text, question text, closes_at timestamptz);
      create table public.chapter_channel_poll_options(id uuid primary key, poll_id uuid, label text, position integer);
      create table public.chapter_channel_poll_votes(poll_id uuid, option_id uuid, user_id uuid, updated_at timestamptz default now(), primary key(poll_id,user_id));
      create table public.member_workload_logs(id uuid, user_id uuid, created_at timestamptz,
        priority int, pending int, unread_docs int, todos int, referrals int, ce_activities int,
        assistance_requests int, aged_cases int, employment text, ot_hours numeric, workload_configuration jsonb);
    `);
    for (const name of ["private.organization_is_union", "private.chapter_belongs_to_union", "private.chapter_belongs_to_platform", "public.get_channel_poll_tally", "public.get_workload_stats"]) {
      await db.query(fnBody(boundary, name));
    }
    await db.query(fnBody(polls, "public.cast_channel_poll_vote"));
    await db.query(fnBody(workloadConfiguration, "public.get_workload_stats"));
  }, 120_000);
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await db.query(`rollback;
      truncate public.chapter_channel_poll_votes, public.chapter_channel_poll_options,
        public.chapter_channel_polls, public.chapter_spaces, public.member_workload_logs,
        public.member_profiles, public.chapters, public.organizations;
      begin;
      select set_config('proof.user','${member}',true), set_config('proof.mfa','true',true), set_config('proof.locked','false',true);
      insert into public.organizations values ('${member}','platform'),('${other}','union');
      insert into public.chapters values ('platform','${member}'),('union','${other}'),('legacy',null);
      insert into public.member_profiles values ('${member}','platform');
      insert into public.chapter_spaces values ('${poll}','platform');
      insert into public.chapter_channel_polls values ('${poll}','${poll}','platform','Priority?',null);
      insert into public.chapter_channel_poll_options values ('${option}','${poll}','Pay',0),('${second}','${poll}','Hours',1);
      insert into public.chapter_channel_poll_votes(poll_id,option_id,user_id) values ('${poll}','${second}','${other}');
    `);
  });
  const tally = async () => (await db.query("select public.get_channel_poll_tally($1) value", [poll])).rows[0].value;
  const vote = async choice => (await db.query("select public.cast_channel_poll_vote($1,$2) value", [poll, choice])).rows[0].value;

  it("pins the installed workload definition in the database contract", async () => {
    const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
    const entry = contract.functions.find(entry => entry.sig === "public.get_workload_stats()");
    expect((await db.query("select md5(pg_get_functiondef('public.get_workload_stats()'::regprocedure)) digest")).rows[0].digest).toBe(entry.bodyMd5);
  });

  it("commits platform cast, change and clear while withholding every aggregate", async () => {
    for (const choice of [option, second, null]) {
      const value = await vote(choice);
      expect(value).toMatchObject({ total: null, mine: choice, options: [
        { id: option, label: "Pay", position: 0, votes: null },
        { id: second, label: "Hours", position: 1, votes: null },
      ] });
      await db.query("commit; begin");
      const stored = await db.query("select option_id from public.chapter_channel_poll_votes where poll_id=$1 and user_id=$2", [poll, member]);
      expect(stored.rows).toEqual(choice ? [{ option_id: choice }] : []);
      await db.query("select set_config('proof.user',$1,true),set_config('proof.mfa','true',true)", [member]);
      expect(await tally()).toEqual(value);
    }
    expect((await db.query("select count(*)::int n from public.chapter_channel_poll_votes")).rows[0].n).toBe(1);
  });

  it("preserves union counts and refuses closed, invalid, inaccessible and unauthenticated votes", async () => {
    await db.query("update public.chapters set organization_id=$1 where id='platform'", [other]);
    expect(await vote(option)).toMatchObject({ total: 2, mine: option, options: [{ votes: 1 }, { votes: 1 }] });
    for (const [setup, choice, error] of [
      ["update public.chapter_channel_polls set closes_at=now()", option, { code: "22023", message: "poll closed" }],
      ["select 1", member, { code: "22023", message: "poll unavailable" }],
      ["update public.member_profiles set chapter_id='legacy'", option, { code: "22023", message: "poll unavailable" }],
      ["select set_config('proof.mfa','false',true)", null, { code: "42501", message: "authentication required" }],
      ["select set_config('proof.user','',true)", null, { code: "42501", message: "authentication required" }],
    ]) {
      await db.query("savepoint refusal");
      await db.query(setup);
      await expect(vote(choice)).rejects.toMatchObject(error);
      await db.query("rollback to savepoint refusal");
      expect((await db.query("select option_id from public.chapter_channel_poll_votes where user_id=$1", [member])).rows).toEqual([{ option_id: option }]);
    }
  });

  it("retains ownerless anonymity-floor and aggregate reads while still rejecting platform workload", async () => {
    await db.query("savepoint platform_refusal");
    await expect(db.query("select public.get_workload_stats()"))
      .rejects.toMatchObject({ code: "42501", message: "platform organization is private" });
    await db.query("rollback to savepoint platform_refusal");
    await db.query("update public.member_profiles set chapter_id='legacy'");
    expect((await db.query("select public.get_workload_stats() value")).rows[0].value)
      .toMatchObject({ enoughData: false, reason: "anonymity_floor", minSubmitters: 25 });
    await db.query(`
      insert into public.member_profiles select md5(n::text)::uuid,'legacy' from generate_series(1,25) n;
      insert into public.member_workload_logs(id,user_id,created_at,priority,pending,unread_docs,todos,
        referrals,ce_activities,assistance_requests,aged_cases,employment,ot_hours)
        select gen_random_uuid(),id,date_trunc('quarter',now() at time zone 'America/New_York') at time zone 'America/New_York' - interval '1 day',
          2,2,2,2,2,2,2,2,'full_time',3 from public.member_profiles where id<>'${member}';
    `);
    const legacy = (await db.query("select public.get_workload_stats() value")).rows[0].value;
    expect(legacy).toMatchObject({ enoughData: true, submittersBand: "25-49", tiles: { pctFullTime: 100, avgOtHours: 3 } });
    expect(legacy.categories).toHaveLength(8);
    await db.query("update public.member_profiles set chapter_id='union' where chapter_id='legacy'");
    expect((await db.query("select public.get_workload_stats() value")).rows[0].value).toEqual(legacy);
    await db.query("select set_config('proof.locked','true',true)");
    expect((await db.query("select public.get_workload_stats() value")).rows[0].value)
      .toMatchObject({ enoughData: false, locked: true, reason: "quarterly_survey_gate" });
  });

  it("#7180 keeps entries with unknown categories and publishes each category only over 25 measured values", async () => {
    await db.query("update public.member_profiles set chapter_id='legacy'");
    await db.query(`
      insert into public.member_profiles select md5(n::text)::uuid,'legacy' from generate_series(1,30) n;
      insert into public.member_workload_logs(id,user_id,created_at,priority,pending,unread_docs,todos,
        referrals,ce_activities,assistance_requests,aged_cases,employment,ot_hours)
        select gen_random_uuid(),id,date_trunc('quarter',now() at time zone 'America/New_York') at time zone 'America/New_York' - interval '1 day',
          2,2,2,case when row_number() over (order by id) <= 25 then 2 end,2,2,2,null,'full_time',3
        from public.member_profiles where id<>'${member}';
    `);
    const stats = (await db.query("select public.get_workload_stats() value")).rows[0].value;
    expect(stats).toMatchObject({ enoughData: true, submittersBand: "25-49", tiles: { pctFullTime: 100, avgOtHours: 3 } });
    expect(stats.categories.map(category => category.key)).toEqual(["priority", "pending", "unread_docs", "todos", "referrals", "ce_activities", "assistance_requests"]);
    for (const category of stats.categories) expect(category).toMatchObject({ avg: 2, median: 2, p90: 2 });
    await db.query("update public.member_workload_logs set todos=null where user_id=(select user_id from public.member_workload_logs where todos is not null order by user_id limit 1)");
    expect((await db.query("select public.get_workload_stats() value")).rows[0].value.categories.map(category => category.key)).not.toContain("todos");
  });
});
