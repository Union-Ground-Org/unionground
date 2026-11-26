// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertLoopbackApplicationRequests,
  assertWebPerformanceSource,
  budgetSummaryMarkdown,
  effectiveBundleCeilings,
  evaluateWebPerformanceBudget,
  firstPaintAssetPaths,
  firstPaintBytes,
  isolatedWebPerformanceEnv,
  median,
  missingBudgetCeilings,
  ratchetedCeiling,
  relativeRange,
  summarizeSamples,
  wholeMonthsSince,
} from "../scripts/lib/web-performance-budget.mjs";
import { runtimeConfigForRequest } from "../api/_lib/runtimeConfig.js";
import { DENIED_SAMPLE_REF, deniedSupabaseOrigin } from "./helpers/denied-identity-fixtures.js";

const config = {
  runsPerMode: 3,
  modes: ["cold"],
  scenarios: [{ id: "sample-member-mobile", surface: "demo", profile: "mobile" }],
  variance: { maxRelativeRange: 0.5 },
  profiles: {
    mobile: { budgets: { lcpMs: 3000, cls: 0.1, inpMs: 200, tbtMs: 500 } },
  },
  bundle: { allJavaScriptAndCssRawBytes: 1000, allJavaScriptAndCssGzipBytes: 500 },
  firstPaint: { scenarios: { "sample-member-mobile": { rawBytes: 3000, gzipBytes: 800 } } },
};

function passingInput() {
  return {
    config,
    bundles: [{ surface: "demo", rawBytes: 900, gzipBytes: 450 }],
    groups: [{
      id: "sample-member-mobile",
      mode: "cold",
      profile: "mobile",
      metrics: summarizeSamples([
        { lcpMs: 2500, cls: 0.05, inpMs: 150, tbtMs: 400, firstPaintRawBytes: 2800, firstPaintGzipBytes: 700 },
        { lcpMs: 2600, cls: 0.04, inpMs: 160, tbtMs: 390, firstPaintRawBytes: 2800, firstPaintGzipBytes: 700 },
        { lcpMs: 2400, cls: 0.06, inpMs: 140, tbtMs: 410, firstPaintRawBytes: 2800, firstPaintGzipBytes: 700 },
      ]),
    }],
  };
}

