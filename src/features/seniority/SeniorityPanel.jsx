// REQ-UG-STEWARD-SENIORITY-LIST-AND-BID-TRACKER-20261030: the
// chapter seniority list and bid tracker in Steward tools (and the
// coordinator desk). Everything is the server's: the list in seniority order,
// a member picker, an import preview that writes nothing, bid windows with
// each bid beside the bidder's seniority, and members' questions.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";
import { formatCalendarDay, formatDateTimeWithZone } from "../../lib/i18n/zonedDates.js";
import { localDateTimeInputToIso } from "../../lib/localDateTime.js";
import { BIDS_CHANGED_EVENT, SENIORITY_IMPORT_MAX_ROWS, bidWindowAcceptsBids, notifyBidsChanged, parseSeniorityFile, upcomingBidDeadlines } from "./api.js";
import "../../lib/i18n/features/seniorityStrings.js";

const plural = (t, key, count) => t(`${key}.${count === 1 ? "one" : "other"}`, { count });
// A seniority date is a calendar day: "Jan 15, 2008" / "15 ene 2008", as the
// rest of the website prints a day (#10026); anything else shows as stored.
const seniorityDay = (value, lang) => formatCalendarDay(value, lang) || value;

// Only the latest read may settle a list: a response that lands after a newer
// read started (a refresh, or a page of an older list) is dropped.
function useSeniorityList(api, chapterId) {
  const [state, setState] = useState({ phase: "loading", items: [], nextCursor: null, openQuestions: 0 });
  const generation = useRef(0);
  const load = useCallback(async (cursor = null) => {
    const mine = ++generation.current;
    try {
      const page = await api.list(chapterId, cursor);
      if (mine !== generation.current) return;
      setState((current) => ({
        phase: "ready",
        items: cursor ? [...current.items, ...(page?.items ?? [])] : (page?.items ?? []),
        nextCursor: page?.nextCursor ?? null,
        openQuestions: Number.isInteger(page?.openQuestions) ? page.openQuestions : 0,
      }));
    } catch {
      if (mine !== generation.current) return;
      // #9463: a failed refresh keeps the rows on screen (and any form in
      // them) and says so above them; only a first read with nothing shown
      // becomes the error state.
      setState((current) => (cursor ? current : current.items.length ? { ...current, stale: true } : { phase: "error", items: [], nextCursor: null, openQuestions: 0 }));
    }
  }, [api, chapterId]);
  useEffect(() => { load(); }, [load]);
  return [state, load];
}

// #9463: "not saved" only for a refusal the database answered (a SQLSTATE or
// PostgREST request code). No reply, a lost connection, a timeout or a busy
// pool leave the outcome unknown: say so and read what is shown again.
const UNCONFIRMED = "seniority.writeUnconfirmed";
function seniorityWriteFailureKey(error, refusedKey) {
  const code = String(error?.code ?? "");
  if (/^PGRST[1-9]\d\d$/u.test(code)) return refusedKey;
  return /^[0-9A-Z]{5}$/u.test(code) && !/^(08|53|57|58|XX)/u.test(code) ? refusedKey : UNCONFIRMED;
}

// One line per slot (an answer, a row's award, the bid form, each window
// button). Only a group's latest attempt sets its lines or refreshes.
function useWriteFeedback() {
  const [lines, setLines] = useState({});
  const latest = useRef({});
  const show = useCallback((group, slot, key) => {
    latest.current[group] = (latest.current[group] ?? 0) + 1;
    setLines((current) => Object.fromEntries([...Object.entries(current).filter(([name]) => name !== group && !name.startsWith(`${group}:`)), [slot, key]]));
    return latest.current[group];
  }, []);
  const run = useCallback(async (group, slot, write, refusedKey, refresh) => {
    const mine = show(group, slot, null);
    let outcome = { ok: true };
    try { outcome.value = await write(); } catch (error) { outcome = { ok: false, key: seniorityWriteFailureKey(error, refusedKey) }; }
    if (latest.current[group] !== mine) return { ok: false, superseded: true };
    setLines((current) => ({ ...current, [slot]: outcome.ok ? null : outcome.key }));
    if (outcome.ok || outcome.key === UNCONFIRMED) refresh?.();
    return outcome;
  }, [show]);
  return { lines, show, run };
}

