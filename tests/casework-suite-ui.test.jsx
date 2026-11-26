import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CaseworkHubPanel } from "../src/components/CaseworkHubPanel.jsx";
import { CaseworkOperationsPanel } from "../src/components/CaseworkOperationsPanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { DEFAULT_MANAGEMENT_CATEGORIES, managementCategoryMessageKey } from "../src/lib/configurableThresholds.js";
import { MemberApiError } from "../src/lib/memberApi.js";
import { CasesView } from "../src/views/CasesView.jsx";
import { CASEWORK_PANEL_REGISTER_MARKERS } from "./i18nRegisterMarkers.js";

const scope = { id: "case-1", organization_id: "org-1", chapter_id: "ch-1", step: "Intake", status: "active", is_restricted: false };
const caseData = {
  scope,
  strength: [{ id: "score-1", score: 72, band: "strong", created_at: "2026-08-28T12:00:00Z" }],
  deadlines: [],
  checklists: [{ id: "list-1", title: "Filing checklist", step: "Intake", items: [{ id: "item-1", label: "Confirm deadline", required: true, completed_at: null }] }],
  transitions: [],
  alerts: [],
  management: [],
  retaliation: [{ id: "report-1", status: "submitted", management_person: "A Manager", incident_at: "2026-08-28T12:00:00Z", protected_activity: "Filed a grievance", adverse_action: "Schedule changed" }],
  links: [],
  reminders: [],
};

const richCaseData = {
  ...caseData,
  scope: { ...scope, is_restricted: false },
  deadlines: [{ id: "deadline-1", label: "File response", due_at: "2026-09-01T12:00:00Z", status: "open", extensions: [{ id: "extension-1", status: "requested", requested_due_at: "2026-09-03T12:00:00Z" }] }],
  transitions: [{ id: "transition-1", from_step: "Triage", to_step: "Intake", outcome: "Accepted", created_at: "2026-08-27T12:00:00Z" }],
  alerts: [{ id: "alert-1", severity: "critical", status: "open", message: "Filing deadline approaching" }],
  management: [{ id: "entry-1", occurred_at: "2026-08-26T12:00:00Z", category: "scheduling", summary: "Changed assignment", casework_management_people: { display_name: "Manager One" }, casework_management_addenda: [{ id: "addendum-1", body: "Confirmed in writing", created_at: "2026-08-27T12:00:00Z" }] }],
  reminders: [{ id: "reminder-1", title: "Call member", remind_at: "2026-09-01T12:00:00Z", recurrence: "weekly", status: "active" }],
  links: [{ id: "link-1", target_case_id: "case-2", target_kind: "case", relationship: "same manager", note: "Shared facts" }],
  accessGrants: [],
};

function operationApi() {
  return {
    loadCaseworkCase: vi.fn().mockResolvedValue(caseData), scoreCase: vi.fn(), setCaseRestriction: vi.fn(),
    createCaseDeadline: vi.fn(), requestDeadlineExtension: vi.fn(), decideDeadlineExtension: vi.fn(), advanceCaseStep: vi.fn(),
    createCaseAlert: vi.fn(), acknowledgeCaseAlert: vi.fn(), createCaseReminder: vi.fn(), setReminderStatus: vi.fn(),
    setChecklistItem: vi.fn().mockResolvedValue({}), logManagementBehavior: vi.fn(), addManagementAddendum: vi.fn(), linkCases: vi.fn(),
  };
}

function article(name) {
  return screen.getByRole("heading", { name }).closest("article");
}

function setField(container, label, value) {
  fireEvent.change(within(container).getByLabelText(label), { target: { value } });
}

async function submitAndWait(container, buttonName, fn) {
  // The previous action's save and reload hold the panel busy until they settle.
  await waitFor(() => expect(within(container).getByRole("button", { name: buttonName })).toBeEnabled());
  fireEvent.click(within(container).getByRole("button", { name: buttonName }));
  await waitFor(() => expect(fn).toHaveBeenCalled(), { timeout: 3000 });
}

// REQ-UG-CONFIGURABLE-THRESHOLDS-20261001: management behavior categories
// and the summary window are organization settings.
describe("configurable management behavior categories and window", () => {
  it("offers the organization's categories, labels stored values, and counts each manager inside the window", async () => {
    const api = {
      ...operationApi(),
      loadCaseworkCase: vi.fn().mockResolvedValue({
        ...caseData,
        management: [{ id: "entry-9", occurred_at: "2026-08-26T12:00:00Z", category: "discipline", summary: "Issued a warning", casework_management_people: { id: "person-9", display_name: "Pat Manager" }, casework_management_addenda: [] }],
      }),
      loadManagementWindow: vi.fn().mockResolvedValue({ "person-9": 3 }),
    };
    const organizationConfiguration = { switches: {
      "lists.casework.management_behavior_categories": ["Weingarten denial", "Badge surveillance"],
      "limits.casework.management_behavior_window_days": 30,
    } };
    render(<LanguageProvider lang="es"><CaseworkOperationsPanel caseId="case-1" api={api} organizationConfiguration={organizationConfiguration} /></LanguageProvider>);
    const log = (await screen.findByRole("heading", { name: "Registro de conducta gerencial" })).closest("article");
    const select = within(log).getByLabelText("Categoría");
    expect([...select.options].map((option) => [option.value, option.text])).toEqual([
      ["Weingarten denial", "Derecho a actuar en conjunto negado"],
      ["Badge surveillance", "Badge surveillance"],
    ]);
    // A legacy token stored before the list became editable still reads in the member's language.
    expect(within(log).getByText(/Disciplina/)).toBeInTheDocument();
    await waitFor(() => expect(api.loadManagementWindow).toHaveBeenCalledWith(["person-9"], 30));
    expect(await within(log).findByText("Pat Manager: 3 registros en los últimos 30 días en los asuntos que puedes ver")).toBeInTheDocument();
  });

  it("defaults to the old app's seven categories without a configuration", async () => {
    render(<LanguageProvider lang="en"><CaseworkOperationsPanel caseId="case-1" api={operationApi()} /></LanguageProvider>);
    const log = (await screen.findByRole("heading", { name: "Management behavior log" })).closest("article");
    expect([...within(log).getByLabelText("Category").options].map((option) => option.value)).toEqual([
      "Verbal threat", "Intimidation", "Policy change (unilateral)", "Weingarten denial", "Retaliation", "Discrimination", "Other",
    ]);
  });

  // PR #8 copy decision: "Weingarten denial" is kept only as a stored value
  // for data compatibility. Every label a worker or organizer reads is
  // organizing language, because Weingarten rights belong to a recognized
  // union; "Retaliation" stays as it is.
  it.each([
    ["en", "Management behavior log", "Category", "Denied right to act together", "Retaliation"],
    ["es", "Registro de conducta gerencial", "Categoría", "Derecho a actuar en conjunto negado", "Represalia"],
  ])("labels the stored Weingarten value in organizing language in %s", async (lang, heading, label, denied, retaliation) => {
    render(<LanguageProvider lang={lang}><CaseworkOperationsPanel caseId="case-1" api={operationApi()} /></LanguageProvider>);
    const log = (await screen.findByRole("heading", { name: heading })).closest("article");
    const options = [...within(log).getByLabelText(label).options];
    expect(options.find((option) => option.value === "Weingarten denial")?.text).toBe(denied);
    expect(options.find((option) => option.value === "Retaliation")?.text).toBe(retaliation);
    expect(options.filter((option) => /weingarten/i.test(option.text))).toEqual([]);
    expect(within(log).queryByText(/weingarten/i)).toBeNull();
  });

  it("keeps Weingarten out of every catalogue label and every native label", () => {
    for (const lang of ["en", "es"]) {
      const values = Object.entries(catalogue[lang])
        .filter(([key, value]) => key.startsWith("casework.tools.category.") && typeof value === "string")
        .map(([, value]) => value);
      expect(values.filter((value) => /weingarten/i.test(value)), lang).toEqual([]);
    }
    // The native app shows no management behavior category; if it ever does,
    // it must not print the stored token either.
    const nativeSources = readdirSync("apps/mobile/src", { recursive: true })
      .filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name))
      .map((name) => [name, readFileSync(`apps/mobile/src/${name}`, "utf8")]);
    expect(nativeSources.filter(([, source]) => /Weingarten denial/i.test(source)).map(([name]) => name)).toEqual([]);
  });
});

