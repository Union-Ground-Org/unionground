// Builds the org-structure/1 payload the setup review sends to
// import_organization_structure (REQ-UG-UNION-CATALOG-SETUP-REVIEW-PREFILL-20260925).
//
// Pure: no React, no network. The draft lives in the page's React state and
// is never stored (brief A4). What a prefill may copy is decided here and
// nowhere else (brief A13): names, kinds, the sub-unit tree, a source host and
// date per row, and, only when the admin opts in, vacant officer and board
// seat outlines. No person, contact, employer, note, member count, steward or
// delegate seat reaches the payload. Member locals are never copied in bulk;
// an explicitly selected child listing contributes only its public name.

import { CATALOG_KEY_PATTERN, CATALOG_ORGANIZATION_NAME_MAX, dateOnly } from "../unionCatalog/catalogSearch.js";

export const ROW_TYPES = Object.freeze(["chapter", "council", "office", "unit", "retiree_chapter"]);
export const MAX_ITEMS = 500;
const CHAPTER_NAME_MAX = 120;
export const NODE_LABEL_MAX = 160;
const SUPPLIED_BY_MAX = 160;
const AUTHORITY_MAX = 240;
const SOURCE_LABEL_MAX = 180;
const ROOT_NODE_KEY = "cat.root";

const CHAPTER_TYPES = new Set(["chapter", "unit", "retiree_chapter"]);

const TYPE_FOR_KIND = Object.freeze({
  chapter: "chapter", local: "chapter",
  unit: "unit", bargaining_unit: "unit",
  retiree_chapter: "retiree_chapter",
  council: "council", district: "council", division: "council", region: "council", sector: "council",
  department: "office", committee: "office", other: "office",
});

const ROLE_CLASS_FOR_SEAT = Object.freeze({ officer: "director", board: "functional" });

// The profile RPC caps sub-units and seat outlines at 500 each.
const PROFILE_SUBUNIT_CAP = 500;

const SUBUNIT_KINDS = new Set([
  "chapter", "unit", "bargaining_unit", "retiree_chapter", "local", "district", "division", "region", "sector",
  "department", "council", "committee", "other",
]);
const SEAT_CLASSES = new Set(["officer", "board", "steward", "delegate"]);

function cleanText(value, max) {
  if (typeof value !== "string") return "";
  const trimmed = value.replace(/\p{Cc}/gu, "").replace(/\s+/g, " ").trim();
  return [...trimmed].length > max ? "" : trimmed;
}

