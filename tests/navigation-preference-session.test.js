import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createNavigationPreferenceSaveQueue } from "../src/lib/navigationPreferences.js";

const prefs = (shortcutKeys, workWidgetOrder = ["messages", "appointments", "cases", "forms", "workload", "numbers"]) => ({
  shortcutKeys,
  workWidgetOrder,
});

describe("navigation preference session queue", () => {
  it("serializes complete snapshots and confirms the last rapid edit", async () => {
    const calls = [];
    const confirmed = [];
    const queue = createNavigationPreferenceSaveQueue({
      initial: prefs(["today"]),
      persist: async (snapshot) => { calls.push(snapshot); },
      canCommit: () => true,
      onConfirmed: (snapshot) => confirmed.push(snapshot),
    });
    await Promise.all([
      queue.enqueue(prefs(["today", "cases"]), { userId: "a", generation: 1 }),
      queue.enqueue(prefs(["today", "cases", "messages"]), { userId: "a", generation: 1 }),
    ]);
    expect(calls).toEqual([prefs(["today", "cases"]), prefs(["today", "cases", "messages"])]);
    expect(confirmed.at(-1)).toEqual(prefs(["today", "cases", "messages"]));
  });

  it("drops stale-session work before write and ignores a stale completion", async () => {
    let active = true;
    let release;
    const persist = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const onConfirmed = vi.fn();
    const queue = createNavigationPreferenceSaveQueue({
      initial: prefs(["today"]), persist, canCommit: () => active, onConfirmed,
    });
    const pending = queue.enqueue(prefs(["cases"]), { userId: "a", generation: 1 });
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    active = false;
    release();
    await pending;
    await queue.enqueue(prefs(["messages"]), { userId: "a", generation: 1 });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("rolls back only when the latest save rejects", async () => {
    const rollback = vi.fn();
    const queue = createNavigationPreferenceSaveQueue({
      initial: prefs(["today"]),
      persist: vi.fn()
        .mockRejectedValueOnce(new Error("first"))
        .mockRejectedValueOnce(new Error("latest")),
      canCommit: () => true,
      onRollback: rollback,
    });
    await Promise.allSettled([
      queue.enqueue(prefs(["cases"]), { userId: "a", generation: 1 }),
      queue.enqueue(prefs(["messages"]), { userId: "a", generation: 1 }),
    ]);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledWith(prefs(["today"]), expect.any(Error));
  });
});

describe("MemberApp navigation preference wiring", () => {
  const app = readFileSync(join(process.cwd(), "src/App.jsx"), "utf8");

  it("queues complete live snapshots through the settings outbox", () => {
    expect(app).toContain('key: "navigation"');
    expect(app).toContain("fields: nextSnapshot");
    expect(app).toContain("shortcutKeys: normalizedShortcuts");
    expect(app).toContain("workWidgetOrder: normalizedWidgets");
  });

  it("uses member-namespaced demo storage and the session generation guard", () => {
    expect(app).toContain("loadDemoNavigationPreferences(data.member.id");
    expect(app).toContain("saveDemoNavigationPreferences(acting.userId, nextSnapshot");
    expect(app).toContain("guardRef.current.generation === acting.generation");
    expect(app).toContain("guardRef.current.currentUserId === acting.userId");
  });
});
