import { act, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { BusyButton } from "../src/components/BusyControls.jsx";
import { prepareBusyWrite, runBusyWrite, useBusyScope } from "../src/lib/busyWrite.js";
import { expectOneWriteForSameTickDouble } from "./helpers/sameTickActivation.js";

// a review note (a) and 272 (1), the shared level of record #8435's busy
// controls (#8554): two activations inside one React update reach the handler
// before the busy state renders, so BusyButton alone cannot refuse the second.
// runBusyWrite's synchronous lock sends the write once; prepareBusyWrite also
// refuses before preparing a second write.
function Save({ write, prepared = false }) {
  const lock = useRef(new Set());
  const [busy, setBusy] = useState(false);
  const save = (event) => {
    const operation = async () => {
      setBusy(true);
      try { await write(); } finally { setBusy(false); }
    };
    return prepared ? prepareBusyWrite(lock, "save", () => operation, event) : runBusyWrite(lock, "save", operation, event);
  };
  return <BusyButton pending={busy} onClick={save}>Save</BusyButton>;
}

describe("shared busy write lock, two activations in one React update", () => {
  it.each([["runBusyWrite", false], ["prepareBusyWrite", true]])("%s sends the write once", async (_name, prepared) => {
    const write = vi.fn(async () => {});
    render(<Save write={write} prepared={prepared} />);
    const button = screen.getByRole("button", { name: "Save" });
    await expectOneWriteForSameTickDouble(write, () => button.click());
    // Released, the next activation writes again: the lock is not left held.
    await act(async () => { button.click(); });
    expect(write).toHaveBeenCalledTimes(2);
  });

  // Each of prepareBusyWrite's two refusals is pinned
  // on its own. Its own check stops a second activation before preparing a
  // second write; runBusyWrite's lock (reached through it) refuses a write
  // whose key another write took while this one was being prepared.
  it("prepareBusyWrite prepares once for two activations, so its own check is pinned", () => {
    const lock = { current: new Set() };
    const write = vi.fn(() => new Promise(() => {}));
    const prepare = vi.fn(() => write);
    void prepareBusyWrite(lock, "save", prepare);
    void prepareBusyWrite(lock, "save", prepare);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("prepareBusyWrite does not run a write whose key was taken while it was prepared, so the lock it reaches is pinned", () => {
    const lock = { current: new Set() };
    const other = vi.fn(() => new Promise(() => {}));
    const write = vi.fn(() => new Promise(() => {}));
    // The preparation itself starts a write under the same key first.
    void prepareBusyWrite(lock, "save", () => { void runBusyWrite(lock, "save", other); return write; });
    expect(other).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });

  // Asserted synchronously, so a missing lock fails
  // here at once instead of by the test's timeout.
  it("keeps separate keys apart: a second write under another key still runs", async () => {
    const lock = { current: new Set() };
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const first = vi.fn(() => held);
    const second = vi.fn(async () => "done");
    const pending = runBusyWrite(lock, "a", first);
    const other = runBusyWrite(lock, "b", second);
    const refused = runBusyWrite(lock, "a", first);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(await other).toBe("done");
    release();
    expect(await refused).toBeUndefined();
    await pending;
    expect(lock.current.size).toBe(0);
  });
});

// #8973 delta 2 (record 8435): useBusyScope gives each activation of a scope a
// fresh generation, a return to an earlier scope included, so a lock keyed by
// it ends whenever busy is cleared by a scope change, and isCurrent fences a
// late answer from an earlier activation or an unmounted surface.
describe("useBusyScope", () => {
  function Probe({ scope, seen }) {
    const busyScope = useBusyScope(scope);
    seen.push(busyScope);
    return null;
  }

  it("starts a new generation on every scope change, a return included, and fences earlier ones", () => {
    const seen = [];
    const view = render(<Probe scope="a" seen={seen} />);
    const first = seen.at(-1).generation;
    view.rerender(<Probe scope="a" seen={seen} />);
    expect(seen.at(-1).generation).toBe(first);
    view.rerender(<Probe scope="b" seen={seen} />);
    view.rerender(<Probe scope="a" seen={seen} />);
    const returned = seen.at(-1);
    expect(returned.generation).toBe(first + 2);
    expect(returned.isCurrent(first)).toBe(false);
    expect(returned.isCurrent(returned.generation)).toBe(true);
    view.unmount();
    expect(returned.isCurrent(returned.generation)).toBe(false);
  });

  it("lets a new activation take its lock while an earlier one holds its own, and each releases only its own", async () => {
    const lock = { current: new Set() };
    let releaseOld;
    const old = runBusyWrite(lock, "save:1", () => new Promise((resolve) => { releaseOld = resolve; }));
    let releaseNew;
    const fresh = runBusyWrite(lock, "save:2", () => new Promise((resolve) => { releaseNew = resolve; }));
    expect([...lock.current]).toEqual(["save:1", "save:2"]);
    releaseOld();
    await old;
    expect([...lock.current]).toEqual(["save:2"]);
    expect(await runBusyWrite(lock, "save:2", async () => "second")).toBeUndefined();
    releaseNew();
    await fresh;
    expect(lock.current.size).toBe(0);
  });
});

describe("useBusyScope guard", () => {
  function Owner({ scope, seen }) {
    const busyScope = useBusyScope(scope);
    seen.push(busyScope.guard((value) => `ran ${value}`));
    return null;
  }

  it("runs a guarded callback while its activation is current, and not after the scope changes or the owner unmounts", () => {
    const seen = [];
    const view = render(<Owner scope="a" seen={seen} />);
    const first = seen.at(-1);
    view.rerender(<Owner scope="a" seen={seen} />);
    expect(first("same")).toBe("ran same");
    view.rerender(<Owner scope="b" seen={seen} />);
    expect(first("old")).toBeUndefined();
    const second = seen.at(-1);
    expect(second("new")).toBe("ran new");
    view.unmount();
    expect(second("gone")).toBeUndefined();
  });
});
