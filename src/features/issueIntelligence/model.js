// Issue intelligence (REQ-UG-ISSUE-INTELLIGENCE-SIGNALS-20261001).
//
// Restores the old app's issue-thread output layer (de7df4b57c^:
// lib/issue-threads/output.ts, privacy.ts, families.ts) for the current
// architecture. The database decides whether a family is active and enforces
// the privacy floor; this module only turns the server projection into copy
// keys and in-app destinations. It never sees counts, people or text.

export const ISSUE_FAMILIES = Object.freeze({
  retaliation: "retaliation_protected_activity_pressure",
  contractRights: "contract_rights_confusion",
});

// Old ISSUE_THREAD_PRIORITY (families.ts:13-16): retaliation first.
const FAMILY_ORDER = [ISSUE_FAMILIES.retaliation, ISSUE_FAMILIES.contractRights];
const THREAD_KEYS = Object.freeze({
  [ISSUE_FAMILIES.retaliation]: "retaliation-protected-activity-pressure",
  [ISSUE_FAMILIES.contractRights]: "contract-rights-confusion",
});
const CONFIDENCE = ["strong", "active", "emerging"];
const TRENDS = ["rising", "stable", "declining"];
export const EVIDENCE_FAMILIES = Object.freeze([
  "retaliation_reports", "kyr", "qa", "messages", "cases", "polls", "reviewed_themes",
]);

// Member surfaces that show a banner: Home (old member home issueSignals) and
// Know your rights (old know-your-rights widget guidance boost). Every other
// old destination is reached from the banner's guidance links instead.
const MEMBER_SURFACES = Object.freeze({
  [ISSUE_FAMILIES.contractRights]: ["today", "rights"],
  [ISSUE_FAMILIES.retaliation]: ["today", "rights"],
});

function familyKey(family) {
  return family === ISSUE_FAMILIES.retaliation ? "retaliation" : "contractRights";
}

// Strict reader for get_issue_intelligence_signals. Anything unexpected is
// dropped rather than rendered; a staff field on a member projection is
// discarded so a member surface can never show staff detail.
export function normalizeIssueSignals(payload) {
  const empty = { enabled: false, viewer: "member", signals: [] };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return empty;
  const viewer = payload.viewer === "staff" ? "staff" : "member";
  if (payload.enabled !== true) return { ...empty, viewer };
  const seen = new Set();
  const signals = (Array.isArray(payload.signals) ? payload.signals : []).flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const family = FAMILY_ORDER.includes(raw.family) ? raw.family : null;
    if (!family || seen.has(family)) return [];
    seen.add(family);
    const signal = { family, threadKey: THREAD_KEYS[family], key: familyKey(family) };
    if (viewer !== "staff") return [signal];
    const evidenceFamilies = Array.isArray(raw.evidenceFamilies)
      ? raw.evidenceFamilies.filter((item, index, list) => EVIDENCE_FAMILIES.includes(item) && list.indexOf(item) === index)
      : [];
    return [{
      ...signal,
      confidence: CONFIDENCE.includes(raw.confidence) ? raw.confidence : "emerging",
      trend: TRENDS.includes(raw.trend) ? raw.trend : "stable",
      evidenceFamilies,
    }];
  });
  signals.sort((a, b) => FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family)
    || CONFIDENCE.indexOf(a.confidence ?? "emerging") - CONFIDENCE.indexOf(b.confidence ?? "emerging"));
  return { enabled: true, viewer, signals };
}

export function signalsForMemberSurface(signals, surface) {
  return (signals || []).filter((signal) => (MEMBER_SURFACES[signal.family] || []).includes(surface));
}

// Old buildReasonSummary (engine.ts:84-92) for staff, privacy.ts copy for members.
export function reasonCopy(signal, viewer) {
  if (viewer !== "staff") return { key: `issueIntelligence.${signal.key}.memberReason` };
  const labels = (signal.evidenceFamilies || []).slice(0, 3);
  return { key: "issueIntelligence.staff.reason", evidence: labels };
}