function AnswerForm({ entry, api, onDone }) {
  const { t } = useLang();
  const id = useId();
  const [answer, setAnswer] = useState("");
  // A failed answer says so beside the button and keeps the text.
  const [sending, setSending] = useState(false);
  // #8435: the save keeps keyboard focus while its write runs (a pending
  // control, not a disabled one), and a synchronous lock refuses a second
  // submit before React commits sending.
  const busyWriteRef = useRef(new Set());
  const { lines, run } = useWriteFeedback();
  return <form onSubmit={(event) => {
    event.preventDefault();
    if (!answer.trim()) return;
    void runBusyWrite(busyWriteRef, "answer", async () => {
      setSending(true);
      try {
        const outcome = await run("answer", "answer", () => api.answer(entry.id, answer.trim()), "seniority.answerError", onDone);
        if (outcome.ok) setAnswer("");
      } finally {
        setSending(false);
      }
    }, event);
  }}>
    <label htmlFor={id}>{t("seniority.answerLabel", { name: entry.name })}</label>
    <input id={id} value={answer} maxLength={1000} onChange={(event) => setAnswer(event.target.value)} />
    <BusyButton type="submit" className="dialog-secondary" pending={sending}>{t("seniority.answerSave")}</BusyButton>
    {lines.answer && <p role="alert">{t(lines.answer)}</p>}
  </form>;
}

// A search over the chapter's active members (search_chapter_seniority_members)
// and a choice among the matches, for an entry or a bid.
function MemberPicker({ api, chapterId, value, onChange, idPrefix }) {
  const { t } = useLang();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState({ phase: "loading", members: [], api, chapterId });
  const [attempt, setAttempt] = useState(0);
  const input = useRef(null);
  const statusId = `${idPrefix}-member-search-status`;
  useEffect(() => {
    let live = true;
    const scope = { api, chapterId };
    setSearch((previous) => ({
      ...scope,
      phase: "loading",
      members: previous.api === api && previous.chapterId === chapterId ? previous.members : [],
    }));
    Promise.resolve().then(() => api.searchMembers(chapterId, query))
      .then((rows) => { if (live) setSearch({ ...scope, phase: "ready", members: Array.isArray(rows) ? rows : [] }); })
      .catch(() => { if (live) setSearch({ ...scope, phase: "error", members: [] }); });
    return () => { live = false; };
  }, [api, chapterId, query, attempt]);
  const { members, phase } = search.api === api && search.chapterId === chapterId
    ? search : { phase: "loading", members: [] };
  const status = phase === "error" ? t("seniority.memberSearchFailed")
    : phase === "loading" ? t("seniority.memberSearchLoading")
      : query.trim() && members.length === 0 ? t("seniority.memberSearchEmpty") : "";
  return <>
    <label htmlFor={`${idPrefix}-find`}>{t("seniority.findMember")}</label>
    <input ref={input} id={`${idPrefix}-find`} type="search" value={query} maxLength={80} aria-describedby={status ? statusId : undefined} onChange={(event) => setQuery(event.target.value)} />
    <label htmlFor={`${idPrefix}-member`}>{t("seniority.member")}</label>
    <select id={`${idPrefix}-member`} required value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{t("seniority.chooseMember")}</option>
      {members.map((member) => <option key={member.userId} value={member.userId}>{member.name}{member.listed ? ` ${t("seniority.listed")}` : ""}</option>)}
    </select>
    <span id={statusId} role="status" aria-atomic="true">{status}</span>
    {phase === "error" && <button type="button" className="dialog-secondary" onClick={() => {
      input.current?.focus();
      setAttempt((current) => current + 1);
    }}>{t("seniority.retry")}</button>}
  </>;
}

