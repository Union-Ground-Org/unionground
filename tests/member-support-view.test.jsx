import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemberSupportView } from "../src/views/MemberSupportView.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { localeFor, t } from "../src/lib/i18n.js";
import { formatGroupMoment } from "../src/lib/i18n/zonedDates.js";
import { App } from "../src/App.jsx";
import { EMERGENCY_SCENARIOS, MEMBER_SUPPORT_TABS } from "../src/features/memberSupport/contract.js";
import { isStaffOnlyWorkspaceTabPath, STAFF_ONLY_WORKSPACE_TAB_PATHS } from "../src/lib/workspacePages.js";
import { primeDemoHat } from "./helpers/demoHat.js";
import { PHONE_HOME_GREETING } from "./helpers/homeGreeting.js";
import { afterRenderingUpdate, enableFocusFixup } from "./helpers/focusFixup.js";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const actor = {
  userId: USER,
  selectedOrganizationId: ORG,
  membershipStatus: "active",
  selectedHat: "member",
  mfaSatisfied: true,
};

function workspace(overrides = {}) {
  return {
    state: "ready",
    organizationId: ORG,
    staff: false,
    emergencyChecklists: [],
    accommodations: [],
    accommodationSummary: { total: 0, open: 0, approved: 0, denied: 0, withdrawn: 0 },
    hrDirectory: null,
    hrContacts: [],
    onboardingProgram: [],
    onboardingPlan: null,
    onboardingRoster: [],
    mentorshipPairs: [],
    mentorshipDirectory: [],
    ...overrides,
  };
}

function clientFor(model) {
  return { rpc: vi.fn(async (name) => {
    if (name === "get_member_support_workspace") return { data: model, error: null };
    return { data: { saved: true }, error: null };
  }) };
}

const staffActor = {
  ...actor,
  selectedHat: "steward",
  organizationRoles: ["steward"],
};

function richWorkspace(overrides = {}) {
  return workspace({
    staff: true,
    emergencyChecklists: [
      { id: "checklist-own", memberUserId: USER, memberLabel: "Morgan Member", scenario: "disciplinary_meeting", status: "draft", completedSteps: [0], notes: "Private draft" },
      { id: "checklist-alert", memberUserId: "member-2", memberLabel: "Alex Member", scenario: "unsafe_work", status: "alerted", completedSteps: [0, 1], notes: "Needs a call" },
    ],
    accommodations: [
      { id: "request-own", memberUserId: USER, memberLabel: "Morgan Member", requestType: "schedule", description: "Earlier shift", status: "submitted", submittedAt: "2026-08-01T12:00:00.000Z" },
      { id: "request-other", memberUserId: "member-2", memberLabel: "Alex Member", requestType: "remote_work", description: "Remote mornings", status: "approved", staffNote: "Approved", submittedAt: null },
    ],
    accommodationSummary: { total: 2, open: 1, approved: 1, denied: 0, withdrawn: 0 },
    hrDirectory: { id: "directory-1", name: "People Support", title: "HR partner", department: "People", email: "hr@example.test", phone: "555 0100", hours: "Weekdays", notes: "Call first", enabled: true },
    hrContacts: [
      { id: "contact-1", memberUserId: USER, memberLabel: "Morgan Member", channel: "email", purpose: "Schedule", disposition: "planned", note: "Drafted", occurredAt: "2026-08-01T12:00:00.000Z", followUpOn: "2026-08-02" },
      { id: "contact-2", memberUserId: "member-2", memberLabel: "Alex Member", channel: "phone", purpose: "Update", disposition: "completed", note: "", occurredAt: null, followUpOn: null },
    ],
    onboardingProgram: [
      { id: "step-1", title: "Welcome", description: "Meet the team", position: 1, active: true },
      { id: "step-2", title: "Rights", description: "Review rights", position: 2, active: true },
      { id: "step-3", title: "Archived", description: "Old", position: 3, active: false },
    ],
    onboardingPlan: { id: "plan-1", memberUserId: USER, status: "active", completedStepIds: ["step-1"], assignedByLabel: "Sam" },
    onboardingRoster: [{ id: "plan-2", memberLabel: "Alex Member", status: "active", completedStepIds: ["step-1"] }],
    mentorshipPairs: [{
      id: "pair-1",
      mentorUserId: USER,
      menteeUserId: "member-2",
      mentorLabel: "Morgan Member",
      menteeLabel: "Alex Member",
      status: "active",
      startedOn: "2026-01-01",
      outcome: "Early progress",
      goals: [
        { id: "goal-1", title: "Prepare filing", completed: false },
        { id: "goal-2", title: "Meet steward", completed: true },
      ],
      notes: [{ id: "note-1", authorLabel: "Morgan", body: "First meeting", createdAt: "2026-01-02" }],
    }],
    mentorshipDirectory: [
      { userId: USER, label: "Morgan Member" },
      { userId: "member-2", label: "Alex Member" },
    ],
    ...overrides,
  });
}

async function waitForMutation(client, name, count = 1) {
  await waitFor(() => expect(client.rpc.mock.calls.filter(([rpc]) => rpc === name)).toHaveLength(count));
  await waitFor(() => expect(screen.getByRole("status")).not.toHaveTextContent("^$"));
}

