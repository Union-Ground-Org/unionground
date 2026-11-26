// @vitest-environment node
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { denyDigest } from "../scripts/lib/denied-identity.mjs";
import { cronAuthorization } from "../api/_lib/cronAuth.js";
import {
  deliverClaimedIntegrationWebhook,
  isPublicIntegrationAddress,
  resolvePinnedIntegrationDestination,
} from "../api/_lib/integrationWebhooks.js";

const migration = readFileSync("supabase/migrations/20260826152000_mi1_integration_control_repairs.sql", "utf8");
const tenantDispatcher = readFileSync("api/integration-webhooks.js", "utf8");
const scheduledDispatcher = readFileSync("api/integration-webhooks-dispatch.js", "utf8");
const cronAuthSource = readFileSync("api/_lib/cronAuth.js", "utf8");
const customerApi = readFileSync("api/customer-api.js", "utf8");
// The sibling SaaS host, as its deny-list digest (config/sample-backend.json
// forbiddenAppHostSha256): the dispatch URL check must not pin that host.
const SIBLING_SAAS_HOST_DIGEST = "2208ecc5f728a7ac92f9b47127193d4046833c3519d508901b872731058c0b73";

describe("MI1 persisted integration repair contracts", () => {
  it("keeps migration history append-only and adds exact scoped RPCs", () => {
    expect(migration).toContain("add column if not exists secret_ref uuid");
    expect(migration).toContain("vault.create_secret");
    expect(migration).toContain("join vault.decrypted_secrets");
    expect(migration).toContain("public.list_integration_webhook_deliveries()");
    expect(migration).toContain("public.list_integration_webhook_delivery_page(");
    const compatibilityListStart = migration.indexOf("create or replace function public.list_integration_webhook_deliveries()");
    const compatibilityListEnd = migration.indexOf("$function$;", compatibilityListStart);
    expect(migration.slice(compatibilityListStart, compatibilityListEnd)).toContain("private.mfa_satisfied()");
    expect(migration).toContain("public.enqueue_integration_job(");
    expect(migration).toContain("public.set_integration_chapter_controls(");
    const chapterControlsStart = migration.indexOf("create function public.set_integration_chapter_controls(");
    const chapterControlsEnd = migration.indexOf("$function$;", chapterControlsStart);
    const chapterControlsFunction = migration.slice(chapterControlsStart, chapterControlsEnd);
    expect(chapterControlsFunction).not.toContain("p_credential_ref");
    expect(chapterControlsFunction).not.toContain("p_default_settings");
    expect(chapterControlsFunction).not.toContain("set status =");
    expect(migration).toContain("public.run_next_integration_job()");
    expect(migration).toContain("public.retry_integration_job(p_job_id uuid)");
    expect(migration).toContain("public.enqueue_integration_webhook_test(");
    expect(migration).toContain("recent_test_count >= 10");
    expect(migration).toContain("p_event_id not like 'test:%'");
    expect(migration).toContain("public.claim_integration_webhook_deliveries(p_limit integer default 10)");
    expect(migration).toContain("public.record_integration_webhook_delivery(");
    expect(migration).toContain("public.rotate_integration_api_key(");
    expect(migration).toContain("public.authenticate_integration_api_key(p_key_hash text)");
    expect(migration).toContain("o.status = 'active'");
    expect(migration).toContain("provider = 'customer_api'");
    expect(migration).toContain("public.configure_integration_webhook_dispatch(p_dispatch_url text, p_cron_secret text)");
    expect(migration).toContain("'integration-webhooks-dispatch-secret'");
    const pinnedDispatchHosts = [...migration.matchAll(/'https:\/\/([^'/]+)\/api\/integration-webhooks-dispatch'/g)].map(([, host]) => denyDigest(host));
    expect(pinnedDispatchHosts).not.toContain(SIBLING_SAAS_HOST_DIGEST);
    expect(migration).toContain("to service_role");
    expect(migration).not.toMatch(/authenticate_integration_api_key\(p_organization/i);
  });

  it("enforces chapter opt-in, endpoint idempotency, and atomic provider state", () => {
    expect(migration).toContain("if not overrides_enabled then raise exception 'chapter overrides disabled'");
    expect(migration).toContain("chapter override key is not allowed");
    expect(migration).toContain("c.id = p_chapter_id and c.organization_id = org");
    expect(migration).toContain("(organization_id, webhook_id, idempotency_key)");
    expect(migration).toContain("values (org, 'customer_webhooks', 'configured')");
    expect(migration).toContain("values (org, 'customer_api', 'configured')");
    expect(migration).toContain("between 1 and 80");
    expect(migration).toContain("credential_ref = coalesce(excluded.credential_ref, chapter_integration_overrides.credential_ref)");
  });

  it("keeps dispatcher secrets server-side and exposes a real API-key authenticator", () => {
    expect(tenantDispatcher).toContain("enqueue_integration_webhook_test");
    expect(tenantDispatcher).toContain("claim_integration_webhook_delivery");
    expect(tenantDispatcher).not.toContain('"claim_integration_webhook_deliveries"');
    expect(tenantDispatcher).toContain("record_integration_webhook_delivery");
    expect(tenantDispatcher).not.toContain("p_secret_plaintext");
    expect(scheduledDispatcher).toContain("INTEGRATION_DISPATCH_SECRET");
    expect(scheduledDispatcher).toContain("SAMPLE_INTEGRATION_DISPATCH_SECRET");
    // Both bearers follow the one cron rule: 32 characters, no placeholder.
    expect(scheduledDispatcher).toContain('from "./_lib/cronAuth.js"');
    // As upstream: Vercel's scheduler sends only the CRON_SECRET bearer, so the
    // fallback asks for no x-vercel-cron marker; the secret still has to pass
    // cronAuth's 32-character rule and constant-time compare.
    expect(scheduledDispatcher).toContain("cronAuthorization(request, { secretName: dispatchSecretName })");
    expect(scheduledDispatcher).toContain("const cron = cronAuthorization(request);");
    expect(scheduledDispatcher).not.toContain("requireVercelCronHeader");
    expect(cronAuthSource).toContain("timingSafeEqual(left, right)");
    const secret = "d".repeat(32);
    const tick = (bearer) => ({ headers: { authorization: `Bearer ${bearer}` } });
    expect(cronAuthorization(tick(secret), { env: { CRON_SECRET: secret } })).toEqual({ ok: true });
    expect(cronAuthorization(tick("e".repeat(32)), { env: { CRON_SECRET: secret } }).status).toBe(401);
    expect(cronAuthorization(tick("short"), { env: { CRON_SECRET: "short" } }).status).toBe(503);
    expect(scheduledDispatcher).toContain('"claim_integration_webhook_deliveries"');
    expect(scheduledDispatcher).toContain("record_integration_webhook_delivery");
    expect(migration).toContain("'integration-webhooks-dispatch-tick'");
    expect(migration).toContain("'*/5 * * * *'");
    expect(customerApi).toContain("authenticate_integration_api_key");
    expect(customerApi).toContain("createHash(\"sha256\")");
    expect(customerApi).not.toContain("p_organization_id");
  });

  it("rejects reserved addresses and pins the complete public resolution set", async () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "198.51.100.2", "203.0.113.2", "::1", "fc00::1", "2001:db8::1"]) {
      expect(isPublicIntegrationAddress(address)).toBe(false);
    }
    expect(isPublicIntegrationAddress("8.8.8.8")).toBe(true);
    expect(isPublicIntegrationAddress("2606:4700:4700::1111")).toBe(true);
    await expect(resolvePinnedIntegrationDestination("https://hooks.example.com/a", async () => [
      { address: "8.8.8.8" },
      { address: "127.0.0.1" },
    ])).resolves.toMatchObject({ ok: false, reason: "unsafe_destination_resolution" });
    await expect(resolvePinnedIntegrationDestination("https://hooks.example.com/a?q=1", async () => [
      { address: "8.8.8.8" },
      { address: "1.1.1.1" },
    ])).resolves.toMatchObject({
      ok: true,
      hostname: "hooks.example.com",
      address: "8.8.8.8",
      path: "/a?q=1",
    });
  });

  it("sends a signed test envelope only to the pinned IP with the original TLS name", async () => {
    let options;
    let body;
    const requester = (nextOptions, callback) => {
      options = nextOptions;
      const request = new EventEmitter();
      request.end = (value) => {
        body = value;
        callback({ statusCode: 204, resume() {} });
      };
      request.destroy = () => request.emit("error", new Error("destroyed"));
      return request;
    };
    const outcome = await deliverClaimedIntegrationWebhook({
      url: "https://hooks.example.com/events",
      deliveryId: "delivery-1",
      eventId: "event-1",
      eventName: "case.opened",
      occurredAt: "2026-08-24T00:00:00.000Z",
      secret: "whsec_" + "a".repeat(48),
    }, {
      now: () => Date.parse("2026-08-24T00:00:05.000Z"),
      resolver: async () => [{ address: "8.8.8.8" }],
      requester,
    });
    expect(outcome).toMatchObject({ ok: true, destinationHost: "hooks.example.com" });
    expect(options).toMatchObject({ hostname: "8.8.8.8", servername: "hooks.example.com", path: "/events" });
    expect(options).not.toHaveProperty("href");
    expect(options.headers["X-Union-Ground-Signature"]).toMatch(/^t=1787529605,v1=[0-9a-f]{64}$/);
    expect(options.headers["X-Union-Ground-Timestamp"]).toBe("1787529605");
    expect(options.headers["X-Union-Ground-Delivery"]).toBe("delivery-1");
    expect(JSON.parse(body)).toEqual({ id: "event-1", type: "case.opened", occurredAt: "2026-08-24T00:00:00.000Z", test: false });
  });

  it("formats a pinned public IPv6 literal as a valid HTTP Host", async () => {
    let options;
    const requester = (nextOptions, callback) => {
      options = nextOptions;
      const request = new EventEmitter();
      request.end = () => callback({ statusCode: 204, resume() {} });
      request.destroy = () => request.emit("error", new Error("destroyed"));
      return request;
    };
    await expect(deliverClaimedIntegrationWebhook({
      url: "https://[2606:4700:4700::1111]/events",
      deliveryId: "delivery-v6",
      eventId: "event-v6",
      eventName: "case.opened",
      occurredAt: "2026-08-24T00:00:00.000Z",
      secret: "whsec_" + "b".repeat(48),
    }, { requester })).resolves.toMatchObject({ ok: true });
    expect(options).toMatchObject({
      hostname: "2606:4700:4700::1111",
      servername: "2606:4700:4700::1111",
    });
    expect(options.headers.Host).toBe("[2606:4700:4700::1111]");
  });
});
