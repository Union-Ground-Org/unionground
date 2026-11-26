import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { CRON_SECRET_MIN_LENGTH, json, unionGroundProvider, supabaseRpc } from "./_lib/http.js";
import { validateUnionGroundAppUrl } from "../src/lib/providerContract.js";
import { usableSecret } from "./_lib/secretStrength.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Control characters are matched on purpose: intake refuses them in every field.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;
const ACTIVATION_CONFIRM = "ENABLE_ONLY_AFTER_CONTACT_VERIFICATION_REVIEWER_AND_PURGE_READY";
const BODY_KEYS = new Set([
  "requestId",
  "firstName",
  "contactMethod",
  "contact",
  "region",
  "language",
  "bestTime",
  "consent",
  "safeToContact",
  "voicemailAllowed",
  "website",
]);

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    json(response, 405, { error: "method-not-allowed" });
    return;
  }

  const contentLength = Number(header(request, "content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > 4096) {
    json(response, 413, { error: "request-too-large" });
    return;
  }
  const contentType = header(request, "content-type")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    json(response, 415, { error: "json-required" });
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // Every activation interlock answers the caller with the same opaque 503 on
    // purpose: an anonymous visitor must not be able to probe which one is
    // missing. The operator turning intake on does need to know, and this is the
    // only place that knows — so the reason goes to the function log and nowhere
    // near the response body.
    console.error(`[connect] not-configured: ${error?.message || "unknown"}`);
    json(response, 503, { error: "not-configured" });
    return;
  }

  const requestOrigin = header(request, "origin");
  const fetchSite = header(request, "sec-fetch-site").toLowerCase();
  if (requestOrigin !== config.appOrigin || (fetchSite && fetchSite !== "same-origin")) {
    json(response, 403, { error: "origin-not-permitted" });
    return;
  }

  const body = parseBody(request.body);
  if (!body || Object.keys(body).some((key) => !BODY_KEYS.has(key))) {
    json(response, 400, { error: "invalid-request" });
    return;
  }
  const rawBody = JSON.stringify(body);
  if (Buffer.byteLength(rawBody, "utf8") > 4096) {
    json(response, 413, { error: "request-too-large" });
    return;
  }

  const requestId = clean(body.requestId, 36).toLowerCase();
  if (!UUID.test(requestId)) {
    json(response, 400, { error: "invalid-request" });
    return;
  }

  // A filled honeypot receives the same accepted shape as a real submission,
  // but no request is persisted.
  if (clean(body.website, 200)) {
    json(response, 202, { accepted: true, requestId });
    return;
  }

  const payload = validatePayload(body);
  if (!payload) {
    json(response, 400, { error: "invalid-request" });
    return;
  }
  const remoteAddress = clientAddress(request);
  if (!remoteAddress) {
    json(response, 503, { error: "request-source-unavailable" });
    return;
  }

  const normalizedPayload = JSON.stringify(payload);
  const submittedAt = new Date();
  const plaintext = JSON.stringify({
    ...payload,
    consentVersion: "2026-07-24-v1",
    consentedAt: submittedAt.toISOString(),
  });
  const encryptionKey = deriveKey(config.rootSecret, "connect-encryption-v1");
  const digestKey = deriveKey(config.rootSecret, "connect-idempotency-v1");
  const rateKey = deriveKey(config.rootSecret, "connect-rate-v1");
  const digest = createHmac("sha256", digestKey)
    .update(`${requestId}|${normalizedPayload}`)
    .digest("hex");
  const sourceHour = submittedAt.toISOString().slice(0, 13);
  const ipHash = createHmac("sha256", rateKey)
    .update(`${sourceHour}|${remoteAddress}`)
    .digest("hex");
  const iv = randomBytes(12);
  const aad = Buffer.from(`${requestId}|${config.keyVersion}`, "utf8");
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  let result;
  try {
    result = await supabaseRpc(
      config.supabaseUrl,
      config.serviceRoleKey,
      config.serviceRoleKey,
      "submit_unionground_connect_request",
      {
        p_request_id: requestId,
        p_payload_ciphertext: ciphertext.toString("base64"),
        p_payload_iv: iv.toString("base64"),
        p_payload_auth_tag: authTag.toString("base64"),
        p_payload_digest: digest,
        p_key_version: config.keyVersion,
        p_ip_hash: ipHash,
      },
    );
  } catch {
    json(response, 503, { error: "temporarily-unavailable" });
    return;
  }

  if (!result?.accepted && result?.reason === "rate-limit") {
    response.setHeader("Retry-After", "3600");
    json(response, 429, { error: "rate-limited" });
    return;
  }
  if (!result?.accepted || result?.requestId !== requestId) {
    json(response, 503, { error: "temporarily-unavailable" });
    return;
  }

  json(response, 202, { accepted: true, requestId });
}