function EntryForm({ api, chapterId, onSaved }) {
  const { t } = useLang();
  const id = useId();
  const [form, setForm] = useState({ userId: "", seniorityDate: "", classification: "", tieBreakNote: "" });
  const [notice, setNotice] = useState(null);
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  return <form className="seniority-form" onSubmit={async (event) => {
    event.preventDefault();
    setNotice(null);
    try {
      await api.save(chapterId, form);
      setForm({ userId: "", seniorityDate: "", classification: "", tieBreakNote: "" });
      setNotice({ role: "status", text: t("seniority.saved") });
      onSaved();
    } catch {
      setNotice({ role: "alert", text: t("seniority.saveError") });
    }
  }}>
    <h3>{t("seniority.addTitle")}</h3>
    <MemberPicker api={api} chapterId={chapterId} value={form.userId} onChange={(userId) => setForm((current) => ({ ...current, userId }))} idPrefix={id} />
    <label htmlFor={`${id}-date`}>{t("seniority.date")}</label>
    <input id={`${id}-date`} type="date" required value={form.seniorityDate} onChange={set("seniorityDate")} />
    <label htmlFor={`${id}-class`}>{t("seniority.classification")}</label>
    <input id={`${id}-class`} maxLength={120} value={form.classification} onChange={set("classification")} />
    <label htmlFor={`${id}-tie`}>{t("seniority.tieBreak")}</label>
    <input id={`${id}-tie`} maxLength={300} value={form.tieBreakNote} onChange={set("tieBreakNote")} />
    <button type="submit" className="dialog-primary">{t("seniority.save")}</button>
    {notice && <p role={notice.role}>{notice.text}</p>}
  </form>;
}

function ImportForm({ api, chapterId, onSaved }) {
  const { t } = useLang();
  const id = useId();
  const [rows, setRows] = useState([]);
  // The preview and the exact rows it was made from: saving sends those rows,
  // never a file chosen after the preview (or while it was loading).
  const [preview, setPreview] = useState(null);
  const [notice, setNotice] = useState(null);
  const generation = useRef(0);
  const run = async (apply) => {
    setNotice(null);
    const sent = apply ? preview?.sourceRows ?? [] : rows;
    if (!sent.length) { setNotice({ role: "alert", text: t("seniority.importEmpty") }); return; }
    if (sent.length > SENIORITY_IMPORT_MAX_ROWS) { setNotice({ role: "alert", text: t("seniority.importTooMany", { count: sent.length, max: SENIORITY_IMPORT_MAX_ROWS }) }); return; }
    const mine = ++generation.current;
    try {
      const result = await api.importRows(chapterId, sent, apply);
      if (mine !== generation.current) return;
      setPreview({ ...result, sourceRows: sent });
      if (apply) {
        setNotice({ role: "status", text: plural(t, "seniority.importApplied", result?.saved ?? 0) });
        onSaved();
      }
    } catch {
      if (mine === generation.current) setNotice({ role: "alert", text: t("seniority.importError") });
    }
  };
  const ready = (preview?.rows ?? []).filter((row) => row.outcome === "ready").length;
  return <section className="seniority-import" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{t("seniority.importTitle")}</h3>
    <p>{t("seniority.importHelp")}</p>
    <label htmlFor={`${id}-file`}>{t("seniority.importFile")}</label>
    <input id={`${id}-file`} type="file" accept=".csv,text/csv" onChange={async (event) => {
      const file = event.target.files?.[0];
      generation.current += 1;
      setPreview(null);
      setRows(file ? parseSeniorityFile(await file.text()) : []);
    }} />
    <button type="button" className="dialog-secondary" onClick={() => run(false)}>{t("seniority.importPreview")}</button>
    {preview && !preview.applied && <>
      <table>
        <thead><tr><th>{t("seniority.importRow")}</th><th>{t("seniority.colName")}</th><th>{t("seniority.colDate")}</th><th>{t("seniority.importOutcome")}</th></tr></thead>
        <tbody>{preview.rows.map((row) => <tr key={row.row} data-outcome={row.outcome}>
          <td>{row.row}</td><td>{row.name ?? ""}</td><td>{row.seniorityDate ?? ""}</td><td>{t(`seniority.outcome.${row.outcome}`)}</td>
        </tr>)}</tbody>
      </table>
      {ready > 0 && <button type="button" className="dialog-primary" onClick={() => run(true)}>{t("seniority.importApply")}</button>}
    </>}
    {notice && <p role={notice.role}>{notice.text}</p>}
  </section>;
}

