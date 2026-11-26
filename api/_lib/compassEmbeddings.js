import { MESH_ENDPOINTS, MESH_HOSTS, meshCredentialsComplete, meshEnvironmentTag } from "./compassAiGovernance.js";
import { minimizeCompassQuestion } from "./compassPrompts.js";

// Hybrid retrieval (REQ-UG-COMPASS-HYBRID-RETRIEVAL-PGVECTOR-20260929).
// The member's minimized question is embedded through the in-house mesh (the
// same allowlisted host, credentials and environment tag as the answer, on
// the proxy's /v1/embeddings path) and public.search_member_kb_hybrid fuses
// semantic recall with the lexical search under the same gates. Retrieval
// never depends on the mesh: every failure here (mesh down, timeout, digest or
// model drift, withheld text) means lexical-only retrieval, never an error.
export const COMPASS_EMBEDDING_MODEL = "bge-m3";
// The registry manifest digest of bge-m3 as pulled on both mesh hosts
// (2026-09-30). A reply under any other digest is discarded.
export const COMPASS_EMBEDDING_MODEL_DIGEST = "sha256:7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab";
export const COMPASS_EMBEDDING_DIMENSIONS = 1024;
export const EMBEDDING_TIMEOUT_MS = 4_000;
// Rollout switch: the hybrid RPC exists only once its migration is applied and
// the proxy path only once both mesh hosts carry it, so the embedding call is
// made only when the operator sets COMPASS_HYBRID_RETRIEVAL=on. Off means the
// lexical RPC exactly as before.
export const HYBRID_RETRIEVAL_FLAG = "COMPASS_HYBRID_RETRIEVAL";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,96}$/;

export function hybridRetrievalEnabled(env = process.env) {
  return String(env?.[HYBRID_RETRIEVAL_FLAG] || "").trim() === "on";
}

// The embeddings path lives on the same allowlisted mesh host as the chat
// completions endpoint this surface resolved; only the path changes.
export function meshEmbeddingsEndpoint(chatEndpoint) {
  if (!chatEndpoint || !Object.values(MESH_ENDPOINTS).includes(chatEndpoint)) throw new Error("unapproved mesh endpoint");
  const url = new URL(chatEndpoint);
  url.pathname = "/v1/embeddings";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function buildCompassEmbeddingRequest(question, access) {
  if (!access?.endpoint || !meshCredentialsComplete(access?.credentials)) throw new Error("mesh credentials are not configured");
  if (access.endpoint !== MESH_ENDPOINTS[access.surface === "demo" ? "demo" : "saas"]) throw new Error("mesh surface mismatch");
  const input = minimizeCompassQuestion(question);
  return {
    url: meshEmbeddingsEndpoint(access.endpoint),
    options: {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${access.credentials.apiKey}`,
        "CF-Access-Client-Id": access.credentials.accessClientId,
        "CF-Access-Client-Secret": access.credentials.accessClientSecret,
        "Content-Type": "application/json",
        "X-UG-Mesh-Env": meshEnvironmentTag(access.surface),
      },
      body: JSON.stringify({ model: COMPASS_EMBEDDING_MODEL, input }),
      signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
    },
  };
}

function header(headers, name) {
  const value = headers?.get?.(name);
  return typeof value === "string" ? value : "";
}

// Fail closed to null: exact model, a known mesh host, the pinned digest, a
// well-formed request id and a finite vector of the expected dimension.
export function readEmbeddingResponse(payload, headers) {
  if (payload?.model !== COMPASS_EMBEDDING_MODEL) return null;
  if (!MESH_HOSTS.includes(header(headers, "x-ug-mesh-host"))
      || header(headers, "x-ug-mesh-model-digest") !== COMPASS_EMBEDDING_MODEL_DIGEST
      || !DIGEST.test(COMPASS_EMBEDDING_MODEL_DIGEST)
      || !REQUEST_ID.test(header(headers, "x-ug-mesh-request-id"))) return null;
  if (!Array.isArray(payload?.data) || payload.data.length !== 1 || payload.data[0]?.index !== 0) return null;
  const vector = payload.data[0].embedding;
  if (!validEmbeddingVector(vector)) return null;
  return vector;
}

export function validEmbeddingVector(vector) {
  return Array.isArray(vector) && vector.length === COMPASS_EMBEDDING_DIMENSIONS
    && vector.every((value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1)
    && vector.some((value) => value !== 0);
}

// Never throws and never logs: a null return is the lexical fallback.
export async function embedCompassQuestion(question, access, fetchImplementation = fetch) {
  try {
    const request = buildCompassEmbeddingRequest(question, access);
    const response = await fetchImplementation(request.url, request.options);
    if (!response?.ok) return null;
    return readEmbeddingResponse(await response.json(), response.headers);
  } catch {
    return null;
  }
}
