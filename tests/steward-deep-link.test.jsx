import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StewardView } from "../src/views/StewardView.jsx";

const actor = {
  userId: "steward-sam",
  selectedOrganizationId: "org-a",
  roles: ["steward"],
  membershipStatus: "active",
};

const cases = [
  {
    id: "case-a",
    subjectUserId: "member-a",
    memberName: "Renata Cole",
    memberInitials: "RC",
    reference: "GRV-2026-014",
    title: "Mandated overtime without notice",
    caseType: "Grievance",
    articles: "Art. 21 §3",
    step: "Step 2",
    status: "active",
    deadline: "2026-10-15",
    updatedAt: "2026-09-20T12:00:00Z",
    assignedAt: "2026-09-18T09:00:00Z",
    coordinatorName: "Dana Ortiz",
    updates: [],
    updatesTotal: 0,
  },
  {
    id: "case-b",
    subjectUserId: "member-b",
    memberName: "Devon Pratt",
    memberInitials: "DP",
    reference: "GRV-2026-015",
    title: "Denied schedule accommodation",
    caseType: "Grievance",
    articles: "",
    step: "Step 1",
    status: "active",
    deadline: "2026-10-20",
    updatedAt: "2026-09-20T13:00:00Z",
    assignedAt: "2026-09-19T09:00:00Z",
    coordinatorName: null,
    updates: [],
    updatesTotal: 0,
  },
];

const threads = [
  {
    id: "thread-a",
    memberName: "Renata Cole",
    memberInitials: "RC",
    preview: "They mandated me again last night.",
    updatedAt: "2026-09-20T14:00:00Z",
    awaitingReply: true,
    messages: [{
      id: "message-a",
      sender_kind: "member",
      sender_name: "Renata Cole",
      body: "They mandated me again last night.",
      created_at: "2026-09-20T14:00:00Z",
    }],
  },
  {
    id: "thread-b",
    memberName: "Devon Pratt",
    memberInitials: "DP",
    preview: "Can we review my schedule request?",
    updatedAt: "2026-09-20T15:00:00Z",
    awaitingReply: false,
    messages: [{
      id: "message-b",
      sender_kind: "member",
      sender_name: "Devon Pratt",
      body: "Can we review my schedule request?",
      created_at: "2026-09-20T15:00:00Z",
    }],
  },
];

function desk(overrides = {}) {
  return {
    caseload: cases,
    caseloadUnavailable: false,
    caseloadTruncated: false,
    caseUpdatesUnavailable: false,
    queue: [{
      id: "request-a",
      memberName: "Avery Rivera",
      memberInitials: "AR",
      lessonLabel: "",
      status: "requested",
      createdAt: "2026-09-20T16:00:00Z",
    }],
    threads,
    broadcasts: [],
    formsInbox: [],
    formTemplateVersions: [],
    kpis: { openRequests: 1, membersCovered: 2, awaitingReply: 1, broadcasts30d: 0 },
    ...overrides,
  };
}

function makeApi(readDesk = () => desk()) {
  return {
    loadDesk: vi.fn(async () => structuredClone(readDesk())),
    recordAccess: vi.fn().mockResolvedValue({ ok: true }),
    triage: vi.fn().mockResolvedValue({}),
    reply: vi.fn().mockResolvedValue({}),
    publish: vi.fn().mockResolvedValue({}),
    retract: vi.fn().mockResolvedValue({}),
    startFormReview: vi.fn().mockResolvedValue({}),
    approveForm: vi.fn().mockResolvedValue({}),
    returnForm: vi.fn().mockResolvedValue({}),
    approveAndOpenCase: vi.fn().mockResolvedValue({}),
    scan: vi.fn().mockResolvedValue({}),
  };
}

function renderDesk(api) {
  return render(
    <StewardView
      data={{ member: { id: actor.userId, initials: "SO" }, events: [] }}
      accessActor={actor}
      api={api}
      onNotice={() => {}}
    />,
  );
}

function finishDialogClose() {
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  fireEvent.transitionEnd(document.querySelector(".dialog-backdrop"));
}

async function reloadDeskBehindDialog(api) {
  fireEvent.click(screen.getByRole("button", { name: "Acknowledge", hidden: true }));
  await waitFor(() => expect(api.loadDesk).toHaveBeenCalledTimes(2));
}

