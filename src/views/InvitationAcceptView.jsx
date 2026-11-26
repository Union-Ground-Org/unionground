import { useCallback, useEffect, useRef, useState } from "react";
import { ResidenceAgeFields } from "../components/ResidenceAgeFields.jsx";
import { missingSentences } from "../components/LegalAcceptancePrompt.jsx";
import { BrandMark } from "../components/BrandMark.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import {
  LEGAL_CHANGELOG_PATH,
  LEGAL_INSTRUMENTS,
} from "../lib/legalInstruments.js";
import { loadPublishedWebVersions } from "../lib/legalReleaseBundle.js";
import { isResidenceRegion, RESIDENCE_REGIONS } from "../lib/residenceRegions.js";

const INVITATION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const scheduleRetry = (callback, delay) => window.setTimeout(callback, delay);
const cancelRetry = (timer) => window.clearTimeout(timer);
const TERMS_INSTRUMENT = "terms-of-use";
const ROLE_LABEL_KEYS = Object.freeze({
  member: "demo.hatMember",
  steward: "demo.hatSteward",
  coordinator: "demo.hatCoordinator",
  advisor: "demo.hatAdvisor",
  admin: "demo.hatAdmin",
  vp: "demo.hatVp",
});

// The address sits inside a translated sentence and is rendered as one
// wrapping, selectable unit (as on /request-invite), so a long one never
// overflows the card.
const ADDRESS_SLOT = "\u0000";
function addressSentence(t, key, email) {
  const [before, after = ""] = t(key, { email: ADDRESS_SLOT }).split(ADDRESS_SLOT);
  return <>{before}<strong className="iac-sent-address">{email}</strong>{after}</>;
}

// REQ-UG-INVITE-TERMS-AGE-STATE-FORM-CLARITY-20261030: what the
// server says about a pending invitation (api/invitation-preview.js). Only
// well-formed text is kept; anything else shows nothing rather than guesses.
function invitationPreview(payload) {
  const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const organization = text(payload?.organization);
  const email = text(payload?.email);
  if (!organization || !email) return null;
  return {
    organization,
    email,
    chapter: text(payload.chapter),
    inviter: text(payload.inviter),
    role: Object.hasOwn(ROLE_LABEL_KEYS, payload.role) ? payload.role : "member",
  };
}

function refreshedLegalPack(pack, language) {
  const entries = pack?.instruments;
  const acceptance = pack?.acceptance;
  const agePolicy = acceptance?.residenceAge;
  const text = (value) => typeof value === "string" && value.trim().length > 0;
  if (pack?.language !== language || !Array.isArray(entries)
      || entries.length !== LEGAL_INSTRUMENTS.length
      || new Set(entries.map((entry) => entry?.key)).size !== entries.length
      || !LEGAL_INSTRUMENTS.every((known) => entries.some((entry) => entry?.key === known.key))
      || !entries.every((entry) => /^\d+\.\d+\.\d+$/.test(entry.version)
        && /^\/legal\/[a-z-]+$/.test(entry.path) && text(entry.status)
        && text(entry.name) && text(entry.intro) && text(entry.notice)
        && Array.isArray(entry.sections) && entry.sections.length > 0
        && entry.sections.every((section) => text(section?.heading) && text(section?.body)))
      || !text(acceptance?.consent)
      || !RESIDENCE_REGIONS.every(({ code }) => ["adult", "band"].includes(agePolicy?.rules?.[code]))
      || !["state", "choose", "help", "adult", "band"].every((key) => text(agePolicy?.labels?.[key]))) {
    throw new Error("legal-pack-unavailable");
  }
  return { instruments: entries, acceptance, language };
}

