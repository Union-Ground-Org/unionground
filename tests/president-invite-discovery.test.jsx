import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { t as translate } from "../src/lib/i18n.js";
import { buildSearchIndex, normalizeText } from "../src/lib/searchIndex.js";
import { buildSiteGuide } from "../src/lib/siteGuide.js";
import { STAFF_ROLE_NAVIGATION } from "../src/lib/staffNavigation.js";

// REQ-UG-INVITE-RIGHTS-AND-ACCESS-REQUESTS-20261030 (#6561, Oct 29-30
// swarm finding 26): a President searched "invite" and found nothing, and the
// invitation card sat at the bottom of the President overview with no page.

const en = (key, vars) => translate("en", key, vars);
const es = (key, vars) => translate("es", key, vars);
const tools = (roles, t = en) => buildSearchIndex({ roles, member: {} }, t).filter((item) => item.type === "tool" && item.id.startsWith("tool:invite-"));
const finds = (entryList, words) => entryList.filter((item) => item.haystack.includes(normalizeText(words)));

describe("finding the invitation tool", () => {
  it("offers a President the President desk's invitation page under 'invite'", () => {
    const [president] = tools(["vp"]);
    expect(president).toMatchObject({
      id: "tool:invite-members-president",
      title: "Invite a worker",
      snippet: "Campaign chair desk · send an invitation to join",
      focus: { staffView: "vp", path: "/m/vp/invitations", sectionId: "vp-invitations" },
    });
    expect(finds([president], "invite")).toHaveLength(1);
    expect(finds([president], "invitar")).toHaveLength(1);
  });

  it("offers an admin the Admin desk's invitation page, and both to someone holding both roles", () => {
    expect(tools(["admin"]).map((item) => item.focus.path)).toEqual(["/m/admin/invitations"]);
    expect(tools(["admin", "vp"]).map((item) => item.focus.path)).toEqual(["/m/admin/invitations", "/m/vp/invitations"]);
  });

  it("offers nothing to a role that cannot invite", () => {
    expect(tools([])).toEqual([]);
    expect(tools(["committee member", "campaign lead", "advisor"])).toEqual([]);
  });

  it("speaks Spanish", () => {
    const [president] = tools(["vp"], es);
    expect(president.title).toBe("Invitar a un trabajador");
    expect(president.snippet).toBe("Escritorio de Presidente · envía una invitación para unirse");
  });
});

describe("the President's invitation page", () => {
  it("is a page of the President desk", () => {
    expect(STAFF_ROLE_NAVIGATION.vp).toContainEqual(expect.objectContaining({
      key: "vp-invitations", sectionId: "vp-invitations", viewKey: "vp", path: "/m/vp/invitations", labelKey: "admin.inviteTitle",
    }));
  });

  it("shows the invitation card on that page as well as the overview, and the address reaches the app", () => {
    const view = readFileSync("src/views/VpView.jsx", "utf8");
    expect(view).toContain('<WorkspaceSection name={["overview", "vp-invitations"]}><PresidentInvitations api={invitationApi} /></WorkspaceSection>');
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
    expect(vercel.rewrites).toContainEqual({ source: "/m/vp/invitations", destination: "/index.html" });
  });
});

// BUG-UG-SITE-GUIDE-PRESIDENT-INVITE-COPY-20261102 (#6790): the
// President's Site guide still sent them to an administrator for the
// invitation tool they hold, and a test President stopped there.
describe("the President's Site guide", () => {
  const migration = readFileSync("supabase/migrations/20261030233000_organization_president_invites.sql", "utf8");

  it("matches the invite right the database grants a President: plain members, on the President desk", () => {
    // The grant the copy describes: chapter or organization-wide vp presides, plain members only.
    expect(migration).toMatch(/private\.member_has_chapter_role\(p_chapter_id, array\['vp'\]\)/);
    expect(migration).toMatch(/private\.has_organization_role\(target\.organization_id, array\['vp'\]\)/);
    expect(migration).toContain("A President invites plain members only.");
    for (const [lang, t] of [["en", en], ["es", es]]) {
      const vp = buildSiteGuide({ t, roles: ["vp"] }).sections.find((section) => section.key === "vp");
      expect(vp.destinations.map((item) => item.path), lang).toContain("/m/vp/invitations");
      expect(vp.body, lang).toContain(t("admin.inviteTitle"));
      expect(vp.body, lang).not.toMatch(/invitations are on the admin desk|ask your organization administrator for the Admin role|las invitaciones están en el panel de administración|pide el rol Admin/i);
    }
    expect(buildSiteGuide({ t: en, roles: ["vp"] }).sections.find((section) => section.key === "vp").body).toMatch(/A Campaign chair invites plain workers only/);
    expect(buildSiteGuide({ t: es, roles: ["vp"] }).sections.find((section) => section.key === "vp").body).toMatch(/invita solo a trabajadores sin acceso de personal/);
  });
});
