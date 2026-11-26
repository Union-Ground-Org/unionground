// OPS-UG-ANALYTICS-READ-SIDE-SHIPPED-BUT-NOTHING-IN-PRODUCTION-WRITES-ORGANIZATION-ENGAGEMENT-EVENTS-20260921
// ( AUTHENTICATED PAGE-VIEW PRODUCER): the web client
// records one authenticated page view per workspace page change through
// public.record_workspace_page_view. This module decides WHAT a page view is
// (a normalized /m workspace path, never a query string, hash or secret
// fragment) and WHEN one is sent (the same page is not re-sent inside the
// server's one-minute idempotency window); the RPC decides the rest.
import { normalizeAppPath } from "./appRoutes.js";
import { guardSignal } from "./transportGuard.js";

export const WORKSPACE_PAGE_KEY_MAX = 100;
export const WORKSPACE_PAGE_VIEW_WINDOW_MS = 60_000;
const PAGE_KEY = /^\/[A-Za-z0-9/_.:-]*$/;

// The page key is the normalized path only: /m or a /m/... workspace page.
// Public pages, standalone pages (/invite, /stop-updates, /verify) and
// anything carrying a query or fragment contribute nothing.
export function workspacePageKey(location) {
  const path = normalizeAppPath(String(location || "").split(/[?#]/)[0]);
  if (path !== "/m" && !path.startsWith("/m/")) return null;
  if (path.length > WORKSPACE_PAGE_KEY_MAX || !PAGE_KEY.test(path)) return null;
  return path;
}

// Binds each RPC to the Product analytics abort signal current at call time, so
// turning analytics off cancels a page view still waiting on authentication,
// and guards that signal so the client's fetch re-reads `allowed` (the shared
// choice, which another tab may already have changed) just before sending.
export function abortableRpcClient(client, signal, allowed) {
  return { rpc: (name, args) => client.rpc(name, args).abortSignal(guardSignal(signal(), allowed)) };
}

// `enabled` is the member's Product analytics switch
// (REQ-UG-VISIBLE-ANALYTICS-OPT-OUT-20261016). It is read when a view
// is decided and again just before the request, so a view decided before the
// member turned analytics off is never sent.
export function createWorkspacePageViewRecorder({ record, enabled = () => true, now = () => Date.now(), windowMs = WORKSPACE_PAGE_VIEW_WINDOW_MS }) {
  let last = null;
  return {
    // Returns whether a view was sent. A failed send is swallowed: analytics
    // never interrupts the page the member is reading.
    view(location, context = {}) {
      if (!enabled()) return false;
      const key = workspacePageKey(location);
      if (!key) return false;
      const at = now();
      if (last && last.key === key && at - last.at < windowMs) return false;
      last = { key, at };
      Promise.resolve().then(() => (enabled() ? record(key, context) : null)).catch(() => {});
      return true;
    },
    reset() {
      last = null;
    },
  };
}
