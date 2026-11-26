// @vitest-environment node
import { createHash, generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants as http2Constants } from "node:http2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pushMock = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  setVapidDetails: vi.fn(),
}));
vi.mock("web-push", () => ({ default: pushMock }));

import handler, { DISPATCH_BUDGETS, TEMPLATES, PUSH_SENSITIVE_KINDS, assertLeases, createApnsHeaders, createApnsJwt, createFcmAssertion, idempotencyKey, nativeInstallationAllowed, pushEndpointAllowed, pushTemplateFor, sendOneApns, templateFor } from "../api/notifications-dispatch.js";
import { siblingIdentityIn } from "../scripts/lib/sibling-deny-list.mjs";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

const SUPABASE_URL = "https://project.supabase.co";
// Assembled rather than written out so a scanner cannot mistake a fixture for a
// real credential. At least CRON_SECRET_MIN_LENGTH (32) characters: the
// dispatcher shares the intake and purge floor, so a shorter fixture would be
// rejected by the authorization gate before any test reached its subject.
const SECRET = ["cron", "fixture", "value", "long", "enough", "to", "authorize"].join("-");
// Long enough to look plausible, short enough to fail the 32-character floor.
const WEAK_SECRET = ["cron", "fixture", "value"].join("-");
// A SAMPLE-style bearer from the sibling product's separate push path. Union
// Ground has no SAMPLE dispatch, so this must authorize nothing anywhere.
const SAMPLE_SECRET = ["sample", "notification", "dispatch", "secret", "value"].join("-");

// The claim size the budget arithmetic yields on a fresh invocation, restated
// here so the test fails loudly if the model changes rather than tracking it:
//   push row worst   = ceil(20/5) * (10_000 + 8_000)
//                    + ceil(10/5) * 3_000 + 10_000            =  88_000 ms
//   email row worst  = 20_000 + 3_000                           =  23_000 ms
//   record reserve   = 20_000 * 2 + 5_000                       =  45_000 ms
//   email share      = 230_000 - 23_000 - 5_000 - 88_000 - 45_000 = 69_000 ms
//   usable           = 69_000 - 45_000                          =  24_000 ms
//   waves of 23_000  = floor(24_000 / 23_000)                   =       1
//   rows             = 1 wave * EMAIL_CONCURRENCY (cap 60)      =       8
const EMAIL_FULL_BUDGET_LIMIT = 8;
//   push budget      = 230_000 - 45_000                         = 185_000 ms
//   rows             = floor(185_000 / 88_000) (cap 25)         =       2
const PUSH_FULL_BUDGET_LIMIT = 2;
const VAPID_PUBLIC = "B".repeat(87);
const NATIVE_TOKEN = "fcm-token-" + "x".repeat(64);
const NATIVE_HASH = "a".repeat(64);
const NATIVE_INSTALLATION_ID = "2a2e0fab-98a1-4d60-a07f-a7283c85d532";
const fcmKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const apnsKeyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

// Sentinels that must never appear in anything sent to a provider. The claim
// RPC does not return title/body at all, so these are planted ON the claimed
// rows: if the dispatcher ever starts reading member text, they show up here.
const SECRET_TITLE = "GRIEVANCE-9931-HOSTILE-TITLE";
const SECRET_BODY = "member-private-body-do-not-send";

function makeRequest(method = "POST", token = SECRET) {
  return { method, headers: token === null ? {} : { authorization: `Bearer ${token}` } };
}

function makeSampleRequest(method = "POST", token = SAMPLE_SECRET, extraHeaders = {}) {
  return {
    method,
    headers: {
      host: "demo.unionground.invalid",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...extraHeaders,
    },
  };
}

function makeResponse() {
  const out = { status: 0, headers: {}, body: null };
  return {
    out,
    status(code) { out.status = code; return this; },
    setHeader(k, v) { out.headers[k] = v; },
    end(payload) { out.body = JSON.parse(payload); },
  };
}

function claimedEmailRow(overrides = {}) {
  return {
    deliveryId: "d1", attempt: 1, leaseEpoch: 1, kind: "cases", lang: "en",
    email: "member@example.com", subscriptions: null,
    title: SECRET_TITLE, body: SECRET_BODY,
    ...overrides,
  };
}

function claimedPushRow(overrides = {}) {
  return {
    deliveryId: "p1", attempt: 1, leaseEpoch: 1, kind: "events", lang: "en", email: null,
    subscriptions: [claimedWebSubscription()],
    title: SECRET_TITLE, body: SECRET_BODY,
    ...overrides,
  };
}

function claimedWebSubscription(overrides = {}) {
  const subscription = {
    endpoint: "https://fcm.googleapis.com/x/1",
    p256dh: "k",
    auth: "a",
    ...overrides,
  };
  return {
    ...subscription,
    targetKey: overrides.targetKey
      ?? `web:${createHash("sha256").update(subscription.endpoint).digest("hex")}`,
  };
}

function claimedNativeInstallation(overrides = {}) {
  const installation = {
    installationId: NATIVE_INSTALLATION_ID,
    provider: "fcm",
    environment: "production",
    token: NATIVE_TOKEN,
    tokenHash: NATIVE_HASH,
    sessionHandle: "c".repeat(64),
    ...overrides,
  };
  return {
    ...installation,
    targetKey: overrides.targetKey ?? `native:${String(installation.installationId).toLowerCase()}`,
  };
}

function configureFcm(prefix = "") {
  vi.stubEnv(`${prefix}FCM_SERVICE_ACCOUNT_JSON`, JSON.stringify({
    project_id: "example-fixture-fcm",
    client_email: "push@example-fixture-fcm.iam.gserviceaccount.com",
    private_key: fcmKeyPair.privateKey.export({ type: "pkcs8", format: "pem" }),
  }));
}

// One place that decides what every outbound call returns, so a test only has
// to declare the part it cares about.
// PostgREST answers a DELETE whose filter matched nothing with the same 2xx it
// uses for a real delete; only the count in Content-Range tells them apart. The
// default here is a real single-row delete, and `pruneCount` is how a test asks
// for the no-op case.
function deleteResponse(count) {
  return {
    ok: true,
    status: 204,
    headers: new Headers({ "content-range": `*/${count}` }),
  };
}

