// The browser half of tests/setup.js: it runs only for files whose environment
// provides a DOM (jsdom). Node-environment files skip it and its imports.
import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";

// Testing Library's findBy*/waitFor default of 1 s is below the scheduling
// jitter of the hosted 8-worker Root check (2026-09-22: "Unable to find
// role=heading Messages", "Unable to find text A retained synthetic answer"
// on Main pushes that passed locally). Widen only under CI so local runs keep
// the fast feedback and real regressions still fail within seconds.
if (process.env.CI) configure({ asyncUtilTimeout: 5_000 });
import { afterAll, afterEach, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { relative } from "node:path";
import { DUPLICATE_KEY_OFFENDERS } from "./duplicateKeyOffenders.js";
import { DUPLICATE_KEY_WARNING, settleDuplicateKeyWarnings } from "./duplicateKeyGate.js";
// The web app fetches the Spanish catalogue on demand (loadLanguage); unit
// tests render both languages synchronously, so register every language up
// front on the same module instance the tests import.
import "../../src/lib/i18n/allLanguages.js";
import { fallbackData } from "../fixtures/retired-pre-bot/src/data/fallback.js";
import { primeDemoData } from "../../src/data/demoData.js";
import { clearDeviceParityState } from "../../src/lib/deviceParity.js";
import { clearActingHat } from "../../src/lib/actingHat.js";

// jsdom deliberately leaves CanvasRenderingContext2D unimplemented. Signature
// tests exercise the accessible input contract and normalized stroke data;
// real paint is covered in browser proof, so keep the unit environment quiet.
if (globalThis.HTMLCanvasElement) {
  globalThis.HTMLCanvasElement.prototype.getContext = () => null;
}

// App forces demo mode under vitest (import.meta.env.MODE === "test"), and in a
// real browser the demo fixtures now arrive over a dynamic import so they stay
// out of the member bundle. Priming the cache here keeps `render(<App />)`
// synchronous for the whole suite, which is what every existing assertion
// assumes.
primeDemoData(fallbackData);

// A test can end with React work still queued in its
// scheduler (passive effects, a follow-up render), which the scheduler runs on
// setImmediate. Nothing awaited it, so on a loaded runner it could run after
// jsdom's teardown and fail the whole shard with "ReferenceError: window is not
// defined" from performWorkOnRootViaSchedulerTask, though every test passed
// (#8821, run 43707417189). Let that queue drain while the window exists. The
// real setImmediate is taken now, so a file that leaves fake timers on cannot
// hang this hook; a few turns cover a scheduler task that queues one more.
const drainSetImmediate = globalThis.setImmediate;
afterAll(async () => {
  for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => drainSetImmediate(resolve));
});

afterEach(() => {
  cleanup();
  clearDeviceParityState();
  // The worn hat is kept per tab session; one test's hat must not open the
  // next test's App in it.
  clearActingHat();
});

// REQ-UG-INVITE-TERMS-AGE-STATE-FORM-CLARITY-20261030: the terms gate
// keeps a chosen state for the tab; one test's choice must not prefill the
// next test's gate.
afterEach(() => {
  try { window.sessionStorage.removeItem("union-ground.legal-acceptance-draft"); } catch { /* no DOM storage in node tests */ }
});

// TEST-UG-SMALL-NEW-ORGANIZATION-FIXTURE-AND-WEB-ROUTE-JOURNEYS-20261111
// (#8318): React's duplicate-key warning fails the test that raised it. Two
// children with one key is how the forms page kept two editors on screen
// (#8212) while its tests passed. Files that raised it before this check are
// listed in ./duplicateKeyOffenders.js, a list that may only shrink. A test
// that replaces console.error with its own mock takes on that duty itself.
// UG_DUPLICATE_KEY_REPORT=<file> also records every file that raised it, to
// rebuild the list after a fix; it never turns the failure off.
// Vitest runs from the repository root (vite.config.mjs).
const repositoryRoot = process.cwd();
const duplicateKeyOffenders = new Set(DUPLICATE_KEY_OFFENDERS);
let duplicateKeyWarnings = [];
const consoleError = console.error;
console.error = function recordDuplicateKeys(...args) {
  if (DUPLICATE_KEY_WARNING.test(String(args[0]))) duplicateKeyWarnings.push(args.map(String).join(" ").slice(0, 400));
  return consoleError.apply(this, args);
};
afterEach(() => {
  const warnings = duplicateKeyWarnings;
  duplicateKeyWarnings = [];
  if (warnings.length === 0) return;
  settleDuplicateKeyWarnings({
    warnings,
    file: relative(repositoryRoot, expect.getState().testPath ?? "").split("\\").join("/"),
    testName: expect.getState().currentTestName,
    offenders: duplicateKeyOffenders,
    reportPath: process.env.UG_DUPLICATE_KEY_REPORT ?? "",
    append: appendFileSync,
  });
});
