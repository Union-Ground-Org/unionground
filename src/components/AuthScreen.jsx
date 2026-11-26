import { Eye, EyeOff, Lock, Mail } from "lucide-react";
import { useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { PRODUCT_NAME } from "../lib/productIdentity.js";
import { BrandMark } from "./BrandMark.jsx";
import { OfficialServiceBadge, OperatorLink, SourceAttribution } from "./ServiceIdentity.jsx";

// Union Ground's sign-in card, on the password route.
//
// Live sign-in is a provisioned email plus a password delivered by email, the
// same rule the native app follows. Member PIN,
// SSO, store-account (social) and passkey sign-in are left out of this
// product, so none of them is offered here. The screen never creates an
// account: the open-signup link appears only while that owner switch is on,
// which it never is on a Union Ground host.

export function AuthScreen({ client, lang = "en", onLanguageChange, onDemo, demoOriginHref, onBackToLanding, returnToRequestedPage = false, signupAvailable = false }) {
  const { t } = useLang();
  // This screen
  // never creates an account. Invited accounts get an emailed password. Every
  // invalid credential pair gets the same failure. Only while the owner's
  // public signup switch is on (REQ-UG-PUBLIC-SIGNUP-OWNER-SWITCH-20261003,
  // off by default) does the card link to the server signup pages instead of
  // the invitation-only note.
  const [busy, setBusy] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState("info");
  const [passwordVisible, setPasswordVisible] = useState(false);

  function report(text, tone) {
    setMessage(text);
    setMessageTone(tone);
  }

  async function submit(event) {
    event.preventDefault();
    // Prevent duplicate password grants while the first request is in flight.
    if (busy) return;
    setBusy("password");
    setMessage("");
    const submittedEmail = email.trim();
    // Only the route's own 401 is a credential refusal and its 429 a wait.
    // Everything else (a fetch that never reached it, a 5xx, a malformed
    // answer, a session the SDK would not take) is not about the password.
    let failure = "auth.passwordUnreachable";
    try {
      const response = await fetch("/api/auth-password-signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: submittedEmail, password }),
      });
      if (response.status === 429) failure = "auth.passwordRateLimited";
      else if (response.status === 401) failure = "auth.passwordFailed";
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.accessToken || !payload?.refreshToken) throw new Error("sign-in-failed");
      const { error } = await client.auth.setSession({
        access_token: payload.accessToken,
        refresh_token: payload.refreshToken,
      });
      if (error) throw error;
    } catch {
      // Credential failures stay indistinguishable on this public surface so
      // the screen never becomes an account oracle. A 429 and an outage are
      // the same for every address, whether or not it has an account, so
      // saying so is honest and reveals nothing.
      report(t(failure), "error");
    } finally {
      setBusy("");
    }
  }

  /* Buttons with aria-pressed, not tabs. A tab role promises a keyboard
     model — Left/Right moving selection between siblings of a tablist
     that owns a tabpanel — which this app has never implemented
     anywhere. A screen reader announced "tab, 1 of 2" on the FIRST
     control a Spanish-speaking member meets, and pressing Right did
     nothing. Two independent toggles over one region is what this is,
     and aria-pressed is what says so. role="group" rather than nothing:
     a bare <div> with aria-label exposes no group name at all. */
  // Each button names its language in that language, so it carries that lang.
  const languageToggle = onLanguageChange ? (
    <div className="segment auth-language" role="group" aria-label={t("auth.language")}>
      <button type="button" lang="en" aria-pressed={lang === "en"} onClick={() => onLanguageChange("en")}>{t("auth.langEnglish")}</button>
      <button type="button" lang="es" aria-pressed={lang === "es"} onClick={() => onLanguageChange("es")}>{t("auth.langSpanish")}</button>
    </div>
  ) : null;

  const canSubmit = email.trim().length > 0 && password.length >= 10 && !busy;
  const submitRequirementsId = "auth-submit-requirements";

  return (
    <div className="sgauth-shell">
      <header className="sgauth-site-header">
        <a className="sgauth-brand" href="/" aria-label={t("landing.homeLabel")}>
          <BrandMark size={34} />
          <span className="sgauth-wordmark">{PRODUCT_NAME}</span>
        </a>
      </header>

      <main className="auth-screen">
        <div className="sgauth-column">

        <section className="auth-card" aria-labelledby="auth-title">
          <span className="auth-mark"><BrandMark size={58} /></span>
          <h1 id="auth-title">{t("auth.passwordTitle")}</h1>
          <OfficialServiceBadge />
          {returnToRequestedPage && (
            <p className="auth-return-context">{t("auth.returnToRequestedPage")}</p>
          )}
          <p>{t("auth.passwordBlurb")}</p>
          <form onSubmit={submit}>
            <label><span>{t("auth.email")}</span><div><Mail size={18} /><input name="email" type="email" autoComplete="email" placeholder={t("authlink.emailPlaceholder")} required value={email} onChange={(event) => setEmail(event.target.value)} /></div></label>
            <label><span>{t("auth.password")}</span><div><Lock size={18} /><input name="password" type={passwordVisible ? "text" : "password"} autoComplete="current-password" required minLength="10" aria-describedby={submitRequirementsId} value={password} onChange={(event) => setPassword(event.target.value)} /><button className="sgauth-password-toggle" type="button" aria-label={t(passwordVisible ? "auth.hidePassword" : "auth.showPassword")} aria-pressed={passwordVisible} onClick={() => setPasswordVisible((visible) => !visible)}>{passwordVisible ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label>
            <p className="auth-requirements" id={submitRequirementsId}>{t("auth.submitRequirements")}</p>
            <button className="auth-submit" type="submit" disabled={!canSubmit} aria-describedby={submitRequirementsId}>{busy === "password" ? t("auth.working") : t("auth.passwordCta")}</button>
          </form>
          {message && (
            <p className={`auth-message auth-message--${messageTone}`} role={messageTone === "error" ? "alert" : "status"}>
              {message}
            </p>
          )}
          {/* The member's own way back in is an emailed reset link that also
              enforces two-step; a campaign admin's reissue stays the fallback. */}
          <p className="sgauth-recovery"><a href="/reset-password">{t("auth.forgotPassword")}</a></p>
          {/* No support mailbox is named: Union Ground has no provisioned
              contact address yet (provider boundary). */}
          <p className="sgauth-recovery">{t("auth.recoveryHelp")}</p>
          {/* A plain link is a full page load, so /signup gets its own
              Content-Security-Policy from Vercel. */}
          {signupAvailable
            ? <p className="sgauth-recovery"><a href="/signup">{t("auth.createOrganization")}</a> <a href="/request-invite">{t("requestInvite.link")}</a></p>
            : <p className="sgauth-recovery">{t("auth.inviteOnly")} <a href="/request-invite">{t("requestInvite.link")}</a></p>}
          {onDemo && (
            <button className="auth-demo" type="button" onClick={onDemo}>
              {t("auth.demo")}
            </button>
          )}
          {!onDemo && demoOriginHref && (
            <a className="auth-demo" href={demoOriginHref}>
              {t("auth.sampleTour")}
            </a>
          )}
          {languageToggle}
        </section>

        {onBackToLanding && (
          <button className="sgauth-back" type="button" onClick={onBackToLanding}>
            <span aria-hidden="true">‹ </span>{t("authlink.backToSite")}
          </button>
        )}
        </div>
      </main>

      <footer className="sgauth-site-footer">
        <span>{PRODUCT_NAME}</span>
        <OperatorLink />
        <SourceAttribution />
      </footer>
    </div>
  );
}