function BidWindow({ window, api, chapterId, onChanged, now }) {
  const { t, lang } = useLang();
  const id = useId();
  const [bid, setBid] = useState({ userId: "", choice: "" });
  const [awards, setAwards] = useState({});
  // Bids past the first page this window arrived with, loaded on request
  // (BUG-UG-BID-RECORDS-STALE-AWARD-AND-500-CAP-20261102), and what
  // the last bid write needs the steward to know.
  const [more, setMore] = useState({ bids: [], failed: false });
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState("");
  // #9463: a failed award (per row), bid or window change, beside its control.
  const feedback = useWriteFeedback();
  const line = (slot) => (feedback.lines[slot] ? <p role="alert">{t(feedback.lines[slot])}</p> : null);
  const changeWindow = (status) => feedback.run("window", `window:${status}`, () => api.saveWindow(null, { ...window, status }), "seniority.bidWindowError", onChanged);
  // One generation per first page: a read started under an earlier first
  // page never publishes into a later one (gate r2s1, r2s2).
  const generation = useRef(0);
  const firstPage = window.bids.length;
  const shownBids = [...window.bids, ...more.bids.filter((entry) => !window.bids.some((first) => first.id === entry.id))];
  const hasMore = Number.isInteger(window.bidCount) && window.bidCount > firstPage + more.bids.length;
  // Reads `count` bids from `offset` in pages of at most 500 (the reader's
  // cap) and answers only once the whole range has arrived.
  const readRange = useCallback(async (offset, count) => {
    const bids = [];
    while (bids.length < count) {
      const want = Math.min(500, count - bids.length);
      const page = await api.bidPage(window.id, offset + bids.length, want);
      const rows = Array.isArray(page?.bids) ? page.bids : [];
      bids.push(...rows);
      if (rows.length < want) break;
    }
    return bids;
  }, [api, window.id]);
  async function loadMore() {
    if (reading) return;
    const current = generation.current;
    setReading(true);
    try {
      const page = await readRange(firstPage + more.bids.length, 100);
      if (current === generation.current) setMore((shown) => ({ bids: [...shown.bids, ...page], failed: false }));
    } catch {
      if (current === generation.current) setMore((shown) => ({ ...shown, failed: true }));
    } finally {
      if (current === generation.current) setReading(false);
    }
  }
  // Every refresh of the first page (an award, a bid, a seniority change that
  // reorders the list) starts a new generation and re-reads the later pages
  // already shown from the new first page's end, so no bid is skipped or
  // shown twice (gate r1s1, r1s2). Show more waits until that read settles.
  const loadedExtra = useRef(0);
  loadedExtra.current = more.bids.length;
  // The first run has nothing to re-read and starts no generation: a Show
  // more clicked after the first page renders but before this effect runs
  // would otherwise be dropped (TEST-UG-CHAPTER-SENIORITY-BIDS-FLAKE-20261102).
  // A layout effect starts the generation inside the commit that shows the
  // refreshed first page: a passive effect runs later, so an earlier read
  // settling in between would still publish into the new first page.
  const mounted = useRef(false);
  useLayoutEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const current = ++generation.current;
    const count = loadedExtra.current;
    if (!count) {
      setReading(false);
      return;
    }
    setReading(true);
    readRange(window.bids.length, count)
      .then((bids) => { if (current === generation.current) setMore({ bids, failed: false }); })
      // A failed re-read drops the earlier generation's rows: Show more then
      // starts again at the refreshed first page's end (gate r3s1).
      .catch(() => { if (current === generation.current) setMore({ bids: [], failed: true }); })
      .finally(() => { if (current === generation.current) setReading(false); });
  }, [window.bids, readRange]);
  return <article className="seniority-bid" data-status={window.status}>
    <h4>{window.subject} <small>{t(`seniority.bidStatus.${window.status}`)}</small></h4>
    <p>{t("seniority.bidWindow", { opens: formatDateTimeWithZone(window.opensAt, lang), closes: formatDateTimeWithZone(window.closesAt, lang) })}</p>
    {hasMore && <p role="status">{t("seniority.bidsShown", { shown: firstPage + more.bids.length, count: window.bidCount })}</p>}
    {shownBids.length === 0 ? <p>{t("seniority.bidNone")}</p> : <ol>
      {shownBids.map((entry) => <li key={entry.id}>
        <strong>{entry.name}</strong> · {entry.choice} · {entry.seniorityDate ? t("seniority.bidOnList", { date: seniorityDay(entry.seniorityDate, lang) }) : t("seniority.bidNotOnList")}
        {entry.award ? <span> · {t("seniority.awarded", { award: entry.award })}</span> : null}
        {window.status !== "cancelled" && <form onSubmit={async (event) => {
          event.preventDefault();
          await feedback.run(`award:${entry.id}`, `award:${entry.id}`, () => api.award(entry.id, awards[entry.id] ?? entry.award ?? ""), "seniority.awardError", onChanged);
        }}>
          <label htmlFor={`${id}-award-${entry.id}`}>{t("seniority.awardLabel", { name: entry.name })}</label>
          <input id={`${id}-award-${entry.id}`} maxLength={200} value={awards[entry.id] ?? entry.award ?? ""} onChange={(event) => setAwards((current) => ({ ...current, [entry.id]: event.target.value }))} />
          <button type="submit" className="dialog-secondary">{t("seniority.awardSave")}</button>
          {line(`award:${entry.id}`)}
        </form>}
      </li>)}
    </ol>}
    {hasMore && <BusyButton type="button" className="dialog-secondary" pending={reading} onClick={() => void loadMore()}>{t("seniority.bidsMore")}</BusyButton>}
    {more.failed && <p role="alert">{t("seniority.bidsMoreError")}</p>}
    {notice && <p role="status">{t(notice)}</p>}
    {window.status === "open" && !bidWindowAcceptsBids(window, now) && <p>{t(Date.parse(window.opensAt) > now ? "seniority.bidNotOpenYet" : "seniority.bidClosedTime")}</p>}
    {window.status === "open" && <>
      {bidWindowAcceptsBids(window, now) && <form onSubmit={async (event) => {
        event.preventDefault();
        if (!bid.userId || !bid.choice.trim()) { feedback.show("bid", "bid", "seniority.bidIncomplete"); return; }
        const outcome = await feedback.run("bid", "bid", () => api.recordBid(window.id, bid.userId, bid.choice.trim()), "seniority.bidRecordError", onChanged);
        if (!outcome.ok) return;
        setNotice(outcome.value?.awardCleared === true ? "seniority.bidAwardCleared" : "");
        setBid({ userId: "", choice: "" });
      }}>
        <h5>{t("seniority.bidRecordTitle")}</h5>
        <MemberPicker api={api} chapterId={chapterId} value={bid.userId} onChange={(userId) => setBid((current) => ({ ...current, userId }))} idPrefix={`${id}-who`} />
        <label htmlFor={`${id}-choice`}>{t("seniority.bidChoice")}</label>
        <input id={`${id}-choice`} maxLength={200} value={bid.choice} onChange={(event) => setBid((current) => ({ ...current, choice: event.target.value }))} />
        <button type="submit" className="dialog-secondary">{t("seniority.bidRecord")}</button>
        {line("bid")}
      </form>}
      <button type="button" className="dialog-secondary" onClick={() => void changeWindow("awarded")}>{t("seniority.bidMarkAwarded")}</button>
      {line("window:awarded")}
      <button type="button" className="dialog-secondary" onClick={() => void changeWindow("cancelled")}>{t("seniority.bidCancel")}</button>
      {line("window:cancelled")}
    </>}
  </article>;
}

