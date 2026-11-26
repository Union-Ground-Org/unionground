import { analyticsScoreBand, normalizeMemberReportCard } from "../parity.js";
import "../analyticsCore.css";

const LABELS = {
  en: {
    title: "Participation report card",
    sub: "Your own activity only. Case volume never lowers this score.",
    empty: "Your report card appears after protected activity signals are available.",
    overall: "Overall",
    participation: "Participation",
    profileReadiness: "Profile readiness",
    followThrough: "Follow-through",
    band: { critical: "Critical", concerning: "Concerning", moderate: "Moderate", healthy: "Healthy", excellent: "Excellent", not_ready: "Not ready" },
  },
  es: {
    title: "Reporte de participación",
    sub: "Solo tu propia actividad. La cantidad de casos nunca reduce esta puntuación.",
    empty: "Tu reporte aparecerá cuando haya señales protegidas de actividad.",
    overall: "General",
    participation: "Participación",
    profileReadiness: "Preparación del perfil",
    followThrough: "Seguimiento",
    band: { critical: "Crítico", concerning: "Preocupante", moderate: "Moderado", healthy: "Saludable", excellent: "Excelente", not_ready: "No listo" },
  },
};

export function MemberReportCard({ value, lang = "en", healthBands = undefined }) {
  const copy = LABELS[lang] || LABELS.en;
  const report = normalizeMemberReportCard(value);
  return (
    <section className="plane-card ach-card mi1-report-card" aria-labelledby="member-report-card-title">
      <div>
        <p className="mi1-ana__eyebrow">{copy.band[analyticsScoreBand(report.overall, healthBands)]}</p>
        <h2 id="member-report-card-title" className="ach-card__title">{copy.title}</h2>
        <p className="mi1-ana__note">{copy.sub}</p>
      </div>
      {report.state === "empty" ? <p className="mi1-ana__note">{copy.empty}</p> : (
        <>
          <div className="mi1-report-card__overall">
            <strong>{report.overall}</strong>
            <span>{copy.overall}</span>
          </div>
          <div className="mi1-ana__grid">
            {report.components.map((component) => (
              <div key={component.id} className="mi1-ana-score">
                <span>{copy[component.id]}</span><strong>{component.score}</strong>
              </div>
            ))}
          </div>
          {report.signals.length ? (
            <div className="mi1-report-card__signals" aria-label={copy.title}>
              {report.signals.map((signal) => <span key={signal.label}>{signal.label}: <strong>{signal.value}</strong></span>)}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
