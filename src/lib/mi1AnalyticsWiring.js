import { useEffect, useMemo, useState } from "react";
import { createAnalyticsCoreAdapter } from "../features/analytics/adapter.js";
import { ANALYTICS_REQUESTED_RPCS, ANALYTICS_REQUESTED_TABLES } from "../features/analytics/contract.js";
import { ORGANIZATION_ROLES } from "../features/tenancy/organizationScope.js";

export const MI1_ANALYTICS_WEB_DONOR = Object.freeze({
  baseline: "donor-baseline-20260721",
  webWiring: "ad2aef01af257be3d6fbbbe985b24f984cf8f222",
  disposition: "port_adapt",
  rejected: Object.freeze([
    "Next.js app router and server actions",
    "legacy service-role browser clients",
    "fictional live tenants or seeded analytics snapshots",
    "in-memory writes presented as persisted success",
    "other first-wave domains and migrations",
  ]),
});

export function isMissingRpcError(error) {
  const code = String(error?.code || error?.status || "");
  const message = String(error?.message || error || "");
  return code === "PGRST202" || code === "42883" || /could not find the function|does not exist/i.test(message);
}

export function isAnalyticsAuthorizationError(error) {
  return String(error?.code || error?.status || "") === "42501";
}

// BUG-UG-WEB-ANALYTICS-TIMEOUT-WORDED-AS-GENERIC-FAILURE-20261002: a
// statement timeout is not a broken read. The desk words it as "took too long".
export function isStatementTimeoutError(error) {
  return String(error?.code || "") === "57014" || /statement timeout/i.test(String(error?.message || ""));
}

export function analyticsAuthorizationReason(error) {
  return /mfa required/i.test(String(error?.message || error || ""))
    ? "mfa_required"
    : "authorization_required";
}

// BUG-UG-TAMARACK-WEB-ANALYTICS-FULL-RUN-FAILURE-CAUSE-20261021: a
// read the database never answered is tried once more. The browser drops an
// in-flight request when the network changes (net::ERR_NETWORK_CHANGED,
// status 0), and a gateway can fail before PostgREST runs anything (a 502 or
// 503 with no database code, or PostgREST's own connection and pool errors).
// supabase-js retries only GET, HEAD and OPTIONS, and these reads are RPC POSTs,
// so one dropped request left "These charts could not load" until the person
// pressed Try again. A database error, a refusal and a timeout are not retried,
// nor is a codeless 504: a gateway timeout does not prove the read never
// started. The retry is skipped when it could not finish before the load's
// deadline, whose result would be discarded anyway.
const TRANSPORT_RETRY_DELAY_MS = 250;
const UNSERVED_GATEWAY_STATUSES = new Set([502, 503]);
const POSTGREST_UNSERVED_CODES = new Set(["PGRST000", "PGRST001", "PGRST002", "PGRST003"]);

export function isTransientTransportFailure(result) {
  const error = result?.error;
  if (!error) return false;
  const code = String(error.code || "");
  if (result.status === 0) return !code && !/^(AbortError|TimeoutError)\b/.test(String(error.message || ""));
  if (POSTGREST_UNSERVED_CODES.has(code)) return true;
  return UNSERVED_GATEWAY_STATUSES.has(result.status) && !code;
}

function retryFits(deadlineAt) {
  return deadlineAt == null || Date.now() + TRANSPORT_RETRY_DELAY_MS < deadlineAt;
}

// Both reads of one load share a signal that aborts at the load's deadline
// (#5639 final round): a read, first or retried, never keeps its request open
// after the desk has stopped waiting for it. postgrest-js reports the abort as
// an AbortError, which is never retried.
export function abortAtDeadline(deadlineAt) {
  if (deadlineAt == null || typeof AbortController !== "function") return { signal: null, release() {} };
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), Math.max(0, deadlineAt - Date.now()));
  return { signal: controller.signal, release: () => globalThis.clearTimeout(timer) };
}

export function withAbortSignal(query, signal) {
  return signal && typeof query?.abortSignal === "function" ? query.abortSignal(signal) : query;
}

// The read stays a literal .rpc( call at each site, so the read-RPC drift guard
// (scripts/lib/pr1815-read-rpc-drift.mjs) still resolves its name.
// A read the deadline stopped (our own abort) or a dropped read with no time
// left is marked deadlineReached and worded "took too long", the same as the
// adapter's own timeout
// (BUG-UG-TAMARACK-ANALYTICS-DEADLINE-ABORT-SHOWS-FAILED-NOT-TIMED-OUT-20261021).
// An answer the database delivered (a refusal, a missing function, any coded
// error) keeps its own meaning even when it arrives after the deadline.
function isAbortResult(result) {
  return result?.status === 0 && !result.error?.code && /^AbortError\b/.test(String(result.error?.message || ""));
}

