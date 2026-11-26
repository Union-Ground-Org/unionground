#!/usr/bin/env node
import { buildPollDraftMessages } from "../api/_lib/compassPrompts.js";
import {
  COMPASS_AI_CONFIG,
  MESH_ENDPOINTS,
  MESH_GATEWAY,
  MESH_MODEL,
  buildCompassGatewayRequest,
  readMeshResponse,
  safeGatewayDiagnostic,
} from "../api/_lib/compassAiGovernance.js";

function assert(condition, message) {
  if (!condition) throw new Error(`AI_GOVERNANCE_FAIL: ${message}`);
}

const sensitiveSentinel = "ci-synthetic-sensitive-content";
const access = Object.freeze({
  surface: "saas",
  endpoint: MESH_ENDPOINTS.saas,
  credentials: { apiKey: "ci-synthetic-mesh-bearer", accessClientId: "ci-synthetic-access-id", accessClientSecret: "ci-synthetic-access-secret" },
  provider: { gateway: MESH_GATEWAY, model: MESH_MODEL, connector: null },
});
const built = buildCompassGatewayRequest(buildPollDraftMessages(`${sensitiveSentinel}. Draft a meeting poll.`), access);
const body = JSON.parse(built.options.body);
assert(!built.options.body.includes(sensitiveSentinel), "sensitive input bypassed minimization");
let rejectedRaw = false;
try { buildCompassGatewayRequest([{ role: "user", content: sensitiveSentinel }], access); }
catch { rejectedRaw = true; }
assert(rejectedRaw, "raw prompts bypassed the privacy boundary");

assert(Object.isFrozen(COMPASS_AI_CONFIG), "configuration must be immutable");
assert(Object.isFrozen(COMPASS_AI_CONFIG.providerPolicy), "provider policy must be immutable");
assert(COMPASS_AI_CONFIG.gateway === "union-ground-mesh", "unexpected provider gateway");
assert(new URL(built.url).host === "mesh.example.org", "unexpected provider endpoint host");
assert(body.model === "union-ground/compass-mesh:v1", "unexpected provider model");
assert(body.stream === false, "mesh requests must not stream");
assert(!("providerOptions" in body), "third-party gateway options must not be sent to the mesh");
assert(built.options.headers["CF-Access-Client-Id"] && built.options.headers["CF-Access-Client-Secret"], "Access service token missing");
assert(built.options.headers["X-UG-Mesh-Env"] === "production", "environment tag missing");

body.model = "ci/unapproved-model";
const rebuilt = JSON.parse(buildCompassGatewayRequest(buildPollDraftMessages("Draft a poll."), access).options.body);
assert(rebuilt.model === COMPASS_AI_CONFIG.model, "a previous body mutation changed the model");

const digest = `sha256:${"a".repeat(64)}`;
const headers = (map) => ({ get: (name) => map[name.toLowerCase()] ?? null });
const proof = { "x-ug-mesh-host": "mesh-host-1", "x-ug-mesh-model-digest": digest, "x-ug-mesh-request-id": "ci-proof-1" };
const reply = { model: MESH_MODEL, choices: [{ message: { content: "ci-synthetic-answer" } }] };
assert(readMeshResponse(reply, headers(proof), { attestedDigest: digest }).ok, "a compliant mesh reply must be accepted");
assert(!readMeshResponse(reply, headers(proof), { attestedDigest: `sha256:${"b".repeat(64)}` }).ok, "an unattested digest must be rejected");
assert(!readMeshResponse(reply, headers({ ...proof, "x-ug-mesh-host": "elsewhere" }), { attestedDigest: digest }).ok, "an unknown host must be rejected");
assert(!readMeshResponse({ ...reply, model: "other" }, headers(proof), { attestedDigest: digest }).ok, "a foreign model must be rejected");

const diagnostic = JSON.stringify(safeGatewayDiagnostic({
  status: 502,
  headers: { get: () => null },
  body: sensitiveSentinel,
}, sensitiveSentinel));
assert(!diagnostic.includes(sensitiveSentinel), "diagnostics copied request or provider content");

console.log("PASS: Compass provider request targets only the in-house mesh with both credential layers, proof-header verification, and bounded diagnostics.");
