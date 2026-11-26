import {
  COORDINATION_EXTENSION_FIELDS,
  COORDINATION_INTENT_ROLES,
  COORDINATION_KINDS,
  COORDINATION_SESSION_SCOPE_STATES,
  COORDINATION_STAFF_HATS,
  COORDINATION_TABS,
  EMPTY_COORDINATION_EXTENSIONS,
  EMPTY_COORDINATION_SNAPSHOT,
} from "./contract.js";

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

export function normalizeCoordinationActor(actor = {}) {
  const organizationRoles = unique(actor.organizationRoles).filter((role) => COORDINATION_STAFF_HATS.includes(role));
  const chapterRoles = unique(actor.chapterRoles).filter((role) => COORDINATION_STAFF_HATS.includes(role));
  return Object.freeze({
    userId: actor.userId || null,
    selectedOrganizationId: actor.selectedOrganizationId || actor.organizationId || null,
    chapterId: actor.chapterId || null,
    selectedHat: actor.selectedHat || "member",
    organizationRoles: Object.freeze(organizationRoles),
    chapterRoles: Object.freeze(chapterRoles),
    membershipStatus: actor.membershipStatus || null,
    mfaSatisfied: Boolean(actor.mfaSatisfied),
    // Fail closed: an actor nobody stamped is "pending", because the only thing
    // that can stamp "resolved" is get_my_chapter_memberships having answered
    // (src/lib/mi1CoordinationWiring.js mergeCoordinationScope). A caller that
    // forgets the stamp therefore loses the deferred directory request, which is
    // the safe direction: the alternative is a writing RPC issued against an
    // organization the server has not confirmed.
    sessionScope: COORDINATION_SESSION_SCOPE_STATES.includes(actor.sessionScope) ? actor.sessionScope : "pending",
  });
}

export function canReadCoordination(actor) {
  const current = normalizeCoordinationActor(actor);
  return Boolean(current.userId && current.selectedOrganizationId && current.membershipStatus === "active");
}

export function canManageCoordination(actor) {
  const current = normalizeCoordinationActor(actor);
  return canReadCoordination(current)
    && COORDINATION_STAFF_HATS.includes(current.selectedHat)
    && current.organizationRoles.includes(current.selectedHat)
    && current.mfaSatisfied;
}

export function canPerformCoordinationIntent(actor, intent) {
  const current = normalizeCoordinationActor(actor);
  return canManageCoordination(current)
    && (COORDINATION_INTENT_ROLES[intent] || []).includes(current.selectedHat);
}

// Whether this session's organization is the server's answer rather than the one
// the route was mounted with. Read by the adapter before it issues the deferred
// directory RPC, and by the desk before it offers the control that calls it: the
// RPC takes no organization argument, so there is no way to bind the intended
// organization to the call, and no way to undo the 'directory_viewed' row it
// writes for whichever organization the session actually resolves to. Reading the
// desk is not gated on it — the read-only mount is safe from the prop — so this
// is deliberately separate from canReadCoordination.
export function coordinationScopeIsAuthoritative(actor) {
  return normalizeCoordinationActor(actor).sessionScope === "resolved";
}

