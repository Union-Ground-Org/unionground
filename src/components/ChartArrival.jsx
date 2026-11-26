import { createContext, createElement, useContext, useEffect, useMemo, useRef, useState } from "react";
import { splitFlowValue } from "./FlowValue.jsx";

// Charts arrive once: decision 4 of the Union Ground theme (owner, November 13,
// 2026). The first time a chart or poll result is seen its bars rise, its line
// draws across and its numbers count up, as the theme guide's charts do. It
// never plays again on that visit (the set below lives as long as the page),
// never on a data refresh (a chart that has arrived renders finished), and not
// at all under reduced motion, in print, under automation or where the browser
// cannot tell when it is seen. Every mark moves by transform, clip or opacity
// only, so nothing around a chart shifts, and the finished values stay in the
// accessibility tree the whole time.
//
// Timings are the theme's own, each under its own name (promo package
// kit/brand/theme/tokens.json, motion.chart): bars 700ms with 70ms between
// them, columns 750ms with 60ms, a line 950ms after an 80ms wait and then its
// end dot 260ms, numbers 800ms with 90ms, meters 800ms with 90ms, and a run of
// bars, columns or meters spread over at most 560ms (staggerTotal), all on the
// theme's motion ease. The CSS half is in src/motion.css and the durations are
// the --sg-motion-*-arrive-* tokens in src/sg-tokens.css.
export const ARRIVAL = Object.freeze({
  barMs: 700,
  barStaggerMs: 70,
  columnMs: 750,
  columnStaggerMs: 60,
  lineDelayMs: 80,
  lineMs: 950,
  dotMs: 260,
  countMs: 800,
  countStaggerMs: 90,
  meterMs: 800,
  meterStaggerMs: 90,
  // A run of bars, columns or meters starts within this (motion.css caps
  // each mark's delay at it).
  staggerTotalMs: 560,
  // Numbers stop staggering after this many (the theme's staggerTotal names
  // bars, columns and meters only), so the longest arrival is
  // 12 * 90 + 800 = 1880ms; after settleMs a chart renders finished, and
  // marks a refresh adds appear without motion.
  staggerCap: 12,
  settleMs: 2000,
  // Seen means at least this share of the chart, or of the viewport for a
  // chart taller than the screen, is on screen (motion.chart.seen).
  seenShare: 0.35,
});

const MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const arrived = new Set();
const ArrivalPhase = createContext("done");

function motionAllowed() {
  const win = globalThis.window;
  if (!win || typeof win.IntersectionObserver !== "function" || typeof win.matchMedia !== "function") return false;
  if (win.navigator?.webdriver) return false;
  return !win.matchMedia(MOTION_QUERY).matches;
}

// Test-only: forget which charts have arrived.
export function resetChartArrivals() {
  arrived.clear();
}

/**
 * The arrival phase of one named chart: "waiting" (drawn empty until seen),
 * "playing" (arriving) or "done" (finished; the only phase without motion).
 * The name says which chart this is across remounts and refreshes.
 */
function useChartArrival(name) {
  const ref = useRef(null);
  const [phase, setPhase] = useState(() => (name && !arrived.has(name) && motionAllowed() ? "waiting" : "done"));

  useEffect(() => {
    if (phase !== "waiting") return undefined;
    const node = ref.current;
    if (!node) return undefined;
    const finish = (next) => {
      observer.disconnect();
      arrived.add(name);
      setPhase(next);
    };
    const observer = new IntersectionObserver((entries) => {
      const seen = entries.some((entry) => entry.isIntersecting && (entry.intersectionRatio >= ARRIVAL.seenShare
        || entry.intersectionRect.height >= (entry.rootBounds?.height || globalThis.innerHeight || 0) * ARRIVAL.seenShare));
      if (seen) finish(motionAllowed() ? "playing" : "done");
    }, { threshold: [0, 0.1, 0.2, ARRIVAL.seenShare, 0.5, 0.75, 1] });
    observer.observe(node);
    // On paper every chart is whole, whether or not it was reached on screen.
    const print = () => finish("done");
    const media = globalThis.window.matchMedia(MOTION_QUERY);
    const still = () => { if (media.matches) finish("done"); };
    globalThis.window.addEventListener("beforeprint", print);
    media.addEventListener?.("change", still);
    return () => {
      observer.disconnect();
      globalThis.window.removeEventListener("beforeprint", print);
      media.removeEventListener?.("change", still);
    };
  }, [phase, name]);

  useEffect(() => {
    if (phase !== "playing") return undefined;
    const timer = setTimeout(() => setPhase("done"), ARRIVAL.settleMs);
    return () => clearTimeout(timer);
  }, [phase]);

  return { ref, phase };
}

