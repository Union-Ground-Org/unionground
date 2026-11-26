// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, expect as browserExpect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

let browser, server, origin, cache;
beforeAll(async () => {
  cache = await mkdtemp(join(tmpdir(), "two-step-browser-"));
  server = await createServer({ configFile: false, envFile: false, root: process.cwd(), cacheDir: cache,
    plugins: [react()], logLevel: "error", server: { host: "127.0.0.1", port: 0, watch: null } });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
}, runnerTimeout(60000));
afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (cache) await rm(cache, { recursive: true, force: true });
});

describe("two-step and session controls in Chromium", () => {
  it("keeps keyboard entry in order and exposes QR, recovery and device controls", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`${origin}/tests/fixtures/two-step-session-controls.html`);
      await page.getByRole("button", { name: "Turn on two-step sign-in" }).click();
      const qr = page.locator(".mfa-qr");
      await browserExpect(qr).toBeInViewport();
      const input = page.getByLabel("Code from your app");
      await input.pressSequentially("012345");
      await browserExpect(input).toHaveValue("012345");
      await input.press("Backspace");
      await input.pressSequentially("6");
      await browserExpect(input).toHaveValue("012346");
      expect(await input.evaluate(el => el.selectionStart)).toBe(6);
      if (process.env.TWO_STEP_PROOF_DIR) {
        await mkdir(process.env.TWO_STEP_PROOF_DIR, { recursive: true });
        await page.locator(".mfa-enroll").screenshot({ path: join(process.env.TWO_STEP_PROOF_DIR, "enrollment-light.png") });
      }
      await page.getByRole("button", { name: "Verify", exact: true }).click();
      await browserExpect(page.getByText("Two-step verified", { exact: true })).toBeVisible();
      await browserExpect(page.getByText(/keep them in your password manager/)).toBeVisible();
      await page.getByRole("button", { name: "Sign out Apple mobile device · Safari" }).click();
      await page.getByRole("button", { name: "Confirm device sign-out" }).click();
      await browserExpect(page.getByText("Apple mobile device · Safari", { exact: true })).toHaveCount(0);
      await browserExpect(page.getByText("Linux computer · Chrome", { exact: true })).toBeVisible();
      await page.setViewportSize({ width: 320, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole("button", { name: "Sign out everywhere", exact: true }).click();
      await page.getByRole("button", { name: "Confirm sign out everywhere" }).click();
      await browserExpect(page.getByRole("heading", { name: "Sign in to Union Ground" })).toBeVisible();
    } finally { await page.close(); }
  }, runnerTimeout(60000));
});
