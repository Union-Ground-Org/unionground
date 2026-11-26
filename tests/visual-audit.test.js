import { describe, expect, it, vi } from "vitest";
import {
  applyVisualBaseline,
  classifyVisualMeasurements,
  collectVisualMeasurements,
  createVisualBaseline,
  renderVisualAuditMarkdown,
} from "../scripts/visual-audit.mjs";

const box = (left, top, width, height) => ({
  left, top, right: left + width, bottom: top + height, width, height,
});
const base = (overrides = {}) => ({
  route: "/home",
  viewport: { width: 390, height: 844 },
  document: { scrollWidth: 390 }, elements: [], clipped: [], brokenImages: [],
  dialogs: [], focus: null, ...overrides,
});

describe("classifyVisualMeasurements", () => {
  it("fails a material text/control collision", () => {
    const result = classifyVisualMeasurements(base({ elements: [
      { id: "title", kind: "text", selector: "h1", rect: box(8, 8, 180, 40) },
      { id: "save", kind: "interactive", selector: "button.save", rect: box(150, 10, 80, 44) },
    ] }), []);
    expect(result.failures[0].rule).toBe("element-collision");
  });

  it("does not fail elements that only meet at a sub-pixel boundary", () => {
    const result = classifyVisualMeasurements(base({ elements: [
      { id: "header", kind: "text", selector: "header", rect: box(0, 0, 200, 40.000001) },
      { id: "footer", kind: "interactive", selector: "footer button", rect: box(0, 40, 200, 44) },
    ] }), []);

    expect(result.failures).toEqual([]);
  });

  it("warns for an ambiguous overlay collision", () => {
    const result = classifyVisualMeasurements(base({ elements: [
      { id: "badge", kind: "overlay", selector: ".badge", rect: box(40, 10, 24, 24) },
      { id: "label", kind: "text", selector: ".label", rect: box(30, 10, 80, 30) },
    ] }), []);
    expect(result.failures).toEqual([]);
    expect(result.warnings[0].rule).toBe("element-collision");
  });

  it("warns when an intentionally positioned surface overlaps normal content", () => {
    const result = classifyVisualMeasurements(base({ elements: [
      { id: "menu", kind: "container", selector: ".menu", positioning: "absolute", rect: box(20, 20, 180, 120) },
      { id: "link", kind: "interactive", selector: ".nav-link", positioning: "static", rect: box(30, 30, 120, 44) },
    ] }), []);

    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ rule: "element-collision", selector: ".menu" }),
    ]);
  });

  it("permits normal containment and omits hidden or decorative elements", () => {
    const result = classifyVisualMeasurements(base({ elements: [
      { id: "card", kind: "container", selector: ".card", rect: box(0, 0, 200, 100) },
      { id: "copy", kind: "text", selector: ".copy", rect: box(10, 10, 100, 30) },
      { id: "hidden", kind: "text", selector: ".hidden", rect: box(10, 10, 100, 30), hidden: true },
      { id: "line", kind: "decorative", selector: ".line", rect: box(10, 10, 100, 30) },
    ] }), []);
    expect(result.failures).toEqual([]);
    expect(result.inspected).toBe(2);
  });

  it("fails a 43 by 44 target", () => {
    const result = classifyVisualMeasurements(base({ elements: [
      { id: "small", kind: "interactive", selector: "button", rect: box(0, 0, 43, 44) },
    ] }), []);
    expect(result.failures.map((item) => item.rule)).toContain("small-target");
  });

  it("passes a 44 by 44 target", () => {
    const result = classifyVisualMeasurements(base({ elements: [
      { id: "exact", kind: "interactive", selector: "button.exact", rect: box(0, 0, 44, 44) },
    ] }), []);
    expect(result.failures).toEqual([]);
  });

  it("does not classify a wholly off-screen control as a visible small or clipped target", () => {
    const result = classifyVisualMeasurements(base({
      elements: [
        { id: "skip", kind: "interactive", selector: ".skip-link", rect: box(12, -60, 185, 39) },
      ],
      clipped: [{ selector: ".skip-link", rect: box(12, -60, 185, 39), clipper: ".app", clipRect: box(0, 0, 390, 900) }],
    }), []);

    expect(result.failures).toEqual([]);
  });

  it("does not classify collisions or fixed obstructions wholly outside the viewport", () => {
    const result = classifyVisualMeasurements(base({
      elements: [
        { id: "skip", kind: "interactive", selector: ".skip-link", rect: box(12, -60, 185, 39), domAncestors: [] },
        { id: "other", kind: "interactive", selector: ".other-skip", rect: box(12, -80, 113, 44), domAncestors: [] },
      ],
      fixedObstructions: [
        { selector: ".skip-link", rect: box(12, -60, 185, 39), domAncestors: [], positioning: "fixed" },
      ],
    }), []);

    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("fails horizontal overflow independently", () => {
    const result = classifyVisualMeasurements(base({ document: { scrollWidth: 500 } }), []);
    expect(result.failures.map((item) => item.rule)).toEqual(["horizontal-overflow"]);
  });

  it("fails clipped interactive content independently", () => {
    const result = classifyVisualMeasurements(base({ clipped: [{ selector: "button.clip" }] }), []);
    expect(result.failures.map((item) => item.rule)).toEqual(["clipped-interactive"]);
  });

  it("fails a broken image independently", () => {
    const result = classifyVisualMeasurements(base({ brokenImages: [{ selector: "img.hero" }] }), []);
    expect(result.failures.map((item) => item.rule)).toEqual(["broken-image"]);
  });

  it("fails an off-viewport dialog independently", () => {
    const result = classifyVisualMeasurements(base({ dialogs: [{ selector: '[role="dialog"]', rect: box(-10, 0, 100, 100) }] }), []);
    expect(result.failures.map((item) => item.rule)).toEqual(["dialog-viewport"]);
  });

  it("fails hidden focus independently", () => {
    const result = classifyVisualMeasurements(base({ focus: { selector: "button.focus", hidden: true } }), []);
    expect(result.failures.map((item) => item.rule)).toEqual(["focus-hidden"]);
  });

  it("does not treat a fixed container as obstructing its contained control", () => {
    const result = classifyVisualMeasurements(base({
      fixedObstructions: [{ selector: ".header", rect: box(0, 0, 390, 60) }],
      elements: [
        { id: "header", kind: "container", selector: ".header", rect: box(0, 0, 390, 60) },
        { id: "menu", kind: "interactive", selector: "button.menu", rect: box(10, 10, 44, 44), domAncestors: [".header"] },
      ],
    }), []);
    expect(result.failures).toEqual([]);
  });

  it("fails a definite fixed obstruction independently", () => {
    const result = classifyVisualMeasurements(base({
      fixedObstructions: [{ selector: ".banner", rect: box(0, 0, 390, 20) }],
      elements: [{ id: "under", kind: "interactive", selector: "button.under", rect: box(10, 10, 80, 44), domAncestors: [] }],
    }), []);
    expect(result.failures.map((item) => item.rule)).toEqual(["fixed-obstruction"]);
  });

  it("fails fixed interactive chrome that covers meaningful text", () => {
    const result = classifyVisualMeasurements(base({
      fixedObstructions: [{ selector: ".demo-chip", rect: box(10, 60, 176, 44), domAncestors: [], positioning: "fixed" }],
      elements: [{ id: "heading", kind: "text", selector: "h1", rect: box(10, 82, 340, 34), domAncestors: [] }],
    }), []);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: "fixed-obstruction",
        obstruction: ".demo-chip",
        selectors: ["h1", ".demo-chip"],
        intersectionRect: expect.objectContaining({ width: 176, height: 22 }),
      }),
    ]));
  });

  it("treats sticky chrome like fixed chrome", () => {
    const result = classifyVisualMeasurements(base({
      fixedObstructions: [{ selector: ".sticky-bar", rect: box(0, 0, 390, 44), domAncestors: [], positioning: "sticky" }],
      elements: [{ id: "heading", kind: "text", selector: "h1", rect: box(10, 20, 180, 32), domAncestors: [] }],
    }), []);
    expect(result.failures.map((item) => item.rule)).toContain("fixed-obstruction");
  });

  it("requires pair-specific fixed obstruction exceptions", () => {
    const measurements = base({
      fixedObstructions: [{ selector: ".demo-chip", rect: box(10, 60, 176, 44), domAncestors: [], positioning: "fixed" }],
      elements: [{ id: "heading", kind: "text", selector: "h1", rect: box(10, 82, 340, 34), domAncestors: [] }],
    });
    expect(classifyVisualMeasurements(measurements, [
      { route: "/home", rule: "fixed-obstruction", selector: "h1", obstruction: ".demo-chip" },
    ]).failures).toEqual([]);
    expect(classifyVisualMeasurements(measurements, [
      { route: "/home", rule: "fixed-obstruction", selector: "h1", obstruction: ".other" },
    ]).failures).not.toEqual([]);
  });

  it("fails an unrelated full-screen fixed overlay behind a button", () => {
    const result = classifyVisualMeasurements(base({
      fixedObstructions: [{ selector: ".overlay", rect: box(0, 0, 390, 844) }],
      elements: [{ id: "behind", kind: "interactive", selector: "#behind", rect: box(10, 10, 80, 44), domAncestors: [] }],
    }), []);
    expect(result.failures.map((item) => item.rule)).toEqual(["fixed-obstruction"]);
  });

  it("warns when fixed obstruction ancestry is unavailable", () => {
    const result = classifyVisualMeasurements(base({
      fixedObstructions: [{ selector: ".unknown", rect: box(0, 0, 390, 844) }],
      elements: [{ id: "unknown", kind: "interactive", selector: "#unknown", rect: box(10, 10, 80, 44) }],
    }), []);
    expect(result.failures).toEqual([]);
    expect(result.warnings.map((item) => item.rule)).toEqual(["fixed-obstruction"]);
  });

  it("filters hidden, inert, aria-hidden, and transparent ancestors in the collector", () => {
    const rect = { left: 0, top: 0, right: 80, bottom: 44, width: 80, height: 44, x: 0, y: 0, toJSON: () => ({}) };
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
    for (const attribute of ["hidden", "inert", "aria-hidden=\"true\""]) {
      document.body.innerHTML = `<div ${attribute}><button id="leaked-descendant">leak</button></div><button id="visible">ok</button>`;
      const result = collectVisualMeasurements();
      expect(result.elements.map((item) => item.selector)).not.toContain("#leaked-descendant");
    }
    document.body.innerHTML = '<div style="opacity: 0"><button id="transparent-descendant">leak</button></div><button id="visible">ok</button>';
    expect(collectVisualMeasurements().elements.map((item) => item.selector)).not.toContain("#transparent-descendant");
    rectSpy.mockRestore();
  });

  it("filters hidden descendants from dialogs and broken images", () => {
    document.body.innerHTML = '<div aria-hidden="true"><div role="dialog"><img id="hidden-image" src="/missing.png"></div></div>';
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 80, bottom: 44, width: 80, height: 44, x: 0, y: 0, toJSON: () => ({}) });
    Object.defineProperty(document.querySelector("img"), "complete", { value: true });
    Object.defineProperty(document.querySelector("img"), "naturalWidth", { value: 0 });
    const result = collectVisualMeasurements();
    expect(result.dialogs).toEqual([]);
    expect(result.brokenImages).toEqual([]);
    rectSpy.mockRestore();
  });

  it("ignores sub-pixel overflow-edge noise while retaining material clipping", () => {
    document.body.innerHTML = '<div id="clipper" style="overflow: hidden"><button id="edge">Edge</button></div>';
    let buttonBottom = 100.00001;
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getRect() {
      const bottom = this.id === "edge" ? buttonBottom : 100;
      return { left: 0, top: 0, right: 100, bottom, width: 100, height: bottom, x: 0, y: 0, toJSON: () => ({}) };
    });

    expect(collectVisualMeasurements().clipped).toEqual([]);
    buttonBottom = 101;
    expect(collectVisualMeasurements().clipped).toEqual([
      expect.objectContaining({ selector: "#edge", clipper: "#clipper" }),
    ]);
    rectSpy.mockRestore();
  });

  it("does not call an offscreen control clipped when its overflow axis is scrollable", () => {
    document.body.innerHTML = '<div id="outer" style="overflow: hidden"><div id="scroller" style="overflow-y: auto; overflow-x: hidden"><button id="later">Later</button></div></div>';
    const scroller = document.querySelector("#scroller");
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 200 },
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 100 },
    });
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getRect() {
      if (this.id === "later") return { left: 0, top: 140, right: 100, bottom: 184, width: 100, height: 44, x: 0, y: 140, toJSON: () => ({}) };
      return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) };
    });

    expect(collectVisualMeasurements().clipped).toEqual([]);
    scroller.style.overflowY = "hidden";
    expect(collectVisualMeasurements().clipped).toEqual([
      expect.objectContaining({ selector: "#later", clipper: "#scroller" }),
    ]);
    rectSpy.mockRestore();
  });

  it("does not call unpainted scroll content obstructed by adjacent sticky chrome", () => {
    document.body.innerHTML = '<div id="scroller" style="overflow-x: auto; width: 100px"><button id="later">Later</button></div><aside id="phone" style="position: sticky">Phone</aside>';
    const scroller = document.querySelector("#scroller");
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 200 },
    });
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getRect() {
      if (this.id === "later") return { left: 140, top: 0, right: 200, bottom: 44, width: 60, height: 44, x: 140, y: 0, toJSON: () => ({}) };
      if (this.id === "phone") return { left: 100, top: 0, right: 200, bottom: 100, width: 100, height: 100, x: 100, y: 0, toJSON: () => ({}) };
      return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) };
    });

    const measurements = collectVisualMeasurements();
    expect(measurements.elements.find((item) => item.selector === "#later")?.paintedRect).toBeNull();
    expect(classifyVisualMeasurements(measurements, []).failures).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "fixed-obstruction", selector: "#later", obstruction: "#phone" }),
    ]));
    rectSpy.mockRestore();
  });

  it("ignores sub-pixel target-size noise while retaining materially small targets", () => {
    const measurements = {
      route: "/m",
      viewport: { width: 390, height: 844 },
      document: { scrollWidth: 390 },
      elements: [{
        kind: "interactive",
        selector: "#edge-target",
        rect: { left: 0, top: 0, right: 44, bottom: 43.99999, width: 44, height: 43.99999 },
      }],
    };

    expect(classifyVisualMeasurements(measurements).failures).toEqual([]);
    measurements.elements[0].rect.height = 43;
    measurements.elements[0].rect.bottom = 43;
    expect(classifyVisualMeasurements(measurements).failures).toEqual([
      expect.objectContaining({ rule: "small-target", selector: "#edge-target" }),
    ]);
  });

  it("uses a name selector when semantic identity comes from name", () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 80, bottom: 44, width: 80, height: 44, x: 0, y: 0, toJSON: () => ({}) });
    document.body.innerHTML = '<button name="save">Save</button>';
    expect(collectVisualMeasurements().elements[0].selector).toBe('[name="save"]');
    rectSpy.mockRestore();
  });

  it("allows exact route, selector, and rule exceptions only", () => {
    const measurements = base({ elements: [
      { id: "small", kind: "interactive", selector: "button.small", rect: box(0, 0, 43, 44) },
    ] });
    expect(classifyVisualMeasurements(measurements, [
      { route: "/home", selector: "button.small", rule: "small-target" },
    ]).failures).toEqual([]);
    expect(classifyVisualMeasurements({ ...measurements, route: "/other" }, [
      { route: "/home", selector: "button.small", rule: "small-target" },
    ]).failures).not.toEqual([]);
  });

  it("returns stable JSON and renders a markdown report", () => {
    const report = { route: "/home", failures: [], warnings: [], inspected: 0 };
    expect(() => JSON.stringify(classifyVisualMeasurements(base(), []))).not.toThrow();
    expect(renderVisualAuditMarkdown(report)).toContain("/home");
  });

  it("keeps reviewed debt visible while failing new occurrences or worsened geometry", () => {
    const knownFinding = {
      rule: "small-target",
      route: "/home",
      viewport: { width: 390, height: 844 },
      selector: "button.small",
      selectors: ["button.small"],
      rectangles: [box(0, 0, 43, 44)],
      severity: "failure",
    };
    const baseline = [{
      rule: "small-target",
      route: "/home",
      viewport: { width: 390, height: 844 },
      selector: "button.small",
      selectors: ["button.small"],
      maxOccurrences: 1,
      maxSeverity: 1,
    }];

    const reviewed = applyVisualBaseline({ failures: [knownFinding], warnings: [] }, baseline);
    expect(reviewed.failures).toEqual([]);
    expect(reviewed.warnings).toEqual([
      expect.objectContaining({ rule: "small-target", severity: "warning", baseline: true }),
    ]);

    const newOccurrence = applyVisualBaseline({ failures: [knownFinding, knownFinding], warnings: [] }, baseline);
    expect(newOccurrence.failures).toHaveLength(1);

    const worsened = applyVisualBaseline({ failures: [{
      ...knownFinding,
      rectangles: [box(0, 0, 42, 44)],
    }], warnings: [] }, baseline);
    expect(worsened.failures).toHaveLength(1);
  });

  it("creates a stable baseline with occurrence and worst-geometry ceilings", () => {
    const finding = {
      rule: "small-target",
      route: "/home",
      viewport: { width: 390, height: 844 },
      selector: "button.small",
      selectors: ["button.small"],
      rectangles: [box(0, 0, 43, 44)],
    };

    expect(createVisualBaseline([
      finding,
      finding,
      { ...finding, rectangles: [box(0, 0, 42, 44)] },
    ])).toEqual([{
      rule: "small-target",
      route: "/home",
      viewport: { width: 390, height: 844 },
      selector: "button.small",
      selectors: ["button.small"],
      maxOccurrences: 3,
      maxSeverity: 2,
    }]);
  });
});
