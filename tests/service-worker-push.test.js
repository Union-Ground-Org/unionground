// @vitest-environment node
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// public/sw.js is a classic worker script, not a module: it runs top level and
// registers handlers on `self`. Loading it inside a fabricated worker global is
// the only way to exercise the push and notificationclick paths, which are
// where the untrusted-payload handling lives.
const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

const ORIGIN = "https://unionground.example.org";

// A working in-memory Cache API. The push tests only need `caches` to exist,
// but the asset-cache tests need it to actually store, list and delete, because
// what they assert is which cache an entry lands in and how many survive an
// activate.
function fakeCaches() {
  const stores = new Map();
  const keyOf = (request) => (typeof request === "string" ? request : request.url);
  const cacheFor = (name) => {
    if (!stores.has(name)) {
      const entries = new Map();
      stores.set(name, {
        entries,
        addAll: async (urls) => { for (const url of urls) entries.set(url, { ok: true }); },
        keys: async () => [...entries.keys()],
        match: async (request) => entries.get(keyOf(request)),
        put: async (request, response) => { entries.set(keyOf(request), response); },
        delete: async (request) => entries.delete(keyOf(request)),
      });
    }
    return stores.get(name);
  };
  return {
    stores,
    open: async (name) => cacheFor(name),
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async () => undefined,
  };
}

function loadWorker({ caches: cachesImpl, fetch: fetchImpl } = {}) {
  // A real EventTarget invokes EVERY listener registered for a type, in
  // registration order. A harness that keeps only the last one cannot see an
  // unsafe handler added ahead of a safe one — it would silently test the wrong
  // function and report the worker as safe.
  const registered = {};
  const shown = [];
  const dispatch = (type, event) => {
    for (const handler of registered[type] ?? []) handler(event);
  };
  const handlers = new Proxy({}, {
    get: (_target, type) => (typeof type === "string" && registered[type]
      ? (event) => dispatch(type, event)
      : undefined),
    has: (_target, type) => Boolean(registered[type]),
  });
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, handler) => {
      (registered[type] ??= []).push(handler);
    },
    skipWaiting: () => {},
    registration: {
      unregister: async () => {},
      showNotification: (title, options) => { shown.push({ title, options }); return Promise.resolve(); },
    },
    clients: {
      claim: async () => {},
      matchAll: async () => [],
      openWindow: vi.fn(async () => {}),
    },
  };
  const caches = cachesImpl ?? { open: async () => ({ addAll: async () => {} }), keys: async () => [], delete: async () => {} };
  const fetch = fetchImpl ?? vi.fn();
  // eslint-disable-next-line no-new-func
  new Function("self", "caches", "fetch", "URL", source)(self, caches, fetch, URL);
  return { handlers, shown, self, registered, caches, fetch };
}

function pushEvent(bodyText) {
  const waits = [];
  return {
    event: {
      data: bodyText === undefined ? null : { json: () => JSON.parse(bodyText) },
      waitUntil: (promise) => waits.push(promise),
    },
    waits,
  };
}

