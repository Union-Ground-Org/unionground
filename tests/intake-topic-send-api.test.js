// @vitest-environment node
// REQ-UG-INTAKE-QUEUE-EMAIL-THE-OPT-IN-LIST-20261118: the three
// routes of the topic update email. POST /api/intake-topic-send lets only a
// GoTrue-validated aal2 operator session preview, test and queue an update,
// mails a test only to the address the database answers, and queues the list
// send without mailing anyone. The cron drain mails each queued delivery with
// its own unsubscribe token (only the digest reaches the database) and the
// RFC 8058 headers, and writes every outcome back. The one-click route turns a
// POST into the existing stop and a GET into a page that changes nothing.
// tests/intake-topic-send-db.test.js proves the RPCs.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/intake-topic-send.js";
import dispatch from "../api/intake-topic-send-dispatch.js";
import unsubscribe from "../api/public-interest-unsubscribe.js";
import { cleanTopicUpdate, topicUpdateEmail, topicUpdateHeaders, unsubscribeLink } from "../api/_lib/intakeTopicEmail.js";
import { SUPABASE, USER_ID, bodyOf, callsTo, fetchRouter, jwt, reply, run, stubClaimEnv } from "./helpers/organization-claim-fixtures.js";
import { PORTAL_ORIGIN as ORIGIN, PORTAL_HOST, SAMPLE_HOST } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

const SESSION_ID = "12345678-1234-4234-8234-123456789abc";
const KEY = "44444444-4444-4444-8444-444444444444";
const TEST_ID = "66666666-6666-4666-8666-666666666666";
const SEND_ID = "77777777-7777-4777-8777-777777777777";
const FOREIGN = "55555555-5555-4555-8555-555555555555";
const AAL2 = jwt({ sub: USER_ID, session_id: SESSION_ID, aal: "aal2", role: "authenticated" });
const AAL1 = jwt({ sub: USER_ID, session_id: SESSION_ID, aal: "aal1", role: "authenticated" });
const VERIFIED_USER = { id: USER_ID, factors: [{ id: "f1", factor_type: "totp", status: "verified" }] };
const POSTAL = vi.hoisted(() => ({
  name: "Example Platform",
  lines: ["1 Fixture Lane"],
  city: "Exampletown",
  state: "MA",
  zip: "00000",
  country: "United States",
}));
vi.mock("../src/lib/publicContact.js", async (original) => ({
  ...await original(),
  PUBLIC_POSTAL_ADDRESS: POSTAL,
}));
const ADDRESS = "Example Platform, 1 Fixture Lane, Exampletown, MA 00000, United States";
const CHAPTER_FOOTER = "Example Chapter Hall, 1 Fixture Street, Springfield";
const CRON = "c".repeat(40);
const RATE = "r".repeat(48);
const UPDATE = { topic: "public_meetings", subject: "  Spring <meeting>  ", body: "Hello & welcome.\r\n\r\nSee you there." };
const OVERVIEW = {
  today: "2026-11-18",
  topics: [
    { topic: "chapter_updates", recipients: 4, sentToday: false },
    { topic: "public_meetings", recipients: 2, sentToday: true },
    { topic: "union_news", recipients: 0, sentToday: false },
  ],
  sends: [],
};

const digest = (token) => createHash("sha256").update(token).digest("hex");

function request(body, { token = AAL2, ...overrides } = {}) {
  return {
    method: "POST",
    url: "/api/intake-topic-send",
    headers: { host: PORTAL_HOST, origin: ORIGIN, authorization: `Bearer ${token}` },
    body,
    ...overrides,
  };
}

function cronRequest(overrides = {}) {
  return { method: "GET", url: "/api/intake-topic-send-dispatch", headers: { host: PORTAL_HOST, authorization: `Bearer ${CRON}` }, ...overrides };
}

function oneClick(method, token, { headers = {}, host = PORTAL_HOST } = {}) {
  return {
    method,
    url: `/api/public-interest-unsubscribe?t=${encodeURIComponent(token)}`,
    query: { t: token },
    headers: { host, "x-vercel-forwarded-for": "203.0.113.7", ...headers },
    body: method === "POST" ? "List-Unsubscribe=One-Click" : undefined,
  };
}

