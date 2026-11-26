// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { forbiddenSupabaseRefsIn } from "../scripts/lib/sibling-deny-list.mjs";
import {
  PAY_DONOR_BASELINE,
  PAY_DONOR_UNITS,
  PAY_PERSISTENCE_CONTRACT,
  PAY_VIEW_STATES,
  presentLoading,
  presentRetry,
} from "../src/features/pay/index.js";
import { UNSET_CALCULATION_RULES } from "../src/features/pay/rules.js";

const payRoot = new URL("../src/features/pay/", import.meta.url);
const implementationFiles = readdirSync(payRoot)
  .filter((name) => name.endsWith(".js") && name !== "provenance.js")
  .map((name) => ({ name, source: readFileSync(new URL(name, payRoot), "utf8") }));

describe("pay-tool donor and launch boundaries", () => {
  it("records donor provenance and rejected legacy assumptions", () => {
    expect(PAY_DONOR_BASELINE).toBe("donor-baseline-20260721");
    expect(PAY_DONOR_UNITS.map((unit) => unit.auditId).sort()).toEqual([
      "CR-045",
      "CR-045",
      "CR-045",
      "CR-045",
      "CR-046",
      "CR-046",
      "CR-046",
    ]);
    expect(PAY_DONOR_UNITS.some((unit) => unit.donorPath === "lib/util/wage-calculator.ts")).toBe(true);
    expect(PAY_DONOR_UNITS.some((unit) => unit.donorPath === "supabase/migrations/0311_seed_pay_scales.sql" && unit.disposition === "discard")).toBe(true);
    expect(PAY_DONOR_UNITS.some((unit) => unit.rejected.includes("placeholder G1/G2/G3 base rates"))).toBe(true);
    expect(PAY_DONOR_UNITS.some((unit) => unit.rejected.includes("anon+authenticated using(true) read-all"))).toBe(true);
  });

  it("does not ship donor seeds, project refs, Next.js boundaries, or clocked effective dates", () => {
    const joined = implementationFiles.map((file) => file.source).join("\n");
    expect(joined).not.toContain("32.6700");
    expect(forbiddenSupabaseRefsIn(joined)).toEqual([]);
    expect(joined).not.toMatch(/BASE_RATES/);
    expect(joined).not.toMatch(/from ["']next\//);
    expect(joined).not.toMatch(/Date\.now\s*\(/);
    expect(joined).not.toMatch(/new Date\s*\(/);
    expect(joined).not.toMatch(/createClient\([^)]*service/i);
    expect(Object.values(UNSET_CALCULATION_RULES).every((value) => value === null)).toBe(true);
    expect(joined).not.toMatch(/2087|checksPerYear:\s*26|nightMultiplier:\s*1\.1|weekendMultiplier:\s*1\.15|standbyHourlyCents:\s*350/);
    expect(PAY_PERSISTENCE_CONTRACT.sessionOrganizationOnly).toBe(true);
    expect(PAY_PERSISTENCE_CONTRACT.migration).toBe("20260822020000_mi1_w1_feature_persistence.sql");
    expect(PAY_PERSISTENCE_CONTRACT.writeScopeGuardMigration).toBe("20260826002000_pay_scale_expected_organization_guard.sql");
    expect(PAY_PERSISTENCE_CONTRACT.expectedOrganizationRequiredForWrites).toBe(true);
    expect(PAY_PERSISTENCE_CONTRACT.rpcs).toEqual(expect.arrayContaining([
      "list_pay_scale_grades",
      "list_pay_scale_steps",
    ]));
  });

  it("covers empty, loading, success, validation, unauthorized, wrong-organization, and retry states", () => {
    expect(PAY_VIEW_STATES).toEqual([
      "empty",
      "loading",
      "success",
      "validation",
      "unauthorized",
      "wrong_organization",
      "retry",
    ]);
    expect(presentLoading("Wage and back-pay calculator").state).toBe("loading");
    expect(presentRetry("Pay-scale tables").state).toBe("retry");
  });

  it("stays inside the W1-PAY write allowlist", () => {
    const names = implementationFiles.map((file) => file.name).sort();
    expect(names.length).toBeGreaterThan(5);
    // Hold the real tree to the pay domain boundary. The engine owns
    // src/features/pay/** and may reach outside that directory only through
    // the shared tenancy scope module, so a new cross-feature import fails
    // here instead of passing a path-join identity.
    const outsideImports = implementationFiles
      .flatMap((file) => [...file.source.matchAll(/from\s+["'](\.\.\/[^"']+)["']/g)]
        .map((match) => `${file.name} -> ${match[1]}`))
      .sort();
    expect(outsideImports).toEqual(["authorization.js -> ../tenancy/organizationScope.js"]);
  });
});
