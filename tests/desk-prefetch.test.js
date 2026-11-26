// PERF-UG-DEMO-ROLE-SWITCH-STAFF-DESK-READS-START-LATE-20261124 (#9840):
// a desk read started before the desk mounts belongs to the visit that started
// it, is used once, only under its own key and only while fresh; a started
// read that failed is replaced by the desk's own read.
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  advisorOverviewOnly, coordinatorKpisOnly, createDeskPrefetch, DESK_PREFETCH_MAX_AGE_MS,
  useDeskPrefetchStore, useDeskPrefetchVisit, workspaceSectionAt,
} from "../src/lib/deskPrefetch.js";

const own = (value) => vi.fn(async () => value);

describe("desk prefetch", () => {
  it("hands a started read to the first take for the same key only, and reads for itself after", async () => {
    const prefetch = createDeskPrefetch();
    const started = vi.fn(async () => "started");
    expect(prefetch.start("coordinator:full:u:o:c:en", started)).toBe(true);
    expect(prefetch.start("coordinator:full:u:o:c:en", started)).toBe(false);
    expect(started).toHaveBeenCalledTimes(1);
    const otherScope = own("own-other");
    await expect(prefetch.take("coordinator:full:u:o:c-other:en", otherScope)).resolves.toBe("own-other");
    const first = own("own");
    await expect(prefetch.take("coordinator:full:u:o:c:en", first)).resolves.toBe("started");
    expect(first).not.toHaveBeenCalled();
    const second = own("own-again");
    await expect(prefetch.take("coordinator:full:u:o:c:en", second)).resolves.toBe("own-again");
  });

  it("drops a stale read: the desk reads for itself", async () => {
    let clock = 1_000;
    const prefetch = createDeskPrefetch({ now: () => clock });
    prefetch.start("advisor:overview:u:o:c", async () => "started");
    clock += DESK_PREFETCH_MAX_AGE_MS;
    const read = own("own");
    await expect(prefetch.take("advisor:overview:u:o:c", read)).resolves.toBe("own");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("replaces a started read that failed with one read of the desk's own, whose result or failure is the desk's", async () => {
    const prefetch = createDeskPrefetch();
    prefetch.start("advisor:full:u:o:c", async () => { throw new Error("transient"); });
    const read = own("own");
    await expect(prefetch.take("advisor:full:u:o:c", read)).resolves.toBe("own");
    expect(read).toHaveBeenCalledTimes(1);
    prefetch.start("advisor:full:u:o:c", () => { throw new Error("sync"); });
    const refused = vi.fn(async () => { throw new Error("refused"); });
    await expect(prefetch.take("advisor:full:u:o:c", refused)).rejects.toThrow("refused");
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("leaves an untaken failure silent", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const prefetch = createDeskPrefetch();
      prefetch.start("coordinator:full:u:o:c:en", async () => { throw new Error("never taken"); });
      prefetch.clear();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("decides each desk's reader from the page, as the desks do", () => {
    expect(workspaceSectionAt("/m/coordinator", "")).toBe("overview");
    expect(workspaceSectionAt("/m/advisor", "")).toBe("overview");
    expect(coordinatorKpisOnly("coordinator-funnel", "")).toBe(true);
    expect(coordinatorKpisOnly("coordinator-funnel", "?case=c-1")).toBe(false);
    expect(coordinatorKpisOnly("overview", "")).toBe(false);
    expect(advisorOverviewOnly("overview")).toBe(true);
    expect(advisorOverviewOnly("advisor-turnout")).toBe(true);
    expect(advisorOverviewOnly("advisor-workload")).toBe(false);
  });
});

describe("a started read belongs to one visit (Sol r1 on #9840)", () => {
  const visit = { view: "coordinator", location: "/m/coordinator", hat: "coordinator", authorized: true, userId: "u", scope: "u:o:c" };
  function mounted() {
    return renderHook((props) => {
      const ref = useDeskPrefetchStore();
      useDeskPrefetchVisit(ref, props);
      return ref;
    }, { initialProps: visit });
  }
  const startedThenTaken = async (ref) => {
    ref.current.start("coordinator:full:u:o:c:en", async () => "started");
    return ref.current.take("coordinator:full:u:o:c:en", async () => "fresh");
  };

  it("keeps the read while the visit stays the same", async () => {
    const { result, rerender } = mounted();
    result.current.current.start("coordinator:full:u:o:c:en", async () => "started");
    rerender({ ...visit });
    await expect(result.current.current.take("coordinator:full:u:o:c:en", async () => "fresh")).resolves.toBe("started");
  });

  it.each([
    ["leaving the page and coming back (a new switch)", { view: "today" }],
    //  on #9840: a read started for one page of the desk is not taken on another.
    ["moving to another page of the same desk", { location: "/m/coordinator#coordinator-cases" }],
    ["opening a case on the same desk page", { location: "/m/coordinator?case=c-1" }],
    ["changing the worn hat", { hat: "member" }],
    ["the hat no longer being authorized", { authorized: false }],
    ["signing out", { userId: null }],
    ["another account", { userId: "v" }],
    ["another organization or chapter", { scope: "u:o:c2" }],
  ])("empties the store on %s", async (_name, change) => {
    const { result, rerender } = mounted();
    result.current.current.start("coordinator:full:u:o:c:en", async () => "started");
    rerender({ ...visit, ...change });
    rerender({ ...visit });
    await expect(result.current.current.take("coordinator:full:u:o:c:en", async () => "fresh")).resolves.toBe("fresh");
  });

  it("empties the store when the shell unmounts", async () => {
    const { result, unmount } = mounted();
    const ref = result.current;
    ref.current.start("coordinator:full:u:o:c:en", async () => "started");
    unmount();
    await expect(ref.current.take("coordinator:full:u:o:c:en", async () => "fresh")).resolves.toBe("fresh");
    await expect(startedThenTaken(ref)).resolves.toBe("started");
  });
});
