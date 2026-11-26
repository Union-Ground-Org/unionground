import { useId, useRef, useState } from "react";
import {
  learningErrorKind,
  learningPublicationIssues,
  learningPublicationState,
  learningSourceRequired,
  learningTransitionsFor,
  validateLearningTransition,
} from "./model.js";
import { formatLearningInstant, instantFromLocalInput } from "./time.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import { prepareBusyWrite } from "../../lib/busyWrite.js";

// Publish now, schedule, or withdraw the SAVED item at its exact revision.
// The readiness list mirrors the server's publication rule, and nothing is
// offered while unsaved edits would make the published text differ from the
// text on screen.
export function LearningPublicationPanel({ api, scope, item, dirty, tr, onChanged, onReload }) {
  const lang = scope.locale;
  const titleId = useId();
  const startId = useId();
  const endId = useId();
  const zoneId = useId();
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [status, setStatus] = useState({ kind: "idle" });
  // Record 8435: a synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());

  if (!item) {
    return (
      <section className="lc-panel" aria-labelledby={titleId}>
        <h3 className="lc-panel__title" id={titleId}>{tr("publish.title")}</h3>
        <p className="lc-status">{tr("publish.newFirst")}</p>
      </section>
    );
  }

  const blocking = learningPublicationIssues(item);
  const checks = [
    ["checkLocale", item.locale_state === "reviewed"],
    ["checkRights", Boolean(item.rights_note.trim())],
    ["checkReview", Boolean(item.review_note.trim())],
    ...(learningSourceRequired(item) ? [["checkSource", Boolean(item.source.trim())]] : []),
  ];
  const nowMs = Date.now();
  const state = learningPublicationState(item, nowMs);
  let stateText = tr(`state.${state}`);
  if (state === "upcoming") stateText = tr("state.upcoming", { start: formatLearningInstant(item.starts_at, lang) });
  if (state === "live" && item.ends_at) stateText = tr("state.liveUntil", { end: formatLearningInstant(item.ends_at, lang) });
  const offered = learningTransitionsFor(item.status);
  const working = status.kind === "working";
  // Record 8435: a publish or schedule is unavailable while a write runs
  // (pending, so focus stays) and natively disabled only for its own reasons.
  const publishReady = blocking.length === 0 && !dirty;
  const fieldIssues = (field) => (status.kind === "invalid" ? status.issues.filter((issue) => issue.field === field) : []);

  // Validation and a cancelled withdrawal start no write, so they stay
  // synchronous (prepareBusyWrite) and a corrected retry runs at once.
  function run(action) {
    return prepareBusyWrite(busyWriteRef, "publication", () => {
      if (dirty || working) return undefined;
      const start = action === "schedule" ? instantFromLocalInput(startsAt) : null;
      const end = action === "withdraw" ? null : instantFromLocalInput(endsAt);
      const issues = [];
      if (start === "invalid") issues.push({ field: "starts_at", code: "invalid_date" });
      if (end === "invalid") issues.push({ field: "ends_at", code: "invalid_date" });
      if (!issues.length) issues.push(...validateLearningTransition({ action, startsAt: start, endsAt: end, nowMs: Date.now() }));
      if (issues.length) {
        setStatus({ kind: "invalid", issues });
        return undefined;
      }
      if (action === "withdraw" && !window.confirm(tr("publish.withdrawConfirm"))) return undefined;
      return () => transitionNow(action, start, end);
    });
  }

  async function transitionNow(action, start, end) {
    setStatus({ kind: "working" });
    try {
      const next = await api.transition({ chapterId: scope.chapterId, id: item.id, action, expectedRevision: item.revision, startsAt: start, endsAt: end });
      setStartsAt("");
      setEndsAt("");
      setStatus({ kind: "done", action });
      onChanged(next);
    } catch (error) {
      setStatus({ kind: "error", errorKind: learningErrorKind(error) });
    }
  }

  const issueText = (issue) => tr(`issue.${issue.code}`);
  return (
    <section className="lc-panel" aria-labelledby={titleId}>
      <h3 className="lc-panel__title" id={titleId}>{tr("publish.title")}</h3>
      <p className="lc-publication__state"><span className="lc-chip">{tr(`status.${item.status}`)}</span> {stateText}</p>
      {dirty ? <p className="lc-status">{tr("publish.saveFirst")}</p> : null}
      <p className="lc-hint">{blocking.length === 0 ? tr("publish.ready") : tr("publish.notReady")}</p>
      <ul className="lc-checks">
        {checks.map(([key, done]) => (
          <li key={key} className={done ? "lc-checks__done" : "lc-checks__missing"}>
            <span aria-hidden="true">{done ? "✓" : "•"}</span> {tr(`publish.${key}`)}
            <span className="visually-hidden">{`: ${tr(done ? "publish.checkDone" : "publish.checkMissing")}`}</span>
          </li>
        ))}
      </ul>
      <div className="lc-window">
        <div className="lc-field">
          <label className="lc-field__label" htmlFor={startId}>{tr("publish.startsAt")}</label>
          <input id={startId} className="lc-input" type="datetime-local" value={startsAt} aria-invalid={fieldIssues("starts_at").length > 0 || undefined}
            aria-describedby={fieldIssues("starts_at").length ? `${zoneId} ${startId}-error` : zoneId} onChange={(event) => setStartsAt(event.target.value)} />
          {fieldIssues("starts_at").length ? <p className="lc-field__error" id={`${startId}-error`}>{fieldIssues("starts_at").map(issueText).join(" ")}</p> : null}
        </div>
        <div className="lc-field">
          <label className="lc-field__label" htmlFor={endId}>{tr("publish.endsAt")}</label>
          <input id={endId} className="lc-input" type="datetime-local" value={endsAt} aria-invalid={fieldIssues("ends_at").length > 0 || undefined}
            aria-describedby={fieldIssues("ends_at").length ? `${zoneId} ${endId}-error` : zoneId} onChange={(event) => setEndsAt(event.target.value)} />
          {fieldIssues("ends_at").length ? <p className="lc-field__error" id={`${endId}-error`}>{fieldIssues("ends_at").map(issueText).join(" ")}</p> : null}
        </div>
      </div>
      <p className="lc-hint" id={zoneId}>{tr("publish.timeZone", { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })}</p>
      <div className="lc-actions">
        {offered.includes("publish") ? <BusyButton type="button" className="lc-button" pending={working} disabled={!publishReady} onClick={() => run("publish")}>{tr("publish.publishNow")}</BusyButton> : null}
        {offered.includes("schedule") ? <BusyButton type="button" className="lc-button lc-button--quiet" pending={working} disabled={!publishReady} onClick={() => run("schedule")}>{tr("publish.schedule")}</BusyButton> : null}
        {offered.includes("withdraw") ? <BusyButton type="button" className="lc-button lc-button--danger" pending={working} disabled={dirty} onClick={() => run("withdraw")}>{tr("publish.withdraw")}</BusyButton> : null}
      </div>
      {working ? <p className="lc-status" role="status">{tr("publish.working")}</p> : null}
      {status.kind === "done" ? <p className="lc-status" role="status">{tr(`publish.done_${status.action}`)}</p> : null}
      {status.kind === "error" ? (
        <div className="lc-error" role="alert">
          <p>{tr(`error.${status.errorKind}`)}</p>
          {status.errorKind === "conflict" && onReload ? <button type="button" className="lc-button lc-button--quiet" onClick={onReload}>{tr("error.reload")}</button> : null}
        </div>
      ) : null}
    </section>
  );
}
