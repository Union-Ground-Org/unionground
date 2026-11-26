// Small server helpers the intake queue shares: a UUID shape, a service-role
// RPC call with a bounded timeout, and request body and token readers. Upstream
// keeps them in its organization-claim module, which Union Ground leaves out
// with the public union catalog claim flow.
import { supabaseHeaders } from "./http.js";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function plainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasQueryString(request) {
  return String(request?.url || "").includes("?");
}

export function parseBody(value) {
  if (plainObject(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return plainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function tokenClaims(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return plainObject(payload) ? payload : null;
  } catch {
    return null;
  }
}

export async function serviceRpc(config, name, args) {
  let response;
  try {
    response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: supabaseHeaders(config.serviceKey, config.serviceKey, { "Content-Type": "application/json" }),
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw Object.assign(new Error(`${name}-failed`), { status: 0, code: null, detail: "" });
  }
  let parsed;
  try {
    const text = await response.text();
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    throw Object.assign(new Error(`${name}-failed`), {
      status: response.status,
      code: typeof parsed?.code === "string" ? parsed.code : null,
      detail: typeof parsed?.message === "string" ? parsed.message : "",
      // The database's DETAIL token (PostgREST `details`), when it sets one.
      token: typeof parsed?.details === "string" ? parsed.details : "",
    });
  }
  if (!plainObject(parsed)) throw Object.assign(new Error(`${name}-empty-response`), { status: response.status, code: null, detail: "" });
  return parsed;
}
