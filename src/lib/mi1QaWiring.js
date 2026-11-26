import { useEffect, useMemo, useRef, useState } from "react";
import { createQaRpcAdapter, isMissingQaRpcError, QA_RPC } from "../features/qa/index.js";
import { ORGANIZATION_ROLES } from "../features/tenancy/organizationScope.js";

export const MI1_QA_WEB_DONOR = Object.freeze({
  baseline: "donor-baseline-20260721",
  disposition: "port_adapt",
  rejected: Object.freeze([
    "Next.js app router and server actions",
    "legacy service-role browser clients",
    "fictional live tenants",
    "in-memory writes presented as persisted success",
  ]),
});

export const QA_DATABASE_DEPENDENCIES = Object.freeze({
  owner: "X-DB",
  rpcs: Object.freeze(Object.values(QA_RPC)),
  tables: Object.freeze(["member_qa_questions", "member_qa_replies", "member_qa_votes"]),
});

function uniqueRoles(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((role) => ORGANIZATION_ROLES.includes(role)))];
}

export function buildQaActor({
  userId = null,
  organizationId = null,
  chapterId = null,
  roles = [],
  organizationRoles = [],
  chapterRoles = [],
  membershipStatus = organizationId ? "active" : null,
  organizationStatus = organizationId ? "active" : null,
  mfaSatisfied = false,
  selectedHat = "member",
} = {}) {
  const orgRoles = uniqueRoles(organizationRoles);
  const chapterGrantRoles = uniqueRoles(chapterRoles);
  return Object.freeze({
    userId: userId || null,
    organizationId: organizationId || null,
    selectedOrganizationId: organizationId || null,
    chapterId: chapterId || null,
    roles: Object.freeze(uniqueRoles(roles)),
    organizationRoles: Object.freeze(orgRoles),
    chapterRoles: Object.freeze(chapterGrantRoles),
    membershipStatus: membershipStatus || (organizationId ? "active" : "inactive"),
    organizationStatus: organizationStatus || (organizationId ? "active" : null),
    mfaSatisfied: Boolean(mfaSatisfied),
    selectedHat: selectedHat || "member",
    authenticated: Boolean(userId),
    role: selectedHat === "member" ? (orgRoles[0] || null) : selectedHat,
  });
}

export async function loadOrganizationSessionScope(client) {
  if (!client?.rpc) {
    return { organizationId: null, chapterId: null, organizationRoles: [], chapterRoles: [], unavailable: true };
  }
  try {
    const { data, error } = await client.rpc("get_my_chapter_memberships");
    if (error) {
      return { organizationId: null, chapterId: null, organizationRoles: [], chapterRoles: [], unavailable: true };
    }
    const memberships = Array.isArray(data) ? data : [];
    const selected = memberships.find((row) => row?.selected) || null;
    return {
      organizationId: selected?.organizationId || null,
      chapterId: selected?.chapterId || null,
      organizationRoles: uniqueRoles(selected?.organizationRoles),
      chapterRoles: uniqueRoles(selected?.chapterRoles),
      unavailable: false,
    };
  } catch {
    return { organizationId: null, chapterId: null, organizationRoles: [], chapterRoles: [], unavailable: true };
  }
}

export function mergeQaSessionScope(actor, scope = {}) {
  const authoritativeScope = scope?.unavailable === false;
  return buildQaActor({
    ...actor,
    organizationId: authoritativeScope
      ? scope.organizationId
      : actor?.organizationId || actor?.selectedOrganizationId || scope.organizationId,
    chapterId: authoritativeScope ? scope.chapterId : actor?.chapterId || scope.chapterId,
    organizationRoles: authoritativeScope ? scope.organizationRoles : actor?.organizationRoles,
    chapterRoles: authoritativeScope ? scope.chapterRoles : actor?.chapterRoles,
    membershipStatus: authoritativeScope ? (scope.organizationId ? "active" : "inactive") : actor?.membershipStatus,
    organizationStatus: authoritativeScope ? (scope.organizationId ? "active" : null) : actor?.organizationStatus,
  });
}

// No client to read through (the fixture preview): the given actor is the
// whole truth. Tested in place, as the read-RPC drift guard requires.
function hasNoMembershipRead(client) {
  if (!client?.rpc) return true;
  return false;
}

export function useQaScopedActor(client, actor) {
  return useQaScopedActorState(client, actor).actor;
}

// `scopeSettled` is true once the membership read has answered successfully,
// or when there is no read to wait for (no client: the fixture preview, whose
// actor is the whole truth). While the read is pending, or after it failed,
// the actor is only the page's bootstrap guess, so a missing chapter there
// proves nothing (#9594 D1-14: the Q&A queue's no-chapter sentence waits
// for this).
export function useQaScopedActorState(client, actor) {
  const rolesKey = JSON.stringify(uniqueRoles(actor?.roles));
  const organizationRolesKey = JSON.stringify(uniqueRoles(actor?.organizationRoles));
  const chapterRolesKey = JSON.stringify(uniqueRoles(actor?.chapterRoles));
  const stableActor = useMemo(() => buildQaActor({
    userId: actor?.userId,
    organizationId: actor?.organizationId || actor?.selectedOrganizationId,
    chapterId: actor?.chapterId,
    roles: JSON.parse(rolesKey),
    organizationRoles: JSON.parse(organizationRolesKey),
    chapterRoles: JSON.parse(chapterRolesKey),
    membershipStatus: actor?.membershipStatus,
    organizationStatus: actor?.organizationStatus,
    mfaSatisfied: actor?.mfaSatisfied,
    selectedHat: actor?.selectedHat,
  }), [actor?.chapterId, actor?.membershipStatus, actor?.mfaSatisfied, actor?.organizationId, actor?.organizationStatus, actor?.selectedHat, actor?.selectedOrganizationId, actor?.userId, chapterRolesKey, organizationRolesKey, rolesKey]);
  // Preserve the trusted bootstrap actor until the membership RPC answers.
  // An empty result is authoritative only after that request succeeds.
  const noRead = hasNoMembershipRead(client);
  const [state, setState] = useState(() => ({ actor: mergeQaSessionScope(stableActor), scopeSettled: noRead }));
  useEffect(() => {
    let active = true;
    setState({ actor: mergeQaSessionScope(stableActor), scopeSettled: noRead });
    loadOrganizationSessionScope(client).then((scope) => {
      if (!active) return;
      setState({ actor: mergeQaSessionScope(stableActor, scope), scopeSettled: noRead || scope?.unavailable === false });
    });
    return () => {
      active = false;
    };
  }, [client, noRead, stableActor]);
  return state;
}

const QA_API_METHODS = Object.freeze([
  "list", "get", "search", "ask", "officialReply", "followUp", "toggleVote", "accept",
  "editQuestion", "deleteQuestion", "editReply", "deleteReply", "officerQueue",
]);

export function useStableQaApi(client, api = null) {
  const apiRef = useRef(api);
  apiRef.current = api;
  const hasInjectedApi = Boolean(api);
  return useMemo(() => {
    if (!hasInjectedApi) return createMemberQaApi(client);
    return Object.freeze(Object.fromEntries(QA_API_METHODS.map((method) => [
      method,
      (...args) => apiRef.current[method](...args),
    ])));
  }, [client, hasInjectedApi]);
}

export function createMemberQaApi(client) {
  return createQaRpcAdapter(client);
}

export { isMissingQaRpcError };
