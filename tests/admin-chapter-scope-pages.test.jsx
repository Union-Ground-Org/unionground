import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminView } from "../src/views/AdminView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { adminDeskScope } from "../src/lib/organizationWorkspaceAccess.js";
import { buildMi1FeatureActor } from "../src/lib/mi1FeatureWiring.js";
import { OperationsHealthView } from "../src/views/OperationsHealthView.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

// BUG-UG-CHAPTER-ADMIN-SEES-ORG-ADMIN-PAGES-THAT-FAIL-20261102: two
// btesters Admins held Admin only as a chapter role. Feature switches, labels,
// the staff two-step requirement, catalog verification and member operations
// read through private.has_organization_role(org, array['admin']), so each
// page said "could not be read", "could not be loaded" or "could not be
// verified". Each now says it needs an organization-wide Admin role and who
// can extend one; an organization-wide Admin keeps every page.
// BUG-UG-CHAPTER-ADMIN-AUDIT-LEDGER-SAYS-UNAVAILABLE-20261102: the
// organization audit ledger, job health and chapter leadership claims share
// that check; they said "unavailable in this environment" or "could not be
// loaded" until they took the same refusal.

const ORGANIZATION_ID = "a1b2c3d4-0000-4000-8000-000000000001";
const PAGES = ["admin-configuration", "admin-labels", "admin-mfa", "admin-catalog-verification", "admin-member-operations", "admin-leadership-claims", "admin-organization-audit", "admin-job-health"];
const FAILURES = [
  "Organization settings could not be read. No defaults are presented as saved values.",
  "The staff two-step requirement could not be loaded.",
  "Verification couldn't be loaded. Reload the page to try again.",
  "Member operations access could not be verified for this organization. Try again or contact an organization administrator.",
  "Chapter leadership claims could not be loaded.",
  "The organization audit ledger is unavailable in this environment.",
  "Background job health is unavailable in this environment.",
];
const WHO = "An organization administrator can make it organization-wide in the Admin desk under Organization roles & access.";

function deskFor(scope) {
  const desk = JSON.parse(JSON.stringify(fallbackData.adminDesk));
  if (scope === "chapter") {
    // What loadAdminDesk returns for a chapter-only Admin: the org structure
    // read reports chapter scope; the two organization-admin reads refused.
    desk.organization = { ...desk.organization, scope: "chapter", chapterId: desk.organization.chapters[0].id, canCreateChapter: false };
    desk.configuration = null;
    desk.mfaPolicy = null;
  }
  return desk;
}

function memberOperationsClient() {
  return { rpc: vi.fn(() => new Promise(() => {})) };
}

function renderDesk({ scope, lang = "en", desk = deskFor(scope), member } = {}) {
  const organizationRoles = scope === "organization" ? ["admin"] : [];
  const api = {
    loadDesk: vi.fn().mockResolvedValue(desk),
    getOrganizationCatalogVerification: vi.fn(() => new Promise(() => {})),
    listLeadershipClaims: vi.fn(() => new Promise(() => {})),
  };
  // No client: the operations readers answer "unset", the not-deployed case.
  const operationsSession = buildMi1FeatureActor({ userId: "staff-ar", organizationId: ORGANIZATION_ID, roles: ["admin"], mfaSatisfied: true, selectedHat: "admin" });
  const client = memberOperationsClient();
  render(
    <LanguageProvider lang={lang}>
      <AdminView
        api={api}
        onNotice={vi.fn()}
        data={{ member: member ?? { id: "staff-ar", initials: "AR", chapterName: "Cedar Ridge Care Services", organizationId: ORGANIZATION_ID, organizationRoles, chapterRoles: ["admin"] } }}
        memberOperationsActor={{ userId: "staff-ar", selectedOrganizationId: ORGANIZATION_ID, selectedHat: "admin", membershipStatus: "active", organizationRoles, mfaSatisfied: true }}
        memberOperationsClient={client}
        operationsHealth={<OperationsHealthView session={operationsSession} client={null} embedded />}
      />
    </LanguageProvider>,
  );
  return { api, client };
}

const page = (id) => within(document.getElementById(id));

afterEach(() => vi.restoreAllMocks());

describe("which scope the Admin desk holds", () => {
  it("takes the server's organization-structure scope first", () => {
    expect(adminDeskScope({ serverScope: "chapter", organizationRoles: ["admin"] })).toBe("chapter");
    expect(adminDeskScope({ serverScope: "organization", organizationRoles: [], chapterRoles: ["admin"] })).toBe("organization");
  });

  it("falls back to the selected membership's grants, and to unknown", () => {
    expect(adminDeskScope({ organizationRoles: ["admin"], chapterRoles: ["admin"] })).toBe("organization");
    expect(adminDeskScope({ organizationRoles: ["vp"], chapterRoles: ["admin"] })).toBe("chapter");
    expect(adminDeskScope({ organizationRoles: [], chapterRoles: [] })).toBeNull();
    expect(adminDeskScope()).toBeNull();
    expect(adminDeskScope({ serverScope: "other", organizationRoles: undefined, chapterRoles: null })).toBeNull();
  });
});

describe("a chapter-only Admin", () => {

  it("keeps the staff two-step status the chapter read can show, without the requirement's controls", async () => {
    renderDesk({ scope: "chapter" });
    await screen.findAllByText("Alex Rivera");
    const mfa = page("admin-mfa");
    expect(mfa.getByText(/staff members have two-step sign-in on/)).toBeInTheDocument();
    expect(mfa.queryByRole("button", { name: /Require for all members|Require two-step/ })).not.toBeInTheDocument();
  });

});

describe("an organization-wide Admin", () => {

  it("keeps \"unavailable in this environment\" for operations readers that are not deployed", async () => {
    renderDesk({ scope: "organization" });
    expect(await screen.findByText(FAILURES[5])).toBeInTheDocument();
    expect(screen.getByText(FAILURES[6])).toBeInTheDocument();
    expect(document.querySelector("[data-organization-role-refusal]")).toBeNull();
  });

  it("keeps the pages' own failure states when an organization-wide read fails", async () => {
    const desk = deskFor("organization");
    desk.configuration = null;
    desk.mfaPolicy = null;
    renderDesk({ scope: "organization", desk });
    await screen.findAllByText("Alex Rivera");
    expect(document.querySelector("[data-organization-role-refusal]")).toBeNull();
    expect(page("admin-configuration").getByText(FAILURES[0])).toBeInTheDocument();
    expect(page("admin-labels").getByText(FAILURES[0])).toBeInTheDocument();
    expect(page("admin-mfa").getByText(FAILURES[1])).toBeInTheDocument();
  });

  it("is trusted from the server's scope even before the membership grants arrive", async () => {
    renderDesk({ scope: "organization", member: { id: "staff-ar", organizationId: ORGANIZATION_ID, organizationRoles: [], chapterRoles: ["admin"] } });
    await screen.findAllByText("Alex Rivera");
    expect(document.querySelector("[data-organization-role-refusal]")).toBeNull();
  });
});
