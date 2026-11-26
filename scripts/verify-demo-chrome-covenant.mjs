/* global document */
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { settleVisualAuditSurface } from "./visual-audit.mjs";
import {
  assertLoadedBuildDocument,
  assertPageOrigin,
} from "./lib/browserbase-target-policy.mjs";
import {
  selectVisibleHatControl,
  waitForVisibleSelectedHatControl,
} from "./lib/visual-audit-hat-control.mjs";
import {
  DEMO_CHROME_COVENANT_LANGUAGES,
  DEMO_CHROME_CHAPTER_LEGIBILITY_MIN_WIDTH,
  DEMO_CHROME_COVENANT_VIEWPORTS,
  DEMO_CHROME_LANGUAGE_STORAGE_KEY,
  DEMO_CHROME_RAIL_STATES,
  DEMO_CHROME_SEQUENCE_VIEWPORT,
  DEMO_CHROME_SHORT_HEIGHT_VIEWPORT_NAME,
  DEMO_CHROME_EXPECTED_CHAPTER_COUNT,
  DEMO_CHROME_COVENANT_HATS,
  demoChromeGeometryCases,
  classifyCovenantCoverage,
  DEMO_CHROME_EXPECTED_HAT_LABELS,
  DEMO_CHROME_STEWARD_REQUIRED_DESTINATIONS,
  DEMO_CHROME_STEWARD_MIN_DESTINATIONS,
  DEMO_CHROME_APPOINTMENTS_HREF,
  DEMO_CHROME_COVENANT_RULES,
  nonDemoCovenantUrl,
  classifyDemoChromeGeometry,
  classifyShortHeightControls,
  classifyWelcomeSequence,
  classifyRailDestinations,
  collectDemoChromeGeometry,
  collectRailDestinations,
  collectWelcomeSurface,
  renderCovenantMarkdown,
  summarizeCovenantFindings,
  projectMemberProfileLanguage,
  attachCovenantFindings,
  CovenantAssertionError,
  CovenantTransientRunnerError,
  runCovenantCaseWithRetry,
  summarizeCovenantError,
  covenantErrorDetails,
  attachCovenantSecondaryError,
  summarizeCovenantCoverage,
  renderCovenantFailureLines,
} from "./lib/demo-chrome-covenant.mjs";

// Exact-SHA covenant proof for the merged SAMPLE demo-chrome records
// (PR #1511 welcome/hat sequencing, PR #1522 rail geometry, focus handoff and
// bilingual Work-tab label fitting). The generic visual audit cannot express
// these promises: it has no notion of a word boundary, of a rail state, or of
// what the first visit is supposed to do. This driver asserts them directly.

const baseUrl = process.env.DEMO_COVENANT_BASE_URL || "http://127.0.0.1:4173";
const expectedSha = process.env.DEMO_COVENANT_EXPECTED_SHA || "";
const artifactDir = process.env.DEMO_COVENANT_ARTIFACT_DIR
  || join(process.cwd(), "artifacts", "demo-chrome-covenant");
const TIMEOUT_MS = Number.parseInt(process.env.DEMO_COVENANT_TIMEOUT_MS || "30000", 10);

if (!Number.isFinite(TIMEOUT_MS) || TIMEOUT_MS < 1) {
  throw new Error("DEMO_COVENANT_TIMEOUT_MS must be a positive integer");
}

const RAIL_LABEL_SELECTORS = Object.freeze([
  ".desktop-rail__label",
  ".desktop-rail__ainame",
  ".desktop-rail__grouplabel",
  ".desktop-rail__collapse-label",
]);
const CHAPTER_TEXT_SELECTORS = Object.freeze([
  ".chapter-rail__name",
  ".chapter-rail__meta",
]);
const WORK_TAB_GROUP_SELECTOR = ".tasks-screen .kan-topbar [role='tablist']";
const COORDINATOR_LABELS = Object.freeze({ en: "Coordinator", es: "Coordinador" });

function appendDemoQuery() {
  const value = String(process.env.DEMO_COVENANT_APPEND_DEMO ?? "1").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(value)) return false;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  throw new Error("DEMO_COVENANT_APPEND_DEMO must be a boolean flag");
}

function covenantUrl(route) {
  const url = new URL(route, baseUrl);
  if (appendDemoQuery()) url.searchParams.set("demo", "1");
  return url.href;
}

async function attestDocument(page, response, targetBaseUrl = baseUrl, assertStillCurrent = () => {}) {
  if (!expectedSha) return null;
  try {
    if (!response) throw new Error("Covenant navigation returned no main-document response");
    const request = response.request();
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) {
      throw new Error("Covenant navigation did not return the loaded main document");
    }
    const expectedOrigin = new URL(targetBaseUrl).origin;
    const [body, contentType] = await Promise.all([
      response.body(),
      response.headerValue("content-type"),
    ]);
    assertStillCurrent("document body/header read");
    const proof = assertLoadedBuildDocument({
      requestedUrl: request.url(),
      responseUrl: response.url(),
      status: response.status(),
      contentType,
      body,
      redirectedFrom: Boolean(request.redirectedFrom()),
      expectedOrigin,
      expectedSha,
    });
    assertPageOrigin(page.url(), expectedOrigin);
    return proof;
  } catch (error) {
    if (error instanceof CovenantAssertionError) throw error;
    throw new CovenantAssertionError(summarizeCovenantError(error, 1200), { cause: error });
  }
}

function isTypedTargetClosedError(error, page) {
  if (error?.name === "TargetClosedError" || error?.constructor?.name === "TargetClosedError") return true;
  try {
    return page?.isClosed?.() === true;
  } catch {
    return false;
  }
}

async function runNavigationOperation(page, operation, findings = []) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CovenantAssertionError || error instanceof CovenantTransientRunnerError) {
      throw attachCovenantFindings(error, findings);
    }
    const classification = error?.name === "TimeoutError" ? "navigation-timeout" : "transport-navigation-error";
    throw new CovenantTransientRunnerError(classification, error, findings);
  }
}

