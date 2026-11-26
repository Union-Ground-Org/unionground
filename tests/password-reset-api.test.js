// @vitest-environment node
//
// REQ-UG-SELF-SERVICE-PASSWORD-RESET-20261006: api/password-reset.js
// answers every address the same way, emails only a known account's own
// confirmed address, never hands the recovery session to the browser, sets
// the password only after an authenticator code is verified (enrolling one
// when the account has none), and writes the audit row on completion.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler, { resetTiming } from "../api/password-reset.js";
import { resetAccountMailAlerts } from "../api/_lib/accountMailAlerts.js";
import {
  loadPendingReset as loadNativePendingReset, savePendingReset as saveNativePendingReset, shareBegin,
} from "../apps/mobile/src/lib/pendingPasswordReset.ts";
import {
  openResetState, openResetTicket, passwordResetEmail, RESET_ACCOUNT, RESET_EMAIL_TIMEOUT_MS, resetAccountTag, resetStateKey, resetTicketKey,
  sealResetState, sealResetTicket,
} from "../api/_lib/passwordReset.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SAMPLE_HOST, SAMPLE_ORIGIN, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
vi.mock("../src/lib/emailLinkHosts.js", async () => (await import("./helpers/fictional-provider.js")).emailLinkHostsModule());

const SUPABASE = SUPABASE_ORIGIN;
const SERVICE = "server-secret-key-long-enough";
const USER = "11111111-2222-4333-8444-555555555555";
const FACTOR = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CHALLENGE = "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TOKEN = "a1".repeat(28);
const EMAIL_REFERENCE = "22222222-3333-4444-8555-666666666666";
// What the emailed link carries: the server's sealed ticket, never TOKEN itself.
const TICKET = sealResetTicket(resetTicketKey(SERVICE), TOKEN);
const RPC = (name) => `${SUPABASE}/rest/v1/rpc/${name}`;

function reply(payload, status = 200) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => body, json: async () => JSON.parse(body) };
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

async function run(body, headers = {}) {
  const response = recorder();
  await handler({
    method: "POST",
    headers: { host: PORTAL_HOST, origin: PORTAL_ORIGIN, "x-vercel-forwarded-for": "203.0.113.9", ...headers },
    body,
  }, response);
  return response.out;
}

// routes: { "<METHOD> <url>": reply | (call) => reply }
function backend(routes) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    const call = { method: init.method || "GET", url: String(url), headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
    Object.defineProperty(call, "signal", { value: init.signal, enumerable: false });
    calls.push(call);
    const route = routes[`${call.method} ${call.url}`];
    if (route === undefined) throw new Error(`unexpected ${call.method} ${call.url}`);
    return typeof route === "function" ? route(call) : route;
  }));
  return calls;
}

