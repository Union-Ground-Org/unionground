// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isHashedAssetName } from "../scripts/carry-previous-assets.mjs";
import { validatePendingFile } from "../scripts/lib/legal-release.mjs";
import { stagedTelemetryPins } from "../scripts/lib/telemetry-disclosure-sources.mjs";
import { PORTAL_ORIGIN } from "./helpers/fictional-provider.js";

// Record #9535: the service worker serves cached hashed /assets files without
// asking the network again, keeps rechecking every unhashed file, and drops
// cached hashed files the live build no longer lists in /asset-manifest.json
// (written by scripts/carry-previous-assets.mjs). Loaded the same way as
// tests/service-worker-push.test.js, with an in-memory Cache Storage.
const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const ORIGIN = PORTAL_ORIGIN;
const href = (path) => new URL(path, ORIGIN).href;
const keyOf = (request) => (typeof request === "string" ? href(request) : request.url);

function makeCaches(initial = {}) {
  const store = new Map(Object.entries(initial).map(([name, entries]) => [name, new Map(Object.entries(entries).map(([path, body]) => [href(path), body]))]));
  const handle = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const entries = store.get(name);
    return {
      match: async (request) => (entries.has(keyOf(request)) ? new Response(entries.get(keyOf(request))) : undefined),
      put: async (request, response) => { entries.set(keyOf(request), await response.text()); },
      addAll: async (paths) => { for (const path of paths) entries.set(href(path), `cached ${path}`); },
      keys: async () => [...entries.keys()].map((url) => ({ url, method: "GET" })),
      delete: async (request) => entries.delete(keyOf(request)),
    };
  };
  const api = {
    open: async (name) => handle(name),
    keys: async () => [...store.keys()],
    delete: async (name) => store.delete(name),
    match: async (request) => {
      for (const entries of store.values()) if (entries.has(keyOf(request))) return new Response(entries.get(keyOf(request)));
      return undefined;
    },
  };
  const paths = (name) => [...(store.get(name)?.keys() ?? [])].map((url) => new URL(url).pathname).sort();
  return { api, store, paths };
}

// The Content-Type the host gives a file of that extension.
const TYPES = { js: "application/javascript; charset=utf-8", css: "text/css; charset=utf-8", woff2: "font/woff2", svg: "image/svg+xml", png: "image/png", wasm: "application/wasm" };
const typeFor = (path) => TYPES[path.split(".").pop()] ?? "text/plain; charset=utf-8";

// `server` maps a path to a body, a status number, an Error to throw, or
// { body, type } for a body with that Content-Type (type null: none).
// `windows` lists the open window clients (`{ id }`) the worker sees; the
// test may change it in place.
function loadWorker({ caches = makeCaches(), server = {}, windows = [] } = {}) {
  const registered = {};
  const fetchImpl = vi.fn(async (request) => {
    const path = new URL(keyOf(request)).pathname;
    const answer = server[path];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) return new Response("missing", { status: 404 });
    if (typeof answer === "number") return new Response("status", { status: answer });
    if (answer && typeof answer === "object") {
      return new Response(new TextEncoder().encode(answer.body), { status: 200, headers: answer.type ? { "content-type": answer.type } : {} });
    }
    return new Response(typeof answer === "function" ? answer() : answer, { status: 200, headers: { "content-type": typeFor(path) } });
  });
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, handler) => { (registered[type] ??= []).push(handler); },
    skipWaiting: () => {},
    registration: { unregister: async () => {}, showNotification: async () => {} },
    clients: { claim: async () => {}, matchAll: async () => [...windows], openWindow: async () => {} },
  };
  // eslint-disable-next-line no-new-func -- evaluates source extracted from the module under test
  new Function("self", "caches", "fetch", "URL", source)(self, caches.api, fetchImpl, URL);
  const run = async (type, extra = {}) => {
    const waits = [];
    let responded;
    const event = { ...extra, waitUntil: (promise) => waits.push(promise), respondWith: (promise) => { responded = promise; } };
    for (const handler of registered[type] ?? []) handler(event);
    const response = await responded;
    // A waitUntil may be added while the response is still being built.
    for (let index = 0; index < waits.length; index += 1) await waits[index];
    return response;
  };
  // A navigation names the client it replaces and the one it creates.
  const get = (path, mode = "no-cors", ids = {}) => run("fetch", { request: { method: "GET", url: href(path), mode }, ...ids });
  const calls = (path) => fetchImpl.mock.calls.filter(([request]) => new URL(keyOf(request)).pathname === path).length;
  return { run, get, calls, fetchImpl, caches, windows };
}

