// Union catalog reads for /unions (REQ-UG-UNION-CATALOG-PROFILE-DEPTH-20260924).
//
// Phase 2b of the union catalog design: the page asks the catalog read RPCs
// first and keeps the Phase 1 registry read (registrySearch.js, unchanged) as
// its fallback. Everything here is pure or a thin RPC wrapper; the three RPC
// names are declared once, statically, so the PR1815 read-RPC drift guard can
// see every call site. Nothing here writes, and nothing here ever carries a
// person field: the profile normalizer keeps only the organization-level facts
// the spec lets a signed-out visitor see (spec section 1.1 J1, 1.3, 4.6).
import { localeFor } from "../../lib/i18n/format.js";
import { MemberApiError } from "../../lib/memberApiError.js";
import { normalizeRegistryFilters, REGISTRY_LEVELS, websiteFromRow } from "./registrySearch.js";

const UNION_CATALOG_RPCS = Object.freeze({
  status: "get_union_catalog_status",
  search: "search_union_catalog",
  profile: "get_union_catalog_profile",
});

// The catalog key domain, exactly as the profile RPC and the
// private.catalog_organizations check constraint validate it. Anything else
// never reaches the network (spec 6.2, 6.3).
export const CATALOG_KEY_PATTERN = /^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$/;
// A catalog organization name may be long: the catalog holds registered union
// names of up to 1,000 characters (code points), never shortened (record #8743,
// migration 20261113133200). Sub-unit names keep their 200-character limit.
export const CATALOG_ORGANIZATION_NAME_MAX = 1000;

const CATALOG_PAGE_SIZE = 25;
const CATALOG_MAX_PAGES = 40;

const DESIGNATIONS = new Set([
  "LU", "BR", "LG", "DIV", "CH", "BCTC", "SLG", "LLG", "SA", "D", "LEADC", "DC", "NHQ", "LEC", "GCA", "SLB",
  "LBR", "LCH", "CAP", "LDIV", "STC", "SC", "CONF", "MEC", "JC", "RC", "SFED",
]);

const CONFIDENCES = new Set(["official_site", "secondary", "olms_filing", "not_found", "unreviewed"]);
const CERTAINTIES = new Set(["filed", "confirmed", "inferred", "split"]);
const RELATION_KINDS = new Set(["olms_parent", "parent_body", "regional_body", "state_body", "state_federation"]);
const SUBUNIT_KINDS = new Set([
  "chapter", "unit", "bargaining_unit", "retiree_chapter", "local", "district", "division", "region", "sector",
  "department", "council", "committee", "other",
]);
const SEAT_CLASSES = new Set(["officer", "board", "steward", "delegate"]);
const CONTACT_KINDS = new Set(["website", "social", "email", "phone", "office_address"]);
const DOCUMENT_KINDS = new Set(["contract", "bylaws", "form", "newsletter", "handbook", "other"]);
const COVERAGE_BANDS = new Set(["basic", "structured", "deep"]);

// Spec 4.6, in spec order. The activation function writes exactly these keys.
const COVERAGE_ITEMS = Object.freeze([
  "website", "publicContact", "structure", "seats", "governingDocument", "contract", "electionCadence", "hierarchy",
]);

// Numbered and place labels for a row from either source. They live here so
// the results list and the profile panel say the same thing about a row.
export function numberedLabel(t, row) {
  const designation = row.designation && DESIGNATIONS.has(row.designation)
    ? t(`unions.designation.${row.designation}`)
    : row.designation;
  if (row.localNumber) {
    return designation
      ? t("unions.numbered", { designation, number: row.localNumber })
      : t("unions.number", { number: row.localNumber });
  }
  return designation || null;
}

// Lengths are code points, so a name is never cut inside a character.
function cleanText(value, max = 200) {
  if (typeof value !== "string") return "";
  const trimmed = value.replace(/\p{Cc}/gu, "").replace(/\s+/g, " ").trim();
  const points = [...trimmed];
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : trimmed;
}