// The staff card shows the family title and the confidence tag above this
// line, so the headline adds only the channel count
// (UB-UG-ISSUE-INTELLIGENCE-CARD-REPEATS-ITS-TITLE-20261108).
export function headlineCopy(signal, viewer) {
  if (viewer !== "staff") return { key: `issueIntelligence.${signal.key}.memberHeadline` };
  return {
    key: `issueIntelligence.${signal.key}.staffHeadline`,
    vars: { count: (signal.evidenceFamilies || []).length },
  };
}

// Old buildIssueThreadSummary / buildMemberSafeIssueThreadSummary.
export function summaryCopy(signal, viewer) {
  const base = viewer === "staff" ? `issueIntelligence.${signal.key}.staff` : `issueIntelligence.${signal.key}.member`;
  return {
    whatItIs: `${base}WhatItIs`,
    whyItMatters: `${base}WhyItMatters`,
    whatChanged: viewer === "staff" && signal.confidence === "strong"
      ? { key: `issueIntelligence.${signal.key}.staffWhatChanged`, vars: { count: (signal.evidenceFamilies || []).length } }
      : null,
  };
}

// Old buildGuidanceRecommendations (output.ts:45-111): the "boosted" rights
// guidance. Destinations are app views the member can already open.
export function guidanceRecommendations(signal, viewer = "member") {
  if (signal.family === ISSUE_FAMILIES.retaliation) {
    return [
      { kind: "rights_explainer", destination: "rights" },
      { kind: "report_path", destination: "cases" },
      { kind: "checklist", destination: "memberSupport" },
      { kind: "form", destination: "forms" },
    ];
  }
  // No contract-article recommendation: Union Ground has no contract
  // clauses to open (owner decision, 2026-10-13).
  const recommendations = [
    { kind: "rights_explainer", destination: "rights" },
  ];
  // Members never see confidence; staff gating follows the old thresholds and
  // members get the whole list (the server already decided a pattern exists).
  const confidence = viewer === "staff" ? signal.confidence : "strong";
  if (confidence === "active" || confidence === "strong") recommendations.push({ kind: "faq", destination: "qa" });
  if (confidence === "strong") recommendations.push({ kind: "checklist", destination: "memberSupport" });
  return recommendations;
}

// Staff coordination actions (output.ts:113-197). Members never receive them
// (old privacy.ts STAFF_ONLY_ACTION_KINDS).
export function actionRecommendations(signal, viewer) {
  if (viewer !== "staff") return [];
  if (signal.family === ISSUE_FAMILIES.retaliation) {
    return [
      { kind: "retaliation_review", destination: "steward" },
      { kind: "task_followup", destination: "tasks" },
      { kind: "steward_followup", destination: "messages" },
    ];
  }
  const actions = [
    { kind: "steward_followup", destination: "messages" },
    { kind: "outreach_group", destination: "qaQueue" },
  ];
  if (signal.confidence === "strong") actions.push({ kind: "poll_suggestion", destination: "campaigns" });
  if ((signal.evidenceFamilies || []).includes("cases")) actions.push({ kind: "escalation_review", destination: "steward" });
  return actions;
}

// Old buildPollSuggestion (output.ts:226-255): offered to staff only when the
// contract-rights signal is strong (old app/dashboard/polls/page.tsx:204-215).
export const POLL_DRAFT_KEYS = Object.freeze(["rightsAwareness", "contractConfusion", "protectionConfidence"]);

export function pollDrafts(signal, viewer) {
  if (viewer !== "staff" || signal.family !== ISSUE_FAMILIES.contractRights || signal.confidence !== "strong") return [];
  return POLL_DRAFT_KEYS.map((key) => ({
    key,
    labelKey: `issueIntelligence.poll.${key}.label`,
    questionKey: `issueIntelligence.poll.${key}.question`,
  }));
}

// A poll draft travels to the staff survey editor as plain, bounded text in
// the query string; StaffEngagement reads it once and clears it.
export const ISSUE_DRAFT_PARAM = "issueDraft";
export const ISSUE_DRAFT_MAX = 280;

// Plain text only: control characters and angle brackets become spaces.
function cleanDraft(value) {
  return Array.from(String(value || ""), (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 || char === "<" || char === ">" ? " " : char;
  }).join("").trim().slice(0, ISSUE_DRAFT_MAX);
}

export function issueDraftHref(question) {
  return `/m/campaigns?${ISSUE_DRAFT_PARAM}=${encodeURIComponent(cleanDraft(question))}`;
}

