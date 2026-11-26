import { useId, useMemo, useRef, useState } from "react";
import { learningContentCopy } from "../../lib/i18n/learningContent.js";
import { LearningContentBody, lessonHasMore } from "./LearningContentBody.jsx";
import {
  learningScopeFrom, learningScopeKey, learningScopeReady, learningScopeTenant, learningTransportReady,
  useLearningApi, useLearningHome, useLearningPolicy,
} from "./hooks.js";
import "./learningContent.css";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";

// Home's one compact quote or mini-lesson card. Props come from App: the
// member's session and App's per-session client factory (or, in tests, a
// captured client), the selected organization and chapter, and the active
// language. The card renders nothing until there is a live, reviewed item in
// that language; an empty chapter shows no card.
export function LearningHomeCard({ client = null, createSessionClient = null, session = null, organizationId = null, chapterId = null, locale = "en", preview = false, api = null }) {
  const scope = learningScopeFrom({ session, organizationId, chapterId, locale, preview });
  const transportReady = Boolean(api) || learningTransportReady({ preview, session, createSessionClient, client });
  if (!learningScopeReady(scope, transportReady) || !learningScopeTenant(scope)) return null;
  // A new user, session, organization, chapter or language is a new card:
  // nothing cached for the previous one survives the render.
  return <LearningHomeSession key={learningScopeKey(scope)} scope={scope} transport={{ client, session, createSessionClient, override: api }} />;
}

function LearningHomeSession({ scope, transport }) {
  const api = useLearningApi(scope, transport);
  const policyState = useLearningPolicy(api, scope);
  const home = useLearningHome(api, scope, policyState);
  const tr = useMemo(() => learningContentCopy(scope.locale), [scope.locale]);
  const [expandedId, setExpandedId] = useState(null);
  const [hideState, setHideState] = useState("idle");
  // Record 8435: a synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const headingId = useId();
  const bodyId = useId();

  function setHidden(hidden) {
    return runBusyWrite(busyWriteRef, "hide", () => setHiddenNow(hidden));
  }

  async function setHiddenNow(hidden) {
    setHideState(hidden ? "hiding" : "restoring");
    try {
      const result = await api.setHomeHidden({ chapterId: scope.chapterId, hidden });
      policyState.confirm({ homeHidden: result });
      setHideState(result ? "hidden" : "idle");
    } catch {
      setHideState(hidden ? "failed" : "undoFailed");
    }
  }

  // Just hidden in this visit: confirm it, and offer to undo it here.
  if (["hidden", "restoring", "undoFailed"].includes(hideState)) {
    return (
      <section className="home-card lc-home lc-home--hidden" aria-label={tr("home.region")}>
        <p className="lc-home__notice" role="status">{tr("home.hidden")}</p>
        <BusyButton type="button" className="lc-button lc-button--quiet" pending={hideState === "restoring"} onClick={() => setHidden(false)}>{tr("home.undo")}</BusyButton>
        {hideState === "undoFailed" ? <p className="lc-error" role="alert">{tr("home.hideFailed")}</p> : null}
      </section>
    );
  }

  const { policy, item } = home;
  if (!policy || policy.homeHidden || !item) return null;
  const expanded = item.kind === "quote" || expandedId === item.id;
  return (
    <section className="home-card lc-home" aria-labelledby={headingId}>
      <div className="lc-home__top">
        <span className="lc-kicker">{tr(`kind.${item.kind}`)}</span>
        {home.liveCount > 1 ? <span className="lc-home__position">{tr("home.position", { position: home.position, count: home.liveCount })}</span> : null}
      </div>
      <div className="lc-home__content" id={bodyId} aria-live="polite">
        <LearningContentBody item={item} tr={tr} headingId={headingId} headingLevel={2} expanded={expanded} />
      </div>
      <div className="lc-actions">
        {lessonHasMore(item) ? (
          <button type="button" className="lc-button lc-button--quiet" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpandedId(expanded ? null : item.id)}>
            {expanded ? tr("home.readLess") : tr("home.readMore")}
          </button>
        ) : null}
        {home.liveCount > 1 ? (
          <button type="button" className="lc-button" aria-controls={bodyId} onClick={() => { setExpandedId(null); home.next(); }}>{tr("home.next")}</button>
        ) : null}
        <BusyButton type="button" className="lc-button lc-button--quiet" pending={hideState === "hiding"} onClick={() => setHidden(true)}>
          {hideState === "hiding" ? tr("home.hiding") : tr("home.hide")}
        </BusyButton>
      </div>
      {hideState === "failed" ? <p className="lc-error" role="alert">{tr("home.hideFailed")}</p> : null}
    </section>
  );
}
