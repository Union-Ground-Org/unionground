// @vitest-environment node
import { buildCompassEvalJudgeMessages, buildPollDraftMessages } from "../api/_lib/compassPrompts.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { siblingIdentityIn } from "../scripts/lib/sibling-deny-list.mjs";
import { DENIED_SAAS_HOST } from "./helpers/denied-identity-fixtures.js";
import {
  AGENCY_CONNECTORS,
  COMPASS_AI_CONFIG,
  MESH_ENDPOINTS,
  MESH_GATEWAY,
  MESH_HOSTS,
  MESH_MODEL,
  MESH_MODELS,
  attestedDigestFromEvidence,
  buildCompassGatewayRequest,
  buildCompassJudgeGatewayRequest,
  connectorModelMatches,
  hasMeshProofHeaders,
  meshCredentialsComplete,
  meshCredentialsFromEnv,
  normalizeResolvedProvider,
  readConnectorResponse,
  readMeshResponse,
  readProviderResponse,
  resolveMeshEndpoint,
  safeGatewayDiagnostic,
} from "../api/_lib/compassAiGovernance.js";

// Contract: the in-house AI mesh contract §9 (the spec is not part of this repo).
// Union Ground operates no mesh and has no approved AI provider: every mesh
// endpoint and host list is empty, and api/guide.js refuses a mesh resolution
// as unconfigured. The request-shape checks below use a synthetic, never
// resolvable endpoint to pin what the dispatch code would send; nothing in the
// product resolves to it.
const DIGEST = `sha256:${"b".repeat(64)}`;
const SYNTHETIC_ENDPOINT = "https://mesh.example.invalid/v1/chat/completions";
const credentials = { apiKey: "mesh-origin-bearer-value", accessClientId: "cf-access-id", accessClientSecret: "cf-access-secret" };
const meshAccess = { surface: "saas", endpoint: SYNTHETIC_ENDPOINT, credentials, provider: { gateway: MESH_GATEWAY, model: MESH_MODEL, connector: null } };

function headers(map) {
  const lower = Object.fromEntries(Object.entries(map).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => lower[name.toLowerCase()] ?? null };
}
const proofHeaders = (overrides = {}) => headers({
  "x-ug-mesh-host": "mesh-host-1",
  "x-ug-mesh-model-digest": DIGEST,
  "x-ug-mesh-request-id": "0f9c2d7e-1234-4abc-8def-1234567890ab",
  ...overrides,
});
const meshCompletion = (content = "A grounded answer.") => ({
  id: "chatcmpl-1", object: "chat.completion", model: MESH_MODEL,
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
});

afterEach(() => vi.unstubAllEnvs());

