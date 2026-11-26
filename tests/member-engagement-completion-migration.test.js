// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readMigrationFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260828034122_member_engagement_completion.sql"),
  "utf8",
).toLowerCase();

function body(name, next = null) {
  const start = sql.indexOf(`create function public.${name}`);
  const end = next ? sql.indexOf(`create function public.${next}`, start) : sql.length;
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, end);
}

function latestDefining(name) {
  const migration = [...migrationFiles()].reverse().find(({ sql: text }) => (
    /create\s+(or\s+replace\s+)?function\s+/i.test(stripComments(text))
    && new RegExp(String.raw`create\s+(or\s+replace\s+)?function\s+public\.${name}\s*\(`, "i")
      .test(stripComments(text))
  ));
  expect(migration, `missing defining migration for public.${name}`).toBeTruthy();
  return {
    file: migration.name,
    body: stripComments(fnBody(migration.sql, `public.${name}`)),
  };
}

// Both RPCs bind `org` from private.engagement_selected_organization(), which
// resolves a chapterless staff account with exactly one active organization.
// private.mi1_write_tenant_audit re-derives the tenant from
// private.current_member_organization(), which is null for that same account,
// so it would raise 42501 and roll back the control update or reminder fanout
// it was only meant to record. The w2 writer checks the identical resolver.
const AUDIT_WRITER = "private.mi1_w2_write_audit";
const CHAPTER_BOUND_AUDIT_WRITER = "private.mi1_write_tenant_audit";

