import { useEffect, useRef } from "react";

// The design's dotted canvas behind the top of every page (`.ug-dots`), with
// its pointer glow: dots near a mouse pointer swell and turn gold, and a press
// sends three rings out. Ported from the export's `UG.glow` (October 10, 2026)
// with the same constants. Touch pointers get no hover swell; a tap sends the
// rings, as the design's own press handler does. Reduced motion keeps the
// hover swell but sends no rings, and environments without ResizeObserver or
// a 2D canvas (tests, old browsers) keep the plain dots.
const STEP = 26;
const DOT = 1.15;
const REACH = 170;
const BAND = 34;
const SPEED = 0.42;
const FAR = 520;
const WAVES = [0, 220, 440];

export function attachDotGlow(host) {
  if (!host || typeof window === "undefined" || !window.ResizeObserver) return () => {};
  const canvas = document.createElement("canvas");
  let ctx = null;
  try { ctx = canvas.getContext("2d"); } catch { ctx = null; }
  if (!ctx) return () => {};
  canvas.className = "ug-dots-glow";
  canvas.setAttribute("aria-hidden", "true");
  host.append(canvas);
  const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  const gold = getComputedStyle(host).getPropertyValue("--ug-gold").trim() || "#efa738";
  let width = 0;
  let height = 0;
  let aim = null;
  let at = null;
  let rings = [];
  let raf = 0;
  let drawn = null;
  let client = null;

  const box = () => {
    const zones = [];
    if (at) zones.push([at.x, at.y, REACH + 5]);
    for (const ring of rings) if (ring.r > 0) zones.push([ring.x, ring.y, ring.r + BAND + 5]);
    if (!zones.length) return null;
    const b = zones.reduce((acc, [x, y, r]) => ({
      x0: Math.min(acc.x0, x - r), y0: Math.min(acc.y0, y - r), x1: Math.max(acc.x1, x + r), y1: Math.max(acc.y1, y + r),
    }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    b.x0 = Math.max(0, b.x0); b.y0 = Math.max(0, b.y0); b.x1 = Math.min(width, b.x1); b.y1 = Math.min(height, b.y1);
    return b.x1 > b.x0 && b.y1 > b.y0 ? b : null;
  };

  const paint = () => {
    const b = box();
    const clear = drawn && b
      ? { x0: Math.min(drawn.x0, b.x0), y0: Math.min(drawn.y0, b.y0), x1: Math.max(drawn.x1, b.x1), y1: Math.max(drawn.y1, b.y1) }
      : drawn || b;
    if (clear) ctx.clearRect(clear.x0 - 2, clear.y0 - 2, clear.x1 - clear.x0 + 4, clear.y1 - clear.y0 + 4);
    drawn = b;
    if (!b) return;
    ctx.fillStyle = gold;
    for (let y = Math.ceil(b.y0 / STEP) * STEP; y <= b.y1; y += STEP) {
      for (let x = Math.ceil(b.x0 / STEP) * STEP; x <= b.x1; x += STEP) {
        let k = at ? 1 - Math.hypot(x - at.x, y - at.y) / REACH : 0;
        for (const ring of rings) if (ring.r > 0) k = Math.max(k, (1 - Math.abs(Math.hypot(x - ring.x, y - ring.y) - ring.r) / BAND) * ring.f);
        if (k <= 0) continue;
        ctx.globalAlpha = 0.2 + 0.65 * k;
        ctx.beginPath();
        ctx.arc(x, y, DOT + 2.4 * k, 0, 6.2832);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  };

  const tick = (time) => {
    raf = 0;
    let busy = false;
    if (aim && !at) { at = { ...aim }; busy = true; }
    else if (aim) {
      const dx = aim.x - at.x;
      const dy = aim.y - at.y;
      busy = Math.abs(dx) > 0.3 || Math.abs(dy) > 0.3;
      at = busy ? { x: at.x + dx * 0.22, y: at.y + dy * 0.22 } : { ...aim };
    } else if (at) { at = null; busy = true; }
    for (const ring of rings) { ring.r = (time - ring.t0) * SPEED; ring.f = Math.max(0, 1 - ring.r / FAR) * ring.s; }
    const had = rings.length;
    rings = rings.filter((ring) => ring.r < FAR);
    if (busy || had) paint();
    if (busy || rings.length) raf = requestAnimationFrame(tick);
  };
  const go = () => { if (!raf) raf = requestAnimationFrame(tick); };

  const size = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = host.clientWidth;
    height = host.clientHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawn = null;
    paint();
  };
  const local = (cx, cy) => {
    const rect = host.getBoundingClientRect();
    return cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom ? { x: cx - rect.left, y: cy - rect.top } : null;
  };
  const move = (event) => {
    if (event.pointerType === "touch") return;
    client = [event.clientX, event.clientY];
    aim = local(...client);
    go();
  };
  const scroll = () => { if (client) { aim = local(...client); go(); } };
  const down = (event) => {
    if (calm) return;
    const point = local(event.clientX, event.clientY);
    if (!point) return;
    const t0 = performance.now();
    WAVES.forEach((delay, index) => rings.push({ x: point.x, y: point.y, t0: t0 + delay, r: 0, f: 0, s: 1 - index * 0.3 }));
    go();
  };
  const away = () => { client = null; aim = null; go(); };

  const observer = new ResizeObserver(size);
  observer.observe(host);
  size();
  window.addEventListener("pointermove", move, { passive: true });
  window.addEventListener("pointerdown", down, { passive: true });
  window.addEventListener("scroll", scroll, { passive: true });
  document.documentElement.addEventListener("mouseleave", away);
  return () => {
    cancelAnimationFrame(raf);
    observer.disconnect();
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerdown", down);
    window.removeEventListener("scroll", scroll);
    document.documentElement.removeEventListener("mouseleave", away);
    canvas.remove();
  };
}

export default function DotGrid() {
  const ref = useRef(null);
  useEffect(() => attachDotGlow(ref.current), []);
  return <div ref={ref} className="ug-dots" aria-hidden="true" />;
}
