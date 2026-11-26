// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import handler, { buildAutomationDraftMessages } from "../api/guide.js";
import { buildCompassGatewayRequest } from "../api/_lib/compassAiGovernance.js";
import { requestAutomationDraft } from "../src/lib/automationCompassApi.js";
import { SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

const RESERVATION_ID = "00000000-0000-4000-8000-000000000001";
const UUID = "50900000-0000-4000-8000-000000000109";
// Union Ground operates no AI mesh (MESH_ENDPOINTS is empty and the Guide's
// mesh access is always unconfigured), so a draft can only come from a governed
// connector provider. The connector path is the one this suite drives.
const MODEL = "accounts/fireworks/models/gpt-oss-120b";
const CONNECTOR_URL = "https://api.fireworks.ai/inference/v1/chat/completions";
const PROVIDER = { gateway: "ai_connector_fireworks", model: MODEL, api_key: "fw_test-key-value-0123456789" };
const DISPATCH = { authorized: true, evidence_ref: null };
const CONNECTOR_ACCESS = {
  surface: "saas",
  endpoint: "",
  credentials: {},
  provider: {
    gateway: PROVIDER.gateway,
    model: MODEL,
    connector: { vendor: "fireworks", endpoint: CONNECTOR_URL, shape: "chat_completions", apiKey: PROVIDER.api_key },
  },
};

const capabilities = Object.freeze({
  schemaVersion: 2,
  triggers: Object.freeze(["overdue_task", "task_due"]),
  actions: Object.freeze(["create_standard_task", "notify_in_app"]),
  cadences: Object.freeze(["hourly", "daily", "weekly"]),
  maxThresholdDays: 90,
});
const opportunities = Object.freeze([{
  triggerKind: "overdue_task",
  candidateCount: 4,
  thresholdDays: 3,
  scope: "organization",
  covered: false,
}]);

function validEnvelope(patch = {}) {
  return {
    schemaVersion: 1,
    capabilityVersion: 2,
    proposal: {
      name: "Notify someone about overdue work",
      triggerKind: "overdue_task",
      thresholdDays: 3,
      cadence: "daily",
      taskPriority: "medium",
      conditions: { status: "in_progress" },
      actionKind: "notify_in_app",
      actionConfig: {},
    },
    needsInput: [{ field: "actionConfig.recipientId", reason: "Choose a recipient in the builder" }],
    explanation: "This is an editable draft for overdue in-progress tasks.",
    assumptions: ["A daily review is frequent enough."],
    warnings: ["Nothing runs until an approver activates it."],
    ...patch,
  };
}

function recorder() {
  return {
    statusCode: 0,
    body: "",
    status(code) { this.statusCode = code; return this; },
    setHeader() {},
    end(value) { this.body = value; },
  };
}

function response(value, status = 200, headers = {}) {
  const text = JSON.stringify(value);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => value,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
  };
}

function completion(content) {
  return response({
    model: MODEL,
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  });
}

