// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler, { buildMessageBriefingMessages, buildPollDraftMessages, parseStructuredAnswer } from "../api/guide.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

const reservationId = "00000000-0000-4000-8000-000000000001";
const targetId = "00000000-0000-4000-8000-000000000010";
// Union Ground has no approved mesh (the Guide refuses mesh_unconfigured), so
// the structured modes are exercised through a governed connector provider
// resolved by the platform. A connector reply carries no mesh proof headers; it
// is accepted only when its model is the configured one or that model's dated
// snapshot.
const CONNECTOR_MODEL = "gemini-2.5-flash";
const CONNECTOR_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const CONNECTOR_PROVIDER = { gateway: "ai_connector_gemini", model: CONNECTOR_MODEL, api_key: "connector-test-key-0001" };
const MESH_PROVIDER = { gateway: "union-ground-mesh", model: "union-ground/compass-mesh:v1" };
const DISPATCH = { organization_id: null, authorized: true, cause: null, evidence_ref: "connector-dispatch-evidence" };

function responseRecorder() {
  return { statusCode: 0, body: "", status(code) { this.statusCode = code; return this; }, setHeader() {}, end(value) { this.body = value; } };
}

function res(value, status = 200, headers = {}) {
  const body = JSON.stringify(value);
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body), headers: { get: (name) => headers[String(name).toLowerCase()] ?? null } };
}

function completion(content, extra = {}, headers = {}) {
  return res({
    model: CONNECTOR_MODEL,
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    ...extra,
  }, 200, headers);
}

