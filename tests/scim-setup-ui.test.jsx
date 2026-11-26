// REQ-UG-SCIM-PROVISIONING-20261001: the SCIM tab is an honest setup
// surface. Every state comes from get_scim_control and every control calls a
// store method the database authorizes.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScimSetup } from "../src/features/integrations/ScimSetup.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick, expectReadyRetryAfterThrowAtOnce } from "./helpers/busyWriteFocus.js";

const actor = { userId: "u", selectedOrganizationId: "org" };

function control(overrides = {}) {
  return {
    organizationId: "org",
    enabled: true,
    canManage: true,
    defaultChapterId: null,
    requestsPerMinute: 120,
    invitationsPerDay: 200,
    chapters: [{ id: "ewl1-a", name: "Example Workers Local 1 North" }, { id: "ewl1-b", name: "Example Workers Local 1 South" }],
    tokens: [],
    groups: [],
    users: { total: 0, invited: 0, active: 0, reactivationInvited: 0, needsAdmin: 0, deprovisioned: 0 },
    attention: [],
    ...overrides,
  };
}

function storeWith(initial, overrides = {}) {
  let current = initial;
  const update = (patch) => { current = { ...current, ...patch }; return { ok: true, data: current }; };
  return {
    getScimControl: vi.fn(async () => ({ ok: true, data: current })),
    saveScimSettings: vi.fn(async (_actor, { defaultChapterId }) => update({ defaultChapterId })),
    issueScimToken: vi.fn(async (_actor, { label }) => ({
      ...update({ tokens: [{ id: "t1", label, tokenPrefix: "ug_scim_abcd", createdAt: "2026-10-02T10:00:00Z", expiresAt: "2999-01-01T00:00:00Z", revokedAt: null, lastUsedAt: null }] }),
      secret: { plaintext: `ug_scim_${"ab".repeat(24)}`, prefix: "ug_scim_abab", shownOnce: true },
    })),
    revokeScimToken: vi.fn(async () => update({ tokens: current.tokens.map((token) => ({ ...token, revokedAt: "2026-10-02T11:00:00Z" })) })),
    setScimGroupRole: vi.fn(async (_actor, { groupId, role }) => update({ groups: current.groups.map((group) => group.id === groupId ? { ...group, mappedRole: role } : group) })),
    ...overrides,
  };
}

function renderSetup(store, lang = "en") {
  return render(<LanguageProvider lang={lang}><ScimSetup store={store} actor={actor} /></LanguageProvider>);
}

