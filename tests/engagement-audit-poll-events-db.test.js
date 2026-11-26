// @vitest-environment node
//
// SEC-UG-ENGAGEMENT-AUDIT-EVENT-TAXONOMY-20260921 (part 2 of 2)
// The weekly-question and live-poll writers used to append
// 'survey_draft_saved'. This proof executes one writer per event type on a
// disposable database, as a verified-MFA admin of a fresh organization (the
// scheduled selection through the cron entry point, attributed to the policy
// author), and requires the operation's own event type, its row identifier and
// actor, no draft-save row, and a 'communications' projection in the admin
// ledger. It also proves a due policy whose author was deleted still runs:
// the old null-actor audit insert made every such tick raise. Everything runs
// in one transaction that is rolled back.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("weekly-question and live-poll writers audit their own operation", () => {
  let client;
  const ids = { org: randomUUID(), admin: randomUUID(), member: randomUUID(), q1: randomUUID(), q2: randomUUID(), q3: randomUUID() };
  ids.chapter = `audit-polls-${ids.org}`;

  async function asAdmin(sql, args = []) {
    await client.query("set local role authenticated");
    try {
      const { rows } = await client.query(sql, args);
      return rows[0]?.value;
    } finally {
      await client.query("reset role");
    }
  }

  // created_at is the transaction timestamp, so new rows are found by id.
  async function eventIds() {
    const { rows } = await client.query(
      "select id from public.organization_audit_events where organization_id = $1",
      [ids.org],
    );
    return new Set(rows.map((row) => row.id));
  }

  async function only(eventType, run) {
    const before = await eventIds();
    await run();
    const { rows: all } = await client.query(
      "select id, event_type, actor_user_id, metadata from public.organization_audit_events where organization_id = $1",
      [ids.org],
    );
    const rows = all.filter((row) => !before.has(row.id));
    expect(rows.map((row) => row.event_type)).toEqual([eventType]);
    expect(rows[0].actor_user_id).toBe(ids.admin);
    expect(rows[0].metadata.organizationId).toBe(ids.org);
    expect(rows[0].metadata.userId).toBe(ids.admin);
    return rows[0].metadata;
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      application_name: "engagement-audit-poll-events-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '15s'");
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [ids.org, ids.chapter]);
    await client.query(
      "insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9900)",
      [ids.chapter, ids.org],
    );
    for (const user of [ids.admin, ids.member]) {
      await client.query("insert into auth.users(id,email) values ($1,$2)", [user, `${user}@example.invalid`]);
      await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, ids.chapter]);
      await client.query(
        "insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing",
        [ids.org, user],
      );
      await client.query(
        "insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing",
        [user, ids.chapter],
      );
    }
    await client.query(
      "insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin') on conflict do nothing",
      [ids.org, ids.admin],
    );
    await client.query(
      "insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())",
      [randomUUID(), ids.admin],
    );
    const session = randomUUID();
    await client.query(
      "insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())",
      [session, ids.admin],
    );
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: ids.admin, role: "authenticated", aal: "aal2", session_id: session }),
    ]);
    for (const [index, id] of [ids.q1, ids.q2, ids.q3].entries()) {
      await client.query(
        "insert into public.member_weekly_questions(id,chapter_id,user_id,week_start,body) values ($1,$2,$3,date '2026-01-05' + $4 * 7,'Should we meet on weekends?')",
        [id, ids.chapter, ids.member, index],
      );
    }
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("a selection policy save audits weekly_question_policy_saved", async () => {
    const metadata = await only("weekly_question_policy_saved", () => asAdmin(
      "select public.save_weekly_question_selection_policy(true, 7, 1, 1, 'support_then_oldest', null) as value",
    ));
    expect(metadata.chapterId).toBe(ids.chapter);
    expect(metadata.status).toBe("enabled");
    expect(metadata.count).toBe(1);
  });

  it("a manual selection run audits weekly_question_selection_run as manual", async () => {
    const metadata = await only("weekly_question_selection_run", () => asAdmin(
      "select public.run_weekly_question_selection($1) as value",
      [randomUUID()],
    ));
    expect(metadata.reasonCode).toBe("manual");
    expect(metadata.count).toBe(1);
  });

  it("an editorial review audits weekly_question_reviewed with the question id", async () => {
    const metadata = await only("weekly_question_reviewed", () => asAdmin(
      "select public.review_weekly_poll_question($1, 'archived', 'Duplicate of last week') as value",
      [ids.q3],
    ));
    expect(metadata.questionId).toBe(ids.q3);
    expect(metadata.status).toBe("archived");
    expect(JSON.stringify(metadata)).not.toContain("Duplicate");
  });

  it("a scheduled selection run audits weekly_question_selection_run as scheduled, attributed to the policy author", async () => {
    await client.query(
      "update public.weekly_question_selection_policies set next_run_at = timestamptz '2000-01-01' where organization_id = $1",
      [ids.org],
    );
    const metadata = await only("weekly_question_selection_run", () => client.query(
      "select private.run_due_weekly_question_selections(100)",
    ));
    expect(metadata.reasonCode).toBe("scheduled");
    expect(metadata.chapterId).toBe(ids.chapter);
  });

  it("a due policy whose author is gone still runs without an audit row", async () => {
    await client.query(
      "update public.weekly_question_selection_policies set next_run_at = timestamptz '2000-01-01', updated_by = null where organization_id = $1",
      [ids.org],
    );
    const before = await eventIds();
    await client.query("select private.run_due_weekly_question_selections(100)");
    const { rows: [policy] } = await client.query(
      "select next_run_at > now() as rescheduled from public.weekly_question_selection_policies where organization_id = $1",
      [ids.org],
    );
    expect(policy.rescheduled).toBe(true);
    const after = await eventIds();
    expect([...after].filter((id) => !before.has(id))).toEqual([]);
  });

  let pollId;
  it("a live poll save audits live_poll_saved with the poll id", async () => {
    let saved;
    const metadata = await only("live_poll_saved", async () => {
      saved = await asAdmin(
        "select public.save_organization_live_poll($1::jsonb) as value",
        [JSON.stringify({ title: "Strike vote timing", options: ["Now", "Later"] })],
      );
    });
    pollId = saved.id;
    expect(metadata.pollId).toBe(pollId);
    expect(metadata.status).toBe("draft");
    expect(metadata.count).toBe(2);
    expect(JSON.stringify(metadata)).not.toContain("Strike vote timing");
  });

  it("a live poll transition audits live_poll_transitioned with its action", async () => {
    const metadata = await only("live_poll_transitioned", () => asAdmin(
      "select public.transition_organization_live_poll($1, 'open') as value",
      [pollId],
    ));
    expect(metadata.pollId).toBe(pollId);
    expect(metadata.action).toBe("open");
    expect(metadata.status).toBe("open");
  });

  it("the admin ledger projects the weekly-question and live-poll events into communications", async () => {
    const ledger = await asAdmin(
      "select public.list_organization_audit_ledger(200, null, null, 'communications', null) as value",
    );
    const actions = new Map(ledger.filter((event) => event.source === "organization_audit_events")
      .map((event) => [event.eventType, event.action]));
    expect(actions.get("weekly_question_policy_saved")).toBe("settings_change");
    for (const type of ["weekly_question_selection_run", "weekly_question_reviewed", "live_poll_saved", "live_poll_transitioned"]) {
      expect(actions.get(type), type).toBe("update");
    }
    expect(actions.has("survey_draft_saved")).toBe(false);
  });
});
