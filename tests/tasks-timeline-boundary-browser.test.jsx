import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { TasksView } from "../src/views/TasksView.jsx";

let browser;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = (await Promise.all(["sg-tokens.css", "styles.css"]
  .map(path => readFile(join(root, "src", path), "utf8")))).join("\n");
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-15T12:00:00-04:00"));
});
afterEach(() => { vi.useRealTimers(); });

it.each([375, 390, 768, 1440])("keeps first, middle and last-day timeline targets inside the track at %i px", async width => {
  const data = structuredClone(fallbackData);
  const original = data.tasks[0];
  data.tasks = [
    ["First day", "2026-08-10", "2026-08-10"],
    ["Middle day", "2026-08-23", "2026-08-23"],
    ["Last day", "2026-09-06", "2026-09-06"],
    ["Full window", "2026-08-10", "2026-09-06"],
  ].map(([title, startDate, dueDate], index) => ({ ...original, id: `boundary-${index}`, title, startDate, dueDate, milestone: false }));
  const { container } = render(<LanguageProvider lang="en"><TasksView data={data} /></LanguageProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Timeline", exact: true }));
  expect(container.querySelectorAll(".timeline-bar")).toHaveLength(4);

  const page = await browser.newPage({ viewport: { width, height: 900 } });
  try {
    // Rendered React markup and shipped CSS, not a duplicate bar calculation.
    await page.setContent(container.innerHTML);
    await page.addStyleTag({ content: css });
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      for (const bar of await page.locator(".timeline-bar").all()) {
        const bounds = await bar.evaluate(node => {
          const target = node.getBoundingClientRect(), track = node.parentElement.getBoundingClientRect();
          return { left: target.left - track.left, right: target.right - track.right,
            top: target.top - track.top, bottom: target.bottom - track.bottom, width: target.width, height: target.height,
            trackWidth: track.width, name: node.getAttribute("aria-label") };
        });
        // Fractional scrolling can subtract about 0.00003px from DOMRect.
        expect(bounds.width).toBeGreaterThanOrEqual(44 - 0.0001);
        expect(bounds.height).toBeGreaterThanOrEqual(44);
        expect(bounds.left).toBeGreaterThanOrEqual(-0.1);
        expect(bounds.right).toBeLessThanOrEqual(0.1);
        expect(bounds.top).toBeGreaterThanOrEqual(-0.1);
        expect(bounds.bottom).toBeLessThanOrEqual(0.1);
        if (bounds.name.startsWith("First day") || bounds.name.startsWith("Full window")) expect(Math.abs(bounds.left)).toBeLessThanOrEqual(0.1);
        if (bounds.name.startsWith("Last day") || bounds.name.startsWith("Full window")) expect(Math.abs(bounds.right)).toBeLessThanOrEqual(0.1);
        if (bounds.name.startsWith("Middle day")) {
          expect(bounds.left / bounds.trackWidth).toBeGreaterThan(0.4);
          expect(bounds.left / bounds.trackWidth).toBeLessThan(0.5);
        }
        await bar.focus();
        expect(await bar.evaluate(node => document.activeElement === node)).toBe(true);
      }
    }
  } finally { await page.close(); }
  fireEvent.click(screen.getByRole("button", { name: /^Last day, / }));
  expect(await screen.findByLabelText("Task title")).toHaveValue("Last day");
});