// Reloads its first page whenever this chapter's bids or seniority change
// anywhere on the page (notifyBidsChanged), so bid cards never show a
// bidder's old seniority date or order.
export function useBidWindows(api, chapterId) {
  const [state, setState] = useState({ phase: "loading", windows: [], nextOffset: null });
  const generation = useRef(0);
  const load = useCallback(async (offset = 0) => {
    const mine = ++generation.current;
    try {
      const page = await api.listBids(chapterId, offset);
      if (mine !== generation.current) return;
      setState((current) => ({
        phase: "ready",
        windows: offset ? [...current.windows, ...(page?.windows ?? [])] : (page?.windows ?? []),
        nextOffset: Number.isInteger(page?.nextOffset) ? page.nextOffset : null,
      }));
    } catch {
      if (mine !== generation.current) return;
      setState((current) => (offset ? current : current.windows.length ? { ...current, stale: true } : { phase: "error", windows: [], nextOffset: null }));
    }
  }, [api, chapterId]);
  useEffect(() => {
    load();
    const onChange = (event) => { if (!event?.detail?.chapterId || event.detail.chapterId === chapterId) load(); };
    globalThis.addEventListener?.(BIDS_CHANGED_EVENT, onChange);
    return () => globalThis.removeEventListener?.(BIDS_CHANGED_EVENT, onChange);
  }, [load, chapterId]);
  return [state, load];
}