function sequence(items) {
  const fetchMock = vi.fn();
  for (const item of items) fetchMock.mockResolvedValueOnce(item);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function body(patch = {}) {
  return {
    mode: "automation_draft",
    intent: "Notify about overdue tasks daily.",
    capabilityVersion: 2,
    triggers: [...capabilities.triggers],
    actions: [...capabilities.actions],
    opportunities: structuredClone(opportunities),
    locale: "en",
    ...patch,
  };
}

async function run(requestBody) {
  const target = recorder();
  await handler({ method: "POST", headers: { authorization: "Bearer staff-token" }, body: requestBody }, target);
  return { status: target.statusCode, body: JSON.parse(target.body) };
}

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_ORIGIN);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", SUPABASE_REF);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("automation Compass prompt boundary", () => {
  it("seals only minimized intent, capability identifiers, aggregate opportunities, and locale", () => {
    const messages = buildAutomationDraftMessages({
      intent: "Notify about overdue tasks daily.",
      capabilityVersion: 2,
      triggers: [...capabilities.triggers],
      actions: [...capabilities.actions],
      opportunities: structuredClone(opportunities),
      locale: "en",
    });
    const gateway = JSON.parse(buildCompassGatewayRequest(messages, CONNECTOR_ACCESS).options.body);
    const outbound = JSON.parse(gateway.messages[1].content);

    expect(outbound).toEqual({
      intent: "Notify about overdue tasks daily.",
      capabilityVersion: 2,
      triggers: ["overdue_task", "task_due"],
      actions: ["create_standard_task", "notify_in_app"],
      opportunities: [{ triggerKind: "overdue_task", candidateCount: 4, thresholdDays: 3, scope: "organization", covered: false }],
      locale: "en",
    });
    expect(gateway.messages[0].content).toContain("JSON only");
    expect(gateway.messages[0].content).toContain("never execute");
  });

  it.each([
    { opportunities: [{ ...opportunities[0], sourceId: UUID }] },
    { opportunities: [{ ...opportunities[0], names: ["Private Person"] }] },
    { opportunities: [{ ...opportunities[0], description: "Private case description" }] },
    { opportunities: [{ ...opportunities[0], notes: "Private note" }] },
    { opportunities: [{ ...opportunities[0], messages: ["Private message"] }] },
    { opportunities: [{ ...opportunities[0], title: "Private title" }] },
    { opportunities: [{ ...opportunities[0], nested: { candidateCount: 4 } }] },
  ])("fails privacy validation before reservation or provider egress for %j", async (patch) => {
    const fetchMock = sequence([response({ id: "staff-user" })]);
    const result = await run(body(patch));
    expect(result).toMatchObject({ status: 503, body: { code: "compass_privacy_unavailable" } });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("reserve_compass_ai_request"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("fireworks.ai"))).toBe(false);
  });
});

describe("automation Compass handler", () => {
  it("authorizes staff before reservation and returns a validated inert proposal", async () => {
    const fetchMock = sequence([
      response({ id: "staff-user" }),
      response({ authorized: true, organizationId: UUID }),
      response(PROVIDER),
      response({ id: RESERVATION_ID }),
      response(DISPATCH),
      completion(JSON.stringify(validEnvelope())),
    ]);

    const result = await run(body());

    expect(result.status).toBe(200);
    expect(result.body.proposal).toEqual(validEnvelope());
    expect(fetchMock.mock.calls[1][0]).toContain("mi1_get_automation_ai_authorization");
    expect(fetchMock.mock.calls[2][0]).toContain("resolve_compass_ai_provider");
    expect(fetchMock.mock.calls[3][0]).toContain("reserve_compass_ai_request");
    expect(fetchMock.mock.calls[4][0]).toContain("authorize_compass_ai_dispatch");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("save_automation"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("execute_automation"))).toBe(false);
  });

  it("refuses as unconfigured, before reserving or dispatching, when the platform resolves the mesh Union Ground does not operate", async () => {
    const fetchMock = sequence([
      response({ id: "staff-user" }),
      response({ authorized: true, organizationId: UUID }),
      response({ gateway: "union-ground-mesh", model: "union-ground/compass-mesh:v1" }),
    ]);

    const result = await run(body());

    expect(result).toMatchObject({ status: 503, body: { error: "Union Ground Guide is not configured." } });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("reserve_compass_ai_request"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("authorize_compass_ai_dispatch"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => /mesh|fireworks\.ai/.test(String(url)))).toBe(false);
  });

  it.each([
    { authorized: false },
    { authorized: false, cause: "mfa_required" },
    { cause: "mfa_required" },
    {},
  ])("returns unauthorized for automation_draft authorization %j and never mfa_required", async (authorization) => {
    sequence([
      response({ id: "staff-user" }),
      response(authorization),
    ]);
    const result = await run(body());
    expect(result).toMatchObject({
      status: 403,
      body: { code: "unauthorized", error: "An active staff role is required to draft an automation." },
    });
    expect(result.body.code).not.toBe("mfa_required");
    expect(JSON.stringify(result.body)).not.toMatch(/mfa_required/);
  });

  it.each([
    ["extra key", validEnvelope({ extra: true })],
    ["unsupported action", validEnvelope({ proposal: { ...validEnvelope().proposal, actionKind: "send_email" } })],
    ["UUID output", validEnvelope({ explanation: `Use ${UUID}` })],
    ["capability mismatch", validEnvelope({ capabilityVersion: 1 })],
    ["seven assumptions", validEnvelope({ assumptions: new Array(7).fill("One assumption") })],
    ["oversized explanation", validEnvelope({ explanation: "x".repeat(601) })],
  ])("retains its reservation for invalid generated output: %s", async (_name, generated) => {
    const fetchMock = sequence([
      response({ id: "staff-user" }),
      response({ authorized: true, organizationId: UUID }),
      response(PROVIDER),
      response({ id: RESERVATION_ID }),
      response(DISPATCH),
      completion(JSON.stringify(generated)),
    ]);

    const result = await run(body());

    expect(result).toMatchObject({ status: 502, body: { code: "invalid_ai_result", error: "Union Ground Guide returned an invalid draft. Try again." } });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("reserve_compass_ai_request"))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("release_member_ai_request"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("save_automation"))).toBe(false);
  });

  it("releases its reservation when the provider never returns a generation", async () => {
    const fetchMock = sequence([
      response({ id: "staff-user" }),
      response({ authorized: true, organizationId: UUID }),
      response(PROVIDER),
      response({ id: RESERVATION_ID }),
      response(DISPATCH),
      response({ error: "upstream" }, 500),
      response(true),
    ]);

    const result = await run(body());

    expect(result).toMatchObject({ status: 502, body: { code: "gateway_unavailable" } });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("reserve_compass_ai_request"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("release_member_ai_request"))).toHaveLength(1);
  });
});

