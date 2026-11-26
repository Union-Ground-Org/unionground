import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_POLL_VOTE_RELOAD_MS, MemberEngagement, SCHEDULED_POLL_REFRESH_MS } from "../src/features/engagement/MemberEngagement.jsx";
import { StaffEngagement } from "../src/features/engagement/StaffEngagement.jsx";
import { engagementApi } from "../src/features/engagement/api.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

function liveClient() {
  const subscription = { id: "subscription" };
  const listeners = [];
  return {
    channel: vi.fn(() => ({
      on: vi.fn((...args) => {
        const handler = args.find((arg) => typeof arg === "function");
        if (handler) listeners.push(handler);
        return { subscribe: vi.fn(() => subscription) };
      }),
    })),
    removeChannel: vi.fn(),
    // The member view coalesces realtime rows for LIVE_POLL_VOTE_RELOAD_MS before
    // it reloads, so the returned promise settles after that window.
    emitLivePollUpdate(row) {
      for (const listener of listeners) listener({ new: row });
      return new Promise((resolve) => { globalThis.setTimeout(resolve, LIVE_POLL_VOTE_RELOAD_MS + 5); });
    },
  };
}

function memberSnapshot() {
  return {
    quarterlyGate: { required: true, completed: false, title: "Quarterly check-in" },
    pulsePrompts: [
      { eventId: "pulse-1", question: "Did this help?", options: ["Yes", { value: "no", label: "No" }] },
      { eventId: "pulse-2", question: "Was this clear?", options: ["Clear"] },
    ],
    livePolls: [
      { id: "scheduled", title: "Scheduled vote", state: "scheduled", eligibility: "organization", voteCount: 0, description: "Upcoming", options: [], results: [], attendance: {} },
      { id: "checkin", title: "Roster vote", state: "open", eligibility: "roster", voteCount: 0, options: [], results: [], attendance: { eligible: true } },
      { id: "open", title: "Open vote", state: "open", eligibility: "roster", voteCount: 4, options: [{ id: "yes", label: "Approve" }, { id: "no", label: "Decline" }], selectedOptionId: "no", results: [{ optionId: "yes", label: "Approve", votes: 3 }], attendance: { eligible: true, checkedInAt: "2026-08-28T00:00:00Z" } },
    ],
    surveys: [
      {
        id: "survey-open", title: "Quarterly voice", description: "Tell us what is working.", cadence: "quarterly", periodKey: "2026-Q3", session: { answers: {} },
        questions: [
          { id: "short", type: "text", label: "Short answer", required: true, sectionKey: "main", sectionTitle: "Basics" },
          { id: "long", type: "paragraph", label: "Long answer", sectionKey: "main" },
          { id: "scale", type: "scale", label: "Rating", options: [{ value: 1, label: "Low" }, { value: 5, label: "High" }], sectionKey: "main" },
          { id: "checks", type: "checkbox", label: "Priorities", options: [{ value: "pay", label: "Pay" }, "Safety"], sectionKey: "main" },
          { id: "branch", type: "radio", label: "Follow up?", options: ["Yes", "No"], sectionKey: "main" },
          { id: "details", type: "paragraph", label: "Follow-up details", branchParentId: "branch", branchValue: "Yes", sectionKey: "follow", sectionTitle: "Follow up" },
        ],
      },
      { id: "survey-done", title: "Completed survey", cadence: "one_off", session: { status: "submitted", answers: {} }, questions: [] },
    ],
    actions: [
      { id: "action-confirm", title: "Follow up with member", sourceKind: "message" },
      { id: "action-reject", title: "Review survey note", sourceKind: "survey" },
    ],
    workspace: { moduleOrder: ["inbox", "surveys"], hiddenModules: ["surveys"] },
  };
}

function staffSnapshot() {
  const basePoll = { voteCount: 2, attendance: { roster: 5, rsvpYes: 3, checkedIn: 2 }, results: [{ optionId: "yes", label: "Yes", votes: 2 }] };
  return {
    presence: { online: 7 },
    delivery: { queued: 2, leased: 1, sent: 5, failed: 1, suppressed: 1 },
    members: [{ id: "member-1", name: "Alex Rivera" }],
    surveys: [
      { id: "draft", title: "Draft survey", description: "Draft", cadence: "quarterly", periodKey: "2026-Q3", status: "draft", privacyMinResponses: 3, questions: [{ id: "q", type: "paragraph", label: "Existing prompt", required: true, options: [], sectionKey: "main", sectionTitle: "Main" }] },
      { id: "open", title: "Open survey", cadence: "one_off", status: "open", coverage: { total: 10, sent: 9, engaged: 5, failed: 1 }, tasks: [{ id: "task", reason: "low_response", status: "open" }], reviews: [{ id: "review", sessionId: "session-1", state: "unreviewed", followUpDueAt: "2026-09-01T00:00:00Z" }] },
      { id: "closed", title: "Closed survey", cadence: "one_off", status: "closed", tasks: [], reviews: [] },
    ],
    livePolls: [
      { ...basePoll, id: "poll-draft", title: "Draft poll", state: "draft" },
      { ...basePoll, id: "poll-scheduled", title: "Scheduled poll", state: "scheduled" },
      { ...basePoll, id: "poll-open", title: "Open poll", state: "open" },
      { ...basePoll, id: "poll-closed", title: "Closed poll", state: "closed" },
    ],
    pulsePrompts: [{ id: "prompt", eventKey: "case.updated", question: "Need help?", active: true, responded: 2, shown: 3, cooldownHours: 168 }],
    channels: [{ spaceId: "space", name: "Chapter room", postingMode: "members", slowModeSeconds: 0, approvalsRequired: false }],
  };
}

function mockApi(methods) {
  for (const method of methods) vi.spyOn(engagementApi, method).mockResolvedValue({ id: `${method}-id`, state: "confirmed" });
}

