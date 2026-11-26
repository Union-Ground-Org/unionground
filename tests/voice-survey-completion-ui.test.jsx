import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemberEngagement } from "../src/features/engagement/MemberEngagement.jsx";
import { StaffEngagement } from "../src/features/engagement/StaffEngagement.jsx";
import { localDateTimeInputValue } from "../src/lib/localDateTime.js";

const staffSnapshot = {
  surveys: [], livePolls: [], pulsePrompts: [], channels: [], members: [],
  presence: { online: 0 }, delivery: {},
};

function staffClient(extra = {}) {
  return {
    rpc: vi.fn(async (name, args) => {
      if (name === "get_staff_engagement_snapshot") return { data: extra.snapshot || staffSnapshot, error: null };
      if (name === "get_organization_survey_draft") return { data: extra.draft, error: extra.draftError || null };
      if (name === "save_organization_survey_draft") return { data: { id: "saved-survey", ...args.p_draft }, error: null };
      if (name === "publish_organization_survey_with_operations") return { data: { id: args.p_draft.id || "saved-survey", ...args.p_draft }, error: null };
      if (name === "get_weekly_question_selection_workspace") return { data: { policy: {}, items: extra.weekly || [] }, error: null };
      return { data: {}, error: null };
    }),
  };
}

describe("Voice survey completion UI", () => {
  it("formats scheduled UTC instants as local datetime input values", () => {
    expect(localDateTimeInputValue("2026-09-01T17:00:00.000Z", 240)).toBe("2026-09-01T13:00");
    expect(localDateTimeInputValue("2026-09-01T17:00:00.000Z", -120)).toBe("2026-09-01T19:00");
    expect(localDateTimeInputValue("not-a-date", 240)).toBe("");
  });
  it("authors ordered question types, section metadata, and a branch to an earlier answer", async () => {
    const client = staffClient();
    render(<StaffEngagement client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "New survey" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Workplace priorities" } });

    const first = screen.getByRole("group", { name: "Question 1" });
    fireEvent.change(within(first).getByLabelText("Prompt"), { target: { value: "Which issue matters most?" } });
    fireEvent.change(within(first).getByLabelText("Type"), { target: { value: "radio" } });
    fireEvent.change(within(first).getByLabelText(/Options, one per line/), { target: { value: "Scheduling\nSafety" } });

    fireEvent.click(screen.getByRole("button", { name: "Add question" }));
    const second = screen.getByRole("group", { name: "Question 2" });
    fireEvent.change(within(second).getByLabelText("Prompt"), { target: { value: "What scheduling change would help?" } });
    fireEvent.change(within(second).getByLabelText("Section key"), { target: { value: "scheduling-follow-up" } });
    fireEvent.change(within(second).getByLabelText("Section title"), { target: { value: "Scheduling follow-up" } });
    fireEvent.change(within(second).getByLabelText("Show only after"), { target: { value: within(second).getByRole("option", { name: /Question 1:/ }).value } });
    fireEvent.change(within(second).getByLabelText("Answer equals"), { target: { value: "Scheduling" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_organization_survey_draft", {
      p_draft: expect.objectContaining({
        title: "Workplace priorities",
        questions: expect.arrayContaining([
          expect.objectContaining({ type: "radio", options: ["Scheduling", "Safety"], sortIndex: 0 }),
          expect.objectContaining({ sectionKey: "scheduling-follow-up", branchValue: "Scheduling", sortIndex: 1 }),
        ]),
      }),
    }));
    const payload = client.rpc.mock.calls.find(([name]) => name === "save_organization_survey_draft")[1].p_draft;
    expect(payload.questions[1].branchParentKey).toBe(payload.questions[0].clientKey);
  });

  it("clears stale options and dependent branches when a question becomes free text", async () => {
    const client = staffClient();
    render(<StaffEngagement client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "New survey" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Shift preferences" } });

    const first = screen.getByRole("group", { name: "Question 1" });
    fireEvent.change(within(first).getByLabelText("Prompt"), { target: { value: "Choose a shift" } });
    fireEvent.change(within(first).getByLabelText("Type"), { target: { value: "dropdown" } });
    fireEvent.change(within(first).getByLabelText(/Options, one per line/), { target: { value: "Day\nNight" } });
    fireEvent.click(screen.getByRole("button", { name: "Add question" }));
    const second = screen.getByRole("group", { name: "Question 2" });
    fireEvent.change(within(second).getByLabelText("Prompt"), { target: { value: "Why?" } });
    fireEvent.change(within(second).getByLabelText("Show only after"), { target: { value: within(second).getByRole("option", { name: /Question 1:/ }).value } });
    fireEvent.change(within(second).getByLabelText("Answer equals"), { target: { value: "Night" } });

    fireEvent.change(within(first).getByLabelText("Type"), { target: { value: "paragraph" } });
    expect(within(first).queryByLabelText(/Options, one per line/)).not.toBeInTheDocument();
    expect(within(second).queryByLabelText("Show only after")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_organization_survey_draft", {
      p_draft: expect.objectContaining({
        questions: [
          expect.objectContaining({ type: "paragraph", options: [] }),
          expect.objectContaining({ branchParentKey: "", branchValue: "" }),
        ],
      }),
    }));
  });

  it("reloads an existing survey and preserves fallback branch choices through publication", async () => {
    const survey = {
      id: "survey-existing", title: "Existing priorities", status: "draft", cadence: "quarterly",
      periodKey: "2026-Q3", coverage: {}, tasks: [], reviews: [],
    };
    const client = staffClient({
      snapshot: { ...staffSnapshot, surveys: [survey] },
      draft: {
        ...survey,
        description: "Existing draft",
        privacyMinResponses: 5,
        questions: [
          { id: "question-binary", clientKey: "binary", type: "yes_no", label: "Continue?", required: true, options: [], sectionKey: "main" },
          { id: "question-follow", clientKey: "follow", type: "paragraph", label: "Why?", required: false, options: [], sectionKey: "follow", branchParentKey: "binary", branchValue: "yes" },
        ],
      },
    });
    render(<StaffEngagement client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(await screen.findByRole("heading", { name: "Edit survey" })).toBeInTheDocument();
    const second = screen.getByRole("group", { name: "Question 2" });
    expect(within(second).getByRole("option", { name: "Yes" })).toBeInTheDocument();

    const first = screen.getByRole("group", { name: "Question 1" });
    fireEvent.change(within(first).getByLabelText("Type"), { target: { value: "rating" } });
    expect(within(second).getByRole("option", { name: "5" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Cadence"), { target: { value: "one_off" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish survey" }));

    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("publish_organization_survey_with_operations", {
      p_draft: expect.objectContaining({ id: "survey-existing" }),
      p_operations: expect.objectContaining({ periodKey: null, operationsState: "ready" }),
    }));
    expect(client.rpc).not.toHaveBeenCalledWith("publish_organization_survey", expect.anything());
    expect(client.rpc).not.toHaveBeenCalledWith("configure_organization_survey_operations", expect.anything());
  });

  it("surfaces weekly editorial loading failures", async () => {
    const client = staffClient();
    client.rpc.mockImplementation(async (name) => {
      if (name === "get_staff_engagement_snapshot") return { data: staffSnapshot, error: null };
      if (name === "get_weekly_question_selection_workspace") return { data: null, error: { message: "Editorial service unavailable" } };
      return { data: {}, error: null };
    });
    render(<StaffEngagement client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Weekly pool" }));
    // The notice carries the service message; the pool's own failure state is a second alert with Try again.
    await waitFor(() => expect(screen.getAllByRole("alert").some((node) => node.textContent.includes("Editorial service unavailable"))).toBe(true));
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("configures and runs deterministic weekly selection without publishing", async () => {
    const client = staffClient();
    let policyEnabled = false;
    client.rpc.mockImplementation(async (name, args) => {
      if (name === "get_staff_engagement_snapshot") return { data: staffSnapshot, error: null };
      if (name === "get_weekly_question_selection_workspace") return { data: { policy: { enabled: policyEnabled, lastResult: { selectedCount: 0, poolCount: 4 } }, items: [] }, error: null };
      if (name === "save_weekly_question_selection_policy") { policyEnabled = Boolean(args.p_enabled); return { data: { saved: true }, error: null }; }
      if (name === "run_weekly_question_selection") return { data: { selectedCount: 1, poolCount: 4 }, error: null };
      return { data: {}, error: null };
    });
    render(<StaffEngagement client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Weekly pool" }));
    expect(await screen.findByText(/Last run reserved 0 of 4/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Enable governed selection/));
    fireEvent.change(screen.getByLabelText("Cadence in days"), { target: { value: "14" } });
    fireEvent.change(screen.getByLabelText("Minimum submitted pool"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Questions to reserve"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Next scheduled run"), { target: { value: "2026-09-01T09:30" } });
    // REQ-UG-WEEKLY-QUESTION-PRIORITY-AND-WEIGHTED-DRAW-20261001: the old
    // weighted draw is the default rule; the support ranking stays selectable.
    expect(screen.getByLabelText("Selection rule")).toHaveValue("weighted_random");
    expect(screen.getByText(/each worker boost adds weight/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Selection rule"), { target: { value: "support_then_oldest" } });
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_weekly_question_selection_policy", expect.objectContaining({
      p_enabled: true, p_cadence_days: 14, p_minimum_pool_size: 5, p_selection_count: 2,
      p_priority_rule: "support_then_oldest", p_next_run_at: expect.stringContaining("2026-09-01"),
    })));
    fireEvent.click(screen.getByRole("button", { name: "Run selection now" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("run_weekly_question_selection", expect.objectContaining({ p_idempotency_key: expect.any(String) })));
  });

  it("pages active weekly questions, filters the archive, and applies editorial transitions", async () => {
    const active = {
      id: "weekly-active", body: "Which issue should be discussed?", options: ["Safety", "Scheduling"],
      editorialState: "submitted", weekStart: "2026-08-17", score: 3,
    };
    const older = {
      id: "weekly-older", body: "Which training would help?", options: ["Rights", "Bargaining"],
      editorialState: "reserved", weekStart: "2026-08-10", score: 2,
    };
    const published = {
      id: "weekly-published", body: "Which meeting format works?", options: ["Online", "In person"],
      editorialState: "published", publishedSurveyId: "survey-weekly", weekStart: "2026-08-03", score: 8,
    };
    const archived = {
      ...published, id: "weekly-archived", body: "Which archived topic mattered?",
      editorialState: "archived", publishedSurveyId: null,
    };
    const client = { rpc: vi.fn(async (name, args = {}) => {
      if (name === "get_staff_engagement_snapshot") return { data: staffSnapshot, error: null };
      if (name === "get_weekly_question_selection_workspace") {
        return { data: { policy: {}, items: [active], nextCursor: { createdAt: "2026-08-17T00:00:00Z", id: active.id } }, error: null };
      }
      if (name === "list_weekly_question_selection_page") {
        if (args.p_view === "archive") return { data: { items: [published, archived], nextCursor: null }, error: null };
        return { data: { items: [older], nextCursor: null }, error: null };
      }
      return { data: { updated: true }, error: null };
    }) };

    render(<StaffEngagement client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Weekly pool" }));
    expect(await screen.findByRole("heading", { name: active.body })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load older questions" }));
    expect(await screen.findByRole("heading", { name: older.body })).toBeInTheDocument();

    fireEvent.change(screen.getAllByLabelText("Editorial note (optional)")[0], { target: { value: "Ready for review" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Reserve" })[0]);
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("review_weekly_poll_question", expect.objectContaining({
      p_question_id: active.id, p_editorial_state: "reserved", p_editor_note: "Ready for review",
    })));
    fireEvent.click(screen.getByRole("button", { name: "Show publication archive" }));
    expect(await screen.findByRole("heading", { name: published.body })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: archived.body })).toBeInTheDocument();
    expect(screen.getByText("survey-weekly")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show active pool" }));
    expect(await screen.findByRole("heading", { name: active.body })).toBeInTheDocument();
  });

  it("reveals conditional member questions and submits the complete response session", async () => {
    const snapshot = {
      quarterlyGate: {}, pulsePrompts: [], livePolls: [], actions: [], briefings: [],
      workspace: { moduleOrder: [], hiddenModules: [] },
      surveys: [{
        id: "survey-1", title: "Priorities", description: "", cadence: "one_off", session: null,
        questions: [
          { id: "question-1", type: "radio", label: "Choose an issue", required: true, options: ["Scheduling", "Safety"], sectionKey: "main" },
          { id: "question-2", type: "paragraph", label: "Tell us more", required: true, options: [], sectionKey: "detail", sectionTitle: "Follow-up", branchParentId: "question-1", branchValue: "Scheduling" },
        ],
      }],
    };
    const subscription = { id: "voice-subscription" };
    const client = {
      rpc: vi.fn(async (name) => ({ data: name === "get_member_engagement_snapshot" ? snapshot : {}, error: null })),
      channel: vi.fn(() => ({ on: vi.fn(() => ({ subscribe: vi.fn(() => subscription) })) })),
      removeChannel: vi.fn(),
    };
    render(<MemberEngagement client={client} organizationId="00000000-0000-4000-a000-000000000001" />);
    expect(await screen.findByRole("group", { name: /Choose an issue/ })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Tell us more/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Scheduling"));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByLabelText(/Tell us more/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Tell us more/), { target: { value: "More advance notice" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit survey" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("submit_organization_survey_session", {
      p_survey_id: "survey-1",
      p_answers: { "question-1": "Scheduling", "question-2": "More advance notice" },
    }));
  });

  it("omits an optional dropdown answer after the member clears it", async () => {
    const snapshot = {
      quarterlyGate: {}, pulsePrompts: [], livePolls: [], actions: [], briefings: [],
      workspace: { moduleOrder: [], hiddenModules: [] },
      surveys: [{
        id: "survey-dropdown", title: "Meeting preferences", description: "", cadence: "one_off", session: null,
        questions: [{ id: "question-dropdown", type: "dropdown", label: "Preferred day", required: false, options: ["Tuesday", "Thursday"], sectionKey: "main" }],
      }],
    };
    const client = {
      rpc: vi.fn(async (name) => ({ data: name === "get_member_engagement_snapshot" ? snapshot : {}, error: null })),
      channel: vi.fn(() => ({ on: vi.fn(() => ({ subscribe: vi.fn(() => ({ id: "voice-subscription" })) })) })),
      removeChannel: vi.fn(),
    };
    render(<MemberEngagement client={client} organizationId="00000000-0000-4000-a000-000000000001" />);
    const dropdown = await screen.findByLabelText("Preferred day");
    fireEvent.change(dropdown, { target: { value: "Tuesday" } });
    fireEvent.change(dropdown, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit survey" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("submit_organization_survey_session", {
      p_survey_id: "survey-dropdown",
      p_answers: {},
    }));
  });

  it("publishes a reviewed weekly question into the privacy-gated survey lane", async () => {
    const client = staffClient({ weekly: [{
      id: "weekly-1", body: "Which meeting time works best?", options: ["Morning", "Evening"],
      editorialState: "reserved", editorNote: "Strong response", weekStart: "2026-08-24", score: 4,
    }] });
    render(<StaffEngagement client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Weekly pool" }));
    expect(await screen.findByRole("heading", { name: "Which meeting time works best?" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Publication privacy floor"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("publish_weekly_poll_question", {
      p_question_id: "weekly-1",
      p_privacy_min_responses: 7,
    }));
  });
});
