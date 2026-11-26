// REQ-UG-COMPASS-STAFF-DATA-ANSWERS-20261001
//
// The closed set of organization-figure topics Compass can answer for staff,
// and a deterministic classifier shared by /api/guide (authoritative) and the
// web client (which only uses it to pre-select "Our numbers" for a suggested
// question). The old app let the model pick tools
// (de7df4b57c^ lib/claude/tools/index.ts:83-99); here the server decides which
// existing aggregate reads run, so the model never chooses a data access.
import { isFeatureEnabled } from "../../lib/featureSwitches.js";

export const STAFF_DATA_TOPICS = Object.freeze(["caseload", "outcomes", "membership", "health", "bargaining"]);

// Union Ground has no arbitration, no contract articles and no grievance
// steps (owner decision, 2026-10-13), so those words select no topic.
const TOPIC_PATTERNS = Object.freeze({
  outcomes: /\b(win|wins|won|winning|outcomes?|resolved|resolutions?|resolution rate|sustained|upheld|settled|settlements?|denied|withdrawn|tasa de éxito|ganad\w*|resultados?|resuelt\w*)\b/iu,
  caseload: /\b(caseloads?|overdue|deadlines?|due|backlog|open cases|queue|workload|vencid\w*|plazos?|casos abiertos|carga)\b/iu,
  membership: /\b(member stats|membership|members|units?|stewards? count|how many members|headcount|miembros|afiliad\w*|unidad(es)?)\b/iu,
  health: /\b(health|engagement|attendance|participation|trends?|trending|active (users|members)|salud|participación|asistencia|tendencias?|evoluciona)\b/iu,
  bargaining: /\b(bargain\w*|proposals?|negotiat\w*|tentative agreement|counter ?proposals?|negociaci\w*|propuestas?|contrapropuestas?)\b/iu,
});

export function classifyDataTopics(question) {
  const text = typeof question === "string" ? question.normalize("NFKC").slice(0, 1200) : "";
  if (!text.trim()) return [];
  return STAFF_DATA_TOPICS.filter((topic) => TOPIC_PATTERNS[topic].test(text));
}

export function validDataTopics(value) {
  if (!Array.isArray(value)) return [];
  return STAFF_DATA_TOPICS.filter((topic) => value.includes(topic));
}

// REQ-UG-COMPASS-STAFF-DATA-ANSWERS-20261001: whether to offer "Our
// numbers" to a staff hat. The server enforces both switches and the role;
// this keeps the toggle honest (it is hidden whenever the server would refuse).
export const STAFF_DATA_ANSWERS_SWITCH = "features.ai_assistant.staff_data_answers";

export function staffDataAnswersEnabled(configuration) {
  return Boolean(configuration && typeof configuration === "object")
    && isFeatureEnabled(configuration, "features.ai_assistant.enabled", true)
    && isFeatureEnabled(configuration, STAFF_DATA_ANSWERS_SWITCH, false);
}
