import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DemoVoiceMember } from "../src/components/DemoVoiceMember.jsx";
import {
  createDemoVoiceState,
  writeDemoVoiceState,
} from "./fixtures/retired-pre-bot/src/lib/demoVoiceParity.js";

function insights() {
  return document.querySelector(".voice-demo-personal-insights");
}

function tile(label) {
  return within(insights()).getByText(label).closest("div");
}

function completeQuarterly({ workload, staffing = "yes", priorities }) {
  fireEvent.click(screen.getByRole("button", { name: "Continue survey" }));

  const workloadSection = screen.getByRole("region", { name: "Workload" });
  fireEvent.click(within(workloadSection).getByLabelText(String(workload)));
  fireEvent.click(
    within(workloadSection).getByLabelText(
      staffing === "no" ? "No" : staffing === "sometimes" ? "Sometimes" : "Yes",
    ),
  );
  if (staffing === "no") {
    fireEvent.change(
      within(workloadSection).getByLabelText(
        /^What would make staffing safer\? \*/u,
      ),
      { target: { value: "Add a second person on closing shift." } },
    );
  }
  fireEvent.click(
    within(workloadSection).getByRole("button", { name: "Save and continue" }),
  );

  const prioritiesSection = screen.getByRole("region", { name: "Priorities" });
  for (const label of priorities) {
    fireEvent.click(within(prioritiesSection).getByLabelText(label));
  }
  fireEvent.click(
    within(prioritiesSection).getByRole("button", {
      name: "Save and continue",
    }),
  );

  const followUp = screen.getByRole("region", { name: "Follow-up" });
  fireEvent.click(within(followUp).getByLabelText("Yes"));
  fireEvent.click(
    within(followUp).getByRole("button", { name: "Submit check-in" }),
  );
}

describe("SAMPLE member Voice quarterly insights", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("reports the submitted workload score and one chosen priority", () => {
    render(<DemoVoiceMember />);
    completeQuarterly({
      workload: 1,
      staffing: "no",
      priorities: ["Staffing"],
    });

    expect(
      screen.getByText(/personal insights are unlocked/i),
    ).toBeInTheDocument();
    expect(within(insights()).getByText("1/5")).toBeInTheDocument();
    expect(within(tile("priorities shared")).getByText("1")).toBeInTheDocument();
    expect(screen.queryByText("3.8/5")).toBeNull();
    expect(within(tile("priorities shared")).queryByText("2")).toBeNull();
  });

  it("tracks a later check-in of 5/5 and three priorities", () => {
    render(<DemoVoiceMember />);
    completeQuarterly({
      workload: 5,
      priorities: ["Staffing", "Scheduling", "Pay"],
    });

    expect(within(insights()).getByText("5/5")).toBeInTheDocument();
    expect(within(tile("priorities shared")).getByText("3")).toBeInTheDocument();
    expect(screen.queryByText("3.8/5")).toBeNull();
    expect(within(tile("workplace log balance")).queryByText("1/5")).toBeNull();
  });

  it("renders the private unavailable dash when the workload answer is missing", () => {
    const seeded = createDemoVoiceState();
    seeded.quarterly = {
      ...seeded.quarterly,
      completed: true,
      submittedAt: "2026-09-21T16:00:00.000-04:00",
      answers: {
        staffing: "yes",
        priorities: ["staffing"],
        "follow-up": "yes",
      },
    };
    writeDemoVoiceState(seeded);

    render(<DemoVoiceMember />);

    expect(insights()).not.toBeNull();
    expect(within(tile("workplace log balance")).getByText("\u2014")).toBeInTheDocument();
    expect(within(tile("priorities shared")).getByText("1")).toBeInTheDocument();
    expect(screen.queryByText("3.8/5")).toBeNull();
    expect(insights().textContent).not.toMatch(/NaN/);
    expect(insights().textContent).not.toMatch(/undefined\/5/);
  });
});
