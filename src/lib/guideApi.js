import { t } from "./i18n.js";
import { validDataTopics } from "../features/compass/dataTopics.js";
import { CASE_HELP_KEYS, COMPASS_PAGE_KEYS } from "../features/compass/pageHelp.js";

// Server-side refusals the Guide sheet explains in its own copy.
const COMPASS_REFUSAL_CODES = new Set([
  "compass_paused", "question_withheld", "staff_required", "feature_disabled", "no_data_topic",
  "role_rate_limit", "shared_rate_limit",
]);
const CASE_HELP_REFUSAL_CODES = new Set(["compass_paused", "feature_disabled", "case_unavailable", "role_rate_limit", "shared_rate_limit"]);

// Saved legacy conversations are not organization-bound. Ask using the current
// question and authorized server sources; do not forward prior workspace text.
// `options.mode === "staff_data"` asks for an answer from the organization's
// own figures (REQ-UG-COMPASS-STAFF-DATA-ANSWERS-20261001); the server
// decides the topics and refuses members. Older callers pass a history array
// in this position, which is ignored as before.
export async function requestGuideReply(session, question, options = {}) {
  if (!session?.access_token) throw new Error("Your session expired. Sign in again.");
  const settings = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  const body = { question };
  if (settings.mode === "staff_data") {
    body.mode = "staff_data";
    const topics = validDataTopics(settings.topics);
    if (topics.length) body.topics = topics;
  } else if (COMPASS_PAGE_KEYS.includes(settings.page)) {
    // Page-aware help: the page key only; the server honors it only while the
    // organization switch is on.
    body.page = settings.page;
  }

  const response = await fetch("/api/guide", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  const scopeNotices = [...new Set(Array.isArray(payload.scope_notices) ? payload.scope_notices : [])]
    .filter((code) => ["local_fallback", "other_organization"].includes(code))
    .map((code) => t(settings.lang || "en", `compass.scope.${code}`));
  if (!response.ok) {
    // Search-only degraded reply: the answer service was unreachable but the
    // verified sources were found. Nothing is saved (there is no answer); the
    // sheet shows them with a plain notice. Only the bounded source fields the
    // API already minimized are kept.
    const outage = (response.status === 504 && payload.code === "gateway_timeout")
      || (response.status === 502 && payload.code === "gateway_unavailable");
    if (outage && payload.degraded === "search_only" && Array.isArray(payload.sources)) {
      const sources = payload.sources
          .filter((source) => source && typeof source === "object" && !Array.isArray(source)
            && typeof source.id === "string" && source.id.trim()
            && ((typeof source.title === "string" && source.title.trim())
              || (typeof source.ref === "string" && source.ref.trim())))
          .slice(0, 6)
          .map((source) => ({
            id: source.id.slice(0, 160),
            kind: String(source.kind || "").slice(0, 40),
            title: String(source.title || "").slice(0, 160),
            ref: String(source.ref || "").slice(0, 80),
          }));
      if (sources.length) return { answer: null, degraded: payload.code, sources, ...(scopeNotices.length ? { scopeNotices } : {}) };
    }
    const error = new Error(payload.error || "Union Ground Guide is unavailable right now.");
    if (COMPASS_REFUSAL_CODES.has(payload.code)) error.code = payload.code;
    throw error;
  }
  if (!payload.answer) throw new Error("Union Ground Guide returned an empty answer.");
  return { answer: [payload.answer, ...scopeNotices].join("\n"), sources: Array.isArray(payload.sources) ? payload.sources : [] };
}

// "Ask the Guide about this case" (REQ-UG-COMPASS-PAGE-AND-CASE-AWARE-HELP-20261001).
// Only the case id and a fixed question key leave the browser; the server
// re-reads the case through the caller's own authorization. Nothing is saved.
export async function requestCaseHelp(session, caseId, questionKey) {
  if (!session?.access_token) throw new Error("Your session expired. Sign in again.");
  if (!CASE_HELP_KEYS.includes(questionKey)) throw new Error("Choose one of the suggested questions.");
  const response = await fetch("/api/guide", {
    method: "POST",
    headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "case_help", caseId, questionKey }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.answer !== "string" || !payload.answer) {
    const error = new Error(payload.error || "Union Ground Guide is unavailable right now.");
    if (CASE_HELP_REFUSAL_CODES.has(payload.code)) error.code = payload.code;
    throw error;
  }
  const sources = Array.isArray(payload.sources)
    ? payload.sources
      .filter((source) => source && typeof source === "object" && (typeof source.title === "string" || typeof source.ref === "string"))
      .slice(0, 6)
      .map((source) => ({ id: String(source.id || "").slice(0, 160), title: String(source.title || "").slice(0, 160), ref: String(source.ref || "").slice(0, 80) }))
    : [];
  return { answer: payload.answer, sources };
}

// REQ-UG-FIELD-NOTES-AI-PACKET-20261001. The draft is for review: nothing
// is saved here and the returned citations are only the markers the server
// itself put in the prompt.
const PACKET_REFUSAL_CODES = new Set(["feature_disabled", "staff_required", "notes_unavailable", "no_notes"]);

export async function requestFieldNotesPacket(session, taskId, noteIds) {
  if (!session?.access_token) throw new Error("Your session expired. Sign in again.");
  const selected = Array.isArray(noteIds) ? [...new Set(noteIds.filter((id) => typeof id === "string" && id))] : [];
  if (!taskId || selected.length < 1) throw new Error("Choose at least one field note.");
  const response = await fetch("/api/guide", {
    method: "POST",
    headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "field_notes_packet", taskId, noteIds: selected }),
  });
  const payload = await response.json().catch(() => ({}));
  const packet = payload?.packet;
  if (!response.ok || !packet || typeof packet !== "object" || typeof packet.headline !== "string" || !packet.headline) {
    const error = new Error(payload.error || "Union Ground Guide is unavailable right now.");
    if (PACKET_REFUSAL_CODES.has(payload.code)) error.code = payload.code;
    throw error;
  }
  const list = (value, maximum, limit) => (Array.isArray(value) ? value : [])
    .filter((item) => typeof item === "string" && item.trim())
    .slice(0, maximum)
    .map((item) => item.slice(0, limit));
  return {
    packet: {
      headline: String(packet.headline).slice(0, 120),
      summary: String(packet.summary || "").slice(0, 600),
      plainLanguage: String(packet.plainLanguage || "").slice(0, 1200),
      checklist: list(packet.checklist, 10, 200),
      questions: list(packet.questions, 8, 200),
      citations: (Array.isArray(packet.citations) ? packet.citations : [])
        .filter((item) => item && typeof item === "object" && typeof item.marker === "string" && typeof item.title === "string")
        .slice(0, 20)
        .map((item) => ({ marker: item.marker.slice(0, 8), title: item.title.slice(0, 200) })),
    },
    sources: (Array.isArray(payload.sources) ? payload.sources : [])
      .filter((source) => source && typeof source === "object")
      .slice(0, 6)
      .map((source) => ({
        marker: String(source.marker || "").slice(0, 8),
        id: String(source.id || "").slice(0, 160),
        title: String(source.title || "").slice(0, 160),
        ref: String(source.ref || "").slice(0, 80),
      })),
  };
}
