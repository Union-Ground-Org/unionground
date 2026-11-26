import { accountEmailDomainBlocked, EMAIL_DOMAIN_BLOCKED } from "./_lib/accountEmailDomains.js";
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { signupPosture } from "./_lib/signupPosture.js";
import { currentLegalVersions } from "../src/lib/legalInstruments.js";
import { isResidenceRegion } from "../src/lib/residenceRegions.js";
import { json, methodGuard, requireEnv, supabaseRpc } from "./_lib/http.js";
import {
  acceptanceScope, activatePasswordAuthUser, createPasswordAuthUser,
  deleteAuthUser, digest, generateMemberPassword, invitationOwnedPasswordUser,
  INVITATION_TOKEN, invitationRecipientAllowed, invitationRuntimeConfig,
  sendSignInPasswordEmail, suspendPasswordAuthUser, UUID,
} from "./_lib/memberInvitations.js";
import { usableSecret } from "./_lib/secretStrength.js";

// D-08 (owner decision, October 10, 2026): the clickwrap is the acceptance.
// Versioned clients record exactly the versions they displayed and refuse
// anything else, so a stale page cannot bind someone to text it did not
// show. Since every acceptance must
// also carry the state the person lives in and their answer to the age
// attestation that state selects (18 or older in the app-store age-law
// states, the D-03 B band elsewhere), so the token-only wire contract of
// pre-D-08 installed builds is refused like a stale pack: no account exists
// without a recorded state and attestation.
// src/lib/legalInstruments.js is the
// one version source for the page, this check and the stored row.
function acceptsVersionsInForce(value, current) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const expected = Object.keys(current);
  return keys.length === expected.length
    && expected.every((key) => value[key] === current[key]);
}

function safeParse(value) {
  if (typeof value === "object" && value !== null) return value;
  try { return JSON.parse(value); } catch { return null; }
}

function secureJson(response, status, payload) {
  response.setHeader("Referrer-Policy", "no-referrer");
  return json(response, status, payload);
}

function boundedRetryAfter(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(120, Math.max(1, Math.ceil(seconds)));
}

async function serviceRpc(config, name, body) {
  return supabaseRpc(config.supabaseUrl, config.serviceKey, config.serviceKey, name, body);
}

// D-08: one acceptance row per acceptance event, carrying the version, the
// time, the person and their organization. Written by the database from the
// invitation's own identity and chapter, never from a client-supplied subject.
// The state and the age attestation are
// checked before the invitation is claimed and recorded on the same row; the
// database decides from the state which attestation the answer was.
async function recordAcceptance(config, invitationId, versions, residenceState) {
  try {
    const recorded = await serviceRpc(config, "record_invitation_legal_acceptance", {
      p_invitation_id: invitationId,
      p_versions: versions,
      p_residence_state: residenceState,
      p_age_attested: true,
    });
    return recorded?.recorded === true;
  } catch { return false; }
}

//: a member's referral code given at acceptance credits that member.
// Best effort, after the acceptance has committed: an unknown, foreign or own
// code records nothing, and a failure never turns an accepted invitation into
// an error.
export function referralCodeFrom(value) {
  if (typeof value !== "string" || value.length > 32) return null;
  const code = value.replace(/[\s-]/g, "").toUpperCase();
  return /^[0-9A-F]{12}$/.test(code) ? code : null;
}

async function recordReferral(config, invitationId, code) {
  if (!code) return;
  try {
    await serviceRpc(config, "record_member_referral", { p_invitation_id: invitationId, p_code: code });
  } catch { /* the referral is optional; the acceptance stands */ }
}

async function markFailed(config, invitationId, code) {
  try {
    const result = await serviceRpc(config, "fail_member_invitation_accept", {
      p_invitation_id: invitationId,
      p_failure_code: code,
    });
    // Only the confirmed transition proves that the token was cleared. A
    // missing or lost reply must leave the caller on the recovery path.
    return result?.recorded === true;
  } catch { return false; }
}

