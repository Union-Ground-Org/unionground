import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PORTAL_HOST, PORTAL_ORIGIN } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
const surface = vi.hoisted(() => ({ kind: "saas", backend: "live" }));
vi.mock("../src/lib/demoOrigin.js", async (original) => ({
  ...await original(),
  resolveAppSurface: () => surface.kind,
}));
vi.mock("../src/lib/supabase.js", () => ({ get appBackendKind() { return surface.backend; } }));
vi.mock("../src/lib/openSignup.js", async (original) => ({
  ...await original(),
  TURNSTILE_SITE_KEY: "test-site-key",
}));

const location = window.location;
let shared;
let respond;
let fetcher;

beforeEach(async () => {
  vi.resetModules();
  surface.kind = "saas";
  surface.backend = "live";
  Object.defineProperty(window, "location", { configurable: true, value: new URL(`${PORTAL_ORIGIN}/signup`) });
  fetcher = vi.fn(() => new Promise((resolve) => { respond = resolve; }));
  vi.stubGlobal("fetch", fetcher);
  shared = await import("../src/MemberShellShared.jsx");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "location", { configurable: true, value: location });
});

async function answer(open, status = 200) {
  await act(async () => { respond({ status, json: async () => ({ open }) }); });
}

describe("member-shell signup availability", () => {
  it.each([
    ["sample", "live", PORTAL_HOST],
    ["saas", "demo", PORTAL_HOST],
    ["saas", "live", "preview.example.test"],
  ])("does not request the owner switch on an ineligible %s/%s/%s surface", (kind, backend, hostname) => {
    surface.kind = kind;
    surface.backend = backend;
    Object.defineProperty(window, "location", { configurable: true, value: { hostname } });
    const { result } = renderHook(shared.useOpenSignupAvailable);
    expect(result.current).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([true, false])("holds confirmation until the owner's switch resolves to %s", async (open) => {
    const { result } = renderHook(shared.useOpenSignupAvailable);
    expect(result.current).toBe(null);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/open-signup", {
      method: "GET", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
    });
    await answer(open);
    expect(result.current).toBe(open);
  });

  it("shares one read across simultaneous consumers and later mounts", async () => {
    const first = renderHook(shared.useOpenSignupAvailable);
    const second = renderHook(shared.useOpenSignupAvailable);
    expect(first.result.current).toBe(null);
    expect(second.result.current).toBe(null);
    expect(fetcher).toHaveBeenCalledTimes(1);
    first.unmount();
    await answer(true);
    expect(first.result.current).toBe(null);
    expect(second.result.current).toBe(true);
    second.unmount();
    const third = renderHook(shared.useOpenSignupAvailable);
    await act(async () => {});
    expect(third.result.current).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not commit a cancelled read after the surface becomes ineligible", async () => {
    const rendered = [];
    const { result, rerender } = renderHook(() => {
      const available = shared.useOpenSignupAvailable();
      rendered.push(available);
      return available;
    });
    surface.kind = "sample";
    rerender();
    expect(result.current).toBe(false);
    await answer(true);
    // Re-enter before the effect's cached promise settles: stale state must
    // still be pending on this render, rather than an answer from the old surface.
    rendered.length = 0;
    surface.kind = "saas";
    rerender();
    await act(async () => {});
    expect(rendered[0]).toBe(null);
    expect(result.current).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps signup unavailable when the server reports the switch endpoint off", async () => {
    const { result } = renderHook(shared.useOpenSignupAvailable);
    await answer(true, 404);
    expect(result.current).toBe(false);
  });
});

it("announces the supplied loading label and hides the decorative brand", () => {
  const { AppLoadingScreen } = shared;
  render(<AppLoadingScreen label="Loading your workspace" />);
  expect(screen.getByRole("main")).toHaveClass("loading-screen");
  const status = screen.getByRole("status");
  expect(status).toHaveTextContent("Loading your workspace");
  expect(status).toHaveAttribute("aria-live", "polite");
  expect(status).toHaveAttribute("aria-atomic", "true");
  expect(document.querySelector(".loading-screen__brand")).toHaveAttribute("aria-hidden", "true");
});
