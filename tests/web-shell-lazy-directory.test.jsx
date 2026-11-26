import { existsSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../src/lib/i18n.js";

// PERF-UG-WEB-SHELL-AND-PER-LANGUAGE-BUNDLES-20261011: a standalone
// public page is a lazy chunk under App's standalone Suspense and
// ChunkBoundary. Union Ground proved this on its public chapter directory,
// which Union Ground leaves out, so the same boundary is proved here on the
// /about page's AboutView chunk. The module boundary is replaced so a case can
// make the chunk fail; each case imports a fresh App so React.lazy's memoised
// result from one case cannot leak into the next. The mock is registered per
// case (vi.doMock) because the mock registry outlives vi.resetModules.
const ABOUT_CHUNK = "../src/views/AboutView.jsx";
const chunk = { failures: 0, calls: 0 };
function aboutChunk() {
  chunk.calls += 1;
  if (chunk.failures > 0) {
    chunk.failures -= 1;
    throw new TypeError("Failed to fetch dynamically imported module");
  }
  return {
    AboutView: () => <main><h1>About chunk for {window.location.pathname}</h1></main>,
  };
}

async function freshApp() {
  vi.resetModules();
  vi.doMock(ABOUT_CHUNK, aboutChunk);
  return (await import("../src/AppRouter.jsx")).App;
}

beforeEach(() => {
  chunk.failures = 0;
  chunk.calls = 0;
  window.localStorage.setItem("sg-lang", "en");
  window.history.replaceState({}, "", "/about");
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

afterEach(() => {
  vi.doUnmock(ABOUT_CHUNK);
  window.localStorage.removeItem("sg-lang");
  window.history.replaceState({}, "", "/");
});

describe("standalone page lazy boundary", () => {
  it("renders the page from its own chunk on its public route", async () => {
    const App = await freshApp();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "About chunk for /about" })).toBeInTheDocument();
    expect(chunk.calls).toBe(1);
  });

  it("retries a failed chunk once, then shows an explicit error with a retry instead of the crash screen", async () => {
    chunk.failures = 2;
    const App = await freshApp();
    render(<App />);
    const alert = await screen.findByRole("alert", {}, { timeout: 3000 });
    // A chunk that would not arrive says so; it is not the code-crash copy.
    expect(alert).toHaveTextContent(t("en", "app.viewLoadFailedTitle"));
    expect(alert).not.toHaveTextContent(t("en", "app.viewCrashTitle"));
    expect(screen.getByRole("button", { name: t("en", "app.tryAgain") })).toBeInTheDocument();
    expect(chunk.calls).toBe(2);
  });

  it("recovers on the retry when only the first fetch fails", async () => {
    chunk.failures = 1;
    const App = await freshApp();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "About chunk for /about" }, { timeout: 3000 })).toBeInTheDocument();
    expect(chunk.calls).toBe(2);
  });

  it("renders a standalone page in English, marked English, when the Spanish boot catalogue did not load", async () => {
    window.localStorage.setItem("sg-lang", "es");
    // a fresh module registry: English registered, Spanish never fetched
    const App = await freshApp();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "About chunk for /about" })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
  });

  it("keeps Spanish on a standalone page when the boot catalogue loaded", async () => {
    window.localStorage.setItem("sg-lang", "es");
    const App = await freshApp();
    const { registerLanguage } = await import("../src/lib/i18n.js");
    const { spanishCatalogue } = await import("../src/lib/i18n/es.js");
    registerLanguage("es", spanishCatalogue.es);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "About chunk for /about" })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("es");
  });
});

// The public chapter directory, its public events and the public union
// catalog are left out of Union Ground: their addresses reach the 404 page,
// never a directory, and no directory module ships.
describe("left-out public directory", () => {
  it("ships no public directory module", () => {
    expect(existsSync(new URL("../src/features/publicDirectory", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../src/views/PublicLanding.jsx", import.meta.url))).toBe(false);
  });

  it.each(["/chapters", "/chapters/bos", "/chapters/bos/news", "/events/boston-meeting", "/unions", "/orgs/example-local-1", "/unions/claim/confirm"])(
    "serves %s as the 404 page, not as a directory",
    async (path) => {
      window.history.replaceState({}, "", path);
      const App = await freshApp();
      render(<App />);
      expect(await screen.findByRole("heading", { level: 1, name: t("en", "notFound.title") }, { timeout: 3000 })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /About chunk/ })).toBeNull();
      expect(chunk.calls).toBe(0);
      expect(document.querySelector(".public-directory, .pd-shell, [data-public-directory]")).toBeNull();
    },
  );
});
