import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BottomNav } from "../src/components/BottomNav.jsx";
import { StewardView } from "../src/views/StewardView.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { chooseReminder } from "./helpers/reminderPicker.js";
import { catalogue, t } from "../src/lib/i18n.js";
import { expectHeldWriteFocus, expectOneWriteFromOneTick, expectPendingFocus } from "./helpers/busyWriteFocus.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const desk = {
  queue: [
    { id: "req-1", memberName: "Renata Cole", memberInitials: "RC", lessonLabel: "Section 7", status: "requested", createdAt: "2026-07-20T14:00:00Z" },
    { id: "req-2", memberName: "Devon Pratt", memberInitials: "DP", lessonLabel: "", status: "acknowledged", createdAt: "2026-07-18T14:00:00Z" },
  ],
  threads: [
    {
      id: "conv-1",
      memberName: "Renata Cole",
      memberInitials: "RC",
      preview: "They mandated me again last night.",
      updatedAt: "2026-07-21T09:00:00Z",
      awaitingReply: true,
      messages: [{ id: "m-1", sender_kind: "member", sender_name: "Renata Cole", body: "They mandated me again last night.", created_at: "2026-07-21T09:00:00Z" }],
    },
  ],
  broadcasts: [
    { id: "bc-1", title: "Card-count update", body: "Management moved on scheduling.", publishedAt: "2026-07-19T17:00:00Z", retracted: false, readCount: 3 },
  ],
  formsInbox: [
    { id: "form-inbox-1", userId: "demo-member-2", memberInitials: "JM", memberName: "Jordan Mills", templateKey: "grievance", status: "submitted", submittedAt: "2026-07-21T16:40:00Z",
      answers: { summary: "Mandated overtime without the 48-hour notice", incident_date: "2026-07-18", narrative: "Third mandate this month; the notice arrived after the shift had already started.", remedy: "Follow the notice window and make the extra hours voluntary", witnesses: "A. Reyes" } },
    { id: "form-inbox-2", userId: "demo-member-3", memberInitials: "AR", memberName: "Ava Ramos", templateKey: "alt_work", status: "in_review", submittedAt: "2026-07-20T13:05:00Z",
      answers: { requested: "Telework Tuesdays and Thursdays", reason: "Recurring medical appointments" } },
  ],
  kpis: { openRequests: 2, membersCovered: 38, awaitingReply: 1, broadcasts30d: 1 },
};

function makeApi() {
  return {
    loadDesk: vi.fn().mockResolvedValue(desk),
    triage: vi.fn().mockResolvedValue({}),
    reply: vi.fn().mockResolvedValue({}),
    toggleReaction: vi.fn().mockResolvedValue({ reacted: true }),
    toggleSaved: vi.fn().mockResolvedValue({ saved: true }),
    remind: vi.fn().mockResolvedValue({ id: "reminder-1" }),
    schedule: vi.fn().mockResolvedValue({ id: "scheduled-1" }),
    sendResource: vi.fn().mockResolvedValue({ messageId: "resource-message-1" }),
    listScheduled: vi.fn().mockResolvedValue([]),
    publish: vi.fn().mockResolvedValue({}),
    retract: vi.fn().mockResolvedValue({}),
    startFormReview: vi.fn().mockResolvedValue({}),
    approveForm: vi.fn().mockResolvedValue({}),
    returnForm: vi.fn().mockResolvedValue({}),
    approveAndOpenCase: vi.fn().mockResolvedValue({}),
    formFilingStatus: vi.fn().mockResolvedValue({ filerSigned: true, attachments: [{ id: "att-1", filename: "schedule.pdf", confirmedAt: "2026-08-12T12:00:00Z" }] }),
    scan: vi.fn().mockResolvedValue({ memberUserId: "m-1", memberName: "Marisol Vega", checkedIn: true, alreadyCheckedIn: false, memberAwardedPoints: 50, scannerAwardedPoints: 15 }),
  };
}


// Closing a request opens a confirmation first (Lovable audit APP-STEWARD-14).
async function confirmClose() {
  const dialog = await screen.findByTestId("confirm-action");
  fireEvent.click(within(dialog).getByRole("button", { name: "Close request" }));
}
describe("independent steward workspaces", () => {
  it("loads appointments without waiting for the unrelated casework desk", async () => {
    window.history.replaceState({}, "", "/m/steward/appointments");
    const api = { ...makeApi(), loadDesk: vi.fn(() => new Promise(() => {})),
      loadAppointments: vi.fn().mockResolvedValue({ schedule: null, windows: [], upcoming: [], recent: [] }) };
    try {
      render(<WorkspacePages view="steward" location="/m/steward/appointments" navigate={vi.fn()} hat="steward">
        <StewardView data={{ member: {} }} api={api} onNotice={vi.fn()} />
      </WorkspacePages>);
      expect(await screen.findByRole("button", { name: "Set availability" })).toBeInTheDocument();
      expect(api.loadDesk).not.toHaveBeenCalled();
    } finally { window.history.replaceState({}, "", "/"); }
  });

  it("keeps the Guide and Campaign work in the appointments page header", async () => {
    window.history.replaceState({}, "", "/m/steward/appointments");
    const api = { ...makeApi(), loadDesk: vi.fn(() => new Promise(() => {})),
      loadAppointments: vi.fn().mockResolvedValue({ schedule: null, windows: [], upcoming: [], recent: [] }) };
    const onAssistant = vi.fn();
    const onOpenTasks = vi.fn();
    try {
      render(<WorkspacePages view="steward" location="/m/steward/appointments" navigate={vi.fn()} hat="steward">
        <StewardView data={{ member: {} }} api={api} onNotice={vi.fn()} onAssistant={onAssistant} onOpenTasks={onOpenTasks} />
      </WorkspacePages>);
      await screen.findByRole("button", { name: "Set availability" });
      fireEvent.click(screen.getByRole("button", { name: "Campaign work" }));
      expect(onOpenTasks).toHaveBeenCalledTimes(1);
      fireEvent.click(document.querySelector(".phead__btn--assistant"));
      expect(onAssistant).toHaveBeenCalledTimes(1);
      expect(api.loadDesk).not.toHaveBeenCalled();
    } finally { window.history.replaceState({}, "", "/"); }
  });

  it("shows a failed initial requests read as unavailable rather than empty and retries it", async () => {
    const api = makeApi();
    api.loadDesk.mockResolvedValueOnce({ ...desk, queue: [], requestsUnavailable: true }).mockResolvedValue(desk);
    const { container } = render(<StewardView data={{ member: {} }} api={api} onNotice={vi.fn()} />);
    await screen.findByText("Worker requests");
    const requests = container.querySelector("#steward-requests");
    await within(requests).findByText("This list could not be loaded.");
    expect(requests.querySelector(".cwk-count")).toBeNull();
    fireEvent.click(within(requests).getByRole("button", { name: "Try again" }));
    expect(await within(requests).findByRole("button", { name: "Renata Cole" })).toBeInTheDocument();
  });
});

