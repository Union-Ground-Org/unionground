// @vitest-environment node
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { observeRailGeometry } from "../scripts/verify-demo-chrome-covenant.mjs";
import { classifyCovenantCoverage, demoChromeGeometryCases, DEMO_CHROME_COVENANT_HATS } from "../scripts/lib/demo-chrome-covenant.mjs";

let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

// Exercise the same browser measurement path as the executable, including the
// full geometry classifier on a Spanish non-Coordinator rail. The fixture is
// deliberately small; chapter/Work/selection integration runs against the app.
async function observe(mutation = "", railState = "expanded") {
  const page = await browser.newPage({ viewport: { width: 1024, height: 450 } });
  try {
    await page.setContent(`<style>
      .desktop-rail__label { display:block; width:180px; line-height:20px }
      ${mutation === "clip" ? '.desktop-rail__label:first-child { width:12px; white-space:nowrap; overflow:hidden }' : ''}
      ${mutation === "wrap" ? '.desktop-rail__label:first-child { width:12px; overflow-wrap:anywhere }' : ''}
      ${mutation === "overflow" ? 'body { width:2000px }' : ''}
      ${railState === "collapsed" ? '.desktop-rail__label { display:none }' : ''}
      </style><nav class="desktop-rail">${Array.from({ length: mutation === "missing-labels" ? 1 : 24 },
        (_, i) => `<span class="desktop-rail__label">${i ? 'Mis casos' : 'Recompensas'}</span>`).join('')}</nav>`);
    return await observeRailGeometry(page, { viewport: { name: "short-1024x450", width: 1024, height: 450 },
      language: "es", hat: DEMO_CHROME_COVENANT_HATS[0], route: "/m", railState });
  } finally { await page.close(); }
}

describe("bilingual full-hat rail measurement driver", () => {
  it("measures the full Spanish Member rail", async () => {
    expect(await observe()).toMatchObject({ hat: "member", language: "es", railLabelCount: 24, findings: [] });
  });
  for (const [mutation, rule] of [["clip", "rail-label-clipped"], ["wrap", "rail-label-intra-word-break"],
    ["overflow", "document-horizontal-overflow"], ["missing-labels", "rail-labels-missing"]]) {
    it(`rejects Spanish Member ${mutation}`, async () => {
      const result = await observe(mutation);
      expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ rule, hat: "member", language: "es" })]));
    });
  }
  it("exempts only deliberately hidden collapsed labels, retaining overflow checks", async () => {
    expect((await observe("", "collapsed")).findings).toEqual([]);
    expect((await observe("overflow", "collapsed")).findings.map((f) => f.rule)).toContain("document-horizontal-overflow");
  });
});

const sha = "a".repeat(40);
function fullReport() {
  const surfaces = [];
  // Independent expected acceptance matrix, not the driver's enumeration.
  for (const [name, width, height] of [["desktop-1280x800",1280,800], ["wide-1440x900",1440,900],
    ["wide-1920x1080",1920,1080], ["short-1024x450",1024,450]]) {
    for (const language of ["en", "es"]) {
      for (const [hat, route] of [["member","/m"], ["steward","/m/steward"], ["coordinator","/m/coordinator"],
        ["advisor","/m/advisor"], ["admin","/m/admin"], ["vp","/m/vp"], ["coordinator","/m/tasks"]]) {
        for (const railState of ["expanded", "collapsed"]) {
          surfaces.push({ hat, route, language, viewport: { name, width, height }, railState, check: "geometry", documentSha: sha });
        }
        if (height === 450) surfaces.push({ hat, route, language, viewport: { name, width, height }, railState: "expanded", check: "short-height-controls", documentSha: sha });
      }
    }
  }
  return { expectedSha: sha, surfaces };
}

describe("covenant required matrix", () => {
  it("requires 56 fresh contexts and 126 observed geometry/control rows", () => {
    const cases = demoChromeGeometryCases();
    expect(cases).toHaveLength(56);
    expect([...new Set(cases.map((c) => c.hat.key))]).toEqual(["member", "steward", "coordinator", "advisor", "admin", "vp"]);
    expect(fullReport().surfaces).toHaveLength(126);
    expect(classifyCovenantCoverage(fullReport())).toEqual([]);
  });
  for (const mutation of ["whole-hat", "spanish", "work", "collapsed", "short-height", "duplicate", "sha", "dimensions", "unexpected"]) {
    it(`refuses ${mutation} coverage substitution`, () => {
      const report = fullReport();
      if (mutation === "whole-hat") report.surfaces = report.surfaces.filter((r) => r.hat !== "advisor");
      if (mutation === "spanish") report.surfaces = report.surfaces.filter((r) => r.language !== "es");
      if (mutation === "work") report.surfaces = report.surfaces.filter((r) => r.route !== "/m/tasks");
      if (mutation === "collapsed") report.surfaces = report.surfaces.filter((r) => r.railState !== "collapsed");
      if (mutation === "short-height") report.surfaces = report.surfaces.filter((r) => r.check !== "short-height-controls");
      if (mutation === "duplicate") report.surfaces.push(report.surfaces[0]);
      if (mutation === "sha") report.surfaces[0].documentSha = "b".repeat(40);
      if (mutation === "dimensions") report.surfaces[0].viewport.width = 390;
      if (mutation === "unexpected") report.surfaces.push({ ...report.surfaces[0], hat: "other" });
      expect(classifyCovenantCoverage(report).length).toBeGreaterThan(0);
    });
  }
});
