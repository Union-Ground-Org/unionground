// Member steward-roster and member org-structure contract, native side.
//
// REQ-UG-MEMBER-FIND-MY-STEWARD-HOME-ENTRY-20260922 and
// REQ-UG-MEMBER-ORG-STRUCTURE-VIEW-20260922 are delivered across three
// lanes. The member-facing reads belong to the web/backend lane and the
// person-node identity column to the import lane; this module is the native
// half. It names no table and no column, and every RPC it calls is the name the
// web/backend lane published in v1 — native invents none.
//
// The three reads are PLANNED (db) at the time of writing: the migration slot is
// held behind, so calling them fails until that lands. The screens report
// that as an error state rather than pretending to have data.
//
// Two projection rules the records spell out are enforced server-side and
// repeated here, so a widened server can never quietly widen the native surface:
//
//   * `reports_to` is the only member-visible relationship kind;
//   * an edge is drawn only when BOTH of its endpoints are admitted nodes of the
//     chart being drawn. The member projection resolves participants to node ids
//     server-side and never projects `user_id`, so the client matches ids and
//     never display text.

export const MEMBER_ORG_CHART_KINDS = ['agency', 'union'] as const;
export type MemberOrgChartKind = (typeof MEMBER_ORG_CHART_KINDS)[number];

export const MEMBER_VISIBLE_RELATIONSHIP_KINDS = ['reports_to'] as const;
export type MemberVisibleRelationshipKind = (typeof MEMBER_VISIBLE_RELATIONSHIP_KINDS)[number];

/** Exactly the RPC names §5 tells every lane to use. */
export const MEMBER_ORG_RPC_NAMES = Object.freeze({
  stewardRoster: 'get_member_chapter_stewards',
  organizationStructure: 'get_member_organization_structure',
  stewardConversation: 'start_member_steward_conversation',
});

export type MemberStewardContact = {
  /** Always true: the in-app thread is the floor and needs no opt-in. */
  conversation: boolean;
  /** Non-null only where the steward opted that channel in. */
  email: string | null;
  phone: string | null;
};

export type MemberStewardCard = {
  id: string;
  name: string;
  roleLabel: string;
  chapterID: string | null;
  chapterLabel: string | null;
  acceptsAppointments: boolean;
  contact: MemberStewardContact;
};

export type MemberOrgNode = {
  id: string;
  parentID: string | null;
  chapterID: string | null;
  nodeKind: string;
  label: string;
  subtitle: string | null;
  sortOrder: number;
  // Descriptive columns the import carried. They
  // are structure labels with no contact or pay data. `vacant` is kept so an
  // empty seat is never shown as filled; `reportsToLabel` is a label only and
  // is never coerced into an edge.
  badge: string | null;
  roleClass: string | null;
  vacant: boolean;
  reportsToLabel: string | null;
  chipLabel: string | null;
  sourceLabel: string | null;
  sourceAsOf: string | null;
  // REQ-UG-TENANT-ORG-CHART-BASELINE-20261030. The server's effective
  // seat state (a confirmation older than a year already reads stale). A
  // database without the column sends none, which reads unconfirmed.
  seatStatus: MemberOrgSeatStatus;
};

export type MemberOrgSeatStatus = 'confirmed' | 'unconfirmed' | 'unknown' | 'stale';

function seatStatus(value: unknown): MemberOrgSeatStatus {
  if (value === 'confirmed' || value === 'unknown' || value === 'stale') return value;
  return 'unconfirmed';
}

export type MemberOrgEdge = {
  id: string;
  sourceID: string;
  targetID: string;
  kind: MemberVisibleRelationshipKind;
};

export type MemberOrgChart = {
  chartKind: MemberOrgChartKind;
  nodes: MemberOrgNode[];
  edges: MemberOrgEdge[];
};

export type MemberOrgStructure = {
  organizationID: string | null;
  chapterID: string | null;
  generatedAt: string | null;
  charts: MemberOrgChart[];
};

export type MemberOrgTreeRow = {
  node: MemberOrgNode;
  depth: number;
  childCount: number;
};

// ---------------------------------------------------------------------------
// Normalizers. The payload is JSON from a security-definer RPC: every field is
// read defensively, and a row the client cannot place is dropped rather than
// rendered against a guess.
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rows(value: unknown): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = [];
  if (!Array.isArray(value)) return parsed;
  const list: readonly unknown[] = value;
  for (const entry of list) {
    const row = record(entry);
    if (row) parsed.push(row);
  }
  return parsed;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function flag(value: unknown): boolean {
  return value === true;
}

