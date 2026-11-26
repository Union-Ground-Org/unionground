import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ChapterBindingCard,
  ChapterMembershipCard,
  HandshakeDocumentsCard,
} from "../src/components/ChapterLifecycleAdmin.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { loadChapterLifecycleAdmin } from "../src/lib/chapterLifecycleApi.js";

const ORGANIZATION_SCOPE = {
  scope: "organization",
  chapterId: null,
  canCreateChapter: true,
  chapters: [
    { id: "wor", name: "Harborview Care United", region: "Central" },
    { id: "bos", name: "Harborview Care Boston", region: "Metro" },
  ],
};

const CHAPTER_SCOPE = { ...ORGANIZATION_SCOPE, scope: "chapter", chapterId: "wor" };

function lifecycle(overrides = {}) {
  return {
    chapterId: "wor",
    binding: null,
    connections: [],
    handshakes: [],
    documents: [],
    events: [],
    sharedDocuments: [],
    latestHealth: null,
    ...overrides,
  };
}

function makeApi(overrides = {}) {
  return {
    searchUnionOrganizations: vi.fn().mockResolvedValue([
      { id: "tamarack-psu", name: "Tamarack Public Service Union", city: "Cedar Ridge", state: "MA", affiliation: "Tamarack" },
    ]),
    requestChapterBinding: vi.fn().mockResolvedValue({ requested: true, chapterId: "wor" }),
    verifyChapterBinding: vi.fn().mockResolvedValue({ verified: true }),
    requestConnectionSetup: vi.fn().mockResolvedValue({ status: "configuring" }),
    verifyConnectionSetup: vi.fn().mockResolvedValue({ status: "active" }),
    shareHandshakeDocument: vi.fn().mockResolvedValue({ shared: true }),
    grantChapterMembership: vi.fn().mockResolvedValue({ active: true }),
    revokeChapterMembership: vi.fn().mockResolvedValue({ active: false }),
    setChapterRole: vi.fn().mockResolvedValue({ enabled: true }),
    loadMemberDirectory: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    ...overrides,
  };
}

function mountBinding({ organization = ORGANIZATION_SCOPE, data = lifecycle(), api = makeApi(), lang = "en", railChapter = null } = {}) {
  const onNotice = vi.fn();
  const reload = vi.fn().mockResolvedValue(undefined);
  render(<LanguageProvider lang={lang}>
    <ChapterBindingCard lifecycle={data} railChapter={railChapter} organization={organization} api={api} reload={reload} onNotice={onNotice} />
  </LanguageProvider>);
  return { api, onNotice, reload };
}

