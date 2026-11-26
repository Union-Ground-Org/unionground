import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import lighthouse from "lighthouse";
import * as chromeLauncher from "chrome-launcher";
import puppeteer from "puppeteer-core";
import { chromium } from "@playwright/test";
import {
  assertLoopbackApplicationRequests,
  assertWebPerformanceSource,
  budgetSummaryMarkdown,
  effectiveBundleCeilings,
  evaluateWebPerformanceBudget,
  firstPaintAssetPaths,
  firstPaintBytes,
  isolatedWebPerformanceEnv,
  missingBudgetCeilings,
  summarizeSamples,
} from "./lib/web-performance-budget.mjs";
import { runtimeConfigForRequest } from "../api/_lib/runtimeConfig.js";
import { APP_READY_MARK } from "../src/lib/appReadyMark.js";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(await readFile(resolve(root, "config/web-performance-budgets.json"), "utf8"));
const outputPath = resolve(root, process.env.WEB_PERF_ARTIFACT || "reports/web-performance/summary.json");
const modes = ["cold", "warm"];
const chromePath = process.env.CHROME_PATH || chromium.executablePath();

function log(message) {
  process.stdout.write(`[web-performance] ${message}\n`);
}

async function exactSourceSha(expectedSha = null) {
  const [head, status] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root }),
    execFileAsync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root }),
  ]);
  return assertWebPerformanceSource({ expectedSha, actualSha: head.stdout.trim(), status: status.stdout });
}

async function commandVersion(command, args) {
  const { stdout, stderr } = await execFileAsync(command, args, { cwd: root });
  return `${stdout}${stderr}`.trim().split("\n", 1)[0];
}

function run(command, args, { env = process.env } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(" ")} failed (${signal || code})`));
    });
  });
}

async function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? rejectPort(error) : resolvePort(address.port));
    });
  });
}

async function waitForPreview(url, child) {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Vite preview exited before becoming ready (${child.exitCode})`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`preview returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Vite preview did not become ready: ${lastError?.message || "timeout"}`);
}

async function startPreview(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [
    resolve(root, "node_modules/vite/bin/vite.js"),
    "preview",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--strictPort",
  ], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const origin = `http://127.0.0.1:${port}`;
  try {
    await waitForPreview(origin, child);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`${error.message}\n${output.slice(-4000)}`, { cause: error });
  }
  return {
    origin,
    async close() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolveClose) => {
        const timeout = setTimeout(() => { child.kill("SIGKILL"); resolveClose(); }, 5000);
        child.once("exit", () => { clearTimeout(timeout); resolveClose(); });
      });
    },
  };
}

// Every emitted JavaScript and CSS file, raw and gzip level 9. The per-file
// sizes also price the first-paint line, so both lines count bytes the same way.
async function bundleMeasurement(surface) {
  const assetDirectory = resolve(root, "dist/assets");
  const files = (await readdir(assetDirectory)).filter((name) => /\.(?:css|js)$/.test(name));
  const sizes = new Map();
  let rawBytes = 0;
  let gzipBytes = 0;
  for (const name of files) {
    const bytes = await readFile(resolve(assetDirectory, name));
    const size = { rawBytes: bytes.byteLength, gzipBytes: gzipSync(bytes, { level: 9 }).byteLength };
    sizes.set(`/assets/${name}`, size);
    rawBytes += size.rawBytes;
    gzipBytes += size.gzipBytes;
  }
  return { bundle: { surface, assetCount: files.length, rawBytes, gzipBytes }, sizes };
}


function lighthouseSettings(profile, port, mode) {
  const throttling = profile.throttling;
  return {
    port,
    logLevel: "error",
    output: "json",
    onlyCategories: ["performance"],
    disableFullPageScreenshot: true,
    disableStorageReset: mode === "warm",
    formFactor: profile.formFactor,
    screenEmulation: profile.viewport,
    throttlingMethod: "simulate",
    throttling: {
      rttMs: throttling.rttMs,
      throughputKbps: throttling.throughputKbps,
      cpuSlowdownMultiplier: throttling.cpuSlowdownMultiplier,
      requestLatencyMs: throttling.rttMs * 3.75,
      downloadThroughputKbps: throttling.throughputKbps * 0.9,
      uploadThroughputKbps: Math.min(675, throttling.throughputKbps * 0.4),
    },
    emulatedUserAgent: profile.formFactor === "mobile"
      ? "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/136.0.0.0 Mobile Safari/537.36"
      : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36",
    maxWaitForLoad: 45_000,
  };
}

