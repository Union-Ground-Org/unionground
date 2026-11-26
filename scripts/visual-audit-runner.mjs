import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  applyVisualBaseline,
  classifyVisualMeasurements,
  collectVisualMeasurements,
  renderVisualAuditMarkdown,
  settleVisualAuditSurface,
} from "./visual-audit.mjs";
import { resolveVisualAuditViewports } from "./visual-audit-presets.mjs";
import {
  DEFAULT_VISUAL_AUDIT_ROUTES,
  visualAuditRouteContract,
} from "./visual-audit-route-contracts.mjs";
import {
  assertLoadedBuildDocument,
  assertPageOrigin,
  loadedBuildDocumentSha,
} from "./lib/browserbase-target-policy.mjs";
import { selectVisibleHatControl } from "./lib/visual-audit-hat-control.mjs";
import {
  appAssetPath,
  assetFailureBuilds,
  collectTearEvidence,
  describeRouteModuleFailure,
  failedDynamicImportUrl,
  observeAssetFailureBuild,
  readBuildInfoResponse,
  routeModuleBuildSha,
  routeModuleFailures,
} from "./lib/visual-audit-tear-evidence.mjs";
import {
  createTargetRuntimeBoundary,
  describeRuntimeHttpFailure,
  describeRuntimeNetworkFailure,
  isGenericResourceConsoleError,
} from "./lib/visual-audit-runtime-boundary.mjs";

const VIEWPORTS = resolveVisualAuditViewports();

const DEFAULT_ROUTES = DEFAULT_VISUAL_AUDIT_ROUTES;
// The default eight are the routes the nightly gate can afford to hold green.
// Covenant proof needs more: a record about the admin console or the rewards
// economy is not proven by auditing /m/cases. Rather than let each session
// hand-roll its own runner copy (and lose the baseline, the SHA gate and the
// artifact format with it), let the caller name the routes and keep every
// other guarantee identical.
const ROUTE_TIMEOUT_MS = Number.parseInt(process.env.VISUAL_AUDIT_ROUTE_TIMEOUT_MS || "30000", 10);

if (!Number.isFinite(ROUTE_TIMEOUT_MS) || ROUTE_TIMEOUT_MS < 1) {
  throw new Error("VISUAL_AUDIT_ROUTE_TIMEOUT_MS must be a positive integer");
}
const FIXTURE_EXPECTED_RULES = new Set([
  "small-target",
  "element-collision",
  "clipped-interactive",
  "dialog-viewport",
  "fixed-obstruction",
]);
const INITIAL_STEWARD_DESK_RPCS = [
  "list_steward_requests",
  "list_steward_conversations",
  "list_steward_broadcasts",
  "list_steward_forms",
  "get_steward_desk_kpis",
];
const SQLSTATE = /^[0-9A-Z]{5}$/;
const STEWARD_DESK_FAILURE_PRIORITY = Object.freeze({
  "http-failed": 5,
  "postgres-failed": 5,
  "network-failed": 5,
  timeout: 4,
  pending: 3,
  duplicate: 3,
  malformed: 3,
  missing: 1,
});
const initialStewardDeskCaptureByPage = new WeakMap();
const runFixture = process.argv.includes("--fixture");
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureUrl = pathToFileURL(resolve(scriptDirectory, "../tests/fixtures/visual-audit.html")).href;
const baseUrl = runFixture ? fixtureUrl : process.env.VISUAL_AUDIT_BASE_URL || "http://127.0.0.1:4173";
const expectedSha = process.env.VISUAL_AUDIT_EXPECTED_SHA || "";
const artifactDir = process.env.VISUAL_AUDIT_ARTIFACT_DIR || join(process.cwd(), "artifacts", "visual-audit");
const baselinePath = process.env.VISUAL_AUDIT_BASELINE_PATH
  || resolve(process.cwd(), "config", "visual-audit-baseline.json");

export function resolveInitialStewardDeskProofMode({ requestedMode = "", targetUrl } = {}) {
  const mode = String(requestedMode || "required").trim().toLowerCase();
  if (mode === "required") return Object.freeze({ mode: "required", initialBatch: null });
  if (mode !== "credential-free-preview") {
    throw new Error("VISUAL_AUDIT_STEWARD_DESK_PROOF must be required or credential-free-preview");
  }

  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    throw new Error("credential-free-preview Steward desk proof mode requires an HTTP loopback target");
  }
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (target.protocol !== "http:" || !loopbackHosts.has(target.hostname.toLowerCase())) {
    throw new Error("credential-free-preview Steward desk proof mode requires an HTTP loopback target");
  }
  return Object.freeze({
    mode: "credential-free-preview",
    initialBatch: Object.freeze({
      status: "not-applicable",
      reason: "credential-free-preview",
    }),
  });
}

const initialStewardDeskProofMode = resolveInitialStewardDeskProofMode({
  requestedMode: process.env.VISUAL_AUDIT_STEWARD_DESK_PROOF,
  targetUrl: baseUrl,
});

function finiteTimestamp(value, now) {
  return Number.isFinite(value) ? value : now();
}

function roundedDuration(startedAt, completedAt) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) return null;
  return Math.ceil(completedAt - startedAt);
}

function sanitizePostgresCode(value) {
  return typeof value === "string" && SQLSTATE.test(value) ? value : null;
}

function isResponseCompletionError(value) {
  return value instanceof Error || (value !== null && typeof value === "object" && typeof value.message === "string");
}

function waitForCompletionWithinTimeout(completion, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: "timed-out" }), timeoutMs);
    Promise.resolve(completion).then(
      (value) => finish({ status: isResponseCompletionError(value) ? "failed" : "complete", value }),
      () => finish({ status: "failed" }),
    );
  });
}

