import { EvidenceUpload } from "./EvidenceUpload.jsx";
import { useEffect, useId, useRef, useState } from "react";
import { BusyButton, BusyInput } from "./BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { EMPTY_SIGNATURE, SignatureChoice } from "./SignatureChoice.jsx";
import { signatureIsReady } from "../lib/typedSignature.js";

const EMPTY_MESSAGE = { tone: "", text: "" };

// BUG-UG-FAILURE-MESSAGE-NAMES-THE-WRONG-CAUSE-20261122 (W3b-8): a
// failed signature save used to tell a person who had just signed to sign.
// Only sign_member_form's own replies, matched whole after the "Form
// signature: " label, name a cause; anything else says only that the
// signature was not saved. It never asks the signer to sign again.
// "authentication required" is raised for no sign-in AND for a second step
// not completed, so its line asks to sign in again without saying a session
// ended; the expired-token codes take the same line.
const SIGN_IN_CODES = new Set(["PGRST301", "PGRST302", "PGRST303"]);
const SIGNATURE_REPLIES = new Map([
  ["authentication required", "signatureSignIn"],
  ["wait for attachment deletion to finish", "signatureWaitFiles"],
  ["wait for every attachment upload to finish", "signatureWaitFiles"],
  ["form not found or not signable", "signatureNotSignable"],
]);

function signatureFailureKey(error) {
  if (error?.details === "form_changed_since_review") return "changedSinceReview";
  if (SIGN_IN_CODES.has(String(error?.code ?? ""))) return "signatureSignIn";
  const message = String(error?.message ?? "");
  const label = message.lastIndexOf(": ");
  const reply = (label >= 0 ? message.slice(label + 2) : message).trim().toLowerCase();
  return SIGNATURE_REPLIES.get(reply) ?? "signatureNotSaved";
}

