// UX-UG-TABLET-RAIL-HAS-NO-CHAPTER-SWITCHER-AND-PHONE-WEB-LAYOUT-FAULTS-20261122
// (#9543, site audit B-35): on phone web the open All features menu ran under
// its own foot. In the demo shell the cards start below the 60px chrome row,
// but the menu was a full 100dvh tall, so its scroll box ended 60px below the
// screen and the last rows (Appointments, then Settings at the very end) sat
// under the avatar, the settings button and the Home orb, which took their
// taps; at 320px the centred Home orb also covered the foot's settings
// button. And the rail is as tall as its tallest card, so the 1,965px menu,
// hidden beside Home, stretched a short Home with blank scroll (D2-28).
// Laid out in headless Chromium with the app's stylesheets at 390 and 320 px.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MobileCardNav } from "../src/components/MobileCardNav.jsx";

const css = (await Promise.all(["sg-tokens.css", "styles.css", "motion.css"]
  .map((path) => readFile(resolve("src", path), "utf8")))).join("\n");

// 640x360: a phone on its side, where the cards' column (at most 480px) is
// narrower than the screen, so foot, drawer and orb must share that column.
const SIZES = [[390, 844], [320, 640], [640, 360]];

let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });
afterEach(() => { cleanup(); });

// The demo shell as the live phone Home mounts it: the in-flow chrome row
// (Demo tour and the hat select), a short Home feed, the full member menu.
function renderCardNav(initialPanel) {
  const view = render(
    <LanguageProvider lang="en">
      <MobileCardNav
        initialPanel={initialPanel}
        onNavigate={vi.fn()}
        onAsk={vi.fn()}
        onNotifications={vi.fn()}
        onProfile={vi.fn()}
        memberName="Marcus Greene"
        topChrome={{
          hatOptions: [{ key: "member", label: "Member" }, { key: "steward", label: "Steward" }],
          activeHat: "member",
          onHatChange: vi.fn(),
          demoMarker: <div className="demo-chip-row"><button type="button" className="demo-chip">Demo tour</button></div>,
        }}
      >
        <div className="short-feed" style={{ height: "600px" }}><p>Next 2 minutes</p></div>
      </MobileCardNav>
    </LanguageProvider>,
  );
  return view.container.innerHTML;
}

async function openPage(width, height, markup) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
  await page.route("**/*", (route) => (/^\/assets\/.*\.woff2$/.test(new URL(route.request().url()).pathname)
    ? route.fulfill({ path: resolve("public", new URL(route.request().url()).pathname.slice(1)), contentType: "font/woff2" })
    : route.abort()));
  await page.setContent(`<base href="http://127.0.0.1/"><div class="sg-app sg-app--phone"><main class="app-column">${markup}</main></div>`);
  await page.addStyleTag({ content: css });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

