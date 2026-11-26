import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { withLoadDeadline } from "../../lib/loadDeadline.js";
import { createChapterFinanceApi } from "../../lib/chapterFinanceApi.js";
import { loadChapterBudgets } from "../../lib/memberApi.js";
import { isConflictRefusalCode } from "../../lib/memberApiError.js";
import { isOfflineError } from "../../lib/outbox.js";
import { BusyButton, BusyInput, BusySelect, BusyTextarea } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";
import "../chapterAccess/chapterAccess.css";

const FINANCE_REFUSALS = new Map([
  ["42501:step-up required", "stepUp.notice"],
  ["42501:chapter finance context required", "finance.contextRequired"],
  ["42501:finance attribution access required", "finance.accessRequired"],
  ["42501:financial document access required", "finance.accessRequired"],
  ["42501:financial publication access required", "finance.accessRequired"],
  ["42501:financial record access required", "finance.accessRequired"],
  ["42501:active chapter member required", "finance.activeMemberRequired"],
  ["42501:budget unavailable", "finance.budgetUnavailable"],
  ["22023:invalid financial request", "finance.invalidRequest"],
  ["22023:invalid financial document", "finance.invalidDocument"],
  ["22023:budget kind required", "finance.budgetKindRequired"],
  ["22023:invalid financial decision", "finance.invalidDecision"],
]);

function financeFailureKey(error, fallback) {
  if (isConflictRefusalCode(error?.code)) return "rpcError.conflict";
  const raw = typeof error?.message === "string" ? error.message : "";
  const prefix = error?.label ? `${error.label}: ` : "";
  const message = prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  return FINANCE_REFUSALS.get(`${error?.code}:${message}`)
    ?? (isOfflineError(error, null) ? "offline.unconfirmed" : fallback);
}

function FinanceFailure({ feedback }) {
  return feedback ? <p id={feedback.id} className="xus-note xus-note--error" role="alert">{feedback.text}</p> : null;
}

function Pager({ page, more, setPage, busy, t, label }) {
  return <nav className="institutional-actions" aria-label={label}>
    <BusyButton type="button" pending={busy} disabled={page === 0} onClick={() => setPage(page - 1)}>{t("finance.previous")}</BusyButton>
    <BusyButton type="button" pending={busy} disabled={!more} onClick={() => setPage(page + 1)}>{t("finance.next")}</BusyButton>
  </nav>;
}

function BudgetChoice({ client, scope, value, setValue, busy, t }) {
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({ phase: "loading", rows: [] });
  useEffect(() => {
    let active = true;
    setValue(""); setState({ phase: "loading", rows: [] });
    withLoadDeadline(loadChapterBudgets(client, { organizationId: scope.organizationId, chapterId: scope.chapterId }, page))
      .then((rows) => { if (!Array.isArray(rows)) throw new Error("budget choices unavailable"); if (active) setState({ phase: "ready", rows }); })
      .catch(() => { if (active) setState({ phase: "error", rows: [] }); });
    return () => { active = false; };
  }, [client, scope.organizationId, scope.chapterId, page, revision, setValue]);
  return <>
    <label>{t("finance.budget")}<BusySelect name="budget" required value={value} onChange={(event) => setValue(event.target.value)} pending={busy} disabled={state.phase !== "ready"}>
      <option value="">{t("finance.chooseBudget")}</option>{state.rows.slice(0, 20).map((budget) => <option key={budget.id} value={budget.id}>{budget.title}</option>)}
    </BusySelect></label>
    {state.phase === "loading" && <p role="status">{t("finance.budgetsLoading")}</p>}
    {state.phase === "error" && <p role="alert">{t("finance.budgetsFailed")}</p>}
    <BusyButton type="button" pending={busy} disabled={state.phase === "loading"} onClick={() => { setPage(0); setRevision((current) => current + 1); }}>{t("finance.refreshBudgets")}</BusyButton>
    <Pager page={page} more={state.rows.length > 20} setPage={setPage} busy={busy || state.phase === "loading"} t={t} label={t("finance.budget")} />
  </>;
}

