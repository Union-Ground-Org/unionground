// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/public-interest-stop.js";
import {
  publicInterestStopEmailScope,
  publicInterestStopScope,
} from "../api/_lib/publicInterest.js";
import { STOP_CONFIRMATION_TOKEN, stopConfirmationDigest } from "../api/_lib/publicInterestStopConfirmation.js";
import { PORTAL_ORIGIN, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

const SUPABASE = SUPABASE_ORIGIN;

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
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
    url: "/api/public-interest-stop",
    headers: { origin: PORTAL_ORIGIN, "x-vercel-forwarded-for": "203.0.113.7" },
    body: { email: " Member@Example.org ", locale: "es", website: "", ...body },
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
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", SUPABASE_REF);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-secret-key");
  vi.stubEnv("PUBLIC_SITE_APP_ORIGIN", PORTAL_ORIGIN);
  vi.stubEnv("PUBLIC_INTEREST_RATE_LIMIT_SECRET", "public-interest-rate-secret-at-least-32-chars");
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("NOTIFY_FROM_ADDRESS", "Union Ground <no-reply@unionground.test>");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("public interest stop endpoint", () => {
  it("derives separate opaque stop rate scopes", () => {
    const key = "public-interest-rate-secret-at-least-32-chars";
    const req = { headers: { "x-vercel-forwarded-for": "2001:db8:abcd:12::1" }, socket: {} };
    const network = publicInterestStopScope(req, key);
    const emailRate = publicInterestStopEmailScope(" Member@Example.org ", key);

    expect(network).toMatch(/^[0-9a-f]{64}$/);
    expect(emailRate).toMatch(/^[0-9a-f]{64}$/);
    expect(network).not.toBe(emailRate);
  });

  it("is POST-only, query-free, same-origin, and rejects invalid email before the database", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect((await run({ method: "GET", url: "/api/public-interest-stop", headers: {}, body: null })).status).toBe(405);
    expect((await run(request({}, { url: "/api/public-interest-stop?email=x" }))).status).toBe(400);
    expect((await run(request({}, { headers: { origin: "https://evil.example" } }))).status).toBe(403);
    expect((await run(request({ email: "not-an-email" }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts honeypots without creating a stop request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(run(request({ website: "bot-site" })))
      .resolves.toMatchObject({ status: 200, body: { accepted: true } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // SEC-UG-PUBLIC-INTEREST-SUPPRESSION-CONFIRMATION-20260921 (owner ruling
  // 2026-09-25, SINGLE-USE EMAIL CONFIRMATION): the endpoint records a pending
  // request keyed by the SHA-256 digest of a fresh token, mails the
  // fragment-only link once, and never calls the immediate stop function.
  it("records a pending request by token digest, mails the single-use link, and never stops directly", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), init, body: JSON.parse(init.body) });
      return String(url).includes("resend.com") ? response({ id: "email-1" }) : response({ accepted: true, pending: true });
    }));

    const out = await run(request());

    expect(out).toMatchObject({ status: 200, body: { accepted: true } });
    expect(out.headers["Cache-Control"]).toBe("no-store");
    expect(out.headers["Referrer-Policy"]).toBe("no-referrer");
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`${SUPABASE}/rest/v1/rpc/request_public_interest_stop`);
    expect(calls[0].init.headers.apikey).toBe("server-secret-key");
    expect(calls[0].body).toEqual({
      p_email: "member@example.org",
      p_locale: "es",
      p_source: "public-landing",
      p_website: "",
      p_scope_hash: publicInterestStopScope(request(), process.env.PUBLIC_INTEREST_RATE_LIMIT_SECRET),
      p_email_scope_hash: publicInterestStopEmailScope("member@example.org", process.env.PUBLIC_INTEREST_RATE_LIMIT_SECRET),
      p_token_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(calls[0])).not.toContain("203.0.113.7");
    expect(calls[0].body).not.toHaveProperty("p_suppression_scope_hash");
    expect(calls.map((call) => call.url)).not.toContain(`${SUPABASE}/rest/v1/rpc/stop_public_interest`);

    const email = calls[1];
    expect(email.url).toBe("https://api.resend.com/emails");
    expect(email.init.headers.Authorization).toBe("Bearer re_test_key");
    expect(email.init.headers["Idempotency-Key"]).toBe(`sg-stop-confirm-${calls[0].body.p_token_hash.slice(0, 40)}`);
    expect(email.body.from).toBe("Union Ground <no-reply@unionground.test>");
    expect(email.body.to).toEqual(["member@example.org"]);
    expect(email.body.subject).toBe("Confirma: detener las novedades públicas de Union Ground");
    expect(email.body.text).toContain("Nada cambia hasta que confirmes");
    expect(email.body.text).toContain("24 horas");
    const [, token] = email.body.text.match(/https:\/\/app\.unionground\.test\/stop-updates#confirm=([A-Za-z0-9_-]+)/) || [];
    expect(token).toMatch(STOP_CONFIRMATION_TOKEN);
    expect(stopConfirmationDigest(token)).toBe(calls[0].body.p_token_hash);
    expect(email.body.html).toContain(`/stop-updates#confirm=${token}`);
    expect(email.body.text).not.toContain("?");
    // The raw token never reaches PostgreSQL.
    expect(JSON.stringify(calls[0])).not.toContain(token);
  });

  it("answers the same way for any address and sends no link when the database refuses the request", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push(String(url));
      return String(url).includes("resend.com") ? response({ id: "email-2" }) : response({ accepted: true, pending: true });
    }));
    const known = await run(request({ email: "member@example.org" }));
    const unknown = await run(request({ email: "nobody@example.org" }));
    expect(unknown).toEqual(known);
    expect(calls.filter((url) => url.includes("resend.com"))).toHaveLength(2);
  });

  it("fails closed on missing configuration, malformed results, rate refusal, database errors, and an undelivered link", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("PUBLIC_INTEREST_RATE_LIMIT_SECRET", "short");
    expect((await run(request())).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv("PUBLIC_INTEREST_RATE_LIMIT_SECRET", "public-interest-rate-secret-at-least-32-chars");
    vi.stubEnv("RESEND_API_KEY", "");
    expect((await run(request())).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv("RESEND_API_KEY", "re_test_key");

    fetchMock.mockResolvedValueOnce(response({ accepted: false }));
    expect((await run(request())).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(response({ detail: "private" }, 500));
    expect((await run(request())).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The pending row exists but no link reached the address: a retryable
    // generic failure, never a suppression and never a leaked token.
    fetchMock.mockResolvedValueOnce(response({ accepted: true, pending: true }));
    fetchMock.mockResolvedValueOnce(response({ message: "provider down" }, 502));
    expect((await run(request())).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
