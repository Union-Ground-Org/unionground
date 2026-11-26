// @vitest-environment node
//
// Accounts are invitation-only, but enable_signup = false in
// supabase/config.toml covers only the local stack. A hosted copy that left
// public sign-up on lets anyone with the public key create an account and skip
// the invitation. api/_lib/signupPosture.js reads the project's public Auth
// settings and the deployment refuses its invitation-only surfaces (the
// browser runtime config, sending and accepting invitations) until sign-up is
// off or ALLOW_OPEN_SIGNUP=true says it is intended.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openSignupAllowed,
  resetSignupPostureCache,
  SIGNUP_OPEN_MESSAGE,
  signupPosture,
} from "../api/_lib/signupPosture.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

const DEPLOYED = Object.freeze({ VERCEL: "1", NODE_ENV: "production" });
const BACKEND = Object.freeze({ url: SUPABASE_ORIGIN, publishableKey: "sb_publishable_fixture_key_value" });

function settings(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

beforeEach(() => resetSignupPostureCache());
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("signupPosture", () => {
  beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });

  it("serves when public sign-up and anonymous sign-in are off, asking with the publishable key", async () => {
    const fetchImpl = vi.fn(async () => settings({ disable_signup: true, external: { email: true, anonymous_users: false } }));
    expect(await signupPosture(BACKEND, { env: DEPLOYED, fetchImpl })).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${SUPABASE_ORIGIN}/auth/v1/settings`);
    expect(init.method).toBe("GET");
    expect(init.headers.apikey).toBe(BACKEND.publishableKey);
  });

  it("refuses while public sign-up is on, with a message that tells the operator what to change", async () => {
    const fetchImpl = vi.fn(async () => settings({ disable_signup: false }));
    const result = await signupPosture(BACKEND, { env: DEPLOYED, fetchImpl });
    expect(result).toEqual({ ok: false, reason: "signup-open", message: SIGNUP_OPEN_MESSAGE });
    expect(result.message).toContain("Allow new users to sign up");
    expect(result.message).toContain("ALLOW_OPEN_SIGNUP=true");
  });

  it("refuses while anonymous sign-in is on even with sign-up off", async () => {
    const fetchImpl = vi.fn(async () => settings({ disable_signup: true, external: { anonymous_users: true } }));
    expect(await signupPosture(BACKEND, { env: DEPLOYED, fetchImpl })).toMatchObject({ ok: false, reason: "signup-open" });
  });

  it.each([
    ["a network failure", async () => { throw new Error("offline"); }],
    ["an error status", async () => settings({ message: "nope" }, 401)],
    ["a body without the switch", async () => settings({ external: {} })],
    ["a non-boolean switch", async () => settings({ disable_signup: "true" })],
    ["an unreadable body", async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } })],
  ])("fails closed on %s", async (_label, answer) => {
    const result = await signupPosture(BACKEND, { env: DEPLOYED, fetchImpl: vi.fn(answer) });
    expect(result).toMatchObject({ ok: false, reason: "settings-unreadable" });
  });

  it("does not ask when the operator allows open sign-up on purpose", async () => {
    const fetchImpl = vi.fn();
    expect(openSignupAllowed({ ALLOW_OPEN_SIGNUP: " TRUE " })).toBe(true);
    expect(openSignupAllowed({ ALLOW_OPEN_SIGNUP: "1" })).toBe(false);
    expect(await signupPosture(BACKEND, { env: { ...DEPLOYED, ALLOW_OPEN_SIGNUP: "true" }, fetchImpl })).toEqual({ ok: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not ask on local development, tests or a loopback backend", async () => {
    const fetchImpl = vi.fn();
    expect(await signupPosture(BACKEND, { env: { NODE_ENV: "development" }, fetchImpl })).toEqual({ ok: true });
    expect(await signupPosture(BACKEND, { env: { NODE_ENV: "test" }, fetchImpl })).toEqual({ ok: true });
    expect(await signupPosture(BACKEND, { env: { UNIONGROUND_LOCAL_BACKEND: "1" }, fetchImpl })).toEqual({ ok: true });
    expect(await signupPosture({ url: "http://127.0.0.1:54321" }, { env: DEPLOYED, fetchImpl })).toEqual({ ok: true });
    expect(await signupPosture({ url: "" }, { env: DEPLOYED, fetchImpl })).toEqual({ ok: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    // A deployed function is never local, whatever NODE_ENV says.
    const deployed = vi.fn(async () => settings({ disable_signup: false }));
    expect(await signupPosture(BACKEND, { env: { NODE_ENV: "development", VERCEL: "1" }, fetchImpl: deployed }))
      .toMatchObject({ ok: false });
  });

  it("caches an answer per project: a minute when serving, fifteen seconds when refusing", async () => {
    let clock = 1_000_000;
    const now = () => clock;
    const open = vi.fn(async () => settings({ disable_signup: false }));
    await signupPosture(BACKEND, { env: DEPLOYED, fetchImpl: open, now });
    clock += 14_000;
    await signupPosture(BACKEND, { env: DEPLOYED, fetchImpl: open, now });
    expect(open).toHaveBeenCalledTimes(1);
    clock += 2_000;
    const closed = vi.fn(async () => settings({ disable_signup: true }));
    expect(await signupPosture(BACKEND, { env: DEPLOYED, fetchImpl: closed, now })).toEqual({ ok: true });
    clock += 59_000;
    expect(await signupPosture(BACKEND, { env: DEPLOYED, fetchImpl: closed, now })).toEqual({ ok: true });
    expect(closed).toHaveBeenCalledTimes(1);
    clock += 2_000;
    await signupPosture(BACKEND, { env: DEPLOYED, fetchImpl: closed, now });
    expect(closed).toHaveBeenCalledTimes(2);
  });
});

// The deployed surfaces, with a fictional trusted provider and fetch mocked.
function stubDeployedEnv() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_ORIGIN);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", SUPABASE_REF);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", BACKEND.publishableKey);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-secret-key");
  vi.stubEnv("INVITATION_APP_ORIGIN", PORTAL_ORIGIN);
  vi.stubEnv("INVITATION_RATE_LIMIT_SECRET", "0123456789abcdef".repeat(4));
  vi.stubEnv("RESEND_API_KEY", "resend-key");
  vi.stubEnv("NOTIFY_FROM_ADDRESS", "Union Ground <alerts@example.invalid>");
  // A deployed server says who runs it (api/_lib/operator.js).
  vi.stubEnv("OPERATOR_NAME", "Tamarack Organizing Committee");
  vi.stubEnv("OPERATOR_CONTACT_EMAIL", "help@tamarack.example");
}

function recorder() {
  const out = { status: 0, headers: {}, body: undefined };
  return {
    out,
    setHeader(name, value) { out.headers[name] = value; },
    status(code) { out.status = code; return this; },
    end(body) { out.body = body; },
  };
}

describe("deployed surfaces refuse while sign-up is open", () => {
  let calls;
  function network(disableSignup) {
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/auth/v1/settings")) return settings({ disable_signup: disableSignup });
      return settings({ message: "unexpected" }, 599);
    }));
  }

  beforeEach(() => {
    stubDeployedEnv();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("the browser runtime config answers not configured, naming why", async () => {
    const { default: handler } = await import("../api/runtime-config.js");
    network(false);
    const refused = recorder();
    await handler({ method: "GET", headers: { host: PORTAL_HOST } }, refused);
    expect(refused.out.status).toBe(200);
    expect(refused.out.body).toContain('"configured":false');
    expect(refused.out.body).toContain('"refused":"signup-open"');
    expect(refused.out.body).not.toContain(BACKEND.publishableKey);

    resetSignupPostureCache();
    network(true);
    const served = recorder();
    await handler({ method: "GET", headers: { host: PORTAL_HOST } }, served);
    expect(served.out.body).toContain('"configured":true');
    expect(served.out.body).toContain(BACKEND.publishableKey);
  });

  it("accepting an invitation is refused before any rate-limit charge", async () => {
    const { default: handler } = await import("../api/accept-invitation.js");
    network(false);
    const res = recorder();
    await handler({
      method: "POST",
      url: "/api/accept-invitation",
      headers: { host: PORTAL_HOST, origin: PORTAL_ORIGIN, "x-vercel-forwarded-for": "203.0.113.7" },
      body: { token: "a".repeat(43) },
    }, res);
    expect(res.out.status).toBe(503);
    expect(JSON.parse(res.out.body)).toEqual({ error: "not-configured", reason: "signup-open" });
    expect(calls).toEqual([`${SUPABASE_ORIGIN}/auth/v1/settings`]);
  });

  it("sending an invitation is refused before anything is minted or mailed", async () => {
    const { default: handler } = await import("../api/admin-invitations.js");
    network(false);
    const res = recorder();
    await handler({
      method: "POST",
      url: "/api/admin-invitations",
      headers: { host: PORTAL_HOST, origin: PORTAL_ORIGIN, authorization: "Bearer admin-token" },
      body: { action: "create", email: "new.member@example.invalid" },
    }, res);
    expect(res.out.status).toBe(503);
    expect(JSON.parse(res.out.body)).toEqual({ error: "not-configured", reason: "signup-open" });
    expect(calls).toEqual([`${SUPABASE_ORIGIN}/auth/v1/settings`]);
  });
});

describe("hosted setup documentation", () => {
  it("tells operators to turn public sign-up off on the hosted project", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("Allow new users to sign up");
    expect(readme).toContain("ALLOW_OPEN_SIGNUP");
    const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    expect(example).toMatch(/^# ALLOW_OPEN_SIGNUP=/m);
  });
});
