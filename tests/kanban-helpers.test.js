import { describe, expect, it } from "vitest";
import {
  KAN_GROUP_ORDER,
  STATUS_IDS,
  byBoardOrder,
  checklistBadge,
  groupBoardTasks,
  matchesTaskKey,
  orderBetween,
  parseChecklist,
  statusCycle,
  taskKey,
  taskDependencyCount,
  taskDependencyLists,
  toggleChecklistItem,
  workstreamColorIndex,
  wouldCreateDependencyCycle,
} from "../src/lib/kanban.js";

// The pure half of the kanban board (REQ-UG-KANBAN-PHASE1-20260801).
// Three surfaces — the board, the modal and the view chrome — all consume
// these helpers, and none of them re-derives an answer locally, so a drift
// here is a drift EVERYWHERE at once: the card circle would advance to a
// different status than the modal's picker claims, or a checklist toggle
// would rewrite a line the member never touched. I pin the contracts as
// values, not implementations, because the components treat them as law:
// the cycle table, the line-number identity of checklist items, the
// round-trip guarantee of the toggle, the null-means-no-key rule, and the
// board grouping order that is deliberately NOT the canonical status order.

describe("statusCycle", () => {
  it("walks the full t0ggles cycle, including the reopen leg", () => {
    // The action name matters as much as the target: glyph, aria-label and
    // announcement all switch on it, so this is a table pin, not a smoke test.
    expect(statusCycle("backlog")).toEqual({ action: "advance", to: "to_do" });
    expect(statusCycle("to_do")).toEqual({ action: "advance", to: "in_progress" });
    expect(statusCycle("in_progress")).toEqual({ action: "advance", to: "needs_review" });
    expect(statusCycle("needs_review")).toEqual({ action: "complete", to: "done" });
    expect(statusCycle("done")).toEqual({ action: "reopen", to: "to_do" });
  });

  it("agrees with STATUS_IDS about what statuses exist", () => {
    // Every canonical status must round back into the canonical set — a fifth
    // status added to one list but not the other would strand cards.
    for (const status of STATUS_IDS) {
      expect(STATUS_IDS).toContain(statusCycle(status).to);
    }
  });
});

describe("parseChecklist", () => {
  it("accepts both bullet characters and both checked casings", () => {
    const { items, done, total } = parseChecklist("- [ ] dash item\n* [x] star item\n- [X] shouted item");
    expect(items).toEqual([
      { index: 0, checked: false, text: "dash item" },
      { index: 1, checked: true, text: "star item" },
      { index: 2, checked: true, text: "shouted item" },
    ]);
    expect(done).toBe(2);
    expect(total).toBe(3);
  });

  it("parses CRLF descriptions: the regex captures the \\r a split(\"\\n\") leaves behind", () => {
    // Descriptions typed on Windows arrive with \r\n; split("\n") leaves a
    // trailing \r on every line, and in a JS regex both `.` and `$` treat \r
    // as a LINE TERMINATOR — an unpatterned \r meant no CRLF line ever
    // matched and the checklist silently vanished for Windows text. The
    // regex's trailing (\r?) group is the fix this pin protects: both items
    // parse, with trimmed labels and line-number indexes intact.
    const { items, done, total } = parseChecklist("intro\r\n- [ ] step one\r\n- [x] step two\r");
    expect(total).toBe(2);
    expect(done).toBe(1);
    expect(items).toEqual([
      { index: 1, checked: false, text: "step one" },
      { index: 2, checked: true, text: "step two" },
    ]);
    // The same description with bare \n parses fine — the gap is CRLF-only.
    expect(parseChecklist("intro\n- [ ] step one\n- [x] step two").total).toBe(2);
  });

  it("ignores everything that is not a checklist line", () => {
    const source = [
      "A paragraph about the work.",
      "-[ ] no space after the bullet",
      "- [] no character in the box",
      "- [y] not a recognised mark",
      "  - [ ] indented is still a checklist line",
    ].join("\n");
    const { items, total } = parseChecklist(source);
    expect(total).toBe(1);
    expect(items[0]).toEqual({ index: 4, checked: false, text: "indented is still a checklist line" });
  });

  it("reports indexes as LINE numbers, not item ordinals", () => {
    // The toggle writes back by line index; if these were item ordinals the
    // toggle would flip the wrong line as soon as prose sat between items.
    const { items } = parseChecklist("title\n\n- [ ] first\nnotes\n- [x] second");
    expect(items.map((item) => item.index)).toEqual([2, 4]);
  });

  it("returns an empty result for null/empty descriptions", () => {
    expect(parseChecklist("")).toEqual({ items: [], done: 0, total: 0 });
    expect(parseChecklist(null)).toEqual({ items: [], done: 0, total: 0 });
    expect(parseChecklist(undefined)).toEqual({ items: [], done: 0, total: 0 });
  });
});