async function runRaw(target, req) {
  const out = { status: 0, headers: {}, body: "" };
  const res = {
    status(code) { out.status = code; return this; },
    setHeader(name, value) { out.headers[name] = value; return this; },
    end(body) { out.body = body ?? ""; return this; },
  };
  await target(req, res);
  return out;
}

const rest = (fetcher) => fetcher.mock.calls.filter(([url]) => String(url).includes("/rest/v1/"));

beforeEach(() => stubClaimEnv({ PUBLIC_SITE_APP_ORIGIN: ORIGIN, ORG_POSTAL_ADDRESS: CHAPTER_FOOTER, CRON_SECRET: CRON, PUBLIC_INTEREST_RATE_LIMIT_SECRET: RATE }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the topic update email", () => {
  it("cleans the update the way the database does and refuses what the database refuses", () => {
    expect(cleanTopicUpdate(UPDATE)).toEqual({ topic: "public_meetings", subject: "Spring <meeting>", body: "Hello & welcome.\n\nSee you there." });
    expect(cleanTopicUpdate({ ...UPDATE, topic: "request_invite" })).toBeNull();
    expect(cleanTopicUpdate({ ...UPDATE, subject: " " })).toBeNull();
    expect(cleanTopicUpdate({ ...UPDATE, subject: "x".repeat(151) })).toBeNull();
    expect(cleanTopicUpdate({ ...UPDATE, subject: "one\ntwo" })).toBeNull();
    expect(cleanTopicUpdate({ ...UPDATE, body: "x".repeat(5001) })).toBeNull();
    expect(cleanTopicUpdate({ ...UPDATE, body: "bell\u0007" })).toBeNull();
    expect(cleanTopicUpdate({ ...UPDATE, body: 5 })).toBeNull();
  });

  it("escapes the operator's words, names the topic in the reader's language and carries the unsubscribe link and the mailing address", () => {
    const link = unsubscribeLink(ORIGIN, "T".repeat(43));
    expect(link).toBe(`${ORIGIN}/api/public-interest-unsubscribe?t=${"T".repeat(43)}`);
    const clean = cleanTopicUpdate(UPDATE);
    const en = topicUpdateEmail({ ...clean, locale: "en", link, address: ADDRESS });
    expect(en.subject).toBe("Spring <meeting>");
    expect(en.html).toContain("Spring &lt;meeting&gt;");
    expect(en.html).not.toContain("<meeting>");
    expect(en.html).toContain("Hello &amp; welcome.</p><p");
    expect(en.html).toContain("UNION GROUND · PUBLIC MEETINGS");
    expect(en.html).toContain(`href="${link}"`);
    expect(en.html).toContain(ADDRESS);
    expect(en.text).toContain(`Unsubscribe from Union Ground public updates: ${link}`);
    expect(en.text.endsWith(ADDRESS)).toBe(true);
    const es = topicUpdateEmail({ ...clean, locale: "es", link, address: ADDRESS });
    expect(es.html).toContain('lang="es"');
    expect(es.html).toContain("Reuniones públicas".toUpperCase());
    expect(es.text).toContain("Cancelar las novedades públicas de Union Ground");
    const test = topicUpdateEmail({ ...clean, locale: "en", link, address: ADDRESS, test: true });
    expect(test.subject).toBe("[Test] Spring <meeting>");
    expect(test.text).toContain("Test send: only you received this.");
    expect(topicUpdateEmail({ ...clean, locale: "en", link }).text.endsWith(ADDRESS)).toBe(true);
    expect(topicUpdateHeaders(link)).toEqual({ "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  });
});

describe("POST /api/intake-topic-send", () => {
  it("answers the overview as the caller's own session, with the mail configuration", async () => {
    const fetcher = fetchRouter({ user: reply(VERIFIED_USER), intake_topic_send_overview: reply(OVERVIEW) });
    const out = await run(handler, request({ action: "overview", p_operator_user_id: FOREIGN }));
    expect(out).toMatchObject({ status: 200, body: { result: { ...OVERVIEW, mail: { ready: true, missing: [] } } } });
    expect(out.headers["Cache-Control"]).toBe("no-store");
    expect(bodyOf(callsTo(fetcher, "intake_topic_send_overview")[0])).toEqual({ p_operator_user_id: USER_ID, p_operator_session_id: SESSION_ID });
  });

  it("previews both frame languages with the topic's count and mails nobody", async () => {
    const fetcher = fetchRouter({ user: reply(VERIFIED_USER), intake_topic_send_overview: reply(OVERVIEW) });
    const out = await run(handler, request({ action: "preview", ...UPDATE }));
    expect(out.status).toBe(200);
    expect(out.body.result).toMatchObject({ topic: "public_meetings", recipients: 2, sentToday: true, mail: { ready: true } });
    expect(out.body.result.email.en.html).toContain("Spring &lt;meeting&gt;");
    expect(out.body.result.email.es.html).toContain('lang="es"');
    expect(out.body.result.email.en.html).toContain(`${ORIGIN}/api/public-interest-unsubscribe"`);
    expect(callsTo(fetcher, "resend")).toHaveLength(0);
  });

  it("mails a test only to the address the database answers, marked as a test, and records whether it went", async () => {
    const fetcher = fetchRouter({
      user: reply(VERIFIED_USER),
      begin_intake_topic_test_send: reply({ started: true, to: "operator@example.invalid", subject: "Spring <meeting>", body: "Hello & welcome.\n\nSee you there.", send: { id: TEST_ID, sent: 0 } }),
      finish_intake_topic_test_send: reply({ recorded: true, send: { id: TEST_ID, sent: 1, status: "done" } }),
    });
    const out = await run(handler, request({ action: "test", ...UPDATE, key: KEY, to: "someone-else@example.invalid" }));
    expect(out).toMatchObject({ status: 200, body: { result: { delivered: true, send: { id: TEST_ID, sent: 1 } } } });
    expect(bodyOf(callsTo(fetcher, "begin_intake_topic_test_send")[0])).toEqual({
      p_operator_user_id: USER_ID, p_operator_session_id: SESSION_ID, p_topic: "public_meetings",
      p_subject: "Spring <meeting>", p_body: "Hello & welcome.\n\nSee you there.", p_idempotency_key: KEY,
    });
    const [mail] = callsTo(fetcher, "resend");
    const sent = bodyOf(mail);
    expect(sent.to).toEqual(["operator@example.invalid"]);
    expect(sent.from).toBe("Union Ground <alerts@example.invalid>");
    expect(sent.subject).toBe("[Test] Spring <meeting>");
    expect(sent.headers).toBeUndefined();
    expect(sent.html).toContain(ADDRESS);
    expect(JSON.stringify(sent)).not.toContain(CHAPTER_FOOTER);
    expect(mail[1].headers["Idempotency-Key"]).toBe(`ug-topic-test-${TEST_ID}`);
    expect(bodyOf(callsTo(fetcher, "finish_intake_topic_test_send")[0])).toMatchObject({ p_send_id: TEST_ID, p_delivered: true });
  });

  it("records a refused test as not delivered, and never mails a repeat or a refusal", async () => {
    let fetcher = fetchRouter({
      user: reply(VERIFIED_USER),
      begin_intake_topic_test_send: reply({ started: true, to: "operator@example.invalid", subject: "S", body: "B", send: { id: TEST_ID } }),
      finish_intake_topic_test_send: reply({ recorded: true, send: { id: TEST_ID, failed: 1 } }),
      resend: reply({ message: "bad" }, 422),
    });
    expect(await run(handler, request({ action: "test", ...UPDATE, key: KEY }))).toMatchObject({ status: 200, body: { result: { delivered: false } } });
    expect(bodyOf(callsTo(fetcher, "finish_intake_topic_test_send")[0])).toMatchObject({ p_delivered: false });

    fetcher = fetchRouter({ user: reply(VERIFIED_USER), begin_intake_topic_test_send: reply({ started: false, refusal: "repeat", send: { id: TEST_ID, sent: 1 } }) });
    expect(await run(handler, request({ action: "test", ...UPDATE, key: KEY }))).toMatchObject({ status: 200, body: { result: { delivered: true, repeat: true } } });
    expect(callsTo(fetcher, "resend")).toHaveLength(0);

    fetcher = fetchRouter({ user: reply(VERIFIED_USER), begin_intake_topic_test_send: reply({ started: false, refusal: "test-limit" }) });
    expect(await run(handler, request({ action: "test", ...UPDATE, key: KEY }))).toMatchObject({ status: 409, body: { error: "refused", reason: "test-limit" } });
    expect(callsTo(fetcher, "resend")).toHaveLength(0);
  });

  it("queues the list send with the test it follows and mails nobody", async () => {
    const fetcher = fetchRouter({ user: reply(VERIFIED_USER), queue_intake_topic_send: reply({ queued: true, send: { id: SEND_ID, queued: 2 } }) });
    const out = await run(handler, request({ action: "send", ...UPDATE, key: KEY, testSendId: TEST_ID }));
    expect(out).toMatchObject({ status: 200, body: { result: { send: { id: SEND_ID, queued: 2 } } } });
    expect(bodyOf(callsTo(fetcher, "queue_intake_topic_send")[0])).toEqual({
      p_operator_user_id: USER_ID, p_operator_session_id: SESSION_ID, p_topic: "public_meetings",
      p_subject: "Spring <meeting>", p_body: "Hello & welcome.\n\nSee you there.", p_test_send_id: TEST_ID, p_idempotency_key: KEY,
    });
    expect(callsTo(fetcher, "resend")).toHaveLength(0);
  });

  it.each(["test-required", "already-sent-today", "no-recipients", "key-reused"])("answers 409 %s from the database", async (refusal) => {
    fetchRouter({ user: reply(VERIFIED_USER), queue_intake_topic_send: reply({ queued: false, refusal }) });
    expect(await run(handler, request({ action: "send", ...UPDATE, key: KEY, testSendId: TEST_ID })))
      .toMatchObject({ status: 409, body: { error: "refused", reason: refusal } });
  });

  it("refuses to test or send before mail is fully configured, naming what is missing, before any database call", async () => {
    vi.stubEnv("NOTIFY_FROM_ADDRESS", "");
    vi.stubEnv("ORG_POSTAL_ADDRESS", "");
    const fetcher = fetchRouter({ user: reply(VERIFIED_USER), intake_topic_send_overview: reply(OVERVIEW) });
    for (const body of [{ action: "test", ...UPDATE, key: KEY }, { action: "send", ...UPDATE, key: KEY, testSendId: TEST_ID }]) {
      expect(await run(handler, request(body))).toMatchObject({ status: 503, body: { error: "mail-unavailable", missing: ["NOTIFY_FROM_ADDRESS"] } });
    }
    expect(rest(fetcher)).toHaveLength(0);
    expect(await run(handler, request({ action: "overview" }))).toMatchObject({ status: 200, body: { result: { mail: { ready: false, missing: ["NOTIFY_FROM_ADDRESS"] } } } });
  });

  // The final, r3s3: the operator cannot test or send while the unsubscribe
  // routes would answer 503 for want of their rate-limit secret.
  it("refuses to test or send while the unsubscribe rate-limit secret is missing or short", async () => {
    vi.stubEnv("PUBLIC_INTEREST_RATE_LIMIT_SECRET", "short");
    const fetcher = fetchRouter({ user: reply(VERIFIED_USER) });
    for (const body of [{ action: "test", ...UPDATE, key: KEY }, { action: "send", ...UPDATE, key: KEY, testSendId: TEST_ID }]) {
      expect(await run(handler, request(body))).toMatchObject({ status: 503, body: { error: "mail-unavailable", missing: ["PUBLIC_INTEREST_RATE_LIMIT_SECRET"] } });
    }
    expect(rest(fetcher)).toHaveLength(0);
  });

  it.each([
    [{ action: "remove" }],
    [{ action: "preview", ...UPDATE, topic: "request_invite" }],
    [{ action: "test", ...UPDATE }],
    [{ action: "test", ...UPDATE, key: "not-a-uuid" }],
    [{ action: "send", ...UPDATE, key: KEY }],
    [{ action: "send", ...UPDATE, subject: "", key: KEY, testSendId: TEST_ID }],
  ])("answers 400 for an invalid request %#", async (body) => {
    const fetcher = fetchRouter({ user: reply(VERIFIED_USER) });
    expect(await run(handler, request(body))).toMatchObject({ status: 400, body: { error: "invalid-request" } });
    expect(rest(fetcher)).toHaveLength(0);
  });

  it("refuses an aal1 session, a query string, another method and the SAMPLE host", async () => {
    const fetcher = fetchRouter({ user: reply(VERIFIED_USER) });
    expect(await run(handler, request({ action: "overview" }, { token: AAL1 }))).toMatchObject({ status: 403, body: { error: "mfa-required" } });
    expect(await run(handler, request({ action: "overview" }, { url: "/api/intake-topic-send?x=1" }))).toMatchObject({ status: 400 });
    expect(await run(handler, request({ action: "overview" }, { method: "GET" }))).toMatchObject({ status: 405 });
    expect(await run(handler, request({ action: "overview" }, { headers: { host: SAMPLE_HOST, authorization: `Bearer ${AAL2}` } })))
      .toMatchObject({ status: 404 });
    expect(rest(fetcher)).toHaveLength(0);
  });

  it("answers 403 only for the database's intake reviewer verdict and 503 for anything else", async () => {
    fetchRouter({ user: reply(VERIFIED_USER), intake_topic_send_overview: reply({ code: "42501", message: "intake reviewer required" }, 403) });
    expect(await run(handler, request({ action: "overview" }))).toMatchObject({ status: 403, body: { error: "not-permitted" } });
    fetchRouter({ user: reply(VERIFIED_USER), intake_topic_send_overview: reply({ code: "42501", message: "service role required" }, 403) });
    expect(await run(handler, request({ action: "overview" }))).toMatchObject({ status: 503, body: { error: "send-unavailable" } });
    fetchRouter({ user: reply(VERIFIED_USER), begin_intake_topic_test_send: reply({ code: "22023", message: "invalid subject" }, 400) });
    expect(await run(handler, request({ action: "test", ...UPDATE, key: KEY }))).toMatchObject({ status: 409, body: { reason: "invalid-subject" } });
  });
});

describe("GET /api/intake-topic-send-dispatch", () => {
  function claimed(deliveries) {
    return (init) => {
      claimed.digests = JSON.parse(init.body).p_token_hashes;
      return reply({ deliveries, skipped: 1, expired: 0 });
    };
  }
  const deliveries = [
    { id: 11, sendId: SEND_ID, email: "ada@example.invalid", locale: "en", topic: "union_news", subject: "News", body: "Body one", attempt: 1, token: 1 },
    { id: 12, sendId: SEND_ID, email: "bea@example.invalid", locale: "es", topic: "union_news", subject: "News", body: "Body one", attempt: 2, token: 2 },
  ];

  it("mails each delivery with its own unsubscribe token and the one-click headers, then records every outcome", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const fetcher = fetchRouter({
        claim_intake_topic_send_batch: claimed(deliveries),
        finish_intake_topic_send_delivery: reply({ recorded: true }),
        resend: (init) => (JSON.parse(init.body).to[0] === "bea@example.invalid" ? reply({}, 429) : reply({ id: "e1" })),
      });
      const pending = runRaw(dispatch, cronRequest());
      await vi.runAllTimersAsync();
      const out = await pending;
      expect(out.status).toBe(200);
      expect(JSON.parse(out.body)).toEqual({ ok: true, claimed: 2, sent: 1, failed: 0, retry: 1, unknown: 0, deferred: 0, skipped: 1, unrecorded: 0, unreleased: 0 });
      const [claimCall] = callsTo(fetcher, "claim_intake_topic_send_batch");
      expect(bodyOf(claimCall).p_token_hashes).toHaveLength(25);
      expect(new Set(bodyOf(claimCall).p_token_hashes).size).toBe(25);
      const mails = callsTo(fetcher, "resend");
      expect(mails).toHaveLength(2);
      for (const [index, mail] of mails.entries()) {
        const sent = bodyOf(mail);
        const link = /<(.+)>/.exec(sent.headers["List-Unsubscribe"])[1];
        const token = new URL(link).searchParams.get("t");
        expect(new URL(link).origin + new URL(link).pathname).toBe(`${ORIGIN}/api/public-interest-unsubscribe`);
        expect(digest(token)).toBe(claimed.digests[index]);
        expect(sent.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
        expect(sent.html).toContain(link.replace(/&/g, "&amp;"));
        expect(sent.text).toContain(ADDRESS);
        expect(JSON.stringify(sent)).not.toContain(CHAPTER_FOOTER);
        expect(mail[1].headers["Idempotency-Key"]).toBe(`ug-topic-${SEND_ID}-${deliveries[index].id}-${deliveries[index].attempt}`);
        expect(JSON.stringify(sent)).not.toContain(claimed.digests[index]);
      }
      expect(bodyOf(mails[1]).html).toContain('lang="es"');
      expect(callsTo(fetcher, "finish_intake_topic_send_delivery").map((call) => [bodyOf(call).p_delivery_id, bodyOf(call).p_outcome]))
        .toEqual([[11, "sent"], [12, "retry"]]);
      const leases = new Set(callsTo(fetcher, "finish_intake_topic_send_delivery").map((call) => bodyOf(call).p_lease_token));
      expect([...leases]).toEqual([bodyOf(claimCall).p_lease_token]);
    } finally {
      vi.useRealTimers();
    }
  });

  // An answer that never came may mean the
  // email went out, so it is recorded "unknown" (never resent, link kept),
  // not "failed" (whose confirmation the database deletes).
  it("records a lost provider answer as unknown so it is never sent twice and its link keeps working", async () => {
    const fetcher = fetchRouter({
      claim_intake_topic_send_batch: claimed([deliveries[0]]),
      finish_intake_topic_send_delivery: reply({ recorded: true }),
      resend: new Error("socket hang up"),
    });
    const out = await runRaw(dispatch, cronRequest());
    expect(JSON.parse(out.body)).toMatchObject({ sent: 0, failed: 0, unknown: 1 });
    expect(bodyOf(callsTo(fetcher, "finish_intake_topic_send_delivery")[0]).p_outcome).toBe("unknown");
  });

  it.each([
    [200, "sent"], [202, "sent"], [429, "retry"], [500, "unknown"], [503, "unknown"], [400, "failed"], [422, "failed"],
  ])("classifies a provider answer of %i as %s", async (status, outcome) => {
    const fetcher = fetchRouter({
      claim_intake_topic_send_batch: claimed([deliveries[0]]),
      finish_intake_topic_send_delivery: reply({ recorded: true }),
      resend: reply(status < 300 ? { id: "e1" } : { message: "no" }, status),
    });
    await runRaw(dispatch, cronRequest());
    expect(bodyOf(callsTo(fetcher, "finish_intake_topic_send_delivery")[0]).p_outcome).toBe(outcome);
  });

  // Gate round 1 (r1s2/r2s1) and the final (r3s1/r4s1): a delivery this
  // invocation has no time left for was never tried. The whole untried tail
  // goes back in ONE release call (which gives each its attempt back), never
  // one call per delivery and never as "retry", and nothing is mailed for it.
  it("releases, without mailing, every delivery it has no time left to try, in one call", async () => {
    let calls = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => (calls++ === 0 ? 1_000_000 : 1_045_000));
    try {
      const fetcher = fetchRouter({
        claim_intake_topic_send_batch: claimed(deliveries),
        release_intake_topic_send_deliveries: reply({ released: 2 }),
        resend: reply({ id: "e1" }),
      });
      const out = await runRaw(dispatch, cronRequest());
      expect(JSON.parse(out.body)).toMatchObject({ claimed: 2, sent: 0, retry: 0, deferred: 2, unreleased: 0 });
      expect(callsTo(fetcher, "resend")).toHaveLength(0);
      expect(callsTo(fetcher, "finish_intake_topic_send_delivery")).toHaveLength(0);
      const releases = callsTo(fetcher, "release_intake_topic_send_deliveries");
      expect(releases).toHaveLength(1);
      expect(bodyOf(releases[0])).toEqual({ p_lease_token: bodyOf(callsTo(fetcher, "claim_intake_topic_send_batch")[0]).p_lease_token, p_delivery_ids: [11, 12] });
    } finally {
      now.mockRestore();
    }
  });

  // The final, r3s1/r4s1 scenario: a slow provider uses up the time after the
  // first delivery. The rest are released together, and that call starts
  // with its reserve still left before the 60-second limit.
  it("on a slow run sends what fits, then releases the untried tail at once with its time reserved", async () => {
    const start = 1_000_000;
    let clock = start;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      let releasedAt = null;
      const tail = Array.from({ length: 5 }, (_, i) => ({ ...deliveries[0], id: 20 + i, email: `p${i}@example.invalid`, token: i + 1 }));
      const fetcher = fetchRouter({
        claim_intake_topic_send_batch: claimed(tail),
        finish_intake_topic_send_delivery: () => { clock += 3_000; return reply({ recorded: true }); },
        release_intake_topic_send_deliveries: () => { releasedAt = clock; return reply({ released: 4 }); },
        resend: () => { clock += 30_000; return reply({ id: "e1" }); },
      });
      const out = await runRaw(dispatch, cronRequest());
      expect(JSON.parse(out.body)).toMatchObject({ claimed: 5, sent: 1, deferred: 4, unreleased: 0 });
      expect(callsTo(fetcher, "finish_intake_topic_send_delivery")).toHaveLength(1);
      expect(bodyOf(callsTo(fetcher, "release_intake_topic_send_deliveries")[0]).p_delivery_ids).toEqual([21, 22, 23, 24]);
      // An RPC takes at most 8 seconds, and the release starts with more than that left.
      expect(start + 60_000 - releasedAt).toBeGreaterThan(8_000);
    } finally {
      now.mockRestore();
    }
  });

  it("counts a failed release as unreleased and still answers", async () => {
    const now = vi.spyOn(Date, "now").mockImplementationOnce(() => 0).mockImplementation(() => 60_000);
    try {
      fetchRouter({
        claim_intake_topic_send_batch: claimed(deliveries),
        release_intake_topic_send_deliveries: reply({ message: "down" }, 503),
      });
      const out = await runRaw(dispatch, cronRequest());
      expect(out.status).toBe(200);
      expect(JSON.parse(out.body)).toMatchObject({ deferred: 0, unreleased: 2 });
    } finally {
      now.mockRestore();
    }
  });

  it("keeps its time budget inside the 60 seconds vercel.json gives it", () => {
    const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    expect(config.functions["api/intake-topic-send-dispatch.js"].maxDuration).toBe(60);
    const source = readFileSync(new URL("../api/intake-topic-send-dispatch.js", import.meta.url), "utf8");
    expect(source).toContain("const RUNTIME_LIMIT_MS = 60000;");
    expect(source).toContain("const RELEASE_RESERVE_MS = 8000 + 1000;");
    expect(source).toContain("const INVOCATION_BUDGET_MS = RUNTIME_LIMIT_MS - RELEASE_RESERVE_MS - 1000;");
  });

  // The final, r3s3: nothing goes out whose unsubscribe link could not work.
  it.each([[""], ["short"]])("takes nothing while the unsubscribe rate-limit secret is %j", async (secret) => {
    vi.stubEnv("PUBLIC_INTEREST_RATE_LIMIT_SECRET", secret);
    const fetcher = fetchRouter({});
    const out = await runRaw(dispatch, cronRequest());
    expect(out.status).toBe(503);
    expect(JSON.parse(out.body)).toEqual({ error: "mail-unavailable", missing: ["PUBLIC_INTEREST_RATE_LIMIT_SECRET"] });
    expect(rest(fetcher)).toHaveLength(0);
  });

  it("takes nothing when it is not the cron, mail is not configured or the database is not reachable", async () => {
    let fetcher = fetchRouter({});
    expect((await runRaw(dispatch, cronRequest({ headers: { host: PORTAL_HOST } }))).status).toBe(401);
    expect((await runRaw(dispatch, cronRequest({ method: "POST" }))).status).toBe(405);
    vi.stubEnv("RESEND_API_KEY", "");
    const missing = await runRaw(dispatch, cronRequest());
    expect(missing.status).toBe(503);
    expect(JSON.parse(missing.body)).toEqual({ error: "mail-unavailable", missing: ["RESEND_API_KEY"] });
    expect(rest(fetcher)).toHaveLength(0);
    vi.stubEnv("RESEND_API_KEY", "resend-key");
    fetcher = fetchRouter({ claim_intake_topic_send_batch: reply({ message: "down" }, 503) });
    expect((await runRaw(dispatch, cronRequest())).status).toBe(503);
    expect(callsTo(fetcher, "resend")).toHaveLength(0);
  });
});

describe("/api/public-interest-unsubscribe", () => {
  const TOKEN = "A".repeat(43);

  it("shows a confirmation page on a GET and changes nothing", async () => {
    const fetcher = fetchRouter({});
    const out = await runRaw(unsubscribe, oneClick("GET", TOKEN));
    expect(out.status).toBe(200);
    expect(out.body).toContain(`<form method="post" action="/api/public-interest-unsubscribe?t=${TOKEN}">`);
    expect(out.body).toContain('name="List-Unsubscribe" value="One-Click"');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("confirms the stop on a provider's one-click POST with the token's digest and a network scope", async () => {
    const fetcher = fetchRouter({ confirm_public_interest_unsubscribe: reply({ confirmed: true }) });
    const out = await runRaw(unsubscribe, oneClick("POST", TOKEN));
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ unsubscribed: true });
    const args = bodyOf(callsTo(fetcher, "confirm_public_interest_unsubscribe")[0]);
    expect(args.p_token_hash).toBe(digest(TOKEN));
    expect(args.p_scope_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(args)).not.toContain(TOKEN);
    expect(callsTo(fetcher, "confirm_public_interest_unsubscribe")[0][0]).toBe(`${SUPABASE}/rest/v1/rpc/confirm_public_interest_unsubscribe`);
  });

  it("answers the page's button with a page, and one refusal for unknown, expired or used tokens", async () => {
    fetchRouter({ confirm_public_interest_unsubscribe: reply({ confirmed: true }) });
    const page = await runRaw(unsubscribe, oneClick("POST", TOKEN, { headers: { accept: "text/html" } }));
    expect(page.status).toBe(200);
    expect(page.body).toContain("You are unsubscribed");
    fetchRouter({ confirm_public_interest_unsubscribe: reply({ confirmed: false, refusal: "unavailable" }) });
    expect(JSON.parse((await runRaw(unsubscribe, oneClick("POST", TOKEN))).body)).toEqual({ error: "invalid-unsubscribe-link" });
    fetchRouter({ confirm_public_interest_unsubscribe: reply({ confirmed: false, refusal: "rate-limited" }) });
    expect((await runRaw(unsubscribe, oneClick("POST", TOKEN))).status).toBe(429);
    fetchRouter({ confirm_public_interest_unsubscribe: new Error("down") });
    expect((await runRaw(unsubscribe, oneClick("POST", TOKEN))).status).toBe(503);
  });

  it("refuses a malformed token, the SAMPLE host and a missing rate key before the database", async () => {
    const fetcher = fetchRouter({});
    expect((await runRaw(unsubscribe, oneClick("POST", "short"))).status).toBe(400);
    expect((await runRaw(unsubscribe, oneClick("GET", "short"))).body).toContain("This link does not work");
    expect((await runRaw(unsubscribe, oneClick("POST", TOKEN, { host: SAMPLE_HOST }))).status).toBe(404);
    vi.stubEnv("PUBLIC_INTEREST_RATE_LIMIT_SECRET", "short");
    expect((await runRaw(unsubscribe, oneClick("POST", TOKEN))).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
