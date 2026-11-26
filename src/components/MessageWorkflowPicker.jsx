import { useRef } from "react";
import { MESSAGE_WORKFLOWS } from "../lib/messageWorkflow.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { messageWorkflowPickerCopyFor } from "../lib/messageWorkflowPickerCopy.js";

// The roles announce "radio button, N of 3", so the arrows have to work: a
// radiogroup is ONE tab stop whose arrow, Home and End keys move focus and the
// choice together. Without that, a member who hears the role and reaches for
// ArrowDown gets nothing and has to Tab through every card instead.
const ARROW_STEPS = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

export function MessageWorkflowPicker({ value, onChange, compact = false, legendId = null }) {
  const { t, lang } = useLang();
  const pickerCopy = messageWorkflowPickerCopyFor(lang);
  const optionRefs = useRef([]);
  const selectedIndex = MESSAGE_WORKFLOWS.findIndex((workflow) => workflow.key === value);
  // An unrecognised value must not leave the group unreachable by Tab.
  const tabStop = selectedIndex === -1 ? 0 : selectedIndex;

  function moveTo(index) {
    const wrapped = (index + MESSAGE_WORKFLOWS.length) % MESSAGE_WORKFLOWS.length;
    optionRefs.current[wrapped]?.focus();
    onChange(MESSAGE_WORKFLOWS[wrapped].key);
  }

  function onKeyDown(event, index) {
    const step = ARROW_STEPS[event.key];
    let target;
    if (step) target = index + step;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = MESSAGE_WORKFLOWS.length - 1;
    else return;
    event.preventDefault();
    moveTo(target);
  }

  return (
    <div className={`message-workflow-picker${compact ? " message-workflow-picker--compact" : ""}`} role="radiogroup" aria-labelledby={legendId || undefined} aria-label={legendId ? undefined : t("inbox.workflow.choiceLabel")}>
      {MESSAGE_WORKFLOWS.map((workflow, index) => {
        const selected = value === workflow.key;
        return (
          <button
            key={workflow.key}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={index === tabStop ? 0 : -1}
            ref={(node) => { optionRefs.current[index] = node; }}
            className="message-workflow-option"
            onClick={() => onChange(workflow.key)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            <span className="message-workflow-option__number" aria-hidden="true">{workflow.number}</span>
            <span className="message-workflow-option__copy">
              {workflow.recommended && <span className="message-workflow-option__recommended">{t("inbox.workflow.defaultBadge")}</span>}
              <strong>{t(workflow.labelKey)}</strong>
              <small>{t(workflow.summaryKey)}</small>
              {!compact && <span className="message-workflow-option__tradeoffs">
                <span><b>{t("inbox.workflow.proLabel")}</b> {pickerCopy.pro[workflow.key] ?? t(workflow.proKey)}</span>
                <span><b>{pickerCopy.conLabel}</b> {t(workflow.conKey)}</span>
              </span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