describe("phone menu and Home floating controls (#9543, B-35)", () => {
  it.each(SIZES)("a short Home ends where its content ends, not at the hidden menu's length, at %i px", async (width, height) => {
    const page = await openPage(width, height, renderCardNav("home"));
    try {
      const result = await page.evaluate(() => {
        const top = document.querySelector(".card-nav__rail").getBoundingClientRect().top;
        return {
          top,
          menuHeight: document.querySelector(".card-nav__panel--features").getBoundingClientRect().height,
          menuContent: document.querySelector(".card-nav__panel--features").scrollHeight,
          workHeight: document.querySelector(".card-nav__panel--work").getBoundingClientRect().height,
          homeBottom: document.querySelector(".card-nav__panel--home").getBoundingClientRect().bottom,
          documentHeight: document.documentElement.scrollHeight,
          reserve: parseFloat(getComputedStyle(document.querySelector(".app-column")).paddingBottom),
          pageScroll: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      // The hidden menu is far longer than the screen, so the check means something.
      expect(result.menuContent).toBeGreaterThan(height * 1.5);
      expect(result.top).toBe(60);
      expect(result.menuHeight).toBe(height - result.top);
      expect(result.workHeight).toBe(height - result.top);
      // The page ends at the feed's end (or one screen), plus the reserve the
      // All features pill keeps clear, never at the hidden menu's length.
      expect(result.documentHeight).toBeLessThanOrEqual(Math.max(result.homeBottom, height) + result.reserve);
      expect(result.pageScroll).toBe(false);
    } finally {
      await page.close();
    }
  });

  it.each(SIZES)("in the open menu no row sits under the foot or the Home orb, and every row can be tapped, at %i px", async (width, height) => {
    const page = await openPage(width, height, renderCardNav("features"));
    try {
      const result = await page.evaluate(async () => {
        const panel = document.querySelector(".card-nav__panel--features");
        const foot = document.querySelector(".card-nav__foot--shown");
        const orb = document.querySelector(".home-orb");
        const rect = (element) => element.getBoundingClientRect();
        const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        const rows = [...panel.querySelectorAll(".morehub-row, .pinned-shortcuts__tile, .pinned-shortcuts__customize, .card-nav__round")];
        const tappable = (row) => {
          const box = rect(row);
          const x = (box.left + box.right) / 2;
          return [box.top + 4, (box.top + box.bottom) / 2, box.bottom - 4].every((y) => row.contains(document.elementFromPoint(x, y)));
        };
        // Rows wholly inside the menu's visible box, at the top and at the end.
        const blocked = () => {
          const view = rect(panel);
          return rows.filter((row) => rect(row).top >= view.top && rect(row).bottom <= Math.min(view.bottom, window.innerHeight))
            .filter((row) => !tappable(row)).map((row) => row.textContent.trim());
        };
        const blockedAtTop = blocked();
        panel.scrollTop = panel.scrollHeight;
        await new Promise((done) => requestAnimationFrame(done));
        const last = rows.at(-1);
        return {
          rowCount: rows.length,
          scrolls: panel.scrollHeight > panel.clientHeight,
          menuBottom: rect(panel).bottom,
          footTop: foot ? rect(foot).top : null,
          footBottom: foot ? rect(foot).bottom : null,
          lastRow: last.textContent.trim(),
          lastRowBottom: rect(last).bottom,
          lastRowTappable: tappable(last),
          blockedAtTop,
          blockedAtEnd: blocked(),
          orbOnFootButton: [...foot.querySelectorAll("button")].some((button) => overlaps(rect(orb), rect(button))),
          orbOverMenu: rect(orb).left < rect(panel).right,
          footRight: rect(foot).right,
          menuRight: rect(panel).right,
          // Each control takes its own taps: its centre hits itself.
          ownTaps: [foot.querySelector(".card-nav__avatar"), foot.querySelector(".card-nav__round"), orb].map((control) => {
            const box = rect(control);
            return control.contains(document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2));
          }),
          pageScroll: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      expect(result.rowCount).toBeGreaterThan(20);
      expect(result.scrolls).toBe(true);
      expect(result.footBottom).toBe(height);
      // The menu ends where the foot begins.
      expect(result.menuBottom).toBeLessThanOrEqual(result.footTop);
      expect(result.blockedAtTop).toEqual([]);
      expect(result.blockedAtEnd).toEqual([]);
      expect(result.lastRow).toMatch(/Settings/);
      expect(result.lastRowBottom).toBeLessThanOrEqual(result.footTop);
      expect(result.lastRowTappable).toBe(true);
      expect(result.orbOnFootButton).toBe(false);
      expect(result.orbOverMenu).toBe(false);
      // The foot spans the drawer exactly, at every width.
      expect(Math.abs(result.footRight - result.menuRight)).toBeLessThanOrEqual(0.5);
      expect(result.ownTaps).toEqual([true, true, true]);
      expect(result.pageScroll).toBe(false);
    } finally {
      await page.close();
    }
  });
});
