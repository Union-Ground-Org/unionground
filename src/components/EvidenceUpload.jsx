import { useCallback, useEffect, useId, useRef, useState } from "react";
import { BusyButton, BusyInput } from "./BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { isHeicUpload, normalizeUploadFile } from "../lib/heicNormalization.js";
import { useLang } from "../lib/LanguageContext.jsx";
import {
  EVIDENCE_UPLOAD_ACCEPT,
  evidenceUploadText,
  readBoundedUploadText,
  renameUploadFile,
  sanitizeUploadStem,
  splitUploadName,
  uploadErrorIsPermanent,
  uploadErrorToken,
  uploadFinalName,
  uploadPreviewKind,
  validatePreparedUpload,
} from "../lib/evidenceUpload.js";
import "./EvidenceUpload.css";

// PICKING A FILE IS NOT UPLOADING IT.
//
// Every upload surface in this app used to send the bytes from the file input's
// own change handler: one click, no name, no preview, and a failure took the
// selection with it, so a rate-limited member re-picked the same file from the
// same folder to find out whether the answer had changed. This panel splits
// that into two decisions the member makes — choose, then upload — and keeps
// the choice across a failure that a retry can still fix.
//
// What it must never do: pretend to know an answer the server owns. The client
// allowlist and the 10 MiB ceiling are courtesies that save an inspection
// attempt, the visible guidance says in words that the server reads the bytes,
// and nothing here renders uninspected bytes in a frame that could execute
// them — a PDF gets a file card, not an <iframe>.

const BUSY_STAGES = new Set(["preparing", "converting", "uploading", "checking", "confirming"]);

// The phase tokens memberApi reports that are progress. Its failure tokens
// ("rejected", "pending-check", "rate-limited") arrive through the same
// callback and deliberately do not move the stage: the rejected promise decides
// what the member reads, and a phase racing ahead of it would show a failure
// sentence for an upload that is still being decided.
const PHASE_STAGES = new Set(["uploading", "checking", "confirming"]);

function notify(callback, value) {
  // A host's state update must never be able to break an upload of ours that
  // is already in flight (memberApi's notifyPhase holds the same line).
  try { callback?.(value); } catch { /* the host's UI, not our transaction */ }
}

/**
 * Stage, name and preview one file, then upload it on an explicit press.
 *
 * @param {object} props
 * @param {(file: File, options: {onPhase: (phase: string) => void}) => Promise<unknown>} props.onUpload
 *   Receives the prepared, validated, renamed file. Must reject on failure:
 *   a resolved promise is read as "attached".
 * @param {boolean} [props.disabled] Host lock. It gates STARTING work only; an
 *   upload already running is never invalidated by it, because the host is
 *   expected to set it from `onBusyChange`.
 * @param {string} [props.label] Accessible label for the file picker.
 * @param {(busy: boolean) => void} [props.onBusyChange] Fires on every busy
 *   transition, and once with false if the panel unmounts while busy.
 * @param {string|number} [props.scopeKey] Identity of the entity being attached
 *   to. A change discards the staged file and makes every in-flight result land
 *   on the floor.
 */
