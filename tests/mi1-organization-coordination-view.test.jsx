// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deskState = vi.hoisted(() => ({ props: null }));

vi.mock("../src/features/coordination/ui/OrganizationCoordinationDesk.jsx", () => ({
  OrganizationCoordinationDesk(props) {
    deskState.props = props;
    return <div>
      <span data-testid="desk-status">{props.status}</span>
      <span data-testid="desk-notice">{props.notice}</span>
      <span data-testid="desk-extensions">{props.extensions?.state}</span>
      {props.extensions?.stale ? <p role="status">Directory may be out of date; reload to refresh.</p> : null}
      <button onClick={props.onShowDirectoryExtensions}>show directory</button>
      <button onClick={props.onRetry}>retry</button>
      <button onClick={props.onLoadMore}>more</button>
      <button onClick={props.onLoadMoreMessages}>more messages</button>
      <button onClick={() => props.onCreate({ kind: "mission", title: "Mission" })}>create</button>
      <button onClick={() => props.onJoin({ id: "committee-1", kind: "committee" })}>join</button>
      <button onClick={() => props.onJoin({ id: "mission-1", kind: "mission" })}>join member</button>
      <button onClick={() => props.onTransition({ id: "record-1" }, "activate", { points: 1 })}>transition</button>
      <button onClick={() => props.onRespond({ id: "record-1" }, true)}>respond</button>
      <button onClick={() => props.onRespond({ id: "record-1" }, false)}>respond decline</button>
      <button onClick={() => props.onMessage("conversation-1", "Hello")}>message</button>
      <button onClick={() => props.onRunExport({ id: "schedule-1", config: { format: "json" } })}>export</button>
      <button onClick={() => props.onDownloadExport("run-1")}>download export</button>
      <button onClick={() => props.onOutreach({ campaignId: "campaign-1" })}>outreach</button>
      <button onClick={() => props.onSaveProfile({ displayName: "Network" })}>profile</button>
      <button onClick={() => props.onSetPermission({ networkRecordId: "network-1" })}>permission</button>
      <button onClick={() => props.onResource({ recordId: "network-1" })}>resource</button>
      <button onClick={() => props.onRespondResource("resource-1", false)}>resource response</button>
      <button onClick={() => props.onRespondResource("resource-1", true)}>resource accept</button>
      <button onClick={() => props.onOpenSharedDocument("resource-1")}>document</button>
      <button onClick={() => props.onInviteOrganization({ recordId: "coalition-1" })}>invite</button>
      <button onClick={() => props.onRespondParticipant("coalition-1", false)}>participant response</button>
      <button onClick={() => props.onRespondParticipant("coalition-1", true)}>participant accept</button>
      <button onClick={() => props.onAssignParticipant({ recordId: "committee-1" })}>assign</button>
      <button onClick={() => props.onProposeCoalitionDecision({ campaignId: "campaign-1" })}>propose</button>
      <button onClick={() => props.onVoteCoalitionDecision({ decisionId: "decision-1" })}>vote</button>
      <button onClick={() => props.onReviewMergeMatch({ planId: "plan-1" })}>review merge</button>
      <button onClick={() => props.onExecuteMerge({ planId: "plan-1" })}>execute merge</button>
      <button onClick={() => props.onSaveChapterProfile({ chapterCode: "wor", titleEn: "Worcester" })}>save chapter profile</button>
      <button onClick={() => props.onSaveMicrositeSection({ slug: "help" })}>save section</button>
      <button onClick={() => props.onSaveMicrositePage({ slug: "hours" })}>save page</button>
      <button onClick={() => props.onAttachPublicPageDocument({ pageSlug: "hours" })}>attach public</button>
      <button onClick={() => props.onTakeOverPublicPage({ pageSlug: "hours" })}>take over public</button>
      <button onClick={() => props.onRecommendCoverage("wor")}>coverage</button>
    </div>;
  },
}));

