import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pencil, X } from "lucide-react";
import { useDetailSurfaceClose } from "../lib/useDetailSurface.js";
import { useModalIsolation } from "../lib/useModalIsolation.js";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { isConflictRefusalCode } from "../lib/memberApiError.js";
import { BusyButton, BusyInput } from "../components/BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";

// Workstream maintenance for the staff tool: rename is unremarkable and looks
// it; merge is irreversible and pays the full price of a real warning.
//
// Rules this panel follows, all learned elsewhere in the product:
// - A rename collision (23505) is surfaced as the merge OFFER, not an error —
//   it is the only moment someone has proven they want the merge.
// - The merge dialog is built from preview_chapter_workstream_merge, never
//   from a client-side count, and passes the preview's movingTasks back as
//   optimistic concurrency (40001 -> "review the merge again").
// - The finished count is called out separately: it is the number that
//   rewrites reporting history, and one combined total would bury it.
// - Direction is named in BOTH buttons, the safe path is first and is a
//   decision ("Keep them separate"), and "cannot be undone" is said once.

// The companion-phone instance mirrors this panel's state through device
// parity, so the effect below also runs inside the embedded IFRAME. Calling
// focus() there pulls top-level keyboard focus out of the desktop dialog the
// user actually opened — the same reason TaskModal never autofocuses in the
// embed. Read at focus time, not at import, so a mirrored surface is judged
// by its own location.
//
// The flag only counts inside a real frame, the rule embedPhoneFromUrl() in
// src/App.jsx states: an ?embed=phone URL opened top-level — the iframe in a
// new tab, a shared link — boots as the ordinary shell, and that shell's
// dialog is the one the user opened, so it must still take focus.
function isEmbeddedCompanion() {
  if (typeof window === "undefined") return false;
  try {
    return /[?&]embed=phone(?:&|$)/.test(window.location.search) && window.parent !== window;
  } catch {
    return false;
  }
}

