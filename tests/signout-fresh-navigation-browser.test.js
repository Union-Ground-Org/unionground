// @vitest-environment node
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chromium, expect as browserExpect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";
import { SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";

const userId = "00000000-0000-4000-8000-000000000102";
const backend = SUPABASE_ORIGIN;
const storageKey = `sb-${SUPABASE_REF}-auth-token`;
let browser, server, origin, cache;
// Every full document load (goto, reload, new page) boots the whole dev
// module graph; App.jsx alone is over 500 KB. On a loaded runner the boot
// after a reload can outrun Playwright's fixed 30 s defaults, so each boot
// (and the navigation that starts it) waits on the runner-scaled budget.
const bootTimeout = runnerTimeout(30000);

function session(id) {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const payload = Buffer.from(JSON.stringify({ sub: userId, session_id: id, exp: expires, aal: "aal2" })).toString("base64url");
  return {
    user: { id: userId, email: "synthetic@example.invalid", factors: [] },
    access_token: `header.${payload}.signature`, refresh_token: `synthetic-${id}`,
    token_type: "bearer", expires_at: expires, expires_in: 3600,
  };
}

beforeAll(async () => {
  cache = await mkdtemp(join(tmpdir(), "signout-browser-"));
  // The build pins its one Union Ground project; the fictional ref stands in.
  vi.stubEnv("VITE_UNIONGROUND_SUPABASE_REF", SUPABASE_REF);
  server = await createServer({
    configFile: false, envFile: false, root: fileURLToPath(new URL("..", import.meta.url)),
    cacheDir: cache, plugins: [react()], logLevel: "error",
    define: { __BUILD_SHA__: JSON.stringify("0000000000000000000000000000000000000000") },
    // This fixed-source browser test never needs HMR or a repository watcher.
    server: { host: "127.0.0.1", port: 0, watch: null },
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
}, runnerTimeout(60000));

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (cache) await rm(cache, { recursive: true, force: true });
});

async function profile(captured, { prepareDelayMs = 0 } = {}) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  // Covers every goto, reload and back navigation, and pages opened later.
  context.setDefaultNavigationTimeout(bootTimeout);
  const requests = [];
  await context.routeWebSocket("**", socket => socket.close());
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin && !url.pathname.startsWith("/api/")) return route.continue();
    if (url.origin === origin && url.pathname === "/api/runtime-config") {
      return route.fulfill({ contentType: "application/javascript", body: "" });
    }
    if (url.origin !== backend && url.origin !== origin) return route.abort("blockedbyclient");
    requests.push({ path: url.pathname, scope: url.searchParams.get("scope"), method: request.method() });
    const headers = { "access-control-allow-origin": "*" };
    if (url.pathname === "/rest/v1/rpc/prepare_my_signout") {
      if (prepareDelayMs) await new Promise(resolve => setTimeout(resolve, prepareDelayMs));
      return route.fulfill({ json: { serverCleanupComplete: true }, headers });
    }
    if (url.pathname === "/auth/v1/logout") return route.fulfill({ status: 204, headers });
    if (url.pathname === "/auth/v1/user") return route.fulfill({ json: captured?.user || null, headers });
    // A failed member-data load exposes the real App sign-out control without
    // inventing member records. Only the synthetic provider boundary is mocked.
    return route.fulfill({ status: 503, json: { message: "Synthetic data unavailable" }, headers });
  });
  await context.addInitScript(({ backend, captured, storageKey }) => {
    globalThis.__UNIONGROUND_RUNTIME_CONFIG__ = {
      configured: true, surface: "saas", supabaseUrl: backend,
      supabasePublishableKey: "sb_publishable_synthetickey0123",
    };
    // Seed once per isolated browser storage realm, never on reload.
    if (!localStorage.getItem("synthetic-profile-seeded")) {
      if (captured) localStorage.setItem(storageKey, JSON.stringify(captured));
      localStorage.setItem("synthetic-profile-seeded", "yes");
      localStorage.setItem("unrelated-preference", "keep");
    }
  }, { backend, captured, storageKey });
  const page = await context.newPage();
  await page.goto(`${origin}/m`);
  return { context, page, requests };
}

