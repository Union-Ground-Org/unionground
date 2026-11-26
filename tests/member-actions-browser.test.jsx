import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "@playwright/test";
import { renderToString } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MemberActionExample } from "./fixtures/member-actions-browser.jsx";
import { StaffFeatureGuide } from "../src/features/onboardingGuideEngine/StaffGuides.jsx";
import { OrgStartGuide } from "../src/features/onboardingGuideEngine/OrgStartGuide.jsx";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";

const actions = [
  ".member-guide-card__primary", ".member-guide-card__quiet", ".home-steward__org", ".home-steward__contact", ".home-steward__channel",
  ".home-takeover__open", ".home-takeover__read", ".what-matters__action",
  ".home-vote-hero__cta", ".home-vote-hero__later", ".home-vote__cta", ".home-vote__alt",
  ".home-action-row__cta", ".home-allevents", ".voting-btn", ".voting-hero__approve",
  ".voting-hero__docs", ".voting-extra__submit", ".voting-suggest__send",
  ".mcases-ph__new", ".mcases-new", ".mcases-primary", ".mcases-ghost", ".inbox-head__action", ".inbox-send",
].join(",");
const globalSheets = ["sg-tokens.css", "styles.css", "coordinator-theme.css", "motion.css", "popups.css"];
async function cssFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory()
    ? cssFiles(join(dir, entry.name)) : entry.name.endsWith(".css") ? [join(dir, entry.name)] : []))).flat();
}
const componentSheets = (await cssFiles(resolve("src"))).sort().filter((path) => !globalSheets.some((name) => path === resolve("src", name)));
let css = (await Promise.all([...globalSheets.map((name) => resolve("src", name)), ...componentSheets].map((path) => readFile(path, "utf8")))).join("\n");
for (const font of new Set([...css.matchAll(/url\("(\/assets\/[^"()]+\.woff2)"\)/g)].map((match) => match[1]))) {
  css = css.replaceAll(font, `data:font/woff2;base64,${(await readFile(resolve("public", font.slice(1)))).toString("base64")}`);
}
let browser;
const receipts = [];
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, BROWSER_HOOK_TIMEOUT);
afterAll(async () => {
  await browser?.close();
  if (process.env.MEMBER_ACTION_EVIDENCE) await writeFile(join(process.env.MEMBER_ACTION_EVIDENCE, "measurements.json"), JSON.stringify(receipts, null, 2));
});

async function open(page, view, width) {
  // Measure the real rendered views with runtime CSS and the shipped fonts.
  // Static rendering isolates this CSS regression from Vite's module startup;
  // the browser fixture and mounted callback test cover the interactive path.
  const html = renderToString(<LanguageProvider lang="en"><MemberActionExample view={view} desktop={width >= 1000}/></LanguageProvider>);
  await page.route("**/*", (route) => route.abort());
  await page.setContent(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${html}</body></html>`);
  await page.addStyleTag({ content: css });
  await page.evaluate(() => document.fonts.ready);
}

async function compareBeforeMemberRules(page, html, selector, properties) {
  await page.route("**/*", (route) => route.abort());
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
  await page.addStyleTag({ content: css });
  await page.evaluate(() => document.fonts.ready);
  const measure = () => page.locator(selector).evaluateAll((nodes, keys) => nodes.map((node) => ({
    name: node.textContent.trim(),
    styles: Object.fromEntries(keys.map((key) => [key, getComputedStyle(node)[key]])),
  })), properties);
  const current = await measure();
  // Remove only #7967's two shared rules: retain every other shipped rule as
  // the pre-change baseline, including staff/setup and control-state styles.
  const removed = await page.evaluate(() => {
    let count = 0;
    for (const sheet of document.styleSheets) {
      for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
        const selector = sheet.cssRules[i].selectorText || "";
        if (selector.includes(".member-guide-card__primary") && selector.includes(".inbox-screen .dialog-primary")) {
          sheet.deleteRule(i);
          count++;
        }
      }
    }
    return count;
  });
  expect(removed).toBe(2);
  return { current, before: await measure() };
}

it("leaves staff feature and organization setup guide buttons exactly as before the member rules", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const guides = { showing: { title: { key: "nav.home" }, lines: [], firstLabel: { key: "nav.home" } } };
  const guide = { view: { canAct: true, ring: { percent: 0, done: 0, total: 7, text: { key: "nav.home" } },
    eyebrow: { key: "nav.home" }, title: { key: "nav.home" } } };
  const markup = renderToString(<LanguageProvider lang="en"><div className="sg-app" data-workspace-theme="union-ground">
    <StaffFeatureGuide guides={guides} announce={false}/><OrgStartGuide guide={guide}/>
    <section className="org-start"><form className="org-start__contacts">
      <button className="member-guide-card__primary" disabled>Save contacts</button>
      <button className="member-guide-card__quiet">Review switches</button>
    </form></section>
  </div></LanguageProvider>);
  try {
    const result = await compareBeforeMemberRules(page, markup,
      ".staff-guide-card button, .org-start .member-guide-card__primary, .org-start .member-guide-card__quiet",
      ["minHeight", "borderRadius", "fontSize", "padding", "backgroundColor", "color", "cursor"]);
    expect(result.current).toHaveLength(5);
    expect(result.current).toEqual(result.before);
    for (const button of result.current) expect(button.styles).toMatchObject({ minHeight: "48px", borderRadius: "10px", fontSize: "16px", padding: "8px 14px" });
  } finally { await page.close(); }
}, 60_000);

it("preserves the static SAMPLE receipt and disabled or busy cursors", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  try {
    const result = await compareBeforeMemberRules(page, `<div class="sg-app" data-workspace-theme="union-ground">
      <section class="voting-screen">
        <span data-probe class="voting-voted__verify voting-voted__verify--demo" tabindex="-1">SAMPLE receipt</span>
        <a class="voting-voted__verify" href="#receipt">Verify receipt</a>
        <button data-probe class="voting-btn" disabled>Vote</button>
        <button data-probe class="dialog-primary" disabled aria-busy="true">Saving</button>
      </section>
      <section class="inbox-screen"><button data-probe class="inbox-send" disabled>Send</button></section>
      <section class="home"><button data-probe class="home-takeover__read" disabled aria-busy="true">Mark read</button></section>
    </div>`, "[data-probe]", ["cursor"]);
    expect(result.current).toEqual(result.before);
    expect(result.current.map((probe) => probe.styles.cursor)).toEqual(["default", "default", "wait", "default", "default"]);
    // The baseline rules remain loaded; reapply the full sheet to check that
    // only a real receipt link receives the new geometry and semantic fill.
    await page.addStyleTag({ content: css });
    const receipt = await page.locator("span.voting-voted__verify").evaluate((node) => {
      const style = getComputedStyle(node);
      return { minHeight: style.minHeight, radius: style.borderRadius, background: style.backgroundColor };
    });
    expect(receipt).toEqual({ minHeight: "42px", radius: "99px", background: "rgb(255, 255, 255)" });
    expect(await page.locator("a.voting-voted__verify").evaluate((node) => getComputedStyle(node).borderRadius)).toBe("999px");
  } finally { await page.close(); }
}, 60_000);

describe.each(["home", "voting", "cases", "messages"])("%s member actions", (view) => {
  // Geometry and browser startup need explicit headroom on the shared host.
  it.each([320, 390, 768, 1280, 1440])("keeps named, readable pills at %i CSS px under either device appearance", async (width) => {
    for (const colorScheme of ["light", "dark"]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme, reducedMotion: "reduce" });
      try {
        await open(page, view, width);
        const measured = await page.locator(actions).evaluateAll((nodes) => {
          const luminance = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number).map((c) => { const s = c / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; }).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
          return nodes.filter((node) => node.getClientRects().length).map((node) => {
            const css = getComputedStyle(node), rect = node.getBoundingClientRect();
            const fg = luminance(css.color), bg = luminance(css.backgroundColor);
            return { name: node.getAttribute("aria-label") || node.textContent.trim(), className: node.className,
              height: rect.height, radius: css.borderRadius, size: css.fontSize,
              contrast: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05),
              foreground: css.color, background: css.backgroundColor };
          });
        });
        receipts.push({ view, width, colorScheme, measured });
        expect(measured.length).toBeGreaterThan(2);
        for (const button of measured) {
          expect(button.name).not.toBe("");
          expect(button, button.className).toMatchObject({ radius: "999px", size: "14px" });
          expect(button.height, button.name).toBeGreaterThanOrEqual(48);
          expect(button.contrast, button.name).toBeGreaterThanOrEqual(4.5);
        }
        const targets = await page.getByRole("button").evaluateAll((nodes) => nodes.map((node) => ({
          name: node.getAttribute("aria-label") || node.textContent.trim(), height: node.getBoundingClientRect().height,
        })));
        for (const target of targets) {
          expect(target.name).not.toBe("");
          expect(target.height, target.name).toBeGreaterThanOrEqual(44);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (process.env.MEMBER_ACTION_EVIDENCE) await page.screenshot({ path: join(process.env.MEMBER_ACTION_EVIDENCE, `${view}-${width}-${colorScheme}.png`), fullPage: true });
      } finally { await page.close(); }
    }
  }, 60_000);
});

it("keeps the shared ranks usable with keyboard focus, hover, active and disabled states", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await open(page, "home", 390);
    for (const selector of [".member-guide-card__primary", ".member-guide-card__quiet"]) {
      const button = page.locator(selector);
      await button.focus();
      expect(await button.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe("solid");
      await button.hover();
      await page.mouse.down();
      expect(await button.evaluate((node) => getComputedStyle(node).borderRadius)).toBe("999px");
      await page.mouse.up();
      await button.evaluate((node) => { node.disabled = true; });
      expect(await button.isDisabled()).toBe(true);
      expect(await button.isVisible()).toBe(true);
      expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(48);
    }
  } finally { await page.close(); }
}, 60_000);

it("preserves the named guide action and its mounted click handler", () => {
  render(<LanguageProvider lang="en"><MemberActionExample view="home" desktop/></LanguageProvider>);
  fireEvent.click(screen.getByRole("button", { name: "See what's next", exact: true }));
  expect(screen.getByLabelText("Fixture action")).toHaveTextContent("guide");
});

