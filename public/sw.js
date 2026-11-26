// Union Ground service worker — handrolled, minimal. Ported from the old
// app's conservative worker, adapted to the Vite SPA.
//
// Strategy (deliberately conservative for a live site):
//  • Navigations: network-first, offline.html as the fallback. Never cache
//    HTML. Keeps stale-page-bug risk at zero.
//  • /assets/* with a content hash in the name: cache-first, never fetched
//    again once cached. Safe because Vite hashes the filenames; a cached
//    asset can't be "wrong." After a page load, when no window other than the
//    one being replaced and the one being loaded is open, the worker drops
//    older caches and cached hashed files the live build no longer lists in
//    /asset-manifest.json; with another tab open (perhaps on an older build)
//    it keeps them and waits for a later load. Only a script, style, font,
//    image or wasm response is kept under a hashed name.
//  • /assets/* without a hash (the fonts and favicon public/assets ships):
//    network-first, the cached copy only when offline, so an update to one
//    always reaches people.
//  • Everything else (incl. /api/ and Supabase): network-only. Member data,
//    auth, and mutations are never cached.
//  • Cross-origin: untouched.
//
// KILL SWITCH — flip to `true`, bump VERSION, deploy. The activating worker
// drops all caches and unregisters, so every future navigation in every tab
// loads service-worker-free. Open tabs are deliberately NOT force-reloaded:
// navigate() only works on clients this worker controls (a fresh kill worker
// controls none), and claim()-then-navigate would reload-loop against the
// unconditional re-registration in src/main.jsx. Navigations are always
// network-first and HTML is never cached, so open tabs heal on their next
// click or reload. For a permanent shutdown also remove the register call
// in src/main.jsx in the same deploy.
const KILL = false;
// Bump on any change to OFFLINE_URL contents — install handler pre-caches the
// offline page and old caches are dropped on activate when the version differs.
// v2: web-push display + notification click focus/navigate (PR5).
// v3: offline page shows the Union Ground logo mark.
// v4: hashed assets cache-first and pruned per build; dropping the v3
//     cache once (when no other tab is open) clears every chunk it kept.
const VERSION = "v4";

const CACHE = `unionground-sw-${VERSION}`;
const OFFLINE_URL = "/offline.html";
const STATIC_PREFIX = "/assets/";
// Every hashed file the live deployment serves (its own and the ones carried
// from the build before it), written by scripts/carry-previous-assets.mjs.
const ASSET_MANIFEST_URL = "/asset-manifest.json";
// The same names as HASHED_NAME in scripts/carry-previous-assets.mjs
// (tests/service-worker-asset-cache.test.js).
const HASHED_ASSET = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,150}-(?:[A-Za-z0-9_-]{8}|[0-9a-f]{12})\.(?:js|css|woff2|woff|ttf|otf|svg|png|jpg|jpeg|webp|avif|gif|ico|wasm)$/;
// What a hashed file may be; anything else (an error page, JSON, plain text)
// is served but never kept.
const ASSET_TYPE = /^(?:text\/javascript|application\/(?:x-)?javascript|text\/css|font\/|application\/(?:x-)?font-|image\/|application\/wasm)/i;
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
let lastPruneAt = 0;

// True when no window of this site is open other than the clients named. The
// page being loaded is not listed until it is ready, and the page it replaces
// still is, so a navigation names both of its own clients; any other window
// may be a tab on an older build that still needs its files.
async function noOtherWindowOpen(ownIds = []) {
  const own = new Set(ownIds.filter(Boolean));
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return windows.every((client) => own.has(client.id));
}

// Drops caches of earlier worker versions.
async function dropOlderCaches() {
  const names = await caches.keys();
  await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
}

