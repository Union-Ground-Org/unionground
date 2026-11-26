import { useEffect } from "react";

// REQ-UG-NAV-LIGHT-IDENTITY-20261102: a signed-in page's browser tab
// names the page and the worn role ("Steward messages · Steward | Union
// Ground") instead of the generic "Union Ground | Member workspace" every
// private route used to share. The private head metadata stays the fallback
// until the page heading renders; applyPageMetadata reads the current value so
// a later head refresh (language change, route change) keeps it.
let currentTitle = null;

export function workspaceTitle(page, role) {
  const parts = [page, role].map((value) => String(value ?? "").trim()).filter(Boolean);
  const unique = parts.filter((value, index) => parts.indexOf(value) === index);
  return unique.length ? `${unique.join(" · ")} | Union Ground` : null;
}

export function currentWorkspaceTitle() {
  return currentTitle;
}

export function setWorkspaceTitle(title) {
  currentTitle = title || null;
  if (currentTitle && typeof document !== "undefined") document.title = currentTitle;
}

// Follows the workspace's first-level heading as views render and change.
export function useWorkspaceDocumentTitle(role, rootId = "main-content") {
  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return undefined;
    let frame = null;
    const update = () => {
      frame = null;
      const heading = document.getElementById(rootId)?.querySelector("h1");
      const page = heading?.textContent?.replace(/\s+/g, " ").trim();
      if (page) setWorkspaceTitle(workspaceTitle(page, role));
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(update) : setTimeout(update, 0);
    };
    update();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame !== null) (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout)(frame);
      currentTitle = null;
    };
  }, [role, rootId]);
}
