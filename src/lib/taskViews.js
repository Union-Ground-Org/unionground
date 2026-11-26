const SHARED_TASK_VIEW_IDS = Object.freeze([
  "board",
  "list",
  "calendar",
  "timeline",
  "progress",
  "report",
]);

const DESKTOP_TASK_VIEW_IDS = Object.freeze([
  "board",
  "list",
  "timeline",
  "calendar",
  "deadlines",
  "field_notes",
  "progress",
  "report",
]);

export const SHARED_TASK_VIEW_SHORTCUTS = Object.freeze({
  b: "board",
  l: "list",
  c: "calendar",
  t: "timeline",
  p: "progress",
  r: "report",
});

export const DESKTOP_TASK_VIEW_SHORTCUTS = Object.freeze({
  ...SHARED_TASK_VIEW_SHORTCUTS,
  d: "deadlines",
  f: "field_notes",
});

export function taskViewIdsFor(desktopShell) {
  return desktopShell ? DESKTOP_TASK_VIEW_IDS : SHARED_TASK_VIEW_IDS;
}

export function isSharedTaskView(value) {
  return SHARED_TASK_VIEW_IDS.includes(value);
}

export function normalizeSharedTaskView(value) {
  return isSharedTaskView(value) ? value : "board";
}
