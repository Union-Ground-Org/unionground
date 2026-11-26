import { Mail } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { runBusyWrite } from "../lib/busyWrite.js";
import { BrandMark } from "../components/BrandMark.jsx";
import { ResidenceAgeFields } from "../components/ResidenceAgeFields.jsx";
import { missingSentences } from "../components/LegalAcceptancePrompt.jsx";
import { BusyButton } from "../components/BusyControls.jsx";
import { isResidenceRegion } from "../lib/residenceRegions.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { loadTurnstile, requestOpenSignup, TURNSTILE_ACTION, TURNSTILE_SITE_KEY } from "../lib/openSignup.js";

const FAILURE_KEYS = {
  unavailable: "signup.serviceUnavailable",
  invalid: "signup.invalid",
  error: "signup.error",
};

export function SignupUnavailable() {
  const { t } = useLang();
  return (
    <main className="auth-screen">
      <div className="sgauth-column">
        <section className="auth-card" aria-labelledby="signup-unavailable-title">
          <span className="iac-brand"><BrandMark size={40} /></span>
          <h1 id="signup-unavailable-title">{t("signup.unavailableTitle")}</h1>
          <p>{t("signup.unavailableBody")}</p>
          <a className="auth-submit auth-submit--link" href="/auth">{t("signup.signIn")}</a>
          <p className="sgauth-recovery"><a href="/request-invite">{t("requestInvite.link")}</a></p>
        </section>
      </div>
    </main>
  );
}