async function runTargetBoundOperation(page, operation, findings = []) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CovenantAssertionError || error instanceof CovenantTransientRunnerError) {
      throw attachCovenantFindings(error, findings);
    }
    if (isTypedTargetClosedError(error, page)) {
      throw new CovenantTransientRunnerError("target-closed", error, findings);
    }
    throw attachCovenantFindings(error, findings);
  }
}

async function runScreenshotOperation(page, operation, findings = []) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CovenantAssertionError || error instanceof CovenantTransientRunnerError) {
      throw attachCovenantFindings(error, findings);
    }
    throw new CovenantTransientRunnerError("screenshot-io", error, findings);
  }
}

function createDocumentAttestation(page, targetBaseUrl = baseUrl) {
  let navigationGeneration = 0;
  let attestedGeneration = -1;
  let attestedResponse = null;
  let latestResponse = null;
  let proof = null;
  const supportsNavigationEvents = typeof page.on === "function";
  const observeResponse = (response) => {
    try {
      const request = response.request();
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
      latestResponse = response;
      navigationGeneration += 1;
      proof = null;
      attestedGeneration = -1;
      attestedResponse = null;
    } catch {
      // A malformed response is rejected by attestDocument, never trusted here.
      latestResponse = response;
      navigationGeneration += 1;
      proof = null;
      attestedGeneration = -1;
      attestedResponse = null;
    }
  };
  if (supportsNavigationEvents) page.on("response", observeResponse);
  const capture = (response = latestResponse) => ({
    generation: navigationGeneration,
    response,
  });
  const assertCaptured = (token, phase, findings = []) => {
    if (token.generation === navigationGeneration && token.response === latestResponse) return;
    throw attachCovenantFindings(new CovenantAssertionError(
      `Navigation provenance changed during ${phase}: generation ${token.generation} became ${navigationGeneration}`,
    ), findings);
  };
  const publishAttestation = async (response, phase) => {
    const token = capture(response);
    const candidate = await attestDocument(page, response, targetBaseUrl, (step) => {
      assertCaptured(token, `${phase} ${step}`);
    });
    assertCaptured(token, `${phase} publication`);
    proof = candidate;
    attestedGeneration = token.generation;
    attestedResponse = token.response;
    return proof;
  };
  return {
    supportsNavigationEvents,
    async bind(response) {
      if (supportsNavigationEvents && response && response !== latestResponse) {
        throw new CovenantAssertionError("Navigation provenance changed during navigation response handoff: navigation returned a superseded response");
      }
      if (response && response !== latestResponse) observeResponse(response);
      return publishAttestation(response ?? latestResponse, "document attestation");
    },
    async current() {
      if (!expectedSha) return null;
      if (proof && attestedGeneration === navigationGeneration && attestedResponse === latestResponse) return proof;
      if (!latestResponse) {
        throw new CovenantAssertionError("Covenant main-document attestation was invalidated without a replacement response");
      }
      return publishAttestation(latestResponse, "current document attestation");
    },
    async beginObservation(phase = "observation") {
      const currentProof = await this.current();
      const token = capture(latestResponse);
      if (expectedSha && (
        !currentProof
        || attestedGeneration !== token.generation
        || attestedResponse !== token.response
      )) {
        throw new CovenantAssertionError(`Navigation provenance is unattested at the start of ${phase}`);
      }
      assertCaptured(token, `${phase} start`);
      return { ...token, proof: currentProof };
    },
    assertObservation(token, phase, findings = []) {
      assertCaptured(token, phase, findings);
      if (expectedSha && (
        token.proof !== proof
        || attestedGeneration !== token.generation
        || attestedResponse !== token.response
      )) {
        throw attachCovenantFindings(new CovenantAssertionError(
          `Navigation provenance lost its attested response during ${phase}`,
        ), findings);
      }
    },
    dispose() {
      page.off?.("response", observeResponse);
    },
  };
}

async function verifyExpectedSha(page) {
  if (!expectedSha) return;
  const info = await page.request.get(`${baseUrl}/build-info.json`, {
    headers: { "cache-control": "no-store" },
  });
  const payload = await info.json();
  if (payload.commitSha !== expectedSha) {
    throw new CovenantAssertionError(`Deployment SHA mismatch: expected ${expectedSha}; received ${payload.commitSha}`);
  }
}

export async function newCovenantContext(browser, { viewport, language }) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  });
  await context.addInitScript(([key, value]) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // A storage-denied context still renders the default language.
    }
  }, [DEMO_CHROME_LANGUAGE_STORAGE_KEY, language]);
  await context.route(/\/rest\/v1\/member_profiles(?:\?|$)/, async (route) => {
    const method = route.request().method();
    if (method === "HEAD") {
      await route.continue();
      return;
    }
    if (method !== "GET") {
      await route.abort("blockedbyclient");
      throw new CovenantAssertionError(`The read-only covenant refused a member_profiles ${method} request`);
    }
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({
      response,
      body: JSON.stringify(projectMemberProfileLanguage(payload, language)),
    });
  });
  return context;
}

export async function closeCovenantContext(context, primaryError = null, documentAttestation = null) {
  let failure = primaryError;
  for (const [phase, cleanup] of [
    ["document-dispose", () => documentAttestation?.dispose()],
    ["context-unroute", () => context.unrouteAll({ behavior: "ignoreErrors" })],
    ["context-close", () => context.close()],
  ]) {
    try {
      await cleanup();
    } catch (error) {
      if (failure) attachCovenantSecondaryError(failure, phase, error);
      else failure = error;
    }
  }
  if (!primaryError && failure) throw failure;
}

async function waitForShell(page) {
  await page.locator("nav.desktop-rail, .card-nav__panel--home, .home-orb").first()
    .waitFor({ state: "visible", timeout: TIMEOUT_MS });
}