export function createInitialStewardDeskBatchTracker({ thresholdMs = 8000, now = Date.now } = {}) {
  const attemptsByRpc = new Map(INITIAL_STEWARD_DESK_RPCS.map((rpc) => [rpc, []]));
  const attemptsByRequest = new Map();
  let frozen = null;

  function observeRequest({ requestKey, rpc, atMs } = {}) {
    if (frozen || !attemptsByRpc.has(rpc) || requestKey === undefined || attemptsByRequest.has(requestKey)) return;
    const attempt = {
      startedAt: finiteTimestamp(atMs, now),
      durationMs: null,
      httpStatus: null,
      postgresCode: null,
      state: "pending",
    };
    attemptsByRequest.set(requestKey, attempt);
    attemptsByRpc.get(rpc).push(attempt);
  }

  function observeResponse({ requestKey, atMs, httpStatus, postgresCode } = {}) {
    if (frozen) return;
    const attempt = attemptsByRequest.get(requestKey);
    if (!attempt) return;
    if (attempt.state !== "pending") {
      attempt.state = "malformed";
      return;
    }
    attempt.durationMs = roundedDuration(attempt.startedAt, finiteTimestamp(atMs, now));
    attempt.httpStatus = Number.isInteger(httpStatus) ? httpStatus : null;
    attempt.postgresCode = sanitizePostgresCode(postgresCode);
    attempt.state = "responded";
  }

  function observeRequestFailed({ requestKey, atMs } = {}) {
    if (frozen) return;
    const attempt = attemptsByRequest.get(requestKey);
    if (!attempt || attempt.state !== "pending") return;
    attempt.durationMs = roundedDuration(attempt.startedAt, finiteTimestamp(atMs, now));
    attempt.state = "network-failed";
  }

  function summarize(rpc) {
    const attempts = attemptsByRpc.get(rpc);
    if (attempts.length === 0) {
      return { rpc, attempts: 0, durationMs: null, httpStatus: null, postgresCode: null, outcome: "missing" };
    }
    if (attempts.length !== 1) {
      return { rpc, attempts: attempts.length, durationMs: null, httpStatus: null, postgresCode: null, outcome: "duplicate" };
    }
    const attempt = attempts[0];
    if (attempt.state === "pending") {
      return { rpc, attempts: 1, durationMs: null, httpStatus: null, postgresCode: null, outcome: "pending" };
    }
    if (attempt.state === "network-failed") {
      return { rpc, attempts: 1, durationMs: attempt.durationMs, httpStatus: null, postgresCode: null, outcome: "network-failed" };
    }
    if (attempt.state !== "responded" || attempt.durationMs === null || attempt.httpStatus === null) {
      return { rpc, attempts: 1, durationMs: null, httpStatus: null, postgresCode: null, outcome: "malformed" };
    }
    if (attempt.httpStatus !== 200) {
      return { rpc, attempts: 1, durationMs: attempt.durationMs, httpStatus: attempt.httpStatus, postgresCode: attempt.postgresCode, outcome: "http-failed" };
    }
    if (attempt.postgresCode !== null) {
      return { rpc, attempts: 1, durationMs: attempt.durationMs, httpStatus: attempt.httpStatus, postgresCode: attempt.postgresCode, outcome: "postgres-failed" };
    }
    if (attempt.durationMs >= thresholdMs) {
      return { rpc, attempts: 1, durationMs: attempt.durationMs, httpStatus: attempt.httpStatus, postgresCode: null, outcome: "timeout" };
    }
    return { rpc, attempts: 1, durationMs: attempt.durationMs, httpStatus: attempt.httpStatus, postgresCode: null, outcome: "passed" };
  }

  return {
    observeRequest,
    observeResponse,
    observeRequestFailed,
    finalize() {
      if (frozen) return frozen;
      const calls = INITIAL_STEWARD_DESK_RPCS.map(summarize);
      frozen = {
        status: calls.every((call) => call.outcome === "passed") ? "passed" : "failed",
        thresholdMs,
        calls,
      };
      return frozen;
    },
  };
}

export function createInitialStewardDeskRuntimeCapture({
  belongsToCurrentTarget,
  thresholdMs = 8000,
  now = Date.now,
  waitForResponseCompletion = async (response) => response?.finished?.(),
  raceWithTimeout = waitForCompletionWithinTimeout,
  responseCompletedAt = now,
  readPostgresCode = async () => null,
} = {}) {
  let tracker = null;
  const pendingResponses = new Set();

  function ownsCurrentRequest(requestKey) {
    return tracker !== null && belongsToCurrentTarget(requestKey);
  }

  return {
    arm() {
      tracker = createInitialStewardDeskBatchTracker({ thresholdMs, now });
      return tracker;
    },
    observeRequest({ requestKey, rpc, atMs } = {}) {
      if (!ownsCurrentRequest(requestKey)) return;
      tracker.observeRequest({ requestKey, rpc, atMs });
    },
    observeResponse({ requestKey, httpStatus, response } = {}) {
      if (!ownsCurrentRequest(requestKey)) return Promise.resolve();
      const targetTracker = tracker;
      const work = (async () => {
        const failClosed = () => {
          try {
            if (tracker === targetTracker && belongsToCurrentTarget(requestKey)) {
              targetTracker.observeRequestFailed({ requestKey, atMs: now() });
            }
          } catch {
            // The event is obsolete or malformed; leave no mutable evidence.
          }
        };
        let postgresCode = null;
        try {
          const completion = await raceWithTimeout(waitForResponseCompletion(response), thresholdMs);
          if (completion?.status !== "complete") {
            failClosed();
            return;
          }
          if (httpStatus !== 200) {
            const parsedCode = await raceWithTimeout(readPostgresCode(response), thresholdMs);
            if (parsedCode?.status !== "complete") {
              failClosed();
              return;
            }
            postgresCode = sanitizePostgresCode(parsedCode.value);
          }
        } catch {
          failClosed();
          return;
        }
        let atMs;
        try {
          atMs = finiteTimestamp(responseCompletedAt(response), now);
        } catch {
          atMs = now();
        }
        try {
          if (tracker === targetTracker && belongsToCurrentTarget(requestKey)) {
            targetTracker.observeResponse({ requestKey, atMs, httpStatus, postgresCode });
          }
        } catch {
          // A changed runtime generation must fail closed without exposing an
          // event-handler error or changing the frozen batch.
        }
      })();
      pendingResponses.add(work);
      void work.then(
        () => pendingResponses.delete(work),
        () => pendingResponses.delete(work),
      );
      return work;
    },
    observeRequestFailed({ requestKey, atMs } = {}) {
      if (!ownsCurrentRequest(requestKey)) return;
      tracker.observeRequestFailed({ requestKey, atMs });
    },
    async finalize() {
      await Promise.allSettled([...pendingResponses]);
      return tracker?.finalize() ?? null;
    },
  };
}

