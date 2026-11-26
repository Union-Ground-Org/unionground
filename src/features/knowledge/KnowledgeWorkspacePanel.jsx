import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cloud, Download, FileUp, FolderPlus, History, RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import {
  beginGoogleDriveConnection,
  clearKnowledgeSource,
  deleteKnowledgeCollection,
  disconnectGoogleDrive,
  downloadConnectedDriveFile,
  getKnowledgeIngestSource,
  knowledgeFileBlob,
  listConnectedDriveFiles,
  listGoogleDriveFilingTargets,
  isMissingConversionReviewColumnError,
  knowledgeConversionReviewColumnsAvailable,
  listKnowledgeConversions,
  listKnowledgeReviewArticles,
  listKnowledgeRevisions,
  loadKnowledgeWorkspace,
  publishStewardLibraryFile,
  recheckKnowledgeFile,
  rejectKnowledgeConversion,
  restoreKnowledgeRevision,
  retryKnowledgeIngestSource,
  retryKnowledgeSource,
  reviewKnowledgeConversion,
  reviewStewardLibraryFile,
  saveKnowledgeCollection,
  setKnowledgeCollectionItem,
  uploadConnectedDriveFile,
  uploadStewardLibraryFile,
} from "./knowledgeApi.js";
import { KnowledgeConversionReviewCard } from "./KnowledgeConversionReviewCard.jsx";
// Card, Status and Empty were private to this module, so the conversion review
// card re-implemented all three. They now live in a shared module that both
// this panel and that card import. They are NOT re-exported from here: this
// module imports the card, so the card importing them back would be an import
// cycle, and an unread re-export is a new unused export -- both of which
// scripts/verify-static-quality.mjs refuses.
import { Card, Empty, Status } from "./knowledgeWorkspacePrimitives.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";
import { formatGroupMoment } from "../../lib/i18n/zonedDates.js";
import { withObjectUrl } from "../../lib/privateFileAccess.js";
import { BusyButton, BusySelect } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";

// No "contract" category: filing an agreement was the CBA ingest's entry
// point, and Union Ground has no CBA ingest. There is no
// collective bargaining agreement before a first contract.
const CATEGORIES = ["general", "forms", "guides", "health_safety", "meetings", "steward_tools", "training"];

// Within a section the cursor advances. When the needs-review section ends the
// settled section begins, and when that ends there is nothing further to read.
function nextConversionRequest(page) {
  if (page?.hasMore) return { section: page.section, cursor: page.nextCursor };
  return page?.section === "needs_review" ? { section: "settled", cursor: null } : null;
}

// REQ-UG-TRUSTED-SOURCE-STALENESS-CHECK-20261001: the hourly roll-up of
// stale, pending and failed trusted sources (old cron/trusted-info-source-health).
function SourceHealthCheck({ health, t, lang }) {
  const checkedAt = health.checkedAt ? new Date(health.checkedAt) : null;
  const attention = Array.isArray(health.attention) ? health.attention : [];
  return <section className="knowledge-workspace__source-health" aria-label={t("knowledge.sourceHealth.title")}>
    <div className="knowledge-workspace__row"><strong>{t("knowledge.sourceHealth.title")}</strong><Status>{t(health.enabled ? "knowledge.sourceHealth.on" : "knowledge.sourceHealth.offShort")}</Status></div>
    {!health.enabled ? <p>{t("knowledge.sourceHealth.off")}</p> : checkedAt && !Number.isNaN(checkedAt.valueOf())
      ? <p>{t("knowledge.sourceHealth.checked", { when: formatGroupMoment(health.checkedAt, lang), days: health.checkedStaleDays ?? health.staleDays })}</p>
      : <p>{t("knowledge.sourceHealth.notChecked")}</p>}
    {health.enabled && checkedAt && <ul className="knowledge-workspace__resource-list">
      <li><small>{t("knowledge.sourceHealth.articles", { total: health.articles?.total ?? 0, stale: health.articles?.stale ?? 0 })}</small></li>
      <li><small>{t("knowledge.sourceHealth.documents", { total: health.documents?.total ?? 0, stale: health.documents?.stale ?? 0, pending: health.documents?.pending ?? 0, failed: health.documents?.failed ?? 0 })}</small></li>
      <li><small>{t("knowledge.sourceHealth.sources", { total: health.sources?.total ?? 0, stale: health.sources?.stale ?? 0, pending: health.sources?.pending ?? 0, failed: health.sources?.failed ?? 0 })}</small></li>
    </ul>}
    {health.enabled && attention.length > 0 && <>
      <strong>{t("knowledge.sourceHealth.attention", { days: health.staleDays })}</strong>
      <ul className="knowledge-workspace__resource-list">
        {attention.map((item) => <li key={`${item.kind}-${item.id}`}><div><strong>{item.label}</strong><small>{t(`knowledge.sourceHealth.kind.${item.kind}`)} · {t(`knowledge.sourceHealth.reason.${item.reason}`)}</small></div></li>)}
      </ul>
    </>}
  </section>;
}

