import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { PRODUCT_NAME } from "../lib/productIdentity.js";
import { BrandMark } from "./BrandMark.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { plainClick } from "../lib/plainClick.js";
import { safeAdminSetupPath } from "../lib/setupSecurityReturn.js";
import { useWorkspace } from "./WorkspacePages.jsx";
import { AuthenticatorCodeInput } from "./AuthenticatorCodeInput.jsx";
import { isAuthenticatorCode } from "../lib/authenticatorCode.js";
import { BusyButton } from "./BusyControls.jsx";
import { prepareBusyWrite, runBusyWrite } from "../lib/busyWrite.js";

// TOTP enrolment and removal for the signed-in member.
//
// GoTrue owns auth.mfa_factors, so there is no table of ours here and no
// migration — which also means no server-side record of who has MFA on. That
// is an accepted limitation of a member-self-service surface; admin visibility
// is tracked separately.
//
// The state machine is small but has one non-obvious branch. enroll() creates
// a factor in `unverified` state immediately, before the member has typed a
// code. If they abandon the screen at that point the factor persists, and the
// NEXT enroll() call can fail with a confusing duplicate error that the member
// can neither understand nor clear. So an unverified leftover is cleaned up
// rather than surfaced — except one whose QR this page has shown, which the
// member may have scanned; that one is resumed (see shownEnrollments).
// GoTrue rate-limits MFA verify attempts. Its raw message is English-only and
// tells a locked-out member nothing about the way out (their local office —
// an admin can reset two-step sign-in, see AdminView's reset flow).
function isTooManyAttempts(error) {
  return error?.status === 429
    || error?.code === "over_request_rate_limit"
    || /rate limit|too many/i.test(String(error?.message || ""));
}

