import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// OPS-UG-POSTHOG-ANALYTICS-ON-MEMBER-PRODUCT-AND-PUBLIC-PAGES-20261027
// (#6247 round 1): standalone public pages render outside MemberApp, so App
// itself sets the cookieless public-page context for them.
const sync = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/deferredObservability.js", async (importOriginal) => ({ ...(await importOriginal()), syncObservabilityContext: sync }));

describe("standalone public pages and product analytics", () => {
  beforeEach(() => {
    sync.mockClear();
    window.scrollTo = vi.fn();
    global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
  });
  afterEach(() => { window.history.replaceState({}, "", "/"); });

  it.each([["/privacy", "privacy"], ["/terms", "terms"], ["/no-such-page", "no-such-page"]])("reports %s as a public page view outside a session", async (path, view) => {
    window.history.replaceState({}, "", path);
    const { App } = await import("../src/AppRouter.jsx");
    render(<App />);
    expect(sync).toHaveBeenCalledWith({ userId: null, view, authPending: false });
  });
});
