import { Inbox } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import "../../lib/i18n/features/intakeQueueStrings.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";
import { caseExportFilename } from "../../lib/caseExport.js";
import { useLang } from "../../lib/LanguageContext.jsx";
import { localeFor } from "../../lib/i18n/format.js";
import { DATE_TIME_WITH_ZONE_OPTIONS, formatDateTimeWithZone } from "../../lib/i18n/zonedDates.js";
import { PLANE_CARD_CLASS } from "../../lib/staffPlaneStyles.js";
import { TopicUpdatePanel } from "./TopicUpdatePanel.jsx";
import { FounderInvitationPanel } from "./FounderInvitationPanel.jsx";
import { focusedElement, useSuccessFocus } from "./useSuccessFocus.js";
import { WorkspaceCardTitle, WorkspaceCardHead } from "../../components/WorkspacePages.jsx";
import {
  EASTERN,
  INTAKE_KINDS,
  INTAKE_STATUSES,
  INTAKE_TOPICS,
  NOTE_MAX,
  PAGE_SIZE,
  PASS_REFUSALS,
  PASS_SEARCH_LIMIT,
  PASS_SEARCH_MIN,
  SEARCH_MAX,
  countsByKind,
  dailyTotals,
  intakeCsv,
  intakeFailureKind,
  intakeFilters,
  inviteRowIds,
  isAccessFailure,
  passOrganizations,
  passesBySubmission,
  replyHref,
  vocabularyKey,
  withPass,
} from "./intakeApi.js";

// People waiting (REQ-UG-INTAKE-QUEUE-PEOPLE-WAITING-ADMIN-PAGE-20261118):
// the platform operator's view of everyone who asked Union Ground for updates,
// an invite or to join. Everything goes through `requestReview(action,
// payload)`, which resolves to the route's result or rejects with
// `{ status, error, reason }`. A refusal of access (not an intake reviewer, no
// second factor, or the demo) replaces the whole page with one neutral
// sentence and shows no data. What people typed is their own text, so it is
// shown as text and never as a link; dates are Eastern.

const P = "intakeQueue";
const SECTION_ID = "admin-people-waiting";
const ROOT_CLASS = `${PLANE_CARD_CLASS} xus-card role-section-target`;
const EASTERN_STAMP = Object.freeze({ ...DATE_TIME_WITH_ZONE_OPTIONS, timeZone: EASTERN });

function stamp(value, lang) {
  return formatDateTimeWithZone(value, lang, EASTERN_STAMP);
}