function BidsSection({ api, chapterId, now }) {
  const { t } = useLang();
  const id = useId();
  const [bids, reloadBids] = useBidWindows(api, chapterId);
  // A change reloads every view of this chapter's bids, this one included.
  const loadBids = (offset) => (offset ? reloadBids(offset) : notifyBidsChanged(chapterId));
  const [form, setForm] = useState({ subject: "", opensAt: "", closesAt: "" });
  const [notice, setNotice] = useState(null);
  // One wrapper per api and chapter: a new object on every render restarted
  // each window's later-page reads on unrelated form edits (gate r4s1).
  const withChapter = useMemo(() => ({ ...api, saveWindow: (_chapter, window) => api.saveWindow(chapterId, window) }), [api, chapterId]);
  return <section className="seniority-bids" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{t("seniority.bidsTitle")}</h3>
    {(bids.phase === "error" || bids.stale) && <p role="alert">{t("seniority.error")}</p>}
    {bids.phase === "ready" && bids.windows.length === 0 && <p>{t("seniority.bidsEmpty")}</p>}
    {bids.windows.map((window) => <BidWindow key={window.id} window={window} api={withChapter} chapterId={chapterId} onChanged={() => loadBids()} now={now} />)}
    {bids.nextOffset !== null && <button type="button" className="dialog-secondary" onClick={() => loadBids(bids.nextOffset)}>{t("seniority.showMore")}</button>}
    <form className="seniority-form" onSubmit={async (event) => {
      event.preventDefault();
      setNotice(null);
      try {
        await api.saveWindow(chapterId, { subject: form.subject.trim(), opensAt: localDateTimeInputToIso(form.opensAt), closesAt: localDateTimeInputToIso(form.closesAt), status: "open" });
        setForm({ subject: "", opensAt: "", closesAt: "" });
        loadBids();
      } catch {
        setNotice(t("seniority.bidSaveError"));
      }
    }}>
      <h4>{t("seniority.bidCreate")}</h4>
      <label htmlFor={`${id}-subject`}>{t("seniority.bidSubject")}</label>
      <input id={`${id}-subject`} required minLength={3} maxLength={200} value={form.subject} onChange={(event) => setForm((current) => ({ ...current, subject: event.target.value }))} />
      <label htmlFor={`${id}-opens`}>{t("seniority.bidOpens")}</label>
      <input id={`${id}-opens`} type="datetime-local" required value={form.opensAt} onChange={(event) => setForm((current) => ({ ...current, opensAt: event.target.value }))} />
      <label htmlFor={`${id}-closes`}>{t("seniority.bidCloses")}</label>
      <input id={`${id}-closes`} type="datetime-local" required value={form.closesAt} onChange={(event) => setForm((current) => ({ ...current, closesAt: event.target.value }))} />
      <button type="submit" className="dialog-primary">{t("seniority.bidCreate")}</button>
      {notice && <p role="alert">{notice}</p>}
    </form>
  </section>;
}

// BUG-UG-SENIORITY-PANEL-PROFILE-CHAPTER-ONLY-20261102: the
// seniority routines admit organization-wide staff who have no chapter of
// their own, and staff who manage a chapter they do not belong to. The desks
// used to mount the panel only for the profile chapter, so those staff never
// reached it. This picks the chapter: the profile chapter by default, and for
// organization-wide stewards and coordinators (or staff with no chapter) any
// chapter of the organization by choice. The server still decides access.
export function seniorityOrganizationWide(member) {
  const roles = Array.isArray(member?.organizationRoles) ? member.organizationRoles : [];
  return roles.includes("steward") || roles.includes("coordinator");
}