// BUG-UG-INVITATION-FIRST-OPEN-SHOWS-UNAVAILABLE-20261030: the page
// scrubs the address bar to a bare /invite as soon as it loads, so the token
// used to live only in the memory of that first document. Any second load of
// the same tab (a reload, a browser or automation tool opening the current
// address again, a restored tab) then found no fragment and told a person
// whose invitation was still pending that it was "no longer available",
// without ever asking the server. The scrubbed token is now kept for this tab
// only, for at most 15 minutes (the emailed link's own lifetime), and removed
// as soon as the server gives a final answer, so the same tab resumes the
// clickwrap. Never localStorage, never the address bar, the DOM or a log.
export const PENDING_INVITATION_KEY = "union-ground.invitation-pending";
export const PENDING_INVITATION_LIFETIME_MS = 15 * 60 * 1000;
// REQ-UG-LOVABLE-PUBLIC-SITE-BATCH-B-PORT-20261103 (WEB-PUB-22): the
// server gives one answer for every spent token, so a reload of the bare
// /invite says "used" or "timed out" only when this tab knows it. After an
// acceptance the tab keeps a timestamp, never the token or an address.
export const ACCEPTED_INVITATION_KEY = "union-ground.invitation-accepted";
export const ACCEPTED_INVITATION_LIFETIME_MS = 24 * 60 * 60 * 1000;

function tabStorage() {
  try { return window.sessionStorage; } catch { return null; }
}

function forgetPendingInvitation() {
  try { tabStorage()?.removeItem(PENDING_INVITATION_KEY); } catch { /* storage may be unavailable */ }
}

function rememberAcceptedInvitation(now = Date.now()) {
  try { tabStorage()?.setItem(ACCEPTED_INVITATION_KEY, String(now)); } catch { /* storage may be unavailable */ }
}

function forgetAcceptedInvitation() {
  try { tabStorage()?.removeItem(ACCEPTED_INVITATION_KEY); } catch { /* storage may be unavailable */ }
}

function acceptedInThisTab(now = Date.now()) {
  let at;
  try { at = Number(tabStorage()?.getItem(ACCEPTED_INVITATION_KEY)); } catch { at = NaN; }
  if (at <= now && at > now - ACCEPTED_INVITATION_LIFETIME_MS) return true;
  forgetAcceptedInvitation();
  return false;
}

function keepPendingInvitation(token, now = Date.now()) {
  try {
    tabStorage()?.setItem(PENDING_INVITATION_KEY, JSON.stringify({ token, expiresAt: now + PENDING_INVITATION_LIFETIME_MS }));
  } catch { /* storage may be unavailable: the token stays in memory only */ }
}

// { token } while the tab still holds a live invitation, { timedOut: true }
// when it held one whose 15 minutes have passed, otherwise {}.
function readPendingInvitation(now = Date.now()) {
  let stored;
  try { stored = JSON.parse(tabStorage()?.getItem(PENDING_INVITATION_KEY) ?? "null"); } catch { stored = null; }
  const expiresAt = Number(stored?.expiresAt);
  const wellFormed = typeof stored?.token === "string" && INVITATION_TOKEN.test(stored.token);
  if (wellFormed && expiresAt > now && expiresAt <= now + PENDING_INVITATION_LIFETIME_MS) return { token: stored.token };
  forgetPendingInvitation();
  return wellFormed && expiresAt <= now ? { timedOut: true } : {};
}

// What the address bar brought: { token } for a usable invitation, otherwise
// the state the page opens in ("used", "timed-out" or "incomplete").
function takeFragmentSecret() {
  const hadQuery = Boolean(window.location.search);
  const fragment = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
  // Replace the complete visible URL before the secret crosses the network or
  // any result paints. Query-string delivery is refused even when the same
  // token also appears in the fragment: the query has already escaped the
  // fragment-only boundary and must not be normalized into a valid attempt.
  window.history.replaceState(window.history.state, "", "/invite");
  // A bare /invite is this tab loading its own scrubbed address again: resume
  // the invitation it already read, if there is one.
  if (!hadQuery && !fragment) {
    const pending = readPendingInvitation();
    if (pending.token) return { token: pending.token };
    if (acceptedInThisTab()) return { state: "used" };
    return { state: pending.timedOut ? "timed-out" : "incomplete" };
  }
  // Any other link replaces whatever this tab held before.
  forgetPendingInvitation();
  forgetAcceptedInvitation();
  if (hadQuery) return { state: "incomplete" };
  const params = new URLSearchParams(fragment);
  if ([...params.keys()].length !== 1 || !params.has("invite")) return { state: "incomplete" };
  const token = params.get("invite") || "";
  if (!INVITATION_TOKEN.test(token)) return { state: "incomplete" };
  keepPendingInvitation(token);
  return { token };
}

