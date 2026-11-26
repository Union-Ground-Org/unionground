// REQ-UG-LOVABLE-ADMIN-ONBOARDING-BATCH-D-GAP-20261103.
//
// The organization side of member onboarding from the Batch D prototype
// (port order item 3): Onboarding setup, Member progress and Preview as
// member, on the RPCs the product already has. Everything here is pure:
//
// - Onboarding setup writes only through save_organization_onboarding_step.
//   Positions are unique per organization (active or not), so a move is a
//   swap written as three saves through a free position.
// - Member progress counts the rows get_member_onboarding_oversight already
//   returned; totals and the step-by-step counts stay hidden below the
//   aggregate floor. By-chapter counts come only from the server's
//   chapterSummary, which already withholds every chapter under its floor of
//   at least 25 (REQ-UG-ONBOARDING-ADMIN-SERVER-GAPS-20261104), as do
//   the reminder rule (once a day, stalled, not opted out) and the required
//   skip reason; the helpers below only explain those answers.
// - Preview as member never reads a member: it rebuilds the member guide
//   from the organization's own steps and switches (memberServer.js) and runs
//   the same plan() the shell runs, with a made-up plan for the chosen stage.
import { normalizeCommandText } from "../../lib/commandPalette.js";
import { ONBOARDING_SKIP_REASON_MAX } from "../memberSupport/onboardingOversight.js";
import { plan } from "./engine.js";
import { GUIDE_SWITCHES, activeStepsInOrder, buildMemberGuidePayload, momentumMark } from "./memberServer.js";

/** Totals and step-by-step counts need at least this many plans. */
export const ONBOARDING_PROGRESS_FLOOR = 10;

const POSITION_MIN = 0;
const POSITION_MAX = 1000;

const PREVIEW_STAGES = Object.freeze(["welcome", "activate", "complete"]);

