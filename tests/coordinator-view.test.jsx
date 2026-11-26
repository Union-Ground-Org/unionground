import { caseListOpenerName } from "./helpers/case-list-opener.js";
import { confirmEvidenceUpload } from "./helpers/confirm-evidence-upload.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoordinatorView } from "../src/views/CoordinatorView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { filterCoordinatorFocus, MemberApiError } from "../src/lib/memberApi.js";
import { clearDeviceParityState, deviceParityValue } from "../src/lib/deviceParity.js";
import { TAB_PAGE_GROUPS, workspacePageForLocation } from "../src/lib/workspacePages.js";
import { STAFF_ROLE_NAVIGATION } from "../src/lib/staffNavigation.js";

// The document panel receives bytes now, not a link, and mints its own object
// URL — jsdom implements neither side of that, so both are stubbed.
beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:coordinator-file");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  clearDeviceParityState();
});

// The queue starts with member plus reference; docket cards start with
// urgency and title, so the row prefix distinguishes the two surfaces.
const renataCaseName = caseListOpenerName(fallbackData.coordinatorDesk.cases[0]);

function renderCoordinator(lang = "en", overrides = {}) {
  const api = overrides.api || {
    loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.coordinatorDesk))),
    // Same shape the demo hat serves: the server focus predicates mirrored
    // over the seeded desk, no further pages.
    loadCases: vi.fn(async ({ focus = "all" } = {}) => ({
      cases: filterCoordinatorFocus(JSON.parse(JSON.stringify(fallbackData.coordinatorDesk)).cases, focus),
      nextCursor: null,
    })),
  };
  const { container } = render(
    <LanguageProvider lang={lang}>
      <CoordinatorView
        data={overrides.data || { member: { initials: "JP" } }}
        api={api}
        accessActor={overrides.accessActor}
        onNotice={overrides.onNotice}
        onOpenTasks={overrides.onOpenTasks}
        onProfile={overrides.onProfile}
      />
    </LanguageProvider>,
  );
  return { api, container };
}

// The demo desk no longer carries the removed casework fields. A live or
// cached desk from before the removal can, so the absence tests seed them back
// in to prove nothing is drawn from them.
function legacyDesk() {
  const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
  seed.kpis = {
    ...seed.kpis,
    inArbitration: 1,
    byStep: [{ step: "Committee review", count: 2 }, { step: "Organizer follow-up", count: 1 }],
    byArticle: [{ articles: "Supervisor interrogation", count: 2 }],
  };
  seed.cases = seed.cases.map((item, index) => ({ ...item, step: index === 0 ? "Organizer follow-up" : "Committee review", articles: index === 0 ? "Supervisor interrogation" : "" }));
  return seed;
}

