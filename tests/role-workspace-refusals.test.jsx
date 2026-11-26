import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { OrganizationRoleRefusal } from "../src/components/OrganizationRoleRefusal.jsx";
import { primeDemoData } from "../src/data/demoData.js";
import { KnowledgeWorkspacePanel } from "../src/features/knowledge/KnowledgeWorkspacePanel.jsx";
import { readActingHat, writeActingHat } from "../src/lib/actingHat.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { organizationWorkspaceAccess } from "../src/lib/organizationWorkspaceAccess.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

// REQ-UG-ROLE-WORKSPACE-REFUSALS-20261030 (finding 34): a President
// and Coordinators wore their role and then met "Only an organization
// administrator or president … can manage integrations" with a "Try again"
// that never worked, "Select an authorized staff role to open this workspace"
// with no role to pick, "Analytics isn't open to this role.", and a library
// "not authorized" box after a save that worked. Invitations give chapter
// roles; these surfaces open only with an organization-wide grant.

const OWN_ID = fallbackData.member.id;

describe("which organization-wide role opens each surface", () => {
  it("opens integrations for an Admin or President hat with either grant", () => {
    expect(organizationWorkspaceAccess("integrations", { hat: "vp", roles: ["vp"], organizationRoles: ["vp"] }).status).toBe("open");
    expect(organizationWorkspaceAccess("integrations", { hat: "vp", roles: ["vp", "admin"], organizationRoles: ["admin"] }).status).toBe("open");
    expect(organizationWorkspaceAccess("integrations", { hat: "vp", roles: ["vp"], organizationRoles: [] }))
      .toEqual({ status: "chapterOnly", allowed: ["admin", "vp"], chapterOnly: ["vp"] });
    expect(organizationWorkspaceAccess("integrations", { hat: "coordinator", roles: ["coordinator"], organizationRoles: ["coordinator"] }))
      .toEqual({ status: "missing", allowed: ["admin", "vp"] });
  });

  it("opens the organization map only under a hat that is itself granted, and offers a held one", () => {
    expect(organizationWorkspaceAccess("organizationMap", { hat: "coordinator", roles: ["coordinator"], organizationRoles: ["coordinator"] }).status).toBe("open");
    expect(organizationWorkspaceAccess("organizationMap", { hat: "coordinator", roles: ["coordinator", "admin"], organizationRoles: ["admin"] }))
      .toMatchObject({ status: "switch", hats: ["admin"] });
    expect(organizationWorkspaceAccess("organizationMap", { hat: "coordinator", roles: ["coordinator"], organizationRoles: [] }))
      .toMatchObject({ status: "chapterOnly", chapterOnly: ["coordinator"] });
    // A grant the account cannot wear is never offered.
    expect(organizationWorkspaceAccess("organizationMap", { hat: "coordinator", roles: ["coordinator"], organizationRoles: ["admin"] }))
      .toMatchObject({ status: "chapterOnly" });
  });

  it("opens analytics under any staff hat once any staff role is granted organization-wide", () => {
    expect(organizationWorkspaceAccess("analytics", { hat: "steward", roles: ["steward", "admin"], organizationRoles: ["admin"] }).status).toBe("open");
    expect(organizationWorkspaceAccess("analytics", { hat: "coordinator", roles: ["coordinator"], organizationRoles: [] }).status).toBe("chapterOnly");
    expect(organizationWorkspaceAccess("analytics", { hat: "member", roles: [], organizationRoles: [] }).status).toBe("missing");
  });

  it("leaves every other page alone", () => {
    expect(organizationWorkspaceAccess("tasks", { hat: "member" })).toEqual({ status: "open" });
    expect(organizationWorkspaceAccess("organizationMap").status).toBe("missing");
  });
});

function refusal(access, lang = "en", onWear = vi.fn()) {
  render(<LanguageProvider lang={lang}><OrganizationRoleRefusal pageKey="nav.organizationMap" access={access} onWear={onWear} /></LanguageProvider>);
  return onWear;
}