/** Every step, active or not, in the server's order: position, then id. */
export function programInOrder(steps) {
  return (Array.isArray(steps) ? steps : [])
    .filter((step) => step && typeof step.id === "string")
    .slice()
    .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The position a new step gets by default: after the last one. */
export function nextStepPosition(steps) {
  const ordered = programInOrder(steps);
  if (ordered.length === 0) return 1;
  const last = Number(ordered[ordered.length - 1].position) || 0;
  if (last < POSITION_MAX) return last + 1;
  return freePosition(ordered);
}

function freePosition(ordered) {
  const used = new Set(ordered.map((step) => Number(step.position) || 0));
  for (let value = POSITION_MAX; value >= POSITION_MIN; value -= 1) if (!used.has(value)) return value;
  return null;
}

/**
 * The saves that move one step up or down past its neighbour.
 * @param {Array<{ id: string, title?: string, description?: string, position?: number, active?: boolean }>} steps
 * @param {string} stepId
 * @param {"up" | "down"} direction
 * `originals` holds each touched step's save at its old position, for
 * applyStepMove to put back when a later save fails.
 * @returns {{ ok: true, writes: StepSave[], originals: Record<string, StepSave> } | { ok: false, reason: "first" | "last" | "missing" | "full" }}
 */
export function stepMove(steps, stepId, direction) {
  const ordered = programInOrder(steps);
  const index = ordered.findIndex((step) => step.id === stepId);
  if (index < 0) return { ok: false, reason: "missing" };
  const otherIndex = direction === "up" ? index - 1 : index + 1;
  if (otherIndex < 0) return { ok: false, reason: "first" };
  if (otherIndex >= ordered.length) return { ok: false, reason: "last" };
  const step = ordered[index];
  const other = ordered[otherIndex];
  const spare = freePosition(ordered);
  if (spare === null) return { ok: false, reason: "full" };
  const save = (row, position) => ({
    stepId: row.id,
    title: String(row.title ?? ""),
    description: String(row.description ?? ""),
    position,
    active: row.active !== false,
  });
  const from = Number(step.position) || 0;
  const to = Number(other.position) || 0;
  return {
    ok: true,
    writes: [save(step, spare), save(other, from), save(step, to)],
    originals: { [step.id]: save(step, from), [other.id]: save(other, to) },
  };
}

/** @typedef {{ stepId: string, title: string, description: string, position: number, active: boolean }} StepSave */

/**
 * Runs a move's saves in order through `save`. The step RPC takes one step
 * per call, so a move is not one transaction: if a save fails after an
 * earlier one committed, the steps already written go back to their old
 * positions, the last written first (each old position is free by then),
 * and the failure is thrown with `restored` saying whether that worked.
 * @param {{ writes: StepSave[], originals: Record<string, StepSave> }} move
 * @param {(write: StepSave) => Promise<unknown>} save
 */
export async function applyStepMove(move, save) {
  const applied = [];
  try {
    for (const write of move.writes) {
      await save(write);
      applied.push(write.stepId);
    }
  } catch (cause) {
    let restored = true;
    const touched = [...new Set(applied.slice().reverse())];
    try {
      for (const stepId of touched) await save(move.originals[stepId]);
    } catch {
      restored = false;
    }
    const failure = new Error("onboarding step move did not save", { cause });
    failure.code = "ONBOARDING_STEP_MOVE_FAILED";
    failure.restored = restored;
    throw failure;
  }
}

/**
 * The step-list summary: active steps and where the guide's Momentum point
 * falls (greatest(2, ceil(n / 3)), as get_member_onboarding_guide decides).
 * @returns {{ active: number, momentum: number | null }}
 */
export function programSummary(steps) {
  const active = activeStepsInOrder(steps).length;
  const momentum = momentumMark(active);
  return { active, momentum: active > 0 && momentum < active ? momentum : null };
}

/**
 * Member progress from the oversight payload (normalizeOnboardingOversight).
 * Counts come only from the rows the server returned. `withheld`: fewer than
 * the floor have a plan. `partial`: the server cut the roster at its limit
 * (stalled first, then most recently updated), so the rows are not the
 * organization's totals. Either way no totals, step counts or chip counts.
 */
export function onboardingProgressSummary(oversight, floor = ONBOARDING_PROGRESS_FLOOR) {
  const members = Array.isArray(oversight?.members) ? oversight.members : [];
  const steps = Array.isArray(oversight?.steps) ? oversight.steps : [];
  const counted = members.length;
  const enrolled = Number.isInteger(oversight?.memberCount) ? Math.max(oversight.memberCount, counted) : counted;
  const partial = enrolled > counted;
  if (counted < floor || partial) return { withheld: counted < floor, floor, counted, enrolled, partial, tiles: null, steps: [], biggestDrop: null };
  const byStatus = (status) => members.filter((row) => row.status === status).length;
  const tiles = {
    enrolled: counted,
    notStarted: byStatus("not_started"),
    inProgress: byStatus("in_progress"),
    completed: byStatus("completed"),
    stalled: oversight?.stalledFlagEnabled === true ? members.filter((row) => row.stalled === true).length : null,
  };
  // Rows carry titles, not numbers: these are active steps only, while
  // Onboarding setup numbers every step, so a number here could name a
  // different step there.
  const stepRows = steps.map((step) => {
    const done = members.filter((row) => Array.isArray(row.completedStepIds) && row.completedStepIds.includes(step.id)).length;
    return { id: step.id, title: step.title, done, percent: Math.round((done / counted) * 100) };
  });
  let biggestDrop = null;
  for (let index = 1; index < stepRows.length; index += 1) {
    const people = stepRows[index - 1].done - stepRows[index].done;
    if (people > 0 && (!biggestDrop || people > biggestDrop.people)) {
      biggestDrop = { from: stepRows[index - 1].title, to: stepRows[index].title, people };
    }
  }
  return { withheld: false, floor, counted, enrolled, partial, tiles, steps: stepRows, biggestDrop };
}

export const PROGRESS_FILTERS = Object.freeze(["all", "stalled", "not_started", "in_progress", "completed"]);

/** Roster rows for one filter chip and the "Find a member" text (accents ignored, as in the command palette). */
export function filterProgressMembers(members, { filter = "all", query = "" } = {}) {
  const needle = normalizeCommandText(String(query ?? "").trim());
  return (Array.isArray(members) ? members : []).filter((row) => {
    if (filter === "stalled" && row.stalled !== true) return false;
    if (filter !== "all" && filter !== "stalled" && row.status !== filter) return false;
    return !needle || normalizeCommandText(row.memberLabel).includes(needle);
  });
}

/** How many rows each chip would show. */
export function progressFilterCounts(members) {
  return Object.fromEntries(PROGRESS_FILTERS.map((filter) => [filter, filterProgressMembers(members, { filter }).length]));
}

/** The five guide switches, by payload field, from the organization's settings. */
export function guideSwitchFields(switches) {
  return Object.fromEntries(GUIDE_SWITCHES.map(({ field, key }) => [field, switches?.[key] === true]));
}

/** Stages a preview can show: "In progress" needs a step between the Momentum point and the end. */
export function previewStages(steps) {
  const total = activeStepsInOrder(steps).length;
  return PREVIEW_STAGES.filter((stage) => stage !== "activate" || (total > 0 && momentumMark(total) < total));
}

/**
 * The member guide as a new member of this organization would see it at one
 * stage. Client only: the plan is made up from the organization's own active
 * steps (none done, the Momentum point's worth done, or all done), never read
 * from a member.
 * @param {{ steps: unknown[], switches?: Record<string, unknown> | null, stage: "welcome" | "activate" | "complete", now: number }} input
 */
export function memberPreview({ steps, switches = null, stage, now }) {
  const active = activeStepsInOrder(/** @type {any[]} */ (steps));
  const total = active.length;
  const doneCount = stage === "complete" ? total : stage === "activate" ? Math.min(momentumMark(total), total) : 0;
  const completedStepIds = active.slice(0, doneCount).map((step) => step.id);
  const previewPlan = total === 0 ? null : {
    status: doneCount >= total ? "completed" : doneCount > 0 ? "in_progress" : "not_started",
    completedStepIds,
  };
  const guide = buildMemberGuidePayload({ memberOnly: true, steps: active, plan: previewPlan, switches: guideSwitchFields(switches) });
  const view = plan({
    now,
    hat: "member",
    switches: switches ?? null,
    guide,
    workspace: { onboardingProgram: active, onboardingPlan: previewPlan },
    who: { memberOnlyAccount: true },
  });
  const reason = total === 0 ? "noSteps"
    : !switches || typeof switches !== "object" ? "switchesUnknown"
      : !guide.applies ? "switchesOff" : !view.card ? "noCard" : null;
  return { stage: guide.stage, total, done: guide.completedSteps, card: view.card, steps: view.steps, spotlight: view.legacy.spotlight, reason };
}

const percentOf = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/**
 * By-chapter rows from the normalized chapterSummary. Nothing is counted
 * here: chapters under the floor never reach the browser, and the pooled
 * remainder is shown only when the server returned it.
 * @returns {null | { floor: number, withheld: boolean, rows: ChapterRow[], other: ChapterRow | null, pooledChapters: number }}
 */
export function chapterProgressRows(summary) {
  if (!summary || !Array.isArray(summary.chapters)) return null;
  const row = (key, name, { enrolled, notStarted, inProgress, completed, stalled }) => (
    { key, name, enrolled, notStarted, inProgress, completed, stalled, completedPercent: percentOf(completed, enrolled) });
  const rows = summary.chapters.map((chapter) => row(chapter.chapterId, chapter.name, chapter));
  const other = summary.otherChapters ? row("other", null, summary.otherChapters) : null;
  return { floor: summary.floor, withheld: summary.withheld === true, rows, other, pooledChapters: other ? summary.withheldChapters : 0 };
}

/** @typedef {{ key: string, name: string | null, enrolled: number, notStarted: number, inProgress: number, completed: number, stalled: number | null, completedPercent: number }} ChapterRow */

const ONBOARDING_REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the desk offers a reminder for one roster row. The server decides
 * again on every send; this only keeps the button honest.
 * @returns {{ state: "ready" | "notStalled" | "optedOut" | "sentToday", nextAt: string | null }}
 */
export function onboardingReminderState(row, now) {
  if (row?.stalled !== true) return { state: "notStalled", nextAt: null };
  if (row.reminderOptedOut === true) return { state: "optedOut", nextAt: null };
  const sent = Date.parse(row.reminderSentAt ?? "");
  if (Number.isFinite(sent) && now - sent < ONBOARDING_REMINDER_WINDOW_MS) {
    return { state: "sentToday", nextAt: new Date(sent + ONBOARDING_REMINDER_WINDOW_MS).toISOString() };
  }
  return { state: "ready", nextAt: null };
}

/** The desk's sentence for a refused reminder, by the server's error code. */
export function onboardingReminderFailure(error) {
  switch (String(error?.code ?? "")) {
    case "54000": return "rateLimited";
    case "55000": return "optedOut";
    case "42501": return "forbidden";
    default: return null;
  }
}

/** Why a skip reason can't be sent yet, or null when it can. */
export function skipReasonProblem(value) {
  const reason = String(value ?? "").trim();
  if (!reason) return "empty";
  if (reason.length > ONBOARDING_SKIP_REASON_MAX) return "tooLong";
  return null;
}
