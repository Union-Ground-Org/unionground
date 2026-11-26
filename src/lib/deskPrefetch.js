import { useEffect, useRef } from "react";
import { workspacePageForLocation } from "./workspacePages.js";

// PERF-UG-DEMO-ROLE-SWITCH-STAFF-DESK-READS-START-LATE-20261124 (#9840):
// after a role switch the Coordinator and Advisor desks used to start their
// own reads only once the shell had mounted them, which waited for the member
// route reads and their rendering (about 3 s with nothing in flight on the
// hosted demo). The shell now starts a desk's read as soon as the switched
// account's own data has loaded, and the desk takes that read when it mounts.
//
// A started read belongs to the one visit that started it: the store is
// emptied whenever the page, the worn hat, its authorization, the signed-in
// account or the organization or chapter changes (useDeskPrefetch), so a
// person who leaves and comes back gets a new read. It is taken once, only
// under the same key, and only while younger than DESK_PREFETCH_MAX_AGE_MS. A
// started read that failed is never the desk's answer: the desk's own reader
// runs once instead and its result (or failure) drives the desk as before.
// The read itself is the desk's own read, under the same session, so the
// server authorizes and scopes it exactly as before.
export const DESK_PREFETCH_MAX_AGE_MS = 30_000;

// The pages each desk serves from its smaller reader (#9805). The views and the
// prefetch decide from these together, so the started read is the one the
// mounted desk asks for.
const ADVISOR_OVERVIEW_SECTIONS = new Set(["overview", "advisor-turnout", "advisor-risks"]);

export function workspaceSectionAt(pathname, hash = "") {
  return workspacePageForLocation(pathname, hash)?.sectionId || "overview";
}

export function coordinatorKpisOnly(section, search = "") {
  return section === "coordinator-funnel" && !new URLSearchParams(search).has("case");
}

export function advisorOverviewOnly(section) {
  return ADVISOR_OVERVIEW_SECTIONS.has(section);
}

export function createDeskPrefetch({ now = () => Date.now(), maxAgeMs = DESK_PREFETCH_MAX_AGE_MS } = {}) {
  const slots = new Map();
  const fresh = (slot) => now() - slot.at < maxAgeMs;
  return {
    // Starts `read` once per key within a visit; a second start while the
    // first is fresh is ignored. Returns whether it started.
    start(key, read) {
      const slot = slots.get(key);
      if (slot && fresh(slot)) return false;
      let promise;
      try { promise = Promise.resolve(read()); } catch (error) { promise = Promise.reject(error); }
      promise.catch(() => {}); // swallow-ok: an untaken read is dropped; a taken one that failed is replaced by the desk's own read in take().
      slots.set(key, { promise, at: now() });
      return true;
    },
    // The desk's read for `key`: the started one, once, while fresh; otherwise,
    // and when the started one failed, `read()` itself.
    take(key, read) {
      const slot = slots.get(key);
      slots.delete(key);
      if (!slot || !fresh(slot)) return read();
      return slot.promise.catch(() => read());
    },
    clear() { slots.clear(); },
  };
}

// One store per shell (the desk APIs take from it, so it exists before them).
export function useDeskPrefetchStore() {
  const ref = useRef(null);
  if (ref.current === null) ref.current = createDeskPrefetch();
  return ref;
}

// Empties the store on every change of the visit's context: the page (view)
// and its address inside the desk (pathname, search and hash, so a move to
// another page of the same desk reads fresh; on #9840), the worn hat
// and whether the account holds it, the signed-in account (sign-out included)
// and the organization and chapter. React runs this cleanup before the start
// effect of the same commit, so a new role switch always starts a new read.
export function useDeskPrefetchVisit(ref, { view, location, hat, authorized, userId, scope }) {
  useEffect(() => {
    const prefetch = ref.current;
    return () => prefetch.clear();
  }, [ref, view, location, hat, authorized, userId, scope]);
}
