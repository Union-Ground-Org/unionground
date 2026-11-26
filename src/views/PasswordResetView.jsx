import { Eye, EyeOff, Lock, Mail, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BrandMark } from "../components/BrandMark.jsx";
import { BusyButton } from "../components/BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { AuthenticatorCodeInput } from "../components/AuthenticatorCodeInput.jsx";
import { isAuthenticatorCode, RECOVERY_CODE_MAX, RECOVERY_CODE_MIN } from "../lib/authenticatorCode.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { LockedOutRemedies } from "../components/LockedOutRemedies.jsx";
import { SupportText } from "../components/SupportText.jsx";
import { NewPasswordLengthMessage } from "../components/NewPasswordLengthMessage.jsx";
import { newPasswordLengthIssue } from "../lib/passwordPolicy.js";
import {
  beginPasswordResetOnce, clearPendingReset, finishPasswordReset, loadPendingReset, requestPasswordReset,
  RECOVERY_CODE_PATTERN, RESET_PASSWORD_MAX, RESET_PASSWORD_MIN, takeResetToken,
} from "../lib/passwordReset.js";

const FAILURE_KEYS = {
  "code-not-accepted": "reset.codeRejected",
  "password-rejected": "reset.passwordRejected",
  "recovery-incomplete": "reset.recoveryIncomplete",
  "recovery-unfinished": "reset.recoveryUnfinished",
  "recovery-held": "reset.recoveryHeld",
  "rate-limited": "reset.rateLimited",
  // No answer: the connection (#9461). Not "unchanged": a lost answer can follow a saved password.
  offline: "auth.passwordUnreachable",
  unavailable: "reset.unavailable",
};

