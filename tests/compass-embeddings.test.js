// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  COMPASS_EMBEDDING_DIMENSIONS,
  COMPASS_EMBEDDING_MODEL,
  COMPASS_EMBEDDING_MODEL_DIGEST,
  EMBEDDING_TIMEOUT_MS,
  HYBRID_RETRIEVAL_FLAG,
  buildCompassEmbeddingRequest,
  embedCompassQuestion,
  hybridRetrievalEnabled,
  meshEmbeddingsEndpoint,
  readEmbeddingResponse,
} from "../api/_lib/compassEmbeddings.js";
import { MESH_ENDPOINTS, MESH_HOSTS } from "../api/_lib/compassAiGovernance.js";

// Union Ground configures no AI mesh: MESH_ENDPOINTS has no endpoint and
// MESH_HOSTS no host, so the embeddings path can never be built, can never
// accept a vector, and can never reach the network. Every case below keeps the
// sibling product's request and response contract fixed while asserting the
// fail-closed outcome.
const access = {
  surface: "saas",
  endpoint: MESH_ENDPOINTS.saas,
  credentials: { apiKey: "mesh-origin-bearer-value", accessClientId: "cf-access-id", accessClientSecret: "cf-access-secret" },
  configured: true,
};
const vector = Array.from({ length: COMPASS_EMBEDDING_DIMENSIONS }, (_, index) => (index % 7) / 10);
const proof = {
  "x-ug-mesh-host": "mesh-host-1",
  "x-ug-mesh-model-digest": COMPASS_EMBEDDING_MODEL_DIGEST,
  "x-ug-mesh-request-id": "0f9c2d7e-1234-4abc-8def-1234567890ab",
};
const headers = (overrides = {}) => ({ get: (name) => ({ ...proof, ...overrides })[String(name).toLowerCase()] ?? null });
const payload = (extra = {}) => ({ object: "list", model: COMPASS_EMBEDDING_MODEL, data: [{ object: "embedding", index: 0, embedding: vector }], usage: { prompt_tokens: 5, total_tokens: 5 }, ...extra });
const response = (body, { ok = true, status = 200, head = headers() } = {}) => ({ ok, status, headers: head, json: async () => body });

