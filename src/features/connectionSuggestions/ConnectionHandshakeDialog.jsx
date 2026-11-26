import { useRef, useState } from "react";
import { Dialog } from "../../components/Dialog.jsx";
import { BusyButton, BusyInput, BusySelect, BusyTextarea } from "../../components/BusyControls.jsx";
import { unionNetworkCopy } from "../unionCatalog/unionNetworkCopy.js";
import { connectionHandshakeOutcome } from "./contract.js";

export function ConnectionHandshakeDialog({ target, chapterId, adapter, preview, lang, onClose, onSaved }) {
  const tr = unionNetworkCopy(lang);
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState("");
  const [scope, setScope] = useState("no_member_data");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(null);
  const inFlight = useRef(false);
  async function submit(event) {
    event.preventDefault();
    if (inFlight.current || !title.trim() || !purpose.trim()) return;
    const fields = { title: title.trim(), purpose: purpose.trim(), dataScope: scope };
    const signature = JSON.stringify([chapterId, target.id, fields]);
    if (pending.current?.signature !== signature) pending.current = { signature, key: crypto.randomUUID() };
    inFlight.current = true; setBusy(true); setFailed(false);
    try {
      const receipt = preview ? null : await adapter.requestHandshake(chapterId, target.id, fields, pending.current.key);
      const outcome = connectionHandshakeOutcome(receipt);
      onSaved(preview ? "requestPreview" : outcome === "declined" ? "requestDeclined" : outcome === "closed" ? "requestClosed" : "requestSent");
    } catch { setFailed(true); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <Dialog title={tr("requestTitle")} beforeClose={() => !inFlight.current} closeBlocked={busy} closeOperationKey={target.id} onClose={onClose}>
    <form className="xus-form" onSubmit={submit}>
      <p><strong>{tr("to")}:</strong> {target.displayName}</p>
      <p>{tr("requestHelp")}</p>
      <label className="xus-field">{tr("title")}<BusyInput className="xus-input" required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} pending={busy} /></label>
      <label className="xus-field">{tr("purpose")}<BusyTextarea className="xus-input" required maxLength={4000} value={purpose} onChange={(event) => setPurpose(event.target.value)} pending={busy} /></label>
      <label className="xus-field">{tr("scope")}<BusySelect className="xus-input" value={scope} onChange={(event) => setScope(event.target.value)} pending={busy}>
        {["no_member_data", "docs_only", "aggregate_only"].map((key) => <option key={key} value={key}>{tr(key)}</option>)}
      </BusySelect></label>
      {failed && <p role="alert" className="xus-note xus-note--error">{tr("requestError")}</p>}
      <div className="xus-btnrow"><BusyButton type="submit" className="xus-btn xus-btn--go" pending={busy} disabled={!title.trim() || !purpose.trim()}>{tr(busy ? "sending" : "send")}</BusyButton>
        <BusyButton type="button" className="xus-btn" pending={busy} onClick={onClose}>{tr("cancel")}</BusyButton></div>
    </form>
  </Dialog>;
}