describe("coordinator view", () => {
  it("labels a case without a deadline instead of inventing one", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    seed.cases = [{ ...seed.cases[0], deadline: null, deadlineLabel: null }];
    renderCoordinator("en", { api: { loadDesk: vi.fn().mockResolvedValue(seed) } });
    expect((await screen.findAllByText("No deadline")).length).toBeGreaterThan(0);
  });

  it("assigns and clears eligible steward/coordinator roles with confirmation and refresh", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    seed.cases[0].stewardUserId = "s1";
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      loadCases: vi.fn(),
      loadAssignmentCandidates: vi.fn().mockResolvedValue([
        { userId: "s1", fullName: "Sam Okafor", roles: ["steward"] },
        { userId: "c1", fullName: "Jordan Patel", roles: ["coordinator"] },
      ]),
      assignCase: vi.fn().mockResolvedValue(undefined),
    };
    const { container } = renderCoordinator("en", { api });
    await screen.findByRole("button", { name: renataCaseName });
    const queueRow = [...container.querySelectorAll(".gq-row__btn")].find((row) => row.textContent.includes("Renata Cole"));
    expect(queueRow).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(queueRow);
    expect(queueRow).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(api.loadAssignmentCandidates).toHaveBeenCalledWith("coord-case-1"));
    expect(await screen.findByRole("heading", { name: "Issue assignment" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Assigned committee member"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Assigned campaign lead"), { target: { value: "c1" } });
    fireEvent.click(screen.getByLabelText(/I confirm/));
    fireEvent.click(screen.getByRole("button", { name: "Save assignment" }));
    await waitFor(() => expect(api.assignCase).toHaveBeenCalledWith("coord-case-1", { stewardId: null, coordinatorId: "c1" }));
    await waitFor(() => expect(api.loadDesk).toHaveBeenCalledTimes(2));
  });

  it("shows a load error with a retry that recovers the assignment candidates", async () => {
    const api = {
      loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.coordinatorDesk))),
      loadCases: vi.fn(),
      loadChapterAppointments: vi.fn().mockResolvedValue({ rows: [], nextCursor: null, total: 0 }),
      loadAssignmentCandidates: vi.fn()
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValueOnce([{ userId: "s1", fullName: "Sam Okafor", roles: ["steward"] }]),
      assignCase: vi.fn(),
    };
    renderCoordinator("en", { api });
    fireEvent.click(await screen.findByRole("button", { name: renataCaseName }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Eligible assignees couldn't be loaded.");
    expect(screen.queryByRole("heading", { name: "Issue assignment" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Issue assignment" })).toBeInTheDocument();
    expect(screen.getByLabelText("Assigned committee member")).toBeInTheDocument();
    expect(api.loadAssignmentCandidates).toHaveBeenCalledTimes(2);
  });

  it("surfaces a save error and leaves the form usable when assignCase rejects", async () => {
    const api = {
      loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.coordinatorDesk))),
      loadCases: vi.fn(),
      loadChapterAppointments: vi.fn().mockResolvedValue({ rows: [], nextCursor: null, total: 0 }),
      loadAssignmentCandidates: vi.fn().mockResolvedValue([
        { userId: "s1", fullName: "Sam Okafor", roles: ["steward"] },
      ]),
      assignCase: vi.fn().mockRejectedValue(new Error("write failed")),
    };
    renderCoordinator("en", { api });
    fireEvent.click(await screen.findByRole("button", { name: renataCaseName }));
    expect(await screen.findByRole("heading", { name: "Issue assignment" })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/I confirm/));
    fireEvent.click(screen.getByRole("button", { name: "Save assignment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The assignment couldn't be saved. Nothing was changed.");
    expect(screen.getByRole("button", { name: "Save assignment" })).not.toBeDisabled();
    expect(api.loadDesk).toHaveBeenCalledTimes(1);
  });

  it("renders live KPIs and the active case queue from the desk load", async () => {
    const seed = legacyDesk();
    const { container } = renderCoordinator("en", { api: { loadDesk: vi.fn().mockResolvedValue(seed), loadCases: vi.fn().mockResolvedValue({ cases: seed.cases, nextCursor: null }) } });
    expect(await screen.findByText("Open issues in your queue")).toBeInTheDocument();
    expect(screen.getByText("Resolution rate")).toBeInTheDocument();
    // 5 seeded cases, 4 active — the resolved one never renders in the queue.
    expect(screen.getByText("Renata Cole")).toBeInTheDocument();
    expect(screen.getByText("ISS-2418")).toBeInTheDocument();
    expect(screen.queryByText("Sam Okafor")).not.toBeInTheDocument();
    // The overdue case is flagged.
    expect(within(screen.getByRole("region", { name: "Upcoming deadlines" })).getAllByText("Overdue").length).toBeGreaterThan(0);
    // Union Ground has no contract articles, no grievance steps and no
    // arbitration (owner decision, 2026-10-13): a desk that still carries
    // byArticle, byStep and inArbitration draws no "by article cited" panel, no
    // escalation funnel, no arbitration KPI and no arbitration header line.
    expect(container.querySelector("#coordinator-articles")).toBeNull();
    expect(container.querySelector("#coordinator-funnel")).toBeNull();
    expect(screen.queryByText("Supervisor interrogation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /arbitration/i })).not.toBeInTheDocument();
    expect(container.querySelector(".phead").textContent).not.toMatch(/arbitration/i);
    // Wave 2e anatomy: the prototype's Case queue table card, one row per
    // active case, the KPI rail, and the right-hand due-soon card.
    expect(container.querySelector(".gq-cases")).not.toBeNull();
    expect(container.querySelectorAll(".gq-row__btn")).toHaveLength(4);
    expect([...container.querySelectorAll(".pkpi .pkpi__label")].map((label) => label.textContent)).toEqual(["Open issues in your queue", "Due this week", "Resolution rate"]);
    expect(screen.getByRole("region", { name: "Today's docket" })).toBeInTheDocument();
    expect(container.querySelectorAll(".gq-docket__case")).toHaveLength(3);
    expect(container.querySelector(".gq-card--due")).not.toBeNull();
    // The strip declares its toolbar so the phone wrap is class-scoped — the
    // :has() it replaces never matches on the Safari 14 build floor.
    expect(container.querySelector(".phead.phead--toolbar")).not.toBeNull();
  });

  it("ranks the backed daily docket and opens its chosen case in the queue", async () => {
    const { container } = renderCoordinator();
    const docket = await screen.findByRole("region", { name: "Today's docket" });
    const priorities = within(docket).getAllByRole("button");
    expect(priorities).toHaveLength(3);
    expect(priorities[0]).toHaveTextContent("Devon Reyes");
    // WCAG 2.5.3 Label in Name: the card's visible text is its name,
    // so voice control can say what it sees.
    expect(priorities[0]).not.toHaveAttribute("aria-label");
    expect(priorities[0]).toHaveAccessibleName(expect.stringContaining("Devon Reyes"));
    expect(priorities[0]).toHaveAccessibleName(expect.stringContaining("ISS-2447"));
    fireEvent.click(priorities[0]);
    const queueRow = [...container.querySelectorAll(".gq-row__btn")].find((row) => row.textContent.includes("Devon Reyes"));
    expect(queueRow).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Issue facts")).toBeInTheDocument();
  });

  it("names the header avatar by its visible initials first (#7550, WCAG 2.5.3 Label in Name)", async () => {
    const onProfile = vi.fn();
    renderCoordinator("en", { onProfile });
    const avatar = await screen.findByRole("button", { name: "JP Profile" });
    expect(avatar).toHaveTextContent(/^JP$/);
    fireEvent.click(avatar);
    expect(onProfile).toHaveBeenCalledTimes(1);
  });

  // REQ-UG-CASEWORK-CONSOLE-54: the dashboards tab is a server capability, not
  // a rendering of the loaded queue, so a desk that cannot read the aggregates
  // must not advertise it — and must still answer a pasted URL honestly.
  it("offers the dashboards tab only to a desk that can read the aggregates", async () => {
    renderCoordinator();
    const viewNav = await screen.findByRole("navigation", { name: "Issue work views" });
    expect(within(viewNav).getAllByRole("button")).toHaveLength(3);
    expect(within(viewNav).queryByText("Dashboards")).toBeNull();
    // No procedure board tab: Union Ground issues have no grievance steps.
    expect(within(viewNav).queryByRole("button", { name: /^Board/ })).toBeNull();
  });

  it("mounts the lazy dashboards tab when the desk carries the aggregate read", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      loadCases: vi.fn().mockResolvedValue({ cases: seed.cases, nextCursor: null }),
      loadCaseDashboards: vi.fn().mockResolvedValue({ dueSoon: [], overdue: [], byAssignee: [] }),
    };
    renderCoordinator("en", { api });
    const viewNav = await screen.findByRole("navigation", { name: "Issue work views" });
    const tabs = within(viewNav).getAllByRole("button");
    expect(tabs).toHaveLength(4);
    expect(tabs.map((tab) => tab.textContent).some((text) => /Board/.test(text))).toBe(false);
    expect(tabs[3]).toHaveTextContent("Dashboards");
    // The count on the strip is the desk's own open-case KPI, not the length
    // of whatever page of cases happens to be loaded.
    expect(tabs[3]).toHaveTextContent(String(seed.kpis.openCases));
    fireEvent.click(tabs[3]);
    expect(await screen.findByRole("heading", { name: "Issue dashboards" })).toBeInTheDocument();
    expect(api.loadCaseDashboards).toHaveBeenCalledTimes(1);
  });

  it("renders the Casefile Control theme contract and indexed workflow", async () => {
    const { container } = renderCoordinator();
    const pageTitle = await screen.findByRole("heading", { level: 1 });
    expect(container.querySelector('[data-casework-theme="casefile-control"]')).not.toBeNull();
    // UB-UG-STAFF-DESK-TITLE-TREATMENT-PER-HAT-20261106 (option B):
    // the casework band keeps the shared serif page title with no eyebrow, as
    // on the steward desk; the section headers keep the system eyebrow.
    expect(pageTitle).toHaveClass("phead__title");
    expect(pageTitle.closest(".phead").querySelector(".phead__eyebrow")).toBeNull();
    expect([...container.querySelectorAll(".gq-view__index")].map((node) => node.textContent)).toEqual(["01", "02", "03"]);

    const viewNav = screen.getByRole("navigation", { name: "Issue work views" });
    fireEvent.click(within(viewNav).getAllByRole("button")[1]);
    const heading = await screen.findByRole("heading", { name: "Practical timeline" });
    expect(screen.queryByRole("heading", { name: "Issue board" })).not.toBeInTheDocument();
    const systemHeader = heading.closest(".casework-section-head");
    expect(systemHeader).not.toBeNull();
    expect(systemHeader.querySelector(".casework-section-head__key")).toHaveTextContent("02");
    expect(systemHeader).toHaveTextContent("Casefile control");
  });

  it("keeps the band's ink but not its own title type, so the title is the shared 28 px serif", () => {
    const css = readFileSync(resolve(process.cwd(), "src/coordinator-theme.css"), "utf8");
    const titleRules = [...css.matchAll(/\.gq-screen \.phead__title\s*\{([^}]*)\}/g)].map((match) => match[1]);
    expect(titleRules.length).toBeGreaterThan(0);
    for (const body of titleRules) expect(body).not.toMatch(/font-(family|size)|letter-spacing|line-height/);
    const subRules = [...css.matchAll(/\.gq-screen \.phead__sub\s*\{([^}]*)\}/g)].map((match) => match[1]);
    for (const body of subRules) expect(body).not.toMatch(/font-family/);
  });

  it("shows an em-dash, not a fabricated 0%, when the resolution rate has no data", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    seed.kpis = {};
    renderCoordinator("en", { api: { loadDesk: vi.fn().mockResolvedValue(seed) } });
    expect(await screen.findByText("—")).toBeInTheDocument();
  });

  it("expands a case into facts and its real update timeline", async () => {
    const { container } = renderCoordinator("en", { api: { loadDesk: vi.fn().mockResolvedValue(legacyDesk()) } });
    const row = await screen.findByRole("button", { name: renataCaseName });
    expect(row).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".gq-detail")).not.toBeNull();
    expect(screen.getByText("Issue facts")).toBeInTheDocument();
    // The facts are member, reference, deadline and status. A row that still
    // carries articles and a step draws neither: Union Ground issues have
    // no "Articles cited" or "Step" fact.
    const facts = [...container.querySelectorAll(".gq-detail .gq-fact")].map((fact) => [fact.querySelector("span").textContent, fact.querySelector("strong").textContent]);
    expect(facts).toEqual([["Worker", "Renata Cole"], ["Reference", "ISS-2418"], ["Next deadline", "Jul 24"], ["Status", "Active"]]);
    expect(screen.queryByText("Supervisor interrogation")).not.toBeInTheDocument();
    expect(within(container.querySelector(".gq-detail")).queryByText("Organizer follow-up")).not.toBeInTheDocument();
    expect(screen.getByText(/Worker wrote down the questions/)).toBeInTheDocument();
    // Collapsing puts the detail panel away again.
    fireEvent.click(row);
    expect(container.querySelector(".gq-detail")).toBeNull();
  });

  it("records a scoped case view before revealing coordinator details", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    seed.cases[0].subjectUserId = "member-renata";
    const actor = { userId: "coordinator-jordan", selectedOrganizationId: "org-a", roles: ["coordinator"], membershipStatus: "active" };
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      recordAccess: vi.fn().mockResolvedValue({ ok: true }),
    };
    const { container } = renderCoordinator("en", { api, accessActor: actor });
    const row = await screen.findByRole("button", { name: renataCaseName });
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(api.recordAccess).toHaveBeenCalledWith(actor, {
      subjectUserId: "member-renata",
      action: "viewed_case",
      entityType: "case",
      entityId: seed.cases[0].id,
    }));
    await waitFor(() => expect(container.querySelector(".gq-detail")).not.toBeNull());
  });

  it("keeps coordinator details closed when access recording fails", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    seed.cases[0].subjectUserId = "member-renata";
    const onNotice = vi.fn();
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      recordAccess: vi.fn().mockResolvedValue({ ok: false }),
    };
    const { container } = renderCoordinator("en", {
      api,
      accessActor: { userId: "coordinator-jordan", selectedOrganizationId: "org-a", roles: ["coordinator"], membershipStatus: "active" },
      onNotice,
    });
    fireEvent.click(await screen.findByRole("button", { name: renataCaseName }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/access could not be logged/i)));
    expect(container.querySelector(".gq-detail")).toBeNull();
  });

  it("opens the coordinator's own case without an access write or a retry notice", async () => {
    // BUG-UG-COORDINATOR-OWN-CASE-CANNOT-OPEN-ON-DESK-20260920: the access
    // history refuses self-subject events permanently, so the desk must not
    // ask for it and then offer a retry that can never land.
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    seed.cases[0].subjectUserId = "coordinator-jordan";
    const onNotice = vi.fn();
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      recordAccess: vi.fn().mockResolvedValue({ ok: false }),
    };
    const { container } = renderCoordinator("en", {
      api,
      accessActor: { userId: "coordinator-jordan", selectedOrganizationId: "org-a", roles: ["coordinator"], membershipStatus: "active" },
      onNotice,
    });
    const row = await screen.findByRole("button", { name: renataCaseName });
    fireEvent.click(row);
    await waitFor(() => expect(container.querySelector(".gq-detail")).not.toBeNull());
    fireEvent.click(row);
    expect(container.querySelector(".gq-detail")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Timeline/ }));
    const timeline = await screen.findByRole("region", { name: "Practical timeline" });
    fireEvent.click(within(timeline).getAllByRole("button", { name: /ISS-2418/ })[0]);
    expect(await screen.findByText("Issue facts")).toBeInTheDocument();
    expect(api.recordAccess).not.toHaveBeenCalled();
    expect(onNotice).not.toHaveBeenCalledWith(expect.stringMatching(/access could not be logged/i));
  });

  it("records access before opening a case from the timeline view", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    seed.cases[0].subjectUserId = "member-renata";
    const actor = { userId: "coordinator-jordan", selectedOrganizationId: "org-a", roles: ["coordinator"], membershipStatus: "active" };
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      recordAccess: vi.fn().mockResolvedValue({ ok: true }),
    };
    renderCoordinator("en", { api, accessActor: actor });
    await screen.findByText("Renata Cole");
    fireEvent.click(screen.getByRole("button", { name: /^Timeline/ }));
    const timeline = await screen.findByRole("region", { name: "Practical timeline" });
    fireEvent.click(within(timeline).getAllByRole("button", { name: /ISS-2418/ })[0]);
    await waitFor(() => expect(api.recordAccess).toHaveBeenCalledWith(actor, expect.objectContaining({
      subjectUserId: "member-renata",
      action: "viewed_case",
      entityId: seed.cases[0].id,
    })));
    expect(await screen.findByText("Issue facts")).toBeInTheDocument();
  });

  it("renders a case's contact log and recorded outcome from real data", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    const item = seed.cases.find((entry) => entry.status === "active");
    item.contacts = [
      { id: "contact-1", type: "phone", direction: "outbound", summary: "Called HR representative", contactedAt: "2026-08-05T14:00:00Z" },
      { id: "contact-2", type: "email", direction: "inbound", summary: "Employer replied with proposal", contactedAt: "2026-08-06T09:30:00Z" },
    ];
    item.outcome = { kind: "settled", summary: "Grievance settled with back pay", recordedAt: "2026-08-07T12:00:00Z" };
    renderCoordinator("en", { api: { loadDesk: vi.fn().mockResolvedValue(seed) } });
    fireEvent.click(await screen.findByRole("button", { name: caseListOpenerName(item) }));

    expect(screen.getByText("Contact log")).toBeInTheDocument();
    expect(screen.getByText("Called HR representative")).toBeInTheDocument();
    expect(screen.getByText(/Phone · Outbound · 2026-08-05T14:00:00Z/)).toBeInTheDocument();
    expect(screen.getByText("Employer replied with proposal")).toBeInTheDocument();
    expect(screen.getByText(/Email · Inbound · 2026-08-06T09:30:00Z/)).toBeInTheDocument();

    expect(screen.getByText("Recorded outcome")).toBeInTheDocument();
    expect(screen.getByText("Grievance settled with back pay")).toBeInTheDocument();
    expect(screen.getByText("Settled · 2026-08-07T12:00:00Z")).toBeInTheDocument();
  });

  it("labels an unknown outcome kind with a generic translation, never the raw key", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    const item = seed.cases.find((entry) => entry.status === "active");
    item.title = "A".repeat(96);
    item.outcome = { kind: "dismissed", summary: "Closed without a recorded outcome", recordedAt: "2026-08-07T12:00:00Z" };
    const { container } = renderCoordinator("en", { api: { loadDesk: vi.fn().mockResolvedValue(seed) } });
    fireEvent.click(await screen.findByRole("button", { name: caseListOpenerName(item) }));
    expect(screen.getByText("Other · 2026-08-07T12:00:00Z")).toBeInTheDocument();
    expect(screen.queryByText(/coordinator\.outcomeDismissed/)).not.toBeInTheDocument();
    const row = [...container.querySelectorAll(".gq-row")].find((entry) => entry.textContent.includes(item.memberName));
    expect(row.querySelector(".gq-issue").textContent).toContain("A".repeat(96));
    const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(styles).toMatch(/\.gq-name \{[^}]*overflow-wrap: anywhere/);
    expect(styles).toMatch(/\.gq-issue \{[^}]*overflow-wrap: anywhere/);
  });

  it("keeps the case detail free of a contact log or outcome panel when the case carries neither", async () => {
    const { container } = renderCoordinator();
    fireEvent.click(await screen.findByRole("button", { name: renataCaseName }));
    expect(screen.queryByText("Contact log")).not.toBeInTheDocument();
    expect(screen.queryByText("Recorded outcome")).not.toBeInTheDocument();
    expect(container.querySelector(".gq-detail")).not.toBeNull();
  });

  it("gives an authorized coordinator document controls inside the case queue", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    seed.cases[0].files = [{ id: "file-1", filename: "grievance.pdf", sizeBytes: 2048 }];
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      loadCases: vi.fn().mockResolvedValue({ cases: seed.cases, nextCursor: null }),
      addCaseFile: vi.fn().mockResolvedValue({}),
      removeCaseFile: vi.fn().mockResolvedValue({}),
      openCaseFile: vi.fn().mockResolvedValue(new Blob(["%PDF"])),
    };
    const { container } = renderCoordinator("en", { api });
    const row = await screen.findByRole("button", { name: caseListOpenerName(seed.cases[0]) });
    fireEvent.click(row);
    const detail = container.querySelector(".gq-detail");
    expect(within(detail).getByText("grievance.pdf")).toBeInTheDocument();
    const upload = within(detail).getByLabelText("Add a document");
    const file = new File(["case note"], "case-note.txt", { type: "text/plain" });
    fireEvent.change(upload, { target: { files: [file] } });
    await confirmEvidenceUpload();
    await vi.waitFor(() => expect(api.addCaseFile).toHaveBeenCalledWith(seed.cases[0].id, file, { onPhase: expect.any(Function) }));
  });

  it("opens and removes a coordinator document, refetching the desk after each action", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    seed.cases[0].files = [{ id: "file-1", filename: "grievance.pdf", sizeBytes: 2048 }];
    let openerWhenRequested;
    const popup = { location: "", opener: window, close: vi.fn() };
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => popup);
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      loadCases: vi.fn().mockResolvedValue({ cases: seed.cases, nextCursor: null }),
      addCaseFile: vi.fn().mockResolvedValue({}),
      removeCaseFile: vi.fn().mockResolvedValue({}),
      openCaseFile: vi.fn().mockImplementation(() => {
        openerWhenRequested = popup.opener;
        return Promise.resolve(new Blob(["%PDF"]));
      }),
    };
    const { container } = renderCoordinator("en", { api });
    const row = await screen.findByRole("button", { name: caseListOpenerName(seed.cases[0]) });
    fireEvent.click(row);
    const detail = container.querySelector(".gq-detail");
    fireEvent.click(within(detail).getByRole("button", { name: /^Open(?:: |$)/ }));
    await vi.waitFor(() => expect(api.openCaseFile).toHaveBeenCalledWith(seed.cases[0].files[0]));
    expect(openSpy).toHaveBeenCalledWith("", "_blank");
    expect(openerWhenRequested).toBeNull();
    expect(popup.opener).toBeNull();
    expect(popup.location).toBe("blob:coordinator-file");
    // Every panel action reloads the desk so the file list reflects the server.
    await vi.waitFor(() => expect(api.loadDesk.mock.calls.length).toBeGreaterThan(1));
    const reloadsBeforeRemove = api.loadDesk.mock.calls.length;
    fireEvent.click(within(detail).getByRole("button", { name: /^Remove(?:: |$)/ }));
    await vi.waitFor(() => expect(api.removeCaseFile).toHaveBeenCalledWith(seed.cases[0].files[0]));
    // The remove itself must also refetch — a dropped post-remove reload would
    // leave the deleted row visible and clickable.
    await vi.waitFor(() => expect(api.loadDesk.mock.calls.length).toBeGreaterThan(reloadsBeforeRemove));
    openSpy.mockRestore();
  });

  it("surfaces a document action failure inline instead of throwing", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    seed.cases[0].files = [{ id: "file-1", filename: "grievance.pdf", sizeBytes: 2048 }];
    const popup = { location: "", opener: window, close: vi.fn() };
    vi.spyOn(window, "open").mockImplementation(() => popup);
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      loadCases: vi.fn().mockResolvedValue({ cases: seed.cases, nextCursor: null }),
      openCaseFile: vi.fn().mockRejectedValue(new Error("signed link expired")),
    };
    const { container } = renderCoordinator("en", { api });
    const row = await screen.findByRole("button", { name: caseListOpenerName(seed.cases[0]) });
    fireEvent.click(row);
    const detail = container.querySelector(".gq-detail");
    // No addCaseFile/removeCaseFile on this api: those controls are absent.
    expect(within(detail).queryByLabelText("Add a document")).not.toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: /^Remove(?:: |$)/ })).not.toBeInTheDocument();
    fireEvent.click(within(detail).getByRole("button", { name: /^Open(?:: |$)/ }));
    expect(await within(detail).findByRole("alert")).toHaveTextContent(catalogue.en["cases.fileFailed"]);
    expect(popup.close).toHaveBeenCalledTimes(1);
  });

  // A clean verdict expires by design — clean_until is least(now()+24h,
  // signatures+48h) — so "this opened yesterday and will not open today" is a
  // normal state, not a fault. The panel's job is to make the recovery one tap
  // and to be honest about which failures that tap can fix.
  it("offers one re-check for a stale document, keeps it through a transient failure, and retires it on a rejection", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    seed.cases[0].files = [{ id: "file-1", filename: "grievance.pdf", sizeBytes: 2048 }];
    const popup = { location: "", opener: window, close: vi.fn() };
    vi.spyOn(window, "open").mockImplementation(() => popup);
    const stale = Object.assign(new Error("storage refused"), { privateFileCode: "stale" });
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      loadCases: vi.fn().mockResolvedValue({ cases: seed.cases, nextCursor: null }),
      openCaseFile: vi.fn().mockRejectedValue(stale),
      recheckCaseFile: vi.fn()
        .mockRejectedValueOnce(new Error("scanner unreachable"))
        .mockRejectedValueOnce(Object.assign(new Error("blocked"), { privateFileCode: "rejected" })),
    };
    const { container } = renderCoordinator("en", { api });
    fireEvent.click(await screen.findByRole("button", { name: caseListOpenerName(seed.cases[0]) }));
    const detail = container.querySelector(".gq-detail");

    fireEvent.click(within(detail).getByRole("button", { name: /^Open(?:: |$)/ }));
    expect(await within(detail).findByRole("alert"))
      .toHaveTextContent("This file needs a fresh safety check before it can open.");
    expect(popup.close).toHaveBeenCalledTimes(1);
    const recheck = await within(detail).findByRole("button", { name: /^Re-check this file(?:: |$)/ });

    // A re-check that could not decide has decided nothing: the coordinator is
    // exactly where they were, so the button must survive its own failure.
    fireEvent.click(recheck);
    await waitFor(() => expect(api.recheckCaseFile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(detail).getByRole("alert"))
      .toHaveTextContent("The safety check did not finish. Try again in a moment."));
    // A pending control stays enabled (record 8435): wait for its busy state to clear.
    await waitFor(() => { const button = within(detail).getByRole("button", { name: /^Re-check this file(?:: |$)/ }); expect(button).toBeEnabled(); expect(button).not.toHaveAttribute("aria-disabled"); });

    // A rejection is a decision about these bytes and is permanent, so the
    // affordance goes away rather than inviting an endless retry loop.
    fireEvent.click(within(detail).getByRole("button", { name: /^Re-check this file(?:: |$)/ }));
    await waitFor(() => expect(api.recheckCaseFile).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(detail).getByRole("alert"))
      .toHaveTextContent("This file was rejected by the safety check and was not attached."));
    expect(within(detail).queryByRole("button", { name: /^Re-check this file(?:: |$)/ })).not.toBeInTheDocument();
  });

  it("recovers a stale coordinator document when the re-check succeeds", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    seed.cases[0].files = [{ id: "file-1", filename: "grievance.pdf", sizeBytes: 2048 }];
    const popup = { location: "", opener: window, close: vi.fn() };
    vi.spyOn(window, "open").mockImplementation(() => popup);
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      loadCases: vi.fn().mockResolvedValue({ cases: seed.cases, nextCursor: null }),
      openCaseFile: vi.fn().mockRejectedValue(Object.assign(new Error("storage refused"), { privateFileCode: "stale" })),
      recheckCaseFile: vi.fn().mockResolvedValue({ status: "clean" }),
    };
    const { container } = renderCoordinator("en", { api });
    fireEvent.click(await screen.findByRole("button", { name: caseListOpenerName(seed.cases[0]) }));
    const detail = container.querySelector(".gq-detail");
    fireEvent.click(within(detail).getByRole("button", { name: /^Open(?:: |$)/ }));
    const recheck = await within(detail).findByRole("button", { name: /^Re-check this file(?:: |$)/ });
    const reloadsBefore = api.loadDesk.mock.calls.length;

    fireEvent.click(recheck);
    // Exactly one inspection per tap: the quota is 20 an hour and a double
    // request would spend two of them for one decision.
    await waitFor(() => expect(api.recheckCaseFile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(detail).queryByRole("button", { name: /^Re-check this file(?:: |$)/ })).not.toBeInTheDocument());
    expect(within(detail).queryByRole("alert")).not.toBeInTheDocument();
    // The desk is refetched so the row reflects the renewed verdict.
    await waitFor(() => expect(api.loadDesk.mock.calls.length).toBeGreaterThan(reloadsBefore));
  });

  it("renders no document panel at all when the coordinator API carries no file capability", async () => {
    const { container } = renderCoordinator();
    const row = await screen.findByRole("button", { name: renataCaseName });
    fireEvent.click(row);
    const detail = container.querySelector(".gq-detail");
    expect(within(detail).queryByText("Documents")).not.toBeInTheDocument();
  });

  it("turns every KPI into a backed, keyboard-operable breakdown", async () => {
    renderCoordinator();
    const open = await screen.findByRole("button", { name: /Open issues/ });
    expect(open).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(open);
    expect(open).toHaveAttribute("aria-expanded", "true");
    const breakdown = screen.getByRole("region", { name: "Open-issue breakdown" });
    expect(breakdown).toBeInTheDocument();
    expect(await within(breakdown).findByRole("button", { name: /Renata Cole/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close breakdown" }));
    expect(screen.queryByRole("region", { name: "Open-issue breakdown" })).not.toBeInTheDocument();
  });

  // Union Ground issues have no grievance procedure (owner decision,
  // 2026-10-13): there is no Board tab, no /m/coordinator/cases/board route,
  // no procedure settings page and no funnel or by-article destination, and
  // no control on the desk can advance a step.
  it("offers no procedure board, step move, procedure settings or removed panel destinations", async () => {
    const advanceCaseStep = vi.fn().mockResolvedValue({ id: "transition-1" });
    const { api, container } = renderCoordinator();
    api.advanceCaseStep = advanceCaseStep;
    const viewNav = await screen.findByRole("navigation", { name: "Issue work views" });
    expect(within(viewNav).getAllByRole("button").map((tab) => tab.textContent.replace(/\d+/g, "").trim())).toEqual(["Action queue", "Timeline", "Outreach"]);
    expect(within(viewNav).queryByRole("button", { name: /^Board/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Move / })).not.toBeInTheDocument();
    expect(container.querySelector(".case-board-card")).toBeNull();
    for (const tab of within(viewNav).getAllByRole("button")) {
      fireEvent.click(tab);
      expect(screen.queryByRole("heading", { name: "Issue board" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Move / })).not.toBeInTheDocument();
    }
    expect(advanceCaseStep).not.toHaveBeenCalled();

    expect(TAB_PAGE_GROUPS.coordinator.tabs).toEqual(["queue", "timeline", "outreach", "dashboards"]);
    for (const path of ["/m/coordinator/cases/board", "/m/coordinator/settings", "/m/coordinator/funnel", "/m/coordinator/articles"]) {
      expect(workspacePageForLocation(path)).toBeNull();
    }
    const coordinatorKeys = STAFF_ROLE_NAVIGATION.coordinator.map((item) => item.key);
    expect(coordinatorKeys).not.toContain("coordinator-settings");
    expect(coordinatorKeys).not.toContain("coordinator-funnel");
    expect(coordinatorKeys).not.toContain("coordinator-articles");
    expect(coordinatorKeys).toContain("coordinator-macros");
  });

  it("switches among the real-data practical timeline and outreach views", async () => {
    renderCoordinator();
    await screen.findByRole("button", { name: /^Action queue/ });
    expect(screen.queryByRole("button", { name: /^Board/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Timeline/ }));
    const timeline = screen.getByRole("region", { name: "Practical timeline" });
    expect(timeline).toBeInTheDocument();
    expect(within(timeline).getByText(/Deadline: Supervisor interrogation after a huddle/)).toBeInTheDocument();
    expect(within(timeline).getByText(/Worker wrote down the questions/)).toBeInTheDocument();
    fireEvent.click(within(timeline).getAllByRole("button", { name: /ISS-2418/ })[0]);
    expect(screen.getByText("Issue facts")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Outreach/ }));
    expect(screen.getByRole("heading", { name: "Outreach this week" })).toBeInTheDocument();
    expect(screen.getByText("Guidance — not recorded contact activity")).toBeInTheDocument();
    expect(screen.getByText("No issue update logged")).toBeInTheDocument();
  });

  it("labels the deadline list as navigation into the real case, not a dead summary", async () => {
    renderCoordinator();
    const deadline = await screen.findByRole("button", { name: /Open overdue deadline for ISS-2418/i });
    fireEvent.click(deadline);
    expect(screen.getByRole("button", { name: renataCaseName })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Issue facts")).toBeInTheDocument();
  });

  // REQ-UG-STEWARD-CASE-STEP-DEADLINE-AND-TITLE-CONTROLS-20261006:
  // the card lists every saved clock on the loaded open cases, each named by
  // its source, not only the case deadline under the member's own paragraph.
  function clockApi(listOpenCaseDeadlines) {
    const desk = () => JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    return {
      loadDesk: vi.fn().mockResolvedValue(desk()),
      loadCases: vi.fn(async ({ focus = "all" } = {}) => ({ cases: filterCoordinatorFocus(desk().cases, focus), nextCursor: null })),
      listOpenCaseDeadlines,
    };
  }

  it("lists procedural clocks beside case deadlines, each named by its source", async () => {
    const listOpenCaseDeadlines = vi.fn().mockResolvedValue([
      { id: "clock-1", caseId: "coord-case-2", kind: "response", label: "County answer due", dueAt: "2026-07-25T16:00:00Z", status: "active" },
      { id: "clock-2", caseId: "coord-case-3", kind: "follow_up", label: "", dueAt: "2026-07-26", status: "extended" },
      { id: "clock-3", caseId: "not-on-this-desk", kind: "filing", label: "Elsewhere", dueAt: "2026-07-20", status: "active" },
      // A stored legacy kind reads as a plain deadline, never as its raw token
      // or a hearing/step name Union Ground does not offer.
      { id: "clock-4", caseId: "coord-case-1", kind: "hearing", label: "Old session", dueAt: "2026-07-27", status: "active" },
    ]);
    renderCoordinator("en", { api: clockApi(listOpenCaseDeadlines) });
    const card = await screen.findByRole("region", { name: "Upcoming deadlines" });
    expect(await within(card).findByText("Response · County answer due")).toBeInTheDocument();
    expect(within(card).getByText("Follow-up")).toBeInTheDocument();
    // No grievance procedure, so no clock is ever named a step deadline.
    expect(within(card).queryByText("Step deadline")).not.toBeInTheDocument();
    expect(within(card).getByText("Deadline · Old session")).toBeInTheDocument();
    expect(within(card).queryByText(/Hearing/)).not.toBeInTheDocument();
    expect(within(card).getAllByText("Issue deadline").length).toBeGreaterThan(0);
    expect(within(card).queryByText(/Elsewhere/)).not.toBeInTheDocument();
    const activeIds = fallbackData.coordinatorDesk.cases.filter((item) => item.status === "active").map((item) => item.id).sort();
    expect(listOpenCaseDeadlines).toHaveBeenCalledWith(activeIds);
    expect(within(card).queryByText("Supervisor interrogation after a huddle")).not.toBeInTheDocument();
    // Clocks first, case dates second (#9165), whatever their dates.
    const clocksGroup = within(card).getByRole("group", { name: "Procedural clocks" });
    const datesGroup = within(card).getByRole("group", { name: "Issue dates" });
    expect(within(clocksGroup).getByRole("button", { name: /County answer due/ })).toBeInTheDocument();
    expect(within(datesGroup).getByRole("button", { name: /ISS-2418: Issue deadline/ })).toBeInTheDocument();
    expect(clocksGroup.compareDocumentPosition(datesGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // UX-UG-COORDINATOR-UPCOMING-DEADLINES-SPLIT-CLOCKS-FROM-CASE-DATES-20261118
  // (#9165): only a clock can be extended, so the card splits the two kinds,
  // and a case date gives up its slot to a same-day clock of the same case
  // only while that clock is shown.
  describe("clocks and case dates (#9165)", () => {
    const day = (offset) => { const date = new Date(); date.setDate(date.getDate() + offset); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
    const at = (offset, hour) => { const date = new Date(); date.setDate(date.getDate() + offset); date.setHours(hour, 0, 0, 0); return date.toISOString(); };
    function deskApi(deadlines, clockRows) {
      const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
      const template = seed.cases[0];
      seed.cases = deadlines.map((deadline, index) => ({ ...JSON.parse(JSON.stringify(template)), id: `dc-${index}`, reference: `G-8${String(index).padStart(3, "0")}`, memberName: `Dated Member ${index}`, status: "active", deadline, deadlineValue: deadline, deadlineLabel: deadline }));
      return {
        loadDesk: vi.fn(async () => JSON.parse(JSON.stringify(seed))),
        loadCases: vi.fn(async () => ({ cases: JSON.parse(JSON.stringify(seed)).cases, nextCursor: null })),
        listOpenCaseDeadlines: vi.fn().mockResolvedValue(clockRows),
      };
    }

    const mixedDeadlines = () => deskApi([day(-1), day(2), day(-2), day(3)], [
      { id: "c-next", caseId: "dc-1", kind: "hearing", label: "Clock A", dueAt: at(1, 10), status: "active" },
      { id: "c-missed", caseId: "dc-3", kind: "filing", label: "Clock B", dueAt: at(4, 10), status: "missed" },
    ]);


    it.each([["en", "Overdue"], ["es", "Vencido"]])(
      "shows the overdue status in visible row text in %s",
      async (lang, status) => {
        renderCoordinator(lang, { api: mixedDeadlines() });
        const card = await screen.findByRole("region", { name: catalogue[lang]["coordinator.deadlinesTitle"] });
        await within(card).findByRole("button", { name: /G-8003:.*Clock B/ });
        const rows = within(card).getAllByRole("button");
        expect(rows.filter((row) => within(row).queryByText(status))).toHaveLength(3);
        for (const row of rows) {
          if (row.getAttribute("aria-label").includes(status)) expect(within(row).getByText(status)).toBeVisible();
          else expect(within(row).queryByText(status)).not.toBeInTheDocument();
        }
      },
    );

    it.each([
      ["en", "No deadlines to show."],
      ["es", "No hay plazos para mostrar."],
    ])("explains that there are no deadlines to show when the queue still has an open case in %s", async (lang, empty) => {
      renderCoordinator(lang, { api: deskApi([null], []) });
      const card = await screen.findByRole("region", { name: catalogue[lang]["coordinator.deadlinesTitle"] });
      const queue = screen.getByRole("region", { name: catalogue[lang]["coordinator.actionTitle"] });
      expect(within(queue).getByRole("button", { name: /Dated Member 0.*G-8000/ })).toBeVisible();
      expect(within(card).getByText(empty)).toBeVisible();
      expect(within(card).queryByText(catalogue[lang]["coordinator.empty"])).not.toBeInTheDocument();
    });



    it("never hides a case date when the clocks did not load, and names the groups in Spanish", async () => {
      renderCoordinator("es", { api: deskApi([day(2), day(3)], []) });
      const card = await screen.findByRole("region", { name: catalogue.es["coordinator.deadlinesTitle"] });
      const datesGroup = await within(card).findByRole("group", { name: catalogue.es["coordinator.groupCaseDates"] });
      expect(within(datesGroup).getAllByRole("button")).toHaveLength(2);
      expect(within(card).queryByRole("group", { name: catalogue.es["coordinator.groupClocks"] })).not.toBeInTheDocument();
      cleanup();
      const api = deskApi([day(2)], [{ id: "c-same", caseId: "dc-0", kind: "filing", label: "Presentar", dueAt: at(2, 10), status: "active" }]);
      api.listOpenCaseDeadlines = vi.fn().mockRejectedValue(new Error("refused"));
      renderCoordinator("es", { api });
      const failed = await screen.findByRole("region", { name: catalogue.es["coordinator.deadlinesTitle"] });
      expect(await within(failed).findByText(catalogue.es["coordinator.clocksUnavailable"])).toBeInTheDocument();
      expect(within(failed).getByRole("button", { name: new RegExp(`G-8000: ${catalogue.es["coordinator.clockCase"]}`) })).toBeInTheDocument();
    });
  });

  it("sorts a timed clock due earlier on the same day ahead of that day's case deadline", async () => {
    const sameDay = new Date(2026, 6, 24, 15, 0, 0).toISOString();
    renderCoordinator("en", { api: clockApi(vi.fn().mockResolvedValue([
      { id: "clock-1", caseId: "coord-case-2", kind: "response", label: "County answer due", dueAt: sameDay, status: "active" },
    ])) });
    const card = await screen.findByRole("region", { name: "Upcoming deadlines" });
    await within(card).findByText("Response · County answer due");
    const rows = within(card).getAllByRole("button").map((button) => button.getAttribute("aria-label"));
    expect(rows.findIndex((label) => /County answer due/.test(label))).toBeLessThan(rows.findIndex((label) => /ISS-2418: Issue deadline/.test(label)));
  });

  it("keeps upcoming clocks on the card when older missed clocks pile up", async () => {
    const missed = Array.from({ length: 12 }, (_, index) => ({ id: `missed-${index}`, caseId: `coord-case-${(index % 4) + 1}`, kind: "procedure", label: `Old clock ${index}`, dueAt: `2026-06-${String(index + 1).padStart(2, "0")}T15:00:00Z`, status: "missed" }));
    const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    renderCoordinator("en", { api: clockApi(vi.fn().mockResolvedValue([...missed, { id: "next", caseId: "coord-case-2", kind: "response", label: "Management answer due", dueAt: future, status: "active" }])) });
    const card = await screen.findByRole("region", { name: "Upcoming deadlines" });
    expect(await within(card).findByText("Response · Management answer due")).toBeInTheDocument();
    expect(within(card).getAllByRole("button")).toHaveLength(10);
    // Overdue rows that remain are the most recent ones.
    expect(within(card).queryByText("Step deadline · Old clock 0")).not.toBeInTheDocument();
  });

  it("keeps a recently overdue case deadline and a clock missed yesterday ahead of ten far-future deadlines", async () => {
    const day = (offset) => { const date = new Date(); date.setDate(date.getDate() + offset); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    const template = seed.cases[0];
    const make = (index, deadline) => ({ ...JSON.parse(JSON.stringify(template)), id: `far-${index}`, reference: `G-7${String(index).padStart(3, "0")}`, memberName: `Far Member ${index}`, status: "active", deadline, deadlineValue: deadline, deadlineLabel: deadline });
    seed.cases = [
      ...Array.from({ length: 10 }, (_, index) => make(index, day(30 + index * 5))),
      { ...make(10, day(-1)), reference: "G-7900" },
      { ...make(11, ""), reference: "G-7901" },
    ];
    const yesterdayNoon = new Date(); yesterdayNoon.setDate(yesterdayNoon.getDate() - 1); yesterdayNoon.setHours(12, 0, 0, 0);
    const api = {
      loadDesk: vi.fn(async () => JSON.parse(JSON.stringify(seed))),
      loadCases: vi.fn(async () => ({ cases: JSON.parse(JSON.stringify(seed)).cases, nextCursor: null })),
      listOpenCaseDeadlines: vi.fn().mockResolvedValue([{ id: "missed-yesterday", caseId: "far-11", kind: "response", label: "Answer due", dueAt: yesterdayNoon.toISOString(), status: "missed" }]),
    };
    renderCoordinator("en", { api });
    const card = await screen.findByRole("region", { name: "Upcoming deadlines" });
    expect(await within(card).findByRole("button", { name: /G-7901: Response · Answer due/ })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /G-7900: Issue deadline/ })).toBeInTheDocument();
    expect(within(card).getAllByRole("button")).toHaveLength(10);
  });

  it("names a missed or passed clock overdue even when it is due today", async () => {
    const later = new Date(Date.now() + 60 * 1000).toISOString();
    renderCoordinator("en", { api: clockApi(vi.fn().mockResolvedValue([
      { id: "clock-missed", caseId: "coord-case-2", kind: "response", label: "Swept", dueAt: later, status: "missed" },
    ])) });
    expect(await screen.findByRole("button", { name: /Open Overdue deadline for ISS-2431: Response · Swept/i })).toBeInTheDocument();
  });

  it("distinguishes a failed clock read from an empty deadline list", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    for (const item of seed.cases) { item.deadline = ""; item.deadlineValue = ""; item.deadlineLabel = ""; }
    const api = { loadDesk: vi.fn(async () => JSON.parse(JSON.stringify(seed))), loadCases: vi.fn(async () => ({ cases: JSON.parse(JSON.stringify(seed)).cases, nextCursor: null })), listOpenCaseDeadlines: vi.fn().mockRejectedValue(new Error("refused")) };
    renderCoordinator("en", { api });
    const card = await screen.findByRole("region", { name: "Upcoming deadlines" });
    expect(await within(card).findByText(/Step and custom deadlines could not load/)).toBeInTheDocument();
    expect(within(card).queryByText("No deadlines to show.")).not.toBeInTheDocument();
  });

  it("reads the clocks again when a case write reloads the desk", async () => {
    const listOpenCaseDeadlines = vi.fn().mockResolvedValueOnce([])
      .mockResolvedValue([{ id: "clock-new", caseId: "coord-case-1", kind: "response", label: "County answer due", dueAt: "2026-07-23T16:00:00Z", status: "active" }]);
    const api = {
      ...clockApi(listOpenCaseDeadlines),
      // Each server read is a new object, as in production.
      loadDesk: vi.fn(async () => JSON.parse(JSON.stringify(fallbackData.coordinatorDesk))),
      loadAssignmentCandidates: vi.fn().mockResolvedValue([{ userId: "c1", fullName: "Jordan Patel", roles: ["coordinator"] }]),
      assignCase: vi.fn().mockResolvedValue(undefined),
    };
    const { container } = renderCoordinator("en", { api });
    await screen.findByRole("button", { name: renataCaseName });
    await waitFor(() => expect(listOpenCaseDeadlines).toHaveBeenCalledTimes(1));
    fireEvent.click([...container.querySelectorAll(".gq-row__btn")].find((row) => row.textContent.includes("Renata Cole")));
    expect(await screen.findByRole("heading", { name: "Issue assignment" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Assigned campaign lead"), { target: { value: "c1" } });
    fireEvent.click(screen.getByLabelText(/I confirm/));
    fireEvent.click(screen.getByRole("button", { name: "Save assignment" }));
    await waitFor(() => expect(api.loadDesk).toHaveBeenCalledTimes(2));
    const card = screen.getByRole("region", { name: "Upcoming deadlines" });
    expect(await within(card).findByText("Response · County answer due")).toBeInTheDocument();
    expect(listOpenCaseDeadlines).toHaveBeenCalledTimes(2);
  });

  it("opens the case a procedural clock belongs to", async () => {
    renderCoordinator("en", { api: clockApi(vi.fn().mockResolvedValue([
      { id: "clock-1", caseId: "coord-case-2", kind: "response", label: "Management answer due", dueAt: "2026-07-25T16:00:00Z", status: "active" },
    ])) });
    fireEvent.click(await screen.findByRole("button", { name: /ISS-2431: Response · Management answer due/ }));
    expect(screen.getByRole("button", { name: caseListOpenerName(fallbackData.coordinatorDesk.cases.find((item) => item.reference === "ISS-2431")) })).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps case deadlines and says so when procedural clocks cannot load", async () => {
    renderCoordinator("es", { api: clockApi(vi.fn().mockRejectedValue(new Error("refused"))) });
    expect(await screen.findByText(catalogue.es["coordinator.clocksUnavailable"])).toBeInTheDocument();
    expect(screen.getAllByText(catalogue.es["coordinator.clockCase"]).length).toBeGreaterThan(0);
  });

  it("filters the queue client-side and shows the filtered empty state", async () => {
    renderCoordinator();
    const input = await screen.findByRole("searchbox");
    fireEvent.change(input, { target: { value: "card talk" } });
    expect(screen.getByText("Priya Nair")).toBeInTheDocument();
    expect(screen.queryByText("Renata Cole")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "zzz-no-match" } });
    expect(screen.getByText("No issues match your filter.")).toBeInTheDocument();
  });

  it("pages the queue client-side instead of rendering hundreds of rows at once", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    const template = seed.cases[0];
    seed.cases = Array.from({ length: 35 }, (_, index) => ({
      ...JSON.parse(JSON.stringify(template)),
      id: `bulk-${index}`,
      reference: `G-9${String(index).padStart(3, "0")}`,
      memberName: `Case Member ${index}`,
    }));
    const { container } = renderCoordinator("en", { api: { loadDesk: vi.fn().mockResolvedValue(seed) } });
    await screen.findByText("Case Member 0");
    expect(container.querySelectorAll(".gq-row__btn")).toHaveLength(30);
    const more = container.querySelector(".gq-more");
    expect(more).not.toBeNull();
    fireEvent.click(more);
    expect(container.querySelectorAll(".gq-row__btn")).toHaveLength(35);
    expect(container.querySelector(".gq-more")).toBeNull();
  });

  it("opens the chapter-work tool from the plane header", async () => {
    const onOpenTasks = vi.fn();
    renderCoordinator("en", { onOpenTasks });
    fireEvent.click(await screen.findByRole("button", { name: /Campaign work/ }));
    expect(onOpenTasks).toHaveBeenCalledTimes(1);
  });

  it("renders fully in Spanish — no hardcoded English chrome remains", async () => {
    renderCoordinator("es", { api: { loadDesk: vi.fn().mockResolvedValue(legacyDesk()) } });
    expect(await screen.findByText("Cola de asuntos")).toBeInTheDocument();
    expect(screen.getByText("Asuntos abiertos en tu cola")).toBeInTheDocument();
    expect(screen.getByText("Agenda de hoy")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: catalogue.es["coordinator.deadlinesTitle"] })).getAllByText("Vencido").length).toBeGreaterThan(0);
    // The escalation funnel and the by-article panel are gone in every language.
    expect(screen.queryByText("Embudo de escalamiento")).not.toBeInTheDocument();
    expect(document.querySelector("#coordinator-funnel")).toBeNull();
    expect(document.querySelector("#coordinator-articles")).toBeNull();
  });

  it("classifies a date-only deadline falling today as due today, not overdue", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    seed.cases = [{ ...seed.cases[0], id: "today-1", reference: "G-8001", deadline: iso, deadlineLabel: "Today", updates: [] }];
    renderCoordinator("en", { api: { loadDesk: vi.fn().mockResolvedValue(seed) } });
    expect((await screen.findAllByText("Due today")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Deadline overdue")).not.toBeInTheDocument();
  });

  // REQ-UG-CONFIGURABLE-THRESHOLDS-20261001: deadline chip colours follow
  // the organization's red/amber thresholds (old defaults 5/14) and the queue
  // ranking follows its risk windows and lookahead (old defaults 0/7/14, 7).
  it("colours deadline chips with the organization's red and amber thresholds", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    const due = new Date();
    due.setDate(due.getDate() + 3);
    const iso = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`;
    seed.cases = [{ ...seed.cases[0], id: "soon-1", reference: "G-8002", deadline: iso, deadlineLabel: "In 3 days", updates: [] }];
    const chipTone = async (switches) => {
      const view = renderCoordinator("en", {
        api: { loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(seed))) },
        data: { member: { initials: "JP" }, organizationConfiguration: switches ? { switches } : null },
      });
      await screen.findAllByText("G-8002", { exact: false });
      const chip = await waitFor(() => {
        const node = view.container.querySelector(".gq-duechip");
        expect(node).not.toBeNull();
        return node;
      });
      const tone = [...chip.classList].find((name) => name.startsWith("gq-duechip--"));
      view.container.remove();
      return tone;
    };
    expect(await chipTone(null)).toBe("gq-duechip--danger");
    expect(await chipTone({ "limits.casework.deadline_red_days": 1, "limits.casework.deadline_amber_days": 4 })).toBe("gq-duechip--gold");
    expect(await chipTone({ "limits.casework.deadline_red_days": 0, "limits.casework.deadline_amber_days": 2 })).toBe("gq-duechip--quiet");
  });

  it("notes when a case detail shows only the recent slice of its history", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    seed.cases[0].totalUpdates = 12;
    renderCoordinator("en", { api: { loadDesk: vi.fn().mockResolvedValue(seed) } });
    fireEvent.click(await screen.findByRole("button", { name: renataCaseName }));
    expect(screen.getByText("Showing the 2 most recent updates of 12 logged.")).toBeInTheDocument();
    // A genuinely complete history carries no note.
    expect(screen.queryByText(/most recent updates of 2 logged/)).not.toBeInTheDocument();
  });

  it("fetches focus drilldowns from the server so contents match the chapter-wide counts", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    // A case beyond the loaded queue page: only the server-filtered drilldown
    // can know about it.
    const beyond = { ...JSON.parse(JSON.stringify(seed.cases[0])), id: "beyond-1", reference: "G-7777", memberName: "Farah Deep", memberInitials: "FD" };
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      loadCases: vi.fn(async () => ({ cases: [beyond], nextCursor: null })),
    };
    const { container } = renderCoordinator("en", { api });
    fireEvent.click(await screen.findByRole("button", { name: /Due this week/ }));
    const breakdown = screen.getByRole("region", { name: "Due-this-week breakdown" });
    const mini = await within(breakdown).findByRole("button", { name: /Farah Deep/ });
    expect(api.loadCases).toHaveBeenCalledWith({ focus: "due", limit: 30 });
    expect(api.loadCases).not.toHaveBeenCalledWith(expect.objectContaining({ focus: "arbitration" }));
    // Opening a case that lives beyond the loaded queue merges it in and
    // expands it — it must not vanish.
    fireEvent.click(mini);
    const row = [...container.querySelectorAll(".gq-row__btn")].find((btn) => btn.textContent.includes("Farah Deep"));
    expect(row).toHaveAttribute("aria-expanded", "true");
  });

  it("walks the chapter with the keyset cursor when the local queue is exhausted", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    const template = seed.cases[0];
    seed.cases = Array.from({ length: 30 }, (_, index) => ({
      ...JSON.parse(JSON.stringify(template)),
      id: `bulk-${index}`,
      reference: `G-9${String(index).padStart(3, "0")}`,
      memberName: `Case Member ${index}`,
    }));
    seed.nextCursor = { deadline: "2026-07-24", id: "bulk-29" };
    const nextPage = [{ ...JSON.parse(JSON.stringify(template)), id: "srv-1", reference: "G-9500", memberName: "Server Page Member" }];
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      loadCases: vi.fn(async () => ({ cases: nextPage, nextCursor: null })),
    };
    const { container } = renderCoordinator("en", { api });
    await screen.findByText("Case Member 0");
    // The cursor lands one commit after the desk (effect-seeded), so the
    // controls must be awaited, not queried synchronously. The chapter-wide
    // notice and the queue-local control have distinct accessible names.
    expect(await screen.findByRole("complementary", { name: "More issues available" }))
      .toHaveTextContent("Showing 30 loaded issues.");
    expect(screen.getByRole("button", { name: "Load next campaign page" })).toBeInTheDocument();
    const more = await screen.findByRole("button", { name: "Load more issues" });
    fireEvent.click(more);
    expect(api.loadCases).toHaveBeenCalledWith({ focus: "all", cursor: { deadline: "2026-07-24", id: "bulk-29" } });
    expect(await screen.findByText("Server Page Member")).toBeInTheDocument();
    // The appended page fits the widened window and the cursor is spent.
    expect(container.querySelector(".gq-more")).toBeNull();
  });

  it("does not advance the queue window when load-more fails", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    const template = seed.cases[0];
    seed.cases = Array.from({ length: 30 }, (_, index) => ({
      ...JSON.parse(JSON.stringify(template)),
      id: `bulk-${index}`,
      reference: `G-9${String(index).padStart(3, "0")}`,
      memberName: `Case Member ${index}`,
    }));
    seed.nextCursor = { deadline: "2026-07-24", id: "bulk-29" };
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      loadCases: vi.fn(async () => { throw new Error("chapter page unavailable"); }),
    };
    const { container } = renderCoordinator("en", { api });
    await screen.findByText("Case Member 0");
    const more = await screen.findByRole("button", { name: "Load more issues" });
    fireEvent.click(more);
    await waitFor(() => expect(api.loadCases).toHaveBeenCalledWith({ focus: "all", cursor: { deadline: "2026-07-24", id: "bulk-29" } }));
    await waitFor(() => expect(api.loadCases).toHaveBeenCalledTimes(1));
    // Retry appears only after the rejected page request settles. Read the
    // parity key then, with no fallback: unwritten stays undefined, and any
    // stored count, including the page size, fails.
    expect(await screen.findByRole("button", { name: "Try loading again" })).toBeInTheDocument();
    expect(deviceParityValue("coordinator.visibleCount")).toBeUndefined();
    expect(container.querySelectorAll(".gq-row")).toHaveLength(30);
    expect(screen.getByRole("button", { name: "Load more issues" })).toBeInTheDocument();
  });

  it("exposes the resolved/total basis inside the resolution-rate breakdown", async () => {
    renderCoordinator();
    fireEvent.click(await screen.findByRole("button", { name: /Resolution rate/ }));
    expect(screen.getByText("2 resolved of 6 tracked issues")).toBeInTheDocument();
  });

  // Step values no longer reach any coordinator surface, in either language:
  // not the queue, the docket, the deadline card, the case facts, the
  // timeline or the outreach cards.
  it.each([
    ["en", "Step 2", "Intake"],
    ["es", "Paso 2", "Admisión"],
  ])("shows no grievance step on any %s coordinator surface", async (lang, stepTwo, intake) => {
    const seed = legacyDesk();
    seed.cases[0].step = "Intake";
    seed.cases[1].step = "Step 2";
    const { container } = renderCoordinator(lang, { api: { loadDesk: vi.fn().mockResolvedValue(seed) } });
    // The overview docket names the same issue; open the queue row.
    const row = (await screen.findAllByRole("button", { name: /Renata Cole/ })).find((button) => !button.classList.contains("gq-docket__case"));
    fireEvent.click(row);
    await waitFor(() => expect(container.querySelector(".gq-detail")).not.toBeNull());
    // A step reads as its own " · "-separated segment wherever it used to be
    // appended; free text that merely mentions a word (an update body) is not
    // a step.
    const stepValues = new Set(["Step 2", stepTwo, "Intake", intake, "Organizer follow-up", "Committee review", "Logged"]);
    const leaks = () => [...container.querySelectorAll("button, .gq-detail strong, .gq-docket__due, small, span")]
      .filter((node) => node.textContent.split(/\s*·\s*/).some((segment) => stepValues.has(segment.trim())) || /\b(Step 2|Paso 2)\b/.test(node.textContent));
    expect(leaks()).toEqual([]);
    for (const tab of within(screen.getByRole("navigation", { name: lang === "es" ? "Vistas del seguimiento de asuntos" : "Issue work views" })).getAllByRole("button")) {
      fireEvent.click(tab);
      expect(leaks()).toEqual([]);
    }
  });

  it("clears the search filter when a drilldown opens a filtered-out case", async () => {
    const { container } = renderCoordinator();
    const input = await screen.findByRole("searchbox");
    fireEvent.change(input, { target: { value: "card talk" } });
    expect(screen.queryByText("Renata Cole")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open issues/ }));
    const breakdown = screen.getByRole("region", { name: "Open-issue breakdown" });
    fireEvent.click(await within(breakdown).findByRole("button", { name: /Renata Cole/ }));
    // The breakdown closes, the filter clears, and the real queue row expands.
    expect(screen.queryByRole("region", { name: "Open-issue breakdown" })).not.toBeInTheDocument();
    const row = [...container.querySelectorAll(".gq-row__btn")].find((btn) => btn.textContent.includes("Renata Cole"));
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Issue facts")).toBeInTheDocument();
  });

  it("shows an inline error card with retry instead of blanking on load failure", async () => {
    const api = { loadDesk: vi.fn().mockRejectedValueOnce(new Error("Case queue: permission denied")).mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.coordinatorDesk))) };
    renderCoordinator("en", { api });
    expect(await screen.findByText("Load failed")).toBeInTheDocument();
    expect(screen.queryByText("Case queue: permission denied")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    // Poll the whole assertion: the recovered desk re-renders the queue rows
    // a beat after the first paint, and a node captured by a bare findBy can
    // detach before its expect runs.
    await waitFor(() => expect(screen.getByText("Renata Cole")).toBeInTheDocument());
  });

  it("writes case facts, notes, contact, outcome, and document actions through the scoped API", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    seed.cases[0].files = [{ id: "file-1", filename: "grievance.pdf", sizeBytes: 2048 }];
    let openerWhenRequested;
    const popup = { location: "", opener: window, close: vi.fn() };
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      loadCases: vi.fn(),
      loadAssignmentCandidates: vi.fn().mockResolvedValue([]),
      updateCase: vi.fn().mockResolvedValue({}),
      addCaseNote: vi.fn().mockResolvedValue({}),
      logCaseContact: vi.fn().mockResolvedValue({}),
      recordCaseOutcome: vi.fn().mockResolvedValue({}),
      addCaseFile: vi.fn().mockResolvedValue({}),
      openCaseFile: vi.fn().mockImplementation(() => {
        openerWhenRequested = popup.opener;
        return Promise.resolve(new Blob(["%PDF"]));
      }),
      removeCaseFile: vi.fn().mockResolvedValue({}),
    };
    vi.spyOn(window, "open").mockImplementation(() => popup);
    const { container } = renderCoordinator("en", { api });
    fireEvent.click(await screen.findByRole("button", { name: renataCaseName }));
    const detail = container.querySelector(".gq-detail");

    fireEvent.change(within(detail).getByLabelText("Reason for change"), { target: { value: "Member update" } });
    fireEvent.change(within(detail).getByLabelText("Contract articles"), { target: { value: "Article 7" } });
    fireEvent.click(within(detail).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.updateCase).toHaveBeenCalledWith(seed.cases[0].id, expect.objectContaining({ reason: "Member update", articles: "Article 7" })));

    fireEvent.change(within(detail).getByLabelText("Issue note"), { target: { value: "Called member" } });
    fireEvent.click(within(detail).getByRole("button", { name: "Add issue note" }));
    await waitFor(() => expect(api.addCaseNote).toHaveBeenCalledWith(seed.cases[0].id, "Called member"));

    fireEvent.change(within(detail).getByLabelText("Contacted at"), { target: { value: "2026-08-13T10:30" } });
    fireEvent.change(within(detail).getByLabelText("Contact summary"), { target: { value: "Reviewed deadline" } });
    fireEvent.click(within(detail).getByRole("button", { name: "Log contact" }));
    await waitFor(() => expect(api.logCaseContact).toHaveBeenCalledWith(seed.cases[0].id, expect.objectContaining({ summary: "Reviewed deadline" })));

    fireEvent.change(within(detail).getByLabelText("Outcome summary"), { target: { value: "Settlement signed" } });
    // #7195: the coordinator is told the member will read what they record.
    expect(within(detail).getByLabelText("I confirm this outcome will resolve the case. The member will see the outcome and summary.")).toBeInTheDocument();
    fireEvent.click(within(detail).getByLabelText(/I confirm/));
    fireEvent.click(within(detail).getByRole("button", { name: "Record outcome" }));
    await waitFor(() => expect(api.recordCaseOutcome).toHaveBeenCalledWith(seed.cases[0].id, expect.objectContaining({ summary: "Settlement signed" })));

    const upload = within(detail).getByLabelText("Add a document");
    const file = new File(["case note"], "case-note.txt", { type: "text/plain" });
    fireEvent.change(upload, { target: { files: [file] } });
    await confirmEvidenceUpload();
    await waitFor(() => expect(api.addCaseFile).toHaveBeenCalledWith(seed.cases[0].id, file, { onPhase: expect.any(Function) }));
    // A pending control stays enabled (record 8435): wait for its busy state to clear.
    await waitFor(() => { const button = within(detail).getByRole("button", { name: /^Open(?:: |$)/ }); expect(button).toBeEnabled(); expect(button).not.toHaveAttribute("aria-disabled"); });
    fireEvent.click(within(detail).getByRole("button", { name: /^Open(?:: |$)/ }));
    // The placeholder tab opens synchronously on the click, before the signed
    // URL resolves, so Safari/iOS keeps the tap's transient user activation.
    await waitFor(() => expect(window.open).toHaveBeenCalledWith("", "_blank"));
    expect(openerWhenRequested).toBeNull();
    expect(popup.opener).toBeNull();
    await waitFor(() => expect(popup.location).toBe("blob:coordinator-file"));
    fireEvent.click(within(detail).getByRole("button", { name: /^Remove(?:: |$)/ }));
    await waitFor(() => expect(api.removeCaseFile).toHaveBeenCalledWith(seed.cases[0].files[0]));
    window.open.mockRestore();
  });

  it("closes the placeholder tab and surfaces the inline error when the signed URL fails", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    seed.cases[0].files = [{ id: "file-1", filename: "grievance.pdf", sizeBytes: 2048 }];
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      loadCases: vi.fn(),
      loadAssignmentCandidates: vi.fn().mockResolvedValue([]),
      openCaseFile: vi.fn().mockRejectedValue(new Error("Signed URL expired")),
    };
    const popup = { location: "", close: vi.fn() };
    vi.spyOn(window, "open").mockImplementation(() => popup);
    const { container } = renderCoordinator("en", { api });
    fireEvent.click(await screen.findByRole("button", { name: renataCaseName }));
    const detail = container.querySelector(".gq-detail");

    fireEvent.click(within(detail).getByRole("button", { name: /^Open(?:: |$)/ }));

    expect(await within(detail).findByRole("alert")).toHaveTextContent(catalogue.en["cases.fileFailed"]);
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(popup.location).toBe("");
    window.open.mockRestore();
  });

  it("surfaces the inline error without calling the API when the browser blocks the popup", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    seed.cases[0].files = [{ id: "file-1", filename: "grievance.pdf", sizeBytes: 2048 }];
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      loadCases: vi.fn(),
      loadAssignmentCandidates: vi.fn().mockResolvedValue([]),
      openCaseFile: vi.fn().mockResolvedValue(new Blob(["%PDF"])),
    };
    vi.spyOn(window, "open").mockImplementation(() => null);
    const { container } = renderCoordinator("en", { api });
    fireEvent.click(await screen.findByRole("button", { name: renataCaseName }));
    const detail = container.querySelector(".gq-detail");

    fireEvent.click(within(detail).getByRole("button", { name: /^Open(?:: |$)/ }));

    expect(await within(detail).findByRole("alert")).toHaveTextContent("Allow pop-ups for this site to open the document.");
    expect(api.openCaseFile).not.toHaveBeenCalled();
    window.open.mockRestore();
  });

  // SOL-20260813-07: the coordinator is authorized to read the President's
  // review record but had no surface for it. The line is attribution from real
  // loader data — never a placeholder, and never a "not reviewed" claim.
  describe("President review attribution", () => {
    async function openDetail(seed, lang = "en") {
      const { container } = renderCoordinator(lang, { api: { loadDesk: vi.fn().mockResolvedValue(seed) } });
      await screen.findByRole("button", { name: caseListOpenerName(seed.cases[0]) });
      fireEvent.click([...container.querySelectorAll(".gq-row__btn")][0]);
      return container;
    }

    it("renders the reviewer and date from the case's review record", async () => {
      const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
      seed.cases = [{
        ...seed.cases[0],
        review: { reviewerName: "Taylor Morgan", reviewedAt: "2026-07-23T15:00:00Z", reviewedLabel: "Jul 23" },
      }];
      const container = await openDetail(seed);
      const note = container.querySelector(".gq-review-note");
      expect(note).not.toBeNull();
      expect(note.textContent).toBe("Reviewed by President Taylor Morgan · Jul 23");
      // It belongs to the facts panel, not floating loose in the detail.
      expect(note.closest(".gq-panel")).not.toBeNull();
    });

    it("renders nothing at all when the case carries no review", async () => {
      const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
      seed.cases = [{ ...seed.cases[0], review: null }];
      const container = await openDetail(seed);
      expect(container.querySelector(".gq-review-note")).toBeNull();
      expect(screen.queryByText(/Reviewed by President/)).toBeNull();
    });

    it("localizes the attribution copy in Spanish", async () => {
      const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
      seed.cases = [{
        ...seed.cases[0],
        review: { reviewerName: "Taylor Morgan", reviewedAt: "2026-07-23T15:00:00Z", reviewedLabel: "23 jul" },
      }];
      const container = await openDetail(seed, "es");
      expect(container.querySelector(".gq-review-note").textContent)
        .toBe("Revisado por la Presidencia: Taylor Morgan · 23 jul");
    });
  });
});

// UX-UG-CASE-LIST-FACET-COUNTS-LOADED-WINDOW-20260917. The window
// qualifier is only honest if it is on the FIRST list the coordinator sees.
// The queue's cursor arrives with the desk payload and the rows it describes
// are painted in that same commit, so the cursor must reach the list before
// the browser paints — otherwise a deep link lands on bare counts that look
// like chapter totals and correct themselves a frame later, which is the
// misreading this record exists to remove.
describe("coordinator queue window qualifier", () => {
  afterEach(() => window.history.replaceState({}, "", "/m/coordinator"));

  function caseTypeOptions() {
    return [...screen.getByLabelText("Issue type").options].map((option) => option.textContent);
  }

  function withCursor(cursor) {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    return {
      loadDesk: vi.fn().mockResolvedValue({ ...seed, nextCursor: cursor }),
      loadCases: vi.fn().mockResolvedValue({ cases: [], nextCursor: null }),
    };
  }

  it("qualifies the facet counts on the first painted queue when the chapter continues past it", async () => {
    renderCoordinator("en", { api: withCursor("cursor-1") });
    await screen.findByRole("button", { name: renataCaseName });
    expect(caseTypeOptions().length).toBeGreaterThan(1);
    expect(caseTypeOptions().slice(1).every((label) => /\(\d+ in the loaded window\)$/.test(label))).toBe(true);
  });

  // A pasted ?step= link from before the removal neither filters the queue nor
  // brings back a step facet; the remaining facet counts are still qualified.
  it("ignores a ?step= deep link and offers no step facet on the first paint", async () => {
    window.history.replaceState({}, "", "/m/coordinator?step=Step%204");
    const { container } = renderCoordinator("en", { api: withCursor("cursor-1") });
    await screen.findByRole("button", { name: renataCaseName });
    expect(screen.queryByLabelText("Step")).not.toBeInTheDocument();
    expect(container.querySelector("#case-list-facet-step")).toBeNull();
    expect(container.querySelectorAll(".gq-row__btn")).toHaveLength(4);
    expect(caseTypeOptions().slice(1).every((label) => /\(\d+ in the loaded window\)$/.test(label))).toBe(true);
  });

  it("leaves the counts unqualified when the desk is the whole chapter", async () => {
    renderCoordinator("en", { api: withCursor(null) });
    await screen.findByRole("button", { name: renataCaseName });
    expect(caseTypeOptions().length).toBeGreaterThan(1);
    expect(caseTypeOptions().some((label) => /loaded window/.test(label))).toBe(false);
  });

  // BUG-UG-COORDINATOR-DEADLINES-SHOWS-A-RAW-TEXT-KEY-AND-HIDES-OVERDUE-20261122
  // (#9512, B-49): the deadlines card printed its own text key when the chapter
  // continued past the loaded cases.
  it.each([
    ["en", "Upcoming deadlines", /Deadlines shown: \d+\. Issues loaded: (\d+)\. Issues not yet loaded are not included\./],
    ["es", "Próximos plazos", /Plazos mostrados: \d+\. Asuntos cargados: (\d+)\. No se incluyen los asuntos que aún no se han cargado\./],
  ])("says in words (%s) what the deadlines card counts when the chapter continues past the loaded cases", async (lang, title, sentence) => {
    renderCoordinator(lang, { api: withCursor("cursor-1") });
    const card = await screen.findByRole("region", { name: title });
    expect(card).not.toHaveTextContent("coordinator.deadlinesSliceSub");
    const loaded = card.textContent.match(sentence);
    expect(loaded, card.textContent).not.toBeNull();
    expect(Number(loaded[1])).toBe(fallbackData.coordinatorDesk.cases.length);
  });
});

// Lane 5.6 (#2115): the note box becomes a mention composer only when the
// scoped API can both name the audience and post mentions. These cover the
// audience load, its failure fallback, and the composer's submit path, which
// the write-panel test above never reaches because it exercises addCaseNote.
function mentionApi(seed, loadMentionCandidates) {
  return {
    loadDesk: vi.fn().mockResolvedValue(seed),
    loadCases: vi.fn(),
    loadAssignmentCandidates: vi.fn().mockResolvedValue([]),
    updateCase: vi.fn().mockResolvedValue({}),
    addCaseNote: vi.fn().mockResolvedValue({}),
    addCaseNoteWithMentions: vi.fn().mockResolvedValue({}),
    loadMentionCandidates,
    logCaseContact: vi.fn().mockResolvedValue({}),
    recordCaseOutcome: vi.fn().mockResolvedValue({}),
  };
}

describe("coordinator case note mentions", () => {
  it.each(["resolved", "rejected"])("ignores a %s audience request from the previously selected case", async (outcome) => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    let resolvePrevious;
    let rejectPrevious;
    const api = mentionApi(seed, vi.fn()
      .mockImplementationOnce(() => new Promise((resolve, reject) => { resolvePrevious = resolve; rejectPrevious = reject; }))
      .mockResolvedValueOnce([{ userId: "u-ben", fullName: "Ben Cho" }]));
    const { container } = renderCoordinator("en", { api });
    // The overview docket names the same issues; open the queue rows.
    const queueRow = (buttons) => buttons.find((button) => !button.classList.contains("gq-docket__case"));
    fireEvent.click(queueRow(await screen.findAllByRole("button", { name: new RegExp(seed.cases[0].reference) })));
    await waitFor(() => expect(api.loadMentionCandidates).toHaveBeenCalledWith(seed.cases[0].id));
    fireEvent.click(queueRow(screen.getAllByRole("button", { name: new RegExp(seed.cases[1].reference) })));
    await waitFor(() => expect(api.loadMentionCandidates).toHaveBeenCalledWith(seed.cases[1].id));
    const detail = within(container.querySelector(".gq-detail"));
    const note = detail.getByLabelText("Issue note");
    fireEvent.change(note, { target: { value: "Private B note for @Be" } });
    expect(await detail.findByRole("option", { name: "@Ben Cho" })).toBeInTheDocument();
    await act(async () => {
      if (outcome === "resolved") resolvePrevious([{ userId: "u-dana", fullName: "Dana Reyes" }]);
      else rejectPrevious(new Error("Previous case audience unavailable"));
    });
    expect(note).toHaveValue("Private B note for @Be");
    expect(detail.getByRole("option", { name: "@Ben Cho" })).toBeInTheDocument();
    expect(detail.queryByText(catalogue.en["coordinator.mentionsUnavailable"])).toBeNull();
    fireEvent.submit(note.closest("form"));
    await waitFor(() => expect(api.addCaseNoteWithMentions).toHaveBeenCalledWith(seed.cases[1].id, "Private B note for @Be", []));
  });


  it("loads the case's mention audience and posts the note with the ids it names", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    const api = mentionApi(seed, vi.fn().mockResolvedValue([
      { userId: "u-dana", fullName: "Dana Reyes" },
      { userId: "u-ben", fullName: "Ben Cho" },
    ]));
    const { container } = renderCoordinator("en", { api });
    fireEvent.click(await screen.findByRole("button", { name: renataCaseName }));
    const detail = container.querySelector(".gq-detail");
    await waitFor(() => expect(api.loadMentionCandidates).toHaveBeenCalledWith(seed.cases[0].id));

    fireEvent.change(within(detail).getByLabelText("Issue note"), { target: { value: "Handed to @Dana Reyes for the hearing" } });
    fireEvent.click(within(detail).getByRole("button", { name: "Add issue note" }));
    await waitFor(() => expect(api.addCaseNoteWithMentions)
      .toHaveBeenCalledWith(seed.cases[0].id, "Handed to @Dana Reyes for the hearing", ["u-dana"]));
    // The mention path replaces the plain note write; it never double-posts.
    expect(api.addCaseNote).not.toHaveBeenCalled();
    // A saved note refreshes the desk so the timeline shows it.
    await waitFor(() => expect(api.loadDesk).toHaveBeenCalledTimes(2));
    expect(await within(detail).findByText(catalogue.en["coordinator.writeSaved"])).toHaveAttribute("role", "status");
  });

  it("names the failed mention load and still posts the note without notifying anyone", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    const api = mentionApi(seed, vi.fn().mockRejectedValue(new Error("audience unavailable")));
    const { container } = renderCoordinator("en", { api });
    fireEvent.click(await screen.findByRole("button", { name: renataCaseName }));
    const detail = container.querySelector(".gq-detail");
    await waitFor(() => expect(api.loadMentionCandidates).toHaveBeenCalledWith(seed.cases[0].id));

    const unavailable = await within(detail).findByText(catalogue.en["coordinator.mentionsUnavailable"]);
    expect(unavailable).toHaveAttribute("role", "status");
    const note = within(detail).getByLabelText("Issue note");
    expect(note).toBeTruthy();
    fireEvent.change(note, { target: { value: "Waiting on @Dana Reyes" } });
    fireEvent.click(within(detail).getByRole("button", { name: "Add issue note" }));
    await waitFor(() => expect(api.addCaseNoteWithMentions).toHaveBeenCalledWith(seed.cases[0].id, "Waiting on @Dana Reyes", []));
    expect(api.addCaseNote).not.toHaveBeenCalled();
    expect(await within(detail).findByText(catalogue.en["coordinator.writeSaved"])).toHaveAttribute("role", "status");
    expect(within(detail).getByText(catalogue.en["coordinator.mentionsUnavailable"])).toHaveAttribute("role", "status");
  });

  it("does not claim mentions are unavailable when the audience loads empty", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    const api = mentionApi(seed, vi.fn().mockResolvedValue([]));
    const { container } = renderCoordinator("en", { api });
    fireEvent.click(await screen.findByRole("button", { name: renataCaseName }));
    const detail = container.querySelector(".gq-detail");
    await waitFor(() => expect(api.loadMentionCandidates).toHaveBeenCalledWith(seed.cases[0].id));

    expect(within(detail).queryByText(catalogue.en["coordinator.mentionsUnavailable"])).toBeNull();
    expect(within(detail).getByLabelText("Issue note")).toBeTruthy();
    fireEvent.change(within(detail).getByLabelText("Issue note"), { target: { value: "Filed without a mention" } });
    fireEvent.click(within(detail).getByRole("button", { name: "Add issue note" }));
    await waitFor(() => expect(api.addCaseNoteWithMentions).toHaveBeenCalledWith(seed.cases[0].id, "Filed without a mention", []));
    expect(await within(detail).findByText(catalogue.en["coordinator.writeSaved"])).toHaveAttribute("role", "status");
    expect(within(detail).queryByText(catalogue.en["coordinator.mentionsUnavailable"])).toBeNull();
  });

  it("keeps a half-typed note after the mention audience load fails", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    let rejectLoad;
    const api = mentionApi(seed, vi.fn(() => new Promise((_, reject) => { rejectLoad = reject; })));
    const { container } = renderCoordinator("en", { api });
    fireEvent.click(await screen.findByRole("button", { name: renataCaseName }));
    const detail = container.querySelector(".gq-detail");
    const note = await within(detail).findByLabelText("Issue note");
    fireEvent.change(note, { target: { value: "@Ana please follow up" } });
    expect(note).toHaveValue("@Ana please follow up");
    rejectLoad(new Error("audience unavailable"));
    expect(await within(detail).findByText(catalogue.en["coordinator.mentionsUnavailable"])).toHaveAttribute("role", "status");
    expect(within(detail).getByLabelText("Issue note")).toHaveValue("@Ana please follow up");
  });

  it("carries the mentions-unavailable copy in English and Spanish", () => {
    expect(catalogue.en["coordinator.mentionsUnavailable"]).toMatch(/mentions are unavailable/i);
    expect(catalogue.en["coordinator.mentionsUnavailable"]).toMatch(/without notifying anyone/i);
    expect(catalogue.es["coordinator.mentionsUnavailable"]).toMatch(/menciones no están disponibles/i);
    expect(catalogue.es["coordinator.mentionsUnavailable"]).toMatch(/sin notificar/i);
  });
});

const caseWritePayload = {
  scope: { id: "case-1", organization_id: "org-a", chapter_id: "ch-1", step: "Intake", status: "active", is_restricted: false },
  strength: [],
  deadlines: [],
  checklists: [],
  transitions: [],
  alerts: [],
  management: [],
  retaliation: [],
  links: [],
  reminders: [],
};

describe("coordinator case-tools writes surface a rejected access-history entry", () => {
  it("replaces the saved notice when the updated_case entry is refused", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    seed.cases[0].subjectUserId = "member-renata";
    const actor = { userId: "coordinator-jordan", selectedOrganizationId: "org-a", roles: ["coordinator"], membershipStatus: "active" };
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      recordAccess: vi.fn(async (_actor, event) => ({ ok: event.action === "viewed_case" })),
      loadCaseworkCase: vi.fn().mockResolvedValue(caseWritePayload),
      createCaseDeadline: vi.fn().mockResolvedValue({}),
    };
    renderCoordinator("en", { api, accessActor: actor });
    fireEvent.click(await screen.findByRole("button", { name: renataCaseName }));
    expect(await screen.findByText("Issue tools")).toBeInTheDocument();

    const deadline = screen.getByRole("heading", { name: "Deadline center" }).closest("article");
    fireEvent.change(within(deadline).getByLabelText("Deadline label"), { target: { value: "Arbitration filing" } });
    fireEvent.change(within(deadline).getByLabelText("Due date and time"), { target: { value: "2026-09-10T12:00" } });
    fireEvent.click(within(deadline).getByRole("button", { name: "Add deadline" }));

    await waitFor(() => expect(api.createCaseDeadline).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.recordAccess).toHaveBeenCalledWith(actor, expect.objectContaining({ action: "updated_case", entityId: seed.cases[0].id })));
    expect(await screen.findByText(/access-history entry could not be logged/i)).toBeInTheDocument();
  });

  it("keeps a typed mentioned note and shows catalogue mention-failure copy when the write is refused", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    const api = mentionApi(seed, vi.fn().mockResolvedValue([
      { userId: "u-dana", fullName: "Dana Reyes" },
    ]));
    api.addCaseNoteWithMentions = vi.fn().mockRejectedValue(new MemberApiError("Add mentioned case note", {
      message: "new row violates row-level security policy for table member_case_notes",
    }));
    const { container } = renderCoordinator("en", { api });
    fireEvent.click(await screen.findByRole("button", { name: renataCaseName }));
    const detail = container.querySelector(".gq-detail");
    await waitFor(() => expect(api.loadMentionCandidates).toHaveBeenCalledWith(seed.cases[0].id));

    const box = within(detail).getByLabelText("Issue note");
    fireEvent.change(box, { target: { value: "Handed to Dana for the hearing" } });
    fireEvent.click(within(detail).getByRole("button", { name: "Add issue note" }));
    const alert = await within(detail).findByRole("alert");
    expect(alert).toHaveTextContent(catalogue.en["caseMentions.failed"]);
    expect(alert.textContent).not.toMatch(/Add mentioned case note|row-level security|member_case_notes/);
    expect(box).toHaveValue("Handed to Dana for the hearing");
  });
});

describe("coordinator write-panel catalogue copy", () => {
  it("shows catalogue write-failure copy for a refused update, note, contact and outcome", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      loadCases: vi.fn(),
      loadAssignmentCandidates: vi.fn().mockResolvedValue([]),
      updateCase: vi.fn().mockRejectedValue(new MemberApiError("Update coordinator case", { message: "deadline may only be extended" })),
      addCaseNote: vi.fn().mockRejectedValue(new MemberApiError("Add coordinator case note", { message: "new row violates row-level security policy" })),
      logCaseContact: vi.fn().mockRejectedValue(new MemberApiError("Log coordinator case contact", { message: "permission denied" })),
      recordCaseOutcome: vi.fn().mockRejectedValue(new MemberApiError("Record coordinator case outcome", { message: "check constraint" })),
    };
    const { container } = renderCoordinator("en", { api });
    fireEvent.click(await screen.findByRole("button", { name: renataCaseName }));
    const detail = container.querySelector(".gq-detail");
    const expected = catalogue.en["coordinator.writeFailed"];

    fireEvent.change(within(detail).getByLabelText("Reason for change"), { target: { value: "Member update" } });
    fireEvent.click(within(detail).getByRole("button", { name: "Save changes" }));
    expect(await within(detail).findByRole("alert")).toHaveTextContent(expected);
    expect(within(detail).getByRole("alert").textContent).not.toMatch(/Update coordinator case|deadline may only be extended/);

    fireEvent.change(within(detail).getByLabelText("Issue note"), { target: { value: "Called member" } });
    fireEvent.click(within(detail).getByRole("button", { name: "Add issue note" }));
    await waitFor(() => expect(api.addCaseNote).toHaveBeenCalled());
    expect(within(detail).getByRole("alert")).toHaveTextContent(expected);
    expect(within(detail).getByRole("alert").textContent).not.toMatch(/Add coordinator case note|row-level security/);

    fireEvent.change(within(detail).getByLabelText("Contacted at"), { target: { value: "2026-08-13T10:30" } });
    fireEvent.change(within(detail).getByLabelText("Contact summary"), { target: { value: "Reviewed deadline" } });
    fireEvent.click(within(detail).getByRole("button", { name: "Log contact" }));
    await waitFor(() => expect(api.logCaseContact).toHaveBeenCalled());
    expect(within(detail).getByRole("alert")).toHaveTextContent(expected);
    expect(within(detail).getByRole("alert").textContent).not.toMatch(/Log coordinator case contact|permission denied/);

    fireEvent.change(within(detail).getByLabelText("Outcome summary"), { target: { value: "Settlement signed" } });
    fireEvent.click(within(detail).getByLabelText(/I confirm/));
    fireEvent.click(within(detail).getByRole("button", { name: "Record outcome" }));
    await waitFor(() => expect(api.recordCaseOutcome).toHaveBeenCalled());
    expect(within(detail).getByRole("alert")).toHaveTextContent(expected);
    expect(within(detail).getByRole("alert").textContent).not.toMatch(/Record coordinator case outcome|check constraint/);
  });

  it("shows Spanish write-failure copy for a deadline-shortening refusal and never the English server sentence", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      loadCases: vi.fn(),
      loadAssignmentCandidates: vi.fn().mockResolvedValue([]),
      updateCase: vi.fn().mockRejectedValue(new MemberApiError("Update coordinator case", { message: "deadline may only be extended" })),
    };
    const { container } = renderCoordinator("es", { api });
    fireEvent.click(await screen.findByRole("button", { name: caseListOpenerName(seed.cases[0]) }));
    const detail = container.querySelector(".gq-detail");
    fireEvent.change(within(detail).getByLabelText("Motivo del cambio"), { target: { value: "Acortar plazo" } });
    fireEvent.click(within(detail).getByRole("button", { name: "Guardar cambios" }));
    const alert = await within(detail).findByRole("alert");
    expect(alert).toHaveTextContent(catalogue.es["coordinator.writeFailed"]);
    expect(alert.textContent).not.toMatch(/Update coordinator case/);
    expect(alert.textContent).not.toMatch(/deadline may only be extended/);
  });

  it("shows catalogue file-failure copy for an unmapped coordinator vault error", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    seed.cases[0].files = [{ id: "file-1", filename: "grievance.pdf", sizeBytes: 2048 }];
    const popup = { location: "", close: vi.fn() };
    vi.spyOn(window, "open").mockImplementation(() => popup);
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      loadCases: vi.fn(),
      loadAssignmentCandidates: vi.fn().mockResolvedValue([]),
      openCaseFile: vi.fn().mockRejectedValue(new MemberApiError("Open coordinator case file", {
        message: "permission denied for table storage.objects",
      })),
    };
    const { container } = renderCoordinator("en", { api });
    fireEvent.click(await screen.findByRole("button", { name: renataCaseName }));
    const detail = container.querySelector(".gq-detail");
    fireEvent.click(within(detail).getByRole("button", { name: /^Open(?:: |$)/ }));
    const alert = await within(detail).findByRole("alert");
    expect(alert).toHaveTextContent(catalogue.en["cases.fileFailed"]);
    expect(alert.textContent).not.toMatch(/Open coordinator case file|permission denied|storage\.objects/);
    window.open.mockRestore();
  });

  it("never renders raw driver error text from coordinator writes, vaults, or mentions", () => {
    for (const file of [
      "src/views/CoordinatorView.jsx",
      "src/views/CasesView.jsx",
      "src/components/CaseMentions.jsx",
    ]) {
      // #2929: the case vault keeps copy the app authored itself (demo vault),
      // but only after a MemberApiError has been turned into catalogue copy.
      const source = readFileSync(resolve(process.cwd(), file), "utf8")
        .replace('error instanceof MemberApiError ? t("cases.fileFailed") : (error?.message', "");
      expect(source, file).not.toMatch(/\b(error|cause)\??\.message/);
    }
  });
});

// On the case board (and the timeline and outreach views)
// the case detail's panels are not remounted per case (the upload control
// keeps each case's write lock across a switch). A message
// raised on case A, or written by a write on case A that finishes after the
// switch, must not show under case B.
describe("per-case messages after the coordinator switches cases", () => {
  const actor = { userId: "coordinator-jordan", selectedOrganizationId: "org-a", roles: ["coordinator"], membershipStatus: "active" };
  const refused = /access-history entry could not be logged/i;
  function seeded() {
    const seed = JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
    seed.cases[0].files = [];
    seed.cases[1].files = [];
    seed.cases[0].subjectUserId = "member-a";
    seed.cases[1].subjectUserId = "member-b";
    return seed;
  }
  // Opens a case from the Practical timeline. The timeline (like outreach)
  // keeps one case detail mounted across cases (the queue gives each row its
  // own), which is where a late message could land under the wrong case. The
  // procedure Case board this test used upstream is left out of this edition.
  const openCase = async (item) => {
    if (!screen.queryByRole("heading", { name: "Practical timeline" })) {
      const viewNav = await screen.findByRole("navigation", { name: "Issue work views" });
      fireEvent.click(within(viewNav).getAllByRole("button")[1]);
      await screen.findByRole("heading", { name: "Practical timeline" });
    }
    const event = [...document.querySelectorAll(".gq-master-event")].find((button) => button.textContent.includes(`${item.memberName} · ${item.reference}`));
    expect(event, `a timeline entry for ${item.reference}`).toBeTruthy();
    fireEvent.click(event);
    await waitFor(() => expect(document.querySelector(".gq-detail")).not.toBeNull());
    await waitFor(() => expect(within(document.querySelector(".gq-detail")).getAllByText(item.memberName).length).toBeGreaterThan(0));
  };
  const detail = (container) => container.querySelector(".gq-detail");
  // Every DOM state between two awaits, not only the last: the #8892 CI run
  // caught case B's first frame still carrying case A's message, which a
  // check after the switch settles can miss. Records each state in which the
  // detail shows `item` together with `text`.
  function watchFrames(container, item, text) {
    const seen = [];
    const check = () => {
      const panel = detail(container);
      if (panel && panel.textContent.includes(item.memberName) && text.test(panel.textContent)) seen.push(panel.textContent.slice(0, 120));
    };
    const observer = new MutationObserver(check);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return { seen, stop: () => { check(); observer.disconnect(); } };
  }
  async function upload(container) {
    const file = new File(["case note"], "case-note.txt", { type: "text/plain" });
    fireEvent.change(within(detail(container)).getByLabelText("Add a document"), { target: { files: [file] } });
    await confirmEvidenceUpload();
  }

  it("does not show case A's document message under case B", async () => {
    const seed = seeded();
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      loadCases: vi.fn().mockResolvedValue({ cases: seed.cases, nextCursor: null }),
      recordAccess: vi.fn(async (_actor, event) => ({ ok: event.action === "viewed_case" })),
      addCaseFile: vi.fn().mockResolvedValue({}),
      openCaseFile: vi.fn(),
    };
    const { container } = renderCoordinator("en", { api, accessActor: actor });
    await openCase(seed.cases[0]);
    await upload(container);
    await waitFor(() => expect(api.addCaseFile).toHaveBeenCalledWith(seed.cases[0].id, expect.any(File), expect.any(Object)));
    expect(await within(detail(container)).findByText(refused)).toBeInTheDocument();
    const frames = watchFrames(container, seed.cases[1], refused);
    await openCase(seed.cases[1]);
    frames.stop();
    expect(within(detail(container)).queryByText(refused)).toBeNull();
    expect(frames.seen).toEqual([]);
  });

  it("does not put a case A upload's late message under case B", async () => {
    const seed = seeded();
    let finishUpload;
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      loadCases: vi.fn().mockResolvedValue({ cases: seed.cases, nextCursor: null }),
      recordAccess: vi.fn(async (_actor, event) => ({ ok: event.action === "viewed_case" })),
      addCaseFile: vi.fn(() => new Promise((resolve) => { finishUpload = () => resolve({}); })),
      openCaseFile: vi.fn(),
    };
    const { container } = renderCoordinator("en", { api, accessActor: actor });
    await openCase(seed.cases[0]);
    await upload(container);
    await waitFor(() => expect(finishUpload).toBeTypeOf("function"));
    await openCase(seed.cases[1]);
    await act(async () => { finishUpload(); });
    await waitFor(() => expect(api.recordAccess).toHaveBeenCalledWith(actor, expect.objectContaining({ action: "updated_case", entityId: seed.cases[0].id })));
    await act(async () => { await Promise.resolve(); });
    expect(within(detail(container)).queryByText(refused)).toBeNull();
  });

  it("does not show case A's assignment message under case B", async () => {
    const seed = seeded();
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      loadCases: vi.fn().mockResolvedValue({ cases: seed.cases, nextCursor: null }),
      loadAssignmentCandidates: vi.fn().mockResolvedValue([{ userId: "u-steward", fullName: "Sam Ortiz", roles: ["steward"] }]),
      assignCase: vi.fn().mockResolvedValue({}),
    };
    const { container } = renderCoordinator("en", { api });
    await openCase(seed.cases[0]);
    await waitFor(() => expect(detail(container).querySelector("form.gq-assignment")).not.toBeNull());
    const form = detail(container).querySelector("form.gq-assignment");
    fireEvent.click(within(form).getByRole("checkbox"));
    fireEvent.submit(form);
    expect(await within(detail(container)).findByText(catalogue.en["coordinator.assignmentSaved"])).toBeInTheDocument();
    const frames = watchFrames(container, seed.cases[1], /Assignment saved and the desk was refreshed/);
    await openCase(seed.cases[1]);
    await waitFor(() => expect(api.loadAssignmentCandidates).toHaveBeenCalledWith(seed.cases[1].id));
    frames.stop();
    expect(within(detail(container)).queryByText(catalogue.en["coordinator.assignmentSaved"])).toBeNull();
    expect(frames.seen).toEqual([]);
  });

  // #8892 review P3-2: the "not dropped" cases and a late assignment save.
  function heldUploads(seed) {
    const pending = [];
    return {
      pending,
      api: {
        loadDesk: vi.fn().mockResolvedValue(seed),
        loadCases: vi.fn().mockResolvedValue({ cases: seed.cases, nextCursor: null }),
        recordAccess: vi.fn(async (_actor, event) => ({ ok: event.action === "viewed_case" })),
        addCaseFile: vi.fn((caseId) => new Promise((resolve) => { pending.push({ caseId, finish: () => resolve({}) }); })),
        openCaseFile: vi.fn(),
      },
    };
  }

  it("shows case A's late upload message once the coordinator is back on case A", async () => {
    const seed = seeded();
    const { api, pending } = heldUploads(seed);
    const { container } = renderCoordinator("en", { api, accessActor: actor });
    await openCase(seed.cases[0]);
    await upload(container);
    await waitFor(() => expect(pending).toHaveLength(1));
    await openCase(seed.cases[1]);
    await openCase(seed.cases[0]);
    await act(async () => { pending[0].finish(); });
    expect(await within(detail(container)).findByText(refused)).toBeInTheDocument();
  });

  it("shows case B's own message after case A's late result landed while B was open", async () => {
    const seed = seeded();
    const { api, pending } = heldUploads(seed);
    const { container } = renderCoordinator("en", { api, accessActor: actor });
    await openCase(seed.cases[0]);
    await upload(container);
    await waitFor(() => expect(pending).toHaveLength(1));
    await openCase(seed.cases[1]);
    await act(async () => { pending[0].finish(); });
    await waitFor(() => expect(api.recordAccess).toHaveBeenCalledWith(actor, expect.objectContaining({ action: "updated_case", entityId: seed.cases[0].id })));
    expect(within(detail(container)).queryByText(refused)).toBeNull();
    await upload(container);
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1].caseId).toBe(seed.cases[1].id);
    await act(async () => { pending[1].finish(); });
    await waitFor(() => expect(api.recordAccess).toHaveBeenCalledWith(actor, expect.objectContaining({ action: "updated_case", entityId: seed.cases[1].id })));
    expect(await within(detail(container)).findByText(refused)).toBeInTheDocument();
  });

  it("does not show a late case A assignment save under case B, and shows it back on case A", async () => {
    const seed = seeded();
    let finishAssign;
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      loadCases: vi.fn().mockResolvedValue({ cases: seed.cases, nextCursor: null }),
      loadAssignmentCandidates: vi.fn().mockResolvedValue([{ userId: "u-steward", fullName: "Sam Ortiz", roles: ["steward"] }]),
      assignCase: vi.fn(() => new Promise((resolve) => { finishAssign = () => resolve({}); })),
    };
    const { container } = renderCoordinator("en", { api });
    const saved = catalogue.en["coordinator.assignmentSaved"];
    await openCase(seed.cases[0]);
    await waitFor(() => expect(detail(container).querySelector("form.gq-assignment")).not.toBeNull());
    const form = detail(container).querySelector("form.gq-assignment");
    fireEvent.click(within(form).getByRole("checkbox"));
    fireEvent.submit(form);
    await waitFor(() => expect(finishAssign).toBeTypeOf("function"));
    await openCase(seed.cases[1]);
    await act(async () => { finishAssign(); });
    await waitFor(() => expect(api.assignCase).toHaveBeenCalledWith(seed.cases[0].id, expect.any(Object)));
    await act(async () => { await Promise.resolve(); });
    expect(within(detail(container)).queryByText(saved)).toBeNull();
    await openCase(seed.cases[0]);
    expect(await within(detail(container)).findByText(saved)).toBeInTheDocument();
  });

  // One message per case, so a late write for case A never
  // replaces the message case B is showing.
  it("keeps case B's pop-up message when case A's late upload result lands", async () => {
    const seed = seeded();
    seed.cases[1].files = [{ id: "file-b", filename: "b-statement.pdf", sizeBytes: 2048 }];
    const { api, pending } = heldUploads(seed);
    vi.spyOn(window, "open").mockReturnValue(null);
    const blocked = catalogue.en["uploads.popupBlocked"];
    const { container } = renderCoordinator("en", { api, accessActor: actor });
    await openCase(seed.cases[0]);
    await upload(container);
    await waitFor(() => expect(pending).toHaveLength(1));
    await openCase(seed.cases[1]);
    // The upload control frees the panel once the case changes; click B's
    // Open only when it is usable (on a loaded runner that takes a moment).
    const openB = await within(detail(container)).findByRole("button", { name: `${catalogue.en["cases.openDocument"]}: b-statement.pdf` });
    await waitFor(() => expect(openB).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(openB);
    expect(await within(detail(container)).findByText(blocked)).toBeInTheDocument();
    await act(async () => { pending[0].finish(); });
    await waitFor(() => expect(api.recordAccess).toHaveBeenCalledWith(actor, expect.objectContaining({ action: "updated_case", entityId: seed.cases[0].id })));
    await act(async () => { await Promise.resolve(); });
    expect(within(detail(container)).getByText(blocked)).toBeInTheDocument();
    expect(within(detail(container)).queryByText(refused)).toBeNull();
  });

  it("keeps case B's assignee load failure and its Try again when case A's late save fails", async () => {
    const seed = seeded();
    let failAssign;
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      loadCases: vi.fn().mockResolvedValue({ cases: seed.cases, nextCursor: null }),
      loadAssignmentCandidates: vi.fn(async (caseId) => {
        if (caseId === seed.cases[1].id) throw new Error("offline");
        return [{ userId: "u-steward", fullName: "Sam Ortiz", roles: ["steward"] }];
      }),
      assignCase: vi.fn(() => new Promise((_resolve, reject) => { failAssign = () => reject(new Error("refused")); })),
    };
    const { container } = renderCoordinator("en", { api });
    const loadFailed = catalogue.en["coordinator.assignmentLoadError"];
    await openCase(seed.cases[0]);
    await waitFor(() => expect(detail(container).querySelector("form.gq-assignment")).not.toBeNull());
    const form = detail(container).querySelector("form.gq-assignment");
    fireEvent.click(within(form).getByRole("checkbox"));
    fireEvent.submit(form);
    await waitFor(() => expect(failAssign).toBeTypeOf("function"));
    await openCase(seed.cases[1]);
    expect(await within(detail(container)).findByText(loadFailed)).toBeInTheDocument();
    await act(async () => { failAssign(); });
    await act(async () => { await Promise.resolve(); });
    expect(within(detail(container)).getByText(loadFailed)).toBeInTheDocument();
    expect(within(detail(container)).getByRole("button", { name: catalogue.en["app.tryAgain"] })).toBeInTheDocument();
    expect(within(detail(container)).queryByText(catalogue.en["coordinator.assignmentLoading"])).toBeNull();
  });

  // A case tools write that commits after the coordinator
  // opened another case still records its updated_case entry, once, for its
  // own case; no notice shows under the case on screen.
  it("records the access-history entry once for a case tools write the coordinator left mid-write", async () => {
    const seed = seeded();
    let finishDeadline;
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      recordAccess: vi.fn(async () => ({ ok: true })),
      loadCaseworkCase: vi.fn().mockResolvedValue(caseWritePayload),
      createCaseDeadline: vi.fn(() => new Promise((resolve) => { finishDeadline = () => resolve({}); })),
    };
    const { container } = renderCoordinator("en", { api, accessActor: actor });
    await openCase(seed.cases[0]);
    expect(await screen.findByText("Issue tools")).toBeInTheDocument();
    const deadline = screen.getByRole("heading", { name: "Deadline center" }).closest("article");
    fireEvent.change(within(deadline).getByLabelText("Deadline label"), { target: { value: "Arbitration filing" } });
    fireEvent.change(within(deadline).getByLabelText("Due date and time"), { target: { value: "2026-09-10T12:00" } });
    fireEvent.click(within(deadline).getByRole("button", { name: "Add deadline" }));
    await waitFor(() => expect(finishDeadline).toBeTypeOf("function"));
    await openCase(seed.cases[1]);
    await act(async () => { finishDeadline(); });
    await waitFor(() => expect(api.recordAccess).toHaveBeenCalledWith(actor, expect.objectContaining({ action: "updated_case", entityId: seed.cases[0].id })));
    await act(async () => { await Promise.resolve(); });
    const updates = api.recordAccess.mock.calls.filter(([, event]) => event.action === "updated_case");
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toEqual(expect.objectContaining({ entityId: seed.cases[0].id }));
    expect(within(detail(container)).queryByText(refused)).toBeNull();
  });

  it("does not show case A's case tools notice under case B", async () => {
    const seed = seeded();
    const api = {
      loadDesk: vi.fn().mockResolvedValue(seed),
      recordAccess: vi.fn(async (_actor, event) => ({ ok: event.action === "viewed_case" })),
      loadCaseworkCase: vi.fn().mockResolvedValue(caseWritePayload),
      createCaseDeadline: vi.fn().mockResolvedValue({}),
    };
    const { container } = renderCoordinator("en", { api, accessActor: actor });
    await openCase(seed.cases[0]);
    expect(await screen.findByText("Issue tools")).toBeInTheDocument();
    const deadline = screen.getByRole("heading", { name: "Deadline center" }).closest("article");
    fireEvent.change(within(deadline).getByLabelText("Deadline label"), { target: { value: "Arbitration filing" } });
    fireEvent.change(within(deadline).getByLabelText("Due date and time"), { target: { value: "2026-09-10T12:00" } });
    fireEvent.click(within(deadline).getByRole("button", { name: "Add deadline" }));
    expect(await within(detail(container)).findByText(refused)).toBeInTheDocument();
    const frames = watchFrames(container, seed.cases[1], refused);
    await openCase(seed.cases[1]);
    frames.stop();
    expect(within(detail(container)).queryByText(refused)).toBeNull();
    expect(frames.seen).toEqual([]);
  });
});