// Each interlock throws its own message. The caller always sees the same
// "not-configured", but these are unrelated operator problems with unrelated
// fixes, so the log has to be able to tell them apart. No message repeats a
// secret's value — only the name of the variable that failed.
function loadConfig() {
  if (process.env.UNIONGROUND_CONNECT_ENABLED !== "1") {
    throw new Error("UNIONGROUND_CONNECT_ENABLED is not 1");
  }
  if (process.env.VITE_UNIONGROUND_CONNECT_ENABLED !== "1") {
    throw new Error("VITE_UNIONGROUND_CONNECT_ENABLED is not 1");
  }
  if (process.env.UNIONGROUND_CONNECT_ACTIVATION_CONFIRM !== ACTIVATION_CONFIRM) {
    throw new Error("UNIONGROUND_CONNECT_ACTIVATION_CONFIRM does not match the activation phrase");
  }
  const provider = unionGroundProvider();
  if (!provider.ok) throw new Error(provider.reason);
  const supabaseUrl = provider.supabaseUrl;
  const serviceRoleKey = String(provider.serviceRoleKey || "");
  const cronSecret = String(process.env.CRON_SECRET || "");

  const appUrl = validateUnionGroundAppUrl(
    process.env.UNIONGROUND_APP_URL,
    { path: "/" },
  );
  const keyVersion = String(
    process.env.UNIONGROUND_CONNECT_KEY_VERSION || "",
  ).trim();
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(keyVersion)) {
    throw new Error("UNIONGROUND_CONNECT_KEY_VERSION missing or malformed");
  }
  if (serviceRoleKey.length < 20) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY missing or too short");
  }
  // The fourth activation interlock, and the least obvious one: intake may not
  // collect anything until the daily retention purge can authorize itself, so a
  // weak CRON_SECRET keeps the whole endpoint closed. Shares one floor with
  // api/_lib/http.js authorizeCronRequest — the purge is what enforces it.
  if (!usableSecret(cronSecret, CRON_SECRET_MIN_LENGTH)) {
    throw new Error(`CRON_SECRET missing, placeholder or shorter than ${CRON_SECRET_MIN_LENGTH} characters (retention-purge interlock)`);
  }

  const encodedSecret = String(
    process.env.UNIONGROUND_CONNECT_SECRET || "",
  ).trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encodedSecret)) {
    throw new Error("connect secret must be canonical base64");
  }
  const rootSecret = Buffer.from(encodedSecret, "base64");
  if (rootSecret.length !== 32 || rootSecret.toString("base64") !== encodedSecret) {
    throw new Error("connect secret must decode to 32 bytes");
  }
  return {
    appOrigin: appUrl.origin,
    keyVersion,
    rootSecret,
    serviceRoleKey,
    supabaseUrl,
  };
}

function deriveKey(rootSecret, label) {
  return createHmac("sha256", rootSecret).update(label, "utf8").digest();
}

function parseBody(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function clean(value, max) {
  if (typeof value !== "string" || CONTROL.test(value)) return "";
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized.length <= max ? normalized : "";
}

function validatePayload(body) {
  const firstName = clean(body.firstName, 80);
  const contactMethod = clean(body.contactMethod, 10);
  const contact = clean(body.contact, 254);
  const region = clean(body.region, 80);
  const language = clean(body.language, 10);
  const bestTime = clean(body.bestTime, 12);

  if (
    firstName.length < 1
    || !["northeast", "south", "midwest", "west", "territories", "outside-us"].includes(region)
    || !["email", "phone", "text"].includes(contactMethod)
    || !["en", "es", "other"].includes(language)
    || !["morning", "afternoon", "evening", "any"].includes(bestTime)
    || body.consent !== true
    || body.safeToContact !== true
    || typeof body.voicemailAllowed !== "boolean"
  ) {
    return null;
  }
  if (contactMethod === "email") {
    if (
      contact.length > 254
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(contact)
    ) return null;
  } else {
    const digits = contact.replace(/\D/gu, "");
    if (contact.length > 32 || digits.length < 7 || digits.length > 15) return null;
  }
  return {
    firstName,
    contactMethod,
    contact,
    region,
    language,
    bestTime,
    safeToContact: true,
    voicemailAllowed: contactMethod === "phone" && body.voicemailAllowed,
  };
}

function clientAddress(request) {
  const forwarded = header(request, "x-forwarded-for");
  const value = String(forwarded || request.socket?.remoteAddress || "")
    .split(",")[0]
    .trim();
  return isIP(value) ? value.toLowerCase() : "";
}

function header(request, name) {
  const headers = request.headers || {};
  return String(headers[name] ?? headers[name.toLowerCase()] ?? "");
}
