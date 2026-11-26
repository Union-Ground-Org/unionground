import { fireEvent, render } from "@testing-library/react";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";

// Match the production cascade: the alternate adapter remaps the classic
// badge tokens, and Messages adds its own rules after that adapter.
const css = (await Promise.all([
  "sg-tokens.css", "styles.css", "coordinator-theme.css", "motion.css", "popups.css",
  "alt/styles/design.css", "alt/styles/shell.css", "alt/styles/legacy-adapter.css", "alt/styles/messages.css",
].map(path => readFile(resolve("src", path), "utf8")))).join("\n");
const data = {
  member: { id: "tamarack-member" },
  conversations: [
    { id: "tamarack-unread", sender: "Tamarack Steward", preview: "Schedule question", unread: 2, messages: [] },
    { id: "tamarack-read", sender: "Tamarack colleague", preview: "Meeting notes", unread: 0, messages: [] },
  ],
  broadcasts: [],
  product: { spaces: [], documents: [] },
};
let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

async function readable(badge) {
  // The chip rail scrolls internally at 320px. Bring each count into view so
  // axe must measure it instead of treating a clipped count as unverified.
  await badge.scrollIntoViewIfNeeded();
  const result = await badge.evaluate(async element => {
    // Measure the settled control state. A color transition sampled at 33ms
    // paints #585858 on the selected #14201c chip even in light mode.
    getComputedStyle(element).color;
    await Promise.all(element.closest(".inbox-filters").getAnimations({ subtree: true })
      .filter(animation => animation instanceof CSSTransition).map(animation => animation.finished));
    const audit = await window.axe.run(element, { runOnly: ["color-contrast"] });
    return {
      violations: audit.violations,
      incomplete: audit.incomplete,
      pairs: [...audit.passes, ...audit.violations, ...audit.incomplete]
        .flatMap(rule => rule.nodes.flatMap(node => node.any.map(check => check.data)))
        .filter(pair => pair?.contrastRatio !== undefined),
    };
  });
  expect(result.pairs).toHaveLength(1);
  // These are effective painted foreground/background colors, including
  // opacity compositing; checking the token alone missed the original 4.05:1.
  for (const pair of result.pairs) {
    expect(pair.fgColor).toMatch(/^#[\da-f]{6}$/i);
    expect(pair.bgColor).toMatch(/^#[\da-f]{6}$/i);
    expect(pair.contrastRatio, JSON.stringify(pair)).toBeGreaterThanOrEqual(4.5);
  }
  expect(result.violations).toEqual([]);
  expect(result.incomplete).toEqual([]);
}

it.each([false, true].flatMap(staffAccess => [1440, 320].map(width => [staffAccess, width])))(
  "keeps every inactive and selected filter count readable with staffAccess=%s at %i px",
  async (staffAccess, width) => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/m/messages");
    const view = render(<LanguageProvider lang="en"><MessagesView alt desktop staffAccess={staffAccess}
      data={data} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} />
    </LanguageProvider>);
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: "light" });
    try {
      await page.emulateMedia({ colorScheme: "light" });
      // Install the cascade once before mounting any filter state. Replacing
      // the document and then injecting CSS started artificial black-to-white
      // text transitions, whose sampled frame depended on runner timing.
      await page.setContent('<html lang="en"><head><title>Messages filter contrast</title></head><body><main class="ugalt sg-app" data-workspace-theme="union-ground"><div class="ug-msg-filters"></div></main></body></html>');
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ path: resolve("node_modules/axe-core/axe.min.js") });
      await page.waitForFunction(() => {
        const workspace = document.querySelector(".ugalt");
        return matchMedia("(prefers-color-scheme: light)").matches
          && workspace?.getAttribute("data-workspace-theme") === "union-ground"
          && getComputedStyle(workspace).colorScheme === "light";
      });
      const filters = view.container.querySelector(".inbox-filters");
      const buttons = [...filters.querySelectorAll("button")];
      const counts = buttons.map(button => button.querySelector("b").textContent);
      expect(counts.slice(0, 3)).toEqual(["2", "1", "2"]);
      for (const [index, button] of buttons.entries()) {
        fireEvent.click(button);
        expect(button).toHaveAttribute("aria-pressed", "true");
        expect(filters.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
        expect(buttons.map(item => item.querySelector("b").textContent)).toEqual(counts);
        if (index < 3) expect(view.container.querySelectorAll(".ug-msg-item")).toHaveLength([2, 1, 2][index]);
        await page.locator(".ug-msg-filters").evaluate((host, markup) => { host.innerHTML = markup; }, filters.outerHTML);
        if (index === 0) {
          for (const badge of await page.locator(".inbox-filters b").all()) await readable(badge);
        } else {
          await readable(page.locator('[aria-pressed="true"] b'));
        }
        const selected = page.locator('[aria-pressed="true"]');
        await selected.hover();
        await selected.focus();
        await readable(selected.locator("b"));
        expect(await selected.evaluate(node => getComputedStyle(node).outlineStyle)).toBe("solid");
        const surfaces = await page.locator(".inbox-filters button").evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
        expect(surfaces[index]).not.toBe(surfaces[(index + 1) % surfaces.length]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    } finally { view.unmount(); await page.close(); }
  },
  30_000,
);