export function attachInitialStewardDeskBatch(surface, initialStewardDeskBatch, { route, viewport } = {}) {
  const batch = initialStewardDeskBatch ?? null;
  const diagnosis = summarizeInitialStewardDeskFailure(batch, {
    inspected: surface.inspected,
    routeError: surfaceHasRouteError(surface),
  });
  const findings = batch?.status === "failed"
    ? [{
      ...runtimeFailure(route, viewport, "steward-desk-performance", diagnosis.message),
      diagnostic_type: "prerequisite",
      root_cause: diagnosis.rootCause,
      consequences: diagnosis.consequences,
    }]
    : [];
  return {
    surface: { ...surface, initialStewardDeskBatch: batch },
    findings,
  };
}

export function summarizeInitialStewardDeskFailure(batch, { inspected, routeError } = {}) {
  const failedCalls = (batch?.calls ?? []).filter((call) => call?.outcome !== "passed");
  const rootCause = failedCalls.reduce((best, call) => {
    if (!best) return call;
    return (STEWARD_DESK_FAILURE_PRIORITY[call.outcome] ?? 0)
      > (STEWARD_DESK_FAILURE_PRIORITY[best.outcome] ?? 0) ? call : best;
  }, null);
  const consequences = [];
  if (inspected === undefined || inspected === 0 || routeError) {
    consequences.push("Steward target selection, stable-surface waiting, and visual measurement were not executed");
  }
  const rootDescription = rootCause
    ? `root RPC ${rootCause.rpc} ${rootCause.outcome}`
    : "no mandatory RPC result was captured";
  return {
    rootCause,
    failedCalls,
    consequences,
    message: `Initial Steward desk prerequisite failed: ${rootDescription}`,
  };
}

function surfaceHasRouteError(surface) {
  return (surface?.failures ?? []).some((failure) => failure?.rule === "route-error");
}

function isStewardDeskRelatedFailure(failure, surface) {
  if (failure.rule === "steward-desk-performance") return true;
  if (failure.rule === "route-error") {
    return (surface.initialStewardDeskBatch?.calls ?? []).some((call) =>
      ["http-failed", "postgres-failed", "network-failed", "timeout"].includes(call.outcome));
  }
  if (!["network-error", "http-error", "console-error", "page-error"].includes(failure.rule)) return false;
  return /\/rest\/v1\/rpc\/(?:list_steward_requests|list_steward_conversations|list_steward_broadcasts|list_steward_forms|get_steward_desk_kpis)\b/i
    .test(String(failure.explanation ?? failure.message ?? ""));
}

function stewardDeskRpcLine(prefix, surface, call) {
  const location = `${String(surface.route ?? "unknown")} ${surface.viewport?.width ?? 0}x${surface.viewport?.height ?? 0}`;
  const clean = (value) => String(value ?? "unknown").split(/\r?\n/, 1)[0]
    .split("").filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join("").slice(0, 600);
  return `${prefix} steward-desk-rpc ${clean(location)} rpc=${clean(call.rpc)} http=${call.httpStatus ?? "none"} sqlstate=${sanitizePostgresCode(call.postgresCode) ?? "none"} durationMs=${call.durationMs ?? "none"} outcome=${clean(call.outcome)}`;
}

export function renderVisualAuditFailureLines(auditReport) {
  const singleLine = (value) => String(value ?? "unknown").split(/\r?\n/, 1)[0]
    .split("").filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join("").slice(0, 600);
  const location = (entry) => `${singleLine(entry.route)} ${entry.viewport?.width ?? 0}x${entry.viewport?.height ?? 0}`;
  const lines = [];
  const prerequisiteSurfaces = new Set();
  for (const surface of auditReport.surfaces ?? []) {
    if (surface.initialStewardDeskBatch?.status === "failed") {
      prerequisiteSurfaces.add(surface);
      const diagnosis = summarizeInitialStewardDeskFailure(surface.initialStewardDeskBatch, {
        inspected: surface.inspected,
        routeError: surfaceHasRouteError(surface),
      });
      const call = diagnosis.rootCause;
      if (call) {
        lines.push(stewardDeskRpcLine("FAIL", surface, call));
      }
      for (const failedCall of diagnosis.failedCalls) {
        if (failedCall !== call) lines.push(stewardDeskRpcLine("CONSEQUENCE", surface, failedCall));
      }
      for (const consequence of diagnosis.consequences) {
        lines.push(`CONSEQUENCE steward-desk-prerequisite ${location(surface)}: ${singleLine(consequence)}`);
      }
    }
  }
  for (const failure of auditReport.failures ?? []) {
    const prerequisiteSurface = [...prerequisiteSurfaces].find((surface) => surface.failures?.includes(failure)
      || (surface.route === failure.route && surface.viewport?.width === failure.viewport?.width
        && surface.viewport?.height === failure.viewport?.height));
    // Keep prerequisite-causal findings labelled as consequences, while
    // retaining unrelated product/runtime findings as their original FAIL.
    if (prerequisiteSurface && isStewardDeskRelatedFailure(failure, prerequisiteSurface)) {
      if (failure.rule !== "steward-desk-performance") {
        lines.push(`CONSEQUENCE ${singleLine(failure.rule)} ${location(failure)}: ${singleLine(failure.explanation ?? failure.message)}`);
      }
      continue;
    }
    lines.push(`FAIL ${singleLine(failure.rule)} ${location(failure)}: ${singleLine(failure.explanation ?? failure.message)}`);
  }
  return [...lines.slice(0, 40), ...(lines.length > 40 ? [`Further diagnostics retained in JSON: ${lines.length - 40}`] : [])];
}

