import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createOrganizationCoordinationAdapter } from "../features/coordination/adapter.js";
import {
  coordinationScopeIsAuthoritative,
  normalizeCoordinationActor,
} from "../features/coordination/authorization.js";
import {
  COORDINATION_DONOR,
  COORDINATION_EXTENSIONS_ANSWERED_STATES,
  COORDINATION_EXTENSIONS_RETRYABLE_STATES,
  COORDINATION_RPCS,
  EMPTY_COORDINATION_EXTENSIONS,
} from "../features/coordination/contract.js";

export { COORDINATION_DONOR };

export function buildCoordinationActor(input = {}) {
  return normalizeCoordinationActor({
    userId: input.userId,
    organizationId: input.organizationId || input.selectedOrganizationId,
    chapterId: input.chapterId,
    selectedHat: input.selectedHat,
    organizationRoles: input.organizationRoles || input.roles,
    chapterRoles: input.chapterRoles,
    membershipStatus: input.membershipStatus,
    mfaSatisfied: input.mfaSatisfied,
    // Carried through so a re-normalized actor keeps the authority it was
    // stamped with; the default is the fail-closed "pending".
    sessionScope: input.sessionScope,
  });
}

export async function loadCoordinationSessionScope(client) {
  if (!client?.rpc) return { unavailable: true };
  try {
    const { data, error } = await client.rpc("get_my_chapter_memberships");
    if (error) return { unavailable: true };
    const selected = (Array.isArray(data) ? data : []).find((row) => row?.selected) || null;
    return {
      unavailable: false,
      organizationId: selected?.organizationId || null,
      chapterId: selected?.chapterId || null,
      organizationRoles: selected?.organizationRoles || [],
      chapterRoles: selected?.chapterRoles || [],
    };
  } catch {
    return { unavailable: true };
  }
}

// The one place an actor becomes authoritative. Until get_my_chapter_memberships
// answers, the actor this desk holds is the one the route was mounted with, and
// the deferred directory RPC — which takes no organization argument and writes a
// 'directory_viewed' row for whatever organization the SESSION resolves to — must
// not be issued from it. Called with no scope this is the mount window
// ("pending"); called with an unavailable discovery the organization cannot be
// confirmed at all ("unconfirmed"), which stays closed rather than falling back to
// the prop, because a fallback is exactly the unverified scope the audit row would
// be written against.
export function mergeCoordinationScope(actor, scope = {}) {
  const current = buildCoordinationActor(actor);
  if (scope.unavailable !== false) {
    return buildCoordinationActor({ ...current, sessionScope: scope.unavailable === true ? "unconfirmed" : "pending" });
  }
  return buildCoordinationActor({
    ...current,
    organizationId: scope.organizationId,
    chapterId: scope.chapterId,
    organizationRoles: scope.organizationRoles,
    chapterRoles: scope.chapterRoles,
    membershipStatus: scope.organizationId ? "active" : "inactive",
    sessionScope: "resolved",
  });
}

// The scoped actor every coordination call is made with. Its `sessionScope` field
// is the signal the desk and the adapter read: "pending" on mount, then the
// discovery's answer. A new actor prop puts it back to "pending" in the same
// effect that re-issues the discovery, so authority is never inherited from the
// actor it was earned for.
// Keep the actor object the desk already holds when the next one is the same
// canonical actor. Every new object rebuilds OrganizationCoordinationView's load
// callback and issues another full read set, so the mount window's second,
// identical "pending" actor used to fan one mount out into three loads.
function keepEquivalentActor(next) {
  const key = JSON.stringify(next);
  return (previous) => (JSON.stringify(previous) === key ? previous : next);
}

export function useCoordinationActor(client, actor) {
  const actorKey = JSON.stringify(buildCoordinationActor(actor));
  const stable = useMemo(() => JSON.parse(actorKey), [actorKey]);
  const [scoped, setScoped] = useState(() => mergeCoordinationScope(stable));
  // The actor/client this retry (or discovery) may write for. Established during
  // render, not in the effect: an awaited retry resolves in a microtask, and an
  // effect is a later turn, so a guard bumped only from the reset effect would
  // still let a stale retry land in the window after the new actor has rendered
  // and before that effect has run. Replacing the run here makes the comparison
  // synchronous with the switch that supersedes it.
  const run = useRef(null);
  if (run.current === null || run.current.client !== client || run.current.stable !== stable) {
    run.current = { client, stable };
  }
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  useEffect(() => {
    let active = true;
    setScoped(keepEquivalentActor(mergeCoordinationScope(stable)));
    loadCoordinationSessionScope(client).then((scope) => {
      if (active) setScoped(keepEquivalentActor(mergeCoordinationScope(stable, scope)));
    });
    return () => { active = false; };
  }, [client, stable]);
  // Re-runs discovery and nothing else. The unconfirmed fail-closed default
  // stays until get_my_chapter_memberships actually answers, so this cannot
  // raise sessionScope to resolved on its own and it never issues the writing
  // directory RPC. A hat or organization switch, or a new client, replaces the
  // run above; the answer from a retry that left on the previous run is dropped
  // whole so it cannot overwrite the newer effect's pending/resolved state and
  // re-enable the parameterless directory RPC under obsolete authorization.
  const retryScope = useCallback(async () => {
    const issued = run.current;
    const scope = await loadCoordinationSessionScope(client);
    if (!live.current || issued !== run.current) return;
    setScoped(keepEquivalentActor(mergeCoordinationScope(stable, scope)));
  }, [client, stable]);
  return { actor: scoped, retryScope };
}

