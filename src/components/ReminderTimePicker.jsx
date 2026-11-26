import { useEffect, useId, useRef, useState } from "react";
import { BusyButton, BusyInput } from "./BusyControls.jsx";
import { MESSAGE_REMINDER_MAX_AHEAD_MS, MESSAGE_REMINDER_MIN_LEAD_MS, messageReminderProblem } from "../features/messaging/actions.js";
import { dateTimeFormat } from "../lib/i18n.js";
import { registerEscapeLayer } from "../lib/escapeLayers.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { localDateTimeInputValue } from "../lib/localDateTime.js";
import "./ReminderTimePicker.css";

const PROBLEM_KEYS = Object.freeze({
  empty: "inbox.remindPicker.errorEmpty",
  invalid: "inbox.remindPicker.errorInvalid",
  past: "inbox.remindPicker.errorPast",
  far: "inbox.remindPicker.errorFar",
});

// The summary spells the chosen instant out with its zone abbreviation, so a
// wall-clock time that a daylight-saving jump moved (02:30 on the spring-forward
// night resolves to 03:30) or one that names the wrong zone is visible before
// Confirm rather than after the reminder fires.
const SUMMARY_FORMAT = Object.freeze({
  weekday: "long", year: "numeric", month: "long", day: "numeric",
  hour: "numeric", minute: "2-digit", timeZoneName: "short",
});

function readChoice(value) {
  if (!value) return { problem: "empty", at: null };
  const at = new Date(value);
  const problem = messageReminderProblem(at.getTime());
  return problem ? { problem, at: null } : { problem: null, at };
}

// Picks the instant a reminder fires. It owns only the choice: nothing here
// writes, and onConfirm is the single path out with a value. The parent runs the
// request, reports `busy`, and closes the picker when the server confirms — a
// refusal leaves it open with the member's choice intact.
export function ReminderTimePicker({ busy = false, onConfirm, onCancel, title }) {
  const { t, lang } = useLang();
  const uid = useId();
  const inputRef = useRef(null);
  const [value, setValue] = useState("");
  const [attempted, setAttempted] = useState(false);
  // Set when Confirm found a date the browser holds but could not turn into a
  // value (a half-typed field reads as "" through `value`); cleared by any edit.
  const [unfinished, setUnfinished] = useState(false);
  // Fixed for the life of the picker so the native control's own min/max do not
  // creep while it is open; Confirm still re-reads the clock.
  const [bounds] = useState(() => {
    const now = Date.now();
    return {
      min: localDateTimeInputValue(now + MESSAGE_REMINDER_MIN_LEAD_MS),
      max: localDateTimeInputValue(now + MESSAGE_REMINDER_MAX_AHEAD_MS),
    };
  });

  // The Escape stack lets this picker outrank a Dialog it sits inside: one press
  // dismisses the picker, the next one closes the dialog. It declines while a
  // request is in flight, because cancelling then would not cancel the request.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => registerEscapeLayer(() => {
    if (!busyRef.current) cancelRef.current?.();
    return undefined;
  }, { modal: true }), []);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const choice = readChoice(value);
  // An empty field is a fault only once the member tried to confirm; a chosen
  // value that is already wrong is reported as soon as it is entered.
  const problem = unfinished ? "invalid" : (choice.problem && (attempted || value) ? choice.problem : null);
  const zone = dateTimeFormat(lang).resolvedOptions().timeZone || "UTC";

  function confirm() {
    if (busy) return;
    if (inputRef.current?.validity?.badInput) {
      setUnfinished(true);
      inputRef.current.focus();
      return;
    }
    // The clock is read again here, not taken from the last render: a picker
    // left open past its minimum lead must not confirm a time that has gone by.
    const latest = readChoice(value);
    if (latest.problem) {
      setAttempted(true);
      inputRef.current?.focus();
      return;
    }
    onConfirm?.(latest.at.toISOString());
  }

  function chooseTomorrow() {
    // setDate keeps the wall-clock time across a daylight-saving change, where
    // adding 24 hours would drift by an hour.
    const next = new Date();
    next.setDate(next.getDate() + 1);
    next.setSeconds(0, 0);
    setValue(localDateTimeInputValue(next));
    setUnfinished(false);
    setAttempted(false);
  }

  const describedBy = [`${uid}-zone`, choice.at ? `${uid}-summary` : null, problem ? `${uid}-error` : null].filter(Boolean).join(" ");

  return (
    <div className="reminder-picker" role="group" aria-labelledby={`${uid}-title`}>
      <strong id={`${uid}-title`} className="reminder-picker__title">{title || t("inbox.remindPicker.title")}</strong>
      <label className="reminder-picker__field" htmlFor={`${uid}-when`}>
        <span>{t("inbox.remindPicker.when")}</span>
        <BusyInput
          ref={inputRef}
          id={`${uid}-when`}
          className="reminder-picker__input"
          type="datetime-local"
          value={value}
          min={bounds.min}
          max={bounds.max}
          pending={busy}
          aria-invalid={problem ? "true" : undefined}
          aria-describedby={describedBy}
          onChange={(event) => { setValue(event.target.value); setUnfinished(false); }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            confirm();
          }}
        />
      </label>
      <p id={`${uid}-zone`} className="reminder-picker__zone">{t("inbox.remindPicker.timeZone", { zone })}</p>
      {choice.at && <p id={`${uid}-summary`} className="reminder-picker__summary">{t("inbox.remindPicker.summary", { when: dateTimeFormat(lang, SUMMARY_FORMAT).format(choice.at) })}</p>}
      {problem && <p id={`${uid}-error`} className="reminder-picker__error" role="alert">{t(PROBLEM_KEYS[problem])}</p>}
      <div className="reminder-picker__actions">
        <BusyButton type="button" className="reminder-picker__chip" pending={busy} onClick={chooseTomorrow}>{t("inbox.remindPicker.tomorrow")}</BusyButton>
        <BusyButton type="button" className="reminder-picker__confirm" pending={busy} onClick={confirm}>{busy ? t("inbox.remindPicker.confirming") : t("inbox.remindPicker.confirm")}</BusyButton>
        <BusyButton type="button" className="reminder-picker__cancel" pending={busy} onClick={() => onCancel?.()}>{t("inbox.cancel")}</BusyButton>
      </div>
    </div>
  );
}
