import {
  COLLECTIVE_ACTION_MANAGER_HATS,
  DIGITAL_ACTION_KINDS,
  DIGITAL_ACTION_PARTICIPATION_KINDS,
  DIGITAL_ACTION_STATUSES,
  LEADERSHIP_TIMELINE_KINDS,
  ORGANIZATION_CHART_KINDS,
  ORGANIZATION_NODE_KINDS,
  ORGANIZATION_SEAT_STATUSES,
  RELATIONSHIP_KINDS,
  TOPIC_PROGRESS_STATES,
} from "./contract.js";
import {
  authorizeCollectiveActions,
  authorizeOrganizationIntelligence,
  canExportCollectiveActionParticipants,
  canManageCollectiveActions,
  canWriteOrganizationIntelligence,
} from "./authorization.js";

function rows(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

function text(value, max = 240) {
  return String(value || "").trim().slice(0, max);
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function emptyModel(state, reason, organizationId = null) {
  return Object.freeze({ state, reason, organizationId });
}

function normalizeChartNodes(snapshot) {
  const knownIds = new Set();
  const normalized = rows(snapshot.chartNodes).flatMap((node) => {
    const id = text(node.id, 80);
    const chartKind = ORGANIZATION_CHART_KINDS.includes(node.chartKind) ? node.chartKind : null;
    const nodeKind = ORGANIZATION_NODE_KINDS.includes(node.nodeKind) ? node.nodeKind : null;
    const label = text(node.label, 160);
    if (!id || !chartKind || !nodeKind || !label || knownIds.has(id)) return [];
    knownIds.add(id);
    return [{
      id,
      chartKind,
      nodeKind,
      parentId: text(node.parentId, 80) || null,
      chapterId: text(node.chapterId, 80) || null,
      label,
      subtitle: text(node.subtitle, 240) || null,
      positionX: Math.max(-10000, Math.min(10000, finite(node.positionX))),
      positionY: Math.max(-10000, Math.min(10000, finite(node.positionY))),
      sortOrder: Math.trunc(finite(node.sortOrder)),
      // The stored seat state, unconfirmed when the database sends none.
      vacant: node.vacant === true,
      seatStatus: ORGANIZATION_SEAT_STATUSES.includes(node.seatStatus) ? node.seatStatus : "unconfirmed",
      seatStatusReviewedOn: text(node.seatStatusReviewedOn, 10) || null,
      sourceLabel: text(node.sourceLabel, 180) || null,
      sourceAsOf: text(node.sourceAsOf, 10) || null,
    }];
  });
  return normalized.map((node) => ({
    ...node,
    parentId: node.parentId && knownIds.has(node.parentId) ? node.parentId : null,
  }));
}

export function buildOrganizationChartForest(snapshot) {
  const nodes = normalizeChartNodes(snapshot);
  const byKind = Object.fromEntries(ORGANIZATION_CHART_KINDS.map((kind) => [kind, []]));
  for (const kind of ORGANIZATION_CHART_KINDS) {
    const scoped = nodes.filter((node) => node.chartKind === kind);
    const children = new Map(scoped.map((node) => [node.id, []]));
    for (const node of scoped) {
      if (node.parentId && children.has(node.parentId)) children.get(node.parentId).push(node);
    }
    const sort = (items) => items.sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
    for (const item of children.values()) sort(item);
    const visit = (node, ancestry = new Set()) => {
      if (ancestry.has(node.id)) return { ...node, children: [] };
      const next = new Set(ancestry).add(node.id);
      return { ...node, children: (children.get(node.id) || []).map((child) => visit(child, next)) };
    };
    byKind[kind] = sort(scoped.filter((node) => !node.parentId)).map((node) => visit(node));
  }
  return Object.freeze({ nodes: Object.freeze(nodes), byKind: Object.freeze(byKind) });
}

export function buildRelationshipGraph(snapshot) {
  const graphNodes = rows(snapshot.relationshipNodes).flatMap((node) => {
    const id = text(node.id, 80);
    const label = text(node.label, 160);
    if (!id || !label) return [];
    return [{
      id,
      label,
      chapterId: text(node.chapterId, 80) || null,
      roleLabel: text(node.roleLabel, 120) || null,
    }];
  });
  const nodeIds = new Set(graphNodes.map((node) => node.id));
  const edges = rows(snapshot.relationships).flatMap((edge) => {
    const id = text(edge.id, 80);
    const source = text(edge.sourceId, 80);
    const target = text(edge.targetId, 80);
    const kind = RELATIONSHIP_KINDS.includes(edge.kind) ? edge.kind : null;
    if (!id || !kind || source === target || !nodeIds.has(source) || !nodeIds.has(target)) return [];
    return [{ id, source, target, kind, strength: Math.max(1, Math.min(5, Math.trunc(finite(edge.strength, 1)))) }];
  });
  const topics = rows(snapshot.topicProgress).flatMap((entry) => {
    const memberId = text(entry.memberId, 80);
    const topicKey = text(entry.topicKey, 80);
    const topicLabel = text(entry.topicLabel, 160);
    const state = TOPIC_PROGRESS_STATES.includes(entry.state) ? entry.state : null;
    if (!nodeIds.has(memberId) || !topicKey || !topicLabel || !state) return [];
    return [{
      memberId,
      topicKey,
      topicLabel,
      state,
      progress: Math.max(0, Math.min(100, Math.round(finite(entry.progress)))),
    }];
  });
  return Object.freeze({ nodes: Object.freeze(graphNodes), edges: Object.freeze(edges), topics: Object.freeze(topics) });
}

function normalizeTimeline(snapshot) {
  return rows(snapshot.timeline).flatMap((entry) => {
    const id = text(entry.id, 80);
    const kind = LEADERSHIP_TIMELINE_KINDS.includes(entry.kind) ? entry.kind : null;
    const title = text(entry.title, 180);
    const effectiveOn = text(entry.effectiveOn, 10);
    if (!id || !kind || !title || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveOn)) return [];
    return [{
      id,
      kind,
      title,
      detail: text(entry.detail, 1000) || null,
      chapterId: text(entry.chapterId, 80) || null,
      effectiveOn,
      endedOn: /^\d{4}-\d{2}-\d{2}$/.test(String(entry.endedOn || "")) ? String(entry.endedOn) : null,
      amountCents: entry.amountCents == null ? null : Math.max(0, Math.trunc(finite(entry.amountCents))),
      amountBasis: text(entry.amountBasis, 80) || null,
      sourceLabel: text(entry.sourceLabel, 180) || null,
      sourceAsOf: /^\d{4}-\d{2}-\d{2}$/.test(String(entry.sourceAsOf || "")) ? String(entry.sourceAsOf) : null,
    }];
  }).sort((a, b) => b.effectiveOn.localeCompare(a.effectiveOn) || a.title.localeCompare(b.title));
}

export function composeOrganizationIntelligence({ snapshot = null, actor = {} } = {}) {
  const gate = authorizeOrganizationIntelligence(actor, snapshot?.organizationId || null);
  if (!gate.ok) return emptyModel(gate.state, gate.reason, gate.actor.organizationId);
  if (snapshot == null) return emptyModel("unset", "snapshot_unwired", gate.actor.organizationId);
  if (snapshot.unavailable) return emptyModel("unauthorized", snapshot.reason || "authorization_required", gate.actor.organizationId);
  if (snapshot.error) return emptyModel("error", snapshot.error, gate.actor.organizationId);
  return Object.freeze({
    state: "ready",
    reason: null,
    organizationId: gate.actor.organizationId,
    generatedAt: snapshot.generatedAt || null,
    charts: buildOrganizationChartForest(snapshot),
    relationships: buildRelationshipGraph(snapshot),
    timeline: Object.freeze(normalizeTimeline(snapshot)),
    writeAllowed: canWriteOrganizationIntelligence(gate.actor),
    // Null when the snapshot does not say (the preview fixtures): the caller's
    // configuration decides then.
    neuroMapEnabled: typeof snapshot.neuroMapEnabled === "boolean" ? snapshot.neuroMapEnabled : null,
  });
}

function normalizeAction(action, viewerCanManage) {
  const id = text(action.id, 80);
  const kind = DIGITAL_ACTION_KINDS.includes(action.kind) ? action.kind : null;
  const status = DIGITAL_ACTION_STATUSES.includes(action.status) ? action.status : null;
  const title = text(action.title, 180);
  if (!id || !kind || !status || !title || (!viewerCanManage && status === "draft")) return null;
  const targetCount = Math.max(1, Math.min(1000000, Math.trunc(finite(action.targetCount, 1))));
  // The server withholds platform-owned totals as null; keep that distinct from zero.
  const participantCount = action.participantCount === null ? null : Math.max(0, Math.min(1000000, Math.trunc(finite(action.participantCount))));
  const viewerParticipation = DIGITAL_ACTION_PARTICIPATION_KINDS.includes(action.viewerParticipation)
    ? action.viewerParticipation
    : null;
  return Object.freeze({
    id,
    kind,
    status,
    title,
    summary: text(action.summary, 2000),
    chapterId: text(action.chapterId, 80) || null,
    targetCount,
    participantCount,
    strengthPercent: participantCount === null ? null : Math.min(100, Math.round((participantCount / targetCount) * 100)),
    viewerParticipation,
    // The server's object-level edit rule (author, or an organization officer
    // hat); never true for a viewer who cannot manage actions at all.
    viewerCanEdit: viewerCanManage && action.viewerCanEdit === true,
    // #9166: the server's join rule for this caller; an older server that
    // does not send it keeps today's offer.
    viewerCanJoin: action.viewerCanJoin !== false,
    startsAt: text(action.startsAt, 40) || null,
    endsAt: text(action.endsAt, 40) || null,
    publishedAt: text(action.publishedAt, 40) || null,
  });
}

export function composeCollectiveActions({ snapshot = null, actor = {} } = {}) {
  const gate = authorizeCollectiveActions(actor, snapshot?.organizationId || null);
  if (!gate.ok) return emptyModel(gate.state, gate.reason, gate.actor.organizationId);
  if (snapshot == null) return emptyModel("unset", "snapshot_unwired", gate.actor.organizationId);
  if (snapshot.unavailable) return emptyModel("unauthorized", snapshot.reason || "authorization_required", gate.actor.organizationId);
  if (snapshot.error) return emptyModel("error", snapshot.error, gate.actor.organizationId);
  // #9166: an organization-wide grant manages every action as before; a hat
  // granted for the selected chapter manages that chapter's actions, on the
  // server's word (get_collective_actions manageScope), never on client roles.
  const manageChapterId = text(snapshot.manageChapterId, 80) || null;
  const manageScope = canManageCollectiveActions(gate.actor)
    ? "organization"
    : snapshot.manageScope === "chapter" && manageChapterId && gate.actor.mfaSatisfied
      && (!gate.actor.chapterId || gate.actor.chapterId === manageChapterId)
      ? "chapter"
      : null;
  const manageAllowed = manageScope !== null;
  const actions = rows(snapshot.actions)
    .map((action) => normalizeAction(action, manageAllowed))
    .filter(Boolean)
    .sort((a, b) => {
      const priority = { published: 0, draft: 1, closed: 2, cancelled: 3 };
      return priority[a.status] - priority[b.status]
        || String(b.startsAt || b.publishedAt || "").localeCompare(String(a.startsAt || a.publishedAt || ""))
        || a.title.localeCompare(b.title);
    });
  return Object.freeze({
    state: "ready",
    reason: null,
    organizationId: gate.actor.organizationId,
    generatedAt: snapshot.generatedAt || null,
    actions: Object.freeze(actions),
    totalCount: Math.max(actions.length, Math.trunc(finite(snapshot.totalCount, actions.length))),
    nextOffset: snapshot.nextOffset == null ? null : Math.max(0, Math.trunc(finite(snapshot.nextOffset))),
    hasMore: snapshot.nextOffset != null,
    manageAllowed,
    manageScope,
    manageChapterId: manageScope === "chapter" ? manageChapterId : null,
    // #9166: the hats that really manage actions here, or null when the server does not say.
    authoringHats: Array.isArray(snapshot.authoringHats)
      ? Object.freeze(snapshot.authoringHats.filter((hat) => COLLECTIVE_ACTION_MANAGER_HATS.includes(hat)))
      : null,
    exportAllowed: canExportCollectiveActionParticipants(gate.actor),
  });
}
