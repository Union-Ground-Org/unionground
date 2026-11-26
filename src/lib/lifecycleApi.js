import { requireRow } from "./apiResult.js";

function requireWriterReceipt(receipt, label, expected) {
  if (!receipt || typeof receipt !== "object") {
    throw new Error(`${label}: invalid receipt`);
  }
  for (const [key, value] of Object.entries(expected)) {
    if (receipt[key] !== value) throw new Error(`${label}: invalid receipt`);
  }
  if (typeof receipt.changed !== "boolean" || !receipt.auditEventId) {
    throw new Error(`${label}: invalid receipt`);
  }
  return receipt;
}

// Lifecycle data stays out of loadMemberApp. The workspace is staff-only,
// potentially sensitive, and should load only when its plane is opened.
export async function loadUnionLifecycleWorkspace(client) {
  const [lifecycleResult, bargainingResult] = await Promise.all([
    client.rpc("get_union_lifecycle_workspace"),
    client.rpc("get_bargaining_workspace"),
  ]);
  const lifecycle = requireRow(lifecycleResult, "Union lifecycle workspace");
  const bargaining = requireRow(bargainingResult, "Bargaining workspace");
  if (lifecycle.access?.aggregateOnly) {
    return {
      ...lifecycle,
      campaigns: (lifecycle.campaigns || []).map((campaign) => ({
        ...campaign,
        canOpenBargaining: false,
      })),
      bargaining: [],
    };
  }
  const canOpenCampaignIds = new Set(
    Array.isArray(bargaining.canOpenCampaignIds)
      ? bargaining.canOpenCampaignIds
      : [],
  );
  return {
    ...lifecycle,
    campaigns: (lifecycle.campaigns || []).map((campaign) => ({
      ...campaign,
      canOpenBargaining: canOpenCampaignIds.has(campaign.id),
    })),
    bargaining: Array.isArray(bargaining.bargaining) ? bargaining.bargaining : [],
  };
}

export async function createOrganizingCampaign(client, fields) {
  const label = "Create organizing campaign";
  const receipt = requireRow(
    await client.rpc("create_organizing_campaign", {
      p_name: fields.name,
      p_employer_name: fields.employerName,
      p_worksite_name: fields.worksiteName,
      p_proposed_unit: fields.proposedUnit,
      p_request_id: fields.requestId,
      p_representation_path: fields.representationPath,
      p_eligible_estimate: fields.eligibleEstimate,
    }),
    label,
  );
  if (!receipt.campaignId || !Number.isInteger(receipt.revision) || receipt.revision <= 0) {
    throw new Error(`${label}: invalid receipt`);
  }
  return requireWriterReceipt(receipt, label, {
    requestId: fields.requestId,
    stage: "lead",
  });
}

export async function transitionOrganizingCampaign(client, fields) {
  const label = "Record organizing milestone";
  const receipt = requireRow(
    await client.rpc("transition_organizing_campaign", {
      p_campaign_id: fields.campaignId,
      p_expected_revision: fields.expectedRevision,
      p_next_stage: fields.nextStage,
      p_request_id: fields.requestId,
      p_note: fields.note || null,
    }),
    label,
  );
  if (!Number.isInteger(receipt.revision) || receipt.revision <= 0) {
    throw new Error(`${label}: invalid receipt`);
  }
  return requireWriterReceipt(receipt, label, {
    requestId: fields.requestId,
    campaignId: fields.campaignId,
    stage: fields.nextStage,
  });
}

export async function setOrganizingCampaignStatus(client, fields) {
  const label = "Update organizing campaign status";
  const receipt = requireRow(
    await client.rpc("set_organizing_campaign_status", {
      p_campaign_id: fields.campaignId,
      p_expected_revision: fields.expectedRevision,
      p_status: fields.status,
      p_request_id: fields.requestId,
      p_outcome: fields.outcome || null,
      p_reason: fields.reason || null,
    }),
    label,
  );
  if (!Number.isInteger(receipt.revision) || receipt.revision <= 0) {
    throw new Error(`${label}: invalid receipt`);
  }
  return requireWriterReceipt(receipt, label, {
    requestId: fields.requestId,
    campaignId: fields.campaignId,
    status: fields.status,
    outcome: fields.status === "closed" ? fields.outcome : null,
  });
}