async function readOnceMoreIfUnserved(read, deadlineAt = null) {
  const deadline = abortAtDeadline(deadlineAt);
  const reached = () => Boolean(deadline.signal?.aborted) || (deadlineAt != null && Date.now() >= deadlineAt);
  const deadlineCaused = (result) => (isAbortResult(result) && Boolean(deadline.signal?.aborted))
    || (isTransientTransportFailure(result) && reached());
  const settle = (result) => (result?.error && deadlineCaused(result) ? { ...result, deadlineReached: true } : result);
  try {
    const first = await read(deadline.signal);
    if (!isTransientTransportFailure(first) || !retryFits(deadlineAt)) return settle(first);
    await new Promise((resolve) => { globalThis.setTimeout(resolve, TRANSPORT_RETRY_DELAY_MS); });
    if (reached()) return settle(first);
    return settle(await read(deadline.signal));
  } finally {
    deadline.release();
  }
}

function uniqueRoles(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((role) => ORGANIZATION_ROLES.includes(role)))];
}

export function buildMi1AnalyticsActor(input = {}) {
  const {
  userId = null,
  organizationId = null,
  chapterId = null,
  roles = [],
  organizationRoles,
  chapterRoles = [],
  membershipStatus = organizationId ? "active" : null,
  organizationStatus = organizationId ? "active" : null,
  mfaSatisfied = false,
  selectedHat = "member",
  } = input;
  const orgRoles = uniqueRoles(Array.isArray(organizationRoles) ? organizationRoles : roles);
  const chapterGrantRoles = uniqueRoles(chapterRoles);
  return Object.freeze({
    userId: userId || null,
    organizationId: organizationId || null,
    selectedOrganizationId: organizationId || null,
    chapterId: chapterId || null,
    roles: Object.freeze(uniqueRoles(roles)),
    organizationRoles: Object.freeze(orgRoles),
    chapterRoles: Object.freeze(chapterGrantRoles),
    membershipStatus: membershipStatus || (organizationId ? "active" : "inactive"),
    organizationStatus: organizationStatus || (organizationId ? "active" : null),
    mfaSatisfied: Boolean(mfaSatisfied),
    selectedHat: selectedHat || "member",
    authenticated: Boolean(userId),
    role: selectedHat === "member" ? (orgRoles[0] || null) : selectedHat,
  });
}

export async function loadOrganizationSessionScope(client) {
  if (!client?.rpc) {
    return { organizationId: null, chapterId: null, organizationRoles: [], chapterRoles: [], unavailable: true };
  }
  try {
    const { data, error } = await client.rpc("get_my_chapter_memberships");
    if (error) {
      return { organizationId: null, chapterId: null, organizationRoles: [], chapterRoles: [], unavailable: true };
    }
    const memberships = Array.isArray(data) ? data : [];
    const selected = memberships.find((row) => row?.selected) || null;
    return {
      organizationId: selected?.organizationId || null,
      chapterId: selected?.chapterId || null,
      organizationRoles: uniqueRoles(selected?.organizationRoles),
      chapterRoles: uniqueRoles(selected?.chapterRoles),
      unavailable: false,
    };
  } catch {
    return { organizationId: null, chapterId: null, organizationRoles: [], chapterRoles: [], unavailable: true };
  }
}

export function mergeMi1AnalyticsScope(actor, scope = {}) {
  const authoritativeScope = scope?.unavailable === false;
  return buildMi1AnalyticsActor({
    ...actor,
    organizationId: authoritativeScope
      ? scope.organizationId
      : actor?.organizationId || actor?.selectedOrganizationId || scope.organizationId,
    chapterId: authoritativeScope ? scope.chapterId : actor?.chapterId || scope.chapterId,
    organizationRoles: authoritativeScope ? scope.organizationRoles : actor?.organizationRoles,
    chapterRoles: authoritativeScope ? scope.chapterRoles : actor?.chapterRoles,
    membershipStatus: authoritativeScope ? (scope.organizationId ? "active" : "inactive") : actor?.membershipStatus,
    organizationStatus: authoritativeScope ? (scope.organizationId ? "active" : null) : actor?.organizationStatus,
  });
}

export function useMi1AnalyticsActor(client, actor) {
  const rolesKey = JSON.stringify(uniqueRoles(actor?.roles));
  const organizationRolesKey = JSON.stringify(uniqueRoles(actor?.organizationRoles));
  const chapterRolesKey = JSON.stringify(uniqueRoles(actor?.chapterRoles));
  const stableActor = useMemo(() => buildMi1AnalyticsActor({
    userId: actor?.userId,
    organizationId: actor?.organizationId || actor?.selectedOrganizationId,
    chapterId: actor?.chapterId,
    roles: JSON.parse(rolesKey),
    organizationRoles: JSON.parse(organizationRolesKey),
    chapterRoles: JSON.parse(chapterRolesKey),
    membershipStatus: actor?.membershipStatus,
    organizationStatus: actor?.organizationStatus,
    mfaSatisfied: actor?.mfaSatisfied,
    selectedHat: actor?.selectedHat,
  }), [actor?.chapterId, actor?.membershipStatus, actor?.mfaSatisfied, actor?.organizationId, actor?.organizationStatus, actor?.selectedHat, actor?.selectedOrganizationId, actor?.userId, chapterRolesKey, organizationRolesKey, rolesKey]);
  const [scoped, setScoped] = useState(() => mergeMi1AnalyticsScope(stableActor));
  useEffect(() => {
    let active = true;
    setScoped(mergeMi1AnalyticsScope(stableActor));
    loadOrganizationSessionScope(client).then((scope) => {
      if (!active) return;
      setScoped(mergeMi1AnalyticsScope(stableActor, scope));
    });
    return () => {
      active = false;
    };
  }, [client, stableActor]);
  return scoped;
}

