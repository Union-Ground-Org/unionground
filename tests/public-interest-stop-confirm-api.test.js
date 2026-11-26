// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/public-interest-stop-confirm.js";
import { publicInterestStopScope } from "../api/_lib/publicInterest.js";
import {
  sendStopConfirmationEmail, stopConfirmationDigest, stopConfirmationEmail, stopConfirmationUrl,
} from "../api/_lib/publicInterestStopConfirmation.js";
import { PORTAL_ORIGIN, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

// SEC-UG-PUBLIC-INTEREST-SUPPRESSION-CONFIRMATION-20260921 (owner ruling
// 2026-09-25): the confirm endpoint forwards only the token digest and a
// network rate scope, and every non-success reads the same to the caller.
const SUPABASE = SUPABASE_ORIGIN;
// A shape-valid, obviously non-secret token: 43 URL-safe characters.
const TOKEN = "stop-confirm-proof-".padEnd(43, "x");

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
    url: "/api/public-interest-stop-confirm",
    headers: { origin: PORTAL_ORIGIN, "x-vercel-forwarded-for": "203.0.113.7" },
    body: { token: TOKEN, ...body },
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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("public interest stop confirmation endpoint", () => {
  it("builds a fragment-only link and a stable digest", () => {
    expect(stopConfirmationUrl(PORTAL_ORIGIN, TOKEN)).toBe(`${PORTAL_ORIGIN}/stop-updates#confirm=${TOKEN}`);
    expect(stopConfirmationDigest(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
    expect(stopConfirmationDigest(TOKEN)).toBe(stopConfirmationDigest(TOKEN));
    expect(stopConfirmationDigest(TOKEN)).not.toBe(stopConfirmationDigest(`${TOKEN.slice(0, -1)}0`));
  });

  it("renders the confirmation email in English by default and in Spanish on request, and reports provider refusals", async () => {
    const link = stopConfirmationUrl(PORTAL_ORIGIN, TOKEN);
    const english = stopConfirmationEmail("en", link);
    expect(english.subject).toBe("Confirm: stop Union Ground public updates");
    expect(english.text).toContain("Nothing changes until you confirm");
    expect(english.text).toContain("within 24 hours; it works once");
    expect(english.text).toContain(`Stop public updates: ${link}`);
    expect(english.html).toContain('<html lang="en">');
    expect(english.html).toContain(`href="${link}"`);
    expect(stopConfirmationEmail("xx", link).html).toContain('<html lang="en">');
    const spanish = stopConfirmationEmail("es", link);
    expect(spanish.html).toContain('<html lang="es">');
    expect(spanish.text).toContain("funciona una sola vez");
    // The link is HTML-escaped exactly once and the token never gains a query form.
    expect(stopConfirmationEmail("en", "https://x.test/stop-updates#confirm=a&b").html).toContain('href="https://x.test/stop-updates#confirm=a&amp;b"');

    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 502 });
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendStopConfirmationEmail({ resendKey: "re", from: "a@b.co", to: "m@x.co", locale: "en", link, tokenHash: "f".repeat(64) })).resolves.toBe(false);
    expect(fetchMock.mock.calls[0][1].headers["Idempotency-Key"]).toBe(`sg-stop-confirm-${"f".repeat(40)}`);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await expect(sendStopConfirmationEmail({ resendKey: "re", from: "a@b.co", to: "m@x.co", locale: "es", link, tokenHash: "f".repeat(64) })).resolves.toBe(true);
  });

  it("is POST-only, query-free, same-origin, and refuses a malformed token before the database", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await run({ method: "GET", url: "/api/public-interest-stop-confirm", headers: {}, body: null })).status).toBe(405);
    expect((await run(request({}, { url: "/api/public-interest-stop-confirm?token=x" }))).status).toBe(400);
    expect((await run(request({}, { headers: { origin: "https://evil.example" } }))).status).toBe(403);
    expect((await run(request({}, { body: "not json" }))).status).toBe(400);
    const malformed = await run(request({ token: "short" }));
    expect(malformed).toMatchObject({ status: 410, body: { error: "confirmation-unavailable" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards only the token digest and an opaque network scope to the service-role confirm RPC", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), init, body: JSON.parse(init.body) });
      return response({ confirmed: true });
    }));
    const out = await run(request());
    expect(out).toMatchObject({ status: 200, body: { confirmed: true } });
    expect(out.headers["Referrer-Policy"]).toBe("no-referrer");
    expect(out.headers["Cache-Control"]).toBe("no-store");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${SUPABASE}/rest/v1/rpc/confirm_public_interest_stop`);
    expect(calls[0].init.headers.apikey).toBe("server-secret-key");
    expect(calls[0].body).toEqual({
      p_token_hash: stopConfirmationDigest(TOKEN),
      p_scope_hash: publicInterestStopScope(request(), process.env.PUBLIC_INTEREST_RATE_LIMIT_SECRET),
    });
    expect(JSON.stringify(calls[0])).not.toContain(TOKEN);
    expect(JSON.stringify(calls[0])).not.toContain("203.0.113.7");
  });

  it("returns one refusal for unknown, expired and used tokens, a retry hint for the rate bound, and fails closed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(response({ confirmed: false, refusal: "unavailable" }));
    expect(await run(request())).toMatchObject({ status: 410, body: { error: "confirmation-unavailable" } });
    fetchMock.mockResolvedValueOnce(response({ confirmed: false, refusal: "rate-limited" }));
    expect(await run(request())).toMatchObject({ status: 429, body: { error: "try-later" } });
    fetchMock.mockResolvedValueOnce(response({ detail: "private" }, 500));
    expect(await run(request())).toMatchObject({ status: 503, body: { error: "confirmation-unavailable" } });
    fetchMock.mockResolvedValueOnce(response({ something: "else" }));
    expect(await run(request())).toMatchObject({ status: 410, body: { error: "confirmation-unavailable" } });

    vi.stubEnv("PUBLIC_INTEREST_RATE_LIMIT_SECRET", "short");
    expect((await run(request())).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
