import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, NOT_FOUND_GRACE_MS } from "../src/AppRouter.jsx";
import { primeDemoHat } from "./helpers/demoHat.js";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

// BUG-UG-NOT-FOUND-FLASH-ON-PAGE-TRANSITIONS-20261103: the owner saw
// the not-found page for a split second between pages. The whole App on the
// fixture data, in both shells: a page whose chunk arrives late keeps the
// loading state, an address that resolves within the grace opens its page, and
// neither paints "Page not found" for even one mutation. A truly unknown
// address still gets the not-found page, after the grace.

const CHUNK_DELAY_MS = NOT_FOUND_GRACE_MS * 2;

// The Messages page is its own lazy chunk; hold it past the grace so the
// route is still settling when the grace would have ended.
vi.mock("../src/views/MessagesView.jsx", async (importOriginal) => {
  await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
  return importOriginal();
});

// Records the first moment the not-found page is in the document, checked on
// every DOM mutation so a single-frame paint is caught.
function watchNotFound() {
  const seen = [];
  const observer = new MutationObserver(() => {
    if (!seen.length && document.body.textContent.includes("Page not found")) {
      seen.push({ at: performance.now(), path: window.location.pathname });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return { seen, stop: () => observer.disconnect() };
}

let watcher;

beforeEach(() => {
  window.scrollTo = vi.fn();
  window.localStorage.clear();
  window.sessionStorage.clear();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
  primeDemoHat("member");
  watcher = watchNotFound();
});

afterEach(() => {
  watcher.stop();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe.each(["classic", "alt"])("route transitions in the %s shell", (shell) => {
  it("keeps the loading state while a route chunk arrives late and never paints not-found", async () => {
    window.history.replaceState({}, "", `/m?demo=1&shell=${shell}`);
    render(<App />);
    window.history.pushState({}, "", `/m/messages?demo=1&shell=${shell}`);
    fireEvent.popState(window);
    expect(await screen.findByRole("heading", { level: 1, name: "Messages" }, { timeout: runnerTimeout(20_000) })).toBeInTheDocument();
    expect(watcher.seen).toEqual([]);
  }, 30_000);

  it("opens an address that resolves within the grace without painting not-found", async () => {
    window.history.replaceState({}, "", `/m/route-settling?demo=1&shell=${shell}`);
    render(<App />);
    // The address resolves before the grace ends, as a page rewritten in
    // place or a Back that lands at once does.
    window.history.replaceState({}, "", `/m/messages?demo=1&shell=${shell}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Messages" }, { timeout: runnerTimeout(20_000) })).toBeInTheDocument();
    expect(watcher.seen).toEqual([]);
  }, 30_000);
});

describe("a truly unknown address", () => {
  it("still shows the not-found page, only after the grace", async () => {
    window.history.replaceState({}, "", "/m/not-a-route");
    const start = performance.now();
    render(<App />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    expect(screen.queryByText("Page not found")).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" }, { timeout: runnerTimeout(8_000) })).toBeInTheDocument();
    expect(watcher.seen).toHaveLength(1);
    expect(watcher.seen[0].path).toBe("/m/not-a-route");
    expect(watcher.seen[0].at - start).toBeGreaterThanOrEqual(NOT_FOUND_GRACE_MS);
  });
});