// acceptance carries the versions and residence this request submitted: an
// identity that is already active is completed only after they are recorded,
// so a retry with a different state never reports an answer it did not keep.
async function recoverLease(config, invitation, acceptance) {
  let recovery;
  try {
    recovery = await serviceRpc(config, "get_member_invitation_recovery_user", {
      p_invitation_id: invitation.invitationId,
    });
  } catch {
    return { ready: false, accepted: false };
  }
  if (!recovery?.found) return { ready: true, accepted: false };
  const userId = String(recovery.userId || "");
  if (!UUID.test(userId)) return { ready: false, accepted: false };
  if (recovery.provisioning === "active") {
    if (!await recordAcceptance(config, invitation.invitationId, acceptance.versions, acceptance.residenceState)) {
      return { ready: false, accepted: false };
    }
    try {
      await serviceRpc(config, "complete_member_invitation_activation", {
        p_invitation_id: invitation.invitationId,
        p_auth_user_id: userId,
      });
      return { ready: false, accepted: true };
    } catch {
      return { ready: false, accepted: false };
    }
  }
  if (recovery.provisioning !== "pending") {
    return { ready: false, accepted: false };
  }
  // PostgreSQL returns only an exact invitation-labelled identity while the
  // invitation is still accepting. Deleting that bounded orphan makes the
  // same secret safely retryable; an unrelated account is never a candidate.
  const removed = await deleteAuthUser(
    config.supabaseUrl, config.serviceKey, userId,
  ).catch(() => false);
  return { ready: removed, accepted: false };
}

