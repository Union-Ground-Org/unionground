// REQ-UG-SURVEY-AND-POLL-BUILDER-OPTIONS-20261030 (#6575).
//
// The October 29-30, 2026 role-play run (findings 21, 91 and 92): a survey
// could not be given an audience or a close date and showed no response
// count; a Campaigns pulse demanded Spanish for every field and a duplicate
// draft could not be deleted; a live poll could not be tied to a meeting.
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaffEngagement, surveyWindowProblem } from "../src/features/engagement/StaffEngagement.jsx";
import { engagementApi } from "../src/features/engagement/api.js";
import { deleteCampaignDraft, saveCampaignDraft, spanishOrEnglish } from "../src/lib/campaignApi.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { CampaignsView, draftFromCampaign } from "../src/views/CampaignsView.jsx";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const wrap = (ui, lang = "en") => render(<LanguageProvider lang={lang}>{ui}</LanguageProvider>);

const pulseDraft = {
  id: "pulse-draft", kind: "pulse", scope: "chapter", chapterId: "wor",
  titleEn: "Overtime list poll", titleEs: "Overtime list poll", bodyEn: "", bodyEs: "",
  closesAt: "2026-11-06T16:00:00.000Z", quorumTarget: null, state: "draft", active: false,
  options: [
    { id: "a", labelEn: "Yes", labelEs: "Sí", orderIndex: 1 },
    { id: "b", labelEn: "Wait for bargaining", labelEs: "Wait for bargaining", orderIndex: 2 },
  ],
};

function rpcClient(result = {}) {
  return { rpc: vi.fn().mockResolvedValue({ data: result, error: null }) };
}

describe("Campaigns: Spanish is optional with an English fallback", () => {
  it("sends the English text where a Spanish field is blank, and keeps typed Spanish", async () => {
    expect(spanishOrEnglish("Yes", "")).toBe("Yes");
    expect(spanishOrEnglish("Yes", "  Sí ")).toBe("Sí");
    expect(spanishOrEnglish(" Yes ", undefined)).toBe("Yes");
    const client = rpcClient({ id: "pulse-1" });
    await saveCampaignDraft(client, {
      kind: "pulse", id: "", scope: "chapter", titleEn: "Overtime list poll", titleEs: "  ",
      closesAt: "2026-11-06T16:00:00.000Z", bodyEn: "Choose one.", bodyEs: undefined,
      options: [{ labelEn: "Yes", labelEs: "Sí" }, { labelEn: "Wait for bargaining", labelEs: "" }],
    });
    expect(client.rpc).toHaveBeenCalledWith("save_vote_campaign_draft", expect.objectContaining({
      p_title_en: "Overtime list poll",
      p_title_es: "Overtime list poll",
      p_body_es: "",
      p_options: [{ labelEn: "Yes", labelEs: "Sí" }, { labelEn: "Wait for bargaining", labelEs: "Wait for bargaining" }],
    }));
  });

  it("reopens a fallback Spanish field blank instead of showing English in it", () => {
    const reopened = draftFromCampaign(pulseDraft);
    expect(reopened.titleEs).toBe("");
    expect(reopened.options.map((option) => option.labelEs)).toEqual(["Sí", ""]);
  });

  it("lets a pulse save with English only", async () => {
    const api = {
      load: vi.fn().mockResolvedValue({ campaigns: [], canManageUnion: false, chapterId: "wor" }),
      saveDraft: vi.fn().mockResolvedValue({ id: "pulse-new", state: "draft" }),
    };
    wrap(<CampaignsView api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "New campaign" }));
    fireEvent.click(screen.getByLabelText("Pulse"));
    expect(screen.getByText(t("en", "campaigns.spanishOptional"))).toBeInTheDocument();
    expect(screen.getByLabelText("Spanish title")).not.toBeRequired();
    expect(screen.getByLabelText("Option 1 in Spanish")).not.toBeRequired();
    fireEvent.change(screen.getByLabelText("English title"), { target: { value: "Overtime list poll" } });
    fireEvent.change(screen.getByLabelText("Option 1 in English"), { target: { value: "Yes" } });
    fireEvent.change(screen.getByLabelText("Option 2 in English"), { target: { value: "No" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(api.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ titleEn: "Overtime list poll", titleEs: "" })));
  });
});