afterEach(() => {
  window.history.replaceState({}, "", "/m/steward");
});

describe("steward desk deep links", () => {
  it("opens a linked case once, records one access event, and stays closed after a fresh desk read", async () => {
    window.history.replaceState({}, "", "/m/steward?case=case-a");
    const api = makeApi();
    renderDesk(api);

    const linked = await screen.findByRole("dialog", { name: /GRV-2026-014/ });
    await waitFor(() => expect(api.recordAccess).toHaveBeenCalledTimes(1));
    // Union Ground issues carry no grievance step or contract article: the
    // linked record states neither, even when the row still carries them.
    expect(within(linked).queryByText("Step 2")).toBeNull();
    expect(within(linked).queryByText("Art. 21 §3")).toBeNull();
    expect(within(linked.querySelector(".detail-facts")).queryByText(/^(Step|Articles)$/)).toBeNull();
    expect(within(linked).queryByRole("button", { name: /change step/i })).toBeNull();
    // Nor does the caseload behind it chip a step on any row.
    expect(screen.queryByText("Step 1")).toBeNull();

    finishDialogClose();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(api.loadDesk).toHaveBeenCalledTimes(2));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.recordAccess).toHaveBeenCalledTimes(1);
  });

  it("keeps a deliberately opened case selected when the linked case remains in the URL", async () => {
    window.history.replaceState({}, "", "/m/steward?case=case-a");
    const api = makeApi();
    renderDesk(api);

    await screen.findByRole("dialog", { name: /GRV-2026-014/ });
    finishDialogClose();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /GRV-2026-015/ }));
    expect(await screen.findByRole("dialog", { name: /GRV-2026-015/ })).toBeInTheDocument();
    await reloadDeskBehindDialog(api);

    expect(screen.getByRole("dialog", { name: /GRV-2026-015/ })).toBeInTheDocument();
    expect(api.recordAccess).toHaveBeenCalledTimes(2);
  });

  it("keeps a linked thread closed and preserves a draft in another thread across reload", async () => {
    window.history.replaceState({}, "", "/m/steward?thread=thread-a");
    const api = makeApi();
    renderDesk(api);

    await screen.findByRole("dialog", { name: "Renata Cole" });
    finishDialogClose();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByText("Can we review my schedule request?").closest("button"));
    const devonDialog = await screen.findByRole("dialog", { name: "Devon Pratt" });
    const reply = within(devonDialog).getByPlaceholderText("Reply as Committee…");
    fireEvent.change(reply, { target: { value: "Draft response for Devon" } });
    await reloadDeskBehindDialog(api);

    expect(screen.getByRole("dialog", { name: "Devon Pratt" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Draft response for Devon")).toBeInTheDocument();
  });

  it("waits for a linked case that arrives in a later desk read, then consumes it once", async () => {
    window.history.replaceState({}, "", "/m/steward?case=case-a");
    let currentDesk = desk({ caseload: [] });
    const api = makeApi(() => currentDesk);
    renderDesk(api);

    await screen.findByText(/No issues are assigned to you right now/);
    expect(screen.queryByRole("dialog")).toBeNull();
    currentDesk = desk();
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));

    expect(await screen.findByRole("dialog", { name: /GRV-2026-014/ })).toBeInTheDocument();
    expect(api.recordAccess).toHaveBeenCalledTimes(1);
  });

  it("waits for a linked thread that arrives in a later desk read, then consumes it once", async () => {
    window.history.replaceState({}, "", "/m/steward?thread=thread-a");
    let currentDesk = desk({ threads: [] });
    const api = makeApi(() => currentDesk);
    renderDesk(api);

    await screen.findByText("No worker conversations yet.");
    expect(screen.queryByRole("dialog")).toBeNull();
    currentDesk = desk();
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));

    expect(await screen.findByRole("dialog", { name: "Renata Cole" })).toBeInTheDocument();
  });

  it("does not open a dialog or record access when the desk has no deep-link query", async () => {
    const api = makeApi();
    renderDesk(api);

    await screen.findByText("Your issues");
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(api.loadDesk).toHaveBeenCalledTimes(2));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.recordAccess).not.toHaveBeenCalled();
  });
});
