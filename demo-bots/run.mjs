// Demo bots: fictional personas that drive the auth-free demo in a real
// browser, one fresh browser context per script.
//
//   node demo-bots/run.mjs list | coverage | lint
//   node demo-bots/run.mjs run [--only W-MEMBER-01,W-CHAIR-01] [--base-url http://127.0.0.1:5173] [--headed] [--out <dir>]
//
// Without --base-url, `run` serves the existing dist/ build (run `npm run build`
// first) with `vite preview` on a free loopback port and stops it afterwards.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copy, SCRIPTS } from "./scripts.mjs";
import { isAllowedRequest, resolveDemoTarget } from "./target.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
export const PERSONAS = JSON.parse(readFileSync(join(here, "personas.json"), "utf8")).personas;
export const FUNCTIONS = JSON.parse(readFileSync(join(here, "function-catalog.json"), "utf8")).functions;

const VIEWPORTS = {
  "web-desktop": { width: 1440, height: 900 },
  "web-mobile": { width: 390, height: 844 },
};
const STEP_TIMEOUT = 10_000;

// Catalog, persona and script consistency. Returned as a list so the CLI and
// tests/demo-bots.test.js report the same problems.
export function lintKit({ personas = PERSONAS, functions = FUNCTIONS, scripts = SCRIPTS } = {}) {
  const problems = [];
  const functionIds = new Set(functions.map((fn) => fn.id));
  const personaIds = new Set(personas.map((persona) => persona.id));
  const scriptIds = new Set();
  for (const persona of personas) {
    if (!VIEWPORTS[persona.device]) problems.push(`${persona.id}: unknown device ${persona.device}`);
    for (const id of persona.focus) if (!functionIds.has(id)) problems.push(`${persona.id}: focus names unknown function ${id}`);
  }
  for (const script of scripts) {
    if (scriptIds.has(script.id)) problems.push(`${script.id}: duplicate script id`);
    scriptIds.add(script.id);
    if (!personaIds.has(script.bot)) problems.push(`${script.id}: unknown bot ${script.bot}`);
    if (typeof script.run !== "function") problems.push(`${script.id}: no run function`);
    for (const id of script.covers) if (!functionIds.has(id)) problems.push(`${script.id}: covers unknown function ${id}`);
  }
  for (const id of uncovered({ functions, scripts })) problems.push(`${id}: no script covers it`);
  return problems;
}

export function uncovered({ functions = FUNCTIONS, scripts = SCRIPTS } = {}) {
  const covered = new Set(scripts.flatMap((script) => script.covers));
  return functions.map((fn) => fn.id).filter((id) => !covered.has(id));
}

