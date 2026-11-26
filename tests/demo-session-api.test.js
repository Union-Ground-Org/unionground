// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import demoSession from "../api/demo-session.js";
import { PORTAL_HOST, SAMPLE_HOST, SUPABASE_ORIGIN } from "./helpers/fictional-provider.js";
import { DENIED_PRODUCTION_REF, DENIED_SAMPLE_REF, deniedSupabaseOrigin } from "./helpers/denied-identity-fixtures.js";
import { totp } from "../api/_lib/totp.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
// The shipped SAMPLE backend pins no project and refuses every target; these
// cases exercise the handler once a project is pinned (see the helper).
vi.mock("../src/lib/sampleBackend.js", async (importOriginal) =>
  (await import("./helpers/batch02-pinned-sample-backend.js")).pinnedSampleBackendModule(await importOriginal()));

// /api/demo-session signs a visitor in as a fictional SAMPLE persona account
// so the demo origin's credentials-free entry and hat switcher establish REAL
// sessions through the production auth path
// (UB-UG-DEMO-STRAIGHT-IN-ENTRY-RESTORED-20261107). It must exist
// only on the demo surface, only for the seven seeded hats, and only against
// the SAMPLE backend; a staff persona's session must reach aal2 with that
// persona's own authenticator; and it must never leak the action link, the
// token hash, any key or any authenticator secret.

const SAMPLE = SUPABASE_ORIGIN;
const FACTOR = "0f5e1b2c-3d4e-4f5a-8b6c-7d8e9fa0b1c2";
// The RFC 6238 appendix B SHA-1 seed (ASCII "12345678901234567890"), base32
// encoded at run time so no secret-shaped literal is committed.
function base32(text) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...Buffer.from(text)].map((byte) => byte.toString(2).padStart(8, "0")).join("");
  return bits.match(/.{1,5}/g).map((chunk) => alphabet[Number.parseInt(chunk.padEnd(5, "0"), 2)]).join("");
}
const SECRET = base32("1234567890".repeat(2));
const EMAILS = {
  member: "darnell.foster@example.invalid",
  organize: "elena.cruz@example.invalid",
  steward: "maya.thompson@example.invalid",
  coordinator: "andre.lewis@example.invalid",
  advisor: "priya.shah@example.invalid",
  admin: "rosa.martinez@example.invalid",
  vp: "jordan.kim@example.invalid",
};

function recorder() {
  const out = { status: 0, headers: {}, body: null };
  return {
    out,
    status(code) { out.status = code; return this; },
    setHeader(name, value) { out.headers[name] = value; },
    end(body) { out.body = body ? JSON.parse(body) : null; },
  };
}

async function run(req) {
  const res = recorder();
  await demoSession(req, res);
  return res.out;
}

const post = (hat, host = SAMPLE_HOST) => ({ method: "POST", headers: { host }, body: { hat } });

