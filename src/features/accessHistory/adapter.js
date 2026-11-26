import { authorizeAccessHistory } from "./authorization.js";
import { isRecordableAccessWrite, normalizeAccessEvent } from "./event.js";
import { accessFailure } from "./errors.js";

function catalogUnavailable() {
  return accessFailure("catalog_unavailable");
}

// The RPCs raise 42501 'mfa required' when private.mfa_satisfied() is false
// (an aal1 session, an MFA recovery lock, or a session older than an MFA
// reset). Retrying cannot clear that, so it keeps its own reason.
function isMfaRefusal(error) {
  return String(error?.code || "") === "42501" && /mfa required/i.test(String(error?.message || ""));
}

function nextId(store) {
  return `access-${store.size + 1}`;
}

const DEFAULT_RANGE_DAYS = 90;

export function createMemoryAccessCatalog(initial = []) {
  const store = new Map();

  function load(records) {
    for (const record of records) {
      const event = normalizeAccessEvent(record);
      if (!event) continue;
      const id = event.id || nextId(store);
      store.set(id, { ...event, id });
    }
  }

  load(initial);

  return {
    listOwn(actor, { rangeDays = DEFAULT_RANGE_DAYS, since = null } = {}) {
      const organizationId = actor?.selectedOrganizationId;
      const auth = authorizeAccessHistory({
        actor,
        organizationId,
        capability: "read_own",
      });
      if (!auth.ok) return auth;
      const events = [...store.values()]
        .filter((row) => row.organizationId === auth.organizationId)
        .filter((row) => row.subjectUserId === auth.subjectUserId)
        .filter((row) => !since || row.occurredAt >= since)
        .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
      return { ok: true, organizationId: auth.organizationId, rangeDays, events };
    },
    record(actor, record) {
      const event = normalizeAccessEvent({
        ...record,
        organizationId: record.organizationId || actor?.selectedOrganizationId,
        actorUserId: record.actorUserId || actor?.userId,
      });
      if (!event || !isRecordableAccessWrite(event)) {
        return accessFailure("invalid_input", { field: "event" });
      }
      const auth = authorizeAccessHistory({
        actor,
        organizationId: event.organizationId,
        capability: "record",
        subjectUserId: event.subjectUserId,
      });
      if (!auth.ok) return auth;
      const id = event.id || nextId(store);
      const saved = { ...event, id };
      store.set(id, saved);
      return {
        ok: true,
        event: saved,
        audit: {
          action: "record",
          organizationId: saved.organizationId,
          entityType: saved.entityType,
        },
      };
    },
    clear() {
      store.clear();
    },
  };
}

export function createAccessCatalogFromRpcPayload(rows) {
  if (!Array.isArray(rows)) return catalogUnavailable();
  const events = rows.map(normalizeAccessEvent).filter(Boolean);
  return { ok: true, catalog: createMemoryAccessCatalog(events), events };
}

export function createAccessRpcAdapter(client) {
  async function call(name, args) {
    if (!client?.rpc) return catalogUnavailable();
    try {
      const { data, error } = await client.rpc(name, args);
      if (error) return isMfaRefusal(error) ? accessFailure("mfa_required") : catalogUnavailable();
      return { ok: true, value: data };
    } catch {
      return catalogUnavailable();
    }
  }

  return Object.freeze({
    async listOwn(rangeDays = DEFAULT_RANGE_DAYS) {
      const listed = await call("list_my_access_history", { p_range_days: rangeDays });
      if (!listed.ok) return listed.reason === "mfa_required" ? listed : catalogUnavailable();
      return createAccessCatalogFromRpcPayload(listed.value);
    },
    async record(actor, record) {
      if (!isRecordableAccessWrite(record)) return accessFailure("invalid_input", { field: "event" });
      const auth = authorizeAccessHistory({
        actor,
        organizationId: actor?.selectedOrganizationId,
        capability: "record",
        subjectUserId: record.subjectUserId,
      });
      if (!auth.ok) return auth;
      return call("record_member_access_event", {
        p_expected_organization_id: actor.selectedOrganizationId,
        p_subject_user_id: record.subjectUserId,
        p_action: record.action,
        p_entity_type: record.entityType,
        p_entity_id: record.entityId || null,
      });
    },
  });
}

export const ACCESS_PERSISTENCE_CONTRACT = Object.freeze({
  migration: "20260828021500_mi1_member_access_history.sql",
  rpcs: ["list_my_access_history", "record_member_access_event"],
  requestedTables: ["member_access_events"],
  sessionOrganizationOnly: true,
  expectedOrganizationRequiredForWrites: true,
  seedPolicy: "empty_on_reset",
  anonAccess: false,
  serviceRoleInClient: false,
});