function metric(lhr, auditId) {
  const value = lhr.audits?.[auditId]?.numericValue;
  return Number.isFinite(value) ? value : null;
}

async function lighthouseSample(url, profile, chrome, mode) {
  const result = await lighthouse(url, lighthouseSettings(profile, chrome.port, mode));
  assertLoopbackApplicationRequests(
    (result.lhr.audits?.["network-requests"]?.details?.items ?? [])
      .map((item) => item.url)
      .filter(Boolean),
  );
  return {
    lcpMs: metric(result.lhr, "largest-contentful-paint"),
    cls: metric(result.lhr, "cumulative-layout-shift"),
    tbtMs: metric(result.lhr, "total-blocking-time"),
    transferBytes: metric(result.lhr, "total-byte-weight"),
  };
}

// One page load under the profile's network and CPU, in which the app-ready
// mark is read and the scenario's named control is clicked for a lab INP
// sample. The control is waited for after the mark, so a slow shell delays the
// click instead of leaving the probe nothing to click.
async function measuredInteraction(url, scenario, profile, chrome, mode) {
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}` });
  try {
    const page = await browser.newPage();
    await page.setViewport(profile.viewport);
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");
    const applicationRequests = [];
    cdp.on("Network.requestWillBeSent", (event) => applicationRequests.push(event.request.url));
    if (mode === "cold") {
      await cdp.send("Network.clearBrowserCache");
      await cdp.send("Storage.clearDataForOrigin", { origin: new URL(url).origin, storageTypes: "all" });
    }
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: profile.throttling.rttMs,
      downloadThroughput: profile.throttling.throughputKbps * 1024 / 8,
      uploadThroughput: Math.min(675, profile.throttling.throughputKbps * 0.4) * 1024 / 8,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.throttling.cpuSlowdownMultiplier });
    await page.evaluateOnNewDocument(() => {
      performance.setResourceTimingBufferSize(10_000);
      globalThis.__unionGroundInp = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.interactionId) globalThis.__unionGroundInp.push(entry.duration);
        }
      }).observe({ type: "event", buffered: true, durationThreshold: 16 });
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForFunction((name) => performance.getEntriesByName(name).length > 0, { timeout: 45_000 }, APP_READY_MARK)
      .catch(() => { throw new Error(`${scenario.id}: the app never set its ${APP_READY_MARK} mark`); });
    const appReadyMs = await page.evaluate((name) => performance.getEntriesByName(name)[0].startTime, APP_READY_MARK);
    const fcpMs = await page.evaluate(() => performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null);
    if (!Number.isFinite(fcpMs)) throw new Error(`${scenario.id}: the cold load recorded no first contentful paint`);
    const resourceEntries = () => page.evaluate(() => performance.getEntriesByType("resource")
      .map(({ name, startTime }) => ({ name, startTime })));
    const firstPaintAtMark = mode === "cold" ? firstPaintAssetPaths(await resourceEntries(), appReadyMs) : null;
    const target = await page.waitForSelector(`:is(${scenario.inpTarget}):not([disabled])`, { visible: true, timeout: 15_000 })
      .catch(() => { throw new Error(`${scenario.id}: INP probe target ${scenario.inpTarget} was not visible after app ready`); });
    // Let the commit that set the mark finish its follow-up work first.
    await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
    await target.click();
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    // Read again after the probe's waits and keep both reads: a resource
    // timing entry appears only when its response ends, so a fetch that started
    // before the mark and was still in flight then shows up only in the late
    // read, and an entry the page clears after the mark survives in the first.
    // Fetches started after the mark (the click included) stay excluded.
    const firstPaintAssets = mode === "cold"
      ? [firstPaintAtMark, firstPaintAssetPaths(await resourceEntries(), appReadyMs)]
      : null;
    const value = await page.evaluate(() => Math.max(0, ...(globalThis.__unionGroundInp || [])));
    assertLoopbackApplicationRequests(applicationRequests);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => undefined);
    await page.close();
    if (!Number.isFinite(value) || value < 0) throw new Error("INP probe returned an invalid Event Timing value");
    // PerformanceEventTiming suppresses interactions shorter than its 16 ms
    // duration threshold. Treat a suppressed entry as a conservative 16 ms
    // upper bound instead of pretending the interaction was unmeasured.
    return { inpMs: value || 16, appReadyMs, fcpMs, firstPaintAssets };
  } finally {
    browser.disconnect();
  }
}

async function collectGroup(scenario, mode, origin, sizes) {
  const profile = config.profiles[scenario.profile];
  const url = new URL(scenario.path, origin).href;
  const chrome = await chromeLauncher.launch({
    chromePath,
    chromeFlags: ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    if (mode === "warm") {
      log(`${scenario.id}/${mode}: warming browser cache`);
      await lighthouseSample(url, profile, chrome, "cold");
    }
    const samples = [];
    for (let index = 0; index < config.runsPerMode; index += 1) {
      log(`${scenario.id}/${mode}: run ${index + 1}/${config.runsPerMode}`);
      const sample = await lighthouseSample(url, profile, chrome, mode);
      const { firstPaintAssets, ...interaction } = await measuredInteraction(url, scenario, profile, chrome, mode);
      Object.assign(sample, interaction, firstPaintAssets ? firstPaintBytes(firstPaintAssets, sizes, scenario.id) : {});
      samples.push(sample);
    }
    return {
      id: scenario.id,
      surface: scenario.surface,
      route: scenario.path,
      profile: scenario.profile,
      mode,
      metrics: summarizeSamples(samples),
      ...(mode === "cold" ? { firstPaintAssetCounts: samples.map((sample) => sample.firstPaintAssetCount) } : {}),
    };
  } finally {
    try { chrome.kill(); } catch { /* launcher process already exited */ }
  }
}

function runSelfTest() {
  const selfTestConfig = { ...config, scenarios: [], modes: [] };
  const today = new Date().toISOString().slice(0, 10);
  const bundleCeilings = effectiveBundleCeilings(config, today);
  const passingBundle = () => ({
    surface: "self-test",
    rawBytes: bundleCeilings.allJavaScriptAndCssRawBytes - 1,
    gzipBytes: bundleCeilings.allJavaScriptAndCssGzipBytes - 1,
  });
  const rejected = new Set();
  const evaluate = ({ profileName, metrics, bundles = [passingBundle()], budgetConfig = selfTestConfig }) =>
    evaluateWebPerformanceBudget({
      config: budgetConfig,
      bundles,
      groups: [{ id: "self-test", mode: "cold", profile: profileName, metrics }],
    });

  // Every configured profile is self-tested, not just the first one: a ceiling
  // deleted from any profile has to fail the gate.
  for (const [profileName, profile] of Object.entries(config.profiles)) {
    const passing = {
      lcpMs: profile.budgets.lcpMs - 1,
      cls: profile.budgets.cls - 0.001,
      inpMs: profile.budgets.inpMs - 1,
      tbtMs: profile.budgets.tbtMs - 1,
    };
    const passingMetrics = () => summarizeSamples([passing, passing, passing]);
    for (const [metricName, ceiling] of Object.entries(profile.budgets)) {
      const metrics = passingMetrics();
      metrics[metricName].median = ceiling + 1;
      if (evaluate({ profileName, metrics }).passed) {
        throw new Error(`self-test failed to reject deliberate ${profileName} ${metricName} regression`);
      }
      const budgets = { ...profile.budgets };
      delete budgets[metricName];
      const budgetConfig = {
        ...selfTestConfig,
        profiles: { ...config.profiles, [profileName]: { ...profile, budgets } },
      };
      if (evaluate({ profileName, metrics: passingMetrics(), budgetConfig }).passed) {
        throw new Error(`self-test failed to reject a missing ${profileName} ${metricName} ceiling`);
      }
    }
    for (const metricName of ["rawBytes", "gzipBytes"]) {
      const regressed = metricName === "rawBytes"
        ? bundleCeilings.allJavaScriptAndCssRawBytes + 1
        : bundleCeilings.allJavaScriptAndCssGzipBytes + 1;
      const result = evaluate({
        profileName,
        metrics: passingMetrics(),
        bundles: [{ ...passingBundle(), [metricName]: regressed }],
      });
      if (result.passed) {
        throw new Error(`self-test failed to reject deliberate ${metricName} regression`);
      }
      rejected.add(result.failures.find((failure) => failure.includes("JS+CSS")));
    }
    for (const ceilingName of ["allJavaScriptAndCssRawBytes", "allJavaScriptAndCssGzipBytes"]) {
      const bundle = { ...config.bundle };
      delete bundle[ceilingName];
      if (evaluate({
        profileName,
        metrics: passingMetrics(),
        budgetConfig: { ...selfTestConfig, bundle },
      }).passed) {
        throw new Error(`self-test failed to reject a missing ${ceilingName} ceiling`);
      }
    }
  }
  // First-paint line (product decision of November 10, 2026): every scenario's cold
  // ceiling rejects a deliberate raw or gzip regression and its own deletion.
  for (const scenario of config.scenarios) {
    const { budgets } = config.profiles[scenario.profile];
    const limit = config.firstPaint.scenarios[scenario.id];
    const sample = (overrides) => ({
      lcpMs: budgets.lcpMs - 1, cls: budgets.cls - 0.001, inpMs: budgets.inpMs - 1, tbtMs: budgets.tbtMs - 1,
      firstPaintRawBytes: limit.rawBytes - 1, firstPaintGzipBytes: limit.gzipBytes - 1, ...overrides,
    });
    const evaluateScenario = (overrides = {}, firstPaint = config.firstPaint) => evaluateWebPerformanceBudget({
      config: { ...config, modes: ["cold"], scenarios: [scenario], firstPaint },
      bundles: [{ ...passingBundle(), surface: scenario.surface }],
      groups: [{
        id: scenario.id, mode: "cold", profile: scenario.profile,
        metrics: summarizeSamples(Array.from({ length: config.runsPerMode }, () => sample(overrides))),
      }],
    });
    if (!evaluateScenario().passed) throw new Error(`self-test: ${scenario.id} rejected a first-paint load under its ceiling`);
    for (const [metricName, ceilingName] of [["firstPaintRawBytes", "rawBytes"], ["firstPaintGzipBytes", "gzipBytes"]]) {
      const result = evaluateScenario({ [metricName]: limit[ceilingName] + 1 });
      const failure = result.failures.find((entry) => entry.includes("first-paint"));
      if (result.passed || !failure) throw new Error(`self-test failed to reject deliberate ${scenario.id} ${metricName} regression`);
      rejected.add(failure);
      const deleted = { ...limit };
      delete deleted[ceilingName];
      if (evaluateScenario({}, { ...config.firstPaint, scenarios: { ...config.firstPaint.scenarios, [scenario.id]: deleted } }).passed) {
        throw new Error(`self-test failed to reject a missing ${scenario.id} first-paint ${ceilingName} ceiling`);
      }
    }
  }
  // The ratchet must tighten: a bundle at today's ceiling fails a month later.
  if (config.ratchet?.bundle) {
    const nextMonth = new Date(`${today}T12:00:00Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, Math.min(nextMonth.getUTCDate(), 28));
    const later = effectiveBundleCeilings(config, nextMonth.toISOString().slice(0, 10));
    const target = config.bundle.allJavaScriptAndCssRawBytes;
    if (bundleCeilings.allJavaScriptAndCssRawBytes > target && later.allJavaScriptAndCssRawBytes >= bundleCeilings.allJavaScriptAndCssRawBytes) {
      throw new Error("self-test failed: the bundle ratchet did not tighten after a month");
    }
  }
  for (const failure of rejected) log(`self-test rejected: ${failure}`);
  log(`self-test PASS: for every configured profile (${Object.keys(config.profiles).join(", ")}), deliberate LCP, CLS, INP, TBT, raw-bundle, and gzip-bundle regressions were rejected; for every scenario (${config.scenarios.map((scenario) => scenario.id).join(", ")}), deliberate raw and gzip first-paint regressions were rejected; and so was every deleted ceiling`);
}

