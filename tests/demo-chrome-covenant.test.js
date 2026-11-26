// @vitest-environment node

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../scripts/visual-audit.mjs", () => ({ settleVisualAuditSurface: async () => {} }));
import {
  DEMO_CHROME_CHAPTER_LEGIBILITY_MIN_WIDTH,
  DEMO_CHROME_COVENANT_LANGUAGES,
  DEMO_CHROME_COVENANT_RULES,
  DEMO_CHROME_COVENANT_VIEWPORTS,
  DEMO_CHROME_RAIL_STATES,
  DEMO_CHROME_SEQUENCE_VIEWPORT,
  DEMO_CHROME_EXPECTED_CHAPTER_COUNT,
  DEMO_CHROME_EXPECTED_CHAPTER_NAMES,
  DEMO_CHROME_EXPECTED_HAT_LABELS,
  DEMO_CHROME_MIN_SHORT_HEIGHT_CONTROLS,
  DEMO_CHROME_STEWARD_REQUIRED_DESTINATIONS,
  DEMO_CHROME_STEWARD_MIN_DESTINATIONS,
  DEMO_CHROME_APPOINTMENTS_HREF,
  classifyDemoChromeGeometry,
  classifyShortHeightControls,
  classifyWelcomeSequence,
  classifyRailDestinations,
  renderCovenantMarkdown,
  summarizeCovenantFindings,
  chapterIdentityEvidence,
  CovenantAssertionError,
  CovenantTransientRunnerError,
  classifyTransientCovenantRunnerError,
  demoChromeGeometryCases,
  projectMemberProfileLanguage,
  runCovenantCaseWithRetry,
  summarizeCovenantError,
  classifyCovenantCoverage,
  summarizeCovenantCoverage,
  renderCovenantFailureLines,
} from "../scripts/lib/demo-chrome-covenant.mjs";
import {
  newCovenantContext,
  observeRailGeometry,
  proveGeometry,
  proveGeometryCases,
  closeCovenantContext,
} from "../scripts/verify-demo-chrome-covenant.mjs";

// Copied independently from the retained live rail observation. Do not derive
// this fixture from the runner's expected-name export: disagreement between
// the observed DOM contract and the runner must make this regression fail.
const RETAINED_LIVE_CHAPTER_IDENTITIES = Object.freeze([
  "Cedar Ridge Care Services", "Pine Harbor Care Services", "Maple Crossing Care Services", "Pine Harbor Family Services", "Pine Harbor Health Services",
  "Pine Harbor Benefits Office", "Spruce Point Care Services", "Willow Bend Care Services", "Birch Hollow Care Services",
  "Cedar Ridge Family Services", "Maple Crossing Family Services", "Willow Bend Family Services", "Elm Grove Health Services",
  "Oak Meadow Health Services", "Cedar Ridge Health Services", "Cedar Ridge Rehab Services", "Maple Crossing Benefits Office",
  "Cedar Ridge Benefits Office", "Aspen Flats Benefits Office", "Pine Harbor Rehab Services",
]);

// A full, seeded chapter measurement: 20 names and 20 count lines, all legible.
const chapterName = (index) => ({
  selector: ".chapter-rail__name",
  label: DEMO_CHROME_EXPECTED_CHAPTER_NAMES[index],
  clientWidth: 200,
  scrollWidth: 180,
  clientHeight: 20,
  scrollHeight: 20,
  splitWords: [],
});
const chapterMeta = (index) => ({
  selector: ".chapter-rail__meta",
  label: `${1000 + index} members · ${index} staff`,
  clientWidth: 200,
  scrollWidth: 180,
  clientHeight: 20,
  scrollHeight: 20,
  splitWords: [],
});
const fullChapterNames = () => Array.from({ length: DEMO_CHROME_EXPECTED_CHAPTER_COUNT }, (_, index) => chapterName(index));
const fullChapterMetas = () => Array.from({ length: DEMO_CHROME_EXPECTED_CHAPTER_COUNT }, (_, index) => chapterMeta(index));
const fullChapters = () => {
  const names = fullChapterNames();
  const metas = fullChapterMetas();
  return { chapterNames: names, chapterMetas: metas, chapterTexts: [...names, ...metas] };
};
// A full, focusable short-height rail control set.
const fullShortControls = () => Array.from(
  { length: DEMO_CHROME_MIN_SHORT_HEIGHT_CONTROLS },
  (_, index) => ({ label: `Control ${index}`, focused: true, top: 10, bottom: 60, height: 50 }),
);

const viewport = { name: "wide-1440x900", width: 1440, height: 900 };
const context = { viewport, language: "en", railState: "expanded" };

const fittingLabel = (overrides = {}) => ({
  selector: ".desktop-rail__label",
  label: "Appointments",
  clientWidth: 120,
  scrollWidth: 118,
  clientHeight: 20,
  scrollHeight: 20,
  splitWords: [],
  ...overrides,
});

const workTabs = (overrides = {}) => ({
  rendered: true,
  fits: true,
  measurements: [{ label: "Board", allocatedWidth: 120, labelWidth: 60, requiredWidth: 100 }],
  visibleLabels: [fittingLabel({ label: "Board" })],
  ...overrides,
});

const geometry = (overrides = {}) => ({
  document: { clientWidth: 1440, scrollWidth: 1440 },
  expectChapterRail: false,
  expectWorkTabs: true,
  railLabels: [fittingLabel()],
  chapterTexts: [],
  workTabs: workTabs(),
  ...overrides,
});

const rules = (findings) => findings.map((entry) => entry.rule);

describe("demo-chrome covenant viewport contract", () => {
  it("names exactly the viewports, languages and rail states the records require", () => {
    expect(DEMO_CHROME_COVENANT_VIEWPORTS.map(({ width, height }) => `${width}x${height}`))
      .toEqual(["1280x800", "1440x900", "1920x1080", "1024x450"]);
    expect(DEMO_CHROME_COVENANT_LANGUAGES).toEqual(["en", "es"]);
    expect(DEMO_CHROME_RAIL_STATES).toEqual(["expanded", "collapsed"]);
    expect(DEMO_CHROME_SEQUENCE_VIEWPORT).toEqual({ name: "wide-1440x900", width: 1440, height: 900 });
    // The merged repair keeps the legacy 184px chapter allocation below 1280px.
    expect(DEMO_CHROME_CHAPTER_LEGIBILITY_MIN_WIDTH).toBe(1280);
  });
});

