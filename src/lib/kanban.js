// Pure board helpers for the t0ggles-style tasks board
// (REQ-UG-KANBAN-PHASE1-20260801). No React, no DOM: KanbanBoard,
// TaskModal and TasksView all need the same answers about ordering, keys,
// grouping and checklists, and three copies of "what does needs_review cycle
// to" is exactly how two surfaces start disagreeing about one card.
//
// The board's core inversion lives here in data terms: columns are
// WORKSTREAMS and status is the card's colour, so grouping is a two-level
// question (workstream, then status) rather than the one-level column split
// the old BoardView asked.

// Canonical status order — pickers, the [ / ] keyboard walk, and any list that
// wants the statuses "in the order a card travels".
export const STATUS_IDS = ["backlog", "to_do", "in_progress", "needs_review", "done"];

// Standard Task ships first. The remaining values reserve the shared task
// vocabulary without exposing the deferred template picker during quick create.
export const TASK_TYPE_IDS = [
  "general",
  "meeting_event",
  "review_approval",
  "member_follow_up",
  "document_request",
  "issue_incident",
];

// Board grouping order is NOT the canonical order: inside a workstream column
// the work that needs attention sorts to the top, which is t0ggles' demo order
// generalised to our four statuses. Done sinks last because it is the one
// group the board can hide entirely.
export const KAN_GROUP_ORDER = ["to_do", "in_progress", "needs_review", "backlog", "done"];

// order_index is bounded 0…1,000,000 — roughly a thousand cards of headroom
// per column at 1,000-step spacing before a renumber is ever needed.
export const ORDER_MAX = 1000000;

// Midpoint-on-drop: a drop writes one row, computed from its neighbours,
// instead of renumbering the column. Exported for direct unit tests — the
// renumber threshold is exactly the case a UI walkthrough never reaches.
export function orderBetween(prev, next) {
  if (!prev && !next) return 1000;
  if (!prev) return Math.max(Math.floor(next.orderIndex / 2), 0);
  if (!next) return prev.orderIndex + 1000;
  return Math.floor((prev.orderIndex + next.orderIndex) / 2);
}

export function byBoardOrder(a, b) {
  return (a.orderIndex ?? 0) - (b.orderIndex ?? 0)
    || String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
}

// The card key (WOR-42) is chapter id + the SERVER-assigned per-chapter
// task_number (migration 20260801170000). Both halves are required: a card
// loaded before the migration reached its chapter has no number, and rendering
// "WOR-undefined" on it would put a broken deep link on a real card. Null
// means "this card has no key yet", and every caller omits the key line.
export function taskKey(task, chapterId) {
  if (!task || task.taskNumber == null || !chapterId) return null;
  return `${String(chapterId).toUpperCase()}-${task.taskNumber}`;
}

// Deep links arrive lower-cased from the query string (?task=wor-42), and the
// search box accepts either casing, so the comparison is case-insensitive on
// both sides rather than upper-casing the needle and hoping.
export function matchesTaskKey(task, chapterId, needle) {
  const key = taskKey(task, chapterId);
  if (!key || !needle) return false;
  return key.toLowerCase() === String(needle).trim().toLowerCase();
}

// The one-tap circle on a card. It returns the ACTION as well as the target
// status because the glyph, the aria-label and the announcement all differ
// between "push this forward" and "this is finished" — deriving three
// switch statements from `to` alone is how they drift apart.
export function statusCycle(status) {
  if (status === "backlog") return { action: "advance", to: "to_do" };
  if (status === "to_do") return { action: "advance", to: "in_progress" };
  if (status === "in_progress") return { action: "advance", to: "needs_review" };
  if (status === "needs_review") return { action: "complete", to: "done" };
  return { action: "reopen", to: "to_do" };
}

// Checklists are parsed out of `description`, not stored: adding a table for
// them would need a migration, RLS, and a write path, and the whole feature is
// two characters of Markdown people already type. `*` bullets are accepted
// because half the world writes them that way. The trailing `\r?` is
// load-bearing: descriptions typed on Windows arrive CRLF, split("\n") leaves
// a \r on every line, and in a JS regex both `.` and `$` treat \r as a line
// terminator — without capturing it, no CRLF line ever matches and the
// checklist silently vanishes. The \r stays OUT of the text group and is
// re-attached verbatim by the toggle so a round-trip never rewrites a
// member's line endings.
const CHECKLIST_LINE = /^(\s*[-*]\s\[)( |x|X)(\]\s?)(.*?)(\r?)$/;

