// Caseload UI (UB-CASE-05): the steward desk renders its assigned cases as a
// list/queue with a read-only detail dialog. The panel must distinguish the
// three honest states — rows, genuinely empty, and UNAVAILABLE — because "no
// cases assigned" as the face of a failed read is exactly the silent lie the
// loader's caseloadUnavailable flag exists to prevent.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StewardView } from "../src/views/StewardView.jsx";

// The shared case list persists its filter state in the URL; every test
// starts from a clean query so one test's facet choice cannot leak into the
// next render.
afterEach(() => { window.history.replaceState({}, "", "/m/steward"); });

const baseDesk = {
  caseload: [],
  caseloadUnavailable: false,
  caseloadTruncated: false,
  caseUpdatesUnavailable: false,
  queue: [],
  threads: [],
  broadcasts: [],
  formsInbox: [],
  formTemplateVersions: [],
  kpis: { openRequests: 0, membersCovered: 12, awaitingReply: 0, broadcasts30d: 0 },
};

const caseload = [
  {
    id: "case-1", subjectUserId: "member-renata", memberName: "Renata Cole", memberInitials: "RC", reference: "GRV-2026-014",
    title: "Mandated overtime without notice", caseType: "Grievance", articles: "Art. 21 §3",
    step: "Step 2", status: "active", deadline: "2026-08-15", updatedAt: "2026-08-05T12:00:00Z",
    assignedAt: "2026-08-01T09:00:00Z", coordinatorName: "Dana Ortiz",
    updates: [{ id: "u-1", body: "HR acknowledged the filing.", createdAt: "2026-08-04T10:00:00Z" }],
    updatesTotal: 1,
  },
  {
    id: "case-2", subjectUserId: "member-devon", memberName: "Devon Pratt", memberInitials: "DP", reference: "GRV-2026-009",
    title: "Denied schedule accommodation", caseType: "Grievance", articles: "",
    step: "Resolved", status: "resolved", deadline: null, updatedAt: "2026-07-28T12:00:00Z",
    assignedAt: "2026-07-20T09:00:00Z", coordinatorName: null, updates: [], updatesTotal: 0,
  },
];

function makeApi(desk) {
  return {
    loadDesk: vi.fn().mockResolvedValue(desk),
    triage: vi.fn(), reply: vi.fn(), publish: vi.fn(), retract: vi.fn(),
    startFormReview: vi.fn(), approveForm: vi.fn(), returnForm: vi.fn(),
    approveAndOpenCase: vi.fn(), scan: vi.fn(),
  };
}

function renderDesk(desk) {
  return render(<StewardView data={{ member: { initials: "SO" } }} api={makeApi(desk)} onNotice={() => {}} />);
}