describe("toggleChecklistItem", () => {
  it("round-trips: two toggles return the exact original string", () => {
    // The description is a member's own writing — the toggle may change ONE
    // box character and nothing else, so toggling twice must be an identity.
    const source = "Plan:\n  * [ ] call the second shift\n- [X] pull the list";
    const once = toggleChecklistItem(source, 1);
    expect(once).toBe("Plan:\n  * [x] call the second shift\n- [X] pull the list");
    expect(toggleChecklistItem(once, 1)).toBe("Plan:\n  * [ ] call the second shift\n- [X] pull the list");
  });

  it("preserves indentation, bullet character and text around the flipped box", () => {
    expect(toggleChecklistItem("    - [ ]   spaced   text  ", 0))
      .toBe("    - [x]   spaced   text  ");
    // An upper-case X unchecks to a space without normalising its siblings.
    expect(toggleChecklistItem("* [X] loud", 0)).toBe("* [ ] loud");
  });

  it("toggles a CRLF line and re-attaches its \\r byte-for-byte", () => {
    // The companion to the CRLF parse pin: the \r rides its own capture group
    // so the flipped line keeps the member's original line ending — a toggle
    // must never silently convert a Windows description to LF.
    expect(toggleChecklistItem("- [ ] step\r\ndone", 0)).toBe("- [x] step\r\ndone");
    expect(toggleChecklistItem("- [x] step\r\ndone", 0)).toBe("- [ ] step\r\ndone");
  });

  it("returns the input unchanged for non-checklist lines", () => {
    const source = "just prose\n- [ ] real item";
    expect(toggleChecklistItem(source, 0)).toBe(source);
  });

  it("returns the input unchanged for out-of-range indexes", () => {
    const source = "- [ ] only item";
    expect(toggleChecklistItem(source, 5)).toBe(source);
    expect(toggleChecklistItem(source, -1)).toBe(source);
  });
});

describe("checklistBadge", () => {
  it("is null when there are zero items — the card renders the badge on truthiness", () => {
    expect(checklistBadge("")).toBeNull();
    expect(checklistBadge("no boxes here, just a description")).toBeNull();
    expect(checklistBadge(null)).toBeNull();
  });

  it("counts done over total when items exist", () => {
    expect(checklistBadge("- [x] a\n- [ ] b\n* [ ] c")).toEqual({ done: 1, total: 3 });
  });
});

