// #9543 (PR #9674 second read): a one-row tab strip that scrolls sideways must
// bring a tab into view when it takes keyboard focus, and show the current tab
// when the strip is first drawn or the current tab changes. Only the strip's
// own scroll position moves (never the page), and it jumps rather than
// animates, so Reduce Motion is respected. DOM only, no imports, so the browser
// test can load this file as it is.

// The current tab of a routed strip: the routed link marks it aria-current="page"
// (an anchor) or aria-pressed="true" (the button outside the routed app).
const CURRENT_TAB = '[aria-current="page"], [aria-pressed="true"]';

// Scroll the strip just enough that the tab sits fully inside its padding box.
function revealInStrip(strip, tab) {
  if (!strip || !tab || !strip.contains(tab) || tab === strip) return;
  const box = strip.getBoundingClientRect();
  const rect = tab.getBoundingClientRect();
  const style = strip.ownerDocument?.defaultView?.getComputedStyle?.(strip);
  const padStart = Number.parseFloat(style?.paddingLeft) || 0;
  const padEnd = Number.parseFloat(style?.paddingRight) || 0;
  const left = box.left + padStart;
  const right = box.right - padEnd;
  if (rect.left < left) strip.scrollLeft -= left - rect.left;
  else if (rect.right > right) strip.scrollLeft += Math.min(rect.right - right, rect.left - left);
}

// Reveal the strip's current tab (when it has one).
export function revealCurrentInStrip(strip) {
  revealInStrip(strip, strip?.querySelector(CURRENT_TAB));
}

// Bring any descendant tab into view when it takes focus. Returns the cleanup.
export function revealFocusedInStrip(strip) {
  if (!strip) return () => {};
  const onFocus = (event) => {
    const tab = event.target?.closest?.("a, button");
    if (tab && strip.contains(tab)) revealInStrip(strip, tab);
  };
  strip.addEventListener("focusin", onFocus);
  return () => strip.removeEventListener("focusin", onFocus);
}