export async function recordResistanceIncident(client, fields) {
  const label = "Record employer conduct";
  const receipt = requireRow(
    await client.rpc("record_resistance_incident", {
      p_campaign_id: fields.campaignId,
      p_title: fields.title,
      p_category: fields.category,
      p_severity: fields.severity,
      p_summary: fields.summary,
      p_request_id: fields.requestId,
      p_source_kind: fields.sourceKind,
      p_occurred_on: fields.occurredOn || null,
      p_next_deadline_at: fields.nextDeadlineAt || null,
      p_consider_legal_review: Boolean(fields.considerLegalReview),
    }),
    label,
  );
  if (!receipt.incidentId || !receipt.reference) {
    throw new Error(`${label}: invalid receipt`);
  }
  return requireWriterReceipt(receipt, label, {
    requestId: fields.requestId,
    campaignId: fields.campaignId,
    status: "reported",
  });
}

function requireBargainingReceipt(receipt, label, expected) {
  if (!Number.isInteger(receipt.revision) || receipt.revision <= 0) {
    throw new Error(`${label}: invalid receipt`);
  }
  return requireWriterReceipt(receipt, label, expected);
}

export async function openOrganizingBargainingCycle(client, fields) {
  const label = "Open bargaining cycle";
  const receipt = requireRow(
    await client.rpc("open_organizing_bargaining_cycle", {
      p_campaign_id: fields.campaignId,
      p_expected_campaign_revision: fields.expectedCampaignRevision,
      p_title: fields.title,
      p_request_id: fields.requestId,
      p_target_first_contract_on: fields.targetFirstContractOn || null,
      p_next_action: fields.nextAction || null,
      p_next_deadline_at: fields.nextDeadlineAt || null,
    }),
    label,
  );
  if (!receipt.cycleId) throw new Error(`${label}: invalid receipt`);
  return requireBargainingReceipt(receipt, label, {
    requestId: fields.requestId,
    campaignId: fields.campaignId,
    phase: "preparing",
  });
}

export async function transitionOrganizingBargainingCycle(client, fields) {
  const label = "Update bargaining phase";
  const receipt = requireRow(
    await client.rpc("transition_organizing_bargaining_cycle", {
      p_cycle_id: fields.cycleId,
      p_expected_revision: fields.expectedRevision,
      p_expected_campaign_revision: fields.expectedCampaignRevision,
      p_next_phase: fields.nextPhase,
      p_request_id: fields.requestId,
      p_effective_on: fields.effectiveOn || null,
      p_reason: fields.reason || null,
      p_next_action: fields.nextAction || null,
      p_next_deadline_at: fields.nextDeadlineAt || null,
    }),
    label,
  );
  return requireBargainingReceipt(receipt, label, {
    requestId: fields.requestId,
    cycleId: fields.cycleId,
    phase: fields.nextPhase,
  });
}

export async function createOrganizingBargainingProposal(client, fields) {
  const label = "Create bargaining proposal";
  const receipt = requireRow(
    await client.rpc("create_organizing_bargaining_proposal", {
      p_cycle_id: fields.cycleId,
      p_expected_cycle_revision: fields.expectedCycleRevision,
      p_topic: fields.topic,
      p_title: fields.title,
      p_side: fields.side,
      p_request_id: fields.requestId,
      p_record_kind: fields.recordKind || "article",
      p_included_proposal_ids: fields.includedProposalIds || [],
      p_document_sha256: fields.documentSha256 || null,
      p_parent_proposal_id: fields.parentProposalId || null,
      p_parent_expected_revision: fields.parentExpectedRevision || null,
      p_relation_kind: fields.relationKind || null,
      p_member_summary: fields.memberSummary || null,
      p_internal_notes: fields.internalNotes || null,
    }),
    label,
  );
  if (!receipt.proposalId || !Number.isInteger(receipt.version)) {
    throw new Error(`${label}: invalid receipt`);
  }
  return requireBargainingReceipt(receipt, label, {
    requestId: fields.requestId,
    cycleId: fields.cycleId,
    status: "draft",
  });
}

