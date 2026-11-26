// Vitest global setup: launch Chromium once per CI run (each shard is one
// run) before any worker starts. A Depot job installs Chromium fresh, and the
// first launch also builds its caches; doing that here keeps it out of every
// browser suite's beforeAll budget (run 40698708004, "Hook timed out in
// 10000ms"). Best effort: a job without Chromium installed runs no browser
// suite, so a failed warm-up is reported and never fails the run.
import { chromium } from "@playwright/test";

export default async function warmChromium() {
  if (!process.env.CI) return;
  const started = Date.now();
  try {
    const browser = await chromium.launch({ headless: true, timeout: 120_000 });
    await browser.close();
    console.log(`Chromium warm-up: ${Date.now() - started} ms`);
  } catch (error) {
    console.warn(`Chromium warm-up skipped: ${error.message.split("\n")[0]}`);
  }
}
