import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { MemberSupportView } from "../src/views/MemberSupportView.jsx";
import { RightsView } from "../src/views/RightsView.jsx";
import { SettingsView } from "../src/views/SettingsView.jsx";
import { altHelpPagesCatalogue } from "../src/lib/i18n/altHelpPages.js";
import { NOTIFICATION_TOPIC_KEYS } from "../src/lib/memberApi.js";
import { matchPrograms } from "../src/alt/help/HelpMatcher.jsx";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

// REQ-UG-ALT-PORT-MEMBER-PAGES-20261030: the alternate shell's Help,
// Organizing rights, Account and Alerts pages are the prototype's pages
// (pages/help.js, account.js, alerts.js) built on each view's own state,
// data and handlers; alt=false keeps every classic page as it was.

vi.mock("../src/lib/sensitiveContentApi.js", () => ({ sensitiveContentRpc: (client, name, args) => client.rpc(name, args) }));

const en = altHelpPagesCatalogue.en;
const es = altHelpPagesCatalogue.es;

beforeEach(() => {
  clearDeviceParityState();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/m");
});
afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

// ── Help (MemberSupportView) ───────────────────────────────────────────────

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const actor = { userId: USER, selectedOrganizationId: ORG, membershipStatus: "active", selectedHat: "member", mfaSatisfied: true };

