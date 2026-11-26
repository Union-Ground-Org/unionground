import { CARD_CLASS } from "./Surfaces.jsx";

export function FormAnswerReview({ template, answers, t, lead = true }) {
  const fields = template.steps.flatMap((step) => step.fields);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {lead && <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: "var(--muted-foreground)" }}>
        {t("forms.reviewLead")}
      </p>}
      <div className={CARD_CLASS + " m-card--flush"}>
        {fields.map((field, index) => {
          const display = formatAnswer(field, answers[field.key], t);
          return (
            <div
              key={field.key}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 3,
                padding: "11px 15px",
                borderTop: index > 0 ? "1px solid var(--border)" : "none",
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".04em", color: "var(--muted-foreground)" }}>
                {t(field.labelKey)}
              </span>
              <span
                style={{
                  fontSize: 13,
                  lineHeight: 1.45,
                  color: display == null ? "var(--muted-foreground)" : "var(--ink)",
                  fontStyle: display == null ? "italic" : "normal",
                  fontWeight: display == null ? 500 : 600,
                  overflowWrap: "anywhere",
                }}
              >
                {display == null ? t(field.required ? "forms.requiredNotAnswered" : "forms.notAnswered") : display}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatAnswer(field, value, t) {
  if (field.type === "multiselect") {
    const selected = Array.isArray(value) ? value : [];
    if (selected.length === 0) return null;
    return selected
      .map((v) => {
        const option = (field.options || []).find((item) => item.value === v);
        return option ? t(option.labelKey) : v;
      })
      .join(", ");
  }
  if (field.type === "select" || field.type === "radio") {
    if (value == null || value === "") return null;
    const option = (field.options || []).find((item) => item.value === value);
    return option ? t(option.labelKey) : String(value);
  }
  if (field.type === "checkbox") {
    return value ? "✓" : null;
  }
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}
