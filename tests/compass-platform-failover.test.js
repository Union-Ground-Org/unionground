// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { completeWithMeshFailover } from "../api/_lib/compassFailover.js";
import { buildGuideMessages } from "../api/_lib/compassPrompts.js";
import { MESH_GATEWAY, FIREWORKS_GATEWAY, normalizeResolvedProvider } from "../api/_lib/compassAiGovernance.js";

const meshModel = "union-ground/compass-mesh:v2";
const fireworksModel = "accounts/fireworks/models/muse-spark-open";
const digest = `sha256:${"a".repeat(64)}`;
const orgA = "f5140000-0000-4000-8000-000000000001";
const orgB = "f5140000-0000-4000-8000-000000000002";
const credential = "synthetic-platform-fireworks-fixture";
const access = { surface: "saas", provider: { gateway: MESH_GATEWAY, model: meshModel, connector: null },
  credentials: { apiKey: "synthetic-mesh", accessClientId: "synthetic-access", accessClientSecret: "synthetic-access-secret" } };
const source = { source_id: "kb:private-proof", kind: "contract", title: "Authorized agreement", ref: "Article 12", snippet: "The agreement requires just cause." };
const messages = () => buildGuideMessages("What does Article 12 say?", {}, [], [source]);
const fallback = (scope = orgA) => ({ authorized: true, gateway: FIREWORKS_GATEWAY, model: fireworksModel, api_key: credential, isolation_scope: scope });
function response({ model = meshModel, status = 200, proof = true, content = "The agreement requires just cause." } = {}) {
  return { ok: status === 200, status,
    headers: new Headers(proof ? { "x-ug-mesh-host": "mesh-host-1", "x-ug-mesh-model-digest": digest, "x-ug-mesh-request-id": "fixture-request" } : {}),
    json: async () => ({ model, choices: [{ message: { content } }] }),
  };
}
const run = (authorizeFailover, options = {}) => completeWithMeshFailover({ messages: messages(), access, attestedDigest: digest, authorizeFailover, ...options });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("centrally managed mesh-first failover", () => {
  // Union Ground approves no mesh host (MESH_HOSTS is empty), so even a
  // well-formed mesh answer cannot pass response integrity. That refusal is an
  // integrity failure, never an outage, so it must not resolve the paid fallback.
  it("never accepts a mesh answer while no host is approved, and does not resolve a paid credential for it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    const authorize = vi.fn();
    await expect(run(authorize)).rejects.toThrow("provider response refused");
    expect(authorize).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([408, 429, 500, 502, 503, 504])("tries Fireworks once after HTTP %s with the same minimized context", async (status) => {
    const request = vi.fn().mockResolvedValueOnce(response({ status })).mockResolvedValueOnce(response({ model: fireworksModel, proof: false }));
    vi.stubGlobal("fetch", request);
    const authorize = vi.fn(async () => fallback());
    const result = await run(authorize);
    expect(result.provider.gateway).toBe(FIREWORKS_GATEWAY);
    expect(authorize).toHaveBeenCalledExactlyOnceWith("temporary_http");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toBe("https://api.fireworks.ai/inference/v1/chat/completions");
    const primary = JSON.parse(request.mock.calls[0][1].body);
    const secondary = JSON.parse(request.mock.calls[1][1].body);
    expect(secondary.messages).toEqual(primary.messages);
    // Muse Spark Open documents no reasoning_effort field, so none is sent.
    expect(secondary).toMatchObject({ model: fireworksModel, stream: false });
    expect(secondary).not.toHaveProperty("reasoning_effort");
    expect(secondary.max_tokens).toBeGreaterThanOrEqual(4096);
    expect(JSON.stringify(secondary)).not.toContain(orgA);
    expect(JSON.stringify(secondary)).not.toContain(credential);
    expect(request.mock.calls[1][1].redirect).toBe("error");
  });

  it("sends gpt-oss its reasoning effort until the operator moves the row off it", async () => {
    const retired = "accounts/fireworks/models/gpt-oss-120b";
    const request = vi.fn().mockResolvedValueOnce(response({ status: 503 })).mockResolvedValueOnce(response({ model: retired, proof: false }));
    vi.stubGlobal("fetch", request);
    await run(vi.fn(async () => ({ ...fallback(), model: retired })));
    expect(JSON.parse(request.mock.calls[1][1].body)).toMatchObject({ model: retired, reasoning_effort: "medium" });
  });

  it.each(["TypeError", "TimeoutError", "AbortError"])("permits bounded failover for %s only from fetch", async (name) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(Object.assign(new Error("private reflected error"), { name }))
      .mockResolvedValueOnce(response({ model: fireworksModel, proof: false })));
    const authorize = vi.fn(async () => fallback());
    await run(authorize);
    expect(authorize).toHaveBeenCalledExactlyOnceWith(name === "TypeError" ? "transport" : "timeout");
  });

  it.each([400, 401, 402, 403, 404, 422])("does not reinterpret HTTP %s as an outage", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ status })));
    const authorize = vi.fn();
    await expect(run(authorize)).rejects.toThrow();
    expect(authorize).not.toHaveBeenCalled();
  });

  it.each([{ proof: false }, { model: "wrong-model" }, { content: "" }])("never bypasses response integrity rejection %j", async (settings) => {
    vi.stubGlobal("fetch", vi.fn(async () => response(settings)));
    const authorize = vi.fn();
    await expect(run(authorize)).rejects.toThrow();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("turns an unreadable 200 body into a bounded gateway error that still names the provider", async () => {
    const unreadable = { ok: true, status: 200, headers: new Headers(), json: async () => { throw new SyntaxError("Unexpected end of JSON input"); } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ status: 503 })).mockResolvedValueOnce(unreadable));
    await expect(run(async () => fallback())).rejects.toMatchObject({ gatewayCause: "gateway_error", gatewayResponse: unreadable, provider: { gateway: FIREWORKS_GATEWAY } });
    // A body read that hits the request deadline keeps its timeout class.
    const stalled = { ...unreadable, json: async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(stalled));
    await expect(run(vi.fn())).rejects.toMatchObject({ name: "TimeoutError", gatewayCause: "gateway_timeout", gatewayResponse: stalled });
  });

  it("never falls back for malformed JSON or unsealed messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ...response(), json: async () => { throw new SyntaxError("invalid reply"); } })));
    const authorize = vi.fn();
    await expect(run(authorize)).rejects.toThrow();
    await expect(run(authorize, { messages: [{ role: "user", content: "unminimized private content" }] })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(authorize).not.toHaveBeenCalled();
  });

  it.each(["disabled", "reservation", "role", "unattested", "config"])("honors the fallback recheck's %s refusal", async (cause) => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ status: 503 })));
    await expect(run(async () => ({ authorized: false, cause }))).rejects.toMatchObject({ cause, failoverRefused: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves the original outage if optional fallback is not configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ status: 503 })));
    await expect(run(async () => ({ authorized: false, cause: "fallback_unconfigured" }))).rejects.toMatchObject({ gatewayCause: "gateway_error" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses missing scope and never loops after Fireworks fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ status: 503 })));
    expect(normalizeResolvedProvider(fallback(null))).toBeNull();
    await expect(run(async () => fallback(null))).rejects.toMatchObject({ failoverRefused: true });
    const authorize = vi.fn(async () => fallback());
    fetch.mockClear();
    // The propagated failure names the fallback provider so the diagnostic
    // and the operator alert blame Fireworks, not the mesh that was abandoned.
    await expect(run(authorize)).rejects.toMatchObject({ gatewayCause: "gateway_error", provider: { gateway: FIREWORKS_GATEWAY } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it("refuses a provider whose isolation scope is lost before the network boundary", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const provider = normalizeResolvedProvider(fallback());
    delete provider.isolationScope;
    await expect(run(undefined, { access: { ...access, provider } })).rejects.toThrow("platform provider scope unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("separates provider cache namespaces by organization and environment without transmitting identities", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => response(url.includes("fireworks.ai")
      ? { model: fireworksModel, proof: false } : { status: 503 })));
    for (const [scope, surface] of [[orgA, "saas"], [orgA, "saas"], [orgB, "saas"], [orgA, "demo"]]) {
      await run(async () => fallback(scope), { access: { ...access, surface } });
    }
    const calls = fetch.mock.calls.filter(([url]) => url.includes("fireworks.ai"));
    const keys = calls.map(([, options]) => options.headers["x-prompt-cache-isolation-key"]);
    expect(keys.every((key) => /^[a-f0-9]{64}$/.test(key))).toBe(true);
    expect(keys[0]).toBe(keys[1]);
    expect(new Set([keys[0], keys[2], keys[3]]).size).toBe(3);
    expect(JSON.stringify(calls)).not.toContain(orgA);
    expect(JSON.stringify(calls)).not.toContain(orgB);
  });
});
