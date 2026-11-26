import { ANALYTICS_EXPORT_HATS, ANALYTICS_STAFF_HATS } from "./contract.js";

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function normalizeAnalyticsViewer(viewer = {}) {
  const selectedHat = viewer.selectedHat || null;
  const roles = unique(Array.isArray(viewer.roles) ? viewer.roles : []);
  const organizationRoles = unique(Array.isArray(viewer.organizationRoles) ? viewer.organizationRoles : []);
  return {
    organizationId: viewer.organizationId || null,
    chapterId: viewer.chapterId || null,
    selectedHat,
    roles,
    organizationRoles,
    userId: viewer.userId || null,
  };
}

function hasStaffAnalyticsHat(viewer) {
  const normalized = normalizeAnalyticsViewer(viewer);
  return ANALYTICS_STAFF_HATS.includes(normalized.selectedHat);
}

function hasOrganizationAnalyticsGrant(viewer) {
  const normalized = normalizeAnalyticsViewer(viewer);
  return normalized.organizationRoles.some((role) => ANALYTICS_STAFF_HATS.includes(role));
}

export function canReadOrganizationAnalytics(viewer) {
  const normalized = normalizeAnalyticsViewer(viewer);
  if (!normalized.organizationId) return false;
  if (!hasStaffAnalyticsHat(normalized)) return false;
  if (!hasOrganizationAnalyticsGrant(normalized)) return false;
  return true;
}

export function canExportOrganizationAnalytics(viewer) {
  const normalized = normalizeAnalyticsViewer(viewer);
  return canReadOrganizationAnalytics(normalized)
    && ANALYTICS_EXPORT_HATS.includes(normalized.selectedHat)
    && normalized.organizationRoles.includes(normalized.selectedHat);
}

export function authorizeAnalyticsAccess(viewer, snapshotOrganizationId) {
  const normalized = normalizeAnalyticsViewer(viewer);

  if (!normalized.organizationId) {
    return { ok: false, state: "empty", reason: "no_organization" };
  }
  if (!hasStaffAnalyticsHat(normalized)) {
    return { ok: false, state: "unauthorized", reason: "member_hat" };
  }
  if (!hasOrganizationAnalyticsGrant(normalized)) {
    return { ok: false, state: "unauthorized", reason: "missing_grant" };
  }
  if (
    snapshotOrganizationId
    && snapshotOrganizationId !== normalized.organizationId
  ) {
    return { ok: false, state: "unauthorized", reason: "cross_organization" };
  }
  return { ok: true, state: "ready", reason: null, viewer: normalized };
}

export function rejectCallerSuppliedOrganization(viewer, claimedOrganizationId) {
  const normalized = normalizeAnalyticsViewer(viewer);
  if (!claimedOrganizationId) return normalized.organizationId;
  if (claimedOrganizationId !== normalized.organizationId) return null;
  return normalized.organizationId;
}
