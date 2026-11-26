// The alternate shell's motion system (REQ-UG-ALT-PORT-SHELL-MOTION-HOME-20261030),
// ported from the prototype's core.js and pages/home.js: the data-tip tooltip,
// the typewriter headline and the reduced-motion signal every effect reads.
// The keyframes, transitions and the global prefers-reduced-motion rule are
// the prototype's own CSS in styles/design.css; the script half lives here.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

function reduceMedia() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(REDUCE_QUERY) : null;
}

function subscribeReduce(listener) {
  const media = reduceMedia();
  media?.addEventListener?.("change", listener);
  return () => media?.removeEventListener?.("change", listener);
}

// True while the visitor asks for reduced motion; every script-driven effect
// (typewriter, marquee, pointer rings) checks it, as the prototype does.
function usePrefersReducedMotion() {
  return useSyncExternalStore(subscribeReduce, () => Boolean(reduceMedia()?.matches), () => false);
}

// The prototype's typewriter: hold each word 4.5 s, erase at 80 ms a letter,
// rest 600 ms, type at 140 ms a letter. With reduced motion the word swaps
// every 5 s without typing. The caller renders the full list for screen
// readers; this element is aria-hidden.
export const TYPE_HOLD_MS = 4500;
export const TYPE_ERASE_MS = 80;
export const TYPE_REST_MS = 600;
export const TYPE_LETTER_MS = 140;
export const TYPE_CALM_MS = 5000;

export function Typewriter({ words }) {
  const list = (words ?? []).filter((word) => typeof word === "string" && word.length > 0);
  const key = list.join("\u0000");
  const reduce = usePrefersReducedMotion();
  const [state, setState] = useState({ index: 0, shown: list[0]?.length ?? 0, typing: false });
  const timer = useRef(0);

  useEffect(() => {
    setState({ index: 0, shown: list[0]?.length ?? 0, typing: false });
    // `key` stands for the list's contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (list.length < 2) return undefined;
    const { index, shown, typing } = state;
    const word = list[index % list.length] ?? "";
    let wait;
    let next;
    if (reduce) {
      wait = TYPE_CALM_MS;
      next = { index: (index + 1) % list.length, shown: (list[(index + 1) % list.length] ?? "").length, typing: false };
    } else if (!typing && shown >= word.length) {
      // Holding the whole word, then start erasing.
      wait = TYPE_HOLD_MS;
      next = { index, shown: shown - 1, typing: false, erasing: true };
    } else if (state.erasing) {
      if (shown <= 0) {
        wait = TYPE_REST_MS;
        next = { index: (index + 1) % list.length, shown: 0, typing: true };
      } else {
        wait = TYPE_ERASE_MS;
        next = { index, shown: shown - 1, typing: false, erasing: true };
      }
    } else {
      wait = TYPE_LETTER_MS;
      next = shown + 1 >= word.length ? { index, shown: word.length, typing: false } : { index, shown: shown + 1, typing: true };
    }
    timer.current = window.setTimeout(() => setState(next), wait);
    return () => window.clearTimeout(timer.current);
    // `key` stands for the list's contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, reduce, key]);

  if (!list.length) return null;
  const word = list[state.index % list.length] ?? "";
  return (
    <span className="ug-accent ug-tw" aria-hidden="true">
      {/* The widest word reserves the line so the heading never reflows. */}
      <span className="ug-tw-size">{list.map((item) => <span key={item}>{item}</span>)}</span>
      <span className="ug-type-word">{word.slice(0, Math.max(0, state.shown))}{reduce || list.length < 2 ? null : <span className="ug-caret" />}</span>
    </span>
  );
}

// The prototype's tooltip: any element with data-tip (and an optional
// data-tip-sub) inside the alternate shell shows one tooltip above it on
// pointer hover or keyboard focus, hidden on scroll. One layer per shell.
// As in core.js the one element stays once shown: `ug-on` fades it in and
// out (.12s, design.css .ug-tip), and while it is off it is hidden from
// assistive technology.
export function TooltipLayer({ rootRef }) {
  const tipRef = useRef(null);
  const [tip, setTip] = useState(null);

  useEffect(() => {
    const root = rootRef?.current?.closest?.(".ugalt") ?? null;
    if (!root) return undefined;
    const show = (element) => {
      const title = element.getAttribute("data-tip");
      if (!title) return;
      setTip({ title, sub: element.getAttribute("data-tip-sub") || "", rect: element.getBoundingClientRect() });
    };
    const hide = () => {
      const element = tipRef.current;
      if (!element) return;
      element.classList.remove("ug-on");
      element.setAttribute("aria-hidden", "true");
    };
    const over = (event) => { const element = event.target?.closest?.("[data-tip]"); if (element && root.contains(element)) show(element); };
    const out = (event) => { if (event.target?.closest?.("[data-tip]")) hide(); };
    const focus = (event) => { const element = event.target?.closest?.("[data-tip]"); if (element && root.contains(element)) show(element); else hide(); };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("focusin", focus);
    window.addEventListener("scroll", hide, { passive: true });
    return () => {
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("focusin", focus);
      window.removeEventListener("scroll", hide);
    };
  }, [rootRef]);

  // Place above the target, clamped to the viewport; below when there is no
  // room above (core.js showTip). Measuring flushes the off state first, so
  // adding `ug-on` afterwards runs the fade.
  useLayoutEffect(() => {
    const element = tipRef.current;
    if (!element || !tip) return;
    const box = element.getBoundingClientRect();
    const width = window.innerWidth || 0;
    let x = tip.rect.left + tip.rect.width / 2 - box.width / 2;
    let y = tip.rect.top - box.height - 10;
    x = Math.max(10, Math.min(width - box.width - 10, x));
    if (y < 10) y = tip.rect.bottom + 10;
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
    element.removeAttribute("aria-hidden");
    element.classList.add("ug-on");
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={tipRef} className="ug-tip" role="tooltip" id="ug-tip">
      <b>{tip.title}</b>{tip.sub ? <small>{tip.sub}</small> : null}
    </div>
  );
}
