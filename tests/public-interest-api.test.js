// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/public-interest.js";
import {
  publicInterestEmailScope,
  publicInterestScope,
  publicInterestStopEmailScope,
} from "../api/_lib/publicInterest.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

const SUPABASE = "https://project.supabase.co";

function response(payload, status = 200) {
  const body = payload === null ? "" : JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

function recorder() {
  const out = { status: 0, headers: {}, body: null };
  return {
    out,
    status(code) { out.status = code; return this; },
    setHeader(name, value) { out.headers[name] = value; },
    end(body) { out.body = JSON.parse(body); },
  };
}

function request(body = {}, overrides = {}) {
  return {
    method: "POST",
    url: "/api/public-interest",
    headers: { origin: "https://app.example.org", "x-vercel-forwarded-for": "203.0.113.7" },
    body: {
      email: " Member@Example.org ",
      name: " Alex Rivera ",
      interest: "chapter_updates",
      locale: "es",
      website: "",
      ...body,
    },
    ...overrides,
  };
}

async function run(req) {
  const res = recorder();
  await handler(req, res);
  return res.out;
}

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-secret-key");
  vi.stubEnv("PUBLIC_SITE_APP_ORIGIN", "https://app.example.org");
  vi.stubEnv("PUBLIC_INTEREST_RATE_LIMIT_SECRET", "public-interest-rate-secret-at-least-32-chars");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("public interest endpoint", () => {
  it("buckets IPv6 privacy addresses by /64 while keeping distinct networks separate", () => {
    const key = "public-interest-rate-secret-at-least-32-chars";
    const requestFor = (address) => ({ headers: { "x-vercel-forwarded-for": address }, socket: {} });

    expect(publicInterestScope(requestFor("2001:db8:abcd:12::1"), key))
      .toBe(publicInterestScope(requestFor("2001:0db8:abcd:0012:ffff:ffff:ffff:ffff"), key));
    expect(publicInterestScope(requestFor("2001:db8:abcd:12::1"), key))
      .not.toBe(publicInterestScope(requestFor("2001:db8:abcd:13::1"), key));
    expect(publicInterestScope(requestFor("::ffff:203.0.113.7"), key))
      .toBe(publicInterestScope(requestFor("203.0.113.7"), key));
    expect(publicInterestScope({
      headers: { "x-vercel-forwarded-for": "203.0.113.7, 198.51.100.4" },
      socket: { remoteAddress: "198.51.100.9" },
    }, key)).toBe(publicInterestScope(requestFor("203.0.113.7"), key));
    expect(publicInterestScope({
      headers: { "x-vercel-forwarded-for": "not-an-ip", "x-forwarded-for": "203.0.113.7" },
      socket: { remoteAddress: "203.0.113.8" },
    }, key)).toBeNull();
    expect(publicInterestScope({
      headers: { "x-forwarded-for": "203.0.113.7" },
      socket: {},
    }, key)).toBeNull();
    expect(publicInterestScope(requestFor("not-an-ip"), key)).toBeNull();
  });

  it("keys the email-interest limiter scope without retaining the raw digest", () => {
    const key = "public-interest-rate-secret-at-least-32-chars";
    const scope = publicInterestEmailScope(" Member@Example.org ", "chapter_updates", key);
    const rawDigest = createHash("sha256")
      .update("member@example.org\u001fchapter_updates")
      .digest("hex");

    expect(scope).toMatch(/^[0-9a-f]{64}$/);
    expect(scope).not.toBe(rawDigest);
    expect(scope).toBe(publicInterestEmailScope("member@example.org", "chapter_updates", key));
    expect(scope).not.toBe(publicInterestEmailScope("member@example.org", "union_news", key));
    expect(publicInterestEmailScope(undefined, undefined, key)).toMatch(/^[0-9a-f]{64}$/);
    expect(publicInterestStopEmailScope(undefined, key)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is POST-only, query-free, and same-origin before any database call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await run({ method: "GET", url: "/api/public-interest", headers: {}, body: null })).status).toBe(405);
    expect((await run(request({}, { url: "/api/public-interest?email=x" }))).status).toBe(400);
    expect((await run(request({}, { headers: { origin: "https://evil.example" } }))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts honeypot submissions without reaching the database", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const out = await run(request({ website: "bot-site" }));

    expect(out).toMatchObject({ status: 200, body: { accepted: true } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when configuration or a trusted network scope is unavailable", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("PUBLIC_INTEREST_RATE_LIMIT_SECRET", "short");
    expect((await run(request())).status).toBe(503);
    vi.stubEnv("PUBLIC_INTEREST_RATE_LIMIT_SECRET", "public-interest-rate-secret-at-least-32-chars");
    expect((await run(request({}, { headers: { origin: "https://app.example.org" }, socket: {} }))).status).toBe(400);
    expect((await run(request(null, { body: null }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires every endpoint configuration value independently", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const values = {
      VITE_SUPABASE_URL: SUPABASE, UNIONGROUND_SUPABASE_PROJECT_REF: "project",
      SUPABASE_SERVICE_ROLE_KEY: "server-secret-key",
      PUBLIC_SITE_APP_ORIGIN: "https://app.example.org",
      PUBLIC_INTEREST_RATE_LIMIT_SECRET: "public-interest-rate-secret-at-least-32-chars",
    };
    for (const [name, value] of Object.entries(values)) {
      vi.stubEnv(name, "");
      expect((await run(request())).status).toBe(503);
      vi.stubEnv(name, value);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a service-only RPC with an opaque network bucket and fixed source", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), init, body: JSON.parse(init.body) });
      return response({ accepted: true });
    }));

    const out = await run(request());
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ accepted: true });
    expect(out.headers["Cache-Control"]).toBe("no-store");
    expect(out.headers["Referrer-Policy"]).toBe("no-referrer");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${SUPABASE}/rest/v1/rpc/submit_public_interest`);
    expect(calls[0].init.headers.apikey).toBe("server-secret-key");
    expect(calls[0].body).toEqual({
      p_email: "member@example.org",
      p_name: "Alex Rivera",
      p_interest: "chapter_updates",
      p_locale: "es",
      p_source: "public-landing",
      p_website: "",
      p_scope_hash: publicInterestScope(request(), process.env.PUBLIC_INTEREST_RATE_LIMIT_SECRET),
      p_email_scope_hash: publicInterestEmailScope("member@example.org", "chapter_updates", process.env.PUBLIC_INTEREST_RATE_LIMIT_SECRET),
    });
    expect(JSON.stringify(calls[0])).not.toContain("203.0.113.7");
    expect(calls[0].body.p_email_scope_hash).not.toBe(createHash("sha256")
      .update("member@example.org\u001fchapter_updates")
      .digest("hex"));
    expect(calls[0].body).not.toHaveProperty("p_suppression_scope_hash");
  });

  it("returns the same accepted response for database-level no-op outcomes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ accepted: true })));
    await expect(run(request())).resolves.toMatchObject({ status: 200, body: { accepted: true } });
  });

  it("does not retry a failed service write", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return response({ code: "PGRST202", message: "function not found" }, 404);
    }));

    await expect(run(request())).resolves.toMatchObject({ status: 503, body: { error: "submission-unavailable" } });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual(expect.objectContaining({
      p_email: "member@example.org",
      p_interest: "chapter_updates",
      p_scope_hash: publicInterestScope(request(), process.env.PUBLIC_INTEREST_RATE_LIMIT_SECRET),
      p_email_scope_hash: publicInterestEmailScope("member@example.org", "chapter_updates", process.env.PUBLIC_INTEREST_RATE_LIMIT_SECRET),
    }));
  });

  it("maps database failures and malformed success payloads to one generic response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ message: "details" }, 500))
      .mockResolvedValueOnce(response({ accepted: false })));
    await expect(run(request())).resolves.toMatchObject({ status: 503, body: { error: "submission-unavailable" } });
    await expect(run(request())).resolves.toMatchObject({ status: 503, body: { error: "submission-unavailable" } });
  });
});