export default async function handler(request, response) {
  if (methodGuard(request, ["POST"], () => secureJson(response, 405, { error: "method-not-allowed" }))) return;

  const backend = resolveSupabaseBackend(request);
  const config = invitationRuntimeConfig(request, backend);
  if (!config) return secureJson(response, 404, { error: "not-available" });
  if (requireEnv([config.supabaseUrl, config.serviceKey, config.appOrigin,
    config.rateKey, config.resendKey, config.notifyFrom],
  () => secureJson(response, 503, { error: "not-configured" }))) return;
  if (!usableSecret(config.rateKey)) return secureJson(response, 503, { error: "not-configured" });
  if (String(request.url || "").includes("?")) return secureJson(response, 400, { error: "invalid-request" });
  if (String(request.headers?.origin || "") !== config.appOrigin) return secureJson(response, 403, { error: "not-permitted" });
  try {
    if (new URL(config.appOrigin).origin !== config.appOrigin
        || new URL(config.supabaseUrl).origin !== config.supabaseUrl) throw new Error("bad-origin");
  } catch {
    return secureJson(response, 503, { error: "not-configured" });
  }

  // An invitation-only deployment does not accept invitations while the
  // project lets anyone sign up (api/_lib/signupPosture.js).
  const posture = await signupPosture(backend);
  if (!posture.ok) return secureJson(response, 503, { error: "not-configured", reason: posture.reason });

  const scopeHash = acceptanceScope(request, config.rateKey);
  if (!scopeHash) return secureJson(response, 400, { error: "invalid-request" });
  const parsedBody = typeof request.body === "string" && request.body.length > 4096
    ? null
    : safeParse(request.body);
  const token = typeof parsedBody?.token === "string" ? parsedBody.token : "";
  const referralCode = referralCodeFrom(parsedBody?.referralCode);
  // The database consumes the network bucket before the caller learns whether
  // this digest belongs to a pending invitation. An invalid token uses the
  // original platform bucket and receives the same unavailable response.
  const tokenHash = INVITATION_TOKEN.test(token) ? digest(token) : null;

  let limit;
  try {
    limit = await serviceRpc(config, "consume_member_invitation_accept_limit_for_token", {
      p_scope_hash: scopeHash,
      p_token_hash: tokenHash,
    });
  } catch {
    return secureJson(response, 503, { error: "acceptance-unavailable" });
  }
  if (!limit?.allowed) return secureJson(response, 429, { error: "try-later" });

  if (!INVITATION_TOKEN.test(token)) return secureJson(response, 410, { error: "invitation-unavailable" });

  // The versions in force at this instant. The bucket above is already spent,
  // so a stale clickwrap learns nothing about the invitation from this answer.
  const versionsInForce = currentLegalVersions();
  // A missing, malformed or stale pack is refused before anything is claimed.
  // Pre-D-08 installed builds post only the token and get the same refusal;
  // the person accepts on the web invitation page, which carries the current
  // clickwrap, or in an updated app.
  if (!acceptsVersionsInForce(parsedBody.acceptedVersions, versionsInForce)) {
    return secureJson(response, 409, { error: "terms-version-stale", versions: versionsInForce });
  }
  // The person says which state they live
  // in and confirms the age rule for it. Without both nothing is claimed,
  // created or recorded.
  const residenceState = parsedBody.residenceState;
  if (!isResidenceRegion(residenceState)) {
    return secureJson(response, 400, { error: "residence-state-required" });
  }
  if (parsedBody.ageAttested !== true) {
    return secureJson(response, 400, { error: "age-attestation-required" });
  }
  // The new-account path creates, emails and binds an identity before it can
  // record the acceptance. A database without the state-scoped writer, or one
  // whose pinned legal pack differs from the versions this site publishes,
  // must refuse here, before any of that, not with a 502 after it.
  let ready = false;
  try {
    ready = await serviceRpc(config, "legal_acceptance_pack_ready", { p_versions: versionsInForce }) === true;
  } catch { /* not ready */ }
  if (!ready) return secureJson(response, 503, { error: "acceptance-unavailable" });

  let invitation;
  try {
    invitation = await serviceRpc(config, "claim_member_invitation", { p_token_hash: tokenHash });
  } catch {
    return secureJson(response, 502, { error: "acceptance-unavailable" });
  }
  // An exhausted claim carries no recipient. In proof mode it cannot authorize
  // orphan deletion, reactivation or mail: return to the scoped operator.
  if (config.sampleProof && invitation?.cause === "acceptance-exhausted") {
    return secureJson(response, 410, { error: "invitation-unavailable" });
  }
  if (!invitation?.available && invitation?.cause === "acceptance-exhausted"
      && UUID.test(String(invitation.invitationId || ""))) {
    // The last attempt's lease lapsed without an outcome. Remove only the
    // exact invitation-labelled pending identity (or finish an active one),
    // then record the failure so the row is resendable instead of stuck.
    const recovered = await recoverLease(config, invitation, { versions: versionsInForce, residenceState });
    if (recovered.accepted) {
      await recordReferral(config, invitation.invitationId, referralCode);
      return secureJson(response, 200, { accepted: true });
    }
    if (recovered.ready && await markFailed(config, invitation.invitationId, "auth_unavailable")) {
      return secureJson(response, 410, { error: "invitation-unavailable" });
    }
    return secureJson(response, 502, { error: "acceptance-unavailable" });
  }
  if (!invitation?.available) {
    const retryAfter = invitation?.cause === "acceptance-in-progress"
      ? boundedRetryAfter(invitation.retryAfterSeconds)
      : null;
    if (retryAfter) {
      response.setHeader("Retry-After", String(retryAfter));
      return secureJson(response, 409, {
        error: "acceptance-in-progress",
        retryAfterSeconds: retryAfter,
      });
    }
    return secureJson(response, 410, { error: "invitation-unavailable" });
  }

  if (!invitationRecipientAllowed(config, invitation.normalizedEmail)) {
    return secureJson(response, 410, { error: "invitation-unavailable" });
  }

  if (invitation.kind === "reactivation") {
    // D-08: the acceptance is recorded BEFORE the reactivation, because the
    // reactivation itself binds the identity and clears the token digest, so
    // an acceptance taken after it could not be retried. A failure here keeps
    // the accepting lease, so the same link records and reactivates later.
    if (!await recordAcceptance(config, invitation.invitationId, versionsInForce, residenceState)) {
      return secureJson(response, 502, { error: "acceptance-unavailable" });
    }
    // A former member who still has an account: no identity is created, no
    // password is emailed. The service RPC re-checks eligibility under the
    // membership locks and re-activates the organization membership. On any
    // failure the accepting lease stays, so the same link recovers after it
    // lapses and never leaks which conjunct failed.
    let reactivated = null;
    try {
      reactivated = await serviceRpc(config, "accept_former_member_invitation", {
        p_invitation_id: invitation.invitationId,
      });
    } catch { /* decided by the outcome read below */ }
    // A rejoin records no referral on either success return (, pinned by
    //): the person was already a member, and their earlier check-ins
    // would activate a referral at once.
    if (reactivated?.accepted === true && reactivated?.reactivated === true) {
      return secureJson(response, 200, { accepted: true, reactivated: true });
    }
    // The RPC may have committed before its reply was lost, timed out or
    // arrived malformed. Acceptance clears the token digest for every kind, so
    // a later retry with the same link can never find the row again; ask now
    // whether the reactivation already happened and report it as the success
    // it was. A refusal (the RPC raised) reads as not accepted and keeps the
    // accepting lease, so the same link recovers after it lapses.
    const outcome = await serviceRpc(config, "get_former_member_invitation_outcome", {
      p_invitation_id: invitation.invitationId,
    }).catch(() => null);
    if (outcome?.accepted === true) {
      return secureJson(response, 200, { accepted: true, reactivated: true });
    }
    return secureJson(response, 502, { error: "acceptance-unavailable" });
  }

  if (invitation.recovery) {
    const recovered = await recoverLease(config, invitation, { versions: versionsInForce, residenceState });
    if (recovered.accepted) {
      await recordReferral(config, invitation.invitationId, referralCode);
      return secureJson(response, 200, { accepted: true });
    }
    if (!recovered.ready) {
      return secureJson(response, 502, { error: "acceptance-unavailable" });
    }
  }

  // A new account is never created on a government or employer address
  // (an invitation sent before its domain was blocked). The invitation ends
  // as failed, so an administrator can invite the person's personal address.
  if (accountEmailDomainBlocked(invitation.normalizedEmail)) {
    await markFailed(config, invitation.invitationId, "auth_unavailable");
    return secureJson(response, 400, { error: EMAIL_DOMAIN_BLOCKED });
  }

  const password = generateMemberPassword();
  let generated;
  try {
    generated = await createPasswordAuthUser(
      config.supabaseUrl, config.serviceKey, invitation, password,
    );
  } catch {
    // The request may have created a user before its response was lost. Leave
    // the digest on the accepting lease so the same link can recover safely.
    return secureJson(response, 502, { error: "acceptance-unavailable" });
  }
  const generatedUserId = generated?.user?.id ?? generated?.id;
  if (!generated || !invitationOwnedPasswordUser(generated, invitation)) {
    const failed = await markFailed(config, invitation.invitationId,
      generatedUserId ? "unsafe_auth_state" : "auth_unavailable");
    if (failed) return secureJson(response, 410, { error: "invitation-unavailable" });
    return secureJson(response, 502, { error: "acceptance-unavailable" });
  }

  let delivered = false;
  try {
    delivered = await sendSignInPasswordEmail({
      resendKey: config.resendKey,
      from: config.notifyFrom,
      to: invitation.normalizedEmail,
      locale: invitation.locale,
      password,
      appOrigin: config.appOrigin,
      invitationId: invitation.invitationId,
    });
  } catch { /* handled by the recoverable branch below */ }
  if (!delivered) {
    const removed = await deleteAuthUser(
      config.supabaseUrl, config.serviceKey, generatedUserId,
    ).catch(() => false);
    if (removed && await markFailed(config, invitation.invitationId, "provider_unavailable")) {
      return secureJson(response, 410, { error: "invitation-unavailable" });
    }
    return secureJson(response, 502, { error: "acceptance-unavailable" });
  }

  // D-08: the identity is bound to the invitation first, then the acceptance,
  // the state and the age attestation are recorded, and only then is the invitation
  // marked accepted. A failure in between leaves the accepting lease, which
  // recovers the same identity and records again.
  try {
    await serviceRpc(config, "finalize_member_invitation", {
      p_invitation_id: invitation.invitationId,
      p_auth_user_id: generatedUserId,
    });
  } catch {
    // The identity stays banned. Leaving the accepting lease intact lets the
    // same secret recover the exact invitation-owned user and issue a new
    // password after the short lease expires.
    return secureJson(response, 502, { error: "acceptance-unavailable" });
  }

  if (!await recordAcceptance(config, invitation.invitationId, versionsInForce, residenceState)) {
    return secureJson(response, 502, { error: "acceptance-unavailable" });
  }

  const activated = await activatePasswordAuthUser(
    config.supabaseUrl, config.serviceKey, generatedUserId,
  ).catch(() => false);
  if (!activated) return secureJson(response, 502, { error: "acceptance-unavailable" });

  try {
    await serviceRpc(config, "complete_member_invitation_activation", {
      p_invitation_id: invitation.invitationId,
      p_auth_user_id: generatedUserId,
    });
  } catch {
    // Prefer returning the exact identity to the recoverable pending state. If
    // this Auth request also fails, the next lease recovery sees the active
    // invitation-labelled user and completes the database transition instead
    // of deleting a usable account.
    await suspendPasswordAuthUser(
      config.supabaseUrl, config.serviceKey, generatedUserId,
    ).catch(() => false);
    return secureJson(response, 502, { error: "acceptance-unavailable" });
  }

  await recordReferral(config, invitation.invitationId, referralCode);
  return secureJson(response, 200, { accepted: true });
}
