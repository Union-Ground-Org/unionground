// Admin-assisted MFA reset, called from the admin plane.
//
// This is the way back in for a member who enrolled TOTP and then lost the
// device: GoTrue will not let an aal1 session unenrol a verified factor, and a
// password-recovery session is aal1 too, so without this the member is locked
// out of their own organizing workspace for good.
//
// Authorization is not decided here. The endpoint re-checks it in Postgres as
// the CALLER and establishes the target's durable reset boundary before factor
// deletion (begin_mfa_reset), so nothing a tampered client sends can widen what
// an admin is allowed to do or keep a pre-reset JWT usable.
export async function resetMemberMfa(session, userId) {
  if (!session?.access_token) throw Object.assign(new Error("unauthenticated"), { code: "unauthenticated" });

  const response = await fetch("/api/admin-mfa-reset", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ userId }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(payload.error || "reset-failed"), {
      code: payload.error || "reset-failed",
      removed: Number(payload.removed) || 0,
      total: Number(payload.total) || 0,
    });
  }

  return {
    removed: Number(payload.removed) || 0,
    audited: payload.audited !== false,
    // The member's out-of-band notice is best-effort server-side; the admin
    // is told when it did not land so they can reach the member themselves.
    notified: payload.notified === true,
  };
}
