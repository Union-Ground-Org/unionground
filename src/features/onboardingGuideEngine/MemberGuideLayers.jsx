// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP2-20261023.
//
// The proposed member layers on screen (Batch E R36 feature guides and R26
// coach marks). Each renders only what plan() decided and only while its
// switch is on (defined on the server in port step 3, on by default, and an
// organization can turn it off). Nothing here is a dialog: the feature guide is
// an inline card at the top of a feature's page, the coach mark an inline note
// under its control; neither moves focus, and each speaks once, politely.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CircleCheck, OctagonX, UserRound } from "lucide-react";
import { useLang } from "../../lib/LanguageContext.jsx";
import {
  ONBOARDING_GUIDE_ACTION_EVENT,
  announceGuideAction,
  readCoachMarkSession,
  readCoachMarksSeen,
  readFeatureGuideMarks,
  writeCoachMarkSeen,
  writeCoachMarkSession,
  writeFeatureGuideMark,
} from "../../lib/onboardingGuide.js";
import { renderGuideCopy } from "./memberAdapter.js";
import "./MemberGuideLayers.css";

/**
 * The device's marks for both layers, and their writers. Reads and writes
 * nothing while both switches are off.
 * @param {{ memberId: string | null, featureGuidesOn: boolean, coachMarksOn: boolean }} input
 */
