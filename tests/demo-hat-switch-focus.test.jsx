import { readFileSync } from "node:fs";
import { Suspense, lazy } from "react";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AfterPageCommit, focusWhenAvailable, sampleHatFocusAfterGate, sampleHatFocusAfterNavigation } from "../src/App.jsx";

// UB-UG-DEMO-HAT-SWITCH-KEEPS-SWITCHER-IN-VIEW-20261107: after a demo
// hat switch the new workspace takes focus without scrolling the demo bar
// (and its hat switcher) off the top of the page.
describe("demo hat switch focus", () => {
  it("focuses without scrolling when asked", () => {
    const focus = vi.fn();
    focusWhenAvailable(() => ({ isConnected: true, focus }), undefined, { preventScroll: true });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("keeps the plain focus call for every other caller", () => {
    const focus = vi.fn();
    focusWhenAvailable(() => ({ isConnected: true, focus }));
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus.mock.calls[0]).toEqual([]);
  });

  it("carries the option through a deferred retry", async () => {
    const focus = vi.fn();
    let ready = false;
    focusWhenAvailable(() => (ready ? { isConnected: true, focus } : null), undefined, { preventScroll: true });
    ready = true;
    await vi.waitFor(() => expect(focus).toHaveBeenCalledWith({ preventScroll: true }));
  });

  //: the switch's own navigation keeps its focus request; any other
  // navigation drops it, so a destination that never drew (a redirect, a
  // refused view) cannot pull focus to main on a later, unrelated page.
  it("keeps a role switch's focus request only through its own navigation", () => {
    expect(sampleHatFocusAfterNavigation("coordinator", "coordinator")).toBe("coordinator");
    expect(sampleHatFocusAfterNavigation("coordinator", "messages")).toBeNull();
    expect(sampleHatFocusAfterNavigation(null, "coordinator")).toBeNull();
  });

  // The route gate redirects with setView. During the
  // switch's wait that is the interim /m and keeps the request; after it, a
  // redirect to another view drops it.
  it("keeps a role switch's focus request through the gate's interim redirect only", () => {
    expect(sampleHatFocusAfterGate("coordinator", "today", true)).toBe("coordinator");
    expect(sampleHatFocusAfterGate("coordinator", "coordinator", false)).toBe("coordinator");
    expect(sampleHatFocusAfterGate("coordinator", "today", false)).toBeNull();
  });
});

// UB-UG-DEMO-HAT-SWITCH-FASTER-ONE-WAIT-20261107: the live profile of
// a Steward switch on demo.example.com (6.8 s) showed the destination's reads
// starting only after the shell's (2.8 s in), under a generic "Loading Union
// Ground…" between the hat-named wait and the desk's own.
describe("demo hat switch load order and wait", () => {
  const source = readFileSync("src/App.jsx", "utf8");

  it("starts the destination's reads with the shell's, on a SAMPLE hat switch only", () => {
    const boot = source.slice(source.indexOf("    setLoading(true);\n    // UB-UG-DEMO-HAT-SWITCH-FASTER-ONE-WAIT-20261107"));
    const head = boot.slice(0, boot.indexOf("loadShellRef.current(session)"));
    expect(head).toContain("if (sampleLive && sampleHatTransitioningRef.current) {");
    expect(head).toContain("loaderFor(session).loadRoute(viewRef.current).catch(() => {});");
  });

  it("keeps the hat-named wait on the in-shell page wait until the switched page loads", () => {
    expect(source).toContain("const routeOpeningHat = sampleHatOpening ? DEMO_HATS.find((hat) => hat.key === sampleHatOpening) : null;");
    expect(source).toContain('const routeOpeningLabel = routeOpeningHat ? tr("demo.hatOpening", { hat: tr(routeOpeningHat.labelKey) }) : tr("app.loading");');
    expect(source).toContain(') : routeLoad.status !== "loaded" ? (\n              <ViewLoading label={routeOpeningLabel} />');
  });

  // BUG-UG-DEMO-HAT-SWITCH-WAIT-GENERIC-WHILE-DESK-CHUNK-LOADS-20261108:
  // live on demo.example.com (Nov 8, 5:00 AM ET, with) a Member to Steward
  // switch still showed "Loading Union Ground..." for 0.3 s at 4.7 s: the
  // shell's Suspense fallback while the Steward desk's chunk loaded, first
  // requested only once the desk's data had loaded.
  it("names the hat on the shell's page Suspense fallback too", () => {
    expect(source).toContain('<Suspense key={sessionGeneration} fallback={<ViewLoading label={routeOpeningLabel} />}>');
  });

  it("clears the hat-named wait only once the switched page has committed", () => {
    expect(source).toContain('{routeOpeningHat && !sampleHatTransitioning && routeLoad.status !== "loading" ? <AfterPageCommit onCommit={clearSampleHatOpening} /> : null}');
    expect(source.match(/setSampleHatOpening\(null\)/g)).toHaveLength(1);
    expect(source).toContain("const clearSampleHatOpening = useCallback(() => setSampleHatOpening(null), []);");
  });

  it("fetches the destination desk's chunk as the switch starts", () => {
    const start = source.slice(source.indexOf("      setSampleHatOpening(entry.key);"));
    expect(start.slice(0, 600)).toContain("viewLoaders[entry.view]?.().catch(() => {});");
  });
});

describe("AfterPageCommit", () => {
  it("fires only once the Suspense boundary around it commits its page", async () => {
    let finish;
    const Page = lazy(() => new Promise((resolve) => { finish = () => resolve({ default: () => <p>Desk</p> }); }));
    const onCommit = vi.fn();
    render(<Suspense fallback={<p>Opening</p>}><AfterPageCommit onCommit={onCommit} /><Page /></Suspense>);
    expect(screen.getByText("Opening")).toBeTruthy();
    await act(async () => { await Promise.resolve(); });
    expect(onCommit).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    expect(await screen.findByText("Desk")).toBeTruthy();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
