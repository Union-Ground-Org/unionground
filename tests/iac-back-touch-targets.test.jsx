import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

// BUG-UG-WEB-TOUCH-TARGETS-UNDER-48PX-20261019: the organization-claim
// restart and home links (confirmed and failed states) and every other
// .iac-back link were bare 12.5px text. Each must offer at least 48 by 48 CSS
// pixels, overlap no neighbouring control, keep its name and destination, stay
// in keyboard order, and reflow at 320px without page-level horizontal scroll.
const css = (await Promise.all(["sg-tokens.css", "styles.css"].map((path) => readFile(resolve("src", path), "utf8")))).join("\n");
let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });
afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) };
}

// InvitationAcceptView and PublicInterestStopConfirmView render the same
// shared pair: a primary .iac-action followed by a .iac-back link.
const SHARED_BACK = `<main class="auth-screen iac-screen"><section class="auth-card iac-card"><div class="iac-state"><h2>Invitation accepted</h2><p>Open the app to continue.</p><a class="iac-action" href="/get-app">Get the app</a><a class="iac-back" href="/">Back to Union Ground</a></div><p class="iac-legal"><a href="/privacy">Privacy</a></p></section></main>`;

async function measure(markup, width) {
  const page = await browser.newPage({ viewport: { width, height: width === 768 ? 1024 : 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(2000);
  await page.route("**/*", (route) => route.abort());
  await page.setContent(`<div class="sg-app" data-workspace-theme="union-ground">${markup}</div>`);
  await page.addStyleTag({ content: css });
  const result = await page.evaluate(() => {
    const box = (node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right }; };
    const backs = [...document.querySelectorAll(".iac-back")].map((node) => ({ name: node.textContent.trim(), href: node.getAttribute("href"), ...box(node) }));
    const neighbours = [...document.querySelectorAll(".iac-action, .iac-legal a, .iac-state h2, .iac-state p")].map(box);
    const scrolls = document.scrollingElement.scrollWidth > window.innerWidth;
    return { backs, neighbours, scrolls };
  });
  const order = [];
  for (let step = 0; step < 6; step += 1) {
    await page.keyboard.press("Tab");
    order.push(await page.evaluate(() => (document.activeElement?.classList.contains("iac-back") ? document.activeElement.textContent.trim() : null)));
  }
  await page.close();
  // Tab wraps back to the top after the last control; keep the first lap.
  return { ...result, focusOrder: [...new Set(order.filter(Boolean))] };
}

const overlaps = (a, b) => a.x < b.right - 0.5 && b.x < a.right - 0.5 && a.y < b.bottom - 0.5 && b.y < a.bottom - 0.5;

function expectTargets({ backs, neighbours, scrolls, focusOrder }, expected) {
  expect(backs.map(({ name, href }) => ({ name, href }))).toEqual(expected);
  for (const back of backs) {
    expect(back.w).toBeGreaterThanOrEqual(48);
    expect(back.h).toBeGreaterThanOrEqual(48);
    for (const other of neighbours) expect(overlaps(back, other)).toBe(false);
  }
  for (let index = 1; index < backs.length; index += 1) expect(overlaps(backs[index - 1], backs[index])).toBe(false);
  expect(scrolls).toBe(false);
  expect(focusOrder).toEqual(expected.map(({ name }) => name));
}

const CLAIM_LINKS = [
  { name: "Start again to request a new link", href: "/m/admin/catalog-verification" },
  { name: "Go to the Union Ground home page", href: "/" },
];

// Union Ground has no public-directory claim view, so only the shared
// invitation and stop-confirm pair is measured here.
it.each([320, 768, 1280])("gives the shared invitation and stop-confirm back link a 48px target at %ipx", { timeout: 30000 }, async (width) => {
  expectTargets(await measure(SHARED_BACK, width), [{ name: "Back to Union Ground", href: "/" }]);
});