import {
  classifyCoordinationRefusal,
  createOrganizationCoordinationAdapter,
} from "../src/features/coordination/adapter.js";
import { OrganizationCoordinationView } from "../src/views/OrganizationCoordinationView.jsx";
import { EMPTY_COORDINATION_EXTENSIONS } from "../src/features/coordination/contract.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const actor = {
  userId: "user-1",
  organizationId: "org-1",
  membershipStatus: "active",
  selectedHat: "coordinator",
  organizationRoles: ["coordinator"],
  chapterRoles: [],
  mfaSatisfied: true,
};

function readyModel(overrides = {}) {
  return {
    state: "ready",
    organizationId: "org-1",
    records: [{ id: "record-1", kind: "mission", title: "Mission" }],
    nextRecordsCursor: null,
    messages: [],
    nextMessagesCursor: null,
    ...overrides,
  };
}

function api(overrides = {}) {
  const result = {};
  for (const name of [
    "create", "join", "transition", "respond", "message", "runExport", "outreach",
    "loadExportPayload",
    "saveProfile", "setPermission", "resource", "respondResource", "loadSharedDocument",
    "inviteOrganization", "respondParticipant", "assignParticipant",
    "proposeCoalitionDecision", "voteCoalitionDecision", "reviewMergeMatch", "executeMerge",
    "saveChapterProfile", "saveMicrositeSection", "saveMicrositePage",
    "attachPublicPageDocument", "takeOverPublicPage", "recommendCoverage",
  ]) result[name] = vi.fn(async () => ({ ok: true }));
  result.load = vi.fn(async () => readyModel());
  result.loadDirectoryExtensions = vi.fn(async () => ({ ...EMPTY_COORDINATION_EXTENSIONS, state: "ready", organizationId: "org-1" }));
  result.loadMore = vi.fn(async () => ({ records: [], nextRecordsCursor: null }));
  result.loadMoreMessages = vi.fn(async () => ({ messages: [], nextMessagesCursor: null }));
  result.loadExportPayload = vi.fn(async () => ({ filename: "coordination.csv", mimeType: "text/csv", content: "id,title\nrecord-1,Mission" }));
  return Object.assign(result, overrides);
}

const client = {
  rpc: vi.fn(async () => ({
    data: [{ selected: true, organizationId: "org-1", chapterId: "wor", organizationRoles: ["coordinator"], chapterRoles: [] }],
    error: null,
  })),
};

async function waitForFinalScopedLoad(adapter) {
  let scopedLoad;
  await waitFor(() => {
    const index = adapter.load.mock.calls.findIndex(([loadedActor]) => loadedActor.chapterId === "wor");
    expect(index).toBeGreaterThanOrEqual(0);
    scopedLoad = adapter.load.mock.results[index].value;
  });
  await scopedLoad;
  await waitFor(() => {
    expect(deskState.props.actor.chapterId).toBe("wor");
    expect(screen.getByTestId("desk-status")).toHaveTextContent("ready");
  });
}