function desk(overrides = {}) {
  return {
    state: "ready",
    organizationId: ORG,
    staff: false,
    emergencyChecklists: [],
    accommodations: [
      { id: "request-own", memberUserId: USER, memberLabel: "Test Member", requestType: "schedule", description: "Earlier shift", status: "submitted", submittedAt: "2026-08-01T12:00:00.000Z" },
    ],
    accommodationSummary: { total: 1, open: 1, approved: 0, denied: 0, withdrawn: 0 },
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

function clientFor(model, { fail = false } = {}) {
  return { rpc: vi.fn(async (name) => {
    if (fail) return { data: null, error: { message: "boom" } };
    if (name === "get_member_support_workspace") return { data: model, error: null };
    if (name === "list_member_handoffs_v2") return { data: { items: [{ id: "h1", memberId: "m9", status: "pending", memberName: "Member Nine", fromStewardName: "Steward One", toStewardName: "Steward Two", direction: "outgoing", createdAt: "2026-08-01T12:00:00Z" }], nextCursor: null }, error: null };
    return { data: { saved: true }, error: null };
  }) };
}

function showHelp({ lang = "en", model = desk(), alt = true, fail = false, actorOverride = actor, onNavigate = vi.fn() } = {}) {
  const onOpenHome = vi.fn();
  render(
    <LanguageProvider lang={lang}>
      <MemberSupportView actor={actorOverride} client={clientFor(model, { fail })} alt={alt} onOpenHome={onOpenHome} onNavigate={onNavigate} />
    </LanguageProvider>,
  );
  return { onOpenHome, onNavigate };
}

describe("the alternate shell's Help page", () => {
  it("draws the prototype's hero, toolbar and program cards on the live desk", async () => {
    const { onOpenHome, onNavigate } = showHelp();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Where to get help");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", { name: "Now" }));
    expect(onOpenHome).toHaveBeenCalled();
    const grid = await screen.findByRole("region", { name: en["altHelpPages.helpCrumb"] });
    const cards = within(grid).getAllByRole("article");
    expect(cards.map((card) => within(card).getByRole("button").textContent)).toHaveLength(5);
    const accommodations = within(grid).getByRole("article", { name: "Accommodations" });
    expect(within(accommodations).getByText("1")).toHaveClass("ug-amt");
    expect(within(accommodations).getByText(en["altHelpPages.prog_accommodations_fig"])).toBeInTheDocument();
    expect(within(accommodations).getByRole("img", { name: en["altHelpPages.hardAria"] })).toBeInTheDocument();
    expect(screen.getByText(en["altHelpPages.helpLede"].replace("{count}", "5"))).toBeInTheDocument();
    // The open program is the rights checklist, the desk's default tab.
    expect(screen.getByRole("heading", { level: 2, name: "Emergency rights checklist" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: en["altHelpPages.helpRights"] }));
    expect(onNavigate).toHaveBeenCalledWith("rights", "/m/rights");
    onNavigate.mockClear();
    fireEvent.click(screen.getByRole("button", { name: en["altHelpPages.helpRights"] }));
    expect(onNavigate).toHaveBeenCalledWith("rights", "/m/rights");
  });

  it("closes the matcher from its close button", async () => {
    showHelp();
    await screen.findByRole("region", { name: en["altHelpPages.helpCrumb"] });
    fireEvent.click(screen.getByRole("button", { name: en["altHelpPages.helpMatch"] }));
    const dialog = screen.getByRole("dialog", { name: en["altHelpPages.helpMatch"] });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.transitionEnd(document.querySelector(".dialog-backdrop"));
    await waitFor(() => expect(document.querySelector(".dialog-backdrop")).toBeNull(), { timeout: 2000 });
  });

  it("filters by chip and search, with the prototype's empty state", async () => {
    showHelp();
    const grid = await screen.findByRole("region", { name: en["altHelpPages.helpCrumb"] });
    const chips = screen.getByRole("group", { name: en["altHelpPages.helpFor"] });
    expect(within(chips).queryByRole("button", { name: /Staff/ })).toBeNull();
    fireEvent.click(within(chips).getByRole("button", { name: /At work/ }));
    expect(within(grid).getAllByRole("article")).toHaveLength(2);
    fireEvent.change(screen.getByRole("searchbox", { name: en["altHelpPages.helpSearch"] }), { target: { value: "nothing like this" } });
    expect(within(grid).getByText(en["altHelpPages.helpNone"])).toBeInTheDocument();
  });

  it("opens a program's own production panel and keeps its actions", async () => {
    const { onNavigate } = showHelp();
    const grid = await screen.findByRole("region", { name: en["altHelpPages.helpCrumb"] });
    fireEvent.click(within(within(grid).getByRole("article", { name: "Mentorship" })).getByRole("button"));
    expect(await screen.findByRole("heading", { level: 2, name: "Mentorship" })).toBeInTheDocument();
    expect(within(within(grid).getByRole("article", { name: "Mentorship" })).getByRole("button")).toHaveAttribute("aria-current", "true");
    fireEvent.click(within(within(grid).getByRole("article", { name: "Onboarding" })).getByRole("button"));
    expect(await screen.findByRole("heading", { level: 2, name: "New-worker onboarding" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en["altHelpPages.messageSteward"] }));
    expect(onNavigate).toHaveBeenCalledWith("messages", "/m/messages");
  });

  it("matches a situation to programs and opens the pick", async () => {
    const { onNavigate } = showHelp();
    await screen.findByRole("region", { name: en["altHelpPages.helpCrumb"] });
    fireEvent.click(screen.getByRole("button", { name: en["altHelpPages.helpMatch"] }));
    const dialog = screen.getByRole("dialog", { name: en["altHelpPages.helpMatch"] });
    expect(within(dialog).getByText("Question 1 of 2")).toBeInTheDocument();
    const next = (box) => fireEvent.click(within(box).getByRole("button", { name: /^(Next|See what fits)$/ }));
    expect(within(dialog).getByRole("button", { name: "Next" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("radio", { name: en["altHelpPages.matchA_change"] }));
    // Arrow keys move the choice through the shared radio model without moving on.
    fireEvent.keyDown(within(dialog).getByRole("radio", { name: en["altHelpPages.matchA_change"] }), { key: "ArrowDown" });
    expect(within(dialog).getByText("Question 1 of 2")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("radio", { name: en["altHelpPages.matchA_change"] }));
    next(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: en["altHelpPages.matchBack"] }));
    expect(within(dialog).getByRole("radio", { name: en["altHelpPages.matchA_change"] })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(dialog).getByRole("radio", { name: en["altHelpPages.matchA_meeting"] }));
    next(dialog);
    fireEvent.click(within(dialog).getByRole("radio", { name: en["altHelpPages.matchA_now"] }));
    next(dialog);
    expect(within(dialog).getByText(en["altHelpPages.matchUrgent"])).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: en["altHelpPages.matchRestart"] }));
    fireEvent.click(within(dialog).getByRole("radio", { name: en["altHelpPages.matchA_hr"] }));
    next(dialog);
    fireEvent.click(within(dialog).getByRole("radio", { name: en["altHelpPages.matchA_later"] }));
    next(dialog);
    expect(within(dialog).getByText(en["altHelpPages.matchCalm"])).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: en["altHelpPages.matchSay"] })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /HR contact/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByRole("heading", { level: 2, name: "HR contact" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: en["altHelpPages.helpMatch"] }));
    const again = screen.getByRole("dialog", { name: en["altHelpPages.helpMatch"] });
    fireEvent.click(within(again).getByRole("radio", { name: en["altHelpPages.matchA_meeting"] }));
    next(again);
    fireEvent.click(within(again).getByRole("radio", { name: en["altHelpPages.matchA_soon"] }));
    next(again);
    fireEvent.click(within(again).getByRole("button", { name: en["altHelpPages.matchSay"] }));
    expect(onNavigate).toHaveBeenCalledWith("rights", "/m/rights");
  });

  it("matches only programs the desk offers", () => {
    const programs = [{ id: "rights" }, { id: "mentorship" }];
    expect(matchPrograms({ what: "grow" }, programs).map((item) => item.id)).toEqual(["mentorship"]);
    expect(matchPrograms({}, programs)).toEqual([]);
  });

  it("shows live figures for staff, onboarding and an alerted checklist", async () => {
    showHelp({
      actorOverride: { ...actor, selectedHat: "steward", organizationRoles: ["steward"] },
      model: desk({
        staff: true,
        emergencyChecklists: [{ id: "own", memberUserId: USER, memberLabel: "Test Member", scenario: "unsafe_work", status: "alerted", completedSteps: [0], notes: "" }],
        onboardingProgram: [{ id: "s1", title: "One", description: "", position: 1, active: true }, { id: "s2", title: "Two", description: "", position: 2, active: true }],
        onboardingPlan: { id: "plan", status: "in_progress", completedStepIds: ["s1"] },
        mentorshipPairs: [{ id: "pair-1", mentorUserId: USER, menteeUserId: "member-2", mentorLabel: "Mentor Person", menteeLabel: "Mentee Person", status: "active", startedOn: "2026-01-01", outcome: "", goals: [], notes: [] }],
      }),
    });
    const grid = await screen.findByRole("region", { name: en["altHelpPages.helpCrumb"] });
    const handoffs = within(grid).getByRole("article", { name: "Handoffs" });
    expect(within(handoffs).getByText(en["altHelpPages.prog_handoffs_fig"]).previousSibling).toHaveTextContent("1");
    const mentorship = within(grid).getByRole("article", { name: "Mentorship" });
    expect(within(mentorship).getByText(en["altHelpPages.prog_mentorship_fig"]).previousSibling).toHaveTextContent("1");
    expect(within(grid).getByText("1/2")).toBeInTheDocument();
    expect(within(grid).getByText(en["altHelpPages.prog_rights_alerted"])).toBeInTheDocument();
    expect(screen.getByText(/Committee workspace/)).toBeInTheDocument();
  });

  it("keeps the desk's error state under the hero and offers no cards", async () => {
    showHelp({ fail: true });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: en["altHelpPages.helpCrumb"] })).toBeNull();
    expect(screen.getByRole("button", { name: en["altHelpPages.helpMatch"] })).toBeDisabled();
  });

  it("speaks Spanish", async () => {
    showHelp({ lang: "es" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Dónde conseguir ayuda");
    expect(await screen.findByRole("region", { name: es["altHelpPages.helpCrumb"] })).toBeInTheDocument();
    expect(screen.getAllByText(es["altHelpPages.hardNone"]).length).toBeGreaterThan(0);
  });

  it("keeps the classic desk when alt is off", async () => {
    showHelp({ alt: false });
    expect(screen.getByRole("heading", { level: 1, name: "Worker support" })).toBeInTheDocument();
    expect(screen.queryByText(en["altHelpPages.helpH1Accent"])).toBeNull();
  });
});

