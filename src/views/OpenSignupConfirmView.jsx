import { Eye, EyeOff, Lock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BrandMark } from "../components/BrandMark.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { BusyButton } from "../components/BusyControls.jsx";
import { NewPasswordLengthMessage } from "../components/NewPasswordLengthMessage.jsx";
import { newPasswordLengthIssue } from "../lib/passwordPolicy.js";
import { prepareBusyWrite } from "../lib/busyWrite.js";
import {
  confirmOpenSignup, signInAfterSignup, SIGNUP_PASSWORD_MAX, SIGNUP_PASSWORD_MIN, takeSignupToken,
} from "../lib/openSignup.js";
import { SignupUnavailable } from "./OpenSignupView.jsx";

const FAILURE_KEYS = {
  "password-rejected": "signup.passwordRejected",
  "rate-limited": "signup.rateLimited",
  "email-domain-blocked": "signup.emailDomainBlocked",
  unavailable: "signup.serviceUnavailable",
  error: "signup.error",
};

function openApp() {
  window.location.assign("/m");
}

// /signup/confirm: the emailed link lands here. The token is read from the
// fragment and removed from the address bar at once; it is held only in
// memory for the one request and never logged or stored.
export function OpenSignupConfirmView({
  available,
  client,
  fetcher = (...args) => fetch(...args),
  onSignedIn = openApp,
  readToken = takeSignupToken,
}) {
  const { t, lang } = useLang();
  const token = useRef(null);
  const started = useRef(false);
  const decided = useRef(false);
  const messageRef = useRef(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  // Synchronous submit lock (#8435): the request holds it until it settles.
  const busyWriteRef = useRef(new Set());
  const [state, setState] = useState("checking");
  const [failure, setFailure] = useState("");

  useEffect(() => {
    // React Strict Mode replays effects; the refs keep the one-time fragment
    // read and the one-time decision single-shot, as InvitationAcceptView
    // does. The fragment is read and scrubbed at once, even where signup is
    // not offered, so a link opened on the wrong host never lingers in the
    // address bar or history. `available` is null while the owner's switch
    // is still being read: the token waits in memory until then and is
    // dropped if signup turns out not to be offered.
    if (!started.current) {
      started.current = true;
      token.current = readToken();
    }
    if (available === null || decided.current) return;
    decided.current = true;
    if (!available) token.current = null;
    setState(token.current ? "form" : "link-invalid");
  }, [available, readToken]);

  useEffect(() => {
    if (["link-invalid", "sign-in-failed"].includes(state) || failure) messageRef.current?.focus();
  }, [failure, state]);

  if (available !== null && !available) return <SignupUnavailable />;

  function submit(event) {
    event.preventDefault();
    if (!canSubmit) return undefined; // #9458: the button stays focusable while blocked.
    // The form shows only while the link's token is held: a missing token
    // never shows it, and an accepted confirmation leaves the form state.
    return prepareBusyWrite(busyWriteRef, "confirm", () => submitNow, event);
  }

  async function submitNow() {
    setBusy(true);
    setFailure("");
    const result = await confirmOpenSignup(fetcher, {
      token: token.current,
      password,
      locale: lang,
    });
    if (result.status === "link-invalid") {
      token.current = null;
      setBusy(false);
      setState("link-invalid");
      return;
    }
    if (result.status !== "accepted") {
      setBusy(false);
      setFailure(FAILURE_KEYS[result.status] || FAILURE_KEYS.error);
      return;
    }
    token.current = null;
    const signedIn = await signInAfterSignup(fetcher, client, result.email, password);
    setBusy(false);
    setPassword("");
    setConfirmation("");
    if (!signedIn) {
      setState("sign-in-failed");
      return;
    }
    setState("continuing");
    onSignedIn();
  }

  const mismatch = confirmation.length > 0 && confirmation !== password;
  const lengthOk = password.length >= SIGNUP_PASSWORD_MIN && password.length <= SIGNUP_PASSWORD_MAX;
  const canSubmit = lengthOk && confirmation === password;
  // #9458: the first unmet rule, said beside the button.
  const submitBlock = password.length < SIGNUP_PASSWORD_MIN ? "auth.blockedPasswordShort" : !lengthOk ? "auth.blockedPasswordLong"
    : !confirmation ? "auth.blockedConfirm" : confirmation !== password ? "auth.blockedMismatch" : "";
  const requirementsId = "signup-password-requirements";
  // #9448: say beside the field why Create my account stays unavailable.
  const lengthIssue = newPasswordLengthIssue(password);
  const lengthId = "signup-password-length";
  const linkInvalid = state === "link-invalid";

  return (
    <main className="auth-screen">
      <div className="sgauth-column">
        <section className="auth-card" aria-labelledby="signup-confirm-title">
          <span className="iac-brand"><BrandMark size={40} /></span>
          <span className="eyebrow">{t("signup.eyebrow")}</span>
          {linkInvalid && (
            <div ref={messageRef} role="alert" tabIndex="-1">
              <h1 id="signup-confirm-title">{t("signup.linkInvalidTitle")}</h1>
              <p>{t("signup.linkInvalidBody")}</p>
              <a className="auth-submit auth-submit--link" href="/signup">{t("signup.requestNew")}</a>
              <p className="sgauth-recovery">{t("signup.haveAccount")} <a href="/auth">{t("signup.signIn")}</a></p>
            </div>
          )}
          {state === "sign-in-failed" && (
            <div ref={messageRef} role="alert" tabIndex="-1">
              <h1 id="signup-confirm-title">{t("signup.confirmTitle")}</h1>
              <p>{t("signup.signInFailed")}</p>
              <a className="auth-submit auth-submit--link" href="/auth">{t("signup.signIn")}</a>
            </div>
          )}
          {state === "continuing" && (
            <div role="status" aria-live="polite">
              <h1 id="signup-confirm-title">{t("signup.confirmTitle")}</h1>
              <p>{t("signup.continuing")}</p>
            </div>
          )}
          {state === "checking" && <h1 id="signup-confirm-title">{t("signup.confirmTitle")}</h1>}
          {state === "form" && (
            <>
              <h1 id="signup-confirm-title">{t("signup.confirmTitle")}</h1>
              <p>{t("signup.confirmIntro")}</p>
              <form onSubmit={submit} noValidate>
                <label>
                  <span>{t("signup.password")}</span>
                  <div>
                    <Lock size={18} aria-hidden="true" />
                    <input name="password" type={visible ? "text" : "password"} autoComplete="new-password" required minLength={SIGNUP_PASSWORD_MIN} maxLength={SIGNUP_PASSWORD_MAX} aria-invalid={Boolean(lengthIssue)} aria-describedby={lengthIssue ? `${lengthId} ${requirementsId}` : requirementsId} value={password} onChange={(event) => setPassword(event.target.value)} />
                    <button className="sgauth-password-toggle" type="button" aria-label={t(visible ? "auth.hidePassword" : "auth.showPassword")} aria-pressed={visible} onClick={() => setVisible((value) => !value)}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button>
                  </div>
                </label>
                <NewPasswordLengthMessage id={lengthId} issue={lengthIssue} length={password.length} />
                <label>
                  <span>{t("signup.passwordConfirm")}</span>
                  <div>
                    <Lock size={18} aria-hidden="true" />
                    <input name="passwordConfirm" type={visible ? "text" : "password"} autoComplete="new-password" required maxLength={SIGNUP_PASSWORD_MAX} aria-invalid={mismatch} aria-describedby={requirementsId} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
                  </div>
                </label>
                <p className="auth-requirements" id={requirementsId}>{t("signup.passwordRequirements")}</p>
                {mismatch && <p className="auth-message auth-message--error" role="alert">{t("signup.passwordMismatch")}</p>}
                <BusyButton className="auth-submit" type="submit" pending={busy} disabled={!canSubmit} disabledReason={submitBlock && t(submitBlock)} aria-describedby={requirementsId}>
                  {busy ? t("signup.confirmWorking") : t("signup.confirmSubmit")}
                </BusyButton>
              </form>
              {failure && <p ref={messageRef} tabIndex="-1" className="auth-message auth-message--error" role="alert">{t(failure)}</p>}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