describe("Campaigns: a draft can be deleted", () => {
  it("asks first, then deletes the draft through delete_vote_campaign_draft", async () => {
    const client = rpcClient({ id: "pulse-draft", kind: "pulse", state: "deleted" });
    await deleteCampaignDraft(client, "pulse", "pulse-draft");
    expect(client.rpc).toHaveBeenCalledWith("delete_vote_campaign_draft", { p_kind: "pulse", p_campaign_id: "pulse-draft" });

    const api = {
      load: vi.fn().mockResolvedValue({ campaigns: [pulseDraft, { ...pulseDraft, id: "pulse-open", state: "open", active: true }], canManageUnion: false, chapterId: "wor" }),
      delete: vi.fn().mockResolvedValue({ id: "pulse-draft", state: "deleted" }),
    };
    wrap(<CampaignsView api={api} />);
    const remove = await screen.findByRole("button", { name: "Delete draft Overtime list poll" });
    expect(screen.getAllByRole("button", { name: /^Delete draft/ })).toHaveLength(1);
    fireEvent.click(remove);
    const dialog = screen.getByRole("dialog", { name: "Delete this draft?" });
    expect(api.delete).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete draft" }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("pulse", "pulse-draft"));
    expect(await screen.findByText("Draft deleted.")).toBeInTheDocument();
  });

  it("r2s2: deleting the draft being edited closes its editor, so nothing saves into a deleted row", async () => {
    const api = {
      load: vi.fn().mockResolvedValue({ campaigns: [pulseDraft], canManageUnion: false, chapterId: "wor" }),
      delete: vi.fn().mockResolvedValue({ id: "pulse-draft", state: "deleted" }),
      saveDraft: vi.fn(),
    };
    wrap(<CampaignsView api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Overtime list poll" }));
    expect(screen.getByRole("button", { name: "Save draft" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete draft Overtime list poll" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Delete this draft?" })).getByRole("button", { name: "Delete draft" }));
    expect(await screen.findByText("Draft deleted.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    expect(api.saveDraft).not.toHaveBeenCalled();
  });

  it("offers no delete without the API or for an officer-removal ballot", async () => {
    const ballot = { ...pulseDraft, id: "ballot-removal", kind: "ballot", quorumTarget: 10 };
    const api = {
      load: vi.fn().mockResolvedValue({ campaigns: [ballot], canManageUnion: false, chapterId: "wor" }),
      delete: vi.fn(),
      removalDetails: vi.fn().mockResolvedValue({ enabled: true, byId: new Map([["ballot-removal", { officerName: "Officer", outcome: null }]]) }),
    };
    wrap(<CampaignsView api={api} />);
    await screen.findByRole("button", { name: /Edit Overtime list poll/ });
    expect(screen.queryByRole("button", { name: /^Delete draft/ })).toBeNull();
    cleanup();
    wrap(<CampaignsView api={{ load: vi.fn().mockResolvedValue({ campaigns: [pulseDraft], canManageUnion: false, chapterId: "wor" }) }} />);
    await screen.findByRole("button", { name: /Edit Overtime list poll/ });
    expect(screen.queryByRole("button", { name: /^Delete draft/ })).toBeNull();
  });
});

const chapters = [{ id: "chapter-garage-a", name: "Garage A" }, { id: "chapter-garage-b", name: "Garage B" }];

function staffSnapshot(overrides = {}) {
  return { surveys: [], livePolls: [], channels: [], pulsePrompts: [], members: [], chapters, ...overrides };
}

async function renderStaff(snapshot, meetings = { events: [], links: [] }) {
  vi.spyOn(engagementApi, "loadOrganizationSwitches").mockResolvedValue({ switches: {} });
  vi.spyOn(engagementApi, "loadStaff").mockResolvedValue(snapshot);
  const loadMeetings = vi.spyOn(engagementApi, "loadLivePollMeetings").mockResolvedValue(meetings);
  wrap(<StaffEngagement client={{}} />);
  await screen.findByTestId("staff-engagement");
  return { loadMeetings };
}

describe("Surveys: audience, close date, reminders and response counts", () => {
  it("checks the answer window before the request", () => {
    const now = Date.parse("2026-10-30T20:00:00Z");
    expect(surveyWindowProblem({}, true, now)).toBeNull();
    expect(surveyWindowProblem({ opens: "2026-11-02T08:00", closes: "2026-11-06T17:00" }, true, now)).toBeNull();
    expect(surveyWindowProblem({ opens: "2026-11-06T17:00", closes: "2026-11-02T08:00" }, false, now)).toBe("engagement.surveyWindowOrder");
    expect(surveyWindowProblem({ closes: "2026-10-01T08:00" }, true, now)).toBe("engagement.surveyClosesPast");
    expect(surveyWindowProblem({ closes: "2026-10-01T08:00" }, false, now)).toBeNull();
    expect(surveyWindowProblem({ closes: "not a date" }, false, now)).toBe("engagement.surveyWindowInvalid");
  });

  it("publishes to a chosen chapter with a close date, and explains reminders", async () => {
    await renderStaff(staffSnapshot());
    const publish = vi.spyOn(engagementApi, "publishSurvey").mockResolvedValue({ id: "survey-1" });
    fireEvent.click(screen.getByRole("button", { name: "New survey" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Shift bid survey" } });
    fireEvent.change(screen.getByLabelText("Cadence"), { target: { value: "one_off" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Which shift do you want?" } });
    expect(screen.getByText(/reminded automatically/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Who can answer"), { target: { value: "chapter-garage-b" } });
    fireEvent.change(screen.getAllByLabelText("Closes")[0], { target: { value: "2099-11-06T17:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish survey" }));
    await waitFor(() => expect(publish).toHaveBeenCalled());
    const [, payload, operations] = publish.mock.calls[0];
    expect(payload.chapterId).toBe("chapter-garage-b");
    expect(operations.closesAt).toBe(new Date("2099-11-06T17:00").toISOString());
    expect(operations.opensAt).toBeNull();
  });

  it("refuses a close time before the start time with a reason, sending nothing", async () => {
    await renderStaff(staffSnapshot());
    const save = vi.spyOn(engagementApi, "saveSurveyDraft");
    fireEvent.click(screen.getByRole("button", { name: "New survey" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Shift bid survey" } });
    fireEvent.change(screen.getByLabelText("Cadence"), { target: { value: "one_off" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Which shift do you want?" } });
    fireEvent.change(screen.getAllByLabelText("Starts")[0], { target: { value: "2099-11-06T17:00" } });
    fireEvent.change(screen.getAllByLabelText("Closes")[0], { target: { value: "2099-11-02T08:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("The close time must be after the start time.")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it("shows the response count and close date on an open survey, and edits the close date", async () => {
    const survey = {
      id: "survey-open", title: "Seasonal crew check-out survey", status: "open", cadence: "one_off",
      privacyMinResponses: 3, closesAt: "2099-10-31T21:00:00.000Z", opensAt: null,
      coverage: { total: 12, sent: 12, engaged: 4, failed: 0 }, tasks: [], reviews: [], questions: [],
      reviewLane: { state: "collecting", responseCount: 2, privacyMinResponses: 3 },
    };
    await renderStaff(staffSnapshot({ surveys: [survey] }));
    const card = (await screen.findByRole("heading", { name: "Seasonal crew check-out survey" })).closest("article");
    expect(within(card).getByText("Responses").nextSibling).toHaveTextContent("2");
    expect(within(card).getByText(/^Closes /)).toBeInTheDocument();
    const configure = vi.spyOn(engagementApi, "configureSurvey").mockResolvedValue({});
    fireEvent.click(within(card).getByText(t("en", "engagement.operationsSettings")));
    fireEvent.change(within(card).getByLabelText("Closes"), { target: { value: "2099-11-01T17:00" } });
    fireEvent.click(within(card).getByRole("button", { name: t("en", "engagement.saveOperations") }));
    await waitFor(() => expect(configure).toHaveBeenCalledWith({}, "survey-open", expect.objectContaining({ closesAt: new Date("2099-11-01T17:00").toISOString() })));
  });
});

describe("Gate round 1 repairs (PR #6601)", () => {
  it("r1s1: an untouched close date follows the saved survey instead of a stale copy", async () => {
    const base = {
      id: "survey-open", title: "Shift bid survey", status: "open", cadence: "one_off", privacyMinResponses: 3,
      opensAt: null, closesAt: null, coverage: { total: 0, sent: 0, engaged: 0, failed: 0 }, tasks: [], reviews: [], questions: [],
      reviewLane: { state: "collecting", responseCount: 0, privacyMinResponses: 3 },
    };
    vi.spyOn(engagementApi, "loadOrganizationSwitches").mockResolvedValue({ switches: {} });
    vi.spyOn(engagementApi, "loadLivePollMeetings").mockResolvedValue({ events: [], links: [] });
    const later = { ...base, closesAt: "2099-11-06T22:00:00.000Z" };
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValueOnce(staffSnapshot({ surveys: [base] })).mockResolvedValue(staffSnapshot({ surveys: [later] }));
    const configure = vi.spyOn(engagementApi, "configureSurvey").mockResolvedValue({});
    wrap(<StaffEngagement client={{}} />);
    const card = (await screen.findByRole("heading", { name: "Shift bid survey" })).closest("article");
    fireEvent.click(within(card).getByText(t("en", "engagement.operationsSettings")));
    const save = () => fireEvent.click(within(screen.getByRole("heading", { name: "Shift bid survey" }).closest("article")).getByRole("button", { name: t("en", "engagement.saveOperations") }));
    save();
    await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
    expect(configure.mock.calls[0][2].closesAt).toBeNull();
    await screen.findByText(/^Closes /);
    save();
    await waitFor(() => expect(configure).toHaveBeenCalledTimes(2));
    expect(configure.mock.calls[1][2].closesAt).toBe("2099-11-06T22:00:00.000Z");
  });

  it("an open survey past its close time still saves owner and due dates; a new past close is refused", async () => {
    const expired = {
      id: "survey-expired", title: "Seasonal crew check-out survey", status: "open", cadence: "one_off", privacyMinResponses: 3,
      opensAt: null, closesAt: "2026-10-28T21:00:00.000Z", coverage: { total: 4, sent: 4, engaged: 1, failed: 0 }, tasks: [], reviews: [], questions: [],
      reviewLane: { state: "collecting", responseCount: 1, privacyMinResponses: 3 },
    };
    await renderStaff(staffSnapshot({ surveys: [expired] }));
    const card = (await screen.findByRole("heading", { name: "Seasonal crew check-out survey" })).closest("article");
    fireEvent.click(within(card).getByText(t("en", "engagement.operationsSettings")));
    const saveButton = within(card).getByRole("button", { name: t("en", "engagement.saveOperations") });
    expect(saveButton).toBeEnabled();
    expect(within(card).queryByText(t("en", "engagement.surveyClosesPast"))).toBeNull();
    const configure = vi.spyOn(engagementApi, "configureSurvey").mockResolvedValue({});
    fireEvent.change(within(card).getByLabelText(t("en", "engagement.reviewDue")), { target: { value: "2099-11-10T09:00" } });
    fireEvent.click(saveButton);
    await waitFor(() => expect(configure).toHaveBeenCalledWith({}, "survey-expired", expect.objectContaining({ closesAt: "2026-10-28T21:00:00.000Z", reviewDueAt: new Date("2099-11-10T09:00").toISOString() })));
    fireEvent.change(within(card).getByLabelText("Closes"), { target: { value: "2026-10-29T09:00" } });
    expect(within(card).getByText(t("en", "engagement.surveyClosesPast"))).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: t("en", "engagement.saveOperations") })).toBeDisabled();
  });

  it("r1s2: a meeting outside the caller's chapter shows as selected and can be cleared", async () => {
    const poll = { id: "poll-a", title: "Poll A", state: "open", voteCount: 0, attendance: { roster: 0, rsvpYes: 0, checkedIn: 0 }, options: [] };
    await renderStaff(staffSnapshot({ livePolls: [poll] }), { events: [], links: [{ pollId: "poll-a", eventId: "event-elsewhere", title: null, startsAt: null }] });
    fireEvent.click(screen.getByRole("button", { name: "Live polls" }));
    const select = await screen.findByLabelText("Meeting for Poll A");
    expect(select).toHaveValue("event-elsewhere");
    expect(within(select).getByRole("option", { name: t("en", "engagement.pollMeetingHiddenOption") })).toBeInTheDocument();
    const link = vi.spyOn(engagementApi, "setLivePollMeeting").mockResolvedValue({ pollId: "poll-a", eventId: null });
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(link).toHaveBeenCalledWith({}, "poll-a", ""));
  });

  it("r1s3: a failed meeting link keeps the created poll, and the retry updates it", async () => {
    await renderStaff(staffSnapshot(), { events: [{ id: "event-8am", title: "Overtime meeting", startsAt: "2099-10-21T12:00:00.000Z" }], links: [] });
    fireEvent.click(screen.getByRole("button", { name: "Live polls" }));
    const save = vi.spyOn(engagementApi, "saveLivePoll").mockResolvedValue({ id: "poll-new" });
    const link = vi.spyOn(engagementApi, "setLivePollMeeting").mockRejectedValueOnce(new Error("meeting unavailable")).mockResolvedValue({});
    fireEvent.click(await screen.findByRole("button", { name: "New live poll" }));
    const editor = screen.getByRole("button", { name: "Save live poll" }).closest("form");
    fireEvent.change(within(editor).getByLabelText("Question"), { target: { value: "File a group grievance?" } });
    fireEvent.change(within(editor).getByLabelText("Option 1"), { target: { value: "Yes" } });
    fireEvent.change(within(editor).getByLabelText("Option 2"), { target: { value: "No" } });
    fireEvent.change(within(editor).getByLabelText("Meeting"), { target: { value: "event-8am" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save live poll" }));
    expect(await screen.findByText(t("en", "engagement.pollMeetingFailed"))).toBeInTheDocument();
    expect(save.mock.calls[0][1].id).toBeUndefined();
    fireEvent.click(within(editor).getByRole("button", { name: "Save live poll" }));
    await waitFor(() => expect(link).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][1].id).toBe("poll-new");
    expect(link).toHaveBeenLastCalledWith({}, "poll-new", "event-8am");
  });
});

describe("Live polls can be tied to a meeting", () => {
  const meetings = {
    events: [{ id: "event-8am", title: "Overtime meeting", startsAt: "2099-10-21T12:00:00.000Z" }],
    links: [{ pollId: "poll-linked", eventId: "event-8am", title: "Overtime meeting", startsAt: "2099-10-21T12:00:00.000Z" }, { pollId: "poll-hidden", eventId: "event-other", title: null, startsAt: null }],
  };
  const poll = (id, state = "draft") => ({ id, title: `Poll ${id}`, state, voteCount: 0, attendance: { roster: 0, rsvpYes: 0, checkedIn: 0 }, options: [] });

  it("names the meeting, picks from events (not people), and saves the link", async () => {
    const { loadMeetings } = await renderStaff(staffSnapshot({ livePolls: [poll("poll-linked"), poll("poll-hidden"), poll("poll-closed", "closed")] }), meetings);
    await waitFor(() => expect(loadMeetings).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Live polls" }));
    expect(await screen.findByText(/^Meeting: Overtime meeting/)).toBeInTheDocument();
    expect(screen.getByText(t("en", "engagement.pollMeetingHidden"))).toBeInTheDocument();
    expect(screen.queryByLabelText("Meeting for Poll poll-closed")).toBeNull();
    const link = vi.spyOn(engagementApi, "setLivePollMeeting").mockResolvedValue({ pollId: "poll-hidden", eventId: "event-8am" });
    fireEvent.change(screen.getByLabelText("Meeting for Poll poll-hidden"), { target: { value: "event-8am" } });
    await waitFor(() => expect(link).toHaveBeenCalledWith({}, "poll-hidden", "event-8am"));

    const save = vi.spyOn(engagementApi, "saveLivePoll").mockResolvedValue({ id: "poll-new" });
    fireEvent.click(screen.getByRole("button", { name: "New live poll" }));
    const editor = screen.getByRole("button", { name: "Save live poll" }).closest("form");
    expect(within(editor).getByRole("option", { name: /Overtime meeting/ })).toBeInTheDocument();
    fireEvent.change(within(editor).getByLabelText("Question"), { target: { value: "File a group grievance?" } });
    fireEvent.change(within(editor).getByLabelText("Option 1"), { target: { value: "Yes" } });
    fireEvent.change(within(editor).getByLabelText("Option 2"), { target: { value: "No" } });
    fireEvent.change(within(editor).getByLabelText("Meeting"), { target: { value: "event-8am" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save live poll" }));
    await waitFor(() => expect(link).toHaveBeenCalledWith({}, "poll-new", "event-8am"));
    expect(save).toHaveBeenCalled();
  });

  it("renders polls as before when the meetings read is unavailable", async () => {
    vi.spyOn(engagementApi, "loadOrganizationSwitches").mockResolvedValue({ switches: {} });
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue(staffSnapshot({ livePolls: [poll("poll-a")] }));
    vi.spyOn(engagementApi, "loadLivePollMeetings").mockRejectedValue(Object.assign(new Error("missing"), { code: "PGRST202" }));
    wrap(<StaffEngagement client={{}} />);
    await screen.findByTestId("staff-engagement");
    fireEvent.click(screen.getByRole("button", { name: "Live polls" }));
    expect(await screen.findByText("Poll poll-a")).toBeInTheDocument();
    expect(screen.queryByLabelText("Meeting for Poll poll-a")).toBeNull();
  });
});

describe("the migration", () => {
  const sql = readFileSync("supabase/migrations/20261030203001_campaign_draft_delete_and_live_poll_meeting.sql", "utf8");

  it("deletes only a never-published standard draft under the publish predicate", () => {
    expect(sql).toContain("private.can_manage_vote_campaign(b.organization_id, b.chapter_id)");
    expect(sql).toContain("private.can_manage_vote_campaign(s.organization_id, s.chapter_id)");
    expect(sql).toContain("b.campaign_state = 'draft' and b.published_at is null");
    expect(sql).toContain("s.campaign_state = 'draft' and s.published_at is null");
    expect(sql).toContain("b.ballot_type = 'standard'");
    expect(sql).toContain("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[])");
    expect(sql).not.toMatch(/delete from public\.member_(ballots|surveys) where (?!id = p_campaign_id)/);
  });

  it("r2s1: sends no survey reminder after the close time, scheduled, manual or already queued", () => {
    expect(sql).toContain("if survey.status = 'open' and (survey.closes_at is null or survey.closes_at > pg_catalog.now()) then\n      -- Reminder cadence:");
    const queue = sql.slice(sql.indexOf("function public.queue_organization_survey_reminders"), sql.indexOf("function public.get_engagement_delivery_payload"));
    expect(queue).toContain("and (s.closes_at is null or s.closes_at > pg_catalog.now())");
    const payload = sql.slice(sql.indexOf("function public.get_engagement_delivery_payload"));
    expect(payload).toContain("and survey.organization_id = row.organization_id and survey.status = 'open'\n      -- An email queued before the close time is not sent after it.\n      and (survey.closes_at is null or survey.closes_at > pg_catalog.now());");
  });

  it("validates the meeting on every write and gives no execute beyond authenticated", () => {
    expect(sql).toContain("not private.live_poll_meeting_visible(org, next_event)");
    expect(sql).toContain("e.chapter_id = private.current_member_chapter()");
    expect(sql).toContain("where id = p_poll_id and organization_id = org");
    expect(sql).not.toMatch(/event_id text references/i);
    for (const fn of ["delete_vote_campaign_draft(text, text)", "set_organization_live_poll_event(uuid, text)", "get_live_poll_meetings()"]) {
      expect(sql).toContain(`revoke all on function public.${fn} from public, anon, authenticated, service_role;`);
      expect(sql).toContain(`grant execute on function public.${fn} to authenticated;`);
    }
    expect(sql).toContain("revoke all on function private.live_poll_meeting_visible(uuid, text) from public, anon, authenticated, service_role;");
  });
});
