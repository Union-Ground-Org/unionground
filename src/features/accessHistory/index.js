import { createMemoryAccessCatalog } from "./adapter.js";

export { ACCESS_RECORD_ROLES, ACCESS_CAPABILITIES, authorizeAccessHistory } from "./authorization.js";
export {
  ACCESS_PERSISTENCE_CONTRACT,
  createAccessCatalogFromRpcPayload,
  createAccessRpcAdapter,
  createMemoryAccessCatalog,
} from "./adapter.js";
export { ACCESS_ACTIONS, ACCESS_ENTITY_TYPES, normalizeAccessEvent } from "./event.js";
export { ACCESS_FAILURE_REASONS, accessFailure } from "./errors.js";
export {
  ACCESS_VIEW_STATES,
  presentAccessHistory,
  presentFailureMessage,
  presentLoading,
  presentRetry,
  presentMfaRequired,
} from "./presenters.js";
export { ACCESS_DONOR_BASELINE, ACCESS_DONOR_UNITS } from "./provenance.js";

export function createAccessHistory({ actor, catalog = createMemoryAccessCatalog() } = {}) {
  return {
    catalog,
    listOwn(options) {
      return catalog.listOwn(actor, options);
    },
    record(record) {
      return catalog.record(actor, record);
    },
  };
}