// With no other tab open, drops older caches and the cached hashed files the
// live build no longer lists. Anything short of a readable version-1 list with
// at least one name leaves this version's cache as it is.
async function pruneUnlistedAssets(ownIds) {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  try {
    if (!(await noOtherWindowOpen(ownIds))) return;
    lastPruneAt = now;
    await dropOlderCaches();
    const response = await fetch(ASSET_MANIFEST_URL, { cache: "no-cache" });
    if (!response.ok) return;
    const manifest = await response.json();
    if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files)) return;
    const listed = new Set(manifest.files.map((file) => file && file.name).filter((name) => typeof name === "string"));
    if (!listed.size) return;
    const cache = await caches.open(CACHE);
    const requests = await cache.keys();
    await Promise.all(requests.map((cached) => {
      const { pathname } = new URL(cached.url);
      if (!pathname.startsWith(STATIC_PREFIX)) return undefined;
      const name = pathname.slice(STATIC_PREFIX.length);
      return HASHED_ASSET.test(name) && !listed.has(name) ? cache.delete(cached) : undefined;
    }));
  } catch {
    // A failed read leaves the cache as it is; the next page load tries again.
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([OFFLINE_URL])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      if (KILL) {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
        await self.registration.unregister();
        return;
      }
      // With any window open, older caches wait for a later page load.
      if (await noOtherWindowOpen()) await dropOlderCaches();
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    const page = fetch(request);
    event.respondWith(
      page.catch(async () => {
        const cached = (await (await caches.open(CACHE)).match(OFFLINE_URL)) || (await caches.match(OFFLINE_URL));
        return cached || Response.error();
      }),
    );
    const ownIds = [event.replacesClientId, event.resultingClientId];
    event.waitUntil(page.then((response) => (response.ok ? pruneUnlistedAssets(ownIds) : undefined), () => undefined));
    return;
  }

  if (url.pathname.startsWith(STATIC_PREFIX)) {
    const hashed = HASHED_ASSET.test(url.pathname.slice(STATIC_PREFIX.length));
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const store = (response) => {
          const asset = ASSET_TYPE.test(response.headers.get("content-type") || "");
          if (response.ok && (!hashed || asset)) event.waitUntil(cache.put(request, response.clone()).catch(() => undefined));
          return response;
        };
        if (hashed) {
          // An older version's cache still serves a tab of an older build
          // until it is dropped.
          const cached = (await cache.match(request)) || (await caches.match(request));
          if (cached) return cached;
          return fetch(request).then(store, () => Response.error());
        }
        return fetch(request).then(store, async () => (await cache.match(request)) || Response.error());
      })(),
    );
  }
  // Everything else: network-only.
});

// Web push (PR5). The dispatcher only ever sends generic per-topic payloads
// (never notification title/body content), but the worker still treats the
// payload as untrusted: strings only, and click targets stay same-origin
// paths — a payload can never navigate the member off-site.
// Anyone holding an endpoint plus its keys can deliver arbitrary bytes here,
// so the payload is untrusted input, not our own data.
//
// String-prefix checks are NOT sufficient to keep a click same-origin. The
// browser resolves the value with the WHATWG URL parser, which treats a
// backslash as a path separator in the authority position: "/\evil.example"
// starts with "/", does not start with "//", and still resolves to
// https://evil.example/. Tab-, newline- and CR-stripping produce the same
// class of escape. Resolving against our own origin and demanding exact origin
// equality is the only check that matches what navigate()/openWindow() will
// actually do.
const DEFAULT_NOTIFICATION_PATH = "/m";

function sameOriginPath(value) {
  if (typeof value !== "string" || !value) return DEFAULT_NOTIFICATION_PATH;
  try {
    const resolved = new URL(value, self.location.origin);
    if (resolved.origin !== self.location.origin) return DEFAULT_NOTIFICATION_PATH;
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return DEFAULT_NOTIFICATION_PATH;
  }
}

self.addEventListener("push", (event) => {
  if (KILL) return;
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  // `null`, `[1,2,3]` and `"text"` are all valid JSON. Only a plain object has
  // the fields below; anything else reads as undefined off a fresh object
  // rather than throwing before showNotification ever runs.
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = {};

  const title = typeof payload.title === "string" && payload.title ? payload.title : "Union Ground";
  const body = typeof payload.body === "string" ? payload.body : "";
  const url = sameOriginPath(payload.url);
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // A killed worker must not act on a notification that is still on screen
  // from before the shutdown.
  if (KILL) return;
  // Re-validated at click time: the stored value came from a payload, and this
  // is the last point before it reaches navigate()/openWindow().
  const url = sameOriginPath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          await client.focus();
          if ("navigate" in client) await client.navigate(url).catch(() => undefined);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