const manifest = (own, carried = []) => JSON.stringify({
  version: 1,
  files: [...own.map((name) => ({ name, origin: "own" })), ...carried.map((name) => ({ name, origin: "carried" }))],
});
const currentCache = (worker) => [...worker.caches.store.keys()].find((name) => name.startsWith("unionground-sw-"));

afterEach(() => { vi.restoreAllMocks(); });

describe("service worker /assets cache (record #9535)", () => {
  it("serves a cached hashed file without fetching it again", async () => {
    const worker = loadWorker({ server: { "/assets/index-AbCd1234.js": "build one" } });
    expect(await (await worker.get("/assets/index-AbCd1234.js")).text()).toBe("build one");
    expect(await (await worker.get("/assets/index-AbCd1234.js")).text()).toBe("build one");
    expect(await (await worker.get("/assets/index-AbCd1234.js")).text()).toBe("build one");
    expect(worker.calls("/assets/index-AbCd1234.js")).toBe(1);
  });

  it("keeps rechecking every unhashed /assets file and falls back to the cached copy only offline", async () => {
    let version = 1;
    const server = { "/assets/archivo-latin.woff2": () => `font v${version}` };
    const worker = loadWorker({ server });
    expect(await (await worker.get("/assets/archivo-latin.woff2")).text()).toBe("font v1");
    version = 2;
    expect(await (await worker.get("/assets/archivo-latin.woff2")).text()).toBe("font v2");
    expect(worker.calls("/assets/archivo-latin.woff2")).toBe(2);
    server["/assets/archivo-latin.woff2"] = new TypeError("offline");
    expect(await (await worker.get("/assets/archivo-latin.woff2")).text()).toBe("font v2");
  });

  it("treats exactly the carry script's hashed names as immutable, and no public/assets file", async () => {
    const publicNames = readdirSync(new URL("../public/assets", import.meta.url));
    const names = [...publicNames, "index-AbCd1234.js", "critical-0123456789ab.css", "index-XUMKDY1P.js.map", "index.js", "index-XUMKDY1.js", "x-ABCDEFGH.json"];
    const server = Object.fromEntries(names.map((name) => [`/assets/${name}`, name]));
    const worker = loadWorker({ server });
    for (const name of names) {
      await worker.get(`/assets/${name}`);
      await worker.get(`/assets/${name}`);
      const hashed = isHashedAssetName(name);
      expect(worker.calls(`/assets/${name}`), name).toBe(hashed ? 1 : 2);
    }
  });

  it("removes cached hashed files the live build no longer lists after a page load, and keeps the rest", async () => {
    const server = {
      "/": "<html>",
      "/asset-manifest.json": manifest(["index-NEWNEW12.js"], ["index-OLDOLD12.js"]),
      "/assets/index-NEWNEW12.js": "new",
      "/assets/index-OLDOLD12.js": "carried",
      "/assets/index-GONEGO12.js": "two builds ago",
      "/assets/archivo-latin.woff2": "font",
    };
    // One open window, reloaded: the page it replaces is its own.
    const worker = loadWorker({ server, windows: [{ id: "tab" }] });
    await worker.run("install");
    await worker.run("activate");
    for (const path of ["/assets/index-NEWNEW12.js", "/assets/index-OLDOLD12.js", "/assets/index-GONEGO12.js", "/assets/archivo-latin.woff2"]) await worker.get(path);
    const page = await worker.get("/", "navigate", { replacesClientId: "tab", resultingClientId: "next" });
    expect(await page.text()).toBe("<html>");
    expect(worker.caches.paths(currentCache(worker))).toEqual([
      "/assets/archivo-latin.woff2", "/assets/index-NEWNEW12.js", "/assets/index-OLDOLD12.js", "/offline.html",
    ]);
    // Pages themselves are never cached.
    expect(worker.caches.paths(currentCache(worker))).not.toContain("/");
  });

  it.each([
    ["is missing", 404],
    ["cannot be read", new TypeError("offline")],
    ["is not JSON", "<html>"],
    ["has another version", JSON.stringify({ version: 2, files: [{ name: "index-NEWNEW12.js" }] })],
    ["lists no files", JSON.stringify({ version: 1, files: [] })],
  ])("keeps every cached file when the build list %s", async (_label, answer) => {
    const worker = loadWorker({ server: { "/": "<html>", "/asset-manifest.json": answer, "/assets/index-OLDOLD12.js": "old" } });
    await worker.get("/assets/index-OLDOLD12.js");
    await worker.get("/", "navigate");
    expect(worker.caches.paths(currentCache(worker))).toContain("/assets/index-OLDOLD12.js");
  });

  it("reads the build list at most once per ten minutes", async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const worker = loadWorker({ server: { "/": "<html>", "/asset-manifest.json": manifest(["index-NEWNEW12.js"]) } });
    await worker.get("/", "navigate");
    await worker.get("/", "navigate");
    expect(worker.calls("/asset-manifest.json")).toBe(1);
    now += 10 * 60 * 1000;
    await worker.get("/", "navigate");
    expect(worker.calls("/asset-manifest.json")).toBe(2);
  });

  it("moves a person from the old worker to the new one without losing the offline page", async () => {
    const caches = makeCaches({
      "unionground-sw-v3": { "/offline.html": "old offline", "/assets/index-GONEGO12.js": "old build", "/assets/index-OLDOLD34.js": "older build" },
    });
    const server = { "/offline.html": "new offline", "/": "<html>" };
    // The person reloads their only tab: the new worker activates while that
    // tab is still open, so the old cache waits for the page load.
    const worker = loadWorker({ caches, server, windows: [{ id: "tab" }] });
    await worker.run("install");
    await worker.run("activate");
    expect([...caches.store.keys()].sort()).toEqual(["unionground-sw-v3", "unionground-sw-v4"]);
    await worker.get("/", "navigate", { replacesClientId: "tab", resultingClientId: "next" });
    expect([...caches.store.keys()]).toEqual(["unionground-sw-v4"]);
    expect(caches.paths("unionground-sw-v4")).toEqual(["/offline.html"]);
    server["/"] = new TypeError("offline");
    const offline = await worker.get("/", "navigate", { replacesClientId: "next", resultingClientId: "after" });
    expect(await offline.text()).toBe("cached /offline.html");
  });

  // public/sw.js is a pinned telemetry source. Its edit is staged for the next
  // legal release, like any src/ configuration edit, instead of moving the
  // published pin (which would change the legal release stamp).
  it("stages the service worker's pin for the next legal release, and no other public file", () => {
    const pin = "sha256:" + "a".repeat(64);
    const pending = (key) => ({ schema: 1, recordId: "R", release: "next", instruments: {}, paths: [], telemetryWriters: [], telemetryPins: { [key]: pin } });
    expect(stagedTelemetryPins(pending("config/public/sw.js"))).toEqual([["config/public/sw.js", pin]]);
    expect(validatePendingFile(pending("config/public/sw.js"), "R.json").recordId).toBe("R");
    for (const key of ["config/public/offline.html", "config/public/sw.jsx", "config/public/assets/sw.js", "config/public/../sw.js"]) {
      expect(() => stagedTelemetryPins(pending(key)), key).toThrow(/invalid staged telemetry pin/);
    }
  });

  it("keeps every cached file, and the old worker's cache, while another tab is open, and sweeps once it is the only one", async () => {
    const caches = makeCaches({ "unionground-sw-v3": { "/offline.html": "old offline", "/assets/index-OLDOLD34.js": "older build" } });
    const server = { "/": "<html>", "/offline.html": "new offline", "/asset-manifest.json": manifest(["index-NEWNEW12.js"]), "/assets/index-GONEGO12.js": "gone", "/assets/index-NEWNEW12.js": "new" };
    const worker = loadWorker({ caches, server, windows: [{ id: "a" }, { id: "b" }] });
    await worker.run("install");
    await worker.run("activate");
    await worker.get("/assets/index-GONEGO12.js");
    await worker.get("/assets/index-NEWNEW12.js");
    await worker.get("/", "navigate", { replacesClientId: "b", resultingClientId: "b2" });
    expect(worker.calls("/asset-manifest.json")).toBe(0);
    expect([...caches.store.keys()].sort()).toEqual(["unionground-sw-v3", "unionground-sw-v4"]);
    expect(caches.paths("unionground-sw-v4")).toContain("/assets/index-GONEGO12.js");
    // The older tab still gets its chunk from the old worker's cache, offline too.
    server["/assets/index-OLDOLD34.js"] = new TypeError("offline");
    expect(await (await worker.get("/assets/index-OLDOLD34.js")).text()).toBe("older build");
    // Tab "a" closes: the next page load in the remaining tab sweeps.
    worker.windows.splice(0, worker.windows.length, { id: "b2" });
    await worker.get("/", "navigate", { replacesClientId: "b2", resultingClientId: "b3" });
    expect([...caches.store.keys()]).toEqual(["unionground-sw-v4"]);
    expect(caches.paths("unionground-sw-v4")).toEqual(["/assets/index-NEWNEW12.js", "/offline.html"]);
  });

  it("never stores a response labelled text/html under a hashed name", async () => {
    const server = { "/assets/index-AbCd1234.js": { body: "<!doctype html>", type: "text/html; charset=utf-8" } };
    const worker = loadWorker({ server });
    expect(await (await worker.get("/assets/index-AbCd1234.js")).text()).toBe("<!doctype html>");
    expect(worker.caches.paths("unionground-sw-v4")).not.toContain("/assets/index-AbCd1234.js");
    server["/assets/index-AbCd1234.js"] = { body: "export {};", type: "text/javascript" };
    expect(await (await worker.get("/assets/index-AbCd1234.js")).text()).toBe("export {};");
    expect(await (await worker.get("/assets/index-AbCd1234.js")).text()).toBe("export {};");
    expect(worker.calls("/assets/index-AbCd1234.js")).toBe(2);
  });

  // During a navigation the page being loaded is not listed yet; the tab
  // already open is. A new tab beside it must not sweep under it.
  it("keeps every cached file when a new tab opens beside a tab that is already open", async () => {
    const caches = makeCaches({ "unionground-sw-v3": { "/offline.html": "old offline", "/assets/index-OLDOLD34.js": "older build" } });
    const server = { "/": "<html>", "/offline.html": "new offline", "/asset-manifest.json": manifest(["index-NEWNEW12.js"]), "/assets/index-GONEGO12.js": "gone" };
    const worker = loadWorker({ caches, server, windows: [{ id: "open" }] });
    await worker.run("install");
    await worker.run("activate");
    expect([...caches.store.keys()].sort()).toEqual(["unionground-sw-v3", "unionground-sw-v4"]);
    await worker.get("/assets/index-GONEGO12.js");
    await worker.get("/", "navigate", { replacesClientId: "", resultingClientId: "new-tab" });
    expect(worker.calls("/asset-manifest.json")).toBe(0);
    expect([...caches.store.keys()].sort()).toEqual(["unionground-sw-v3", "unionground-sw-v4"]);
    expect(caches.paths("unionground-sw-v4")).toContain("/assets/index-GONEGO12.js");
  });

  it("stores a hashed-name response only when it is a script, style, font, image or wasm", async () => {
    const cases = [
      ["index-AbCd1234.js", "application/javascript; charset=utf-8", true],
      ["index-AbCd1234.css", "text/css", true],
      ["font-AbCd1234.woff2", "font/woff2", true],
      ["logo-AbCd1234.svg", "image/svg+xml", true],
      ["engine-AbCd1234.wasm", "application/wasm", true],
      ["index-JsOnErr1.js", "application/json", false],
      ["index-PlainTx1.js", "text/plain; charset=utf-8", false],
      ["index-NoTyPe12.js", null, false],
    ];
    const server = Object.fromEntries(cases.map(([name, type]) => [`/assets/${name}`, { body: name, type }]));
    const worker = loadWorker({ server });
    for (const [name, , kept] of cases) {
      expect(await (await worker.get(`/assets/${name}`)).text(), name).toBe(name);
      expect(worker.caches.paths("unionground-sw-v4").includes(`/assets/${name}`), name).toBe(kept);
    }
  });
});