function initialStewardDeskRpc(request) {
  if (request.method() !== "POST") return null;
  let pathname;
  try {
    pathname = new URL(request.url()).pathname;
  } catch {
    return null;
  }
  for (const rpc of INITIAL_STEWARD_DESK_RPCS) {
    if (pathname === `/rest/v1/rpc/${rpc}`) return rpc;
  }
  return null;
}

function requestStartedAt() {
  // Playwright can expose a provisional zero startTime while the request event
  // is firing. Capture both ends on the runner clock so an early response
  // cannot turn that placeholder into an epoch-sized duration.
  return Date.now();
}

function responseCompletedAt() {
  return Date.now();
}

async function responsePostgresCode(response) {
  try {
    const body = await response.body();
    if (body.byteLength > 65536) return null;
    const parsed = JSON.parse(body.toString("utf8"));
    return sanitizePostgresCode(parsed?.code) || sanitizePostgresCode(parsed?.error?.code);
  } catch {
    return null;
  }
}

function parseRoutes(value) {
  const routes = String(value).split(",").map((route) => route.trim()).filter(Boolean);
  if (!routes.length) throw new Error("VISUAL_AUDIT_ROUTES must name at least one route");
  const baseOrigin = new URL(baseUrl).origin;
  for (const route of routes) {
    let resolved;
    try {
      resolved = new URL(route, baseUrl);
    } catch {
      throw new Error(`VISUAL_AUDIT_ROUTES entries must be same-origin absolute paths, got ${route}`);
    }
    if (!route.startsWith("/") || route.includes("\\") || resolved.origin !== baseOrigin) {
      throw new Error(`VISUAL_AUDIT_ROUTES entries must be same-origin absolute paths, got ${route}`);
    }
  }
  return routes;
}

const routes = process.env.VISUAL_AUDIT_ROUTES ? parseRoutes(process.env.VISUAL_AUDIT_ROUTES) : DEFAULT_ROUTES;

function appendDemoQuery() {
  const value = String(process.env.VISUAL_AUDIT_APPEND_DEMO ?? "1").trim().toLowerCase();
  return value !== "0" && value !== "false";
}

function auditUrl(route) {
  const url = new URL(route, baseUrl);
  if (appendDemoQuery()) url.searchParams.set("demo", "1");
  return url.href;
}

function displayRoute(url) {
  const parsed = new URL(url);
  return parsed.protocol === "file:" ? "/visual-audit-fixture" : parsed.pathname;
}

function screenshotName(viewport, route) {
  const readableRoute = displayRoute(route).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home";
  return `${viewport}-${readableRoute}-viewport.png`;
}

function failureScreenshotName(viewport, route) {
  return screenshotName(viewport, route).replace("-viewport.png", "-failure.png");
}

async function captureScreenshot(page, destination) {
  try {
    await page.screenshot({ path: destination, fullPage: false });
  } catch (error) {
    const message = String(error?.message || error);
    if (!message.includes("Page.captureScreenshot")) throw error;
    await page.waitForTimeout(100);
    await page.screenshot({ path: destination, fullPage: false });
  }
}

function runtimeFailure(route, viewport, rule, message) {
  return {
    rule,
    severity: "failure",
    route,
    viewport: { width: viewport.width, height: viewport.height },
    selector: "document",
    selectors: ["document"],
    rectangles: [],
    explanation: message.slice(0, 120),
    message: message.slice(0, 120),
  };
}

async function waitForAuditShell(page) {
  await page.locator("nav.desktop-rail, .card-nav__panel--home, .home-orb").first()
    .waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
}

async function dismissWelcome(page) {
  const welcome = page.locator(".demo-welcome-layer");
  try {
    await welcome.waitFor({ state: "visible", timeout: Math.min(8000, ROUTE_TIMEOUT_MS) });
  } catch {
    // Later routes in the same page have already dismissed the banner.
  }
  if (await welcome.isVisible().catch(() => false)) {
    await welcome.locator(".demo-welcome__actions .dialog-primary, .dialog-primary").first().click();
    await welcome.waitFor({ state: "hidden", timeout: ROUTE_TIMEOUT_MS });
  }
}

async function waitForStableSurface(page, options = {}) {
  if (runFixture) {
    await page.locator("body").waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
  } else {
    await settleVisualAuditSurface(page, ROUTE_TIMEOUT_MS, {
      expectWelcome: options.expectWelcome ?? !appendDemoQuery(),
    });
  }
}

