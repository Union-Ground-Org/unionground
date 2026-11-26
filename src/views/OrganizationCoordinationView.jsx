import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { classifyCoordinationRefusal } from "../features/coordination/adapter.js";
import { coordinationIntentTouchesExtensions } from "../features/coordination/contract.js";
import { SHELL_LOAD_DEADLINE_MS, withLoadDeadline } from "../lib/loadDeadline.js";
import { OrganizationCoordinationDesk } from "../features/coordination/ui/OrganizationCoordinationDesk.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { rpcRefusalKey } from "../lib/rpcErrorText.js";
import { buildXlsxWorkbook, XLSX_MIME } from "../lib/xlsxWorkbook.js";
import {
  coordinationExtensionsScope,
  createWiredCoordinationAdapter,
  useCoordinationActor,
  useCoordinationDirectoryExtensions,
} from "../lib/mi1CoordinationWiring.js";

const DATASET_EXPORTS_SWITCH = "features.automation.scheduled_dataset_exports";

const RECORD_UNAVAILABLE = new Set([
  "active coalition campaign unavailable",
  "active organization network unavailable",
  "chapter unavailable",
  "coalition work item unavailable",
  "coordination conversation unavailable",
  "coordination parent unavailable",
  "coordination resource lane unavailable",
  "member unavailable",
  "mobilization campaign unavailable",
  "partner organization unavailable",
  "public chapter section unavailable",
  "public chapter page unavailable",
]);

function coordinationFormRefusal(error) {
  if (classifyCoordinationRefusal(error) === "mfa_required") return "coordination.noticeMfaRequired";
  if (error?.code === "22023" && RECORD_UNAVAILABLE.has(error.message)) {
    return "coordination.noticeRecordUnavailable";
  }
  if (error?.code === "23514" && ["coverage schedule window unavailable", "coverage override window unavailable"].includes(error.message)) {
    return "coordination.noticeCoverageWindow";
  }
  return rpcRefusalKey(error, "coordination.noticeSaveFailed");
}

// The XLSX workbook is built in the browser from the same rows the server
// returned as `table` (REQ-UG-SCHEDULED-EXPORTS-PARITY-20261001; old
// agency exports offered csv and xlsx).
function exportWorkbookRows(table) {
  const columns = Array.isArray(table?.columns) ? table.columns : [];
  const rows = Array.isArray(table?.rows) ? table.rows : [];
  return [columns, ...rows.map((row) => (Array.isArray(row) ? row : []))];
}

