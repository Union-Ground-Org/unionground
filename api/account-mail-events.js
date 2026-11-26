import { createHmac, timingSafeEqual } from "node:crypto";
import { recordAccountMailFailure } from "./_lib/accountMailAlerts.js";
import { json, methodGuard } from "./_lib/http.js";

// Receiver for the mail provider's delivery-failure events
// (REQ-UG-SIGNUP-AND-ACCOUNT-MAIL-FAILURES-RAISE-NO-PRIVATE-ALERT-20261111).
//
// Resend signs each webhook delivery the Svix way: HMAC-SHA256 over
// `<id>.<timestamp>.<raw body>` with the base64 key after `whsec_`, sent as
// space-separated `v1,<base64>` signatures. This route verifies that
// signature over the exact bytes received, refuses a missing or wrong one and
// a timestamp more than five minutes off, and ignores an id this instance
// accepted within the provider's retry schedule. It reads only the event
// type: the recipient, subject, sender and every other field of the body are
// never stored, logged or sent on. The bounce, failure, suppression,
// complaint and delayed-delivery types become one private record each
// (accountMailAlerts.js); every other type is acknowledged and dropped.
// Without RESEND_WEBHOOK_SECRET every call is refused.
// names the address and setup.

export const ACCOUNT_MAIL_EVENT_KINDS = Object.freeze({
  "email.bounced": "provider_bounced",
  "email.failed": "provider_failed",
  "email.suppressed": "provider_suppressed",
  "email.complained": "provider_complained",
  "email.delivery_delayed": "provider_delivery_delayed",
});

const MAX_BODY_BYTES = 65_536;
const MAX_CLOCK_SKEW_SECONDS = 300;
// Resend retries an unacknowledged delivery under the same id, freshly signed,
// for 27 hours 35 minutes (immediately, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h,
// 10 h), so an accepted id is remembered past that.
const REMEMBER_ID_SECONDS = 30 * 3600;
export const MAX_REMEMBERED_IDS = 10_000;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TIMESTAMP = /^[0-9]{1,12}$/;
const SIGNING_SECRET = /^whsec_([A-Za-z0-9+/]{16,}={0,2})$/;

// Accepted ids on this instance, oldest first. A replay or provider retry of
// one is acknowledged without a second record; a copy of an old delivery is
// refused by its timestamp.
const seen = new Map();
export function resetAccountMailEventReplays() {
  seen.clear();
}

export const accountMailEventClock = { nowSeconds: () => Math.floor(Date.now() / 1000) };

function header(request, name) {
  const value = request.headers?.[name];
  return typeof value === "string" ? value.trim() : "";
}

// Vercel's Node helpers read the body before the handler runs, replay its
// bytes through request.on("data") and request.on("end"), and make
// request.body a getter that parses them (and throws on malformed JSON). The
// signature covers the bytes, so a request stream is read through those
// events and its body getter is never touched.
function readRawBody(request) {
  if (typeof request?.on !== "function") {
    const body = request?.body;
    if (typeof body === "string") return Buffer.from(body, "utf8");
    return Buffer.isBuffer(body) ? body : null;
  }
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes <= MAX_BODY_BYTES) chunks.push(buffer);
    });
    request.on("end", () => resolve(bytes <= MAX_BODY_BYTES ? Buffer.concat(chunks) : null));
    request.on("error", () => resolve(null));
  });
}

function signingKey(secret) {
  const match = SIGNING_SECRET.exec(String(secret ?? "").trim());
  return match ? Buffer.from(match[1], "base64") : null;
}

export function signatureMatches(key, id, timestamp, raw, supplied) {
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(raw).digest();
  return supplied.split(" ").some((entry) => {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) return false;
    const received = Buffer.from(value, "base64");
    return received.byteLength === expected.byteLength && timingSafeEqual(received, expected);
  });
}

function forgetExpired(now) {
  for (const [id, expiresAt] of seen) {
    if (expiresAt > now) break;
    seen.delete(id);
  }
}

function remember(id, now) {
  if (seen.size >= MAX_REMEMBERED_IDS) seen.delete(seen.keys().next().value);
  seen.set(id, now + REMEMBER_ID_SECONDS);
}

export default async function handler(request, response) {
  if (methodGuard(request, ["POST"], () => json(response, 405, { error: "method-not-allowed" }))) return;
  const key = signingKey(process.env.RESEND_WEBHOOK_SECRET);
  const id = header(request, "svix-id");
  const timestamp = header(request, "svix-timestamp");
  const supplied = header(request, "svix-signature");
  const raw = await readRawBody(request);
  if (raw === null) return json(response, 400, { error: "invalid-envelope" });

  const now = accountMailEventClock.nowSeconds();
  if (!key || !MESSAGE_ID.test(id) || !TIMESTAMP.test(timestamp)
      || Math.abs(now - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS
      || !supplied || supplied.length > 1024
      || !signatureMatches(key, id, timestamp, raw, supplied)) {
    return json(response, 401, { error: "request-refused" });
  }

  forgetExpired(now);
  if (seen.has(id)) return json(response, 200, { received: true });

  let type;
  try {
    // A valid signature does not make malformed bytes safe to reinterpret.
    type = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw))?.type;
  } catch {
    return json(response, 400, { error: "invalid-envelope" });
  }
  remember(id, now);
  const kind = typeof type === "string" && Object.hasOwn(ACCOUNT_MAIL_EVENT_KINDS, type) ? ACCOUNT_MAIL_EVENT_KINDS[type] : null;
  if (kind) recordAccountMailFailure(kind);
  return json(response, 200, { received: true });
}