describe("classifyDemoChromeGeometry", () => {
  it("passes a surface whose labels all fit and whose document does not scroll sideways", () => {
    expect(classifyDemoChromeGeometry(geometry(), context)).toEqual([]);
  });

  it("fails a rail label whose text overflows its allocation", () => {
    const findings = classifyDemoChromeGeometry(
      geometry({ railLabels: [fittingLabel({ scrollWidth: 141, clientWidth: 120 })] }),
      context,
    );
    expect(rules(findings)).toEqual([DEMO_CHROME_COVENANT_RULES.RAIL_LABEL_CLIPPED]);
    expect(findings[0].label).toBe("Appointments");
    expect(findings[0].viewport).toEqual({ name: "wide-1440x900", width: 1440, height: 900 });
    expect(findings[0].language).toBe("en");
    expect(findings[0].railState).toBe("expanded");
  });

  it("tolerates a sub-pixel measurement difference", () => {
    expect(classifyDemoChromeGeometry(
      geometry({ railLabels: [fittingLabel({ scrollWidth: 120.4, clientWidth: 120 })] }),
      context,
    )).toEqual([]);
  });

  it("fails the original Appointments orphan wrap as an intra-word break", () => {
    const findings = classifyDemoChromeGeometry(
      geometry({ railLabels: [fittingLabel({ splitWords: ["Appointments"] })] }),
      context,
    );
    expect(rules(findings)).toEqual([DEMO_CHROME_COVENANT_RULES.RAIL_LABEL_INTRA_WORD_BREAK]);
    expect(findings[0].splitWords).toEqual(["Appointments"]);
  });

  it("fails closed when the expanded rail rendered no measurable label at all", () => {
    expect(rules(classifyDemoChromeGeometry(geometry({ railLabels: [] }), context)))
      .toEqual([DEMO_CHROME_COVENANT_RULES.RAIL_LABELS_MISSING]);
  });

  it("requires painted Work tab labels to agree with the measured fit in both directions", () => {
    const measurements = [{ label: "Board", allocatedWidth: 100, labelWidth: 40, requiredWidth: 80 }];
    const painted = classifyDemoChromeGeometry(geometry({
      workTabs: { rendered: false, fits: true, measurements, visibleLabels: [] },
    }), context);
    expect(rules(painted)).toEqual([DEMO_CHROME_COVENANT_RULES.WORK_TAB_FIT_MISMATCH]);

    const overflowing = classifyDemoChromeGeometry(geometry({
      workTabs: {
        rendered: true,
        fits: false,
        measurements: [{ label: "Board", allocatedWidth: 60, labelWidth: 40, requiredWidth: 80 }],
        visibleLabels: [],
      },
    }), context);
    expect(rules(overflowing)).toEqual([DEMO_CHROME_COVENANT_RULES.WORK_TAB_FIT_MISMATCH, DEMO_CHROME_COVENANT_RULES.WORK_TAB_PAINTED_LABEL_MISMATCH]);
  });

  it("rejects enabled Work labels hidden by CSS even when their measured text fits", () => {
    const findings = classifyDemoChromeGeometry(geometry({
      workTabs: workTabs({ visibleLabels: [] }),
    }), context);
    expect(rules(findings)).toContain("work-tab-painted-label-mismatch");
  });

  it("rejects a missing painted label among several Work tabs", () => {
    const findings = classifyDemoChromeGeometry(geometry({ workTabs: workTabs({
      measurements: [
        { label: "Board", allocatedWidth: 120, labelWidth: 60, requiredWidth: 100 },
        { label: "List", allocatedWidth: 120, labelWidth: 60, requiredWidth: 100 },
      ],
      visibleLabels: [fittingLabel({ label: "Board" })],
    }) }), context);
    expect(rules(findings)).toContain("work-tab-painted-label-mismatch");
  });

  it("rejects painted Work labels when the toolbar declares them hidden", () => {
    const findings = classifyDemoChromeGeometry(geometry({ workTabs: workTabs({
      rendered: false, fits: false,
      visibleLabels: [fittingLabel({ label: "Board" })],
    }) }), context);
    expect(rules(findings)).toContain("work-tab-painted-label-mismatch");
  });

  it("rejects twenty chapter rows that duplicate one identity and omit another", () => {
    const chapters = fullChapters();
    chapters.chapterNames[19] = { ...chapters.chapterNames[0] };
    const findings = classifyDemoChromeGeometry(geometry({
      ...chapters, expectChapterRail: true,
    }), context);
    expect(rules(findings)).toContain("chapter-identities-incomplete");
    expect(findings[0]).toMatchObject({
      missing: [DEMO_CHROME_EXPECTED_CHAPTER_NAMES[19]],
      unexpected: [DEMO_CHROME_EXPECTED_CHAPTER_NAMES[0]],
      duplicates: [{ label: DEMO_CHROME_EXPECTED_CHAPTER_NAMES[0], count: 2 }],
    });
  });

  it("fails a painted Work tab label that is clipped or broken inside a word", () => {
    const findings = classifyDemoChromeGeometry(geometry({
      workTabs: {
        rendered: true,
        fits: true,
        measurements: [{ label: "Cronograma", allocatedWidth: 120, labelWidth: 90, requiredWidth: 110 }],
        visibleLabels: [
          { label: "Cronograma", clientWidth: 80, scrollWidth: 96, clientHeight: 18, scrollHeight: 18, splitWords: ["Cronograma"] },
        ],
      },
    }), context);
    expect(rules(findings)).toEqual([
      DEMO_CHROME_COVENANT_RULES.WORK_TAB_LABEL_CLIPPED,
      DEMO_CHROME_COVENANT_RULES.RAIL_LABEL_INTRA_WORD_BREAK,
    ]);
  });

  it("fails closed when the Work toolbar rendered no measurable tab", () => {
    expect(rules(classifyDemoChromeGeometry(geometry({
      workTabs: { rendered: false, fits: false, measurements: [], visibleLabels: [] },
    }), context))).toEqual([DEMO_CHROME_COVENANT_RULES.WORK_TABS_MISSING]);
  });

  it("fails closed when the Work desk renders no toolbar at all", () => {
    // A renamed container or a changed tablist role makes the collector return
    // workTabs: null. On the Work desk that must be a finding, never a silent
    // pass that vacates the whole bilingual label-fit matrix.
    expect(rules(classifyDemoChromeGeometry(
      geometry({ expectWorkTabs: true, workTabs: null }),
      context,
    ))).toEqual([DEMO_CHROME_COVENANT_RULES.WORK_TABS_MISSING]);
    // Surfaces that are not the Work desk still make no Work-tab claim.
    expect(classifyDemoChromeGeometry(
      geometry({ expectWorkTabs: false, workTabs: null }),
      context,
    )).toEqual([]);
  });

  it("asserts chapter names and count lines only where the rail is expected to expand", () => {
    const clippedChapter = {
      selector: ".chapter-rail__name",
      label: DEMO_CHROME_EXPECTED_CHAPTER_NAMES[0],
      clientWidth: 61,
      scrollWidth: 138,
      clientHeight: 17,
      scrollHeight: 17,
      splitWords: [],
    };
    const chapters = fullChapters();
    // One clipped name inside an otherwise-complete 20/20 set: only the clip.
    expect(rules(classifyDemoChromeGeometry(
      geometry({
        expectChapterRail: true,
        chapterNames: [clippedChapter, ...chapters.chapterNames.slice(1)],
        chapterMetas: chapters.chapterMetas,
        chapterTexts: [clippedChapter, ...chapters.chapterNames.slice(1), ...chapters.chapterMetas],
      }),
      context,
    ))).toEqual([DEMO_CHROME_COVENANT_RULES.CHAPTER_TEXT_CLIPPED]);
    // Below the supported chapter width the whole check is skipped.
    expect(classifyDemoChromeGeometry(
      geometry({ expectChapterRail: false, chapterTexts: [clippedChapter] }),
      context,
    )).toEqual([]);
  });

  it("fails a chapter rail that renders no rows at all", () => {
    expect(rules(classifyDemoChromeGeometry(
      geometry({ expectChapterRail: true, chapterTexts: [], chapterNames: [], chapterMetas: [] }),
      context,
    ))).toEqual([
      DEMO_CHROME_COVENANT_RULES.CHAPTER_ROWS_MISSING,
      DEMO_CHROME_COVENANT_RULES.CHAPTER_NAMES_INCOMPLETE,
      DEMO_CHROME_COVENANT_RULES.CHAPTER_COUNTS_INCOMPLETE,
    ]);
  });

  it("mutation: a truncated set of chapter names fails even when each is legible", () => {
    const chapters = fullChapters();
    const findings = rules(classifyDemoChromeGeometry(
      geometry({
        expectChapterRail: true,
        chapterNames: chapters.chapterNames.slice(0, 1),
        chapterMetas: chapters.chapterMetas,
        chapterTexts: [chapters.chapterNames[0], ...chapters.chapterMetas],
      }),
      context,
    ));
    expect(findings).toEqual([DEMO_CHROME_COVENANT_RULES.CHAPTER_NAMES_INCOMPLETE]);
  });

  it("mutation: missing count lines fail even when every name is present", () => {
    const chapters = fullChapters();
    const findings = rules(classifyDemoChromeGeometry(
      geometry({
        expectChapterRail: true,
        chapterNames: chapters.chapterNames,
        chapterMetas: chapters.chapterMetas.slice(0, 5),
        chapterTexts: [...chapters.chapterNames, ...chapters.chapterMetas.slice(0, 5)],
      }),
      context,
    ));
    expect(findings).toEqual([DEMO_CHROME_COVENANT_RULES.CHAPTER_COUNTS_INCOMPLETE]);
  });

  it("passes the full seeded 20/20 chapter set", () => {
    const chapters = fullChapters();
    expect(classifyDemoChromeGeometry(
      geometry({ expectChapterRail: true, ...chapters }),
      context,
    )).toEqual([]);
  });

  it("fails page-level horizontal overflow introduced by the rail", () => {
    expect(rules(classifyDemoChromeGeometry(
      geometry({ document: { clientWidth: 1440, scrollWidth: 1512 } }),
      context,
    ))).toEqual([DEMO_CHROME_COVENANT_RULES.DOCUMENT_HORIZONTAL_OVERFLOW]);
  });
});

