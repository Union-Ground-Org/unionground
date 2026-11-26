// @vitest-environment node
//
// SEC-UG-ENGAGEMENT-AUDIT-EVENT-TAXONOMY-20260921 (part 1 of 2)
// The survey-side engagement writers used to append 'survey_draft_saved'
// whatever they did. This proof executes one writer per new event type on a
// disposable database, as a verified-MFA admin of a fresh organization, and
// requires the operation's own event type, its row identifier and the actor,
// no draft-save row, and a 'communications' projection in the admin ledger.
// Everything runs in one transaction that is rolled back.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("engagement survey writers audit their own operation", () => {
  let client;
  const ids = { org: randomUUID(), admin: randomUUID(), member: randomUUID(), survey: randomUUID() };
  ids.chapter = `audit-taxonomy-${ids.org}`;

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
      application_name: "engagement-audit-survey-events-proof",
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
    await client.query(
      "insert into public.organization_surveys(id,organization_id,chapter_id,title,status,created_by) values ($1,$2,$3,'Audit taxonomy proof','open',$4)",
      [ids.survey, ids.org, ids.chapter, ids.admin],
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("a privacy-floor change audits survey_privacy_floor_changed", async () => {
    const metadata = await only("survey_privacy_floor_changed", () => asAdmin(
      "select public.set_organization_survey_privacy_floor($1, 7) as value",
      [ids.survey],
    ));
    expect(metadata.surveyId).toBe(ids.survey);
    expect(metadata.privacyMinResponses).toBe(7);
  });

  it("an operations configuration audits survey_operations_configured", async () => {
    const metadata = await only("survey_operations_configured", () => asAdmin(
      "select public.configure_organization_survey_operations($1, $2::jsonb) as value",
      [ids.survey, JSON.stringify({ cadence: "one_off", operationsState: "distributing" })],
    ));
    expect(metadata.surveyId).toBe(ids.survey);
    expect(metadata.status).toBe("distributing");
    expect(metadata.reasonCode).toBeUndefined();
  });

  it("a task update audits survey_task_updated with the task id", async () => {
    const { rows: [{ id: taskId }] } = await client.query(
      "insert into public.organization_survey_tasks(organization_id,survey_id,reason) values ($1,$2,'closeout') returning id",
      [ids.org, ids.survey],
    );
    const metadata = await only("survey_task_updated", () => asAdmin(
      "select public.update_organization_survey_task($1, 'in_progress', $2) as value",
      [taskId, ids.admin],
    ));
    expect(metadata.taskId).toBe(taskId);
    expect(metadata.surveyId).toBe(ids.survey);
    expect(metadata.status).toBe("in_progress");
  });

  it("a response review update audits survey_response_review_updated with the review id", async () => {
    // SEC-UG-SURVEY-REVIEW-PRIVACY-FLOOR-20261001: review triage is
    // refused until the survey reaches its privacy floor, which never goes
    // below 25 whatever the survey's own floor of three
    // (REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104), so the
    // survey gets 25 submitted responses first.
    await client.query("update public.organization_surveys set privacy_min_responses = 3 where id = $1", [ids.survey]);
    const extra = Array.from({ length: 23 }, () => randomUUID());
    await client.query("insert into auth.users(id,email) select id,id::text || '@example.invalid' from unnest($1::uuid[]) id", [extra]);
    const submitted = [];
    for (const respondent of [ids.member, ids.admin, ...extra]) {
      const { rows: [{ id }] } = await client.query(
        "insert into public.organization_survey_sessions(organization_id,survey_id,respondent_user_id,status,submitted_at) values ($1,$2,$3,'submitted',now()) returning id",
        [ids.org, ids.survey, respondent],
      );
      submitted.push(id);
    }
    const sessionId = submitted[0];
    const { rows: [{ id: reviewId }] } = await client.query(
      "insert into public.organization_survey_reviews(organization_id,survey_id,session_id) values ($1,$2,$3) returning id",
      [ids.org, ids.survey, sessionId],
    );
    const metadata = await only("survey_response_review_updated", () => asAdmin(
      "select public.update_organization_survey_review($1, 'follow_up', $2, 'Call back') as value",
      [reviewId, ids.admin],
    ));
    expect(metadata.reviewId).toBe(reviewId);
    expect(metadata.sessionId).toBe(sessionId);
    expect(metadata.status).toBe("follow_up");
    expect(JSON.stringify(metadata)).not.toContain("Call back");
  });

  it("a pulse prompt save audits pulse_prompt_saved with the prompt id", async () => {
    let saved;
    const metadata = await only("pulse_prompt_saved", async () => {
      saved = await asAdmin(
        "select public.save_organization_pulse_prompt($1::jsonb) as value",
        [JSON.stringify({ eventKey: "contract.page", question: "How did it go?", options: ["Good", "Bad"] })],
      );
    });
    expect(metadata.promptId).toBe(saved.id);
    expect(metadata.status).toBe("active");
    expect(JSON.stringify(metadata)).not.toContain("How did it go?");
  });

  it("the admin ledger projects the survey events into communications", async () => {
    const ledger = await asAdmin(
      "select public.list_organization_audit_ledger(200, null, null, 'communications', null) as value",
    );
    const byType = new Map(ledger.filter((event) => event.source === "organization_audit_events")
      .map((event) => [event.eventType, event]));
    for (const type of ["survey_task_updated", "survey_response_review_updated", "pulse_prompt_saved"]) {
      expect(byType.get(type)?.action, type).toBe("update");
    }
    for (const type of ["survey_privacy_floor_changed", "survey_operations_configured"]) {
      expect(byType.get(type)?.action, type).toBe("settings_change");
    }
    expect(byType.has("survey_draft_saved")).toBe(false);
    const administration = await asAdmin(
      "select public.list_organization_audit_ledger(200, null, null, 'administration', null) as value",
    );
    expect(administration.filter((event) => event.source === "organization_audit_events")).toEqual([]);
  });
});
