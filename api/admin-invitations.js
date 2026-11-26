import { waitUntil } from "@vercel/functions";
import { accountEmailDomainBlocked, EMAIL_DOMAIN_BLOCKED } from "./_lib/accountEmailDomains.js";
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { signupPosture } from "./_lib/signupPosture.js";
import { authenticateCaller, bearerToken, json, methodGuard, requireEnv, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";
import { captureServerFailure } from "./_lib/observability.js";
import { withReportedFallback } from "./_lib/reportedFallback.js";
import { deskInvitationNames, digest, invitationRecipientAllowed, invitationRuntimeConfig, invitationSecret, invitationUrl, sendInvitationEmail, UUID } from "./_lib/memberInvitations.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CHAPTER = /^[a-z0-9][a-z0-9-]{1,63}$/;
// "vp" is President:
// (REQ-UG-OFFICER-ROLES-VP-TREASURER-SECRETARY-20261006). The RPC still
// lets only an administrator of the target chapter choose any starting access.
// "organizer" is the Organizer hat (public edition).
const ROLES = new Set([null, "steward", "organizer", "coordinator", "advisor", "vp"]);
// Roster import has its own
// server limits; a refusal names one of these settings and when it opens again.
const ROSTER_LIMITS = new Set([
  "limits.security.invitation_roster_admin_hourly",
  "limits.security.invitation_roster_chapter_daily",
  "limits.security.invitation_roster_lookup_hourly",
  // A worker's own sending limits, and the campaign's daily limit they share.
  "limits.security.invitation_member_daily",
  "limits.security.invitation_member_monthly",
  "limits.security.invitation_chapter_daily",
]);

function safeParse(value) {
  if (typeof value === "object" && value !== null) return value;
  try { return JSON.parse(value); } catch { return null; }
}

function createFields(body) {
  if (Object.hasOwn(body || {}, "legacyChapterCoverage") || Object.hasOwn(body || {}, "legacy_chapter_coverage")) return null;
  const email = String(body?.email || "").trim().toLowerCase();
  const fullName = String(body?.fullName || "").trim();
  const chapterId = String(body?.chapterId || "").trim();
  const roleValue = String(body?.initialRole || "").trim().toLowerCase();
  const initialRole = roleValue && roleValue !== "member" ? roleValue : null;
  const locale = String(body?.locale || "").trim().toLowerCase();
  // A former member keeps the profile they already have: the request names no
  // display name and can grant no starting access (the RPC refuses both).
  const formerMember = body?.formerMember === true;
  const hasControl = [...fullName].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!EMAIL.test(email) || email.length > 254 || !CHAPTER.test(chapterId)
      || !["en", "es"].includes(locale)) return null;
  // A roster row is a plain-member invitation from the CSV import: no former
  // member, no starting access.
  const roster = body?.source === "roster";
  if (formerMember) {
    if (roster || initialRole !== null || fullName.length > 120 || hasControl) return null;
    return { email, fullName: "", chapterId, initialRole: null, locale, formerMember: true, roster: false };
  }
  if (fullName.length < 2 || fullName.length > 120 || hasControl || !ROLES.has(initialRole)) return null;
  if (roster && initialRole !== null) return null;
  // REQ-UG-INVITATION-SUGGESTIONS-AND-ACCESS-REQUESTS-20261030: an
  // approved member suggestion names its request; the invitation is created
  // with the approval, from the request's own address and name.
  if (body?.requestId !== undefined) {
    const requestId = String(body.requestId || "").toLowerCase();
    if (!UUID.test(requestId) || roster || initialRole !== null) return null;
    return { email, fullName, chapterId, initialRole: null, locale, formerMember: false, roster: false, requestId };
  }
  // REQ-UG-CHAPTER-UNITS-WORKSITES-AND-LOCAL-PROFILE-20261030: an
  // ordinary invitation may name a unit of its chapter.
  const unitValue = body?.unitId == null || body.unitId === "" ? null : String(body.unitId).toLowerCase();
  if (unitValue !== null && (roster || !UUID.test(unitValue))) return null;
  if (initialRole === "steward" && unitValue === null) return null;
  return { email, fullName, chapterId, initialRole, locale, formerMember: false, roster, unitId: unitValue };
}

