import { isUuid } from "./controlPlane.js";
import { automationAccess } from "./access.js";
import { TAB_PAGE_GROUPS } from "../../lib/workspacePages.js";

export function validAutomationSource(kind, id) {
  return ["task", "case", "appointment", "event"].includes(kind) && typeof id === "string"
    && (kind === "event" ? /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id) : isUuid(id));
}

export function automationContextFromSearch(search) {
  const query = new URLSearchParams(search);
  const sourceKind = query.get("sourceKind"), sourceId = query.get("sourceId");
  return validAutomationSource(sourceKind, sourceId) ? { sourceKind, sourceId } : null;
}

export function automationWorkflowHref(session, sourceKind, sourceId) {
  // A user's admin membership is not permission to silently choose that hat.
  if (!automationAccess(session).canAuthor
    || !Array.isArray(session.organizationRoles) || !session.organizationRoles.includes(session.selectedHat)
    || !validAutomationSource(sourceKind, sourceId)) return null;
  const group = TAB_PAGE_GROUPS.automation;
  const query = new URLSearchParams({ sourceKind, sourceId });
  return `${group.base}/recipes?${query}`;
}

const LEGACY_AUTOMATION_TABS = new Set(TAB_PAGE_GROUPS.automation.tabs.filter((tab) => tab !== "discover"));
const AUTOMATION_QUERY_KEYS = Object.freeze(["demo", "embed", "sourceKind", "sourceId", "definition", "run"]);

export function canonicalAutomationPath(pathname, search = "", hash = "") {
  const normalizedPath = String(pathname || "").replace(/\/+$/, "");
  const legacyHashHat = normalizedPath.match(/^\/m\/(admin|vp)$/)?.[1];
  const fromLegacyHash = legacyHashHat && hash === `#${legacyHashHat}-automation-control`;
  const match = fromLegacyHash
    ? [normalizedPath, "discover"]
    : normalizedPath.match(/^\/m\/(?:admin|vp)\/automations(?:\/([^/]+))?$/);
  if (!match) return null;
  const tab = match[1] || "discover";
  if (tab !== "discover" && !LEGACY_AUTOMATION_TABS.has(tab)) return null;
  const incoming = new URLSearchParams(search);
  const outgoing = new URLSearchParams();
  for (const key of AUTOMATION_QUERY_KEYS) if (incoming.has(key)) outgoing.set(key, incoming.get(key));
  return `/m/automations/${tab}${outgoing.size ? `?${outgoing}` : ""}`;
}

// The staff case surfaces that open one case by its exact reference. Member
// Cases (/m/cases) is a member's own-case page and fenced against staff hats, so
// a case source is only offered where the explicitly selected staff hat has a
// surface of its own; every other hat is offered no usable link.
const STAFF_CASE_SURFACES = Object.freeze({ steward: "/m/steward", coordinator: "/m/coordinator" });

export function automationSourceHref(effect, selectedHat = null) {
  if (effect?.sourceAvailable !== true) return null;
  const caseChild = ["casework_deadline", "case_checklist"].includes(effect.sourceKind);
  const kind = caseChild ? "case" : effect.sourceKind;
  const id = caseChild ? effect.caseId : effect.sourceId;
  if (!validAutomationSource(kind, id)) return null;
  if (kind === "case") {
    const surface = Object.hasOwn(STAFF_CASE_SURFACES, selectedHat) ? STAFF_CASE_SURFACES[selectedHat] : null;
    return surface ? `${surface}?${new URLSearchParams({ case: id })}` : null;
  }
  const destinations = { task: ["/m/tasks/board", "task"], appointment: ["/m/appointments", "appointment"], event: ["/m/events", "event"] };
  const [path, key] = destinations[kind];
  return `${path}?${new URLSearchParams({ [key]: id })}`;
}

export function automationEffectHref(effect) {
  return effect?.effectAvailable === true && isUuid(effect.taskId) ? `/m/tasks/board?${new URLSearchParams({ task: effect.taskId })}` : null;
}