describe("the refusal", () => {

  it("offers only the held roles that open the page, and wears the chosen one", () => {
    const onWear = refusal({ status: "switch", allowed: ["steward", "coordinator", "advisor", "admin", "vp"], hats: ["admin"] });
    expect(screen.getByText("Organization map opens with your organization-wide Admin role.")).toBeVisible();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Act as Admin here" }));
    expect(onWear).toHaveBeenCalledWith("admin");
  });

  it("names the roles that open it to someone holding none, in Spanish too", () => {
    refusal({ status: "missing", allowed: ["admin", "vp"] }, "es");
    expect(screen.getByRole("heading", { name: "Mapa organizacional necesita un rol de toda la organización" })).toBeVisible();
    expect(screen.getByText(/^Mapa organizacional se abre con un rol de Administrador o .+ de toda la organización\. Una persona administradora/u)).toBeVisible();
  });
});

describe("the live pages", () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
    global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
  });
  afterEach(() => primeDemoData(fallbackData));

  function open(path, { roles, organizationRoles, hat }) {
    primeDemoData({ ...fallbackData, roles, member: { ...fallbackData.member, organizationRoles } });
    writeActingHat(OWN_ID, hat);
    window.history.replaceState({}, "", path);
    render(<App />);
  }



  it("offers the organization-wide Admin role on the organization map and keeps the page when worn", async () => {
    open("/m/organization-map", { roles: ["coordinator", "admin"], organizationRoles: ["admin"], hat: "coordinator" });
    fireEvent.click(await screen.findByRole("button", { name: "Act as Admin here" }));
    await waitFor(() => expect(document.querySelector("[data-organization-role-refusal]")).toBeNull());
    expect(window.location.pathname).toBe("/m/organization-map");
    expect(readActingHat()).toEqual({ userId: OWN_ID, hat: "admin" });
  });

  it("loads the surface without a refusal when the worn role is granted organization-wide", async () => {
    open("/m/organization-map", { roles: ["coordinator"], organizationRoles: ["coordinator"], hat: "coordinator" });
    await waitFor(() => expect(readActingHat()).toEqual({ userId: OWN_ID, hat: "coordinator" }));
    expect(document.querySelector("[data-organization-role-refusal]")).toBeNull();
    expect(window.location.pathname).toBe("/m/organization-map");
  });
});

describe("the library", () => {
  it("says a refused staff read is a role question, with nothing to retry", async () => {
    const client = { rpc: vi.fn(async () => ({ data: null, error: { message: "not authorized", code: "42501" } })) };
    render(<LanguageProvider lang="en"><KnowledgeWorkspacePanel client={client} organizationId="org-1" canStaff canAdmin={false} collectionChapterId="harbor" /></LanguageProvider>);
    expect(await screen.findByText("Your current role can read the library but cannot manage it. Your saved changes are kept.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps an ordinary failure retryable", async () => {
    const client = { rpc: vi.fn(async () => ({ data: null, error: { message: "network down" } })) };
    render(<LanguageProvider lang="en"><KnowledgeWorkspacePanel client={client} organizationId="org-1" canStaff={false} canAdmin={false} /></LanguageProvider>);
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  it("uses the library's staff reads only under an organization-wide grant", () => {
    const app = readFileSync("src/App.jsx", "utf8");
    expect(app).toContain("const knowledgeStaffAccess = selectedStaffHatAuthorized && (demo || organizationRolesHeld.includes(selectedStaffHat));");
    expect(app).toContain("knowledgeStaffAccess={knowledgeStaffAccess}");
    const hub = readFileSync("src/views/ProductHubView.jsx", "utf8");
    expect(hub).toContain("const knowledgeStaff = knowledgeStaffAccess ?? canStaff;");
    expect(hub).toContain("canStaff={knowledgeStaff}");
  });
});