describe("live SAMPLE covenant evidence helpers", () => {
  it("pins the twenty live chapter identities instead of the stale generic chapter names", () => {
    expect(DEMO_CHROME_EXPECTED_CHAPTER_NAMES).toHaveLength(20);
    expect(DEMO_CHROME_EXPECTED_CHAPTER_NAMES).toEqual(expect.arrayContaining([
      "Pine Harbor Family Services", "Pine Harbor Health Services", "Pine Harbor Benefits Office",
    ]));
    expect(chapterIdentityEvidence(
      DEMO_CHROME_EXPECTED_CHAPTER_NAMES.map((label) => ({ label })),
    )).toMatchObject({ missing: [], unexpected: [], duplicates: [] });
  });

  it("projects only the language field in the isolated read response", () => {
    const profile = { id: "persona", language: "en", full_name: "Example" };
    expect(projectMemberProfileLanguage(profile, "es")).toEqual({
      id: "persona", language: "es", full_name: "Example",
    });
    expect(profile.language).toBe("en");
    expect(projectMemberProfileLanguage([profile], "es")).toEqual([{
      id: "persona", language: "es", full_name: "Example",
    }]);
    expect(() => projectMemberProfileLanguage(profile, "fr")).toThrow("Unsupported covenant language");
  });

  it("retries only an explicitly classified runner failure", async () => {
    let attempts = 0;
    const retries = [];
    await expect(runCovenantCaseWithRetry(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new CovenantTransientRunnerError(
          "navigation-timeout",
          new Error("page.goto: Timeout 30000ms exceeded."),
        );
      }
      return "passed";
    }, { onRetry: (error, attempt, classification) => retries.push({
      message: error.message, attempt, classification,
    }) }))
      .resolves.toBe("passed");
    expect({ attempts, retries }).toEqual({
      attempts: 2,
      retries: [{ message: "page.goto: Timeout 30000ms exceeded.", attempt: 1, classification: "navigation-timeout" }],
    });

    let persistentAttempts = 0;
    await expect(runCovenantCaseWithRetry(async () => {
      persistentAttempts += 1;
      throw new Error("persistent defect");
    })).rejects.toThrow("persistent defect");
    expect(persistentAttempts).toBe(1);
    expect(classifyTransientCovenantRunnerError(new Error("Hat mismatch after SAMPLE shell settled"))).toBeNull();
    expect(classifyTransientCovenantRunnerError(new Error("Deployment SHA mismatch"))).toBeNull();
    expect(classifyTransientCovenantRunnerError(new Error("locator.evaluate: Error: net::ERR_FAILED"))).toBeNull();
    expect(classifyTransientCovenantRunnerError(new Error("page.evaluate: Target closed"))).toBeNull();
    expect(classifyTransientCovenantRunnerError(new CovenantAssertionError("net::ERR_FAILED"))).toBeNull();
  });

  it("retains only the safe first line of a browser error", () => {
    const error = new Error("route.fetch failed\nrequest headers must not enter the artifact");
    expect(summarizeCovenantError(error)).toBe("route.fetch failed");
    expect(summarizeCovenantError(new Error("\u001b[2mTimed out\u001b[22m"))).toBe("Timed out");
  });
});

