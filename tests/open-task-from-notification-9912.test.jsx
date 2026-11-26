import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { primeDemoData } from "../src/data/demoData.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { primeDemoHat } from "./helpers/demoHat.js";

// BUG-UG-WEB-OPEN-TASK-FROM-NOTIFICATION-AND-CLEARED-TASK-TITLE-FAIL-SILENTLY-20261125
// (#9912, W2-6 of #9463): Open task on a notification whose task is in another
// chapter closed the list and said nothing. The fixture is fictional.
const OTHER_CHAPTER_TASK = {
  id: "task-tamarack-other-chapter", title: "Tamarack follow-up", description: "", status: "todo", priority: "normal",
  chapterId: "tamarack-other", assigneeId: null, dueDate: null, createdAt: "2026-07-21T13:00:00Z", updatedAt: "2026-07-21T13:00:00Z",
};

beforeEach(() => {
  window.history.replaceState({}, "", "/m/steward?demo=1");
  window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
  primeDemoHat("steward");
  primeDemoData({
    ...fallbackData,
    tasks: [...(fallbackData.tasks || []), OTHER_CHAPTER_TASK],
    taskAttachments: [...(fallbackData.taskAttachments || []), { id: "att-tamarack", taskId: OTHER_CHAPTER_TASK.id, sourceKind: "notification", sourceId: "n1" }],
  });
});

afterEach(() => {
  primeDemoData(fallbackData);
});

describe("open a task from the notifications list (#9912)", () => {
  it("says the task is no longer available when it is in another chapter", async () => {
    render(<App />);
    const bell = (await screen.findAllByRole("button", { name: /^Notifications, \d+ unread$/ }, { timeout: 8_000 }))[0];
    fireEvent.click(bell);
    const dialog = await screen.findByRole("dialog", { name: "Notifications" });
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Create task" })[0]);
    fireEvent.click(await within(dialog).findByRole("button", { name: "Open task" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull());
    expect(await screen.findByText("The linked task is no longer available.")).toBeInTheDocument();
  });
});