export function EvidenceUpload({ onUpload, disabled = false, label, onBusyChange, scopeKey }) {
  const { lang } = useLang();
  const text = useCallback((key, vars) => evidenceUploadText(lang, key, vars), [lang]);

  const headingId = useId();
  const guidanceId = useId();
  const fileId = useId();
  const nameId = useId();
  const nameHelpId = useId();

  const [storedSelection, setSelection] = useState(null);
  // Scope binding is synchronous: a new record must never render the previous
  // record's private preview while waiting for the cleanup effect.
  const selection = storedSelection?.scopeKey === scopeKey ? storedSelection : null;
  const [stem, setStem] = useState("");
  const [stage, setStage] = useState("idle");
  const [errorToken, setErrorToken] = useState(null);

  const inputRef = useRef(null);
  const previewUrlRef = useRef(null);
  // Bumped whenever the staged file stops being the one this panel is about:
  // a replacement pick, a cancel, a scope change, a completed upload, unmount.
  // Every async step compares the generation it started under before it touches
  // state, which is what keeps a slow conversion or a slow upload from
  // resurfacing under the next case.
  const generation = useRef(0);

  const busy = BUSY_STAGES.has(stage);
  // Synchronous write lock (record 8435): a second Upload is refused before
  // React commits the uploading stage.
  const busyWriteRef = useRef(new Set());
  const permanent = uploadErrorIsPermanent(errorToken);

  const busyCallback = useRef(onBusyChange);
  // Declared before the reporting effect so the two always run in this order on
  // the same commit: a host that passes a fresh arrow every render still gets
  // the current one called.
  useEffect(() => { busyCallback.current = onBusyChange; }, [onBusyChange]);
  const reportedBusy = useRef(false);
  useEffect(() => {
    if (reportedBusy.current === busy) return;
    reportedBusy.current = busy;
    notify(busyCallback.current, busy);
  }, [busy]);
  useEffect(() => () => {
    // A host that locked its own controls for us must not stay locked because
    // the panel was unmounted mid-upload.
    if (!reportedBusy.current) return;
    reportedBusy.current = false;
    notify(busyCallback.current, false);
  }, []);

  const revokePreview = useCallback(() => {
    if (!previewUrlRef.current) return;
    URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
  }, []);

  // Drop the staged file and everything still running for it. Returns the
  // generation a caller may claim for the work it is about to start.
  const discard = useCallback(() => {
    generation.current += 1;
    revokePreview();
    setSelection(null);
    setStem("");
    return generation.current;
  }, [revokePreview]);

  useEffect(() => {
    // The host pointed this panel at a different entity. Whatever was staged
    // belonged to the previous one.
    discard();
    setStage("idle");
    setErrorToken(null);
    if (inputRef.current) inputRef.current.value = "";
  }, [scopeKey, discard]);

  useEffect(() => () => {
    generation.current += 1;
    revokePreview();
  }, [revokePreview]);

  const previewUrlFor = useCallback((file) => {
    try {
      const url = URL.createObjectURL(file);
      previewUrlRef.current = url;
      return url;
    } catch {
      // No object URL (quota, or a browser that refused): the file card is the
      // honest fallback, and the upload itself is unaffected.
      return null;
    }
  }, []);

  const pick = useCallback(async (event) => {
    const chosen = event.currentTarget.files?.[0];
    // Cleared immediately so choosing the SAME file again after a cancel or a
    // refusal still fires a change event.
    event.currentTarget.value = "";
    if (!chosen) return;
    const request = discard();
    setErrorToken(null);
    // normalizeUploadFile recognises HEIC by MIME, by extension, or by its
    // container brand. The first two are known here, so the converting stage is
    // announced before the work starts; the third — HEIC bytes under a .jpg
    // name — is only known inside the helper, which is why the phase callback
    // is passed as well.
    setStage(isHeicUpload(chosen) ? "converting" : "preparing");

    let prepared;
    try {
      prepared = await normalizeUploadFile(chosen, {
        onPhase: (phase) => {
          if (generation.current === request && phase === "converting") setStage("converting");
        },
      });
    } catch (error) {
      if (generation.current !== request) return;
      setStage("idle");
      setErrorToken(uploadErrorToken(error));
      return;
    }
    if (generation.current !== request) return;

    // Validation runs on the CONVERTED file: an iPhone photo is judged as the
    // JPEG that will actually be uploaded, by the size it will actually have.
    const refusal = validatePreparedUpload(prepared);
    if (refusal) {
      setStage("idle");
      setErrorToken(refusal);
      return;
    }

    let kind = uploadPreviewKind(prepared);
    let preview = { url: null, text: "", truncated: false };
    if (kind === "text") {
      const read = await readBoundedUploadText(prepared);
      if (generation.current !== request) return;
      preview = { url: null, text: read.text, truncated: read.truncated };
    } else if (kind === "image") {
      // Created after the last await, so there is no window in which a scope
      // change could leave an unrevoked URL behind.
      preview = { url: previewUrlFor(prepared), text: "", truncated: false };
      // No object URL means no image to show; the file card is honest about
      // that rather than rendering a broken one.
      if (!preview.url) kind = "document";
    }

    setSelection({ scopeKey, file: prepared, kind, preview });
    setStem(sanitizeUploadStem(splitUploadName(prepared.name).stem));
    setStage("staged");
  }, [discard, previewUrlFor, scopeKey]);

  const cancel = useCallback(() => {
    discard();
    setStage("idle");
    setErrorToken(null);
  }, [discard]);

  // The lock is held per entity (record 8435): a re-scoped panel can upload to
  // the new entity at once, while the entity whose upload is still running
  // refuses a second one, also after the panel leaves it and comes back.
  const upload = useCallback(() => runBusyWrite(busyWriteRef, `upload:${scopeKey ?? ""}`, async () => {
    if (!selection || busy || permanent) return;
    // NOT a new generation: the staged file stays valid, and this upload claims
    // the generation it was staged under. A `disabled` flip from the host's own
    // onBusyChange therefore cannot reach it.
    const request = generation.current;
    const file = selection.attemptFile ?? renameUploadFile(selection.file, stem);
    setErrorToken(null);
    setStage("uploading");
    try {
      await onUpload(file, {
        ...(selection.retryUpload ? { retryUpload: selection.retryUpload } : {}),
        onPhase: (phase) => {
          if (generation.current !== request) return;
          if (PHASE_STAGES.has(phase)) setStage(phase);
          // The API may finish before the host refreshes the attachment list.
          // Keep the selection locked until the entire upload action settles.
          if (phase === "done") setStage("confirming");
        },
      });
    } catch (error) {
      if (generation.current !== request) return;
      // The selection and the edited name are kept: a retryable failure is
      // retried from here, and a permanent one still shows which file was
      // refused until a different file is chosen.
      setStage("staged");
      setErrorToken(uploadErrorToken(error));
      if (typeof error?.retryUpload === "function") {
        setSelection((current) => current === selection
          ? { ...current, attemptFile: file, retryUpload: error.retryUpload }
          : current);
      }
      return;
    }
    if (generation.current !== request) return;
    discard();
    setStage("done");
  }), [selection, stem, busy, permanent, onUpload, discard, scopeKey]);

  const stageText = stage === "idle" ? "" : text(`evidenceUpload.stage.${stage}`);
  const finalName = selection ? uploadFinalName(selection.file, stem) : "";
  const extension = selection ? splitUploadName(selection.file.name).extension : "";

  return <section className="evidence-upload" aria-labelledby={headingId} aria-busy={busy} data-stage={stage}>
    <h3 className="evidence-upload__title" id={headingId}>{text("evidenceUpload.title")}</h3>
    <ul className="evidence-upload__guidance" id={guidanceId}>
      <li>{text("evidenceUpload.formats")}</li>
      <li>{text("evidenceUpload.size")}</li>
      <li>{text("evidenceUpload.conversion")}</li>
      <li>{text("evidenceUpload.inspection")}</li>
    </ul>
    <div className="evidence-upload__pick">
      <label className="evidence-upload__pick-label" htmlFor={fileId}>
        {label || (selection ? text("evidenceUpload.replace") : text("evidenceUpload.choose"))}
      </label>
      <input
        className="evidence-upload__input"
        id={fileId}
        ref={inputRef}
        type="file"
        accept={EVIDENCE_UPLOAD_ACCEPT}
        aria-describedby={guidanceId}
        disabled={disabled || busy}
        onChange={pick}
      />
    </div>
    {/* Mounted at all times: a live region added to the DOM alongside its first
        message is not announced by every screen reader. */}
    <p className="evidence-upload__stage" role="status" aria-live="polite">{stageText}</p>
    {errorToken && <div className="evidence-upload__error" role="alert">
      <p>{text(`evidenceUpload.error.${selection?.retryUpload && !permanent && errorToken !== "rateLimited" ? "reconcile" : errorToken}`)}</p>
      {permanent && <p>{text("evidenceUpload.permanent")}</p>}
    </div>}
    {selection && <div className="evidence-upload__staged">
      <div className="evidence-upload__name">
        <label htmlFor={nameId}>{text("evidenceUpload.nameLabel")}</label>
        <div className="evidence-upload__name-row">
          <BusyInput
            id={nameId}
            type="text"
            value={stem}
            pending={busy}
            disabled={disabled || Boolean(selection.retryUpload)}
            aria-describedby={nameHelpId}
            onChange={(event) => setStem(event.currentTarget.value)}
            onBlur={() => setStem((current) => sanitizeUploadStem(current))}
          />
          <span className="evidence-upload__extension" aria-hidden="true">{extension}</span>
        </div>
        <p className="evidence-upload__name-help" id={nameHelpId}>
          {text("evidenceUpload.nameHelp", { extension })}
        </p>
        <p className="evidence-upload__final">
          <span>{text("evidenceUpload.finalName")}</span>
          {" "}
          <strong>{finalName}</strong>
          {" "}
          <small>{text("evidenceUpload.size.kb", { kilobytes: Math.ceil(selection.file.size / 1024) })}</small>
        </p>
      </div>
      <div className="evidence-upload__preview">
        {selection.kind === "image" && <img
          className="evidence-upload__image"
          src={selection.preview.url}
          alt={text("evidenceUpload.preview.image", { name: finalName })}
          onError={() => {
            if (previewUrlRef.current !== selection.preview.url) return;
            revokePreview();
            setSelection((current) => current === selection ? { ...current, kind: "document" } : current);
          }}
        />}
        {selection.kind === "text" && <>
          <p className="evidence-upload__preview-label">{text("evidenceUpload.preview.text", { name: finalName })}</p>
          {selection.preview.text
            ? <pre className="evidence-upload__text">{selection.preview.text}</pre>
            : <p className="evidence-upload__preview-note">{text("evidenceUpload.preview.empty")}</p>}
          {selection.preview.truncated && <p className="evidence-upload__preview-note">{text("evidenceUpload.preview.truncated")}</p>}
        </>}
        {selection.kind === "document" && <p className="evidence-upload__preview-note">
          {text("evidenceUpload.preview.document")}
        </p>}
      </div>
      <div className="evidence-upload__actions">
        {!permanent && <BusyButton
          type="button"
          className="dialog-primary evidence-upload__upload"
          pending={busy} disabled={disabled}
          onClick={() => void upload()}
        >{selection.retryUpload ? text("evidenceUpload.reconcile") : errorToken ? text("evidenceUpload.retry") : text("evidenceUpload.upload")}</BusyButton>}
        <BusyButton
          type="button"
          className="dialog-secondary evidence-upload__cancel"
          pending={busy} disabled={disabled}
          onClick={cancel}
        >{text("evidenceUpload.cancel")}</BusyButton>
      </div>
    </div>}
  </section>;
}
