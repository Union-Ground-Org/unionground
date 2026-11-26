import { useCallback, useEffect, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { engagementApi } from "./api.js";
import {
  isProductPulseContext,
  markPulseSessionUsed,
  normalizePulseDecision,
  pulseDecisionEndsSession,
  pulseSessionKey,
  pulseSessionUsed,
  pulseSettings,
  pulseThresholdMet,
  scrollPercentOf,
} from "./contextualPulse.js";
import { optionLabel, optionValue } from "./surveyModel.js";
import "./engagement.css";
import { BusyButton } from "../../components/BusyControls.jsx";

// REQ-UG-CONTEXTUAL-PULSE-PRODUCT-TRIGGERS-20261001 (CR-014): the web
// half of the reading-screen quick check (old components/contextual-pulse/
// contextual-pulse-slot.tsx and contextual-pulse-card.tsx at de7df4b57c^).

function sessionStorageOrNull() {
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

// The nearest scrolled ancestor (a dialog body, a panel), else the page.
function scrollSurface(node) {
  for (let element = node?.parentElement ?? null; element; element = element.parentElement) {
    const style = globalThis.getComputedStyle?.(element);
    if (style && /(auto|scroll)/.test(style.overflowY || "") && element.scrollHeight > element.clientHeight) return element;
  }
  return null;
}

function readScrollPercent(node) {
  const surface = scrollSurface(node);
  if (surface) return scrollPercentOf({ scrollTop: surface.scrollTop, scrollHeight: surface.scrollHeight, clientHeight: surface.clientHeight });
  const root = globalThis.document?.documentElement;
  if (!root) return 0;
  return scrollPercentOf({
    scrollTop: globalThis.scrollY ?? root.scrollTop ?? 0,
    scrollHeight: root.scrollHeight,
    clientHeight: globalThis.innerHeight ?? root.clientHeight,
  });
}

function randomUUID() {
  return globalThis.crypto.randomUUID();
}

// Asks once per mount, after the dwell OR scroll threshold, unless this tab
// session already saw a quick check. The server decides eligibility.
function useContextualPulse({ client, configuration, contextKey, active = true }) {
  const { enabled, dwellSeconds: dwellLimit, scrollPercent: scrollLimit } = pulseSettings(configuration);
  const live = Boolean(client && active && enabled && isProductPulseContext(contextKey));
  const anchorRef = useRef(null);
  const [prompt, setPrompt] = useState(null);

  useEffect(() => {
    setPrompt(null);
    if (!live) return undefined;
    const storage = sessionStorageOrNull();
    if (pulseSessionUsed(storage)) return undefined;
    let cancelled = false;
    let asked = false;
    let deepest = 0;
    const document = globalThis.document;
    let foregroundMs = 0;
    let foregroundStartedAt = document?.hidden ? null : Date.now();
    const dwellTime = () => foregroundMs + (foregroundStartedAt === null ? 0 : Date.now() - foregroundStartedAt);
    let timer = 0;
    const stop = () => {
      globalThis.clearInterval(timer);
      document?.removeEventListener("scroll", check, true);
      document?.removeEventListener("visibilitychange", onVisibilityChange);
    };
    function onVisibilityChange() {
      if (document.hidden) {
        if (foregroundStartedAt !== null) foregroundMs += Date.now() - foregroundStartedAt;
        foregroundStartedAt = null;
      } else if (foregroundStartedAt === null) {
        foregroundStartedAt = Date.now();
      }
      if (!document.hidden) check();
    }
    function check() {
      if (asked || cancelled || document?.hidden) return;
      const dwellSeconds = Math.floor(dwellTime() / 1000);
      deepest = Math.max(deepest, readScrollPercent(anchorRef.current));
      if (!pulseThresholdMet({ dwellSeconds, scrollPercent: deepest }, { dwellSeconds: dwellLimit, scrollPercent: scrollLimit })) return;
      asked = true;
      stop();
      const sessionKey = pulseSessionKey(storage, randomUUID);
      engagementApi.evaluatePulseInContext(client, contextKey, sessionKey, dwellSeconds, deepest).then((value) => {
        const decision = normalizePulseDecision(value);
        if (pulseDecisionEndsSession(decision)) markPulseSessionUsed(storage);
        if (!cancelled && decision.eligible) setPrompt(decision.prompt);
      }).catch(() => {});
    }
    timer = globalThis.setInterval(check, 1000);
    // Scroll events do not bubble; a capturing listener hears the page and
    // any scrolled panel or dialog body.
    document?.addEventListener("scroll", check, { capture: true, passive: true });
    document?.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      stop();
    };
  }, [client, contextKey, dwellLimit, scrollLimit, live]);

  const clear = useCallback(() => setPrompt(null), []);
  return { prompt, anchorRef, clear };
}

// `pulse` is { client, configuration }: the member's session client (null in
// fixture previews, which never ask) and get_member_organization_configuration().
export function ContextualPulseSlot({ pulse = null, contextKey, active = true, className = "" }) {
  const { t } = useLang();
  const client = pulse?.client ?? null;
  const { prompt, anchorRef, clear } = useContextualPulse({ client, configuration: pulse?.configuration ?? null, contextKey, active });
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState("");
  const busyRef = useRef(false);

  async function respond(value, dismiss = false) {
    if (!prompt || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setState("");
    try {
      await engagementApi.respondPulse(client, prompt.eventId, dismiss ? null : value, dismiss);
      clear();
      setState(dismiss ? "dismissed" : "saved");
    } catch {
      // Keep the card so a failed write never looks like success.
      setState("failed");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return <div ref={anchorRef} className={`eng-pulse-slot${className ? ` ${className}` : ""}`} data-pulse-context={contextKey}>
    {prompt && <section className="eng-card eng-pulse" aria-labelledby={`eng-pulse-${prompt.eventId}`}>
      <span className="eng-kicker">{t("engagement.member.pulseKicker")}</span>
      <h3 id={`eng-pulse-${prompt.eventId}`}>{prompt.question}</h3>
      <div className="eng-choice-row">{prompt.options.map((option) => <BusyButton type="button" className="eng-chip" key={String(optionValue(option))} pending={busy} onClick={() => respond(optionValue(option))}>{optionLabel(option)}</BusyButton>)}</div>
      <BusyButton type="button" className="eng-link" pending={busy} onClick={() => respond(null, true)}>{t("engagement.member.notNow")}</BusyButton>
      {state === "failed" && <p className="eng-notice eng-notice--error" role="alert">{t("engagement.responseFailed")}</p>}
    </section>}
    {(state === "saved" || state === "dismissed") && <p className="eng-notice" role="status">{t(state === "saved" ? "engagement.member.responseSaved" : "engagement.member.promptDismissed")}</p>}
  </div>;
}
