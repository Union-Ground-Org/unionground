import { describe, expect, it } from "vitest";
import { fencedChapterWrite } from "../src/lib/chapterWriteFence.js";

// Sol final on #6606: a notice's chapter is the selected chapter when the
// server runs it, so a chapter switch must not overtake a submitted notice.
const transition = (current) => ({ current: current === null ? null : { operation: { isCurrent: () => current } } });

describe("a write bound to the selected chapter", () => {
  it("is refused while a chapter switch is current and never starts", async () => {
    let started = false;
    await expect(fencedChapterWrite(transition(true), { current: new Set() }, () => { started = true; return Promise.resolve(); }))
      .rejects.toThrow("Chapter switch in progress");
    expect(started).toBe(false);
  });

  it("is tracked until it settles so a switch can wait for it", async () => {
    const pending = { current: new Set() };
    let finish;
    const write = fencedChapterWrite(transition(false), pending, () => new Promise((resolve) => { finish = resolve; }));
    expect(pending.current.size).toBe(1);
    const tracked = [...pending.current][0];
    finish("posted");
    await expect(tracked).resolves.toBe("posted");
    await expect(write).resolves.toBe("posted");
    expect(pending.current.size).toBe(0);
  });

  it("stops tracking a failed write and passes the failure on", async () => {
    const pending = { current: new Set() };
    await expect(fencedChapterWrite(transition(null), pending, () => Promise.reject(new Error("refused")))).rejects.toThrow("refused");
    expect(pending.current.size).toBe(0);
  });
});
