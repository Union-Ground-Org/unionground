import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lifecycleFallback } from "../src/data/lifecycleFallback.js";
import { createLifecycleDemoApi } from "../src/lib/lifecycleApi.js";
import { ORGANIZE_LOCALE_TABLES, OrganizeView } from "../src/views/OrganizeView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const data = { member: { initials: "DF" } };
const clone = (value) => JSON.parse(JSON.stringify(value));

function liveWriterWorkspace(overrides = {}) {
  const workspace = clone(lifecycleFallback);
  workspace.mode = "live";
  workspace.access.aggregateOnly = false;
  workspace.access.canCreateCampaign = true;
  workspace.campaigns[0] = {
    ...workspace.campaigns[0],
    stage: "lead",
    status: "active",
    revision: 7,
    canOperate: true,
    closedAt: null,
    outcome: null,
    outcomeReason: null,
    verifiedStages: ["lead"],
    ...overrides,
  };
  return workspace;
}

function liveBargainingWorkspace(overrides = {}) {
  const workspace = clone(lifecycleFallback);
  workspace.mode = "live";
  workspace.access.aggregateOnly = false;
  const campaign = workspace.campaigns.find((item) => item.id === "campaign-metro-dispatch");
  Object.assign(campaign, {
    status: "active",
    stage: "bargaining",
    revision: 11,
    canOperate: true,
  });
  const bargaining = workspace.bargaining.find((item) => item.campaignId === campaign.id);
  const agreementPackage = bargaining.proposals.find(
    (proposal) => proposal.recordKind === "agreement_package",
  );
  Object.assign(agreementPackage, {
    status: "tentative_agreement",
    presentedOn: "2026-07-18",
    memberSummary: "The whole agreement package is ready for the recorded decision process.",
    canMarkTentativeAgreement: true,
  });
  Object.assign(bargaining, {
    canWrite: true,
    canRecordSessionOutcome: true,
    canAdvanceToRatification: true,
    canCertify: true,
    ...overrides,
  });
  return workspace;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("organizing lifecycle workspace", () => {
  it("renders the fictional lifecycle rail and seven-tab operating plane", async () => {
    render(<OrganizeView data={data} api={createLifecycleDemoApi(lifecycleFallback)} />);
    expect(await screen.findByText("Fictional demonstration")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recorded lifecycle" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(7);
    expect(screen.getByRole("radio", { name: /Harborview Care United/ })).toHaveAttribute("aria-checked", "true");
  });

  it("suppresses small numerator and complement values without a residual bar or percent", async () => {
    render(<OrganizeView data={data} api={createLifecycleDemoApi(lifecycleFallback)} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Worksites" }));
    expect(screen.getAllByText("Not shown").length).toBeGreaterThan(0);
    expect(screen.queryByText("3%")).not.toBeInTheDocument();
    expect(document.querySelector('[style*="width: 3%"]')).toBeNull();
  });

  it("does not label a live workspace as fictional and handles suppressed live metrics", async () => {
    const live = clone(lifecycleFallback);
    live.mode = "live";
    live.engagement.onboarding30 = null;
    live.engagement.onboarding90 = null;
    live.engagement.membershipRetention12Month = null;
    live.engagement.engagementRetention12Month = null;
    live.engagement.ladder = live.engagement.ladder.map((item) => ({ ...item, count: null }));
    render(<OrganizeView data={data} api={createLifecycleDemoApi(live)} />);
    expect(await screen.findByText("Restricted workspace")).toBeInTheDocument();
    expect(screen.queryByText("Fictional demonstration")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Engagement" }));
    expect(screen.getAllByText("Not shown").length).toBeGreaterThan(0);
  });

  it("keeps aggregate engagement, coalition, and impact tabs usable without campaign detail", async () => {
    const aggregate = clone(lifecycleFallback);
    aggregate.mode = "live";
    aggregate.access.aggregateOnly = true;
    aggregate.campaigns = [];
    aggregate.workAreas = [];
    render(<OrganizeView data={data} api={createLifecycleDemoApi(aggregate)} />);
    expect(await screen.findByRole("tab", { name: "Engagement" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    fireEvent.click(screen.getByRole("tab", { name: "Impact" }));
    expect(screen.getByRole("heading", { name: "Ten-year impact" })).toBeInTheDocument();
  });

  it("distinguishes restricted resistance data from a verified empty record", async () => {
    const restricted = clone(lifecycleFallback);
    restricted.mode = "live";
    restricted.access.resistanceDetails = false;
    restricted.access.resistanceCampaignIds = [];
    restricted.resistanceEvents = [];
    render(<OrganizeView data={data} api={createLifecycleDemoApi(restricted)} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Resistance" }));
    expect(screen.getByText(/restricted to assigned organizers/i)).toBeInTheDocument();
    expect(screen.queryByText("No resistance reports recorded for this campaign.")).not.toBeInTheDocument();
  });

  it("announces load failures and retries", async () => {
    const api = { loadWorkspace: vi.fn().mockRejectedValueOnce(new Error("permission denied")).mockResolvedValueOnce(clone(lifecycleFallback)) };
    render(<OrganizeView data={data} api={api} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The workspace could not refresh.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("Fictional demonstration")).toBeInTheDocument());
    expect(api.loadWorkspace).toHaveBeenCalledTimes(2);
  });

  it("supports arrow-key tab and campaign selection", async () => {
    render(<OrganizeView data={data} api={createLifecycleDemoApi(lifecycleFallback)} />);
    const campaigns = await screen.findByRole("tab", { name: "Campaigns" });
    fireEvent.keyDown(campaigns, { key: "ArrowRight" });
    const worksites = screen.getByRole("tab", { name: "Worksites" });
    expect(worksites).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(worksites).toHaveFocus());
    const selected = screen.getByRole("radio", { name: /Harborview Care United/ });
    fireEvent.keyDown(selected, { key: "ArrowDown" });
    const nextCampaign = screen.getByRole("radio", { name: /North County Coordinators/ });
    expect(nextCampaign).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(nextCampaign).toHaveFocus());
  });

  it("formats stage transitions without exposing storage-key separators", async () => {
    render(<OrganizeView data={data} api={createLifecycleDemoApi(lifecycleFallback)} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Impact" }));
    expect(screen.getByText("Lead → Petition")).toBeInTheDocument();
    expect(screen.getByText("Bargaining → First contract")).toBeInTheDocument();
  });

  it("shows the longest median regardless of source row order", async () => {
    const workspace = clone(lifecycleFallback);
    workspace.impact.medianDays = [
      { stage: "bargaining_to_first_contract", label: "Bargaining → First contract", days: 286 },
      { stage: "lead_to_petition", label: "Lead → Petition", days: 104 },
      { stage: "certification_to_bargaining", label: "Certification → Bargaining", days: 31 },
    ];
    render(<OrganizeView data={data} api={createLifecycleDemoApi(workspace)} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Impact" }));
    expect(document.querySelector(".lifecycle-stats .stat-card:last-child")).toHaveTextContent("286 days");
  });

  it("keeps every tab control reference valid", async () => {
    render(<OrganizeView data={data} api={createLifecycleDemoApi(lifecycleFallback)} />);
    await screen.findByRole("tab", { name: "Campaigns" });
    for (const tab of screen.getAllByRole("tab")) {
      expect(document.getElementById(tab.getAttribute("aria-controls"))).not.toBeNull();
    }
  });

  it("draws no activity bar for a measured zero", async () => {
    const workspace = clone(lifecycleFallback);
    workspace.impact.years = [{ year: 2026, joined: 0, left: 0 }];
    render(<OrganizeView data={data} api={createLifecycleDemoApi(workspace)} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Impact" }));
    const bars = [...document.querySelectorAll(".impact-bars__pair i")];
    expect(bars).toHaveLength(2);
    expect(bars.every((bar) => parseFloat(bar.style.height || "0") === 0)).toBe(true);
  });

  it("creates the first live campaign with one stable idempotency key and reloads it", async () => {
    const empty = clone(lifecycleFallback);
    empty.mode = "live";
    empty.access.canCreateCampaign = true;
    empty.campaigns = [];
    empty.workAreas = [];
    const created = clone(lifecycleFallback);
    created.mode = "live";
    created.access.canCreateCampaign = true;
    created.campaigns[0].canOperate = true;
    const requestId = "20000000-0000-4000-8000-000000000001";
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => requestId) });
    const api = {
      loadWorkspace: vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce(created),
      createCampaign: vi.fn()
        .mockRejectedValueOnce(new Error("temporary conflict"))
        .mockResolvedValueOnce({ changed: true, campaignId: created.campaigns[0].id }),
    };

    render(<OrganizeView data={data} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create campaign" }));
    const dialog = screen.getByRole("dialog", { name: "Create an organizing campaign" });
    fireEvent.change(within(dialog).getByLabelText("Campaign name"), { target: { value: "Harbor workers" } });
    fireEvent.change(within(dialog).getByLabelText("Employer name"), { target: { value: "Harbor Employer" } });
    fireEvent.change(within(dialog).getByLabelText("Primary worksite"), { target: { value: "North site" } });
    fireEvent.change(within(dialog).getByLabelText("Proposed bargaining unit"), { target: { value: "Operations staff" } });
    fireEvent.change(within(dialog).getByLabelText("Representation path"), { target: { value: "election" } });
    fireEvent.change(within(dialog).getByLabelText(/Eligible estimate/), { target: { value: "42" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create campaign" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The change could not be saved.");

    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(api.createCampaign).toHaveBeenCalledTimes(2));
    expect(api.createCampaign.mock.calls[0][0].requestId).toBe(requestId);
    expect(api.createCampaign.mock.calls[1][0].requestId).toBe(requestId);
    expect(api.createCampaign.mock.calls[1][0]).toMatchObject({
      name: "Harbor workers",
      employerName: "Harbor Employer",
      worksiteName: "North site",
      proposedUnit: "Operations staff",
      representationPath: "election",
      eligibleEstimate: 42,
    });
    await waitFor(() => expect(screen.getByRole("radio", { name: /Harborview Care United/ })).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByRole("status")).toHaveTextContent("Campaign created.");
  });

  it("hides campaign creation from demo and aggregate-only workspaces", async () => {
    const demo = render(<OrganizeView data={data} api={createLifecycleDemoApi(lifecycleFallback)} />);
    await screen.findByText("Fictional demonstration");
    expect(screen.queryByRole("button", { name: "Create campaign" })).not.toBeInTheDocument();
    demo.unmount();

    const aggregate = clone(lifecycleFallback);
    aggregate.mode = "live";
    aggregate.access.aggregateOnly = true;
    aggregate.access.canCreateCampaign = false;
    aggregate.campaigns = [];
    render(<OrganizeView data={data} api={{ loadWorkspace: vi.fn().mockResolvedValue(aggregate) }} />);
    await screen.findByText("Restricted workspace");
    expect(screen.queryByRole("button", { name: "Create campaign" })).not.toBeInTheDocument();
  });

  it("does not report a committed campaign as failed when the refresh fails", async () => {
    const empty = clone(lifecycleFallback);
    empty.mode = "live";
    empty.access.canCreateCampaign = true;
    empty.campaigns = [];
    empty.workAreas = [];
    const api = {
      loadWorkspace: vi.fn().mockResolvedValueOnce(empty).mockRejectedValueOnce(new Error("offline")),
      createCampaign: vi.fn().mockResolvedValue({
        changed: true,
        campaignId: "a2000000-0000-4000-8000-000000000001",
      }),
    };

    render(<OrganizeView data={data} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create campaign" }));
    const dialog = screen.getByRole("dialog", { name: "Create an organizing campaign" });
    fireEvent.change(within(dialog).getByLabelText("Campaign name"), { target: { value: "Harbor workers" } });
    fireEvent.change(within(dialog).getByLabelText("Employer name"), { target: { value: "Harbor Employer" } });
    fireEvent.change(within(dialog).getByLabelText("Primary worksite"), { target: { value: "North site" } });
    fireEvent.change(within(dialog).getByLabelText("Proposed bargaining unit"), { target: { value: "Operations staff" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create campaign" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create an organizing campaign" })).not.toBeInTheDocument());
    expect(api.createCampaign).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent(/Campaign saved, but the workspace could not refresh/);
  });

  it("does not render a blank accountable-action card for a viewer", async () => {
    const viewer = clone(lifecycleFallback);
    viewer.mode = "live";
    viewer.campaigns[0].canOperate = false;
    viewer.campaigns[0].nextAction = null;
    viewer.campaigns[0].nextActionDue = null;
    render(<OrganizeView data={data} api={createLifecycleDemoApi(viewer)} />);
    await screen.findByRole("heading", { name: "Recorded lifecycle" });
    expect(screen.queryByText("Next accountable action")).not.toBeInTheDocument();
  });

  it("retries one unchanged milestone with the same request ID", async () => {
    const initial = liveWriterWorkspace();
    const updated = liveWriterWorkspace({
      stage: "committee",
      revision: 8,
      verifiedStages: ["lead", "committee"],
    });
    const requestId = "20000000-0000-4000-8000-000000000101";
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => requestId) });
    const firstError = Object.assign(new Error("temporary database timeout"), { code: "57014" });
    const api = {
      loadWorkspace: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(updated),
      transitionCampaign: vi.fn()
        .mockRejectedValueOnce(firstError)
        .mockResolvedValueOnce({
          changed: true,
          requestId,
          campaignId: initial.campaigns[0].id,
          stage: "committee",
          revision: 8,
          auditEventId: "30000000-0000-4000-8000-000000000101",
        }),
      setCampaignStatus: vi.fn(),
      createCampaign: vi.fn(),
    };

    render(<OrganizeView data={data} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Record milestone" }));
    const dialog = screen.getByRole("dialog", { name: "Record campaign milestone" });
    fireEvent.change(within(dialog).getByLabelText("Context note (optional)"), {
      target: { value: "Committee verified" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save milestone" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The change could not be saved.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save milestone" }));

    await waitFor(() => expect(api.transitionCampaign).toHaveBeenCalledTimes(2));
    expect(api.transitionCampaign.mock.calls[0][0]).toEqual(api.transitionCampaign.mock.calls[1][0]);
    expect(api.transitionCampaign.mock.calls[1][0]).toMatchObject({
      campaignId: initial.campaigns[0].id,
      expectedRevision: 7,
      nextStage: "committee",
      note: "Committee verified",
      requestId,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("Campaign milestone saved.");
  });

  it("reloads a revision conflict, preserves the draft, and uses a new command receipt", async () => {
    const initial = liveWriterWorkspace();
    const concurrent = liveWriterWorkspace({ revision: 8 });
    const updated = liveWriterWorkspace({
      stage: "committee",
      revision: 9,
      verifiedStages: ["lead", "committee"],
    });
    const requestIds = [
      "20000000-0000-4000-8000-000000000111",
      "20000000-0000-4000-8000-000000000112",
    ];
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => requestIds.shift()) });
    const conflict = Object.assign(new Error("campaign changed"), { code: "40001" });
    const api = {
      loadWorkspace: vi.fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(concurrent)
        .mockResolvedValueOnce(updated),
      transitionCampaign: vi.fn()
        .mockRejectedValueOnce(conflict)
        .mockResolvedValueOnce({
          changed: true,
          requestId: "20000000-0000-4000-8000-000000000112",
          campaignId: initial.campaigns[0].id,
          stage: "committee",
          revision: 9,
          auditEventId: "30000000-0000-4000-8000-000000000112",
        }),
      setCampaignStatus: vi.fn(),
      createCampaign: vi.fn(),
    };

    render(<OrganizeView data={data} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Record milestone" }));
    const dialog = screen.getByRole("dialog", { name: "Record campaign milestone" });
    const note = within(dialog).getByLabelText("Context note (optional)");
    fireEvent.change(note, { target: { value: "Verified committee" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save milestone" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/latest data loaded/i);
    expect(note).toHaveValue("Verified committee");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save milestone" }));

    await waitFor(() => expect(api.transitionCampaign).toHaveBeenCalledTimes(2));
    expect(api.transitionCampaign.mock.calls[0][0]).toMatchObject({
      expectedRevision: 7,
      requestId: "20000000-0000-4000-8000-000000000111",
    });
    expect(api.transitionCampaign.mock.calls[1][0]).toMatchObject({
      expectedRevision: 8,
      requestId: "20000000-0000-4000-8000-000000000112",
      note: "Verified committee",
    });
  });

  it("requires a closure outcome and reason and sends the coordinator-only command", async () => {
    const initial = liveWriterWorkspace();
    const closed = liveWriterWorkspace({
      status: "closed",
      revision: 8,
      outcome: "withdrawn",
      outcomeReason: "Unit scope changed.",
      closedAt: "2026-07-24T12:00:00Z",
    });
    const requestId = "20000000-0000-4000-8000-000000000121";
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => requestId) });
    const api = {
      loadWorkspace: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(closed),
      transitionCampaign: vi.fn(),
      setCampaignStatus: vi.fn().mockResolvedValue({
        changed: true,
        requestId,
        campaignId: initial.campaigns[0].id,
        status: "closed",
        outcome: "withdrawn",
        revision: 8,
        auditEventId: "30000000-0000-4000-8000-000000000121",
      }),
      createCampaign: vi.fn(),
    };

    render(<OrganizeView data={data} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage status" }));
    const dialog = screen.getByRole("dialog", { name: "Manage campaign status" });
    fireEvent.click(within(dialog).getByLabelText("Close permanently"));
    const outcome = within(dialog).getByLabelText("Closure outcome");
    const reason = within(dialog).getByLabelText("Reason or operating note");
    expect(outcome).toBeRequired();
    expect(reason).toBeRequired();
    expect(within(dialog).queryByRole("option", { name: "Established" })).not.toBeInTheDocument();
    fireEvent.change(outcome, { target: { value: "withdrawn" } });
    fireEvent.change(reason, { target: { value: "Unit scope changed." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Update status" }));

    await waitFor(() => expect(api.setCampaignStatus).toHaveBeenCalledWith({
      campaignId: initial.campaigns[0].id,
      expectedRevision: 7,
      status: "closed",
      outcome: "withdrawn",
      reason: "Unit scope changed.",
      requestId,
    }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Manage status" })).not.toBeInTheDocument());
  });

  it("keeps committed data visible and freezes writers when refresh fails", async () => {
    const initial = liveWriterWorkspace();
    const requestId = "20000000-0000-4000-8000-000000000131";
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => requestId) });
    const api = {
      loadWorkspace: vi.fn().mockResolvedValueOnce(initial).mockRejectedValueOnce(new Error("offline")),
      transitionCampaign: vi.fn().mockResolvedValue({
        changed: true,
        requestId,
        campaignId: initial.campaigns[0].id,
        stage: "committee",
        revision: 8,
        auditEventId: "30000000-0000-4000-8000-000000000131",
      }),
      setCampaignStatus: vi.fn(),
      createCampaign: vi.fn(),
    };

    render(<OrganizeView data={data} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Record milestone" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save milestone" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // The dialog node leaves in the commit, but useModalDialog lifts the
    // background's inert and aria-hidden in its effect cleanup, which React can
    // flush a tick later. Wait for the page to be exposed again, so the absent
    // writer buttons below are absent, not merely hidden.
    expect(await screen.findByRole("heading", { name: "Recorded lifecycle" })).toBeInTheDocument();
    expect(screen.getByText(/Change saved. Do not repeat it/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record milestone" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage status" })).not.toBeInTheDocument();
    expect(api.transitionCampaign).toHaveBeenCalledTimes(1);
  });

  it("renders the typed bargaining docket with canonical held sessions and safe evidence copy", async () => {
    const workspace = liveBargainingWorkspace();
    render(<OrganizeView data={data} api={{ loadWorkspace: vi.fn().mockResolvedValue(workspace) }} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Metro Dispatch First Contract/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Bargaining" }));

    expect(screen.getAllByText("At the table").length).toBeGreaterThan(0);
    expect(screen.getByText("Held")).toBeInTheDocument();
    expect(screen.queryByText("completed", { exact: false })).not.toBeInTheDocument();
    expect(screen.getAllByText(/does not collect ballots or make a legal determination/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Record next phase" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add proposal version" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Schedule session" })).toBeInTheDocument();
  });

  it("retries one unchanged session schedule with the same request and private agenda", async () => {
    const initial = liveBargainingWorkspace();
    const updated = liveBargainingWorkspace({
      revision: initial.bargaining[0].revision + 1,
      sessions: [
        {
          id: "session-6",
          sessionNumber: 6,
          startsAt: "2026-08-03T14:00:00.000Z",
          location: "Union hall",
          status: "scheduled",
          revision: 1,
          summary: "",
        },
        ...initial.bargaining[0].sessions,
      ],
    });
    const stableRequestId = "20000000-0000-4000-8000-000000000201";
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => stableRequestId) });
    const temporary = Object.assign(new Error("statement timeout"), { code: "57014" });
    const api = {
      loadWorkspace: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(updated),
      scheduleBargainingSession: vi.fn()
        .mockRejectedValueOnce(temporary)
        .mockResolvedValueOnce({
          changed: true,
          requestId: stableRequestId,
          campaignId: "campaign-metro-dispatch",
          cycleId: "bargaining-metro",
          sessionId: "session-6",
          sessionNumber: 6,
          status: "scheduled",
          revision: 1,
          auditEventId: "30000000-0000-4000-8000-000000000201",
        }),
    };

    render(<OrganizeView data={data} api={api} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Metro Dispatch First Contract/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Bargaining" }));
    fireEvent.click(screen.getByRole("button", { name: "Schedule session" }));
    const dialog = screen.getByRole("dialog", { name: "Schedule bargaining session" });
    fireEvent.change(within(dialog).getByLabelText("Starts"), { target: { value: "2026-08-03T10:00" } });
    fireEvent.change(within(dialog).getByLabelText("Location (optional)"), { target: { value: "Union hall" } });
    fireEvent.change(within(dialog).getByLabelText("Agenda (restricted)"), { target: { value: "Private wage proposal details" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /reviewed every worker-facing field/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save record" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The record could not be saved.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save record" }));

    await waitFor(() => expect(api.scheduleBargainingSession).toHaveBeenCalledTimes(2));
    expect(api.scheduleBargainingSession.mock.calls[0][0]).toEqual(
      api.scheduleBargainingSession.mock.calls[1][0],
    );
    expect(api.scheduleBargainingSession.mock.calls[0][0]).toMatchObject({
      requestId: stableRequestId,
      agenda: "Private wage proposal details",
      location: "Union hall",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("Bargaining record saved.");
  });

  it("collects only aggregate ratification inputs and labels not-required as sourced", async () => {
    const workspace = liveBargainingWorkspace({ phase: "ratification", status: "ratification" });
    render(<OrganizeView data={data} api={{
      loadWorkspace: vi.fn().mockResolvedValue(workspace),
      recordRatification: vi.fn(),
    }} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Metro Dispatch First Contract/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Bargaining" }));
    fireEvent.click(screen.getByRole("button", { name: "Record external result" }));
    const dialog = screen.getByRole("dialog", { name: "Record external ratification result" });

    expect(within(dialog).getByLabelText("Eligible aggregate")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Approve aggregate")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/worker name/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/individual vote/i)).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Decision method"), {
      target: { value: "not_required" },
    });
    expect(within(dialog).getByLabelText("Eligible aggregate")).toBeDisabled();
    expect(within(dialog).getByText(/“Not required” is a sourced product record, not a legal conclusion/i)).toBeInTheDocument();
  });

  it("overlays a committed correction when the post-save refresh fails", async () => {
    const initial = liveBargainingWorkspace({
      phase: "complete",
      status: "complete",
      canWrite: false,
      canCertify: false,
      canCorrectRatification: true,
      ratifications: [{
        id: "ratification-current",
        heldOn: "2026-07-20",
        current: true,
        corrected: false,
        outcome: "approved",
        verification: "staff_recorded_external_aggregate",
      }],
      firstContract: {
        signedOn: "2026-07-21",
        effectiveOn: "2026-07-22",
        expiresOn: "2029-07-21",
        status: "executed",
        verification: "staff_recorded_executed_agreement",
      },
    });
    const campaign = initial.campaigns.find((item) => item.id === "campaign-metro-dispatch");
    campaign.stage = "first_contract";
    const requestId = "20000000-0000-4000-8000-000000000301";
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => requestId) });
    const api = {
      loadWorkspace: vi.fn().mockResolvedValueOnce(initial).mockRejectedValueOnce(new Error("offline")),
      correctRatification: vi.fn().mockResolvedValue({
        changed: true,
        corrected: true,
        requestId,
        campaignId: campaign.id,
        cycleId: "bargaining-metro",
        ratificationId: "ratification-current",
        correctionId: "correction-current",
        reasonCode: "source_error",
        integrityHold: true,
        revision: 17,
        campaignRevision: 12,
        auditEventId: "30000000-0000-4000-8000-000000000301",
      }),
    };

    render(<OrganizeView data={data} api={api} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Metro Dispatch First Contract/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Bargaining" }));
    fireEvent.click(screen.getByRole("button", { name: /Correct current record/ }));
    const dialog = screen.getByRole("dialog", { name: "Correct ratification authorization" });
    fireEvent.change(within(dialog).getByLabelText("Restricted source reference"), {
      target: { value: "Corrected official record" },
    });
    fireEvent.change(within(dialog).getByLabelText("Source SHA-256"), {
      target: { value: "a".repeat(64) },
    });
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Append correction" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText(/Change saved. Do not repeat it/i)).toBeInTheDocument();
    expect(screen.getByText("Corrected")).toBeInTheDocument();
    expect(screen.getByText("Correction reason: Source error")).toBeInTheDocument();
    expect(screen.queryByText("Current sourced record")).not.toBeInTheDocument();
    expect(screen.getByText(/Ratification authorization was corrected after execution/i)).toBeInTheDocument();
    expect(api.correctRatification).toHaveBeenCalledTimes(1);
  });

  // Before the governed exit existed the hold could only be cleared by a DBA
  // disabling an integrity trigger, so the control has to be reachable AND has
  // to send a note — the note is the whole product record of the resolution.
  it("offers the governed resolution while a ratification integrity hold is active", async () => {
    const held = liveBargainingWorkspace({
      phase: "complete",
      status: "complete",
      canWrite: false,
      canCertify: false,
      canCorrectRatification: false,
      ratificationIntegrityHold: true,
      revision: 17,
    });
    const cleared = liveBargainingWorkspace({
      phase: "complete",
      status: "complete",
      canWrite: false,
      canCertify: false,
      canCorrectRatification: false,
      ratificationIntegrityHold: false,
      revision: 18,
    });
    const requestId = "20000000-0000-4000-8000-000000000401";
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => requestId) });
    const resolveRatificationIntegrityHold = vi.fn().mockResolvedValue({
      changed: true,
      idempotent: false,
      requestId,
      campaignId: "campaign-metro-dispatch",
      cycleId: "bargaining-metro",
      phase: "complete",
      revision: 18,
      correctionId: "correction-current",
      integrityHold: false,
      auditEventId: "30000000-0000-4000-8000-000000000401",
    });
    const api = {
      loadWorkspace: vi.fn().mockResolvedValueOnce(held).mockResolvedValue(cleared),
      resolveRatificationIntegrityHold,
    };

    render(<OrganizeView data={data} api={api} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Metro Dispatch First Contract/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Bargaining" }));
    expect(screen.getByText(/Ratification authorization was corrected after execution/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Resolve integrity hold/ }));

    const dialog = screen.getByRole("dialog", { name: "Resolve the ratification integrity hold" });
    fireEvent.change(within(dialog).getByLabelText("Why the hold is being lifted"), {
      target: { value: "Executive board reviewed the corrected tally and reaffirmed the contract." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record resolution" }));

    await waitFor(() => expect(resolveRatificationIntegrityHold).toHaveBeenCalledTimes(1));
    expect(resolveRatificationIntegrityHold).toHaveBeenCalledWith({
      cycleId: "bargaining-metro",
      expectedCycleRevision: 17,
      resolutionNote: "Executive board reviewed the corrected tally and reaffirmed the contract.",
      requestId,
    });
    await waitFor(() => expect(screen.getByText("Integrity hold resolved.")).toBeInTheDocument());
    expect(screen.queryByText(/Ratification authorization was corrected after execution/i)).not.toBeInTheDocument();
  });

  it("hides the resolution control when no hold is active or no writer is wired", async () => {
    const noHold = liveBargainingWorkspace({ phase: "complete", status: "complete", ratificationIntegrityHold: false });
    render(<OrganizeView data={data} api={{ loadWorkspace: vi.fn().mockResolvedValue(noHold), resolveRatificationIntegrityHold: vi.fn() }} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Metro Dispatch First Contract/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Bargaining" }));
    expect(screen.queryByRole("button", { name: /Resolve integrity hold/ })).toBeNull();

    // Held, but the api has no writer wired: no control rather than a button
    // that can only fail.
    const held = liveBargainingWorkspace({ phase: "complete", status: "complete", ratificationIntegrityHold: true });
    render(<OrganizeView data={data} api={{ loadWorkspace: vi.fn().mockResolvedValue(held) }} />);
    await waitFor(() => expect(screen.getAllByRole("tab", { name: "Bargaining" }).length).toBeGreaterThan(1));
    expect(screen.queryByRole("button", { name: /Resolve integrity hold/ })).toBeNull();
  });

  // The coverage ratios and the coalition/commitment chips were the last
  // English strings on this surface: the ratio label came baked into
  // lifecycleMetrics, and the two status chips printed raw database slugs.
  it("renders coverage ratios, suppression labels and status chips in Spanish", async () => {
    render(
      <LanguageProvider lang="es">
        <OrganizeView data={data} api={createLifecycleDemoApi(lifecycleFallback)} />
      </LanguageProvider>,
    );
    fireEvent.click(await screen.findByRole("radio", { name: /Metro Dispatch First Contract/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Negociación" }));
    fireEvent.click(screen.getByRole("tab", { name: "Lugares" }));

    // Visible ratio: "67 de 73 · 92%", not the "ok" status code and not "of".
    expect(screen.getByText("67 de 73 · 92%")).toBeInTheDocument();
    expect(screen.queryByText(/ok/)).toBeNull();
    // The committee bar is drawn against the denominator its suppression gate
    // was computed on (contacted), not against the eligible estimate.
    expect(screen.getByText("Cobertura del comité entre las contactadas")).toBeInTheDocument();
    expect(screen.getByText("9 de 67 · 13%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Coaliciones" }));
    expect(screen.getAllByText("En curso").length).toBeGreaterThan(0);
    expect(screen.queryByText("in progress")).toBeNull();
    expect(screen.getAllByText("Activo").length).toBeGreaterThan(0);
  });

  it("suppresses the coverage ratio with the locale's own privacy label", async () => {
    render(
      <LanguageProvider lang="es">
        <OrganizeView data={data} api={createLifecycleDemoApi(lifecycleFallback)} />
      </LanguageProvider>,
    );
    fireEvent.click(await screen.findByRole("tab", { name: "Lugares" }));
    expect(screen.getAllByText("No se muestra").length).toBeGreaterThan(0);
    expect(screen.queryByText("Not shown")).toBeNull();
    expect(screen.queryByText("suppressed")).toBeNull();
  });

  it("does not offer held for a session before the verified bargaining start", async () => {
    const workspace = liveBargainingWorkspace({
      bargainingStartedOn: "2026-07-20",
      sessions: [{
        id: "session-before-start",
        sessionNumber: 1,
        startsAt: "2026-07-19T16:00:00.000Z",
        location: "Union hall",
        status: "scheduled",
        revision: 1,
        summary: "",
      }],
    });
    render(<OrganizeView data={data} api={{
      loadWorkspace: vi.fn().mockResolvedValue(workspace),
      recordBargainingSessionOutcome: vi.fn(),
    }} />);

    fireEvent.click(await screen.findByRole("radio", { name: /Metro Dispatch First Contract/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Bargaining" }));
    fireEvent.click(screen.getByRole("button", { name: /Record outcome/ }));
    const dialog = screen.getByRole("dialog", { name: "Record session outcome" });
    const status = within(dialog).getByLabelText("Outcome");
    expect(status).toHaveValue("cancelled");
    expect(within(status).getByRole("option", { name: "Held" })).toBeDisabled();
    expect(within(status).getByRole("option", { name: "Cancelled" })).toBeEnabled();
  });
});

// This file keeps a private ~340-entry en/es table instead of using the
// app-wide catalogue, and the app-wide catalogue is the thing with a parity
// test. That gap is how untranslated English prose and raw database slugs
// reached Spanish readers here. Until the migration happens, guard the tables
// where they live.
describe("OrganizeView locale table parity", () => {
  const nested = (table) => Object.entries(table).filter(([, value]) => value && typeof value === "object");

  for (const [name, table] of Object.entries(ORGANIZE_LOCALE_TABLES)) {
    it(`${name} has the same keys in en and es`, () => {
      expect(Object.keys(table)).toEqual(["en", "es"]);
      expect(Object.keys(table.es).sort()).toEqual(Object.keys(table.en).sort());
      // Nested groups (COPY.tabs) drift independently of their parent.
      for (const [group, enGroup] of nested(table.en)) {
        expect(Object.keys(table.es[group] || {}).sort(), `${name}.${group}`).toEqual(Object.keys(enGroup).sort());
      }
    });

    it(`${name} resolves every key to a non-empty string`, () => {
      for (const locale of ["en", "es"]) {
        for (const [key, value] of Object.entries(table[locale])) {
          if (value && typeof value === "object") {
            for (const [nestedKey, nestedValue] of Object.entries(value)) {
              expect(typeof nestedValue, `${name}.${locale}.${key}.${nestedKey}`).toBe("string");
              expect(nestedValue.trim().length, `${name}.${locale}.${key}.${nestedKey} empty`).toBeGreaterThan(0);
            }
            continue;
          }
          expect(typeof value, `${name}.${locale}.${key}`).toBe("string");
          expect(value.trim().length, `${name}.${locale}.${key} empty`).toBeGreaterThan(0);
        }
      }
    });
  }

  // The es table must not simply mirror the en strings: that is what "a key
  // exists in both" fails to catch, and it is the exact shape of the defect.
  it("actually translates the COPY table rather than copying English across", () => {
    const shared = Object.entries(ORGANIZE_LOCALE_TABLES.COPY.en)
      .filter(([key, value]) => typeof value === "string" && ORGANIZE_LOCALE_TABLES.COPY.es[key] === value);
    // A handful of proper nouns and short tokens legitimately match.
    expect(shared.length, `identical en/es COPY values: ${shared.map(([k]) => k).join(", ")}`).toBeLessThan(12);
  });
});
