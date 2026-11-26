import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionToast, App, focusWhenAvailable } from "../src/App.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { TasksView } from "../src/views/TasksView.jsx";
import { primeDemoHat } from "./helpers/demoHat.js";

// Soft delete, and the two things that keep it honest: the designed confirm
// (it names the chapter, the message count and the person; the safe path comes
// first and holds focus; "Remove it" is the destructive act) and the Undo the
// soft delete exists to make possible. window.confirm is gone and stays gone.
//
// The t0ggles rebuild moved the ENTRANCE without moving the flow: delete used
// to hang off the old TaskEditor dialog, and now it is a round pill in the task
// modal's floating bar. That is exactly the kind of move that quietly loses a
// confirm — the pill is easy to wire straight to the destructive call, and
// nothing in review looks wrong, because a delete button that deletes reads as
// correct. So this file drives the real path end to end: open the card, press
// the pill, and prove that NOTHING is removed until the alertdialog is
// answered, that the safe answer is the one focus lands on, and that a failed
// server call puts the card back.
//
// The last describe runs the same flow through <App /> in demo mode, because
// the Undo lives on the app toast, not in the view — the view's job ends at
// "removed optimistically, parent told".

function renderTasks(overrides = {}) {
  const props = {
    data: structuredClone(fallbackData),
    onProfile: vi.fn(),
    onAssistant: vi.fn(),
    onCreateTask: vi.fn(async (fields) => ({ ...fields, id: "new-task" })),
    onUpdateTask: vi.fn(async (_id, fields) => fields),
    onDeleteTask: vi.fn(async () => ({ deleted: true })),
    onSendTaskMessage: vi.fn(async () => null),
    ...overrides,
  };
  const rendered = render(<LanguageProvider lang="en"><TasksView {...props} /></LanguageProvider>);
  return {
    ...props,
    rerenderData(nextData) {
      rendered.rerender(<LanguageProvider lang="en"><TasksView {...props} data={nextData} /></LanguageProvider>);
    },
  };
}

// The card title button is the modal's entrance; the pill inside it is the
// only delete control on the screen.
function openCard(title) {
  fireEvent.click(screen.getByRole("button", { name: title }));
  return screen.getByRole("dialog");
}

function pressDeletePill() {
  fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
  return screen.getByRole("alertdialog");
}