// REQ-UG-CASEWORK-CONSOLE-54: the steward hub mounts the same five tiles
// the coordinator gets as a tab. The aggregates scope themselves to the caller,
// so this is the steward's own assigned caseload, and the tiles deep-link back
// into the steward's caseload rather than the coordinator's queue.
describe("steward case dashboards", () => {
  it("mounts the dashboards section and aims its deep links at the steward's own caseload", async () => {
    const api = {
      ...makeApi(),
      loadCaseDashboards: vi.fn().mockResolvedValue({
        dueSoon: [],
        overdue: [{ kind: "response", deadlineCount: 2, caseCount: 2, oldestDueAt: "2026-07-10T12:00:00Z" }],
        byAssignee: [],
      }),
    };
    render(<StewardView data={{ member: { initials: "SO" } }} api={api} onNotice={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Issue dashboards" })).toBeInTheDocument();
    const tile = await screen.findByRole("figure", { name: "Overdue deadlines" });
    expect(within(tile).getAllByRole("link")[0]).toHaveAttribute("href", "/m/steward?deadline=overdue&kind=response");
    expect(api.loadCaseDashboards).toHaveBeenCalledTimes(1);
    // Union Ground issues have no grievance steps: no by-step or
    // median-per-step tile, and no tile deep-links to a step filter.
    expect(screen.queryByRole("figure", { name: /by step|per step/i })).toBeNull();
    expect(document.querySelector('a[href*="step="]')).toBeNull();
  });

  it("renders nothing at all when the desk carries no aggregate read", async () => {
    render(<StewardView data={{ member: { initials: "SO" } }} api={makeApi()} onNotice={() => {}} />);
    // Wait for the desk itself to land, so the absence below is a decision
    // rather than a race with the load.
    expect((await screen.findAllByText("Renata Cole")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "Issue dashboards" })).toBeNull();
    expect(screen.queryByText("Loading the issue dashboards…")).toBeNull();
  });
});

const scanEvents = [
  { id: "evt-1", title: "Chapter meeting", dateLabel: "Thu, Jul 30" },
  { id: "evt-2", title: "Caseload rally", dateLabel: "Tue, Aug 11" },
];

async function startCamera() {
  const button = await screen.findByRole("button", { name: "Use the camera" });
  await waitFor(() => expect(button).toBeEnabled(), { timeout: 3_000 });
  fireEvent.click(button);
}

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");

afterEach(() => {
  if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  else delete navigator.mediaDevices;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Wave 2a (2026-07-28): the flat Steward tab is gone. The steward flag now
// swaps the member bar's Voice/Learn pair for the prototype's Cases/Inbox
// pair, so the role gate is pinned on that vocabulary instead.
describe("role-gated steward navigation", () => {
  it("renders no steward tab nodes for plain members", () => {
    render(<BottomNav active="today" onNavigate={() => {}} />);
    expect(screen.getByRole("link", { name: "Work" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Meetings" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Inbox" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Reports" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Committee" })).toBeNull();
  });

  it("swaps in the steward tab set only when the steward flag is set", () => {
    render(<BottomNav active="cases" onNavigate={() => {}} steward />);
    const tab = screen.getByRole("link", { name: "Issues" });
    expect(tab).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Inbox" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reports" })).toBeInTheDocument();
    // The worker-only pair gives way — the bar stays six entries either way.
    expect(screen.queryByRole("link", { name: "Work" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Meetings" })).toBeNull();
  });
});

// Wave 2e (pixel-match, prototype pg.casework): the desk adopts the shared
// staff-plane anatomy. `.strip-head` was a Wave-2b placeholder and this view
// was its last consumer, so its absence is pinned here rather than left to a
// sweep — a re-added strip header would otherwise pass every assertion below.
describe("casework desk plane anatomy", () => {
  it("announces Committee desk loading as a polite status", () => {
    const api = makeApi();
    api.loadDesk.mockReturnValue(new Promise(() => {}));
    render(<StewardView data={{ member: { initials: "SO" } }} api={api} onNotice={() => {}} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading the committee desk");
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  it("renders the shared plane header with real desk counts and both actions", async () => {
    const onAssistant = vi.fn();
    const onOpenTasks = vi.fn();
    render(
      <StewardView
        data={{ member: { initials: "SO" } }}
        api={makeApi()}
        onNotice={() => {}}
        onAssistant={onAssistant}
        onOpenTasks={onOpenTasks}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Committee desk" })).toBeInTheDocument();
    expect(document.querySelector(".phead")).not.toBeNull();
    expect(document.querySelector(".strip-head")).toBeNull();
    expect(document.querySelector(".plane-tools")).toBeNull();
    // The toolbar wrap belongs to the strips that carry full toolbars (Case
    // queue, work tool); this two-button strip stays a one-line strip at
    // every width.
    expect(document.querySelector(".phead--toolbar")).toBeNull();
    // Both header actions are wired to the callbacks they were given.
    fireEvent.click(screen.getByRole("button", { name: "Ask Union Ground Guide" }));
    expect(onAssistant).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Campaign work/ }));
    expect(onOpenTasks).toHaveBeenCalledTimes(1);
    // The Chapter-work entrance is the strip variant: its label rides in its
    // own span so the ≤720px rule can hide it visually (the Spanish label
    // starved the strip title otherwise) while the accessible name stays put.
    const work = screen.getByRole("button", { name: /Campaign work/ });
    expect(work.classList.contains("cwk-btn--strip")).toBe(true);
    expect(work.querySelector(".cwk-btn__label")).not.toBeNull();
    expect(work.querySelector(".cwk-btn__ic").getAttribute("aria-hidden")).toBe("true");
  });

  // The <=720px stylesheet rule IS the Spanish-crush fix, and jsdom never
  // enters media queries: the markup pins above stay green if the rule is
  // deleted and the crush quietly returns. Same text-level assertion over the
  // sheet as the density-floor guard, for the same reason.
  it("keeps the phone-width label-hide rule for the strip action", () => {
    const css = readFileSync(join(repoRoot, "src/styles.css"), "utf8").replace(/\r\n/g, "\n");
    const blocks = [...css.matchAll(/@media \(max-width: 720px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]);
    const strip = blocks.find((body) => body.includes(".cwk-btn--strip"));
    expect(strip).toBeDefined();
    // 48px: the mobile web support tier's touch-target floor (design Step 2 raised it from 44px).
    expect(strip).toContain(".cwk-btn--strip { justify-content: center; min-width: 48px;");
    expect(strip).toContain(
      ".cwk-btn--strip .cwk-btn__label { position: absolute; width: 1px; height: 1px;",
    );
  });

  it("renders four KPI tiles off desk.kpis, not the prototype's seeded numbers", async () => {
    render(<StewardView data={{ member: { initials: "SO" } }} api={makeApi()} onNotice={() => {}} />);
    await screen.findByText("Worker requests");
    const tiles = [...document.querySelectorAll(".pkpi")];
    expect(tiles).toHaveLength(4);
    expect(tiles.map((tile) => tile.querySelector(".pkpi__value").textContent)).toEqual(["2", "38", "1", "1"]);
    // The prototype's hardcoded subline is gone; the strip states the real
    // open/covered pair instead. The interpolated key lands with the wave's
    // central i18n merge, so only the numbers are asserted here.
    expect(document.querySelector(".phead__sub")).not.toBeNull();
  });

  // The dark Compass card carries no invented member question and no invented
  // answer — only the entrance. With no assistant to open, it must not render
  // at all rather than render a dead control.
  it("omits the Compass card entirely when no assistant callback is given", async () => {
    render(<StewardView data={{ member: { initials: "SO" } }} api={makeApi()} onNotice={() => {}} />);
    await screen.findByText("Worker requests");
    expect(document.querySelector(".cwk-compass")).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask Union Ground Guide" })).toBeNull();
  });
});

describe("steward desk view", () => {
  it("accepts a reviewing external-email intake and reloads its bounded queue", async () => {
    const api = makeApi();
    api.listEmailIntakes = vi.fn().mockResolvedValue([{
      id: "email-1",
      status: "reviewing",
      subject: "Member follow-up",
      from: "member@example.test",
      text: "Please contact me.",
      receivedAt: "2026-08-13T12:00:00Z",
    }]);
    api.reviewEmailIntake = vi.fn().mockResolvedValue({ updated: true });
    const onNotice = vi.fn();
    render(<StewardView data={{ member: { initials: "SO" } }} api={api} onNotice={onNotice} />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    await waitFor(() => expect(api.reviewEmailIntake).toHaveBeenCalledWith("email-1", "accept"));
    await waitFor(() => expect(api.listEmailIntakes).toHaveBeenCalledTimes(2));
    expect(onNotice).toHaveBeenCalledWith("Email intake review updated");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(api.reviewEmailIntake).toHaveBeenCalledWith("email-1", "reject"));
  });

  it("allows only this origin to use the camera while denying unrelated sensors", () => {
    const config = JSON.parse(readFileSync(join(repoRoot, "vercel.json"), "utf8"));
    const globalHeaders = config.headers.find((entry) => entry.source === "/(.*)" && !entry.has)?.headers || [];
    expect(globalHeaders.find((header) => header.key === "Permissions-Policy")?.value)
      .toBe("camera=(self), microphone=(), geolocation=()");
  });

  it("draws only the trend categories the server published (#7180)", async () => {
    const api = makeApi();
    api.loadDesk.mockResolvedValue({
      ...desk,
      workloadIntelligence: {
        available: true,
        eligibleWeeks: 2,
        categories: [{ key: "priority", slope: 0, latest: 9, forecast4Weeks: 9, points: 2 }, { key: "pending", slope: 0, latest: 9, forecast4Weeks: 9, points: 2 }],
        rebalancing: { stewards: [], suggestions: [] },
      },
    });
    render(<StewardView data={{ member: { initials: "SO" } }} api={api} onNotice={() => {}} />);
    const workload = (await screen.findByRole("heading", { name: "Workplace log insights" })).closest("section");
    expect(workload.querySelectorAll(".cwk-workload__trend")).toHaveLength(2);
    expect(within(workload).queryByText("Aged issues")).toBeNull();
  });

  it("renders bounded trends, counts-only rebalancing rows, and the privacy disclaimer copy", async () => {
    const api = makeApi();
    api.loadDesk.mockResolvedValue({
      ...desk,
      workloadIntelligence: {
        available: true,
        eligibleWeeks: 6,
        categories: [{ key: "pending", slope: 1.5, latest: 20, forecast4Weeks: 26, points: 6 }],
        rebalancing: {
          stewards: [
            { id: "s1", name: "R. Cole", activeCases: 18, dueSoon: 4, overdue: 2 },
            { id: "s2", name: "A. Ramos", activeCases: 7, dueSoon: 1, overdue: 0 },
          ],
          suggestions: [{ fromId: "s1", fromName: "R. Cole", toId: "s2", toName: "A. Ramos", reviewCount: 3 }],
        },
      },
    });
    render(<StewardView data={{ member: { initials: "SO" } }} api={api} onNotice={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Workplace log insights" })).toBeInTheDocument();
    const workload = screen.getByRole("heading", { name: "Workplace log insights" }).closest("section");
    expect(within(workload).getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText(/20 → 26/)).toBeInTheDocument();
    expect(screen.getByText(/Review 3 assignments from R\. Cole with A\. Ramos/)).toBeInTheDocument();
    expect(screen.getByText(/assigned-issue counts.*never private worker logs/i)).toBeInTheDocument();
  });

  it("never renders an unexpected field from the rebalancing payload", async () => {
    const PRIVATE_FIELD_SENTINEL = "WLPRIV-knee-sx-followup-20261002";
    const api = makeApi();
    api.loadDesk.mockResolvedValue({
      ...desk,
      workloadIntelligence: {
        available: true,
        eligibleWeeks: 6,
        categories: [{ key: "pending", slope: 1.5, latest: 20, forecast4Weeks: 26, points: 6 }],
        rebalancing: {
          stewards: [
            {
              id: "s1",
              name: "R. Cole",
              activeCases: 18,
              dueSoon: 4,
              overdue: 2,
              privateNote: `knee surgery follow-up 2026-10-02 ${PRIVATE_FIELD_SENTINEL}`,
            },
            {
              id: "s2",
              name: "A. Ramos",
              activeCases: 7,
              dueSoon: 1,
              overdue: 0,
              medicalAccommodation: `reduced caseload — medical appointments ${PRIVATE_FIELD_SENTINEL}`,
            },
          ],
          suggestions: [{
            fromId: "s1",
            fromName: "R. Cole",
            toId: "s2",
            toName: "A. Ramos",
            reviewCount: 3,
            privateNote: PRIVATE_FIELD_SENTINEL,
          }],
        },
      },
    });
    render(<StewardView data={{ member: { initials: "SO" } }} api={api} onNotice={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Workplace log insights" })).toBeInTheDocument();
    const workload = screen.getByRole("heading", { name: "Workplace log insights" }).closest("section");
    expect(within(workload).getByText(/R\. Cole: 18 active/)).toBeInTheDocument();
    expect(within(workload).getByText(/A\. Ramos: 7 active/)).toBeInTheDocument();
    expect(within(workload).getByText(/Review 3 assignments from R\. Cole with A\. Ramos/)).toBeInTheDocument();
    expect(within(workload).queryByText(new RegExp(PRIVATE_FIELD_SENTINEL))).toBeNull();
    expect(document.body.textContent).not.toContain(PRIVATE_FIELD_SENTINEL);
    expect(workload.innerHTML).not.toContain(PRIVATE_FIELD_SENTINEL);
  });

  it("renders an honest unavailable state below the anonymity floor", async () => {
    const api = makeApi();
    api.loadDesk.mockResolvedValue({
      ...desk,
      workloadIntelligence: {
        available: false,
        reason: "anonymity_floor",
        eligibleWeeks: 0,
        categories: [],
        rebalancing: { stewards: [], suggestions: [] },
      },
    });
    render(<StewardView data={{ member: { initials: "SO" } }} api={api} onNotice={() => {}} />);
    expect(await screen.findByText(/Trend data appears after at least 25 campaign workers/)).toBeInTheDocument();
    expect(screen.queryByText("No material issue-count imbalance to review.")).toBeNull();
  });

  it("renders queue, threads, and composer from desk data", async () => {
    render(<StewardView data={{ member: { initials: "SO" } }} api={makeApi()} onNotice={() => {}} />);
    expect(await screen.findByText("Worker requests")).toBeInTheDocument();
    // Rows seed through the paged-queue effect (UB-DESK-01) one commit after
    // the desk shell — the first row query must be awaited.
    expect((await screen.findAllByText("Renata Cole")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Acknowledge" })).toBeInTheDocument();
    expect(screen.getByText("Read by 3 workers", { exact: false })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Card-count update — what moved at yesterday's huddle…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish broadcast" })).toBeInTheDocument();
  });

  it("keeps a page-scoped count without repeating the newest-20 read", async () => {
    const api = makeApi();
    api.getBroadcastReadCounts = vi.fn().mockResolvedValue([{ broadcastId: "bc-1", readCount: 8 }]);
    render(<StewardView data={{ member: { initials: "SO" } }} api={api} onNotice={() => {}} />);
    expect(await screen.findByText("Read by 3 workers", { exact: false })).toBeInTheDocument();
    expect(api.getBroadcastReadCounts).not.toHaveBeenCalled();
    expect(screen.getByText("Read by 3 workers", { exact: false })).toBeInTheDocument();
  });

  it("fills a missing page-scoped count from get_broadcast_read_counts", async () => {
    const api = makeApi();
    api.loadDesk = vi.fn().mockResolvedValue({
      ...desk,
      broadcasts: [{ id: "bc-2", title: "Safety huddle", body: "Bring cards.", publishedAt: "2026-07-19T17:00:00Z", retracted: false, readCount: null }],
    });
    api.getBroadcastReadCounts = vi.fn().mockResolvedValue([{ broadcastId: "bc-2", readCount: 4 }]);
    render(<StewardView data={{ member: { initials: "SO" } }} api={api} onNotice={() => {}} />);
    expect(await screen.findByText("Safety huddle")).toBeInTheDocument();
    expect(await screen.findByText("Read by 4 workers", { exact: false })).toBeInTheDocument();
    expect(api.getBroadcastReadCounts).toHaveBeenCalledTimes(1);
  });

  it("cancels a scheduled steward reply and surfaces the refusal", async () => {
    const api = makeApi();
    api.listScheduled = vi.fn().mockResolvedValue([{
      id: "sched-1", conversation_id: "conv-1", body: "Follow up tomorrow",
      scheduled_for: "2026-09-18T12:00:00Z", status: "pending",
    }]);
    api.cancelScheduled = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("scheduled message unavailable"), { code: "22023" }))
      .mockResolvedValueOnce({ cancelled: true });
    const onNotice = vi.fn();
    render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={onNotice} />);
    fireEvent.click(await screen.findByText("They mandated me again last night."));
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    expect(await within(dialog).findByText(/Follow up tomorrow/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel scheduled send" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("scheduled message unavailable"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel scheduled send" }));
    await waitFor(() => expect(api.cancelScheduled).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Scheduled send cancelled"));
  });

  it("exposes steward reactions, saves, reminders, scheduling, and member-readable resource drops", async () => {
    const api = makeApi();
    render(<StewardView data={{ member: { id: "steward-1", initials: "SO" }, product: { documents: [{ id: "doc-1", title: "Chapter policy", status: "published", visibility: "campaign" }, { id: "doc-2", title: "Staff notes", status: "published", visibility: "staff" }] } }} api={api} onNotice={() => {}} />);
    fireEvent.click(await screen.findByText("They mandated me again last night."));
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    fireEvent.click(within(dialog).getByRole("button", { name: "React" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Care" }));
    await waitFor(() => expect(api.toggleReaction).toHaveBeenCalledWith("private", "m-1", "care"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.toggleSaved).toHaveBeenCalledWith("private", "m-1"));
    const remindAt = chooseReminder(dialog);
    await waitFor(() => expect(api.remind).toHaveBeenCalledWith("private", "m-1", remindAt));
    expect(within(dialog).queryByRole("option", { name: "Staff notes" })).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByPlaceholderText("Reply as Committee…"), { target: { value: "Scheduled reply" } });
    fireEvent.change(within(dialog).getByLabelText("Schedule for"), { target: { value: "2099-08-12T12:30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(api.schedule).toHaveBeenCalledWith("conv-1", "Scheduled reply", new Date("2099-08-12T12:30").toISOString()));
  });

  it("acknowledges a request through the api and reloads the desk", async () => {
    const api = makeApi();
    const onNotice = vi.fn();
    render(<StewardView data={{ member: { initials: "SO" } }} api={api} onNotice={onNotice} />);
    fireEvent.click(await screen.findByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Request acknowledged"));
    expect(api.triage).toHaveBeenCalledWith("req-1", "acknowledge");
    expect(api.loadDesk).toHaveBeenCalledTimes(2);
  });

  // BUG-UG-PAGES-FAIL-HARD-ON-MISSING-OR-SLOW-FUNCTION-20261003: a
  // failed KPI read used to fail the whole desk; now the tiles read "—", say
  // why, and the queues still work.
  it("keeps the queues working with dash tiles when the desk counts could not load", async () => {
    const api = makeApi();
    api.loadDesk.mockResolvedValue({ ...desk, kpis: { openRequests: null, membersCovered: 38, awaitingReply: null, broadcasts30d: null, unavailable: true } });
    render(<StewardView data={{ member: { initials: "SO" } }} api={api} onNotice={() => {}} />);
    expect(await screen.findByText("The desk counts could not load just now. Your lists below still work.")).toBeInTheDocument();
    const tiles = screen.getByRole("group", { name: "Committee desk summary" });
    expect(within(tiles).getAllByText("—")).toHaveLength(3);
    expect(within(tiles).getByText("38")).toBeInTheDocument();
    expect(screen.queryByText("Committee desk could not load.")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Acknowledge" }).length).toBeGreaterThan(0);
  });

  it("shows an inline error card instead of blanking when the desk read fails", async () => {
    const api = makeApi();
    api.loadDesk.mockRejectedValueOnce(new Error("Member roster: permission denied"));
    render(<StewardView data={{ member: { initials: "SO" } }} api={api} onNotice={() => {}} />);
    expect(await screen.findByText("Committee desk could not load.")).toBeInTheDocument();
    expect(screen.queryByText("Member roster: permission denied")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("reconciles shared action edits and chronological replies in the open conversation", async () => {
    const api = makeApi();
    api.messageAction = vi.fn(async (_kind, id, action, body) => action === "state"
      ? { canEdit: true, saved: false, reminders: [], reactions: [] }
      : action === "edit" ? { id, body, edited_at: "2026-09-07T00:00:00Z" }
      : { id: "reply-1", body, parent_message_id: id, created_at: "2026-09-07T00:00:00Z", sender_kind: "committee member", sender_name: "Sam" });
    render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={() => {}} />);
    fireEvent.click(await screen.findByText("They mandated me again last night."));
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Edit message" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Edit message" }), { target: { value: "Confirmed correction" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save edit" }));
    await within(dialog).findByText("Confirmed correction");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Reply", exact: true }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reply to message" }), { target: { value: "Confirmed threaded response" } });
    const composer = within(dialog).getByRole("textbox", { name: "Reply to message" }).closest(".thread-composer");
    fireEvent.click(within(composer).getByRole("button", { name: "Send reply" }));
    await within(dialog).findByText("Confirmed threaded response");
    expect(within(dialog).getByText("Confirmed correction")).toBeInTheDocument();
  });

  it("renders the forms review inbox and approves through the api", async () => {
    const api = makeApi();
    const onNotice = vi.fn();
    render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={onNotice} />);
    // The review inbox heading, in Union Ground's Committee vocabulary.
    const inboxTitle = t("en", "steward.formsInboxTitle");
    expect(inboxTitle).not.toMatch(/steward|grievance/i);
    expect(await screen.findByText(inboxTitle)).toBeInTheDocument();
    // The paged queues seed through an effect (UB-DESK-01), so rows land one
    // commit after the desk shell — the row button must be awaited.
    fireEvent.click(await screen.findByRole("button", { name: /Workplace issue report/ }));
    expect(screen.getByText("Mandated overtime without the 48-hour notice")).toBeInTheDocument();
    expect(await screen.findByText("Filer signature saved")).toBeInTheDocument();
    expect(screen.getByText("schedule.pdf")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Form approved — the worker has been notified"));
    expect(api.approveForm).toHaveBeenCalledWith("form-inbox-1", "", expect.objectContaining({ templateKey: "grievance", cosignerIds: [] }));
    expect(api.loadDesk).toHaveBeenCalledTimes(2);
  });

  //: the approval names what the dialog showed. When the filing changed
  // after the steward opened it (a resubmission, a co-signer joining or
  // withdrawing), nothing is approved and the approval is not retried. Tooling
  // The dialog closes rather than keep the old answers on screen;
  // the inbox is read again and reopening the form shows what is filed now.
  it("sends what the review showed and, when the filing changed, closes the review without approving", async () => {
    const api = makeApi();
    const onNotice = vi.fn();
    const resubmitted = { ...desk, formsInbox: [{ ...desk.formsInbox[0], answers: { ...desk.formsInbox[0].answers, summary: "Resubmitted after a return" } }, desk.formsInbox[1]] };
    api.loadDesk.mockResolvedValueOnce(desk).mockResolvedValue(resubmitted);
    api.approveForm.mockRejectedValueOnce(Object.assign(new Error("form changed since review"), { code: "PT409", details: "form_changed_since_review" }));
    render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={onNotice} />);
    fireEvent.click(await screen.findByRole("button", { name: /Workplace issue report/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("changed after you opened it")));
    expect(api.approveForm).toHaveBeenCalledTimes(1);
    expect(api.approveForm).toHaveBeenCalledWith("form-inbox-1", "", {
      templateKey: "grievance", answers: desk.formsInbox[0].answers, dataVersion: null, attachmentIds: ["att-1"], cosignerIds: [],
    });
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("Open it again from the inbox"));
    //  review P2-1: the dialog closes, so the notice says a typed note was not kept.
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("Your note was not saved."));
    expect(api.loadDesk.mock.calls.length).toBeGreaterThanOrEqual(2);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: /Workplace issue report/ }));
    expect(await screen.findByText("Resubmitted after a return")).toBeInTheDocument();
    expect(onNotice).not.toHaveBeenCalledWith("Form approved — the worker has been notified");
  });

  // The open form left the
  // loaded queue after the refusal's refresh (here: no longer on page one).
  // The dialog used to stay open from its cache with the old answers, and
  // every Approve was refused again. It now closes, so no old answers are
  // shown as current and no second approval goes out on them.
  it("closes the review when the form has left the loaded queue after a refusal, so Approve cannot repeat on old answers", async () => {
    const api = makeApi();
    const onNotice = vi.fn();
    const withoutIt = { ...desk, formsInbox: [desk.formsInbox[1]] };
    api.loadDesk.mockResolvedValueOnce(desk).mockResolvedValue(withoutIt);
    api.approveForm.mockRejectedValueOnce(Object.assign(new Error("form changed since review"), { code: "PT409", details: "form_changed_since_review" }));
    render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={onNotice} />);
    fireEvent.click(await screen.findByRole("button", { name: /Workplace issue report/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
    expect(screen.getByText(desk.formsInbox[0].answers.narrative)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("changed after you opened it")));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).toBeNull());
    expect(screen.queryByRole("button", { name: /Workplace issue report/ })).toBeNull();
    // The old answers are gone from the page, not only the Approve button.
    expect(screen.queryByText(desk.formsInbox[0].answers.narrative)).toBeNull();
    expect(api.approveForm).toHaveBeenCalledTimes(1);
  });

  // a review note, from the  review. (1) The notice says where a
  // form that is no longer listed may be. (2) The review hands focus back to
  // its inbox row; when the re-read drops that row, focus moves to the forms
  // inbox instead of falling to the page.
  describe("after a review closes and its row leaves the inbox", () => {
    const changed = () => Object.assign(new Error("form changed since review"), { code: "PT409", details: "form_changed_since_review" });
    const openFromRow = async () => {
      const row = await screen.findByRole("button", { name: /Workplace issue report/ });
      row.focus();
      fireEvent.click(row);
      await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
      return row;
    };

    // The inbox has Load more, not numbered pages, so
    // the notice names that control.
    it.each(["en", "es"])("says to use Load more or another filter when the form is not listed (%s)", (lang) => {
      const text = catalogue[lang]["steward.reviewChangedSinceRead"];
      expect(text).toContain(lang === "en" ? "if it is not listed, select Load more or try another filter" : "si no aparece en la lista, selecciona Cargar más o prueba otro filtro");
      expect(text).toContain(catalogue[lang]["steward.loadMore"]);
      expect(text).not.toMatch(/later page|página posterior/);
      expect(text).toContain(lang === "en" ? "Your note was not saved." : "Tu nota no se guardó.");
    });

    it("moves focus to the forms inbox when a refused approval's re-read drops the row", async () => {
      const api = makeApi();
      const onNotice = vi.fn();
      api.loadDesk.mockResolvedValueOnce(desk).mockResolvedValue({ ...desk, formsInbox: [desk.formsInbox[1]] });
      api.approveForm.mockRejectedValueOnce(changed());
      render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={onNotice} />);
      await openFromRow();
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      await waitFor(() => expect(onNotice).toHaveBeenCalledWith(catalogue.en["steward.reviewChangedSinceRead"]));
      await waitFor(() => expect(screen.queryByRole("button", { name: /Workplace issue report/ })).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(document.getElementById("steward-forms")));
    });

    it("moves focus to the forms inbox when an approved form leaves the list", async () => {
      const api = makeApi();
      const onNotice = vi.fn();
      api.loadDesk.mockResolvedValueOnce(desk).mockResolvedValue({ ...desk, formsInbox: [desk.formsInbox[1]] });
      render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={onNotice} />);
      await openFromRow();
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Form approved — the worker has been notified"));
      await waitFor(() => expect(screen.queryByRole("button", { name: /Workplace issue report/ })).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(document.getElementById("steward-forms")));
    });

    it("leaves focus on the row when the form is still listed after the re-read", async () => {
      const api = makeApi();
      const onNotice = vi.fn();
      const resubmitted = { ...desk, formsInbox: [{ ...desk.formsInbox[0], answers: { ...desk.formsInbox[0].answers, summary: "Resubmitted after a return" } }, desk.formsInbox[1]] };
      api.loadDesk.mockResolvedValueOnce(desk).mockResolvedValue(resubmitted);
      api.approveForm.mockRejectedValueOnce(changed());
      render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={onNotice} />);
      await openFromRow();
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      await waitFor(() => expect(onNotice).toHaveBeenCalledWith(catalogue.en["steward.reviewChangedSinceRead"]));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).toBeNull());
      const row = await screen.findByRole("button", { name: /Workplace issue report/ });
      await waitFor(() => expect(document.activeElement).toBe(row));
    });

    // A re-read that failed drops the pending move, so a
    // later re-read (here the error banner's Try again) does not move focus.
    it("drops the focus move when the re-read after the review fails", async () => {
      const api = makeApi();
      const onNotice = vi.fn();
      api.loadDesk.mockResolvedValueOnce(desk).mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ...desk, formsInbox: [desk.formsInbox[1]] });
      render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={onNotice} />);
      await openFromRow();
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      // The desk's own banner (each queue panel has its own Try again too).
      const banner = (await screen.findByText(catalogue.en["steward.deskLoadFailed"])).closest(".cwk-alert");
      const retry = within(banner).getByRole("button", { name: "Try again" });
      expect(screen.getByRole("button", { name: /Workplace issue report/ })).toBeInTheDocument();
      document.activeElement?.blur();
      fireEvent.click(retry);
      await waitFor(() => expect(screen.queryByRole("button", { name: /Workplace issue report/ })).toBeNull());
      await act(async () => { await Promise.resolve(); });
      expect(document.activeElement).toBe(document.body);
    });

    // Opening another review while a move waits drops
    // it, so the re-read landing later never pulls focus to the inbox. Ledger
    // 321a: focus leaves the new review's controls first (here: blurred to the
    // page), so the only thing that keeps the move from firing is that drop,
    // not the check that focus was lost.
    it("keeps focus in a review opened while a focus move waits", async () => {
      const api = makeApi();
      const onNotice = vi.fn();
      let finishReload;
      api.loadDesk.mockResolvedValueOnce(desk).mockImplementation(() => new Promise((resolve) => { finishReload = () => resolve({ ...desk, formsInbox: [desk.formsInbox[1]] }); }));
      render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={onNotice} />);
      await openFromRow();
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).toBeNull());
      await waitFor(() => expect(finishReload).toBeTypeOf("function"));
      fireEvent.click(screen.getByRole("button", { name: new RegExp(desk.formsInbox[1].memberName) }));
      const dialog = await screen.findByRole("dialog");
      await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
      document.activeElement.blur();
      await act(async () => { finishReload(); });
      await waitFor(() => expect(screen.queryByRole("button", { name: /Workplace issue report/ })).toBeNull());
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(document.activeElement).not.toBe(document.getElementById("steward-forms"));
      expect(document.activeElement).toBe(document.body);
    });

    // When the forms queue itself fails on the re-read, it
    // empties its rows; focus goes to the forms inbox, which shows the error
    // and its Try again, instead of staying on the page.
    it("moves focus to the forms inbox when the re-read marks the forms unavailable", async () => {
      const api = makeApi();
      const onNotice = vi.fn();
      api.loadDesk.mockResolvedValueOnce(desk).mockResolvedValue({ ...desk, formsInbox: [], formsUnavailable: true });
      render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={onNotice} />);
      await openFromRow();
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Form approved — the worker has been notified"));
      await waitFor(() => expect(screen.queryByRole("button", { name: /Workplace issue report/ })).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(document.getElementById("steward-forms")));
      expect(within(document.getElementById("steward-forms")).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    });

    // The section focus moves to is named by its title.
    it("names the forms inbox section by its title", async () => {
      render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={makeApi()} onNotice={vi.fn()} />);
      await screen.findByRole("button", { name: /Workplace issue report/ });
      expect(screen.getByRole("region", { name: "Committee review inbox" })).toBe(document.getElementById("steward-forms"));
    });

    it("does not take focus the steward has moved elsewhere", async () => {
      const api = makeApi();
      const onNotice = vi.fn();
      let finishReload;
      api.loadDesk.mockResolvedValueOnce(desk).mockImplementation(() => new Promise((resolve) => { finishReload = () => resolve({ ...desk, formsInbox: [desk.formsInbox[1]] }); }));
      render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={onNotice} />);
      await openFromRow();
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).toBeNull());
      await waitFor(() => expect(finishReload).toBeTypeOf("function"));
      const other = screen.getByRole("button", { name: new RegExp(desk.formsInbox[1].memberName) });
      other.focus();
      await act(async () => { finishReload(); });
      await waitFor(() => expect(screen.queryByRole("button", { name: /Workplace issue report/ })).toBeNull());
      expect(document.activeElement).toBe(other);
    });
  });

  //  round 1 (r2s1): Start review moves the form out of the Submitted
  // filter; the cached dialog stays open, and Approve & open issue must still
  // name the co-signers that dialog showed (none), so one who accepted since is
  // refused rather than approved unseen.

  it("explains why approval is blocked when the filer signature is missing", async () => {
    const api = makeApi();
    api.formFilingStatus.mockResolvedValue({ filerSigned: false, attachments: [] });
    render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Workplace issue report/ }));
    expect(await screen.findByText("The filer must save a signature for this exact version before you can approve it.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  // A SUBMITTED FORM'S ATTACHMENTS CAN OUTLIVE THEIR CLEAN VERDICT.
  //
  // The approval gate refuses while any attachment lacks a current inspection,
  // and the filer can no longer edit a submitted form — so the reviewer is the
  // only person left who can renew it. Without a re-check on this surface the
  // gate had no path out of it at all.
  it("names the stale attachments and renews them from the review dialog", async () => {
    const api = makeApi();
    const onNotice = vi.fn();
    api.formFilingStatus
      .mockResolvedValueOnce({
        filerSigned: true,
        attachments: [
          { id: "att-1", filename: "schedule.pdf", confirmedAt: "2026-08-12T12:00:00Z", scanCurrent: false },
          { id: "att-2", filename: "roster.pdf", confirmedAt: "2026-08-12T12:00:00Z", scanCurrent: true },
        ],
      })
      .mockResolvedValue({
        filerSigned: true,
        attachments: [
          { id: "att-1", filename: "schedule.pdf", confirmedAt: "2026-08-12T12:00:00Z", scanCurrent: true },
          { id: "att-2", filename: "roster.pdf", confirmedAt: "2026-08-12T12:00:00Z", scanCurrent: true },
        ],
      });
    api.recheckFormFile = vi.fn().mockResolvedValue({ fileId: "att-1", status: "clean" });

    render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={onNotice} />);
    fireEvent.click(await screen.findByRole("button", { name: /Workplace issue report/ }));

    // The refusal names the file, not "an attachment".
    const blocked = await screen.findByRole("alert");
    expect(blocked).toHaveTextContent("schedule.pdf");
    expect(blocked).not.toHaveTextContent("roster.pdf");
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();

    // Exactly one re-check button — the current attachment does not get one.
    const recheck = screen.getAllByRole("button", { name: "Re-check this file: schedule.pdf" });
    expect(recheck).toHaveLength(1);
    fireEvent.click(recheck[0]);

    await waitFor(() => expect(api.recheckFormFile).toHaveBeenCalledWith("att-1"));
    // The renewed status clears the gate in the same dialog.
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(api.approveForm).toHaveBeenCalledWith("form-inbox-1", "", expect.objectContaining({ templateKey: "grievance", cosignerIds: [] })));
  });

  it("names the stale attachments when the approval gate itself refuses", async () => {
    const api = makeApi();
    const onNotice = vi.fn();
    // The status read raced the verdict expiring, so the GATE — not the UI —
    // is the one that refuses, in one sentence about "an attachment". Re-reading
    // the status is what turns that into a file name and a re-check button.
    api.formFilingStatus
      .mockResolvedValueOnce({
        filerSigned: true,
        attachments: [{ id: "att-1", filename: "schedule.pdf", confirmedAt: "2026-08-12T12:00:00Z", scanCurrent: true }],
      })
      .mockResolvedValue({
        filerSigned: true,
        attachments: [{ id: "att-1", filename: "schedule.pdf", confirmedAt: "2026-08-12T12:00:00Z", scanCurrent: false }],
      });
    api.approveForm.mockRejectedValue(new Error("Form: form has an attachment without a current inspection"));
    api.recheckFormFile = vi.fn().mockResolvedValue({ fileId: "att-1", status: "clean" });

    render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={onNotice} />);
    fireEvent.click(await screen.findByRole("button", { name: /Workplace issue report/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(
      "These attachments need a fresh safety check before you can approve: schedule.pdf. Re-check each one above.",
    ));
    // The refreshed status also re-arms the affordance that clears the gate.
    expect(await screen.findByRole("button", { name: "Re-check this file: schedule.pdf" })).toBeInTheDocument();
  });

  it("scans a member's code without scoring either person", async () => {
    const api = makeApi();
    const onNotice = vi.fn();
    render(<StewardView data={{ member: { initials: "SO" }, events: scanEvents }} api={api} onNotice={onNotice} />);
    expect(await screen.findByText("Scan check-ins")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("7-character code"), { target: { value: "abc1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Check in worker" }));
    await waitFor(() => expect(api.scan).toHaveBeenCalledWith("evt-1", "abc1234"));
    // UB-EVT-05: the notice leads with WHO was checked in, because only a name
    // can surface a code redeemed against the wrong person. Attendance is a
    // service record, so no points are reported for either person.
    expect(onNotice).toHaveBeenCalledWith("Marisol Vega — Worker checked in.");
    expect(JSON.stringify(onNotice.mock.calls)).not.toMatch(/\+\d|points?/i);
  });

  it("surfaces the already-checked-in state without point language", async () => {
    const api = makeApi();
    api.scan.mockResolvedValueOnce({ memberUserId: "m-1", memberName: "Marisol Vega", checkedIn: true, alreadyCheckedIn: true, memberAwardedPoints: 0, scannerAwardedPoints: 0 });
    const onNotice = vi.fn();
    render(<StewardView data={{ member: { initials: "SO" }, events: scanEvents }} api={api} onNotice={onNotice} />);
    fireEvent.change(await screen.findByPlaceholderText("7-character code"), { target: { value: "abc1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Check in worker" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Marisol Vega — Worker was already checked in."));
    expect(JSON.stringify(onNotice.mock.calls)).not.toMatch(/\+\d|points?|capped/i);
  });

  it("scans a member QR with the rear camera, submits it once, and stops every track", async () => {
    const api = makeApi();
    const onNotice = vi.fn();
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
    const detect = vi.fn()
      .mockResolvedValueOnce([{ rawValue: "ABC1234" }])
      .mockResolvedValue([]);
    class BarcodeDetectorMock {
      static getSupportedFormats = vi.fn().mockResolvedValue(["qr_code"]);
      detect = detect;
    }
    vi.stubGlobal("BarcodeDetector", BarcodeDetectorMock);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();

    render(<StewardView data={{ member: { initials: "SO" }, events: scanEvents }} api={api} onNotice={onNotice} />);
    await startCamera();

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    }), { timeout: 3_000 });
    await waitFor(() => expect(api.scan).toHaveBeenCalledWith("evt-1", "ABC1234"), { timeout: 3_000 });
    expect(api.scan).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Stop the camera" })).not.toBeInTheDocument();
  });

  it("keeps manual entry available and stops the camera on explicit stop and unmount", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
    class BarcodeDetectorMock {
      static getSupportedFormats = vi.fn().mockResolvedValue(["qr_code"]);
      detect = vi.fn().mockResolvedValue([]);
    }
    vi.stubGlobal("BarcodeDetector", BarcodeDetectorMock);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();

    const view = render(<StewardView data={{ member: { initials: "SO" }, events: scanEvents }} api={makeApi()} onNotice={() => {}} />);
    expect(await screen.findByPlaceholderText("7-character code")).toBeInTheDocument();
    await startCamera();
    expect(await screen.findByRole("button", { name: "Stop the camera" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop the camera" }));
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1), { timeout: 3_000 });

    await startCamera();
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    view.unmount();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("explains unsupported camera scanning without removing the manual form", async () => {
    vi.stubGlobal("BarcodeDetector", undefined);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    render(<StewardView data={{ member: { initials: "SO" }, events: scanEvents }} api={makeApi()} onNotice={() => {}} />);
    expect(await screen.findByText("This browser cannot scan with the camera. Type the code instead.")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("7-character code")).toBeInTheDocument();
  });

  it("stops an acquired stream and keeps manual entry when camera startup is refused", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
    class BarcodeDetectorMock {
      static getSupportedFormats = vi.fn().mockResolvedValue(["qr_code"]);
      detect = vi.fn().mockResolvedValue([]);
    }
    vi.stubGlobal("BarcodeDetector", BarcodeDetectorMock);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(new DOMException("denied", "NotAllowedError"));

    render(<StewardView data={{ member: { initials: "SO" }, events: scanEvents }} api={makeApi()} onNotice={() => {}} />);
    await startCamera();
    expect(await screen.findByText("Camera access was refused. Type the code instead.")).toBeInTheDocument();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.getByPlaceholderText("7-character code")).toBeInTheDocument();
  });

  it.each([
    ["SecurityError", "Camera access was refused. Type the code instead."],
    ["NotFoundError", "No usable camera was found. Type the code instead."],
    ["NotReadableError", "No usable camera was found. Type the code instead."],
    ["OverconstrainedError", "No usable camera was found. Type the code instead."],
    ["AbortError", "The camera could not start. Type the code instead."],
  ])("names the camera start failure %s without blaming permission unless it was refused", async (name, message) => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException("start failed", name));
    class BarcodeDetectorMock {
      static getSupportedFormats = vi.fn().mockResolvedValue(["qr_code"]);
      detect = vi.fn().mockResolvedValue([]);
    }
    vi.stubGlobal("BarcodeDetector", BarcodeDetectorMock);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });

    render(<StewardView data={{ member: { initials: "SO" }, events: scanEvents }} api={makeApi()} onNotice={() => {}} />);
    await startCamera();
    expect(await screen.findByText(message)).toBeInTheDocument();
    if (name !== "SecurityError") {
      expect(screen.queryByText("Camera access was refused. Type the code instead.")).not.toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Use the camera" })).toBeEnabled();
    expect(screen.getByPlaceholderText("7-character code")).toBeInTheDocument();
  });

  it("says the camera is starting while the permission prompt is open", async () => {
    let resolveStream;
    const getUserMedia = vi.fn(() => new Promise((resolve) => { resolveStream = resolve; }));
    class BarcodeDetectorMock {
      static getSupportedFormats = vi.fn().mockResolvedValue(["qr_code"]);
      detect = vi.fn().mockResolvedValue([]);
    }
    vi.stubGlobal("BarcodeDetector", BarcodeDetectorMock);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();

    render(<StewardView data={{ member: { initials: "SO" }, events: scanEvents }} api={makeApi()} onNotice={() => {}} />);
    await startCamera();
    const pending = await screen.findByRole("button", { name: "Starting the camera…" });
    // It stays focusable and refuses a second start while the
    // permission prompt is open.
    expect(pending).toHaveAttribute("aria-disabled", "true");
    expect(pending).toBeEnabled();
    fireEvent.click(pending);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Use the camera" })).not.toBeInTheDocument();
    resolveStream({ getTracks: () => [{ stop: vi.fn() }] });
    expect(await screen.findByRole("button", { name: "Stop the camera" })).toBeInTheDocument();
  });

  it("explains an unrelated QR code and submits a later valid check-in code only once", async () => {
    const api = makeApi();
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
    const detect = vi.fn()
      .mockResolvedValue([{ rawValue: "ABCI234" }]);
    class BarcodeDetectorMock {
      static getSupportedFormats = vi.fn().mockResolvedValue(["qr_code"]);
      detect = detect;
    }
    vi.stubGlobal("BarcodeDetector", BarcodeDetectorMock);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();

    render(<StewardView data={{ member: { initials: "SO" }, events: scanEvents }} api={api} onNotice={() => {}} />);
    await startCamera();
    const message = "That code is not a check-in code. Ask the worker to open their check-in code in the app.";
    expect(await screen.findByText(message)).toHaveAttribute("role", "status");
    expect(api.scan).not.toHaveBeenCalled();
    await waitFor(() => expect(detect.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3_000 });
    expect(screen.getAllByText(message)).toHaveLength(1);
    detect.mockResolvedValue([{ rawValue: "0101010" }, { rawValue: "Z9Y8X7W" }]);
    await waitFor(() => expect(api.scan).toHaveBeenCalledWith("evt-1", "0101010"), { timeout: 3_000 });
    expect(api.scan).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  });

  it("stops the active camera when the steward changes the selected event", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
    class BarcodeDetectorMock {
      static getSupportedFormats = vi.fn().mockResolvedValue(["qr_code"]);
      detect = vi.fn().mockResolvedValue([]);
    }
    vi.stubGlobal("BarcodeDetector", BarcodeDetectorMock);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();

    render(<StewardView data={{ member: { initials: "SO" }, events: scanEvents }} api={makeApi()} onNotice={() => {}} />);
    await startCamera();
    expect(await screen.findByRole("button", { name: "Stop the camera" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Meeting"), { target: { value: "evt-2" } });
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    expect(screen.queryByRole("button", { name: "Stop the camera" })).not.toBeInTheDocument();
  });

  it("invalidates a deferred camera grant when the steward changes events", async () => {
    const api = makeApi();
    const stop = vi.fn();
    let resolveStream;
    const getUserMedia = vi.fn(() => new Promise((resolve) => { resolveStream = resolve; }));
    const detect = vi.fn().mockResolvedValue([{ rawValue: "ABC1234" }]);
    class BarcodeDetectorMock {
      static getSupportedFormats = vi.fn().mockResolvedValue(["qr_code"]);
      detect = detect;
    }
    vi.stubGlobal("BarcodeDetector", BarcodeDetectorMock);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();

    render(<StewardView data={{ member: { initials: "SO" }, events: scanEvents }} api={api} onNotice={() => {}} />);
    await startCamera();
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    fireEvent.change(screen.getByLabelText("Meeting"), { target: { value: "evt-2" } });
    resolveStream({ getTracks: () => [{ stop }] });

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    expect(play).not.toHaveBeenCalled();
    expect(detect).not.toHaveBeenCalled();
    expect(api.scan).not.toHaveBeenCalled();
  });

  it("invalidates deferred playback when manual submission stops the camera", async () => {
    const api = makeApi();
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
    let resolvePlay;
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => new Promise((resolve) => { resolvePlay = resolve; }));
    const detect = vi.fn().mockResolvedValue([{ rawValue: "ABC1234" }]);
    class BarcodeDetectorMock {
      static getSupportedFormats = vi.fn().mockResolvedValue(["qr_code"]);
      detect = detect;
    }
    vi.stubGlobal("BarcodeDetector", BarcodeDetectorMock);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });

    render(<StewardView data={{ member: { initials: "SO" }, events: scanEvents }} api={api} onNotice={() => {}} />);
    await startCamera();
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    fireEvent.change(screen.getByPlaceholderText("7-character code"), { target: { value: "ABC1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Check in worker" }));
    await waitFor(() => expect(api.scan).toHaveBeenCalledWith("evt-1", "ABC1234"), { timeout: 3_000 });
    resolvePlay();

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    expect(detect).not.toHaveBeenCalled();
    expect(api.scan).toHaveBeenCalledTimes(1);
  });

  it("invalidates a deferred detector result when the steward stops scanning", async () => {
    const api = makeApi();
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
    let resolveDetect;
    const detect = vi.fn(() => new Promise((resolve) => { resolveDetect = resolve; }));
    class BarcodeDetectorMock {
      static getSupportedFormats = vi.fn().mockResolvedValue(["qr_code"]);
      detect = detect;
    }
    vi.stubGlobal("BarcodeDetector", BarcodeDetectorMock);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();

    render(<StewardView data={{ member: { initials: "SO" }, events: scanEvents }} api={api} onNotice={() => {}} />);
    await startCamera();
    fireEvent.click(await screen.findByRole("button", { name: "Stop the camera" }));
    await waitFor(() => expect(detect).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    resolveDetect([{ rawValue: "ABC1234" }]);

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    expect(api.scan).not.toHaveBeenCalled();
  });

  it("shows the scanner's empty state when no events are on the calendar", async () => {
    render(<StewardView data={{ member: { initials: "SO" } }} api={makeApi()} onNotice={() => {}} />);
    expect(await screen.findByText("No upcoming meetings right now — scanning opens when a meeting is on the calendar.")).toBeInTheDocument();
  });

  it("keeps completed event history out of the check-in picker", async () => {
    render(
      <StewardView
        data={{
          member: { initials: "SO" },
          events: [
            ...scanEvents,
            { id: "evt-history", title: "Summer member meeting", dateLabel: "Thu, Jul 30", isPast: true },
          ],
        }}
        api={makeApi()}
        onNotice={() => {}}
      />,
    );

    const picker = await screen.findByRole("combobox", { name: "Meeting" });
    expect(within(picker).getByRole("option", { name: "Chapter meeting · Thu, Jul 30" })).toBeInTheDocument();
    expect(within(picker).queryByRole("option", { name: /Summer member meeting/ })).toBeNull();
  });

  // Regression (L17): the busy guard used to be a single string, so a second
  // action overwrote the first key and whichever call settled first cleared it
  // — re-enabling a button whose write was still in flight. Acknowledge req-1
  // and close req-2 concurrently, then settle only the FIRST: the second must
  // still read as busy.
  it("tracks each in-flight action under its own busy key", async () => {
    const api = makeApi();
    const settle = [];
    api.triage.mockImplementation(() => new Promise((resolve) => { settle.push(resolve); }));
    render(<StewardView data={{ member: { initials: "SO" } }} api={api} onNotice={() => {}} />);

    const acknowledge = await screen.findByRole("button", { name: "Acknowledge" });
    // req-1 is "requested" (Acknowledge + Close); req-2 is "acknowledged" (Close only).
    const closeButtons = screen.getAllByRole("button", { name: "Close" });
    fireEvent.click(acknowledge);
    fireEvent.click(closeButtons[1]);
    await confirmClose();
    await waitFor(() => expect(api.triage).toHaveBeenCalledTimes(2));
    // Pending, not natively disabled, so focus stays on them.
    await waitFor(() => expect(closeButtons[1]).toHaveAttribute("aria-disabled", "true"));
    expect(acknowledge).toHaveAttribute("aria-disabled", "true");

    // Only the acknowledge call resolves. The close is untouched by it.
    settle[0]({});
    await waitFor(() => expect(acknowledge).not.toHaveAttribute("aria-disabled"));
    expect(screen.getAllByRole("button", { name: "Close" })[1]).toHaveAttribute("aria-disabled", "true");
  });

  it("keeps Return disabled until a note is entered, then returns with it", async () => {
    const api = makeApi();
    render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Workplace issue report/ }));
    const returnButton = screen.getByRole("button", { name: "Return with note" });
    expect(returnButton).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("What needs to change before this is ready…"), { target: { value: "Add the incident date" } });
    expect(returnButton).not.toBeDisabled();
    fireEvent.click(returnButton);
    await waitFor(() => expect(api.returnForm).toHaveBeenCalledWith("form-inbox-1", "Add the incident date"));
  });
});

