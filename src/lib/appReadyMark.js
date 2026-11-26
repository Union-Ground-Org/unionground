// BUG-UG-WEB-PERFORMANCE-BUDGET-DORMANT-BUNDLE-OVER-CEILING-20261109:
// a performance mark for the moment the first route content commits, so the
// weekly budget run (scripts/run-web-performance-budgets.mjs) can time the app
// itself. Lighthouse's LCP reads the static crawl fallback in index.html,
// which paints long before the app, so a shell that became ready 500 ms later
// moved no number the run recorded.
//
// "Ready" is the first commit that replaces the crawl fallback with content
// in #root and leaves no loading screen or route placeholder inside it. The
// static fallback paints before React starts and must never count as ready.
// The mark is set once; the observer then disconnects.
export const APP_READY_MARK = "ug:app-ready";
const PENDING = ".crawl-fallback, .loading-screen, .view-loading";

export function observeAppReady(root, { performance = globalThis.performance, MutationObserver = globalThis.MutationObserver } = {}) {
  if (!root || typeof performance?.mark !== "function" || typeof MutationObserver !== "function") return () => {};
  let observer = null;
  const settle = () => {
    if (!root.firstElementChild || root.querySelector(PENDING)) return false;
    observer?.disconnect();
    performance.mark(APP_READY_MARK);
    return true;
  };
  if (settle()) return () => {};
  observer = new MutationObserver(() => { settle(); });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
