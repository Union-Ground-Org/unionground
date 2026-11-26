// @vitest-environment node
//
// REQ-UG-SIGNUP-AND-ACCOUNT-MAIL-FAILURES-RAISE-NO-PRIVATE-ALERT-20261111:
// api/account-mail-events.js accepts only the mail provider's signed, fresh,
// unseen deliveries, turns the five failure types into one content-free
// private record each, and keeps no recipient or other body field anywhere.
import { createHmac } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler, {
  ACCOUNT_MAIL_EVENT_KINDS, accountMailEventClock, MAX_REMEMBERED_IDS, resetAccountMailEventReplays,
} from "../api/account-mail-events.js";
import { resetAccountMailAlerts } from "../api/_lib/accountMailAlerts.js";

// Built at run time so no signing-value-shaped literal sits in the source.
const KEY = Buffer.from("account-mail-events-test-signing-value");
const SECRET = `whsec_${KEY.toString("base64")}`;
const NOW = 1_794_000_000;
const RECIPIENT = "member@example.invalid";
const WEBHOOK = "https://hooks.slack.com/services/T000/B000/synthetic";

function sign(id, timestamp, raw, key = KEY) {
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`).digest("base64")}`;
}

function event(type, extra = {}) {
  return JSON.stringify({
    type,
    created_at: "2026-11-11T19:30:00.000Z",
    data: { email_id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c", from: "Union Ground <alerts@example.invalid>", to: [RECIPIENT], subject: "Confirm your email for Union Ground", bounce: { message: `550 ${RECIPIENT} does not exist` } },
    ...extra,
  });
}

function recorder() {
  const out = { status: 0, headers: {}, body: null };
  return {
    out,
    status(code) { out.status = code; return this; },
    setHeader(name, value) { out.headers[name] = value; },
    end(body) { out.body = body ? JSON.parse(body) : null; },
  };
}

// The request Vercel's Node helpers hand a function (addHelpers in
// @vercel/node): the body is already read, its bytes are replayed through
// on("data") and on("end"), and `body` is a lazy getter that parses them.
function vercelRequest(raw, bodyReads) {
  const request = Readable.from([]);
  const replay = new PassThrough();
  const replayOn = replay.on.bind(replay);
  const originalOn = request.on.bind(request);
  request.read = replay.read.bind(replay);
  request.on = request.addListener = (name, listener) => (name === "data" || name === "end" ? replayOn(name, listener) : originalOn(name, listener));
  replay.end(Buffer.from(raw));
  Object.defineProperty(request, "body", {
    configurable: true,
    enumerable: true,
    get() {
      bodyReads.push(raw);
      try { return JSON.parse(raw); } catch { throw Object.assign(new Error("Invalid JSON"), { statusCode: 400 }); }
    },
  });
  return request;
}

async function post(raw, { id = "msg_2b8Hcq1Mf2l3", timestamp = String(NOW), signature, method = "POST", stream = false, vercel = null, headers = {} } = {}) {
  const res = recorder();
  const request = vercel ? vercelRequest(raw, vercel) : stream ? Readable.from([Buffer.from(raw)]) : { body: raw };
  request.method = method;
  request.headers = {
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": signature ?? sign(id, timestamp, raw),
    ...headers,
  };
  await handler(request, res);
  return res.out;
}

let warn;
let fetchMock;
beforeEach(() => {
  vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("UG_ALERTS_SLACK_WEBHOOK_URL", WEBHOOK);
  vi.spyOn(accountMailEventClock, "nowSeconds").mockReturnValue(NOW);
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal("fetch", fetchMock);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  resetAccountMailEventReplays();
  resetAccountMailAlerts();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const record = (kind, count = 1) => [JSON.stringify({ event: "account-mail-failure", kind, count })];

describe("POST /api/account-mail-events", () => {
  it("reads the signed bytes from a Vercel request and never its parsed body", async () => {
    const bodyReads = [];
    expect(await post(event("email.bounced"), { id: "msg_vercel", vercel: bodyReads })).toMatchObject({ status: 200, body: { received: true } });
    expect(warn.mock.calls).toEqual([record("provider_bounced")]);
    // Bytes Vercel's getter would throw on are still verified, then refused as an envelope.
    expect(await post("{not json", { id: "msg_vercel_malformed", vercel: bodyReads })).toMatchObject({ status: 400, body: { error: "invalid-envelope" } });
    expect(await post(event("email.bounced"), { id: "msg_vercel_unsigned", vercel: bodyReads, signature: "v1,AAAA" })).toMatchObject({ status: 401 });
    expect(await post("x".repeat(70_000), { id: "msg_vercel_large", vercel: bodyReads })).toMatchObject({ status: 400, body: { error: "invalid-envelope" } });
    expect(bodyReads).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each(Object.entries(ACCOUNT_MAIL_EVENT_KINDS))("records %s as %s, from a parsed or streamed body", async (type, kind) => {
    const out = await post(event(type), { id: `msg_${kind}` });
    expect(out).toMatchObject({ status: 200, body: { received: true } });
    expect(await post(event(type), { id: `msg_${kind}_stream`, stream: true })).toMatchObject({ status: 200 });
    expect(warn.mock.calls).toEqual([record(kind, 1), record(kind, 2)]);
  });

  it("raises one metadata-only alert and keeps no recipient, subject, sender or provider text", async () => {
    await post(event("email.bounced"), { id: "msg_one" });
    await post(event("email.bounced"), { id: "msg_two" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(WEBHOOK);
    const sent = JSON.stringify([init.body, warn.mock.calls]);
    expect(JSON.parse(init.body).text).toContain("kind: provider_bounced");
    for (const value of [RECIPIENT, "example.invalid", "Confirm your email", "does not exist", "4ef9a417", "msg_one"]) {
      expect(sent).not.toContain(value);
    }
  });

  it("acknowledges other event types and records nothing", async () => {
    for (const type of ["email.sent", "email.delivered", "email.opened", "domain.updated", "toString", "__proto__", 7]) {
      expect(await post(event(type), { id: `msg_${String(type).replace(/\W/g, "")}x` })).toMatchObject({ status: 200, body: { received: true } });
    }
    expect(warn).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["no signature", { signature: "" }],
    ["a signature by another key", { signature: sign("msg_2b8Hcq1Mf2l3", String(NOW), event("email.bounced"), Buffer.from("another-signing-value")) }],
    ["a signature over another body", { signature: sign("msg_2b8Hcq1Mf2l3", String(NOW), event("email.failed")) }],
    ["a signature for another id", { id: "msg_other", signature: sign("msg_2b8Hcq1Mf2l3", String(NOW), event("email.bounced")) }],
    ["an unknown signature version", { signature: sign("msg_2b8Hcq1Mf2l3", String(NOW), event("email.bounced")).replace("v1,", "v2,") }],
    ["a truncated signature", { signature: "v1,AAAA" }],
    ["a timestamp six minutes old", { timestamp: String(NOW - 360) }],
    ["a timestamp six minutes ahead", { timestamp: String(NOW + 360) }],
    ["a non-numeric timestamp", { timestamp: "soon" }],
    ["a missing id", { id: "" }],
    ["an id with unexpected characters", { id: "msg 1;drop" }],
  ])("refuses %s and records nothing", async (_label, options) => {
    const raw = event("email.bounced");
    const signature = options.signature ?? sign(options.id ?? "msg_2b8Hcq1Mf2l3", options.timestamp ?? String(NOW), raw);
    const out = await post(raw, { ...options, signature });
    expect(out).toMatchObject({ status: 401, body: { error: "request-refused" } });
    expect(warn).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts any listed signature when the provider rotates keys", async () => {
    const raw = event("email.failed");
    const signature = `v1,${Buffer.alloc(32).toString("base64")} ${sign("msg_rotated", String(NOW), raw)}`;
    expect(await post(raw, { id: "msg_rotated", signature })).toMatchObject({ status: 200 });
    expect(warn.mock.calls).toEqual([record("provider_failed")]);
  });

  it("ignores a replayed delivery inside the window and refuses it after", async () => {
    const raw = event("email.complained");
    expect(await post(raw)).toMatchObject({ status: 200 });
    expect(await post(raw)).toMatchObject({ status: 200, body: { received: true } });
    accountMailEventClock.nowSeconds.mockReturnValue(NOW + 301);
    expect(await post(raw)).toMatchObject({ status: 401 });
    expect(warn.mock.calls).toEqual([record("provider_complained")]);
  });

  it("records a delivery once however often the provider retries it, freshly signed, across its retry schedule", async () => {
    const raw = event("email.delivery_delayed");
    expect(await post(raw, { id: "msg_late" })).toMatchObject({ status: 200 });
    // Resend's schedule ends 27 h 35 min 5 s after the first attempt.
    for (const later of [5, 305, 601, 2105, 9305, 27_305, 63_305, 99_305]) {
      accountMailEventClock.nowSeconds.mockReturnValue(NOW + later);
      expect(await post(raw, { id: "msg_late", timestamp: String(NOW + later) })).toMatchObject({ status: 200, body: { received: true } });
    }
    expect(warn.mock.calls).toEqual([record("provider_delivery_delayed", 1)]);
    // Past the schedule the id is forgotten, so the memory stays bounded.
    accountMailEventClock.nowSeconds.mockReturnValue(NOW + 30 * 3600);
    expect(await post(raw, { id: "msg_late", timestamp: String(NOW + 30 * 3600) })).toMatchObject({ status: 200 });
    expect(warn.mock.calls).toEqual([record("provider_delivery_delayed", 1), record("provider_delivery_delayed", 2)]);
  });

  it("remembers a bounded number of accepted ids and drops the oldest first", async () => {
    const quiet = event("email.delivered");
    for (let index = 0; index <= MAX_REMEMBERED_IDS; index += 1) await post(quiet, { id: `msg_${index}` });
    expect(warn).not.toHaveBeenCalled();
    expect(await post(event("email.bounced"), { id: `msg_${MAX_REMEMBERED_IDS}` })).toMatchObject({ status: 200 });
    expect(warn).not.toHaveBeenCalled();
    expect(await post(event("email.bounced"), { id: "msg_0" })).toMatchObject({ status: 200 });
    expect(warn.mock.calls).toEqual([record("provider_bounced")]);
  });

  it.each([
    ["is unset", undefined],
    ["lacks the whsec_ prefix", KEY.toString("base64")],
    ["is too short", "whsec_c2hvcnQ="],
  ])("refuses every call while the signing value %s", async (_label, value) => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", value);
    expect(await post(event("email.bounced"))).toMatchObject({ status: 401, body: { error: "request-refused" } });
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses an unreadable or oversized body and a signed body that is not JSON", async () => {
    const res = recorder();
    await handler({ method: "POST", headers: {}, body: { type: "email.bounced" } }, res);
    expect(res.out).toMatchObject({ status: 400, body: { error: "invalid-envelope" } });
    expect(await post("x".repeat(70_000), { stream: true })).toMatchObject({ status: 400, body: { error: "invalid-envelope" } });
    expect(await post("not json")).toMatchObject({ status: 400, body: { error: "invalid-envelope" } });
    expect(warn).not.toHaveBeenCalled();
  });

  it("answers only POST", async () => {
    expect(await post(event("email.bounced"), { method: "GET" })).toMatchObject({ status: 405 });
  });
});