describe("Compass hybrid retrieval embeddings", () => {
  it("is off unless the operator sets the switch to on", () => {
    expect(HYBRID_RETRIEVAL_FLAG).toBe("COMPASS_HYBRID_RETRIEVAL");
    expect(hybridRetrievalEnabled({})).toBe(false);
    expect(hybridRetrievalEnabled({ COMPASS_HYBRID_RETRIEVAL: "1" })).toBe(false);
    expect(hybridRetrievalEnabled({ COMPASS_HYBRID_RETRIEVAL: "true" })).toBe(false);
    expect(hybridRetrievalEnabled({ COMPASS_HYBRID_RETRIEVAL: " on " })).toBe(true);
  });

  it("has no mesh endpoint to embed on, so no request is ever built, whatever the credentials or the question", () => {
    expect(MESH_ENDPOINTS).toEqual({ saas: "", demo: "" });
    expect(MESH_HOSTS).toEqual([]);
    expect(() => meshEmbeddingsEndpoint(MESH_ENDPOINTS.saas)).toThrow(/unapproved mesh endpoint/);
    expect(() => meshEmbeddingsEndpoint(MESH_ENDPOINTS.demo)).toThrow(/unapproved mesh endpoint/);
    expect(EMBEDDING_TIMEOUT_MS).toBe(4_000);
    const sensitive = "Marisol Alvarez has lupus and SSN 123-45-6789.";
    expect(() => buildCompassEmbeddingRequest(`${sensitive} What does Article 12 say?`, access)).toThrow(/mesh credentials are not configured/);
    expect(() => buildCompassEmbeddingRequest("What does Article 12 say?", { ...access, surface: "demo", endpoint: MESH_ENDPOINTS.demo })).toThrow(/mesh credentials are not configured/);
  });

  it("refuses to build a request without complete credentials or a question that survives minimization", () => {
    expect(() => buildCompassEmbeddingRequest("What does Article 12 say?", { ...access, credentials: { apiKey: "x" } })).toThrow(/credentials/);
    expect(() => buildCompassEmbeddingRequest("What does Article 12 say?", { ...access, endpoint: "" })).toThrow(/credentials/);
    expect(() => buildCompassEmbeddingRequest("Marisol Alvarez has lupus.", access)).toThrow();
  });

  it("accepts no vector at all, because no mesh host is approved", () => {
    // A response that would be perfect for the sibling product is still refused.
    expect(readEmbeddingResponse(payload(), headers())).toBeNull();
    expect(readEmbeddingResponse(payload({ model: "nomic-embed-text" }), headers())).toBeNull();
    expect(readEmbeddingResponse(payload(), headers({ "x-ug-mesh-host": "elsewhere" }))).toBeNull();
    expect(readEmbeddingResponse(payload(), headers({ "x-ug-mesh-model-digest": `sha256:${"c".repeat(64)}` }))).toBeNull();
    expect(readEmbeddingResponse(payload(), headers({ "x-ug-mesh-model-digest": undefined }))).toBeNull();
    expect(readEmbeddingResponse(payload(), headers({ "x-ug-mesh-request-id": "bad id\n" }))).toBeNull();
    expect(readEmbeddingResponse(payload({ data: [{ embedding: vector.slice(0, 512) }] }), headers())).toBeNull();
    expect(readEmbeddingResponse(payload({ data: [{ embedding: [...vector.slice(0, 1023), "1"] }] }), headers())).toBeNull();
    expect(readEmbeddingResponse(payload({ data: [{ embedding: [...vector.slice(0, 1023), Number.NaN] }] }), headers())).toBeNull();
    expect(readEmbeddingResponse(payload({ data: [] }), headers())).toBeNull();
    expect(readEmbeddingResponse(null, headers())).toBeNull();
    for (const data of [
      [{ index: 1, embedding: vector }],
      [{ index: 0, embedding: vector }, { index: 0, embedding: vector }],
      [{ index: 0, embedding: Array(1024).fill(0) }],
      [{ index: 0, embedding: [...vector.slice(0, 1023), 1e300] }],
    ]) expect(readEmbeddingResponse(payload({ data }), headers())).toBeNull();
  });

  it("rejects endpoint injection and mismatched surfaces before any request", () => {
    for (const endpoint of ["", "https://elsewhere.invalid/v1/chat/completions", "https://mesh.example.invalid/v1/chat/completions?x=1", "https://mesh.example.invalid/v1/chat/completions#x", "https://user@mesh.example.invalid/v1/chat/completions"]) {
      expect(() => meshEmbeddingsEndpoint(endpoint)).toThrow();
      expect(() => buildCompassEmbeddingRequest("What does Article 12 say?", { ...access, endpoint })).toThrow();
    }
    expect(() => buildCompassEmbeddingRequest("What does Article 12 say?", { ...access, surface: "demo" })).toThrow();
  });

  it("returns null, never a throw, and never calls the network on any attempt", async () => {
    const calls = [];
    const fetchOk = async (url, options) => { calls.push({ url, options }); return response(payload()); };
    await expect(embedCompassQuestion("What does Article 12 say?", access, fetchOk)).resolves.toBeNull();
    await expect(embedCompassQuestion("What does Article 12 say?", access, async () => response({ error: "down" }, { ok: false, status: 503 }))).resolves.toBeNull();
    await expect(embedCompassQuestion("What does Article 12 say?", access, async () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); })).resolves.toBeNull();
    await expect(embedCompassQuestion("What does Article 12 say?", access, async () => response(payload({ model: "other" })))).resolves.toBeNull();
    await expect(embedCompassQuestion("What does Article 12 say?", access, async () => ({ ok: true, headers: headers(), json: async () => { throw new Error("malformed"); } }))).resolves.toBeNull();
    await expect(embedCompassQuestion("What does Article 12 say?", { ...access, credentials: {} }, fetchOk)).resolves.toBeNull();
    await expect(embedCompassQuestion("Marisol Alvarez has lupus.", access, fetchOk)).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });
});
