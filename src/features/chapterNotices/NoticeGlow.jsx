import { useEffect, useMemo, useRef, useState } from "react";
import { BusyButton, BusyInput } from "../../components/BusyControls.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";
import { CHAPTER_NOTICE_GLOWS, createNoticeGlowApi, forgetNoticeChapters, noticeTileGlow } from "./noticeGlow.js";
import "./noticeGlow.css";

// REQ-UG-CHAPTER-NOTICE-GLOW-COLOURS-20261113 (#8627).

// The attributes that make a notice tile glow, or none.
export function noticeGlowAttributes(tile) {
  if (!tile) return {};
  return { "data-glow": tile.glow, ...(tile.breathe ? { "data-glow-breathe": "" } : {}) };
}

// The words on a glowing tile: its urgency word when it has one, and the
// chapter's name, so the colour is never the only way to tell either.
export function NoticeGlowLabels({ notice, chapter }) {
  const { t } = useLang();
  const tile = noticeTileGlow(notice, chapter);
  if (!tile) return null;
  return <>
    {tile.wordKey ? <strong className="notice-glow__word">{t(tile.wordKey)}</strong> : null}
    {chapter?.name ? <span className="notice-glow__from">{t("noticeGlow.from", { chapter: chapter.name })}</span> : null}
  </>;
}

// The chapter setting: four named colours. Offered only when the server says
// the caller may change it (the roles that can publish the chapter's
// announcements); a refused read offers nothing.
// BUG-UG-CHAPTER-NOTICE-COLOUR-SETTING-VANISHES-ON-A-FAILED-READ-20261125
// (#9995, from #9465): any other failed read says the colour could not be
// loaded, with Try again. Its lock and pending state belong to one chapter;
// while it runs a loading line replaces the alert, so a second failure is
// announced again; and after it lands the chosen colour takes focus only if
// Try again still held it and no other control took it since.
// #9995: a refusal is one of these codes; an error with no code at all
// is a refusal when its HTTP status is 403 or 404. Any other code is a failed
// read, whatever the status.
const NO_CONTROL_CODES = new Set(["42501", "not_authorized", "PGRST202", "42883"]);

function readOffersNoControl(error) {
  const code = error?.code;
  if (code !== undefined && code !== null && code !== "") return NO_CONTROL_CODES.has(String(code));
  return error?.status === 403 || error?.status === 404;
}

export function NoticeGlowControl({ client, chapterId }) {
  const { t } = useLang();
  const api = useMemo(() => createNoticeGlowApi(client), [client]);
  const [value, setValue] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const generation = useRef(0);
  // #9995: the failure and the pending retry belong to one client and
  // chapter, so a reused control never shows the previous chapter's.
  const [failedFor, setFailedFor] = useState(null);
  const [retryingFor, setRetryingFor] = useState(null);
  const isCurrent = (scope) => Boolean(scope) && scope.api === api && scope.chapterId === chapterId;
  const loadFailed = isCurrent(failedFor);
  const retrying = isCurrent(retryingFor);
  const busyWriteRef = useRef(new Set());
  const retryRef = useRef(null);
  const choicesRef = useRef(null);
  const focusChoiceRef = useRef(false);
  useEffect(() => {
    if (!focusChoiceRef.current) return;
    focusChoiceRef.current = false;
    const active = globalThis.document?.activeElement;
    if (active && active !== globalThis.document.body && active !== retryRef.current) return;
    const choices = choicesRef.current;
    (choices?.querySelector("input:checked") || choices?.querySelector("input"))?.focus();
  });
  // The colours are pending, not disabled, while one saves. They
  // need no write lock: a colour is chosen by a discrete change, which React
  // commits (busy, so the next colour refuses) before the next change runs. A
  // new client or chapter clears busy below, and the generation check drops a
  // late answer from the earlier one.
  useEffect(() => {
    const current = ++generation.current;
    setValue(null); setBusy(false); setStatus(null); setFailedFor(null); setRetryingFor(null);
    if (!api || !chapterId) return undefined;
    void read(current);
    return () => { generation.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, chapterId]);
  function read(current, retried = false) {
    return api.load(chapterId).then((result) => {
      if (current !== generation.current) return;
      // Checked before the commit that removes Try again.
      if (retried && retryRef.current && retryRef.current === globalThis.document?.activeElement) focusChoiceRef.current = true;
      setValue(result); setFailedFor(null);
    }, (error) => {
      // Not this caller's to change, or an older backend: no control.
      if (current === generation.current) setFailedFor(readOffersNoControl(error) ? null : { api, chapterId });
    });
  }
  function retry() {
    const current = generation.current;
    return runBusyWrite(busyWriteRef, `retrying:${current}`, async (releaseBusyWrite) => {
      setRetryingFor({ api, chapterId });
      try { await read(current, true); } finally {
        if (current === generation.current) setRetryingFor(null);
        releaseBusyWrite();
      }
    });
  }
  if (loadFailed) {
    return <div className="institutional-form notice-glow-choice">
      <h4>{t("noticeGlow.title")}</h4>
      {retrying
        ? <p key="loading" role="status">{t("noticeGlow.loading")}</p>
        : <p key="failed" role="alert">{t("noticeGlow.loadError")}</p>}
      {/* #9995 Sol r1: leaving Try again while it is still on the page cancels the pending focus move. */}
      <BusyButton ref={retryRef} type="button" pending={retrying} onClick={() => void retry()} onBlur={(event) => { if (event.currentTarget.isConnected) focusChoiceRef.current = false; }}>{t("noticeGlow.retry")}</BusyButton>
    </div>;
  }
  if (!value?.canChange) return null;
  async function choose(colour) {
    const current = generation.current;
    setBusy(true); setStatus(null);
    let next = value;
    let outcome = "saved";
    try {
      await api.save(chapterId, colour);
      forgetNoticeChapters();
      // An earlier chapter's save answering late reads nothing more.
      if (current !== generation.current) return;
      next = { ...value, glow: colour };
      try { next = await api.load(chapterId); } catch { outcome = "reloadError"; }
    } catch { outcome = "saveError"; }
    if (current !== generation.current) return;
    setValue(next);
    setStatus(outcome);
    setBusy(false);
  }
  return <fieldset className="institutional-form notice-glow-choice">
    <legend><h4>{t("noticeGlow.title")}</h4></legend>
    <p>{t("noticeGlow.help")}</p>
    <div className="notice-glow-choice__options" ref={choicesRef}>
      {CHAPTER_NOTICE_GLOWS.map((colour) => (
        <label key={colour} className="notice-glow-choice__option notice-glow" data-glow={colour}>
          <BusyInput type="radio" name={`notice-glow-${chapterId}`} value={colour} checked={value.glow === colour} pending={busy} onChange={() => void choose(colour)} />
          <span className="notice-glow-choice__swatch" data-glow={colour} aria-hidden="true" />
          {t(`noticeGlow.${colour}`)}
        </label>
      ))}
    </div>
    {status ? <p role={status === "saved" ? "status" : "alert"}>{t(`noticeGlow.${status}`)}</p> : null}
  </fieldset>;
}
