// @vitest-environment node
//
// UX-UG-CHAPTER-SCOPED-STEWARD-COORDINATOR-HATS-OPEN-CAMPAIGNS-ENGAGEMENT-THEN-EVERY-STAFF-RPC-20260921
//
// A steward or coordinator granted only at chapter level (member_role_chapters,
// no organization_role_grants row) was refused by every staff engagement RPC.
// (2026-09-24) narrows the fix to the seven weekly-question
// selection/pool RPCs, which already lock to private.current_member_chapter().
// 20260925130200 adds private.engagement_require_weekly_selection_staff and
// swaps only those seven guard calls; private.engagement_require_staff stays
// organization-grant only, so the ~30 organization-wide engagement RPCs (for
// example transition_organization_live_poll) keep refusing chapter-only hats.
//
// The offline half pins the migration text and the db-contract entries. The
// live half (disposable loopback only) drives the real RPCs.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("engagement_weekly_selection_chapter_staff"));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const WEEKLY_SIGNATURES = [
  "public.list_weekly_question_editorial()",
  "public.get_weekly_question_selection_workspace()",
  "public.list_weekly_question_selection_page(text,timestamp with time zone,uuid,integer)",
  "public.save_weekly_question_selection_policy(boolean,integer,integer,integer,text,timestamp with time zone)",
  "public.run_weekly_question_selection(uuid)",
  "public.review_weekly_poll_question(uuid,text,text)",
  "public.publish_weekly_poll_question(uuid,integer)",
];

