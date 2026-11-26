import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHELL_LOAD_DEADLINE_MS, createLoadTimeoutError, withLoadDeadline } from "../src/lib/loadDeadline.js";

describe("withLoadDeadline", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("resolves the work when it settles before the deadline and clears the timer", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const result = withLoadDeadline(() => Promise.resolve("ready"), 50);
    await expect(result).resolves.toBe("ready");
    expect(clearSpy).toHaveBeenCalled();
  });

  it("rejects with a TimeoutError once the deadline passes", async () => {
    const pending = withLoadDeadline(new Promise(() => {}), 25);
    const outcome = pending.catch((error) => error);
    vi.advanceTimersByTime(25);
    const error = await outcome;
    expect(error.name).toBe("TimeoutError");
  });

  it("returns the work untouched for a non-finite or non-positive deadline", async () => {
    const promise = Promise.resolve("no-deadline");
    expect(withLoadDeadline(promise, 0)).toBe(promise);
    expect(withLoadDeadline(promise, Number.NaN)).toBe(promise);
    expect(withLoadDeadline(promise, Number.POSITIVE_INFINITY)).toBe(promise);
    await expect(withLoadDeadline(promise)).resolves.toBe("no-deadline");
    expect(SHELL_LOAD_DEADLINE_MS).toBe(10_000);
  });

  it("builds a TimeoutError with or without DOMException", () => {
    expect(createLoadTimeoutError().name).toBe("TimeoutError");
    const original = globalThis.DOMException;
    globalThis.DOMException = undefined;
    try {
      const error = createLoadTimeoutError("late");
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("TimeoutError");
      expect(error.message).toBe("late");
    } finally {
      globalThis.DOMException = original;
    }
  });
});
