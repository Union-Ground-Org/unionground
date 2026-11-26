// REQ-UG-HOLD-DIRECTORY-SYNC-WITH-SINGLE-SIGN-ON-20261117 (#9037).
//
// Directory sync (SCIM) is held with single sign-on. While
// public.get_scim_control() answers released: false (held), or cannot be read,
// the Integrations page offers no SCIM tab, draws no setup and leaves the SCIM
// row out of Providers, and a link to the tab lands on the first tab.
// Released, even with the organization switch off, all three are as before.
import { Component, useEffect, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { IntegrationControlPlane } from "../src/features/integrations/IntegrationControlPlane.jsx";
import { ScimSetup } from "../src/features/integrations/ScimSetup.jsx";
import { createActor } from "../src/features/integrations/authorization.js";
import { createIntegrationControlStore } from "../src/features/integrations/store.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";

afterEach(() => { window.history.replaceState({}, "", "/m"); });

const actor = createActor({
  userId: "admin-a", selectedOrganizationId: "organization-a", roles: ["admin"],
  membershipStatus: "active", selectedHat: "admin", mfaSatisfied: true,
});

function Router({ children }) {
  const [location, setLocation] = useState(() => window.location.href);
  useEffect(() => {
    const changed = () => setLocation(window.location.href);
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);
  function navigate(_view, path, _state, options = {}) {
    window.history[options.replace ? "replaceState" : "pushState"]({}, "", path);
    setLocation(window.location.href);
  }
  return <LanguageProvider lang="en"><WorkspacePages view="integrations" hat="admin" location={location} navigate={navigate}>{children}</WorkspacePages></LanguageProvider>;
}

// The local store answers single sign-on as released; only SCIM changes here.
function storeAnswering(getScimControl) {
  const base = createIntegrationControlStore();
  return { ...base, getScimControl: vi.fn(getScimControl) };
}

const scimTab = () => screen.queryByRole("link", { name: t("en", "integrations.scim"), exact: true });
// Every place the page prints the SCIM provider name (the Providers row and any list of providers).
const scimNames = () => screen.queryAllByText(t("en", "integrations.provider.scim.label"), { exact: true });
const scimButton = () => screen.queryByRole("link", { name: t("en", "integrations.scimOpenSetup") });

describe("Directory sync (SCIM) on the Integrations page follows its release hold", () => {
  it.each([
    ["held", () => ({ ok: true, data: { organizationId: "organization-a", released: false } })],
    ["refused", () => ({ ok: false, reason: "unauthorized" })],
    ["unreadable", () => Promise.reject(new Error("offline"))],
  ])("leaves the tab, setup and Providers row out and sends a link to the tab to the first tab when %s", async (_state, answer) => {
    const store = storeAnswering(answer);
    window.history.replaceState({}, "", "/m/integrations/scim");
    render(<Router><IntegrationControlPlane store={store} actor={actor} /></Router>);
    await waitFor(() => expect(window.location.pathname).toBe("/m/integrations/providers"));
    expect(store.getScimControl).toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Connections" })).toBeInTheDocument();
    expect(screen.getByText(t("en", "integrations.provider.twilio.label"), { exact: true })).toBeInTheDocument();
    expect(scimTab()).not.toBeInTheDocument();
    expect(scimNames()).toHaveLength(0);
    expect(scimButton()).not.toBeInTheDocument();
    expect(document.querySelector("#integration-scim")).not.toBeInTheDocument();
  });

  it("keeps the tab, setup and Providers row when released, even with the organization switch off", async () => {
    const base = createIntegrationControlStore();
    const store = storeAnswering((who) => {
      const answer = base.getScimControl(who);
      return { ...answer, data: { ...answer.data, released: true, enabled: false } };
    });
    window.history.replaceState({}, "", "/m/integrations/scim");
    render(<Router><IntegrationControlPlane store={store} actor={actor} /></Router>);
    await waitFor(() => expect(scimTab()).toBeInTheDocument());
    expect(window.location.pathname).toBe("/m/integrations/scim");
    await waitFor(() => expect(document.querySelector("#integration-scim")).toBeInTheDocument());
    expect(await screen.findByText(/SCIM directory provisioning is off/)).toBeInTheDocument();
  });

  it("still shows the setup load error when released but the setup's own read fails", async () => {
    const base = createIntegrationControlStore();
    let calls = 0;
    const store = storeAnswering((who) => {
      calls += 1;
      return calls === 1
        ? { ...base.getScimControl(who), data: { ...base.getScimControl(who).data, released: true } }
        : { ok: false, reason: "persistence_unavailable" };
    });
    window.history.replaceState({}, "", "/m/integrations/scim");
    render(<Router><IntegrationControlPlane store={store} actor={actor} /></Router>);
    expect(await screen.findByText(t("en", "integrations.scimUnavailable"))).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m/integrations/scim");
    expect(scimTab()).toBeInTheDocument();
  });

  it("keeps the Providers row and its setup button when released", async () => {
    const base = createIntegrationControlStore();
    const store = storeAnswering((who) => ({ ...base.getScimControl(who), data: { ...base.getScimControl(who).data, released: true } }));
    render(<LanguageProvider lang="en"><IntegrationControlPlane store={store} actor={actor} /></LanguageProvider>);
    expect(await screen.findByRole("link", { name: t("en", "integrations.scimOpenSetup") })).toBeInTheDocument();
    expect(scimNames().length).toBeGreaterThan(0);
  });
});

// Round 1 of #9064 (r1s1, r2s1): a hold that lands while an admin has the
// setup open answers the next write with only released false. The setup then
// shows nothing; it never reads a setup field from that answer.
describe("SCIM setup when the hold lands while it is open", () => {
  const HELD = { ok: true, data: { organizationId: "organization-a", released: false } };
  const open = {
    organizationId: "organization-a", released: true, enabled: true, canManage: true, defaultChapterId: "ewl1-a",
    requestsPerMinute: 120, invitationsPerDay: 200,
    chapters: [{ id: "ewl1-a", name: "Example Workers Local 1 North" }, { id: "ewl1-b", name: "Example Workers Local 1 South" }],
    tokens: [{ id: "t1", label: "Okta production", tokenPrefix: "ug_scim_abcd", createdAt: "2026-10-02T10:00:00Z", expiresAt: "2999-01-01T00:00:00Z", revokedAt: null, lastUsedAt: null }],
    groups: [], users: { total: 0, invited: 0, active: 0, reactivationInvited: 0, needsAdmin: 0, deprovisioned: 0 }, attention: [],
  };
  const setupStore = (overrides) => ({
    getScimControl: vi.fn(async () => ({ ok: true, data: open })),
    saveScimSettings: vi.fn(async () => HELD),
    revokeScimToken: vi.fn(async () => HELD),
    issueScimToken: vi.fn(async () => HELD),
    setScimGroupRole: vi.fn(async () => HELD),
    ...overrides,
  });
  // A crash would also empty the page, so a boundary makes it visible.
  class Boundary extends Component {
    constructor(props) { super(props); this.state = { crashed: false }; }
    static getDerivedStateFromError() { return { crashed: true }; }
    render() { return this.state.crashed ? <p>setup crashed</p> : this.props.children; }
  }
  const renderSetup = (store) => {
    const view = render(<LanguageProvider lang="en"><Boundary><div data-testid="setup"><ScimSetup store={store} actor={actor} /></div></Boundary></LanguageProvider>);
    return { container: { get current() { return screen.queryByTestId("setup"); } }, view };
  };
  const shownNothing = (container) => {
    expect(screen.queryByText("setup crashed")).not.toBeInTheDocument();
    expect(container.current).toBeEmptyDOMElement();
  };

  it("draws nothing when the first read answers held", async () => {
    const store = setupStore({ getScimControl: vi.fn(async () => HELD) });
    const { container } = renderSetup(store);
    await waitFor(() => expect(store.getScimControl).toHaveBeenCalled());
    await waitFor(() => shownNothing(container));
  });

  it("draws nothing, and does not crash, when a token revocation answers held", async () => {
    const store = setupStore();
    const { container } = renderSetup(store);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Okta production" }));
    await waitFor(() => expect(store.revokeScimToken).toHaveBeenCalledOnce());
    await waitFor(() => shownNothing(container));
  });

  it("draws nothing, and does not crash, when saving the default chapter answers held", async () => {
    const store = setupStore();
    const { container } = renderSetup(store);
    fireEvent.change(await screen.findByLabelText("Campaign for new invitations"), { target: { value: "ewl1-b" } });
    fireEvent.click(screen.getByRole("button", { name: "Save campaign" }));
    await waitFor(() => expect(store.saveScimSettings).toHaveBeenCalledOnce());
    await waitFor(() => shownNothing(container));
  });
});

// a review note and 503 (#9064 final, r3s1 and r4s1): the page follows a
// held answer from the setup, and Try again reads the release again.
describe("the Integrations page keeps the SCIM release current", () => {
  const HELD = { ok: true, data: { organizationId: "organization-a", released: false } };
  const releasedControl = (who, base) => ({
    ...base.getScimControl(who),
    data: {
      ...base.getScimControl(who).data, released: true, enabled: true, defaultChapterId: "ewl1-a",
      chapters: [{ id: "ewl1-a", name: "Example Workers Local 1 North" }],
      tokens: [{ id: "t1", label: "Okta production", tokenPrefix: "ug_scim_abcd", createdAt: "2026-10-02T10:00:00Z", expiresAt: "2999-01-01T00:00:00Z", revokedAt: null, lastUsedAt: null }],
    },
  });

  it("leaves the SCIM tab and card when a setup write answers held (ledger 502)", async () => {
    const base = createIntegrationControlStore();
    const store = { ...storeAnswering((who) => releasedControl(who, base)), revokeScimToken: vi.fn(async () => HELD) };
    window.history.replaceState({}, "", "/m/integrations/scim");
    render(<Router><IntegrationControlPlane store={store} actor={actor} /></Router>);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Okta production" }));
    await waitFor(() => expect(store.revokeScimToken).toHaveBeenCalledOnce());
    await waitFor(() => expect(window.location.pathname).toBe("/m/integrations/providers"));
    expect(scimTab()).not.toBeInTheDocument();
    expect(document.querySelector("#integration-scim")).not.toBeInTheDocument();
    expect(scimNames()).toHaveLength(0);
  });

  it("reads the SCIM release again from Try again (ledger 503)", async () => {
    const base = createIntegrationControlStore();
    let reads = 0;
    const store = storeAnswering((who) => {
      reads += 1;
      return reads === 1 ? Promise.reject(new Error("offline")) : releasedControl(who, base);
    });
    let snapshots = 0;
    store.getSnapshot = vi.fn((who) => {
      snapshots += 1;
      return snapshots === 1 ? { ok: false, reason: "persistence_unavailable" } : base.getSnapshot(who);
    });
    render(<LanguageProvider lang="en"><IntegrationControlPlane store={store} actor={actor} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: t("en", "integrations.retry") }));
    expect(await screen.findByRole("link", { name: t("en", "integrations.scimOpenSetup") })).toBeInTheDocument();
    expect(store.getScimControl.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