export function WorkstreamSettings({ t, workstreams, tasks, onClose, onRename, onPreviewMerge, onMerge }) {
  const backdropRef = useRef(null);
  const headingRef = useRef(null);
  const lastRestoreRef = useRef(null);
  const renameTriggerRefs = useRef(new Map());
  const removeTriggerRefs = useRef(new Map());
  const [editingId, setEditingId] = useDeviceParityState("tasks.workstreams.editingId", null);
  const [editName, setEditName] = useDeviceParityState("tasks.workstreams.editName", "");
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState("");
  const [offer, setOffer] = useDeviceParityState("tasks.workstreams.offer", null); // { source, target, preview }
  const [merge, setMerge] = useDeviceParityState("tasks.workstreams.merge", null); // { source, target, preview, stale }
  const [removing, setRemoving] = useDeviceParityState("tasks.workstreams.removing", null); // entity with 0 tasks
  const { mounted, phase, closing, onTransitionEnd, requestClose } = useDetailSurfaceClose(onClose, { blocked: busy });
  useModalIsolation(backdropRef, { active: mounted });
  const viewKey = merge ? "merge" : removing ? "removing" : editingId ? "rename" : "list";

  useEffect(() => {
    function closeOnEscape(event) {
      // A command palette opened above this sheet claims its Escape first.
      if (event.defaultPrevented) return;
      if (event.key === "Escape" && !busy && !closing) {
        event.preventDefault();
        requestClose();
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, closing, requestClose]);

  // List view has no autoFocus. Place focus on a stable perceivable target
  // when the panel opens and when a merge, removal, or rename subview
  // unmounts the control that held it. Leave merge/remove keep buttons and
  // the rename input to their existing autoFocus.
  useLayoutEffect(() => {
    if (viewKey !== "list" || closing) return;
    const restore = lastRestoreRef.current;
    lastRestoreRef.current = null;
    if (isEmbeddedCompanion()) return;
    const trigger = restore
      ? (restore.kind === "remove"
        ? removeTriggerRefs.current.get(restore.id)
        : renameTriggerRefs.current.get(restore.id))
      : null;
    const target = trigger?.isConnected ? trigger : headingRef.current;
    if (target && typeof target.focus === "function") target.focus();
  }, [viewKey, closing]);

  const countsByName = new Map();
  for (const task of tasks) {
    const entry = countsByName.get(task.workstream) || { total: 0, done: 0 };
    entry.total += 1;
    if (task.status === "done") entry.done += 1;
    countsByName.set(task.workstream, entry);
  }
  const lastOne = workstreams.length <= 1;

  function startEdit(entry) {
    lastRestoreRef.current = { id: entry.id, kind: "rename" };
    setError("");
    setOffer(null);
    setEditingId(entry.id);
    setEditName(entry.name);
  }

  function saveRename(entry) {
    return runBusyWrite(busyWriteRef, "workstream", () => saveRenameNow(entry));
  }

  async function saveRenameNow(entry) {
    const clean = editName.trim();
    if (!clean || clean === entry.name) { setEditingId(null); return; }
    setBusy(true);
    setError("");
    try {
      await onRename(entry.id, clean);
      setEditingId(null);
    } catch (cause) {
      if (cause?.code === "23505") {
        // The offer, not an error. Preview so the offer can state the count.
        const target = workstreams.find((item) => item.name === clean && item.id !== entry.id);
        if (target?.id && onPreviewMerge) {
          try {
            const preview = await onPreviewMerge(entry.id, target.id);
            setOffer({ source: entry, target, preview });
          } catch {
            // The rename is over; what failed is the merge we offered instead.
            setError(t("tasks.errorMerge"));
          }
        } else {
          setError(t("tasks.workstreamExists", { name: clean }));
        }
      } else {
        setError(t("tasks.errorRename"));
      }
    } finally {
      setBusy(false);
    }
  }

  function openMerge(source, target) {
    return runBusyWrite(busyWriteRef, "workstream", () => openMergeNow(source, target));
  }

  async function openMergeNow(source, target) {
    setBusy(true);
    setError("");
    try {
      const preview = await onPreviewMerge(source.id, target.id);
      lastRestoreRef.current = { id: source.id, kind: "rename" };
      setOffer(null);
      setMerge({ source, target, preview, stale: false });
      setEditingId(null);
    } catch {
      setError(t("tasks.errorMerge"));
    } finally {
      setBusy(false);
    }
  }

  function confirmMerge() {
    return runBusyWrite(busyWriteRef, "workstream", () => confirmMergeNow());
  }

  async function confirmMergeNow() {
    if (!merge) return;
    setBusy(true);
    setError("");
    setMerge({ ...merge, stale: false });
    try {
      await onMerge(merge.source.id, merge.target.id, merge.preview.movingTasks);
      // The source row is gone as soon as the parent reconciles, and may
      // linger until it does. Restoring to its trigger would hand focus to an
      // element about to be removed, so the heading takes it instead.
      lastRestoreRef.current = null;
      setMerge(null);
    } catch (cause) {
      if (isConflictRefusalCode(cause?.code)) {
        // Someone filed cards while the dialog was open: re-read, never widen.
        try {
          const preview = await onPreviewMerge(merge.source.id, merge.target.id);
          setMerge({ ...merge, preview, stale: true });
        } catch {
          setMerge(null);
          setError(t("tasks.mergeStale"));
        }
      } else {
        setError(t("tasks.errorMerge"));
      }
    } finally {
      setBusy(false);
    }
  }

  function confirmRemove() {
    return runBusyWrite(busyWriteRef, "workstream", () => confirmRemoveNow());
  }

  async function confirmRemoveNow() {
    // "Remove" for an empty workstream is the merge that moves nothing: the
    // server has no separate delete path, which keeps every removal previewed
    // and counted the same way.
    const target = workstreams.find((item) => item.id && item.id !== removing.id);
    if (!target) { setRemoving(null); return; }
    setBusy(true);
    setError("");
    try {
      await onMerge(removing.id, target.id, 0);
      lastRestoreRef.current = null;
      setRemoving(null);
    } catch {
      setRemoving(null);
      // The RPC is a merge, but the steward asked for a removal: say so.
      setError(t("tasks.errorRemove"));
    } finally {
      setBusy(false);
    }
  }

  if (!mounted) return null;

  return (
    <div
      ref={backdropRef}
      className="task-editor-backdrop sg-detail-layer"
      role="presentation"
      data-state={phase}
      aria-hidden={closing || undefined}
      inert={closing ? true : undefined}
      onTransitionEnd={onTransitionEnd}
      onMouseDown={(event) => event.target === event.currentTarget && !busy && !closing && requestClose()}
    >
      <section className="task-editor workstream-panel sg-detail-surface" role="dialog" aria-modal="true" aria-labelledby="workstream-panel-title">
        <header>
          <div>
            <span className="eyebrow">{t("tasks.eyebrow")}</span>
            <h2 id="workstream-panel-title" ref={headingRef} tabIndex={-1}>{t("tasks.workstreams")}</h2>
          </div>
          <BusyButton type="button" onClick={requestClose} pending={busy} aria-label={t("tasks.close")}><X size={20} /></BusyButton>
        </header>

        {error && <p className="tasks-error" role="alert">{error}</p>}
        {merge ? (
          <div className="workstream-merge">
            <h3>{t("tasks.mergeTitle", { source: merge.source.name, target: merge.target.name })}</h3>
            {merge.stale && <p className="workstream-offer" role="alert">{t("tasks.mergeStale")}</p>}
            <p>{t("tasks.mergeBody", { count: merge.preview.movingTasks, source: merge.source.name, target: merge.target.name })}</p>
            {merge.preview.movingDoneTasks > 0 && (
              <p>{t("tasks.mergeDone", { count: merge.preview.movingDoneTasks, source: merge.source.name, target: merge.target.name })}</p>
            )}
            <p>{t("tasks.mergeTarget", { target: merge.target.name, count: merge.preview.targetExistingTasks })}</p>
            <p><strong>{t("tasks.mergeNoUndo")}</strong></p>
            <footer>
              <BusyButton type="button" className="task-confirm__keep" autoFocus pending={busy} onClick={() => { setError(""); setMerge(null); }}>{t("tasks.mergeKeep")}</BusyButton>
              <BusyButton type="button" className="task-editor__delete" pending={busy} onClick={confirmMerge}>{t("tasks.mergeConfirm", { target: merge.target.name })}</BusyButton>
            </footer>
          </div>
        ) : removing ? (
          <div className="workstream-merge">
            <h3>{t("tasks.deleteTitle", { title: removing.name })}</h3>
            <p>{t("tasks.workstreamRemoveBody", { name: removing.name })}</p>
            <p><strong>{t("tasks.mergeNoUndo")}</strong></p>
            <footer>
              <BusyButton type="button" className="task-confirm__keep" autoFocus pending={busy} onClick={() => { setError(""); setRemoving(null); }}>{t("tasks.mergeKeep")}</BusyButton>
              <BusyButton type="button" className="task-editor__delete" pending={busy} onClick={confirmRemove}>{t("tasks.workstreamRemove")}</BusyButton>
            </footer>
          </div>
        ) : (
          <div className="workstream-list">
            {offer && (
              <div className="workstream-offer" role="alert">
                <p>
                  <strong>{t("tasks.workstreamExists", { name: offer.target.name })}</strong>{" "}
                  {t("tasks.workstreamOffer", { source: offer.source.name, target: offer.target.name, count: offer.preview.movingTasks })}
                </p>
                <BusyButton type="button" pending={busy} onClick={() => openMerge(offer.source, offer.target)}>{t("tasks.reviewMerge")}</BusyButton>
              </div>
            )}
            {workstreams.map((entry) => {
              const counts = countsByName.get(entry.name) || { total: 0, done: 0 };
              return (
                <div className="tasks-breakdown__row workstream-row" key={entry.id || entry.name}>
                  {editingId === entry.id && entry.id ? (
                    <span className="workstream-row__edit">
                      <BusyInput
                        value={editName}
                        onChange={(event) => setEditName(event.target.value)}
                        maxLength={60}
                        aria-label={t("tasks.workstreamName")}
                        autoFocus
                        pending={busy}
                      />
                      <BusyButton type="button" className="task-confirm__keep" pending={busy} onClick={() => { setEditingId(null); setError(""); }}>{t("tasks.cancel")}</BusyButton>
                      <BusyButton type="button" className="task-editor__save" pending={busy} disabled={!editName.trim()} onClick={() => saveRename(entry)}>{t("tasks.workstreamSave")}</BusyButton>
                    </span>
                  ) : (
                    <>
                      <span><strong>{entry.name}</strong><small>{t("tasks.workstreamCount", { count: counts.total })}</small></span>
                      <span className="workstream-row__actions">
                        {entry.id && onRename && (
                          <BusyButton
                            type="button"
                            ref={(node) => {
                              if (node) renameTriggerRefs.current.set(entry.id, node);
                              else renameTriggerRefs.current.delete(entry.id);
                            }}
                            pending={busy}
                            onClick={() => startEdit(entry)}
                            aria-label={t("tasks.workstreamRenameAction", { name: entry.name })}
                          >
                            <Pencil size={14} />
                          </BusyButton>
                        )}
                        {entry.id && onMerge && counts.total === 0 && !lastOne && (
                          <BusyButton
                            type="button"
                            ref={(node) => {
                              if (node) removeTriggerRefs.current.set(entry.id, node);
                              else removeTriggerRefs.current.delete(entry.id);
                            }}
                            pending={busy}
                            onClick={() => {
                              lastRestoreRef.current = { id: entry.id, kind: "remove" };
                              setError("");
                              setRemoving(entry);
                            }}
                            aria-label={t("tasks.workstreamRemoveAction", { name: entry.name })}
                          >{t("tasks.workstreamRemove")}</BusyButton>
                        )}
                      </span>
                    </>
                  )}
                </div>
              );
            })}
            {/* The one guard rename cannot express: the task trigger requires
                every card to name a workstream, so the last one stays. */}
            {lastOne && <p className="tasks-report__note">{t("tasks.mergeLast")}</p>}
          </div>
        )}
      </section>
    </div>
  );
}
