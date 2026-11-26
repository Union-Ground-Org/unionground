// @vitest-environment node
//
// SEC-UG-PASSWORD-SIGNIN-THROTTLE-20261001: api/auth-password-signin.js
// reserves every well-formed attempt in the durable database throttle before
// contacting GoTrue, answers a flat 429 over either limit, and never lets the
// answer depend on whether the address has an account.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import passwordHandler from "../api/auth-password-signin.js";
import { requestClientAddress } from "../api/_lib/networkAddress.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

const SUPABASE = "https://project.supabase.co";
const THROTTLE = `${SUPABASE}/rest/v1/rpc/reserve_password_signin_attempt`;
const LEGACY = `${SUPABASE}/rest/v1/rpc/consume_password_signin_attempt`;
const REFUND = `${SUPABASE}/rest/v1/rpc/refund_password_signin_attempt`;
const RESERVATION = "00000000-0000-4000-8000-000000000001";
const GRANT = `${SUPABASE}/auth/v1/token?grant_type=password`;

function reply(payload, status = 200) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) };
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

async function run({ body, headers = {}, socket } = {}) {
  const response = recorder();
  await passwordHandler({
    method: "POST",
    headers: { host: "app.example.org", origin: "https://app.example.org", "user-agent": "Test Browser/1.0", ...headers },
    ...(socket ? { socket } : {}),
    body,
  }, response);
  return response.out;
}

