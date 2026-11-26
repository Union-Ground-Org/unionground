import { useEffect, useRef, useState } from "react";

// UX-UG-ONE-ORBIT-ENGINE-FOR-HOME-AND-SIGN-IN-20261113: the one orbit
// engine behind the sign-in story side (SignInOrbit, #8669) and the home
// page's original orbit (HomeOrbit). It is SignInOrbit's engine, moved here so
// both pages draw the same thing the same way: the promo package's orbit
// (sign-in/orbit-original.html) rebuilt as bundled code, because the
// Content-Security-Policy refuses the package's inline script.
//
// The rings carry Union Ground's own capability icons, never a union's logo
// (owner answers of November 13, 2026, choice 5). Paths are copied from the
// package's kit/brand/theme/icons.json; each ring shows its icons twice, half a
// turn apart. The globe stops while it is off screen, while the tab is hidden,
// while paused and under reduced motion (followed live), keeps its points and
// angle across pauses, and projects into reused typed arrays.
//
// Each page keeps its own sheet and sizes: `prefix` names the classes and
// custom properties the markup uses (sgauth-orbit, site-home-orbit),
// `ringSizes` sets each ring's --<prefix>-n, and every ring carries
// data-ring (0, 1, 2) for sheets that size rings per breakpoint.
// Also drawn by the small orbit of sign-in designs 2 to 4 (SignInDesignStory.jsx).
export const ICONS = {
  messages: <><path d="M4.2 6.4a2 2 0 0 1 2-2h11.6a2 2 0 0 1 2 2v8.2a2 2 0 0 1-2 2h-6.3L7.4 20v-3.4H6.2a2 2 0 0 1-2-2z" /><path d="M8.2 9h7.6M8.2 12.2h4.6" /></>,
  calendar: <><rect x="3.8" y="5.2" width="16.4" height="15" rx="2.6" /><path d="M3.8 9.9h16.4M8.2 3.4v3.5M15.8 3.4v3.5" /></>,
  vote: <><path d="M4.4 13.2h15.2v5.4a1.6 1.6 0 0 1-1.6 1.6H6a1.6 1.6 0 0 1-1.6-1.6z" /><path d="m8 13.2 1.4-8h5.2l1.4 8" /><path d="m10.4 8.8 1.3 1.3 2.2-2.4" /></>,
  cases: <><path d="M3.8 8.6a2 2 0 0 1 2-2h12.4a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5.8a2 2 0 0 1-2-2z" /><path d="M9 6.6V5.4A1.4 1.4 0 0 1 10.4 4h3.2A1.4 1.4 0 0 1 15 5.4v1.2" /><path d="M3.8 12.4h16.4M12 11.2v2.4" /></>,
  rights: <><path d="M12 3.6 5 6.3v5.2c0 4.3 2.9 7.4 7 8.9 4.1-1.5 7-4.6 7-8.9V6.3z" /><path d="m9.1 12 2 2 3.8-4.1" /></>,
  contract: <><path d="M6.4 3.8h7.4l4.4 4.4v10a2 2 0 0 1-2 2H6.4a2 2 0 0 1-2-2V5.8a2 2 0 0 1 2-2z" /><path d="M13.6 3.8v4.6h4.6M8 12.4h7M8 15.8h4.6" /></>,
  compass: <><circle cx="12" cy="12" r="8.6" /><path d="m15.5 8.5-2.1 4.9-4.9 2.1 2.1-4.9z" /></>,
  chapters: <><circle cx="9" cy="8.6" r="3.2" /><path d="M3.4 19.6c.4-3.3 2.6-5.3 5.6-5.3s5.2 2 5.6 5.3" /><path d="M15.4 5.7a3.2 3.2 0 0 1 0 5.9M17.2 14.6c1.9.7 3.1 2.4 3.4 5" /></>,
};

// Ring diameters, turn times and start angles are the design's (0.8 of the
// reference's desktop sizes); the icons are orbit-original's, in its order.
export const ORBIT_RINGS = Object.freeze([
  { size: 576, seconds: 18, clockwise: true, icons: [["messages", -60], ["calendar", 0], ["vote", 60]] },
  { size: 704, seconds: 24, clockwise: false, icons: [["cases", 0], ["rights", -90]] },
  { size: 848, seconds: 30, clockwise: true, icons: [["contract", -60], ["compass", 0], ["chapters", 60]] },
]);

// The globe: the design's particle sphere (same projection, radius and 0.003
// rad per frame). Every colour is a Union Ground theme token, named beside it.
const POINT_COUNT = 9000;
const RADIUS = 275;
const SIZE = 575;
const COLORS = [
  "#efa738", // gold
  "#f7c56e", // gold-hover
  "#137c54", // signal
  "#cfe0d8", // tint-2
  "#9aa39d", // ink-4 (a dot, never text)
  "#0e4034", // green
  "#1b6e49", // green-text
  "#137c54", // signal
  "#efa738", // gold
];

function makePoints() {
  const x = new Float32Array(POINT_COUNT);
  const y = new Float32Array(POINT_COUNT);
  const z = new Float32Array(POINT_COUNT);
  const color = new Uint8Array(POINT_COUNT);
  for (let index = 0; index < POINT_COUNT; index += 1) {
    const height = Math.random() * 2 - 1;
    const angle = Math.random() * 2 * Math.PI;
    const horizontal = Math.sqrt(1 - height * height);
    const radius = RADIUS * (0.97 + Math.random() * 0.06);
    y[index] = radius * horizontal * Math.sin(angle);
    const latitude = (y[index] + RADIUS) / (2 * RADIUS);
    color[index] = Math.random() > 0.9 ? 7
      : latitude > 0.6 ? Math.floor(Math.random() * 3)
        : latitude < 0.4 ? 3 + Math.floor(Math.random() * 3)
          : Math.floor(Math.random() * COLORS.length);
    x[index] = radius * horizontal * Math.cos(angle);
    z[index] = radius * height;
  }
  return { x, y, z, color };
}

