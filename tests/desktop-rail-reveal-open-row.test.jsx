import { readFileSync } from "node:fs";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopRail } from "../src/components/DesktopRail.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

// BUG-UG-STAFF-RAIL-LAST-GROUP-HIDDEN-UNDER-FOOTER-20261106: the rail
// scrolls only its own list, by the least amount, so the open page's row is
// inside it; it re-checks when the list resizes and stops at the viewer's first
// interaction. jsdom has no layout, so boxes and the ResizeObserver are stubbed.
let resizeCallbacks;
let rowBox;
let listBox;
const realRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  resizeCallbacks = [];
  rowBox = { top: 700, bottom: 744 };
  listBox = { top: 120, bottom: 600 };
  globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback; resizeCallbacks.push(callback); } observe() {} disconnect() { resizeCallbacks = resizeCallbacks.filter((entry) => entry !== this.callback); } };
  Element.prototype.getBoundingClientRect = function rect() {
    if (this.classList?.contains("desktop-rail__items")) return { ...listBox, left: 0, right: 240, width: 240, height: listBox.bottom - listBox.top };
    if (this.getAttribute?.("aria-current") === "page") {
      // The row moves with the list's scroll position, as in a real layout.
      const scrolled = this.closest(".desktop-rail__items")?.scrollTop ?? 0;
      return { top: rowBox.top - scrolled, bottom: rowBox.bottom - scrolled, left: 0, right: 240, width: 240, height: rowBox.bottom - rowBox.top };
    }
    return realRect.call(this);
  };
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
  delete globalThis.ResizeObserver;
});

function renderRail(active = "settings") {
  return render(<LanguageProvider lang="en">
    <div className="sg-app sg-app--desktop">
      <DesktopRail active={active} activeHat="member" demo={false} memberId="member-a" onAsk={() => {}} onNavigate={() => {}} renderMode="desktop" />
    </div>
  </LanguageProvider>);
}

it("scrolls the list down just far enough to show an open row below its fold, clear of the palette strip's fade", () => {
  const { container } = renderRail();
  const list = container.querySelector(".desktop-rail__items:not(.desktop-rail__items--foot)");
  // Row bottom 744 against the list's clear bottom 576 (600 less the 24px
  // fade of the palette strip, #9565 A-40): 168 plus the 8px margin.
  expect(list.scrollTop).toBe(176);
  expect(container.querySelector(".desktop-rail__items--foot .desktop-rail__palette")).not.toBeNull();
  expect(list.querySelector(".desktop-rail__palette")).toBeNull();
});

it("scrolls up for a row above the list, re-checks on resize, and stops at the first interaction", () => {
  rowBox = { top: 300, bottom: 344 };
  const { container } = renderRail();
  const list = container.querySelector(".desktop-rail__items:not(.desktop-rail__items--foot)");
  expect(list.scrollTop).toBe(0);
  // The viewer had scrolled past the row; a resize (the header growing)
  // re-runs the check: the row now sits 30px above the list's clear top (120
  // plus the 10px sticky fade), plus 8.
  list.scrollTop = 200;
  act(() => { for (const callback of resizeCallbacks) callback([]); });
  expect(list.scrollTop).toBe(162);
  // After the viewer's own scroll in the rail, a resize no longer moves it.
  list.dispatchEvent(new Event("wheel"));
  list.scrollTop = 400;
  act(() => { for (const callback of resizeCallbacks) callback([]); });
  expect(list.scrollTop).toBe(400);
});

it("leaves a row that is already inside the list where it is", () => {
  rowBox = { top: 300, bottom: 344 };
  const { container } = renderRail();
  expect(container.querySelector(".desktop-rail__items:not(.desktop-rail__items--foot)").scrollTop).toBe(0);
});

// #9565 A-40: a row inside the list's box but under one of the fades painted
// over its edges (the palette strip's shadow below, the sticky fade above)
// was left there, half hidden. It is now moved clear of the fade.
it("moves a row that sits under the palette strip's fade or the top fade clear of it", () => {
  rowBox = { top: 546, bottom: 590 };
  const { container, unmount } = renderRail();
  const list = container.querySelector(".desktop-rail__items:not(.desktop-rail__items--foot)");
  // Row bottom 590 against the clear bottom 576: 14 plus 8.
  expect(list.scrollTop).toBe(22);
  unmount();
  rowBox = { top: 425, bottom: 469 };
  const again = renderRail();
  const second = again.container.querySelector(".desktop-rail__items:not(.desktop-rail__items--foot)");
  second.scrollTop = 300;
  act(() => { for (const callback of resizeCallbacks) callback([]); });
  // Row top 125 against the clear top 130: 5 plus 8.
  expect(second.scrollTop).toBe(287);
});

it("matches the fades it clears to the ones the stylesheet paints", () => {
  const css = readFileSync("src/styles.css", "utf8");
  expect(css).toMatch(/\.desktop-rail__items:not\(\.desktop-rail__items--foot\)::before \{[^}]*\bheight: 10px;/);
  expect(css).toMatch(/\.desktop-rail__items \.desktop-rail__palette \{ box-shadow: 0 -12px 12px /);
  const source = readFileSync("src/components/DesktopRail.jsx", "utf8");
  expect(source).toMatch(/const RAIL_LIST_TOP_FADE_PX = 10;/);
  expect(source).toMatch(/const RAIL_LIST_BOTTOM_FADE_PX = 24;/);
});

// Sol's read of the first version (#9565 A-40): in a list too short to hold
// the row and its two 8px margins between the fades, aiming past both fades
// pushed the row into one fade and the next call pushed it back. Such a list
// keeps the list's own edges, as before the fades were counted, so repeated
// reveals settle. A 60px list with a 32px row at 12 to 44px is left alone.
it("leaves the scroll position settled in a list too short to clear both fades", () => {
  listBox = { top: 120, bottom: 180 };
  rowBox = { top: 132, bottom: 164 };
  const { container } = renderRail();
  const list = container.querySelector(".desktop-rail__items:not(.desktop-rail__items--foot)");
  const first = list.scrollTop;
  expect(first).toBe(0);
  for (let call = 0; call < 3; call += 1) {
    act(() => { for (const callback of resizeCallbacks) callback([]); });
    expect(list.scrollTop).toBe(first);
  }
});

it("still reveals a row below a short list by the list's own edge, and then holds", () => {
  listBox = { top: 120, bottom: 180 };
  rowBox = { top: 200, bottom: 248 };
  const { container } = renderRail();
  const list = container.querySelector(".desktop-rail__items:not(.desktop-rail__items--foot)");
  // Row bottom 248 against the list bottom 180: 68 plus 8.
  expect(list.scrollTop).toBe(76);
  act(() => { for (const callback of resizeCallbacks) callback([]); });
  expect(list.scrollTop).toBe(76);
});