const throttle = (value = true) => ({ [`POST ${RPC("consume_password_reset_attempt")}`]: reply(value) });
const knownUser = { id: USER, email: "member@example.com", email_confirmed_at: "2026-09-01T00:00:00Z", banned_until: null, app_metadata: { union_ground_provisioning: "active" } };

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", SUPABASE_REF);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE);
  vi.stubEnv("RESEND_API_KEY", "resend-key");
  vi.stubEnv("NOTIFY_FROM_ADDRESS", "Union Ground <notify@unionground.test>");
  vi.stubEnv("INVITATION_APP_ORIGIN", PORTAL_ORIGIN);
  vi.spyOn(resetTiming, "sleep").mockResolvedValue();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("reset request", () => {
  it("answers an unknown and a known address identically and emails only the known account's own address", async () => {
    const unknownCalls = backend({
      ...throttle(),
      [`POST ${SUPABASE}/auth/v1/admin/generate_link`]: reply({ code: 404, msg: "User not found" }, 404),
    });
    const unknown = await run({ action: "request", email: "nobody@example.com", locale: "en" });
    expect(unknownCalls.some((call) => call.url.startsWith("https://api.resend.com"))).toBe(false);

    const calls = backend({
      ...throttle(),
      [`POST ${SUPABASE}/auth/v1/admin/generate_link`]: reply({ ...knownUser, hashed_token: TOKEN, verification_type: "recovery" }),
      "POST https://api.resend.com/emails": reply({ id: "email" }),
    });
    const known = await run({ action: "request", email: " Member@Example.com ", locale: "en" });

    expect(known).toEqual(unknown);
    expect(known.status).toBe(200);
    expect(known.body).toEqual({ accepted: true });
    expect(known.headers["Referrer-Policy"]).toBe("no-referrer");
    const throttled = calls.filter((call) => call.url === RPC("consume_password_reset_attempt")).map((call) => call.body);
    expect(throttled).toEqual([{ p_scope: "network", p_key: "ipv4:203.0.113.9" }, { p_scope: "email", p_key: "member@example.com" }]);
    expect(calls.find((call) => call.url.endsWith("/generate_link")).body).toEqual({ type: "recovery", email: "member@example.com" });
    const sent = calls.find((call) => call.url === "https://api.resend.com/emails").body;
    expect(sent.to).toEqual(["member@example.com"]);
    const ticket = /https:\/\/app\.unionground\.test\/app\/reset-password#token=(\S+)/.exec(sent.text)[1];
    expect(openResetTicket(resetTicketKey(SERVICE), ticket)).toBe(TOKEN);
    // GoTrue's token never reaches the mailbox, so it cannot be taken to
    // Auth's public verify endpoint to skip the second factor.
    expect(JSON.stringify(sent)).not.toContain(TOKEN);
    expect(JSON.stringify(sent)).not.toContain("access_token");
    // Both branches are held to the same timing floor, and the floor covers
    // the one wait only a real account reaches: the email send.
    expect(resetTiming.sleep).toHaveBeenCalledTimes(2);
    expect(resetTiming.floorMs).toBeGreaterThan(RESET_EMAIL_TIMEOUT_MS);
  });

  it("sends distinct, secret-free subjects for two requests captured at the same instant", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-17T22:00:00.100-04:00"));
      let minted = 0;
      const calls = backend({
        ...throttle(),
        [`POST ${SUPABASE}/auth/v1/admin/generate_link`]: () => reply({ ...knownUser, hashed_token: minted++ ? "b2".repeat(28) : TOKEN, verification_type: "recovery" }),
        "POST https://api.resend.com/emails": reply({ id: "email" }),
      });
      await run({ action: "request", email: "member@example.com" });
      await run({ action: "request", email: "member@example.com" });
      const sent = calls.filter((call) => call.url === "https://api.resend.com/emails").map((call) => call.body);
      expect(sent).toHaveLength(2);
      expect(sent[0].subject).not.toBe(sent[1].subject);
      for (const mail of sent) {
        expect(mail.subject).toContain("10:00:00 PM EDT");
        for (const secret of [TOKEN, "b2".repeat(28), SERVICE, "member@example.com", "token=", "https://"]) {
          expect(mail.subject).not.toContain(secret);
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["http", "network"])("retries a failed %s send with one minted link and an identical idempotent payload", async (failure) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let attempts = 0;
      const calls = backend({
        ...throttle(),
        [`POST ${SUPABASE}/auth/v1/admin/generate_link`]: reply({ ...knownUser, hashed_token: TOKEN, verification_type: "recovery" }),
        "POST https://api.resend.com/emails": () => {
          if (attempts++ > 0) return reply({ id: "email" });
          // A later retry must still carry the original email's timestamp.
          vi.setSystemTime(Date.now() + 1000);
          if (failure === "network") throw new Error("timeout");
          return reply({}, 500);
        },
      });
      expect(await run({ action: "request", email: "member@example.com" })).toMatchObject({ status: 200, body: { accepted: true } });
      expect(calls.filter((call) => call.url.endsWith("/generate_link"))).toHaveLength(1);
      const sent = calls.filter((call) => call.url === "https://api.resend.com/emails");
      expect(sent).toHaveLength(2);
      expect(sent[0].headers["Idempotency-Key"]).toMatch(/^ug-reset-/);
      expect(sent[1]).toEqual(sent[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a lasting send failure privately without secrets and answers identically to an unknown address", async () => {
    resetAccountMailAlerts();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = backend({
      ...throttle(),
      [`POST ${SUPABASE}/auth/v1/admin/generate_link`]: reply({ ...knownUser, hashed_token: TOKEN, verification_type: "recovery" }),
      "POST https://api.resend.com/emails": reply({ message: "private provider detail" }, 500),
    });
    const failed = await run({ action: "request", email: "member@example.com" });
    backend({ ...throttle(), [`POST ${SUPABASE}/auth/v1/admin/generate_link`]: reply({}, 404) });
    expect(failed).toEqual(await run({ action: "request", email: "nobody@example.com" }));
    expect(failed).toMatchObject({ status: 200, body: { accepted: true } });
    expect(calls.filter((call) => call.url.endsWith("/generate_link"))).toHaveLength(1);
    expect(calls.filter((call) => call.url === "https://api.resend.com/emails")).toHaveLength(2);
    // REQ-UG-SIGNUP-AND-ACCOUNT-MAIL-FAILURES-RAISE-NO-PRIVATE-ALERT-20261111:
    // one content-free record (kind and count), no address, token or provider detail.
    expect(warn.mock.calls).toEqual([[JSON.stringify({ event: "account-mail-failure", kind: "reset_send_failed", count: 1 })]]);
    expect(error).not.toHaveBeenCalled();
  });

  it("answers a confirmed address at the same time as an unknown one even when Auth or the mail provider is slow", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    resetTiming.sleep.mockImplementation((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const linked = reply({ ...knownUser, hashed_token: TOKEN, verification_type: "recovery" });
    // A call that never answers on its own; aborting it rejects it, like fetch.
    const hang = (init) => new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    const aborted = [];
    async function timed(email, route) {
      vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
        if (String(url) === RPC("consume_password_reset_attempt")) return reply(true);
        const answer = route(String(url), init);
        if (answer instanceof Promise) answer.catch(() => aborted.push(String(url)));
        return answer;
      }));
      const startedAt = Date.now();
      let doneAt = null;
      const done = run({ action: "request", email }).then((out) => { doneAt = Date.now(); return out; });
      await vi.advanceTimersByTimeAsync(20_000);
      return { out: await done, elapsed: doneAt - startedAt };
    }

    const unknown = await timed("nobody@example.com", () => reply({ code: 404, msg: "User not found" }, 404));
    const slowAuth = await timed("member@example.com", (url, init) => hang(init));
    const slowSend = await timed("member@example.com", (url, init) => (url.endsWith("/generate_link") ? linked : hang(init)));
    let sends = 0;
    const slowRetry = await timed("member@example.com", (url, init) => {
      if (url.endsWith("/generate_link")) return linked;
      return sends++ === 0 ? reply({}, 500) : hang(init);
    });
    vi.useRealTimers();

    expect(unknown.elapsed).toBe(resetTiming.floorMs);
    for (const slow of [slowAuth, slowSend, slowRetry]) {
      expect(slow.out).toEqual(unknown.out);
      expect(slow.elapsed).toBe(unknown.elapsed);
    }
    // The slow calls were aborted at the deadline, not left to run on.
    expect(sends).toBe(2);
    expect(aborted).toEqual([`${SUPABASE}/auth/v1/admin/generate_link`, "https://api.resend.com/emails", "https://api.resend.com/emails"]);
    const logged = console.warn.mock.calls.map(([line]) => line).join("\n");
    expect(logged).toContain("password-reset-request-deadline");
    // A send the deadline cut short is unknown, not failed: the provider may
    // have taken it. Nothing was sent for the slow Auth call, so it records nothing.
    expect(console.warn.mock.calls.map(([line]) => JSON.parse(line)).filter((entry) => entry.event === "account-mail-failure").map((entry) => entry.kind))
      .toEqual(["reset_send_unconfirmed", "reset_send_unconfirmed"]);
    expect(logged).not.toContain("member@example.com");
    expect(logged).not.toContain(TOKEN);
  });

  it("does not email an unconfirmed, banned or still-pending account", async () => {
    for (const user of [
      { ...knownUser, email_confirmed_at: null },
      { ...knownUser, banned_until: "2999-01-01T00:00:00Z" },
      { ...knownUser, app_metadata: { union_ground_provisioning: "pending" } },
    ]) {
      const calls = backend({
        ...throttle(),
        [`POST ${SUPABASE}/auth/v1/admin/generate_link`]: reply({ ...user, hashed_token: TOKEN, verification_type: "recovery" }),
      });
      const out = await run({ action: "request", email: "member@example.com" });
      expect(out).toMatchObject({ status: 200, body: { accepted: true } });
      expect(calls.some((call) => call.url.startsWith("https://api.resend.com"))).toBe(false);
    }
  });

  it("answers 429 over a limit and fails closed without the throttle, before Auth is asked", async () => {
    let calls = backend(throttle(false));
    expect(await run({ action: "request", email: "member@example.com" })).toMatchObject({ status: 429, body: { error: "try-later" } });
    expect(calls.map((call) => call.url)).toEqual([RPC("consume_password_reset_attempt")]);

    calls = backend({ [`POST ${RPC("consume_password_reset_attempt")}`]: reply({ code: "PGRST202", message: "missing" }, 404) });
    expect(await run({ action: "request", email: "member@example.com" })).toMatchObject({ status: 503, body: { error: "reset-unavailable" } });
    expect(calls.some((call) => call.url.includes("/auth/v1/"))).toBe(false);
  });

  it("is not offered on the SAMPLE surface", async () => {
    const calls = backend({});
    const out = await run({ action: "request", email: "member@example.com" }, { host: SAMPLE_HOST, origin: SAMPLE_ORIGIN });
    // Union Ground trusts no sample portal, so the demo host is refused at the origin check.
    expect(out.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe("reset email copy", () => {
  it.each([
    ["en", "2026-10-17T22:00:00-04:00", "October 17, 2026 at 10:00:00 PM EDT", "October 17, 2026 at 10:01:00 PM EDT"],
    ["en", "2026-01-17T22:00:00-05:00", "January 17, 2026 at 10:00:00 PM EST", "January 17, 2026 at 10:01:00 PM EST"],
  ])("distinguishes %s reset subjects using the body's Eastern send time (%s)", (locale, at, firstTime, secondTime) => {
    const sentAt = new Date(at);
    const link = `${PORTAL_ORIGIN}/app/reset-password#token=${TICKET}`;
    const first = passwordResetEmail(locale, link, sentAt, EMAIL_REFERENCE);
    const second = passwordResetEmail(locale, link, new Date(sentAt.getTime() + 60_000), EMAIL_REFERENCE);
    const title = locale === "es" ? "Restablece tu contraseña de Union Ground" : "Reset your Union Ground password";
    expect(first.subject).toBe(`${title} — ${firstTime} (${sentAt.toISOString().slice(0, 23).replace("T", " ")} UTC) [${EMAIL_REFERENCE}]`);
    expect(second.subject).toBe(`${title} — ${secondTime} (${new Date(sentAt.getTime() + 60_000).toISOString().slice(0, 23).replace("T", " ")} UTC) [${EMAIL_REFERENCE}]`);
    expect(second.subject).not.toBe(first.subject);
    for (const [message, time] of [[first, firstTime], [second, secondTime]]) {
      expect(message.text).toContain(time);
      expect(message.html).toContain(time);
      for (const secret of [TOKEN, TICKET, SERVICE, link, "#token=", "access_token", "member@example.com"]) {
        expect(message.subject).not.toContain(secret);
      }
    }
  });

  it("distinguishes overlapping sends within one second without changing the body timestamp", () => {
    const first = passwordResetEmail("en", "https://example.invalid/reset", new Date("2026-10-17T22:00:00.100-04:00"));
    const second = passwordResetEmail("en", "https://example.invalid/reset", new Date("2026-10-17T22:00:00.200-04:00"));
    expect(first.subject).toContain("10:00:00 PM EDT (2026-10-18 02:00:00.100 UTC)");
    expect(second.subject).toContain("10:00:00 PM EDT (2026-10-18 02:00:00.200 UTC)");
    expect(second.subject).not.toBe(first.subject);
    expect(first.text).toBe(second.text);
    expect(first.html).toBe(second.html);
  });

  it("distinguishes independent messages even when their captured send times are identical", () => {
    const sentAt = new Date("2026-10-17T22:00:00.100-04:00");
    const first = passwordResetEmail("en", "https://example.invalid/reset", sentAt);
    const second = passwordResetEmail("en", "https://example.invalid/reset", sentAt);
    expect(first.subject).toMatch(/\[[0-9a-f-]{36}\]$/);
    expect(second.subject).not.toBe(first.subject);
    expect(second.text).toBe(first.text);
    expect(second.html).toBe(first.html);
  });

  it("keeps the send instants unambiguous through the Eastern fall-back hour", () => {
    const first = passwordResetEmail("en", "https://example.invalid/reset", new Date("2026-11-01T01:30:50-04:00"));
    const second = passwordResetEmail("en", "https://example.invalid/reset", new Date("2026-11-01T01:30:10-05:00"));
    expect(first.subject).toContain("1:30:50 AM EDT (2026-11-01 05:30:50.000 UTC)");
    expect(second.subject).toContain("1:30:10 AM EST (2026-11-01 06:30:10.000 UTC)");
  });

  it("is written in Spanish for a Spanish request and names the 15-minute, single-use, newest-link rules", () => {
    const sentAt = new Date("2026-10-08T05:30:00Z");
    const es = passwordResetEmail("es", `${PORTAL_ORIGIN}/app/reset-password#token=x`, sentAt, EMAIL_REFERENCE);
    expect(es.subject).toMatch(/^Restablece tu contraseña de Union Ground — .*EDT \(.* UTC\) \[/);
    expect(es.text).toContain("dentro de 15 minutos");
    expect(es.text).toContain("solo funciona el enlace más reciente");
    expect(es.text).toContain("app de autenticación");
    expect(es.html).toContain('lang="es"');
    expect(es.text).toMatch(/Enviado el .*2026/);
    const sent = es.text.split("\n").at(-1).replace(/^Enviado el /, "").replace(/\.$/, "");
    expect(es.subject).toBe(`Restablece tu contraseña de Union Ground — ${sent} (2026-10-08 05:30:00.000 UTC) [${EMAIL_REFERENCE}]`);
    const en = passwordResetEmail("en", `${PORTAL_ORIGIN}/app/reset-password#token=x`, sentAt);
    expect(en.text).toContain("only the newest reset link works");
    expect(en.text).toContain("1:30:00 AM EDT");
  });
});

describe("reset begin", () => {
  const verify = { [`POST ${SUPABASE}/auth/v1/verify`]: reply({ access_token: "aal1-token", refresh_token: "refresh-secret", user: { id: USER } }) };

  it("keeps the saved native recovery attached to a live factor when different tickets overlap", async () => {
    const secondFactor = "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const secondToken = "b2".repeat(28);
    const secondTicket = sealResetTicket(resetTicketKey(SERVICE), secondToken);
    const factors = new Map();
    const values = new Map();
    const store = {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => { values.set(key, value); },
      removeItem: async (key) => { values.delete(key); },
    };
    let releaseFirst;
    let firstReachedList;
    const holdFirst = new Promise((resolve) => { releaseFirst = resolve; });
    const firstAtList = new Promise((resolve) => { firstReachedList = resolve; });
    let listings = 0;
    backend({
      ...throttle(),
      [`POST ${SUPABASE}/auth/v1/verify`]: (call) => reply({
        access_token: call.body.token_hash === TOKEN ? "session-a" : "session-b", user: { id: USER },
      }),
      [`GET ${SUPABASE}/auth/v1/admin/users/${USER}/factors`]: async () => {
        if (listings++ === 0) { firstReachedList(); await holdFirst; }
        return reply([...factors.values()]);
      },
      [`POST ${SUPABASE}/auth/v1/factors`]: (call) => {
        const id = call.headers.Authorization === "Bearer session-a" ? FACTOR : secondFactor;
        factors.set(id, { id, factor_type: "totp", status: "unverified" });
        return reply({ id, totp: { secret: "JBSWY3DPEHPK3PXP" } });
      },
      ...Object.fromEntries([FACTOR, secondFactor].map((id) => [
        `DELETE ${SUPABASE}/auth/v1/admin/users/${USER}/factors/${id}`,
        () => { factors.delete(id); return reply({}); },
      ])),
    });
    const begin = (ticket) => shareBegin(ticket, async (attempt) => {
      const result = await run({ action: "begin", token: ticket });
      expect(result.status).toBe(200);
      await saveNativePendingReset({ ticket, ...attempt, recovery: {
        status: result.body.mode, state: result.body.state, secret: result.body.secret,
      } }, store);
    });
    const first = begin(TICKET);
    await firstAtList;
    const second = begin(secondTicket);
    // Let an unqueued second request finish its immediate mocked Auth calls.
    // A serialized implementation instead waits behind the held first call.
    await new Promise((resolve) => setImmediate(resolve));
    releaseFirst();
    await Promise.all([first, second]);
    const saved = await loadNativePendingReset(store);
    expect(saved.ticket).toBe(secondTicket);
    const state = openResetState(resetStateKey(SERVICE), saved.state);
    expect(factors.has(state.factorId)).toBe(true);
    expect(state.factorId).toBe(secondFactor);
  });

  it("asks for the existing authenticator and never returns the recovery session", async () => {
    const calls = backend({
      ...throttle(), ...verify,
      [`GET ${SUPABASE}/auth/v1/admin/users/${USER}/factors`]: reply([{ id: FACTOR, factor_type: "totp", status: "verified" }]),
    });
    const out = await run({ action: "begin", token: TICKET });
    expect(out.status).toBe(200);
    expect(out.body.mode).toBe("challenge");
    expect(JSON.stringify(out.body)).not.toMatch(/aal1-token|refresh-secret/);
    expect(openResetState(resetStateKey(SERVICE), out.body.state)).toEqual({ accessToken: "aal1-token", userId: USER, factorId: FACTOR, mode: "challenge" });
    expect(calls.find((call) => call.url.endsWith("/auth/v1/verify")).body).toEqual({ type: "recovery", token_hash: TOKEN });
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("enrolls an authenticator for an account without one, clearing a stale unverified factor first", async () => {
    const stale = "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const calls = backend({
      ...throttle(), ...verify,
      [`GET ${SUPABASE}/auth/v1/admin/users/${USER}/factors`]: reply([{ id: stale, factor_type: "totp", status: "unverified" }]),
      [`DELETE ${SUPABASE}/auth/v1/admin/users/${USER}/factors/${stale}`]: reply({}),
      [`POST ${SUPABASE}/auth/v1/factors`]: reply({ id: FACTOR, totp: { qr_code: "data:image/svg+xml;utf-8,<svg/>", secret: "JBSWY3DPEHPK3PXP" } }),
    });
    const out = await run({ action: "begin", token: TICKET });
    expect(out.body).toMatchObject({ mode: "enroll", qr: "data:image/svg+xml;utf-8,<svg/>", secret: "JBSWY3DPEHPK3PXP", account: resetAccountTag(SERVICE, USER) });
    const enroll = calls.find((call) => call.url === `${SUPABASE}/auth/v1/factors`);
    expect(enroll.headers.Authorization).toBe("Bearer aal1-token");
    expect(enroll.body.factor_type).toBe("totp");
    expect(calls.map((call) => call.method)).toContain("DELETE");
  });

  it.each([
    ["rate limit", reply({}, 429)],
    ["provider refusal", reply({}, 500)],
    ["lost reply", () => { throw new Error("offline"); }],
    ["empty enrollment", reply({})],
  ])("distinguishes invalidated enrollment after deletion and %s", async (_label, result) => {
    backend({ ...throttle(), ...verify,
      [`GET ${SUPABASE}/auth/v1/admin/users/${USER}/factors`]: reply([{ id: FACTOR, factor_type: "totp", status: "unverified" }]),
      [`DELETE ${SUPABASE}/auth/v1/admin/users/${USER}/factors/${FACTOR}`]: reply({}),
      [`POST ${SUPABASE}/auth/v1/factors`]: result,
    });
    const out = await run({ action: "begin", token: TICKET });
    expect(out.body.error).toBe("reset-invalidated");
    expect(Object.keys(out.body).sort()).toEqual(["account", "error", "reason"]);
    // Names the account whose enrolment changed, never its id.
    expect(out.body.account).toBe(resetAccountTag(SERVICE, USER));
  });

  // BUG-UG-RESET-PENDING-RECORD-ACCOUNT-BINDING-20261021.
  it("tags every begin answer with an opaque account tag that is stable per account and never the user id", async () => {
    backend({ ...throttle(), ...verify,
      [`GET ${SUPABASE}/auth/v1/admin/users/${USER}/factors`]: reply([{ id: FACTOR, factor_type: "totp", status: "verified" }]),
    });
    const challenge = await run({ action: "begin", token: TICKET });
    expect(challenge.body.mode).toBe("challenge");
    expect(challenge.body.account).toMatch(RESET_ACCOUNT);
    expect(challenge.body.account).toBe(resetAccountTag(SERVICE, USER));
    expect(JSON.stringify(challenge.body)).not.toContain(USER);
    expect(resetAccountTag(SERVICE, USER.toUpperCase())).toBe(challenge.body.account);
    expect(resetAccountTag(SERVICE, "22222222-3333-4444-8555-666666666666")).not.toBe(challenge.body.account);
    expect(resetAccountTag("another-service-key-long-enough", USER)).not.toBe(challenge.body.account);
    expect(resetAccountTag(SERVICE, "not-a-user")).toBeNull();
    expect(resetAccountTag("short", USER)).toBeNull();
  });

  it.each([false, true])("reports possible invalidation when a deletion fails (earlier deletion: %s)", async (earlierDelete) => {
    const second = "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const calls = backend({ ...throttle(), ...verify,
      [`GET ${SUPABASE}/auth/v1/admin/users/${USER}/factors`]: reply((earlierDelete ? [FACTOR, second] : [second]).map((id) => ({ id, factor_type: "totp", status: "unverified" }))),
      [`DELETE ${SUPABASE}/auth/v1/admin/users/${USER}/factors/${FACTOR}`]: reply({}),
      [`DELETE ${SUPABASE}/auth/v1/admin/users/${USER}/factors/${second}`]: () => { throw new Error("lost deletion reply"); },
    });
    expect(await run({ action: "begin", token: TICKET })).toMatchObject({ body: { error: "reset-invalidated" } });
    expect(calls.some((call) => call.url === `${SUPABASE}/auth/v1/factors`)).toBe(false);
  });

  it("still invalidates the prior enrollment when a later deletion is throttled", async () => {
    const second = "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    backend({ ...throttle(), ...verify,
      [`GET ${SUPABASE}/auth/v1/admin/users/${USER}/factors`]: reply([FACTOR, second].map(id => ({ id, factor_type: "totp", status: "unverified" }))),
      [`DELETE ${SUPABASE}/auth/v1/admin/users/${USER}/factors/${FACTOR}`]: reply({}),
      [`DELETE ${SUPABASE}/auth/v1/admin/users/${USER}/factors/${second}`]: reply({}, 429),
    });
    expect(await run({ action: "begin", token: TICKET })).toMatchObject({ status: 429, body: { error: "reset-invalidated", reason: "try-later" } });
  });

  it.each([
    [reply({}, 500), 502, "reset-unavailable", true],
    [reply({}, 404), 502, "reset-unavailable", true],
    [reply({}, 429), 429, "try-later", false],
    [reply({}, 403), 502, "reset-unavailable", false],
    [() => { throw new Error("offline"); }, 503, "reset-unavailable", true],
  ])("stops before enrolment when stale factor cleanup fails (%s)", async (answer, status, error, invalidated) => {
    const calls = backend({
      ...throttle(), ...verify,
      [`GET ${SUPABASE}/auth/v1/admin/users/${USER}/factors`]: reply([{ id: FACTOR, factor_type: "totp", status: "unverified" }]),
      [`DELETE ${SUPABASE}/auth/v1/admin/users/${USER}/factors/${FACTOR}`]: answer,
      [`POST ${SUPABASE}/auth/v1/factors`]: reply({ id: FACTOR, totp: { secret: "secret" } }),
    });
    expect(await run({ action: "begin", token: TICKET })).toMatchObject({ status,
      body: invalidated ? { error: "reset-invalidated", reason: error } : { error } });
    expect(calls.some((call) => call.url === `${SUPABASE}/auth/v1/factors` || call.method === "PUT")).toBe(false);
  });

  it.each([
    [500, "unexpected_failure", 502, "reset-unavailable"],
    [429, "over_request_rate_limit", 429, "try-later"],
    [422, "mfa_factor_name_conflict", 502, "reset-unavailable"],
  ])("offers recovery from an enrolment refusal (%s) instead of requiring staff", async (providerStatus, code, status, error) => {
    const calls = backend({
      ...throttle(), ...verify,
      [`GET ${SUPABASE}/auth/v1/admin/users/${USER}/factors`]: reply([]),
      [`POST ${SUPABASE}/auth/v1/factors`]: reply({ error_code: code }, providerStatus),
    });
    expect(await run({ action: "begin", token: TICKET })).toMatchObject({ status, body: { error } });
    expect(calls.some((call) => call.method === "PUT" || call.url.includes("record_self_service"))).toBe(false);
  });

  it("refuses, without changing anything, when two-step cannot be set up", async () => {
    const calls = backend({
      ...throttle(), ...verify,
      [`GET ${SUPABASE}/auth/v1/admin/users/${USER}/factors`]: reply([]),
      [`POST ${SUPABASE}/auth/v1/factors`]: reply({ error_code: "mfa_totp_enroll_not_enabled" }, 422),
    });
    expect(await run({ action: "begin", token: TICKET })).toMatchObject({ status: 409, body: { error: "two-step-unavailable" } });
    expect(calls.some((call) => call.method === "PUT" || call.url.includes("record_self_service"))).toBe(false);
  });

  it("answers link-invalid for a used, expired or malformed link", async () => {
    backend({ ...throttle(), [`POST ${SUPABASE}/auth/v1/verify`]: reply({ error_code: "otp_expired" }, 403) });
    expect(await run({ action: "begin", token: TICKET })).toMatchObject({ status: 400, body: { error: "link-invalid" } });
    const calls = backend({});
    const foreign = sealResetTicket(resetTicketKey("another-service-key-long-enough"), TOKEN);
    const expired = sealResetTicket(resetTicketKey(SERVICE), TOKEN, Date.now() - 15 * 60 * 1000);
    for (const token of ["not-a-token", TOKEN, foreign, expired, `${TICKET}x`]) {
      expect(await run({ action: "begin", token })).toMatchObject({ status: 400, body: { error: "link-invalid" } });
    }
    expect(calls).toEqual([]);
  });
});

// BUG-UG-AUTHENTICATED-NATIVE-RESET-RESUME-20261021: Account offers a
// saved reset only when its tag is the signed-in account's, which only this
// route can compute.
describe("signed-in account tag", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("answers the bearer's own reset tag, the same tag begin saved", async () => {
    const calls = backend({ [`GET ${SUPABASE}/auth/v1/user`]: reply({ id: USER }) });
    const out = await run({ action: "account" }, { authorization: "Bearer member-token" });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ account: resetAccountTag(SERVICE, USER) });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe("Bearer member-token");
  });

  it("answers 401 without a bearer and asks Auth nothing", async () => {
    const calls = backend({});
    const out = await run({ action: "account" });
    expect(out).toMatchObject({ status: 401, body: { error: "not-signed-in" } });
    expect(calls).toHaveLength(0);
  });

  it("answers 401 for a token Auth refuses or a user without an id", async () => {
    backend({ [`GET ${SUPABASE}/auth/v1/user`]: reply({ message: "invalid" }, 401) });
    expect((await run({ action: "account" }, { authorization: "Bearer stale" })).status).toBe(401);
    backend({ [`GET ${SUPABASE}/auth/v1/user`]: reply({}) });
    expect((await run({ action: "account" }, { authorization: "Bearer odd" })).status).toBe(401);
  });

  it("answers 503 when Auth cannot be reached", async () => {
    backend({ [`GET ${SUPABASE}/auth/v1/user`]: () => { throw new Error("down"); } });
    expect(await run({ action: "account" }, { authorization: "Bearer member-token" })).toMatchObject({ status: 503, body: { error: "reset-unavailable" } });
  });
});

