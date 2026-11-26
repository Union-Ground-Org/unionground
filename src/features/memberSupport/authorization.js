import {
  ACCOMMODATION_STATUSES,
  EMPTY_MEMBER_SUPPORT_WORKSPACE,
  EMERGENCY_SCENARIOS,
  HANDOFF_INITIATOR_HATS,
  HR_CONTACT_DISPOSITIONS,
  MEMBER_SUPPORT_STAFF_HATS,
  MENTORSHIP_STATUSES,
} from "./contract.js";

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizeMemberSupportActor(actor = {}) {
  const organizationRoles = unique(actor.organizationRoles || actor.roles)
    .filter((role) => MEMBER_SUPPORT_STAFF_HATS.includes(role));
  const chapterRoles = unique(actor.chapterRoles)
    .filter((role) => MEMBER_SUPPORT_STAFF_HATS.includes(role));
  return Object.freeze({
    userId: actor.userId || actor.id || null,
    selectedOrganizationId: actor.selectedOrganizationId || actor.organizationId || null,
    chapterId: actor.chapterId || null,
    selectedHat: actor.selectedHat || "member",
    organizationRoles: Object.freeze(organizationRoles),
    chapterRoles: Object.freeze(chapterRoles),
    membershipStatus: actor.membershipStatus || null,
    mfaSatisfied: Boolean(actor.mfaSatisfied),
  });
}

export function canReadMemberSupport(actor) {
  const current = normalizeMemberSupportActor(actor);
  return Boolean(
    current.userId
      && current.selectedOrganizationId
      && current.membershipStatus === "active",
  );
}

export function canManageMemberSupport(actor) {
  const current = normalizeMemberSupportActor(actor);
  return canReadMemberSupport(current)
    && MEMBER_SUPPORT_STAFF_HATS.includes(current.selectedHat)
    && current.organizationRoles.includes(current.selectedHat)
    && current.mfaSatisfied;
}

export function canInitiateMemberHandoff(actor) {
  const current = normalizeMemberSupportActor(actor);
  return canManageMemberSupport(current) && HANDOFF_INITIATOR_HATS.includes(current.selectedHat);
}

