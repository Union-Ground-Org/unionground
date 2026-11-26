import { ANALYTICS_HEATMAP_CELL_FLOOR, ANALYTICS_HEATMAP_KINDS, analyticsAnonymityFloor } from "./contract.js";
import { keepOrganizationRows, suppressHeatmapCell } from "./privacy.js";

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function buildHeatmapLayer(points, { floor = ANALYTICS_HEATMAP_CELL_FLOOR } = {}) {
  const rowKeys = uniqueSorted(points.map((point) => point.rowKey || "unspecified"));
  const colKeys = uniqueSorted(points.map((point) => point.colKey || "unspecified"));
  const counts = new Map();
  for (const point of points) {
    const key = `${point.rowKey || "unspecified"}|${point.colKey || "unspecified"}`;
    counts.set(key, (counts.get(key) || 0) + (Number(point.count) || 0));
  }

  let maxValue = 0;
  let suppressedCount = 0;
  const cells = [];
  for (const rowKey of rowKeys) {
    for (const colKey of colKeys) {
      const raw = counts.get(`${rowKey}|${colKey}`) || 0;
      const cell = suppressHeatmapCell(raw, floor);
      if (cell.suppressed) suppressedCount += 1;
      if (cell.value > maxValue) maxValue = cell.value;
      cells.push({
        rowKey,
        colKey,
        ...cell,
      });
    }
  }

  return {
    rowKeys,
    colKeys,
    cells,
    maxValue,
    suppressedCount,
    cellFloor: floor,
  };
}

export function buildOrganizationHeatmaps(snapshot = {}, viewer = {}) {
  const organizationId = viewer.organizationId;
  const floor = analyticsAnonymityFloor(snapshot.privacyThreshold);
  const points = keepOrganizationRows(snapshot.heatmapPoints, organizationId);
  const layers = {};
  for (const kind of ANALYTICS_HEATMAP_KINDS) {
    layers[kind] = buildHeatmapLayer(points.filter((point) => point.kind === kind), { floor });
  }
  return layers;
}