describe("demo-chrome covenant live-path regressions", () => {
  let browser;
  let server;
  let serverOrigin;
  const upstreamProfileMethods = [];

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    server = createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/rest/v1/member_profiles") {
        upstreamProfileMethods.push(request.method);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify([{
          id: url.searchParams.get("persona") || "member",
          language: "en",
          full_name: "Retained SAMPLE Persona",
        }]));
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><html lang="en"><body><output id="profile"></output><script>
        window.switchPersona = async (persona) => {
          const response = await fetch('/rest/v1/member_profiles?persona=' + persona);
          const [profile] = await response.json();
          document.documentElement.lang = profile.language;
          const labels = profile.language === 'es'
            ? { member: 'Miembro', coordinator: 'Coordinador' }
            : { member: 'Member', coordinator: 'Coordinator' };
          document.querySelector('#profile').textContent = labels[persona];
          return { language: profile.language, label: labels[persona] };
        };
      </script></body></html>`);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    serverOrigin = `http://127.0.0.1:${server.address().port}`;
  }, BROWSER_HOOK_TIMEOUT);

  afterAll(async () => {
    await browser?.close();
    await new Promise((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
  });

  it.each(["lost-focus", "menu-stuck"])("retains the primary %s failure, partial keyboard evidence and failed exit through cleanup errors", async (fault) => {
    const artifactDir = await mkdtemp(join(tmpdir(), "covenant-failed-keyboard-"));
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: `
      <!doctype html><html lang="en"><nav class="desktop-rail">Rail</nav>
      <button class="demo-hat-selector__trigger">Steward</button>
      <div class="demo-hat-selector__menu" hidden><p class="demo-hat-selector__intro">Choose a hat</p></div>
      <div class="demo-welcome-layer"><button class="dialog-primary">Explore</button></div>
      <script>
        const trigger = document.querySelector('.demo-hat-selector__trigger');
        const menu = document.querySelector('.demo-hat-selector__menu');
        document.querySelector('.dialog-primary').onclick = () => {
          document.querySelector('.demo-welcome-layer').remove(); menu.hidden = false; trigger.focus();
        };
        document.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape') return;
          if (${JSON.stringify(fault)} === 'lost-focus') { menu.hidden = true; trigger.blur(); }
        });
      </script></html>` }));
    const page = await context.newPage();
    vi.spyOn(context, "newPage").mockResolvedValue(page);
    vi.spyOn(page, "screenshot").mockRejectedValue(new Error("failure screenshot unavailable"));
    vi.spyOn(context, "unrouteAll").mockRejectedValue(new Error("unroute failed"));
    const realClose = context.close.bind(context);
    vi.spyOn(context, "close").mockImplementation(async () => { await realClose(); throw new Error("close failed"); });
    vi.spyOn(chromium, "launch").mockResolvedValue({ newContext: async () => context, close: async () => {
      if (fault === "menu-stuck") throw new Error("browser close failed");
    } });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("DEMO_COVENANT_TIMEOUT_MS", String(runnerTimeout(2_000)));
    vi.stubEnv("DEMO_COVENANT_EXPECTED_SHA", "");
    vi.stubEnv("DEMO_COVENANT_ARTIFACT_DIR", artifactDir);
    const previousExitCode = process.exitCode;
    try {
      const driver = fault === "lost-focus"
        ? await import("../scripts/verify-demo-chrome-covenant.mjs?diagnostic-lost-focus")
        : await import("../scripts/verify-demo-chrome-covenant.mjs?diagnostic-menu-stuck");
      await driver.main();
      const report = JSON.parse(await readFile(join(artifactDir, "demo-chrome-covenant.json"), "utf8"));
      expect(process.exitCode).toBe(1);
      expect(report.status).toBe("failed");
      const [sequence] = report.keyboardSequences;
      expect(sequence).toMatchObject({ activationKey: "Enter", status: "failed", documentSha: null,
        observation: { afterDismissal: { activeElementIsTrigger: true, menuVisible: true } } });
      if (fault === "lost-focus") {
        expect(sequence.observation.keyboardInitial).toMatchObject({ activeElement: "body", menuVisible: false });
        expect(sequence.error.detail).toContain("closed trigger focus left by Escape");
        expect(sequence.error.name).toBe("CovenantAssertionError");
      } else {
        expect(sequence.phase).toBe("escape-menu-dismissal");
        expect(sequence.error.name).toBe("TimeoutError");
        expect(sequence.observation.atFailure.menuVisible).toBe(true);
        expect(sequence.observation).not.toHaveProperty("keyboardInitial");
      }
      expect(sequence.secondaryErrors.map((error) => error.phase))
        .toEqual(["failure-screenshot", "context-unroute", "context-close", ...(fault === "menu-stuck" ? ["browser-close"] : [])]);
      expect(report.executionFailure.error).toEqual(sequence.error);
      expect(report.coverage).toEqual({ missingRows: 126, unrunRows: 126, invalidRows: 0, unexpectedRows: 0 });
      expect(report.findings.filter((row) => row.rule === "covenant-matrix-incomplete")).toHaveLength(126);
      expect(report.surfaces).toEqual([]);
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("STOP welcome Enter");
      expect(output).toContain("unrun-after-abort=126");
      expect(output).not.toContain("observed 0");
      const markdown = await readFile(join(artifactDir, "demo-chrome-covenant.md"), "utf8");
      expect(markdown).toContain("unrun-after-abort=126");
      expect(markdown).not.toContain("observed 0");
    } finally {
      process.exitCode = previousExitCode;
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await realClose().catch(() => {});
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  it("runs the retained chapter markup through the real DOM collector", async () => {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    try {
      const rows = RETAINED_LIVE_CHAPTER_IDENTITIES.map((name, index) => `
        <div class="chapter-rail__row">
          <button class="chapter-rail__choice" aria-label="Open ${name}">
            <span class="chapter-rail__choice-copy">
              <span class="chapter-rail__name">${name}</span>
              <span class="chapter-rail__sub"><span class="chapter-rail__meta">${1000 + index} members · ${20 + index} staff</span></span>
            </span>
          </button>
          <button class="chapter-rail__pin" aria-label="Pin ${name}">Pin</button>
        </div>`).join("");
      await page.setContent(`<style>
        .desktop-rail__label,.chapter-rail__row,.chapter-rail__name,.chapter-rail__meta { display:block; width:260px; }
      </style><nav class="desktop-rail"><span class="desktop-rail__label">Home</span></nav>
      <nav class="chapter-rail"><div class="chapter-rail__list">${rows}</div></nav>`);
      const driverCase = {
        viewport, language: "en", railState: "expanded", route: "/m",
        hat: { key: "member", minControls: 1 },
      };

      const complete = await observeRailGeometry(page, driverCase);
      expect(complete).toMatchObject({
        chapterRowCount: 20, chapterNameCount: 20, chapterMetaCount: 20, findings: [],
      });
      expect(await page.locator(".chapter-rail__name").allTextContents()).toEqual(RETAINED_LIVE_CHAPTER_IDENTITIES);

      await page.locator(".chapter-rail__name").last().evaluate((node, duplicate) => { node.textContent = duplicate; }, RETAINED_LIVE_CHAPTER_IDENTITIES[0]);
      const duplicate = await observeRailGeometry(page, driverCase);
      expect(rules(duplicate.findings)).toContain(DEMO_CHROME_COVENANT_RULES.CHAPTER_IDENTITIES_INCOMPLETE);
      expect(duplicate.findings.find((finding) => finding.rule === DEMO_CHROME_COVENANT_RULES.CHAPTER_IDENTITIES_INCOMPLETE))
        .toMatchObject({ missing: [RETAINED_LIVE_CHAPTER_IDENTITIES[19]], duplicates: [{ label: RETAINED_LIVE_CHAPTER_IDENTITIES[0], count: 2 }] });

      await page.locator(".chapter-rail__row").last().evaluate((node) => node.remove());
      const missing = await observeRailGeometry(page, driverCase);
      expect(missing).toMatchObject({ chapterRowCount: 19, chapterNameCount: 19, chapterMetaCount: 19 });
      expect(rules(missing.findings)).toEqual(expect.arrayContaining([
        DEMO_CHROME_COVENANT_RULES.CHAPTER_NAMES_INCOMPLETE,
        DEMO_CHROME_COVENANT_RULES.CHAPTER_COUNTS_INCOMPLETE,
      ]));
    } finally {
      await page.close();
    }
  });

  it("exercises member_profiles interception in both languages across persona switches without writes", async () => {
    upstreamProfileMethods.length = 0;
    for (const [language, expectedLabels] of [
      ["en", ["Member", "Coordinator"]],
      ["es", ["Miembro", "Coordinador"]],
    ]) {
      const context = await newCovenantContext(browser, { viewport, language });
      try {
        const page = await context.newPage();
        await page.goto(serverOrigin);
        const member = await page.evaluate(() => window.switchPersona("member"));
        const coordinator = await page.evaluate(() => window.switchPersona("coordinator"));
        expect([member.label, coordinator.label]).toEqual(expectedLabels);
        expect(member.language).toBe(language);
        expect(coordinator.language).toBe(language);
        expect(await page.getAttribute("html", "lang")).toBe(language);
        expect(await page.locator("#profile").textContent()).toBe(expectedLabels[1]);
      } finally {
        await context.unrouteAll({ behavior: "wait" });
        await context.close();
      }
    }
    expect(upstreamProfileMethods).toEqual(["GET", "GET", "GET", "GET"]);
  });

  it("retains a real proveGeometry finding when screenshot capture triggers a classified retry", async () => {
    const geometryCase = demoChromeGeometryCases()[0];
    let contexts = 0;
    const report = { surfaces: [], findings: [], caseRetries: [] };
    const safe = (label, selector) => ({
      label, selector, clientWidth: 200, scrollWidth: 180,
      clientHeight: 20, scrollHeight: 20, splitWords: [],
    });
    const adapter = { async newContext() {
      const attempt = ++contexts;
      let collapsed = false;
      let currentUrl = "http://127.0.0.1:4173/m";
      const locator = (selector) => ({
        first() { return this; },
        filter() { return this; },
        locator(subselector) { return locator(subselector); },
        async isVisible() {
          if (selector === "select") return true;
          return !selector.includes("demo-welcome") && !selector.includes("demo-hat-selector__menu")
            && !selector.includes("desktop-rail__hat-option");
        },
        async waitFor() { if (selector.includes("demo-welcome")) throw new Error("fixture has no welcome"); },
        async inputValue() { return "member"; },
        async textContent() { return "Member"; },
        async selectOption() {},
        async getAttribute(name) { return name === "data-collapsed" ? String(collapsed) : null; },
        async click() { if (selector.includes("desktop-rail__collapse")) collapsed = !collapsed; },
      });
      const page = {
        locator,
        keyboard: { async press() {} },
        async goto(url) { currentUrl = url; return null; },
        url() { return currentUrl; },
        async waitForURL() {},
        async waitForFunction() {},
        async waitForTimeout() {},
        async evaluate(fn) {
          if (fn.name !== "collectDemoChromeGeometry") return undefined;
          const chapterNames = RETAINED_LIVE_CHAPTER_IDENTITIES.map((name) => safe(name, ".chapter-rail__name"));
          const chapterMetas = chapterNames.map(() => safe("100 members · 5 staff", ".chapter-rail__meta"));
          const railLabels = Array.from({ length: geometryCase.hat.minControls }, () => safe("Example", ".desktop-rail__label"));
          if (attempt === 1) railLabels[0].scrollWidth = 400;
          return {
            document: { clientWidth: 1280, scrollWidth: 1280 },
            expectChapterRail: !collapsed,
            expectWorkTabs: false,
            railLabels,
            chapterNames,
            chapterMetas,
            chapterTexts: [...chapterNames, ...chapterMetas],
            chapterRows: chapterNames.map((entry) => ({ name: entry.label })),
            workTabs: null,
          };
        },
        async screenshot() {
          if (attempt === 1) throw new Error("page.screenshot: transient capture error after measurement");
        },
      };
      return {
        async addInitScript() {}, async route() {}, async unrouteAll() {}, async close() {},
        async newPage() { return page; },
      };
    } };

    await runCovenantCaseWithRetry(() => proveGeometry(adapter, report, geometryCase), {
      onRetry: (error, attempt, classification) => report.caseRetries.push({
        error: error.message, attempt, classification,
      }),
    });
    expect(contexts).toBe(2);
    expect(rules(report.findings)).toContain(DEMO_CHROME_COVENANT_RULES.RAIL_LABEL_CLIPPED);
    expect(report.surfaces).toHaveLength(2);
    expect(report.caseRetries).toEqual([expect.objectContaining({ attempt: 1, classification: "screenshot-io" })]);
  });

  it("publishes a Steward geometry finding before a typed target-close destination retry", async () => {
    const geometryCase = demoChromeGeometryCases()[1];
    let contexts = 0;
    const report = { surfaces: [], findings: [], caseRetries: [] };
    const safe = (label, selector) => ({
      label, selector, clientWidth: 200, scrollWidth: 180,
      clientHeight: 20, scrollHeight: 20, splitWords: [],
    });
    const adapter = { async newContext() {
      const attempt = ++contexts;
      let collapsed = false;
      let closed = false;
      let currentUrl = "http://127.0.0.1:4173/m";
      const locator = (selector) => ({
        first() { return this; },
        filter() { return this; },
        locator(subselector) { return locator(subselector); },
        async isVisible() {
          return !selector.includes("demo-welcome") && !selector.includes("demo-hat-selector__menu")
            && !selector.includes("desktop-rail__hat-option");
        },
        async waitFor() { if (selector.includes("demo-welcome")) throw new Error("fixture has no welcome"); },
        async inputValue() { return "steward"; },
        async textContent() { return "Steward"; },
        async selectOption() { currentUrl = "http://127.0.0.1:4173/m/steward"; },
        async getAttribute(name) { return name === "data-collapsed" ? String(collapsed) : null; },
        async click() { if (selector.includes("desktop-rail__collapse")) collapsed = !collapsed; },
      });
      const page = {
        locator,
        keyboard: { async press() {} },
        async goto(url) { currentUrl = url; return null; },
        url() { return currentUrl; },
        isClosed() { return closed; },
        async waitForURL() {},
        async waitForFunction() {},
        async waitForTimeout() {},
        async evaluate(fn) {
          if (fn.name === "collectRailDestinations") {
            if (attempt === 1) {
              closed = true;
              throw new Error("opaque browser transport failure");
            }
            return {
              destinationHrefs: [
                ...DEMO_CHROME_STEWARD_REQUIRED_DESTINATIONS,
                ...Array.from({ length: 11 }, (_, index) => `/m/extra-${index}`),
              ],
              appointmentsPresent: true,
              appointmentsLabel: "Appointments",
              appointmentsSplitWords: [],
            };
          }
          if (fn.name !== "collectDemoChromeGeometry") return undefined;
          const chapterNames = RETAINED_LIVE_CHAPTER_IDENTITIES.map((name) => safe(name, ".chapter-rail__name"));
          const chapterMetas = chapterNames.map(() => safe("100 members · 5 staff", ".chapter-rail__meta"));
          const railLabels = Array.from({ length: geometryCase.hat.minControls }, () => safe("Example", ".desktop-rail__label"));
          if (attempt === 1) railLabels[0].scrollWidth = 400;
          return {
            document: { clientWidth: 1280, scrollWidth: 1280 },
            expectChapterRail: !collapsed,
            expectWorkTabs: false,
            railLabels,
            chapterNames,
            chapterMetas,
            chapterTexts: [...chapterNames, ...chapterMetas],
            chapterRows: chapterNames.map((entry) => ({ name: entry.label })),
            workTabs: null,
          };
        },
        async screenshot() {},
      };
      return {
        async addInitScript() {}, async route() {}, async unrouteAll() {}, async close() {},
        async newPage() { return page; },
      };
    } };

    await proveGeometryCases(adapter, report, [geometryCase]);
    expect(contexts).toBe(2);
    expect(rules(report.findings)).toContain(DEMO_CHROME_COVENANT_RULES.RAIL_LABEL_CLIPPED);
    expect(report.surfaces).toHaveLength(2);
    expect(report.caseRetries).toEqual([expect.objectContaining({
      attempt: 1,
      classification: "target-closed",
      accumulatedFindingRules: expect.arrayContaining([DEMO_CHROME_COVENANT_RULES.RAIL_LABEL_CLIPPED]),
    })]);
  });

  it("invalidates a reused page proof and rejects a replacement main document", async () => {
    const previousExpectedSha = process.env.DEMO_COVENANT_EXPECTED_SHA;
    const expectedDocumentSha = "a".repeat(40);
    process.env.DEMO_COVENANT_EXPECTED_SHA = expectedDocumentSha;
    try {
      const { proveGeometryCases: provePinnedGeometryCases } = await import(
        "../scripts/verify-demo-chrome-covenant.mjs?round3-document-regression"
      );
      const [geometryCase, secondCase] = [demoChromeGeometryCases()[0], demoChromeGeometryCases()[3]];
      let actualDocumentSha = expectedDocumentSha;
      let documentReads = 0;
      let contexts = 0;
      const measuredDocumentShas = [];
      const report = { expectedSha: expectedDocumentSha, surfaces: [], findings: [], caseRetries: [] };
      const safe = (label, selector) => ({
        label, selector, clientWidth: 200, scrollWidth: 180,
        clientHeight: 20, scrollHeight: 20, splitWords: [],
      });
      const adapter = { async newContext() {
        contexts += 1;
        let collapsed = false;
        let currentHat = "member";
        let currentUrl = "http://127.0.0.1:4173/m";
        const frame = {};
        const responseListeners = new Set();
        const locator = (selector) => ({
          first() { return this; },
          filter() { return this; },
          locator(subselector) { return locator(subselector); },
          async isVisible() {
            return !selector.includes("demo-welcome") && !selector.includes("demo-hat-selector__menu")
              && !selector.includes("desktop-rail__hat-option");
          },
          async waitFor() { if (selector.includes("demo-welcome")) throw new Error("fixture has no welcome"); },
          async inputValue() { return currentHat; },
          async textContent() { return currentHat === "member" ? "Member" : "Advisor"; },
          async selectOption(hat) {
            currentHat = hat;
            currentUrl = `http://127.0.0.1:4173${hat === "member" ? "/m" : "/m/advisor"}`;
          },
          async getAttribute(name) { return name === "data-collapsed" ? String(collapsed) : null; },
          async click() { if (selector.includes("desktop-rail__collapse")) collapsed = !collapsed; },
        });
        const page = {
          locator,
          keyboard: { async press() {} },
          on(event, listener) { if (event === "response") responseListeners.add(listener); },
          off(event, listener) { if (event === "response") responseListeners.delete(listener); },
          mainFrame() { return frame; },
          async goto(url) {
            currentUrl = url;
            const sha = actualDocumentSha;
            const request = {
              isNavigationRequest: () => true,
              frame: () => frame,
              url: () => url,
              redirectedFrom: () => null,
            };
            const response = {
              request: () => request,
              url: () => url,
              status: () => 200,
              body: async () => {
                documentReads += 1;
                return Buffer.from(`<html><head><meta name="union-ground-build-sha" content="${sha}"></head></html>`);
              },
              headerValue: async () => "text/html",
            };
            for (const listener of responseListeners) listener(response);
            return response;
          },
          url() { return currentUrl; },
          async waitForURL() {},
          async waitForFunction() {},
          async waitForTimeout() {},
          async evaluate(fn) {
            if (fn.name !== "collectDemoChromeGeometry") return undefined;
            const chapterNames = RETAINED_LIVE_CHAPTER_IDENTITIES.map((name) => safe(name, ".chapter-rail__name"));
            const chapterMetas = chapterNames.map(() => safe("100 members · 5 staff", ".chapter-rail__meta"));
            measuredDocumentShas.push({ hat: currentHat, sha: actualDocumentSha });
            return {
              document: { clientWidth: 1280, scrollWidth: 1280 },
              expectChapterRail: !collapsed,
              expectWorkTabs: false,
              railLabels: Array.from({ length: 24 }, () => safe("Example", ".desktop-rail__label")),
              chapterNames,
              chapterMetas,
              chapterTexts: [...chapterNames, ...chapterMetas],
              chapterRows: chapterNames.map((entry) => ({ name: entry.label })),
              workTabs: null,
            };
          },
          async screenshot() {
            if (currentHat === "member" && collapsed) {
              actualDocumentSha = "b".repeat(40);
              await page.goto(currentUrl);
            }
          },
        };
        return {
          async addInitScript() {}, async route() {}, async unrouteAll() {}, async close() {},
          async newPage() { return page; },
        };
      } };

      await expect(provePinnedGeometryCases(adapter, report, [geometryCase, secondCase]))
        .rejects.toBeInstanceOf(CovenantAssertionError);
      expect(contexts).toBe(1);
      // The screenshot-time response invalidates the observation immediately;
      // the replacement body is never read or allowed to bless the old row.
      expect(documentReads).toBe(1);
      expect(measuredDocumentShas).toEqual([
        { hat: "member", sha: expectedDocumentSha },
        { hat: "member", sha: expectedDocumentSha },
      ]);
      expect(report.surfaces.filter((surface) => surface.hat === "advisor")).toEqual([]);
      expect(report.surfaces.every((surface) => surface.documentSha === expectedDocumentSha)).toBe(true);
    } finally {
      if (previousExpectedSha === undefined) delete process.env.DEMO_COVENANT_EXPECTED_SHA;
      else process.env.DEMO_COVENANT_EXPECTED_SHA = previousExpectedSha;
    }
  });

  it.each([
    ["navigation response handoff", "handoff"],
    ["attestation body resolution", "attestation"],
    ["expanded-to-collapsed measurement", "measurement"],
    ["geometry collection-to-publication", "publication"],
  ])("fails closed on navigation during %s", async (_label, race) => {
    const previousExpectedSha = process.env.DEMO_COVENANT_EXPECTED_SHA;
    const expectedDocumentSha = "a".repeat(40);
    const replacementDocumentSha = "b".repeat(40);
    process.env.DEMO_COVENANT_EXPECTED_SHA = expectedDocumentSha;
    try {
      const { proveGeometryCases: proveGenerationBoundCases } = await import(
        "../scripts/verify-demo-chrome-covenant.mjs?round4-generation-regression"
      );
      const geometryCase = demoChromeGeometryCases()[0];
      let actualDocumentSha = expectedDocumentSha;
      let documentReads = 0;
      let measurementCount = 0;
      let collapsed = false;
      let currentUrl = "http://127.0.0.1:4173/m";
      const frame = {};
      const responseListeners = new Set();
      const safe = (label, selector, overrides = {}) => ({
        label, selector, clientWidth: 200, scrollWidth: 180,
        clientHeight: 20, scrollHeight: 20, splitWords: [], ...overrides,
      });
      let page;
      const emitNavigation = (url = currentUrl) => {
        currentUrl = url;
        const sha = actualDocumentSha;
        const request = {
          isNavigationRequest: () => true,
          frame: () => frame,
          url: () => url,
          redirectedFrom: () => null,
        };
        const response = {
          request: () => request,
          url: () => url,
          status: () => 200,
          body: async () => {
            documentReads += 1;
            if (race === "attestation" && documentReads === 1) {
              actualDocumentSha = replacementDocumentSha;
              emitNavigation();
            }
            return Buffer.from(`<html><head><meta name="union-ground-build-sha" content="${sha}"></head></html>`);
          },
          headerValue: async () => "text/html",
        };
        for (const listener of responseListeners) listener(response);
        return response;
      };
      const locator = (selector) => ({
        first() { return this; },
        filter() { return this; },
        locator(subselector) { return locator(subselector); },
        async isVisible() {
          return !selector.includes("demo-welcome") && !selector.includes("demo-hat-selector__menu")
            && !selector.includes("desktop-rail__hat-option");
        },
        async waitFor() { if (selector.includes("demo-welcome")) throw new Error("fixture has no welcome"); },
        async inputValue() { return "member"; },
        async textContent() { return "Member"; },
        async selectOption() {},
        async getAttribute(name) { return name === "data-collapsed" ? String(collapsed) : null; },
        async click() { if (selector.includes("desktop-rail__collapse")) collapsed = !collapsed; },
      });
      page = {
        locator,
        keyboard: { async press() {} },
        on(event, listener) { if (event === "response") responseListeners.add(listener); },
        off(event, listener) { if (event === "response") responseListeners.delete(listener); },
        mainFrame() { return frame; },
        async goto(url) {
          const response = emitNavigation(url);
          if (race === "handoff") {
            actualDocumentSha = replacementDocumentSha;
            emitNavigation(url);
          }
          return response;
        },
        url() { return currentUrl; },
        async waitForURL() {},
        async waitForFunction() {},
        async waitForTimeout() {},
        async evaluate(fn) {
          if (fn.name !== "collectDemoChromeGeometry") return undefined;
          measurementCount += 1;
          if (race === "measurement" && measurementCount === 2) {
            actualDocumentSha = replacementDocumentSha;
            emitNavigation();
          }
          const chapterNames = RETAINED_LIVE_CHAPTER_IDENTITIES.map((name) => safe(name, ".chapter-rail__name"));
          const chapterMetas = chapterNames.map(() => safe("100 members · 5 staff", ".chapter-rail__meta"));
          const firstLabel = safe("Clipped finding retained", ".desktop-rail__label", { scrollWidth: 400 });
          const measurement = {
            document: { clientWidth: 1280, scrollWidth: 1280 },
            expectChapterRail: !collapsed,
            expectWorkTabs: false,
            railLabels: [firstLabel, ...Array.from({ length: 23 }, () => safe("Example", ".desktop-rail__label"))],
            chapterNames,
            chapterMetas,
            chapterTexts: [...chapterNames, ...chapterMetas],
            chapterRows: chapterNames.map((entry) => ({ name: entry.label })),
            workTabs: null,
          };
          if (race === "publication") {
            let publishedCollection = false;
            Object.defineProperty(measurement, "railLabels", {
              enumerable: true,
              get() {
                if (!publishedCollection) {
                  publishedCollection = true;
                  actualDocumentSha = replacementDocumentSha;
                  emitNavigation();
                }
                return [firstLabel, ...Array.from({ length: 23 }, () => safe("Example", ".desktop-rail__label"))];
              },
            });
          }
          return measurement;
        },
        async screenshot() {},
      };
      const adapter = { async newContext() {
        return {
          async addInitScript() {}, async route() {}, async unrouteAll() {}, async close() {},
          async newPage() { return page; },
        };
      } };
      const report = { expectedSha: expectedDocumentSha, surfaces: [], findings: [], caseRetries: [] };
      let failure;
      try {
        await proveGenerationBoundCases(adapter, report, [geometryCase]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(CovenantAssertionError);
      expect(failure.message).toMatch(/Navigation provenance changed during/);
      expect(report.caseRetries).toEqual([]);
      expect(report.surfaces).toEqual([]);
      if (race === "attestation" || race === "handoff") {
        expect(failure.covenantFindings ?? []).toEqual([]);
        if (race === "handoff") {
          expect(documentReads).toBe(0);
          expect(measurementCount).toBe(0);
        }
      } else {
        expect(rules(failure.covenantFindings)).toContain(DEMO_CHROME_COVENANT_RULES.RAIL_LABEL_CLIPPED);
      }
    } finally {
      if (previousExpectedSha === undefined) delete process.env.DEMO_COVENANT_EXPECTED_SHA;
      else process.env.DEMO_COVENANT_EXPECTED_SHA = previousExpectedSha;
    }
  });

  it("never retries a non-transient contract failure even when the next attempt would pass", async () => {
    let attempts = 0;
    await expect(runCovenantCaseWithRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Deployment SHA mismatch: stale document");
      return "passed";
    })).rejects.toThrow("Deployment SHA mismatch");
    expect(attempts).toBe(1);
  });
});