async function selectHat(page, hat, label, expectedPath, restartTargetRuntimeCapture) {
  const select = page.locator("select").filter({ has: page.locator(`option[value="${hat}"]`) }).first();
  const expandedOption = page.locator("button.desktop-rail__hat-option").filter({ hasText: new RegExp(`^${label}$`) }).first();
  const topOption = page.locator("button.demo-hat-selector__option")
    .filter({ hasText: new RegExp(`^${label}$`) }).first();
  const trigger = page.locator("button.demo-hat-selector__trigger").first();
  // A SAMPLE shell repaint can replace phone, expanded-rail, and desktop
  // controls while persona authentication settles. Re-evaluate every public
  // control under one route deadline rather than committing to a stale layout.
  await selectVisibleHatControl({
    select,
    hat,
    expandedOption,
    option: topOption,
    trigger,
    timeoutMs: ROUTE_TIMEOUT_MS,
    waitForRetry: (delayMs) => page.waitForTimeout(delayMs),
    // Flip ownership only when an actionable control is about to dispatch the
    // persona change. Retrying a not-yet-mounted control still belongs to the
    // source hat, and a failed action reopens a non-target generation before
    // the helper waits again.
    beforeSelectionAttempt: restartTargetRuntimeCapture,
    afterSelectionAttemptFailure: restartTargetRuntimeCapture,
  });
  await page.waitForURL((url) => url.pathname === expectedPath, { timeout: ROUTE_TIMEOUT_MS });
  // A live persona swap temporarily replaces every hat control with the
  // authenticated loading boundary. Wait for that exact account's shell to
  // return before assertSelectedHat probes phone, tablet, or desktop chrome.
  await waitForAuditShell(page);
}

async function selectMemberHat(page, restartTargetRuntimeCapture) {
  await selectHat(page, "member", "Member", "/m", restartTargetRuntimeCapture);
}

async function selectCoordinatorHat(page, restartTargetRuntimeCapture) {
  await selectHat(page, "coordinator", "Coordinator", "/m/coordinator", restartTargetRuntimeCapture);
}

async function assertSelectedHat(page, hat, label) {
  const select = page.locator("select").filter({ has: page.locator(`option[value="${hat}"]`) }).first();
  if (await select.isVisible().catch(() => false)) {
    const actual = await select.inputValue();
    if (actual !== hat) throw new Error(`Hat mismatch: expected ${label} (${hat}); received ${actual || "none"}`);
    return;
  }

  const expandedOption = page.locator("button.desktop-rail__hat-option")
    .filter({ hasText: new RegExp(`^${label}$`) }).first();
  if (await expandedOption.isVisible().catch(() => false)) {
    const pressed = await expandedOption.getAttribute("aria-pressed");
    if (pressed !== "true") throw new Error(`Hat mismatch: ${label} is not active in the desktop rail`);
    return;
  }

  const trigger = page.locator("button.demo-hat-selector__trigger").first();
  await trigger.waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
  const triggerText = (await trigger.innerText()).trim();
  if (triggerText !== label) throw new Error(`Hat mismatch: expected ${label}; received ${triggerText || "none"}`);
}

async function selectedHatMatches(page, hat, label) {
  const select = page.locator("select").filter({ has: page.locator(`option[value="${hat}"]`) }).first();
  if (await select.isVisible().catch(() => false)) return await select.inputValue() === hat;

  const expandedOption = page.locator("button.desktop-rail__hat-option")
    .filter({ hasText: new RegExp(`^${label}$`) }).first();
  if (await expandedOption.isVisible().catch(() => false)) {
    return await expandedOption.getAttribute("aria-pressed") === "true";
  }

  const trigger = page.locator("button.demo-hat-selector__trigger").first();
  if (!await trigger.isVisible().catch(() => false)) return false;
  return (await trigger.innerText()).trim() === label;
}

async function waitForInitialStewardDesk(page) {
  const retry = page.locator(".screen.cwk-screen .cwk-alert button.cwk-btn--green").first();
  await page.locator([
    ".screen.cwk-screen .pkpi-grid",
    ".screen.cwk-screen .cwk-alert button.cwk-btn--green",
  ].join(", ")).first().waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
  if (await retry.isVisible().catch(() => false)) {
    throw new Error("Initial SAMPLE Steward desk failed before target hat selection");
  }
}

async function assertRouteContract(page, route) {
  const contract = visualAuditRouteContract(route);
  if (!contract) return null;
  const currentPath = new URL(page.url()).pathname;
  if (currentPath !== route) throw new Error(`Route mismatch: expected ${route}; received ${currentPath}`);
  await assertSelectedHat(page, contract.hat, contract.hatLabel);
  const landmark = page.locator(contract.landmark);
  await landmark.first().waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
  const landmarkCount = await landmark.count();
  if (landmarkCount !== 1) {
    throw new Error(`Landmark mismatch: expected one ${contract.landmark} for ${route}; received ${landmarkCount}`);
  }
  return {
    hat: contract.hat,
    hatLabel: contract.hatLabel,
    route,
    landmark: contract.landmark,
    landmarkCount,
  };
}

async function navigateWithinSelectedHat(page, url, route) {
  const destination = new URL(url);
  const target = `${destination.pathname}${destination.search}${destination.hash}`;
  // A full document navigation would reboot the SAMPLE entry contract and
  // deliberately seed Steward again. Move through the application's public
  // history boundary instead so the explicitly selected hat remains the
  // identity under which this route is rendered and measured.
  await page.evaluate((target) => {
    globalThis.history.pushState({}, "", target);
    globalThis.dispatchEvent(new globalThis.PopStateEvent("popstate"));
  }, target);
  await page.waitForURL((current) => current.pathname === route, { timeout: ROUTE_TIMEOUT_MS });
  await waitForAuditShell(page);
}

async function attestLoadedVisualDocument(page, response) {
  if (!expectedSha) return null;
  if (!response) throw new Error("Visual audit navigation returned no main-document response");
  const request = response.request();
  if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) {
    throw new Error("Visual audit navigation did not return the loaded main document");
  }
  const expectedOrigin = new URL(baseUrl).origin;
  const [body, contentType] = await Promise.all([
    response.body(),
    response.headerValue("content-type"),
  ]);
  let proof;
  try {
    proof = assertLoadedBuildDocument({
      requestedUrl: request.url(),
      responseUrl: response.url(),
      status: response.status(),
      contentType,
      body,
      redirectedFrom: Boolean(request.redirectedFrom()),
      expectedOrigin,
      expectedSha,
    });
  } catch (error) {
    // Keep the marker the refused document actually carried beside the
    // refusal, so the failed surface can record which build it loaded. This
    // binds nothing: the surface still fails, and only the supersession
    // classifier may later resolve that SHA against Main.
    error.receivedDocumentSha = loadedBuildDocumentSha(body);
    throw error;
  }
  assertPageOrigin(page.url(), expectedOrigin);
  return proof;
}