function auditCall(source) {
  const start = source.indexOf(AUDIT_WRITER);
  expect(start, `missing ${AUDIT_WRITER}`).toBeGreaterThan(-1);
  const open = source.indexOf("jsonb_build_object(", start);
  expect(open).toBeGreaterThan(start);
  let depth = 0;
  let end = -1;
  for (let i = open + "jsonb_build_object".length; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  expect(end).toBeGreaterThan(open);
  return {
    call: source.slice(start, end + 1),
    metadata: source.slice(open, end + 1),
  };
}

function listedTokens(source, pattern) {
  const definitions = [...source.matchAll(pattern)];
  expect(definitions.length).toBeGreaterThan(0);
  return [...definitions.at(-1)[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

describe("member engagement completion migration", () => {
  it("adds quarterly survey cadence, ownership, tasks, distribution, review, reports, and exports", () => {
    expect(sql).toContain("cadence in ('one_off', 'quarterly', 'contextual')");
    expect(sql).toContain("create unique index organization_surveys_quarterly_period_once_idx");
    for (const table of ["organization_survey_tasks", "organization_survey_deliveries", "organization_survey_reviews"]) {
      expect(sql).toContain(`create table public.${table}`);
      expect(sql).toContain(`alter table public.${table} enable row level security`);
    }
    for (const fn of [
      "configure_organization_survey_operations", "prepare_organization_survey_distribution",
      "queue_organization_survey_reminders", "update_organization_survey_task",
      "update_organization_survey_review", "get_quarterly_survey_gate",
      "get_organization_survey_report", "export_organization_survey_results",
    ]) expect(sql).toContain(`create function public.${fn}`);
    expect(body("get_organization_survey_report", "export_organization_survey_results")).toContain("privacy_min_responses");
  });

  it("implements contextual prompt evaluation, dismissal, and bounded response storage", () => {
    expect(sql).toContain("create table public.organization_pulse_prompts");
    expect(sql).toContain("create table public.organization_pulse_events");
    const evaluate = body("evaluate_contextual_pulse", "respond_contextual_pulse");
    expect(evaluate).toContain("cooldown_hours");
    expect(evaluate).toContain("on conflict (prompt_id, user_id, context_key)");
    const respond = body("respond_contextual_pulse", "save_organization_live_poll");
    expect(respond).toContain("state = 'dismissed'");
    expect(respond).toContain("response is not a prompt option");
  });

  it("implements a roster-aware live poll lifecycle with aggregate realtime rows", () => {
    for (const table of ["organization_live_polls", "organization_live_poll_options", "organization_live_poll_votes", "organization_live_poll_attendance"]) {
      expect(sql).toContain(`create table public.${table}`);
    }
    expect(body("cast_organization_live_poll_vote", "claim_engagement_delivery_batch")).toContain("check-in required");
    expect(sql).toContain("alter publication supabase_realtime add table public.organization_live_polls");
    expect(sql).not.toContain("alter publication supabase_realtime add table public.organization_live_poll_votes");
    expect(sql).toContain("result_cache");
  });

  it("keeps recipient email and content behind lease-bound service-role RPCs", () => {
    expect(sql).toContain("create table public.engagement_delivery_outbox");
    expect(sql).toContain("for update skip locked");
    expect(body("get_engagement_delivery_payload", "complete_engagement_delivery")).toContain("auth.users");
    expect(sql).toContain("grant execute on function public.claim_engagement_delivery_batch(uuid, integer, integer) to service_role");
    expect(sql).not.toContain("grant execute on function public.claim_engagement_delivery_batch(uuid, integer, integer) to authenticated");
    expect(sql).not.toContain("grant select on public.engagement_delivery_outbox to authenticated");
  });

  it("adds presence, channel controls, keyword references, and requester-owned briefing persistence", () => {
    for (const table of [
      "member_presence", "chapter_space_controls", "chapter_space_preferences",
      "chapter_space_keyword_monitors", "chapter_space_keyword_hits", "compass_message_briefings",
    ]) expect(sql).toContain(`create table public.${table}`);
    expect(body("get_message_briefing_context", "save_chapter_space_keyword_monitor")).toContain("security invoker");
    expect(body("persist_compass_message_briefing", "get_member_engagement_snapshot")).toContain("private.engagement_can_read_message_target");
    const triggerStart = sql.indexOf("create function private.capture_chapter_space_keyword_hits");
    const triggerEnd = sql.indexOf("create trigger chapter_thread_posts_capture_keyword_hits", triggerStart);
    expect(sql.slice(triggerStart, triggerEnd)).not.toContain("new.body,");
  });

  it("requires explicit confirmation for Compass workspace actions and validates the source again", () => {
    expect(sql).toContain("state text not null default 'proposed'");
    const decide = body("decide_compass_workspace_action", "get_message_briefing_context");
    expect(decide).toContain("p_decision = 'reject'");
    expect(decide).toContain("p_decision <> 'confirm'");
    expect(decide).toContain("create_chapter_task_from_source");
    expect(decide).toContain("task_result #>> '{task,id}'");
  });

  it("revokes implicit PUBLIC execute from every browser RPC", () => {
    for (const signature of [
      "get_member_engagement_snapshot()", "get_staff_engagement_snapshot()",
      "get_message_briefing_context(text, uuid)", "persist_compass_message_briefing(text, uuid, text, jsonb)",
      "save_compass_workspace_preferences(jsonb, jsonb)", "save_organization_live_poll(jsonb)",
    ]) {
      expect(sql).toContain(`revoke all on function public.${signature} from public, anon, authenticated`);
      expect(sql).toContain(`grant execute on function public.${signature} to authenticated`);
    }
  });
});

describe("engagement controls and survey reminder tenant audit", () => {
  const auditSql = loadMigrationSql("20260924140400_engagement_controls_reminders_audit");
  const auditCode = stripComments(auditSql);
  const previousEventSql = loadMigrationSql("20260924100200_public_interest_lead_tenant_scoped_reads");
  const previousMetadataSql = loadMigrationSql("20260917140000_mi1_dues_oauth_callback_audit_metadata");

  it("is the last defining migration for both RPCs", () => {
    // 20261002021000 re-emits the reminder fan-out with the engagement email
    // opt-out filter and keeps this audit append verbatim; 20261030203001
    // (REQ-UG-SURVEY-AND-POLL-BUILDER-OPTIONS-20261030) re-emits it
    // again, refusing a survey past its close time. 20261117133000 (#9050)
    // re-emits it once more, letting Remind select a delivery that ended as
    // skipped_stale or skipped_survey_closed; the audit append is unchanged.
    expect(latestDefining("queue_organization_survey_reminders").file)
      .toBe("20261117133000_engagement_delivery_skip_stale_and_closed_survey.sql");
    expect(latestDefining("set_chapter_space_controls").file)
      .toBe("20260924140400_engagement_controls_reminders_audit.sql");
  });

  it("keeps the staff gate, empty search_path, and not-found errcodes", () => {
    for (const name of ["queue_organization_survey_reminders", "set_chapter_space_controls"]) {
      const { body: source } = latestDefining(name);
      const declaration = source.slice(0, source.indexOf("as $function$"));
      expect(declaration).toContain("security definer");
      expect(declaration).toContain("set search_path = ''");
      expect(source).toContain("private.engagement_require_staff(org)");
      expect(source).toContain("errcode = 'P0002'");
    }
    expect(latestDefining("set_chapter_space_controls").body).toContain("errcode = '22023'");
  });

  it("audits set_chapter_space_controls after the write with bounded control metadata", () => {
    const { body: source } = latestDefining("set_chapter_space_controls");
    const staffGate = source.indexOf("private.engagement_require_staff(org)");
    const write = source.indexOf("insert into public.chapter_space_controls");
    const audit = source.indexOf(AUDIT_WRITER);
    expect(staffGate).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(staffGate);
    expect(audit).toBeGreaterThan(write);
    const { call, metadata } = auditCall(source);
    expect(call).toContain("'chapter_space_controls_updated'");
    for (const key of ["organizationId", "spaceId", "userId", "postingMode", "slowModeSeconds", "approvalsRequired"]) {
      expect(metadata).toContain(`'${key}'`);
    }
    expect(metadata).not.toMatch(/recipient_user_id|p_title|full_text|new\.body/i);
    // A chapterless single-organization steward must not have the control
    // update itself rolled back by its own audit row.
    expect(source).not.toContain(CHAPTER_BOUND_AUDIT_WRITER);
  });

  it("audits queue_organization_survey_reminders after the write with a queued count", () => {
    const { body: source } = latestDefining("queue_organization_survey_reminders");
    const staffGate = source.indexOf("private.engagement_require_staff(org)");
    const write = source.indexOf("insert into public.engagement_delivery_outbox");
    const escalate = source.indexOf("escalation_state = 'reminder_due'");
    const audit = source.indexOf(AUDIT_WRITER);
    expect(staffGate).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(staffGate);
    expect(escalate).toBeGreaterThan(write);
    expect(audit).toBeGreaterThan(escalate);
    const { call, metadata } = auditCall(source);
    expect(call).toContain("'survey_reminders_queued'");
    for (const key of ["organizationId", "surveyId", "userId", "count"]) {
      expect(metadata).toContain(`'${key}'`);
    }
    expect(metadata).not.toMatch(/recipient_user_id|candidates\.recipient_user_id/i);
    // Same for the reminder fanout: the audit append shares the RPC's
    // transaction, so a writer bound to a different resolver would undo it.
    expect(source).not.toContain(CHAPTER_BOUND_AUDIT_WRITER);
  });

  it("admits the two event types and control metadata keys without dropping earlier vocabulary", () => {
    const eventTypes = (source) => listedTokens(
      source,
      /add constraint organization_audit_events_event_type_check check \(event_type in \(([\s\S]*?)\)\)/g,
    );
    const metadataKeys = (source) => listedTokens(
      source,
      /add constraint organization_audit_events_metadata_keys check \(\s*metadata - array\[([\s\S]*?)\]\s*=\s*'\{\}'::jsonb/g,
    );
    const eventsBefore = eventTypes(previousEventSql);
    const eventsAfter = eventTypes(auditSql);
    expect(eventsAfter.slice(0, eventsBefore.length)).toEqual(eventsBefore);
    expect(eventsAfter.slice(eventsBefore.length)).toEqual([
      // Carried from the sibling Stripe disconnect migration (PR #2448).
      "dues_stripe_disconnect_requested",
      "dues_stripe_disconnected",
      "dues_stripe_disconnect_attention",
      "chapter_space_controls_updated",
      "survey_reminders_queued",
    ]);
    const keysBefore = metadataKeys(previousMetadataSql);
    const keysAfter = metadataKeys(auditSql);
    expect(keysAfter.slice(0, keysBefore.length)).toEqual(keysBefore);
    expect(keysAfter.slice(keysBefore.length)).toEqual([
      "spaceId", "postingMode", "slowModeSeconds", "approvalsRequired",
    ]);
    expect(new Set(eventsAfter).size).toBe(eventsAfter.length);
    expect(new Set(keysAfter).size).toBe(keysAfter.length);
  });

  it("keeps authenticated-only execute and the case-graph lock wrapper", () => {
    expect(auditCode).toContain("revoke execute on function public.queue_organization_survey_reminders(uuid) from service_role");
    expect(auditCode).toContain("revoke execute on function public.set_chapter_space_controls(uuid, text, integer, boolean) from service_role");
    expect(auditCode).toContain("grant execute on function public.queue_organization_survey_reminders(uuid) to authenticated");
    expect(auditCode).toContain("grant execute on function public.set_chapter_space_controls(uuid, text, integer, boolean) to authenticated");
    for (const name of ["queue_organization_survey_reminders", "set_chapter_space_controls"]) {
      const { body: source } = latestDefining(name);
      expect(source).toMatch(
        /begin\s+perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);/,
      );
    }
  });
});

// BUG-UG-SURVEY-PUBLISH-NON-ATOMIC-20260920: publishing used to be two
// sequential RPCs, so a quarterly period collision or transient failure in the
// configure call stranded an unconfigured survey at status 'open' — already
// live to the membership — while the operator was told the save failed.
const atomicity = loadMigrationSql("survey_publish_atomicity").toLowerCase();

describe("survey publish atomicity migration", () => {
  it("commits the status transition and the operating configuration in one function body", () => {
    expect(atomicity).toContain("create function public.publish_organization_survey_with_operations(");
    const conflict = atomicity.indexOf("errcode = '23505'");
    expect(conflict).toBeGreaterThan(-1);
    // The quarterly period pre-check refuses the collision before any row
    // changes state, so a rejected publish leaves nothing behind.
    expect(conflict).toBeLessThan(atomicity.indexOf("insert into public.organization_surveys"));
    expect(conflict).toBeLessThan(atomicity.indexOf("update public.organization_surveys"));
    expect(atomicity).toContain("status = 'open'");
    expect(atomicity).toContain("cadence = next_cadence");
    expect(atomicity).toContain("period_key = next_period");
    expect(atomicity).toContain("operations_state = next_state");
    expect(atomicity).toContain("insert into public.organization_survey_tasks");
    expect(atomicity).toContain("on conflict (survey_id, reason) do update");
    // Publish refuses operations_state = 'draft' so an authenticated caller
    // cannot recreate an open survey with unfinished readiness.
    expect(atomicity).toContain("if next_state not in ('ready', 'distributing', 'reviewing', 'complete')");
    expect(atomicity).not.toContain("if next_state not in ('draft', 'ready', 'distributing', 'reviewing', 'complete')");
    expect(atomicity).toContain("nullif(p_operations ->> 'operationsstate', ''), 'ready'");
  });

  it("keeps the atomic publish behind the authenticated grant only", () => {
    expect(atomicity).toContain("revoke all on function public.publish_organization_survey_with_operations(jsonb, jsonb)");
    expect(atomicity).toContain("from public, anon, authenticated, service_role");
    expect(atomicity).toContain("grant execute on function public.publish_organization_survey_with_operations(jsonb, jsonb) to authenticated");
  });

  it("retires the non-atomic publisher so authenticated callers cannot open a survey without operations", () => {
    expect(atomicity).toContain("create or replace function public.publish_organization_survey(p_draft jsonb)");
    expect(atomicity).toContain("publish_organization_survey is retired");
    expect(atomicity).toContain("revoke all on function public.publish_organization_survey(jsonb)");
    expect(atomicity).not.toContain("grant execute on function public.publish_organization_survey(jsonb) to authenticated");
    const replaceAt = atomicity.indexOf("create or replace function public.publish_organization_survey(p_draft jsonb)");
    const revokeAt = atomicity.indexOf("revoke all on function public.publish_organization_survey(jsonb)");
    expect(replaceAt).toBeGreaterThan(-1);
    expect(revokeAt).toBeGreaterThan(replaceAt);
  });
});

const enforcementSql = loadMigrationSql("live_poll_chapter_scope_enforcement");
const enforcementBody = stripComments(fnBody(enforcementSql, "public.save_organization_live_poll"));

describe("live poll chapter scope enforcement migration", () => {
  it("requires a resolved same-organization chapter for the chapter scope", () => {
    expect(enforcementBody).toMatch(/as \$function\$\s+begin\s+perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\s+declare/);
    expect(enforcementBody).toContain("chapter scope requires a specific chapter");
    expect(enforcementBody).toContain("private.mi1_w2_same_org_chapter");
    expect(enforcementBody).toContain("coalesce(payload_chapter, private.current_member_chapter())");
    expect(enforcementBody).toContain("coalesce(payload_chapter, saved.chapter_id, private.current_member_chapter())");
    expect(enforcementBody).toContain("chapter is not in the selected organization");
    expect(enforcementBody).toContain("resolved_eligibility in ('organization', 'roster')");
    expect(enforcementBody).not.toContain("set chapter_id = chapter");
    expect(enforcementSql).toContain("Existing Chapter-scope rows with a null chapter");
    expect(enforcementSql).toContain("not backfill or narrow those rows");
    expect(enforcementSql).toContain("Editing a chapter-scoped");
  });

  it("exposes the selected organization's chapter catalogue on the staff snapshot", () => {
    const snapshotBody = stripComments(fnBody(enforcementSql, "public.get_staff_engagement_snapshot"));
    expect(snapshotBody).toContain("'chapters'");
    expect(snapshotBody).toContain("from public.chapters chapter");
    expect(snapshotBody).toContain("where chapter.organization_id = org");
    expect(snapshotBody).not.toContain("member.chapterId");
  });
});

const live = process.env.RUN_LIVE_POLL_CHAPTER_SCOPE_DB_TESTS === "1" && process.env.SUPABASE_DB_URL
  ? describe
  : describe.skip;

live("save_organization_live_poll chapter scope over a disposable database", () => {
  let client;
  const world = {};

  function connectionUrl() {
    const url = new URL(process.env.SUPABASE_DB_URL);
    expect(["localhost", "127.0.0.1"]).toContain(url.hostname);
    expect(Number(url.port)).toBeGreaterThanOrEqual(55000);
    expect(Number(url.port)).toBeLessThanOrEqual(59999);
    return url.toString();
  }

  async function actor(email, { aal = "aal2", chapter = world.chapterA } = {}) {
    const id = randomUUID();
    const session = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}-${email}`]);
    await client.query(
      "insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,$3,now(),now())",
      [session, id, aal],
    );
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapter]);
    await client.query(
      "insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing",
      [id, chapter],
    );
    await client.query(
      "insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing",
      [world.org, id],
    );
    await client.query(
      "insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())",
      [randomUUID(), id],
    );
    return { id, session, aal, chapter };
  }

  async function become(person) {
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      sub: person?.id ?? null,
      role: "authenticated",
      aal: person?.aal ?? "aal1",
      session_id: person?.session ?? null,
    })]);
    await client.query("set local role authenticated");
  }

  async function asPostgres() {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims','',true)");
  }

  async function savePoll(fields) {
    const payload = {
      title: fields.title || "Chapter vote",
      description: "Scope proof",
      eligibility: fields.eligibility,
      resultsVisibility: "after_close",
      options: [{ label: "Yes" }, { label: "No" }],
      ...(fields.id ? { id: fields.id } : {}),
      ...(Object.prototype.hasOwnProperty.call(fields, "chapterId") ? { chapterId: fields.chapterId } : {}),
    };
    return client.query("select public.save_organization_live_poll($1::jsonb) as saved", [JSON.stringify(payload)]);
  }

  async function attempt(work) {
    await client.query("savepoint poll_scope");
    try {
      const result = await work();
      await client.query("release savepoint poll_scope");
      return result;
    } catch (error) {
      await client.query("rollback to savepoint poll_scope");
      throw error;
    }
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: connectionUrl(),
      application_name: "live-poll-chapter-scope-proof",
    });
    await client.connect();
    await client.query("set statement_timeout = '30s'");
    await client.query("begin");

    world.org = randomUUID();
    world.foreignOrg = randomUUID();
    world.chapterA = `lpa-${world.org}`;
    world.chapterB = `lpb-${world.org}`;
    world.foreignChapter = `lpf-${world.foreignOrg}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [world.org, `lpo-${world.org}`]);
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [world.foreignOrg, `lpf-${world.foreignOrg}`]);
    await client.query(
      "insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9911)",
      [world.chapterA, world.org],
    );
    await client.query(
      "insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9912)",
      [world.chapterB, world.org],
    );
    await client.query(
      "insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9913)",
      [world.foreignChapter, world.foreignOrg],
    );

    world.staff = await actor("staff@example.invalid");
    await client.query(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'steward',$2)",
      [world.org, world.staff.id],
    );
    await client.query(
      "insert into public.member_roles(user_id,role,chapter_id) values ($1,'steward',$2)",
      [world.staff.id, world.chapterA],
    );

    world.memberA = await actor("member-a@example.invalid", { chapter: world.chapterA });
    world.memberB = await actor("member-b@example.invalid", { chapter: world.chapterB });
    world.chapterlessStaff = await actor("chapterless@example.invalid");
    await client.query(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'steward',$2)",
      [world.org, world.chapterlessStaff.id],
    );
    await client.query("update public.member_profiles set chapter_id = null where id = $1", [world.chapterlessStaff.id]);
    await client.query("delete from public.member_chapter_memberships where user_id = $1", [world.chapterlessStaff.id]);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("refuses a chapter-scope save that cannot resolve a chapter, and refuses a foreign chapter", async () => {
    await become(world.chapterlessStaff);
    await expect(attempt(() => savePoll({ eligibility: "chapter" }))).rejects.toMatchObject({
      code: "22023",
      message: expect.stringMatching(/chapter scope requires a specific chapter/i),
    });
    await asPostgres();

    await become(world.staff);
    await expect(attempt(() => savePoll({ eligibility: "chapter", chapterId: world.foreignChapter }))).rejects.toMatchObject({
      code: "42501",
      message: expect.stringMatching(/chapter is not in the selected organization/i),
    });
    await asPostgres();
  });

  it("persists a chapter, hides it from other chapters, and keeps it across an unchanged-scope edit", async () => {
    await become(world.staff);
    const inserted = await savePoll({ eligibility: "chapter", chapterId: world.chapterA, title: "Reach A only" });
    const pollId = inserted.rows[0].saved.id;
    expect(inserted.rows[0].saved.chapterId).toBe(world.chapterA);

    await savePoll({
      id: pollId,
      eligibility: "chapter",
      title: "Reach A only, edited",
    });
    await asPostgres();
    const preserved = await client.query("select chapter_id, title, eligibility from public.organization_live_polls where id = $1", [pollId]);
    expect(preserved.rows[0]).toMatchObject({
      chapter_id: world.chapterA,
      title: "Reach A only, edited",
      eligibility: "chapter",
    });

    await become(world.staff);
    await savePoll({
      id: pollId,
      eligibility: "organization",
      title: "Now organization-wide",
    });
    await asPostgres();
    const cleared = await client.query("select chapter_id, eligibility from public.organization_live_polls where id = $1", [pollId]);
    expect(cleared.rows[0]).toEqual({ chapter_id: null, eligibility: "organization" });

    await become(world.staff);
    const scoped = await savePoll({ eligibility: "chapter", chapterId: world.chapterA, title: "Open chapter vote" });
    const openId = scoped.rows[0].saved.id;
    await client.query("select public.transition_organization_live_poll($1, 'open')", [openId]);
    await asPostgres();

    const option = await client.query(
      "select id from public.organization_live_poll_options where poll_id = $1 order by sort_index limit 1",
      [openId],
    );

    await become(world.memberB);
    const outsider = await client.query("select public.get_member_engagement_snapshot() as snapshot");
    expect((outsider.rows[0].snapshot.livePolls || []).map((poll) => poll.id)).not.toContain(openId);
    await expect(attempt(() => client.query(
      "select public.cast_organization_live_poll_vote($1,$2)",
      [openId, option.rows[0].id],
    ))).rejects.toMatchObject({ message: expect.stringMatching(/poll is not open/i) });
    await asPostgres();

    await become(world.memberA);
    const insider = await client.query("select public.get_member_engagement_snapshot() as snapshot");
    expect((insider.rows[0].snapshot.livePolls || []).map((poll) => poll.id)).toContain(openId);
    await asPostgres();
  });

  it("clears chapter_id when a chapter-scoped draft is switched to roster", async () => {
    await become(world.staff);
    const inserted = await savePoll({ eligibility: "chapter", chapterId: world.chapterA, title: "Then roster" });
    const pollId = inserted.rows[0].saved.id;
    expect(inserted.rows[0].saved.chapterId).toBe(world.chapterA);
    await savePoll({ id: pollId, eligibility: "roster", title: "Now roster" });
    await asPostgres();
    const cleared = await client.query("select chapter_id, eligibility from public.organization_live_polls where id = $1", [pollId]);
    expect(cleared.rows[0]).toEqual({ chapter_id: null, eligibility: "roster" });
  });
});

