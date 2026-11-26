import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { primeDemoHat } from "./helpers/demoHat.js";

beforeEach(() => {
  window.history.replaceState({}, "", "/m?demo=1");
  window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

async function renderTaskDemo() {
  primeDemoHat("coordinator");
  render(<App />);
  fireEvent.change(await screen.findByRole("combobox", { name: "Switch role" }), { target: { value: "coordinator" } });
  expect(await screen.findByRole("heading", { level: 1, name: "Issue queue" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Campaign duty" }));
}

async function clickReadyFlowButton(name) {
  // The step's text can render before the preceding update clears its busy
  // state. fireEvent silently ignores clicks on a still-disabled button.
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

describe("specialized task template demo twin", () => {
  it("keeps the reviewer picker separate from the ordinary campaign-worker roster", async () => {
    await renderTaskDemo();
    fireEvent.click(await screen.findByRole("button", { name: "Use a template" }));
    fireEvent.click(screen.getByRole("button", { name: /Review or Approval/i }));
    const reviewer = screen.getByLabelText("Reviewer");
    for (const person of fallbackData.taskTemplateReviewers) {
      expect(reviewer).toHaveTextContent(person.fullName);
    }
    for (const person of fallbackData.taskAssignees) {
      expect(reviewer).not.toHaveTextContent(person.fullName);
    }
  });

  it("creates a typed task, moves flow alone, then moves flow with the catalog status", async () => {
    await renderTaskDemo();
    fireEvent.click(await screen.findByRole("button", { name: "Use a template" }));
    fireEvent.click(screen.getByRole("button", { name: /Worker follow-up/i }));
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Schedule a safe follow-up" } });
    fireEvent.change(screen.getByLabelText("Contact method"), { target: { value: "phone" } });
    fireEvent.change(screen.getByLabelText("Follow-up date"), { target: { value: "2026-08-20" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    expect(await screen.findByLabelText("Task title")).toHaveValue("Schedule a safe follow-up");
    expect(screen.getByText("Current step: Prepare")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "To do" })).toBeInTheDocument();

    await clickReadyFlowButton("Move to Contact");
    await clickReadyFlowButton("Move flow only");
    expect(await screen.findByText("Current step: Contact")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "To do" })).toBeInTheDocument();

    await clickReadyFlowButton("Move to Await response");
    await clickReadyFlowButton("Move flow and status");
    expect(await screen.findByText("Current step: Await response")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "In progress" })).toBeInTheDocument());

    expect(fallbackData.tasks.some((task) => task.title === "Schedule a safe follow-up")).toBe(false);
  });
});