describe("MI1 casework UI", () => {
  // Union Ground issues have no grievance procedure (owner decision,
  // 2026-10-13): no step progression, no stage checklists, no unfair labor
  // practice filing window and no suggested score — even when the api double
  // still carries the old methods and the payload still carries a checklist.
  it("renders the complete case-scoped workspace without step, checklist, ULP, or suggested-score tools", async () => {
    const api = {
      ...operationApi(),
      getCaseProcedure: vi.fn(),
      listCaseRetaliationFlags: vi.fn().mockResolvedValue([]),
      suggestCaseStrength: vi.fn(),
    };
    render(<LanguageProvider lang="en"><CaseworkOperationsPanel caseId="case-1" caseOptions={[{ id: "case-2", reference: "GRV-2", title: "Related issue" }]} api={api} /></LanguageProvider>);
    expect(await screen.findByText("Issue tools")).toBeInTheDocument();
    for (const heading of ["Strength check", "Restricted access", "Deadline center", "Alerts", "Management behavior log", "Retaliation reports", "Follow-up reminders", "Issue graph"]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    for (const heading of ["Step progression", "Stage checklists", "Suggested score"]) {
      expect(screen.queryByRole("heading", { name: heading })).toBeNull();
    }
    expect(screen.queryByRole("heading", { name: /unfair labor practice|ULP/i })).toBeNull();
    expect(screen.queryByText("Current step")).toBeNull();
    expect(screen.queryByRole("button", { name: "Advance step" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Suggest a score" })).toBeNull();
    expect(screen.queryByText("Filing checklist")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Confirm deadline/ })).toBeNull();
    expect(document.getElementById("casework-step-case-1")).toBeNull();
    expect(api.getCaseProcedure).not.toHaveBeenCalled();
    expect(api.listCaseRetaliationFlags).not.toHaveBeenCalled();
    expect(api.suggestCaseStrength).not.toHaveBeenCalled();
    expect(api.setChecklistItem).not.toHaveBeenCalled();
  });

  it("executes every case-scoped steward workflow from the operations panel", async () => {
    const api = operationApi();
    api.loadCaseworkCase.mockResolvedValue(richCaseData);
    const onNotice = vi.fn();
    render(<LanguageProvider lang="en"><CaseworkOperationsPanel caseId="case-1" caseOptions={[{ id: "case-2", reference: "GRV-2", title: "Related issue" }]} api={api} onNotice={onNotice} /></LanguageProvider>);
    expect(await screen.findByText("Issue tools")).toBeInTheDocument();

    await submitAndWait(article("Strength check"), "Save strength check", api.scoreCase);

    const restriction = article("Restricted access");
    setField(restriction, "Reason", "Sensitive witness information");
    await submitAndWait(restriction, "Restrict issue", api.setCaseRestriction);

    expect(screen.queryByRole("heading", { name: "Step progression" })).toBeNull();

    const deadline = article("Deadline center");
    setField(deadline, "Requested extension", "2026-09-03T12:00"); setField(deadline, "Extension reason", "Waiting for complete records");
    await submitAndWait(deadline, "Request extension", api.requestDeadlineExtension);
    await submitAndWait(deadline, "Approve", api.decideDeadlineExtension);
    await waitFor(() => { expect(within(deadline).getByRole("button", { name: "Deny" })).toBeEnabled(); expect((within(deadline).getByRole("button", { name: "Deny" })).closest('[aria-disabled="true"]')).toBeNull(); });
    fireEvent.click(within(deadline).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(api.decideDeadlineExtension).toHaveBeenCalledWith("extension-1", "denied"), { timeout: 3000 });
    // Deadline kinds are response and follow-up only.
    expect([...within(deadline).getByLabelText("Deadline type").options].map((option) => option.value)).toEqual(["response", "follow_up"]);
    setField(deadline, "Deadline label", "Follow up with HR"); setField(deadline, "Deadline type", "follow_up"); setField(deadline, "Due date and time", "2026-09-10T12:00"); setField(deadline, "Reminder (optional)", "2026-09-09T12:00");
    await submitAndWait(deadline, "Add deadline", api.createCaseDeadline);
    expect(api.createCaseDeadline).toHaveBeenCalledWith(expect.objectContaining({ id: "case-1" }), expect.objectContaining({ kind: "follow_up", label: "Follow up with HR" }));

    const alerts = article("Alerts");
    await submitAndWait(alerts, "Acknowledge", api.acknowledgeCaseAlert);
    setField(alerts, "Alert message", "Member needs an immediate update"); setField(alerts, "Severity", "critical"); setField(alerts, "Escalate if unacknowledged (optional)", "2026-09-01T12:00");
    await submitAndWait(alerts, "Add alert", api.createCaseAlert);

    const management = article("Management behavior log");
    setField(management, "Add correction or context", "Corrected meeting time");
    await submitAndWait(management, "Add", api.addManagementAddendum);
    setField(management, "Management person", "Manager Two"); setField(management, "Occurred", "2026-08-28T12:00"); setField(management, "Observation", "Changed the member assignment without notice");
    await submitAndWait(management, "Log behavior", api.logManagementBehavior);

    const reminders = article("Follow-up reminders");
    await submitAndWait(reminders, "Done", api.setReminderStatus);
    await waitFor(() => { expect(within(reminders).getByRole("button", { name: "Dismiss" })).toBeEnabled(); expect((within(reminders).getByRole("button", { name: "Dismiss" })).closest('[aria-disabled="true"]')).toBeNull(); });
    fireEvent.click(within(reminders).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(api.setReminderStatus).toHaveBeenCalledWith("reminder-1", "dismissed"), { timeout: 3000 });
    setField(reminders, "Reminder", "Call witness"); setField(reminders, "Remind me", "2026-09-02T12:00"); setField(reminders, "Repeat", "weekly");
    await submitAndWait(reminders, "Add reminder", api.createCaseReminder);

    const graph = article("Issue graph");
    setField(graph, "Related issue", "case-2"); setField(graph, "Relationship", "same supervisor"); setField(graph, "Note (optional)", "Overlapping evidence");
    await submitAndWait(graph, "Link issues", api.linkCases);
    expect(onNotice).toHaveBeenCalledWith("Issue tools updated.");
    // The stored transitions never render as a step history, and no step move is offered.
    expect(screen.queryByText(/Triage → Intake/)).toBeNull();
    expect(api.advanceCaseStep).not.toHaveBeenCalled();
  });

  it("manages explicit access and recovers from load and action failures", async () => {
    const api = operationApi();
    api.loadCaseworkCase
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ ...richCaseData, scope: { ...scope, is_restricted: true, restriction_reason: "Sensitive" }, accessGrants: [{ id: "grant-1", grantee_user_id: "staff-2", revoked_at: null }] });
    api.loadAccessCandidates = vi.fn().mockResolvedValue([{ userId: "staff-2", fullName: "Staff Two", roles: ["steward"] }, { userId: "staff-3", fullName: "Staff Three", roles: ["admin"] }]);
    api.grantCaseAccess = vi.fn().mockRejectedValue(new Error("Grant blocked")); api.revokeCaseAccess = vi.fn();
    const onNotice = vi.fn();
    render(<LanguageProvider lang="en"><CaseworkOperationsPanel caseId="case-1" api={api} onNotice={onNotice} /></LanguageProvider>);
    expect(await screen.findByText("Issue tools are unavailable.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Staff Two")).toBeInTheDocument();
    const restriction = article("Restricted access");
    await submitAndWait(restriction, "Revoke", api.revokeCaseAccess);
    setField(restriction, "Person in the organization", "staff-3");
    setField(restriction, "Reason for access", "Preparing the arbitration file");
    await waitFor(() => { expect(within(restriction).getByRole("button", { name: "Grant access" })).toBeEnabled(); expect((within(restriction).getByRole("button", { name: "Grant access" })).closest('[aria-disabled="true"]')).toBeNull(); });
    fireEvent.click(within(restriction).getByRole("button", { name: "Grant access" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("That casework action could not be saved."));
    await submitAndWait(restriction, "Remove restriction", api.setCaseRestriction);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.loadCaseworkCase.mock.calls.length).toBeGreaterThan(3));
  });

  // UX-UG-STEWARD-DESK-EXPLICIT-ACCESS-GRANTEE-PICKER-ALWAYS-EMPTY-LOADER-20260921:
  // the candidate read refuses a steward with 42501, which the panel used to
  // turn into a required picker holding only the placeholder.
  it("names explicit access as a campaign lead action when the candidate read is refused", async () => {
    const api = operationApi();
    api.loadCaseworkCase.mockResolvedValue({ ...richCaseData, scope: { ...scope, is_restricted: true, restriction_reason: "Sensitive" } });
    api.loadAccessCandidates = vi.fn().mockRejectedValue(Object.assign(new Error("coordinator role and MFA required"), { code: "42501" }));
    api.grantCaseAccess = vi.fn(); api.revokeCaseAccess = vi.fn();
    render(<LanguageProvider lang="en"><CaseworkOperationsPanel caseId="case-1" api={api} /></LanguageProvider>);
    const restriction = await waitFor(() => article("Restricted access"));
    expect(await within(restriction).findByText(/Granting explicit access is a campaign lead action/)).toBeInTheDocument();
    expect(within(restriction).queryByLabelText("Person in the organization")).not.toBeInTheDocument();
    expect(within(restriction).queryByRole("button", { name: "Grant access" })).not.toBeInTheDocument();
    expect(api.grantCaseAccess).not.toHaveBeenCalled();
  });

  it("offers a retry instead of an empty grantee picker when the candidate read fails", async () => {
    const api = operationApi();
    api.loadCaseworkCase.mockResolvedValue({ ...richCaseData, scope: { ...scope, is_restricted: true, restriction_reason: "Sensitive" } });
    api.loadAccessCandidates = vi.fn()
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValue([{ userId: "staff-2", fullName: "Staff Two", roles: ["steward"] }]);
    api.grantCaseAccess = vi.fn(); api.revokeCaseAccess = vi.fn();
    render(<LanguageProvider lang="en"><CaseworkOperationsPanel caseId="case-1" api={api} /></LanguageProvider>);
    const restriction = await waitFor(() => article("Restricted access"));
    expect(await within(restriction).findByText("The worker list could not be loaded.")).toBeInTheDocument();
    expect(within(restriction).queryByLabelText("Person in the organization")).not.toBeInTheDocument();
    expect(within(restriction).queryByText(/campaign lead action/)).not.toBeInTheDocument();
    fireEvent.click(within(restriction).getByRole("button", { name: "Try again" }));
    expect(await within(restriction).findByRole("option", { name: "Staff Two · steward" })).toBeInTheDocument();
    expect(within(restriction).getByRole("button", { name: "Grant access" })).toBeInTheDocument();
    expect(api.loadAccessCandidates).toHaveBeenCalledTimes(2);
  });

  it("renders bargaining live, autosaved intake, retaliation review, history filters, and bulk controls", async () => {
    const api = {
      loadCaseworkHub: vi.fn().mockResolvedValue({
        workspaces: [{ id: "workspace-1", title: "2027 bargaining", status: "live", starts_at: "2026-08-28T14:00:00Z", proposals: [{ id: "proposal-1", title: "Article 3", side: "union", body: "Initial language", status: "proposed", response_due_at: "2026-08-30T14:00:00Z" }], events: [{ id: "event-1", body: "Caucus complete", pulse: "steady", event_type: "pulse", created_at: "2026-08-28T15:00:00Z" }] }],
        drafts: [{ id: "draft-1", revision: 2, case_id: "case-1", payload: { title: "Intake draft", notes: "Initial notes" }, updated_at: "2026-08-28T15:00:00Z" }],
        patterns: [{ id: "pattern-1", report_count: 3, status: "flagged", disposition: null }],
      }),
      loadCaseworkHistory: vi.fn().mockResolvedValue({ rows: [{ id: "case-1", reference: "GRV-1", title: "Schedule case", status: "active", case_type: "Scheduling", step: "Intake", is_restricted: false, member: { full_name: "Member One" } }], total: 1, page: 0, pageSize: 50 }),
      saveIntakeDraft: vi.fn().mockResolvedValue({ id: "draft-1", revision: 3, updated_at: "2026-08-28T16:00:00Z" }),
      scanRetaliationPatterns: vi.fn(), reviewRetaliationPattern: vi.fn(), bulkUpdateCases: vi.fn(),
      createBargainingWorkspace: vi.fn(), addBargainingProposal: vi.fn(), transitionBargainingProposal: vi.fn(), addBargainingEvent: vi.fn(), setBargainingStatus: vi.fn(),
    };
    render(<LanguageProvider lang="en"><CaseworkHubPanel chapterId="ch-1" caseOptions={[{ id: "case-1", reference: "GRV-1", title: "Schedule case" }]} api={api} /></LanguageProvider>);
    expect(await screen.findByText("Issue work hub")).toBeInTheDocument();
    expect(screen.getByText("2027 bargaining")).toBeInTheDocument();
    expect(screen.getByText("Caucus complete")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Intake draft autosave" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Retaliation pattern review" })).toBeInTheDocument();
    expect(await screen.findByText("Member One")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Scan reports" }));
    await waitFor(() => expect(api.scanRetaliationPatterns).toHaveBeenCalledWith("ch-1"));
    const intake = screen.getByRole("heading", { name: "Intake draft autosave" }).closest("article");
    fireEvent.change(within(intake).getByLabelText("Draft title"), { target: { value: "Recovered intake" } });
    await waitFor(() => expect(api.saveIntakeDraft).toHaveBeenCalledWith(expect.objectContaining({ id: "draft-1", revision: 2, payload: expect.objectContaining({ title: "Recovered intake" }) })), { timeout: 1500 });
  });

  it("executes bargaining, pattern, filtering, paging, and grouped bulk workflows with no checklist templates", async () => {
    const now = Date.now();
    const hub = {
      workspaces: [{
        id: "workspace-1", title: "2027 bargaining", status: "live", starts_at: null,
        proposals: [
          { id: "proposal-1", title: "Past response", side: "management", body: "Past language", status: "proposed", response_due_at: new Date(now - 3600000).toISOString() },
          { id: "proposal-2", title: "Near response", side: "union", body: "Near language", status: "countered", response_due_at: new Date(now + 3600000).toISOString() },
          { id: "proposal-3", title: "Open response", side: "joint", body: "Open language", status: "draft", response_due_at: null },
        ],
        events: [{ id: "event-1", body: "Urgent caucus", pulse: "urgent", created_at: "2026-08-28T15:00:00Z" }],
      }],
      drafts: [],
      templates: [{ id: "template-1", title: "Intake steps", case_type: "Scheduling", step: "Intake", items: [{ label: "Call" }] }],
      patterns: [{ id: "pattern-1", subject_label: "Manager One", report_count: 3, status: "flagged", disposition: null, casework_retaliation_pattern_notes: [{ id: "note-1", body: "Review assignment history" }] }],
    };
    const historyRows = [
      { id: "case-1", reference: "GRV-1", title: "Schedule case", status: "active", case_type: "Scheduling", step: "Intake", is_restricted: true, member: { full_name: "Member One" } },
      { id: "case-3", reference: "GRV-3", title: "Overtime case", status: "active", case_type: "Scheduling", step: "Intake", is_restricted: false, member: { full_name: "Member Three" } },
      { id: "case-2", reference: "GRV-2", title: "Safety case", status: "resolved", case_type: "Safety", step: "Closed", is_restricted: false, member: null },
    ];
    const api = {
      loadCaseworkHub: vi.fn().mockResolvedValue(hub),
      loadCaseworkHistory: vi.fn(async (options = {}) => ({ rows: historyRows, total: 120, page: options.page || 0, pageSize: 50 })),
      saveIntakeDraft: vi.fn(), scanRetaliationPatterns: vi.fn(), reviewRetaliationPattern: vi.fn(), bulkUpdateCases: vi.fn(),
      createChecklistTemplate: vi.fn(), createBargainingWorkspace: vi.fn(), addBargainingProposal: vi.fn(), transitionBargainingProposal: vi.fn(), addBargainingEvent: vi.fn(), setBargainingStatus: vi.fn(),
    };
    const onNotice = vi.fn();
    render(<LanguageProvider lang="en"><CaseworkHubPanel chapterId="ch-1" caseOptions={[{ id: "case-1", reference: "GRV-1", title: "Schedule case" }]} api={api} onNotice={onNotice} /></LanguageProvider>);
    expect(await screen.findByText("Issue work hub")).toBeInTheDocument();
    expect(await screen.findByText("Member One")).toBeInTheDocument();

    const bargaining = article("Bargaining");
    const sessionForm = within(bargaining).getByLabelText("Session status").closest("form");
    setField(sessionForm, "Session status", "paused"); fireEvent.submit(sessionForm);
    await waitFor(() => expect(api.setBargainingStatus).toHaveBeenCalledWith("workspace-1", "live", "paused"));
    const proposalForm = within(bargaining).getAllByLabelText("Proposal status")[0].closest("form");
    await waitFor(() => { expect(within(proposalForm).getByRole("button")).toBeEnabled(); expect((within(proposalForm).getByRole("button")).closest('[aria-disabled="true"]')).toBeNull(); });
    setField(proposalForm, "Proposal status", "accepted"); setField(proposalForm, "Response due (optional)", "2026-09-10T12:00"); fireEvent.submit(proposalForm);
    await waitFor(() => expect(api.transitionBargainingProposal).toHaveBeenCalledWith("proposal-1", "proposed", "accepted", expect.any(String)));
    const newProposal = within(bargaining).getByRole("heading", { name: "New proposal" }).closest("form");
    setField(newProposal, "Side", "joint"); setField(newProposal, "Proposal title", "Article 8"); setField(newProposal, "Proposal text", "Joint health and safety language");
    await submitAndWait(newProposal, "Add proposal", api.addBargainingProposal);
    const liveUpdate = within(bargaining).getByLabelText("Live timeline update").closest("form");
    setField(liveUpdate, "Live timeline update", "Management returned to the table"); setField(liveUpdate, "Team pulse", "watch");
    await submitAndWait(liveUpdate, "Add update", api.addBargainingEvent);
    const workspaceForm = within(bargaining).getByRole("button", { name: "Create workspace" }).closest("form");
    setField(workspaceForm, "Workspace title", "2028 bargaining"); setField(workspaceForm, "Session starts (optional)", "2027-09-01T12:00");
    await submitAndWait(workspaceForm, "Create workspace", api.createBargainingWorkspace);

    // Step checklist templates are gone with the grievance procedure: no
    // panel, no jump link, and the stored template never renders, even though
    // the api double still carries createChecklistTemplate.
    expect(screen.queryByRole("heading", { name: "Checklist templates" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Checklist templates" })).toBeNull();
    expect(screen.queryByText("Intake steps")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create template" })).toBeNull();
    expect(api.createChecklistTemplate).not.toHaveBeenCalled();

    const patterns = article("Retaliation pattern review");
    await submitAndWait(patterns, "Scan reports", api.scanRetaliationPatterns);
    setField(patterns, "Review status", "investigating"); setField(patterns, "Disposition", "Shared supervisor"); setField(patterns, "Investigation note (optional)", "Compare scheduling records");
    await submitAndWait(patterns, "Save review", api.reviewRetaliationPattern);

    const history = article("Advanced issue operations");
    setField(history, "Search reference or title", "GRV"); setField(history, "Issue status", "active"); setField(history, "Issue type", "Scheduling"); setField(history, "Access", "restricted");
    await submitAndWait(history, "Apply filters", api.loadCaseworkHistory);
    // Selection made while the filtered page is still loading is reset when it arrives.
    await waitFor(() => { expect(within(history).getByRole("button", { name: "Apply filters" })).toBeEnabled(); expect((within(history).getByRole("button", { name: "Apply filters" })).closest('[aria-disabled="true"]')).toBeNull(); });
    // No step filter, no step in the query, and no step on a row.
    expect(within(history).queryByLabelText("Step contains")).toBeNull();
    await waitFor(() => expect(api.loadCaseworkHistory).toHaveBeenLastCalledWith(expect.objectContaining({ search: "GRV", status: "active", caseType: "Scheduling", restricted: "restricted" })));
    expect(api.loadCaseworkHistory.mock.calls.at(-1)[0]).not.toHaveProperty("step");
    expect(within(history).queryByText("Scheduling · Intake")).toBeNull();
    expect(within(history).queryByText("Safety · Closed")).toBeNull();
    // The panel offers no step box: casework_bulk_update_cases may never carry
    // a step, so a status is the whole of this batch update.
    expect(within(history).queryByLabelText(/New step/)).toBeNull();
    // A mixed-status selection cannot be updated at all: the routine takes one
    // expected status for the whole batch, so the update is refused before the
    // request — with the reason stated — instead of half-applying group by
    // group and leaving a stale selection behind on failure.
    fireEvent.click(within(history).getByRole("checkbox", { name: /Member One/ }));
    fireEvent.click(within(history).getByRole("checkbox", { name: /Member Three/ }));
    fireEvent.click(within(history).getByRole("checkbox", { name: /GRV-2/ }));
    const updateSelected = () => within(history).getByRole("button", { name: "Update selected" });
    expect(updateSelected()).toBeDisabled();
    expect(within(history).getByRole("alert")).toHaveTextContent("The selection mixes active and resolved issues");
    fireEvent.click(within(history).getByRole("checkbox", { name: /GRV-2/ }));
    expect(within(history).queryByRole("alert")).toBeNull();
    expect(updateSelected()).toBeDisabled(); // no new status chosen yet
    setField(history, "New status", "resolved");
    await waitFor(() => { expect(updateSelected()).toBeEnabled(); expect((updateSelected()).closest('[aria-disabled="true"]')).toBeNull(); });
    fireEvent.click(updateSelected());
    await waitFor(() => expect(api.bulkUpdateCases).toHaveBeenCalledTimes(1));
    expect(api.bulkUpdateCases).toHaveBeenCalledWith(["case-1", "case-3"], "active", { status: "resolved" });
    await waitFor(() => expect(api.loadCaseworkHistory.mock.calls.length).toBeGreaterThan(2));
    expect(within(history).getByText("0 selected")).toBeInTheDocument();
    // A failed batch can still have moved rows, so the panel reconciles the
    // visible rows and the selection from the server instead of keeping a
    // selection whose expected status is already stale.
    api.bulkUpdateCases.mockRejectedValueOnce(new Error("batch refused"));
    const callsBefore = api.loadCaseworkHistory.mock.calls.length;
    fireEvent.click(within(history).getByRole("checkbox", { name: /Member One/ }));
    await waitFor(() => { expect(updateSelected()).toBeEnabled(); expect((updateSelected()).closest('[aria-disabled="true"]')).toBeNull(); });
    fireEvent.click(updateSelected());
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("That casework action could not be saved."));
    await waitFor(() => expect(api.loadCaseworkHistory.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(within(history).getByText("0 selected")).toBeInTheDocument();
    expect(api.bulkUpdateCases).toHaveBeenCalledTimes(2);
    fireEvent.click(within(history).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(api.loadCaseworkHistory).toHaveBeenCalledWith(expect.objectContaining({ page: 1 })));
    await waitFor(() => { expect(within(history).getByRole("button", { name: "Previous" })).toBeEnabled(); expect((within(history).getByRole("button", { name: "Previous" })).closest('[aria-disabled="true"]')).toBeNull(); });
    fireEvent.click(within(history).getByRole("button", { name: "Previous" }));
    await waitFor(() => expect(api.loadCaseworkHistory).toHaveBeenCalledWith(expect.objectContaining({ page: 0 })));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.loadCaseworkHub.mock.calls.length).toBeGreaterThan(7));
    expect(onNotice).toHaveBeenCalledWith("Issue work hub updated.");
  });

  it("explains a mixed-status selection in English and Spanish before any request", async () => {
    const rows = [
      { id: "case-1", reference: "GRV-1", title: "Schedule case", status: "active", case_type: "Scheduling", step: "Intake", is_restricted: false, member: { full_name: "Member One" } },
      { id: "case-2", reference: "GRV-2", title: "Safety case", status: "resolved", case_type: "Safety", step: "Closed", is_restricted: false, member: null },
    ];
    for (const [lang, reason] of [
      ["en", "The selection mixes active and resolved issues"],
      ["es", "La selección mezcla asuntos activos y resueltos"],
    ]) {
      const api = {
        loadCaseworkHub: vi.fn().mockResolvedValue({ workspaces: [], drafts: [], patterns: [] }),
        loadCaseworkHistory: vi.fn().mockResolvedValue({ rows, total: 2, page: 0, pageSize: 50 }),
        bulkUpdateCases: vi.fn(),
      };
      const { unmount } = render(<LanguageProvider lang={lang}><CaseworkHubPanel chapterId="ch-1" caseOptions={[]} api={api} /></LanguageProvider>);
      expect(await screen.findByText("Member One")).toBeInTheDocument();
      const history = article(lang === "en" ? "Advanced issue operations" : "Operaciones avanzadas de asuntos");
      fireEvent.click(within(history).getByRole("checkbox", { name: /Member One/ }));
      fireEvent.click(within(history).getByRole("checkbox", { name: /GRV-2/ }));
      expect(within(history).getByRole("alert")).toHaveTextContent(reason);
      expect(api.bulkUpdateCases).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("recovers the hub, exposes history errors, and reports autosave failures", async () => {
    const api = {
      loadCaseworkHub: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ workspaces: [], drafts: [], patterns: [], templates: [] }),
      loadCaseworkHistory: vi.fn().mockRejectedValue(new Error("history unavailable")),
      saveIntakeDraft: vi.fn().mockRejectedValue(new Error("Revision conflict")),
      scanRetaliationPatterns: vi.fn().mockRejectedValue(new Error()),
      createChecklistTemplate: vi.fn(),
    };
    const onNotice = vi.fn();
    render(<LanguageProvider lang="es"><CaseworkHubPanel chapterId="ch-1" api={api} onNotice={onNotice} /></LanguageProvider>);
    expect(await screen.findByText("El centro de seguimiento de asuntos no está disponible.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Intentar de nuevo" }));
    expect(await screen.findByText("Centro de seguimiento de asuntos")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("El centro de seguimiento de asuntos no está disponible.");
    const intake = article("Autoguardado de borrador");
    setField(intake, "Título del borrador", "Borrador recuperado");
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("No se pudo guardar esa acción."), { timeout: 1500 });
    const patterns = article("Revisión de patrones de represalias");
    fireEvent.click(within(patterns).getByRole("button", { name: "Analizar informes" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("No se pudo guardar esa acción."));
  });

  it("names the casework hub, never a casework center, in its loading and unavailable copy in both languages", async () => {
    // #2043 renamed the surface on the heading only; the panel's own COPY table
    // still called it a "casework center" in the states a steward sees when the
    // hub is slow or down.
    // Comments are stripped first, the way tests/i18n-coverage.test.jsx does it,
    // so a comment that names the retired wording is not mistaken for it.
    const source = readFileSync(resolve(process.cwd(), "src/components/CaseworkHubPanel.jsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(source.toLowerCase()).not.toContain("casework center");
    for (const [lang, loading, unavailable, retry] of [
      ["en", "Loading the issue work hub…", "The issue work hub is unavailable.", "Try again"],
      ["es", "Cargando el centro de seguimiento de asuntos…", "El centro de seguimiento de asuntos no está disponible.", "Intentar de nuevo"],
    ]) {
      const pending = { loadCaseworkHub: vi.fn(() => new Promise(() => {})) };
      const held = render(<LanguageProvider lang={lang}><CaseworkHubPanel chapterId="ch-1" api={pending} /></LanguageProvider>);
      expect(await screen.findByText(loading), lang).toBeInTheDocument();
      held.unmount();
      const failing = { loadCaseworkHub: vi.fn().mockRejectedValue(new Error("offline")) };
      const down = render(<LanguageProvider lang={lang}><CaseworkHubPanel chapterId="ch-1" api={failing} /></LanguageProvider>);
      expect(await screen.findByText(unavailable), lang).toBeInTheDocument();
      expect(screen.getByRole("button", { name: retry }), lang).toBeInTheDocument();
      down.unmount();
    }
  });

  it("uses one surface name for the hub heading in both languages", async () => {
    const api = { loadCaseworkHub: vi.fn().mockResolvedValue({ workspaces: [], drafts: [], patterns: [] }) };
    for (const [lang, name] of [["en", "Issue work hub"], ["es", "Centro de seguimiento de asuntos"]]) {
      const { unmount } = render(<LanguageProvider lang={lang}><CaseworkHubPanel chapterId="ch-1" api={api} /></LanguageProvider>);
      expect(await screen.findByRole("heading", { level: 2, name })).toBeInTheDocument();
      unmount();
    }
  });

  it("labels the new-proposal title apart from the workspace title in English and Spanish", async () => {
    const workspace = {
      id: "workspace-1", title: "2027 bargaining", status: "planning", starts_at: null, proposals: [], events: [],
    };
    const labels = {
      en: { bargaining: "Bargaining", proposal: "New proposal", proposalTitle: "Proposal title", workspaceTitle: "Workspace title" },
      es: { bargaining: "Negociación", proposal: "Nueva propuesta", proposalTitle: "Título de la propuesta", workspaceTitle: "Nombre del espacio" },
    };
    for (const [lang, copy] of Object.entries(labels)) {
      const api = { loadCaseworkHub: vi.fn().mockResolvedValue({ workspaces: [workspace], drafts: [], patterns: [] }) };
      const { unmount } = render(<LanguageProvider lang={lang}><CaseworkHubPanel chapterId="ch-1" caseOptions={[]} api={api} /></LanguageProvider>);
      expect(await screen.findByRole("heading", { name: copy.bargaining })).toBeInTheDocument();
      const proposalForm = screen.getByRole("heading", { name: copy.proposal }).closest("form");
      const proposalTitle = within(proposalForm).getByLabelText(copy.proposalTitle);
      expect(proposalTitle).toHaveAttribute("name", "title");
      expect(within(proposalForm).queryByLabelText(copy.workspaceTitle)).toBeNull();
      expect(screen.getAllByLabelText(copy.proposalTitle)).toHaveLength(1);
      expect(screen.getAllByLabelText(copy.workspaceTitle)).toHaveLength(1);
      const workspaceTitle = screen.getByLabelText(copy.workspaceTitle);
      expect(workspaceTitle).toHaveAttribute("name", "title");
      expect(workspaceTitle).not.toBe(proposalTitle);
      unmount();
    }
  });

  it("gives a member structured retaliation submission and explicit withdrawal", async () => {
    const row = { id: "case-1", reference: "GRV-1", title: "Schedule case", type: "Scheduling", articles: "", status: "active", step: "Intake", deadlineValue: null, updates: [], files: [] };
    const api = { loadRetaliationReports: vi.fn().mockResolvedValue([{ id: "report-1", management_person: "A Manager", adverse_action: "Schedule changed", status: "submitted" }]), submitRetaliationReport: vi.fn(), withdrawRetaliationReport: vi.fn() };
    render(<LanguageProvider lang="en"><CasesView data={{ cases: [row] }} caseworkApi={api} onCreateCase={vi.fn()} onUpdateCase={vi.fn()} onAddCaseUpdate={vi.fn()} onAddCaseFile={vi.fn()} onRemoveCaseFile={vi.fn()} onOpenCaseFile={vi.fn()} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: /Schedule case/ }));
    expect(await screen.findByRole("heading", { name: "Report retaliation" })).toBeInTheDocument();
    const panel = screen.getByRole("heading", { name: "Report retaliation" }).closest("section");
    fireEvent.change(await within(panel).findByLabelText("Withdrawal reason"), { target: { value: "I want to revise the report" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(api.withdrawRetaliationReport).toHaveBeenCalledWith("report-1", "I want to revise the report"));
  });

  it("renders retaliation copy from the catalogue in the tú register", async () => {
    const row = { id: "case-1", reference: "GRV-1", title: "Schedule case", type: "Scheduling", articles: "", status: "active", step: "Intake", deadlineValue: null, updates: [], files: [] };
    const api = { loadRetaliationReports: vi.fn().mockResolvedValue([]), submitRetaliationReport: vi.fn(), withdrawRetaliationReport: vi.fn() };
    render(<LanguageProvider lang="es"><CasesView data={{ cases: [row] }} caseworkApi={api} onCreateCase={vi.fn()} onUpdateCase={vi.fn()} onAddCaseUpdate={vi.fn()} onAddCaseFile={vi.fn()} onRemoveCaseFile={vi.fn()} onOpenCaseFile={vi.fn()} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: /Schedule case/ }));
    expect(await screen.findByRole("heading", { name: "Reportar represalias" })).toBeInTheDocument();
    expect(screen.getByText(/Solo tú y el personal autorizado/)).toBeInTheDocument();
    expect(screen.queryByText(/\busted\b/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar informe" })).toBeInTheDocument();
  });
});

// Step transitions are gone with the grievance procedure: a stored
// transition (a board move, typed prose, or a prototype-named outcome) never
// renders as a step history, and the panel offers no step-advance form.
describe("casework operations panel shows no step transitions", () => {
  it("renders no transition row and no step-advance form in EN and ES", async () => {
    const transitions = [
      { id: "t-key", from_step: "Intake", to_step: "Step 1", outcome: "board_move", created_at: "2026-08-27T12:00:00Z" },
      { id: "t-prose", from_step: "Step 1", to_step: "Step 2", outcome: "Filed with management", created_at: "2026-08-28T12:00:00Z" },
      { id: "t-proto", from_step: "Step 2", to_step: "Step 3", outcome: "__proto__", created_at: "2026-08-29T12:00:00Z" },
    ];
    for (const [lang, title, progression, advance] of [
      ["en", "Issue tools", "Step progression", "Advance step"],
      ["es", "Herramientas del asunto", "Progreso del paso", "Avanzar paso"],
    ]) {
      const api = operationApi();
      api.loadCaseworkCase.mockResolvedValue({ ...caseData, transitions });
      const { container, unmount } = render(
        <LanguageProvider lang={lang}>
          <CaseworkOperationsPanel caseId="case-1" api={api} />
        </LanguageProvider>,
      );
      expect(await screen.findByText(title)).toBeInTheDocument();
      expect(container.textContent).not.toContain("→");
      expect(screen.queryByText(/Filed with management|__proto__|board_move/)).toBeNull();
      expect(screen.queryByRole("heading", { name: progression })).toBeNull();
      expect(screen.queryByRole("button", { name: advance })).toBeNull();
      expect(api.advanceCaseStep).not.toHaveBeenCalled();
      unmount();
    }
  });
});

// UX-UG-CASE-TOOLS-STRENGTH-BAND-UNCATALOGUED-20260920: the strength
// summary used to print band.replaceAll("_", " "), so Spanish showed the
// English storage words. Each supported band, and an unknown token, must
// read the active language's catalogue label.
describe("case tools strength band catalogue", () => {
  const bands = [
    ["needs_evidence", 40, "Needs evidence", "Necesita evidencia"],
    ["developing", 55, "Developing", "En desarrollo"],
    ["strong", 90, "Strong", "Fuerte"],
    ["not_a_band", 10, "Strength unavailable", "Fortaleza no disponible"],
    ["__proto__", 1, "Strength unavailable", "Fortaleza no disponible"],
  ];

  for (const [band, score, english, spanish] of bands) {
    it(`labels ${band} from the active language catalogue`, async () => {
      for (const [lang, latest, label] of [
        ["en", "Latest", english],
        ["es", "Más reciente", spanish],
      ]) {
        const api = operationApi();
        api.loadCaseworkCase.mockResolvedValue({
          ...caseData,
          strength: [{ id: "score-band", score, band, created_at: "2026-08-28T12:00:00Z" }],
        });
        const { unmount } = render(
          <LanguageProvider lang={lang}>
            <CaseworkOperationsPanel caseId="case-1" api={api} />
          </LanguageProvider>,
        );
        const heading = lang === "en" ? "Strength check" : "Evaluación de fortaleza";
        expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
        const strength = article(heading);
        const summary = `${latest}: ${score}/100 · ${label}`;
        expect(within(strength).getByText(summary, { selector: "strong" })).toBeInTheDocument();
        const storedWords = `${latest}: ${score}/100 · ${String(band).replaceAll("_", " ")}`;
        if (storedWords !== summary) {
          expect(within(strength).queryByText(storedWords, { selector: "strong" })).not.toBeInTheDocument();
        }
        unmount();
      }
    });
  }
});

// UX-UG-CASEWORK-PANEL-OPTION-LABELS-NOT-LOCALIZED-20260920: the nine
// casework selects (session, proposal, side, pulse, review, deadline type,
// alert type, severity, management category) read their option text from the
// shared catalogue. Deadline kinds, alert kinds and severities reuse the keys
// the case history timeline and the case macro editor show for the same
// stored values. Values stay the stored tokens; only the visible text moves.
const CASEWORK_OPTION_SELECTS = [
  { article: { en: "Bargaining", es: "Negociación" }, label: { en: "Session status", es: "Estado de la sesión" }, prefix: "casework.hub.session", values: ["planning", "live", "paused", "tentative_agreement", "closed"] },
  { article: { en: "Bargaining", es: "Negociación" }, label: { en: "Proposal status", es: "Estado de propuesta" }, prefix: "casework.hub.proposal", values: ["draft", "proposed", "countered", "tentative", "accepted", "rejected", "withdrawn"] },
  { article: { en: "Bargaining", es: "Negociación" }, label: { en: "Side", es: "Parte" }, prefix: "casework.hub.side", values: ["union", "management", "joint"] },
  { article: { en: "Bargaining", es: "Negociación" }, label: { en: "Team pulse", es: "Pulso del equipo" }, prefix: "casework.hub.pulse", values: ["steady", "watch", "urgent"] },
  { article: { en: "Retaliation pattern review", es: "Revisión de patrones de represalias" }, label: { en: "Review status", es: "Estado de revisión" }, prefix: "casework.hub.review", values: ["flagged", "investigating", "substantiated", "dismissed"] },
  { article: { en: "Deadline center", es: "Centro de plazos" }, label: { en: "Deadline type", es: "Tipo de plazo" }, prefix: "caseHistory.value.kind", values: ["response", "follow_up"] },
  { article: { en: "Alerts", es: "Alertas" }, label: { en: "Alert type", es: "Tipo de alerta" }, prefix: "caseMacros.alert", values: ["deadline", "safety", "retaliation", "legal", "stalled", "custom"] },
  { article: { en: "Alerts", es: "Alertas" }, label: { en: "Severity", es: "Prioridad" }, prefix: "caseMacros.severity", values: ["info", "warning", "critical"] },
  // REQ-UG-CONFIGURABLE-THRESHOLDS-20261001: the organization list (old default) is stored as entered; its catalogue key is the slug.
  { article: { en: "Management behavior log", es: "Registro de conducta gerencial" }, label: { en: "Category", es: "Categoría" }, prefix: "casework.tools.category", values: [...DEFAULT_MANAGEMENT_CATEGORIES], keyOf: managementCategoryMessageKey },
];

// The English words these selects used to ship as literal option text.
const FORMER_ENGLISH_OPTIONS = [
  "Planning", "Live", "Paused", "Tentative agreement", "Closed",
  "Draft", "Proposed", "Countered", "Tentative", "Accepted", "Rejected", "Withdrawn",
  "Union", "Management", "Joint", "Steady", "Watch", "Urgent",
  "Flagged", "Investigating", "Substantiated", "Dismissed",
  "Filing", "Response", "Hearing", "Appeal", "Follow-up",
  "Deadline", "Safety", "Retaliation", "Stalled", "Custom", "Info", "Warning", "Critical",
  "Discipline", "Scheduling", "Bargaining", "Other",
];

function literalOptionTexts(source) {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  return [...stripped.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/g)]
    .map((match) => match[1].trim())
    .filter((text) => text && !text.includes("{"));
}

describe("casework panel option labels follow the active language", () => {
  it("keeps every option label in the catalogue, in both languages", () => {
    const keys = CASEWORK_OPTION_SELECTS.flatMap((select) => select.values.map((value) => (select.keyOf ? select.keyOf(value) : `${select.prefix}.${value}`)));
    // 33 fixed tokens plus the seven-category management default list. The
    // deadline type offers response and follow-up only: filing, hearing and
    // appeal clocks belong to a grievance procedure Union Ground issues do
    // not have.
    expect(keys).toHaveLength(40);
    const identical = [];
    for (const key of keys) {
      expect(typeof catalogue.en[key], `en ${key}`).toBe("string");
      expect(typeof catalogue.es[key], `es ${key}`).toBe("string");
      if (catalogue.en[key] === catalogue.es[key]) identical.push(key);
    }
    // "Legal" is the same word in both languages.
    expect(identical).toEqual(["caseMacros.alert.legal"]);
  });

  it("fails on a literal option label in either panel", () => {
    for (const file of ["src/components/CaseworkHubPanel.jsx", "src/components/CaseworkOperationsPanel.jsx"]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(literalOptionTexts(source), file).toEqual(["—", "—"]);
      for (const word of FORMER_ENGLISH_OPTIONS) expect(source, `${file} ${word}`).not.toMatch(new RegExp(`>\\s*${word}\\s*</option>`));
    }
  });

  it("renders every affected select in Spanish and English", async () => {
    const hubApi = {
      loadCaseworkHub: vi.fn().mockResolvedValue({
        workspaces: [{
          id: "workspace-1", title: "2027 bargaining", status: "planning", starts_at: null,
          proposals: [{ id: "proposal-1", title: "Article 3", side: "union", body: "Initial language", status: "draft", response_due_at: null }],
          events: [],
        }],
        drafts: [],
        patterns: [{ id: "pattern-1", report_count: 2, status: "flagged", disposition: null }],
      }),
      scanRetaliationPatterns: vi.fn(),
      reviewRetaliationPattern: vi.fn(),
    };
    for (const lang of ["es", "en"]) {
      const view = render(
        <LanguageProvider lang={lang}>
          <CaseworkHubPanel chapterId="ch-1" caseOptions={[]} api={hubApi} />
          <CaseworkOperationsPanel caseId="case-1" api={operationApi()} />
        </LanguageProvider>,
      );
      expect(await screen.findByRole("heading", { level: 3, name: lang === "es" ? "Negociación" : "Bargaining" })).toBeInTheDocument();
      expect(await screen.findByRole("heading", { name: lang === "es" ? "Centro de plazos" : "Deadline center" })).toBeInTheDocument();
      for (const select of CASEWORK_OPTION_SELECTS) {
        const fields = within(article(select.article[lang])).getAllByLabelText(select.label[lang]);
        expect(fields, `${lang} ${select.label.en}`).toHaveLength(1);
        const options = [...fields[0].options];
        expect(options.map((option) => option.value)).toEqual(select.values);
        expect(options.map((option) => option.text)).toEqual(select.values.map((value) => catalogue[lang][select.keyOf ? select.keyOf(value) : `${select.prefix}.${value}`]));
        if (lang === "es") {
          for (const option of options) {
            if (option.text !== "Legal") expect(FORMER_ENGLISH_OPTIONS, `${select.label.en} ${option.value}`).not.toContain(option.text);
          }
        }
      }
      view.unmount();
    }
  });
});

// BUG-UG-CASEWORK-PANELS-RAW-DRIVER-ERROR-TEXT-20260920. A refused write
// used to reach the notice surface as the raw PostgREST/driver sentence
// ("new row violates row-level security policy for table ..."). Both a
// MemberApiError refusal and a bare Error must now render only the panel's
// fixed catalogue copy, in the member's own language.
describe("casework failure notices never render raw driver text", () => {
  const DRIVER_REFUSAL = () => new MemberApiError("Save casework action", {
    message: 'new row violates row-level security policy for table "member_cases"',
    code: "42501",
    details: null,
  });
  const BARE_REFUSAL = () => new Error('duplicate key value violates unique constraint "member_cases_pkey"');
  const FORBIDDEN = /policy|relation|violates|constraint/i;

  it.each([["en", "Issue tools", "Strength check", "Save strength check", "That casework action could not be saved."],
    ["es", "Herramientas del asunto", "Evaluación de fortaleza", "Guardar evaluación", "No se pudo guardar esa acción."]])(
    "operations panel shows only catalogue copy for a driver refusal and a bare Error (%s)",
    async (lang, title, strengthHeading, scoreButton, expected) => {
      for (const makeRefusal of [DRIVER_REFUSAL, BARE_REFUSAL]) {
        const api = operationApi();
        api.scoreCase.mockRejectedValue(makeRefusal());
        const onNotice = vi.fn();
        const { unmount } = render(
          <LanguageProvider lang={lang}>
            <CaseworkOperationsPanel caseId="case-1" api={api} onNotice={onNotice} />
          </LanguageProvider>,
        );
        expect(await screen.findByText(title)).toBeInTheDocument();
        await submitAndWait(article(strengthHeading), scoreButton, api.scoreCase);
        await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expected));
        for (const call of onNotice.mock.calls) expect(String(call[0])).not.toMatch(FORBIDDEN);
        unmount();
      }
    },
  );

  it.each([["en", "Issue work hub", "Scan reports", "That casework action could not be saved."],
    ["es", "Centro de seguimiento de asuntos", "Analizar informes", "No se pudo guardar esa acción."]])(
    "hub panel shows only catalogue copy for a driver refusal and a bare Error (%s)",
    async (lang, heading, scanButtonName, expected) => {
      for (const makeRefusal of [DRIVER_REFUSAL, BARE_REFUSAL]) {
        const api = {
          loadCaseworkHub: vi.fn().mockResolvedValue({ workspaces: [], drafts: [], patterns: [], templates: [] }),
          scanRetaliationPatterns: vi.fn().mockRejectedValue(makeRefusal()),
        };
        const onNotice = vi.fn();
        const { unmount } = render(
          <LanguageProvider lang={lang}>
            <CaseworkHubPanel chapterId="ch-1" api={api} onNotice={onNotice} />
          </LanguageProvider>,
        );
        expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: scanButtonName }));
        await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expected));
        for (const call of onNotice.mock.calls) expect(String(call[0])).not.toMatch(FORBIDDEN);
        unmount();
      }
    },
  );
});

