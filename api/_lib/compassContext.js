import { supabaseRpc } from "./http.js";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SCOPE_LEVELS = new Set(["local", "agency", "unit", "chapter"]);

// Context and its tenant label are read in one database transaction as the
// member, under the same identity lock used by reservation/dispatch.
export async function readCompassContext(url, key, token, kind, args = {}) {
  const envelope = await supabaseRpc(url, key, token, "get_compass_ai_context", { p_kind: kind, p_args: args });
  if (!envelope || !Object.hasOwn(envelope, "data") || !Object.hasOwn(envelope, "organization_id")
    || envelope.organization_id !== null && !UUID.test(envelope.organization_id)) {
    throw new Error("context scope unavailable");
  }
  if (Object.hasOwn(envelope, "scope")) {
    const scope = envelope.scope;
    if (!scope || Array.isArray(scope) || scope.version !== "compass-scope-v1"
      || scope.organization_id !== envelope.organization_id || typeof scope.local_fallback !== "boolean"
      || !Array.isArray(scope.matching_organization_ids) || scope.matching_organization_ids.length > 10
      || new Set(scope.matching_organization_ids).size !== scope.matching_organization_ids.length
      || scope.matching_organization_ids.some((id) => typeof id !== "string" || !UUID.test(id) || id === envelope.organization_id)) {
      throw new Error("context scope unavailable");
    }
    if (["lexical", "hybrid"].includes(kind) && (!Array.isArray(envelope.data)
      || envelope.data.some((source) => String(source?.source_id || "").startsWith("kb:")
        && (!UUID.test(source.organization_id || "") || source.organization_id !== envelope.organization_id || !SCOPE_LEVELS.has(source.scope_level))))) {
      throw new Error("context scope unavailable");
    }
    if (["lexical", "hybrid"].includes(kind)) {
      const knowledge = envelope.data.filter((source) => String(source?.source_id || "").startsWith("kb:"));
      if (scope.local_fallback !== (knowledge.length > 0 && knowledge.every((source) => source.scope_level === "local"))) {
        throw new Error("context scope unavailable");
      }
    }
  }
  // Legacy chapter-scoped envelopes remain usable during the owner rollout.
  // Any supplied source tenant must agree even before the new scope version.
  if (["lexical", "hybrid"].includes(kind) && Array.isArray(envelope.data)
    && envelope.data.some((source) => source && Object.hasOwn(source, "organization_id")
      && source.organization_id !== envelope.organization_id)) throw new Error("context scope unavailable");
  return envelope;
}

export function compassScopeNotices(envelope) {
  const scope = envelope?.scope;
  if (!scope) return [];
  return [
    scope.local_fallback ? "local_fallback" : null,
    scope.matching_organization_ids.length ? "other_organization" : null,
  ].filter(Boolean);
}

export function compassContextMatches(envelope, dispatch) {
  return Boolean(envelope && Object.hasOwn(dispatch || {}, "organization_id")
    && envelope.organization_id === dispatch.organization_id);
}
