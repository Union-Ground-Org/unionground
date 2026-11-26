import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { render } from "@testing-library/react";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DesktopRail } from "../src/components/DesktopRail.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";

// BUG-UG-STAFF-RAIL-LAST-GROUP-HIDDEN-UNDER-FOOTER-20261106: the
// Command palette entry was pinned inside the scrolling rail list, so at rest
// the row or group heading under it was hidden, and a page opened from
// elsewhere could be highlighted under it. Real layout in desktop Chromium
// with the shipped CSS: the palette sits below the list, and the open page's
// row is scrolled into the list.
const css = (await Promise.all(["sg-tokens.css", "styles.css", "components/OnboardingHud.css"]
  .map((path) => readFile(resolve("src", path), "utf8")))).join("\n");

let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

it("keeps every list row clear of the palette and scrolls the open page's row into the list", async () => {
  const view = render(<LanguageProvider lang="en">
    <div className="sg-app sg-app--desktop" data-workspace-theme="union-ground">
      <DesktopRail active="settings" activeHat="member" demo={false} memberId="member-a" onAsk={() => {}} onNavigate={() => {}} renderMode="desktop" workspaceTheme="union-ground" />
    </div>
  </LanguageProvider>);
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, reducedMotion: "reduce" });
  try {
    await page.route("**/*", (route) => route.abort());
    await page.setContent(`<base href="http://127.0.0.1/">${view.container.innerHTML}`);
    view.unmount();
    await page.addStyleTag({ content: css });
    // The static copy carries no React effect, so apply the reveal the rail
    // performs: the list must be able to bring the open row fully into view.
    const geometry = await page.evaluate(() => {
      const list = document.querySelector(".desktop-rail__items:not(.desktop-rail__items--foot)");
      const palette = document.querySelector(".desktop-rail__palette");
      const row = list.querySelector('[aria-current="page"]');
      const before = row.getBoundingClientRect().bottom > list.getBoundingClientRect().bottom;
      row.scrollIntoView({ block: "nearest" });
      const listBox = list.getBoundingClientRect();
      const paletteBox = palette.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      // A row the palette paints over: its visible part (inside the list's own
      // box) reaches into the palette's box.
      const underPalette = [...list.querySelectorAll("a, button, .desktop-rail__grouplabel")]
        .filter((item) => {
          const box = item.getBoundingClientRect();
          const visibleBottom = Math.min(box.bottom, listBox.bottom);
          return box.height > 1 && box.top < listBox.bottom && visibleBottom > paletteBox.top + 0.5;
        });
      return {
        overflowed: list.scrollHeight > list.clientHeight,
        rowStartedBelowFold: before,
        paletteInList: list.contains(palette),
        paletteBelowList: paletteBox.top >= listBox.bottom - 0.5,
        rowInside: rowBox.top >= listBox.top - 0.5 && rowBox.bottom <= listBox.bottom + 0.5,
        underPalette: underPalette.map((item) => item.textContent.trim().slice(0, 30)),
      };
    });
    expect(geometry.overflowed).toBe(true);
    expect(geometry.rowStartedBelowFold).toBe(true);
    expect(geometry.paletteInList).toBe(false);
    expect(geometry.paletteBelowList).toBe(true);
    expect(geometry.rowInside).toBe(true);
    expect(geometry.underPalette).toEqual([]);
  } finally { await page.close(); }
});