beforeEach(() => {
  mockApi([
    "saveSurveySession", "submitSurveySession", "respondPulse", "rsvpLivePoll", "checkInLivePoll", "castLivePollVote",
    "heartbeat", "decideAction", "saveWorkspace", "saveSurveyDraft", "publishSurvey", "configureSurvey",
    "prepareDistribution", "queueReminders", "closeSurvey", "reopenSurvey", "updateSurveyTask", "updateSurveyReview", "exportSurvey",
    "saveLivePoll", "setLivePollRoster", "transitionLivePoll", "savePulsePrompt", "setChannelControls",
  ]);
  vi.spyOn(engagementApi, "evaluatePulse").mockResolvedValue(null);
  vi.spyOn(engagementApi, "loadSurveyDraft").mockImplementation(async (_client, surveyId) => (
    staffSnapshot().surveys.find((survey) => survey.id === surveyId)
  ));
  vi.spyOn(engagementApi, "loadSurveyReview").mockResolvedValue({ sessionId: "session-1", answers: [{ questionId: "q", label: "Existing prompt", type: "paragraph", value: "Short-staffed on nights" }] });
  vi.spyOn(engagementApi, "loadSurveyReport").mockResolvedValue({ available: true, questions: [{ id: "report-q", label: "Workload", answered: 4, distribution: [{ value: "manageable", count: 3 }] }] });
  global.fetch = vi.fn(async (url) => url === "/api/engagement-delivery?status=1"
    ? { ok: true, json: async () => ({ configured: true }) }
    : { ok: true, json: async () => ({ draft: { title: "Compass poll", description: "Drafted", options: [{ label: "Yes" }, { label: "No" }] } }) });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("member engagement", () => {
  // BUG-UG-OPEN-SURVEY-UNREACHABLE-FROM-HOME-AND-PHONE-20261111 (gate
  // r1s1 on #8260): every accepted write here tells the shell, which drops its
  // cached snapshot so Home stops offering an answered survey.
  it("tells the shell after an accepted write and not after a refused one", async () => {
    const client = liveClient();
    const onSnapshotChanged = vi.fn();
    vi.spyOn(engagementApi, "loadMember").mockResolvedValue(memberSnapshot());
    render(<MemberEngagement client={client} organizationId="00000000-0000-4000-a000-000000000001" onSnapshotChanged={onSnapshotChanged} />);
    expect(await screen.findByTestId("member-engagement")).toBeInTheDocument();
    expect(onSnapshotChanged).not.toHaveBeenCalled();
    engagementApi.respondPulse.mockRejectedValueOnce(new Error("refused"));
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(engagementApi.respondPulse).toHaveBeenCalledTimes(1));
    expect(onSnapshotChanged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(onSnapshotChanged).toHaveBeenCalledTimes(1));
  });

  it("completes surveys, prompts, live polls, and Guide decisions", async () => {
    const client = liveClient();
    const announce = vi.fn();
    vi.spyOn(engagementApi, "loadMember").mockResolvedValue(memberSnapshot());
    const view = render(<MemberEngagement client={client} organizationId="00000000-0000-4000-a000-000000000001" onNotice={announce} />);
    expect(await screen.findByTestId("member-engagement")).toBeInTheDocument();
    expect(screen.getByText("Your response is complete.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(engagementApi.respondPulse).toHaveBeenCalledWith(client, "pulse-1", "Yes", false));
    const clearPrompt = screen.getByRole("heading", { name: "Was this clear?" }).closest("article");
    fireEvent.click(within(clearPrompt).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(engagementApi.respondPulse).toHaveBeenCalledWith(client, "pulse-2", null, true));

    const survey = screen.getByRole("heading", { name: "Quarterly voice" }).closest("form");
    fireEvent.change(within(survey).getByLabelText(/Short answer/), { target: { value: "Short" } });
    fireEvent.change(within(survey).getByLabelText("Long answer"), { target: { value: "Long" } });
    fireEvent.click(within(survey).getByLabelText("High"));
    fireEvent.click(within(survey).getByLabelText("Pay"));
    fireEvent.click(within(survey).getByLabelText("Safety"));
    fireEvent.click(within(survey).getByLabelText("Safety"));
    fireEvent.click(within(survey).getByLabelText("Yes"));
    fireEvent.click(within(survey).getByRole("button", { name: "Save and continue" }));
    expect(await within(survey).findByLabelText("Follow-up details")).toBeInTheDocument();
    fireEvent.click(within(survey).getByRole("button", { name: "Back" }));
    fireEvent.click(within(survey).getByRole("button", { name: "Save and continue" }));
    fireEvent.change(await within(survey).findByLabelText("Follow-up details"), { target: { value: "More context" } });
    fireEvent.click(within(survey).getByRole("button", { name: "Save for later" }));
    await waitFor(() => expect(engagementApi.saveSurveySession).toHaveBeenCalled());
    fireEvent.submit(survey);
    await waitFor(() => expect(engagementApi.submitSurveySession).toHaveBeenCalledWith(client, "survey-open", expect.objectContaining({ details: "More context" })));

    fireEvent.click(screen.getByRole("button", { name: "I’m going" }));
    fireEvent.click(screen.getByRole("button", { name: "Check in to vote" }));
    const openPoll = screen.getByRole("heading", { name: "Open vote" }).closest("article");
    fireEvent.click(within(openPoll).getByLabelText("Approve"));
    await waitFor(() => expect(engagementApi.castLivePollVote).toHaveBeenCalledWith(client, "open", "yes"));

    const confirm = screen.getByText("Follow up with member").closest("article");
    fireEvent.click(within(confirm).getByRole("button", { name: "Create task" }));
    const reject = screen.getByText("Review survey note").closest("article");
    fireEvent.click(within(reject).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("button", { name: "Mark reviewed" })).not.toBeInTheDocument();
    const details = screen.getByText("Customize Guide home").closest("details");
    fireEvent.click(within(details).getByLabelText("Surveys"));
    fireEvent.click(within(details).getByRole("button", { name: "Save workspace" }));
    await waitFor(() => expect(engagementApi.saveWorkspace).toHaveBeenCalled());

    view.unmount();
    expect(client.removeChannel).toHaveBeenCalled();
    expect(engagementApi.heartbeat).toHaveBeenCalledWith(client, "offline");
    expect(announce).toHaveBeenCalled();
  });

  it("renders null without a client and supports load recovery", async () => {
    const { container, rerender } = render(<MemberEngagement client={null} />);
    expect(container).toBeEmptyDOMElement();
    const client = liveClient();
    engagementApi.evaluatePulse.mockRejectedValueOnce(new Error("pulse unavailable"));
    vi.spyOn(engagementApi, "loadMember")
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValue(memberSnapshot());
    rerender(<MemberEngagement client={client} organizationId="00000000-0000-4000-a000-000000000001" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Worker engagement is unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("member-engagement")).toBeInTheDocument();
  });

  it("shows catalogue copy in the selected language, never the raw backend message, when loading fails", async () => {
    const client = liveClient();
    vi.spyOn(engagementApi, "loadMember").mockRejectedValue(new Error("permission denied for function get_member_engagement"));
    render(
      <LanguageProvider lang="es">
        <MemberEngagement client={client} organizationId="00000000-0000-4000-a000-000000000001" />
      </LanguageProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(catalogue.es["engagement.memberUnavailable"]);
    expect(screen.queryByText(/permission denied/)).not.toBeInTheDocument();
  });

  it("omits check-in and vote options when a roster poll has no staff-granted eligibility", async () => {
    const snapshot = memberSnapshot();
    snapshot.livePolls = [{
      id: "unrostered",
      title: "Unrostered vote",
      state: "open",
      eligibility: "roster",
      voteCount: 0,
      options: [{ id: "yes", label: "Approve" }],
      results: [],
      attendance: { eligible: false, rsvp: "yes" },
      canCheckIn: false,
    }];
    vi.spyOn(engagementApi, "loadMember").mockResolvedValue(snapshot);
    render(<MemberEngagement client={liveClient()} organizationId="00000000-0000-4000-a000-000000000001" />);
    expect(await screen.findByRole("heading", { name: "Unrostered vote" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check in to vote" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Approve")).not.toBeInTheDocument();
  });

  // #9470 (W5-18): the same card says why there is nothing to press, in both languages.
  it.each([["en"], ["es"]])("tells a member off a roster poll's roster why it has no choices (%s)", async (lang) => {
    const snapshot = memberSnapshot();
    snapshot.livePolls = [{ id: "unrostered", title: "Unrostered vote", state: "open", eligibility: "roster", voteCount: 0,
      options: [{ id: "yes", label: "Approve" }], results: [], attendance: null, canCheckIn: false }];
    vi.spyOn(engagementApi, "loadMember").mockResolvedValue(snapshot);
    render(<LanguageProvider lang={lang}><MemberEngagement client={liveClient()} organizationId="00000000-0000-4000-a000-000000000001" /></LanguageProvider>);
    const card = (await screen.findByRole("heading", { name: "Unrostered vote" })).closest("article");
    expect(within(card).getByRole("status")).toHaveTextContent(catalogue[lang]["engagement.member.notOnRoster"]);
    expect(catalogue[lang]["engagement.member.notOnRoster"]).toMatch(/\S/);
  });

  it("does not say a member is off the roster when the poll has not said where they stand", async () => {
    const snapshot = memberSnapshot();
    snapshot.livePolls = [{ id: "unknown", title: "Roster not read", state: "open", eligibility: "roster", voteCount: 0,
      options: [{ id: "yes", label: "Approve" }], results: [] }];
    vi.spyOn(engagementApi, "loadMember").mockResolvedValue(snapshot);
    render(<MemberEngagement client={liveClient()} organizationId="00000000-0000-4000-a000-000000000001" />);
    const card = (await screen.findByRole("heading", { name: "Roster not read" })).closest("article");
    expect(within(card).queryByRole("status")).toBeNull();
  });

  it("keeps a newly provisioned empty-tenant account out of organization engagement RPCs", async () => {
    const client = liveClient();
    const loadMember = vi.spyOn(engagementApi, "loadMember");
    render(<MemberEngagement client={client} organizationId={null} />);

    expect(await screen.findByTestId("member-engagement-empty")).toHaveTextContent("connected to an organization");
    expect(loadMember).not.toHaveBeenCalled();
    expect(engagementApi.evaluatePulse).not.toHaveBeenCalled();
    expect(engagementApi.heartbeat).not.toHaveBeenCalled();
    expect(client.channel).not.toHaveBeenCalled();
  });

  it("renders numeric vote counts from the server votes key, including zero", async () => {
    const client = liveClient();
    const snapshot = memberSnapshot();
    snapshot.livePolls = [{
      id: "tallied",
      title: "Tallied vote",
      state: "open",
      eligibility: "organization",
      voteCount: 3,
      options: [{ id: "yes", label: "Approve" }, { id: "no", label: "Decline" }],
      selectedOptionId: "yes",
      results: [
        { optionId: "yes", label: "Approve", votes: 3 },
        { optionId: "no", label: "Decline", votes: 0 },
      ],
      attendance: {},
    }];
    vi.spyOn(engagementApi, "loadMember").mockResolvedValue(snapshot);
    render(<MemberEngagement client={client} organizationId="00000000-0000-4000-a000-000000000001" />);
    const results = await screen.findByLabelText("Poll results");
    expect(within(results).getByText("Approve").closest("div")).toHaveTextContent("3");
    expect(within(results).getByText("Decline").closest("div")).toHaveTextContent("0");
  });

  it("opens a scheduled after_close poll without a realtime payload, then stops background fetching", async () => {
    vi.useFakeTimers();
    const client = liveClient();
    const scheduledPoll = {
      id: "after-close",
      title: "After-close vote",
      state: "scheduled",
      resultsVisibility: "after_close",
      eligibility: "organization",
      voteCount: 0,
      description: "Opens soon",
      options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
      results: [],
      attendance: {},
      opensAt: "2026-09-21T16:00:00.000Z",
      scheduledAt: "2026-09-21T15:50:00.000Z",
    };
    const openPoll = { ...scheduledPoll, state: "open" };
    const emptyWorkspace = { quarterlyGate: {}, pulsePrompts: [], surveys: [], actions: [], workspace: {} };
    let releaseOpen = false;
    const loadMember = vi.spyOn(engagementApi, "loadMember").mockImplementation(async () => (
      releaseOpen
        ? { ...emptyWorkspace, livePolls: [openPoll] }
        : { ...emptyWorkspace, livePolls: [scheduledPoll] }
    ));
    const clearInterval = vi.spyOn(globalThis, "clearInterval");

    try {
      const view = render(<MemberEngagement client={client} organizationId="00000000-0000-4000-a000-000000000001" />);
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByTestId("member-engagement")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "I’m going" })).toBeInTheDocument();
      expect(screen.queryByLabelText("Yes")).not.toBeInTheDocument();
      const callsAfterMount = loadMember.mock.calls.length;
      expect(client.channel).toHaveBeenCalled();

      releaseOpen = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_POLL_REFRESH_MS); });
      expect(loadMember.mock.calls.length).toBeGreaterThan(callsAfterMount);
      expect(screen.getByLabelText("Yes")).not.toHaveAttribute("aria-disabled");
      expect(screen.queryByRole("button", { name: "I’m going" })).not.toBeInTheDocument();

      const callsAfterOpen = loadMember.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_POLL_REFRESH_MS * 3); });
      expect(loadMember.mock.calls.length).toBe(callsAfterOpen);

      const heartbeatsAfterOpen = engagementApi.heartbeat.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(engagementApi.heartbeat.mock.calls.length).toBeGreaterThan(heartbeatsAfterOpen);

      view.unmount();
      expect(client.removeChannel).toHaveBeenCalled();
      expect(clearInterval).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps refreshing an open staff_only poll until the snapshot shows it closed", async () => {
    vi.useFakeTimers();
    const client = liveClient();
    const scheduledPoll = {
      id: "staff-only",
      title: "Staff-only vote",
      state: "scheduled",
      resultsVisibility: "staff_only",
      eligibility: "organization",
      voteCount: 0,
      options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
      results: [],
      attendance: {},
    };
    const openPoll = { ...scheduledPoll, state: "open" };
    const closedPoll = { ...scheduledPoll, state: "closed" };
    const emptyWorkspace = { quarterlyGate: {}, pulsePrompts: [], surveys: [], actions: [], workspace: {} };
    let phase = "scheduled";
    const loadMember = vi.spyOn(engagementApi, "loadMember").mockImplementation(async () => ({
      ...emptyWorkspace,
      livePolls: [phase === "scheduled" ? scheduledPoll : phase === "open" ? openPoll : closedPoll],
    }));

    try {
      const view = render(<MemberEngagement client={client} organizationId="00000000-0000-4000-a000-000000000001" />);
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByRole("button", { name: "I’m going" })).toBeInTheDocument();

      phase = "open";
      await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_POLL_REFRESH_MS); });
      expect(screen.getByLabelText("Yes")).not.toHaveAttribute("aria-disabled");

      const callsWhileOpen = loadMember.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_POLL_REFRESH_MS); });
      expect(loadMember.mock.calls.length).toBeGreaterThan(callsWhileOpen);

      phase = "closed";
      await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_POLL_REFRESH_MS); });
      expect(screen.queryByLabelText("Yes")).not.toBeInTheDocument();
      expect(screen.getByText("closed")).toBeInTheDocument();

      const callsAfterClosed = loadMember.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_POLL_REFRESH_MS * 3); });
      expect(loadMember.mock.calls.length).toBe(callsAfterClosed);

      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs a trailing snapshot refresh when a live-poll update arrives during an in-flight load", async () => {
    const client = liveClient();
    engagementApi.evaluatePulse.mockReturnValue(new Promise(() => {}));
    const emptyWorkspace = { quarterlyGate: {}, pulsePrompts: [], surveys: [], actions: [], workspace: {} };
    const poll = (voteCount) => ({
      id: "open-live",
      title: "Open live vote",
      state: "open",
      resultsVisibility: "live",
      eligibility: "organization",
      voteCount,
      options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
      results: [{ optionId: "yes", label: "Yes", votes: voteCount }],
      attendance: {},
    });
    const pending = [];
    vi.spyOn(engagementApi, "loadMember").mockImplementation(() => new Promise((resolve) => {
      pending.push(resolve);
    }));

    render(<MemberEngagement client={client} organizationId="00000000-0000-4000-a000-000000000001" />);
    await act(async () => { await Promise.resolve(); });
    expect(pending).toHaveLength(1);

    await act(async () => {
      pending.shift()({ ...emptyWorkspace, livePolls: [poll(1)] });
      await Promise.resolve();
    });
    expect(screen.getByText("1 votes")).toBeInTheDocument();
    expect(pending).toHaveLength(0);

    await act(async () => {
      await client.emitLivePollUpdate({ id: "open-live", state: "open", vote_count: 2 });
    });
    expect(pending).toHaveLength(1);

    await act(async () => {
      await client.emitLivePollUpdate({ id: "open-live", state: "open", vote_count: 3 });
    });
    expect(pending).toHaveLength(1);

    await act(async () => {
      pending.shift()({ ...emptyWorkspace, livePolls: [poll(2)] });
      await Promise.resolve();
    });
    expect(screen.getByText("2 votes")).toBeInTheDocument();
    expect(pending).toHaveLength(1);

    await act(async () => {
      pending.shift()({ ...emptyWorkspace, livePolls: [poll(3)] });
      await Promise.resolve();
    });
    expect(screen.getByText("3 votes")).toBeInTheDocument();
    expect(pending).toHaveLength(0);
  });

  it("loads the new client instead of applying the previous client's in-flight snapshot", async () => {
    const clientA = liveClient();
    const clientB = liveClient();
    engagementApi.evaluatePulse.mockReturnValue(new Promise(() => {}));
    const emptyWorkspace = { quarterlyGate: {}, pulsePrompts: [], surveys: [], actions: [], workspace: {} };
    const pollFor = (title) => ({
      id: title,
      title,
      state: "open",
      resultsVisibility: "live",
      eligibility: "organization",
      voteCount: 1,
      options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
      results: [],
      attendance: {},
    });
    const pending = [];
    vi.spyOn(engagementApi, "loadMember").mockImplementation((requestClient) => new Promise((resolve) => {
      pending.push({ client: requestClient, resolve });
    }));

    const { rerender } = render(<MemberEngagement client={clientA} organizationId="00000000-0000-4000-a000-000000000001" />);
    await act(async () => { await Promise.resolve(); });
    expect(pending).toHaveLength(1);
    expect(pending[0].client).toBe(clientA);

    rerender(<MemberEngagement client={clientB} organizationId="00000000-0000-4000-a000-000000000001" />);
    await act(async () => { await Promise.resolve(); });
    expect(pending.at(-1).client).toBe(clientB);

    await act(async () => {
      pending[0].resolve({ ...emptyWorkspace, livePolls: [pollFor("Client A poll")] });
      await Promise.resolve();
    });
    expect(screen.queryByText("Client A poll")).not.toBeInTheDocument();

    await act(async () => {
      pending.at(-1).resolve({ ...emptyWorkspace, livePolls: [pollFor("Client B poll")] });
      await Promise.resolve();
    });
    expect(screen.getByText("Client B poll")).toBeInTheDocument();
  });

  it("clears vote busy after the in-flight snapshot even when later updates stay queued", async () => {
    const client = liveClient();
    engagementApi.evaluatePulse.mockReturnValue(new Promise(() => {}));
    const emptyWorkspace = { quarterlyGate: {}, pulsePrompts: [], surveys: [], actions: [], workspace: {} };
    const poll = (voteCount, selected = "no") => ({
      id: "open-live",
      title: "Open live vote",
      state: "open",
      resultsVisibility: "live",
      eligibility: "organization",
      voteCount,
      options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
      selectedOptionId: selected,
      results: [{ optionId: "yes", label: "Yes", votes: voteCount }],
      attendance: {},
    });
    const pending = [];
    vi.spyOn(engagementApi, "loadMember").mockImplementation(() => new Promise((resolve) => {
      pending.push(resolve);
    }));

    render(<MemberEngagement client={client} organizationId="00000000-0000-4000-a000-000000000001" />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      pending.shift()({ ...emptyWorkspace, livePolls: [poll(1)] });
      await Promise.resolve();
    });
    fireEvent.click(screen.getByLabelText("Yes"));
    await act(async () => { await Promise.resolve(); });
    expect(pending).toHaveLength(1);
    expect(screen.getByLabelText("Yes")).toHaveAttribute("aria-disabled", "true");
    // A held vote control refuses activation, not only reads as unavailable (tooling
    // ledgers 336 and 344: "Yes" is the unselected option, so the click would vote).
    { const votes = engagementApi.castLivePollVote.mock.calls.length; fireEvent.click(screen.getByLabelText("Yes")); expect(engagementApi.castLivePollVote).toHaveBeenCalledTimes(votes); }

    await act(async () => {
      await client.emitLivePollUpdate({ id: "open-live", state: "open", vote_count: 2 });
    });
    expect(pending).toHaveLength(1);

    await act(async () => {
      pending.shift()({ ...emptyWorkspace, livePolls: [poll(2, "yes")] });
      await Promise.resolve();
    });
    expect(screen.getByLabelText("Yes")).not.toHaveAttribute("aria-disabled");
    expect(pending).toHaveLength(1);

    await act(async () => {
      await client.emitLivePollUpdate({ id: "open-live", state: "open", vote_count: 3 });
    });
    expect(screen.getByLabelText("Yes")).not.toHaveAttribute("aria-disabled");

    await act(async () => {
      pending.shift()({ ...emptyWorkspace, livePolls: [poll(3, "yes")] });
      await Promise.resolve();
    });
    expect(screen.getByLabelText("Yes")).not.toHaveAttribute("aria-disabled");
    expect(screen.getByText("3 votes")).toBeInTheDocument();
  });

  it("keeps the cached engagement screen when a scheduled-poll refresh fails", async () => {
    vi.useFakeTimers();
    const client = liveClient();
    engagementApi.evaluatePulse.mockReturnValue(new Promise(() => {}));
    const scheduledPoll = {
      id: "after-close",
      title: "After-close vote",
      state: "scheduled",
      resultsVisibility: "after_close",
      eligibility: "organization",
      voteCount: 0,
      options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
      results: [],
      attendance: {},
    };
    const emptyWorkspace = { quarterlyGate: {}, pulsePrompts: [], surveys: [], actions: [], workspace: {} };
    let failNext = false;
    vi.spyOn(engagementApi, "loadMember").mockImplementation(async () => {
      if (failNext) throw new Error("snapshot timeout");
      return { ...emptyWorkspace, livePolls: [scheduledPoll], surveys: [memberSnapshot().surveys[0]] };
    });

    try {
      render(<MemberEngagement client={client} organizationId="00000000-0000-4000-a000-000000000001" />);
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByTestId("member-engagement")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "I’m going" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Quarterly voice" })).toBeInTheDocument();

      failNext = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_POLL_REFRESH_MS); });
      expect(screen.getByTestId("member-engagement")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "I’m going" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Quarterly voice" })).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("Worker engagement is unavailable.");
      expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a vote error after a later snapshot refresh succeeds", async () => {
    const client = liveClient();
    engagementApi.evaluatePulse.mockReturnValue(new Promise(() => {}));
    const emptyWorkspace = { quarterlyGate: {}, pulsePrompts: [], surveys: [], actions: [], workspace: {} };
    const poll = {
      id: "open-live",
      title: "Open live vote",
      state: "open",
      resultsVisibility: "live",
      eligibility: "organization",
      voteCount: 1,
      options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
      selectedOptionId: "no",
      results: [{ optionId: "yes", label: "Yes", votes: 1 }],
      attendance: {},
    };
    const pending = [];
    vi.spyOn(engagementApi, "loadMember").mockImplementation(() => new Promise((resolve) => {
      pending.push(resolve);
    }));
    vi.spyOn(engagementApi, "castLivePollVote").mockRejectedValue(new Error("vote rejected"));

    render(<MemberEngagement client={client} organizationId="00000000-0000-4000-a000-000000000001" />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      pending.shift()({ ...emptyWorkspace, livePolls: [poll] });
      await Promise.resolve();
    });

    await act(async () => {
      await client.emitLivePollUpdate({ id: "open-live", state: "open", vote_count: 2 });
    });
    expect(pending).toHaveLength(1);

    fireEvent.click(screen.getByLabelText("Yes"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Poll could not be updated.");

    await act(async () => {
      pending.shift()({ ...emptyWorkspace, livePolls: [{ ...poll, voteCount: 2 }] });
      await Promise.resolve();
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Poll could not be updated.");
    expect(screen.queryByText(/vote rejected/)).not.toBeInTheDocument();
    expect(screen.getByTestId("member-engagement")).toBeInTheDocument();
    expect(screen.getByLabelText("Yes")).not.toHaveAttribute("aria-disabled");
  });

  it("keeps vote busy until a snapshot that starts after the vote settles", async () => {
    const client = liveClient();
    engagementApi.evaluatePulse.mockReturnValue(new Promise(() => {}));
    const emptyWorkspace = { quarterlyGate: {}, pulsePrompts: [], surveys: [], actions: [], workspace: {} };
    const poll = (voteCount, selected = "no") => ({
      id: "open-live",
      title: "Open live vote",
      state: "open",
      resultsVisibility: "live",
      eligibility: "organization",
      voteCount,
      options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
      selectedOptionId: selected,
      results: [{ optionId: "yes", label: "Yes", votes: voteCount }],
      attendance: {},
    });
    const pending = [];
    vi.spyOn(engagementApi, "loadMember").mockImplementation(() => new Promise((resolve) => {
      pending.push(resolve);
    }));

    render(<MemberEngagement client={client} organizationId="00000000-0000-4000-a000-000000000001" />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      pending.shift()({ ...emptyWorkspace, livePolls: [poll(1)] });
      await Promise.resolve();
    });

    await act(async () => {
      await client.emitLivePollUpdate({ id: "open-live", state: "open", vote_count: 2 });
    });
    expect(pending).toHaveLength(1);

    fireEvent.click(screen.getByLabelText("Yes"));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByLabelText("Yes")).toHaveAttribute("aria-disabled", "true");
    // A held vote control refuses activation, not only reads as unavailable (tooling
    // ledgers 336 and 344: "Yes" is the unselected option, so the click would vote).
    { const votes = engagementApi.castLivePollVote.mock.calls.length; fireEvent.click(screen.getByLabelText("Yes")); expect(engagementApi.castLivePollVote).toHaveBeenCalledTimes(votes); }
    expect(pending).toHaveLength(1);

    await act(async () => {
      pending.shift()({ ...emptyWorkspace, livePolls: [poll(2, "no")] });
      await Promise.resolve();
    });
    expect(screen.getByLabelText("Yes")).toHaveAttribute("aria-disabled", "true");
    expect(pending).toHaveLength(1);

    await act(async () => {
      pending.shift()({ ...emptyWorkspace, livePolls: [poll(3, "yes")] });
      await Promise.resolve();
    });
    expect(screen.getByLabelText("Yes")).not.toHaveAttribute("aria-disabled");
    expect(screen.getByText("3 votes")).toBeInTheDocument();
    expect(pending).toHaveLength(0);
  });

  it("keeps a vote error when an in-flight snapshot refresh then fails", async () => {
    const client = liveClient();
    engagementApi.evaluatePulse.mockReturnValue(new Promise(() => {}));
    const emptyWorkspace = { quarterlyGate: {}, pulsePrompts: [], surveys: [], actions: [], workspace: {} };
    const poll = { id: "open-live", title: "Open live vote", state: "open", resultsVisibility: "live", eligibility: "organization", voteCount: 1, options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }], selectedOptionId: "no", results: [], attendance: {} };
    const pending = [];
    vi.spyOn(engagementApi, "loadMember").mockImplementation(() => new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
    }));
    vi.spyOn(engagementApi, "castLivePollVote").mockRejectedValue(new Error("vote rejected"));

    render(<MemberEngagement client={client} organizationId="00000000-0000-4000-a000-000000000001" />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      pending.shift().resolve({ ...emptyWorkspace, livePolls: [poll] });
      await Promise.resolve();
    });

    await act(async () => {
      await client.emitLivePollUpdate({ id: "open-live", state: "open", vote_count: 2 });
    });
    expect(pending).toHaveLength(1);

    fireEvent.click(screen.getByLabelText("Yes"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Poll could not be updated.");

    await act(async () => {
      pending.shift().reject(new Error("snapshot unavailable"));
      await Promise.resolve();
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Poll could not be updated.");
    expect(screen.queryByText(/vote rejected/)).not.toBeInTheDocument();
  });

  it("reloads when the organization changes on the same client", async () => {
    const client = liveClient();
    engagementApi.evaluatePulse.mockReturnValue(new Promise(() => {}));
    const emptyWorkspace = { quarterlyGate: {}, pulsePrompts: [], surveys: [], actions: [], workspace: {} };
    const pollFor = (title) => ({ id: title, title, state: "open", resultsVisibility: "live", eligibility: "organization", voteCount: 1, options: [{ id: "yes", label: "Yes" }], results: [], attendance: {} });
    const pending = [];
    vi.spyOn(engagementApi, "loadMember").mockImplementation(() => new Promise((resolve) => {
      pending.push(resolve);
    }));

    const { rerender } = render(<MemberEngagement client={client} organizationId="00000000-0000-4000-a000-000000000001" />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      pending.shift()({ ...emptyWorkspace, livePolls: [pollFor("Org A poll")] });
      await Promise.resolve();
    });
    expect(screen.getByText("Org A poll")).toBeInTheDocument();

    rerender(<MemberEngagement client={client} organizationId="00000000-0000-4000-a000-000000000002" />);
    await act(async () => { await Promise.resolve(); });
    expect(pending).toHaveLength(1);
    expect(screen.queryByText("Org A poll")).not.toBeInTheDocument();

    await act(async () => {
      pending.shift()({ ...emptyWorkspace, livePolls: [pollFor("Org B poll")] });
      await Promise.resolve();
    });
    expect(screen.getByText("Org B poll")).toBeInTheDocument();
  });

  it("ignores a post-write refresh from the previous client", async () => {
    const clientA = liveClient();
    const clientB = liveClient();
    engagementApi.evaluatePulse.mockReturnValue(new Promise(() => {}));
    const emptyWorkspace = { quarterlyGate: {}, pulsePrompts: [], surveys: [], actions: [], workspace: {} };
    const pollFor = (title) => ({ id: title, title, state: "open", resultsVisibility: "live", eligibility: "organization", voteCount: 1, options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }], selectedOptionId: "no", results: [], attendance: {} });
    const pending = [];
    vi.spyOn(engagementApi, "loadMember").mockImplementation((requestClient) => new Promise((resolve) => {
      pending.push({ client: requestClient, resolve });
    }));
    let finishVote;
    vi.spyOn(engagementApi, "castLivePollVote").mockImplementation(() => new Promise((resolve) => { finishVote = resolve; }));

    const { rerender } = render(<MemberEngagement client={clientA} organizationId="00000000-0000-4000-a000-000000000001" />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      pending.shift().resolve({ ...emptyWorkspace, livePolls: [pollFor("Client A poll")] });
      await Promise.resolve();
    });
    fireEvent.click(screen.getByLabelText("Yes"));
    await act(async () => { await Promise.resolve(); });

    rerender(<MemberEngagement client={clientB} organizationId="00000000-0000-4000-a000-000000000001" />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      pending.shift().resolve({ ...emptyWorkspace, livePolls: [pollFor("Client B poll")] });
      await Promise.resolve();
    });
    expect(screen.getByText("Client B poll")).toBeInTheDocument();

    await act(async () => {
      finishVote({ id: "vote", state: "confirmed" });
      await Promise.resolve();
    });
    expect(pending).toHaveLength(0);
    expect(engagementApi.loadMember.mock.calls.every(([requestClient], index) => index === 0 || requestClient === clientB)).toBe(true);
    expect(screen.getByText("Client B poll")).toBeInTheDocument();
  });
});

