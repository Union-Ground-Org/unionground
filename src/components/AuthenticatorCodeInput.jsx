import { cleanAuthenticatorCode } from "../lib/authenticatorCode.js";

// The one six-digit authenticator code input (#7052). The caller owns the
// value so it can keep its submit off until six digits are present, and its
// form is noValidate so the member reads the hint named by hintId, never the
// browser's "Please match the requested format". No maxLength: a
// six-character limit would cut a pasted "123 456" to "123 45" before the
// change handler could drop the space; cleanAuthenticatorCode caps at six.
export function AuthenticatorCodeInput({ value, onChange, hintId, className, autoFocus = false }) {
  return (
    <input
      className={className}
      type="text"
      dir="ltr"
      spellCheck={false}
      name="code"
      inputMode="numeric"
      autoComplete="one-time-code"
      required
      autoFocus={autoFocus}
      aria-describedby={hintId}
      value={value}
      onChange={(event) => onChange(cleanAuthenticatorCode(event.target.value))}
    />
  );
}