// UX-UG-CASEWORK-PANEL-ES-USTED-COPY-TABLES-20260920: the file-private es
// COPY tables of the hub and Issue tools spoke usted (Siga, Vincule, Cree,
// Califique, Pida…) while the catalogue and the shell use tú. The guard reads
// every string in each panel's es block with the shared marker list in
// tests/i18nRegisterMarkers.js, and the rendered panels show the tú help.
const CASEWORK_PANEL_TU_HELP = [
  "Sigue propuestas, plazos de respuesta, cronología en vivo y pulso del equipo en un espacio.",
  "La recuperación usa revisiones optimistas. Vincula un asunto para conservar el contexto de asignación sin copiar contenido sensible.",
  "Empieza a escribir para crear un borrador autoguardado.",
  "Analiza informes autorizados para detectar patrones repetidos de personas gerenciales en el historial móvil de tres años.",
  "Busca asuntos asignados actuales e históricos, aplica todos los filtros y actualiza una selección limitada.",
  "Califica de 0 a 5. Los resultados se guardan como historial; no son asesoría legal.",
  "Vincula otro asunto autorizado para mostrar la relación en el grafo.",
];

// The usted sentences these panels shipped; each must trip the shared markers.
const CASEWORK_PANEL_USTED_HELP = [
  "Siga propuestas, plazos de respuesta, cronología en vivo y pulso del equipo en un espacio.",
  "Vincule un caso para conservar el contexto de asignación sin copiar contenido sensible.",
  "Empiece a escribir para crear un borrador autoguardado.",
  "Cree trabajo por capítulo que se genera automáticamente cuando un caso coincidente avanza al paso indicado.",
  "Analice informes autorizados para detectar patrones repetidos de personas gerenciales en el historial móvil de tres años.",
  "Busque casos asignados actuales e históricos, aplique todos los filtros y actualice una selección limitada.",
  "Califique de 0 a 5. Los resultados se guardan como historial; no son asesoría legal.",
  "Vincule otro caso autorizado para mostrar la relación en el grafo.",
  "Conceder acceso explícito corresponde a la coordinación. Pida a un coordinador que dé acceso a este caso.",
];