// Which projection a latched request belongs to: one organization, read by one
// user, through one adapter. Deliberately NOT the scoped actor's object identity.
// useCoordinationActor above replaces that object at least twice per mount — once
// synchronously and again when get_my_chapter_memberships resolves — so keying
// the latch on identity released it underneath a click that had already issued
// the writing RPC, and the desk then re-offered a control whose next press wrote
// a second 'directory_viewed' audit row for the same visit. Membership resolution
// is not a new projection; a different organization or a different user is.
export function coordinationExtensionsScope(actor) {
  return `${actor?.selectedOrganizationId || actor?.organizationId || ""}|${actor?.userId || ""}`;
}

// One explicit request per visit, and the projection is stored with the scope it
// belongs to. The deferred directory RPC writes a 'directory_viewed' audit row, so
// it is loaded when a member who can read the desk asks for it — and only once
// session scope is authoritative (see mergeCoordinationScope above) — and then
// kept for the rest of the mounted session: switching tabs, resolving session
// scope, or re-rendering after any other coordination action must not ask again
// and must not write a second audit row. The latch is released only when the load
// ends in an outcome the desk offers a retry for, or when the adapter or the scope
// above changes, which is a different projection.
//
// THE PROJECTION IS DERIVED DURING RENDER FROM THE SCOPE IT WAS LOADED FOR. It is
// not merely cleared by an effect: a resolved projection for org-1 sat in state
// when the actor became org-2, so the very first render under org-2 returned
// org-1's directory, invitations, badges and activity and committed them to the
// desk — one render of another tenant's data, and an `extensions.state === "ready"`
// that also suppressed org-2's own request control — before the reset effect ran a
// macrotask later. Storing `{ scope, adapter, value }` and returning the idle
// projection whenever the stored scope is not the current one makes the clear
// simultaneous with the change that requires it; there is no window to be one
// render behind in. The effect that drops the superseded value afterwards is
// housekeeping — it stops an earlier scope's data from being resurrected if the
// operator switches back within the same mount — and correctness does not rest on
// it having run.
//
// `run` is the identity of the load a response may write into, and it carries the
// latch, so both are replaced by the same render. It is NOT "still mounted": a
// scope change replaces the projection while this component stays mounted, so an
// in-flight loadDirectoryExtensions issued for org-1 used to resolve after the
// actor prop had already become org-2 and write org-1's directory rows onto org-2's
// desk — a cross-organization leak — and then latch them there, so org-2 was never
// offered its own request. Every call captures the run it left on; a response from
// a superseded run is dropped whole.
//
// The run identity is established DURING RENDER, not in an effect. An effect is a
// macrotask and an awaited RPC resolves in a microtask, so a guard bumped from a
// reset effect was only current one turn after React had already rendered the new
// scope: between those two points `issued === run.current` still held for the OLD
// scope, and a response arriving there would be written and would close the latch
// on the new scope's behalf. Assigning the run while rendering makes the comparison
// synchronous with the change it guards, so the ordering question does not arise.
export function useCoordinationDirectoryExtensions(adapter, actor) {
  const scope = coordinationExtensionsScope(actor);
  // The parameterless RPC resolves its own organization server-side, so nothing
  // here may issue it until this session's organization is the server's answer.
  const authoritative = coordinationScopeIsAuthoritative(actor);

  const [stored, setStored] = useState(() => ({ scope, adapter, value: EMPTY_COORDINATION_EXTENSIONS }));
  // Derived during render: a projection from any other scope or adapter is not
  // this one's data and is never returned, not even for a single render.
  const extensions = stored.scope === scope && stored.adapter === adapter
    ? stored.value
    : EMPTY_COORDINATION_EXTENSIONS;

  // Derived-during-render, and idempotent: re-rendering the same adapter and the
  // same scope string keeps the same token and the same latch, so a response in
  // flight for the current projection is still allowed to write. Only a real
  // change replaces it — and replacing it reopens the latch for the new scope.
  const run = useRef(null);
  if (run.current === null || run.current.scope !== scope || run.current.adapter !== adapter) {
    run.current = { scope, adapter, requested: false };
  }
  // Unmounting supersedes the run too, and nothing renders after it, so it is the
  // one part of the identity an effect still has to carry.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  // Housekeeping only. The render above already refuses to return a superseded
  // projection; this releases it so a scope visited earlier in the same mount is
  // asked for again instead of showing what it held last time.
  useEffect(() => {
    setStored((previous) => (previous.scope === scope && previous.adapter === adapter
      ? previous
      : { scope, adapter, value: EMPTY_COORDINATION_EXTENSIONS }));
  }, [adapter, scope]);

  const request = useCallback(async (refresh) => {
    // Captured synchronously, inside the press (or the mutation) that issues the
    // call: the scope, the adapter and the latch this answer is allowed to touch.
    const issued = run.current;
    if (typeof adapter?.loadDirectoryExtensions !== "function") return;
    if (!authoritative) return;
    if (issued.requested && !refresh) return;
    issued.requested = true;
    const write = (value) => {
      // A different organization, user or adapter — or an unmounted desk — is a
      // different run: the projection has been cleared for whatever is current, so
      // this answer must not write its rows and must not close that latch on the
      // new scope's behalf.
      if (!live.current || issued !== run.current) return;
      setStored({ scope: issued.scope, adapter: issued.adapter, value });
    };
    if (!refresh) write({ ...EMPTY_COORDINATION_EXTENSIONS, state: "loading" });
    let next;
    try {
      next = await adapter.loadDirectoryExtensions(actor) || { ...EMPTY_COORDINATION_EXTENSIONS, state: "error" };
    } catch {
      next = { ...EMPTY_COORDINATION_EXTENSIONS, state: "error" };
    }
    if (!live.current || issued !== run.current) return;
    // `idle` is the adapter declining to call at all because the scope stopped
    // being authoritative under the request. Nothing was asked, so nothing is
    // latched and nothing is claimed.
    if (next.state === "idle") {
      issued.requested = false;
      if (!refresh) write(EMPTY_COORDINATION_EXTENSIONS);
      return;
    }
    if (refresh) {
      // A refresh is a side effect of a mutation the operator asked for, not a
      // request for the directory: it may improve the retained projection and it
      // may never destroy it. A failed refresh therefore leaves the last answer
      // and its closed latch exactly as they were — no failure panel replacing
      // loaded panels, and no new press that would write a second audit row —
      // and marks the retained answer stale so the acknowledgement can say so.
      if (COORDINATION_EXTENSIONS_ANSWERED_STATES.includes(next.state)) write(next);
      else {
        setStored((previous) => {
          if (previous.scope !== issued.scope || previous.adapter !== issued.adapter) return previous;
          if (previous.value?.stale) return previous;
          return { ...previous, value: { ...previous.value, stale: true } };
        });
      }
      return;
    }
    // Only an outcome the desk offers a retry for reopens the latch, and that is
    // only the outcome the client can prove never executed. A refusal, an
    // answered-empty projection and an ambiguous failure all keep it closed for
    // this visit.
    if (COORDINATION_EXTENSIONS_RETRYABLE_STATES.includes(next.state)) issued.requested = false;
    write(next);
    // The callback may be rebuilt as the actor object is replaced; only the latch
    // above, the run guard and the stored scope are bound to the projection's
    // identity, never to that object identity.
  }, [actor, adapter, authoritative]);

  const loadExtensions = useCallback(() => request(false), [request]);

  // The refresh the desk owes an answered projection after a mutation that owns
  // one of this projection's fields. The view maps each run() intent onto those
  // fields, so a partner message or an export does not re-issue the writing RPC.
  // An owning mutation still re-reads through the same explicit path — one
  // further 'directory_viewed' row for that mutation, because the operator is
  // acting on the surface they asked to see. It does nothing before the operator
  // has asked for the projection at all, which is what keeps a desk nobody
  // opened that surface on free of audit rows.
  const refreshExtensions = useCallback(() => {
    if (!COORDINATION_EXTENSIONS_ANSWERED_STATES.includes(extensions.state)) return Promise.resolve();
    return request(true);
  }, [extensions.state, request]);

  return { extensions, loadExtensions, refreshExtensions };
}

export function createWiredCoordinationAdapter(client) {
  return createOrganizationCoordinationAdapter(client);
}

// `mountRpcs` is the read-only set the desk issues on view; `explicitRpcs` is
// the set no page mount may reach. get_organization_coordination_extensions
// writes an access-event row, so it belongs to the second list only.
export const MI1_COORDINATION_DATABASE_DEPENDENCIES = Object.freeze({
  sessionScope: Object.freeze(["get_my_chapter_memberships"]),
  mountRpcs: Object.freeze([
    COORDINATION_RPCS.snapshot,
    COORDINATION_RPCS.messagesPage,
    COORDINATION_RPCS.networkAccessEvents,
    COORDINATION_RPCS.coalitionDecisions,
    COORDINATION_RPCS.micrositeEditor,
  ]),
  explicitRpcs: Object.freeze([COORDINATION_RPCS.extensions]),
  rpcs: Object.freeze(Object.values(COORDINATION_RPCS)),
});
