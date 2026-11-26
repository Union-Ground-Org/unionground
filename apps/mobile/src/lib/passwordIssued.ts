// The emailed-password stamp (user_metadata.union_ground_password_issued_at):
// set when the sign-in password is emailed, deleted by the member's own
// password change. A prompt only; nothing authorizes on it.
export function passwordIssuedAt(metadata: unknown): string | null {
  const value = (metadata as { union_ground_password_issued_at?: unknown } | null | undefined)?.union_ground_password_issued_at;
  return typeof value === 'string' && value ? value : null;
}
