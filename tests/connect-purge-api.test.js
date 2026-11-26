// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/connect-purge.js";
import { DENIED_PRODUCTION_REF, deniedSupabaseOrigin } from "./helpers/denied-identity-fixtures.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://unionground.supabase.co"));

const cronSecret = ["cron", "fixture", "long", "enough", "connect", "purge"].join("-");
const opaqueServiceKey = ["sb", "secret", "unionground", "fixture", "value"].join("_");

function responseRecorder() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body; },
  };
}

function rpcResponse(payload) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  };
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", cronSecret);
  vi.stubEnv("VITE_SUPABASE_URL", "https://unionground.supabase.co");
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "unionground");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", opaqueServiceKey);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("connect retention purge API", () => {
  it("runs the service-only purge with an opaque secret key and returns exact counts", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(rpcResponse({
      requestsDeleted: 3,
      bucketsDeleted: 7,
    }));
    const response = responseRecorder();
    await handler({
      method: "GET",
      headers: { authorization: `Bearer ${cronSecret}` },
    }, response);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      requestsDeleted: 3,
      bucketsDeleted: 7,
    });
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toContain("/rpc/purge_expired_unionground_connect_requests");
    expect(options.headers.apikey).toBe(opaqueServiceKey);
    expect(options.headers).not.toHaveProperty("Authorization");
  });

  it("rejects wrong methods and missing or wrong cron authorization", async () => {
    global.fetch = vi.fn();
    for (const request of [
      { method: "POST", headers: {} },
      { method: "GET", headers: {} },
      { method: "GET", headers: { authorization: "Bearer wrong-secret" } },
    ]) {
      const response = responseRecorder();
      await handler(request, response);
      expect([401, 405]).toContain(response.statusCode);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fails closed for invalid provider config, failed RPCs, and malformed receipts", async () => {
    global.fetch = vi.fn();
    vi.stubEnv("VITE_SUPABASE_URL", deniedSupabaseOrigin(DENIED_PRODUCTION_REF));
    vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", DENIED_PRODUCTION_REF);
    const provider = responseRecorder();
    await handler({
      method: "GET",
      headers: { authorization: `Bearer ${cronSecret}` },
    }, provider);
    expect(provider.statusCode).toBe(503);

    vi.stubEnv("VITE_SUPABASE_URL", "https://unionground.supabase.co");
    vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "unionground");
    global.fetch = vi.fn().mockResolvedValueOnce(rpcResponse({ requestsDeleted: "3" }));
    const malformed = responseRecorder();
    await handler({
      method: "GET",
      headers: { authorization: `Bearer ${cronSecret}` },
    }, malformed);
    expect(malformed.statusCode).toBe(503);
  });
});