function makeUi(page, persona, errors) {
  const lang = persona.language;
  const visible = (locator) => locator.first().waitFor({ state: "visible", timeout: STEP_TIMEOUT });
  // Buttons and links both count as controls: the member nav renders links on
  // some layouts and buttons on others.
  const control = (name) => page.getByRole("button", { name, exact: typeof name === "string" })
    .or(page.getByRole("link", { name, exact: typeof name === "string" }))
    .or(page.getByRole("tab", { name, exact: typeof name === "string" }))
    .or(page.getByRole("radio", { name, exact: typeof name === "string" }))
    .or(page.getByRole("menuitem", { name, exact: typeof name === "string" }));
  const ui = {
    page,
    async click(name) {
      const target = control(name).first();
      await target.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
      await target.click();
    },
    // Close a conversation or detail dialog if one opened; a no-op when the
    // layout showed it inline instead.
    async dismissDialogs() {
      const dialog = page.getByRole("dialog").filter({ visible: true });
      if (await dialog.count()) await page.keyboard.press("Escape");
    },
    async closeDialog() {
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").first().waitFor({ state: "hidden", timeout: STEP_TIMEOUT });
    },
    async seeControl(name) { await visible(control(name)); },
    async gone(name) { await control(name).first().waitFor({ state: "hidden", timeout: STEP_TIMEOUT }); },
    async seeHeading(name) { await visible(page.getByRole("heading", { name })); },
    async seeText(text) { await visible(page.getByText(text)); },
    // Scoped checks, for content the list behind already shows: a named
    // region of the page, or the open dialog.
    async seeIn(region, name) { await visible(page.getByRole("region", { name: region }).getByRole("textbox", { name })); },
    async seeInDialog(heading) { await visible(page.getByRole("dialog").getByRole("heading", { name: heading })); },
    // The desktop shell shows the preview banner; the phone shell has no room
    // for it and carries the "Demo tour" chip instead. Either one tells a
    // visitor the data is fictional, and one of them must always be there.
    async seeBanner(bannerLang = lang) {
      await visible(page.getByText(copy("demo.previewBanner", bannerLang))
        .or(page.getByRole("button", { name: copy("demo.chipLabel", bannerLang) })));
    },
    // Fixture demo mode opens on a welcome dialog; a visitor dismisses it to
    // explore. Wait for it to close so the next click is not swallowed by it.
    async dismissWelcome() {
      const explore = page.getByRole("button", { name: copy("demo.exploreAlone", lang) });
      await explore.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
      await explore.click();
      // The phone shell keeps its own navigation sheet in the dialog role, so
      // wait for this dialog's button, not for "no dialog".
      await explore.waitFor({ state: "hidden", timeout: STEP_TIMEOUT });
    },
    // A staff desk's sections are chosen from a select; pick the option whose
    // text matches. Choosing an option proves only that the menu works, so
    // also wait for the section's route, its heading, and `shows`: text only
    // that section's own body renders.
    async section(text, shows) {
      if (!shows) throw new Error("name text the section itself shows");
      const select = page.getByRole("main").getByRole("combobox").first();
      await select.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
      const options = await select.locator("option").evaluateAll((nodes) => nodes.map((node) => ({ value: node.value, text: node.textContent.trim() })));
      const match = options.find((option) => (typeof text === "string" ? option.text === text : text.test(option.text)));
      if (!match) throw new Error(`No section ${text} in ${options.map((option) => option.text).join(" | ")}`);
      await select.selectOption(match.value);
      await page.waitForURL((url) => url.pathname === match.value, { timeout: STEP_TIMEOUT });
      const main = page.getByRole("main");
      await visible(main.getByRole("heading", { name: match.text, exact: true }));
      await visible(main.getByText(shows));
    },
    // A tab counts as opened when it is the selected one and the panel it
    // labels shows that tab's own heading.
    async tab(name, shows) {
      await page.getByRole("tab", { name, exact: true }).click({ timeout: STEP_TIMEOUT });
      await visible(page.getByRole("tab", { name, exact: true, selected: true }));
      await visible(page.getByRole("tabpanel", { name, exact: true }).getByRole("heading", { name: shows }));
    },
    async seeToast(text) {
      const toast = page.getByRole("status").filter({ hasText: text ?? /\S/ });
      await visible(toast);
    },
    // The first visit opens the hat menu by itself (with an intro line), so
    // clicking the trigger then would close it. Open it only when it is shut.
    async hat(key) {
      const trigger = page.getByRole("button", { name: copy("demo.hatsLabel", lang, { exact: false }) }).first();
      await trigger.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
      if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
      await page.getByRole("menuitemradio", { name: copy(key, lang) }).click({ timeout: STEP_TIMEOUT });
    },
    // A ballot opens in a dialog: pick the first choice by its label (the
    // radios are visually replaced) and submit. The demo keeps the vote in
    // this tab and confirms it with a preview receipt. The receipt is named
    // because the preview banner is a status region too.
    async voteOnce() {
      const dialog = page.getByRole("dialog").first();
      await dialog.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
      await dialog.locator("label").first().click();
      await dialog.getByRole("button", { name: copy("dialogs.submitVote", lang) }).click({ timeout: STEP_TIMEOUT });
      await visible(page.getByRole("status").filter({ hasText: copy("toast.voteSavedReceiptDemo", lang, { exact: false }) }));
      if (await dialog.isVisible()) await this.closeDialog();
    },
    // Desktop lists Rights in the rail; the phone home lists it as "Know your
    // rights" with a trailing chevron.
    async openRights() {
      const phone = VIEWPORTS[persona.device].width < 768;
      await this.click(phone ? copy("nav.knowRights", lang, { exact: false }) : copy("nav.rights", lang));
      await page.waitForURL((url) => url.pathname === "/m/rights", { timeout: STEP_TIMEOUT });
    },
    async exitDemo() {
      await this.click(copy("demo.exit", lang));
      await visible(page.getByRole("button", { name: copy("auth.demo", lang) })
        .or(page.getByRole("link", { name: copy("learn.ctaDemo", lang) }))
        .or(page.getByRole("button", { name: copy("learn.ctaDemo", lang) })));
    },
    async noPageErrors() {
      if (errors.length) throw new Error(`Page error: ${errors[0]}`);
    },
  };
  // A timeout says only "locator.waitFor"; name the step and its argument so a
  // failed run reads as the action the persona could not take.
  for (const [method, fn] of Object.entries(ui)) {
    if (typeof fn !== "function") continue;
    ui[method] = async (...args) => {
      try {
        return await fn.apply(ui, args);
      } catch (error) {
        const shown = args.map((arg) => String(arg)).join(", ");
        throw new Error(`${method}(${shown}): ${String(error?.message || error).split("\n")[0]}`, { cause: error });
      }
    };
  }
  return ui;
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

// A proxy that forwards nothing. A bot's browser context sends every
// connection except the app's own host:port through it, so traffic that
// request routing never sees (the later hops of a redirect, WebSockets,
// service workers) is refused before it reaches anything, and recorded so the
// script fails.
async function startSink() {
  const refused = [];
  const server = createHttpServer((request, response) => {
    refused.push(request.url);
    response.writeHead(502).end();
  });
  server.on("connect", (request, socket) => {
    refused.push(request.url);
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  await new Promise((listening, reject) => server.once("error", reject).listen(0, "127.0.0.1", listening));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    refused,
    close: () => new Promise((closed) => { server.closeAllConnections(); server.close(closed); }),
  };
}

async function startPreview() {
  if (!existsSync(join(repoRoot, "dist", "index.html"))) throw new Error("No dist/ build to serve. Run `npm run build` first, or pass --base-url.");
  const { preview } = await import("vite");
  const port = await freePort();
  const server = await preview({ root: repoRoot, logLevel: "silent", preview: { host: "127.0.0.1", port, strictPort: true } });
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => server.close() };
}

// The one place a bot's browser is launched, so every caller gets the same
// rails. The proxy only carries TCP: without this policy WebRTC would send
// UDP (a STUN probe) straight past it.
export async function launchBrowser({ headed = false } = {}) {
  const { chromium } = await import("@playwright/test");
  return chromium.launch({ headless: !headed, args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] });
}

