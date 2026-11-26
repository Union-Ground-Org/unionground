import { useEffect, useState } from "react";
import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspacePages, WorkspaceSection, RoutedTabLink, useRoutedTab, useWorkspace, useWorkspaceTitle, workspaceHref, workspaceListWindow, workspaceListRows } from "../src/components/WorkspacePages.jsx";
import { WORKSPACE_PAGES, TAB_PAGE_GROUPS, NESTED_TAB_PAGE_GROUP_BASES, workspacePageForLocation } from "../src/lib/workspacePages.js";
import { appViewForPath, SPA_ROUTE_PATHS } from "../src/lib/appRoutes.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { STAFF_ROLE_NAVIGATION } from "../src/lib/staffNavigation.js";
import { STAFF_PLANES } from "../src/lib/staffPlanes.js";
import { t } from "../src/lib/i18n.js";
import { AdminView } from "../src/views/AdminView.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { AutomationControlRoom } from "../src/features/automation/AutomationControlRoom.jsx";
import { AutomationControlRoomView } from "../src/views/AutomationControlRoomView.jsx";
import { canonicalAutomationPath } from "../src/features/automation/links.js";
import { choosePage, pageMenuTrigger } from "./helpers/workspacePageMenu.js";
import { TasksView } from "../src/views/TasksView.jsx";
import { CampaignsView } from "../src/views/CampaignsView.jsx";
import { PayToolsView } from "../src/views/PayToolsView.jsx";
import { buildPayActor } from "../src/lib/mi1PayWiring.js";
import { IntegrationControlPlane } from "../src/features/integrations/IntegrationControlPlane.jsx";
import { createIntegrationControlStore } from "../src/features/integrations/store.js";
import { createActor } from "../src/features/integrations/authorization.js";
import { OrganizationCoordinationDesk } from "../src/features/coordination/ui/OrganizationCoordinationDesk.jsx";
import { WorkloadView } from "../src/views/WorkloadView.jsx";

afterEach(() => { window.history.replaceState({}, "", "/m"); });

