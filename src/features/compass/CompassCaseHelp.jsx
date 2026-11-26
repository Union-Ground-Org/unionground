// REQ-UG-COMPASS-PAGE-AND-CASE-AWARE-HELP-20261001
//
// "Ask Compass about this case" on the member's own case (old
// de7df4b57c^ components/claude/contextual-ai-card.tsx on app/m/cases/[id]).
// Three fixed questions; the server re-reads the case through the person's own
// authorization and answers from status, step and deadlines (plus screened
// notes only when the organization opted in). The answer stays on this card
// and is never saved to Compass history.
import { useId, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { CASE_HELP_KEYS } from "./pageHelp.js";
import { CompassSourceList } from "./CompassSourceList.jsx";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";

export function CompassCaseHelp({ caseId, ask, includesNarrative = false, onAddNote = null }) {
  const { t } = useLang();
  const titleId = useId();
  const [state, setState] = useState({ status: "idle", questionKey: null, answer: "", sources: [], error: "" });
  const generation = useRef(0);
  const busy = state.status === "busy";
  // REQ-UG-COMPASS-ACTION-OFFERS-20261001: offer to keep the answer as a
  // case note, written only after an explicit confirmation through the
  // member's existing case-note path.
  const [noteStep, setNoteStep] = useState("idle");
  // Record 8435: a synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());

  async function choose(questionKey) {
    if (busy) return;
    const current = ++generation.current;
    setState({ status: "busy", questionKey, answer: "", sources: [], error: "" });
    setNoteStep("idle");
    try {
      const reply = await ask(caseId, questionKey);
      if (current !== generation.current) return;
      setState({ status: "answered", questionKey, answer: reply.answer, sources: reply.sources || [], error: "" });
    } catch (error) {
      if (current !== generation.current) return;
      const code = error?.code;
      const key = code === "feature_disabled" ? "compass.caseHelp.off"
        : code === "case_unavailable" ? "compass.caseHelp.unavailable"
          : code === "compass_paused" ? "compass.pausedNotice"
            : "compass.caseHelp.failed";
      setState({ status: "failed", questionKey, answer: "", sources: [], error: t(key) });
    }
  }

  function addNote() {
    return runBusyWrite(busyWriteRef, `note:${caseId}`, () => addNoteNow());
  }

  async function addNoteNow() {
    if (noteStep === "saving" || state.status !== "answered") return;
    setNoteStep("saving");
    try {
      await onAddNote(caseId, state.answer);
      setNoteStep("saved");
    } catch {
      setNoteStep("failed");
    }
  }

  return (
    <section className="compass-case-help" aria-labelledby={titleId}>
      <h3 id={titleId}>{t("compass.caseHelp.title")}</h3>
      <p className="compass-case-help__notice">{t(includesNarrative ? "compass.caseHelp.noticeNarrative" : "compass.caseHelp.notice")}</p>
      <div className="compass-chips compass-case-help__questions" role="group" aria-label={t("compass.caseHelp.questionsLabel")}>
        {CASE_HELP_KEYS.map((key) => (
          <BusyButton type="button" key={key} pending={busy} aria-pressed={state.questionKey === key && state.status !== "idle"} onClick={() => choose(key)}>
            {t(`compass.caseHelp.q.${key}`)}
          </BusyButton>
        ))}
      </div>
      {busy && <p className="guide2-typing" role="status">{t("compass.thinking")}</p>}
      {state.status === "answered" && (
        <article className="compass-case-help__answer" aria-live="polite">
          <p>{state.answer}</p>
          <CompassSourceList sources={state.sources} />
          <small>{t("compass.caseHelp.notSaved")}</small>
          {onAddNote && noteStep === "idle" && <button type="button" className="outline-pill" onClick={() => setNoteStep("confirm")}>{t("compass.actions.addCaseNote")}</button>}
          {onAddNote && (noteStep === "confirm" || noteStep === "saving") && (
            <div className="compass-answer-actions__panel" role="group" aria-label={t("compass.actions.addCaseNote")}>
              <p>{t("compass.actions.caseNoteHelp")}</p>
              <div className="compass-answer-actions__buttons">
                <BusyButton type="button" className="dialog-primary" pending={noteStep === "saving"} onClick={addNote}>{t("compass.actions.caseNoteConfirm")}</BusyButton>
                <BusyButton type="button" className="dialog-secondary" pending={noteStep === "saving"} onClick={() => setNoteStep("idle")}>{t("compass.actions.cancel")}</BusyButton>
              </div>
            </div>
          )}
          {noteStep === "saved" && <p role="status">{t("compass.actions.caseNoteSaved")}</p>}
          {noteStep === "failed" && <p role="alert">{t("compass.actions.failed")}</p>}
        </article>
      )}
      {state.status === "failed" && <p className="assistant__error" role="alert">{state.error}</p>}
    </section>
  );
}
