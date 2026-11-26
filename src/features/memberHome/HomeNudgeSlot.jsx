import { useEffect, useId, useMemo, useState } from "react";
import { ListChecks } from "lucide-react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { NUDGES_RPC, chooseHomeNudge, normalizeHomeNudges } from "./nudges.js";
import "./homeNudges.css";

// REQ-UG-HOME-NUDGES-20261001: web half of the one-at-a-time Home nudge
// slot. The organization's switches and the member's onboarding progress come
// from get_member_home_nudges(). Dismissals and the shown-this-week marker
// stay in this browser. Union Ground offers no passkey sign-in, so only the
// onboarding nudge runs (the shared policy is told passkeys are unsupported,
// as the native app does).
export function historyKey(userId) {
  return userId ? `ug-home-nudges:v1:${userId}` : null;
}

export function readHistory(key) {
  try {
    const value = key ? JSON.parse(window.localStorage.getItem(key) || "{}") : {};
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}

export function writeHistory(key, value) {
  try { if (key) window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* history stays in memory */ }
}

function sessionShown(userId, kind) {
  try { return window.sessionStorage.getItem(`ug-home-nudge-shown:v1:${userId}:${kind}`) === "1"; } catch { return false; }
}

function markSessionShown(userId, kind) {
  try { window.sessionStorage.setItem(`ug-home-nudge-shown:v1:${userId}:${kind}`, "1"); } catch { /* best effort */ }
}

export function HomeNudgeSlot({ data, transport = null, welcomeTourActive = false, onOpenOnboarding = null }) {
  const { t } = useLang();
  const titleId = useId();
  const userId = data?.member?.id ?? null;
  const key = historyKey(userId);
  const preview = transport?.preview === true;
  const accessToken = typeof transport?.session?.access_token === "string" ? transport.session.access_token : null;
  const createSessionClient = typeof transport?.createSessionClient === "function" ? transport.createSessionClient : null;
  const [server, setServer] = useState(null);
  const [history, setHistory] = useState(() => readHistory(key));

  useEffect(() => { setHistory(readHistory(key)); }, [key]);

  useEffect(() => {
    if (preview || !accessToken || !createSessionClient) { setServer(null); return undefined; }
    let active = true;
    let client;
    try { client = createSessionClient({ access_token: accessToken }); } catch { client = null; }
    if (!client || typeof client.rpc !== "function") return undefined;
    Promise.resolve(client.rpc(NUDGES_RPC))
      .then((result) => { if (active) setServer(result?.error ? null : normalizeHomeNudges(result?.data)); })
      .catch(() => { if (active) setServer(null); });
    return () => { active = false; };
  }, [preview, accessToken, createSessionClient]);

  const nudge = useMemo(() => chooseHomeNudge({
    server,
    welcomeTourActive,
    passkeySupported: false,
    hasPasskey: null,
    signedInAt: null,
    history: { onboarding: { ...(history.onboarding ?? {}), shownThisSession: userId ? sessionShown(userId, "onboarding") : false } },
    now: Date.now(),
  }), [server, welcomeTourActive, history, userId]);

  // Record when a nudge first appears in this session (the weekly cap).
  useEffect(() => {
    if (!nudge || !userId || sessionShown(userId, nudge.kind)) return;
    markSessionShown(userId, nudge.kind);
    const next = { ...readHistory(key), [nudge.kind]: { ...(readHistory(key)[nudge.kind] ?? {}), shownAt: Date.now() } };
    writeHistory(key, next);
    setHistory(next);
  }, [nudge, userId, key]);

  if (!nudge) return null;
  const dismiss = () => {
    const next = { ...readHistory(key), [nudge.kind]: { ...(readHistory(key)[nudge.kind] ?? {}), dismissedAt: Date.now() } };
    writeHistory(key, next);
    setHistory(next);
  };
  return (
    <section className="home-nudge" aria-labelledby={titleId}>
      <span className="home-nudge__icon" aria-hidden="true"><ListChecks size={18} /></span>
      <div className="home-nudge__copy">
        <h2 id={titleId}>{t("homeNudge.onboardingTitle")}</h2>
        <p>{t("homeNudge.onboardingBody", { step: nudge.completed + 1, total: nudge.total })}</p>
      </div>
      <div className="home-nudge__actions">
        {onOpenOnboarding ? <button type="button" className="home-nudge__primary" onClick={onOpenOnboarding}>{t("homeNudge.onboardingAction")}</button> : null}
        <button type="button" className="home-nudge__later" aria-label={t("homeNudge.notNowOnboarding")} onClick={dismiss}>{t("homeNudge.notNow")}</button>
      </div>
    </section>
  );
}