function FinancialDocumentEditor({ document, client, scope, submit, cancel, busy, canPublish, canBudget, failure, t }) {
  const [kind, setKind] = useState(document.kind || "financial_report");
  const [budgetId, setBudgetId] = useState("");
  return <form className="institutional-form" onSubmit={(event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    submit({ id: document.id, revision: document.revision, kind, title: form.get("title"), body: form.get("body"), budgetId: form.get("budget"), status: form.get("status") });
  }}>
    <h4>{t("finance.editDocument")}</h4>
    <label>{t("finance.kind")}<BusySelect value={kind} onChange={(event) => setKind(event.target.value)} pending={busy}>
      {["financial_report", "meeting_report", "financial_notice", ...(canBudget ? ["budget"] : [])].map((value) => <option key={value} value={value}>{t(`finance.kind.${value}`)}</option>)}
    </BusySelect></label>
    <label>{t("finance.titleLabel")}<BusyInput name="title" required maxLength={160} defaultValue={document.title} pending={busy} /></label>
    <label>{t("finance.body")}<BusyTextarea name="body" required maxLength={100000} defaultValue={document.body} pending={busy} /></label>
    {kind === "budget" && <BudgetChoice client={client} scope={scope} value={budgetId} setValue={setBudgetId} busy={busy} t={t} />}
    <label>{t("finance.statusLabel")}<BusySelect name="status" defaultValue={document.status || "draft"} pending={busy}>
      <option value="draft">{t("finance.status.draft")}</option>{canPublish && <option value="published">{t("finance.status.published")}</option>}<option value="archived">{t("finance.status.archived")}</option>
    </BusySelect></label>
    <FinanceFailure feedback={failure} />
    <div className="institutional-actions"><BusyButton pending={busy} aria-describedby={failure?.id} disabled={kind === "budget" && !budgetId}>{t("finance.save")}</BusyButton><BusyButton type="button" pending={busy} onClick={cancel}>{t("finance.cancel")}</BusyButton></div>
  </form>;
}

function RequestDecision({ request, busy, decide, failure, t }) {
  return <form className="institutional-form" onSubmit={(event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    decide(request, form.get("decision"), form.get("note"));
  }}>
    <label>{t("finance.decision")}<BusySelect name="decision" pending={busy}><option value="approved">{t("finance.status.approved")}</option><option value="declined">{t("finance.status.declined")}</option></BusySelect></label>
    <label>{t("finance.decisionNote")}<BusyTextarea name="note" required maxLength={2000} pending={busy} /></label>
    <BusyButton pending={busy} aria-describedby={failure?.id}>{t("finance.recordDecision")}</BusyButton>
    <FinanceFailure feedback={failure} />
  </form>;
}