//: a member invites someone into their own home chapter. The server
// picks the chapter and grants no starting access, so neither is sent.
function memberSendFields(body) {
  const email = String(body?.email || "").trim().toLowerCase();
  const fullName = String(body?.fullName || "").trim();
  const locale = String(body?.locale || "").trim().toLowerCase();
  const hasControl = [...fullName].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  // The first word becomes the stored first name, which the table holds to 80
  // characters; refusing it here gives every address the same answer (Sol
  // final, r3s1; the database checks it again before any address branch).
  const firstName = fullName.split(/\s+/u)[0] || "";
  if (!EMAIL.test(email) || email.length > 254 || fullName.length < 2 || fullName.length > 120 || hasControl
      || [...firstName].length > 80 || !["en", "es"].includes(locale)) return null;
  return { email, fullName, locale, memberSent: true };
}

// A roster limit refusal: which setting and when it opens again.
function rosterLimitFields(parsed) {
  const retryAt = Date.parse(parsed?.retryAt ?? "");
  if (!ROSTER_LIMITS.has(parsed?.limit) || !Number.isFinite(retryAt)) return null;
  return { limit: parsed.limit, retryAt: new Date(retryAt).toISOString() };
}

// The lookup throttle refuses by raising (nothing to keep).
function rosterLimit(error) {
  if (error?.code !== "P0001" || typeof error?.details !== "string") return null;
  let parsed;
  try { parsed = JSON.parse(error.details); } catch { return null; }
  return rosterLimitFields(parsed);
}

function mapRpcFailure(error, response) {
  const status = Number(error?.status || 0);
  const limited = rosterLimit(error);
  if (limited) json(response, 429, { error: "rate-limited", ...limited });
  else if (status === 401 || status === 403) json(response, 403, { error: "not-permitted" });
  else if (status === 400 || status === 422) json(response, 400, { error: "request-unavailable" });
  else json(response, 503, { error: "service-unavailable" });
}

async function recordDelivery(config, token, result, outcome, memberId = null) {
  const fields = { p_invitation_id: result.invitationId, p_delivery_version: result.deliveryVersion, p_outcome: outcome };
  //: a member's own invitation is recorded by the server for the member
  // it verified; the member cannot call that function.
  return memberId
    ? supabaseRpc(config.supabaseUrl, config.serviceKey, config.serviceKey,
      "record_member_sent_invitation_delivery", { p_actor: memberId, ...fields })
    : supabaseRpc(config.supabaseUrl, config.publishableKey, token, "record_member_invitation_delivery", fields);
}

//: the member behind this bearer, verified twice: the Auth gateway names
// the user, and the member's own session passes the step-up check
// (public.member_sent_invitation_session) and names the same user. Only then
// does the server create the invitation, under the service role, with the
// secret it made, so the member never chooses the link's secret.
async function verifiedMember(config, token) {
  const caller = await authenticateCaller(config.supabaseUrl, config.publishableKey, token);
  if (caller.outcome === "unavailable") return { error: "service-unavailable", status: 503 };
  const id = String(caller.user?.id || "").toLowerCase();
  if (caller.outcome !== "resolved" || !UUID.test(id)) return { error: "not-permitted", status: 403 };
  let session;
  try {
    session = await supabaseRpc(config.supabaseUrl, config.publishableKey, token, "member_sent_invitation_session");
  } catch (error) {
    const status = Number(error?.status || 0);
    return status === 401 || status === 403 ? { error: "not-permitted", status: 403 } : { error: "service-unavailable", status: 503 };
  }
  return String(session || "").toLowerCase() === id ? { id } : { error: "not-permitted", status: 403 };
}

async function deliver(config, token, result, recipient) {
  if (!result?.send) return { accepted: true };
  if (!invitationRecipientAllowed(config, recipient.email)) return { error: "not-permitted", status: 403 };
  const link = invitationUrl(config.appOrigin, recipient.secret);
  let sent;
  try {
    const names = await deskInvitationNames(config.supabaseUrl, config.publishableKey, token);
    sent = await sendInvitationEmail({
      resendKey: config.resendKey,
      from: config.from,
      to: recipient.email,
      locale: recipient.locale,
      link,
      appOrigin: config.appOrigin,
      invitationId: result.invitationId,
      deliveryVersion: result.deliveryVersion,
      names: result.source === "roster" ? { ...names, rosterLink: true }
        : recipient.memberSent ? { ...names, source: "member" } : names,
    });
  } catch {
    sent = false;
  }
  try {
    await recordDelivery(config, token, result, sent ? "sent" : "failed", recipient.memberId ?? null);
  } catch {
    return { error: "delivery-status-unavailable", status: 503 };
  }
  return sent
    ? { accepted: true }
    : { error: "delivery-unavailable", status: 502 };
}

