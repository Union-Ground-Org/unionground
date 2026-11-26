import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { requestHost } from "./http.js";
import {
  calendarOAuthRedirectUri,
  isCalendarProvider,
  providerEnvKeys,
  resolveCalendarOAuthStatus,
  wrapKeyName,
} from "../../src/features/calendarFreeBusy/config.js";

function envString(env, key) {
  return String(env?.[key] || "").trim();
}

function wrapKeyBytes(env, surface) {
  const raw = envString(env, wrapKeyName(surface));
  if (raw.length < 32) return null;
  return createHash("sha256").update(raw).digest();
}

const OAUTH_BINDING_COOKIE_PREFIX = "calendar_oauth_binding_";

function decodeCanonicalBase64Url(value, expectedLength = null) {
  const encoded = String(value || "");
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded) return null;
  if (expectedLength !== null && decoded.length !== expectedLength) return null;
  return decoded;
}

export function newOAuthBrowserBinding() {
  return randomBytes(32).toString("base64url");
}

export function hashOAuthBrowserBinding(value) {
  const binding = String(value || "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(binding)) return "";
  return createHash("sha256").update(binding).digest("base64url");
}

export function readOAuthBrowserBindings(headers) {
  const cookieHeader = String(headers?.cookie || "");
  const bindings = [];
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (!name.startsWith(OAUTH_BINDING_COOKIE_PREFIX)) continue;
    const provider = name.slice(OAUTH_BINDING_COOKIE_PREFIX.length);
    if (!isCalendarProvider(provider)) continue;
    const value = rest.join("=");
    if (hashOAuthBrowserBinding(value)) bindings.push({ provider, value });
  }
  return bindings;
}

export function oauthBrowserBindingCookie(provider, value, { clear = false } = {}) {
  if (!isCalendarProvider(provider)) throw new Error("unknown_provider");
  const encoded = clear ? "" : String(value || "");
  const maxAge = clear ? 0 : 600;
  return `${OAUTH_BINDING_COOKIE_PREFIX}${provider}=${encoded}; Path=/api/calendar-oauth; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function readProviderSecrets(env, surface, provider) {
  const keys = providerEnvKeys(surface, provider);
  return {
    clientId: envString(env, keys.clientId),
    clientSecret: envString(env, keys.clientSecret),
    tenant: keys.tenant ? envString(env, keys.tenant) : "",
  };
}

export function publicOAuthStatus(env, surface) {
  const status = resolveCalendarOAuthStatus(env, { surface });
  return {
    providers: {
      google: { configured: status.providers.google.configured },
      microsoft: { configured: status.providers.microsoft.configured },
    },
  };
}

export function encryptRefreshToken(env, surface, plaintext) {
  const key = wrapKeyBytes(env, surface);
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function decryptRefreshToken(env, surface, envelope) {
  const key = wrapKeyBytes(env, surface);
  if (!key) return null;
  const parts = String(envelope || "").split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const iv = decodeCanonicalBase64Url(parts[1], 12);
    const tag = decodeCanonicalBase64Url(parts[2], 16);
    const ciphertext = decodeCanonicalBase64Url(parts[3]);
    if (!iv || !tag || !ciphertext?.length) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  return { verifier, challenge, state };
}

export function redirectForRequest(request) {
  return calendarOAuthRedirectUri(requestHost(request));
}
