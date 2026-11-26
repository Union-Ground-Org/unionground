import { readFileSync } from "node:fs";
import { readAppSource } from "./helpers/app-source.js";
import { describe, expect, it } from "vitest";
import {
  APP_PATH_ALIASES,
  appViewForPath,
  AUTH_PATHS,
  MEMBER_PATH_VIEWS,
  memberCoordinationAliasPath,
  normalizeAppPath,
  SPA_ROUTE_PATHS,
  STAFF_TOOL_PATH_VIEWS,
} from "../src/lib/appRoutes.js";
import { COORDINATION_TABS } from "../src/features/coordination/contract.js";
import { STAFF_ONLY_WORKSPACE_TAB_PATHS, TAB_PAGE_GROUPS, workspacePageForLocation } from "../src/lib/workspacePages.js";
import { PUBLIC_STATIC_ROUTES } from "../scripts/public-route-metadata.mjs";
import { STANDALONE_DOCUMENT } from "../scripts/member-shell-build.mjs";

const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
const rewrites = vercel.rewrites
  .filter((entry) => ["/index.html", `/${STANDALONE_DOCUMENT}`].includes(entry.destination) || entry.destination.startsWith("/api/public-page?path="))
  .map((entry) => entry.source);

describe("SPA route registry", () => {
  // BUG-UG-M-HOME-AND-MEMBER-TOOLS-ADDRESSES-NOT-FOUND-20261006.
  it("redirects every typed alias to a canonical page, never serving it as a route of its own", () => {
    expect(APP_PATH_ALIASES).toMatchObject({ "/m/home": "/m", "/m/settings/member-tools": "/m/settings/shortcuts" });
    expect(appViewForPath("/m")).toBe("today");
    expect(appViewForPath("/m/settings/shortcuts")).toBe("settings");
    for (const [alias, destination] of Object.entries(APP_PATH_ALIASES)) {
      expect(SPA_ROUTE_PATHS).toContain(destination.split("?", 1)[0]);
      expect(SPA_ROUTE_PATHS).not.toContain(alias);
      expect(rewrites).not.toContain(alias);
      expect(vercel.redirects.filter((entry) => entry.source === alias)).toEqual([
        { source: alias, destination, permanent: true },
      ]);
    }
    const aliasRedirects = vercel.redirects.filter((entry) => !entry.has && (entry.source.startsWith("/m") || ["/admin", "/settings"].includes(entry.source)));
    expect(Object.fromEntries(aliasRedirects.map((entry) => [entry.source, entry.destination]))).toEqual(APP_PATH_ALIASES);
  });

  it("matches the Vercel exact rewrite allowlist in both directions", () => {
    expect([...rewrites].sort()).toEqual([...SPA_ROUTE_PATHS].sort());
  });

  it("normalizes every registered member and staff path before lookup", () => {
    for (const [path, view] of Object.entries({ ...MEMBER_PATH_VIEWS, ...STAFF_TOOL_PATH_VIEWS })) {
      expect(appViewForPath(path)).toBe(view);
      expect(appViewForPath(`${path}/`)).toBe(view);
      expect(appViewForPath(`${path}///`)).toBe(view);
    }
    for (const path of AUTH_PATHS) expect(normalizeAppPath(`${path}/`)).toBe(path);
  });

  it("does not turn unknown paths or physical public documents into member views", () => {
    expect(appViewForPath("/m/not-a-route/")).toBeNull();
    expect(SPA_ROUTE_PATHS).not.toContain("/m/not-a-route");
    for (const route of PUBLIC_STATIC_ROUTES) {
      expect(appViewForPath(`${route}/`)).toBeNull();
      expect(SPA_ROUTE_PATHS).not.toContain(route);
    }
  });

  // The public union catalog (organization landing pages and the claim
  // confirmation) is left out of Union Ground (owner decision, wave 2): no
  // public page may carry a campaign's organization or its claimants, so
  // neither route is served, rewritten, listed or linked.
  it("serves no public organization or claim route", async () => {
    const routes = await import("../src/lib/appRoutes.js");
    expect(routes.PUBLIC_ORGANIZATION_SPA_PATHS).toBeUndefined();
    for (const path of ["/orgs/:slug", "/unions/claim/confirm", "/unions"]) {
      expect(SPA_ROUTE_PATHS).not.toContain(path);
      expect(vercel.rewrites.some((entry) => entry.source === path)).toBe(false);
      expect(PUBLIC_STATIC_ROUTES).not.toContain(path);
      expect(appViewForPath(path)).toBeNull();
    }
    expect(SPA_ROUTE_PATHS.some((route) => route.startsWith("/orgs"))).toBe(false);
    expect(vercel.rewrites.some((entry) => entry.source.startsWith("/orgs"))).toBe(false);
    expect(PUBLIC_STATIC_ROUTES.some((route) => route.startsWith("/orgs"))).toBe(false);
    expect(readFileSync("public/sitemap.xml", "utf8")).not.toMatch(/\/orgs|claim\/confirm/);
    expect(readFileSync("src/components/PublicDocumentShell.jsx", "utf8")).not.toMatch(/\/orgs|claim\/confirm/);
    const app = readAppSource();
    expect(app).not.toContain("OrganizationClaimConfirmView");
    expect(app).not.toContain("OrganizationLandingView");
  });

  it("maps /m/network and /m/coordination onto the same coordination view", () => {
    expect(appViewForPath("/m/network")).toBe("coordination");
    expect(appViewForPath("/m/coordination")).toBe("coordination");
    expect(MEMBER_PATH_VIEWS["/m/network"]).toBe("coordination");
    expect(STAFF_TOOL_PATH_VIEWS["/m/coordination"]).toBe("coordination");
    expect(SPA_ROUTE_PATHS).toContain("/m/network");
    expect(SPA_ROUTE_PATHS).toContain("/m/coordination");
    const app = readAppSource();
    expect([...app.matchAll(/<OrganizationCoordinationView /g)]).toHaveLength(1);
    expect(app).toContain('return nextView === "coordination" || !STAFF_VIEWS.includes(nextView)');
  });

  it("keeps /m/network as the member hat path a reload can still select", () => {
    expect(memberCoordinationAliasPath("/m/network")).toBe(true);
    expect(memberCoordinationAliasPath("/m/network/")).toBe(true);
    expect(memberCoordinationAliasPath("/m/coordination/network")).toBe(false);
    expect(workspacePageForLocation("/m/network")).toMatchObject({
      path: "/m/network",
      viewKey: "coordination",
      group: "coordination",
      tab: "network",
    });
    expect(appViewForPath("/m/coordination/network")).toBe("coordination");
    const app = readAppSource();
    expect(app).toContain("if (memberCoordinationAliasPath()) return \"member\"");
    expect(app).toContain("hat={selectedStaffHat}");
  });

  // BUG-UG-PR1815-SUPPORT-HANDOFFS-MEMBER-NOT-DENIED-AT-A6-20260916: a
  // staff-only workspace tab must still be SERVED by the SPA (the app has to
  // boot to refuse it), and the refusal must run through the one hat gate
  // rather than a second copy keyed on the handoffs path.
  it("serves staff-only workspace tabs through the SPA and refuses them in the hat gate", () => {
    expect(STAFF_ONLY_WORKSPACE_TAB_PATHS).toContain("/m/support/handoffs");
    // TEST-UG-COORDINATION-MEMBER-COVERAGE-AND-STAFFONLY-TAB-ROUTES-20260919
    // (acceptance 3): the three staffOnly coordination tabs have one URL/audience
    // contract, read from COORDINATION_TABS, and their URLs are staff destinations.
    expect(COORDINATION_TABS.filter((tab) => tab.staffOnly).map((tab) => tab.id)).toEqual(["coalitions", "operations", "mobilize"]);
    expect(TAB_PAGE_GROUPS.coordination.tabs).toEqual(COORDINATION_TABS.map((tab) => tab.id));
    expect(TAB_PAGE_GROUPS.coordination.staffOnlyTabs).toEqual(["coalitions", "operations", "mobilize"]);
    for (const tab of ["coalitions", "operations", "mobilize"]) {
      expect(STAFF_ONLY_WORKSPACE_TAB_PATHS).toContain(`/m/coordination/${tab}`);
    }
    expect(STAFF_ONLY_WORKSPACE_TAB_PATHS).not.toContain("/m/coordination/missions");
    expect(STAFF_ONLY_WORKSPACE_TAB_PATHS).not.toContain("/m/coordination/network");
    expect(STAFF_ONLY_WORKSPACE_TAB_PATHS).not.toContain("/m/coordination/chapter");
    for (const path of STAFF_ONLY_WORKSPACE_TAB_PATHS) {
      expect(SPA_ROUTE_PATHS).toContain(path);
      expect(rewrites).toContain(path);
      // Coordination is a staff tool with a member alias, so its tab paths are
      // registered under STAFF_TOOL_PATH_VIEWS; support tabs stay member paths.
      expect(appViewForPath(path)).toBe(MEMBER_PATH_VIEWS[path] ?? STAFF_TOOL_PATH_VIEWS[path]);
    }
    const app = readAppSource();
    expect(app).toContain("if (!authorizedStaffHat && isStaffOnlyWorkspaceTabPath(path?.split(/[?#]/, 1)[0])) return false;");
    expect(app).not.toContain("\"/m/support/handoffs\"");
  });
});