async function navigateAndAttest(page, url) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: ROUTE_TIMEOUT_MS });
  return attestLoadedVisualDocument(page, response);
}

async function navigateToAuditSurface(page, url, route, restartTargetRuntimeCapture) {
  const {
    armInitialStewardDeskCapture = () => {},
    finalizeInitialStewardDeskCapture = async () => null,
  } = initialStewardDeskCaptureByPage.get(page) ?? {};
  if (runFixture) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: ROUTE_TIMEOUT_MS });
    return null;
  }

  const contract = visualAuditRouteContract(route);
  if (contract?.hat === "member") {
    // SAMPLE first entry is Steward. Always enter through Home, dismiss the
    // welcome layer, and explicitly choose Member before visiting the requested
    // member surface. A direct member URL must never be measured while the
    // staff identity inherited from SAMPLE bootstrap is still active.
    armInitialStewardDeskCapture();
    const documentProof = await navigateAndAttest(page, auditUrl("/m"));
    // SAMPLE first entry is Steward. Dismiss welcome first — the layer
    // isolates Switch role — then wear Member so member routes are not
    // measured as Casework. The caller settles again without expecting
    // welcome a second time.
    await waitForAuditShell(page);
    await dismissWelcome(page);
    if (!await selectedHatMatches(page, contract.hat, contract.hatLabel)) {
      // A fresh SAMPLE visit intentionally starts as Steward. Let its
      // load-bearing desk batch finish before starting Member's own boot; this
      // prevents two organization-wide read bursts from competing for the
      // database timeout while still failing honestly on a broken front door.
      if (await selectedHatMatches(page, "steward", "Steward")) {
        try {
          await waitForInitialStewardDesk(page);
        } finally {
          await finalizeInitialStewardDeskCapture();
        }
      } else {
        await finalizeInitialStewardDeskCapture();
      }
      // Requests already in flight belong to SAMPLE's required initial
      // Steward identity. Start a fresh boundary immediately before the
      // Member choice so their eventual responses cannot poison Member proof.
      await selectMemberHat(page, restartTargetRuntimeCapture);
    }
    await assertSelectedHat(page, contract.hat, contract.hatLabel);
    if (route !== "/m") {
      await navigateWithinSelectedHat(page, url, route);
    }
    return documentProof;
  }

  if (route !== "/m/tasks") {
    const documentProof = await navigateAndAttest(page, url);
    await waitForAuditShell(page);
    await dismissWelcome(page);
    return documentProof;
  }

  // Chapter Work is staff-only. Enter it through the same explicit hat
  // selection a person must make; a cold /m/tasks visit correctly fails
  // closed to Member and must never be used as an implicit role switch.
  armInitialStewardDeskCapture();
  const documentProof = await navigateAndAttest(page, auditUrl("/m"));
  await waitForAuditShell(page);
  await dismissWelcome(page);
  if (await selectedHatMatches(page, "steward", "Steward")) {
    try {
      await waitForInitialStewardDesk(page);
    } finally {
      await finalizeInitialStewardDeskCapture();
    }
  } else {
    await finalizeInitialStewardDeskCapture();
  }
  if (!await selectedHatMatches(page, "coordinator", "Coordinator")) {
    await selectCoordinatorHat(page, restartTargetRuntimeCapture);
  }
  const taskLink = page.locator('a[href^="/m/tasks"]').first();
  if (await taskLink.isVisible().catch(() => false)) await taskLink.click();
  // Phone chrome enters the same route through the coordinator header action.
  // Its accessible name is organization-configurable, so audit the stable
  // control anatomy instead of pinning the default English label.
  else await page.locator("button.gq-action").first().click();
  await page.waitForURL((current) => current.pathname === "/m/tasks", { timeout: ROUTE_TIMEOUT_MS });
  return documentProof;
}

async function verifyExpectedSha(page) {
  if (!expectedSha || runFixture) return;
  const info = await page.request.get(`${baseUrl}/build-info.json`, { headers: { "cache-control": "no-store" } });
  const payload = await info.json();
  if (payload.commitSha !== expectedSha) {
    throw new Error(`Deployment SHA mismatch: expected ${expectedSha}; received ${payload.commitSha}`);
  }
}

async function routeDiagnostic(page, url, error) {
  const diagnostic = { url, error: String(error.message || error).slice(0, 1200) };
  const title = await page.title().catch(() => "");
  const body = await page.locator("body").innerText().catch(() => "");
  if (title) diagnostic.title = title.slice(0, 240);
  if (body) diagnostic.body = body.slice(0, 1200);
  return diagnostic;
}

function renderReport(report) {
  const lines = ["# Visual audit", "", `Status: ${report.status}`, `Base URL: ${report.baseUrl}`, ""];
  for (const surface of report.surfaces) {
    lines.push(`## ${surface.viewport.name}: ${surface.route}`, "");
    lines.push(renderVisualAuditMarkdown(surface), "");
  }
  if (!report.surfaces.length) lines.push("No surfaces were audited.", "");
  if (report.failures.length) lines.push(`Definite findings: ${report.failures.length}`, "");
  if (report.warnings.length) lines.push(`Warnings: ${report.warnings.length}`, "");
  return lines.join("\n");
}

function fixtureMatchesExpectedRules(auditReport) {
  const actualRules = new Set(auditReport.failures.map((finding) => finding.rule));
  return actualRules.size === FIXTURE_EXPECTED_RULES.size
    && [...FIXTURE_EXPECTED_RULES].every((rule) => actualRules.has(rule));
}

