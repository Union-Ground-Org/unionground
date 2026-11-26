// @vitest-environment node
//
// SEC-UG-LIVE-POLL-CHECKIN-CHAPTER-ELIGIBILITY-20260921
//
// RSVP and voting refuse a chapter-bound live poll outside the member's
// chapter; check-in did not, for self or staff-assisted check-in.
// 20260925550600 re-emits check_in_organization_live_poll with the same
// chapter boundary, resolved from the member being checked in.
//
// The offline half pins the migration text and the db-contract entry. The
// live half (disposable loopback only) runs two chapters of one organization
// in one rolled-back transaction.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const NAME = "20260925550600_live_poll_checkin_chapter_eligibility.sql";
const sql = stripComments(loadMigrationSql("live_poll_checkin_chapter_eligibility"));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const CHAPTER_CLAUSE = "and ( p.chapter_id is null or p.chapter_id = ( select profile.chapter_id from public.member_profiles profile where profile.id = target ) )";

describe("live-poll check-in chapter eligibility migration", () => {
  it("is the newest emitter of the check-in RPC, inside one bounded transaction", () => {
    expect(findMigrationName("live_poll_checkin_chapter_eligibility")).toBe(NAME);
    const last = [...migrationFiles()].reverse().find(({ sql: text }) => (
      stripComments(text).toLowerCase().includes("function public.check_in_organization_live_poll(")
    ));
    expect(last.name).toBe(NAME);
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("adds only the chapter clause to the 20260924020500 body and keeps the lock first", () => {
    const body = squash(fnBody(sql, "public.check_in_organization_live_poll"));
    const previous = squash(fnBody(stripComments(loadMigrationSql("live_poll_roster_eligibility_staff_only")), "public.check_in_organization_live_poll"));
    expect(body).toContain("as $function$ begin perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]); declare org uuid");
    expect(body).toContain(`p.state in ('scheduled', 'open') ${CHAPTER_CLAUSE} ) then raise exception 'not found' using errcode = 'P0002'; end if;`);
    expect(body.replace(` ${CHAPTER_CLAUSE}`, "")).toBe(previous);
  });

  it("pins the chapter clause in the database contract", () => {
    const entry = contract.functions.find((row) => row.sig === "public.check_in_organization_live_poll(p_poll_id uuid, p_user_id uuid)");
    expect(entry.bodyContains).toEqual(expect.arrayContaining([
      "perform private.lock_case_graph(array[auth.uid()], array[]::uuid[])",
      "p.chapter_id is null",
      "where profile.id = target",
    ]));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("live-poll check-in admits only polls the checked-in member's chapter may attend", () => {
  let db;
  const id = Object.fromEntries([
    "org", "staff", "memberA", "memberB", "staffSession", "memberASession", "memberBSession",
  ].map((key) => [key, randomUUID()]));
  const chapterA = `lpce-a-${id.org}`;
  const chapterB = `lpce-b-${id.org}`;
  const sessions = { [id.staff]: id.staffSession, [id.memberA]: id.memberASession, [id.memberB]: id.memberBSession };

  async function as(user, statement, values = []) {
    await db.query("savepoint checkin_chapter");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: user, role: "authenticated", session_id: sessions[user], aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const result = await db.query(statement, values);
      await db.query("reset role");
      await db.query("release savepoint checkin_chapter");
      return { code: "", rows: result.rows, message: "" };
    } catch (error) {
      await db.query("rollback to savepoint checkin_chapter");
      await db.query("reset role").catch(() => {});
      return { code: error.code || "?", rows: [], message: error.message || "" };
    }
  }

  async function poll(chapterId) {
    const pollId = randomUUID();
    await db.query(
      `insert into public.organization_live_polls (
         id, organization_id, chapter_id, title, description, state, eligibility, results_visibility, created_by
       ) values ($1,$2,$3,'Chapter check-in proof','Chapter check-in proof','open','roster','live',$4)`,
      [pollId, id.org, chapterId, id.staff],
    );
    return pollId;
  }

  async function attendance(pollId, userId) {
    return (await db.query(
      "select eligible, checked_in_at is not null as checked_in from public.organization_live_poll_attendance where poll_id=$1 and user_id=$2",
      [pollId, userId],
    )).rows;
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "live-poll-checkin-chapter-eligibility-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '30s'");
    await db.query("set local lock_timeout = '15s'");
    for (const user of [id.staff, id.memberA, id.memberB]) {
      await db.query("insert into auth.users(id,email) values($1,$2)", [user, `${user}@example.invalid`]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [sessions[user], user]);
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values(gen_random_uuid(),$1,'lpce-totp','totp','verified',now(),now())", [user]);
    }
    await db.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [id.org, `lpce-${id.org}`, id.staff]);
    for (const [chapter, order] of [[chapterA, 92531], [chapterB, 92532]]) {
      await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,$3)", [chapter, id.org, order]);
    }
    await db.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [id.org]);
    for (const [user, chapter] of [[id.staff, chapterA], [id.memberA, chapterA], [id.memberB, chapterB]]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, user]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
    }
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$2)", [id.org, id.staff]);
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("refuses a staff-assisted check-in of an out-of-chapter member with the standard refusal and no row", async () => {
    const pollId = await poll(chapterA);
    const result = await as(id.staff, "select public.check_in_organization_live_poll($1,$2) result", [pollId, id.memberB]);
    expect(result.code, result.message).toBe("P0002");
    expect(result.message).toBe("not found");
    expect(await attendance(pollId, id.memberB)).toEqual([]);
  });

  it("still checks in and grants eligibility to a member of the poll's chapter", async () => {
    const pollId = await poll(chapterA);
    const result = await as(id.staff, "select public.check_in_organization_live_poll($1,$2) result", [pollId, id.memberA]);
    expect(result, result.message).toMatchObject({ code: "" });
    expect(result.rows[0].result).toEqual({ pollId, userId: id.memberA, checkedIn: true });
    expect(await attendance(pollId, id.memberA)).toEqual([{ eligible: true, checked_in: true }]);
  });

  it("refuses an out-of-chapter self check-in even when an eligible row exists", async () => {
    const pollId = await poll(chapterA);
    // A row that predates the boundary (for example an old roster write).
    await db.query(
      "insert into public.organization_live_poll_attendance(organization_id,poll_id,user_id,eligible,rsvp) values($1,$2,$3,true,'yes')",
      [id.org, pollId, id.memberB],
    );
    const result = await as(id.memberB, "select public.check_in_organization_live_poll($1) result", [pollId]);
    expect(result.code, result.message).toBe("P0002");
    expect(await attendance(pollId, id.memberB)).toEqual([{ eligible: true, checked_in: false }]);
  });

  it("lets an eligible in-chapter member check themselves in", async () => {
    const pollId = await poll(chapterA);
    await db.query(
      "insert into public.organization_live_poll_attendance(organization_id,poll_id,user_id,eligible,rsvp) values($1,$2,$3,true,'yes')",
      [id.org, pollId, id.memberA],
    );
    const result = await as(id.memberA, "select public.check_in_organization_live_poll($1) result", [pollId]);
    expect(result, result.message).toMatchObject({ code: "" });
    expect(await attendance(pollId, id.memberA)).toEqual([{ eligible: true, checked_in: true }]);
  });

  it("keeps an organization-wide poll open to members of every chapter", async () => {
    const pollId = await poll(null);
    const result = await as(id.staff, "select public.check_in_organization_live_poll($1,$2) result", [pollId, id.memberB]);
    expect(result, result.message).toMatchObject({ code: "" });
    expect(await attendance(pollId, id.memberB)).toEqual([{ eligible: true, checked_in: true }]);
  });
});
