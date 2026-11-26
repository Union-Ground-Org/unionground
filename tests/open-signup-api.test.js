// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import openSignup, { signupTiming } from "../api/open-signup.js";
import openSignupConfirm from "../api/open-signup-confirm.js";
import { resetAccountMailAlerts } from "../api/_lib/accountMailAlerts.js";
import { legalReleaseIO } from "../api/_lib/legalReleaseGate.js";
import { mintSignupToken, signupKeys } from "../api/_lib/openSignup.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SAMPLE_HOST, SUPABASE_ORIGIN } from "./helpers/fictional-provider.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
import { pinnedSampleSupabaseOrigin } from "../src/lib/sampleBackend.js";

const SECRET = "open-signup-secret-at-least-32-characters";
const SUPABASE = SUPABASE_ORIGIN;
const EMAIL = "person@example.invalid";

function recorder() {
  const out = { status: 0, headers: {}, body: null, raw: "" };
  return {
    out,
    status(code) { out.status = code; return this; },
    setHeader(name, value) { out.headers[name] = value; },
    end(body) { out.raw = body || ""; out.body = body ? JSON.parse(body) : null; },
  };
}

async function run(handler, { method = "POST", host = PORTAL_HOST, origin = `https://${host}`, body, ip = "203.0.113.7" } = {}) {
  const res = recorder();
  const headers = { host, "content-type": "application/json" };
  if (origin) headers.origin = origin;
  if (ip) headers["x-vercel-forwarded-for"] = ip;
  await handler({ method, url: "/api/x", headers, body }, res);
  return res.out;
}

function respond(status, body) {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(text),
  };
}

