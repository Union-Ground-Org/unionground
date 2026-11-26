import { createHmac, timingSafeEqual } from "node:crypto";
import { requestHost } from "./http.js";
import { usableSecret } from "./secretStrength.js";

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/i;
const MESSAGE_SID = /^SM[0-9a-f]{32}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const STOP = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT"]);
const START = new Set(["START", "YES", "UNSTOP"]);
const HELP = new Set(["HELP", "INFO"]);

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeHttpsOrigin(value) {
  try {
    const url = new URL(clean(value));
    if (url.protocol !== "https:" || url.username || url.password
        || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function requestHeader(request, name) {
  if (typeof request?.headers?.get === "function") return request.headers.get(name) || "";
  const wanted = name.toLowerCase();
  const entry = Object.entries(request?.headers || {}).find(([key]) => key.toLowerCase() === wanted);
  return String(entry?.[1] || "");
}

export function parseTwilioParams(body) {
  const source = typeof body === "string" ? new URLSearchParams(body) : body;
  const params = {};
  if (source instanceof URLSearchParams) {
    for (const [key, value] of source.entries()) {
      if (Object.hasOwn(params, key)) return null;
      params[key] = value;
    }
    return params;
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string" || key.length > 80 || value.length > 2_000) return null;
    params[key] = value;
  }
  return params;
}

export function parseTwilioAccountRegistry(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw || ""));
  } catch {
    return { ok: false, reason: "registry_invalid" };
  }
  if (!Array.isArray(parsed) || parsed.length > 50) return { ok: false, reason: "registry_invalid" };
  const accounts = new Map();
  for (const value of parsed) {
    const accountSid = clean(value?.accountSid);
    const authToken = clean(value?.authToken);
    const organizationId = clean(value?.organizationId);
    const fromNumber = clean(value?.fromNumber);
    const fromNumbers = Array.isArray(value?.fromNumbers) ? value.fromNumbers.map(clean) : [fromNumber];
    const webhookBaseUrl = normalizeHttpsOrigin(value?.webhookBaseUrl);
    if (!ACCOUNT_SID.test(accountSid) || authToken.length < 16 || authToken.length > 128
        || !UUID.test(organizationId) || !E164.test(fromNumber)
        || fromNumbers.length < 1 || fromNumbers.length > 50
        || !fromNumbers.includes(fromNumber) || fromNumbers.some((number) => !E164.test(number))
        || new Set(fromNumbers).size !== fromNumbers.length
        || !webhookBaseUrl || accounts.has(accountSid)) {
      return { ok: false, reason: "registry_invalid" };
    }
    accounts.set(accountSid, {
      accountSid, authToken, organizationId, fromNumber,
      allowedFromNumbers: new Set(fromNumbers), webhookBaseUrl,
    });
  }
  return { ok: true, accounts };
}

export function twilioRegistryForSurface(env, surface) {
  const key = surface === "demo" ? "SAMPLE_TWILIO_ACCOUNTS_JSON" : "TWILIO_ACCOUNTS_JSON";
  return parseTwilioAccountRegistry(env?.[key]);
}

export function resolveTwilioSignatureUrl(request, webhookBaseUrl) {
  const host = requestHost(request);
  const protocol = (requestHeader(request, "x-forwarded-proto") || "https").split(",")[0].trim();
  const current = new URL(String(request?.url || "/"), `${protocol}://${host}`);
  const base = new URL(webhookBaseUrl);
  current.protocol = base.protocol;
  current.host = base.host;
  return current.toString();
}

export function validateTwilioSignature({ authToken, signature, url, params }) {
  if (!clean(authToken) || !clean(signature) || !clean(url) || !params) return false;
  let signed = url;
  for (const key of Object.keys(params).sort()) signed += `${key}${params[key]}`;
  const expected = createHmac("sha1", authToken).update(signed).digest("base64");
  return safeEqual(expected, signature);
}

function keyword(value) {
  const normalized = clean(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalized || null;
}

export function classifyTwilioConsent(body, optOutType = "") {
  const advanced = keyword(optOutType);
  const candidate = advanced || keyword(body);
  if (candidate && STOP.has(candidate)) return { eventType: "opt_out", keyword: candidate };
  if (candidate && START.has(candidate)) return { eventType: "opt_in", keyword: candidate };
  if (candidate && HELP.has(candidate)) return { eventType: "help", keyword: candidate };
  return { eventType: "unknown", keyword: null };
}

export function providerReferenceDigest(accountSid, messageSid, salt) {
  if (!ACCOUNT_SID.test(clean(accountSid)) || !MESSAGE_SID.test(clean(messageSid)) || !usableSecret(clean(salt))) {
    return null;
  }
  return createHmac("sha256", salt).update(`${accountSid}:${messageSid}`).digest("hex");
}

export function phoneDigest(phone, salt) {
  if (!E164.test(clean(phone)) || clean(salt).length < 32) return null;
  return createHmac("sha256", salt).update(phone).digest("hex");
}

export function bodyDigest(body, salt) {
  if (clean(salt).length < 32) return null;
  return createHmac("sha256", salt).update(String(body || "")).digest("hex");
}

export function validE164(value) {
  return E164.test(clean(value));
}

export function validMessageSid(value) {
  return MESSAGE_SID.test(clean(value));
}

export async function persistTwilioResult(write, {
  attempts = 4,
  wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
} = {}) {
  let lastError = new Error("result_not_recorded");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (await write() === true) return true;
      lastError = new Error("result_not_recorded");
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts) await wait(75 * (2 ** attempt));
  }
  throw lastError;
}

export async function sendTwilioMessage({ account, to, body, statusCallbackUrl, fetchImpl = fetch }) {
  if (!account || !validE164(to) || !clean(body) || clean(body).length > 1_600) {
    return { ok: false, reason: "invalid_send" };
  }
  const payload = new URLSearchParams({ To: to, From: account.fromNumber, Body: body });
  if (statusCallbackUrl) payload.set("StatusCallback", statusCallbackUrl);
  let response;
  try {
    response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${account.accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${account.accountSid}:${account.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: payload,
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    return { ok: false, reason: "provider_unavailable" };
  }
  if (!response.ok) {
    return { ok: false, reason: "provider_rejected" };
  }
  const result = await response.json().catch(() => null);
  if (!validMessageSid(result?.sid)) {
    return { ok: false, reason: "provider_response_uncertain" };
  }
  return { ok: true, messageSid: result.sid, status: clean(result.status) || "queued" };
}