export async function transitionOrganizingBargainingProposal(client, fields) {
  const label = "Update bargaining proposal";
  const receipt = requireRow(
    await client.rpc("transition_organizing_bargaining_proposal", {
      p_proposal_id: fields.proposalId,
      p_expected_revision: fields.expectedRevision,
      p_expected_cycle_revision: fields.expectedCycleRevision,
      p_next_status: fields.nextStatus,
      p_request_id: fields.requestId,
      p_presented_on: fields.presentedOn || null,
      p_reason: fields.reason || null,
    }),
    label,
  );
  return requireBargainingReceipt(receipt, label, {
    requestId: fields.requestId,
    proposalId: fields.proposalId,
    status: fields.nextStatus,
  });
}

export async function scheduleOrganizingBargainingSession(client, fields) {
  const label = "Schedule bargaining session";
  const receipt = requireRow(
    await client.rpc("schedule_organizing_bargaining_session", {
      p_cycle_id: fields.cycleId,
      p_expected_cycle_revision: fields.expectedCycleRevision,
      p_starts_at: fields.startsAt,
      p_request_id: fields.requestId,
      p_location: fields.location || null,
      p_agenda: fields.agenda || null,
    }),
    label,
  );
  if (!receipt.sessionId || !Number.isInteger(receipt.sessionNumber)) {
    throw new Error(`${label}: invalid receipt`);
  }
  return requireBargainingReceipt(receipt, label, {
    requestId: fields.requestId,
    cycleId: fields.cycleId,
    status: "scheduled",
  });
}

export async function recordOrganizingBargainingSessionOutcome(client, fields) {
  const label = "Record bargaining session outcome";
  const receipt = requireRow(
    await client.rpc("record_organizing_bargaining_session_outcome", {
      p_session_id: fields.sessionId,
      p_expected_revision: fields.expectedRevision,
      p_expected_cycle_revision: fields.expectedCycleRevision,
      p_status: fields.status,
      p_request_id: fields.requestId,
      p_ends_at: fields.endsAt || null,
      p_member_update: fields.memberUpdate || null,
      p_internal_minutes: fields.internalMinutes || null,
      p_reason: fields.reason || null,
    }),
    label,
  );
  return requireBargainingReceipt(receipt, label, {
    requestId: fields.requestId,
    sessionId: fields.sessionId,
    status: fields.status,
  });
}

export async function recordOrganizingRatification(client, fields) {
  const label = "Record external ratification result";
  const receipt = requireRow(
    await client.rpc("record_organizing_ratification", {
      p_cycle_id: fields.cycleId,
      p_expected_cycle_revision: fields.expectedCycleRevision,
      p_expected_campaign_revision: fields.expectedCampaignRevision,
      p_agreement_proposal_id: fields.agreementProposalId,
      p_agreement_sha256: fields.agreementSha256,
      p_decision_method: fields.decisionMethod,
      p_held_on: fields.heldOn,
      p_source_reported_outcome: fields.sourceReportedOutcome,
      p_source_kind: fields.sourceKind,
      p_source_reference: fields.sourceReference,
      p_source_sha256: fields.sourceSha256,
      p_rule_summary: fields.ruleSummary,
      p_eligibility_source: fields.eligibilitySource,
      p_eligible_count: fields.eligibleCount,
      p_ballots_cast: fields.ballotsCast,
      p_approve_count: fields.approveCount,
      p_reject_count: fields.rejectCount,
      p_abstain_count: fields.abstainCount,
      p_invalid_count: fields.invalidCount,
      p_quorum_required_count: fields.quorumRequiredCount,
      p_threshold_numerator: fields.thresholdNumerator,
      p_threshold_denominator: fields.thresholdDenominator,
      p_approval_comparator: fields.approvalComparator,
      p_approval_denominator: fields.approvalDenominator,
      p_request_id: fields.requestId,
    }),
    label,
  );
  if (!receipt.ratificationId || !receipt.outcome) {
    throw new Error(`${label}: invalid receipt`);
  }
  return requireBargainingReceipt(receipt, label, {
    requestId: fields.requestId,
    cycleId: fields.cycleId,
    decisionMethod: fields.decisionMethod,
  });
}

