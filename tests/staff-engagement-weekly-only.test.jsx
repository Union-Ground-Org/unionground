// UX-UG-CHAPTER-SCOPED-STEWARD-COORDINATOR-HATS-OPEN-CAMPAIGNS-ENGAGEMENT-THEN-EVERY-STAFF-RPC-20260921
//
// A chapter-only steward is refused the organization-wide staff snapshot
// (42501) but may run its own chapter's weekly selection.
// Campaigns -> Engagement then shows only the Weekly pool tab instead of the
// "not authorized" alert.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaffEngagement } from "../src/features/engagement/StaffEngagement.jsx";
import { engagementApi } from "../src/features/engagement/api.js";
import { MemberApiError } from "../src/lib/memberApi.js";

const refused = () => new MemberApiError("Engagement operations", { code: "42501", message: "not authorized" });
const workspace = {
  organizationId: "00000000-0000-4000-a000-000000000001",
  chapterId: "wor",
  policy: { enabled: false, cadence_days: 7, minimum_pool_size: 3, selection_count: 1, priority_rule: "support_then_oldest" },
  items: [{ id: "q-1", body: "Worcester weekly prompt", options: ["Yes", "No"], editorialState: "submitted", score: 0 }],
  nextCursor: null,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("staff engagement for a chapter-only steward", () => {
  it("shows only the weekly pool when the snapshot is refused but the weekly workspace loads", async () => {
    vi.spyOn(engagementApi, "loadStaff").mockRejectedValue(refused());
    vi.spyOn(engagementApi, "loadWeeklySelection").mockResolvedValue(workspace);
    vi.spyOn(engagementApi, "loadWeeklySelectionPage").mockResolvedValue({ items: [], nextCursor: null });
    render(<StaffEngagement client={{ rpc: vi.fn() }} />);

    expect(await screen.findByTestId("staff-engagement")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Weekly pool" })).toHaveAttribute("aria-pressed", "true");
    for (const name of ["Surveys", "Live polls", "Channels"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(await screen.findByText("Worcester weekly prompt")).toBeInTheDocument();
    expect(screen.queryByText(/not authorized/i)).not.toBeInTheDocument();
  });

  it("keeps the refusal when the weekly workspace is refused too", async () => {
    vi.spyOn(engagementApi, "loadStaff").mockRejectedValue(refused());
    vi.spyOn(engagementApi, "loadWeeklySelection").mockRejectedValue(refused());
    render(<StaffEngagement client={{ rpc: vi.fn() }} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Engagement operations are unavailable.");
    expect(screen.queryByTestId("staff-engagement")).not.toBeInTheDocument();
  });

  it("does not probe the weekly workspace for other snapshot failures", async () => {
    vi.spyOn(engagementApi, "loadStaff").mockRejectedValue(new MemberApiError("Engagement operations", { code: "57014", message: "canceling statement" }));
    const weekly = vi.spyOn(engagementApi, "loadWeeklySelection");
    render(<StaffEngagement client={{ rpc: vi.fn() }} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Engagement operations are unavailable.");
    expect(weekly).not.toHaveBeenCalled();
  });
});