describe("classifyShortHeightControls", () => {
  // Exercise a single control by lowering the expected floor, so the legacy
  // per-control assertions stay focused; the default floor is exercised below.
  const shortContext = {
    viewport: { name: "short-1024x450", width: 1024, height: 450 },
    expectedMinControls: 1,
  };

  it("passes controls that stay inside the 450px viewport and keep the 44px floor", () => {
    expect(classifyShortHeightControls([
      { label: "Forms", focused: true, top: 380, bottom: 431.96875, height: 51.96875 },
    ], shortContext)).toEqual([]);
  });

  it("passes the full seeded short-height rail control set", () => {
    expect(classifyShortHeightControls(fullShortControls(), {
      viewport: { name: "short-1024x450", width: 1024, height: 450 },
    })).toEqual([]);
  });

  it("fails the exact Forms 2 regression measured at bottom 450.21875", () => {
    const findings = classifyShortHeightControls([
      { label: "Forms 2", focused: true, top: 398, bottom: 450.21875, height: 52 },
    ], shortContext);
    expect(rules(findings)).toEqual([DEMO_CHROME_COVENANT_RULES.CONTROL_OUTSIDE_VIEWPORT]);
    expect(findings[0].label).toBe("Forms 2");
  });

  it("fails an undersized or unfocusable control", () => {
    expect(rules(classifyShortHeightControls([
      { label: "Cobalt Signal", focused: false, top: 10, bottom: 50, height: 40 },
    ], shortContext))).toEqual([
      DEMO_CHROME_COVENANT_RULES.CONTROL_NOT_FOCUSABLE,
      DEMO_CHROME_COVENANT_RULES.CONTROL_BELOW_TARGET_FLOOR,
    ]);
  });

  it("mutation: an empty short-height control collection fails closed", () => {
    expect(rules(classifyShortHeightControls([], {
      viewport: { name: "short-1024x450", width: 1024, height: 450 },
    }))).toEqual([DEMO_CHROME_COVENANT_RULES.SHORT_HEIGHT_CONTROLS_MISSING]);
  });

  it("mutation: fewer than the seeded controls fails closed", () => {
    const findings = classifyShortHeightControls(fullShortControls().slice(0, 3), {
      viewport: { name: "short-1024x450", width: 1024, height: 450 },
    });
    expect(rules(findings)).toEqual([DEMO_CHROME_COVENANT_RULES.SHORT_HEIGHT_CONTROLS_MISSING]);
  });
});