async function waitForLanguage(page, language) {
  try {
    await page.waitForFunction((expected) => document.documentElement.lang === expected, language, {
      timeout: TIMEOUT_MS,
    });
  } catch (error) {
    if (isTypedTargetClosedError(error, page)) {
      throw new CovenantTransientRunnerError("target-closed", error);
    }
    throw new CovenantAssertionError(
      `Language projection mismatch: expected ${language}; ${summarizeCovenantError(error)}`,
      { cause: error },
    );
  }
}

function selectedHatControls(page, hat, label) {
  const select = page.locator("select").filter({ has: page.locator(`option[value="${hat}"]`) }).first();
  return {
    select,
    selectedOption: select.locator("option:checked"),
    hat,
    expandedOption: page.locator("button.desktop-rail__hat-option")
      .filter({ hasText: new RegExp(`^${label}$`) }).first(),
    trigger: page.locator("button.demo-hat-selector__trigger").first(),
    label,
  };
}

async function waitForSelectedHat(page, hat, label, timeoutMs = TIMEOUT_MS) {
  return waitForVisibleSelectedHatControl({
    ...selectedHatControls(page, hat, label),
    timeoutMs,
    waitForRetry: (delayMs) => page.waitForTimeout(delayMs),
  });
}

async function dismissWelcome(page) {
  const welcome = page.locator(".demo-welcome-layer");
  try {
    await welcome.waitFor({ state: "visible", timeout: Math.min(8000, TIMEOUT_MS) });
  } catch {
    return;
  }
  await welcome.locator(".demo-welcome__actions .dialog-primary, .dialog-primary").first().click();
  await welcome.waitFor({ state: "hidden", timeout: TIMEOUT_MS });
}

async function closeHatMenu(page) {
  const menu = page.locator(".demo-hat-selector__menu");
  if (!await menu.isVisible().catch(() => false)) return;
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden", timeout: TIMEOUT_MS });
}

async function selectHat(page, hat, label, expectedPath) {
  await selectVisibleHatControl({
    select: page.locator("select").filter({ has: page.locator(`option[value="${hat}"]`) }).first(),
    hat,
    expandedOption: page.locator("button.desktop-rail__hat-option")
      .filter({ hasText: new RegExp(`^${label}$`) }).first(),
    option: page.locator("button.demo-hat-selector__option")
      .filter({ hasText: new RegExp(`^${label}$`) }).first(),
    trigger: page.locator("button.demo-hat-selector__trigger").first(),
    timeoutMs: TIMEOUT_MS,
    waitForRetry: (delayMs) => page.waitForTimeout(delayMs),
  });
  await page.waitForURL((url) => url.pathname === expectedPath, { timeout: TIMEOUT_MS });
  await waitForShell(page);
  await waitForSelectedHat(page, hat, label);
}

async function openChapterWork(page, language) {
  const label = COORDINATOR_LABELS[language];
  await selectHat(page, "coordinator", label, "/m/coordinator");
  const taskLink = page.locator('a[href^="/m/tasks"]').first();
  await taskLink.waitFor({ state: "visible", timeout: TIMEOUT_MS });
  await taskLink.click();
  await page.waitForURL((url) => url.pathname === "/m/tasks", { timeout: TIMEOUT_MS });
  await page.locator(".tasks-screen").waitFor({ state: "visible", timeout: TIMEOUT_MS });
}

async function setRailState(page, railState) {
  const rail = page.locator('nav.desktop-rail[data-render-mode="desktop"]').first();
  if (!await rail.isVisible().catch(() => false)) return false;
  const expected = railState === "collapsed" ? "true" : "false";
  if (await rail.getAttribute("data-collapsed") === expected) return true;
  const toggle = page.locator("button.desktop-rail__collapse").first();
  if (!await toggle.isVisible().catch(() => false)) return false;
  await toggle.click();
  await page.waitForFunction((state) => (
    document.querySelector('nav.desktop-rail[data-render-mode="desktop"]')
      ?.getAttribute("data-collapsed") === state
  ), expected, { timeout: TIMEOUT_MS });
  return true;
}

async function measureShortHeightControls(page, documentAttestation, observationToken, findings = []) {
  const assertCurrent = (phase) => documentAttestation?.assertObservation(observationToken, phase, findings);
  const controls = page.locator(".desktop-rail a, .desktop-rail button");
  const total = await controls.count();
  assertCurrent("short-height control count");
  const measured = [];
  for (let index = 0; index < total; index += 1) {
    const control = controls.nth(index);
    const visible = await control.isVisible().catch(() => false);
    assertCurrent(`short-height control ${index} visibility`);
    if (!visible) continue;
    await control.scrollIntoViewIfNeeded();
    assertCurrent(`short-height control ${index} scroll`);
    await control.focus();
    assertCurrent(`short-height control ${index} focus`);
    const measurement = await control.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        focused: document.activeElement === node,
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        label: (node.getAttribute("aria-label") || node.textContent || "").trim().slice(0, 120),
      };
    });
    assertCurrent(`short-height control ${index} measurement`);
    measured.push(measurement);
  }
  assertCurrent("short-height control collection publication");
  return measured;
}