export function SeniorityChapterScope({ api, defaultChapterId = null, organizationId = null, organizationWide = false, children }) {
  const { t } = useLang();
  const id = useId();
  const [chosen, setChosen] = useState(defaultChapterId || "");
  const [chapters, setChapters] = useState({ phase: "idle", items: [] });
  useEffect(() => { setChosen(defaultChapterId || ""); }, [defaultChapterId]);
  const choosing = organizationWide || !defaultChapterId;
  useEffect(() => {
    if (!choosing || !api?.chapters || !organizationId) { setChapters({ phase: "idle", items: [] }); return undefined; }
    let live = true;
    setChapters({ phase: "loading", items: [] });
    api.chapters(organizationId)
      .then((rows) => { if (live) setChapters({ phase: "ready", items: Array.isArray(rows) ? rows : [] }); })
      .catch(() => { if (live) setChapters({ phase: "error", items: [] }); });
    return () => { live = false; };
  }, [api, organizationId, choosing]);
  const options = chapters.items.some((chapter) => chapter.id === defaultChapterId) || !defaultChapterId
    ? chapters.items
    : [{ id: defaultChapterId, name: defaultChapterId }, ...chapters.items];
  return <>
    {choosing && (options.length > 1 || (!defaultChapterId && options.length > 0)) ? <p className="seniority-scope">
      <label htmlFor={`${id}-chapter`}>{t("seniority.chapterLabel")}</label>{" "}
      <select id={`${id}-chapter`} value={chosen} onChange={(event) => setChosen(event.target.value)}>
        {!chosen && <option value="">{t("seniority.chooseChapter")}</option>}
        {options.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.name || chapter.id}</option>)}
      </select>
    </p> : null}
    {!defaultChapterId && chapters.phase === "error" && <p role="alert">{t("seniority.chaptersError")}</p>}
    {chosen ? children(chosen) : null}
  </>;
}

export function SeniorityPanel({ api, chapterId, now = Date.now() }) {
  const { t, lang } = useLang();
  const id = useId();
  const [list, load] = useSeniorityList(api, chapterId);
  // A seniority change also re-reads the bids, whose order and dates follow it.
  const reload = () => { load(); notifyBidsChanged(chapterId); };
  return <section className="cwk-panel seniority-panel" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>{t("seniority.title")}</h2>
    <p>{t("seniority.rule")}</p>
    {list.phase === "loading" && <p role="status">{t("seniority.loading")}</p>}
    {(list.phase === "error" || list.stale) && <p role="alert">{t("seniority.error")} <button type="button" className="dialog-secondary" onClick={reload}>{t("seniority.retry")}</button></p>}
    {list.phase === "ready" && list.openQuestions > 0 && <p role="status">{plural(t, "seniority.openQuestions", list.openQuestions)}</p>}
    {list.phase === "ready" && list.items.length === 0 && <p>{t("seniority.empty")}</p>}
    {list.items.length > 0 && <table className="seniority-table">
      <thead><tr>
        <th scope="col">{t("seniority.colPosition")}</th><th scope="col">{t("seniority.colName")}</th><th scope="col">{t("seniority.colDate")}</th>
        <th scope="col">{t("seniority.colClassification")}</th><th scope="col">{t("seniority.colTieBreak")}</th><th scope="col">{t("seniority.colQuestion")}</th><th scope="col"><span className="sr-only">{t("seniority.remove")}</span></th>
      </tr></thead>
      <tbody>{list.items.map((entry) => <tr key={entry.id}>
        <td>{entry.position}</td><td>{entry.name}</td><td>{seniorityDay(entry.seniorityDate, lang)}</td><td>{entry.classification ?? ""}</td><td>{entry.tieBreakNote ?? ""}</td>
        <td>
          {entry.question?.status === "open" && <>
            <p>{t("seniority.questionOpen", { note: entry.question.note })}</p>
            <AnswerForm entry={entry} api={api} onDone={reload} />
          </>}
          {entry.question?.status === "answered" && <p>{t("seniority.questionAnswered", { answer: entry.question.answer })}</p>}
        </td>
        <td><button type="button" className="dialog-secondary" aria-label={t("seniority.removeNamed", { name: entry.name })} onClick={async () => { await api.remove(entry.id); reload(); }}>{t("seniority.remove")}</button></td>
      </tr>)}</tbody>
    </table>}
    {list.nextCursor && <button type="button" className="dialog-secondary" onClick={() => load(list.nextCursor)}>{t("seniority.showMore")}</button>}
    <EntryForm api={api} chapterId={chapterId} onSaved={reload} />
    <ImportForm api={api} chapterId={chapterId} onSaved={reload} />
    <BidsSection api={api} chapterId={chapterId} now={now} />
  </section>;
}

