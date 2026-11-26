import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadJson,
  engagementApi,
  loadEngagementDeliveryStatus,
  requestMessageBriefing,
  requestPollDraft,
  subscribeToLivePolls,
} from "../src/features/engagement/api.js";

afterEach(() => vi.restoreAllMocks());

describe("engagement API", () => {
  it.each([
    ["loadMember", [], "get_member_engagement_snapshot", {}],
    ["loadStaff", [], "get_staff_engagement_snapshot", {}],
    ["saveSurveySession", ["survey", { q: "a" }], "save_organization_survey_session",
      { p_survey_id: "survey", p_answers: { q: "a" } }],
    ["submitSurveySession", ["survey", { q: "a" }], "submit_organization_survey_session",
      { p_survey_id: "survey", p_answers: { q: "a" } }],
    ["saveSurveyDraft", [{ title: "Survey" }], "save_organization_survey_draft",
      { p_draft: { title: "Survey" } }],
    ["publishSurvey", [{ title: "Survey" }, { cadence: "quarterly" }], "publish_organization_survey_with_operations",
      { p_draft: { title: "Survey" }, p_operations: { cadence: "quarterly" } }],
    ["closeSurvey", ["survey"], "close_organization_survey", { p_survey_id: "survey" }],
    ["reopenSurvey", ["survey"], "reopen_organization_survey", { p_survey_id: "survey" }],
    ["configureSurvey", ["survey", { cadence: "quarterly" }], "configure_organization_survey_operations",
      { p_survey_id: "survey", p_operations: { cadence: "quarterly" } }],
    ["prepareDistribution", ["survey"], "prepare_organization_survey_distribution",
      { p_survey_id: "survey", p_recipient_user_ids: null }],
    ["prepareDistribution", ["survey", ["member"]], "prepare_organization_survey_distribution",
      { p_survey_id: "survey", p_recipient_user_ids: ["member"] }],
    ["queueReminders", ["survey"], "queue_organization_survey_reminders", { p_survey_id: "survey" }],
    ["updateSurveyTask", ["task", { status: "done" }], "update_organization_survey_task",
      { p_task_id: "task", p_status: "done", p_assigned_to: null, p_due_at: null }],
    ["updateSurveyTask", ["task", { status: "open", assignedTo: "staff", dueAt: "2026-09-01" }], "update_organization_survey_task",
      { p_task_id: "task", p_status: "open", p_assigned_to: "staff", p_due_at: "2026-09-01" }],
    ["updateSurveyReview", ["review", { state: "resolved" }], "update_organization_survey_review",
      { p_review_id: "review", p_state: "resolved", p_assigned_to: null, p_disposition: null, p_follow_up_due_at: null }],
    ["updateSurveyReview", ["review", { state: "assigned", assignedTo: "staff", disposition: "follow_up", followUpDueAt: "2026-09-01" }], "update_organization_survey_review",
      { p_review_id: "review", p_state: "assigned", p_assigned_to: "staff", p_disposition: "follow_up", p_follow_up_due_at: "2026-09-01" }],
    ["loadSurveyReview", ["session"], "get_organization_survey_review_detail", { p_session_id: "session" }],
    ["loadSurveyDraft", ["survey"], "get_organization_survey_draft", { p_survey_id: "survey" }],
    ["loadSurveyReport", ["survey"], "get_organization_survey_report", { p_survey_id: "survey" }],
    ["exportSurvey", ["survey"], "export_organization_survey_results", { p_survey_id: "survey" }],
    // REQ-UG-SURVEY-AND-POLL-BUILDER-OPTIONS-20261030: the meetings a
    // live poll may be tied to, and setting or clearing a poll's meeting.
    ["loadLivePollMeetings", [], "get_live_poll_meetings", {}],
    ["setLivePollMeeting", ["poll", "event-8am"], "set_organization_live_poll_event", { p_poll_id: "poll", p_event_id: "event-8am" }],
    ["setLivePollMeeting", ["poll", ""], "set_organization_live_poll_event", { p_poll_id: "poll", p_event_id: null }],
    ["setLivePollMeeting", ["poll"], "set_organization_live_poll_event", { p_poll_id: "poll", p_event_id: null }],
    ["reviewWeeklyQuestion", ["question", "reserved", "Ready for next week"], "review_weekly_poll_question",
      { p_question_id: "question", p_editorial_state: "reserved", p_editor_note: "Ready for next week" }],
    ["publishWeeklyQuestion", ["question", 7], "publish_weekly_poll_question",
      { p_question_id: "question", p_privacy_min_responses: 7 }],
    ["savePulsePrompt", [{ eventKey: "case.updated" }], "save_organization_pulse_prompt",
      { p_prompt: { eventKey: "case.updated" } }],
    ["evaluatePulse", ["voice.open", "2026-08-28"], "evaluate_contextual_pulse",
      { p_event_key: "voice.open", p_context_key: "2026-08-28" }],
    ["respondPulse", ["event"], "respond_contextual_pulse",
      { p_event_id: "event", p_response: null, p_dismiss: false }],
    ["respondPulse", ["event", "yes", true], "respond_contextual_pulse",
      { p_event_id: "event", p_response: "yes", p_dismiss: true }],
    ["saveLivePoll", [{ title: "Vote" }], "save_organization_live_poll", { p_poll: { title: "Vote" } }],
    ["transitionLivePoll", ["poll", "open"], "transition_organization_live_poll", { p_poll_id: "poll", p_action: "open" }],
    ["setLivePollRoster", ["poll", ["member"]], "set_organization_live_poll_roster", { p_poll_id: "poll", p_user_ids: ["member"] }],
    ["rsvpLivePoll", ["poll", "yes"], "rsvp_organization_live_poll", { p_poll_id: "poll", p_rsvp: "yes" }],
    ["checkInLivePoll", ["poll"], "check_in_organization_live_poll", { p_poll_id: "poll", p_user_id: null }],
    ["checkInLivePoll", ["poll", "member"], "check_in_organization_live_poll", { p_poll_id: "poll", p_user_id: "member" }],
    ["castLivePollVote", ["poll", "option"], "cast_organization_live_poll_vote", { p_poll_id: "poll", p_option_id: "option" }],
    ["heartbeat", [], "heartbeat_member_presence", { p_status: "online" }],
    ["heartbeat", ["away"], "heartbeat_member_presence", { p_status: "away" }],
    ["setChannelControls", ["space", { postingMode: "members", slowModeSeconds: "15", approvalsRequired: true }], "set_chapter_space_controls",
      { p_space_id: "space", p_posting_mode: "members", p_slow_mode_seconds: 15, p_approvals_required: true }],
    ["setChannelControls", ["space", { postingMode: "read_only", slowModeSeconds: "", approvalsRequired: false }], "set_chapter_space_controls",
      { p_space_id: "space", p_posting_mode: "read_only", p_slow_mode_seconds: 0, p_approvals_required: false }],
    ["saveWorkspace", [["inbox"], ["cases"]], "save_compass_workspace_preferences",
      { p_module_order: ["inbox"], p_hidden_modules: ["cases"] }],
    ["proposeAction", ["message", "message-id", "Follow up"], "propose_compass_workspace_action",
      { p_source_kind: "message", p_source_id: "message-id", p_title: "Follow up" }],
    ["decideAction", ["action", "confirm"], "decide_compass_workspace_action", { p_action_id: "action", p_decision: "confirm" }],
    ["loadBargainingResults", ["survey"], "get_bargaining_survey_results", { p_survey_id: "survey" }],
  ])("maps %s(%j) to %s with complete arguments", async (operation, input, expectedRpc, expectedArgs) => {
    const data = { id: "rpc-result" };
    const client = { rpc: vi.fn().mockResolvedValue({ data, error: null }) };
    expect(await engagementApi[operation](client, ...input)).toBe(data);
    expect(client.rpc.mock.calls).toStrictEqual([[expectedRpc, expectedArgs]]);
  });

  it("preserves RPC error metadata and labels", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "denied", code: "42501", details: "RLS", hint: "sign in" } }) };
    await expect(engagementApi.loadMember(client)).rejects.toMatchObject({
      name: "MemberApiError",
      message: "Member engagement: denied",
      code: "42501",
      details: "RLS",
      hint: "sign in",
    });
  });

  it("uses bearer-authenticated guide and delivery endpoints", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => ({ draft: { title: "Draft" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ briefing: { summary: "Summary" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ configured: true }) });
    const session = { access_token: "token" };

    await expect(requestPollDraft(session, "meeting")).resolves.toEqual({ draft: { title: "Draft" } });
    await expect(requestMessageBriefing(session, "private", "conversation")).resolves.toEqual({ briefing: { summary: "Summary" } });
    await expect(loadEngagementDeliveryStatus(session)).resolves.toEqual({ configured: true });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/guide", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
      body: JSON.stringify({ mode: "poll_draft", topic: "meeting" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/engagement-delivery?status=1", {
      headers: { Authorization: "Bearer token" },
    });
  });

  it("reports missing sessions, response errors, and invalid JSON safely", async () => {
    await expect(requestPollDraft(null, "meeting")).rejects.toThrow("session expired");
    await expect(loadEngagementDeliveryStatus({})).rejects.toThrow("session expired");

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: "guide denied" }) })
      .mockResolvedValueOnce({ ok: false, json: async () => { throw new Error("bad json"); } });
    await expect(requestMessageBriefing({ access_token: "token" }, "task", "task-id")).rejects.toThrow("guide denied");
    await expect(loadEngagementDeliveryStatus({ access_token: "token" })).rejects.toThrow("Delivery status is unavailable");
  });

  it("subscribes to live poll changes and removes the exact channel", () => {
    const subscription = { id: "subscription" };
    const subscribe = vi.fn(() => subscription);
    const on = vi.fn(() => ({ subscribe }));
    const channel = vi.fn(() => ({ on }));
    const removeChannel = vi.fn();
    const client = { channel, removeChannel };
    const onChange = vi.fn();

    const unsubscribe = subscribeToLivePolls(client, onChange);
    expect(channel).toHaveBeenCalledWith(expect.stringMatching(/^engagement-live-polls-/));
    const handler = on.mock.calls[0][2];
    handler({ new: { id: "poll" } });
    expect(onChange).toHaveBeenCalledWith({ id: "poll" });
    unsubscribe();
    expect(removeChannel).toHaveBeenCalledWith(subscription);
  });

  it("downloads privacy-safe JSON and revokes its object URL", () => {
    const click = vi.fn();
    vi.spyOn(document, "createElement").mockReturnValue({ click });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:engagement");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    downloadJson("survey.json", { count: 3 });
    expect(click).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:engagement");
  });
});
