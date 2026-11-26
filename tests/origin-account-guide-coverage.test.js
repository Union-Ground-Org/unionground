// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import lifecycle from "../api/account-lifecycle.js";
import reissue from "../api/admin-password-reissue.js";
import recovery from "../api/admin-signin-recovery.js";
import calendar from "../api/calendar-sync.js";
import guide from "../api/guide.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

const userId = "00000000-0000-4000-8000-000000000011";
const requestId = "00000000-0000-4000-8000-000000000012";
const originHeaders = { host: PORTAL_HOST, origin: PORTAL_ORIGIN };
function upstream(body, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body };
}
async function run(handler, body = {}, { headers = { authorization: "Bearer caller-0123456789abcdef0123456789" }, method = "POST" } = {}) {
  const response = { code: 0, body: "", status(code) { this.code = code; return this; }, setHeader() { return this; }, end(body) { this.body = body; } };
  await handler({ method, headers, body }, response);
  return { status: response.code, body: JSON.parse(response.body) };
}
beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_ORIGIN);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", SUPABASE_REF);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "test-public");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service");
  vi.stubEnv("RESEND_API_KEY", "test-resend");
  vi.stubEnv("NOTIFY_FROM_ADDRESS", "test@example.com");
  vi.stubEnv("MESH_AI_API_KEY", "test-mesh-key");
  vi.stubEnv("MESH_AI_ACCESS_CLIENT_ID", "test-mesh-access-id");
  vi.stubEnv("MESH_AI_ACCESS_CLIENT_SECRET", "test-mesh-access-secret");
  vi.stubEnv("CRON_SECRET", "caller-0123456789abcdef0123456789");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("authentication and configuration after a trusted Origin", () => {
  it.each([lifecycle, reissue, recovery, calendar, guide])("%s still requires caller authentication", async (handler) => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect((await run(handler, {}, { headers: originHeaders })).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([reissue, recovery, calendar, guide])("%s rejects unsupported methods and missing configuration without egress", async (handler) => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect((await run(handler, {}, { method: "OPTIONS" })).status).toBe(405);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect((await run(handler)).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([lifecycle, reissue, recovery])("%s rejects malformed serialized bodies", async (handler) => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect((await run(handler, "not-json")).status).toBe(400);
    expect((await run(handler, "null")).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("account lifecycle failure boundaries", () => {
  it("does not delete when the claim RPC fails after valid authorization", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(upstream({ requestId, userId, deletionToken: "a".repeat(64) })).mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetcher);
    expect(await run(lifecycle, JSON.stringify({ confirmation: "DELETE MY ACCOUNT" }))).toEqual({ status: 502, body: { error: "account-lifecycle-unavailable" } });
    expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(["POST", "POST"]);
  });
  it("reports a completed deletion with an unavailable audit without repeating the deletion", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(upstream({ requestId, userId, deletionToken: "a".repeat(64) }))
      .mockResolvedValueOnce(upstream({ claimed: true })).mockResolvedValueOnce(upstream({})).mockRejectedValueOnce(new Error("audit unavailable"));
    vi.stubGlobal("fetch", fetcher);
    expect(await run(lifecycle, { confirmation: "DELETE MY ACCOUNT" })).toEqual({ status: 200, body: { deleted: true, audited: false } });
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "DELETE")).toHaveLength(1);
  });
});

describe("recovery authorization refusal mapping", () => {
  it.each([[reissue, 401, 403], [reissue, 409, 409], [recovery, 400, 409], [recovery, 409, 409], [recovery, 422, 409], [recovery, 500, 503]])("%s maps an upstream %s to %s before provider mutation", async (handler, status, expected) => {
    const fetcher = vi.fn().mockResolvedValue(upstream({ error: "refused" }, status)); vi.stubGlobal("fetch", fetcher);
    expect((await run(handler, { userId, identityVerified: true, newEmail: "new@example.com", reason: "lost_inbox" })).status).toBe(expected);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toContain("/rest/v1/rpc/begin_member_");
  });
});

describe("Compass structured reservation failures", () => {
  // Union Ground has no AI mesh (MESH_ENDPOINTS is empty), so a platform
  // resolution that selects the mesh refuses as mesh_unconfigured BEFORE any
  // reservation is attempted: whatever cause a reservation would have returned,
  // the answer is the same fail-closed "not configured" and no provider egress.
  it.each(["shared", "role", "disabled", "unknown"])("refuses as unconfigured before any %s reservation or provider egress", async (cause) => {
    const fetcher = vi.fn().mockResolvedValueOnce(upstream({ id: userId })).mockResolvedValueOnce(upstream({ surveys: [] }))
      .mockResolvedValueOnce(upstream({ gateway: "union-ground-mesh", model: "union-ground/compass-mesh:v1" }))
      .mockResolvedValueOnce(upstream({ cause })); vi.stubGlobal("fetch", fetcher);
    const result = await run(guide, { mode: "poll_draft", topic: "Meeting time" });
    expect(result.status).toBe(503); expect(result.body).toEqual({ error: "Union Ground Guide is not configured." });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${SUPABASE_ORIGIN}/`))).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/rpc/reserve_compass_ai_request"))).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("fails closed on invalid thread identifiers before any thread lookup", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(upstream({ id: userId })); vi.stubGlobal("fetch", fetcher);
    expect((await run(guide, { mode: "message_briefing", sourceKind: "private", targetId: "bad" })).status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
