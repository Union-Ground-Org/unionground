import { useId, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import {
  NEW_MEMBER_GUIDED_NAV_DAYS,
  onboardingGuideCard,
  readGuideCompleteDismissed,
  writeGuideCompleteDismissed,
} from "../lib/onboardingGuide.js";
import "./OnboardingHud.css";

// REQ-UG-PROGRESSIVE-DISCLOSURE-AND-FEATURE-DRIP-20261001: the onboarding
// stage card (old OnboardingHud slot in the dashboard top chrome). It renders
// only what get_member_onboarding_guide decided: stage copy, the next real
// checklist step, progress, and the badge when badges are on. may
// place this same component on Home through its own nudge arbitration.
// BUG-UG-GUIDE-LOAD-FAILURE-HIDES-GUIDANCE-20261018: when the read
// failed (`loadFailed`), a small retry card stands in for the stage card, so a
// failed read never looks like finished onboarding.
// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP2-20261023: the shell hands
// it the guide engine's `card` (plan(...).card); a bare `guide` is turned into
// the same card by the same builder the engine uses.
// BUG-UG-PASSWORD-PROMPT-OVERLAPS-ONBOARDING-20261020: `children` is
// the slot's next prompt (Home's ordinary nudge). It renders only while this
// card has nothing to show: no card, or the finished card put away.
export function OnboardingHud({ card: engineCard, guide, navigationGuide = guide, showAll = false, memberId = null, onNavigate, loadFailed = false, onRetry = null, className = "", hideComplete = false, children = null }) {
  const { t } = useLang();
  const [dismissed, setDismissed] = useState(() => readGuideCompleteDismissed(memberId));
  if (loadFailed) {
    const bodyKey = navigationGuide?.progressiveDisclosureActive && !showAll
      ? "onboardingGuide.loadFailedBodyGuided" : "onboardingGuide.loadFailedBody";
    return (
      <aside className={`onboarding-hud onboarding-hud--failed${className ? ` ${className}` : ""}`} aria-labelledby="onboarding-hud-failed-title" data-stage="failed">
        <p className="onboarding-hud__eyebrow">{t("onboardingGuide.eyebrow")}</p>
        <h2 id="onboarding-hud-failed-title" className="onboarding-hud__title">{t("onboardingGuide.loadFailedTitle")}</h2>
        <p className="onboarding-hud__body" role="status">{t(bodyKey)}</p>
        {onRetry && (
          <div className="onboarding-hud__actions">
            <button type="button" className="onboarding-hud__cta" onClick={() => onRetry()}>
              {t("onboardingGuide.tryAgain")}
            </button>
          </div>
        )}
      </aside>
    );
  }
  const copy = engineCard === undefined ? onboardingGuideCard(guide) : engineCard;
  if (!copy) return children;
  const complete = copy.stage === "complete";
  //  (site audit B-39),: a finished card the caller asks to hide
  // (every page but Home, where it pushed every page title down) gives way to
  // the fallback, as a dismissed one does. Home still shows it.
  if (complete && (dismissed || hideComplete)) return children;
  const { total, completed } = copy.params;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 100;
  const badgeKey = copy.badgeKey;
  const titleId = "onboarding-hud-title";
  return (
    <aside className={`onboarding-hud${complete ? " onboarding-hud--complete" : ""}${className ? ` ${className}` : ""}`} aria-labelledby={titleId} data-stage={copy.stage}>
      <div className="onboarding-hud__heading">
        <p className="onboarding-hud__eyebrow">{t(copy.eyebrowKey)}</p>
        {badgeKey && (
          <span className={`onboarding-hud__badge onboarding-hud__badge--${copy.badge}`}>
            <span className="sr-only">{t("onboardingGuide.badgePrefix")} </span>
            {t(badgeKey)}
          </span>
        )}
      </div>
      <h2 id={titleId} className="onboarding-hud__title">{t(copy.titleKey)}</h2>
      <p className="onboarding-hud__body">{t(copy.bodyKey, { completed, total })}</p>
      {!complete && copy.nextStepTitle !== null && (
        <p className="onboarding-hud__next">{t("onboardingGuide.nextStep", { title: copy.nextStepTitle })}</p>
      )}
      {!complete && total > 0 && (
        <div
          className="onboarding-hud__progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={completed}
          aria-valuetext={t("onboardingGuide.progress", { completed, total })}
          aria-label={t("onboardingGuide.progressLabel")}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
      <div className="onboarding-hud__actions">
        <button
          type="button"
          className="onboarding-hud__cta"
          onClick={() => onNavigate?.(copy.target.view, copy.target.path)}
        >
          {t(copy.ctaKey)}
        </button>
        {complete && (
          <button
            type="button"
            className="onboarding-hud__dismiss"
            onClick={() => { writeGuideCompleteDismissed(memberId); setDismissed(true); }}
          >
            {t("onboardingGuide.dismiss")}
          </button>
        )}
      </div>
    </aside>
  );
}

// The member's escape hatch from the guided navigation (accessibility: the
// reduced list is a default, never a lock). Rendered by every navigation
// surface that applies the guided view.
export function GuidedNavToggle({ guide, showAll, hiddenCount, onToggle, className = "" }) {
  const { t } = useLang();
  // The note is the button's description: the desktop rail shows only the
  // button and keeps the note for assistive technology.
  const noteId = useId();
  if (!guide?.progressiveDisclosureActive) return null;
  return (
    <div className={`guided-nav-toggle${className ? ` ${className}` : ""}`}>
      {!showAll && (
        <p className="guided-nav-toggle__note" id={noteId}>
          {guide.newMemberWindowOnly === true
            ? t("onboardingGuide.guidedNoteNewMember", { days: NEW_MEMBER_GUIDED_NAV_DAYS })
            : guide.newMemberWindowOnly === false
              ? t("onboardingGuide.guidedNoteStepsOrDays", { days: NEW_MEMBER_GUIDED_NAV_DAYS })
              : t("onboardingGuide.guidedNote")}
        </p>
      )}
      <button type="button" className="guided-nav-toggle__button" aria-pressed={showAll} aria-describedby={showAll ? undefined : noteId} onClick={() => onToggle(!showAll)}>
        {showAll ? t("onboardingGuide.showGuided") : t("onboardingGuide.showEverything", { count: hiddenCount })}
      </button>
    </div>
  );
}

// Visible marker on the spotlit destination. The words are visible text, so
// the link's accessible name carries "Next step" without an aria override.
export function SpotlightMarker() {
  const { t } = useLang();
  return <span className="onboarding-spotlight-marker">{t("onboardingGuide.spotlight")}</span>;
}
