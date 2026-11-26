const SAFE_CODES = new Set([
  "invalid-request", "not-configured", "not-permitted", "recovery-incomplete",
  "recovery-unavailable", "reissue-incomplete", "reissue-unavailable", "service-unavailable",
  "session-expired", "email-domain-blocked",
]);

export class AdminSigninRecoveryError extends Error {
  constructor(code) {
    super(code);
    this.name = "AdminSigninRecoveryError";
    this.code = code;
  }
}

export async function recoverMemberSigninAddress(session, fields) {
  if (!session?.access_token) throw new AdminSigninRecoveryError("session-expired");
  const response = await fetch("/api/admin-signin-recovery", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    cache: "no-store",
    body: JSON.stringify({
      userId: fields.userId,
      newEmail: fields.newEmail,
      reason: fields.reason,
      identityVerified: fields.identityVerified === true,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.completed !== true) {
    const code = SAFE_CODES.has(payload?.error) ? payload.error : "service-unavailable";
    throw new AdminSigninRecoveryError(code);
  }
  return { completed: true };
}

export async function reissueMemberPassword(session, fields) {
  if (!session?.access_token) throw new AdminSigninRecoveryError("session-expired");
  const response = await fetch("/api/admin-password-reissue", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    cache: "no-store",
    body: JSON.stringify({
      userId: fields.userId,
      identityVerified: fields.identityVerified === true,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.completed !== true) {
    const code = SAFE_CODES.has(payload?.error) ? payload.error : "service-unavailable";
    throw new AdminSigninRecoveryError(code);
  }
  return { completed: true };
}
