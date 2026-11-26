// @vitest-environment node
// REQ-UG-ENGAGEMENT-EMAIL-RESEND-BRIDGE-20261121: the Resend bridge
// alone, then the real delivery route and the bridge together. No network:
// every fetch is a stub, and the route's webhook call is handed to the real
// bridge handler.
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bridge, { RESEND_URL } from "../api/engagement-email-bridge.js";
import route from "../api/engagement-delivery.js";
import { vercelCronTickHeaders } from "./helpers/vercelCronTick.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SAMPLE_HOST, SAMPLE_ORIGIN } from "./helpers/fictional-provider.js";

// The bridge reads the deployment's public origin when it loads; the fictional
// portal stands in for it (tests/helpers/fictional-provider.js).
vi.hoisted(() => { process.env.PUBLIC_SITE_APP_ORIGIN = "https://app.unionground.test"; });

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

// Node's own fetch, kept before any test stubs the global.
const realFetch = globalThis.fetch;
const CRON = "bridge-fixture-cron-secret-".repeat(2);
const WEBHOOK_TOKEN = "w".repeat(40);
const RESEND_KEY = "resend-send-only-key";
const BRIDGE_URL = `${PORTAL_ORIGIN}/api/engagement-email-bridge`;
const DELIVERY = "00000000-0000-4000-8000-000000000201";
const tokenFor = (category) => `00000000-0000-4000-8000-0000000000aa.${category}.1790000000.${"A".repeat(43)}`;
const unsubscribeFor = (category) => `${PORTAL_ORIGIN}/api/email-unsubscribe?t=${tokenFor(category)}`;

function contract(overrides = {}) {
  const category = overrides.category || "announcements";
  const unsubscribeUrl = unsubscribeFor(category);
  return {
    to: "member@example.test",
    locale: "en",
    subject: "Chapter update",
    text: "Meeting starts at six.\n\nBring a friend.",
    actionPath: "/m/messages?broadcast=broadcast-1",
    headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    unsubscribeUrl,
    category,
    metadata: { deliveryId: DELIVERY, kind: "broadcast" },
    ...overrides,
  };
}

function bridgeRequest({ body = contract(), host = PORTAL_HOST, token = WEBHOOK_TOKEN, key = DELIVERY, method = "POST", extra = {} } = {}) {
  return {
    method,
    headers: {
      host,
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(key === null ? {} : { "idempotency-key": key }),
      ...extra,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

function recorder() {
  const out = { status: 0, raw: "", body: null };
  return {
    out,
    status(code) { out.status = code; return this; },
    setHeader() { return this; },
    end(value) { out.raw = String(value); out.body = JSON.parse(value); return this; },
  };
}

async function callBridge(options) {
  const response = recorder();
  await bridge(bridgeRequest(options), response);
  return response.out;
}

function resendReply(status) {
  return { ok: status >= 200 && status < 300, status, text: async () => "{}", json: async () => ({}) };
}

function stubResend(reply = resendReply(200)) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    if (reply instanceof Error) throw reply;
    return reply;
  }));
  return calls;
}

