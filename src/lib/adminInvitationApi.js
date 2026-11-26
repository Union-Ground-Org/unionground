const ENDPOINT = "/api/admin-invitations";
const KNOWN_ERRORS = new Set([
  "invalid-request", "not-configured", "not-permitted", "request-unavailable",
  "service-unavailable", "delivery-unavailable", "delivery-status-unavailable", "rate-limited",
  "email-domain-blocked",
]);

export class AdminInvitationError extends Error {
  constructor(code, status = 0, { limit = null, retryAt = null } = {}) {
    super(code);
    this.name = "AdminInvitationError";
    this.code = code;
    this.status = status;
    // A roster-import refusal names the server limit reached and when it opens again.
    this.limit = limit;
    this.retryAt = retryAt;
  }
}

// BUG-UG-ADMIN-INVITATIONS-503-THEN-202-20261003. A busy service, a
// failed send or a dropped connection is worth one more press, and the server
// keeps that press safe: a create for an address that already has a pending
// invitation answers accepted and sends nothing. delivery-status-unavailable
// is different: the email may already be out and a resend would replace its
// link, so it says the send could not be confirmed instead. Everything else
// keeps the generic sentence.
const RETRYABLE_ERRORS = new Set(["service-unavailable", "delivery-unavailable"]);

export function invitationErrorKey(error) {
  if (error instanceof AdminInvitationError && error.code === "delivery-status-unavailable") return "admin.invitationUnconfirmed";
  // A government or employer address can never be an account address.
  if (error instanceof AdminInvitationError && error.code === "email-domain-blocked") return "admin.emailDomainBlocked";
  const retryable = error instanceof TypeError
    || (error instanceof AdminInvitationError && RETRYABLE_ERRORS.has(error.code));
  return retryable ? "admin.invitationRetry" : "admin.invitationError";
}

// BUG-UG-ACCEPTED-INVITATIONS-SHOW-EXPIRY-20261102. The status an
// invitation row shows: a pending link whose expiry has passed since the list
// was read is expired, never pending.
export function invitationDisplayStatus(invitation, nowMs = Date.now()) {
  const expiresMs = Date.parse(invitation?.expiresAt ?? "");
  return invitation?.status === "pending" && Number.isFinite(expiresMs) && expiresMs <= nowMs ? "expired" : invitation?.status;
}

// The row's status with the one time that belongs to it: the expiry only while
// pending, when it was accepted or revoked otherwise. A time the list did not
// return is left out rather than replaced by another.
export function invitationStatusLine(invitation, t, nowMs = Date.now()) {
  const status = invitationDisplayStatus(invitation, nowMs);
  if (status === "pending" && invitation.expiresLabel) return `${t("admin.invitationStatus.pending")} · ${t("admin.invitationExpires", { date: invitation.expiresLabel })}`;
  if (status === "accepted" && invitation.acceptedLabel) return t("admin.invitationAcceptedOn", { date: invitation.acceptedLabel });
  if (status === "revoked" && invitation.revokedLabel) return t("admin.invitationRevokedOn", { date: invitation.revokedLabel });
  return t(`admin.invitationStatus.${status}`);
}

async function mutate(session, body) {
  if (!session?.access_token) throw new AdminInvitationError("session-expired", 401);
  const response = await fetch(ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = KNOWN_ERRORS.has(payload?.error) ? payload.error : "service-unavailable";
    const limited = code === "rate-limited" && typeof payload?.limit === "string"
      && Number.isFinite(Date.parse(payload?.retryAt ?? ""))
      ? { limit: payload.limit, retryAt: payload.retryAt } : {};
    throw new AdminInvitationError(code, response.status, limited);
  }
  return { accepted: payload?.accepted === true };
}

export function inviteMember(session, fields) {
  // #8171: a member invites someone into their own home chapter. The server
  // picks the chapter and grants no starting access, so neither is sent.
  if (fields?.memberSent === true) {
    return mutate(session, {
      action: "member-send",
      email: String(fields?.email || ""),
      fullName: String(fields?.fullName || ""),
      locale: fields?.locale === "es" ? "es" : "en",
    });
  }
  return mutate(session, {
    action: "create",
    email: String(fields?.email || ""),
    fullName: String(fields?.fullName || ""),
    chapterId: String(fields?.chapterId || ""),
    initialRole: fields?.formerMember === true ? null : (fields?.initialRole || null),
    locale: fields?.locale === "es" ? "es" : "en",
    // Ordinary invitations keep the exact body the server always accepted;
    // the flag travels only when the desk asked for a former member.
    ...(fields?.formerMember === true ? { formerMember: true } : {}),
    // CSV roster rows use the roster-import limits and 7-day links.
    ...(fields?.source === "roster" && fields?.formerMember !== true ? { source: "roster" } : {}),
    // A member's suggestion being approved: the server approves it and
    // creates the invitation together (#6634).
    ...(typeof fields?.requestId === "string" && fields.requestId ? { requestId: fields.requestId } : {}),
    // REQ-UG-CHAPTER-UNITS-WORKSITES-AND-LOCAL-PROFILE-20261030: a
    // unit of the chosen chapter, only on an ordinary invitation.
    ...(fields?.unitId && fields?.formerMember !== true && fields?.source !== "roster" ? { unitId: String(fields.unitId) } : {}),
  });
}

// REQ-UG-MEMBER-SENT-INVITATIONS-20261111 (#8171): whether this
// member's organization lets members send invitations themselves.
export const MEMBER_INVITATIONS_SWITCH = "features.member_invitations.enabled";
export function memberSentInvitationsEnabled(data) {
  return data?.organizationConfiguration?.switches?.[MEMBER_INVITATIONS_SWITCH] === true;
}

export function resendMemberInvitation(session, invitationId) {
  return mutate(session, { action: "resend", invitationId: String(invitationId || "") });
}

export function revokeMemberInvitation(session, invitationId) {
  return mutate(session, { action: "revoke", invitationId: String(invitationId || "") });
}
