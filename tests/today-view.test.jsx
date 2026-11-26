import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { TodayView } from "../src/views/TodayView.jsx";

const data = {
  member: {
    firstName: "Darnell",
    fullName: "Darnell Foster",
    initials: "DF",
    roleLine: "Worker · Harborview Care committee",
    notificationCount: 2,
  },
  metrics: { openCases: 3, resolvedCases: 1 },
  planItems: [
    { id: "lesson-1", kind: "lesson", title: "Section 7 · Know Your Organizing Rights", meta: "Supervisor questions", action: "Start" },
  ],
};

describe("organizing Today", () => {
  it("shows the campaign next action instead of a member-since line", () => {
    const onOpenCampaign = vi.fn();
    render(
      <LanguageProvider lang="en">
        <TodayView
          data={data}
          campaign={{
            name: "Harborview Care United",
            stage: "cards",
            nextAction: "Talk with two evening-shift coworkers.",
            nextActionDue: "2026-07-24",
            eligibleEstimate: 100,
            contactedCount: 62,
          }}
          onPlanAction={() => {}}
          onOpenCampaign={onOpenCampaign}
        />
      </LanguageProvider>,
    );
    expect(screen.getByRole("heading", { name: "Harborview Care United" })).toBeInTheDocument();
    expect(screen.getByText("Talk with two evening-shift coworkers.")).toBeInTheDocument();
    expect(screen.getByText("Open issues")).toBeInTheDocument();
    expect(screen.getByText(/Stage · Cards/i)).toBeInTheDocument();
    expect(screen.queryByText(/certification/i)).toBeNull();
    expect(screen.queryByText("2026-07-24")).toBeNull();
    expect(screen.queryByText(/Member since/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Harborview Care United/ }));
    expect(onOpenCampaign).toHaveBeenCalledOnce();
  });
});
