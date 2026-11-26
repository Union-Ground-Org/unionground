import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_POLL_VOTE_RELOAD_MAX_MS, LIVE_POLL_VOTE_RELOAD_MS, MemberEngagement } from "../src/features/engagement/MemberEngagement.jsx";
import { engagementApi } from "../src/features/engagement/api.js";

const BURST_SIZE = 5;
const RENDERED_POLL_ID = "open";
const ABSENT_POLL_ID = "other-org-poll";
const ORGANIZATION_ID = "00000000-0000-4000-a000-000000000001";
const OTHER_ORGANIZATION_ID = "00000000-0000-4000-a000-0000000000ff";
const NEWLY_VISIBLE_POLL_ID = "just-scheduled";

function memberSnapshot() {
  return {
    quarterlyGate: { required: false, completed: true },
    pulsePrompts: [],
    livePolls: [
      {
        id: RENDERED_POLL_ID,
        title: "Open vote",
        state: "open",
        eligibility: "organization",
        voteCount: 4,
        options: [{ id: "yes", label: "Approve" }],
        results: [],
        attendance: {},
      },
    ],
    surveys: [],
    actions: [],
    workspace: { moduleOrder: ["inbox"], hiddenModules: [] },
  };
}

function capturingClient() {
  const subscription = { id: "subscription" };
  let changeHandler = null;
  const on = vi.fn((_event, _filter, handler) => {
    changeHandler = handler;
    return { subscribe: vi.fn(() => subscription) };
  });
  return {
    client: {
      channel: vi.fn(() => ({ on })),
      removeChannel: vi.fn(),
    },
    emit(row) {
      if (!changeHandler) throw new Error("live-poll channel handler was not subscribed");
      changeHandler({ new: row });
    },
  };
}

beforeEach(() => {
  vi.spyOn(engagementApi, "evaluatePulse").mockResolvedValue(null);
  vi.spyOn(engagementApi, "heartbeat").mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("member engagement live-poll vote fanout", () => {
  it("collapses a same-tick burst into one snapshot reload and ignores an absent poll", async () => {
    const { client, emit } = capturingClient();
    const loadMember = vi.spyOn(engagementApi, "loadMember").mockResolvedValue(memberSnapshot());
    const view = render(<MemberEngagement client={client} organizationId={ORGANIZATION_ID} />);

    expect(await screen.findByTestId("member-engagement")).toBeInTheDocument();
    await waitFor(() => expect(loadMember.mock.calls.length).toBeGreaterThanOrEqual(2));
    loadMember.mockClear();

    vi.useFakeTimers();
    for (let index = 0; index < BURST_SIZE; index += 1) {
      emit({ id: RENDERED_POLL_ID, vote_count: 4 + index });
    }
    expect(loadMember).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VOTE_RELOAD_MS);
    expect(loadMember).toHaveBeenCalledTimes(1);

    emit({ id: ABSENT_POLL_ID, organization_id: OTHER_ORGANIZATION_ID, state: "open", vote_count: 99 });
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VOTE_RELOAD_MS);
    expect(loadMember).toHaveBeenCalledTimes(1);

    emit({ id: RENDERED_POLL_ID, vote_count: 20 });
    view.unmount();
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VOTE_RELOAD_MS);
    expect(loadMember).toHaveBeenCalledTimes(1);
  });

  it("reloads when a poll of this organization becomes newly visible off screen", async () => {
    const { client, emit } = capturingClient();
    const loadMember = vi.spyOn(engagementApi, "loadMember").mockResolvedValue(memberSnapshot());
    render(<MemberEngagement client={client} organizationId={ORGANIZATION_ID} />);

    expect(await screen.findByTestId("member-engagement")).toBeInTheDocument();
    await waitFor(() => expect(loadMember.mock.calls.length).toBeGreaterThanOrEqual(2));
    loadMember.mockClear();

    vi.useFakeTimers();
    emit({ id: NEWLY_VISIBLE_POLL_ID, organization_id: ORGANIZATION_ID, state: "scheduled", vote_count: 0 });
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VOTE_RELOAD_MS);
    expect(loadMember).toHaveBeenCalledTimes(1);

    emit({ id: "still-a-draft", organization_id: ORGANIZATION_ID, state: "draft", vote_count: 0 });
    await vi.advanceTimersByTimeAsync(LIVE_POLL_VOTE_RELOAD_MS);
    expect(loadMember).toHaveBeenCalledTimes(1);
  });

  it("still refreshes on a bounded cadence while voting never goes quiet", async () => {
    const { client, emit } = capturingClient();
    const loadMember = vi.spyOn(engagementApi, "loadMember").mockResolvedValue(memberSnapshot());
    render(<MemberEngagement client={client} organizationId={ORGANIZATION_ID} />);

    expect(await screen.findByTestId("member-engagement")).toBeInTheDocument();
    await waitFor(() => expect(loadMember.mock.calls.length).toBeGreaterThanOrEqual(2));
    loadMember.mockClear();

    vi.useFakeTimers();
    const step = LIVE_POLL_VOTE_RELOAD_MS - 10;
    for (let elapsed = 0; elapsed < LIVE_POLL_VOTE_RELOAD_MAX_MS; elapsed += step) {
      emit({ id: RENDERED_POLL_ID, organization_id: ORGANIZATION_ID, state: "open", vote_count: elapsed });
      await vi.advanceTimersByTimeAsync(step);
    }
    expect(loadMember).toHaveBeenCalledTimes(1);
  });
});
