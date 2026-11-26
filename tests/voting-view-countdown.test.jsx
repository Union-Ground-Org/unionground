// Crunch countdown scheduling for the member Voice screen
// (PERF-UG-VOTING-COUNTDOWN-TICKS-OUTSIDE-CRUNCH-WINDOW-20260920).
// The per-second clock exists only to redraw the "closes in" chip, and that
// chip is on screen only inside the 2-hour crunch window. The loader ships
// closes_at on every ballot plan item, so an unguarded interval would wake the
// view once a second for the whole life of a ballot that closes next week and
// again forever after it has closed. The clock must stay dormant until the
// window opens and retire itself at the close.
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { VotingView } from "../src/views/VotingView.jsx";

const NOW = new Date("2026-09-22T09:00:00-04:00").getTime();
const HOUR = 60 * 60 * 1000;

const openBallot = fallbackData.planItems.find((item) => item.kind === "ballot" && !item.closed);

function dataClosingIn(ms) {
  return {
    ...fallbackData,
    planItems: [{ ...openBallot, receiptCode: "", closesAt: new Date(NOW + ms).toISOString() }],
  };
}

function renderVoting(data) {
  return render(
    <LanguageProvider lang="en">
      <VotingView data={data} demo onPlanAction={vi.fn()} />
    </LanguageProvider>,
  );
}

// Only the 1-second clock matters here; the dormant wake-up timer and any
// unrelated scheduling are not per-second re-render pressure.
function secondTicks(spy) {
  return spy.mock.calls.filter((call) => call[1] === 1000).length;
}

describe("VotingView crunch countdown scheduling", () => {
  let intervalSpy;
  let clearIntervalSpy;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    intervalSpy = vi.spyOn(globalThis, "setInterval");
    clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
  });

  afterEach(() => {
    intervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
    vi.useRealTimers();
    clearDeviceParityState();
  });

  it("does not run the per-second clock while the close is outside the crunch window", () => {
    const view = renderVoting(dataClosingIn(5 * HOUR));
    expect(view.container.querySelector(".voting-hero__countdown")).toBeNull();
    expect(secondTicks(intervalSpy)).toBe(0);

    // An hour of wall clock inside the dormant band must still cost nothing.
    act(() => { vi.advanceTimersByTime(HOUR); });
    expect(view.container.querySelector(".voting-hero__countdown")).toBeNull();
    expect(secondTicks(intervalSpy)).toBe(0);
    view.unmount();
  });

  it("does not run the per-second clock once the ballot's close time has passed", () => {
    const view = renderVoting(dataClosingIn(-HOUR));
    expect(view.container.querySelector(".voting-hero__countdown")).toBeNull();
    expect(secondTicks(intervalSpy)).toBe(0);

    act(() => { vi.advanceTimersByTime(HOUR); });
    expect(secondTicks(intervalSpy)).toBe(0);
    view.unmount();
  });

  it("starts the clock when the window opens and stops it at the close", () => {
    const view = renderVoting(dataClosingIn(3 * HOUR));
    expect(secondTicks(intervalSpy)).toBe(0);

    // Cross into the 2-hour window: the chip appears and the clock starts.
    act(() => { vi.advanceTimersByTime(HOUR + 1000); });
    expect(secondTicks(intervalSpy)).toBe(1);
    const chip = view.container.querySelector(".voting-hero__countdown");
    expect(chip).not.toBeNull();
    const firstLabel = chip.textContent;
    expect(firstLabel).toMatch(/^1:5\d:\d\d$/);

    act(() => { vi.advanceTimersByTime(2000); });
    expect(view.container.querySelector(".voting-hero__countdown").textContent).not.toBe(firstLabel);

    // Past the close the chip is gone and the interval is retired, not left
    // spinning for the rest of the session.
    const timerId = intervalSpy.mock.results.find((result, index) => intervalSpy.mock.calls[index][1] === 1000).value;
    act(() => { vi.advanceTimersByTime(2 * HOUR); });
    expect(view.container.querySelector(".voting-hero__countdown")).toBeNull();
    expect(clearIntervalSpy).toHaveBeenCalledWith(timerId);
    expect(secondTicks(intervalSpy)).toBe(1);
    view.unmount();
  });

  it("arms no timer at all when no open ballot carries a close time", () => {
    const view = renderVoting({
      ...fallbackData,
      planItems: [{ ...openBallot, receiptCode: "", closesAt: null, closes_at: null }],
    });
    expect(secondTicks(intervalSpy)).toBe(0);
    act(() => { vi.advanceTimersByTime(4 * HOUR); });
    expect(secondTicks(intervalSpy)).toBe(0);
    view.unmount();
  });
});
