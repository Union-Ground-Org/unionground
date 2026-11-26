import { act, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { expect, vi } from "vitest";
import { afterRenderingUpdate, enableFocusFixup } from "./focusFixup.js";

// Presentational surfaces receive pending state from their owner. Exercise
// that public prop contract with a real held callback, without adding a lock
// to the fixture that could conceal a missing guard in the control itself.
export function BusyTestHost({ children }) {
  const [pending, setPending] = useState(false);
  async function run(work) {
    setPending(true);
    try { return await work(); }
    finally { setPending(false); }
  }
  return children(pending, run);
}

// A surface test may already own a held promise. Assert its pending control
// with the browser's timed focus fixup, keeping the existing completion and
// duplicate-write assertions in that test.
export async function expectPendingFocus(control) {
  enableFocusFixup();
  expect(control).toBeEnabled();
  expect(control.closest('[aria-disabled="true"]')).not.toBeNull();
  control.focus();
  const frame = afterRenderingUpdate();
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(32);
  await frame;
  expect(control).toHaveFocus();
}

// Fire every activation inside one act(), before React can commit a busy
// state, so only a synchronous runBusyWrite lock can refuse the later ones.
// The writes stay held until all activations ran; across every mock passed,
// exactly one write may start. The original implementations come back after,
// and the reads a settled write starts (a reload on the same mock) are not
// counted. When one mock carries reads and writes alike (a client's rpc),
// pass isWrite: a surface's own background read can land inside the tick
//  and must not
// count as a second write.
export async function expectOneWriteFromOneTick(writes, activations, { isWrite = () => true } = {}) {
  const mocks = Array.isArray(writes) ? writes : [writes];
  const implementations = mocks.map((write) => write.getMockImplementation());
  const calls = () => mocks.reduce((total, write) => total + write.mock.calls.filter((args) => isWrite(...args)).length, 0);
  const before = calls();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  mocks.forEach((write, index) => write.mockImplementation(async function (...args) {
    await held;
    return implementations[index]?.apply(this, args);
  }));
  try {
    await act(async () => { for (const activate of activations) activate(); });
    expect(calls()).toBe(before + 1);
  } finally {
    await act(async () => { release(); });
    mocks.forEach((write, index) => write.mockImplementation(implementations[index]));
  }
}

// Exercise a real mounted surface with its backend write held past a browser
// rendering update. Keep the original mock's payload/result behavior after
// releasing it, so the surface's existing persistence assertions still run.
export async function expectHeldWriteFocus(write, control, activate = () => fireEvent.click(control)) {
  enableFocusFixup();
  // A newly opened dialog may still owe its initial-focus frame. Finish that
  // before the member focuses and activates a write control inside it.
  await act(async () => { await afterRenderingUpdate(); });
  const implementation = write.getMockImplementation();
  if (!implementation && write.getMockName() !== "vi.fn()") {
    throw new Error("A spy must explicitly mockImplementation(original.bind(owner)) before its write is held");
  }
  const before = write.mock.calls.length;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  write.mockImplementation(async function (...args) {
    await held;
    return implementation?.apply(this, args);
  });
  try {
    control.focus();
    activate();
    await afterRenderingUpdate();
    expect(write).toHaveBeenCalledTimes(before + 1);
    expect(control).toBeEnabled();
    expect(control).toHaveFocus();
    expect(control.closest('[aria-disabled="true"]')).not.toBeNull();
    activate();
    await afterRenderingUpdate();
    expect(write).toHaveBeenCalledTimes(before + 1);
    expect(control).toHaveFocus();
  } finally {
    await act(async () => { release(); });
    write.mockImplementation(implementation);
  }
}

// A write whose callback throws at once clears its busy state in its own
// finally, in the same turn. The lock must end there too: the control reads
// ready, so an immediate second press sends (record 8435, slice 9). The
// callback stays throwing for the rest of the test.
export async function expectReadyRetryAfterThrowAtOnce(write, control, activate = () => fireEvent.click(control)) {
  write.mockImplementation(() => { throw new Error("refused at once"); });
  const before = write.mock.calls.length;
  activate();
  expect(write).toHaveBeenCalledTimes(before + 1);
  expect(control).toBeEnabled();
  expect(control).not.toHaveAttribute("aria-disabled");
  activate();
  expect(write).toHaveBeenCalledTimes(before + 2);
  await act(async () => {});
}
