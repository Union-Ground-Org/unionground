import { useLayoutEffect } from "react";

// #7668. The phone role bar and the Coordinator desk toolbar both stick at
// top: 0. After a no-match filter shortens the page, the bar covers the
// search and the toolbar covers a focused KPI. A tucked bar is off-screen
// (translateY(-100%)) and adds no clearance; focus inside that bar shows it
// again, so it counts as covering the viewport.
export const COORDINATOR_OUTLINE_PAD_PX = 8;

function wholePixels(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.ceil(number);
}

export function coordinatorStickyClearance({
  roleBarHeight = 0,
  roleBarVisible = false,
  toolbarHeight = 0,
  outlinePad = COORDINATOR_OUTLINE_PAD_PX,
} = {}) {
  const role = roleBarVisible ? wholePixels(roleBarHeight) : 0;
  const toolbar = wholePixels(toolbarHeight);
  const pad = wholePixels(outlinePad);
  return { toolbarTop: role, kpiScrollMargin: role + toolbar + pad };
}

// A tucked bar is off-screen until it holds focus. `contains(activeElement)`
// is the light-DOM :focus-within check. Element.matches(":focus-within") is
// false in this jsdom even when querySelector finds the same element, so the
// active-element check is the one the unit suite can prove; the matches call
// covers a browser that reports :focus-within before activeElement moves.
function barHoldsFocus(bar) {
  const active = bar.ownerDocument?.activeElement;
  if (active && bar.contains(active)) return true;
  return typeof bar.matches === "function" && bar.matches(":focus-within");
}

export function roleBarCoversViewport(bar) {
  if (!bar) return false;
  if (!bar.classList?.contains("mobile-top--tucked")) return true;
  return barHoldsFocus(bar);
}

export function blockHeight(element) {
  if (!element || typeof element.getBoundingClientRect !== "function") return 0;
  const { height } = element.getBoundingClientRect();
  return Number.isFinite(height) ? height : 0;
}

export function readCoordinatorStickyChrome(doc, screen) {
  const bar = doc?.querySelector?.(".mobile-top") ?? null;
  const toolbar = screen?.querySelector?.(":scope > .phead") ?? null;
  return coordinatorStickyClearance({
    roleBarHeight: blockHeight(bar),
    roleBarVisible: roleBarCoversViewport(bar),
    toolbarHeight: blockHeight(toolbar),
  });
}

export function applyCoordinatorStickyClearance(screen, clearance) {
  if (!screen?.style) return;
  screen.style.setProperty("--gq-toolbar-top", `${clearance.toolbarTop}px`);
  screen.style.setProperty("--gq-kpi-scroll-margin", `${clearance.kpiScrollMargin}px`);
}

export function clearCoordinatorStickyClearance(screen) {
  screen?.style?.removeProperty("--gq-toolbar-top");
  screen?.style?.removeProperty("--gq-kpi-scroll-margin");
}

export function useCoordinatorStickyClearance(screenRef) {
  useLayoutEffect(() => {
    const screen = screenRef?.current;
    if (!screen || typeof document === "undefined") return undefined;

    let bar = null;
    let classObserver = null;
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => measure()) : null;
    const toolbar = screen.querySelector(":scope > .phead");
    if (toolbar) resizeObserver?.observe(toolbar);

    function watchBar() {
      const next = document.querySelector(".mobile-top");
      if (next === bar) return;
      classObserver?.disconnect();
      classObserver = null;
      if (bar) resizeObserver?.unobserve(bar);
      bar = next;
      if (!bar) return;
      resizeObserver?.observe(bar);
      if (typeof MutationObserver !== "function") return;
      classObserver = new MutationObserver(() => measure());
      classObserver.observe(bar, { attributes: true, attributeFilter: ["class"] });
    }

    function measure() {
      watchBar();
      applyCoordinatorStickyClearance(screen, readCoordinatorStickyChrome(document, screen));
    }

    measure();
    document.addEventListener("focusin", measure);
    document.addEventListener("focusout", measure);
    window.addEventListener("resize", measure);
    return () => {
      resizeObserver?.disconnect();
      classObserver?.disconnect();
      document.removeEventListener("focusin", measure);
      document.removeEventListener("focusout", measure);
      window.removeEventListener("resize", measure);
      clearCoordinatorStickyClearance(screen);
    };
  }, [screenRef]);
}
