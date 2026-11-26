import { useEffect, useRef } from "react";
import { deletionCompletionCopy } from "../lib/accountDeletionCompletion.js";

export default function AccountDeletionCompletion({ outcome, lang = "en", cleanup, onContinue, onRetry, sample = false }) {
  const heading = useRef(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const copy = deletionCompletionCopy[lang] || deletionCompletionCopy.en;
  return <section className="data-error" aria-labelledby="account-deletion-title">
    <h1 id="account-deletion-title" ref={heading} tabIndex={-1}>{outcome.uncertain ? copy.uncertainTitle : copy.title}</h1>
    <p role="status" aria-live="polite">{outcome.uncertain ? copy.uncertainBody : outcome.audited ? copy.body : copy.pending}</p>
    {cleanup === "pending" && <p role="status">{copy.cleanup}</p>}
    {cleanup === "failed" && <p role="alert">{copy.cleanupFailed}</p>}
    <div className="error-actions">
      {cleanup === "failed"
        ? <button className="dialog-primary" type="button" onClick={onRetry}>{copy.retry}</button>
        : <button className="dialog-primary" type="button" disabled={cleanup !== "done"} onClick={onContinue}>{sample ? copy.sample : copy.continue}</button>}
    </div>
  </section>;
}