describe("the designed delete confirm", () => {
  it("names the chapter, the kept message count and the notified person", async () => {
    const props = renderTasks();
    // task-demo-2: created by the member, assigned to Maria, 2 messages.
    openCard("Translate bargaining pulse");
    const dialog = pressDeletePill();
    expect(dialog).toHaveAccessibleName('Delete "Translate bargaining pulse"?');
    expect(within(dialog).getByText("This removes the task for everyone in Harborview Care United.")).toBeInTheDocument();
    expect(within(dialog).getByText("The 2 private messages about it are kept.")).toBeInTheDocument();
    expect(within(dialog).getByText("Maria Santos is notified that it left their list.")).toBeInTheDocument();
    expect(within(dialog).getByText("Removed from the board. The conversation is kept. Undo is offered briefly right after removal.")).toBeInTheDocument();
    // The confirm never claims the conversation is destroyed — that was the
    // hard-delete promise the soft delete exists to stop making.
    expect(within(dialog).queryByText(/permanently deletes/)).not.toBeInTheDocument();

    // The safe path comes first, it is a decision rather than a cancel, and it
    // is where focus lands — the destructive button is never one blind Enter
    // away.
    const buttons = within(dialog).getAllByRole("button");
    expect(buttons[0]).toHaveTextContent("Keep the task");
    expect(buttons[1]).toHaveTextContent("Remove it");
    expect(buttons[0]).toHaveFocus();

    fireEvent.click(buttons[0]);
    expect(screen.getByRole("alertdialog").closest(".task-editor-backdrop")).toHaveAttribute("data-state", "closing");
    expect(buttons[1]).toBeDisabled();
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(props.onDeleteTask).not.toHaveBeenCalled();
    // Backing out of the confirm keeps the card open, not just alive.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("removes the card optimistically after Remove it, and closes the modal with it", async () => {
    vi.useFakeTimers();
    try {
      const props = renderTasks();
      const [fallbackButton, ...otherButtons] = screen.getAllByRole("button", { name: "New task" });
      expect(otherButtons.some((button) => button.closest(".kan-col") !== fallbackButton.closest(".kan-col"))).toBe(true);
      const taskCard = screen.getByRole("button", { name: "Translate bargaining pulse" });
      const workspace = openCard("Translate bargaining pulse");
      const confirm = pressDeletePill();

      await act(async () => { fireEvent.click(within(confirm).getByRole("button", { name: "Remove it" })); });
      expect(props.onDeleteTask).toHaveBeenCalledWith("task-demo-2");
      expect(taskCard).not.toBeInTheDocument();

      // JSDOM does not animate the exits. Finish both and let the product's
      // scheduled focus hand-off run after their inert layers are released.
      for (const backdrop of [confirm.closest(".task-editor-backdrop"), workspace.closest(".kan-modal-backdrop")]) {
        expect(backdrop).toHaveAttribute("data-state", "closing");
        fireEvent.transitionEnd(backdrop);
      }
      expect(confirm).not.toBeInTheDocument();
      expect(workspace).not.toBeInTheDocument();
      await act(async () => { vi.advanceTimersToNextFrame(); });
      expect(fallbackButton).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it("unmounts both delete surfaces and restores focus when transitionend never arrives", async () => {
    vi.useFakeTimers();
    try {
      const props = renderTasks();
      const [fallbackButton] = screen.getAllByRole("button", { name: "New task" });
      const taskCard = screen.getByRole("button", { name: "Translate bargaining pulse" });
      taskCard.focus();
      const workspace = openCard("Translate bargaining pulse");
      const confirm = pressDeletePill();

      await act(async () => { fireEvent.click(within(confirm).getByRole("button", { name: "Remove it" })); });
      expect(props.onDeleteTask).toHaveBeenCalledWith("task-demo-2");
      expect(confirm.closest(".task-editor-backdrop")).toHaveAttribute("data-state", "closing");
      expect(workspace.closest(".kan-modal-backdrop")).toHaveAttribute("data-state", "closing");

      // Let the exit fallback timers fire without delivering any transition event.
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(confirm).not.toBeInTheDocument();
      expect(workspace).not.toBeInTheDocument();
      await act(async () => { vi.advanceTimersToNextFrame(); });
      expect(fallbackButton).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the board when the soft delete fails", async () => {
    renderTasks({ onDeleteTask: vi.fn().mockRejectedValue(new Error("network")) });
    openCard("Translate bargaining pulse");
    pressDeletePill();
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The task could not be deleted. It was restored."));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    // The workspace stays open after the failed RPC so the member does not lose
    // their editing context. Close it before asserting the restored board card:
    // the board is intentionally inert while the modal owns interaction.
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close task editor" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Translate bargaining pulse" })).toBeInTheDocument());
  });

  it("restores the latest realtime row when it changes while confirm is open", async () => {
    const props = renderTasks({ onDeleteTask: vi.fn().mockRejectedValue(new Error("network")) });
    openCard("Translate bargaining pulse");
    pressDeletePill();

    const nextData = structuredClone(fallbackData);
    const nextTask = nextData.tasks.find((task) => task.id === "task-demo-2");
    nextTask.title = "Translate the updated bargaining pulse";
    props.rerenderData(nextData);

    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    await waitFor(() => expect(props.onDeleteTask).toHaveBeenCalledWith("task-demo-2"));
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("The task could not be deleted. It was restored."));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close task editor" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Translate the updated bargaining pulse" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Translate bargaining pulse" })).not.toBeInTheDocument();
  });

  it("does not resurrect a row removed remotely while confirm is open", async () => {
    const props = renderTasks();
    openCard("Translate bargaining pulse");
    pressDeletePill();

    const nextData = structuredClone(fallbackData);
    nextData.tasks = nextData.tasks.filter((task) => task.id !== "task-demo-2");
    props.rerenderData(nextData);

    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(props.onDeleteTask).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Translate bargaining pulse" })).not.toBeInTheDocument();
  });

  it("keeps the workspace open until a slow delete settles, then restores it on failure", async () => {
    let rejectDelete;
    const onDeleteTask = vi.fn(() => new Promise((_resolve, reject) => { rejectDelete = reject; }));
    renderTasks({ onDeleteTask });
    const workspace = openCard("Translate bargaining pulse");
    pressDeletePill();
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    await waitFor(() => expect(onDeleteTask).toHaveBeenCalledWith("task-demo-2"));
    await waitFor(() => expect(workspace.closest(".kan-modal-backdrop")).toHaveAttribute("data-state", "open"));
    expect(workspace).toHaveAttribute("aria-busy", "true");
    expect(workspace.querySelector(".kan-modal__contents")).toHaveAttribute("inert");
    expect(within(workspace).getByDisplayValue("Translate bargaining pulse")).toBeInTheDocument();
    // Unavailable while the delete settles, but still focusable (#8435).
    expect(within(workspace).getByRole("button", { name: "Delete task", hidden: true })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(within(workspace).getByRole("button", { name: "Close task editor", hidden: true }));
    expect(workspace.closest(".kan-modal-backdrop")).toHaveAttribute("data-state", "open");

    await act(async () => { rejectDelete(new Error("slow network")); });
    await waitFor(() => expect(within(workspace).getByRole("alert")).toHaveTextContent("The task could not be deleted. It was restored."));
    expect(workspace.closest(".kan-modal-backdrop")).toHaveAttribute("data-state", "open");
    expect(workspace).not.toHaveAttribute("aria-busy");
    expect(workspace.querySelector(".kan-modal__contents")).not.toHaveAttribute("inert");
  });
});