export async function correctOrganizingRatification(client, fields) {
  const label = "Correct external ratification record";
  const receipt = requireRow(
    await client.rpc("correct_organizing_ratification", {
      p_ratification_id: fields.ratificationId,
      p_expected_cycle_revision: fields.expectedCycleRevision,
      p_expected_campaign_revision: fields.expectedCampaignRevision,
      p_reason_code: fields.reasonCode,
      p_source_kind: fields.sourceKind,
      p_source_reference: fields.sourceReference,
      p_source_sha256: fields.sourceSha256,
      p_request_id: fields.requestId,
    }),
    label,
  );
  if (
    !receipt.correctionId
    || receipt.ratificationId !== fields.ratificationId
    || receipt.corrected !== true
    || receipt.reasonCode !== fields.reasonCode
  ) {
    throw new Error(`${label}: invalid receipt`);
  }
  return requireBargainingReceipt(receipt, label, {
    requestId: fields.requestId,
    cycleId: fields.cycleId,
  });
}

// The governed exit from a post-first-contract ratification integrity hold
// (20260725100000_unionground_ratification_hold_governance.sql). Without a
// client wrapper the hold is unreachable from the product and the only recovery
// is a DBA disabling a trigger on live evidence data, which is precisely what
// the migration exists to prevent. The note is the whole product record of why
// the hold was lifted, so the RPC rejects an empty one.
export async function resolveRatificationIntegrityHold(client, fields) {
  const label = "Resolve ratification integrity hold";
  const receipt = requireRow(
    await client.rpc("resolve_ratification_integrity_hold", {
      p_cycle_id: fields.cycleId,
      p_expected_cycle_revision: fields.expectedCycleRevision,
      p_request_id: fields.requestId,
      p_resolution_note: fields.resolutionNote,
    }),
    label,
  );
  // integrityHold must read false in BOTH receipt branches — a receipt that
  // still reports the hold means the clear did not happen.
  if (!receipt.correctionId || receipt.integrityHold !== false) {
    throw new Error(`${label}: invalid receipt`);
  }
  return requireBargainingReceipt(receipt, label, {
    requestId: fields.requestId,
    cycleId: fields.cycleId,
  });
}

export async function recordOrganizingFirstContract(client, fields) {
  const label = "Record executed first contract";
  const receipt = requireRow(
    await client.rpc("record_organizing_first_contract", {
      p_cycle_id: fields.cycleId,
      p_expected_cycle_revision: fields.expectedCycleRevision,
      p_expected_campaign_revision: fields.expectedCampaignRevision,
      p_ratification_id: fields.ratificationId,
      p_agreement_sha256: fields.agreementSha256,
      p_signed_on: fields.signedOn,
      p_request_id: fields.requestId,
      p_source_kind: fields.sourceKind,
      p_source_reference: fields.sourceReference,
      p_source_sha256: fields.sourceSha256,
      p_expected_signatory_count: fields.expectedSignatoryCount,
      p_verified_signatory_count: fields.verifiedSignatoryCount,
      p_effective_on: fields.effectiveOn || null,
      p_expires_on: fields.expiresOn || null,
    }),
    label,
  );
  if (!receipt.contractId || receipt.status !== "source_recorded_fully_signed") {
    throw new Error(`${label}: invalid receipt`);
  }
  return requireBargainingReceipt(receipt, label, {
    requestId: fields.requestId,
    cycleId: fields.cycleId,
    phase: "complete",
  });
}

export function createLifecycleDemoApi(seed) {
  const snapshot = JSON.parse(JSON.stringify(seed));
  return {
    loadWorkspace: async () => JSON.parse(JSON.stringify(snapshot)),
  };
}
