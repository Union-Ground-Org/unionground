// @vitest-environment jsdom

// TEST-UG-COORDINATION-MEMBER-COVERAGE-AND-STAFFONLY-TAB-ROUTES-20260919,
// The three
// staffOnly coordination tabs have one explicit URL/audience contract, and
// route, tab visibility and member/staff outcomes agree with it. The contract
// lives in src/features/coordination/contract.js (COORDINATION_TABS.staffOnly);
// src/lib/workspacePages.js reads it into STAFF_ONLY_WORKSPACE_TAB_PATHS, and
// the one hat gate in src/App.jsx refuses those paths to a member hat exactly
// as it refuses /m/support/handoffs. No staff identity is granted to the member.
import { useEffect, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { COORDINATION_TABS } from "../src/features/coordination/contract.js";
import { visibleCoordinationTabs } from "../src/features/coordination/authorization.js";
import { OrganizationCoordinationDesk } from "../src/features/coordination/ui/OrganizationCoordinationDesk.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { buildCoordinationActor } from "../src/lib/mi1CoordinationWiring.js";
import { isStaffOnlyWorkspaceTabPath, STAFF_ONLY_WORKSPACE_TAB_PATHS } from "../src/lib/workspacePages.js";
import { primeDemoHat } from "./helpers/demoHat.js";
import { PHONE_HOME_GREETING } from "./helpers/homeGreeting.js";

const STAFF_ONLY_TABS = ["coalitions", "operations", "mobilize"];
const REFUSAL = "Your Worker role cannot open that page. Opening Home instead.";

afterEach(() => {
  window.history.replaceState({}, "", "/m");
});

describe("coordination staff-only tab URL/audience contract", () => {
  it("derives the three staff-only tab paths from the coordination contract", () => {
    expect(COORDINATION_TABS.filter((tab) => tab.staffOnly).map((tab) => tab.id)).toEqual(STAFF_ONLY_TABS);
    for (const tab of STAFF_ONLY_TABS) {
      expect(STAFF_ONLY_WORKSPACE_TAB_PATHS).toContain(`/m/coordination/${tab}`);
      expect(isStaffOnlyWorkspaceTabPath(`/m/coordination/${tab}`)).toBe(true);
      expect(isStaffOnlyWorkspaceTabPath(`/m/coordination/${tab}/`)).toBe(true);
    }
    // Tab visibility agrees with the URL contract: a member hat never sees a
    // staff-only tab, a staff hat sees every tab.
    const member = { selectedHat: "member", roles: [], organizationRoles: [], mfaSatisfied: true };
    expect(visibleCoordinationTabs(member).map((tab) => tab.id)).toEqual(["missions", "network", "chapter"]);
    for (const tab of ["missions", "network", "chapter"]) {
      expect(isStaffOnlyWorkspaceTabPath(`/m/coordination/${tab}`)).toBe(false);
    }
    expect(isStaffOnlyWorkspaceTabPath("/m/network")).toBe(false);
    expect(isStaffOnlyWorkspaceTabPath("/m/coordination")).toBe(false);
  });

  it.each(STAFF_ONLY_TABS)("refuses a member hat at /m/coordination/%s onto /m without advertising it", async (tab) => {
    primeDemoHat("member");
    window.history.replaceState({}, "", `/m/coordination/${tab}?demo=1`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/m"));
    // The SAMPLE rider the denied link carried survives the repair.
    expect(window.location.search).toBe("?demo=1");
    expect(screen.getByText(REFUSAL)).toBeInTheDocument();
    // No coordination surface, and the refused destination is never linked.
    expect(document.querySelector(".coord-desk, .coord-state, .workspace-pages")).toBeNull();
    expect(document.querySelector(`a[href="/m/coordination/${tab}"], a[href^="/m/coordination/${tab}?"]`)).toBeNull();
  });

  it.each(STAFF_ONLY_TABS)("keeps /m/coordination/%s for a steward hat", async (tab) => {
    primeDemoHat("steward");
    window.history.replaceState({}, "", `/m/coordination/${tab}?demo=1`);
    render(<App />);
    // The coordination view is reached and the URL survives: the SAMPLE origin
    // carries no organization snapshot, so the desk renders its headed
    // no-organization state here; the tab selection is proved on the desk below
    // with a ready snapshot.
    await waitFor(() => expect(document.querySelector(".coord-desk, .coord-state-copy")).not.toBeNull());
    expect(window.location.pathname).toBe(`/m/coordination/${tab}`);
    expect(screen.queryByText(REFUSAL)).toBeNull();
    expect(document.querySelector(".coord-desk, .coord-state-copy")).not.toBeNull();
  });

  // The same Router the workspace-page contracts use: the routed tab comes from
  // the real URL and navigation writes back to history.
  function Router({ view, children }) {
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
    return <LanguageProvider lang="en"><WorkspacePages view={view} location={location} navigate={navigate}>{children}</WorkspacePages></LanguageProvider>;
  }
  const staff = buildCoordinationActor({
    userId: "user-1", organizationId: "org-1", membershipStatus: "active", selectedHat: "coordinator",
    organizationRoles: ["coordinator"], mfaSatisfied: true, sessionScope: "resolved",
  });
  const readySnapshot = {
    state: "ready", organizationId: "org-1", staff: true, records: [], leaderboards: [], messages: [],
    resources: [], exportRuns: [], outreach: [],
  };

  it.each(STAFF_ONLY_TABS)("selects the %s tab for a staff hat at its own URL on a ready desk", (tab) => {
    window.history.replaceState({}, "", `/m/coordination/${tab}?demo=1`);
    render(<Router view="coordination"><OrganizationCoordinationDesk actor={staff} model={readySnapshot} status="ready" /></Router>);
    expect(document.querySelector(".coord-desk")).not.toBeNull();
    expect(screen.getByRole("tab", { selected: true })).toHaveAttribute("id", `coord-tab-${tab}`);
    expect(document.querySelector(`#coord-panel-${tab}`)).not.toBeNull();
    expect(window.location.pathname).toBe(`/m/coordination/${tab}`);
  });

  it("never selects a staff-only tab for a member actor on the desk, whatever the URL says", () => {
    const member = buildCoordinationActor({ ...staff, selectedHat: "member", organizationRoles: [] });
    window.history.replaceState({}, "", "/m/coordination/coalitions?demo=1");
    render(<Router view="coordination"><OrganizationCoordinationDesk actor={member} model={{ ...readySnapshot, staff: false }} status="ready" /></Router>);
    expect(screen.queryByRole("tab", { name: "Coalitions" })).toBeNull();
    expect(screen.getByRole("tab", { selected: true })).toHaveAttribute("id", "coord-tab-missions");
    expect(document.querySelector("#coord-panel-coalitions")).toBeNull();
  });
});
