// @vitest-environment node
// D1 (owner decision, 2026-10-15): deleting an account that authored Union
// Ground campaign evidence succeeds, keeps the campaign's history without the
// person's identity, and removes the worker's own lifecycle records. Every
// case runs in one rolled-back transaction against the owned disposable stack.
import pg from "pg";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.RUN_ACCOUNT_LIFECYCLE_DB_TESTS === "1" ? describe : describe.skip;

const id = (n) => `50915000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = {
  organization: id(1),
  organizer: id(2),
  worker: id(3),
  lead: id(4),
  employer: id(11),
  worksite: id(12),
  campaign: id(13),
  supportRow: id(14),
  incident: id(15),
  partner: id(16),
  handshake: id(17),
  cycle: id(18),
  article: id(19),
  agreement: id(20),
  ratification: id(21),
  correctedRatification: id(22),
  period: id(30),
  session: id(31),
  assignment: id(32),
  commitment: id(33),
  completion: id(34),
  receipt: id(35),
  workerSession: id(36),
};
const chapter = "psg-lifecycle-proof";
// Union Ground's lifecycle tables with a direct auth.users key
// (20261014001000-009000).
const LIFECYCLE_TABLES = [
  "coalition_commitments", "coalition_handshakes", "coalition_partners", "member_capacity_commitments",
  "member_learning_assignments", "member_learning_sessions", "member_membership_periods", "member_onboarding_steps",
  "member_participation_completions", "member_participation_events", "member_recognition_events",
  "member_recognition_week_totals", "organizing_bargaining_cycles", "organizing_bargaining_proposals",
  "organizing_bargaining_ratification_corrections", "organizing_bargaining_ratifications", "organizing_bargaining_sessions",
  "organizing_campaign_assignments", "organizing_campaigns", "organizing_contact_events", "organizing_first_contracts",
  "organizing_resistance_evidence", "organizing_resistance_incidents", "organizing_stage_events", "organizing_workers",
  "union_employers", "union_lifecycle_audit_events", "union_worksites",
];
const sha = (c) => c.repeat(64);

async function seed(client) {
  const { organization, organizer: G, worker: W, lead: S } = ids;
  const q = (sql, values = []) => client.query(sql, values);
  await q("insert into public.organizations (id, slug, name) values ($1, 'psg-lifecycle-proof-org', 'Lifecycle Proof Campaign Org')", [organization]);
  await q("insert into public.chapters (id, name, region, order_index, organization_id, slug) values ($1, 'Lifecycle Proof Campaign', 'Local proof', 915, $2, $1)", [chapter, organization]);
  await q("insert into auth.users (id, email) values ($1, 'psg-organizer@example.invalid'), ($2, 'psg-worker@example.invalid'), ($3, 'psg-lead@example.invalid')", [G, W, S]);
  await q("insert into public.organization_memberships (organization_id, user_id) select $1, unnest($2::uuid[])", [organization, [G, W, S]]);
  await q("insert into public.member_chapter_memberships (user_id, chapter_id) select unnest($1::uuid[]), $2", [[G, W, S], chapter]);
  await q("update public.member_profiles set chapter_id = $2 where id = any($1::uuid[])", [[G, W, S], chapter]);

  // Shared campaign records, all authored or assigned by the organizer.
  await q("insert into public.union_employers (id, chapter_id, legal_name, display_name, created_by) values ($1, $2, 'Proof Employer LLC', 'Proof Employer', $3)", [ids.employer, chapter, G]);
  await q("insert into public.union_worksites (id, chapter_id, employer_id, name, created_by) values ($1, $2, $3, 'Proof Worksite', $4)", [ids.worksite, chapter, ids.employer, G]);
  await q(`insert into public.organizing_campaigns (id, chapter_id, employer_id, primary_worksite_id, name, proposed_unit, owner_id, next_action_owner_id, create_request_id, created_by)
    values ($1, $2, $3, $4, 'Proof campaign', 'All proof workers', $5, $5, extensions.gen_random_uuid(), $5)`, [ids.campaign, chapter, ids.employer, ids.worksite, G]);
  await q(`insert into public.organizing_campaign_assignments (campaign_id, chapter_id, user_id, assignment_role, granted_by)
    values ($1, $2, $3, 'organizer', $4), ($1, $2, $4, 'lead_organizer', $5)`, [ids.campaign, chapter, W, G, S]);
  await q("insert into public.organizing_stage_events (campaign_id, chapter_id, from_stage, to_stage, actor_id) values ($1, $2, 'lead', 'committee', $3)", [ids.campaign, chapter, G]);
  await q("insert into public.organizing_workers (id, campaign_id, chapter_id, private_alias, support_position, assigned_to, created_by) values ($1, $2, $3, 'Proof alias', 'supporter', $4, $4)", [ids.supportRow, ids.campaign, chapter, G]);
  await q("insert into public.organizing_contact_events (worker_id, actor_id, channel, outcome, occurred_at) values ($1, $2, 'in_person', 'completed', now())", [ids.supportRow, G]);
  await q(`insert into public.organizing_resistance_incidents (id, campaign_id, chapter_id, reference, title, category, factual_summary, source_kind, owner_id, created_by, create_request_id)
    values ($1, $2, $3, 'PSG-PROOF-1', 'Proof captive meeting', 'captive_audience', 'Proof summary', 'organizer_note', $4, $4, extensions.gen_random_uuid())`, [ids.incident, ids.campaign, chapter, G]);
  await q("insert into public.organizing_resistance_evidence (incident_id, evidence_type, title, uploaded_by) values ($1, 'document', 'Proof flyer', $2)", [ids.incident, G]);
  await q("insert into public.coalition_partners (id, chapter_id, name, organization_type, created_by) values ($1, $2, 'Proof tenants council', 'community', $3)", [ids.partner, chapter, G]);
  await q("insert into public.coalition_handshakes (id, chapter_id, partner_id, shared_interest, bridge_lead_id, created_by) values ($1, $2, $3, 'Safe staffing proof', $4, $4)", [ids.handshake, chapter, ids.partner, G]);
  await q("insert into public.coalition_commitments (handshake_id, title, owner_side, created_by) values ($1, 'Proof joint letter', 'joint', $2)", [ids.handshake, G]);
  await q("insert into public.union_lifecycle_audit_events (chapter_id, campaign_id, actor_id, event_type, entity_type, entity_id) values ($1, $2, $3, 'proof.event', 'organizing_campaign', $2)", [chapter, ids.campaign, G]);

  // First-contract bargaining and its append-only external evidence.
  await q("insert into public.organizing_bargaining_cycles (id, campaign_id, chapter_id, title, lead_id, created_by) values ($1, $2, $3, 'Proof first contract', $4, $4)", [ids.cycle, ids.campaign, chapter, G]);
  await q(`insert into public.organizing_bargaining_proposals (id, cycle_id, campaign_id, chapter_id, topic, title, side, created_by, create_request_id)
    values ($1, $2, $3, $4, 'scheduling', 'Proof article', 'union', $5, extensions.gen_random_uuid())`, [ids.article, ids.cycle, ids.campaign, chapter, G]);
  await q(`insert into public.organizing_bargaining_proposals (id, cycle_id, campaign_id, chapter_id, topic, title, side, created_by, create_request_id, record_kind, included_proposal_ids, document_sha256, status)
    values ($1, $2, $3, $4, 'agreement', 'Proof agreement', 'joint', $5, extensions.gen_random_uuid(), 'agreement_package', array[$6]::uuid[], $7, 'tentative_agreement')`, [ids.agreement, ids.cycle, ids.campaign, chapter, G, ids.article, sha("a")]);
  await q("insert into public.organizing_bargaining_sessions (cycle_id, campaign_id, chapter_id, session_number, starts_at, created_by, create_request_id) values ($1, $2, $3, 1, now(), $4, extensions.gen_random_uuid())", [ids.cycle, ids.campaign, chapter, G]);
  for (const [ratification, reference, source] of [[ids.ratification, "Proof bylaws", sha("b")], [ids.correctedRatification, "Proof bylaws duplicate", sha("c")]]) {
    await q(`insert into public.organizing_bargaining_ratifications (id, cycle_id, campaign_id, chapter_id, agreement_proposal_id, agreement_sha256, decision_method, held_on, source_reported_outcome, computed_outcome, source_kind, source_reference, source_sha256, rule_summary, eligibility_source, recorded_by, create_request_id)
      values ($1, $2, $3, $4, $5, $6, 'not_required', current_date, 'not_required', 'not_required', 'written_rule', $7, $8, 'No vote required by proof rule', 'Proof roster', $9, extensions.gen_random_uuid())`,
    [ratification, ids.cycle, ids.campaign, chapter, ids.agreement, sha("a"), reference, source, G]);
  }
  await q(`insert into public.organizing_bargaining_ratification_corrections (ratification_id, cycle_id, campaign_id, chapter_id, reason_code, source_kind, source_reference, source_sha256, corrected_by, create_request_id)
    values ($1, $2, $3, $4, 'duplicate_record', 'written_rule', 'Proof duplicate', $5, $6, extensions.gen_random_uuid())`, [ids.correctedRatification, ids.cycle, ids.campaign, chapter, sha("d"), G]);
  await q(`insert into public.organizing_first_contracts (cycle_id, campaign_id, chapter_id, ratification_id, agreement_proposal_id, agreement_sha256, signed_on, source_kind, source_reference, source_sha256, expected_signatory_count, verified_signatory_count, recorded_by, create_request_id)
    values ($1, $2, $3, $4, $5, $6, current_date, 'executed_contract', 'Proof signed contract', $7, 2, 2, $8, extensions.gen_random_uuid())`, [ids.cycle, ids.campaign, chapter, ids.ratification, ids.agreement, sha("a"), sha("e"), G]);

  // The worker's own records, verified or offered by the organizer.
  await q("insert into public.member_membership_periods (id, user_id, chapter_id, joined_on, status, source_kind, verified_by, verified_at) values ($1, $2, $3, current_date, 'active', 'staff_verified', $4, now())", [ids.period, W, chapter, G]);
  await q("insert into public.member_onboarding_steps (membership_period_id, user_id, chapter_id, step_key, status, completed_at, verified_by) values ($1, $2, $3, 'welcome', 'completed', now(), $4)", [ids.period, W, chapter, G]);
  await q("insert into public.member_learning_sessions (id, chapter_id, learning_kind, title, starts_at, ends_at, created_by, request_id) values ($1, $2, 'training', 'Proof training', now() - interval '2 hours', now() - interval '1 hour', $3, extensions.gen_random_uuid())", [ids.session, chapter, G]);
  await q(`insert into public.member_learning_assignments (id, session_id, user_id, chapter_id, learning_kind, status, assigned_by, request_id, responded_at, completion_request_id, completed_at, verified_by, verified_at)
    values ($1, $2, $3, $4, 'training', 'completed', $5, extensions.gen_random_uuid(), now() - interval '3 hours', extensions.gen_random_uuid(), now() - interval '1 hour', $5, now() - interval '30 minutes')`, [ids.assignment, ids.session, W, chapter, G]);
  await q(`insert into public.member_capacity_commitments (id, user_id, chapter_id, commitment_kind, title, status, offered_by, request_id, responded_at, started_at, completion_request_id, completed_at, verified_by, verified_at)
    values ($1, $2, $3, 'voluntary', 'Proof flyer drop', 'completed', $4, extensions.gen_random_uuid(), now() - interval '3 hours', now() - interval '2 hours', extensions.gen_random_uuid(), now() - interval '1 hour', $5, now() - interval '30 minutes')`, [ids.commitment, W, chapter, S, G]);
  await q(`insert into public.member_participation_completions (id, user_id, chapter_id, activity_kind, rung, learning_assignment_id, occurred_at, verified_by, verified_at, verification_request_id)
    select $1, a.user_id, a.chapter_id, a.activity_kind, a.rung, a.id, a.verified_at, a.verified_by, a.verified_at, extensions.gen_random_uuid()
    from public.member_learning_assignments a where a.id = $2`, [ids.completion, ids.assignment]);
  await q(`insert into public.member_participation_events (id, user_id, chapter_id, rung, activity_kind, source_kind, source_id, occurred_at, verified_by, canonical_completion_id, verified_at)
    select $1, c.user_id, c.chapter_id, c.rung, c.activity_kind, 'learning_assignment', c.id::text, c.occurred_at, c.verified_by, c.id, c.verified_at
    from public.member_participation_completions c where c.id = $2`, [ids.receipt, ids.completion]);
  await q(`insert into public.member_recognition_events (participation_event_id, canonical_completion_id, user_id, chapter_id, recognition_kind, source_kind, source_id, occurred_at, verified_by, verified_at)
    select e.id, e.canonical_completion_id, e.user_id, e.chapter_id, e.activity_kind, e.source_kind, e.source_id, e.occurred_at, $2, e.verified_at
    from public.member_participation_events e where e.id = $1`, [ids.receipt, G]);
}

const workerOwnRecords = `
  select
    (select count(*)::int from public.member_membership_periods where user_id = $1) as periods,
    (select count(*)::int from public.member_onboarding_steps where user_id = $1) as steps,
    (select count(*)::int from public.member_learning_assignments where user_id = $1) as assignments,
    (select count(*)::int from public.member_capacity_commitments where user_id = $1) as commitments,
    (select count(*)::int from public.member_participation_completions where user_id = $1) as completions,
    (select count(*)::int from public.member_participation_events where user_id = $1) as receipts,
    (select count(*)::int from public.member_recognition_events where user_id = $1) as recognitions,
    (select count(*)::int from private.member_recognition_week_totals where user_id = $1) as week_totals,
    (select count(*)::int from public.organizing_campaign_assignments where user_id = $1) as campaign_assignments`;

live("Union Ground account deletion on the disposable stack", () => {
  let client;
  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "unionground-account-lifecycle-proof" });
    await client.connect();
  });
  afterAll(async () => { await client?.end(); });
  beforeEach(async () => {
    await client.query("begin");
    await seed(client);
  });
  afterEach(async () => { await client.query("rollback"); });

  // The 44 columns 20261014014000 reviewed, read from the manifest itself.
  async function reviewedColumnsNaming(user) {
    const rows = (await client.query(`
      select schema_name, table_name, user_column from private.account_lifecycle_manifest
      where export_inventory_basis = 'auth_user_fk' and table_name = any($1::text[])
      order by 1, 2, 3`, [LIFECYCLE_TABLES])).rows;
    expect(rows).toHaveLength(44);
    const naming = [];
    for (const row of rows) {
      const { n } = (await client.query(
        `select count(*)::int as n from ${row.schema_name}.${row.table_name} where ${row.user_column} = $1`, [user])).rows[0];
      if (n > 0) naming.push(`${row.schema_name}.${row.table_name}.${row.user_column}`);
    }
    return naming;
  }

  async function expectState(statement, values, code) {
    await client.query("savepoint control");
    let error;
    try { await client.query(statement, values); } catch (caught) { error = caught; }
    await client.query("rollback to savepoint control");
    await client.query("release savepoint control");
    expect(error?.code, `${statement} should fail with ${code}`).toBe(code);
  }

  it("deletes an organizer who authored campaign evidence and keeps the history without their identity", async () => {
    const G = ids.organizer;
    const before = (await client.query("select count(*)::int as n from public.organizing_bargaining_ratifications where cycle_id = $1", [ids.cycle])).rows[0].n;
    await client.query("delete from auth.users where id = $1", [G]);

    const residue = (await client.query(`
      select
        (select created_by is null from public.union_employers where id = $1) as employer,
        (select created_by is null from public.union_worksites where id = $2) as worksite,
        (select created_by is null and owner_id is null and next_action_owner_id is null from public.organizing_campaigns where id = $3) as campaign,
        (select granted_by is null from public.organizing_campaign_assignments where user_id = $4) as worker_assignment,
        (select count(*) = 0 from public.organizing_campaign_assignments where user_id = $5) as organizer_assignment_gone,
        (select bool_and(actor_id is null) from public.organizing_stage_events where campaign_id = $3) as stage_history,
        (select created_by is null and assigned_to is null and support_position = 'supporter' and private_alias = 'Proof alias' from public.organizing_workers where id = $6) as support_row,
        (select bool_and(actor_id is null) from public.organizing_contact_events where worker_id = $6) as contact_history,
        (select created_by is null and owner_id is null from public.organizing_resistance_incidents where id = $7) as incident,
        (select bool_and(uploaded_by is null) from public.organizing_resistance_evidence where incident_id = $7) as evidence,
        (select bool_and(created_by is null) from public.coalition_partners where id = $8) as partner,
        (select created_by is null and bridge_lead_id is null from public.coalition_handshakes where id = $9) as handshake,
        (select bool_and(created_by is null) from public.coalition_commitments where handshake_id = $9) as coalition_commitment,
        (select bool_and(actor_id is null) from public.union_lifecycle_audit_events where chapter_id = $10) as audit,
        (select created_by is null and lead_id is null from public.organizing_bargaining_cycles where id = $11) as cycle,
        (select bool_and(created_by is null) from public.organizing_bargaining_proposals where cycle_id = $11) as proposals,
        (select bool_and(created_by is null) from public.organizing_bargaining_sessions where cycle_id = $11) as sessions,
        (select bool_and(recorded_by is null and execution_authorized) from public.organizing_bargaining_ratifications where cycle_id = $11) as ratifications,
        (select bool_and(corrected_by is null) from public.organizing_bargaining_ratification_corrections where cycle_id = $11) as corrections,
        (select bool_and(recorded_by is null) from public.organizing_first_contracts where cycle_id = $11) as first_contract,
        (select created_by is null from public.member_learning_sessions where id = $12) as learning_session,
        (select assigned_by is null and verified_by is null and status = 'completed' and verified_at is not null from public.member_learning_assignments where id = $13) as learning_assignment,
        (select offered_by = $14 and verified_by is null and status = 'completed' from public.member_capacity_commitments where id = $15) as commitment,
        (select verified_by is null from public.member_participation_completions where id = $16) as completion,
        (select verified_by is null and canonical_completion_id = $16 from public.member_participation_events where id = $17) as receipt,
        (select bool_and(verified_by is null) from public.member_recognition_events where user_id = $4) as recognition,
        (select verified_by is null and status = 'active' from public.member_membership_periods where id = $18) as membership_period,
        (select bool_and(verified_by is null) from public.member_onboarding_steps where user_id = $4) as onboarding
    `, [ids.employer, ids.worksite, ids.campaign, ids.worker, G, ids.supportRow, ids.incident, ids.partner, ids.handshake, chapter,
      ids.cycle, ids.session, ids.assignment, ids.lead, ids.commitment, ids.completion, ids.receipt, ids.period])).rows[0];
    expect(residue).toEqual(Object.fromEntries(Object.keys(residue).map((key) => [key, true])));
    expect((await client.query("select count(*)::int as n from public.organizing_bargaining_ratifications where cycle_id = $1", [ids.cycle])).rows[0].n).toBe(before);
    expect((await client.query(workerOwnRecords, [ids.worker])).rows[0]).toEqual({
      periods: 1, steps: 1, assignments: 1, commitments: 1, completions: 1, receipts: 1, recognitions: 1, week_totals: 1, campaign_assignments: 1,
    });
    // Nothing in any of the 44 reviewed lifecycle columns still names the
    // deleted organizer.
    expect(await reviewedColumnsNaming(G)).toEqual([]);
  });

  it("refuses every ordinary attribution clearing or actorless completion the detachment exception could be mistaken for", async () => {
    await expectState("update public.union_lifecycle_audit_events set actor_id = null where chapter_id = $1", [chapter], "42501");
    await expectState("update public.member_participation_events set verified_by = null where id = $1", [ids.receipt], "42501");
    await expectState("update public.member_participation_completions set verified_by = null where id = $1", [ids.completion], "42501");
    await expectState("update public.organizing_bargaining_ratifications set recorded_by = null where id = $1", [ids.ratification], "42501");
    await expectState("update public.organizing_bargaining_ratification_corrections set corrected_by = null where ratification_id = $1", [ids.correctedRatification], "42501");
    await expectState("update public.organizing_first_contracts set recorded_by = null where cycle_id = $1", [ids.cycle], "42501");
    await expectState("update public.organizing_bargaining_proposals set created_by = null where id = $1", [ids.article], "22023");
    await expectState("update public.member_learning_assignments set verified_by = null where id = $1", [ids.assignment], "42501");
    await expectState("update public.member_capacity_commitments set verified_by = null where id = $1", [ids.commitment], "42501");
    await expectState(`insert into public.member_learning_assignments (session_id, user_id, chapter_id, learning_kind, status, assigned_by, request_id, responded_at, completed_at, verified_at)
      values ($1, $2, $3, 'training', 'completed', $4, extensions.gen_random_uuid(), now() - interval '2 hours', now() - interval '1 hour', now())`,
    [ids.session, ids.lead, chapter, ids.organizer], "23514");
    await expectState("delete from public.union_lifecycle_audit_events where chapter_id = $1", [chapter], "42501");
    await expectState("delete from public.organizing_first_contracts where cycle_id = $1", [ids.cycle], "42501");
  });

  it("exports the worker's own lifecycle records without another person's identity", async () => {
    await client.query("insert into auth.sessions (id, user_id, aal, created_at) values ($1, $2, 'aal2', now())", [ids.workerSession, ids.worker]);
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids.worker, role: "authenticated", aal: "aal2", session_id: ids.workerSession })]);
    await client.query("set local role authenticated");
    const exported = (await client.query("select public.get_member_data_export() as value")).rows[0].value;
    await client.query("reset role");
    const domains = exported.additionalDomains;
    for (const [table, key] of [
      ["member_membership_periods", ids.period],
      ["member_learning_assignments", ids.assignment],
      ["member_capacity_commitments", ids.commitment],
      ["member_participation_completions", ids.completion],
      ["member_participation_events", ids.receipt],
    ]) {
      expect(domains[table].map((row) => row.id), table).toContain(key);
    }
    expect(domains.member_onboarding_steps).toHaveLength(1);
    expect(domains.member_recognition_events).toHaveLength(1);
    const text = JSON.stringify(Object.fromEntries(Object.entries(domains).filter(([table]) => [
      "member_membership_periods", "member_onboarding_steps", "member_learning_assignments", "member_capacity_commitments",
      "member_participation_completions", "member_participation_events", "member_recognition_events",
    ].includes(table))));
    for (const other of [ids.organizer, ids.lead]) expect(text).not.toContain(other);
    for (const column of ["verified_by", "assigned_by", "offered_by", "request_id", "verification_request_id", "source_id"]) {
      expect(text).not.toContain(`"${column}"`);
    }
  });

  it("removes the worker's own lifecycle records with their account, before or after the organizer's", async () => {
    for (const order of [[ids.worker], [ids.organizer, ids.worker]]) {
      await client.query("savepoint deletion_order");
      for (const user of order) await client.query("delete from auth.users where id = $1", [user]);
      expect((await client.query(workerOwnRecords, [ids.worker])).rows[0], order.join(" then ")).toEqual({
        periods: 0, steps: 0, assignments: 0, commitments: 0, completions: 0, receipts: 0, recognitions: 0, week_totals: 0, campaign_assignments: 0,
      });
      expect(await reviewedColumnsNaming(ids.worker)).toEqual([]);
      const kept = (await client.query(`
        select
          (select count(*)::int from public.organizing_campaigns where id = $1) as campaign,
          (select count(*)::int from public.member_learning_sessions where id = $2) as learning_session,
          (select count(*)::int from public.organizing_workers where id = $3) as support_row
      `, [ids.campaign, ids.session, ids.supportRow])).rows[0];
      expect(kept).toEqual({ campaign: 1, learning_session: 1, support_row: 1 });
      await client.query("rollback to savepoint deletion_order");
      await client.query("release savepoint deletion_order");
    }
  });
});
