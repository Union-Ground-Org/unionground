// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";

// REQ-UG-FIRST-CLICK-AND-DEAD-CONTROLS-20261030: every detail
// surface (the member card with Sign out, a case, the minutes editor with
// Publish, Messages > Contacts, the task workspace) takes pointer input two
// frames after it mounts. The old entrance rose from beyond the viewport for
// 800ms, so the first click aimed at a button landed on another control or on
// the scrim, which closes the dialog. This drives the shipped CSS in Chromium
// through the same opening -> open phase change useTransitionPresence makes.

let browser;
const css = (await Promise.all(["sg-tokens.css", "styles.css", "motion.css"]
  .map(path => readFile(new URL(`../src/${path}`, import.meta.url), "utf8")))).join("\n");

beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

const CARRIERS = [
  {
    name: "dialog",
    markup: `<div class="dialog-backdrop sg-detail-layer" data-state="opening" role="presentation">
      <section class="app-dialog sg-detail-surface" role="dialog" aria-modal="true" aria-label="Member card">
        <header><div><h2 tabindex="-1">Member card</h2></div></header>
        <div class="app-dialog__body"><form class="stack-form"><label>First name<input name="firstName" value="Darnell"></label></form>
        <div class="dialog-secondary-row"><button class="dialog-secondary" type="button" id="target">Sign out</button></div></div>
      </section></div>`,
  },
  {
    name: "task workspace",
    markup: `<div class="kan-modal-backdrop sg-detail-layer" data-state="opening">
      <section class="kan-modal sg-detail-surface" role="dialog" aria-label="Task" tabindex="-1">
        <article class="kan-modal__card"><button type="button" id="target">Edit description</button></article>
      </section></div>`,
  },
  {
    name: "workstream editor",
    markup: `<div class="task-editor-backdrop sg-detail-layer" data-state="opening">
      <section class="task-editor sg-detail-surface" role="dialog" aria-label="Workstream"><button type="button" id="target">Save</button></section></div>`,
  },
];

for (const carrier of CARRIERS) {
  it(`settles the ${carrier.name} entrance before a first click lands`, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, reducedMotion: "no-preference" });
    try {
      await page.setContent(`<main class="sg-app" data-workspace-theme="union-ground"><p>Page under the layer</p></main>`);
      await page.addStyleTag({ content: css });
      const rest = await page.evaluate(async (markup) => {
        document.body.insertAdjacentHTML("beforeend", markup);
        const layer = document.body.lastElementChild;
        const target = () => document.getElementById("target").getBoundingClientRect();
        const frame = () => new Promise(requestAnimationFrame);
        await frame();
        await frame();
        layer.dataset.state = "open";
        window.__openedAt = performance.now();
        // Final resting place: what the person sees once everything stops.
        await new Promise(resolve => setTimeout(resolve, 1500));
        const settled = target();
        return { x: settled.left + settled.width / 2, y: settled.top + settled.height / 2 };
      }, carrier.markup);

      // Replay the entrance and sample where the control is 250ms in: the
      // pointer input a person aims at the resting place must reach it.
      const early = await page.evaluate(async ({ markup, rest }) => {
        document.body.lastElementChild.remove();
        document.body.insertAdjacentHTML("beforeend", markup);
        const layer = document.body.lastElementChild;
        const frame = () => new Promise(requestAnimationFrame);
        await frame();
        await frame();
        layer.dataset.state = "open";
        await new Promise(resolve => setTimeout(resolve, 250));
        const box = document.getElementById("target").getBoundingClientRect();
        const hit = document.elementFromPoint(rest.x, rest.y);
        return {
          dy: Math.abs(box.top + box.height / 2 - rest.y),
          hit: hit?.id || hit?.closest?.("#target")?.id || hit?.className || hit?.tagName,
          pointerEvents: getComputedStyle(layer).pointerEvents,
        };
      }, { markup: carrier.markup, rest });

      expect(early.pointerEvents).toBe("auto");
      expect(early.dy, `${carrier.name} still moving 250ms after it takes input`).toBeLessThanOrEqual(1);
      expect(early.hit).toBe("target");
    } finally {
      await page.close();
    }
  });
}

it("keeps the long exit travel: a closing surface still leaves toward the viewport bottom", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, reducedMotion: "no-preference" });
  try {
    await page.setContent(`<main class="sg-app" data-workspace-theme="union-ground"></main>`);
    await page.addStyleTag({ content: css });
    // Read each phase's target transform, not a value mid-transition.
    await page.addStyleTag({ content: ".sg-detail-surface { transition: none !important; }" });
    const transforms = await page.evaluate(() => {
      document.body.insertAdjacentHTML("beforeend", `<div class="dialog-backdrop sg-detail-layer" data-state="opening"><section class="app-dialog sg-detail-surface" role="dialog" aria-label="Probe"><button type="button">Probe</button></section></div>`);
      const layer = document.body.lastElementChild;
      const surface = layer.firstElementChild;
      const opening = getComputedStyle(surface).transform;
      layer.dataset.state = "closing";
      const closing = getComputedStyle(surface).transform;
      const y = (matrix) => Number(matrix.match(/matrix\(([^)]+)\)/)?.[1].split(",")[5] ?? 0);
      return { opening: y(opening), closing: y(closing), height: surface.getBoundingClientRect().height };
    });
    expect(transforms.opening).toBeGreaterThan(0);
    expect(transforms.opening).toBeLessThanOrEqual(16);
    expect(transforms.closing).toBeGreaterThan(transforms.height);
  } finally {
    await page.close();
  }
});
