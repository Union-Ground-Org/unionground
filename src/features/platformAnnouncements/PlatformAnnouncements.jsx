import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as React from "react";
import { ANNOUNCEMENT_PAGE, announcementScope, createAnnouncementApi } from "./api.js";
import { announcementCopy } from "./copy.js";
import { useAnnouncementFeedWith } from "./useAnnouncementFeed.js";
import { useLearningUndone } from "../learningPeriod/undoneSignal.js";
import { PlatformAnnouncementPublisher } from "./PlatformAnnouncementPublisher.jsx";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite, useBusyScope } from "../../lib/busyWrite.js";
import "./platformAnnouncements.css";

// A captured-session client prevents a late request from adopting another
// session. The keyed child discards memory synchronously at every scope change.
function Boundary({ context, locale, settings = false }) {
  const scope = announcementScope({ ...context, locale });
  const { preview, restricted, createClient, session, organizationId } = context ?? {};
  const client = useMemo(() => scope && !preview && !restricted ? createClient?.(session) : null,
    [scope, preview, restricted, createClient, session]);
  const api = useMemo(() => client ? createAnnouncementApi(client, organizationId) : null, [client, organizationId]);
  if (!scope || !api) return null;
  return settings ? <AnnouncementSettingsSession key={scope} api={api} locale={locale} />
    : <AnnouncementReaderSession key={scope} api={api} locale={locale} />;
}
// Whether the reader below draws anything for this context: a preview, a
// restricted session or a missing scope or client renders nothing.
export function platformAnnouncementsShown(context, locale = "en") {
  const { preview, restricted, createClient } = context ?? {};
  return Boolean(announcementScope({ ...context, locale }) && !preview && !restricted && typeof createClient === "function");
}
export function PlatformAnnouncements({ context, locale = "en" }) { return <Boundary context={context} locale={locale} />; }
export function PlatformAnnouncementSettings({ context, locale = "en" }) { return <Boundary context={context} locale={locale} settings />; }

export function AnnouncementReaderSession({ api, locale }) {
  const c = announcementCopy(locale);
  const { state, refresh, clear, preference } = useAnnouncementFeedWith(React, api, locale, true, { keepOnFailedSave: true });
  // #7027: an undo of hiding or showing updates re-reads whether they are hidden.
  useLearningUndone(["own_platform_update_preference"], () => { void refresh(); });
  const [admin, setAdmin] = useState(false);
  const [localError, setLocalError] = useState(false);
  const [backgrounded, setBackgrounded] = useState(false);
  // Record 8435: hiding or showing the feed keeps its own pending mark, set and
  // cleared by that write alone. The feed's own busy flag is reset by a blur,
  // a refresh or an expiry while the write still runs, and the feed refuses a
  // second preference until it settles, so the controls read pending for
  // exactly as long as a press is refused. Session scope changes remount this
  // reader (the boundary keys it), which ends both together.
  const [preferring, setPreferring] = useState(false);
  const busyWriteRef = useRef(new Set());
  const busy = state.busy || preferring;
  const setHidden = (hidden) => runBusyWrite(busyWriteRef, "preference", async () => {
    setPreferring(true);
    try { await preference(hidden); } finally { setPreferring(false); }
  });
  // Hiding one update for the organization keeps its own pending mark next to
  // its own lock, both cleared when that hide settles: a refresh that shows
  // the same update again before then shows its button pending, not ready.
  // The completion re-reads the feed, and reports a refusal, only while this
  // reader is still mounted. The boundary remounts it for every scope change
  // (organization, chapter, user, session, hat, language); a same-login token
  // renewal builds a new api but keeps this reader, so the fence follows the
  // mount, not the api object. The mark and the lock are released either way.
  const [hiding, setHiding] = useState(() => new Set());
  const readerScope = useBusyScope("mounted reader");
  const hideLocal = (item) => runBusyWrite(busyWriteRef, `hide-local:${item.id}`, async () => {
    const generation = readerScope.generation;
    setHiding((ids) => new Set(ids).add(item.id));
    clear(); setLocalError(false);
    try { await api.hideLocal(item.id); } catch { if (readerScope.isCurrent(generation)) setLocalError(true); } finally {
      setHiding((ids) => { const next = new Set(ids); next.delete(item.id); return next; });
      if (readerScope.isCurrent(generation)) void refresh();
    }
  });
  useEffect(() => { let live = true; api.settings().then(() => { if (live) setAdmin(true); }).catch(() => {}); return () => { live = false; }; }, [api]);
  useEffect(() => {
    const hide = () => { clear(); setBackgrounded(true); };
    const focus = () => {
      if (document.visibilityState !== "visible") return;
      setBackgrounded(false);
      void refresh();
    };
    const visibility = () => document.visibilityState === "visible" ? focus() : hide();
    window.addEventListener("blur", hide); window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("blur", hide); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visibility); };
  }, [clear, refresh]);
  return <section className="pa-panel ph-no-capture" data-sentry-mask="true" aria-label={c.title}>
    <h3>{c.title}</h3>
    <p>{c.notice}</p>
    <div className="pa-actions">
      <BusyButton className="pa-button" pending={state.loading || busy} onClick={() => { setBackgrounded(false); void refresh(); }}>{c.refresh}</BusyButton>
      <BusyButton className="pa-button" pending={state.loading || busy} onClick={() => { void setHidden(!state.hidden); }}>{state.hidden ? c.undo : c.hide}</BusyButton>
    </div>
    {state.saveFailed || localError ? <p role="alert">{c.saveFailed}</p> : null}
    {/* #9465: an organization hide clears the list until it re-reads; that is loading, not "no updates". */}
    <p role="status">{state.loading || hiding.size ? c.loading : state.expired ? c.expired : state.saveFailed || localError ? "" : state.error ? c.unavailable : state.hidden ? c.hidden : !state.items.length ? (backgrounded ? c.backgrounded : c.empty) : ""}</p>
    {state.items.map(item => <article key={`${state.generation}:${item.id}`} className="pa-post" data-source-type="platform-announcement">
      <h4>{item.title}</h4><p>{item.body}</p><time dateTime={item.publishedAt}>{new Date(item.publishedAt).toLocaleDateString(locale)}</time>
      {admin ? <BusyButton className="pa-button" pending={busy || hiding.has(item.id)} onClick={() => { void hideLocal(item); }}>{c.hideLocal}</BusyButton> : null}
    </article>)}
    {state.items.length === ANNOUNCEMENT_PAGE ? <button className="pa-button" onClick={() => { void refresh(state.items.at(-1)); }}>{c.older}</button> : null}
  </section>;
}