describe("classifyWelcomeSequence", () => {
  const passing = () => ({
    initial: { welcomeVisible: true, hatMenuCount: 0, hatIntroCount: 0 },
    afterDismissal: {
      welcomeCount: 0,
      menuVisible: true,
      introVisible: true,
      optionLabels: [...DEMO_CHROME_EXPECTED_HAT_LABELS],
      activeElementIsTrigger: true,
      triggerVisible: true,
      triggerOpacity: 1,
    },
    afterEscape: { introVisible: false, hatIntroCount: 0, activeElementIsTrigger: true },
    afterRetoggle: { menuVisible: true, introVisible: false },
    afterCoordinator: { path: "/m/coordinator", selected: true },
    afterReload: { hatMenuCount: 0, hatIntroCount: 0, triggerCount: 1, activeElementIsTrigger: false },
    phone: { hatSelectorPresent: false, activeElementIsTrigger: false, welcomeFocusHandoff: false },
    saas: { hatSelectorPresent: false, welcomeLayerPresent: false, activeElementIsTrigger: false },
  });

  it("passes the merged welcome-first, focus-handoff, no-replay sequence", () => {
    expect(classifyWelcomeSequence(passing(), { viewport })).toEqual([]);
  });

  it("mutation: six duplicate Member hats fail on identity even though the count is six", () => {
    const observation = passing();
    observation.afterDismissal.optionLabels = ["Member", "Member", "Member", "Member", "Member", "Member"];
    expect(rules(classifyWelcomeSequence(observation, { viewport })))
      .toEqual([DEMO_CHROME_COVENANT_RULES.HAT_OPTIONS_WRONG_IDENTITY]);
  });

  it("mutation: a wrong sixth hat fails on identity", () => {
    const observation = passing();
    observation.afterDismissal.optionLabels = ["Member", "Steward", "Coordinator", "Advisor", "Admin", "Organizer"];
    expect(rules(classifyWelcomeSequence(observation, { viewport })))
      .toEqual([DEMO_CHROME_COVENANT_RULES.HAT_OPTIONS_WRONG_IDENTITY]);
  });

  it("mutation: Escape that strands focus on document.body fails closed", () => {
    const observation = passing();
    observation.afterEscape = { introVisible: false, hatIntroCount: 0, activeElementIsTrigger: false, activeElement: "body" };
    const findings = classifyWelcomeSequence(observation, { viewport });
    expect(rules(findings)).toEqual([DEMO_CHROME_COVENANT_RULES.ESCAPE_FOCUS_UNRESOLVED]);
    expect(findings[0].detail).toContain("body");
  });

  it("mutation: Escape that leaves the intro open fails closed", () => {
    const observation = passing();
    observation.afterEscape = { introVisible: true, hatIntroCount: 1, activeElementIsTrigger: true };
    expect(rules(classifyWelcomeSequence(observation, { viewport })))
      .toEqual([DEMO_CHROME_COVENANT_RULES.ESCAPE_FOCUS_UNRESOLVED]);
  });

  it("mutation: a re-toggle that replays the once-only intro fails closed", () => {
    const observation = passing();
    observation.afterRetoggle = { menuVisible: true, introVisible: true };
    expect(rules(classifyWelcomeSequence(observation, { viewport })))
      .toEqual([DEMO_CHROME_COVENANT_RULES.HAT_INTRO_REPLAYED]);
  });

  it("mutation: a repeat visit that re-steals focus to the trigger fails closed", () => {
    const observation = passing();
    observation.afterReload = { hatMenuCount: 0, hatIntroCount: 0, triggerCount: 1, activeElementIsTrigger: true };
    expect(rules(classifyWelcomeSequence(observation, { viewport })))
      .toEqual([DEMO_CHROME_COVENANT_RULES.REPEAT_VISIT_FOCUS_STOLEN]);
  });

  it("mutation: a phone surface that receives the demo hat focus fails closed", () => {
    const observation = passing();
    observation.phone = { hatSelectorPresent: true, activeElementIsTrigger: true, welcomeFocusHandoff: true };
    expect(rules(classifyWelcomeSequence(observation, { viewport })))
      .toEqual([DEMO_CHROME_COVENANT_RULES.PHONE_RECEIVED_DEMO_FOCUS]);
  });

  it("mutation: a SaaS surface that mounts the demo welcome/hat layer fails closed", () => {
    const observation = passing();
    observation.saas = { hatSelectorPresent: true, welcomeLayerPresent: true, activeElementIsTrigger: false };
    expect(rules(classifyWelcomeSequence(observation, { viewport })))
      .toEqual([DEMO_CHROME_COVENANT_RULES.SAAS_RECEIVED_DEMO_FOCUS]);
  });

  it("fails the original defect: the hat menu open beneath the welcome scrim", () => {
    const observation = passing();
    observation.initial.hatMenuCount = 1;
    observation.initial.hatIntroCount = 1;
    expect(rules(classifyWelcomeSequence(observation, { viewport })))
      .toEqual([DEMO_CHROME_COVENANT_RULES.HAT_MENU_BEFORE_DISMISSAL]);
  });

  it("fails when dismissal strands focus on document.body", () => {
    const observation = passing();
    observation.afterDismissal.activeElementIsTrigger = false;
    observation.afterDismissal.activeElement = "body";
    const findings = classifyWelcomeSequence(observation, { viewport });
    expect(rules(findings)).toEqual([DEMO_CHROME_COVENANT_RULES.WELCOME_FOCUS_NOT_HANDED_OFF]);
    expect(findings[0].detail).toContain("body");
  });

  it("fails an invisible trigger, a short hat list, and a rejected Coordinator selection", () => {
    const observation = passing();
    observation.afterDismissal.triggerOpacity = 0.2;
    observation.afterDismissal.optionLabels = ["Member", "Steward", "Coordinator"];
    observation.afterCoordinator = { path: "/m", selected: false };
    expect(rules(classifyWelcomeSequence(observation, { viewport }))).toEqual([
      DEMO_CHROME_COVENANT_RULES.HAT_OPTIONS_INCOMPLETE,
      DEMO_CHROME_COVENANT_RULES.SWITCH_HAT_TRIGGER_NOT_VISIBLE,
      DEMO_CHROME_COVENANT_RULES.COORDINATOR_SELECTION_REJECTED,
    ]);
  });

  it("fails a reload that replays the once-only intro", () => {
    const observation = passing();
    observation.afterReload = { hatMenuCount: 1, hatIntroCount: 1, triggerCount: 1 };
    expect(rules(classifyWelcomeSequence(observation, { viewport })))
      .toEqual([DEMO_CHROME_COVENANT_RULES.HAT_INTRO_REPLAYED]);
  });

  it("fails a first visit that never showed the welcome dialog", () => {
    const observation = passing();
    observation.initial.welcomeVisible = false;
    expect(rules(classifyWelcomeSequence(observation, { viewport })))
      .toEqual([DEMO_CHROME_COVENANT_RULES.WELCOME_NOT_FIRST]);
  });
});

