// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import handler from "../api/engagement-delivery.js";
import { vercelCronTickHeaders } from "./helpers/vercelCronTick.js";
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("ends an empty documented Vercel cron tick (no x-vercel-cron marker) after one claim without reading payloads or contacting the provider", async () => {
  for (const [key, value] of Object.entries({
    CRON_SECRET: "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx", VITE_SUPABASE_URL: "https://project.supabase.co", UNIONGROUND_SUPABASE_PROJECT_REF: "project",
    VITE_SUPABASE_PUBLISHABLE_KEY: "test-publishable", SUPABASE_SERVICE_ROLE_KEY: "test-service",
    ENGAGEMENT_EMAIL_WEBHOOK_URL: "https://mail.example.test/send", ENGAGEMENT_EMAIL_WEBHOOK_TOKEN: "test-provider",
  })) vi.stubEnv(key, value);
  const fetchMock = vi.fn(async (raw) => {
    expect(String(raw)).toBe("https://project.supabase.co/rest/v1/rpc/claim_engagement_delivery_batch");
    return { ok: true, status: 200, text: async () => "[]" };
  });
  vi.stubGlobal("fetch", fetchMock);
  const result = {};
  await handler({ method: "GET", headers: { host: "app.unionground.test", ...vercelCronTickHeaders("cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx", "*/15 * * * *") } }, {
    status(code) { result.status = code; return this; },
    setHeader() {},
    end(body) { result.body = JSON.parse(body); },
  });
  expect(result).toEqual({ status: 200, body: { claimed: 0, sent: 0, failed: 0, suppressed: 0 } });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ p_limit: 1, p_lease_seconds: 240, p_lease_token: expect.any(String) });
});