describe("organization coordination route controller", () => {
  beforeEach(() => {
    deskState.props = null;
    client.rpc.mockClear();
    Object.defineProperty(globalThis.URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:coordination") });
    Object.defineProperty(globalThis.URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(globalThis.HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  it("leaves status error and exposes Try again when adapter.load rejects", async () => {
    const adapter = api({ load: vi.fn().mockRejectedValue(new Error("coordination snapshot failed")) });
    render(<OrganizationCoordinationView actor={actor} client={client} api={adapter} />);
    await waitFor(() => expect(screen.getByTestId("desk-status")).toHaveTextContent("error"));
    const calls = adapter.load.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    await waitFor(() => expect(adapter.load.mock.calls.length).toBeGreaterThan(calls));
  });

  it("leaves status error when adapter.load hangs past the deadline", async () => {
    const adapter = api({ load: vi.fn(() => new Promise(() => {})) });
    render(<OrganizationCoordinationView actor={actor} client={client} api={adapter} loadDeadlineMs={40} />);
    await waitFor(() => expect(screen.getByTestId("desk-status")).toHaveTextContent("error"));
    const calls = adapter.load.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(adapter.load.mock.calls.length).toBe(calls + 1);
  });

  it("runs every desk intent through the adapter and refreshes the projection", async () => {
    const adapter = api();
    render(<OrganizationCoordinationView actor={actor} client={client} api={adapter} />);
    await waitFor(() => expect(screen.getByTestId("desk-status")).toHaveTextContent("ready"));
    fireEvent.click(screen.getByRole("button", { name: "more" }));
    expect(adapter.loadMore).not.toHaveBeenCalled();
    const actions = [
      "create", "join", "join member", "transition", "respond", "respond decline", "message", "export", "download export", "outreach", "profile",
      "permission", "resource", "resource response", "resource accept", "invite", "participant response", "participant accept", "assign",
      "propose", "vote", "review merge", "execute merge",
      "save chapter profile", "save section", "save page", "attach public", "take over public",
    ];
    for (const label of actions) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(deskState.props.busy).toBe(false));
    }
    fireEvent.click(screen.getByRole("button", { name: "document" }));
    fireEvent.click(screen.getByRole("button", { name: "coverage" }));
    expect(adapter.load.mock.calls.length).toBeGreaterThanOrEqual(actions.length + 1);
    expect(adapter.join).toHaveBeenCalledWith(expect.objectContaining({ chapterId: "wor" }), "committee-1", "committee_member");
    expect(adapter.respondResource).toHaveBeenCalledWith(expect.any(Object), "resource-1", false);
    expect(adapter.recommendCoverage).toHaveBeenCalledWith(expect.any(Object), "wor");
    expect(adapter.loadExportPayload).toHaveBeenCalledWith(expect.any(Object), "run-1");
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith("blob:coordination");
  });

  it("merges a successful older page once and reports a paging failure", async () => {
    const adapter = api({
      load: vi.fn(async () => readyModel({ nextRecordsCursor: { updatedAt: "2026-08-01T00:00:00Z", id: "record-1" } })),
      loadMore: vi.fn()
        .mockResolvedValueOnce({ records: [{ id: "record-2", kind: "mission", title: "Older" }, { id: "record-1", title: "Refreshed" }], nextRecordsCursor: null })
        .mockRejectedValueOnce(new Error("offline")),
    });
    const { rerender } = render(<OrganizationCoordinationView actor={actor} client={client} api={adapter} />);
    await waitForFinalScopedLoad(adapter);
    fireEvent.click(screen.getByRole("button", { name: "more" }));
    await waitFor(() => expect(deskState.props.model.records).toHaveLength(2));
    expect(deskState.props.model.records.find((record) => record.id === "record-1").title).toBe("Refreshed");
    rerender(<OrganizationCoordinationView actor={{ ...actor, userId: "user-2" }} client={client} api={adapter} />);
    await waitFor(() => expect(deskState.props.model.nextRecordsCursor).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "more" }));
    await waitFor(() => expect(screen.getByTestId("desk-notice")).toHaveTextContent("could not be loaded"));
  });

  it("merges chronological message pages without duplicating existing messages", async () => {
    const adapter = api({
      load: vi.fn(async () => readyModel({
        messages: [{ id: "message-2", body: "Current" }],
        nextMessagesCursor: { createdAt: "2026-08-01T00:00:00Z", id: "message-2" },
      })),
      loadMoreMessages: vi.fn(async () => ({
        messages: [{ id: "message-1", body: "Older" }, { id: "message-2", body: "Refreshed" }],
        nextMessagesCursor: null,
      })),
    });
    render(<OrganizationCoordinationView actor={actor} client={client} api={adapter} />);
    await waitForFinalScopedLoad(adapter);
    fireEvent.click(screen.getByRole("button", { name: "more messages" }));
    await waitFor(() => expect(deskState.props.model.messages).toHaveLength(2));
    expect(deskState.props.model.messages.find((message) => message.id === "message-2").body).toBe("Refreshed");
    expect(deskState.props.model.nextMessagesCursor).toBeNull();
  });

  // Record 8435: the desk's controls stay focusable while a write runs, so the
  // controller refuses a second write that starts before React commits busy.
  it("runs one desk write when two start in the same tick", async () => {
    let release;
    const adapter = api({ create: vi.fn(() => new Promise((resolve) => { release = resolve; })) });
    render(<OrganizationCoordinationView actor={actor} client={client} api={adapter} />);
    await waitFor(() => expect(screen.getByTestId("desk-status")).toHaveTextContent("ready"));
    let second;
    act(() => {
      deskState.props.onCreate({ kind: "mission", title: "Mission" });
      second = deskState.props.onCreate({ kind: "mission", title: "Mission" });
    });
    await expect(second).resolves.toBeUndefined();
    expect(adapter.create).toHaveBeenCalledTimes(1);
    await act(async () => { release({ ok: true }); });
    await waitFor(() => expect(screen.getByTestId("desk-notice")).not.toBeEmptyDOMElement());
  });

  it("shows the two-step notice only for a 42501 MFA refusal", async () => {
    const adapter = api({
      create: vi.fn().mockRejectedValue(Object.assign(new Error("mfa required"), { code: "42501" })),
    });
    render(<OrganizationCoordinationView actor={actor} client={client} api={adapter} />);
    await waitFor(() => expect(screen.getByTestId("desk-status")).toHaveTextContent("ready"));
    fireEvent.click(screen.getByRole("button", { name: "create" }));
    await waitFor(() => expect(screen.getByTestId("desk-notice")).toHaveTextContent("Complete two-step sign-in and try again."));
  });

  it("keeps the generic save-failure notice when an MFA substring arrives without 42501", async () => {
    const adapter = api({
      create: vi.fn().mockRejectedValue(Object.assign(new Error("mfa required for this operation"), { code: "PGRST301" })),
    });
    render(<OrganizationCoordinationView actor={actor} client={client} api={adapter} />);
    await waitFor(() => expect(screen.getByTestId("desk-status")).toHaveTextContent("ready"));
    fireEvent.click(screen.getByRole("button", { name: "create" }));
    await waitFor(() => expect(screen.getByTestId("desk-notice")).toHaveTextContent("That coordination change could not be saved."));
    expect(screen.getByTestId("desk-notice")).not.toHaveTextContent("two-step");
  });

  it("keeps the generic save-failure notice for a 42501 authorization refusal", async () => {
    const adapter = api({
      create: vi.fn().mockRejectedValue(Object.assign(new Error("coordination staff role required"), { code: "42501" })),
    });
    render(<OrganizationCoordinationView actor={actor} client={client} api={adapter} />);
    await waitFor(() => expect(screen.getByTestId("desk-status")).toHaveTextContent("ready"));
    fireEvent.click(screen.getByRole("button", { name: "create" }));
    await waitFor(() => expect(screen.getByTestId("desk-notice")).toHaveTextContent("That coordination change could not be saved."));
    expect(screen.getByTestId("desk-notice")).not.toHaveTextContent("two-step");
  });

  it("classifies the same three refusals the mount-read snapshot uses", async () => {
    const cases = [
      { error: Object.assign(new Error("mfa required"), { code: "42501" }), refusal: "mfa_required", state: "mfa_required" },
      { error: Object.assign(new Error("mfa required for this operation"), { code: "PGRST301" }), refusal: "other", state: "error" },
      { error: Object.assign(new Error("coordination staff role required"), { code: "42501" }), refusal: "unauthorized", state: "unauthorized" },
    ];
    for (const { error, refusal, state } of cases) {
      expect(classifyCoordinationRefusal(error)).toBe(refusal);
      const wired = createOrganizationCoordinationAdapter({
        rpc: vi.fn(async () => ({ data: null, error })),
      });
      await expect(wired.load(actor)).resolves.toMatchObject({ state });
    }
  });

  it("renders success and failure notices in the reader's language", async () => {
    const adapter = api({
      load: vi.fn(async () => readyModel({ nextRecordsCursor: { updatedAt: "2026-08-01T00:00:00Z", id: "record-1" } })),
      loadMore: vi.fn().mockRejectedValue(new Error("offline")),
    });
    const view = (lang) => <LanguageProvider lang={lang}><OrganizationCoordinationView actor={actor} client={client} api={adapter} /></LanguageProvider>;
    const { rerender } = render(view("es"));
    await waitForFinalScopedLoad(adapter);
    fireEvent.click(screen.getByRole("button", { name: "create" }));
    await waitFor(() => expect(screen.getByTestId("desk-notice")).toHaveTextContent("Registro de coordinación creado."));
    fireEvent.click(screen.getByRole("button", { name: "more" }));
    await waitFor(() => expect(screen.getByTestId("desk-notice")).toHaveTextContent("No se pudieron cargar los registros de coordinación anteriores."));
    // Switching the language repaints the notice already on screen, with the
    // English wording an English reader always had.
    rerender(view("en"));
    await waitFor(() => expect(screen.getByTestId("desk-notice")).toHaveTextContent("Older coordination records could not be loaded."));
    fireEvent.click(screen.getByRole("button", { name: "create" }));
    await waitFor(() => expect(screen.getByTestId("desk-notice")).toHaveTextContent("Coordination record created."));
  });

  it("asks for the writing directory projection only when the desk control is used", async () => {
    const adapter = api();
    render(<OrganizationCoordinationView actor={actor} client={client} api={adapter} />);
    await waitForFinalScopedLoad(adapter);
    // A mount, the session-scope re-load and every re-render leave it untouched:
    // the RPC behind it writes a 'directory_viewed' audit row.
    expect(adapter.loadDirectoryExtensions).not.toHaveBeenCalled();
    expect(screen.getByTestId("desk-extensions")).toHaveTextContent("idle");
    fireEvent.click(screen.getByRole("button", { name: "show directory" }));
    await waitFor(() => expect(screen.getByTestId("desk-extensions")).toHaveTextContent("ready"));
    // Asked with the scope get_my_chapter_memberships confirmed, not the prop.
    expect(adapter.loadDirectoryExtensions).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chapterId: "wor", sessionScope: "resolved" }));
    // A second press is latched for the visit: one request, one audit row.
    fireEvent.click(screen.getByRole("button", { name: "show directory" }));
    fireEvent.click(screen.getByRole("button", { name: "show directory" }));
    await waitFor(() => expect(screen.getByTestId("desk-extensions")).toHaveTextContent("ready"));
    expect(adapter.loadDirectoryExtensions).toHaveBeenCalledTimes(1);
  });

  it("refreshes the latched projection exactly once after a mutation that changes its fields", async () => {
    // The projection is latched for the visit, and a mutation changes fields it
    // owns: accepting a coalition invitation used to leave the accepted invitation
    // still listed as actionable, and the next press on it failed. The mutation's
    // existing post-write refresh now re-reads the projection through the same
    // explicit path — one further 'directory_viewed' row per mutation, on purpose,
    // because the operator is acting on the surface they asked to see.
    const adapter = api();
    adapter.loadDirectoryExtensions = vi.fn(async () => ({
      ...EMPTY_COORDINATION_EXTENSIONS,
      state: "ready",
      organizationId: "org-1",
      invitations: adapter.respondParticipant.mock.calls.length === 0
        ? [{ recordId: "coalition-1", title: "Regional coalition", status: "invited" }]
        : [{ recordId: "coalition-1", title: "Regional coalition", status: "accepted" }],
    }));
    render(<OrganizationCoordinationView actor={actor} client={client} api={adapter} />);
    await waitForFinalScopedLoad(adapter);
    // Nothing to refresh before the operator has asked: a desk where the directory
    // was never opened records no audit row, mutations or not.
    fireEvent.click(screen.getByRole("button", { name: "create" }));
    await waitFor(() => expect(adapter.create).toHaveBeenCalled());
    await waitFor(() => expect(deskState.props.busy).toBe(false));
    expect(adapter.loadDirectoryExtensions).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "show directory" }));
    await waitFor(() => expect(screen.getByTestId("desk-extensions")).toHaveTextContent("ready"));
    expect(deskState.props.extensions.invitations[0].status).toBe("invited");

    fireEvent.click(screen.getByRole("button", { name: "participant accept" }));
    await waitFor(() => expect(adapter.respondParticipant)
      .toHaveBeenCalledWith(expect.objectContaining({ sessionScope: "resolved" }), "coalition-1", true));
    // Exactly one further read, and the desk now shows the post-mutation state.
    await waitFor(() => expect(adapter.loadDirectoryExtensions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(deskState.props.extensions.invitations[0].status).toBe("accepted"));
    expect(screen.getByTestId("desk-extensions")).toHaveTextContent("ready");
    expect(adapter.loadDirectoryExtensions).toHaveBeenCalledTimes(2);
  });

  it("issues no extensions RPC for a mutation that owns none of the projection fields", async () => {
    const adapter = api();
    render(<OrganizationCoordinationView actor={actor} client={client} api={adapter} />);
    await waitForFinalScopedLoad(adapter);
    fireEvent.click(screen.getByRole("button", { name: "show directory" }));
    await waitFor(() => expect(screen.getByTestId("desk-extensions")).toHaveTextContent("ready"));
    expect(adapter.loadDirectoryExtensions).toHaveBeenCalledTimes(1);
    for (const label of ["message", "resource", "export"]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(deskState.props.busy).toBe(false));
    }
    expect(adapter.loadDirectoryExtensions).toHaveBeenCalledTimes(1);
  });

  it("refreshes the projection exactly once for each extension-owning intent", async () => {
    const adapter = api();
    let refresh = 0;
    adapter.loadDirectoryExtensions = vi.fn(async () => ({
      ...EMPTY_COORDINATION_EXTENSIONS,
      state: "ready",
      organizationId: "org-1",
      invitations: [{ recordId: "coalition-1", title: "Regional coalition", status: refresh++ === 0 ? "invited" : "accepted" }],
    }));
    render(<OrganizationCoordinationView actor={actor} client={client} api={adapter} />);
    await waitForFinalScopedLoad(adapter);
    fireEvent.click(screen.getByRole("button", { name: "show directory" }));
    await waitFor(() => expect(screen.getByTestId("desk-extensions")).toHaveTextContent("ready"));
    expect(adapter.loadDirectoryExtensions).toHaveBeenCalledTimes(1);
    const owning = [
      "respond", "join", "assign", "transition", "profile", "permission",
      "participant accept", "review merge", "execute merge",
      "outreach",
    ];
    for (const label of owning) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(deskState.props.busy).toBe(false));
    }
    expect(adapter.loadDirectoryExtensions).toHaveBeenCalledTimes(1 + owning.length);
    await waitFor(() => expect(deskState.props.extensions.invitations[0].status).toBe("accepted"));
    expect(screen.getByTestId("desk-extensions")).toHaveTextContent("ready");
  });

  it("announces a staleness line when a post-mutation refresh is refused and keeps the retained projection", async () => {
    const adapter = api();
    const projection = {
      ...EMPTY_COORDINATION_EXTENSIONS,
      state: "ready",
      organizationId: "org-1",
      invitations: [{ recordId: "coalition-1", title: "Regional coalition", status: "invited" }],
    };
    adapter.loadDirectoryExtensions = vi.fn()
      .mockResolvedValueOnce(projection)
      .mockResolvedValueOnce({ ...EMPTY_COORDINATION_EXTENSIONS, state: "unauthorized" });
    render(<OrganizationCoordinationView actor={actor} client={client} api={adapter} />);
    await waitForFinalScopedLoad(adapter);
    fireEvent.click(screen.getByRole("button", { name: "show directory" }));
    await waitFor(() => expect(screen.getByTestId("desk-extensions")).toHaveTextContent("ready"));
    expect(deskState.props.extensions.invitations[0].status).toBe("invited");
    fireEvent.click(screen.getByRole("button", { name: "participant accept" }));
    await waitFor(() => expect(deskState.props.busy).toBe(false));
    await waitFor(() => expect(adapter.loadDirectoryExtensions).toHaveBeenCalledTimes(2));
    expect(deskState.props.extensions.state).toBe("ready");
    expect(deskState.props.extensions.invitations[0].status).toBe("invited");
    expect(deskState.props.extensions.stale).toBe(true);
    expect(screen.getByText("Directory may be out of date; reload to refresh.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "show directory" }));
    expect(adapter.loadDirectoryExtensions).toHaveBeenCalledTimes(2);
  });

  it("clears the staleness line on the next answered refresh", async () => {
    const adapter = api();
    const projection = {
      ...EMPTY_COORDINATION_EXTENSIONS,
      state: "ready",
      organizationId: "org-1",
      invitations: [{ recordId: "coalition-1", title: "Regional coalition", status: "invited" }],
    };
    adapter.loadDirectoryExtensions = vi.fn()
      .mockResolvedValueOnce(projection)
      .mockResolvedValueOnce({ ...EMPTY_COORDINATION_EXTENSIONS, state: "unauthorized" })
      .mockResolvedValueOnce({
        ...projection,
        invitations: [{ recordId: "coalition-1", title: "Regional coalition", status: "accepted" }],
      });
    render(<OrganizationCoordinationView actor={actor} client={client} api={adapter} />);
    await waitForFinalScopedLoad(adapter);
    fireEvent.click(screen.getByRole("button", { name: "show directory" }));
    await waitFor(() => expect(screen.getByTestId("desk-extensions")).toHaveTextContent("ready"));
    fireEvent.click(screen.getByRole("button", { name: "participant accept" }));
    await waitFor(() => expect(deskState.props.extensions.stale).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "participant accept" }));
    await waitFor(() => expect(adapter.loadDirectoryExtensions).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(deskState.props.extensions.stale).toBeFalsy());
    expect(deskState.props.extensions.invitations[0].status).toBe("accepted");
    expect(screen.queryByText("Directory may be out of date; reload to refresh.")).not.toBeInTheDocument();
  });

  it("discards a scope retry after the actor it was issued for is superseded", async () => {
    // retryScope used to apply whatever get_my_chapter_memberships returned, with
    // the actor captured when the press started, even after a later organization
    // switch had already resolved a different scope. The newer discovery finishing
    // first was then overwritten, re-enabling the directory control under the
    // obsolete organization.
    const pending = [];
    const scopedClient = {
      rpc: vi.fn(async (name) => {
        if (name !== "get_my_chapter_memberships") return { data: [], error: null };
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        pending.push({ held, release });
        return held;
      }),
    };
    const memberships = (organizationId) => ({
      data: [{ selected: true, organizationId, chapterId: "wor", organizationRoles: ["coordinator"], chapterRoles: [] }],
      error: null,
    });
    const adapter = api();
    const { rerender } = render(<OrganizationCoordinationView actor={actor} client={scopedClient} api={adapter} />);
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0].release({ data: null, error: new Error("offline") });
      await pending[0].held;
    });
    await waitFor(() => expect(deskState.props.actor.sessionScope).toBe("unconfirmed"));

    act(() => { void deskState.props.onRetryScope(); });
    await waitFor(() => expect(pending).toHaveLength(2));

    rerender(<OrganizationCoordinationView actor={{ ...actor, organizationId: "org-2" }} client={scopedClient} api={adapter} />);
    await waitFor(() => expect(pending).toHaveLength(3));
    await act(async () => {
      pending[2].release(memberships("org-2"));
      await pending[2].held;
    });
    await waitFor(() => {
      expect(deskState.props.actor.selectedOrganizationId).toBe("org-2");
      expect(deskState.props.actor.sessionScope).toBe("resolved");
    });

    await act(async () => {
      pending[1].release(memberships("org-1"));
      await pending[1].held;
    });
    expect(deskState.props.actor.selectedOrganizationId).toBe("org-2");
    expect(deskState.props.actor.sessionScope).toBe("resolved");
    expect(deskState.props.actor.chapterId).toBe("wor");
  });

  it("refreshes mobilization progress after outreach is recorded", async () => {
    // record_organization_coordination_outreach inserts an outreach event, and
    // get_organization_coordination_extensions derives mobilizationProgress by
    // counting those events. After the projection is open, a successful save
    // must re-read it so the reached/committed/attended totals do not stay stale.
    const adapter = api();
    adapter.loadDirectoryExtensions = vi.fn(async () => ({
      ...EMPTY_COORDINATION_EXTENSIONS,
      state: "ready",
      organizationId: "org-1",
      mobilizationProgress: adapter.outreach.mock.calls.length === 0
        ? [{ campaignId: "campaign-1", title: "Turnout", reached: 8, committed: 4, attended: 2 }]
        : [{ campaignId: "campaign-1", title: "Turnout", reached: 9, committed: 4, attended: 2 }],
    }));
    render(<OrganizationCoordinationView actor={actor} client={client} api={adapter} />);
    await waitForFinalScopedLoad(adapter);
    fireEvent.click(screen.getByRole("button", { name: "show directory" }));
    await waitFor(() => expect(screen.getByTestId("desk-extensions")).toHaveTextContent("ready"));
    expect(deskState.props.extensions.mobilizationProgress[0].reached).toBe(8);

    fireEvent.click(screen.getByRole("button", { name: "outreach" }));
    await waitFor(() => expect(adapter.outreach).toHaveBeenCalled());
    await waitFor(() => expect(deskState.props.busy).toBe(false));
    await waitFor(() => expect(adapter.loadDirectoryExtensions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(deskState.props.extensions.mobilizationProgress[0].reached).toBe(9));
    expect(screen.getByTestId("desk-extensions")).toHaveTextContent("ready");
  });

  it("sends the schedule's stored export format instead of the csv default", async () => {
    const adapter = api();
    render(<OrganizationCoordinationView actor={actor} client={client} api={adapter} />);
    await waitFor(() => expect(screen.getByTestId("desk-status")).toHaveTextContent("ready"));
    fireEvent.click(screen.getByRole("button", { name: "export" }));
    await waitFor(() => expect(adapter.runExport).toHaveBeenCalled());
    expect(adapter.runExport).toHaveBeenCalledWith(
      expect.objectContaining({ chapterId: "wor" }),
      "schedule-1",
      "json",
    );
  });

  it("builds the wired adapter when no test API is supplied", async () => {
    const rpc = vi.fn(async (name) => {
      if (name === "get_my_chapter_memberships") return { data: [{ selected: true, organizationId: "org-1", chapterId: null, organizationRoles: ["coordinator"], chapterRoles: [] }], error: null };
      if (name === "get_organization_coordination_snapshot") return { data: readyModel(), error: null };
      if (name === "get_organization_coordination_extensions") return { data: { state: "ready", organizationId: "org-1" }, error: null };
      if (name === "list_organization_coordination_messages") return { data: { messages: [], nextCursor: null }, error: null };
      if (name === "list_organization_network_access_events") return { data: [], error: null };
      if (name === "get_organization_coalition_decisions") return { data: [], error: null };
      return { data: null, error: null };
    });
    render(<OrganizationCoordinationView actor={actor} client={{ rpc }} />);
    await waitFor(() => expect(screen.getByTestId("desk-status")).toHaveTextContent("ready"));
    expect(rpc).toHaveBeenCalledWith("get_organization_coordination_snapshot", undefined);
    // The wired adapter mounts read-only; the stubbed extensions answer above is
    // never requested by a page mount.
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain("get_organization_coordination_extensions");
  });
});