describe("reset finish", () => {
  const PASSWORD = "a-brand-new-password-long-enough";
  function state(mode = "challenge") {
    return sealResetState(resetStateKey(SERVICE), { accessToken: "aal1-token", userId: USER, factorId: FACTOR, mode });
  }
  const challenge = { [`POST ${SUPABASE}/auth/v1/factors/${FACTOR}/challenge`]: reply({ id: CHALLENGE }) };
  const ISSUED = "2026-10-21T14:00:00.000Z";
  const OPERATION = "11111111-1111-4111-8111-111111111111";
  const stamped = (issuedAt, operation = null) => ({ id: USER, user_metadata: issuedAt ? { union_ground_password_issued_at: issuedAt } : {},
    app_metadata: operation ? { union_ground_password_reissue_operation_id: operation } : {} });
  const admin = `${SUPABASE}/auth/v1/admin/users/${USER}`;
  const clearStamp = (value) => ({ [`PUT ${admin}`]: value });
  // Successive answers on one route; the last one repeats.
  const answers = (...replies) => { let index = 0; return () => replies[Math.min(index++, replies.length - 1)]; };
  // Everything after the code check, with the password update answering
  // `atUpdate` and the service-role reads (the compare, then the restore check)
  // answering `reads` in turn.
  const finishRoutes = (atUpdate, reads = [reply({}, 500)], extra = {}) => ({
    ...throttle(), ...challenge,
    [`POST ${SUPABASE}/auth/v1/factors/${FACTOR}/verify`]: reply({ access_token: "aal2-token" }),
    [`PUT ${SUPABASE}/auth/v1/user`]: reply(stamped(atUpdate, OPERATION)),
    [`GET ${admin}`]: answers(...reads),
    ...clearStamp(reply({ id: USER })),
    ...extra,
    [`POST ${RPC("end_member_auth_sessions")}`]: reply({ ended: true }),
    [`POST ${RPC("record_self_service_password_reset")}`]: reply(true),
  });

  it("verifies the authenticator before the password, sets it from the AAL2 session, ends sessions and writes the audit row", async () => {
    const calls = backend({
      ...throttle(), ...challenge,
      [`POST ${SUPABASE}/auth/v1/factors/${FACTOR}/verify`]: reply({ access_token: "aal2-token" }),
      [`PUT ${SUPABASE}/auth/v1/user`]: reply(stamped(ISSUED, OPERATION)),
      [`GET ${admin}`]: answers(reply(stamped(ISSUED, OPERATION)), reply(stamped(null, OPERATION))),
      ...clearStamp(reply({ id: USER })),
      [`POST ${RPC("end_member_auth_sessions")}`]: reply({ ended: true }),
      [`POST ${RPC("record_self_service_password_reset")}`]: reply(true),
    });
    const out = await run({ action: "finish", state: state("enroll"), code: "123 456", password: PASSWORD });
    expect(out).toMatchObject({ status: 200, body: { completed: true, sessionsEnded: true, audited: true } });
    const order = calls.map((call) => `${call.method} ${call.url.replace(SUPABASE, "")}`);
    expect(order).toEqual([
      "POST /rest/v1/rpc/consume_password_reset_attempt",
      `POST /auth/v1/factors/${FACTOR}/challenge`,
      `POST /auth/v1/factors/${FACTOR}/verify`,
      "PUT /auth/v1/user",
      `GET /auth/v1/admin/users/${USER}`,
      `PUT /auth/v1/admin/users/${USER}`,
      `GET /auth/v1/admin/users/${USER}`,
      "POST /rest/v1/rpc/end_member_auth_sessions",
      "POST /rest/v1/rpc/record_self_service_password_reset",
    ]);
    expect(calls[0].body).toEqual({ p_scope: "code", p_key: USER });
    expect(calls[2].body).toEqual({ challenge_id: CHALLENGE, code: "123456" });
    const [update, stamp, ...rest] = calls.filter((call) => call.method === "PUT");
    expect(rest).toEqual([]);
    expect(update.headers.Authorization).toBe("Bearer aal2-token");
    // The password is written alone; clearing the emailed-password stamp is its own later call.
    expect(update.body).toEqual({ password: PASSWORD });
    // The stamp is cleared with the service role, never the recovery bearer.
    expect(stamp.headers.apikey).toBe(SERVICE);
    expect(stamp.headers.Authorization).not.toBe("Bearer aal2-token");
    expect(stamp.body).toEqual({ user_metadata: { union_ground_password_issued_at: null } });
    expect(calls.indexOf(stamp)).toBeGreaterThan(calls.indexOf(update));
    expect(calls.at(-1).body).toEqual({ p_user_id: USER, p_enrolled_two_step: true });
  });

  it("keeps a newer stamp a staff reissue wrote between the password update and the clear", async () => {
    const reissued = "2026-10-21T14:00:05.000Z";
    const calls = backend(finishRoutes(ISSUED, [reply(stamped(reissued, "22222222-2222-4222-8222-222222222222"))]));
    expect(await run({ action: "finish", state: state(), code: "123456", password: PASSWORD }))
      .toMatchObject({ status: 200, body: { completed: true } });
    const puts = calls.filter((call) => call.method === "PUT");
    expect(puts.map((call) => call.body)).toEqual([{ password: PASSWORD }]);
  });

  it("puts the stamp back when a reissue stamped while the clear was in flight", async () => {
    // The clear's write landed after the reissue's: the stamp is gone, the operation is new.
    let calls = backend(finishRoutes(ISSUED, [reply(stamped(ISSUED, OPERATION)), reply(stamped(null, "22222222-2222-4222-8222-222222222222"))]));
    expect(await run({ action: "finish", state: state(), code: "123456", password: PASSWORD })).toMatchObject({ status: 200 });
    const [clear, restore, ...more] = calls.filter((call) => call.method === "PUT" && call.url === admin);
    expect(more).toEqual([]);
    expect(clear.body).toEqual({ user_metadata: { union_ground_password_issued_at: null } });
    expect(restore.headers.Authorization).toBe(`Bearer ${SERVICE}`);
    expect(Object.keys(restore.body)).toEqual(["user_metadata"]);
    expect(Date.parse(restore.body.user_metadata.union_ground_password_issued_at)).not.toBeNaN();
    // The same operation as at the password update: nothing to put back.
    calls = backend(finishRoutes(ISSUED, [reply(stamped(ISSUED, OPERATION)), reply(stamped(null, OPERATION))]));
    expect(await run({ action: "finish", state: state(), code: "123456", password: PASSWORD })).toMatchObject({ status: 200 });
    expect(calls.filter((call) => call.method === "PUT").map((call) => call.url)).toEqual([`${SUPABASE}/auth/v1/user`, admin]);
  });

  it("leaves the stamp when the service-role read fails, and reads nothing when there was no stamp", async () => {
    for (const read of [reply({}, 500), () => { throw new Error("offline"); }]) {
      const calls = backend(finishRoutes(ISSUED, [read]));
      expect(await run({ action: "finish", state: state(), code: "123456", password: PASSWORD })).toMatchObject({ status: 200 });
      expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    }
    const calls = backend(finishRoutes(null));
    expect(await run({ action: "finish", state: state(), code: "123456", password: PASSWORD })).toMatchObject({ status: 200 });
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    expect(calls.some((call) => call.method === "GET")).toBe(false);
  });

  it("clears the emailed-password stamp even when the password update revokes the recovery session", async () => {
    // BUG-UG-RESET-CLEARS-ISSUED-PASSWORD-STAMP-WITH-SERVICE-ROLE-20261021:
    // once the password PUT has revoked aal2-token, any later call on that
    // bearer is refused, so the clear must not depend on it.
    let revoked = false;
    const metadata = { union_ground_password_issued_at: "2026-10-01T00:00:00.000Z" };
    const current = () => reply({ id: USER, user_metadata: { ...metadata }, app_metadata: { union_ground_password_reissue_operation_id: OPERATION } });
    const calls = backend({
      ...throttle(), ...challenge,
      [`POST ${SUPABASE}/auth/v1/factors/${FACTOR}/verify`]: reply({ access_token: "aal2-token" }),
      [`PUT ${SUPABASE}/auth/v1/user`]: (call) => {
        if (revoked || call.headers.Authorization !== "Bearer aal2-token") return reply({ msg: "session_not_found" }, 403);
        revoked = true;
        return current();
      },
      [`GET ${admin}`]: (call) => (call.headers.apikey !== SERVICE || call.headers.Authorization === "Bearer aal2-token" ? reply({}, 401) : current()),
      ...clearStamp((call) => {
        if (call.headers.apikey !== SERVICE || call.headers.Authorization === "Bearer aal2-token") return reply({}, 401);
        for (const [key, value] of Object.entries(call.body.user_metadata)) {
          if (value === null) delete metadata[key];
          else metadata[key] = value;
        }
        return reply({ id: USER, user_metadata: metadata });
      }),
      [`POST ${RPC("end_member_auth_sessions")}`]: reply({ ended: true }),
      [`POST ${RPC("record_self_service_password_reset")}`]: reply(true),
    });
    const out = await run({ action: "finish", state: state(), code: "123456", password: PASSWORD });
    expect(out).toMatchObject({ status: 200, body: { completed: true, sessionsEnded: true, audited: true } });
    expect(revoked).toBe(true);
    expect(metadata).not.toHaveProperty("union_ground_password_issued_at");
    expect(calls.filter((call) => call.url === `${SUPABASE}/auth/v1/user`)).toHaveLength(1);
  });

  it("keeps the changed password and completes when the stamp clear fails", async () => {
    for (const answer of [reply({}, 500), () => { throw new Error("offline"); }]) {
      const calls = backend(finishRoutes(ISSUED, [reply(stamped(ISSUED, OPERATION))], clearStamp(answer)));
      const out = await run({ action: "finish", state: state(), code: "123456", password: PASSWORD });
      expect(out).toMatchObject({ status: 200, body: { completed: true, sessionsEnded: true, audited: true } });
      // The password was written once, before the clear, and nothing tried to undo it.
      const passwordWrites = calls.filter((call) => call.url === `${SUPABASE}/auth/v1/user`);
      expect(passwordWrites.map((call) => call.body)).toEqual([{ password: PASSWORD }]);
      expect(calls.findIndex((call) => call.url === admin && call.method === "PUT"))
        .toBeGreaterThan(calls.indexOf(passwordWrites[0]));
      // A clear that did not land is followed by the restore check, which
      // finds the stamp still there and writes nothing more.
      expect(calls.filter((call) => call.url === admin && call.method === "GET")).toHaveLength(2);
      expect(calls.filter((call) => call.url === admin && call.method === "PUT")).toHaveLength(1);
    }
  });

  it("puts the stamp back when a clear that committed lost its answer while a reissue stamped", async () => {
    // BUG-UG-RESET-STAMP-RESTORE-AFTER-UNKNOWN-CLEAR-20261022: the
    // clear erases the reissue's stamp in GoTrue, then its answer is lost.
    const REISSUE = "22222222-2222-4222-8222-222222222222";
    for (const lose of [() => { throw new Error("socket hang up"); }, () => { throw new DOMException("timed out", "TimeoutError"); }]) {
      let account = stamped(ISSUED, OPERATION);
      let clears = 0;
      const calls = backend(finishRoutes(ISSUED, [], {
        [`GET ${admin}`]: () => reply(account),
        [`PUT ${admin}`]: (call) => {
          if (call.body.user_metadata["union_ground_password_issued_at"] === null) {
            clears += 1;
            account = stamped(null, REISSUE);
            return lose();
          }
          account = stamped(call.body.user_metadata["union_ground_password_issued_at"], REISSUE);
          return reply({ id: USER });
        },
      }));
      const out = await run({ action: "finish", state: state(), code: "123456", password: PASSWORD });
      expect(out).toMatchObject({ status: 200, body: { completed: true } });
      expect(clears).toBe(1);
      const [, restore, ...more] = calls.filter((call) => call.method === "PUT" && call.url === admin);
      expect(more).toEqual([]);
      expect(restore.headers.Authorization).toBe(`Bearer ${SERVICE}`);
      expect(Date.parse(account.user_metadata["union_ground_password_issued_at"])).not.toBeNaN();
      expect(account.app_metadata.union_ground_password_reissue_operation_id).toBe(REISSUE);
    }
  });

  it("never touches the password when the code is wrong", async () => {
    const calls = backend({
      ...throttle(), ...challenge,
      [`POST ${SUPABASE}/auth/v1/factors/${FACTOR}/verify`]: reply({ error_code: "mfa_verification_failed" }, 422),
    });
    expect(await run({ action: "finish", state: state(), code: "000000", password: PASSWORD }))
      .toMatchObject({ status: 400, body: { error: "code-not-accepted" } });
    expect(calls.some((call) => call.method === "PUT" || call.url.includes("record_self_service"))).toBe(false);
  });

  it("refuses a tampered or foreign state, a short password and a malformed code before calling Auth", async () => {
    const calls = backend({});
    const foreign = sealResetState(resetStateKey("another-service-key-long-enough"), { accessToken: "t", userId: USER, factorId: FACTOR, mode: "challenge" });
    expect(await run({ action: "finish", state: foreign, code: "123456", password: PASSWORD })).toMatchObject({ status: 400, body: { error: "link-invalid" } });
    expect(await run({ action: "finish", state: `${state()}x`, code: "123456", password: PASSWORD })).toMatchObject({ status: 400, body: { error: "link-invalid" } });
    expect(await run({ action: "finish", state: state(), code: "123456", password: "short" })).toMatchObject({ status: 400, body: { error: "password-rejected" } });
    for (const length of [12, 23]) {
      expect(await run({ action: "finish", state: state(), code: "123456", password: "a".repeat(length) })).toMatchObject({ status: 400, body: { error: "password-rejected" } });
    }
    expect(await run({ action: "finish", state: state(), code: "12ab56", password: PASSWORD })).toMatchObject({ status: 400, body: { error: "code-not-accepted" } });
    expect(calls).toEqual([]);
  });

  // BUG-UG-RESET-REFUSES-RECOVERY-CODE-20261018
  describe("with a saved recovery code", () => {
    const CODE = "UG-ABCD-1234-ABCD-1234";
    const HANDLE = "a".repeat(64);
    const CLAIM = "b".repeat(64);
    const SECOND = "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const PHONE = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const factorList = [
      { id: FACTOR, factor_type: "totp", status: "verified" }, { id: SECOND, factor_type: "totp", status: "unverified" },
      { id: PHONE, factor_type: "phone", status: "verified" },
    ];
    const factorUrl = (id) => `${SUPABASE}/auth/v1/admin/users/${USER}/factors/${id}`;
    const LEASE = `GET ${SUPABASE}/rest/v1/mfa_recovery_codes?select=claim_expires_at&user_id=eq.${USER}&used_at=is.null&claim_expires_at=not.is.null`;
    const recovery = (overrides = {}) => ({
      ...throttle(),
      [LEASE]: reply([]),
      [`POST ${RPC("claim_mfa_recovery_code")}`]: reply({ claimToken: CLAIM, userId: USER, sessionHandle: HANDLE, expiresIn: 120 }),
      [`GET ${SUPABASE}/auth/v1/admin/users/${USER}/factors`]: reply(factorList),
      [`POST ${RPC("prepare_mfa_recovery_signout")}`]: reply({ serverCleanupComplete: true }),
      [`POST ${RPC("prepare_password_reset_recovery")}`]: reply({ prepared: true, serverCleanupComplete: true }),
      [`POST ${RPC("cancel_password_reset_recovery")}`]: reply(true),
      [`DELETE ${factorUrl(FACTOR)}`]: reply({}),
      [`DELETE ${factorUrl(SECOND)}`]: reply({}),
      [`DELETE ${factorUrl(PHONE)}`]: reply({}),
      [`POST ${RPC("end_member_auth_sessions")}`]: reply({ ended: true }),
      [`POST ${RPC("finalize_mfa_recovery_code")}`]: reply(true),
      [`PUT ${SUPABASE}/auth/v1/admin/users/${USER}`]: reply({ id: USER }),
      [`POST ${RPC("record_self_service_password_reset")}`]: reply(true),
      ...overrides,
    });
    const send = (code = CODE, mode = "challenge") => run({ action: "finish", state: state(mode), code, password: PASSWORD });
    const steps = (calls) => calls.map((call) => `${call.method} ${call.url.replace(SUPABASE, "")}`);
    const reached = (calls, part) => calls.some((call) => call.url.includes(part));

    it("binds the recovery lock while the original Auth session is still alive", async () => {
      let sessionAlive = true;
      const prepare = (call) => reply({ serverCleanupComplete: call.body.p_cleanup === true, prepared: call.body.p_cleanup === true || sessionAlive });
      const calls = backend(recovery({
        [`POST ${RPC("prepare_mfa_recovery_signout")}`]: prepare,
        [`POST ${RPC("prepare_password_reset_recovery")}`]: prepare,
        [`PUT ${SUPABASE}/auth/v1/admin/users/${USER}`]: () => {
          sessionAlive = false; // GoTrue UpdatePassword(tx, nil) revokes every session.
          return reply({ id: USER });
        },
      }));
      expect(await send()).toMatchObject({ status: 200, body: { completed: true } });
      expect(steps(calls).indexOf("POST /rest/v1/rpc/prepare_password_reset_recovery"))
        .toBeLessThan(steps(calls).indexOf(`PUT /auth/v1/admin/users/${USER}`));
    });

    it("releases the unspent claim on a rejected password so a corrected retry can use the same code", async () => {
      let leased = false;
      let passwordAttempts = 0;
      const calls = backend(recovery({
        [`POST ${RPC("claim_mfa_recovery_code")}`]: () => {
          if (leased) return reply({ accepted: false });
          leased = true;
          return reply({ claimToken: CLAIM, userId: USER, sessionHandle: HANDLE });
        },
        [`POST ${RPC("prepare_password_reset_recovery")}`]: reply({ prepared: true, serverCleanupComplete: true }),
        [`POST ${RPC("cancel_password_reset_recovery")}`]: () => { leased = false; return reply(true); },
        [`PUT ${SUPABASE}/auth/v1/admin/users/${USER}`]: (call) => !call.body.password ? reply({ id: USER })
          : ++passwordAttempts === 1 ? reply({ error_code: "weak_password" }, 422) : reply({ id: USER }),
      }));
      expect(await send()).toMatchObject({ status: 400, body: { error: "password-rejected" } });
      expect(await send()).toMatchObject({ status: 200, body: { completed: true } });
      expect(passwordAttempts).toBe(2);
      expect(calls.find((call) => call.url.endsWith("cancel_password_reset_recovery")).body)
        .toEqual({ p_user_id: USER, p_session_handle: HANDLE, p_claim_token: CLAIM });
    });

    it("prepares the lock, sets the password, removes every factor and session, then verifies and spends the code", async () => {
      let listings = 0;
      const calls = backend(recovery({
        [`GET ${SUPABASE}/auth/v1/admin/users/${USER}/factors`]: () => reply(++listings === 1 ? factorList : []),
      }));
      expect(await send()).toMatchObject({ status: 200, body: { completed: true, sessionsEnded: true, audited: true, recoveryCodeUsed: true } });
      expect(steps(calls)).toEqual([
        LEASE.replace(`GET ${SUPABASE}`, "GET "),
        "POST /rest/v1/rpc/consume_password_reset_attempt",
        "POST /rest/v1/rpc/claim_mfa_recovery_code",
        `GET /auth/v1/admin/users/${USER}/factors`,
        "POST /rest/v1/rpc/prepare_password_reset_recovery",
        `PUT /auth/v1/admin/users/${USER}`,
        "POST /rest/v1/rpc/prepare_password_reset_recovery",
        `DELETE /auth/v1/admin/users/${USER}/factors/${FACTOR}`,
        `DELETE /auth/v1/admin/users/${USER}/factors/${SECOND}`,
        `DELETE /auth/v1/admin/users/${USER}/factors/${PHONE}`,
        "POST /rest/v1/rpc/end_member_auth_sessions",
        `GET /auth/v1/admin/users/${USER}/factors`,
        "POST /rest/v1/rpc/finalize_mfa_recovery_code",
        // No emailed-password stamp in the password update's answer, so there is nothing to clear.
        "POST /rest/v1/rpc/record_self_service_password_reset",
      ]);
      expect(calls[0].headers.Authorization).toBe(`Bearer ${SERVICE}`);
      expect(calls[1].body).toEqual({ p_scope: "code", p_key: USER });
      expect(calls[2].body).toEqual({ p_code: CODE });
      expect(calls[2].headers.Authorization).toBe("Bearer aal1-token");
      expect(calls[4].body).toEqual({ p_user_id: USER, p_session_handle: HANDLE, p_claim_token: CLAIM });
      expect(calls[5].body).toEqual({ password: PASSWORD });
      expect(calls[6].body).toEqual({ p_user_id: USER, p_session_handle: HANDLE, p_claim_token: CLAIM, p_cleanup: true });
      expect(calls.find((call) => call.url.endsWith("finalize_mfa_recovery_code")).body).toEqual({ p_user_id: USER, p_claim_token: CLAIM });
      expect(calls.at(-1).body).toEqual({ p_user_id: USER, p_enrolled_two_step: false });
    });

    // BUG-UG-RECOVERY-RESET-RETAINS-ISSUED-PASSWORD-MARKER-20261021 and
    // BUG-UG-RECOVERY-RESET-MARKER-COMPARE-AND-CLEAR-20261021: the stamp
    // the password update answered with is cleared in its own admin call once
    // the code is spent, only while it is still current, and a failure there
    // never undoes or repeats the reset.
    const ISSUED_AT = "2026-10-21T14:00:00.000Z";
    const OPERATION_A = "11111111-1111-4111-8111-111111111111";
    const withStamp = (issuedAt, operation = OPERATION_A) => ({ id: USER,
      user_metadata: issuedAt ? { union_ground_password_issued_at: issuedAt } : {},
      app_metadata: { union_ground_password_reissue_operation_id: operation } });
    const adminPuts = (calls) => calls.filter((call) => call.method === "PUT" && call.url.endsWith(`/auth/v1/admin/users/${USER}`))
      .map((call) => call.body);
    const stampedAccount = (current) => ({
      [`PUT ${SUPABASE}/auth/v1/admin/users/${USER}`]: (call) => {
        if (call.body.password) return reply(withStamp(ISSUED_AT));
        if (call.body.user_metadata?.union_ground_password_issued_at === null) current.issuedAt = null;
        return reply({ id: USER });
      },
      [`GET ${SUPABASE}/auth/v1/admin/users/${USER}`]: () => reply(withStamp(current.issuedAt, current.operation)),
    });

    it("clears its own emailed-password stamp after the code is spent when nothing races", async () => {
      const current = { issuedAt: ISSUED_AT, operation: OPERATION_A };
      const calls = backend(recovery(stampedAccount(current)));
      expect(await send()).toMatchObject({ status: 200, body: { completed: true, recoveryCodeUsed: true } });
      expect(adminPuts(calls)).toEqual([{ password: PASSWORD }, { user_metadata: { union_ground_password_issued_at: null } }]);
      expect(current.issuedAt).toBeNull();
      const order = steps(calls);
      expect(order.lastIndexOf(`PUT /auth/v1/admin/users/${USER}`))
        .toBeGreaterThan(order.indexOf("POST /rest/v1/rpc/finalize_mfa_recovery_code"));
    });

    it("keeps a newer stamp a staff reissue wrote during the recovery-code reset", async () => {
      const reissued = "2026-10-21T14:00:05.000Z";
      const current = { issuedAt: reissued, operation: "22222222-2222-4222-8222-222222222222" };
      const calls = backend(recovery(stampedAccount(current)));
      expect(await send()).toMatchObject({ status: 200, body: { completed: true, recoveryCodeUsed: true } });
      expect(adminPuts(calls)).toEqual([{ password: PASSWORD }]);
      expect(current.issuedAt).toBe(reissued);
    });

    it.each([
      ["a refused write", () => reply({ message: "lock timeout" }, 500)],
      ["a dropped connection", () => { throw new TypeError("fetch failed"); }],
    ])("keeps the finished reset when clearing the marker meets %s", async (_name, failure) => {
      let passwordSets = 0;
      const current = { issuedAt: ISSUED_AT, operation: OPERATION_A };
      const calls = backend(recovery({
        ...stampedAccount(current),
        [`PUT ${SUPABASE}/auth/v1/admin/users/${USER}`]: (call) => {
          if (call.body.password) { passwordSets += 1; return reply(withStamp(ISSUED_AT)); }
          return failure();
        },
      }));
      expect(await send()).toMatchObject({ status: 200, body: { completed: true, sessionsEnded: true, audited: true, recoveryCodeUsed: true } });
      expect(passwordSets).toBe(1);
      expect(adminPuts(calls)).toHaveLength(2);
      expect(calls.filter((call) => call.url.endsWith("finalize_mfa_recovery_code"))).toHaveLength(1);
      expect(reached(calls, "record_self_service_password_reset")).toBe(true);
    });

    it("removes a factor enrolled with the old session inside the window before it spends the code", async () => {
      let listings = 0;
      const rogue = "99999999-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const calls = backend(recovery({
        [`GET ${SUPABASE}/auth/v1/admin/users/${USER}/factors`]: () => reply(++listings === 1 ? factorList : [{ id: rogue, factor_type: "totp", status: "unverified" }]),
        [`DELETE ${factorUrl(rogue)}`]: reply({}),
      }));
      expect(await send()).toMatchObject({ status: 200, body: { completed: true } });
      const order = steps(calls);
      expect(order.indexOf(`DELETE /auth/v1/admin/users/${USER}/factors/${rogue}`)).toBeGreaterThan(order.indexOf("POST /rest/v1/rpc/end_member_auth_sessions"));
      expect(order.indexOf("POST /rest/v1/rpc/finalize_mfa_recovery_code")).toBeGreaterThan(order.indexOf(`DELETE /auth/v1/admin/users/${USER}/factors/${rogue}`));
    });

    it("refuses a wrong, used or locked-out code without touching a factor, session or the password", async () => {
      for (const claim of [reply({ accepted: false }), reply({ code: "22023", message: "recovery code not accepted" }, 400)]) {
        const calls = backend(recovery({ [`POST ${RPC("claim_mfa_recovery_code")}`]: claim }));
        expect(await send()).toMatchObject({ status: 400, body: { error: "code-not-accepted" } });
        expect(steps(calls)).toEqual([LEASE.replace(`GET ${SUPABASE}`, "GET "), "POST /rest/v1/rpc/consume_password_reset_attempt",
          "POST /rest/v1/rpc/claim_mfa_recovery_code"]);
      }
    });

    // BUG-UG-RESET-RECOVERY-CLAIM-TRANSPORT-CLASSIFICATION-20261021
    // . A small model of claim_mfa_recovery_code: a
    // matching code that is not under a live lease is leased for two minutes;
    // anything else counts a failed attempt toward the lockout.
    describe("when the claim's answer is lost or refused", () => {
      const database = () => {
        const db = { now: Date.parse("2026-10-21T22:00:00Z"), leaseUntil: 0, failedAttempts: 0, claims: 0, busyAware: false, staleLeaseRead: false };
        db.lease = () => reply(db.leaseUntil && !db.staleLeaseRead ? [{ claim_expires_at: new Date(db.leaseUntil).toISOString() }] : []);
        db.claim = (lose) => () => {
          db.claims += 1;
          if (lose === "before-commit") throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
          if (db.leaseUntil > db.now && db.busyAware) {
            return reply({ accepted: false, busy: true, retryAfterSeconds: Math.ceil((db.leaseUntil - db.now) / 1000) });
          }
          if (db.leaseUntil > db.now) { db.failedAttempts += 1; return reply({ accepted: false }); }
          db.leaseUntil = db.now + 120_000;
          if (lose === "after-commit") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
          return reply({ claimToken: CLAIM, userId: USER, sessionHandle: HANDLE, expiresIn: 120 });
        };
        return db;
      };
      const routesFor = (db, claim) => recovery({ [LEASE]: () => db.lease(), [`POST ${RPC("claim_mfa_recovery_code")}`]: claim });
      beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
      afterEach(() => { vi.useRealTimers(); });

      it("answers an abort before commit as unavailable, never as a wrong code, and lets an immediate retry through", async () => {
        const db = database();
        vi.setSystemTime(db.now);
        let lose = "before-commit";
        const calls = backend(routesFor(db, (call) => db.claim(lose)(call)));
        const first = await send();
        expect(first).toMatchObject({ status: 503, body: { error: "reset-unavailable", retryAfterSeconds: 120 } });
        expect(first.headers["Retry-After"]).toBe("120");
        expect(reached(calls, "cancel_password_reset_recovery")).toBe(false);
        lose = null;
        expect(await send()).toMatchObject({ status: 200, body: { completed: true } });
        expect([db.claims, db.failedAttempts]).toEqual([2, 0]);
      });

      it("holds an immediate retry after a timeout that committed the lease, without counting a failed attempt", async () => {
        const db = database();
        vi.setSystemTime(db.now);
        let lose = "after-commit";
        const calls = backend(routesFor(db, (call) => db.claim(lose)(call)));
        const charges = () => calls.filter((call) => call.url === RPC("consume_password_reset_attempt")).length;
        expect(await send()).toMatchObject({ status: 503, body: { error: "reset-unavailable", retryAfterSeconds: 120 } });
        lose = null;
        // Five immediate retries would have locked recovery; none reaches the claim.
        db.now += 30_000;
        vi.setSystemTime(db.now);
        for (let retry = 0; retry < 5; retry += 1) {
          const held = await send();
          expect(held).toMatchObject({ status: 503, body: { error: "reset-unavailable", retryAfterSeconds: 90 } });
          expect(held.headers["Retry-After"]).toBe("90");
        }
        expect([db.claims, db.failedAttempts]).toEqual([1, 0]);
        // Nor does a held retry spend the per-account code budget.
        expect(charges()).toBe(1);
        // The unknown lease is never released on the member's behalf.
        expect(reached(calls, "cancel_password_reset_recovery")).toBe(false);
        // Once the lease has run out, the same code works.
        db.now += 91_000;
        vi.setSystemTime(db.now);
        expect(await send()).toMatchObject({ status: 200, body: { completed: true } });
        expect([db.claims, db.failedAttempts, charges()]).toEqual([2, 0, 2]);
      });

      // BUG-UG-RECOVERY-CLAIM-LEASED-MATCH-BUSY-OUTCOME-20261022: the one
      // window the lease read cannot close. The retry's lease read sees no lease,
      // then the original claim commits before the retry's claim takes its locks.
      // claim_mfa_recovery_code (20261022091521) answers that leased match as busy.
      it("holds a retry whose lease read ran before the original claim committed, counting no failed attempt", async () => {
        const db = database();
        db.busyAware = true;
        vi.setSystemTime(db.now);
        let lose = "after-commit";
        const calls = backend(routesFor(db, (call) => db.claim(lose)(call)));
        expect(await send()).toMatchObject({ status: 503, body: { error: "reset-unavailable", retryAfterSeconds: 120 } });
        lose = null;
        db.staleLeaseRead = true;
        db.now += 1_000;
        vi.setSystemTime(db.now);
        const held = await send();
        expect(held).toMatchObject({ status: 503, body: { error: "reset-unavailable", retryAfterSeconds: 119 } });
        expect(held.headers["Retry-After"]).toBe("119");
        expect([db.claims, db.failedAttempts]).toEqual([2, 0]);
        expect(reached(calls, "cancel_password_reset_recovery")).toBe(false);
      });

      it.each([
        [{ accepted: false, busy: true, retryAfterSeconds: 900 }, 120],
        [{ accepted: false, busy: true }, 120],
      ])("bounds a busy claim's Retry-After to the lease (%j)", async (claim, seconds) => {
        backend(recovery({ [`POST ${RPC("claim_mfa_recovery_code")}`]: reply(claim) }));
        const out = await send();
        expect(out).toMatchObject({ status: 503, body: { error: "reset-unavailable", retryAfterSeconds: seconds } });
        expect(out.headers["Retry-After"]).toBe(String(seconds));
      });

      it("keeps an explicit refusal a wrong code, and an immediate retry with the right code proceeds", async () => {
        const db = database();
        vi.setSystemTime(db.now);
        let refused = true;
        backend(routesFor(db, (call) => (refused ? (db.failedAttempts += 1, reply({ accepted: false })) : db.claim(null)(call))));
        expect(await send()).toMatchObject({ status: 400, body: { error: "code-not-accepted" } });
        refused = false;
        expect(await send()).toMatchObject({ status: 200, body: { completed: true } });
        expect(db.failedAttempts).toBe(1);
      });

      it.each([
        ["a statement timeout Postgres reported (rolled back)", reply({ code: "57014", message: "canceling statement due to statement timeout" }, 500), 503, { error: "reset-unavailable" }],
        ["a function PostgREST cannot find", reply({ code: "PGRST202", message: "not found" }, 404), 503, { error: "reset-unavailable" }],
        ["a gateway timeout with no answer", reply(undefined, 504), 503, { error: "reset-unavailable", retryAfterSeconds: 120 }],
        ["a dropped connection", () => { throw new TypeError("fetch failed"); }, 503, { error: "reset-unavailable", retryAfterSeconds: 120 }],
        ["a reset session that is gone (42501)", reply({ code: "42501", message: "authentication required" }, 403), 400, { error: "link-invalid" }],
      ])("classifies %s", async (_label, claim, status, body) => {
        const calls = backend(recovery({ [`POST ${RPC("claim_mfa_recovery_code")}`]: claim }));
        const out = await send();
        expect(out).toMatchObject({ status, body });
        if (!body.retryAfterSeconds) expect(out.body.retryAfterSeconds).toBeUndefined();
        expect(calls.filter((call) => call.method === "PUT" || call.method === "DELETE")).toEqual([]);
        expect(reached(calls, "cancel_password_reset_recovery")).toBe(false);
      });

      it("never claims when the live-lease read fails or answers something unreadable", async () => {
        for (const lease of [reply({}, 500), reply({ rows: [] }), reply([{ claim_expires_at: "soon" }]), () => { throw new Error("offline"); }]) {
          const calls = backend(recovery({ [LEASE]: lease }));
          expect(await send()).toMatchObject({ status: 503, body: { error: "reset-unavailable" } });
          expect(reached(calls, "claim_mfa_recovery_code")).toBe(false);
        }
      });
    });

    it("shares the per-account reset throttle and never reaches the code check when it is exhausted", async () => {
      const calls = backend(recovery(throttle(false)));
      expect(await send()).toMatchObject({ status: 429, body: { error: "try-later" } });
      expect(steps(calls)).toEqual([LEASE.replace(`GET ${SUPABASE}`, "GET "), "POST /rest/v1/rpc/consume_password_reset_attempt"]);
    });

    it("offers a recovery code only to an account that has an authenticator to lose", async () => {
      const calls = backend(recovery());
      expect(await send(CODE, "enroll")).toMatchObject({ status: 400, body: { error: "code-not-accepted" } });
      expect(steps(calls)).toEqual(["POST /rest/v1/rpc/consume_password_reset_attempt"]);
    });

    it.each([
      ["a claim for another account", { [`POST ${RPC("claim_mfa_recovery_code")}`]: reply({ claimToken: CLAIM, userId: SECOND, sessionHandle: HANDLE }) }],
      ["a claim with a bad handle", { [`POST ${RPC("claim_mfa_recovery_code")}`]: reply({ claimToken: CLAIM, userId: USER, sessionHandle: "short" }) }],
      ["a claim with a bad token", { [`POST ${RPC("claim_mfa_recovery_code")}`]: reply({ claimToken: "short", userId: USER, sessionHandle: HANDLE }) }],
      ["a factor list that cannot be read", { [`GET ${SUPABASE}/auth/v1/admin/users/${USER}/factors`]: reply({}, 500) }],
      ["an unusable factor id", { [`GET ${SUPABASE}/auth/v1/admin/users/${USER}/factors`]: reply([{ id: "not-a-uuid", factor_type: "totp" }]) }],
    ])("stops before any change with %s", async (_label, overrides) => {
      const calls = backend(recovery(overrides));
      expect(await send()).toMatchObject({ status: 502, body: { error: "reset-unavailable" } });
      expect(calls.filter((call) => call.method === "PUT" || call.method === "DELETE")).toEqual([]);
      expect(reached(calls, "finalize_mfa_recovery_code")).toBe(false);
      expect(reached(calls, "prepare_mfa_recovery_signout")).toBe(false);
    });

    it.each([
      ["a password GoTrue rejects (422)", { [`PUT ${SUPABASE}/auth/v1/admin/users/${USER}`]: reply({ error_code: "weak_password" }, 422) }, 400, "password-rejected"],
      ["a password update that fails (500)", { [`PUT ${SUPABASE}/auth/v1/admin/users/${USER}`]: reply({}, 500) }, 502, "recovery-held"],
      ["a password update that cannot be reached", { [`PUT ${SUPABASE}/auth/v1/admin/users/${USER}`]: () => { throw new Error("offline"); } }, 503, "recovery-held"],
    ])("with %s removes no factor or session and spends no code", async (_label, overrides, status, error) => {
      const calls = backend(recovery(overrides));
      expect(await send()).toMatchObject({ status, body: { error } });
      for (const part of ["prepare_mfa_recovery_signout", "end_member_auth_sessions", "finalize_mfa_recovery_code", "record_self_service"]) {
        expect(reached(calls, part)).toBe(false);
      }
      expect(calls.filter((call) => call.method === "DELETE")).toEqual([]);
      expect(reached(calls, "prepare_password_reset_recovery")).toBe(true);
      expect(reached(calls, "cancel_password_reset_recovery")).toBe(error === "password-rejected");
      expect(calls.filter((call) => call.body?.p_cleanup === true)).toEqual([]);
    });

    it.each([
      ['refused', reply({ prepared: false })],
      ['unreachable', () => { throw new Error('offline'); }],
    ])("does not change the password when claim preparation is %s", async (_label, result) => {
      const calls = backend(recovery({ [`POST ${RPC("prepare_password_reset_recovery")}`]: result }));
      expect(await send()).toMatchObject({ status: 502, body: { error: "reset-unavailable" } });
      expect(calls.filter((call) => call.method === "PUT" || call.method === "DELETE")).toEqual([]);
      expect(reached(calls, "cancel_password_reset_recovery")).toBe(true);
    });

    it.each([
      ['unconfirmed', reply(false)],
      ['unreachable', () => { throw new Error('offline'); }],
    ])("directs %s rejected-password cancellation to staff without claiming the code is retryable", async (_label, result) => {
      backend(recovery({
        [`PUT ${SUPABASE}/auth/v1/admin/users/${USER}`]: reply({}, 422),
        [`POST ${RPC("cancel_password_reset_recovery")}`]: result,
      }));
      expect(await send()).toMatchObject({ status: 502, body: { error: "recovery-held" } });
    });

    it("reports a held recovery when preparation and cancellation cannot be confirmed", async () => {
      const calls = backend(recovery({
        [`POST ${RPC("prepare_password_reset_recovery")}`]: reply({ prepared: false }),
        [`POST ${RPC("cancel_password_reset_recovery")}`]: reply(false),
      }));
      expect(await send()).toMatchObject({ status: 502, body: { error: "recovery-held" } });
      expect(calls.filter((call) => call.method === "PUT" || call.method === "DELETE")).toEqual([]);
      expect(reached(calls, "finalize_mfa_recovery_code")).toBe(false);
    });

    it.each([
      ["a cleanup that did not complete", { [`POST ${RPC("prepare_password_reset_recovery")}`]: (call) => reply({ prepared: true, serverCleanupComplete: call.body.p_cleanup !== true }) }, "DELETE"],
      ["a cleanup call that throws", { [`POST ${RPC("prepare_password_reset_recovery")}`]: (call) => { if (call.body.p_cleanup) throw new Error("offline"); return reply({ prepared: true }); } }, "DELETE"],
      ["a factor that cannot be removed", { [`DELETE ${factorUrl(SECOND)}`]: reply({}, 500) }, "end_member_auth_sessions"],
      ["a factor removal that times out", { [`DELETE ${factorUrl(SECOND)}`]: () => { throw new Error("aborted"); } }, "end_member_auth_sessions"],
      ["sessions that cannot be ended", { [`POST ${RPC("end_member_auth_sessions")}`]: reply({}, 500) }, "finalize_mfa_recovery_code"],
      ["a final listing that fails", null, "finalize_mfa_recovery_code"],
      ["a factor that survives the final verification", null, "finalize_mfa_recovery_code"],
      ["a final listing with an unusable id", null, "finalize_mfa_recovery_code"],
      ["a code spend that is not confirmed", { [`POST ${RPC("finalize_mfa_recovery_code")}`]: reply(false) }, "record_self_service"],
      ["a code spend that throws", { [`POST ${RPC("finalize_mfa_recovery_code")}`]: () => { throw new Error("offline"); } }, "record_self_service"],
    ])("reports the reset as unfinished, never as complete, with %s", async (label, overrides, mustNotReach) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let listings = 0;
      const dynamic = {
        "a final listing that fails": () => { if (++listings > 1) throw new Error("offline"); return reply(factorList); },
        "a factor that survives the final verification": () => reply(++listings === 1 ? factorList : [{ id: SECOND, factor_type: "totp" }]),
        "a final listing with an unusable id": () => reply(++listings === 1 ? factorList : [{ id: "not-a-uuid" }]),
      }[label];
      const routes = overrides ?? { [`GET ${SUPABASE}/auth/v1/admin/users/${USER}/factors`]: dynamic };
      if (label === "a factor that survives the final verification") routes[`DELETE ${factorUrl(SECOND)}`] = () => (listings > 1 ? reply({}, 500) : reply({}));
      const calls = backend(recovery(routes));
      const out = await send();
      expect(out).toMatchObject({ status: expect.any(Number), body: { error: "recovery-unfinished" } });
      expect(out.body.completed).toBeUndefined();
      // The password changed first, and the lock is never released on an unfinished reset.
      expect(calls.some((call) => call.method === "PUT")).toBe(true);
      if (mustNotReach === "DELETE") expect(calls.filter((call) => call.method === "DELETE")).toEqual([]);
      else expect(reached(calls, mustNotReach)).toBe(false);
      if (!label.includes("spend")) expect(reached(calls, "finalize_mfa_recovery_code")).toBe(false);
      expect(reached(calls, "record_self_service")).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("password-reset-recovery-unfinished"));
      warn.mockRestore();
    });

    it("runs every factor removal under an abort budget, not only the per-call timeout", async () => {
      const calls = backend(recovery());
      await send();
      const first = calls.filter((call) => call.method === "DELETE").slice(0, 3);
      expect(first).toHaveLength(3);
      for (const call of first) expect(call.signal).toBeInstanceOf(AbortSignal);
    });

    it("retries sign-out once and the code spend once", async () => {
      let sessions = 0;
      let spends = 0;
      backend(recovery({
        [`POST ${RPC("end_member_auth_sessions")}`]: () => (sessions++ === 0 ? reply({}, 500) : reply({ ended: true })),
        [`POST ${RPC("finalize_mfa_recovery_code")}`]: () => (spends++ === 0 ? reply({}, 500) : reply(true)),
      }));
      expect(await send()).toMatchObject({ status: 200, body: { completed: true } });
      expect([sessions, spends]).toEqual([2, 2]);
    });

    it("completes and logs when only the audit row cannot be written", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      backend(recovery({ [`POST ${RPC("record_self_service_password_reset")}`]: () => { throw new Error("offline"); } }));
      expect(await send()).toMatchObject({ status: 200, body: { completed: true, audited: false } });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"audited":false'));
      warn.mockRestore();
    });

    it("still takes a six-digit authenticator code on the ordinary path", async () => {
      const calls = backend({
        ...throttle(), ...challenge,
        [`POST ${SUPABASE}/auth/v1/factors/${FACTOR}/verify`]: reply({ access_token: "aal2-token" }),
        [`PUT ${SUPABASE}/auth/v1/user`]: reply({ id: USER }),
        [`POST ${RPC("end_member_auth_sessions")}`]: reply({ ended: true }),
        [`POST ${RPC("record_self_service_password_reset")}`]: reply(true),
      });
      expect(await send("123456")).toMatchObject({ status: 200, body: { completed: true } });
      expect(calls.some((call) => call.url.includes("claim_mfa_recovery_code"))).toBe(false);
    });
  });

  it("expires the state after 15 minutes", () => {
    const key = resetStateKey(SERVICE);
    const sealed = sealResetState(key, { accessToken: "t", userId: USER, factorId: FACTOR, mode: "challenge" }, 0);
    expect(openResetState(key, sealed, 14 * 60 * 1000)).not.toBeNull();
    expect(openResetState(key, sealed, 15 * 60 * 1000)).toBeNull();
  });
});

