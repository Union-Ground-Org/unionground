import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RETRY_TIME_OPTIONS, RosterInvitations } from "../src/components/RosterInvitations.jsx";
import { WorksiteSurveyReport } from "../src/components/WorksiteSurveyReport.jsx";
import { parseRosterInvitations } from "../src/features/memberOperations/rosterInvitations.js";
import { AdminInvitationError } from "../src/lib/adminInvitationApi.js";
import { dateTimeFormat } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
import { getMyProfileDetails, setMyProfileDetails } from "../src/lib/memberApi.js";
import { SettingsView } from "../src/views/SettingsView.jsx";

const wrap = (ui, lang = "en") => render(<LanguageProvider lang={lang}>{ui}</LanguageProvider>);

describe("invitation-only roster import", () => {
  it("does not let invalid rows reserve a later valid invitation", () => {
    const rows = parseRosterInvitations("email,full_name,locale\na@example.invalid,X,en\na@example.invalid,Alex Valid,en\nA@example.invalid,Alex Again,en\nb@example.invalid,Alex Wrong,fr\nb@example.invalid,Alex Spanish,es");
    expect(rows.map((row) => row.state)).toEqual(["invalid", "ready", "duplicate", "invalid", "ready"]);
  });
  it("keeps only invitation fields and skips duplicates and invalid rows", () => {
    const rows = parseRosterInvitations('email,full_name,locale,worksite\na@example.invalid,"Alex, Example",es,Secret site\nA@example.invalid,Other,en,Another\nbad,Too Short,fr,Elsewhere');
    expect(rows.map((row) => row.state)).toEqual(["ready", "duplicate", "invalid"]);
    expect(rows[0]).toEqual({ row: 2, email: "a@example.invalid", fullName: "Alex, Example", locale: "es", state: "ready" });
    expect(() => parseRosterInvitations("email\na@example.invalid")).toThrow("headers");
  });

  it("previews locally, stops on a refusal, and retries only unconfirmed rows", async () => {
    const api = { inviteMember: vi.fn().mockResolvedValueOnce({ accepted: true }).mockRejectedValueOnce(new Error("cap")).mockResolvedValue({ accepted: true }) };
    wrap(<RosterInvitations api={api} chapters={[{ id: "chapter-a", name: "Chapter A" }]} />);
    const file = { size: 200, text: async () => "email,full_name,shift\na@example.invalid,Alex One,Nights\nb@example.invalid,Alex Two,Nights\nc@example.invalid,Alex Three,Nights" };
    fireEvent.change(screen.getByLabelText(/Roster CSV/), { target: { files: [file] } });
    await screen.findByText("3 rows reviewed · 3 ready to invite");
    expect(api.inviteMember).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send 3 invitations" }));
    await screen.findByText(/Alex Two — Not confirmed/);
    expect(api.inviteMember).toHaveBeenCalledTimes(2);
    expect(api.inviteMember).toHaveBeenNthCalledWith(1, { email: "a@example.invalid", fullName: "Alex One", locale: "en", chapterId: "chapter-a", initialRole: null, source: "roster" });
    fireEvent.click(screen.getByRole("button", { name: "Send 2 invitations" }));
    await waitFor(() => expect(api.inviteMember).toHaveBeenCalledTimes(4));
    expect(api.inviteMember.mock.calls.map(([row]) => row.email)).toEqual(["a@example.invalid", "b@example.invalid", "b@example.invalid", "c@example.invalid"]);
    expect(screen.getByLabelText("Campaign for CSV invitations")).toBeDisabled();
  });

  // REQ-UG-BLOCK-GOVERNMENT-AND-EMPLOYER-EMAIL-DOMAINS-20261102: a
  // government or employer address is marked and skipped; the rest still go.
  it("skips a government or employer address and sends the rest of the roster", async () => {
    const blocked = new AdminInvitationError("email-domain-blocked", 400);
    const api = { inviteMember: vi.fn().mockResolvedValueOnce({ accepted: true }).mockRejectedValueOnce(blocked).mockResolvedValue({ accepted: true }) };
    wrap(<RosterInvitations api={api} chapters={[{ id: "chapter-a", name: "Chapter A" }]} />);
    const file = { size: 200, text: async () => "email,full_name\na@example.invalid,Alex One\nb@agency.gov,Alex Two\nc@example.invalid,Alex Three" };
    fireEvent.change(screen.getByLabelText(/Roster CSV/), { target: { files: [file] } });
    await screen.findByText("3 rows reviewed · 3 ready to invite");
    fireEvent.click(screen.getByRole("button", { name: "Send 3 invitations" }));
    await screen.findByText("Alex Three — Invitation accepted");
    expect(screen.getByText("Alex Two — Skipped: use a personal email, not a government or employer address")).toBeInTheDocument();
    expect(api.inviteMember).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: "Send 0 invitations" })).toBeDisabled();
  });

  // UX-UG-ROSTER-IMPORT-TAKES-DAYS-20261018: a roster-import limit
  // stop names the limit reached and when the next batch can go.
  it("names the roster limit reached and when to continue, then resumes from the waiting row", async () => {
    const retryAt = "2026-10-22T03:00:00.000Z";
    const refusal = new AdminInvitationError("rate-limited", 429, { limit: "limits.security.invitation_roster_admin_hourly", retryAt });
    const api = { inviteMember: vi.fn().mockResolvedValueOnce({ accepted: true }).mockRejectedValueOnce(refusal).mockResolvedValue({ accepted: true }) };
    wrap(<RosterInvitations api={api} chapters={[{ id: "chapter-a", name: "Chapter A" }]} />);
    const file = { size: 200, text: async () => "email,full_name\na@example.invalid,Alex One\nb@example.invalid,Alex Two\nc@example.invalid,Alex Three" };
    fireEvent.change(screen.getByLabelText(/Roster CSV/), { target: { files: [file] } });
    await screen.findByText("3 rows reviewed · 3 ready to invite");
    fireEvent.click(screen.getByRole("button", { name: "Send 3 invitations" }));
    const alert = await screen.findByRole("alert");
    const time = dateTimeFormat("en", RETRY_TIME_OPTIONS).format(new Date(retryAt));
    expect(time).toMatch(/\d{1,2}:\d{2}/);
    expect(time).not.toMatch(/:\d{2}:\d{2}/);
    expect(alert).toHaveTextContent(`Sending paused: you reached the hourly roster-import limit for administrators. After ${time}, send the remaining 2.`);
    expect(screen.getByText("Alex Two — Waiting for the next batch")).toBeInTheDocument();
    expect(screen.getByText("Alex Three — Ready")).toBeInTheDocument();
    expect(api.inviteMember).toHaveBeenCalledTimes(2);

    const daily = new AdminInvitationError("rate-limited", 429, { limit: "limits.security.invitation_roster_chapter_daily", retryAt });
    api.inviteMember.mockRejectedValueOnce(daily);
    fireEvent.click(screen.getByRole("button", { name: "Send 2 invitations" }));
    await screen.findByText(/this campaign reached its daily roster-import limit/);
    fireEvent.click(screen.getByRole("button", { name: "Send 2 invitations" }));
    await screen.findByText("Alex Three — Invitation accepted");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.inviteMember.mock.calls.map(([row]) => row.email)).toEqual(
      ["a@example.invalid", "b@example.invalid", "b@example.invalid", "b@example.invalid", "c@example.invalid"]);
  });

  it("does not send invalid rows or a file read that finished after replacement", async () => {
    let finish;
    const slow = { size: 100, text: () => new Promise((resolve) => { finish = resolve; }) };
    const api = { inviteMember: vi.fn() };
    wrap(<RosterInvitations api={api} chapters={[{ id: "chapter-a", name: "Chapter A" }]} />);
    const input = screen.getByLabelText(/Roster CSV/);
    fireEvent.change(input, { target: { files: [slow] } });
    fireEvent.change(input, { target: { files: [{ size: 100, text: async () => "email,full_name\nbad,One" }] } });
    await screen.findByText("1 rows reviewed · 0 ready to invite");
    finish("email,full_name\na@example.invalid,Alex One");
    await waitFor(() => expect(screen.getByRole("button", { name: "Send 0 invitations" })).toBeDisabled());
    expect(api.inviteMember).not.toHaveBeenCalled();
  });

  it("rejects oversized and unreadable files and clears the error when selection is cancelled", async () => {
    const api = { inviteMember: vi.fn() };
    wrap(<RosterInvitations api={api} chapters={[{ id: "chapter-a", name: "Chapter A" }]} />);
    const input = screen.getByLabelText(/Roster CSV/);
    const text = vi.fn();
    fireEvent.change(input, { target: { files: [{ size: 2 * 1024 * 1024 + 1, text }] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a valid CSV under 2 MB");
    expect(text).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { files: [] } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: /Send .* invitations/ })).toBeNull();
    fireEvent.change(input, { target: { files: [{ size: 100, text: vi.fn().mockRejectedValue(new Error("private read failure")) }] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a valid CSV under 2 MB");
    expect(screen.queryByText("private read failure")).toBeNull();
    expect(api.inviteMember).not.toHaveBeenCalled();
  });

  it("keeps a local preview unsendable without a permitted chapter", async () => {
    const api = { inviteMember: vi.fn() };
    wrap(<RosterInvitations api={api} chapters={[]} />);
    fireEvent.change(screen.getByLabelText(/Roster CSV/), { target: { files: [{ size: 100, text: async () => "email,full_name\na@example.invalid,Alex Member\nb@example.invalid," }] } });
    await screen.findByText("2 rows reviewed · 1 ready to invite");
    expect(screen.getByText("b@example.invalid — Skipped: check name, email or language")).toBeInTheDocument();
    const send = screen.getByRole("button", { name: "Send 1 invitations" });
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(api.inviteMember).not.toHaveBeenCalled();
  });

  it("stops on an unconfirmed response and refreshes without accepting the row", async () => {
    const api = { inviteMember: vi.fn().mockResolvedValue(null) };
    const reload = vi.fn();
    wrap(<RosterInvitations api={api} chapters={[{ id: "chapter-a", name: "Chapter A" }, { id: "chapter-b", name: "Chapter B" }]} reload={reload} />);
    fireEvent.change(screen.getByLabelText("Campaign for CSV invitations"), { target: { value: "chapter-b" } });
    fireEvent.change(screen.getByLabelText(/Roster CSV/), { target: { files: [{ size: 100, text: async () => "email,full_name\na@example.invalid,Alex One\nb@example.invalid,Alex Two" }] } });
    await screen.findByText("2 rows reviewed · 2 ready to invite");
    fireEvent.click(screen.getByRole("button", { name: "Send 2 invitations" }));
    await screen.findByText("Alex One — Not confirmed; retry later");
    expect(api.inviteMember).toHaveBeenCalledTimes(1);
    expect(api.inviteMember).toHaveBeenCalledWith({ email: "a@example.invalid", fullName: "Alex One", locale: "en", chapterId: "chapter-b", initialRole: null, source: "roster" });
    expect(screen.getByText("Alex Two — Ready")).toBeInTheDocument();
    expect(screen.queryByText(/— Invitation accepted/)).toBeNull();
    expect(screen.getByRole("button", { name: "Send 2 invitations" })).toBeEnabled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("discards a pending roster when the permitted chapter scope changes", async () => {
    const api = { inviteMember: vi.fn() };
    const view = wrap(<RosterInvitations api={api} chapters={[{ id: "old", name: "Old chapter" }]} />);
    fireEvent.change(screen.getByLabelText(/Roster CSV/), { target: { files: [{ size: 80, text: async () => "email,full_name\na@example.invalid,Alex Member" }] } });
    await screen.findByText(/1 rows reviewed/);
    view.rerender(<LanguageProvider lang="en"><RosterInvitations api={api} chapters={[{ id: "new", name: "New chapter" }]} /></LanguageProvider>);
    expect(screen.queryByText(/1 rows reviewed/)).toBeNull();
    expect(screen.getByLabelText("Campaign for CSV invitations")).toHaveValue("new");
    expect(api.inviteMember).not.toHaveBeenCalled();
  });
});

describe("member workplace attributes", () => {
  it("loads organization suggestions and saves all details atomically without a target member", async () => {
    const fields = { pronouns: null, jobTitle: null, worksite: "Main", shift: "Nights", classification: "Clerk", phone: null, detailsVisibility: "only_me", phoneVisibility: "only_me" };
    const client = { rpc: vi.fn(async (name, payload) => ({ data: name === "get_my_profile_details" ? { ...fields, workplaceOptions: { worksite: ["Main", "East"], shift: ["Days", "Nights"], classification: ["Clerk"] } } : payload.p_details, error: null })) };
    wrap(<SettingsView data={{ member: { id: "member-a", fullName: "Alex Member" }, roles: [], metrics: {}, cases: [], events: [], forms: [], product: { spaces: [] } }} onNavigate={vi.fn()} onProfile={vi.fn()} onAssistant={vi.fn()} lang="en" onLanguage={vi.fn()} profileDetailsApi={{ load: () => getMyProfileDetails(client), save: (next) => setMyProfileDetails(client, next) }} />);
    await screen.findByDisplayValue("Nights");
    expect(document.querySelector('datalist option[value="East"]')).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Shift"), { target: { value: "Days" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("set_my_profile_details_v2", { p_details: { ...fields, shift: "Days" } }));
  });
});

describe("worksite survey report", () => {
  it("explains an invalidated release without offering a later smaller cohort", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: { privacyMinResponses: 3, withheld: true, releaseChanged: true, groups: [] } }) };
    wrap(<WorksiteSurveyReport client={client} surveyId="survey-a" />);
    fireEvent.click(screen.getByRole("button", { name: "Results by worksite" }));
    await screen.findByText(/Comparing the changed groups could identify/);
    expect(screen.queryByText(/No worksite group can be shown safely yet/)).toBeNull();
  });
  it("renders the threshold, released aggregates and suppression, without identities", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: { privacyMinResponses: 3, withheld: true, groups: [{ worksite: "Main", responseCount: 6, questions: [{ id: "q", label: "Schedule", available: true, distribution: [{ value: "Days", count: 3 }, { value: "Nights", count: 3 }] }, { id: "q2", label: "Staffing", available: false, distribution: [] }] }] }, error: null }) };
    wrap(<WorksiteSurveyReport client={client} surveyId="survey-a" />);
    fireEvent.click(screen.getByRole("button", { name: "Results by worksite" }));
    await screen.findByText("Main · 6 responses");
    expect(screen.getByText(/Minimum: 3 responses/)).toBeInTheDocument();
    expect(screen.getByText(/Days: 3 · Nights: 3/)).toBeInTheDocument();
    expect(screen.getByText(/Answers hidden for privacy/)).toBeInTheDocument();
    expect(client.rpc).toHaveBeenCalledWith("get_organization_survey_worksites", { p_survey_id: "survey-a" });
  });

  it("reports malformed results as a retryable error, then explains an empty release", async () => {
    const client = { rpc: vi.fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { privacyMinResponses: 3, withheld: false, groups: [] }, error: null }) };
    wrap(<WorksiteSurveyReport client={client} surveyId="survey-a" />);
    fireEvent.click(screen.getByRole("button", { name: "Results by worksite" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Worksite results could not load. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Results by worksite" }));
    await screen.findByText("No worksite group can be shown safely yet.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Some groups are hidden for privacy, including worksites not shared with administrators.")).toBeNull();
    expect(client.rpc.mock.calls).toEqual([
      ["get_organization_survey_worksites", { p_survey_id: "survey-a" }],
      ["get_organization_survey_worksites", { p_survey_id: "survey-a" }],
    ]);
  });

  it("labels released non-string answer cells and available questions with no answers", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: { privacyMinResponses: 3, withheld: false, groups: [{ worksite: "Main", responseCount: 6, questions: [
      { id: "q", label: "Rating", available: true, distribution: [{ value: 4, count: 3 }, { value: null, count: 3 }] },
      { id: "q2", label: "Schedule", available: true, distribution: [] },
    ] }] }, error: null }) };
    wrap(<WorksiteSurveyReport client={client} surveyId="survey-a" />);
    fireEvent.click(screen.getByRole("button", { name: "Results by worksite" }));
    await screen.findByText("Main · 6 responses");
    expect(screen.getByText(/4: 3 · —: 3/)).toBeInTheDocument();
    expect(screen.getByText("Schedule:").closest("p")).toHaveTextContent("Schedule: No answers");
    expect(screen.queryByText("Answers hidden for privacy")).toBeNull();
  });

  it("explains the administrator boundary in Spanish", async () => {
    wrap(<WorksiteSurveyReport client={{ rpc: async () => ({ error: { code: "42501" } }) }} surveyId="survey-a" />, "es");
    fireEvent.click(screen.getByRole("button", { name: "Resultados por lugar de trabajo" }));
    await screen.findByText(/Solo los administradores de la organización/);
  });

  it("discards a report when the active client changes", async () => {
    const client = { rpc: async () => ({ data: { privacyMinResponses: 3, groups: [{ worksite: "Old scope", responseCount: 5, questions: [] }] } }) };
    const view = wrap(<WorksiteSurveyReport client={client} surveyId="survey-a" />);
    fireEvent.click(screen.getByRole("button", { name: "Results by worksite" }));
    await screen.findByText(/Old scope/);
    view.rerender(<LanguageProvider lang="en"><WorksiteSurveyReport client={{ rpc: vi.fn() }} surveyId="survey-b" /></LanguageProvider>);
    expect(screen.queryByText(/Old scope/)).toBeNull();
  });
});

describe("roster invitations keep focus while they are sent (record 8435)", () => {
  it("keeps Send invitations focused while the roster is sent, and sends each row once", async () => {
    const api = { inviteMember: vi.fn(async () => ({ accepted: true })) };
    wrap(<RosterInvitations api={api} chapters={[{ id: "chapter-a", name: "Chapter A" }]} />);
    const file = { size: 200, text: async () => "email,full_name,shift\na@example.invalid,Alex One,Nights\nb@example.invalid,Alex Two,Nights" };
    fireEvent.change(screen.getByLabelText(/Roster CSV/), { target: { files: [file] } });
    await screen.findByText("2 rows reviewed · 2 ready to invite");
    await expectHeldWriteFocus(api.inviteMember, screen.getByRole("button", { name: "Send 2 invitations" }));
    await waitFor(() => expect(api.inviteMember).toHaveBeenCalledTimes(2));
  });
});