// Continue from the focus Escape actually left. Never use click()/focus() to
// manufacture reachability; intentional tabindex=-1 peers use roving arrows.
export async function observeKeyboardHatActivation(page, { activationKey, timeoutMs = TIMEOUT_MS }, {
  documentAttestation = null,
  observationToken = null,
  publishObservation = () => {},
} = {}) {
  const assertCurrent = (phase) => documentAttestation?.assertObservation(observationToken, phase);
  if (!["Enter", "Space"].includes(activationKey)) throw new CovenantAssertionError("Unsupported hat activation key");
  const before = await page.evaluate(collectWelcomeSurface);
  publishObservation("keyboardInitial", before);
  assertCurrent("keyboard sequence initial collection");
  if (!before.activeElementIsTrigger || before.menuVisible) {
    throw new CovenantAssertionError(`Keyboard hat activation requires the closed trigger focus left by Escape; observed ${JSON.stringify(before)}`);
  }
  await page.keyboard.press(activationKey);
  assertCurrent("keyboard sequence activation");
  await page.locator(".demo-hat-selector__menu").waitFor({ state: "visible", timeout: timeoutMs });
  assertCurrent("keyboard sequence menu visibility");
  const afterRetoggle = await page.evaluate(collectWelcomeSurface);
  publishObservation("afterRetoggle", afterRetoggle);
  assertCurrent("keyboard sequence retoggle collection");
  const focusedLabels = [];
  for (const [key, label] of [[null, "Steward"], ["ArrowDown", "Coordinator"], ["ArrowUp", "Steward"], ["ArrowDown", "Coordinator"]]) {
    if (key) {
      await page.keyboard.press(key);
      assertCurrent(`keyboard sequence ${key}`);
    }
    const focus = await page.evaluate(() => {
      const options = [...document.querySelectorAll("button.demo-hat-selector__option")];
      const active = document.activeElement;
      return {
        label: options.includes(active) ? active.textContent.trim() : null,
        activeTabIndex: active?.tabIndex,
        rovingCount: options.filter((option) => option.tabIndex === 0).length,
      };
    });
    publishObservation("keyboardFocus", { key: key || activationKey, ...focus });
    assertCurrent(`keyboard sequence ${key || activationKey} focus collection`);
    if (focus.label !== label || focus.activeTabIndex !== 0 || focus.rovingCount !== 1) {
      throw new CovenantAssertionError(`Keyboard hat focus after ${key || activationKey}: expected ${label}; observed ${JSON.stringify(focus)}`);
    }
    focusedLabels.push(focus.label);
  }
  await page.keyboard.press(activationKey);
  assertCurrent("keyboard sequence persona activation");
  await page.waitForURL((url) => url.pathname === "/m/coordinator", { timeout: timeoutMs });
  assertCurrent("keyboard sequence coordinator URL");
  await page.locator(".demo-hat-selector__menu").waitFor({ state: "hidden", timeout: timeoutMs });
  assertCurrent("keyboard sequence menu dismissal");
  const selectedControl = await waitForSelectedHat(page, "coordinator", COORDINATOR_LABELS.en, timeoutMs);
  assertCurrent("keyboard sequence selected-hat collection");
  const surface = await page.evaluate(collectWelcomeSurface);
  publishObservation("afterCoordinator", surface);
  assertCurrent("keyboard sequence surface publication");
  return {
    afterRetoggle,
    keyboard: { activationKey, focusedLabels },
    afterCoordinator: {
      path: surface.path,
      triggerLabel: surface.triggerLabel,
      selected: selectedControl.selected,
      controlShape: selectedControl.shape,
      controlLabel: selectedControl.label,
      hatMenuCount: surface.hatMenuCount,
    },
  };
}