describe("worker support web workspace", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps rows and the selected tab across an equal-actor re-render", async () => {
    const model = workspace({
      accommodations: [
        { id: "request-own", memberUserId: USER, memberLabel: "Morgan Member", requestType: "schedule", description: "Earlier shift", status: "submitted", submittedAt: "2026-08-01T12:00:00.000Z" },
      ],
      accommodationSummary: { total: 1, open: 1, approved: 0, denied: 0, withdrawn: 0 },
    });
    const client = clientFor(model);
    const { rerender } = render(<MemberSupportView actor={{ ...actor }} client={client} />);
    await screen.findByRole("heading", { name: "Emergency rights checklist" });
    fireEvent.click(screen.getByRole("button", { name: "Accommodations" }));
    expect(screen.getByText("Earlier shift")).toBeInTheDocument();
    expect(client.rpc.mock.calls.filter(([name]) => name === "get_member_support_workspace")).toHaveLength(1);

    rerender(<MemberSupportView actor={{ ...actor }} client={client} />);
    await Promise.resolve();
    expect(client.rpc.mock.calls.filter(([name]) => name === "get_member_support_workspace")).toHaveLength(1);
    expect(screen.getByText("Earlier shift")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Accommodation requests" })).toBeInTheDocument();

    rerender(<MemberSupportView actor={{ ...actor, userId: "99999999-9999-4999-8999-999999999999" }} client={client} />);
    await waitFor(() => expect(client.rpc.mock.calls.filter(([name]) => name === "get_member_support_workspace")).toHaveLength(2));
  });

  // BUG-UG-MEMBER-SUPPORT-RPCS-REQUIRE-HOME-CHAPTER-FOR-CHAPTERLESS-STAFF-20260921.
  // An organization administrator with no chapter membership reaches the desk
  // with chapterId null. Once get_my_chapter_memberships reports the
  // organization-level selected row, the desk must open rather than paint
  // "Organization setup is still empty".
  it("opens the desk for chapterless single-organization staff", async () => {
    const chapterlessStaff = {
      ...actor,
      chapterId: null,
      selectedHat: "admin",
      organizationRoles: ["admin"],
      mfaSatisfied: true,
    };
    const client = clientFor(workspace({ staff: true }));
    render(<MemberSupportView actor={chapterlessStaff} client={client} />);
    expect(await screen.findByRole("heading", { name: "Emergency rights checklist" })).toBeInTheDocument();
    expect(screen.queryByText("Organization setup is still empty")).not.toBeInTheDocument();
    expect(screen.queryByText("Worker support could not be loaded")).not.toBeInTheDocument();
    expect(client.rpc).toHaveBeenCalledWith("get_member_support_workspace", undefined);
  });

  // The workspace opening does not make a handoff possible: a handoff writes a
  // chapter. The server now says so, and the desk must repeat that sentence
  // instead of the generic "That change could not be saved."
  it("repeats the server's chapter-required refusal verbatim", async () => {
    const chapterRequired = Object.assign(
      new Error("A handoff records a chapter. Select a chapter before transferring responsibility for a member."),
      { code: "42501" },
    );
    const client = {
      rpc: vi.fn(async (name) => {
        if (name === "get_member_support_workspace") return { data: workspace(), error: null };
        return { data: null, error: chapterRequired };
      }),
    };
    render(<MemberSupportView actor={actor} client={client} />);
    await screen.findByRole("heading", { name: "Emergency rights checklist" });
    fireEvent.click(screen.getByRole("button", { name: "Save progress" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(
      "Select a chapter before transferring responsibility for a member.",
    ));
    expect(screen.queryByText("That change could not be saved.")).not.toBeInTheDocument();
  });

  // BUG-UG-MEMBER-SUPPORT-RAW-ERROR-TEXT-20261018: a failed save
  // shows the translated failure text, never the database's own message.
  it.each([
    ["en", "That change could not be saved."],
    ["es", "No se pudo guardar ese cambio."],
  ])("shows translated failure text, not a raw database message, after a failed save (%s)", async (lang, expected) => {
    const raw = 'duplicate key value violates unique constraint "member_support_progress_pkey"';
    const client = {
      rpc: vi.fn(async (name) => {
        if (name === "get_member_support_workspace") return { data: workspace(), error: null };
        return { data: null, error: Object.assign(new Error(raw), { code: "23505" }) };
      }),
    };
    render(<LanguageProvider lang={lang}><MemberSupportView actor={actor} client={client} /></LanguageProvider>);
    const save = await screen.findAllByRole("button", { name: lang === "en" ? "Save progress" : "Guardar progreso" });
    fireEvent.click(save[0]);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(expected));
    expect(screen.queryByText(/duplicate key|member_support_progress_pkey/)).toBeNull();
  });

  it("renders all five workflows with honest empty states", async () => {
    render(<MemberSupportView actor={actor} client={clientFor(workspace())} />);
    expect(await screen.findByRole("heading", { name: "Emergency rights checklist" })).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: "Accommodations" }));
    expect(screen.getByRole("heading", { name: "Accommodation requests" })).toBeInTheDocument();
    expect(screen.getByText("No requests yet")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "HR contact" }));
    expect(screen.getByText("HR directory is not configured")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Onboarding" }));
    // REQ-UG-DEFAULT-NEW-MEMBER-ONBOARDING-PROGRAM-20261006: no
    // organization steps means the Union Ground starting list, not an empty page.
    expect(screen.queryByText("No onboarding program is configured")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Getting started" })).toBeInTheDocument();
    for (const step of ["Welcome", "Finish your profile", "Meet your committee contact", "Read the organizing guide"]) expect(screen.getByText(step)).toBeInTheDocument();
    for (const step of ["Meet your steward", "Read the member guide"]) expect(screen.queryByText(step)).toBeNull();
    expect(screen.getByText(/When your campaign turns on its own steps, they replace this list/)).toBeInTheDocument();
    // Gate round 3 on: the chapter is checked where each platform shows
    // it, and the last step names the seeded lesson.
    expect(screen.getByText(/Then check your campaign \(in Settings on the web, at the top of Home in the app\)/)).toBeInTheDocument();
    expect(screen.getByText(/Open Organizing rights and start with the first lesson/)).toBeInTheDocument();
    // Content only: nothing to start or complete, so nothing is written for it.
    expect(screen.queryByRole("button", { name: "Start my onboarding plan" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Mentorship" }));
    expect(screen.getByText("No mentorship pair yet")).toBeInTheDocument();
  });

  it.each([
    ["en", "Onboarding", "Getting started", ["Welcome", "Finish your profile", "Meet your committee contact", "Read the organizing guide"]],
    ["es", "Incorporación", "Primeros pasos", ["Bienvenida", "Completa tu perfil", "Conoce a tu contacto del comité", "Lee la guía de organización"]],
  ])("links every built-in onboarding step in %s without creating a plan", async (lang, tab, eyebrow, titles) => {
    const client = clientFor(workspace());
    render(<LanguageProvider lang={lang}><MemberSupportView actor={actor} client={client} /></LanguageProvider>);
    const onboardingTab = await screen.findByRole("button", { name: tab });
    fireEvent.click(onboardingTab);
    const panel = document.querySelector('[aria-labelledby="member-support-onboarding-title"]');
    expect(panel.querySelector(".member-support-eyebrow")).toHaveTextContent(eyebrow);
    const destinations = ["/m", "/m/settings", "/m", "/m/rights"];
    expect(within(panel).getAllByRole("link")).toHaveLength(4);
    titles.forEach((title, index) => {
      expect(within(panel).getByRole("link", { name: new RegExp(`^${title}`) })).toHaveAttribute("href", destinations[index]);
    });
    expect(client.rpc.mock.calls.every(([name]) => name === "get_member_support_workspace")).toBe(true);
  });

  // BUG-UG-ONBOARDING-LINKS-PRESERVE-WORKSPACE-CONTEXT-20261020: the
  // built-in steps hop in place through the shell's navigate and keep the demo
  // query in their hrefs; a modified click stays the browser's.
  it("opens built-in onboarding steps in place and keeps the workspace context", async () => {
    window.history.replaceState({}, "", "/m/support/onboarding?demo=1");
    try {
      const onNavigate = vi.fn();
      render(<LanguageProvider lang="en"><MemberSupportView actor={actor} client={clientFor(workspace())} onNavigate={onNavigate} /></LanguageProvider>);
      fireEvent.click(await screen.findByRole("button", { name: "Onboarding" }));
      const panel = document.querySelector('[aria-labelledby="member-support-onboarding-title"]');
      const links = within(panel).getAllByRole("link");
      expect(links.map((link) => link.getAttribute("href"))).toEqual(["/m?demo=1", "/m/settings?demo=1", "/m?demo=1", "/m/rights?demo=1"]);
      const plain = fireEvent.click(links[1]);
      expect(plain).toBe(false);
      expect(onNavigate).toHaveBeenCalledExactlyOnceWith("settings", "/m/settings");
      const modified = fireEvent.click(links[3], { ctrlKey: true });
      expect(modified).toBe(true);
      expect(onNavigate).toHaveBeenCalledTimes(1);
      expect(fireEvent.click(links[0])).toBe(false);
      expect(onNavigate).toHaveBeenLastCalledWith("today", "/m");
    } finally {
      window.history.replaceState({}, "", "/");
    }
  });

  it("submits a canonical accommodation RPC without client-supplied tenant scope", async () => {
    const client = clientFor(workspace());
    render(<MemberSupportView actor={actor} client={client} />);
    await screen.findByRole("heading", { name: "Emergency rights checklist" });
    fireEvent.click(screen.getByRole("button", { name: "Accommodations" }));
    fireEvent.change(screen.getByLabelText("Request type"), { target: { value: "remote_work" } });
    fireEvent.change(screen.getByLabelText(/^What change or support are you requesting\?/), { target: { value: "Two remote mornings during recovery." } });
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith(
      "create_member_accommodation_request",
      expect.objectContaining({
        p_request_type: "remote_work",
        p_description: "Two remote mornings during recovery.",
      }),
    ));
    const mutationArgs = client.rpc.mock.calls.find(([name]) => name === "create_member_accommodation_request")[1];
    expect(mutationArgs).not.toHaveProperty("organization_id");
    expect(mutationArgs).not.toHaveProperty("p_organization_id");
    expect(mutationArgs).not.toHaveProperty("p_member_user_id");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Accommodation request submitted."));
    expect(screen.getByLabelText(/^What change or support are you requesting\?/)).toHaveValue("");
    expect(client.rpc.mock.calls.filter(([name]) => name === "get_member_support_workspace")).toHaveLength(2);
  });

  it("shows staff-only operation controls only for an explicitly selected authorized hat", async () => {
    const model = workspace({
      staff: true,
      hrDirectory: { id: ORG, name: "People Support", enabled: true },
      mentorshipDirectory: [
        { userId: USER, label: "Morgan Member" },
        { userId: "33333333-3333-4333-8333-333333333333", label: "Alex Staff" },
      ],
    });
    const { unmount } = render(<MemberSupportView actor={actor} client={clientFor(model)} />);
    fireEvent.click(await screen.findByRole("button", { name: "HR contact" }));
    expect(screen.queryByText("Configure HR directory")).not.toBeInTheDocument();
    unmount();

    render(<MemberSupportView actor={staffActor} client={clientFor(model)} />);
    expect(await screen.findByRole("heading", { name: "Open committee alerts" })).toBeInTheDocument();
    expect(screen.getByText("No open alerts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "HR contact" }));
    expect(screen.getByText("Configure HR directory")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mentorship" }));
    expect(screen.getByRole("heading", { name: "Create a pairing" })).toBeInTheDocument();
  });

  it("renders every bounded unavailable state and retries a missing deployment", async () => {
    const cases = [
      [{ data: { state: "empty" }, error: null }, "Organization setup is still empty"],
      [{ data: { state: "ready", organizationId: "other" }, error: null }, "Worker support isn't open to this role"],
      [{ data: null, error: { code: "42501", message: "MFA required" } }, "Two-step sign-in required"],
      [{ data: null, error: { code: "PGRST202" } }, "Worker support isn't available right now"],
      [{ data: null, error: new Error("offline") }, "Worker support could not be loaded"],
    ];

    for (const [result, heading] of cases) {
      const client = { rpc: vi.fn().mockResolvedValue(result) };
      const { unmount } = render(<MemberSupportView actor={actor} client={client} />);
      expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
      unmount();
    }

    const retryClient = { rpc: vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202" } })
      .mockResolvedValue({ data: workspace(), error: null }) };
    render(<MemberSupportView actor={actor} client={retryClient} />);
    expect(await screen.findByRole("heading", { name: "Worker support isn't available right now" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Emergency rights checklist" })).toBeInTheDocument();
  });

  it("announces a failed load assertively and keeps the other bounded states polite", async () => {
    const polite = [
      [{ data: { state: "empty" }, error: null }, "Organization setup is still empty"],
      [{ data: { state: "ready", organizationId: "other" }, error: null }, "Worker support isn't open to this role"],
      [{ data: null, error: { code: "42501", message: "MFA required" } }, "Two-step sign-in required"],
      [{ data: null, error: { code: "PGRST202" } }, "Worker support isn't available right now"],
    ];
    for (const [result, heading] of polite) {
      const { unmount } = render(<MemberSupportView actor={actor} client={{ rpc: vi.fn().mockResolvedValue(result) }} />);
      const card = (await screen.findByRole("heading", { name: heading })).closest("section");
      expect(card).toHaveAttribute("role", "status");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      unmount();
    }

    // A mapped load failure and an unmapped state that falls back to the error
    // copy (a 22023 reply becomes "invalid_input") both interrupt the reader.
    const failures = [
      { data: null, error: new Error("offline") },
      { data: null, error: { code: "22023", message: "invalid input syntax" } },
    ];
    for (const result of failures) {
      const { unmount } = render(<MemberSupportView actor={actor} client={{ rpc: vi.fn().mockResolvedValue(result) }} />);
      const loadingCard = screen.getByText("Loading worker support…").closest("section");
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Worker support could not be loaded");
      expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
      // A role swapped onto the element the polite loading card already owned
      // is not announced, so the failure card must be a freshly inserted node.
      expect(alert).not.toBe(loadingCard);
      unmount();
    }
  });

  it("operates emergency, accommodation, and HR staff workflows", async () => {
    const client = clientFor(richWorkspace());
    render(<MemberSupportView actor={staffActor} client={client} />);
    expect(await screen.findByText("Alex Member")).toBeInTheDocument();
    expect(screen.getByText("Needs a call")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Resolve alert" }));
    await waitForMutation(client, "resolve_member_emergency_checklist");
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.change(screen.getByLabelText(/^Private incident notes/), { target: { value: "Updated draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save progress" }));
    await waitForMutation(client, "save_member_emergency_checklist");
    fireEvent.click(screen.getByRole("button", { name: "Alert a committee member now" }));
    await waitForMutation(client, "alert_member_emergency_steward");
    fireEvent.click(screen.getByRole("button", { name: /Unsafe work/ }));
    expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Accommodations" }));
    //: the status badge and the staff status option both read "Approved" now.
    expect(screen.getAllByText("Approved").some((node) => node.classList.contains("member-support-status"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Withdraw request" }));
    await waitForMutation(client, "transition_member_accommodation_request");
    fireEvent.change(screen.getByLabelText("Status for Alex Member"), { target: { value: "denied" } });
    fireEvent.change(screen.getByLabelText("Staff note for Alex Member"), { target: { value: "More information required" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Update" }).at(-1));
    await waitForMutation(client, "transition_member_accommodation_request", 2);

    fireEvent.click(screen.getByRole("button", { name: "HR contact" }));
    expect(screen.getByRole("link", { name: "Call" })).toHaveAttribute("href", "tel:5550100");
    expect(screen.getByRole("link", { name: "Email" })).toHaveAttribute("href", "mailto:hr@example.test");
    fireEvent.change(screen.getByLabelText("Worker"), { target: { value: "member-2" } });
    fireEvent.change(screen.getByLabelText("Purpose"), { target: { value: "Policy question" } });
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Asked for response" } });
    fireEvent.click(screen.getByRole("button", { name: "Save contact" }));
    await waitForMutation(client, "record_member_hr_contact");
    fireEvent.click(screen.getByText("Configure HR directory"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Updated People Team" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "people@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save directory" }));
    await waitForMutation(client, "save_organization_hr_directory");
  });

  it("lets staff start an onboarding plan for a directory member who has none", async () => {
    const client = clientFor(richWorkspace({
      onboardingRoster: [{ id: "plan-2", memberUserId: "member-2", memberLabel: "Alex Member", status: "active", completedStepIds: ["step-1"] }],
      mentorshipDirectory: [
        { userId: "member-2", label: "Alex Member" },
        { userId: "member-3", label: "Jordan Member" },
      ],
    }));
    const memberOnly = render(<MemberSupportView actor={actor} client={clientFor(workspace({ onboardingProgram: [{ id: "step-1", title: "Welcome", description: "Meet the team", position: 1, active: true }] }))} />);
    await screen.findByRole("heading", { name: "Emergency rights checklist" });
    fireEvent.click(screen.getByRole("button", { name: "Onboarding" }));
    expect(screen.queryByText("Manage program and oversight")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Worker to start")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start my onboarding plan" })).toBeInTheDocument();
    memberOnly.unmount();

    render(<MemberSupportView actor={staffActor} client={client} />);
    await screen.findByRole("heading", { name: "Emergency rights checklist" });
    fireEvent.click(screen.getByRole("button", { name: "Onboarding" }));
    fireEvent.click(screen.getByText("Manage program and oversight"));

    const select = screen.getByLabelText("Worker to start");
    expect([...select.options].map((option) => option.value)).toEqual(["", "member-3"]);
    fireEvent.change(select, { target: { value: "member-3" } });
    fireEvent.click(screen.getByRole("button", { name: "Start selected worker plan" }));
    await waitForMutation(client, "start_member_onboarding_plan");
    expect(client.rpc).toHaveBeenCalledWith("start_member_onboarding_plan", expect.objectContaining({ p_member_user_id: "member-3" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Worker onboarding plan started."));
  });

  // REQ-UG-DEFAULT-NEW-MEMBER-ONBOARDING-PROGRAM-20261006
  it("replaces the starting list with the organization's own active steps", async () => {
    const own = render(<MemberSupportView actor={actor} client={clientFor(workspace({ onboardingProgram: [{ id: "step-1", title: "Sign the card", description: "At the front desk", position: 1, active: true }] }))} />);
    await screen.findByRole("heading", { name: "Emergency rights checklist" });
    fireEvent.click(screen.getByRole("button", { name: "Onboarding" }));
    expect(screen.getByText("Sign the card")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Getting started" })).not.toBeInTheDocument();
    expect(screen.queryByText("Read the member guide")).not.toBeInTheDocument();
    own.unmount();

    // Steps that are all turned off leave a member with nothing, so the starting list returns.
    const client = clientFor(workspace({ staff: true, onboardingProgram: [{ id: "step-1", title: "Sign the card", description: "", position: 1, active: false }] }));
    render(<MemberSupportView actor={staffActor} client={client} />);
    await screen.findByRole("heading", { name: "Emergency rights checklist" });
    fireEvent.click(screen.getByRole("button", { name: "Onboarding" }));
    expect(screen.getByRole("heading", { name: "Getting started" })).toBeInTheDocument();
    // Gate rounds 1 and 2 on: a member never receives turned-off steps,
    // so the one note must be true whether none were added or all are off.
    expect(screen.getByText(/has no onboarding steps turned on right now/)).toBeInTheDocument();
    expect(screen.queryByText(/has not added its own onboarding steps yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start my onboarding plan" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Manage program and oversight"));
    expect(screen.getByText(/Your first active step replaces it/)).toBeInTheDocument();
    expect(client.rpc.mock.calls.map(([name]) => name).filter((name) => /onboarding/.test(name) && !/^get_|oversight/.test(name))).toEqual([]);
  });

  it("operates onboarding and mentorship staff workflows", async () => {
    const client = clientFor(richWorkspace());
    render(<MemberSupportView actor={staffActor} client={client} />);
    await screen.findByRole("heading", { name: "Emergency rights checklist" });
    fireEvent.click(screen.getByRole("button", { name: "Onboarding" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete “Rights”" }));
    await waitForMutation(client, "complete_member_onboarding_step");
    fireEvent.click(screen.getByText("Manage program and oversight"));
    fireEvent.change(screen.getByLabelText("Step title"), { target: { value: "Benefits" } });
    fireEvent.change(screen.getByLabelText("Position"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Review benefits" } });
    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    await waitForMutation(client, "save_organization_onboarding_step");

    fireEvent.click(screen.getByRole("button", { name: "Mentorship" }));
    fireEvent.change(screen.getByLabelText("Mentor"), { target: { value: USER } });
    fireEvent.change(screen.getByLabelText("Mentee"), { target: { value: "member-2" } });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-08-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Create pairing" }));
    await waitForMutation(client, "create_member_mentorship_pair");
    fireEvent.click(screen.getByRole("button", { name: /Prepare filing/ }));
    await waitForMutation(client, "save_member_mentorship_goal");
    fireEvent.change(screen.getByLabelText("New goal for Alex Member"), { target: { value: "Attend training" } });
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
    await waitForMutation(client, "save_member_mentorship_goal", 2);
    fireEvent.change(screen.getByLabelText("New note for Alex Member"), { target: { value: "Second meeting" } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    await waitForMutation(client, "add_member_mentorship_note");
    fireEvent.change(screen.getByLabelText("New status for Alex Member"), { target: { value: "completed" } });
    fireEvent.change(screen.getByLabelText("Outcome for Alex Member"), { target: { value: "Goals met" } });
    fireEvent.click(screen.getByRole("button", { name: "Close pairing" }));
    await waitForMutation(client, "transition_member_mentorship_pair");
  });

  it.each([
    { lang: "en", alt: false, open: "Handoffs", title: "Committee handoffs", status: "Status", failure: "Handoff history could not be loaded.", retry: "Try again", empty: "No handoff history", zero: "0 pending" },
    { lang: "es", alt: true, open: "Abrir Traspasos", title: "Traspasos del comité", status: "Estado", failure: "No se pudo cargar el historial de traspasos.", retry: "Intentar de nuevo", empty: "Sin historial de traspasos", zero: "0 pendientes" },
  ])("distinguishes failed handoff history from an empty result in $lang", async ({ lang, alt, open, title, status, failure, retry, empty, zero }) => {
    let unavailable = true;
    const items = alt ? [{ id: "handoff-1", memberId: "member-2", memberName: "Alex Member", direction: "incoming", status: "pending" }] : [];
    const client = { rpc: vi.fn(async (name) => {
      if (name === "get_member_support_workspace") return { data: richWorkspace(), error: null };
      if (name === "list_member_handoffs_v2") {
        return unavailable ? { data: null, error: { code: "08006", message: "offline fixture" } }
          : { data: { items, nextCursor: null }, error: null };
      }
      return { data: null, error: null };
    }) };
    render(<LanguageProvider lang={lang}><MemberSupportView actor={staffActor} client={client} alt={alt} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: open }));
    const history = within(await screen.findByRole("region", { name: title }));

    expect(await history.findByText(failure)).toHaveAttribute("role", "alert");
    expect(history.queryByText(empty)).not.toBeInTheDocument();
    expect(history.queryByText(zero)).not.toBeInTheDocument();
    if (alt) {
      const program = within(screen.getByRole("article", { name: "Traspasos" }));
      expect(program.getByText(failure)).toBeInTheDocument();
      expect(program.getByText("—")).toBeInTheDocument();
    }

    const filter = history.getByLabelText(status);
    fireEvent.change(filter, { target: { value: "pending" } });
    await waitFor(() => expect(client.rpc).toHaveBeenLastCalledWith("list_member_handoffs_v2", expect.objectContaining({ p_status: "pending" })));

    unavailable = false;
    const retryButton = history.getByRole("button", { name: retry });
    retryButton.focus();
    fireEvent.click(retryButton);
    expect(filter).toHaveFocus();
    if (alt) {
      expect(await history.findByText("Alex Member")).toBeInTheDocument();
      expect(history.getByText("1 pendientes")).toBeInTheDocument();
    } else {
      expect(await history.findByText(empty)).toBeInTheDocument();
      expect(history.getByText(zero)).toBeInTheDocument();
    }
    expect(history.queryByText(failure)).not.toBeInTheDocument();
    expect(client.rpc).toHaveBeenLastCalledWith("list_member_handoffs_v2", expect.objectContaining({ p_status: "pending" }));
    expect(client.rpc.mock.calls.filter(([name]) => name === "get_member_support_workspace")).toHaveLength(1);

    unavailable = true;
    fireEvent.change(filter, { target: { value: "declined" } });
    expect(await history.findByText(failure)).toHaveAttribute("role", "alert");
    expect(history.queryByText(empty)).not.toBeInTheDocument();
    expect(history.getByText(alt ? "1 pendientes" : zero)).toBeInTheDocument();
  });




  it.each([false, true])("reads the pending count independently after a declined history reload (summary fails: %s)", async (summaryFails) => {
    let sent = false;
    const declined = { id: "declined", memberId: "member-2", memberName: "Alex Rivera", status: "declined" };
    const pending = { id: "pending", memberId: "member-3", memberName: "Sam Chen", status: "pending" };
    const newPending = { id: "new-pending", memberId: "member-2", memberName: "Alex Rivera", status: "pending" };
    const client = { rpc: vi.fn(async (name, args = {}) => {
      if (name === "get_member_support_workspace") return { data: richWorkspace(), error: null };
      if (name === "search_handoff_members") return { data: [{ userId: "member-2", displayName: "Alex Rivera" }], error: null };
      if (name === "search_handoff_stewards") return { data: [{ userId: "steward-2", displayName: "Taylor Steward" }], error: null };
      if (name === "initiate_member_handoff") sent = true;
      if (name === "list_member_handoffs_v2") {
        if (args.p_status === "declined") {
          return { data: { items: [{ ...declined, note: sent ? "Refreshed declined history" : "Original declined history" }], nextCursor: null }, error: null };
        }
        if (args.p_status === "pending" && summaryFails) {
          return { data: null, error: { code: "08006", message: "offline fixture" } };
        }
        return { data: { items: sent ? [pending, newPending] : [pending], nextCursor: null }, error: null };
      }
      return { data: { saved: true }, error: null };
    }) };
    render(<MemberSupportView actor={staffActor} client={client} alt />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Handoffs" }));
    const panel = within(screen.getByRole("region", { name: "Committee handoffs" }));
    const card = within(screen.getByRole("article", { name: "Handoffs" }));
    fireEvent.change(panel.getByLabelText("Status"), { target: { value: "declined" } });
    expect(await panel.findByText("Original declined history")).toBeInTheDocument();
    expect(panel.getByText("1 pending")).toBeInTheDocument();

    fireEvent.change(panel.getByLabelText("Search workers for handoff"), { target: { value: "Alex" } });
    fireEvent.click(panel.getAllByRole("button", { name: "Search" })[0]);
    fireEvent.change(panel.getByLabelText("Search receiving committee members"), { target: { value: "Taylor" } });
    fireEvent.click(panel.getAllByRole("button", { name: "Search" })[1]);
    await panel.findByRole("option", { name: "Alex Rivera" });
    await panel.findByRole("option", { name: "Taylor Steward" });
    fireEvent.change(panel.getByLabelText("Worker"), { target: { value: "member-2" } });
    fireEvent.change(panel.getByLabelText("Receiving committee member"), { target: { value: "steward-2" } });
    fireEvent.click(panel.getByRole("button", { name: "Send handoff" }));

    expect(await panel.findByText("Refreshed declined history")).toBeInTheDocument();
    expect(panel.getByLabelText("Status")).toHaveValue("declined");
    expect(client.rpc).toHaveBeenCalledWith("list_member_handoffs_v2", expect.objectContaining({ p_status: "pending" }));
    const failure = "Handoff history could not be loaded.";
    expect(panel.queryByText(failure)).not.toBeInTheDocument();
    if (summaryFails) {
      expect(panel.queryByText(/^\d+ pending$/)).not.toBeInTheDocument();
      expect(card.getByText("—")).toBeInTheDocument();
      expect(card.getByText(failure)).toBeInTheDocument();
    } else {
      expect(panel.getByText("2 pending")).toBeInTheDocument();
      expect(card.getByText("2")).toBeInTheDocument();
      expect(card.getByText("pending handoffs")).toBeInTheDocument();
      expect(card.queryByText(failure)).not.toBeInTheDocument();
    }
  });

  it("searches, pages, filters, and completes staff handoffs", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const firstPage = {
      items: [{
        id: "handoff-1", memberId: "member-2", memberName: "Alex Member",
        fromStewardName: "Morgan Member", toStewardName: "Taylor Steward",
        direction: "incoming", status: "pending", note: "Current follow-up",
        createdAt: "2026-08-29T12:00:00.000Z", canAcknowledge: true,
        canDecline: true, canCancel: true,
      }],
      nextCursor: { createdAt: "2026-08-29T12:00:00.000Z", id: "handoff-1" },
    };
    const olderPage = {
      items: [{
        id: "handoff-2", memberId: "member-3", memberName: "Jordan Member",
        fromStewardName: "Sam Steward", toStewardName: "Morgan Member",
        direction: "outgoing", status: "acknowledged", note: "",
      }],
      nextCursor: null,
    };
    const client = { rpc: vi.fn(async (name, args = {}) => {
      if (name === "get_member_support_workspace") return { data: richWorkspace(), error: null };
      if (name === "list_member_handoffs_v2") {
        return { data: args.p_before_id ? olderPage : firstPage, error: null };
      }
      if (name === "search_handoff_members") {
        return { data: [{ userId: "member-2", displayName: "Alex Member" }], error: null };
      }
      if (name === "search_handoff_stewards") {
        return { data: [{ userId: "steward-2", displayName: "Taylor Steward" }], error: null };
      }
      return { data: { saved: true }, error: null };
    }) };

    render(<MemberSupportView actor={staffActor} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Handoffs" }));
    expect(await screen.findByRole("heading", { name: "Committee handoffs" })).toBeInTheDocument();
    expect(screen.getByText("Current follow-up")).toBeInTheDocument();
    expect(screen.getByText(/Morgan Member → Taylor Steward · Incoming/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search workers for handoff"), { target: { value: "Alex" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Search" })[0]);
    fireEvent.change(screen.getByLabelText("Search receiving committee members"), { target: { value: "Taylor" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Search" })[1]);
    await waitFor(() => expect(screen.getByRole("option", { name: "Alex Member" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("option", { name: "Taylor Steward" })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Worker"), { target: { value: "member-2" } });
    fireEvent.change(screen.getByLabelText("Receiving committee member"), { target: { value: "steward-2" } });
    fireEvent.change(screen.getByLabelText(/Handoff note/), { target: { value: "Transfer the scheduled check-in." } });
    fireEvent.click(screen.getByRole("button", { name: "Send handoff" }));
    await waitForMutation(client, "initiate_member_handoff");

    fireEvent.click(screen.getByRole("button", { name: "Load older handoffs" }));
    expect(await screen.findByText("Jordan Member")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "pending" } });
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("list_member_handoffs_v2", expect.objectContaining({ p_status: "pending" })));

    const listCallsBeforeMutation = client.rpc.mock.calls.filter(([name]) => name === "list_member_handoffs_v2").length;
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await waitForMutation(client, "acknowledge_member_handoff");
    await waitFor(() => {
      const calls = client.rpc.mock.calls.filter(([name]) => name === "list_member_handoffs_v2");
      expect(calls.length).toBeGreaterThan(listCallsBeforeMutation);
      expect(calls.at(-1)[1]).toEqual(expect.objectContaining({ p_status: "pending" }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitForMutation(client, "decline_member_handoff");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitForMutation(client, "cancel_member_handoff");
    expect(window.confirm).toHaveBeenCalledWith("Cancel the pending handoff for Alex Member?");
  });

  it("shows an advisor the handoff history without the search and start controls the server refuses", async () => {
    // BUG-UG-ADVISOR-HANDOFF-DEAD-END-20261003: advisors oversee handoffs
    // but private.mi1_w2_handoff_can_initiate refuses their searches and starts.
    const advisor = { ...actor, selectedHat: "advisor", organizationRoles: ["advisor"] };
    const client = { rpc: vi.fn(async (name) => {
      if (name === "get_member_support_workspace") return { data: richWorkspace(), error: null };
      if (name === "list_member_handoffs_v2") {
        return { data: { items: [{
          id: "handoff-1", memberId: "member-2", memberName: "Alex Member",
          fromStewardName: "Morgan Member", toStewardName: "Taylor Steward",
          direction: "overseen", status: "pending", note: "Current follow-up",
          createdAt: "2026-08-29T12:00:00.000Z", canCancel: true,
        }], nextCursor: null }, error: null };
      }
      return { data: { saved: true }, error: null };
    }) };
    render(<MemberSupportView actor={advisor} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Handoffs" }));
    expect(await screen.findByText("Current follow-up")).toBeInTheDocument();
    expect(screen.getByText(/Morgan Member → Taylor Steward · Overseen/)).toBeInTheDocument();
    expect(screen.getByText("Your hat can review handoff history. A committee member, campaign lead, admin or campaign chair starts a handoff.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Search workers for handoff")).toBeNull();
    expect(screen.queryByLabelText("Search receiving committee members")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send handoff" })).toBeNull();
    // Per-handoff actions stay whatever the server offers.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(client.rpc.mock.calls.map(([name]) => name)).not.toEqual(expect.arrayContaining(["search_handoff_members"]));
  });

  for (const hat of ["steward", "coordinator", "admin", "vp"]) {
    it(`offers the ${hat} hat the handoff search and start controls`, async () => {
      const client = { rpc: vi.fn(async (name) => {
        if (name === "get_member_support_workspace") return { data: richWorkspace(), error: null };
        if (name === "list_member_handoffs_v2") return { data: { items: [], nextCursor: null }, error: null };
        return { data: { saved: true }, error: null };
      }) };
      render(<MemberSupportView actor={{ ...actor, selectedHat: hat, organizationRoles: [hat] }} client={client} />);
      fireEvent.click(await screen.findByRole("button", { name: "Handoffs" }));
      expect(await screen.findByLabelText("Search workers for handoff")).toBeInTheDocument();
      expect(screen.getByLabelText("Search receiving committee members")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Send handoff" })).toBeInTheDocument();
      expect(screen.queryByText(/Your hat can review handoff history/)).toBeNull();
    });
  }

  it("renders translated handoff directions in the Spanish view", async () => {
    const client = { rpc: vi.fn(async (name) => {
      if (name === "get_member_support_workspace") return { data: richWorkspace(), error: null };
      if (name === "list_member_handoffs_v2") {
        return { data: { items: [{
          id: "handoff-1", memberId: "member-2", memberName: "Alex Member",
          fromStewardName: "Morgan Member", toStewardName: "Taylor Steward",
          direction: "incoming", status: "pending", note: "Current follow-up",
          createdAt: "2026-08-29T12:00:00.000Z",
        }, {
          id: "handoff-2", memberId: "member-3", memberName: "Jordan Member",
          fromStewardName: "Sam Steward", toStewardName: "Morgan Member",
          direction: "outgoing", status: "acknowledged",
        }, {
          id: "handoff-3", memberId: "member-4", memberName: "Riley Member",
          fromStewardName: "Sam Steward", toStewardName: "Taylor Steward",
          direction: "overseen", status: "declined",
        }], nextCursor: null }, error: null };
      }
      return { data: { saved: true }, error: null };
    }) };
    render(<LanguageProvider lang="es"><MemberSupportView actor={staffActor} client={client} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Traspasos" }));
    expect(await screen.findByText(/Morgan Member → Taylor Steward · Entrante/)).toBeInTheDocument();
    expect(screen.getByText(/Sam Steward → Morgan Member · Saliente/)).toBeInTheDocument();
    expect(screen.getByText(/Sam Steward → Taylor Steward · Supervisado/)).toBeInTheDocument();
    expect(screen.queryByText(/\bincoming\b/i)).not.toBeInTheDocument();
  });

  it("starts an unassigned onboarding plan and reports mutation errors", async () => {
    const model = richWorkspace({ onboardingPlan: null });
    const client = clientFor(model);
    render(<MemberSupportView actor={staffActor} client={client} />);
    await screen.findByRole("heading", { name: "Emergency rights checklist" });
    fireEvent.click(screen.getByRole("button", { name: "Onboarding" }));
    fireEvent.click(screen.getByRole("button", { name: "Start my onboarding plan" }));
    await waitForMutation(client, "start_member_onboarding_plan");
  });

  it("shows the translated save failure, not the database message, without discarding the form", async () => {
    const client = { rpc: vi.fn(async (name) => name === "get_member_support_workspace"
      ? { data: workspace(), error: null }
      : { data: null, error: new Error("Request could not be saved") }) };
    render(<MemberSupportView actor={actor} client={client} />);
    await screen.findByRole("heading", { name: "Emergency rights checklist" });
    fireEvent.click(screen.getByRole("button", { name: "Accommodations" }));
    fireEvent.change(screen.getByLabelText(/^What change or support are you requesting\?/), { target: { value: "Keep this text" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("That change could not be saved."));
    expect(screen.getByRole("status")).not.toHaveTextContent("Request could not be saved");
    expect(screen.getByLabelText(/^What change or support are you requesting\?/)).toHaveValue("Keep this text");
  });

  // UX-UG-MEMBER-SUPPORT-OPTIONS-READ-AS-LOWERCASE-KEYS-20261125
  //: the options were the stored keys with the
  // underscore removed ("remote work", "follow up due"). They are words now;
  // the stored values do not change.
  it.each([
    ["en", "Accommodations", "Request type", ["Schedule", "Equipment", "Workspace", "Leave", "Communication", "Remote work", "Other"],
      "HR contact", "Channel", ["Email", "Phone", "Meeting", "Letter", "Portal", "Other"],
      "Disposition", ["Planned", "Attempted", "Reached", "Follow-up due", "Resolved"]],
    ["es", "Adaptaciones", "Tipo de solicitud", ["Horario", "Equipo", "Espacio de trabajo", "Permiso", "Comunicación", "Trabajo remoto", "Otro"],
      "Contacto de RR. HH.", "Canal", ["Correo", "Teléfono", "Reunión", "Carta", "Portal", "Otro"],
      "Disposición", ["Planificado", "Intentado", "Contactado", "Seguimiento pendiente", "Resuelto"]],
  ])("names the request type, channel and disposition options in words (%s)", async (lang, accommodations, typeLabel, types, hr, channelLabel, channels, dispositionLabel, dispositions) => {
    render(<LanguageProvider lang={lang}><MemberSupportView actor={actor} client={clientFor(workspace())} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: accommodations }));
    const optionText = (label) => Array.from(screen.getByLabelText(label).options, (option) => option.textContent);
    const optionValues = (label) => Array.from(screen.getByLabelText(label).options, (option) => option.value);
    expect(optionText(typeLabel)).toEqual(types);
    expect(optionValues(typeLabel)).toEqual(["schedule", "equipment", "workspace", "leave", "communication", "remote_work", "other"]);
    fireEvent.click(screen.getByRole("button", { name: hr }));
    expect(optionText(channelLabel)).toEqual(channels);
    expect(optionText(dispositionLabel)).toEqual(dispositions);
    expect(optionValues(dispositionLabel)).toEqual(["planned", "attempted", "reached", "follow_up_due", "resolved"]);
  });

  //, amend: every option and status-pill map of the page reads in
  // sentence case, so tabs do not mix "Under review" with "in progress". One
  // label from each changed map, read from the rendered page.
  it.each([
    ["en", { rights: ["Saved, no alert sent", "Committee member alerted"], accommodations: "Accommodations", accommodation: ["Under review", "Remote work"],
      hr: "HR contact", hrLabels: ["Name", "Phone", "Follow-up due"], onboarding: "Onboarding", onboardingPill: "Active",
      mentorship: "Mentorship", mentorshipLabels: ["Completed", "Active"], handoffs: "Handoffs", direction: /Morgan Member → Taylor Steward · Incoming/ }],
    ["es", { rights: ["Guardado, sin alerta", "Miembro del comité alertado"], accommodations: "Adaptaciones", accommodation: ["En revisión", "Trabajo remoto"],
      hr: "Contacto de RR. HH.", hrLabels: ["Nombre", "Teléfono", "Seguimiento pendiente"], onboarding: "Incorporación", onboardingPill: "Activo",
      mentorship: "Mentoría", mentorshipLabels: ["Completada", "Activa"], handoffs: "Traspasos", direction: /Morgan Member → Taylor Steward · Entrante/ }],
  ])("reads every option and status-pill label in sentence case (%s)", async (lang, expected) => {
    const client = { rpc: vi.fn(async (name) => {
      if (name === "get_member_support_workspace") return { data: richWorkspace(), error: null };
      if (name === "list_member_handoffs_v2") {
        return { data: { items: [{ id: "handoff-1", memberId: "member-2", memberName: "Alex Member", fromStewardName: "Morgan Member",
          toStewardName: "Taylor Steward", direction: "incoming", status: "pending", note: "", createdAt: "2026-08-29T12:00:00.000Z" }], nextCursor: null }, error: null };
      }
      return { data: { saved: true }, error: null };
    }) };
    render(<LanguageProvider lang={lang}><MemberSupportView actor={staffActor} client={client} /></LanguageProvider>);
    const shown = (text) => expect(screen.getAllByText(text).length, text).toBeGreaterThan(0);
    await screen.findAllByText(expected.rights[0]);
    expected.rights.forEach(shown);
    fireEvent.click(screen.getByRole("button", { name: expected.accommodations }));
    expected.accommodation.forEach(shown);
    fireEvent.click(screen.getByRole("button", { name: expected.hr }));
    expected.hrLabels.forEach(shown);
    fireEvent.click(screen.getByRole("button", { name: expected.onboarding }));
    shown(expected.onboardingPill);
    fireEvent.click(screen.getByRole("button", { name: expected.mentorship }));
    expected.mentorshipLabels.forEach(shown);
    fireEvent.click(screen.getByRole("button", { name: expected.handoffs }));
    expect(await screen.findByText(expected.direction)).toBeInTheDocument();
  });

  it("requires a follow-up date before saving a follow-up-due HR contact", async () => {
    const client = clientFor(workspace());
    render(<MemberSupportView actor={actor} client={client} />);
    await screen.findByRole("heading", { name: "Emergency rights checklist" });
    fireEvent.click(screen.getByRole("button", { name: "HR contact" }));
    fireEvent.change(screen.getByLabelText("Purpose"), { target: { value: "Leave paperwork" } });
    fireEvent.change(screen.getByLabelText("Disposition"), { target: { value: "follow_up_due" } });
    const save = screen.getByRole("button", { name: "Save contact" });
    const followUp = screen.getByLabelText(/^Follow-up date/);
    expect(followUp).toBeRequired();
    expect(screen.getByText("Required when the disposition is “Follow-up due”.")).toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.submit(save.closest("form"));
    expect(client.rpc.mock.calls.filter(([name]) => name === "record_member_hr_contact")).toHaveLength(0);

    fireEvent.change(followUp, { target: { value: "2026-10-01" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitForMutation(client, "record_member_hr_contact");
    const [, args] = client.rpc.mock.calls.find(([name]) => name === "record_member_hr_contact");
    expect(args).toMatchObject({ p_disposition: "follow_up_due", p_follow_up_on: "2026-10-01" });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("HR contact recorded."));
    expect(screen.getByLabelText("Disposition")).toHaveValue("planned");
    expect(screen.getByLabelText(/^Follow-up date/)).not.toBeRequired();
  });

  it("shows the invalid-input message when the server refuses an HR contact with 22023", async () => {
    const client = { rpc: vi.fn(async (name) => name === "get_member_support_workspace"
      ? { data: workspace(), error: null }
      : { data: null, error: { code: "22023", message: "invalid HR contact" } }) };
    render(<LanguageProvider lang="es"><MemberSupportView actor={actor} client={client} /></LanguageProvider>);
    await screen.findByRole("heading", { name: "Lista de derechos de emergencia" });
    fireEvent.click(screen.getByRole("button", { name: "Contacto de RR. HH." }));
    fireEvent.change(screen.getByLabelText("Propósito"), { target: { value: "Consulta" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar contacto" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Algunos datos no fueron aceptados. Revisa el formulario y vuelve a intentarlo."));
    expect(screen.getByRole("status")).not.toHaveTextContent("invalid HR contact");
  });

  it("lets the owner resolve an already-alerted checklist", async () => {
    const client = clientFor(richWorkspace({ emergencyChecklists: [{
      id: "checklist-own",
      memberUserId: USER,
      memberLabel: "Morgan Member",
      scenario: "disciplinary_meeting",
      status: "alerted",
      completedSteps: [0],
      notes: "Alerted",
    }] }));
    render(<MemberSupportView actor={actor} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark alert resolved" }));
    await waitForMutation(client, "resolve_member_emergency_checklist");
  });

  //  B-23: a bare "RESOLVED" over an unchecked step read as a finished
  // checklist; the chip is the steward alert's state and now says so.
  it.each([["en", "Alert resolved", "Emergency rights checklist"], ["es", "Alerta resuelta", "Lista de derechos de emergencia"]])("names a resolved alert as the alert's state, not the checklist's (%s)", async (lang, chip, heading) => {
    const client = clientFor(richWorkspace({ emergencyChecklists: [{
      id: "checklist-own", memberUserId: USER, memberLabel: "Morgan Member", scenario: "disciplinary_meeting",
      status: "resolved", completedSteps: [0, 1, 2], notes: "",
    }] }));
    render(<LanguageProvider lang={lang}><MemberSupportView actor={actor} client={client} /></LanguageProvider>);
    const panel = (await screen.findByRole("heading", { name: heading })).closest("section");
    expect(within(panel).getByText(chip, { selector: ".member-support-status" })).toBeInTheDocument();
    expect(within(panel).getAllByRole("checkbox").filter((box) => !box.checked).length).toBeGreaterThan(0);
  });

  //  gate read: the chip reads the server's status. A saved checklist is
  // draft until alert_member_emergency_steward sets alerted; a refused alert
  // raises and rolls back, so the row keeps its status, and the view does not
  // reload on that failure. An unsent or failed alert never reads "alerted".
  it.each([["no saved checklist", null, "Not started"], ["a saved draft", "draft", "Saved, no alert sent"]])("keeps %s from reading steward alerted when the alert is refused", async (_label, status, chip) => {
    const model = richWorkspace({ emergencyChecklists: status ? [{ id: "checklist-own", memberUserId: USER, memberLabel: "Morgan Member", scenario: "disciplinary_meeting", status, completedSteps: [0], notes: "" }] : [] });
    const client = { rpc: vi.fn(async (name) => {
      if (name === "get_member_support_workspace") return { data: model, error: null };
      if (name === "alert_member_emergency_steward") return { data: null, error: { code: "22023", message: "emergency steward alert rate limited" } };
      return { data: { saved: true }, error: null };
    }) };
    render(<MemberSupportView actor={actor} client={client} />);
    const panel = (await screen.findByRole("heading", { name: "Emergency rights checklist" })).closest("section");
    const chipText = () => panel.querySelector(".member-support-panel__heading .member-support-status").textContent;
    expect(chipText()).toBe(chip);
    fireEvent.click(within(panel).getByRole("button", { name: "Alert a committee member now" }));
    await waitFor(() => expect(client.rpc.mock.calls.some(([name]) => name === "alert_member_emergency_steward")).toBe(true));
    await waitFor(() => expect(within(panel).getByRole("button", { name: "Alert a committee member now" })).toBeEnabled());
    expect(chipText()).toBe(chip);
    expect(within(panel).queryByText("Committee member alerted")).toBeNull();
  });

  it("translates populated member-support status values in Spanish", async () => {
    const model = richWorkspace({
      onboardingPlan: { id: "plan-1", memberUserId: USER, status: "in_progress", completedStepIds: ["step-1"], assignedByLabel: "Sam" },
      onboardingRoster: [
        { id: "plan-2", memberLabel: "Alex Member", status: "active", completedStepIds: ["step-1"] },
        { id: "plan-3", memberLabel: "Jordan Member", status: "completed", completedStepIds: ["step-1", "step-2"] },
        { id: "plan-4", memberLabel: "Riley Member", status: "draft", completedStepIds: [] },
      ],
    });
    render(<LanguageProvider lang="es"><MemberSupportView actor={staffActor} client={clientFor(model)} /></LanguageProvider>);
    expect(await screen.findByRole("heading", { name: "Lista de derechos de emergencia" })).toBeInTheDocument();
    const statusText = () => [...document.querySelectorAll(".member-support-status")].map((node) => node.textContent);
    expect(statusText()).toEqual(expect.arrayContaining(["Guardado, sin alerta", "Miembro del comité alertado"]));
    expect(statusText().join("\n")).not.toMatch(/\b(alerted|draft|active|completed|resolved|in_progress|not_started)\b/i);

    fireEvent.click(screen.getByRole("button", { name: "Incorporación" }));
    expect(screen.getByRole("heading", { name: "Incorporación de nuevos trabajadores" })).toBeInTheDocument();
    expect(statusText()).toEqual(expect.arrayContaining(["En curso"]));
    fireEvent.click(screen.getByText("Gestionar programa y supervisión"));
    expect(statusText()).toEqual(expect.arrayContaining(["En curso", "Activo", "Completado", "Borrador"]));
    expect(statusText().join("\n")).not.toMatch(/\b(alerted|draft|active|completed|resolved|in_progress|not_started)\b/i);
    expect(screen.queryByText(/^alerted$/i)).not.toBeInTheDocument();
  });

  it("renders Spanish copy on every member-support panel", async () => {
    render(<LanguageProvider lang="es"><MemberSupportView actor={actor} client={clientFor(workspace())} /></LanguageProvider>);
    expect(await screen.findByRole("heading", { name: "Lista de derechos de emergencia" })).toBeInTheDocument();
    expect(screen.getByText("Orientación urgente")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Guardar progreso" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Adaptaciones" }));
    expect(screen.getByRole("heading", { name: "Solicitudes de adaptación" })).toBeInTheDocument();
    expect(screen.getByText("Aún no hay solicitudes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Contacto de RR. HH." }));
    expect(screen.getByRole("heading", { name: "Contacto de RR. HH." })).toBeInTheDocument();
    expect(screen.getByText("El directorio de RR. HH. no está configurado")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Incorporación" }));
    expect(screen.getByRole("heading", { name: "Incorporación de nuevos trabajadores" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Primeros pasos" })).toBeInTheDocument();
    expect(screen.getByText(/Abre Derechos de organización y empieza por la primera lección/)).toBeInTheDocument();
    expect(screen.getByText(/Luego revisa tu campaña \(en Ajustes en la web, arriba en Inicio en la app\)/)).toBeInTheDocument();
    for (const step of ["Bienvenida", "Completa tu perfil", "Conoce a tu contacto del comité", "Lee la guía de organización"]) expect(screen.getByText(step)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Mentoría" }));
    expect(screen.getByRole("heading", { name: "Mentoría" })).toBeInTheDocument();
    expect(screen.getByText("Aún no hay emparejamiento de mentoría")).toBeInTheDocument();
  });

  it("names the steward role as the organizing committee in both languages", async () => {
    // Union Ground labels the steward hat as the organizing committee
    // ("Committee" / "Comité") everywhere: the hat picker, the case-history
    // role noun and every member-support panel.
    expect(t("es", "caseHistory.role.steward")).toBe("Comité");
    expect(t("en", "caseHistory.role.steward")).toBe("Committee");
    expect(t("es", "demo.hatSteward")).toBe("Comité");
    expect(t("en", "demo.hatSteward")).toBe("Committee");
    const role = "miembro del comité";

    const source = readFileSync("src/views/MemberSupportView.jsx", "utf8");
    const copyStart = source.indexOf("const COPY = {");
    const copyEnd = source.indexOf("\n};", copyStart);
    const copySource = source.slice(copyStart, copyEnd);
    const enBlock = copySource.slice(copySource.indexOf("\n  en: {"), copySource.indexOf("\n  es: {"));
    const esBlock = copySource.slice(copySource.indexOf("\n  es: {"));
    expect(esBlock).not.toMatch(/stewardship|delegad/i);
    // Copy values only: the COPY keys keep the shared role ids.
    const enValues = [...enBlock.matchAll(/"(?:[^"\\\n]|\\.)*"/g)].map(([literal]) => literal);
    expect(enValues.length).toBeGreaterThan(100);
    expect(enValues.filter((literal) => /steward|president|coordinator/i.test(literal))).toEqual([]);
    // Pinned to the merged English block (upstream's added states and
    // handoff copy, in this edition's committee wording).
    expect(createHash("sha256").update(enBlock).digest("hex")).toBe(
      "a265c98b99d1e3815327f19da7d4506d4cbadb4faf335f5d9e805ce1f581c77e",
    );

    const spanishDesk = render(<LanguageProvider lang="es"><MemberSupportView actor={actor} client={clientFor(workspace())} /></LanguageProvider>);
    expect(await screen.findByRole("heading", { name: "Lista de derechos de emergencia" })).toBeInTheDocument();
    expect(spanishDesk.container.textContent).not.toMatch(/stewardship|delegad/i);
    expect(screen.getByRole("button", { name: `Alertar a un ${role} ahora` })).toBeInTheDocument();
    expect(screen.getByText(`Justo después, anota la hora, el lugar, las personas y los documentos, y cuéntaselo a un ${role} o a un organizador.`)).toBeInTheDocument();
    expect(screen.getByText(`Incluye solo lo que un miembro autorizado del comité necesita para responder.`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Respuesta previa a la disciplina/ }));
    expect(screen.getByText(`Contacta a un ${role} antes de enviar una respuesta.`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Trabajo inseguro/ }));
    expect(screen.getByText(`Contacta a un ${role} para el seguimiento.`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Reunión disciplinaria/ }));
    fireEvent.click(screen.getByRole("button", { name: `Alertar a un ${role} ahora` }));
    await waitFor(() => expect(screen.getByText("Alerta urgente enviada al comité.")).toBeInTheDocument());
    expect(spanishDesk.container.textContent).not.toMatch(/stewardship|delegad/i);
    spanishDesk.unmount();

    const handoffClient = { rpc: vi.fn(async (name) => {
      if (name === "get_member_support_workspace") return { data: richWorkspace(), error: null };
      if (name === "list_member_handoffs_v2") return { data: { items: [], nextCursor: null }, error: null };
      return { data: { saved: true }, error: null };
    }) };
    const spanishHandoffs = render(<LanguageProvider lang="es"><MemberSupportView actor={staffActor} client={handoffClient} /></LanguageProvider>);
    expect(await screen.findByRole("heading", { name: "Alertas abiertas del comité" })).toBeInTheDocument();
    expect(spanishHandoffs.container.textContent).not.toMatch(/stewardship|delegad/i);
    fireEvent.click(screen.getByRole("button", { name: "Traspasos" }));
    expect(await screen.findByRole("heading", { name: "Traspasos del comité" })).toBeInTheDocument();
    expect(spanishHandoffs.container.textContent).not.toMatch(/stewardship|delegad/i);
    expect(screen.getByLabelText(`El ${role} que recibe`)).toBeInTheDocument();
    const stewardSearch = screen.getByLabelText(`Buscar al ${role} que recibe`);
    expect(stewardSearch).toHaveAttribute("placeholder", `Buscar al ${role} que recibe`);
    expect(screen.getByText(`El ${role} que recibe debe confirmar antes de que cambie la relación permanente. El traspaso completado queda en el historial.`)).toBeInTheDocument();
    expect(screen.getByText(`Incluye solo el contexto que necesita el ${role} que recibe.`)).toBeInTheDocument();
    spanishHandoffs.unmount();

    const english = render(<LanguageProvider lang="en"><MemberSupportView actor={staffActor} client={handoffClient} /></LanguageProvider>);
    expect(await screen.findByRole("heading", { name: "Emergency rights checklist" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Open committee alerts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Alert a committee member now" })).toBeInTheDocument();
    expect(screen.getByText("Right after, write down the time, place, people, and documents, and tell a committee member or organizer.")).toBeInTheDocument();
    expect(screen.getByText("Only include what an authorized committee member needs to respond.")).toBeInTheDocument();
    expect(english.container.textContent).not.toMatch(/delegado|steward/i);
    fireEvent.click(screen.getByRole("button", { name: "Handoffs" }));
    expect(await screen.findByRole("heading", { name: "Committee handoffs" })).toBeInTheDocument();
    expect(screen.getByLabelText("Receiving committee member")).toBeInTheDocument();
    expect(screen.getByLabelText("Search receiving committee members")).toHaveAttribute("placeholder", "Search receiving committee members");
    expect(screen.getByText("A receiving committee member must acknowledge before the durable relationship changes. The completed transfer remains in history.")).toBeInTheDocument();
    expect(screen.getByText("Include only the context the receiving committee member needs.")).toBeInTheDocument();
    expect(english.container.textContent).not.toMatch(/delegado|steward/i);
  });

  it("names the staff hat in the scope badge instead of printing its English id", async () => {
    const spanish = render(<LanguageProvider lang="es"><MemberSupportView actor={staffActor} client={clientFor(richWorkspace())} /></LanguageProvider>);
    expect(await screen.findByRole("heading", { name: "Lista de derechos de emergencia" })).toBeInTheDocument();
    const scope = () => document.querySelector(".member-support-scope").textContent;
    expect(scope()).toBe("espacio de comité");
    expect(scope()).not.toMatch(/steward|delegado/i);
    spanish.unmount();

    const vp = render(<MemberSupportView actor={{ ...staffActor, selectedHat: "vp", organizationRoles: ["vp"] }} client={clientFor(richWorkspace())} />);
    expect(await screen.findByRole("heading", { name: "Emergency rights checklist" })).toBeInTheDocument();
    expect(scope()).toBe("Campaign chair workspace");
    expect(scope()).not.toMatch(/\bvp\b/);
    vp.unmount();
  });

  // Before recognition most
  // private-sector workers have no right to a representative in an
  // investigatory meeting. No worker-facing checklist may promise one, on the
  // web desk (both languages) or in the shared contract the native app reads.
  it("promises no right to union representation in any emergency checklist", async () => {
    const REPRESENTATION_CLAIM = /union representation|representation|representaci[oó]n|representante|waive|renunci|Weingarten|steward|delegad/i;
    const source = readFileSync("src/views/MemberSupportView.jsx", "utf8");
    const copy = source.slice(source.indexOf("const COPY = {"), source.indexOf("\n};", source.indexOf("const COPY = {")));
    for (const lang of ["en", "es"]) {
      const block = lang === "en"
        ? copy.slice(copy.indexOf("\n  en: {"), copy.indexOf("\n  es: {"))
        : copy.slice(copy.indexOf("\n  es: {"));
      const scenarios = block.slice(block.indexOf("      scenarios: {"), block.indexOf("\n    accommodations: {"));
      expect(scenarios, `${lang} scenarios block`).toContain("disciplinary_meeting");
      expect(scenarios, `${lang} checklist`).not.toMatch(REPRESENTATION_CLAIM);
    }
    for (const scenario of EMERGENCY_SCENARIOS) {
      expect([scenario.label, scenario.summary, ...scenario.steps].join(" "), scenario.id).not.toMatch(REPRESENTATION_CLAIM);
    }
    const meeting = EMERGENCY_SCENARIOS.find((item) => item.id === "disciplinary_meeting");
    expect(meeting.steps).toHaveLength(4);
    expect(meeting.steps[1]).toBe("Ask for a coworker to be present. The employer may say no, but asking is still worth it.");

    for (const lang of ["en", "es"]) {
      const view = render(<LanguageProvider lang={lang}><MemberSupportView actor={actor} client={clientFor(workspace())} /></LanguageProvider>);
      expect(await screen.findByRole("heading", { name: lang === "en" ? "Emergency rights checklist" : "Lista de derechos de emergencia" })).toBeInTheDocument();
      expect(view.container.querySelector("#member-support-rights-title").closest("section").textContent).not.toMatch(REPRESENTATION_CLAIM);
      expect(screen.getByText(lang === "en"
        ? "Ask for a coworker to be present. The employer may say no, but asking is still worth it."
        : "Pide que esté presente un compañero o compañera de trabajo. El empleador puede negarse, pero vale la pena pedirlo.")).toBeInTheDocument();
      view.unmount();
    }
  });

  it("does not style member-support tabs as buttons", () => {
    const css = readFileSync("src/features/memberSupport/member-support.css", "utf8");
    expect(css).not.toMatch(/\.member-support-tabs button/);
  });

  it("offers the staff-only handoffs tab to a staff hat only", async () => {
    const staffRender = render(<MemberSupportView actor={staffActor} client={clientFor(richWorkspace())} />);
    expect(await screen.findByRole("button", { name: "Handoffs" })).toBeInTheDocument();
    staffRender.unmount();

    render(<MemberSupportView actor={actor} client={clientFor(workspace())} />);
    await screen.findByRole("heading", { name: "Emergency rights checklist" });
    expect(screen.queryByRole("button", { name: "Handoffs" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Handoffs" })).toBeNull();
    expect(document.querySelector('a[href="/m/support/handoffs"]')).toBeNull();
  });

  // UX-UG-MEMBER-SUPPORT-DESK-UNMOUNTS-EVERY-PANEL-ON-SAVE-20260920: a
  // post-write revalidation of the same actor's desk must not tear the open
  // panel tree down, while an actor-identity change still replaces the desk.
  it("keeps the emergency panel, chosen scenario, and focus mounted across a save", async () => {
    // A browser moves focus off a disabled control at the next rendering
    // update; this test proves the panel never lets that happen mid-save.
    enableFocusFixup();
    let releaseSave;
    const saveGate = new Promise((resolve) => { releaseSave = resolve; });
    let releaseReload;
    const reloadGate = new Promise((resolve) => { releaseReload = resolve; });
    let workspaceLoads = 0;
    const client = { rpc: vi.fn(async (name) => {
      if (name === "get_member_support_workspace") {
        workspaceLoads += 1;
        if (workspaceLoads >= 2) await reloadGate;
        return { data: richWorkspace(), error: null };
      }
      if (name === "save_member_emergency_checklist") { await saveGate; return { data: { saved: true }, error: null }; }
      return { data: { saved: true }, error: null };
    }) };
    render(<MemberSupportView actor={actor} client={client} />);
    await screen.findByRole("heading", { name: "Emergency rights checklist" });

    const chosenScenario = screen.getByRole("button", { name: /Pre-discipline response/ });
    fireEvent.click(chosenScenario);
    expect(chosenScenario).toHaveAttribute("aria-pressed", "true");
    const save = screen.getByRole("button", { name: "Save progress" });
    save.focus();
    expect(document.activeElement).toBe(save);
    fireEvent.click(save);
    // A disabled element loses focus at the next rendering update (the HTML
    // focus fixup rule, which jsdom 31 runs on a timer). Let one pass before
    // checking focus, so this asserts the outcome, not a race with that timer.
    await afterRenderingUpdate();

    // Mid-write: the panel stays mounted with the chosen scenario, no
    // loading interstitial replaces it, and focus never falls to body.
    expect(screen.getByRole("heading", { name: "Emergency rights checklist" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Loading worker support…" })).toBeNull();
    expect(screen.getByRole("button", { name: /Pre-discipline response/ })).toHaveAttribute("aria-pressed", "true");
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(document.activeElement).toBe(save);
    // Still one write: a second click while it runs saves nothing more.
    fireEvent.click(save);
    expect(client.rpc.mock.calls.filter(([name]) => name === "save_member_emergency_checklist")).toHaveLength(1);
    expect(document.activeElement).not.toBe(document.body);

    releaseSave();
    await waitFor(() => expect(workspaceLoads).toBe(2));
    await afterRenderingUpdate();
    // During the post-write revalidation the open panel must stay mounted.
    expect(screen.getByRole("heading", { name: "Emergency rights checklist" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Loading worker support…" })).toBeNull();
    expect(screen.getByRole("button", { name: /Pre-discipline response/ })).toHaveAttribute("aria-pressed", "true");
    expect(document.activeElement).toBe(save);
    expect(document.activeElement).not.toBe(document.body);

    releaseReload();
    await waitFor(() => expect(document.querySelector(".member-support-notice")).toHaveTextContent("Checklist progress saved."));
    expect(screen.getByRole("heading", { name: "Emergency rights checklist" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Loading worker support…" })).toBeNull();
    expect(screen.getByRole("button", { name: /Pre-discipline response/ })).toHaveAttribute("aria-pressed", "true");
    expect(document.activeElement).toBe(save);
    expect(document.activeElement).not.toBe(document.body);
  });

  it.each(["alert", "resolve", "staff resolve"])("hands %s focus to a stable result after the held write", async (action) => {
    enableFocusFixup();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const own = { id: "own", memberUserId: USER, memberLabel: "Morgan Member", scenario: "disciplinary_meeting", status: action === "alert" ? "draft" : "alerted", completedSteps: [], notes: "" };
    let model = richWorkspace({ emergencyChecklists: [own, ...(action === "staff resolve" ? [{ ...own, id: "other", memberUserId: "member-2", memberLabel: "Alex Member" }] : [])] });
    const rpcName = action === "alert" ? "alert_member_emergency_steward" : "resolve_member_emergency_checklist";
    const client = { rpc: vi.fn(async name => {
      if (name === "get_member_support_workspace") return { data: model, error: null };
      if (name === rpcName) {
        await held;
        model = { ...model, emergencyChecklists: model.emergencyChecklists.map(item => item.id === (action === "staff resolve" ? "other" : "own") ? { ...item, status: action === "alert" ? "alerted" : "resolved" } : item) };
      }
      return { data: { saved: true }, error: null };
    }) };
    render(<MemberSupportView actor={action === "staff resolve" ? staffActor : actor} client={client} />);
    const control = await screen.findByRole("button", { name: action === "alert" ? "Alert a committee member now" : action === "resolve" ? "Mark alert resolved" : "Resolve alert" });
    control.focus(); fireEvent.click(control);
    await afterRenderingUpdate();
    expect(control).toHaveFocus();
    expect(control).toBeEnabled();
    expect(control).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(control);
    expect(client.rpc.mock.calls.filter(([name]) => name === rpcName)).toHaveLength(1);
    release();
    const result = action === "staff resolve" ? document.getElementById("member-support-alerts-title") : document.querySelector("#member-support-rights-title").closest(".member-support-panel__heading").querySelector(".member-support-status");
    await waitFor(() => expect(result).toHaveFocus());
    await afterRenderingUpdate();
    expect(result).toHaveFocus();
    if (action === "alert") expect(control).toBeDisabled();
    else expect(control).not.toBeInTheDocument();
  });


  it("retains handoff search queries and results across a handoff action", async () => {
    let releaseReload;
    const reloadGate = new Promise((resolve) => { releaseReload = resolve; });
    let workspaceLoads = 0;
    const client = { rpc: vi.fn(async (name) => {
      if (name === "get_member_support_workspace") {
        workspaceLoads += 1;
        if (workspaceLoads >= 2) await reloadGate;
        return { data: richWorkspace(), error: null };
      }
      if (name === "list_member_handoffs_v2") return { data: { items: [], nextCursor: null }, error: null };
      if (name === "search_handoff_members") return { data: [{ userId: "member-2", displayName: "Alex Member" }], error: null };
      if (name === "search_handoff_stewards") return { data: [{ userId: "steward-2", displayName: "Taylor Steward" }], error: null };
      return { data: { saved: true }, error: null };
    }) };
    render(<MemberSupportView actor={staffActor} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Handoffs" }));
    await screen.findByRole("heading", { name: "Committee handoffs" });

    fireEvent.change(screen.getByLabelText("Search workers for handoff"), { target: { value: "Alex" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Search" })[0]);
    fireEvent.change(screen.getByLabelText("Search receiving committee members"), { target: { value: "Taylor" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Search" })[1]);
    await screen.findByRole("option", { name: "Alex Member" });
    await screen.findByRole("option", { name: "Taylor Steward" });

    fireEvent.change(screen.getByLabelText("Worker"), { target: { value: "member-2" } });
    fireEvent.change(screen.getByLabelText("Receiving committee member"), { target: { value: "steward-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Send handoff" }));
    await waitFor(() => expect(workspaceLoads).toBe(2));
    expect(screen.getByRole("heading", { name: "Committee handoffs" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Loading worker support…" })).toBeNull();
    expect(screen.getByLabelText("Search workers for handoff")).toHaveValue("Alex");
    expect(screen.getByLabelText("Search receiving committee members")).toHaveValue("Taylor");
    expect(screen.getByRole("option", { name: "Alex Member" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Taylor Steward" })).toBeInTheDocument();

    releaseReload();
    await waitFor(() => expect(document.querySelector(".member-support-notice")).toHaveTextContent("Handoff sent for acknowledgement."));
    expect(screen.getByRole("heading", { name: "Committee handoffs" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Loading worker support…" })).toBeNull();
    expect(screen.getByLabelText("Search workers for handoff")).toHaveValue("Alex");
    expect(screen.getByLabelText("Search receiving committee members")).toHaveValue("Taylor");
    expect(screen.getByRole("option", { name: "Alex Member" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Taylor Steward" })).toBeInTheDocument();
  });

  it("replaces the desk behind the loading state when the actor identity changes", async () => {
    let releaseSecondLoad;
    const secondLoadGate = new Promise((resolve) => { releaseSecondLoad = resolve; });
    let workspaceLoads = 0;
    const client = { rpc: vi.fn(async (name) => {
      if (name === "get_member_support_workspace") {
        workspaceLoads += 1;
        if (workspaceLoads === 2) await secondLoadGate;
        return { data: richWorkspace(), error: null };
      }
      return { data: { saved: true }, error: null };
    }) };
    const { rerender } = render(<MemberSupportView actor={actor} client={client} />);
    await screen.findByRole("heading", { name: "Emergency rights checklist" });

    rerender(<MemberSupportView actor={{ ...actor, userId: "99999999-9999-4999-8999-999999999999" }} client={client} />);
    // The previous actor's desk is immediately replaced by the loading
    // state rather than silently refreshing stale records in place.
    expect(screen.queryByRole("heading", { name: "Emergency rights checklist" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Loading worker support…" })).toBeInTheDocument();
    releaseSecondLoad();
    expect(await screen.findByRole("heading", { name: "Emergency rights checklist" })).toBeInTheDocument();
    expect(workspaceLoads).toBe(2);
  });

  it("refetches only the handoff list when the status filter changes", async () => {
    const client = { rpc: vi.fn(async (name, args = {}) => {
      if (name === "get_member_support_workspace") return { data: richWorkspace(), error: null };
      if (name === "list_member_handoffs_v2") return { data: { items: [], nextCursor: null }, error: null };
      return { data: { saved: true }, error: null };
    }) };
    render(<MemberSupportView actor={staffActor} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Handoffs" }));
    await screen.findByRole("heading", { name: "Committee handoffs" });
    const workspaceCalls = client.rpc.mock.calls.filter(([name]) => name === "get_member_support_workspace").length;

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "pending" } });
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("list_member_handoffs_v2", expect.objectContaining({ p_status: "pending" })));
    expect(screen.getByRole("heading", { name: "Committee handoffs" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Loading worker support…" })).toBeNull();
    expect(client.rpc.mock.calls.filter(([name]) => name === "get_member_support_workspace")).toHaveLength(workspaceCalls);
  });

  // UX-UG-MEMBER-SUPPORT-DATES-FOLLOW-THE-BROWSER-NOT-THE-MEMBER-20260920.
  // Four stamps on this desk called toLocaleDateString()/toLocaleString() with
  // no locale, so the labels followed the member's language and the dates
  // followed the BROWSER — a Spanish member reading on an en-US profile (which
  // is exactly what jsdom resolves here) saw "8/1/2026" beside "Adaptaciones".
  // The two `date` columns were worse: HR follow-up and mentorship start were
  // interpolated raw, so both languages read "2026-08-02". The mentorship start
  // also pins the UTC-midnight trap: "2026-01-01" parsed bare is 31 Dec 2025 in
  // any zone west of Greenwich such as America/New_York (CI runs in UTC, where
  // the trap cannot fire; run with VITEST_KEEP_TZ=1 TZ=America/New_York to
  // exercise it).
  it("renders every member-support date in the member's language, not the browser's", async () => {
    const created = new Date("2026-08-01T12:00:00.000Z");
    const spanishDay = new Intl.DateTimeFormat(localeFor("es")).format(created);
    const englishDay = new Intl.DateTimeFormat(localeFor("en")).format(created);
    //: a stamp is a moment with its group's zone named, no seconds.
    const spanishStamp = formatGroupMoment(created, "es");
    const englishStamp = formatGroupMoment(created, "en");
    // Without this the assertions below could pass on a no-op.
    expect(spanishDay).not.toBe(englishDay);
    expect(spanishStamp).not.toBe(englishStamp);
    expect(Intl.DateTimeFormat().resolvedOptions().locale).toBe("en-US");

    const handoffClient = { rpc: vi.fn(async (name) => {
      if (name === "get_member_support_workspace") return { data: richWorkspace(), error: null };
      if (name === "list_member_handoffs_v2") {
        return { data: { items: [{
          id: "handoff-1", memberId: "member-2", memberName: "Alex Member",
          fromStewardName: "Morgan Member", toStewardName: "Taylor Steward",
          direction: "incoming", status: "pending", createdAt: created.toISOString(),
        }], nextCursor: null }, error: null };
      }
      return { data: { saved: true }, error: null };
    }) };

    const spanish = render(<LanguageProvider lang="es"><MemberSupportView actor={staffActor} client={handoffClient} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Adaptaciones" }));
    expect(spanish.container.textContent).toContain(`· ${spanishDay}`);
    expect(spanish.container.textContent).not.toContain(englishDay);

    fireEvent.click(screen.getByRole("button", { name: "Contacto de RR. HH." }));
    expect(spanish.container.textContent).toContain(`· ${spanishStamp}`);
    expect(spanish.container.textContent).toContain(`Seguimiento ${new Intl.DateTimeFormat(localeFor("es")).format(new Date("2026-08-02T12:00:00"))}`);
    expect(spanish.container.textContent).not.toContain("2026-08-02");

    fireEvent.click(screen.getByRole("button", { name: "Mentoría" }));
    const spanishStart = new Intl.DateTimeFormat(localeFor("es")).format(new Date("2026-01-01T12:00:00"));
    expect(spanish.container.textContent).toContain(`Inició ${spanishStart}`);
    expect(spanish.container.textContent).not.toContain("2026-01-01");
    // The date column is read at local noon, so it never slips to the day before.
    expect(spanish.container.textContent).not.toContain(new Intl.DateTimeFormat(localeFor("es")).format(new Date("2025-12-31T12:00:00")));

    fireEvent.click(screen.getByRole("button", { name: "Traspasos" }));
    expect(await screen.findByText(/Morgan Member → Taylor Steward/)).toBeInTheDocument();
    expect(spanish.container.textContent).toContain(spanishStamp);
    expect(spanish.container.textContent).not.toContain(englishStamp);
    spanish.unmount();

    // English is unchanged, including the day-before trap on the date columns.
    const english = render(<LanguageProvider lang="en"><MemberSupportView actor={staffActor} client={handoffClient} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Accommodations" }));
    expect(english.container.textContent).toContain(`· ${englishDay}`);
    fireEvent.click(screen.getByRole("button", { name: "Mentorship" }));
    expect(english.container.textContent).toContain(
      `Started ${new Intl.DateTimeFormat(localeFor("en")).format(new Date("2026-01-01T12:00:00"))}`,
    );
    expect(english.container.textContent).not.toContain("12/31/2025");
    expect(english.container.textContent).not.toContain("2026-01-01");
  });

  it("falls back to the unavailable label instead of printing Invalid Date", async () => {
    const model = richWorkspace({
      accommodations: [
        { id: "request-bad", memberUserId: USER, memberLabel: "Morgan Member", requestType: "schedule", description: "Earlier shift", status: "submitted", submittedAt: "not-a-date" },
      ],
    });
    render(<MemberSupportView actor={staffActor} client={clientFor(model)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Accommodations" }));
    expect(screen.getByText(/date unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
  });
});

// BUG-UG-PR1815-SUPPORT-HANDOFFS-MEMBER-NOT-DENIED-AT-A6-20260916: hiding
// the staff-only tab is not the same as refusing its URL. A member who pastes
// /m/support/handoffs must be repaired onto /m by the SAME mechanism that
// repairs a member off /m/admin (explicitHatAllowsView + the redirect effect
// in src/App.jsx), while a staff hat keeps the route untouched.
describe("the staff-only handoffs route", () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
    global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
  });

  afterEach(() => {
    window.history.replaceState({}, "", "/m");
  });

  it("registers the contract's staffOnly tabs as refused member destinations", () => {
    expect(MEMBER_SUPPORT_TABS.filter((tab) => tab.staffOnly).map((tab) => tab.id)).toEqual(["handoffs"]);
    // Coordination and the shared union connection tool use the same registry
    // (tests/coordination-staff-only-tab-routes.test.jsx owns their outcomes).
    expect(STAFF_ONLY_WORKSPACE_TAB_PATHS).toEqual([
      "/m/organize/connections",
      "/m/support/handoffs",
      "/m/coordination/coalitions",
      "/m/coordination/operations",
      "/m/coordination/mobilize",
    ]);
    expect(isStaffOnlyWorkspaceTabPath("/m/support/handoffs")).toBe(true);
    expect(isStaffOnlyWorkspaceTabPath("/m/support/handoffs/")).toBe(true);
    // The member workspace and its member tabs are untouched.
    expect(isStaffOnlyWorkspaceTabPath("/m/support")).toBe(false);
    expect(isStaffOnlyWorkspaceTabPath("/m/support/mentorship")).toBe(false);
  });

  it("repairs a member off the handoffs URL onto /m without advertising it", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/support/handoffs?demo=1");
    render(<App />);
    expect(await screen.findByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/m"));
    // The SAMPLE rider the denied link carried survives the repair.
    expect(window.location.search).toBe("?demo=1");
    expect(screen.getByText("Your Worker role cannot open that page. Opening Home instead.")).toBeInTheDocument();
    // No private surface, and the refused destination is never linked.
    expect(document.querySelector(".workspace-pages, .automation-pages, .tasks-screen")).toBeNull();
    expect(document.querySelector(".member-support-desk")).toBeNull();
    expect(document.querySelector('a[href="/m/support/handoffs"], a[href^="/m/support/handoffs?"]')).toBeNull();
  });

  it("keeps the handoffs URL for a steward hat", async () => {
    primeDemoHat("steward");
    window.history.replaceState({}, "", "/m/support/handoffs?demo=1");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Worker support" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m/support/handoffs");
    expect(screen.queryByText("Your Worker role cannot open that page. Opening Home instead.")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// UX-UG-MEMBER-SUPPORT-DESK-ES-USTED-REGISTER-20260920
//
// The desk keeps its bilingual copy in a module-private `COPY[lang]` table,
// a shape neither the catalogue sweep nor the feature-copy walker in
// tests/i18n-coverage.test.jsx reaches, and src/views/MemberSupportView.jsx is
// in neither TRANSLATED_VIEWS nor FEATURE_COPY_REMAINING. It therefore missed
// every usted census and kept formal imperatives while every screen around it
// reads tú. This guard owns the register for COPY.es so a formal form cannot
// come back.
//
// Two properties carried over from the sibling guard in
// tests/qa-entry-points-register.test.jsx, both load-bearing here:
//
// 1. Boundaries are a Spanish letter class, not `\b`. `\b` is ASCII-only, so
//    `\baléjese\b` can never match "Aléjese del peligro…" — the accent is a
//    non-word character to it. The self-test below keeps that case reachable.
// 2. Rendered text is read node by node, never as one `textContent` blob.
//    `textContent` concatenates sibling elements with no separator, which
//    destroys the left boundary of the first word of a sibling.
//
// `su`/`sus`/`le`/`les` are deliberately NOT markers here. This desk uses them
// in the third person about records, never about the reader ("…sin exponerlo
// fuera de sus participantes"), so they would only produce false failures.
// `solicita` is not a marker either: Main's usted question "¿Qué cambio o apoyo
// solicita?" is spelled exactly like the tú imperative the repaired scenario
// summary now uses ("…solicita representación…"). Morphology cannot separate
// them, so that one string is held by the frozen-copy check below instead.
// ---------------------------------------------------------------------------

// Every formal form Main's desk copy actually carried, plus the shared set the
// QA register guards carry, kept in step so a revert reaching for any of them
// is caught here too. `aléjese` and `dé` are the accented cases.
const DESK_USTED_WORDS = [
  "usted", "ustedes",
  "use", "complete", "vuelva", "seleccione", "intente", "inténtelo",
  "incluya", "elija", "pause", "solicite", "conserve", "pregunte",
  "renuncie", "especule", "anote", "confirme", "contacte", "atienda",
  "aléjese", "notifique", "documente", "agregue",
  "publique", "envíe", "busque", "haga", "dé", "escriba", "añada",
  "revise", "ingrese",
];
const DESK_LETTER = "A-Za-zÁÉÍÓÚÜÑáéíóúüñ";
const DESK_USTED_MARKERS = new RegExp(
  `(?<![${DESK_LETTER}])(?:${DESK_USTED_WORDS.join("|")})(?![${DESK_LETTER}])`,
  "i",
);

// Main's Spanish desk copy at e8245e1d8, one entry per repaired string. None of
// them may reappear in the copy table, and the marker set has to catch every one
// whose formal form is unambiguous.
const MAIN_ES_FORMAL_DESK_COPY = Object.freeze([
  "Use un espacio protegido para orientación urgente, solicitudes de adaptación, contacto con RR. HH., incorporación y mentoría.",
  "Complete la verificación configurada antes de abrir los registros protegidos de apoyo al miembro.",
  "Vuelva a Miembro o seleccione un sombrero de personal otorgado a esta cuenta.",
  "Intente de nuevo. Ningún registro protegido se modificó.",
  "Incluya solo el contexto que necesita el delegado que recibe.",
  "Elija de los resultados de búsqueda",
  "Incluya solo lo que un delegado autorizado necesita para responder.",
  "Pause la reunión, solicite representación y conserve los detalles mientras se contacta ayuda.",
  "Pregunte si la reunión podría llevar a una medida disciplinaria.",
  "Solicite claramente un delegado o representante.",
  "No renuncie a la representación ni especule sobre los hechos.",
  "Anote la hora, el lugar, las personas participantes y los documentos solicitados.",
  "Use el plazo de respuesta para entender los cargos, reunir registros y preparar una respuesta con apoyo.",
  "Solicite por escrito las acusaciones y el material de respaldo.",
  "Confirme la fecha límite de respuesta.",
  "Contacte a un delegado antes de enviar una respuesta.",
  "Conserve una copia de todo lo enviado.",
  "Atienda primero el peligro inmediato, luego conserve los hechos y use el canal de seguridad apropiado.",
  "Aléjese del peligro inmediato cuando pueda hacerlo de forma segura.",
  "Notifique al contacto de emergencia o de seguridad del trabajo apropiado.",
  "Documente la condición sin exponer información protegida del miembro.",
  "Contacte a un delegado para el seguimiento.",
  "¿Qué cambio o apoyo solicita?",
  "No agregue historiales médicos ni un diagnóstico a menos que el proceso lo exija.",
  "Elija un miembro",
]);

// The one Main string the word-marker set cannot carry, for the reason in the
// header note. It is still held by the frozen-copy check.
const DESK_MORPHOLOGICALLY_AMBIGUOUS = new Set(["¿Qué cambio o apoyo solicita?"]);

// The English half of every repaired pair: the register record changed the ES
// side only, so these must still be present byte for byte. The two bounded
// state bodies were reworded in both locales on purpose by
// UX-UG-MEMBER-SUPPORT-ERROR-STATES-DEAD-END-20261018 (plain words and
// a next step), so their entries carry that record's English.
const DESK_EN_UNCHANGED = Object.freeze([
  "Use one protected workspace for urgent guidance, accommodation intake, HR outreach, onboarding, and mentorship.",
  "Your current sign-in hasn't passed two-step verification. Sign in again and enter your two-step code, then come back. Your two-step setup is in Settings.",
  "Go back to Worker, or choose a staff role this account actually has. Ask an administrator if a role you need is missing.",
  "Try again. No protected record was changed.",
  "Include only the context the receiving committee member needs.",
  "Choose from search results",
  "Only include what an authorized committee member needs to respond.",
  // (October 15, 2026) rewrote the disciplinary-meeting
  // checklist in both languages; these are its current English lines.
  "Ask whether it could lead to discipline, ask for a coworker to be present, and keep a record while you reach the committee.",
  "Ask whether the meeting could lead to discipline.",
  "Ask for a coworker to be present. The employer may say no, but asking is still worth it.",
  "Stay calm. Don't guess or speculate, don't sign anything you disagree with, and ask for a copy of anything you are given or asked to sign.",
  "Right after, write down the time, place, people, and documents, and tell a committee member or organizer.",
  "Use the response window to understand the charges, gather records, and prepare a supported answer.",
  "Request the allegations and supporting material in writing.",
  "Confirm the response deadline.",
  "Contact a committee member before submitting a response.",
  "Keep a copy of everything submitted.",
  "Address immediate danger first, then preserve facts and use the appropriate safety channel.",
  "Move away from immediate danger when you can do so safely.",
  "Notify the appropriate emergency or workplace safety contact.",
  "Document the condition without exposing protected worker information.",
  "Contact a committee member for follow-through.",
  "What change or support are you requesting?",
  "Do not add medical records or a diagnosis unless the process explicitly requires it.",
  "Choose a worker",
]);

function deskCopyBlocks() {
  const source = readFileSync("src/views/MemberSupportView.jsx", "utf8");
  const copy = source.slice(source.indexOf("const COPY = {"));
  const body = copy.slice(0, copy.indexOf("\n};"));
  const esAt = body.indexOf("\n  es: {");
  return { en: body.slice(body.indexOf("\n  en: {"), esAt), es: body.slice(esAt) };
}

// Only the quoted literals: an object key such as `use:` would otherwise read
// as a formal imperative that never reaches a screen.
function stringLiterals(block) {
  return block.match(/"(?:[^"\\\n]|\\.)*"/g).map((literal) => literal.slice(1, -1));
}

// Every text node on its own line: sibling elements must not be concatenated
// into a word that never appears on screen, in either direction.
function deskTextLines(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const lines = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.trim();
    if (text) lines.push(text);
  }
  return lines;
}

function expectNoFormalForm(lines, where) {
  for (const line of lines) {
    expect(line, `${where} still uses usted: ${line}`).not.toMatch(DESK_USTED_MARKERS);
  }
}

describe("the member-support desk speaks tú in Spanish", () => {
  it("uses Spanish letter-class boundaries that `\\b` cannot provide", () => {
    // An imperative that ends on an accent is reachable here and unreachable
    // with `\b`: `é` is a non-word character, so `\bdé\b` has no right boundary.
    expect("Dé los hechos").toMatch(DESK_USTED_MARKERS);
    expect(/\bdé\b/i.test("Dé los hechos")).toBe(false);
    expect("Aléjese del peligro inmediato").toMatch(DESK_USTED_MARKERS);
    // And the boundary does not fire inside a longer word.
    expect("No agregues un diagnóstico").not.toMatch(DESK_USTED_MARKERS);
    expect("No renuncies ni especules").not.toMatch(DESK_USTED_MARKERS);
    expect("{completed} de {total} pasos completos").not.toMatch(DESK_USTED_MARKERS);
    // `complete` is a marker, but the desk's own infinitive must survive it.
    expect("No se pudo completar la búsqueda de miembros.").not.toMatch(DESK_USTED_MARKERS);
    expect("Complete la verificación configurada").toMatch(DESK_USTED_MARKERS);
    // The ambiguous form stays out of the marker set: it is the repaired copy.
    expect("Pausa la reunión, solicita representación").not.toMatch(DESK_USTED_MARKERS);
  });

  it("fails on every formal string Main's desk carried", () => {
    const es = deskCopyBlocks().es;
    for (const line of MAIN_ES_FORMAL_DESK_COPY) {
      if (!DESK_MORPHOLOGICALLY_AMBIGUOUS.has(line)) {
        expect(line, `marker set misses: ${line}`).toMatch(DESK_USTED_MARKERS);
      }
      expect(es, `still on Main's copy: ${line}`).not.toContain(line);
    }
    expect(DESK_MORPHOLOGICALLY_AMBIGUOUS.size, "the exemption may not grow").toBe(1);
  });

  it("leaves no formal form in the desk's private Spanish copy table", () => {
    const literals = stringLiterals(deskCopyBlocks().es);
    expect(literals.length, "es copy block did not parse").toBeGreaterThan(200);
    expectNoFormalForm(literals, "COPY.es");

    // Negative imperatives move to the tú subjunctive, and a subordinate verb
    // whose subject is the reader agrees with it.
    expect(literals).toContain("Mantén la calma. No adivines ni especules, no firmes nada con lo que no estés de acuerdo y pide una copia de todo lo que te entreguen o te pidan firmar.");
    expect(literals).toContain("No agregues historiales médicos ni un diagnóstico a menos que el proceso lo exija.");
    expect(literals).toContain("Aléjate del peligro inmediato cuando puedas hacerlo de forma segura.");
    expect(literals).toContain("¿Qué cambio o apoyo solicitas?");

    // Infinitives and strings whose subject is not the reader do not move.
    expect(literals).toContain("Intentar de nuevo");
    expect(literals).toContain("Empezar mi plan de incorporación");
    expect(literals).toContain("Elegir");
    expect(literals).toContain("Estos programas estarán disponibles cuando una administración cree la primera organización y active la membresía.");
    expect(literals).toContain("El personal puede crear un emparejamiento formal sin exponerlo fuera de sus participantes y el equipo autorizado.");
  });

  it("leaves the English desk copy unchanged", () => {
    const en = deskCopyBlocks().en;
    for (const line of DESK_EN_UNCHANGED) {
      expect(en, `English desk copy moved: ${line}`).toContain(line);
    }
  });

  it("renders every Spanish panel with no formal form on screen", async () => {
    const member = render(<LanguageProvider lang="es"><MemberSupportView actor={actor} client={clientFor(richWorkspace({ staff: false }))} /></LanguageProvider>);
    expect(await screen.findByRole("heading", { name: "Lista de derechos de emergencia" })).toBeInTheDocument();
    for (const scenario of ["Reunión disciplinaria", "Respuesta previa a la disciplina", "Trabajo inseguro"]) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(scenario) }));
      expectNoFormalForm(deskTextLines(member.container), `rights/${scenario}`);
    }
    for (const tab of ["Adaptaciones", "Contacto de RR. HH.", "Incorporación", "Mentoría"]) {
      fireEvent.click(screen.getByRole("button", { name: tab }));
      expectNoFormalForm(deskTextLines(member.container), tab);
    }
    member.unmount();

    const handoffClient = { rpc: vi.fn(async (name) => {
      if (name === "get_member_support_workspace") return { data: richWorkspace(), error: null };
      if (name === "list_member_handoffs_v2") return { data: { items: [], nextCursor: null }, error: null };
      return { data: { saved: true }, error: null };
    }) };
    const staff = render(<LanguageProvider lang="es"><MemberSupportView actor={staffActor} client={handoffClient} /></LanguageProvider>);
    expect(await screen.findByRole("heading", { name: "Lista de derechos de emergencia" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Traspasos" }));
    expect(await screen.findByRole("heading", { name: "Traspasos del comité" })).toBeInTheDocument();
    expectNoFormalForm(deskTextLines(staff.container), "Traspasos");
  });

  it("renders the bounded Spanish states with no formal form on screen", async () => {
    const cases = [
      ["mfa_required", { code: "42501", message: "MFA required" }, "Se requiere verificación en dos pasos"],
      ["unauthorized", { code: "42501", message: "not permitted" }, "El apoyo a trabajadores no está abierto para este rol"],
      ["error", new Error("boom"), "No se pudo cargar el apoyo a trabajadores"],
    ];
    for (const [state, error, heading] of cases) {
      const view = render(<LanguageProvider lang="es"><MemberSupportView actor={staffActor} client={{ rpc: vi.fn().mockResolvedValue({ data: null, error }) }} /></LanguageProvider>);
      expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
      expectNoFormalForm(deskTextLines(view.container), state);
      view.unmount();
    }
  });
});

// UX-UG-MEMBER-SUPPORT-ERROR-STATES-DEAD-END-20261018: the page the
// onboarding guide sends members to must never dead-end. Every bounded state
// speaks plain words and names a next step beside Try again, in both locales.
describe("member-support error states name a next step", () => {
  const DEVELOPER_WORDS = /\b(?:migration|migración|hat|sombrero|second-factor|environment|entorno|interface|interfaz)\b/i;
  // Union Ground publishes no support mailbox yet, so the unavailable and
  // error states offer Try again alone (src/lib/publicContact.js).
  const cases = [
    {
      state: "mfa_required",
      result: { data: null, error: { code: "42501", message: "MFA required" } },
      en: { heading: "Two-step sign-in required", link: "Two-step settings", href: "/m/settings/security" },
      es: { heading: "Se requiere verificación en dos pasos", link: "Configuración de dos pasos", href: "/m/settings/security" },
    },
    {
      state: "unauthorized",
      result: { data: { state: "ready", organizationId: "other" }, error: null },
      en: { heading: "Worker support isn't open to this role", link: "Back to Worker", href: "/m" },
      es: { heading: "El apoyo a trabajadores no está abierto para este rol", link: "Volver a Trabajador/a", href: "/m" },
    },
    {
      state: "unavailable",
      result: { data: null, error: { code: "PGRST202" } },
      en: { heading: "Worker support isn't available right now", link: null, href: null },
      es: { heading: "El apoyo a trabajadores no está disponible ahora mismo", link: null, href: null },
    },
    {
      state: "error",
      result: { data: null, error: new Error("offline") },
      en: { heading: "Worker support could not be loaded", link: null, href: null },
      es: { heading: "No se pudo cargar el apoyo a trabajadores", link: null, href: null },
    },
  ];
  const retryLabel = { en: "Try again", es: "Intentar de nuevo" };

  for (const { state, result, ...locales } of cases) {
    for (const lang of ["en", "es"]) {
      it(`${state} (${lang}) uses plain words and offers ${locales[lang].link ?? "Try again alone"}`, async () => {
        const client = { rpc: vi.fn().mockResolvedValue(result) };
        render(<LanguageProvider lang={lang}><MemberSupportView actor={staffActor} client={client} /></LanguageProvider>);
        const heading = await screen.findByRole("heading", { name: locales[lang].heading });
        const card = heading.closest("section");
        expect(card).toHaveAttribute("data-state", state);
        expect(card.textContent).not.toMatch(DEVELOPER_WORDS);
        if (locales[lang].link === null) {
          expect(within(card).queryAllByRole("link")).toEqual([]);
        } else {
          const link = within(card).getByRole("link", { name: locales[lang].link });
          expect(link).toHaveAttribute("href", locales[lang].href);
          expect(link).toHaveClass("member-support-button");
        }
        expect(within(card).getByRole("button", { name: retryLabel[lang] })).toBeInTheDocument();
      });
    }
  }

  it("keeps Try again working beside the next step and never shows a next step on a ready desk", async () => {
    const client = { rpc: vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: "42501", message: "MFA required" } })
      .mockResolvedValue({ data: workspace(), error: null }) };
    render(<MemberSupportView actor={actor} client={client} />);
    const card = (await screen.findByRole("heading", { name: "Two-step sign-in required" })).closest("section");
    expect(within(card).getByRole("link", { name: "Two-step settings" })).toHaveAttribute("href", "/m/settings/security");
    fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Emergency rights checklist" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Two-step settings" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Write to support" })).toBeNull();
  });

  // Review thread r4317745059: a two-step denial means the session must be
  // recovered (complete the enrolled factor, or sign in past a reset or
  // recovery lock), so the first action is the shell's sign-out, and the
  // settings link stays second for the reader who wants to check the factor.
  it("offers Sign in again first on a two-step denial and only when the shell can sign out", async () => {
    const mfa = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501", message: "MFA required" } }) };
    const onSignOut = vi.fn();
    const withShell = render(<MemberSupportView actor={staffActor} client={mfa} onSignOut={onSignOut} />);
    const card = (await screen.findByRole("heading", { name: "Two-step sign-in required" })).closest("section");
    const buttons = within(card).getAllByRole("button").map((button) => button.textContent);
    expect(buttons).toEqual(["Sign in again", "Try again"]);
    expect(within(card).getByRole("button", { name: "Sign in again" })).not.toHaveClass("member-support-button--secondary");
    fireEvent.click(within(card).getByRole("button", { name: "Sign in again" }));
    // Called bare: the shell's sign-out defaults its scope to "local".
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(onSignOut).toHaveBeenCalledWith();
    expect(card.textContent).not.toMatch(/set up/i);
    withShell.unmount();

    render(<MemberSupportView actor={staffActor} client={mfa} />);
    const alone = (await screen.findByRole("heading", { name: "Two-step sign-in required" })).closest("section");
    expect(within(alone).queryByRole("button", { name: "Sign in again" })).toBeNull();
    expect(within(alone).getByRole("link", { name: "Two-step settings" })).toHaveAttribute("href", "/m/settings/security");
  });

  it("never offers Sign in again without a client, even when the shell hands one over", async () => {
    render(<MemberSupportView actor={staffActor} client={null} onSignOut={vi.fn()} />);
    const card = (await screen.findByRole("heading", { name: "Worker support isn't available right now" })).closest("section");
    expect(within(card).queryByRole("button", { name: "Sign in again" })).toBeNull();
    expect(within(card).queryByRole("link", { name: "Write to support" })).toBeNull();
  });

  // Review thread r4317745041: under a worn staff hat, Back to Member must go
  // through the shell's navigation (which switches the hat), not only the route.
  it("takes a worn staff hat off through the shell's switchHat on Back to Member and keeps modified clicks for the browser", async () => {
    const unauthorized = () => ({ rpc: vi.fn().mockResolvedValue({ data: { state: "ready", organizationId: "other" }, error: null }) });
    const onNavigate = vi.fn();
    const onSwitchHat = vi.fn();
    const worn = render(<MemberSupportView actor={staffActor} client={unauthorized()} onNavigate={onNavigate} onSwitchHat={onSwitchHat} />);
    const link = await screen.findByRole("link", { name: "Back to Worker" });
    expect(link).toHaveAttribute("href", "/m");
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    expect(onSwitchHat).not.toHaveBeenCalled();
    expect(fireEvent.click(link)).toBe(false);
    expect(onSwitchHat).toHaveBeenCalledWith("member");
    expect(onNavigate).not.toHaveBeenCalled();
    worn.unmount();

    // Already the Member hat: there is no identity to change, so the shell's
    // navigate takes the reader home.
    const member = render(<MemberSupportView actor={actor} client={unauthorized()} onNavigate={onNavigate} onSwitchHat={onSwitchHat} />);
    expect(fireEvent.click(await screen.findByRole("link", { name: "Back to Worker" }))).toBe(false);
    expect(onSwitchHat).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("today", "/m");
    member.unmount();

    // A shell with navigation but no hat switcher still gets the hop.
    const navigateOnly = vi.fn();
    render(<MemberSupportView actor={staffActor} client={unauthorized()} onNavigate={navigateOnly} />);
    expect(fireEvent.click(await screen.findByRole("link", { name: "Back to Worker" }))).toBe(false);
    expect(navigateOnly).toHaveBeenCalledWith("today", "/m");
  });

  it("uses a mounted workspace router when the shell gives no navigation, and a plain anchor when neither exists", async () => {
    const unauthorized = () => ({ rpc: vi.fn().mockResolvedValue({ data: { state: "ready", organizationId: "other" }, error: null }) });
    const navigate = vi.fn();
    const routed = render(<LanguageProvider lang="en"><WorkspacePages view="memberSupport" location="/m/support" navigate={navigate} hat="steward">
      <MemberSupportView actor={staffActor} client={unauthorized()} />
    </WorkspacePages></LanguageProvider>);
    const link = await screen.findByRole("link", { name: "Back to Worker" });
    expect(fireEvent.click(link)).toBe(false);
    expect(navigate).toHaveBeenCalledWith("today", "/m", null, { replace: false });
    routed.unmount();

    render(<MemberSupportView actor={staffActor} client={unauthorized()} />);
    const plain = await screen.findByRole("link", { name: "Back to Worker" });
    expect(fireEvent.click(plain)).toBe(true);
  });

  it("falls back to the support mailbox when the desk reports an unmapped state", async () => {
    render(<MemberSupportView actor={actor} client={{ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "22023", message: "invalid input syntax" } }) }} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("data-state", "error");
    expect(within(alert).queryByRole("link", { name: "Write to support" })).toBeNull();
    expect(alert.textContent).not.toMatch(/invalid input syntax/);
  });

  it("never names the support mailbox or a settings link on the empty organization state", async () => {
    render(<MemberSupportView actor={actor} client={{ rpc: vi.fn().mockResolvedValue({ data: { state: "empty" }, error: null }) }} />);
    const card = (await screen.findByRole("heading", { name: "Organization setup is still empty" })).closest("section");
    expect(within(card).queryByRole("link")).toBeNull();
    expect(within(card).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

// UI behavior is independent of the encrypted HTTP transport, covered separately.
vi.mock("../src/lib/sensitiveContentApi.js", () => ({ sensitiveContentRpc: (client, name, args) => client.rpc(name, args) }));