function sequence(items) {
  const pending = [...items];
  const fetchMock = vi.fn(async (url) => {
    const item = pending.shift();
    if (item?.ok && url.endsWith("get_compass_ai_context")) return res({ organization_id: null, data: await item.json() });
    return item;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function run(body) {
  const response = responseRecorder();
  await handler({ method: "POST", headers: { authorization: "Bearer member-token" }, body }, response);
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("structured engagement Compass modes", () => {
  it("builds bounded, JSON-only prompts", () => {
    expect(buildPollDraftMessages("Shift meeting")[0].content).toContain("Return JSON only");
    const messages = buildMessageBriefingMessages({ messages: Array.from({ length: 45 }, () => ({ actor: "member", body: `Can we meet Thursday?`, createdAt: "2026-08-28" })) });
    expect(JSON.parse(messages[1].content)).toHaveLength(40);
    expect(parseStructuredAnswer("```json\n{\"summary\":\"ok\"}\n```")).toEqual({ summary: "ok" });
  });

  it("authorizes staff, reserves and rechecks governance, then returns a normalized poll draft", async () => {
    const fetchMock = sequence([
      res({ id: "staff-user" }),
      res(true),
      res(CONNECTOR_PROVIDER), res({ id: reservationId, cause: null }),
      res(DISPATCH),
      completion(JSON.stringify({
        title: "Which meeting time works best?",
        description: "Choose one time.",
        options: [{ label: "5:00 PM" }, { label: "6:00 PM" }],
        resultsVisibility: "live",
        eligibility: "roster",
      })),
    ]);
    const result = await run({ mode: "poll_draft", topic: "Draft a meeting-time poll" });
    expect(result.status).toBe(200);
    expect(result.body.draft).toMatchObject({
      title: "Which meeting time works best?",
      resultsVisibility: "after_close",
      eligibility: "organization",
      options: [{ label: "5:00 PM" }, { label: "6:00 PM" }],
    });
    expect(fetchMock.mock.calls[1][0]).toContain("authorize_engagement_staff");
    // PERF-UG-ENGAGEMENT-STAFF-GATE-RUNS-THE-WHOLE-SNAPSHOT-20260920: the
    // gate must cost the staff predicate, never the whole staff dashboard.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("get_staff_engagement_snapshot"))).toBe(false);
    expect(fetchMock.mock.calls[2][0]).toContain("resolve_compass_ai_provider");
    expect(fetchMock.mock.calls[3][0]).toContain("reserve_compass_ai_request");
    expect(fetchMock.mock.calls[4][0]).toContain("authorize_compass_ai_dispatch");
  });

  it("loads only server-authorized thread rows and persists the bounded briefing", async () => {
    const fetchMock = sequence([
      res({ id: "staff-user" }),
      res(true),
      res({ sourceKind: "private", targetId, messages: [{ actor: "member", body: "Can we meet Thursday?", createdAt: "2026-08-28" }] }),
      res(CONNECTOR_PROVIDER), res({ id: reservationId, cause: null }),
      res(DISPATCH),
      completion(JSON.stringify({ summary: "A meeting was requested for Thursday.", actionItems: ["Confirm a time"] })),
      res({ id: "briefing-1", sourceKind: "private", targetId, summary: "A meeting was requested for Thursday.", actionItems: ["Confirm a time"] }),
    ]);
    const result = await run({ mode: "message_briefing", sourceKind: "private", targetId });
    expect(result.status).toBe(200);
    expect(result.body.briefing.summary).toContain("Thursday");
    expect(fetchMock.mock.calls[1][0]).toContain("authorize_engagement_staff");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("get_staff_engagement_snapshot"))).toBe(false);
    expect(fetchMock.mock.calls[2][0]).toContain("get_compass_ai_context");
    expect(fetchMock.mock.calls[7][0]).toContain("persist_compass_message_briefing");
    expect(JSON.parse(fetchMock.mock.calls[7][1].body)).toMatchObject({
      p_source_kind: "private", p_target_id: targetId,
      p_summary: "A meeting was requested for Thursday.", p_action_items: ["Confirm a time"],
    });
  });

  it("never calls the provider when the source thread is unauthorized", async () => {
    const fetchMock = sequence([res({ id: "staff-user" }), res(true), res({ error: "not found" }, 404)]);
    const result = await run({ mode: "message_briefing", sourceKind: "private", targetId });
    expect(result.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // SEC-UG-COMPASS-SOURCE-ORGANIZATION-SCOPE-20261012: a thread from
  // another organization than the selected one is refused by the context
  // wrapper with not found; nothing is reserved, dispatched or saved.
  it("never reserves, dispatches or saves when the context refuses a thread outside the selected organization", async () => {
    const fetchMock = sequence([res({ id: "staff-user" }), res(true), res({ code: "P0002", message: "not found" }, 404)]);
    const result = await run({ mode: "message_briefing", sourceKind: "private", targetId });
    expect(result).toEqual({ status: 404, body: { error: "That message thread is unavailable." } });
    const called = fetchMock.mock.calls.map(([url]) => String(url));
    for (const name of ["reserve_compass_ai_request", "authorize_compass_ai_dispatch", "authorize_compass_ai_failover", "persist_compass_message_briefing", "/chat/completions"]) {
      expect(called.some((url) => url.includes(name)), name).toBe(false);
    }
  });

  it("rejects member-only identities before loading or briefing a thread", async () => {
    const fetchMock = sequence([res({ id: "member-user" }), res({ error: "staff required" }, 403)]);
    const result = await run({ mode: "message_briefing", sourceKind: "private", targetId });
    expect(result.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("authorize_engagement_staff");
  });

  it.each([
    ["poll_draft", { mode: "poll_draft", topic: "Shift meeting" }, "A staff role is required to draft a poll."],
    ["message_briefing", { mode: "message_briefing", sourceKind: "private", targetId }, "A staff role is required to brief a message thread."],
  ])("keeps the %s staff refusal on the existing 403 copy and never builds the snapshot", async (_mode, body, copy) => {
    const fetchMock = sequence([res({ id: "member-user" }), res({ code: "42501", message: "not authorized" }, 403)]);
    const result = await run(body);
    expect(result).toEqual({ status: 403, body: { error: copy } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("get_staff_engagement_snapshot"))).toBe(false);
  });

  it.each([
    ["poll_draft", { mode: "poll_draft", topic: "Shift meeting" }],
    ["message_briefing", { mode: "message_briefing", sourceKind: "private", targetId }],
  ])("reports a %s staff-gate timeout or 5xx as unavailability, not a missing role", async (_mode, body) => {
    for (const failure of ["timeout", "5xx"]) {
      const fetchMock = vi.fn().mockResolvedValueOnce(res({ id: "staff-user" }));
      if (failure === "timeout") fetchMock.mockRejectedValueOnce(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
      else fetchMock.mockResolvedValueOnce(res({ message: "upstream unavailable" }, 503));
      vi.stubGlobal("fetch", fetchMock);
      const result = await run(body);
      expect(result.status, failure).toBe(503);
      expect(result.body, failure).toEqual({ code: "governance_unavailable", error: "Union Ground Guide is unavailable right now." });
      expect(JSON.stringify(result.body)).not.toContain("staff role");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it.each(["poll_draft", "message_briefing"])("rejects unverified %s model/routing before parsing or persistence", async (mode) => {
    for (const variant of ["missing-model", "different-model", "malformed-model", "other-family-model", "lookalike-model"]) {
      const generated = "Synthetic generated content must not be consumed.";
      const gateway = completion(generated);
      const value = await gateway.json();
      if (variant === "missing-model") delete value.model;
      if (variant === "different-model") value.model = "untrusted/returned-model";
      if (variant === "malformed-model") value.model = [CONNECTOR_MODEL];
      if (variant === "other-family-model") value.model = "gpt-5";
      if (variant === "lookalike-model") value.model = `${CONNECTOR_MODEL}-lite`;
      const readContent = vi.fn(() => generated);
      Object.defineProperty(value.choices[0].message, "content", { get: readContent });
      gateway.json = async () => value;
      const prelude = [res({ id: "staff-user" }), res(true)];
      if (mode === "message_briefing") prelude.push(res({ sourceKind: "private", targetId, messages: [{ actor: "member", body: "Can we meet Thursday?" }] }));
      const fetchMock = sequence([...prelude, res(CONNECTOR_PROVIDER), res({ id: reservationId }), res(DISPATCH), gateway, res({})]);
      const body = mode === "poll_draft" ? { mode, topic: "Draft a poll" } : { mode, sourceKind: "private", targetId };

      const result = await run(body);

      expect(result.status, variant).toBe(502);
      expect(result.body.code, variant).toBe("gateway_unavailable");
      expect(result.body).not.toHaveProperty("draft");
      expect(result.body).not.toHaveProperty("briefing");
      expect(readContent, variant).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.filter(([url]) => url.includes("release_member_ai_request")), variant).toHaveLength(1);
      expect(fetchMock.mock.calls.some(([url]) => url.includes("persist_compass_message_briefing")), variant).toBe(false);
      expect(JSON.stringify(result.body)).not.toContain(generated);
      expect(JSON.stringify(result.body)).not.toContain("untrusted/returned-model");
    }
  });

  it.each(["poll_draft", "message_briefing"])("refuses a platform-resolved mesh for %s as unconfigured before any reservation or provider call", async (mode) => {
    const prelude = [res({ id: "staff-user" }), res(true)];
    if (mode === "message_briefing") prelude.push(res({ sourceKind: "private", targetId, messages: [{ actor: "member", body: "Can we meet Thursday?" }] }));
    const fetchMock = sequence([...prelude, res(MESH_PROVIDER)]);
    const body = mode === "poll_draft" ? { mode, topic: "Draft a poll" } : { mode, sourceKind: "private", targetId };

    const result = await run(body);

    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: "Union Ground Guide is not configured." });
    expect(fetchMock.mock.calls.some(([url]) => /reserve_compass_ai_request|authorize_compass_ai_dispatch|release_member_ai_request|persist_compass_message_briefing/.test(url))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => url === CONNECTOR_URL || String(url).includes("mesh"))).toBe(false);
  });

  it("retains the reservation for every invalid structured result", async () => {
    const cases = [
      {
        body: { mode: "poll_draft", topic: "Draft a poll" },
        calls: [res({ id: "staff-user" }), res(true), res(CONNECTOR_PROVIDER), res({ id: reservationId }), res(DISPATCH), completion("not-json")],
      },
      {
        body: { mode: "poll_draft", topic: "Draft a poll" },
        calls: [res({ id: "staff-user" }), res(true), res(CONNECTOR_PROVIDER), res({ id: reservationId }), res(DISPATCH), completion(JSON.stringify({ title: "Incomplete", options: [] }))],
      },
      {
        body: { mode: "message_briefing", sourceKind: "private", targetId },
        calls: [res({ id: "staff-user" }), res(true), res({ sourceKind: "private", targetId, messages: [{ actor: "member", body: "Can we meet Thursday?" }] }), res(CONNECTOR_PROVIDER), res({ id: reservationId }), res(DISPATCH), completion(JSON.stringify({ summary: "" }))],
      },
    ];
    for (const entry of cases) {
      const fetchMock = sequence(entry.calls);
      const result = await run(entry.body);
      expect(result).toMatchObject({ status: 502, body: { code: "invalid_ai_result", error: "Union Ground Guide returned an invalid draft. Try again." } });
      expect(fetchMock.mock.calls.some(([url]) => url.includes("reserve_compass_ai_request"))).toBe(true);
      expect(fetchMock.mock.calls.some(([url]) => url.includes("release_member_ai_request"))).toBe(false);
    }
  });

  it.each(["poll_draft", "message_briefing"])("releases a %s reservation when the provider never returns a generation", async (mode) => {
    const prelude = [res({ id: "staff-user" }), res(true)];
    if (mode === "message_briefing") {
      prelude.push(res({ sourceKind: "private", targetId, messages: [{ actor: "member", body: "Can we meet Thursday?" }] }));
    }
    const fetchMock = sequence([...prelude, res(CONNECTOR_PROVIDER), res({ id: reservationId }), res(DISPATCH), res({ error: "upstream" }, 500), res({})]);
    const body = mode === "poll_draft" ? { mode, topic: "Draft a poll" } : { mode, sourceKind: "private", targetId };

    const result = await run(body);

    expect(result).toMatchObject({ status: 502, body: { code: "gateway_unavailable" } });
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("reserve_compass_ai_request"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("release_member_ai_request"))).toHaveLength(1);
  });

  it("consumes one reservation for each invalid structured result and returns no capacity", async () => {
    let reserved = 0;
    let released = 0;
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const target = String(url);
      if (target.endsWith("/auth/v1/user")) return res({ id: "staff-user" });
      if (target.endsWith("authorize_engagement_staff")) return res(true);
      if (target.endsWith("resolve_compass_ai_provider")) return res(CONNECTOR_PROVIDER);
      if (target.endsWith("reserve_compass_ai_request")) {
        reserved += 1;
        if (reserved > 2) return res({ cause: "role" });
        return res({ id: reservationId, cause: null });
      }
      if (target.endsWith("authorize_compass_ai_dispatch")) return res(DISPATCH);
      if (target === CONNECTOR_URL) return completion("not-json");
      if (target.endsWith("release_member_ai_request")) {
        released += 1;
        return res(true);
      }
      throw new Error(`unexpected URL ${url}`);
    }));

    const first = await run({ mode: "poll_draft", topic: "Draft a poll" });
    const second = await run({ mode: "poll_draft", topic: "Draft a poll" });
    const third = await run({ mode: "poll_draft", topic: "Draft a poll" });

    expect(first).toMatchObject({ status: 502, body: { code: "invalid_ai_result" } });
    expect(second).toMatchObject({ status: 502, body: { code: "invalid_ai_result" } });
    expect(third).toMatchObject({ status: 429, body: { code: "role_rate_limit" } });
    expect(reserved).toBe(3);
    expect(released).toBe(0);
  });
});
