// The prototype's "Match my situation" (pages/help.js UG.actions.match) for
// the alternate shell's Help page (REQ-UG-ALT-PORT-MEMBER-PAGES-20261030):
// a short run of questions in the production Dialog (which the legacy adapter
// opens with the design's scrim and settle), ending on the member support
// programs that fit. Nothing is stored; picking a program opens it on the
// page through the view's own tab handler.
import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "../../components/Dialog.jsx";
import { RadioGroup } from "../../components/RadioGroup.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";
import { Icon } from "../icons.jsx";
import "../../lib/i18n/features/altHelpPagesStrings.js";

const MATCH_QUESTIONS = Object.freeze([
  { key: "what", options: ["meeting", "unsafe", "change", "hr", "new", "grow"] },
  { key: "when", options: ["now", "soon", "later"] },
]);

// Situation → the desk's programs, best fit first.
const MATCH_PROGRAMS = Object.freeze({
  meeting: ["rights", "hr"],
  unsafe: ["rights", "hr"],
  change: ["accommodations", "hr"],
  hr: ["hr", "accommodations"],
  new: ["onboarding", "mentorship"],
  grow: ["mentorship", "onboarding"],
});

export function matchPrograms(answers, programs) {
  const ids = MATCH_PROGRAMS[answers.what] ?? [];
  return ids.map((id) => programs.find((program) => program.id === id)).filter(Boolean);
}

export function HelpMatcher({ programs, onPick, onClose, onSay = null }) {
  const { t } = useLang();
  const [answers, setAnswers] = useState({});
  const [step, setStep] = useState(0);
  const body = useRef(null);
  const moved = useRef(false);
  const questionId = useId();
  const total = MATCH_QUESTIONS.length;

  // As the prototype's redraw: each new step puts focus on its chosen answer
  // or its first control. The first step leaves focus on the dialog heading.
  useEffect(() => {
    if (!moved.current) return;
    const target = body.current?.querySelector('[aria-checked="true"]') ?? body.current?.querySelector("button");
    target?.focus();
  }, [step]);

  const go = (next) => { moved.current = true; setStep(next); };

  let content;
  if (step < total) {
    const question = MATCH_QUESTIONS[step];
    content = (
      <>
        <p className="ug-alt-help-step">{t("altHelpPages.matchQuestion", { n: step + 1, total })}</p>
        <h3 id={questionId}>{t(`altHelpPages.matchQ_${question.key}`)}</h3>
        {/* The shared keyboard model: arrows move the choice, Next moves on. */}
        <RadioGroup className="ug-alt-help-opts" aria-labelledby={questionId}>
          {question.options.map((option) => (
            <button
              key={option}
              type="button"
              className="ug-opt"
              role="radio"
              aria-checked={answers[question.key] === option}
              onClick={() => setAnswers((current) => ({ ...current, [question.key]: option }))}
            >
              <span className="ug-alt-help-grow"><b>{t(`altHelpPages.matchA_${option}`)}</b></span>
              <span className="ug-box ug-round"><Icon name="check" /></span>
            </button>
          ))}
        </RadioGroup>
        <div className="ug-btn-row ug-alt-help-row">
          <button className="ug-btn ug-btn-dark" type="button" disabled={!answers[question.key]} onClick={() => go(step + 1)}>{t(step + 1 < total ? "altHelpPages.matchNext" : "altHelpPages.matchSee")}</button>
          {step ? <button className="ug-btn ug-btn-ghost" type="button" onClick={() => go(step - 1)}>{t("altHelpPages.matchBack")}</button> : null}
        </div>
      </>
    );
  } else {
    const list = matchPrograms(answers, programs);
    const meeting = answers.what === "meeting";
    content = (
      <>
        <h3>{t("altHelpPages.matchResult")}</h3>
        <p className="ug-lede">{t(answers.when === "now" ? "altHelpPages.matchUrgent" : "altHelpPages.matchCalm")}</p>
        <div className="ug-alt-help-opts">
          {list.map((program) => (
            <button key={program.id} type="button" className="ug-opt" onClick={() => onPick(program.id)}>
              <span className="ug-av ug-av-sm ug-alt-help-av" aria-hidden="true"><Icon name={program.icon} /></span>
              <span className="ug-alt-help-grow"><b>{program.name}</b><span>{program.summary}</span></span>
              <Icon name="right" />
            </button>
          ))}
        </div>
        <div className="ug-btn-row ug-alt-help-row">
          <button className="ug-btn ug-btn-soft" type="button" onClick={() => { setAnswers({}); go(0); }}>{t("altHelpPages.matchRestart")}</button>
          {meeting && onSay ? <button className="ug-btn ug-btn-dark" type="button" onClick={onSay}>{t("altHelpPages.matchSay")}</button> : null}
        </div>
      </>
    );
  }

  return (
    <Dialog title={t("altHelpPages.helpMatch")} onClose={onClose}>
      <div className="ug-alt-help-matcher" ref={body}>{content}</div>
    </Dialog>
  );
}