beforeEach(() => {
  vi.stubEnv("ENGAGEMENT_EMAIL_WEBHOOK_TOKEN", WEBHOOK_TOKEN);
  vi.stubEnv("ENGAGEMENT_EMAIL_RESEND_API_KEY", RESEND_KEY);
  vi.stubEnv("RESEND_API_KEY", "the-account-wide-key");
  vi.stubEnv("NOTIFY_FROM_ADDRESS", "Union Ground <notify@unionground.test>");
  vi.stubEnv("ORG_POSTAL_ADDRESS", "");
  vi.stubEnv("ENGAGEMENT_EMAIL_BRIDGE_SAMPLE_RECIPIENTS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("engagement email bridge: who may call it", () => {
  it("accepts POST only", async () => {
    const calls = stubResend();
    expect((await callBridge({ method: "GET" })).status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  it("refuses a browser (Origin, Cookie, Referer or Sec-Fetch-Site) and admits Node's fetch, which sends Sec-Fetch-Mode", async () => {
    const calls = stubResend();
    for (const extra of [{ origin: PORTAL_ORIGIN }, { origin: "null" }, { cookie: "s=1" }, { referer: `${PORTAL_ORIGIN}/m` }, { "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "" }]) {
      expect(await callBridge({ extra })).toMatchObject({ status: 403, body: { error: "untrusted-origin" } });
    }
    expect(calls).toHaveLength(0);
    expect((await callBridge({ extra: { "sec-fetch-mode": "cors", "accept-language": "*", "user-agent": "node" } })).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("refuses every host but the SaaS host and the SAMPLE host, before reading the token", async () => {
    const calls = stubResend();
    for (const host of ["preview-1.vercel.app", "localhost", "attacker.example", ""]) {
      expect(await callBridge({ host })).toMatchObject({ status: 403, body: { error: "untrusted-host" } });
    }
    expect(calls).toHaveLength(0);
  });

  it("stays off while the shared token is missing or shorter than 32 characters", async () => {
    const calls = stubResend();
    for (const value of [undefined, "", "short-token"]) {
      vi.stubEnv("ENGAGEMENT_EMAIL_WEBHOOK_TOKEN", value);
      expect((await callBridge({ token: value || "any-presented-token" })).status).toBe(503);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a missing, wrong or same-length wrong bearer", async () => {
    const calls = stubResend();
    for (const token of [null, "", "nope", "x".repeat(40), `${WEBHOOK_TOKEN}x`, WEBHOOK_TOKEN.slice(1)]) {
      expect(await callBridge({ token })).toMatchObject({ status: 401, body: { error: "Unauthorized." } });
    }
    expect((await callBridge({ token: null, extra: { authorization: `bearer ${WEBHOOK_TOKEN}` } })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("stays off without its own send-only key, when that key is the account-wide key, or without a sender", async () => {
    const calls = stubResend();
    vi.stubEnv("ENGAGEMENT_EMAIL_RESEND_API_KEY", "");
    expect((await callBridge()).status).toBe(503);
    vi.stubEnv("ENGAGEMENT_EMAIL_RESEND_API_KEY", "the-account-wide-key");
    expect((await callBridge()).status).toBe(503);
    vi.stubEnv("ENGAGEMENT_EMAIL_RESEND_API_KEY", RESEND_KEY);
    for (const from of ["", "not an address", "a@example.test, b@example.test"]) {
      vi.stubEnv("NOTIFY_FROM_ADDRESS", from);
      expect((await callBridge()).status).toBe(503);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("engagement email bridge: only the route's request shape", () => {
  const otherUnsubscribe = "https://attacker.example/api/email-unsubscribe?t=" + tokenFor("announcements");
  const refused = [
    ["no body", { body: "" }],
    ["not JSON", { body: "{" }],
    ["an array", { body: "[]" }],
    ["no idempotency key", { key: null }],
    ["a key that is not a uuid", { key: "abc" }],
    ["a key that is not this delivery", { key: "00000000-0000-4000-8000-000000000999" }],
    ["an unknown kind", { body: contract({ metadata: { deliveryId: DELIVERY, kind: "dues" } }) }],
    ["a category that is not the kind's", { body: { ...contract(), category: "surveys" } }],
    ["an unsubscribe link on another origin", { body: { ...contract(), unsubscribeUrl: otherUnsubscribe, headers: { "List-Unsubscribe": `<${otherUnsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } }],
    ["an unsubscribe token for another category", { body: { ...contract(), unsubscribeUrl: unsubscribeFor("surveys"), headers: contract({ category: "surveys" }).headers } }],
    ["an unsubscribe link with an extra parameter", { body: { ...contract(), unsubscribeUrl: `${unsubscribeFor("announcements")}&x=1` } }],
    ["a caller-chosen extra header", { body: contract({ headers: { ...contract().headers, Bcc: "someone@example.test" } }) }],
    ["no unsubscribe headers", { body: contract({ headers: {} }) }],
    ["two recipients", { body: contract({ to: "a@example.test, b@example.test" }) }],
    ["a recipient with a line break", { body: contract({ to: "a@example.test\r\nBcc: b@example.test" }) }],
    ["a subject of only control characters", { body: contract({ subject: "\f\u0007" }) }],
    ["a body of only control characters", { body: contract({ text: "\f\u0000\u001b" }) }],
    ["an empty subject", { body: contract({ subject: "  " }) }],
    ["an empty body", { body: contract({ text: "" }) }],
    ["a body that is too long", { body: contract({ text: "a".repeat(100001) }) }],
    ["a protocol-relative action path", { body: contract({ actionPath: "//attacker.example/m" }) }],
    ["an absolute action URL", { body: contract({ actionPath: "https://attacker.example/m" }) }],
    ["a backslash action path", { body: contract({ actionPath: "/m\\..\\attacker" }) }],
    ["an action path outside the member app", { body: contract({ actionPath: "/admin" }) }],
    ["an action path that only starts like /m", { body: contract({ actionPath: "/media" }) }],
    ["an action path that leaves /m once parsed", { body: contract({ actionPath: "/m/../admin" }) }],
    ["an encoded action path that leaves /m once parsed", { body: contract({ actionPath: "/m/%2e%2e/admin" }) }],
  ];

  it.each(refused)("answers 400 for %s and calls nobody", async (_label, options) => {
    const calls = stubResend();
    const out = await callBridge(options);
    expect(out).toMatchObject({ status: 400, body: { error: "invalid-request" } });
    expect(calls).toHaveLength(0);
  });
});

describe("engagement email bridge: the message Resend receives", () => {
  it("sends one message with the send-only key, the delivery's stable key, the action link and the one-click headers", async () => {
    const calls = stubResend(resendReply(200));
    const out = await callBridge();
    expect(out).toEqual({ status: 200, raw: JSON.stringify({ sent: true }), body: { sent: true } });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe(RESEND_URL);
    expect(call.init.headers).toEqual({
      Authorization: `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `ug-engagement-${DELIVERY}`,
    });
    expect(JSON.stringify(call.init.headers)).not.toContain(WEBHOOK_TOKEN);
    expect(call.body).toMatchObject({
      from: "Union Ground <notify@unionground.test>",
      to: ["member@example.test"],
      subject: "Chapter update",
      headers: contract().headers,
    });
    expect(Object.keys(call.body).sort()).toEqual(["from", "headers", "html", "subject", "text", "to"]);
    expect(call.body.text).toContain("Meeting starts at six.\n\nBring a friend.");
    expect(call.body.text).toContain(`Read it in Union Ground: ${PORTAL_ORIGIN}/m/messages?broadcast=broadcast-1`);
    expect(call.body.text).toContain(`Unsubscribe from these emails: ${unsubscribeFor("announcements")}`);
    expect(call.body.html).toContain(`href="${PORTAL_ORIGIN}/m/messages?broadcast=broadcast-1"`);
    expect(call.body.html).toContain(`href="${unsubscribeFor("announcements")}"`);
    expect(call.body.html).toContain("<p style=\"margin:0 0 14px;font-size:16px;line-height:1.55;color:#3d4a44\">Meeting starts at six.</p>");
    expect(call.body.html).toContain('<html lang="en">');
  });

  it("writes the frame in Spanish for a Spanish reader, escapes the author's words, and adds the sending organization's postal line", async () => {
    const calls = stubResend();
    const body = contract({
      locale: "es",
      subject: "Encuesta <b>nueva</b>",
      text: "Hola & bienvenidos\n<script>x</script>",
      category: "surveys",
      actionPath: "/m/voice?survey=s-1",
      metadata: { deliveryId: DELIVERY, kind: "survey_invitation" },
      postalAddress: "100 Main St, Springfield",
    });
    expect((await callBridge({ body })).status).toBe(200);
    const sent = calls[0].body;
    expect(sent.html).toContain('<html lang="es">');
    expect(sent.html).toContain("ENCUESTA");
    expect(sent.html).toContain("Responder la encuesta");
    expect(sent.html).toContain("Cancelar la suscripción a estos correos");
    expect(sent.html).toContain("Encuesta &lt;b&gt;nueva&lt;/b&gt;");
    expect(sent.html).toContain("Hola &amp; bienvenidos<br>&lt;script&gt;x&lt;/script&gt;");
    expect(sent.html).not.toContain("<script>");
    expect(sent.html).toContain("100 Main St, Springfield");
    expect(sent.text).toContain(`Responder la encuesta: ${PORTAL_ORIGIN}/m/voice?survey=s-1`);
    expect(sent.text.endsWith("100 Main St, Springfield")).toBe(true);
  });

  // #9507: each organization's mail carries its own office address; one with
  // none on file carries none, never a deployment-wide value. A request with
  // no postalAddress key (a database not yet migrated) keeps today's line.
  it("prints each sending organization's own address and none for an organization with none, ignoring any deployment value", async () => {
    vi.stubEnv("ORG_POSTAL_ADDRESS", "999 Shared Street, Elsewhere");
    const calls = stubResend();
    expect((await callBridge({ body: contract({ postalAddress: "1 Alder Way\nFictionville" }) })).status).toBe(200);
    expect((await callBridge({ body: contract({ postalAddress: "2 Birch Road, Exampletown" }) })).status).toBe(200);
    expect((await callBridge({ body: contract({ postalAddress: "" }) })).status).toBe(200);
    expect((await callBridge({ body: contract({ postalAddress: "3 Cedar <b>Court</b>" }) })).status).toBe(200);
    const [first, second, none, unusable] = calls.map((call) => call.body);
    expect(first.text.endsWith("1 Alder Way, Fictionville")).toBe(true);
    expect(first.html).toContain("1 Alder Way, Fictionville");
    expect(second.text.endsWith("2 Birch Road, Exampletown")).toBe(true);
    expect(second.html).toContain("2 Birch Road, Exampletown");
    expect(first.html).not.toContain("Birch Road");
    expect(second.html).not.toContain("Alder Way");
    for (const sent of [first, second, none, unusable]) {
      expect(sent.text).not.toContain("Shared Street");
      expect(sent.html).not.toContain("Shared Street");
    }
    expect(none.text.endsWith(`Email settings: ${PORTAL_ORIGIN}/m/settings`)).toBe(true);
    expect(unusable.text).not.toContain("Cedar");
    expect(unusable.html).not.toContain("Cedar");
  });

  it("keeps the deployment-wide line for a request with no postalAddress key", async () => {
    vi.stubEnv("ORG_POSTAL_ADDRESS", "999 Shared Street, Elsewhere");
    const calls = stubResend();
    expect((await callBridge({ body: contract() })).status).toBe(200);
    expect(calls[0].body.text.endsWith("999 Shared Street, Elsewhere")).toBe(true);
    expect(calls[0].body.html).toContain("999 Shared Street, Elsewhere");
  });

  it("drops a pasted control character instead of refusing the row, keeping the body's line breaks", async () => {
    const calls = stubResend();
    const body = contract({ subject: "Chapter\r\nupdate\f", text: "Line one\fstill one\u0007\n\nPara\ttwo\u001b" });
    expect((await callBridge({ body })).status).toBe(200);
    expect(calls[0].body.subject).toBe("Chapter  update");
    expect(calls[0].body.text.startsWith("Line onestill one\n\nPara\ttwo\n")).toBe(true);
    expect(calls[0].body.html).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  });

  it("answers so the route's retry rules hold: 2xx sent, 429 later, 409 or 5xx or no answer retried under the same key, other refusals 502", async () => {
    const cases = [
      [resendReply(200), 200], [resendReply(202), 200],
      [resendReply(429), 429],
      [resendReply(409), 503], [resendReply(500), 503], [resendReply(503), 503],
      [Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }), 503],
      [new TypeError("fetch failed"), 503],
      [resendReply(401), 502], [resendReply(403), 502], [resendReply(422), 502],
    ];
    const keys = new Set();
    for (const [reply, status] of cases) {
      const calls = stubResend(reply);
      expect((await callBridge()).status).toBe(status);
      keys.add(calls[0].init.headers["Idempotency-Key"]);
    }
    expect([...keys]).toEqual([`ug-engagement-${DELIVERY}`]);
  });

  it("logs nothing and never answers with the address, subject or body", async () => {
    const spies = ["log", "info", "warn", "error", "debug"].map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
    const answers = [];
    for (const reply of [resendReply(200), resendReply(429), resendReply(500), resendReply(422), new Error("boom member@example.test")]) {
      stubResend(reply);
      answers.push((await callBridge()).raw);
    }
    stubResend();
    answers.push((await callBridge({ body: contract({ actionPath: "/admin" }) })).raw);
    for (const raw of answers) {
      for (const secret of ["member@example.test", "Chapter update", "Meeting starts", RESEND_KEY, WEBHOOK_TOKEN]) expect(raw).not.toContain(secret);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("engagement email bridge on the SAMPLE host", () => {
  it("sends nothing while the operator test inbox list is empty or unusable", async () => {
    const calls = stubResend();
    for (const list of ["", "not-an-address", "a@x.test,b@x.test,c@x.test,d@x.test,e@x.test,f@x.test"]) {
      vi.stubEnv("ENGAGEMENT_EMAIL_BRIDGE_SAMPLE_RECIPIENTS", list);
      expect(await callBridge({ host: SAMPLE_HOST, body: contract({ to: "a@x.test" }) })).toMatchObject({ status: 403, body: { error: "recipient-not-allowed" } });
    }
    expect(calls).toHaveLength(0);
  });

  it("sends only to the operator test inbox, marked as a SAMPLE test, with SAMPLE links", async () => {
    vi.stubEnv("ENGAGEMENT_EMAIL_BRIDGE_SAMPLE_RECIPIENTS", " Operator@Example.test ");
    const calls = stubResend();
    expect((await callBridge({ host: SAMPLE_HOST, body: contract({ to: "member@example.test" }) })).status).toBe(403);
    expect(calls).toHaveLength(0);
    expect((await callBridge({ host: SAMPLE_HOST, body: contract({ to: "operator@example.test" }) })).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.subject).toBe("[SAMPLE] Chapter update");
    expect(calls[0].body.to).toEqual(["operator@example.test"]);
    expect(calls[0].body.text).toContain(`${SAMPLE_ORIGIN}/m/messages?broadcast=broadcast-1`);
    expect(calls[0].body.text).toContain("SAMPLE test send");
  });

  it("never applies the SAMPLE list on the SaaS host", async () => {
    vi.stubEnv("ENGAGEMENT_EMAIL_BRIDGE_SAMPLE_RECIPIENTS", "operator@example.test");
    const calls = stubResend();
    expect((await callBridge({ host: PORTAL_HOST })).status).toBe(200);
    expect(calls[0].body.to).toEqual(["member@example.test"]);
    expect(calls[0].body.subject).toBe("Chapter update");
  });
});

describe("the delivery route and the bridge together", () => {
  function routeRequest() {
    return { method: "GET", query: {}, headers: { ...vercelCronTickHeaders(CRON, "*/15 * * * *"), host: PORTAL_HOST } };
  }

  function jsonResponse(value, status = 200) {
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value), json: async () => value };
  }

  // The route's webhook call goes through the real bridge handler; Resend and
  // the database are stubs.
  function stubWorld({ kind = "broadcast", category = "announcements", path = "/m/messages?broadcast=b-1", resend = () => resendReply(200), webhook = null } = {}) {
    const seen = { webhook: [], resend: [], complete: [] };
    let claimed = false;
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      const target = String(url);
      if (target.includes("claim_engagement_delivery_batch")) {
        if (claimed) return jsonResponse([]);
        claimed = true;
        return jsonResponse([{ id: DELIVERY, deliveryKind: kind, sourceKind: kind, sourceId: "s-1" }]);
      }
      if (target.includes("get_engagement_delivery_payload")) return jsonResponse({
        available: true, email: "member@example.test", locale: "en", subject: "Hello", body: "Body text.",
        path, category, transactional: false, unsubscribeToken: tokenFor(category),
      });
      if (target.includes("complete_engagement_delivery")) {
        seen.complete.push(JSON.parse(init.body));
        return jsonResponse({ state: "ok" });
      }
      if (target === BRIDGE_URL && webhook) return webhook(init);
      if (target === BRIDGE_URL) {
        const headers = Object.fromEntries(Object.entries(init.headers).map(([name, value]) => [name.toLowerCase(), value]));
        seen.webhook.push(headers);
        const response = recorder();
        await bridge({ method: init.method, headers: { ...headers, host: new URL(target).host }, body: init.body }, response);
        return { ok: response.out.status >= 200 && response.out.status < 300, status: response.out.status };
      }
      if (target === RESEND_URL) {
        seen.resend.push({ headers: init.headers, body: JSON.parse(init.body) });
        const reply = resend();
        if (reply instanceof Error) throw reply;
        return reply;
      }
      throw new Error(`unexpected URL ${target}`);
    }));
    return seen;
  }

  async function runRoute() {
    const response = recorder();
    await route(routeRequest(), response);
    return response.out;
  }

  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", CRON);
    vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
    vi.stubEnv("ENGAGEMENT_EMAIL_WEBHOOK_URL", BRIDGE_URL);
  });

  it.each([
    ["broadcast", "announcements", "/m/messages?broadcast=b-1"],
    ["welcome", "welcome", "/m"],
    ["survey_invitation", "surveys", "/m/voice?survey=s-1"],
    ["survey_reminder", "surveys", "/m/voice?survey=s-1"],
  ])("a %s row the route sends reaches Resend once and is recorded sent", async (kind, category, path) => {
    const seen = stubWorld({ kind, category, path });
    expect(await runRoute()).toMatchObject({ status: 200, body: { claimed: 1, sent: 1, failed: 0, suppressed: 0 } });
    expect(seen.webhook).toHaveLength(1);
    expect(seen.webhook[0].authorization).toBe(`Bearer ${WEBHOOK_TOKEN}`);
    expect(seen.resend).toHaveLength(1);
    expect(seen.resend[0].headers["Idempotency-Key"]).toBe(`ug-engagement-${DELIVERY}`);
    expect(seen.resend[0].headers.Authorization).toBe(`Bearer ${RESEND_KEY}`);
    expect(seen.resend[0].body.to).toEqual(["member@example.test"]);
    expect(seen.resend[0].body.headers).toEqual({
      "List-Unsubscribe": `<${unsubscribeFor(category)}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(seen.resend[0].body.text).toContain(`${PORTAL_ORIGIN}${path}`);
    expect(seen.complete).toEqual([{ p_delivery_id: DELIVERY, p_lease_token: expect.any(String), p_success: true }]);
  });

  it("a Resend 429 becomes the route's 15-minute rate-limit retry", async () => {
    const seen = stubWorld({ resend: () => resendReply(429) });
    expect(await runRoute()).toMatchObject({ status: 503, body: { failed: 1, sent: 0 } });
    expect(seen.complete).toEqual([expect.objectContaining({ p_success: false, p_error_code: "provider_rate_limited", p_retry_after_seconds: 900 })]);
  });

  it("a Resend 5xx or no answer becomes a 5-minute retry, and the retry reuses the same Resend key so nothing goes out twice", async () => {
    for (const failure of [() => resendReply(500), () => new TypeError("fetch failed")]) {
      const first = stubWorld({ resend: failure });
      await runRoute();
      expect(first.complete).toEqual([expect.objectContaining({ p_success: false, p_error_code: "provider_5xx", p_retry_after_seconds: 300 })]);
      const retry = stubWorld();
      expect(await runRoute()).toMatchObject({ status: 200, body: { sent: 1 } });
      expect(retry.resend[0].headers["Idempotency-Key"]).toBe(first.resend[0].headers["Idempotency-Key"]);
    }
  });

  it("a row the bridge refuses is recorded as the route's own request problem and reaches no one", async () => {
    const seen = stubWorld({ path: "/admin" });
    expect(await runRoute()).toMatchObject({ status: 503, body: { failed: 1 } });
    expect(seen.resend).toHaveLength(0);
    expect(seen.complete).toEqual([expect.objectContaining({ p_success: false, p_error_code: "provider_4xx", p_retry_after_seconds: 300 })]);
  });

  // R-9410: the route's own request through Node's real fetch, to the bridge on
  // a loopback server. Node adds Sec-Fetch-Mode to every request, which the
  // shared origin check counts as a browser. Only the Host is set to the
  // custom domain, as Vercel's edge does; every other header is what Node sent.
  it("the route's real Node fetch reaches the bridge on loopback and the row is sent", async () => {
    const arrived = [];
    const server = createServer((incoming, outgoing) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", async () => {
        arrived.push(incoming.headers);
        const response = {
          status(code) { outgoing.statusCode = code; return this; },
          setHeader(name, value) { outgoing.setHeader(name, value); return this; },
          end(value) { outgoing.end(value); return this; },
        };
        await bridge({
          method: incoming.method,
          headers: { ...incoming.headers, host: PORTAL_HOST },
          body: Buffer.concat(chunks).toString("utf8"),
        }, response);
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const loopback = `http://127.0.0.1:${server.address().port}/api/engagement-email-bridge`;
    try {
      const seen = stubWorld({ webhook: (init) => realFetch(loopback, init) });
      expect(await runRoute()).toMatchObject({ status: 200, body: { claimed: 1, sent: 1, failed: 0 } });
      expect(arrived).toHaveLength(1);
      expect(arrived[0]["sec-fetch-mode"]).toBe("cors");
      expect(arrived[0].authorization).toBe(`Bearer ${WEBHOOK_TOKEN}`);
      expect(seen.resend).toHaveLength(1);
      expect(seen.complete).toEqual([expect.objectContaining({ p_success: true })]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("a token mismatch between the route's setting and the bridge's check sends nothing", async () => {
    vi.stubEnv("ENGAGEMENT_EMAIL_WEBHOOK_TOKEN", WEBHOOK_TOKEN);
    const seen = stubWorld();
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => (String(url) === BRIDGE_URL
      ? original(url, { ...init, headers: { ...init.headers, Authorization: "Bearer someone-else" } })
      : original(url, init))));
    expect(await runRoute()).toMatchObject({ status: 503, body: { failed: 1 } });
    expect(seen.resend).toHaveLength(0);
    expect(seen.complete).toEqual([expect.objectContaining({ p_error_code: "provider_4xx" })]);
  });
});
