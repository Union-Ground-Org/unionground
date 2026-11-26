// One decorative, list-local highlight follows fine pointers. The pseudo-element
// leaves list semantics and React's children untouched and clips with its normal
// scroll ancestors instead of floating over dialogs or sticky application chrome.
const HOVER_LIST_SELECTOR = [
  ".coord-list", ".thread-list", ".morehub-list", ".member-support-list",
  ".member-operations-list", ".home-rows", ".bevoice-weekly__list",
  ".case-files__list", ".workwidget__rows", ".reports-rows", ".kan-list__rows",
  ".voting-pastlist__rows", ".tasks-work-docket__rows", ".workstream-list",
  ".knowledge-workspace__resource-list", ".automation-pages__list",
  ".retention-history__list", ".voice-demo-weekly-list", ".voice-demo-survey-list",
  ".voice-demo-question-list", ".voice-demo-qa-list",
].join(", ");

const LIST_CLASS = "ug-hover-list";
const JUMP_CLASS = "ug-row-jump";
const STATIC_CLASS = "ug-row-static";

export function rowForTarget(list, target) {
  return Array.from(list.children).find((child) => child === target || child.contains(target)) ?? null;
}

export function glowFrame(list, row) {
  const listRect = list.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const scale = list.offsetHeight ? listRect.height / list.offsetHeight : 1;
  return {
    top: Math.max(0, (rowRect.top - listRect.top) / (scale || 1) + list.scrollTop - list.clientTop),
    height: rowRect.height / (scale || 1),
  };
}

function listenMedia(media, listener) {
  if (media.addEventListener) {
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }
  media.addListener?.(listener);
  return () => media.removeListener?.(listener);
}

export function initRowHighlight(doc = document, win = window) {
  if (typeof win.matchMedia !== "function") return () => {};
  const hover = win.matchMedia("(hover: hover) and (pointer: fine)");
  const motion = win.matchMedia("(prefers-reduced-motion: reduce)");
  let activeList = null;
  let activeRow = null;

  function detach() {
    mutationObserver?.disconnect();
    resizeObserver?.disconnect();
    if (activeList) {
      activeList.classList.remove(LIST_CLASS, JUMP_CLASS, STATIC_CLASS);
      activeList.style.removeProperty("--ug-row-top");
      activeList.style.removeProperty("--ug-row-height");
    }
    activeList = null;
    activeRow = null;
  }

  function position(jump = false) {
    if (!activeList?.isConnected || !activeRow?.isConnected) { detach(); return; }
    const frame = glowFrame(activeList, activeRow);
    if (!frame.height) { detach(); return; }
    activeList.classList.toggle(STATIC_CLASS, motion.matches);
    if (activeList.style.getPropertyValue("--ug-row-top") === `${frame.top}px`
      && activeList.style.getPropertyValue("--ug-row-height") === `${frame.height}px`) return;
    if (jump) activeList.classList.add(JUMP_CLASS);
    activeList.style.setProperty("--ug-row-top", `${frame.top}px`);
    activeList.style.setProperty("--ug-row-height", `${frame.height}px`);
    if (jump) {
      // Switching lists lands immediately; subsequent rows share one glide.
      void activeList.offsetHeight;
      activeList.classList.remove(JUMP_CLASS);
    }
  }

  // A shrinking or replaced list must not retain a decorative scroll extent.
  const mutationObserver = typeof win.MutationObserver === "function" ? new win.MutationObserver(detach) : null;
  const resizeObserver = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(() => position(true)) : null;

  function onPointerOver(event) {
    if (!hover.matches || event.pointerType === "touch") { detach(); return; }
    const target = event.target instanceof win.Element ? event.target : null;
    const list = target?.closest(HOVER_LIST_SELECTOR);
    const row = list ? rowForTarget(list, target) : null;
    if (!row || row.hidden || row.matches(":disabled, [aria-disabled='true']")) { detach(); return; }
    if (activeList === list && activeRow === row) return;
    const jumped = activeList !== list;
    if (jumped) {
      detach();
      activeList = list;
      list.classList.add(LIST_CLASS);
      mutationObserver?.observe(list, { childList: true, subtree: true, characterData: true });
    }
    activeRow = row;
    resizeObserver?.disconnect();
    resizeObserver?.observe(list);
    resizeObserver?.observe(row);
    position(jumped);
  }

  function onPointerOut(event) {
    const next = event.relatedTarget instanceof win.Element ? event.relatedTarget : null;
    if (activeList && (!next || !activeList.contains(next))) detach();
  }

  const stopHover = listenMedia(hover, () => { if (!hover.matches) detach(); });
  const stopMotion = listenMedia(motion, () => { if (activeList) position(true); });
  doc.addEventListener("pointerover", onPointerOver, { passive: true });
  doc.addEventListener("pointerout", onPointerOut, { passive: true });
  doc.addEventListener("scroll", detach, { capture: true, passive: true });
  win.addEventListener("resize", detach, { passive: true });
  win.addEventListener("blur", detach);
  return () => {
    doc.removeEventListener("pointerover", onPointerOver);
    doc.removeEventListener("pointerout", onPointerOut);
    doc.removeEventListener("scroll", detach, true);
    win.removeEventListener("resize", detach);
    win.removeEventListener("blur", detach);
    stopHover();
    stopMotion();
    detach();
  };
}
