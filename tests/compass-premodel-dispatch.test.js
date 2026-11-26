// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/guide.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));
const targetId = "d9cc6efb-fd83-43b3-9712-8b646a857b66";
const reservation = "00000000-0000-4000-8000-000000000001";
const source = { source_id: "kb:article-12", kind: "contract", title: "Article 12", ref: "Article 12", snippet: "Just cause and progressive discipline apply." };
const sensitive = "Marisol Alvarez has lupus, SSN 123-45-6789 and email marisol@example.org.";
// Union Ground has no approved mesh (the Guide refuses mesh_unconfigured), so
// the provider boundary is exercised through the one path that can answer: a
// governed connector provider resolved by the platform.
const CONNECTOR_GATEWAY = "ai_connector_gemini";
const CONNECTOR_MODEL = "gemini-2.5-flash";
const MESH_MODEL = CONNECTOR_MODEL;
const MESH_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
function setup({ meshProvider = false, messages = [{ actor: targetId, body: `${sensitive}\nCan we meet Thursday?`, createdAt: "2026-09-04T16:03:22Z" }], retrieved = [source], context = {}, organizationId = null, scope, providerFailure = false } = {}) {
  const requests = [];
  const fetchMock = vi.fn(async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : undefined;
    requests.push({ url, body });
    let value;
    if (url.endsWith("/auth/v1/user")) value = { id: "user-1" };
    else if (url.endsWith("authorize_engagement_staff")) value = true;
    else if (url.endsWith("get_compass_ai_context")) value = { organization_id: organizationId,
      ...(scope && ["lexical", "hybrid"].includes(body.p_kind) ? { scope } : {}),
      data: body.p_kind === "briefing" ? { sourceKind: "private", targetId, messages, sourceRevision: "source-revision-proof" }
        : body.p_kind === "portal" ? context : retrieved };
    else if (url.endsWith("resolve_compass_ai_provider")) value = meshProvider ? { gateway: "union-ground-mesh", model: "union-ground/compass-mesh:v1" } : { gateway: CONNECTOR_GATEWAY, model: CONNECTOR_MODEL, api_key: "connector-test-key-0001" };
    else if (url.endsWith("reserve_compass_ai_request")) value = { id: reservation };
    else if (url.endsWith("authorize_compass_ai_dispatch")) value = { organization_id: organizationId, authorized: true, evidence_ref: "connector-dispatch-evidence" };
    else if (url.endsWith("record_compass_ai_request_outcome")) value = true;
    else if (url.endsWith("release_member_ai_request")) value = true;
    else if (url.endsWith("persist_compass_message_briefing")) value = { summary: body.p_summary };
    else if (url === MESH_URL && providerFailure) throw Object.assign(new Error("synthetic outage"), { name: "TimeoutError" });
    else if (url === MESH_URL) value = { model: MESH_MODEL, choices: [{ index: 0, message: { role: "assistant",
      content: body.messages[0].content.includes("Draft one neutral meeting poll")
        ? JSON.stringify({ title: "Meeting time", description: "Choose a time.", options: [{ label: "Morning" }, { label: "Afternoon" }], resultsVisibility: "after_close", eligibility: "organization" })
        : JSON.stringify({ summary: "A meeting was requested.", actionItems: [] }),
    }, finish_reason: "stop" }] };
    else throw new Error(`Unexpected test URL ${url}`);
    return { ok: true, status: 200, text: async () => JSON.stringify(value), json: async () => value, headers: { get: () => null } };
  });
  vi.stubGlobal("fetch", fetchMock);
  const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
  return { requests, diagnostics };
}
async function invoke(body) {
  const response = { statusCode: 0, body: "", status(code) { this.statusCode = code; return this; }, setHeader() {}, end(value) { this.body = value; } };
  await handler({ method: "POST", headers: { authorization: "Bearer member-test-token" }, body }, response);
  return { status: response.statusCode, body: JSON.parse(response.body) };
}
beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-test-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("actual Compass provider dispatch", () => {
  it("refuses a platform-resolved mesh as unconfigured before any reservation or provider call", async () => {
    const { requests } = setup({ meshProvider: true });
    const result = await invoke({ mode: "question", question: "What does Article 12 say?" });
    expect(result.status).toBe(503);
    expect(result.body.error).toBe("Union Ground Guide is not configured.");
    expect(requests.some((item) => item.url === MESH_URL || item.url.includes("reserve_compass_ai_request"))).toBe(false);
    expect(requests.some((item) => item.url.includes("mesh"))).toBe(false);
  });
  it("adds verified scope notices after dispatch without sending other memberships to the provider", async () => {
    const organizationId = "00000000-0000-4000-8000-000000000010";
    const other = "00000000-0000-4000-8000-000000000011";
    const { requests } = setup({ organizationId, retrieved: [{ ...source, organization_id: organizationId, scope_level: "local" }],
      scope: { version: "compass-scope-v1", organization_id: organizationId, local_fallback: true, matching_organization_ids: [other] } });
    const result = await invoke({ mode: "question", question: "What does Article 12 say?" });
    expect(result.status).toBe(200);
    expect(result.body.scope_notices).toEqual(["local_fallback", "other_organization"]);
    const request = requests.find((item) => item.url === MESH_URL);
    expect(request).toBeDefined();
    expect(JSON.stringify(request)).not.toContain(other);
    expect(JSON.stringify(result.body)).not.toContain(other);
  });
  it("retains verified scope codes when generation times out without exposing other tenant identities", async () => {
    const organizationId = "00000000-0000-4000-8000-000000000010";
    const other = "00000000-0000-4000-8000-000000000011";
    setup({ organizationId, providerFailure: true, retrieved: [{ ...source, organization_id: organizationId, scope_level: "local" }],
      scope: { version: "compass-scope-v1", organization_id: organizationId, local_fallback: true, matching_organization_ids: [other] } });
    const result = await invoke({ mode: "question", question: "What does Article 12 say?" });
    expect(result.status).toBe(504);
    expect(result.body.degraded).toBe("search_only");
    expect(result.body.scope_notices).toEqual(["local_fallback", "other_organization"]);
    expect(JSON.stringify(result.body)).not.toContain(other);
  });
  it("offers a membership switch after an authoritative empty result without a provider call", async () => {
    const organizationId = "00000000-0000-4000-8000-000000000020";
    const { requests } = setup({ organizationId, retrieved: [], scope: { version: "compass-scope-v1", organization_id: organizationId,
      local_fallback: false, matching_organization_ids: ["00000000-0000-4000-8000-000000000021"] } });
    const result = await invoke({ mode: "question", question: "What does Article 12 say?" });
    expect(result.status).toBe(200);
    expect(result.body.scope_notices).toEqual(["other_organization"]);
    expect(result.body.sources).toEqual([]);
    expect(requests.some((item) => item.url === MESH_URL)).toBe(false);
  });
  it.each(["private", "channel", "task"])("minimizes %s briefings before fetch", async (sourceKind) => {
    const { requests } = setup();
    expect((await invoke({ mode: "message_briefing", sourceKind, targetId })).status).toBe(200);
    expect(requests.find(item => item.url.endsWith("persist_compass_message_briefing"))?.body.p_source_revision).toBe("source-revision-proof");
    const request = requests.find((item) => item.url === MESH_URL);
    expect(request).toBeDefined();
    for (const value of [targetId, "Marisol", "lupus", "123-45-6789", "marisol@example.org", "2026-09-04", "member-test-token"]) expect(JSON.stringify(request)).not.toContain(value);
    expect(JSON.parse(request.body.messages[1].content)).toEqual([{ actor: "Participant 1", body: "[details withheld] Can we meet Thursday?" }]);
    expect(request.body).not.toHaveProperty("providerOptions");
    expect(request.body).toMatchObject({ model: MESH_MODEL, stream: false });
  });
  it.each(["question", "poll_draft"])("minimizes %s text at the actual fetch boundary", async (mode) => {
    const { requests } = setup();
    expect((await invoke({ mode, question: `${sensitive} What does Article 12 say?`, topic: `${sensitive} Draft a meeting poll.`, history: [{ role: "user", body: sensitive }] })).status).toBe(200);
    const request = requests.find((item) => item.url === MESH_URL);
    for (const value of ["Marisol", "lupus", "123-45-6789", "marisol@example.org"]) expect(JSON.stringify(request)).not.toContain(value);
  });
  it("blocks malformed RPC text before a structured reservation or provider call and logs only a fixed cause", async () => {
    const { requests, diagnostics } = setup({ messages: [{ actor: targetId, body: { secret: sensitive } }] });
    const result = await invoke({ mode: "message_briefing", sourceKind: "private", targetId });
    expect(result.status).toBe(503);
    expect(result.body.code).toBe("compass_privacy_unavailable");
    expect(requests.some((item) => item.url === MESH_URL || item.url.includes("reserve_compass_ai_request"))).toBe(false);
    expect(diagnostics.mock.calls).toEqual([["[guide] minimization failure", { cause: "redaction_failed" }]]);
  });
  it("releases an existing question reservation if a retrieval row is malformed", async () => {
    const { requests, diagnostics } = setup({ retrieved: [{ ...source, snippet: { secret: sensitive } }] });
    const result = await invoke({ question: "Help" });
    expect(result.status).toBe(503);
    expect(result.body.code).toBe("retrieval_unavailable");
    expect(requests.some((item) => item.url === MESH_URL)).toBe(false);
    expect(requests.at(-1).body).toEqual({ p_request_id: reservation });
    expect(requests.at(-1).url).toContain("release_member_ai_request");
    expect(diagnostics).not.toHaveBeenCalled();
  });
  it("does not send an entirely withheld question, topic, or thread to the model", async () => {
    // A withheld member question is the member's to reword: 422 before any
    // reservation (BUG-UG-COMPASS-GUIDE-503-PRODUCTION-20261003).
    for (const [body, status] of [[{ question: sensitive }, 422], [{ mode: "poll_draft", topic: sensitive }, 503], [{ mode: "message_briefing", sourceKind: "private", targetId }, 503]]) {
      const { requests } = setup({ messages: [{ actor: targetId, body: sensitive }] });
      expect((await invoke(body)).status).toBe(status);
      expect(requests.some((item) => item.url === MESH_URL)).toBe(false);
      if (status === 422) expect(requests.some((item) => item.url.includes("reserve_compass_ai_request"))).toBe(false);
    }
  });
  it("uses the existing grounding response for case-only retrieval and never dispatches", async () => {
    const { requests } = setup({ retrieved: [{ ...source, kind: "case", source_id: "case:private-id" }] });
    const result = await invoke({ question: "Help" });
    expect(result.status).toBe(200);
    expect(result.body.meta.model).toBe("grounding-gate");
    expect(result.body.sources).toEqual([]);
    expect(requests.some((item) => item.url === MESH_URL)).toBe(false);
    // Retrieval answered; the rows were case rows this gate must not ground on.
    // That is an honest no-match, so the reservation is NOT refunded -- the
    // attempt keeps counting toward the member's hourly cap.
    expect(requests.some((item) => item.url.includes("release_member_ai_request"))).toBe(false);
    expect(requests.at(-1).url).toContain("record_compass_ai_request_outcome");
    expect(requests.at(-1).body).toEqual({ p_request_id: reservation, p_user_id: "user-1", p_outcome: "no_source" });
  });

});