describe("requestAutomationDraft", () => {
  it("rejects missing credentials and malformed capability inputs before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestAutomationDraft({ intent: "Draft work", capabilities, opportunities }))
      .resolves.toEqual({ ok: false, reason: "unauthorized" });
    await expect(requestAutomationDraft({ accessToken: "token", intent: "Draft work", capabilities: null, opportunities }))
      .resolves.toEqual({ ok: false, reason: "invalid_ai_result" });
    await expect(requestAutomationDraft({ accessToken: "token", intent: "Draft work", capabilities, opportunities: new Array(9).fill(opportunities[0]) }))
      .resolves.toEqual({ ok: false, reason: "invalid_ai_result" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts bearer-authenticated minimized inputs and validates the response again", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ proposal: validEnvelope(), meta: { model: MODEL } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestAutomationDraft({
      accessToken: "staff-token",
      intent: "Notify about overdue tasks daily.",
      capabilities,
      opportunities,
      locale: "en",
    });

    expect(result).toMatchObject({ ok: true, proposal: validEnvelope() });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/guide");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer staff-token");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(body());
  });

  it.each([
    [401, { code: "unauthorized" }, "unauthorized"],
    [403, { code: "mfa_required" }, "mfa_required"],
    [503, { code: "governance_unavailable" }, "governance_unavailable"],
    [503, { code: "compass_paused" }, "governance_unavailable"],
    [502, { code: "gateway_unavailable" }, "gateway_unavailable"],
    [502, { code: "invalid_ai_result" }, "invalid_ai_result"],
  ])("maps a %i response to %s", async (status, payload, reason) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(payload, status)));
    await expect(requestAutomationDraft({ accessToken: "token", intent: "Draft work", capabilities, opportunities, locale: "en" }))
      .resolves.toEqual({ ok: false, reason });
  });

  it("maps an aborted request without turning it into a gateway error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" })));
    await expect(requestAutomationDraft({ accessToken: "token", intent: "Draft work", capabilities, opportunities, locale: "en" }))
      .resolves.toEqual({ ok: false, reason: "aborted" });
  });

  it("fails closed for unreadable error bodies and ordinary transport failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: vi.fn().mockRejectedValue(new Error("not json")),
    }));
    await expect(requestAutomationDraft({ accessToken: "token", intent: "Draft work", capabilities, opportunities }))
      .resolves.toEqual({ ok: false, reason: "gateway_unavailable" });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(requestAutomationDraft({ accessToken: "token", intent: "Draft work", capabilities, opportunities }))
      .resolves.toEqual({ ok: false, reason: "gateway_unavailable" });
  });
});
