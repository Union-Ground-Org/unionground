// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";

describe("Eastern timestamps in Chromium browser time zones", () => {
  let browser;
  let script;
  beforeAll(async () => {
    // Vite (the repository's own bundler) packs the module as a browser global.
    const bundle = await build({ configFile: false, envFile: false, logLevel: "silent", build: { write: false, minify: false,
      lib: { entry: "src/lib/easternTimestamp.js", formats: ["iife"], name: "EasternTimestamp" } } });
    script = (Array.isArray(bundle) ? bundle[0] : bundle).output[0].code;
    browser = await chromium.launch({ headless: true });
  }, BROWSER_HOOK_TIMEOUT);
  afterAll(async () => browser?.close());

  it("renders the same EN/ES winter and summer instants in Los Angeles and Tokyo", async () => {
    const results = [];
    for (const timezoneId of ["America/Los_Angeles", "Asia/Tokyo"]) {
      const context = await browser.newContext({ timezoneId });
      try {
        const page = await context.newPage();
        await page.setContent("<!doctype html><html lang=en><body></body></html>");
        await page.addScriptTag({ content: script });
        const result = await page.evaluate(() => {
          const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
          for (const lang of ["en", "es"]) for (const instant of ["2026-01-15T17:05:00Z", "2026-07-15T17:05:00Z"]) {
            const timestamp = window.EasternTimestamp.formatEasternTimestamp(instant, lang, { daylightName: true });
            const time = document.createElement("time");
            time.lang = lang;
            time.dateTime = timestamp.dateTime;
            time.textContent = timestamp.text;
            document.body.append(time);
          }
          return { zone, stamps: [...document.querySelectorAll("time")].map(time => ({ text: time.textContent, dateTime: time.dateTime })) };
        });
        expect(result.zone).toBe(timezoneId);
        results.push(result.stamps);
      } finally { await context.close(); }
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0].map(stamp => stamp.text)).toEqual([
      "Jan 15, 2026, 12:05 PM EST", "Jul 15, 2026, 1:05 PM EDT",
      "15 ene 2026, 12:05 p. m. EST", "15 jul 2026, 1:05 p. m. EDT",
    ]);
  });
});
