// @vitest-environment node
//
// SEC-UG-LIVE-POLL-ROSTER-ELIGIBILITY-NOT-ROSTER-BOUND-20260920
//
// Meeting-roster voting eligibility is staff-granted. Self-service attendance
// writes leave a member ineligible, and the member snapshot omits check-in
// when the caller holds no eligible row.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const MIGRATION = "supabase/migrations/20260924020500_live_poll_roster_eligibility_staff_only.sql";
const migration = readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

function extractFunction(sql, name) {
  const start = sql.indexOf(`create or replace function ${name}`);
  expect(start, name).toBeGreaterThan(-1);
  const marker = "$function$;";
  const end = sql.indexOf(marker, start);
  expect(end, name).toBeGreaterThan(start);
  return sql.slice(start, end + marker.length);
}

function insertColumnLists(fnSql, table) {
  const re = new RegExp(`insert into ${table.replaceAll(".", "\\.")}\\s*\\(([^)]+)\\)`, "gi");
  return [...fnSql.matchAll(re)].map((match) => match[1].split(",").map((part) => part.trim()));
}

describe("live poll roster eligibility (static)", () => {
  it("defaults eligible false, leaves existing rows, and keeps eligible out of self-service inserts", () => {
    expect(migration).toMatch(/alter table public\.organization_live_poll_attendance\s+alter column eligible set default false/);
    expect(migration).toContain("comment on column public.organization_live_poll_attendance.eligible");
    expect(migration).toContain("comment on table public.organization_live_poll_attendance");
    expect(migration).toMatch(/keep the value stored at insert/i);
    expect(migration).toMatch(/are not rewritten in place/i);
    expect(migration).not.toMatch(/update public\.organization_live_poll_attendance[\s\S]{0,120}eligible\s*=\s*false/i);

    const rsvp = extractFunction(migration, "public.rsvp_organization_live_poll");
    const rsvpInserts = insertColumnLists(rsvp, "public.organization_live_poll_attendance");
    expect(rsvpInserts).toHaveLength(1);
    expect(rsvpInserts[0]).toEqual(["organization_id", "poll_id", "user_id", "rsvp"]);
    expect(rsvpInserts[0]).not.toContain("eligible");

    const roster = extractFunction(migration, "public.set_organization_live_poll_roster");
    const rosterInserts = insertColumnLists(roster, "public.organization_live_poll_attendance");
    expect(rosterInserts).toHaveLength(1);
    expect(rosterInserts[0]).toEqual(["organization_id", "poll_id", "user_id", "eligible"]);
    expect(roster).toMatch(/select org, p_poll_id, actor\.user_id, true/i);
    expect(roster).toContain("do update set eligible = true");

    const checkIn = extractFunction(migration, "public.check_in_organization_live_poll");
    const selfBranch = checkIn.split("-- self-service:")[1];
    expect(selfBranch).toBeDefined();
    expect(selfBranch).not.toMatch(/insert into public\.organization_live_poll_attendance/i);
    expect(insertColumnLists(selfBranch, "public.organization_live_poll_attendance")).toEqual([]);

    const lockPreamble = /^\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n\ndeclare\n/;
    for (const name of [
      "public.set_organization_live_poll_roster",
      "public.rsvp_organization_live_poll",
      "public.check_in_organization_live_poll",
    ]) {
      const fn = parseFunctions(migration, MIGRATION).find((entry) => entry.name === name);
      expect(fn, name).toBeTruthy();
      expect(helperFirst(fn.source), name).toBe(true);
      expect(fn.source, name).toMatch(lockPreamble);
    }

    const snapshot = extractFunction(migration, "private.engagement_member_snapshot_scoped");
    expect(snapshot).toContain("'canCheckIn'");
    expect(snapshot).toContain("coalesce(attendance.eligible, false)");

    const rsvpContract = contract.functions.find((entry) => entry.sig === "public.rsvp_organization_live_poll(p_poll_id uuid, p_rsvp text)");
    expect(rsvpContract.bodyForbids).toEqual(["eligible"]);
    expect(rsvpContract.bodyContains).toEqual(expect.arrayContaining([
      "perform private.lock_case_graph(array[auth.uid()], array[]::uuid[])",
    ]));
    const checkInContract = contract.functions.find((entry) => entry.sig === "public.check_in_organization_live_poll(p_poll_id uuid, p_user_id uuid)");
    expect(checkInContract.bodyContains).toEqual(expect.arrayContaining([
      "perform private.lock_case_graph(array[auth.uid()], array[]::uuid[])",
      "eligible = true",
      "check-in required",
    ]));
    const rosterContract = contract.functions.find((entry) => entry.sig === "public.set_organization_live_poll_roster(p_poll_id uuid, p_user_ids uuid[])");
    expect(rosterContract.bodyContains).toEqual(expect.arrayContaining([
      "perform private.lock_case_graph(array[auth.uid()], array[]::uuid[])",
      "organization_id, poll_id, user_id, eligible",
      "do update set eligible = true",
    ]));
  });
});