/**
 * The element that holds one chart. Its marks carry `arrive-x` (a bar growing
 * from the start edge), `arrive-y` (a column rising), `arrive-meter` (a
 * progress meter filling from the start edge), `arrive-line` (a line or area
 * drawn across) or `arrive-dot` (a mark that appears when its line ends),
 * with `--arrive-i` as the mark's place in the stagger; ArrivalCount numbers
 * inside it count up.
 */
export function ChartArrival({ name, as = "div", children, ...props }) {
  const { ref, phase } = useChartArrival(name);
  return (
    <ArrivalPhase.Provider value={phase}>
      {createElement(as, { ...props, ref, "data-arrival": phase === "done" ? undefined : phase }, children)}
    </ArrivalPhase.Provider>
  );
}

/** The style that places a mark in the arrival stagger. */
export function arriveAt(index, style) {
  return { ...style, "--arrive-i": Math.min(index, ARRIVAL.staggerCap) };
}

// A number counts only when it is the one number in its text: "1,204" and
// "42%" count, "12 votes · 40%" stays as it is rather than count half its
// figures.
function countParts(value, locales) {
  const parts = splitFlowValue(value, locales);
  if (!parts || /\d/.test(parts.prefix) || /\d/.test(parts.suffix)) return null;
  return parts;
}

const ease = (t) => 1 - (1 - t) ** 4;

/**
 * A chart's number. Finished, it is the value as given. While its chart waits
 * and arrives, the finished value keeps its place (transparent, still read by
 * screen readers) and a hidden copy over it counts up from zero.
 */
export function ArrivalCount({ value, index = 0, locales = "en-US" }) {
  const phase = useContext(ArrivalPhase);
  const parts = useMemo(() => countParts(value, locales), [value, locales]);
  const format = useMemo(() => (parts ? new Intl.NumberFormat(parts.locales, parts.format) : null), [parts]);
  // undefined: not started; a string: counting; null: counted.
  const [running, setRunning] = useState(undefined);
  const counted = useRef(false);
  const at = (share) => `${parts.prefix}${format.format(parts.number * share)}${parts.suffix}`;

  useEffect(() => {
    if (phase !== "playing" || !parts || counted.current) return undefined;
    const start = performance.now() + Math.min(index, ARRIVAL.staggerCap) * ARRIVAL.countStaggerMs;
    let frame = 0;
    const step = (now) => {
      const t = Math.min(1, Math.max(0, (now - start) / ARRIVAL.countMs));
      if (t >= 1) { counted.current = true; setRunning(null); return; }
      setRunning(`${parts.prefix}${format.format(parts.number * ease(t))}${parts.suffix}`);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [phase, parts, format, index]);

  const shown = !parts ? null : phase === "waiting" ? at(0) : phase === "playing" && running !== null ? running ?? at(0) : null;
  if (shown == null) return value;
  return (
    <span className="arrive-count">
      <span className="arrive-count__final">{value}</span>
      <span className="arrive-count__run" aria-hidden="true">{shown}</span>
    </span>
  );
}