describe("SCIM setup tab", () => {
  it("walks an admin through campaign, one-time token and revocation", async () => {
    const store = storeWith(control());
    renderSetup(store);
    expect(await screen.findByText(/SCIM directory provisioning is on/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Feature switches & limits" })).toHaveAttribute("href", "/m/admin/configuration");
    expect(screen.getByText(/\/scim\/v2$/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Issue SCIM token" })).toBeDisabled();
    expect(screen.getByText("Choose a default campaign before issuing a token.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Campaign for new invitations"), { target: { value: "ewl1-b" } });
    fireEvent.click(screen.getByRole("button", { name: "Save campaign" }));
    await waitFor(() => expect(store.saveScimSettings).toHaveBeenCalledWith(actor, { defaultChapterId: "ewl1-b" }));

    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "Okta production" } });
    fireEvent.click(screen.getByRole("button", { name: "Issue SCIM token" }));
    const secret = await screen.findByDisplayValue(/^ug_scim_[0-9a-f]{48}$/);
    expect(secret).toHaveAttribute("readonly");
    expect(screen.getAllByText(/shown once and expires in 90 days/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "I have copied it" }));
    expect(screen.queryByDisplayValue(/^ug_scim_/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Revoke Okta production" }));
    await waitFor(() => expect(store.revokeScimToken).toHaveBeenCalledWith(actor, { tokenId: "t1" }));
    expect(await screen.findByText(/revoked/)).toBeInTheDocument();
  });

  it("explains a switched-off organization and reports database refusals as alerts", async () => {
    const store = storeWith(control({ enabled: false, defaultChapterId: "ewl1-a" }), {
      saveScimSettings: vi.fn(async () => ({ ok: false, reason: "mfa_required" })),
    });
    renderSetup(store);
    expect(await screen.findByText(/SCIM directory provisioning is off/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Issue SCIM token" })).toBeDisabled();
    expect(screen.getAllByText(/Turn on SCIM directory provisioning in Feature switches & limits/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Campaign for new invitations"), { target: { value: "ewl1-b" } });
    fireEvent.click(screen.getByRole("button", { name: "Save campaign" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Complete two-step sign-in");
  });


  it("shows a vp the setup without write controls, in Spanish", async () => {
    const store = storeWith(control({ canManage: false, defaultChapterId: "ewl1-a", groups: [{ id: "g1", displayName: "Coordinadores", mappedRole: "coordinator", memberCount: 2 }] }));
    renderSetup(store, "es");
    expect(await screen.findByText(/El aprovisionamiento de directorio SCIM está activado/)).toBeInTheDocument();
    expect(screen.getByText("Example Workers Local 1 North")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Emitir token SCIM" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText(/Liderazgo de campaña/)).toBeInTheDocument();
  });

  it("keeps a failed load to a status line", async () => {
    renderSetup(storeWith(control(), { getScimControl: vi.fn(async () => ({ ok: false, reason: "persistence_unavailable" })) }));
    expect(await screen.findByRole("status")).toHaveTextContent("SCIM setup could not be loaded. Try again.");
  });
});

// Every SCIM control shares one busy state and one lock, keeps
// focus while its change runs, and a change that answers after the page moved
// to another member or organization leaves that page alone.
describe("SCIM setup while a change runs", () => {
  const token = { id: "t1", label: "Okta production", tokenPrefix: "ug_scim_abcd", createdAt: "2026-10-02T10:00:00Z", expiresAt: "2999-01-01T00:00:00Z", revokedAt: null, lastUsedAt: null };
  const group = { id: "g1", displayName: "Committee workers", mappedRole: null, memberCount: 4 };

  it("keeps Revoke focused and pending while the revocation runs, with the other controls pending", async () => {
    const store = storeWith(control({ defaultChapterId: "ewl1-a", tokens: [token], groups: [group] }));
    renderSetup(store);
    const revoke = await screen.findByRole("button", { name: "Revoke Okta production" });
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "Second" } });
    await expectHeldWriteFocus(store.revokeScimToken, revoke, () => {
      fireEvent.click(revoke);
      for (const control of [screen.getByRole("button", { name: "Issue SCIM token" }), screen.getByLabelText("Starting role for Committee workers")]) {
        expect(control).toBeEnabled();
        expect(control).toHaveAttribute("aria-disabled", "true");
      }
    });
    expect(await screen.findByText(/revoked/)).toBeInTheDocument();
  });

  it("keeps Issue SCIM token focused and pending while the token is issued", async () => {
    const store = storeWith(control({ defaultChapterId: "ewl1-a" }));
    renderSetup(store);
    const issue = await screen.findByRole("button", { name: "Issue SCIM token" });
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "Okta production" } });
    await expectHeldWriteFocus(store.issueScimToken, issue);
    expect(await screen.findByDisplayValue(/^ug_scim_/)).toBeInTheDocument();
    expect(store.issueScimToken).toHaveBeenCalledOnce();
  });

  it("keeps a group's starting role focused and pending while it is saved", async () => {
    const store = storeWith(control({ defaultChapterId: "ewl1-a", groups: [group] }));
    renderSetup(store);
    const select = await screen.findByLabelText("Starting role for Committee workers");
    await expectHeldWriteFocus(store.setScimGroupRole, select, () => fireEvent.change(select, { target: { value: "coordinator" } }));
    expect(store.setScimGroupRole).toHaveBeenCalledOnce();
    expect(store.setScimGroupRole).toHaveBeenCalledWith(actor, { groupId: "g1", role: "coordinator" });
  });

  it("sends one change when Save campaign and Revoke are pressed in the same tick", async () => {
    const store = storeWith(control({ defaultChapterId: "ewl1-a", tokens: [token] }));
    renderSetup(store);
    const revoke = await screen.findByRole("button", { name: "Revoke Okta production" });
    fireEvent.change(screen.getByLabelText("Campaign for new invitations"), { target: { value: "ewl1-b" } });
    const save = screen.getByRole("button", { name: "Save campaign" });
    await expectOneWriteFromOneTick([store.saveScimSettings, store.revokeScimToken], [() => fireEvent.click(save), () => fireEvent.click(revoke)]);
    // The lock ends with the change: the next press sends.
    await waitFor(() => expect(revoke).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(revoke);
    await waitFor(() => expect(store.revokeScimToken).toHaveBeenCalledOnce());
  });

  it("revokes again from an immediate press after a revocation that throws at once", async () => {
    const store = storeWith(control({ defaultChapterId: "ewl1-a", tokens: [token] }));
    renderSetup(store);
    const revoke = await screen.findByRole("button", { name: "Revoke Okta production" });
    await expectReadyRetryAfterThrowAtOnce(store.revokeScimToken, revoke);
    expect(screen.getByRole("alert")).toHaveTextContent("The integration change could not be completed.");
  });

  it("shows no token, control or error from an issue that answers after the page moved to another organization", async () => {
    const storeA = storeWith(control({ defaultChapterId: "ewl1-a" }));
    let answer;
    storeA.issueScimToken.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const otherActor = { userId: "u", selectedOrganizationId: "org-b" };
    const controlB = control({ organizationId: "org-b", defaultChapterId: "ewl1-b", tokens: [], chapters: [{ id: "ewl1-b", name: "Organization B campaign" }] });
    storeA.getScimControl.mockImplementation(async (who) => ({ ok: true, data: who === otherActor ? controlB : control({ defaultChapterId: "ewl1-a" }) }));
    const view = renderSetup(storeA);
    fireEvent.change(await screen.findByLabelText("Token name"), { target: { value: "Okta production" } });
    fireEvent.click(screen.getByRole("button", { name: "Issue SCIM token" }));
    expect(storeA.issueScimToken).toHaveBeenCalledOnce();
    view.rerender(<LanguageProvider lang="en"><ScimSetup store={storeA} actor={otherActor} /></LanguageProvider>);
    expect(await screen.findByText("Organization B campaign")).toBeInTheDocument();
    await act(async () => {
      answer({ ok: true, data: control({ defaultChapterId: "ewl1-a", tokens: [token] }), secret: { plaintext: `ug_scim_${"ab".repeat(24)}`, prefix: "ug_scim_abab", shownOnce: true } });
    });
    expect(screen.queryByDisplayValue(/^ug_scim_/)).not.toBeInTheDocument();
    expect(screen.queryByText("Okta production")).not.toBeInTheDocument();
    expect(screen.getByText("Organization B campaign")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // The earlier write still ends its own lock and busy state.
    const issue = screen.getByRole("button", { name: "Issue SCIM token" });
    expect(issue).not.toHaveAttribute("aria-disabled");
  });

  it("shows no refusal from a change that fails after the page moved to another organization", async () => {
    const store = storeWith(control({ defaultChapterId: "ewl1-a", tokens: [token] }));
    let fail;
    store.revokeScimToken.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const view = renderSetup(store);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Okta production" }));
    view.rerender(<LanguageProvider lang="en"><ScimSetup store={store} actor={{ userId: "u", selectedOrganizationId: "org-b" }} /></LanguageProvider>);
    await act(async () => { fail(new Error("network")); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

// A one-time token already on screen belongs to the member
// and organization that issued it.
describe("SCIM one-time token after the page's worker or organization changes", () => {
  async function issued(store) {
    const view = renderSetup(store);
    fireEvent.change(await screen.findByLabelText("Token name"), { target: { value: "Okta production" } });
    fireEvent.click(screen.getByRole("button", { name: "Issue SCIM token" }));
    expect(await screen.findByDisplayValue(/^ug_scim_/)).toBeInTheDocument();
    return view;
  }

  it("hides the shown token when the page moves to another organization, and does not bring it back on return", async () => {
    const store = storeWith(control({ defaultChapterId: "ewl1-a" }));
    const view = await issued(store);
    view.rerender(<LanguageProvider lang="en"><ScimSetup store={store} actor={{ userId: "u", selectedOrganizationId: "org-b" }} /></LanguageProvider>);
    expect(screen.queryByDisplayValue(/^ug_scim_/)).not.toBeInTheDocument();
    view.rerender(<LanguageProvider lang="en"><ScimSetup store={store} actor={actor} /></LanguageProvider>);
    await waitFor(() => expect(store.getScimControl).toHaveBeenCalledTimes(3));
    expect(screen.queryByDisplayValue(/^ug_scim_/)).not.toBeInTheDocument();
  });

  it("hides the shown token when another worker signs in on the same organization", async () => {
    const store = storeWith(control({ defaultChapterId: "ewl1-a" }));
    const view = await issued(store);
    view.rerender(<LanguageProvider lang="en"><ScimSetup store={store} actor={{ userId: "someone-else", selectedOrganizationId: "org" }} /></LanguageProvider>);
    expect(screen.queryByDisplayValue(/^ug_scim_/)).not.toBeInTheDocument();
  });

  it("drops the token from the page's state, not just the screen, when the organization changes", async () => {
    const store = storeWith(control({ defaultChapterId: "ewl1-a" }));
    const view = await issued(store);
    const plaintext = screen.getByDisplayValue(/^ug_scim_/).value;
    // The component's own hook state, read from the root's current tree.
    const scimHookStates = () => {
      const key = Object.keys(view.container).find((name) => name.startsWith("__reactContainer$"));
      const pending = [view.container[key].stateNode.current];
      let fiber = null;
      while (pending.length && !fiber) {
        const node = pending.pop();
        if (node.type === ScimSetup) fiber = node;
        else { if (node.sibling) pending.push(node.sibling); if (node.child) pending.push(node.child); }
      }
      const states = [];
      for (let hook = fiber?.memoizedState; hook; hook = hook.next) states.push(hook.memoizedState);
      return states;
    };
    const holds = (value) => scimHookStates().some((state) => state === value || (state !== null && typeof state === "object" && state.plaintext === value));
    expect(holds(plaintext)).toBe(true);
    view.rerender(<LanguageProvider lang="en"><ScimSetup store={store} actor={{ userId: "u", selectedOrganizationId: "org-b" }} /></LanguageProvider>);
    await waitFor(() => expect(store.getScimControl).toHaveBeenCalledTimes(2));
    expect(screen.queryByDisplayValue(/^ug_scim_/)).not.toBeInTheDocument();
    expect(holds(plaintext)).toBe(false);
  });

  it("keeps the shown token through a same-login session renewal (a new actor for the same worker and organization)", async () => {
    const store = storeWith(control({ defaultChapterId: "ewl1-a" }));
    const view = await issued(store);
    view.rerender(<LanguageProvider lang="en"><ScimSetup store={store} actor={{ ...actor }} /></LanguageProvider>);
    await waitFor(() => expect(store.getScimControl).toHaveBeenCalledTimes(2));
    expect(screen.getByDisplayValue(/^ug_scim_/)).toBeInTheDocument();
  });
});