describe("web performance budget gate", () => {
  it("records FCP from the same cold loads as app-ready, using all three samples", () => {
    expect(summarizeSamples([{ fcpMs: 800 }, { fcpMs: 700 }, { fcpMs: 900 }]).fcpMs).toEqual({
      median: 800, min: 700, max: 900, relativeRange: 0.25, samples: 3, attemptedSamples: 3,
    });
    const runner = readFileSync("scripts/run-web-performance-budgets.mjs", "utf8");
    expect(runner).toContain('performance.getEntriesByName("first-contentful-paint")');
    expect(runner).toContain('appReadyMs, fcpMs, firstPaintAssets');
  });
  it("PERF-UG-LIGHTHOUSE-BUDGETS-20260904 requires one bundle measurement per configured surface", () => {
    const missing = passingInput();
    missing.bundles = [];
    expect(evaluateWebPerformanceBudget(missing).failures).toContain("demo bundle was not measured");

    const duplicate = passingInput();
    duplicate.bundles.push(structuredClone(duplicate.bundles[0]));
    expect(evaluateWebPerformanceBudget(duplicate).failures).toContain(
      "demo bundle was measured more than once",
    );
  });

  it("uses a median and records bounded variance", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(relativeRange([90, 100, 110])).toBe(0.2);
    expect(evaluateWebPerformanceBudget(passingInput())).toMatchObject({ failures: [], passed: true, warnings: [] });
  });

  it.each([
    ["LCP", "lcpMs", 3001],
    ["CLS", "cls", 0.101],
    ["INP", "inpMs", 201],
    ["TBT", "tbtMs", 501],
  ])("fails a deliberate %s regression", (label, metric, regressed) => {
    const input = passingInput();
    for (const sample of [input.groups[0].metrics[metric]]) {
      sample.median = regressed;
    }
    const result = evaluateWebPerformanceBudget(input);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain(label);
  });

  it.each([
    ["raw", "rawBytes", 1001],
    ["gzip", "gzipBytes", 501],
  ])("fails a deliberate %s bundle regression", (_label, metric, regressed) => {
    const input = passingInput();
    input.bundles[0][metric] = regressed;
    const result = evaluateWebPerformanceBudget(input);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("JS+CSS");
  });

  it.each([
    ["lcpMs", "sample-member-mobile/cold LCP has no configured budget ceiling"],
    ["cls", "sample-member-mobile/cold CLS has no configured budget ceiling"],
    ["inpMs", "sample-member-mobile/cold INP has no configured budget ceiling"],
    ["tbtMs", "sample-member-mobile/cold TBT has no configured budget ceiling"],
  ])("PERF-UG-WEB-BUDGET-CEILING-MISSING-PASSES-GATE-20260920 fails when the %s ceiling is missing", (metric, failure) => {
    const input = passingInput();
    const budgets = { ...config.profiles.mobile.budgets };
    delete budgets[metric];
    input.config = { ...config, profiles: { mobile: { budgets } } };
    const result = evaluateWebPerformanceBudget(input);
    expect(result.passed).toBe(false);
    expect(result.failures).toContain(failure);
  });

  it.each([
    ["allJavaScriptAndCssRawBytes", "demo raw JS+CSS has no configured budget ceiling"],
    ["allJavaScriptAndCssGzipBytes", "demo gzip JS+CSS has no configured budget ceiling"],
  ])("fails when the %s bundle ceiling is missing", (ceiling, failure) => {
    const input = passingInput();
    const bundle = { ...config.bundle };
    delete bundle[ceiling];
    input.config = { ...config, bundle };
    const result = evaluateWebPerformanceBudget(input);
    expect(result.passed).toBe(false);
    expect(result.failures).toContain(failure);
  });

  it("fails rather than throwing when a profile or the bundle section has no budgets at all", () => {
    const input = passingInput();
    input.config = { ...config, profiles: { mobile: {} }, bundle: undefined };
    const result = evaluateWebPerformanceBudget(input);
    expect(result.passed).toBe(false);
    for (const failure of [
      "sample-member-mobile/cold LCP has no configured budget ceiling",
      "sample-member-mobile/cold CLS has no configured budget ceiling",
      "sample-member-mobile/cold INP has no configured budget ceiling",
      "sample-member-mobile/cold TBT has no configured budget ceiling",
      "demo raw JS+CSS has no configured budget ceiling",
      "demo gzip JS+CSS has no configured budget ceiling",
    ]) expect(result.failures).toContain(failure);
  });

  it("fails a non-numeric ceiling instead of comparing against it", () => {
    const input = passingInput();
    input.config = { ...config, profiles: { mobile: { budgets: { ...config.profiles.mobile.budgets, lcpMs: "3000" } } } };
    expect(evaluateWebPerformanceBudget(input).failures).toContain(
      "sample-member-mobile/cold LCP has no configured budget ceiling",
    );
  });

  it("fails a negative ceiling instead of treating it as satisfied", () => {
    const input = passingInput();
    input.config = { ...config, profiles: { mobile: { budgets: { ...config.profiles.mobile.budgets, tbtMs: -1 } } } };
    expect(evaluateWebPerformanceBudget(input).failures).toContain(
      "sample-member-mobile/cold TBT has no configured budget ceiling",
    );
  });

  it("names every missing or invalid ceiling key across all declared profiles and the bundle", () => {
    expect(missingBudgetCeilings({
      profiles: {
        mobile: { budgets: { lcpMs: 9000, cls: 0.1, inpMs: 200, tbtMs: 750 } },
        desktop: { budgets: { lcpMs: 2500, cls: Number.NaN, inpMs: -5 } },
      },
      bundle: { allJavaScriptAndCssRawBytes: 1000 },
    })).toEqual([
      "profiles.desktop.budgets.cls",
      "profiles.desktop.budgets.inpMs",
      "profiles.desktop.budgets.tbtMs",
      "bundle.allJavaScriptAndCssGzipBytes",
    ]);
  });

  describe("monthly ratchet", () => {
    const ratchet = { startsOn: "2026-10-11", monthlyReduction: 0.05,
      bundle: { allJavaScriptAndCssRawBytes: 2000, allJavaScriptAndCssGzipBytes: 800 },
      scenarios: { "sample-member-mobile": { cold: { tbtMs: 1000 } } } };
    const ratcheted = { ...config, ratchet };
    const input = (overrides) => ({ ...passingInput(), config: ratcheted, ...overrides });
    const slow = (tbtMs) => summarizeSamples([0, 0, 0].map(() => ({ lcpMs: 2500, cls: 0.05, inpMs: 150, tbtMs })));

    it("counts whole calendar months", () => {
      expect(wholeMonthsSince("2026-10-11", "2026-10-11")).toBe(0);
      expect(wholeMonthsSince("2026-10-11", "2026-11-10")).toBe(0);
      expect(wholeMonthsSince("2026-10-11", "2026-11-11")).toBe(1);
      expect(wholeMonthsSince("2026-10-11", "2027-10-11")).toBe(12);
      expect(wholeMonthsSince("2026-10-11", "2026-09-01")).toBe(0);
      expect(() => wholeMonthsSince("2026-10-11", "soon")).toThrow();
    });

    it("starts at the measured size, drops 5% a month, and stops at the target", () => {
      expect(ratchetedCeiling(1000, 2000, ratchet, "2026-10-11")).toBe(2000);
      expect(ratchetedCeiling(1000, 2000, ratchet, "2026-11-11")).toBe(1900);
      expect(ratchetedCeiling(1000, 2000, ratchet, "2026-12-11")).toBe(1805);
      expect(ratchetedCeiling(1000, 2000, ratchet, "2028-10-11")).toBe(1000);
      expect(ratchetedCeiling(500, undefined, ratchet, "2026-10-11")).toBe(500);
      expect(effectiveBundleCeilings(ratcheted, "2026-11-11")).toEqual({ allJavaScriptAndCssRawBytes: 1900, allJavaScriptAndCssGzipBytes: 760 });
    });

    it("keeps a fractional scenario start (CLS) instead of flooring it to the target", () => {
      expect(ratchetedCeiling(0.1, 0.2, ratchet, "2026-10-11")).toBe(0.2);
      expect(ratchetedCeiling(0.1, 0.2, ratchet, "2026-11-11")).toBe(0.19);
      expect(ratchetedCeiling(0.1, 0.2, ratchet, "2026-12-11")).toBe(0.1805);
      expect(ratchetedCeiling(1000, 2000.9, ratchet, "2026-10-11", { wholeUnits: true })).toBe(2000);
      // A baseline finer than six places is kept, not truncated.
      expect(ratchetedCeiling(0.1, 0.1234567, ratchet, "2026-10-11")).toBe(0.1234567);
    });

    it("passes today's size on day one and fails it a month later", () => {
      const bundles = [{ surface: "demo", rawBytes: 2000, gzipBytes: 800 }];
      expect(evaluateWebPerformanceBudget({ ...input({ bundles }), today: "2026-10-11" }).passed).toBe(true);
      const later = evaluateWebPerformanceBudget({ ...input({ bundles }), today: "2026-11-11" });
      expect(later.failures).toEqual(["demo raw JS+CSS 2000 exceeded 1900", "demo gzip JS+CSS 800 exceeded 760"]);
    });

    it("applies a scenario start value to that scenario only", () => {
      const member = { ...passingInput().groups[0], metrics: slow(990) };
      const other = { ...member, id: "saas-public-mobile" };
      const result = evaluateWebPerformanceBudget({ ...input({ groups: [member, other] }), config: { ...ratcheted, scenarios: [] }, today: "2026-10-11" });
      expect(result.failures).toEqual(["saas-public-mobile/cold TBT 990 exceeded 500"]);
      const warm = { ...member, mode: "warm" };
      const byMode = evaluateWebPerformanceBudget({ ...input({ groups: [member, warm] }), config: { ...ratcheted, scenarios: [] }, today: "2026-10-11" });
      expect(byMode.failures).toEqual(["sample-member-mobile/warm TBT 990 exceeded 500"]);
    });

    it("records the ceilings the run was judged against", () => {
      const result = evaluateWebPerformanceBudget({ ...input({}), today: "2026-11-11" });
      expect(result.ceilings.evaluatedOn).toBe("2026-11-11");
      expect(result.ceilings.bundle).toEqual({ allJavaScriptAndCssRawBytes: 1900, allJavaScriptAndCssGzipBytes: 760 });
      expect(result.ceilings.groups["sample-member-mobile/cold"]).toEqual({ lcpMs: 3000, cls: 0.1, inpMs: 200, tbtMs: 950 });
    });

    it("still fails a deleted target even with a ratchet start value", () => {
      const result = evaluateWebPerformanceBudget({ ...input({}), config: { ...ratcheted, bundle: { allJavaScriptAndCssGzipBytes: 500 } }, today: "2026-10-11" });
      expect(result.failures).toContain("demo raw JS+CSS has no configured budget ceiling");
    });

    it("refuses an out-of-range reduction instead of silently loosening", () => {
      expect(() => ratchetedCeiling(1000, 2000, { ...ratchet, monthlyReduction: 0 }, "2026-11-11")).toThrow();
      expect(() => ratchetedCeiling(1000, 2000, { ...ratchet, monthlyReduction: 1.5 }, "2026-11-11")).toThrow();
    });

    it("ships the ratchet: started October 11, 5% a month, targets unchanged", () => {
      const shipped = JSON.parse(readFileSync(new URL("../config/web-performance-budgets.json", import.meta.url), "utf8"));
      expect(shipped.ratchet).toMatchObject({ startsOn: "2026-10-11", monthlyReduction: 0.05,
        scenarios: { "sample-member-mobile": { warm: { tbtMs: 1279 } } } });
      // The bundle start values are re-based on purpose (see the headroom
      // tests), so only their shape is pinned here.
      expect(Object.keys(shipped.ratchet.bundle).toSorted()).toEqual(["allJavaScriptAndCssGzipBytes", "allJavaScriptAndCssRawBytes"]);
      for (const value of Object.values(shipped.ratchet.bundle)) expect(Number.isInteger(value) && value > 0).toBe(true);
      expect(shipped.bundle).toEqual({ allJavaScriptAndCssRawBytes: 4400000, allJavaScriptAndCssGzipBytes: 1150000 });
      expect(shipped.profiles.mobile.budgets.tbtMs).toBe(750);
    });
  });

  it("keeps every ceiling the shipped budget configuration is expected to enforce", () => {
    const shipped = JSON.parse(readFileSync(new URL("../config/web-performance-budgets.json", import.meta.url), "utf8"));
    const profileNames = Object.keys(shipped.profiles);
    expect(profileNames.length).toBeGreaterThan(0);
    expect(missingBudgetCeilings(shipped)).toEqual([]);
    // Every scenario profile must be one the gate can enforce.
    for (const scenario of shipped.scenarios) expect(profileNames).toContain(scenario.profile);
  });

  it("carries no root Lighthouse CI config unless @lhci/cli is a declared dependency", () => {
    const root = new URL("../", import.meta.url);
    const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    const declared = Boolean(pkg.dependencies?.["@lhci/cli"] || pkg.devDependencies?.["@lhci/cli"]);
    const configs = readdirSync(root).filter((name) => /^\.?lighthouserc(\.|$)/.test(name));
    expect(declared ? [] : configs).toEqual([]);
  });

  it("fails when any enforced metric has fewer finite samples than configured", () => {
    const input = passingInput();
    input.groups[0].metrics = summarizeSamples([
      { lcpMs: 2500, cls: 0.05, inpMs: 150, tbtMs: 400 },
      { lcpMs: null, cls: 0.04, inpMs: 160, tbtMs: 390 },
      { lcpMs: undefined, cls: 0.06, inpMs: 140, tbtMs: 410 },
    ]);
    const result = evaluateWebPerformanceBudget(input);
    expect(result.passed).toBe(false);
    expect(result.failures).toContain("sample-member-mobile/cold lcpMs requires 3 finite measurements (received 1 finite from 3 attempts)");
  });

  it("requires every configured scenario and mode exactly once", () => {
    const input = passingInput();
    input.config = { ...config, modes: ["cold", "warm"] };
    expect(evaluateWebPerformanceBudget(input).failures).toContain("sample-member-mobile/warm was not measured");
    input.groups.push(structuredClone(input.groups[0]));
    expect(evaluateWebPerformanceBudget(input).failures).toContain("sample-member-mobile/cold was measured more than once");
  });

  it("opts the SaaS measurement in to the loopback development backend, and only on loopback", () => {
    const env = isolatedWebPerformanceEnv({ NODE_ENV: "production" }, "saas");
    expect(runtimeConfigForRequest({ headers: { host: "127.0.0.1" } }, env))
      .toMatchObject({ schema: 1, surface: "saas", configured: true, supabaseUrl: "http://127.0.0.1:65535" });
    expect(runtimeConfigForRequest({ headers: { host: "127.0.0.1" } }, { ...env, VERCEL: "1" }))
      .toEqual({ schema: 1, surface: "saas", configured: false });
  });

  it("neutralizes inherited and dotenv-precedence SAMPLE inputs before asserting fixture mode", () => {
    const inherited = {
      SAMPLE_SUPABASE_URL: deniedSupabaseOrigin(DENIED_SAMPLE_REF),
      SAMPLE_SUPABASE_PUBLISHABLE_KEY: "inherited-public",
      SAMPLE_SUPABASE_SERVICE_ROLE_KEY: "inherited-secret",
      VITE_SAMPLE_SUPABASE_URL: deniedSupabaseOrigin(DENIED_SAMPLE_REF),
      VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY: "dotenv-public",
    };
    const env = isolatedWebPerformanceEnv(inherited, "demo");
    for (const name of Object.keys(inherited)) expect(env[name]).toBe("");
    expect(runtimeConfigForRequest({ headers: { host: "127.0.0.1" } }, env))
      .toEqual({ schema: 1, surface: "demo", configured: false });
  });

  it("allows only loopback application traffic during measurement", () => {
    expect(() => assertLoopbackApplicationRequests([
      "http://127.0.0.1:4173/m",
      "http://localhost:65535/rest/v1/member_profiles",
      "data:image/svg+xml,ok",
    ])).not.toThrow();
    expect(() => assertLoopbackApplicationRequests([`${deniedSupabaseOrigin(DENIED_SAMPLE_REF)}/rest/v1/member_profiles`]))
      .toThrow(/refused non-loopback application request/);
  });
});