// In-app destinations for guidance and follow-up links. Staff tools are
// marked so the shell applies its staff navigation and hat gate.
export const ISSUE_DESTINATIONS = Object.freeze({
  rights: { view: "rights", path: "/m/rights", staff: false },
  qa: { view: "qa", path: "/m/qa", staff: false },
  cases: { view: "cases", path: "/m/cases", staff: false },
  forms: { view: "forms", path: "/m/forms", staff: false },
  memberSupport: { view: "memberSupport", path: "/m/support", staff: false },
  messages: { view: "messages", path: "/m/messages", staff: false },
  steward: { view: "steward", path: "/m/steward", staff: true },
  tasks: { view: "tasks", path: "/m/tasks", staff: true },
  qaQueue: { view: "qaQueue", path: "/m/qa-queue", staff: true },
  campaigns: { view: "campaigns", path: "/m/campaigns", staff: true },
});

export function joinEvidenceList(labels, andWord) {
  const list = (labels || []).filter(Boolean);
  if (list.length <= 1) return list[0] || "";
  return `${list.slice(0, -1).join(", ")} ${andWord} ${list[list.length - 1]}`;
}

export function readIssueDraft(search) {
  let value;
  try {
    value = new URLSearchParams(search || "").get(ISSUE_DRAFT_PARAM);
  } catch {
    return null;
  }
  const text = cleanDraft(value);
  return text.length >= 8 ? text : null;
}

// Weekly digest (REQ-UG-ISSUE-INTELLIGENCE-WEEKLY-DIGEST-20261001). The
// server stores coarse bands only; anything else is dropped here.
const DIGEST_CONFIDENCE = ["high", "medium", "low"];
const DIGEST_BANDS = ["few", "several", "many"];
const DIGEST_BAND_KEYS = ["qa", "messages", "cases", "polls", "retaliationReports", "kyr"];
export const DIGEST_RECOMMENDATIONS = Object.freeze(["publish_explainer", "brief_stewards", "run_full_poll"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeDigest(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
  if (!FAMILY_ORDER.includes(raw.family) || !ISO_DATE.test(String(raw.windowStart)) || !ISO_DATE.test(String(raw.windowEnd))) return null;
  const evidence = raw.evidence && typeof raw.evidence === "object" ? raw.evidence : {};
  const bands = DIGEST_BAND_KEYS.flatMap((key) => (DIGEST_BANDS.includes(evidence[key]) ? [{ key, band: evidence[key] }] : []));
  const ai = raw.ai && typeof raw.ai === "object" ? raw.ai : {};
  const summary = ai.summary && typeof ai.summary === "object" && typeof ai.summary.summary === "string" ? {
    summary: ai.summary.summary,
    recommendations: Array.isArray(ai.summary.recommendations) ? ai.summary.recommendations.filter((item) => typeof item === "string").slice(0, 3) : [],
    caution: typeof ai.summary.caution === "string" ? ai.summary.caution : null,
  } : null;
  const status = ai.status === "enriched" && summary ? "enriched" : ai.status === "available" ? "available" : "off";
  return {
    id: raw.id,
    family: raw.family,
    key: familyKey(raw.family),
    windowStart: raw.windowStart,
    windowEnd: raw.windowEnd,
    confidence: DIGEST_CONFIDENCE.includes(raw.confidence) ? raw.confidence : "low",
    trend: TRENDS.includes(raw.trend) ? raw.trend : "stable",
    bands,
    reviewedThemes: evidence.reviewedThemes === true,
    recommendations: (Array.isArray(raw.recommendations) ? raw.recommendations : [])
      .filter((item, index, list) => DIGEST_RECOMMENDATIONS.includes(item) && list.indexOf(item) === index),
    ai: { status, summary: status === "enriched" ? summary : null },
  };
}

export function normalizeWeeklyDigests(payload) {
  if (!payload || typeof payload !== "object" || payload.enabled !== true) return { enabled: false, digests: [] };
  const digests = (Array.isArray(payload.digests) ? payload.digests : []).map(normalizeDigest).filter(Boolean);
  digests.sort((a, b) => FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family));
  return { enabled: true, digests };
}