describe("service worker push handler", () => {
  let worker;
  beforeEach(() => { worker = loadWorker(); });

  it("shows the notification from a well-formed payload", async () => {
    const { event, waits } = pushEvent(JSON.stringify({ title: "T", body: "B", url: "/m/cases" }));
    worker.handlers.push(event);
    await Promise.all(waits);
    expect(worker.shown).toHaveLength(1);
    expect(worker.shown[0].title).toBe("T");
    expect(worker.shown[0].options.body).toBe("B");
    expect(worker.shown[0].options.data.url).toBe("/m/cases");
  });

  // The defect this pins: a string-prefix check accepts "/\evil.example",
  // which the URL parser resolves to https://evil.example/ — so clicking the
  // notification would navigate the member off-site.
  it.each([
    ["/\\evil.example", "backslash authority"],
    ["/\\/evil.example", "mixed slash authority"],
    ["//evil.example", "protocol-relative"],
    ["https://evil.example/x", "absolute cross-origin"],
    ["\\\\evil.example", "double backslash"],
    // The URL parser STRIPS leading control characters before parsing, so a
    // prefix check sees a harmless-looking string while the browser resolves an
    // authority. These are the same class as the backslash bypass.
    ["\t//evil.example", "tab then protocol-relative"],
    ["\n//evil.example", "newline then protocol-relative"],
    ["\r//evil.example", "carriage return then protocol-relative"],
    ["/\t/evil.example", "tab inside the path"],
    [" https://evil.example/x", "leading space then absolute"],
    ["java\tscript:alert(1)", "tab-split scheme"],
    ["about:blank", "non-http scheme"],
    ["javascript:alert(1)", "javascript scheme"],
  ])("rejects %s (%s) and falls back to /m", async (hostile) => {
    const { event, waits } = pushEvent(JSON.stringify({ title: "T", url: hostile }));
    worker.handlers.push(event);
    await Promise.all(waits);
    expect(worker.shown[0].options.data.url).toBe("/m");
  });

  // Guards the harness, not the worker. A real EventTarget runs every listener
  // registered for a type; if this fabricated `self` kept only the last one, an
  // unsafe handler registered ahead of a safe one would never be invoked and
  // every test above would pass against a worker that navigates off-origin.
  it("dispatches every registered listener, like a real EventTarget", () => {
    const { self, handlers } = loadWorker();
    const seen = [];
    self.addEventListener("push", () => seen.push("extra-first"));
    self.addEventListener("push", () => seen.push("extra-second"));
    handlers.push({ data: null, waitUntil: () => {} });
    expect(seen).toEqual(["extra-first", "extra-second"]);
  });

  it("registers exactly one push and one notificationclick listener", () => {
    const { registered } = loadWorker();
    expect(registered.push).toHaveLength(1);
    expect(registered.notificationclick).toHaveLength(1);
  });

  it("keeps a same-origin absolute url as a path", async () => {
    const { event, waits } = pushEvent(JSON.stringify({ title: "T", url: `${ORIGIN}/m/events?tab=1#x` }));
    worker.handlers.push(event);
    await Promise.all(waits);
    expect(worker.shown[0].options.data.url).toBe("/m/events?tab=1#x");
  });

  it.each([
    ["null", "json null"],
    ["[1,2,3]", "json array"],
    ["\"text\"", "json string"],
    ["17", "json number"],
  ])("still shows a notification for %s (%s)", async (raw) => {
    const { event, waits } = pushEvent(raw);
    worker.handlers.push(event);
    await Promise.all(waits);
    expect(worker.shown).toHaveLength(1);
    expect(worker.shown[0].title).toBe("Union Ground");
    expect(worker.shown[0].options.data.url).toBe("/m");
  });

  it("survives a payload that is not JSON at all", async () => {
    const waits = [];
    worker.handlers.push({ data: { json: () => { throw new SyntaxError("nope"); } }, waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    expect(worker.shown).toHaveLength(1);
    expect(worker.shown[0].title).toBe("Union Ground");
  });

  it("ignores a prototype-pollution shaped payload", async () => {
    const { event, waits } = pushEvent(JSON.stringify({ __proto__: { title: "injected" }, title: 42 }));
    worker.handlers.push(event);
    await Promise.all(waits);
    expect(worker.shown[0].title).toBe("Union Ground");
    expect({}.title).toBeUndefined();
  });
});

describe("service worker notificationclick handler", () => {
  it("closes the notification and re-validates the stored url before navigating", async () => {
    const worker = loadWorker();
    const navigate = vi.fn(async () => {});
    const focus = vi.fn(async () => {});
    worker.self.clients.matchAll = async () => [{ url: `${ORIGIN}/m`, focus, navigate }];

    const close = vi.fn();
    const waits = [];
    worker.handlers.notificationclick({
      notification: { close, data: { url: "/\\evil.example" } },
      waitUntil: (p) => waits.push(p),
    });
    await Promise.all(waits);

    expect(close).toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/m");
  });

  it("opens a window when no same-origin client is focusable", async () => {
    const worker = loadWorker();
    worker.self.clients.matchAll = async () => [{ url: "https://other.example/x", focus: vi.fn(), navigate: vi.fn() }];
    const waits = [];
    worker.handlers.notificationclick({
      notification: { close: vi.fn(), data: { url: "/m/rights" } },
      waitUntil: (p) => waits.push(p),
    });
    await Promise.all(waits);
    expect(worker.self.clients.openWindow).toHaveBeenCalledWith("/m/rights");
  });
});

describe("service worker kill switch", () => {
  it("suppresses both notification paths when KILL is on", async () => {
    const killed = source.replace("const KILL = false;", "const KILL = true;");
    const handlers = {};
    const shown = [];
    const openWindow = vi.fn(async () => {});
    const self = {
      location: { origin: ORIGIN },
      addEventListener: (type, handler) => { handlers[type] = handler; },
      skipWaiting: () => {},
      registration: { unregister: async () => {}, showNotification: (t, o) => { shown.push({ t, o }); return Promise.resolve(); } },
      clients: { claim: async () => {}, matchAll: async () => [], openWindow },
    };
    // eslint-disable-next-line no-new-func
    new Function("self", "caches", "fetch", "URL", killed)(
      self,
      { open: async () => ({ addAll: async () => {} }), keys: async () => [], delete: async () => {} },
      vi.fn(),
      URL,
    );

    const waits = [];
    handlers.push({ data: { json: () => ({ title: "T" }) }, waitUntil: (p) => waits.push(p) });
    const close = vi.fn();
    handlers.notificationclick({ notification: { close, data: { url: "/m" } }, waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);

    expect(shown).toHaveLength(0);
    expect(openWindow).not.toHaveBeenCalled();
    // The notification is still dismissed — leaving it stuck on screen would be
    // its own bug.
    expect(close).toHaveBeenCalled();
  });
});