export function InvitationAcceptView({
  fetcher = (...args) => fetch(...args),
  // The preview read is separate from the acceptance exchange: it may fail or
  // be absent without changing what the page does.
  previewFetcher = (...args) => fetch(...args),
  schedule = scheduleRetry,
  cancelSchedule = cancelRetry,
}) {
  const { t, lang } = useLang();
  const started = useRef(false);
  const secret = useRef(null);
  // Set once the server has answered for the token (accepted or gone): only
  // then may a missing secret be described as a spent invitation.
  const spent = useRef(false);
  const messageRef = useRef(null);
  const termsRef = useRef(null);
  const refreshRequest = useRef(null);
  // Nothing is exchanged until the person has been shown
  // the versioned terms and has agreed to them. "terms" is the first state a
  // valid invitation reaches, and only the agree button leaves it.
  const [state, setState] = useState("checking");
  const [agreed, setAgreed] = useState(false);
  // The account is created only after the
  // person says which state they live in and confirms the age rule it selects.
  const [residenceState, setResidenceState] = useState("");
  const [ageAttested, setAgeAttested] = useState(false);
  //: an optional referral code from the member who brought this person in.
  const [referralCode, setReferralCode] = useState("");
  const [missingAgreement, setMissingAgreement] = useState(false);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(0);
  const [legalPack, setLegalPack] = useState({ instruments: LEGAL_INSTRUMENTS, acceptance: null });
  const { instruments, acceptance } = legalPack;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [preview, setPreview] = useState(null);
  const termsVersion = instruments.find((entry) => entry.key === TERMS_INSTRUMENT)?.version ?? "";
  const shownLanguage = useRef(lang);

  useEffect(() => () => { refreshRequest.current?.abort(); refreshRequest.current = null; }, []);

  // A language switch replaces an in-flight or settled refreshed pack: the
  // previous request is aborted, so only the newest language's response can
  // land .
  async function readNewTerms(language = lang, { supersede = false } = {}) {
    if (refreshRequest.current && !supersede) return;
    refreshRequest.current?.abort();
    const controller = new AbortController();
    refreshRequest.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 8000);
    setRefreshing(true);
    setRefreshFailed(false);
    setAgreed(false);
    setAgeAttested(false);
    setMissingAgreement(false);
    // The language context already names the catalogue currently on screen.
    try {
      const response = await fetcher(`/api/legal-pack?lang=${language}`, {
        cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal,
      });
      if (!response.ok) throw new Error("legal-pack-unavailable");
      const next = refreshedLegalPack(await response.json(), language);
      if (refreshRequest.current !== controller || controller.signal.aborted) return;
      setLegalPack(next);
      setState("terms");
    } catch {
      if (refreshRequest.current === controller) setRefreshFailed(true);
    } finally {
      window.clearTimeout(timer);
      if (refreshRequest.current === controller) {
        refreshRequest.current = null;
        setRefreshing(false);
      }
    }
  }

  const exchange = useCallback(async () => {
    if (!secret.current) {
      setState(spent.current ? "unavailable" : "incomplete");
      return;
    }
    setState("checking");
    setRetryAfterSeconds(0);
    try {
      const response = await fetcher("/api/accept-invitation", {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        // The versions this page displayed. The route refuses anything but the
        // versions in force and stores exactly these, so the recorded
        // acceptance always names the text that was on the screen. Only the
        // agree button reaches this, after a state was chosen and both boxes
        // were checked.
        body: JSON.stringify({
          token: secret.current,
          acceptedVersions: await loadPublishedWebVersions(instruments, undefined, fetcher),
          residenceState,
          ageAttested: true,
          ...(referralCode.trim() ? { referralCode: referralCode.trim() } : {}),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      // The server's final answer (consumed, revoked, expired or unknown) is
      // the only thing that says the invitation is gone.
      if (response.status === 410) {
        secret.current = null;
        spent.current = true;
        forgetPendingInvitation();
        setState("unavailable");
        return;
      }
      // The published versions moved while this page was open. Nothing was
      // accepted and nothing was recorded; the page has to be read again.
      // The invitation went to a government or employer address, which can
      // never be an account address; the server ended it.
      if (response.status === 400 && payload?.error === "email-domain-blocked") {
        secret.current = null;
        spent.current = true;
        forgetPendingInvitation();
        setState("domain-blocked");
        return;
      }
      if (response.status === 409 && payload?.error === "terms-version-stale") {
        setState("stale");
        return;
      }
      const retryAfter = Math.min(120, Math.max(1, Math.ceil(Number(payload?.retryAfterSeconds))));
      if (response.status === 409
          && payload?.error === "acceptance-in-progress"
          && Number.isFinite(retryAfter)) {
        setRetryAfterSeconds(retryAfter);
        setState("waiting");
        return;
      }
      if (!response.ok || payload?.accepted !== true) {
        setState(response.status >= 500 && response.status < 600 ? "server-error" : "retry");
        return;
      }
      // Drop the app-owned secret. The password travels only through the
      // transactional email provider and never enters this response or DOM.
      secret.current = null;
      spent.current = true;
      forgetPendingInvitation();
      rememberAcceptedInvitation();
      // A former member's acceptance re-activated an existing account: no
      // password travels anywhere, the member signs in as before.
      setState(payload?.reactivated === true ? "reactivated" : "continuing");
    } catch {
      setState("retry");
    }
  }, [fetcher, residenceState, instruments, referralCode]);

  const complete = agreed && ageAttested && isResidenceRegion(residenceState);
  const agree = useCallback(() => {
    if (!complete) {
      setMissingAgreement(true);
      return;
    }
    setMissingAgreement(false);
    exchange();
  }, [complete, exchange]);

  useEffect(() => {
    // React Strict Mode replays effects; this ref keeps the one-time fragment
    // consumption single-shot within that replay. The endpoint is not claimed
    // here any more: the agree button is the only thing that claims it.
    if (started.current) return;
    started.current = true;
    const arrival = takeFragmentSecret();
    secret.current = arrival.token ?? null;
    // The secret stays in memory (and this tab's session storage) while the
    // clickwrap is on screen: an acceptance that must be shown before it is
    // taken cannot also be exchanged on load. The visible URL is already
    // scrubbed, and nothing writes the token to the DOM or a log. A link with
    // no usable token says only that: nothing was asked of the server, so the
    // page cannot say the invitation is gone.
    setState(secret.current ? "terms" : arrival.state);
    // Name the organization, role, inviter and address before anything is
    // accepted. A failed or refused read leaves the page as it was.
    if (secret.current) {
      Promise.resolve().then(() => previewFetcher("/api/invitation-preview", {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: secret.current }),
      })).then((response) => (response?.ok ? response.json() : null))
        .then((payload) => setPreview(invitationPreview(payload)))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // BUG-UG-INVITATION-REFRESHED-TERMS-LANGUAGE-20261025: consent
  // given to the text in one language is never carried into another. A pack
  // refreshed from the server (or still being fetched) is read again in the
  // new language before the clickwrap returns.
  useEffect(() => {
    if (shownLanguage.current === lang) return;
    shownLanguage.current = lang;
    setAgreed(false);
    setAgeAttested(false);
    setMissingAgreement(false);
    if ((state === "terms" || state === "stale") && (legalPack.language || refreshRequest.current)) {
      setState("stale");
      readNewTerms(lang, { supersede: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  useEffect(() => {
    if (["retry", "server-error", "waiting", "unavailable", "incomplete", "timed-out", "stale", "domain-blocked"].includes(state)) messageRef.current?.focus();
    if (state === "terms") termsRef.current?.focus();
  }, [state]);

  useEffect(() => {
    if (state !== "waiting" || retryAfterSeconds < 1) return undefined;
    const timer = schedule(exchange, retryAfterSeconds * 1000);
    return () => cancelSchedule(timer);
  }, [cancelSchedule, exchange, retryAfterSeconds, schedule, state]);

  const waiting = state === "waiting";
  const retryable = state === "retry" || state === "server-error";
  const failed = retryable || waiting || state === "unavailable" || state === "incomplete" || state === "timed-out"
    || state === "stale" || state === "domain-blocked";
  const done = state === "continuing" || state === "reactivated";
  const used = state === "used";
  const clickwrap = state === "terms";
  return (
    <main className="auth-screen iac-screen">
      <section className="auth-card iac-card" aria-labelledby="invitation-title">
        <span className="iac-brand"><BrandMark size={40} /></span>
        <span className="eyebrow">{t("inviteAccept.eyebrow")}</span>
        <h1 id="invitation-title" className="iac-title">{t("inviteAccept.title")}</h1>
        {clickwrap && <div className="iac-state">
          <p>{t("inviteAccept.passwordFlow")}</p>
          <p><strong>{t("auth.passwordMinimum")}</strong></p>
        </div>}
        {clickwrap && (
          <div className="iac-state iac-terms">
            <h2 ref={termsRef} tabIndex="-1">{t("inviteAccept.terms.title")}</h2>
            {preview && <div className="iac-preview">
              <p><strong>{t("inviteAccept.preview.invited", { organization: preview.organization, role: t(ROLE_LABEL_KEYS[preview.role]) })}</strong></p>
              {preview.chapter && <p>{t("inviteAccept.preview.chapter", { chapter: preview.chapter })}</p>}
              {preview.inviter && <p>{t("inviteAccept.preview.inviter", { inviter: preview.inviter })}</p>}
              <p className="iac-sent-to">{addressSentence(t, "inviteAccept.preview.email", preview.email)}</p>
            </div>}
            <p>{t("inviteAccept.terms.body")}</p>
            <p>{t("inviteAccept.terms.version", { version: termsVersion })}</p>
            {instruments.some((entry) => entry.status !== "operative") && <p>{t("legal.instrument.notOperative")}</p>}
            <p>{t("inviteAccept.terms.read")}</p>
            <ul className="iac-terms-list">
              {instruments.map((entry) => (
                <li key={entry.key} className={entry.sections?.[0]?.body ? "iac-terms-reader-item" : undefined}>
                  {/* BUG-UG-INVITATION-REFRESHED-LEGAL-READER-ALIGNMENT-20261020:
                      the refreshed text reads as a left-aligned document under
                      one disclosure marker (styles: .iac-terms-reader). */}
                  {entry.sections?.[0]?.body ? <details className="iac-terms-reader">
                    <summary>{t("inviteAccept.terms.instrument", { name: entry.name, version: entry.version })}</summary>
                    <p>{entry.intro}</p>
                    <p>{entry.notice}</p>
                    {entry.sections.map((section, index) => <section key={index}>
                      <h3>{section.heading}</h3><p>{section.body}</p>
                    </section>)}
                  </details> : <a href={entry.path} target="_blank" rel="noopener noreferrer">
                    {t("inviteAccept.terms.instrument", {
                      name: t(entry.summaryTitleKey),
                      version: entry.version,
                    })}
                  </a>}
                </li>
              ))}
              <li><a href={LEGAL_CHANGELOG_PATH} target="_blank" rel="noopener noreferrer">{t("legal.instrument.links.changelog")}</a></li>
            </ul>
            <label className="iac-consent" htmlFor="invitation-agree">
              <input
                id="invitation-agree"
                type="checkbox"
                checked={agreed}
                onChange={(event) => setAgreed(event.target.checked)}
              />
              {acceptance ? acceptance.consent : t("inviteAccept.terms.consent")}
            </label>
            <ResidenceAgeFields
              idPrefix="invitation"
              agePolicy={acceptance?.residenceAge}
              residenceState={residenceState}
              onResidenceState={setResidenceState}
              ageAttested={ageAttested}
              onAgeAttested={setAgeAttested}
              selectLabelClassName="iac-consent"
              checkLabelClassName="iac-consent"
            />
            <div className="iac-referral">
              <label htmlFor="invitation-referral-code">{t("inviteAccept.referralLabel")}</label>
              <input
                id="invitation-referral-code"
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={16}
                value={referralCode}
                aria-describedby="invitation-referral-hint"
                onChange={(event) => setReferralCode(event.target.value)}
              />
              <small id="invitation-referral-hint">{t("inviteAccept.referralHint")}</small>
            </div>
            {missingAgreement && !complete && (
              <p className="iac-consent-error" role="alert">{missingSentences(t, "inviteAccept.terms", agreed, residenceState, ageAttested)}</p>
            )}
            <button type="button" className="iac-action" onClick={agree}>
              {t("inviteAccept.terms.action")}
            </button>
            <a className="iac-back" href="/">{t("inviteAccept.back")}</a>
          </div>
        )}
        {used && (
          <div className="iac-state" role="status">
            <span className="iac-glyph" aria-hidden="true">✓</span>
            <h2>{t("inviteAccept.usedTitle")}</h2>
            <p>{t("inviteAccept.usedBody")}</p>
            <a className="iac-action" href="/m">{t("inviteAccept.signIn")}</a>
            <a className="iac-back" href="/get-app">{t("inviteAccept.getApp")}</a>
          </div>
        )}
        {!clickwrap && !failed && !used && (
          <div className="iac-state" role="status" aria-live="polite">
            <span className="iac-glyph" aria-hidden="true">{done ? "✓" : "↻"}</span>
            <h2>{t(state === "reactivated" ? "inviteAccept.reactivated" : state === "continuing" ? "inviteAccept.continuing" : "inviteAccept.checking")}</h2>
            <p>{t(state === "reactivated" ? "inviteAccept.reactivatedBody" : state === "continuing" ? "inviteAccept.continuingBody" : "inviteAccept.checkingBody")}</p>
            {state === "continuing" && <p><strong>{t("auth.passwordMinimum")}</strong></p>}
            {done && preview && <p>{t("inviteAccept.preview.invited", { organization: preview.organization, role: t(ROLE_LABEL_KEYS[preview.role]) })}</p>}
            {done && preview && <p className="iac-sent-to">{addressSentence(t, "inviteAccept.signInWith", preview.email)}</p>}
            {done && <p>{t("inviteAccept.terms.recorded", { version: termsVersion })}</p>}
            {done && <a className="iac-action" href="/m">{t("inviteAccept.signIn")}</a>}
            {done && <a className="iac-back" href="/get-app">{t("inviteAccept.getApp")}</a>}
          </div>
        )}
        {failed && (
          <div ref={messageRef} className="iac-state" role="alert" tabIndex="-1">
            <span className="iac-glyph" aria-hidden="true">!</span>
            <h2>{t(state === "unavailable"
              ? "inviteAccept.unavailable"
              : state === "incomplete" ? "inviteAccept.incompleteTitle"
              : state === "timed-out" ? "inviteAccept.timedOutTitle"
              : state === "domain-blocked" ? "inviteAccept.domainBlockedTitle"
              : state === "stale" ? "inviteAccept.staleTitle"
                : waiting ? "inviteAccept.waitingTitle"
                  : state === "server-error" ? "inviteAccept.serverTitle" : "inviteAccept.retryTitle")}</h2>
            <p>{t(state === "unavailable"
              ? (preview?.inviter ? "inviteAccept.unavailableBodyNamed" : "inviteAccept.unavailableBody")
              : state === "incomplete" ? "inviteAccept.incompleteBody"
              : state === "timed-out" ? "inviteAccept.timedOutBody"
              : state === "domain-blocked" ? "inviteAccept.domainBlockedBody"
              : state === "stale" ? "inviteAccept.staleBody"
                : waiting ? "inviteAccept.waitingBody"
                  : state === "server-error" ? "inviteAccept.serverBody" : "inviteAccept.retryBody", { seconds: retryAfterSeconds, inviter: preview?.inviter ?? "" })}</p>
            {waiting && <button type="button" className="iac-action" disabled>{t("inviteAccept.waitingAction")}</button>}
            {state === "stale" && <button type="button" className="iac-action" disabled={refreshing} onClick={() => readNewTerms()}>
              {t(refreshing ? "inviteAccept.refreshing" : "inviteAccept.staleAction")}
            </button>}
            {state === "stale" && refreshFailed && <p>{t("inviteAccept.refreshFailed")}</p>}
            {retryable && <button type="button" className="iac-action" onClick={exchange}>{t("inviteAccept.retry")}</button>}
            {/* WEB-PUB-22: a link that cannot be used names the way on: sign
                in for someone who already accepted, and the invite request
                for someone who has no usable invitation email. */}
            {["unavailable", "incomplete", "timed-out"].includes(state) && <>
              <p>{t("inviteAccept.alreadyAccepted")} <a className="iac-back" href="/m">{t("inviteAccept.signIn")}</a></p>
              <p>{t("inviteAccept.noInvitation")} <a className="iac-back" href="/request-invite">{t("requestInvite.link")}</a></p>
            </>}
            <a className="iac-back" href="/">{t("inviteAccept.back")}</a>
          </div>
        )}
        <p className="iac-legal">{t("inviteAccept.legalNotice")} <a href="/privacy" target="_blank" rel="noopener noreferrer">{t("hub.privacy")}</a> · <a href="/terms" target="_blank" rel="noopener noreferrer">{t("hub.terms")}</a></p>
      </section>
    </main>
  );
}