export function useMemberGuideLayers({ memberId, featureGuidesOn, coachMarksOn }) {
  const [featureMarks, setFeatureMarks] = useState(() => (featureGuidesOn ? readFeatureGuideMarks(memberId) : {}));
  const [coachSeen, setCoachSeen] = useState(() => (coachMarksOn ? readCoachMarksSeen(memberId) : {}));
  const [coachSession, setCoachSession] = useState(() => (coachMarksOn ? readCoachMarkSession(memberId) : null));

  useEffect(() => { setFeatureMarks(featureGuidesOn ? readFeatureGuideMarks(memberId) : {}); }, [memberId, featureGuidesOn]);
  useEffect(() => {
    setCoachSeen(coachMarksOn ? readCoachMarksSeen(memberId) : {});
    setCoachSession(coachMarksOn ? readCoachMarkSession(memberId) : null);
  }, [memberId, coachMarksOn]);

  // State changes only when a mark does, so a repeated mark renders nothing.
  const commitMarks = useCallback((next) => {
    setFeatureMarks((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
  }, []);

  const markFeature = useCallback((kind, feature) => {
    if (!featureGuidesOn || !memberId) return;
    commitMarks(writeFeatureGuideMark(memberId, kind, feature));
  }, [featureGuidesOn, memberId, commitMarks]);

  // A real action finishes its guide; the first time is kept.
  useEffect(() => {
    if (!featureGuidesOn || !memberId || typeof window === "undefined") return undefined;
    const onAction = (event) => {
      const feature = event?.detail?.feature;
      if (typeof feature === "string") commitMarks(writeFeatureGuideMark(memberId, "acted", feature));
    };
    window.addEventListener(ONBOARDING_GUIDE_ACTION_EVENT, onAction);
    return () => window.removeEventListener(ONBOARDING_GUIDE_ACTION_EVENT, onAction);
  }, [featureGuidesOn, memberId, commitMarks]);

  const markCoachShown = useCallback((anchor) => {
    if (!coachMarksOn || !memberId || readCoachMarkSession(memberId) === anchor) return;
    writeCoachMarkSession(memberId, anchor);
    setCoachSession(anchor);
  }, [coachMarksOn, memberId]);

  const markCoachSeen = useCallback((anchor) => {
    if (!coachMarksOn || !memberId) return;
    writeCoachMarkSeen(memberId, anchor);
    setCoachSeen(readCoachMarksSeen(memberId));
  }, [coachMarksOn, memberId]);

  return { featureMarks, markFeature, coachSeen, coachSession, markCoachShown, markCoachSeen };
}

/**
 * A shell handler that also finishes `feature`'s guide once its write has
 * landed. Each invocation supplies its own mutation outcome; a queued write
 * does not count, and cannot suppress another invocation that committed.
 * A superseded run resolves undefined and is not success. A committed write
 * finishes the guide only while the session that started it is current, so a
 * slow response cannot finish the next member's guide after a same-tab
 * account switch (BUG-UG-FEATURE-GUIDE-SESSION-COMPLETION-20261025).
 * @param {string} feature
 * @param {(...args: any[]) => any} handler
 * @param {EventTarget} [target]
 * @param {{ isCurrent: () => boolean } | null} [operation] the initiating session's operation
 */
export function countGuideAction(feature, handler, target = globalThis, operation = null) {
  return async (...args) => {
    const outcome = await handler(...args);
    if (outcome?.status === "committed" && (!operation || operation.isCurrent())) announceGuideAction(feature, target);
    return outcome?.value;
  };
}

const VISIBLE_BLOCKERS = "[aria-modal=\"true\"], [data-guide-surface]";

function visibleMatch(doc, selector) {
  return [...doc.querySelectorAll(selector)].some((element) => element.getClientRects().length > 0);
}

function blockerVisible(doc) {
  return visibleMatch(doc, VISIBLE_BLOCKERS);
}

/**
 * The facts R26 needs from the screen: seconds on this screen (counted to
 * the wait), whether the anchor is on the page, and whether a dialog or a
 * feature guide card is showing. Polls once a second, only while `active`.
 */
export function useCoachMarkFacts({ active, screenKey, anchorSelector = "[data-guide-anchor=\"next-step\"]", waitSeconds = 10 }) {
  const [facts, setFacts] = useState({ secondsOnScreen: 0, anchorReached: false, blocked: false });
  useEffect(() => {
    if (!active || typeof document === "undefined") { setFacts({ secondsOnScreen: 0, anchorReached: false, blocked: false }); return undefined; }
    const start = Date.now();
    const check = () => {
      const next = {
        secondsOnScreen: Math.min(waitSeconds, Math.floor((Date.now() - start) / 1000)),
        anchorReached: Boolean(document.querySelector(anchorSelector)),
        blocked: blockerVisible(document),
      };
      setFacts((current) => (current.secondsOnScreen === next.secondsOnScreen && current.anchorReached === next.anchorReached && current.blocked === next.blocked ? current : next));
    };
    check();
    const timer = window.setInterval(check, 1000);
    return () => window.clearInterval(timer);
  }, [active, screenKey, anchorSelector, waitSeconds]);
  return facts;
}

// A guide card speaks only after an in-app move to its page, never on a load.
// The shell notes the move in an effect after its children mount, so the card
// asks when its short delay ends, not while it renders.
let navigatedInApp = false;
export function noteGuideNavigation() { navigatedInApp = true; }
const always = () => true;

function PoliteOnce({ text, when = always }) {
  const [said, setSaid] = useState("");
  const allowed = useRef(when);
  allowed.current = when;
  useEffect(() => {
    const timer = window.setTimeout(() => { if (allowed.current()) setSaid(text); }, 50);
    return () => window.clearTimeout(timer);
  }, [text]);
  return <span className="sr-only" role="status" aria-live="polite">{said}</span>;
}

const afterInAppMove = () => navigatedInApp;

function Group({ icon: Icon, heading, items }) {
  if (!items.length) return null;
  return (
    <div className="member-guide-card__group">
      <h3><Icon aria-hidden="true" size={18} />{heading}</h3>
      <ul>{items.map((line) => <li key={line}>{line}</li>)}</ul>
    </div>
  );
}

/**
 * The feature guide card (Proposed) for the feature on screen, from
 * plan(...).featureGuides.showing. Its primary button performs or goes to the
 * real first action; Got it hides it.
 */
export function MemberFeatureGuide({ guides, onPrimary, onGotIt, onSeen }) {
  const { lang, t } = useLang();
  const id = useId();
  const item = guides?.showing ?? null;
  // The callback is read through a ref: a new function from the parent on
  // every render must not record the mark again.
  const seen = useRef(onSeen);
  seen.current = onSeen;
  const feature = item?.feature ?? null;
  const showingAs = guides?.showingAs ?? null;
  useEffect(() => {
    if (feature && showingAs === "first") seen.current?.(feature);
  }, [feature, showingAs]);
  if (!item) return null;
  const r = (entry) => renderGuideCopy(lang, entry, t);
  const name = r(item.title);
  const doneBefore = item.doneBeforeOpened && guides.showingAs === "first";
  return (
    <section className="member-guide-card" data-guide-surface="feature-guide" aria-labelledby={`${id}-title`}>
      {/* B-52 (#9525): the heading names the guide, not only the feature, so
          it never repeats the page title; the eyebrow keeps the notes. */}
      {(doneBefore || item.optional) && <p className="member-guide-card__eyebrow">
        {doneBefore && <span>{r({ key: "guideEngine.fg.doneBeforeOpened" })}</span>}
        {item.optional && <span className="member-guide-card__chip">{r({ key: "guideEngine.fg.optional" })}</span>}
      </p>}
      <h2 id={`${id}-title`} className="member-guide-card__title">{r({ key: "guideEngine.fg.about", params: { feature: name } })}</h2>
      {item.done && !doneBefore && <p className="member-guide-card__done">{r({ key: "guideEngine.row.done" })}</p>}
      <div className="member-guide-card__groups">
        <Group icon={CircleCheck} heading={r({ key: "guideEngine.fg.youCan" })} items={item.canDo.map(r)} />
        <Group icon={OctagonX} heading={r({ key: "guideEngine.fg.never" })} items={item.neverDo.map(r)} />
        {item.askWho && <Group icon={UserRound} heading={r({ key: "guideEngine.fg.askHeading" })} items={[r({ key: "guideEngine.fg.askLine", params: { who: item.askWho } })]} />}
      </div>
      <div className="member-guide-card__actions">
        {!item.done && <button type="button" className="member-guide-card__primary" onClick={() => onPrimary?.(item)}>{r(item.firstLabel)}</button>}
        <button type="button" className="member-guide-card__quiet" onClick={() => onGotIt?.(item)}>{r({ key: "guideEngine.fg.gotIt" })}</button>
      </div>
      <PoliteOnce text={r({ key: "guideEngine.fg.announce", params: { feature: name } })} when={afterInAppMove} />
    </section>
  );
}

function GuideRow({ item, onOpen, lang }) {
  const { t } = useLang();
  const r = (entry) => renderGuideCopy(lang, entry, t);
  return (
    <li>
      <button type="button" className="member-guide-list__row" onClick={() => onOpen?.(item)}>
        <span className="member-guide-list__name">
          <strong>{r(item.title)}</strong>
          {item.optional && <span className="member-guide-card__chip">{r({ key: "guideEngine.fg.optional" })}</span>}
          <span className="member-guide-list__why">{r(item.why)}</span>
        </span>
        <span className="member-guide-list__state">{item.done ? r(item.doneBeforeOpened ? { key: "guideEngine.fg.doneBeforeOpened" } : { key: "guideEngine.row.done" }) : r({ key: "guideEngine.fg.notYet" })}</span>
      </button>
    </li>
  );
}

/** "Your guides" on member Home (Proposed): the engine's order, done ones folded. */
export function MemberGuideList({ guides, onOpen }) {
  const { lang, t } = useLang();
  const id = useId();
  const [showDone, setShowDone] = useState(false);
  if (!guides || guides.items.length + guides.done.length === 0) return null;
  const r = (entry) => renderGuideCopy(lang, entry, t);
  return (
    <section className="member-guide-list" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>{r({ key: "guideEngine.fg.yourGuides" })}</h2>
      {guides.items.length > 0 && <ul>{guides.items.map((item) => <GuideRow key={item.feature} item={item} onOpen={onOpen} lang={lang} />)}</ul>}
      {guides.done.length > 0 && (
        <>
          <button type="button" className="member-guide-list__fold" aria-expanded={showDone} aria-controls={`${id}-done`} onClick={() => setShowDone((value) => !value)}>
            {r({ key: "guideEngine.fg.doneGroup", params: { n: guides.done.length } })}
          </button>
          {showDone && <ul id={`${id}-done`}>{guides.done.map((item) => <GuideRow key={item.feature} item={item} onOpen={onOpen} lang={lang} />)}</ul>}
        </>
      )}
    </section>
  );
}

export const COACH_MARK_ID = "onboarding-coach-mark";

/**
 * The coach mark (Proposed) under its control, from plan(...).coachMark.
 * Non-modal: no dimming, no tour controls, focus stays where it is; one Got it
 * and Escape close it for good.
 */
export function MemberCoachMark({ mark, onShown, onClose }) {
  const { t } = useLang();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!mark) return undefined;
    onShown?.(mark.anchor);
    // Escape belongs to an open dialog first; it never closes the mark for good then.
    const onKey = (event) => { if (event.key === "Escape" && !visibleMatch(document, "[aria-modal=\"true\"]")) close.current?.(mark.anchor); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mark?.anchor]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!mark) return null;
  const title = t(mark.titleKey);
  const body = t(mark.bodyKey, mark.params);
  return (
    <aside className="member-coach-mark">
      <div id={COACH_MARK_ID}>
        <p className="member-coach-mark__title">{title}</p>
        <p>{body}</p>
      </div>
      <button type="button" className="member-guide-card__quiet" onClick={() => onClose?.(mark.anchor)}>{t("guideEngine.fg.gotIt")}</button>
      <PoliteOnce text={`${title}. ${body}`} />
    </aside>
  );
}