export async function proveWelcomeSequence(browser, report, activationKey) {
  const viewport = DEMO_CHROME_SEQUENCE_VIEWPORT;
  const sequence = {
    kind: "welcome", activationKey, viewport, language: "en", route: "/m",
    phase: "context-open", status: "running", documentSha: null, observation: {}, findings: [],
  };
  report.keyboardSequences.push(sequence);
  report.activeCase = sequence;
  const observation = sequence.observation;
  const publishObservation = (name, value) => {
    if (name === "keyboardFocus") (observation.keyboardFocus ??= []).push(value);
    else observation[name] = value;
    sequence.phase = `${name}-observed`;
  };
  let context;
  let page;
  let documentAttestation;
  let primaryError;
  try {
    context = await newCovenantContext(browser, { viewport, language: "en" });
    page = await context.newPage();
    sequence.phase = "document-navigation";
    documentAttestation = createDocumentAttestation(page);
    await verifyExpectedSha(page);
    const response = await runNavigationOperation(page, () => page.goto(covenantUrl("/m"), {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT_MS,
    }));
    const documentProof = await documentAttestation.bind(response);
    sequence.documentSha = documentProof?.sha ?? null;
    sequence.phase = "welcome-ready";
    await waitForShell(page);
    await waitForLanguage(page, "en");
    const initialToken = await documentAttestation.beginObservation("welcome keyboard sequence");
    const welcome = page.locator(".demo-welcome-layer");
    await welcome.waitFor({ state: "visible", timeout: TIMEOUT_MS });
    documentAttestation.assertObservation(initialToken, "welcome visibility");
    publishObservation("initial", await page.evaluate(collectWelcomeSurface));
    documentAttestation.assertObservation(initialToken, "welcome initial collection");
    sequence.phase = "welcome-dismissal";

    // Dismiss by keyboard: the record's focus covenant is specifically about
    // a dismissal that would otherwise strand focus on document.body.
    const primary = welcome.locator(".demo-welcome__actions .dialog-primary, .dialog-primary").first();
    await primary.focus();
    documentAttestation.assertObservation(initialToken, "welcome primary focus");
    await primary.press("Enter");
    documentAttestation.assertObservation(initialToken, "welcome primary activation");
    await welcome.waitFor({ state: "detached", timeout: TIMEOUT_MS }).catch(async () => {
      await welcome.waitFor({ state: "hidden", timeout: TIMEOUT_MS });
    });
    documentAttestation.assertObservation(initialToken, "welcome dismissal");
    await page.locator(".demo-hat-selector__menu").waitFor({ state: "visible", timeout: TIMEOUT_MS });
    documentAttestation.assertObservation(initialToken, "welcome hat menu visibility");
    publishObservation("afterDismissal", await page.evaluate(collectWelcomeSurface));
    documentAttestation.assertObservation(initialToken, "welcome dismissal collection");

    // Escape must close the intro and return focus to the Switch-hat trigger —
    // the record's "predictable focus destination". Measured before any hat is
    // selected so the assertion is about Escape alone.
    sequence.phase = "escape-menu-dismissal";
    await page.keyboard.press("Escape");
    documentAttestation.assertObservation(initialToken, "welcome Escape activation");
    await page.locator(".demo-hat-selector__menu").waitFor({ state: "hidden", timeout: TIMEOUT_MS });
    documentAttestation.assertObservation(initialToken, "welcome Escape dismissal");
    publishObservation("afterEscape", await page.evaluate(collectWelcomeSurface));
    documentAttestation.assertObservation(initialToken, "welcome Escape collection");
    sequence.phase = "keyboard-activation";

    // Each activation key runs in a fresh welcome/intro context. The helper
    // measures focus through real keyboard navigation before accepting a hat.
    const { afterRetoggle, afterCoordinator, keyboard } = await observeKeyboardHatActivation(
      page, { activationKey }, { documentAttestation, observationToken: initialToken, publishObservation },
    );
    documentAttestation.assertObservation(initialToken, "welcome keyboard sequence collection");
    await waitForShell(page);
    documentAttestation.assertObservation(initialToken, "welcome keyboard sequence shell");

    Object.assign(observation, { afterRetoggle, afterCoordinator, keyboard });
    sequence.phase = "reload";
    const reloadResponse = await runNavigationOperation(page, () => page.reload({
      waitUntil: "domcontentloaded", timeout: TIMEOUT_MS,
    }));
    await documentAttestation.bind(reloadResponse);
    await waitForShell(page);
    await dismissWelcome(page);
    // The intro is once-only. Give the reloaded shell the same settle window
    // the first visit had, so "did not replay" is a measured absence rather
    // than a race against hydration.
    await settleVisualAuditSurface(page, TIMEOUT_MS, { expectWelcome: false });
    const reloadToken = await documentAttestation.beginObservation("welcome reload");
    publishObservation("afterReload", await page.evaluate(collectWelcomeSurface));
    documentAttestation.assertObservation(reloadToken, "welcome reload collection");

    // Phone surface must NOT receive the demo-only hat focus handoff: the hat
    // switcher is a desktop feature and must be absent on the phone shell.
    sequence.phase = "phone-isolation";
    publishObservation("phone", await observePhoneFocusIsolation(browser));
    // A non-SAMPLE surface (no ?demo=1) must never mount the demo welcome/hat
    // layer at all — the SaaS clause of the accessibility acceptance.
    sequence.phase = "saas-isolation";
    publishObservation("saas", await observeNonDemoFocusIsolation(browser));
    const findings = classifyWelcomeSequence(observation, {
      viewport,
      expectedHatLabels: [...DEMO_CHROME_EXPECTED_HAT_LABELS],
    });
    sequence.findings = findings;
    documentAttestation.assertObservation(reloadToken, "welcome sequence finding publication", findings);
    report.sequence ??= sequence;
    report.findings.push(...findings);
    sequence.phase = "success-screenshot";
    await runScreenshotOperation(page, () => page.screenshot({
      path: join(artifactDir, `welcome-sequence-${activationKey.toLowerCase()}.png`), fullPage: false,
    }), findings);
    documentAttestation.assertObservation(reloadToken, "welcome sequence screenshot publication", findings);
    sequence.status = findings.length > 0 ? "failed" : "passed";
  } catch (error) {
    primaryError = error;
    sequence.status = "failed";
    sequence.error = covenantErrorDetails(error);
    if (page) {
      try {
        // Failure observations are diagnostic, not independently attested
        // coverage rows. Keep the last measured state even if capture fails.
        observation.atFailure = await page.evaluate(collectWelcomeSurface);
      } catch (diagnosticError) {
        attachCovenantSecondaryError(error, "failure-observation", diagnosticError);
      }
      try {
        const path = join(artifactDir, `welcome-sequence-${activationKey.toLowerCase()}-failure.png`);
        await page.screenshot({ path, fullPage: false, timeout: Math.min(2000, TIMEOUT_MS) });
        sequence.failureScreenshot = path;
      } catch (screenshotError) {
        attachCovenantSecondaryError(error, "failure-screenshot", screenshotError);
      }
    }
  } finally {
    try {
      if (context) await closeCovenantContext(context, primaryError, documentAttestation);
    } catch (error) {
      primaryError = error;
    }
    if (primaryError) {
      sequence.status = "failed";
      sequence.error ??= covenantErrorDetails(primaryError);
      sequence.secondaryErrors = primaryError.covenantSecondaryErrors ?? [];
    }
  }
  // A cleanup failure on an otherwise successful case must also fail.
  if (primaryError) throw primaryError;
  sequence.phase = "complete";
}

