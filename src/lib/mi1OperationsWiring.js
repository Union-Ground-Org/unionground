import {
  AUDIT_SINK_TABLES,
  OPERATIONS_RPCS,
  PRODUCT_JOBS,
  auditSinkRpc,
  authorizeAuditQuery,
  authorizeAuditSinkQuery,
  authorizeJobQuery,
  authorizeJobRemediation,
  buildJobHealthDesk,
  normalizePersistedJobHealthRows,
  clientMayCallRpc,
  projectAuditSinkRows,
  shapeAuditListRequest,
  shapeAuditSinkRequest,
  shapeJobRemediationRequest,
} from "../features/operations/index.js";

export const MI1_OPERATIONS_WEB_DONOR = Object.freeze({
  baseline: "donor-baseline-20260721",
  wiring: "ad2aef01af257be3d6fbbbe985b24f984cf8f222",
  disposition: "port_adapt",
  rejected: Object.freeze([
    "Next.js app router and server actions",
    "legacy service-role browser clients",
    "fictional live tenants or seeded job runs",
    "in-memory writes presented as persisted success",
    "browser execution of acknowledge/retry remediations",
    "QA, pay, analytics, integrations, and public-directory wiring",
  ]),
});

export function isMissingOperationsRpcError(error) {
  const code = String(error?.code || error?.status || "");
  const message = String(error?.message || error || "");
  return code === "PGRST202" || code === "42883" || /could not find the function|does not exist/i.test(message);
}

export function isOperationsAuthorizationError(error) {
  return String(error?.code || error?.status || "") === "42501";
}

function operationsAuthorizationReason(error) {
  return /mfa required/i.test(String(error?.message || error || ""))
    ? "mfa_required"
    : "authorization_required";
}

async function callNamedRpc(client, name, args) {
  if (!clientMayCallRpc(name)) return { missing: false, error: { message: "rpc-not-client-callable" }, data: null };
  if (!client?.rpc) return { missing: true, error: null, data: null };
  const result = await client.rpc(name, args);
  if (!result?.error) return { missing: false, error: null, data: result?.data ?? null };
  if (isMissingOperationsRpcError(result.error)) return { missing: true, error: result.error, data: null };
  return { missing: false, error: result.error, data: null };
}

// The ledger's actor ids, at most 200 per call (the reader's own limit).
const ACTOR_NAME_BATCH = 200;

