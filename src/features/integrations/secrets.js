export const API_KEY_PREFIX = "ug_live_";
export const SCIM_TOKEN_PREFIX = "ug_scim_";
export const WEBHOOK_SECRET_PREFIX = "whsec_";

function toHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function generateSecret(prefix) {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `${prefix}${toHex(bytes)}`;
}

export async function hashSecret(plaintext) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plaintext));
  return toHex(new Uint8Array(digest));
}

export function displayPrefix(plaintext, prefix) {
  return plaintext.slice(0, Math.min(prefix.length + 4, 16));
}

export function oneTimeSecretEnvelope(plaintext, prefix) {
  return Object.freeze({
    plaintext,
    prefix: displayPrefix(plaintext, prefix),
    shownOnce: true,
  });
}

export async function hmacSha256Hex(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return toHex(new Uint8Array(signature));
}

export function sanitizeWebhookRow(row) {
  const { secretHash: _secretHash, ...rest } = row;
  return { ...rest, secretPresent: Boolean(row.secretHash) };
}

export function sanitizeApiKeyRow(row) {
  const { keyHash: _keyHash, ...rest } = row;
  return rest;
}
