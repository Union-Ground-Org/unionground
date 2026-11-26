// @vitest-environment node
// Exercise FormsView in Chromium: jsdom cannot prove the native Tab order.
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, expect as browserExpect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";

let browser, server, origin, cache;
beforeAll(async () => {
  cache = await mkdtemp(join(tmpdir(), "forms-step-focus-"));
  server = await createServer({
    configFile: false, envFile: false, root: process.cwd(), cacheDir: cache,
    plugins: [react()], logLevel: "error", server: { host: "127.0.0.1", port: 0, watch: null },
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
}, BROWSER_HOOK_TIMEOUT);
afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (cache) await rm(cache, { recursive: true, force: true });
});

for (const lang of ["en", "es"]) it.each([1440, 320])(`keeps forward and backward step focus in ${lang} at %i CSS px`, async (width) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const copy = lang === "en"
    ? { schedule: "Current schedule", requested: "Requested arrangement", reason: "Reason", why: "Why", review: "Review & submit", next: "Next", back: "Back", step: (n) => `Step ${n} of 3` }
    : { schedule: "Horario actual", requested: "Arreglo solicitado", reason: "Motivo", why: "Por qué", review: "Revisar y enviar", next: "Siguiente", back: "Atrás", step: (n) => `Paso ${n} de 3` };
  async function checkStart(name, position, first) {
    const heading = page.getByRole("heading", { name, exact: true });
    await browserExpect(heading).toBeFocused();
    await browserExpect(heading).toHaveAccessibleDescription(copy.step(position));
    await page.keyboard.press("Tab");
    await browserExpect(first).toBeFocused();
  }
  try {
    await page.goto(`${origin}/tests/fixtures/forms-step-focus-browser.html?lang=${lang}`);
    const schedule = page.getByRole("textbox", { name: copy.schedule, exact: true });
    await schedule.focus();
    await page.keyboard.type("Fixture schedule");
    await page.keyboard.press("Tab");
    const requested = page.getByRole("textbox", { name: copy.requested });
    await browserExpect(requested).toBeFocused();
    await page.keyboard.type("Fixture arrangement");
    // Traverse all five telework choices to Next with the native Tab key.
    for (let i = 0; i < 6; i += 1) await page.keyboard.press("Tab");
    await browserExpect(page.getByRole("button", { name: copy.next, exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    const reason = page.getByRole("textbox", { name: copy.reason, exact: true });
    await checkStart(copy.why, 2, reason);
    await page.keyboard.type("Fixture reason");
    await page.keyboard.press("Tab"); // Duration
    await page.keyboard.type("Fixture duration");
    await page.keyboard.press("Tab"); // Back
    await page.keyboard.press("Tab"); // Next
    await page.keyboard.press("Enter");
    await checkStart(copy.review, 3, page.locator(".message-section input[type=file]"));
    await browserExpect(page.getByText("Fixture arrangement", { exact: true })).toBeVisible();
    await browserExpect(page.getByText("Fixture reason", { exact: true })).toBeVisible();
    // Review's only actions after the attachment input are Back and disabled
    // Submit: no signature has been drawn in this fixture.
    await page.keyboard.press("Tab");
    await browserExpect(page.getByRole("button", { name: copy.back, exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await checkStart(copy.why, 2, reason);
    await browserExpect(reason).toHaveValue("Fixture reason");
    await page.keyboard.press("Tab"); // Duration
    await page.keyboard.press("Tab"); // Back
    await page.keyboard.press("Enter");
    await checkStart(copy.schedule, 1, schedule);
    await browserExpect(schedule).toHaveValue("Fixture schedule");
    await browserExpect(requested).toHaveValue("Fixture arrangement");
    await browserExpect.poll(() => page.evaluate(() => window.__savedDrafts.at(-1)?.step)).toBe(0);
    expect(await page.evaluate(() => window.__savedDrafts.at(-1).answers)).toEqual({
      schedule: "Fixture schedule", requested: "Fixture arrangement", reason: "Fixture reason", duration: "Fixture duration",
    });
    // Completing an autosave must not move focus away from an editable field.
    await browserExpect(schedule).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  } finally { await page.close(); }
}, 60000);