describe("taskKey / matchesTaskKey", () => {
  it("mints the WOR-42 shape from chapter id + server task number", () => {
    expect(taskKey({ taskNumber: 42 }, "wor")).toBe("WOR-42");
  });

  it("is null when either half is missing — never WOR-undefined on a card", () => {
    expect(taskKey({ taskNumber: null }, "wor")).toBeNull();
    expect(taskKey({}, "wor")).toBeNull();
    expect(taskKey({ taskNumber: 42 }, "")).toBeNull();
    expect(taskKey({ taskNumber: 42 }, null)).toBeNull();
    expect(taskKey(null, "wor")).toBeNull();
  });

  it("matches deep-link needles case-insensitively and trimmed", () => {
    const task = { taskNumber: 42 };
    // ?task=wor-42 arrives lower-cased; a pasted search may carry whitespace.
    expect(matchesTaskKey(task, "wor", "wor-42")).toBe(true);
    expect(matchesTaskKey(task, "wor", "WOR-42")).toBe(true);
    expect(matchesTaskKey(task, "wor", "  Wor-42  ")).toBe(true);
    expect(matchesTaskKey(task, "wor", "wor-43")).toBe(false);
    expect(matchesTaskKey(task, "wor", "")).toBe(false);
    expect(matchesTaskKey(task, "wor", null)).toBe(false);
    // A keyless card can never match anything.
    expect(matchesTaskKey({ taskNumber: null }, "wor", "wor-42")).toBe(false);
  });
});

describe("groupBoardTasks", () => {
  const make = (id, workstream, status, orderIndex, createdAt = "2026-07-20T10:00:00Z") =>
    ({ id, workstream, status, orderIndex, createdAt });

  it("builds columns in the caller's workstream order with groups in KAN_GROUP_ORDER", () => {
    const tasks = [
      make("a", "Chapter", "done", 10),
      make("b", "Chapter", "in_progress", 10),
      make("c", "Chapter", "backlog", 10),
      make("d", "Chapter", "needs_review", 10),
      make("e", "Chapter", "to_do", 10),
    ];
    const board = groupBoardTasks(tasks, ["Chapter", "Safety"]);
    expect(board.map((col) => col.workstream)).toEqual(["Chapter", "Safety"]);
    // The grouping order is the "needs attention first" order, NOT STATUS_IDS.
    expect(KAN_GROUP_ORDER).toEqual(["to_do", "in_progress", "needs_review", "backlog", "done"]);
    expect(board[0].groups.map((group) => group.status)).toEqual(KAN_GROUP_ORDER);
    expect(board[0].groups.map((group) => group.tasks.map((task) => task.id))).toEqual([
      ["e"], ["b"], ["d"], ["c"], ["a"],
    ]);
  });

  it("keeps a column for a workstream with zero tasks — the composer lives there", () => {
    const board = groupBoardTasks([], ["Fresh"]);
    expect(board).toHaveLength(1);
    expect(board[0].workstream).toBe("Fresh");
    expect(board[0].groups).toHaveLength(5);
    expect(board[0].groups.every((group) => group.tasks.length === 0)).toBe(true);
  });

  it("sorts each group byBoardOrder and breaks orderIndex ties on createdAt", () => {
    const tasks = [
      make("late", "Chapter", "backlog", 10, "2026-07-22T10:00:00Z"),
      make("early", "Chapter", "backlog", 10, "2026-07-20T10:00:00Z"),
      make("first", "Chapter", "backlog", 5, "2026-07-23T10:00:00Z"),
    ];
    const [column] = groupBoardTasks(tasks, ["Chapter"]);
    const backlog = column.groups.find((group) => group.status === "backlog");
    expect(backlog.tasks.map((task) => task.id)).toEqual(["first", "early", "late"]);
  });

  it("byBoardOrder treats a missing orderIndex as 0", () => {
    expect(byBoardOrder({ createdAt: "a" }, { orderIndex: 5, createdAt: "b" })).toBeLessThan(0);
    expect(byBoardOrder({ orderIndex: 0, createdAt: "b" }, { createdAt: "a" })).toBeGreaterThan(0);
  });
});

