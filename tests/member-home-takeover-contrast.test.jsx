// The unread takeover must keep its text readable throughout its entrance,
// including when a responsive Home remount starts the animation again.
import { render } from "@testing-library/react";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { HomeTakeover } from "../src/features/memberHome/HomeTakeover.jsx";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";

const css = (await Promise.all([
  "sg-tokens.css", "styles.css", "coordinator-theme.css", "motion.css",
  "features/memberHome/homeTakeover.css",
].map(path => readFile(resolve("src", path), "utf8")))).join("\n");
let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

function markup() {
  const data = {
    conversations: [{ id: "tamarack-conversation", unread: 1, messages: [{
      id: "tamarack-message", sender_kind: "steward", sender_name: "Rosa Boateng",
      body: "The posted schedule is restored Monday. Keep your next stub so we can verify the differential.",
      created_at: "2026-11-07T14:00:00Z", read_at: null,
    }] }],
    broadcasts: [],
  };
  const view = render(<LanguageProvider lang="en"><HomeTakeover data={data}
    transport={{ preview: true }} onOpenConversation={vi.fn()} onMarkConversationRead={vi.fn()} />
  </LanguageProvider>);
  const html = view.container.innerHTML;
  view.unmount();
  return html;
}

it.each([1440, 320].flatMap(width => ["no-preference", "reduce"].map(motion => [width, motion])))(
  "keeps the takeover readable during entry and control states at %i px with %s motion",
  async (width, reducedMotion) => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: "light", reducedMotion });
    try {
      await page.setContent(`<html lang="en"><head><title>Member Home contrast</title></head><body><main class="sg-app" data-workspace-theme="union-ground"><h1>Home</h1>${markup()}</main></body></html>`);
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ path: resolve("node_modules/axe-core/axe.min.js") });
      await page.evaluate(() => Promise.all(document.getAnimations()
        .filter(animation => animation instanceof CSSTransition).map(animation => animation.finished)));
      await page.evaluate(() => {
        const card = document.querySelector(".home-takeover__card");
        card.style.animationName = "none";
        getComputedStyle(card).animationName;
        card.style.animationPlayState = "paused";
        card.style.animationFillMode = "both";
        card.style.removeProperty("animation-name");
      });
      // Freeze the shipped keyframes rather than waiting for the fade to end.
      for (const at of [40, 90, 180]) {
        await page.evaluate(time => {
          for (const animation of document.querySelector(".home-takeover__card").getAnimations()) animation.currentTime = time;
        }, at);
        const result = await page.evaluate(async () => {
          const audit = await window.axe.run(".home-takeover", { runOnly: ["color-contrast"] });
          return { violations: audit.violations, incomplete: audit.incomplete,
            opacity: getComputedStyle(document.querySelector(".home-takeover__card")).opacity };
        });
        expect(result.violations, `entrance at ${at}ms`).toEqual([]);
        expect(result.incomplete, `unmeasured takeover text at ${at}ms`).toEqual([]);
        expect(result.opacity).toBe("1");
      }
      for (const selector of [".home-takeover__open", ".home-takeover__read"]) {
        const control = page.locator(selector);
        await control.hover();
        await control.focus();
        const audit = await page.evaluate(() => window.axe.run(".home-takeover", { runOnly: ["color-contrast"] }));
        expect(audit.violations, `${selector} hover and focus`).toEqual([]);
        expect(await control.evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe("none");
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await page.close(); }
  },
);
