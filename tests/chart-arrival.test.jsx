import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARRIVAL, ArrivalCount, ChartArrival, arriveAt, resetChartArrivals } from "../src/components/ChartArrival.jsx";

// Charts arrive once (Union Ground theme decision 4, owner, November 13, 2026):
// the first time a chart is seen it arrives, then never again on that visit,
// never on a refresh, never under reduced motion or in print, and anything
// without a browser that can tell when it is seen gets the finished chart.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const motionCss = readFileSync(join(root, "src", "motion.css"), "utf8");
const tokensCss = readFileSync(join(root, "src", "sg-tokens.css"), "utf8");

let observers;
let reduce;
let mediaListeners;

function installBrowser({ reduced = false } = {}) {
  observers = [];
  reduce = reduced;
  mediaListeners = [];
  class MockIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.observe = vi.fn();
      this.disconnect = vi.fn();
      observers.push(this);
    }
  }
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  vi.stubGlobal("matchMedia", (query) => ({
    media: query,
    get matches() { return reduce; },
    addEventListener: (_type, listener) => mediaListeners.push(listener),
    removeEventListener: vi.fn(),
  }));
}

function see(ratio = 1) {
  act(() => {
    observers.at(-1).callback([{ isIntersecting: ratio > 0, intersectionRatio: ratio, intersectionRect: { height: 0 }, rootBounds: { height: 800 } }]);
  });
}

function Chart({ name = "test:chart", value = "1,204" }) {
  return (
    <ChartArrival as="ul" name={name} data-testid="chart">
      <li><span className="arrive-x" style={arriveAt(3, { width: "40%" })} /><b><ArrivalCount value={value} /></b></li>
    </ChartArrival>
  );
}

