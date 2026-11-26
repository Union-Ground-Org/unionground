// Demo board bridge: the desktop shell and its companion-phone iframe are two
// full app instances whose demo data lives in separate React state, so a task
// created on one board never reached the other — only scalar UI selections
// crossed the frame boundary (deviceParity). This module defines the DATA
// slice that now rides the same postMessage channel: the board's domain keys,
// nothing else. Slicing keeps the payload small (~a few KB, not the whole
// fixture set) and bounds the blast radius of a malformed message.
export const DEMO_BOARD_KEYS = [
  "tasks",
  "taskMessages",
  "taskComments",
  "taskAttachments",
  "taskActivity",
  "taskDependencies",
  "taskSubtasks",
  "taskWatches",
  "taskFiles",
  "taskAssignments",
  "taskAssignees",
];

export function demoBoardSlice(data) {
  const slice = {};
  for (const key of DEMO_BOARD_KEYS) {
    if (Array.isArray(data?.[key])) slice[key] = data[key];
  }
  return slice;
}

// Merge is key-replacement, not row-merge: each instance's mutation paths
// already produce complete arrays, and last-writer-wins per key mirrors what
// a single instance would have computed. Unknown keys never cross.
export function mergeDemoSlice(previous, slice) {
  if (!previous || !slice || typeof slice !== "object") return previous;
  const next = { ...previous };
  for (const key of DEMO_BOARD_KEYS) {
    if (Array.isArray(slice[key])) next[key] = slice[key];
  }
  return next;
}
