import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { render } from "@testing-library/react";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DesktopRail } from "../src/components/DesktopRail.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { normalizeOnboardingGuide } from "../src/lib/onboardingGuide.js";
import { HAT_WORKSPACE_THEMES } from "../src/lib/workspaceTheme.js";

// Real layout in desktop Chromium using the rail's own markup and the shipped
// CSS. The guided-view toggle is a text-only button. The rail's icon-row grid
// (22px icon column, label, badge) once dropped that text into the icon column,
// so "Show everything (15 more)" wrapped a few letters per line, and the rail's
// row rules lowered its 48px touch target to 44px. This is functional reflow
// and contrast, not a mobile-browser design or device acceptance gate.
const css = (await Promise.all(["sg-tokens.css", "styles.css", "components/OnboardingHud.css"]
  .map((path) => readFile(resolve("src", path), "utf8")))).join("\n");

const GUIDE = normalizeOnboardingGuide({
  state: "ready",
  applies: true,
  memberOnly: true,
  programConfigured: true,
  enrolled: true,
  totalSteps: 4,
  completedSteps: 0,
  onboardingComplete: false,
  progressiveDisclosureActive: true,
  stage: "welcome",
  nextStep: { id: "step-1", title: "Meet your chapter" },
  featureDrip: true,
  showHud: true,
  spotlight: "member-support",
  badge: "new_member",
  switches: { featureDrip: true, hudTooltips: true, spotlight: true, progressiveDisclosure: true, badgeAchievements: true },
});

// Every theme a member rail can render since design Step 2: no attribute and
// the one Union Ground identity (its dark form was deleted by s
// 616 and 636).
// Superseded enumeration, quoted: "no attribute, the outer-desktop Evergreen
// guide, the member hat's own palette and each selectable theme"; the desktop
// Evergreen forcing and the selectable palettes were retired by the owner's
// rulings of October 3, 2026.
const MEMBER_RAIL_THEMES = [
  null,
  HAT_WORKSPACE_THEMES.member,
];
const TOGGLE = ".desktop-rail__items .guided-nav-toggle__button";

let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

// App puts the theme on the .sg-app root, where the palette tokens live, and
// passes the same slug to the rail. A fixture that themes only the rail reads
// the default tokens under themed rules and reports contrast that never ships.
async function railPage({ lang = "en", guideShowAll = false, tablet = false, theme = null } = {}) {
  const view = render(<LanguageProvider lang={lang}>
    <div className={tablet ? "sg-app sg-app--tablet" : "sg-app sg-app--desktop"} data-workspace-theme={theme || undefined}>
      <DesktopRail
        active="today"
        activeHat="member"
        demo={false}
        memberId="member-a"
        onAsk={() => {}}
        onNavigate={() => {}}
        renderMode={tablet ? "tablet" : "desktop"}
        workspaceTheme={theme}
        guide={GUIDE}
        guideShowAll={guideShowAll}
        onGuideShowAllChange={() => {}}
      />
    </div>
  </LanguageProvider>);
  // Reduced motion switches the rail's own transitions off, so geometry and colours are settled when they are read.
  const page = await browser.newPage({ viewport: tablet ? { width: 768, height: 1024 } : { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return /^\/assets\/.*\.woff2$/.test(url.pathname)
      ? route.fulfill({ path: resolve("public", url.pathname.slice(1)), contentType: "font/woff2" })
      : route.abort();
  });
  await page.setContent(`<base href="http://127.0.0.1/">${view.container.innerHTML}`);
  view.unmount();
  await page.addStyleTag({ content: css });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

function toggleGeometry(page) {
  return page.locator(TOGGLE).evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const label = range.getBoundingClientRect();
    const lineTops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
    const box = node.getBoundingClientRect();
    const items = node.closest(".desktop-rail__items").getBoundingClientRect();
    return {
      text: node.textContent,
      lines: lineTops.size,
      labelWidth: label.width,
      labelLeft: label.left,
      labelRight: label.right,
      left: box.left,
      right: box.right,
      width: box.width,
      height: box.height,
      itemsLeft: items.left,
      itemsRight: items.right,
      itemsWidth: items.width,
    };
  });
}

// Computed colours of the toggle, its note and the surfaces behind them,
// reduced to WCAG contrast ratios in the page.
function toggleContrast(page) {
  return page.locator(TOGGLE).evaluate((node) => {
    const channels = (value) => value.match(/[\d.]+/g).slice(0, 4).map(Number);
    const luminance = ([red, green, blue]) => [red, green, blue]
      .map((channel) => channel / 255)
      .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const ratio = (first, second) => {
      const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
      return (lighter + 0.05) / (darker + 0.05);
    };
    const surface = (start) => {
      for (let element = start; element; element = element.parentElement) {
        const background = channels(getComputedStyle(element).backgroundColor);
        if (background.length === 3 || background[3] === 1) return background;
      }
      return null;
    };
    const style = getComputedStyle(node);
    const note = node.parentElement.querySelector(".guided-nav-toggle__note");
    return {
      height: node.getBoundingClientRect().height,
      background: style.backgroundColor,
      label: ratio(channels(style.color), surface(node)),
      note: note ? ratio(channels(getComputedStyle(note).color), surface(note)) : null,
      focusVisible: node.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      outline: ratio(channels(style.outlineColor), surface(node.parentElement)),
    };
  });
}

