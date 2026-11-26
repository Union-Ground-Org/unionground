// @vitest-environment node
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";

const css = ["sg-tokens.css", "styles.css"]
  .map((name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8")).join("\n");
let browser;
beforeAll(async () => { browser = await chromium.launch(); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

function luminance(color) {
  return color.match(/[\d.]+/g).slice(0, 3).map(Number)
    .map((value) => value / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}

describe.each(["union-ground"])("invitation-card action ink (%s)", (theme) => {
  it.each([1440, 320])("keeps link buttons readable at %i CSS px in every interaction state", async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.setContent(`<!doctype html><html><body>
        <main class="sg-app" data-workspace-theme="${theme}">
          <section class="auth-card iac-card">
            <a class="iac-action" href="/auth" lang="en">Sign in on the website</a>
            <a class="iac-action" href="/auth" lang="es">Entrar en el sitio web</a>
            <button class="iac-action">Continue</button>
            <p class="sgauth-recovery"><a href="/password-reset">Reset password</a></p>
            <p><a href="mailto:support@example.test">Support</a></p>
            <a class="auth-submit" href="/auth">Sign in</a>
          </section>
        </main>
      </body></html>`);
      await page.addStyleTag({ content: css });
      // The theme's 150ms colour and background transitions (#8663) left a
      // link mid-fade when its colour was read right after hover, focus and
      // press, so the comparisons below flaked by one RGB step. The test reads
      // settled colours, so the harness turns transitions off.
      await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
      await page.evaluate(() => document.addEventListener("click", (event) => event.preventDefault()));
      for (const action of await page.locator("a.iac-action").all()) {
        for (const state of ["rest", "hover", "focus", "active"]) {
          if (state === "hover") await action.hover();
          if (state === "focus") await action.focus();
          if (state === "active") await page.mouse.down();
          const colors = await action.evaluate((node) => {
            const probe = document.createElement("span");
            probe.style.color = "var(--primary-foreground)";
            node.append(probe);
            const expected = getComputedStyle(probe).color;
            probe.remove();
            const style = getComputedStyle(node);
            return { actual: style.color, background: style.backgroundColor, expected };
          });
          expect(colors.actual, `${theme}/${width}/${state}`).toBe(colors.expected);
          const ink = luminance(colors.actual);
          const background = luminance(colors.background);
          expect((Math.max(ink, background) + 0.05) / (Math.min(ink, background) + 0.05)).toBeGreaterThanOrEqual(4.5);
          if (state === "active") await page.mouse.up();
        }
      }
      // Ordinary support/recovery links retain their product ink; both
      // kinds of button retain their own foreground.
      expect(await page.locator(".sgauth-recovery a").evaluate((node) => getComputedStyle(node).color))
        .toBe(await page.locator('a[href^="mailto:"]').evaluate((node) => getComputedStyle(node).color));
      for (const selector of ["button.iac-action", "a.auth-submit"]) {
        expect(await page.locator(selector).evaluate((node) => getComputedStyle(node).color))
          .toBe(await page.locator("a.iac-action").first().evaluate((node) => getComputedStyle(node).color));
      }
    } finally { await page.close(); }
  });
});
