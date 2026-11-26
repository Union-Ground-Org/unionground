// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, expect as browserExpect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { SharedMessageActions } from "../src/components/SharedMessageActions.jsx";

let browser;
let server;
let origin;
let cache;
const evidence = [];

beforeAll(async () => {
  cache = await mkdtemp(join(tmpdir(), "reply-focus-"));
  server = await createServer({
    configFile: false, envFile: false, root: fileURLToPath(new URL("..", import.meta.url)),
    cacheDir: cache, plugins: [react()], logLevel: "error",
    server: { host: "127.0.0.1", port: 0, watch: null },
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
}, BROWSER_HOOK_TIMEOUT);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (cache) await rm(cache, { recursive: true, force: true });
  const dir = process.env.REPLY_FOCUS_EVIDENCE;
  if (dir && evidence.length) await writeFile(join(dir, "focus.json"), `${JSON.stringify(evidence, null, 2)}\n`);
});

async function openWidth(width) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(`${origin}/tests/fixtures/reply-cancel-focus-browser.html`);
  await browserExpect(page.getByRole("button", { name: "Reply" }).first()).toBeVisible();
  return { context, page };
}

async function retain(page, name) {
  const dir = process.env.REPLY_FOCUS_EVIDENCE;
  if (!dir) return;
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}

it.each([1440, 320])("cancels a reply with Tab and Enter and keeps focus at %i CSS px", async (width) => {
  const { context, page } = await openWidth(width);
  try {
    const first = page.getByRole("article", { name: "The hall opens at six." });
    const second = page.getByRole("article", { name: "Bring the printed agenda." });
    const firstReply = first.getByRole("button", { name: "Reply", exact: true });
    const secondReply = second.getByRole("button", { name: "Reply", exact: true });

    await secondReply.click();
    const kept = second.getByRole("textbox", { name: "Reply to message" });
    await kept.fill("Keep this draft");

    await firstReply.click();
    const draft = first.getByRole("textbox", { name: "Reply to message" });
    await draft.fill("Discard this draft");
    await draft.press("Tab");
    await browserExpect(first.getByRole("button", { name: "Send reply" })).toBeFocused();
    await page.keyboard.press("Tab");
    await browserExpect(first.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Enter");
    await browserExpect(firstReply).toBeFocused();
    await browserExpect(first.getByRole("textbox")).toHaveCount(0);
    await browserExpect(first.getByText("Discard this draft")).toHaveCount(0);
    await browserExpect(kept).toHaveValue("Keep this draft");
    await browserExpect(second.getByText("Bring the printed agenda.")).toBeVisible();
    const afterCancel = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? "",
      name: document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent || "",
    }));
    expect(afterCancel.name).toBe("Reply");
    await retain(page, `reply-cancel-focus-${width}-after-cancel`);

    await firstReply.click();
    const again = first.getByRole("textbox", { name: "Reply to message" });
    await browserExpect(again).toHaveValue("");
    await again.fill("Sent from the hall");
    await again.press("Tab");
    await page.keyboard.press("Enter");
    await browserExpect(firstReply).toBeFocused();
    await browserExpect(first.getByRole("textbox")).toHaveCount(0);
    await browserExpect(kept).toHaveValue("Keep this draft");

    await page.evaluate(() => { window.__replyFocusFail = "m2"; });
    await kept.press("Tab");
    await page.keyboard.press("Enter");
    await browserExpect(second.getByRole("status")).toContainText("Action not confirmed. Try again.");
    await browserExpect(kept).toHaveValue("Keep this draft");
    const usable = await kept.evaluate((node) => node.closest(".thread-composer")?.contains(document.activeElement) ?? false);
    expect(usable).toBe(true);
    expect(typeof SharedMessageActions).toBe("function");

    const layout = await page.evaluate(() => {
      const main = document.querySelector("main");
      const paint = getComputedStyle(main);
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        background: paint.backgroundColor,
        colorScheme: paint.colorScheme,
      };
    });
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.colorScheme).toBe("light");
    const axe = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    const violations = axe.violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map((node) => node.target) }));
    evidence.push({ width, afterCancel, layout, violations, focusedInComposer: usable });
    await retain(page, `reply-cancel-focus-${width}-after-failure`);
    // Reaction summaries now give populated groups valid names and leave
    // empty summaries unnamed, so the reply focus proof must stay Axe-clean.
    expect(violations).toEqual([]);
  } finally {
    await context.close();
  }
}, 60000);
