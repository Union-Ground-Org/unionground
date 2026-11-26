import { ArrivalCount, ChartArrival, arriveAt } from "../../../components/ChartArrival.jsx";
import { latestRow, pulseRowLabel, pulseSeries } from "../pulseCharts.js";

// One chart from server-cleared rows. The series hue is the measure's trio
// color; text never sits in a series color, so the page's text pairs keep
// their audited 4.5:1.
export function PulseFigureState({ figures, copy, loading = false }) {
  if (loading) return <p className="pulse-note" role="status">{copy.cardLoading}</p>;
  if (!figures || figures.unavailable) return <p className="pulse-note pulse-note--alert" role="status">{copy.unavailable}</p>;
  if (figures.locked) return <p className="pulse-note" role="status">{copy.locked}</p>;
  if (figures.withheld) return <p className="pulse-note" role="status">{copy.withheld(figures.floor)}</p>;
  if (!figures.rows.length) return <p className="pulse-note" role="status">{copy.empty}</p>;
  return null;
}

export function PulseTable({ figures, copy, lang, caption }) {
  return (
    <table className="pulse-table">
      <caption>{caption}</caption>
      <thead>
        <tr><th scope="col">{copy.labelHeader}</th><th scope="col">{copy.valueHeader}</th></tr>
      </thead>
      <tbody>
        {figures.rows.map((row) => (
          <tr key={row.label}><th scope="row">{pulseRowLabel(row.label, lang)}</th><td>{row.value}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

// The name a chart arrives under (charts arrive once, theme decision 4): the
// same measure, period, breakdown and form is the same chart on this visit.
export function pulseArrivalName(spec, where) {
  return `pulse:${where}:${spec?.measure}:${spec?.period}:${spec?.breakdown}:${spec?.form}`;
}

export function PulseHero({ name, value, children }) {
  return (
    <ChartArrival as="p" name={name} className="pulse-card__hero">
      <strong><ArrivalCount value={value} /></strong> {children}
    </ChartArrival>
  );
}

export function PulseChart({ figures, spec, title, copy, lang, large = false, name = pulseArrivalName(spec, large ? "detail" : "card") }) {
  if (!figures || figures.unavailable || figures.locked || figures.withheld || !figures.rows.length) {
    return <PulseFigureState figures={figures} copy={copy} />;
  }
  if (spec?.form === "table") return <PulseTable figures={figures} copy={copy} lang={lang} caption={title} />;
  const color = pulseSeries(spec?.measure);
  const rows = figures.rows;
  const max = Math.max(1, ...rows.map((row) => row.value));
  const width = 100;
  const height = large ? 48 : 32;
  const step = width / rows.length;
  const latest = latestRow(figures);
  const label = copy.chartLabel(copy.forms[spec?.form] || copy.forms.bars, title, rows.length, latest ? `${pulseRowLabel(latest.label, lang)} ${latest.value}` : "");
  const y = (value) => height - (value / max) * (height - 2);
  return (
    <ChartArrival as="figure" name={name} className={`pulse-chart${large ? " pulse-chart--large" : ""}`}>
      <svg role="img" aria-label={label} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="pulse-chart__plot">
        <line x1="0" x2={width} y1={height - 0.25} y2={height - 0.25} className="pulse-chart__axis" />
        {spec?.form === "line"
          ? <polyline className="arrive-line" fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke"
            points={rows.map((row, index) => `${(index + 0.5) * step},${y(row.value)}`).join(" ")} />
          : rows.map((row, index) => (
            <rect key={row.label} className="arrive-y" style={arriveAt(index)} x={index * step + step * 0.15} width={step * 0.7} y={y(row.value)} height={Math.max(0, height - y(row.value))} fill={color} />
          ))}
      </svg>
      <figcaption className="pulse-chart__axis-labels" aria-hidden="true">
        <span>{pulseRowLabel(rows[0].label, lang)}</span>
        <span>{pulseRowLabel(rows[rows.length - 1].label, lang)}</span>
      </figcaption>
    </ChartArrival>
  );
}