function safeChecklist(row) {
  const scenario = EMERGENCY_SCENARIOS.find((item) => item.id === row?.scenario);
  if (!row?.id || !scenario) return null;
  const completed = [...new Set(array(row.completedSteps))].filter((step) => Number.isInteger(step)
    && step >= 0 && step < scenario.steps.length);
  return {
    id: row.id,
    memberUserId: row.memberUserId || null,
    memberLabel: String(row.memberLabel || "Worker"),
    scenario: row.scenario,
    status: ["draft", "alerted", "resolved"].includes(row.status) ? row.status : "draft",
    completedSteps: completed,
    notes: String(row.notes || ""),
    alertedAt: row.alertedAt || null,
    resolvedAt: row.resolvedAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function safeAccommodation(row) {
  if (!row?.id) return null;
  return {
    id: row.id,
    memberUserId: row.memberUserId || null,
    memberLabel: String(row.memberLabel || "Worker"),
    requestType: String(row.requestType || "other"),
    description: String(row.description || ""),
    status: ACCOMMODATION_STATUSES.includes(row.status) ? row.status : "submitted",
    staffNote: String(row.staffNote || ""),
    submittedAt: row.submittedAt || null,
    resolvedAt: row.resolvedAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function safeHrContact(row) {
  if (!row?.id) return null;
  return {
    id: row.id,
    memberUserId: row.memberUserId || null,
    memberLabel: String(row.memberLabel || "Worker"),
    channel: ["email", "phone", "meeting", "letter", "portal", "other"].includes(row.channel)
      ? row.channel : "other",
    purpose: String(row.purpose || ""),
    disposition: HR_CONTACT_DISPOSITIONS.includes(row.disposition) ? row.disposition : "planned",
    note: String(row.note || ""),
    occurredAt: row.occurredAt || null,
    followUpOn: row.followUpOn || null,
    createdAt: row.createdAt || null,
  };
}

function safeMentorshipPair(row) {
  if (!row?.id) return null;
  return {
    id: row.id,
    mentorUserId: row.mentorUserId || null,
    menteeUserId: row.menteeUserId || null,
    mentorLabel: String(row.mentorLabel || "Mentor"),
    menteeLabel: String(row.menteeLabel || "Mentee"),
    status: MENTORSHIP_STATUSES.includes(row.status) ? row.status : "active",
    startedOn: row.startedOn || null,
    endedOn: row.endedOn || null,
    outcome: String(row.outcome || ""),
    goals: array(row.goals).filter((goal) => goal?.id && goal?.title).map((goal) => ({
      id: goal.id,
      title: String(goal.title),
      completed: Boolean(goal.completed),
      completedAt: goal.completedAt || null,
    })),
    notes: array(row.notes).filter((note) => note?.id).map((note) => ({
      id: note.id,
      authorLabel: String(note.authorLabel || "Participant"),
      body: String(note.body || ""),
      createdAt: note.createdAt || null,
    })),
  };
}

function safeHandoff(row) {
  if (!row?.id || !row?.memberId) return null;
  return {
    id: row.id,
    memberId: row.memberId,
    memberName: String(row.memberName || "Worker").slice(0, 200),
    fromStewardId: row.fromStewardId || null,
    fromStewardName: String(row.fromStewardName || "Unassigned").slice(0, 200),
    toStewardId: row.toStewardId || null,
    toStewardName: String(row.toStewardName || "Steward").slice(0, 200),
    direction: ["incoming", "outgoing", "overseen"].includes(row.direction) ? row.direction : "overseen",
    status: ["pending", "acknowledged", "declined", "cancelled"].includes(row.status) ? row.status : "pending",
    note: String(row.note || "").slice(0, 2000),
    canAcknowledge: Boolean(row.canAcknowledge),
    canDecline: Boolean(row.canDecline),
    canCancel: Boolean(row.canCancel),
    createdAt: row.createdAt || null,
    acknowledgedAt: row.acknowledgedAt || null,
    resolvedAt: row.resolvedAt || null,
  };
}

export function normalizeMemberHandoffs(value) {
  return {
    items: array(value?.items).map(safeHandoff).filter(Boolean),
    nextCursor: value?.nextCursor || null,
  };
}

export function normalizeMemberSupportWorkspace(snapshot, actor) {
  const current = normalizeMemberSupportActor(actor);
  if (!snapshot || snapshot.state === "empty" || !current.selectedOrganizationId) {
    return { ...EMPTY_MEMBER_SUPPORT_WORKSPACE };
  }
  if (snapshot.organizationId !== current.selectedOrganizationId) {
    return { ...EMPTY_MEMBER_SUPPORT_WORKSPACE, state: "unauthorized" };
  }
  return {
    state: snapshot.state === "ready" ? "ready" : "error",
    organizationId: snapshot.organizationId,
    viewerUserId: current.userId,
    staff: Boolean(snapshot.staff && canManageMemberSupport(current)),
    emergencyChecklists: array(snapshot.emergencyChecklists).map(safeChecklist).filter(Boolean),
    accommodations: array(snapshot.accommodations).map(safeAccommodation).filter(Boolean),
    accommodationSummary: {
      total: Number(snapshot.accommodationSummary?.total || 0),
      open: Number(snapshot.accommodationSummary?.open || 0),
      approved: Number(snapshot.accommodationSummary?.approved || 0),
      denied: Number(snapshot.accommodationSummary?.denied || 0),
      withdrawn: Number(snapshot.accommodationSummary?.withdrawn || 0),
    },
    hrDirectory: snapshot.hrDirectory?.id ? {
      id: snapshot.hrDirectory.id,
      name: String(snapshot.hrDirectory.name || ""),
      title: String(snapshot.hrDirectory.title || ""),
      department: String(snapshot.hrDirectory.department || ""),
      email: String(snapshot.hrDirectory.email || ""),
      phone: String(snapshot.hrDirectory.phone || ""),
      hours: String(snapshot.hrDirectory.hours || ""),
      notes: String(snapshot.hrDirectory.notes || ""),
      enabled: snapshot.hrDirectory.enabled !== false,
    } : null,
    hrContacts: array(snapshot.hrContacts).map(safeHrContact).filter(Boolean),
    onboardingProgram: array(snapshot.onboardingProgram).filter((step) => step?.id).map((step) => ({
      id: step.id,
      title: String(step.title || "Step"),
      description: String(step.description || ""),
      position: Number(step.position || 0),
      active: step.active !== false,
    })),
    onboardingPlan: snapshot.onboardingPlan?.id ? {
      id: snapshot.onboardingPlan.id,
      memberUserId: snapshot.onboardingPlan.memberUserId || current.userId,
      status: String(snapshot.onboardingPlan.status || "not_started"),
      completedStepIds: unique(snapshot.onboardingPlan.completedStepIds),
      startedAt: snapshot.onboardingPlan.startedAt || null,
      completedAt: snapshot.onboardingPlan.completedAt || null,
      assignedByLabel: String(snapshot.onboardingPlan.assignedByLabel || ""),
    } : null,
    onboardingRoster: array(snapshot.onboardingRoster),
    mentorshipPairs: array(snapshot.mentorshipPairs).map(safeMentorshipPair).filter(Boolean),
    mentorshipDirectory: array(snapshot.mentorshipDirectory).filter((person) => person?.userId).map((person) => ({
      userId: person.userId,
      label: String(person.label || "Worker"),
      chapterId: person.chapterId || null,
    })),
    handoffs: current.selectedHat === "member"
      ? { items: [], nextCursor: null }
      : normalizeMemberHandoffs(snapshot.handoffs),
  };
}
