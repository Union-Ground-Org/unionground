import { useLayoutEffect, useRef } from "react";
import { dateTimeFormat, t as translate } from "../../../lib/i18n.js";

const fieldStyle = {
  minHeight: 48,
  minWidth: 48,
  padding: "0 16px",
  borderRadius: 12,
  border: "1px solid var(--control-border, var(--sg-color-border))",
  background: "var(--sg-color-card, var(--card))",
  color: "var(--ink, inherit)",
  // Longhands only. The `font` shorthand also sets font-weight, and React warns
  // when a range chip drops fontWeight while that shorthand is still set.
  fontFamily: "inherit",
  fontSize: "inherit",
  fontStyle: "inherit",
  fontStretch: "inherit",
  fontVariant: "inherit",
  lineHeight: "inherit",
  fontWeight: "inherit",
};

const buttonStyle = {
  ...fieldStyle,
  border: 0,
  background: "var(--green, var(--primary))",
  color: "var(--primary-foreground, #fff)",
  fontWeight: 800,
  cursor: "pointer",
};

const RANGES = [
  { value: 30, labelKey: "accessHistory.range30" },
  { value: 90, labelKey: "accessHistory.range90" },
  { value: 365, labelKey: "accessHistory.range365" },
];

function formatOccurredAt(value, lang) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return dateTimeFormat(lang, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function AccessHistory({
  lang = "en",
  presentation,
  rangeDays = 90,
  onRangeChange,
  onRetry,
}) {
  const events = presentation?.events || [];
  const state = presentation?.state || "loading";
  const pageHeading = useRef(null);
  const retryFocus = useRef({ wasRetry: false, restoreHeading: false });

  // Record focus BEFORE React unmounts the retry-only button. The effect below
  // runs after that unmount, when document.activeElement has already fallen
  // back to <body>, so it can no longer tell where focus came from. Restoring
  // unconditionally would steal focus from whatever the reader was on when the
  // retry state cleared for some other reason.
  if (retryFocus.current.wasRetry && state !== "retry" && !retryFocus.current.restoreHeading) {
    const active = typeof document === "undefined" ? null : document.activeElement;
    retryFocus.current.restoreHeading = Boolean(active?.closest?.("[data-access-history-retry]"));
  }
  if (state === "retry") retryFocus.current.restoreHeading = false;
  retryFocus.current.wasRetry = state === "retry";

  useLayoutEffect(() => {
    if (!retryFocus.current.restoreHeading) return;
    retryFocus.current.restoreHeading = false;
    pageHeading.current?.focus();
  }, [state]);

  return (
    <section className="access-history" aria-labelledby="access-history-title" aria-busy={state === "loading" || undefined}>
      <header>
        <h1 id="access-history-title" ref={pageHeading} tabIndex="-1">{translate(lang, "accessHistory.title")}</h1>
        <p>{translate(lang, "accessHistory.sub")}</p>
        {state === "loading" ? null : (
          <p>{state === "mfa_required" ? translate(lang, "accessHistory.mfaRequired") : presentation?.message}</p>
        )}
      </header>
      <div role="group" aria-label={translate(lang, "accessHistory.rangeLegend")} style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "16px 0" }}>
        {RANGES.map((range) => (
          <button
            key={range.value}
            type="button"
            style={rangeDays === range.value ? buttonStyle : fieldStyle}
            aria-pressed={rangeDays === range.value}
            onClick={() => onRangeChange?.(range.value)}
          >
            {translate(lang, range.labelKey)}
          </button>
        ))}
      </div>
      {state === "retry" ? (
        <button type="button" data-access-history-retry="" style={buttonStyle} onClick={onRetry}>{translate(lang, "accessHistory.retryAction")}</button>
      ) : null}
      {state === "loading" ? <p role="status" aria-live="polite">{translate(lang, "accessHistory.loadingBody")}</p> : null}
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 12 }}>
        {events.map((event) => (
          <li key={event.id}>
            <article>
              <h2>{event.label}</h2>
              <p><time dateTime={event.occurredAt}>{formatOccurredAt(event.occurredAt, lang)}</time></p>
            </article>
          </li>
        ))}
      </ul>
      <p>{presentation?.disclaimer}</p>
    </section>
  );
}
