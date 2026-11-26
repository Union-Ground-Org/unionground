import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { render } from "@testing-library/react";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ChapterRail } from "../src/components/ChapterRail.jsx";
import { ProfileDialog } from "../src/components/Dialogs.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { browserMarkup } from "./helpers/browserMarkup.js";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";

const css = (await Promise.all(["sg-tokens.css", "styles.css", "components/Dialog.css", "popups.css"]
  .map(path => readFile(resolve("src", path), "utf8")))).join("\n");
let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

async function fixturePage(width, children) {
  const view = render(<LanguageProvider lang="en">{children}</LanguageProvider>);
  const markup = browserMarkup(view.container);
  view.unmount();
  const page = await browser.newPage({ viewport: { width, height: 920 } });
  try {
    await page.route("**/*", route => route.abort());
    await page.setContent(markup);
    await page.addStyleTag({ content: css });
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
}

it.each([[1680, "desktop", 248], [900, "tablet", 220]])("dims only the workspace behind Campaigns at %i CSS px", async (width, layout, railWidth) => {
  const page = await fixturePage(width, <div className={`sg-app sg-app--${layout}`}>
    <ChapterRail flyout open chapters={[{ id: "ch", name: "Harbor Campaign", abbreviation: "HC" }]} selectedId="ch" onSelect={vi.fn()} />
  </div>);
  try {
    const shade = page.locator(".chapter-rail__scrim");
    const flyout = page.getByRole("navigation", { name: "Campaigns" });
    expect(await shade.count()).toBe(1);
    expect(await shade.boundingBox()).toMatchObject({ x: railWidth, y: 0, width: width - railWidth, height: 920 });
    expect((await flyout.boundingBox()).x).toBe(railWidth);
    expect(await shade.evaluate(node => getComputedStyle(node).backgroundColor)).toBe("rgba(6, 14, 11, 0.45)");
    expect(await flyout.evaluate(node => document.elementFromPoint(node.getBoundingClientRect().left + 20, 30).closest("nav") === node)).toBe(true);
  } finally { await page.close(); }
});

it("shows a single profile switch cue in either state, including during a change", async () => {
  const member = { firstName: "Rae", fullName: "Rae Harbor", initials: "RH", roleLine: "Library assistant" };
  const page = await fixturePage(1680, <div className="sg-app sg-app--desktop">
    <ProfileDialog member={member} onClose={vi.fn()} onSave={vi.fn()} chapterRailOwner={{ memberId: "fictional-member" }} />
  </div>);
  try {
    const toggle = page.getByRole("switch");
    const cues = checked => toggle.evaluate((node, state) => {
      node.setAttribute("aria-checked", state);
      return [...node.querySelectorAll(".sg-switch__cue")]
        .filter(cue => getComputedStyle(cue).display !== "none" && Number(getComputedStyle(cue).opacity) > 0)
        .map(cue => cue.textContent);
    }, checked);
    expect(await cues("false")).toEqual(["×"]);
    expect(await cues("true")).toEqual(["✓"]);
    expect(await cues("false")).toEqual(["×"]);
  } finally { await page.close(); }
});