function integerOrNull(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function enumOrNull(set, value) {
  return typeof value === "string" && set.has(value) ? value : null;
}

// Calendar dates arrive as plain YYYY-MM-DD strings (already Eastern dates for
// the status RPC). Anything else is dropped rather than guessed.
export function dateOnly(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

// Formats a plain date without a day shift: the string is read as a UTC
// calendar date and printed as one, so 2026-09-24 never renders as the 23rd.
export function formatCatalogDate(value, lang) {
  const date = dateOnly(value);
  if (!date) return "";
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(localeFor(lang), { dateStyle: "medium", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day)));
}

// PostgREST answers PGRST202 when the function is not in its schema cache and
// Postgres answers 42883 when it does not exist. Both mean the hosted
// migration is pending. Nothing else does: 22023 is a bounds violation the
// client should have prevented, and a network failure is an outage. The
// message is never consulted, because a function body can raise the same words.
export function isMissingRpcError(error) {
  return error?.code === "PGRST202" || error?.code === "42883";
}

// Strips control characters and collapses whitespace the way the RPC does, so
// the length rule below is judged on what the server will see.
export function cleanCatalogQuery(raw) {
  return String(raw || "").replace(/\p{Cc}/gu, "").replace(/\s+/g, " ").trim();
}

// Where a search goes. The RPC takes a 2 to 80 character query or a state and
// cannot express a level filter, a family-only search or a bare 1-character
// local number, so those stay on the Phase 1 registry read, as does every
// search while the catalog is probing or has fallen back.
export function catalogSearchPlan(rawQuery, filters = {}, page = 0, catalog = "live") {
  const query = cleanCatalogQuery(rawQuery);
  const normalized = normalizeRegistryFilters(filters);
  // The RPC counts code points, not UTF-16 units, so a lone astral character
  // is one character here too and never reaches it as a "two-character" query.
  const length = [...query].length;
  const lengthOk = length >= 2 && length <= 80;
  const useCatalog = catalog === "live"
    && normalized.level === ""
    && length !== 1
    && (lengthOk || normalized.state !== "");
  if (!useCatalog) return { source: "registry", query, args: null };
  const catalogPage = Number.isInteger(page) && page >= 0 && page < CATALOG_MAX_PAGES ? page : 0;
  return {
    source: "catalog",
    query,
    args: {
      p_query: lengthOk ? query : null,
      p_state: normalized.state || null,
      p_family: normalized.affiliation || null,
      p_tier: null,
      p_page: catalogPage + 1,
    },
  };
}

export function catalogPageCount(total) {
  if (!Number.isInteger(total) || total <= 0) return 0;
  return Math.min(CATALOG_MAX_PAGES, Math.ceil(total / CATALOG_PAGE_SIZE));
}

function stateOrNull(value) {
  return typeof value === "string" && /^[A-Z]{2}$/.test(value) && value !== "00" ? value : null;
}

// Search rows from either branch of the RPC, shaped like Phase 1's rows so the
// results list renders both the same way. Malformed rows are dropped.
export function normalizeCatalogRow(row) {
  if (!row || typeof row !== "object" || typeof row.key !== "string" || typeof row.name !== "string") return null;
  const name = cleanText(row.name, CATALOG_ORGANIZATION_NAME_MAX);
  if (!name) return null;
  const membersLatest = integerOrNull(row.membersReported);
  const membersYear = integerOrNull(row.membersFiscalYear);
  return {
    id: row.key,
    key: row.key,
    registryOnly: row.registryOnly === true,
    name,
    affiliation: cleanText(row.family, 40) || null,
    designation: cleanText(row.designation, 160) || null,
    localNumber: cleanText(row.localNumber, 20) || null,
    level: REGISTRY_LEVELS.includes(row.level) ? row.level : "unknown",
    city: cleanText(row.city, 120) || null,
    state: stateOrNull(row.state),
    website: websiteFromRow(row.website),
    membersLatest: membersLatest != null && membersYear != null ? membersLatest : null,
    membersYear: membersLatest != null && membersYear != null ? membersYear : null,
    parentName: cleanText(row.parentName, CATALOG_ORGANIZATION_NAME_MAX) || null,
  };
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeParent(item, index) {
  if (!item || typeof item !== "object") return null;
  const parentKey = typeof item.parentKey === "string" && CATALOG_KEY_PATTERN.test(item.parentKey) ? item.parentKey : null;
  return {
    key: parentKey ?? `label:${cleanText(item.parentLabel, 300)}#${index}`,
    parentKey,
    parentName: cleanText(item.parentName, CATALOG_ORGANIZATION_NAME_MAX) || null,
    parentLabel: cleanText(item.parentLabel, 300) || null,
    certainty: enumOrNull(CERTAINTIES, item.certainty),
  };
}

// The parent list is a DAG walk, so one parent body can arrive twice (a
// diamond). Each catalog parent is listed once, keeping the first (nearest)
// entry; label-only parents carry no identity and are never merged.
function normalizeParents(items) {
  const seen = new Set();
  const parents = [];
  list(items).forEach((item, index) => {
    const parent = normalizeParent(item, index);
    if (!parent) return;
    if (parent.parentKey) {
      if (seen.has(parent.parentKey)) return;
      seen.add(parent.parentKey);
    }
    parents.push(parent);
  });
  return parents;
}

// Names and kinds only (spec J1). Location, employer, members, notes and the
// sub-unit website are deliberately not carried out of this function.
function normalizeSubunit(item) {
  if (!item || typeof item !== "object" || typeof item.key !== "string") return null;
  return {
    key: item.key,
    name: cleanText(item.name, 200) || null,
    kind: enumOrNull(SUBUNIT_KINDS, item.kind),
    kindLabel: cleanText(item.kindLabel, 60) || null,
  };
}

// Title and counts only. The outline has no holder column and this keeps it so.
function normalizeSeat(item) {
  if (!item || typeof item !== "object" || typeof item.key !== "string") return null;
  return {
    key: item.key,
    title: cleanText(item.title, 120) || null,
    seatClass: enumOrNull(SEAT_CLASSES, item.seatClass),
    listed: integerOrNull(item.listed) ?? 0,
    vacant: integerOrNull(item.vacant) ?? 0,
  };
}

// Organization-level contacts only, by the export rules. Websites and social
// pages become host links; everything else stays plain text.
function normalizeContact(item, index) {
  if (!item || typeof item !== "object") return null;
  const kind = enumOrNull(CONTACT_KINDS, item.kind);
  const value = cleanText(item.value, 500);
  if (!kind || !value) return null;
  const link = kind === "website" || kind === "social" ? websiteFromRow(value) : null;
  return { key: `${kind}-${index}`, kind, value, link };
}

// Documents link out only over https (D18, F13); an http-only link keeps its
// title as text and gets no anchor. A document with no link (members only, or
// none on record) is kept: its kind, title and date still show.
function normalizeDocument(item, membersOnly) {
  if (!item || typeof item !== "object" || typeof item.key !== "string") return null;
  const href = !membersOnly && typeof item.url === "string" && /^https:\/\//i.test(item.url.trim()) ? websiteFromRow(item.url) : null;
  return {
    key: item.key,
    kind: enumOrNull(DOCUMENT_KINDS, item.kind),
    title: cleanText(item.title, 300) || null,
    link: href,
    asOf: dateOnly(item.asOf),
  };
}

function normalizeCoverage(coverage) {
  if (!coverage || typeof coverage !== "object") return null;
  const checklist = {};
  for (const item of COVERAGE_ITEMS) checklist[item] = coverage.checklist?.[item] === true;
  return {
    band: enumOrNull(COVERAGE_BANDS, coverage.band),
    checklist,
    lastResearched: dateOnly(coverage.lastResearched),
  };
}

function normalizeSources(urls) {
  const seen = new Set();
  const sources = [];
  for (const url of list(urls)) {
    const link = websiteFromRow(url);
    if (!link || seen.has(link.href)) continue;
    seen.add(link.href);
    sources.push(link);
  }
  return sources;
}

// These are organization relationships already published by the profile RPC,
// not workspace chapters or enrollment. Keep only identity and provenance;
// future RPC fields cannot introduce people or private research into browsing.
function normalizeChildren(items) {
  const seen = new Set();
  return list(items).slice(0, 500).flatMap((item) => {
    if (!item || typeof item.key !== "string" || !CATALOG_KEY_PATTERN.test(item.key)) return [];
    const edgeKind = enumOrNull(RELATION_KINDS, item.edgeKind);
    const identity = `${item.key}:${edgeKind ?? ""}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{ key: item.key, name: cleanText(item.name, CATALOG_ORGANIZATION_NAME_MAX) || null, edgeKind, certainty: enumOrNull(CERTAINTIES, item.certainty) }];
  });
}

// The profile the panel renders. Every field is allow-listed here: a key the
// RPC adds later never reaches the page until this function names it.
export function normalizeCatalogProfile(data) {
  if (!data || typeof data !== "object" || data.found !== true || !data.organization || typeof data.organization !== "object") {
    return { found: false };
  }
  const org = data.organization;
  const membersLatest = integerOrNull(org.membersReported);
  const membersYear = integerOrNull(org.membersFiscalYear);
  const children = normalizeChildren(data.children);
  // Document links are for members (REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110).
  // The profile says which answer it is; one with no such field predates the
  // rule and carries its links as before.
  const documentLinks = data.documentLinks === "members" ? "members" : "included";
  return {
    found: true,
    organization: {
      key: typeof org.key === "string" ? org.key : null,
      name: cleanText(org.name, CATALOG_ORGANIZATION_NAME_MAX) || null,
      affiliation: cleanText(org.family, 40) || null,
      designation: cleanText(org.designation, 160) || null,
      localNumber: cleanText(org.localNumber, 20) || null,
      level: REGISTRY_LEVELS.includes(org.level) ? org.level : "unknown",
      city: cleanText(org.city, 120) || null,
      state: stateOrNull(org.state),
      website: websiteFromRow(org.website),
      membersLatest: membersLatest != null && membersYear != null ? membersLatest : null,
      membersYear: membersLatest != null && membersYear != null ? membersYear : null,
      confidence: enumOrNull(CONFIDENCES, org.confidence),
      researchedOn: dateOnly(org.researchedOn),
    },
    parents: normalizeParents(data.parents),
    children,
    childrenTotal: Math.max(integerOrNull(data.childrenTotal) ?? children.length, children.length),
    subunits: list(data.subunits).map(normalizeSubunit).filter(Boolean),
    seats: list(data.seatOutlines).map(normalizeSeat).filter(Boolean),
    contacts: list(data.contacts).map(normalizeContact).filter(Boolean),
    documentLinks,
    documents: list(data.documents).map((item) => normalizeDocument(item, documentLinks === "members")).filter(Boolean),
    coverage: normalizeCoverage(data.coverage),
    sources: normalizeSources(org.sourceUrls),
  };
}

// One status probe per page lifetime. Any error, and any answer other than
// `available: true`, means the page keeps Phase 1's registry behaviour: a
// missing function (migration pending), an inactive catalog (2a migrated, 2c
// not activated) and an outage all look the same to the visitor.
export async function probeCatalogStatus(client) {
  try {
    const { data, error } = await client.rpc(UNION_CATALOG_RPCS.status);
    if (error || data?.available !== true) return { catalog: "fallback", status: null };
    return {
      catalog: "live",
      status: {
        dataAsOf: dateOnly(data.dataAsOf),
        releasedOn: dateOnly(data.releasedOn),
        // The setup review pins the release it read a profile from (Phase 4a).
        releaseLabel: typeof data.releaseLabel === "string" ? data.releaseLabel : null,
      },
    };
  } catch {
    return { catalog: "fallback", status: null };
  }
}

export async function searchCatalog(client, args) {
  const { data, error } = await client.rpc(UNION_CATALOG_RPCS.search, args);
  if (error) throw new MemberApiError("Union catalog search", error);
  const rows = list(data?.rows).map(normalizeCatalogRow).filter(Boolean);
  const total = Number.isInteger(data?.total) && data.total >= 0 ? data.total : rows.length;
  return { rows, total, totalCapped: data?.totalCapped === true, hasNext: data?.hasNext === true };
}

// First-page catalog rows for the setup review and the placement card. A
// registry-fallback row is kept only when its id is a catalog key, because a
// placement or a prefill must name a catalog entry. `catalogOnly` also drops
// registry-only rows whose id looks like a catalog key: the search returns
// those only when no live catalog row carries that key, so a placement
// naming one is always refused.
export async function searchCatalogKeys(client, query, { catalogOnly = false } = {}) {
  const { rows } = await searchCatalog(client, { p_query: query, p_state: null, p_family: null, p_tier: null, p_page: 1 });
  return rows
    .filter((row) => CATALOG_KEY_PATTERN.test(row.key) && !(catalogOnly && row.registryOnly))
    .map(({ key, name, city, state }) => ({ key, name, city, state }));
}

// `normalize` lets the setup review keep its own, narrower allow-list.
export async function loadCatalogProfile(client, key, normalize = normalizeCatalogProfile) {
  const { data, error } = await client.rpc(UNION_CATALOG_RPCS.profile, { p_key: key });
  if (error) throw new MemberApiError("Union catalog profile", error);
  return normalize(data);
}
