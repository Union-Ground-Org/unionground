import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StewardView } from "../src/views/StewardView.jsx";

// The steward desk mounts its issue-signal and case-signal panels only when
// App hands them a client; both arms are pinned here, beside the dated-note
// and deadline-list additions of REQ-UG-STEWARD-CASE-NOTES-AND-STEP-DEADLINES-20261030.

afterEach(() => { window.history.replaceState({}, "", "/m/steward"); });

const desk = {
  caseload: [], caseloadUnavailable: false, caseloadTruncated: false, caseUpdatesUnavailable: false,
  queue: [], threads: [], broadcasts: [], formsInbox: [], formTemplateVersions: [],
  kpis: { openRequests: 0, membersCovered: 12, awaitingReply: 0, broadcasts30d: 0 },
};

function api(extra = {}) {
  return {
    loadDesk: vi.fn().mockResolvedValue(desk),
    triage: vi.fn(), reply: vi.fn(), publish: vi.fn(), retract: vi.fn(),
    startFormReview: vi.fn(), approveForm: vi.fn(), returnForm: vi.fn(),
    approveAndOpenCase: vi.fn(), scan: vi.fn(),
    ...extra,
  };
}

describe("committee worker desk signal panels and deadline list", () => {
  it("mounts the issue and issue signal panels when their clients are present", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { enabled: false, digests: [], signals: [] }, error: null });
    render(<StewardView data={{ member: { initials: "SO" } }} api={api()} onNotice={() => {}}
      issueSignals={{ client: { rpc }, scopeKey: "steward-a" }} caseSignals={{ client: { rpc }, scopeKey: "steward-a" }} />);
    expect(await screen.findByText("Your issues")).toBeInTheDocument();
    await waitFor(() => expect(rpc).toHaveBeenCalled());
  });

  it("shows the committee worker's deadline list on the caseload when the desk offers it", async () => {
    const listCaseDeadlines = vi.fn().mockResolvedValue({ state: "ready", rows: [] });
    render(<StewardView data={{ member: { initials: "SO" } }} api={api({ listCaseDeadlines })} onNotice={() => {}} />);
    expect(await screen.findByText("Deadlines on my issues")).toBeInTheDocument();
    expect(await screen.findByText("No open deadlines on your issues.")).toBeInTheDocument();
    expect(listCaseDeadlines).toHaveBeenCalledTimes(1);
  });

  it("seeds an older desk with no forms inbox and survives odd broadcast read-count answers", async () => {
    const { formsInbox: _omitted, ...olderDesk } = { ...desk, broadcasts: [{ id: "broadcast-a", title: "Campaign notice",
      body: "Meeting this week.", publishedAt: "2026-11-01T12:00:00Z", readCount: null }] };
    const odd = vi.fn().mockResolvedValue(null);
    const first = render(<StewardView data={{ member: { initials: "SO" } }} api={api({ loadDesk: vi.fn().mockResolvedValue(olderDesk), getBroadcastReadCounts: odd })} onNotice={() => {}} />);
    expect(await screen.findByText("Your issues")).toBeInTheDocument();
    await waitFor(() => expect(odd).toHaveBeenCalledTimes(1));
    first.unmount();
    const failing = vi.fn().mockRejectedValue({});
    render(<StewardView data={{ member: { initials: "SO" } }} api={api({ loadDesk: vi.fn().mockResolvedValue(olderDesk), getBroadcastReadCounts: failing })} onNotice={() => {}} />);
    expect(await screen.findByText("Your issues")).toBeInTheDocument();
    await waitFor(() => expect(failing).toHaveBeenCalledTimes(1));
  });

  it("re-reads the issue history and the deadline list after a committee worker note is saved", async () => {
    const caseRow = { id: "case-1", memberName: "Renata Cole", memberInitials: "RC", reference: "GRV-2026-014", title: "Overtime", step: "Step 1",
      status: "active", deadline: "2026-11-13", updatedAt: "2026-10-05T12:00:00Z", updates: [], updatesTotal: 0 };
    const loadDesk = vi.fn().mockImplementation(async () => ({ ...desk, caseload: [caseRow] }));
    const loadCaseHistory = vi.fn().mockResolvedValue({ rows: [], nextCursor: null });
    const listCaseDeadlines = vi.fn().mockResolvedValue({ state: "ready", rows: [] });
    const addStewardCaseNote = vi.fn().mockResolvedValue({ id: "n1" });
    const loadCaseworkCase = vi.fn().mockResolvedValue({ scope: { id: "case-1", step: "Step 1", status: "active" }, strength: [], deadlines: [], checklists: [],
      transitions: [], alerts: [], management: [], retaliation: [], links: [], reminders: [], accessGrants: [] });
    render(<StewardView data={{ member: { initials: "SO" } }} api={api({ loadDesk, loadCaseHistory, listCaseDeadlines, addStewardCaseNote, loadCaseworkCase })} onNotice={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /GRV-2026-014/ }));
    const dialog = await screen.findByRole("dialog", { name: "GRV-2026-014 — Overtime" });
    await waitFor(() => expect(loadCaseHistory).toHaveBeenCalled());
    const historyReads = loadCaseHistory.mock.calls.length;
    const deadlineReads = listCaseDeadlines.mock.calls.length;
    fireEvent.change(within(dialog).getByLabelText("Note"), { target: { value: "Called HR" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(addStewardCaseNote).toHaveBeenCalledWith("case-1", "Called HR", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)));
    await waitFor(() => expect(loadCaseHistory.mock.calls.length).toBeGreaterThan(historyReads));
    await waitFor(() => expect(listCaseDeadlines.mock.calls.length).toBeGreaterThan(deadlineReads));
  });
});