function spanishCopyStrings(file) {
  const source = readFileSync(resolve(process.cwd(), file), "utf8");
  const start = source.indexOf("\n  es: {");
  const end = source.indexOf("\n  },\n};", start);
  expect(start, file).toBeGreaterThan(0);
  expect(end, file).toBeGreaterThan(start);
  return [...source.slice(start, end).matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) => match[1]);
}

describe("casework panel Spanish copy speaks tú", () => {
  it("detects the usted help these panels shipped and not the tú replacements", () => {
    for (const sentence of CASEWORK_PANEL_USTED_HELP) expect(sentence).toMatch(CASEWORK_PANEL_REGISTER_MARKERS);
    for (const sentence of CASEWORK_PANEL_TU_HELP) expect(sentence).not.toMatch(CASEWORK_PANEL_REGISTER_MARKERS);
    expect("Crear plantilla").not.toMatch(CASEWORK_PANEL_REGISTER_MARKERS);
  });

  it("fails on a formal-register word anywhere in either panel's es COPY table", () => {
    for (const file of ["src/components/CaseworkHubPanel.jsx", "src/components/CaseworkOperationsPanel.jsx"]) {
      const spanish = spanishCopyStrings(file);
      expect(spanish.length, file).toBeGreaterThan(40);
      expect(spanish.filter((text) => CASEWORK_PANEL_REGISTER_MARKERS.test(text)), file).toEqual([]);
    }
  });

  it("shows the tú help on the rendered hub and Issue tools", async () => {
    const hubApi = {
      loadCaseworkHub: vi.fn().mockResolvedValue({ workspaces: [], drafts: [], patterns: [], templates: [] }),
      loadCaseworkHistory: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 0, pageSize: 50 }),
      createChecklistTemplate: vi.fn(),
      scanRetaliationPatterns: vi.fn(),
    };
    const view = render(
      <LanguageProvider lang="es">
        <CaseworkHubPanel chapterId="ch-1" caseOptions={[]} api={hubApi} />
        <CaseworkOperationsPanel caseId="case-1" api={operationApi()} />
      </LanguageProvider>,
    );
    for (const sentence of CASEWORK_PANEL_TU_HELP) expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(view.container.textContent).not.toMatch(CASEWORK_PANEL_REGISTER_MARKERS);
    // The checklist-template help is gone with the panel it explained.
    expect(screen.queryByText(/avanza al paso indicado/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Plantillas de listas" })).toBeNull();
    view.unmount();
  });
});

