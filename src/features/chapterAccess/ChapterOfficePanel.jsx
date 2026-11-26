import { prepareBusyWrite } from "../../lib/busyWrite.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { withLoadDeadline } from "../../lib/loadDeadline.js";
import { createChapterAccessApi } from "../../lib/chapterAccessApi.js";
import { listMyMemberNotices, getMemberNoticeReceipts, listAnnouncementDrafts, resolveAnnouncementDraft } from "../../lib/memberApi.js";
import { OfficerNoticeDesk } from "../notices/OfficerNoticeDesk.jsx";
import "./chapterAccess.css";

const tag = (scope) => scope?.unitId ? `unit:${scope.unitId}` : scope?.committeeId ? `committee:${scope.committeeId}` : "";

function DocumentEditor({ document, office, chapterId, save, close, t }) {
  const busyWriteRef = useRef(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const scopes = office.scopes.filter((scope) => scope.documents);
  const tag = (scope) => scope.unitId ? `unit:${scope.unitId}` : `committee:${scope.committeeId}`;
  async function submit(event, action) {
    return prepareBusyWrite(busyWriteRef, "busy", () => {
      event.preventDefault(); const element = event.currentTarget.closest("form");
      if (action !== "archive" && !element.reportValidity()) return;
      const form = new FormData(element);
      return async (releaseBusyWrite) => {
        setBusy(true); setError(false);
        try {
          await save(document?.id, { chapterId, title: form.get("title"), body: form.get("body"), summary: form.get("summary"), documentType: document?.document_type || "other", visibility: document?.visibility || "chapter", status: action === "republish" ? "published" : "draft", accessScope: form.get("scope") }, action);
        } catch { setError(true); }
        finally { setBusy(false);
          releaseBusyWrite();
        }
      };
    }, event);
  }
  return <form className="institutional-form" onSubmit={(event) => void submit(event, "save")}>
    <h4>{t(document ? "access.editDocument" : "access.newDocument")}</h4>
    <label>{t("access.documentTitle")}<input name="title" required maxLength={200} defaultValue={document?.title} /></label>
    <label>{t("access.documentSummary")}<input name="summary" maxLength={1000} defaultValue={document?.summary} /></label>
    <label>{t("access.documentBody")}<textarea name="body" required maxLength={100000} defaultValue={document?.body} /></label>
    {!document && <label>{t("access.scope")}<select name="scope" required={!office.unscopedDocuments}>{office.unscopedDocuments && <option value="">{t("access.chapter")}</option>}{scopes.map((scope) => <option key={`${scope.role}:${tag(scope)}`} value={tag(scope)}>{scope.name}</option>)}</select></label>}
    {error && <p role="alert">{t("access.saveError")}</p>}
    <div className="institutional-actions">
      {document?.status !== "published" && <BusyButton pending={busy}>{t("access.save")}</BusyButton>}
      <BusyButton type="button" pending={busy} onClick={(event) => void submit(event, "republish")}>{t("access.publish")}</BusyButton>
      {document && <BusyButton type="button" pending={busy} onClick={(event) => void submit(event, "archive")}>{t("access.archive")}</BusyButton>}
      <BusyButton type="button" pending={busy} onClick={close}>{t("access.cancel")}</BusyButton>
    </div>
  </form>;
}

export function ChapterOfficePanel({ client, chapterId, role = null, onNotice = () => {} }) {
  const { t } = useLang();
  const api = useMemo(() => createChapterAccessApi(client), [client]);
  const [state, setState] = useState({ phase: "loading", office: null, documents: [] });
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [editor, setEditor] = useState(null);
  const [noticeScope, setNoticeScope] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setState({ phase: "loading", office: null, documents: [] }); setEditor(null); setNoticeScope("");
    if (!api || !chapterId) return undefined;
  // #9781: a first read that never answers ends in the panel's own
  // could-not-load line with its Try again after the shared deadline,
  // instead of "Loading access…" for as long as the page stays open.
    withLoadDeadline(() => api.office()).then(async (available) => {
      const office = role === "records" ? { ...available, notices: false } : available;
      if (office.chapterId !== chapterId) throw new Error("chapter context changed");
      const documents = office.documents ? await withLoadDeadline(() => api.documents(chapterId, page)) : [];
      if (current === generation.current) setState({ phase: "ready", office, documents });
    }).catch(() => { if (current === generation.current) setState({ phase: "error", office: null, documents: [] }); });
    return () => { generation.current += 1; };
  }, [api, chapterId, role, page, revision]);
  const noticeScopes = state.office?.scopes.filter((scope) => scope.notices) || [];
  const unscopedNotices = state.office?.unscopedNotices !== false;
  const currentNoticeScope = noticeScope || (unscopedNotices ? "" : tag(noticeScopes[0]));
  const notices = useMemo(() => ({
    loadAudiences: async () => {
      const office = await api.office();
      if (office.chapterId !== chapterId || !office.notices) return [];
      const scope = office.scopes.find((entry) => entry.notices && tag(entry) === currentNoticeScope);
      if (currentNoticeScope ? !scope : office.unscopedNotices !== true) return [];
      return [{ value: "chapter", kind: "chapter", name: scope?.name || "" }];
    },
    listMine: (before) => listMyMemberNotices(client, before),
    receipts: (id) => getMemberNoticeReceipts(client, id),
    listDrafts: () => unscopedNotices ? listAnnouncementDrafts(client) : Promise.resolve([]),
    resolveDraft: (id, value) => resolveAnnouncementDraft(client, id, value),
    // The desk's 4th argument (audience) is the scope above; the 5th is its draft key (#9220).
    publish: (title, body, locale, _audience, operationKey) => api.publishNotice(chapterId, title, body, locale, currentNoticeScope, operationKey),
  }), [client, chapterId, api, currentNoticeScope, unscopedNotices]);
  async function save(id, fields, action) {
    const current = generation.current;
    await api.saveDocument(id, fields, action);
    if (current === generation.current) { onNotice(t("access.saved")); setRevision((value) => value + 1); }
  }
  if (!api || !chapterId) return null;
  return <section className="institutional-section chapter-access" aria-label={t("access.office")}>
    <h3>{t("access.office")}</h3>
    {state.phase === "loading" && <p role="status">{t("access.loading")}</p>}
    {state.phase === "error" && <p role="alert">{t("access.error")} <button type="button" onClick={() => setRevision((value) => value + 1)}>{t("access.retry")}</button></p>}
    {state.office?.documents && <>
      <h4>{t("access.documents")}</h4><button type="button" onClick={() => setEditor({})}>{t("access.newDocument")}</button>
      {state.documents.length === 0 && <p>{t("access.empty")}</p>}
      {state.documents.slice(0, 20).map((document) => <article key={document.id} className="institutional-card"><h4>{document.title}</h4><p>{document.summary}</p><details><summary>{t("access.documents")}</summary><p className="institutional-record-body">{document.body}</p></details><button type="button" onClick={() => setEditor({ document })}>{t("access.editDocument")}</button></article>)}
      <nav className="institutional-actions" aria-label={t("access.documents")}><button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>{t("access.previous")}</button><button type="button" disabled={state.documents.length <= 20} onClick={() => setPage((value) => value + 1)}>{t("access.next")}</button></nav>
      {editor && <DocumentEditor document={editor.document} office={state.office} chapterId={chapterId} t={t} close={() => setEditor(null)} save={save} />}
    </>}
    {state.office?.notices && <>
      {noticeScopes.length > 0 && <label>{t("access.scope")}<select aria-label={t("access.noticeScope")} value={currentNoticeScope} onChange={(event) => setNoticeScope(event.target.value)}>{unscopedNotices && <option value="">{t("access.chapter")}</option>}{noticeScopes.map((scope) => <option key={`${scope.role}:${tag(scope)}`} value={tag(scope)}>{scope.name}</option>)}</select></label>}
      <OfficerNoticeDesk key={currentNoticeScope} api={notices} canPostOrganization={false} chapterAudienceLabel={noticeScopes.find((scope) => tag(scope) === currentNoticeScope)?.name} onNotice={onNotice} />
    </>}
  </section>;
}