export function AnnouncementSettingsSession({ api, locale }) {
  const c = announcementCopy(locale);
  const [state, setState] = useState({ loading: true, settings: null, publisher: null, error: false });
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [saved, setSaved] = useState(false);
  const [followFailed, setFollowFailed] = useState(false); // or the copy key of its line
  // Record 8435: a synchronous write lock for following, refused before React
  // commits busy. Only follow's own finally clears busy, and a session scope
  // change remounts this panel, which ends both together.
  const busyWriteRef = useRef(new Set());
  const run = useRef(0);
  const reload = useCallback(async () => {
    const current = ++run.current;
    setState({ loading: true, settings: null, publisher: null, error: false });
    const [settings, publisher] = await Promise.allSettled([api.settings(), api.workspace()]);
    if (current !== run.current) return;
    setState({ loading: false, settings: settings.status === "fulfilled" ? settings.value : null,
      publisher: publisher.status === "fulfilled" ? publisher.value : null,
      error: [settings, publisher].some(result => result.status === "rejected" && !result.reason?.denied) });
  }, [api]);
  useEffect(() => { void reload(); return () => { run.current += 1; }; }, [reload]);
  function follow(enabled) {
    return runBusyWrite(busyWriteRef, "follow", () => followNow(enabled));
  }
  async function followNow(enabled) {
    if (busy || !state.settings) return;
    const current = ++run.current; setBusy(true); setSaved(false); setFollowFailed(false); setConfirm(false);
    try {
      const settings = await api.follow(enabled, state.settings.generation);
      if (current === run.current) { setState({ ...state, settings, error: false }); setSaved(true); }
    } catch {
      // Re-read only the settings (a newer generation), never the publisher:
      // reloading it unmounts the publisher and drops an unsaved draft (#9469).
      if (current !== run.current) return;
      // The write may have landed without its answer: say what the re-read
      // shows; if it fails too, hold the control rather than act on a cache.
      const settings = await api.settings().catch(() => null); // swallow-ok: answered below
      if (current !== run.current) return;
      if (!settings) { setFollowFailed("followUnconfirmed"); return; }
      setState(previous => ({ ...previous, settings }));
      if (settings.enabled === enabled) setSaved(true); else setFollowFailed("saveFailed");
    }
    finally { if (current <= run.current) setBusy(false); }
  }
  // Reads only the follow settings, never the publisher, so a draft stays.
  function check() { return runBusyWrite(busyWriteRef, "follow", () => checkNow()); }
  async function checkNow() {
    const current = ++run.current; setBusy(true);
    const settings = await api.settings().catch(() => null); // swallow-ok: the line stays
    if (settings && current === run.current) { setState(previous => ({ ...previous, settings })); setFollowFailed(false); }
    setBusy(false);
  }
  const unconfirmed = followFailed === "followUnconfirmed";
  if (!state.loading && !state.error && !state.settings && !state.publisher) return null;
  return <section className="pa-panel ph-no-capture" data-sentry-mask="true" aria-label={c.settings}>
    <h3>{c.settings}</h3>
    {state.loading ? <p role="status">{c.loading}</p> : null}
    {state.error ? <p role="alert">{c.unavailable}</p> : null}
    {state.settings ? <>
      <p>{c.notice}</p>{unconfirmed ? null : <p>{state.settings.enabled ? c.following : c.stopped}</p>}
      {unconfirmed ? <BusyButton className="pa-button" pending={busy} onClick={() => { void check(); }}>{c.checkFollow}</BusyButton> : confirm ? <div role="group" aria-label={c.revoke}><p>{c.confirm}</p><div className="pa-actions">
        <BusyButton className="pa-button" pending={busy} onClick={() => { void follow(false); }}>{c.yes}</BusyButton>
        <BusyButton className="pa-button" pending={busy} onClick={() => setConfirm(false)}>{c.cancel}</BusyButton>
      </div></div> : <BusyButton className="pa-button" pending={busy} onClick={() => state.settings.enabled ? setConfirm(true) : void follow(true)}>{state.settings.enabled ? c.revoke : c.follow}</BusyButton>}
      {saved ? <p role="status">{c.saved}</p> : null}
      {followFailed ? <p role="alert">{c[followFailed]}</p> : null}
    </> : null}
    <BusyButton className="pa-button" pending={busy || state.loading} onClick={() => { setSaved(false); void reload(); }}>{c.refresh}</BusyButton>
    {state.publisher ? <PlatformAnnouncementPublisher key={locale} api={api} locale={locale} initial={state.publisher} /> : null}
  </section>;
}
