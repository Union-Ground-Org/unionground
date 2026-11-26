// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

const fixtureSource = `
import React from "react";
import { createRoot } from "react-dom/client";
import { MessagesView } from "/src/views/MessagesView.jsx";
import { LanguageProvider } from "/src/lib/LanguageContext.jsx";
import "/src/lib/i18n/allLanguages.js";
import "/src/sg-tokens.css";
import "/src/styles.css";
import "/src/popups.css";
const query = new URLSearchParams(location.search);
const lang = query.get("lang");
const data = {
  member: { id: "tamarack-member" }, broadcasts: [],
  conversations: [{ id: "tamarack-conversation", counterpartRole: "steward", sender: "Tamarack steward", unread: 0, messages: [] }],
  product: { spaces: [], documents: [{ id: "tamarack-resource", status: "published", title: "Tamarack overtime scheduling reference" }] },
};
window.scheduledCalls = [];
const api = {
  schedule: async (conversationId, body, scheduledFor) => {
    window.scheduledCalls.push({ conversationId, body, scheduledFor });
    return { id: "tamarack-scheduled-" + window.scheduledCalls.length };
  },
  cancelScheduled: async () => ({ cancelled: true }),
};
createRoot(document.getElementById("root")).render(
  <LanguageProvider lang={lang}><main className="sg-app" data-workspace-theme="union-ground">
    <MessagesView data={data} desktop={innerWidth >= 1024} messagingApi={api}
      onReadConversation={async () => {}} onReadBroadcast={async () => {}} onNotice={() => {}} />
  </main></LanguageProvider>,
);
`;
// Keep at least 2x the observed 9.447s cold-run cost even on slower runners.
const SCHEDULED_TEST_TIMEOUT = runnerTimeout(30_000);
let server, browser, origin, cacheDir;
beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "scheduled-pointer-"));
  const fixtureId = join(process.cwd(), "__scheduled-pointer-fixture.jsx");
  server = await createServer({
    configFile: false, root: process.cwd(), cacheDir,
    optimizeDeps: { include: ["react", "react-dom/client"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
    plugins: [react(), {
      name: "scheduled-pointer-fixture",
      resolveId(id) { if (id === "/__scheduled-pointer-fixture.jsx") return fixtureId; },
      load(id) { if (id === fixtureId) return fixtureSource; },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url?.split("?")[0] !== "/__scheduled-pointer") return next();
          try {
            const html = await vite.transformIndexHtml("/__scheduled-pointer", '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head><body><div id="root"></div><script type="module" src="/__scheduled-pointer-fixture.jsx"></script></body></html>');
            response.setHeader("Content-Type", "text/html"); response.end(html);
          } catch (error) { next(error); }
        });
      },
    }],
  });
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  // Compile the real fixture and its dialog before a measured workflow pays
  // for cold Vite transforms. Every test still gets a separate page/context.
  const warmup = await browser.newPage({ viewport: { width: 320, height: 900 } });
  try {
    await warmup.route("**/*", fixtureRoute);
    await warmup.goto(`${origin}/__scheduled-pointer?lang=en`);
    await warmup.getByRole("button", { name: "Message your committee contact", exact: true }).click();
    await warmup.locator('.inbox-composer input[name="message"]').waitFor({ state: "visible" });
  } finally { await warmup.close(); }
}, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); await server?.close(); if (cacheDir) await rm(cacheDir, { recursive: true, force: true }); });

// Keep real Vite responses while isolating geometry checks from Chromium's
// host-interface ERR_NETWORK_CHANGED cancellations of loopback module loads.
async function fixtureRoute(route) {
  if (new URL(route.request().url()).origin !== origin) return route.abort();
  await route.fulfill({ response: await route.fetch() });
}