function Router({ view, hat, children, lang = "en" }) {
  const [location, setLocation] = useState(() => window.location.href);
  useEffect(() => {
    const changed = () => setLocation(window.location.href);
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);
  function navigate(nextView, path, _, options = {}) {
    expect(nextView).toBe(view);
    window.history[options.replace ? "replaceState" : "pushState"]({}, "", path);
    setLocation(window.location.href);
  }
  return <LanguageProvider lang={lang}><WorkspacePages view={view} hat={hat} location={location} navigate={navigate}>{children}</WorkspacePages></LanguageProvider>;
}

function Title() { return <h1>{useWorkspaceTitle("Overview")}</h1>; }

// history.length only counts up from the TIP of the session history: a test
// that ran history.back() leaves the cursor mid-stack, where the next push
// prunes a forward entry as it appends. Enter every history-counting case with
// a push so the cursor is on the tip before the delta is measured.
function enterAtHistoryTip(path) {
  window.history.pushState({}, "", path);
  return window.history.length;
}

function Tabs({ group, spec }) {
  const [tab, setTab] = useRoutedTab(group, spec.tabs[0]);
  return <>{spec.tabs.map(id => <button key={id} onClick={() => setTab(id)}>{id}</button>)}<output data-testid="tab">{tab}</output></>;
}

describe("focused workspace page contracts", () => {
  it("keeps live SAMPLE engagement reachable alongside its optional demo studio", async () => {
    const api = { load: vi.fn().mockResolvedValue({ campaigns: [] }) };
    const client = { rpc: vi.fn().mockResolvedValue({ data: {}, error: null }) };
    window.history.replaceState({}, "", "/m/campaigns/engagement/polls");
    render(<Router view="campaigns"><CampaignsView api={api} sampleStudio engagementClient={client} /></Router>);
    expect(await screen.findByTestId("staff-engagement")).toBeVisible();
    expect(client.rpc).toHaveBeenCalledWith("get_staff_engagement_snapshot", {});
    expect(screen.queryByRole("heading", { name: "Engagement studio isn't in this preview" })).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/m/campaigns/engagement/surveys"]')).not.toBeNull();
    expect(document.querySelector('a[href="/m/campaigns/studio/surveys"]')).not.toBeNull();
  });
  // Lovable audit APP-STEWARD-06 and APP-ADVISOR-03 (REQ-UNIONGROUND-LOVABLE-
  // AUDIT-WEBAPP-FIXES-20261103): routes this workspace cannot back explain
  // why and give a way on instead of a lone sentence or a blank panel.
  // BUG-UG-CAMPAIGNS-SAMPLE-STUDIO-ADDRESS-SHOWS-RETIRED-PREVIEW-COPY-20261106:
  // signed in to a real organization, the sample-studio address showed the
  // retired preview's "only in the preview" card. It now opens the
  // organization's own engagement studio, keeping a tab both studios share.
  it.each([
    ["/m/campaigns/studio/surveys", "/m/campaigns/engagement/surveys"],
    ["/m/campaigns/studio/weekly", "/m/campaigns/engagement/weekly"],
    ["/m/campaigns/studio/insights", "/m/campaigns/engagement/surveys"],
  ])("opens a live organization's engagement studio from the sample-studio address %s", async (from, to) => {
    const api = { load: vi.fn().mockResolvedValue({ campaigns: [] }) };
    const client = { rpc: vi.fn().mockResolvedValue({ data: {}, error: null }) };
    window.history.replaceState({}, "", from);
    const before = window.history.length;
    render(<Router view="campaigns"><CampaignsView api={api} engagementClient={client} /></Router>);
    expect(await screen.findByTestId("staff-engagement")).toBeVisible();
    expect(window.location.pathname).toBe(to);
    expect(window.history.length).toBe(before);
    expect(screen.queryByRole("heading", { name: "The sample studio is only in the preview" })).not.toBeInTheDocument();
  });
  it("still explains the missing sample studio on the demo surface without fixtures", async () => {
    const api = { load: vi.fn().mockResolvedValue({ campaigns: [] }) };
    window.history.replaceState({}, "", "/m/campaigns/studio/surveys");
    render(<Router view="campaigns"><CampaignsView api={api} demo engagementClient={null} /></Router>);
    const heading = await screen.findByRole("heading", { name: "The sample studio is only in the preview" });
    const state = heading.closest("[data-state-block]");
    expect(within(state).getByRole("link", { name: "Back to Campaigns" })).toHaveAttribute("href", "/m/campaigns");
  });
  it("keeps fixture-only campaign previews from mounting live engagement", async () => {
    const api = { load: vi.fn().mockResolvedValue({ campaigns: [] }) };
    const client = { rpc: vi.fn() };
    window.history.replaceState({}, "", "/m/campaigns/engagement/polls?demo=1");
    render(<Router view="campaigns"><CampaignsView api={api} demo sampleStudio engagementClient={client} /></Router>);
    // The unavailable engagement page names why and routes back (audit P0
    // APP-STEWARD-06) instead of a lone "not available" sentence.
    const heading = await screen.findByRole("heading", { name: "Engagement studio isn't in this preview" });
    expect(heading).toBeVisible();
    expect(within(heading.closest("[data-state-block]")).getByRole("link", { name: "Back to Campaigns" })).toHaveAttribute("href", "/m/campaigns?demo=1");
    expect(client.rpc).not.toHaveBeenCalled();
  });
  it.each(["empty", "unavailable", "error", "mfa_required", "unauthorized"])("keeps the %s coordination page headed without granting access", (status) => {
    window.history.replaceState({}, "", "/m/coordination/missions?demo=1");
    render(<Router view="coordination"><OrganizationCoordinationDesk actor={{ roles: [] }} model={null} status={status} /></Router>);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Create/ })).not.toBeInTheDocument();
  });

  it("bounds list pages and clamps a stale position after rows disappear", () => {
    const rows = Array.from({ length: 13 }, (_, index) => index);
    expect(workspaceListRows(rows, 6, true)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(workspaceListRows(rows, 12, true)).toEqual([6, 7, 8, 9, 10, 11]);
    expect(workspaceListRows(rows, 18, true)).toEqual([12]);
    expect(workspaceListRows(rows.slice(0, 2), 18, true)).toEqual([0, 1]);
    expect(workspaceListRows(rows, 12, false)).toHaveLength(12);
    expect(workspaceListWindow(0, 18)).toEqual({ page: 0, pages: 1, start: 0, end: 6 });
  });

  it.each(["en", "es"])("paginates localized Admin audit sentences without accumulating rows (%s)", async (lang) => {
    const desk = structuredClone(fallbackData.adminDesk);
    desk.audit = Array.from({ length: 13 }, (_, index) => ({ id: `audit-${index}`, action: `Audit event ${index}`, actorName: `Audit actor ${index}`, createdAt: "2026-09-10T01:00:00Z" }));
    const rowText = (index) => lang === "es"
      ? `Audit actor ${index} hizo un cambio administrativo`
      : `Audit actor ${index} made an admin change`;
    const api = { loadDesk: vi.fn().mockResolvedValue(desk) };
    window.history.replaceState({}, "", "/m/admin/audit?demo=1");
    render(<Router view="admin" lang={lang}><AdminView data={{ member: { initials: "AR", organizationRoles: ["admin"] } }} api={api} onNotice={vi.fn()} /></Router>);
    const firstRow = await screen.findByText(rowText(0));
    expect(firstRow).toHaveAttribute("data-audit-action", "Audit event 0");
    expect(screen.queryByText("Audit event 0")).not.toBeInTheDocument();
    expect(screen.getAllByText(/^Audit actor /)).toHaveLength(6);
    const next = screen.getByRole("button", { name: lang === "es" ? "Siguiente" : "Next", exact: true });
    const previous = screen.getByRole("button", { name: lang === "es" ? "Anterior" : "Previous", exact: true });
    expect(previous).toBeDisabled();
    fireEvent.click(next);
    expect(screen.queryByText(rowText(0))).not.toBeInTheDocument();
    expect(screen.getByText(rowText(6))).toHaveAttribute("data-audit-action", "Audit event 6");
    expect(screen.getAllByText(/^Audit actor /)).toHaveLength(6);
    fireEvent.click(next);
    expect(screen.getAllByText(/^Audit actor /)).toHaveLength(1);
    expect(screen.getByText(rowText(12))).toBeInTheDocument();
    expect(next).toBeDisabled();
    fireEvent.click(previous);
    expect(screen.getByText(rowText(6))).toHaveAttribute("data-audit-action", "Audit event 6");
  });

  it("paginates the campaign registry and resets the page when filtering", async () => {
    const campaigns = Array.from({ length: 13 }, (_, index) => ({ id: `campaign-${index}`, kind: "pulse", scope: "chapter", titleEn: `Campaign ${index}`, titleEs: `Campaña ${index}`, state: index === 12 ? "closed" : "draft", closesAt: "2026-09-20T16:00:00Z", options: [] }));
    const api = { load: vi.fn().mockResolvedValue({ campaigns, chapterId: "wor", canManageUnion: false }) };
    window.history.replaceState({}, "", "/m/campaigns?demo=1");
    render(<Router view="campaigns"><CampaignsView api={api} demo /></Router>);
    await screen.findByText("Campaign 0");
    expect(document.querySelectorAll(".cam-card")).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Next", exact: true }));
    expect(screen.queryByText("Campaign 0")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".cam-card")).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Next", exact: true }));
    expect(screen.getByText("Campaign 12")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Drafts/ }));
    expect(screen.getByText("Campaign 0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous", exact: true })).toBeDisabled();
    expect(document.querySelectorAll(".cam-card")).toHaveLength(6);
  });

  it("pages invitations and MFA independently without losing their first rows", async () => {
    const desk = structuredClone(fallbackData.adminDesk);
    desk.invitations.items = Array.from({ length: 7 }, (_, index) => ({ ...desk.invitations.items[0], id: `invitation-${index}`, fullName: `Paged invitation ${index}` }));
    desk.mfa.staff = Array.from({ length: 7 }, (_, index) => ({ ...desk.mfa.staff[0], userId: `staff-${index}`, fullName: `Paged staff ${index}` }));
    const api = { loadDesk: vi.fn().mockResolvedValue(desk) };
    window.history.replaceState({}, "", "/m/admin/invitations?demo=1");
    render(<Router view="admin"><AdminView data={{ member: { initials: "AR", organizationRoles: ["admin"] } }} api={api} onNotice={vi.fn()} /></Router>);
    await screen.findByText("Paged invitation 0");
    fireEvent.click(screen.getByRole("button", { name: "Next", exact: true }));
    expect(screen.getByText("Paged invitation 6")).toBeInTheDocument();
    expect(screen.queryByText("Paged invitation 0")).not.toBeInTheDocument();
    choosePage(pageMenuTrigger(), "/m/admin/mfa");
    expect(screen.getByText("Paged staff 0")).toBeInTheDocument();
    expect(screen.queryByText("Paged staff 6")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next", exact: true }));
    expect(screen.getByText("Paged staff 6")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous", exact: true }));
    expect(screen.getByText("Paged staff 0")).toBeInTheDocument();
    choosePage(pageMenuTrigger(), "/m/admin/invitations");
    expect(screen.getByText("Paged invitation 6")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous", exact: true }));
    expect(screen.getByText("Paged invitation 0")).toBeInTheDocument();
  });

  it("pages a 500-invitation roster and resends and revokes an invitation beyond row 100", async () => {
    const desk = structuredClone(fallbackData.adminDesk);
    desk.invitations.items = Array.from({ length: 500 }, (_, index) => ({
      ...desk.invitations.items[0],
      id: `roster-invitation-${index}`,
      fullName: `Roster Member ${index + 1}`,
      normalizedEmail: `roster-${index + 1}@example.invalid`,
      status: "pending",
    }));
    const target = desk.invitations.items[101];
    const replacementId = `${target.id}-replacement`;
    let invitations = desk.invitations.items;
    const api = {
      loadDesk: vi.fn(async () => structuredClone({ ...desk, invitations: {
        ...desk.invitations, items: invitations.filter(invitation => invitation.status !== "superseded"),
      } })),
      resendInvitation: vi.fn(async id => {
        const original = invitations.find(invitation => invitation.id === id);
        // get_member_invitations omits superseded rows and puts the newest first.
        invitations = [{ ...original, id: replacementId }, ...invitations.map(invitation =>
          invitation.id === id ? { ...invitation, status: "superseded" } : invitation)];
        return { accepted: true, invitationId: replacementId };
      }),
      revokeInvitation: vi.fn(async id => {
        const row = invitations.find(invitation => invitation.id === id);
        const revoked = Boolean(row && ["pending", "delivery_failed", "expired"].includes(row.status));
        if (revoked) invitations = invitations.map(invitation => invitation.id === id ? { ...invitation, status: "revoked" } : invitation);
        return { accepted: true, revoked };
      }),
    };
    window.history.replaceState({}, "", "/m/admin/invitations");
    render(<Router view="admin"><AdminView data={{ member: { initials: "AR", organizationRoles: ["admin"] } }} api={api} onNotice={vi.fn()} /></Router>);
    await screen.findByText("Roster Member 1");
    expect(screen.queryByText(target.fullName)).not.toBeInTheDocument();
    for (let page = 0; page < 16; page += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Next", exact: true }));
    }
    expect(screen.getByText("Page 17 of 84")).toBeInTheDocument();
    expect(screen.getAllByText(/^Roster Member /)).toHaveLength(6);
    const targetRow = screen.getByText(target.fullName).closest(".xus-row");
    fireEvent.click(within(targetRow).getByRole("button", { name: "Resend" }));
    await waitFor(() => expect(api.resendInvitation).toHaveBeenCalledWith(target.id));
    await waitFor(() => expect(api.loadDesk).toHaveBeenCalledTimes(2));
    expect(invitations.find(invitation => invitation.id === target.id).status).toBe("superseded");
    const refreshed = await api.loadDesk.mock.results[1].value;
    expect(refreshed.invitations.items[0]).toMatchObject({ id: replacementId, status: "pending" });
    expect(refreshed.invitations.items.some(invitation => invitation.id === target.id)).toBe(false);
    await waitFor(() => expect(targetRow).not.toBeInTheDocument());
    // The replacement is newest, so find its live row on the first page.
    for (let page = 0; page < 16; page += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Previous", exact: true }));
    }
    expect(screen.getByText("Page 1 of 84")).toBeInTheDocument();
    const replacementRow = screen.getByText(target.fullName).closest(".xus-row");
    fireEvent.click(within(replacementRow).getByRole("button", { name: "Revoke invitation" }));
    const confirmation = within(replacementRow).getByRole("group", { name: `Revoke the invitation for ${target.fullName}?` });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Yes, revoke" }));
    await waitFor(() => expect(api.revokeInvitation).toHaveBeenCalledWith(replacementId));
    expect(api.revokeInvitation).not.toHaveBeenCalledWith(target.id);
    expect(invitations.find(invitation => invitation.id === replacementId).status).toBe("revoked");
    await waitFor(() => expect(api.loadDesk).toHaveBeenCalledTimes(3));
    await waitFor(() => {
      const row = screen.getByText(target.fullName).closest(".xus-row");
      expect(within(row).getByText("Revoked", { exact: true, selector: ".xus-chip" })).toBeVisible();
      expect(within(row).queryByRole("button", { name: "Revoke invitation" })).not.toBeInTheDocument();
    });
    for (let page = 1; page < 84; page += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Next", exact: true }));
    }
    expect(screen.getByText("Roster Member 500")).toBeInTheDocument();
    expect(screen.getAllByText(/^Roster Member /)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  });

  it("keeps native tab links scoped and preserves their keyboard semantics", () => {
    window.history.replaceState({}, "", "/m/coordination/missions?demo=1&embed=phone&secret=must-not-travel");
    const navigate = vi.fn();
    render(<Router view="coordination"><RoutedTabLink group="coordination" value="network" role="tab" aria-selected={false} tabIndex={0} aria-controls="network-panel" onClick={navigate}>Network</RoutedTabLink></Router>);
    const tab = screen.getByRole("tab", { name: "Network" });
    expect(tab.tagName).toBe("A");
    expect(tab).toHaveAttribute("href", "/m/coordination/network?demo=1&embed=phone");
    expect(tab).toHaveAttribute("tabindex", "0");
    expect(tab).toHaveAttribute("aria-controls", "network-panel");
    expect(workspaceHref("/m/admin")).toBe("/m/admin?demo=1&embed=phone");
    fireEvent.click(tab, { ctrlKey: true });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps /m/network as the member network tab so a reload still selects Member", async () => {
    window.history.replaceState({}, "", "/m/network?demo=1");
    render(<Router view="coordination" hat="member"><Title /></Router>);
    await waitFor(() => expect(window.location.pathname).toBe("/m/network"));
    expect(window.location.search).toBe("?demo=1");
    expect(workspacePageForLocation("/m/network")).toMatchObject({ viewKey: "coordination", group: "coordination", tab: "network" });
  });

  it("canonicalizes /m/network onto the coordination network tab for a staff hat", async () => {
    window.history.replaceState({}, "", "/m/network?demo=1");
    render(<Router view="coordination" hat="steward"><Title /></Router>);
    await waitFor(() => expect(window.location.pathname).toBe("/m/coordination/network"));
    expect(window.location.search).toBe("?demo=1");
  });

  it("keeps member network tab links on the member alias", () => {
    window.history.replaceState({}, "", "/m/network?demo=1");
    render(<Router view="coordination" hat="member"><RoutedTabLink group="coordination" value="network" role="tab">Network</RoutedTabLink></Router>);
    expect(screen.getByRole("tab", { name: "Network" })).toHaveAttribute("href", "/m/network?demo=1");
  });

  it("opens a routed tab on Space and on a plain click when the caller passes no handler", () => {
    window.history.replaceState({}, "", "/m/coordination/missions");
    render(<Router view="coordination"><RoutedTabLink group="coordination" value="network" role="tab">Network</RoutedTabLink></Router>);
    const tab = screen.getByRole("tab", { name: "Network" });
    fireEvent.keyDown(tab, { key: " " });
    expect(window.location.pathname).toBe("/m/coordination/network");
    window.history.replaceState({}, "", "/m/coordination/missions");
    fireEvent.click(tab);
    expect(window.location.pathname).toBe("/m/coordination/network");
  });

  it.each([false, true])("opens and navigates actual task pages (desktop=%s)", async (desktopShell) => {
    window.history.replaceState({}, "", "/m/tasks/deadlines?demo=1");
    render(<Router view="tasks"><TasksView data={structuredClone(fallbackData)} desktopShell={desktopShell} demo onNotice={vi.fn()} /></Router>);
    // The page is named Work, as the rail names it; Deadlines and Field notes
    // carry the focus mark on their own visible second-level title.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Work");
    expect(screen.getByRole("heading", { level: 2, name: "Task deadlines" })).toHaveAttribute("data-workspace-focus");
    expect(document.querySelectorAll("[data-workspace-focus]")).toHaveLength(1);
    expect(document.querySelector(".tasks-deadlines-view")).toBeInTheDocument();
    expect(document.querySelector(".tasks-field-notes-view")).not.toBeInTheDocument();
    const fieldNotes = screen.getByRole(desktopShell ? "tab" : "link", { name: "Field notes", exact: true });
    expect(fieldNotes).toHaveAttribute("href", "/m/tasks/field_notes?demo=1");
    fireEvent.click(fieldNotes);
    expect(window.location.pathname).toBe("/m/tasks/field_notes");
    expect(document.querySelector(".tasks-field-notes-view")).toBeInTheDocument();
    expect(document.querySelector(".tasks-deadlines-view")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Work");
    // A change to a titled tab focuses its visible title.
    expect(screen.getByRole("heading", { level: 2, name: "Field notes" })).toHaveFocus();
    expect(document.querySelectorAll("[data-workspace-focus]")).toHaveLength(1);
    // Board has only a visually hidden tab-level heading for the outline, which
    // is not marked, so focus falls back to the visible Work heading.
    fireEvent.click(screen.getByRole(desktopShell ? "tab" : "link", { name: "Board", exact: true }));
    expect(window.location.pathname).toBe("/m/tasks/board");
    expect(screen.getByRole("heading", { level: 2, name: "Board" })).toHaveClass("visually-hidden");
    expect(document.querySelectorAll("[data-workspace-focus]")).toHaveLength(0);
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
    expect(document.activeElement.closest(".visually-hidden")).toBeNull();
  });

  // #9936: an Integrations confirmation belongs to the tab it was made on.
  it("clears an Integrations confirmation when the tab changes", async () => {
    const store = createIntegrationControlStore();
    const actor = createActor({ userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", selectedOrganizationId: "11111111-1111-4111-8111-111111111111", roles: ["admin"], membershipStatus: "active", mfaSatisfied: true });
    window.history.replaceState({}, "", "/m/integrations/jobs?demo=1");
    render(<Router view="integrations"><IntegrationControlPlane store={store} actor={actor} /></Router>);
    fireEvent.click(await screen.findByRole("button", { name: "Queue SMS readiness check" }));
    expect(await screen.findByText("SMS readiness check queued.")).toHaveAttribute("role", "status");
    fireEvent.click(screen.getByRole("link", { name: "Webhooks", exact: true }));
    await waitFor(() => expect(screen.queryByText("SMS readiness check queued.")).toBeNull());
    expect(document.querySelector(".xus-note--live")).toHaveTextContent("");
  });

  // #9971: a page whose tabs share one page-wide h1 marks the open tab's title,
  // and a change of tab focuses that title; with no mark the h1 is focused.
  it("focuses the marked tab title on a change of tab, and the first h1 when nothing is marked", () => {
    function CivicLike() {
      const [path, setPath] = useState(window.location.pathname);
      useEffect(() => {
        const changed = () => setPath(window.location.pathname);
        window.addEventListener("popstate", changed);
        return () => window.removeEventListener("popstate", changed);
      }, []);
      return <><h1>Civic</h1>{path === "/m/civic/act" ? <h2 data-workspace-focus="">Take action</h2> : null}</>;
    }
    const go = (path) => act(() => { window.history.pushState({}, "", path); window.dispatchEvent(new PopStateEvent("popstate")); });
    window.history.replaceState({}, "", "/m/civic/officials");
    render(<Router view="civic"><CivicLike /></Router>);
    go("/m/civic/act");
    expect(screen.getByRole("heading", { name: "Take action", level: 2 })).toHaveFocus();
    go("/m/civic/outcomes");
    expect(screen.getByRole("heading", { name: "Civic", level: 1 })).toHaveFocus();
  });

  it("isolates integration pages and preserves unacknowledged one-time secrets across navigation", async () => {
    const store = createIntegrationControlStore();
    const actor = createActor({ userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", selectedOrganizationId: "11111111-1111-4111-8111-111111111111", roles: ["admin"], membershipStatus: "active", mfaSatisfied: true });
    window.history.replaceState({}, "", "/m/integrations/api-keys?demo=1");
    render(<Router view="integrations"><IntegrationControlPlane store={store} actor={actor} /></Router>);
    await screen.findByRole("heading", { name: "API keys" });
    expect(document.querySelectorAll("article[id^='integration-']")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "Local fixture only" } });
    fireEvent.click(screen.getByRole("button", { name: "Issue key" }));
    const secret = await screen.findByLabelText("API key");
    const value = secret.value;
    fireEvent.click(screen.getByRole("link", { name: "Jobs", exact: true }));
    expect(screen.getByLabelText("API key")).toHaveValue(value);
    expect(document.querySelector("#integration-api-keys")).not.toBeInTheDocument();
    expect(document.querySelector("#integration-jobs")).toBeInTheDocument();
    expect(window.location.href).not.toContain(value);
    fireEvent.click(screen.getByRole("button", { name: "I have copied it" }));
    fireEvent.click(screen.getByRole("link", { name: "Send an SMS", exact: true }));
    expect(document.querySelector("#integration-sms-unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
  });

  it.each(WORKSPACE_PAGES.map(page => [page.path, page.viewKey]))("registers %s under its existing authorized %s view", (path, view) => {
    expect(appViewForPath(path)).toBe(view);
    expect(appViewForPath(`${path}/`)).toBe(view);
    expect(appViewForPath(`${path}/invented`)).toBeNull();
  });

  it("resolves every nested TAB_PAGE_GROUPS base through the SPA allowlist", () => {
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
    const rewrites = new Set(vercel.rewrites.filter((entry) => entry.destination === "/index.html").map((entry) => entry.source));
    expect(NESTED_TAB_PAGE_GROUP_BASES).toHaveLength(6);
    for (const spec of NESTED_TAB_PAGE_GROUP_BASES) {
      expect(SPA_ROUTE_PATHS).toContain(spec.base);
      expect(rewrites.has(spec.base)).toBe(true);
      expect(appViewForPath(spec.base)).toBe(spec.view);
    }
  });

  it("canonicalizes nested tab-group bases onto the first tab while keeping demo search", async () => {
    window.history.replaceState({}, "", "/m/admin/evidence?demo=1");
    render(<Router view="admin"><Title /></Router>);
    await waitFor(() => expect(window.location.pathname).toBe("/m/admin/evidence/notes"));
    expect(window.location.search).toBe("?demo=1");
  });

  it("documents fail-open WorkspaceSection without a provider", () => {
    render(<LanguageProvider lang="en"><WorkspaceSection name="steward-requests"><div id="unscoped-section">open</div></WorkspaceSection></LanguageProvider>);
    expect(document.getElementById("unscoped-section")).toHaveTextContent("open");
  });

  it.each(Object.entries(STAFF_ROLE_NAVIGATION))("isolates every %s section before child effects mount", async (view, items) => {
    const mounted = vi.fn();
    function Child({ name }) { useEffect(() => { mounted(name); }, [name]); return <div data-testid="selected">{name}</div>; }
    const sections = items.filter(item => item.sectionId);
    const tree = <Router view={view}><Title />{sections.map(item => <WorkspaceSection key={item.key} name={item.sectionId}><Child name={item.sectionId} /></WorkspaceSection>)}</Router>;
    window.history.replaceState({}, "", `/m/${view}`);
    render(tree);
    expect(screen.queryByTestId("selected")).not.toBeInTheDocument();
    expect(mounted).not.toHaveBeenCalled();
    const planeTitle = t("en", STAFF_PLANES.find((plane) => plane.view === view).labelKey);
    const firstPageTitle = t("en", items[0].labelKey);
    const crumb = screen.getByRole("navigation", { name: "Page menu" }).querySelector(".workspace-page-menu__crumb");
    expect(crumb).toHaveTextContent(planeTitle);
    expect(crumb).not.toHaveTextContent("Overview");
    expect(crumb).not.toHaveTextContent(firstPageTitle);
    expect(pageMenuTrigger()).toHaveAccessibleName("Current page Overview");
    expect(pageMenuTrigger()).toHaveAttribute("aria-expanded", "false");
    for (const item of sections) {
      mounted.mockClear();
      choosePage(pageMenuTrigger(), item.path);
      expect(window.location.pathname).toBe(item.path);
      expect(screen.getAllByTestId("selected")).toHaveLength(1);
      expect(screen.getByTestId("selected")).toHaveTextContent(item.sectionId);
      expect(mounted).toHaveBeenCalledExactlyOnceWith(item.sectionId);
      expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
    }
  });

  it.each(Object.entries(TAB_PAGE_GROUPS))("routes every %s tab and restores browser history", async (group, spec) => {
    function Tabs() {
      const [tab, setTab] = useRoutedTab(group, spec.tabs[0]);
      return <><h1>{tab}</h1>{spec.tabs.map(id => <button key={id} onClick={() => setTab(id)}>{id}</button>)}<output data-testid="tab">{tab}</output></>;
    }
    window.history.replaceState({}, "", `${spec.base}/${spec.tabs[0]}?demo=1&embed=phone`);
    render(<Router view={spec.view}><Tabs /></Router>);
    const last = spec.tabs.at(-1);
    fireEvent.click(screen.getByRole("button", { name: last, exact: true }));
    expect(window.location.pathname).toBe(`${spec.base}/${last}`);
    expect(window.location.search).toBe("?demo=1&embed=phone");
    expect(screen.getByTestId("tab")).toHaveTextContent(last);
    await act(async () => { window.history.back(); });
    await waitFor(() => expect(screen.getByTestId("tab")).toHaveTextContent(spec.tabs[0]));
    await act(async () => { window.history.forward(); });
    await waitFor(() => expect(screen.getByTestId("tab")).toHaveTextContent(last));
  });

  // BUG-UG-PR1815-WORKLOAD-SUBMIT-NAVIGATION-ROUTE-UNREPAIRED-AT-A6-20260916.
  // A group sitting on its BASE url already renders its default tab, so a tab
  // handler that skips work for the "current" tab swallowed the click on the
  // default tab's own link and stranded the member on /m/<group> — the deployed
  // SAMPLE matrix caught it as PR1815_NAVIGATION_ROUTE on /m/workload/submit.
  // The repair belongs in useRoutedTab, whose setter is idempotent on location,
  // NOT in a post-handler fallback inside RoutedTabLink: the link cannot tell a
  // handler that declined to navigate from one that navigates asynchronously.
  it("leaves the address bar to a tab handler that navigates asynchronously", async () => {
    const spec = TAB_PAGE_GROUPS.tasks;
    const from = `${spec.base}/${spec.tabs[0]}`;
    const to = `${spec.base}/${spec.tabs.at(-1)}`;
    // TasksView commits its routed view inside document.startViewTransition,
    // so the pathname has NOT moved by the time the click handler returns.
    let deferred = null;
    function Deferred() {
      const context = useWorkspace();
      return <RoutedTabLink group="tasks" value={spec.tabs.at(-1)} onClick={() => { deferred = () => context.open(to); }}>{spec.tabs.at(-1)}</RoutedTabLink>;
    }
    const entries = enterAtHistoryTip(from);
    render(<Router view={spec.view}><Deferred /></Router>);
    fireEvent.click(document.querySelector(`a[href="${to}"]`));
    expect(deferred).not.toBeNull();
    expect(window.location.pathname).toBe(from);
    expect(window.history.length).toBe(entries);
    await act(async () => { deferred(); });
    expect(window.location.pathname).toBe(to);
    // One entry, not two: a second push of the same route would leave the
    // first Back inert.
    expect(window.history.length - entries).toBe(1);
    await act(async () => { window.history.back(); });
    await waitFor(() => expect(window.location.pathname).toBe(from));
  });

  it("does not stack a history entry when the selected canonical tab is re-selected", () => {
    const spec = TAB_PAGE_GROUPS.workload;
    const entries = enterAtHistoryTip("/m/workload/history");
    render(<Router view="workload"><Tabs group="workload" spec={spec} /></Router>);
    expect(screen.getByTestId("tab")).toHaveTextContent("history");
    fireEvent.click(screen.getByRole("button", { name: "history" }));
    expect(window.location.pathname).toBe("/m/workload/history");
    expect(window.history.length).toBe(entries);
    // A real hop still pushes, and Back returns to the tab that never doubled.
    fireEvent.click(screen.getByRole("button", { name: "stats" }));
    expect(window.location.pathname).toBe("/m/workload/stats");
    expect(window.history.length - entries).toBe(1);
  });

  // The member network alias is the one tab whose canonical path is not
  // `${base}/${tab}`, so the comparison has to read the aliased target too.
  it("does not stack a history entry when the member network alias is re-selected", () => {
    const spec = TAB_PAGE_GROUPS.coordination;
    const entries = enterAtHistoryTip("/m/network?demo=1");
    render(<Router view="coordination" hat="member"><Tabs group="coordination" spec={spec} /></Router>);
    expect(screen.getByTestId("tab")).toHaveTextContent("network");
    fireEvent.click(screen.getByRole("button", { name: "network" }));
    expect(window.location.pathname).toBe("/m/network");
    expect(window.history.length).toBe(entries);
  });

  it.each(Object.entries(TAB_PAGE_GROUPS))("lands on the %s default tab from the group base with one history entry", (group, spec) => {
    const target = `${spec.base}/${spec.tabs[0]}`;
    const entries = enterAtHistoryTip(spec.base);
    render(<Router view={spec.view}><Tabs group={group} spec={spec} /></Router>);
    // A NESTED base landing replaceStates itself onto its default tab on
    // mount, so it is already there and the click must add nothing; every
    // other base keeps its own url and the click is the one hop that moves it.
    const landed = window.location.pathname === target;
    fireEvent.click(screen.getByRole("button", { name: spec.tabs[0] }));
    expect(window.location.pathname).toBe(target);
    expect(window.history.length - entries).toBe(landed ? 0 : 1);
  });

  it("pins /m/workload/submit as the landed workload route without moving the base", () => {
    const data = { workload: { entries: [], stats: { enoughData: false } } };
    window.history.replaceState({}, "", "/m/workload");
    const view = render(<Router view="workload"><WorkloadView data={data} /></Router>);
    // The base keeps landing on Submit without rewriting itself (desktop-shell
    // and App route tests pin /m/workload as a real member destination).
    expect(window.location.pathname).toBe("/m/workload");
    expect(screen.getByRole("link", { name: "Submit" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("link", { name: "Submit" }));
    expect(window.location.pathname).toBe("/m/workload/submit");
    expect(screen.getByRole("link", { name: "Submit" })).toHaveAttribute("aria-current", "page");
    view.unmount();

    // Direct entry, and a Back/Forward pair across a sibling tab, stay on the
    // submit pathname rather than collapsing onto the group base.
    window.history.replaceState({}, "", "/m/workload/submit");
    render(<Router view="workload"><WorkloadView data={data} /></Router>);
    expect(window.location.pathname).toBe("/m/workload/submit");
    expect(screen.getByRole("link", { name: "Submit" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("link", { name: "History" }));
    expect(window.location.pathname).toBe("/m/workload/history");
    fireEvent.click(screen.getByRole("link", { name: "Submit" }));
    expect(window.location.pathname).toBe("/m/workload/submit");
  });

  it("canonicalizes the legacy automation anchor without crossing unrelated role anchors", async () => {
    expect(canonicalAutomationPath("/m/admin", "?demo=1", "#admin-automation-control"))
      .toBe("/m/automations/discover?demo=1");
    window.history.replaceState({}, "", "/m/admin?demo=1");
    render(<Router view="admin"><Title /><a href="#admin-invitations">Legacy invitation link</a></Router>);
    fireEvent.click(screen.getByRole("link", { name: "Legacy invitation link" }));
    expect(window.location.pathname).toBe("/m/admin/invitations");
    expect(workspacePageForLocation("/m/steward", "#admin-access")).toBeNull();
    expect(workspacePageForLocation("/m/admin", "#%zz")).toBeNull();
  });

  it("keeps the actual Admin overview free of unrelated feature loaders and forms", async () => {
    const api = {
      loadDesk: vi.fn().mockResolvedValue(structuredClone(fallbackData.adminDesk)),
      loadFormTemplates: vi.fn(), loadAdministrativeEvidence: vi.fn(), loadFailedLoginInbox: vi.fn(),
    };
    window.history.replaceState({}, "", "/m/admin?demo=1");
    render(<Router view="admin"><AdminView data={{ member: { initials: "AR", organizationRoles: ["admin"] } }} api={api} onNotice={vi.fn()} /></Router>);
    await waitFor(() => expect(document.querySelector(".pkpi-grid")).toBeInTheDocument());
    expect(document.querySelectorAll(".role-section-target")).toHaveLength(0);
    expect(document.querySelectorAll("form")).toHaveLength(0);
    expect(api.loadFormTemplates).not.toHaveBeenCalled();
    expect(api.loadAdministrativeEvidence).not.toHaveBeenCalled();
    choosePage(pageMenuTrigger(), "/m/admin/access");
    expect(document.querySelectorAll(".role-section-target")).toHaveLength(1);
    expect(document.querySelector("#admin-access")).toBeInTheDocument();
    expect(document.querySelector(".pkpi-grid")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Organization roles & access");
  });

  it("keeps automation recipes inert until explicitly saved and separates safety from history", async () => {
    const page = { rows: [], total: 0, page: 1, pageSize: 6 };
    const api = { load: vi.fn().mockResolvedValue({ state: "ready", control: { capabilities: { schemaVersion: 2, triggers: ["overdue_task"], actions: ["create_standard_task"], cadences: ["hourly", "daily", "weekly"], maxThresholdDays: 90 }, settings: { enabled: false, maxEffectsPerRun: 20 }, schedulerConfigured: true, definitions: [], runs: [] } }), getDefinitions: vi.fn().mockResolvedValue({ ok: true, data: page }), getRuns: vi.fn().mockResolvedValue({ ok: true, data: page }), saveDefinition: vi.fn(), setEnabled: vi.fn() };
    window.history.replaceState({}, "", "/m/automations/definitions?demo=1");
    render(<Router view="automations"><AutomationControlRoom session={{ authenticated: true, role: "admin", selectedHat: "admin", selectedOrganizationId: "11111111-1111-4111-8111-111111111111", membershipStatus: "active", organizationStatus: "active", mfaSatisfied: true }} api={api} /></Router>);
    await screen.findByRole("heading", { name: "Your automations" });
    expect(screen.queryByLabelText("Maximum effects per run")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Run history" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Browse recipes" }));
    expect(window.location.pathname).toBe("/m/automations/recipes");
    fireEvent.click(await screen.findByRole("button", { name: "Use recipe: Review overdue work", exact: true }));
    expect(window.location.pathname).toBe("/m/automations/builder");
    expect(screen.getByLabelText("Name")).toHaveValue("Review overdue work");
    expect(api.saveDefinition).not.toHaveBeenCalled();
    expect(api.setEnabled).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: "Runs", exact: true }));
    expect(screen.getByRole("heading", { name: "Run history" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Readiness and safety", exact: true }));
    expect(screen.getByLabelText("Maximum effects per run")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Run history" })).not.toBeInTheDocument();
  });

  // DEBT-UG-LEGACY-AUTOMATION-CONTROL-ROOM-AND-TESTS-ARE-UNREACHABLE-20260921:
  // AutomationControlRoom used to fall back to a second, pre-workspace control
  // room when no WorkspacePages provider was present. App never mounts it that
  // way, so the fallback was dead code carrying its own green tests. The
  // provider is now the only supported shape, and these pins fail if a shipped
  // route mounts the desk outside one or the legacy branch comes back.
  it("mounts the automation desk only inside a WorkspacePages provider", async () => {
    const viewSession = { userId: "50900000-0000-4000-8000-000000000111", organizationId: "50900000-0000-4000-8000-000000000108", organizationRoles: ["admin"], membershipStatus: "active", organizationStatus: "active", mfaSatisfied: true, selectedHat: "admin" };
    window.history.replaceState({}, "", "/m/automations");
    const { container, unmount } = render(<Router view="automations"><AutomationControlRoomView session={viewSession} client={null} /></Router>);
    expect(container.querySelector("[data-mi1-surface='automation-control-room']")).toHaveClass("screen");
    expect(await screen.findByText("Automation storage is not configured. Automations remain paused.")).toBeInTheDocument();
    unmount();

    const api = { load: vi.fn() };
    const outside = render(<LanguageProvider lang="en"><AutomationControlRoom session={{ authenticated: true, role: "admin", selectedOrganizationId: "11111111-1111-4111-8111-111111111111" }} api={api} /></LanguageProvider>);
    expect(outside.container).toBeEmptyDOMElement();
    expect(api.load).not.toHaveBeenCalled();

    const source = (path) => readFileSync(path, "utf8");
    const room = source("src/features/automation/AutomationControlRoom.jsx").replace(/^\s*\/\/.*$/gm, "");
    expect(room).not.toMatch(/Legacy|DefinitionFields|failureKey|api\.(saveDefinition|previewRun)/);
    const app = source("src/App.jsx");
    expect(app.match(/<AutomationControlRoomView\b[^\n]*/g)).toEqual([expect.stringMatching(/^<AutomationControlRoomView session=\{mi1Actor\}/)]);
    expect(app).toMatch(/views\.automations = <AutomationControlRoomView /);
    // Every rendered view slot, automations included, is wrapped by the provider.
    const viewRenders = app.match(/\{views\[[^\]]+\]\}/g);
    expect(viewRenders.length).toBeGreaterThan(0);
    for (const render of viewRenders) expect(app).toMatch(new RegExp(`<WorkspacePages [^>]*>${render.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</WorkspacePages>`));
    expect(source("src/views/AutomationControlRoomView.jsx")).toContain("<AutomationControlRoom ");
  });
});

describe("a page that draws its own way between pages", () => {
  it("drops the page menu with menu={false} and keeps the section context", () => {
    window.history.replaceState({}, "", "/m/settings");
    function Section() { return <p data-testid="section">{useWorkspace()?.section}</p>; }
    render(<LanguageProvider lang="en"><WorkspacePages view="settings" location="/m/settings" navigate={() => {}} menu={false}><Section /></WorkspacePages></LanguageProvider>);
    expect(screen.queryByRole("navigation", { name: "Page menu" })).toBeNull();
    expect(screen.getByTestId("section")).toHaveTextContent("overview");
  });
});
