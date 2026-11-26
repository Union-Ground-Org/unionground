import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeHatSwitcherMenu,
  openHatSwitcherMenu,
} from "../apps/mobile/src/lib/hatSwitcherSheetMotion.ts";

const accessibility = vi.hoisted(() => {
  /** @type {{ resolve: ((value: boolean) => void) | null, promise: Promise<boolean> }} */
  const state = { resolve: null, promise: new Promise(() => undefined) };
  return {
    state,
    resetPending() {
      state.promise = new Promise((resolve) => {
        state.resolve = resolve;
      });
    },
    isReduceMotionEnabled: vi.fn(() => state.promise),
    addEventListener: vi.fn(),
  };
});

vi.mock("react-native", () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: (...args) => accessibility.isReduceMotionEnabled(...args),
    addEventListener: (...args) => accessibility.addEventListener(...args),
  },
}));

function sheetDriver(initial = 0) {
  const sheet = { value: initial, setValue(next) { this.value = next; } };
  return sheet;
}

describe("hat switcher menu Reduce Motion", () => {
  beforeEach(() => {
    vi.resetModules();
    accessibility.resetPending();
    accessibility.isReduceMotionEnabled.mockClear();
    accessibility.addEventListener.mockClear();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("treats a pending AccessibilityInfo probe as Reduce Motion and never times the menu", async () => {
    const { useReduceMotion } = await import("../apps/mobile/src/lib/reduceMotion.ts");
    const seen = [];
    function Probe() {
      seen.push(useReduceMotion());
      return null;
    }
    render(<Probe />);
    expect(seen.at(-1)).toBe(true);
    expect(accessibility.isReduceMotionEnabled).toHaveBeenCalled();

    const openSheet = sheetDriver(0);
    const timeOpen = vi.fn();
    openHatSwitcherMenu(openSheet, seen.at(-1), timeOpen);
    expect(openSheet.value).toBe(1);
    expect(timeOpen).not.toHaveBeenCalled();

    const closeSheet = sheetDriver(1);
    const timeClose = vi.fn();
    const dismiss = vi.fn();
    closeHatSwitcherMenu(closeSheet, seen.at(-1), timeClose, dismiss);
    expect(closeSheet.value).toBe(0);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(timeClose).not.toHaveBeenCalled();
  });

  it("keeps the snap paths after the probe resolves true", async () => {
    const { useReduceMotion } = await import("../apps/mobile/src/lib/reduceMotion.ts");
    const seen = [];
    function Probe() {
      seen.push(useReduceMotion());
      return null;
    }
    render(<Probe />);
    await act(async () => {
      accessibility.state.resolve?.(true);
      await accessibility.state.promise;
    });
    expect(seen.at(-1)).toBe(true);

    const timeOpen = vi.fn();
    openHatSwitcherMenu(sheetDriver(0), seen.at(-1), timeOpen);
    expect(timeOpen).not.toHaveBeenCalled();
  });

  it("allows the timed paths only after the probe resolves false", async () => {
    const { useReduceMotion } = await import("../apps/mobile/src/lib/reduceMotion.ts");
    const seen = [];
    function Probe() {
      seen.push(useReduceMotion());
      return null;
    }
    render(<Probe />);
    expect(seen.at(-1)).toBe(true);
    await act(async () => {
      accessibility.state.resolve?.(false);
      await accessibility.state.promise;
    });
    expect(seen.at(-1)).toBe(false);

    const start = vi.fn();
    openHatSwitcherMenu(sheetDriver(0), seen.at(-1), () => ({ start }));
    expect(start).toHaveBeenCalledTimes(1);
  });
});