async function main() {
  const missingCeilings = missingBudgetCeilings(config);
  if (missingCeilings.length) {
    throw new Error(`web performance budget config is missing enforced ceilings: ${missingCeilings.join(", ")}`);
  }
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }
  if (!Number.isInteger(config.runsPerMode) || config.runsPerMode < 3) {
    throw new Error("web performance variance handling requires at least three runs per mode");
  }
  const sourceSha = await exactSourceSha();
  const groups = [];
  const bundles = [];
  for (const surface of ["saas", "demo"]) {
    // Empty values deliberately override both the inherited environment and
    // Vite's .env/.env.production fallback merge. The demo measurement must
    // enter credential-free fixture mode even on an operator workstation that
    // is configured for the real SAMPLE project.
    const env = isolatedWebPerformanceEnv(process.env, surface);
    const runtime = runtimeConfigForRequest({ headers: { host: "127.0.0.1" } }, env);
    if (surface === "saas") {
      if (!runtime.configured || runtime.surface !== "saas" || runtime.supabaseUrl !== env.VITE_SUPABASE_URL) {
        throw new Error("SaaS performance measurement requires the explicit closed loopback runtime backend");
      }
    } else if (runtime.configured || runtime.surface !== "demo") {
      throw new Error("demo performance measurement requires credential-free fixture runtime configuration");
    }
    await exactSourceSha(sourceSha);
    // The SAMPLE surface is the credential-free fixture build the visual audit
    // uses (vite build --mode test); a production-mode demo build has no
    // fixtures and renders only "Secure member service is not connected".
    const script = surface === "demo" ? "build:assurance" : "build";
    log(`building ${surface} surface (npm run ${script}) at ${sourceSha}`);
    await run("npm", ["run", script], { env });
    await exactSourceSha(sourceSha);
    const { bundle, sizes } = await bundleMeasurement(surface);
    bundles.push(bundle);
    const preview = await startPreview(env);
    try {
      for (const scenario of config.scenarios.filter((entry) => entry.surface === surface)) {
        for (const mode of modes) groups.push(await collectGroup(scenario, mode, preview.origin, sizes));
      }
    } finally {
      await preview.close();
    }
  }
  const gate = evaluateWebPerformanceBudget({ config, groups, bundles });
  const summary = {
    schema: 1,
    sourceSha,
    recordedAt: new Date().toISOString(),
    tools: {
      browser: await commandVersion(chromePath, ["--version"]),
      lighthouse: await commandVersion(resolve(root, "node_modules/.bin/lighthouse"), ["--version"]),
      chromeLauncher: JSON.parse(await readFile(resolve(root, "node_modules/chrome-launcher/package.json"), "utf8")).version,
    },
    measurement: {
      build: "SaaS: vite production build; SAMPLE: the credential-free fixture build (vite build --mode test); both served by local vite preview",
      data: "credential-free local fixtures and a deliberately closed loopback SaaS backend",
      modes,
      runsPerMode: config.runsPerMode,
      aggregation: config.variance.aggregation,
      varianceWarningRelativeRange: config.variance.maxRelativeRange,
      firstPaint: "cold loads only: built JavaScript and CSS whose fetch started before the ug:app-ready mark, priced by the build's own raw and gzip level 9 file sizes, median of the cold runs",
      artifacts: "aggregate metrics only; no trace, screenshot, cookies, headers, or tenant data",
    },
    profiles: config.profiles,
    bundles,
    groups,
    gate,
  };
  await exactSourceSha(sourceSha);
  await mkdir(resolve(outputPath, ".."), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  log(`privacy-safe summary written to ${outputPath}`);
  const markdown = budgetSummaryMarkdown(summary);
  process.stdout.write(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  for (const warning of gate.warnings) log(`variance warning: ${warning}`);
  if (!gate.passed) throw new Error(`web performance budget failed:\n- ${gate.failures.join("\n- ")}`);
  log("budget gate PASS");
}

await main();
