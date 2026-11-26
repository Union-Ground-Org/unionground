import { useLang } from "../lib/LanguageContext.jsx";
import { publicContact } from "../lib/publicContact.js";

// BUG-UG-LOCKED-OUT-REMEDIES-SCANNABILITY-20261020: the locked-out
// help shown under the sign-in card and the reset screens. Three losses, each
// with its own remedy, as a short list a person can scan on a phone, then the
// canonical support address for anyone with no administrator to ask. The same
// words as before, one case per line instead of one six-line paragraph.
const CASES = Object.freeze(["password", "authenticator", "inbox"]);

// `recoveryCodes`: the sign-in screen and the reset link's challenge step can
// tell a member to use a saved recovery code; the other reset screens and the
// enrolment step (an account with no two-step has no codes) name the
// administrator reset alone.
//
// `collapsed` (the sign-in card, REQ-UG-SIGNIN-SIMPLE-OTHER-OPTIONS-20261102):
// the same help behind one "Locked out?" disclosure, so the card leads with
// signing in; the reset link above it stays the first way back in.
export function LockedOutRemedies({ className = "sgauth-recovery", recoveryCodes = true, collapsed = false }) {
  const { t } = useLang();
  // The support line shows only once this deployment publishes a mailbox
  // (src/lib/publicContact.js); until then the remedies stand alone.
  const support = publicContact("support");
  const remedyKey = (item) => (item === "authenticator" && !recoveryCodes ? "lockedOut.authenticatorRemedyAdminOnly" : `lockedOut.${item}Remedy`);
  const body = <>
    <ul className="locked-out__list">
      {CASES.map((item) => (
        <li key={item}>
          <strong>{t(`lockedOut.${item}`)}:</strong> {t(remedyKey(item))}
        </li>
      ))}
    </ul>
    {support ? <p className="locked-out__support">{t("lockedOut.support")} <a href={support.href}>{support.email}</a></p> : null}
  </>;
  if (collapsed) return (
    <details className={`${className} locked-out locked-out--collapsed`}>
      <summary className="locked-out__lead">{t("lockedOut.lead")}</summary>
      {body}
    </details>
  );
  return (
    <div className={`${className} locked-out`}>
      <p className="locked-out__lead">{t("lockedOut.lead")}</p>
      {body}
    </div>
  );
}
