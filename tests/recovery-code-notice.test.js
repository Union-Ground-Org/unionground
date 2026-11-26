// @vitest-environment node
// SEC-UG-RECOVERY-CODE-USE-WRITES-NO-AUDIT-ROW-OR-NOTICE-20261112
// (#8491): after a recovery code is used, the member is emailed at the
// account's own address in their saved language; a refused code sends
// nothing, and a failed send never undoes the recovery.
// SEC-UG-ACCOUNT-RECOVERY-NOTICE-AND-RESET-LOCK-GAPS-20261117
// (#9036): the email is queued in the commit that consumes the code, so a
// lost reply to finalize still sends it, once. The fake below keeps that
// queue the way private.account_notice_mail does: finalize adds a row only
// when it commits, a claim leases waiting rows, a completion marks one sent
// or releases it. Nothing here calls a real provider.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import recovery from "../api/mfa-recovery.js";
import dispatch from "../api/notifications-dispatch.js";
import { accountNoticeIdempotencyKey, deliverAccountNotices, purgeAccountNotices, recoveryCodeUsedEmail } from "../api/_lib/recoveryCodeNotice.js";
import { PORTAL_HOST, PORTAL_ORIGIN } from "./helpers/fictional-provider.js";
import { SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

const USER = "10000000-0000-4000-8000-000000000001";
const FACTOR = "20000000-0000-4000-8000-000000000002";
const NOTICE = "30000000-0000-4000-8000-000000000003";
const CODE = "ABCD-EFGH-IJKL-MNOP-QRST";
const claim = { accepted: true, userId: USER, sessionHandle: "b".repeat(64), claimToken: "a".repeat(64) };
const headers = { host: PORTAL_HOST, origin: PORTAL_ORIGIN, authorization: "Bearer caller-token" };
const reply = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status });
const config = { url: SUPABASE_ORIGIN, serviceKey: "sb_secret_test", resendKey: "fake-resend-key", from: "Union Ground <alerts@example.invalid>" };

async function run(body = { code: CODE }) {
  const res = { status(code) { this.code = code; return this; }, setHeader() {}, end(value) { this.body = JSON.parse(value); } };
  await recovery({ method: "POST", headers, body }, res);
  return { status: res.code, body: res.body };
}

