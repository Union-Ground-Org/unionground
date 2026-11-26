// REQ-UG-COMPASS-ACTION-OFFERS-20261001 (CR-099) and
// REQ-UG-COMPASS-CONTEXTUAL-NUDGES-20261001.
//
// Client half of the restored Compass offers (old de7df4b57c^
// lib/claude/tools/ui-tools.ts, lib/ai-assistant/*, components/claude/
// assistant-action-offer.tsx, forward-picker-dialog.tsx) and attention nudges
// (lib/claude/contextual-nudges.ts). Nothing here writes on its own: every
// offer opens a confirmation, and the confirmed write goes through the
// existing authorized path for its object. These helpers keep controls
// honest; the server enforces each switch.
import { isFeatureEnabled } from "../../lib/featureSwitches.js";

export const ACTION_OFFERS_SWITCH = "features.ai_assistant.action_offers";
export const CONTEXTUAL_NUDGES_SWITCH = "features.ai_assistant.contextual_nudges";
export const PIN_LIMIT = 6;

// The organization's Compass switch for the menus and openers: on by default,
// and on until the organization's configuration has loaded.
// REQ-UG-COMPASS-REFUSES-GENERAL-HOW-TO-QUESTIONS-20261030.
export function compassAssistantEnabled(configuration) {
  return !configuration || typeof configuration !== "object"
    || isFeatureEnabled(configuration, "features.ai_assistant.enabled", true);
}

function assistantOn(configuration) {
  return Boolean(configuration && typeof configuration === "object")
    && isFeatureEnabled(configuration, "features.ai_assistant.enabled", true);
}

export function actionOffersEnabled(configuration) {
  return assistantOn(configuration) && isFeatureEnabled(configuration, ACTION_OFFERS_SWITCH, false);
}

export function contextualNudgesEnabled(configuration) {
  return assistantOn(configuration) && isFeatureEnabled(configuration, CONTEXTUAL_NUDGES_SWITCH, false);
}

// Old lib/ai-assistant/forward-target-heuristic.ts: preselect event for a
// date/time, task for an action verb, otherwise message. The person can change it.
const DATE_TIME = /\b(?:tomorrow|today|tonight|this (?:morning|afternoon|evening)|(?:next|this|on|by)\s+(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*|(?:mon|tues|wednes|thurs|fri|satur|sun)day|\d{1,2}(?:[:.]\d{2})\s*(?:[ap]m)?|\d{1,2}\s*[ap]m|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i;
const ACTION_VERB = /(?:^|\n|[•\-*]\s*|\d+\.\s+)(?:send|draft|follow\s*up|schedule|file|submit|create|review|reach\s*out|email|contact|prepare|sign|update|complete|check)\b/i;

export function inferForwardTarget(text, targets = ["message", "task", "event"]) {
  const value = typeof text === "string" ? text : "";
  const preferred = DATE_TIME.test(value) ? "event" : ACTION_VERB.test(value) ? "task" : "message";
  return targets.includes(preferred) ? preferred : targets[0];
}

// A task title is the answer's first sentence, bounded like quick creation.
export function taskTitleFromAnswer(answer) {
  const text = typeof answer === "string" ? answer.replace(/\s+/g, " ").trim() : "";
  const sentence = (text.match(/^[^.!?]+[.!?]?/) || [text])[0].trim();
  return sentence.length > 120 ? `${sentence.slice(0, 117).trimEnd()}…` : sentence;
}

export async function loadCompassPinnedAnswers(client) {
  const { data, error } = await client.rpc("list_compass_pinned_answers");
  if (error) throw error;
  return (Array.isArray(data) ? data : [])
    .filter((pin) => pin && typeof pin.id === "string" && typeof pin.answer === "string")
    .slice(0, PIN_LIMIT)
    .map((pin) => ({
      id: pin.id,
      threadId: typeof pin.threadId === "string" ? pin.threadId : null,
      question: typeof pin.question === "string" ? pin.question : "",
      answer: pin.answer,
      pinnedAt: typeof pin.pinnedAt === "string" ? pin.pinnedAt : null,
    }));
}

export async function setCompassAnswerPinned(client, messageId, pinned) {
  const { data, error } = await client.rpc("set_compass_answer_pinned", { p_message_id: messageId, p_pinned: Boolean(pinned) });
  if (error) {
    const failure = new Error("Compass pin unavailable");
    failure.code = error.code === "54000" ? "pin_limit" : error.code === "55000" ? "feature_disabled" : "pin_failed";
    throw failure;
  }
  return data;
}

// Nudge ids are the server's closed set; anything else is dropped.
const NUDGES = Object.freeze({
  "overdue-cases": { audience: "staff", labelKey: "compass.nudge.overdueCases", promptKey: "compass.nudge.prompt.overdueCases" },
  "retaliation-patterns": { audience: "staff", labelKey: "compass.nudge.retaliationPatterns", promptKey: "compass.nudge.prompt.retaliationPatterns" },
  "retaliation-flag": { audience: "member", labelKey: "compass.nudge.retaliationFlag", promptKey: "compass.nudge.prompt.retaliationFlag" },
});

export async function loadCompassNudges(client) {
  const { data, error } = await client.rpc("get_compass_nudges");
  if (error) throw error;
  if (!data || data.enabled !== true) return { staff: [], member: [] };
  const pick = (rows, audience) => (Array.isArray(rows) ? rows : [])
    .filter((row) => row && NUDGES[row.id]?.audience === audience && Number.isSafeInteger(row.count) && row.count > 0)
    .map((row) => ({ id: row.id, count: row.count, urgent: row.urgent === true }));
  return { staff: pick(data.staff, "staff"), member: pick(data.member, "member") };
}

export function presentNudges(rows, t) {
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const meta = NUDGES[row?.id];
    if (!meta) return [];
    return [{ id: row.id, urgent: row.urgent === true, label: t(meta.labelKey, { count: row.count }), prompt: t(meta.promptKey) }];
  });
}
