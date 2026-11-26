// Six-digit authenticator (TOTP) codes, as typed or pasted into the two-factor
// check, two-step setup and the password reset (#7052). Anything that is not
// an ASCII digit is dropped as it arrives, so a pasted "123 456" becomes
// "123456" and a seventh digit never lands. Recovery codes are a different
// shape and keep their own fields.
export const AUTHENTICATOR_CODE_LENGTH = 6;
// A saved recovery code's length, as RECOVERY_CODE_PATTERN (passwordReset.js) accepts it (#9458).
export const RECOVERY_CODE_MIN = 18;
export const RECOVERY_CODE_MAX = 32;

export function cleanAuthenticatorCode(value) {
  return String(value ?? "").replace(/[^0-9]/g, "").slice(0, AUTHENTICATOR_CODE_LENGTH);
}

export function isAuthenticatorCode(value) {
  return typeof value === "string" && /^[0-9]{6}$/.test(value);
}