function httpsHost(value) {
  if (typeof value !== "string" || !/^https:\/\//i.test(value.trim())) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.host ? { href: url.href, host: url.host } : null;
  } catch {
    return null;
  }
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

// Only what the setup review may use (brief A13): names, kinds, the sub-unit
// tree, source hosts and dates, officer and board seat titles and counts,
// https document links, and the count of organizations listed under this
// one. Contacts, notes, employer, members, confidence and every bookkeeping
// field stop here.
export function normalizeSetupProfile(data) {
  if (!data || data.found !== true || !data.organization || typeof data.organization !== "object") return { found: false };
  const subunits = list(data.subunits).map((item) => {
    if (!item || typeof item.key !== "string") return null;
    const name = cleanText(item.name, 400);
    if (!name) return null;
    return {
      key: item.key,
      parentKey: typeof item.parentKey === "string" ? item.parentKey : null,
      kind: SUBUNIT_KINDS.has(item.kind) ? item.kind : "other",
      name,
      sourceHost: httpsHost(item.sourceUrl)?.host ?? null,
      asOf: dateOnly(item.asOf),
    };
  }).filter(Boolean);
  const seats = list(data.seatOutlines).map((item) => {
    if (!item || typeof item.key !== "string" || !SEAT_CLASSES.has(item.seatClass)) return null;
    const title = cleanText(item.title, 160);
    if (!title) return null;
    return {
      key: item.key,
      subunitKey: typeof item.subunitKey === "string" ? item.subunitKey : null,
      seatClass: item.seatClass,
      title,
      asOf: dateOnly(item.asOf),
    };
  }).filter(Boolean);
  const documents = list(data.documents).map((item) => {
    const link = item && typeof item.key === "string" ? httpsHost(item.url) : null;
    return link ? { key: item.key, title: cleanText(item.title, 300) || link.host, ...link } : null;
  }).filter(Boolean);
  return {
    found: true,
    // Catalog organization names may be up to 1,000 characters .
    organization: { key: data.organization.key, name: cleanText(data.organization.name, CATALOG_ORGANIZATION_NAME_MAX) },
    subunits,
    subunitsCapped: list(data.subunits).length >= PROFILE_SUBUNIT_CAP,
    seats,
    documents,
    childrenTotal: Number.isInteger(data.childrenTotal) && data.childrenTotal > 0 ? data.childrenTotal : 0,
    // Individual child listings are selectable references, never bulk-imported
    // as if the parent's member organizations were workspace chapters.
    children: list(data.children).filter((child, index, all) => child && CATALOG_KEY_PATTERN.test(child.key)
      && child.key !== data.organization.key && all.findIndex((item) => item?.key === child.key) === index)
      .map((child) => ({ key: child.key, name: cleanText(child.name, CATALOG_ORGANIZATION_NAME_MAX) })).filter((child) => child.name),
  };
}

export function rowTypeForKind(kind) {
  return TYPE_FOR_KIND[kind] ?? "office";
}

function nameLimitFor(type) {
  return CHAPTER_TYPES.has(type) ? CHAPTER_NAME_MAX : NODE_LABEL_MAX;
}

// Review rows from a normalized setup profile. Every public-record row starts
// included (: an editable suggestion). Council member locals
// (`children`) are other catalog organizations and never become rows.
export function rowsFromProfile(profile) {
  if (!profile?.found) return [];
  return profile.subunits.slice(0, MAX_ITEMS).map((subunit) => ({
    id: subunit.key,
    origin: "catalog",
    name: subunit.name,
    type: rowTypeForKind(subunit.kind),
    parentId: subunit.parentKey,
    sourceHost: subunit.sourceHost,
    sourceAsOf: subunit.asOf,
  }));
}

// Seat outlines are offered for officer and board seats only.
export function seatsFromProfile(profile) {
  if (!profile?.found) return [];
  return profile.seats.filter((seat) => seat.seatClass === "officer" || seat.seatClass === "board");
}

export function newOwnRow(name, type, id = globalThis.crypto.randomUUID()) {
  return { id, origin: "own", name, type: ROW_TYPES.includes(type) ? type : "chapter", parentId: null, sourceHost: null, sourceAsOf: null };
}

// Length as the database counts it (characters, not UTF-16 units).
function charLength(text) {
  return [...text].length;
}

function folded(value) {
  return String(value ?? "").trim().toLowerCase();
}

// Per-row problems the dry run cannot see: a name that is too long (flagged,
// never truncated) and a duplicate name, within the list or against a chapter
// the organization already has.
export function rowIssues(rows, existingChapterNames = []) {
  const counts = new Map();
  for (const row of rows) counts.set(folded(row.name), (counts.get(folded(row.name)) ?? 0) + 1);
  const existing = new Set(existingChapterNames.map(folded));
  const issues = {};
  for (const row of rows) {
    const name = String(row.name ?? "").trim();
    const found = [];
    if (!name) found.push("emptyName");
    else if (charLength(name) > nameLimitFor(row.type)) found.push("needsShorterName");
    if (name && (counts.get(folded(name)) > 1 || existing.has(folded(name)))) found.push("duplicateName");
    if (found.length) issues[row.id] = found;
  }
  return issues;
}

export function attestationIssues(attestation) {
  const found = [];
  const suppliedBy = String(attestation?.suppliedBy ?? "").trim();
  const authority = String(attestation?.authority ?? "").trim();
  if (!suppliedBy || charLength(suppliedBy) > SUPPLIED_BY_MAX) found.push("suppliedBy");
  if (!authority || charLength(authority) > AUTHORITY_MAX) found.push("authority");
  return found;
}

// Today's calendar date in Eastern time, as YYYY-MM-DD.
export function easternDate(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function slugPrefix(name) {
  const slug = String(name ?? "").normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 12).replace(/-+$/, "");
  return slug || "org";
}

// `<chart root name, 12 chars>-<4 hex of the org id>-<8 hex digest>`:
// at most 26 characters. The digest binds the full organization id and row id,
// so a shared UUID prefix does not reproduce the same public-record chapter
// key (public.chapters.id is repository-wide). The client has no
// organization slug, so the readable prefix is the root name on the chart.
// Without an organization id there is no namespace, so no key is made.
export async function chapterKeyFor(organizationId, organizationName, rowId) {
  const orgHex = String(organizationId ?? "").replace(/[^0-9a-f]/gi, "").slice(0, 4).toLowerCase();
  if (orgHex.length < 4) throw new Error("organization id required for a chapter key");
  const identity = JSON.stringify([String(organizationId).toLowerCase(), rowId]);
  return `${slugPrefix(organizationName)}-${orgHex}-${(await sha256Hex(identity)).slice(0, 8)}`;
}

// `salt` namespaces one build's nodes. import_organization_structure upserts
// by node key and replaces a matched node's notes and metrics, so a key this
// organization's chart already holds would overwrite that node.
export async function nodeKeyFor(rowId, salt = "") {
  return `cat.${(await sha256Hex(salt ? `${salt}|${rowId}` : rowId)).slice(0, 12)}`;
}

export function sourceLabelFor(releaseLabel, catalogKey) {
  return `Union Ground public-record catalog ${releaseLabel}, ${catalogKey}`.slice(0, SOURCE_LABEL_MAX);
}

// The payload. `dryRun` is never a payload key: the import refuses a payload
// whose dryRun disagrees with its argument, so the argument alone decides.
export async function buildSetupPayload({
  organizationId,
  organizationName,
  rows,
  seats = [],
  attestation,
  source = null,
  seatBadge = "",
  seatSubtitle = () => "",
  existingChapterIds = [],
  // The page builds once for the dry run and confirms that same body, so a
  // fresh salt per build is safe; tests pass a fixed one.
  nodeSalt = globalThis.crypto.randomUUID(),
}) {
  const rootLabel = String(organizationName ?? "").trim();
  const included = rows.slice(0, MAX_ITEMS);
  // Keys are deterministic, so confirming the same public record again (or a
  // row renamed after a first import) reproduces a chapter key this
  // organization already has, and import_organization_structure UPDATES the
  // chapter that owns it: the existing chapter would be renamed and reordered
  // instead of a new one being created. A colliding row takes a suffixed
  // identity for its chapter key, so setup only ever adds chapters (gate
  // round 1 on). Node keys are salted per build: the client cannot read
  // the chart's existing node keys, and an unsalted key repeats whenever the
  // same record is confirmed again, even under a changed chart title (gate
  // round 2 on), so every node but the root is new. The importer creates
  // cat.root only when absent and preserves an existing anchor and its content.
  const taken = new Set(existingChapterIds.filter((id) => typeof id === "string" && id));
  const identities = new Map();
  for (const row of included) {
    let identity = row.id;
    if (CHAPTER_TYPES.has(row.type)) {
      for (let attempt = 1; taken.has(await chapterKeyFor(organizationId, rootLabel, identity)); attempt += 1) {
        identity = `${row.id}#${attempt}`;
      }
      taken.add(await chapterKeyFor(organizationId, rootLabel, identity));
    }
    identities.set(row.id, identity);
  }
  const nodeKeys = new Map();
  for (const row of included) nodeKeys.set(row.id, await nodeKeyFor(identities.get(row.id), nodeSalt));
  const chapters = [];
  const nodes = [{ nodeKey: ROOT_NODE_KEY, nodeKind: "organization", label: rootLabel, sortOrder: 0 }];
  let order = 2;
  for (const [index, row] of included.entries()) {
    const name = String(row.name ?? "").trim();
    const node = {
      nodeKey: nodeKeys.get(row.id),
      parentKey: nodeKeys.get(row.parentId) ?? ROOT_NODE_KEY,
      nodeKind: CHAPTER_TYPES.has(row.type) ? "chapter" : row.type === "council" ? "division" : "team",
      label: name,
      sortOrder: index + 1,
    };
    if (CHAPTER_TYPES.has(row.type)) {
      const chapterKey = await chapterKeyFor(organizationId, rootLabel, identities.get(row.id));
      chapters.push({ chapterKey, name, orderIndex: order });
      order += 1;
      node.chapterKey = chapterKey;
    }
    if (row.origin === "catalog") {
      if (row.sourceHost) node.sourceLabel = row.sourceHost.slice(0, SOURCE_LABEL_MAX);
      if (row.sourceAsOf) node.sourceAsOf = row.sourceAsOf;
    }
    nodes.push(node);
  }
  const room = Math.max(0, MAX_ITEMS - included.length);
  for (const [index, seat] of seats.filter((item) => ROLE_CLASS_FOR_SEAT[item.seatClass]).slice(0, room).entries()) {
    const node = {
      nodeKey: await nodeKeyFor(`seat:${seat.key}`, nodeSalt),
      parentKey: nodeKeys.get(seat.subunitKey) ?? ROOT_NODE_KEY,
      nodeKind: "role",
      label: seat.title,
      vacant: true,
      roleClass: ROLE_CLASS_FOR_SEAT[seat.seatClass],
      sortOrder: included.length + index + 1,
    };
    if (seatBadge) node.badge = seatBadge;
    const subtitle = seatSubtitle(seat.asOf);
    if (subtitle) node.subtitle = subtitle;
    if (seat.asOf) node.sourceAsOf = seat.asOf;
    nodes.push(node);
  }
  const payload = {
    schemaVersion: "org-structure/1",
    selectedHat: "admin",
    attestation: {
      suppliedBy: String(attestation?.suppliedBy ?? "").trim(),
      suppliedOn: attestation?.suppliedOn ?? easternDate(),
      authority: String(attestation?.authority ?? "").trim(),
      personalContactConsent: "not_obtained",
    },
    chapters,
    charts: { union: { nodes } },
  };
  if (source?.releaseLabel && source?.catalogKey && source?.dataAsOf) {
    payload.sources = [{ sourceLabel: sourceLabelFor(source.releaseLabel, source.catalogKey), sourceAsOf: source.dataAsOf }];
  }
  return payload;
}

// Import error codes the page has its own copy for.
export const KNOWN_IMPORT_ERRORS = Object.freeze([
  "chapter_key_taken", "duplicate_key", "invalid_text", "unknown_parent", "payload_too_large", "write_refused",
]);

// The row an import error path points at, when there is one. Paths look like
// `chapters[3].name` or `charts.union.nodes[5].label`; the root node is index 0.
export function rowForErrorPath(path, rows, payload) {
  const chapter = /^chapters\[(\d+)\]/.exec(path ?? "");
  if (chapter) {
    const key = payload?.chapters?.[Number(chapter[1])]?.chapterKey;
    const nodeIndex = payload?.charts?.union?.nodes?.findIndex((node) => node.chapterKey === key) ?? -1;
    return nodeIndex > 0 ? rows[nodeIndex - 1] ?? null : null;
  }
  const node = /^charts\.union\.nodes\[(\d+)\]/.exec(path ?? "");
  if (node && Number(node[1]) > 0) return rows[Number(node[1]) - 1] ?? null;
  return null;
}
