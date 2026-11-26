// A11Y-UG-CASE-CARDS-DARK-MODE-CONTRAST-20261012 (local Chromium
// evidence, not hosted acceptance). The My cases empty card (.mcases-empty),
// desktop open-case card (.mcases-desk) and desktop closed-case panel
// (.mcases-panel) painted linear-gradient(180deg,#fefefe,#fbfbfb) in every
// theme while their text inherits the theme's --ink and --sec, so in
// union-ground-dark the titles measured about 1.1:1 and the meta lines about
// 2.0:1. The declared-pair contrast audit cannot see a hard-coded background
// under inherited text, so this mounts the real CasesView with the full
// runtime CSS, composites each text node over its painted ancestor chain, and
// runs axe color-contrast in the browser, for empty, active and closed lists
// at phone and desktop widths. The dormant dark form is deleted,
// so only the light identity is measured.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import AxeBuilder from "@axe-core/playwright";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CasesView } from "../src/views/CasesView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

// main.jsx's four global sheets in import order, then every component and
// feature sheet the bundle can load, so no rule that reaches a case card is
// missing from the page.
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

const base = {
  reference: "GR-2026-1", type: "Scheduling", articles: "Article 7", step: "Investigation",
  deadline: "Aug 20, 2026", deadlineValue: "2026-08-20", overdue: false,
  stewardName: "Sam Okafor", coordinatorName: "Jordan Patel", files: [],
  updates: [{ id: "u1", body: "Intake complete", created_at: "2026-08-01T12:00:00Z" }],
};
const lists = {
  empty: [],
  active: [{ ...base, id: "case-1", title: "Schedule grievance", status: "active" }],
  closed: [{ ...base, id: "case-2", title: "Overtime pay grievance", status: "closed", reference: "GR-2026-2" }],
};
// Which repaired card each list paints at each width. The phone open and
// closed rows (.mcases-case, .mcases-closed__row) already used var(--card).
const cards = {
  empty: { phone: ".mcases-empty", desktop: ".mcases-empty" },
  active: { phone: null, desktop: ".mcases-desk" },
  closed: { phone: null, desktop: ".mcases-panel" },
};

function markup(cases, desktop) {
  const view = render(<LanguageProvider lang="en"><main className="app-column">
    <CasesView data={{ cases, member: { id: "member-1" } }} desktop={desktop} onMessages={vi.fn()}
      onCreateCase={vi.fn()} onUpdateCase={vi.fn()} onAddCaseUpdate={vi.fn()} onAddCaseFile={vi.fn()}
      onRemoveCaseFile={vi.fn()} onOpenCaseFile={vi.fn()} />
  </main></LanguageProvider>);
  const html = view.container.innerHTML;
  view.unmount();
  return html;
}

async function pageFor(html, width, theme) {
  // AxeBuilder refuses a page from browser.newPage(); give each its own context.
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  await page.route("**/*", (route) => route.abort());
  await page.setContent(`<div class="sg-app" data-workspace-theme="union-ground" style="width:${width}px">${html}</div>`);
  await page.addStyleTag({ content: css });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

// Every element under the card that owns a text node, composited over its
// whole ancestor chain. A background-image anywhere in the chain (the old
// gradient) cannot be composited and fails closed, as the PR1815 runner does.
function cardSweep(selector) {
  const rgb = (value) => {
    const match = value.match(/^rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\)$/);
    return match ? [+match[1], +match[2], +match[3], match[4] === undefined ? 1 : +match[4]] : null;
  };
  const luminance = (channels) => channels.slice(0, 3).map((channel) => { const s = channel / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const card = document.querySelector(selector);
  if (!card) return null;
  const probe = document.createElement("div");
  probe.style.background = "var(--card)";
  card.parentElement.append(probe);
  const surface = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const cardStyle = getComputedStyle(card);
  const failures = [], pairs = [];
  for (const element of [card, ...card.querySelectorAll("*")]) {
    if (![...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) continue;
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    if (box.width < 2 || box.height < 2 || style.visibility !== "visible" || style.opacity !== "1") continue;
    let bg = [255, 255, 255, 1], valid = true;
    const chain = [];
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) chain.unshift(ancestor);
    for (const node of chain) {
      const css = getComputedStyle(node), color = rgb(css.backgroundColor);
      if (!color || css.backgroundImage !== "none") { valid = false; break; }
      bg = color.slice(0, 3).map((channel, index) => channel * color[3] + bg[index] * (1 - color[3])).concat(1);
    }
    const fg = rgb(style.color);
    const name = `${element.tagName.toLowerCase()}.${String(element.className).trim().split(/\s+/).join(".")} "${element.textContent.trim().slice(0, 24)}"`;
    if (!valid || !fg) { failures.push(`${name}: uncompositable pair`); continue; }
    const painted = fg.slice(0, 3).map((channel, index) => channel * fg[3] + bg[index] * (1 - fg[3]));
    const a = luminance(painted), b = luminance(bg), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
    pairs.push(`${name}: ${ratio.toFixed(2)}`);
    if (ratio + 0.01 < (large ? 3 : 4.5)) failures.push(`${name}: ${style.color} on rgb(${bg.slice(0, 3).map(Math.round).join(",")}) = ${ratio.toFixed(2)}:1`);
  }
  return { backgroundImage: cardStyle.backgroundImage, backgroundColor: cardStyle.backgroundColor, surface, pairs, failures };
}

describe("My cases cards in the light identity", () => {
  for (const theme of ["light"]) {
    for (const [state, cases] of Object.entries(lists)) {
      for (const [layout, width] of [["phone", 390], ["desktop", 1280]]) {
        it(`paints the ${state} ${layout} list on the theme card surface with readable text in ${theme}`, async () => {
          const page = await pageFor(markup(cases, layout === "desktop"), width, theme);
          try {
            const selector = cards[state][layout];
            if (selector) {
              const sweep = await page.evaluate(cardSweep, selector);
              expect(sweep, `${selector} is rendered`).not.toBeNull();
              expect(sweep.backgroundImage, `${selector} paints no fixed gradient`).toBe("none");
              expect(sweep.backgroundColor, `${selector} uses the theme card surface`).toBe(sweep.surface);
              expect(sweep.failures, `${selector} text contrast in ${theme}`).toEqual([]);
              expect(sweep.pairs.length).toBeGreaterThan(0);
            }
            const axe = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
            expect(axe.violations.flatMap((rule) => rule.nodes.map((node) => node.target.join(" "))), `axe color-contrast in ${theme}`).toEqual([]);
            // axe cannot rate text over a background-image and reports it as
            // incomplete rather than failed; a repaired card must be rated. The
            // aria-hidden ✓ and ● step glyphs stay incomplete for a different
            // reason (nonBmp: "only non-text characters") in either theme.
            const unrated = axe.incomplete.flatMap((rule) => rule.nodes
              .filter((node) => !node.any.some((check) => check.data?.messageKey === "nonBmp"))
              .map((node) => `${node.target.join(" ")}: ${node.any.map((check) => check.message).join("; ")}`))
              .filter((target) => /mcases-(empty|desk|panel)/.test(target));
            expect(unrated, `axe could rate every case-card text node in ${theme}`).toEqual([]);
          } finally { await page.context().close(); }
        }, 60000);
      }
    }
  }
});
