import { ArrivalCount, ChartArrival, arriveAt } from "../../components/ChartArrival.jsx";

// The prototype Statistics page's chart marks (pages/stats.js): the monthly
// bar chart (thin bars, one axis, value labels on the latest two bars, a
// focusable hover target per bar that feeds the shell's data-tip tooltip),
// the horizontal bars, and the table every chart can switch to. The series
// are whatever the caller hands in; nothing here invents a value. Each chart
// arrives once under its name (theme decision 4, ChartArrival.jsx).

const W = 1000;
const H = 300;
const PAD_L = 44;
const PAD_B = 34;
const PAD_T = 26;

function chartTop(max) {
  if (max <= 10) return Math.max(1, Math.ceil(max));
  return Math.ceil(max / 10) * 10;
}

// bars: [{ v, label, val }]; `val` is the text a reader sees for the bar.
export function BarChart({ bars, color, label, showAxis = true, name = `takepart:bars:${label}` }) {
  const innerH = H - PAD_B - PAD_T;
  const top = chartTop(Math.max(0, ...bars.map((bar) => bar.v)));
  const y = (value) => PAD_T + innerH - (value / top) * innerH;
  const ticks = top >= 2 && top % 2 === 0 ? [0, top / 2, top] : [0, top];
  const slot = (W - PAD_L - 10) / Math.max(1, bars.length);
  const barW = Math.min(46, slot * 0.56);
  return (
    <ChartArrival as="svg" name={name} className="ug-chart" viewBox={`0 0 ${W} ${H}`} role="group" aria-label={label}>
      {ticks.map((value) => (
        <g key={value}>
          <line x1={PAD_L} x2={W - 6} y1={y(value)} y2={y(value)} stroke="rgba(20,32,28,.10)" />
          {showAxis ? <text x={PAD_L - 10} y={y(value) + 4} textAnchor="end">{value}</text> : null}
        </g>
      ))}
      {bars.map((bar, index) => {
        const x = PAD_L + index * slot + (slot - barW) / 2;
        const height = (bar.v / top) * innerH;
        const latest = index >= bars.length - 2;
        return (
          <g key={`${bar.label}-${index}`}>
            <rect className="arrive-y" style={arriveAt(index)} x={x} y={PAD_T + innerH - height} width={barW} height={Math.max(0, height)} rx="4" fill={color} />
            <text x={x + barW / 2} y={H - 12} textAnchor="middle" className={index === bars.length - 1 ? "ug-ta-chart-now" : undefined}>{bar.label}</text>
            {latest ? <text x={x + barW / 2} y={PAD_T + innerH - height - 8} textAnchor="middle" className="ug-ta-chart-now arrive-dot">{bar.val}</text> : null}
            <rect
              x={PAD_L + index * slot}
              y={PAD_T}
              width={slot}
              height={innerH}
              fill="transparent"
              tabIndex={0}
              role="img"
              aria-label={`${bar.label}: ${bar.val}`}
              data-tip={bar.label}
              data-tip-sub={bar.val}
            />
          </g>
        );
      })}
    </ChartArrival>
  );
}

// rows: [{ label, w (0–100), val, color }]
export function HBars({ rows, name }) {
  return (
    <ChartArrival name={name} className="ug-ta-hbars">
      {rows.map((row, index) => (
        <div key={`${row.label}-${index}`} className="ug-ta-hbar" data-tip={row.label} data-tip-sub={row.val}>
          <span className="ug-ta-hbar-l">{row.label}</span>
          <span className="ug-ta-hbar-track" aria-hidden="true"><i className="arrive-x" style={arriveAt(index, { width: `${Math.max(0, Math.min(100, row.w))}%`, background: row.color })} /></span>
          <b className="ug-tnum"><ArrivalCount value={row.val} index={index} /></b>
        </div>
      ))}
    </ChartArrival>
  );
}

export function DataTable({ head, rows }) {
  return (
    <div className="ug-ta-table">
      <table>
        <thead><tr>{head.map((cell) => <th key={cell} scope="col">{cell}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