// waitUntil keeps the function alive after the response on Vercel; anywhere
// else the promise simply runs detached. The member already has their answer,
// so a failure stays inside it, but it is still reported as on Main, where it
// was the answer's status: a failed send or a failed save of its outcome sends
// that status (502 or 503), and anything thrown sends 500. Only the status
// leaves the function, never the address or the member (captureServerFailure).
function deliverAfterAnswer(config, token, result, recipient) {
  const pending = withReportedFallback(async () => {
    const outcome = await deliver(config, token, result, recipient);
    if (outcome.error) captureServerFailure(outcome.status);
    return outcome;
  }, null);
  try { waitUntil(pending); } catch { /* swallow-ok: outside the Vercel runtime the promise runs detached */ }
  return pending;
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["POST"], () => json(response, 405, { error: "method-not-allowed" }))) return;
  const token = bearerToken(request);
  if (!token) return json(response, 401, { error: "unauthenticated" });

  const backend = resolveSupabaseBackend(request);
  const config = invitationRuntimeConfig(request, backend);
  if (!config) return json(response, 404, { error: "not-available" });
  const body = safeParse(request.body);
  const action = String(body?.action || "");
  if (requireEnv([config.supabaseUrl, config.publishableKey],
    () => json(response, 503, { error: "not-configured" }))) return;
  if (action === "revoke") {
    const invitationId = String(body?.invitationId || "");
    if (!UUID.test(invitationId)) return json(response, 400, { error: "invalid-request" });
    try {
      await supabaseRpc(config.supabaseUrl, config.publishableKey, token,
        "revoke_member_invitation", { p_invitation_id: invitationId });
      // The response deliberately does not reveal whether the opaque id was a
      // live same-chapter invitation. The authorized list is the truth after
      // refresh; this mutation endpoint is not an id oracle.
      return json(response, 200, { accepted: true });
    } catch (error) {
      return mapRpcFailure(error, response);
    }
  }

  if (requireEnv([config.resendKey, config.from, config.appOrigin],
    () => json(response, 503, { error: "not-configured" }))) return;
  // Invitations mean nothing while the project lets anyone sign up
  // (api/_lib/signupPosture.js): refuse to send one until that is fixed.
  const posture = await signupPosture(backend);
  if (!posture.ok) return json(response, 503, { error: "not-configured", reason: posture.reason });
  try {
    if (new URL(config.appOrigin).origin !== config.appOrigin) throw new Error("bad-origin");
  } catch {
    return json(response, 503, { error: "not-configured" });
  }

  const secret = invitationSecret();
  const tokenHash = digest(secret);
  let result;
  let recipient;
  try {
    if (action === "create") {
      const fields = createFields(body);
      if (!fields) return json(response, 400, { error: "invalid-request" });
      // A former member's invitation reactivates the account they already
      // have; it creates no account and changes no address.
      if (!fields.formerMember && accountEmailDomainBlocked(fields.email)) {
        return json(response, 400, { error: EMAIL_DOMAIN_BLOCKED });
      }
      if (!invitationRecipientAllowed(config, fields.email)) return json(response, 403, { error: "not-permitted" });
      recipient = { ...fields, secret };
      result = fields.requestId
        // A member's suggestion: approved and invited in one transaction, so
        // a request someone already decided creates no invitation.
        ? await supabaseRpc(config.supabaseUrl, config.publishableKey, token,
          "approve_member_request_invitation", {
            p_request_id: fields.requestId,
            p_email: fields.email,
            p_locale: fields.locale,
            p_token_hash: tokenHash,
          })
        : fields.formerMember
        // Organization-admin re-invitation of a former member: the RPC checks
        // the second factor, the organization admin role and the revoked-here
        // / active-nowhere eligibility, and answers the uniform accepted shape.
        ? await supabaseRpc(config.supabaseUrl, config.publishableKey, token,
          "create_former_member_invitation", {
            p_email: fields.email,
            p_chapter_id: fields.chapterId,
            p_locale: fields.locale,
            p_token_hash: tokenHash,
          })
        : fields.roster
          ? await supabaseRpc(config.supabaseUrl, config.publishableKey, token,
            "create_roster_member_invitation", {
              p_email: fields.email,
              p_full_name: fields.fullName,
              p_chapter_id: fields.chapterId,
              p_locale: fields.locale,
              p_token_hash: tokenHash,
            })
          : await supabaseRpc(config.supabaseUrl, config.publishableKey, token,
            "create_member_invitation", {
              p_email: fields.email,
              p_full_name: fields.fullName,
              p_chapter_id: fields.chapterId,
              p_initial_role: fields.initialRole,
              p_locale: fields.locale,
              p_token_hash: tokenHash,
              p_unit_id: fields.unitId,
            });
    } else if (action === "member-send") {
      //: no administrator. create_member_sent_invitation decides whether
      // this member may send (the organization switch, an active membership,
      // a home chapter, a 7-day-old account) and charges the member limits.
      const fields = memberSendFields(body);
      if (!fields) return json(response, 400, { error: "invalid-request" });
      if (accountEmailDomainBlocked(fields.email)) return json(response, 400, { error: EMAIL_DOMAIN_BLOCKED });
      if (!invitationRecipientAllowed(config, fields.email)) return json(response, 403, { error: "not-permitted" });
      if (requireEnv([config.serviceKey], () => json(response, 503, { error: "not-configured" }))) return;
      const member = await verifiedMember(config, token);
      if (member.error) return json(response, member.status, { error: member.error });
      recipient = { ...fields, secret, memberId: member.id };
      result = await supabaseRpc(config.supabaseUrl, config.serviceKey, config.serviceKey,
        "create_member_sent_invitation", {
          p_actor: member.id,
          p_email: fields.email,
          p_full_name: fields.fullName,
          p_locale: fields.locale,
          p_token_hash: tokenHash,
        });
    } else if (action === "resend") {
      let invitationId = String(body?.invitationId || "");
      if (!UUID.test(invitationId)) return json(response, 400, { error: "invalid-request" });
      invitationId = invitationId.toLowerCase();
      if (config.sampleProof) {
        // Read through the caller's existing organization/chapter authorization
        // before the resend RPC can supersede a row. Its recipient is immutable;
        // never authorize rotation from an address supplied in the request.
        const listing = await supabaseRpc(config.supabaseUrl, config.publishableKey, token,
          "get_member_invitations", { p_limit: 100 });
        const matches = Array.isArray(listing?.items)
          ? listing.items.filter((item) => item.id === invitationId) : [];
        if (matches.length !== 1 || !invitationRecipientAllowed(config, matches[0].normalizedEmail)) {
          return json(response, 403, { error: "not-permitted" });
        }
      }
      result = await supabaseRpc(config.supabaseUrl, config.publishableKey, token,
        "resend_member_invitation", { p_invitation_id: invitationId, p_token_hash: tokenHash });
      recipient = {
        email: String(result?.normalizedEmail || ""),
        fullName: String(result?.fullName || ""),
        locale: result?.locale === "es" ? "es" : "en",
        secret,
      };
      if (result?.send && !EMAIL.test(recipient.email)) throw Object.assign(new Error("bad-rpc-shape"), { status: 502 });
    } else {
      return json(response, 400, { error: "invalid-request" });
    }
  } catch (error) {
    return mapRpcFailure(error, response);
  }

  // A sending-limit refusal comes back as a result, so the roster lookup
  // charge it follows stays committed (no free probing past the allowance).
  if (result?.rateLimited === true) {
    const limited = rosterLimitFields(result);
    return limited ? json(response, 429, { error: "rate-limited", ...limited })
      : json(response, 503, { error: "service-unavailable" });
  }
  // Any failure after the roster lookup charge comes back as a result too, so
  // that charge commits for every address; nothing is sent.
  if (result?.unavailable === true) return json(response, 503, { error: "service-unavailable" });

  if (action === "member-send") {
    // SEC-UG-MEMBER-SENT-INVITATION-REVEALS-WHETHER-AN-ADDRESS-HAS-AN-ACCOUNT-20261115
    //: a member's invitation is mailed after the answer, so a new
    // address and one that already has an account (or a live invitation) get
    // the same 202, in the same time, and a failed send is never a different
    // status for the member. The outcome is still recorded on the invitation
    // (sent, or delivery failed), where its administrators see it in the list.
    json(response, 202, { accepted: true });
    deliverAfterAnswer(config, token, result, recipient);
    return;
  }
  // An administrator's send still waits for the email and answers its
  // failure: the invitation list they are allowed to read already shows
  // whether an invitation was created for the address, so the answer reveals
  // nothing more, and the desk needs the failure at once to offer a retry.
  const outcome = await deliver(config, token, result, recipient);
  if (outcome.error) return json(response, outcome.status, { error: outcome.error });
  return json(response, 202, outcome);
}