function isChartKind(value: unknown): value is MemberOrgChartKind {
  return (MEMBER_ORG_CHART_KINDS as readonly unknown[]).includes(value);
}

function isMemberVisibleRelationshipKind(value: unknown): value is MemberVisibleRelationshipKind {
  return (MEMBER_VISIBLE_RELATIONSHIP_KINDS as readonly unknown[]).includes(value);
}

/** `get_member_chapter_stewards()` → the roster the steward sheet renders. */
export function normalizeMemberStewardRoster(payload: unknown): MemberStewardCard[] {
  const envelope = record(payload);
  const cards: MemberStewardCard[] = [];
  for (const row of rows(envelope ? envelope.stewards : payload)) {
    // A steward the roster cannot identify cannot own a conversation.
    const id = text(row.id);
    const name = text(row.name);
    if (!id || !name) continue;
    const contact = record(row.contact);
    cards.push({
      id,
      name,
      roleLabel: text(row.roleLabel) ?? 'steward',
      chapterID: text(row.chapterId),
      chapterLabel: text(row.chapterLabel),
      acceptsAppointments: flag(row.acceptsAppointments),
      contact: {
        // The in-app conversation is the floor; treat a missing flag as present
        // rather than stranding the member with no way to reach anyone.
        conversation: contact === null || contact.conversation !== false,
        email: contact ? text(contact.email) : null,
        phone: contact ? text(contact.phone) : null,
      },
    });
  }
  return cards;
}

function normalizeChart(value: unknown): MemberOrgChart | null {
  const row = record(value);
  if (!row || !isChartKind(row.chartKind)) return null;
  const nodes: MemberOrgNode[] = [];
  for (const node of rows(row.nodes)) {
    const id = text(node.id);
    const label = text(node.label);
    if (!id || !label) continue;
    nodes.push({
      id,
      parentID: text(node.parentId),
      chapterID: text(node.chapterId),
      nodeKind: text(node.nodeKind) ?? 'role',
      label,
      subtitle: text(node.subtitle),
      sortOrder: count(node.sortOrder),
      badge: text(node.badge),
      roleClass: text(node.roleClass),
      vacant: flag(node.vacant),
      reportsToLabel: text(node.reportsToLabel),
      chipLabel: text(node.chipLabel),
      sourceLabel: text(node.sourceLabel),
      sourceAsOf: text(node.sourceAsOf),
      seatStatus: seatStatus(node.seatStatus),
    });
  }
  const edges: MemberOrgEdge[] = [];
  for (const edge of rows(row.edges)) {
    const id = text(edge.id);
    const sourceID = text(edge.sourceId);
    const targetID = text(edge.targetId);
    // The member allow-list, repeated on the client.
    if (!id || !sourceID || !targetID || !isMemberVisibleRelationshipKind(edge.kind)) continue;
    edges.push({ id, sourceID, targetID, kind: edge.kind });
  }
  return { chartKind: row.chartKind, nodes, edges };
}

/** `get_member_organization_structure()` → both charts for the caller's scope. */
export function normalizeMemberOrgStructure(payload: unknown): MemberOrgStructure {
  const envelope = record(payload);
  const charts: MemberOrgChart[] = [];
  if (Array.isArray(envelope?.charts)) {
    const list: readonly unknown[] = envelope.charts;
    for (const entry of list) {
      const chart = normalizeChart(entry);
      // One chart per kind: a duplicate kind would silently hide the second.
      if (chart && !charts.some((existing) => existing.chartKind === chart.chartKind)) charts.push(chart);
    }
  }
  charts.sort((left, right) => MEMBER_ORG_CHART_KINDS.indexOf(left.chartKind) - MEMBER_ORG_CHART_KINDS.indexOf(right.chartKind));
  return {
    organizationID: text(envelope?.organizationId),
    chapterID: text(envelope?.chapterId),
    generatedAt: text(envelope?.generatedAt),
    charts,
  };
}

// ---------------------------------------------------------------------------
// Projection rules shared by the native screen and its tests.
// ---------------------------------------------------------------------------

function compareNodes(left: MemberOrgNode, right: MemberOrgNode): number {
  if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
  return left.label.localeCompare(right.label);
}

/**
 * Flattens one chart into indented rows. A node whose parent is not in the
 * caller's scope is shown at the root rather than hidden: chapter scoping
 * legitimately removes ancestors, and dropping the subtree would hide the
 * caller's own chapter.
 */
