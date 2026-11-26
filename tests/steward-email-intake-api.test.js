// @vitest-environment node
import { createHmac } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/steward-email-intake.js";
import { SAMPLE_BACKEND } from "../src/lib/sampleBackend.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

function responseRecorder() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body; },
  };
}

function rpcResponse(payload, status = 200) {
  const body = payload == null ? "" : JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

const SECRET = "email-intake-test-secret";
const NOW = 1_786_576_800_000;
const envelope = {
  messageId: "provider-message-7",
  chapterId: "wor",
  from: "member@example.test",
  subject: "Schedule question",
  text: "Could a steward call me?",
  receivedAt: "2026-08-12T12:00:00.000Z",
};

const SITE = "unionground.net";
const SAMPLE_SITE = "demo.example.com";

// The relay signs `<timestamp>.<site host>.<raw body>`
// (BUG-UG-STEWARD-EMAIL-INTAKE-IS-NOT-READY-FOR-A-RELAY-20261122).
function sign(timestamp, host, raw) {
  return createHmac("sha256", SECRET).update(`${timestamp}.${host}.`).update(raw).digest("hex");
}

function signedRequest(overrides = {}) {
  const raw = overrides.raw ?? JSON.stringify(overrides.envelope ?? envelope);
  const timestamp = overrides.timestamp ?? String(Math.floor(NOW / 1000));
  const host = overrides.host ?? SITE;
  const signature = overrides.signature ?? sign(timestamp, overrides.signedHost ?? host, raw);
  return {
    method: overrides.method ?? "POST",
    headers: {
      host,
      "x-union-email-timestamp": timestamp,
      "x-union-email-signature": signature,
      ...(overrides.headers ?? {}),
    },
    body: raw,
  };
}

// The request Vercel's Node helpers hand a function (addHelpers in
// @vercel/node), as tests/account-mail-events-api.test.js models it: the body
// is already read, its bytes are replayed through on("data") and on("end"),
// and `body` is a lazy getter that parses JSON (and throws on malformed JSON).
function vercelRequest(signed, bodyReads) {
  const raw = signed.body;
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
  request.method = signed.method;
  request.headers = { "content-type": "application/json", ...signed.headers };
  return request;
}

const HEX64 = /^[a-f0-9]{64}$/;

async function postedDigest(envelopeOverrides = {}) {
  global.fetch = vi.fn().mockResolvedValue(rpcResponse({ accepted: true, duplicate: false }));
  const response = responseRecorder();
  await handler(signedRequest({ envelope: { ...envelope, ...envelopeOverrides } }), response);
  expect(response.statusCode).toBe(202);
  const rpc = JSON.parse(global.fetch.mock.calls[0][1].body);
  return rpc.p_provider_message_digest;
}

beforeEach(() => {
  vi.stubEnv("STEWARD_EMAIL_INTAKE_SECRET", SECRET);
  vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_service-role-key");
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("steward email intake endpoint", () => {
  it("authenticates streamed bytes with Fetch-style headers before accepting the envelope", async () => {
    global.fetch = vi.fn().mockResolvedValue(rpcResponse({ accepted: true }));
    const signed = signedRequest({ envelope: { ...envelope, senderAuthentication: { dmarc: "pass", spf: "pass" } } });
    const response = responseRecorder();
    await handler({
      method: "POST", headers: new Headers(signed.headers),
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(signed.body.slice(0, 20));
        yield signed.body.slice(20);
      },
    }, response);
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).p_sender_authenticated).toBe(true);
  });

  it("refuses oversized streams, pre-parsed bodies and unreadable requests without an RPC", async () => {
    global.fetch = vi.fn();
    const signed = signedRequest();
    const requests = [
      { ...signed, body: envelope },
      { ...signed, body: undefined },
      { ...signed, body: undefined, async *[Symbol.asyncIterator]() { yield "x".repeat(65_537); } },
    ];
    for (const request of requests) {
      const response = responseRecorder();
      await handler(request, response);
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: "invalid-envelope" });
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([null, [], { ...envelope, text: "" }, { ...envelope, receivedAt: "invalid" }])(
    "refuses a signed invalid envelope without forwarding private content (%j)", async (value) => {
      global.fetch = vi.fn();
      const response = responseRecorder();
      await handler(signedRequest({ raw: JSON.stringify(value) }), response);
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: "invalid-envelope" });
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  it("keeps an unaccepted service response indistinguishable from other refusals", async () => {
    global.fetch = vi.fn().mockResolvedValue(rpcResponse({ accepted: false }));
    const response = responseRecorder();
    await handler(signedRequest(), response);
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: "request-refused" });
  });

  it("verifies exact raw bytes and sends only the bounded envelope to the service-only RPC", async () => {
    global.fetch = vi.fn().mockResolvedValue(rpcResponse({ accepted: true, duplicate: false }));
    const response = responseRecorder();
    await handler(signedRequest(), response);
    expect(response.statusCode).toBe(202);
    expect(response.headers["Cache-Control"]).toBe("no-store");
    expect(JSON.parse(response.body)).toEqual({ accepted: true });
    const [url, request] = global.fetch.mock.calls[0];
    expect(url).toContain("/rpc/ingest_steward_email");
    expect(request.headers.Authorization).toBeUndefined();
    const rpc = JSON.parse(request.body);
    expect(rpc).toMatchObject({
      p_chapter_id: "wor",
      p_from_address: "member@example.test",
      p_subject: "Schedule question",
      p_body_text: "Could a steward call me?",
    });
    expect(rpc.p_provider_message_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(rpc.p_sender_authenticated).toBe(false);
    expect(JSON.stringify(response)).not.toContain("member@example.test");
  });

  it("only passes sender authentication when the signed envelope has aligned mail-auth results", async () => {
    global.fetch = vi.fn().mockResolvedValue(rpcResponse({ accepted: true, duplicate: false }));
    const authenticated = responseRecorder();
    await handler(signedRequest({ envelope: { ...envelope, senderAuthentication: { dmarc: "pass", dkim: "pass", spf: "fail" } } }), authenticated);
    expect(authenticated.statusCode).toBe(202);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).p_sender_authenticated).toBe(true);
    const unaligned = responseRecorder();
    await handler(signedRequest({ envelope: { ...envelope, senderAuthentication: { dmarc: "fail", dkim: "pass", spf: "pass" } } }), unaligned);
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).p_sender_authenticated).toBe(false);
  });

  it.each([
    ["missing secret", () => vi.stubEnv("STEWARD_EMAIL_INTAKE_SECRET", ""), signedRequest()],
    ["bad signature", () => {}, signedRequest({ signature: "0".repeat(64) })],
    ["stale timestamp", () => {}, signedRequest({ timestamp: String(Math.floor(NOW / 1000) - 301) })],
    ["unknown chapter", () => { global.fetch = vi.fn().mockResolvedValue(rpcResponse({ error: "chapter missing" }, 400)); }, signedRequest()],
  ])("returns one uniform refusal for %s without leaking content", async (_label, setup, request) => {
    setup();
    const response = responseRecorder();
    await handler(request, response);
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: "request-refused" });
    expect(response.body).not.toContain("member@example.test");
    expect(response.body).not.toContain("Could a steward call me");
  });

  it("rejects oversized and malformed bodies before any RPC", async () => {
    global.fetch = vi.fn();
    for (const request of [signedRequest({ raw: "x".repeat(65_537) }), signedRequest({ raw: "{" })]) {
      const response = responseRecorder();
      await handler(request, response);
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: "invalid-envelope" });
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("verifies original bytes before strictly decoding the signed envelope", async () => {
    global.fetch = vi.fn();
    const timestamp = String(Math.floor(NOW / 1000));
    const raw = Buffer.concat([
      Buffer.from('{"messageId":"byte-proof","chapterId":"wor","from":"member@example.test","subject":"","text":"'),
      Buffer.from([0xff]),
      Buffer.from('","receivedAt":"2026-08-12T12:00:00.000Z"}'),
    ]);
    const signature = sign(timestamp, SITE, raw);
    const response = responseRecorder();
    await handler({ method: "POST", headers: { host: SITE, "x-union-email-timestamp": timestamp, "x-union-email-signature": signature }, body: raw }, response);
    // 400 proves the exact bytes passed authentication and then failed strict
    // UTF-8 decoding. Re-encoding replacement text before HMAC yields 401.
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "invalid-envelope" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("treats duplicate delivery as accepted and never logs body/address/provider errors", async () => {
    global.fetch = vi.fn().mockResolvedValue(rpcResponse({ accepted: true, duplicate: true }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = responseRecorder();
    await handler(signedRequest(), response);
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toEqual({ accepted: true });
    expect(JSON.stringify([...error.mock.calls, ...warn.mock.calls])).not.toMatch(/member@example\.test|Could a steward call me|Schedule question/);
  });

  it("digest is chapter-scoped", async () => {
    const wor = await postedDigest({ chapterId: "wor" });
    const spr = await postedDigest({ chapterId: "spr" });
    expect(wor).toMatch(HEX64);
    expect(spr).toMatch(HEX64);
    expect(wor).not.toEqual(spr);
  });

  it("reads a relay message sent as JSON from Vercel's replayed stream, never from the parsed body", async () => {
    global.fetch = vi.fn().mockResolvedValue(rpcResponse({ accepted: true, duplicate: false }));
    const bodyReads = [];
    const response = responseRecorder();
    await handler(vercelRequest(signedRequest(), bodyReads), response);
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toEqual({ accepted: true });
    expect(bodyReads).toEqual([]);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({ p_chapter_id: "wor", p_body_text: "Could a steward call me?" });
  });

  it("refuses an oversized or malformed replayed stream with 400 before any RPC", async () => {
    global.fetch = vi.fn();
    for (const raw of ["x".repeat(65_537), "{"]) {
      const bodyReads = [];
      const response = responseRecorder();
      await handler(vercelRequest(signedRequest({ raw }), bodyReads), response);
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: "invalid-envelope" });
      expect(bodyReads).toEqual([]);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("reads a plain Node request stream of text and byte chunks, and answers 400 when the stream fails", async () => {
    global.fetch = vi.fn().mockResolvedValue(rpcResponse({ accepted: true, duplicate: false }));
    const signed = signedRequest();
    const streamed = Object.assign(Readable.from([signed.body.slice(0, 20), Buffer.from(signed.body.slice(20))]), { method: "POST", headers: signed.headers });
    const accepted = responseRecorder();
    await handler(streamed, accepted);
    expect(accepted.statusCode).toBe(202);

    global.fetch.mockClear();
    const failing = new PassThrough();
    Object.assign(failing, { method: "POST", headers: signed.headers });
    const refused = responseRecorder();
    const pending = handler(failing, refused);
    failing.destroy(new Error("connection reset"));
    await pending;
    expect(refused.statusCode).toBe(400);
    expect(JSON.parse(refused.body)).toEqual({ error: "invalid-envelope" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("answers 400 at the read deadline for a stream that already ended and replays nothing", async () => {
    global.fetch = vi.fn();
    const signed = signedRequest();
    const ended = Readable.from([Buffer.from(signed.body)]);
    ended.resume();
    await new Promise((resolve) => ended.once("end", resolve));
    Object.assign(ended, { method: "POST", headers: signed.headers });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const response = responseRecorder();
    const pending = handler(ended, response);
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "invalid-envelope" });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers 400 at once when a request is aborted or closes before it completes, with no error event", async () => {
    global.fetch = vi.fn();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const signed = signedRequest();
    const aborted = Object.assign(new PassThrough(), { method: "POST", headers: signed.headers, complete: false });
    const closed = Object.assign(new PassThrough(), { method: "POST", headers: signed.headers });
    const abortedResponse = responseRecorder();
    const abortedPending = handler(aborted, abortedResponse);
    aborted.write(signed.body.slice(0, 20));
    aborted.emit("aborted");
    await abortedPending;
    const closedResponse = responseRecorder();
    const closedPending = handler(closed, closedResponse);
    closed.write(signed.body.slice(0, 20));
    closed.destroy();
    await closedPending;
    for (const response of [abortedResponse, closedResponse]) {
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: "invalid-envelope" });
    }
    expect(global.fetch).not.toHaveBeenCalled();
    expect(aborted.listenerCount("aborted")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers 400 after ten seconds of silence before any signature or database work, and leaves only its error listener and no timer", async () => {
    global.fetch = vi.fn().mockResolvedValue(rpcResponse({ accepted: true, duplicate: false }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const signed = signedRequest();
    const silent = Object.assign(new PassThrough(), { method: "POST", headers: signed.headers });
    const response = responseRecorder();
    let settled = false;
    const pending = handler(silent, response).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "invalid-envelope" });
    expect(global.fetch).not.toHaveBeenCalled();
    for (const name of ["data", "end", "aborted", "close"]) expect(silent.listenerCount(name)).toBe(0);
    expect(silent.listenerCount("error")).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    const prompt = Object.assign(Readable.from([Buffer.from(signed.body)]), { method: "POST", headers: signed.headers });
    const accepted = responseRecorder();
    await handler(prompt, accepted);
    expect(accepted.statusCode).toBe(202);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an error listener after an abort or the read deadline, so a late stream error does not throw", async () => {
    global.fetch = vi.fn();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const signed = signedRequest();
    const aborted = Object.assign(new PassThrough(), { method: "POST", headers: signed.headers, complete: false });
    const abortedResponse = responseRecorder();
    const abortedPending = handler(aborted, abortedResponse);
    aborted.emit("aborted");
    await abortedPending;
    const silent = Object.assign(new PassThrough(), { method: "POST", headers: signed.headers });
    const silentResponse = responseRecorder();
    const silentPending = handler(silent, silentResponse);
    await vi.advanceTimersByTimeAsync(10_000);
    await silentPending;
    for (const [stream, response] of [[aborted, abortedResponse], [silent, silentResponse]]) {
      expect(response.statusCode).toBe(400);
      expect(() => stream.emit("error", new Error("late socket error"))).not.toThrow();
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("answers a refused host and a header-less request at once, without reading the body or waiting on the read deadline", async () => {
    global.fetch = vi.fn();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const unsent = (overrides, setup = () => {}) => {
      const signed = signedRequest(overrides);
      return { setup, request: Object.assign(new PassThrough(), { method: "POST", headers: signed.headers }) };
    };
    const headerless = unsent({});
    delete headerless.request.headers["x-union-email-timestamp"];
    delete headerless.request.headers["x-union-email-signature"];
    const cases = [
      unsent({ host: "unlisted-preview.vercel.app" }, () => vi.stubEnv("VITE_APP_SURFACE", "demo")),
      headerless,
      unsent({ signature: "not-a-signature" }),
      unsent({ timestamp: String(Math.floor(NOW / 1000) - 301) }),
      unsent({}, () => vi.stubEnv("STEWARD_EMAIL_INTAKE_SECRET", "")),
    ];
    for (const { setup, request } of cases) {
      vi.unstubAllEnvs();
      vi.stubEnv("STEWARD_EMAIL_INTAKE_SECRET", SECRET);
      vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_service-role-key");
      setup();
      const response = responseRecorder();
      await handler(request, response);
      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body)).toEqual({ error: "request-refused" });
      expect(request.listenerCount("data")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("accepts a message only on the site its signature names", async () => {
    vi.stubEnv("SAMPLE_SUPABASE_URL", `https://${SAMPLE_BACKEND.sampleSupabaseRef}.supabase.co`);
    vi.stubEnv("SAMPLE_SUPABASE_SERVICE_ROLE_KEY", "sb_secret_sample-service-role-key");
    global.fetch = vi.fn().mockResolvedValue(rpcResponse({ accepted: true, duplicate: false }));

    const onSample = responseRecorder();
    await handler(signedRequest({ host: SAMPLE_SITE }), onSample);
    expect(onSample.statusCode).toBe(202);
    expect(global.fetch.mock.calls[0][0]).toContain(`${SAMPLE_BACKEND.sampleSupabaseRef}.supabase.co`);

    const onProduction = responseRecorder();
    await handler(signedRequest({ host: SITE }), onProduction);
    expect(onProduction.statusCode).toBe(202);
    expect(global.fetch.mock.calls[1][0]).toContain("project.supabase.co");

    global.fetch.mockClear();
    for (const [signedHost, host] of [[SAMPLE_SITE, SITE], [SITE, SAMPLE_SITE], [SITE, `www.${SITE}`]]) {
      const replayed = responseRecorder();
      await handler(signedRequest({ host, signedHost }), replayed);
      expect(replayed.statusCode).toBe(401);
      expect(JSON.parse(replayed.body)).toEqual({ error: "request-refused" });
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("refuses a signature that names no site, and a request with no readable host", async () => {
    global.fetch = vi.fn();
    const timestamp = String(Math.floor(NOW / 1000));
    const raw = JSON.stringify(envelope);
    const unbound = createHmac("sha256", SECRET).update(`${timestamp}.${raw}`).digest("hex");
    const hostless = signedRequest({ signedHost: "" });
    delete hostless.headers.host;
    const requests = [signedRequest({ signature: unbound }), hostless, signedRequest({ signedHost: "", headers: { host: "" } })];
    for (const request of requests) {
      const response = responseRecorder();
      await handler(request, response);
      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body)).toEqual({ error: "request-refused" });
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("answers anything but POST with 405 and reads nothing", async () => {
    global.fetch = vi.fn();
    const response = responseRecorder();
    await handler(signedRequest({ method: "GET" }), response);
    expect(response.statusCode).toBe(405);
    expect(JSON.parse(response.body)).toEqual({ error: "method-not-allowed" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("digest is stable for one chapter+message pair", async () => {
    const first = await postedDigest({ chapterId: "wor", messageId: "provider-message-7" });
    const second = await postedDigest({ chapterId: "wor", messageId: "provider-message-7" });
    expect(first).toMatch(HEX64);
    expect(second).toMatch(HEX64);
    expect(first).toBe(second);
  });
});