// The Drive card shows the catalogue label for the connection state, never
// the stored token; an unknown state reads as not set up.
const DRIVE_STATUS_KEYS = Object.freeze({
  unset: "knowledge.unset",
  requested: "knowledge.requested",
  connected: "knowledge.connected",
  revoked: "knowledge.revoked",
});

function driveStatusKey(status) {
  return Object.hasOwn(DRIVE_STATUS_KEYS, status) ? DRIVE_STATUS_KEYS[status] : DRIVE_STATUS_KEYS.unset;
}

export function KnowledgeWorkspacePanel({
  client,
  organizationId = null,
  canStaff,
  canAdmin,
  canDriveOperate = false,
  canHealth = false,
  articles = [],
  driveOutcome = "",
  onKnowledgeChanged = null,
  collectionChapterId = null,
  reviewChapterId: controlledReviewChapterId = null,
  onReviewChapterChange = null,
}) {
  const { t, lang } = useLang();
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [revisions, setRevisions] = useState([]);
  const [localReviewChapterId, setLocalReviewChapterId] = useState("");
  const [reviewArticles, setReviewArticles] = useState([]);
  const [revisionArticleId, setRevisionArticleId] = useState("");
  const [driveFiles, setDriveFiles] = useState([]);
  // REQ-UG-DRIVE-PER-CASE-FOLDERS-20261001: "" is the shared resources
  // folder; "case:<id>" / "meeting:<id>" file into that case or meeting folder.
  const [driveFiling, setDriveFiling] = useState({ enabled: false, cases: [], meetings: [] });
  const [driveTargetKey, setDriveTargetKey] = useState("");
  const [uploadCategory, setUploadCategory] = useState("general");
  // `checking` covers the window where the bytes are in the bucket but the
  // upload is not yet complete metadata; `staleFileId` marks the single file
  // whose clean verdict aged out, which one re-check fixes.
  const [uploadPhase, setUploadPhase] = useState("");
  const [staleFileId, setStaleFileId] = useState("");
  const [conversions, setConversions] = useState([]);
  const [conversionNext, setConversionNext] = useState(null);
  const [reviewColumnsAvailable, setReviewColumnsAvailable] = useState(true);
  const workspaceRequestRef = useRef(0);
  const reviewRequestRef = useRef(0);
  const reviewChapterId = controlledReviewChapterId ?? localReviewChapterId;
  const working = busy || workspaceLoading || reviewLoading;
  // Every write goes through run(): one synchronous lock refuses a second
  // activation before React commits `busy` .
  const busyWriteRef = useRef(new Set());

  const driveConnected = Boolean(snapshot?.drive?.connected);
  useEffect(() => {
    let active = true;
    if (!client || !canDriveOperate || !driveConnected) {
      setDriveFiling({ enabled: false, cases: [], meetings: [] });
      return () => { active = false; };
    }
    listGoogleDriveFilingTargets(client)
      .then((result) => {
        if (active) setDriveFiling({
          enabled: result?.enabled === true,
          cases: Array.isArray(result?.cases) ? result.cases : [],
          meetings: Array.isArray(result?.meetings) ? result.meetings : [],
        });
      })
      .catch(() => { if (active) setDriveFiling({ enabled: false, cases: [], meetings: [] }); });
    return () => { active = false; };
  }, [client, canDriveOperate, driveConnected]);


  const refresh = useCallback(async () => {
    const requestId = workspaceRequestRef.current + 1;
    workspaceRequestRef.current = requestId;
    if (!client) { setSnapshot(null); setWorkspaceLoading(false); return; }
    setWorkspaceLoading(true);
    setError("");
    try {
      const result = await loadKnowledgeWorkspace(client, {
        staff: canStaff,
        health: canHealth,
        chapterId: collectionChapterId,
      });
      let conversionRows = [];
      let conversionRequest = null;
      let reviewColumns = true;
      // The read is bound to one organization, so without one there is no
      // ledger to ask for rather than every organization's newest rows.
      if (canStaff && organizationId) {
        try {
          const page = await listKnowledgeConversions(client, organizationId);
          conversionRows = page.conversions;
          conversionRequest = nextConversionRequest(page);
          // An empty list has no row to read the flag from, so ask the probe.
          reviewColumns = conversionRows.length
            ? conversionRows.every((row) => row.reviewColumnsAvailable !== false)
            : knowledgeConversionReviewColumnsAvailable();
        } catch (cause) {
          if (isMissingConversionReviewColumnError(cause)) {
            conversionRows = [];
            conversionRequest = null;
            reviewColumns = false;
          } else if (workspaceRequestRef.current === requestId) {
            setError(cause?.message || t("knowledge.failed"));
          }
        }
      }
      if (workspaceRequestRef.current === requestId) {
        setSnapshot(result);
        setConversions(conversionRows);
        setConversionNext(conversionRequest);
        setReviewColumnsAvailable(reviewColumns);
      }
    } catch (cause) {
      if (workspaceRequestRef.current === requestId) {
        setSnapshot(null);
        setConversions([]);
        setConversionNext(null);
        setReviewColumnsAvailable(true);
        setError(cause?.message || t("knowledge.failed"));
      }
    } finally {
      if (workspaceRequestRef.current === requestId) setWorkspaceLoading(false);
    }
  }, [canHealth, canStaff, client, collectionChapterId, t, organizationId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => () => {
    workspaceRequestRef.current += 1;
    reviewRequestRef.current += 1;
  }, []);

  useEffect(() => {
    if (driveOutcome === "connected") setNotice(t("knowledge.driveConnected"));
    if (driveOutcome === "failed") setError(t("knowledge.driveFailed"));
  }, [t, driveOutcome]);

  async function run(action, { reload = true, success = true } = {}) {
    if (working) return null;
    const outcome = await runBusyWrite(busyWriteRef, "knowledge", async () => {
      setBusy(true); setError(""); setNotice("");
      try {
        const result = await action();
        if (reload) await refresh();
        if (success) setNotice(t("knowledge.success"));
        return result;
      } catch (cause) {
        setError(cause?.message || t("knowledge.failed"));
        return null;
      } finally { setBusy(false); }
    });
    return outcome ?? null;
  }

  const placementOptions = useMemo(() => [
    ...articles.filter((article) => !article.isSample).map((article) => ({ kind: "kb_article", id: article.id, label: `${article.title} · v${article.version}` })),
    ...(snapshot?.files || []).map((file) => ({ kind: "knowledge_file", id: file.id, label: `${file.title} · ${file.reviewStatus}` })),
  ], [articles, snapshot?.files]);

  if (!client) return <section className="knowledge-workspace" aria-label={t("knowledge.title")}><p className="knowledge-workspace__empty">{t("knowledge.unavailable")}</p></section>;
  if (!snapshot && !error) return <section className="knowledge-workspace" aria-label={t("knowledge.title")}><p role="status" className="knowledge-workspace__empty">{t("knowledge.loading")}</p></section>;
  // REQ-UG-ROLE-WORKSPACE-REFUSALS-20261030: a refused staff read is
  // a role question, not an outage. Say so in the page's language and offer no
  // "Try again", which could not change the role.
  if (!snapshot && /not authorized|42501/iu.test(String(error))) return <section className="knowledge-workspace" aria-label={t("knowledge.title")}><p role="status" className="knowledge-workspace__empty">{t("knowledge.unauthorized")}</p></section>;
  if (!snapshot) return <section className="knowledge-workspace" aria-label={t("knowledge.title")}><p role="alert" className="knowledge-workspace__error">{error}</p><button type="button" className="hub2-btn hub2-btn--primary" onClick={refresh}>{t("knowledge.retry")}</button></section>;

  // The signed URL this replaces was one decision honoured for its whole
  // lifetime, which a later quarantine could not revoke. An authenticated read
  // re-evaluates the restrictive policy on every request; the `download:`
  // disposition went with it, so the file name rides on an <a download>.
  async function openStoredFile(fileId, mode) {
    setStaleFileId("");
    const result = await run(async () => {
      try {
        return await knowledgeFileBlob(client, fileId, mode);
      } catch (cause) {
        // A file recorded as an outside link is not stored here and can never
        // be served (it carries no scan verdict); it is not a stale verdict, so
        // it must not offer the safety re-check.
        if (cause?.details === "knowledge_file_external_unsupported") {
          throw new Error(t("knowledge.fileExternalUnsupported"), { cause });
        }
        // A 4xx for an authorized reader is the quarantine policy saying the
        // clean verdict aged out. `download_*` now refuses upstream of Storage
        // for the same reason, so the RPC's own refusal is the same condition
        // reaching us one step earlier. One re-check is the fix for both.
        if (cause?.staleVerdict || isInspectionRefusal(cause)) {
          setStaleFileId(fileId);
          throw new Error(t("knowledge.staleFile"), { cause });
        }
        throw cause;
      }
    }, { reload: false, success: false });
    if (!result?.blob) return;
    // withObjectUrl defers the revoke: the browser has not necessarily started
    // the download when this returns.
    withObjectUrl(result.blob, (url) => {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.fileName;
      anchor.click();
    });
  }

  async function recheckStoredFile(fileId) {
    const done = await run(async () => {
      try {
        return await recheckKnowledgeFile(client, fileId);
      } catch (cause) {
        throw new Error(cause?.code === "rejected" ? t("knowledge.rejected") : t("knowledge.recheckFailed"), { cause });
      }
    }, { reload: false, success: false });
    if (done) setStaleFileId("");
  }

  // Approve and publish used to be gated client-side on `scanStatus === "clean"`.
  // After the workflow-gate migration nothing writes 'clean' to that column any
  // more — it is a lifecycle marker, not a malware verdict (invariant 7) — so
  // that condition would hide both buttons forever. 20260906022000 dropped the
  // field from the payload entirely so it cannot be reached for again. The
  // lifecycle fields that remain are reviewStatus and indexStatus. The ledger
  // verdict is not
  // carried in this snapshot, so `review_steward_library_file` and
  // `publish_steward_file_to_catalog` are the authority; their refusal is routed
  // to the same one-tap re-check a stale download already offers.
  function isInspectionRefusal(cause) {
    const message = String(cause?.message || "");
    return message.includes("file inspection required")
      || message.includes("only approved clean files can be published");
  }

  function gatedLibraryAction(fileId, action) {
    setStaleFileId("");
    return run(async () => {
      try {
        return await action();
      } catch (cause) {
        if (isInspectionRefusal(cause)) {
          setStaleFileId(fileId);
          throw new Error(t("knowledge.needsCheck"), { cause });
        }
        throw cause;
      }
    });
  }

  function approveLibraryFile(fileId) {
    return gatedLibraryAction(fileId, () => reviewStewardLibraryFile(client, fileId, "approved"));
  }

  function publishLibraryFile(file) {
    return gatedLibraryAction(file.id, () => publishStewardLibraryFile(client, file.id, file.category));
  }

  async function createCollection(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const result = await run(() => saveKnowledgeCollection(client, {
      ...values,
      chapterId: collectionChapterId,
    }));
    if (result) form.reset();
  }

  async function addPlacement(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const [itemKind, itemId] = String(values.item || "").split(":");
    if (!itemKind || !itemId) return;
    const result = await run(() => setKnowledgeCollectionItem(client, {
      collectionId: values.collectionId,
      itemKind,
      itemId,
      include: true,
      chapterId: collectionChapterId,
    }));
    if (result) form.reset();
  }

  async function uploadLibrary(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const file = form.elements.file.files?.[0];
    if (!file) return;
    setUploadPhase("");
    const result = await run(async () => {
      try {
        return await uploadStewardLibraryFile(client, file, values, { onPhase: setUploadPhase });
      } catch (cause) {
        // The inspection's own refusals get their own sentences: a rejection is
        // permanent and offers no retry, a quota refusal names the ceiling.
        if (cause?.code === "rejected") throw new Error(t("knowledge.rejected"), { cause });
        if (cause?.code === "rate-limited") throw new Error(t("knowledge.rateLimited"), { cause });
        if (cause?.code === "unsupported-format") throw new Error(t("knowledge.unsupportedFormat"), { cause });
        if (cause?.name === "PrivateFileError") throw new Error(t("knowledge.pendingCheck"), { cause });
        throw cause;
      } finally {
        setUploadPhase("");
      }
    }, { success: false });
    if (result) {
      form.reset();
      setUploadCategory("general");
      if (result.ingestionError) setError(result.ingestionError);
      else setNotice(t("knowledge.success"));
    }
  }

  async function loadReviewChapter(chapterId) {
    const requestId = reviewRequestRef.current + 1;
    reviewRequestRef.current = requestId;
    if (!chapterId) {
      setReviewLoading(false);
      return;
    }
    setReviewLoading(true);
    setError("");
    setNotice("");
    try {
      const result = await listKnowledgeReviewArticles(client, chapterId);
      if (reviewRequestRef.current === requestId) setReviewArticles(result);
    } catch (cause) {
      if (reviewRequestRef.current === requestId) setError(cause?.message || t("knowledge.failed"));
    } finally {
      if (reviewRequestRef.current === requestId) setReviewLoading(false);
    }
  }

  async function selectReviewChapter(event) {
    const chapterId = event.target.value;
    if (controlledReviewChapterId === null) setLocalReviewChapterId(chapterId);
    onReviewChapterChange?.(chapterId);
    setReviewArticles([]);
    setRevisionArticleId("");
    setRevisions([]);
    await loadReviewChapter(chapterId);
  }

  async function refreshIngestedKnowledge() {
    const updates = [];
    if (reviewChapterId) {
      setReviewArticles([]);
      setRevisionArticleId("");
      setRevisions([]);
      updates.push(loadReviewChapter(reviewChapterId));
    }
    if (onKnowledgeChanged) updates.push(onKnowledgeChanged());
    await Promise.all(updates);
  }

  // A retry is two writes, not one. `retry_knowledge_ingest_source` is the
  // audited, idempotent record of the operator's intent, but its body only
  // resets the source to `unset_embedding`, clears `last_error` and marks the
  // file unset; nothing is re-chunked or re-embedded by it. The HTTP ingest
  // route is what actually re-ingests, so the control runs the RPC and then
  // the route, in that order, or "Retry" would only mean "forget the failure".
  async function retrySource(sourceId) {
    const outcome = await run(async () => {
      // The pre-flight read is also the decision: a source the database
      // already calls healthy is left alone rather than knocked back to unset
      // and re-embedded for nothing. `healthy` is the only settled-good value
      // in the column's domain (healthy, partial, failed, unset_embedding).
      const current = await getKnowledgeIngestSource(client, sourceId);
      if (current?.health === "healthy") return { skipped: true, source: current };
      const retried = await retryKnowledgeIngestSource(client, sourceId);
      try {
        await retryKnowledgeSource(client, sourceId);
      } catch (cause) {
        // The reset is already durable even though the re-ingest failed, so
        // the health list has to be reloaded before the refusal is announced;
        // otherwise the row keeps showing the state the RPC just replaced.
        await refresh();
        await refreshIngestedKnowledge();
        throw cause;
      }
      await refreshIngestedKnowledge();
      return { skipped: false, source: retried };
    }, { success: false });
    if (!outcome) return null;
    setNotice(outcome.skipped ? t("knowledge.retrySkipped") : t("knowledge.success"));
    return outcome.source;
  }

  // A decision settles exactly one loaded row and changes nothing else in the
  // workspace snapshot, so it drops that row from the loaded list instead of
  // reloading. A full reload would reset the reader to page one of the
  // needs-review section, which is the position a reviewer three pages deep has
  // just spent the whole session building.
  function settleLoadedConversion(conversionId) {
    setConversions((rows) => rows.filter((row) => row.id !== conversionId));
  }

  async function approveConversion(conversion) {
    const result = await run(
      () => reviewKnowledgeConversion(client, conversion.organizationId, conversion.id),
      { reload: false, success: false },
    );
    if (result) {
      settleLoadedConversion(conversion.id);
      setNotice(t("knowledge.conversionApproved"));
    }
    return result;
  }

  async function loadMoreConversions() {
    if (!client || !organizationId || !conversionNext) return;
    const page = await run(
      () => listKnowledgeConversions(client, organizationId, conversionNext),
      { reload: false, success: false },
    );
    if (!page) return;
    // Merge by id. A row loaded while it was awaiting review can be settled by
    // another reviewer before this reader crosses into the settled section, and
    // appending blindly would then render it twice under a duplicate React key.
    setConversions((rows) => {
      const seen = new Set(rows.map((row) => row.id));
      return [...rows, ...page.conversions.filter((row) => !seen.has(row.id))];
    });
    setConversionNext(nextConversionRequest(page));
  }

  async function rejectConversion(conversion, reason) {
    const result = await run(
      () => rejectKnowledgeConversion(client, conversion.organizationId, conversion.id, reason),
      { reload: false, success: false },
    );
    if (result) {
      settleLoadedConversion(conversion.id);
      setNotice(t("knowledge.conversionDenied"));
    }
    return result || false;
  }

  async function loadRevisions() {
    if (!reviewChapterId || !revisionArticleId) return;
    const result = await run(() => listKnowledgeRevisions(client, revisionArticleId, reviewChapterId), { reload: false, success: false });
    if (result) setRevisions(result);
  }

  async function restore(revision, publish) {
    const retirement = revision.importCandidate && revision.status === "retired";
    const confirmation = retirement
      ? (publish ? t("knowledge.retireArticleConfirm") : t("knowledge.keepArticleConfirm"))
      : t("knowledge.restoreConfirm");
    if (!window.confirm(confirmation)) return;
    const result = await run(async () => {
      const restored = await restoreKnowledgeRevision(
        client, revisionArticleId, revision.id, publish, reviewChapterId,
      );
      // The adjacent editor reads its canonical article from App data, not
      // this workspace snapshot. Refresh that owner before another edit can
      // be based on the pre-restore body, status, or version.
      if (onKnowledgeChanged) await onKnowledgeChanged();
      return restored;
    });
    if (result) await loadRevisions();
  }

  function driveTarget(key = driveTargetKey) {
    const [kind, ...rest] = String(key || "").split(":");
    const id = rest.join(":");
    if (!driveFiling.enabled || !id) return null;
    const list = kind === "case" ? driveFiling.cases : kind === "meeting" ? driveFiling.meetings : [];
    return list.some((item) => String(item.id) === id) ? { kind, id } : null;
  }

  async function refreshDrive(key = driveTargetKey) {
    const result = await run(() => listConnectedDriveFiles(client, driveTarget(key)), { reload: false, success: false });
    if (result) setDriveFiles(result);
  }

  async function chooseDriveFolder(event) {
    const key = event.target.value;
    setDriveTargetKey(key);
    setDriveFiles([]);
    await refreshDrive(key);
  }

  async function uploadDrive(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = form.elements.file.files?.[0];
    if (!file) return;
    const result = await run(() => uploadConnectedDriveFile(client, file, driveTarget()), { reload: false });
    if (result) { form.reset(); await refreshDrive(); }
  }

  return <section className="knowledge-workspace" aria-labelledby="knowledge-workspace-title">
    <header className="knowledge-workspace__title">
      <div><h2 id="knowledge-workspace-title">{t("knowledge.title")}</h2><p>{t("knowledge.sub")}</p></div>
      {working && <span role="status">{t("knowledge.working")}</span>}
    </header>
    {notice && <p className="knowledge-workspace__notice" role="status">{notice}</p>}
    {error && <p className="knowledge-workspace__error" role="alert">{error}</p>}

    <div className="knowledge-workspace__grid">
      <Card title={t("knowledge.collections")} sub={t("knowledge.collectionsSub")} icon={FolderPlus}>
        {snapshot.collections.length ? <div className="knowledge-workspace__list">{snapshot.collections.map((collection) => {
          const canManage = canStaff && (collection.chapterId || canHealth);
          return <section className="knowledge-workspace__collection" key={collection.id}>
          <div className="knowledge-workspace__row"><strong>{collection.title}</strong><div className="knowledge-workspace__actions"><Status value={collection.visibility} />{canManage && <BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={working} onClick={() => window.confirm(t("knowledge.deleteCollectionConfirm")) && run(() => deleteKnowledgeCollection(client, collection.id, collectionChapterId))}>{t("knowledge.deleteCollection")}</BusyButton>}</div></div>
          {collection.description && <p>{collection.description}</p>}
          {collection.items?.length ? <ul>{collection.items.map((item) => <li key={item.id}><span>{item.title}</span><small>{item.kind.replaceAll("_", " ")} · {item.status}</small>{canManage && <BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={working} onClick={() => run(() => setKnowledgeCollectionItem(client, { collectionId: collection.id, itemKind: item.kind, itemId: item.itemId, include: false, chapterId: collectionChapterId }))}>{t("knowledge.remove")}</BusyButton>}</li>)}</ul> : <Empty>{t("knowledge.empty")}</Empty>}
        </section>;
        })}</div> : <Empty>{t("knowledge.empty")}</Empty>}
        {canStaff && <div className="knowledge-workspace__forms">
          <form onSubmit={createCollection}>
            <h4>{t("knowledge.newCollection")}</h4>
            <label>{t("knowledge.collectionTitle")}<input name="title" maxLength="120" required /></label>
            <label>{t("knowledge.description")}<textarea name="description" maxLength="1000" /></label>
            <div className="knowledge-workspace__fields"><label>{t("knowledge.scope")}<select name="scope"><option value="chapter">{t("knowledge.chapter")}</option>{canHealth && <option value="organization">{t("knowledge.organization")}</option>}</select></label><label>{t("knowledge.visibility")}<select name="visibility"><option value="organization">{t("knowledge.members")}</option><option value="staff">{t("knowledge.staff")}</option></select></label></div>
            <BusyButton className="hub2-btn hub2-btn--primary" pending={working}>{t("knowledge.saveCollection")}</BusyButton>
          </form>
          <form onSubmit={addPlacement}>
            <h4>{t("knowledge.placement")}</h4>
            {snapshot.collections.some((collection) => collection.chapterId || canHealth) ? <><label>{t("knowledge.pickCollection")}<select name="collectionId" required><option value="">{t("knowledge.pickCollection")}</option>{snapshot.collections.filter((collection) => collection.chapterId || canHealth).map((collection) => <option value={collection.id} key={collection.id}>{collection.title}</option>)}</select></label><label>{t("knowledge.pickItem")}<select name="item" required><option value="">{t("knowledge.pickItem")}</option>{placementOptions.map((item) => <option value={`${item.kind}:${item.id}`} key={`${item.kind}:${item.id}`}>{item.label}</option>)}</select></label><BusyButton className="hub2-btn hub2-btn--primary" pending={working}>{t("knowledge.add")}</BusyButton></> : <p>{t("knowledge.noCollections")}</p>}
          </form>
        </div>}
      </Card>

      <Card title={t("knowledge.catalog")} sub={t("knowledge.catalogSub")} icon={Download}>
        {snapshot.catalog.length ? <ul className="knowledge-workspace__resource-list">{snapshot.catalog.map((file) => <li key={file.id}><div><strong>{file.title}</strong><small>{file.category} · {file.fileName}</small><p>{file.summary}</p></div><BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={working} aria-label={`${t("knowledge.download")}: ${file.fileName}`} onClick={() => openStoredFile(file.id, "catalog")}><Download size={15} />{t("knowledge.download")}</BusyButton>{staleFileId === file.id && <BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={working} aria-label={`${working ? t("knowledge.rechecking") : t("knowledge.recheck")}: ${file.fileName}`} onClick={() => recheckStoredFile(file.id)}>{working ? t("knowledge.rechecking") : t("knowledge.recheck")}</BusyButton>}</li>)}</ul> : <Empty>{t("knowledge.empty")}</Empty>}
      </Card>

      {canStaff && <Card title={t("knowledge.steward")} sub={t("knowledge.stewardSub")} icon={FileUp}>
        <form className="knowledge-workspace__upload" onSubmit={uploadLibrary}>
          <label>{t("knowledge.file")}<input name="file" type="file" required /></label>
          <label>{t("knowledge.titleField")}<input name="title" maxLength="200" /></label>
          <label>{t("knowledge.summary")}<textarea name="summary" maxLength="1000" /></label>
          <label>{t("knowledge.category")}<select name="category" value={uploadCategory} onChange={(event) => setUploadCategory(event.target.value)}>{CATEGORIES.map((category) => <option key={category} value={category}>{category.replaceAll("_", " ")}</option>)}</select></label>
          <BusyButton className="hub2-btn hub2-btn--primary" pending={working}><FileUp size={15} />{t("knowledge.upload")}</BusyButton>
          {uploadPhase === "checking" && <p className="case-files__checking" role="status" aria-live="polite">{t("knowledge.checking")}</p>}
        </form>
        {snapshot.files.length ? <ul className="knowledge-workspace__resource-list">{snapshot.files.map((file) => <li key={file.id}><div><strong>{file.title}</strong><small>{file.fileName} · {file.reviewStatus} · {file.indexStatus}</small></div><div className="knowledge-workspace__actions"><BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={working} aria-label={`${t("knowledge.download")}: ${file.fileName}`} onClick={() => openStoredFile(file.id, "steward")}>{t("knowledge.download")}</BusyButton>{staleFileId === file.id && <BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={working} aria-label={`${working ? t("knowledge.rechecking") : t("knowledge.recheck")}: ${file.fileName}`} onClick={() => recheckStoredFile(file.id)}>{working ? t("knowledge.rechecking") : t("knowledge.recheck")}</BusyButton>}{file.reviewStatus !== "approved" && <BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={working} aria-label={`${t("knowledge.approve")}: ${file.fileName}`} onClick={() => approveLibraryFile(file.id)}>{t("knowledge.approve")}</BusyButton>}<BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={working} aria-label={`${t("knowledge.reject")}: ${file.fileName}`} onClick={() => run(() => reviewStewardLibraryFile(client, file.id, "rejected"))}>{t("knowledge.reject")}</BusyButton><BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={working} aria-label={`${t("knowledge.quarantine")}: ${file.fileName}`} onClick={() => run(() => reviewStewardLibraryFile(client, file.id, "quarantined"))}>{t("knowledge.quarantine")}</BusyButton>{file.reviewStatus === "approved" && !file.publishedToCatalog && <BusyButton type="button" className="hub2-btn hub2-btn--primary" pending={working} aria-label={`${t("knowledge.publish")}: ${file.fileName}`} onClick={() => publishLibraryFile(file)}>{t("knowledge.publish")}</BusyButton>}</div></li>)}</ul> : <Empty>{t("knowledge.empty")}</Empty>}
      </Card>}

      {canStaff && (
        <KnowledgeConversionReviewCard
          conversions={conversions}
          working={working}
          reviewColumnsAvailable={reviewColumnsAvailable}
          hasMore={Boolean(conversionNext)}
          onApprove={approveConversion}
          onReject={rejectConversion}
          onLoadMore={loadMoreConversions}
        />
      )}

      {canHealth && <Card title={t("knowledge.health")} sub={t("knowledge.healthSub")} icon={ShieldCheck}>
        <div className="knowledge-workspace__row"><strong>{t("knowledge.embedding")}</strong><Status value={snapshot.embedding.status} /></div>
        {snapshot.sourceHealth && <SourceHealthCheck health={snapshot.sourceHealth} t={t} lang={lang} />}
        {snapshot.sources.length ? (
          <ul className="knowledge-workspace__resource-list">
            {snapshot.sources.map((source) => (
              <li key={source.id}>
                <div>
                  <strong>{source.label}</strong>
                  <small>{source.chunkCount} {t("knowledge.chunks")} · {source.embeddedCount} {t("knowledge.embedded")}</small>
                  <small>{t("knowledge.sourceHealth", { status: String(source.health || "unset").replaceAll("_", " ") })}</small>
                  {source.lastIngestAt ? (
                    <small>{t("knowledge.lastIngest", { when: formatGroupMoment(source.lastIngestAt, lang) })}</small>
                  ) : null}
                  {source.lastError && <p className="knowledge-workspace__error">{source.lastError}</p>}
                </div>
                <div className="knowledge-workspace__actions">
                  <Status value={source.health} />
                  <BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={working} onClick={() => retrySource(source.id)}>
                    <RefreshCw size={15} />{t("knowledge.retrySource")}
                  </BusyButton>
                  <BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={working} onClick={() => window.confirm(t("knowledge.clearConfirm")) && run(() => clearKnowledgeSource(client, source.id))}>{t("knowledge.clear")}</BusyButton>
                </div>
              </li>
            ))}
          </ul>
        ) : <Empty>{t("knowledge.empty")}</Empty>}
      </Card>}

      {canStaff && <Card title={t("knowledge.revisions")} sub={t("knowledge.revisionsSub")} icon={History}>
        <div className="knowledge-workspace__revision-picker"><label>{t("knowledge.reviewChapter")}<BusySelect value={reviewChapterId} pending={busy} onChange={selectReviewChapter}><option value="">{t("knowledge.chooseContractChapter")}</option>{(snapshot.chapters || []).map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.name}</option>)}</BusySelect></label><label>{t("knowledge.article")}<select value={revisionArticleId} disabled={!reviewChapterId || reviewLoading} onChange={(event) => { setRevisionArticleId(event.target.value); setRevisions([]); }}><option value="">{t("knowledge.chooseArticle")}</option>{reviewArticles.map((article) => <option value={article.id} key={article.id}>{article.title} · v{article.version} · {article.status}</option>)}</select></label><BusyButton type="button" className="hub2-btn hub2-btn--primary" pending={working} disabled={!reviewChapterId || !revisionArticleId} onClick={loadRevisions}>{t("knowledge.loadHistory")}</BusyButton></div>
        {revisions.length ? <ol className="knowledge-workspace__revisions">{revisions.map((revision) => {
          const retirement = revision.importCandidate && revision.status === "retired";
          return <li key={revision.id}><div><strong>{retirement ? t("knowledge.importedRetirement") : revision.importCandidate ? t("knowledge.importedUpdate") : `v${revision.version}`} · {revision.title}</strong><small>{revision.status} · {formatGroupMoment(revision.changedAt, lang)}</small><details className="knowledge-workspace__revision-content"><summary>{t("knowledge.reviewContent")}</summary><strong>{revision.articleRef}</strong><p>{revision.body}</p>{revision.keywords?.length > 0 && <small>{t("knowledge.keywords")}: {revision.keywords.join(", ")}</small>}</details></div><div className="knowledge-workspace__actions">{retirement ? <><BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={working} onClick={() => restore(revision, false)}>{t("knowledge.keepArticle")}</BusyButton><BusyButton type="button" className="hub2-btn hub2-btn--danger" pending={working} onClick={() => restore(revision, true)}>{t("knowledge.retireArticle")}</BusyButton></> : <><BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={working} onClick={() => restore(revision, false)}><RotateCcw size={15} />{t("knowledge.restoreDraft")}</BusyButton>{["draft", "published"].includes(revision.status) && <BusyButton type="button" className="hub2-btn hub2-btn--primary" pending={working} onClick={() => restore(revision, true)}>{t("knowledge.restorePublished")}</BusyButton>}</>}</div></li>;
        })}</ol> : <Empty>{t("knowledge.empty")}</Empty>}
      </Card>}

      {canStaff && <Card title={t("knowledge.drive")} sub={t("knowledge.driveSub")} icon={Cloud}>
        <div className="knowledge-workspace__row"><strong>{snapshot.drive.accountEmail || "Google Drive"}</strong><Status>{t(driveStatusKey(snapshot.drive.status))}</Status></div>
        {!snapshot.drive.connected ? <>{canAdmin ? <BusyButton type="button" className="hub2-btn hub2-btn--primary" pending={working} onClick={() => run(() => beginGoogleDriveConnection(client), { reload: false, success: false })}>{t("knowledge.connect")}</BusyButton> : <p>{t("knowledge.noAdmin")}</p>}</> : <>
          {(canDriveOperate || canAdmin) && <div className="knowledge-workspace__actions">{canDriveOperate && <BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={working} onClick={() => refreshDrive()}>{t("knowledge.refreshFiles")}</BusyButton>}{canAdmin && <BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={working} onClick={() => window.confirm(t("knowledge.disconnectConfirm")) && run(() => disconnectGoogleDrive(client))}>{t("knowledge.disconnect")}</BusyButton>}</div>}
          {/* authorize_google_drive_operation accepts list/upload/download only
              for an organization_role_grants hat. A chapter-only steward is
              staff here, so the card stays, but offering controls that can only
              answer 42501 is the dishonest half. Say so instead. */}
          {canDriveOperate ? <>
            {driveFiling.enabled && <label className="knowledge-workspace__drive-folder">{t("knowledge.driveFolder")}
              <BusySelect value={driveTargetKey} pending={working} onChange={chooseDriveFolder}>
                <option value="">{t("knowledge.driveFolderResources")}</option>
                {driveFiling.cases.length > 0 && <optgroup label={t("knowledge.driveFolderCases")}>{driveFiling.cases.map((item) => <option key={`case:${item.id}`} value={`case:${item.id}`}>{item.folderName}</option>)}</optgroup>}
                {driveFiling.meetings.length > 0 && <optgroup label={t("knowledge.driveFolderMeetings")}>{driveFiling.meetings.map((item) => <option key={`meeting:${item.id}`} value={`meeting:${item.id}`}>{item.folderName}</option>)}</optgroup>}
              </BusySelect>
              <small>{t("knowledge.driveFolderHint")}</small>
            </label>}
            <form className="knowledge-workspace__drive-upload" onSubmit={uploadDrive}><label>{t("knowledge.file")}<input type="file" name="file" required /></label><BusyButton className="hub2-btn hub2-btn--primary" pending={working}>{t("knowledge.driveUpload")}</BusyButton><small>{t("knowledge.driveLimit")}</small></form>
            {driveFiles.length ? <ul className="knowledge-workspace__resource-list">{driveFiles.map((file) => <li key={file.id}><div><strong>{file.name}</strong><small>{file.mimeType} · {file.size || 0} bytes</small></div><BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={working} aria-label={`${t("knowledge.download")}: ${file.name}`} onClick={() => run(() => downloadConnectedDriveFile(client, file, driveTarget()), { reload: false, success: false })}>{t("knowledge.download")}</BusyButton></li>)}</ul> : <Empty>{t("knowledge.empty")}</Empty>}
          </> : <p>{t("knowledge.noDriveOperate")}</p>}
        </>}
      </Card>}
    </div>
  </section>;
}