// /signup: email, terms, Turnstile and a hidden honeypot. Every accepted
// request shows the same "check your email" answer whether or not a link was
// sent, so this page never tells anyone whether an address has an account.
export function OpenSignupView({
  available,
  siteKey = TURNSTILE_SITE_KEY,
  fetcher = (...args) => fetch(...args),
  loadWidget = loadTurnstile,
}) {
  const { t, lang } = useLang();
  const widgetRef = useRef(null);
  const busyWriteRef = useRef(new Set());
  const widgetApi = useRef(null);
  const widgetId = useRef(null);
  const [email, setEmail] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  // The signup API takes the stated residence and the age statement it
  // selects, as invitation acceptance does (ResidenceAgeFields).
  const [residenceState, setResidenceState] = useState("");
  const [ageAttested, setAgeAttested] = useState(false);
  const [website, setWebsite] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [widgetFailed, setWidgetFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState("");
  const [checkExpired, setCheckExpired] = useState(false);

  useEffect(() => {
    if (!available) return undefined;
    // A new widget (first load or a language change) starts a fresh check.
    setTurnstileToken("");
    setCheckExpired(false);
    setWidgetFailed(false);
    let cancelled = false;
    loadWidget().then((api) => {
      if (cancelled || !widgetRef.current) return;
      widgetApi.current = api;
      widgetId.current = api.render(widgetRef.current, {
        sitekey: siteKey,
        action: TURNSTILE_ACTION,
        language: lang,
        callback: (token) => { if (!cancelled) { setTurnstileToken(String(token || "")); setWidgetFailed(false); setCheckExpired(false); } },
        "expired-callback": () => { if (!cancelled) { setTurnstileToken(""); setCheckExpired(true); } },
        "error-callback": () => { if (!cancelled) { setTurnstileToken(""); setWidgetFailed(true); } },
      });
    }).catch(() => { if (!cancelled) setWidgetFailed(true); });
    return () => {
      cancelled = true;
      if (widgetId.current !== null) widgetApi.current?.remove?.(widgetId.current);
      widgetId.current = null;
    };
  }, [available, lang, loadWidget, siteKey]);

  if (!available) return <SignupUnavailable />;

  async function submit(event) {
    event.preventDefault();
    // The button stays focusable (aria-disabled with its reason), so a submit
    // still arrives here while anything is missing: send nothing then.
    if (busy || !canSubmit) return;
    return runBusyWrite(busyWriteRef, "signup", async (release) => {
      setBusy(true);
      try {
        setFailure("");
        const outcome = await requestOpenSignup(fetcher, {
          email: email.trim(),
          locale: lang,
          turnstileToken,
          acceptedTerms,
          residenceState,
          ageAttested,
          website,
        });
        if (outcome === "accepted") {
          setSent(true);
          return;
        }
        // A Turnstile token is single use; ask for a fresh one before a retry.
        setTurnstileToken("");
        if (widgetId.current !== null) widgetApi.current?.reset?.(widgetId.current);
        setFailure(FAILURE_KEYS[outcome] || FAILURE_KEYS.error);
      } finally {
        release();
        setBusy(false);
      }
    });
  }

  const requirementsId = "signup-requirements";
  const canSubmit = email.trim().length > 0 && acceptedTerms && isResidenceRegion(residenceState) && ageAttested && Boolean(turnstileToken);
  // #9458 W1-7: what is still missing, beside the button.
  const missing = [!email.trim() && t("signup.missing.email"), missingSentences(t, "signup", acceptedTerms, residenceState, ageAttested),
    !turnstileToken && t(checkExpired ? "signup.missing.checkExpired" : "signup.missing.check")].filter(Boolean).join(" ");

  return (
    <main className="auth-screen">
      <div className="sgauth-column">
        <section className="auth-card" aria-labelledby="signup-title">
          <span className="iac-brand"><BrandMark size={40} /></span>
          <span className="eyebrow">{t("signup.eyebrow")}</span>
          {sent ? (
            <div role="status" aria-live="polite">
              <h1 id="signup-title">{t("signup.sentTitle")}</h1>
              <p>{t("signup.sentBody")}</p>
              <p className="sgauth-recovery">{t("signup.haveAccount")} <a href="/auth">{t("signup.signIn")}</a></p>
            </div>
          ) : (
            <>
              <h1 id="signup-title">{t("signup.title")}</h1>
              <p>{t("signup.intro")}</p>
              <form onSubmit={submit} noValidate>
                <label>
                  <span>{t("signup.email")}</span>
                  <div><Mail size={18} aria-hidden="true" /><input name="email" type="email" autoComplete="email" placeholder={t("authlink.emailPlaceholder")} required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /></div>
                </label>
                {/* Honeypot: hidden from people and assistive technology. A
                    value here is answered like every other request. */}
                <div className="sgauth-honeypot" aria-hidden="true">
                  <label>
                    <span>{t("signup.website")}</span>
                    <input name="website" type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.target.value)} />
                  </label>
                </div>
                <label className="sgauth-terms">
                  <input name="acceptedTerms" type="checkbox" required checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} />
                  <span>{t("signup.termsLead")} <a href="/terms" target="_blank" rel="noopener">{t("signup.termsLink")}</a> {t("signup.termsJoin")} <a href="/privacy" target="_blank" rel="noopener">{t("signup.privacyLink")}</a></span>
                </label>
                <ResidenceAgeFields
                  idPrefix="signup"
                  residenceState={residenceState}
                  onResidenceState={setResidenceState}
                  ageAttested={ageAttested}
                  onAgeAttested={setAgeAttested}
                  checkLabelClassName="sgauth-terms"
                />
                <div className="sgauth-turnstile" ref={widgetRef} role="group" aria-label={t("signup.securityCheck")} />
                {widgetFailed && <p className="auth-message auth-message--error" role="alert">{t("signup.securityCheckFailed")}</p>}
                <p className="auth-requirements" id={requirementsId}>{t("signup.requirements")}</p>
                <BusyButton className="auth-submit" type="submit" pending={busy} disabled={!canSubmit} disabledReason={missing} aria-describedby={requirementsId}>
                  {busy ? t("signup.working") : t("signup.submit")}
                </BusyButton>
              </form>
              {failure && <p className="auth-message auth-message--error" role="alert">{t(failure)}</p>}
              <p className="sgauth-recovery">{t("signup.haveAccount")} <a href="/auth">{t("signup.signIn")}</a></p>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