// UX-UG-MEMBER-ENGAGEMENT-CHROME-ENGLISH-ONLY-20260920. The Be heard
// surface hard-coded its English chrome while staff engagement and VoiceView
// already read the catalogue, so a member reading the app in Spanish met
// "Your surveys", "Save and continue" and an English "Survey sections"
// aria-label. Author-authored survey titles, question labels and option labels
// stay untranslated data on both sides.
function localizedSnapshot() {
  const snapshot = memberSnapshot();
  const survey = snapshot.surveys[0];
  // Answer the branch up front so both sections — and with them the section
  // stepper and its "Save and continue" control — render on first paint.
  survey.session = { answers: { branch: "Yes" } };
  // Drop the author-supplied period key and gate title so the catalogue's own
  // fallbacks ("Quarterly survey", "Quarterly worker survey") are the ones rendered.
  delete survey.periodKey;
  delete snapshot.quarterlyGate.title;
  // Exercise the section-title fallbacks: no author title on either section.
  for (const question of survey.questions) delete question.sectionTitle;
  survey.questions.find((question) => question.id === "checks").maxSelections = 2;
  survey.questions.push({ id: "pick", type: "dropdown", label: "Preferred shift", options: ["Day", "Night"], sectionKey: "main" });
  survey.questions.push({ id: "yesno", type: "yes_no", label: "Attending?", sectionKey: "main" });
  return snapshot;
}

