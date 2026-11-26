import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChoiceDialog } from "../src/components/Dialogs.jsx";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const PULSE = {
  id: "p1",
  kind: "pulse",
  title: "Weekend pulse",
  options: [
    { id: "a", label: "Fair" },
    { id: "b", label: "Unfair" },
  ],
};

function wrapDialog(item, props = {}) {
  return (
    <LanguageProvider lang="en">
      <ChoiceDialog item={item} onClose={props.onClose || vi.fn()} onSubmit={props.onSubmit || vi.fn()} />
    </LanguageProvider>
  );
}

function renderDialog(item, props = {}) {
  return render(wrapDialog(item, props));
}

async function submitPulseAnswer(item, props) {
  const view = renderDialog(item, props);
  fireEvent.click(screen.getByRole("radio", { name: "Fair" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  });
  expect(screen.getByRole("status")).toHaveTextContent("Answer in!");
  return view;
}

describe("choice dialog — pulse anonymity + celebration", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows the anonymity reassurance before submitting a pulse", () => {
    renderDialog(PULSE);
    expect(screen.getByText(/answers are anonymous/i)).toBeInTheDocument();
    expect(screen.getByText(/never which answers you chose/i)).toBeInTheDocument();
  });

  it("shows the final-vote note on ballots, never the pulse anonymity note", () => {
    // Votes are FINAL (20260808230000): the ballot form warns before the
    // member commits, and the pulse-specific anonymity wording (which names
    // completion visibility pulses have and ballots do not) stays off it.
    renderDialog({ ...PULSE, kind: "ballot" });
    expect(screen.getByText(/your vote is final/i)).toBeInTheDocument();
    expect(screen.queryByText(/answers are anonymous/i)).not.toBeInTheDocument();
  });

  it("does not show the ballot final-vote note on pulses", () => {
    renderDialog(PULSE);
    expect(screen.queryByText(/your vote is final/i)).not.toBeInTheDocument();
  });

  it("offers no resubmission for a ballot that already holds a receipt", () => {
    // A cast ballot's only client-side state is its receipt — the choice is
    // stored unlinkably server-side — so the dialog must state finality
    // instead of re-rendering a submittable form.
    renderDialog({ ...PULSE, kind: "ballot", receiptCode: "SG-AAAA-BBBB" });
    expect(screen.queryByRole("button", { name: "Submit vote" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/your vote is final/i);
  });

  it("celebrates after a pulse answer lands, then self-dismisses", async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue({ awardedPoints: 0 });
    renderDialog(PULSE, { onClose, onSubmit });
    fireEvent.click(screen.getByRole("radio", { name: "Fair" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    });
    expect(onSubmit).toHaveBeenCalledWith("a");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Answer in!");
    act(() => vi.advanceTimersByTime(1800));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes a ballot immediately without the celebration", async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue("RCPT-1");
    renderDialog({ ...PULSE, kind: "ballot" }, { onClose, onSubmit });
    fireEvent.click(screen.getByRole("radio", { name: "Fair" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit vote" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Answer in!")).not.toBeInTheDocument();
  });

  it("stays open with the form intact when the save fails", async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn().mockRejectedValue(new Error("offline"));
    renderDialog(PULSE, { onClose, onSubmit });
    fireEvent.click(screen.getByRole("radio", { name: "Fair" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeEnabled();
  });
});

describe("choice dialog — pulse celebration timer survives parent rerenders", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    clearDeviceParityState();
  });

  it("fires the latest onClose at the original 1800ms deadline after mid-window callback swaps", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue({ awardedPoints: 0 });
    const item = { ...PULSE, id: "p-rerender-callback" };
    const { rerender } = await submitPulseAnswer(item, { onClose: first, onSubmit });
    act(() => vi.advanceTimersByTime(1500));
    expect(first).not.toHaveBeenCalled();
    rerender(wrapDialog(item, { onClose: second, onSubmit }));
    rerender(wrapDialog(item, { onClose: second, onSubmit }));
    act(() => vi.advanceTimersByTime(300));
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("does not re-arm the close deadline across five mid-window rerenders", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ awardedPoints: 0 });
    const item = { ...PULSE, id: "p-rerender-deadline" };
    let onClose = vi.fn();
    const { rerender } = await submitPulseAnswer(item, { onClose, onSubmit });
    for (let i = 0; i < 5; i += 1) {
      act(() => vi.advanceTimersByTime(200));
      onClose = vi.fn();
      rerender(wrapDialog(item, { onClose, onSubmit }));
    }
    act(() => vi.advanceTimersByTime(799));
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cancels the celebration close when the dialog unmounts before the deadline", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue({ awardedPoints: 0 });
    const item = { ...PULSE, id: "p-rerender-unmount" };
    const { rerender, unmount } = await submitPulseAnswer(item, { onClose: first, onSubmit });
    act(() => vi.advanceTimersByTime(500));
    rerender(wrapDialog(item, { onClose: second, onSubmit }));
    unmount();
    act(() => vi.advanceTimersByTime(2000));
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });
});