describe("classifyRailDestinations", () => {
  const railContext = { viewport, language: "en", railState: "expanded" };
  const filler = Array.from(
    { length: DEMO_CHROME_STEWARD_MIN_DESTINATIONS - DEMO_CHROME_STEWARD_REQUIRED_DESTINATIONS.length },
    (_, index) => `/m/filler-${index}`,
  );
  const fullRail = () => ({ destinationHrefs: [...DEMO_CHROME_STEWARD_REQUIRED_DESTINATIONS, ...filler] });

  it("passes the full Steward rail with Appointments present", () => {
    expect(classifyRailDestinations(fullRail(), railContext)).toEqual([]);
  });

  it("mutation: a rail missing Appointments fails closed", () => {
    const measurement = { destinationHrefs: fullRail().destinationHrefs.filter((href) => href !== DEMO_CHROME_APPOINTMENTS_HREF) };
    // Keep the count at the floor by substituting a filler for Appointments.
    measurement.destinationHrefs.push("/m/filler-extra");
    const found = rules(classifyRailDestinations(measurement, railContext));
    expect(found).toContain(DEMO_CHROME_COVENANT_RULES.APPOINTMENTS_DESTINATION_MISSING);
    expect(found).toContain(DEMO_CHROME_COVENANT_RULES.RAIL_DESTINATION_MISSING);
  });

  it("mutation: a single-label rail fails on missing destinations and cardinality", () => {
    const found = rules(classifyRailDestinations({ destinationHrefs: ["/m/steward"] }, railContext));
    expect(found).toContain(DEMO_CHROME_COVENANT_RULES.APPOINTMENTS_DESTINATION_MISSING);
    expect(found).toContain(DEMO_CHROME_COVENANT_RULES.RAIL_DESTINATION_MISSING);
    expect(found).toContain(DEMO_CHROME_COVENANT_RULES.RAIL_DESTINATIONS_BELOW_EXPECTED);
  });

  it("mutation: a rail below the expected destination count fails closed", () => {
    const measurement = { destinationHrefs: [...DEMO_CHROME_STEWARD_REQUIRED_DESTINATIONS] };
    expect(rules(classifyRailDestinations(measurement, railContext)))
      .toEqual([DEMO_CHROME_COVENANT_RULES.RAIL_DESTINATIONS_BELOW_EXPECTED]);
  });
});

