import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BottomNav } from "../src/components/BottomNav.jsx";
import { MobileTopBar } from "../src/components/MobileTopBar.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

// The phone top bar tucks away on scroll-down; the bottom nav CONDENSES to
// just the Home tab (owner feedback, 2026-08-25) instead of leaving the
// screen. Both restore on scroll-up (useHideOnScroll). jsdom never scrolls on
// its own, so the tests drive window.scrollY by hand and flush the hook's
// requestAnimationFrame gate.

function mount(ui) {
  return render(<LanguageProvider>{ui}</LanguageProvider>);
}

async function scrollWindowTo(y) {
  Object.defineProperty(window, "scrollY", { configurable: true, value: y });
  await act(async () => {
    window.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  });
}

// The hook clamps y to [0, scrollHeight - innerHeight]; give the document
// room so mid-page positions are reachable.
function stubScrollRoom() {
  Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 3000 });
  window.innerHeight = 800;
}

afterEach(() => {
  delete document.documentElement.scrollHeight;
  Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
});

describe("phone chrome hide-on-scroll", () => {
  it("tucks the top bar and condenses the nav on scroll-down, restoring both on scroll-up", async () => {
    stubScrollRoom();
    mount(
      <>
        <MobileTopBar initials="MC" />
        <BottomNav active="today" onNavigate={() => {}} onAsk={() => {}} />
      </>,
    );
    const top = document.querySelector(".mobile-top");
    const nav = document.querySelector(".bottom-nav");
    expect(top.className).not.toContain("mobile-top--tucked");
    expect(nav.className).not.toContain("bottom-nav--condensed");

    await scrollWindowTo(400);
    expect(top.className).toContain("mobile-top--tucked");
    expect(nav.className).toContain("bottom-nav--condensed");
    // Condensed is not gone: the Home tab is still in the bar, marked as the
    // one entry the condensed pill keeps visible.
    expect(nav.querySelector(".bottom-nav__home")).not.toBeNull();

    await scrollWindowTo(300);
    expect(top.className).not.toContain("mobile-top--tucked");
    expect(nav.className).not.toContain("bottom-nav--condensed");
  });

  it("never tucks while still near the top of the page", async () => {
    stubScrollRoom();
    mount(<BottomNav active="today" onNavigate={() => {}} onAsk={() => {}} />);
    const nav = document.querySelector(".bottom-nav");
    // 40 < the 64px reveal ceiling: a sub-ceiling scroll must keep the bar.
    await scrollWindowTo(40);
    expect(nav.className).not.toContain("bottom-nav--condensed");
  });

  it("does not flap when the viewport resizes without the page scrolling", async () => {
    stubScrollRoom();
    mount(<BottomNav active="today" onNavigate={() => {}} onAsk={() => {}} />);
    const nav = document.querySelector(".bottom-nav");
    await scrollWindowTo(400);
    expect(nav.className).toContain("bottom-nav--condensed");
    // An iOS toolbar collapse changes innerHeight while scrollY stays put —
    // the raw-delta hook must read that as "no movement", not a reveal.
    window.innerHeight = 850;
    await scrollWindowTo(400);
    expect(nav.className).toContain("bottom-nav--condensed");
  });

  it("ignores sub-jitter deltas instead of flapping", async () => {
    stubScrollRoom();
    mount(<BottomNav active="today" onNavigate={() => {}} onAsk={() => {}} />);
    const nav = document.querySelector(".bottom-nav");
    await scrollWindowTo(400);
    expect(nav.className).toContain("bottom-nav--condensed");
    // A 4px up-wiggle (rubber-band noise) is below the 6px jitter gate and
    // must not un-tuck the bar.
    await scrollWindowTo(396);
    expect(nav.className).toContain("bottom-nav--condensed");
  });
});
