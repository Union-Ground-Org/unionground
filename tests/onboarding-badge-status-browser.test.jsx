import { chromium } from "@playwright/test";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { OnboardingHud } from "../src/components/OnboardingHud.jsx";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";

const css = ["sg-tokens.css", "styles.css", "components/OnboardingHud.css"].map((path) => readFileSync(`src/${path}`, "utf8")).join("\n");
const guide = { applies: true, showHud: true, stage: "complete", badge: "ready_to_roll", totalSteps: 6, completedSteps: 6 };
let browser;
beforeAll(async () => { browser = await chromium.launch(); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });
afterEach(cleanup);
const luminance = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => v / 255)
  .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);

describe.each(["en", "es"])("onboarding status badge (%s)", (lang) => {
  for (const theme of ["union-ground"]) {
    it.each([1280, 390])(`uses the status tint rather than action fill in ${theme} at %i px`, async (width) => {
      const { container } = render(<LanguageProvider lang={lang}><OnboardingHud guide={guide} /></LanguageProvider>);
      const badge = container.querySelector(".onboarding-hud__badge");
      expect(badge.tagName).toBe("SPAN");
      expect(badge).not.toHaveAttribute("tabindex");
      expect(badge).not.toHaveAttribute("role", "button");
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.setContent(`<main class="sg-app" data-workspace-theme="${theme}">${container.innerHTML}</main>`);
        await page.addStyleTag({ content: css });
        const colors = await page.locator(".onboarding-hud__badge").evaluate((node) => {
          const s = getComputedStyle(node), probe = document.createElement("span");
          probe.style.background = "var(--secondary)";
          probe.style.color = "var(--secondary-foreground)";
          node.append(probe);
          const expected = getComputedStyle(probe);
          const values = { background: s.backgroundColor, color: s.color, statusBackground: expected.backgroundColor, statusColor: expected.color,
            actionBackground: getComputedStyle(document.querySelector(".onboarding-hud__cta")).backgroundColor };
          probe.remove(); return values;
        });
        expect(colors.background).toBe(colors.statusBackground);
        expect(colors.color).toBe(colors.statusColor);
        expect(colors.background).not.toBe(colors.actionBackground);
        const a = luminance(colors.color), b = luminance(colors.background);
        expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      } finally { await page.close(); }
    });
  }
});
