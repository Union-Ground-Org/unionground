import { describe, expect, it } from "vitest";

import { appViewForPath } from "../src/lib/appRoutes.js";
import { STAFF_ROLE_NAVIGATION } from "../src/lib/staffNavigation.js";
import { STAFF_TOOLS, staffToolAllowsHat } from "../src/lib/staffPlanes.js";
import { TAB_PAGE_GROUPS, workspacePageForLocation } from "../src/lib/workspacePages.js";
import {
  automationWorkflowHref,
  canonicalAutomationPath,
} from "../src/features/automation/links.js";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000509";
const SOURCE_ID = "50900000-0000-4000-8000-000000000109";
const roles = ["steward", "coordinator", "advisor", "admin", "vp"];

function activeSession(role) {
  return {
    authenticated: true,
    selectedOrganizationId: ORGANIZATION_ID,
    membershipStatus: "active",
    organizationStatus: "active",
    mfaSatisfied: true,
    role,
    selectedHat: role,
    organizationRoles: [role],
  };
}

describe("shared automation route", () => {
  it("registers one discoverable workspace destination for every staff hat", () => {
    expect(STAFF_TOOLS).toContainEqual({
      key: "automations",
      labelKey: "workspace.automations",
      view: "automations",
      path: "/m/automations",
    });
    for (const role of roles) {
      expect(staffToolAllowsHat("automations", role)).toBe(true);
      expect(STAFF_ROLE_NAVIGATION[role].filter(({ path }) => path === "/m/automations"))
        .toEqual([expect.objectContaining({ key: "automations", viewKey: "automations" })]);
    }
    expect(staffToolAllowsHat("automations", "member")).toBe(false);
  });

  it("maps every automation tab to the shared staff view", () => {
    expect(TAB_PAGE_GROUPS.automation).toEqual({
      view: "automations",
      base: "/m/automations",
      tabs: ["discover", "definitions", "recipes", "builder", "definition", "history", "run", "settings"],
    });
    for (const tab of TAB_PAGE_GROUPS.automation.tabs) {
      const path = `/m/automations/${tab}`;
      expect(appViewForPath(path)).toBe("automations");
      expect(workspacePageForLocation(path)).toMatchObject({ group: "automation", tab, viewKey: "automations" });
    }
  });

  it.each(roles)("opens source-aware recipes for an active %s", (role) => {
    expect(automationWorkflowHref(activeSession(role), "task", SOURCE_ID))
      .toBe(`/m/automations/recipes?sourceKind=task&sourceId=${SOURCE_ID}`);
  });

  it("keeps members and stale staff hats out of source-aware authoring", () => {
    expect(automationWorkflowHref(activeSession("member"), "task", SOURCE_ID)).toBeNull();
    expect(automationWorkflowHref({ ...activeSession("admin"), selectedHat: "steward" }, "task", SOURCE_ID)).toBeNull();
  });
});

describe("legacy automation redirects", () => {
  it.each(["admin", "vp"])("redirects %s tabs to the matching shared tab", (role) => {
    expect(canonicalAutomationPath(`/m/${role}/automations/history`, "?demo=1"))
      .toBe("/m/automations/history?demo=1");
    expect(canonicalAutomationPath(`/m/${role}/automations`, ""))
      .toBe("/m/automations/discover");
    expect(canonicalAutomationPath(`/m/${role}`, "?demo=1", `#${role}-automation-control`))
      .toBe("/m/automations/discover?demo=1");
  });

  it("preserves only explicit automation context and shell query keys", () => {
    const search = new URLSearchParams({
      demo: "1",
      embed: "phone",
      sourceKind: "task",
      sourceId: SOURCE_ID,
      definition: ORGANIZATION_ID,
      run: SOURCE_ID,
      notification: "private",
      token: "secret",
      role: "admin",
    });
    expect(canonicalAutomationPath("/m/admin/automations/definition", `?${search}`))
      .toBe(`/m/automations/definition?demo=1&embed=phone&sourceKind=task&sourceId=${SOURCE_ID}&definition=${ORGANIZATION_ID}&run=${SOURCE_ID}`);
  });

  it("does not rewrite shared, unrelated, or invented legacy paths", () => {
    expect(canonicalAutomationPath("/m/automations/discover", "?demo=1")).toBeNull();
    expect(canonicalAutomationPath("/m/admin", "?demo=1")).toBeNull();
    expect(canonicalAutomationPath("/m/admin/automations/invented", "?demo=1")).toBeNull();
  });
});