// `index` is the line's position in description.split("\n") — the toggle
// writes back by line number, so an item's identity is its line and nothing
// else. Text is trimmed for the label only.
export function parseChecklist(description) {
  const items = [];
  String(description || "").split("\n").forEach((line, index) => {
    const match = CHECKLIST_LINE.exec(line);
    if (!match) return;
    items.push({ index, checked: match[2] !== " ", text: match[4].trim() });
  });
  return {
    items,
    done: items.filter((item) => item.checked).length,
    total: items.length,
  };
}

// Flips one line's box and returns the whole description. Only the box
// character changes — indentation, bullet, spacing, text AND the line's own
// \r are carried through from the captured groups, because this string is a
// member's own writing and a round-trip through a formatter would rewrite it.
export function toggleChecklistItem(description, lineIndex) {
  const text = String(description || "");
  const lines = text.split("\n");
  const line = lines[lineIndex];
  if (line === undefined) return text;
  const match = CHECKLIST_LINE.exec(line);
  if (!match) return text;
  lines[lineIndex] = `${match[1]}${match[2] === " " ? "x" : " "}${match[3]}${match[4]}${match[5]}`;
  return lines.join("\n");
}

// null rather than {done: 0, total: 0}: the card footer renders the badge on
// truthiness, and a zero-item badge on every description-less card is noise.
export function checklistBadge(description) {
  const { done, total } = parseChecklist(description);
  return total === 0 ? null : { done, total };
}

// Workstream colour is derived, not stored. A chapter names its own
// workstreams, so there is no column to hold a palette slot, and a hash keeps
// "Grievances" the same colour on every device and after every rename-free
// reload. Ten slots (kan-ws-0…kan-ws-9) — collisions are cosmetic.
export function workstreamColorIndex(name) {
  const text = String(name || "");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 100000007;
  }
  return hash % 10;
}

// The board's shape in one call: workstreams in the caller's order (the
// chapter's own vocabulary decides the columns), each holding the five status
// groups in KAN_GROUP_ORDER. A workstream with no cards still gets a column —
// an empty column is where the composer lives, and hiding it would make a
// freshly added workstream unusable until someone put a card in it elsewhere.
export function groupBoardTasks(tasks, workstreamNames) {
  const list = Array.isArray(tasks) ? tasks : [];
  return (workstreamNames || []).map((workstream) => ({
    workstream,
    groups: KAN_GROUP_ORDER.map((status) => ({
      status,
      tasks: list
        .filter((task) => task.workstream === workstream && task.status === status)
        .sort(byBoardOrder),
    })),
  }));
}

// Dependency edges are one directed list ({taskId dependsOn dependsOnId});
// both modal directions are reads of it. Pure and shared so the add-picker's
// exclusions, the demo twin and the card badge can never disagree with each
// other — the server's trigger stays the real guard.
export function taskDependencyLists(edges, taskId) {
  const list = Array.isArray(edges) ? edges : [];
  return {
    dependsOn: list.filter((edge) => edge.taskId === taskId),
    blocking: list.filter((edge) => edge.dependsOnId === taskId),
  };
}

// The card footer's number: how many edges TOUCH the task, either direction —
// t0ggles' footer counts links, not just prerequisites.
export function taskDependencyCount(edges, taskId) {
  const list = Array.isArray(edges) ? edges : [];
  let count = 0;
  for (const edge of list) {
    if (edge.taskId === taskId || edge.dependsOnId === taskId) count += 1;
  }
  return count;
}

// Client twin of the migration's reachability walk: adding taskId -> candidate
// closes a loop exactly when candidate already reaches taskId through existing
// edges. Visited-set walk, so a somehow-cyclic graph still terminates. The
// picker uses this to EXCLUDE candidates; the server's advisory-locked check
// still owns the race two concurrent editors can create.
export function wouldCreateDependencyCycle(edges, taskId, candidateId) {
  if (taskId === candidateId) return true;
  const list = Array.isArray(edges) ? edges : [];
  const byTask = new Map();
  for (const edge of list) {
    const next = byTask.get(edge.taskId);
    if (next) next.push(edge.dependsOnId);
    else byTask.set(edge.taskId, [edge.dependsOnId]);
  }
  const seen = new Set([candidateId]);
  const queue = [candidateId];
  while (queue.length) {
    const current = queue.pop();
    if (current === taskId) return true;
    for (const next of byTask.get(current) || []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}
