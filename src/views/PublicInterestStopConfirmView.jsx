import { useCallback, useEffect, useRef, useState } from "react";
import { BrandMark } from "../components/BrandMark.jsx";
import { BusyButton } from "../components/BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { isDemoHost } from "../lib/demoOrigin.js";
import { useLang } from "../lib/LanguageContext.jsx";

// SEC-UG-PUBLIC-INTEREST-SUPPRESSION-CONFIRMATION-20260921 (owner ruling
// 2026-09-25, SINGLE-USE EMAIL CONFIRMATION). The emailed "stop public
// updates" link lands here as `/stop-updates#confirm=<token>`: fragment-only
// delivery, the same discipline as /invite, so the secret never reaches a
// server log, a referrer or the query string. The page scrubs the URL before
// anything paints, posts the token once to the same-origin confirm endpoint,
// and reports one of three outcomes. Nothing is suppressed until that post
// succeeds; an unknown, expired or already-used link reads the same.
const STOP_CONFIRMATION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function takeFragmentSecret() {
  const hadQuery = Boolean(window.location.search);
  const fragment = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
  window.history.replaceState(window.history.state, "", "/stop-updates");
  if (hadQuery) return null;
  const params = new URLSearchParams(fragment);
  if ([...params.keys()].length !== 1 || !params.has("confirm")) return null;
  const token = params.get("confirm") || "";
  return STOP_CONFIRMATION_TOKEN.test(token) ? token : null;
}

export function PublicInterestStopConfirmView({ fetcher = (...args) => fetch(...args) }) {
  const { t, lang } = useLang();
  const started = useRef(false);
  const secret = useRef(null);
  const messageRef = useRef(null);
  const [state, setState] = useState("checking");
  const [requestState, setRequestState] = useState("idle");
  const requestLock = useRef(new Set());
  const requestResultRef = useRef(null);

  const confirm = useCallback(async () => {
    if (!secret.current) {
      setState("unavailable");
      return;
    }
    setState("checking");
    try {
      const response = await fetcher("/api/public-interest-stop-confirm", {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: secret.current }),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 410) {
        secret.current = null;
        setState("unavailable");
        return;
      }
      if (!response.ok || payload?.confirmed !== true) {
        setState("retry");
        return;
      }
      secret.current = null;
      setState("confirmed");
    } catch {
      setState("retry");
    }
  }, [fetcher]);

  useEffect(() => {
    // Strict Mode replays effects; the ref keeps the fragment consumption and
    // the single-use post single-shot within that replay.
    if (started.current) return;
    started.current = true;
    secret.current = takeFragmentSecret();
    confirm();
  }, [confirm]);

  useEffect(() => {
    if (["retry", "unavailable"].includes(state)) messageRef.current?.focus();
  }, [state]);

  useEffect(() => {
    if (requestState === "sent") requestResultRef.current?.focus();
  }, [requestState]);

  function requestNewLink(event) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    return runBusyWrite(requestLock, "stop-link", async () => {
      setRequestState("submitting");
      try {
        const response = await fetcher("/api/public-interest-stop", {
          method: "POST",
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: String(fields.get("email") || "").trim().toLowerCase(),
            locale: lang,
            website: String(fields.get("website") || "").trim(),
          }),
        });
        const payload = await response.json();
        setRequestState(response.ok && payload?.accepted === true ? "sent" : "error");
      } catch {
        setRequestState("error");
      }
    }, event);
  }

  const failed = state === "retry" || state === "unavailable";
  const requestAvailable = state === "unavailable" && !isDemoHost(globalThis.location?.hostname);
  const requested = requestState === "sent";
  return (
    <main className="auth-screen iac-screen">
      <section className="auth-card iac-card" aria-labelledby="stop-confirm-title">
        <span className="iac-brand"><BrandMark size={40} /></span>
        <span className="eyebrow">{t("stopConfirm.eyebrow")}</span>
        <h1 id="stop-confirm-title" className="iac-title">{t("stopConfirm.title")}</h1>
        {!failed && (
          <div className="iac-state" role="status" aria-live="polite">
            <span className="iac-glyph" aria-hidden="true">{state === "confirmed" ? "✓" : "↻"}</span>
            <h2>{t(state === "confirmed" ? "stopConfirm.confirmed" : "stopConfirm.checking")}</h2>
            <p>{t(state === "confirmed" ? "stopConfirm.confirmedBody" : "stopConfirm.checkingBody")}</p>
            {state === "confirmed" && <a className="iac-action" href="/">{t("stopConfirm.back")}</a>}
          </div>
        )}
        {requested && (
          <div ref={requestResultRef} className="iac-state" role="status" tabIndex="-1">
            <h2>{t("landing.interestStopSuccessTitle")}</h2>
            <p>{t("landing.interestStopSuccessBody")}</p>
            <a className="iac-back" href="/">{t("stopConfirm.back")}</a>
          </div>
        )}
        {failed && !requested && (
          <div ref={messageRef} className="iac-state" role="alert" tabIndex="-1">
            <span className="iac-glyph" aria-hidden="true">!</span>
            <h2>{t(state === "unavailable" ? "stopConfirm.unavailable" : "stopConfirm.retryTitle")}</h2>
            <p>{t(state === "unavailable" ? "stopConfirm.unavailableBody" : "stopConfirm.retryBody")}</p>
            {state === "retry" && <button type="button" className="iac-action" onClick={confirm}>{t("stopConfirm.retry")}</button>}
            {requestAvailable && (
              <form className="rqi-form" onSubmit={requestNewLink} aria-busy={requestState === "submitting"}>
                <label>
                  <span>{t("landing.interestStopEmail")}</span>
                  <input name="email" type="email" autoComplete="email" required maxLength={254} />
                </label>
                <label className="rqi-trap" hidden>
                  Website
                  <input name="website" autoComplete="off" tabIndex={-1} />
                </label>
                {requestState === "error" && <p className="rqi-error" role="status">{t("landing.interestStopError")}</p>}
                <BusyButton className="iac-action" type="submit" pending={requestState === "submitting"}>
                  {t(requestState === "submitting" ? "stopConfirm.requesting" : "stopConfirm.requestNew")}
                </BusyButton>
              </form>
            )}
            <a className="iac-back" href="/">{t("stopConfirm.back")}</a>
          </div>
        )}
        <p className="iac-legal">{t("stopConfirm.legalNotice")} <a href="/privacy">{t("hub.privacy")}</a></p>
      </section>
    </main>
  );
}