export function downloadCoordinationExport(payload, { xlsx = false } = {}) {
  if (!payload?.content || !payload?.filename || typeof document === "undefined"
    || typeof globalThis.URL?.createObjectURL !== "function"
    || (xlsx && !Array.isArray(payload?.table?.columns))) {
    throw new Error("export download unavailable");
  }
  const body = xlsx ? buildXlsxWorkbook([{ name: "Export", rows: exportWorkbookRows(payload.table) }]) : payload.content;
  const url = globalThis.URL.createObjectURL(new Blob([body], { type: xlsx ? XLSX_MIME : payload.mimeType || "text/plain" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = xlsx ? payload.filename.replace(/\.(csv|json)$/, ".xlsx") : payload.filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.URL.revokeObjectURL(url);
}

// How many same-scope refreshes in a row may fail while the last ready desk stays
// on screen marked stale. Past this the page takes the whole-page unavailable
// state, so a desk is never kept indefinitely on data no refresh can confirm.
export const COORDINATION_STALE_REFRESH_LIMIT = 3;

// The authority a painted desk was loaded under: the canonical actor without its
// sessionScope stamp. Resolving a pending scope to the SAME organization, user,
// hat, roles, chapter and MFA state is not an authorization change; any
// difference in those is, and it keeps failing closed.
function coordinationAuthorityKey(actor) {
  const { sessionScope: _sessionScope, ...authority } = actor || {};
  return JSON.stringify(authority);
}

// Outcomes a same-scope refresh may ride out on the kept desk: a thrown load
// (the shell deadline or a transport failure) or the adapter's generic "error".
// Every other non-ready answer (unauthorized, mfa_required, empty, unavailable)
// is the server's word about this session and replaces the desk.
function transientRefreshFailure(next) {
  return next?.state === "error";
}

export function OrganizationCoordinationView({ actor, client, api = null, loadDeadlineMs = SHELL_LOAD_DEADLINE_MS }) {
  const { t } = useLang();
  const { actor: scopedActor, retryScope } = useCoordinationActor(client, actor);
  const adapter = useMemo(() => api || createWiredCoordinationAdapter(client), [api, client]);
  const [model, setModel] = useState(null);
  const [status, setStatus] = useState("loading");
  const [busy, setBusy] = useState(false);
  const [paging, setPaging] = useState(false);
  const [pagingMessages, setPagingMessages] = useState(false);
  // The notice is held as a catalogue key and translated where it is painted, so
  // it reads in the reader's language and follows a language switch.
  const [notice, setNotice] = useState("");
  const [stale, setStale] = useState(false);
  // REQ-UG-SCHEDULED-EXPORTS-PARITY-20261001: whether the restored export
  // datasets are offered. A read failure keeps the registered default (off);
  // the server refuses them whenever the switch is off either way.
  const [datasetExportsEnabled, setDatasetExportsEnabled] = useState(false);
  useEffect(() => {
    if (typeof client?.rpc !== "function") return undefined;
    let active = true;
    Promise.resolve(client.rpc("get_member_organization_configuration", {}))
      .then((result) => {
        if (active && !result?.error) setDatasetExportsEnabled(result?.data?.switches?.[DATASET_EXPORTS_SWITCH] === true);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [client]);
  const request = useRef(0);
  // The authority key of the actor the painted desk was loaded under, and how
  // many same-scope refreshes in a row have failed on top of it.
  const deskedAuthority = useRef(null);
  const staleFailures = useRef(0);
  // The projection the desk currently has painted — `organization|user`, the same
  // key coordinationExtensionsScope() gives the directory projection — or null
  // when the desk is not on screen at all. Held in a ref because `load` must stay
  // a callback over [adapter, scopedActor, loadDeadlineMs] only: reading the
  // model from state would put it in those dependencies and re-issue the load on
  // every model change.
  const desked = useRef(null);
  // `busy` is "a desk-wide write is in flight", and it is now raised from two
  // places, so it is counted rather than assigned: run() below holds it across
  // its mutation, its reload and its projection refresh, and a suppressed reload
  // raises it on its own. Assigning would clear it when the inner load() settled
  // and re-enable every control while refreshExtensions() was still running.
  const writes = useRef(0);
  const markBusy = useCallback((delta) => {
    writes.current = Math.max(0, writes.current + delta);
    setBusy(writes.current > 0);
  }, []);
  // The mount below loads the read-only snapshot only. The partner directory,
  // invitations, badges, activity and mapping projection comes from a separate
  // adapter method the desk's explicit control calls once per visit, because the
  // RPC behind it records a 'directory_viewed' audit row.
  const { extensions, loadExtensions, refreshExtensions } = useCoordinationDirectoryExtensions(adapter, scopedActor);

  const load = useCallback(async () => {
    const id = ++request.current;
    const scope = coordinationExtensionsScope(scopedActor);
    // A reload for the projection ALREADY on screen is a refresh, and a refresh
    // keeps the desk. This callback is rebuilt and re-invoked every time
    // useCoordinationActor replaces the scoped actor — which it does at least
    // twice per mount, once when get_my_chapter_memberships answers — and
    // re-entering "loading" there took OrganizationCoordinationDesk's
    // `status === "loading"` early return and UNMOUNTED a desk the operator was
    // already reading: the focused control left the document mid-interaction and
    // the browser dropped focus on <body>.
    //
    // What may be kept is decided by the SCOPE, never by mere readiness.
    // mergeCoordinationScope overwrites the actor's organizationId with the row
    // the server names as selected, so the very same replacement can also be an
    // organization — or, at the same organization, a user — switch, and the desk
    // derives its tabs and its staff rights from the actor while rendering
    // whatever model is in state. Keeping the previous scope's records painted
    // there is one tenant's data under another tenant's authority, the leak
    // src/lib/mi1CoordinationWiring.js guards the directory projection against.
    // So a reload for a different scope blanks and takes the loading state
    // exactly as before; only the same-scope refresh is suppressed, and it says
    // so through the desk-wide busy flag, which is the one signal an operator
    // pressing Try again still has.
    const refresh = desked.current === scope;
    const authority = coordinationAuthorityKey(scopedActor);
    // A failed refresh may keep the painted desk (marked stale, with a retry)
    // only when it is the same projection under the same authority. A scope or
    // authorization change still blanks on failure, exactly as before.
    const keepOnFailure = () => refresh
      && deskedAuthority.current === authority
      && staleFailures.current < COORDINATION_STALE_REFRESH_LIMIT;
    if (refresh) markBusy(1);
    else {
      desked.current = null;
      deskedAuthority.current = null;
      staleFailures.current = 0;
      setStale(false);
      setModel(null);
      setStatus("loading");
    }
    const fail = (next) => {
      if (keepOnFailure()) {
        staleFailures.current += 1;
        setStale(true);
        return;
      }
      desked.current = null;
      deskedAuthority.current = null;
      staleFailures.current = 0;
      setStale(false);
      if (next) setModel(next);
      setStatus(next?.state || "error");
    };
    try {
      const next = await withLoadDeadline(adapter.load(scopedActor), loadDeadlineMs);
      if (id !== request.current) return;
      if (transientRefreshFailure(next)) {
        fail(next);
        return;
      }
      // The one status the desk renders its data view for, and it renders it only
      // with an organization on the model.
      const ready = next.state === "ready" && next.organizationId;
      desked.current = ready ? scope : null;
      deskedAuthority.current = ready ? authority : null;
      staleFailures.current = 0;
      setStale(false);
      setModel(next);
      setStatus(next.state);
    } catch {
      if (id !== request.current) return;
      fail(null);
    } finally {
      if (refresh) markBusy(-1);
    }
  }, [adapter, loadDeadlineMs, markBusy, scopedActor]);

  useEffect(() => {
    load();
    return () => { request.current += 1; };
  }, [load]);

  const runNow = useCallback(async (intent, label, operation, applyResult, publish) => {
    markBusy(1);
    setNotice("");
    let confirmed = false;
    try {
      const result = await operation();
      const key = typeof label === "function" ? label(result) : label;
      confirmed = true;
      if (publish) publish({ key, ok: true });
      else setNotice(key);
      await load();
      // The mount snapshot is not the whole desk: accepting an invitation, awarding
      // mission activity, saving a directory profile, setting a network permission,
      // assigning a participant or executing a mapping plan all change fields the
      // deferred projection owns, and that projection is latched for the visit — so
      // without this the desk kept showing the pre-mutation invitation, activity,
      // directory or job state and a second press on an already-accepted invitation
      // failed. Only those intents refresh: COORDINATION_MUTATION_EXTENSION_TOUCH
      // is the declaration, so a partner message or an export cannot inherit a
      // writing directory_viewed row. refreshExtensions() is still a no-op until
      // the operator has asked for the projection.
      if (coordinationIntentTouchesExtensions(intent)) await refreshExtensions();
      if (applyResult) applyResult(result);
      return true;
    } catch (error) {
      if (publish) {
        if (!confirmed) publish({ key: coordinationFormRefusal(error), ok: false });
        return confirmed;
      }
      setNotice(classifyCoordinationRefusal(error) === "mfa_required"
        ? "coordination.noticeMfaRequired"
        : "coordination.noticeSaveFailed");
      return false;
    } finally {
      markBusy(-1);
    }
  }, [load, markBusy, refreshExtensions]);
  // Synchronous desk-wide write lock (record 8435): the desk's controls stay
  // focusable while a write runs, so a second activation before React commits
  // busy is refused here; a refused call resolves undefined, read as not done.
  const busyWriteRef = useRef(new Set());
  const run = useCallback(
    (intent, label, operation, applyResult = null, publish = null) => runBusyWrite(busyWriteRef, "desk", () => runNow(intent, label, operation, applyResult, publish)),
    [runNow],
  );

  const loadMore = useCallback(async () => {
    if (!model?.nextRecordsCursor || paging) return;
    setPaging(true);
    setNotice("");
    try {
      const page = await adapter.loadMore(scopedActor, model.nextRecordsCursor);
      setModel((current) => {
        if (!current) return current;
        const byId = new Map(current.records.map((record) => [record.id, record]));
        for (const record of page.records) byId.set(record.id, record);
        return {
          ...current,
          records: [...byId.values()],
          nextRecordsCursor: page.nextRecordsCursor,
        };
      });
    } catch {
      setNotice("coordination.noticeOlderRecordsFailed");
    } finally {
      setPaging(false);
    }
  }, [adapter, model?.nextRecordsCursor, paging, scopedActor]);

  const loadMoreMessages = useCallback(async () => {
    if (!model?.nextMessagesCursor || pagingMessages) return;
    setPagingMessages(true);
    setNotice("");
    try {
      const page = await adapter.loadMoreMessages(scopedActor, model.nextMessagesCursor);
      setModel((current) => {
        if (!current) return current;
        const byId = new Map(current.messages.map((message) => [message.id, message]));
        for (const message of page.messages) byId.set(message.id, message);
        return {
          ...current,
          messages: [...byId.values()],
          nextMessagesCursor: page.nextMessagesCursor,
        };
      });
    } catch {
      setNotice("coordination.noticeOlderMessagesFailed");
    } finally {
      setPagingMessages(false);
    }
  }, [adapter, model?.nextMessagesCursor, pagingMessages, scopedActor]);

  return (
    <div className="screen" data-mi1-surface="organization-coordination">
      <OrganizationCoordinationDesk
        actor={scopedActor}
        model={model}
        datasetExportsEnabled={datasetExportsEnabled}
        extensions={extensions}
        onShowDirectoryExtensions={loadExtensions}
        onRetryScope={retryScope}
        status={status}
        busy={busy}
        paging={paging}
        pagingMessages={pagingMessages}
        notice={notice ? t(notice) : ""}
        stale={stale}
        onRetry={load}
        onLoadMore={loadMore}
        onLoadMoreMessages={loadMoreMessages}
        onCreate={(input, publish) => run("create", "coordination.noticeCreated", () => adapter.create(scopedActor, input), null, publish)}
        onJoin={(record) => run("join", "coordination.noticeJoined", () => adapter.join(scopedActor, record.id, record.kind === "committee" ? "committee_member" : "participant"))}
        onTransition={(record, transition, options) => run("transition",
          transition === "complete_objective"
            ? (result) => result?.alreadyCompleted ? "coordination.noticeObjectiveAlreadyCompleted" : "coordination.noticeObjectiveCompleted"
            : "coordination.noticeStatusUpdated",
          () => adapter.transition(scopedActor, record.id, transition, options),
          transition === "complete_objective"
            ? (result) => {
                if (!result?.transitioned && !result?.alreadyCompleted) return;
                setModel((current) => current ? {
                  ...current,
                  records: current.records.map((currentRecord) => currentRecord.id === record.id
                    ? { ...currentRecord, completedByCaller: true }
                    : currentRecord),
                } : current);
              }
            : null,
        )}
        onRespond={(record, accept) => run("respond", accept ? "coordination.noticeInvitationAccepted" : "coordination.noticeInvitationDeclined", () => adapter.respond(scopedActor, record.id, accept))}
        onMessage={(conversationId, body, publish) => run("message", "coordination.noticeMessageSent", () => adapter.message(scopedActor, conversationId, body), null, publish)}
        onRunExport={(record) => run("runExport", "coordination.noticeExportReady", () => adapter.runExport(scopedActor, record.id, record.config?.format))}
        onDownloadExport={(runId, format) => run("downloadExport", "coordination.noticeExportDownloaded", async () => {
          const payload = await adapter.loadExportPayload(scopedActor, runId);
          downloadCoordinationExport(payload, { xlsx: format === "xlsx" });
        })}
        onOutreach={(input, publish) => run("outreach", "coordination.noticeOutreachRecorded", () => adapter.outreach(scopedActor, input), null, publish)}
        onSaveProfile={(input) => run("saveProfile", "coordination.noticeProfileSaved", () => adapter.saveProfile(scopedActor, input))}
        onSetPermission={(input, publish) => run("setPermission", "coordination.noticePermissionSaved", () => adapter.setPermission(scopedActor, input), null, publish)}
        onResource={(input, publish) => run("resource", "coordination.noticeResourceSubmitted", () => adapter.resource(scopedActor, input), null, publish)}
        onRespondResource={(resourceId, accept) => run("respondResource", accept ? "coordination.noticeResourceAccepted" : "coordination.noticeResourceDeclined", () => adapter.respondResource(scopedActor, resourceId, accept))}
        onOpenSharedDocument={(resourceId) => adapter.loadSharedDocument(scopedActor, resourceId)}
        onInviteOrganization={(input, publish) => run("inviteOrganization", "coordination.noticeOrganizationInvited", () => adapter.inviteOrganization(scopedActor, input), null, publish)}
        onRespondParticipant={(recordId, accept) => run("respondParticipant", accept ? "coordination.noticeInvitationAccepted" : "coordination.noticeInvitationDeclined", () => adapter.respondParticipant(scopedActor, recordId, accept))}
        onAssignParticipant={(input, publish) => run("assignParticipant", "coordination.noticeMemberSelectionSaved", () => adapter.assignParticipant(scopedActor, input), null, publish)}
        onProposeCoalitionDecision={(input, publish) => run("proposeCoalitionDecision", "coordination.noticeCoalitionDecisionOpened", () => adapter.proposeCoalitionDecision(scopedActor, input), null, publish)}
        onVoteCoalitionDecision={(input) => run("voteCoalitionDecision", "coordination.noticeCoalitionVoteSaved", () => adapter.voteCoalitionDecision(scopedActor, input))}
        onReviewMergeMatch={(input, publish) => run("reviewMergeMatch", "coordination.noticeMatchReviewSaved", () => adapter.reviewMergeMatch(scopedActor, input), null, publish)}
        onExecuteMerge={(input) => run("executeMerge", "coordination.noticeMappingPlanExecuted", () => adapter.executeMerge(scopedActor, input))}
        onSaveChapterProfile={(input) => run("saveChapterProfile", "coordination.noticeChapterProfileSaved", () => adapter.saveChapterProfile(scopedActor, input))}
        onSaveMicrositeSection={(input, publish) => run("saveMicrositeSection", "coordination.noticeMicrositeSectionSaved", () => adapter.saveMicrositeSection(scopedActor, input), null, publish)}
        onSaveMicrositePage={(input, publish) => run("saveMicrositePage", "coordination.noticeMicrositePageSaved", () => adapter.saveMicrositePage(scopedActor, input), null, publish)}
        onAttachPublicPageDocument={(input, publish) => run("attachPublicPageDocument", "coordination.noticePublicDocumentAttached", () => adapter.attachPublicPageDocument(scopedActor, input), null, publish)}
        onTakeOverPublicPage={(input, publish) => run("takeOverPublicPage", "coordination.noticePublicPageOwnershipUpdated", () => adapter.takeOverPublicPage(scopedActor, input), null, publish)}
        onRecommendCoverage={(chapterId) => adapter.recommendCoverage(scopedActor, chapterId)}
      />
    </div>
  );
}