describe("weekly selection chapter-staff migration", () => {
  it("sorts after the weekly selection RPCs, inside one bounded transaction", () => {
    const name = findMigrationName("engagement_weekly_selection_chapter_staff");
    expect(name).toBe("20260925130200_engagement_weekly_selection_chapter_staff.sql");
    expect(name > "20260907151000_account_deletion_finalization_reconciliation.sql").toBe(true);
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("leaves engagement_require_staff untouched and rewrites only the seven weekly guards", () => {
    expect(sql).not.toMatch(/function\s+private\.engagement_require_staff\b/);
    expect(sql).not.toMatch(/\bgrant\s+execute\b/i);
    expect(sql).not.toMatch(/\bcreate\s+(table|policy)\b/i);
    for (const signature of WEEKLY_SIGNATURES) expect(sql).toContain(`'${signature}'`);
    expect(sql.match(/\('public\.[a-z_]+\(/g)).toHaveLength(WEEKLY_SIGNATURES.length);
    expect(sql).toContain("'perform private.engagement_require_staff(org);'");
    expect(sql).toContain("'weekly selection guard not found exactly once: %'");
  });

  it("admits a chapter grant only on the caller's own chapter of the organization, after MFA", () => {
    const body = squash(fnBody(sql, "private.engagement_require_weekly_selection_staff"));
    expect(body.indexOf("private.mfa_satisfied()")).toBeLessThan(body.indexOf("private.has_organization_role("));
    expect(body).toContain("p_chapter_id = private.current_member_chapter()");
    expect(body).toContain("private.mi1_w2_same_org_chapter(p_organization_id, p_chapter_id)");
    expect(body).toContain("public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])");
    expect(body).toContain("not private.staff_mfa_required(p_organization_id) or private.has_second_factor((select auth.uid()))");
    expect(body).toContain("raise exception 'not authorized' using errcode = '42501'");
  });

  it("pins the new guard in the database contract", () => {
    const helper = contract.functions.find((row) => row.sig === "private.engagement_require_weekly_selection_staff(p_organization_id uuid, p_chapter_id text)");
    expect(helper).toMatchObject({ secdef: true, exec: "" });
    expect(contract.mfaCoverage.guardedDelegates[helper.sig]).toMatch(/current chapter/);
    for (const sig of [
      "public.list_weekly_question_editorial()",
      "public.review_weekly_poll_question(p_question_id uuid, p_editorial_state text, p_editor_note text)",
      "public.publish_weekly_poll_question(p_question_id uuid, p_privacy_min_responses integer)",
    ]) {
      const entry = contract.functions.find((row) => row.sig === sig);
      expect(entry.bodyContains).toContain("private.engagement_require_weekly_selection_staff(org, caller_chapter)");
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("a chapter-only steward runs its own chapter's weekly selection and nothing organization-wide", () => {
  let client;
  const id = Object.fromEntries([
    "admin", "steward", "memberA", "memberB", "plain",
    "adminSession", "stewardSession", "memberASession", "memberBSession", "plainSession",
    "org", "questionA", "questionB", "pollB",
  ].map((key) => [key, randomUUID()]));
  const chapterA = `wsc-a-${id.org}`;
  const chapterB = `wsc-b-${id.org}`;

  const act = async (actor, session) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
  };
  const asSteward = () => act(id.steward, id.stewardSession);

  // Runs one statement under a savepoint and returns its SQLSTATE (null on success).
  const sqlState = async (statement, params = []) => {
    await client.query("savepoint probe");
    try {
      await client.query(statement, params);
      await client.query("release savepoint probe");
      return null;
    } catch (error) {
      await client.query("rollback to savepoint probe");
      return error.code;
    }
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "engagement-weekly-selection-chapter-staff-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    const people = [
      [id.admin, id.adminSession, chapterA],
      [id.steward, id.stewardSession, chapterA],
      [id.memberA, id.memberASession, chapterA],
      [id.memberB, id.memberBSession, chapterB],
      [id.plain, id.plainSession, chapterA],
    ];
    for (const [user, session] of people) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{\"full_name\":\"Synthetic Person\"}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic weekly factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [id.org, `wsc-${id.org}`, id.admin]);
    for (const [chapterId, order] of [[chapterA, 9951], [chapterB, 9952]]) {
      await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,$3)", [chapterId, id.org, order]);
      await client.query("insert into public.chapter_workstreams(chapter_id,name,created_by) values($1,'General',$2)", [chapterId, id.admin]);
    }
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [id.org]);
    for (const [user, , chapterId] of people) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, user]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapterId]);
      await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapterId]);
    }
    // The steward is also an active member of chapter B, so a chapter switch
    // alone must not carry the chapter-A grant into B.
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id.steward, chapterB]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)", [id.org, id.admin]);
    await client.query("insert into public.member_roles(user_id,role,chapter_id,granted_by) values($1,'steward',$2,$3)", [id.steward, chapterA, id.admin]);
    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id,granted_by) values($1,'steward',$2,$3)", [id.steward, chapterA, id.admin]);
    await client.query(`
      insert into public.member_weekly_questions (id, chapter_id, user_id, week_start, body, options, editorial_state) values
        ($1, $3, $5, current_date, 'Chapter A weekly prompt', '["Yes","No"]'::jsonb, 'submitted'),
        ($2, $4, $6, current_date, 'Chapter B weekly prompt', '["Yes","No"]'::jsonb, 'submitted')
    `, [id.questionA, id.questionB, chapterA, chapterB, id.memberA, id.memberB]);
    await client.query(`
      insert into public.organization_live_polls (id, organization_id, chapter_id, title, state, results_visibility, result_cache, vote_count, created_by)
      values ($1, $2, $3, 'Chapter B live poll', 'open', 'live', '[]', 0, $4)
    `, [id.pollB, id.org, chapterB, id.admin]);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("loads only its own chapter's weekly workspace and editorial pool", async () => {
    await asSteward();
    const workspace = (await client.query("select public.get_weekly_question_selection_workspace() as out")).rows[0].out;
    expect(workspace.chapterId).toBe(chapterA);
    expect(workspace.items.map((item) => item.id)).toEqual([id.questionA]);
    const editorial = (await client.query("select public.list_weekly_question_editorial() as out")).rows[0].out;
    expect(editorial.map((item) => item.id)).toEqual([id.questionA]);
    await client.query("reset role");
  });

  it("saves the chapter policy and runs the weekly selection for its chapter only", async () => {
    await asSteward();
    await client.query("select public.save_weekly_question_selection_policy(true, 7, 1, 1, 'support_then_oldest', null)");
    const result = (await client.query("select public.run_weekly_question_selection($1) as out", [randomUUID()])).rows[0].out;
    await client.query("reset role");
    expect(result.selectedIds).toEqual([id.questionA]);
    const states = (await client.query(
      "select id, editorial_state from public.member_weekly_questions where id = any($1::uuid[])",
      [[id.questionA, id.questionB]],
    )).rows;
    expect(Object.fromEntries(states.map((row) => [row.id, row.editorial_state]))).toEqual({
      [id.questionA]: "reserved",
      [id.questionB]: "submitted",
    });
    const policies = (await client.query("select chapter_id from public.weekly_question_selection_policies where organization_id = $1", [id.org])).rows;
    expect(policies.map((row) => row.chapter_id)).toEqual([chapterA]);
  });

  it("cannot review another chapter's weekly question", async () => {
    await asSteward();
    expect(await sqlState("select public.review_weekly_poll_question($1, 'archived', null)", [id.questionB])).toBe("P0002");
    await client.query("reset role");
    const state = (await client.query("select editorial_state from public.member_weekly_questions where id = $1", [id.questionB])).rows[0];
    expect(state.editorial_state).toBe("submitted");
  });

  it("cannot close another chapter's live poll or load the organization-wide snapshot", async () => {
    await asSteward();
    expect(await sqlState("select public.transition_organization_live_poll($1, 'close')", [id.pollB])).toBe("42501");
    expect(await sqlState("select public.get_staff_engagement_snapshot()")).toBe("42501");
    await client.query("reset role");
    const poll = (await client.query("select state from public.organization_live_polls where id = $1", [id.pollB])).rows[0];
    expect(poll.state).toBe("open");
  });

  it("carries no chapter-A authority into chapter B after a chapter switch", async () => {
    await client.query("update public.member_profiles set chapter_id = $2 where id = $1", [id.steward, chapterB]);
    await asSteward();
    const refused = await sqlState("select public.get_weekly_question_selection_workspace()");
    await client.query("reset role");
    await client.query("update public.member_profiles set chapter_id = $2 where id = $1", [id.steward, chapterA]);
    expect(refused).toBe("42501");
  });

  it("still requires the tenant staff second factor and a staff grant", async () => {
    await client.query("update auth.mfa_factors set status = 'unverified' where user_id = $1", [id.steward]);
    await asSteward();
    const unenrolled = await sqlState("select public.get_weekly_question_selection_workspace()");
    await client.query("reset role");
    await client.query("update auth.mfa_factors set status = 'verified' where user_id = $1", [id.steward]);
    expect(unenrolled).toBe("42501");

    await act(id.plain, id.plainSession);
    expect(await sqlState("select public.get_weekly_question_selection_workspace()")).toBe("42501");
    await client.query("reset role");
  });

  it("keeps organization staff on the weekly workspace", async () => {
    await act(id.admin, id.adminSession);
    const workspace = (await client.query("select public.get_weekly_question_selection_workspace() as out")).rows[0].out;
    await client.query("reset role");
    expect(workspace.chapterId).toBe(chapterA);
  });
});
