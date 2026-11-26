import { ANALYTICS_REQUESTED_RPCS, ANALYTICS_REQUESTED_TABLES } from "./contract.js";
import { composeAnalyticsCore } from "./dashboard.js";
import { buildAnalyticsExport } from "./export.js";
import { normalizeAnalyticsViewer } from "./authorization.js";
import { withLoadDeadline } from "../../lib/loadDeadline.js";

function readFailure(error, failed) {
  return error?.name === "TimeoutError" ? "timed_out" : failed;
}

export function createAnalyticsCoreAdapter({
  fetchSnapshot = null,
  fetchWorkspace = null,
  saveLayout = null,
  deleteLayout = null,
  requestExport = null,
} = {}) {
  return {
    requestedRpcs: ANALYTICS_REQUESTED_RPCS,
    requestedTables: ANALYTICS_REQUESTED_TABLES,
    // Each read has its own deadline and its own failure
    // (BUG-UG-WEB-ANALYTICS-HOSTED-DEMO-NEVER-SHOWS-A-FIGURE-20261002):
    // the role-scaled workspace read can time out without discarding a
    // snapshot that answered, and the desk names which part timed out.
    async loadDesk({ viewer, now = new Date(), deadlineMs = null } = {}) {
      const normalized = normalizeAnalyticsViewer(viewer);
      if (!fetchSnapshot) {
        return composeAnalyticsCore({ snapshot: null, workspace: null, viewer: normalized, now });
      }
      // Loaders that retry a dropped read skip a retry past this deadline.
      const deadlineAt = Number.isFinite(deadlineMs) && deadlineMs > 0 ? Date.now() + deadlineMs : null;
      const [snapshot, workspace] = await Promise.all([
        withLoadDeadline(async () => fetchSnapshot(normalized, { deadlineAt }), deadlineMs).catch((error) => ({
          organizationId: normalized.organizationId,
          error: readFailure(error, "snapshot_failed"),
        })),
        fetchWorkspace
          ? withLoadDeadline(async () => fetchWorkspace(normalized, { deadlineAt }), deadlineMs).catch((error) => ({
            error: readFailure(error, "workspace_failed"),
          }))
          : null,
      ]);
      return composeAnalyticsCore({ snapshot, workspace, viewer: normalized, now });
    },
    async saveLayout(input) {
      if (!saveLayout) return { ok: false, reason: "layout_unwired" };
      try {
        return { ok: true, layout: await saveLayout(input) };
      } catch {
        return { ok: false, reason: "layout_save_failed" };
      }
    },
    async deleteLayout(input) {
      if (!deleteLayout) return { ok: false, reason: "layout_unwired" };
      try {
        return { ok: true, layout: await deleteLayout(input) };
      } catch {
        return { ok: false, reason: "layout_delete_failed" };
      }
    },
    async exportDesk(model, viewer, options) {
      const result = buildAnalyticsExport(model, normalizeAnalyticsViewer(viewer), options);
      if (!result.ok || !requestExport) return result;
      try {
        const receipt = await requestExport({
          format: result.payload.format,
          snapshotId: model?.snapshotId || null,
          rowCount: result.payload.rowCount,
          suppressedCount: result.payload.suppressedCount,
        });
        return { ...result, receipt };
      } catch {
        return {
          ok: false,
          state: "error",
          reason: "export_failed",
          payload: null,
          audit: null,
        };
      }
    },
  };
}