export function FormFilingControls({
  t, editable = false, approved = false, demo = false, files = [], filesUnavailable = false, holdNoteId = null,
  headingLevel = 3,
  signatureCurrent = false, signatureStale = false,
  onAddFile, onOpenFile, onRemoveFile, onRecheckFile = null, onSaveSignature,
  onDownload, canShare = () => false, onShare, onSignatureStateChange = () => {},
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const [rows, setRows] = useState(files);
  const [signature, setSignature] = useState(EMPTY_SIGNATURE);
  const [consent, setConsent] = useState(false);
  const [saved, setSaved] = useState(signatureCurrent);
  const [busy, setBusy] = useState("");
  // Synchronous write lock (#8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [message, setMessage] = useState(EMPTY_MESSAGE);
  const [pdf, setPdf] = useState(null);
  // `checking` is the state the old boolean busy could not express: the bytes
  // are in Storage but nothing is attached until the verdict arrives.
  const [phase, setPhase] = useState("");
  // The single row whose clean verdict aged out. One re-check is the whole fix,
  // so it gets a button rather than an unexplained failure.
  const [staleId, setStaleId] = useState("");
  // Rows this component has renewed since the parent last reloaded. A reviewer
  // clears several attachments in one sitting and must see each one settle.
  const [renewed, setRenewed] = useState(() => new Set());
  const titleId = useId();
  // The hold message's id, shared with the editor's Submit
  // when it passes one, so both held buttons name their reason.
  const holdId = holdNoteId || `${titleId}-files-hold`;

  useEffect(() => {
    setRows(files);
    // THE SERVER'S ANSWER OUTRANKS THIS COMPONENT'S MEMORY.
    //
    // `renewed` is only a local note that a re-check resolved clean. The
    // refreshed rows are the ledger's own verdict, and when they disagree —
    // the row still reports `scanCurrent === false` — the note is wrong and is
    // dropped, so the stale badge and the per-row re-check button come back.
    // Without this the reviewer can face an approval the parent still blocks
    // (StewardView reads the fresh status directly) with no control left to
    // clear it. Ids the refresh no longer carries fall out of the set too.
    setRenewed((current) => {
      if (current.size === 0) return current;
      const next = new Set();
      for (const row of files) {
        if (current.has(row?.id) && row?.scanCurrent !== false) next.add(row.id);
      }
      // `next` is always a subset of `current`, so equal sizes mean equal sets:
      // returning the same reference then avoids a pointless re-render.
      return next.size === current.size ? current : next;
    });
  }, [files]);
  useEffect(() => setSaved(signatureCurrent), [signatureCurrent]);

  function add(file, { onPhase, retryUpload } = {}) {
    return runBusyWrite(busyWriteRef, "filing", () => addNow(file, { onPhase, retryUpload }));
  }

  async function addNow(file, { onPhase, retryUpload } = {}) {
    setBusy("upload");
    setPhase("");
    setMessage(EMPTY_MESSAGE);
    // ONLY THE SERVER CAN INVALIDATE THE SIGNATURE, SO ONLY IT DECIDES WHEN.
    //
    // Registering the attachment is what clears the stored digest, and the
    // uploading phase is this client's proof that the registration call
    // returned. Clearing beforehand — as this did — threw away a still-valid
    // signature whenever the attempt died on its way to the server: a photo
    // this browser cannot convert, a form already locked, the twenty-file
    // ceiling, or a draft with no id yet. Each of those leaves the stored
    // digest intact, but the member was left staring at "save your signature
    // again" with Submit disabled, and nothing short of re-drawing it brought
    // the form back.
    let cleared = false;
    function clearSignature() {
      if (cleared) return;
      cleared = true;
      setSaved(false);
      onSignatureStateChange(false);
    }
    try {
      const row = await onAddFile(file, {
        ...(retryUpload ? { retryUpload } : {}),
        onPhase: (next) => {
          // Preparation/conversion happens before registration and cannot
          // invalidate the server-held signature.
          if (["uploading", "checking", "confirming", "done"].includes(next)) clearSignature();
          onPhase?.(next);
        },
      });
      // The demo session attaches without reporting a phase and drops its own
      // signature, so a success settles the state whether or not a phase came.
      clearSignature();
      if (row) setRows((current) => [...current.filter((item) => item.id !== row.id), row]);
      setMessage({ tone: "status", text: t("uploadSuccess") });
    } catch (error) {
      setMessage(EMPTY_MESSAGE);
      throw error;
    } finally {
      setPhase("");
      setBusy("");
    }
  }

  function remove(row) {
    return runBusyWrite(busyWriteRef, "filing", () => removeNow(row));
  }

  async function removeNow(row) {
    if (!onRemoveFile || busy) return;
    setBusy(`remove-${row.id}`);
    setMessage(EMPTY_MESSAGE);
    try {
      await onRemoveFile(row);
      setRows((current) => current.filter((item) => item.id !== row.id));
      setSaved(false);
      onSignatureStateChange(false);
    } catch {
      setMessage({ tone: "error", text: t("removeError") });
    } finally { setBusy(""); }
  }

  function open(row) {
    return runBusyWrite(busyWriteRef, "filing", () => openNow(row));
  }

  async function openNow(row) {
    if (!onOpenFile || busy) return;
    setBusy(`open-${row.id}`);
    setStaleId("");
    setMessage(EMPTY_MESSAGE);
    try {
      // The parent opens the tab synchronously on this call, before its first
      // await, so the transient user activation is still live on iOS.
      await onOpenFile(row);
    } catch (error) {
      // Storage refusing an otherwise-authorized read means the clean verdict
      // aged out or was superseded — recoverable by exactly one re-check.
      if (error?.privateFileCode === "stale" && onRecheckFile) {
        setStaleId(row.id);
        setMessage({ tone: "error", text: t("staleFile") });
      } else {
        setMessage({ tone: "error", text: t("openError") });
      }
    } finally { setBusy(""); }
  }

  // A row the filing status already reports as stale needs the re-check button
  // without an open having failed first. A submitted form is not editable by
  // its filer, so the reviewer is the only one who can renew the verdict the
  // approval gate demands, and asking them to try opening the file to discover
  // that is not an affordance.
  function knownStale(row) {
    return row?.scanCurrent === false && !renewed.has(row.id);
  }

  function offerRecheck(row) {
    return Boolean(onRecheckFile) && (staleId === row.id || knownStale(row));
  }

  function recheck(row) {
    return runBusyWrite(busyWriteRef, "filing", () => recheckNow(row));
  }

  async function recheckNow(row) {
    if (!onRecheckFile || busy) return;
    setBusy(`recheck-${row.id}`);
    setPhase("checking");
    setMessage({ tone: "status", text: t("checking") });
    try {
      await onRecheckFile(row);
      setStaleId("");
      setRenewed((current) => new Set(current).add(row.id));
      setMessage(EMPTY_MESSAGE);
    } catch (error) {
      if (error?.privateFileCode === "rejected") {
        setStaleId("");
        setMessage({ tone: "error", text: t("rejected") });
      } else {
        setMessage({ tone: "error", text: t("openError") });
      }
    } finally { setPhase(""); setBusy(""); }
  }

  function saveSignature() {
    return runBusyWrite(busyWriteRef, "filing", () => saveSignatureNow());
  }

  async function saveSignatureNow() {
    if (!onSaveSignature || !signatureIsReady(signature) || !consent || busy || filesUnavailable) return;
    setBusy("signature");
    setMessage({ tone: "status", text: t("savingSignature") });
    try {
      // The attachments on screen are part of what the member reviewed.
      await onSaveSignature(signature.kind === "typed" ? signature : signature.strokes, true, rows.map((row) => row.id));
      setSaved(true);
      onSignatureStateChange(true);
      setMessage(EMPTY_MESSAGE);
    } catch (error) {
      // Another session saved after review: nothing was signed, and the
      // editor now shows the stored answers for a fresh review.
      setMessage({ tone: "error", text: t(signatureFailureKey(error)) });
    } finally { setBusy(""); }
  }

  function download() {
    return runBusyWrite(busyWriteRef, "filing", () => downloadNow());
  }

  async function downloadNow() {
    if (!onDownload || busy) return;
    setBusy("download");
    setMessage({ tone: "status", text: t("downloading") });
    try {
      const file = await onDownload();
      setPdf(file || null);
      const shareable = Boolean(file && onShare && canShare(file));
      setMessage({ tone: "status", text: t(shareable ? "downloadReady" : "downloadOnly") });
    } catch {
      setMessage({ tone: "error", text: t("downloadError") });
    } finally { setBusy(""); }
  }

  function share() {
    return runBusyWrite(busyWriteRef, "filing", () => shareNow());
  }

  async function shareNow() {
    if (!pdf || !onShare || busy) return;
    setBusy("share");
    try {
      const result = await onShare(pdf);
      if (result?.status === "shared") setMessage({ tone: "status", text: t("shared") });
    } catch {
      setMessage({ tone: "error", text: t("downloadError") });
    } finally { setBusy(""); }
  }

  return (
    <section className="form-filing" aria-labelledby={titleId}>
      <header className="form-filing__head">
        <Heading id={titleId}>{t("title")}</Heading>
        {demo && <span className="form-filing__preview">{t("demo")}</span>}
      </header>

      <div className="form-filing__section">
        <strong>{t("attachments")}</strong>
        {/* Ledgers 217 (1) and 276: a failed read says so whenever it holds
            signing, also after an upload added a row to the list. */}
        {filesUnavailable && <p id={holdId} className="form-filing__warning" role="status">{t(editable ? "filesUnavailableHold" : "filesUnavailable")}</p>}
        {rows.length === 0 ? (filesUnavailable ? null : <p className="form-filing__hint">{t("noFiles")}</p>) : (
          <ul className="form-filing__files">
            {rows.map((row) => (
              <li key={row.id}>
                <span>
                  {row.filename}
                  {!row.confirmedAt && <small className="form-filing__pending">{t("pendingFile")}</small>}
                  {row.confirmedAt && knownStale(row) && <small className="form-filing__pending">{t("staleBadge")}</small>}
                </span>
                <span className="form-filing__file-actions">
                  {onOpenFile && <BusyButton type="button" className="form-filing__quiet" pending={busy !== ""} onClick={() => open(row)}>{t("openFile", { name: row.filename })}</BusyButton>}
                  {offerRecheck(row) && <BusyButton type="button" className="form-filing__quiet" pending={busy !== ""} aria-label={`${busy === `recheck-${row.id}` ? t("rechecking") : t("recheck")}: ${row.filename}`} onClick={() => recheck(row)}>{busy === `recheck-${row.id}` ? t("rechecking") : t("recheck")}</BusyButton>}
                  {editable && onRemoveFile && <BusyButton type="button" className="form-filing__quiet" pending={busy !== ""} onClick={() => remove(row)}>{t("removeFile", { name: row.filename })}</BusyButton>}
                </span>
              </li>
            ))}
          </ul>
        )}
        {phase === "checking" && <p className="case-files__checking" role="status" aria-live="polite">{t("checking")}</p>}
        {editable && onAddFile && (
          <EvidenceUpload label={t("addFile")} disabled={busy !== ""} onUpload={add} />
        )}
      </div>

      {editable && onSaveSignature && (
        <div className="form-filing__section">
          <SignatureChoice
            value={signature}
            onChange={(next) => {
              setSignature(next);
              setSaved(false);
              if (signatureCurrent || saved) onSignatureStateChange(false);
            }}
            pending={busy !== ""}
            labels={{
              legend: t("signatureWay"), draw: t("signatureWayDraw"), type: t("signatureWayType"),
              nameLabel: t("typedName"), nameHint: t("typedNameHint"),
              problems: { hidden: t("typedNameHidden"), length: t("typedNameLength"), letter: t("typedNameLetter") },
            }}
            padProps={{
              label: t("signature"),
              instructions: t("signatureInstructions"),
              clearLabel: t("clearSignature"),
              emptyStatus: t("emptySignature"),
              strokeStatus: (count) => t("strokeCount", { n: count }),
              capStatus: t("signatureCapReached"),
              statusRole: "note",
            }}
          />
          <label className="form-filing__consent">
            <BusyInput type="checkbox" checked={consent} pending={busy !== ""} onChange={(event) => setConsent(event.target.checked)} />
            <span>{t(signature.kind === "typed" ? "typedConsent" : "consent")}</span>
          </label>
          <BusyButton type="button" className="dialog-primary form-filing__action" pending={busy !== ""} disabled={!signatureIsReady(signature) || !consent || filesUnavailable} disabledReason={filesUnavailable ? null : t(signatureIsReady(signature) ? "signatureTickBox" : consent ? "signatureSignFirst" : "signatureSignAndTick")} aria-describedby={filesUnavailable ? holdId : undefined} onClick={saveSignature}>
            {busy === "signature" ? t("savingSignature") : t("saveSignature")}
          </BusyButton>
          {saved && <p className="form-filing__success" role="status" aria-live="polite">{t("signatureSaved")}</p>}
          {!saved && signatureStale && <p className="form-filing__warning">{t("signatureStale")}</p>}
        </div>
      )}

      {!editable && signatureCurrent && <p className="form-filing__success">{t("signedReady")}</p>}

      {approved && onDownload && (
        <div className="form-filing__delivery">
          <BusyButton type="button" className="dialog-primary form-filing__action" pending={busy !== ""} onClick={download}>
            {busy === "download" ? t("downloading") : t("download")}
          </BusyButton>
          {pdf && canShare(pdf) && onShare && (
            <BusyButton type="button" className="outline-pill form-filing__action" pending={busy !== ""} onClick={share}>{t("share")}</BusyButton>
          )}
        </div>
      )}

      {message.text && <p className={`form-filing__status form-filing__status--${message.tone}`} role={message.tone === "error" ? "alert" : "status"} aria-live="polite">{message.text}</p>}
    </section>
  );
}
