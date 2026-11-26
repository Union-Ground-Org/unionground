import { describe, expect, it, vi } from "vitest";
import {
  correctOrganizingRatification,
  createOrganizingBargainingProposal,
  loadUnionLifecycleWorkspace,
  openOrganizingBargainingCycle,
  recordOrganizingBargainingSessionOutcome,
  recordOrganizingFirstContract,
  recordOrganizingRatification,
  recordResistanceIncident,
  resolveRatificationIntegrityHold,
  scheduleOrganizingBargainingSession,
  setOrganizingCampaignStatus,
  transitionOrganizingBargainingCycle,
  transitionOrganizingBargainingProposal,
  transitionOrganizingCampaign,
} from "../src/lib/lifecycleApi.js";

const campaignId = "10000000-0000-4000-8000-000000000001";
const requestId = "20000000-0000-4000-8000-000000000001";
const auditEventId = "30000000-0000-4000-8000-000000000001";

function clientWith(receipt) {
  return { rpc: vi.fn().mockResolvedValue({ data: receipt, error: null }) };
}

describe("lifecycle writer API", () => {
  it("maps a milestone command exactly and validates its receipt", async () => {
    const receipt = {
      changed: true,
      requestId,
      campaignId,
      stage: "committee",
      revision: 8,
      auditEventId,
    };
    const client = clientWith(receipt);
    await expect(transitionOrganizingCampaign(client, {
      campaignId,
      expectedRevision: 7,
      nextStage: "committee",
      requestId,
      note: "Committee verified",
    })).resolves.toBe(receipt);
    expect(client.rpc).toHaveBeenCalledWith("transition_organizing_campaign", {
      p_campaign_id: campaignId,
      p_expected_revision: 7,
      p_next_stage: "committee",
      p_request_id: requestId,
      p_note: "Committee verified",
    });
  });

  it("maps a status command exactly and validates its receipt", async () => {
    const receipt = {
      changed: true,
      requestId,
      campaignId,
      status: "paused",
      outcome: null,
      revision: 8,
      auditEventId,
    };
    const client = clientWith(receipt);
    await expect(setOrganizingCampaignStatus(client, {
      campaignId,
      expectedRevision: 7,
      status: "paused",
      requestId,
      outcome: null,
      reason: "Waiting on access",
    })).resolves.toBe(receipt);
    expect(client.rpc).toHaveBeenCalledWith("set_organizing_campaign_status", {
      p_campaign_id: campaignId,
      p_expected_revision: 7,
      p_status: "paused",
      p_request_id: requestId,
      p_outcome: null,
      p_reason: "Waiting on access",
    });
  });

  it("maps identity-free resistance input exactly", async () => {
    const receipt = {
      changed: true,
      requestId,
      campaignId,
      incidentId: "40000000-0000-4000-8000-000000000001",
      reference: "ER-2026-ABCD1234",
      status: "reported",
      auditEventId,
    };
    const client = clientWith(receipt);
    await expect(recordResistanceIncident(client, {
      campaignId,
      title: "Reported schedule threat",
      category: "threat",
      severity: "high",
      summary: "Supervisor reportedly linked schedules to campaign activity.",
      requestId,
      sourceKind: "worker_report",
      occurredOn: "2026-07-23",
      nextDeadlineAt: "2026-07-25T16:00:00.000Z",
      considerLegalReview: true,
    })).resolves.toBe(receipt);
    expect(client.rpc).toHaveBeenCalledWith("record_resistance_incident", {
      p_campaign_id: campaignId,
      p_title: "Reported schedule threat",
      p_category: "threat",
      p_severity: "high",
      p_summary: "Supervisor reportedly linked schedules to campaign activity.",
      p_request_id: requestId,
      p_source_kind: "worker_report",
      p_occurred_on: "2026-07-23",
      p_next_deadline_at: "2026-07-25T16:00:00.000Z",
      p_consider_legal_review: true,
    });
  });

  it("preserves Supabase conflict metadata", async () => {
    const source = {
      message: "campaign changed; reload and try again",
      code: "40001",
      details: "revision mismatch",
      hint: "reload",
      status: 409,
    };
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: source, status: 409 }) };
    await expect(transitionOrganizingCampaign(client, {
      campaignId,
      expectedRevision: 7,
      nextStage: "committee",
      requestId,
      note: "",
    })).rejects.toMatchObject({
      message: "Record organizing milestone: campaign changed; reload and try again",
      code: "40001",
      details: "revision mismatch",
      hint: "reload",
      status: 409,
      cause: source,
    });
  });

  it("fails closed on missing or mismatched receipts", async () => {
    const missing = clientWith(null);
    await expect(transitionOrganizingCampaign(missing, {
      campaignId,
      expectedRevision: 7,
      nextStage: "committee",
      requestId,
      note: "",
    })).rejects.toThrow(/no data returned/i);

    const mismatch = clientWith({
      changed: true,
      requestId: "wrong",
      campaignId,
      stage: "committee",
      revision: 8,
      auditEventId,
    });
    await expect(transitionOrganizingCampaign(mismatch, {
      campaignId,
      expectedRevision: 7,
      nextStage: "committee",
      requestId,
      note: "",
    })).rejects.toThrow(/invalid receipt/i);
  });
});

