// Explicitly labeled PREVIEW fixture for the website Pulse: Tamarack Valley
// Human Services, the fictional organization SAMPLE and PREVIEW show. It
// answers in the server's response shapes so the page code paths are the live
// ones, keeps every aggregate cell at zero or at least the floor of ten, and
// withholds the one small unit as a whole the way the server does. It is never
// written to any database.
import { dateTimeFormatCore } from "../../lib/i18n/format.js";
import { builderScopes, pulseChartFigures, pulseChartSpec, savedPulseChart } from "./pulseCharts.js";

export const PULSE_PREVIEW_ORGANIZATION = "Tamarack Valley Human Services";

const UNITS = Object.freeze([
  { id: "7a1c0b52-0d5e-4c1f-9a51-3f0c2d6b1a01", name: "Residential · Tamarack Valley chapter", current: true, scale: 0.5 },
  { id: "7a1c0b52-0d5e-4c1f-9a51-3f0c2d6b1a02", name: "Day programs · Tamarack Valley chapter", current: true, scale: 0.35 },
  // Five members: below the floor, so every chart narrowed to it is withheld.
  { id: "7a1c0b52-0d5e-4c1f-9a51-3f0c2d6b1a03", name: "Crisis team · Tamarack Valley chapter", current: true, scale: 0 },
]);

const SERIES = Object.freeze({
  my_actions: [1, 2, 0, 3, 2, 1, 4, 2, 3, 1, 2, 3],
  published_actions: [96, 104, 88, 112, 120, 109, 131, 118, 126, 139, 142, 148],
  meeting_turnout: [31, 0, 34, 38, 0, 36, 41, 0, 39, 44, 0, 46],
  visible_cases: [12, 14, 11, 16, 13, 15, 18, 14, 17, 19, 15, 21],
});

const COUNTED_FROM = Object.freeze({
  my_actions: "Your recorded collective-action sign-ups, grouped by Eastern calendar month. Other people and product analytics are excluded.",
  published_actions: "Recorded sign-ups to published collective actions for this chapter. Private drafts, cancelled actions and product analytics are excluded.",
  meeting_turnout: "Recorded check-ins at non-cancelled chapter meetings that have started. RSVPs and unrecorded attendance are excluded.",
  visible_cases: "Recorded cases in this chapter that your current staff role may read. Restricted or hidden cases outside that scope are excluded. Counts describe filings, not outcomes.",
});

function months(now, length) {
  const parts = dateTimeFormatCore("en", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  return Array.from({ length }, (_, index) => {
    const offset = month - 1 - (length - 1 - index);
    const date = new Date(Date.UTC(year, offset, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

function figures(spec, now) {
  const length = spec.period === "3m" ? 3 : spec.period === "6m" ? 6 : 12;
  const unit = UNITS.find((row) => row.id === spec.unitID);
  const local = spec.level === "local" ? 3 : 1;
  const base = { privacyFloor: 25, person: spec.measure === "my_actions", countedFrom: COUNTED_FROM[spec.measure], period: spec.period, form: spec.form };
  if (unit && unit.scale === 0) return { ...base, rows: [], withheld: true };
  const scale = (value) => {
    if (spec.measure === "my_actions" || value === 0) return value;
    return Math.round(value * local * (unit ? unit.scale : 1));
  };
  // As on the server, one aggregate cell under the floor withholds the whole
  // chart; a protected count never becomes a literal zero (gate r1s3).
  const release = (rows) => (!base.person && rows.some((row) => row.value > 0 && row.value < base.privacyFloor)
    ? { ...base, rows: [], withheld: true }
    : { ...base, withheld: false, rows });
  if (spec.breakdown === "unit") {
    // The Crisis team's cells are under ten, so the server withholds the cube.
    return { ...base, rows: [], withheld: true };
  }
  if (spec.breakdown === "meeting") {
    const labels = ["Membership meeting", "Stewards' council", "Bargaining update", "Contract town hall"];
    return release(labels.map((label, index) => ({ label, value: scale([38, 41, 44, 46][index]) })));
  }
  const values = SERIES[spec.measure].slice(-length);
  return release(months(now, length).map((label, index) => ({ label, value: scale(values[index]) })));
}

let sequence = 0;
function previewId() {
  sequence += 1;
  return `5c0ffee0-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

export function createPreviewPulseApi({ now = () => new Date() } = {}) {
  let charts = [
    { id: previewId(), title: "Chapter sign-ups", scope: "chapter", pinned: true, home: false,
      spec: { version: 1, measure: "published_actions", breakdown: "month", period: "6m", form: "line" } },
    { id: previewId(), title: "My sign-ups", scope: "personal", pinned: false, home: false,
      spec: { version: 1, measure: "my_actions", breakdown: "month", period: "12m", form: "bars" } },
  ];
  const removed = new Map();
  const measuresFor = (hat) => (hat === "member" ? ["my_actions", "published_actions", "meeting_turnout"] : ["my_actions", "published_actions", "meeting_turnout", "visible_cases"]);
  return {
    isPreview: true,
    async options(hat) {
      return {
        measures: measuresFor(hat),
        levels: hat === "member" || hat === "steward" ? ["chapter"] : ["chapter", "local"],
        units: hat === "admin" ? UNITS.map(({ id, name, current }) => ({ id, name, current })) : [],
      };
    },
    async preview(hat, spec) {
      return pulseChartFigures(figures(spec, now()), spec);
    },
    async list(hat) {
      return charts
        .filter((chart) => measuresFor(hat).includes(chart.spec.measure))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned))
        .map((chart) => savedPulseChart({ ...chart, owned: true, figures: figures(chart.spec, now()) }));
    },
    async save(hat, chart) {
      const spec = pulseChartSpec(chart.spec);
      if (!builderScopes(hat, spec.measure).includes(chart.scope)) throw new Error("chart cannot be shared in that scope");
      const row = { id: chart.id ?? previewId(), title: String(chart.title).trim(), scope: chart.scope, spec, pinned: chart.pinned === true, home: chart.pinned === true && chart.home === true };
      charts = chart.id ? charts.map((item) => (item.id === chart.id ? row : item)) : [...charts, row];
      return row.id;
    },
    async remove(id, undo = false) {
      if (undo) {
        const chart = removed.get(id);
        if (!chart) throw new Error("chart unavailable or undo expired");
        removed.delete(id);
        charts = [...charts, chart];
        return;
      }
      const chart = charts.find((item) => item.id === id);
      if (!chart) throw new Error("chart unavailable");
      removed.set(id, chart);
      charts = charts.filter((item) => item.id !== id);
    },
  };
}
