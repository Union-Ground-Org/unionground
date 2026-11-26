import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyCoordinatorStickyClearance,
  blockHeight,
  clearCoordinatorStickyClearance,
  coordinatorStickyClearance,
  readCoordinatorStickyChrome,
  roleBarCoversViewport,
  useCoordinatorStickyClearance,
} from "../src/lib/coordinatorStickyClearance.js";

// Recorded on Main 57ec957f at 320 CSS px after scrolling to Today's docket
// and filtering with no matches (D11 sticky-hit-test.json, issue #7668).
// Both strips stuck at top: 0, so the role bar covered the search and the
// desk toolbar covered the focused Open cases label and value.
const RECORDED = {
  roleTop: 0,
  roleHeight: 150.75,
  toolbarTop: 0,
  toolbarHeight: 200.59375,
  inputTop: 134.59375,
  inputHeight: 44,
  tileTop: 138.0625,
  labelTop: 154.0625,
  valueTop: 172.5625,
  outlineReach: 6,
};

function overlaps(top, bottom, otherTop, otherBottom) {
  return top < otherBottom - 0.01 && otherTop < bottom - 0.01;
}

function placed(clearance, recorded = RECORDED) {
  const shift = clearance.toolbarTop - recorded.toolbarTop;
  const inputTop = recorded.inputTop + shift;
  const toolbarTop = recorded.toolbarTop + shift;
  const roleBottom = recorded.roleTop + recorded.roleHeight;
  const tileTop = Math.max(recorded.tileTop, clearance.kpiScrollMargin);
  const tileShift = tileTop - recorded.tileTop;
  const chromeBottom = clearance.toolbarTop + Math.ceil(recorded.toolbarHeight);
  return {
    searchCovered: overlaps(inputTop, inputTop + recorded.inputHeight, recorded.roleTop, roleBottom),
    barsOverlap: overlaps(toolbarTop, toolbarTop + recorded.toolbarHeight, recorded.roleTop, roleBottom),
    labelTop: recorded.labelTop + tileShift,
    valueTop: recorded.valueTop + tileShift,
    outlineTop: tileTop - recorded.outlineReach,
    chromeBottom,
  };
}

function withHeight(element, height) {
  element.getBoundingClientRect = () => ({
    height, width: 320, top: 0, bottom: height, left: 0, right: 320, x: 0, y: 0, toJSON() { return {}; },
  });
  return element;
}