describe("chapter lifecycle admin — union organization binding", () => {
  it("refuses to render partnership controls without a selected chapter", () => {
    mountBinding({ data: lifecycle({ chapterId: null }) });
    expect(screen.getByText("Your account isn't part of any campaign, so there are no campaign partnerships or connections to manage here.")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Find the real union organization" })).toBeNull();
  });

  it("searches real organizations and requests exactly one binding review", async () => {
    const { api, onNotice, reload } = mountBinding();
    const search = screen.getByRole("searchbox", { name: "Find the real union organization" });
    fireEvent.change(search, { target: { value: "Tamarack" } });
    fireEvent.submit(search.closest("form"));
    const choice = await screen.findByRole("radio", { name: /Tamarack Public Service Union/ });
    expect(api.searchUnionOrganizations).toHaveBeenCalledWith("Tamarack");

    const request = screen.getByRole("button", { name: "Request binding review" });
    expect(request).toBeDisabled();
    fireEvent.click(choice);
    fireEvent.click(request);
    await waitFor(() => expect(api.requestChapterBinding).toHaveBeenCalledWith("tamarack-psu"));
    expect(api.requestChapterBinding).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledWith("Binding review requested.");
    expect(reload).toHaveBeenCalled();
  });

  it("shows a refusal instead of a fabricated success when the request is rejected", async () => {
    const api = makeApi({ requestChapterBinding: vi.fn().mockRejectedValue(new Error("admin role required")) });
    const { onNotice } = mountBinding({ api });
    const search = screen.getByRole("searchbox", { name: "Find the real union organization" });
    fireEvent.change(search, { target: { value: "Tamarack" } });
    fireEvent.submit(search.closest("form"));
    fireEvent.click(await screen.findByRole("radio", { name: /Tamarack Public Service Union/ }));
    fireEvent.click(screen.getByRole("button", { name: "Request binding review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The campaign lifecycle action could not be confirmed.");
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("offers verification only to an organization-wide admin on a requested binding", () => {
    const requested = lifecycle({
      binding: { chapter_id: "wor", union_org_id: "tamarack-psu", status: "requested", public_note: "", union_orgs: { name: "Tamarack Public Service Union" } },
    });
    mountBinding({ data: requested, organization: CHAPTER_SCOPE });
    expect(screen.getByText("Tamarack Public Service Union · Link to this campaign: Requested")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verify binding" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject binding" })).toBeNull();
  });

  // Verification moved off the admin desk: no organization administrator,
  // organization-wide or not, verifies their own campaign's binding.
  it("offers no binding verification to any organization administrator, and says who confirms it", () => {
    const requested = lifecycle({
      binding: { chapter_id: "wor", union_org_id: "tamarack-psu", status: "requested", public_note: "", union_orgs: { name: "Tamarack Public Service Union" } },
    });
    for (const organization of [CHAPTER_SCOPE, ORGANIZATION_SCOPE]) {
      mountBinding({ data: requested, organization });
      expect(screen.getByText("Tamarack Public Service Union · Link to this campaign: Requested")).toBeInTheDocument();
      expect(screen.getByText(/administrators can change the request but cannot verify it/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Verify binding" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Reject binding" })).toBeNull();
      expect(screen.queryByLabelText("Public review note")).toBeNull();
      cleanup();
    }
  });

  it("hides the request form once a binding is verified", () => {
    mountBinding({ data: lifecycle({
      binding: { chapter_id: "wor", union_org_id: "tamarack-psu", status: "verified", public_note: "Verified by the organization", union_orgs: { name: "Tamarack Public Service Union" } },
    }) });
    expect(screen.queryByRole("searchbox", { name: "Find the real union organization" })).toBeNull();
    expect(screen.getByText("Verified by the organization")).toBeInTheDocument();
  });
});

// BUG-UG-WEB-ADMIN-HANDSHAKE-IGNORES-RAIL-CHAPTER-20261002: the page
// acts for the server's selected chapter and reconciles it with the desktop
// chapter rail in view, never by trusting the rail.
describe("chapter lifecycle admin — which chapter the page acts for", () => {
  const WOR = { chapterId: "wor", name: "Harborview Care United", selected: false };
  const BOS = { chapterId: "bos", name: "Harborview Care Boston", selected: false };
  const RAIL_WOR = { id: "wor", name: "Harborview Care United" };
  const RAIL_BOS = { id: "bos", name: "Harborview Care Boston" };
  const switchApi = (switchMyChapter = vi.fn().mockResolvedValue({ chapterId: "bos" })) => makeApi({ switchMyChapter });

  it("explains a chapterless admin's page instead of asking for a chapter it cannot pick", () => {
    const api = switchApi();
    mountBinding({ data: lifecycle({ chapterId: null, memberships: [] }), railChapter: RAIL_WOR, api });
    expect(screen.getByText("Your account isn't part of any campaign, so there are no campaign partnerships or connections to manage here.")).toBeInTheDocument();
    expect(screen.getByText("The campaign list shows Harborview Care United for browsing. It doesn't add you to it or change which campaign you act for.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Manage / })).toBeNull();
    expect(screen.queryByRole("searchbox", { name: "Find the real union organization" })).toBeNull();
  });

  it("offers the account's own chapters, the rail's first, when no chapter is selected", () => {
    mountBinding({ data: lifecycle({ chapterId: null, memberships: [WOR, BOS] }), railChapter: RAIL_BOS, api: switchApi() });
    expect(screen.getByText("Your account has no campaign selected. Choose the campaign to manage:")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Manage / }).map((button) => button.textContent)).toEqual(["Manage Harborview Care Boston", "Manage Harborview Care United"]);
    expect(screen.queryByRole("searchbox", { name: "Find the real union organization" })).toBeNull();
  });

  it("switches through the authorized path and re-reads the server's selection", async () => {
    const api = switchApi();
    const { onNotice, reload } = mountBinding({ data: lifecycle({ chapterId: null, memberships: [WOR, BOS] }), api });
    fireEvent.click(screen.getByRole("button", { name: "Manage Harborview Care Boston" }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(api.switchMyChapter).toHaveBeenCalledWith("bos");
    expect(onNotice).toHaveBeenCalledWith("You're now managing Harborview Care Boston.");
  });

  it("restores focus only after the successfully selected chapter is rendered", async () => {
    const api = switchApi();
    const onNotice = vi.fn();
    let finishReload;
    const reload = vi.fn(() => new Promise(resolve => { finishReload = resolve; }));
    const before = lifecycle({ chapterId: "wor", chapterName: "Harborview Care United", memberships: [{ ...WOR, selected: true }, BOS] });
    const card = data => <LanguageProvider lang="en"><ChapterBindingCard lifecycle={data} railChapter={RAIL_BOS}
      organization={ORGANIZATION_SCOPE} api={api} reload={reload} onNotice={onNotice} /></LanguageProvider>;
    const view = render(card(before));
    const control = screen.getByRole("button", { name: "Manage Harborview Care Boston instead" });
    control.focus();
    fireEvent.click(control);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    const target = document.getElementById("admin-chapter-handshake");
    expect(target).not.toHaveFocus();
    // The reload can settle before React commits the returned selection.
    await act(async () => { finishReload(); });
    expect(target).not.toHaveFocus();
    view.rerender(card(lifecycle({ chapterId: "bos", chapterName: "Harborview Care Boston", memberships: [WOR, { ...BOS, selected: true }] })));
    await waitFor(() => expect(target).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Manage Harborview Care Boston instead" })).toBeNull();
    expect(target).toHaveTextContent("Changes on this page apply to Harborview Care Boston.");
  });

  it("says a refused switch changed nothing, without a notice or a reload", async () => {
    const api = switchApi(vi.fn().mockRejectedValue(Object.assign(new Error("Switch chapter: foreign chapter switching denied"), { code: "42501" })));
    const { onNotice, reload } = mountBinding({ data: lifecycle({ chapterId: "wor", chapterName: "Harborview Care United", memberships: [{ ...WOR, selected: true }, BOS] }), railChapter: RAIL_BOS, api });
    const control = screen.getByRole("button", { name: "Manage Harborview Care Boston instead" });
    control.focus();
    fireEvent.click(control);
    expect(await screen.findByRole("alert")).toHaveTextContent("That campaign isn't available to your account. Nothing was changed.");
    expect(onNotice).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText("The campaign list shows Harborview Care Boston, but changes on this page apply to Harborview Care United.")).toBeInTheDocument();
    expect(control).toHaveFocus();
  });

  it("names the selected chapter, and never offers a rail chapter the account does not belong to", () => {
    mountBinding({ data: lifecycle({ chapterId: "wor", chapterName: "Harborview Care United", memberships: [{ ...WOR, selected: true }] }), railChapter: { id: "other-org", name: "Harborview Care Springfield" }, api: switchApi() });
    expect(screen.getByText("The campaign list shows Harborview Care Springfield, but your account isn't part of it. Changes on this page apply to Harborview Care United.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Manage / })).toBeNull();
    // The partnership controls stay on the server's chapter.
    expect(screen.getByRole("searchbox", { name: "Find the real union organization" })).toBeInTheDocument();
  });

  it("states the chapter plainly when the rail agrees, and when there is no rail", () => {
    mountBinding({ data: lifecycle({ chapterId: "wor", chapterName: "Harborview Care United", memberships: [{ ...WOR, selected: true }] }), railChapter: RAIL_WOR, api: switchApi() });
    expect(screen.getByText("Changes on this page apply to Harborview Care United.")).toBeInTheDocument();
    cleanup();
    mountBinding({ data: lifecycle({ chapterId: "wor", chapterName: "Harborview Care United", memberships: [{ ...WOR, selected: true }] }), api: switchApi() });
    expect(screen.getByText("Changes on this page apply to Harborview Care United.")).toBeInTheDocument();
  });

  // BUG-UG-CHAPTER-PARTNERSHIPS-DETAILS-UNAVAILABLE-20261003 (cause
  // shared with BUG-UG-WEB-CHAPTER-LIFECYCLE-QUERIES-MISSING-COLUMN-20261003):
  // the real loader, against a client that refuses an unknown column the way
  // Postgres does, loads a chapter with no partnership yet, and the page lists
  // the options and says why none exist instead of "aren't available".
  it("loads a chapter with no partnership yet and lists the options instead of saying details are unavailable", async () => {
    const reads = [];
    const client = {
      rpc: vi.fn().mockResolvedValue({ data: [{ chapterId: "wor", name: "Harborview Care United", selected: true }], error: null }),
      from: (table) => {
        let columns = "";
        const builder = {
          select: (value) => { columns = value; reads.push(table); return builder; },
          eq: () => builder,
          order: () => builder,
          limit: () => builder,
          then: (resolve) => resolve(table === "chapter_connection_readiness" && /\brequested_at\b/.test(columns)
            ? { data: null, error: { code: "42703", message: "column chapter_connection_readiness.requested_at does not exist" } }
            : { data: [], error: null }),
        };
        return builder;
      },
    };
    const data = await loadChapterLifecycleAdmin(client);
    expect(reads).toContain("chapter_connection_readiness");
    expect(data).toMatchObject({ chapterId: "wor", chapterName: "Harborview Care United", binding: null, connections: [] });
    mountBinding({ data });
    expect(screen.queryByText("Campaign partnership details aren't available right now.")).toBeNull();
    expect(screen.getByText("Changes on this page apply to Harborview Care United.")).toBeInTheDocument();
    expect(screen.getByText("No organization binding has been requested for the selected campaign.")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Find the real union organization" })).toBeInTheDocument();
    expect(screen.getByText("No optional connection setup has been requested.")).toBeInTheDocument();
  });

  it("says the details are unavailable when the lifecycle read failed, with no controls", () => {
    // BUG-UG-WEB-CHAPTER-LIFECYCLE-QUERIES-MISSING-COLUMN-20261003: a
    // failed read is its own state, never a chapter-selection prompt.
    mountBinding({ data: null, railChapter: RAIL_WOR, api: switchApi() });
    expect(screen.getByText("Campaign partnership details aren't available right now.")).toBeInTheDocument();
    expect(screen.queryByText(/no campaign selected|isn't part of any campaign|Select an active campaign/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Manage / })).toBeNull();
    expect(screen.queryByRole("searchbox", { name: "Find the real union organization" })).toBeNull();
  });

  it("speaks Spanish for the same states", () => {
    mountBinding({ data: lifecycle({ chapterId: null, memberships: [WOR] }), railChapter: RAIL_WOR, api: switchApi(), lang: "es" });
    expect(screen.getByText("Tu cuenta no tiene una campaña seleccionada. Elige la campaña que quieres administrar:")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Administrar Harborview Care United" })).toBeInTheDocument();
    expect(screen.queryByText(/admin\.chapterLifecycle\./)).toBeNull();
  });
});

describe("chapter lifecycle admin — connection setup", () => {
  it("requests setup for the chosen capability and marks a verified outcome", async () => {
    const data = lifecycle({
      connections: [{ capability: "sms", status: "configuring", provider_label: "Chapter Twilio", public_message: "Setup requested." }],
    });
    const { api } = mountBinding({ data });
    fireEvent.change(screen.getByLabelText("Capability"), { target: { value: "calendar_google" } });
    fireEvent.change(screen.getByLabelText("Provider label (optional)"), { target: { value: " Chapter Google " } });
    fireEvent.click(screen.getByRole("button", { name: "Request setup review" }));
    await waitFor(() => expect(api.requestConnectionSetup).toHaveBeenCalledWith("calendar_google", " Chapter Google "));

    fireEvent.change(screen.getByLabelText("Public verification message"), { target: { value: "Chapter-owned sender confirmed" } });
    fireEvent.click(screen.getByRole("button", { name: "Mark active" }));
    await waitFor(() => expect(api.verifyConnectionSetup).toHaveBeenCalledWith({
      chapterId: "wor", capability: "sms", status: "active", publicMessage: "Chapter-owned sender confirmed",
    }));
  });

  it("keeps verification off the chapter-scoped admin's screen", () => {
    const data = lifecycle({
      connections: [{ capability: "sms", status: "configuring", provider_label: "", public_message: "Setup requested." }],
    });
    mountBinding({ data, organization: CHAPTER_SCOPE });
    expect(screen.getByRole("button", { name: "Request setup review" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark active" })).toBeNull();
    expect(screen.queryByLabelText("Public verification message")).toBeNull();
  });
});

describe("chapter lifecycle admin — handshake document exchange", () => {
  function mountDocuments(data, api = makeApi()) {
    const onNotice = vi.fn();
    const reload = vi.fn().mockResolvedValue(undefined);
    render(<LanguageProvider lang="en">
      <HandshakeDocumentsCard lifecycle={data} api={api} reload={reload} onNotice={onNotice} />
    </LanguageProvider>);
    return { api, onNotice, reload };
  }

  it("offers only active docs-only handshakes", () => {
    mountDocuments(lifecycle({
      handshakes: [
        { id: "h-active", title: "Shared training library", status: "active", data_scope: "docs_only" },
        { id: "h-aggregate", title: "Aggregate benchmark", status: "active", data_scope: "aggregate_only" },
        { id: "h-requested", title: "Pending request", status: "requested", data_scope: "docs_only" },
      ],
      documents: [{ id: "doc-1", title: "Steward handbook" }],
    }));
    const options = within(screen.getByLabelText("Active document handshake")).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Choose a handshake", "Shared training library"]);
  });

  it("shares a published document with a fresh idempotency key", async () => {
    const { api, onNotice } = mountDocuments(lifecycle({
      handshakes: [{ id: "h-active", title: "Shared training library", status: "active", data_scope: "docs_only" }],
      documents: [{ id: "doc-1", title: "Steward handbook" }],
    }));
    const submit = screen.getByRole("button", { name: "Share document" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Active document handshake"), { target: { value: "h-active" } });
    fireEvent.change(screen.getByLabelText("Published campaign document"), { target: { value: "doc-1" } });
    fireEvent.click(submit);
    await waitFor(() => expect(api.shareHandshakeDocument).toHaveBeenCalledTimes(1));
    const [handshakeId, documentId, key] = api.shareHandshakeDocument.mock.calls[0];
    expect([handshakeId, documentId]).toEqual(["h-active", "doc-1"]);
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(onNotice).toHaveBeenCalledWith("Document shared through the active handshake.");
  });

  it("says plainly when no active docs-only handshake exists", () => {
    mountDocuments(lifecycle({ handshakes: [], documents: [] }));
    expect(screen.getByText("No active handshake allows document sharing yet.")).toBeInTheDocument();
  });
});

describe("chapter lifecycle admin — multi-chapter membership", () => {
  const PEOPLE = [
    { userId: "00000000-0000-0000-0000-000000000001", fullName: "Ana Rivera", chapterId: "wor", chapterName: "Harborview Care United", roles: ["admin"] },
  ];

  function mountMembership(api = makeApi(), lang = "en", people = PEOPLE) {
    const onNotice = vi.fn();
    const reload = vi.fn().mockResolvedValue(undefined);
    render(<LanguageProvider lang={lang}>
      <ChapterMembershipCard
        directory={{ items: people, nextCursor: null }}
        organization={ORGANIZATION_SCOPE}
        api={api}
        reload={reload}
        onNotice={onNotice}
      />
    </LanguageProvider>);
    return { api, onNotice, reload };
  }

  it("names the person, the chapter and the current roles before any change", () => {
    mountMembership();
    fireEvent.change(screen.getByLabelText("Worker"), { target: { value: PEOPLE[0].userId } });
    expect(screen.getByRole("status")).toHaveTextContent("Home campaign: Harborview Care United · Current roles: Admin");
    expect(screen.getByText(/A role applies only inside the campaign chosen in step 2/)).toBeInTheDocument();
  });

  it("grants an additional chapter membership for the exact selected pair", async () => {
    const { api, onNotice, reload } = mountMembership();
    const grant = screen.getByRole("button", { name: "Add to campaign" });
    expect(grant).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Worker"), { target: { value: PEOPLE[0].userId } });
    fireEvent.change(screen.getByLabelText("Campaign"), { target: { value: "bos" } });
    fireEvent.click(grant);
    await waitFor(() => expect(api.grantChapterMembership).toHaveBeenCalledWith(PEOPLE[0].userId, "bos"));
    expect(onNotice).toHaveBeenCalledWith("Additional campaign participation added.");
    expect(reload).toHaveBeenCalled();
  });

  it("requires an explicit confirmation before a revocation reaches the server", async () => {
    const { api } = mountMembership();
    fireEvent.change(screen.getByLabelText("Worker"), { target: { value: PEOPLE[0].userId } });
    fireEvent.change(screen.getByLabelText("Campaign"), { target: { value: "bos" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove from campaign" }));
    expect(api.revokeChapterMembership).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Remove Ana Rivera from Harborview Care Boston? Their roles in that campaign are removed too.");
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() => expect(api.revokeChapterMembership).toHaveBeenCalledWith(PEOPLE[0].userId, "bos"));
  });

  it("scopes a role grant and removal to the named chapter", async () => {
    // Remove role is offered only for a role the person holds; the directory
    // re-read after the grant returns it.
    const withCoordinator = { ...PEOPLE[0], roles: ["admin", "coordinator"] };
    const { api } = mountMembership(makeApi({ loadMemberDirectory: vi.fn().mockResolvedValue({ items: [withCoordinator], nextCursor: null }) }), "en", [withCoordinator]);
    fireEvent.change(screen.getByLabelText("Worker"), { target: { value: PEOPLE[0].userId } });
    fireEvent.change(screen.getByLabelText("Campaign"), { target: { value: "bos" } });
    fireEvent.change(screen.getByLabelText("Campaign role"), { target: { value: "coordinator" } });
    fireEvent.click(screen.getByRole("button", { name: "Grant role" }));
    await waitFor(() => expect(api.setChapterRole).toHaveBeenCalledWith(PEOPLE[0].userId, "bos", "coordinator", true));
    // A pending control stays enabled: wait for its busy state to clear.
    await waitFor(() => { const control = screen.getByRole("button", { name: "Remove role" }); expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
    fireEvent.click(screen.getByRole("button", { name: "Remove role" }));
    // Removing a role now asks first, naming the role, the person and the campaign.
    const dialog = screen.getByRole("dialog", { name: "Remove the Campaign lead role from Ana Rivera in Harborview Care Boston?" });
    expect(api.setChapterRole).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Campaign lead in Harborview Care Boston" }));
    await waitFor(() => expect(api.setChapterRole).toHaveBeenLastCalledWith(PEOPLE[0].userId, "bos", "coordinator", false));
  });

  it("searches the directory instead of trusting one preloaded page", async () => {
    const api = makeApi({
      loadMemberDirectory: vi.fn().mockResolvedValue({
        items: [{ userId: "00000000-0000-0000-0000-000000000002", fullName: "Darnell Brooks", chapterId: "bos", chapterName: "Harborview Care Boston", roles: [] }],
        nextCursor: null,
      }),
    });
    mountMembership(api);
    const search = screen.getByRole("searchbox", { name: "Find a worker by name" });
    fireEvent.change(search, { target: { value: " Darnell " } });
    fireEvent.submit(search.closest("form"));
    await waitFor(() => expect(api.loadMemberDirectory).toHaveBeenCalledWith("Darnell", null));
    expect(await screen.findByRole("option", { name: "Darnell Brooks" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Ana Rivera" })).toBeNull();
  });

  it("carries the complete Spanish catalogue for the same controls", () => {
    mountMembership(makeApi(), "es");
    expect(screen.getByRole("heading", { name: "Participación en varias campañas" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agregar a la campaña" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quitar rol" })).toBeInTheDocument();
    expect(screen.queryByText(/admin\.chapterLifecycle\./)).toBeNull();
  });
});
