import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { requestHostname, resolveSupabaseBackend } from "./_lib/backend.js";
import { json, methodGuard, supabaseRpc } from "./_lib/http.js";

// Preserve the bytes the sender signed. Reconstructing JSON from a parsed
// object would accept a signature for bytes the endpoint never received.
// Vercel's Node runtime does not honour this setting: it has already read the
// body, so readRawBody takes the bytes from the replayed stream instead.
export const config = { api: { bodyParser: false } };

const MAX_BODY_BYTES = 65_536;
const MAX_CLOCK_SKEW_SECONDS = 300;
const CHAPTER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}$/;
const HEX_SHA256 = /^[a-f0-9]{64}$/;

function header(request, name) {
  if (typeof request.headers?.get === "function") return request.headers.get(name) || "";
  const wanted = name.toLowerCase();
  const found = Object.entries(request.headers || {}).find(([key]) => key.toLowerCase() === wanted);
  return String(found?.[1] || "");
}

// Vercel's Node helpers read the body before the handler runs, replay its
// bytes through request.on("data") and request.on("end"), and make
// request.body a getter that parses JSON (and throws on malformed JSON). A
// relay message sent as application/json would reach a body check as an
// object, so a request stream is read through those events and its body
// getter is never touched, as api/account-mail-events.js does
// (BUG-UG-STEWARD-EMAIL-INTAKE-IS-NOT-READY-FOR-A-RELAY-20261122).
// The read settles once: on end, error, aborted, a close before the request
// completed, or READ_DEADLINE_MS of silence. A stream that already ended and
// replays nothing settles at the deadline, not at once, because Vercel's
// replaying request can look already ended while its bytes are still to come.
const READ_DEADLINE_MS = 10_000;

function readReplayedStream(request) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    let timer;
    const listeners = {
      data: (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes <= MAX_BODY_BYTES) chunks.push(buffer);
      },
      end: () => settle(bytes <= MAX_BODY_BYTES ? Buffer.concat(chunks) : null),
      error: () => settle(null),
      aborted: () => settle(null),
      close: () => {
        if (request.complete !== true && request.readableEnded !== true) settle(null);
      },
    };
    function settle(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The error listener stays attached (settle is a no-op now): a stream
      // that errors after an abort or the deadline would otherwise have no
      // error listener and throw an uncaught exception.
      for (const [name, listener] of Object.entries(listeners)) {
        if (name !== "error") request.removeListener?.(name, listener);
      }
      resolve(value);
    }
    timer = setTimeout(() => settle(null), READ_DEADLINE_MS);
    for (const [name, listener] of Object.entries(listeners)) request.on(name, listener);
  });
}

async function readRawBody(request) {
  if (typeof request.on === "function") return readReplayedStream(request);
  if (typeof request.body === "string") return Buffer.from(request.body, "utf8");
  if (Buffer.isBuffer(request.body)) return request.body;
  if (request.body !== undefined && request.body !== null) return null;
  if (typeof request[Symbol.asyncIterator] !== "function") return null;

  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

// The signed text is `<timestamp>.<site host>.<raw body>`. The site host is
// the request hostname the database is chosen from (resolveSupabaseBackend),
// so one secret shared by both sites cannot carry a message signed for one
// site into the other's database.
// The handler has already refused an empty secret or host and a supplied
// value that is not 64 hex characters before it read the body.
function signatureMatches(secret, timestamp, siteHost, rawBytes, supplied) {
  const expected = createHmac("sha256", secret).update(`${timestamp}.${siteHost}.`).update(rawBytes).digest();
  const received = Buffer.from(supplied, "hex");
  return received.byteLength === expected.byteLength && timingSafeEqual(received, expected);
}

function boundedEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const messageId = typeof value.messageId === "string" ? value.messageId.trim() : "";
  const chapterId = typeof value.chapterId === "string" ? value.chapterId.trim() : "";
  const from = typeof value.from === "string" ? value.from.trim().toLowerCase() : "";
  const subject = typeof value.subject === "string" ? value.subject.trim() : "";
  const text = typeof value.text === "string" ? value.text.trim() : "";
  const receivedAt = typeof value.receivedAt === "string" ? value.receivedAt : "";
  const receivedTime = Date.parse(receivedAt);
  // These results are part of the exact bytes covered by the relay HMAC.
  // An address match alone cannot authenticate the author of an email.
  const senderAuthentication = value.senderAuthentication;
  const senderAuthenticated = senderAuthentication?.dmarc === "pass"
    && (senderAuthentication?.spf === "pass" || senderAuthentication?.dkim === "pass");

  if (messageId.length < 1 || messageId.length > 500
      || !CHAPTER_ID.test(chapterId)
      || from.length < 3 || from.length > 320 || !EMAIL.test(from)
      || subject.length > 500
      || text.length < 1 || text.length > 60_000
      || receivedAt.length < 20 || receivedAt.length > 40
      || !Number.isFinite(receivedTime)) return null;

  return { messageId, chapterId, from, subject, text, receivedAt: new Date(receivedTime).toISOString(), senderAuthenticated };
}