// One programmable backend. Every call is recorded so each test can assert
// exactly which services a branch reached.
function backend(overrides = {}) {
  const state = {
    turnstile: { success: true, hostname: PORTAL_HOST, action: "open-signup" },
    turnstileStatus: 200,
    turnstileError: null,
    limits: {},
    available: true,
    intake: { open: true },
    resend: 200,
    createUser: [200, { id: "10000000-0000-4000-8000-000000000001" }],
    rpcFailure: null,
    // REQ-UG-PUBLIC-SIGNUP-OWNER-SWITCH-20261003: the owner's switch. It
    // ships off; these route tests exercise the open state unless they say so.
    switchOpen: true,
    recoveryReady: true,
    coverageActive: true,
    legalPackReady: true,
    ...overrides,
  };
  const calls = [];
  const alerts = [];
  const switchReads = [];
  const packReadyReads = [];
  const fetchMock = vi.fn(async (url, init = {}) => {
    const target = String(url);
    const body = init.body && !String(init.body).startsWith("secret=") ? JSON.parse(init.body) : init.body;
    // The switch read precedes every other check; it is recorded apart so the
    // remaining call order stays the route's own.
    if (target.endsWith("/rest/v1/rpc/open_signup_switch_open")) {
      switchReads.push({ url: target, body, headers: init.headers });
      if (state.rpcFailure?.open_signup_switch_open) return respond(...state.rpcFailure.open_signup_switch_open);
      return respond(200, state.switchOpen);
    }
    if (target.endsWith("/rest/v1/rpc/open_signup_recovery_ready")) {
      if (state.rpcFailure?.open_signup_recovery_ready) return respond(...state.rpcFailure.open_signup_recovery_ready);
      return respond(200, state.recoveryReady);
    }
    if (target.endsWith("/rest/v1/rpc/open_signup_coverage_active")) {
      if (state.rpcFailure?.open_signup_coverage_active) return respond(...state.rpcFailure.open_signup_coverage_active);
      return respond(200, state.coverageActive);
    }
    if (target.endsWith("/rest/v1/rpc/open_signup_intake_status")) {
      if (state.rpcFailure?.open_signup_intake_status) return respond(...state.rpcFailure.open_signup_intake_status);
      return respond(200, state.intake);
    }
    // The released-pack probe runs only when the stamp names a release, so it
    // is recorded apart too and the route's order holds under either stamp.
    if (target.endsWith("/rest/v1/rpc/legal_acceptance_pack_ready")) {
      packReadyReads.push({ url: target, body, headers: init.headers });
      if (state.rpcFailure?.legal_acceptance_pack_ready) return respond(...state.rpcFailure.legal_acceptance_pack_ready);
      return respond(200, state.legalPackReady);
    }
    // The private ug-alerts post runs after the answer; it is recorded apart.
    if (target.startsWith("https://hooks.slack.com/")) {
      alerts.push(body);
      return respond(200, {});
    }
    calls.push({ url: target, body, headers: init.headers });
    if (target.includes("challenges.cloudflare.com")) {
      if (state.turnstileError) throw state.turnstileError;
      return respond(state.turnstileStatus, state.turnstile);
    }
    if (target.includes("/rest/v1/rpc/")) {
      const name = target.split("/rest/v1/rpc/")[1];
      if (state.rpcFailure?.[name]) return respond(...state.rpcFailure[name]);
      if (name === "consume_open_signup_limit") return respond(200, state.limits[body.p_operation] ?? true);
      if (name === "open_signup_email_available") return respond(200, state.available);
    }
    if (target === "https://api.resend.com/emails") return respond(state.resend, { id: "email" });
    if (target === `${SUPABASE}/auth/v1/admin/users`) return respond(...state.createUser);
    throw new Error(`unexpected fetch ${target}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { alerts, calls, fetchMock, packReadyReads, state, switchReads };
}

const signupBody = {
  email: EMAIL, locale: "en", turnstileToken: "turnstile-token", acceptedTerms: true, residenceState: "OH", ageAttested: true, website: "",
};

// Order: Turnstile, both network windows, the email window, availability.
function expectSignupOrder(calls) {
  expect(calls.map((call) => call.url.split("/").pop())).toEqual([
    "siteverify", "consume_open_signup_limit", "consume_open_signup_limit", "consume_open_signup_limit",
    "open_signup_email_available", "emails",
  ]);
  expect(calls.slice(1, 4).map((call) => call.body.p_operation)).toEqual(["network-hour", "network-day", "email-day"]);
  for (const call of calls.slice(1, 5)) expect(JSON.stringify(call.body)).not.toContain(EMAIL);
}

// The last column is the route's own call count; the released-pack probe is
// recorded apart and runs once whenever Turnstile passed.
const silent = [
  ["the honeypot is filled", {}, { ...signupBody, website: "https://spam.example.invalid" }, 0],
  ["the email is malformed", {}, { ...signupBody, email: "not-an-email" }, 0],
  ["the email is longer than 254 characters", {}, { ...signupBody, email: `${"a".repeat(250)}@x.io` }, 0],
  ["Turnstile fails", { turnstile: { success: false } }, signupBody, 1],
  ["Turnstile names another host", { turnstile: { success: true, hostname: "x.vercel.app", action: "open-signup" } }, signupBody, 1],
  ["the hourly network limit is spent", { limits: { "network-hour": false } }, signupBody, 2],
  ["the daily network limit is spent", { limits: { "network-day": false } }, signupBody, 3],
  ["the email limit is spent", { limits: { "email-day": false } }, signupBody, 4],
  ["the address already has an account or pending invitation", { available: false }, signupBody, 5],
];

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "psgfictionalproject");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-secret-key");
  vi.stubEnv("INVITATION_APP_ORIGIN", PORTAL_ORIGIN);
  vi.stubEnv("RESEND_API_KEY", "resend-key");
  vi.stubEnv("NOTIFY_FROM_ADDRESS", "Union Ground <alerts@example.invalid>");
  vi.stubEnv("OPEN_SIGNUP_SECRET", SECRET);
  vi.stubEnv("TURNSTILE_SECRET_KEY", "turnstile-secret");
  vi.stubEnv("UG_ALERTS_SLACK_WEBHOOK_URL", "");
  resetAccountMailAlerts();
  // No test really waits out the timing floor.
  vi.spyOn(signupTiming, "sleep").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.each([
  ["open-signup", openSignup],
  ["open-signup-confirm", openSignupConfirm],
])("%s shared gates", (_name, handler) => {
  it("refuses a method other than POST (or the status GET)", async () => {
    const { calls } = backend();
    const out = await run(handler, { method: "PUT" });
    expect(out.status).toBe(405);
    expect(calls).toEqual([]);
  });

  it("refuses a cross-site origin before any work, the switch read included", async () => {
    const { calls, switchReads } = backend();
    const out = await run(handler, { origin: "https://attacker.example.invalid", body: {} });
    expect(out).toMatchObject({ status: 403, body: { error: "not-permitted" } });
    expect(calls).toEqual([]);
    expect(switchReads).toEqual([]);
  });

  // Union Ground trusts only a paired portal origin (and loopback outside
  // production): the demo host and a Vercel preview are refused at the origin
  // gate, before any route work; localhost still reaches the route and finds
  // no open-signup there.
  it.each([
    ["the demo host", SAMPLE_HOST, 403, "not-permitted"],
    ["a Vercel preview", "feature-git-branch.vercel.app", 403, "not-permitted"],
    ["localhost", "localhost", 404, "not-found"],
  ])("answers %s without reaching any backend", async (_label, host, status, error) => {
    vi.stubEnv("VERCEL_URL", host);
    const { fetchMock } = backend();
    const out = await run(handler, { host, origin: host === "localhost" ? "http://localhost" : `https://${host}`, body: signupBody });
    expect(out).toMatchObject({ status, body: { error } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["OPEN_SIGNUP_SECRET", "TURNSTILE_SECRET_KEY", "RESEND_API_KEY", "INVITATION_APP_ORIGIN"])(
    "answers 503 when %s is missing", async (name) => {
      vi.stubEnv(name, "");
      const { calls } = backend();
      const out = await run(handler, { body: signupBody });
      expect(out).toMatchObject({ status: 503, body: { error: "signup-unavailable" } });
      expect(calls).toEqual([]);
    },
  );

  it("answers as a missing route when the service key is missing, since the switch cannot be read", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const { fetchMock } = backend();
    expect(await run(handler, { body: signupBody })).toMatchObject({ status: 404, body: { error: "not-found" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([pinnedSampleSupabaseOrigin(), "http://project.supabase.co", "not-a-url", `${SUPABASE}/path`])(
    "never reads the switch or creates accounts on the invalid backend %s", async (url) => {
      vi.stubEnv("VITE_SUPABASE_URL", url);
      const { fetchMock } = backend();
      expect(await run(handler, { body: signupBody })).toMatchObject({ status: 404, body: { error: "not-found" } });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("answers 503 when the secret is still the .env.example placeholder", async () => {
    vi.stubEnv("OPEN_SIGNUP_SECRET", "replace-with-at-least-32-random-characters");
    const { calls } = backend();
    expect(await run(handler, { body: signupBody })).toMatchObject({ status: 503, body: { error: "signup-unavailable" } });
    expect(calls).toEqual([]);
  });

  it("answers 503 for a secret shorter than 32 characters", async () => {
    vi.stubEnv("OPEN_SIGNUP_SECRET", "short");
    backend();
    expect((await run(handler, { body: signupBody })).status).toBe(503);
  });
});

// REQ-UG-PUBLIC-SIGNUP-OWNER-SWITCH-20261003: while the owner's switch is
// off (its shipped state) both routes answer exactly as a missing route, for
// every same-origin method, and reach nothing but the switch read. The shared
// Origin boundary still runs first, so a cross-site POST gets the same 403
// either way and learns nothing about the switch.
describe.each([
  ["open-signup", openSignup],
  ["open-signup-confirm", openSignupConfirm],
])("%s while the owner's switch is off", (_name, handler) => {
  it.each(["POST", "GET", "PUT"])("answers %s as a missing route", async (method) => {
    const { calls, switchReads } = backend({ switchOpen: false });
    const out = await run(handler, { method, body: signupBody });
    expect(out).toMatchObject({ status: 404, body: { error: "not-found" } });
    expect(calls).toEqual([]);
    expect(switchReads).toHaveLength(1);
    expect(switchReads[0].headers).toMatchObject({ apikey: "server-secret-key" });
  });

  it("refuses a cross-site POST with the same 403 whether or not the switch is open, without reading it", async () => {
    const { calls, switchReads } = backend({ switchOpen: false });
    const out = await run(handler, { origin: "https://attacker.example.invalid", body: signupBody });
    expect(out).toMatchObject({ status: 403, body: { error: "not-permitted" } });
    expect(calls).toEqual([]);
    expect(switchReads).toEqual([]);
  });

  it("treats an unreadable switch, such as a database without the function, as off", async () => {
    const { calls } = backend({ rpcFailure: { open_signup_switch_open: [404, { code: "PGRST202" }] } });
    expect(await run(handler, { body: signupBody })).toMatchObject({ status: 404, body: { error: "not-found" } });
    expect(calls).toEqual([]);
  });

  it("treats anything but true as off", async () => {
    for (const value of [false, null, "true", 1, {}]) {
      const { calls } = backend({ switchOpen: value });
      expect((await run(handler, { body: signupBody })).status).toBe(404);
      expect(calls).toEqual([]);
    }
  });
});

describe("GET /api/open-signup (the browser's switch status)", () => {
  it("reports open only while the switch is on and the routes are configured", async () => {
    backend();
    const open = await run(openSignup, { method: "GET", origin: "" });
    expect(open).toMatchObject({ status: 200, body: { open: true } });
    expect(open.headers["Cache-Control"]).toBe("no-store");
    vi.stubEnv("OPEN_SIGNUP_SECRET", "");
    backend();
    expect(await run(openSignup, { method: "GET", origin: "" })).toMatchObject({ status: 200, body: { open: false } });
  });
});

describe.each([["request", openSignup], ["confirmation", openSignupConfirm]])("%s production recovery prerequisite", (_name, handler) => {
  it.each([false, null, "true", 1, {}])("rejects unverified recovery value %j before any other work", async (recoveryReady) => {
    const { calls } = backend({ recoveryReady });
    expect(await run(handler, { body: signupBody })).toMatchObject({ status: 404, body: { error: "not-found" } });
    expect(calls).toEqual([]);
  });
  it("fails closed when the recovery migration is absent or unreadable", async () => {
    const { calls } = backend({ rpcFailure: { open_signup_recovery_ready: [404, { code: "PGRST202" }] } });
    expect((await run(handler, { body: signupBody })).status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe.each([["request", openSignup], ["confirmation", openSignupConfirm]])("%s operator coverage prerequisite", (_name, handler) => {
  it.each([false, null, "true", 1, {}])("rejects coverage value %j before any other work", async (coverageActive) => {
    const { calls } = backend({ coverageActive });
    expect(await run(handler, { body: signupBody })).toMatchObject({ status: 404, body: { error: "not-found" } });
    expect(calls).toEqual([]);
  });
  it("fails closed when the coverage migration is absent or unreadable", async () => {
    const { calls } = backend({ rpcFailure: { open_signup_coverage_active: [404, { code: "PGRST202" }] } });
    expect((await run(handler, { body: signupBody })).status).toBe(404);
    expect(calls).toEqual([]);
  });
});

it("does not advertise signup outside operator coverage", async () => {
  backend({ coverageActive: false });
  expect(await run(openSignup, { method: "GET", origin: "" })).toMatchObject({ status: 404, body: { error: "not-found" } });
});

it("does not advertise signup while production recovery is unverified", async () => {
  backend({ recoveryReady: false });
  expect(await run(openSignup, { method: "GET", origin: "" })).toMatchObject({ status: 404, body: { error: "not-found" } });
});

describe("POST /api/open-signup", () => {
  // REQ-UG-BLOCK-GOVERNMENT-AND-EMPLOYER-EMAIL-DOMAINS-20261102: the
  // answer depends only on the domain, so it is refused openly, before
  // Turnstile or any limit is spent.
  it.each(["person@agency.gov", "person@army.mil", "person@dot.state.ny.us", "Person@Example.GOV.UK"])(
    "refuses the government address %s with email-domain-blocked before any check", async (email) => {
      const { calls } = backend();
      expect(await run(openSignup, { body: { ...signupBody, email } }))
        .toMatchObject({ status: 400, body: { error: "email-domain-blocked" } });
      expect(calls).toEqual([]);
    },
  );

  it("refuses malformed JSON and a missing terms acceptance with invalid-request", async () => {
    const { calls } = backend();
    expect(await run(openSignup, { body: "{" })).toMatchObject({ status: 400, body: { error: "invalid-request" } });
    expect(await run(openSignup, { body: { ...signupBody, acceptedTerms: "yes" } }))
      .toMatchObject({ status: 400, body: { error: "invalid-request" } });
    expect(calls).toEqual([]);
  });

  // The request needs a listed state and
  // the age attestation it selects as well as the terms.
  it.each([undefined, false, "yes"])("refuses a signup whose age attestation is %s before any check", async (ageAttested) => {
    const { calls } = backend();
    const body = { ...signupBody, ageAttested };
    if (ageAttested === undefined) delete body.ageAttested;
    expect(await run(openSignup, { body })).toMatchObject({ status: 400, body: { error: "invalid-request" } });
    expect(calls).toEqual([]);
  });

  it.each([undefined, "", "ZZ", "oh"])("refuses a signup whose state is %s before any check", async (residenceState) => {
    const { calls } = backend();
    const body = { ...signupBody, residenceState };
    if (residenceState === undefined) delete body.residenceState;
    expect(await run(openSignup, { body })).toMatchObject({ status: 400, body: { error: "invalid-request" } });
    expect(calls).toEqual([]);
  });

  it("refuses the October 12 adult-only body, which names no state", async () => {
    const { calls } = backend();
    const { residenceState: _state, ageAttested: _age, ...rest } = signupBody;
    expect(await run(openSignup, { body: { ...rest, adultAttested: true } }))
      .toMatchObject({ status: 400, body: { error: "invalid-request" } });
    expect(calls).toEqual([]);
  });

  it("sends exactly one email whose link is a #token fragment on success", async () => {
    const { calls } = backend();
    const out = await run(openSignup, { body: signupBody });
    expect(out).toMatchObject({ status: 200, body: { accepted: true } });
    expect(out.headers["Referrer-Policy"]).toBe("no-referrer");
    const sends = calls.filter((call) => call.url === "https://api.resend.com/emails");
    expect(sends).toHaveLength(1);
    expect(sends[0].body.to).toEqual([EMAIL]);
    expect(sends[0].body.text).toMatch(new RegExp(`${PORTAL_ORIGIN.replace(/[.]/g, "\\.")}/signup/confirm#token=v1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+`));
    expect(sends[0].body.text).not.toContain("?");
    expect(sends[0].headers["Idempotency-Key"]).toMatch(/^ug-signup-[0-9a-f]{24}$/);
    expectSignupOrder(calls);
  });

  it("uses a Spanish email for a Spanish request", async () => {
    const { calls } = backend();
    await run(openSignup, { body: { ...signupBody, locale: "es" } });
    expect(calls.find((call) => call.url.includes("resend")).body.subject).toBe("Confirma tu correo para Union Ground");
  });

  it.each(silent)("answers the same 200 and sends nothing when %s", async (_label, state, body, callCount) => {
    const { calls } = backend(state);
    const out = await run(openSignup, { body });
    expect(out.status).toBe(200);
    expect(out.raw).toBe(JSON.stringify({ accepted: true }));
    expect(calls).toHaveLength(callCount);
    expect(calls.some((call) => call.url.includes("resend"))).toBe(false);
  });

  it("holds the existing-account branch and the send branch to the same timing floor", async () => {
    let clock = 1_000;
    vi.spyOn(signupTiming, "now").mockImplementation(() => clock);
    const waits = [];
    signupTiming.sleep.mockImplementation(async (ms) => { waits.push(ms); });
    // Existing account: the backend answers instantly (clock does not move).
    backend({ available: false });
    await run(openSignup, { body: signupBody });
    // Send: the email provider takes 400 ms.
    const { fetchMock } = backend();
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).includes("resend")) clock += 400;
      return original(url, init);
    });
    await run(openSignup, { body: signupBody });
    expect(waits).toEqual([signupTiming.floorMs, signupTiming.floorMs - 400]);
    expect(signupTiming.floorMs).toBe(1500);
  });

  it("does not add a wait once the floor has already passed, or before Turnstile passes", async () => {
    let clock = 0;
    vi.spyOn(signupTiming, "now").mockImplementation(() => clock);
    const { fetchMock } = backend();
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).includes("resend")) clock += 2_000;
      return original(url, init);
    });
    await run(openSignup, { body: signupBody });
    backend({ turnstile: { success: false } });
    await run(openSignup, { body: signupBody });
    expect(signupTiming.sleep).not.toHaveBeenCalled();
  });

  it("uses a real clock and timer by default", async () => {
    signupTiming.sleep.mockRestore();
    const before = Date.now();
    await signupTiming.sleep(1);
    expect(signupTiming.now()).toBeGreaterThanOrEqual(before);
  });

  it("answers the same 200, byte for byte, when the email provider fails", async () => {
    backend();
    const sent = await run(openSignup, { body: signupBody });
    backend({ resend: 500 });
    const out = await run(openSignup, { body: signupBody });
    expect(out.raw).toBe(JSON.stringify({ accepted: true }));
    expect(out).toEqual(sent);
  });

  it("answers the same 200 without a network bucket", async () => {
    const { calls } = backend();
    const out = await run(openSignup, { body: signupBody, ip: "" });
    expect(out.raw).toBe(JSON.stringify({ accepted: true }));
    expect(calls.map((call) => call.url.split("/").pop())).toEqual(["siteverify"]);
  });

  it("fails closed with signup-unavailable while the limiter function is missing", async () => {
    backend({ rpcFailure: { consume_open_signup_limit: [404, { code: "PGRST202" }] } });
    const out = await run(openSignup, { body: signupBody });
    expect(out).toMatchObject({ status: 503, body: { error: "signup-unavailable" } });
  });

  it("sends no mail when the legal release files are missing", async () => {
    const empty = mkdtempSync(join(tmpdir(), "legal-signup-"));
    const root = vi.spyOn(legalReleaseIO, "root").mockReturnValue(empty);
    try {
      const { calls } = backend();
      expect(await run(openSignup, { body: signupBody })).toMatchObject({ status: 503, body: { error: "signup-unavailable" } });
      expect(calls.some((call) => call.url.includes("resend.com"))).toBe(false);
    } finally {
      root.mockRestore();
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("fails closed when the availability check is unavailable", async () => {
    const { calls } = backend({ rpcFailure: { open_signup_email_available: [500, { code: "XX000" }] } });
    const out = await run(openSignup, { body: signupBody });
    expect(out).toMatchObject({ status: 503, body: { error: "signup-unavailable" } });
    expect(calls.some((call) => call.url.includes("resend"))).toBe(false);
  });

  it("logs nothing on any silent branch or on success", async () => {
    const spies = ["log", "info", "warn", "error"].map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    for (const [, state, body] of silent) {
      backend(state);
      await run(openSignup, { body });
    }
    backend();
    await run(openSignup, { body: signupBody });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

// REQ-UG-SIGNUP-AND-ACCOUNT-MAIL-FAILURES-RAISE-NO-PRIVATE-ALERT-20261111:
// a failed confirmation send and an unavailable Turnstile check are recorded
// privately, with one throttled ug-alerts post, and the visitor's answer and
// its timing stay exactly what they are for success or a refused token.
describe("POST /api/open-signup private failure signals", () => {
  const WEBHOOK = "https://hooks.slack.com/services/T000/B000/synthetic";
  const line = (kind, count) => JSON.stringify({ event: "account-mail-failure", kind, count });

  it("records one content-free line for a failed confirmation send and posts one metadata-only alert", async () => {
    vi.stubEnv("UG_ALERTS_SLACK_WEBHOOK_URL", WEBHOOK);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { alerts } = backend({ resend: 500 });
    const out = await run(openSignup, { body: signupBody });
    expect(out).toMatchObject({ status: 200, raw: JSON.stringify({ accepted: true }) });
    expect(warn.mock.calls).toEqual([[line("signup_confirmation_send_failed", 1)]]);
    await vi.waitFor(() => expect(alerts).toHaveLength(1));
    expect(alerts[0].text).toContain("kind: signup_confirmation_send_failed");
    for (const value of [EMAIL, "turnstile-token", "#token=", "resend-key", "203.0.113"]) {
      expect(JSON.stringify(alerts[0])).not.toContain(value);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(value);
    }
    // A sustained failure: the second event is counted, not posted again.
    await run(openSignup, { body: signupBody });
    expect(warn.mock.calls.at(-1)).toEqual([line("signup_confirmation_send_failed", 2)]);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(alerts).toHaveLength(1);
  });

  it.each([
    ["an HTTP error", { turnstileStatus: 503 }],
    ["a transport error", { turnstileError: new Error("connect ETIMEDOUT") }],
    ["a malformed answer", { turnstile: null }],
    ["Cloudflare's internal error", { turnstile: { success: false, "error-codes": ["internal-error"] } }],
    ["a refused site secret", { turnstile: { success: false, "error-codes": ["invalid-input-secret"] } }],
  ])("records an unavailable Turnstile check on %s and answers as for a refused token", async (_label, state) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    backend({ turnstile: { success: false, "error-codes": ["invalid-input-response"] } });
    const refused = await run(openSignup, { body: signupBody });
    expect(warn).not.toHaveBeenCalled();
    const { calls } = backend(state);
    const out = await run(openSignup, { body: signupBody });
    expect(out).toEqual(refused);
    expect(out.raw).toBe(JSON.stringify({ accepted: true }));
    expect(calls.map((call) => call.url.split("/").pop())).toEqual(["siteverify"]);
    expect(warn.mock.calls).toEqual([[line("signup_turnstile_unavailable", 1)]]);
    expect(signupTiming.sleep).not.toHaveBeenCalled();
  });

  it("keeps the send branch's timing floor when the send fails", async () => {
    let clock = 1_000;
    vi.spyOn(signupTiming, "now").mockImplementation(() => clock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const waits = [];
    signupTiming.sleep.mockImplementation(async (ms) => { waits.push(ms); });
    const { fetchMock } = backend({ resend: 500 });
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).includes("resend")) clock += 400;
      return original(url, init);
    });
    await run(openSignup, { body: signupBody });
    expect(waits).toEqual([signupTiming.floorMs - 400]);
  });
});

describe("POST /api/open-signup-confirm", () => {
  const keys = signupKeys(SECRET);
  const token = (residenceState = "UT") => mintSignupToken(keys, { email: EMAIL, locale: "en", termsVersion: "2026-09-22", residenceState });
  const confirmBody = (overrides = {}) => ({ token: token(), password: "a-long-enough-password-for-policy", locale: "en", ...overrides });

  it("creates the account with empty user metadata and the accepted terms in app metadata", async () => {
    const { calls } = backend();
    const out = await run(openSignupConfirm, {
      body: confirmBody({ user_metadata: { chapter_id: "ewl-orphan" }, chapter_id: "ewl-orphan", union_base_invitation_id: "x" }),
    });
    expect(out).toMatchObject({ status: 200, body: { accepted: true, email: EMAIL } });
    const create = calls.find((call) => call.url.endsWith("/auth/v1/admin/users"));
    expect(create.body).toMatchObject({
      email: EMAIL,
      password: "a-long-enough-password-for-policy",
      email_confirm: true,
      user_metadata: {},
      app_metadata: {
        union_ground_provisioning: "active",
        union_ground_signup: "self_serve",
        union_ground_terms_version: "2026-09-22",
      },
    });
    expect(Number.isNaN(Date.parse(create.body.app_metadata.union_ground_terms_accepted_at))).toBe(false);
    // The state and the age attestation taken on the signup form, recorded
    // where only the service role can write.
    expect(create.body.app_metadata).toMatchObject({
      union_ground_residence_state: "UT",
      union_ground_age_attestation: "adult",
    });
    expect(create.body.app_metadata).not.toHaveProperty("union_ground_adult_attested_at");
    expect(Number.isNaN(Date.parse(create.body.app_metadata.union_ground_age_attested_at))).toBe(false);
    expect(calls[0].body.p_operation).toBe("confirm-network-hour");
  });

  it("records the D-03 B band for a state outside the app-store age-law states", async () => {
    const { calls } = backend();
    expect(await run(openSignupConfirm, { body: confirmBody({ token: token("NY") }) }))
      .toMatchObject({ status: 200, body: { accepted: true } });
    const create = calls.find((call) => call.url.endsWith("/auth/v1/admin/users"));
    expect(create.body.app_metadata).toMatchObject({
      union_ground_residence_state: "NY",
      union_ground_age_attestation: "band",
    });
  });

  it("refuses more than the hourly confirm limit with rate-limited", async () => {
    backend({ limits: { "confirm-network-hour": false } });
    expect(await run(openSignupConfirm, { body: confirmBody() }))
      .toMatchObject({ status: 429, body: { error: "rate-limited" } });
  });

  it("answers 503 when the limiter is missing", async () => {
    backend({ rpcFailure: { consume_open_signup_limit: [404, { code: "PGRST202" }] } });
    expect((await run(openSignupConfirm, { body: confirmBody() })).status).toBe(503);
  });

  it("refuses a malformed body or a request without a network bucket", async () => {
    backend();
    expect(await run(openSignupConfirm, { body: "{" })).toMatchObject({ status: 400, body: { error: "invalid-request" } });
    expect(await run(openSignupConfirm, { body: confirmBody(), ip: "" })).toMatchObject({ status: 400 });
  });

  it("refuses a tampered, foreign or expired token as link-invalid", async () => {
    const { calls } = backend();
    const good = token();
    const tampered = `${good.slice(0, -2)}${good.endsWith("AA") ? "BB" : "AA"}`;
    const foreign = mintSignupToken(signupKeys("another-secret-that-is-long-enough-000"), { email: EMAIL, locale: "en", residenceState: "UT" });
    const expired = mintSignupToken(keys, { email: EMAIL, locale: "en", residenceState: "UT" }, Date.now() - 31 * 60 * 1000);
    const stateless = mintSignupToken(keys, { email: EMAIL, locale: "en" });
    for (const value of [tampered, foreign, expired, stateless, "", 42]) {
      expect(await run(openSignupConfirm, { body: confirmBody({ token: value }) }))
        .toMatchObject({ status: 400, body: { error: "link-invalid" } });
    }
    expect(calls.some((call) => call.url.includes("/auth/v1/admin/users"))).toBe(false);
  });

  it.each([["short", "x".repeat(11)], ["long", "x".repeat(257)], ["missing", undefined]])(
    "refuses a %s password as password-rejected", async (_label, password) => {
      backend();
      expect(await run(openSignupConfirm, { body: confirmBody({ password }) }))
        .toMatchObject({ status: 400, body: { error: "password-rejected" } });
    },
  );

  it("refuses a link minted for a government address and creates nothing", async () => {
    const { calls } = backend();
    const govToken = mintSignupToken(keys, { email: "person@agency.gov", locale: "en", termsVersion: "2026-09-22", residenceState: "UT" });
    expect(await run(openSignupConfirm, { body: confirmBody({ token: govToken }) }))
      .toMatchObject({ status: 400, body: { error: "email-domain-blocked" } });
    expect(calls.some((call) => call.url.includes("/auth/v1/admin/users"))).toBe(false);
  });

  it("treats an address that already has an account as a used link", async () => {
    const { calls } = backend({ available: false });
    expect(await run(openSignupConfirm, { body: confirmBody() }))
      .toMatchObject({ status: 400, body: { error: "link-invalid" } });
    expect(calls.some((call) => call.url.includes("/auth/v1/admin/users"))).toBe(false);
  });

  it("answers 503 when the availability check fails", async () => {
    backend({ rpcFailure: { open_signup_email_available: [500, {}] } });
    expect((await run(openSignupConfirm, { body: confirmBody() })).status).toBe(503);
  });

  it.each([
    ["an existing account (race)", [422, { error_code: "email_exists", msg: "A user with this email address has already been registered" }], 400, "link-invalid"],
    ["an existing account (message only)", [422, { msg: "User already registered" }], 400, "link-invalid"],
    ["a weak password", [422, { error_code: "weak_password", msg: "Password is known to be weak" }], 400, "password-rejected"],
    ["another GoTrue failure", [500, { msg: "boom" }], 503, "signup-unavailable"],
    ["an unreadable GoTrue failure", [502, undefined], 503, "signup-unavailable"],
  ])("maps %s", async (_label, createUser, status, error) => {
    backend({ createUser });
    expect(await run(openSignupConfirm, { body: confirmBody() })).toMatchObject({ status, body: { error } });
  });

  it("creates nothing when the legal release files are missing", async () => {
    const empty = mkdtempSync(join(tmpdir(), "legal-signup-"));
    const root = vi.spyOn(legalReleaseIO, "root").mockReturnValue(empty);
    try {
      const { calls } = backend();
      expect(await run(openSignupConfirm, { body: confirmBody() }))
        .toMatchObject({ status: 503, body: { error: "signup-unavailable" } });
      expect(calls.some((call) => call.url.endsWith("/auth/v1/admin/users"))).toBe(false);
    } finally {
      root.mockRestore();
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("answers 503 when GoTrue cannot be reached", async () => {
    const { fetchMock } = backend();
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/auth/v1/admin/users")) throw new Error("network");
      return original(url, init);
    });
    expect(await run(openSignupConfirm, { body: confirmBody() })).toMatchObject({ status: 503, body: { error: "signup-unavailable" } });
  });
});


describe("public signup intake refusal", () => {
  it("keeps first-run eligibility while new intake is full", async () => {
    backend({ intake: { open: false } });
    expect(await run(openSignup, { method: "GET" })).toMatchObject({ status: 200, body: { open: true } });
  });
  const confirmBody = () => ({ token: mintSignupToken(signupKeys(SECRET), { email: EMAIL, locale: "en", termsVersion: "2026-09-22", residenceState: "UT" }), password: "a-long-enough-password-for-policy", locale: "en" });
  it.each([{ open: false }, { status: "unavailable" }, null, {}])("keeps request responses generic and sends no mail for %j", async (intake) => {
    const { calls } = backend({ intake });
    expect(await run(openSignup, { body: signupBody })).toMatchObject({ status: 200, body: { accepted: true } });
    expect(calls.some((call) => call.url.includes("resend.com"))).toBe(false);
  });
  it.each([{ open: false }, { status: "unavailable" }, null, {}])("creates no account and exposes no capacity detail for %j", async (intake) => {
    const { calls } = backend({ intake });
    expect(await run(openSignupConfirm, { body: confirmBody() })).toMatchObject({ status: 503, body: { error: "signup-unavailable" } });
    expect(calls.some((call) => call.url.endsWith("/auth/v1/admin/users"))).toBe(false);
  });
  it("fails closed when the intake RPC migration is unavailable", async () => {
    const { calls } = backend({ rpcFailure: { open_signup_intake_status: [404, { code: "PGRST202" }] } });
    expect(await run(openSignupConfirm, { body: confirmBody() })).toMatchObject({ status: 503, body: { error: "signup-unavailable" } });
    expect(calls.some((call) => call.url.endsWith("/auth/v1/admin/users"))).toBe(false);
  });
});

// No "released legal bundle signup readiness" cases: this edition publishes no
// operative instrument text (its legal release stamp stays release: null), so
// a real release cannot be cut from the tree; the unreleased paths are above.
