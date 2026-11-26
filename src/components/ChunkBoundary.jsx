import { Component, useEffect } from "react";
import { canReachChunkDocument, claimChunkReload, isChunkLoadError, markChunkReady } from "../lib/lazyView.js";
import { captureViewError } from "../lib/deferredObservability.js";

// The blast radius of a chunk that will not load.
//
// A lazy component whose factory rejects throws during render, and an
// unhandled render error unmounts the WHOLE tree — main.jsx renders <App/>
// with nothing above it, so "the Rights chunk 404'd" and "the member is
// staring at a blank white page with no nav, no banner and no way back"
// are the same event. This boundary keeps the failure where it happened: the
// shell, the offline banner and the bottom nav survive, and only the view
// region is replaced.
//
// `fallback` is a function of a dismiss callback rather than an element,
// because the retry control has to be able to clear this boundary's own state
// — an error boundary that cannot be reset turns a one-off network blip into a
// dead screen for the rest of the session. App also keys the boundary on the
// active view, so navigating away is itself a reset.
//
// BUG-UG-VIEW-CRASH-SHOWN-AS-LOAD-FAILED-UNREPORTED-20261018: the
// boundary also catches ordinary render crashes, which a reload will not fix
// and which the root Sentry boundary never sees because this one catches them
// first. So every caught error is reported here, once, and the fallback is told
// which kind it is ("chunk" or "crash") so its copy can say the right thing.
//
// BUG-UG-SAMPLE-ROUTE-VIEWS-CAUGHT-LOAD-RENDER-BOUNDARY-20261019: a
// chunk failure can never clear in place (React.lazy memoises the rejection
// and Chromium's module map memoises the failed fetch), so while online the
// boundary verifies the document is reachable before reloading. A claim stays
// consumed until the requested view renders, including across slow startup.
// A crash never reloads: the same code would crash again.
function reloadPage() {
  window.location.reload();
}

function browserReloadClaim() {
  if (typeof window === "undefined") return false;
  let storage;
  try { storage = window.sessionStorage; } catch { return false; }
  return claimChunkReload({ storage, location: window.location, online: window.navigator?.onLine });
}

function browserCanReload({ signal }) {
  if (typeof window === "undefined") return false;
  return canReachChunkDocument({ url: window.location.href, fetchImpl: window.fetch?.bind(window),
    online: window.navigator?.onLine, signal });
}

// Mount INSIDE the route's Suspense boundary: its effect must not run while
// only the loading fallback is committed. This adds no DOM or visible copy.
export function ChunkReady({ ready = true }) {
  const pathname = typeof window === "undefined" ? "" : window.location.pathname;
  const search = typeof window === "undefined" ? "" : window.location.search;
  useEffect(() => {
    if (!ready) return;
    try { markChunkReady({ storage: window.sessionStorage, location: { pathname, search } }); } catch { /* Keep the claim if storage is unavailable. */ }
  }, [ready, pathname, search]);
  return null;
}

export class ChunkBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false, kind: "crash" };
    this.generation = 0;
    this.disposed = false;
    this.dismiss = () => {
      this.generation += 1;
      this.reloadProbe?.abort();
      this.setState({ failed: false });
    };
  }

  static getDerivedStateFromError(error) {
    return { failed: true, kind: isChunkLoadError(error) ? "chunk" : "crash" };
  }

  componentDidMount() {
    this.disposed = false;
  }

  componentWillUnmount() {
    this.generation += 1;
    this.disposed = true;
    this.reloadProbe?.abort();
  }

  async componentDidCatch(error) {
    captureViewError(error);
    if (!isChunkLoadError(error)) return;
    const generation = ++this.generation;
    this.reloadProbe?.abort();
    const controller = new AbortController();
    this.reloadProbe = controller;
    const href = typeof window === "undefined" ? null : window.location.href;
    const { canReload = browserCanReload, claimReload = browserReloadClaim, reload = reloadPage } = this.props;
    try {
      const reachable = await canReload({ signal: controller.signal });
      if (reachable && !this.disposed && generation === this.generation
          && href === (typeof window === "undefined" ? null : window.location.href) && claimReload()) reload();
    } catch { /* An unverified network or storage result never reloads. */ }
  }

  render() {
    if (this.state.failed) return this.props.fallback(this.dismiss, this.state.kind);
    return this.props.children;
  }
}