describe("bargaining writer API", () => {
  const cycleId = "40000000-0000-4000-8000-000000000001";
  const proposalId = "50000000-0000-4000-8000-000000000001";
  const sessionId = "60000000-0000-4000-8000-000000000001";
  const ratificationId = "70000000-0000-4000-8000-000000000001";
  const correctionId = "71000000-0000-4000-8000-000000000001";
  const contractId = "80000000-0000-4000-8000-000000000001";
  const sha = "a".repeat(64);

  it("merges the safe bargaining projection and exact open permission", async () => {
    const client = {
      rpc: vi.fn()
        .mockResolvedValueOnce({
          data: { campaigns: [{ id: campaignId }], bargaining: [{ id: "unsafe" }] },
          error: null,
        })
        .mockResolvedValueOnce({
          data: {
            canOpenCampaignIds: [campaignId],
            bargaining: [{ id: cycleId, campaignId }],
          },
          error: null,
        }),
    };
    await expect(loadUnionLifecycleWorkspace(client)).resolves.toMatchObject({
      campaigns: [{ id: campaignId, canOpenBargaining: true }],
      bargaining: [{ id: cycleId, campaignId }],
    });
    expect(client.rpc.mock.calls).toEqual([
      ["get_union_lifecycle_workspace"],
      ["get_bargaining_workspace"],
    ]);
  });

  it("maps all bargaining commands to the exact RPC contract", async () => {
    const cases = [
      {
        call: openOrganizingBargainingCycle,
        name: "open_organizing_bargaining_cycle",
        fields: {
          campaignId,
          expectedCampaignRevision: 4,
          title: "First contract",
          requestId,
          targetFirstContractOn: "2026-12-01",
          nextAction: "Prepare priorities",
          nextDeadlineAt: "2026-08-01T16:00:00.000Z",
        },
        params: {
          p_campaign_id: campaignId,
          p_expected_campaign_revision: 4,
          p_title: "First contract",
          p_request_id: requestId,
          p_target_first_contract_on: "2026-12-01",
          p_next_action: "Prepare priorities",
          p_next_deadline_at: "2026-08-01T16:00:00.000Z",
        },
        receipt: { campaignId, cycleId, phase: "preparing", revision: 1 },
      },
      {
        call: transitionOrganizingBargainingCycle,
        name: "transition_organizing_bargaining_cycle",
        fields: {
          cycleId,
          expectedRevision: 2,
          expectedCampaignRevision: 4,
          nextPhase: "at_table",
          requestId,
          effectiveOn: "2026-07-01",
          reason: "Start verified",
          nextAction: "Session one",
          nextDeadlineAt: null,
        },
        params: {
          p_cycle_id: cycleId,
          p_expected_revision: 2,
          p_expected_campaign_revision: 4,
          p_next_phase: "at_table",
          p_request_id: requestId,
          p_effective_on: "2026-07-01",
          p_reason: "Start verified",
          p_next_action: "Session one",
          p_next_deadline_at: null,
        },
        receipt: { cycleId, phase: "at_table", revision: 3 },
      },
      {
        call: createOrganizingBargainingProposal,
        name: "create_organizing_bargaining_proposal",
        fields: {
          cycleId,
          expectedCycleRevision: 3,
          topic: "Scheduling",
          title: "Predictable schedules",
          side: "union",
          requestId,
          recordKind: "article",
          includedProposalIds: [],
          documentSha256: null,
          parentProposalId: null,
          parentExpectedRevision: null,
          relationKind: null,
          memberSummary: "Scheduling proposal.",
          internalNotes: "Restricted.",
        },
        params: {
          p_cycle_id: cycleId,
          p_expected_cycle_revision: 3,
          p_topic: "Scheduling",
          p_title: "Predictable schedules",
          p_side: "union",
          p_request_id: requestId,
          p_record_kind: "article",
          p_included_proposal_ids: [],
          p_document_sha256: null,
          p_parent_proposal_id: null,
          p_parent_expected_revision: null,
          p_relation_kind: null,
          p_member_summary: "Scheduling proposal.",
          p_internal_notes: "Restricted.",
        },
        receipt: { cycleId, proposalId, version: 1, status: "draft", revision: 1 },
      },
      {
        call: transitionOrganizingBargainingProposal,
        name: "transition_organizing_bargaining_proposal",
        fields: {
          proposalId,
          expectedRevision: 1,
          expectedCycleRevision: 4,
          nextStatus: "approved",
          requestId,
          presentedOn: null,
          reason: "",
        },
        params: {
          p_proposal_id: proposalId,
          p_expected_revision: 1,
          p_expected_cycle_revision: 4,
          p_next_status: "approved",
          p_request_id: requestId,
          p_presented_on: null,
          p_reason: null,
        },
        receipt: { proposalId, status: "approved", revision: 2 },
      },
      {
        call: scheduleOrganizingBargainingSession,
        name: "schedule_organizing_bargaining_session",
        fields: {
          cycleId,
          expectedCycleRevision: 5,
          startsAt: "2026-08-01T14:00:00.000Z",
          requestId,
          location: "Union hall",
          agenda: "Restricted agenda",
        },
        params: {
          p_cycle_id: cycleId,
          p_expected_cycle_revision: 5,
          p_starts_at: "2026-08-01T14:00:00.000Z",
          p_request_id: requestId,
          p_location: "Union hall",
          p_agenda: "Restricted agenda",
        },
        receipt: { cycleId, sessionId, sessionNumber: 1, status: "scheduled", revision: 1 },
      },
      {
        call: recordOrganizingBargainingSessionOutcome,
        name: "record_organizing_bargaining_session_outcome",
        fields: {
          sessionId,
          expectedRevision: 1,
          expectedCycleRevision: 6,
          status: "held",
          requestId,
          endsAt: "2026-08-01T18:00:00.000Z",
          memberUpdate: "Session held.",
          internalMinutes: "Restricted minutes.",
          reason: null,
        },
        params: {
          p_session_id: sessionId,
          p_expected_revision: 1,
          p_expected_cycle_revision: 6,
          p_status: "held",
          p_request_id: requestId,
          p_ends_at: "2026-08-01T18:00:00.000Z",
          p_member_update: "Session held.",
          p_internal_minutes: "Restricted minutes.",
          p_reason: null,
        },
        receipt: { cycleId, sessionId, status: "held", revision: 2 },
      },
      {
        call: recordOrganizingRatification,
        name: "record_organizing_ratification",
        fields: {
          cycleId,
          expectedCycleRevision: 7,
          expectedCampaignRevision: 5,
          agreementProposalId: proposalId,
          agreementSha256: sha,
          decisionMethod: "vote",
          heldOn: "2026-07-20",
          sourceReportedOutcome: "approved",
          sourceKind: "union_report",
          sourceReference: "restricted/reference",
          sourceSha256: sha,
          ruleSummary: "Majority of non-abstaining ballots.",
          eligibilitySource: "Staff roster as of 2026-07-20.",
          eligibleCount: 100,
          ballotsCast: 80,
          approveCount: 50,
          rejectCount: 25,
          abstainCount: 5,
          invalidCount: 0,
          quorumRequiredCount: 50,
          thresholdNumerator: 1,
          thresholdDenominator: 2,
          approvalComparator: "more_than",
          approvalDenominator: "non_abstaining",
          requestId,
        },
        params: {
          p_cycle_id: cycleId,
          p_expected_cycle_revision: 7,
          p_expected_campaign_revision: 5,
          p_agreement_proposal_id: proposalId,
          p_agreement_sha256: sha,
          p_decision_method: "vote",
          p_held_on: "2026-07-20",
          p_source_reported_outcome: "approved",
          p_source_kind: "union_report",
          p_source_reference: "restricted/reference",
          p_source_sha256: sha,
          p_rule_summary: "Majority of non-abstaining ballots.",
          p_eligibility_source: "Staff roster as of 2026-07-20.",
          p_eligible_count: 100,
          p_ballots_cast: 80,
          p_approve_count: 50,
          p_reject_count: 25,
          p_abstain_count: 5,
          p_invalid_count: 0,
          p_quorum_required_count: 50,
          p_threshold_numerator: 1,
          p_threshold_denominator: 2,
          p_approval_comparator: "more_than",
          p_approval_denominator: "non_abstaining",
          p_request_id: requestId,
        },
        receipt: { cycleId, ratificationId, outcome: "approved", decisionMethod: "vote", revision: 8 },
      },
      {
        call: correctOrganizingRatification,
        name: "correct_organizing_ratification",
        fields: {
          cycleId,
          ratificationId,
          expectedCycleRevision: 8,
          expectedCampaignRevision: 6,
          reasonCode: "source_error",
          sourceKind: "official_record",
          sourceReference: "restricted/correction",
          sourceSha256: sha,
          requestId,
        },
        params: {
          p_ratification_id: ratificationId,
          p_expected_cycle_revision: 8,
          p_expected_campaign_revision: 6,
          p_reason_code: "source_error",
          p_source_kind: "official_record",
          p_source_reference: "restricted/correction",
          p_source_sha256: sha,
          p_request_id: requestId,
        },
        receipt: {
          cycleId,
          ratificationId,
          correctionId,
          corrected: true,
          reasonCode: "source_error",
          phase: "ratification",
          revision: 9,
        },
      },
      {
        call: recordOrganizingFirstContract,
        name: "record_organizing_first_contract",
        fields: {
          cycleId,
          expectedCycleRevision: 8,
          expectedCampaignRevision: 6,
          ratificationId,
          agreementSha256: sha,
          signedOn: "2026-07-23",
          requestId,
          sourceKind: "executed_contract",
          sourceReference: "restricted/contract",
          sourceSha256: sha,
          expectedSignatoryCount: 4,
          verifiedSignatoryCount: 4,
          effectiveOn: "2026-07-01",
          expiresOn: "2029-06-30",
        },
        params: {
          p_cycle_id: cycleId,
          p_expected_cycle_revision: 8,
          p_expected_campaign_revision: 6,
          p_ratification_id: ratificationId,
          p_agreement_sha256: sha,
          p_signed_on: "2026-07-23",
          p_request_id: requestId,
          p_source_kind: "executed_contract",
          p_source_reference: "restricted/contract",
          p_source_sha256: sha,
          p_expected_signatory_count: 4,
          p_verified_signatory_count: 4,
          p_effective_on: "2026-07-01",
          p_expires_on: "2029-06-30",
        },
        receipt: { cycleId, contractId, phase: "complete", status: "source_recorded_fully_signed", revision: 9 },
      },
      {
        call: resolveRatificationIntegrityHold,
        name: "resolve_ratification_integrity_hold",
        fields: {
          cycleId,
          expectedCycleRevision: 9,
          requestId,
          resolutionNote: "Employer confirmed the corrected tally in writing.",
        },
        params: {
          p_cycle_id: cycleId,
          p_expected_cycle_revision: 9,
          p_request_id: requestId,
          p_resolution_note: "Employer confirmed the corrected tally in writing.",
        },
        receipt: {
          cycleId,
          correctionId,
          ratificationId,
          phase: "ratification",
          integrityHold: false,
          revision: 10,
        },
      },
    ];

    for (const item of cases) {
      const receipt = {
        changed: true,
        requestId,
        auditEventId,
        campaignId,
        ...item.receipt,
      };
      const client = clientWith(receipt);
      await expect(item.call(client, item.fields)).resolves.toBe(receipt);
      expect(client.rpc).toHaveBeenCalledWith(item.name, item.params);
    }
  });

  it("rejects a correction receipt with a mismatched reason", async () => {
    const client = clientWith({
      changed: true,
      requestId,
      auditEventId,
      campaignId,
      cycleId,
      ratificationId,
      correctionId,
      corrected: true,
      reasonCode: "wrong_agreement",
      phase: "ratification",
      revision: 9,
    });
    await expect(correctOrganizingRatification(client, {
      cycleId,
      ratificationId,
      expectedCycleRevision: 8,
      expectedCampaignRevision: 6,
      reasonCode: "source_error",
      sourceKind: "official_record",
      sourceReference: "restricted/correction",
      sourceSha256: sha,
      requestId,
    })).rejects.toThrow(/invalid receipt/i);
  });

  it("rejects a hold-resolution receipt that still reports the hold", async () => {
    const client = clientWith({
      changed: true,
      requestId,
      auditEventId,
      campaignId,
      cycleId,
      correctionId,
      ratificationId,
      phase: "ratification",
      integrityHold: true,
      revision: 10,
    });
    await expect(resolveRatificationIntegrityHold(client, {
      cycleId,
      expectedCycleRevision: 9,
      requestId,
      resolutionNote: "Employer confirmed the corrected tally in writing.",
    })).rejects.toThrow(/invalid receipt/i);
  });
});