// BUG-UG-FORMS-REVIEW-LATE-REPLY-CLOSES-ANOTHER-MEMBERS-REVIEW-20261119
//: the review dialog can be closed while its action runs. When the
// steward has opened another member's form and is writing a note there, the
// first form's late reply must not close that review or lose its note; the
// inbox is still read again so the first form shows its new status.
describe("a late reply to one member's form review (#9200)", () => {
  const notePlaceholder = "What needs to change before this is ready…";
  const changed = () => Object.assign(new Error("form changed since review"), { code: "PT409", details: "form_changed_since_review" });

  async function returnJordanThenOpenAva(api, onNotice) {
    render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={onNotice} />);
    fireEvent.click(await screen.findByRole("button", { name: /Workplace issue report/ }));
    fireEvent.change(screen.getByPlaceholderText(notePlaceholder), { target: { value: "Add the incident date" } });
    fireEvent.click(screen.getByRole("button", { name: "Return with note" }));
    await waitFor(() => expect(api.returnForm).toHaveBeenCalledWith("form-inbox-1", "Add the incident date"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: catalogue.en["dialogs.close"] }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: new RegExp(desk.formsInbox[1].memberName) }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(desk.formsInbox[1].memberName);
    fireEvent.change(within(dialog).getByPlaceholderText(notePlaceholder), { target: { value: "Note for Ava" } });
    expect(api.loadDesk).toHaveBeenCalledTimes(1);
    return dialog;
  }

  it("leaves the open review and its note alone when the first form's return succeeds late, and reads the inbox again", async () => {
    const api = makeApi();
    const onNotice = vi.fn();
    let settle;
    api.returnForm.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    const dialog = await returnJordanThenOpenAva(api, onNotice);
    await act(async () => { settle({}); });
    await waitFor(() => expect(api.loadDesk).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(catalogue.en["steward.reviewReturned"]));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(dialog).toHaveTextContent(desk.formsInbox[1].memberName);
    expect(within(dialog).getByPlaceholderText(notePlaceholder)).toHaveValue("Note for Ava");
  });

  it("leaves the open review and its note alone when the first form's refusal (changed since review) lands late", async () => {
    const api = makeApi();
    const onNotice = vi.fn();
    let refuse;
    api.returnForm.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject; }));
    const dialog = await returnJordanThenOpenAva(api, onNotice);
    await act(async () => { refuse(changed()); });
    await waitFor(() => expect(api.loadDesk.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(catalogue.en["steward.reviewChangedSinceRead"]));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(dialog).toHaveTextContent(desk.formsInbox[1].memberName);
    expect(within(dialog).getByPlaceholderText(notePlaceholder)).toHaveValue("Note for Ava");
  });

  it("still closes the review when its own return succeeds", async () => {
    const api = makeApi();
    const onNotice = vi.fn();
    render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={onNotice} />);
    fireEvent.click(await screen.findByRole("button", { name: /Workplace issue report/ }));
    fireEvent.change(screen.getByPlaceholderText(notePlaceholder), { target: { value: "Add the incident date" } });
    fireEvent.click(screen.getByRole("button", { name: "Return with note" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(catalogue.en["steward.reviewReturned"]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.loadDesk).toHaveBeenCalledTimes(2);
  });
});