// throttle: a value the RPC returns, or a function returning a reply.
function backend({ throttle = true, grant = reply({ error: "invalid_grant" }, 400), refund = true, legacy = true } = {}) {
  const calls = [];
  const fetchMock = vi.fn(async (url, init = {}) => {
    const call = { url: String(url), headers: init.headers, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    if (call.url === THROTTLE) return typeof throttle === "function" ? throttle(call)
      : reply(typeof throttle === "boolean" ? { allowed: throttle, ...(throttle ? { reservation: RESERVATION } : {}) } : throttle);
    if (call.url === LEGACY) return typeof legacy === "function" ? legacy(call) : reply(legacy);
    if (call.url === REFUND) return typeof refund === "function" ? refund(call) : reply(refund);
    if (call.url === GRANT) return typeof grant === "function" ? grant(call) : grant;
    if (call.url.endsWith("/rpc/record_failed_login_attempt")) return reply(undefined, 204);
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const CREDENTIALS = { email: " Member@Example.com ", password: "long-password" };

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-secret-key");
  vi.stubEnv("SUPABASE_AUTH_FORWARD_CLIENT_IP", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("password sign-in throttle", () => {
  it("reserves the normalized address and network before the grant and refunds a success with the service key", async () => {
    const calls = backend({ grant: reply({ access_token: "a", refresh_token: "r" }) });
    const out = await run({ body: CREDENTIALS, headers: { "x-vercel-forwarded-for": "203.0.113.9, 10.0.0.1" } });
    expect(out.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([THROTTLE, GRANT, REFUND]);
    expect(calls[0].body).toEqual({ p_email: "member@example.com", p_network: "ipv4:203.0.113.9" });
    expect(calls[0].headers.apikey).toBe("server-secret-key");
    expect(calls[2].body).toEqual({ p_reservation: RESERVATION });
    expect(calls[2].headers.apikey).toBe("server-secret-key");
  });

  it("buckets IPv6 by /64 and shares one bucket when no address is readable", async () => {
    let calls = backend();
    await run({ body: CREDENTIALS, headers: { "x-vercel-forwarded-for": "2001:db8:1:2:3:4:5:6" } });
    expect(calls[0].body.p_network).toBe("ipv6:2001:db8:1:2::/64");

    calls = backend();
    await run({ body: CREDENTIALS, socket: { remoteAddress: "::ffff:198.51.100.4" } });
    expect(calls[0].body.p_network).toBe("ipv4:198.51.100.4");

    calls = backend();
    await run({ body: CREDENTIALS, headers: { "x-vercel-forwarded-for": "not-an-address" } });
    expect(calls[0].body.p_network).toBe("unknown");
  });

  it("answers a flat 429 over the limit without contacting GoTrue or recording a failure", async () => {
    const calls = backend({ throttle: false });
    const out = await run({ body: CREDENTIALS });
    expect(out).toEqual({ status: 429, headers: expect.any(Object), body: { error: "try-later" } });
    expect(out.headers["Cache-Control"]).toBe("no-store");
    expect(calls.map((call) => call.url)).toEqual([THROTTLE]);
  });

  it("gives a known and an unknown address the same throttled reply", async () => {
    const replies = [];
    for (const email of ["member@example.com", "nobody-here@example.com"]) {
      backend({ throttle: false });
      replies.push(await run({ body: { email, password: "long-password" } }));
    }
    expect(replies[0]).toEqual(replies[1]);
    // And the route never asks whether an address has an account before deciding.
    const route = readFileSync(new URL("../api/auth-password-signin.js", import.meta.url), "utf8");
    expect(route).not.toMatch(/admin\/users|open_signup_email_available|auth\.users/);
  });

  it("never charges the throttle for a malformed request", async () => {
    const calls = backend();
    const out = await run({ body: { email: "member@example.com", password: "" } });
    expect(out).toMatchObject({ status: 401, body: { error: "sign-in-failed" } });
    expect(calls).toHaveLength(0);
  });

  it.each([
    "!@!." + "!.".repeat(4997) + "!@",
    "a@" + ".".repeat(9996) + " b",
  ])("rejects a 10000-character crafted email within 250ms without network access %#", async (email) => {
    const calls = backend();
    expect(email).toHaveLength(10000);
    const started = performance.now();
    const out = await run({ body: { email, password: "long-password" } });
    expect(performance.now() - started).toBeLessThan(250);
    expect(out).toMatchObject({ status: 401, body: { error: "sign-in-failed" } });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["person+tag@sub.example.com", true], ["a@b.c", true],
    ["a@b..", true], ["a@..b", true],
    ["a".repeat(248) + "@b.com", true],
    ["a".repeat(249) + "@b.com", false],
    ["a@@b.com", false], ["a@b", false], ["a@.b", false],
    ["a@b.", false], ["a b@c.de", false], ["a@b\nc.de", false],
  ])("preserves email validation for %s", async (email, valid) => {
    const calls = backend({ grant: reply({ access_token: "a", refresh_token: "r" }) });
    const out = await run({ body: { email, password: "long-password" } });
    expect(out.status).toBe(valid ? 200 : 401);
    expect(calls.map(call => call.url)).toEqual(valid ? [THROTTLE, GRANT, REFUND] : []);
  });

  it.each(["a", "old123"])("reserves an existing short-password attempt before Auth and refunds its success (%s)", async (password) => {
    const calls = backend({ grant: reply({ access_token: "access", refresh_token: "refresh" }) });
    const out = await run({ body: { email: "member@example.com", password } });
    expect(calls.map((call) => call.url)).toEqual([THROTTLE, GRANT, REFUND]);
    expect(calls[1].body).toEqual({ email: "member@example.com", password });
    expect(calls[2].body).toEqual({ p_reservation: RESERVATION });
    expect(out).toMatchObject({ status: 200, body: { accessToken: "access", refreshToken: "refresh" } });
  });

  it("stops the attempt when the throttle fails or answers something other than a boolean", async () => {
    for (const throttle of [() => reply({ code: "XX000" }, 500), () => { throw new TypeError("network"); }, { allowed: true }, null]) {
      const calls = backend({ throttle });
      const out = await run({ body: CREDENTIALS });
      expect(out).toMatchObject({ status: 503, body: { error: "sign-in-unavailable" } });
      expect(calls.map((call) => call.url)).toEqual([THROTTLE]);
    }
  });

  it("lets the attempt through only while the throttle function is not deployed yet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missing = () => reply({ code: "PGRST202", message: "Could not find the function" }, 404);
    let calls = backend({ throttle: missing, legacy: missing });
    let out = await run({ body: CREDENTIALS });
    expect(out).toMatchObject({ status: 401, body: { error: "sign-in-failed" } });
    expect(calls.map((call) => call.url)).toContain(GRANT);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("password-signin-throttle-unavailable"));
    expect(warn.mock.calls[0][0]).not.toContain("member@example.com");

    calls = backend({ throttle: () => reply({ code: "42883" }, 404) });
    out = await run({ body: CREDENTIALS });
    expect(out).toMatchObject({ status: 503 });
    expect(calls.map((call) => call.url)).toEqual([THROTTLE]);
  });

  it("keeps the legacy limiter active until the reservation migration is installed", async () => {
    const calls = backend({ throttle: () => reply({ code: "PGRST202" }, 404), legacy: false });
    expect(await run({ body: CREDENTIALS })).toMatchObject({ status: 429 });
    expect(calls.map((call) => call.url)).toEqual([THROTTLE, LEGACY]);
  });

  it("returns a successful legacy grant without attempting a receipt refund", async () => {
    const calls = backend({
      throttle: () => reply({ code: "PGRST202" }, 404),
      legacy: true,
      grant: reply({ access_token: "a", refresh_token: "r" }),
    });
    expect(await run({ body: CREDENTIALS })).toMatchObject({
      status: 200, body: { accessToken: "a", refreshToken: "r" },
    });
    expect(calls.map(call => call.url)).toEqual([THROTTLE, LEGACY, GRANT]);
  });

  it("fails closed when the legacy limiter errors or returns a non-boolean", async () => {
    for (const legacy of [() => reply({ code: "XX000" }, 500), () => reply({ code: "42883" }, 404), null, "true"]) {
      const calls = backend({ throttle: () => reply({ code: "PGRST202" }, 404), legacy });
      expect(await run({ body: CREDENTIALS })).toMatchObject({ status: 503, body: { error: "sign-in-unavailable" } });
      expect(calls.map(call => call.url)).toEqual([THROTTLE, LEGACY]);
    }
  });

  it("refuses a malformed reservation before contacting Auth", async () => {
    const calls = backend({ throttle: { allowed: true, reservation: "not-a-receipt" } });
    expect(await run({ body: CREDENTIALS })).toMatchObject({ status: 503, body: { error: "sign-in-unavailable" } });
    expect(calls.map(call => call.url)).toEqual([THROTTLE]);
  });

  it("keeps the charge when the grant cannot be reached or returns an incomplete session", async () => {
    for (const grant of [() => { throw new TypeError("network"); }, reply(null), reply({ access_token: "a" }), reply({ refresh_token: "r" })]) {
      const calls = backend({ grant });
      expect(await run({ body: CREDENTIALS })).toMatchObject({ status: 503, body: { error: "sign-in-unavailable" } });
      expect(calls.map(call => call.url)).toEqual([THROTTLE, GRANT]);
    }
  });

  it("parses JSON request bodies and leaves malformed or empty requests uncharged", async () => {
    const calls = backend({ grant: reply({ access_token: "a", refresh_token: "r" }) });
    expect(await run({ body: JSON.stringify(CREDENTIALS) })).toMatchObject({ status: 200 });
    expect(calls.map(call => call.url)).toEqual([THROTTLE, GRANT, REFUND]);
    for (const body of ["{", undefined, {}]) {
      const malformedCalls = backend();
      expect(await run({ body })).toMatchObject({ status: 401, body: { error: "sign-in-failed" } });
      expect(malformedCalls).toHaveLength(0);
    }
  });

  it.each(["web", "ios", "android"])("refunds successful %s grants but retains failures", async (client) => {
    let calls = backend({ grant: reply({ access_token: "a", refresh_token: "r" }) });
    expect(await run({ body: { ...CREDENTIALS, client } })).toMatchObject({ status: 200 });
    expect(calls.at(-1).url).toBe(REFUND);
    calls = backend();
    expect(await run({ body: { ...CREDENTIALS, client } })).toMatchObject({ status: 401 });
    expect(calls.some(call => call.url === REFUND)).toBe(false);
  });

  it("returns the issued session when refund accounting fails and logs no member data", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const refund of [() => { throw new Error("offline"); }, () => reply({}, 500), null]) {
      backend({ grant: reply({ access_token: "a", refresh_token: "r" }), refund });
      expect(await run({ body: CREDENTIALS })).toMatchObject({ status: 200, body: { accessToken: "a", refreshToken: "r" } });
    }
    expect(warn.mock.calls).toEqual(Array.from({ length: 3 }, () => [JSON.stringify({ event: "password-signin-refund-unavailable" })]));
  });
});

// BUG-UG-SIGNIN-AUTH-REFUSAL-SHOWN-AS-WRONG-PASSWORD-20261003
describe("Supabase Auth refusals", () => {
  it("passes Auth's own rate limit on as try-later and records no failed sign-in", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = backend({ grant: reply({ code: 429, error_code: "over_request_rate_limit", msg: "Request rate limit reached" }, 429) });
    const out = await run({ body: CREDENTIALS });
    expect(out).toMatchObject({ status: 429, body: { error: "try-later" } });
    expect(calls.some((call) => call.url.endsWith("/rpc/record_failed_login_attempt"))).toBe(false);
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: "password-signin-upstream-refused", status: 429, code: "over_request_rate_limit" }));
    expect(warn.mock.calls.flat().join(" ")).not.toContain("member@example.com");
  });

  // An Auth 5xx can be a password-hook failure, which happens only for an
  // existing account, so it must not answer differently from an unknown address.
  it.each([500, 502, 503])("answers an Auth %s with the flat sign-in-failed and records no failed sign-in", async (status) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = backend({ grant: reply({ code: status, msg: "upstream unavailable" }, status) });
    const out = await run({ body: CREDENTIALS });
    expect(out).toMatchObject({ status: 401, body: { error: "sign-in-failed" } });
    expect(calls.some((call) => call.url.endsWith("/rpc/record_failed_login_attempt"))).toBe(false);
  });

  it("still answers a credential refusal as sign-in-failed, records it and logs only its status and code", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = backend({ grant: reply({ code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" }, 400) });
    const out = await run({ body: CREDENTIALS });
    expect(out).toMatchObject({ status: 401, body: { error: "sign-in-failed" } });
    expect(calls.filter((call) => call.url.endsWith("/rpc/record_failed_login_attempt"))).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: "password-signin-upstream-refused", status: 400, code: "invalid_credentials" }));
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).not.toContain("member@example.com");
    expect(logged).not.toContain("long-password");
  });
});

