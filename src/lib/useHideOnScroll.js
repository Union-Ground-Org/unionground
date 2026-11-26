import { useEffect, useState } from "react";

// Scroll-direction chrome hiding for the phone shell: scrolling down tucks
// the bar away so the content owns the viewport, scrolling up (or landing
// near the top) brings it back. The window is the scroll container on phone
// widths — App's navigation resets use window.scrollTo the same way.
//
// Deltas come from RAW scrollY on purpose: a bottom clamp would recompute
// against live innerHeight, and an iOS toolbar collapse or bounce that
// resizes the viewport would then manufacture a phantom delta and flap the
// bars with the finger still. Raw scrollY only moves when the page actually
// scrolls. The zero-floor still absorbs top rubber-banding (negative
// scrollY), and the reveal ceiling keeps the bounce-back from tucking the
// chrome while the member is effectively at the top.
const REVEAL_CEILING = 64;
const JITTER = 6;

export function useHideOnScroll(enabled = true) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return undefined;
    setHidden(false);
    let last = Math.max(0, window.scrollY || 0);
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const y = Math.max(0, window.scrollY || 0);
        const delta = y - last;
        if (Math.abs(delta) <= JITTER) return;
        last = y;
        setHidden(delta > 0 && y > REVEAL_CEILING);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [enabled]);
  return enabled ? hidden : false;
}
