import { useRef, useState } from "react";
import { BusyButton } from "../../../components/BusyControls.jsx";
import { useLang } from "../../../lib/LanguageContext.jsx";

export function CoordinationForm({
  className, busy, submitLabel, busyLabel, disabled, disabledReason, onSubmit, onSaved, children,
}) {
  const { t } = useLang();
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const revision = useRef(0);
  const submittingRef = useRef(false);

  function change() {
    revision.current += 1;
    setFeedback(null);
  }

  async function submit(event) {
    event.preventDefault();
    if (busy || disabled || submittingRef.current) return;
    const submitted = ++revision.current;
    submittingRef.current = true;
    setSubmitting(true);
    setFeedback(null);
    let published = false;
    const publish = (outcome) => {
      published = true;
      setSubmitting(false);
      if (revision.current !== submitted) return;
      setFeedback(outcome);
      if (outcome.ok) onSaved?.();
    };
    try {
      const saved = await onSubmit(publish);
      if (!published && saved === true && revision.current === submitted) onSaved?.();
    } catch {
      if (!published) publish({ key: "coordination.noticeSaveFailed", ok: false });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <form className={className} onChange={change} onSubmit={submit}>
      {children}
      <BusyButton className="coord-button" type="submit" pending={busy || submitting} disabled={disabled} disabledReason={disabledReason}>
        {submitting && busyLabel ? busyLabel : submitLabel}
      </BusyButton>
      <div className="coord-form-feedback" role="status" aria-atomic="true">
        {feedback && <p className={feedback.ok ? "coord-form-feedback__saved" : "coord-form-feedback__error"}>{t(feedback.key)}</p>}
      </div>
    </form>
  );
}
