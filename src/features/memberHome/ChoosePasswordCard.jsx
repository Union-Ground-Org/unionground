import { cloneElement, isValidElement, useEffect, useId, useState } from "react";
import { KeyRound } from "lucide-react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { historyKey, readHistory, writeHistory } from "./HomeNudgeSlot.jsx";
import "./homeNudges.css";

// REQ-UG-TEMPORARY-PASSWORD-CHANGE-PROMPT-20261018: the emailed
// sign-in password says "change it after you sign in", so Home asks once. The
// marker is user_metadata.union_ground_password_issued_at, stamped when the
// password is emailed (api/_lib/memberInvitations.js PASSWORD_ISSUED_KEY) and
// deleted by the member's own password change (PasswordChangeForm), which
// removes this card. "Not now" hides it on this device for that issued
// password only; a reissued password carries a new stamp and asks again. It is
// a prompt, not a gate: nothing authorizes on the marker.
// Dismissals live in the Home nudge history this browser already keeps (the
// disclosed ug-home-nudges key, written by HomeNudgeSlot), under kind
// "password" and the stamp of the password they dismissed.
function dismissedFor(userId, issuedAt) {
  const entry = readHistory(historyKey(userId)).password;
  return Boolean(entry?.dismissedAt) && entry?.issuedAt === issuedAt;
}

// The props App hands the Home views: null when the session carries no
// emailed-password stamp (or in the preview), so the views render nothing.
export function choosePasswordFor(session, preview, navigate) {
  const issuedAt = preview ? null : session?.user?.user_metadata?.union_ground_password_issued_at;
  if (typeof issuedAt !== "string" || !issuedAt) return null;
  return { issuedAt, userId: session.user.id ?? null, onChoose: () => navigate("settings", "/m/settings/security") };
}

// BUG-UG-PASSWORD-PROMPT-OVERLAPS-ONBOARDING-20261020: Home's single
// prompt slot, password first, then the onboarding guide card, then the
// ordinary nudge (`children`). The guide card the shell hands Home accepts the
// next prompt as its own children and renders it only while it shows no card,
// so a member never reads two next steps at once. `homeGuides` (Home's
// feature guide and "Your guides") sits under the slot whichever prompt shows.
export function HomeGuidanceSlot({ choosePassword = null, onboardingHud = null, homeGuides = null, children = null }) {
  const guidance = isValidElement(onboardingHud) ? cloneElement(onboardingHud, {}, children) : children;
  return <><ChoosePasswordCard {...choosePassword}>{guidance}</ChoosePasswordCard>{homeGuides}</>;
}

// One Home nudge at a time: this card goes first, and while it is not showing
// (no stamp, or dismissed) its children, the regular nudge slot, take its place.
export function ChoosePasswordCard({ issuedAt = null, userId = null, onChoose = null, children = null }) {
  const { t } = useLang();
  const titleId = useId();
  const active = Boolean(userId && issuedAt);
  const [dismissed, setDismissed] = useState(() => active && dismissedFor(userId, issuedAt));
  useEffect(() => { setDismissed(active && dismissedFor(userId, issuedAt)); }, [active, userId, issuedAt]);
  if (!active || dismissed) return children;
  const dismiss = () => {
    const key = historyKey(userId);
    writeHistory(key, { ...readHistory(key), password: { issuedAt, dismissedAt: Date.now() } });
    setDismissed(true);
  };
  return (
    <section className="home-nudge" aria-labelledby={titleId}>
      <span className="home-nudge__icon" aria-hidden="true"><KeyRound size={18} /></span>
      <div className="home-nudge__copy">
        <h2 id={titleId}>{t("homeNudge.passwordTitle")}</h2>
        <p>{t("homeNudge.passwordBody")}</p>
        <p><strong>{t("auth.passwordMinimum")}</strong></p>
      </div>
      <div className="home-nudge__actions">
        {onChoose ? <button type="button" className="home-nudge__primary" onClick={onChoose}>{t("homeNudge.passwordAction")}</button> : null}
        <button type="button" className="home-nudge__later" aria-label={t("homeNudge.notNowPassword")} onClick={dismiss}>{t("homeNudge.notNow")}</button>
      </div>
    </section>
  );
}
