import { fireEvent, screen } from "@testing-library/react";

// The workspace page menu is a disclosure: a "Current page <page>" button
// whose hidden list holds one link per page
// (UX-UG-STAFF-DESK-PAGE-MENU-RAW-BROWSER-SELECT-20261108).
export const PAGE_MENU_TRIGGER = { name: /^Current page\b/ };

export function pageMenuTrigger(root = screen) {
  return root.getByRole("button", PAGE_MENU_TRIGGER);
}

export function findPageMenuTrigger(options) {
  return screen.findByRole("button", PAGE_MENU_TRIGGER, options);
}

function panelOf(trigger) {
  return trigger.ownerDocument.getElementById(trigger.getAttribute("aria-controls"));
}

export function pageMenuPaths(trigger) {
  return [...panelOf(trigger).querySelectorAll("a")].map((link) => new URL(link.href, window.location.origin).pathname);
}

export function choosePage(trigger, path) {
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  const link = [...panelOf(trigger).querySelectorAll("a")]
    .find((candidate) => new URL(candidate.href, window.location.origin).pathname === path);
  if (!link) throw new Error(`The page menu has no link to ${path}`);
  fireEvent.click(link);
}
