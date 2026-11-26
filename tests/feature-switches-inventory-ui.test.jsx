// REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001 (PR 2: inventory).
// Each surfaced write path gets a real control, and a platform-only value is
// shown as a fact rather than a control that would fail on save.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSecurityConfiguration } from "../src/components/AdminSecurityConfiguration.jsx";
import { AutomationWorkspaceLink } from "../src/components/AutomationWorkspaceLink.jsx";
import { StaffEngagement, pulsePromptPayload, surveyOperationsFields } from "../src/features/engagement/StaffEngagement.jsx";
import { engagementApi } from "../src/features/engagement/api.js";
import { organizationConnectionWeights } from "../src/features/connectionSuggestions/contract.js";
import { createIntegrationControlStore } from "../src/features/integrations/store.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { SETTING_LISTED_WITH, listedSettings } from "../src/lib/organizationSettingsAdmin.js";
import { MemberSupportView } from "../src/views/MemberSupportView.jsx";

// The member support snapshot travels the sensitive-content route in the app;
// here it reads the fake client directly, as tests/member-support-view does.
vi.mock("../src/lib/sensitiveContentApi.js", () => ({ sensitiveContentRpc: (client, name, args) => client.rpc(name, args) }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("platform-only settings on the Feature switches & limits page", () => {
  it("shows the value and 'Set for the whole platform' with no editable control or save", () => {
    const configuration = {
      settings: [{ key: "limits.security.signin_attempts_per_email_hour", kind: "integer", category: "security", label: "Sign-in attempts per email per hour", description: "Platform throttle.", value: 5, defaultValue: 5, minimum: 1, maximum: 25, organizationEditable: false, overridden: false, updatedAt: null, lastChange: null }],
      labelKeys: [], labelOverrides: {},
    };
    const { container } = render(<LanguageProvider lang="en"><AdminSecurityConfiguration configuration={configuration} failedLoginInbox={null} api={{ updateOrganizationSetting: vi.fn() }} reload={vi.fn()} onNotice={vi.fn()} /></LanguageProvider>);
    const row = within(container.querySelector('[data-setting-key="limits.security.signin_attempts_per_email_hour"]'));
    expect(row.getByText("Set for the whole platform")).toBeInTheDocument();
    expect(row.getByText("5")).toBeInTheDocument();
    expect(row.queryByRole("spinbutton")).toBeNull();
    expect(row.queryByRole("button")).toBeNull();
  });
});

// BUG-UG-HELD-MEMBER-PIN-STILL-SHOWS-20261112: the server leaves a
// held switch out of the admin list; Restricted PIN sessions is never held
// (held, it would read off and lift the restriction) and leaves with it.
describe("a setting listed with a switch on the Feature switches & limits page", () => {
  const row = (key, label, value = true) => ({ key, kind: "boolean", category: "security", label, description: label, value, defaultValue: value,
    minimum: null, maximum: null, organizationEditable: true, overridden: false, updatedAt: null, lastChange: null });
  const pinSignIn = row("features.security.member_pin_signin", "Member PIN sign-in", false);
  const restricted = row("features.security.member_pin_restricted_sessions", "Restricted PIN sessions");
  const passkeys = row("features.passkey_enrollment", "Passkey enrollment");

  function renderPage(settings) {
    const configuration = { settings, labelKeys: [], labelOverrides: {} };
    return render(<LanguageProvider lang="en"><AdminSecurityConfiguration configuration={configuration} failedLoginInbox={null} api={{ updateOrganizationSetting: vi.fn() }} reload={vi.fn()} onNotice={vi.fn()} /></LanguageProvider>);
  }

  it("keeps PIN sign-in and passkey enrollment off the public settings page", () => {
    const { container } = renderPage([pinSignIn, restricted, passkeys]);
    for (const setting of [pinSignIn, restricted, passkeys]) {
      expect(container.querySelector(`[data-setting-key="${setting.key}"]`)).toBeNull();
    }
  });

  it("filters only the list, never a row's value", () => {
    const lockout = { ...row("limits.security.member_pin_lockout_attempts", "PIN lockout after wrong PINs"), kind: "integer", value: 5, defaultValue: 5 };
    expect(listedSettings([restricted, lockout, passkeys])).toEqual([passkeys]);
    expect(listedSettings([pinSignIn, lockout])).toEqual([pinSignIn, lockout]);
    expect(listedSettings([pinSignIn, restricted])).toEqual([pinSignIn, restricted]);
    expect(listedSettings(null)).toEqual([]);
    for (const [key, parent] of Object.entries(SETTING_LISTED_WITH)) expect(key).not.toBe(parent);
  });
});

describe("inventory A5: admin and VP automation pages", () => {
  it("links to the working Automations workspace instead of rendering empty", () => {
    render(<LanguageProvider lang="es"><AutomationWorkspaceLink id="vp-automation-control" /></LanguageProvider>);
    expect(screen.getByRole("link", { name: "Abrir Automatizaciones" })).toHaveAttribute("href", "/m/automations");
    expect(document.getElementById("vp-automation-control")).not.toBeNull();
  });
});

describe("inventory A3: contextual prompt cooldown, active flag, edit and pause", () => {
  const prompt = { id: "prompt-1", eventKey: "case.updated", question: "Was this update clear?", options: ["Yes", "No"], active: true, cooldownHours: 168, shown: 4, responded: 2 };
  beforeEach(() => {
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue({ surveys: [], livePolls: [], channels: [], pulsePrompts: [prompt] });
    vi.spyOn(engagementApi, "savePulsePrompt").mockResolvedValue({});
  });

  it("pauses an active prompt by resending its own content with active false", async () => {
    render(<LanguageProvider lang="en"><StaffEngagement client={{}} /></LanguageProvider>);
    await screen.findByTestId("staff-engagement");
    fireEvent.click(screen.getByRole("button", { name: "Contextual" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pause prompt: Was this update clear?" }));
    await waitFor(() => expect(engagementApi.savePulsePrompt).toHaveBeenCalledWith({}, {
      id: "prompt-1", eventKey: "case.updated", question: "Was this update clear?", options: ["Yes", "No"], active: false, cooldownHours: 168,
    }));
  });

  it("edits the cooldown and active flag of an existing prompt", async () => {
    render(<LanguageProvider lang="en"><StaffEngagement client={{}} /></LanguageProvider>);
    await screen.findByTestId("staff-engagement");
    fireEvent.click(screen.getByRole("button", { name: "Contextual" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit prompt: Was this update clear?" }));
    fireEvent.change(screen.getByLabelText("Hours before the same member sees it again"), { target: { value: "72" } });
    fireEvent.click(screen.getByLabelText("Active"));
    fireEvent.submit(screen.getByLabelText("Hours before the same member sees it again").closest("form"));
    await waitFor(() => expect(engagementApi.savePulsePrompt).toHaveBeenCalledWith({}, expect.objectContaining({ id: "prompt-1", cooldownHours: 72, active: false })));
  });

  it("keeps the payload helper stable for a new prompt", () => {
    expect(pulsePromptPayload(null, { eventKey: "x", question: "q", options: ["a"], active: true, cooldownHours: 5 }))
      .toEqual({ eventKey: "x", question: "q", options: ["a"], active: true, cooldownHours: 5 });
  });
});

describe("inventory A2: survey owner, due dates and privacy floor", () => {
  const survey = {
    id: "survey-1", title: "Quarterly pulse", status: "open", cadence: "quarterly", periodKey: "2026-Q4",
    privacyMinResponses: 5, operationsState: "distributing", ownerUserId: null, opensAt: null, closesAt: null, reviewDueAt: null,
    coverage: {}, tasks: [{ id: "task-1", reason: "readiness", status: "done", assignedTo: null, dueAt: "2026-10-05T16:00:00.000Z" }], reviews: [],
  };
  beforeEach(() => {
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue({ surveys: [survey], livePolls: [], channels: [], pulsePrompts: [], members: [{ id: "member-1", name: "Morgan Member" }] });
    vi.spyOn(engagementApi, "setSurveyPrivacyFloor").mockResolvedValue({});
    vi.spyOn(engagementApi, "configureSurvey").mockResolvedValue({});
  });

  it("saves the privacy floor within 3..50 and the owner without clearing the other operations fields", async () => {
    render(<LanguageProvider lang="en"><StaffEngagement client={{}} /></LanguageProvider>);
    await screen.findByTestId("staff-engagement");
    fireEvent.click(await screen.findByText("Owner, due dates and privacy floor"));
    const floor = screen.getByLabelText("Privacy floor");
    fireEvent.change(floor, { target: { value: "2" } });
    expect(screen.getByRole("button", { name: "Save privacy floor" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(floor, { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save privacy floor" }));
    await waitFor(() => expect(engagementApi.setSurveyPrivacyFloor).toHaveBeenCalledWith({}, "survey-1", 12));

    fireEvent.change(screen.getByLabelText("Survey owner"), { target: { value: "member-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save owner and due dates" }));
    await waitFor(() => expect(engagementApi.configureSurvey).toHaveBeenCalledWith({}, "survey-1", expect.objectContaining({
      cadence: "quarterly", periodKey: "2026-Q4", operationsState: "distributing", ownerUserId: "member-1",
      readinessDueAt: "2026-10-05T16:00:00.000Z",
    })));
  });

  // REQ-UG-STALE-OR-CONTRADICTORY-STATE-AFTER-SAVE-20261030: "saved"
  // was followed by "No owner" on the card.
  it("keeps showing the saved owner after the save and reload, even when the member list does not carry them", async () => {
    const owned = { ...survey, ownerUserId: "member-1" };
    engagementApi.loadStaff.mockResolvedValueOnce({ surveys: [survey], livePolls: [], channels: [], pulsePrompts: [], members: [{ id: "member-1", name: "Morgan Member" }] })
      .mockResolvedValueOnce({ surveys: [owned], livePolls: [], channels: [], pulsePrompts: [], members: [{ id: "member-1", name: "Morgan Member" }] })
      .mockResolvedValue({ surveys: [{ ...survey, ownerUserId: "member-9" }], livePolls: [], channels: [], pulsePrompts: [], members: [{ id: "member-1", name: "Morgan Member" }] });
    render(<LanguageProvider lang="en"><StaffEngagement client={{}} /></LanguageProvider>);
    fireEvent.click(await screen.findByText("Owner, due dates and privacy floor"));
    const owner = screen.getByLabelText("Survey owner");
    fireEvent.change(owner, { target: { value: "member-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save owner and due dates" }));
    await waitFor(() => expect(engagementApi.loadStaff).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByLabelText("Survey owner")).toHaveDisplayValue("Morgan Member"));
    // A later reload with an owner outside the list: the control shows the saved owner, not "No owner".
    fireEvent.change(screen.getByLabelText("Privacy floor"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Save privacy floor" }));
    await waitFor(() => expect(engagementApi.loadStaff).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByLabelText("Survey owner")).toHaveDisplayValue("Saved owner (not in this list)"));
    expect(screen.getByLabelText("Survey owner")).not.toHaveDisplayValue("No owner");
  });

  it("reads every operations field the RPC rewrites from the snapshot", () => {
    expect(surveyOperationsFields(survey)).toEqual({
      cadence: "quarterly", periodKey: "2026-Q4", operationsState: "distributing", opensAt: null, closesAt: null,
      ownerUserId: null, reviewDueAt: null, readinessDueAt: "2026-10-05T16:00:00.000Z",
    });
  });
});

describe("inventory A4: HR directory visibility and onboarding steps", () => {
  const actor = { userId: "11111111-1111-4111-8111-111111111111", selectedOrganizationId: "22222222-2222-4222-8222-222222222222", membershipStatus: "active", selectedHat: "steward", organizationRoles: ["steward"], mfaSatisfied: true };
  const model = {
    state: "ready", organizationId: actor.selectedOrganizationId, staff: true, emergencyChecklists: [], accommodations: [],
    accommodationSummary: { total: 0, open: 0, approved: 0, denied: 0, withdrawn: 0 },
    hrDirectory: { id: "directory-1", name: "People Support", title: "HR partner", department: "People", email: "hr@example.test", phone: "555 0100", hours: "Weekdays", notes: "Call first", enabled: true },
    hrContacts: [], onboardingPlan: null, onboardingRoster: [], mentorshipPairs: [], mentorshipDirectory: [],
    onboardingProgram: [
      { id: "step-1", title: "Welcome", description: "Meet the team", position: 1, active: true },
      { id: "step-3", title: "Archived", description: "Old", position: 3, active: false },
    ],
  };
  const clientFor = () => ({ rpc: vi.fn(async (name) => (name === "get_member_support_workspace" ? { data: model, error: null } : { data: { saved: true }, error: null })) });

  it("hides the HR directory from members when the box is unchecked", async () => {
    const client = clientFor();
    render(<LanguageProvider lang="en"><MemberSupportView actor={actor} client={client} /></LanguageProvider>);
    await screen.findByRole("heading", { name: "Emergency rights checklist" });
    fireEvent.click(screen.getByRole("button", { name: "HR contact" }));
    fireEvent.click(screen.getByText("Configure HR directory"));
    fireEvent.click(screen.getByLabelText("Show this HR directory to workers"));
    fireEvent.click(screen.getByRole("button", { name: "Save directory" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_organization_hr_directory", expect.objectContaining({ p_enabled: false })));
  });

  it("turns an existing onboarding step off and back on", async () => {
    const client = clientFor();
    render(<LanguageProvider lang="en"><MemberSupportView actor={actor} client={client} /></LanguageProvider>);
    await screen.findByRole("heading", { name: "Emergency rights checklist" });
    fireEvent.click(screen.getByRole("button", { name: "Onboarding" }));
    fireEvent.click(screen.getByText("Manage program and oversight"));
    fireEvent.click(screen.getByRole("button", { name: "Turn off step Welcome" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_organization_onboarding_step", expect.objectContaining({ p_step_id: "step-1", p_active: false })));
    fireEvent.click(screen.getByRole("button", { name: "Turn on step Archived" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_organization_onboarding_step", expect.objectContaining({ p_step_id: "step-3", p_active: true })));
  });
});

describe("inventory A1: provider status in the local integration store", () => {
  it("turns a requested provider off and requests it again, refusing activation and unset providers", () => {
    const store = createIntegrationControlStore();
    const actor = { userId: "admin-1", selectedOrganizationId: "org-1", organizationRoles: ["admin"], chapterRoles: [], selectedHat: "admin", membershipStatus: "active", mfaSatisfied: true, chapterId: null };
    expect(store.setProviderStatus(actor, { provider: "twilio", status: "disabled" })).toMatchObject({ ok: false, reason: "provider_not_set_up" });
    expect(store.requestActivation(actor, { provider: "twilio" })).toMatchObject({ ok: true });
    expect(store.setProviderStatus(actor, { provider: "twilio", status: "connected" })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(store.setProviderStatus(actor, { provider: "twilio", status: "disabled" })).toMatchObject({ ok: true, provider: expect.objectContaining({ status: "disabled" }) });
    expect(store.setProviderStatus(actor, { provider: "twilio", status: "requested" })).toMatchObject({ ok: true, provider: expect.objectContaining({ status: "requested" }) });
  });
});

describe("inventory B13: organization default matching weights", () => {
  it("reads the six weights from the member switches map and keeps the preset when none are set", () => {
    expect(organizationConnectionWeights(null)).toBeNull();
    expect(organizationConnectionWeights({ switches: {} })).toBeNull();
    expect(organizationConnectionWeights({ switches: { "limits.intelligence.connection_weight_location": 60, "limits.intelligence.connection_weight_union": 101 } }))
      .toEqual({ location: 60, sector: 20, issues: 25, expertise: 20, local: 10, union: 5 });
  });
});
