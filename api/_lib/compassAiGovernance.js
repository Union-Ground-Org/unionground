import { assertMinimizedCompassMessages } from "./compassPrompts.js";
import { createHmac, randomUUID } from "node:crypto";

// The governed AI dispatch contract imported from the sibling product: a
// platform mesh as primary and a centrally managed Fireworks fallback, both
// under governance, minimization and tenant scope. Union Ground operates
// no AI mesh and has no approved AI provider, so the mesh has no endpoint and
// no host here and every mesh dispatch refuses as unconfigured. The gateway
// and model identifiers below are kept only because the database's policy
// rows and CHECK constraints name them; they reach no network target.

const providerPolicy = Object.freeze({
  zeroDataRetention: true,
  disallowPromptTraining: true,
});

export const MESH_GATEWAY = "union-ground-mesh";
export const FIREWORKS_GATEWAY = "union-ground-fireworks";
export const MESH_MODEL = "union-ground/compass-mesh:v1";
// The aliases the database's policy rows may name; none reaches a host here.
export const MESH_MODELS = Object.freeze(["union-ground/compass-mesh:v1", "union-ground/compass-mesh:v2"]);
// No mesh host answers for Union Ground, so an embedding response can never
// prove it came from an approved host.
export const MESH_HOSTS = Object.freeze([]);
// Each surface's one permitted mesh endpoint. Union Ground has none, so both
// are empty and resolveMeshEndpoint refuses every environment override.
export const MESH_ENDPOINTS = Object.freeze({ saas: "", demo: "" });
export const MESH_MODEL_PATTERN = /^union-ground\/compass-mesh:v[0-9]+$/;
// A trial alias (`:v2-qwen27`) lives only on a mesh host's own client
// allowlist for the evaluation harness. Production never resolves one:
// MESH_MODELS is closed and the policy CHECK admits plain versions only.
export const MESH_ALIAS_PATTERN = /^union-ground\/compass-mesh:v[0-9]+(?:-[a-z0-9]{1,24})?$/;
export const AGENCY_CONNECTORS = Object.freeze({
  ai_connector_gemini: Object.freeze({
    vendor: "google",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    modelPattern: /^gemini-[a-z0-9.-]{1,60}$/,
    shape: "chat_completions",
  }),
  ai_connector_claude: Object.freeze({
    vendor: "anthropic",
    endpoint: "https://api.anthropic.com/v1/messages",
    modelPattern: /^claude-[a-z0-9-]{1,60}$/,
    shape: "anthropic_messages",
  }),
  ai_connector_gpt: Object.freeze({
    vendor: "openai",
    endpoint: "https://api.openai.com/v1/chat/completions",
    modelPattern: /^(gpt|o)[a-z0-9.-]{1,60}$/,
    shape: "chat_completions",
  }),
  // Shared protocol definition for the central Fireworks fallback and legacy
  // connector parsing. New tenant-owned connector activation is retired.
  ai_connector_fireworks: Object.freeze({
    vendor: "fireworks",
    endpoint: "https://api.fireworks.ai/inference/v1/chat/completions",
    // A Meta "contributor" model trains on what it is sent (owner instruction,
    // October 2, 2026: public data only), so no contributor id is ever accepted.
    modelPattern: /^accounts\/fireworks\/models\/(?![a-z0-9.-]*contributor)[a-z0-9.-]{1,80}$/,
    shape: "chat_completions",
  }),
});
export const GATEWAY_IDS = Object.freeze([MESH_GATEWAY, FIREWORKS_GATEWAY, ...Object.keys(AGENCY_CONNECTORS)]);

export const COMPASS_AI_CONFIG = Object.freeze({
  gateway: MESH_GATEWAY,
  endpoint: MESH_ENDPOINTS.saas,
  model: MESH_MODEL,
  providerPolicy,
});