describe("Compass provider policy boundary", () => {
  it("resolves to no mesh endpoint or host, keeping only the database's identifiers", () => {
    // The gateway and model ids stay because the policy rows and CHECK
    // constraints name them; they reach no network target.
    expect(COMPASS_AI_CONFIG.gateway).toBe("union-ground-mesh");
    expect(COMPASS_AI_CONFIG.model).toBe("union-ground/compass-mesh:v1");
    expect(COMPASS_AI_CONFIG.endpoint).toBe("");
    expect(MESH_ENDPOINTS).toEqual({ saas: "", demo: "" });
    expect(Object.isFrozen(MESH_ENDPOINTS)).toBe(true);
    expect(COMPASS_AI_CONFIG.providerPolicy).toEqual({ zeroDataRetention: true, disallowPromptTraining: true });
    expect(resolveMeshEndpoint("saas", {})).toBe("");
    expect(resolveMeshEndpoint("demo", {})).toBe("");
    const governance = readFileSync("api/_lib/compassAiGovernance.js", "utf8");
    expect(siblingIdentityIn(governance)).toEqual([]);
    expect(readFileSync("api/guide.js", "utf8")).toContain('return { surface: "saas", endpoint: "", credentials: Object.freeze({}), configured: false };');
  });

  it("refuses every endpoint override, including the sibling product's mesh hosts", () => {
    for (const [surface, key] of [["saas", "MESH_AI_ENDPOINT"], ["demo", "SAMPLE_MESH_AI_ENDPOINT"]]) {
      for (const value of [
        "https://ai-gateway.example/v1/chat/completions",
        `https://mesh.${DENIED_SAAS_HOST}/v1/chat/completions`,
        `https://mesh-sample.${DENIED_SAAS_HOST}/v1/chat/completions`,
        SYNTHETIC_ENDPOINT,
        "not a url",
      ]) {
        expect(() => resolveMeshEndpoint(surface, { [key]: value }), `${surface} ${value}`).toThrow(/allowlist/);
      }
    }
  });

  it("reads production and SAMPLE credentials from their own variables and requires both layers", () => {
    const env = {
      MESH_AI_API_KEY: "prod-key", MESH_AI_ACCESS_CLIENT_ID: "prod-id", MESH_AI_ACCESS_CLIENT_SECRET: "prod-secret",
      SAMPLE_MESH_AI_API_KEY: "sample-key", SAMPLE_MESH_AI_ACCESS_CLIENT_ID: "sample-id", SAMPLE_MESH_AI_ACCESS_CLIENT_SECRET: "sample-secret",
    };
    expect(meshCredentialsFromEnv("saas", env)).toEqual({ apiKey: "prod-key", accessClientId: "prod-id", accessClientSecret: "prod-secret" });
    expect(meshCredentialsFromEnv("demo", env)).toEqual({ apiKey: "sample-key", accessClientId: "sample-id", accessClientSecret: "sample-secret" });
    expect(meshCredentialsComplete(meshCredentialsFromEnv("saas", { MESH_AI_API_KEY: "only-bearer" }))).toBe(false);
    expect(meshCredentialsComplete(meshCredentialsFromEnv("saas", env))).toBe(true);
  });

  it("builds the mesh request with both credential layers, the environment tag, and no providerOptions", () => {
    const memberToken = "member-session-token-must-not-leak";
    const messages = buildPollDraftMessages("A bounded test question");
    const request = buildCompassGatewayRequest(messages, meshAccess);
    const body = JSON.parse(request.options.body);

    expect(request.url).toBe(SYNTHETIC_ENDPOINT);
    expect(request.options.method).toBe("POST");
    expect(request.options.headers).toEqual({
      Authorization: "Bearer mesh-origin-bearer-value",
      "CF-Access-Client-Id": "cf-access-id",
      "CF-Access-Client-Secret": "cf-access-secret",
      "Content-Type": "application/json",
      "X-UG-Mesh-Env": "production",
    });
    expect(JSON.stringify(request)).not.toContain(memberToken);
    expect(body).toEqual({ model: MESH_MODEL, messages, max_tokens: 500, temperature: 0.2, stream: false });
    expect(body).not.toHaveProperty("providerOptions");
    expect(buildCompassGatewayRequest(messages, { ...meshAccess, surface: "demo" }).options.headers["X-UG-Mesh-Env"]).toBe("sample");
  });

  it("refuses to build a mesh request without complete credentials", () => {
    const messages = buildPollDraftMessages("A bounded test question");
    expect(() => buildCompassGatewayRequest(messages, { ...meshAccess, credentials: { apiKey: "x" } })).toThrow(/credentials/);
  });

  it("builds the synthetic entailment judge on the same mesh with temperature zero", () => {
    const messages = buildCompassEvalJudgeMessages({
      caseId: "citation",
      rubric: "Pass only when every assertion follows from the grounded proposition.",
      source: { title: "Article 12", ref: "Contract · Article 12", organization: "Synthetic Organization A" },
      proposition: "The grounded proposition.",
      answer: "The candidate answer.",
    });
    expect(JSON.parse(messages[1].content)).toMatchObject({ source_title: "Article 12", source_reference: "Contract · Article 12", source_organization: "Synthetic Organization A" });
    for (const source of [undefined, { title: "Article 12", ref: "Contract · Article 12" }, { title: "Two\nlines", ref: "Contract", organization: "A" }]) {
      expect(() => buildCompassEvalJudgeMessages({ caseId: "citation", rubric: "Rubric.", source, proposition: "P.", answer: "A." })).toThrow();
    }
    const request = buildCompassJudgeGatewayRequest(messages, meshAccess);
    const body = JSON.parse(request.options.body);
    expect(request.url).toBe(SYNTHETIC_ENDPOINT);
    expect(body).toMatchObject({ model: MESH_MODEL, max_tokens: 160, temperature: 0, stream: false });
  });

  it("normalizes the resolved provider and refuses identifiers outside the catalog", () => {
    expect(normalizeResolvedProvider({ gateway: MESH_GATEWAY, model: MESH_MODEL })).toEqual({ gateway: MESH_GATEWAY, model: MESH_MODEL, connector: null });
    expect(normalizeResolvedProvider({ gateway: MESH_GATEWAY, model: "google/gemini-3-flash" })).toBeNull();
    expect(normalizeResolvedProvider({ gateway: "vercel-ai-gateway", model: MESH_MODEL })).toBeNull();
    expect(normalizeResolvedProvider({ gateway: "ai_connector_gpt", model: "gpt-5-mini", api_key: "sk-".padEnd(32, "x") })).toMatchObject({
      gateway: "ai_connector_gpt", model: "gpt-5-mini", connector: { vendor: "openai", endpoint: "https://api.openai.com/v1/chat/completions" },
    });
    expect(normalizeResolvedProvider({ gateway: "ai_connector_gpt", model: "gemini-2", api_key: "k".repeat(32) })).toBeNull();
    expect(normalizeResolvedProvider({ gateway: "ai_connector_claude", model: "claude-sonnet-5", api_key: "short" })).toBeNull();
    expect(normalizeResolvedProvider(null)).toBeNull();
  });

  it("routes a connector request to its fixed vendor endpoint with the agency key and never to the mesh", () => {
    const messages = buildPollDraftMessages("A bounded test question");
    const gpt = normalizeResolvedProvider({ gateway: "ai_connector_gpt", model: "gpt-5-mini", api_key: "sk-agency-key-value-0123456789" });
    const request = buildCompassGatewayRequest(messages, { ...meshAccess, provider: gpt });
    expect(request.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(request.options.headers).toEqual({ Authorization: "Bearer sk-agency-key-value-0123456789", "Content-Type": "application/json" });
    expect(JSON.stringify(request)).not.toContain("mesh-origin-bearer-value");
    expect(JSON.stringify(request)).not.toContain("cf-access");
    expect(JSON.parse(request.options.body)).toMatchObject({ model: "gpt-5-mini", stream: false });

    const claude = normalizeResolvedProvider({ gateway: "ai_connector_claude", model: "claude-sonnet-5", api_key: "sk-ant-agency-key-value-01234" });
    const anthropic = buildCompassGatewayRequest(messages, { ...meshAccess, provider: claude });
    const body = JSON.parse(anthropic.options.body);
    expect(anthropic.url).toBe("https://api.anthropic.com/v1/messages");
    expect(anthropic.options.headers).toEqual({ "x-api-key": "sk-ant-agency-key-value-01234", "anthropic-version": "2023-06-01", "Content-Type": "application/json" });
    expect(body.system).toBe(messages.find((message) => message.role === "system").content);
    expect(body.messages.every((message) => message.role !== "system")).toBe(true);
    expect(body).not.toHaveProperty("stream");
    expect(Object.keys(AGENCY_CONNECTORS)).toEqual(["ai_connector_gemini", "ai_connector_claude", "ai_connector_gpt", "ai_connector_fireworks"]);
  });

  // No mesh host is approved for Union Ground (MESH_HOSTS is empty), so even
  // a reply with the alias, an attested digest, and every proof header is
  // refused, and its content never comes back.
  it("accepts no mesh reply, even one with the alias, an attested digest, proof headers and content", () => {
    expect(MESH_HOSTS).toEqual([]);
    const verdict = readMeshResponse(meshCompletion("ready"), proofHeaders(), { attestedDigest: DIGEST });
    expect(verdict).toEqual({ ok: false, cause: "compliance_metadata_invalid" });
    expect(verdict).not.toHaveProperty("content");
    expect(readProviderResponse(meshCompletion("ready"), proofHeaders(), { provider: meshAccess.provider, attestedDigest: DIGEST }))
      .toEqual({ ok: false, cause: "compliance_metadata_invalid" });
  });

  for (const [name, payload, head, attested, cause] of [
    ["wrong model", { ...meshCompletion(), model: "qwen3.6:latest" }, proofHeaders(), DIGEST, "model_mismatch"],
    ["missing digest header", meshCompletion(), proofHeaders({ "x-ug-mesh-model-digest": undefined }), DIGEST, "compliance_metadata_invalid"],
    ["malformed digest header", meshCompletion(), proofHeaders({ "x-ug-mesh-model-digest": "sha256:zz" }), DIGEST, "compliance_metadata_invalid"],
    ["unattested digest", meshCompletion(), proofHeaders(), `sha256:${"c".repeat(64)}`, "compliance_metadata_invalid"],
    ["no attestation digest", meshCompletion(), proofHeaders(), null, "compliance_metadata_invalid"],
    ["unknown host", meshCompletion(), proofHeaders({ "x-ug-mesh-host": "attacker" }), DIGEST, "compliance_metadata_invalid"],
    ["malformed request id", meshCompletion(), proofHeaders({ "x-ug-mesh-request-id": "bad id\n" }), DIGEST, "compliance_metadata_invalid"],
    // The host check comes before content, so an empty reply is refused as
    // unproven before it could be read as a gateway error.
    ["empty content", meshCompletion("   "), proofHeaders(), DIGEST, "compliance_metadata_invalid"],
  ]) {
    it(`rejects ${name} and never returns content`, () => {
      const verdict = readMeshResponse(payload, head, { attestedDigest: attested });
      expect(verdict).toEqual({ ok: false, cause });
      expect(verdict).not.toHaveProperty("content");
    });
  }

  it("accepts a connector reply only when the model matches and the text is non-empty", () => {
    const gpt = normalizeResolvedProvider({ gateway: "ai_connector_gpt", model: "gpt-5-mini", api_key: "k".repeat(32) });
    expect(readConnectorResponse({ model: "gpt-5-mini", choices: [{ message: { content: "ok" } }] }, gpt)).toEqual({ ok: true, content: "ok", requestId: undefined });
    expect(readConnectorResponse({ model: "gpt-5", choices: [{ message: { content: "ok" } }] }, gpt)).toEqual({ ok: false, cause: "model_mismatch" });
    expect(readConnectorResponse({ model: "gpt-5-mini", choices: [{ message: { content: "" } }] }, gpt)).toEqual({ ok: false, cause: "gateway_error" });
    const claude = normalizeResolvedProvider({ gateway: "ai_connector_claude", model: "claude-sonnet-5", api_key: "k".repeat(32) });
    expect(readConnectorResponse({ model: "claude-sonnet-5", content: [{ type: "text", text: " answer " }] }, claude)).toEqual({ ok: true, content: "answer", requestId: undefined });
    expect(readConnectorResponse({ model: "claude-sonnet-5", content: [{ type: "tool_use" }] }, claude)).toEqual({ ok: false, cause: "gateway_error" });
  });

  it("accepts a vendor-resolved dated snapshot of the configured connector model", () => {
    const chat = (model, content) => ({ model, choices: [{ message: { content } }] });
    const anthropic = (model, content) => ({ model, content: [{ type: "text", text: content }] });
    const rows = [
      {
        gateway: "ai_connector_gpt",
        model: "gpt-5-mini",
        snapshot: "gpt-5-mini-2026-04-14",
        mismatches: ["gpt-5", "gpt-5-mini-high", "gpt-5-2026-04-14"],
        reply: chat,
      },
      {
        gateway: "ai_connector_claude",
        model: "claude-sonnet-5",
        snapshot: "claude-sonnet-5-20260514",
        mismatches: ["claude-opus-5-20260514", "claude-sonnet-5@20260514"],
        reply: anthropic,
      },
      {
        gateway: "ai_connector_gemini",
        model: "gemini-2.5-pro",
        snapshot: "gemini-2.5-pro-20260301",
        mismatches: ["gemini-2.5-flash", "gemini-2.0-pro-20260301"],
        reply: chat,
      },
    ];
    for (const row of rows) {
      const provider = normalizeResolvedProvider({ gateway: row.gateway, model: row.model, api_key: "k".repeat(32) });
      const pattern = AGENCY_CONNECTORS[row.gateway].modelPattern;
      expect(connectorModelMatches(row.model, row.model, pattern)).toBe(true);
      expect(connectorModelMatches(row.model, row.snapshot, pattern)).toBe(true);
      expect(readConnectorResponse(row.reply(row.model, "ok"), provider)).toEqual({ ok: true, content: "ok", requestId: undefined });
      expect(readConnectorResponse(row.reply(row.snapshot, "ok"), provider)).toEqual({ ok: true, content: "ok", requestId: undefined });
      for (const other of row.mismatches) {
        const verdict = readConnectorResponse(row.reply(other, "ok"), provider);
        expect(verdict).toEqual({ ok: false, cause: "model_mismatch" });
        expect(verdict).not.toHaveProperty("content");
      }
    }
  });

  it("accepts a vendor snapshot that replaces a trailing -0 alias suffix", () => {
    const pattern = AGENCY_CONNECTORS.ai_connector_claude.modelPattern;
    const anthropic = (model, content) => ({ model, content: [{ type: "text", text: content }] });
    expect(connectorModelMatches("claude-sonnet-4-0", "claude-sonnet-4-20250514", pattern)).toBe(true);
    const sonnet40 = normalizeResolvedProvider({
      gateway: "ai_connector_claude",
      model: "claude-sonnet-4-0",
      api_key: "k".repeat(32),
    });
    expect(readConnectorResponse(anthropic("claude-sonnet-4-0", "ok"), sonnet40)).toEqual({
      ok: true, content: "ok", requestId: undefined,
    });
    expect(readConnectorResponse(anthropic("claude-sonnet-4-20250514", "ok"), sonnet40)).toEqual({
      ok: true, content: "ok", requestId: undefined,
    });
    for (const other of ["claude-opus-4-20250514", "claude-sonnet-4-1-20250805", "claude-sonnet-4-0-high"]) {
      const verdict = readConnectorResponse(anthropic(other, "ok"), sonnet40);
      expect(verdict).toEqual({ ok: false, cause: "model_mismatch" });
      expect(verdict).not.toHaveProperty("content");
    }
    const opus41 = normalizeResolvedProvider({
      gateway: "ai_connector_claude",
      model: "claude-opus-4-1",
      api_key: "k".repeat(32),
    });
    expect(readConnectorResponse(anthropic("claude-opus-4-1-20250805", "ok"), opus41)).toEqual({
      ok: true, content: "ok", requestId: undefined,
    });
    expect(readConnectorResponse(anthropic("claude-opus-4-20250514", "ok"), opus41)).toEqual({
      ok: false, cause: "model_mismatch",
    });
  });

  it("refuses a connector reply that names no model, and a provider that configures none", () => {
    const pattern = AGENCY_CONNECTORS.ai_connector_gpt.modelPattern;
    expect(connectorModelMatches("gpt-5-mini", undefined, pattern)).toBe(false);
    expect(connectorModelMatches(undefined, "gpt-5-mini", pattern)).toBe(false);
    const gpt = normalizeResolvedProvider({ gateway: "ai_connector_gpt", model: "gpt-5-mini", api_key: "k".repeat(32) });
    const verdict = readConnectorResponse({ choices: [{ message: { content: "ok" } }] }, gpt);
    expect(verdict).toEqual({ ok: false, cause: "model_mismatch" });
    expect(verdict).not.toHaveProperty("content");
  });

  it("still requires an exact mesh alias plus attested digest and proof headers", () => {
    expect(readMeshResponse({ ...meshCompletion("ready"), model: `${MESH_MODEL}-20260920` }, proofHeaders(), { attestedDigest: DIGEST }))
      .toEqual({ ok: false, cause: "model_mismatch" });
    expect(readMeshResponse(meshCompletion("ready"), proofHeaders({ "x-ug-mesh-model-digest": undefined }), { attestedDigest: DIGEST }))
      .toEqual({ ok: false, cause: "compliance_metadata_invalid" });
    expect(readMeshResponse(meshCompletion("ready"), proofHeaders(), { attestedDigest: `sha256:${"c".repeat(64)}` }))
      .toEqual({ ok: false, cause: "compliance_metadata_invalid" });
    // No mesh host is a Union Ground host (MESH_HOSTS is empty).
    expect(readMeshResponse(meshCompletion("ready"), proofHeaders({ "x-ug-mesh-host": "mesh-host-1" }), { attestedDigest: DIGEST }))
      .toEqual({ ok: false, cause: "compliance_metadata_invalid" });
  });

  it("extracts the attested digest from the attestation evidence reference", () => {
    expect(attestedDigestFromEvidence(`${DIGEST} https://mesh.example.invalid`)).toBe(DIGEST);
    expect(attestedDigestFromEvidence("no digest here")).toBeNull();
    expect(hasMeshProofHeaders(proofHeaders())).toBe(true);
    expect(hasMeshProofHeaders(proofHeaders({ "x-ug-mesh-host": undefined }))).toBe(false);
  });

  it("keeps the failure diagnostic bounded and content-free", () => {
    const diagnostic = safeGatewayDiagnostic({ status: 502, headers: proofHeaders() }, "compliance_metadata_invalid", { metadataPresent: true });
    expect(diagnostic).toEqual({
      cause: "compliance_metadata_invalid", status: 502, model: MESH_MODEL, metadataPresent: true,
      requestId: "0f9c2d7e-1234-4abc-8def-1234567890ab",
    });
    expect(safeGatewayDiagnostic(undefined, "surprise")).toEqual({ cause: "unknown", status: 0, model: MESH_MODEL, metadataPresent: false });
    expect(safeGatewayDiagnostic({ status: 500, headers: headers({ "x-ug-mesh-request-id": "bad id\n" }) }, "gateway_error", { model: "gpt-5-mini" })).toEqual({
      cause: "gateway_error", status: 500, model: "gpt-5-mini", metadataPresent: false,
    });
  });

  it("covers the remaining fail-closed edges: malformed overrides, non-string rows, missing system prompt, endpoint fallback, header shapes", () => {
    // With no configured endpoint every override, even a malformed one, is
    // refused as outside the allowlist before it is parsed.
    expect(() => resolveMeshEndpoint("saas", { MESH_AI_ENDPOINT: "not a url" })).toThrow(/allowlist/);
    expect(normalizeResolvedProvider({ gateway: "ai_connector_gpt", model: 42, api_key: "k".repeat(32) })).toBeNull();
    expect(normalizeResolvedProvider({ gateway: "ai_connector_gpt", model: "gpt-5-mini", api_key: { reflected: true } })).toBeNull();

    // Without an explicit endpoint the mesh request falls back to its own
    // surface's allowlisted endpoint, which is empty here: never a host, and
    // never the other surface's.
    const fallback = buildCompassGatewayRequest(buildPollDraftMessages("A bounded test question"), { ...meshAccess, endpoint: undefined });
    expect(fallback.url).toBe(COMPASS_AI_CONFIG.endpoint);
    expect(fallback.url).toBe("");
    const demoFallback = buildCompassGatewayRequest(buildPollDraftMessages("A bounded test question"), { ...meshAccess, surface: "demo", endpoint: undefined });
    expect(demoFallback.url).toBe(MESH_ENDPOINTS.demo);
    expect(demoFallback.url).toBe("");
    expect(demoFallback.options.headers["X-UG-Mesh-Env"]).toBe("sample");

    // Header values that are not strings never satisfy a proof check.
    const odd = { get: (name) => (name === "x-ug-mesh-host" ? 42 : proofHeaders().get(name)) };
    expect(readMeshResponse(meshCompletion("ready"), odd, { attestedDigest: DIGEST })).toEqual({ ok: false, cause: "compliance_metadata_invalid" });
    expect(hasMeshProofHeaders(odd)).toBe(false);
    expect(attestedDigestFromEvidence(undefined)).toBeNull();

    // readProviderResponse dispatches to the connector reader for connector providers.
    const gpt = normalizeResolvedProvider({ gateway: "ai_connector_gpt", model: "gpt-5-mini", api_key: "k".repeat(32) });
    expect(readProviderResponse({ model: "gpt-5-mini", choices: [{ message: { content: "ok" } }] }, headers({}), { provider: gpt })).toEqual({ ok: true, content: "ok", requestId: undefined });
    expect(readConnectorResponse({ model: "gpt-5-mini" }, null)).toEqual({ ok: false, cause: "model_mismatch" });

    // A diagnostic never reports a model outside the catalog.
    expect(safeGatewayDiagnostic({ status: 500, headers: headers({ "x-request-id": "req-1" }) }, "gateway_error", { model: "untrusted/model" })).toEqual({
      cause: "gateway_error", status: 500, model: MESH_MODEL, metadataPresent: false, requestId: "req-1",
    });
  });

  it("names no third-party gateway or model anywhere outside docs", () => {
    // Files allowed to quote the retired identifiers: the historical migration
    // (immutable), the isolated local proof of that migration, and tests that
    // assert the identifiers are ABSENT from shipped copy.
    const allowed = new Set([
      "supabase/migrations/20260812113000_compass_ai_governance.sql",
      "scripts/verify-compass-ai-governance-local.mjs",
      "tests/compass-ai-governance-db.test.js",
      "tests/compass-ai-governance-guard.test.js",
      "tests/compass-inhouse-mesh-db.test.js",
      "tests/compass-ai-disclosure.test.jsx",
      "tests/legal-page-claims.test.js",
      "apps/mobile/src/lib/legalDocuments.test.ts",
    ]);
    const roots = ["api", "src", "scripts", "supabase", "tests", "apps/mobile/src"];
    const banned = [/ai-gateway\.vercel\.sh/, /gemini-3-flash/, /vercel-ai-gateway/];
    const hits = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "fixtures") continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!/\.(js|jsx|mjs|ts|tsx|sql|json)$/.test(entry) || allowed.has(path)) continue;
        const text = readFileSync(path, "utf8");
        for (const pattern of banned) if (pattern.test(text)) hits.push(`${path}: ${pattern}`);
      }
    };
    for (const root of roots) walk(root);
    expect(hits).toEqual([]);
  });
});

