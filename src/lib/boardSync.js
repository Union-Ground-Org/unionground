import { withTaskAssignees } from "./memberApi.js";

export const DONE_WINDOW_MS = 60 * 86400000;

// Last write wins by updated_at, never by arrival order. NONE of the streams
// that can touch a task row are ordered against each other: broadcasts race
// other broadcasts, they race this member's own optimistic writes, and the
// app's OWN mutation responses race the broadcasts too — two rapid writes can
// commit A then B server-side yet deliver their HTTP responses B then A, so
// "my own response" is no more authoritative than a socket event. One shared
// comparison so the paths cannot drift; a stale copy applied by any of them
// would visibly snap a card back to a state the server has already left.
// Strictly newer, so an equal-timestamp response still applies.
export function localTaskRowWins(existing, incoming) {
  return Boolean(existing) && String(existing.updatedAt || "") > String(incoming?.updatedAt || "");
}

// A task write's confirmation, replayed by the session loader on every
// projection until a fresh chapter_tasks read takes over (#8211, gate round 3
// r3s1). The write answers with the bare row, so each replay decorates it
// from that projection's own assignments and roster: a projection built while
// the task read keeps failing must not drop a co-assignee the board shows.
export function confirmedTaskProjection(current, rows, { deletedId = null, insert = false } = {}) {
  let tasks = (current.tasks || []).filter((task) => task.id !== deletedId);
  for (const row of rows) {
    const existing = tasks.find((task) => task.id === row.id);
    if ((!existing && !insert) || localTaskRowWins(existing, row)) continue;
    tasks = [...tasks.filter((task) => task.id !== row.id), withTaskAssignees(row, current.taskAssignments || [], current.taskAssignees || [])];
  }
  return { ...current, tasks };
}

export function mergeExistingRows(existingRows, incomingRows, keepExisting = () => false) {
  const byId = new Map((Array.isArray(incomingRows) ? incomingRows : []).map((row) => [row.id, row]));
  return (Array.isArray(existingRows) ? existingRows : []).map((existing) => {
    const incoming = byId.get(existing.id);
    return incoming && !keepExisting(existing, incoming) ? incoming : existing;
  });
}

export function pruneExpiredDoneTasks(tasks, now = Date.now()) {
  const floor = now - DONE_WINDOW_MS;
  return (Array.isArray(tasks) ? tasks : []).filter((task) => {
    if (task.status !== "done" || !task.doneAt) return true;
    const doneAt = Date.parse(task.doneAt);
    return Number.isNaN(doneAt) || doneAt >= floor;
  });
}

export function nextDoneTaskExpiryDelay(tasks, now = Date.now()) {
  let earliest = Number.POSITIVE_INFINITY;
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (task.status !== "done" || !task.doneAt) continue;
    const doneAt = Date.parse(task.doneAt);
    if (!Number.isNaN(doneAt)) earliest = Math.min(earliest, doneAt + DONE_WINDOW_MS);
  }
  if (!Number.isFinite(earliest)) return null;
  return Math.max(0, earliest - now);
}

// A 60-day window exceeds the browser's maximum timer delay. An early wake
// must re-arm even when pruning would leave React's task state unchanged.
export function scheduleDoneTaskExpiry(tasks, onExpiry) {
  const now = Date.now();
  const delay = nextDoneTaskExpiryDelay(tasks, now);
  if (delay == null) return () => {};
  const expiresAt = now + delay;
  let timer;
  let cancelled = false;
  const arm = () => {
    timer = globalThis.setTimeout(() => {
      if (cancelled) return;
      if (Date.now() < expiresAt) arm();
      else onExpiry();
    }, Math.min(Math.max(0, expiresAt - Date.now()) + 10, 2147483647));
  };
  arm();
  return () => { cancelled = true; globalThis.clearTimeout(timer); };
}

// Realtime can report SUBSCRIBED more than once while reconnecting. Each gap
// fill is chained behind the previous one, and every active buffer receives
// every live event. No later refetch can overwrite an earlier replay buffer.
export function createBoardRefetchQueue({ load, commit, onError = () => {} }) {
  let chain = Promise.resolve();
  let active = true;
  const buffers = new Set();

  return {
    note(event) {
      if (!active) return;
      for (const buffer of buffers) buffer.push(event);
    },
    refetch() {
      if (!active) return Promise.resolve(null);
      const buffer = [];
      buffers.add(buffer);
      const run = chain.then(async () => {
        if (!active) return null;
        const snapshot = await load();
        if (!active) return null;
        return commit(snapshot, buffer);
      });
      chain = run.catch((error) => { onError(error); }).finally(() => buffers.delete(buffer));
      return run;
    },
    close() {
      active = false;
      buffers.clear();
    },
  };
}