// Mounted with an identity/organization/chapter key. Every RPC additionally
// binds the expected context; stale responses cannot cross a scope change.
export function ChapterFinancePanel({ client, scope, memberId, canAuthor = false }) {
  const { t, lang } = useLang();
  const api = useMemo(() => createChapterFinanceApi(client, { organizationId: scope.organizationId, chapterId: scope.chapterId }, canAuthor), [client, scope.organizationId, scope.chapterId, canAuthor]);
  const [state, setState] = useState({ phase: "loading", workspace: null });
  const [page, setPage] = useState(0);
  const [requestPage, setRequestPage] = useState(0);
  const [memberPage, setMemberPage] = useState(0);
  const [query, setQuery] = useState("");
  const [members, setMembers] = useState([]);
  const [memberError, setMemberError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState(null);
  const failureId = useId();
  const [editor, setEditor] = useState(null);
  const generation = useRef(0);
  // Synchronous write lock (record 8435), keyed by the chapter and the record
  // the write changes, so a second activation of the same write is refused
  // before React commits busy; nothing ever clears it but the write itself.
  const busyWriteRef = useRef(new Set());
  useEffect(() => {
    const current = ++generation.current;
    setState({ phase: "loading", workspace: null }); setEditor(null); setBusy(false); setFailure(null);
    if (!api) return undefined;
    withLoadDeadline(api.load(page, requestPage)).then((workspace) => {
      if (!workspace || workspace.chapterId !== scope.chapterId || workspace.organizationId !== scope.organizationId || !Array.isArray(workspace.documents) || !Array.isArray(workspace.requests)) throw new Error("finance context changed");
      const selected = canAuthor ? workspace : { ...workspace,
        canRecords: false, canDocuments: false, canPublish: false, canRoster: false,
        documents: workspace.documents.filter((document) => document.status === "published"),
        requests: workspace.requests.filter((request) => request.subject_id === memberId),
      };
      if (current === generation.current) setState({ phase: "ready", workspace: selected });
    }).catch(() => { if (current === generation.current) setState({ phase: "error", workspace: null }); });
    return () => { generation.current += 1; };
  }, [api, client, scope.organizationId, scope.chapterId, page, requestPage, revision, memberId, canAuthor]);
  useEffect(() => {
    let active = true;
    setMembers([]); setMemberError(false);
    if (api && state.workspace?.canRoster) withLoadDeadline(api.members(memberPage, query)).then((result) => {
      if (active) setMembers(result);
    }).catch(() => { if (active) setMemberError(true); });
    return () => { active = false; };
  }, [api, state.workspace, memberPage, query]);
  function run(record, fallback, operation) {
    return runBusyWrite(busyWriteRef, `${scope.organizationId}:${scope.chapterId}:${record}`, () => runNow(record, fallback, operation));
  }

  async function runNow(record, fallback, operation) {
    if (busy) return;
    const current = generation.current;
    setBusy(true); setNotice(""); setFailure(null);
    try {
      await operation();
      if (current === generation.current) { setEditor(null); setState({ phase: "loading", workspace: null }); setRevision((value) => value + 1); setNotice("finance.saved"); }
    } catch (error) {
      if (current === generation.current) setFailure({ record, key: financeFailureKey(error, fallback) });
    }
    finally { if (current === generation.current) setBusy(false); }
  }
  function feedbackFor(record) {
    return failure?.record === record ? { id: failureId, text: t(failure.key) } : null;
  }
  function changeEditor(document) {
    setEditor(document);
    setFailure((current) => current?.record.startsWith("document:") ? null : current);
  }
  if (!api) return null;
  const workspace = state.workspace;
  const requestFailure = feedbackFor("request:new");
  const currency = new Intl.NumberFormat(lang, { style: "currency", currency: "USD" });
  return <section className="institutional-section chapter-access" aria-label={t("finance.title")}>
    <h3>{t("finance.title")}</h3>
    {state.phase === "loading" && <p role="status">{t("finance.loading")}</p>}
    {state.phase === "error" && <p role="alert">{t("finance.loadFailed")} <button type="button" onClick={() => setRevision((value) => value + 1)}>{t("finance.retry")}</button></p>}
    {notice && <p role="status">{t(notice)}</p>}
    {workspace && <>
      <h4>{t("finance.reports")}</h4>
      {workspace.canDocuments && <BusyButton type="button" pending={busy} onClick={() => changeEditor({})}>{t("finance.newDocument")}</BusyButton>}
      {editor && <FinancialDocumentEditor key={editor.id || "new"} document={editor} client={client} scope={scope} busy={busy}
        canPublish={workspace.canPublish} canBudget={workspace.canRecords} t={t} cancel={() => changeEditor(null)}
        failure={feedbackFor(`document:${editor.id || "new"}`)}
        submit={(document) => void run(`document:${document.id || "new"}`, "finance.documentUnconfirmed", () => api.saveDocument(document))} />}
      {!workspace.documents.length && <p>{t("finance.emptyReports")}</p>}
      {workspace.documents.slice(0, 20).map((document) => <article key={document.id} className="institutional-card">
        <h4>{document.title}</h4><p>{t(`finance.kind.${document.kind}`)} · {t(`finance.status.${document.status}`)}</p><p className="institutional-record-body">{document.body}</p>
        {document.budget_snapshot && <details><summary>{t("finance.budget")}</summary><p>{document.budget_snapshot.periodStart} – {document.budget_snapshot.periodEnd}</p><p>{document.budget_snapshot.notes}</p><ol>{document.budget_snapshot.items.map((line, index) => <li key={index}>{line.name}: {currency.format(line.planned)} / {currency.format(line.actual)}</li>)}</ol></details>}
        {workspace.canDocuments && (document.kind !== "budget" || workspace.canRecords) && (document.status !== "published" || workspace.canPublish) && <BusyButton type="button" pending={busy} onClick={() => changeEditor(document)}>{t("finance.editDocument")}</BusyButton>}
      </article>)}
      <Pager label={t("finance.reports")} page={page} more={workspace.documents.length>20} setPage={setPage} busy={busy} t={t} />
      <h4>{t("finance.requests")}</h4><p>{t("finance.requestsHelp")}</p>
      {workspace.canRoster && <form className="institutional-form" onSubmit={(event) => { event.preventDefault(); setQuery(new FormData(event.currentTarget).get("query")); setMemberPage(0); }}>
        <label>{t("finance.memberSearch")}<BusyInput name="query" maxLength={120} defaultValue={query} pending={busy} /></label><BusyButton pending={busy}>{t("finance.search")}</BusyButton>
      </form>}
      {memberError && <p role="alert">{t("finance.membersFailed")} <button type="button" onClick={() => setRevision((value) => value + 1)}>{t("finance.retry")}</button></p>}
      {workspace.canSubmit === false && <p>{t("finance.stepUp")}</p>}
      {workspace.canSubmit !== false && <form className="institutional-form" onSubmit={(event) => {
        event.preventDefault(); const form = new FormData(event.currentTarget);
        void run("request:new", "finance.requestUnconfirmed", () => api.submit({ subjectId: form.get("subject") || memberId, kind: form.get("kind"), title: form.get("title"), description: form.get("description"), amount: form.get("amount") }));
      }}>
        {workspace.canRoster && workspace.canRecords && <label>{t("finance.member")}<BusySelect name="subject" pending={busy}><option value="">{t("finance.myself")}</option>{members.slice(0,20).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</BusySelect></label>}
        <label>{t("finance.requestKind")}<BusySelect name="kind" pending={busy}><option value="expense">{t("finance.kind.expense")}</option><option value="reimbursement">{t("finance.kind.reimbursement")}</option></BusySelect></label>
        <label>{t("finance.titleLabel")}<BusyInput name="title" required maxLength={160} pending={busy} /></label>
        <label>{t("finance.description")}<BusyTextarea name="description" required maxLength={4000} pending={busy} /></label>
        <label>{t("finance.amount")}<BusyInput type="number" name="amount" required min="0.01" max="9999999999.99" step="0.01" pending={busy} /></label>
        <BusyButton pending={busy} aria-describedby={requestFailure?.id}>{t("finance.submitRequest")}</BusyButton>
        <FinanceFailure feedback={requestFailure} />
      </form>}
      {workspace.canRoster && <Pager label={t("finance.member")} page={memberPage} more={members.length>20} setPage={setMemberPage} busy={busy} t={t} />}
      {!workspace.requests.length && <p>{t("finance.emptyRequests")}</p>}
      {workspace.requests.slice(0,20).map((request) => <article key={request.id} className="institutional-card">
        <h4>{request.title}</h4><p>{t(`finance.kind.${request.kind}`)} · {currency.format(request.amount)} · {t(`finance.status.${request.status}`)}</p>
        {request.subject_name && <p>{t("finance.requestedFor", { name: request.subject_name })}</p>}
        <p className="institutional-record-body">{request.description}</p><p>{request.decision_note}</p>
        {workspace.canRecords && request.status === "pending" && <RequestDecision request={request} busy={busy} t={t}
          failure={feedbackFor(`request:${request.id}`)}
          decide={(item, decision, note) => void run(`request:${item.id}`, "finance.decisionUnconfirmed", () => api.decide(item, decision, note))} />}
      </article>)}
      <Pager label={t("finance.requests")} page={requestPage} more={workspace.requests.length>20} setPage={setRequestPage} busy={busy} t={t} />
    </>}
  </section>;
}