it("binds measurements to a clean, unchanged exact source SHA", () => {
  const sha = "a".repeat(40);
  expect(assertWebPerformanceSource({ actualSha: sha, status: "" })).toBe(sha);
  expect(() => assertWebPerformanceSource({ actualSha: "HEAD", status: "" })).toThrow(/exact Git source SHA/);
  expect(() => assertWebPerformanceSource({ actualSha: "0".repeat(40), status: "" })).toThrow(/exact Git source SHA/);
  expect(() => assertWebPerformanceSource({ actualSha: sha, status: " M src/App.jsx" })).toThrow(/clean worktree/);
  expect(() => assertWebPerformanceSource({ actualSha: sha, status: "?? src/new.js" })).toThrow(/clean worktree/);
  expect(() => assertWebPerformanceSource({ expectedSha: "b".repeat(40), actualSha: sha, status: "" })).toThrow(/changed during measurement/);
});

describe("BUG-UG-WEB-PERFORMANCE-BUDGET-DORMANT-BUNDLE-OVER-CEILING-20261109", () => {
  const shipped = JSON.parse(readFileSync(new URL("../config/web-performance-budgets.json", import.meta.url), "utf8"));
  const runner = readFileSync(new URL("../scripts/run-web-performance-budgets.mjs", import.meta.url), "utf8");

  it("names the control the INP probe clicks in every scenario, one control for both SAMPLE scenarios", () => {
    for (const scenario of shipped.scenarios) expect(scenario.inpTarget, scenario.id).toMatch(/\S/);
    const demo = shipped.scenarios.filter((scenario) => scenario.surface === "demo").map((scenario) => scenario.inpTarget);
    expect(new Set(demo)).toEqual(new Set([".mobile-top__bell, .desktop-rail__bell"]));
    const unnamed = structuredClone(shipped);
    delete unnamed.scenarios[0].inpTarget;
    expect(missingBudgetCeilings(unnamed)).toEqual(["scenarios[0].inpTarget"]);
    expect(runner).not.toContain("no safe enabled button");
    expect(runner).toContain("scenario.inpTarget");
  });

  it("measures the SAMPLE surface on the fixture build and waits for the app's ready mark", () => {
    expect(runner).toContain('surface === "demo" ? "build:assurance" : "build"');
    expect(runner).toContain("APP_READY_MARK");
    const metrics = summarizeSamples([{ appReadyMs: 900 }, { appReadyMs: 1400 }, { appReadyMs: 1000 }]);
    expect(metrics.appReadyMs.median).toBe(1000);
  });

  it("records app ready without enforcing it", () => {
    const input = passingInput();
    input.groups[0].metrics.appReadyMs = summarizeSamples([{ appReadyMs: 99999 }, { appReadyMs: 99999 }, { appReadyMs: 99999 }]).appReadyMs;
    expect(evaluateWebPerformanceBudget(input).passed).toBe(true);
  });

  it("writes a short job summary naming every failure", () => {
    const input = passingInput();
    input.bundles[0].rawBytes = 1200;
    const gate = evaluateWebPerformanceBudget(input);
    const markdown = budgetSummaryMarkdown({
      sourceSha: "a".repeat(40), recordedAt: "2026-11-10T13:23:00.000Z", measurement: { runsPerMode: 3 },
      groups: input.groups, bundles: input.bundles, gate,
    });
    expect(markdown).toContain("## Web performance budgets: FAILED");
    expect(markdown).toContain("- demo raw JS+CSS 1200 exceeded 1000");
    expect(markdown).toContain("| sample-member-mobile | cold | not measured | 2,500 | 400 | 150 | 0.05 |");
    expect(markdown).toContain("| demo | 1,200 | 1,000 | 450 | 500 |");
    expect(markdown).toContain("| sample-member-mobile | 2,800 | 3,000 | 700 | 800 |");
    expect(runner).toContain("process.env.GITHUB_STEP_SUMMARY");
  });
});