// SEC-UG-ENGAGEMENT-AUDIT-EVENT-TAXONOMY-20260921 (part 1 of 2): the
// survey-side engagement writers each audit their own operation instead of
// 'survey_draft_saved', and the admin ledger projects the engagement event
// types into the communications domain.
describe("engagement audit event taxonomy (survey writers)", () => {
  const taxonomySql = loadMigrationSql("20260925120000_engagement_audit_event_taxonomy");
  const previousSql = loadMigrationSql("20260924140400_engagement_controls_reminders_audit");
  const WRITERS = {
    set_organization_survey_privacy_floor: "survey_privacy_floor_changed",
    configure_organization_survey_operations: "survey_operations_configured",
    publish_organization_survey_with_operations: "survey_operations_configured",
    update_organization_survey_task: "survey_task_updated",
    update_organization_survey_review: "survey_response_review_updated",
    save_organization_pulse_prompt: "pulse_prompt_saved",
  };

  // SEC-UG-SURVEY-REVIEW-PRIVACY-FLOOR-20261001 re-emits the review
  // writer once more (privacy-floor refusal); the gate, event type and actor
  // pins below still hold for it.
  const LATER_REEMITS = {
    update_organization_survey_review: "20261002015000_survey_review_privacy_floor_and_signin_throttle.sql",
  };

  it("re-emits each survey writer last, gate first, with its own event type and the actor", () => {
    for (const [name, eventType] of Object.entries(WRITERS)) {
      const { file, body: source } = latestDefining(name);
      expect(file, name).toBe(LATER_REEMITS[name] ?? "20260925120000_engagement_audit_event_taxonomy.sql");
      expect(source, name).toMatch(
        /as \$function\$\s*begin\s+(?:--[^\n]*\n\s*)*perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\s+declare/,
      );
      expect(source, name).toContain(`private.mi1_w2_write_audit(org, '${eventType}'`);
      expect(source, name).toContain("'userId', (select auth.uid())");
    }
  });

  it("leaves 'survey_draft_saved' only on the publisher's own draft save", () => {
    for (const name of Object.keys(WRITERS)) {
      const count = latestDefining(name).body.split("'survey_draft_saved'").length - 1;
      expect(count, name).toBe(name === "publish_organization_survey_with_operations" ? 1 : 0);
    }
    const publish = latestDefining("publish_organization_survey_with_operations").body;
    expect(publish.indexOf("'survey_draft_saved'")).toBeLessThan(publish.indexOf("'survey_published'"));
    expect(publish.indexOf("'survey_published'")).toBeLessThan(publish.indexOf("'survey_operations_configured'"));
  });

  it("appends the engagement event types and identifying keys without dropping earlier vocabulary", () => {
    const eventTypes = (source) => listedTokens(
      source,
      /add constraint organization_audit_events_event_type_check check \(event_type in \(([\s\S]*?)\)\)/g,
    );
    const metadataKeys = (source) => listedTokens(
      source,
      /add constraint organization_audit_events_metadata_keys check \(\s*metadata - array\[([\s\S]*?)\]\s*=\s*'\{\}'::jsonb/g,
    );
    const before = eventTypes(previousSql);
    const after = eventTypes(taxonomySql);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual([
      "survey_privacy_floor_changed", "survey_operations_configured",
      "survey_task_updated", "survey_response_review_updated",
      "pulse_prompt_saved", "weekly_question_reviewed",
      "weekly_question_policy_saved", "weekly_question_selection_run",
      "live_poll_saved", "live_poll_transitioned",
    ]);
    const keysBefore = metadataKeys(previousSql);
    const keysAfter = metadataKeys(taxonomySql);
    expect(keysAfter.slice(0, keysBefore.length)).toEqual(keysBefore);
    expect(keysAfter.slice(keysBefore.length)).toEqual(["taskId", "reviewId", "promptId", "pollId"]);
    expect(new Set(after).size).toBe(after.length);
    expect(new Set(keysAfter).size).toBe(keysAfter.length);
  });

  it("projects engagement events into communications in the admin ledger", () => {
    const { file, body: ledger } = latestDefining("list_organization_audit_ledger");
    expect(file).toBe("20260925120000_engagement_audit_event_taxonomy.sql");
    const domain = ledger.indexOf("then 'communications'");
    expect(domain).toBeGreaterThan(-1);
    expect(domain).toBeLessThan(ledger.indexOf("else 'administration'"));
    expect(ledger).toContain("when e.event_type like 'survey_%' or e.event_type like 'live_poll_%'");
    expect(ledger).toContain("or e.event_type like 'weekly_question_%' or e.event_type = 'pulse_prompt_saved' then 'communications'");
    expect(ledger).toContain(
      "when e.event_type in ('survey_privacy_floor_changed', 'survey_operations_configured', 'weekly_question_policy_saved') then 'settings_change'",
    );
    expect(ledger).toContain("private.mfa_satisfied()");
    expect(ledger).toContain("private.has_organization_role(org, array['admin'])");
  });
});

// SEC-UG-ENGAGEMENT-AUDIT-EVENT-TAXONOMY-20260921 (part 2 of 2): the
// weekly-question and live-poll writers, including the cron scheduler, audit
// their own operation, and no engagement writer is left on the fallback type.
describe("engagement audit event taxonomy (weekly-question and live-poll writers)", () => {
  const pollSql = loadMigrationSql("20260925170000_engagement_audit_poll_events");
  const WRITERS = {
    review_weekly_poll_question: "weekly_question_reviewed",
    save_weekly_question_selection_policy: "weekly_question_policy_saved",
    run_weekly_question_selection: "weekly_question_selection_run",
    save_organization_live_poll: "live_poll_saved",
    transition_organization_live_poll: "live_poll_transitioned",
  };

  // REQ-UG-WEEKLY-QUESTION-PRIORITY-AND-WEIGHTED-DRAW-20261001 re-emits the
  // policy save and the manual run (rule choice, priority slot, draw seed)
  // with the same gate, event type and actor.
  // REQ-UG-LEARNING-PERIOD-EVENTS-20261103 re-emits the two live-poll
  // writers with only a learning-period journal call; gate, event type and
  // actor are unchanged.
  const LATER_WRITER_FILES = {
    save_weekly_question_selection_policy: "20261002101000_weekly_question_draw_and_live_poll_schedule.sql",
    run_weekly_question_selection: "20261002101000_weekly_question_draw_and_live_poll_schedule.sql",
    save_organization_live_poll: "20261104110000_learning_period_events.sql",
    transition_organization_live_poll: "20261104110000_learning_period_events.sql",
  };

  it("re-emits each writer last, gate first, with its own event type and the actor", () => {
    for (const [name, eventType] of Object.entries(WRITERS)) {
      const { file, body: source } = latestDefining(name);
      expect(file, name).toBe(LATER_WRITER_FILES[name] ?? "20260925170000_engagement_audit_poll_events.sql");
      expect(source, name).toMatch(
        /as \$function\$\s*begin\s+perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\s+declare/,
      );
      expect(source, name).toContain(`private.mi1_w2_write_audit(org, '${eventType}'`);
      expect(source, name).toContain("'userId', (select auth.uid())");
      expect(source, name).not.toContain("'survey_draft_saved'");
    }
  });

  it("keeps the chapter-staff guard 20260925130200 installed on the weekly-question writers", () => {
    for (const [name, chapter] of [
      ["review_weekly_poll_question", "caller_chapter"],
      ["save_weekly_question_selection_policy", "chapter"],
      ["run_weekly_question_selection", "chapter"],
    ]) {
      const { body: source } = latestDefining(name);
      expect(source.split(`perform private.engagement_require_weekly_selection_staff(org, ${chapter});`).length - 1, name).toBe(1);
      expect(source, name).not.toContain("private.engagement_require_staff(org)");
    }
    for (const name of ["save_organization_live_poll", "transition_organization_live_poll"]) {
      expect(latestDefining(name).body, name).toContain("perform private.engagement_require_staff(org);");
    }
  });

  it("audits the scheduled selection under the policy author instead of a null actor", () => {
    const later = migrationFiles().filter(({ name, sql: text }) => name > "20260925170000_engagement_audit_poll_events.sql"
      && /function\s+private\.run_due_weekly_question_selections\s*\(/i.test(stripComments(text)));
    // The weighted-draw restore is the one later re-emit; it keeps this audit.
    expect(later.map(({ name }) => name)).toEqual(["20261002101000_weekly_question_draw_and_live_poll_schedule.sql"]);
    const source = stripComments(fnBody(later[0].sql, "private.run_due_weekly_question_selections"));
    expect(source).toMatch(/as \$function\$\s*begin\s+perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\s+declare/);
    expect(source).toContain("if target.updated_by is not null then");
    expect(source).toContain("target.organization_id, 'weekly_question_selection_run', target.updated_by,");
    expect(source).toContain("'reasonCode', 'scheduled'");
    expect(source).not.toContain("'survey_draft_saved'");
    expect(stripComments(pollSql)).toContain(
      "revoke all on function private.run_due_weekly_question_selections(integer) from public, anon, authenticated, service_role;",
    );
  });

  it("leaves no engagement writer on the draft-save type except the draft saves themselves", () => {
    const latest = readMigrationFunctions("supabase/migrations");
    const emitters = latest.filter((fn) => stripComments(fn.source).includes("'survey_draft_saved'"))
      .map((fn) => fn.name).sort();
    expect(emitters).toEqual([
      "public.publish_organization_survey_with_operations",
      "public.save_organization_survey_draft",
    ]);
  });
});
