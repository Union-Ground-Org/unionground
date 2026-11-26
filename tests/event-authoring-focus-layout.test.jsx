import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { EventAuthoringCard } from "../src/components/EventAuthoringCard.jsx";
import { MobileTopBar } from "../src/components/MobileTopBar.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { OrganizationNameProvider } from "../src/lib/organizationName.js";

const css = (await Promise.all(["sg-tokens.css", "styles.css", "motion.css"].map(path => readFile(resolve("src", path), "utf8")))).join("\n");
let browser;
beforeAll(async () => { browser = await chromium.launch(); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });
const noop = () => {};
const event = { id: "tamarack-meeting", title: "Tamarack planning meeting", startsAt: "2099-11-18T18:00:00Z", location: "Tamarack hall", summary: "Plan the chapter meeting.", checkInCode: "SG-TAMAR" };

// Actual shell/form markup and styles in desktop Chromium, with fictional data.
// The header must not cover a field when scrolling back up after Summary.
for (const mode of ["create", "edit"]) {
  it.each([{ width: 320, zoom: 1 }, { width: 1440, zoom: 1 }, { width: 640, zoom: 2 }, { width: 1440, zoom: 2 }])(`keeps ${mode} fields usable while scrolling and tabbing at $width px, zoom $zoom`, async ({ width, zoom }) => {
    const view = render(<LanguageProvider lang="en"><OrganizationNameProvider value="Tamarack Workers Association">
      <div className="sg-app" data-workspace-theme="union-ground">
        <MobileTopBar onHome={noop} onFeatures={noop} onNotifications={noop} onProfile={noop} initials="AE" roleLabel="Steward" hatOptions={[{ key: "member", label: "Worker" }, { key: "committee member", label: "Steward" }]} activeHat="committee member" onHatChange={noop} />
        <main><h1>Events</h1><EventAuthoringCard events={mode === "edit" ? [event] : []} api={{}} onNotice={noop} reload={vi.fn()} chapterName="Tamarack chapter" /></main>
      </div>
    </OrganizationNameProvider></LanguageProvider>);
    if (mode === "create") fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
    else {
      fireEvent.click(screen.getByText("Manage meeting"));
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    }
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce", colorScheme: "light" });
    const page = await context.newPage();
    try {
      await page.route("**/*", route => route.abort());
      await page.setContent(view.container.innerHTML);
      await page.addStyleTag({ content: css });
      await page.evaluate(value => { document.documentElement.style.zoom = value; }, String(zoom));
      const summary = page.locator("textarea[name=summary]");
      await summary.focus();
      const title = page.locator("input[name=title]");
      await title.evaluate(node => {
        node.scrollIntoView({ block: "start" });
        node.focus({ preventScroll: true });
        window.scrollBy(0, -30);
      });
      const hit = async locator => locator.evaluate(node => {
        const r = node.getBoundingClientRect();
        return { height: r.height, width: r.width, unobscured: [2, r.height / 2, r.height - 2].every(y => document.elementFromPoint(r.left + r.width / 2, r.top + y) === node) };
      });
      expect((await hit(title)).unobscured).toBe(true);
      // Shift-Tab and Tab use real browser focus scrolling, including selects,
      // datetime segments, and the rest of the form's controls.
      await page.keyboard.press("Shift+Tab");
      for (let i = 0; i < 100; i += 1) {
        await page.keyboard.press("Tab");
        const active = page.locator(".event-authoring-form :focus");
        if (!(await active.count())) break;
        const box = await hit(active);
        expect(box.unobscured).toBe(true);
        expect(box.height).toBeGreaterThanOrEqual(48 * zoom);
        expect(box.width).toBeGreaterThanOrEqual(48 * zoom);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const axe = await new AxeBuilder({ page }).include(".event-authoring-form").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(axe.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) }))).toEqual([]);
    } finally {
      await context.close();
      view.unmount();
    }
  });
}

it("restores ordinary shell chrome when the editor closes", () => {
  const view = render(<LanguageProvider><div className="sg-app"><EventAuthoringCard events={[]} api={{}} onNotice={noop} reload={noop} /></div></LanguageProvider>);
  const shell = view.container.querySelector(".sg-app");
  expect(shell).not.toHaveClass("sg-app--event-authoring");
  fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
  expect(shell).toHaveClass("sg-app--event-authoring");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(shell).not.toHaveClass("sg-app--event-authoring");
});