describe("steward caseload panel", () => {
  it("lists assigned cases with member, reference, status, and deadline", async () => {
    renderDesk({ ...baseDesk, caseload });
    expect(await screen.findByText("Your issues")).toBeInTheDocument();
    const panel = within(document.getElementById("steward-caseload"));
    expect(panel.getByText("Renata Cole")).toBeInTheDocument();
    expect(panel.getByText("GRV-2026-014")).toBeInTheDocument();
    expect(panel.getByText("Mandated overtime without notice")).toBeInTheDocument();
    expect(panel.getByText("Active")).toBeInTheDocument();
    // "Resolved" is both this case's step and its status; pin the status cell.
    expect(panel.getByText("Resolved", { selector: ".gq-status" })).toBeInTheDocument();
    // Localized deadline cell: the dated case names its date, the undated
    // one says so instead of inventing a date.
    expect(panel.getByText("Deadline Aug 15")).toBeInTheDocument();
    expect(panel.getByText("No deadline")).toBeInTheDocument();
  });

  // Lane 5.6 wires the shared bulk bar into the caseload. casework_apply_macro
  // demands a coordinator/admin/vp role on the organization, so a Macros
  // button on the steward desk would answer a raw 42501 on the first click.
  it("offers the bulk bar without the coordinator-only macro menu", async () => {
    const api = {
      ...makeApi({ ...baseDesk, caseload }),
      bulkUpdateCases: vi.fn(),
      advanceCaseStep: vi.fn(),
      listMacros: vi.fn(),
      applyMacro: vi.fn(),
    };
    render(<StewardView data={{ member: { initials: "SO" } }} api={api} onNotice={() => {}} />);
    await screen.findByText("Renata Cole");
    const panel = within(document.getElementById("steward-caseload"));
    // The bar only offers actions once something is ticked.
    fireEvent.click(panel.getByRole("checkbox", { name: "Select issue GRV-2026-014" }));
    const actions = await panel.findByRole("group", { name: "Bulk actions" });
    expect(within(actions).getByRole("button", { name: "Set status" })).toBeInTheDocument();
    // Union Ground issues have no grievance steps: no bulk Advance step,
    // even when the api double still carries the old method.
    expect(panel.queryByRole("button", { name: "Advance step" })).toBeNull();
    expect(panel.queryByRole("button", { name: /advance/i })).toBeNull();
    expect(panel.queryByRole("button", { name: "Macros" })).toBeNull();
    expect(api.advanceCaseStep).not.toHaveBeenCalled();
    expect(api.listMacros).not.toHaveBeenCalled();
  });

  it("filters the queue by status without losing the full list", async () => {
    renderDesk({ ...baseDesk, caseload });
    await screen.findByText("Renata Cole");
    // Scope to the caseload panel: the UB-DESK-01 queue toolbars carry their
    // own "All" chips, so bare name queries would be ambiguous.
    const panel = within(document.getElementById("steward-caseload"));
    fireEvent.change(panel.getByLabelText("Status"), { target: { value: "resolved" } });
    await waitFor(() => expect(screen.queryByText("Renata Cole")).toBeNull());
    expect(screen.getByText("Devon Pratt")).toBeInTheDocument();
    fireEvent.change(panel.getByLabelText("Status"), { target: { value: "" } });
    // Polling assertion: the desk reload that follows a filter edit can swap
    // the row DOM between a findBy query and its expect.
    await waitFor(() => expect(screen.getByText("Renata Cole")).toBeInTheDocument());
  });

  // The procedure board is left out: Union Ground issues have no
  // grievance steps to deal cards into (owner decision, 2026-10-13). The list
  // is the only layout, with no layout toggle and no step columns.
  it("offers no procedure board, layout toggle, or step columns", async () => {
    const api = makeApi({ ...baseDesk, caseload });
    api.advanceCaseStep = vi.fn().mockResolvedValue({ advanced: true });
    render(<StewardView data={{ member: { initials: "SO" } }} api={api} onNotice={() => {}} />);
    await screen.findByText("Renata Cole");
    expect(document.querySelectorAll("#steward-caseload .case-list__open")).toHaveLength(2);
    const panel = within(document.getElementById("steward-caseload"));
    expect(panel.queryByRole("group", { name: "Issue list layout" })).toBeNull();
    expect(panel.queryByRole("button", { name: "Board" })).toBeNull();
    expect(panel.queryByRole("button", { name: "List" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Step 2 cases" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Resolved issues" })).toBeNull();
    expect(panel.queryByRole("button", { name: /^Move / })).toBeNull();
    // No step column or chip on the rows either.
    expect(panel.queryByText("Step 2")).toBeNull();
    expect(panel.queryByRole("columnheader", { name: /step/i })).toBeNull();
    expect(api.advanceCaseStep).not.toHaveBeenCalled();
  });

  // The shared list owns facets, sort and saved views over the caseload.
  it("applies a saved default view to the list", async () => {
    const api = makeApi({ ...baseDesk, caseload });
    api.listSavedViews = vi.fn().mockResolvedValue([
      { id: "view-1", name: "Live work", isDefault: true, definition: { filters: { status: "active" }, sorting: [{ id: "deadline", desc: false }] } },
    ]);
    api.saveSavedView = vi.fn();
    api.deleteSavedView = vi.fn();
    render(<StewardView data={{ member: { initials: "SO" } }} api={api} onNotice={() => {}} />);
    await screen.findByText("Your issues");
    const panel = within(document.getElementById("steward-caseload"));
    // The owner's default view is applied on its own, with no click.
    await waitFor(() => expect(api.listSavedViews).toHaveBeenCalledWith("steward"));
    await waitFor(() => expect(panel.queryByText("Devon Pratt")).toBeNull());
    expect(panel.getByText("Renata Cole")).toBeInTheDocument();
    expect(panel.getByLabelText("Saved views")).toHaveValue("view-1");
    // The applied view is written to the query, so the link is shareable.
    expect(new URLSearchParams(window.location.search).get("status")).toBe("active");
  });

  it("opens the read-only detail dialog with the case facts and update timeline", async () => {
    renderDesk({ ...baseDesk, caseload });
    fireEvent.click(await screen.findByRole("button", { name: /GRV-2026-014/ }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("GRV-2026-014 — Mandated overtime without notice")).toBeInTheDocument();
    expect(dialog.getByText("Grievance")).toBeInTheDocument();
    expect(dialog.getByText("Dana Ortiz")).toBeInTheDocument();
    // Union Ground issues carry no grievance step or contract article, so
    // neither is a fact on the record even when the row still carries them.
    expect(dialog.queryByText("Step 2")).toBeNull();
    expect(dialog.queryByText("Art. 21 §3")).toBeNull();
    expect(dialog.queryByText("Step")).toBeNull();
    expect(dialog.queryByText("Articles")).toBeNull();
    expect(dialog.queryByRole("button", { name: "Change step or add a deadline" })).toBeNull();
    expect(dialog.getByText("HR acknowledged the filing.")).toBeInTheDocument();
  });

  it("records a scoped case view before revealing steward details", async () => {
    const api = makeApi({ ...baseDesk, caseload });
    api.recordAccess = vi.fn().mockResolvedValue({ ok: true });
    const actor = { userId: "steward-sam", selectedOrganizationId: "org-a", roles: ["steward"], membershipStatus: "active" };
    render(<StewardView data={{ member: { initials: "SO" } }} accessActor={actor} api={api} onNotice={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /GRV-2026-014/ }));
    await waitFor(() => expect(api.recordAccess).toHaveBeenCalledWith(actor, {
      subjectUserId: "member-renata",
      action: "viewed_case",
      entityType: "case",
      entityId: "case-1",
    }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("keeps steward details closed when access recording fails", async () => {
    const api = makeApi({ ...baseDesk, caseload });
    api.recordAccess = vi.fn().mockResolvedValue({ ok: false });
    const onNotice = vi.fn();
    render(<StewardView data={{ member: { initials: "SO" } }} accessActor={{ userId: "steward-sam", selectedOrganizationId: "org-a", roles: ["steward"], membershipStatus: "active" }} api={api} onNotice={onNotice} />);
    fireEvent.click(await screen.findByRole("button", { name: /GRV-2026-014/ }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/access could not be logged/i)));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("admits exactly how much timeline is omitted when the per-case window is smaller than the true total", async () => {
    const truncated = [{ ...caseload[0], updatesTotal: 25 }];
    renderDesk({ ...baseDesk, caseload: truncated });
    fireEvent.click(await screen.findByRole("button", { name: /GRV-2026-014/ }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("Showing the latest 1 of 25 updates.")).toBeInTheDocument();
    expect(dialog.getByText("HR acknowledged the filing.")).toBeInTheDocument();
  });

  it("discloses a truncated caseload window with the real loaded counts", async () => {
    renderDesk({ ...baseDesk, caseload, caseloadTruncated: true, caseloadWindow: { active: 200, resolved: 3 } });
    expect(await screen.findByText(/showing your 200 most urgent active and 3 most recent resolved issues/)).toBeInTheDocument();
  });

  it("says the timeline is unavailable inside the dialog when the updates read failed", async () => {
    renderDesk({ ...baseDesk, caseload, caseUpdatesUnavailable: true });
    fireEvent.click(await screen.findByRole("button", { name: /GRV-2026-014/ }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/Issue updates could not be loaded right now/)).toBeInTheDocument();
    expect(dialog.queryByText("HR acknowledged the filing.")).toBeNull();
  });

  it("hides the count chip on a failed read so the panel never claims a zero caseload", async () => {
    renderDesk({ ...baseDesk, caseloadUnavailable: true });
    await screen.findByText(/Your issues could not be loaded right now/);
    const heading = screen.getByText("Your issues").closest(".cwk-panel__heading");
    expect(heading.querySelector(".cwk-count")).toBeNull();
  });

  it("shows the genuine empty state when no cases are assigned", async () => {
    renderDesk({ ...baseDesk });
    expect(await screen.findByText(/No issues are assigned to you right now/)).toBeInTheDocument();
    // No filter row when there is nothing to filter.
    expect(screen.queryByRole("group", { name: "Issue list filters" })).toBeNull();
  });

  it("shows the unavailable notice — never the empty state — when the read failed", async () => {
    renderDesk({ ...baseDesk, caseloadUnavailable: true });
    expect(await screen.findByText(/Your issues could not be loaded right now/)).toBeInTheDocument();
    expect(screen.queryByText(/No issues are assigned to you right now/)).toBeNull();
  });

  // SOL-20260813-07: the steward may read the President's review record, so
  // the dialog where the case is worked names the reviewer and the date. Its
  // absence claims nothing — a case never reviewed and a failed review read
  // look the same, which is the honest state for an additive line.
  describe("President review attribution in the case dialog", () => {
    const reviewedAt = "2026-08-06T15:00:00Z";
    const expectedDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(reviewedAt));

    it("names the reviewer and the review date from the case record", async () => {
      const reviewed = [{ ...caseload[0], review: { reviewerName: "Taylor Morgan", reviewedAt } }, caseload[1]];
      renderDesk({ ...baseDesk, caseload: reviewed });
      fireEvent.click(await screen.findByRole("button", { name: /GRV-2026-014/ }));
      const dialog = within(await screen.findByRole("dialog"));
      expect(dialog.getByText(`Reviewed by President Taylor Morgan · ${expectedDate}`)).toBeInTheDocument();
    });

    it("renders no attribution line for a case with no review", async () => {
      renderDesk({ ...baseDesk, caseload });
      fireEvent.click(await screen.findByRole("button", { name: /GRV-2026-014/ }));
      const dialog = within(await screen.findByRole("dialog"));
      expect(dialog.queryByText(/Reviewed by President/)).toBeNull();
      expect(document.querySelector(".cwk-review-note")).toBeNull();
    });

    it("keeps one case's review off another case's dialog", async () => {
      const reviewed = [caseload[0], { ...caseload[1], review: { reviewerName: "Taylor Morgan", reviewedAt } }];
      renderDesk({ ...baseDesk, caseload: reviewed });
      fireEvent.click(await screen.findByRole("button", { name: /GRV-2026-014/ }));
      const dialog = within(await screen.findByRole("dialog"));
      expect(dialog.queryByText(/Reviewed by President/)).toBeNull();
    });
  });
});