// finalize: true commits and answers; "lost" commits and drops the reply;
// "lost-uncommitted" drops the reply without committing; false refuses.
function backend({ finalized = true, language = "es", resend = { id: "fake-1" }, claimed = claim, factors = [{ id: FACTOR, factor_type: "totp" }], queueDown = false } = {}) {
  const sent = [];
  // What reached the member: the provider keeps one message per
  // Idempotency-Key, as Resend does for 24 hours.
  const delivered = new Map();
  const queue = [];
  const completions = [];
  const claims = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    if (url === "https://api.resend.com/emails") {
      const message = { ...JSON.parse(init.body), key: init.headers["Idempotency-Key"] };
      sent.push(message);
      const answer = typeof resend === "function" ? resend(sent.length - 1) : resend;
      // "accepted, reply lost": the provider took it, the sender never heard.
      if (answer === "accepted-reply-lost") {
        if (!delivered.has(message.key)) delivered.set(message.key, message);
        return Promise.reject(new TypeError("fetch failed: connection reset"));
      }
      if (answer instanceof Error) return Promise.reject(answer);
      const status = answer?.status ?? 200;
      if (status < 300 && !delivered.has(message.key)) delivered.set(message.key, message);
      return reply(answer, status);
    }
    // The dispatcher's own channels are empty in these fixtures.
    if (url.includes("/rpc/expire_notification_deliveries")) return reply({ expired: 0, exhausted: 0, ineligible: 0 });
    if (url.includes("/rpc/claim_notification_deliveries")) return reply([]);
    if (url.includes("/rpc/get_notification_dispatch_health")) return reply({ queue: { pending_email: 0, pending_push: 0 } });
    if (url.includes("/rpc/claim_mfa_recovery_code")) return reply(claimed);
    if (url.includes("/rpc/prepare_mfa_recovery_signout")) return reply({ serverCleanupComplete: true });
    if (url.includes("/rpc/finalize_mfa_recovery_code")) {
      if (finalized === true || finalized === "lost") {
        queue.push({ id: NOTICE, userId: USER, notice: "recovery_code_used", email: "member@example.invalid", lang: language, attempts: 0, leased: false, backoff: false, sentAt: null });
      }
      if (finalized === "lost" || finalized === "lost-uncommitted") throw new TypeError("fetch failed: connection reset");
      return reply(finalized);
    }
    if (url.includes("/rpc/claim_account_notice_mail")) {
      if (queueDown) return reply({ message: "fake outage" }, 503);
      const { p_user_id: userId, p_limit: limit } = JSON.parse(init.body);
      claims.push({ userId, limit });
      const rows = queue.filter((row) => !row.sentAt && !row.leased && !row.backoff && (!userId || row.userId === userId)).slice(0, limit);
      for (const row of rows) { row.attempts += 1; row.leased = true; }
      // The address and language stored when the row was queued.
      return reply(rows.map((row) => ({ id: row.id, notice: row.notice, attempt: row.attempts, email: row.email, lang: row.lang })));
    }
    if (url.includes("/rpc/prepare_account_notice_mail")) {
      // Stored once, on the row's current attempt; the stored request is returned.
      const body = JSON.parse(init.body);
      const row = queue.find((entry) => entry.id === body.p_id && entry.attempts === body.p_attempt && !entry.sentAt);
      if (!row) return reply(null);
      if (!row.request && body.p_request?.to?.[0] === row.email) row.request = body.p_request;
      return reply(row.request ?? null);
    }
    if (url.includes("/rpc/complete_account_notice_mail")) {
      const body = JSON.parse(init.body);
      completions.push(body);
      const row = queue.find((entry) => entry.id === body.p_id && entry.attempts === body.p_attempt && !entry.sentAt);
      if (!row) return reply(false);
      row.leased = false;
      if (body.p_sent) row.sentAt = "now";
      else row.backoff = true;
      return reply(true);
    }
    if (url.includes("logout")) return reply(null, 204);
    if (init.method === "DELETE") return reply(null, 204);
    if (url.endsWith(`/auth/v1/admin/users/${USER}/factors`)) return reply(factors);
    throw new Error(`unexpected ${url}`);
  }));
  return { sent, delivered, queue, completions, claims };
}

// Time passing: a two-minute lease and a failed row's back-off both end.
const leaseEnds = (queue) => { for (const row of queue) { row.leased = false; row.backoff = false; } };

// One production dispatcher tick, as pg_cron sends it.
async function dispatcherTick() {
  vi.stubEnv("CRON_SECRET", "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx");
  const res = { status(code) { this.code = code; return this; }, setHeader() {}, end(value) { this.body = JSON.parse(value); } };
  await dispatch({ method: "POST", headers: { host: PORTAL_HOST, authorization: "Bearer cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx" } }, res);
  return res;
}