describe("Fireworks zero-retention connector", () => {
  const model = "accounts/fireworks/models/muse-spark-open";

  it("is catalogued on the chat-completions shape with a bounded account-scoped model rule", () => {
    expect(AGENCY_CONNECTORS.ai_connector_fireworks).toMatchObject({
      vendor: "fireworks",
      endpoint: "https://api.fireworks.ai/inference/v1/chat/completions",
      shape: "chat_completions",
    });
    const provider = normalizeResolvedProvider({ gateway: "ai_connector_fireworks", model, api_key: "fw_".padEnd(40, "x") });
    expect(provider).toMatchObject({ gateway: "ai_connector_fireworks", model, connector: { vendor: "fireworks" } });
    for (const bad of [
      "gpt-oss-120b",
      "accounts/other/models/gpt-oss-120b",
      // A Meta contributor model trains on what it receives; never selectable.
      "accounts/fireworks/models/muse-spark-1p3-contributor",
      "accounts/fireworks/models/muse-spark-contributor",
      "accounts/fireworks/models/",
      "accounts/fireworks/models/UPPER",
      "accounts/fireworks/models/a b",
      `accounts/fireworks/models/${"a".repeat(81)}`,
    ]) {
      expect(normalizeResolvedProvider({ gateway: "ai_connector_fireworks", model: bad, api_key: "k".repeat(32) })).toBeNull();
    }
    expect(normalizeResolvedProvider({ gateway: "ai_connector_fireworks", model, api_key: "short" })).toBeNull();
  });

  it("builds a bearer chat-completions request to the fixed endpoint and accepts only the configured model back", () => {
    const provider = normalizeResolvedProvider({ gateway: "ai_connector_fireworks", model, api_key: "fw_agency-key-value-0123456789" });
    const messages = buildPollDraftMessages("A bounded test question");
    const request = buildCompassGatewayRequest(messages, { ...meshAccess, provider });
    expect(request.url).toBe("https://api.fireworks.ai/inference/v1/chat/completions");
    expect(request.options.redirect).toBe("error");
    expect(request.options.headers).toEqual({ Authorization: "Bearer fw_agency-key-value-0123456789", "Content-Type": "application/json" });
    expect(JSON.parse(request.options.body)).toMatchObject({ model, max_tokens: 500, temperature: 0.2, stream: false });
    expect(request.options.headers).not.toHaveProperty("X-UG-Mesh-Env");
    expect(readConnectorResponse({ model, choices: [{ message: { content: "ok" } }] }, provider)).toEqual({ ok: true, content: "ok", requestId: undefined });
    expect(readConnectorResponse({ model: "accounts/fireworks/models/deepseek-v4-flash", choices: [{ message: { content: "ok" } }] }, provider)).toEqual({ ok: false, cause: "model_mismatch" });
    expect(readConnectorResponse({ model, choices: [{ message: { content: "" } }] }, provider)).toEqual({ ok: false, cause: "gateway_error" });
    expect(safeGatewayDiagnostic(undefined, "gateway_error", { model }).model).toBe(model);
  });
});

