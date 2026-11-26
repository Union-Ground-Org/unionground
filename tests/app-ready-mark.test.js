import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { APP_READY_MARK, observeAppReady } from "../src/lib/appReadyMark.js";

// BUG-UG-WEB-PERFORMANCE-BUDGET-DORMANT-BUNDLE-OVER-CEILING-20261109:
// the weekly budget run times the app from this mark, not from Lighthouse's
// LCP of the static crawl fallback.

const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });

describe("the app-ready mark", () => {
  it("ignores the actual crawl fallback until the real route commits", async () => {
    const html = readFileSync("index.html", "utf8");
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const root = document.importNode(parsed.getElementById("root"), true);
    document.body.append(root);
    const performance = { mark: vi.fn() };
    const stop = observeAppReady(root, { performance });
    try {
      expect(root.querySelector(".crawl-fallback")).not.toBeNull();
      expect(performance.mark).not.toHaveBeenCalled();
      root.querySelector(".crawl-fallback").append(document.createElement("p"));
      await flush();
      expect(performance.mark).not.toHaveBeenCalled();

      root.innerHTML = '<main class="loading-screen"><p role="status">Loading</p></main>';
      await flush();
      expect(performance.mark).not.toHaveBeenCalled();
      root.innerHTML = '<main><h1>Casework desk</h1></main>';
      await flush();
      expect(performance.mark).toHaveBeenCalledTimes(1);
      expect(performance.mark).toHaveBeenCalledWith(APP_READY_MARK);

      root.append(document.createElement("section"));
      await flush();
      expect(performance.mark).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      root.remove();
    }
  });

  it("waits through the boot loading screen and a route placeholder, then marks once", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const performance = { mark: vi.fn() };
    observeAppReady(root, { performance });
    await flush();
    expect(performance.mark).not.toHaveBeenCalled();

    root.innerHTML = '<main class="loading-screen"><p role="status">Loading</p></main>';
    await flush();
    expect(performance.mark).not.toHaveBeenCalled();

    root.innerHTML = '<div class="sg-app"><nav></nav><div class="view-loading"></div></div>';
    await flush();
    expect(performance.mark).not.toHaveBeenCalled();

    root.querySelector(".view-loading").replaceWith(Object.assign(document.createElement("h1"), { textContent: "My cases" }));
    await flush();
    expect(performance.mark).toHaveBeenCalledTimes(1);
    expect(performance.mark).toHaveBeenCalledWith(APP_READY_MARK);

    root.append(document.createElement("section"));
    await flush();
    expect(performance.mark).toHaveBeenCalledTimes(1);
    root.remove();
  });

  it("marks at once when the content is already committed, and does nothing without the APIs", () => {
    const root = document.createElement("div");
    root.innerHTML = "<h1>Your union, in your pocket.</h1>";
    const performance = { mark: vi.fn() };
    // Each early return still hands back a callable stop function.
    expect(observeAppReady(root, { performance })()).toBeUndefined();
    expect(performance.mark).toHaveBeenCalledWith("ug:app-ready");
    expect(observeAppReady(null, { performance })()).toBeUndefined();
    expect(observeAppReady(root, { performance: {}, MutationObserver: undefined })()).toBeUndefined();
    expect(performance.mark).toHaveBeenCalledTimes(1);
  });

  it("stops observing when the returned function is called", async () => {
    const root = document.createElement("div");
    const performance = { mark: vi.fn() };
    const stop = observeAppReady(root, { performance });
    stop();
    root.innerHTML = "<h1>Ready</h1>";
    await flush();
    expect(performance.mark).not.toHaveBeenCalled();
  });

  it("is observed from the web entry before the first render", () => {
    const main = readFileSync("src/main.jsx", "utf8");
    expect(main).toContain('observeAppReady(document.getElementById("root"));');
    expect(main.indexOf("observeAppReady(")).toBeLessThan(main.indexOf("createRoot("));
  });
});
