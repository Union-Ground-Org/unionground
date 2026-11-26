import { act } from "@testing-library/react";
import { expect } from "vitest";

// a review note (a) and 272 (1): activate a control twice inside ONE React
// update, so the second activation runs before React commits the busy state the
// first one set. Only the write's own synchronous lock (src/lib/busyWrite.js,
// runBusyWrite) can then refuse the second, which is what this pins. The write
// is held until both activations are made, so the first cannot finish early.
export async function expectOneWriteForSameTickDouble(write, activate) {
  const implementation = write.getMockImplementation();
  const before = write.mock.calls.length;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  write.mockImplementation(async function (...args) {
    await held;
    return implementation?.apply(this, args);
  });
  try {
    await act(async () => {
      activate();
      activate();
    });
    expect(write).toHaveBeenCalledTimes(before + 1);
  } finally {
    await act(async () => { release(); });
    write.mockImplementation(implementation);
  }
}