it("keeps a local sign-out across reload and a new page while another browser session stays signed in", async () => {
  const first = await profile(session("00000000-0000-4000-8000-000000000301"));
  const second = await profile(session("00000000-0000-4000-8000-000000000302"));
  try {
    await browserExpect(first.page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible({ timeout: bootTimeout });
    await first.page.evaluate(() => {
      history.pushState({}, "", "/m/messages?thread=previous#message");
      history.pushState({}, "", "/m/settings");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await first.page.getByRole("button", { name: "Sign out", exact: true }).click();
    await browserExpect(first.page.getByRole("heading", { name: "Sign in to Union Ground", exact: true })).toBeVisible();
    // An explicit sign-out lands on / with no return-to intent
    // (BUG-UG-SIGN-OUT-KEEPS-THE-LAST-PAGE-ADDRESS-20261006), and a
    // reload of that tab reopens the sign-in card itself, not the public
    // landing page (REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030,
    // finding 93).
    expect(new URL(first.page.url()).pathname).toBe("/");
    // Reload BEFORE sanitizing the earlier entries: the explicit sign-out
    // decision must outlive this document, not only its mounted React refs.
    await first.page.reload();
    await browserExpect(first.page.getByRole("heading", { name: "Sign in to Union Ground", exact: true })).toBeVisible({ timeout: bootTimeout });
    await browserExpect(first.page.locator("main.site-home-main")).toHaveCount(0);
    // Neither direction through earlier SPA entries may restore the departed
    // member's address or requested-page intent.
    for (const move of ["goBack", "goBack", "goForward", "goForward"]) {
      await first.page[move]();
      await browserExpect(first.page).toHaveURL(`${origin}/`);
      await browserExpect(first.page.getByText("Your requested page is waiting. Sign in and you’ll return there automatically.")).toHaveCount(0);
    }
    await first.page.reload();
    await browserExpect(first.page.getByRole("heading", { name: "Sign in to Union Ground", exact: true })).toBeVisible({ timeout: bootTimeout });
    await browserExpect(first.page.locator("main.site-home-main")).toHaveCount(0);
    await browserExpect(first.page.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
    const fresh = await first.context.newPage();
    await fresh.goto(`${origin}/m`);
    await browserExpect(fresh.getByRole("heading", { name: "Sign in to Union Ground", exact: true })).toBeVisible({ timeout: bootTimeout });
    expect(await fresh.evaluate(() => localStorage.getItem("unrelated-preference"))).toBe("keep");
    expect(first.requests.filter(request => request.path === "/auth/v1/logout"))
      .toEqual([{ path: "/auth/v1/logout", scope: "local", method: "POST" }]);
    await second.page.reload();
    await browserExpect(second.page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible({ timeout: bootTimeout });
    expect(second.requests.some(request => request.path === "/auth/v1/logout")).toBe(false);
  } finally {
    await first.context.close();
    await second.context.close();
  }
}, runnerTimeout(150000));

it("keeps sign-in-required intent through Back, Forward and reload without an explicit sign-out", async () => {
  const visit = await profile(null);
  const requested = "Your requested page is waiting. Sign in and you’ll return there automatically.";
  try {
    await browserExpect(visit.page.getByRole("heading", { name: "Sign in to Union Ground", exact: true })).toBeVisible({ timeout: bootTimeout });
    await visit.page.evaluate(() => {
      history.pushState({}, "", "/m/messages?thread=requested#message");
      history.pushState({}, "", "/m/settings?section=privacy#account");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await browserExpect(visit.page.getByText(requested)).toHaveCount(1);
    await visit.page.goBack();
    await browserExpect(visit.page).toHaveURL(`${origin}/m/messages?thread=requested#message`);
    await browserExpect(visit.page.getByText(requested)).toHaveCount(1);
    await visit.page.goForward();
    await browserExpect(visit.page).toHaveURL(`${origin}/m/settings?section=privacy#account`);
    await browserExpect(visit.page.getByText(requested)).toHaveCount(1);
    await visit.page.reload();
    await browserExpect(visit.page.getByRole("heading", { name: "Sign in to Union Ground", exact: true })).toBeVisible({ timeout: bootTimeout });
    await browserExpect(visit.page).toHaveURL(`${origin}/m/settings?section=privacy#account`);
    await browserExpect(visit.page.getByText(requested)).toHaveCount(1);
  } finally {
    await visit.context.close();
  }
}, runnerTimeout(150000));

// REQ-UG-FIRST-CLICK-AND-DEAD-CONTROLS-20261030: production sign-out
// waits on two server round trips before the page changes. The first click
// used to leave the button looking untouched, so people clicked again. One
// click now shows the sign-out underway at once, a repeat click joins it, and
// that single click lands on the sign-in page.
it("signs out with a single click and shows it underway while the server is slow", async () => {
  const visit = await profile(session("00000000-0000-4000-8000-000000000303"), { prepareDelayMs: 1500 });
  try {
    const signOut = visit.page.getByRole("button", { name: "Sign out", exact: true });
    await browserExpect(signOut).toBeVisible({ timeout: bootTimeout });
    const box = await signOut.boundingBox();
    await visit.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const pending = visit.page.getByRole("button", { name: "Signing out…", exact: true });
    await browserExpect(pending).toBeDisabled({ timeout: 1000 });
    await browserExpect(pending).toHaveAttribute("aria-busy", "true");
    // A second click while the first is running starts nothing new.
    await visit.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await browserExpect(visit.page.getByRole("heading", { name: "Sign in to Union Ground", exact: true })).toBeVisible({ timeout: bootTimeout });
    expect(new URL(visit.page.url()).pathname).toBe("/");
    expect(visit.requests.filter(request => request.path === "/rest/v1/rpc/prepare_my_signout")).toHaveLength(1);
    expect(visit.requests.filter(request => request.path === "/auth/v1/logout"))
      .toEqual([{ path: "/auth/v1/logout", scope: "local", method: "POST" }]);
  } finally {
    await visit.context.close();
  }
}, runnerTimeout(90000));