describe("self-service reset migration", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261008093000_self_service_password_reset.sql", import.meta.url), "utf8");
  const previous = readFileSync(new URL("../supabase/migrations/20261004050000_member_chapter_display_titles.sql", import.meta.url), "utf8");
  const actions = (text) => text.split("add constraint member_admin_audit_action_check")[1].split("));")[0].match(/'[a-z_]+'/g);

  it("keeps every settled audit action and adds the one reset action", () => {
    expect(actions(sql)).toEqual([...actions(previous), "'self_service_password_reset'"]);
  });

  it("lets only the service role charge the limits and write the audit row", () => {
    for (const signature of ["consume_password_reset_attempt(text, text)", "record_self_service_password_reset(uuid, boolean)"]) {
      expect(sql).toContain(`revoke all on function public.${signature}\n  from public, anon, authenticated, service_role;`);
      expect(sql).toContain(`grant execute on function public.${signature} to service_role;`);
    }
    expect(sql.match(/raise exception 'service role required'/g)).toHaveLength(2);
    expect(sql).toContain("values (p_user_id, 'self_service_password_reset', p_user_id,");
  });
});

describe("refusals at each step", () => {
  const PASSWORD = "a-brand-new-password-long-enough";
  const verify = { [`POST ${SUPABASE}/auth/v1/verify`]: reply({ access_token: "aal1-token", user: { id: USER } }) };
  const factors = (list) => ({ [`GET ${SUPABASE}/auth/v1/admin/users/${USER}/factors`]: reply(list) });
  const sealed = () => sealResetState(resetStateKey(SERVICE), { accessToken: "aal1-token", userId: USER, factorId: FACTOR, mode: "challenge" });
  const finish = () => run({ action: "finish", state: sealed(), code: "123456", password: PASSWORD });
  const challenge = (value) => ({ [`POST ${SUPABASE}/auth/v1/factors/${FACTOR}/challenge`]: value });
  const verifyCode = (value) => ({ [`POST ${SUPABASE}/auth/v1/factors/${FACTOR}/verify`]: value });
  const update = (value) => ({ [`PUT ${SUPABASE}/auth/v1/user`]: value });

  it("guards the route: origin, method, configuration and action", async () => {
    backend({});
    expect((await run({ action: "request" }, { origin: "https://elsewhere.example" })).status).toBe(403);
    const response = recorder();
    await handler({ method: "GET", headers: { host: PORTAL_HOST, origin: PORTAL_ORIGIN } }, response);
    expect(response.out.status).toBe(405);
    expect(await run({ action: "unknown" })).toMatchObject({ status: 400, body: { error: "invalid-request" } });
    expect(await run("not json")).toMatchObject({ status: 400, body: { error: "invalid-request" } });
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(await run({ action: "request", email: "member@example.com" })).toMatchObject({ status: 503, body: { error: "reset-unavailable" } });
  });

  it("answers an invalid address as accepted without asking anyone, and fails closed without mail settings", async () => {
    const calls = backend({});
    expect(await run({ action: "request", email: "not-an-address" })).toMatchObject({ status: 200, body: { accepted: true } });
    expect(calls).toEqual([]);
    vi.stubEnv("RESEND_API_KEY", "");
    expect(await run({ action: "request", email: "member@example.com" })).toMatchObject({ status: 503, body: { error: "reset-unavailable" } });
    expect(calls).toEqual([]);
  });

  it("stops at the address limit, and sends nothing for a non-recovery or mismatched link", async () => {
    let call = 0;
    backend({ [`POST ${RPC("consume_password_reset_attempt")}`]: () => reply(call++ === 0) });
    expect(await run({ action: "request", email: "member@example.com" })).toMatchObject({ status: 429, body: { error: "try-later" } });
    for (const payload of [
      { ...knownUser, hashed_token: TOKEN, verification_type: "signup" },
      { ...knownUser, email: "other@example.com", hashed_token: TOKEN, verification_type: "recovery" },
      { user: knownUser, properties: { hashed_token: "short", verification_type: "recovery" } },
    ]) {
      const calls = backend({ ...throttle(), [`POST ${SUPABASE}/auth/v1/admin/generate_link`]: reply(payload) });
      expect(await run({ action: "request", email: "member@example.com", locale: "es" })).toMatchObject({ status: 200, body: { accepted: true } });
      expect(calls.some((entry) => entry.url.startsWith("https://api.resend.com"))).toBe(false);
    }
    const calls = backend({ ...throttle(), [`POST ${SUPABASE}/auth/v1/admin/generate_link`]: () => { throw new Error("offline"); } });
    expect(await run({ action: "request", email: "member@example.com" })).toMatchObject({ status: 200, body: { accepted: true } });
    expect(calls.some((entry) => entry.url.startsWith("https://api.resend.com"))).toBe(false);
  });

  it("refuses to begin when the network is over its limit, the throttle is down, or Auth answers oddly", async () => {
    backend(throttle(false));
    expect(await run({ action: "begin", token: TICKET })).toMatchObject({ status: 429 });
    backend({ [`POST ${RPC("consume_password_reset_attempt")}`]: reply("yes") });
    expect(await run({ action: "begin", token: TICKET })).toMatchObject({ status: 503, body: { error: "reset-unavailable" } });
    backend({ ...throttle(), [`POST ${SUPABASE}/auth/v1/verify`]: reply({}, 429) });
    expect(await run({ action: "begin", token: TICKET })).toMatchObject({ status: 429, body: { error: "try-later" } });
    backend({ ...throttle(), [`POST ${SUPABASE}/auth/v1/verify`]: () => { throw new Error("offline"); } });
    expect(await run({ action: "begin", token: TICKET })).toMatchObject({ status: 503 });
    backend({ ...throttle(), [`POST ${SUPABASE}/auth/v1/verify`]: reply({ access_token: "aal1-token", user: {} }) });
    expect(await run({ action: "begin", token: TICKET })).toMatchObject({ status: 502 });
    backend({ ...throttle(), ...verify, [`GET ${SUPABASE}/auth/v1/admin/users/${USER}/factors`]: reply({}, 500) });
    expect(await run({ action: "begin", token: TICKET })).toMatchObject({ status: 502 });
    backend({ ...throttle(), ...verify, ...factors({ factors: "none" }) });
    expect(await run({ action: "begin", token: TICKET })).toMatchObject({ status: 502 });
  });

  it("never enrols a second factor past a verified one it cannot challenge, and rejects an unusable enrolment", async () => {
    let calls = backend({ ...throttle(), ...verify, ...factors({ factors: [{ id: FACTOR, factor_type: "phone", status: "verified" }] }) });
    expect(await run({ action: "begin", token: TICKET })).toMatchObject({ status: 409, body: { error: "two-step-unavailable" } });
    expect(calls.some((call) => call.url === `${SUPABASE}/auth/v1/factors`)).toBe(false);
    backend({ ...throttle(), ...verify, ...factors([]), [`POST ${SUPABASE}/auth/v1/factors`]: reply({ id: FACTOR, totp: { qr_code: "javascript:x" } }) });
    expect(await run({ action: "begin", token: TICKET })).toMatchObject({ status: 502 });
    backend({ ...throttle(), ...verify, ...factors([]), [`POST ${SUPABASE}/auth/v1/factors`]: reply({ id: FACTOR, totp: { qr_code: "javascript:x", secret: "JBSWY3DPEHPK3PXP" } }) });
    expect((await run({ action: "begin", token: TICKET })).body).toMatchObject({ mode: "enroll", qr: "" });
    backend({ ...throttle(), ...verify, ...factors([]), [`POST ${SUPABASE}/auth/v1/factors`]: () => { throw new Error("offline"); } });
    expect(await run({ action: "begin", token: TICKET })).toMatchObject({ status: 503 });
  });

  it("maps each finish refusal without ever reaching the password before the code is verified", async () => {
    const cases = [
      [throttle(false), 429, "try-later"],
      [{ ...throttle(), ...challenge(reply({}, 401)) }, 400, "link-invalid"],
      [{ ...throttle(), ...challenge(reply({}, 500)) }, 502, "reset-unavailable"],
      [{ ...throttle(), ...challenge(reply({ id: "x" })) }, 502, "reset-unavailable"],
      [{ ...throttle(), ...challenge(() => { throw new Error("offline"); }) }, 503, "reset-unavailable"],
      // A deleted factor ends the reset: the clients clear their saved step on link-invalid.
      [{ ...throttle(), ...challenge(reply({ code: 404, error_code: "mfa_factor_not_found", msg: "Factor not found" }, 404)) }, 400, "link-invalid"],
      [{ ...throttle(), ...challenge(reply({}, 404)) }, 502, "reset-unavailable"],
      [{ ...throttle(), ...challenge(reply({ error_code: "mfa_factor_not_found" }, 500)) }, 502, "reset-unavailable"],
      [{ ...throttle(), ...challenge(reply({ id: CHALLENGE })), ...verifyCode(reply({ error_code: "mfa_factor_not_found" }, 404)) }, 400, "link-invalid"],
      // Real single-read Responses: the missing-factor body is read once, so a second read can't hide it.
      [{ ...throttle(), ...challenge(() => new Response(JSON.stringify({ error_code: "mfa_factor_not_found" }), { status: 404 })) }, 400, "link-invalid"],
      [{ ...throttle(), ...challenge(reply({ id: CHALLENGE })), ...verifyCode(() => new Response(JSON.stringify({ error_code: "mfa_factor_not_found" }), { status: 404 })) }, 400, "link-invalid"],
      [{ ...throttle(), ...challenge(reply({ id: CHALLENGE })), ...verifyCode(reply({}, 429)) }, 429, "try-later"],
      [{ ...throttle(), ...challenge(reply({ id: CHALLENGE })), ...verifyCode(reply({})) }, 502, "reset-unavailable"],
      [{ ...throttle(), ...challenge(reply({ id: CHALLENGE })), ...verifyCode(() => { throw new Error("offline"); }) }, 503, "reset-unavailable"],
    ];
    for (const [routes, status, error] of cases) {
      const calls = backend(routes);
      expect(await finish()).toMatchObject({ status, body: { error } });
      expect(calls.some((call) => call.method === "PUT")).toBe(false);
    }
    backend({ [`POST ${RPC("consume_password_reset_attempt")}`]: reply({}, 500) });
    expect(await finish()).toMatchObject({ status: 503 });
  });

  it("reports a refused or failed password update and writes no audit row", async () => {
    const verified = { ...throttle(), ...challenge(reply({ id: CHALLENGE })), ...verifyCode(reply({ access_token: "aal2-token" })) };
    for (const [answer, status, error] of [
      [reply({ error_code: "weak_password" }, 422), 400, "password-rejected"],
      [reply({}, 403), 400, "link-invalid"],
      [reply({}, 500), 502, "reset-incomplete"],
      [() => { throw new Error("offline"); }, 503, "reset-unavailable"],
    ]) {
      const calls = backend({ ...verified, ...update(answer) });
      expect(await finish()).toMatchObject({ status, body: { error } });
      expect(calls.some((call) => call.url.includes("record_self_service"))).toBe(false);
    }
  });

  it("retries a failed sign-out once before reporting the sessions as still open", async () => {
    let attempts = 0;
    backend({
      ...throttle(), ...challenge(reply({ id: CHALLENGE })), ...verifyCode(reply({ access_token: "aal2-token" })), ...update(reply({ id: USER })),
      [`POST ${RPC("end_member_auth_sessions")}`]: () => (attempts++ === 0 ? reply({}, 500) : reply({ ended: true })),
      [`POST ${RPC("record_self_service_password_reset")}`]: reply(true),
    });
    expect(await finish()).toMatchObject({ status: 200, body: { completed: true, sessionsEnded: true, audited: true } });
    expect(attempts).toBe(2);
  });

  it("still completes, and logs it, when sessions or the audit row could not be finished", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = backend({
      ...throttle(), ...challenge(reply({ id: CHALLENGE })), ...verifyCode(reply({ access_token: "aal2-token" })), ...update(reply({ id: USER })),
      [`POST ${RPC("end_member_auth_sessions")}`]: reply({}, 500),
      [`POST ${RPC("record_self_service_password_reset")}`]: reply(false),
    });
    expect(await finish()).toMatchObject({ status: 200, body: { completed: true, sessionsEnded: false, audited: false } });
    expect(calls.filter((call) => call.url === RPC("end_member_auth_sessions"))).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("password-reset-completion-partial"));
  });
});
