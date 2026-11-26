import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { explicitHatAllowsView } from "../src/App.jsx";
import { PAY_WRITE_ROLES, authorizePay, createPayRpcAdapter } from "../src/features/pay/index.js";
import { mergeSelectedMembershipRoles } from "../src/lib/memberApi.js";
import { FEATURE_GROUPS } from "../src/lib/mobileNav.js";
import { STAFF_ROLE_NAVIGATION } from "../src/lib/staffNavigation.js";
import { MEMBER_PATH_VIEWS, SPA_ROUTE_PATHS } from "../src/lib/appRoutes.js";
import {
  PAY_DATABASE_DEPENDENCIES,
  PAY_WEB_DONOR,
  buildPayActor,
  isMissingRpcError,
  loadOrganizationSessionScope,
  mergePaySessionScope,
  payRolesForSelectedHat,
} from "../src/lib/mi1PayWiring.js";

describe("MI1 pay web wiring", () => {
  it("records pay-only donor reuse and rejects seeded CBA material", () => {
    expect(PAY_WEB_DONOR.webWiring).toBe("ad2aef01af257be3d6fbbbe985b24f984cf8f222");
    expect(PAY_WEB_DONOR.rejected).toEqual(expect.arrayContaining([
      "fictional live tenants or seeded CBA rates",
      "QA, analytics, integrations, operations, and public-directory wiring",
    ]));
  });

  it("registers the member pay destination alongside the integrated member destinations", () => {
    expect(MEMBER_PATH_VIEWS["/m/pay"]).toBe("pay");
    expect(SPA_ROUTE_PATHS).toContain("/m/pay");
    expect(MEMBER_PATH_VIEWS["/m/analytics"]).toBeUndefined();
    expect(FEATURE_GROUPS.find((group) => group.key === "union").items.map((item) => item.key)).toContain("pay");
    expect(FEATURE_GROUPS.find((group) => group.key === "union").items.map((item) => item.key)).toContain("qa");
  });

  it("maps missing RPCs and empty session scope without inventing an organization", async () => {
    expect(isMissingRpcError({ code: "PGRST202" })).toBe(true);
    expect(await loadOrganizationSessionScope(null)).toEqual({
      organizationId: null,
      chapterId: null,
      organizationRoles: [],
      chapterRoles: [],
      unavailable: true,
    });
    const client = {
      rpc: async () => ({ error: { code: "PGRST202", message: "Could not find the function" } }),
    };
    expect(await loadOrganizationSessionScope(client)).toMatchObject({
      organizationId: null,
      unavailable: true,
    });
    expect(buildPayActor({ userId: "user-a" }).selectedOrganizationId).toBeNull();
    expect(mergePaySessionScope(buildPayActor({ userId: "user-a" }), { loading: true }))
      .toMatchObject({ selectedOrganizationId: null, organizationScopeState: "loading" });
    expect(mergePaySessionScope(buildPayActor({ userId: "user-a" }), { unavailable: true }))
      .toMatchObject({ selectedOrganizationId: null, organizationScopeState: "retry" });
  });

  it("lists the landed session-scoped pay RPC contract", () => {
    expect(PAY_DATABASE_DEPENDENCIES.rpcs).toEqual([
      "list_pay_scale_grades",
      "list_pay_scale_steps",
      "upsert_pay_scale_grade",
      "upsert_pay_scale_step",
    ]);
    expect(PAY_DATABASE_DEPENDENCIES.writeScopeGuardMigration).toBe(
      "20260826002000_pay_scale_expected_organization_guard.sql",
    );
    expect(PAY_DATABASE_DEPENDENCIES.tables).toEqual(["pay_scale_grades", "pay_scale_steps"]);
  });

  it("derives catalog write grants only from the explicitly selected hat", () => {
    const availableRoles = ["advisor", "admin"];
    expect(payRolesForSelectedHat({ selectedHat: "member", availableRoles })).toEqual([]);
    expect(payRolesForSelectedHat({ selectedHat: "advisor", availableRoles })).toEqual(["advisor"]);
    expect(payRolesForSelectedHat({ selectedHat: "vp", availableRoles })).toEqual([]);
    expect(payRolesForSelectedHat({ selectedHat: "vp", sample: true })).toEqual(["vp"]);
  });

  // UX-UG-WEB-PAY-CATALOG-PUBLISHER-UNREACHABLE-WRITE-HATS-CANNOT-OPEN-M-PAY-20260921:
  // the catalog publisher lives inside /m/pay and needs a write hat, but the
  // shell refused /m/pay to every staff hat, so the hats that could publish
  // never reached the page and the Member hat that reached it carried no write
  // role. The write hats now carry a pay row in their navigation, which is
  // what the shell guard admits. The actor below is built as App builds
  // payActor.
  function shellPayActor(selectedHat, availableRoles, sample) {
    return buildPayActor({
      userId: "user-a",
      organizationId: "org-a",
      roles: payRolesForSelectedHat({ selectedHat, availableRoles, sample }),
      organizationRoles: availableRoles,
      membershipStatus: "active",
      mfaSatisfied: true,
      selectedHat,
    });
  }
  const canWriteCatalog = (actor) =>
    authorizePay({ actor, organizationId: "org-a", capability: "write_catalog" }).ok === true;

  it("lets the advisor, admin and VP hats open /m/pay with the publisher's write grant", () => {
    expect(explicitHatAllowsView("advisor", "pay", true, ["advisor"])).toBe(true);
    expect(canWriteCatalog(shellPayActor("advisor", ["advisor"], true))).toBe(true);
    expect(canWriteCatalog(shellPayActor("member", ["advisor"], true))).toBe(false);
    // The Member hat still opens the calculator, tables and compare tabs, and
    // still has no write grant, so the publisher stays hidden there.
    expect(explicitHatAllowsView("member", "pay", false, ["advisor"])).toBe(true);
    expect(canWriteCatalog(shellPayActor("member", ["advisor", "admin", "vp"], false))).toBe(false);
  });

  it("never routes a staff hat to /m/pay without the write grant, or grants it without the route", () => {
    for (const hat of ["steward", "coordinator", "advisor", "admin", "vp"]) {
      const writeHat = PAY_WRITE_ROLES.includes(hat);
      const listed = STAFF_ROLE_NAVIGATION[hat].some((item) => item.viewKey === "pay");
      expect({ hat, listed }).toEqual({ hat, listed: writeHat });
      for (const [demo, roles] of [[true, [hat]], [false, [hat]]]) {
        const routePay = explicitHatAllowsView(hat, "pay", demo, roles);
        const write = canWriteCatalog(shellPayActor(hat, roles, demo));
        expect({ hat, demo, routePay, write }).toEqual({ hat, demo, routePay: writeHat, write: writeHat });
      }
      // A hat the live account does not hold is not a write hat: the page
      // opens as it does for Member and the publisher stays without a grant.
      expect(canWriteCatalog(shellPayActor(hat, [], false))).toBe(false);
    }
  });

  it("uses tenant-owned membership roles without resurrecting revoked legacy hats", () => {
    expect(mergeSelectedMembershipRoles(["steward"], [
      { organizationId: "org-b", selected: false, roles: ["vp"] },
      { organizationId: "org-a", selected: true, roles: ["advisor", "admin"] },
    ])).toEqual(["advisor", "admin"]);
    expect(mergeSelectedMembershipRoles(["steward"], [
      { organizationId: null, selected: true, roles: ["advisor"] },
    ])).toEqual(["steward", "advisor"]);
    expect(mergeSelectedMembershipRoles(["steward"], [])).toEqual(["steward"]);
  });

  it("hydrates the calculation catalog through RPCs without sending an organization id", async () => {
    const calls = [];
    const client = {
      rpc: vi.fn(async (name, args) => {
        calls.push({ name, args });
        if (name === "list_pay_scale_grades") {
          return { data: [{ organizationId: "org-a", grade: "A", title: "Grade A", stepCount: 1 }], error: null };
        }
        return { data: [{ organizationId: "org-a", grade: "A", effectiveOn: "2026-08-25", stepNumber: 1, hourlyRateCents: 3000 }], error: null };
      }),
    };
    const loaded = await createPayRpcAdapter(client).loadCatalog();
    expect(loaded.ok).toBe(true);
    expect(loaded.catalog.listGrades("org-a")).toHaveLength(1);
    expect(loaded.catalog.listSteps("org-a")).toHaveLength(1);
    expect(calls).toEqual([
      { name: "list_pay_scale_grades", args: undefined },
      {
        name: "list_pay_scale_steps",
        args: { p_grade: null, p_effective_on: null, p_step_number: null, p_effective_year: null },
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain("organizationId");
  });

  it("fails closed on transport errors and malformed catalog rows", async () => {
    const transport = createPayRpcAdapter({ rpc: async () => { throw new Error("offline"); } });
    expect(await transport.loadCatalog()).toEqual({ ok: false, reason: "catalog_unavailable" });

    const malformed = createPayRpcAdapter({ rpc: async (name) => ({
      data: name === "list_pay_scale_grades" ? [{ grade: "A", title: "Missing organization" }] : [],
      error: null,
    }) });
    expect(await malformed.loadCatalog()).toEqual({ ok: false, reason: "catalog_unavailable" });
  });

  it("does not import other domains or migrations from the pay wiring files", () => {
    const wiring = readFileSync("src/lib/mi1PayWiring.js", "utf8");
    const view = readFileSync("src/views/PayToolsView.jsx", "utf8");
    const app = readFileSync("src/App.jsx", "utf8");
    expect(wiring).not.toMatch(/supabase\/migrations|features\/qa|features\/analytics|features\/integrations|features\/operations|publicDirectory/);
    expect(view).toContain("createMemoryPayCatalog()");
    expect(view).not.toMatch(/hourlyRateCents:\s*2500|SEIU|seed/);
    expect(app).toContain("PayToolsView");
    expect(app).toContain('from "./lib/mi1PayWiring.js"');
    expect(app).toContain("roles: payRolesForSelectedHat({ selectedHat: activeHat");
  });
});
