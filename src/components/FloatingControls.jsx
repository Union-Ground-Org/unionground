import { AlertTriangle, ArrowUp, Check, Database, Eye, FileText, Laptop, Lightbulb, Menu, MessageCircleQuestion, MousePointerClick, Plus, RefreshCw, Shield, Target, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BusyButton } from "./BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { CompassSourceList } from "../features/compass/CompassSourceList.jsx";
import { classifyDataTopics } from "../features/compass/dataTopics.js";
import { suggestedQuestionRole } from "../features/compass/suggestedQuestions.js";
import { CompassAnswerActions } from "../features/compass/CompassAnswerActions.jsx";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { captureSanitizedDiagnostic } from "../lib/deferredObservability.js";
import { useCompassDesktopFocus } from "../lib/compassCoveredFocus.js";
import { useModalIsolation } from "../lib/useModalIsolation.js";
import { returnFocusAfterModal } from "../lib/useTransitionPresence.js";
import { registerEscapeLayer } from "../lib/escapeLayers.js";
import { BrandMark } from "./BrandMark.jsx";

// Union Ground names its assistant the Guide (internal ids still say Compass).
const GUIDE_NAME = "Union Ground Guide";

// Latest live Compass panel. A Strict Mode remount must not let the discarded
// mount's focus restore pull the question box back to the opener.
let assistantFocusGeneration = 0;

const memberPersona = {
  id: "member",
  name: "Darnell Foster",
  roleKey: "guide.roleMember",
  guidanceKey: "guide.guidanceMember",
};

// One persona per real staff plane, in STAFF_PLANES switcher order — the ids
// are the plane keys, and the names match the canon cast the fallback rosters
// and the prototype's vestigial ids agree on. No guest: no guest plane or
// role exists anywhere in the app.
const personas = [
  { id: "steward", name: "Sam Okafor", roleKey: "guide.roleSteward", tone: "blue", guidanceKey: "guide.guidanceSteward" },
  { id: "coordinator", name: "Jordan Patel", roleKey: "guide.roleGrievance", tone: "coral", guidanceKey: "guide.guidanceGrievance" },
  { id: "advisor", name: "Avery Nguyen", roleKey: "guide.roleAdvisor", tone: "gold", guidanceKey: "guide.guidanceAdvisor" },
  { id: "admin", name: "Alex Rivera", roleKey: "guide.roleAdmin", tone: "violet", guidanceKey: "guide.guidanceAdmin" },
  { id: "vp", name: "Taylor Morgan", roleKey: "guide.rolePresident", tone: "berry", guidanceKey: "guide.guidancePresident" },
];

const tourSteps = [
  { view: "today", path: "/m", titleKey: "nav.today", copyKey: "guide.tourCopyToday", target: ".home-ph, .home-greet" },
  { view: "messages", path: "/m/messages", titleKey: "nav.messages", copyKey: "guide.tourCopyMessages", target: ".inbox-panel" },
  { view: "cases", path: "/m/cases", titleKey: "nav.issues", copyKey: "guide.tourCopyCases", target: ".mcases-desk, .mcases-case, .mcases-head" },
  // The tour visits meetings rather than reports.
  { view: "events", path: "/m/events", titleKey: "nav.meetings", copyKey: "guide.tourCopyMeetings", target: ".events-screen, .screen" },
  { view: "rights", path: "/m/rights", titleKey: "nav.rights", copyKey: "guide.tourCopyRights", target: ".learn-dhero, .learn-hero" },
  { view: "search", path: "/m/search", titleKey: "nav.search", copyKey: "guide.tourCopySearch", target: ".search-box" },
];


// A true banner, not a takeover (owner spec, 2026-08-07): one compact card
// with the greeting and a single way in. The three orientation facts stay
// desktop-only via the stylesheet, and the six-step tour CTA is gone from
// onboarding — the tour remains reachable from the preview guide for anyone
// who goes looking, but it no longer interrupts the first minute.
//
// The welcome, the preview guide and the tour mount open and close with the
// prototype modal's 200 ms fade (an owner decision; App holds each
// through useModalExit and passes `closing`): focus stays inside and every
// further dismissal or step is ignored until the surface has gone, and then
// focus goes back to the control that opened it.
function useClosingGuard(closing) {
  const closingRef = useRef(closing);
  closingRef.current = closing;
  return closingRef;
}

function useReturnFocusOnExit() {
  const [opener] = useState(() => document.activeElement);
  useEffect(() => () => { returnFocusAfterModal(opener); }, [opener]);
}

