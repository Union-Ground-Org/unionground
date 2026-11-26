import { describe, expect, it } from "vitest";
import { DEMO_BOARD_KEYS, demoBoardSlice, mergeDemoSlice } from "../src/lib/demoBridge.js";

// App.jsx reaches mergeDemoSlice only through the companion-frame
// "sg-demo-data" / "sg-demo-data-up" postMessage handlers, which no App test
// drives, so the merge rules are pinned here against the module itself.
describe("demoBoardSlice", () => {
  it("keeps only the board keys whose values are arrays", () => {
    const tasks = [{ id: "task-1" }];
    const taskComments = [];
    expect(demoBoardSlice({
      tasks,
      taskComments,
      taskMessages: "not an array",
      taskFiles: null,
      member: { id: "member-1" },
      cases: [{ id: "case-1" }],
    })).toEqual({ tasks, taskComments });
  });

  it("returns an empty slice for missing data", () => {
    expect(demoBoardSlice(undefined)).toEqual({});
    expect(demoBoardSlice(null)).toEqual({});
  });

  it("covers every task-board collection and nothing else", () => {
    const data = Object.fromEntries(DEMO_BOARD_KEYS.map((key) => [key, [{ key }]]));
    expect(Object.keys(demoBoardSlice({ ...data, cases: [] })).sort()).toEqual([...DEMO_BOARD_KEYS].sort());
  });
});

describe("mergeDemoSlice", () => {
  const previous = Object.freeze({
    member: { id: "member-1" },
    tasks: [{ id: "task-1" }],
    taskComments: [{ id: "comment-1" }],
  });

  it("replaces board keys wholesale and keeps the rest of the fixture state", () => {
    const tasks = [{ id: "task-2" }];
    const next = mergeDemoSlice(previous, { tasks, taskWatches: [] });
    expect(next).toEqual({
      member: { id: "member-1" },
      tasks,
      taskComments: [{ id: "comment-1" }],
      taskWatches: [],
    });
    expect(next).not.toBe(previous);
    expect(next.tasks).toBe(tasks);
  });

  it("never lets unknown or non-array slice values cross", () => {
    const next = mergeDemoSlice(previous, {
      member: { id: "intruder" },
      cases: [{ id: "case-1" }],
      taskComments: "not an array",
    });
    expect(next).toEqual(previous);
    expect(next).not.toBe(previous);
  });

  it("returns the previous state unchanged when either side is unusable", () => {
    expect(mergeDemoSlice(null, { tasks: [] })).toBeNull();
    expect(mergeDemoSlice(undefined, { tasks: [] })).toBeUndefined();
    expect(mergeDemoSlice(previous, null)).toBe(previous);
    expect(mergeDemoSlice(previous, "sg-demo-data")).toBe(previous);
  });
});
