import { useCallback, useEffect, useId, useRef, useState } from "react";
import { BellRing, CalendarDays, FolderKanban, Scale, Vote } from "lucide-react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { localeFor } from "../../lib/i18n.js";
import { isFeatureEnabled } from "../../lib/featureSwitches.js";
import { homeRelevantEvents } from "../../lib/homeFeed.js";
import { WELCOME_BACK_RPC, WELCOME_BACK_SWITCH, normalizeWelcomeBack, resolveWelcomeBackStep } from "./welcomeBack.js";
import "./welcomeBack.css";

// REQ-UG-REACTIVATION-WELCOME-BACK-20261001: web half. The server keeps one
// last-active date per account and nothing else; the RPC records today and
// answers whether this visit follows a long absence.
// BUG-UG-WELCOME-BACK-ACTIVITY-CACHE-20261002: two separate caches.
//   * Display and dismissal live in sessionStorage per account and
//     organization, so a dismissed welcome stays dismissed for the visit.
//   * The activity mark lives in localStorage as the UTC day it was last sent,
//     so activity is recorded at most once per day, and a tab left open across
//     days records again (and evaluates the return) when it regains focus.
function sessionKey(userId, organizationId) {
  return userId ? `ug-home-return:v2:${userId}:${organizationId || "none"}` : null;
}

function activityKey(userId, organizationId) {
  return userId ? `ug-home-return:v2:active:${userId}:${organizationId || "none"}` : null;
}

function welcomeBackDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function readStore(store, key) {
  try { return key ? window[store].getItem(key) : null; } catch { return null; }
}

function writeStore(store, key, value) {
  try { if (key) window[store].setItem(key, value); } catch { /* the decision stays in memory */ }
}

// The calendar day as state, refreshed whenever the tab becomes visible or
// focused again, so a long-lived tab notices a new day without a reload.
function useCurrentDay() {
  const [day, setDay] = useState(() => welcomeBackDay());
  useEffect(() => {
    const refresh = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      setDay(welcomeBackDay());
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return day;
}

export function useWelcomeBack({ data, transport = null }) {
  const enabled = isFeatureEnabled(data?.organizationConfiguration, WELCOME_BACK_SWITCH, true);
  const preview = transport?.preview === true;
  // A shared demo persona is one account behind every visitor to the sample
  // site, so its "last active" date says nothing about a return. Its Home
  // records no activity and shows no welcome back.
  const sharedDemoPersona = transport?.sharedDemoPersona === true;
  const accessToken = typeof transport?.session?.access_token === "string" ? transport.session.access_token : null;
  const createSessionClient = typeof transport?.createSessionClient === "function" ? transport.createSessionClient : null;
  const memberId = data?.member?.id ?? null;
  const organizationId = data?.member?.organizationId ?? null;
  const key = sessionKey(memberId, organizationId);
  const markKey = activityKey(memberId, organizationId);
  const day = useCurrentDay();
  const [state, setState] = useState(() => readStore("sessionStorage", key));
  const asked = useRef(null);
  // A same-member token refresh must not cancel the request already in flight
  // (BUG-UG-WELCOME-BACK-PENDING-REFRESH-20261020): the effect depends
  // on whether a session exists, not on which access token it carries, and
  // reads the current token and client factory when it fires. A change of
  // member, organization or day still ends the request and drops its answer.
  const hasSession = Boolean(accessToken && createSessionClient);
  const sessionRef = useRef({ accessToken, createSessionClient });
  sessionRef.current = { accessToken, createSessionClient };

  useEffect(() => {
    setState(readStore("sessionStorage", key));
    if (!enabled || preview || sharedDemoPersona || !key || !hasSession) return undefined;
    const attempt = `${key}:${day}`;
    if (readStore("localStorage", markKey) === day || asked.current === attempt) return undefined;
    asked.current = attempt;
    let active = true;
    let client;
    try { client = sessionRef.current.createSessionClient({ access_token: sessionRef.current.accessToken }); } catch { client = null; }
    if (!client || typeof client.rpc !== "function") return undefined;
    // One attempt per day, answered or not, claimed before the request so a
    // second tab or Home instance never records the same day again.
    writeStore("localStorage", markKey, day);
    const settle = (welcome) => {
      // A new welcome replaces an earlier dismissal; otherwise the visit's own
      // display state (including an undismissed welcome) is kept.
      const decision = welcome ? "welcome" : readStore("sessionStorage", key) || "seen";
      writeStore("sessionStorage", key, decision);
      if (active) setState(decision);
    };
    Promise.resolve(client.rpc(WELCOME_BACK_RPC))
      .then((result) => settle(!result?.error && normalizeWelcomeBack(result?.data).welcomeBack))
      .catch(() => settle(false));
    return () => { active = false; };
  }, [enabled, preview, sharedDemoPersona, key, markKey, day, hasSession]);

  const dismiss = useCallback(() => {
    writeStore("sessionStorage", key, "seen");
    setState("seen");
  }, [key]);
  return { show: enabled && !preview && !sharedDemoPersona && state === "welcome", dismiss };
}

export function welcomeBackInputs(data, now = new Date()) {
  const broadcasts = (data?.broadcasts ?? []).filter((item) => item?.unread);
  const newest = [...broadcasts].sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0))[0];
  return {
    unreadUpdates: (Number(data?.member?.notificationCount) || 0) + broadcasts.length,
    newestUpdateTitle: newest?.title ?? null,
    openPolls: (data?.planItems ?? [])
      .filter((item) => (item?.kind === "ballot" || item?.kind === "pulse") && !item.closed && !item.receiptCode && !item.selectedOption)
      .map((item) => ({ id: item.id, title: item.title })),
    events: homeRelevantEvents(data)
      .filter((item) => item?.isPast !== true && !item?.cancelledAt)
      .map((item) => ({ id: item.id, title: item.title, startsAt: item.startsAt })),
    activeCases: (data?.cases ?? []).filter((item) => item?.status === "active"),
    now,
  };
}