const alerts = (warn) => warn.mock.calls.flat().join("\n");

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_ORIGIN);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", SUPABASE_REF);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test");
  vi.stubEnv("RESEND_API_KEY", "fake-resend-key");
  vi.stubEnv("NOTIFY_FROM_ADDRESS", "Union Ground <alerts@example.invalid>");
  // This edition sends dispatcher email only with an owner-set app link.
  vi.stubEnv("NOTIFY_APP_URL", `${PORTAL_ORIGIN}/m`);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("the recovery code notice email", () => {
  it("says a code was used and how to get help, in English and Spanish, with no code or account detail", () => {
    const en = recoveryCodeUsedEmail("en");
    expect(en.subject).toBe("A recovery code was used on your Union Ground account");
    expect(en.text).toContain("If this was not you, change your password and contact your local office immediately.");
    const es = recoveryCodeUsedEmail("es");
    expect(es.subject).toBe("Se usó un código de recuperación en tu cuenta de Union Ground");
    expect(es.text).toContain("Si no fuiste tú");
    expect(recoveryCodeUsedEmail("fr").subject).toBe(en.subject);
  });

  it("emails the account's own address once, in its saved language, after a code is used, and marks the row sent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sent, queue, completions } = backend({ language: "es" });
    expect(await run()).toEqual({ status: 200, body: { recovered: true, removed: 1, sessionsRevoked: true, signInAgain: true } });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["member@example.invalid"]);
    expect(sent[0].subject).toBe("Se usó un código de recuperación en tu cuenta de Union Ground");
    expect(sent[0].key).toBe(accountNoticeIdempotencyKey(NOTICE));
    expect(JSON.stringify(sent[0])).not.toContain(CODE);
    expect(completions).toEqual([{ p_id: NOTICE, p_attempt: 1, p_sent: true }]);
    expect(queue[0].sentAt).toBe("now");
  });

  it("still sends the email once, and raises no alert, when finalize committed but its reply was lost", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sent, queue } = backend({ finalized: "lost", language: "en" });
    // The route cannot know the code was consumed, so it never says so.
    expect(await run()).toEqual({ status: 502, body: { error: "recovery-unavailable", removed: 1 } });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("A recovery code was used on your Union Ground account");
    expect(queue[0].sentAt).toBe("now");
    expect(alerts(warn)).not.toContain("recovery_notice_send_failed");
    // The dispatcher's sweep finds nothing left, so no second email.
    expect(await deliverAccountNotices(config)).toEqual({ claimed: 0, sent: 0, failed: 0, deferred: 0, unavailable: false });
    expect(sent).toHaveLength(1);
  });

  it("sends nothing when the reply was lost and finalize did not commit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sent } = backend({ finalized: "lost-uncommitted" });
    expect((await run()).status).toBe(502);
    expect(sent).toEqual([]);
    expect(alerts(warn)).not.toContain("recovery_notice_send_failed");
  });

  it("sends nothing when the code is not consumed", async () => {
    const { sent, queue } = backend({ finalized: false });
    expect((await run()).status).toBe(502);
    expect(sent).toEqual([]);
    expect(queue).toEqual([]);
  });

  it("sends nothing when the claim has no token or a two-step factor has no id", async () => {
    const noToken = backend({ claimed: { ...claim, claimToken: undefined } });
    expect((await run()).status).toBe(502);
    expect(noToken.sent).toEqual([]);
    const noId = backend({ factors: [{ factor_type: "totp" }] });
    expect((await run()).status).toBe(502);
    expect(noId.sent).toEqual([]);
  });

  it("keeps the recovery, raises the alert and leaves the email for the sweep when the provider refuses it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sent, queue, completions } = backend({ resend: (index) => (index === 0 ? { message: "fake outage", status: 500 } : { id: "fake-2" }) });
    expect(await run()).toMatchObject({ status: 200, body: { recovered: true } });
    expect(alerts(warn)).toContain('"kind":"recovery_notice_send_failed"');
    expect(completions).toEqual([{ p_id: NOTICE, p_attempt: 1, p_sent: false }]);
    expect(queue[0].sentAt).toBeNull();

    // Backed off: a sweep right away sends nothing; after the back-off the
    // next tick sends it under the same key, and only once.
    expect(await deliverAccountNotices(config)).toEqual({ claimed: 0, sent: 0, failed: 0, deferred: 0, unavailable: false });
    leaseEnds(queue);
    expect(await deliverAccountNotices(config)).toEqual({ claimed: 1, sent: 1, failed: 0, deferred: 0, unavailable: false });
    expect(await deliverAccountNotices(config)).toEqual({ claimed: 0, sent: 0, failed: 0, deferred: 0, unavailable: false });
    expect(sent.map((message) => message.key)).toEqual([accountNoticeIdempotencyKey(NOTICE), accountNoticeIdempotencyKey(NOTICE)]);
    expect(queue[0].sentAt).toBe("now");
  });

  it("keeps the recovery, reports the failure and raises the alert when the send throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sent } = backend({ resend: new Error("fake network failure") });
    expect(await run()).toMatchObject({ status: 200, body: { recovered: true } });
    expect(sent).toHaveLength(1);
    expect(alerts(warn)).toContain('"kind":"recovery_notice_send_failed"');

    const report = vi.fn();
    const { queue } = backend({ resend: new Error("fake network failure") });
    queue.push({ id: NOTICE, userId: USER, notice: "recovery_code_used", email: "member@example.invalid", lang: "en", attempts: 0, leased: false, backoff: false, sentAt: null });
    expect(await deliverAccountNotices(config, fetch, { report })).toEqual({ claimed: 1, sent: 0, failed: 1, deferred: 0, unavailable: false });
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("keeps the recovery and raises the alert when the queue cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sent } = backend({ queueDown: true });
    expect(await run()).toMatchObject({ status: 200, body: { recovered: true } });
    expect(sent).toEqual([]);
    expect(alerts(warn)).toContain('"kind":"recovery_notice_send_failed"');
  });

  it.each(["RESEND_API_KEY", "NOTIFY_FROM_ADDRESS"])("keeps the recovery, claims and sends nothing and raises the alert when %s is not set", async (name) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv(name, "");
    const { sent, queue } = backend();
    expect(await run()).toEqual({ status: 200, body: { recovered: true, removed: 1, sessionsRevoked: true, signInAgain: true } });
    expect(sent).toEqual([]);
    expect(queue[0]).toMatchObject({ attempts: 0, sentAt: null });
    expect(alerts(warn)).toContain('"kind":"recovery_notice_send_failed"');
  });

  // ask for #9036: one email per row when finalize's reply is lost
  // and a dispatcher sweep follows, whatever happened to the route's send.
  it("delivers one email for the row when finalize's reply is lost and a dispatcher tick follows", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { sent, delivered, queue } = backend({ finalized: "lost" });
    expect((await run()).status).toBe(502);
    expect((await dispatcherTick()).code).toBe(200);
    expect(sent).toHaveLength(1);
    expect([...delivered.keys()]).toEqual([accountNoticeIdempotencyKey(NOTICE)]);
    expect(queue).toEqual([expect.objectContaining({ attempts: 1, sentAt: "now" })]);
  });

  it("delivers one email when finalize's reply and the route's send reply are both lost and the tick resends", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { sent, delivered, queue } = backend({ finalized: "lost", resend: (index) => (index === 0 ? "accepted-reply-lost" : { id: "fake-2" }) });
    expect((await run()).status).toBe(502);
    expect(alerts(warn)).toContain('"kind":"recovery_notice_send_failed"');
    leaseEnds(queue);
    await dispatcherTick();
    // Two requests, one key, one email in the member's inbox.
    expect(sent.map((message) => message.key)).toEqual([accountNoticeIdempotencyKey(NOTICE), accountNoticeIdempotencyKey(NOTICE)]);
    expect(delivered.size).toBe(1);
    expect(queue[0]).toMatchObject({ attempts: 2, sentAt: "now" });
    await dispatcherTick();
    expect(sent).toHaveLength(2);
  });

  it("delivers one email when the route dies before recording its send and the tick runs after the lease", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { sent, delivered, queue } = backend({ finalized: "lost" });
    // The route claimed and sent, but its completion never landed.
    const completion = vi.fn(async (url, init) => (url.includes("/rpc/complete_account_notice_mail") ? Promise.reject(new TypeError("fetch failed")) : previous(url, init)));
    const previous = globalThis.fetch;
    vi.stubGlobal("fetch", completion);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await run()).status).toBe(502);
    vi.stubGlobal("fetch", previous);
    // Still leased: the tick inside the lease sends nothing.
    await dispatcherTick();
    expect(sent).toHaveLength(1);
    leaseEnds(queue);
    await dispatcherTick();
    expect(sent.map((message) => message.key)).toEqual([accountNoticeIdempotencyKey(NOTICE), accountNoticeIdempotencyKey(NOTICE)]);
    expect(delivered.size).toBe(1);
    expect(queue[0]).toMatchObject({ attempts: 2, sentAt: "now" });
  });

  // #9076 round 1, r1s4/r2s2: every try of a row is the identical request,
  // so a reused key can never draw a 409 for a changed message.
  it("sends the identical request on every try of a row, from what was stored when it was queued", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sent, queue } = backend({ language: "es", resend: (index) => (index === 0 ? "accepted-reply-lost" : { id: "fake-2" }) });
    expect((await run()).status).toBe(200);
    leaseEnds(queue);
    await deliverAccountNotices(config);
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[1])).toBe(JSON.stringify(sent[0]));
    expect(sent[0].subject).toBe("Se usó un código de recuperación en tu cuenta de Union Ground");
  });

  // #9076 final, r3s2/r4s1: the whole request is stored before the first send,
  // so a redeploy that changes the sender or the postal footer between tries
  // still resends the identical request under the row's key.
  it("resends the stored request byte for byte after a redeploy changed the sender and the postal footer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("ORG_POSTAL_ADDRESS", "100 Fixture Street, Testville");
    const { sent, delivered, queue } = backend({ finalized: "lost", resend: (index) => (index === 0 ? "accepted-reply-lost" : { id: "fake-2" }) });
    expect((await run()).status).toBe(502);
    vi.stubEnv("NOTIFY_FROM_ADDRESS", "Union Ground Alerts <notices@example.invalid>");
    vi.stubEnv("ORG_POSTAL_ADDRESS", "200 Other Avenue, Testville");
    leaseEnds(queue);
    await dispatcherTick();
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[1])).toBe(JSON.stringify(sent[0]));
    expect(sent[0].from).toBe("Union Ground <alerts@example.invalid>");
    expect(sent[0].text).toContain("100 Fixture Street");
    expect(delivered.size).toBe(1);
    expect(queue[0]).toMatchObject({ attempts: 2, sentAt: "now" });
  });

  // #9076 round 1, r1s1/r2s1: a slow or failing provider cannot hold the
  // sweep past its deadline; rows that do not fit wait for their lease.
  it("starts no row once a worst-case row no longer fits before the deadline, and leaves the rest leased", async () => {
    let now = 1_000_000;
    const rows = Array.from({ length: 5 }, (_, index) => ({ id: `30000000-0000-4000-8000-00000000000${index}`, notice: "recovery_code_used", attempt: 1, email: "member@example.invalid", lang: "en" }));
    const sends = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      if (url.includes("/rpc/claim_account_notice_mail")) return reply(rows);
      if (url.includes("/rpc/prepare_account_notice_mail")) return reply(JSON.parse(init.body).p_request);
      if (url.includes("/rpc/complete_account_notice_mail")) return reply(true);
      if (url === "https://api.resend.com/emails") { sends.push(init.headers["Idempotency-Key"]); now += 8000; return reply({ id: "x" }); }
      throw new Error(`unexpected ${url}`);
    }));
    const outcome = await deliverAccountNotices({ ...config, deadline: now + 40_000, clock: () => now });
    // 24 s worst case per row (store, send, record): rows start at +0, +8, +16.
    expect(outcome).toEqual({ claimed: 5, sent: 3, failed: 0, deferred: 2, unavailable: false });
    expect(sends).toHaveLength(3);
    // No room for the claim and one row: claims nothing at all.
    expect(await deliverAccountNotices({ ...config, deadline: now + 20_000, clock: () => now })).toEqual({ claimed: 0, sent: 0, failed: 0, deferred: 0, unavailable: false });
  });

  // #9076 round 1, r1s3/r2s4: retention runs without a mail provider.
  it("purges through the sweep's zero-limit claim, with no provider needed", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => { calls.push({ url, body: JSON.parse(init.body) }); return reply([]); }));
    expect(await purgeAccountNotices({ url: config.url, serviceKey: config.serviceKey })).toBe(true);
    expect(calls).toEqual([{ url: `${SUPABASE_ORIGIN}/rest/v1/rpc/claim_account_notice_mail`, body: { p_user_id: null, p_limit: 0 } }]);
    vi.stubGlobal("fetch", vi.fn(async () => reply({ message: "fake outage" }, 503)));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await purgeAccountNotices({ url: config.url, serviceKey: config.serviceKey })).toBe(false);
  });

  it("sends no row it cannot address or render, and never marks it sent", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      if (url.includes("/rpc/claim_account_notice_mail")) {
        return reply([
          { id: NOTICE, notice: "recovery_code_used", attempt: 1, email: "", lang: "en" },
          { id: NOTICE, notice: "something_else", attempt: 1, email: "member@example.invalid", lang: "en" },
          { id: "not-a-uuid", notice: "recovery_code_used", attempt: 1, email: "member@example.invalid", lang: "en" },
        ]);
      }
      if (url.includes("/rpc/prepare_account_notice_mail")) return reply(JSON.parse(init.body).p_request);
      if (url.includes("/rpc/complete_account_notice_mail")) return reply(JSON.parse(init.body).p_sent === false);
      throw new Error(`unexpected ${url}`);
    }));
    expect(await deliverAccountNotices(config)).toEqual({ claimed: 3, sent: 0, failed: 3, deferred: 0, unavailable: false });
  });
});
