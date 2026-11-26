import { useLang } from "../lib/LanguageContext.jsx";

// BUG-UG-NEW-PASSWORD-TOO-SHORT-GIVES-NO-REASON-20261122 (#9448): why a
// new-password page keeps its save unavailable, shown beside the field and named
// by that field's aria-describedby. Not an alert: an alert would be read out
// again on every keystroke while the count changes.
const KEYS = Object.freeze({ short: "auth.newPasswordTooShort", long: "auth.newPasswordTooLong" });

export function NewPasswordLengthMessage({ id, issue, length }) {
  const { t } = useLang();
  if (!KEYS[issue]) return null;
  return <p className="auth-message auth-message--error" id={id}>{t(KEYS[issue], { count: length })}</p>;
}
