import confetti from "canvas-confetti";

// REQ-UG-MILESTONE-CONFETTI-CELEBRATIONS-20261102: one brief,
// restrained celebration for confirmed milestones, in the aubergine-and-gold
// identity. A small burst for a smaller milestone, two side cannons for a
// major one. canvas-confetti draws on its own fixed, pointer-events: none
// canvas, so nothing here takes focus, intercepts input or widens the page.
// The CSS reduced-motion guard cannot reach a canvas, so this checks the
// preference itself and draws nothing; the caller's success text stays.

// Identity tokens (sg-tokens.css): aubergine, its gradient end, picket gold
// and soft gold. Read at fire time so a token change needs no edit here.
const COLOR_TOKENS = Object.freeze(["--sg-light-brand", "--sg-light-brand-2", "--sg-light-accent", "--sg-color-gold-soft"]);

function prefersReducedMotion() {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

// A browser (or test DOM) without a 2D canvas would throw from the library's
// animation frame; such a page simply gets no particles.
let canvasChecked = null;
function canvasSupported() {
  if (canvasChecked !== null) return canvasChecked;
  try {
    canvasChecked = typeof document !== "undefined" && Boolean(document.createElement("canvas").getContext?.("2d"));
  } catch {
    canvasChecked = false;
  }
  return canvasChecked;
}

function identityColors() {
  if (typeof document === "undefined") return undefined;
  const style = getComputedStyle(document.documentElement);
  const colors = COLOR_TOKENS.map((token) => style.getPropertyValue(token).trim()).filter(Boolean);
  return colors.length ? colors : undefined;
}

// Returns true when it drew. `fire` is canvas-confetti, injectable for tests.
export function celebrate(size = "small", { fire = confetti, canvas = canvasSupported } = {}) {
  if (prefersReducedMotion() || !canvas()) return false;
  const base = { colors: identityColors(), disableForReducedMotion: true, zIndex: 10000, ticks: 160, scalar: 0.9 };
  if (size === "major") {
    fire({ ...base, particleCount: 55, angle: 60, spread: 55, startVelocity: 55, origin: { x: 0, y: 0.75 } });
    fire({ ...base, particleCount: 55, angle: 120, spread: 55, startVelocity: 55, origin: { x: 1, y: 0.75 } });
  } else {
    fire({ ...base, particleCount: 45, spread: 65, startVelocity: 32, origin: { x: 0.5, y: 0.6 } });
  }
  return true;
}

// Once per milestone key on this browser, so reopening or rerendering a
// completed screen never replays it. The key is recorded even when motion is
// reduced: the milestone was marked, only its particles were withheld.
//
// Storage is read inside the try: a browser that blocks it throws from the
// localStorage getter itself. Without storage the key is
// remembered for this page only, so it still fires at most once per load.
const celebratedThisPage = new Set();
const fromLocalStorage = () => globalThis.localStorage;
export function celebrateOnce(key, size = "small", { storage = fromLocalStorage, fire = confetti, canvas = canvasSupported } = {}) {
  const storageKey = `union-ground:celebrated:${key}`;
  if (celebratedThisPage.has(storageKey)) return false;
  celebratedThisPage.add(storageKey);
  try {
    const store = typeof storage === "function" ? storage() : storage;
    if (store?.getItem?.(storageKey)) return false;
    store?.setItem?.(storageKey, "1");
  } catch {
    // Storage refused (blocked, private mode, quota): the page memory above
    // still keeps this to once per load.
  }
  return celebrate(size, { fire, canvas });
}
