import { authorizeAnalyticsAccess, canExportOrganizationAnalytics } from "./authorization.js";
import { buildAttendanceAnalytics } from "./attendance.js";
import { buildEngagementScoring } from "./engagement.js";
import { buildOrganizationHeatmaps } from "./heatmaps.js";
import { buildCorrelationInsights } from "./insights.js";
import { buildOrganizationStatsSuite } from "./stats.js";
import { buildPortalUsageSummary } from "./usage.js";
import { analyticsAnonymityFloor } from "./contract.js";
import { composeAnalyticsWorkspace } from "./parity.js";

function emptyDesk(state, reason, viewer = {}) {
  return {
    state,
    reason,
    organizationId: viewer.organizationId || null,
    generatedAt: null,
    stats: null,
    usage: null,
    insights: null,
    heatmaps: null,
    engagement: null,
    attendance: null,
    workspace: null,
    exportAllowed: false,
  };
}

function organizationRows(rows, organizationId) {
  return Array.isArray(rows)
    ? rows.map((row) => ({ ...row, organizationId: row?.organizationId || organizationId }))
    : [];
}

export function normalizeAnalyticsSnapshot(snapshot, organizationId) {
  if (snapshot == null) return snapshot;
  if (typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return { unavailable: true, reason: "snapshot_failed", organizationId: null };
  }
  if (snapshot.unavailable === true) {
    return { ...snapshot, organizationId: snapshot.organizationId || null };
  }
  if (snapshot.error) {
    return { ...snapshot, organizationId: snapshot.organizationId || organizationId || null };
  }
  const trustedOrganizationId = snapshot.organizationId || null;
  const sourcePrivacyFloor = Number(snapshot.privacyThreshold);
  if (!trustedOrganizationId) {
    return { unavailable: true, reason: "organization_scope_missing", organizationId: null };
  }
  if (organizationId && trustedOrganizationId !== organizationId) {
    return { unavailable: true, reason: "organization_mismatch", organizationId: trustedOrganizationId };
  }
  if (!Number.isInteger(sourcePrivacyFloor) || sourcePrivacyFloor < 10 || sourcePrivacyFloor > 200) {
    return { unavailable: true, reason: "privacy_floor_mismatch", organizationId: trustedOrganizationId };
  }
  const chapters = organizationRows(snapshot.chapters, trustedOrganizationId);
  const cases = organizationRows(snapshot.cases, trustedOrganizationId);
  const membership = snapshot.membership?.organizationId === trustedOrganizationId
    ? snapshot.membership
    : {
      organizationId: trustedOrganizationId,
      active: null,
      newIn90: null,
      suppressed: true,
    };
  const series = organizationRows(snapshot.series, trustedOrganizationId);
  const placeholderSources = snapshot.attendanceCohorts?.suppressed === true
    && snapshot.attendanceCohorts?.firstTime == null
    && snapshot.attendanceCohorts?.repeat == null
    && series.every((row) => row.attendanceRate == null
      && row.engagementMean == null
      && row.usageViews == null);

  return {
    ...snapshot,
    organizationId: trustedOrganizationId,
    chapters,
    cases,
    membership,
    series,
    usageViews: organizationRows(snapshot.usageViews, trustedOrganizationId),
    heatmapPoints: organizationRows(snapshot.heatmapPoints, trustedOrganizationId),
    engagementCounts: organizationRows(snapshot.engagementCounts, trustedOrganizationId),
    attendanceEvents: organizationRows(snapshot.attendanceEvents, trustedOrganizationId),
    sourceAvailability: {
      ...snapshot.sourceAvailability,
      insights: snapshot.sourceAvailability?.insights ?? !placeholderSources,
      attendance: snapshot.sourceAvailability?.attendance ?? !placeholderSources,
      solidarity: snapshot.sourceAvailability?.solidarity ?? !placeholderSources,
    },
  };
}

export function composeAnalyticsCore({ snapshot = null, workspace = null, viewer = {}, now = new Date() } = {}) {
  const normalizedSnapshot = normalizeAnalyticsSnapshot(snapshot, viewer?.organizationId);
  const gate = authorizeAnalyticsAccess(viewer, normalizedSnapshot?.organizationId);
  if (!gate.ok) {
    return emptyDesk(gate.state, gate.reason, viewer);
  }

  if (!normalizedSnapshot) {
    return emptyDesk("unset", "snapshot_unwired", gate.viewer);
  }

  if (normalizedSnapshot.error) {
    return emptyDesk("error", normalizedSnapshot.error, gate.viewer);
  }

  if (normalizedSnapshot.unavailable) {
    return emptyDesk("unauthorized", normalizedSnapshot.reason || "authorization_required", gate.viewer);
  }

  const model = {
    state: "ready",
    reason: null,
    organizationId: gate.viewer.organizationId,
    generatedAt: normalizedSnapshot.generatedAt || now.toISOString(),
    // Server-issued id that binds an export receipt to this snapshot's counts.
    snapshotId: typeof normalizedSnapshot.snapshotId === "string" ? normalizedSnapshot.snapshotId : null,
    preview: normalizedSnapshot.label === "PREVIEW",
    stats: buildOrganizationStatsSuite(normalizedSnapshot, gate.viewer),
    usage: buildPortalUsageSummary(normalizedSnapshot, gate.viewer, now),
    insights: buildCorrelationInsights(normalizedSnapshot, gate.viewer),
    heatmaps: buildOrganizationHeatmaps(normalizedSnapshot, gate.viewer),
    engagement: buildEngagementScoring(normalizedSnapshot, gate.viewer),
    attendance: buildAttendanceAnalytics(normalizedSnapshot, gate.viewer, now),
    workspace: composeAnalyticsWorkspace({ workspace, viewer: gate.viewer, expectedFloor: analyticsAnonymityFloor(normalizedSnapshot.privacyThreshold) }),
    exportAllowed: canExportOrganizationAnalytics(gate.viewer),
  };

  if (normalizedSnapshot.sourceAvailability?.insights === false) {
    model.insights = { enoughData: false, reason: "source_unavailable", findings: [], available: false };
  }
  if (normalizedSnapshot.sourceAvailability?.solidarity === false) {
    model.heatmaps.solidarity = {
      ...model.heatmaps.solidarity,
      reason: "source_unavailable",
      available: false,
    };
  }
  if (normalizedSnapshot.sourceAvailability?.attendance === false) {
    model.attendance = {
      ...model.attendance,
      enoughData: false,
      reason: "source_unavailable",
      available: false,
    };
  }

  return model;
}
