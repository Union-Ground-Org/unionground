import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createRequestGeneration, isStaleResponse, StaleResponseError } from "../src/lib/requestGeneration.js";
import { useRequestGeneration } from "../src/lib/useRequestGeneration.js";
import { createRequestGeneration as createNativeGeneration } from "../apps/mobile/src/lib/requestGeneration.ts";
import { useRequestGeneration as useNativeGeneration } from "../apps/mobile/src/lib/useRequestGeneration.ts";
import { createResponseQueue } from "./helpers/responseQueue.js";

describe.each([["web", createRequestGeneration], ["native", createNativeGeneration]])("%s request lane", (_surface, create) => {
  it.each([false, true])("drops an older response after a newer result (old failure: %s)", async (failOld) => {
    const requests = create();
    const responses = createResponseQueue();
    let state;
    const read = (label) => {
      const ticket = requests.begin();
      return responses.request(label).then(
        (value) => { if (ticket.isCurrent()) state = { value }; },
        (error) => { if (ticket.isCurrent()) state = { error }; },
      );
    };
    const older = read("older");
    const newer = read("newer");
    responses.resolve("newer", "new answer");
    await newer;
    if (failOld) responses.reject("older", new Error("old failure"));
    else responses.resolve("older", "old answer");
    await older;
    expect(state).toEqual({ value: "new answer" });
  });

  it("keeps a current failure when an older success arrives", async () => {
    const requests = create();
    const responses = createResponseQueue();
    const old = requests.begin();
    const pending = responses.request("old");
    const latest = requests.begin();
    let state = latest.isCurrent() ? "current failure" : "loading";
    responses.resolve("old", "old success");
    const value = await pending;
    if (old.isCurrent()) state = value;
    expect(state).toBe("current failure");
  });

  it("invalidates captures, never revives disposed tickets, and keeps independent lanes separate", () => {
    const requests = create();
    const other = create();
    const unrelated = other.begin();
    const first = requests.begin();
    const page = requests.capture();
    expect(first.isCurrent()).toBe(true);
    expect(page.isCurrent()).toBe(true);
    expect(() => first.assertCurrent()).not.toThrow();
    requests.invalidate();
    expect(page.isCurrent()).toBe(false);
    expect(() => first.assertCurrent()).toThrow(StaleResponseError);
    requests.dispose();
    expect(requests.begin().isCurrent()).toBe(false);
    requests.activate();
    expect(first.isCurrent()).toBe(false);
    expect(requests.begin().isCurrent()).toBe(true);
    expect(unrelated.isCurrent()).toBe(true);
    expect(isStaleResponse(new StaleResponseError())).toBe(true);
    expect(isStaleResponse(new Error("current error"))).toBe(false);
  });
});

describe.each([["web", useRequestGeneration], ["native", useNativeGeneration]])("%s React lifecycle", (_surface, useGuard) => {
  it("rejects old scope and unmounted work, including A -> B -> A and Strict Mode replay", async () => {
    const responses = createResponseQueue();
    const { result, rerender, unmount } = renderHook(({ scope }) => useGuard(scope), { initialProps: { scope: "A" }, wrapper: StrictMode });
    const first = result.current.begin();
    const old = responses.request("A-before");
    rerender({ scope: "B" });
    const middle = result.current.begin();
    rerender({ scope: "A" });
    const current = result.current.begin();
    expect(first.isCurrent()).toBe(false);
    expect(middle.isCurrent()).toBe(false);
    expect(current.isCurrent()).toBe(true);
    let published = false;
    await act(async () => {
      responses.resolve("A-before", "retired A");
      await old;
      if (first.isCurrent()) published = true;
    });
    expect(published).toBe(false);
    unmount();
    expect(current.isCurrent()).toBe(false);
    expect(result.current.begin().isCurrent()).toBe(false);
  });

  it("keeps the same lane for the same committed scope", () => {
    const scope = {};
    const { result, rerender } = renderHook(() => useGuard(scope));
    const ticket = result.current.begin();
    const lane = result.current;
    rerender();
    expect(result.current).toBe(lane);
    expect(ticket.isCurrent()).toBe(true);
  });
});

it("the response test kit rejects duplicate labels and accidental double settlement", async () => {
  const responses = createResponseQueue();
  const success = responses.request("success");
  const failure = responses.request("failure").catch((error) => error);
  expect(responses.pending()).toEqual(["success", "failure"]);
  expect(() => responses.request("success")).toThrow("already used");
  const error = new Error("controlled failure");
  responses.reject("failure", error);
  responses.resolve("success", 42);
  expect(await success).toBe(42);
  expect(await failure).toBe(error);
  expect(responses.pending()).toEqual([]);
  expect(() => responses.resolve("success", 43)).toThrow("No pending response");
});
