import {
  authenticate,
  bearerToken,
  json,
  methodGuard,
  unionGroundProvider,
  requireEnv,
  supabaseHeaders,
  supabaseRpc,
  validateMutationOrigin,
} from "./_lib/http.js";
import { logoutAuthUser } from "./_lib/memberSigninRecovery.js";
import { adminRankChecked } from "./_lib/adminRank.js";

// Admin-assisted MFA reset — the way back in for a member who enrolled TOTP and
// then lost the device.
//
// Why this exists at all: GoTrue refuses to unenrol a verified factor from an
// aal1 session (422 "AAL2 required to unenroll verified factor"), and a password
// recovery session is also aal1, so the member cannot climb out on their own and
// there are no backup codes. Without this endpoint the only remedy is somebody
// with the service-role key editing auth tables by hand.
//
// Why it is an endpoint and not an RPC: auth.mfa_factors belongs to GoTrue, and
// its admin API is the only supported way to delete a factor. So the split is:
// Postgres decides WHETHER and establishes a durable pre-reset session boundary
// (begin_mfa_reset, admin-gated, self-reset refused), then records WHAT HAPPENED
// (record_mfa_reset, after the fact); this function is only the hands.
//
// The service-role key never authorizes anything here. Authorization runs as the
// CALLER against the database, so an admin who owes their own MFA code fails the
// check like any other staff action — member_has_role now ANDs in
// private.mfa_satisfied().
//
// SELF-RESET IS REFUSED, twice. begin_mfa_reset refuses `p_user_id = caller`
// in Postgres, and this handler refuses a target equal to the bearer's own
// subject before it makes a single call. The second check is deliberately
// independent of the first: deleting your own factors needs only an aal1
// session, so an admin who could reset themselves would hand any thief of an
// admin password a one-call MFA bypass. One refusal in one place is one bug
// away from that hole; a refusal here survives a bypassed or edited RPC.
export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["POST"], () => json(response, 405, { error: "method-not-allowed" }))) return;

  // The one Union Ground provider, or nothing. unionGroundProvider()
  // refuses any Supabase target the provider contract does not name, so an
  // unprovisioned deployment answers not-configured instead of reaching a
  // sibling product's project.
  const { ok: providerValid, supabaseUrl, publishableKey, serviceRoleKey } = unionGroundProvider();
  if (requireEnv([providerValid, supabaseUrl, publishableKey, serviceRoleKey],
    () => json(response, 503, { error: "not-configured" }))) return;

  const token = bearerToken(request);
  if (!token) {
    json(response, 401, { error: "unauthenticated" });
    return;
  }

  const body = typeof request.body === "string" ? safeParse(request.body) : request.body;
  // Canonical lowercase, so the self-target refusal, the RPC argument and the
  // provider admin path all name the same member.
  const userId = String(body?.userId || "").trim().toLowerCase();
  if (!UUID.test(userId)) {
    json(response, 400, { error: "invalid-user-id" });
    return;
  }

  // 0. Never yourself. The bearer's subject is read WITHOUT verifying the
  //    token: this check can only refuse, never authorize, and a forged subject
  //    still meets begin_mfa_reset, which derives auth.uid() from the verified
  //    token. Same flat answer as every other refusal so the endpoint stays a
  //    non-oracle.
  const subject = tokenSubject(token);
  if (subject && subject.toLowerCase() === userId.toLowerCase()) {
    json(response, 403, { error: "not-permitted" });
    return;
  }

  // Authenticate independently of the authorization RPC. Never trust a decoded
  // claim to grant access; the earlier subject check is only a cheap refusal.
  let caller;
  try { caller = await authenticate(supabaseUrl, publishableKey, token); } catch { /* deny */ }
  if (!UUID.test(caller?.id || "")) return json(response, 401, { error: "unauthenticated" });
  if (caller.id.toLowerCase() === userId.toLowerCase()) {
    return json(response, 403, { error: "not-permitted" });
  }

  // 1. May this caller do this, to this member? Runs as the caller. The same
  //    transaction records a reset boundary before any factor can disappear,
  //    so already-issued target JWTs stay denied even if provider logout fails.
  try {
    const authorization = await supabaseRpc(supabaseUrl, publishableKey, token, "authorize_mfa_reset", { p_user_id: userId });
    if (authorization?.authorized !== true) throw new Error("not-authorized");
    // The database refuses an administrator of equal or lower rank than the
    // target (api/_lib/adminRank.js); without its marker it predates that
    // guard, so nothing is reset.
    if (!adminRankChecked(authorization)) throw new Error("admin-rank-unchecked");
    // Do not replace this with authorization alone: it reconciles recovery
    // locks and closes old sessions and push targets before provider mutation.
    await supabaseRpc(supabaseUrl, publishableKey, token, "begin_mfa_reset", { p_user_id: userId });
  } catch {
    // Deliberately flat: an admin-only endpoint should not distinguish "you are
    // not an admin" from "that member does not exist" from "you cannot reset
    // yourself", or it becomes a membership oracle for whoever can reach it.
    json(response, 403, { error: "not-permitted" });
    return;
  }

  // 2. Remove every factor the member has. Listing first means the audit row can
  //    record how many were actually removed rather than asserting "one".
  let factors;
  try {
    factors = await adminListFactors(supabaseUrl, serviceRoleKey, userId);
  } catch {
    // BUG-UG-MFA-RESET-FOURTH-EXIT-NO-NOTICE-NO-DEBT-20260918: the
    // member's sessions and push targets are already closed, but no factor
    // was touched. The pending-notice debt is NOT used here: it drains as
    // "an administrator removed the authenticator", which is false on this
    // exit. This notice says what did happen — signed out, reset unfinished,
    // authenticator still there.
    let notified = false;
    try {
      const notice = await supabaseRpc(supabaseUrl, publishableKey, token, "notify_member_mfa_reset_incomplete", {
        p_user_id: userId,
      });
      notified = notice?.notified === true || notice?.duplicate === true;
    } catch { /* the response says the member was not told */ }
    json(response, 502, {
      error: "auth-service-unavailable",
      removed: 0,
      staleSessionsBlocked: true,
      notified,
      pendingNotice: false,
    });
    return;
  }

  const removed = [];
  for (const factor of factors) {
    try {
      await adminDeleteFactor(supabaseUrl, serviceRoleKey, userId, factor.id);
      removed.push(factor.id);
    } catch {
      // Partial failure is reported as partial. Claiming success here would tell
      // an admin the member can sign in when they still cannot, and the member
      // would be the one to discover otherwise.
      //
      // The member is still owed the notice: their sessions and push targets
      // are already closed and some factors are already gone. Mark the debt,
      // then try to deliver it.
      await recordQuietly(supabaseUrl, publishableKey, token, userId, removed.length);
      const notice = await settleMemberNotice(supabaseUrl, publishableKey, token, userId, true);
      json(response, 502, {
        error: "partial-reset",
        removed: removed.length,
        total: factors.length,
        staleSessionsBlocked: true,
        notified: notice.notified,
        pendingNotice: notice.pendingNotice,
      });
      return;
    }
  }

  // 3. Revoke the member's live sessions.
  //
  // Without this the reset is half a remedy. Clearing the factors makes
  // private.mfa_satisfied() true again for that member — which is the point —
  // but it makes it true for EVERY token they have, including one an attacker is
  // holding. An access token stays valid until it expires no matter what the
  // factor table says, so the thief who caused the lockout would get a window of
  // full, unchallenged access created by the act of helping the victim.
  //
  // Best-effort: the database boundary already makes every older session fail
  // closed. A provider failure therefore does not undo the reset and is reported
  // in the response rather than swallowed or retried into a false failure.
  let revoked;
  try {
    revoked = await logoutAuthUser(supabaseUrl, serviceRoleKey, userId);
  } catch {
    revoked = false;
  }

  // 4. Audit what happened, after it happened.
  try {
    await supabaseRpc(supabaseUrl, publishableKey, token, "record_mfa_reset", {
      p_user_id: userId,
      p_factors: removed.length,
    });
  } catch {
    // The factors ARE gone; failing the response now would invite a retry that
    // finds nothing to delete and looks like a no-op. Report success with the
    // audit gap named rather than hiding it. notify_member_mfa_reset cannot
    // run here — it is bound to the audit row that was not written — so the
    // debt goes on the reset boundary and the drain, which is bound to the
    // boundary instead, is what tells the member.
    const notice = await settleMemberNotice(supabaseUrl, publishableKey, token, userId, true);
    json(response, 200, {
      removed: removed.length,
      audited: false,
      notified: notice.notified,
      pendingNotice: notice.pendingNotice,
      revoked,
      staleSessionsBlocked: true,
    });
    return;
  }

  // 5. Tell the member. Their sessions are closed and the authenticator is
  //    gone; the in-app row (and, through the delivery outbox, email/push) is
  //    the existing notification path, including for a member
  //    who did not request the reset. Delivery is not guaranteed. Runs as the caller and is bound in
  //    Postgres to the audit row just written, so it cannot fabricate a reset.
  //    Best-effort: the reset is complete either way and the response says
  //    whether the notice landed.
  let notified;
  try {
    const notice = await supabaseRpc(supabaseUrl, publishableKey, token, "notify_member_mfa_reset", {
      p_user_id: userId,
    });
    notified = notice?.notified === true;
  } catch {
    notified = false;
  }

  // 6. Settle the member's notice. When step 5 did not land, the debt is
  //    recorded first and delivered second, on purpose: a mark and a delivery
  //    in one transaction commit or roll back together, and what has to
  //    survive is a delivery that never happens. When step 5 did land, this is
  //    the drain for a debt an EARLIER reset of this member left behind — the
  //    retry, and the only thing that clears a mark whose own drain never ran.
  const settled = await settleMemberNotice(supabaseUrl, publishableKey, token, userId, !notified);

  json(response, 200, {
    removed: removed.length,
    audited: true,
    notified: notified || settled.notified,
    pendingNotice: settled.pendingNotice,
    revoked,
    staleSessionsBlocked: true,
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// The `sub` claim of a JWS compact token, read without verification. Used only
// to REFUSE (self-target); never to grant. Anything malformed reads as "no
// subject", which falls through to the database's own refusal.
export function tokenSubject(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return "";
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const sub = typeof payload?.sub === "string" ? payload.sub.trim() : "";
    return UUID.test(sub) ? sub : "";
  } catch {
    return "";
  }
}

// GoTrue rejects a secret key presented with a browser-shaped User-Agent
// ("Forbidden use of secret API key in browser"), and Vercel's runtime default
// is browser-shaped. Pin it.
function adminHeaders(serviceRoleKey) {
  return {
    ...supabaseHeaders(serviceRoleKey),
    "Content-Type": "application/json",
    "User-Agent": "node",
  };
}

async function adminListFactors(supabaseUrl, serviceRoleKey, userId) {
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}/factors`, {
    headers: adminHeaders(serviceRoleKey),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error("list-factors-failed");
  const payload = await res.json();
  const factors = Array.isArray(payload) ? payload : payload?.factors;
  if (!Array.isArray(factors) || factors.some((factor) => !UUID.test(factor?.id || ""))) {
    throw new Error("invalid-factor-list");
  }
  return factors;
}

async function adminDeleteFactor(supabaseUrl, serviceRoleKey, userId, factorId) {
  // Checked again here, not only in adminListFactors: a service-role DELETE
  // path is never built from an identifier that is not a factor UUID.
  if (!UUID.test(factorId || "")) throw new Error("invalid-factor-id");
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}/factors/${encodeURIComponent(factorId)}`, {
    method: "DELETE",
    headers: adminHeaders(serviceRoleKey),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error("delete-factor-failed");
}

// The member's out-of-band notice, made durable.
//
// BUG-UG-MFA-RESET-PARTIAL-NO-MEMBER-NOTICE-20260917: three paths used to
// end here with nothing owed and nothing to retry, because the only notice
// writer is bound to a member_admin_audit row from this caller inside a
// fifteen-minute window — a window a partial reset, a failed audit write and a
// failed notice all leave without one. queue_member_mfa_reset_notice marks the
// debt on the reset boundary begin_mfa_reset already wrote, so it outlives
// that window; drain_member_mfa_reset_notice delivers it, at most once per
// reset, in its own transaction. Both are best-effort here for the same reason
// step 5 is: the reset itself is complete either way and the response says
// which of the two happened.
//
// `queue` is false once the notice already landed — then this is only the
// drain for a debt an earlier reset of the same member left pending.
async function settleMemberNotice(supabaseUrl, publishableKey, token, userId, queue) {
  let owed = false;
  if (queue) {
    try {
      const queued = await supabaseRpc(supabaseUrl, publishableKey, token, "queue_member_mfa_reset_notice", {
        p_user_id: userId,
      });
      owed = queued?.pending === true;
    } catch { /* nothing durable was written; the drain below still runs */ }
  }
  try {
    const drained = await supabaseRpc(supabaseUrl, publishableKey, token, "drain_member_mfa_reset_notice", {
      p_user_id: userId,
    });
    // `duplicate` is the drain recognising a notice THIS reset already has —
    // written by notify_member_mfa_reset, or by an earlier drain whose answer
    // never came back. The member has been told, so the admin is told they
    // were: reporting not-notified here would send an administrator to phone a
    // member who already has the notice in their inbox.
    const told = drained?.notified === true || drained?.duplicate === true;
    return { notified: told, pendingNotice: owed && drained?.drained !== true };
  } catch {
    // The mark is committed and a later reset for this member drains it.
    return { notified: false, pendingNotice: owed };
  }
}

async function recordQuietly(supabaseUrl, publishableKey, token, userId, count) {
  if (count === 0) return;
  try {
    await supabaseRpc(supabaseUrl, publishableKey, token, "record_mfa_reset", {
      p_user_id: userId,
      p_factors: count,
    });
  } catch { /* the 502 already tells the truth */ }
}