// UX-UG-CASEWORK-PANEL-CHIPS-EXPOSE-RAW-ENUMS-20260920: every permitted
// value of the chip columns and the unnamed-pattern fallback read from the
// active language. The stored token stays on the control
// value, where the write path expects it.
const STATE_LABELS = {
  en: {
    bargaining: "Bargaining", templates: "Checklist templates", patterns: "Retaliation pattern review",
    sessionStatus: "Session status", reviewStatus: "Review status",
    strength: "Strength check", deadlines: "Deadline center", alerts: "Alerts", severity: "Severity",
    retaliation: "Retaliation reports", reminders: "Follow-up reminders",
    unnamedPattern: "Pattern",
    workspaceStatus: { planning: "Planning", live: "Live", paused: "Paused", tentative_agreement: "Tentative agreement", closed: "Closed" },
    patternStatus: { flagged: "Flagged", investigating: "Investigating", substantiated: "Substantiated", dismissed: "Dismissed" },
    strengthBand: { needs_evidence: "Needs evidence", developing: "Developing", strong: "Strong" },
    alertSeverity: { info: "Information", warning: "Warning", critical: "Critical" },
    reportStatus: { submitted: "Submitted", in_review: "In review", withdrawn: "Withdrawn", closed: "Closed" },
    recurrence: { none: "Does not repeat", daily: "Daily", weekly: "Weekly", monthly: "Monthly" },
    reminderStatus: { scheduled: "Scheduled", snoozed: "Snoozed", completed: "Completed", dismissed: "Dismissed" },
    deadlineStatus: { active: "Active", met: "Met", extended: "Extended", waived: "Waived", missed: "Missed" },
    extensionStatus: { requested: "Requested", approved: "Approved", denied: "Denied" },
  },
  es: {
    bargaining: "Negociación", templates: "Plantillas de listas", patterns: "Revisión de patrones de represalias",
    sessionStatus: "Estado de la sesión", reviewStatus: "Estado de revisión",
    strength: "Evaluación de fortaleza", deadlines: "Centro de plazos", alerts: "Alertas", severity: "Prioridad",
    retaliation: "Informes de represalias", reminders: "Recordatorios de seguimiento",
    unnamedPattern: "Patrón",
    workspaceStatus: { planning: "Planificación", live: "En vivo", paused: "En pausa", tentative_agreement: "Acuerdo tentativo", closed: "Cerrado" },
    patternStatus: { flagged: "Marcado", investigating: "En investigación", substantiated: "Sustanciado", dismissed: "Desestimado" },
    strengthBand: { needs_evidence: "Necesita evidencia", developing: "En desarrollo", strong: "Fuerte" },
    alertSeverity: { info: "Información", warning: "Advertencia", critical: "Crítica" },
    reportStatus: { submitted: "Enviado", in_review: "En revisión", withdrawn: "Retirado", closed: "Cerrado" },
    recurrence: { none: "No repetir", daily: "Diariamente", weekly: "Semanalmente", monthly: "Mensualmente" },
    reminderStatus: { scheduled: "Programado", snoozed: "Pospuesto", completed: "Completado", dismissed: "Descartado" },
    deadlineStatus: { active: "Activo", met: "Cumplido", extended: "Prorrogado", waived: "Dispensado", missed: "Incumplido" },
    extensionStatus: { requested: "Solicitada", approved: "Aprobada", denied: "Denegada" },
  },
};