function dayLabel(day, lang) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  return new Intl.DateTimeFormat(localeFor(lang), { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
}

// The browser download for the export. Tests pass their own.
function downloadCsv(csv, now = new Date()) {
  const filename = caseExportFilename("people-waiting", now);
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return filename;
  const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return filename;
}

function Term({ label, children }) {
  return <div className="xus-verifier-term"><dt>{label}</dt><dd>{children}</dd></div>;
}

function Summary({ summary, t, lang }) {
  const byKind = countsByKind(summary?.counts);
  const days = dailyTotals(summary?.daily);
  const total = days.reduce((sum, row) => sum + row.total, 0);
  const peak = days.reduce((best, row) => (row.total > (best?.total ?? 0) ? row : best), null);
  const max = Math.max(1, ...days.map((row) => row.total));
  const topics = (Array.isArray(summary?.topics) ? summary.topics : [])
    .filter((row) => vocabularyKey(INTAKE_TOPICS, row?.topic));
  const people = Number.isInteger(summary?.updatePeople) ? summary.updatePeople : 0;
  const trendLabel = total === 0
    ? t(`${P}.trendEmpty`)
    : t(`${P}.trendLabel`, { total, peak: peak.total, day: dayLabel(peak.day, lang) });
  return <section className="xus-intake-summary" aria-label={t(`${P}.summaryHeading`)}>
    <ul className="xus-intake-stats">
      {INTAKE_KINDS.map((kind) => <li key={kind} className="xus-intake-stat">
        <span className="xus-intake-statname">{t(`${P}.kind.${kind}`)}</span>
        <span className="xus-intake-statvalue">{byKind[kind].total}</span>
        <span className="xus-note">{INTAKE_STATUSES.map((status) => t(`${P}.statusCount`, { status: t(`${P}.status.${status}`), count: byKind[kind][status] })).join(" · ")}</span>
        {kind === "updates" && <span className="xus-note">{t(`${P}.updatePeople`, { count: people })}</span>}
      </li>)}
    </ul>
    {topics.length > 0 && <p className="xus-note">{t(`${P}.topicsLead`)} {topics.map((row) => t(`${P}.topicCount`, { topic: t(`${P}.topic.${row.topic}`), count: Number(row.count) || 0 })).join(" · ")}</p>}
    <figure className="xus-intake-trend">
      <figcaption className="xus-note">{t(`${P}.trendHeading`)}</figcaption>
      <div className="xus-intake-bars" role="img" aria-label={trendLabel}>
        {days.map((row) => <span key={row.day} className="xus-intake-bar" style={{ blockSize: `${Math.round((row.total / max) * 100)}%` }} title={`${dayLabel(row.day, lang)}: ${row.total}`} />)}
      </div>
      <p className="xus-note">{trendLabel}</p>
      {total > 0 && <details className="xus-intake-days">
        <summary>{t(`${P}.trendTable`)}</summary>
        <table>
          <thead><tr><th scope="col">{t(`${P}.day`)}</th>{INTAKE_KINDS.map((kind) => <th scope="col" key={kind}>{t(`${P}.kind.${kind}`)}</th>)}</tr></thead>
          <tbody>{days.filter((row) => row.total > 0).map((row) => <tr key={row.day}>
            <th scope="row">{dayLabel(row.day, lang)}</th>
            {INTAKE_KINDS.map((kind) => <td key={kind}>{row[kind]}</td>)}
          </tr>)}</tbody>
        </table>
      </details>}
    </figure>
  </section>;
}

// REQ-UG-INTAKE-QUEUE-SEND-INVITATION-FROM-ROW-20261118 (owner
// option b): an invite request is passed to an existing organization's
// administrators, who approve or decline it under Requests. The operator
// finds the organization by the start of its name, chooses it and confirms.
function PassPanel({ row, passes, t, lang, dataLang, busy, onSearch, onPass, onPassed }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(row.organizationName ?? "");
  const [found, setFound] = useState({ state: "idle", organizations: [] });
  const [chosen, setChosen] = useState(null);
  const searchId = useId();
  const listId = useId();
  const name = row.name || row.email;

  async function find(event) {
    event.preventDefault();
    const text = query.trim();
    setChosen(null);
    if ([...text].length < PASS_SEARCH_MIN) { setFound({ state: "short", organizations: [] }); return; }
    setFound({ state: "searching", organizations: [] });
    const result = await onSearch(text.slice(0, SEARCH_MAX));
    if (result === null) { setFound({ state: "failed", organizations: [] }); return; }
    setFound({ state: "ready", organizations: passOrganizations(result) });
  }

  function close() {
    setOpen(false);
    setChosen(null);
    setFound({ state: "idle", organizations: [] });
  }

  async function confirm(event) {
    const started = focusedElement();
    if (await onPass(row, chosen, event)) {
      close();
      onPassed?.(started);
    }
  }

  return <section className="xus-intake-pass" aria-label={t(`${P}.pass.heading`)}>
    {passes.length > 0 && <div>
      <p className="xus-note"><strong>{t(`${P}.pass.sentTo`)}</strong></p>
      <ul className="xus-intake-passes">
        {passes.map((pass) => <li key={pass.organizationId} className="xus-note">{t(`${P}.pass.entry`, {
          organization: pass.organizationName,
          chapter: pass.chapterName,
          date: stamp(pass.passedAt, lang),
          status: t(`${P}.pass.status.${pass.status || "unknown"}`),
        })}</li>)}
      </ul>
    </div>}
    {!open && <button className="xus-btn" type="button" disabled={Boolean(busy)} onClick={() => setOpen(true)}>{t(`${P}.pass.open`)}</button>}
    {open && <div className="xus-intake-passform">
      <p className="xus-note">{t(`${P}.pass.lead`)}</p>
      <form className="xus-verifier-toolbar" onSubmit={find}>
        <label className="xus-field" htmlFor={searchId}>{t(`${P}.pass.search`)}
          <input id={searchId} className="xus-input" type="search" maxLength={SEARCH_MAX} value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <BusyButton className="xus-btn" type="submit" pending={found.state === "searching"}>{t(`${P}.pass.find`)}</BusyButton>
        <button className="xus-btn" type="button" onClick={close}>{t(`${P}.pass.cancel`)}</button>
      </form>
      <p className="xus-note" role="status" aria-live="polite">
        {found.state === "short" && t(`${P}.pass.searchShort`)}
        {found.state === "failed" && t(`${P}.pass.refusal.other`)}
        {found.state === "ready" && found.organizations.length === 0 && t(`${P}.pass.noMatches`)}
        {found.state === "ready" && found.organizations.length >= PASS_SEARCH_LIMIT && t(`${P}.pass.matchesCapped`)}
      </p>
      {found.state === "ready" && found.organizations.length > 0 && <fieldset className="xus-intake-passmatches">
        <legend id={listId}>{t(`${P}.pass.matches`)}</legend>
        {found.organizations.map((organization) => <label key={organization.id}>
          <input type="radio" name={`pass-${row.id}`} value={organization.id} checked={chosen?.id === organization.id} onChange={() => setChosen(organization)} />
          <span lang={dataLang}>{organization.name}</span>
        </label>)}
      </fieldset>}
      {chosen && <div>
        <p className="xus-note">{t(`${P}.pass.confirm`, { name, organization: chosen.name })}</p>
        <BusyButton className="xus-btn xus-btn--go" type="button" pending={busy === "pass"} disabled={Boolean(busy)} onClick={confirm}>{t(`${P}.pass.submit`)}</BusyButton>
      </div>}
    </div>}
  </section>;
}

function RequestItem({ row, t, lang, dataLang, onStatus, onNote, onSearch, onPass, onFounder, onSucceeded, busy }) {
  const [status, setStatus] = useState(row.status);
  const [note, setNote] = useState(row.operatorNote ?? "");
  const statusId = useId();
  const noteId = useId();
  // Take a newly saved status or note from the row only when it changes, in
  // render rather than in an effect, so a mount-time effect can never land
  // after (and undo) an edit the operator has just made.
  const [seen, setSeen] = useState({ status: row.status, note: row.operatorNote ?? "" });
  if (seen.status !== row.status || seen.note !== (row.operatorNote ?? "")) {
    if (seen.status !== row.status) setStatus(row.status);
    if (seen.note !== (row.operatorNote ?? "")) setNote(row.operatorNote ?? "");
    setSeen({ status: row.status, note: row.operatorNote ?? "" });
  }
  const kind = vocabularyKey(INTAKE_KINDS, row.kind);
  const topic = vocabularyKey(INTAKE_TOPICS, row.topic);
  const known = vocabularyKey(INTAKE_STATUSES, row.status);
  const href = replyHref(row, t(kind ? `${P}.replySubject.${kind}` : `${P}.replySubject.updates`));
  const name = row.name || row.email;
  return <li className="xus-verifier-item">
    <h4 className="xus-etitle"><span lang={dataLang}>{name}</span></h4>
    <p className="xus-note">{t(kind ? `${P}.kind.${kind}` : `${P}.kind.unknown`)} · {t(known ? `${P}.status.${known}` : `${P}.status.unknown`)}</p>
    <dl className="xus-verifier-terms">
      <Term label={t(`${P}.email`)}><span lang={dataLang}>{row.email}</span></Term>
      {topic && <Term label={t(`${P}.topicLabel`)}>{t(`${P}.topic.${topic}`)}</Term>}
      {row.organizationName && <Term label={t(`${P}.organization`)}><span lang={dataLang}>{row.organizationName}</span></Term>}
      {row.role && <Term label={t(`${P}.role`)}><span lang={dataLang}>{row.role}</span></Term>}
      {row.state && <Term label={t(`${P}.state`)}><span lang={dataLang}>{row.state}</span></Term>}
      {row.phone && <Term label={t(`${P}.phone`)}><span lang={dataLang}>{row.phone}</span></Term>}
      {row.note && <Term label={t(`${P}.theirNote`)}><span lang={dataLang} className="xus-intake-pre">{row.note}</span></Term>}
      <Term label={t(`${P}.firstAsked`)}>{stamp(row.createdAt, lang)}</Term>
      <Term label={t(`${P}.lastAsked`)}>{stamp(row.lastSubmittedAt, lang)}</Term>
      {row.statusChangedAt && <Term label={t(`${P}.statusChanged`)}>{stamp(row.statusChangedAt, lang)}</Term>}
    </dl>
    <div className="xus-verifier-toolbar">
      <label className="xus-field" htmlFor={statusId}>{t(`${P}.statusLabel`)}
        <select id={statusId} className="xus-input" value={status} disabled={busy === "status"} onChange={(event) => setStatus(event.target.value)}>
          {INTAKE_STATUSES.map((value) => <option key={value} value={value}>{t(`${P}.status.${value}`)}</option>)}
        </select>
      </label>
      <BusyButton className="xus-btn" pending={busy === "status"} disabled={status === row.status || Boolean(busy)} onClick={(event) => onStatus(row, status, event)}>{t(`${P}.saveStatus`)}</BusyButton>
      {href && <a className="xus-btn" href={href}>{t(`${P}.reply`)}</a>}
    </div>
    <label className="xus-field" htmlFor={noteId}>{t(`${P}.operatorNote`)}
      {/* Read-only while its save runs, so nothing typed then is replaced by the saved text. */}
      <textarea id={noteId} className="xus-input xus-input--area" maxLength={NOTE_MAX} value={note} readOnly={busy === "note"} aria-busy={busy === "note" || undefined} onChange={(event) => setNote(event.target.value)} />
    </label>
    <BusyButton className="xus-btn" pending={busy === "note"} disabled={note.trim() === (row.operatorNote ?? "") || Boolean(busy)} onClick={(event) => onNote(row, note, event)}>{t(`${P}.saveNote`)}</BusyButton>
    {kind === "invite" && <PassPanel row={row} passes={Array.isArray(row.passes) ? row.passes : []} t={t} lang={lang} dataLang={dataLang} busy={busy} onSearch={onSearch} onPass={onPass} onPassed={onSucceeded} />}
    {kind === "join" && <FounderInvitationPanel row={row} t={t} busy={busy} onInvite={onFounder} onInvited={onSucceeded} />}
  </li>;
}

export function PeopleWaitingPage({ requestReview, requestTopicSend = null, saveCsv = downloadCsv }) {
  const { t, lang } = useLang();
  const dataLang = lang === "en" ? undefined : "en";
  const headingId = useId();
  const listHeadingId = useId();
  const reviewRef = useRef(requestReview);
  useEffect(() => { reviewRef.current = requestReview; });
  const busyWriteRef = useRef(new Set());
  const [access, setAccess] = useState(null);
  const [summary, setSummary] = useState(null);
  const [form, setForm] = useState({ kind: "", status: "", search: "" });
  const [filters, setFilters] = useState({});
  // The filters on screen now: a save that finishes after the operator
  // applied other filters is reconciled against those, not the ones it began with.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  // The cursors of the pages already read: [null] is the newest page.
  const [cursors, setCursors] = useState([null]);
  const [list, setList] = useState({ state: "loading", rows: [], hasMore: false, next: null });
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState({});
  // A success that removes the pressed control hands focus to the status line (ledger 621).
  const { targetRef: noticeRef, handOff } = useSuccessFocus();
  const [exporting, setExporting] = useState(false);
  // Bumped after a saved status so the counts are read again.
  const [summaryTick, setSummaryTick] = useState(0);
  // Bumped to read the current page again (after every row on it left it).
  const [listTick, setListTick] = useState(0);
  // Rows this page has saved, with when, so a list answer that was already on
  // its way during the save cannot paint the old values back.
  const savedRef = useRef(new Map());
  // Server histories may arrive during or after a pass. Keep the current
  // history and each local pass's revision so only writes newer than a read
  // override that read, without hiding newer server decisions on older passes.
  const passHistoryRef = useRef({ revision: 0, rows: new Map() });
  const droppedRef = useRef(false);
  // False once the page has left the screen (a sign-out or another page), so a
  // late export never downloads a file for a session that has ended.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // True when the failure refuses the page itself.
  const refuse = useCallback((error) => {
    const kind = intakeFailureKind(error);
    if (isAccessFailure(kind)) { setAccess(kind); return true; }
    return false;
  }, []);

  // The sentence for a failure kind, translated when it is shown, so a
  // language switch never reloads the list.
  const failureKey = (kind) => (kind === "refused" ? `${P}.error.refused` : kind === "unavailable" ? `${P}.error.unavailable` : `${P}.error.generic`);
  const failureText = (error) => t(failureKey(intakeFailureKind(error)));

  useEffect(() => {
    let live = true;
    reviewRef.current("summary", {}).then((result) => { if (live) setSummary(result); }, (error) => {
      if (live && !refuse(error)) setSummary({ failed: true });
    });
    return () => { live = false; };
  }, [refuse, summaryTick]);

  const page = cursors.length;
  const cursor = cursors[cursors.length - 1];
  useEffect(() => {
    let live = true;
    const started = Date.now();
    setList((current) => ({ ...current, state: "loading" }));
    const payload = { ...filters, limit: PAGE_SIZE, ...(cursor ? { before: cursor.before, beforeId: cursor.beforeId } : {}) };
    reviewRef.current("list", payload).then((result) => {
      if (!live) return;
      const status = filtersRef.current.status;
      // The server filtered this page; only a row replaced by a newer save is
      // checked against the status filter again.
      const rows = [];
      for (const row of Array.isArray(result?.requests) ? result.requests : []) {
        const saved = savedRef.current.get(row.id);
        if (!saved || saved.at < started) rows.push(row);
        else if (saved.row && (!status || saved.row.status === status)) rows.push(saved.row);
      }
      const next = result?.hasMore === true && result.cursorSubmittedAt && result.cursorId
        ? { before: result.cursorSubmittedAt, beforeId: result.cursorId } : null;
      setList({ state: "ready", rows, hasMore: Boolean(next), next });
      const ids = inviteRowIds(rows);
      if (ids.length === 0) return;
      const passReadRevision = passHistoryRef.current.revision;
      // Where each invite request went is read after the page and kept on its
      // row. A failed read leaves the rows usable without it.
      reviewRef.current("passes", { ids }).then((found) => {
        if (!live) return;
        const byRow = passesBySubmission(found);
        for (const id of ids) {
          const known = passHistoryRef.current.rows.get(id);
          const newer = new Map([...(known?.writes || [])].filter(([, write]) => write.revision > passReadRevision));
          let history = byRow[id] || [];
          for (const write of newer.values()) {
            // A returned decision is authoritative even when this request
            // began before the local pass completed.
            if (!history.some((entry) => entry.organizationId === write.pass.organizationId)) {
              history = withPass({ [id]: history }, write.pass)[id];
            }
          }
          passHistoryRef.current.rows.set(id, { passes: history, writes: newer });
        }
        setList((current) => ({ ...current, rows: current.rows.map((row) => (ids.includes(row.id)
          ? { ...row, passes: passHistoryRef.current.rows.get(row.id).passes } : row)) }));
      }, (error) => {
        if (live) refuse(error);
      });
    }, (error) => {
      if (!live || refuse(error)) return;
      setList({ state: "failed", rows: [], hasMore: false, next: null, failureKind: intakeFailureKind(error) });
    });
    return () => { live = false; };
  }, [filters, cursor, refuse, listTick]);

  // When saves have moved every row on this page out of the filter, read the
  // filter's first page again instead of saying nothing matches: newer and
  // older pages may still hold matches.
  useEffect(() => {
    if (!droppedRef.current || list.state !== "ready" || list.rows.length > 0) return;
    droppedRef.current = false;
    if (list.hasMore || cursors.length > 1) {
      setCursors([null]);
      setListTick((tick) => tick + 1);
    }
  }, [list, cursors.length]);

  function apply(event) {
    event.preventDefault();
    setNotice("");
    setFailure("");
    setFilters(intakeFilters(form));
    setCursors([null]);
  }

  // A row whose status no longer matches the status filter leaves the list,
  // as it would on a reload.
  // Returns true when the row left the list.
  function replaceRow(next) {
    if (!next?.id) return false;
    const status = filtersRef.current.status;
    if (status && next.status !== status) { dropRow(next.id); return true; }
    setList((current) => ({ ...current, rows: current.rows.map((row) => (row.id === next.id ? { ...next, passes: next.passes ?? row.passes } : row)) }));
    return false;
  }

  function dropRow(id) {
    droppedRef.current = true;
    setList((current) => ({ ...current, rows: current.rows.filter((row) => row.id !== id) }));
  }

  async function write(row, kind, payload, event) {
    const started = focusedElement();
    return runBusyWrite(busyWriteRef, `${kind}:${row.id}`, async () => {
      setBusy((current) => ({ ...current, [row.id]: kind }));
      setNotice("");
      setFailure("");
      try {
        const result = await reviewRef.current(kind, { id: row.id, ...payload });
        if (result?.request?.id) savedRef.current.set(result.request.id, { row: result.request, at: Date.now() });
        if (result?.updated === true) {
          replaceRow(result.request);
          if (kind === "status") setSummaryTick((tick) => tick + 1);
          setNotice(t(kind === "status" ? `${P}.statusSaved` : `${P}.noteSaved`, { name: row.name || row.email }));
          // Moves focus only when the saved status took the row out of the filter.
          handOff(started);
        } else if (result?.refusal === "not-found") {
          // Remembered as gone, so a list answer already on its way cannot bring it back.
          savedRef.current.set(row.id, { row: null, at: Date.now() });
          dropRow(row.id);
          setSummaryTick((tick) => tick + 1);
          setFailure(t(`${P}.gone`));
        } else if (result?.refusal === "changed") {
          const left = replaceRow(result.request);
          setSummaryTick((tick) => tick + 1);
          const now = vocabularyKey(INTAKE_STATUSES, result.request?.status);
          setFailure(left && now
            ? t(`${P}.changedElsewhereLeft`, { status: t(`${P}.status.${now}`) })
            : t(`${P}.changedElsewhere`));
        } else {
          replaceRow(result?.request);
          setNotice(t(`${P}.unchanged`));
        }
      } catch (error) {
        if (!refuse(error)) setFailure(failureText(error));
      } finally {
        setBusy((current) => { const next = { ...current }; delete next[row.id]; return next; });
      }
    }, event);
  }

  // The organization search: the result, or null when it failed (an access
  // failure replaces the page).
  async function searchOrganizations(text) {
    try {
      return await reviewRef.current("organizations", { search: text });
    } catch (error) {
      refuse(error);
      return null;
    }
  }

  // Passes one invite request; true when it is now with that organization.
  async function passRow(row, organization, event) {
    let passed = false;
    await runBusyWrite(busyWriteRef, `pass:${row.id}`, async () => {
      setBusy((current) => ({ ...current, [row.id]: "pass" }));
      setNotice("");
      setFailure("");
      const name = row.name || row.email;
      try {
        const result = await reviewRef.current("pass", { id: row.id, organizationId: organization.id });
        if (result?.passed === true) {
          passed = true;
          const before = row;
          const known = passHistoryRef.current.rows.get(row.id);
          const history = withPass({ [row.id]: known?.passes || row.passes || [] }, result.pass)[row.id] || [];
          const writes = new Map(known?.writes);
          const savedPass = history.find((entry) => entry.organizationId === result.pass?.organizationId);
          if (savedPass) writes.set(savedPass.organizationId, { pass: savedPass, revision: ++passHistoryRef.current.revision });
          passHistoryRef.current.rows.set(row.id, { passes: history, writes });
          const passedRow = { ...(result.request?.id ? result.request : before), passes: history };
          savedRef.current.set(row.id, { row: passedRow, at: Date.now() });
          replaceRow(passedRow);
          if (passedRow.status !== before.status) setSummaryTick((tick) => tick + 1);
          const organizationName = result.pass?.organizationName || organization.name;
          setNotice(t(result.repeated === true ? `${P}.pass.repeated` : `${P}.pass.done`, { name, organization: organizationName }));
        } else {
          const refusal = vocabularyKey(PASS_REFUSALS, result?.refusal);
          if (refusal === "not-found") {
            savedRef.current.set(row.id, { row: null, at: Date.now() });
            dropRow(row.id);
            setSummaryTick((tick) => tick + 1);
          }
          setFailure(t(`${P}.pass.refusal.${refusal || "other"}`));
        }
      } catch (error) {
        // A lost answer is not a refusal: the pass may have been saved. Read
        // this row's history once and say what it shows.
        if (!refuse(error)) passed = await confirmLostPass(row, organization, name);
      } finally {
        setBusy((current) => { const next = { ...current }; delete next[row.id]; return next; });
      }
    }, event);
    return passed;
  }

  // True when the re-read history holds the pass to that organization.
  async function confirmLostPass(row, organization, name) {
    // A pass to an organization the row already went to is a repeat, whatever this click did.
    const already = (passHistoryRef.current.rows.get(row.id)?.passes || row.passes || []).some((p) => p.organizationId === organization.id);
    let history;
    try {
      history = passesBySubmission(await reviewRef.current("passes", { ids: [row.id] }))[row.id] || [];
    } catch (error) {
      if (!refuse(error)) setFailure(t(`${P}.pass.unconfirmed`));
      return false;
    }
    const known = passHistoryRef.current.rows.get(row.id);
    const writes = new Map(known?.writes);
    const savedPass = history.find((entry) => entry.organizationId === organization.id);
    if (savedPass) writes.set(savedPass.organizationId, { pass: savedPass, revision: ++passHistoryRef.current.revision });
    passHistoryRef.current.rows.set(row.id, { passes: history, writes });
    setList((current) => ({ ...current, rows: current.rows.map((item) => (item.id === row.id ? { ...item, passes: history } : item)) }));
    if (!savedPass) {
      setFailure(t(`${P}.pass.unconfirmed`));
      return false;
    }
    setNotice(t(already ? `${P}.pass.repeated` : `${P}.pass.done`, { name, organization: savedPass.organizationName || organization.name }));
    return true;
  }

  async function founderRow(row, fields, event) {
    let invited = false;
    await runBusyWrite(busyWriteRef, `founder:${row.id}`, async () => {
      setBusy((current) => ({ ...current, [row.id]: "founder" }));
      setNotice(""); setFailure("");
      try {
        const result = await reviewRef.current("founder", { id: row.id, ...fields });
        if (!mountedRef.current) return;
        if (result?.invited === true) {
          invited = true;
          if (result.request?.id) {
            savedRef.current.set(row.id, { row: result.request, at: Date.now() });
            replaceRow(result.request);
          }
          setSummaryTick((tick) => tick + 1);
          const delivery = ["sent", "failed", "unknown", "unchanged"].includes(result.delivery) ? result.delivery : "unknown";
          setNotice(t(`${P}.founder.delivery.${delivery}`, { invitationId: result.invitationId }));
        } else {
          const refusal = ["stopped", "not-found", "not-join", "closed", "email_unavailable", "name_unavailable"].includes(result?.refusal) ? result.refusal : "other";
          if (refusal === "not-found") {
            savedRef.current.set(row.id, { row: null, at: Date.now() }); dropRow(row.id);
          }
          setFailure(t(`${P}.founder.refusal.${refusal}`));
        }
      } catch (error) {
        if (mountedRef.current && !refuse(error)) {
          const refusal = error?.reason === "legal-release-pending" ? "legal"
            : error?.reason === "organization-name-phone" ? "organization-name-phone" : "other";
          setFailure(t(`${P}.founder.refusal.${refusal}`));
        }
      } finally {
        if (mountedRef.current) setBusy((current) => { const next = { ...current }; delete next[row.id]; return next; });
      }
    }, event);
    return invited;
  }

  async function exportCsv(event) {
    return runBusyWrite(busyWriteRef, "export", async () => {
      setExporting(true);
      setNotice("");
      setFailure("");
      try {
        const result = await reviewRef.current("export", filters);
        if (!mountedRef.current) return;
        const rows = Array.isArray(result?.requests) ? result.requests : [];
        saveCsv(intakeCsv(rows));
        setNotice(t(result?.truncated === true ? `${P}.exportTruncated` : `${P}.exported`, { count: rows.length }));
      } catch (error) {
        if (mountedRef.current && !refuse(error)) setFailure(failureText(error));
      } finally {
        if (mountedRef.current) setExporting(false);
      }
    }, event);
  }

  // Without its intro the head holds only the title (ledger 815).
  const header = (withIntro) => <WorkspaceCardHead title={withIntro ? null : t("intakeQueue.title")} id={headingId}><header className="xus-cardhead">
    <span className="xus-glyph" aria-hidden="true"><Inbox size={18} /></span>
    <div className="xus-cardhead__copy">
      <WorkspaceCardTitle outline className="xus-cardttl" id={headingId}>{t("intakeQueue.title")}</WorkspaceCardTitle>
      {withIntro && <p className="xus-cardsub">{t(`${P}.intro`)}</p>}
    </div>
  </header></WorkspaceCardHead>;

  if (access) {
    const key = access === "demo" ? `${P}.demoUnavailable` : access === "mfa" ? `${P}.mfaRequired` : `${P}.forbidden`;
    return <article id={SECTION_ID} className={ROOT_CLASS} tabIndex="-1" aria-labelledby={headingId}>
      {header(false)}
      <p className="xus-note xus-cardbody" role={access === "demo" ? "status" : "alert"}>{t(key)}</p>
    </article>;
  }

  return <article id={SECTION_ID} className={ROOT_CLASS} tabIndex="-1" aria-labelledby={headingId}>
    {header(true)}
    <div className="xus-cardbody xus-verifier xus-form">
      {summary === null && <p className="xus-note" role="status">{t(`${P}.loading`)}</p>}
      {summary?.failed && <p className="xus-note xus-note--error">{t(`${P}.summaryFailed`)}</p>}
      {summary && !summary.failed && <Summary summary={summary} t={t} lang={lang} />}

      <form className="xus-verifier-toolbar" onSubmit={apply} aria-label={t(`${P}.filters`)}>
        <label className="xus-field">{t(`${P}.kindFilter`)}
          <select className="xus-input" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
            <option value="">{t(`${P}.allKinds`)}</option>
            {INTAKE_KINDS.map((kind) => <option key={kind} value={kind}>{t(`${P}.kind.${kind}`)}</option>)}
          </select>
        </label>
        <label className="xus-field">{t(`${P}.statusFilter`)}
          <select className="xus-input" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>
            <option value="">{t(`${P}.allStatuses`)}</option>
            {INTAKE_STATUSES.map((status) => <option key={status} value={status}>{t(`${P}.status.${status}`)}</option>)}
          </select>
        </label>
        <label className="xus-field">{t(`${P}.search`)}
          <input className="xus-input" type="search" maxLength={SEARCH_MAX} value={form.search} onChange={(event) => setForm({ ...form, search: event.target.value })} />
        </label>
        <button className="xus-btn xus-btn--go" type="submit">{t(`${P}.apply`)}</button>
        <BusyButton className="xus-btn" type="button" pending={exporting} onClick={exportCsv}>{t(`${P}.export`)}</BusyButton>
      </form>

      <p ref={noticeRef} tabIndex={-1} className="xus-note xus-note--success" role="status" aria-live="polite">{notice}</p>
      {failure && <p className="xus-note xus-note--error" role="alert">{failure}</p>}

      <section className="xus-verifier-list" aria-labelledby={listHeadingId}>
        <h3 className="xus-etitle" id={listHeadingId}>{t(`${P}.listHeading`)}</h3>
        {list.state === "loading" && <p className="xus-note" role="status">{t(`${P}.loading`)}</p>}
        {list.state === "failed" && <p className="xus-note xus-note--error">{t(failureKey(list.failureKind))}</p>}
        {list.state === "ready" && list.rows.length === 0 && <p className="xus-note">{t(Object.keys(filters).length ? `${P}.emptyFiltered` : `${P}.empty`)}</p>}
        {list.state === "ready" && list.rows.length > 0 && <ul className="xus-verifier-items">
          {list.rows.map((row) => <RequestItem key={row.id} row={row} t={t} lang={lang} dataLang={dataLang} busy={busy[row.id]}
            onSearch={searchOrganizations} onPass={passRow} onFounder={founderRow} onSucceeded={handOff}
            onStatus={(item, status, event) => write(item, "status", { status, expectedStatus: item.status }, event)}
            onNote={(item, note, event) => write(item, "note", { note }, event)} />)}
        </ul>}
        <div className="xus-btnrow xus-verifier-pages">
          <button className="xus-btn" type="button" disabled={page === 1} onClick={() => setCursors(cursors.slice(0, -1))}>{t(`${P}.newer`)}</button>
          <span className="xus-note">{t(`${P}.page`, { page })}</span>
          <button className="xus-btn" type="button" disabled={!list.hasMore || list.state !== "ready"} onClick={() => setCursors([...cursors, list.next])}>{t(`${P}.older`)}</button>
        </div>
      </section>

      {/* Email an update to a topic's opt-ins (REQ-UG-INTAKE-QUEUE-EMAIL-THE-OPT-IN-LIST-20261118). */}
      {requestTopicSend && <TopicUpdatePanel requestSend={requestTopicSend} />}
    </div>
  </article>;
}
