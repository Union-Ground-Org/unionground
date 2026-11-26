import { onTestFinished } from "vitest";

// jsdom 31 (#8393) runs the HTML focus fixup rule on a rendering timer: a
// focused element that becomes disabled loses focus to body at the next tick.
// Root tests that check focus right after an action race that timer, and on a
// slow runner they fail (merge groups 43153744329 and 43158041518). tests/setup.js
// turns the timer off for every DOM test, as jsdom 29 behaved. Real browsers do
// apply the rule, so a test that proves a product keeps focus while a control
// is busy turns it back on with enableFocusFixup().
//
// This relies on jsdom's internal window._requestFocusFixup (lib/jsdom/browser/
// Window.js). If a jsdom upgrade renames it, disableFocusFixup throws, so every
// DOM test file fails loudly instead of silently racing the timer again.

const kept = new WeakMap();

export function disableFocusFixup(view = window) {
  const current = view._requestFocusFixup;
  if (typeof current !== "function") {
    throw new Error("jsdom no longer exposes window._requestFocusFixup; update tests/helpers/focusFixup.js for this jsdom version");
  }
  if (!kept.has(view)) kept.set(view, current);
  view._requestFocusFixup = () => {};
}

// For the current test only: the next rendering update moves focus off a
// disabled element, as a browser does. Turned off again when the test ends,
// whether it passed, failed or timed out. A fixup the test already queued is
// held in jsdom's private pending flag, which replacing the hook cannot clear,
// so the cleanup first stops new requests and then lets one rendering update
// run that queued fixup before the next test starts.
export function enableFocusFixup(view = window) {
  const original = kept.get(view);
  if (typeof original !== "function") throw new Error("enableFocusFixup needs tests/setup.js to have kept jsdom's focus fixup");
  view._requestFocusFixup = original;
  onTestFinished(async () => {
    disableFocusFixup(view);
    await afterRenderingUpdate(view);
  });
}

// Resolves after jsdom's next rendering update, which runs animation frame
// callbacks and then the focus fixup (when on) in the same tick.
export const afterRenderingUpdate = (view = window) => new Promise((resolve) => view.requestAnimationFrame(() => view.setTimeout(resolve, 0)));