// BUG-UG-FORMS-REVIEW-LATE-FILING-STATUS-DISABLES-ANOTHER-MEMBERS-APPROVE-20261119
//: a filing-status read for one member's
// form that finishes after the steward moved to another member's review
// leaves that review's filing status, Approve and note alone. A read for the
// form that is still open updates it as before (the re-check and stale-file
// tests above).
describe("a late filing-status read for one member's form (#9213)", () => {
  const notePlaceholder = "What needs to change before this is ready…";
  const current = { filerSigned: true, attachments: [{ id: "att-1", filename: "schedule.pdf", confirmedAt: "2026-08-12T12:00:00Z", scanCurrent: true }] };
  const stale = { filerSigned: true, attachments: [{ id: "att-1", filename: "schedule.pdf", confirmedAt: "2026-08-12T12:00:00Z", scanCurrent: false }] };
  const avaStatus = { filerSigned: true, attachments: [{ id: "att-9", filename: "letter.pdf", confirmedAt: "2026-08-12T12:00:00Z", scanCurrent: true }] };

  async function closeAndOpenAva() {
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: catalogue.en["dialogs.close"] }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: new RegExp(desk.formsInbox[1].memberName) }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(desk.formsInbox[1].memberName);
    fireEvent.change(within(dialog).getByPlaceholderText(notePlaceholder), { target: { value: "Note for Ava" } });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Approve" })).toBeEnabled());
    return dialog;
  }

  function expectAvaUntouched(dialog) {
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(dialog).toHaveTextContent(desk.formsInbox[1].memberName);
    expect(within(dialog).getByPlaceholderText(notePlaceholder)).toHaveValue("Note for Ava");
    expect(within(dialog).getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(within(dialog).queryByRole("button", { name: /Re-check this file/ })).toBeNull();
  }

  it("keeps Ava's Approve when Jordan's approval is refused late for an attachment that needs a current inspection", async () => {
    const api = makeApi();
    const onNotice = vi.fn();
    let jordanReads = 0;
    api.formFilingStatus.mockImplementation(async (id) => (id === "form-inbox-1" ? (jordanReads++ === 0 ? current : stale) : avaStatus));
    let refuse;
    api.approveForm.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject; }));
    render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={onNotice} />);
    fireEvent.click(await screen.findByRole("button", { name: /Workplace issue report/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(api.approveForm).toHaveBeenCalledTimes(1));
    const dialog = await closeAndOpenAva();
    await act(async () => { refuse(new Error("Form: form has an attachment without a current inspection")); });
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(
      "These attachments need a fresh safety check before you can approve: schedule.pdf. Re-check each one above.",
    ));
    expect(api.formFilingStatus).toHaveBeenCalledWith("form-inbox-1");
    expectAvaUntouched(dialog);
  });

  it("keeps Ava's Approve when Jordan's attachment re-check finishes after Ava's review was opened", async () => {
    const api = makeApi();
    const onNotice = vi.fn();
    let jordanReads = 0;
    api.formFilingStatus.mockImplementation(async (id) => (id === "form-inbox-1" ? (jordanReads++ === 0 ? stale : current) : avaStatus));
    let finishRecheck;
    api.recheckFormFile = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finishRecheck = resolve; }));
    render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={onNotice} />);
    fireEvent.click(await screen.findByRole("button", { name: /Workplace issue report/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Re-check this file: schedule.pdf" }));
    await waitFor(() => expect(api.recheckFormFile).toHaveBeenCalledWith("att-1"));
    const dialog = await closeAndOpenAva();
    await act(async () => { finishRecheck({ fileId: "att-1", status: "clean" }); });
    await waitFor(() => expect(jordanReads).toBe(2));
    expectAvaUntouched(dialog);
  });
});

