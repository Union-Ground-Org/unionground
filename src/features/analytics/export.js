import {
  ANALYTICS_AUDIT_EVENT_TYPES,
  ANALYTICS_AUDIT_METADATA_KEYS,
  ANALYTICS_EXPORT_TTL_MS,
} from "./contract.js";
import { canExportOrganizationAnalytics } from "./authorization.js";
import { redactExportValue } from "./privacy.js";

function csvEscape(value) {
  const raw = value == null ? "" : String(value);
  const text = typeof value === "string" && /^\s*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll("\"", "\"\"")}"`;
  return text;
}

export function flattenAnalyticsExportRows(model) {
  const rows = [];
  const stats = model.stats || {};
  if (stats.overview) {
    rows.push({
      surface: "stats",
      section: "overview",
      label: "open_cases",
      value: stats.overview.openCases,
    });
    rows.push({
      surface: "stats",
      section: "overview",
      label: "resolved_cases",
      value: stats.overview.resolvedCases,
    });
    rows.push({
      surface: "stats",
      section: "overview",
      label: "average_open_per_steward",
      value: stats.overview.averageOpenPerSteward,
    });
  }
  for (const row of stats.comparison?.rows || []) {
    rows.push({
      surface: "stats",
      section: "comparison",
      label: row.label,
      value: row.openCases,
    });
  }
  for (const row of model.usage?.byPath || []) {
    rows.push({ surface: "usage", section: "path", label: row.name, value: row.count });
  }
  for (const finding of model.insights?.available === false ? [] : model.insights?.findings || []) {
    rows.push({
      surface: "insights",
      section: finding.id,
      label: finding.title,
      value: finding.r,
    });
  }
  for (const kind of ["grievance", "solidarity"]) {
    for (const cell of model.heatmaps?.[kind]?.available === false ? [] : model.heatmaps?.[kind]?.cells || []) {
      rows.push({
        surface: "heatmaps",
        section: kind,
        label: `${cell.rowKey} × ${cell.colKey}`,
        value: redactExportValue(cell),
      });
    }
  }
  for (const row of model.engagement?.chapters || []) {
    rows.push({
      surface: "engagement",
      section: "chapter",
      label: row.label,
      value: row.score,
    });
  }
  for (const [band, cell] of Object.entries(model.engagement?.histogram || {})) {
    rows.push({ surface: "engagement", section: "histogram", label: band, value: redactExportValue(cell) });
  }
  for (const row of model.attendance?.available === false ? [] : model.attendance?.recent || []) {
    rows.push({
      surface: "attendance",
      section: "event",
      label: row.id,
      value: row.suppressed ? { value: null, suppressed: true } : row.checkIns,
    });
  }
  return rows;
}

export function serializeAnalyticsCsv(rows) {
  const header = ["surface", "section", "label", "value"];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push([
      csvEscape(row.surface),
      csvEscape(row.section),
      csvEscape(row.label),
      csvEscape(redactExportValue(row.value)),
    ].join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function buildAnalyticsExport(model, viewer, { now = new Date(), format = "csv" } = {}) {
  if (!canExportOrganizationAnalytics(viewer)) {
    return {
      ok: false,
      state: "unauthorized",
      reason: "export_denied",
      payload: null,
      audit: null,
    };
  }
  if (!model?.organizationId || model.organizationId !== viewer.organizationId) {
    return {
      ok: false,
      state: "unauthorized",
      reason: "cross_organization",
      payload: null,
      audit: null,
    };
  }

  const rows = flattenAnalyticsExportRows(model);
  const expiresAt = new Date(now.getTime() + ANALYTICS_EXPORT_TTL_MS).toISOString();
  const suppressedCount = rows.filter((row) => redactExportValue(row.value) === "suppressed").length;
  const exportRows = rows.map((row) => ({ ...row, value: redactExportValue(row.value) }));
  const body = format === "json"
    ? JSON.stringify({ organizationId: viewer.organizationId, expiresAt, rows: exportRows }, null, 2)
    : serializeAnalyticsCsv(rows);

  return {
    ok: true,
    state: "ready",
    reason: null,
    payload: {
      format,
      filename: `organization-analytics-${viewer.organizationId}-${now.toISOString().slice(0, 10)}.${format}`,
      body,
      expiresAt,
      rowCount: rows.length,
      suppressedCount,
    },
    audit: {
      type: ANALYTICS_AUDIT_EVENT_TYPES[1],
      metadata: {
        organizationId: viewer.organizationId,
        chapterId: viewer.chapterId || null,
        surface: "analytics_core",
        exportFormat: format,
        rowCount: rows.length,
        suppressedCount,
        expiresAt,
      },
      allowedKeys: ANALYTICS_AUDIT_METADATA_KEYS,
    },
  };
}
