import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { render } from "@testing-library/react";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DesktopRail } from "../src/components/DesktopRail.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";

// BUG-UG-OPEN-DESKTOP-RAIL-STRETCHES-EVERY-PAGE-TO-A-BLANK-SCREEN-20261122
// (#9509): rail rows carry their description as visually hidden text (.sr-only,
// position: absolute). The scrolling list was not positioned, so those spans
// were laid out against the sticky rail, escaped the list's clipping and made
// a short page scroll hundreds of pixels past its end. Real layout in desktop
// Chromium with the shipped CSS: beside a short page, the document is no
// taller than the window, and each hidden description belongs to the list.
const css = (await Promise.all(["sg-tokens.css", "styles.css", "components/OnboardingHud.css"]
  .map((path) => readFile(resolve("src", path), "utf8")))).join("\n");

const VIEWPORT = { width: 1280, height: 640 };

let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

function railMarkup({ renderMode, collapsed }) {
  const memberId = `member-9509-${renderMode}-${collapsed}`;
  window.localStorage.setItem(`sg:member:${memberId}:desktop-main-rail:collapsed`, String(collapsed));
  const shell = renderMode === "tablet" ? "sg-app--tablet" : "sg-app--desktop";
  const view = render(<LanguageProvider lang="en">
    <div className={`sg-app ${shell}`} data-workspace-theme="union-ground">
      <DesktopRail active="home" activeHat="member" demo={false} memberId={memberId} onAsk={() => {}} onNavigate={() => {}} renderMode={renderMode} workspaceTheme="union-ground" />
      <main style={{ flex: "1 1 auto", height: "200px" }}>Short page</main>
    </div>
  </LanguageProvider>);
  const html = view.container.innerHTML;
  view.unmount();
  window.localStorage.removeItem(`sg:member:${memberId}:desktop-main-rail:collapsed`);
  return html;
}

async function measure(html, viewport = VIEWPORT) {
  const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
  try {
    await page.route("**/*", (route) => route.abort());
    await page.setContent(`<base href="http://127.0.0.1/">${html}`);
    await page.addStyleTag({ content: css });
    return await page.evaluate(() => {
      const list = document.querySelector(".desktop-rail__items:not(.desktop-rail__items--foot)");
      const hidden = [...document.querySelectorAll(".desktop-rail__items :is(.sr-only, .guided-nav-toggle__note)")];
      return {
        documentHeight: document.documentElement.scrollHeight,
        windowHeight: window.innerHeight,
        hidden: hidden.length,
        hiddenText: hidden.every((node) => node.textContent.trim().length > 0),
        outsideList: hidden.filter((node) => node.offsetParent !== list && !list.contains(node.offsetParent)).length,
      };
    });
  } finally {
    await page.close();
  }
}

it("keeps a short page no taller than the window beside the open desktop rail, with every hidden row description inside the list", async () => {
  const open = await measure(railMarkup({ renderMode: "desktop", collapsed: false }));
  expect(open.hidden).toBeGreaterThan(0);
  expect(open.documentHeight).toBeLessThanOrEqual(open.windowHeight);
  expect(open.outsideList).toBe(0);
  expect(open.hiddenText).toBe(true);
});

it("keeps the same page height with the rail folded and at the tablet rail width", async () => {
  const folded = await measure(railMarkup({ renderMode: "desktop", collapsed: true }));
  expect(folded.documentHeight).toBeLessThanOrEqual(folded.windowHeight);
  const tablet = await measure(railMarkup({ renderMode: "tablet", collapsed: false }), { width: 900, height: 640 });
  expect(tablet.documentHeight).toBeLessThanOrEqual(tablet.windowHeight);
  expect(tablet.outsideList).toBe(0);
});