function installFetch({ emailClaims = [], pushClaims = [], resend, eventEmail, recordFails = false, expireFails = false, pruneStatus, pruneCount = 1, nativeAuthorize = true, nativePrune = true, stalePruned = 0, stalePruneFails = false, fcm, health } = {}) {
  const calls = { rpc: [], resend: [], deletes: [], oauth: [], fcm: [] };
  let emailIndex = 0;
  let pushIndex = 0;

  const fetchMock = vi.fn(async (url, init) => {
    const target = String(url);
    if (target.includes("/rest/v1/rpc/")) {
      const name = target.split("/rest/v1/rpc/")[1];
      const body = JSON.parse(init.body);
      calls.rpc.push({ name, body, target });
      if (name === "expire_notification_deliveries") {
        if (expireFails) return { ok: false, status: 500, text: async () => "" };
        return { ok: true, status: 200, text: async () => JSON.stringify({ expired: 0, exhausted: 0, ineligible: 0 }) };
      }
      if (name === "claim_notification_deliveries") {
        const queue = body.p_channel === "email" ? emailClaims : pushClaims;
        const index = body.p_channel === "email" ? emailIndex++ : pushIndex++;
        return { ok: true, status: 200, text: async () => JSON.stringify(queue[index] ?? []) };
      }
      if (name === "get_event_notification_email") {
        if (typeof eventEmail === "function") return eventEmail(body);
        return { ok: true, status: 200, text: async () => JSON.stringify(eventEmail ?? {
          status: "generic", deliveryId: body.p_delivery_id, attempt: body.p_attempt,
          leaseEpoch: body.p_lease_epoch, email: body.p_email, lang: "en",
        }) };
      }
      if (name === "record_notification_delivery_results") {
        if (recordFails) return { ok: false, status: 503, text: async () => "" };
        return { ok: true, status: 200, text: async () => JSON.stringify({ applied: body.p_results.length, ignored: 0 }) };
      }
      if (name === "prune_stale_native_push_installations") {
        if (stalePruneFails) return { ok: false, status: 503, text: async () => "" };
        return { ok: true, status: 200, text: async () => JSON.stringify(stalePruned) };
      }
      if (name === "authorize_native_push_dispatch") {
        if (typeof nativeAuthorize === "function") return nativeAuthorize(body);
        return { ok: true, status: 200, text: async () => JSON.stringify(nativeAuthorize) };
      }
      if (name === "prune_native_push_installation") {
        return { ok: true, status: 200, text: async () => JSON.stringify(nativePrune) };
      }
      if (name === "get_notification_dispatch_health") {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(health ?? { queue: { pending_email: 0, pending_push: 0 } }),
        };
      }
      throw new Error(`unexpected rpc ${name}`);
    }
    if (new URL(target).hostname === "api.resend.com") {
      calls.resend.push({ init, payload: JSON.parse(init.body) });
      if (typeof resend === "function") return resend(calls.resend.length - 1);
      // One request per delivery, so the response is a single object.
      return resend ?? { ok: true, status: 200, text: async () => JSON.stringify({ id: "re-1" }) };
    }
    if (target === "https://oauth2.googleapis.com/token") {
      calls.oauth.push({ init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "oauth-" + "z".repeat(48) }),
      };
    }
    if (target.includes("fcm.googleapis.com/v1/projects/")) {
      calls.fcm.push({ init, payload: JSON.parse(init.body) });
      if (typeof fcm === "function") return fcm(calls.fcm.length - 1);
      return fcm ?? { ok: true, status: 200, json: async () => ({ name: "message-1" }) };
    }
    if (target.includes("member_push_subscriptions")) {
      calls.deletes.push({ target, init });
      return pruneStatus ?? deleteResponse(pruneCount);
    }
    throw new Error(`unexpected fetch ${target}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

async function run(request = makeRequest()) {
  const response = makeResponse();
  await handler(request, response);
  return response.out;
}

const rpcNames = (calls) => calls.rpc.map((c) => c.name);
const recordBody = (calls) => calls.rpc.find((c) => c.name === "record_notification_delivery_results").body.p_results;

beforeEach(() => {
  vi.clearAllMocks();
  // Never inherit ambient configuration: a CI box with RESEND_API_KEY set would
  // silently take a different branch than the one under test. stubEnv rather
  // than assignment/delete so afterEach can put the real environment back —
  // vitest reuses a worker across files, and a leaked fake service-role key or
  // a deleted provider variable makes a LATER file order-dependent.
  for (const key of ["RESEND_API_KEY", "NOTIFY_FROM_ADDRESS", "NOTIFY_APP_URL", "NOTIFY_KILL_SWITCH", "SAMPLE_NOTIFY_KILL_SWITCH", "VITE_VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_CONTACT", "APNS_TEAM_ID", "APNS_KEY_ID", "APNS_PRIVATE_KEY", "APNS_BUNDLE_ID", "FCM_SERVICE_ACCOUNT_JSON"]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("CRON_SECRET", SECRET);
  for (const key of ["APNS_TEAM_ID", "APNS_KEY_ID", "APNS_PRIVATE_KEY", "APNS_BUNDLE_ID", "FCM_SERVICE_ACCOUNT_JSON"]) {
    vi.stubEnv(`SAMPLE_${key}`, undefined);
  }
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", `sb_publishable_${"p".repeat(40)}`);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-value");
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
  pushMock.sendNotification.mockResolvedValue({ statusCode: 201 });
  pushMock.setVapidDetails.mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("event email authorization boundary", () => {
  const reply = (body, overrides = {}) => ({
    ok: true, status: 200, text: async () => JSON.stringify({
      status: "authorized", deliveryId: body.p_delivery_id, attempt: body.p_attempt,
      leaseEpoch: body.p_lease_epoch, email: body.p_email, lang: "en",
      title: "<img src=x> & 'Member meeting'", startsAt: "2026-10-10T15:00:00+00:00",
      change: "rescheduled", timeZone: "America/New_York", ...overrides,
    }),
  });
  const enableEmail = () => {
    vi.stubEnv("RESEND_API_KEY", "resend-test-key");
    vi.stubEnv("NOTIFY_FROM_ADDRESS", "notices@example.invalid");
    vi.stubEnv("NOTIFY_APP_URL", "https://unionground.example.org/m");
  };

  it("rechecks the exact lease/address and renders live Spanish source copy with escaped HTML", async () => {
    enableEmail();
    const calls = installFetch({ emailClaims: [[claimedEmailRow({ kind: "events" })]], eventEmail: (body) => reply(body, { lang: "es" }) });
    await run();
    const authorization = calls.rpc.find((call) => call.name === "get_event_notification_email");
    expect(authorization.body).toEqual({ p_delivery_id: "d1", p_attempt: 1, p_lease_epoch: 1, p_email: "member@example.com" });
    expect(calls.resend).toHaveLength(1);
    const payload = calls.resend[0].payload;
    expect(payload.subject).toBe("Evento reprogramado: <img src=x> & 'Member meeting'");
    expect(payload.text).toContain("10 de octubre de 2026");
    expect(payload.html).toContain('<html lang="es">');
    expect(payload.html).toContain("&lt;img src=x&gt; &amp; &#39;Member meeting&#39;");
    expect(payload.html).not.toContain("<img src=x>");
    expect(JSON.stringify(payload)).not.toContain(SECRET_TITLE);
    expect(JSON.stringify(payload)).not.toContain(SECRET_BODY);
    expect(recordBody(calls)[0].status).toBe("sent");
  });

  it.each([
    { status: "refused" }, { deliveryId: "different" }, { attempt: 2 }, { leaseEpoch: 2 },
    { email: "someone@example.invalid" }, { title: "Meeting\nInjected: header" },
    { title: "x".repeat(121) }, { change: "private-summary" }, { startsAt: "infinity" },
    { status: "generic", attempt: 2 },
  ])("sends nothing for refused, stale or invalid projection %j", async (overrides) => {
    enableEmail();
    const calls = installFetch({ emailClaims: [[claimedEmailRow({ kind: "events" })]], eventEmail: (body) => reply(body, overrides) });
    const out = await run();
    expect(calls.resend).toHaveLength(0);
    expect(recordBody(calls)[0].status).toBe("skipped");
    expect(out.body.email.providerAttemptedRows).toBe(0);
    expect(out.body.email.providerDown).toBe(false);
  });

  it("defers authorization errors without a generic fallback or a provider attempt", async () => {
    enableEmail();
    const calls = installFetch({ emailClaims: [[claimedEmailRow({ kind: "events" })]], eventEmail: () => ({ ok: false, status: 503, text: async () => SECRET_BODY }) });
    const out = await run();
    expect(calls.resend).toHaveLength(0);
    expect(recordBody(calls)[0]).toMatchObject({ status: "deferred", error: "event email authorization unavailable" });
    expect(out.body.email.providerAttemptedRows).toBe(0);
    expect(out.body.email.providerDown).toBe(false);
    expect(JSON.stringify(out)).not.toContain(SECRET_BODY);
  });

  it("retries an ambiguous event send with identical provider parameters and key on a fresh lease", async () => {
    enableEmail();
    const calls = installFetch({
      emailClaims: [
        [claimedEmailRow({ kind: "events" })],
        [claimedEmailRow({ kind: "events", attempt: 2, leaseEpoch: 2, lang: "es" })], [],
      ],
      // The database has frozen these presentation fields; its new lease
      // binding still follows each claim, even after profile/event changes.
      eventEmail: (body) => reply(body),
      resend: (attempt) => {
        if (attempt === 0) throw new Error("ambiguous provider acceptance");
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: "re-retry" }) };
      },
    });
    await run();
    await run();
    expect(calls.resend).toHaveLength(2);
    expect(calls.resend[1].init.body).toBe(calls.resend[0].init.body);
    expect(calls.resend[1].init.headers["Idempotency-Key"]).toBe(calls.resend[0].init.headers["Idempotency-Key"]);
    expect(calls.rpc.filter((call) => call.name === "get_event_notification_email").map((call) => call.body.p_lease_epoch)).toEqual([1, 2]);
  });

  it("keeps legacy event copy generic even if a generic RPC reply contains a forged title", async () => {
    enableEmail();
    const calls = installFetch({ emailClaims: [[claimedEmailRow({ kind: "events", eventTitle: SECRET_TITLE })]], eventEmail: (body) => reply(body, { status: "generic", title: SECRET_TITLE }) });
    await run();
    expect(calls.resend).toHaveLength(1);
    expect(calls.resend[0].payload.subject).toBe(TEMPLATES.events.en.subject);
    expect(JSON.stringify(calls.resend[0].payload)).not.toContain(SECRET_TITLE);
  });

  it("never requests event details for other email kinds or any push", async () => {
    enableEmail();
    vi.stubEnv("VITE_VAPID_PUBLIC_KEY", VAPID_PUBLIC);
    vi.stubEnv("VAPID_PRIVATE_KEY", "private-vapid-key");
    vi.stubEnv("VAPID_CONTACT", "mailto:push@example.invalid");
    const calls = installFetch({ emailClaims: [[claimedEmailRow({ eventTitle: SECRET_TITLE })]], pushClaims: [[claimedPushRow({ eventTitle: SECRET_TITLE })]] });
    await run();
    expect(rpcNames(calls)).not.toContain("get_event_notification_email");
    expect(calls.resend[0].payload.subject).toBe(TEMPLATES.cases.en.subject);
    expect(pushMock.sendNotification).toHaveBeenCalled();
    expect(JSON.stringify(pushMock.sendNotification.mock.calls)).not.toContain(SECRET_TITLE);
  });
});

describe("authorization gates", () => {
  it("rejects methods other than GET and POST", async () => {
    installFetch();
    expect((await run(makeRequest("DELETE"))).status).toBe(405);
  });

  it("rejects a wrong bearer", async () => {
    installFetch();
    expect((await run(makeRequest("POST", "wrong"))).status).toBe(401);
  });

  it("rejects a missing authorization header", async () => {
    installFetch();
    expect((await run(makeRequest("POST", null))).status).toBe(403);
  });

  it("refuses everything when CRON_SECRET is unset rather than allowing all", async () => {
    vi.stubEnv("CRON_SECRET", undefined);
    installFetch();
    expect((await run(makeRequest("POST", ""))).status).toBe(403);
  });

  // This endpoint can mail every member in the chapter, and it used to accept
  // any non-empty CRON_SECRET while the far narrower intake endpoint demanded
  // 32 characters — the weakest guard on the most powerful surface. One floor
  // governs all three now, so a correctly-presented weak secret still fails.
  it("refuses a correct but under-strength CRON_SECRET as a configuration fault", async () => {
    vi.stubEnv("CRON_SECRET", WEAK_SECRET);
    const calls = installFetch();
    expect((await run(makeRequest("POST", WEAK_SECRET))).status).toBe(503);
    expect(calls.rpc).toHaveLength(0);
  });

  it("does not touch the database before authorizing", async () => {
    const calls = installFetch();
    await run(makeRequest("POST", "wrong"));
    expect(calls.rpc).toHaveLength(0);
  });

  it("honours the static fail-safe on the documented value", async () => {
    vi.stubEnv("NOTIFY_KILL_SWITCH", "1");
    const calls = installFetch();
    const out = await run();
    expect(out.status).toBe(200);
    expect(out.body.disabled).toBe(true);
    // The switch holds delivery, not retention: only the account-notice
    // retention purge runs.
    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].name).toBe("claim_account_notice_mail");
  });

  it("ignores an undocumented kill-switch value instead of silently disabling delivery", async () => {
    vi.stubEnv("NOTIFY_KILL_SWITCH", "true");
    const calls = installFetch();
    const out = await run();
    expect(out.body.disabled).toBeUndefined();
    expect(rpcNames(calls)).toContain("expire_notification_deliveries");
  });

  it("returns 503 when the database is not configured", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined);
    installFetch();
    expect((await run()).status).toBe(503);
  });
});

// Union Ground has a separate SAMPLE push-only path selected by its demo host.
// Union Ground has no SAMPLE backend, so that path does not exist: a SAMPLE
// bearer authorizes nothing on any host, and SAMPLE credentials never reach the
// production cron.
describe("no SAMPLE dispatch", () => {
  it("does not make SAMPLE native credentials available to the production cron", async () => {
    configureFcm("SAMPLE_");
    vi.stubEnv("VITE_VAPID_PUBLIC_KEY", undefined);
    vi.stubEnv("VAPID_PRIVATE_KEY", undefined);
    const calls = installFetch();
    const out = await run();
    expect(out.body.push.configured).toBe(false);
    expect(calls.fcm).toHaveLength(0);
    expect(calls.oauth).toHaveLength(0);
    expect(rpcNames(calls)).not.toContain("prune_stale_native_push_installations");
  });

  it.each(["demo.unionground.invalid", "unionground.invalid", "localhost"])("refuses the SAMPLE bearer on %s before touching any backend", async (host) => {
    vi.stubEnv("SAMPLE_NOTIFICATION_DISPATCH_SECRET", SAMPLE_SECRET);
    vi.stubEnv("VITE_VAPID_PUBLIC_KEY", VAPID_PUBLIC);
    vi.stubEnv("VAPID_PRIVATE_KEY", "private-value");
    vi.stubEnv("VAPID_CONTACT", "mailto:alerts@example.invalid");
    const calls = installFetch({ pushClaims: [[claimedPushRow()]] });
    const out = await run(makeSampleRequest("POST", SAMPLE_SECRET, { host }));
    expect(out.status).toBe(401);
    expect(out.body).not.toHaveProperty("surface");
    expect(calls.rpc).toHaveLength(0);
    expect(pushMock.sendNotification).not.toHaveBeenCalled();
  });

  it("serves a genuine cron request on the one Union Ground backend whatever the host", async () => {
    const calls = installFetch();
    const out = await run({ method: "GET", headers: { host: "demo.unionground.invalid", authorization: `Bearer ${SECRET}`, "x-vercel-cron": "1" } });
    expect(out.body).not.toHaveProperty("surface");
    expect(rpcNames(calls)).toContain("expire_notification_deliveries");
    expect(calls.rpc.every((call) => call.target.startsWith(SUPABASE_URL))).toBe(true);
  });
});

describe("expiry sweep", () => {
  it("runs every tick even with no provider configured", async () => {
    const calls = installFetch();
    const out = await run();
    expect(rpcNames(calls)).toContain("expire_notification_deliveries");
    // No provider at all is a misconfiguration, not a success.
    expect(out.status).toBe(503);
  });

  it("reports a failure as non-2xx so the cron result is not a false green", async () => {
    installFetch({ expireFails: true });
    const out = await run();
    expect(out.status).toBe(500);
    expect(out.body.error).toContain("expire_notification_deliveries");
  });
});

describe("email channel", () => {
  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "resend-value");
    vi.stubEnv("NOTIFY_FROM_ADDRESS", "Union Ground <alerts@example.org>");
    vi.stubEnv("NOTIFY_APP_URL", "https://unionground.example.org/m");
  });

  // Union Ground has no provisioned domain, so the link in every email is
  // the owner-set NOTIFY_APP_URL or nothing: an unset or malformed value leaves
  // email unconfigured and nothing is claimed or mailed.
  it.each([
    ["unset", undefined],
    ["not https", "http://unionground.example.org/m"],
    ["the wrong path", "https://unionground.example.org/"],
    ["carrying a query", "https://unionground.example.org/m?x=1"],
    ["carrying credentials", "https://user:pass@unionground.example.org/m"],
  ])("leaves email unconfigured when NOTIFY_APP_URL is %s", async (_, value) => {
    vi.stubEnv("NOTIFY_APP_URL", value);
    const calls = installFetch({ emailClaims: [[claimedEmailRow()], []] });
    const out = await run();
    expect(out.body.email).toEqual({ configured: false });
    expect(calls.resend).toHaveLength(0);
    expect(calls.rpc.some((call) => call.name === "claim_notification_deliveries" && call.body.p_channel === "email")).toBe(false);
  });

  it("links the owner-set app URL and settings route in every email", async () => {
    const calls = installFetch({ emailClaims: [[claimedEmailRow()], []] });
    await run();
    const payload = calls.resend[0].payload;
    expect(payload.text).toContain("https://unionground.example.org/m");
    expect(payload.headers["List-Unsubscribe"]).toContain("https://unionground.example.org/m");
    expect(JSON.stringify(payload)).not.toMatch(/unionground\.net/i);
    expect(siblingIdentityIn(JSON.stringify(payload))).toEqual([]);
  });

  it("sends the generic per-kind template and records the provider id against the lease", async () => {
    const calls = installFetch({ emailClaims: [[claimedEmailRow()], []] });
    const out = await run();

    expect(out.status).toBe(200);
    expect(calls.resend).toHaveLength(1);
    const message = calls.resend[0].payload;
    expect(message.subject).toBe(TEMPLATES.cases.en.subject);
    expect(message.to).toEqual(["member@example.com"]);
    // Review mutation proof: deleting the html and headers blocks from the
    // payload left this suite green. The rendered shell and the unsubscribe
    // header are the deliverables of F1 — pin them at the wire.
    expect(message.text).toContain(TEMPLATES.cases.en.body);
    expect(message.html).toContain("ISSUE UPDATE");
    expect(message.headers["List-Unsubscribe"]).toMatch(/^<https?:\/\/.+\/settings>$/);
    expect(recordBody(calls)).toEqual([
      { deliveryId: "d1", attempt: 1, leaseEpoch: 1, status: "sent", providerMessageId: "re-1", error: null },
    ]);
  });

  // Union Ground leaves dues out (owner decision, 2026-10-13). A dues row
  // that reaches the queue anyway fails closed as unsendable: skipped, never
  // mailed, and never sent under a generic fallback.
  it("fails closed on a Dues delivery instead of mailing it", async () => {
    const calls = installFetch({ emailClaims: [[claimedEmailRow({ kind: "dues" })], []] });
    const out = await run();

    expect(out.status).toBe(200);
    expect(calls.resend).toHaveLength(0);
    expect(recordBody(calls)[0]).toMatchObject({ status: "skipped" });
  });

  it("never lets member text reach the provider", async () => {
    const calls = installFetch({ emailClaims: [[claimedEmailRow({ lang: "es" })], []] });
    await run();
    const wire = JSON.stringify(calls.resend[0].payload);
    expect(wire).not.toContain(SECRET_TITLE);
    expect(wire).not.toContain(SECRET_BODY);
    expect(wire).toContain(TEMPLATES.cases.es.subject);
  });

  // The key must be stable across the retry that matters — the ambiguous one,
  // where the provider accepted the message but the response was lost and the
  // row comes back on a LATER attempt. Keying on the attempt would defeat that
  // entirely, which is what the previous implementation did.
  it("keys idempotency on the delivery alone, so a later attempt is deduplicated", async () => {
    const first = installFetch({ emailClaims: [[claimedEmailRow()], []] });
    await run();
    const key = first.resend[0].init.headers["Idempotency-Key"];
    expect(key).toMatch(/^sg-notify-[0-9a-f]{48}$/);

    const second = installFetch({ emailClaims: [[claimedEmailRow({ attempt: 4 })], []] });
    await run();
    expect(second.resend[0].init.headers["Idempotency-Key"]).toBe(key);
  });

  it("gives different deliveries different keys, so unrelated mail is never deduplicated", async () => {
    const calls = installFetch({
      emailClaims: [[claimedEmailRow(), claimedEmailRow({ deliveryId: "d2" })], []],
    });
    await run();
    const keys = calls.resend.map((c) => c.init.headers["Idempotency-Key"]);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("is unaffected by which other deliveries share the invocation", async () => {
    const alone = installFetch({ emailClaims: [[claimedEmailRow()], []] });
    await run();
    const withCompany = installFetch({
      emailClaims: [[claimedEmailRow({ deliveryId: "d0" }), claimedEmailRow()], []],
    });
    await run();
    const d1Key = withCompany.resend.find((c) => c.payload.to[0] === "member@example.com"
      && c.init.headers["Idempotency-Key"] === alone.resend[0].init.headers["Idempotency-Key"]);
    expect(d1Key).toBeTruthy();
  });

  // Per-message sends make partial success representable: one rejected message
  // must not drag an accepted sibling back into the queue to be sent twice.
  it("records each message independently when the provider accepts some and rejects others", async () => {
    const calls = installFetch({
      emailClaims: [[claimedEmailRow(), claimedEmailRow({ deliveryId: "d2", email: "two@example.com" })], []],
      resend: (index) => (index === 0
        ? { ok: true, status: 200, text: async () => JSON.stringify({ id: "re-1" }) }
        : { ok: false, status: 422, text: async () => "" }),
    });
    await run();
    const results = recordBody(calls);
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.deliveryId === "d1")).toMatchObject({ status: "sent", providerMessageId: "re-1" });
    expect(results.find((r) => r.deliveryId === "d2")).toMatchObject({ status: "failed" });
  });

  // A 2xx whose body carries no usable id still means the provider accepted the
  // message. Re-sending it because the id was missing would mail the member twice.
  it.each([
    [{}, "no id field"],
    [{ id: null }, "a null id"],
    ["not json at all", "an unparseable body"],
  ])("treats a 2xx with %j (%s) as sent rather than resending", async (payload) => {
    const calls = installFetch({
      emailClaims: [[claimedEmailRow()], []],
      resend: {
        ok: true,
        status: 200,
        text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
      },
    });
    await run();
    expect(recordBody(calls)[0]).toMatchObject({ status: "sent", providerMessageId: null });
  });

  it("returns 502 when every send in the tick fails, rather than a false green", async () => {
    installFetch({
      emailClaims: [[claimedEmailRow(), claimedEmailRow({ deliveryId: "d2" })], []],
      resend: { ok: false, status: 401, text: async () => "" },
    });
    const out = await run();
    expect(out.status).toBe(502);
  });

  it("clears a failed full batch when a later email batch reaches the provider", async () => {
    const firstBatch = Array.from({ length: DISPATCH_BUDGETS.emailConcurrency }, (_, index) =>
      claimedEmailRow({ deliveryId: `d${index + 1}`, email: `member${index + 1}@example.com` }));
    installFetch({
      emailClaims: [firstBatch, [claimedEmailRow({ deliveryId: "tail", email: "tail@example.com" })], []],
      resend: (index) => (index < firstBatch.length
        ? { ok: false, status: 503, text: async () => "" }
        : { ok: true, status: 200, text: async () => JSON.stringify({ id: "re-3" }) }),
    });
    const out = await run();
    expect(out.body.email.providerAttemptedRows).toBe(DISPATCH_BUDGETS.emailConcurrency + 1);
    expect(out.body.email.providerFailedRows).toBe(DISPATCH_BUDGETS.emailConcurrency);
    expect(out.body.email.providerDown).toBe(false);
    expect(out.status).toBe(200);
  });

  it("does not count budget-deferred email rows as provider attempts", async () => {
    const firstBatch = Array.from({ length: DISPATCH_BUDGETS.emailConcurrency }, (_, index) =>
      claimedEmailRow({ deliveryId: `failed-${index + 1}`, email: `failed${index + 1}@example.com` }));
    const deferredBatch = Array.from({ length: DISPATCH_BUDGETS.emailConcurrency }, (_, index) =>
      claimedEmailRow({ deliveryId: `deferred-${index + 1}`, email: `deferred${index + 1}@example.com` }));
    let clockReads = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      clockReads += 1;
      return clockReads <= 11 ? 0 : DISPATCH_BUDGETS.emailMs;
    });
    installFetch({
      emailClaims: [firstBatch, deferredBatch],
      resend: { ok: false, status: 503, text: async () => "" },
    });
    const out = await run();
    expect(out.body.email.providerAttemptedRows).toBe(DISPATCH_BUDGETS.emailConcurrency);
    expect(out.body.email.providerFailedRows).toBe(DISPATCH_BUDGETS.emailConcurrency);
    expect(out.body.email.deferred).toBe(DISPATCH_BUDGETS.emailConcurrency);
    expect(out.body.email.providerDown).toBe(true);
    expect(out.status).toBe(502);
  });

  it("rejects a claimed row with no usable lease before contacting the provider", async () => {
    const calls = installFetch({ emailClaims: [[claimedEmailRow({ attempt: null })], []] });
    const out = await run();
    expect(calls.resend).toHaveLength(0);
    expect(out.status).toBe(500);
  });

  it("marks a row with no address as skipped, not retried forever", async () => {
    const calls = installFetch({ emailClaims: [[claimedEmailRow({ email: null })], []] });
    await run();
    expect(calls.resend).toHaveLength(0);
    expect(recordBody(calls)[0]).toMatchObject({ status: "skipped", error: "no email address" });
  });

  // 'general' is the kind a member cannot switch off, so a sendable fallback
  // for it would be a hole straight through the preference system.
  it.each(["general", "somethingnew"])("fails closed on the unsendable kind %s", async (kind) => {
    const calls = installFetch({ emailClaims: [[claimedEmailRow({ kind })], []] });
    await run();
    expect(calls.resend).toHaveLength(0);
    expect(recordBody(calls)[0]).toMatchObject({ status: "skipped", error: "kind is not outbound-eligible" });
  });

  it("records a transport failure as failed", async () => {
    const calls = installFetch({
      emailClaims: [[claimedEmailRow()], []],
      resend: { ok: false, status: 429, text: async () => "" },
    });
    await run();
    expect(recordBody(calls)[0]).toMatchObject({ status: "failed", error: "resend http 429" });
  });

  // A send that is not recorded becomes a duplicate on the next watchdog cycle,
  // so swallowing the record failure is exactly the wrong move.
  it("surfaces a record-RPC failure as a 500 rather than reporting success", async () => {
    installFetch({ emailClaims: [[claimedEmailRow()], []], recordFails: true });
    const out = await run();
    expect(out.status).toBe(500);
    expect(out.body.error).toContain("record_notification_delivery_results");
  });

  it("keeps claiming while a full batch comes back, then stops", async () => {
    // One worst-case time slice buys one complete concurrency wave. Returning
    // exactly that limit proves another claim is attempted; the empty second
    // claim stops the loop.
    const full = Array.from({ length: DISPATCH_BUDGETS.emailConcurrency }, (_, index) =>
      claimedEmailRow({ deliveryId: `d${index + 1}` }));
    const calls = installFetch({
      emailClaims: [full, []],
    });
    await run();
    const claims = calls.rpc.filter((c) => c.name === "claim_notification_deliveries" && c.body.p_channel === "email");
    expect(claims).toHaveLength(2);
  });

  // Claiming more than the remaining budget can process is what strands rows in
  // 'sending' and re-sends them a watchdog cycle later.
  //
  // Pinned to the exact figure rather than an upper bound: the claim size is now
  // derived from the budget alone (there is no separate constant cap, because
  // the budget bound was always the smaller of the two and a cap of 60 could
  // never be reached). An exact assertion is what makes a change to
  // EMAIL_SEND_TIMEOUT_MS, EMAIL_CONCURRENCY, or the budget shares visible here
  // instead of silently altering throughput.
  it("claims exactly what a full email budget can finish", async () => {
    const calls = installFetch({ emailClaims: [[], []] });
    await run();
    const claim = calls.rpc.find((c) => c.name === "claim_notification_deliveries" && c.body.p_channel === "email");
    expect(claim.body.p_limit).toBe(EMAIL_FULL_BUDGET_LIMIT);
  });

  it("reserves an in-flight email, handoff slack, one push row, and recording before giving time to email", () => {
    expect(DISPATCH_BUDGETS.emailMs).toBeGreaterThan(0);
    expect(DISPATCH_BUDGETS.emailConcurrency).toBeGreaterThan(1);
    expect(DISPATCH_BUDGETS.emailMs
      + DISPATCH_BUDGETS.emailRowWorstCaseMs
      + DISPATCH_BUDGETS.channelHandoffSlackMs
      + DISPATCH_BUDGETS.pushRowWorstCaseMs
      + DISPATCH_BUDGETS.recordReserveMs).toBe(DISPATCH_BUDGETS.invocationMs);
  });

  it("treats the reserved email share as healthy throttling after successful sends", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(DISPATCH_BUDGETS.emailMs);
    const calls = installFetch({
      emailClaims: [[
        claimedEmailRow(),
        claimedEmailRow({ deliveryId: "d2" }),
      ]],
    });
    const out = await run();
    expect(calls.resend).toHaveLength(2);
    expect(out.body.email.sent).toBe(2);
    expect(out.body.email.deadlineReached).toBeUndefined();
    expect(out.status).toBe(200);
  });

  it("returns a claimed email row to pending instead of consuming the push reserve", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(DISPATCH_BUDGETS.emailMs);
    const calls = installFetch({ emailClaims: [[claimedEmailRow()]] });
    const out = await run();
    expect(calls.resend).toHaveLength(0);
    expect(recordBody(calls)[0]).toMatchObject({
      status: "deferred",
      error: "deferred: email channel budget",
    });
    expect(out.body.email.deferred).toBe(1);
    expect(out.body.email.deadlineReached).toBeUndefined();
  });
});

describe("push channel", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_VAPID_PUBLIC_KEY", VAPID_PUBLIC);
    vi.stubEnv("VAPID_PRIVATE_KEY", "private-value");
    vi.stubEnv("VAPID_CONTACT", "mailto:alerts@example.org");
  });

  // No default VAPID contact: the sibling product's address must never reach a
  // push service, so web push without VAPID_CONTACT is incomplete and degraded
  // before anything is claimed.
  it("treats web push without VAPID_CONTACT as incomplete and claims nothing", async () => {
    vi.stubEnv("VAPID_CONTACT", undefined);
    const calls = installFetch({ pushClaims: [[claimedPushRow()], []] });
    const out = await run();
    expect(pushMock.setVapidDetails).not.toHaveBeenCalled();
    expect(pushMock.sendNotification).not.toHaveBeenCalled();
    expect(out.body.push.degradedProviders).toContain("web");
    expect(calls.rpc.some((call) => call.name === "claim_notification_deliveries" && call.body.p_channel === "push")).toBe(false);
    expect(out.status).not.toBe(200);
  });

  it("returns a non-2xx health result when claimed push work is deferred at the deadline", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(200_000)
      .mockReturnValue(200_000);
    const calls = installFetch({ pushClaims: [[claimedPushRow()], []] });
    const out = await run();
    expect(recordBody(calls)[0]).toMatchObject({ status: "deferred" });
    expect(out.status).toBe(502);
    expect(out.body.push.deadlineReached).toBe(true);
    expect(out.body.error).toContain("dispatch deadline reached: push");
  });

  it("treats a saturated successful push batch as healthy throttling", async () => {
    let clockReads = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      clockReads += 1;
      return clockReads <= 4 ? 0 : DISPATCH_BUDGETS.invocationMs;
    });
    const calls = installFetch({
      pushClaims: [[
        claimedPushRow(),
        claimedPushRow({
          deliveryId: "p2",
          subscriptions: [claimedWebSubscription({ endpoint: "https://fcm.googleapis.com/x/2" })],
        }),
      ]],
    });
    const out = await run();
    expect(pushMock.sendNotification).toHaveBeenCalledTimes(2);
    expect(recordBody(calls)).toHaveLength(2);
    expect(out.body.push.sent).toBe(2);
    expect(out.body.push.deadlineReached).toBeUndefined();
    expect(out.status).toBe(200);
  });

  it("signs provider assertions with the configured keys and bounded claims", () => {
    const now = 1_786_969_800;
    const apns = createApnsJwt({
      teamId: "ABCDEFGHIJ",
      keyId: "KLMNOPQRST",
      privateKey: apnsKeyPair.privateKey,
    }, now);
    const [apnsHeader, apnsClaims, apnsSignature] = apns.split(".");
    expect(JSON.parse(Buffer.from(apnsHeader, "base64url"))).toEqual({ alg: "ES256", kid: "KLMNOPQRST" });
    expect(JSON.parse(Buffer.from(apnsClaims, "base64url"))).toEqual({ iss: "ABCDEFGHIJ", iat: now });
    expect(cryptoVerify("sha256", Buffer.from(`${apnsHeader}.${apnsClaims}`), {
      key: apnsKeyPair.publicKey,
      dsaEncoding: "ieee-p1363",
    }, Buffer.from(apnsSignature, "base64url"))).toBe(true);

    const fcm = createFcmAssertion({
      clientEmail: "push@example-fixture-fcm.iam.gserviceaccount.com",
      privateKey: fcmKeyPair.privateKey,
    }, now);
    const [fcmHeader, fcmClaims, fcmSignature] = fcm.split(".");
    expect(JSON.parse(Buffer.from(fcmHeader, "base64url"))).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(fcmClaims, "base64url"))).toMatchObject({
      iss: "push@example-fixture-fcm.iam.gserviceaccount.com",
      iat: now,
      exp: now + 3600,
    });
    expect(cryptoVerify("RSA-SHA256", Buffer.from(`${fcmHeader}.${fcmClaims}`), fcmKeyPair.publicKey,
      Buffer.from(fcmSignature, "base64url"))).toBe(true);
  });

  it("caches the APNs provider token and gives offline phones a one-hour delivery window", () => {
    const now = 1_786_969_800;
    const configuration = {
      teamId: "ABCDEFGHIJ",
      keyId: "KLMNOPQRST",
      privateKey: apnsKeyPair.privateKey,
      bundleId: "org.unionground.app",
      authenticationToken: null,
      authenticationTokenIssuedAt: 0,
    };
    const installation = claimedNativeInstallation({ provider: "apns", environment: "sandbox", token: "b".repeat(80) });
    const first = createApnsHeaders(configuration, installation, now);
    const reused = createApnsHeaders(configuration, installation, now + 20 * 60);
    const refreshed = createApnsHeaders(configuration, installation, now + 50 * 60);

    expect(first[":path"]).toBe(`/3/device/${installation.token}`);
    expect(first["apns-expiration"]).toBe(String(now + 3600));
    expect(reused.authorization).toBe(first.authorization);
    expect(refreshed.authorization).not.toBe(first.authorization);
  });

  it("cancels only a timed-out APNs stream and leaves a healthy sibling on the shared session", async () => {
    vi.useFakeTimers();
    const requests = [];
    const client = Object.assign(new EventEmitter(), {
      closed: false,
      destroyed: false,
      destroy: vi.fn(),
      request: vi.fn(() => {
        const request = Object.assign(new EventEmitter(), {
          setEncoding: vi.fn(),
          write: vi.fn(),
          end: vi.fn(),
          close: vi.fn(function close(code) {
            this.closed = true;
            this.emit("close");
            expect(code).toBe(http2Constants.NGHTTP2_CANCEL);
          }),
        });
        requests.push(request);
        return request;
      }),
    });
    const configuration = {
      teamId: "ABCDEFGHIJ",
      keyId: "KLMNOPQRST",
      privateKey: apnsKeyPair.privateKey,
      bundleId: "org.unionground.app",
      authenticationToken: null,
      authenticationTokenIssuedAt: 0,
      sessions: new Map([["https://api.sandbox.push.apple.com", client]]),
    };
    const template = { subject: "Union Base", body: "Open the app." };
    const stalled = sendOneApns(configuration, claimedNativeInstallation({
      provider: "apns", environment: "sandbox", token: "b".repeat(80),
    }), template);
    const healthy = sendOneApns(configuration, claimedNativeInstallation({
      provider: "apns", environment: "sandbox", token: "c".repeat(80),
    }), template);

    requests[1].emit("response", { [http2Constants.HTTP2_HEADER_STATUS]: 200 });
    requests[1].emit("end");
    await expect(healthy).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(stalled).resolves.toEqual({ ok: false, terminal: false, statusCode: 0 });
    expect(requests[0].close).toHaveBeenCalledTimes(1);
    expect(client.destroy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("preserves APNs terminal classification when the stream closes after 410 headers", async () => {
    const requests = [];
    const client = Object.assign(new EventEmitter(), {
      closed: false,
      destroyed: false,
      destroy: vi.fn(),
      request: vi.fn(() => {
        const request = Object.assign(new EventEmitter(), {
          setEncoding: vi.fn(),
          write: vi.fn(),
          end: vi.fn(),
          close: vi.fn(),
        });
        requests.push(request);
        return request;
      }),
    });
    const configuration = {
      teamId: "ABCDEFGHIJ",
      keyId: "KLMNOPQRST",
      privateKey: apnsKeyPair.privateKey,
      bundleId: "org.unionground.app",
      authenticationToken: null,
      authenticationTokenIssuedAt: 0,
      sessions: new Map([["https://api.sandbox.push.apple.com", client]]),
    };
    const pending = sendOneApns(configuration, claimedNativeInstallation({
      provider: "apns", environment: "sandbox", token: "b".repeat(80),
    }), { subject: "Union Base", body: "Open the app." });

    requests[0].emit("response", { [http2Constants.HTTP2_HEADER_STATUS]: 410 });
    requests[0].emit("close");
    await expect(pending).resolves.toEqual({ ok: false, terminal: true, statusCode: 410 });
    expect(client.destroy).not.toHaveBeenCalled();
  });

  it("requires an explicit compatible routing environment on every native claim", () => {
    expect(nativeInstallationAllowed(claimedNativeInstallation())).toBe(true);
    expect(nativeInstallationAllowed(claimedNativeInstallation({ provider: "apns", environment: "sandbox", token: "b".repeat(64) }))).toBe(true);
    expect(nativeInstallationAllowed(claimedNativeInstallation({ provider: "apns", environment: "sandbox", token: "b".repeat(80) }))).toBe(true);
    expect(nativeInstallationAllowed(claimedNativeInstallation({ provider: "apns", environment: "sandbox", token: "b".repeat(79) }))).toBe(false);
    expect(nativeInstallationAllowed(claimedNativeInstallation({ provider: "apns", environment: "development", token: "b".repeat(64) }))).toBe(false);
    expect(nativeInstallationAllowed(claimedNativeInstallation({ environment: "sandbox" }))).toBe(false);
  });

  it.each([
    ['FCM', {}],
    ['APNs', { provider: 'apns', environment: 'sandbox', token: 'b'.repeat(80) }],
  ])('defers a legacy %s claim without spending an attempt or contacting providers', async (_, fields) => {
    configureFcm();
    const legacy = claimedNativeInstallation(fields);
    delete legacy.sessionHandle;
    const calls = installFetch({ pushClaims: [[claimedPushRow({ subscriptions: [], nativeInstallations: [legacy] })], []] });
    await run();
    expect(recordBody(calls)[0]).toMatchObject({ status: 'deferred' });
    expect(calls.fcm).toHaveLength(0);
    expect(calls.oauth).toHaveLength(0);
    expect(calls.rpc.some(call => call.name === 'authorize_native_push_dispatch')).toBe(false);
  });

  it('defers the whole mixed delivery when a legacy native claim is present', async () => {
    configureFcm();
    const legacy = claimedNativeInstallation();
    delete legacy.sessionHandle;
    const calls = installFetch({ pushClaims: [[claimedPushRow({ nativeInstallations: [legacy, claimedNativeInstallation()] })], []] });
    await run();
    expect(recordBody(calls)[0]).toMatchObject({ status: 'deferred', error: 'native claim schema unavailable' });
    expect(pushMock.sendNotification).not.toHaveBeenCalled();
    expect(calls.fcm).toHaveLength(0);
    expect(calls.oauth).toHaveLength(0);
    expect(calls.rpc.some(call => call.name === 'authorize_native_push_dispatch')).toBe(false);
  });

  it.each([false, null, {}, 'true'])("never contacts FCM on a refused or malformed reauthorization %j", async (nativeAuthorize) => {
    configureFcm();
    const calls = installFetch({ nativeAuthorize, pushClaims: [[claimedPushRow({ subscriptions: [], nativeInstallations: [claimedNativeInstallation()] })], []] });
    await run();
    expect(calls.fcm).toHaveLength(0);
    expect(calls.oauth).toHaveLength(0);
    expect(calls.rpc.some((call) => call.name === 'authorize_native_push_dispatch')).toBe(true);
    expect(recordBody(calls)[0].status).not.toBe('sent');
  });

  it("defers a native target when reauthorization is unavailable without contacting its provider", async () => {
    configureFcm();
    const calls = installFetch({ nativeAuthorize: async () => ({ ok: false, status: 503, text: async () => '' }), pushClaims: [[claimedPushRow({ subscriptions: [], nativeInstallations: [claimedNativeInstallation()] })], []] });
    await run();
    expect(calls.fcm).toHaveLength(0);
    expect(recordBody(calls)[0]).toMatchObject({ status: 'deferred' });
  });

  it('binds reauthorization to the claimed lease and opaque target identity without sending credentials', async () => {
    configureFcm();
    const target = claimedNativeInstallation();
    const row = claimedPushRow({ subscriptions: [], nativeInstallations: [target] });
    const calls = installFetch({ pushClaims: [[row], []] });
    await run();
    expect(calls.rpc.find((call) => call.name === 'authorize_native_push_dispatch').body).toEqual({
      p_delivery_id: row.deliveryId, p_attempt: row.attempt, p_lease_epoch: row.leaseEpoch,
      p_installation_id: target.installationId, p_provider: target.provider,
      p_environment: target.environment, p_token_hash: target.tokenHash, p_session_handle: target.sessionHandle,
    });
    expect(JSON.stringify(calls.rpc)).not.toContain(NATIVE_TOKEN);
    expect(calls.fcm).toHaveLength(1);
  });

  it("sends a generic FCM payload after bounded stale cleanup", async () => {
    configureFcm();
    vi.stubEnv("VITE_VAPID_PUBLIC_KEY", undefined);
    vi.stubEnv("VAPID_PRIVATE_KEY", undefined);
    const calls = installFetch({
      pushClaims: [[claimedPushRow({ kind: "cases", subscriptions: [], nativeInstallations: [claimedNativeInstallation()] })], []],
      stalePruned: 2,
    });
    const out = await run();
    expect(out.status).toBe(200);
    expect(calls.rpc.find((call) => call.name === "prune_stale_native_push_installations")?.body)
      .toMatchObject({ p_limit: 100 });
    expect(calls.oauth).toHaveLength(1);
    expect(calls.fcm).toHaveLength(1);
    const wire = calls.fcm[0].payload.message;
    expect(wire.token).toBe(NATIVE_TOKEN);
    expect(wire.notification).toEqual({
      title: "Something needs your attention",
      body: "Open Union Ground to see what's new.",
    });
    expect(wire.data).toEqual({ screen: "home" });
    expect(JSON.stringify(wire)).not.toContain(SECRET_TITLE);
    expect(JSON.stringify(wire)).not.toContain(SECRET_BODY);
    expect(recordBody(calls)[0]).toMatchObject({ status: "sent" });
  });

  it("prunes a terminal FCM token only with its exact non-secret identity", async () => {
    configureFcm();
    vi.stubEnv("VITE_VAPID_PUBLIC_KEY", undefined);
    vi.stubEnv("VAPID_PRIVATE_KEY", undefined);
    const calls = installFetch({
      pushClaims: [[claimedPushRow({ subscriptions: [], nativeInstallations: [claimedNativeInstallation()] })], []],
      fcm: {
        ok: false,
        status: 404,
        json: async () => ({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }),
      },
    });
    await run();
    const prune = calls.rpc.find((call) => call.name === "prune_native_push_installation");
    expect(prune.body).toEqual({
      p_installation_id: NATIVE_INSTALLATION_ID,
      p_provider: "fcm",
      p_environment: "production",
      p_token_hash: NATIVE_HASH,
    });
    expect(JSON.stringify(prune.body)).not.toContain(NATIVE_TOKEN);
    expect(recordBody(calls)[0]).toMatchObject({ status: "skipped", error: "all push endpoints expired" });
  });

  it("retries a terminal FCM token when its installation cannot be pruned", async () => {
    configureFcm();
    vi.stubEnv("VITE_VAPID_PUBLIC_KEY", undefined);
    vi.stubEnv("VAPID_PRIVATE_KEY", undefined);
    const calls = installFetch({
      pushClaims: [[claimedPushRow({ subscriptions: [], nativeInstallations: [claimedNativeInstallation()] })], []],
      nativePrune: false,
      fcm: {
        ok: false,
        status: 404,
        json: async () => ({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }),
      },
    });
    const out = await run();
    expect(out.body.push.pruned).toBe(0);
    expect(out.body.push.providerDown).toBe(false);
    expect(out.body.push.cleanupFailed).toBe(true);
    expect(out.status).toBe(502);
    expect(out.body.error).toContain("stale-token cleanup");
    expect(recordBody(calls)[0]).toMatchObject({ status: "failed", error: "push failed: 503" });
  });

  it("does not prune a bare FCM 404 that is not provider-reported UNREGISTERED", async () => {
    configureFcm();
    vi.stubEnv("VITE_VAPID_PUBLIC_KEY", undefined);
    vi.stubEnv("VAPID_PRIVATE_KEY", undefined);
    const calls = installFetch({
      pushClaims: [[claimedPushRow({ subscriptions: [], nativeInstallations: [claimedNativeInstallation()] })], []],
      fcm: {
        ok: false,
        status: 404,
        json: async () => ({ error: { status: "NOT_FOUND", message: "project mismatch" } }),
      },
    });
    const out = await run();
    expect(calls.rpc.some((call) => call.name === "prune_native_push_installation")).toBe(false);
    expect(recordBody(calls)[0]).toMatchObject({ status: "failed", error: "push failed: 404" });
    expect(out.status).toBe(502);
  });

  it("shares one first-use FCM OAuth exchange across concurrent installation sends", async () => {
    configureFcm();
    vi.stubEnv("VITE_VAPID_PUBLIC_KEY", undefined);
    vi.stubEnv("VAPID_PRIVATE_KEY", undefined);
    const second = claimedNativeInstallation({
      installationId: "4b4e0fab-98a1-4d60-a07f-a7283c85d533",
      token: `second-${"y".repeat(64)}`,
      tokenHash: "c".repeat(64),
    });
    const calls = installFetch({
      pushClaims: [[claimedPushRow({
        subscriptions: [],
        nativeInstallations: [claimedNativeInstallation(), second],
      })], []],
    });
    await run();
    expect(calls.oauth).toHaveLength(1);
    expect(calls.fcm).toHaveLength(2);
    expect(recordBody(calls)[0].deliveredTargetKeys).toEqual([
      `native:${NATIVE_INSTALLATION_ID}`,
      `native:${second.installationId}`,
    ]);
  });

  it("fails a malformed native claim without contacting or logging a provider token", async () => {
    configureFcm();
    vi.stubEnv("VITE_VAPID_PUBLIC_KEY", undefined);
    vi.stubEnv("VAPID_PRIVATE_KEY", undefined);
    const calls = installFetch({
      pushClaims: [[claimedPushRow({
        subscriptions: [],
        nativeInstallations: [claimedNativeInstallation({ environment: "sandbox" })],
      })], []],
    });
    const out = await run();
    expect(calls.fcm).toHaveLength(0);
    expect(recordBody(calls)[0]).toMatchObject({ status: "failed", error: "push failed: 422" });
    expect(out.body.push.providerDown).toBe(false);
    expect(out.body.push.invalidTargets).toBe(1);
    expect(out.status).toBe(502);
    expect(out.body.error).toContain("malformed target data");
    expect(JSON.stringify(console.error.mock.calls)).not.toContain(NATIVE_TOKEN);
  });

  it("rejects partial FCM credentials before claiming a delivery", async () => {
    vi.stubEnv("VITE_VAPID_PUBLIC_KEY", undefined);
    vi.stubEnv("VAPID_PRIVATE_KEY", undefined);
    vi.stubEnv("FCM_SERVICE_ACCOUNT_JSON", "{}");
    const calls = installFetch({ pushClaims: [[claimedPushRow()], []] });
    const out = await run();
    expect(calls.rpc.filter((call) => call.name === "claim_notification_deliveries")).toHaveLength(0);
    expect(out.status).toBe(500);
    expect(out.body.push.error).toBe("push provider configuration rejected");
  });

  it("keeps web push running but reports a separately configured native provider as degraded", async () => {
    vi.stubEnv("FCM_SERVICE_ACCOUNT_JSON", "{}");
    const calls = installFetch({ pushClaims: [[claimedPushRow()], []] });
    const out = await run();
    expect(pushMock.sendNotification).toHaveBeenCalledTimes(1);
    expect(recordBody(calls)[0]).toMatchObject({ status: "sent" });
    expect(out.status).toBe(502);
    expect(out.body.push.degradedProviders).toEqual(["fcm"]);
    expect(out.body.error).toContain("push degraded");
  });

  it.each(["APNS_TEAM_ID", "APNS_KEY_ID", "APNS_PRIVATE_KEY", "APNS_BUNDLE_ID"])("rejects an isolated %s before claiming native delivery", async (key) => {
    vi.stubEnv("VITE_VAPID_PUBLIC_KEY", undefined);
    vi.stubEnv("VAPID_PRIVATE_KEY", undefined);
    vi.stubEnv(key, "incomplete-test-setting");
    const calls = installFetch({ pushClaims: [[claimedPushRow()], []] });
    const out = await run();
    expect(calls.rpc.filter((call) => call.name === "claim_notification_deliveries")).toHaveLength(0);
    expect(out.status).toBe(500);
    expect(out.body.push).toMatchObject({ configured: true, error: "push provider configuration rejected", degradedProviders: ["apns"] });
    expect(JSON.stringify(out.body)).not.toContain("incomplete-test-setting");
  });

  it("preserves web delivery while reporting partial APNs configuration", async () => {
    vi.stubEnv("APNS_BUNDLE_ID", "org.unionground.app");
    const calls = installFetch({ pushClaims: [[claimedPushRow()], []] });
    const out = await run();
    expect(pushMock.sendNotification).toHaveBeenCalledTimes(1);
    expect(recordBody(calls)[0]).toMatchObject({ status: "sent" });
    expect(out.status).toBe(502);
    expect(out.body.push.degradedProviders).toEqual(["apns"]);
  });

  it("keeps delivery running but reports failed stale native-token housekeeping", async () => {
    configureFcm();
    const calls = installFetch({ pushClaims: [[claimedPushRow()], []], stalePruneFails: true });
    const out = await run();
    expect(pushMock.sendNotification).toHaveBeenCalledTimes(1);
    expect(recordBody(calls)[0]).toMatchObject({ status: "sent" });
    expect(out.status).toBe(502);
    expect(out.body.push.staleCleanupFailed).toBe(true);
    expect(out.body.error).toContain("stale-token cleanup");
  });

  it("sends the generic template and records against the lease", async () => {
    const calls = installFetch({ pushClaims: [[claimedPushRow()], []] });
    const out = await run();
    expect(out.status).toBe(200);
    expect(pushMock.sendNotification).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(pushMock.sendNotification.mock.calls[0][1]);
    expect(payload).toEqual({ title: TEMPLATES.events.en.subject, body: TEMPLATES.events.en.body, url: "/m" });
    expect(JSON.stringify(payload)).not.toContain(SECRET_TITLE);
    expect(recordBody(calls)[0]).toMatchObject({ deliveryId: "p1", attempt: 1, status: "sent" });
  });

  // Shoulder rule: a push banner reads on a lock screen, so case/form/vote
  // pushes must not name their topic. Email keeps the per-topic subject — an
  // inbox sits behind the mail account's own lock.
  it("collapses sensitive push kinds to the generic title", async () => {
    installFetch({ pushClaims: [[claimedPushRow({ kind: "cases" })], []] });
    await run();
    const payload = JSON.parse(pushMock.sendNotification.mock.calls[0][1]);
    expect(payload.title).toBe("Something needs your attention");
    expect(payload.title).not.toBe(TEMPLATES.cases.en.subject);
    expect(JSON.stringify(payload)).not.toMatch(/case|form|vote/i);
  });

  it("collapses in the member's language", async () => {
    installFetch({ pushClaims: [[claimedPushRow({ kind: "votes", lang: "es" })], []] });
    await run();
    const payload = JSON.parse(pushMock.sendNotification.mock.calls[0][1]);
    expect(payload.title).toBe("Algo requiere tu atención");
  });

  it("keeps the collapse scoped to exactly the privacy-sensitive topics", () => {
    // 'appointments' joined 2026-08-01: that a one-on-one is booked at all is
    // the sensitive fact. No 'dues': Union Ground has no dues notices.
    expect([...PUSH_SENSITIVE_KINDS].sort()).toEqual(["appointments", "cases", "forms", "votes", "workload"]);
    for (const kind of PUSH_SENSITIVE_KINDS) {
      const metadata = kind === "workload" ? { event: "reminder", receiptCode: null } : null;
      expect(pushTemplateFor(kind, "en", metadata).subject).toBe("Something needs your attention");
    }
    // Non-sensitive kinds keep their per-topic (already shoulder-safe) copy…
    for (const kind of ["deadlines", "tasks", "events"]) {
      expect(pushTemplateFor(kind, "en")).toEqual(TEMPLATES[kind].en);
    }
    // …and the fail-closed gate survives the wrapper.
    expect(pushTemplateFor("general", "en")).toBeNull();
    // Email must never inherit the collapse.
    expect(templateFor("cases", "en").subject).toBe(TEMPLATES.cases.en.subject);
  });

  // The defect this pins: setVapidDetails throws on a malformed key, and doing
  // that AFTER the claim burns an attempt on every claimed row for a problem
  // that has nothing to do with them.
  it("validates the VAPID configuration before claiming anything", async () => {
    pushMock.setVapidDetails.mockImplementation(() => {
      throw new Error("Vapid public key should be 65 bytes long when decoded");
    });
    const calls = installFetch({ pushClaims: [[claimedPushRow()], []] });
    const out = await run();
    const claims = calls.rpc.filter((c) => c.name === "claim_notification_deliveries" && c.body.p_channel === "push");
    expect(claims).toHaveLength(0);
    expect(out.status).toBe(500);
    expect(out.body.push.error).toContain("push provider configuration rejected");
  });

  it("prunes a 410 endpoint and skips the delivery when every endpoint is dead", async () => {
    pushMock.sendNotification.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));
    const calls = installFetch({ pushClaims: [[claimedPushRow()], []] });
    await run();
    expect(calls.deletes).toHaveLength(1);
    expect(calls.deletes[0].target).toContain(encodeURIComponent("https://fcm.googleapis.com/x/1"));
    // Without an exact count the DELETE cannot be told apart from a no-op.
    expect(calls.deletes[0].init.headers.Prefer).toContain("count=exact");
    expect(recordBody(calls)[0]).toMatchObject({ status: "skipped", error: "all push endpoints expired" });
  });

  it("retries a terminal web endpoint when its subscription cannot be pruned", async () => {
    pushMock.sendNotification.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));
    const calls = installFetch({
      pushClaims: [[claimedPushRow()], []],
      pruneStatus: { ok: false, status: 503 },
    });
    const out = await run();
    expect(out.body.push.pruned).toBe(0);
    expect(out.body.push.providerDown).toBe(false);
    expect(out.body.push.cleanupFailed).toBe(true);
    expect(out.status).toBe(502);
    expect(out.body.error).toContain("stale-token cleanup");
    expect(recordBody(calls)[0]).toMatchObject({ status: "failed", error: "push failed: 503" });
  });

  it("prefers a real provider failure over a simultaneous cleanup failure", async () => {
    configureFcm();
    pushMock.sendNotification.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));
    const calls = installFetch({
      pushClaims: [[claimedPushRow({ nativeInstallations: [claimedNativeInstallation()] })], []],
      pruneStatus: { ok: false, status: 503 },
      fcm: { ok: false, status: 500, json: async () => ({ error: { status: "INTERNAL" } }) },
    });
    const out = await run();
    expect(out.body.push.cleanupFailed).toBe(true);
    // The web provider answered authoritatively with a terminal 410, so the
    // provider set is not wholly down even though the sibling FCM send failed.
    expect(out.body.push.providerDown).toBe(false);
    expect(out.status).toBe(502);
    expect(recordBody(calls)[0]).toMatchObject({ status: "failed", error: "push failed: 500" });
  });

  it("prefers a real provider failure over simultaneous malformed target data", async () => {
    configureFcm();
    const calls = installFetch({
      pushClaims: [[claimedPushRow({
        subscriptions: [claimedWebSubscription({ endpoint: "https://internal.example.com/push" })],
        nativeInstallations: [claimedNativeInstallation()],
      })], []],
      fcm: { ok: false, status: 500, json: async () => ({ error: { status: "INTERNAL" } }) },
    });
    const out = await run();
    expect(out.body.push.invalidTargets).toBe(1);
    expect(out.body.push.providerDown).toBe(true);
    expect(out.status).toBe(502);
    expect(recordBody(calls)[0]).toMatchObject({ status: "failed", error: "push failed: 500" });
  });

  it("ignores non-send rows when every actual provider send fails", async () => {
    configureFcm();
    vi.stubEnv("VITE_VAPID_PUBLIC_KEY", undefined);
    vi.stubEnv("VAPID_PRIVATE_KEY", undefined);
    const malformed = claimedPushRow({
      deliveryId: "malformed",
      subscriptions: [],
      nativeInstallations: [claimedNativeInstallation({ environment: "sandbox" })],
    });
    const providerFailure = claimedPushRow({
      deliveryId: "provider-failure",
      subscriptions: [],
      nativeInstallations: [claimedNativeInstallation()],
    });
    const calls = installFetch({
      pushClaims: [[malformed, providerFailure], []],
      fcm: { ok: false, status: 500, json: async () => ({ error: { status: "INTERNAL" } }) },
    });
    const out = await run();
    expect(calls.fcm).toHaveLength(1);
    expect(out.body.push.invalidTargets).toBe(1);
    expect(out.body.push.providerDown).toBe(true);
    expect(out.status).toBe(502);
  });

  it("clears a failed full batch when a later push batch reaches a provider", async () => {
    const firstBatch = [
      claimedPushRow(),
      claimedPushRow({
        deliveryId: "p2",
        subscriptions: [claimedWebSubscription({ endpoint: "https://fcm.googleapis.com/x/2" })],
      }),
    ];
    pushMock.sendNotification
      .mockRejectedValueOnce(Object.assign(new Error("down"), { statusCode: 503 }))
      .mockRejectedValueOnce(Object.assign(new Error("down"), { statusCode: 503 }))
      .mockResolvedValue({ statusCode: 201 });
    installFetch({
      pushClaims: [firstBatch, [claimedPushRow({
        deliveryId: "p3",
        subscriptions: [claimedWebSubscription({ endpoint: "https://fcm.googleapis.com/x/3" })],
      })], []],
    });
    const out = await run();
    expect(out.body.push.providerAttemptedRows).toBe(3);
    expect(out.body.push.providerFailedRows).toBe(2);
    expect(out.body.push.providerDown).toBe(false);
    expect(out.status).toBe(200);
  });

  it("treats a retryable provider error as failed, not dead", async () => {
    pushMock.sendNotification.mockRejectedValue(Object.assign(new Error("boom"), { statusCode: 500 }));
    const calls = installFetch({ pushClaims: [[claimedPushRow()], []] });
    await run();
    expect(calls.deletes).toHaveLength(0);
    expect(recordBody(calls)[0]).toMatchObject({ status: "failed", error: "push failed: 500" });
  });

  it("treats a plain error with no statusCode as retryable rather than dead", async () => {
    pushMock.sendNotification.mockRejectedValue(new Error("socket hang up"));
    const calls = installFetch({ pushClaims: [[claimedPushRow()], []] });
    await run();
    expect(calls.deletes).toHaveLength(0);
    expect(recordBody(calls)[0].status).toBe("failed");
  });

  it("defers an unavailable sibling without burning the row or losing an accepted target receipt", async () => {
    const calls = installFetch({
      pushClaims: [[claimedPushRow({ nativeInstallations: [claimedNativeInstallation()] })], []],
    });
    const out = await run();
    expect(pushMock.sendNotification).toHaveBeenCalledTimes(1);
    expect(recordBody(calls)[0]).toMatchObject({
      status: "deferred",
      error: "provider unavailable: fcm",
      deliveredTargetKeys: [claimedWebSubscription().targetKey],
    });
    expect(out.body.push.configurationDeferred).toBe(1);
    expect(out.body.push.unavailableProviders).toEqual(["fcm"]);
    expect(out.status).toBe(502);
  });

  it("does not refund a real provider failure when another provider is unavailable", async () => {
    pushMock.sendNotification.mockRejectedValue(Object.assign(new Error("boom"), { statusCode: 500 }));
    const calls = installFetch({
      pushClaims: [[claimedPushRow({ nativeInstallations: [claimedNativeInstallation()] })], []],
    });
    const out = await run();
    expect(recordBody(calls)[0]).toMatchObject({ status: "failed", error: "push failed: 500" });
    expect(recordBody(calls)[0]).not.toHaveProperty("deliveredTargetKeys");
    expect(out.body.push.configurationDeferred).toBe(0);
    expect(out.body.push.unavailableProviders).toEqual(["fcm"]);
    expect(out.status).toBe(502);
  });

  it("retries only the failed sibling after recording the accepted target receipt", async () => {
    configureFcm();
    const native = claimedNativeInstallation();
    const firstClaim = claimedPushRow({ nativeInstallations: [native] });
    const retryClaim = claimedPushRow({ attempt: 2, subscriptions: [], nativeInstallations: [native] });
    const calls = installFetch({
      pushClaims: [[firstClaim], [retryClaim]],
      fcm: (index) => index === 0
        ? { ok: false, status: 500, json: async () => ({ error: { status: "INTERNAL" } }) }
        : { ok: true, status: 200, json: async () => ({ name: "message-2" }) },
    });

    const partial = await run();
    expect(partial.status).toBe(200);
    expect(partial.body.push.providerDown).toBe(false);
    expect((await run()).status).toBe(200);
    expect(pushMock.sendNotification).toHaveBeenCalledTimes(1);
    expect(calls.fcm).toHaveLength(2);
    const results = calls.rpc
      .filter((call) => call.name === "record_notification_delivery_results")
      .flatMap((call) => call.body.p_results);
    expect(results[0]).toMatchObject({
      status: "failed",
      deliveredTargetKeys: [claimedWebSubscription().targetKey],
    });
    expect(results[1]).toMatchObject({
      attempt: 2,
      status: "sent",
      deliveredTargetKeys: [native.targetKey],
    });
  });

  it("sends to a live endpoint and prunes a dead one in the same delivery", async () => {
    pushMock.sendNotification
      .mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 }))
      .mockResolvedValueOnce({ statusCode: 201 });
    const calls = installFetch({
      pushClaims: [[claimedPushRow({
        subscriptions: [
          claimedWebSubscription({ endpoint: "https://fcm.googleapis.com/dead" }),
          claimedWebSubscription({ endpoint: "https://fcm.googleapis.com/live" }),
        ],
      })], []],
    });
    const out = await run();
    expect(out.body.push.pruned).toBe(1);
    expect(recordBody(calls)[0].status).toBe("sent");
  });

  it("skips a delivery with no subscriptions", async () => {
    const calls = installFetch({ pushClaims: [[claimedPushRow({ subscriptions: [] })], []] });
    await run();
    expect(pushMock.sendNotification).not.toHaveBeenCalled();
    expect(recordBody(calls)[0]).toMatchObject({ status: "skipped", error: "no usable push subscriptions" });
  });

  // The database constrains stored endpoints, but the dispatcher is what makes
  // the request. A row restored from a pre-constraint backup must not turn this
  // service-role function into an SSRF primitive. Every other push fixture uses
  // FCM, so without this the allow-list could be deleted and stay green.
  it.each([
    "https://127.0.0.1/push/1",
    "http://fcm.googleapis.com/x/1",
    "https://internal.example.com/x/1",
    "https://evil.com/googleapis.com",
    "https://notgoogleapis.com/x/1",
  ])("refuses to POST a claimed endpoint outside the allow-list: %s", async (endpoint) => {
    const calls = installFetch({
      pushClaims: [[claimedPushRow({ subscriptions: [claimedWebSubscription({ endpoint })] })], []],
    });
    await run();
    expect(pushMock.sendNotification).not.toHaveBeenCalled();
    expect(recordBody(calls)[0]).toMatchObject({ status: "failed", error: "push failed: 422" });
  });

  it("still sends to the real push hosts", async () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/x",
      "https://updates.push.services.mozilla.com/wpush/v2/x",
      "https://sin.notify.windows.com/w/?token=x",
      "https://api.push.apple.com/3/device/x",
    ]) {
      vi.clearAllMocks();
      pushMock.sendNotification.mockResolvedValue({ statusCode: 201 });
      installFetch({ pushClaims: [[claimedPushRow({ subscriptions: [claimedWebSubscription({ endpoint })] })], []] });
      await run();
      expect(pushMock.sendNotification).toHaveBeenCalledTimes(1);
    }
  });

  // Counting a prune that did not happen reports a self-healing queue that is
  // in fact re-sending to the same dead endpoint on every tick.
  it("does not count a prune whose DELETE failed", async () => {
    const calls = installFetch({
      pushClaims: [[claimedPushRow()], []],
      pruneStatus: { ok: false, status: 500 },
    });
    pushMock.sendNotification.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));
    const out = await run();
    expect(calls.deletes).toHaveLength(1);
    expect(out.body.push.pruned).toBe(0);
  });

  // The defect this pins: PostgREST returns 204 for a DELETE that matched no
  // rows, so a prune that removed nothing used to be counted as a success. The
  // summary then showed a self-healing queue while the dead endpoint stayed in
  // the table and was re-sent on every tick, forever.
  it("does not count a prune whose DELETE matched no rows", async () => {
    const calls = installFetch({ pushClaims: [[claimedPushRow()], []], pruneCount: 0 });
    pushMock.sendNotification.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));
    const out = await run();
    expect(calls.deletes).toHaveLength(1);
    expect(out.body.push.pruned).toBe(0);
  });

  it("does not count a prune whose response carries no count at all", async () => {
    const calls = installFetch({
      pushClaims: [[claimedPushRow()], []],
      pruneStatus: { ok: true, status: 204, headers: new Headers() },
    });
    pushMock.sendNotification.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));
    const out = await run();
    expect(calls.deletes).toHaveLength(1);
    expect(out.body.push.pruned).toBe(0);
  });

  // Push claims are sized off the serial per-row worst case, unlike email: a
  // push row sends up to ten subscriptions and dispatchPushBatch walks rows one
  // at a time, so the concurrency inside a row must not be credited against the
  // batch. Pinned exactly for the same reason as the email limit.
  it("claims exactly what a full push budget can finish", async () => {
    const calls = installFetch({ pushClaims: [[], []] });
    await run();
    const claim = calls.rpc.find((c) => c.name === "claim_notification_deliveries" && c.body.p_channel === "push");
    expect(claim.body.p_limit).toBe(PUSH_FULL_BUDGET_LIMIT);
  });

  it("fails closed on an unsendable kind before reaching the push service", async () => {
    const calls = installFetch({ pushClaims: [[claimedPushRow({ kind: "general" })], []] });
    await run();
    expect(pushMock.sendNotification).not.toHaveBeenCalled();
    expect(recordBody(calls)[0]).toMatchObject({ status: "skipped", error: "kind is not outbound-eligible" });
  });
});

describe("templateFor", () => {
  it("covers every sendable kind in both languages", () => {
    for (const kind of ["deadlines", "cases", "forms", "votes", "events", "tasks", "appointments", "messages"]) {
      for (const lang of ["en", "es"]) {
        const template = templateFor(kind, lang);
        expect(template.subject.length).toBeGreaterThan(0);
        expect(template.body.length).toBeGreaterThan(0);
      }
    }
  });

  it("has no Dues template in either language or on the lock screen", () => {
    expect(templateFor("dues", "en")).toBeNull();
    expect(templateFor("dues", "es")).toBeNull();
    expect(pushTemplateFor("dues", "en")).toBeNull();
  });

  it("names Union Ground, never a retired name, in every template", () => {
    const all = JSON.stringify([TEMPLATES, pushTemplateFor("cases", "en"), pushTemplateFor("cases", "es")]);
    expect(all).not.toMatch(/Solid ?Ground|Union Base|509/);
    expect(all).toContain("Union Ground");
  });

  it("returns nothing sendable for kinds that must stay in-app", () => {
    expect(templateFor("general", "en")).toBeNull();
    expect(templateFor("unknown", "en")).toBeNull();
    expect(templateFor(undefined, "en")).toBeNull();
    // Prototype keys must not resolve to a template.
    expect(templateFor("constructor", "en")).toBeNull();
    expect(templateFor("toString", "en")).toBeNull();
  });

  it("falls back to English for an unknown language rather than failing", () => {
    expect(templateFor("cases", "fr")).toEqual(TEMPLATES.cases.en);
  });

  it("selects bilingual workload receipt and reminder templates from closed metadata", () => {
    expect(templateFor("workload", "en", { event: "receipt", receiptCode: "a3f81c92" })).toEqual({
      subject: "Workplace log received",
      body: "Your workplace log receipt is #a3f81c92. Keep this code for your records.",
    });
    expect(templateFor("workload", "es", { event: "reminder", receiptCode: null })).toEqual({
      subject: "Recordatorio del registro del lugar de trabajo",
      body: "Es hora de actualizar tu registro del lugar de trabajo en Union Ground. Abre la aplicación cuando puedas.",
    });
  });

  it("fails closed on malformed workload metadata", () => {
    for (const metadata of [
      null,
      {},
      { event: "other" },
      { event: "receipt", receiptCode: "A3F81C92" },
      { event: "receipt", receiptCode: "a3f81c9" },
      { event: "reminder", receiptCode: "a3f81c92" },
    ]) {
      expect(templateFor("workload", "en", metadata)).toBeNull();
    }
  });

  it("collapses workload push copy and never exposes a receipt code", () => {
    const push = pushTemplateFor("workload", "en", { event: "receipt", receiptCode: "a3f81c92" });
    expect(push).toEqual({ subject: "Something needs your attention", body: "Open Union Ground to see what's new." });
    expect(JSON.stringify(push)).not.toContain("a3f81c92");
  });
});

// Both of these are exported for exactly this: they are the two pure decisions
// in a function that otherwise only runs against a live queue, and they were
// only ever covered incidentally through the handler. A direct test says what
// each one is FOR, and pins the boundaries the handler tests cannot express.
describe("pushEndpointAllowed", () => {
  // The only outbound-request gate in a service-role function. It answers
  // "may this claimed row make me POST somewhere", so it fails closed on
  // anything it cannot positively recognise.
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://sin.notify.windows.com/w/?token=abc",
    "https://api.push.apple.com/3/device/abc",
    // The bare suffix, not just a subdomain of it.
    "https://push.services.mozilla.com/wpush/v2/abc",
  ])("allows the real push host %s", (endpoint) => {
    expect(pushEndpointAllowed(endpoint)).toBe(true);
  });

  it.each([
    ["http://fcm.googleapis.com/x", "plaintext http"],
    ["ftp://fcm.googleapis.com/x", "a non-http scheme"],
    ["https://127.0.0.1/push/1", "a loopback address"],
    ["https://169.254.169.254/latest/meta-data/", "the cloud metadata address"],
    ["https://internal.example.com/x", "an arbitrary host"],
    // Suffix matching must be anchored on a dot boundary and on the HOST, not
    // anywhere in the URL — these are the three shapes that break a naive
    // `endpoint.includes(suffix)` or `host.endsWith(suffix)` check.
    ["https://notgoogleapis.com/x", "a host that merely ends in the suffix text"],
    ["https://evil.com/googleapis.com", "the suffix hidden in the path"],
    ["https://evil.com/?to=fcm.googleapis.com", "the suffix hidden in the query"],
    ["https://fcm.googleapis.com.evil.com/x", "the suffix as a left-hand label"],
    ["https://evil.com#fcm.googleapis.com", "the suffix hidden in the fragment"],
  ])("rejects %s (%s)", (endpoint) => {
    expect(pushEndpointAllowed(endpoint)).toBe(false);
  });

  it.each([
    ["", "an empty string"],
    ["not a url", "an unparseable value"],
    ["//fcm.googleapis.com/x", "a scheme-relative reference"],
    [null, "null"],
    [undefined, "undefined"],
    [{ endpoint: "https://fcm.googleapis.com/x" }, "an object"],
    [["https://fcm.googleapis.com/x"], "an array"],
  ])("rejects %j (%s) instead of throwing", (endpoint) => {
    expect(pushEndpointAllowed(endpoint)).toBe(false);
  });

  it("is case-insensitive about the host, as DNS is", () => {
    expect(pushEndpointAllowed("https://FCM.GoogleAPIs.COM/fcm/send/abc")).toBe(true);
  });
});

// The lease guard is what stops a malformed claim reaching a provider, and it
// lived as two hand-copied blocks — one per channel — with no test of its own,
// so a divergence between them would have been invisible. Now that both
// channels call the same function, this is what says the guard is FOR.
describe("assertLeases", () => {
  it.each(["email", "push"])("accepts a well-formed %s batch", (scope) => {
    expect(() => assertLeases(scope, [
      { deliveryId: "d1", attempt: 1, leaseEpoch: 1 },
      { deliveryId: "d2", attempt: 7, leaseEpoch: 9 },
    ])).not.toThrow();
    // An empty claim is the ordinary "no work waiting" case, not a fault.
    expect(() => assertLeases(scope, [])).not.toThrow();
  });

  // A missing `attempt` is dropped from the JSON and silently ignored by the
  // recorder; an explicit null aborts the whole record call. Either way the row
  // stays 'sending' and is re-sent later, so the batch has to be refused BEFORE
  // a provider is contacted — on either channel.
  it.each([
    [{ deliveryId: "d1", leaseEpoch: 1 }, "a missing attempt"],
    [{ deliveryId: "d1", attempt: null, leaseEpoch: 1 }, "an explicit null attempt"],
    [{ deliveryId: "d1", attempt: "1", leaseEpoch: 1 }, "an attempt that is a string"],
    [{ deliveryId: "d1", attempt: 1.5, leaseEpoch: 1 }, "a fractional attempt"],
    [{ deliveryId: "d1", attempt: 0, leaseEpoch: 1 }, "attempt 0, which no claim ever writes"],
    [{ attempt: 1, leaseEpoch: 1 }, "no delivery id"],
    [{ deliveryId: "", attempt: 1, leaseEpoch: 1 }, "an empty delivery id"],
    [{ deliveryId: 42, attempt: 1, leaseEpoch: 1 }, "a delivery id that is not a string"],
    [{ deliveryId: "d1", attempt: 1 }, "a missing lease epoch"],
    [{ deliveryId: "d1", attempt: 1, leaseEpoch: null }, "a null lease epoch"],
    [{ deliveryId: "d1", attempt: 1, leaseEpoch: "1" }, "a string lease epoch"],
    [{ deliveryId: "d1", attempt: 1, leaseEpoch: 1.5 }, "a fractional lease epoch"],
    [{ deliveryId: "d1", attempt: 1, leaseEpoch: 0 }, "lease epoch 0"],
  ])("rejects %j (%s) on both channels", (row) => {
    for (const scope of ["email", "push"]) {
      expect(() => assertLeases(scope, [row])).toThrow(/without a usable lease/);
    }
  });

  it("refuses the whole batch when only one row is malformed", () => {
    expect(() => assertLeases("push", [
      { deliveryId: "p1", attempt: 1, leaseEpoch: 1 },
      { deliveryId: "p2", attempt: null, leaseEpoch: 1 },
    ])).toThrow(/without a usable lease/);
  });
});

describe("idempotencyKey", () => {
  it("is stable for a delivery id, which is what makes the ambiguous retry safe", () => {
    expect(idempotencyKey("d1")).toBe(idempotencyKey("d1"));
    // Same delivery arriving as a number must not mint a second key: the id
    // round-trips through JSON, and a duplicate key means a duplicate email.
    expect(idempotencyKey(42)).toBe(idempotencyKey("42"));
  });

  it("is unique per delivery, so unrelated mail is never deduplicated", () => {
    const ids = ["d1", "d2", "d10", "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
    expect(new Set(ids.map(idempotencyKey)).size).toBe(ids.length);
  });

  it("emits the prefixed 48-hex-character shape Resend is handed", () => {
    expect(idempotencyKey("d1")).toMatch(/^sg-notify-[0-9a-f]{48}$/);
  });
});