const DIAGNOSTIC_CAUSES = new Set([
  "compliance_metadata_invalid",
  "model_mismatch",
  "gateway_error",
  "gateway_timeout",
  "no_credits",
  "unauthorized",
]);

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,96}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REQUEST_TIMEOUT_MS = 25_000;
export const FIREWORKS_MAX_TOKENS = 4096;
export const FIREWORKS_REASONING_EFFORT = "medium";
// Fireworks retires gpt-oss-120b from serverless on November 7, 2026; the
// failover moves to Muse Spark Open (US-only serverless, zero data retention
// by default, open weights; MAIN decision October 22, 2026,
// OPS-UG-FIREWORKS-FAILOVER-GPT-OSS-120B-SERVERLESS-RETIRED-20261022).
export const FIREWORKS_DEFAULT_MODEL = "accounts/fireworks/models/muse-spark-open";
// Request fields a model needs beyond the chat-completions body. Only a model
// whose documented API accepts a field gets it; any other model, and every
// other gateway, gets the body unchanged.
export const FIREWORKS_MODEL_REQUEST_FIELDS = Object.freeze({
  // gpt-oss spends part of max_tokens on its own reasoning before the answer.
  // Medium effort (was low / 2048).
  "accounts/fireworks/models/gpt-oss-120b": Object.freeze({ reasoning_effort: FIREWORKS_REASONING_EFFORT }),
});

function envValue(env, key) {
  return String(env?.[key] || "").trim();
}

// Production ("saas") reads the unprefixed variables; SAMPLE ("demo") reads the
// SAMPLE_-prefixed ones, the way every other SAMPLE secret is modelled. Both
// layers are required: the Cloudflare Access service token at the edge and the
// origin bearer verified by the mesh proxy.
export function meshCredentialsFromEnv(surface, env = process.env) {
  const prefix = surface === "demo" ? "SAMPLE_" : "";
  return Object.freeze({
    apiKey: envValue(env, `${prefix}MESH_AI_API_KEY`),
    accessClientId: envValue(env, `${prefix}MESH_AI_ACCESS_CLIENT_ID`),
    accessClientSecret: envValue(env, `${prefix}MESH_AI_ACCESS_CLIENT_SECRET`),
  });
}

export function meshCredentialsComplete(credentials) {
  return Boolean(credentials?.apiKey && credentials?.accessClientId && credentials?.accessClientSecret);
}

// Each surface has exactly one permitted hostname. An override may only
// restate that surface's own endpoint, so production can never be pointed at
// the SAMPLE mesh or vice versa.
export function resolveMeshEndpoint(surface, env = process.env) {
  const configured = MESH_ENDPOINTS[surface === "demo" ? "demo" : "saas"];
  const override = envValue(env, surface === "demo" ? "SAMPLE_MESH_AI_ENDPOINT" : "MESH_AI_ENDPOINT");
  if (!override) return configured;
  if (!configured) throw new Error("mesh endpoint override names a host outside this surface's allowlist");
  let parsed;
  try { parsed = new URL(override); } catch { throw new Error("mesh endpoint override is not a URL"); }
  if (parsed.protocol !== "https:" || parsed.host !== new URL(configured).host || parsed.pathname !== "/v1/chat/completions") {
    throw new Error("mesh endpoint override names a host outside this surface's allowlist");
  }
  return parsed.toString();
}

export function meshEnvironmentTag(surface) {
  return surface === "demo" ? "sample" : "production";
}

// Primary resolution returns mesh. The separate failover authorization can
// return centrally managed Fireworks with a server-derived isolation scope.
export function normalizeResolvedProvider(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const gateway = row.gateway;
  if (gateway === MESH_GATEWAY) {
    return MESH_MODELS.includes(row.model) ? { gateway, model: row.model, connector: null } : null;
  }
  const connector = gateway === FIREWORKS_GATEWAY ? AGENCY_CONNECTORS.ai_connector_fireworks : AGENCY_CONNECTORS[gateway];
  if (!connector) return null;
  const model = typeof row.model === "string" ? row.model : "";
  const apiKey = typeof row.api_key === "string" ? row.api_key : "";
  if (!connector.modelPattern.test(model) || apiKey.length < 16 || apiKey.length > 512) return null;
  if (gateway === FIREWORKS_GATEWAY && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(row.isolation_scope || "")) return null;
  return { gateway, model, connector: { ...connector, apiKey },
    ...(gateway === FIREWORKS_GATEWAY ? { isolationScope: row.isolation_scope } : {}) };
}