// The phone shell (390x844) renders the SAMPLE demo welcome, but the desktop
// hat switcher must not exist there and focus must never be handed to it. A
// phone surface that mounted the switcher, or whose focus landed on a hat
// trigger, is the "phone surfaces do not receive unexpected focus" regression.
export async function observePhoneFocusIsolation(browser) {
  const viewport = { name: "phone-390x844", width: 390, height: 844 };
  const context = await newCovenantContext(browser, { viewport, language: "en" });
  let documentAttestation;
  let primaryError;
  try {
    const page = await context.newPage();
    documentAttestation = createDocumentAttestation(page);
    const response = await runNavigationOperation(page, () => page.goto(covenantUrl("/m"), {
      waitUntil: "domcontentloaded", timeout: TIMEOUT_MS,
    }));
    const documentProof = await documentAttestation.bind(response);
    await waitForShell(page);
    await dismissWelcome(page);
    await settleVisualAuditSurface(page, TIMEOUT_MS, { expectWelcome: false });
    const observationToken = await documentAttestation.beginObservation("phone focus isolation");
    const surface = await page.evaluate(collectWelcomeSurface);
    documentAttestation.assertObservation(observationToken, "phone focus isolation publication");
    return {
      viewport,
      documentSha: documentProof?.sha ?? null,
      hatSelectorPresent: Number(surface.hatMenuCount ?? 0) > 0 || Number(surface.triggerCount ?? 0) > 0,
      activeElementIsTrigger: surface.activeElementIsTrigger === true,
      welcomeFocusHandoff: surface.activeElementIsTrigger === true,
      activeElement: surface.activeElement ?? null,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await closeCovenantContext(context, primaryError, documentAttestation);
  }
}

// Use the actual SaaS origin for hosted proof. Removing ?demo=1 from SAMPLE
// cannot change the host boundary. The isolated local harness is the only
// same-origin exception and must leave VITE_APP_SURFACE unset.
async function observeNonDemoFocusIsolation(browser) {
  const viewport = { name: "desktop-1440x900", width: 1440, height: 900 };
  const targetUrl = nonDemoCovenantUrl(baseUrl, process.env.DEMO_COVENANT_SAAS_BASE_URL);
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  });
  let documentAttestation;
  let primaryError;
  try {
    const page = await context.newPage();
    documentAttestation = createDocumentAttestation(page, targetUrl);
    const response = await runNavigationOperation(page, () => page.goto(targetUrl, {
      waitUntil: "domcontentloaded", timeout: TIMEOUT_MS,
    }));
    const documentProof = await documentAttestation.bind(response);
    await page.locator("main, [role='main'], form").first().waitFor({ state: "visible", timeout: TIMEOUT_MS });
    // Signed-out SaaS has no member/staff shell; the SAMPLE shell settler would
    // wait for navigation that must never mount on this surface.
    await page.waitForFunction(() => document.fonts.status === "loaded", null, { timeout: TIMEOUT_MS });
    const observationToken = await documentAttestation.beginObservation("non-demo focus isolation");
    const surface = await page.evaluate(collectWelcomeSurface);
    documentAttestation.assertObservation(observationToken, "non-demo focus isolation publication");
    return {
      viewport,
      documentSha: documentProof?.sha ?? null,
      welcomeLayerPresent: Number(surface.welcomeCount ?? 0) > 0,
      hatSelectorPresent: Number(surface.hatMenuCount ?? 0) > 0 || Number(surface.triggerCount ?? 0) > 0,
      activeElementIsTrigger: surface.activeElementIsTrigger === true,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await closeCovenantContext(context, primaryError, documentAttestation);
  }
}

// Export the actual measurement path for browser regression fixtures. Selection,
// navigation and document attestation remain in proveGeometry below.
export async function observeRailGeometry(page, { viewport, language, hat, route, railState }, {
  publishFindings = () => {},
  documentAttestation = null,
  observationToken = null,
} = {}) {
  const assertCurrent = (phase, findings = []) => (
    documentAttestation?.assertObservation(observationToken, phase, findings)
  );
  const expanded = railState === "expanded";
  const expectChapterRail = expanded && viewport.width >= DEMO_CHROME_CHAPTER_LEGIBILITY_MIN_WIDTH;
  const measurement = await page.evaluate(collectDemoChromeGeometry, {
    railLabelSelectors: [...RAIL_LABEL_SELECTORS],
    chapterTextSelectors: [...CHAPTER_TEXT_SELECTORS],
    chapterNameSelector: ".chapter-rail__name",
    chapterMetaSelector: ".chapter-rail__meta",
    chapterRowSelector: ".chapter-rail__row",
    workTabGroupSelector: WORK_TAB_GROUP_SELECTOR,
    expectChapterRail,
    expectedChapterCount: DEMO_CHROME_EXPECTED_CHAPTER_COUNT,
    ...(route === "/m/tasks" ? { expectWorkTabs: true } : { expectWorkTabs: false }),
  });
  assertCurrent("rail geometry collection");
  const context = { viewport, language, railState, hat: hat.key, route, expectedMinLabels: hat.minControls };
  const findings = classifyDemoChromeGeometry(measurement, context)
    // Only the deliberate collapsed-label absence is exempt; every rendered
    // label, Work toolbar and page overflow still runs through the classifier.
    .filter((entry) => expanded || entry.rule !== DEMO_CHROME_COVENANT_RULES.RAIL_LABELS_MISSING);
  // This callback is synchronous by contract. Once classification has happened,
  // durable report publication precedes the Steward destination read (or any
  // other await) so a discarded context cannot erase observed evidence.
  assertCurrent("rail geometry finding publication", findings);
  publishFindings(findings);
  assertCurrent("rail geometry post-finding publication", findings);
  let destinations = null;
  if (hat.key === "steward") {
    try {
      destinations = await runTargetBoundOperation(page, () => page.evaluate(collectRailDestinations, {
        railSelector: "nav.desktop-rail", appointmentsHref: DEMO_CHROME_APPOINTMENTS_HREF,
      }), findings);
      assertCurrent("rail destination collection", findings);
      const destinationFindings = classifyRailDestinations(destinations, {
        ...context,
        requiredDestinations: [...DEMO_CHROME_STEWARD_REQUIRED_DESTINATIONS],
        expectedMinDestinations: DEMO_CHROME_STEWARD_MIN_DESTINATIONS,
        appointmentsHref: DEMO_CHROME_APPOINTMENTS_HREF,
      });
      findings.push(...destinationFindings);
      assertCurrent("rail destination finding publication", findings);
      publishFindings(destinationFindings);
      assertCurrent("rail destination post-finding publication", findings);
      if (expanded && destinations.appointmentsSplitWords?.length > 0) {
        const wordBreakFinding = { ...context, rule: DEMO_CHROME_COVENANT_RULES.RAIL_LABEL_INTRA_WORD_BREAK,
          detail: `Appointments label breaks inside ${JSON.stringify(destinations.appointmentsSplitWords)}`,
          label: destinations.appointmentsLabel, splitWords: destinations.appointmentsSplitWords };
        findings.push(wordBreakFinding);
        assertCurrent("rail destination word-break publication", findings);
        publishFindings([wordBreakFinding]);
        assertCurrent("rail destination post-word-break publication", findings);
      }
    } catch (error) {
      throw attachCovenantFindings(error, findings);
    }
  }
  assertCurrent("rail geometry surface publication", findings);
  return {
    route, viewport, language, hat: hat.key, railState, check: "geometry",
    railLabelCount: measurement.railLabels?.length ?? 0,
    workTabCount: measurement.workTabs?.measurements?.length ?? 0,
    chapterTextCount: measurement.chapterTexts?.length ?? 0,
    chapterRowCount: measurement.chapterRows?.length ?? 0,
    chapterNameCount: measurement.chapterNames?.length ?? 0,
    chapterMetaCount: measurement.chapterMetas?.length ?? 0,
    chapterLegibilityAsserted: expectChapterRail,
    workTabsRendered: measurement.workTabs?.rendered ?? null,
    workTabsFit: measurement.workTabs?.fits ?? null,
    ...(destinations ? { destinationCount: destinations.destinationHrefs?.length ?? 0,
      appointmentsPresent: destinations.appointmentsPresent === true,
      appointmentsLabel: destinations.appointmentsLabel ?? null } : {}),
    findings,
  };
}

