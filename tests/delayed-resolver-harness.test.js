import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configuredResolverDelay, installDelayedResolvers } from "../scripts/lib/delayed-resolver-harness.mjs";

let restore;
beforeEach(() => { restore = installDelayedResolvers(vi, 20); });
afterEach(() => { restore(); vi.useRealTimers(); });

it("keeps fake-clock mock replies on the microtask queue", async () => {
  vi.useFakeTimers();
  const reply = vi.fn().mockResolvedValue("settled");
  let observed;
  reply().then(value => { observed = value; });
  await Promise.resolve();
  await Promise.resolve();
  expect(observed).toBe("settled");
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves one-shot replies, fallback replies and promise adoption on a fake clock", async () => {
  vi.useFakeTimers();
  const reply = vi.fn()
    .mockResolvedValue("fallback")
    .mockResolvedValueOnce(Promise.resolve("first"))
    .mockResolvedValueOnce("second");
  await expect(reply()).resolves.toBe("first");
  await expect(reply()).resolves.toBe("second");
  await expect(reply()).resolves.toBe("fallback");
  expect(vi.getTimerCount()).toBe(0);
});

it("still delays replies on a real clock", async () => {
  const pending = vi.fn().mockResolvedValue("later")();
  let observed;
  pending.then(value => { observed = value; });
  await Promise.resolve();
  await Promise.resolve();
  expect(observed).toBeUndefined();
  await expect(pending).resolves.toBe("later");
});

it("settles an already scheduled real reply after a switch to fake timers", async () => {
  const pending = vi.fn().mockResolvedValueOnce("scheduled")();
  vi.useFakeTimers();
  await expect(pending).resolves.toBe("scheduled");
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves synchronous implementations and rejected replies", async () => {
  expect(vi.fn(value => value + 1)(2)).toBe(3);
  const failure = new Error("expected rejection");
  await expect(vi.fn().mockRejectedValue(failure)()).rejects.toBe(failure);
});

it("restores the original factory and its microtask-only replies", async () => {
  const wrappedFactory = vi.fn;
  restore();
  expect(vi.fn).not.toBe(wrappedFactory);
  let observed;
  vi.fn().mockResolvedValue("ordinary")().then(value => { observed = value; });
  await Promise.resolve();
  await Promise.resolve();
  expect(observed).toBe("ordinary");
});

it.each([-1, NaN, Infinity, 60_001])("refuses an invalid diagnostic delay %s", delay => {
  expect(() => installDelayedResolvers(vi, delay)).toThrow(RangeError);
});

it("observes an adopted rejection before forwarding it after the delay", async () => {
  const failure = new Error("adopted rejection");
  const pending = vi.fn().mockResolvedValue(Promise.reject(failure))();
  await expect(pending).rejects.toBe(failure);
});

it.each(["", " ", "\t", "invalid", "-1", "Infinity", "60001"])("refuses an invalid configured delay %j", raw => {
  expect(() => configuredResolverDelay(raw)).toThrow(RangeError);
});

it("retains the default, explicit zero and ordinary configured delays", () => {
  expect(configuredResolverDelay()).toBe(60);
  expect(configuredResolverDelay("0")).toBe(0);
  expect(configuredResolverDelay(" 30 ")).toBe(30);
});