function rawTokenAbsent(text, token) {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = (value) => new RegExp(`(^|[^\\p{L}\\p{N}_])${escape(value)}([^\\p{L}\\p{N}_]|$)`, "u");
  expect(text).not.toMatch(word(token));
  const spaced = token.replaceAll("_", " ");
  if (spaced !== token) expect(text).not.toMatch(word(spaced));
}

describe("casework state chips follow the active language", () => {
  const patternSubjects = { investigating: "North supervisor", substantiated: "East supervisor", dismissed: "West supervisor" };
  const alertMessages = { info: "Clock notice", warning: "Safety notice", critical: "Legal notice" };
  const reportPeople = { submitted: "Supervisor Ada", in_review: "Supervisor Bo", withdrawn: "Supervisor Cho", closed: "Supervisor Dee" };
  const deadlineLabels = { active: "Filing clock", met: "Response clock", extended: "Hearing clock", waived: "Appeal clock", missed: "Follow clock" };
  const reminderRows = [
    ["Morning call", "none", "scheduled"],
    ["Noon call", "daily", "snoozed"],
    ["Evening call", "weekly", "completed"],
    ["Month call", "monthly", "dismissed"],
  ];

  function hubApi() {
    return {
      loadCaseworkHub: vi.fn().mockResolvedValue({
        workspaces: Object.keys(STATE_LABELS.en.workspaceStatus).map((status) => ({
          id: `ws-${status}`, title: `Workspace ${status}`, status, starts_at: null, proposals: [], events: [],
        })),
        drafts: [],
        templates: [
          { id: "tpl-1", title: "One step", case_type: "Scheduling", step: "Intake", items: [{ label: "Call" }] },
          { id: "tpl-2", title: "Two steps", case_type: "Safety", step: "Hearing", items: [{ label: "Call" }, { label: "Write" }] },
        ],
        patterns: Object.keys(STATE_LABELS.en.patternStatus).map((status) => ({
          id: `pat-${status}`,
          subject_label: patternSubjects[status] || "",
          report_count: 2,
          status,
          disposition: null,
        })),
      }),
      createChecklistTemplate: vi.fn(),
      scanRetaliationPatterns: vi.fn(),
      reviewRetaliationPattern: vi.fn(),
      setBargainingStatus: vi.fn(),
      createBargainingWorkspace: vi.fn(),
      addBargainingProposal: vi.fn(),
      transitionBargainingProposal: vi.fn(),
      addBargainingEvent: vi.fn(),
    };
  }

  function operationsFixture(band) {
    return {
      ...caseData,
      strength: [{ id: "score-1", score: 72, band, created_at: "2026-08-28T12:00:00Z" }],
      deadlines: Object.keys(deadlineLabels).map((status) => ({
        id: `dl-${status}`,
        label: deadlineLabels[status],
        due_at: "2026-09-01T12:00:00Z",
        status,
        extensions: status === "active"
          ? Object.keys(STATE_LABELS.en.extensionStatus).map((extensionStatus, index) => ({
            id: `ext-${extensionStatus}`, status: extensionStatus, requested_due_at: `2026-09-0${index + 2}T15:00:00Z`,
          }))
          : [],
      })),
      alerts: Object.keys(alertMessages).map((severity) => ({
        id: `alert-${severity}`, severity, status: "open", message: alertMessages[severity],
      })),
      retaliation: Object.keys(reportPeople).map((status) => ({
        id: `report-${status}`, status, management_person: reportPeople[status], incident_at: "2026-08-28T12:00:00Z",
        protected_activity: "Filed a grievance", adverse_action: "Schedule changed",
      })),
      reminders: reminderRows.map(([title, recurrence, status], index) => ({
        id: `rem-${index}`, title, recurrence, status, remind_at: "2026-09-01T12:00:00Z",
      })),
      checklists: [],
      management: [],
      links: [],
    };
  }

  it("renders every permitted hub and case-tool state in English and Spanish", async () => {
    for (const lang of ["en", "es"]) {
      const copy = STATE_LABELS[lang];
      const other = STATE_LABELS[lang === "en" ? "es" : "en"];
      const hub = render(<LanguageProvider lang={lang}><CaseworkHubPanel chapterId="ch-1" api={hubApi()} /></LanguageProvider>);
      expect(await screen.findByRole("heading", { name: copy.bargaining })).toBeInTheDocument();
      const bargaining = article(copy.bargaining);
      for (const [token, label] of Object.entries(copy.workspaceStatus)) {
        const section = within(bargaining).getByText(`Workspace ${token}`).closest("section");
        const chip = within(section).getByText(label, { selector: ".cwk-chip" });
        expect(chip.textContent).toBe(label);
        rawTokenAbsent(chip.textContent, token);
        expect(label).not.toBe(other.workspaceStatus[token]);
        // Tables open one at a time (BUG-UG-WEB-CASEWORK-HUB-RENDERS-EVERY-FORM-OPEN-20261002).
        fireEvent.click(within(section).getByRole("button", { expanded: false }));
        const select = within(section).getByLabelText(copy.sessionStatus);
        expect(within(select).getByRole("option", { name: label })).toHaveValue(token);
        expect(within(select).queryByRole("option", { name: other.workspaceStatus[token] })).toBeNull();
      }
      // Step checklist templates are gone: no panel and no item counts, even
      // with stored templates and createChecklistTemplate on the api double.
      expect(screen.queryByRole("heading", { name: copy.templates })).toBeNull();
      expect(screen.queryByText("One step")).toBeNull();
      expect(screen.queryByText("Two steps")).toBeNull();
      const patterns = article(copy.patterns);
      for (const [token, label] of Object.entries(copy.patternStatus)) {
        const subject = patternSubjects[token] || copy.unnamedPattern;
        const summary = within(patterns).getByText(subject, { selector: "strong", exact: false }).closest("p");
        expect(summary).toHaveTextContent(label);
        expect(summary).toHaveTextContent(subject);
        rawTokenAbsent(summary.textContent, token);
        expect(summary.textContent).not.toContain(other.patternStatus[token]);
        if (!patternSubjects[token]) expect(summary.textContent).not.toContain(other.unnamedPattern);
      }
      hub.unmount();

      for (const band of Object.keys(copy.strengthBand)) {
        const api = operationApi();
        api.loadCaseworkCase.mockResolvedValue(operationsFixture(band));
        const view = render(<LanguageProvider lang={lang}><CaseworkOperationsPanel caseId="case-1" api={api} /></LanguageProvider>);
        expect(await screen.findByRole("heading", { name: copy.strength })).toBeInTheDocument();
        const strength = article(copy.strength);
        const score = within(strength).getByText(`${lang === "en" ? "Latest" : "Más reciente"}: 72/100 · ${copy.strengthBand[band]}`, { selector: "strong" });
        rawTokenAbsent(score.textContent, band);
        expect(score.textContent).not.toContain(other.strengthBand[band]);

        if (band === "needs_evidence") {
          const deadlines = article(copy.deadlines);
          for (const [token, label] of Object.entries(copy.deadlineStatus)) {
            const row = within(deadlines).getByText(deadlineLabels[token]).closest("div");
            const statusLine = [...row.querySelectorAll("small")].find((node) => node.textContent.includes(` · ${label}`));
            expect(statusLine, token).toBeTruthy();
            rawTokenAbsent(statusLine.textContent, token);
            expect(statusLine.textContent).not.toContain(other.deadlineStatus[token]);
          }
          const extensionLines = [...within(deadlines).getByText(deadlineLabels.active).closest("div").querySelectorAll("small")];
          for (const [token, label] of Object.entries(copy.extensionStatus)) {
            const line = extensionLines.find((node) => node.textContent.startsWith(`${label}:`));
            expect(line, token).toBeTruthy();
            rawTokenAbsent(line.textContent, token);
            expect(line.textContent).not.toContain(other.extensionStatus[token]);
          }
          const alerts = article(copy.alerts);
          for (const [token, label] of Object.entries(copy.alertSeverity)) {
            const row = within(alerts).getByText(alertMessages[token]).closest("p");
            const chip = within(row).getByText(label, { selector: ".cwk-chip" });
            expect(chip.textContent).toBe(label);
            rawTokenAbsent(chip.textContent, token);
          }
          const severity = within(alerts).getByLabelText(copy.severity);
          for (const [token, label] of Object.entries(copy.alertSeverity)) {
            expect(within(severity).getByRole("option", { name: label })).toHaveValue(token);
            expect(within(severity).queryByRole("option", { name: other.alertSeverity[token] })).toBeNull();
          }
          const reports = article(copy.retaliation);
          for (const [token, label] of Object.entries(copy.reportStatus)) {
            const row = within(reports).getByText(reportPeople[token]).closest("p");
            const chip = within(row).getByText(label, { selector: ".cwk-chip" });
            expect(chip.textContent).toBe(label);
            rawTokenAbsent(chip.textContent, token);
          }
          const reminders = article(copy.reminders);
          for (const [title, recurrence, status] of reminderRows) {
            const line = within(reminders).getByText(title).closest("div").querySelector("small");
            expect(line).toHaveTextContent(copy.recurrence[recurrence]);
            expect(line).toHaveTextContent(copy.reminderStatus[status]);
            rawTokenAbsent(line.textContent, recurrence);
            rawTokenAbsent(line.textContent, status);
            expect(line.textContent).not.toContain(other.recurrence[recurrence]);
            expect(line.textContent).not.toContain(other.reminderStatus[status]);
          }
        }
        view.unmount();
      }
    }
  });
});
