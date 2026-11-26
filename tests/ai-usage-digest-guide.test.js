// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/guide.js";
import { SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";
import { buildUsageDigestMessages } from "../api/_lib/compassPrompts.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

const ORG = "00000000-0000-4000-8000-0000000000a1";
const OTHER_ORG = "00000000-0000-4000-8000-0000000000b2";
const DIGEST = "00000000-0000-4000-8000-0000000000d1";
const REQUEST = "00000000-0000-4000-8000-000000000001";
// Union Ground operates no AI mesh (MESH_ENDPOINTS is empty and the Guide's
// mesh access is always unconfigured), so wording can only come from a governed
// connector provider. The connector path is the one this suite drives; the
// mesh refusal itself is pinned by the first test below.
const MODEL = "accounts/fireworks/models/gpt-oss-120b";
const CONNECTOR_URL = "https://api.fireworks.ai/inference/v1/chat/completions";
const PROVIDER = { gateway: "ai_connector_fireworks", model: MODEL, api_key: "fw_test-key-value-0123456789" };
const DISPATCH = { organization_id: ORG, authorized: true, cause: null, evidence_ref: null };
const SUMMARY = { summary: "App use increased across the published periods.", highlights: ["Home remained the busiest area"], caution: null };
const bucket = () => ({
  start: "2026-09-28", end: "2026-10-04", suppressed: false, minCohort: 25, actors: 30, checkins: 25,
});
const payload = () => ({
  organizationId: ORG, digestId: DIGEST, period: "weekly", windowStart: "2026-09-07", windowEnd: "2026-10-04",
  buckets: [bucket()], deltas: [{ metric: "actors", current: 30, previous: 25, direction: "up" }],
});

function response(value, status = 200, headers = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => value, text: async () => JSON.stringify(value), headers: { get: name => headers[name.toLowerCase()] ?? null } };
}
function completion(content = JSON.stringify(SUMMARY)) {
  return response({ model: MODEL, usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
}
function install(overrides = {}) {
  const routes = {
    user: response({ id: "staff-user" }),
    authorize_analytics_usage_digest_ai: response(payload()),
    resolve_compass_ai_provider: response(PROVIDER),
    reserve_compass_ai_request: response({ id: REQUEST, cause: null }),
    authorize_compass_ai_dispatch: response(DISPATCH),
    model: completion(),
    save_analytics_usage_digest_ai: response({ id: DIGEST, ai: { status: "enriched" } }),
    ...overrides,
  };
  const fetcher = vi.fn(async url => {
    const text = String(url);
    const key = text === CONNECTOR_URL ? "model" : text.split("/").pop();
    if (Object.hasOwn(routes, key)) return routes[key];
    if (/\/(?:complete|release|record)_/.test(text)) return response(true);
    throw new Error(`Unexpected test request: ${text}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
async function run(body = {}) {
  const result = { statusCode: 0, body: "", status(code) { this.statusCode = code; return this; }, setHeader() {}, end(value) { this.body = value; } };
  await handler({ method: "POST", headers: { authorization: "Bearer staff-token" }, body: { mode: "usage_digest", hat: "admin", digestId: DIGEST, ...body } }, result);
  return { status: result.statusCode, body: JSON.parse(result.body) };
}
const called = (fetcher, endpoint) => fetcher.mock.calls.filter(([url]) => String(url).includes(endpoint));

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_ORIGIN);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", SUPABASE_REF);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("usage digest governed wording", () => {
  it("refuses as unconfigured when the platform resolves the mesh, which Union Ground does not operate", async () => {
    const fetcher = install({ resolve_compass_ai_provider: response({ gateway: "union-ground-mesh", model: "union-ground/compass-mesh:v1" }) });
    expect(await run()).toMatchObject({ status: 503, body: { error: "Union Ground Guide is not configured." } });
    expect(called(fetcher, "reserve_compass_ai_request")).toHaveLength(0);
    expect(called(fetcher, "authorize_compass_ai_dispatch")).toHaveLength(0);
    expect(called(fetcher, "save_analytics_usage_digest_ai")).toHaveLength(0);
    expect(fetcher.mock.calls.every(([url]) => !/mesh/.test(String(url)))).toBe(true);
  });

  it("authorizes, reserves, dispatches and persists trimmed wording without sending tenant identifiers to the model", async () => {
    const answer = { ...SUMMARY, summary: ` ${SUMMARY.summary} `, highlights: [" Home remained busiest "], caution: " Compare only published periods " };
    const fetcher = install({ model: completion(JSON.stringify(answer)) });
    const result = await run({ hat: "steward" });
    expect(result).toMatchObject({ status: 200, body: { digest: { id: DIGEST, ai: { status: "enriched" } } } });
    expect(JSON.parse(called(fetcher, "authorize_analytics_usage_digest_ai")[0][1].body)).toEqual({ p_selected_hat: "steward", p_digest_id: DIGEST });
    expect(called(fetcher, "reserve_compass_ai_request")).toHaveLength(1);
    expect(called(fetcher, "authorize_compass_ai_dispatch")).toHaveLength(1);
    expect(called(fetcher, "fireworks.ai")[0][1].body).not.toContain(ORG);
    const save = called(fetcher, "save_analytics_usage_digest_ai")[0];
    expect(save[1].headers.Authorization ?? save[1].headers.authorization).toContain("staff-token");
    expect(JSON.parse(save[1].body)).toEqual({ p_selected_hat: "steward", p_digest_id: DIGEST, p_summary: SUMMARY.summary, p_highlights: ["Home remained busiest"], p_caution: "Compare only published periods", p_model: MODEL });
  });

  it.each([{ hat: "member" }, { digestId: "invalid" }, { hat: "" }, { digestId: null }])("rejects invalid selection before authorization: %j", async body => {
    const fetcher = install();
    expect((await run(body)).status).toBe(400);
    expect(called(fetcher, "authorize_analytics_usage_digest_ai")).toHaveLength(0);
  });

  it.each([["P0002", 404], ["22023", 409], ["42501", 403], ["55000", 503], ["XX000", 503]])("honors database refusal %s before reserving", async (code, status) => {
    const fetcher = install({ authorize_analytics_usage_digest_ai: response({ code, message: "refused" }, 400) });
    expect((await run()).status).toBe(status);
    expect(called(fetcher, "reserve_compass_ai_request")).toHaveLength(0);
    expect(called(fetcher, "fireworks.ai")).toHaveLength(0);
  });

  it.each([null, {}, { organizationId: "invalid" }])("fails closed on an unbound database payload: %j", async data => {
    const fetcher = install({ authorize_analytics_usage_digest_ai: response(data) });
    expect((await run())).toMatchObject({ status: 503, body: { code: "governance_unavailable" } });
    expect(called(fetcher, "reserve_compass_ai_request")).toHaveLength(0);
  });

  it("refuses malformed aggregate facts before contacting a provider", async () => {
    const fetcher = install({ authorize_analytics_usage_digest_ai: response({ ...payload(), period: "daily" }) });
    expect(await run()).toMatchObject({ status: 503, body: { code: "compass_privacy_unavailable" } });
    expect(called(fetcher, "reserve_compass_ai_request")).toHaveLength(0);
  });

  it("handles provider resolution failure before dispatch", async () => {
    const fetcher = install({ resolve_compass_ai_provider: response({ code: "XX000", message: "unavailable" }, 500) });
    expect((await run())).toMatchObject({ status: 503, body: { code: "governance_unavailable" } });
    expect(called(fetcher, "fireworks.ai")).toHaveLength(0);
  });

  it.each([["shared", 429, "shared_rate_limit"], ["role", 429, "role_rate_limit"], ["disabled", 503, "compass_paused"], [null, 503, "governance_unavailable"]])("honors quota refusal %s", async (cause, status, code) => {
    const fetcher = install({ reserve_compass_ai_request: response({ id: null, cause }) });
    expect(await run()).toMatchObject({ status, body: { code } });
    expect(called(fetcher, "fireworks.ai")).toHaveLength(0);
  });

  it.each([["disabled", 503, "compass_paused"], ["refused", 502, "gateway_unavailable"]])("honors dispatch refusal %s without storing wording", async (cause, status, code) => {
    const fetcher = install({ authorize_compass_ai_dispatch: response({ ...DISPATCH, authorized: false, cause }) });
    expect(await run()).toMatchObject({ status, body: { code } });
    expect(called(fetcher, "fireworks.ai")).toHaveLength(0);
    expect(called(fetcher, "save_analytics_usage_digest_ai")).toHaveLength(0);
  });

  it("refuses dispatch bound to another organization", async () => {
    const fetcher = install({ authorize_compass_ai_dispatch: response({ ...DISPATCH, organization_id: OTHER_ORG }) });
    expect((await run()).status).toBe(502);
    expect(called(fetcher, "fireworks.ai")).toHaveLength(0);
  });

  it.each([
    "not json", JSON.stringify({ ...SUMMARY, summary: "short" }),
    JSON.stringify({ ...SUMMARY, highlights: ["x"] }), JSON.stringify({ ...SUMMARY, caution: "x" }),
    JSON.stringify({ ...SUMMARY, unexpected: "field" }),
  ])("rejects invalid completed wording without saving or refunding: %s", async content => {
    const fetcher = install({ model: completion(content) });
    expect(await run()).toMatchObject({ status: 502, body: { code: "invalid_ai_result" } });
    expect(called(fetcher, "save_analytics_usage_digest_ai")).toHaveLength(0);
    expect(called(fetcher, "release_compass_ai_request")).toHaveLength(0);
  });

  it("persists a null caution and reports a persistence failure honestly", async () => {
    const fetcher = install({ save_analytics_usage_digest_ai: response({ code: "XX000", message: "unavailable" }, 500) });
    expect(await run()).toMatchObject({ status: 503, body: { code: "persistence_unavailable" } });
    expect(JSON.parse(called(fetcher, "save_analytics_usage_digest_ai")[0][1].body).p_caution).toBeNull();
  });
});

describe("usage digest prompt minimization", () => {
  it("keeps only aggregate facts and preserves withheld figures as null", () => {
    const data = payload();
    data.buckets.push({ ...bucket(), suppressed: true, actors: null, checkins: null });
    data.note = "Never forward this extra field";
    const messages = buildUsageDigestMessages(data);
    expect(messages[0].content).toContain("Return JSON only");
    expect(messages[1].content).not.toContain(ORG);
    expect(messages[1].content).not.toContain(data.note);
    const text = messages[1].content.match(/<untrusted_aggregate_payload>\n([\s\S]*?)\n<\/untrusted_aggregate_payload>/)[1];
    const facts = JSON.parse(text);
    expect(facts.buckets[0]).toEqual({ start: "2026-09-28", end: "2026-10-04", suppressed: false, actors: 30, checkins: 25 });
    expect(facts.buckets[1]).toMatchObject({ suppressed: true, actors: null, checkins: null });
    expect(facts.deltas).toEqual(data.deltas);
    expect(Object.keys(facts).sort()).toEqual(["buckets", "deltas", "period", "windowEnd", "windowStart"]);
  });

  it.each([
    null, [], {}, { period: "daily" }, { buckets: [] }, { buckets: Array(5).fill(bucket()) },
    { deltas: null }, { deltas: Array(3).fill({}) }, { windowStart: 123 }, { windowEnd: "next week" },
    { buckets: [null] }, { buckets: [[]] }, { buckets: [{ ...bucket(), extra: "person" }] },
    { buckets: [{ ...bucket(), suppressed: "yes" }] }, { buckets: [{ ...bucket(), actors: -1 }] },
    { buckets: [{ ...bucket(), actors: 1.5 }] }, { buckets: [{ ...bucket(), checkins: 100_000_001 }] },
    // View totals, sections and role rows left the digest (round-1 privacy
    // repair); a payload still carrying one is refused, not forwarded.
    { buckets: [{ ...bucket(), views: 170 }] }, { buckets: [{ ...bucket(), topSections: [] }] },
    { buckets: [{ ...bucket(), byHat: [] }] }, { buckets: [{ ...bucket(), suppressedSections: 0 }] },
    { deltas: [null] }, { deltas: [[]] }, { deltas: [{ metric: "actors", current: 25, previous: 30 }] },
    { deltas: [{ metric: "views", current: 170, previous: 150, direction: "up" }] },
    { deltas: [{ metric: "people", current: 25, previous: 30, direction: "up" }] },
    { deltas: [{ metric: "actors", current: 25, previous: 30, direction: "sideways" }] },
  ])("refuses malformed or identifying aggregate input %j", change => {
    const data = change === null || Array.isArray(change) ? change : { ...payload(), ...change };
    // An empty override remains a valid payload; exercise a truly empty object.
    expect(() => buildUsageDigestMessages(change && Object.keys(change).length === 0 ? {} : data)).toThrow();
  });
});
