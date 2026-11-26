import { useEffect, useRef, useState } from "react";
import { BusyButton } from "./BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { FormAutofillOffer, useFormAutofill } from "./FormAutofillOffer.jsx";
import {
  ORG_FORM_FRAME_PATH,
  ORG_FORM_FRAME_SANDBOX,
  buildOrganizationFormFrameDocument,
  downloadOrganizationFormHtml,
  shareOrganizationFormHtml,
} from "../lib/organizationHtmlForms.js";
import "../lib/i18n/features/organizationHtmlFormsStrings.js";

// REQ-UG-ORG-RESOURCE-HTML-FORMS-20261030: one organization HTML form,
// filled inside the opaque-origin frame (/org-form-frame.html). The form's own
// phone and desktop views, signature pads, print layout and PDF builder run
// unchanged in there; this toolbar adds Save HTML, Email HTML and Print. The
// filled form never leaves the member's device except as a file they save or
// share themselves.
//
// REQ-UG-FORMS-OFFER-WORKPLACE-AUTOFILL-20261030: once the form is
// ready the frame lists its empty text fields; the toolbar asks whether to
// fill the matching ones from the member's profile, and only a yes (or the
// member's "always" answer in Settings) sends those values in. The frame marks
// each filled field, and the mark travels in the saved file.

const SNAPSHOT_TIMEOUT_MS = 15_000;
// #9890: a frame that has not reported the form ready by then is said to have
// failed to load, with Try again, instead of "Loading the form…" forever.
const FORM_LOAD_TIMEOUT_MS = 15_000;

function kitCopy(t) {
  const keys = ["region", "save", "email", "print", "saved", "shared", "shareCancelled", "shareFailed", "drafted", "draftBody", "restoreFailed", "pdfInApp", "profileFilled"];
  return Object.fromEntries(keys.map((key) => [key, t(`orgForms.kit.${key}`)]));
}

let snapshotSequence = 0;

