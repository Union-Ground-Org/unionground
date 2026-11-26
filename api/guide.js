import { readCompassContext, compassContextMatches, compassScopeNotices } from "./_lib/compassContext.js";
import { scheduleCompassTraining } from "./_lib/compassTraining.js";
import { CASE_HELP_QUESTIONS, COMPASS_PAGE_LABELS, FIELD_NOTES_PACKET_INSTRUCTION, buildAutomationDraftMessages, buildCaseHelpMessages, buildFieldNotesPacketMessages, fieldNotesPacketRetrievalQuery, buildGuideMessages, buildIssueDigestMessages, buildPollDraftMessages, buildUsageDigestMessages, buildMessageBriefingMessages, buildStaffDataMessages, compassNoSourceAnswer, compassRetrievalQuery, minimizedCompassSourceIndexes } from "./_lib/compassPrompts.js";
import { buildCaseFacts } from "./_lib/compassCaseHelp.js";
import { COMPASS_QUESTION_WITHHELD_ERROR, productGuideSources } from "./_lib/compassProductGuide.js";
import { compassCitedSources, splitCompassAnswerSources } from "./_lib/compassCitedSources.js";
import { buildFieldNotesPacketFacts } from "./_lib/compassFieldNotes.js";
import { readOrganizationSettings } from "./_lib/organizationSettings.js";
import { buildStaffDataFacts, restorePlaceholderNames } from "./_lib/compassStaffData.js";
import { classifyDataTopics, validDataTopics } from "../src/features/compass/dataTopics.js";
export { buildAutomationDraftMessages, buildGuideMessages, buildPollDraftMessages, buildMessageBriefingMessages, CLIENT_HISTORY_ROLE } from "./_lib/compassPrompts.js";
import { normalizeAutomationProposal } from "../src/features/automation/proposals.js";
import { authenticate, bearerToken, json, methodGuard, unionGroundProvider, requireEnv, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";
import { completeWithMeshFailover } from "./_lib/compassFailover.js";
import { embedCompassQuestion, hybridRetrievalEnabled } from "./_lib/compassEmbeddings.js";
import {
  COMPASS_AI_CONFIG,
  FIREWORKS_GATEWAY,
  attestedDigestFromEvidence,
  connectorModelMatches,
  meshEnvironmentTag,
  normalizeResolvedProvider,
  safeGatewayDiagnostic,
} from "./_lib/compassAiGovernance.js";
import { answerPathOutage, schedulePlatformAlert } from "./_lib/platformAlerts.js";

function privacyFailure(response) {
  console.error("[guide] minimization failure", { cause: "redaction_failed" });
  return json(response, 503, { code: "compass_privacy_unavailable", error: "Union Ground Guide could not safely prepare that request." });
}

function acceptedGuideModel(completion, provider) {
  const reported = completion?.model;
  if (typeof reported !== "string" || typeof provider?.model !== "string") return null;
  if (provider.connector) {
    return connectorModelMatches(provider.model, reported, provider.connector.modelPattern) ? reported : null;
  }
  return reported === provider.model ? reported : null;
}

export function publicGuideMeta(completion = {}, provider = { model: COMPASS_AI_CONFIG.model }) {
  const usage = completion?.usage;
  const promptTokens = Number(usage?.prompt_tokens ?? usage?.promptTokens);
  const completionTokens = Number(usage?.completion_tokens ?? usage?.completionTokens);
  const totalTokens = Number(usage?.total_tokens ?? usage?.totalTokens);
  const safeUsage = [promptTokens, completionTokens, totalTokens].every((value) => Number.isFinite(value) && value >= 0)
    ? { promptTokens, completionTokens, totalTokens }
    : null;
  return {
    model: acceptedGuideModel(completion, provider),
    usage: safeUsage,
  };
}

// Union Ground has no approved AI mesh. The sibling product's mesh hosts
// (api/_lib/compassAiGovernance.js MESH_ENDPOINTS) are never reached from
// here: the mesh is always unconfigured, so a platform resolution that selects
// it refuses as mesh_unconfigured instead of dispatching. Only an explicitly
// governed connector provider could answer, and only once a Union Ground
// provider and its credentials exist.
function meshAccess() {
  return { surface: "saas", endpoint: "", credentials: Object.freeze({}), configured: false };
}

function governanceRpcArgs(provider) {
  return {
    p_gateway: provider.gateway,
    p_model: provider.model,
    p_zero_data_retention: COMPASS_AI_CONFIG.providerPolicy.zeroDataRetention,
    p_disallow_prompt_training: COMPASS_AI_CONFIG.providerPolicy.disallowPromptTraining,
  };
}

// Platform resolution selects mesh; a separately authorized outage may use Fireworks.
async function resolveProvider(supabaseUrl, serviceRoleKey, userId) {
  const row = await supabaseRpc(supabaseUrl, serviceRoleKey, serviceRoleKey, "resolve_compass_ai_provider", { p_user_id: userId });
  const provider = normalizeResolvedProvider(row);
  if (!provider) throw Object.assign(new Error("provider-unresolved"), { cause: "config" });
  return provider;
}

// This is intentionally ONE governed RPC with no legacy fallback. A missing
// function means the default-OFF policy/attestation gate has not landed yet,
// so availability would be a security downgrade.
async function reserveWithCause(supabaseUrl, serviceRoleKey, userId, provider) {
  return supabaseRpc(
    supabaseUrl,
    serviceRoleKey,
    serviceRoleKey,
    "reserve_compass_ai_request",
    { p_user_id: userId, ...governanceRpcArgs(provider) },
  );
}

// Agency-level usage counters (contract §7): one org-level increment, no
// member column, never allowed to fail the member's request.
async function recordOutcome(supabaseUrl, serviceRoleKey, reservationId, userId, outcome) {
  try {
    await supabaseRpc(supabaseUrl, serviceRoleKey, serviceRoleKey, "record_compass_ai_request_outcome", { p_request_id: reservationId, p_user_id: userId, p_outcome: outcome });
  } catch {
    // Counting is best-effort; the answer path never depends on it.
  }
}

// Missing primary credentials are a configuration refusal, not an outage.
async function resolveAndReserve(supabaseUrl, serviceRoleKey, userId, mesh) {
  const provider = await resolveProvider(supabaseUrl, serviceRoleKey, userId);
  if (!provider.connector && !mesh?.configured) throw Object.assign(new Error("mesh-unconfigured"), { cause: "mesh_unconfigured" });
  const reservation = await reserveWithCause(supabaseUrl, serviceRoleKey, userId, provider);
  return { provider, reservation };
}

// UX-UG-COMPASS-STEWARD-ANSWER-SAYS-CONTACT-YOUR-STEWARD-20261107
// (#7434): the reader's role frames the answer's closing guidance only. The
// reservation's role reads organization grants alone, and most stewards hold
// a chapter role, so the caller's own member_has_role check (an organization
// grant or a chapter role in the selected chapter of the active organization,
// the same check every staff desk makes, as the caller) counts too. The
// highest role held wins. Never a client field; any refusal or failure reads
// as a member, which is today's framing.
const READER_ROLE_PRECEDENCE = ["admin", "vp", "coordinator", "advisor", "steward"];
async function readerRole(supabaseUrl, publishableKey, token, reservationRole) {
  const held = new Set(READER_ROLE_PRECEDENCE.includes(reservationRole) ? [reservationRole] : []);
  const hasRole = (roles) => supabaseRpc(supabaseUrl, publishableKey, token, "member_has_role", { p_roles: roles })
    .then((result) => result === true, () => false);
  if (await hasRole(READER_ROLE_PRECEDENCE)) {
    const checks = await Promise.all(READER_ROLE_PRECEDENCE.map((role) => hasRole([role])));
    READER_ROLE_PRECEDENCE.forEach((role, index) => { if (checks[index]) held.add(role); });
  }
  return READER_ROLE_PRECEDENCE.find((role) => held.has(role)) ?? "member";
}

function notConfigured(response) {
  return json(response, 503, { error: "Union Ground Guide is not configured." });
}

async function completeWithProvider({ supabaseUrl, serviceRoleKey, userId, reservationId, access, messages, contextEnvelope }) {
  const dispatch = await supabaseRpc(
    supabaseUrl,
    serviceRoleKey,
    serviceRoleKey,
    "authorize_compass_ai_dispatch",
    { p_request_id: reservationId, p_user_id: userId, ...governanceRpcArgs(access.provider) },
  );
  if (dispatch?.authorized !== true || contextEnvelope && !compassContextMatches(contextEnvelope, dispatch)) {
    throw Object.assign(new Error("dispatch-unavailable"), { cause: dispatch?.cause || "governance_unavailable" });
  }
  let result;
  try {
    result = await completeWithMeshFailover({
      messages, access, attestedDigest: attestedDigestFromEvidence(dispatch?.evidence_ref),
      authorizeFailover: async (cause) => {
        const authorization = await supabaseRpc(supabaseUrl, serviceRoleKey, serviceRoleKey,
          "authorize_compass_ai_failover", { p_request_id: reservationId, p_user_id: userId, p_cause: cause });
        // A context-bound request fails over only inside the same isolation
        // scope: the reservation's organization (or the member when none).
        if (contextEnvelope && authorization?.authorized === true
            && authorization.isolation_scope !== (contextEnvelope.organization_id ?? userId)) {
          return { authorized: false, cause: "governance_unavailable" };
        }
        return authorization;
      },
    });
  } catch (error) {
    // Every structured mode shares this path, so the outage alert lives here.
    const outage = answerPathOutage(error, access.provider);
    if (outage) schedulePlatformAlert({ kind: "answer_path_down", environment: meshEnvironmentTag(access.surface), route: "guide", ...outage, reservationId });
    throw error;
  }
  if (result.provider?.gateway === FIREWORKS_GATEWAY) {
    schedulePlatformAlert({ kind: "fireworks_takeover", environment: meshEnvironmentTag(access.surface), route: "guide",
      cause: result.failoverCause, gateway: result.provider.gateway, model: result.provider.model, reservationId });
  }
  return { content: result.content, meta: publicGuideMeta(result.completion, result.provider), provider: result.provider };
}

// A completed reply the structured mode could not use leaves the member with
// a 502: an outage for the operator, attributed to the provider that produced
// the reply (Fireworks after a takeover, whose own alert has already posted).
function scheduleInvalidResultAlert(completion, access, reservationId) {
  schedulePlatformAlert({
    kind: "answer_path_down", environment: meshEnvironmentTag(access.surface), route: "guide", cause: "invalid_result",
    gateway: completion?.provider?.gateway, model: completion?.provider?.model, reservationId,
  });
}

async function releaseReservation(supabaseUrl, serviceRoleKey, reservationId) {
  try {
    await supabaseRpc(
      supabaseUrl,
      serviceRoleKey,
      serviceRoleKey,
      "release_member_ai_request",
      { p_request_id: reservationId },
    );
  } catch {
    // A leaked reservation counts against both caps until its hour rolls over.
    // The opaque reservation UUID is safe diagnostic context; no member text
    // or identity is logged.
    console.error("[guide] release_member_ai_request failed", { reservationId, cause: "release_failed" });
  }
}

// Whether the semantic lane has anything to find for this member: at least one
// current chunk of an eligible article in the active organization, under the
// hybrid RPC's own gates. Any failure (including a database that predates the
// hybrid_ready kind) means "not ready", which keeps retrieval lexical.
async function hybridIndexReady(supabaseUrl, publishableKey, token) {
  try {
    return (await readCompassContext(supabaseUrl, publishableKey, token, "hybrid_ready")).data === true;
  } catch {
    return false;
  }
}

// Retrieval failures always release their reservation: an infrastructure fault
// is not a completed member request. This process-local ledger is diagnostic
// bookkeeping only and must never decide refund eligibility. Bound it separately
// with an idle TTL and LRU eviction so a long-lived instance cannot retain an
// unbounded number of member identifiers during an outage.
const RETRIEVAL_REFUND_ENTRY_TTL_MS = 60 * 60 * 1000;
const RETRIEVAL_REFUND_LEDGER_LIMIT = 200;
const retrievalRefundLedger = new Map();

function recordRetrievalRefund(userId, now = Date.now()) {
  for (const [member, entry] of retrievalRefundLedger) {
    if (now - entry.lastSeen >= RETRIEVAL_REFUND_ENTRY_TTL_MS) retrievalRefundLedger.delete(member);
  }
  const previous = retrievalRefundLedger.get(userId);
  if (previous) retrievalRefundLedger.delete(userId);
  while (retrievalRefundLedger.size >= RETRIEVAL_REFUND_LEDGER_LIMIT) {
    retrievalRefundLedger.delete(retrievalRefundLedger.keys().next().value);
  }
  retrievalRefundLedger.set(userId, { lastSeen: now, refunds: (previous?.refunds || 0) + 1 });
}

export function retrievalRefundLedgerSizeForTest() {
  return retrievalRefundLedger.size;
}

export function parseStructuredAnswer(content) {
  const text = String(content || "").trim();
  if (!text || text.length > 20_000) throw new Error("structured-answer-invalid");
  const unwrapped = text.startsWith("```")
    ? text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : text;
  const parsed = JSON.parse(unwrapped);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.getPrototypeOf(parsed) !== Object.prototype) {
    throw new Error("structured-answer-invalid");
  }
  return parsed;
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedText(value, maximum) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function validRetrievalRow(row) {
  return row && !Array.isArray(row) && typeof row === "object"
    && ["source_id", "kind", "title", "ref", "snippet"]
      .every((key) => typeof row[key] === "string" && row[key].trim().length > 0);
}

// Echo back only the markers the server itself put in the prompt, with the
// server's own title — the old honesty contract
// (de7df4b57c^ lib/field-notes/packet-prompt.ts:120-131). A model that cited
// nothing usable gets an empty list rather than the whole registry, so an
// uncited source is never presented as backing the draft.
export function verifyPacketCitations(used, registry) {
  const seen = new Set();
  const verified = [];
  for (const candidate of Array.isArray(used) ? used : []) {
    const match = registry.find((entry) => entry.marker === candidate?.marker);
    if (match && !seen.has(match.marker)) {
      seen.add(match.marker);
      verified.push({ marker: match.marker, title: match.title });
    }
  }
  return verified;
}

// Provider JSON is untrusted. Validate its complete, mode-specific shape before
// it can be normalized, persisted, or returned; coercion would turn malformed
// model output into an apparently valid staff action.
export function validateStructuredAnswer(mode, structured) {
  if (!structured || Array.isArray(structured) || typeof structured !== "object") throw new Error("structured-answer-invalid");
  if (mode === "poll_draft") {
    if (!exactKeys(structured, ["title", "description", "options", "resultsVisibility", "eligibility"])
        || !boundedText(structured.title, 240)
        || typeof structured.description !== "string" || structured.description.length > 4000
        || !boundedText(structured.resultsVisibility, 40)
        || !boundedText(structured.eligibility, 40)
        || !Array.isArray(structured.options) || structured.options.length < 2 || structured.options.length > 6
        || structured.options.some((option) => !option || Array.isArray(option) || typeof option !== "object"
          || !exactKeys(option, ["label"]) || !boundedText(option.label, 160))) {
      throw new Error("structured-answer-invalid");
    }
    return {
      title: structured.title.trim(),
      description: structured.description.trim(),
      options: structured.options.map((option) => ({ label: option.label.trim() })),
      // These values are policy, never model discretion.
      resultsVisibility: "after_close",
      eligibility: "organization",
    };
  }
  if (mode === "message_briefing") {
    if (!exactKeys(structured, ["summary", "actionItems"])
        || !boundedText(structured.summary, 1200)
        || !Array.isArray(structured.actionItems) || structured.actionItems.length > 6
        || structured.actionItems.some((item) => !boundedText(item, 300))) {
      throw new Error("structured-answer-invalid");
    }
    return { summary: structured.summary.trim(), actionItems: structured.actionItems.map((item) => item.trim()) };
  }
  if (mode === "field_notes_packet") {
    // The old DraftSchema (de7df4b57c^ app/api/field-notes/draft-packet/route.ts:28-35)
    // with its bounds. Markers are checked against the server's own registry
    // by verifyPacketCitations below, never trusted from the model.
    const { headline, summary, plainLanguage, checklist, questions, citations } = structured;
    if (!exactKeys(structured, ["headline", "summary", "plainLanguage", "checklist", "questions", "citations"])
        || !boundedText(headline, 120) || !boundedText(summary, 600) || !boundedText(plainLanguage, 1200)
        || !Array.isArray(checklist) || checklist.length > 10 || checklist.some((item) => !boundedText(item, 200))
        || !Array.isArray(questions) || questions.length < 1 || questions.length > 8
        || questions.some((item) => !boundedText(item, 200))
        || !Array.isArray(citations) || citations.length > 20
        || citations.some((item) => !item || Array.isArray(item) || typeof item !== "object"
          || !exactKeys(item, ["marker", "title"]) || !boundedText(item.marker, 8) || !boundedText(item.title, 200))) {
      throw new Error("structured-answer-invalid");
    }
    return {
      headline: headline.trim(),
      summary: summary.trim(),
      plainLanguage: plainLanguage.trim(),
      checklist: checklist.map((item) => item.trim()),
      questions: questions.map((item) => item.trim()),
      citations: citations.map((item) => ({ marker: item.marker.trim(), title: item.title.trim() })),
    };
  }
  if (mode === "issue_digest") {
    const caution = structured.caution;
    if (!exactKeys(structured, ["summary", "recommendations", "caution"])
        || !boundedText(structured.summary, 600) || structured.summary.trim().length < 20
        || !Array.isArray(structured.recommendations) || structured.recommendations.length > 3
        || structured.recommendations.some((item) => !boundedText(item, 160) || item.trim().length < 4)
        || (caution !== null && (!boundedText(caution, 200) || caution.trim().length < 4))) {
      throw new Error("structured-answer-invalid");
    }
    return {
      summary: structured.summary.trim(),
      recommendations: structured.recommendations.map((item) => item.trim()),
      caution: caution === null ? null : caution.trim(),
    };
  }
  if (mode === "usage_digest") {
    // REQ-UG-AI-USAGE-DIGEST-20261001: wording for one stored aggregate
    // usage digest. Same bounds the database enforces in
    // public.save_analytics_usage_digest_ai.
    const caution = structured.caution;
    if (!exactKeys(structured, ["summary", "highlights", "caution"])
        || !boundedText(structured.summary, 600) || structured.summary.trim().length < 20
        || !Array.isArray(structured.highlights) || structured.highlights.length > 3
        || structured.highlights.some((item) => !boundedText(item, 160) || item.trim().length < 4)
        || (caution !== null && (!boundedText(caution, 200) || caution.trim().length < 4))) {
      throw new Error("structured-answer-invalid");
    }
    return {
      summary: structured.summary.trim(),
      highlights: structured.highlights.map((item) => item.trim()),
      caution: caution === null ? null : caution.trim(),
    };
  }
  throw new Error("structured-answer-invalid");
}

function reservationFailure(reservation) {
  if (reservation?.cause === "shared") return { status: 429, payload: { code: "shared_rate_limit", error: "Union Ground Guide is at the shared hourly limit. Try again shortly." } };
  if (reservation?.cause === "role") return { status: 429, payload: { code: "role_rate_limit", error: "You’ve reached your Union Ground Guide limit for this hour." } };
  if (reservation?.cause === "disabled") return { status: 503, payload: { code: "compass_paused", error: "Union Ground Guide is paused by an administrator." } };
  return { status: 503, payload: { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." } };
}

async function governedStructuredCompletion({ supabaseUrl, serviceRoleKey, userId, reservation, messages, access, contextEnvelope }) {
  const reservationId = typeof reservation?.id === "string" ? reservation.id : null;
  if (!reservationId) throw Object.assign(new Error("reservation-unavailable"), { reservation });
  try {
    return await completeWithProvider({ supabaseUrl, serviceRoleKey, userId, reservationId, access, messages, contextEnvelope });
  } catch (error) {
    await releaseReservation(supabaseUrl, serviceRoleKey, reservationId);
    throw error;
  }
}

// public.authorize_engagement_staff refuses with SQLSTATE 42501 (PostgREST 403)
// or the session is rejected (401). Anything else, including the supabaseRpc
// timeout, is unavailability rather than a missing staff role.
function engagementStaffRefused(error) {
  return error?.code === "42501" || error?.status === 401 || error?.status === 403;
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// REQ-UG-COMPASS-STAFF-DATA-ANSWERS-20261001. Staff ask about their own
// organization's figures. The server picks the topics (never the model), reads
// the staff-only, switch-gated aggregate context AS THE CALLER, keeps numbers
// and closed labels only, and dispatches through the same governed path with
// the context's organization bound to the dispatch organization.
async function staffDataAnswer({ request, response, supabaseUrl, publishableKey, serviceRoleKey, token, user, mesh }) {
  const question = String(request.body?.question || "").trim();
  if (!question || question.length > 1200) return json(response, 400, { error: "Ask a question between 1 and 1,200 characters." });
  const topics = [...new Set([...classifyDataTopics(question), ...validDataTopics(request.body?.topics)])];
  if (!topics.length) {
    return json(response, 400, { code: "no_data_topic", error: "Ask about issue outcomes, issue load, participation, campaign health or bargaining." });
  }
  let contextEnvelope;
  let facts;
  try {
    contextEnvelope = await supabaseRpc(supabaseUrl, publishableKey, token, "get_compass_staff_data_context", { p_topics: topics });
  } catch (error) {
    if (error?.code === "55000") return json(response, 403, { code: "feature_disabled", error: "Answers from your organization's figures are turned off." });
    if (error?.code === "42501" || error?.status === 401 || error?.status === 403) {
      return json(response, 403, { code: "staff_required", error: "A staff role is required for answers from your organization's figures." });
    }
    return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
  }
  try {
    if (!UUID.test(String(contextEnvelope?.organization_id || ""))) throw new Error("staff-data-scope");
    facts = buildStaffDataFacts(contextEnvelope);
  } catch {
    return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
  }
  if (!facts.available) {
    // Nothing to summarize: no provider call and no quota spent.
    return json(response, 200, {
      code: "no_figures",
      answer: "None of those figures are available to you right now. Ask an administrator if you expected to see them.",
      sources: [],
      figures: { topics: facts.topics },
      meta: { model: "data-gate", usage: null },
    });
  }
  let messages;
  try { messages = buildStaffDataMessages(question, facts); }
  catch { return privacyFailure(response); }

  let reservation;
  let provider;
  try { ({ provider, reservation } = await resolveAndReserve(supabaseUrl, serviceRoleKey, user.id, mesh)); }
  catch (error) {
    if (error?.cause === "mesh_unconfigured") return notConfigured(response);
    return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
  }
  if (!reservation?.id) {
    const failure = reservationFailure(reservation);
    return json(response, failure.status, failure.payload);
  }
  let completion;
  try {
    completion = await governedStructuredCompletion({
      supabaseUrl, serviceRoleKey, userId: user.id, reservation, messages, contextEnvelope, access: { ...mesh, provider },
    });
  } catch (error) {
    const paused = error?.cause === "disabled";
    return json(response, paused ? 503 : 502, {
      code: paused ? "compass_paused" : "gateway_unavailable",
      error: paused ? "Union Ground Guide is paused by an administrator." : "Union Ground Guide could not complete that request right now.",
    });
  }
  await recordOutcome(supabaseUrl, serviceRoleKey, reservation.id, user.id, "answered");
  // The provider never saw which custom step was asked about, so the server
  // adds that step's figures (BUG-UG-COMPASS-STAFF-QUESTION-NAMES-PLACEHOLDER-STEP-20261013).
  return json(response, 200, {
    answer: restorePlaceholderNames(completion.content, facts.legend),
    sources: [],
    figures: { topics: facts.topics },
    meta: completion.meta,
  });
}

// REQ-UG-COMPASS-PAGE-AND-CASE-AWARE-HELP-20261001: "Ask Compass about
// this case". The browser sends a case id and one of three fixed question
// keys; the case is re-read through the caller's own authorization
// (get_compass_case_context), minimized, bound to the dispatch organization,
// answered with a per-request provider cache scope, and never saved.
async function caseHelpAnswer({ request, response, supabaseUrl, publishableKey, serviceRoleKey, token, user, mesh }) {
  const caseId = String(request.body?.caseId || "");
  const questionKey = String(request.body?.questionKey || "");
  if (!UUID.test(caseId) || !Object.hasOwn(CASE_HELP_QUESTIONS, questionKey)) {
    return json(response, 400, { error: "Choose an issue and one of the suggested questions." });
  }
  let caseEnvelope;
  let facts;
  try {
    caseEnvelope = await supabaseRpc(supabaseUrl, publishableKey, token, "get_compass_case_context", { p_case_id: caseId });
  } catch (error) {
    if (error?.code === "55000") return json(response, 403, { code: "feature_disabled", error: "Issue help is turned off for your organization." });
    if (error?.code === "P0002") return json(response, 404, { code: "case_unavailable", error: "That issue is unavailable." });
    if (error?.code === "42501" || error?.status === 401 || error?.status === 403) return json(response, 403, { code: "case_unavailable", error: "That issue is unavailable." });
    return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
  }
  try {
    if (!UUID.test(String(caseEnvelope?.organization_id || ""))) throw new Error("case-scope");
    facts = buildCaseFacts(caseEnvelope);
  } catch {
    return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
  }

  let reservation;
  let provider;
  try { ({ provider, reservation } = await resolveAndReserve(supabaseUrl, serviceRoleKey, user.id, mesh)); }
  catch (error) {
    if (error?.cause === "mesh_unconfigured") return notConfigured(response);
    return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
  }
  if (!reservation?.id) {
    const failure = reservationFailure(reservation);
    return json(response, failure.status, failure.payload);
  }

  // Verified chapter sources for the fixed question, best effort: the case
  // facts alone still answer "what happens next". A retrieval from another
  // organization is refused, never merged.
  let grounded = [];
  try {
    const retrieval = await readCompassContext(supabaseUrl, publishableKey, token, "lexical", { p_query: CASE_HELP_QUESTIONS[questionKey] });
    if (!compassContextMatches(caseEnvelope, retrieval)) {
      await releaseReservation(supabaseUrl, serviceRoleKey, reservation.id);
      return json(response, 503, { code: "governance_unavailable", error: "Your organization context changed. Try again." });
    }
    grounded = (Array.isArray(retrieval.data) ? retrieval.data : [])
      .filter((row) => validRetrievalRow(row) && row.kind !== "case" && !String(row.source_id).startsWith("case:"))
      .slice(0, 4);
  } catch {
    grounded = [];
  }
  let messages;
  try { messages = buildCaseHelpMessages(questionKey, facts, grounded); }
  catch {
    try { grounded = []; messages = buildCaseHelpMessages(questionKey, facts, []); }
    catch {
      await releaseReservation(supabaseUrl, serviceRoleKey, reservation.id);
      return privacyFailure(response);
    }
  }
  const sources = minimizedCompassSourceIndexes(messages).map((index) => ({
    id: String(grounded[index].source_id).slice(0, 160),
    kind: String(grounded[index].kind).slice(0, 40),
    title: String(grounded[index].title).slice(0, 160),
    ref: String(grounded[index].ref).slice(0, 80),
  }));
  let completion;
  try {
    completion = await governedStructuredCompletion({
      supabaseUrl, serviceRoleKey, userId: user.id, reservation, messages, contextEnvelope: caseEnvelope,
      access: { ...mesh, provider, cacheIsolation: "request" },
    });
  } catch (error) {
    const paused = error?.cause === "disabled";
    return json(response, paused ? 503 : 502, {
      code: paused ? "compass_paused" : "gateway_unavailable",
      error: paused ? "Union Ground Guide is paused by an administrator." : "Union Ground Guide could not answer right now. Try again shortly.",
    });
  }
  await recordOutcome(supabaseUrl, serviceRoleKey, reservation.id, user.id, "answered");
  return json(response, 200, { answer: completion.content, sources, meta: completion.meta });
}

// REQ-UG-FIELD-NOTES-AI-PACKET-20261001. Staff assemble a draft packet
// from field notes on one task. The database decides whether the caller holds
// a staff role, whether the task and every selected note are readable in the
// caller's own chapter, whether both the packet switch and the organization AI
// switch are on, and how many notes one packet may use; the server then adds
// verified chapter sources and dispatches through the same governed path with
// the context's organization bound to the dispatch organization. The draft is
// returned for review and never saved.
async function fieldNotesPacket({ request, response, supabaseUrl, publishableKey, serviceRoleKey, token, user, mesh }) {
  const taskId = String(request.body?.taskId || "");
  const noteIds = Array.isArray(request.body?.noteIds) ? request.body.noteIds : [];
  if (!UUID.test(taskId) || noteIds.length < 1 || noteIds.length > 24
      || noteIds.some((id) => typeof id !== "string" || !UUID.test(id))
      || new Set(noteIds).size !== noteIds.length) {
    return json(response, 400, { error: "Choose a task and between 1 and 24 of its field notes." });
  }
  let contextEnvelope;
  let facts;
  try {
    contextEnvelope = await supabaseRpc(supabaseUrl, publishableKey, token, "get_compass_field_notes_packet_context", {
      p_task_id: taskId,
      p_note_ids: noteIds,
    });
  } catch (error) {
    if (error?.code === "55000") return json(response, 403, { code: "feature_disabled", error: "Draft packets from field notes are turned off for your organization." });
    if (error?.code === "P0002") return json(response, 404, { code: "notes_unavailable", error: "That task is unavailable." });
    if (error?.code === "22023") return json(response, 400, { error: "Choose a task and between 1 and 24 of its field notes." });
    if (error?.code === "42501" || error?.status === 401 || error?.status === 403) {
      return json(response, 403, { code: "staff_required", error: "A staff role is required to draft a packet." });
    }
    return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
  }
  try {
    if (!UUID.test(String(contextEnvelope?.organization_id || ""))) throw new Error("field-notes-scope");
    facts = buildFieldNotesPacketFacts(contextEnvelope);
  } catch {
    return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
  }
  if (!facts.notes.length) {
    // Nothing usable survived selection or minimization: no provider call and
    // no quota spent.
    return json(response, 200, {
      code: "no_notes",
      packet: null,
      sources: [],
      meta: { model: "notes-gate", usage: null },
    });
  }

  // Minimize before spending quota: a selection whose every note is wholly
  // withheld is refused without a reservation or a provider call.
  let messages;
  try { messages = buildFieldNotesPacketMessages(facts, []); }
  catch { return privacyFailure(response); }

  let reservation;
  let provider;
  try { ({ provider, reservation } = await resolveAndReserve(supabaseUrl, serviceRoleKey, user.id, mesh)); }
  catch (error) {
    if (error?.cause === "mesh_unconfigured") return notConfigured(response);
    return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
  }
  if (!reservation?.id) {
    const failure = reservationFailure(reservation);
    return json(response, failure.status, failure.payload);
  }

  // Verified chapter sources, best effort: the notes alone still assemble a
  // packet. A retrieval from another organization is refused, never merged.
  let grounded = [];
  try {
    // The query is the minimizer's own output for the task title, never raw
    // note text, and it reaches the database as the caller under the same
    // knowledge-base gates Compass retrieval already applies.
    const retrieval = await readCompassContext(supabaseUrl, publishableKey, token, "lexical", {
      p_query: fieldNotesPacketRetrievalQuery(facts) || FIELD_NOTES_PACKET_INSTRUCTION,
    });
    if (!compassContextMatches(contextEnvelope, retrieval)) {
      await releaseReservation(supabaseUrl, serviceRoleKey, reservation.id);
      return json(response, 503, { code: "governance_unavailable", error: "Your organization context changed. Try again." });
    }
    grounded = (Array.isArray(retrieval.data) ? retrieval.data : [])
      .filter((row) => validRetrievalRow(row) && row.kind !== "case" && !String(row.source_id).startsWith("case:"))
      .slice(0, 4);
  } catch {
    grounded = [];
  }
  if (grounded.length) {
    // A source that cannot be minimized loses only the grounding, never the
    // packet: fall back to the notes-only messages built above.
    try { messages = buildFieldNotesPacketMessages(facts, grounded); }
    catch { grounded = []; }
  }
  const included = minimizedCompassSourceIndexes(messages);
  const sources = included.map((index) => ({
    marker: `S${index + 1}`,
    id: String(grounded[index].source_id).slice(0, 160),
    kind: String(grounded[index].kind).slice(0, 40),
    title: String(grounded[index].title).slice(0, 160),
    ref: String(grounded[index].ref).slice(0, 80),
  }));
  const registry = included.map((index) => ({ marker: `S${index + 1}`, title: String(grounded[index].title).slice(0, 160) }));

  let completion;
  try {
    completion = await governedStructuredCompletion({
      supabaseUrl, serviceRoleKey, userId: user.id, reservation, messages, contextEnvelope,
      access: { ...mesh, provider, cacheIsolation: "request" },
    });
  } catch (error) {
    const paused = error?.cause === "disabled";
    return json(response, paused ? 503 : 502, {
      code: paused ? "compass_paused" : "gateway_unavailable",
      error: paused ? "Union Ground Guide is paused by an administrator." : "Union Ground Guide could not draft that packet right now. Try again shortly.",
    });
  }
  let packet;
  try { packet = validateStructuredAnswer("field_notes_packet", parseStructuredAnswer(completion.content)); }
  catch {
    // Completed generations are never refunded (see automation_draft above).
    scheduleInvalidResultAlert(completion, mesh, reservation.id);
    return json(response, 502, { code: "invalid_ai_result", error: "Union Ground Guide returned an invalid draft. Try again." });
  }
  await recordOutcome(supabaseUrl, serviceRoleKey, reservation.id, user.id, "answered");
  return json(response, 200, {
    packet: { ...packet, citations: verifyPacketCitations(packet.citations, registry) },
    sources,
    meta: completion.meta,
  });
}

// Page-aware help is honored only while the organization switch is on; an
// unknown page, a missing organization or an unreadable setting sends no page.
async function pageAwareContext(supabaseUrl, serviceRoleKey, portalEnvelope, page) {
  if (!Object.hasOwn(COMPASS_PAGE_LABELS, page) || !UUID.test(String(portalEnvelope?.organization_id || ""))) return null;
  try {
    const settings = await readOrganizationSettings({ url: supabaseUrl, serviceRoleKey }, portalEnvelope.organization_id, ["features.ai_assistant.page_aware_help"]);
    return settings["features.ai_assistant.page_aware_help"] === true ? page : null;
  } catch {
    return null;
  }
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["POST"], () => json(response, 405, { error: "Method not allowed." }))) return;

  const { ok: providerValid, supabaseUrl, publishableKey, serviceRoleKey } = unionGroundProvider();
  const mesh = meshAccess();
  if (requireEnv([providerValid, supabaseUrl, publishableKey, serviceRoleKey], () => notConfigured(response))) return;

  const token = bearerToken(request);
  if (!token) return json(response, 401, { error: "Sign in to use Union Ground Guide." });

  const user = await authenticate(supabaseUrl, publishableKey, token).catch(() => null);
  if (!user?.id) return json(response, 401, { error: "Your session expired. Sign in again." });

  // No PIN step-up gate: Union Ground has no member PIN or restricted PIN
  // session (owner decision, 2026-10-13), so every signed-in caller is a full
  // password session and the database authorizes each mode below.

  const mode = String(request.body?.mode || "question");
  if (mode === "automation_draft") {
    let messages;
    try {
      messages = buildAutomationDraftMessages({
        intent: request.body?.intent,
        capabilityVersion: request.body?.capabilityVersion,
        triggers: request.body?.triggers,
        actions: request.body?.actions,
        opportunities: request.body?.opportunities,
        locale: request.body?.locale,
      });
    } catch {
      return privacyFailure(response);
    }

    try {
      const authorization = await supabaseRpc(
        supabaseUrl,
        publishableKey,
        token,
        "mi1_get_automation_ai_authorization",
      );
      if (authorization?.authorized !== true) {
        // public.mi1_get_automation_ai_authorization (20260911070000:542) has
        // exactly one non-exception result and no cause key. supabaseRpc
        // (api/_lib/http.js:283) keeps only HTTP status and PostgREST code, so
        // MFA and role refusals cannot be distinguished at this boundary.
        return json(response, 403, {
          code: "unauthorized",
          error: "An active staff role is required to draft an automation.",
        });
      }
    } catch (error) {
      const denied = error?.status === 401 || error?.status === 403;
      return json(response, denied ? 403 : 503, {
        code: denied ? "unauthorized" : "governance_unavailable",
        error: denied ? "An active staff role is required to draft an automation." : "Union Ground Guide is unavailable right now.",
      });
    }

    let reservation;
    let provider;
    try { ({ provider, reservation } = await resolveAndReserve(supabaseUrl, serviceRoleKey, user.id, mesh)); }
    catch (error) {
      if (error?.cause === "mesh_unconfigured") return notConfigured(response);
      return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
    }
    if (!reservation?.id) {
      const failure = reservationFailure(reservation);
      return json(response, failure.status, failure.payload);
    }

    let completion;
    try {
      completion = await governedStructuredCompletion({
        supabaseUrl, serviceRoleKey, userId: user.id, reservation, messages, access: { ...mesh, provider },
      });
    } catch (error) {
      const paused = error?.cause === "disabled";
      return json(response, paused ? 503 : 502, {
        code: paused ? "compass_paused" : "gateway_unavailable",
        error: paused ? "Union Ground Guide is paused by an administrator." : "Union Ground Guide could not complete that request right now.",
      });
    }

    const capabilities = {
      schemaVersion: 2,
      triggers: request.body.triggers,
      actions: request.body.actions,
      cadences: ["hourly", "daily", "weekly"],
      maxThresholdDays: 90,
    };
    let proposal;
    try {
      proposal = normalizeAutomationProposal(parseStructuredAnswer(completion.content), capabilities);
      if (!proposal) throw new Error("structured-answer-invalid");
    } catch {
      // The provider already completed a generation. Never refund this:
      // release_member_ai_request DELETEs the row that
      // reserve_compass_ai_request counts for both hourly caps, so an invalid
      // structured result would otherwise leave that completed call uncounted.
      scheduleInvalidResultAlert(completion, mesh, reservation.id);
      return json(response, 502, { code: "invalid_ai_result", error: "Union Ground Guide returned an invalid draft. Try again." });
    }
    return json(response, 200, { proposal, meta: completion.meta });
  }
  if (mode === "field_notes_packet") {
    return fieldNotesPacket({ request, response, supabaseUrl, publishableKey, serviceRoleKey, token, user, mesh });
  }
  if (mode === "issue_digest") {
    // REQ-UG-ISSUE-INTELLIGENCE-WEEKLY-DIGEST-20261001: a staff member asks
    // Compass to summarize one stored weekly digest. The database decides
    // whether the caller holds the staff hat, whether the digest belongs to the
    // caller's organization and whether both the digest AI switch and the
    // organization AI switch are on; it returns only the aggregate digest.
    const digestId = String(request.body?.digestId || "");
    const hat = String(request.body?.hat || "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(digestId) || !/^(steward|coordinator|admin)$/.test(hat)) {
      return json(response, 400, { error: "Choose a valid weekly digest." });
    }
    let payload;
    try {
      payload = await supabaseRpc(supabaseUrl, publishableKey, token, "authorize_issue_intelligence_digest_ai", { p_selected_hat: hat, p_digest_id: digestId });
    } catch (error) {
      if (error?.code === "P0002") return json(response, 404, { error: "That weekly digest is unavailable." });
      if (error?.code === "22023") return json(response, 409, { code: "digest_summary_unavailable", error: "This digest already has a summary or cannot be summarized." });
      if (engagementStaffRefused(error)) return json(response, 403, { error: "A staff role and the Guide digest summary switch are required." });
      return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
    }
    // The digest names the organization it belongs to. Governed completion
    // dispatches only if the reservation is still bound to that organization
    // (primary and failover), so a workspace switch between this read and the
    // hand-off cannot send organization A's aggregate under B's reservation.
    const { organizationId, ...digestPayload } = payload && typeof payload === "object" ? payload : {};
    if (typeof organizationId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(organizationId)) {
      return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
    }
    const contextEnvelope = { organization_id: organizationId };
    let messages;
    try { messages = buildIssueDigestMessages(digestPayload); }
    catch { return privacyFailure(response); }

    let reservation;
    let provider;
    try { ({ provider, reservation } = await resolveAndReserve(supabaseUrl, serviceRoleKey, user.id, mesh)); }
    catch (error) {
      if (error?.cause === "mesh_unconfigured") return notConfigured(response);
      return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
    }
    if (!reservation?.id) {
      const failure = reservationFailure(reservation);
      return json(response, failure.status, failure.payload);
    }
    let completion;
    try {
      completion = await governedStructuredCompletion({
        supabaseUrl, serviceRoleKey, userId: user.id, reservation, messages, contextEnvelope, access: { ...mesh, provider },
      });
    } catch (error) {
      const paused = error?.cause === "disabled";
      return json(response, paused ? 503 : 502, {
        code: paused ? "compass_paused" : "gateway_unavailable",
        error: paused ? "Union Ground Guide is paused by an administrator." : "Union Ground Guide could not complete that request right now.",
      });
    }
    let structured;
    try { structured = validateStructuredAnswer(mode, parseStructuredAnswer(completion.content)); }
    catch {
      // Completed generations are never refunded (see poll_draft below).
      scheduleInvalidResultAlert(completion, mesh, reservation.id);
      return json(response, 502, { code: "invalid_ai_result", error: "Union Ground Guide returned an invalid summary. Try again." });
    }
    const model = String(completion.meta?.model || provider?.model || "compass").slice(0, 160);
    try {
      const digest = await supabaseRpc(supabaseUrl, publishableKey, token, "save_issue_intelligence_digest_ai", {
        p_selected_hat: hat,
        p_digest_id: digestId,
        p_summary: structured.summary,
        p_recommendations: structured.recommendations,
        p_caution: structured.caution,
        p_model: model,
      });
      return json(response, 200, { digest, meta: completion.meta });
    } catch {
      return json(response, 503, { code: "persistence_unavailable", error: "The summary could not be saved." });
    }
  }
  if (mode === "usage_digest") {
    // REQ-UG-AI-USAGE-DIGEST-20261001: a staff member asks Compass to word
    // one stored usage digest. The database decides whether the caller holds a
    // staff hat, whether the digest belongs to the caller's organization and
    // whether both the digest wording switch and the organization AI switch
    // are on; it returns only the floored aggregate figures.
    const digestId = String(request.body?.digestId || "");
    const hat = String(request.body?.hat || "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(digestId)
        || !/^(steward|coordinator|advisor|admin|vp)$/.test(hat)) {
      return json(response, 400, { error: "Choose a valid usage digest." });
    }
    let payload;
    try {
      payload = await supabaseRpc(supabaseUrl, publishableKey, token, "authorize_analytics_usage_digest_ai", { p_selected_hat: hat, p_digest_id: digestId });
    } catch (error) {
      if (error?.code === "P0002") return json(response, 404, { error: "That usage digest is unavailable." });
      if (error?.code === "22023") return json(response, 409, { code: "digest_summary_unavailable", error: "This digest already has wording or cannot be worded." });
      if (engagementStaffRefused(error)) return json(response, 403, { error: "A staff role and the Guide usage digest switch are required." });
      return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
    }
    // The digest names the organization it belongs to; the governed dispatch is
    // bound to it for both the primary and the failover provider, so a
    // workspace switch between this read and the hand-off cannot send
    // organization A's aggregate under B's reservation.
    const { organizationId, ...digestPayload } = payload && typeof payload === "object" ? payload : {};
    if (typeof organizationId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(organizationId)) {
      return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
    }
    const contextEnvelope = { organization_id: organizationId };
    let messages;
    try { messages = buildUsageDigestMessages(digestPayload); }
    catch { return privacyFailure(response); }

    let reservation;
    let provider;
    try { ({ provider, reservation } = await resolveAndReserve(supabaseUrl, serviceRoleKey, user.id, mesh)); }
    catch (error) {
      if (error?.cause === "mesh_unconfigured") return notConfigured(response);
      return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
    }
    if (!reservation?.id) {
      const failure = reservationFailure(reservation);
      return json(response, failure.status, failure.payload);
    }
    let completion;
    try {
      completion = await governedStructuredCompletion({
        supabaseUrl, serviceRoleKey, userId: user.id, reservation, messages, contextEnvelope, access: { ...mesh, provider },
      });
    } catch (error) {
      const paused = error?.cause === "disabled";
      return json(response, paused ? 503 : 502, {
        code: paused ? "compass_paused" : "gateway_unavailable",
        error: paused ? "Union Ground Guide is paused by an administrator." : "Union Ground Guide could not complete that request right now.",
      });
    }
    let structured;
    try { structured = validateStructuredAnswer(mode, parseStructuredAnswer(completion.content)); }
    catch {
      // Completed generations are never refunded (see poll_draft below).
      scheduleInvalidResultAlert(completion, mesh, reservation.id);
      return json(response, 502, { code: "invalid_ai_result", error: "Union Ground Guide returned invalid wording. Try again." });
    }
    const model = String(completion.meta?.model || provider?.model || "compass").slice(0, 160);
    try {
      const digest = await supabaseRpc(supabaseUrl, publishableKey, token, "save_analytics_usage_digest_ai", {
        p_selected_hat: hat,
        p_digest_id: digestId,
        p_summary: structured.summary,
        p_highlights: structured.highlights,
        p_caution: structured.caution,
        p_model: model,
      });
      return json(response, 200, { digest, meta: completion.meta });
    } catch {
      return json(response, 503, { code: "persistence_unavailable", error: "The wording could not be saved." });
    }
  }
  if (mode === "poll_draft" || mode === "message_briefing") {
    let context = null;
    let contextEnvelope;
    let messages;
    if (mode === "poll_draft") {
      const topic = String(request.body?.topic || "").trim();
      if (!topic || topic.length > 500) return json(response, 400, { error: "Describe the poll in 1 to 500 characters." });
      try {
        // The staff authorization gate. It answers the role question only —
        // no engagement projection is read here, and only the caller's topic
        // crosses the provider boundary.
        await supabaseRpc(supabaseUrl, publishableKey, token, "authorize_engagement_staff");
      } catch (error) {
        if (!engagementStaffRefused(error)) return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
        return json(response, 403, { error: "A staff role is required to draft a poll." });
      }
      try { messages = buildPollDraftMessages(topic); }
      catch { return privacyFailure(response); }
    } else {
      const sourceKind = String(request.body?.sourceKind || "");
      const targetId = String(request.body?.targetId || "");
      if (!/^(private|channel|task)$/.test(sourceKind)
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId)) {
        return json(response, 400, { error: "Choose a valid message thread." });
      }
      try {
        await supabaseRpc(supabaseUrl, publishableKey, token, "authorize_engagement_staff");
      } catch (error) {
        if (!engagementStaffRefused(error)) return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
        return json(response, 403, { error: "A staff role is required to brief a message thread." });
      }
      try {
        contextEnvelope = await readCompassContext(supabaseUrl, publishableKey, token, "briefing", {
          p_source_kind: sourceKind,
          p_target_id: targetId,
        });
        context = contextEnvelope.data;
      } catch {
        return json(response, 404, { error: "That message thread is unavailable." });
      }
      try { messages = buildMessageBriefingMessages(context); }
      catch { return privacyFailure(response); }
    }

    let reservation;
    let provider;
    try { ({ provider, reservation } = await resolveAndReserve(supabaseUrl, serviceRoleKey, user.id, mesh)); }
    catch (error) {
      if (error?.cause === "mesh_unconfigured") return notConfigured(response);
      return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
    }
    if (!reservation?.id) {
      const failure = reservationFailure(reservation);
      return json(response, failure.status, failure.payload);
    }
    let completion;
    try {
      completion = await governedStructuredCompletion({
        supabaseUrl, serviceRoleKey, userId: user.id, reservation, messages, contextEnvelope, access: { ...mesh, provider },
      });
    } catch (error) {
      const paused = error?.cause === "disabled";
      return json(response, paused ? 503 : 502, {
        code: paused ? "compass_paused" : "gateway_unavailable",
        error: paused ? "Union Ground Guide is paused by an administrator." : "Union Ground Guide could not complete that request right now.",
      });
    }
    let structured;
    try { structured = validateStructuredAnswer(mode, parseStructuredAnswer(completion.content)); }
    catch {
      // The provider already completed a generation. Never refund this:
      // release_member_ai_request DELETEs the row that
      // reserve_compass_ai_request counts for both hourly caps, so an invalid
      // structured result would otherwise leave that completed call uncounted.
      scheduleInvalidResultAlert(completion, mesh, reservation.id);
      return json(response, 502, { code: "invalid_ai_result", error: "Union Ground Guide returned an invalid draft. Try again." });
    }

    if (mode === "poll_draft") {
      return json(response, 200, {
        draft: {
          title: structured.title,
          description: structured.description,
          options: structured.options,
          resultsVisibility: structured.resultsVisibility,
          eligibility: structured.eligibility,
        },
        meta: completion.meta,
      });
    }

    try {
      const briefing = await supabaseRpc(supabaseUrl, publishableKey, token, "persist_compass_message_briefing", {
        p_source_revision: context.sourceRevision,
        p_source_kind: context.sourceKind,
        p_target_id: context.targetId,
        p_summary: structured.summary,
        p_action_items: structured.actionItems,
      });
      return json(response, 200, { briefing, meta: completion.meta });
    } catch {
      return json(response, 503, { code: "persistence_unavailable", error: "The briefing could not be saved." });
    }
  }
  if (mode === "staff_data") return staffDataAnswer({ request, response, supabaseUrl, publishableKey, serviceRoleKey, token, user, mesh });
  if (mode === "case_help") return caseHelpAnswer({ request, response, supabaseUrl, publishableKey, serviceRoleKey, token, user, mesh });
  if (mode !== "question") return json(response, 400, { error: "Unsupported Union Ground Guide request." });

  const question = String(request.body?.question || "").trim();
  if (!question || question.length > 1200) return json(response, 400, { error: "Ask a question between 1 and 1,200 characters." });
  // BUG-UG-COMPASS-GUIDE-503-PRODUCTION-20261003: the wording the
  // minimizer cannot send is the member's to change, not an outage. Refuse it
  // with the same minimizer buildGuideMessages applies, before any context
  // read, reservation or dispatch, so it spends nothing and reads as a 422.
  // Retrieval then searches only the wording the model will see.
  let retrievalQuery;
  try { retrievalQuery = compassRetrievalQuery(question); }
  catch {
    return json(response, 422, {
      code: "question_withheld",
      error: COMPASS_QUESTION_WITHHELD_ERROR,
    });
  }

  let portalContext;
  let portalEnvelope;
  let retrievalEnvelope;
  let reservation;
  let provider;
  try {
    portalEnvelope = await readCompassContext(supabaseUrl, publishableKey, token, "portal");
    portalContext = portalEnvelope.data;
    const page = request.body?.page ? await pageAwareContext(supabaseUrl, serviceRoleKey, portalEnvelope, String(request.body.page)) : null;
    if (page) portalContext = { ...(portalContext && typeof portalContext === "object" ? portalContext : {}), page };
    ({ provider, reservation } = await resolveAndReserve(supabaseUrl, serviceRoleKey, user.id, mesh));
  } catch (error) {
    if (error?.cause === "mesh_unconfigured") return notConfigured(response);
    return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
  }
  const reservationId = typeof reservation?.id === "string" ? reservation.id : null;
  if (!reservationId) {
    const cause = reservation?.cause;
    if (cause === "shared") {
      return json(response, 429, {
        code: "shared_rate_limit",
        error: "Union Ground Guide is at the shared hourly limit — not your personal one. Try again in a little while, and tell a committee member or organizer if this keeps happening.",
      });
    }
    if (cause === "role") {
      const limit = Number(reservation?.limit);
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > 200) {
        return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
      }
      return json(response, 429, {
        code: "role_rate_limit",
        error: `You've reached your ${limit} Union Ground Guide questions for this hour. Room frees up as the hour rolls over.`,
      });
    }
    if (cause === "disabled") {
      return json(response, 503, { code: "compass_paused", error: "Union Ground Guide is paused by an administrator." });
    }
    return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
  }

  // Hybrid retrieval, when switched on: the minimized question is embedded
  // through the mesh and search_member_kb_hybrid fuses semantic recall with
  // the lexical search under the same gates. A null embedding (switch off,
  // mesh unreachable, digest or model drift, withheld text) and a failing
  // hybrid RPC both fall back to the lexical RPC, so retrieval keeps working
  // whenever Postgres does, exactly as before. The switch alone is not enough:
  // until the active organization has a current indexed chunk (or while the
  // database lacks the readiness check), nothing is authorized or embedded.
  let embedding = null;
  if (hybridRetrievalEnabled() && mesh.configured && !provider.connector
    && await hybridIndexReady(supabaseUrl, publishableKey, token)) {
    // Embedding is a provider dispatch too. Revalidate before any network
    // request, and again below before generation after retrieval completes.
    let embeddingDispatch;
    try {
      embeddingDispatch = await supabaseRpc(supabaseUrl, serviceRoleKey, serviceRoleKey, "authorize_compass_ai_embedding", {
        p_request_id: reservationId, p_user_id: user.id, ...governanceRpcArgs(provider),
      });
    } catch { /* An unreadable authorization is refused below. */ }
    if (embeddingDispatch?.authorized !== true) {
      await releaseReservation(supabaseUrl, serviceRoleKey, reservationId);
      const paused = embeddingDispatch?.cause === "disabled";
      return json(response, 503, { code: paused ? "compass_paused" : "governance_unavailable", error: paused ? "Union Ground Guide is paused by an administrator." : "Union Ground Guide is unavailable right now." });
    }
    embedding = await embedCompassQuestion(question, mesh);
  }
  const lexicalSearch = () => readCompassContext(supabaseUrl, publishableKey, token, "lexical", { p_query: retrievalQuery });
  // Grounding fails closed. A missing RPC, RLS refusal, timeout, or honest
  // no-match is never permission for the model to improvise contract language.
  let retrieved;
  try {
    if (embedding) {
      try {
        retrievalEnvelope = await readCompassContext(supabaseUrl, publishableKey, token, "hybrid", { p_query: retrievalQuery, p_embedding: JSON.stringify(embedding) });
      } catch {
        retrievalEnvelope = await lexicalSearch();
      }
    } else {
      retrievalEnvelope = await lexicalSearch();
    }
  } catch {
    // Retrieval itself failed: a missing RPC, an RLS refusal, or the 8s client
    // timeout. The member did not cause it, so every retrieval-layer failure
    // releases the reservation. This is reported as an outage, never as an
    // authoritative empty result -- a 200 grounding answer would claim a check
    // nobody performed and fold an incident into compass_no_source reporting.
    recordRetrievalRefund(user.id);
    await releaseReservation(supabaseUrl, serviceRoleKey, reservationId);
    return json(response, 503, {
      code: "retrieval_unavailable",
      error: "Union Ground Guide could not reach your campaign's verified sources just now. Try again in a moment.",
    });
  }
  retrieved = retrievalEnvelope.data;
  if (!compassContextMatches(portalEnvelope, retrievalEnvelope)) {
    await releaseReservation(supabaseUrl, serviceRoleKey, reservationId);
    return json(response, 503, { code: "governance_unavailable", error: "Your organization context changed. Try again." });
  }
  if (!Array.isArray(retrieved) || retrieved.some((row) => !validRetrievalRow(row))) {
    // A successful transport with the wrong RPC shape, including one malformed
    // row inside an array, is still a retrieval failure. Filtering invalid rows
    // into an authoritative empty result would retain the reservation for a
    // source check that never satisfied its contract.
    recordRetrievalRefund(user.id);
    await releaseReservation(supabaseUrl, serviceRoleKey, reservationId);
    return json(response, 503, {
      code: "retrieval_unavailable",
      error: "Union Ground Guide could not reach your campaign's verified sources just now. Try again in a moment.",
    });
  }
  // REQ-UG-COMPASS-REFUSES-GENERAL-HOW-TO-QUESTIONS-20261030: a
  // how-to question about Union Ground itself is also grounded in the
  // product's own public guide, after the organization's sources.
  const grounded = [...retrieved
    .filter((item) => item?.kind !== "case" && !String(item?.source_id || "").startsWith("case:")
      && String(item?.source_id || "").trim()
      && String(item?.title || "").trim()
      && String(item?.ref || "").trim()
      && String(item?.snippet || "").trim())
    .slice(0, 6), ...productGuideSources(retrievalQuery)]
    .slice(0, 6);
  if (!grounded.length) {
    // Retrieval answered; nothing survived the grounding filter. Never refund
    // this: release_member_ai_request DELETEs the row that
    // reserve_compass_ai_request counts for both hourly caps, so refunding made
    // the grounding gate the one refusal a member can trigger at will and repeat
    // without limit -- each repeat still costs an Auth round trip, the
    // portal-context read, the platform-wide member-ai-global advisory lock,
    // three retrieval scans, and one more compass_no_source tick on the
    // organization's published usage aggregate. Counted, the member's own role
    // cap bounds all of it.
    const reader = await readerRole(supabaseUrl, publishableKey, token, reservation.role);
    await recordOutcome(supabaseUrl, serviceRoleKey, reservationId, user.id, "no_source");
    return json(response, 200, {
      answer: compassNoSourceAnswer(reader),
      ...(compassScopeNotices(retrievalEnvelope).length ? { scope_notices: compassScopeNotices(retrievalEnvelope) } : {}),
      sources: [],
      meta: { model: "grounding-gate", usage: null },
    });
  }
  const sources = grounded.map((item) => ({
    id: String(item.source_id || ""),
    kind: String(item.kind || ""),
    title: String(item.title || "").slice(0, 160),
    ref: String(item.ref || "").slice(0, 80),
  }));

  // A reservation is not permission forever. Re-check the kill switch,
  // attestation, exact provider configuration, and current role cap under the
  // same database advisory lock immediately before the network hand-off.
  let dispatch;
  try {
    dispatch = await supabaseRpc(
      supabaseUrl,
      serviceRoleKey,
      serviceRoleKey,
      "authorize_compass_ai_dispatch",
      { p_request_id: reservationId, p_user_id: user.id, ...governanceRpcArgs(provider) },
    );
  } catch {
    await releaseReservation(supabaseUrl, serviceRoleKey, reservationId);
    return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
  }
  if (dispatch?.authorized !== true || !compassContextMatches(portalEnvelope, dispatch)) {
    await releaseReservation(supabaseUrl, serviceRoleKey, reservationId);
    if (dispatch?.cause === "disabled") {
      return json(response, 503, { code: "compass_paused", error: "Union Ground Guide is paused by an administrator." });
    }
    return json(response, 503, { code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
  }

  const reader = await readerRole(supabaseUrl, publishableKey, token, reservation.role);
  // The minimized source set is fixed before the network hand-off and shared
  // by the answer and by the search-only degraded reply below.
  let safeSources = [];
  try {
    // Legacy conversation history has no organization binding. Never forward
    // it implicitly across a workspace switch, including from older clients.
    // The reader's role is the server's own read for the active organization,
    // never a client field (#7434).
    const messages = buildGuideMessages(question, portalContext, [], grounded, reader);
    const access = { ...mesh, provider };
    const sourceIndexes = minimizedCompassSourceIndexes(messages);
    safeSources = sourceIndexes.map((index) => sources[index]);
    const result = await completeWithMeshFailover({
      messages, access, attestedDigest: attestedDigestFromEvidence(dispatch?.evidence_ref),
      authorizeFailover: (cause) => supabaseRpc(supabaseUrl, serviceRoleKey, serviceRoleKey,
        "authorize_compass_ai_failover", { p_request_id: reservationId, p_user_id: user.id, p_cause: cause }),
    });
    // #7535: the model's "Used:" line names the sources it relied on; it is
    // removed here, before the answer reaches the reader, history or training.
    const { answer: modelAnswer, used } = splitCompassAnswerSources(result.content);
    // Attribution alone is not an answer. Reuse the grounding gate's reply,
    // with no cited sources or training pair, and count it as a non-answer.
    const answer = modelAnswer || compassNoSourceAnswer(reader);
    await recordOutcome(supabaseUrl, serviceRoleKey, reservationId, user.id, modelAnswer ? "answered" : "no_source");
    if (modelAnswer) {
      void scheduleCompassTraining({ supabaseUrl, serviceRoleKey, userId: user.id, requestId: reservationId,
        kind: "question", question, answer });
    }
    if (result.provider?.gateway === FIREWORKS_GATEWAY) {
      // Operator signal only: a takeover is a 200 to the member and invisible
      // to every monitor. Scheduled after the response; metadata only.
      schedulePlatformAlert({ kind: "fireworks_takeover", environment: meshEnvironmentTag(mesh.surface), route: "guide",
        cause: result.failoverCause, gateway: result.provider.gateway, model: result.provider.model, reservationId });
    }
    // #7503: list only the sources the answer relies on: the ones its "Used:"
    // line names, or else the ones it names by title or article, matched on
    // the full title and reference the model saw (the public copies are trimmed).
    const cited = new Set(compassCitedSources(modelAnswer, sourceIndexes.map((index) => ({
      index, kind: String(grounded[index]?.kind || ""), title: String(grounded[index]?.title || ""), ref: String(grounded[index]?.ref || ""),
    })), used).map(({ index }) => index));
    const citedSources = sourceIndexes.filter((index) => cited.has(index)).map((index) => sources[index]);
    return json(response, 200, { answer, ...(compassScopeNotices(retrievalEnvelope).length ? { scope_notices: compassScopeNotices(retrievalEnvelope) } : {}), sources: citedSources, meta: publicGuideMeta(result.completion, result.provider) });
  } catch (error) {
    // Operator signal for every outage shape, including a refused fallback
    // after a mesh failure; a deliberate pause and a privacy refusal are not
    // outages. Scheduled after the response; metadata only. The outcome
    // follows the branch below: a refused fallback is a 503 with an error and
    // no sources, so only the gateway-failure tail is the search-only reply.
    const outage = answerPathOutage(error, provider);
    if (outage) schedulePlatformAlert({ kind: "answer_path_down", environment: meshEnvironmentTag(mesh.surface), route: "guide", outcome: error?.failoverRefused ? "error" : "search_only", ...outage, reservationId });
    if (error?.failoverRefused) {
      await releaseReservation(supabaseUrl, serviceRoleKey, reservationId);
      const paused = error.cause === "disabled";
      return json(response, 503, { code: paused ? "compass_paused" : "governance_unavailable",
        error: paused ? "Union Ground Guide is paused by an administrator." : "Union Ground Guide is unavailable right now." });
    }
    if (error?.code === "compass_privacy_unavailable") {
      await releaseReservation(supabaseUrl, serviceRoleKey, reservationId);
      return privacyFailure(response);
    }
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    const cause = timedOut ? "gateway_timeout" : error?.gatewayCause || "gateway_error";
    // After an authorized takeover the failing provider is Fireworks.
    const failedProvider = error?.provider?.gateway ? error.provider : provider;
    // Deliberately no exception message and no upstream body. Either may
    // reflect prompts, retrieved source content, credentials, or generated
    // answers. This bounded object is the entire provider diagnostic surface.
    console.error("[guide] gateway failure", safeGatewayDiagnostic(
      error?.gatewayResponse,
      cause,
      { metadataPresent: error?.metadataPresent, model: failedProvider?.model },
    ));
    await releaseReservation(supabaseUrl, serviceRoleKey, reservationId);
    // Search-only degraded mode (REQ-UG-COMPASS-OUTAGE-DEGRADED-MODE-20260929):
    // retrieval is pure Postgres and already succeeded, so the member keeps the
    // verified sources the answer would have cited. `safeSources` is exactly
    // the minimized index set a 200 returns: no snippet, no generated text and
    // no upstream body leaves. Status and code are unchanged so monitors still
    // see the outage; `degraded` tells the client the sources are renderable.
    return json(response, timedOut ? 504 : 502, {
      code: timedOut ? "gateway_timeout" : "gateway_unavailable",
      error: "Union Ground Guide could not answer right now. Try again shortly.",
      degraded: "search_only",
      sources: safeSources, ...(compassScopeNotices(retrievalEnvelope).length ? { scope_notices: compassScopeNotices(retrievalEnvelope) } : {}),
    });
  }
}