// REQ-UG-DORMANT-62-ADMIN-MFA-RESET-LEGAL-HOLD-20260917: the preservation
// order marker on the desk and in the thread dialog. Only a server-confirmed
// `true` renders the chip; an unknown status (no read, failed read) must not
// read as "not held". Place/release render only when the server says the
// caller can manage — never from a client-side role guess.
describe("conversation legal hold on the steward desk", () => {
  function heldDesk(legalHold) {
    return { ...desk, threads: desk.threads.map((row) => ({ ...row, legalHold })) };
  }

  it("marks a held conversation on its row and in the dialog, and hides the controls from a steward", async () => {
    const api = makeApi();
    api.loadDesk = vi.fn().mockResolvedValue(heldDesk(true));
    api.loadLegalHold = vi.fn().mockResolvedValue({ held: true, reasonCode: null, placedAt: null, canManage: false });
    render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={() => {}} />);
    const row = (await screen.findByText("They mandated me again last night.")).closest("button");
    expect(within(row).getByText("Legal hold")).toBeInTheDocument();
    fireEvent.click(row);
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    const marker = await within(dialog).findByTestId("legal-hold-marker");
    expect(marker).toHaveTextContent("Under legal hold");
    // A steward sees the order, never the reason, and gets no button.
    expect(marker).not.toHaveTextContent("Arbitration");
    expect(within(dialog).queryByRole("button", { name: /legal hold/i })).not.toBeInTheDocument();
    expect(api.loadLegalHold).toHaveBeenCalledWith("conv-1");
  });

  it("renders no chip for an unknown status and no marker or controls for an api double without the read", async () => {
    const api = makeApi();
    api.loadDesk = vi.fn().mockResolvedValue(heldDesk(null));
    render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={() => {}} />);
    const row = (await screen.findByText("They mandated me again last night.")).closest("button");
    expect(within(row).queryByText("Legal hold")).not.toBeInTheDocument();
    fireEvent.click(row);
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    await within(dialog).findByPlaceholderText("Reply as Committee…");
    expect(within(dialog).queryByTestId("legal-hold-marker")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /legal hold/i })).not.toBeInTheDocument();
  });

  it("lets an organization admin place a hold from the dialog and reflects it on the row at once", async () => {
    const api = makeApi();
    let status = { held: false, reasonCode: null, placedAt: null, canManage: true };
    api.loadDesk = vi.fn().mockResolvedValue(heldDesk(false));
    api.loadLegalHold = vi.fn(async () => status);
    api.placeLegalHold = vi.fn(async (_, reasonCode) => { status = { ...status, held: true, reasonCode, placedAt: "2026-09-17T12:00:00Z" }; return { held: true, reasonCode }; });
    const onNotice = vi.fn();
    render(<StewardView data={{ member: { id: "admin-1", initials: "AR" }, roles: ["admin"] }} api={api} onNotice={onNotice} />);
    const row = (await screen.findByText("They mandated me again last night.")).closest("button");
    expect(within(row).queryByText("Legal hold")).not.toBeInTheDocument();
    fireEvent.click(row);
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Place legal hold" }));
    // Nothing is sent until the reason is confirmed.
    expect(api.placeLegalHold).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Reason for the hold" }), { target: { value: "agency_charge" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Place hold" }));
    await waitFor(() => expect(api.placeLegalHold).toHaveBeenCalledWith("conv-1", "agency_charge"));
    expect(onNotice).toHaveBeenCalledWith("Legal hold placed — this conversation is now preserved.");
    expect(await within(dialog).findByTestId("legal-hold-marker")).toHaveTextContent("Agency charge");
    // The list row behind the dialog carries the chip without a desk reload.
    expect(within(row).getByText("Legal hold")).toBeInTheDocument();
    expect(await within(dialog).findByRole("button", { name: "Release legal hold" })).toBeInTheDocument();
  });
});