export function visibleCoordinationTabs(actor) {
  const staff = canManageCoordination(actor);
  return COORDINATION_TABS.filter((tab) => !tab.staffOnly || staff);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function safeRecord(record) {
  if (!record || !COORDINATION_KINDS.includes(record.kind) || !record.id) return null;
  return {
    id: record.id,
    kind: record.kind,
    title: String(record.title || "Untitled"),
    summary: String(record.summary || ""),
    status: String(record.status || "draft"),
    visibility: String(record.visibility || "staff"),
    organizationId: record.organizationId || null,
    partnerOrganizationId: record.partnerOrganizationId || null,
    chapterId: record.chapterId || null,
    parentId: record.parentId || null,
    config: record.config && typeof record.config === "object" ? record.config : {},
    completedByCaller: Boolean(record.completedByCaller),
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
  };
}

function safeCursor(cursor, records) {
  if (cursor?.updatedAt && cursor?.id) {
    return { updatedAt: cursor.updatedAt, id: cursor.id };
  }
  if (records.length !== 50) return null;
  const last = records.at(-1);
  return last?.updatedAt && last?.id
    ? { updatedAt: last.updatedAt, id: last.id }
    : null;
}

function safeMessageCursor(cursor, messages) {
  if (cursor?.createdAt && cursor?.id) {
    return { createdAt: cursor.createdAt, id: cursor.id };
  }
  if (messages.length !== 30) return null;
  const last = messages.at(-1);
  return last?.createdAt && last?.id
    ? { createdAt: last.createdAt, id: last.id }
    : null;
}

export function normalizeCoordinationRecordPage(page) {
  const records = array(page?.records).map(safeRecord).filter(Boolean);
  return {
    records,
    nextRecordsCursor: safeCursor(page?.nextCursor, records),
  };
}

export function normalizeCoordinationMessagePage(page) {
  const messages = array(page?.messages);
  return {
    messages,
    nextMessagesCursor: safeMessageCursor(page?.nextCursor, messages),
  };
}

function safeMicrositeProfile(profile) {
  if (!profile || typeof profile !== "object") return null;
  return {
    titleEn: typeof profile.titleEn === "string" ? profile.titleEn : "",
    titleEs: typeof profile.titleEs === "string" ? profile.titleEs : "",
    bodyEn: typeof profile.bodyEn === "string" ? profile.bodyEn : "",
    bodyEs: typeof profile.bodyEs === "string" ? profile.bodyEs : "",
    published: Boolean(profile.published),
    updatedAt: typeof profile.updatedAt === "string" ? profile.updatedAt : null,
  };
}

export function normalizeCoordinationSnapshot(snapshot, actor) {
  const current = normalizeCoordinationActor(actor);
  if (!snapshot || snapshot.state === "empty" || !current.selectedOrganizationId) {
    return { ...EMPTY_COORDINATION_SNAPSHOT };
  }
  if (snapshot.organizationId !== current.selectedOrganizationId) {
    return { ...EMPTY_COORDINATION_SNAPSHOT, state: "unauthorized" };
  }
  const records = array(snapshot.records).map(safeRecord).filter(Boolean);
  return {
    state: snapshot.state === "ready" ? "ready" : "error",
    degradedProjections: array(snapshot.degradedProjections).filter((field) => typeof field === "string" && field.length > 0),
    organizationId: snapshot.organizationId,
    staff: Boolean(snapshot.staff && canManageCoordination(current)),
    records,
    nextRecordsCursor: safeCursor(snapshot.nextRecordsCursor, records),
    messages: array(snapshot.messages),
    nextMessagesCursor: safeMessageCursor(snapshot.nextMessagesCursor, array(snapshot.messages)),
    resources: array(snapshot.resources),
    exportRuns: array(snapshot.exportRuns),
    outreach: array(snapshot.outreach),
    directory: array(snapshot.directory),
    permissions: array(snapshot.permissions),
    networkAccessEvents: array(snapshot.networkAccessEvents),
    invitations: array(snapshot.invitations),
    badges: array(snapshot.badges),
    recentActivity: array(snapshot.recentActivity),
    organizationParticipants: array(snapshot.organizationParticipants),
    userParticipants: array(snapshot.userParticipants),
    mergeMatches: array(snapshot.mergeMatches),
    mergeJobs: array(snapshot.mergeJobs),
    coalitionDecisions: array(snapshot.coalitionDecisions),
    micrositeEditor: snapshot.micrositeEditor && typeof snapshot.micrositeEditor === "object"
      ? {
          state: snapshot.micrositeEditor.state === "ready" ? "ready" : "missing",
          chapterCode: snapshot.micrositeEditor.chapterCode || null,
          profile: safeMicrositeProfile(snapshot.micrositeEditor.profile),
          sections: array(snapshot.micrositeEditor.sections),
          pages: array(snapshot.micrositeEditor.pages),
          attachments: array(snapshot.micrositeEditor.attachments),
          takeovers: array(snapshot.micrositeEditor.takeovers),
        }
      : EMPTY_COORDINATION_SNAPSHOT.micrositeEditor,
    mobilizationProgress: array(snapshot.mobilizationProgress),
  };
}

// The directory/activity projection that only an explicit member request loads.
// It is normalized separately from the mount snapshot because it arrives later
// and from a different call, and it is still bound to the same authorization
// facts: a projection for another organization is refused, not merged.
export function normalizeCoordinationExtensions(extensions, actor) {
  const current = normalizeCoordinationActor(actor);
  if (!extensions || extensions.state === "empty" || !current.selectedOrganizationId) {
    return { ...EMPTY_COORDINATION_EXTENSIONS, state: "empty" };
  }
  if (extensions.organizationId !== current.selectedOrganizationId) {
    return { ...EMPTY_COORDINATION_EXTENSIONS, state: "unauthorized" };
  }
  const normalized = {
    ...EMPTY_COORDINATION_EXTENSIONS,
    state: extensions.state === "ready" ? "ready" : "error",
    organizationId: extensions.organizationId,
  };
  for (const field of COORDINATION_EXTENSION_FIELDS) normalized[field] = array(extensions[field]);
  return normalized;
}

// Only the fields the deferred projection owns. The mount snapshot keeps every
// other field, so merging this over it can never blank a read-only surface.
export function coordinationExtensionFields(extensions) {
  const source = extensions || EMPTY_COORDINATION_EXTENSIONS;
  return Object.fromEntries(COORDINATION_EXTENSION_FIELDS.map((field) => [field, array(source[field])]));
}

export function recordsForTab(snapshot, tabId) {
  const tab = COORDINATION_TABS.find((item) => item.id === tabId);
  if (!tab) return [];
  return array(snapshot?.records).filter((record) => tab.kinds.includes(record.kind));
}

// The capability `private.validate_organization_coordination_record_shape`
// demands of a network child's parent link, and the one
// `private.validate_organization_coordination_resource_permission` demands of a
// resource row (supabase/migrations/
// 20260828232000_mi1_organization_coordination_workflows.sql). A write whose
// parent cannot carry it is refused with 42501, so the desk must not offer that
// parent at all.
export const NETWORK_CHILD_CAPABILITY = Object.freeze({
  network_conversation: "message",
  network_request: "resource_request",
});

export const NETWORK_RESOURCE_CAPABILITY = Object.freeze({
  request: "resource_request",
  share: "resource_share",
});

// The network links a child write of `capability` can actually land on.
//
// Status is known from the mount snapshot and is always enforced: the same
// trigger refuses any parent link that is not `active`.
//
// The grants are not. They arrive only with the deferred extensions projection,
// so `permissions` is null until that load answers, and an unknown grant list
// must never hide a link — an empty array would otherwise read as "no grant
// exists" on every mount and take away a create the server would have accepted.
// When the list IS known, a link is offered only while it carries an active
// grant for that capability, which is what set_organization_network_permission
// binds to the link it was recorded against. The server predicate
// (private.organization_network_has_permission, which matches the two
// organizations rather than the link) stays the authorization boundary; this
// only stops the desk from offering a control whose write is already refused.
export function networkLinksForCapability(records, capability, permissions = null) {
  const links = array(records).filter((record) => record.kind === "network_link" && record.status === "active");
  if (!capability || !Array.isArray(permissions)) return links;
  return links.filter((link) => permissions.some((grant) => grant
    && grant.networkRecordId === link.id
    && grant.capability === capability
    && grant.status === "active"));
}