export function DemoWelcome({ memberName, roleName, onExplore, inSession = false, closing = false, onTransitionEnd }) {
  const { t } = useLang();
  const layerRef = useRef(null);
  const startRef = useRef(null);
  const closingRef = useClosingGuard(closing);
  useModalIsolation(layerRef);
  useReturnFocusOnExit();

  useEffect(() => {
    if (!layerRef.current?.contains(document.activeElement)) startRef.current?.focus();
    function onKeyDown(event) {
      // A command palette opened above claims its Escape (preventDefault).
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (!closingRef.current) onExplore();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closingRef, onExplore]);

  return (
    <div ref={layerRef} className="demo-welcome-layer" role="presentation" data-state={closing ? "closing" : undefined} onTransitionEnd={onTransitionEnd}>
      <section className="demo-welcome demo-welcome--banner" role="dialog" aria-modal="true" aria-labelledby="demo-welcome-title" aria-describedby="demo-welcome-summary">
        <header className="demo-welcome__header">
          <BrandMark size={40} />
          <div>
            <span className="eyebrow">{t("demo.welcomeEyebrow")}</span>
            <h2 id="demo-welcome-title">{t("demo.welcomeTitle")}</h2>
            <p id="demo-welcome-summary">{t("demo.welcomeSummary", { name: memberName, role: roleName || t("demo.hatMember") })}</p>
          </div>
        </header>
        <div className="demo-welcome__facts">
          <DemoWelcomeFact icon={Database} title={t("demo.welcomeSampleTitle")}>{t("demo.welcomeSampleBody")}</DemoWelcomeFact>
          <DemoWelcomeFact icon={MousePointerClick} title={t("demo.welcomeTryTitle")}>{t("demo.welcomeTryBody")}</DemoWelcomeFact>
          <DemoWelcomeFact
            icon={RefreshCw}
            title={t(inSession ? "demo.welcomeSessionTitle" : "demo.welcomeResetTitle")}
          >
            {t(inSession ? "demo.welcomeSessionBody" : "demo.welcomeResetBody")}
          </DemoWelcomeFact>
        </div>
        <footer className="demo-welcome__actions">
          <button ref={startRef} type="button" className="dialog-primary" onClick={() => { if (!closing) onExplore(); }}>{t("demo.exploreAlone")}</button>
          {/* No support line: this deployment publishes no support mailbox
              (src/lib/publicContact.js). */}
        </footer>
      </section>
    </div>
  );
}

function DemoWelcomeFact({ icon: Icon, title, children }) {
  return (
    <section className="demo-welcome__fact">
      <span className="demo-welcome__fact-icon" aria-hidden="true"><Icon size={18} /></span>
      <div><h3>{title}</h3><p>{children}</p></div>
    </section>
  );
}

// castNames ({ hat: fullName }) renames the cast for the live SAMPLE demo,
// whose hats are the Tamarack persona accounts rather than this fixture cast
// (UB-UG-DEMO-STRAIGHT-IN-ENTRY-RESTORED-20261107).
export function PreviewGuide({ onClose, onNavigate, onStartTour, closing = false, onTransitionEnd, castNames = null }) {
  const { t } = useLang();
  const [personaId, setPersonaId] = useDeviceParityState("guide.personaId", memberPersona.id);
  const named = (item) => ({ ...item, name: castNames?.[item.id] || item.name });
  const cast = personas.map(named);
  const member = named(memberPersona);
  const persona = personaId === member.id ? member : cast.find((item) => item.id === personaId) || member;
  const avatar = member.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  // aria-modal was declared here long before it was honest: nothing trapped
  // focus or inerted the page behind the panel, so a keyboard user tabbed
  // straight through the dialog into covered controls (sol F7 on 89660c497 —
  // the phone chip made this the tour's front door, which is what surfaced
  // it). Same isolation + Escape + initial-focus contract as DemoWelcome.
  const closingRef = useClosingGuard(closing);
  useModalIsolation(panelRef);
  useReturnFocusOnExit();
  useEffect(() => {
    if (!panelRef.current?.contains(document.activeElement)) closeRef.current?.focus();
    function onKeyDown(event) {
      // A command palette opened above claims its Escape (preventDefault).
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (!closingRef.current) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closingRef, onClose]);
  // Mid-fade the guide takes no further step: no navigation, no tour, no
  // second close.
  const unlessClosing = (action) => (...args) => { if (!closing) action(...args); };
  const go = unlessClosing(onNavigate);
  return (
    <section ref={panelRef} className="guide-dialog" role="dialog" aria-modal="true" aria-label={t("guide.dialogLabel")} data-state={closing ? "closing" : undefined} onTransitionEnd={onTransitionEnd}>
      <header>
        <span className="guide-avatar">{avatar}</span>
        <div><strong>{t("guide.youAre", { name: persona.name, role: t(persona.roleKey) })}</strong><small>{t("nav.today")}</small></div>
        <button type="button" ref={closeRef} aria-label={t("guide.close")} onClick={unlessClosing(onClose)}><X size={19} /></button>
      </header>
      <div className="guide-dialog__scroll">
        <GuideGroup icon={Lightbulb} title={t("guide.onThisPage")}>
          <div className="guide-line"><span>•</span><p>{t("guide.weekGlance")}</p><button type="button" onClick={() => go("today", "/m")}>{t("guide.showMe")}</button></div>
          <div className="guide-line"><span>•</span><p>{t("guide.fiveTabs")}</p></div>
        </GuideGroup>
        <GuideGroup icon={Target} title={t("guide.tryThis")}>
          <div className="guide-line"><Check size={16} /><p>{t("guide.openCases")}</p><button type="button" onClick={() => go("cases", "/m/cases")}>{t("guide.open")}</button></div>
          <div className="guide-line"><Check size={16} /><p>{t("guide.seeEvents")}</p><button type="button" onClick={() => go("events", "/m/events")}>{t("guide.open")}</button></div>
          <div className="guide-line"><Check size={16} /><p>{t("guide.seeWorkload")}</p><button type="button" onClick={() => go("workload", "/m/workload")}>{t("guide.open")}</button></div>
          <div className="guide-line"><Check size={16} /><p>{t("guide.seeForms")}</p><button type="button" onClick={() => go("forms", "/m/forms")}>{t("guide.open")}</button></div>
          <div className="guide-line"><Check size={16} /><p>{t("guide.manageSettings")}</p><button type="button" onClick={() => go("settings", "/m/settings")}>{t("guide.open")}</button></div>
        </GuideGroup>
        <GuideGroup icon={Eye} title={t("guide.seeAs")}>
          <p className="persona-guidance" aria-live="polite">{t(persona.guidanceKey)}</p>
          <div className="persona-list">
            {cast.map((item) => <button type="button" key={item.id} aria-pressed={personaId === item.id} onClick={unlessClosing(() => setPersonaId(item.id))}><i className={`dot dot--${item.tone}`} />{item.name} · {t(item.roleKey)}</button>)}
          </div>
        </GuideGroup>
        <button className="tour-link" type="button" onClick={unlessClosing(onStartTour)}>▶ {t("guide.watchTour")}</button>
      </div>
    </section>
  );
}

export function GuidedTour({ onClose, onNavigate, closing = false, onTransitionEnd }) {
  const { t } = useLang();
  const [stepIndex, setStepIndex] = useDeviceParityState("tour.stepIndex", 0);
  const [spotlight, setSpotlight] = useState(null);
  const layerRef = useRef(null);
  const step = tourSteps[stepIndex];
  const closingRef = useClosingGuard(closing);
  useModalIsolation(layerRef);
  useReturnFocusOnExit();

  useEffect(() => {
    function onKeyDown(event) {
      // A command palette opened above claims its Escape (preventDefault).
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (!closingRef.current) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closingRef, onClose]);

  useEffect(() => {
    let frame = 0;
    let timer = 0;
    const target = () => step.target.split(",").map((selector) => document.querySelector(selector.trim())).find(Boolean);
    const measure = () => {
      const element = target();
      if (!element) { setSpotlight(null); return; }
      const rect = element.getBoundingClientRect();
      const pad = 8;
      const top = Math.max(8, rect.top - pad);
      const left = Math.max(8, rect.left - pad);
      setSpotlight({
        top,
        left,
        width: Math.max(0, Math.min(window.innerWidth - left - 8, rect.width + (pad * 2))),
        height: Math.max(0, Math.min(window.innerHeight - top - 8, rect.height + (pad * 2))),
      });
    };
    const settle = () => {
      const element = target();
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      element?.scrollIntoView?.({ block: "center", inline: "nearest", behavior: reduced ? "auto" : "smooth" });
      frame = window.requestAnimationFrame(() => { frame = window.requestAnimationFrame(measure); });
      timer = window.setTimeout(measure, reduced ? 0 : 360);
    };
    settle();
    const observer = typeof MutationObserver === "function" ? new MutationObserver(measure) : null;
    observer?.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [step.target]);

  function move(nextIndex) {
    if (closing) return;
    const next = tourSteps[nextIndex];
    setStepIndex(nextIndex);
    onNavigate(next.view, next.path);
  }

  return (
    <div ref={layerRef} className={`tour-layer${spotlight ? " tour-layer--focused" : ""}`} role="presentation" data-state={closing ? "closing" : undefined} onTransitionEnd={onTransitionEnd}>
      {spotlight && <div className="tour-spotlight" aria-hidden="true" style={{ top: spotlight.top, left: spotlight.left, width: spotlight.width, height: spotlight.height }} />}
      <section className="tour-dialog" role="dialog" aria-modal="true" aria-label={t("guide.tourLabel")}>
        <header><div><span className="eyebrow">{t("guide.stepEyebrow", { current: stepIndex + 1, total: tourSteps.length })}</span><h2>{t(step.titleKey)}</h2></div><button type="button" aria-label={t("guide.closeTour")} onClick={() => { if (!closing) onClose(); }}><X size={19} /></button></header>
        <p>{t(step.copyKey)}</p>
        <progress value={stepIndex + 1} max={tourSteps.length} aria-label={t("guide.tourProgress", { current: stepIndex + 1, total: tourSteps.length })} />
        <div className="tour-actions">
          <button type="button" className="dialog-secondary" disabled={stepIndex === 0} onClick={() => move(stepIndex - 1)}>{t("guide.back")}</button>
          {stepIndex < tourSteps.length - 1
            ? <button type="button" className="dialog-primary" onClick={() => move(stepIndex + 1)}>{t("guide.next")}</button>
            : <button type="button" className="dialog-primary" onClick={() => { if (!closing) onClose(); }}>{t("guide.finishTour")}</button>}
        </div>
      </section>
    </div>
  );
}

function GuideGroup({ icon: Icon, title, children }) {
  return (
    <section className="guide-group">
      <h3><Icon size={14} aria-hidden="true" /> {title}</h3>
      {children}
    </section>
  );
}

const compassChipKeys = ["compass.chipDiscipline", "compass.chipGrievance", "compass.chipTelework"];
const SAVED_ANSWER_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
// #9563: the question box asks what the worn hat's suggestions ask about, in
// the same three groups as the suggested questions (suggestedQuestionRole).
const COMPASS_PLACEHOLDER_KEYS = { member: "compass.placeholder", steward: "compass.placeholderSteward", admin: "compass.placeholderAdmin" };

// The same three suggestions wear two shapes (owner reference, 2026-08-08):
// a fresh chat gets icon rows in the thread area; once a conversation is
// running they compress into a chip rail above the composer.
const compassStarters = [
  { key: "compass.chipDiscipline", Icon: Shield },
  { key: "compass.chipGrievance", Icon: FileText },
  { key: "compass.chipTelework", Icon: Laptop },
];

// initialDraft pre-fills the composer (the Search screen's "Ask Compass about
// …" hand-off); the member still reviews and sends it themselves.
export function Assistant({ sessionOperation = null, onClose, threads = [], onSend, initialDraft = "", searchTarget = null, demo = false, hat = "member", historyError = false, historyLoading = false, onRetryHistory = null, suggestions = null, staffDataAvailable = false, pageHelp = null, answerActions = null, nudges = [], sourceArticles = [], onOpenSource = null }) {
  const { t } = useLang();
  // REQ-UG-COMPASS-ROLE-SUGGESTED-QUESTIONS-20261001: the organization's
  // role list (App resolves the hat and language). null keeps the built-in
  // starters (demo, or no organization configuration); [] means the admin
  // turned suggested questions off, so neither shape renders.
  const roleSuggestions = Array.isArray(suggestions) ? suggestions.filter((item) => typeof item === "string" && item.trim()) : null;
  const starterRows = roleSuggestions
    ? roleSuggestions.map((text) => ({ key: text, text, Icon: MessageCircleQuestion }))
    : compassStarters.map(({ key, Icon }) => ({ key, text: t(key), Icon }));
  const chipTexts = roleSuggestions ?? compassChipKeys.map((key) => t(key));
  // REQ-UG-COMPASS-STAFF-DATA-ANSWERS-20261001: a staff hat in an
  // organization that turned figure answers on can ask about its own numbers.
  // The server decides the topics and refuses members; this only chooses the
  // request mode. A suggested question about figures pre-selects it.
  const [numbersMode, setNumbersMode] = useState(false);
  const numbersActive = staffDataAvailable && numbersMode;
  // REQ-UG-COMPASS-PAGE-AND-CASE-AWARE-HELP-20261001: page-aware quick
  // help. Only the page key is sent, and only while this is on; the server
  // ignores it unless the organization switch allows it.
  const [pageOn, setPageOn] = useState(true);
  const pageActive = Boolean(pageHelp?.key) && pageOn && !numbersActive;
  function chooseSuggestion(text) {
    setDraft(text);
    if (staffDataAvailable && classifyDataTopics(text).length) setNumbersMode(true);
  }
  // Below 768px the surface is a full-screen takeover (owner feedback,
  // 2026-08-05) and behaves as a real modal: aria-modal, isolation, Escape,
  // focus moved inside. Both rail shells keep the bounded panel nonmodal —
  // the page is visible and interactive beside it. Same breakpoint as App's
  // tablet shell, so a painted rail is never silently inerted behind Compass.
  // Narrow is the default: where matchMedia is unavailable (jsdom) the app
  // already renders its phone shell, so the surface must be the takeover too.
  const [takeover, setTakeover] = useState(() =>
    !(typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(min-width: 768px)").matches));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const rail = window.matchMedia("(min-width: 768px)");
    if (typeof rail.addEventListener !== "function") return undefined;
    const update = () => setTakeover(!rail.matches);
    rail.addEventListener("change", update);
    return () => rail.removeEventListener("change", update);
  }, []);
  const [draft, setDraft] = useDeviceParityState("assistant.draft", initialDraft);
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  // The question being answered right now, echoed as a user bubble before the
  // round-trip lands — without it the sheet sits blank for the whole request
  // and a sent question looks swallowed.
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  // Search-only degraded reply (the answer service was unreachable, retrieval
  // was not): the question and the verified sources it found, rendered from
  // local state because nothing was saved to the thread.
  const [degraded, setDegraded] = useState(null);
  // A refused request pauses this open composer. Closing and reopening it
  // permits a deliberate retry after an administrator restores Compass.
  const [paused, setPaused] = useState(false);
  // Polite completion channel for a send this panel just made. Saved history
  // never sets it, and leaving that thread clears it so the announcement is
  // not replayed. The text stays a short status: the answer and its sources
  // render outside this live region.
  const [answerReadyThreadId, setAnswerReadyThreadId] = useState(null);
  const answerWatchRef = useRef(null);
  const [historyOpen, setHistoryOpen] = useDeviceParityState("assistant.historyOpen", false);
  const [activeThreadId, setActiveThreadId] = useDeviceParityState("assistant.activeThreadId", threads[0]?.id || null);
  // New chat can keep the same null thread id, so identity alone cannot
  // invalidate an in-flight reply after the member leaves its conversation.
  const conversationGeneration = useRef(0);
  useEffect(() => {
    if (!searchTarget?.guideThreadId) return;
    conversationGeneration.current += 1;
    setActiveThreadId(searchTarget.guideThreadId);
    setHistoryOpen(false);
    setError("");
    setDegraded(null);
  }, [searchTarget, setActiveThreadId, setHistoryOpen]);
  // A hand-off can arrive while the sheet is ALREADY open (desktop keeps the
  // page interactive beside the panel — Be heard's Send, Voting's poll
  // suggestion). useState only reads the prop on mount, so without this sync
  // the new draft would vanish while the sender screen reports success.
  // Gated on non-empty so App clearing its draft state on close never wipes
  // whatever the member is typing.
  useEffect(() => {
    if (initialDraft) setDraft(initialDraft);
  }, [initialDraft, setDraft]);
  // Keyboard tracking for the bottom sheet. Browsers that honor
  // interactive-widget=resizes-content shrink the layout viewport (and dvh)
  // themselves; iOS Safari does not, so the sheet reads the visualViewport
  // and lifts its own bottom edge by --keyboard-inset instead. Position, never
  // transform: the sheet is anchored with bottom/inset, so no translateY is
  // ever involved in keyboard handling.
  const sheetRef = useRef(null);
  const returnFocusRef = useRef(typeof document === "undefined" ? null : document.activeElement);
  // Modal isolation only in takeover mode: the desktop panel deliberately
  // leaves the page interactive beside it. The rail is never inerted.
  // #7700: on desktop and tablet, focus still moves into the question box,
  // and a control fully covered by the panel leaves the tab order.
  useModalIsolation(sheetRef, { active: takeover });
  useCompassDesktopFocus(sheetRef, { active: !takeover });
  useEffect(() => {
    if (takeover) sheetRef.current?.focus();
  }, [takeover]);
  useEffect(() => {
    const opener = returnFocusRef.current;
    const generation = ++assistantFocusGeneration;
    let timer = 0;
    return () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (generation !== assistantFocusGeneration) return;
        if (typeof document === "undefined") return;
        if (opener?.isConnected && opener !== document.body && opener !== document.documentElement) opener.focus();
        else document.getElementById("main-content")?.focus();
      }, 0);
    };
  }, []);
  // The shared Escape stack decides who answers: in takeover mode the sheet
  // is a modal layer, so a dialog or palette opened above it wins the key and
  // the sheet (and its unsent draft) stays untouched; on the non-modal rail
  // panel it only receives Escape when no modal layer is registered. App
  // passes a fresh inline onClose each render, so the layer reads it through
  // a ref: re-registering would move the sheet above a palette opened later.
  // Register before paint: the committed panel can already receive keyboard
  // input while passive effects are still waiting to run.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useLayoutEffect(() => registerEscapeLayer(() => {
    onCloseRef.current();
    return undefined;
  }, { modal: takeover }), [takeover]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const sheet = sheetRef.current;
    if (!viewport || !sheet) return undefined;
    const update = () => {
      // Pinch-zoom also shrinks visualViewport.height — with no keyboard in
      // sight. Treat a zoomed viewport as keyboard-closed rather than launch
      // the sheet up the screen for exactly the users who zoom.
      const zoomed = viewport.scale > 1.01;
      const keyboard = zoomed
        ? 0
        : Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      sheet.style.setProperty("--keyboard-inset", `${Math.round(keyboard)}px`);
      // iOS pans the visual viewport when the keyboard opens; a takeover
      // pinned to layout-coordinate 0 would leave its header above the
      // visible area, so the top edge follows offsetTop (sol Medium on
      // f13e07ba3).
      sheet.style.setProperty("--viewport-top", `${Math.round(zoomed ? 0 : viewport.offsetTop)}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const threadUnavailable = Boolean(searchTarget?.guideThreadId === activeThreadId && activeThreadId && !activeThread && !historyLoading);
  const visibleMessages = activeThread?.messages || [];
  // Self-cancelling echo: the moment the saved exchange arrives in `threads`
  // the persisted copy of the question renders, so the echo must stop — even
  // when the snapshot and the resolve land in different React batches, which
  // is why clearing `pending` in finally alone is not enough.
  // The echo is also scoped to the thread it was sent from (sol finding,
  // 2026-08-08): New Chat and history switching stay enabled while a request
  // is in flight, and an unscoped echo would follow the member into the other
  // conversation — suppressing the starter rows there and faking a message
  // that thread never held.
  const pendingThreadRef = useRef(null);
  const pendingEcho = pending
    && (activeThreadId ?? null) === pendingThreadRef.current
    && !visibleMessages.some((message) => message.role === "user" && message.body === pending) ? pending : "";
  // Pin the conversation to its newest entry: the send echo, the typing
  // line and the saved answer all land below the fold of a filled sheet, and
  // without this the member reads a stale exchange while the reply renders
  // off-screen. Two guards keep the pin polite: a member who scrolled up to
  // read history is only pulled down by their OWN send (the echo), never by
  // a late answer landing; and smooth animation is skipped on first paint,
  // thread switches (animating a whole conversation reads as replay) and
  // under prefers-reduced-motion — scrollTo's behavior argument is not
  // covered by the CSS reduced-motion rule, so the check must live here.
  const chatRef = useRef(null);
  const chatSettledRef = useRef(false);
  const lastThreadRef = useRef(activeThreadId);
  const nearBottomRef = useRef(true);
  const scrolledSearchTargetRef = useRef(null);
  useEffect(() => {
    const chat = chatRef.current;
    if (!chat) return;
    const threadSwitched = lastThreadRef.current !== activeThreadId;
    lastThreadRef.current = activeThreadId;
    const fresh = !chatSettledRef.current || threadSwitched;
    chatSettledRef.current = true;
    if (searchTarget?.guideThreadId === activeThreadId && searchTarget.messageId && scrolledSearchTargetRef.current !== searchTarget) {
      const match = Array.from(chat.querySelectorAll("[data-guide-message-id]"))
        .find((element) => element.dataset.guideMessageId === searchTarget.messageId);
      if (match) {
        scrolledSearchTargetRef.current = searchTarget;
        match.scrollIntoView?.({ block: "center", behavior: "auto" });
        nearBottomRef.current = false;
        return;
      }
    }
    if (!fresh && !pendingEcho && !nearBottomRef.current) return;
    const reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const behavior = fresh || reduceMotion ? "auto" : "smooth";
    nearBottomRef.current = true;
    if (typeof chat.scrollTo === "function") chat.scrollTo({ top: chat.scrollHeight, behavior });
    else chat.scrollTop = chat.scrollHeight;
  }, [visibleMessages.length, pendingEcho, busy, error, degraded, paused, activeThreadId, searchTarget]);
  useEffect(() => {
    if (answerReadyThreadId && answerReadyThreadId !== activeThreadId) setAnswerReadyThreadId(null);
  }, [activeThreadId, answerReadyThreadId]);
  // Announce only after this send's new assistant message is on screen and
  // the waiting status has cleared. A thread switch, a stale generation, or
  // an error, pause or degraded reply drops the watch instead.
  useEffect(() => {
    const watch = answerWatchRef.current;
    if (!watch || watch.generation !== conversationGeneration.current) {
      answerWatchRef.current = null;
      return;
    }
    const threadId = watch.adoptedThreadId || watch.originThreadId;
    // The member left this conversation. Drop the watch so coming back to a
    // saved transcript does not announce it as a new completion.
    if (threadId && activeThreadId !== threadId) {
      answerWatchRef.current = null;
      return;
    }
    if (!threadId || busy || pending) return;
    if (error || paused || degraded) {
      answerWatchRef.current = null;
      return;
    }
    const fresh = visibleMessages.some((message) => message.role === "assistant" && !watch.knownIds.includes(String(message.id)));
    if (!fresh) return;
    answerWatchRef.current = null;
    setAnswerReadyThreadId(threadId);
  }, [visibleMessages, busy, pending, error, paused, degraded, activeThreadId]);
  function submit(event) {
    return runBusyWrite(busyWriteRef, "assistant", () => submitNow(event), event);
  }

  async function submitNow(event) {
    event.preventDefault();
    const question = draft.trim();
    // A second Enter while the model is answering bills a second completion
    // and saves a duplicate exchange to the thread.
    if (!question || busy || paused || threadUnavailable) return;
    setError("");
    setDegraded(null);
    setAnswerReadyThreadId(null);
    setBusy(true);
    setPending(question);
    pendingThreadRef.current = activeThreadId ?? null;
    const sentGeneration = conversationGeneration.current;
    answerWatchRef.current = {
      generation: sentGeneration,
      originThreadId: activeThreadId ?? null,
      adoptedThreadId: null,
      knownIds: visibleMessages.filter((message) => message.role === "assistant").map((message) => String(message.id)),
    };
    const dropAnswerWatch = () => {
      if (answerWatchRef.current?.generation === sentGeneration) answerWatchRef.current = null;
    };
    try {
      const threadId = await onSend(question, activeThreadId, visibleMessages, numbersActive ? { mode: "staff_data" } : pageActive ? { page: pageHelp.key } : undefined);
      if (sessionOperation && !sessionOperation.isCurrent()) { dropAnswerWatch(); return; }
      if (sentGeneration !== conversationGeneration.current) { dropAnswerWatch(); return; }
      if (answerWatchRef.current?.generation === sentGeneration) {
        answerWatchRef.current.adoptedThreadId = threadId || activeThreadId || null;
      }
      // Adopting the created thread must carry the echo's scope with it, or
      // the echo vanishes for the gap between the id landing and the saved
      // exchange arriving in `threads`.
      if (threadId) { pendingThreadRef.current = threadId; setActiveThreadId(threadId); }
      setDraft("");
    } catch (submitError) {
      dropAnswerWatch();
      if (sessionOperation && !sessionOperation.isCurrent()) return;
      // A degraded reply is not a failure to hide: the verified sources are
      // shown with a plain notice, the question stays in the composer for a
      // retry, and only the sanitized shape leaves the browser.
      if (submitError?.code === "compass_degraded" && Array.isArray(submitError.sources) && submitError.sources.length > 0) {
        if (sentGeneration !== conversationGeneration.current) return;
        captureSanitizedDiagnostic({ kind: "guide_reply_degraded", code: submitError.degraded, name: submitError?.name });
        setDegraded({ question, sources: submitError.sources, scopeNotices: submitError.scopeNotices });
        return;
      }
      // Request failures belong to the conversation that asked. A pause is
      // global, so an authoritative refusal still disables this open panel
      // even if search or history selected another conversation meanwhile.
      if (submitError?.code !== "compass_paused" && sentGeneration !== conversationGeneration.current) return;
      // Never paint submitError.message: every rejection this path can produce
      // carries an untranslated English one (guideApi's own sentences, an
      // api/guide.js curated gateway/rate-limit body, or a bare fetch
      // TypeError), so the catalogue sentence is the member's copy and only the
      // sanitized failure shape leaves the browser.
      captureSanitizedDiagnostic({ kind: "guide_reply_failure", code: submitError?.code, name: submitError?.name });
      if (submitError?.code === "compass_paused") setPaused(true);
      else if (submitError?.code === "question_withheld") setError(t("guide.errorQuestionWithheld"));
      else if (submitError?.code === "role_rate_limit") setError(t("inbox.compassBriefFailure.roleLimit"));
      else if (submitError?.code === "shared_rate_limit") setError(t("inbox.compassBriefFailure.sharedLimit"));
      else if (numbersActive && ["staff_required", "feature_disabled", "no_data_topic"].includes(submitError?.code)) setError(t(`compass.numbers.${submitError.code}`));
      else setError(t("guide.errorAnswer"));
    } finally {
      if (!sessionOperation || sessionOperation.isCurrent()) { setBusy(false); setPending(""); }
    }
  }
  return (
    /* aria-modal rides the takeover: on phones the surface covers the whole
       page, and modal ISOLATION (inert + aria-hidden on everything outside)
       is what makes the value honest — the earlier off-by-default stance was
       argued from untrapped focus, which the isolation hook now traps. On
       rail shells the panel stays nonmodal because the page really is
       interactive beside it. */
    <section ref={sheetRef} className="assistant" role="dialog" aria-label={GUIDE_NAME} aria-modal={takeover || undefined} tabIndex={-1}>
      <header>
        <button type="button" aria-label={t("guide.openConversations")} aria-pressed={historyOpen} onClick={() => setHistoryOpen((open) => !open)}><Menu size={22} /></button>
        <div><span className="eyebrow">Compass</span><strong>{activeThread?.title || t(threadUnavailable ? "guide.conversationUnavailable" : "guide.newChat")}</strong></div>
        {/* One close affordance only (owner feedback, 2026-08-05): minimize
            and close were the same onClose handler wearing two icons, and on
            the full-screen phone takeover a fake window-chrome trio read as
            desktop clutter. */}
        <div className="assistant__tools">
          <button type="button" aria-label={t("guide.newChat")} onClick={() => { conversationGeneration.current += 1; setActiveThreadId(null); setDraft(""); setError(""); setDegraded(null); setHistoryOpen(false); }}><Plus size={20} /></button>
          <button type="button" aria-label={t("guide.closeAssistant")} onClick={onClose}><X size={20} /></button>
        </div>
      </header>
      {historyOpen && <aside className="assistant-history" aria-label={t("guide.conversationHistory")}><strong>{t("guide.conversationHistory")}</strong>{threads.length ? threads.map((thread) => <button type="button" aria-pressed={thread.id === activeThreadId} key={thread.id} onClick={() => { conversationGeneration.current += 1; setActiveThreadId(thread.id); setDegraded(null); setHistoryOpen(false); }}>{thread.title}</button>) : <p>{t(demo ? "guide.noConversationsDemo" : "guide.noConversations")}</p>}</aside>}
      {/* UX-UG-COMPASS-CHAT-SCROLL-REGION-NOT-KEYBOARD-REACHABLE-20261108
          (#7472): a scrolling conversation must be reachable by keyboard
          (Axe scrollable-region-focusable). tabIndex 0 only adds a tab stop;
          nothing moves focus here, so the composer keeps it. */}
      <section className="assistant-chat" tabIndex={0} aria-label={t("guide.conversation")} ref={chatRef} onScroll={(event) => { const el = event.currentTarget; nearBottomRef.current = el.scrollHeight - el.clientHeight - el.scrollTop < 140; }}>
      {historyLoading && <p className="assistant__error" role="status">{t("guide.historyLoading")}</p>}
      {threadUnavailable && <p className="assistant__error" role="status">{t("guide.conversationUnavailable")}</p>}
      {historyError && <div className="assistant__error" role="alert">
        <p>{t("guide.historyFailed")}</p>
        <button className="dialog-primary" type="button" disabled={historyLoading} onClick={onRetryHistory}>{t("app.tryAgain")}</button>
      </div>}
        <div className="guide2-hero">
          <strong>{GUIDE_NAME} <span className="guide2-hero__badge">{t(demo ? "compass.badgeDemo" : "compass.badge")}</span></strong>
          <p>{t(demo ? "compass.subtitleDemo" : "compass.subtitle")}</p>
        </div>
        {/* REQ-UG-COMPASS-CONTEXTUAL-NUDGES-20261001: attention signals the
            server counted for this person; choosing one only fills the box. */}
        {nudges.length > 0 && (
          <div className="compass-chips compass-nudges" role="group" aria-label={t("compass.nudge.groupLabel")}>
            {nudges.map((nudge) => (
              <button type="button" key={nudge.id} className={nudge.urgent ? "compass-nudges__urgent" : undefined} disabled={paused} onClick={() => setDraft(nudge.prompt)}>
                {nudge.urgent && <AlertTriangle size={14} aria-hidden="true" />}
                {nudge.label}
              </button>
            ))}
          </div>
        )}
        {visibleMessages.length
          ? visibleMessages.map((message) => {
              return (
                /* assistant-message--* stays alongside guide2-msg--*: the
                   production e2e (scripts/browserbase-production-e2e.mjs)
                   locates answers via .assistant-message--assistant. All
                   styling now lives on the guide2- classes. */
                <article className={`assistant-message assistant-message--${message.role} guide2-msg guide2-msg--${message.role}`} key={message.id} data-guide-message-id={message.id}>
                  <span className="visually-hidden">{message.role === "assistant" ? "Compass" : t("guide.you")}</span>
                  {message.role === "assistant"
                    ? <div className="guide2-msg__bubble"><p>{message.body}</p></div>
                    : <p>{message.body}</p>}
                  {message.role === "assistant" && <CompassSourceList sources={message.sources} articles={sourceArticles} onOpen={onOpenSource} />}
                  {/* REQ-UG-COMPASS-ACTION-OFFERS-20261001: offers only on a
                      saved answer; pinning needs its persisted id. */}
                  {answerActions && message.role === "assistant" && (
                    <CompassAnswerActions message={message} actions={SAVED_ANSWER_ID.test(String(message.id)) ? answerActions : { ...answerActions, pin: null }} />
                  )}
                </article>
              );
            })
          : pendingEcho || degraded || threadUnavailable ? null : (
            <>
              <p className="assistant-empty">{t("guide.askPrompt")}</p>
              <small>{t(demo ? "guide.aiNoticeDemo" : "guide.aiNotice")}</small>
              {/* Starters fill the composer draft, never auto-send: the member
                  reviews the question before it bills a completion — the same
                  contract as the chip rail. */}
              {starterRows.length > 0 && <div className="compass-starters" role="group" aria-label={t("compass.chipsLabel")}>
                {starterRows.map(({ key, text, Icon }) => (
                  <button type="button" key={key} disabled={paused} onClick={() => chooseSuggestion(text)}>
                    <Icon size={18} aria-hidden="true" />
                    <span>{text}</span>
                  </button>
                ))}
              </div>}
            </>
          )}
        {pendingEcho && (
          /* guide2-msg--pending is a test/e2e hook with no paint rule: the
             echo must not dim member-typed text below an audited pair. */
          <article className="assistant-message assistant-message--user guide2-msg guide2-msg--user guide2-msg--pending">
            <span className="visually-hidden">{t("guide.you")}</span>
            <p>{pendingEcho}</p>
          </article>
        )}
        {degraded && (
          <>
            <article className="assistant-message assistant-message--user guide2-msg guide2-msg--user">
              <span className="visually-hidden">{t("guide.you")}</span>
              <p>{degraded.question}</p>
            </article>
            {/* role=status, not alert: the sources are the content, the notice
                explains why there is no answer, and neither should interrupt. */}
            <article className="assistant-message assistant-message--assistant guide2-msg guide2-msg--assistant guide2-msg--degraded" role="status">
              <span className="visually-hidden">{GUIDE_NAME}</span>
              <div className="guide2-msg__bubble"><p>{t("guide.degradedNotice")}</p>{degraded.scopeNotices?.map((notice) => <p key={notice}>{notice}</p>)}</div>
              <CompassSourceList sources={degraded.sources} articles={sourceArticles} onOpen={onOpenSource} />
            </article>
          </>
        )}
        {busy && <p className="guide2-typing" role="status">{t("compass.thinking")}</p>}
        {error && <p className="assistant__error" role="alert">{error}</p>}
        {paused && <p className="assistant__error" role="status">{t("compass.pausedNotice")}</p>}
      </section>
      {/* Always present, including after a thread starts: the member should
          not have to abandon an active conversation to discover the provider
          boundary or the sensitive-data warning. */}
      <p className="compass-disclosure-note">
        <span>{t("guide.safetyNotice")}</span>{" "}
        <a href="/ai-disclosure" target="_blank" rel="noreferrer">{t("compass.providerDisclosure")}</a>
      </p>
      {answerReadyThreadId && answerReadyThreadId === activeThreadId && (
        <p className="visually-hidden" role="status" aria-live="polite">{t("compass.answerReady")}</p>
      )}
      <form className="guide2-composer" onSubmit={submit}>
        {/* Chip rail only once a conversation exists — a fresh chat carries
            the same suggestions as starter rows in the thread area instead,
            so the two shapes never stack. */}
        {(visibleMessages.length > 0 || pendingEcho) && chipTexts.length > 0 && (
          <div className="compass-chips" role="group" aria-label={t("compass.chipsLabel")}>
            {chipTexts.map((text) => <button type="button" key={text} disabled={paused} onClick={() => chooseSuggestion(text)}>{text}</button>)}
          </div>
        )}
        {(staffDataAvailable || pageHelp?.key) && (
          <div className="compass-chips compass-mode" role="group" aria-label={t("compass.numbers.groupLabel")}>
            {pageHelp?.key && !numbersActive && (
              <button type="button" aria-pressed={pageActive} disabled={paused} onClick={() => setPageOn((on) => !on)}>
                {t("compass.page.toggle", { page: pageHelp.label })}
              </button>
            )}
            {staffDataAvailable && (
              <button type="button" aria-pressed={numbersActive} disabled={paused} onClick={() => setNumbersMode((on) => !on)}>
                {t("compass.numbers.toggle")}
              </button>
            )}
            {numbersActive && <span className="compass-mode__note">{t("compass.numbers.note")}</span>}
          </div>
        )}
        <div className="guide2-composer__row">
          {/* 16px font is load-bearing: it keeps iOS Safari from zooming the
              sheet when the input focuses. */}
          <input className="guide2-input" type="text" name="compass-question" autoComplete="off" aria-label={t("compass.askAria")} value={draft} disabled={paused} onChange={(event) => setDraft(event.target.value)} placeholder={t(COMPASS_PLACEHOLDER_KEYS[suggestedQuestionRole(hat)])} />
          <BusyButton type="submit" className="guide2-send" aria-label={t("guide.send")} aria-busy={busy || undefined} pending={busy} disabled={!draft.trim() || paused || threadUnavailable}><ArrowUp size={20} aria-hidden="true" /></BusyButton>
        </div>
      </form>
    </section>
  );
}