describe("coordinator sticky clearance", () => {
  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("separates the recorded no-match 320px stack and keeps each KPI visible", () => {
    const stuck = placed({ toolbarTop: 0, kpiScrollMargin: 0 });
    expect(stuck.searchCovered).toBe(true);
    expect(stuck.barsOverlap).toBe(true);
    expect(stuck.labelTop).toBeLessThan(stuck.chromeBottom);
    expect(stuck.valueTop).toBeLessThan(RECORDED.toolbarHeight);

    const fixed = coordinatorStickyClearance({
      roleBarHeight: RECORDED.roleHeight,
      roleBarVisible: true,
      toolbarHeight: RECORDED.toolbarHeight,
    });
    const placedFixed = placed(fixed);
    expect(fixed.toolbarTop).toBe(151);
    expect(fixed.kpiScrollMargin).toBe(151 + 201 + 8);
    expect(placedFixed.searchCovered).toBe(false);
    expect(placedFixed.barsOverlap).toBe(false);
    expect(placedFixed.labelTop).toBeGreaterThanOrEqual(placedFixed.chromeBottom);
    expect(placedFixed.valueTop).toBeGreaterThanOrEqual(placedFixed.chromeBottom);
    expect(placedFixed.outlineTop).toBeGreaterThanOrEqual(placedFixed.chromeBottom);
  });

  it("uses the measured bar and toolbar instead of a fixed offset", () => {
    const tucked = coordinatorStickyClearance({ roleBarHeight: 188.4, roleBarVisible: false, toolbarHeight: 248.2 });
    expect(tucked).toEqual({ toolbarTop: 0, kpiScrollMargin: 249 + 8 });
    const wrapped = coordinatorStickyClearance({ roleBarHeight: 188.4, roleBarVisible: true, toolbarHeight: 248.2 });
    expect(wrapped).toEqual({ toolbarTop: 189, kpiScrollMargin: 189 + 249 + 8 });
    expect(coordinatorStickyClearance({
      roleBarHeight: Number.NaN, roleBarVisible: true, toolbarHeight: -3, outlinePad: "no",
    })).toEqual({ toolbarTop: 0, kpiScrollMargin: 0 });
  });

  it("treats a tucked role bar as covering the viewport only while it contains focus", () => {
    expect(roleBarCoversViewport(null)).toBe(false);
    const bar = document.createElement("header");
    bar.className = "mobile-top";
    expect(roleBarCoversViewport(bar)).toBe(true);
    bar.classList.add("mobile-top--tucked");
    expect(roleBarCoversViewport(bar)).toBe(false);
    const field = document.createElement("input");
    bar.append(field);
    document.body.append(bar);
    field.focus();
    expect(document.activeElement).toBe(field);
    expect(roleBarCoversViewport(bar)).toBe(true);
    field.blur();
    expect(roleBarCoversViewport(bar)).toBe(false);
  });

  it("reads the role bar and the desk toolbar from the document", () => {
    expect(blockHeight(null)).toBe(0);
    expect(blockHeight({ getBoundingClientRect: () => ({ height: Number.NaN }) })).toBe(0);
    const bar = withHeight(document.createElement("header"), 150.75);
    bar.className = "mobile-top";
    const screen = document.createElement("div");
    const toolbar = withHeight(document.createElement("header"), 200.59375);
    toolbar.className = "phead";
    screen.append(toolbar);
    document.body.append(bar, screen);
    expect(readCoordinatorStickyChrome(document, screen)).toEqual({ toolbarTop: 151, kpiScrollMargin: 360 });
    bar.classList.add("mobile-top--tucked");
    expect(readCoordinatorStickyChrome(document, screen).toolbarTop).toBe(0);
    expect(readCoordinatorStickyChrome(null, screen).toolbarTop).toBe(0);
    applyCoordinatorStickyClearance(null, { toolbarTop: 1, kpiScrollMargin: 2 });
    applyCoordinatorStickyClearance(screen, readCoordinatorStickyChrome(document, screen));
    expect(screen.style.getPropertyValue("--gq-toolbar-top")).toBe("0px");
    clearCoordinatorStickyClearance(screen);
    expect(screen.style.getPropertyValue("--gq-toolbar-top")).toBe("");
    clearCoordinatorStickyClearance(null);
  });

  it("publishes clearance on the coordinator screen and drops it on unmount", async () => {
    const bar = withHeight(document.createElement("header"), 150.75);
    bar.className = "mobile-top mobile-top--with-menu";
    const screen = document.createElement("div");
    screen.className = "screen gq-screen";
    const toolbar = withHeight(document.createElement("header"), 200.59375);
    toolbar.className = "phead";
    const tile = document.createElement("button");
    tile.className = "pkpi";
    screen.append(toolbar, tile);
    document.body.append(bar, screen);
    const ref = { current: screen };
    const hook = renderHook(() => useCoordinatorStickyClearance(ref));
    expect(screen.style.getPropertyValue("--gq-toolbar-top")).toBe("151px");
    expect(screen.style.getPropertyValue("--gq-kpi-scroll-margin")).toBe("360px");

    bar.classList.add("mobile-top--tucked");
    await act(async () => {});
    expect(screen.style.getPropertyValue("--gq-toolbar-top")).toBe("0px");
    expect(screen.style.getPropertyValue("--gq-kpi-scroll-margin")).toBe("209px");

    const field = document.createElement("input");
    bar.append(field);
    await act(async () => { field.focus(); });
    expect(screen.style.getPropertyValue("--gq-toolbar-top")).toBe("151px");

    window.dispatchEvent(new Event("resize"));
    expect(screen.style.getPropertyValue("--gq-kpi-scroll-margin")).toBe("360px");

    hook.unmount();
    expect(screen.style.getPropertyValue("--gq-toolbar-top")).toBe("");
    expect(screen.style.getPropertyValue("--gq-kpi-scroll-margin")).toBe("");
  });

  it("measures again when the role bar appears and when its box changes", async () => {
    const observed = [];
    class RecordingResize {
      constructor(callback) { this.callback = callback; }
      observe(element) { observed.push(element); this.callback(); }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", RecordingResize);
    const screen = document.createElement("div");
    const toolbar = withHeight(document.createElement("header"), 90);
    toolbar.className = "phead";
    screen.append(toolbar);
    document.body.append(screen);
    const ref = { current: screen };
    renderHook(() => useCoordinatorStickyClearance(ref));
    expect(screen.style.getPropertyValue("--gq-toolbar-top")).toBe("0px");
    expect(screen.style.getPropertyValue("--gq-kpi-scroll-margin")).toBe("98px");

    const bar = withHeight(document.createElement("header"), 64.2);
    bar.className = "mobile-top";
    document.body.prepend(bar);
    window.dispatchEvent(new Event("resize"));
    expect(observed).toContain(bar);
    expect(screen.style.getPropertyValue("--gq-toolbar-top")).toBe("65px");
    expect(screen.style.getPropertyValue("--gq-kpi-scroll-margin")).toBe("163px");
  });

  it("does nothing when the screen ref is empty", () => {
    const ref = { current: null };
    const hook = renderHook(() => useCoordinatorStickyClearance(ref));
    hook.unmount();
  });

  it("wires the clearance variables through the coordinator screen", () => {
    const root = join(import.meta.dirname, "..");
    const css = readFileSync(join(root, "src/styles.css"), "utf8");
    const view = readFileSync(join(root, "src/views/CoordinatorView.jsx"), "utf8");
    expect(css).toMatch(/\.gq-screen > \.phead \{[^}]*top: var\(--gq-toolbar-top, 0px\)/);
    expect(css).toMatch(/\.pkpi \{[^}]*scroll-margin-top: var\(--gq-kpi-scroll-margin, 0px\)/);
    expect(css).not.toMatch(/\.gq-screen \.pkpi \{/);
    expect(view).toMatch(/useCoordinatorStickyClearance\(depthRef\)/);
  });

  it("uses the measured header clearance for deadline links and their rows", () => {
    const theme = readFileSync(join(import.meta.dirname, "../src/coordinator-theme.css"), "utf8");
    expect(theme).toMatch(/\.gq-screen :is\(#coordinator-deadlines, \.gq-duerow\) \{[^}]*scroll-margin-top: max\(76px, var\(--gq-kpi-scroll-margin, 0px\)\)/);
  });
});