beforeEach(() => resetChartArrivals());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("charts arrive once", () => {
  it("renders the finished chart where the browser cannot tell when it is seen", () => {
    render(<Chart />);
    expect(screen.getByTestId("chart")).not.toHaveAttribute("data-arrival");
    expect(screen.getByText("1,204")).toBeInTheDocument();
    expect(document.querySelector(".arrive-count")).toBeNull();
  });

  it("waits empty until seen, arrives, then renders finished and never arrives again", () => {
    vi.useFakeTimers();
    installBrowser();
    const view = render(<Chart />);
    const chart = screen.getByTestId("chart");
    expect(chart).toHaveAttribute("data-arrival", "waiting");
    // The finished value is in the document the whole time; the counting copy is hidden from assistive technology.
    expect(screen.getByText("1,204")).toHaveClass("arrive-count__final");
    expect(document.querySelector(".arrive-count__run")).toHaveAttribute("aria-hidden", "true");
    expect(document.querySelector(".arrive-count__run")).toHaveTextContent(/^0$/);

    see(0.1);
    expect(chart).toHaveAttribute("data-arrival", "waiting");
    see(ARRIVAL.seenShare);
    expect(chart).toHaveAttribute("data-arrival", "playing");
    act(() => { vi.advanceTimersByTime(ARRIVAL.settleMs); });
    expect(chart).not.toHaveAttribute("data-arrival");
    expect(document.querySelector(".arrive-count")).toBeNull();

    // A refresh with new figures shows them without motion.
    view.rerender(<Chart value="1,310" />);
    expect(chart).not.toHaveAttribute("data-arrival");
    expect(screen.getByText("1,310")).toBeInTheDocument();

    // The same chart mounted again on this visit is finished at once.
    view.unmount();
    render(<Chart value="1,310" />);
    expect(screen.getByTestId("chart")).not.toHaveAttribute("data-arrival");
  });

  it("counts a chart taller than the screen as seen when it fills a share of the viewport", () => {
    installBrowser();
    render(<Chart />);
    act(() => {
      observers.at(-1).callback([{ isIntersecting: true, intersectionRatio: 0.2, intersectionRect: { height: 400 }, rootBounds: { height: 800 } }]);
    });
    expect(screen.getByTestId("chart")).toHaveAttribute("data-arrival", "playing");
  });

  it("never moves under reduced motion, and stops waiting when the device asks for it", () => {
    installBrowser({ reduced: true });
    render(<Chart name="test:still" />);
    expect(screen.getByTestId("chart")).not.toHaveAttribute("data-arrival");

    installBrowser();
    render(<Chart name="test:switch" />);
    const chart = screen.getAllByTestId("chart").at(-1);
    expect(chart).toHaveAttribute("data-arrival", "waiting");
    reduce = true;
    act(() => mediaListeners.forEach((listener) => listener()));
    expect(chart).not.toHaveAttribute("data-arrival");
  });

  it("is whole on paper", () => {
    installBrowser();
    render(<Chart />);
    act(() => { window.dispatchEvent(new Event("beforeprint")); });
    expect(screen.getByTestId("chart")).not.toHaveAttribute("data-arrival");
  });

  it("counts only a text that holds one number", () => {
    installBrowser();
    render(
      <ChartArrival name="test:words" data-testid="words">
        <span><ArrivalCount value="12 votes · 40%" /></span>
        <span><ArrivalCount value="42%" /></span>
      </ChartArrival>,
    );
    expect(screen.getByText("12 votes · 40%").className).toBe("");
    expect(screen.getByText("42%")).toHaveClass("arrive-count__final");
  });

  it("caps the stagger so the longest arrival ends before the chart settles", () => {
    expect(arriveAt(40)["--arrive-i"]).toBe(ARRIVAL.staggerCap);
    expect(ARRIVAL.staggerCap * ARRIVAL.countStaggerMs + ARRIVAL.countMs).toBeLessThan(ARRIVAL.settleMs);
    for (const ms of [ARRIVAL.barMs, ARRIVAL.columnMs, ARRIVAL.meterMs]) expect(ARRIVAL.staggerTotalMs + ms).toBeLessThan(ARRIVAL.settleMs);
    expect(ARRIVAL.lineDelayMs + ARRIVAL.lineMs + ARRIVAL.dotMs).toBeLessThan(ARRIVAL.settleMs);
    // Bars, columns and meters each wait their own stagger, never past the theme's staggerTotal.
    for (const kind of ["bar", "column", "meter"]) {
      expect(motionCss).toContain(`animation-delay: min(calc(var(--arrive-i, 0) * var(--sg-motion-stagger-arrive-${kind})), var(--sg-motion-stagger-arrive-total));`);
    }
  });

  // The theme's chart timings (promo package kit/brand/theme/tokens.json,
  // motion.chart), each under its own name: columns are not bars.
  it("takes its timings from the tokens the stylesheet uses", () => {
    const token = (name) => tokensCss.match(new RegExp(`--sg-motion-${name}:\\s*([^;]+);`))?.[1].trim();
    expect(token("ease-arrive")).toBe("cubic-bezier(.23,1,.32,1)");
    expect(ARRIVAL).toMatchObject({ barMs: 700, barStaggerMs: 70, columnMs: 750, columnStaggerMs: 60, lineDelayMs: 80, lineMs: 950, dotMs: 260, countMs: 800, countStaggerMs: 90, meterMs: 800, meterStaggerMs: 90, staggerTotalMs: 560, seenShare: 0.35 });
    expect(token("duration-arrive-bar")).toBe(`${ARRIVAL.barMs}ms`);
    expect(token("stagger-arrive-bar")).toBe(`${ARRIVAL.barStaggerMs}ms`);
    expect(token("duration-arrive-column")).toBe(`${ARRIVAL.columnMs}ms`);
    expect(token("stagger-arrive-column")).toBe(`${ARRIVAL.columnStaggerMs}ms`);
    expect(token("delay-arrive-line")).toBe(`${ARRIVAL.lineDelayMs}ms`);
    expect(token("duration-arrive-line")).toBe(`${ARRIVAL.lineMs}ms`);
    expect(token("duration-arrive-dot")).toBe(`${ARRIVAL.dotMs}ms`);
    expect(token("duration-arrive-meter")).toBe(`${ARRIVAL.meterMs}ms`);
    expect(token("stagger-arrive-meter")).toBe(`${ARRIVAL.meterStaggerMs}ms`);
    expect(token("stagger-arrive-total")).toBe(`${ARRIVAL.staggerTotalMs}ms`);
    const playing = (cls) => { const start = motionCss.indexOf(`[data-arrival="playing"] .${cls} {`); return motionCss.slice(start, motionCss.indexOf("}", start)); };
    expect(playing("arrive-x")).toContain("var(--sg-motion-duration-arrive-bar)");
    expect(playing("arrive-y")).toContain("var(--sg-motion-duration-arrive-column)");
    expect(playing("arrive-meter")).toContain("var(--sg-motion-duration-arrive-meter)");
    expect(playing("arrive-line")).toContain("animation-delay: var(--sg-motion-delay-arrive-line);");
    expect(playing("arrive-dot")).toContain("animation-delay: calc(var(--sg-motion-delay-arrive-line) + var(--sg-motion-duration-arrive-line));");
  });

  it("keeps the resting empty state behind no-preference and screen, so reduced motion and print show the whole chart", () => {
    const css = motionCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const block = css.slice(css.indexOf("@media screen and (prefers-reduced-motion: no-preference)"));
    expect(block.indexOf('[data-arrival="waiting"] :is(.arrive-x, .arrive-meter)')).toBeGreaterThan(-1);
    const outside = css.slice(0, css.indexOf("@media screen and (prefers-reduced-motion: no-preference)"));
    expect(outside).not.toMatch(/data-arrival="waiting"/);
  });
});