// Every request carries Compass's minimization seal (or the one its caller
// names). Unsealed or copied messages are refused before anything reaches a
// provider.
function safeMessages(messages, assertSealed = assertMinimizedCompassMessages) {
  assertSealed(messages);
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

// The alias the request names is the policy row's (already constrained to
// MESH_MODELS); a caller without a resolved provider speaks to the current one.
function meshRequestModel(provider) {
  return MESH_MODELS.includes(provider?.model) ? provider.model : MESH_MODEL;
}

function chatCompletionsBody(model, messages, { maxTokens, temperature }) {
  return { model, messages, max_tokens: maxTokens, temperature, stream: false };
}

function anthropicBody(model, messages, { maxTokens, temperature }) {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  return {
    model,
    ...(system ? { system } : {}),
    messages: messages.filter((message) => message.role !== "system"),
    max_tokens: maxTokens,
    temperature,
  };
}

function buildProviderRequest(messages, access, { maxTokens, temperature, assertSealed }) {
  const minimized = safeMessages(messages, assertSealed);
  const provider = access?.provider;
  if (!provider?.connector) {
    if (!meshCredentialsComplete(access?.credentials)) throw new Error("mesh credentials are not configured");
    return {
      // A missing endpoint falls back to this surface's own allowlisted
      // hostname, never to the other surface's mesh.
      url: access.endpoint || MESH_ENDPOINTS[access.surface === "demo" ? "demo" : "saas"],
      options: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access.credentials.apiKey}`,
          "CF-Access-Client-Id": access.credentials.accessClientId,
          "CF-Access-Client-Secret": access.credentials.accessClientSecret,
          "Content-Type": "application/json",
          "X-UG-Mesh-Env": meshEnvironmentTag(access.surface),
        },
        body: JSON.stringify(chatCompletionsBody(meshRequestModel(provider), minimized, { maxTokens, temperature })),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    };
  }
  const { connector, model } = provider;
  const headers = connector.shape === "anthropic_messages"
    ? { "x-api-key": connector.apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }
    : { Authorization: `Bearer ${connector.apiKey}`, "Content-Type": "application/json" };
  const body = connector.shape === "anthropic_messages"
    ? anthropicBody(model, minimized, { maxTokens, temperature })
    : chatCompletionsBody(model, minimized, { maxTokens, temperature });
  if (provider.gateway === FIREWORKS_GATEWAY) {
    if (!provider.isolationScope) throw new Error("platform provider scope unavailable");
    // Never send tenant identifiers. Separate environments and organizations
    // even when prompt prefixes match and the platform uses one billing key.
    // A request that carries case content (access.cacheIsolation "request",
    // REQ-UG-COMPASS-PAGE-AND-CASE-AWARE-HELP-20261001) adds a one-time
    // nonce, so no later request, even from the same organization, can reuse
    // its cached prefix.
    const cacheScope = access?.cacheIsolation === "request" ? `:${randomUUID()}` : "";
    headers["x-prompt-cache-isolation-key"] = createHmac("sha256", connector.apiKey)
      .update(`${meshEnvironmentTag(access.surface)}:${provider.isolationScope}${cacheScope}`).digest("hex");
    // A reasoning model spends part of max_tokens before the answer, so the
    // ceiling leaves the full answer room after that reasoning (was 2048).
    body.max_tokens = Math.max(maxTokens, FIREWORKS_MAX_TOKENS);
    Object.assign(body, FIREWORKS_MODEL_REQUEST_FIELDS[model] ?? {});
  }
  return {
    url: connector.endpoint,
    options: { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "error" },
  };
}

// `access` = { surface, endpoint, credentials, provider } from api/guide.js.
export function buildCompassGatewayRequest(messages, access) {
  return buildProviderRequest(messages, access, { maxTokens: 500, temperature: 0.2 });
}

// The opt-in synthetic evaluation judge shares the exact production mesh,
// model alias, minimization seal, and privacy posture. Only its bounded
// completion size and deterministic temperature differ from user-facing
// Compass generation.
export function buildCompassJudgeGatewayRequest(messages, access) {
  return buildProviderRequest(messages, access, { maxTokens: 160, temperature: 0 });
}

function header(headers, name) {
  const value = headers?.get?.(name);
  return typeof value === "string" ? value : "";
}

export function attestedDigestFromEvidence(evidenceRef) {
  const match = String(evidenceRef || "").match(/sha256:[0-9a-f]{64}/);
  return match ? match[0] : null;
}

function firstContent(payload, shape) {
  if (shape === "anthropic_messages") {
    const block = Array.isArray(payload?.content) ? payload.content.find((item) => item?.type === "text") : null;
    return typeof block?.text === "string" ? block.text.trim() : "";
  }
  const content = payload?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content.trim() : "";
}

// Fail-closed acceptance of a mesh reply: the exact alias the request named,
// every proof header present and well-formed, the digest equal to the current
// verified attestation, and a known mesh host. Content is never returned on
// rejection.
export function readMeshResponse(payload, headers, { attestedDigest, expectedModel = MESH_MODEL } = {}) {
  if (!MESH_ALIAS_PATTERN.test(String(expectedModel || "")) || payload?.model !== expectedModel) return { ok: false, cause: "model_mismatch" };
  const host = header(headers, "x-ug-mesh-host");
  const digest = header(headers, "x-ug-mesh-model-digest");
  const requestId = header(headers, "x-ug-mesh-request-id");
  if (!MESH_HOSTS.includes(host)
      || !DIGEST.test(digest)
      || !REQUEST_ID.test(requestId)
      || !DIGEST.test(String(attestedDigest || ""))
      || digest !== attestedDigest) {
    return { ok: false, cause: "compliance_metadata_invalid" };
  }
  const content = firstContent(payload, "chat_completions");
  if (!content) return { ok: false, cause: "gateway_error" };
  return { ok: true, content, requestId };
}

// Vendor-resolved snapshot of a configured alias: a single `-YYYYMMDD`,
// `-YYYY-MM-DD`, or (when the vendor pattern allows it) `@YYYYMMDD` suffix.
// Anthropic aliases ending in `-0` resolve by replacing that token
// (`claude-sonnet-4-0` → `claude-sonnet-4-20250514`); later minors such as
// `-1` keep the token and only append a date. The remainder after the
// matched prefix must be only that suffix, so `gpt-5-mini` never matches
// `gpt-5-mini-high` or `gpt-5`.
const CONNECTOR_SNAPSHOT_SUFFIX = /^(?:-\d{8}|-\d{4}-\d{2}-\d{2}|@\d{8})$/;

function isDatedSnapshotOf(configured, reported) {
  return reported.startsWith(configured) && CONNECTOR_SNAPSHOT_SUFFIX.test(reported.slice(configured.length));
}

export function connectorModelMatches(configured, reported, modelPattern) {
  if (typeof configured !== "string" || typeof reported !== "string") return false;
  if (!modelPattern?.test(reported)) return false;
  if (configured === reported || isDatedSnapshotOf(configured, reported)) return true;
  if (!configured.endsWith("-0")) return false;
  const family = configured.slice(0, -2);
  return Boolean(family) && isDatedSnapshotOf(family, reported);
}

// A connector reply is accepted when its model equals the configured
// identifier or the vendor's dated snapshot of that identifier, and the
// first text block is non-empty. Mesh replies stay on exact alias match.
export function readConnectorResponse(payload, provider) {
  const shape = provider?.connector?.shape;
  if (!shape || !connectorModelMatches(provider.model, payload?.model, provider.connector.modelPattern)) {
    return { ok: false, cause: "model_mismatch" };
  }
  const content = firstContent(payload, shape);
  if (!content) return { ok: false, cause: "gateway_error" };
  return { ok: true, content, requestId: undefined };
}

export function readProviderResponse(payload, headers, { provider, attestedDigest } = {}) {
  return provider?.connector
    ? readConnectorResponse(payload, provider)
    : readMeshResponse(payload, headers, { attestedDigest, expectedModel: meshRequestModel(provider) });
}

export function hasMeshProofHeaders(headers) {
  return Boolean(header(headers, "x-ug-mesh-host") && header(headers, "x-ug-mesh-model-digest") && header(headers, "x-ug-mesh-request-id"));
}

function boundedRequestId(response) {
  const raw = header(response?.headers, "x-ug-mesh-request-id") || header(response?.headers, "x-request-id");
  const value = String(raw).slice(0, 96);
  return REQUEST_ID.test(value) ? value : undefined;
}

export function safeGatewayDiagnostic(response, cause, { metadataPresent = false, model = MESH_MODEL } = {}) {
  const status = Number(response?.status);
  const diagnostic = {
    cause: DIAGNOSTIC_CAUSES.has(cause) ? cause : "unknown",
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0,
    model: GATEWAY_IDS.length && (MESH_MODELS.includes(model) || Object.values(AGENCY_CONNECTORS).some((c) => c.modelPattern.test(String(model)))) ? model : MESH_MODEL,
    metadataPresent: Boolean(metadataPresent),
  };
  const requestId = boundedRequestId(response);
  if (requestId) diagnostic.requestId = requestId;
  return diagnostic;
}
