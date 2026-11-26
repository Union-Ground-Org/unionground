// Six-digit authenticator (TOTP) codes, as typed or pasted into the two-factor
// check and the emailed password reset (#7052, the web's
// src/lib/authenticatorCode.js). Anything that is not an ASCII digit is dropped
// as it arrives and the slice below is what stops a seventh digit. The fields
// carry no maxLength on purpose: React Native cuts pasted text to maxLength
// before onChangeText runs, so maxLength={6} would turn a pasted "123 456"
// into "123 45". Recovery codes are a different shape
// (mfaRecovery.ts).
export const AUTHENTICATOR_CODE_LENGTH = 6;

export function cleanAuthenticatorCode(value: string): string {
  return value.replace(/[^0-9]/g, '').slice(0, AUTHENTICATOR_CODE_LENGTH);
}

export function isAuthenticatorCode(value: string): boolean {
  return /^[0-9]{6}$/.test(value);
}
