import { readFileSync } from "node:fs";
import { readAppSource } from "./helpers/app-source.js";
import { publicContact } from "../src/lib/publicContact.js";
import { resolve } from "node:path";
import { StrictMode, Suspense } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/lib/trustedBackends.js", async () =>
  (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

// BUG-UG-VIEW-CRASH-SHOWN-AS-LOAD-FAILED-UNREPORTED-20261018: a render
// crash inside a view was caught by ChunkBoundary, shown as a data-connection
// "Load failed", and never reached Sentry.
const sdk = vi.hoisted(() => ({ init: vi.fn(), setUser: vi.fn(), captureException: vi.fn(), makeFetchTransport: vi.fn() }));
vi.mock("@sentry/react", () => sdk);
vi.mock("posthog-js", () => ({ default: {} }));

const appSource = readAppSource();

async function loadBoundary({ sentry = true } = {}) {
  vi.stubEnv("VITE_SENTRY_DSN", sentry ? "https://public@o0.ingest.us.sentry.io/1" : "");
  const observability = await import("../src/lib/observability.js");
  observability.initObservability({ hostname: "app.unionground.test", automated: false });
  // ChunkBoundary reports through the deferred loader; load it as the shell would.
  await (await import("../src/lib/deferredObservability.js")).startObservability();
  const { ChunkBoundary } = await import("../src/components/ChunkBoundary.jsx");
  return { ChunkBoundary, observability };
}

function Crash({ error }) {
  throw error;
}

const fallback = (dismiss, kind) => (
  <div role="alert" data-kind={kind}>
    <button type="button" onClick={dismiss}>Try again</button>
  </div>
);

describe("ChunkBoundary reporting", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "");
    vi.stubEnv("VITE_SENTRY_PREVIEW_ENABLED", "0");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sends a render crash to Sentry exactly once and marks it as a crash", async () => {
    const { ChunkBoundary } = await loadBoundary();
    const error = new TypeError("Cannot read properties of undefined (reading 'name')");
    render(
      <StrictMode>
        <ChunkBoundary fallback={fallback}>
          <Crash error={error} />
        </ChunkBoundary>
      </StrictMode>,
    );
    expect(screen.getByRole("alert")).toHaveAttribute("data-kind", "crash");
    expect(sdk.captureException).toHaveBeenCalledTimes(1);
    expect(sdk.captureException).toHaveBeenCalledWith(error);
  });

  it("marks a chunk that would not load as a chunk failure", async () => {
    const { ChunkBoundary } = await loadBoundary();
    const { lazyView } = await import("../src/lib/lazyView.js");
    const Missing = lazyView(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/route-x.js")), 5_000);
    render(
      <ChunkBoundary fallback={fallback}>
        <Suspense fallback={<div role="status">Loading</div>}>
          <Missing />
        </Suspense>
      </ChunkBoundary>,
    );
    expect(await screen.findByRole("alert", {}, { timeout: 3_000 })).toHaveAttribute("data-kind", "chunk");
    expect(sdk.captureException).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when Sentry is not enabled", async () => {
    const { ChunkBoundary, observability } = await loadBoundary({ sentry: false });
    render(
      <ChunkBoundary fallback={fallback}>
        <Crash error={new Error("boom")} />
      </ChunkBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveAttribute("data-kind", "crash");
    expect(sdk.captureException).not.toHaveBeenCalled();
    expect(observability.captureViewError(new Error("boom"))).toBe(false);
  });

  it("tells a chunk failure from a code crash", async () => {
    const { isChunkLoadError } = await import("../src/lib/lazyView.js");
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/a.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module: https://x/a.js"))).toBe(true);
    expect(isChunkLoadError(Object.assign(new Error("Request timed out"), { name: "TimeoutError" }))).toBe(true);
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(isChunkLoadError(new Error("wrapped", { cause: new TypeError("Importing a module script failed.") }))).toBe(true);
    expect(isChunkLoadError(new Error("wrapped", { cause: new Error("render bug") }))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(false);
  });
});

describe("ChunkBoundary fallback copy", () => {
  it("no longer blames the data connection and offers Try again without an unpublished support address", async () => {
    const start = appSource.indexOf("<ChunkBoundary\n          key={view}");
    expect(start).toBeGreaterThan(-1);
    const block = appSource.slice(start, appSource.indexOf("<Suspense", start));
    expect(block).not.toContain("app.dataEyebrow");
    expect(block).not.toContain("app.loadFailed");
    expect(block).toContain('"app.viewCrashTitle"');
    expect(block).toContain('"app.viewLoadFailedTitle"');
    expect(block).toContain("app.viewCrashSupport");
    // The only mailbox is the operator's published support contact, shown only
    // when one is configured (src/lib/publicContact.js); none ships by default.
    expect(block.match(/mailto:/g) ?? []).toHaveLength(1);
    expect(block).toContain("{VIEW_SUPPORT_EMAIL ? <> <a href={`mailto:${VIEW_SUPPORT_EMAIL}`}>");
    expect(readFileSync(resolve("src/MemberShellShared.jsx"), "utf8")).toContain('VIEW_SUPPORT_EMAIL = publicContact("support")?.email ?? "";');
    expect(publicContact("support")).toBeNull();
    expect(block).toContain('tr("app.tryAgain")');
  });

  it("has English and Spanish copy for both kinds", async () => {
    const { catalogue } = await import("../src/lib/i18n.js");
    const { spanishCatalogue } = await import("../src/lib/i18n/es.js");
    expect(catalogue.en["app.viewCrashTitle"]).toBe("This page didn't open");
    expect(catalogue.en["app.viewCrashSupport"]).toBe("Try again. If it keeps happening, tell your organizer.");
    expect(catalogue.en["app.viewLoadFailedTitle"]).toBe("This page didn't load");
    for (const key of ["app.viewCrashTitle", "app.viewCrashSupport", "app.viewLoadFailedTitle", "app.viewLoadFailedBody"]) {
      expect(catalogue.en[key]).toBeTruthy();
      expect(spanishCatalogue.es[key]).toBeTruthy();
      expect(`${catalogue.en[key]} ${spanishCatalogue.es[key]}`).not.toMatch(/Data connection|Conexión de datos/);
    }
  });
});