export function createOperationsApi(client) {
  return {
    // Names for the ledger rows' actors. A failed or missing reader names
    // nobody, so the ledger keeps its short references rather than failing.
    async listActorNames(userIds = []) {
      const ids = [...new Set(userIds.filter((id) => typeof id === "string" && id))].slice(0, ACTOR_NAME_BATCH);
      if (!ids.length) return {};
      const result = await callNamedRpc(client, OPERATIONS_RPCS.listActorNames, { p_user_ids: ids });
      if (result.error || result.missing || !result.data || typeof result.data !== "object") return {};
      return Object.fromEntries(Object.entries(result.data).filter(([id, name]) => ids.includes(id) && typeof name === "string" && name.trim()));
    },
    async listAudit(session, filters = {}) {
      const gate = authorizeAuditQuery(session);
      if (!gate.ok) return { state: "unauthorized", reason: gate.reason, events: [], hasOlder: false };
      const shaped = shapeAuditListRequest(session, filters);
      const result = await callNamedRpc(client, OPERATIONS_RPCS.listAudit, {
        p_limit: shaped.p_limit,
        p_before: shaped.p_before,
        p_before_id: shaped.p_before_id,
        p_domain: shaped.p_domain,
        p_action: shaped.p_action,
      });
      if (result.missing) return { state: "unset", events: [], hasOlder: false };
      if (isOperationsAuthorizationError(result.error)) return { state: "unauthorized", reason: operationsAuthorizationReason(result.error), events: [], hasOlder: false };
      if (result.error) return { state: "error", events: [], hasOlder: false };
      const events = Array.isArray(result.data) ? result.data : [];
      return {
        state: events.length ? "ready" : "empty",
        events,
        hasOlder: events.length >= shaped.p_limit,
      };
    },

    // One paged read of a single previously dormant audit sink. The reader
    // returns authorized record links only, so the projection has nothing to
    // redact; a row outside the selected organization is still dropped here
    // rather than trusted from the wire.
    async listAuditSource(session, source, filters = {}) {
      const gate = authorizeAuditSinkQuery(session, source, filters);
      if (!gate.ok) return { state: "unauthorized", reason: gate.reason, events: [], hasOlder: false };
      const shaped = shapeAuditSinkRequest(session, source, filters);
      const result = await callNamedRpc(client, auditSinkRpc(source), {
        p_limit: shaped.p_limit,
        p_before: shaped.p_before,
        p_before_id: shaped.p_before_id,
        p_kind: shaped.p_kind,
        p_since: shaped.p_since,
        p_until: shaped.p_until,
        ...(shaped.p_case_id === undefined ? {} : { p_case_id: shaped.p_case_id }),
      });
      if (result.missing) return { state: "unset", events: [], hasOlder: false };
      if (isOperationsAuthorizationError(result.error)) {
        return { state: "unauthorized", reason: operationsAuthorizationReason(result.error), events: [], hasOlder: false };
      }
      if (result.error) return { state: "error", events: [], hasOlder: false };
      const rows = Array.isArray(result.data) ? result.data : [];
      const events = projectAuditSinkRows(source, rows, session.selectedOrganizationId);
      return {
        state: events.length ? "ready" : "empty",
        events,
        hasOlder: rows.length >= shaped.p_limit,
      };
    },

    async listJobHealth(session) {
      const gate = authorizeJobQuery(session);
      if (!gate.ok) return { state: "unauthorized", reason: gate.reason, jobs: [] };
      const result = await callNamedRpc(client, OPERATIONS_RPCS.listJobHealth, {});
      if (result.missing) {
        return { state: "unset", jobs: [] };
      }
      if (isOperationsAuthorizationError(result.error)) return { state: "unauthorized", reason: operationsAuthorizationReason(result.error), jobs: [] };
      if (result.error) return { state: "error", jobs: [] };
      const payload = normalizePersistedJobHealthRows(result.data, session.selectedOrganizationId);
      return {
        state: PRODUCT_JOBS.length ? "ready" : "empty",
        jobs: buildJobHealthDesk({
          selectedOrganizationId: session.selectedOrganizationId,
          runs: payload.runs || [],
          acknowledgements: payload.acknowledgements || [],
        }),
      };
    },

    async acknowledgeJob(session, command) {
      const gate = authorizeJobRemediation(session, { ...command, remediation: "acknowledge" });
      if (!gate.ok) return { ok: false, reason: gate.reason, executesJob: false };
      const shaped = shapeJobRemediationRequest(session, command);
      const result = await callNamedRpc(client, OPERATIONS_RPCS.acknowledgeJob, {
        p_job_name: shaped.p_job_name,
        p_run_id: shaped.p_run_id,
      });
      if (result.missing) return { ok: false, reason: "persistence_unset", executesJob: false };
      if (isOperationsAuthorizationError(result.error)) return { ok: false, reason: operationsAuthorizationReason(result.error), executesJob: false };
      if (result.error) return { ok: false, reason: "unavailable", executesJob: false };
      return { ok: true, executesJob: false };
    },

    async requestJobRetry(session, command) {
      const gate = authorizeJobRemediation(session, { ...command, remediation: "request_retry" });
      if (!gate.ok) return { ok: false, reason: gate.reason, executesJob: false };
      const shaped = shapeJobRemediationRequest(session, command);
      const result = await callNamedRpc(client, OPERATIONS_RPCS.requestJobRetry, {
        p_job_name: shaped.p_job_name,
        p_run_id: shaped.p_run_id,
      });
      if (result.missing) return { ok: false, reason: "persistence_unset", executesJob: false };
      if (isOperationsAuthorizationError(result.error)) return { ok: false, reason: operationsAuthorizationReason(result.error), executesJob: false };
      if (result.error) return { ok: false, reason: "unavailable", executesJob: false };
      return { ok: true, executesJob: false };
    },
  };
}

export const MI1_OPERATIONS_DATABASE_DEPENDENCIES = Object.freeze({
  operations: Object.freeze({
    owner: "X-DB",
    rpcs: Object.freeze([
      ...Object.values(OPERATIONS_RPCS),
      ...AUDIT_SINK_TABLES.map((source) => auditSinkRpc(source)),
    ]),
    tables: Object.freeze([
      "organization_audit_ledger",
      "organization_job_runs",
      "organization_job_acknowledgements",
      ...AUDIT_SINK_TABLES,
    ]),
  }),
  sessionScope: Object.freeze({
    owner: "X-DB",
    rpcs: Object.freeze(["get_my_chapter_memberships"]),
    tables: Object.freeze(["organization_memberships", "organization_role_grants"]),
  }),
});