async function main() {
const report = {
  status: "running",
  baseUrl,
  expectedSha: expectedSha || null,
  fixture: runFixture,
  initialStewardDeskProofMode: initialStewardDeskProofMode.mode,
  startedAt: new Date().toISOString(),
  viewports: VIEWPORTS,
  routes: runFixture ? [fixtureUrl] : routes.map(auditUrl),
  surfaces: [],
  failures: [],
  warnings: [],
  screenshots: [],
  baselinePath: runFixture ? null : baselinePath,
  baselineEntries: 0,
};

let browser;
let failed;
let baseline = [];
try {
  await mkdir(artifactDir, { recursive: true });
  if (!runFixture) {
    baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    if (!Array.isArray(baseline)) throw new Error("Visual audit baseline must be a JSON array");
    report.baselineEntries = baseline.length;
  }
  browser = await chromium.launch({ headless: true });
  // Every surface proves a fresh SAMPLE front door. Reusing a context restores
  // the preceding Member session and prevents the required Steward batch.
  const targets = VIEWPORTS.flatMap((viewport) => report.routes.map((route) => ({ viewport, route })));
  for (const { viewport, route } of targets) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
    try {
      const page = await context.newPage();
      await page.addInitScript("window.__ugPendingDeviceParity=[['app.selectedStaffHat','steward']]");
      let activeRoute = "runner";
      let runtimeFailures = [];
      // Full URLs of dynamic imports the page reported as failed; the capped
      // console-error message may truncate them, and the tear evidence needs
      // the exact asset path to pair an import with its HTTP failure.
      let failedImportUrls = [];
      // One build-info observation per failed app asset, started the moment
      // the failure is seen, so a tear can be placed at the import failure
      // itself rather than at the end of the route wait.
      let assetFailureProbes = [];
      const fetchBuildInfo = async () => {
        const url = `${baseUrl}/build-info.json`;
        const info = await page.request.get(url, { headers: { "cache-control": "no-store" }, maxRedirects: 0 });
        return readBuildInfoResponse(info, url);
      };
      const runtimeBoundary = createTargetRuntimeBoundary();
      let initialStewardDeskCapture = null;
      let initialStewardDeskBatch = null;
      const restartTargetRuntimeCapture = () => {
        runtimeFailures = [];
        failedImportUrls = [];
        assetFailureProbes = [];
        runtimeBoundary.restartTarget();
      };
      const armInitialStewardDeskCapture = () => {
        initialStewardDeskBatch = initialStewardDeskProofMode.initialBatch;
        if (initialStewardDeskProofMode.mode !== "required") {
          initialStewardDeskCapture = null;
          return;
        }
        initialStewardDeskCapture = createInitialStewardDeskRuntimeCapture({
          belongsToCurrentTarget: (request) => runtimeBoundary.belongsToCurrentTarget(request),
          now: Date.now,
          waitForResponseCompletion: async (response) => response.finished(),
          responseCompletedAt,
          readPostgresCode: responsePostgresCode,
        });
        initialStewardDeskCapture.arm();
      };
       const finalizeInitialStewardDeskCapture = async () => {
        if (!initialStewardDeskCapture) return null;
        initialStewardDeskBatch = await initialStewardDeskCapture.finalize();
         return initialStewardDeskBatch;
       };
       initialStewardDeskCaptureByPage.set(page, {
         armInitialStewardDeskCapture,
         finalizeInitialStewardDeskCapture,
       });
       page.on("request", (request) => runtimeBoundary.trackRequest(request));
       page.on("request", (request) => {
         const rpc = initialStewardDeskRpc(request);
        if (rpc && initialStewardDeskCapture && runtimeBoundary.belongsToCurrentTarget(request)) {
          initialStewardDeskCapture.observeRequest({ requestKey: request, rpc, atMs: requestStartedAt(request) });
        }
      });
      page.on("console", (message) => {
        // Chromium duplicates HTTP/network failures as an unlocated console
        // line. The response/requestfailed handlers below own those failures
        // because they can bind them to the identity that started the request.
        if (message.type() === "error" && !isGenericResourceConsoleError(message.text())) {
          runtimeFailures.push(runtimeFailure(activeRoute, viewport, "console-error", `Console error: ${message.text()}`));
          const failedImport = failedDynamicImportUrl(message.text());
          if (failedImport) failedImportUrls.push(failedImport);
        }
      });
      page.on("pageerror", (error) => {
        runtimeFailures.push(runtimeFailure(activeRoute, viewport, "page-error", `Page error: ${error.message}`));
      });
      page.on("response", (response) => {
        const request = response.request();
        const rpc = initialStewardDeskRpc(request);
        if (rpc && initialStewardDeskCapture && runtimeBoundary.belongsToCurrentTarget(request)) {
          initialStewardDeskCapture.observeResponse({
            requestKey: request,
            httpStatus: response.status(),
            response,
          });
        }
        if (response.status() >= 400 && runtimeBoundary.belongsToCurrentTarget(response.request())) {
          runtimeFailures.push(runtimeFailure(activeRoute, viewport, "http-error", describeRuntimeHttpFailure({
            status: response.status(),
            responseUrl: response.url(),
            baseUrl,
          })));
          const assetPath = appAssetPath(response.url(), baseUrl);
          if (assetPath && expectedSha && !runFixture) {
            assetFailureProbes.push(observeAssetFailureBuild({ assetPath, fetchBuildInfo }));
          }
        }
      });
      page.on("requestfailed", (request) => {
        if (!runtimeBoundary.belongsToCurrentTarget(request)) return;
        const errorText = request.failure()?.errorText || "unknown network failure";
        const rpc = initialStewardDeskRpc(request);
        const isInitialStewardDeskRequest = rpc && initialStewardDeskCapture;
        if (isInitialStewardDeskRequest) {
          initialStewardDeskCapture.observeRequestFailed({ requestKey: request, atMs: Date.now() });
        }
        // Full-document and SPA navigation intentionally abort obsolete
        // resources. They are not dependency failures and were never console
        // findings; keep the runtime gate focused on actual failed transport.
        if (errorText === "net::ERR_ABORTED" && !isInitialStewardDeskRequest) return;
        runtimeFailures.push(runtimeFailure(activeRoute, viewport, "network-error", describeRuntimeNetworkFailure({
          errorText,
          requestUrl: request.url(),
          baseUrl,
        })));
      });
      await verifyExpectedSha(page);
      const url = runFixture ? route : auditUrl(route);
      const currentRoute = displayRoute(url);
      activeRoute = currentRoute;
      initialStewardDeskCapture = null;
      initialStewardDeskBatch = null;
      // Capture the fresh front door before selecting the route's target hat;
      // navigateToAuditSurface restarts this boundary at the explicit choice.
      restartTargetRuntimeCapture();
      let documentProof = null;
      try {
         documentProof = await navigateToAuditSurface(page, url, currentRoute, restartTargetRuntimeCapture);
        await finalizeInitialStewardDeskCapture();
        await waitForStableSurface(page, { expectWelcome: false });
        const routeContract = await assertRouteContract(page, currentRoute);
        const measurements = await page.evaluate(collectVisualMeasurements);
        measurements.route = currentRoute;
        const classified = applyVisualBaseline(classifyVisualMeasurements(measurements), baseline);
        const screenshotPath = join(artifactDir, screenshotName(viewport.name, url));
        await captureScreenshot(page, screenshotPath);
        const baseSurface = {
          route: currentRoute,
          url,
          viewport: { width: viewport.width, height: viewport.height, name: viewport.name },
          inspected: classified.inspected,
          documentSha: documentProof?.sha ?? null,
          routeContract,
          failures: [...classified.failures, ...runtimeFailures],
          warnings: classified.warnings,
          screenshot: screenshotPath,
        };
        const attached = attachInitialStewardDeskBatch(baseSurface, initialStewardDeskBatch, {
          route: currentRoute,
          viewport,
        });
        const surface = {
          ...attached.surface,
          failures: [...baseSurface.failures, ...attached.findings],
        };
        report.surfaces.push(surface);
        report.failures.push(...surface.failures);
        report.warnings.push(...surface.warnings);
        report.screenshots.push(screenshotPath);
      } catch (error) {
        await finalizeInitialStewardDeskCapture();
        const diagnostic = await routeDiagnostic(page, url, error);
        const failureScreenshotPath = join(artifactDir, failureScreenshotName(viewport.name, url));
        let failureScreenshot;
        await captureScreenshot(page, failureScreenshotPath).then(() => {
          failureScreenshot = failureScreenshotPath;
          report.screenshots.push(failureScreenshot);
        }).catch((screenshotError) => {
          diagnostic.screenshotError = String(screenshotError.message || screenshotError).slice(0, 1200);
        });
        // Record what this surface saw of the deployment: the build its main
        // document carried (even when refused as unbound), which of its own
        // route modules failed to load and the build the origin served at the
        // moment they failed, and (diagnostic only) the build it serves now.
        // The classifier decides later whether that is a tear.
        const tear = await collectTearEvidence({ error, expectedSha, fixture: runFixture, fetchBuildInfo });
        const modules = routeModuleFailures({ failedImportUrls, runtimeFailures });
        const routeModules = modules.map((module) => runtimeFailure(currentRoute, viewport, "route-chunk-error", describeRouteModuleFailure(module)));
        const assetBuilds = assetFailureBuilds(await Promise.all(assetFailureProbes));
        const routeModuleBuild = routeModuleBuildSha(modules, assetBuilds);
        const baseSurface = {
          route: currentRoute,
          url,
          viewport: { width: viewport.width, height: viewport.height, name: viewport.name },
          inspected: 0,
          documentSha: documentProof?.sha ?? null,
          receivedDocumentSha: tear.receivedDocumentSha,
          liveBuildSha: tear.liveBuildSha,
          routeModuleBuildSha: routeModuleBuild,
          assetFailureBuilds: assetBuilds,
          failures: [...runtimeFailures, ...routeModules, runtimeFailure(currentRoute, viewport, "route-error", diagnostic.error)],
          warnings: [],
          failureScreenshot,
          diagnostic,
        };
        const attached = attachInitialStewardDeskBatch(baseSurface, initialStewardDeskBatch, {
          route: currentRoute,
          viewport,
        });
        const surface = {
          ...attached.surface,
          failures: [...baseSurface.failures, ...attached.findings],
        };
        report.surfaces.push(surface);
        report.failures.push(...surface.failures);
      }
    } finally {
      await context.close();
    }
  }
} catch (error) {
  report.failures.push(runtimeFailure("runner", { width: 0, height: 0 }, "runner-error", error.message));
} finally {
  await browser?.close().catch((error) => {
    report.failures.push(runtimeFailure("runner", { width: 0, height: 0 }, "runner-error", error.message));
  });
  report.finishedAt = new Date().toISOString();
  report.fixtureMatchesExpectedRules = runFixture ? fixtureMatchesExpectedRules(report) : null;
  failed = runFixture ? !report.fixtureMatchesExpectedRules : report.failures.length > 0;
  report.status = failed ? "failed" : "passed";
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "visual-audit.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(artifactDir, "visual-audit.md"), `${renderReport(report)}\n`);
}

console.log(`VISUAL_AUDIT_ARTIFACT=${artifactDir}`);
console.log(`VISUAL_AUDIT_STATUS=${report.status}`);
if (failed) for (const line of renderVisualAuditFailureLines(report)) console.error(line);
process.exitCode = failed ? 1 : 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