describe("OPS-UG-WEB-BUDGET-BUNDLE-CEILING-NEEDS-REBASELINE-RULING-20261109", () => {
  const shipped = JSON.parse(readFileSync(new URL("../config/web-performance-budgets.json", import.meta.url), "utf8"));
  const runner = readFileSync(new URL("../scripts/run-web-performance-budgets.mjs", import.meta.url), "utf8");

  it.each([
    ["raw", "firstPaintRawBytes", 3001],
    ["gzip", "firstPaintGzipBytes", 801],
  ])("fails a deliberate %s first-paint regression on the cold load", (label, metric, regressed) => {
    const input = passingInput();
    input.groups[0].metrics[metric].median = regressed;
    const result = evaluateWebPerformanceBudget(input);
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([`sample-member-mobile/cold first-paint ${label} JS+CSS ${regressed} exceeded ${label === "raw" ? 3000 : 800}`]);
  });

  it("judges first paint on the cold load only", () => {
    const input = passingInput();
    input.config = { ...config, modes: ["cold", "warm"] };
    const warm = { ...structuredClone(input.groups[0]), mode: "warm" };
    warm.metrics.firstPaintRawBytes = summarizeSamples([{}, {}, {}]).firstPaintRawBytes;
    input.groups.push(warm);
    expect(evaluateWebPerformanceBudget(input)).toMatchObject({ passed: true, failures: [] });
  });

  it("fails a missing first-paint ceiling and names it before any measurement", () => {
    const input = passingInput();
    input.config = { ...config, firstPaint: { scenarios: { "sample-member-mobile": { rawBytes: 3000 } } } };
    expect(evaluateWebPerformanceBudget(input).failures).toEqual(["sample-member-mobile/cold first-paint gzip JS+CSS has no configured budget ceiling"]);
    expect(missingBudgetCeilings({ ...input.config, scenarios: [{ id: "sample-member-mobile", inpTarget: ".bell" }] }))
      .toEqual(["firstPaint.scenarios.sample-member-mobile.gzipBytes"]);
  });

  it("requires every cold run to have measured first paint", () => {
    const input = passingInput();
    input.groups[0].metrics.firstPaintGzipBytes = summarizeSamples([{ firstPaintGzipBytes: 700 }, {}, {}]).firstPaintGzipBytes;
    expect(evaluateWebPerformanceBudget(input).failures).toContain(
      "sample-member-mobile/cold first-paint firstPaintGzipBytes requires 3 finite measurements (received 1 finite from 3 attempts)");
  });

  it("re-baselines the bundle on its own date while the scenario ratchet keeps October 11", () => {
    const ratchet = { startsOn: "2026-10-11", bundleStartsOn: "2026-11-10", monthlyReduction: 0.05,
      bundle: { allJavaScriptAndCssRawBytes: 2000, allJavaScriptAndCssGzipBytes: 800 },
      scenarios: { "sample-member-mobile": { cold: { tbtMs: 1000 } } } };
    const ratcheted = { ...config, ratchet };
    expect(effectiveBundleCeilings(ratcheted, "2026-11-11")).toEqual({ allJavaScriptAndCssRawBytes: 2000, allJavaScriptAndCssGzipBytes: 800 });
    expect(effectiveBundleCeilings(ratcheted, "2026-12-10")).toEqual({ allJavaScriptAndCssRawBytes: 1900, allJavaScriptAndCssGzipBytes: 760 });
    const result = evaluateWebPerformanceBudget({ ...passingInput(), config: ratcheted, today: "2026-11-11" });
    expect(result.ceilings.groups["sample-member-mobile/cold"].tbtMs).toBe(950);
    expect(result.ceilings.firstPaint).toEqual({ "sample-member-mobile": { rawBytes: 3000, gzipBytes: 800 } });
  });

  it("ships the November 10 ruling: bundle re-baselined, ratchet and targets unchanged, a first-paint ceiling per scenario", () => {
    expect(shipped.ratchet).toMatchObject({ startsOn: "2026-10-11", monthlyReduction: 0.05 });
    expect(shipped.ratchet.bundleStartsOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(shipped.ratchet.bundleStartsOn >= "2026-11-10").toBe(true);
    expect(Object.keys(shipped.firstPaint.scenarios).toSorted()).toEqual(shipped.scenarios.map((scenario) => scenario.id).toSorted());
    expect(shipped.bundle).toEqual({ allJavaScriptAndCssRawBytes: 4400000, allJavaScriptAndCssGzipBytes: 1150000 });
    for (const scenario of shipped.scenarios) {
      const limit = shipped.firstPaint.scenarios[scenario.id];
      expect(limit.rawBytes, scenario.id).toBeLessThan(shipped.ratchet.bundle.allJavaScriptAndCssRawBytes);
      expect(limit.gzipBytes, scenario.id).toBeLessThan(limit.rawBytes);
    }
    expect(runner).toContain("performance.getEntriesByType(\"resource\")");
    expect(runner).toContain("[firstPaintAtMark, firstPaintAssetPaths(await resourceEntries(), appReadyMs)]");
  });
});

describe("size ceilings carry 2 percent headroom over the measured size (re-based November 10, 2026, Refs #7734)", () => {
  const shipped = JSON.parse(readFileSync(new URL("../config/web-performance-budgets.json", import.meta.url), "utf8"));
  const withHeadroom = (measured) => Math.ceil(measured * 1.02);
  const bundleEntries = Object.entries(shipped.ratchet.bundleMeasuredBytes).map(([name, measured]) =>
    ({ label: `bundle ${name}`, measured, ceiling: shipped.ratchet.bundle[name] }));
  const firstPaintEntries = Object.entries(shipped.firstPaint.scenarios).flatMap(([id, limit]) =>
    ["rawBytes", "gzipBytes"].map((name) => ({ label: `${id} first-paint ${name}`, id, name, measured: limit.measured[name], ceiling: limit[name] })));

  it("records the headroom and the measured value for every size ceiling", () => {
    expect(shipped.ratchet.bundleHeadroom).toBe(0.02);
    expect(shipped.firstPaint.headroom).toBe(0.02);
    expect(Object.keys(shipped.ratchet.bundleMeasuredBytes).toSorted()).toEqual(Object.keys(shipped.ratchet.bundle).toSorted());
    expect(bundleEntries).toHaveLength(2);
    expect(firstPaintEntries).toHaveLength(shipped.scenarios.length * 2);
  });

  it.each([...bundleEntries, ...firstPaintEntries])("$label is the measured size times 1.02, rounded up", ({ measured, ceiling }) => {
    expect(Number.isInteger(measured) && measured > 0).toBe(true);
    expect(ceiling).toBe(withHeadroom(measured));
  });

  const evaluateAt = (today, { bundleBytes, firstPaint }) => {
    const groups = shipped.scenarios.map((scenario) => {
      const sample = { lcpMs: 1, cls: 0, inpMs: 1, tbtMs: 1, ...firstPaint(scenario.id) };
      return { id: scenario.id, mode: "cold", profile: scenario.profile, metrics: summarizeSamples([sample, sample, sample]) };
    });
    const bundles = ["saas", "demo"].map((surface) => ({ surface, ...bundleBytes }));
    return evaluateWebPerformanceBudget({ config: { ...shipped, modes: ["cold"] }, groups, bundles, today });
  };
  const measuredFirstPaint = (id) => ({ firstPaintRawBytes: shipped.firstPaint.scenarios[id].measured.rawBytes, firstPaintGzipBytes: shipped.firstPaint.scenarios[id].measured.gzipBytes });
  const measuredBundle = { rawBytes: shipped.ratchet.bundleMeasuredBytes.allJavaScriptAndCssRawBytes, gzipBytes: shipped.ratchet.bundleMeasuredBytes.allJavaScriptAndCssGzipBytes };

  it("passes the measured sizes and the ceilings themselves", () => {
    expect(evaluateAt("2026-11-17", { bundleBytes: measuredBundle, firstPaint: measuredFirstPaint }).failures).toEqual([]);
    const atCeiling = { rawBytes: shipped.ratchet.bundle.allJavaScriptAndCssRawBytes, gzipBytes: shipped.ratchet.bundle.allJavaScriptAndCssGzipBytes };
    const firstPaintAtCeiling = (id) => ({ firstPaintRawBytes: shipped.firstPaint.scenarios[id].rawBytes, firstPaintGzipBytes: shipped.firstPaint.scenarios[id].gzipBytes });
    expect(evaluateAt("2026-11-17", { bundleBytes: atCeiling, firstPaint: firstPaintAtCeiling }).failures).toEqual([]);
  });

  it.each(bundleEntries)("fails $label one byte over its ceiling", ({ label, ceiling }) => {
    const metric = label.endsWith("RawBytes") ? "rawBytes" : "gzipBytes";
    const result = evaluateAt("2026-11-17", { bundleBytes: { ...measuredBundle, [metric]: ceiling + 1 }, firstPaint: measuredFirstPaint });
    expect(result.failures).toContain(`demo ${metric === "rawBytes" ? "raw" : "gzip"} JS+CSS ${ceiling + 1} exceeded ${ceiling}`);
  });

  it.each(firstPaintEntries)("fails $label one byte over its ceiling", ({ id, name, ceiling }) => {
    const metric = name === "rawBytes" ? "firstPaintRawBytes" : "firstPaintGzipBytes";
    const result = evaluateAt("2026-11-17", { bundleBytes: measuredBundle,
      firstPaint: (scenarioId) => ({ ...measuredFirstPaint(scenarioId), ...(scenarioId === id ? { [metric]: ceiling + 1 } : {}) }) });
    expect(result.failures).toEqual([`${id}/cold first-paint ${name === "rawBytes" ? "raw" : "gzip"} JS+CSS ${ceiling + 1} exceeded ${ceiling}`]);
  });
});

describe("first-paint collection keeps every read and fails closed (safety review of #8041)", () => {
  const sizes = new Map([["/assets/index-a.js", { rawBytes: 300, gzipBytes: 100 }], ["/assets/index-a.css", { rawBytes: 50, gzipBytes: 20 }]]);
  const origin = "http://127.0.0.1:4173";

  it("counts only built JS and CSS whose fetch started before the mark", () => {
    expect(firstPaintAssetPaths([
      { name: `${origin}/assets/index-a.js?v=1`, startTime: 10 },
      { name: `${origin}/assets/index-a.css`, startTime: 99 },
      { name: `${origin}/assets/late-b.js`, startTime: 100 },
      { name: `${origin}/api/runtime-config`, startTime: 5 },
      { name: `${origin}/assets/logo.svg`, startTime: 5 },
    ], 100)).toEqual(["/assets/index-a.js", "/assets/index-a.css"]);
  });

  it("keeps an asset seen at the mark after the page clears its resource timings", () => {
    const atMark = firstPaintAssetPaths([{ name: `${origin}/assets/index-a.js`, startTime: 10 }], 100);
    const afterClear = firstPaintAssetPaths([], 100);
    expect(firstPaintBytes([atMark, afterClear], sizes, "s")).toEqual({ firstPaintRawBytes: 300, firstPaintGzipBytes: 100, firstPaintAssetCount: 1 });
  });

  it("adds a fetch that was still in flight at the mark and counts a file seen twice once", () => {
    const atMark = ["/assets/index-a.js"];
    const late = ["/assets/index-a.js", "/assets/index-a.css"];
    expect(firstPaintBytes([atMark, late], sizes, "s")).toEqual({ firstPaintRawBytes: 350, firstPaintGzipBytes: 120, firstPaintAssetCount: 2 });
  });

  it("fails an empty list, a zero-byte list and an asset missing from the build", () => {
    expect(() => firstPaintBytes([[], []], sizes, "s")).toThrow("s: the cold load recorded no first-paint JavaScript or CSS");
    expect(() => firstPaintBytes([["/assets/empty.js"]], new Map([["/assets/empty.js", { rawBytes: 0, gzipBytes: 20 }]]), "s"))
      .toThrow("s: first-paint assets priced to zero bytes");
    expect(() => firstPaintBytes([["/assets/gone.js"]], sizes, "s")).toThrow("s: first-paint asset /assets/gone.js is not in the measured build");
  });
});