// /reset-password (REQ-UG-SELF-SERVICE-PASSWORD-RESET-20261006).
// Without a token it asks for an email address and gives the same answer for
// every address. The emailed link lands here with `#token=`, which is read
// and scrubbed from the address bar at once. The new password takes effect
// only after an authenticator code is verified: the member's existing one,
// or one set up here if the account has none. Opening the link spends it, so
// the server's sealed state is kept in sessionStorage for its 15 minutes and a
// reload resumes the same step instead of ending the reset.
export function PasswordResetView({ fetcher = (...args) => fetch(...args), readToken = takeResetToken }) {
  const { t, lang } = useLang();
  const started = useRef(false);
  const messageRef = useRef(null);
  const emailRef = useRef(null);
  // Set when the sent state hands back to the request form, so keyboard and
  // screen-reader focus lands on the reopened field, not on a vanished button.
  const refocusEmail = useRef(false);
  const [state, setState] = useState("checking");
  // Another link was requested from the sent screen and the server accepted it.
  const [resent, setResent] = useState(false);
  // The address the accepted request went to: a resend posts exactly that,
  // never the draft a later keystroke may have changed (the form stays
  // editable while the first request is in flight).
  const [sentTo, setSentTo] = useState("");
  const resendAlertRef = useRef(null);
  const [recovery, setRecovery] = useState(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  // One request at a time (#8435): the request, Send another and the finish
  // share `busy`, so they share one lock. Their controls are pending while
  // it runs, so the lock alone refuses a second press or a form submit.
  const busyWriteRef = useRef(new Set());
  const [failure, setFailure] = useState("");
  const [sessionsEnded, setSessionsEnded] = useState(true);
  // A member who lost the authenticator may type a saved recovery code instead.
  const [useRecovery, setUseRecovery] = useState(false);
  const [recovered, setRecovered] = useState(false);

  useEffect(() => {
    // Strict Mode replays effects; the ref keeps the one-time fragment read
    // and the single-use token exchange single-shot.
    if (started.current) return;
    started.current = true;
    const token = readToken();
    const pending = loadPendingReset();
    // No link, or the same link opened again: resume without calling begin.
    // A different link is newer, and only the newest works.
    if (pending && (!token || token === pending.ticket)) {
      setRecovery(pending);
      setState(pending.status);
      return;
    }
    if (!token) {
      setState("request");
      return;
    }
    // The saved reset is replaced only when the new link is accepted: an
    // expired or used link must not destroy the reset that is still usable.
    beginPasswordResetOnce(fetcher, token).then((result) => {
      if (result.status === "challenge" || result.status === "enroll") {
        setRecovery(result);
        setState(result.status);
      } else if (result.status === "two-step-unavailable") {
        setState("two-step-unavailable");
      } else if (result.status === "reset-invalidated") {
        setState(result.reason === "two-step-unavailable" ? "two-step-unavailable" : "link-invalid");
      } else if (result.status === "rate-limited" || result.status === "unavailable" || result.status === "offline") {
        setFailure(FAILURE_KEYS[result.status]);
        setState("link-failed");
      } else {
        setState("link-invalid");
      }
    });
  }, [fetcher, readToken]);

  useEffect(() => {
    if (["sent", "link-invalid", "link-failed", "two-step-unavailable", "unfinished", "held", "completed"].includes(state)) {
      messageRef.current?.focus();
    }
  }, [state]);

  // A refusal is announced where it shows: on the sent screen that is the
  // resend alert, elsewhere the message paragraph that carries messageRef.
  // Clearing a refusal (the next press) moves focus nowhere, so the control
  // that was pressed keeps it while the request is busy.
  useEffect(() => {
    if (!failure) return;
    (state === "sent" ? resendAlertRef : messageRef).current?.focus();
  }, [failure, state]);

  // Leaves a resumed reset for a fresh request (another account, another
  // address): the saved step is dropped and the request form shown.
  function startOver() {
    clearPendingReset();
    setRecovery(null);
    setCode("");
    setPassword("");
    setConfirmation("");
    setFailure("");
    setState("request");
  }

  useEffect(() => {
    if (state === "request" && refocusEmail.current) {
      refocusEmail.current = false;
      emailRef.current?.focus();
    }
  }, [state]);

  function reopenRequest() {
    setEmail("");
    setSentTo("");
    setFailure("");
    setResent(false);
    refocusEmail.current = true;
    setState("request");
  }

  // BUG-UG-RESET-SEND-ANOTHER-LINK-COPY-MATCHES-ACTION-20261020: the
  // sent-state control promises a send, so it sends: the same request, the same
  // kept address, the same server limits. A refusal shows here, on the sent
  // screen, and the person keeps the address.
  function resendLink() {
    return runBusyWrite(busyWriteRef, "reset", () => resendLinkNow());
  }

  async function resendLinkNow() {
    setBusy(true);
    setFailure("");
    setResent(false);
    const result = await requestPasswordReset(fetcher, { email: sentTo || email.trim(), locale: lang });
    setBusy(false);
    if (result.status === "sent") setResent(true);
    else setFailure(FAILURE_KEYS[result.status] || FAILURE_KEYS.unavailable);
  }

  function submitRequest(event) {
    event.preventDefault();
    return runBusyWrite(busyWriteRef, "reset", () => submitRequestNow(), event);
  }

  async function submitRequestNow() {
    setBusy(true);
    setFailure("");
    const address = email.trim();
    const result = await requestPasswordReset(fetcher, { email: address, locale: lang });
    setBusy(false);
    if (result.status === "sent") { setSentTo(address); setState("sent"); }
    else setFailure(FAILURE_KEYS[result.status] || FAILURE_KEYS.unavailable);
  }

  function submitRecovery(event) {
    event.preventDefault();
    if (!canFinish) return undefined; // #9458: Save stays focusable while blocked.
    return runBusyWrite(busyWriteRef, "reset", () => submitRecoveryNow(), event);
  }

  async function submitRecoveryNow() {
    if (!recovery) return;
    setBusy(true);
    setFailure("");
    const result = await finishPasswordReset(fetcher, { state: recovery.state, code, password });
    setBusy(false);
    setCode("");
    if (result.status === "completed") {
      clearPendingReset();
      setRecovery(null);
      setPassword("");
      setConfirmation("");
      setSessionsEnded(result.sessionsEnded);
      setRecovered(result.recoveryCodeUsed);
      setState("completed");
    } else if (result.status === "link-invalid") {
      clearPendingReset();
      setRecovery(null);
      setState("link-invalid");
    } else if (result.status === "two-step-unavailable") {
      // The server ended this reset; resuming it would only repeat the refusal.
      clearPendingReset();
      setFailure(FAILURE_KEYS[result.status] || FAILURE_KEYS.unavailable);
    } else if (result.status === "recovery-unfinished") {
      clearPendingReset();
      // The password changed but the recovery could not be completed; there is
      // nothing left to retry here, only staff can clear the account.
      setRecovery(null);
      setPassword("");
      setConfirmation("");
      setState("unfinished");
    } else if (result.status === "recovery-held") {
      clearPendingReset();
      // The recovery lock is held and the password outcome is unknown; only an
      // administrator's two-step reset clears the account. Nothing to retype.
      setRecovery(null);
      setPassword("");
      setConfirmation("");
      setState("held");
    } else {
      setFailure(result.status === "code-not-accepted" && useRecovery
        ? "reset.recoveryRejected" : FAILURE_KEYS[result.status] || FAILURE_KEYS.unavailable);
    }
  }

  const mismatch = confirmation.length > 0 && confirmation !== password;
  // The emailed link got no answer: say so, and send them to a new link (#9461).
  const linkOffline = state === "link-failed" && failure === FAILURE_KEYS.offline;
  const lengthOk = password.length >= RESET_PASSWORD_MIN && password.length <= RESET_PASSWORD_MAX;
  const codeOk = useRecovery ? RECOVERY_CODE_PATTERN.test(code.trim()) : isAuthenticatorCode(code);
  const canFinish = lengthOk && confirmation === password && codeOk;
  // #9458: the first unmet rule, said beside Save.
  const finishBlock = !codeOk ? (useRecovery ? "reset.blockedRecoveryCode" : "reset.blockedCode")
    : password.length < RESET_PASSWORD_MIN ? "auth.blockedPasswordShort" : !lengthOk ? "auth.blockedPasswordLong"
    : !confirmation ? "auth.blockedConfirm" : confirmation !== password ? "auth.blockedMismatch" : "";
  const requirementsId = "reset-password-requirements";
  // #9448: say beside the field why Save stays unavailable.
  const lengthIssue = newPasswordLengthIssue(password);
  const lengthId = "reset-password-length";
  const codeHintId = "reset-code-hint";
  const failureMessage = failure && (
    <p ref={messageRef} tabIndex="-1" className="auth-message auth-message--error" role="alert"><SupportText text={t(failure)} /></p>
  );
  const fallback = <LockedOutRemedies recoveryCodes={false} />;
  const signInLink = <p className="sgauth-recovery"><a href="/auth">{t("reset.backToSignIn")}</a></p>;

  return (
    <main className="auth-screen">
      <div className="sgauth-column">
        <section className="auth-card" aria-labelledby="reset-title">
          <span className="iac-brand"><BrandMark size={40} /></span>
          {state === "checking" && (
            <div role="status" aria-live="polite">
              <h1 id="reset-title">{t("reset.title")}</h1>
              <p>{t("reset.checking")}</p>
            </div>
          )}

          {state === "request" && (
            <>
              <h1 id="reset-title">{t("reset.requestTitle")}</h1>
              <p>{t("reset.requestIntro")}</p>
              <form onSubmit={submitRequest}>
                <label>
                  <span>{t("auth.email")}</span>
                  <div>
                    <Mail size={18} aria-hidden="true" />
                    <input ref={emailRef} name="email" type="email" autoComplete="email" required placeholder={t("authlink.emailPlaceholder")} value={email} onChange={(event) => setEmail(event.target.value)} />
                  </div>
                </label>
                <BusyButton className="auth-submit" type="submit" pending={busy} disabled={!email.trim()}>
                  {busy ? t("auth.working") : t("reset.requestSubmit")}
                </BusyButton>
              </form>
              {failureMessage}
              {fallback}
              {signInLink}
            </>
          )}

          {state === "sent" && (
            <>
              <div ref={messageRef} role="status" tabIndex="-1">
                <h1 id="reset-title">{t("reset.sentTitle")}</h1>
                <p>{t("reset.sentBody")}</p>
              </div>
              {resent && <p className="auth-message auth-message--info" role="status">{t("reset.sentAgain")}</p>}
              {/* A refused resend is announced and focused here (the effect above), so
                  the answer is read where it shows, not from the status block. */}
              {failure && <p ref={resendAlertRef} className="auth-message auth-message--error" role="alert" tabIndex="-1">{t(failure)}</p>}
              {/* Send another: the same request for the kept address; the server's
                  per-address and per-network limits still decide whether another
                  email goes out. A different address returns to the form. */}
              {/* Pending, not disabled, while sending: a disabled control drops
                  keyboard focus in browsers. */}
              <BusyButton className="auth-switch" type="button" pending={busy} onClick={resendLink}>
                {busy ? t("auth.working") : t("reset.sendAnother")}
              </BusyButton>
              <BusyButton className="auth-switch" type="button" pending={busy} onClick={reopenRequest}>
                {t("reset.useDifferentEmail")}
              </BusyButton>
              {fallback}
              {signInLink}
            </>
          )}

          {(state === "challenge" || state === "enroll") && recovery && (
            <>
              <h1 id="reset-title">{t("reset.title")}</h1>
              <p>{t(state === "enroll" ? "reset.enrollIntro" : useRecovery ? "reset.recoveryIntro" : "reset.challengeIntro")}</p>
              <form onSubmit={submitRecovery} noValidate>
                {state === "enroll" && (
                  <div className="mfa-enroll">
                    <p>{t("mfa.scanBlurb")}</p>
                    {recovery.qr && <img className="mfa-qr" src={recovery.qr} alt={t("mfa.qrAlt")} />}
                    <label>
                      <span>{t("mfa.secretLabel")}</span>
                      <code className="mfa-secret">{recovery.secret}</code>
                    </label>
                    <p className="mfa-caution"><SupportText text={t("reset.enrollCaution")} /></p>
                  </div>
                )}
                <label>
                  <span>{t(useRecovery ? "reset.recoveryCodeLabel" : "mfa.codeLabel")}</span>
                  <div>
                    <ShieldCheck size={18} aria-hidden="true" />
                    {useRecovery
                      ? <input name="code" autoComplete="off" autoCapitalize="characters" spellCheck="false" pattern="[A-Za-z0-9\-]{18,32}" maxLength={32} required aria-describedby={codeHintId} value={code} onChange={(event) => setCode(event.target.value.replace(/[^A-Za-z0-9-]/g, ""))} />
                      : <AuthenticatorCodeInput value={code} onChange={setCode} hintId={codeHintId} />}
                  </div>
                </label>
                <p className="auth-requirements" id={codeHintId}>{t(useRecovery ? "reset.recoveryCodeHint" : "mfa.codeHint", { min: RECOVERY_CODE_MIN, max: RECOVERY_CODE_MAX })}</p>
                {state === "challenge" && (
                  <button className="auth-switch" type="button" onClick={() => { setUseRecovery((value) => !value); setCode(""); setFailure(""); }}>
                    {t(useRecovery ? "reset.useAuthenticatorCode" : "reset.useRecoveryCode")}
                  </button>
                )}
                <label>
                  <span>{t("reset.newPassword")}</span>
                  <div>
                    <Lock size={18} aria-hidden="true" />
                    <input name="password" type={visible ? "text" : "password"} autoComplete="new-password" required minLength={RESET_PASSWORD_MIN} maxLength={RESET_PASSWORD_MAX} aria-invalid={Boolean(lengthIssue)} aria-describedby={lengthIssue ? `${lengthId} ${requirementsId}` : requirementsId} value={password} onChange={(event) => setPassword(event.target.value)} />
                    <button className="sgauth-password-toggle" type="button" aria-label={t(visible ? "auth.hidePassword" : "auth.showPassword")} aria-pressed={visible} onClick={() => setVisible((value) => !value)}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button>
                  </div>
                </label>
                <NewPasswordLengthMessage id={lengthId} issue={lengthIssue} length={password.length} />
                <label>
                  <span>{t("reset.confirmPassword")}</span>
                  <div>
                    <Lock size={18} aria-hidden="true" />
                    <input name="passwordConfirm" type={visible ? "text" : "password"} autoComplete="new-password" required maxLength={RESET_PASSWORD_MAX} aria-invalid={mismatch} aria-describedby={requirementsId} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
                  </div>
                </label>
                <p className="auth-requirements" id={requirementsId}>{t("reset.passwordRequirements")}</p>
                {mismatch && <p className="auth-message auth-message--error" role="alert">{t("reset.passwordMismatch")}</p>}
                <BusyButton className="auth-submit" type="submit" pending={busy} disabled={!canFinish} disabledReason={finishBlock && t(finishBlock, { min: RECOVERY_CODE_MIN, max: RECOVERY_CODE_MAX })} aria-describedby={requirementsId}>
                  {busy ? t("auth.working") : t("reset.finishSubmit")}
                </BusyButton>
              </form>
              {failureMessage}
              <BusyButton className="auth-switch" type="button" pending={busy} onClick={startOver}>{t("reset.startOver")}</BusyButton>
              {/* BUG-UG-RESET-RECOVERY-FOOTER-CONTRADICTION-20261021: the
                  challenge step offers "Use a recovery code" above, so its help names
                  that remedy too; enrolment has no codes yet and keeps the
                  administrator-only line. */}
              <LockedOutRemedies recoveryCodes={state === "challenge"} />
            </>
          )}

          {state === "completed" && (
            <div ref={messageRef} role="status" tabIndex="-1">
              <h1 id="reset-title">{t("reset.completedTitle")}</h1>
              <p>{t(recovered ? "reset.completedRecovery" : sessionsEnded ? "reset.completedBody" : "reset.completedSessionsOpen")}</p>
              <a className="auth-submit auth-submit--link" href="/auth">{t("reset.signIn")}</a>
            </div>
          )}

          {(state === "link-invalid" || state === "link-failed") && (
            <div ref={messageRef} role="alert" tabIndex="-1">
              <h1 id="reset-title">{t(linkOffline ? "reset.linkOfflineTitle" : state === "link-failed" ? "reset.linkFailedTitle" : "reset.linkInvalidTitle")}</h1>
              <p><SupportText text={t(linkOffline ? "reset.linkOfflineBody" : state === "link-failed" ? failure || "reset.unavailable" : "reset.linkInvalidBody")} /></p>
              <a className="auth-submit auth-submit--link" href="/reset-password" onClick={(event) => { event.preventDefault(); startOver(); }}>{t("reset.requestNew")}</a>
              {fallback}
            </div>
          )}

          {state === "unfinished" && (
            <div ref={messageRef} role="alert" tabIndex="-1">
              <h1 id="reset-title">{t("reset.title")}</h1>
              <p>{t("reset.recoveryUnfinished")}</p>
              {signInLink}
            </div>
          )}

          {state === "held" && (
            <div ref={messageRef} role="alert" tabIndex="-1">
              <h1 id="reset-title">{t("reset.title")}</h1>
              <p>{t("reset.recoveryHeld")}</p>
              {signInLink}
            </div>
          )}

          {state === "two-step-unavailable" && (
            <div ref={messageRef} role="alert" tabIndex="-1">
              <h1 id="reset-title">{t("reset.title")}</h1>
              <p><SupportText text={t("reset.twoStepUnavailable")} /></p>
              {signInLink}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
