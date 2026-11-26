import { useId } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { renderGuideCopy } from "./memberAdapter.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import "./OrgStartGuide.css";

// Keep the collapsed card's real text and geometry while its interactive
// guide loads. Sharing this markup also reserves wrapped Spanish copy.
// #9132: when the guide's code fails to load, times out or crashes, the card
// is not busy; it says the setup steps could not load and offers Reload, which
// reloads the page only when the person presses it.
export function OrgStartGuideCard({ view, pending = false, expanded = false, milestonesId, onContinue, onCelebrated, celebrating = false, celebrateStatus = "", loadFailed = false, onReload, children }) {
  const { lang, t } = useLang();
  const id = useId();
  const r = (entry) => renderGuideCopy(lang, entry, t);
  if (!view) return null;
  const unavailable = pending || loadFailed;
  const failure = loadFailed && (
    <div className="org-start__load-failed">
      <p role="alert">{r({ key: "guideEngine.org.loadFailed" })}</p>
      <button type="button" className="member-guide-card__quiet" onClick={onReload}>{r({ key: "guideEngine.org.reload" })}</button>
    </div>
  );
  if (view.kind === "celebrate") {
    return (
      <section className="org-start org-start--live" data-guide-surface="org-start" aria-labelledby={`${id}-title`} aria-busy={pending || undefined}>
        <p className="member-guide-card__eyebrow">{r({ key: "guideEngine.org.live" })}</p>
        <h2 id={`${id}-title`} className="member-guide-card__title">{r(view.title)}</h2>
        <p>{r(view.body)}</p>
        <div className="member-guide-card__actions">
          <BusyButton type="button" className="member-guide-card__primary" disabled={unavailable} pending={celebrating} onClick={onCelebrated}>{r({ key: "guideEngine.org.liveDone" })}</BusyButton>
        </div>
        {/* #9895: a status region in the accessibility tree before any text
            (its own class: the shared .org-start__status:empty is display
            none), so a failed Done is announced. */}
        {!unavailable && <p className="org-start__done-status" role="status">{celebrateStatus}</p>}
        {failure}
        {children}
      </section>
    );
  }
  return (
    <section className="org-start" data-guide-surface="org-start" aria-labelledby={`${id}-title`} aria-busy={pending || undefined}>
      <div className="org-start__summary">
        <div className="org-start__ring" role="img" aria-label={r(view.ring.text)} style={{ "--org-start-percent": `${view.ring.percent}%` }}>
          <span aria-hidden="true">{view.ring.done}/{view.ring.total}</span>
        </div>
        <div className="org-start__words">
          <p className="member-guide-card__eyebrow">{r(view.eyebrow)}</p>
          <h2 id={`${id}-title`} className="member-guide-card__title">{r(view.title)}</h2>
          <p className="org-start__ring-text">{r(view.ring.text)}</p>
          {view.canAct
            ? view.next && <p className="org-start__next">{r(view.next.line)}</p>
            : <p className="org-start__next">{r({ key: "guideEngine.org.nothingForYou" })}</p>}
        </div>
      </div>
      {/* A role with no open milestone it can move sees progress alone. */}
      {view.canAct && <div className="member-guide-card__actions">
        <button type="button" className="member-guide-card__primary" disabled={unavailable} aria-expanded={expanded} aria-controls={milestonesId ?? `${id}-milestones`} onClick={onContinue}>{r({ key: "guideEngine.org.continue" })}</button>
      </div>}
      {view.canAct && <p className="org-start__shared">{r({ key: "guideEngine.org.sharedLine" })}</p>}
      {failure}
      {children}
    </section>
  );
}