describe("client address forwarding to GoTrue", () => {
  it("keeps the publishable key and sends no forwarded address by default", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_example");
    const calls = backend();
    await run({ body: CREDENTIALS, headers: { "x-vercel-forwarded-for": "203.0.113.9" } });
    const grant = calls.find((call) => call.url === GRANT);
    expect(grant.headers.apikey).toBe("publishable-key");
    expect(grant.headers).not.toHaveProperty("Sb-Forwarded-For");
  });

  it("forwards the end-user address with the secret key once the operator enables it", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_example");
    vi.stubEnv("SUPABASE_AUTH_FORWARD_CLIENT_IP", "1");
    const calls = backend();
    await run({ body: CREDENTIALS, headers: { "x-vercel-forwarded-for": "203.0.113.9, 10.0.0.1" } });
    const grant = calls.find((call) => call.url === GRANT);
    expect(grant.headers.apikey).toBe("sb_secret_example");
    expect(grant.headers["Sb-Forwarded-For"]).toBe("203.0.113.9");
    expect(grant.headers).not.toHaveProperty("Authorization");
  });

  it("does not forward with a legacy service key or without a literal address", async () => {
    vi.stubEnv("SUPABASE_AUTH_FORWARD_CLIENT_IP", "1");
    let calls = backend();
    await run({ body: CREDENTIALS, headers: { "x-vercel-forwarded-for": "203.0.113.9" } });
    expect(calls.find((call) => call.url === GRANT).headers).not.toHaveProperty("Sb-Forwarded-For");

    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_example");
    calls = backend();
    await run({ body: CREDENTIALS, headers: { "x-vercel-forwarded-for": "garbage" } });
    expect(calls.find((call) => call.url === GRANT).headers).not.toHaveProperty("Sb-Forwarded-For");
  });

  it("reads one literal end-user address", () => {
    expect(requestClientAddress({ headers: { "x-vercel-forwarded-for": "[2001:db8::1]" } })).toBe("2001:db8::1");
    expect(requestClientAddress({ headers: {}, socket: { remoteAddress: "fe80::1%eth0" } })).toBe("fe80::1");
    expect(requestClientAddress({ headers: { "x-vercel-forwarded-for": "evil.example" } })).toBeNull();
    expect(requestClientAddress({})).toBeNull();
  });
});

// #6574: Auth's inventory labels come from the grant's User-Agent. The proxy
// used its own fixed name, erasing every browser/device distinction.
it.each([
  ["Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36", /windows/i, /chrome/i],
  ["Mozilla/5.0 (Macintosh) Firefox/130.0", /macintosh/i, /firefox/i],
  ["Mozilla/5.0 (iPhone) Version/18 Safari/605.1", /iphone/i, /safari/i],
])("keeps coarse device and browser labels for %s", async (agent, device, browser) => {
  const calls = backend({ grant: reply({ access_token: "a", refresh_token: "r" }) });
  await run({ body: CREDENTIALS, headers: { "user-agent": agent } });
  const headers = calls.find(call => call.url === GRANT).headers;
  expect(headers["User-Agent"]).toMatch(device);
  expect(headers["User-Agent"]).toMatch(browser);
  expect(headers["User-Agent"]).not.toContain("130.0");
});