const ID = {
  org: "50902121-0000-4000-8000-000000000001",
  staff: "50902121-0000-4000-8000-000000000101",
  member: "50902121-0000-4000-8000-000000000102",
  extra: "50902121-0000-4000-8000-000000000103",
  staffSession: "50902121-0000-4000-8000-000000000201",
  memberSession: "50902121-0000-4000-8000-000000000202",
  extraSession: "50902121-0000-4000-8000-000000000203",
};
const CHAPTER = "roster-elig-chapter";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("live poll roster eligibility on a disposable database", () => {
  let db;

  async function as(userId, sessionId, statement, values = []) {
    await db.query("savepoint roster_eligibility");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: userId,
        role: "authenticated",
        session_id: sessionId,
        aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const result = await db.query(statement, values);
      await db.query("reset role");
      await db.query("release savepoint roster_eligibility");
      return { code: "", rows: result.rows, message: "" };
    } catch (error) {
      await db.query("rollback to savepoint roster_eligibility");
      await db.query("reset role").catch(() => {});
      return { code: error.code || "?", rows: [], message: error.message || "" };
    }
  }

  async function asMember(statement, values = []) {
    return as(ID.member, ID.memberSession, statement, values);
  }

  async function asStaff(statement, values = []) {
    return as(ID.staff, ID.staffSession, statement, values);
  }

  async function openRosterPoll(title) {
    const pollId = randomUUID();
    const yesId = randomUUID();
    const noId = randomUUID();
    await db.query(
      `insert into public.organization_live_polls (
         id, organization_id, title, description, state, eligibility, results_visibility, created_by
       ) values ($1,$2,$3,'Roster eligibility proof','open','roster','live',$4)`,
      [pollId, ID.org, title, ID.staff],
    );
    await db.query(
      `insert into public.organization_live_poll_options (id, organization_id, poll_id, label, sort_index)
       values ($1,$3,$4,'Yes',0),($2,$3,$4,'No',1)`,
      [yesId, noId, ID.org, pollId],
    );
    return { pollId, yesId };
  }

  async function attendance(pollId, userId = ID.member) {
    return (await db.query(
      `select eligible, rsvp, checked_in_at is not null as checked_in
       from public.organization_live_poll_attendance
       where poll_id = $1 and user_id = $2`,
      [pollId, userId],
    )).rows;
  }

  async function memberPoll(pollId) {
    const snapshot = await asMember("select public.get_member_engagement_snapshot() snapshot");
    expect(snapshot, snapshot.message).toMatchObject({ code: "" });
    return (snapshot.rows[0]?.snapshot?.livePolls || []).find((poll) => poll.id === pollId) || null;
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "live-poll-roster-eligibility-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '30s'");
    await db.query("set local lock_timeout = '15s'");
    await db.query(
      `insert into auth.users (id,email) values
        ($1,'roster-elig-staff@example.invalid'),
        ($2,'roster-elig-member@example.invalid'),
        ($3,'roster-elig-extra@example.invalid')`,
      [ID.staff, ID.member, ID.extra],
    );
    await db.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,'roster-elig-org','Roster eligibility proof org',$2)",
      [ID.org, ID.staff],
    );
    await db.query(
      "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,92121)",
      [CHAPTER, ID.org],
    );
    await db.query(
      "insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)",
      [ID.org],
    );
    for (const userId of [ID.staff, ID.member, ID.extra]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ID.org, userId]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [userId, CHAPTER]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [userId, CHAPTER]);
    }
    await db.query(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$2)",
      [ID.org, ID.staff],
    );
    await db.query(
      `insert into auth.sessions(id,user_id,aal,created_at,updated_at) values
        ($1,$2,'aal2',now(),now()),($3,$4,'aal2',now(),now()),($5,$6,'aal2',now(),now())`,
      [ID.staffSession, ID.staff, ID.memberSession, ID.member, ID.extraSession, ID.extra],
    );
    await db.query(
      `insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
       values (gen_random_uuid(),$1,'staff-totp','totp','verified',now(),now()),
              (gen_random_uuid(),$2,'member-totp','totp','verified',now(),now()),
              (gen_random_uuid(),$3,'extra-totp','totp','verified',now(),now())`,
      [ID.staff, ID.member, ID.extra],
    );
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("self check-in leaves the member ineligible and a later vote is refused", async () => {
    const defaultRow = (await db.query(`
      select pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_expr
      from pg_catalog.pg_attrdef d
      join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
      join pg_catalog.pg_class c on c.oid = d.adrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'organization_live_poll_attendance' and a.attname = 'eligible'
    `)).rows[0];
    expect(defaultRow?.default_expr).toMatch(/false/i);

    const { pollId, yesId } = await openRosterPoll("Self check-in poll");
    const checkIn = await asMember("select public.check_in_organization_live_poll($1) result", [pollId]);
    expect(checkIn.code).toBe("42501");
    expect(checkIn.message).toMatch(/check-in required/i);
    expect(await attendance(pollId)).toEqual([]);
    const snapshot = await memberPoll(pollId);
    expect(snapshot?.canCheckIn).toBe(false);
    expect(snapshot?.attendance?.eligible ?? false).toBe(false);
    const vote = await asMember("select public.cast_organization_live_poll_vote($1,$2) result", [pollId, yesId]);
    expect(vote.code).toBe("42501");
    expect(vote.message).toMatch(/check-in required/i);
  });

  it("RSVP then self check-in and self check-in then RSVP both end ineligible", async () => {
    const first = await openRosterPoll("RSVP then check-in");
    const rsvpFirst = await asMember("select public.rsvp_organization_live_poll($1,'yes') result", [first.pollId]);
    expect(rsvpFirst, rsvpFirst.message).toMatchObject({ code: "" });
    const checkAfterRsvp = await asMember("select public.check_in_organization_live_poll($1) result", [first.pollId]);
    expect(checkAfterRsvp.code).toBe("42501");
    expect(await attendance(first.pollId)).toEqual([{ eligible: false, rsvp: "yes", checked_in: false }]);

    const second = await openRosterPoll("Check-in then RSVP");
    const checkFirst = await asMember("select public.check_in_organization_live_poll($1) result", [second.pollId]);
    expect(checkFirst.code).toBe("42501");
    const rsvpAfterCheck = await asMember("select public.rsvp_organization_live_poll($1,'maybe') result", [second.pollId]);
    expect(rsvpAfterCheck, rsvpAfterCheck.message).toMatchObject({ code: "" });
    expect(await attendance(second.pollId)).toEqual([{ eligible: false, rsvp: "maybe", checked_in: false }]);
  });

  it("a staff roster write plus a staff-executed check-in lets the member vote", async () => {
    const { pollId, yesId } = await openRosterPoll("Staff granted poll");
    const roster = await asStaff("select public.set_organization_live_poll_roster($1,$2) result", [pollId, [ID.member]]);
    expect(roster, roster.message).toMatchObject({ code: "" });
    expect(await attendance(pollId)).toEqual([{ eligible: true, rsvp: "pending", checked_in: false }]);
    const beforeCheckIn = await memberPoll(pollId);
    expect(beforeCheckIn?.canCheckIn).toBe(true);
    expect(beforeCheckIn?.attendance?.eligible).toBe(true);

    const staffCheckIn = await asStaff("select public.check_in_organization_live_poll($1,$2) result", [pollId, ID.member]);
    expect(staffCheckIn, staffCheckIn.message).toMatchObject({ code: "" });
    expect(await attendance(pollId)).toEqual([{ eligible: true, rsvp: "pending", checked_in: true }]);
    const afterCheckIn = await memberPoll(pollId);
    expect(afterCheckIn?.canCheckIn).toBe(false);

    const vote = await asMember("select public.cast_organization_live_poll_vote($1,$2) result", [pollId, yesId]);
    expect(vote, vote.message).toMatchObject({ code: "" });
    expect(vote.rows[0]?.result).toEqual({ pollId, voted: true });
  });

  it("the staff roster counter counts only staff-granted eligibility", async () => {
    const { pollId } = await openRosterPoll("Roster counter poll");
    await asMember("select public.rsvp_organization_live_poll($1,'yes') result", [pollId]);
    await as(ID.extra, ID.extraSession, "select public.rsvp_organization_live_poll($1,'yes') result", [pollId]);
    const before = await asStaff("select public.get_staff_engagement_snapshot() snapshot");
    expect(before, before.message).toMatchObject({ code: "" });
    const beforePoll = (before.rows[0]?.snapshot?.livePolls || []).find((poll) => poll.id === pollId);
    expect(beforePoll?.attendance).toMatchObject({ roster: 0, rsvpYes: 2 });

    await asStaff("select public.set_organization_live_poll_roster($1,$2) result", [pollId, [ID.member]]);
    const afterRoster = await asStaff("select public.get_staff_engagement_snapshot() snapshot");
    const afterPoll = (afterRoster.rows[0]?.snapshot?.livePolls || []).find((poll) => poll.id === pollId);
    expect(afterPoll?.attendance).toMatchObject({ roster: 1, rsvpYes: 2 });

    await asStaff("select public.check_in_organization_live_poll($1,$2) result", [pollId, ID.extra]);
    const afterStaffCheckIn = await asStaff("select public.get_staff_engagement_snapshot() snapshot");
    const granted = (afterStaffCheckIn.rows[0]?.snapshot?.livePolls || []).find((poll) => poll.id === pollId);
    expect(granted?.attendance).toMatchObject({ roster: 2, rsvpYes: 2, checkedIn: 1 });
  });
});
