// @vitest-environment node
import { createDecipheriv, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/connect.js";
import { DENIED_PRODUCTION_REF, deniedSupabaseOrigin } from "./helpers/denied-identity-fixtures.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://unionground.supabase.co"));

const requestId = "20000000-0000-4000-8000-000000000001";
const rootSecret = Buffer.alloc(32, 7);
const validBody = {
  requestId,
  firstName: "Avery",
  contactMethod: "email",
  contact: "avery@example.org",
  region: "northeast",
  language: "en",
  bestTime: "evening",
  consent: true,
  safeToContact: true,
  voicemailAllowed: false,
  website: "",
};

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

function request(body = validBody, overrides = {}) {
  const { headers: headerOverrides = {}, ...requestOverrides } = overrides;
  return {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(JSON.stringify(body))),
      origin: "https://unionground.example.org",
      "sec-fetch-site": "same-origin",
      "x-forwarded-for": "203.0.113.8",
      ...headerOverrides,
    },
    socket: { remoteAddress: "127.0.0.1" },
    ...requestOverrides,
  };
}

function rpcResponse(payload) {
  const body = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    text: async () => body,
    json: async () => payload,
  };
}

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://unionground.supabase.co");
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "unionground");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key-long-enough-for-tests");
  vi.stubEnv("UNIONGROUND_APP_URL", "https://unionground.example.org/");
  vi.stubEnv("UNIONGROUND_CONNECT_SECRET", rootSecret.toString("base64"));
  vi.stubEnv("UNIONGROUND_CONNECT_KEY_VERSION", "v1");
  vi.stubEnv("UNIONGROUND_CONNECT_ENABLED", "1");
  vi.stubEnv("VITE_UNIONGROUND_CONNECT_ENABLED", "1");
  vi.stubEnv(
    "UNIONGROUND_CONNECT_ACTIVATION_CONFIRM",
    "ENABLE_ONLY_AFTER_CONTACT_VERIFICATION_REVIEWER_AND_PURGE_READY",
  );
  vi.stubEnv("CRON_SECRET", "cron-secret-long-enough-for-connect-tests");
  // The handler logs which interlock refused it. That is the point of the
  // change, but it would otherwise flood the run with expected failures.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("public connect API", () => {
  it("encrypts the minimal payload and persists it only through the service-role RPC", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(rpcResponse({
      accepted: true,
      idempotent: false,
      requestId,
    }));
    const response = responseRecorder();
    await handler(request(validBody, {
      headers: { "x-vercel-forwarded-for": "198.51.100.99" },
    }), response);

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toEqual({ accepted: true, requestId });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("https://unionground.supabase.co/rest/v1/rpc/submit_unionground_connect_request");
    expect(options.headers.apikey).toBe("service-role-key-long-enough-for-tests");
    const rpc = JSON.parse(options.body);
    expect(JSON.stringify(rpc)).not.toContain("Avery");
    expect(JSON.stringify(rpc)).not.toContain("avery@example.org");
    expect(rpc.p_request_id).toBe(requestId);
    expect(rpc.p_key_version).toBe("v1");
    const rateKey = createHmac("sha256", rootSecret)
      .update("connect-rate-v1", "utf8")
      .digest();
    expect(rpc.p_payload_digest).toMatch(/^[0-9a-f]{64}$/);

    const key = createHmac("sha256", rootSecret)
      .update("connect-encryption-v1", "utf8")
      .digest();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(rpc.p_payload_iv, "base64"),
    );
    decipher.setAAD(Buffer.from(`${requestId}|v1`, "utf8"));
    decipher.setAuthTag(Buffer.from(rpc.p_payload_auth_tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(rpc.p_payload_ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const decrypted = JSON.parse(plaintext);
    expect(decrypted).toMatchObject({
      firstName: "Avery",
      contactMethod: "email",
      contact: "avery@example.org",
      region: "northeast",
      language: "en",
      bestTime: "evening",
      safeToContact: true,
      voicemailAllowed: false,
    });
    expect(decrypted.consentedAt).toMatch(/Z$/);
    expect(rpc.p_ip_hash).toBe(
      createHmac("sha256", rateKey)
        .update(`${decrypted.consentedAt.slice(0, 13)}|203.0.113.8`)
        .digest("hex"),
    );
    expect(decrypted).not.toHaveProperty("employer");
    expect(decrypted).not.toHaveProperty("notes");
  });

  it("keeps the idempotency digest stable across encrypted retries", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(rpcResponse({ accepted: true, requestId }))
      .mockResolvedValueOnce(rpcResponse({ accepted: true, idempotent: true, requestId }));

    await handler(request(), responseRecorder());
    await handler(request(), responseRecorder());
    const first = JSON.parse(global.fetch.mock.calls[0][1].body);
    const second = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(first.p_payload_digest).toBe(second.p_payload_digest);
    expect(first.p_payload_ciphertext).not.toBe(second.p_payload_ciphertext);
  });

  it("binds the digest to the request ID so identical contacts are not linkable", async () => {
    const otherId = "20000000-0000-4000-8000-000000000002";
    global.fetch = vi.fn()
      .mockResolvedValueOnce(rpcResponse({ accepted: true, requestId }))
      .mockResolvedValueOnce(rpcResponse({ accepted: true, requestId: otherId }));
    await handler(request(), responseRecorder());
    await handler(request({ ...validBody, requestId: otherId }), responseRecorder());
    const first = JSON.parse(global.fetch.mock.calls[0][1].body);
    const second = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(first.p_payload_digest).not.toBe(second.p_payload_digest);
  });

  it("rejects cross-origin, cross-site, non-JSON, oversized, or expanded payloads before persistence", async () => {
    global.fetch = vi.fn();
    const cases = [
      request(validBody, { headers: { origin: "https://evil.example" } }),
      request(validBody, { headers: { "sec-fetch-site": "cross-site" } }),
      request(validBody, { headers: { "content-type": "text/plain" } }),
      request(validBody, { headers: { "content-type": "application/jsonp" } }),
      request(validBody, { headers: { "content-length": "5000" } }),
      request({ ...validBody, employer: "Forbidden Employer" }),
    ];
    for (const item of cases) {
      const response = responseRecorder();
      await handler(item, response);
      expect([400, 403, 413, 415]).toContain(response.statusCode);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects invalid consent/contact data and does not expose validation details", async () => {
    global.fetch = vi.fn();
    for (const body of [
      { ...validBody, consent: false },
      { ...validBody, contact: "not-email" },
      { ...validBody, contactMethod: "phone", contact: "123" },
      { ...validBody, bestTime: "midnight" },
      { ...validBody, safeToContact: false },
      { ...validBody, region: "Western Massachusetts" },
    ]) {
      const response = responseRecorder();
      await handler(request(body), response);
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: "invalid-request" });
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("silently accepts the honeypot and maps database rate limits", async () => {
    global.fetch = vi.fn();
    const trapped = responseRecorder();
    await handler(request({ ...validBody, website: "https://bot.invalid" }), trapped);
    expect(trapped.statusCode).toBe(202);
    expect(global.fetch).not.toHaveBeenCalled();

    global.fetch = vi.fn().mockResolvedValueOnce(rpcResponse({
      accepted: false,
      reason: "rate-limit",
    }));
    const limited = responseRecorder();
    await handler(request(), limited);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["Retry-After"]).toBe("3600");
  });

  it("fails closed for missing or legacy provider configuration", async () => {
    global.fetch = vi.fn();
    vi.stubEnv("UNIONGROUND_CONNECT_SECRET", "");
    const missing = responseRecorder();
    await handler(request(), missing);
    expect(missing.statusCode).toBe(503);

    vi.stubEnv("UNIONGROUND_CONNECT_SECRET", rootSecret.toString("base64"));
    vi.stubEnv("VITE_SUPABASE_URL", deniedSupabaseOrigin(DENIED_PRODUCTION_REF));
    vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", DENIED_PRODUCTION_REF);
    const legacy = responseRecorder();
    await handler(request(), legacy);
    expect(legacy.statusCode).toBe(503);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fails closed while public intake is disabled", async () => {
    global.fetch = vi.fn();
    vi.stubEnv("UNIONGROUND_CONNECT_ENABLED", "0");
    const response = responseRecorder();
    await handler(request(), response);
    expect(response.statusCode).toBe(503);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fails closed when browser visibility, activation confirmation, or purge authorization is not ready", async () => {
    global.fetch = vi.fn();
    for (const [name, value] of [
      ["VITE_UNIONGROUND_CONNECT_ENABLED", "0"],
      ["UNIONGROUND_CONNECT_ACTIVATION_CONFIRM", "disabled"],
      ["CRON_SECRET", ""],
    ]) {
      vi.stubEnv(name, value);
      const response = responseRecorder();
      await handler(request(), response);
      expect(response.statusCode).toBe(503);
      vi.unstubAllEnvs();
      vi.stubEnv("VITE_SUPABASE_URL", "https://unionground.supabase.co");
      vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "unionground");
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key-long-enough-for-tests");
      vi.stubEnv("UNIONGROUND_APP_URL", "https://unionground.example.org/");
      vi.stubEnv("UNIONGROUND_CONNECT_SECRET", rootSecret.toString("base64"));
      vi.stubEnv("UNIONGROUND_CONNECT_KEY_VERSION", "v1");
      vi.stubEnv("UNIONGROUND_CONNECT_ENABLED", "1");
      vi.stubEnv("VITE_UNIONGROUND_CONNECT_ENABLED", "1");
      vi.stubEnv(
        "UNIONGROUND_CONNECT_ACTIVATION_CONFIRM",
        "ENABLE_ONLY_AFTER_CONTACT_VERIFICATION_REVIEWER_AND_PURGE_READY",
      );
      vi.stubEnv("CRON_SECRET", "cron-secret-long-enough-for-connect-tests");
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // The fourth interlock, and the only one that is not a flag: intake stays shut
  // until the retention purge can authorize itself, so a CRON_SECRET that is
  // merely present is not enough. It shares one floor (32) with the purge and
  // the notification dispatcher.
  it("refuses to open intake for a CRON_SECRET below the shared strength floor", async () => {
    global.fetch = vi.fn();
    vi.stubEnv("CRON_SECRET", "c".repeat(31));
    const response = responseRecorder();
    await handler(request(), response);
    expect(response.statusCode).toBe(503);
    expect(global.fetch).not.toHaveBeenCalled();

    vi.stubEnv("CRON_SECRET", "c".repeat(32));
    global.fetch = vi.fn().mockResolvedValueOnce(rpcResponse({ accepted: true, idempotent: false, requestId }));
    const accepted = responseRecorder();
    await handler(request(), accepted);
    expect(accepted.statusCode).toBe(202);
  });

  // Every interlock answers the visitor with the same opaque 503 — the endpoint
  // must not be a probe for which one is missing — while the operator gets the
  // specific reason in the function log.
  it("names the failing interlock in the log and never in the response", async () => {
    global.fetch = vi.fn();
    vi.stubEnv("UNIONGROUND_CONNECT_ACTIVATION_CONFIRM", "disabled");
    const response = responseRecorder();
    await handler(request(), response);

    expect(JSON.parse(response.body)).toEqual({ error: "not-configured" });
    const logged = console.error.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("UNIONGROUND_CONNECT_ACTIVATION_CONFIRM");
    // The activation phrase itself is the shared secret of the interlock; naming
    // the variable is useful, echoing its expected value is not.
    expect(logged).not.toContain("ENABLE_ONLY_AFTER_CONTACT_VERIFICATION");
  });

  it("advertises only POST for unsupported methods", async () => {
    const response = responseRecorder();
    await handler(request(validBody, { method: "GET" }), response);
    expect(response.statusCode).toBe(405);
    expect(response.headers.Allow).toBe("POST");
  });
});
