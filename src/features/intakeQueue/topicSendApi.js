// The platform operator's client for POST /api/intake-topic-send
// (REQ-UG-INTAKE-QUEUE-EMAIL-THE-OPT-IN-LIST-20261118): preview,
// test and send one update to everyone who opted into a landing topic. The
// route authenticates the bearer token, needs a second factor and answers
// `{ result }`. Every failure is thrown as one plain shape,
// `{ status, error, reason, missing }`, so the panel never reads a raw
// Response. Nothing here logs or stores a body.

export const TOPIC_SEND_PATH = "/api/intake-topic-send";
export const TOPIC_SEND_TOPICS = Object.freeze(["chapter_updates", "public_meetings", "union_news"]);
export const SUBJECT_MAX = 150;
export const BODY_MAX = 5000;
// Sends are dated on the Eastern day the server counts them on.
export const EASTERN = "America/New_York";

// The refusals the database and the route name; anything else is "generic".
export const TOPIC_SEND_REFUSALS = Object.freeze([
  "test-required", "already-sent-today", "no-recipients", "test-limit", "no-operator-email", "key-reused",
  "invalid-topic", "invalid-subject", "invalid-body",
]);

export async function requestTopicSend({ fetchImpl = globalThis.fetch, accessToken, action, payload = {} }) {
  let response;
  try {
    response = await fetchImpl(TOPIC_SEND_PATH, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ ...payload, action }),
    });
  } catch {
    throw { status: 0, error: "unavailable", reason: null, missing: [] };
  }
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw {
      status: response.status,
      error: typeof body?.error === "string" ? body.error : "unavailable",
      reason: typeof body?.reason === "string" ? body.reason : null,
      missing: Array.isArray(body?.missing) ? body.missing.filter((name) => typeof name === "string") : [],
    };
  }
  if (!body || typeof body !== "object" || !body.result || typeof body.result !== "object") {
    throw { status: response.status, error: "unavailable", reason: null, missing: [] };
  }
  return body.result;
}

// Mirrors the server's cleaning (CRLF and CR become LF, both trimmed), so the
// panel knows whether the text on screen is exactly the text it tested.
export function cleanUpdate({ topic, subject, body }) {
  return {
    topic: TOPIC_SEND_TOPICS.includes(topic) ? topic : "",
    subject: String(subject ?? "").trim(),
    body: String(body ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^[ \n\t]+|[ \n\t]+$/g, ""),
  };
}

export function updateSignature(update) {
  const clean = cleanUpdate(update);
  return JSON.stringify([clean.topic, clean.subject, clean.body]);
}

export function updateReady(update) {
  const clean = cleanUpdate(update);
  const subjectLength = [...clean.subject].length;
  const bodyLength = [...clean.body].length;
  return Boolean(clean.topic) && subjectLength >= 1 && subjectLength <= SUBJECT_MAX && !/\n/.test(clean.subject)
    && bodyLength >= 1 && bodyLength <= BODY_MAX;
}

export function refusalKey(error) {
  if (error?.status === 409 && error.error === "refused" && TOPIC_SEND_REFUSALS.includes(error.reason)) return error.reason;
  if (error?.status === 503 && error.error === "mail-unavailable") return "mail-unavailable";
  if (error?.status === 0 || error?.status === 503) return "unavailable";
  return "generic";
}

export function newKey() {
  return globalThis.crypto.randomUUID();
}
