// REQ-UG-WEEKLY-QUESTION-PRIORITY-AND-WEIGHTED-DRAW-20261001 and
// REQ-UG-LIVE-POLL-SCHEDULED-OPEN-CLOSE-20261001: the staff controls say
// what the server will do — the selection rule, the priority slot, the draw
// seed, and whether a scheduled poll opens and closes on its own.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaffEngagement } from "../src/features/engagement/StaffEngagement.jsx";
import { catalogue } from "../src/lib/i18n.js";

afterEach(cleanup);

const AUTO = "features.engagement_voice.live_poll_auto_open_close";
const scheduledPoll = {
  id: "poll-scheduled", title: "Contract vote", state: "scheduled", voteCount: 0,
  opensAt: "2026-10-05T14:00:00Z", closesAt: "2026-10-05T16:00:00Z", attendance: {}, results: [],
};

function client({ switches = {}, weekly = {}, configError = null } = {}) {
  return {
    rpc: vi.fn(async (name) => {
      if (name === "get_staff_engagement_snapshot") return { data: { surveys: [], livePolls: [scheduledPoll], pulsePrompts: [], channels: [], members: [], presence: { online: 0 }, delivery: {} }, error: null };
      if (name === "get_member_organization_configuration") return configError ? { data: null, error: configError } : { data: { switches }, error: null };
      if (name === "get_weekly_question_selection_workspace") return { data: { policy: {}, items: [], ...weekly }, error: null };
      return { data: {}, error: null };
    }),
  };
}

describe("live poll schedule line", () => {
  it("states when a scheduled poll opens and closes on its own", async () => {
    render(<StaffEngagement client={client({ switches: { [AUTO]: true } })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Live polls" }));
    expect(await screen.findByText(/Opens automatically .* Closes automatically/)).toBeInTheDocument();
  });

  it("says the poll is manual when the organization turned scheduling off", async () => {
    render(<StaffEngagement client={client({ switches: { [AUTO]: false } })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Live polls" }));
    expect(await screen.findByText(catalogue.en["engagement.pollScheduleManual"])).toBeInTheDocument();
    expect(screen.queryByText(/Opens automatically/)).toBeNull();
  });

  it("keeps the registered default (on) when the configuration cannot be read", async () => {
    render(<StaffEngagement client={client({ configError: { code: "42501", message: "denied" } })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Live polls" }));
    expect(await screen.findByText(/Opens automatically/)).toBeInTheDocument();
  });
});

describe("weekly selection rule and priority slot", () => {
  it("shows the priority slot state and the recorded draw seed", async () => {
    render(<StaffEngagement client={client({ weekly: {
      prioritySlot: false,
      policy: { enabled: true, priority_rule: "weighted_random", last_result: { selectedCount: 1, poolCount: 4, rule: "weighted_random", seed: "seed-1234" } },
    } })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Weekly pool" }));
    expect(await screen.findByText(/Draw seed seed-1234/)).toBeInTheDocument();
    expect(screen.getByText(catalogue.en["engagement.prioritySlotOff"])).toBeInTheDocument();
    expect(screen.getByLabelText("Selection rule")).toHaveValue("weighted_random");
  });

  it("loads a saved support ranking and explains it", async () => {
    render(<StaffEngagement client={client({ weekly: { prioritySlot: true, policy: { enabled: true, priority_rule: "support_then_oldest" } } })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Weekly pool" }));
    expect(await screen.findByLabelText("Selection rule")).toHaveValue("support_then_oldest");
    expect(screen.getByText(catalogue.en["engagement.priorityHelp"])).toBeInTheDocument();
    expect(screen.getByText(catalogue.en["engagement.prioritySlotOn"])).toBeInTheDocument();
  });
});
