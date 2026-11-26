import { useLayoutEffect } from "react";

// #7700. The desktop and tablet Compass panel stays non-modal: the page
// beside it stays clickable, and the rail is not inerted. Two things still
// have to be true while it is open. Focus starts in the question box, and a
// control whose box sits entirely under the panel is not a Tab stop.

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

export function boxFullyInside(target, cover) {
  if (!target || !cover || target.width < 1 || target.height < 1 || cover.width < 1 || cover.height < 1) return false;
  return target.left >= cover.left - 0.5
    && target.top >= cover.top - 0.5
    && target.right <= cover.right + 0.5
    && target.bottom <= cover.bottom + 0.5;
}

function belongsToPanel(element, panel) {
  if (element === panel || panel.contains(element) || element.contains(panel)) return true;
  const dialog = element.closest?.("[role='dialog']");
  return Boolean(dialog && dialog !== panel);
}

function focusablesCoveredBy(panel, root = document) {
  const cover = panel.getBoundingClientRect();
  if (cover.width < 1 || cover.height < 1) return [];
  return [...root.querySelectorAll(FOCUSABLE)].filter((element) => {
    if (belongsToPanel(element, panel)) return false;
    return boxFullyInside(element.getBoundingClientRect(), cover);
  });
}

// A control below the fold is not covered until Tab scrolls it into the
// panel. Skip from the one that just received focus toward the next control
// that is still visible beside the panel.
const HOP_LIMIT = 80;

function nextOutside(panel, from, backward) {
  const cover = panel.getBoundingClientRect();
  const all = [...document.querySelectorAll(FOCUSABLE)];
  const start = all.indexOf(from);
  if (start < 0) return null;
  const step = backward ? -1 : 1;
  for (let index = start + step; index >= 0 && index < all.length; index += step) {
    const element = all[index];
    if (belongsToPanel(element, panel)) continue;
    if (element.hasAttribute("inert") || element.closest("[inert]")) continue;
    const box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1 || boxFullyInside(box, cover)) continue;
    return element;
  }
  return null;
}

export function useCompassDesktopFocus(panelRef, { active }) {
  useLayoutEffect(() => {
    if (!active) return undefined;
    const panel = panelRef.current;
    if (!panel) return undefined;
    const question = () => panel.querySelector("input.guide2-input:not([disabled])");
    (question() || panel).focus();
    const owned = new Set();
    const sync = () => {
      const next = new Set(focusablesCoveredBy(panel));
      for (const element of next) {
        if (owned.has(element) || element.hasAttribute("inert")) continue;
        element.setAttribute("inert", "");
        owned.add(element);
      }
      for (const element of [...owned]) {
        if (next.has(element)) continue;
        owned.delete(element);
        element.removeAttribute("inert");
      }
    };
    sync();
    let shiftTab = false;
    let hops = 0;
    const onKeyDown = (event) => {
      if (event.key !== "Tab") return;
      shiftTab = event.shiftKey;
      hops = 0;
      sync();
    };
    const onFocusIn = (event) => {
      const element = event.target;
      if (!(element instanceof Element) || belongsToPanel(element, panel)) return;
      if (!boxFullyInside(element.getBoundingClientRect(), panel.getBoundingClientRect())) {
        hops = 0;
        return;
      }
      hops += 1;
      if (!element.hasAttribute("inert")) {
        element.setAttribute("inert", "");
        owned.add(element);
      }
      const fallback = question() || panel;
      if (hops > HOP_LIMIT) {
        hops = 0;
        fallback.focus();
        return;
      }
      const next = nextOutside(panel, element, shiftTab);
      (next || fallback).focus();
    };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(sync) : null;
    observer?.observe(panel);
    const mutations = typeof MutationObserver === "function" ? new MutationObserver(schedule) : null;
    let frame = 0;
    function schedule() {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        sync();
      });
    }
    mutations?.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("focusin", onFocusIn, true);
    return () => {
      observer?.disconnect();
      mutations?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("focusin", onFocusIn, true);
      if (frame) window.cancelAnimationFrame(frame);
      for (const element of owned) element.removeAttribute("inert");
      owned.clear();
    };
  }, [active, panelRef]);
}