function reply(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

// A GoTrue double: answers each step by path, records every call.
function gotrue({ email = null, factors = null, overrides = {} } = {}) {
  return vi.fn(async (url, init) => {
    const path = String(url).replace(`${SAMPLE}/auth/v1`, "").split("?")[0];
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    if (Object.hasOwn(overrides, path)) return overrides[path](body, init, url);
    if (path === "/admin/users") {
      const filter = new URL(url).searchParams.get("filter");
      return reply(200, { users: Object.values(EMAILS).includes(filter) ? [{ id: "persona-user", email: filter }] : [] });
    }
    if (path === "/admin/generate_link") return reply(200, { hashed_token: "hashed-token-value", verification_type: "magiclink", action_link: `${SAMPLE}/auth/v1/verify?token=secret` });
    if (path === "/verify") {
      return reply(200, {
        access_token: "aal1-access", refresh_token: "aal1-refresh",
        user: { email: email ?? "", factors: factors ?? [] },
      });
    }
    if (path === `/factors/${FACTOR}/challenge`) return reply(200, { id: "challenge-1" });
    if (path === `/factors/${FACTOR}/verify`) return reply(200, { access_token: "aal2-access", refresh_token: "aal2-refresh" });
    return reply(404, {});
  });
}

const verifiedTotp = [{ id: FACTOR, factor_type: "totp", status: "verified" }];
const authenticators = (hats) => JSON.stringify(Object.fromEntries(hats.map((hat) => [hat, { factorId: FACTOR, secret: SECRET }])));

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-secret-key");
  vi.stubEnv("SAMPLE_SUPABASE_URL", SAMPLE);
  vi.stubEnv("SAMPLE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_sample");
  // Modern opaque secret key: the mint must send it via apikey with the
  // pinned server User-Agent, never as an Authorization bearer.
  vi.stubEnv("SAMPLE_SUPABASE_SERVICE_ROLE_KEY", "sb_secret_sample_service");
  vi.stubEnv("SAMPLE_DEMO_PERSONA_AUTHENTICATORS", authenticators(["organize", "steward", "coordinator", "advisor", "admin", "vp"]));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("demo-session surface boundary", () => {
  it.each([PORTAL_HOST, `www.${PORTAL_HOST}`, `${SAMPLE_HOST}.attacker.invalid`, "example.com"])("refuses %s with 404 before touching any backend", async (host) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(post("member", host));
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ error: "not-available" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["GET", "PUT", "DELETE"])("refuses %s", async (method) => {
    const out = await run({ method, headers: { host: SAMPLE_HOST } });
    expect(out.status).toBe(405);
  });

  it.each(["superuser", "__proto__", "constructor", "toString", "", "MEMBER", 7, null, ["member"], { hat: "member" }])("refuses hat %j without contacting GoTrue", async (hat) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(post(hat));
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ error: "unknown-hat" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a forbidden backend", "SAMPLE_SUPABASE_URL", deniedSupabaseOrigin(DENIED_PRODUCTION_REF)],
    ["no service key", "SAMPLE_SUPABASE_SERVICE_ROLE_KEY", ""],
    ["no publishable key", "SAMPLE_SUPABASE_PUBLISHABLE_KEY", ""],
  ])("fails closed with %s", async (_label, key, value) => {
    vi.stubEnv(key, value);
    if (key === "SAMPLE_SUPABASE_PUBLISHABLE_KEY") vi.stubEnv("VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(post("member"));
    expect(out.status).toBe(503);
    expect(out.body).toEqual({ error: "sample-backend-unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for a denied SAMPLE or production project and for none", async () => {
    for (const url of [deniedSupabaseOrigin(DENIED_SAMPLE_REF), deniedSupabaseOrigin(DENIED_PRODUCTION_REF), ""]) {
      vi.stubEnv("SAMPLE_SUPABASE_URL", url);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const out = await run(post("member"));
      expect(out.status).toBe(503);
      expect(out.body).toEqual({ error: "sample-backend-unconfigured" });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("refuses every project, even a hosted one, while the shipped SAMPLE backend pins none", async () => {
    vi.doUnmock("../src/lib/sampleBackend.js");
    vi.resetModules();
    try {
      const { default: shipped } = await import("../api/demo-session.js");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const res = recorder();
      await shipped({ method: "POST", headers: { host: SAMPLE_HOST }, body: { hat: "member" } }, res);
      expect(res.out.status).toBe(503);
      expect(res.out.body).toEqual({ error: "sample-backend-unconfigured" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.doMock("../src/lib/sampleBackend.js", async (importOriginal) =>
        (await import("./helpers/batch02-pinned-sample-backend.js")).pinnedSampleBackendModule(await importOriginal()));
      vi.resetModules();
    }
  });

  it("parses a JSON string body", async () => {
    vi.stubGlobal("fetch", gotrue({ email: EMAILS.member }));
    const out = await run({ method: "POST", headers: { host: SAMPLE_HOST }, body: JSON.stringify({ hat: "member" }) });
    expect(out.status).toBe(200);
  });

  it("no longer answers the retired 410 on the demo host", async () => {
    vi.stubGlobal("fetch", gotrue({ email: EMAILS.member }));
    const out = await run(post("member"));
    expect(out.status).not.toBe(410);
    expect(out.body).not.toEqual({ error: "demo-retired" });
  });
});

describe("demo-session sign-in", () => {
  it("signs the member hat in as its SAMPLE persona and returns only the session tokens", async () => {
    const fetchMock = gotrue({ email: EMAILS.member });
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(post("member"));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ accessToken: "aal1-access", refreshToken: "aal1-refresh" });
    expect(out.headers["Cache-Control"]).toBe("no-store");
    expect(out.headers["Referrer-Policy"]).toBe("no-referrer");
    expect(JSON.stringify(out.body)).not.toMatch(/hashed-token-value|action_link|sb_secret/);
    expect(JSON.stringify(out.body)).not.toContain(SECRET);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${SAMPLE}/auth/v1/admin/users?page=1&per_page=50&filter=${encodeURIComponent(EMAILS.member)}`,
      `${SAMPLE}/auth/v1/admin/generate_link`,
      `${SAMPLE}/auth/v1/verify`,
    ]);
    const [, lookup] = fetchMock.mock.calls[0];
    expect(lookup.method).toBe("GET");
    expect(lookup.headers.apikey).toBe("sb_secret_sample_service");
    expect(lookup.headers.Authorization).toBeUndefined();
    const [, mint] = fetchMock.mock.calls[1];
    // Secret-key contract (REQ-UG-SUPABASE-SECRET-KEY-20260803): opaque
    // sb_secret_ keys ride in apikey only, with the server User-Agent pinned
    // and no Authorization bearer for the gateway to refuse.
    expect(mint.headers.apikey).toBe("sb_secret_sample_service");
    expect(mint.headers.Authorization).toBeUndefined();
    expect(mint.headers["User-Agent"]).toBe("UnionGround-Server/1.0");
    expect(JSON.parse(mint.body)).toEqual({ type: "magiclink", email: EMAILS.member });
    const [, verify] = fetchMock.mock.calls[2];
    expect(verify.headers.apikey).toBe("sb_publishable_sample");
    expect(verify.headers.Authorization).toBeUndefined();
    expect(JSON.parse(verify.body)).toEqual({ type: "email", token_hash: "hashed-token-value" });
  });

  it.each(["organize", "steward", "coordinator", "advisor", "admin", "vp"])("raises the %s persona to aal2 with its own authenticator", async (hat) => {
    const fetchMock = gotrue({ email: EMAILS[hat], factors: verifiedTotp });
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(post(hat));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ accessToken: "aal2-access", refreshToken: "aal2-refresh" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ type: "magiclink", email: EMAILS[hat] });
    const [challengeUrl, challenge] = fetchMock.mock.calls[3];
    expect(challengeUrl).toBe(`${SAMPLE}/auth/v1/factors/${FACTOR}/challenge`);
    expect(challenge.headers.Authorization).toBe("Bearer aal1-access");
    expect(challenge.headers.apikey).toBe("sb_publishable_sample");
    const [verifyUrl, verify] = fetchMock.mock.calls[4];
    expect(verifyUrl).toBe(`${SAMPLE}/auth/v1/factors/${FACTOR}/verify`);
    expect(verify.headers.Authorization).toBe("Bearer aal1-access");
    expect(JSON.parse(verify.body)).toEqual({ challenge_id: "challenge-1", code: expect.stringMatching(/^\d{6}$/) });
  });

  it("answers the challenge with the RFC 6238 code for the configured secret", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(59_000);
    try {
      const fetchMock = gotrue({ email: EMAILS.steward, factors: verifiedTotp });
      vi.stubGlobal("fetch", fetchMock);
      expect((await run(post("steward"))).status).toBe(200);
      // RFC 6238 appendix B, SHA-1 at T = 59 s: 94287082, six digits 287082.
      expect(JSON.parse(fetchMock.mock.calls[4][1].body).code).toBe("287082");
    } finally {
      vi.useRealTimers();
    }
  });

  it("raises a member persona that holds a verified authenticator too", async () => {
    vi.stubEnv("SAMPLE_DEMO_PERSONA_AUTHENTICATORS", authenticators(["member"]));
    const fetchMock = gotrue({ email: EMAILS.member, factors: verifiedTotp });
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(post("member"));
    expect(out.body).toEqual({ accessToken: "aal2-access", refreshToken: "aal2-refresh" });
  });

  it.each([
    ["no authenticator variable", undefined],
    ["unparseable JSON", "{not json"],
    ["an array", "[]"],
    ["another hat only", authenticators(["admin"])],
    ["a malformed factor id", JSON.stringify({ steward: { factorId: "nope", secret: SECRET } })],
    ["a malformed secret", JSON.stringify({ steward: { factorId: FACTOR, secret: "not base32!" } })],
  ])("never returns an aal1 staff session: %s", async (_label, value) => {
    vi.stubEnv("SAMPLE_DEMO_PERSONA_AUTHENTICATORS", value ?? "");
    const fetchMock = gotrue({ email: EMAILS.steward, factors: verifiedTotp });
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(post("steward"));
    expect(out.status).toBe(503);
    expect(out.body).toEqual({ error: "persona-unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(console.warn.mock.calls[0][0]).reason).toBe("missing_authenticator");
  });

  it("refuses an authenticator that is not the persona's own verified factor", async () => {
    const fetchMock = gotrue({ email: EMAILS.steward, factors: [{ id: "11111111-2222-4333-8444-555555555555", factor_type: "totp", status: "verified" }] });
    vi.stubGlobal("fetch", fetchMock);
    expect((await run(post("steward"))).status).toBe(503);
    expect(JSON.parse(console.warn.mock.calls[0][0]).reason).toBe("missing_authenticator");
  });

  it.each([
    ["another account", { email: "kayla.doyle@loadtest.example.com" }],
    ["no access token", { email: EMAILS.member, noAccess: true }],
  ])("refuses a verified session that belongs to %s", async (_label, { email, noAccess }) => {
    vi.stubGlobal("fetch", gotrue({
      overrides: { "/verify": () => reply(200, { ...(noAccess ? {} : { access_token: "a" }), refresh_token: "r", user: { email } }) },
    }));
    const out = await run(post("member"));
    expect(out.status).toBe(503);
    expect(JSON.parse(console.warn.mock.calls[0][0]).reason).toBe("identity_mismatch");
  });

  it.each([
    ["challenge refused", { [`/factors/${FACTOR}/challenge`]: () => reply(422, {}) }, 422],
    ["challenge without id", { [`/factors/${FACTOR}/challenge`]: () => reply(200, {}) }, 200],
    ["code refused", { [`/factors/${FACTOR}/verify`]: () => reply(422, {}) }, 422],
    ["verify without tokens", { [`/factors/${FACTOR}/verify`]: () => reply(200, { access_token: "x" }) }, 200],
  ])("fails closed when the two-step step fails (%s)", async (_label, overrides, status) => {
    vi.stubGlobal("fetch", gotrue({ email: EMAILS.admin, factors: verifiedTotp, overrides }));
    const out = await run(post("admin"));
    expect(out.status).toBe(503);
    expect(out.body).toEqual({ error: "persona-unavailable" });
    expect(JSON.parse(console.warn.mock.calls[0][0])).toMatchObject({ reason: "mfa_http", upstream_status: status });
  });

  it("fails closed when the magic link cannot be verified", async () => {
    vi.stubGlobal("fetch", gotrue({ overrides: { "/verify": () => reply(403, { error: "otp_expired" }) } }));
    const out = await run(post("member"));
    expect(out.status).toBe(503);
    expect(JSON.parse(console.warn.mock.calls[0][0])).toMatchObject({ reason: "verify_http", upstream_status: 403 });
  });

  it.each(["signup", "invite", "recovery"])("refuses a %s link GoTrue issued instead of a magic link", async (type) => {
    const fetchMock = gotrue({ overrides: { "/admin/generate_link": () => reply(200, { hashed_token: "h", verification_type: type }) } });
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(post("member"));
    expect(out.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(console.warn.mock.calls[0][0]).reason).toBe("unexpected_link_type");
  });

  // Gate r1s3/r2s3 on #7375: GoTrue would create a missing persona as a
  // signup, so an absent persona is refused before any link is requested.
  it.each([
    ["no account", { users: [] }],
    ["a look-alike address only", { users: [{ email: "x.darnell.foster@loadtest.example.com" }] }],
    ["a soft-deleted account", { users: [{ email: EMAILS.member, deleted_at: "2026-11-07T00:00:00Z" }] }],
    ["an unreadable listing", {}],
  ])("never asks GoTrue for a link when the persona is missing (%s)", async (_label, listing) => {
    const fetchMock = gotrue({ overrides: { "/admin/users": () => reply(200, listing) } });
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(post("member"));
    expect(out.status).toBe(503);
    expect(out.body).toEqual({ error: "persona-unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("generate_link"))).toBe(false);
    expect(JSON.parse(console.warn.mock.calls[0][0]).reason).toBe("persona_missing");
  });

  it("accepts the auth-js proxy shape that nests the token under properties", async () => {
    vi.stubGlobal("fetch", gotrue({
      email: EMAILS.member,
      overrides: { "/admin/generate_link": () => reply(200, { properties: { hashed_token: "nested", verification_type: "magiclink" } }) },
    }));
    expect((await run(post("member"))).status).toBe(200);
  });
});

describe("demo-session failure diagnostics", () => {
  const secret = "do-not-log-token-key-email-action-link";
  const request = {
    method: "POST",
    headers: { host: SAMPLE_HOST, "x-request-id": secret },
    body: { hat: "steward", extra: secret },
  };

  function expectFailure(out, reason, upstreamStatus) {
    expect(out.status).toBe(503);
    expect(out.body).toEqual({ error: "persona-unavailable" });
    expect(out.headers["Cache-Control"]).toBe("no-store");
    expect(out.headers["Referrer-Policy"]).toBe("no-referrer");
    expect(console.warn).toHaveBeenCalledTimes(1);
    const [line] = console.warn.mock.calls[0];
    const event = JSON.parse(line);
    expect(event).toEqual({
      event: "sample_session_issuance_failed",
      reason,
      upstream_status: upstreamStatus,
      elapsed_ms: expect.any(Number),
    });
    expect(Number.isInteger(event.elapsed_ms)).toBe(true);
    expect(event.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(event.elapsed_ms).toBeLessThanOrEqual(60000);
    expect(line).not.toContain(secret);
    expect(line).not.toContain("maya.thompson");
    expect(line).not.toContain("sb_secret");
    expect(line).not.toContain(SECRET);
  }

  it.each([401, 403, 429, 500, 503])("records upstream HTTP %s without reading its body", async (status) => {
    const json = vi.fn(async () => ({ error: secret, action_link: secret, hashed_token: secret }));
    const fetchMock = vi.fn(async () => ({ ok: false, status, json }));
    vi.stubGlobal("fetch", fetchMock);
    expectFailure(await run(request), "upstream_http", status);
    expect(json).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["fetch", "body"])("distinguishes the eight-second deadline during %s", async (stage) => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fail = () => {
      controller.abort(new DOMException(secret, "TimeoutError"));
      throw controller.signal.reason;
    };
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (stage === "fetch") fail();
      return { ok: true, status: 200, json: fail };
    }));
    expectFailure(await run(request), "timeout", stage === "fetch" ? null : 200);
    expect(timeout).toHaveBeenCalledWith(8000);
    expect(timeout).toHaveBeenCalledTimes(1);
  });

  it("records transport failure without exception text or spoofed error names", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error(secret), { name: "TimeoutError", cause: secret });
    }));
    expectFailure(await run(request), "transport_error", null);
  });

  it("records invalid JSON without logging parser exception text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, json: async () => { throw new SyntaxError(secret); },
    })));
    expectFailure(await run(request), "invalid_json", 200);
  });

  it("keeps interrupted body reads distinct from invalid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, json: async () => { throw new TypeError(secret); },
    })));
    expectFailure(await run(request), "transport_error", 200);
  });

  it.each([null, {}, { action_link: secret, user: { email: secret } }, { properties: {} }])("records missing token without response data (%j)", async (payload) => {
    vi.stubGlobal("fetch", gotrue({ overrides: { "/admin/generate_link": () => reply(200, payload) } }));
    expectFailure(await run(request), "missing_token", 200);
  });

  it("does not copy a nonnumeric upstream status to telemetry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: secret })));
    expectFailure(await run(request), "upstream_http", null);
  });

  it.each([0, 99, 600, -1, 200.5, Number.NaN, Number.POSITIVE_INFINITY])("BUG-UG-SAMPLE-SESSION-FAILURE-DIAGNOSTICS-20260908 bounds malformed upstream status %p out of telemetry", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status })));
    expectFailure(await run(request), "upstream_http", null);
  });

  it("keeps a successful sign-in out of logs", async () => {
    vi.stubGlobal("fetch", gotrue({ email: EMAILS.steward, factors: verifiedTotp }));
    const out = await run(request);
    expect(out.status).toBe(200);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("does not report an upstream failure for a rejected host or hat", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await run({ ...request, headers: { host: PORTAL_HOST } })).status).toBe(404);
    expect((await run({ ...request, body: { hat: secret } })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("preserves the public failure response if the logging sink throws", async () => {
    console.warn.mockImplementation(() => { throw new Error(secret); });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    const out = await run(request);
    expect(out.status).toBe(503);
    expect(out.body).toEqual({ error: "persona-unavailable" });
  });
});

describe("shared demo persona guard list", () => {
  it("names exactly the entry personas in the database guard", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const config = JSON.parse(readFileSync(new URL("../config/sample-backend.json", import.meta.url), "utf8"));
    const migrations = new URL("../supabase/migrations/", import.meta.url);
    const sql = readdirSync(migrations).sort().reverse()
      .filter((name) => name.endsWith(".sql"))
      .map((name) => readFileSync(new URL(name, migrations), "utf8"))
      .find((source) => /^create (?:or replace )?function private\.is_shared_demo_persona_email\(/im.test(source));
    const listed = sql.slice(sql.indexOf("= any (array["), sql.indexOf("]::text[])")).match(/'[^']+'/g).map((item) => item.slice(1, -1));
    expect(listed).toEqual(config.samplePersonas.map((persona) => persona.email));
    expect(Object.values(EMAILS)).toEqual(listed);
  });
});

describe("server TOTP", () => {
  it("matches the RFC 6238 SHA-1 vectors and refuses a malformed secret", () => {
    expect(totp(SECRET, { now: 59_000 })).toBe("287082");
    expect(totp(SECRET, { now: 1_111_111_109_000 })).toBe("081804");
    expect(totp(`${SECRET}====`, { now: 59_000 })).toBe("287082");
    expect(() => totp("not base32!")).toThrow("Invalid base32 TOTP secret");
    expect(() => totp("")).toThrow("Invalid base32 TOTP secret");
  });
});