async function openGeometryPage(browser, { viewport, language }) {
  const context = await newCovenantContext(browser, { viewport, language });
  try {
    const page = await context.newPage();
    const documentAttestation = createDocumentAttestation(page);
    const response = await runNavigationOperation(page, () => page.goto(covenantUrl("/m"), {
      waitUntil: "domcontentloaded", timeout: TIMEOUT_MS,
    }));
    await documentAttestation.bind(response);
    await waitForShell(page);
    await waitForLanguage(page, language);
    await dismissWelcome(page);
    await closeHatMenu(page);
    return { context, page, documentAttestation, completedCases: 0, viewport: { ...viewport } };
  } catch (error) {
    await closeCovenantContext(context, error);
    throw error;
  }
}

async function resetGeometryDocument(opened, { language, viewport }) {
  if (opened.viewport.width !== viewport.width || opened.viewport.height !== viewport.height) {
    await runTargetBoundOperation(opened.page, () => opened.page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    }));
    opened.viewport = { ...viewport };
  }
  const response = await runNavigationOperation(opened.page, () => opened.page.goto(covenantUrl("/m"), {
    waitUntil: "domcontentloaded", timeout: TIMEOUT_MS,
  }));
  await opened.documentAttestation.bind(response);
  await waitForShell(opened.page);
  await waitForLanguage(opened.page, language);
  await dismissWelcome(opened.page);
  await closeHatMenu(opened.page);
}

async function proveGeometryOnPage(page, report, documentAttestation, { viewport, language, hat, route }) {
  const surfaces = [];
  const attemptFindings = [];
  const publishFindings = (findings) => {
    if (!Array.isArray(findings) || findings.length === 0) return;
    attemptFindings.push(...findings);
    report.findings.push(...findings);
  };
  try {
    await closeHatMenu(page);
    if (route === "/m/tasks") await openChapterWork(page, language);
    else await selectHat(page, hat.key, hat.labels[language], hat.route);
    await settleVisualAuditSurface(page, TIMEOUT_MS, { expectWelcome: false });
    await waitForLanguage(page, language);
    const selectedControl = await waitForSelectedHat(page, hat.key, hat.labels[language]);
    const selectedLabel = selectedControl.label;
    if (!selectedControl.selected || new URL(page.url()).pathname !== route) {
      throw new CovenantAssertionError(`Expected explicit ${hat.key}/${language} at ${route}; observed ${selectedLabel} at ${page.url()}`);
    }
    for (const railState of DEMO_CHROME_RAIL_STATES) {
      if (!await setRailState(page, railState)) {
        throw new CovenantAssertionError(`The ${hat.key} rail could not enter ${railState}`);
      }
      await settleVisualAuditSurface(page, TIMEOUT_MS, { expectWelcome: false });
      const observationToken = await documentAttestation.beginObservation(`${railState} rail geometry`);
      const row = await observeRailGeometry(page, { viewport, language, hat, route, railState }, {
        publishFindings, documentAttestation, observationToken,
      });
      await runScreenshotOperation(page, () => page.screenshot({
        path: join(artifactDir, `${viewport.name}-${language}-${hat.key}-${route === "/m/tasks" ? "work" : "desk"}-${railState}.png`),
        fullPage: false,
      }), attemptFindings);
      documentAttestation.assertObservation(observationToken, `${railState} screenshot publication`, attemptFindings);
      surfaces.push({ ...row, documentSha: observationToken.proof?.sha ?? null, selectedLabel });
    }
    if (viewport.name === DEMO_CHROME_SHORT_HEIGHT_VIEWPORT_NAME) {
      if (!await setRailState(page, "expanded")) {
        throw new CovenantAssertionError(`The ${hat.key} short rail could not expand`);
      }
      const observationToken = await documentAttestation.beginObservation("short-height controls");
      const controls = await measureShortHeightControls(
        page, documentAttestation, observationToken, attemptFindings,
      );
      const findings = classifyShortHeightControls(controls, {
        viewport, language, railState: "expanded", hat: hat.key, route,
        expectedMinControls: hat.minControls,
      });
      documentAttestation.assertObservation(observationToken, "short-height finding publication", findings);
      publishFindings(findings);
      documentAttestation.assertObservation(observationToken, "short-height surface publication", attemptFindings);
      surfaces.push({ route, viewport, language, hat: hat.key, railState: "expanded",
        check: "short-height-controls", documentSha: observationToken.proof?.sha ?? null,
        controlCount: controls.length, controls, findings });
    }
    // Attempt-local surfaces reach the report only after every measurement and
    // capture finishes. Findings above are already durable if a retry is needed.
    report.surfaces.push(...surfaces);
  } catch (error) {
    if (error instanceof CovenantAssertionError || error instanceof CovenantTransientRunnerError) {
      throw attachCovenantFindings(error, attemptFindings);
    }
    if (isTypedTargetClosedError(error, page)) {
      throw new CovenantTransientRunnerError("target-closed", error, attemptFindings);
    }
    throw attachCovenantFindings(error, attemptFindings);
  }
}

