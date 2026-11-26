import {
  ANALYTICS_COHORT_FLOOR,
  ANALYTICS_COUNT_BANDS,
  ANALYTICS_HEATMAP_CELL_FLOOR,
} from "./contract.js";

export function countBand(count, floor = ANALYTICS_COHORT_FLOOR) {
  if (!Number.isFinite(count) || count < floor) return null;
  if (count < 25) return `${floor}-24`;
  const band = ANALYTICS_COUNT_BANDS.find((item) => count >= item.min && count <= item.max);
  return band?.id ?? "100+";
}

export function enoughForCohort(count, floor = ANALYTICS_COHORT_FLOOR) {
  return Number.isFinite(count) && count >= floor;
}

export function protectedCohort(reason = "anonymity_floor", floor = ANALYTICS_COHORT_FLOOR) {
  return {
    enoughData: false,
    reason,
    minCohort: floor,
    rows: [],
  };
}

export function suppressHeatmapCell(count, floor = ANALYTICS_HEATMAP_CELL_FLOOR) {
  // Zero and malformed cells are protected too. Publishing a literal zero
  // lets a viewer distinguish an empty cohort from a small protected cohort.
  if (!Number.isFinite(count) || count < floor) {
    return { value: null, suppressed: true };
  }
  return { value: count, suppressed: false };
}

export function keepOrganizationRows(rows, organizationId) {
  if (!organizationId || !Array.isArray(rows)) return [];
  return rows.filter((row) => row?.organizationId === organizationId);
}

export function roundRate(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function average(values) {
  const numbers = (values || []).filter((value) => Number.isFinite(value));
  if (!numbers.length) return null;
  return roundRate(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
}

export function redactExportValue(cell) {
  if (cell == null) return "suppressed";
  if (typeof cell === "object") {
    if (cell.suppressed || cell.enoughData === false) return "suppressed";
    if (cell.value == null && cell.suppressed !== false) return "suppressed";
    return cell.value;
  }
  return cell;
}