export function createAnalyticsSnapshotLoader(client) {
  return async function fetchSnapshot(_viewer, { deadlineAt = null } = {}) {
    if (!client?.rpc) return null;
    const { data, error, deadlineReached } = await readOnceMoreIfUnserved((signal) => withAbortSignal(client.rpc(ANALYTICS_REQUESTED_RPCS.snapshot), signal), deadlineAt);
    if (error) {
      if (deadlineReached) return { error: "timed_out" };
      if (isMissingRpcError(error)) return null;
      if (isAnalyticsAuthorizationError(error)) return { unavailable: true, reason: analyticsAuthorizationReason(error) };
      if (isStatementTimeoutError(error)) return { error: "timed_out" };
      return { error: "snapshot_failed" };
    }
    return data || null;
  };
}

export function createAnalyticsWorkspaceLoader(client) {
  return async function fetchWorkspace(_viewer, { deadlineAt = null } = {}) {
    if (!client?.rpc) return null;
    const { data, error, deadlineReached } = await readOnceMoreIfUnserved((signal) => withAbortSignal(client.rpc(ANALYTICS_REQUESTED_RPCS.workspace), signal), deadlineAt);
    if (error) {
      if (deadlineReached) return { error: "timed_out" };
      if (isMissingRpcError(error)) return null;
      if (isAnalyticsAuthorizationError(error)) return { unavailable: true, reason: analyticsAuthorizationReason(error) };
      if (isStatementTimeoutError(error)) return { error: "timed_out" };
      return { error: "workspace_failed" };
    }
    return data || null;
  };
}

export function createAnalyticsLayoutSaver(client) {
  return async function saveLayout({ id = null, name, scope, chapterId = null, spec, idempotencyKey } = {}) {
    if (!client?.rpc) throw new Error("analytics layout unavailable");
    const { data, error } = await client.rpc(ANALYTICS_REQUESTED_RPCS.saveLayout, {
      p_layout_id: id,
      p_name: name,
      p_scope: scope,
      p_chapter_id: chapterId,
      p_spec: spec,
      p_idempotency_key: idempotencyKey,
    });
    if (error) throw error;
    if (!data?.id || !data?.spec) throw new Error("analytics layout receipt invalid");
    return data;
  };
}

export function createAnalyticsLayoutDeleter(client) {
  return async function deleteLayout({ id, idempotencyKey } = {}) {
    if (!client?.rpc) throw new Error("analytics layout unavailable");
    const { data, error } = await client.rpc(ANALYTICS_REQUESTED_RPCS.deleteLayout, {
      p_layout_id: id,
      p_idempotency_key: idempotencyKey,
    });
    if (error) throw error;
    if (!data?.id || data?.deleted !== true) throw new Error("analytics layout delete receipt invalid");
    return data;
  };
}

export function createAnalyticsExportRequester(client) {
  return async function requestExport({ format = "csv", snapshotId = null, rowCount = 0, suppressedCount = 0 } = {}) {
    if (!client?.rpc) throw new Error("analytics export unavailable");
    // The receipt counts are derived by the server from the snapshot it
    // issued. A snapshot without an id comes from a database that predates
    // 20260925160000, which still takes the legacy count-carrying signature.
    const { data, error } = await client.rpc(ANALYTICS_REQUESTED_RPCS.export, snapshotId
      ? { p_format: format, p_snapshot_id: snapshotId }
      : { p_format: format, p_row_count: rowCount, p_suppressed_count: suppressedCount });
    if (error) throw error;
    if (!data?.id || !data?.expiresAt) throw new Error("analytics export receipt invalid");
    return data;
  };
}

export function createWiredAnalyticsAdapter(client) {
  return createAnalyticsCoreAdapter({
    fetchSnapshot: createAnalyticsSnapshotLoader(client),
    fetchWorkspace: createAnalyticsWorkspaceLoader(client),
    saveLayout: createAnalyticsLayoutSaver(client),
    deleteLayout: createAnalyticsLayoutDeleter(client),
    requestExport: createAnalyticsExportRequester(client),
  });
}

export const MI1_ANALYTICS_DATABASE_DEPENDENCIES = Object.freeze({
  owner: "X-DB",
  rpcs: Object.freeze(Object.values(ANALYTICS_REQUESTED_RPCS)),
  tables: ANALYTICS_REQUESTED_TABLES,
});