// The bid deadlines beside the steward's other dated work (the private
// reminders on the caseload page): open windows closing within 30 days.
// BUG-UG-STEWARD-BID-DEADLINES-VANISH-ON-A-FAILED-READ-20261125 (#9968,
// from #9465): a failed read is not an empty list. A refusal for role or scope
// (42501) still shows nothing; any other failure says the deadlines could not
// be loaded, or, after a bid change, that those shown may be out of date.
const NO_DEADLINES = Object.freeze({ windows: [], failed: false, retried: false });

export function BidDeadlines({ api, chapterId, now = Date.now() }) {
  const { t, lang } = useLang();
  const [state, setState] = useState(NO_DEADLINES);
  const [retrying, setRetrying] = useState(false);
  const generation = useRef(0);
  // #9968: one scope per api and chapter. Its read, its retry lock and
  // its pending state end with it, so a retry still running for the chapter
  // the steward left neither refuses the new chapter's Try again nor clears
  // that chapter's pending state.
  const scopeRef = useRef(null);
  const retryRef = useRef(null);
  // Try again is removed when its read lands. The heading takes its focus only
  // when Try again still held it, so a keyboard user is not sent to the page
  // and focus is never pulled from a control they moved to.
  const headingRef = useRef(null);
  const focusHeadingRef = useRef(false);
  useEffect(() => {
    if (!focusHeadingRef.current) return;
    focusHeadingRef.current = false;
    headingRef.current?.focus();
  });
  useEffect(() => {
    let live = true;
    setState(NO_DEADLINES); setRetrying(false);
    // Only the latest read settles the list; an older one landing later is dropped.
    const load = (retried = false) => {
      const mine = ++generation.current;
      return Promise.resolve().then(() => api.deadlines(chapterId)).then((rows) => {
        if (!live || mine !== generation.current) return;
        // Checked before the commit that removes Try again.
        if (retried && retryRef.current && retryRef.current === globalThis.document?.activeElement) focusHeadingRef.current = true;
        setState({ windows: Array.isArray(rows) ? rows : [], failed: false, retried });
      }, (error) => {
        if (live && mine === generation.current) setState((current) => (error?.code === "42501" ? NO_DEADLINES : { ...current, failed: true }));
      });
    };
    const scope = { load, locks: { current: new Set() }, isLive: () => live };
    scopeRef.current = scope;
    const onChange = (event) => { if (!event?.detail?.chapterId || event.detail.chapterId === chapterId) load(); };
    load();
    globalThis.addEventListener?.(BIDS_CHANGED_EVENT, onChange);
    return () => { live = false; if (scopeRef.current === scope) scopeRef.current = null; globalThis.removeEventListener?.(BIDS_CHANGED_EVENT, onChange); };
  }, [api, chapterId]);
  function retry() {
    const scope = scopeRef.current;
    if (!scope) return undefined;
    return runBusyWrite(scope.locks, "retrying", async (releaseBusyWrite) => {
      setRetrying(true);
      try { await scope.load(true); } finally {
        if (scope.isLive()) setRetrying(false);
        releaseBusyWrite();
      }
    });
  }
  const due = upcomingBidDeadlines(state.windows, now);
  // #9968: "none" is the server's answer, never the browser clock's.
  // Rows the server returned that this clock filters out make no claim.
  const serverEmpty = state.windows.length === 0;
  if (!due.length && !state.failed && !(state.retried && serverEmpty)) return null;
  return <section className="seniority-deadlines" aria-label={t("seniority.deadlinesTitle")}>
    <h3 ref={headingRef} tabIndex={-1}>{t("seniority.deadlinesTitle")}</h3>
    {due.length > 0 && <ul>{due.map((window) => <li key={window.id}>{t("seniority.deadlineLine", { subject: window.subject, when: formatDateTimeWithZone(window.closesAt, lang) })}</li>)}</ul>}
    {state.failed && <>
      {/* #9968 Sol r1: the alert leaves while a retry runs, so a second failure inserts it again and is announced. */}
      {retrying
        ? <p key="loading" role="status">{t("seniority.deadlinesLoading")}</p>
        : <p key="failed" role="alert">{t(due.length ? "seniority.deadlinesStale" : "seniority.deadlinesError")}</p>}
      <BusyButton ref={retryRef} type="button" pending={retrying} onClick={() => void retry()}>{t("seniority.retry")}</BusyButton>
    </>}
    {!state.failed && !due.length && <p role="status">{t("seniority.deadlinesNone")}</p>}
  </section>;
}