const caseWriteRow = {
  id: "case-1",
  subjectUserId: "member-1",
  reference: "GRV-1",
  title: "Schedule case",
  memberName: "Proof member",
  memberInitials: "PM",
  status: "active",
  step: "Intake",
  caseType: "Scheduling",
  updates: [],
  updatesTotal: 0,
};

const caseWriteDesk = {
  caseload: [caseWriteRow],
  queue: [],
  threads: [],
  broadcasts: [],
  formsInbox: [],
  formTemplateVersions: [],
  kpis: {},
};

const caseWritePayload = {
  scope: {
    id: "case-1",
    organization_id: "org-1",
    chapter_id: "ch-1",
    step: "Intake",
    status: "active",
    is_restricted: false,
  },
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

const accessActor = {
  userId: "steward-sam",
  selectedOrganizationId: "org-1",
  roles: ["steward"],
  membershipStatus: "active",
};

describe("steward plane case writes record access history", () => {
  it("records updated_case when a steward saves a case-tools write", async () => {
    const api = {
      ...makeApi(),
      loadDesk: vi.fn().mockResolvedValue(caseWriteDesk),
      recordAccess: vi.fn().mockResolvedValue({ ok: true }),
      loadCaseworkCase: vi.fn().mockResolvedValue(caseWritePayload),
      createCaseDeadline: vi.fn().mockResolvedValue({}),
      scoreCase: vi.fn(),
      setCaseRestriction: vi.fn(),
      requestDeadlineExtension: vi.fn(),
      decideDeadlineExtension: vi.fn(),
      advanceCaseStep: vi.fn(),
      createCaseAlert: vi.fn(),
      acknowledgeCaseAlert: vi.fn(),
      createCaseReminder: vi.fn(),
      setReminderStatus: vi.fn(),
      setChecklistItem: vi.fn(),
      logManagementBehavior: vi.fn(),
      addManagementAddendum: vi.fn(),
      linkCases: vi.fn(),
    };
    render(
      <StewardView
        data={{ member: { initials: "SO" } }}
        accessActor={accessActor}
        api={api}
        onNotice={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /GRV-1/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Issue tools")).toBeInTheDocument();
    await waitFor(() => expect(api.recordAccess).toHaveBeenCalledWith(accessActor, expect.objectContaining({
      action: "viewed_case",
      entityId: "case-1",
    })));

    const deadline = within(dialog).getByRole("heading", { name: "Deadline center" }).closest("article");
    fireEvent.change(within(deadline).getByLabelText("Deadline label"), { target: { value: "Arbitration filing" } });
    fireEvent.change(within(deadline).getByLabelText("Due date and time"), { target: { value: "2026-09-10T12:00" } });
    fireEvent.click(within(deadline).getByRole("button", { name: "Add deadline" }));

    await waitFor(() => expect(api.createCaseDeadline).toHaveBeenCalled());
    await waitFor(() => expect(api.recordAccess).toHaveBeenCalledWith(accessActor, {
      subjectUserId: "member-1",
      action: "updated_case",
      entityType: "case",
      entityId: "case-1",
    }));
  });

  it("opens a case without waiting when the desk has no access-logging adapter", async () => {
    const api = {
      ...makeApi(),
      loadDesk: vi.fn().mockResolvedValue(caseWriteDesk),
      loadCaseworkCase: vi.fn().mockResolvedValue(caseWritePayload),
    };
    expect(api.recordAccess).toBeUndefined();
    render(<StewardView data={{ member: { initials: "SO" } }} api={api} onNotice={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /GRV-1/ }));
    expect(await screen.findByRole("dialog", { name: /GRV-1/ })).toBeInTheDocument();
  });
});

// The case facts are read-only and the steward's writes live in the case
// tools below them; the desk also carries the steward's private reminders.
// Union Ground issues have no grievance procedure (owner decision,
// 2026-10-13), so the facts offer no step or article and no step editor.
describe("steward desk case controls entry and private reminders", () => {
  it("offers no step facts or step editor while case tools load, fail, and recover", async () => {
    let rejectRead, resolveRetry;
    const read = new Promise((resolve, reject) => { rejectRead = reject; });
    const retry = new Promise((resolve) => { resolveRetry = resolve; });
    const api = {
      ...makeApi(),
      loadDesk: vi.fn().mockResolvedValue({ ...caseWriteDesk, caseload: [{ ...caseWriteRow, articles: "Art. 12" }] }),
      loadCaseworkCase: vi.fn().mockReturnValueOnce(read).mockReturnValueOnce(retry),
    };
    render(<StewardView data={{ member: {} }} api={api} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /GRV-1/ }));
    const dialog = await screen.findByRole("dialog");
    const facts = dialog.querySelector(".detail-facts");
    expect(within(facts).getByText("Scheduling")).toBeInTheDocument();
    // A step or contract article carried on the row never becomes a fact.
    expect(within(facts).queryByText("Intake")).toBeNull();
    expect(within(facts).queryByText("Art. 12")).toBeNull();
    expect(within(facts).queryByText(/^(Step|Articles)$/)).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Change step or add a deadline" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /change step/i })).toBeNull();
    await act(async () => rejectRead(new Error("offline")));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Try again" }));
    await act(async () => resolveRetry(caseWritePayload));
    const deadline = (await within(dialog).findByRole("heading", { name: "Deadline center" })).closest("article");
    expect(within(dialog).queryByRole("heading", { name: "Step progression" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /change step/i })).toBeNull();
    // Deadline kinds are response and follow-up only.
    expect([...deadline.querySelectorAll('select[name="kind"] option')].map((option) => option.value)).toEqual(["response", "follow_up"]);
  });

  it.each([true, false])("reads back a committed rename after access recording returns ok=%s", async (ok) => {
    const title = "Overtime denial";
    let currentDesk = caseWriteDesk;
    let currentCase = { ...caseWritePayload, scope: { ...caseWritePayload.scope, title: caseWriteRow.title } };
    const api = {
      ...makeApi(),
      loadDesk: vi.fn(async () => currentDesk),
      recordAccess: vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValue({ ok }),
      loadCaseworkCase: vi.fn(async () => currentCase),
      renameCase: vi.fn(async () => {
        currentDesk = { ...caseWriteDesk, caseload: [{ ...caseWriteRow, title }] };
        currentCase = { ...currentCase, scope: { ...currentCase.scope, title } };
        return { changed: true };
      }),
      listPrivateReminders: vi.fn().mockResolvedValue([{ id: "r-1", title: "Filing window closes", remindOn: "2026-10-16", caseId: null, caseReference: null }]),
    };
    render(<StewardView data={{ member: {} }} accessActor={accessActor} api={api} onNotice={vi.fn()} />);
    await screen.findByRole("option", { name: "GRV-1 · Schedule case" });
    fireEvent.click(await screen.findByRole("button", { name: /GRV-1/ }));
    const dialog = await screen.findByRole("dialog");
    const section = (await within(dialog).findByRole("heading", { name: "Issue title" })).closest("article");
    fireEvent.change(within(section).getByLabelText("New title"), { target: { value: title } });
    fireEvent.click(within(section).getByRole("button", { name: "Rename issue" }));
    expect(await within(dialog).findByRole("heading", { name: `GRV-1 — ${title}` })).toBeInTheDocument();
    await waitFor(() => expect(api.loadCaseworkCase).toHaveBeenCalledTimes(2));
    expect(await within(section).findByText(title)).toBeInTheDocument();
    expect(api.recordAccess).toHaveBeenLastCalledWith(accessActor, {
      subjectUserId: "member-1", action: "updated_case", entityType: "case", entityId: "case-1",
    });
    expect(api.recordAccess.mock.invocationCallOrder[1]).toBeLessThan(api.loadDesk.mock.invocationCallOrder[1]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /GRV-1.*Overtime denial/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: `GRV-1 · ${title}` })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "GRV-1 · Schedule case" })).toBeNull();
  });

  it("lists private reminders on the desk and opens a case with no step editor", async () => {
    const api = {
      ...makeApi(),
      loadDesk: vi.fn().mockResolvedValue(caseWriteDesk),
      recordAccess: vi.fn().mockResolvedValue({ ok: true }),
      loadCaseworkCase: vi.fn().mockResolvedValue(caseWritePayload),
      listPrivateReminders: vi.fn().mockResolvedValue([{ id: "r-1", title: "Filing window closes", remindOn: "2026-10-16", caseId: null, caseReference: null }]),
      savePrivateReminder: vi.fn(),
      attachPrivateReminder: vi.fn(),
      deletePrivateReminder: vi.fn(),
    };
    render(<StewardView data={{ member: { initials: "SO" } }} accessActor={accessActor} api={api} onNotice={() => {}} />);
    expect(await screen.findByText("Filing window closes")).toBeInTheDocument();
    expect(screen.getByText("My private reminders")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /GRV-1/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("heading", { name: "Deadline center" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("heading", { name: "Step progression" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Change step or add a deadline" })).toBeNull();
    expect(dialog.querySelector('[id^="casework-step-"]')).toBeNull();
  });
});

// UX-UG-WORDING-AND-SPANISH-GAPS-FROM-REVIEWS-20261117 (
// 386, from the  review): a function-missing answer to Approve used to
// reach the steward as the driver's English ("Approve form: Could not find the
// function ..."). It now reads as the shared service-busy sentence; the note
// typed stays and the approval is sent once.
describe("form approval refused because the function is missing", () => {
  it.each(["PGRST202", "42883"])("shows the service-busy sentence, never the driver text, for %s", async (code) => {
    const { approveForm } = await import("../src/lib/memberApi.js");
    const rpc = vi.fn().mockResolvedValueOnce({ data: null, error: { code, message: "Could not find the function public.approve_form" }, status: 404 })
      .mockResolvedValue({ data: { status: "approved" }, error: null });
    const api = makeApi();
    api.approveForm = vi.fn((...args) => approveForm({ rpc }, ...args));
    const onNotice = vi.fn();
    render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={onNotice} />);
    fireEvent.click(await screen.findByRole("button", { name: /Workplace issue report/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My review note" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalled());
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox")).toHaveValue("My review note");
    expect(onNotice).toHaveBeenCalledWith(catalogue.en["error.serviceBusy"]);
    expect(onNotice.mock.calls.flat().join(" ")).not.toMatch(/Could not find the function/);
  });
});

// Each steward desk control that starts a write stays focusable
// as a pending control while that write runs, refuses a second activation,
// and its write takes a synchronous lock. Each test turns the browser's focus
// fixup on (expectHeldWriteFocus, expectPendingFocus).
describe("steward desk controls keep focus while their own writes run", () => {
  const openThread = async (api, props = {}) => {
    render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={() => {}} {...props} />);
    fireEvent.click(await screen.findByText("They mandated me again last night."));
    return screen.findByRole("dialog", { name: "Renata Cole" });
  };

  it("keeps an email intake action focused, and lets one tick review the row once", async () => {
    const api = makeApi();
    api.listEmailIntakes = vi.fn().mockResolvedValue([{
      id: "email-1", status: "reviewing", subject: "Member follow-up", from: "member@example.test",
      text: "Please contact me.", receivedAt: "2026-08-13T12:00:00Z",
    }]);
    api.reviewEmailIntake = vi.fn().mockResolvedValue({ updated: true });
    render(<StewardView data={{ member: { initials: "SO" } }} api={api} onNotice={() => {}} />);
    const accept = await screen.findByRole("button", { name: "Accept" });
    const reject = screen.getByRole("button", { name: "Reject" });
    await expectOneWriteFromOneTick(api.reviewEmailIntake, [() => fireEvent.click(accept), () => fireEvent.click(reject)]);
    await waitFor(() => expect(accept).not.toHaveAttribute("aria-disabled"));
    await expectHeldWriteFocus(api.reviewEmailIntake, accept);
    expect(api.reviewEmailIntake).toHaveBeenLastCalledWith("email-1", "accept");
  });

  it("keeps Acknowledge focused while its triage runs", async () => {
    const api = makeApi();
    render(<StewardView data={{ member: { initials: "SO" } }} api={api} onNotice={() => {}} />);
    const acknowledge = await screen.findByRole("button", { name: "Acknowledge" });
    await expectHeldWriteFocus(api.triage, acknowledge);
    expect(api.triage).toHaveBeenCalledWith("req-1", "acknowledge");
  });

  it("keeps Check in worker and Use the camera focusable while a check-in runs", async () => {
    class BarcodeDetectorMock {
      static getSupportedFormats = vi.fn().mockResolvedValue(["qr_code"]);
      detect = vi.fn().mockResolvedValue([]);
    }
    vi.stubGlobal("BarcodeDetector", BarcodeDetectorMock);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn() } });
    const api = makeApi();
    render(<StewardView data={{ member: { initials: "SO" }, events: scanEvents }} api={api} onNotice={() => {}} />);
    const camera = await screen.findByRole("button", { name: "Use the camera" });
    await waitFor(() => expect(camera).toBeEnabled(), { timeout: 3_000 });
    fireEvent.change(screen.getByPlaceholderText("7-character code"), { target: { value: "abc1234" } });
    const checkIn = screen.getByRole("button", { name: "Check in worker" });
    await expectHeldWriteFocus(api.scan, checkIn, () => {
      fireEvent.click(checkIn);
      if (api.scan.mock.calls.length === 1) {
        expect(camera).toHaveAttribute("aria-disabled", "true");
        expect(camera).toBeEnabled();
        fireEvent.click(camera);
        expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
      }
    });
    expect(api.scan).toHaveBeenCalledWith("evt-1", "abc1234");
  });

  it("keeps Approve focused while the review's approval runs", async () => {
    const api = makeApi();
    render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Workplace issue report/ }));
    expect(await screen.findByText("Filer signature saved")).toBeInTheDocument();
    const approve = screen.getByRole("button", { name: "Approve" });
    await expectHeldWriteFocus(api.approveForm, approve);
    expect(api.approveForm).toHaveBeenCalledWith("form-inbox-1", "", expect.objectContaining({ templateKey: "grievance" }));
  });

  it("keeps a review's actions under one lock, so one tick starts one write", async () => {
    const api = makeApi();
    render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Workplace issue report/ }));
    expect(await screen.findByText("Filer signature saved")).toBeInTheDocument();
    const start = screen.getByRole("button", { name: "Start review" });
    const approve = screen.getByRole("button", { name: "Approve" });
    await expectOneWriteFromOneTick([api.startFormReview, api.approveForm], [() => fireEvent.click(start), () => fireEvent.click(approve)]);
  });

  it("keeps Send reply focused while the reply sends", async () => {
    const api = makeApi();
    const dialog = await openThread(api);
    fireEvent.change(within(dialog).getByPlaceholderText("Reply as Committee…"), { target: { value: "On it today." } });
    const send = within(dialog).getByRole("button", { name: "Send reply" });
    await expectHeldWriteFocus(api.reply, send);
    expect(api.reply).toHaveBeenCalledWith("conv-1", "On it today.");
  });

  it("keeps Cancel scheduled send focused while it cancels", async () => {
    const api = makeApi();
    api.listScheduled = vi.fn().mockResolvedValue([{ id: "sched-1", conversation_id: "conv-1", body: "Follow up tomorrow", scheduled_for: "2026-09-18T12:00:00Z", status: "pending" }]);
    api.cancelScheduled = vi.fn().mockResolvedValue({ cancelled: true });
    const dialog = await openThread(api);
    const cancel = await within(dialog).findByRole("button", { name: "Cancel scheduled send" });
    await expectHeldWriteFocus(api.cancelScheduled, cancel);
    expect(api.cancelScheduled).toHaveBeenCalledWith("sched-1");
  });

  it("keeps Save private note focused while the note saves", async () => {
    const api = { ...makeApi(), listContactNotes: vi.fn().mockResolvedValue([]), createContactNote: vi.fn().mockResolvedValue({ id: "note-1" }) };
    const dialog = await openThread(api);
    fireEvent.change(within(dialog).getByPlaceholderText("Add a staff-only contact note…"), { target: { value: "Prefers calls after 3 PM" } });
    const save = within(dialog).getByRole("button", { name: "Save private note" });
    await expectHeldWriteFocus(api.createContactNote, save);
    expect(api.createContactNote).toHaveBeenCalledWith("conv-1", "Prefers calls after 3 PM", null);
  });

  it("keeps Create campaign-only meeting focused while the event is created", async () => {
    const api = { ...makeApi(), createEventFromMessage: vi.fn().mockResolvedValue({ created: true }) };
    const dialog = await openThread(api, { canCreateMessageEvent: true });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create meeting" }));
    for (const [label, value] of [
      ["Meeting ID", "overtime-meeting"], ["Meeting title", "Overtime meeting"], ["Starts", "2026-11-20T18:00"],
      ["Location", "Union hall"], ["Public summary", "Overtime rules."], ["Check-in code", "SG-ABC123"],
    ]) fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
    const create = within(dialog).getByRole("button", { name: "Create campaign-only meeting" });
    await expectHeldWriteFocus(api.createEventFromMessage, create);
    expect(api.createEventFromMessage).toHaveBeenCalledWith("m-1", expect.objectContaining({ title: "Overtime meeting" }));
  });

  it("keeps a broadcast's Retract focusable while its retraction runs", async () => {
    const api = makeApi();
    let release;
    api.retract = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    render(<StewardView data={{ member: { initials: "SO" } }} api={api} onNotice={() => {}} />);
    const retract = await screen.findByRole("button", { name: "Retract “Card-count update”" });
    fireEvent.click(retract);
    fireEvent.click(within(await screen.findByTestId("confirm-action")).getByRole("button", { name: "Retract broadcast" }));
    await waitFor(() => expect(api.retract).toHaveBeenCalledTimes(1));
    try {
      await expectPendingFocus(retract);
      fireEvent.click(retract);
      expect(screen.queryByTestId("confirm-action")).toBeNull();
    } finally {
      await act(async () => { release({}); });
    }
  });
});