describe("workstreamColorIndex", () => {
  it("is stable and always lands in the ten kan-ws-N slots", () => {
    const names = ["Grievances", "Communications", "Organizing", "Safety", "Bargaining", "Chapter", "ñ-unicode", ""];
    for (const name of names) {
      const slot = workstreamColorIndex(name);
      expect(Number.isInteger(slot)).toBe(true);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThanOrEqual(9);
      // Same name, same colour — on every device and every reload.
      expect(workstreamColorIndex(name)).toBe(slot);
    }
  });

  it("hashes the whole name, not just its first letter", () => {
    // Two names sharing an initial should be ABLE to differ; these two do
    // under the current hash, which pins that the hash reads past index 0.
    const slots = ["Grievances", "Grants", "Growth", "General"].map(workstreamColorIndex);
    expect(new Set(slots).size).toBeGreaterThan(1);
  });
});

describe("orderBetween", () => {
  it("computes midpoints from the neighbours — the historical contract, verbatim", () => {
    expect(orderBetween(null, null)).toBe(1000);
    expect(orderBetween(null, { orderIndex: 10 })).toBe(5);
    expect(orderBetween({ orderIndex: 20 }, null)).toBe(1020);
    expect(orderBetween({ orderIndex: 10 }, { orderIndex: 20 })).toBe(15);
  });

  it("collides (equals a neighbour) exactly when the gap has closed", () => {
    // The caller detects <= prev / >= next and renumbers; these are the
    // boundary values that trip it.
    expect(orderBetween({ orderIndex: 10 }, { orderIndex: 11 })).toBe(10);
    expect(orderBetween(null, { orderIndex: 0 })).toBe(0);
  });
});

// Phase-2 graph helpers. One directed edge list serves both modal directions,
// the card badge and the picker's cycle exclusions — and the cycle walk is
// the client twin of the migration's advisory-locked reachability check, so
// its answers must match what the server would refuse.
const EDGES = [
  { id: "e1", taskId: "b", dependsOnId: "a" },
  { id: "e2", taskId: "c", dependsOnId: "b" },
  { id: "e3", taskId: "d", dependsOnId: "b" },
];

describe("taskDependencyLists", () => {
  it("reads the same edges forward as depends-on and backward as blocking", () => {
    expect(taskDependencyLists(EDGES, "b").dependsOn.map((edge) => edge.id)).toEqual(["e1"]);
    expect(taskDependencyLists(EDGES, "b").blocking.map((edge) => edge.id)).toEqual(["e2", "e3"]);
    expect(taskDependencyLists(EDGES, "a").dependsOn).toEqual([]);
    expect(taskDependencyLists(null, "a")).toEqual({ dependsOn: [], blocking: [] });
  });
});

describe("taskDependencyCount", () => {
  it("counts every edge touching the task in either direction", () => {
    expect(taskDependencyCount(EDGES, "b")).toBe(3);
    expect(taskDependencyCount(EDGES, "a")).toBe(1);
    expect(taskDependencyCount(EDGES, "zz")).toBe(0);
  });
});

describe("wouldCreateDependencyCycle", () => {
  it("refuses self-edges and the direct reversal", () => {
    expect(wouldCreateDependencyCycle(EDGES, "a", "a")).toBe(true);
    // b depends on a, so a -> b would close the two-node loop.
    expect(wouldCreateDependencyCycle(EDGES, "a", "b")).toBe(true);
  });

  it("sees TRANSITIVE reachability, not just direct edges", () => {
    // c reaches a through b; a -> c closes a three-node loop.
    expect(wouldCreateDependencyCycle(EDGES, "a", "c")).toBe(true);
    // Sibling branches never cycle: c and d both depend on b.
    expect(wouldCreateDependencyCycle(EDGES, "c", "d")).toBe(false);
    expect(wouldCreateDependencyCycle(EDGES, "b", "zz")).toBe(false);
  });

  it("terminates on a graph that already contains a cycle", () => {
    const cyclic = [...EDGES, { id: "e4", taskId: "a", dependsOnId: "c" }];
    expect(wouldCreateDependencyCycle(cyclic, "zz", "a")).toBe(false);
  });
});
