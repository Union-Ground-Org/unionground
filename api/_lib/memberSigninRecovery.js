import { createHash } from "node:crypto";
import { supabaseHeaders, supabaseRpc } from "./http.js";

export const RECOVERY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECOVERY_LOCK_KEY = "member_signin_recovery_operation_id";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeRecoveryEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !EMAIL.test(email)) return null;
  return email;
}

export function recoveryEmailDigest(email) {
  return createHash("sha256").update(email).digest("hex");
}

function adminHeaders(serviceRoleKey) {
  return {
    ...supabaseHeaders(serviceRoleKey),
    "Content-Type": "application/json",
  };
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export async function getAuthUser(supabaseUrl, serviceRoleKey, userId) {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    headers: adminHeaders(serviceRoleKey),
    signal: AbortSignal.timeout(8000),
  });
  return { ok: response.ok, status: response.status, payload: await parseResponse(response) };
}

export async function updateAuthEmail(supabaseUrl, serviceRoleKey, userId, email) {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    headers: adminHeaders(serviceRoleKey),
    body: JSON.stringify({ email, email_confirm: true }),
    signal: AbortSignal.timeout(8000),
  });
  return { ok: response.ok, status: response.status, payload: await parseResponse(response) };
}

export function authUserIsBanned(payload) {
  const bannedUntil = Date.parse(String(payload?.banned_until || ""));
  return Number.isFinite(bannedUntil) && bannedUntil > Date.now();
}

export function authUserRecoveryLock(payload) {
  const operationId = String(payload?.app_metadata?.[RECOVERY_LOCK_KEY] || "");
  return RECOVERY_UUID.test(operationId) ? operationId : null;
}

export async function setAuthUserRecoveryBan(supabaseUrl, serviceRoleKey, userId, operationId, enabled) {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    headers: adminHeaders(serviceRoleKey),
    body: JSON.stringify({
      ban_duration: enabled ? "876000h" : "none",
      app_metadata: { [RECOVERY_LOCK_KEY]: enabled ? operationId : null },
    }),
    signal: AbortSignal.timeout(8000),
  });
  return { ok: response.ok, status: response.status, payload: await parseResponse(response) };
}

// Ends every Auth session of one account. Supabase Auth has no admin route
// that logs out another user (POST /auth/v1/logout acts only on the caller's
// own session), so the service-role RPC deletes the account's auth.sessions
// rows: their refresh tokens are revoked and private.mfa_satisfied() refuses
// the remaining access tokens (BUG-UG-ADMIN-SESSION-REVOKE-ENDPOINT-20261003).
export async function logoutAuthUser(supabaseUrl, serviceRoleKey, userId) {
  const result = await supabaseRpc(supabaseUrl, serviceRoleKey, serviceRoleKey,
    "end_member_auth_sessions", { p_user_id: userId });
  return result?.ended === true;
}