describe("who is offered the pill at all", () => {
  it("hides it from someone who neither opened the task nor holds a role — no false RLS story", () => {
    // task-demo-5: created by Jordan (44…), assigned to the member. They can
    // see and work the card; they cannot remove someone else's task, and the
    // old RLS refusal surfaced as "could not be deleted… restored", which is a
    // false explanation of an unstated rule.
    renderTasks();
    const dialog = openCard("Review chapter newsletter");
    expect(within(dialog).queryByRole("button", { name: "Delete task" })).not.toBeInTheDocument();
  });

  it("shows it to a staff role on someone else's task", () => {
    const data = structuredClone(fallbackData);
    data.roles = ["coordinator"];
    renderTasks({ data });
    const dialog = openCard("Review chapter newsletter");
    expect(within(dialog).getByRole("button", { name: "Delete task" })).toBeInTheDocument();
  });
});

describe("the app-level Undo toast (demo path — same wiring as live)", () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
    global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
  });

  it("soft-deletes with a recoverable toast whose Undo puts the task back", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    fireEvent.change(screen.getByRole("combobox", { name: "Switch role" }), { target: { value: "coordinator" } });
    await act(async () => { await import("../src/views/CoordinatorView.jsx"); });
    expect(await screen.findByRole("heading", { level: 1, name: "Issue queue" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Campaign duty" }));
    fireEvent.click(await screen.findByRole("button", { name: "Translate bargaining pulse" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Translate bargaining pulse" })).not.toBeInTheDocument());
    await waitFor(() => expect(document.querySelector(".task-editor-backdrop")).toBeNull());
    await waitFor(() => expect(document.querySelector(".kan-modal-backdrop")).toBeNull());
    const toast = document.querySelector(".toast");
    expect(toast).toHaveTextContent("Removed from the board. The conversation is kept. Undo is offered briefly right after removal.");

    // App budgets the restore's focus hand-off in wall-clock milliseconds: the
    // card may take focus back off the board's "New task" fallback only if the
    // undo settles quickly. On a loaded runner it does not, focus is refused
    // outright, and this case fails for a reason that has nothing to do with
    // the wiring it exists to prove. Hold the clock still across the undo so it
    // measures the behaviour instead of the runner's speed.
    const heldClock = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(heldClock);
    try {
      fireEvent.click(within(toast).getByRole("button", { name: "Undo" }));
      const restored = await screen.findByRole("button", { name: "Translate bargaining pulse" });
      await waitFor(() => expect(restored.closest("[data-task-id]")).toHaveFocus());
    } finally {
      clock.mockRestore();
    }
  });

  it("BUG-UG-TASK-DELETE-UNDO-TOAST-FOCUS-20260907 restores the real App task after eight seconds", async () => {
    try {
      primeDemoHat("member");
      window.history.replaceState({}, "", "/m?demo=1");
      render(<App />);
      fireEvent.change(screen.getByRole("combobox", { name: "Switch role" }), { target: { value: "coordinator" } });
      await act(async () => { await import("../src/views/CoordinatorView.jsx"); });
      expect(await screen.findByRole("heading", { level: 1, name: "Issue queue" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Campaign duty" }));
      fireEvent.click(await screen.findByRole("button", { name: "Translate bargaining pulse" }));
      fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
      vi.useFakeTimers();
      fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.queryByRole("button", { name: "Translate bargaining pulse" })).not.toBeInTheDocument();
      const toast = document.querySelector(".toast");
      const undo = within(toast).getByRole("button", { name: "Undo", hidden: true });
      act(() => undo.focus());
      act(() => vi.advanceTimersByTime(8_000));

      expect(toast).toBeInTheDocument();
      expect(undo).toHaveFocus();
      await act(async () => {
        fireEvent.click(undo);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      const restored = screen.getByRole("button", { name: "Translate bargaining pulse" });
      act(() => vi.runOnlyPendingTimers());
      expect(restored.closest("[data-task-id]")).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not move focus when another control is active before an async restore settles", () => {
    const restored = document.createElement("article");
    restored.tabIndex = 0;
    const nextControl = document.createElement("button");
    document.body.append(restored, nextControl);
    nextControl.focus();

    focusWhenAvailable(() => restored);

    expect(nextControl).toHaveFocus();
    restored.remove();
    nextControl.remove();
  });

  it("allows only the first board fallback to yield focus during the modal-close window", () => {
    const board = document.createElement("section");
    board.className = "kan-board";
    const firstFallback = document.createElement("button");
    firstFallback.className = "kan-newtask";
    const otherFallback = document.createElement("button");
    otherFallback.className = "kan-newtask";
    const restored = document.createElement("article");
    restored.tabIndex = 0;
    board.append(firstFallback, otherFallback, restored);
    document.body.append(board);

    firstFallback.focus();
    focusWhenAvailable(() => restored, undefined, {
      allowActive: (active) => active === document.querySelector(".kan-board button.kan-newtask"),
    });
    expect(restored).toHaveFocus();

    otherFallback.focus();
    focusWhenAvailable(() => restored, undefined, {
      allowActive: (active) => active === document.querySelector(".kan-board button.kan-newtask"),
    });
    expect(otherFallback).toHaveFocus();
    board.remove();
  });
});
