// @vitest-environment node
// #9515: after a keyboard role switch on the demo host, focus lands on the new
// desk's main region, named for the role. #7397's test only read App.jsx as
// text; this runs the real App in Chromium (SAMPLE client and member load are
// stand-ins). The interim /m page takes focus during the load, as any control
// on it can; the desk must still get focus after.
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";
import { SAMPLE_HOST } from "./helpers/fictional-provider.js";

const fixtures = resolve("tests/fixtures/demo-role-switch-focus");
const swaps = new Map(["supabase", "memberApi"].map((name) => [resolve(`src/lib/${name}.js`), join(fixtures, `${name}.js`)]));
const timeout = runnerTimeout(30000);
let browser, server, port, cache;

const swapBackend = {
  name: "swap-sample-backend",
  enforce: "pre",
  async resolveId(source, importer, options) {
    if (source.endsWith("memberApi.js?real")) return resolve("src/lib/memberApi.js");
    if (importer?.startsWith(fixtures)) return null;
    const id = (await this.resolve(source, importer, { ...options, skipSelf: true }))?.id?.split("?")[0];
    return swaps.get(id) ?? null;
  },
  configureServer(dev) {
    dev.middlewares.use(async (request, response, next) => {
      if (!/^\/m(\/|\?|$)/.test(request.url)) return next();
      const page = await readFile(resolve("tests/fixtures/demo-role-switch-focus-browser.html"), "utf8");
      response.setHeader("content-type", "text/html");
      response.end(await dev.transformIndexHtml(request.url, page));
    });
  },
};

beforeAll(async () => {
  cache = await mkdtemp(join(tmpdir(), "demo-role-switch-focus-"));
  server = await createServer({
    configFile: false, envFile: false, root: resolve("."), cacheDir: cache, plugins: [swapBackend, react()], logLevel: "error",
    server: { host: "127.0.0.1", port: 0, watch: null, allowedHosts: true },
  });
  await server.listen();
  port = server.httpServer.address().port;
  browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${SAMPLE_HOST} 127.0.0.1`] });
}, runnerTimeout(60000));

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (cache) await rm(cache, { recursive: true, force: true });
});

const words = {
  en: { trigger: /^Switch role, current/, current: "Switch role, current: ", main: "Primary workspace: ", group: "Switch role", roles: { steward: "Committee", coordinator: "Campaign lead", admin: "Admin" } },
  es: { trigger: /^Cambiar de rol, actual/, current: "Cambiar de rol, actual: ", main: "Espacio de trabajo principal: ", group: "Cambiar de rol", roles: { steward: "Comité", coordinator: "Liderazgo de campaña" } },
};

it.each([
  ["classic", 1280, "en", "steward", "coordinator"],
  ["classic", 1280, "en", "member", "steward"],
  ["alt", 1280, "en", "steward", "coordinator"],
  ["classic", 900, "en", "member", "steward"],
  ["classic", 1280, "es", "steward", "coordinator"],
  // The Admin sign-in fails: the rollback's own navigation drops the request
  // and points it at the desk the visitor is back on.
  ["classic", 1280, "en", "steward", "admin"],
])("%s shell at %i px (%s): a keyboard switch from %s to %s ends on the new desk, named for the role", async (shell, width, lang, from, to) => {
  const fails = to === "admin";
  const copy = words[lang];
  const context = await browser.newContext({ viewport: { width, height: 800 }, serviceWorkers: "block" });
  context.setDefaultTimeout(timeout);
  await context.addInitScript((language) => {
    localStorage.setItem("sg-lang", language);
    localStorage.setItem("sg:demo:desktop-hat-intro-seen:v1", "true");
    // The stand-in arms on the switch's own first step, the push of its
    // destination. Armed before the key press, it acted on a member's start
    // page (itself /m): a late render there moved focus to the Home heading,
    // Enter switched nothing and the URL wait timed out.
    const push = history.pushState;
    // The real push runs first and the check reads only the address it left,
    // so the stand-in can never stop or alter a push.
    history.pushState = function pushState(...args) {
      const result = push.apply(this, args);
      if (window.__switchTo && location.pathname === `/m/${window.__switchTo}`) window.__switching = true;
      return result;
    };
    new MutationObserver(() => {
      if (!window.__switching || window.__interimFocused || location.pathname !== "/m") return;
      const target = document.querySelector("#main-content :is(h1, h2, .view-loading)");
      if (!target) return;
      window.__interimFocused = true;
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }).observe(document, { subtree: true, childList: true });
  }, lang);
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== SAMPLE_HOST) return route.abort("blockedbyclient");
    if (url.pathname === "/api/demo-session") {
      const { hat } = JSON.parse(route.request().postData());
      if (hat === "admin") return route.fulfill({ status: 503, json: {} });
      return route.fulfill({ json: { accessToken: `access-${hat}`, refreshToken: `refresh-${hat}` } });
    }
    return url.pathname.startsWith("/api/") ? route.fulfill({ status: 204, body: "" }) : route.continue();
  });
  const page = await context.newPage();
  try {
    await page.goto(`http://${SAMPLE_HOST}:${port}/m${from === "member" ? "" : `/${from}`}?shell=${shell}&startHat=${from}`);
    const role = copy.roles[to];
    if (width >= 1024) {
      // The top-rail menu: Enter opens it on the current role, arrows move.
      const trigger = page.getByRole("button", { name: copy.trigger });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const item = page.getByRole("menuitemradio", { name: role, exact: true });
      await item.waitFor();
      while (!(await item.evaluate((node) => node === document.activeElement))) await page.keyboard.press("ArrowDown");
    } else {
      await page.getByRole("group", { name: copy.group }).getByRole("button", { name: role, exact: true }).focus();
    }
    await page.evaluate((hat) => { window.__switchTo = hat; }, to);
    await page.keyboard.press("Enter");
    if (fails) await page.getByText("Could not switch roles. Try again.").waitFor();
    else await page.waitForURL(new RegExp(`/m/${to}`));
    const landed = fails ? from : to;
    await page.locator("#main-content h1").waitFor();
    await page.waitForTimeout(1500);
    const focused = await page.evaluate(() => {
      const node = document.activeElement;
      const box = node.getBoundingClientRect();
      return { id: node.id, name: node.getAttribute("aria-label"), visible: box.height > 0 && box.top < innerHeight, scrollY, interim: window.__interimFocused };
    });
    expect({ ...focused, interim: fails || focused.interim }).toEqual({ id: "main-content", name: copy.main + copy.roles[landed], visible: true, scrollY: 0, interim: true });
    if (width >= 1024) expect(await page.getByRole("button", { name: copy.current + copy.roles[landed] }).isVisible()).toBe(true);
  } finally {
    await context.close();
  }
}, runnerTimeout(90000));
