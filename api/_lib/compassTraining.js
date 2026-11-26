import { waitUntil } from "@vercel/functions";
import { unchangedCompassTrainingText } from "./compassPrompts.js";
import { supabaseRpc } from "./http.js";

export const COMPASS_TRAINING_NOTICE_VERSION = "compass-training-v1";
export const COMPASS_TRAINING_RETENTION_DAYS = 180;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function compassTrainingPair({ kind, question, answer }) {
  if (kind !== "question" && kind !== "civic-draft") return null;
  const prompt = unchangedCompassTrainingText(question, 1200);
  const response = unchangedCompassTrainingText(answer, 8000);
  return prompt && response ? { prompt, response } : null;
}

// The database derives the organization from this exact dispatched request,
// and rechecks consent, membership and archive state. No source/context object
// or raw rejected text is passed to storage. Failure cannot alter an answer.
export function scheduleCompassTraining({ supabaseUrl, serviceRoleKey, userId, requestId, kind, question, answer }, options = {}) {
  const pair = compassTrainingPair({ kind, question, answer });
  if (!pair || !UUID.test(userId || "") || !UUID.test(requestId || "")) return Promise.resolve(false);
  const pending = Promise.resolve().then(() => (options.rpc || supabaseRpc)(
    supabaseUrl, serviceRoleKey, serviceRoleKey, "retain_compass_training_pair",
    { p_request_id: requestId, p_user_id: userId, p_kind: kind,
      p_prompt: pair.prompt, p_response: pair.response,
      p_notice_version: COMPASS_TRAINING_NOTICE_VERSION },
    { timeoutMs: 2500 },
  )).then(value => value === true).catch(() => false);
  try { (options.waitUntilImpl || waitUntil)(pending); } catch { /* local runtime */ }
  return pending;
}
