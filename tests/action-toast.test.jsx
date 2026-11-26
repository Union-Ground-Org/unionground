import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionToast, useActionNotice } from "../src/App.jsx";
import { TOAST_LEAVE_MS, TOAST_LIFETIME_MS } from "../src/lib/useToastLifetime.js";

function setup() {
  let notify;
  const run = vi.fn();
  function Harness() {
    const { notice, noticeAction, noticeId, setNotice } = useActionNotice();
    notify = setNotice;
    return <ActionToast notice={notice} noticeId={noticeId} action={noticeAction}
      onDismiss={() => setNotice("")} onAction={run} />;
  }
  render(<Harness />);
  return { notify: (...args) => act(() => notify(...args)), run };
}

function advance(ms) {
  act(() => vi.advanceTimersByTime(ms));
}

describe("repeated action notices", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // The prototype's toast clock (an owner decision, core.js
  // UG.toast): 4.2 s, then a .3s fade and removal at 320 ms.
  it("keeps an identical confirmation for 4.2 seconds after the latest save, then fades it out", () => {
    const { notify } = setup();
    notify("Availability saved");
    advance(2500);
    notify("Availability saved");
    advance(TOAST_LIFETIME_MS - 1);
    expect(screen.getByRole("status")).toHaveTextContent("Availability saved");
    expect(screen.getByRole("status")).not.toHaveAttribute("data-leaving");
    advance(1);
    expect(screen.getByRole("status")).toHaveAttribute("data-leaving", "true");
    advance(TOAST_LEAVE_MS);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect([TOAST_LIFETIME_MS, TOAST_LEAVE_MS]).toEqual([4200, 320]);
  });

  it("replaces the announcement text inside the existing live region on a repeat", () => {
    const { notify } = setup();
    notify("Availability saved");
    const region = screen.getByRole("status");
    const firstText = region.textContent;
    const firstAnnouncement = screen.getByText("Availability saved");
    notify("Availability saved");
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).not.toBe(firstText);
    expect(region.querySelector(".sr-only")).not.toHaveAttribute("aria-hidden");
    expect(firstAnnouncement).not.toBeInTheDocument();
    expect(screen.getByText("Availability saved")).toBeInTheDocument();
  });

  it.each(["focus", "hover"])("preserves the action and its %s pause across identical notices", (pause) => {
    const { notify, run } = setup();
    const action = { label: "Undo" };
    notify("Task removed", action);
    const button = screen.getByRole("button", { name: "Undo" });
    if (pause === "focus") act(() => button.focus());
    else fireEvent.mouseEnter(screen.getByRole("status"));
    advance(2500);
    notify("Task removed", action);
    advance(10_000);
    expect(screen.getByRole("button", { name: "Undo" })).toBe(button);
    if (pause === "focus") {
      expect(button).toHaveFocus();
      act(() => button.blur());
    } else fireEvent.mouseLeave(screen.getByRole("status"));
    advance(TOAST_LIFETIME_MS - 1);
    fireEvent.click(button);
    expect(run).toHaveBeenCalledOnce();
    advance(1);
    advance(TOAST_LEAVE_MS);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("clears an old action when the same message is issued without one", () => {
    const { notify } = setup();
    notify("Saved", { label: "Undo" });
    notify("Saved");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    advance(TOAST_LIFETIME_MS);
    advance(TOAST_LEAVE_MS);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
