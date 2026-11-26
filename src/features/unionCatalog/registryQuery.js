// Shared nationwide union registry query contract for public discovery, chapter
// identity and native setup. Transport and authorization remain with each caller.

export const REGISTRY_SEARCH_MIN_LENGTH = 2;

export function unionOrganizationSearchPattern(query) {
  const needle = String(query || "").trim();
  if (needle.length < REGISTRY_SEARCH_MIN_LENGTH) return null;
  const escaped = needle
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_")
    .replaceAll("*", "");
  return `%${escaped}%`;
}

const REGISTRY_TABLE = "union_orgs";
export const REGISTRY_PAGE_SIZE = 20;
export const REGISTRY_MAX_PAGES = 50;
const REGISTRY_SELECT =
  "id,name,affiliation,designation,local_number,level,city,state,website,members_latest,members_latest_year,parent_name";

export const REGISTRY_LEVELS = Object.freeze(["local", "intermediate", "national", "unknown"]);

// Two-letter postal codes present in the registry (50 states, DC and the
// territories the Department of Labor files carry). "00" is the Atlas sentinel
// for an unrecorded state and is never offered as a filter.
export const REGISTRY_STATES = Object.freeze([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY",
  "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH",
  "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "PR", "VI", "GU", "AS", "MP",
]);

// Affiliation codes with at least 100 registry rows, measured against the
// production registry on 2026-09-24. The codes are the Atlas's own; the Phase 2
// catalog replaces this list with union families carried by the data itself.
const REGISTRY_AFFILIATIONS = Object.freeze([
  "AFGE", "AFM", "AFSCME", "AFT", "ALPA", "APWU", "ATU", "BBF", "BCTD", "BCTGMI", "BLE", "BMWE", "BRS", "BSOIW",
  "CJA", "CWA", "IAFF", "IAM", "IATSE", "IBEW", "IBT", "ILA", "ILWU", "LIUNA", "NAGE", "NALC", "NAPFE", "NATCA",
  "NTEU", "NWSEO", "PAT", "PPF", "RLCA", "SEIU", "SMART", "SPFPA", "TCU/IAM", "UAW", "UFCW", "UGSOA", "UMW",
  "UNAFF", "USW", "UWU", "WU",
]);

const LOCAL_NUMBER_PATTERN = /(?:^|\s)(?:local|lu|lodge|branch|br|chapter|ch|division|div)\s*#?\s*(\d{1,7})(?=\s|$)/i;
const BARE_NUMBER_PATTERN = /^#?(\d{1,7})$/;

// "Local 600" -> { localNumber: "600", text: "" }; "lu 12 boston" -> { "12", "boston" };
// a bare number is a local number too. Text under two characters is dropped,
// because the pattern helper below refuses it anyway.
export function parseRegistryQuery(raw) {
  const collapsed = String(raw || "").replace(/\s+/g, " ").trim();
  if (!collapsed) return { localNumber: "", text: "" };
  const bare = collapsed.match(BARE_NUMBER_PATTERN);
  if (bare) return { localNumber: String(Number(bare[1])), text: "" };
  const match = collapsed.match(LOCAL_NUMBER_PATTERN);
  if (!match) return { localNumber: "", text: collapsed.length >= REGISTRY_SEARCH_MIN_LENGTH ? collapsed : "" };
  const localNumber = String(Number(match[1]));
  const text = collapsed.replace(match[0], " ").replace(/\s+/g, " ").trim();
  return { localNumber, text: text.length >= REGISTRY_SEARCH_MIN_LENGTH ? text : "" };
}

// Inside PostgREST's `or=(...)` list a value is double-quoted so commas, dots
// and parentheses in the visitor's text cannot add filters. Within the quotes
// `\` and `"` are escaped, and the LIKE-escaping the pattern already carries
// (`\%`, `\_`) is preserved by that same backslash doubling.
export function quotedFilterValue(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function normalizeRegistryFilters(input = {}) {
  const state = REGISTRY_STATES.includes(input.state) ? input.state : "";
  const affiliation = REGISTRY_AFFILIATIONS.includes(input.affiliation) ? input.affiliation : "";
  const level = REGISTRY_LEVELS.includes(input.level) ? input.level : "";
  const page = Number.isInteger(input.page) && input.page >= 0 && input.page < REGISTRY_MAX_PAGES ? input.page : 0;
  return { state, affiliation, level, page };
}

// A search needs at least one of: two characters of text, a local number, or a
// filter. Otherwise nothing is sent (the honest empty state stays up).
export function registrySearchPlan(rawQuery, filters = {}) {
  const { localNumber, text } = parseRegistryQuery(rawQuery);
  const normalized = normalizeRegistryFilters(filters);
  const pattern = text ? unionOrganizationSearchPattern(text) : null;
  // A few dozen registry rows carry their number only in `name` ("TEXTILE
  // PROCESSORS LOCAL 1") with an empty local_number, so the whole typed query
  // is also offered to `name` whenever a local number was parsed out of it.
  const fullPattern = localNumber ? unionOrganizationSearchPattern(String(rawQuery || "").replace(/\s+/g, " ").trim()) : null;
  const searchable = Boolean(pattern || localNumber || normalized.state || normalized.affiliation || normalized.level);
  return { ...normalized, localNumber, text, pattern, fullPattern, searchable };
}

export function buildRegistryQuery(client, plan) {
  if (!client || !plan?.searchable) return null;
  let query = client.from(REGISTRY_TABLE).select(REGISTRY_SELECT, { count: "exact" });
  if (plan.localNumber) {
    query = plan.fullPattern
      ? query.or(`local_number.eq.${quotedFilterValue(plan.localNumber)},name.ilike.${quotedFilterValue(plan.fullPattern)}`)
      : query.eq("local_number", plan.localNumber);
  }
  if (plan.pattern) {
    // Affiliation codes ("SEIU", "UFCW") are what people type first, and the
    // registry keeps them in their own column, never in `name`.
    const quoted = quotedFilterValue(plan.pattern);
    query = query.or(`name.ilike.${quoted},city.ilike.${quoted},affiliation.ilike.${quoted}`);
  }
  if (plan.state) query = query.eq("state", plan.state);
  if (plan.affiliation) query = query.eq("affiliation", plan.affiliation);
  if (plan.level) query = query.eq("level", plan.level);
  const from = plan.page * REGISTRY_PAGE_SIZE;
  return query.order("name").order("local_number", { nullsFirst: false }).order("id").range(from, from + REGISTRY_PAGE_SIZE - 1);
}