describe("Compass alias transition", () => {
  const V2 = "union-ground/compass-mesh:v2";

  it.each([undefined, null, { model: "union-ground/compass-mesh:v2-qwen27" }])("defaults an unresolved provider to v1 and refuses a trial reply (%j)", provider => {
    const messages = buildPollDraftMessages("A bounded test question");
    const request = buildCompassGatewayRequest(messages, { ...meshAccess, provider });
    expect(JSON.parse(request.options.body).model).toBe(MESH_MODEL);
    // The v1 reply passes the alias check and is then refused for want of an
    // approved mesh host.
    expect(readProviderResponse(meshCompletion("ready"), proofHeaders(), { provider, attestedDigest: DIGEST }))
      .toEqual({ ok: false, cause: "compliance_metadata_invalid" });
    expect(readProviderResponse({ ...meshCompletion("ready"), model: "union-ground/compass-mesh:v2-qwen27" }, proofHeaders(), { provider, attestedDigest: DIGEST }))
      .toEqual({ ok: false, cause: "model_mismatch" });
  });

  it.each([null, "", 0])("rejects an empty or non-string expected alias even when the reply repeats it (%j)", expectedModel => {
    expect(readMeshResponse({ ...meshCompletion("private text"), model: expectedModel }, proofHeaders(), { attestedDigest: DIGEST, expectedModel }))
      .toEqual({ ok: false, cause: "model_mismatch" });
  });

  it("rejects malformed provider content without exposing it as an answer", () => {
    const gpt = normalizeResolvedProvider({ gateway: "ai_connector_gpt", model: "gpt-5-mini", api_key: "k".repeat(32) });
    const claude = normalizeResolvedProvider({ gateway: "ai_connector_claude", model: "claude-sonnet-5", api_key: "k".repeat(32) });
    for (const content of [null, { text: "private text" }, 42]) {
      expect(readConnectorResponse({ model: gpt.model, choices: [{ message: { content } }] }, gpt))
        .toEqual({ ok: false, cause: "gateway_error" });
      expect(readConnectorResponse({ model: claude.model, content }, claude))
        .toEqual({ ok: false, cause: "gateway_error" });
    }
  });

  it("accepts exactly the listed aliases from the policy row", () => {
    expect(MESH_MODELS).toEqual([MESH_MODEL, V2]);
    expect(Object.isFrozen(MESH_MODELS)).toBe(true);
    expect(normalizeResolvedProvider({ gateway: MESH_GATEWAY, model: V2 })).toEqual({ gateway: MESH_GATEWAY, model: V2, connector: null });
    for (const model of ["union-ground/compass-mesh:v3", "union-ground/compass-mesh:v2-qwen27", "union-ground/compass-mesh:v1 ", "", null]) {
      expect(normalizeResolvedProvider({ gateway: MESH_GATEWAY, model })).toBeNull();
    }
  });

  it("names the row's alias in the request and requires the same alias back", () => {
    const messages = buildPollDraftMessages("A bounded test question");
    const v2Access = { ...meshAccess, provider: { gateway: MESH_GATEWAY, model: V2, connector: null } };
    expect(JSON.parse(buildCompassGatewayRequest(messages, v2Access).options.body).model).toBe(V2);
    expect(JSON.parse(buildCompassGatewayRequest(messages, meshAccess).options.body).model).toBe(MESH_MODEL);
    expect(JSON.parse(buildCompassJudgeGatewayRequest(messages, meshAccess).options.body).model).toBe(MESH_MODEL);
    // The alias check runs first; a matching alias is then refused for want
    // of an approved mesh host.
    expect(readProviderResponse({ ...meshCompletion("ready"), model: V2 }, proofHeaders(), { provider: v2Access.provider, attestedDigest: DIGEST })).toEqual({ ok: false, cause: "compliance_metadata_invalid" });
    expect(readProviderResponse(meshCompletion("ready"), proofHeaders(), { provider: v2Access.provider, attestedDigest: DIGEST })).toEqual({ ok: false, cause: "model_mismatch" });
    expect(readProviderResponse(meshCompletion("ready"), proofHeaders(), { provider: meshAccess.provider, attestedDigest: DIGEST })).toEqual({ ok: false, cause: "compliance_metadata_invalid" });
    expect(readMeshResponse({ ...meshCompletion("ready"), model: V2 }, proofHeaders(), { attestedDigest: DIGEST })).toEqual({ ok: false, cause: "model_mismatch" });
    expect(readMeshResponse({ ...meshCompletion("ready"), model: V2 }, proofHeaders(), { attestedDigest: DIGEST, expectedModel: V2 })).toEqual({ ok: false, cause: "compliance_metadata_invalid" });
    expect(readMeshResponse({ ...meshCompletion("ready"), model: "other" }, proofHeaders(), { attestedDigest: DIGEST, expectedModel: "other" })).toEqual({ ok: false, cause: "model_mismatch" });
    expect(safeGatewayDiagnostic(undefined, "gateway_error", { model: V2 }).model).toBe(V2);
    expect(safeGatewayDiagnostic(undefined, "gateway_error", { model: "union-ground/compass-mesh:v3" }).model).toBe(MESH_MODEL);
  });
});
