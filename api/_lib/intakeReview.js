// The platform operator's intake queue (REQ-UNIONGROUND-INTAKE-QUEUE-STORE-
// INVITE-REQUESTS-AND-OPERATOR-READ-20261118): the people who asked Union
// Ground for updates, an invite, to join or for their union to join. An
// invite request can be passed to an organization's administrators as an
// invitation suggestion (REQ-UNIONGROUND-INTAKE-QUEUE-SEND-INVITATION-FROM-ROW-
// 20261118, owner option b): the operator never sends an invitation. The
// browser names an action and
// its filters; this module turns that into exactly one service-only RPC. The
// database decides whether the caller is an intake_review operator on a live
// stepped-up session and reads only Union Ground's own rows.

import { UUID } from "./serviceRpc.js";

export const INVITE_REQUEST_PASS_PATH = "invite-request-pass";

// "union" is a member asking for their union to join (/ask-your-union,
// REQ-UG-MEMBER-ASKS-THEIR-UNION-TO-JOIN-20261118).
export const INTAKE_KINDS = Object.freeze(["updates", "join", "invite", "union"]);
export const INTAKE_STATUSES = Object.freeze(["new", "contacted", "invited", "closed"]);

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

function hasControl(value, allowed = "") {
  return [...value].some((character) => {
    if (allowed.includes(character)) return false;
    const code = character.charCodeAt(0);
    // C0, DEL and C1: the same set the database rejects with [[:cntrl:]].
    return code < 32 || (code >= 127 && code <= 159);
  });
}

// undefined means invalid; null means absent.
function optionalChoice(value, choices) {
  if (value === undefined || value === null || value === "") return null;
  return choices.includes(value) ? value : undefined;
}

function search(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return null;
  if ([...text].length > 120 || hasControl(text)) return undefined;
  return text;
}

function filters(body) {
  const kind = optionalChoice(body.kind, INTAKE_KINDS);
  const status = optionalChoice(body.status, INTAKE_STATUSES);
  const text = search(body.search);
  if (kind === undefined || status === undefined || text === undefined) return null;
  return { p_kind: kind, p_status: status, p_search: text };
}

/**
 * The one RPC for this action, or null when the body is not a valid request.
 * The route adds p_operator_session_id from the caller's own token.
 */
export function intakeReviewPlan(body, operatorId) {
  if (!body || typeof body !== "object" || !UUID.test(String(operatorId || ""))) return null;
  const operator = { p_operator_user_id: operatorId };
  switch (body.action) {
    case "summary":
      return { rpc: "intake_request_summary", args: operator };
    case "list": {
      const shared = filters(body);
      if (!shared) return null;
      const before = body.before ?? null;
      const beforeId = body.beforeId ?? null;
      if ((before === null) !== (beforeId === null)) return null;
      if (before !== null && (typeof before !== "string" || !ISO_INSTANT.test(before) || Number.isNaN(Date.parse(before)))) return null;
      if (beforeId !== null && !UUID.test(String(beforeId))) return null;
      const limit = body.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return null;
      return { rpc: "list_intake_requests", args: { ...operator, ...shared, p_before: before, p_before_id: beforeId, p_limit: limit } };
    }
    case "export": {
      const shared = filters(body);
      return shared ? { rpc: "export_intake_requests", args: { ...operator, ...shared } } : null;
    }
    case "status": {
      if (!UUID.test(String(body.id || ""))) return null;
      if (!INTAKE_STATUSES.includes(body.status)) return null;
      const expected = optionalChoice(body.expectedStatus, INTAKE_STATUSES);
      if (expected === undefined) return null;
      return { rpc: "set_intake_request_status", args: { ...operator, p_id: body.id, p_status: body.status, p_expected_status: expected } };
    }
    case "note": {
      if (!UUID.test(String(body.id || ""))) return null;
      if (body.note !== null && typeof body.note !== "string") return null;
      const note = String(body.note ?? "").replace(/\r\n?/g, "\n").trim();
      if ([...note].length > 2000 || hasControl(note, "\n\t")) return null;
      return { rpc: "set_intake_request_note", args: { ...operator, p_id: body.id, p_note: note } };
    }
    case "organizations": {
      if (typeof body.search !== "string") return null;
      const text = body.search.trim();
      if ([...text].length < 2 || [...text].length > 120 || hasControl(text)) return null;
      return { rpc: "search_intake_pass_organizations", args: { ...operator, p_prefix: text } };
    }
    case "pass": {
      if (!UUID.test(String(body.id || "")) || !UUID.test(String(body.organizationId || ""))) return null;
      return { rpc: "pass_intake_invite_request", args: { ...operator, p_id: body.id, p_organization_id: body.organizationId } };
    }
    case "founder": {
      if (!UUID.test(String(body.id || ""))) return null;
      if (typeof body.organizationName !== "string" || typeof body.fullName !== "string") return null;
      const organization = body.organizationName.trim();
      const name = body.fullName.trim();
      if ([...organization].length < 2 || [...organization].length > 120 || hasControl(organization)
          || [...name].length < 2 || [...name].length > 120 || hasControl(name)) return null;
      return { rpc: "create_intake_founder_invitation", args: { ...operator, p_id: body.id,
        p_organization_name: organization, p_full_name: name } };
    }
    case "passes": {
      const ids = body.ids;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100) return null;
      if (!ids.every((id) => typeof id === "string" && UUID.test(id))) return null;
      return { rpc: "list_intake_request_passes", args: { ...operator, p_ids: [...new Set(ids.map((id) => id.toLowerCase()))] } };
    }
    default:
      return null;
  }
}

const REFUSAL_SLUGS = new Map([
  ["invalid kind", "invalid-kind"],
  ["invalid status", "invalid-status"],
  ["invalid search", "invalid-search"],
  ["invalid page size", "invalid-page-size"],
  ["cursor needs both parts", "invalid-cursor"],
  ["invalid note", "invalid-note"],
  ["request id required", "invalid-request"],
  ["organization id required", "invalid-organization"],
  ["invalid request ids", "invalid-request"],
]);

// 403 only for the database's own verdict that the caller is not an intake
// reviewer; 409 with a stable slug for a refusal the database decided; 503
// for everything else (any other 42501 is a misconfigured deployment, not a
// verdict on the caller; a transport failure; a 5xx).
export function intakeReviewFailure(error) {
  const code = error?.code;
  const detail = String(error?.detail || "");
  if (code === "42501" && detail === "intake reviewer required") {
    return { status: 403, body: { error: "not-permitted" } };
  }
  if (code === "22023") {
    if (detail === "invalid founder invitation" && error?.token === "organization name holds a phone number") {
      return { status: 409, body: { error: "refused", reason: "organization-name-phone" } };
    }
    return { status: 409, body: { error: "refused", reason: REFUSAL_SLUGS.get(detail) || "invalid" } };
  }
  return { status: 503, body: { error: "review-unavailable" } };
}
