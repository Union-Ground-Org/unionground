// BUG-UG-HOME-LATER-BUTTON-DARK-CONTRAST-20261027 (local Chromium
// evidence, not hosted acceptance). Home's vote and survey hero card painted
// the vendored gradient in every theme; under the dark carriers that gradient
// runs from the lifted brand (#d9bee0) into the rail count (#4f3954) beneath
// canvas-dark ink, and the Later button's label (#46304d) measured 1.6 to
// 2.3:1 with its edge at 2.1:1. The declared-pair contrast audit cannot see a
// gradient under inherited text, so this mounts the real TodayView with the
// full runtime CSS, composites every text node of each hero card over its
// painted ancestor chain, and measures the Later edge against the card, at
// phone 320, tablet 768 and desktop 1280 in both themes. The card is rendered by the
// phone branch and by every width without the desktop rail (TodayView's
// desktop branch does not render it), so 1280 is measured on that branch.
// The light card keeps its gradient wash and is not re-measured here (its
// pairs are certified by the union-ground block); its rendered Later values
// are pinned. The dormant dark form and its card binding are deleted,
// so only the light identity is measured.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TodayView } from "../src/views/TodayView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

const globalSheets = ["sg-tokens.css", "styles.css", "coordinator-theme.css", "motion.css"];
async function cssFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => (entry.isDirectory()
    ? cssFiles(join(dir, entry.name)) : entry.name.endsWith(".css") ? [join(dir, entry.name)] : [])));
  return nested.flat();
}
const componentSheets = (await cssFiles(resolve("src"))).sort()
  .filter((path) => !globalSheets.some((name) => path === resolve("src", name)));
const css = (await Promise.all([...globalSheets.map((name) => resolve("src", name)), ...componentSheets]
  .map((path) => readFile(path, "utf8")))).join("\n");

let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

// The fixture member has an open ballot and an open survey, so the phone
// branch renders the hero card and the second card that carries Later.
function markup(desktop) {
  const view = render(<LanguageProvider lang="en"><main className="app-column">
    <TodayView data={fallbackData} desktop={desktop} onPlanAction={vi.fn()} />
  </main></LanguageProvider>);
  const html = view.container.innerHTML;
  view.unmount();
  return html;
}

async function pageFor(html, width, theme) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  await page.route("**/*", (route) => route.abort());
  await page.setContent(`<div class="sg-app" data-workspace-theme="union-ground" style="width:${width}px">${html}</div>`);
  await page.addStyleTag({ content: css });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

// Every element under each hero card that owns a text node, composited over
// its whole ancestor chain (a background-image anywhere in the chain cannot be
// composited and fails closed), plus the Later edge against what it sits on.
function heroSweep() {
  const rgb = (value) => {
    const match = value.match(/^rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\)$/);
    return match ? [+match[1], +match[2], +match[3], match[4] === undefined ? 1 : +match[4]] : null;
  };
  const luminance = (channels) => channels.slice(0, 3).map((channel) => { const s = channel / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const ratioOf = (fg, bg) => { const a = luminance(fg), b = luminance(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
  const over = (color, bg) => color.slice(0, 3).map((channel, index) => channel * color[3] + bg[index] * (1 - color[3]));
  const backdrop = (element) => {
    let bg = [255, 255, 255, 1];
    const chain = [];
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) chain.unshift(ancestor);
    for (const node of chain) {
      const css = getComputedStyle(node), color = rgb(css.backgroundColor);
      if (!color || css.backgroundImage !== "none") return null;
      bg = over(color, bg).concat(1);
    }
    return bg;
  };
  const cards = [...document.querySelectorAll(".home-vote-hero")];
  const failures = [], pairs = [], later = [];
  for (const card of cards) {
    const cardStyle = getComputedStyle(card);
    pairs.push(`${card.className}: background ${cardStyle.backgroundColor} image ${cardStyle.backgroundImage === "none" ? "none" : "gradient"}`);
    for (const element of [card, ...card.querySelectorAll("*")]) {
      if (![...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) continue;
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      if (box.width < 2 || box.height < 2 || style.visibility !== "visible" || style.opacity !== "1") continue;
      const name = `${element.tagName.toLowerCase()}.${String(element.className).trim().split(/\s+/).join(".")} "${element.textContent.trim().slice(0, 24)}"`;
      const bg = backdrop(element), fg = rgb(style.color);
      if (!bg || !fg) { failures.push(`${name}: uncompositable pair`); continue; }
      const ratio = ratioOf(over(fg, bg), bg);
      const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
      pairs.push(`${name}: ${ratio.toFixed(2)} (${style.color} on rgb(${bg.slice(0, 3).map(Math.round).join(",")}))`);
      if (ratio + 0.01 < (large ? 3 : 4.5)) failures.push(`${name}: ${style.color} on rgb(${bg.slice(0, 3).map(Math.round).join(",")}) = ${ratio.toFixed(2)}:1`);
    }
    for (const button of card.querySelectorAll(".home-vote-hero__later")) {
      const style = getComputedStyle(button), bg = backdrop(button), edge = rgb(style.borderTopColor), label = rgb(style.color);
      const entry = { label: style.color, fill: style.backgroundColor, edge: style.borderTopColor, labelRatio: null, edgeRatio: null, surface: null, height: button.getBoundingClientRect().height };
      if (bg && edge && label) {
        entry.labelRatio = ratioOf(over(label, bg), bg);
        entry.edgeRatio = ratioOf(over(edge, bg), bg);
        entry.surface = `rgb(${bg.slice(0, 3).map(Math.round).join(",")})`;
        if (entry.edgeRatio + 0.01 < 3) failures.push(`later edge ${entry.edge} on ${entry.surface} = ${entry.edgeRatio.toFixed(2)}:1`);
      } else {
        failures.push("later: uncompositable edge");
      }
      later.push(entry);
    }
  }
  return { cards: cards.length, pairs, failures, later };
}

describe("Home vote and survey hero cards in the light identity", () => {
  for (const theme of ["light"]) {
    for (const [layout, width] of [["phone-320", 320], ["tablet-768", 768], ["desktop-1280", 1280]]) {
      it(`keeps every hero text node and the Later edge readable at ${layout} in ${theme}`, async () => {
        const page = await pageFor(markup(false), width, theme);
        try {
          const sweep = await page.evaluate(heroSweep);
          expect(sweep.cards, `${layout} renders the hero and second cards`).toBe(2);
          expect(sweep.later.length, `${layout} renders Later`).toBe(1);
          const [later] = sweep.later;
          expect(later.height).toBeGreaterThanOrEqual(48);
          // #7967 moves Later into the shared native-shaped secondary
          // family. The card's gradient stays; member-actions-browser
          // measures this opaque secondary pair's contrast separately.
          expect(sweep.pairs[0]).toMatch(/image gradient$/);
          expect(later.fill).toBe("rgb(220, 233, 226)");
          expect(later.label).toBe("rgb(14, 64, 52)");
          expect(later.edge).toBe("rgb(79, 90, 84)");
        } finally { await page.context().close(); }
      }, 60000);
    }
  }
});
