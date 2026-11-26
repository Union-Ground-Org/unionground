// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { readFile } from "node:fs/promises";

// REQ-UG-SITEWIDE-NEUROMAP-PAPER-VISUAL-LANGUAGE-20261104 (owner order,
// November 4, 2026) retires the Step 2 rule this file used to prove ("the
// public landing and the sign-in screens keep today's token values ... a dark
// system setting cannot reach a public page"). Every page now reads the
// Neuromap sample's paper. The landing, sign-in and public document pages wrap
// themselves in the identity scope (src/components/IdentityThemeScope.jsx),
// which renders `union-ground` only since the owner's order of November 5,
// 2026 (REQ-UG-DISABLE-DARK-MODE-WEB-AND-MOBILE-20261105); its dormant dark
// form is deleted. The look is chosen by that attribute,
// never by a CSS media query, so the same markup measures the same under
// either system setting; tests/identity-theme-scope.test.jsx pins the light
// choice.
let browser;
const css = (await Promise.all(["sg-tokens.css", "styles.css", "lifecycle.css"]
  .map((path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8")))).join("\n");
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

const publicRoots = (theme) => `
  <div class="sg-app sg-app--public" data-workspace-theme="${theme}" data-probe="${theme}">
    <main class="auth-screen"><section class="auth-card"><h1>Sign in</h1></section></main>
    <div class="public-site"><header class="public-header"><h1>Union Ground</h1></header></div>
  </div>`;

async function measure(colorScheme, fixture) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme });
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${fixture}</body></html>`);
    await page.addStyleTag({ content: css });
    return await page.evaluate(() => {
      const read = (node) => {
        const style = getComputedStyle(node);
        return {
          primary: style.getPropertyValue("--primary").trim(),
          muted: style.getPropertyValue("--muted").trim(),
          background: style.backgroundColor,
          color: style.color,
          colorScheme: style.colorScheme,
        };
      };
      const within = (probe, selector) => read(document.querySelector(`[data-probe="${probe}"] ${selector}`));
      const html = getComputedStyle(document.documentElement);
      return {
        root: read(document.body),
        html: { background: html.backgroundColor, colorScheme: html.colorScheme },
        light: document.querySelector('[data-probe="union-ground"]')
          ? { signIn: within("union-ground", ".auth-screen"), landing: within("union-ground", ".public-site") } : null,
      };
    });
  } finally {
    await page.close();
  }
}

const PAPER = "rgb(244, 242, 236)"; // the sample's --page, #f4f2ec

it("paints the Neuromap paper on the root and on the light public roots", async () => {
  const { root, light, html } = await measure("light", publicRoots("union-ground"));
  expect(root).toMatchObject({ primary: "#0e4034", muted: "#ebe7dc", background: PAPER });
  expect(html.background).toBe(PAPER);
  expect(light.signIn).toMatchObject({ primary: "#0e4034", background: PAPER, colorScheme: "light" });
  // The theme guide's ink #14201c, not the forest stage colour #0d241e (record
  // UX-UG-PUBLIC-PAGES-AND-MARK-TAKE-THEME-GUIDE-VALUES-20261113).
  expect(light.landing).toMatchObject({ background: PAPER, color: "rgb(20, 32, 28)", colorScheme: "light" });
}, 30000);

it("lets the rendered attribute, not the media query, choose the look", async () => {
  const underLight = await measure("light", publicRoots("union-ground"));
  const underDark = await measure("dark", publicRoots("union-ground"));
  expect(underDark.light).toEqual(underLight.light);
  expect(underDark.html).toEqual(underLight.html);
}, 30000);
