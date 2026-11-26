import { useCallback, useEffect, useRef, useState } from "react";
import { BusyButton, BusySelect, BusyFieldset } from "./BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { withLoadDeadline } from "../lib/loadDeadline.js";
import { loadChapterBudgetAccess, loadChapterBudgets, saveChapterBudget, setChapterBudgetOffice } from "../lib/memberApi.js";
import { isConflictRefusalCode } from "../lib/memberApiError.js";
import "../lib/i18n/features/chapterBudgetStrings.js";

const blankLine = () => ({ name: "", planned: 0, actual: 0 });
const blankBudget = () => ({ title: "", period_start: "", period_end: "", notes: "", items: [blankLine()] });

// The parent keys this panel by identity, organization and chapter. Every RPC
// also binds that scope: old writes cannot land in a newly selected chapter.
export function ChapterBudgetPanel({ client, scope, canAuthor = true }) {
  const { t, lang } = useLang();
  const currency = new Intl.NumberFormat(lang, { style: "currency", currency: "USD" });
  const [access, setAccess] = useState(null);
  const [budgets, setBudgets] = useState([]);
  const [page, setPage] = useState(0);
  const [memberPage, setMemberPage] = useState(0);
  const [editor, setEditor] = useState(null);
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (#8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const generation = useRef(0);
  const live = useRef(true);
  const scopeOrg = scope.organizationId;
  const scopeChapter = scope.chapterId;
  useEffect(() => { live.current = true; return () => { live.current = false; generation.current += 1; }; }, []);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true); setError(""); setAccess(null); setBudgets([]);
    try {
      const bound = { organizationId: scopeOrg, chapterId: scopeChapter };
      let next;
      try {
        // Both reads are bounded like the shell, so "Loading budget access…"
        // ends in the error line with Refresh rather than waiting
        // indefinitely (REQ-UG-PAGE-LOADING-STALLS-20261030).
        next = await withLoadDeadline(loadChapterBudgetAccess(client, bound, memberPage));
      } catch (failure) {
        // The web deployment can precede the hosted budget migration.
        if (failure?.code === "PGRST202" || failure?.code === "42883") return;
        throw failure;
      }
      next = { ...next, canRead: next.canRead && (canAuthor || next.legacyRead === true), canAssign: next.canAssign && canAuthor };
      const rows = next.canRead ? await withLoadDeadline(loadChapterBudgets(client, bound, page)) : [];
      if (current === generation.current && live.current) { setAccess(next); setBudgets(rows); }
    } catch { if (current === generation.current && live.current) setError(t("budget.failed")); }
    finally { if (current === generation.current && live.current) setLoading(false); }
  }, [client, scopeOrg, scopeChapter, page, memberPage, t, canAuthor]);
  useEffect(() => { setEditor(null); }, [client, scopeOrg, scopeChapter, canAuthor]);
  useEffect(() => { refresh(); return () => { generation.current += 1; }; }, [refresh]);

  function mutate(action, saved) {
    return runBusyWrite(busyWriteRef, "budget", () => mutateNow(action, saved));
  }

  async function mutateNow(action, saved) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await action();
      if (!live.current) return;
      saved?.(); setMessage(t("budget.saved")); await refresh();
    } catch (failure) {
      if (live.current) setError(t(isConflictRefusalCode(failure?.code) ? "budget.conflict" : "budget.failed"));
    } finally { if (live.current) setBusy(false); }
  }

  if (!loading && !error && !access?.canRead && !access?.canAssign) return null;
  const disabled = busy || loading;
  return <section className="chapter-budget" aria-label={t("budget.title")}>
    <h2>{t("budget.title")}</h2>
    {loading && <p role="status">{t("budget.loading")}</p>}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    <BusyButton type="button" className="outline-pill" pending={disabled} onClick={refresh}>{t("budget.refresh")}</BusyButton>
    {access?.canAssign && <details>
      <summary>{t("budget.access")}</summary><p>{t("budget.accessHelp")}</p>
      {(access.members || []).slice(0, 20).map((member) => <OfficeRow key={member.id} member={member} pending={disabled} t={t}
        onSave={(office) => mutate(() => setChapterBudgetOffice(client, scope, member.id, office))} />)}
      <Pager page={memberPage} next={(access.members || []).length > 20} pending={disabled} setPage={setMemberPage} t={t} />
    </details>}
    {access?.canRead && <>
      <p>{t("budget.privacy")}</p>
      {!editor && <BusyButton type="button" className="outline-pill" pending={disabled} onClick={() => setEditor(blankBudget())}>{t("budget.new")}</BusyButton>}
      {editor && <BudgetEditor key={editor.id || "new"} draft={editor} setDraft={setEditor} pending={disabled} t={t}
        onCancel={() => setEditor(null)} onSave={(budget) => mutate(() => saveChapterBudget(client, scope, budget), () => {
          // A new budget lists first, so return there instead of a later page.
          setEditor(null); if (!budget.id) setPage(0);
        })} />}
      {!budgets.length && <p>{t("budget.empty")}</p>}
      {budgets.slice(0, 20).map((budget) => <article key={budget.id}>
        <h3>{budget.title}</h3><p>{budget.period_start} – {budget.period_end}</p>
        <p className="chapter-budget__notes">{budget.notes}</p>
        <ol>{budget.items.map((line, index) => <li key={index}>
          <strong>{line.name}</strong> · {t("budget.planned")}: {currency.format(line.planned)} · {t("budget.actual")}: {currency.format(line.actual)}
        </li>)}</ol>
        <BusyButton type="button" className="outline-pill" pending={disabled} disabled={Boolean(editor)} onClick={() => { setError(""); setMessage(""); setEditor({ ...budget, items: budget.items.map((line) => ({ ...line })) }); }}>{t("budget.edit", { title: budget.title })}</BusyButton>
      </article>)}
      <Pager page={page} next={budgets.length > 20} pending={disabled} disabled={Boolean(editor)} setPage={setPage} t={t} />
    </>}
  </section>;
}