export function OrganizationFormViewer({ html, title, saved = false, onClose, autofillApi = null, share = shareOrganizationFormHtml, download = downloadOrganizationFormHtml }) {
  const { t } = useLang();
  const frameRef = useRef(null);
  const pendingRef = useRef(new Map());
  // Built once per opened document: a language change must not reload the
  // frame and lose what the member has typed.
  const [frameDocument] = useState(() => buildOrganizationFormFrameDocument(html, { copy: kitCopy(t) }));
  const [ready, setReady] = useState(false);
  // Each Try again mounts a fresh frame (the key) and starts a new timer.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadTimedOut, setLoadTimedOut] = useState(false);
  const [busy, setBusy] = useState("");
  // Synchronous write lock (#8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [status, setStatus] = useState("");
  // The frame's empty text fields ({ key, label, autocomplete }); null until listed.
  const [frameFields, setFrameFields] = useState(null);
  const [filledCount, setFilledCount] = useState(0);
  const autofill = useFormAutofill(autofillApi, frameFields || [], {}, { enabled: Boolean(frameFields?.length) });
  const autofillApiRef = useRef(autofillApi);
  autofillApiRef.current = autofillApi;

  useEffect(() => {
    const pending = pendingRef.current;
    function onMessage(event) {
      const frameWindow = frameRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      const data = event.data || {};
      if (data.type === "ug-org-form:frame-ready") {
        frameWindow.postMessage({ type: "ug-org-form:load", html: frameDocument }, "*");
      } else if (data.type === "ug-org-form:ready") {
        setReady(true);
        setLoadTimedOut(false);
        if (autofillApiRef.current?.load) frameWindow.postMessage({ type: "ug-org-form:fields" }, "*");
      } else if (data.type === "ug-org-form:fields-result") {
        setFrameFields((Array.isArray(data.fields) ? data.fields : [])
          .filter((field) => field && typeof field.ref === "string" && !field.filled)
          .map((field) => ({ key: field.ref, name: String(field.name || ""), label: String(field.label || ""), autocomplete: String(field.autocomplete || "") })));
      } else if (data.type === "ug-org-form:autofill-result") {
        setFilledCount(Array.isArray(data.filled) ? data.filled.length : 0);
      } else if (data.type === "ug-org-form:pdf-unavailable") {
        setStatus(t("orgForms.pdfInApp"));
      } else if (data.type === "ug-org-form:snapshot-result") {
        const entry = pending.get(data.requestId);
        if (!entry) return;
        pending.delete(data.requestId);
        clearTimeout(entry.timer);
        if (typeof data.html === "string") entry.resolve(data.html);
        else entry.reject(new Error(data.error || "snapshot_failed"));
      }
    }
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
    };
  }, [frameDocument, t]);

  useEffect(() => {
    if (ready) return undefined;
    const timer = setTimeout(() => setLoadTimedOut(true), FORM_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [ready, loadAttempt]);

  function retryLoad() {
    setLoadTimedOut(false);
    setLoadAttempt((value) => value + 1);
  }

  function requestSnapshot() {
    const frameWindow = frameRef.current?.contentWindow;
    if (!frameWindow) return Promise.reject(new Error("frame_unavailable"));
    snapshotSequence += 1;
    const requestId = `snapshot-${snapshotSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRef.current.delete(requestId);
        reject(new Error("snapshot_timeout"));
      }, SNAPSHOT_TIMEOUT_MS);
      pendingRef.current.set(requestId, { resolve, reject, timer });
      frameWindow.postMessage({ type: "ug-org-form:snapshot", requestId }, "*");
    });
  }

  function onSave() {
    return runBusyWrite(busyWriteRef, "viewer", () => onSaveNow());
  }

  async function onSaveNow() {
    setBusy("save");
    setStatus("");
    try {
      const snapshot = await requestSnapshot();
      const { name } = download(snapshot, title);
      setStatus(t("orgForms.savedStatus", { name }));
    } catch {
      setStatus(t("orgForms.snapshotFailed"));
    } finally {
      setBusy("");
    }
  }

  function onEmail() {
    return runBusyWrite(busyWriteRef, "viewer", () => onEmailNow());
  }

  async function onEmailNow() {
    setBusy("email");
    setStatus("");
    try {
      const snapshot = await requestSnapshot();
      const result = await share(snapshot, title, { draftBody: t("orgForms.kit.draftBody") });
      setStatus(t(`orgForms.share.${result.outcome}`, { name: result.name }));
    } catch {
      setStatus(t("orgForms.snapshotFailed"));
    } finally {
      setBusy("");
    }
  }

  function fillFromProfile() {
    autofill.answer(true);
    frameRef.current?.contentWindow?.postMessage({
      type: "ug-org-form:autofill",
      fills: autofill.proposal.map((item) => ({ ref: item.fieldKey, kind: item.kind, value: item.value })),
    }, "*");
  }

  useEffect(() => {
    // The member's Settings answer is "always fill".
    if (autofill.status === "always") fillFromProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autofill.status]);

  function onPrint() {
    frameRef.current?.contentWindow?.postMessage({ type: "ug-org-form:print" }, "*");
    setStatus(t("orgForms.printStatus"));
  }

  return (
    <div className="ohf-viewer">
      <div className="ohf-toolbar" role="toolbar" aria-label={t("orgForms.toolbar", { title })}>
        <BusyButton type="button" className="ftm-btn ftm-btn--primary ohf-btn" onClick={onSave} pending={Boolean(busy)} disabled={!ready}>{t(busy === "save" ? "orgForms.saving" : "orgForms.save")}</BusyButton>
        <BusyButton type="button" className="ftm-btn ohf-btn" onClick={onEmail} pending={Boolean(busy)} disabled={!ready}>{t(busy === "email" ? "orgForms.preparing" : "orgForms.email")}</BusyButton>
        <BusyButton type="button" className="ftm-btn ohf-btn" onClick={onPrint} pending={Boolean(busy)} disabled={!ready}>{t("orgForms.print")}</BusyButton>
        <button type="button" className="ftm-btn ftm-btn--quiet ohf-btn" onClick={onClose}>{t("orgForms.close")}</button>
      </div>
      <p className="ohf-help">{t(saved ? "orgForms.savedHelp" : "orgForms.viewerHelp")}</p>
      <p className="ohf-status" role="status" aria-live="polite">{ready ? status : loadTimedOut ? "" : t("orgForms.loadingForm")}</p>
      {!ready && loadTimedOut ? <p className="ohf-status" role="alert">{t("orgForms.loadTimedOut")} <button type="button" className="ftm-btn ohf-btn" onClick={retryLoad}>{t("orgForms.retryLoad")}</button></p> : null}
      <FormAutofillOffer offer={autofill} onAccept={fillFromProfile} onDecline={() => autofill.answer(false)} filledCount={filledCount} />
      {/* #9890: inert until the form reports ready, so a frame this page calls
          loading or failed takes no typing or focus that Try again would lose. */}
      <iframe
        key={loadAttempt}
        inert={!ready}
        ref={frameRef}
        className="ohf-frame"
        title={t("orgForms.frameTitle", { title })}
        src={ORG_FORM_FRAME_PATH}
        sandbox={ORG_FORM_FRAME_SANDBOX}
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