async function readJsonBody(response) {
  try {
    if (typeof response?.json !== "function") return null;
    const payload = await response.json();
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

function namedRecoveryError(payload) {
  if (!payload || typeof payload !== "object") return "";
  return String(payload.code || payload.error || payload.message || "");
}

function recoveryHttpError(response, payload) {
  const named = namedRecoveryError(payload);
  return { status: response?.status, code: named, message: named };
}

function isRecoveryCodeRejected(response, payload) {
  return response?.status === 400 && namedRecoveryError(payload) === "code-not-accepted";
}

// GoTrue's error.message is English-only server copy — "Invalid TOTP code
// entered", "MFA enroll is disabled", "Factor not found". Showing it whenever it
// was non-empty meant a member reading the app in Spanish got English on the
// wrong code, the failed enrolment and the failed turn-off alike.
//
// So a server message never reaches the screen. The screens still raise their
// OWN already-translated lines through the same catch (mfa.noFactor):
// localizedError() marks those so they survive, and everything else falls back
// to the caller's translated line.
function localizedError(text) {
  const error = new Error(text);
  error.localizedMessage = text;
  return error;
}

function memberMessage(error, fallback) {
  const own = error?.localizedMessage;
  return typeof own === "string" && own ? own : fallback;
}

function verifyErrorMessage(error, t) {
  if (isTooManyAttempts(error)) return t("mfa.tooManyAttempts");
  if (error?.name === "AuthRetryableFetchError" && error?.status === 0) return t("auth.passwordUnreachable");
  return memberMessage(error, t("mfa.codeRejected"));
}

const IDLE = "idle";
const ENROLLING = "enrolling";
const VERIFIED = "verified";

// BUG-UG-TWO-STEP-SETUP-SECRET-REPLACED-AFTER-SCAN-20261103: the QR
// and secret of an unverified factor come back from GoTrue only once, in the
// enroll() answer, and the member scans them straight away. Keeping them only
// in component state meant any remount or factor re-read during setup showed
// "Off", and the next "Turn on" deleted the scanned factor and made a new
// secret, so every code from the member's app was refused.
//
// So the enrolments this page has shown are kept here, by factor id, for as
// long as the page is loaded: a remount or re-read resumes the same QR. They
// are never written to Web Storage, so the secret does not outlive the page
// or sit where any later script on the origin can read it. After a full reload
// the factor cannot be resumed, and the member is told that turning two-step
// on makes a new QR before anything is replaced.
const shownEnrollments = new Map();

// Sign-in challenge. A member with a verified factor gets a session at aal1
// from the magic-link sign-in; the second factor is what raises it to aal2. Until
// then they are authenticated but not fully assured, so the app must not render
// member data behind them.
//
// This screen is the explanation, not the enforcement. Enforcement lives in the
// database: a restrictive policy on every public table calls
// private.mfa_satisfied(), so an aal1 token belonging to a member with a
// verified factor reads nothing through PostgREST either. Proven end to end in
// the migration's dry run — member_profiles goes 1 row -> 0 rows -> 1 row as the
// same member moves no-MFA -> owing-a-code -> aal2.
//
// Without that policy this component would be theatre: an earlier build of PR6
// had exactly this UI and an aal1 token still returned 200s straight from the
// API.
export function MfaChallenge({ client, onCleared, onSignOut }) {
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [code, setCode] = useState("");
  const codeHintId = useId();
  // Spaces are dropped as typed, so a code copied with spaces fits the pattern.
  const [recoveryCode, setRecoveryCode] = useState("");
  const recoveryHintId = useId();
  // Verify, Use a recovery code and Sign out instead stay focusable while a
  // request runs, so the two requests (which share busy) take this
  // synchronous lock before React commits it.
  const busyWriteRef = useRef(new Set());

  function submit(event) {
    event.preventDefault();
    return runBusyWrite(busyWriteRef, "challenge", submitNow, event);
  }

  async function submitNow() {
    if (!isAuthenticatorCode(code)) return;
    setBusy(true);
    setMessage("");
    try {
      const { data: factorData, error: listError } = await client.auth.mfa.listFactors();
      if (listError) throw listError;
      const verified = (factorData?.all ?? [])
        .filter((entry) => entry.factor_type === "totp" && entry.status === "verified");
      if (verified.length === 0) throw localizedError(t("mfa.noFactor"));

      // Try the code against EVERY verified factor, not just the first in list
      // order.
      //
      // A member can end up with more than one — a factor created through the
      // API, a concurrent tab, a re-enrolment after the list failed to load. If
      // the first one is the authenticator they lost, challenging only that one
      // rejects every correct code from the device they still have, and the
      // member is locked out while holding a working authenticator. The code
      // itself identifies the factor, so trying each is invisible when there is
      // only one and quietly correct when there is not.
      let lastError = null;
      for (const factor of verified) {
        const { data: challengeData, error: challengeError } =
          await client.auth.mfa.challenge({ factorId: factor.id });
        if (challengeError) { lastError = challengeError; continue; }
        const { error } = await client.auth.mfa.verify({
          factorId: factor.id,
          challengeId: challengeData.id,
          code,
        });
        if (!error) { onCleared?.(); return; }
        lastError = error;
      }
      throw lastError || localizedError(t("mfa.codeRejected"));
    } catch (error) {
      setMessage(verifyErrorMessage(error, t));
    } finally {
      setBusy(false);
    }
  }

  function recover(event) {
    event.preventDefault();
    return runBusyWrite(busyWriteRef, "challenge", () => recoverNow(event.currentTarget), event);
  }

  async function recoverNow(form) {
    const code = String(new FormData(form).get("recoveryCode") || "").trim();
    setBusy(true);
    setMessage("");
    try {
      const { data: sessionData } = await client.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error("missing-session");
      const response = await fetch("/api/mfa-recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code }),
      });
      const payload = await readJsonBody(response);
      if (isTooManyAttempts(recoveryHttpError(response, payload))) {
        setMessage(t("mfa.tooManyAttempts"));
        return;
      }
      if (isRecoveryCodeRejected(response, payload)) {
        setMessage(t("mfa.recoveryRejected"));
        return;
      }
      if (!response.ok) {
        setMessage(t("mfa.recoveryUnavailable"));
        return;
      }
      await client.auth.signOut({ scope: "local" }).catch(() => {});
      onSignOut?.();
    } catch (error) {
      // Fetch failures, a missing AAL1 session, and any other throw are not a
      // refused recovery code. HTTP 400 code-not-accepted is classified above.
      setMessage(isTooManyAttempts(error) ? t("mfa.tooManyAttempts") : t("mfa.recoveryUnavailable"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <div className="sgauth-column">
        <div className="sgauth-brand">
          <BrandMark size={34} />
          <span className="sgauth-wordmark">{PRODUCT_NAME}</span>
        </div>
        <section className="auth-card sgauth-center" aria-labelledby="mfa-challenge-title">
          <span className="sgauth-icon" aria-hidden="true"><ShieldCheck size={20} /></span>
          <h1 id="mfa-challenge-title">{t("authlink.mfaTitle")}</h1>
          {/* The blurb stays the catalogue's, NOT the prototype's. The design
              offers "…or use your passkey" under a row of pre-filled code
              boxes; this challenge verifies TOTP factors and nothing else, so
              both are copy for a feature that does not exist. Telling a locked
              -out member to reach for a passkey they were never issued is the
              worst possible place to be aspirational. */}
          <p>{t("mfa.challengeBlurb")}</p>
          {/* This screen is the ONE surface guaranteed to reach a member whose
              factor was enrolled by someone else holding their inbox: the
              assurance boundary hides everything past it, including the in-app
              "an authenticator was added" notification. Tell them the way out
              here, where they are actually standing. */}
          <p className="sgauth-caution">{t("mfa.challengeNotYou")}</p>
          <form onSubmit={submit} noValidate>
            <label className="sgauth-codefield">
              <span>{t("mfa.codeLabel")}</span>
              <div>
                <AuthenticatorCodeInput className="sgauth-code" value={code} onChange={setCode} hintId={codeHintId} autoFocus />
              </div>
            </label>
            <p className="auth-requirements" id={codeHintId}>{t("mfa.codeHint")}</p>
            <BusyButton className="auth-submit" type="submit" pending={busy} disabled={!isAuthenticatorCode(code)}>
              {busy ? t("auth.working") : t("mfa.verify")}
            </BusyButton>
          </form>
          <details className="mfa-recovery-challenge">
            <summary>{t("mfa.useRecoveryCode")}</summary>
            <p>{t("mfa.recoveryChallengeBlurb")}</p>
            <form onSubmit={recover}>
              <label className="sgauth-codefield">
                <span>{t("mfa.recoveryCodeLabel")}</span>
                <div><input name="recoveryCode" autoComplete="one-time-code" pattern="[A-Za-z0-9\-]{18,32}" required aria-describedby={recoveryHintId} value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value.replace(/\s+/g, ""))} /></div>
              </label>
              <p className="auth-requirements" id={recoveryHintId}>{t("mfa.recoveryCodeHint")}</p>
              <BusyButton className="auth-submit" type="submit" pending={busy}>
                {busy ? t("auth.working") : t("mfa.recover")}
              </BusyButton>
            </form>
          </details>
          {message && <p className="auth-message auth-message--error" role="alert">{message}</p>}
          {/* Pending (refuses every activation) while a verification is in
              flight; it stays focusable. Otherwise the two race:
              sign-out clears the stored session, then the in-flight verify's
              successful response writes an aal2 session back, and the auth
              listener reopens the member's grievance data on a device they
              believe they just signed out of. On a shared workplace terminal that
              is the whole threat. */}
          <BusyButton className="auth-switch" type="button" onClick={onSignOut} pending={busy}>{t("mfa.signOutInstead")}</BusyButton>
        </section>
      </div>
    </main>
  );
}

function AccountSecurityExtensions({
  client,
  mfaVerified,
  recoveryCodeEnrollmentEnabled = true,
}) {
  const { t } = useLang();
  const [recovery, setRecovery] = useState(null);
  const [codes, setCodes] = useState([]);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  // Generate recovery codes stays focusable while the codes are made; this
  // synchronous lock refuses a second press before React commits busy.
  const busyWriteRef = useRef(new Set());

  const refresh = useCallback(async () => {
    const recoveryResult = mfaVerified
      ? await client.rpc("get_mfa_recovery_code_status")
      : { data: null, error: null };
    setRecovery(recoveryResult.error ? null : recoveryResult.data);
  }, [client, mfaVerified]);

  useEffect(() => { refresh().catch(() => { setRecovery(null); }); }, [refresh]);

  // The confirmation runs before the lock (prepareBusyWrite), so a cancelled
  // prompt takes nothing.
  function generateCodes() {
    return prepareBusyWrite(busyWriteRef, "extension", () => {
      if (busy || !mfaVerified || !recoveryCodeEnrollmentEnabled) return undefined;
      if (recovery?.generation > 0 && !window.confirm(t("mfa.recoveryRotateConfirm"))) return undefined;
      return async () => {
        setBusy("recovery"); setMessage(""); setCodes([]);
        try {
          const { data, error } = await client.rpc("generate_mfa_recovery_codes");
          if (error || !Array.isArray(data?.codes)) throw error || new Error("invalid-response");
          setCodes(data.codes);
          setRecovery({ ...data, unusedCount: data.codes.length, usedCount: 0 });
        } catch { setMessage(t("mfa.recoveryGenerateFailed")); } finally { setBusy(""); }
      };
    });
  }

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setMessage(t("mfa.recoveryCopied"));
    } catch { setMessage(t("mfa.recoveryCopyFailed")); }
  }

  return <div className="account-security-extensions">
    {/* Union Ground leaves out passkey, security-key and store-account
        (social) sign-in, so this panel offers only the TOTP recovery codes. */}
    <section className="security-extension" aria-labelledby="recovery-code-title">
      <div className="mfa-status">
        <ShieldCheck size={18} aria-hidden="true" />
        <div><strong id="recovery-code-title">{t("mfa.recoveryTitle")}</strong><small>{t("mfa.recoverySub")}</small></div>
      </div>
      {!mfaVerified && <p className="mfa-caution">{t("mfa.recoveryNeedsMfa")}</p>}
      {!recoveryCodeEnrollmentEnabled && <p className="mfa-caution">{t("mfa.recoveryDisabledByOrganization")}</p>}
      {mfaVerified && recoveryCodeEnrollmentEnabled && <p className="mfa-caution">{t("mfa.recoveryStorage")}</p>}
      {mfaVerified && recovery && recovery.generation > 0 && codes.length === 0 &&
        <p className="mfa-caution">{t("mfa.recoveryCount", { count: recovery.unusedCount })}</p>}
      {codes.length > 0 && <div className="recovery-code-display" role="status">
        <p>{t("mfa.recoveryDisplayOnce")}</p>
        <ul>{codes.map((code) => <li key={code}><code>{code}</code></li>)}</ul>
        <button className="dialog-secondary" type="button" onClick={copyCodes}>{t("mfa.recoveryCopy")}</button>
        <button className="dialog-secondary" type="button" onClick={() => setCodes([])}>{t("mfa.recoverySaved")}</button>
      </div>}
      <BusyButton className="dialog-primary" type="button" onClick={generateCodes} pending={Boolean(busy)}
        disabled={!mfaVerified || !recoveryCodeEnrollmentEnabled}>
        {busy === "recovery" ? t("auth.working") : recovery?.generation > 0 ? t("mfa.recoveryRotate") : t("mfa.recoveryGenerate")}
      </BusyButton>
    </section>
    {message && <p className="auth-message" role="status">{message}</p>}
  </div>;
}