it.each(["en", "es"].flatMap(lang => [320, 1440].flatMap(width => ["light", "dark"].map(system => ({ lang, width, system })))))("schedules by pointer and keyboard at $width px ($lang, $system system)", async ({ lang, width, system }) => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: system });
    try {
      await page.route("**/*", fixtureRoute);
      await page.goto(`${origin}/__scheduled-pointer?lang=${lang}`);
      await page.getByRole("button", { name: lang === "en" ? "Message your committee contact" : "Escribe a tu contacto del comité", exact: true }).click();
      const input = page.locator('.inbox-composer input[name="message"]');
      const date = page.locator('.inbox-composer input[type="datetime-local"]');
      const send = page.locator(".inbox-send");
      await input.fill("Tamarack pointer schedule"); await date.fill("2099-11-10T09:00");
      await expect.poll(() => page.locator(".inbox-composer select").isDisabled()).toBe(true);
      await send.scrollIntoViewIfNeeded();
      const geometry = await send.evaluate(button => {
        const r = button.getBoundingClientRect(), field = button.form.querySelector("select").getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { hit: button === top || button.contains(top), sendHeight: r.height, fieldHeight: field.height,
          overlap: field.left < r.right && field.right > r.left && field.top < r.bottom && field.bottom > r.top };
      });
      await send.click({ timeout: 2500 });
      expect(geometry.hit).toBe(true);
      expect(geometry.overlap).toBe(false);
      if (width === 320) {
        expect(geometry.sendHeight).toBeGreaterThanOrEqual(48);
        expect(geometry.fieldHeight).toBeGreaterThanOrEqual(48);
      }
      await page.locator(".inbox-scheduled").waitFor();
      expect(await page.locator(".inbox-scheduled").innerText()).toContain("Tamarack pointer schedule");
      expect(await page.evaluate(() => window.scheduledCalls.length)).toBe(1);
      await input.fill("Tamarack keyboard schedule"); await date.fill("2099-11-10T10:00");
      await page.keyboard.press("Tab");
      await send.focus();
      expect(await send.evaluate(button => {
        const style = getComputedStyle(button);
        return button.matches(":focus-visible") && (style.outlineStyle !== "none" || style.boxShadow !== "none");
      })).toBe(true);
      await page.keyboard.press("Enter");
      await expect.poll(() => page.locator(".inbox-scheduled__row").count()).toBe(2);
      expect(await page.evaluate(() => window.scheduledCalls.length)).toBe(2);
      const cancel = page.locator(".inbox-scheduled__cancel"); await cancel.first().click();
      await expect.poll(() => cancel.count()).toBe(1); await cancel.click();
      await expect.poll(() => cancel.count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await page.close(); }
  }, SCHEDULED_TEST_TIMEOUT);

it.each(["en", "es"].flatMap(lang => ["light", "dark"].map(system => ({ lang, system }))))("keeps scheduled targets at least 48px during dialog entry ($lang, $system system)", async ({ lang, system }) => {
    const page = await browser.newPage({ viewport: { width: 320, height: 900 }, colorScheme: system, reducedMotion: "no-preference" });
    try {
      await page.route("**/*", fixtureRoute);
      await page.goto(`${origin}/__scheduled-pointer?lang=${lang}`);
      // Extend only the duration so a busy runner cannot miss the real CSS
      // entrance before we pause it; its transform endpoints stay unchanged.
      await page.addStyleTag({ content: ".sg-detail-surface { transition-duration: 60s !important; }" });
      await page.getByRole("button", { name: lang === "en" ? "Message your committee contact" : "Escribe a tu contacto del comité", exact: true }).click();
      await page.locator('.sg-detail-layer[data-state="open"]').waitFor();
      const surface = page.locator(".sg-detail-surface");
      await surface.evaluate(element => {
        const animation = element.getAnimations().find(item => item.transitionProperty === "transform");
        if (!animation) throw new Error("Expected the production modal entrance transform transition");
        animation.pause(); animation.currentTime = 0;
      });
      await page.locator('.inbox-composer input[name="message"]').fill("Tamarack entrance target");
      await page.locator('.inbox-composer input[type="datetime-local"]').fill("2099-11-10T09:00");
      const controls = page.locator(".inbox-composer");
      const heights = () => controls.evaluate(form => [...form.querySelectorAll("input, select, .inbox-send")].map(control => control.getBoundingClientRect().height));
      for (const height of await heights()) expect(height).toBeGreaterThanOrEqual(48);
      await surface.evaluate(element => { for (const animation of element.getAnimations()) animation.finish(); });
      for (const height of await heights()) expect(height).toBeGreaterThanOrEqual(48);
    } finally { await page.close(); }
  }, SCHEDULED_TEST_TIMEOUT);