// `browser` comes from launchBrowser.
export async function runScript(browser, target, script, { outDir } = {}) {
  const persona = PERSONAS.find((candidate) => candidate.id === script.bot);
  const sink = await startSink();
  const context = await browser.newContext({
    proxy: { server: sink.url, bypass: target.host },
    viewport: VIEWPORTS[persona.device],
    isMobile: persona.device === "web-mobile",
    hasTouch: persona.device === "web-mobile",
    locale: persona.language === "es" ? "es-US" : "en-US",
    timezoneId: "America/New_York",
  });
  const errors = [];
  const offOrigin = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (isAllowedRequest(url, target.origin)) return route.continue();
    offOrigin.push(url);
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  // Kept for the report: a chunk that failed to load explains a missing view.
  const failedRequests = [];
  page.on("requestfailed", (request) => failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? ""}`.trim()));
  page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));
  const started = Date.now();
  const result = { id: script.id, bot: persona.id, persona: persona.fullName, covers: script.covers, ok: false };
  try {
    await page.goto(script.entry === "signin" ? new URL("/m", target.origin).href : target.demoUrl);
    const ui = makeUi(page, persona, errors);
    if (script.entry !== "signin") await ui.dismissWelcome();
    await script.run(ui);
    await ui.noPageErrors();
    offOrigin.push(...sink.refused);
    if (offOrigin.length) throw new Error(`Demo page requested off-origin ${offOrigin[0]}`);
    result.ok = true;
  } catch (error) {
    result.error = String(error?.message || error).split("\n")[0];
    if (failedRequests.length) result.failedRequests = failedRequests.slice(0, 10);
    if (outDir) {
      result.screenshot = join(outDir, `${script.id}.png`);
      await page.screenshot({ path: result.screenshot, fullPage: true }).catch(() => {});
    }
  } finally {
    result.ms = Date.now() - started;
    await context.close();
    await sink.close();
  }
  return result;
}

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

// What `run` was asked to do. Throws on anything it cannot honour, so a
// mistyped flag never turns into a run of zero scripts that exits 0.
export function parseRunArgs(args) {
  const requested = argValue(args, "--only");
  const only = requested === undefined ? null : [...new Set(requested.split(",").map((id) => id.trim()).filter(Boolean))];
  if (only && !only.length) throw new Error("--only needs at least one script id");
  const unknown = (only ?? []).filter((id) => !SCRIPTS.some((script) => script.id === id));
  if (unknown.length) throw new Error(`Unknown script in --only: ${unknown.join(", ")}`);
  return {
    scripts: only ? SCRIPTS.filter((script) => only.includes(script.id)) : SCRIPTS,
    outDir: argValue(args, "--out"),
    baseUrl: argValue(args, "--base-url"),
    headed: args.includes("--headed"),
  };
}

async function main(args) {
  const command = args[0] || "list";
  if (command === "list") {
    for (const script of SCRIPTS) console.log(`${script.id}\t${script.bot}\t${script.title}`);
    return 0;
  }
  if (command === "coverage") {
    const missing = uncovered();
    console.log(`${FUNCTIONS.length - missing.length}/${FUNCTIONS.length} demo functions covered`);
    for (const id of missing) console.log(`missing ${id}`);
    return missing.length ? 1 : 0;
  }
  if (command === "lint") {
    const problems = lintKit();
    for (const problem of problems) console.error(problem);
    console.log(problems.length ? `${problems.length} problem(s)` : "ok");
    return problems.length ? 1 : 0;
  }
  if (command !== "run") {
    console.error(`Unknown command ${command}`);
    return 2;
  }
  const { scripts, outDir: requestedOut, baseUrl: suppliedBase, headed } = parseRunArgs(args);
  const outDir = resolve(requestedOut || join(here, ".runs", new Date().toISOString().replace(/[:.]/g, "-")));
  // Resolve before a server or browser starts, so a refused target does nothing.
  if (suppliedBase) resolveDemoTarget(suppliedBase);
  let server = null;
  let browser = null;
  let target;
  const results = [];
  try {
    server = suppliedBase ? null : await startPreview();
    target = resolveDemoTarget(suppliedBase || server.baseUrl);
    browser = await launchBrowser({ headed });
    await mkdir(outDir, { recursive: true });
    for (const script of scripts) {
      const result = await runScript(browser, target, script, { outDir });
      results.push(result);
      console.log(`${result.ok ? "pass" : "FAIL"} ${result.id} (${result.persona}, ${result.ms} ms)${result.ok ? "" : `: ${result.error}`}`);
    }
  } finally {
    await browser?.close();
    await server?.close();
  }
  await writeFile(join(outDir, "report.json"), `${JSON.stringify({ target: target.origin, results }, null, 2)}\n`);
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} scripts passed; report ${join(outDir, "report.json")}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error?.message || error);
    process.exitCode = 2;
  });
}
