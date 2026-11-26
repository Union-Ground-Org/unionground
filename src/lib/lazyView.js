import { lazy } from "react";
import { SHELL_LOAD_DEADLINE_MS, withLoadDeadline } from "./loadDeadline.js";

// React.lazy for route and overlay chunks, with ONE retry inside the factory.
//
// The retry has to live in here, not in a boundary above it: React.lazy
// MEMOISES the promise it gets back, rejection included. Once a factory has
// rejected, every subsequent render of that component replays the same stored
// rejection — re-rendering, or resetting an error boundary, never re-fetches.
// So the only place a second attempt can happen is before the rejection is
// handed to React at all.
//
// Which matters here more than it does in most apps. sw.js serves the shell
// stale-while-revalidate, so a tab can be holding an app shell that references
// chunk filenames a newer deploy has already rotated away — the first fetch
// 404s through no fault of the member's. And a member who is genuinely offline
// on a screen the warm-up has not reached yet gets the same rejection. A
// single 600ms retry covers the transient half of both (a re-validated cache
// entry, a flapping connection) without turning a real outage into a retry
// storm; ChunkBoundary catches whatever is left and offers the member the
// retry themselves.
//
// BUG-UG-SAMPLE-ROUTE-VIEWS-CAUGHT-LOAD-RENDER-BOUNDARY-20261019: in
// Chromium that in-page retry cannot succeed. The document's module map keeps
// a failed module fetch, so a second import() of the same URL replays the
// failure in about a millisecond without touching the network. Only a fresh
// document fetches again, which is why ChunkBoundary reloads the page once on
// its own (claimChunkReload below) before it leaves a member on the fallback.
export function lazyView(load, deadlineMs = SHELL_LOAD_DEADLINE_MS) {
  return lazy(() => withLoadDeadline(load().catch(() => new Promise((resolve) => {
    window.setTimeout(resolve, 600);
  }).then(load)), deadlineMs));
}

// A chunk that would not arrive, as opposed to a component that crashed while
// rendering. Chromium, WebKit and Gecko each word a failed dynamic import
// differently; withLoadDeadline rejects a hung one with a TimeoutError. A
// loader that wraps the import failure keeps it as the cause, so a short cause
// chain is followed too.
const CHUNK_LOAD_MESSAGE = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading (?:CSS )?chunk [^ ]+ failed/i;

export function isChunkLoadError(error, depth = 0) {
  if (!error || typeof error !== "object" || depth > 3) return false;
  if (error.name === "ChunkLoadError" || error.name === "TimeoutError") return true;
  if (typeof error.message === "string" && CHUNK_LOAD_MESSAGE.test(error.message)) return true;
  return isChunkLoadError(error.cause, depth + 1);
}

// A claim stays consumed until that address renders successfully. Elapsed
// time during authentication or a hung import must never re-arm a reload.
// Keep each failed address; reaching B must not forget a failed A. At capacity
// refuse automatic reloads rather than evicting an address and creating a loop.
const CHUNK_RELOAD_KEY = "ug.chunkReload";
const MAX_RELOAD_CLAIMS = 32;

function reloadClaims(storage) {
  const raw = storage.getItem(CHUNK_RELOAD_KEY);
  if (raw === null) return [];
  if (raw.length > 131072) return null;
  const value = JSON.parse(raw);
  const claims = value?.version === 2 ? value.claims : value?.address !== undefined ? [value] : null;
  return Array.isArray(claims) && claims.length <= MAX_RELOAD_CLAIMS
    && claims.every(entry => typeof entry?.address === "string" && entry.address.length <= 2048 && Number.isFinite(entry.at))
    ? claims : null;
}

function writeReloadClaims(storage, claims) {
  const serialized = JSON.stringify({ version: 2, claims });
  storage.setItem(CHUNK_RELOAD_KEY, serialized);
  return storage.getItem(CHUNK_RELOAD_KEY) === serialized;
}

export function claimChunkReload({ storage, location, online = true, now = Date.now() } = {}) {
  if (online === false || !storage || !location || !Number.isFinite(now)) return false;
  const address = `${location.pathname ?? ""}${location.search ?? ""}`;
  if (address.length > 2048) return false;
  try {
    const prior = reloadClaims(storage);
    if (!prior || prior.length >= MAX_RELOAD_CLAIMS || prior.some(entry => entry.address === address)) return false;
    return writeReloadClaims(storage, [...prior, { address, at: now }]);
  } catch { return false; }
}

export function markChunkReady({ storage, location } = {}) {
  if (!storage || !location) return false;
  const address = `${location.pathname ?? ""}${location.search ?? ""}`;
  try {
    const prior = reloadClaims(storage);
    if (!prior || !prior.some(entry => entry.address === address)) return false;
    return writeReloadClaims(storage, prior.filter(entry => entry.address !== address));
  } catch { return false; }
}

// HEAD is network-only in our service worker (which handles GET only), and
// no-store avoids the HTTP cache. Do not mistake a cached shell or onLine for
// reachability. Failure, timeout, redirects and cancellation leave the shell.
export async function canReachChunkDocument({ url, fetchImpl, online = true, signal, timeoutMs = 2000 } = {}) {
  if (online === false || !url || typeof fetchImpl !== "function" || signal?.aborted) return false;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const response = await withLoadDeadline(() => fetchImpl(url, {
      method: "HEAD", cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal,
    }), timeoutMs);
    return !controller.signal.aborted && response?.ok === true && response.redirected !== true;
  } catch { return false; }
  finally {
    signal?.removeEventListener("abort", cancel);
    controller.abort();
  }
}
