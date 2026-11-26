// REQ-UG-ONBOARDING-AUTO-ASSIGN-AND-STEWARD-OVERSIGHT-20261001 (CR-082).
// Staff onboarding oversight over the existing checklist: the roster with the
// organization's stalled flag (old app/dashboard/onboarding/page.tsx:48,131)
// and audited complete / skip / reset (old app/dashboard/onboarding/actions.ts).
// The server decides everything; this module only names the RPCs and
// normalizes their payload, failing closed to an empty roster.
// REQ-UG-ONBOARDING-ADMIN-SERVER-GAPS-20261104: each row's skip
// reasons and reminder state, the by-chapter summary the server already cut
// at its privacy floor, and the reminder RPC.

export const MEMBER_ONBOARDING_OVERSIGHT_RPCS = Object.freeze({
  load: "get_member_onboarding_oversight",
  update: "staff_update_member_onboarding_plan",
  remind: "send_member_onboarding_reminder",
});

/** The server refuses a skip reason that is empty or longer than this. */
export const ONBOARDING_SKIP_REASON_MAX = 500;

export const ONBOARDING_OVERSIGHT_ACTIONS = Object.freeze(["complete", "skip", "reset"]);

export const EMPTY_ONBOARDING_OVERSIGHT = Object.freeze({
  state: "empty",
  stalledFlagEnabled: false,
  stalledAfterDays: 14,
  stalledBelowPercent: 50,
  staffOverridesEnabled: false,
  autoEnrollEnabled: false,
  totalSteps: 0,
  steps: Object.freeze([]),
  members: Object.freeze([]),
  memberCount: 0,
  chapterSummary: null,
});

const STATUSES = new Set(["not_started", "in_progress", "completed"]);

function text(value, max = 160) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function nonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function stamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function chapterCounts(value) {
  return {
    enrolled: nonNegative(value.enrolled),
    notStarted: nonNegative(value.notStarted),
    inProgress: nonNegative(value.inProgress),
    completed: nonNegative(value.completed),
    stalled: Number.isInteger(value.stalled) && value.stalled >= 0 ? value.stalled : null,
  };
}

// The server returns only chapters at or above its floor; anything else, or a
// payload without the summary, shows no by-chapter counts at all.
function normalizeChapterSummary(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.chapters)) return null;
  const floor = nonNegative(value.floor, 25);
  const chapters = value.chapters
    .filter((row) => row && typeof row.chapterId === "string" && nonNegative(row.enrolled) >= floor)
    .map((row) => ({ chapterId: row.chapterId, name: text(row.name) || row.chapterId, ...chapterCounts(row) }));
  const other = value.otherChapters && typeof value.otherChapters === "object" && nonNegative(value.otherChapters.enrolled) >= floor
    ? chapterCounts(value.otherChapters)
    : null;
  return { floor, withheld: value.withheld === true, chapters, otherChapters: other, withheldChapters: nonNegative(value.withheldChapters) };
}

export function normalizeOnboardingOversight(payload) {
  if (!payload || typeof payload !== "object" || payload.state !== "ready") return { ...EMPTY_ONBOARDING_OVERSIGHT };
  const steps = (Array.isArray(payload.steps) ? payload.steps : [])
    .filter((step) => step && typeof step.id === "string")
    .map((step) => ({ id: step.id, title: text(step.title), position: nonNegative(step.position) }));
  const stepIds = new Set(steps.map((step) => step.id));
  const members = (Array.isArray(payload.members) ? payload.members : [])
    .filter((row) => row && typeof row.planId === "string" && typeof row.memberUserId === "string")
    .map((row) => ({
      planId: row.planId,
      memberUserId: row.memberUserId,
      memberLabel: text(row.memberLabel) || "Worker",
      status: STATUSES.has(row.status) ? row.status : "not_started",
      completedStepIds: (Array.isArray(row.completedStepIds) ? row.completedStepIds : []).filter((id) => stepIds.has(id)),
      completedSteps: nonNegative(row.completedSteps),
      percentComplete: Math.min(100, nonNegative(row.percentComplete)),
      assignedAt: typeof row.assignedAt === "string" ? row.assignedAt : null,
      autoEnrolled: row.autoEnrolled === true,
      stalled: row.stalled === true,
      skippedSteps: (Array.isArray(row.skippedSteps) ? row.skippedSteps : [])
        .filter((skip) => skip && stepIds.has(skip.stepId) && typeof skip.reason === "string")
        .map((skip) => ({ stepId: skip.stepId, reason: text(skip.reason, ONBOARDING_SKIP_REASON_MAX), skippedAt: stamp(skip.skippedAt) })),
      reminderSentAt: stamp(row.reminderSentAt),
      reminderOptedOut: row.reminderOptedOut === true,
    }));
  return {
    state: "ready",
    stalledFlagEnabled: payload.stalledFlagEnabled === true,
    stalledAfterDays: nonNegative(payload.stalledAfterDays, 14),
    stalledBelowPercent: nonNegative(payload.stalledBelowPercent, 50),
    staffOverridesEnabled: payload.staffOverridesEnabled === true,
    autoEnrollEnabled: payload.autoEnrollEnabled === true,
    totalSteps: nonNegative(payload.totalSteps),
    steps,
    members,
    memberCount: nonNegative(payload.memberCount, members.length),
    chapterSummary: normalizeChapterSummary(payload.chapterSummary),
  };
}

// The steps a staff member can still complete or skip for this worker.
export function openOnboardingSteps(oversight, member) {
  const done = new Set(member?.completedStepIds || []);
  return (oversight?.steps || []).filter((step) => !done.has(step.id));
}