// ── Organizing rights (RightsView) ──────────────────────────────────────────

function rightsData() {
  const lessonRecords = fallbackData.rights.lessonRecords.map((item) => (
    item.id === "supervisor-questions" ? { ...item, completedSteps: [0] }
      : item.id === "cards-majority" ? { ...item, completedSteps: item.steps.map((_, index) => index) }
        : item
  ));
  return { ...fallbackData, rights: { ...fallbackData.rights, lessonRecords } };
}

function showRights({ lang = "en", alt = true, stewardRequests = [], ...props } = {}) {
  const handlers = {
    onAssistant: vi.fn(),
    onSaveProgress: vi.fn().mockResolvedValue(undefined),
    onRequestSteward: vi.fn().mockResolvedValue(undefined),
    onMessageSteward: vi.fn(),
    onOpenHome: vi.fn(),
    ...props,
  };
  render(
    <LanguageProvider lang={lang}>
      <RightsView alt={alt} desktop data={rightsData()} stewardRequests={stewardRequests} {...handlers} />
    </LanguageProvider>,
  );
  return handlers;
}

describe("the alternate shell's Organizing rights", () => {
  it("draws the hero, the open lesson's checklist and the Say this card", async () => {
    const handlers = showRights();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Organizing rights");
    fireEvent.click(screen.getByRole("link", { name: "Now" }));
    expect(handlers.onOpenHome).toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 2, name: "You can talk about forming a union" })).toBeInTheDocument();
    const steps = screen.getAllByRole("checkbox");
    expect(steps).toHaveLength(4);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    await act(async () => { fireEvent.click(steps[0]); });
    expect(handlers.onSaveProgress).toHaveBeenCalledWith("section-7", [0]);
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy the script" })); });
    expect(navigator.clipboard.writeText).toHaveBeenCalled();
    expect(screen.getByRole("status")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "The contract, searchable" }));
    expect(handlers.onAssistant).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: en["altHelpPages.messageSteward"] }));
    expect(handlers.onMessageSteward).toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Request" })); });
    expect(handlers.onRequestSteward).toHaveBeenCalledWith("section-7");
  });

  it("filters guides by progress and search", () => {
    showRights();
    const chips = screen.getByRole("group", { name: en["altHelpPages.rightsProgress"] });
    expect(within(chips).getByRole("button", { name: /^All/ })).toHaveTextContent("5");
    fireEvent.click(within(chips).getByRole("button", { name: /In progress/ }));
    expect(screen.getAllByRole("article").map((item) => item.getAttribute("aria-labelledby"))).toEqual(["ug-guide-supervisor-questions"]);
    fireEvent.click(within(chips).getByRole("button", { name: /Done/ }));
    expect(screen.getAllByRole("article").map((item) => item.getAttribute("aria-labelledby"))).toEqual(["ug-guide-cards-majority"]);
    fireEvent.click(within(chips).getByRole("button", { name: /Not started/ }));
    expect(screen.getAllByRole("article")).toHaveLength(3);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "no such guide" } });
    expect(screen.getByText(en["altHelpPages.rightsNone"])).toBeInTheDocument();
  });

  it("opens a guide as the prototype's guide page and goes back", async () => {
    showRights({ stewardRequests: [{ id: "r1", lesson_id: "supervisor-questions", status: "acknowledged", created_at: "2026-08-08T10:00:00Z" }] });
    fireEvent.click(screen.getByRole("button", { name: /Read If a supervisor asks about organizing/ }));
    expect(screen.getByRole("heading", { level: 1, name: "If a supervisor asks about organizing" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText(en["altHelpPages.rightsUsefulBody"])).toBeInTheDocument();
    expect(screen.getByText("A committee member is on it.")).toBeInTheDocument();
    const more = screen.getByRole("heading", { level: 3, name: en["altHelpPages.rightsMoreGuides"] }).parentElement;
    fireEvent.click(within(more).getByRole("button", { name: /You do not have to agree in a captive meeting/ }));
    expect(screen.getByRole("heading", { level: 1, name: "You do not have to agree in a captive meeting" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: en["altHelpPages.helpRights"] }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Organizing rights");
    // The hero's button resumes the guide already in progress.
    fireEvent.click(screen.getByRole("button", { name: /Continue the walkthrough/ }));
    expect(screen.getByRole("heading", { level: 1, name: "If a supervisor asks about organizing" })).toBeInTheDocument();
  });

  it("opens the open lesson from the Say this card and states a sent request", async () => {
    const onRequestSteward = vi.fn().mockRejectedValue(new Error("offline"));
    showRights({ onRequestSteward, onAssistant: null, onMessageSteward: null, stewardRequests: [{ id: "r2", lesson_id: "section-7", status: "requested", created_at: "2026-08-08T10:00:00Z" }] });
    expect(screen.queryByRole("button", { name: "The contract, searchable" })).toBeNull();
    expect(screen.queryByRole("button", { name: en["altHelpPages.messageSteward"] })).toBeNull();
    expect(screen.getByText("Request sent — a committee member has been pinged.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en["altHelpPages.rightsOpenGuide"] }));
    expect(screen.getByRole("heading", { level: 1, name: "You can talk about forming a union" })).toBeInTheDocument();
    const more = screen.getByRole("heading", { level: 3, name: en["altHelpPages.rightsMoreGuides"] }).parentElement;
    fireEvent.click(within(more).getByRole("button", { name: /If a supervisor asks about organizing/ }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Request" })); });
    expect(onRequestSteward).toHaveBeenCalledWith("supervisor-questions");
    expect(screen.getByRole("button", { name: "Request" })).not.toBeDisabled();
  });

  it("starts the first guide and lists no others when it is the only one", () => {
    const only = fallbackData.rights.lessonRecords.find((item) => item.id === "section-7");
    render(
      <LanguageProvider lang="en">
        <RightsView alt desktop data={{ ...fallbackData, rights: { ...fallbackData.rights, lessonRecords: [only] } }} onSaveProgress={vi.fn()} onRequestSteward={vi.fn().mockResolvedValue(undefined)} />
      </LanguageProvider>,
    );
    expect(screen.getByText("Now").tagName).toBe("SPAN");
    fireEvent.click(screen.getByRole("button", { name: /Start the walkthrough/ }));
    expect(screen.getByText(en["altHelpPages.rightsNoOthers"])).toBeInTheDocument();
  });

  it("keeps the learning editor under the crumb trail", async () => {
    const client = { rpc: vi.fn(async () => ({ data: null, error: { code: "PGRST202", message: "none" } })) };
    const onLearningSection = vi.fn();
    render(
      <LanguageProvider lang="en">
        <RightsView alt data={fallbackData} onSaveProgress={vi.fn()} onRequestSteward={vi.fn()} learningContent={{ client, session: { user: { id: "user-1" } }, organizationId: "org-1", chapterId: "chapter-1", locale: "en" }} learningSection="manage" onLearningSection={onLearningSection} />
      </LanguageProvider>,
    );
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByText("Manage quotes and lessons")).toBeInTheDocument();
    fireEvent.click(within(crumbs).getByRole("link", { name: en["altHelpPages.helpRights"] }));
    expect(onLearningSection).toHaveBeenCalledWith("library");
    expect(await screen.findByRole("heading", { level: 1 }, { timeout: 8_000 })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("speaks Spanish", () => {
    showRights({ lang: "es" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Derechos de organización");
    expect(screen.getByRole("group", { name: es["altHelpPages.rightsProgress"] })).toBeInTheDocument();
  });

  it("keeps the classic page when alt is off", () => {
    showRights({ alt: false });
    expect(screen.queryByRole("group", { name: en["altHelpPages.rightsProgress"] })).toBeNull();
    expect(document.querySelector(".learn-desktop")).not.toBeNull();
  });
});

// ── Account and Alerts (SettingsView) ──────────────────────────────────────

const authClient = () => ({
  rpc: vi.fn(async (name) => (name === "get_my_sms_preference"
    ? { data: { activationStatus: "active", consented: true, phoneLast4: "0123" }, error: null }
    : { data: { available: false, hasPin: false }, error: null })),
  auth: { updateUser: vi.fn(), mfa: { listFactors: vi.fn().mockResolvedValue({ data: { all: [], totp: [] }, error: null }) } },
});

function settingsData(overrides = {}) {
  return {
    member: {
      initials: "TM",
      fullName: "Test Member",
      firstName: "Test",
      email: "member@example.test",
      sinceYear: 2019,
      chapterName: "North Chapter",
      chapterId: "c1",
      chapterMemberships: [{ chapterId: "c1", name: "North Chapter", selected: true }],
      notificationPrefs: {},
      dndEnabled: false,
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
    },
    roles: [],
    organizationConfiguration: null,
    staffMfa: null,
    rewards: { totalPoints: 120, tierNumber: 2, tierName: "Builder", nextTierName: "Leader", pointsToGo: 80, isMaxTier: false, weekStreak: 3, actionsYtd: null },
    events: [
      { id: "e1", title: "Chapter meeting", startsAt: "2026-11-05T22:00:00Z", rsvpStatus: "going", isPast: false },
      { id: "e2", title: "Past meeting", startsAt: "2026-01-05T22:00:00Z", rsvpStatus: "going", isPast: true },
    ],
    forms: [],
    ...overrides,
  };
}

function showSettings({ lang = "en", path = null, data = settingsData(), alt = true, push = { supported: true, denied: false, subscribed: false }, client = authClient(), ...props } = {}) {
  const handlers = {
    onNavigate: vi.fn(),
    onProfile: vi.fn(),
    onSignOut: vi.fn(),
    onOpenHome: vi.fn(),
    onNotificationPrefs: vi.fn().mockResolvedValue(undefined),
    onFocusSettings: vi.fn().mockResolvedValue(undefined),
    onPushSubscribe: vi.fn().mockResolvedValue(undefined),
    onPushUnsubscribe: vi.fn().mockResolvedValue(undefined),
    onPushRefresh: vi.fn().mockResolvedValue(undefined),
    loadCalendarFeedStatus: vi.fn().mockResolvedValue(false),
    onCalendarRotate: vi.fn().mockResolvedValue({ token: "abc" }),
    onCalendarRevoke: vi.fn().mockResolvedValue({ revoked: true }),
    onAddShortcut: vi.fn(),
    onLanguage: vi.fn(),
    ...props,
  };
  const view = (
    <SettingsView alt={alt} data={data} lang={lang} push={push} authClient={client} {...handlers} />
  );
  if (path) window.history.replaceState({}, "", path);
  render(
    <LanguageProvider lang={lang}>
      {path ? <WorkspacePages view="settings" hat="member" location={window.location.href} navigate={vi.fn()}>{view}</WorkspacePages> : view}
    </LanguageProvider>,
  );
  return handlers;
}

describe("the alternate shell's Account page", () => {
  it("greets the member with the prototype's hero, figures and panels", async () => {
    const handlers = showSettings();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Hi, Test");
    expect(screen.getByText(/worker since 2019 · signed in as member@example.test/)).toBeInTheDocument();
    const figures = screen.getByRole("region", { name: en["altHelpPages.kpisLabel"] });
    expect(within(figures).getByRole("img", { name: "60% of the way to Leader" })).toBeInTheDocument();
    expect(within(figures).getByText("80 points to Leader")).toBeInTheDocument();
    expect(within(figures).getByText("3 weeks")).toBeInTheDocument();
    expect(within(figures).getAllByText(en["altHelpPages.kpiNotTracked"])).toHaveLength(2);
    expect(screen.getByText("Chapter meeting")).toBeInTheDocument();
    expect(screen.queryByText("Past meeting")).toBeNull();
    expect(screen.getByText(en["altHelpPages.savedNone"])).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en["altHelpPages.card"] }));
    expect(handlers.onProfile).toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: en["altHelpPages.signOut"] })[0]);
    expect(handlers.onSignOut).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: en["altHelpPages.casesOpen"] }));
    expect(handlers.onNavigate).toHaveBeenCalledWith("cases", "/m/cases");
    fireEvent.click(screen.getByRole("button", { name: en["altHelpPages.ballotsOpen"] }));
    expect(handlers.onNavigate).toHaveBeenCalledWith("voting", "/m/voting");
    fireEvent.click(screen.getByRole("button", { name: en["altHelpPages.savedBrowse"] }));
    expect(handlers.onNavigate).toHaveBeenCalledWith("memberSupport", "/m/support");
    // Every topic defaults on; the text channel is consented.
    expect(await screen.findByText(`${NOTIFICATION_TOPIC_KEYS.length} of ${NOTIFICATION_TOPIC_KEYS.length} kinds on · by text`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en["altHelpPages.alertsEdit"] }));
    expect(handlers.onNavigate).toHaveBeenCalledWith("settings", "/m/settings/notifications");
    // Without page routing every classic block is folded into the panels,
    // the security ones included.
    expect(screen.getByRole("heading", { level: 2, name: "Security" })).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Account" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Sign out" })[1]);
    expect(handlers.onSignOut).toHaveBeenCalledTimes(2);
  });

  it("keeps every folded block working: steward contact, sessions, calendar copy and the steward link", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const stewardContactApi = { load: vi.fn().mockResolvedValue({ shareEmail: false, contactEmail: "", sharePhone: false, contactPhone: "" }), save: vi.fn() };
    const profileDetailsApi = { load: vi.fn().mockRejectedValue(new Error("offline")), save: vi.fn() };
    const handlers = showSettings({ data: settingsData({ roles: ["steward"] }), stewardContactApi, profileDetailsApi, sessionDemo: true });
    fireEvent.click(screen.getByRole("button", { name: "Message a committee member" }));
    expect(handlers.onNavigate).toHaveBeenCalledWith("messages", "/m/messages");
    expect(await screen.findByText("Your details could not be loaded. Reload the page to try again.")).toBeInTheDocument();
    fireEvent.click(await screen.findByLabelText("Show my phone number to workers"));
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "+15085550123" } });
    expect(screen.getByLabelText("Phone number")).toHaveValue("+15085550123");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Get calendar link" })); });
    const link = await screen.findByDisplayValue(/token=abc$/);
    fireEvent.focus(link);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy" })); });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringMatching(/token=abc$/));
    fireEvent.click(screen.getByRole("button", { name: "Sign out everywhere" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out everywhere" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm sign out everywhere" })); });
    expect(screen.getByText("All preview devices were removed. No real session changed.")).toBeInTheDocument();
  });

  it("keeps the learning editor under the Account crumb trail", () => {
    const client = { rpc: vi.fn(async () => ({ data: null, error: { code: "PGRST202", message: "none" } })) };
    const onLearningSection = vi.fn();
    render(
      <LanguageProvider lang="en">
        <SettingsView alt onOpenHome={vi.fn()} data={settingsData()} lang="en" onLanguage={vi.fn()} learningContent={{ client, session: { user: { id: "user-1" } }, organizationId: "org-1", chapterId: "chapter-1", locale: "en" }} learningSection="manage" onLearningSection={onLearningSection} />
      </LanguageProvider>,
    );
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    fireEvent.click(within(crumbs).getByRole("link", { name: en["altHelpPages.account"] }));
    expect(onLearningSection).toHaveBeenCalledWith("library");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("offers no hop the shell would refuse", () => {
    showSettings({ data: settingsData({ events: [], member: { initials: "TM" } }), canNavigateView: () => false });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Hi, TM");
    expect(screen.queryByRole("button", { name: en["altHelpPages.casesOpen"] })).toBeNull();
    expect(screen.queryByRole("button", { name: en["altHelpPages.ballotsOpen"] })).toBeNull();
    expect(screen.queryByRole("button", { name: en["altHelpPages.rsvpsFind"] })).toBeNull();
    expect(screen.queryByRole("button", { name: en["altHelpPages.savedBrowse"] })).toBeNull();
  });

  it("shows honest empty figures and no RSVPs", () => {
    showSettings({ data: settingsData({ rewards: undefined, events: [], member: { initials: "TM", fullName: "Test Member" } }), onNotificationPrefs: undefined });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Hi, Test");
    const figures = screen.getByRole("region", { name: en["altHelpPages.kpisLabel"] });
    expect(within(figures).getByRole("img", { name: en["altHelpPages.kpiNoPoints"] })).toBeInTheDocument();
    expect(screen.getByText(en["altHelpPages.rsvpsNone"])).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en["altHelpPages.alertsSetUp"] })).toBeInTheDocument();
  });

  it("marks the top tier", () => {
    showSettings({ data: settingsData({ rewards: { totalPoints: 900, tierNumber: 5, tierName: "Top", nextTierName: null, pointsToGo: null, isMaxTier: true, weekStreak: 0, actionsYtd: 12 } }) });
    expect(screen.getByRole("img", { name: en["altHelpPages.kpiRingTop"] })).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("routes the overview page: directory, site view and account rows only", () => {
    showSettings({ path: "/m/settings" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Hi, Test");
    expect(screen.getByRole("heading", { level: 2, name: en["altHelpPages.settingsTitle"] })).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Account" })).toBeInTheDocument();
  });

  it("draws a settings sub-page with its crumbs and its own controls", async () => {
    const handlers = showSettings({ path: "/m/settings/security" });
    expect(screen.getByRole("heading", { level: 1, name: "Security" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: en["altHelpPages.kpisLabel"] })).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: en["altHelpPages.account"] }));
    expect(handlers.onNavigate).toHaveBeenCalledWith("settings", "/m/settings");
    fireEvent.click(screen.getByRole("button", { name: en["altHelpPages.card"] }));
    expect(handlers.onProfile).toHaveBeenCalled();
  });

  it("keeps the classic hub when alt is off", () => {
    showSettings({ alt: false });
    expect(document.querySelector(".morehub-title")).not.toBeNull();
    expect(screen.queryByRole("region", { name: en["altHelpPages.kpisLabel"] })).toBeNull();
  });

  it("speaks Spanish", () => {
    showSettings({ lang: "es" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Hola, Test");
    expect(screen.getByText(es["altHelpPages.savedNone"])).toBeInTheDocument();
  });
});

describe("the alternate shell's Alerts page", () => {
  it("draws chapters, what to send, how and the preview on the live switches", async () => {
    const handlers = showSettings({ path: "/m/settings/notifications" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Never miss a vote");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("North Chapter")).toBeInTheDocument();
    expect(screen.getByText(en["altHelpPages.alertsChaptersNote"])).toBeInTheDocument();
    const what = screen.getByRole("heading", { level: 2, name: en["altHelpPages.alertsWhat"] }).parentElement;
    const switches = within(what).getAllByRole("switch");
    expect(switches.length).toBeGreaterThan(NOTIFICATION_TOPIC_KEYS.length);
    switches.forEach((item) => expect(item).toHaveAttribute("aria-checked", "true"));
    await act(async () => { fireEvent.click(switches[0]); });
    expect(handlers.onNotificationPrefs).toHaveBeenCalledWith(expect.objectContaining({ [NOTIFICATION_TOPIC_KEYS[0]]: false }));

    const how = screen.getByRole("heading", { level: 2, name: en["altHelpPages.alertsHow"] }).parentElement;
    await act(async () => { fireEvent.click(within(how).getByRole("switch", { name: "Push notifications" })); });
    expect(handlers.onPushSubscribe).toHaveBeenCalled();
    await act(async () => { fireEvent.click(within(how).getByRole("switch", { name: "Do not disturb" })); });
    expect(handlers.onFocusSettings).toHaveBeenCalledWith({ dndEnabled: true });
    expect(within(how).getByText(en["altHelpPages.alertsEmailBody"])).toBeInTheDocument();
    fireEvent.click(within(how).getByRole("button", { name: /Add shortcut to home screen/ }));
    expect(handlers.onAddShortcut).toHaveBeenCalled();
    fireEvent.click(await within(how).findByRole("button", { name: "Get calendar link" }));
    expect(handlers.onCalendarRotate).toHaveBeenCalled();
    expect(await within(how).findByDisplayValue(/\/api\/calendar\?token=abc$/)).toBeInTheDocument();
    expect(await within(how).findByRole("button", { name: "Turn off" })).toBeInTheDocument();

    const preview = screen.getByRole("complementary", { name: en["altHelpPages.previewTitle"] });
    await waitFor(() => expect(within(preview).getByText(/Arrives by text\./)).toBeInTheDocument());
    expect(within(preview).getAllByText("Union Ground")).toHaveLength(3);
    expect(within(preview).getByText(/and \d+ more kinds/)).toBeInTheDocument();
  });

  it("refreshes push, turns texts off and previews both channels", async () => {
    const client = authClient();
    const handlers = showSettings({ path: "/m/settings/notifications", push: { supported: true, denied: false, subscribed: true }, client });
    const preview = screen.getByRole("complementary", { name: en["altHelpPages.previewTitle"] });
    await waitFor(() => expect(within(preview).getByText(/Arrives by browser and text\./)).toBeInTheDocument());
    expect(within(preview).getByText(en["altHelpPages.previewQuiet"], { exact: false })).toBeInTheDocument();
    const how = screen.getByRole("heading", { level: 2, name: en["altHelpPages.alertsHow"] }).parentElement;
    await act(async () => { fireEvent.click(within(how).getByRole("button", { name: "Refresh push registration" })); });
    expect(handlers.onPushRefresh).toHaveBeenCalled();
    await act(async () => { fireEvent.click(within(how).getByRole("switch", { name: "Push notifications" })); });
    expect(handlers.onPushUnsubscribe).toHaveBeenCalled();
    await act(async () => { fireEvent.click(within(how).getByRole("button", { name: "Turn off" })); });
    expect(client.rpc).toHaveBeenCalledWith("set_my_sms_consent", { p_phone_e164: null, p_consented: false });
  });

  it("previews nothing when every kind is off and names the missing channel", () => {
    const prefs = Object.fromEntries([...NOTIFICATION_TOPIC_KEYS, "announcements", "surveys", "welcome"].map((key) => [key, false]));
    const data = settingsData();
    data.member = { ...data.member, notificationPrefs: prefs, chapterMemberships: [], chapterName: "" };
    showSettings({ path: "/m/settings/notifications", data });
    const preview = screen.getByRole("complementary", { name: en["altHelpPages.previewTitle"] });
    expect(within(preview).getByText(en["altHelpPages.previewNone"])).toBeInTheDocument();
    expect(screen.getByText(en["altHelpPages.alertsNoChapter"])).toBeInTheDocument();
  });

  it("states unavailable channels and topics honestly", () => {
    window.history.replaceState({}, "", "/m/settings/notifications");
    render(
      <LanguageProvider lang="en">
        <WorkspacePages view="settings" hat="member" location={window.location.href} navigate={vi.fn()}>
          <SettingsView alt data={settingsData()} lang="en" push={{ supported: false, denied: true }} onLanguage={vi.fn()} onFocusSettings={vi.fn()} />
        </WorkspacePages>
      </LanguageProvider>,
    );
    expect(screen.getByText(en["altHelpPages.alertsWhatNone"])).toBeInTheDocument();
    expect(screen.getByText("Notifications are blocked for this site in your browser settings.")).toBeInTheDocument();
  });

  it("speaks Spanish", () => {
    showSettings({ lang: "es", path: "/m/settings/notifications" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("No te pierdas ninguna votación");
    expect(screen.getByRole("complementary", { name: es["altHelpPages.previewTitle"] })).toBeInTheDocument();
  });
});

describe("the alt help catalogue", () => {
  it("declares every key in both languages", () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      expect(key.startsWith("altHelpPages."), key).toBe(true);
      expect(en[key], key).toBeTruthy();
      expect(es[key], key).toBeTruthy();
    }
  });
});

// The alternate shell's Request keeps focus while the steward
// request is sent, and a second activation in the same tick sends nothing more.
describe("the alternate shell's steward request while it is sent", () => {
  const ready = async (onRequestSteward) => {
    showRights({ onRequestSteward });
    fireEvent.click(screen.getByRole("button", { name: "The contract, searchable" }));
    return screen.findByRole("button", { name: "Request" });
  };

  it("keeps Request focused while the request is sent, and requests once", async () => {
    const onRequestSteward = vi.fn(async () => undefined);
    await expectHeldWriteFocus(onRequestSteward, await ready(onRequestSteward));
    expect(onRequestSteward).toHaveBeenCalledTimes(1);
  });

  it("requests once when Request is activated twice in one tick", async () => {
    const onRequestSteward = vi.fn(async () => undefined);
    const request = await ready(onRequestSteward);
    await expectOneWriteFromOneTick(onRequestSteward, [() => fireEvent.click(request), () => fireEvent.click(request)]);
  });
});
