// Find-your-union registry search (REQ-UG-FIND-YOUR-UNION-PUBLIC-REGISTRY-SEARCH-20260924).
//
// Pure helpers for the in-app union search (campaign affiliation and setup
// placement). They shape a query against
// public.union_orgs, the USUnions Union Atlas mirror that the chapter handshake
// already reads (20260726164045_union_orgs_registry.sql), and normalize the rows
// that come back. Nothing here touches a tenant, a session, or a write path:
// the table is anon-readable reference data about real labor organizations,
// and the page reads it through an anonymous client so the restrictive MFA
// policy on `authenticated` never hides rows from a signed-in visitor.
//
// Search shape, from the registry's own data: 17,435 of 20,699 rows carry the
// local number only in `local_number`, never in `name`, so "Local 600" or a
// bare number is read as a local-number filter and the rest of the text
// matches `name` or `city`. Names repeat heavily (one affiliation name covers
// 585 rows), so every result row is labelled with affiliation, designation,
// local number and city.
import { MemberApiError } from "../../lib/memberApiError.js";
import { buildRegistryQuery, registrySearchPlan, REGISTRY_LEVELS, REGISTRY_PAGE_SIZE, REGISTRY_MAX_PAGES } from "./registryQuery.js";
export { buildRegistryQuery, parseRegistryQuery, quotedFilterValue, normalizeRegistryFilters, registrySearchPlan, REGISTRY_LEVELS, REGISTRY_STATES, REGISTRY_PAGE_SIZE, REGISTRY_MAX_PAGES } from "./registryQuery.js";

function cleanText(value, max = 200) {
  if (typeof value !== "string") return "";
  const trimmed = value.replace(/\p{Cc}/gu, "").replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

// Only http(s) websites render as links; anything else is dropped, never
// repaired. The visible text is the host, so a visitor sees where the link goes.
export function websiteFromRow(value) {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!/^https?:\/\//i.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    if (url.username || url.password) return null;
    return { href: url.toString(), host: url.hostname.replace(/^www\./i, "") };
  } catch {
    return null;
  }
}

function integerOrNull(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function normalizeRegistryRow(row) {
  if (!row || typeof row !== "object" || typeof row.id !== "string" || typeof row.name !== "string") return null;
  const name = cleanText(row.name, 200);
  if (!name) return null;
  const state = typeof row.state === "string" && /^[A-Z]{2}$/.test(row.state) && row.state !== "00" ? row.state : null;
  const membersLatest = integerOrNull(row.members_latest);
  const membersYear = integerOrNull(row.members_latest_year);
  return {
    id: row.id,
    name,
    affiliation: cleanText(row.affiliation, 40) || null,
    designation: cleanText(row.designation, 20) || null,
    localNumber: cleanText(row.local_number, 20) || null,
    level: REGISTRY_LEVELS.includes(row.level) ? row.level : "unknown",
    city: cleanText(row.city, 120) || null,
    state,
    website: websiteFromRow(row.website),
    membersLatest: membersLatest != null && membersYear != null ? membersLatest : null,
    membersYear: membersLatest != null && membersYear != null ? membersYear : null,
    parentName: cleanText(row.parent_name, 200) || null,
  };
}

export async function searchRegistry(client, rawQuery, filters = {}) {
  const plan = registrySearchPlan(rawQuery, filters);
  const query = buildRegistryQuery(client, plan);
  if (!query) return { plan, rows: [], total: 0 };
  const { data, count, error } = await query;
  if (error) throw new MemberApiError("Union registry search", error);
  const rows = (Array.isArray(data) ? data : []).map(normalizeRegistryRow).filter(Boolean);
  const total = Number.isInteger(count) && count >= 0 ? count : rows.length;
  return { plan, rows, total };
}

export function registryPageCount(total) {
  if (!Number.isInteger(total) || total <= 0) return 0;
  return Math.min(REGISTRY_MAX_PAGES, Math.ceil(total / REGISTRY_PAGE_SIZE));
}