function refusal(response) {
  json(response, 401, { error: "request-refused" });
}

export default async function handler(request, response) {
  if (methodGuard(request, ["POST"], () => json(response, 405, { error: "method-not-allowed" }))) return;

  const secret = process.env.STEWARD_EMAIL_INTAKE_SECRET || "";
  const siteHost = requestHostname(request);
  const { url: supabaseUrl, serviceRoleKey: serviceKey } = resolveSupabaseBackend(request);
  const timestamp = header(request, "x-union-email-timestamp");
  const suppliedSignature = header(request, "x-union-email-signature").toLowerCase();

  // Every refusal that needs no body is answered before the body is read, so
  // an unsigned, stale or misrouted request never waits on the read deadline.
  const sentAt = Number(timestamp);
  if (!secret || !siteHost || !supabaseUrl || !serviceKey
      || !Number.isSafeInteger(sentAt)
      || Math.abs(Math.floor(Date.now() / 1000) - sentAt) > MAX_CLOCK_SKEW_SECONDS
      || !HEX_SHA256.test(suppliedSignature)) {
    refusal(response);
    return;
  }

  const raw = await readRawBody(request);
  if (raw === null || raw.byteLength > MAX_BODY_BYTES) {
    json(response, 400, { error: "invalid-envelope" });
    return;
  }

  if (!signatureMatches(secret, timestamp, siteHost, raw, suppliedSignature)) {
    refusal(response);
    return;
  }

  let parsed;
  try {
    // A valid signature does not make malformed text safe to reinterpret.
    // Fatal decoding rejects invalid UTF-8 instead of silently replacing bytes
    // and storing content different from what the provider signed.
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    json(response, 400, { error: "invalid-envelope" });
    return;
  }
  const envelope = boundedEnvelope(parsed);
  if (!envelope) {
    json(response, 400, { error: "invalid-envelope" });
    return;
  }

  // Only an irreversible digest of the provider identifier is retained for
  // replay control. Provider failures are deliberately not logged: their
  // messages can echo addresses, subjects, or bodies.
  const providerMessageDigest = createHash("sha256")
    .update(`${envelope.chapterId}\0${envelope.messageId}`)
    .digest("hex");

  try {
    const result = await supabaseRpc(
      supabaseUrl,
      serviceKey,
      serviceKey,
      "ingest_steward_email",
      {
        p_provider_message_digest: providerMessageDigest,
        p_chapter_id: envelope.chapterId,
        p_from_address: envelope.from,
        p_subject: envelope.subject,
        p_body_text: envelope.text,
        p_received_at: envelope.receivedAt,
        p_sender_authenticated: envelope.senderAuthenticated,
      },
    );
    if (result?.accepted !== true) throw new Error("intake-refused");
  } catch {
    refusal(response);
    return;
  }

  json(response, 202, { accepted: true });
}