describe("covenant reporting", () => {
  const completeCoverage = () => demoChromeGeometryCases().flatMap(({ viewport, language, hat, route }) => [
    ...["expanded", "collapsed"].map((railState) => ({ viewport, language, hat: hat.key, route, railState, check: "geometry", documentSha: "a".repeat(40) })),
    ...(viewport.height === 450 ? [{ viewport, language, hat: hat.key, route, railState: "expanded", check: "short-height-controls", documentSha: "a".repeat(40) }] : []),
  ]);

  it.each(["missing", "duplicate", "wrong-sha", "unattested", "unexpected"])("keeps %s coverage evidence failing independently of abort presentation", (mutant) => {
    const report = { expectedSha: "a".repeat(40), surfaces: completeCoverage() };
    expect(report.surfaces).toHaveLength(126);
    expect(classifyCovenantCoverage(report)).toEqual([]);
    if (mutant === "missing") report.surfaces.shift();
    if (mutant === "duplicate") report.surfaces.push({ ...report.surfaces[0] });
    if (mutant === "wrong-sha") report.surfaces[0].documentSha = "b".repeat(40);
    if (mutant === "unattested") delete report.surfaces[0].documentSha;
    if (mutant === "unexpected") report.surfaces.push({ ...report.surfaces[0], hat: "invented" });
    const original = classifyCovenantCoverage(report);
    expect(original).toHaveLength(1);
    const before = JSON.stringify(report);
    const coverage = summarizeCovenantCoverage(report);
    expect(coverage.unrunRows).toBe(0);
    expect(coverage[mutant === "missing" ? "missingRows" : mutant === "unexpected" ? "unexpectedRows" : "invalidRows"]).toBe(1);
    const output = renderCovenantFailureLines({ ...report, findings: original }).join("\n");
    expect(output).toContain("exact coverage is still required");
    expect(JSON.stringify(report)).toBe(before);
    expect(classifyCovenantCoverage({ ...report, executionFailure: { kind: "geometry" } })).toEqual(original);
  });

  it("distinguishes missing rows in an attempted case from cases never started after an abort", () => {
    const first = completeCoverage()[0];
    const report = { surfaces: [], executionFailure: { kind: "geometry" }, geometryCasesStarted: [first] };
    expect(summarizeCovenantCoverage(report)).toEqual({ missingRows: 126, unrunRows: 124, invalidRows: 0, unexpectedRows: 0 });
  });

  it("still closes the context after unroute fails and fails a previously successful attempt", async () => {
    const error = new Error("unroute unavailable");
    const close = vi.fn(async () => { throw new Error("close unavailable"); });
    await expect(closeCovenantContext({ unrouteAll: async () => { throw error; }, close })).rejects.toBe(error);
    expect(close).toHaveBeenCalledOnce();
    expect(error.covenantSecondaryErrors).toEqual([expect.objectContaining({ phase: "context-close", detail: "close unavailable" })]);
  });

  it("summarizes findings by rule and renders a readable artifact", () => {
    const findings = [
      { rule: "rail-label-clipped", viewport, language: "es", railState: "expanded", detail: "one" },
      { rule: "rail-label-clipped", viewport, language: "en", railState: "collapsed", detail: "two" },
      { rule: "hat-intro-replayed", viewport: null, language: null, railState: null, detail: "three" },
    ];
    expect(summarizeCovenantFindings(findings)).toEqual([
      { rule: "hat-intro-replayed", count: 1 },
      { rule: "rail-label-clipped", count: 2 },
    ]);
    const markdown = renderCovenantMarkdown({
      status: "failed",
      baseUrl: "https://app.example.org",
      expectedSha: "a".repeat(40),
      surfaces: [{ viewport, route: "/m/tasks", language: "en", railState: "expanded", railLabelCount: 20,
        chapterRowCount: 20, chapterNameCount: 20, chapterMetaCount: 20 }],
      findings,
    });
    expect(markdown).toContain("Status: failed");
    expect(markdown).toContain("| rail-label-clipped | 2 |");
    expect(markdown).toContain("`hat-intro-replayed`");
    expect(markdown).toContain("Chapter rows measured: 20");
    expect(markdown).toContain("Chapter names measured: 20");
  });

  it("renders a clean pass without a findings table", () => {
    const markdown = renderCovenantMarkdown({
      status: "passed",
      baseUrl: "https://app.example.org",
      expectedSha: null,
      surfaces: [],
      findings: [],
    });
    expect(markdown).toContain("No covenant findings.");
  });
});

describe("demo-chrome covenant driver", () => {
  it("asks the /m/tasks collector to require a Work toolbar", () => {
    const driver = readFileSync(new URL("../scripts/verify-demo-chrome-covenant.mjs", import.meta.url), "utf8");
    // Without this flag an absent toolbar would make the entire bilingual
    // Work-tab label-fit matrix disappear behind a clean pass.
    expect(driver).toMatch(/expectWorkTabs:\s*true/);
  });
});