// Every English chrome literal the record pins, copied from the source with the
// U+2019 apostrophe it uses.
const ENGLISH_CHROME = [
  "Worker voice", "Your surveys", "Meeting room", "Live polls", "Live now", "Quarterly survey",
  "Questions", "Choose an answer", "Choose up to 2.",
  "Save and continue", "Your response is complete.", "Worker survey",
  "Quick check-in", "Not now", "I’m going", "Check in to vote",
  " votes", "Guide workspace", "Ready for your decision", "Create task", "Dismiss",
  "Customize Guide home", "Save workspace", "Quarterly worker survey",
];

// The two English aria-labels the record pins. They never reach textContent,
// so they are checked as attributes on both sides.
const ENGLISH_ARIA_LABELS = ["Survey sections", "Poll results"];

// Rendered only after an action, or only on the last section of a survey, so
// they are checked once the same interactions have revealed them.
const ENGLISH_DEFERRED_CHROME = ["You’re checked in.", "Progress saved.", "Save for later", "Submit survey"];

describe("member engagement in Spanish", () => {
  it("renders the whole Be heard surface from the catalogue, with no English chrome left", async () => {
    const client = liveClient();
    vi.spyOn(engagementApi, "loadMember").mockResolvedValue(localizedSnapshot());
    render(<LanguageProvider lang="es"><MemberEngagement client={client} organizationId="00000000-0000-4000-a000-000000000001" /></LanguageProvider>);
    expect(await screen.findByTestId("member-engagement")).toBeInTheDocument();

    expect(screen.getByRole("heading", { name: "Tus encuestas" })).toBeInTheDocument();
    expect(screen.getByText("Voz de los trabajadores")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Votaciones en vivo" })).toBeInTheDocument();
    expect(screen.getByText("Sala de reunión")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Listo para tu decisión" })).toBeInTheDocument();
    expect(screen.getByText("Espacio de la Guía")).toBeInTheDocument();
    expect(screen.getAllByText("Consulta rápida").length).toBe(2);
    expect(screen.getByText("Tu respuesta está completa.")).toBeInTheDocument();
    expect(screen.getByText("Completa la encuesta de este trimestre para terminar tu registro.")).toBeInTheDocument();

    // Concepts the catalogue already carries render the staff surface's own
    // Spanish, not a second wording for the same idea.
    const survey = screen.getByRole("heading", { name: "Quarterly voice" }).closest("form");
    expect(within(survey).getByText("Elige hasta 2.")).toBeInTheDocument();
    expect(within(survey).getByRole("option", { name: "Elige una respuesta" })).toBeInTheDocument();
    expect(within(survey).getByLabelText("Sí")).toBeInTheDocument();
    expect(screen.getByText("4 votos")).toBeInTheDocument();
    expect(screen.getByText("programada")).toBeInTheDocument();
    expect(screen.getAllByText("En vivo").length).toBe(2);
    expect(screen.getByText("Encuesta trimestral")).toBeInTheDocument();
    expect(screen.getByText("Encuesta para trabajadores")).toBeInTheDocument();
    expect(screen.getByText("Encuesta trimestral para trabajadores")).toBeInTheDocument();

    // Section chrome: the fallback titles, the stepper and its aria-label.
    expect(within(survey).getByLabelText("Secciones de la encuesta")).toHaveTextContent("1 de 2");
    expect(within(survey).getByLabelText("Secciones de la encuesta")).toHaveTextContent("Preguntas");
    expect(screen.getByLabelText("Resultados de la votación")).toBeInTheDocument();
    for (const label of ENGLISH_ARIA_LABELS) {
      expect(document.querySelector(`[aria-label="${label}"]`), label).toBeNull();
    }

    // Compass workspace copy, including the module labels and the action line.
    expect(screen.getByText("La Guía puede crear una tarea vinculada a partir de este elemento autorizado: mensaje.")).toBeInTheDocument();
    const details = screen.getByText("Personaliza el inicio de la Guía").closest("details");
    expect(within(details).getByLabelText("Bandeja")).toBeInTheDocument();
    expect(within(details).getByLabelText("Encuestas")).toBeInTheDocument();

    // Author-authored survey and option text is data, never a catalogue key.
    expect(within(survey).getByText("Tell us what is working.")).toBeInTheDocument();
    expect(within(survey).getByRole("option", { name: "Day" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Did this help?" })).toBeInTheDocument();

    for (const literal of ENGLISH_CHROME) {
      expect(document.body.textContent, literal).not.toContain(literal);
    }
  });

  it("announces saves, RSVPs and check-ins in Spanish", async () => {
    const client = liveClient();
    const announce = vi.fn();
    vi.spyOn(engagementApi, "loadMember").mockResolvedValue(localizedSnapshot());
    render(<LanguageProvider lang="es"><MemberEngagement client={client} organizationId="00000000-0000-4000-a000-000000000001" onNotice={announce} /></LanguageProvider>);
    expect(await screen.findByTestId("member-engagement")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Voy a asistir" }));
    expect(await screen.findByText("Confirmación guardada.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Regístrate para votar" }));
    expect(await screen.findByText("Registro confirmado.")).toBeInTheDocument();
    const openPoll = screen.getByRole("heading", { name: "Open vote" }).closest("article");
    fireEvent.click(within(openPoll).getByLabelText("Approve"));
    expect(await screen.findByText("Voto guardado.")).toBeInTheDocument();

    const survey = screen.getByRole("heading", { name: "Quarterly voice" }).closest("form");
    fireEvent.click(within(survey).getByRole("button", { name: "Guardar y continuar" }));
    expect(await screen.findByText("Progreso guardado.")).toBeInTheDocument();
    expect(within(survey).getByLabelText("Secciones de la encuesta")).toHaveTextContent("Sección 2");
    expect(within(survey).getByRole("button", { name: "Guardar para después" })).toBeInTheDocument();
    expect(within(survey).getByRole("button", { name: "Enviar encuesta" })).toBeInTheDocument();
    for (const literal of ENGLISH_DEFERRED_CHROME) {
      expect(document.body.textContent, literal).not.toContain(literal);
    }
    fireEvent.click(within(survey).getByRole("button", { name: "Atrás" }));
    fireEvent.submit(survey);
    expect(await screen.findByText("Encuesta enviada.")).toBeInTheDocument();

    const reject = screen.getByText("Review survey note").closest("article");
    fireEvent.click(within(reject).getByRole("button", { name: "Descartar" }));
    expect(await screen.findByText("Sugerencia descartada.")).toBeInTheDocument();
    const confirm = screen.getByText("Follow up with member").closest("article");
    fireEvent.click(within(confirm).getByRole("button", { name: "Crear tarea" }));
    expect(await screen.findByText("Tarea creada.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Guardar espacio" }));
    expect(await screen.findByText("Espacio de la Guía guardado.")).toBeInTheDocument();
    expect(announce).toHaveBeenCalledWith("Tarea creada.");
  });

  it("keeps the English wording of that same chrome unchanged", async () => {
    const client = liveClient();
    vi.spyOn(engagementApi, "loadMember").mockResolvedValue(localizedSnapshot());
    render(<LanguageProvider lang="en"><MemberEngagement client={client} organizationId="00000000-0000-4000-a000-000000000001" /></LanguageProvider>);
    expect(await screen.findByTestId("member-engagement")).toBeInTheDocument();
    for (const literal of ENGLISH_CHROME) {
      expect(document.body.textContent, literal).toContain(literal);
    }
    for (const label of ENGLISH_ARIA_LABELS) {
      expect(document.querySelector(`[aria-label="${label}"]`), label).not.toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "Check in to vote" }));
    expect(await screen.findByText("You’re checked in.")).toBeInTheDocument();

    const survey = screen.getByRole("heading", { name: "Quarterly voice" }).closest("form");
    expect(within(survey).getByLabelText("Survey sections")).toHaveTextContent("1 of 2");
    // The second section's fallback title only renders once it is the active one.
    fireEvent.click(within(survey).getByRole("button", { name: "Save and continue" }));
    expect(await within(survey).findByText("Section 2")).toBeInTheDocument();
    expect(await screen.findByText("Progress saved.")).toBeInTheDocument();
    expect(within(survey).getByRole("button", { name: "Save for later" })).toBeInTheDocument();
    expect(within(survey).getByRole("button", { name: "Submit survey" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "I’m going" })).toBeInTheDocument();
  });

  it("localizes the states this surface reaches before a snapshot arrives", async () => {
    const client = liveClient();
    // A refused load paints Main's catalogue line (engagement.memberUnavailable);
    // the pulse evaluation is refused too so its follow-up load does not
    // immediately clear the error under test.
    engagementApi.evaluatePulse.mockRejectedValue(new Error("pulse unavailable"));
    vi.spyOn(engagementApi, "loadMember")
      .mockRejectedValueOnce(Object.assign(new Error(), { message: "" }))
      .mockResolvedValue(localizedSnapshot());
    const { rerender } = render(<LanguageProvider lang="es"><MemberEngagement client={client} organizationId={null} /></LanguageProvider>);
    expect(await screen.findByTestId("member-engagement-empty"))
      .toHaveTextContent("Las encuestas y votaciones en vivo estarán disponibles cuando tu cuenta esté conectada a una organización.");

    rerender(<LanguageProvider lang="es"><MemberEngagement client={client} organizationId="00000000-0000-4000-a000-000000000001" /></LanguageProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent(catalogue.es["engagement.memberUnavailable"]);
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByTestId("member-engagement")).toBeInTheDocument();
  });
});

describe("staff engagement", () => {
  it("runs survey operations and authoring flows", async () => {
    const client = liveClient();
    // A survey action keeps the card's buttons disabled
    // until the snapshot reload after it lands, and a click on a disabled
    // button is lost. On a loaded runner that reload outlasts the write, so
    // here every reload after the first read takes a timer turn, and each next
    // action waits for its button to be usable again before it is clicked.
    vi.spyOn(engagementApi, "loadStaff")
      .mockResolvedValueOnce(staffSnapshot())
      .mockImplementation(() => new Promise((resolve) => { setTimeout(() => resolve(staffSnapshot()), 25); }));
    const clickWhenEnabled = async (name) => {
      const button = await screen.findByRole("button", { name });
      // A pending control stays enabled (record 8435); wait for its busy state to clear.
      await waitFor(() => { expect(button).toBeEnabled(); expect(button).not.toHaveAttribute("aria-disabled"); });
      fireEvent.click(button);
    };
    render(<StaffEngagement client={client} session={{ access_token: "token" }} />);
    expect(await screen.findByTestId("staff-engagement")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Distribute" }));
    await waitFor(() => expect(engagementApi.prepareDistribution).toHaveBeenCalled());
    await clickWhenEnabled("Remind");
    await waitFor(() => expect(engagementApi.queueReminders).toHaveBeenCalled());
    await clickWhenEnabled("Mark done");
    await waitFor(() => expect(engagementApi.updateSurveyTask).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Read response" }));
    fireEvent.change(await screen.findByLabelText("Review state"), { target: { value: "resolved" } });
    await waitFor(() => expect(engagementApi.updateSurveyReview).toHaveBeenCalled());
    await clickWhenEnabled("Report");
    expect(await screen.findByText("Workload")).toBeInTheDocument();
    await clickWhenEnabled("Export JSON");
    await waitFor(() => expect(engagementApi.exportSurvey).toHaveBeenCalled());
    await clickWhenEnabled("Close");
    await waitFor(() => expect(engagementApi.closeSurvey).toHaveBeenCalled());
    await clickWhenEnabled("Reopen");
    await waitFor(() => expect(engagementApi.reopenSurvey).toHaveBeenCalled());

    await clickWhenEnabled("Edit");
    const editor = (await screen.findByRole("heading", { name: "Edit survey" })).closest("form");
    fireEvent.change(within(editor).getByLabelText("Title"), { target: { value: " Updated survey " } });
    fireEvent.change(within(editor).getByLabelText("Cadence"), { target: { value: "one_off" } });
    fireEvent.change(within(editor).getByLabelText("Privacy floor"), { target: { value: "5" } });
    fireEvent.change(within(editor).getByLabelText("Description"), { target: { value: " Updated description " } });
    fireEvent.change(within(editor).getByLabelText("Prompt"), { target: { value: " Updated prompt " } });
    fireEvent.change(within(editor).getByLabelText("Type"), { target: { value: "checkbox" } });
    fireEvent.change(within(editor).getByLabelText("Section title"), { target: { value: "Experience" } });
    fireEvent.change(within(editor).getByLabelText("Options, one per line"), { target: { value: "One\nTwo" } });
    fireEvent.click(within(editor).getByLabelText("Required"));
    fireEvent.click(within(editor).getByRole("button", { name: "Add question" }));
    fireEvent.click(within(editor).getAllByRole("button", { name: "Remove question" })[1]);
    fireEvent.click(within(editor).getByRole("button", { name: "Publish survey" }));
    // BUG-UG-SURVEY-PUBLISH-NON-ATOMIC-20260920: publish is one atomic RPC
    // carrying the operating configuration; there is no second configure call
    // that could strand the survey at status 'open' unconfigured.
    await waitFor(() => expect(engagementApi.publishSurvey).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ id: "draft", title: "Updated survey" }),
      expect.objectContaining({ operationsState: "ready", cadence: "one_off" }),
    ));
    expect(engagementApi.configureSurvey).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "New survey" }));
    const fresh = screen.getByRole("heading", { name: "New survey" }).closest("form");
    fireEvent.change(within(fresh).getByLabelText("Title"), { target: { value: "New survey" } });
    fireEvent.change(within(fresh).getByLabelText("Prompt"), { target: { value: "New question" } });
    fireEvent.submit(fresh);
    await waitFor(() => expect(engagementApi.saveSurveyDraft).toHaveBeenCalled());
  });

  // Mark done is not held by the card's busy state, so it
  // can run beside a Remind that is still saving. The first write to finish
  // must not free the card's other buttons while the other is still running.
  it("keeps the survey card's actions held until every write on it has finished", async () => {
    const client = liveClient();
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue(staffSnapshot());
    let finishReminders;
    engagementApi.queueReminders.mockImplementation(() => new Promise((resolve) => { finishReminders = () => resolve({ state: "confirmed" }); }));
    render(<StaffEngagement client={client} session={{ access_token: "token" }} />);
    // Held = pending (record 8435): aria-disabled, still focusable, refusing activation.
    expect(await screen.findByTestId("staff-engagement")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remind" }));
    await waitFor(() => expect(engagementApi.queueReminders).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Distribute" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(engagementApi.updateSurveyTask).toHaveBeenCalled());
    // Mark done has finished and reloaded; Remind is still saving.
    await waitFor(() => expect(engagementApi.loadStaff.mock.calls.length).toBeGreaterThanOrEqual(2));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("button", { name: "Distribute" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Remind" })).toHaveAttribute("aria-disabled", "true");
    // Held means refused: Distribute sends nothing while Remind runs.
    fireEvent.click(screen.getByRole("button", { name: "Distribute" }));
    expect(engagementApi.prepareDistribution).not.toHaveBeenCalled();
    await act(async () => { finishReminders(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Distribute" })).not.toHaveAttribute("aria-disabled"));
  });

  it("shows a flagged response's answers before the review state can change", async () => {
    const client = liveClient();
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue(staffSnapshot());
    render(<StaffEngagement client={client} session={{ access_token: "token" }} />);
    expect(await screen.findByTestId("staff-engagement")).toBeInTheDocument();

    expect(screen.queryByLabelText("Review state")).toBeNull();
    expect(screen.queryByText("Short-staffed on nights")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Read response" }));
    expect(await screen.findByText("Short-staffed on nights")).toBeInTheDocument();
    expect(engagementApi.loadSurveyReview).toHaveBeenCalledWith(client, "session-1");
    expect(screen.getByLabelText("Review state")).toHaveValue("unreviewed");
    expect(screen.queryByRole("button", { name: "Read response" })).toBeNull();
  });

  it("keeps the review state locked when the flagged response cannot be read", async () => {
    const client = liveClient();
    const onNotice = vi.fn();
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue(staffSnapshot());
    engagementApi.loadSurveyReview.mockRejectedValue(new Error("denied"));
    render(<StaffEngagement client={client} session={{ access_token: "token" }} onNotice={onNotice} />);
    fireEvent.click(await screen.findByRole("button", { name: "Read response" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("The response could not be loaded."));
    expect(screen.queryByLabelText("Review state")).toBeNull();
    expect(engagementApi.updateSurveyReview).not.toHaveBeenCalled();
  });

  // SEC-UG-SURVEY-REVIEW-PRIVACY-FLOOR-20261001: below the privacy floor
  // the server lists no review rows and the lane says it is collecting.
  it("keeps the review lane in collection mode below the privacy floor", async () => {
    const client = liveClient();
    const snapshot = staffSnapshot();
    snapshot.surveys = snapshot.surveys.map((survey) => survey.id === "open"
      ? { ...survey, privacyMinResponses: 3, reviewLane: { state: "collecting", responseCount: 2, privacyMinResponses: 3 }, reviews: [] }
      : survey);
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue(snapshot);
    render(<StaffEngagement client={client} session={{ access_token: "token" }} />);
    expect(await screen.findByText(catalogue.en["engagement.reviewCollecting"]
      .replace("{count}", "2").replaceAll("{minimum}", "3"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Read response" })).toBeNull();
    expect(screen.queryByLabelText("Review state")).toBeNull();
  });

  it("offers no triage when the floor rose before the response was read", async () => {
    const client = liveClient();
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue(staffSnapshot());
    engagementApi.loadSurveyReview.mockResolvedValue({ sessionId: "session-1", state: "collecting", available: false, responseCount: 3, privacyMinResponses: 5, answers: [] });
    render(<StaffEngagement client={client} session={{ access_token: "token" }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Read response" }));
    expect(await screen.findByText(catalogue.en["engagement.reviewCollecting"]
      .replace("{count}", "3").replaceAll("{minimum}", "5"))).toBeInTheDocument();
    expect(screen.queryByLabelText("Review state")).toBeNull();
    expect(engagementApi.updateSurveyReview).not.toHaveBeenCalled();
  });

  // BUG-UG-STAFF-ENGAGEMENT-WITHHELD-TOTALS-20261028: the snapshot
  // returns coverage and attendance as null where it withholds them; they are
  // shown as withheld, never as zero, and measured values stay exact.
  it("shows withheld survey coverage and live-poll attendance as withheld, and measured values as measured", async () => {
    const client = liveClient();
    const snapshot = staffSnapshot();
    const open = snapshot.surveys.find((survey) => survey.id === "open");
    snapshot.surveys = [
      { ...open, id: "withheld", title: "Withheld survey", coverage: null, reviews: [] },
      { ...open, id: "zero", title: "Zero survey", coverage: { total: 0, sent: 0, engaged: 0, failed: 0 }, reviews: [] },
      { ...open, id: "measured", title: "Measured survey", reviews: [] },
    ];
    snapshot.livePolls = [
      { ...snapshot.livePolls[2], id: "poll-withheld", title: "Withheld poll", attendance: null },
      { ...snapshot.livePolls[2], id: "poll-zero", title: "Zero poll", attendance: { roster: 0, rsvpYes: 0, checkedIn: 0 } },
      { ...snapshot.livePolls[2], id: "poll-measured", title: "Measured poll" },
    ];
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue(snapshot);
    render(<StaffEngagement client={client} session={{ access_token: "token" }} />);
    await screen.findByTestId("staff-engagement");
    const card = (title) => screen.getByRole("heading", { name: title }).closest("article");
    const metrics = (title, labels) => labels.map((label) => within(card(title)).queryByText(label)?.parentElement.querySelector("strong")?.textContent ?? null);
    const coverageLabels = ["Audience", "Sent", "Engaged", "Failed"].map((key) => catalogue.en[`engagement.${key.toLowerCase()}`]);

    expect(within(card("Withheld survey")).getByText(catalogue.en["engagement.coverageWithheld"])).toBeInTheDocument();
    expect(metrics("Withheld survey", coverageLabels)).toEqual([null, null, null, null]);
    expect(metrics("Zero survey", coverageLabels)).toEqual(["0", "0", "0", "0"]);
    expect(metrics("Measured survey", coverageLabels)).toEqual(["10", "9", "5", "1"]);
    expect(within(card("Measured survey")).queryByText(catalogue.en["engagement.coverageWithheld"])).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Live polls" }));
    const attendanceLabels = ["roster", "rsvpYes", "checkedIn"].map((key) => catalogue.en[`engagement.${key}`]);
    expect(within(card("Withheld poll")).getByText(catalogue.en["engagement.attendanceWithheld"])).toBeInTheDocument();
    expect(metrics("Withheld poll", attendanceLabels)).toEqual([null, null, null]);
    expect(metrics("Zero poll", attendanceLabels)).toEqual(["0", "0", "0"]);
    expect(metrics("Measured poll", attendanceLabels)).toEqual(["5", "3", "2"]);
    expect(within(card("Measured poll")).queryByText(catalogue.en["engagement.attendanceWithheld"])).toBeNull();
  });

  it("runs live-poll, contextual, delivery, channel, and projector flows", async () => {
    const client = liveClient();
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue(staffSnapshot());
    render(<StaffEngagement client={client} session={{ access_token: "token" }} />);
    await screen.findByTestId("staff-engagement");

    fireEvent.click(screen.getByRole("button", { name: "Live polls" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0]);
    await waitFor(() => expect(engagementApi.transitionLivePoll).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole("button", { name: "Projector view" })[0]);
    const projector = screen.getByRole("dialog", { name: "Draft poll" });
    const projectorClose = within(projector).getByRole("button", { name: "Close" });
    expect(projectorClose).toHaveFocus();
    fireEvent.keyDown(projector, { key: "Tab" });
    expect(projectorClose).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Draft poll" })).not.toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: "Projector view" })[0]).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "New live poll" }));
    const editor = screen.getByRole("heading", { name: "Author a poll" }).closest("form");
    fireEvent.change(within(editor).getByLabelText("Draft with the Guide"), { target: { value: "Meeting choice" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(within(editor).getByLabelText("Question")).toHaveValue("Compass poll"));
    fireEvent.change(within(editor).getByLabelText("Question"), { target: { value: "Final question" } });
    fireEvent.change(within(editor).getByLabelText("Eligibility"), { target: { value: "roster" } });
    fireEvent.change(within(editor).getByLabelText("Context"), { target: { value: "Context" } });
    fireEvent.change(within(editor).getByLabelText("Results"), { target: { value: "live" } });
    fireEvent.change(within(editor).getByLabelText("Starts"), { target: { value: "2026-08-29T10:00" } });
    fireEvent.change(within(editor).getByLabelText("Closes"), { target: { value: "2026-08-29T11:00" } });
    fireEvent.change(within(editor).getByLabelText("Option 1"), { target: { value: "Approve" } });
    fireEvent.click(within(editor).getByLabelText("Alex Rivera"));
    fireEvent.click(within(editor).getByRole("button", { name: "Add option" }));
    fireEvent.change(within(editor).getByLabelText("Option 3"), { target: { value: "Abstain" } });
    fireEvent.submit(editor);
    await waitFor(() => expect(engagementApi.setLivePollRoster).toHaveBeenCalledWith(client, expect.any(String), ["member-1"]));

    fireEvent.click(screen.getByRole("button", { name: "Contextual" }));
    fireEvent.click(screen.getByRole("button", { name: "New prompt" }));
    const prompt = screen.getByRole("heading", { name: "Contextual micro-poll" }).closest("form");
    fireEvent.change(within(prompt).getByLabelText("Where to ask"), { target: { value: "contract.page" } });
    fireEvent.change(within(prompt).getByLabelText("Question"), { target: { value: "Was that useful?" } });
    fireEvent.change(within(prompt).getByLabelText("Options, one per line"), { target: { value: "Yes\nNo\n" } });
    fireEvent.submit(prompt);
    await waitFor(() => expect(engagementApi.savePulsePrompt).toHaveBeenCalledWith(client, expect.objectContaining({ eventKey: "contract.page" })));

    fireEvent.click(screen.getByRole("button", { name: "Delivery" }));
    expect(await screen.findByText("configured")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Channels" }));
    fireEvent.change(screen.getByLabelText("Posting"), { target: { value: "staff_only" } });
    fireEvent.blur(screen.getByLabelText("Slow mode seconds"), { target: { value: "30" } });
    expect(screen.queryByLabelText("My notifications")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Your keyword monitor")).not.toBeInTheDocument();

  });

  it("shows loading, then a retryable failure, on the Delivery tab instead of 'not activated'", async () => {
    const client = liveClient();
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue(staffSnapshot());
    let settle;
    global.fetch = vi.fn(() => new Promise((resolve) => { settle = resolve; }));
    render(<StaffEngagement client={client} session={{ access_token: "token" }} />);
    await screen.findByTestId("staff-engagement");
    fireEvent.click(screen.getByRole("button", { name: "Delivery" }));

    expect(await screen.findByText("Checking email delivery status…")).toBeInTheDocument();
    expect(screen.getByText("checking")).toBeInTheDocument();
    expect(screen.queryByText("not activated")).not.toBeInTheDocument();
    expect(screen.queryByText(/Email activation remains unset/)).not.toBeInTheDocument();

    await act(async () => { settle({ ok: false, json: async () => ({ error: "boom" }) }); });
    expect(await screen.findByText("Email delivery status could not be loaded. Try again in a moment.")).toBeInTheDocument();
    expect(screen.getByText("unavailable")).toBeInTheDocument();
    expect(screen.queryByText("not activated")).not.toBeInTheDocument();
    expect(screen.queryByText(/Email activation remains unset/)).not.toBeInTheDocument();

    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ configured: true }) }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("configured")).toBeInTheDocument();
    expect(screen.getByText(/The provider webhook is active/)).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not refocus the projector close button when its parent rerenders", async () => {
    const client = liveClient();
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue(staffSnapshot());
    const { rerender } = render(<StaffEngagement client={client} session={{ access_token: "token" }} onNotice={vi.fn()} />);
    await screen.findByTestId("staff-engagement");
    fireEvent.click(screen.getByRole("button", { name: "Live polls" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Projector view" })[0]);
    await screen.findByRole("dialog", { name: "Draft poll" });
    const focus = vi.spyOn(HTMLButtonElement.prototype, "focus");

    rerender(<StaffEngagement client={client} session={{ access_token: "token" }} onNotice={vi.fn()} />);

    expect(focus).not.toHaveBeenCalled();
  });

  it("shows translated period-conflict copy when the atomic publish rejects, never a success notice", async () => {
    const client = liveClient();
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue(staffSnapshot());
    const conflict = new Error("Publish survey: quarterly survey period conflict");
    conflict.code = "23505";
    engagementApi.publishSurvey.mockRejectedValue(conflict);
    render(<StaffEngagement client={client} session={{ access_token: "token" }} />);
    await screen.findByTestId("staff-engagement");

    fireEvent.click(screen.getByRole("button", { name: "New survey" }));
    const editor = screen.getByRole("heading", { name: "New survey" }).closest("form");
    fireEvent.change(within(editor).getByLabelText("Title"), { target: { value: "Quarterly pulse" } });
    fireEvent.change(within(editor).getByLabelText("Prompt"), { target: { value: "How are we doing?" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Publish survey" }));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("A quarterly survey already covers");
    expect(notice).not.toHaveTextContent("quarterly survey period conflict");
    expect(screen.queryByText("Survey published and ready for distribution.")).not.toBeInTheDocument();
    expect(engagementApi.configureSurvey).not.toHaveBeenCalled();
  });

  it("shows the Spanish period-conflict copy for a rejected publish", async () => {
    const client = liveClient();
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue(staffSnapshot());
    const conflict = new Error("Publish survey: quarterly survey period conflict");
    conflict.code = "23505";
    engagementApi.publishSurvey.mockRejectedValue(conflict);
    render(<LanguageProvider lang="es"><StaffEngagement client={client} session={{ access_token: "token" }} /></LanguageProvider>);
    await screen.findByTestId("staff-engagement");

    fireEvent.click(screen.getByRole("button", { name: "Nueva encuesta" }));
    const editor = screen.getByRole("heading", { name: "Nueva encuesta" }).closest("form");
    fireEvent.change(within(editor).getByLabelText("Título"), { target: { value: "Pulso trimestral" } });
    fireEvent.change(within(editor).getByLabelText("Enunciado"), { target: { value: "¿Cómo vamos?" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Publicar encuesta" }));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("Ya existe una encuesta trimestral para");
    expect(screen.queryByText("Encuesta publicada y lista para distribuir.")).not.toBeInTheDocument();
  });

  it("ignores a second Save prompt submit while savePulsePrompt is in flight", async () => {
    const client = liveClient();
    let resolveSave;
    engagementApi.savePulsePrompt.mockImplementation(() => new Promise((resolve) => { resolveSave = resolve; }));
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue(staffSnapshot());
    render(<StaffEngagement client={client} session={{ access_token: "token" }} />);
    await screen.findByTestId("staff-engagement");
    fireEvent.click(screen.getByRole("button", { name: "Contextual" }));
    fireEvent.click(screen.getByRole("button", { name: "New prompt" }));
    const prompt = screen.getByRole("heading", { name: "Contextual micro-poll" }).closest("form");
    fireEvent.change(within(prompt).getByLabelText("Question"), { target: { value: "Was that useful?" } });
    const saveButton = within(prompt).getByRole("button", { name: "Save prompt" });
    fireEvent.submit(prompt);
    fireEvent.submit(prompt);
    expect(engagementApi.savePulsePrompt).toHaveBeenCalledTimes(1);
    expect(saveButton).toHaveAttribute("aria-disabled", "true");
    expect(saveButton).toHaveAttribute("aria-busy", "true");
    resolveSave({ id: "prompt-1" });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Contextual micro-poll" })).not.toBeInTheDocument());
  });

  it("renders null without a client and recovers from a staff snapshot failure", async () => {
    const { container, rerender } = render(<StaffEngagement client={null} />);
    expect(container).toBeEmptyDOMElement();
    const client = liveClient();
    vi.spyOn(engagementApi, "loadStaff").mockRejectedValueOnce(new Error("staff unavailable")).mockResolvedValue(staffSnapshot());
    rerender(<StaffEngagement client={client} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Engagement operations are unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("staff-engagement")).toBeInTheDocument();
  });

  it("renders projector vote counts from the server votes key, including zero", async () => {
    const client = liveClient();
    const snapshot = staffSnapshot();
    snapshot.livePolls = [{
      id: "poll-tallied",
      title: "Tallied poll",
      state: "open",
      voteCount: 3,
      attendance: { roster: 5, rsvpYes: 3, checkedIn: 2 },
      results: [
        { optionId: "yes", label: "Yes", votes: 3 },
        { optionId: "no", label: "No", votes: 0 },
      ],
    }];
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue(snapshot);
    render(<StaffEngagement client={client} session={{ access_token: "token" }} />);
    await screen.findByTestId("staff-engagement");
    fireEvent.click(screen.getByRole("button", { name: "Live polls" }));
    fireEvent.click(screen.getByRole("button", { name: "Projector view" }));
    const projector = screen.getByRole("dialog", { name: "Tallied poll" });
    const rows = projector.querySelector(".eng-projector__results");
    expect(within(rows).getByText("Yes").closest("div")).toHaveTextContent("3");
    expect(within(rows).getByText("No").closest("div")).toHaveTextContent("0");
  });

  it("sends chapterId when the Campaign eligibility option is selected", async () => {
    const client = liveClient();
    const snapshot = staffSnapshot();
    snapshot.chapters = [{ id: "wor", name: "Worcester" }];
    snapshot.members = [{ id: "member-1", name: "Alex Rivera", chapterId: "wor" }];
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue(snapshot);
    render(<StaffEngagement client={client} session={{ access_token: "token" }} />);
    await screen.findByTestId("staff-engagement");
    fireEvent.click(screen.getByRole("button", { name: "Live polls" }));
    fireEvent.click(screen.getByRole("button", { name: "New live poll" }));
    const editor = screen.getByRole("heading", { name: "Author a poll" }).closest("form");
    fireEvent.change(within(editor).getByLabelText("Question"), { target: { value: "Chapter vote" } });
    fireEvent.change(within(editor).getByLabelText("Eligibility"), { target: { value: "chapter" } });
    fireEvent.change(within(editor).getByLabelText("Option 1"), { target: { value: "Yes" } });
    fireEvent.change(within(editor).getByLabelText("Option 2"), { target: { value: "No" } });
    expect(within(editor).getByLabelText("Campaign")).toHaveValue("wor");
    expect(within(editor).getByText("This poll will reach Worcester only.")).toBeInTheDocument();
    fireEvent.submit(editor);
    await waitFor(() => expect(engagementApi.saveLivePoll).toHaveBeenCalledWith(client, expect.objectContaining({
      eligibility: "chapter",
      chapterId: "wor",
      title: "Chapter vote",
    })));
  });

  it("offers an organization chapter that has no member whose profile points at it", async () => {
    const client = liveClient();
    const snapshot = staffSnapshot();
    snapshot.chapters = [
      { id: "wor", name: "Worcester" },
      { id: "empty-chapter", name: "New chapter" },
    ];
    snapshot.members = [{ id: "member-1", name: "Alex Rivera", chapterId: "wor" }];
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue(snapshot);
    render(<StaffEngagement client={client} session={{ access_token: "token" }} />);
    await screen.findByTestId("staff-engagement");
    fireEvent.click(screen.getByRole("button", { name: "Live polls" }));
    fireEvent.click(screen.getByRole("button", { name: "New live poll" }));
    const editor = screen.getByRole("heading", { name: "Author a poll" }).closest("form");
    fireEvent.change(within(editor).getByLabelText("Question"), { target: { value: "Empty chapter vote" } });
    fireEvent.change(within(editor).getByLabelText("Eligibility"), { target: { value: "chapter" } });
    fireEvent.change(within(editor).getByLabelText("Option 1"), { target: { value: "Yes" } });
    fireEvent.change(within(editor).getByLabelText("Option 2"), { target: { value: "No" } });
    fireEvent.change(within(editor).getByLabelText("Campaign"), { target: { value: "empty-chapter" } });
    expect(within(editor).getByLabelText("Campaign")).toHaveValue("empty-chapter");
    expect(within(editor).getByText("This poll will reach New chapter only.")).toBeInTheDocument();
    fireEvent.submit(editor);
    await waitFor(() => expect(engagementApi.saveLivePoll).toHaveBeenCalledWith(client, expect.objectContaining({
      eligibility: "chapter",
      chapterId: "empty-chapter",
      title: "Empty chapter vote",
    })));
  });

  it("renders the translated refusal when a Campaign-scope poll cannot resolve a chapter", async () => {
    const client = liveClient();
    const snapshot = staffSnapshot();
    snapshot.chapters = [];
    snapshot.members = [{ id: "member-1", name: "Alex Rivera", chapterId: "wor" }];
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue(snapshot);
    engagementApi.saveLivePoll.mockRejectedValueOnce(new Error("Save live poll: chapter scope requires a specific chapter"));
    render(<StaffEngagement client={client} session={{ access_token: "token" }} />);
    await screen.findByTestId("staff-engagement");
    fireEvent.click(screen.getByRole("button", { name: "Live polls" }));
    fireEvent.click(screen.getByRole("button", { name: "New live poll" }));
    const editor = screen.getByRole("heading", { name: "Author a poll" }).closest("form");
    fireEvent.change(within(editor).getByLabelText("Question"), { target: { value: "Unresolved chapter" } });
    fireEvent.change(within(editor).getByLabelText("Eligibility"), { target: { value: "chapter" } });
    fireEvent.change(within(editor).getByLabelText("Option 1"), { target: { value: "Yes" } });
    fireEvent.change(within(editor).getByLabelText("Option 2"), { target: { value: "No" } });
    expect(within(editor).getByText(catalogue.en["engagement.pollChapterRequired"])).toBeInTheDocument();
    expect(within(editor).queryByLabelText("Campaign")).not.toBeInTheDocument();
    fireEvent.submit(editor);
    expect(await screen.findByRole("alert")).toHaveTextContent(catalogue.en["engagement.pollChapterRequired"]);
  });
});

// A control that starts its own write stays focusable while the
// write runs (the browser focus fixup would otherwise send focus to the page),
// reads as unavailable, and refuses a second activation.
describe("engagement controls keep focus while their own write runs", () => {
  const ORG = "00000000-0000-4000-a000-000000000001";

  it("keeps a pulse answer focused while it is sent, and sends it once", async () => {
    vi.spyOn(engagementApi, "loadMember").mockResolvedValue(memberSnapshot());
    render(<MemberEngagement client={liveClient()} organizationId={ORG} />);
    expect(await screen.findByTestId("member-engagement")).toBeInTheDocument();
    await expectHeldWriteFocus(engagementApi.respondPulse, screen.getByRole("button", { name: "Yes" }));
    expect(engagementApi.respondPulse).toHaveBeenCalledTimes(1);
  });

  it("keeps Save for later focused while survey progress is saved, and saves once", async () => {
    vi.spyOn(engagementApi, "loadMember").mockResolvedValue(memberSnapshot());
    render(<MemberEngagement client={liveClient()} organizationId={ORG} />);
    const survey = (await screen.findByRole("heading", { name: "Quarterly voice" })).closest("form");
    await expectHeldWriteFocus(engagementApi.saveSurveySession, within(survey).getByRole("button", { name: "Save for later" }));
    expect(engagementApi.saveSurveySession).toHaveBeenCalledTimes(1);
  });

  it("keeps I’m going focused while the RSVP is saved, and saves it once", async () => {
    vi.spyOn(engagementApi, "loadMember").mockResolvedValue(memberSnapshot());
    render(<MemberEngagement client={liveClient()} organizationId={ORG} />);
    expect(await screen.findByTestId("member-engagement")).toBeInTheDocument();
    await expectHeldWriteFocus(engagementApi.rsvpLivePoll, screen.getByRole("button", { name: "I’m going" }));
    expect(engagementApi.rsvpLivePoll).toHaveBeenCalledTimes(1);
  });

  it("keeps Distribute focused while distribution is prepared, and prepares it once", async () => {
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue(staffSnapshot());
    render(<StaffEngagement client={liveClient()} session={{ access_token: "token" }} />);
    expect(await screen.findByTestId("staff-engagement")).toBeInTheDocument();
    await expectHeldWriteFocus(engagementApi.prepareDistribution, screen.getByRole("button", { name: "Distribute" }));
    expect(engagementApi.prepareDistribution).toHaveBeenCalledTimes(1);
  });
});