export function buildMemberOrgTree(nodes: readonly MemberOrgNode[]): MemberOrgTreeRow[] {
  const byID = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string | null, MemberOrgNode[]>();
  for (const node of nodes) {
    const parentID = node.parentID !== null && byID.has(node.parentID) ? node.parentID : null;
    const bucket = children.get(parentID);
    if (bucket) bucket.push(node);
    else children.set(parentID, [node]);
  }
  for (const bucket of children.values()) bucket.sort(compareNodes);

  const flattened: MemberOrgTreeRow[] = [];
  const visited = new Set<string>();
  const walk = (parentID: string | null, depth: number) => {
    for (const node of children.get(parentID) ?? []) {
      // A cyclic parent chain is data, not a crash.
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      flattened.push({ node, depth, childCount: (children.get(node.id) ?? []).length });
      walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  return flattened;
}

export type MemberOrgResolvedEdge = {
  edge: MemberOrgEdge;
  source: MemberOrgNode;
  target: MemberOrgNode;
};

/**
 * An edge is drawn only when both of its endpoints are admitted nodes of the
 * chart being drawn. An edge whose endpoint is missing — a participant outside
 * the caller's chapter, or a person the projection did not admit — is omitted,
 * never drawn against a phantom node and never matched by display text.
 */
export function resolveMemberOrgEdges(chart: MemberOrgChart): MemberOrgResolvedEdge[] {
  const byID = new Map(chart.nodes.map((node) => [node.id, node]));
  const resolved: MemberOrgResolvedEdge[] = [];
  for (const edge of chart.edges) {
    const source = byID.get(edge.sourceID);
    const target = byID.get(edge.targetID);
    if (source && target) resolved.push({ edge, source, target });
  }
  return resolved;
}

export function searchMemberOrgNodes(
  rowsToSearch: readonly MemberOrgTreeRow[],
  query: string,
): MemberOrgTreeRow[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return [...rowsToSearch];
  return rowsToSearch.filter(({ node }) => [node.label, node.subtitle, node.badge, node.chipLabel, node.reportsToLabel]
    .some((field) => field !== null && field.toLocaleLowerCase().includes(needle)));
}

/**
 * The source's own provenance line, when the import carried one, matching the
 * web view: the first node naming a source, with its as-of date when present.
 */
export function memberOrgSourceLine(charts: readonly MemberOrgChart[]): string | null {
  for (const chart of charts) {
    for (const node of chart.nodes) {
      if (node.sourceLabel) return [node.sourceLabel, node.sourceAsOf].filter((value) => value !== null).join(' · ');
    }
  }
  return null;
}

export function memberOrgChartsWithContent(structure: MemberOrgStructure): MemberOrgChart[] {
  return structure.charts.filter((chart) => chart.nodes.length > 0);
}

// ---------------------------------------------------------------------------
// Data port. The screens read through this so the native surfaces can be
// exercised without a backend, and so the one place that talks to Supabase is
// named and testable.
// ---------------------------------------------------------------------------

export type MemberOrgDataPort = {
  loadStewardRoster: () => Promise<unknown>;
  loadOrganizationStructure: () => Promise<unknown>;
  /** `start_member_steward_conversation(p_steward_user_id, p_body)`. */
  startStewardConversation: (stewardUserID: string, body: string) => Promise<unknown>;
};

export type MemberStewardConversationStart = {
  conversationID: string;
  /** False when the server returned the member's existing thread with this steward. */
  created: boolean;
};

export const MEMBER_MESSAGE_MAX_LENGTH = 4_000;

/**
 * The first message to a selected steward. The
 * server binds the thread to that steward, refuses a steward outside the
 * caller's chapter, and returns the existing bound thread rather than a second
 * one. The client only accepts a reply that names the steward it asked for, so
 * a thread bound to anyone else can never be opened from this card.
 */
export async function startSelectedStewardConversation(
  port: Pick<MemberOrgDataPort, 'startStewardConversation'>,
  stewardUserID: string,
  body: string,
): Promise<MemberStewardConversationStart> {
  const steward = stewardUserID.trim();
  const clean = body.trim();
  if (steward === '') throw new Error('Choose a committee member before sending.');
  if (clean === '' || clean.length > MEMBER_MESSAGE_MAX_LENGTH) {
    throw new Error('Messages must be between 1 and 4,000 characters.');
  }
  const reply = record(await port.startStewardConversation(steward, clean));
  const conversationID = reply ? text(reply.conversationId) : null;
  if (!reply || !conversationID || text(reply.stewardUserId) !== steward) {
    throw new Error('The conversation could not be confirmed.');
  }
  return { conversationID, created: reply.created !== false };
}