export async function proveGeometry(browser, report, geometryCase) {
  const opened = await openGeometryPage(browser, geometryCase);
  let primaryError;
  try {
    await proveGeometryOnPage(opened.page, report, opened.documentAttestation, geometryCase);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await closeCovenantContext(opened.context, primaryError, opened.documentAttestation);
  }
}

// Keep one isolated browser context per language slice, but start each case
// from a newly navigated and attested /m document. Cases are grouped by persona
// in main(), so viewport changes do not mint another SAMPLE magic-link session.
// This retains language/session setup without allowing React state or an
// earlier document proof to leak across cases. A classified runner failure
// discards that context before the one allowed retry; covenant errors stop once.
export async function proveGeometryCases(browser, report, geometryCases) {
  let opened = null;
  let primaryError;
  try {
    for (const geometryCase of geometryCases) {
      const { viewport, language, hat, route } = geometryCase;
      report.activeCase = { kind: "geometry", viewport, language, hat: hat.key, route, phase: "geometry-case" };
      (report.geometryCasesStarted ??= []).push({ viewport, language, hat: hat.key, route });
      await runCovenantCaseWithRetry(async () => {
        if (opened && expectedSha && !opened.documentAttestation.supportsNavigationEvents) {
          await closeCovenantContext(opened.context, null, opened.documentAttestation);
          opened = null;
        }
        opened ??= await openGeometryPage(browser, geometryCase);
        try {
          if (opened.completedCases > 0) await resetGeometryDocument(opened, geometryCase);
          await proveGeometryOnPage(opened.page, report, opened.documentAttestation, geometryCase);
          opened.completedCases += 1;
        } catch (error) {
          await closeCovenantContext(opened.context, error, opened.documentAttestation);
          opened = null;
          throw error;
        }
      }, { onRetry: (error, attempt, classification) => report.caseRetries.push({
        kind: "geometry", viewport: geometryCase.viewport.name,
        language: geometryCase.language, hat: geometryCase.hat.key,
        route: geometryCase.route, attempt, classification,
        error: summarizeCovenantError(error),
        secondaryErrors: error.covenantSecondaryErrors ?? [],
        accumulatedFindingRules: (error.covenantFindings ?? []).map((finding) => finding.rule),
      }) });
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (opened) {
      await closeCovenantContext(opened.context, primaryError, opened.documentAttestation);
    }
  }
}

async function main() {
  const report = {
    status: "running",
    baseUrl,
    expectedSha: expectedSha || null,
    startedAt: new Date().toISOString(),
    viewports: DEMO_CHROME_COVENANT_VIEWPORTS,
    languages: DEMO_CHROME_COVENANT_LANGUAGES,
    hats: DEMO_CHROME_COVENANT_HATS,
    railStates: DEMO_CHROME_RAIL_STATES,
    languageProjection: "read-only-member-profile-response",
    sequence: null,
    keyboardSequences: [],
    caseRetries: [],
    geometryCasesStarted: [],
    surfaces: [],
    findings: [],
  };
  let browser;
  try {
    await mkdir(artifactDir, { recursive: true });
    browser = await chromium.launch({ headless: true });
    for (const activationKey of ["Enter", "Space"]) {
      await proveWelcomeSequence(browser, report, activationKey);
    }
    const geometryCases = demoChromeGeometryCases();
    const personaOrder = new Map(["steward", "member", "coordinator", "advisor", "admin", "vp"]
      .map((hat, index) => [hat, index]));
    for (const language of DEMO_CHROME_COVENANT_LANGUAGES) {
      const languageCases = geometryCases.filter((entry) => entry.language === language)
        .sort((left, right) => (
          personaOrder.get(left.hat.key) - personaOrder.get(right.hat.key)
          || Number(left.route === "/m/tasks") - Number(right.route === "/m/tasks")
        ));
      await proveGeometryCases(browser, report, languageCases);
    }
  } catch (error) {
    const { kind, activationKey, viewport, language, route, phase } = report.activeCase ?? {};
    report.executionFailure = {
      kind: kind ?? "runner", activationKey, viewport, language, route, phase: phase ?? "startup",
      error: covenantErrorDetails(error), secondaryErrors: error.covenantSecondaryErrors ?? [],
    };
    report.findings.push({
      rule: "covenant-runner-error",
      viewport: null,
      language: null,
      railState: null,
      detail: summarizeCovenantError(error, 1200),
    });
  } finally {
    await browser?.close().catch((error) => {
      const secondary = { phase: "browser-close", ...covenantErrorDetails(error) };
      if (report.executionFailure) report.executionFailure.secondaryErrors.push(secondary);
      else report.findings.push({ rule: "covenant-runner-error", detail: `Browser cleanup: ${secondary.detail}` });
    });
    delete report.activeCase;
    report.findings.push(...classifyCovenantCoverage(report));
    report.coverage = summarizeCovenantCoverage(report);
    report.finishedAt = new Date().toISOString();
    report.summary = summarizeCovenantFindings(report.findings);
    report.status = report.findings.length > 0 ? "failed" : "passed";
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, "demo-chrome-covenant.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(artifactDir, "demo-chrome-covenant.md"), `${renderCovenantMarkdown(report)}\n`);
  }

  console.log(`DEMO_COVENANT_ARTIFACT=${artifactDir}`);
  console.log(`DEMO_COVENANT_STATUS=${report.status}`);
  if (report.findings.length > 0) {
    for (const line of renderCovenantFailureLines(report)) console.error(line);
  }
  process.exitCode = report.findings.length > 0 ? 1 : 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();

export { main };