it.each([
  ["en", false, false, "Show everything (15 more)"],
  ["en", true, false, "Show the guided view"],
  ["es", false, false, "Mostrar todo (15 más)"],
  ["es", true, false, "Mostrar la vista guiada"],
  ["en", false, true, "Show everything (15 more)"],
  ["en", true, true, "Show the guided view"],
  ["es", false, true, "Mostrar todo (15 más)"],
  ["es", true, true, "Mostrar la vista guiada"],
])("gives the %s guided-view toggle (show all %s, tablet %s) the rail's full row and a 48px target", async (lang, guideShowAll, tablet, text) => {
  const page = await railPage({ lang, guideShowAll, tablet });
  try {
    const geometry = await toggleGeometry(page);
    expect(geometry.text).toBe(text);
    // The label reads as words on one or two lines, not a column of fragments.
    expect(geometry.lines).toBeLessThanOrEqual(2);
    expect(geometry.labelWidth).toBeGreaterThan(22 * 3);
    // It is a full-width rail row and a 48px touch target, and nothing spills out.
    expect(geometry.width).toBeGreaterThanOrEqual(geometry.itemsWidth * 0.8);
    expect(geometry.height).toBeGreaterThanOrEqual(48);
    expect(geometry.height).toBeLessThanOrEqual(72);
    expect(geometry.labelLeft).toBeGreaterThanOrEqual(geometry.left);
    expect(geometry.labelRight).toBeLessThanOrEqual(geometry.right);
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.itemsLeft);
    expect(geometry.right).toBeLessThanOrEqual(geometry.itemsRight);
  } finally { await page.close(); }
});

// BUG-UG-GUIDED-NAV-TOGGLE-CUT-AT-RAIL-EDGE-20261106: the toggle was
// the last row before the pinned Command palette and its six-line note pushed
// the list past the window, so at rest the rail ended in a cut row. On the
// desktop rail the note is the button's accessible description only, and no
// row of the list ends under the palette or past the list's own edge.
it("ends the desktop rail list on the whole toggle, with the note kept as its description", async () => {
  const page = await railPage();
  try {
    const rest = await page.locator(TOGGLE).evaluate((node) => {
      const list = node.closest(".desktop-rail__items");
      const note = node.closest(".guided-nav-toggle").querySelector(".guided-nav-toggle__note");
      const palette = list.querySelector(".desktop-rail__palette");
      const limit = palette ? palette.getBoundingClientRect().top : list.getBoundingClientRect().bottom;
      const clipped = [...list.querySelectorAll(":scope > *, :scope .guided-nav-toggle > *")]
        .filter((item) => item !== palette && item !== note && !item.classList.contains("guided-nav-toggle"))
        .filter((item) => { const box = item.getBoundingClientRect(); return box.height > 1 && box.bottom > limit + 0.5; })
        .map((item) => item.textContent.trim().slice(0, 30));
      return {
        describedBy: node.getAttribute("aria-describedby"),
        noteId: note?.id ?? null,
        noteText: note?.textContent.trim() ?? "",
        noteWidth: note?.getBoundingClientRect().width ?? null,
        clipped,
        overflow: list.scrollHeight - list.clientHeight,
      };
    });
    expect(rest.noteId).toBeTruthy();
    expect(rest.describedBy).toBe(rest.noteId);
    expect(rest.noteText.length).toBeGreaterThan(20);
    expect(rest.noteWidth).toBeLessThanOrEqual(1);
    expect(rest.clipped).toEqual([]);
    expect(rest.overflow).toBeLessThanOrEqual(1);
  } finally { await page.close(); }
});

for (const tablet of [false, true]) {
  it.each(MEMBER_RAIL_THEMES)(`keeps the toggle and its note readable at rest, on hover and on keyboard focus in the %s theme (tablet ${tablet})`, async (theme) => {
    const page = await railPage({ theme, tablet });
    try {
      const rest = await toggleContrast(page);
      expect(rest.height).toBeGreaterThanOrEqual(48);
      expect(rest.label).toBeGreaterThanOrEqual(4.5);
      expect(rest.note).toBeGreaterThanOrEqual(4.5);

      await page.locator(TOGGLE).hover();
      const hover = await toggleContrast(page);
      expect(hover.background).not.toBe(rest.background);
      expect(hover.label).toBeGreaterThanOrEqual(4.5);

      await page.mouse.move(700, 600);
      for (let presses = 0; presses < 60; presses += 1) {
        await page.keyboard.press("Tab");
        if (await page.evaluate((selector) => document.activeElement === document.querySelector(selector), TOGGLE)) break;
      }
      const focus = await toggleContrast(page);
      expect(focus.focusVisible).toBe(true);
      expect(focus.outlineStyle).toBe("solid");
      expect(focus.outlineWidth).toBeGreaterThanOrEqual(2);
      expect(focus.outline).toBeGreaterThanOrEqual(3);
      expect(focus.label).toBeGreaterThanOrEqual(4.5);
    } finally { await page.close(); }
  });
}