function paintSphere(context, points, angle, scratch) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const { px, pz, order } = scratch;
  for (let index = 0; index < POINT_COUNT; index += 1) {
    px[index] = points.x[index] * cosine - points.z[index] * sine;
    pz[index] = points.x[index] * sine + points.z[index] * cosine;
    order[index] = index;
  }
  order.sort((left, right) => pz[left] - pz[right]);
  context.clearRect(0, 0, SIZE, SIZE);
  context.save();
  context.translate(SIZE / 2, SIZE / 2);
  for (const index of order) {
    const depth = (pz[index] + RADIUS) / (2 * RADIUS);
    const pointY = points.y[index];
    const edge = Math.min(Math.sqrt(px[index] * px[index] + pointY * pointY) / RADIUS, 1);
    context.beginPath();
    context.arc(px[index], pointY, (0.4 + 0.8 * depth) * 1.5, 0, Math.PI * 2);
    context.fillStyle = COLORS[points.color[index]];
    context.globalAlpha = Math.max(0.1, edge ** 3 * 0.8) * (0.4 + 0.6 * depth);
    context.fill();
  }
  context.globalAlpha = 1;
  context.restore();
}

function reducedMotionQuery() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;
}

// The pause choice can be held by the caller: the sign-in
// page keeps one choice for design 1's orbit and the story of designs 2 and 4,
// so a visitor's Pause survives a late release answer that swaps the design.
// Without those props the orbit keeps the choice itself (the home page).
export default function UnionOrbit({ prefix, ringSizes = ORBIT_RINGS.map((ring) => ring.size), label, pauseLabel, playLabel, paused: heldPaused, onPausedChange }) {
  const globeRef = useRef(null);
  const canvasRef = useRef(null);
  const [reduced, setReduced] = useState(() => Boolean(reducedMotionQuery()?.matches));
  const [ownPlaying, setOwnPlaying] = useState(true);
  const held = typeof onPausedChange === "function";
  const playing = held ? !heldPaused : ownPlaying;
  const [onScreen, setOnScreen] = useState(true);
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const running = playing && !reduced && onScreen && pageVisible;

  useEffect(() => {
    const query = reducedMotionQuery();
    if (!query) return undefined;
    const onChange = () => setReduced(query.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);

  useEffect(() => {
    const onVisibility = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    const globe = globeRef.current;
    if (!globe || typeof IntersectionObserver !== "function") return () => document.removeEventListener("visibilitychange", onVisibility);
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting));
    observer.observe(globe);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
    };
  }, []);

  // One loop draws the globe: it advances only while running and otherwise
  // leaves one still frame, so motion stops everywhere at once. The sphere
  // (points, angle, scratch arrays) lives in a ref, so Pause and Play carry on
  // from where the globe stopped.
  const sphereRef = useRef(null);
  useEffect(() => {
    const context = canvasRef.current?.getContext?.("2d", { alpha: true });
    if (!context) return undefined;
    sphereRef.current ??= {
      points: makePoints(),
      angle: 0,
      scratch: { px: new Float32Array(POINT_COUNT), pz: new Float32Array(POINT_COUNT), order: new Uint32Array(POINT_COUNT) },
    };
    const sphere = sphereRef.current;
    paintSphere(context, sphere.points, sphere.angle, sphere.scratch);
    if (!running) return undefined;
    let frame = requestAnimationFrame(function tick() {
      sphere.angle += 0.003;
      paintSphere(context, sphere.points, sphere.angle, sphere.scratch);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [running]);

  // Decorative beside a story (sign-in), or one labelled picture (home).
  const naming = label ? { role: "img", "aria-label": label } : { "aria-hidden": "true" };
  return (
    <div className={prefix}>
      <div className={`${prefix}__globe`} ref={globeRef} {...naming} data-paused={running ? "false" : "true"}>
        <div className={`${prefix}__sphere`}><canvas ref={canvasRef} width={SIZE} height={SIZE} /></div>
        {ORBIT_RINGS.map((ring, index) => (
          <div key={ring.size} className={`${prefix}__ring`} data-ring={index} data-direction={ring.clockwise ? "clockwise" : "counterclockwise"}
            style={{ [`--${prefix}-n`]: ringSizes[index], [`--${prefix}-seconds`]: `${ring.seconds}s` }}>
            {ring.icons.flatMap(([name, angle]) => [[name, angle], [name, angle + 180]]).map(([name, angle]) => (
              <div key={`${name}-${angle}`} className={`${prefix}__arm`} style={{ [`--${prefix}-start`]: `${angle}deg`, [`--${prefix}-counter`]: `${-angle}deg` }}>
                <div className={`${prefix}__tile`} data-icon={name}>
                  <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">{ICONS[name]}</svg>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      {/* WCAG 2.2.2: motion that lasts longer than five seconds can be paused.
          Under reduced motion nothing moves, so there is nothing to pause. */}
      <button className={`${prefix}__motion`} type="button" hidden={reduced}
        onClick={() => (held ? onPausedChange(playing) : setOwnPlaying((current) => !current))}>
        {playing ? pauseLabel : playLabel}
      </button>
    </div>
  );
}
