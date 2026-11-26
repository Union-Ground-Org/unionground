import { useEffect, useId, useRef, useState } from "react";
import { CONNECTION_ISSUE_TOPICS, CONNECTION_SIGNAL_KINDS } from "./contract.js";
import { proposeConnectionIssueTags } from "./signals.js";
import { connectionCopy } from "../../lib/i18n/connectionSuggestions.js";
// The ID hint is website-only copy, so it lives in the web catalogue that the
// phone never imports, not in the shared Connections namespace (#9469).
import { t } from "../../lib/i18n.js";
import { BusyButton, BusyInput, BusySelect, BusyTextarea } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";

// Source text stays in this component's memory. Only reviewed taxonomy keys and
// a source reference reach the server, which rechecks source access and scope.
export function ReviewedIssueSignals({ workspace, adapter, preview, lang = "en", onRefresh }) {
  const tr = connectionCopy(lang);
  const [kind, setKind] = useState("grievance");
  const [sourceId, setSourceId] = useState("");
  const [text, setText] = useState("");
  const [topics, setTopics] = useState([]);
  const [confirmed, setConfirmed] = useState(false);
  const [freezeConsent, setFreezeConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435), keyed by the record the write changes.
  const busyWriteRef = useRef(new Set());
  const [status, setStatus] = useState("");
  const sourceIdHint = useId();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const latestTopics = [...new Set((Array.isArray(workspace.analysis?.latest?.topics) ? workspace.analysis.latest.topics : []).map((topic) => topic?.key).filter((key) => CONNECTION_ISSUE_TOPICS.includes(key)))];
  // Correcting the ID keeps the text and tags; the confirmation ("I reviewed
  // this source") and the last notice no longer apply to the new ID, so they
  // clear (#9469). A new source type starts over.
  const resetReview = () => { setText(""); setTopics([]); setConfirmed(false); setStatus(""); };
  const save = (event) => runBusyWrite(busyWriteRef, `signals:${workspace.chapterId}`, () => saveNow(event), event);
  const saveNow = async (event) => {
    event.preventDefault(); setBusy(true); setStatus("");
    try {
      if (!preview) await adapter.reviewSource(workspace.chapterId, kind, sourceId.trim(), topics);
      if (!mounted.current) return;
      resetReview(); setSourceId(""); setStatus(preview ? "reviewPreviewSaved" : "reviewSaved");
    } catch { if (mounted.current) setStatus("reviewError"); }
    finally { if (mounted.current) setBusy(false); }
  };
  const freeze = () => runBusyWrite(busyWriteRef, `signals:${workspace.chapterId}`, () => freezeNow());
  const freezeNow = async () => {
    setBusy(true); setStatus("");
    try {
      if (!preview) await adapter.freezeIssues(workspace.chapterId);
      if (!mounted.current) return;
      setFreezeConsent(false); setStatus(preview ? "freezePreview" : "freezeSaved");
      if (!preview) onRefresh();
    } catch { if (mounted.current) setStatus("freezeError"); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <details className="cs-analysis oi-card">
    <summary>{tr("reviewTitle")}</summary>
    <p>{tr("reviewIntro")}</p>
    {status && <p role="status" className="oi-notice">{tr(status)}</p>}
    <form onSubmit={save}>
      <div className="oi-form__grid">
        <label className="oi-field">{tr("sourceKind")}<BusySelect value={kind} pending={busy} onChange={(event) => { setKind(event.target.value); resetReview(); }}>{CONNECTION_SIGNAL_KINDS.map((key) => <option key={key} value={key}>{tr(key)}</option>)}</BusySelect></label>
        <label className="oi-field">{tr("sourceId")}<BusyInput required maxLength={36} pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" aria-describedby={sourceIdHint} value={sourceId} pending={busy} onChange={(event) => { setSourceId(event.target.value); setConfirmed(false); setStatus(""); }} /></label>
      </div>
      <p id={sourceIdHint} className="cs-note">{t(lang, "hub.connections.sourceIdHint")}</p>
      <label className="oi-field">{tr("sourceText")}<BusyTextarea maxLength={10000} rows={4} value={text} pending={busy} onChange={(event) => { setText(event.target.value); setConfirmed(false); }} /></label>
      <p className="cs-note">{tr("localAnalysis")}</p>
      <BusyButton type="button" className="oi-button oi-button--secondary" pending={busy} disabled={!text.trim()} onClick={() => { setTopics(proposeConnectionIssueTags({ sourceKind: kind, text }).proposals.map((item) => item.key)); setConfirmed(false); setStatus("proposalsReady"); }}>{tr("propose")}</BusyButton>
      <fieldset className="cs-checklist"><legend>{tr("reviewedTopics")}</legend>{CONNECTION_ISSUE_TOPICS.map((key) => <label key={key}><BusyInput type="checkbox" pending={busy} checked={topics.includes(key)} onChange={(event) => { setTopics((prior) => event.target.checked ? [...prior, key] : prior.filter((item) => item !== key)); setConfirmed(false); }} />{tr(key)}</label>)}</fieldset>
      <label className="cs-consent"><BusyInput type="checkbox" pending={busy} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{tr("reviewConsent")}</label>
      <BusyButton className="oi-button" type="submit" pending={busy} disabled={!confirmed || !sourceId.trim()}>{tr("saveReview")}</BusyButton>
    </form>
    <div className="cs-quarter">
      <h3>{tr("quarterTitle")}{workspace.analysis?.nextPeriodKey ? ` · ${workspace.analysis.nextPeriodKey}` : ""}</h3>
      <p>{tr("quarterHelp")}</p>
      {workspace.analysis?.latest && <p>{tr("latestThemes")}: {latestTopics.length ? latestTopics.map(tr).join(", ") : tr("suppressedThemes")}</p>}
      {workspace.analysis?.nextPeriodFrozen ? <p>{tr("alreadyFrozen")}</p> : <><label className="cs-consent"><BusyInput type="checkbox" checked={freezeConsent} pending={busy} onChange={(event) => setFreezeConsent(event.target.checked)} />{tr("freezeConsent")}</label><BusyButton type="button" className="oi-button oi-button--secondary" pending={busy} disabled={!freezeConsent} onClick={freeze}>{tr("freeze")}</BusyButton></>}
    </div>
  </details>;
}
