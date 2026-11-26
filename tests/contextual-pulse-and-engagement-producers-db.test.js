// @vitest-environment node
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

// REQ-UG-CONTEXTUAL-PULSE-PRODUCT-TRIGGERS-20261001 (CR-014) and
// REQ-UG-ENGAGEMENT-SCORE-EVENT-PRODUCERS-20261001 (CR-039/CR-040).
// Only a live apply proves the reading-screen evaluator (switch, blocked
// screens, dwell OR scroll, once per session, cooldown, weekly target,
// sampling, tenant scope), the prompt event-key guard, the engagement event
// producers on every real member action (and their retraction, tenant scope
// and switch), and that the report card and staff workspace stop counting
// page views. Every case runs in one transaction that rolls back.
const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;

live("contextual pulse triggers and engagement event producers (live)", () => {
  let client;
  const world = {};

  async function actor(label, chapter, org, { mfa = true } = {}) {
    const id = randomUUID();
    const session = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}-${label}@example.invalid`]);
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, id]);
    await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id, chapter, `Proof ${label}`]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, chapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [org, id]);
    if (mfa) await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    return { id, session };
  }

  async function grantRole(person, role, chapter, org) {
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [person.id, role, chapter]);
    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [person.id, role, chapter]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [org, person.id, role]);
  }

  async function as(person, sql, params = [], role = "authenticated") {
    await client.query("savepoint proof");
    try {
      await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(person
        ? { sub: person.id, role, aal: "aal2", session_id: person.session }
        : { role })]);
      await client.query(`set local role ${role}`);
      const { rows } = await client.query(sql, params);
      await client.query("reset role");
      await client.query("release savepoint proof");
      return { value: rows[0]?.value };
    } catch (error) {
      await client.query("rollback to savepoint proof");
      await client.query("reset role");
      return { code: error.code, message: error.message };
    }
  }

  async function sql(text, params = []) {
    await client.query("savepoint direct");
    try {
      const result = await client.query(text, params);
      await client.query("release savepoint direct");
      return { rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint direct");
      return { code: error.code, message: error.message };
    }
  }

  async function setting(org, key, value) {
    await client.query(
      `insert into public.organization_setting_values(organization_id, setting_key, value)
       values ($1, $2, $3::jsonb)
       on conflict (organization_id, setting_key) do update set value = excluded.value`,
      [org, key, JSON.stringify(value)],
    );
  }

  const evaluate = (person, context, session, dwell, scroll) => as(person,
    "select public.evaluate_contextual_pulse_in_context($1, $2::uuid, $3, $4) as value", [context, session, dwell, scroll]);

  async function events(user, type = null) {
    const { rows } = await client.query(
      `select event_type, source_id, chapter_id, organization_id from public.organization_engagement_events
       where user_id = $1 and event_type <> 'page_view' and ($2::text is null or event_type = $2) order by event_type, source_id`,
      [user.id, type],
    );
    return rows;
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "contextual-pulse-engagement-producers-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");
    for (const key of ["A", "B"]) {
      world[`org${key}`] = randomUUID();
      world[`chapter${key}`] = `l2-${key.toLowerCase()}-${world[`org${key}`].slice(0, 8)}`;
      await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [world[`org${key}`], world[`chapter${key}`]]);
      await client.query(
        "insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,$3)",
        [world[`chapter${key}`], world[`org${key}`], key === "A" ? 98211 : 98212],
      );
    }
    world.member = await actor("member", world.chapterA, world.orgA);
    world.second = await actor("second", world.chapterA, world.orgA);
    world.steward = await actor("steward", world.chapterA, world.orgA);
    await grantRole(world.steward, "steward", world.chapterA, world.orgA);
    //  round 1: committed data gives every steward grant its migration carry-over; the analytics roster follows it.
    await migrateLegacyStewardFixtures(client);
    world.outsider = await actor("outsider", world.chapterB, world.orgB);
    world.prompt = randomUUID();
    await client.query(
      `insert into public.organization_pulse_prompts(id, organization_id, event_key, question, options, cooldown_hours)
       values ($1, $2, 'contract.page', 'Was this clause clear?', '["Yes","No"]'::jsonb, 24)`,
      [world.prompt, world.orgA],
    );
    // Sampling is deterministic; prove the paths with everyone sampled in.
    await setting(world.orgA, "limits.engagement_voice.pulse_sampling_percent", 100);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("registers the six definitions with their defaults (D6 turns quick checks on) and no organization values", async () => {
    const { rows } = await client.query(
      `select key, default_value, category, member_visible from public.platform_setting_definitions
       where key in ('features.engagement_voice.contextual_pulses', 'limits.engagement_voice.pulse_dwell_seconds',
         'limits.engagement_voice.pulse_scroll_percent', 'limits.engagement_voice.pulse_weekly_target',
         'limits.engagement_voice.pulse_sampling_percent', 'features.analytics.engagement_event_producers')
       order by key`,
    );
    expect(rows.map((row) => [row.key, row.default_value, row.category, row.member_visible])).toEqual([
      ["features.analytics.engagement_event_producers", true, "analytics", false],
      // Default ON by (2026-10-02); the old app default was off.
      ["features.engagement_voice.contextual_pulses", true, "engagement_voice", true],
      ["limits.engagement_voice.pulse_dwell_seconds", 20, "engagement_voice", true],
      ["limits.engagement_voice.pulse_sampling_percent", 35, "engagement_voice", false],
      ["limits.engagement_voice.pulse_scroll_percent", 50, "engagement_voice", true],
      ["limits.engagement_voice.pulse_weekly_target", 40, "engagement_voice", false],
    ]);
    const switches = await as(world.member, "select public.get_member_organization_configuration() -> 'switches' as value");
    expect(switches.value["features.engagement_voice.contextual_pulses"]).toBe(true);
    expect(switches.value["limits.engagement_voice.pulse_dwell_seconds"]).toBe(20);
    expect(switches.value).not.toHaveProperty("limits.engagement_voice.pulse_weekly_target");
  });

  it("asks nothing while the organization switch is off and refuses blocked or unknown screens", async () => {
    await setting(world.orgA, "features.engagement_voice.contextual_pulses", false);
    const session = randomUUID();
    expect(await evaluate(world.member, "contract.page", session, 60, 100)).toEqual({ value: { eligible: false, reason: "disabled" } });
    expect(await evaluate(world.member, "grievance.filing", session, 60, 100)).toEqual({ value: { eligible: false, reason: "blocked_context" } });
    expect((await evaluate(world.member, "case.anything", session, 60, 100)).code).toBe("22023");
    expect((await evaluate(world.member, "voice.open", session, 60, 100)).code).toBe("22023");
    expect((await evaluate(world.member, "contract.page", null, 60, 100)).code).toBe("22023");
    expect((await evaluate(world.member, "contract.page", session, 60, 101)).code).toBe("22023");
    expect((await evaluate(null, "contract.page", session, 60, 100)).code).toBe("42501");
    const anon = await as(null, "select public.evaluate_contextual_pulse_in_context('contract.page', gen_random_uuid(), 60, 100) as value", [], "anon");
    expect(anon.code).toBe("42501");
    const { rows } = await client.query("select count(*)::int as n from public.organization_pulse_events where prompt_id = $1", [world.prompt]);
    expect(rows[0].n).toBe(0);
  });

  it("asks after the dwell OR scroll threshold, once per session, then honors the cooldown", async () => {
    await setting(world.orgA, "features.engagement_voice.contextual_pulses", true);
    const session = randomUUID();
    expect(await evaluate(world.member, "contract.page", session, 19, 49)).toEqual({ value: { eligible: false, reason: "engagement_not_met" } });
    const shown = await evaluate(world.member, "contract.page", session, 3, 50);
    expect(shown.value).toMatchObject({ eligible: true, promptId: world.prompt, question: "Was this clause clear?", options: ["Yes", "No"], contextKey: "contract.page" });
    const { rows: [row] } = await client.query("select context_key, session_key, state from public.organization_pulse_events where id = $1", [shown.value.eventId]);
    expect(row).toEqual({ context_key: `contract.page:${session}`, session_key: session, state: "shown" });
    expect(await evaluate(world.member, "contract.page", session, 60, 100)).toEqual({ value: { eligible: false, reason: "session_already_used" } });
    expect(await evaluate(world.member, "contract.page", randomUUID(), 60, 100)).toEqual({ value: { eligible: false, reason: "cooldown_active" } });
    const answered = await as(world.member, "select public.respond_contextual_pulse($1::uuid, '\"Yes\"'::jsonb, false) as value", [shown.value.eventId]);
    expect(answered.value).toEqual({ eventId: shown.value.eventId, state: "responded" });
    // Another organization's member never sees organization A's prompt.
    await setting(world.orgB, "features.engagement_voice.contextual_pulses", true);
    expect(await evaluate(world.outsider, "contract.page", randomUUID(), 60, 100)).toEqual({ value: { eligible: false, reason: "no_matching_prompt" } });
  });

  it("stops at the weekly response target and samples members deterministically per week", async () => {
    await setting(world.orgA, "limits.engagement_voice.pulse_weekly_target", 1);
    expect(await evaluate(world.second, "contract.page", randomUUID(), 60, 100)).toEqual({ value: { eligible: false, reason: "target_reached" } });
    await setting(world.orgA, "limits.engagement_voice.pulse_weekly_target", 40);
    await setting(world.orgA, "limits.engagement_voice.pulse_sampling_percent", 1);
    const { rows: [{ bucket }] } = await client.query(
      "select ((pg_catalog.hashtextextended($1::text || ':' || $2::text || ':' || pg_catalog.to_char(pg_catalog.now(), 'IYYY-\"W\"IW'), 0) % 100) + 100) % 100 as bucket",
      [world.second.id, world.prompt],
    );
    const sampled = await evaluate(world.second, "contract.page", randomUUID(), 60, 100);
    if (Number(bucket) >= 1) expect(sampled).toEqual({ value: { eligible: false, reason: "sampled_out" } });
    else expect(sampled.value.eligible).toBe(true);
    await setting(world.orgA, "limits.engagement_voice.pulse_sampling_percent", 100);
  });

  it("limits prompts to registered low-risk screens without touching legacy rows", async () => {
    const refused = await sql(
      "insert into public.organization_pulse_prompts(organization_id, event_key, question, options) values ($1, 'grievance.filing', 'Q?', '[\"a\",\"b\"]'::jsonb)",
      [world.orgA],
    );
    expect(refused.code).toBe("22023");
    expect((await sql(
      "insert into public.organization_pulse_prompts(organization_id, event_key, question, options) values ($1, 'made.up', 'Q?', '[\"a\",\"b\"]'::jsonb)",
      [world.orgA],
    )).code).toBe("22023");
    const saved = await as(world.steward, "select public.save_organization_pulse_prompt($1::jsonb) as value",
      [JSON.stringify({ eventKey: "rights.page", question: "Did this help?", options: ["Yes", "No"] })]);
    expect(saved.value).toMatchObject({ eventKey: "rights.page" });
    await client.query("alter table public.organization_pulse_prompts disable trigger organization_pulse_prompts_event_key_guard");
    const legacy = randomUUID();
    await client.query(
      "insert into public.organization_pulse_prompts(id, organization_id, event_key, question, options) values ($1, $2, 'case.updated', 'Old?', '[\"a\",\"b\"]'::jsonb)",
      [legacy, world.orgA],
    );
    await client.query("alter table public.organization_pulse_prompts enable trigger organization_pulse_prompts_event_key_guard");
    expect((await sql("update public.organization_pulse_prompts set question = 'Still old?', active = false where id = $1", [legacy])).code).toBeUndefined();
    expect((await sql("update public.organization_pulse_prompts set event_key = 'account.recovery' where id = $1", [legacy])).code).toBe("22023");
    expect((await sql("update public.organization_pulse_prompts set event_key = 'qa.detail' where id = $1", [legacy])).code).toBeUndefined();
  });

  it("records one event per real member action, tenant-scoped, and retracts withdrawn ones", async () => {
    const m = world.member;
    // Ballot vote.
    const ballot = `l2-ballot-${randomUUID().slice(0, 8)}`;
    await client.query("insert into public.member_ballots(id,title,closes_at,order_index,organization_id,chapter_id,campaign_state,active) values ($1,'Proof ballot',now()+interval '1 day',982110,$2,$3,'open',true)", [ballot, world.orgA, world.chapterA]);
    await client.query("insert into public.member_ballot_options(id,ballot_id,label,order_index) values ($1,$2,'Yes',0)", [`${ballot}-yes`, ballot]);
    await client.query("insert into public.member_ballot_votes(ballot_id,option_id,user_id) values ($1,$2,$3)", [ballot, `${ballot}-yes`, m.id]);
    // An outsider's vote on organization A's ballot is not organization A participation.
    await client.query("insert into public.member_ballot_votes(ballot_id,option_id,user_id) values ($1,$2,$3)", [ballot, `${ballot}-yes`, world.outsider.id]);
    // Live poll vote, RSVP and check-in.
    const poll = randomUUID();
    await client.query("insert into public.organization_live_polls(id,organization_id,chapter_id,title,state) values ($1,$2,$3,'Proof poll','open')", [poll, world.orgA, world.chapterA]);
    const option = randomUUID();
    await client.query("insert into public.organization_live_poll_options(id,organization_id,poll_id,label,sort_index) values ($1,$2,$3,'Aye',0)", [option, world.orgA, poll]);
    await client.query("insert into public.organization_live_poll_votes(organization_id,poll_id,option_id,voter_user_id) values ($1,$2,$3,$4)", [world.orgA, poll, option, m.id]);
    await client.query("insert into public.organization_live_poll_attendance(organization_id,poll_id,user_id,rsvp) values ($1,$2,$3,'pending')", [world.orgA, poll, m.id]);
    await client.query("update public.organization_live_poll_attendance set rsvp='yes', checked_in_at=now() where poll_id=$1 and user_id=$2", [poll, m.id]);
    // Channel poll vote.
    const space = randomUUID();
    await client.query("insert into public.chapter_spaces(id,chapter_id,name,created_by) values ($1,$2,'Proof space',$3)", [space, world.chapterA, world.steward.id]);
    const channelPoll = randomUUID();
    await client.query("insert into public.chapter_channel_polls(id,space_id,chapter_id,question,created_by) values ($1,$2,$3,'Proof?',$4)", [channelPoll, space, world.chapterA, world.steward.id]);
    const channelOption = randomUUID();
    await client.query("insert into public.chapter_channel_poll_options(id,poll_id,label,position) values ($1,$2,'Yes',0)", [channelOption, channelPoll]);
    await client.query("insert into public.chapter_channel_poll_votes(poll_id,option_id,user_id) values ($1,$2,$3)", [channelPoll, channelOption, m.id]);
    // Event RSVP and check-in.
    const event = `l2-event-${randomUUID().slice(0, 8)}`;
    await client.query("insert into public.member_events(id,title,starts_at,location,summary,check_in_code,order_index,chapter_id) values ($1,'Proof meeting',now(),'Hall','Proof','SG-L2PROOF',982111,$2)", [event, world.chapterA]);
    await client.query("insert into public.member_event_rsvps(event_id,user_id,status) values ($1,$2,'going')", [event, m.id]);
    await client.query("insert into public.member_event_checkins(event_id,user_id) values ($1,$2)", [event, m.id]);
    // Survey submission.
    const survey = randomUUID();
    await client.query("insert into public.organization_surveys(id,organization_id,title,status) values ($1,$2,'Proof survey','open')", [survey, world.orgA]);
    const surveySession = randomUUID();
    await client.query("insert into public.organization_survey_sessions(id,organization_id,survey_id,respondent_user_id) values ($1,$2,$3,$4)", [surveySession, world.orgA, survey, m.id]);
    expect(await events(m, "survey_response")).toEqual([]);
    await client.query("update public.organization_survey_sessions set status='submitted', submitted_at=now() where id=$1", [surveySession]);
    // Q&A question and reply.
    const question = randomUUID();
    await client.query("insert into public.member_qa_questions(id,organization_id,chapter_id,author_user_id,title,body) values ($1,$2,$3,$4,'Proof question title','A proof question body.')", [question, world.orgA, world.chapterA, m.id]);
    const reply = randomUUID();
    await client.query("insert into public.member_qa_replies(id,organization_id,question_id,author_user_id,kind,body) values ($1,$2,$3,$4,'follow_up','A proof follow-up body.')", [reply, world.orgA, question, m.id]);
    // Steward contact log: a member contact counts for the contacted member; a management contact does not.
    const contact = randomUUID();
    await client.query(
      "insert into public.chapter_contact_log(id,organization_id,chapter_id,subject_user_id,contact_kind,channel,purpose,summary,occurred_at,created_by) values ($1,$2,$3,$4,'member','phone','Check-in','Called the member.',now(),$5)",
      [contact, world.orgA, world.chapterA, m.id, world.steward.id],
    );
    await client.query(
      "insert into public.chapter_contact_log(organization_id,chapter_id,subject_user_id,contact_kind,channel,purpose,summary,occurred_at,created_by) values ($1,$2,$3,'management','meeting','Labor-management','Met management.',now(),$4)",
      [world.orgA, world.chapterA, m.id, world.steward.id],
    );

    expect(await events(m)).toEqual([
      { event_type: "authorized_contact", source_id: `contact:${contact}`, chapter_id: world.chapterA, organization_id: world.orgA },
      { event_type: "event_rsvp", source_id: `event:${event}`, chapter_id: world.chapterA, organization_id: world.orgA },
      { event_type: "event_rsvp", source_id: `live-poll:${poll}`, chapter_id: world.chapterA, organization_id: world.orgA },
      { event_type: "meeting_check_in", source_id: `event:${event}`, chapter_id: world.chapterA, organization_id: world.orgA },
      { event_type: "meeting_check_in", source_id: `live-poll:${poll}`, chapter_id: world.chapterA, organization_id: world.orgA },
      { event_type: "poll_vote", source_id: `ballot:${ballot}`, chapter_id: world.chapterA, organization_id: world.orgA },
      { event_type: "poll_vote", source_id: `channel-poll:${channelPoll}`, chapter_id: world.chapterA, organization_id: world.orgA },
      { event_type: "poll_vote", source_id: `live-poll:${poll}`, chapter_id: world.chapterA, organization_id: world.orgA },
      { event_type: "qa_contribution", source_id: `qa-question:${question}`, chapter_id: world.chapterA, organization_id: world.orgA },
      { event_type: "qa_contribution", source_id: `qa-reply:${reply}`, chapter_id: world.chapterA, organization_id: world.orgA },
      { event_type: "survey_response", source_id: `survey:${survey}`, chapter_id: world.chapterA, organization_id: world.orgA },
    ]);
    expect(await events(world.outsider)).toEqual([]);

    // Idempotent: replaying a write records nothing new.
    await client.query("update public.member_event_rsvps set status='going' where event_id=$1 and user_id=$2", [event, m.id]);
    expect(await events(m, "event_rsvp")).toHaveLength(2);

    // Withdrawals retract.
    await client.query("update public.member_event_rsvps set status='not_going' where event_id=$1 and user_id=$2", [event, m.id]);
    await client.query("update public.member_qa_replies set deleted_at=now() where id=$1", [reply]);
    await client.query("update public.chapter_contact_log set archived_at=now() where id=$1", [contact]);
    await client.query("delete from public.chapter_channel_poll_votes where poll_id=$1 and user_id=$2", [channelPoll, m.id]);
    await client.query("update public.organization_live_poll_attendance set rsvp='no' where poll_id=$1 and user_id=$2", [poll, m.id]);
    const after = (await events(m)).map((row) => `${row.event_type}|${row.source_id}`);
    expect(after).not.toContain(`event_rsvp|event:${event}`);
    expect(after).not.toContain(`event_rsvp|live-poll:${poll}`);
    expect(after).not.toContain(`qa_contribution|qa-reply:${reply}`);
    expect(after).not.toContain(`authorized_contact|contact:${contact}`);
    expect(after).not.toContain(`poll_vote|channel-poll:${channelPoll}`);
    expect(after).toContain(`meeting_check_in|live-poll:${poll}`);
  });

  it("records nothing while an organization turns the producers off", async () => {
    await setting(world.orgA, "features.analytics.engagement_event_producers", false);
    const question = randomUUID();
    await client.query("insert into public.member_qa_questions(id,organization_id,chapter_id,author_user_id,title,body) values ($1,$2,$3,$4,'Switch-off question','Asked while producers are off.')", [question, world.orgA, world.chapterA, world.second.id]);
    expect(await events(world.second)).toEqual([]);
    await setting(world.orgA, "features.analytics.engagement_event_producers", true);
  });

  it("stops counting page views as protected activities on the report card and the staff workspace", async () => {
    const viewer = await actor("viewer", world.chapterA, world.orgA);
    await client.query(
      "insert into public.organization_engagement_events(organization_id,user_id,chapter_id,event_type,source_id) select $1,$2,$3,'page_view','/m|' || n from generate_series(1,12) n",
      [world.orgA, viewer.id, world.chapterA],
    );
    expect((await as(viewer, "select public.get_my_analytics_report_card() as value")).value).toMatchObject({ overall: null, signals: [] });
    const card = (await as(world.member, "select public.get_my_analytics_report_card() as value")).value;
    expect(card.signals[0]).toEqual({ label: "Protected activities (180 days)", value: (await events(world.member)).length });
    expect(card.participation).toBe(Math.min(100, (await events(world.member)).length * 10));
    const workspace = (await as(world.steward, "select public.get_organization_analytics_workspace() as value")).value;
    const viewerRow = workspace.members.find((row) => row.id === `${viewer.id}:${world.chapterA}`);
    expect(viewerRow).toMatchObject({ participationScore: 0, attention: "support", lastActivityAt: null });
  });

  it("keeps the account lifecycle trigger inventory complete", async () => {
    const { rows } = await client.query("select count(*)::int as n from private.account_lifecycle_referential_action_trigger_issues()");
    expect(rows[0].n).toBe(0);
    // The full lifecycle trigger review takes about 11 s on a migrated stack.
  }, 120_000);
});
