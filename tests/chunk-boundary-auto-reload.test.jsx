import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Suspense } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChunkBoundary, ChunkReady } from "../src/components/ChunkBoundary.jsx";
import { canReachChunkDocument, claimChunkReload, markChunkReady, lazyView } from "../src/lib/lazyView.js";

// BUG-UG-SAMPLE-ROUTE-VIEWS-CAUGHT-LOAD-RENDER-BOUNDARY-20261019: in
// the SAMPLE workday, 14 desk and member views were left on the boundary's
// "Load failed" for the whole 20 s each bot waited. A cold Vite dev server
// (bots/local-app.mjs) failed a view's dynamic import in 3 of 14 local cold
// runs; both times the 600 ms retry was exercised it failed again in 0-1 ms,
// because Chromium's module map keeps the failed fetch. Only a fresh document fetches
// again, so the boundary now reloads once by itself.
vi.mock("../src/lib/deferredObservability.js", () => ({ captureViewError: vi.fn() }));

const fallback = (dismiss, kind) => (
  <div role="alert" data-kind={kind}>
    <button type="button" onClick={dismiss}>Try again</button>
  </div>
);

function Crash() {
  throw new TypeError("Cannot read properties of undefined (reading 'map')");
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

// The views the workday's full boundary snapshots were opened on, with the
// error text Chromium gives a failed dynamic import of their dev-server module.
const AFFECTED = [
  ["CampaignsView", "/m/campaigns/engagement/surveys"],
  ["EventsDeskView", "/m/events-desk"],
  ["StewardView", "/m/steward/appointments"],
  ["AdminView", "/m/admin/chapter-handshake"],
  ["SearchView", "/m/search"],
];

describe("ChunkBoundary reloads once on a chunk failure", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, redirected: false }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the fallback when no browser window is available", async () => {
    const reload = vi.fn();
    const boundary = new ChunkBoundary({ fallback, reload });
    vi.stubGlobal("window", undefined);
    await boundary.componentDidCatch(new Error("Importing a module script failed."));
    expect(reload).not.toHaveBeenCalled();
    const forcedProbe = new ChunkBoundary({ fallback, reload, canReload: () => true });
    await forcedProbe.componentDidCatch(new Error("Importing a module script failed."));
    expect(reload).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(<ChunkReady />)).toBe("");
  });

  it("uses the default browser probe, persistent claim and reload exactly once", async () => {
    const reload = vi.fn(), storage = memoryStorage();
    const fetchPage = vi.fn().mockResolvedValue({ ok: true, redirected: false });
    vi.stubGlobal("window", { sessionStorage: storage, navigator: { onLine: true }, fetch: fetchPage,
      location: { href: "https://example.test/m/events", pathname: "/m/events", search: "", reload } });
    const boundary = new ChunkBoundary({ fallback });
    await boundary.componentDidCatch(new Error("Importing a module script failed."));
    expect(fetchPage).toHaveBeenCalledWith("https://example.test/m/events", expect.objectContaining({ method: "HEAD", cache: "no-store" }));
    expect(reload).toHaveBeenCalledTimes(1);
    await boundary.componentDidCatch(new Error("Importing a module script failed."));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps the fallback when the browser denies access to sessionStorage", async () => {
    const reload = vi.fn();
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new DOMException("Storage access denied", "SecurityError");
    });
    const boundary = new ChunkBoundary({ fallback, reload });
    await boundary.componentDidCatch(new Error("Importing a module script failed."));
    expect(reload).not.toHaveBeenCalled();
  });

  it("retries a recovered view when the fallback is dismissed", () => {
    let failing = true;
    function RecoveringView() {
      if (failing) throw new Error("View data was temporarily unavailable");
      return <p>Recovered view</p>;
    }
    render(<ChunkBoundary fallback={fallback}><RecoveringView /></ChunkBoundary>);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("Recovered view")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(AFFECTED)("reloads the page once when %s's module will not load", async (view) => {
    const reload = vi.fn();
    const claimReload = vi.fn(() => true);
    const Failed = lazyView(() => Promise.reject(new TypeError(`Failed to fetch dynamically imported module: http://127.0.0.1:5288/src/views/${view}.jsx`)), 5_000);
    render(
      <ChunkBoundary fallback={fallback} claimReload={claimReload} reload={reload}>
        <Suspense fallback={<div role="status">Loading</div>}>
          <Failed />
        </Suspense>
      </ChunkBoundary>,
    );
    expect(await screen.findByRole("alert", {}, { timeout: 3_000 })).toHaveAttribute("data-kind", "chunk");
    expect(claimReload).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it("reloads after a hung chunk passes its deadline", async () => {
    const reload = vi.fn();
    const Hung = lazyView(() => new Promise(() => {}), 40);
    render(
      <ChunkBoundary fallback={fallback} claimReload={() => true} reload={reload}>
        <Suspense fallback={<div role="status">Loading</div>}>
          <Hung />
        </Suspense>
      </ChunkBoundary>,
    );
    expect(await screen.findByRole("alert")).toHaveAttribute("data-kind", "chunk");
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it("leaves the fallback in place when the reload was already spent", async () => {
    const reload = vi.fn();
    const Failed = lazyView(() => Promise.reject(new TypeError("Importing a module script failed.")), 5_000);
    render(
      <ChunkBoundary fallback={fallback} claimReload={() => false} reload={reload}>
        <Suspense fallback={<div role="status">Loading</div>}>
          <Failed />
        </Suspense>
      </ChunkBoundary>,
    );
    expect(await screen.findByRole("alert", {}, { timeout: 3_000 })).toHaveAttribute("data-kind", "chunk");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it("never reloads for a render crash, which a reload would repeat", () => {
    const reload = vi.fn();
    const claimReload = vi.fn(() => true);
    render(
      <ChunkBoundary fallback={fallback} claimReload={claimReload} reload={reload}>
        <Crash />
      </ChunkBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveAttribute("data-kind", "crash");
    expect(claimReload).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("keeps the shell when onLine is true but the real document probe fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const claimReload = vi.fn(() => true), reload = vi.fn();
    const boundary = new ChunkBoundary({ fallback, claimReload, reload });
    await boundary.componentDidCatch(new Error("Importing a module script failed."));
    expect(fetch).toHaveBeenCalledWith(window.location.href, expect.objectContaining({ method: "HEAD", cache: "no-store", redirect: "error" }));
    expect(claimReload).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("waits for real reachability before consuming the reload claim", async () => {
    let finish;
    vi.stubGlobal("fetch", vi.fn(() => new Promise(resolve => { finish = resolve; })));
    const claimReload = vi.fn(() => true), reload = vi.fn();
    const boundary = new ChunkBoundary({ fallback, claimReload, reload });
    const work = boundary.componentDidCatch(new Error("Importing a module script failed."));
    expect(claimReload).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    finish({ ok: true, redirected: false });
    await work;
    expect(claimReload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not probe or reload when offline or fetch is unavailable", async () => {
    const reload = vi.fn();
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    await new ChunkBoundary({ fallback, reload }).componentDidCatch(new Error("Importing a module script failed."));
    expect(fetch).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", undefined);
    await new ChunkBoundary({ fallback, reload }).componentDidCatch(new Error("Importing a module script failed."));
    expect(reload).not.toHaveBeenCalled();
  });

  it("contains a failed probe implementation and supports a strict-mode remount", async () => {
    const reload = vi.fn();
    const boundary = new ChunkBoundary({ fallback, reload, canReload: vi.fn().mockRejectedValueOnce(new Error("probe failed")).mockResolvedValue(true), claimReload: () => true });
    await boundary.componentDidCatch(new Error("Importing a module script failed."));
    expect(reload).not.toHaveBeenCalled();
    boundary.componentWillUnmount();
    boundary.componentDidMount();
    await boundary.componentDidCatch(new Error("Importing a module script failed."));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each(["unmount", "dismiss", "newer error", "navigation"])("ignores a stale reachable result after %s", async action => {
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    const claimReload = vi.fn(() => true), reload = vi.fn();
    const boundary = new ChunkBoundary({ fallback, claimReload, reload, canReload: vi.fn().mockReturnValueOnce(pending).mockResolvedValue(false) });
    boundary.setState = vi.fn();
    const original = window.location.href;
    const work = boundary.componentDidCatch(new Error("Importing a module script failed."));
    if (action === "unmount") boundary.componentWillUnmount();
    if (action === "dismiss") boundary.dismiss();
    if (action === "newer error") await boundary.componentDidCatch(new Error("Importing a module script failed."));
    if (action === "navigation") window.history.replaceState({}, "", "/other-view");
    resolve(true);
    await work;
    window.history.replaceState({}, "", original);
    expect(claimReload).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("claimChunkReload", () => {
  const location = { pathname: "/m/steward/appointments", search: "" };

  it("keeps slow-startup and A/B/A claims consumed until that address is ready", () => {
    const storage = memoryStorage();
    expect(claimChunkReload({ storage, location, now: 1_000 })).toBe(true);
    expect(claimChunkReload({ storage, location, now: 121_000 })).toBe(false);
    expect(claimChunkReload({ storage, location: { pathname: "/m/campaigns", search: "" }, now: 2_000 })).toBe(true);
    expect(claimChunkReload({ storage, location, now: 122_000 })).toBe(false);
    expect(markChunkReady({ storage, location: { pathname: "/m/campaigns" } })).toBe(true);
    expect(claimChunkReload({ storage, location, now: 123_000 })).toBe(false);
    expect(markChunkReady({ storage, location })).toBe(true);
    expect(claimChunkReload({ storage, location, now: 124_000 })).toBe(true);
  });

  it("migrates legacy claims without a clock or slow-startup loophole", () => {
    const storage = memoryStorage();
    storage.setItem("ug.chunkReload", JSON.stringify({ address: location.pathname, at: 50_000 }));
    expect(claimChunkReload({ storage, location, now: 1_000 })).toBe(false);
    expect(claimChunkReload({ storage, location, now: 5_000_000 })).toBe(false);
    expect(markChunkReady({ storage, location })).toBe(true);
    expect(claimChunkReload({ storage, location, now: 5_000_001 })).toBe(true);
  });

  it.each([
    [{}, ""],
    [{ pathname: "/m/events" }, "/m/events"],
    [{ search: "?view=events" }, "?view=events"],
  ])("records an address when location omits a pathname or query", (partialLocation, address) => {
    const storage = memoryStorage();
    expect(claimChunkReload({ storage, location: partialLocation, now: 1_000 })).toBe(true);
    expect(JSON.parse(storage.getItem("ug.chunkReload"))).toEqual({ version: 2, claims: [{ address, at: 1_000 }] });
    expect(claimChunkReload({ storage, location: partialLocation, now: 1_001 })).toBe(false);
  });

  it("refuses offline, without storage, and when storage throws", () => {
    expect(claimChunkReload({ storage: memoryStorage(), location, online: false })).toBe(false);
    expect(claimChunkReload({ storage: null, location })).toBe(false);
    expect(claimChunkReload({ storage: memoryStorage(), location: null })).toBe(false);
    const throwing = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => {} };
    expect(claimChunkReload({ storage: throwing, location })).toBe(false);
    const full = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } };
    expect(claimChunkReload({ storage: full, location })).toBe(false);
  });

  it("refuses an unreadable stored claim rather than risk repeating it", () => {
    const storage = memoryStorage();
    storage.setItem("ug.chunkReload", "{not json");
    expect(claimChunkReload({ storage, location, now: 1_000 })).toBe(false);
    expect(claimChunkReload({ storage, location, now: 1_001 })).toBe(false);
  });

  it("keeps a bounded set without evicting an earlier failed address", () => {
    const storage = memoryStorage();
    for (let i = 0; i < 32; i++) expect(claimChunkReload({ storage, location: { pathname: `/view/${i}` } })).toBe(true);
    expect(claimChunkReload({ storage, location: { pathname: "/overflow" } })).toBe(false);
    expect(claimChunkReload({ storage, location: { pathname: "/view/0" } })).toBe(false);
    expect(markChunkReady({ storage, location: { pathname: "/view/0" } })).toBe(true);
    expect(claimChunkReload({ storage, location: { pathname: "/overflow" } })).toBe(true);
  });

  it.each(["null", "{}", '{"version":2,"claims":null}', '{"version":2,"claims":[null]}',
    '{"version":2,"claims":[{"address":"/","at":"bad"}]}',
    JSON.stringify({ version: 2, claims: Array.from({ length: 33 }, (_, at) => ({ address: `/${at}`, at })) }),
    JSON.stringify({ version: 2, claims: [{ address: "/".repeat(2049), at: 1 }] }), "x".repeat(131073)])("refuses invalid retained state %#", value => {
    const storage = memoryStorage(); storage.setItem("ug.chunkReload", value);
    expect(claimChunkReload({ storage, location })).toBe(false);
    expect(markChunkReady({ storage, location })).toBe(false);
  });

  it("keeps claims safe when storage cannot verify a write or readiness cannot be saved", () => {
    expect(claimChunkReload()).toBe(false);
    expect(claimChunkReload({ storage: memoryStorage(), location, now: NaN })).toBe(false);
    expect(claimChunkReload({ storage: memoryStorage(), location: { pathname: "/".repeat(2049) } })).toBe(false);
    expect(claimChunkReload({ storage: { getItem: () => null, setItem: () => {} }, location })).toBe(false);
    expect(markChunkReady()).toBe(false);
    expect(markChunkReady({ storage: memoryStorage() })).toBe(false);
    expect(markChunkReady({ storage: memoryStorage(), location })).toBe(false);
    expect(markChunkReady({ storage: { getItem: () => { throw new Error("blocked"); } }, location })).toBe(false);
    const storage = memoryStorage();
    expect(claimChunkReload({ storage, location: {} })).toBe(true);
    expect(markChunkReady({ storage, location: {} })).toBe(true);
    expect(claimChunkReload({ storage, location })).toBe(true);
    storage.setItem = () => { throw new Error("blocked"); };
    expect(markChunkReady({ storage, location })).toBe(false);
  });

  it("keeps rendering when readiness cannot access browser storage", () => {
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => { throw new Error("blocked"); });
    expect(() => render(<ChunkReady />)).not.toThrow();
    vi.restoreAllMocks();
  });

  it("does not release a claim while the replacement route is suspended or data is pending", async () => {
    window.sessionStorage.clear();
    const location = { pathname: window.location.pathname, search: window.location.search };
    expect(claimChunkReload({ storage: window.sessionStorage, location, now: 0 })).toBe(true);
    let complete;
    const Pending = lazyView(() => new Promise(resolve => { complete = resolve; }));
    const { rerender } = render(<Suspense fallback={<p>Still booting</p>}><Pending /><ChunkReady ready={false} /></Suspense>);
    expect(screen.getByText("Still booting")).toBeInTheDocument();
    expect(claimChunkReload({ storage: window.sessionStorage, location, now: 120_000 })).toBe(false);
    await act(async () => { complete({ default: () => <p>Ready view</p> }); });
    expect(screen.getByText("Ready view")).toBeInTheDocument();
    expect(claimChunkReload({ storage: window.sessionStorage, location, now: 120_001 })).toBe(false);
    rerender(<Suspense fallback={<p>Still booting</p>}><Pending /><ChunkReady /></Suspense>);
    expect(claimChunkReload({ storage: window.sessionStorage, location, now: 120_002 })).toBe(true);
    window.sessionStorage.clear();
  });
});

describe("network-only document reachability", () => {
  it.each([{ ok: true }, { ok: false }, { ok: true, redirected: true }, null])("requires a successful unredirected HTTP answer: %j", async response => {
    const fetchImpl = vi.fn().mockResolvedValue(response);
    expect(await canReachChunkDocument({ url: "https://example.test/m/home", fetchImpl })).toBe(response?.ok === true && response?.redirected !== true);
  });

  it("bounds a hung network request and aborts it", async () => {
    vi.useFakeTimers();
    let signal;
    const work = canReachChunkDocument({ url: "https://example.test/", timeoutMs: 20,
      fetchImpl: vi.fn((_url, options) => { signal = options.signal; return new Promise(() => {}); }) });
    await vi.advanceTimersByTimeAsync(20);
    expect(await work).toBe(false);
    expect(signal.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("refuses missing, offline and pre-cancelled probes and handles a rejected request", async () => {
    const controller = new AbortController(); controller.abort();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await canReachChunkDocument()).toBe(false);
    expect(await canReachChunkDocument({ url: "/" })).toBe(false);
    expect(await canReachChunkDocument({ url: "/", fetchImpl, online: false })).toBe(false);
    expect(await canReachChunkDocument({ url: "/", fetchImpl, signal: controller.signal })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await canReachChunkDocument({ url: "/", fetchImpl })).toBe(false);
  });

  it("forwards cancellation and refuses a response delivered after it", async () => {
    const controller = new AbortController(); let finish; let requestSignal;
    const work = canReachChunkDocument({ url: "/", signal: controller.signal,
      fetchImpl: (_url, options) => { requestSignal = options.signal; return new Promise(resolve => { finish = resolve; }); } });
    controller.abort();
    finish({ ok: true });
    expect(await work).toBe(false);
    expect(requestSignal.aborted).toBe(true);
  });
});

describe("the route view boundary keeps the automatic reload", () => {
  const appSource = readFileSync(resolve(process.cwd(), "src/AppRouter.jsx"), "utf8");

  it("does not override claimReload or reload on either App boundary", () => {
    const blocks = appSource.split("<ChunkBoundary").slice(1).map((rest) => rest.slice(0, rest.indexOf(">\n")));
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      expect(block).not.toMatch(/claimReload=|reload=/);
    }
  });
});