function Pager({ page, next, pending, disabled = false, setPage, t }) {
  return <div className="chapter-budget__actions">
    <BusyButton type="button" className="outline-pill" pending={pending} disabled={disabled || page === 0} onClick={() => setPage(page - 1)}>{t("budget.previous")}</BusyButton>
    <BusyButton type="button" className="outline-pill" pending={pending} disabled={disabled || !next} onClick={() => setPage(page + 1)}>{t("budget.next")}</BusyButton>
  </div>;
}
function OfficeRow({ member, pending, t, onSave }) {
  const [office, setOffice] = useState(member.office || "");
  useEffect(() => { setOffice(member.office || ""); }, [member.office]);
  return <div className="chapter-budget__office">
    <label>{t("budget.officeFor", { name: member.name })}
      <BusySelect pending={pending} value={office} onChange={(event) => setOffice(event.target.value)}>
        {["", "treasurer", "secretary_treasurer", "secretary"].map((key) => <option key={key} value={key}>{t(`budget.office.${key || "none"}`)}</option>)}
      </BusySelect>
    </label>
    <BusyButton type="button" className="outline-pill" pending={pending} disabled={office === (member.office || "")} onClick={() => onSave(office)}>{t("budget.assign", { name: member.name })}</BusyButton>
  </div>;
}
function BudgetEditor({ draft, setDraft, pending, t, onCancel, onSave }) {
  function field(key, value) { setDraft((current) => ({ ...current, [key]: value })); }
  function lineField(index, key, value) {
    setDraft((current) => ({ ...current, items: current.items.map((line, i) => i === index ? { ...line, [key]: value } : line) }));
  }
  function submit(event) {
    event.preventDefault();
    if (!pending) onSave({ ...draft, items: draft.items.map((line) => ({ ...line, name: line.name.trim(), planned: Number(line.planned), actual: Number(line.actual) })) });
  }
  return <form onSubmit={submit} aria-label={t("budget.editor")}>
    <BusyFieldset pending={pending}>
      <legend>{t("budget.editor")}</legend>
      <label>{t("budget.name")}<input required maxLength={160} value={draft.title} onChange={(event) => field("title", event.target.value)} /></label>
      <label>{t("budget.start")}<input required type="date" value={draft.period_start} onChange={(event) => field("period_start", event.target.value)} /></label>
      <label>{t("budget.end")}<input required type="date" min={draft.period_start} value={draft.period_end} onChange={(event) => field("period_end", event.target.value)} /></label>
      <label>{t("budget.notes")}<textarea maxLength={4000} value={draft.notes} onChange={(event) => field("notes", event.target.value)} /></label>
      {draft.items.map((line, index) => <fieldset key={index}>
        <legend>{t("budget.line", { number: index + 1 })}</legend>
        <label>{t("budget.itemName")}<input required maxLength={160} value={line.name} onChange={(event) => lineField(index, "name", event.target.value)} /></label>
        {["planned", "actual"].map((key) => <label key={key}>{t(`budget.${key}`)}<input required type="number" step="0.01" min="-9999999999.99" max="9999999999.99" value={line[key]} onChange={(event) => lineField(index, key, event.target.value)} /></label>)}
        <button type="button" className="outline-pill" disabled={draft.items.length === 1} onClick={() => field("items", draft.items.filter((_, i) => i !== index))}>{t("budget.removeLine", { number: index + 1 })}</button>
      </fieldset>)}
      <button type="button" className="outline-pill" disabled={draft.items.length >= 100} onClick={() => field("items", [...draft.items, blankLine()])}>{t("budget.addLine")}</button>
      <div className="chapter-budget__actions"><button type="submit" className="outline-pill">{t("budget.save")}</button>
        <button type="button" className="outline-pill" onClick={onCancel}>{t("budget.cancel")}</button></div>
    </BusyFieldset>
  </form>;
}