export function MfaSettings({
  client,
  staffMfa = null,
  onStandingChanged = null,
  recoveryCodeEnrollmentEnabled = true,
  adminSetupPath = null,
  enrollmentRequired = false,
}) {
  const { t } = useLang();
  const workspace = useWorkspace();
  const adminReturnPath = safeAdminSetupPath(adminSetupPath);
  const [state, setState] = useState(IDLE);
  const [factors, setFactors] = useState([]);
  // Verified factors of a type MfaChallenge cannot verify. Counted, never
  // unenrolled here: removing a member's security factor without being asked is
  // destructive and irreversible, and the "turn off two-step" path that would
  // do it is unreachable for them anyway (it needs state === VERIFIED, which
  // needs a verified TOTP).
  const [otherVerified, setOtherVerified] = useState(0);
  const [challenge, setChallenge] = useState(null);
  // The typed code belongs to the QR it answers: a restart or a resumed
  // enrolment shows a new factor, and the box starts empty for it.
  const [enrollCode, setEnrollCode] = useState({ factorId: null, value: "" });
  const enrollCodeValue = challenge && enrollCode.factorId === challenge.factorId ? enrollCode.value : "";
  const enrollCodeHintId = useId();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [tone, setTone] = useState("info");
  const [loaded, setLoaded] = useState(false);
  // "We could not read whether your second factor is on" — distinct from "it is
  // off", because claiming the latter about the former is a lie about the
  // member's account security.
  const [unknown, setUnknown] = useState(false);
  // An unverified factor from an earlier page load, whose QR cannot be shown
  // again. Turning two-step on replaces it, and the member is told so first.
  const [earlierSetup, setEarlierSetup] = useState(false);
  // A double click must not enrol twice: the second QR would silently
  // replace the first one the member may already be scanning. Record 8435:
  // the factor writes (enrol, verify, turn off) share busy and stay focusable
  // while it is set, so they share this synchronous lock; the standing
  // refresh a member presses has its own.
  const busyWriteRef = useRef(new Set());
  // Bumped when an enrolment starts. A factor list read before that predates
  // the new factor and must not decide what the setup panel shows.
  const enrollEpoch = useRef(0);
  const enrollForm = useRef(null);
  useEffect(() => {
    if (state !== ENROLLING || !challenge) return;
    // Focus the start of setup, not the code box below the QR. Do this only
    // when setup opens so later renders never steal the typing caret.
    enrollForm.current?.focus({ preventScroll: true });
    enrollForm.current?.scrollIntoView?.({ block: "start", behavior: "instant" });
  }, [state, challenge]);

  const report = (text, nextTone) => { setMessage(text); setTone(nextTone); };

  // True while the shell re-reads staff standing after a factor change.
  const [restoringHats, setRestoringHats] = useState(false);
  // Turning two-step off retires the restore panel at once; it is about a
  // factor that is being removed.
  const [disabling, setDisabling] = useState(false);
  // REQ-UG-SECURITY-STATUS-HIERARCHY-20261102: turning two-step off
  // is asked for, then confirmed, below the routine setup and recovery tasks.
  const [confirmingOff, setConfirmingOff] = useState(false);
  // A turn-off failure is said inside the confirmation, beside its buttons,
  // and takes focus; the control sits at the end of the card, far from the
  // message slot above the recovery codes.
  // { text, seq }: a new object per failure, so a repeated failure with the
  // same words refocuses too.
  const [offError, setOffError] = useState(null);
  const offErrorSeq = useRef(0);
  const keepOnRef = useRef(null);
  const openOffRef = useRef(null);
  const offErrorRef = useRef(null);
  const statusRef = useRef(null);
  const focusAfterOff = useRef(null);
  const turnOffId = useId();
  useEffect(() => {
    if (confirmingOff) keepOnRef.current?.focus();
    else if (focusAfterOff.current === "open") openOffRef.current?.focus();
    if (!confirmingOff) focusAfterOff.current = null;
  }, [confirmingOff]);
  useEffect(() => { if (offError) offErrorRef.current?.focus(); }, [offError]);
  // Setting two-step up again starts from a closed control with no old error.
  useEffect(() => {
    if (state !== ENROLLING) return;
    setConfirmingOff(false);
    setOffError(null);
  }, [state]);

  async function refreshStanding() {
    if (!onStandingChanged) return;
    // The factor write already succeeded. A member-data refresh failure must
    // not turn that success into an MFA error or leave an unhandled rejection;
    // the normal reconnect/session refresh path will retry it.
    setRestoringHats(true);
    try { await onStandingChanged(); } catch { /* best-effort shell refresh */ }
    finally { setRestoringHats(false); }
  }

  // REQ-UG-STAFF-ROLE-PAUSE-AND-RESTORE-CLARITY-20261030 (finding 16):
  // a verified factor with staff roles still paused (for example after a
  // reload) asks the shell for the standing once on its own, and the Restore
  // control stays until the roles are back; when they come back while this
  // screen is open, it says so.
  const sawPausedRef = useRef(false);
  const autoRestoreRef = useRef(false);
  const [hatsRestored, setHatsRestored] = useState(false);
  useEffect(() => {
    if (staffMfa?.blocked) {
      sawPausedRef.current = true;
      setHatsRestored(false);
    } else if (sawPausedRef.current && staffMfa?.holdsStaffRole) {
      setHatsRestored(true);
    }
  }, [staffMfa?.blocked, staffMfa?.holdsStaffRole]);

  useEffect(() => {
    if (!staffMfa?.blocked || state !== VERIFIED || !onStandingChanged || autoRestoreRef.current) return;
    autoRestoreRef.current = true;
    refreshStanding();
    // refreshStanding reads only stable refs and the callback prop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staffMfa?.blocked, state, onStandingChanged]);

  const refresh = useCallback(async ({ removalsSucceeded = false } = {}) => {
    const epoch = enrollEpoch.current;
    try {
      const { data, error } = await client.auth.mfa.listFactors();
      if (error) throw error;
      if (epoch !== enrollEpoch.current) return;
      // `data.all` — NOT `data.totp`. auth-js types totp as
      // `Factor<K, 'verified'>[]`, so it never contains an unverified factor,
      // which meant the abandoned-enrolment cleanup below was filtering for
      // something that could not be in the list and had never removed anything.
      // Those invisible leftovers accumulate against the 10-factor cap until
      // enrolment stops working with an error the member cannot act on.
      const all = data?.all ?? [];
      const totp = all.filter((factor) => factor.factor_type === "totp");
      setFactors(totp);
      // A verified factor of a type this app cannot challenge is not "no second
      // factor", and telling its holder "your sign-in link alone signs you in"
      // is false. It is also not protecting them — private.mfa_satisfied() counts
      // TOTP only, so a phone or security key registered against this account
      // guards nothing here. Both halves of that are the member's business, so
      // say them instead of filtering the factor silently out of existence.
      setOtherVerified(all.filter((factor) => factor.factor_type !== "totp" && factor.status === "verified").length);
      const pending = totp.filter((factor) => factor.status === "unverified");
      for (const factorId of shownEnrollments.keys()) {
        if (!pending.some((factor) => factor.id === factorId)) shownEnrollments.delete(factorId);
      }
      const resumable = pending.filter((factor) => shownEnrollments.has(factor.id)).at(-1);
      if (totp.some((factor) => factor.status === "verified")) {
        setChallenge(null);
        setEarlierSetup(false);
        setState(VERIFIED);
      } else if (resumable) {
        // The member may have scanned this QR already: show the same one and
        // the code field again rather than "Off".
        setChallenge(shownEnrollments.get(resumable.id));
        setEarlierSetup(false);
        setState(ENROLLING);
      } else {
        setChallenge(null);
        setEarlierSetup(pending.length > 0);
        setState(IDLE);
      }
      setUnknown(false);
    } catch {
      // A failure to read factors must not claim MFA is off. Leaving `state` at
      // its IDLE default did exactly that: a member who HAS a verified factor
      // was told their sign-in link alone signs them in and offered a Turn On
      // button that then failed on a duplicate factor. An unreadable state is
      // its own state, and says so.
      setFactors([]);
      setOtherVerified(0);
      // Successful removals invalidate their old verified state. Do this with
      // the unknown result, so a pending read never flashes an off state or
      // resets recovery-code status before a fresh verified result arrives.
      if (removalsSucceeded) setState(IDLE);
      setUnknown(true);
    } finally {
      setLoaded(true);
    }
  }, [client]);

  useEffect(() => { refresh(); }, [refresh]);

  // Removes `discard` (factor ids), then enrols a new TOTP factor and shows
  // its QR. Only "Turn on" with nothing resumable and the explicit "Start
  // over" reach this, so a QR shown on this page is never replaced unasked.
  function enrollNew(discard) {
    return runBusyWrite(busyWriteRef, "factor", () => enrollNewNow(discard));
  }

  async function enrollNewNow(discard) {
    enrollEpoch.current += 1;
    setBusy(true);
    setMessage("");
    try {
      for (const factorId of discard) {
        shownEnrollments.delete(factorId);
        await client.auth.mfa.unenroll({ factorId }).catch(() => {});
      }
      // Without an issuer the authenticator app labels the entry with the
      // site's host name.
      const { data, error } = await client.auth.mfa.enroll({ factorType: "totp", issuer: PRODUCT_NAME });
      if (error) throw error;
      const shown = {
        factorId: data.id,
        qr: data.totp?.qr_code || "",
        secret: data.totp?.secret || "",
      };
      shownEnrollments.set(shown.factorId, shown);
      setChallenge(shown);
      setEarlierSetup(false);
      setState(ENROLLING);
    } catch (error) {
      report(memberMessage(error, t("mfa.enrollFailed")), "error");
    } finally {
      setBusy(false);
    }
  }

  function beginEnroll() {
    const stale = factors.filter((factor) => factor.status === "unverified");
    // A factor whose QR this page showed is resumed, never discarded.
    const resumable = stale.filter((factor) => shownEnrollments.has(factor.id)).at(-1);
    if (resumable) {
      setChallenge(shownEnrollments.get(resumable.id));
      setEarlierSetup(false);
      setState(ENROLLING);
      return undefined;
    }
    // Clear any half-finished factor from a previous abandoned attempt.
    // `factors` now comes from data.all, so these are actually visible here —
    // before this they never were, and every abandoned attempt leaked a slot.
    // The member was told above the button that the earlier QR stops working.
    return enrollNew(stale.map((factor) => factor.id));
  }

  // The explicit replacement: the member asked for a new QR and was told the
  // entry already in their app stops working.
  function restartEnroll() {
    const discard = new Set(factors.filter((factor) => factor.status === "unverified").map((factor) => factor.id));
    if (challenge?.factorId) discard.add(challenge.factorId);
    return enrollNew([...discard]);
  }

  function confirmEnroll(event) {
    event.preventDefault();
    return runBusyWrite(busyWriteRef, "factor", confirmEnrollNow, event);
  }

  async function confirmEnrollNow() {
    const code = enrollCodeValue;
    if (!isAuthenticatorCode(code)) return;
    setBusy(true);
    setMessage("");
    try {
      const { data: challengeData, error: challengeError } =
        await client.auth.mfa.challenge({ factorId: challenge.factorId });
      if (challengeError) throw challengeError;
      const { error } = await client.auth.mfa.verify({
        factorId: challenge.factorId,
        challengeId: challengeData.id,
        code,
      });
      if (error) throw error;
      // The verify succeeded, so the factor IS verified. Say so before the
      // factor re-read and standing refresh, so a slow or failed re-read can
      // never put "set up an authenticator" back beside "two-step is on".
      shownEnrollments.delete(challenge.factorId);
      setChallenge(null);
      // This verify refreshes the standing itself; no second automatic try.
      autoRestoreRef.current = true;
      setState(VERIFIED);
      if (onStandingChanged) setRestoringHats(true);
      // The status line above says "On" (and is announced); a second "two-step
      // is on" line under it only repeated it.
      setMessage("");
      await refresh();
      await refreshStanding();
    } catch (error) {
      // Wrong code is the common case and is not an emergency — keep the member
      // on the same screen with the secret still shown rather than dumping them
      // back to the start and forcing a re-scan.
      report(verifyErrorMessage(error, t), "error");
    } finally {
      setBusy(false);
    }
  }

  async function cancelEnroll() {
    if (challenge?.factorId) {
      shownEnrollments.delete(challenge.factorId);
      await client.auth.mfa.unenroll({ factorId: challenge.factorId }).catch(() => {});
    }
    setChallenge(null);
    setState(IDLE);
    setMessage("");
    await refresh();
  }

  // `inline`: the confirmation asked for this, so a failure is said there.
  // Resolves true only when every factor was removed; a press refused by the
  // lock resolves undefined and removes nothing.
  function disable(options) {
    return runBusyWrite(busyWriteRef, "factor", () => disableNow(options));
  }

  async function disableNow({ inline = false } = {}) {
    const fail = (text) => { if (inline) setOffError({ text, seq: ++offErrorSeq.current }); else report(text, "error"); };
    let removedAll = false;
    setBusy(true);
    setDisabling(true);
    setMessage("");
    setOffError(null);
    try {
      // Keep going after a failure instead of aborting on the first one, and
      // ALWAYS relist afterwards.
      //
      // Aborting was actively dangerous: with a working factor A and a dead
      // factor B, deleting A could succeed and deleting B fail, leaving only the
      // authenticator the member no longer has — turning "turn this off" into a
      // permanent lockout, while the screen kept its pre-failure state and said
      // nothing was wrong.
      let failed = 0;
      for (const factor of factors) {
        const { error } = await client.auth.mfa.unenroll({ factorId: factor.id });
        if (error) failed += 1;
      }
      if (failed > 0) fail(t("mfa.disablePartial", { count: failed }));
      else setMessage("");
      removedAll = failed === 0;
      await refresh({ removalsSucceeded: removedAll });
      await refreshStanding();
    } catch (error) {
      fail(memberMessage(error, t("mfa.disableFailed")));
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
      setDisabling(false);
    }
    return removedAll;
  }

  // The confirmation stays open until the removal settles; on success the
  // control is gone, so focus goes to the status line that now says Off.
  async function confirmTurnOff() {
    if (await disable({ inline: true })) {
      setConfirmingOff(false);
      statusRef.current?.focus();
    }
  }

  if (!loaded) return null;

  const turnOffAvailable = !unknown && state === VERIFIED && !enrollmentRequired;
  // An open confirmation stays while the factor list cannot be read after a
  // failed turn-off, so its alert stays beside the control.
  const turnOffShown = turnOffAvailable || (confirmingOff && unknown);

  return (
    <div className="mfa-settings">
      <div className="mfa-status" role="status" ref={statusRef} tabIndex={-1}>
        {state === VERIFIED ? <ShieldCheck size={18} aria-hidden="true" /> : <ShieldOff size={18} aria-hidden="true" />}
        <div>
          <strong>{t("mfa.title")}</strong>
          <small>{unknown ? t("mfa.unknownSub") : state === VERIFIED ? t("mfa.onSub") : state === ENROLLING && challenge ? t("mfa.settingUpSub") : t("mfa.offSub")}</small>
        </div>
      </div>

      <p className="mfa-caution">{t("mfa.appOnly")}</p>

      {/* BUG-UG-TWO-STEP-ON-BUT-STAFF-HATS-STILL-PAUSED-20261006:
          the server pauses hats only while no verified authenticator exists,
          so a verified one read here means the shell's standing is stale.
          Never tell the member to set up the app they just set up; say the
          hats are coming back and offer the same standing refresh again in
          case the automatic one did not land. */}
      {staffMfa?.blocked && state !== VERIFIED && (
        <p className="mfa-caution" role="status">{t("mfa.staffRequiredBlocked")}</p>
      )}

      {staffMfa?.blocked && state === VERIFIED && !disabling && (
        <>
          <p className="mfa-caution" role="status">{restoringHats ? t("mfa.staffHatsRestoring") : t("mfa.staffHatsRestorePending")}</p>
          {onStandingChanged && (
            <BusyButton className="dialog-secondary" type="button" onClick={() => runBusyWrite(busyWriteRef, "standing", refreshStanding)} pending={restoringHats || busy}>
              {restoringHats ? t("auth.working") : t("mfa.staffHatsRestore")}
            </BusyButton>
          )}
        </>
      )}

      {hatsRestored && !staffMfa?.blocked && (
        <p className="mfa-caution" role="status">{t("mfa.staffHatsRestored")}</p>
      )}

      {staffMfa?.required && staffMfa?.holdsStaffRole && !staffMfa?.blocked && (
        <p className="mfa-caution">{t("mfa.staffRequiredOn")}</p>
      )}

      {/* A new administrator sent here by the setup notice needs the way back
          once the factor exists and the staff roles are restored. */}
      {adminReturnPath && staffMfa?.required && staffMfa?.holdsStaffRole && !staffMfa?.blocked && state === VERIFIED && !disabling && (
        <p>
          <a
            href={adminReturnPath}
            onClick={(event) => {
              if (!workspace || !plainClick(event)) return;
              event.preventDefault();
              workspace.open(adminReturnPath, "admin");
            }}
          >{t("mfa.continueToAdmin")}</a>
        </p>
      )}

      {unknown && (
        <BusyButton className="dialog-secondary" type="button" onClick={() => refresh()} pending={busy}>
          {t("mfa.retry")}
        </BusyButton>
      )}

      {!unknown && otherVerified > 0 && (
        <p className="mfa-caution">{t("mfa.otherFactors", { count: otherVerified })}</p>
      )}

      {!unknown && state === IDLE && (
        <>
          {/* Said BEFORE they opt in, not after they are stuck. Turning this on
              is close to irreversible from the member's side: GoTrue refuses to
              unenrol a verified factor from the aal1 session a magic-link
              sign-in gives you. Losing the phone means asking an admin, so the
              member deserves to know that while the choice is still theirs. */}
          <p className="mfa-caution">{t("mfa.enrollCaution")}</p>
          {earlierSetup && <p className="mfa-caution" role="status">{t("mfa.earlierSetupReplaced")}</p>}
          <BusyButton className="dialog-primary" type="button" onClick={beginEnroll} pending={busy}>
            {busy ? t("auth.working") : t("mfa.enable")}
          </BusyButton>
        </>
      )}

      {state === ENROLLING && challenge && (
        <form ref={enrollForm} tabIndex={-1} aria-label={t("mfa.enable")} className="mfa-enroll stack-form" onSubmit={confirmEnroll} noValidate>
          <p>{t("mfa.scanBlurb")}</p>
          {challenge.qr && <img className="mfa-qr" src={challenge.qr} alt={t("mfa.qrAlt")} />}
          {/* The typed secret is the fallback for anyone who cannot scan — a
              desktop authenticator, a screen-reader user, or a second device. */}
          <label>
            <span>{t("mfa.secretLabel")}</span>
            <code className="mfa-secret">{challenge.secret}</code>
          </label>
          <label>
            <span>{t("mfa.codeLabel")}</span>
            <AuthenticatorCodeInput value={enrollCodeValue} onChange={(value) => setEnrollCode({ factorId: challenge.factorId, value })} hintId={enrollCodeHintId} />
          </label>
          <p className="mfa-caution" id={enrollCodeHintId}>{t("mfa.codeHint")}</p>
          <div className="mfa-actions">
            <BusyButton className="dialog-primary" type="submit" pending={busy} disabled={!isAuthenticatorCode(enrollCodeValue)}>
              {busy ? t("auth.working") : t("mfa.verify")}
            </BusyButton>
            <BusyButton className="dialog-secondary" type="button" onClick={cancelEnroll} pending={busy}>
              {t("mfa.cancel")}
            </BusyButton>
          </div>
          <p className="mfa-caution">{t("mfa.restartWarning")}</p>
          <div className="mfa-actions">
            <BusyButton className="dialog-secondary" type="button" onClick={restartEnroll} pending={busy}>
              {t("mfa.restart")}
            </BusyButton>
          </div>
        </form>
      )}

      {message && (
        <p className={`auth-message auth-message--${tone}`} role={tone === "error" ? "alert" : "status"}>
          {message}
        </p>
      )}
      {/* A turn-off failure whose control is gone (the factor list changed)
          still has to be said; it falls back to this slot. */}
      {offError && !turnOffShown && (
        <p className="auth-message auth-message--error" role="alert" ref={offErrorRef} tabIndex={-1}>
          {offError.text}
        </p>
      )}
      <AccountSecurityExtensions
        client={client}
        mfaVerified={!unknown && state === VERIFIED}
        recoveryCodeEnrollmentEnabled={recoveryCodeEnrollmentEnabled}
      />
      {turnOffShown && (
        <div className="mfa-turn-off">
          {confirmingOff ? (
            <div className="mfa-turn-off__confirm" role="group" aria-labelledby={`${turnOffId}-title`} aria-describedby={`${turnOffId}-body`}>
              <strong id={`${turnOffId}-title`}>{t("mfa.disableConfirmTitle")}</strong>
              <p className="mfa-caution" id={`${turnOffId}-body`}>
                {t("mfa.disableConfirmBody")}{staffMfa?.required && staffMfa?.holdsStaffRole ? ` ${t("mfa.disableConfirmStaff")}` : ""}
              </p>
              {offError && (
                <p className="auth-message auth-message--error" role="alert" ref={offErrorRef} tabIndex={-1}>
                  {offError.text}
                </p>
              )}
              <div className="mfa-actions">
                <BusyButton className="dialog-secondary mfa-turn-off__go" type="button" pending={busy} disabled={!turnOffAvailable} onClick={() => void confirmTurnOff()}>
                  {busy ? t("auth.working") : t("mfa.disableConfirm")}
                </BusyButton>
                <BusyButton ref={keepOnRef} className="dialog-secondary" type="button" pending={busy}
                  onClick={() => { focusAfterOff.current = "open"; setOffError(null); setConfirmingOff(false); }}>
                  {t("mfa.disableKeep")}
                </BusyButton>
              </div>
            </div>
          ) : (
            <BusyButton ref={openOffRef} className="mfa-turn-off__open" type="button" onClick={() => setConfirmingOff(true)} pending={busy}>
              {busy ? t("auth.working") : t("mfa.disable")}
            </BusyButton>
          )}
        </div>
      )}
    </div>
  );
}

// An organization-wide requirement must offer enrollment before member data
// can load. Auth enrollment stays reachable while RLS refuses that data.

// The screen App shows (lazily, by this export's name) when the member's
// organization requires two-step sign-in and the member has none yet: set it
// up here before any organization data loads, or sign out.
export function MfaEnrollment({ client, onCleared, onSignOut }) {
  const { t } = useLang();
  return <main className="auth-screen"><section className="auth-card">
    <h1>{t("mfa.organizationRequiredTitle")}</h1>
    <p>{t("mfa.organizationRequiredBody")}</p>
    <MfaSettings client={client} enrollmentRequired onStandingChanged={onCleared} />
    <button type="button" className="dialog-secondary" onClick={onSignOut}>{t("app.signOut")}</button>
  </section></main>;
}