const STEP_ICONS = { updates: BellRing, poll: Vote, event: CalendarDays, case: FolderKanban, resources: Scale };

// The calm single screen the old ReactivationHero rendered instead of the full
// dashboard: three short facts and ONE picked next step, plus an honest way
// to the full Home.
export function WelcomeBackScreen({ data, onDismiss, onOpenUpdates, onVote, onOpenEvents, onOpenCase, onOpenRights }) {
  const { t, lang } = useLang();
  const titleId = useId();
  const headingRef = useRef(null);
  useEffect(() => { headingRef.current?.focus(); }, []);
  const inputs = welcomeBackInputs(data);
  const step = resolveWelcomeBackStep(inputs);
  const nextEvent = inputs.events[0] ?? null;
  const name = data?.member?.firstName?.trim() || t("welcomeBack.friend");
  const when = (value) => new Date(value).toLocaleDateString(localeFor(lang), { weekday: "short", month: "short", day: "numeric" });

  const pollItem = step.kind === "poll" ? (data?.planItems ?? []).find((item) => String(item.id) === step.id) : null;
  const actions = {
    updates: onOpenUpdates ? { label: step.count === 1 ? t("welcomeBack.ctaUpdatesOne") : t("welcomeBack.ctaUpdates", { count: step.count }), detail: step.title ? t("welcomeBack.detailUpdatesTitle", { title: step.title }) : t("welcomeBack.detailUpdates"), run: onOpenUpdates } : null,
    poll: onVote && pollItem ? { label: t("welcomeBack.ctaPoll"), detail: step.title, run: () => onVote(pollItem) } : null,
    event: onOpenEvents ? { label: t("welcomeBack.ctaEvent"), detail: t("welcomeBack.detailEvent", { title: step.title, date: step.startsAt ? when(step.startsAt) : "" }), run: () => onOpenEvents() } : null,
    case: onOpenCase ? { label: t("welcomeBack.ctaCase", { reference: step.reference || t("welcomeBack.caseFallback") }), detail: t("welcomeBack.detailCase"), run: () => onOpenCase(step.id) } : null,
    resources: onOpenRights ? { label: t("welcomeBack.ctaResources"), detail: t("welcomeBack.detailResources"), run: onOpenRights } : null,
  };
  const action = actions[step.kind];
  const StepIcon = STEP_ICONS[step.kind] ?? Scale;
  const takeStep = () => { onDismiss(); action?.run(); };

  return (
    <section className="welcome-back" aria-labelledby={titleId}>
      <p className="welcome-back__eyebrow">{t("welcomeBack.eyebrow")}</p>
      <h1 id={titleId} ref={headingRef} tabIndex={-1}>{t("welcomeBack.title", { name })}</h1>
      <p className="welcome-back__lede">{t("welcomeBack.lede")}</p>
      <ul className="welcome-back__facts">
        <li>
          <strong>{inputs.unreadUpdates === 1 ? t("welcomeBack.factUpdatesOne") : t("welcomeBack.factUpdates", { count: inputs.unreadUpdates })}</strong>
          <span>{inputs.newestUpdateTitle ? t("welcomeBack.factUpdatesNewest", { title: inputs.newestUpdateTitle }) : t("welcomeBack.factUpdatesBody")}</span>
        </li>
        <li>
          <strong>{nextEvent ? t("welcomeBack.factActiveTitle") : t("welcomeBack.factMovingTitle")}</strong>
          <span>{nextEvent
            ? t("welcomeBack.factActiveEvent", { title: nextEvent.title, date: when(nextEvent.startsAt) })
            : inputs.openPolls[0]
              ? t("welcomeBack.factActivePoll", { title: inputs.openPolls[0].title })
              : t("welcomeBack.factMovingBody")}</span>
        </li>
        <li>
          <strong>{t("welcomeBack.factBenefitsTitle")}</strong>
          <span>{t("welcomeBack.factBenefitsBody")}</span>
        </li>
      </ul>
      <div className="welcome-back__step">
        <span className="welcome-back__step-icon" aria-hidden="true"><StepIcon size={20} /></span>
        <div>
          <strong>{t("welcomeBack.stepTitle")}</strong>
          <p>{action?.detail ?? t("welcomeBack.detailResources")}</p>
        </div>
      </div>
      <div className="welcome-back__actions">
        {action ? <button type="button" className="welcome-back__primary" onClick={takeStep}>{action.label}</button> : null}
        <button type="button" className="welcome-back__secondary" onClick={onDismiss}>{t("welcomeBack.showHome")}</button>
      </div>
    </section>
  );
}
