// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DENIED_SAMPLE_REF, deniedSupabaseOrigin } from "./helpers/denied-identity-fixtures.js";
import {
  advisorFindings,
  lintFindings,
  compareFindings,
  rejectBaselineExpansion,
  validateScanTarget,
  configuredApiSchemas,
} from "../scripts/lib/database-assurance-policy.mjs";

const advisor = { name: "rls_disabled_in_public", level: "ERROR", cacheKey: "rls_disabled_in_public_public_fixture", metadata: { schema: "public", name: "fixture" } };
const lint = { function: "public.fixture", issues: [{ level: "error", message: "missing relation", sqlState: "42P01" }] };

describe("database scanner result boundary", () => {
  it("TEST-UG-SUPABASE-ASSURANCE-GATES-20260904 keeps Advisor metadata out of finding identity and artifacts", () => {
    const first = advisorFindings([{
      ...advisor,
      metadata: { schema: "public", description: "member@example.invalid", query: "select protected_body" },
    }]);
    const second = advisorFindings([{
      ...advisor,
      metadata: { schema: "private", description: "different sensitive detail" },
    }]);

    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toMatch(/member@example\.invalid|protected_body|sensitive detail/);
  });

  it.each([null, {}, { results: null }, { results: [null] }, { results: [{ name: "x" }] }])("rejects unreadable Advisor output %j", (value) => {
    expect(() => advisorFindings(value)).toThrow(/invalid/i);
  });
  it.each([{}, { results: [{}] }, { results: [{ function: "x", issues: null }] }, { results: [{ ...lint, issues: [{ ...lint.issues[0], level: "unknown" }] }] }])("rejects incomplete lint output %j", (value) => {
    expect(() => lintFindings(value)).toThrow(/invalid/i);
  });
  it("accepts explicit empty result arrays, never a missing envelope", () => {
    expect(advisorFindings({ results: [] })).toEqual([]);
    expect(lintFindings([])).toEqual([]);
  });
  it("keeps warning/error Advisor identities but excludes workload-dependent INFO results", () => {
    const results = advisorFindings([advisor, { ...advisor, level: "INFO", cacheKey: "unused_index_fixture" }]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: "advisor", level: "ERROR", rule: advisor.name, count: 1 });
  });
  it("retains lint warning and warning-extra findings without exporting SQL, hints or messages", () => {
    const results = lintFindings([{ ...lint, issues: [lint.issues[0], { ...lint.issues[0], level: "warning extra", query: { text: "sensitive fixture SQL" } }] }]);
    expect(results).toHaveLength(2);
    expect(JSON.stringify(results)).not.toContain("sensitive fixture");
    expect(JSON.stringify(results)).not.toContain("missing relation");
  });
});

describe("disposable scanner target", () => {
  it("requires exactly one valid API schema list from config", () => {
    expect(configuredApiSchemas('[api]\nschemas = ["public", "graphql_public"]\n[db]\nschemas = ["ignored"]')).toEqual(["public", "graphql_public"]);
    for (const config of ['[api]\n', '[api]\nschemas=[]', '[api]\nschemas=["public; drop schema public"]', '[api]\nschemas=["public"]\nschemas=["private"]']) {
      expect(() => configuredApiSchemas(config)).toThrow();
    }
  });
  const databaseUrl = "postgresql://postgres:postgres@127.0.0.1:55672/postgres";
  const status = { DB_URL: databaseUrl, API_URL: "http://127.0.0.1:55671", ANON_KEY: "fixture-anon", SERVICE_ROLE_KEY: "fixture-service" };
  it("binds the API and database ports to one owned local stack", () => {
    expect(() => validateScanTarget(databaseUrl, status)).not.toThrow();
    for (const patch of [
      { DB_URL: "postgresql://postgres@outside.example:55672/postgres" },
      { API_URL: deniedSupabaseOrigin(DENIED_SAMPLE_REF) },
      { API_URL: "http://127.0.0.1:55681" },
      { SERVICE_ROLE_KEY: "" },
    ]) expect(() => validateScanTarget(databaseUrl, { ...status, ...patch })).toThrow(/disposable/i);
    expect(() => validateScanTarget(`${databaseUrl}?host=outside.example`, status)).toThrow(/disposable/i);
  });
});

describe("two-sided database finding ratchet", () => {
  const known = () => [...advisorFindings([advisor]), ...lintFindings([lint])];
  it("accepts exactly the known findings", () => {
    expect(compareFindings(known(), known())).toEqual({ added: [], removed: [] });
  });
  it("rejects a new RLS or function error and a silently deleted active baseline entry", () => {
    const baseline = known();
    expect(compareFindings(baseline, baseline.slice(1)).added).toHaveLength(1);
    expect(compareFindings(baseline.slice(1), baseline).removed).toHaveLength(1);
  });
  it("detects duplicate occurrences instead of losing an overload regression in a Set", () => {
    const once = lintFindings([lint]);
    const twice = lintFindings([lint, lint]);
    expect(twice[0].count).toBe(2);
    expect(compareFindings(twice, once).added).toHaveLength(1);
  });
  it("permits tightening after a fix but rejects baseline additions and count increases", () => {
    expect(() => rejectBaselineExpansion(known().slice(1), known())).not.toThrow();
    expect(() => rejectBaselineExpansion(known(), known().slice(1))).toThrow(/expand/i);
    expect(() => rejectBaselineExpansion(lintFindings([lint, lint]), lintFindings([lint]))).toThrow(/expand/i);
  });
});
