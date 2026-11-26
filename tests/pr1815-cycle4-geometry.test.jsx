import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { chromium } from "@playwright/test";
import { browserMarkup } from "./helpers/browserMarkup.js";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { OfficerQaQueue } from "../src/features/qa/OfficerQaQueue.jsx";
import { OrganizationIntelligenceView } from "../src/views/OrganizationIntelligenceView.jsx";
import { nodes, relationshipNodes } from "./fixtures/pr1815-chart-nodes.js";
import { collectVisualMeasurements, classifyVisualMeasurements } from "../scripts/visual-audit.mjs";
const fixture = vi.hoisted(() => ({ dense: true }));
vi.mock("./fixtures/retired-pre-bot/src/features/organizationIntelligence/preview.js", async importOriginal => {
  const original = await importOriginal();
  const seeded = await import("./fixtures/pr1815-chart-nodes.js");
  return { ...original, ORGANIZATION_INTELLIGENCE_PREVIEW_SNAPSHOT: {
    ...original.ORGANIZATION_INTELLIGENCE_PREVIEW_SNAPSHOT,
    get chartNodes() { return fixture.dense ? seeded.nodes : original.ORGANIZATION_INTELLIGENCE_PREVIEW_SNAPSHOT.chartNodes; },
    get relationshipNodes() { return fixture.dense ? seeded.relationshipNodes : original.ORGANIZATION_INTELLIGENCE_PREVIEW_SNAPSHOT.relationshipNodes; },
    get relationships() { return fixture.dense ? seeded.relationships : original.ORGANIZATION_INTELLIGENCE_PREVIEW_SNAPSHOT.relationships; },
    get topicProgress() { return fixture.dense ? seeded.topicProgress : original.ORGANIZATION_INTELLIGENCE_PREVIEW_SNAPSHOT.topicProgress; },
    get timeline() { return fixture.dense ? seeded.timeline : original.ORGANIZATION_INTELLIGENCE_PREVIEW_SNAPSHOT.timeline; },
  } };
});
let browser;
const css = (await Promise.all(["sg-tokens.css", "styles.css", "features/organizationIntelligence/organization-intelligence.css"]
  .map(path => readFile(resolve("src", path), "utf8")))).join("\n");
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });
const actor = { userId: "staff", organizationId: "preview-organization-intelligence", chapterId: "chapter", selectedHat: "admin", organizationRoles: ["admin"], chapterRoles: [], organizationStatus: "active", membershipStatus: "active", mfaSatisfied: true };
async function pageFor(markup, width, theme) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : width === 768 ? 1024 : 900 }, colorScheme: theme, reducedMotion: "reduce" });
  page.setDefaultTimeout(2000);
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.origin === "http://127.0.0.1:56810" && /^\/assets\/.*\.woff2$/.test(url.pathname)
      ? route.fulfill({ path: resolve("public", url.pathname.slice(1)), contentType: "font/woff2" }) : route.abort();
  });
  await page.setContent(`<base href="http://127.0.0.1:56810/"><main class="sg-app" data-workspace-theme="union-ground" style="width:${width >= 1024 ? width - 520 : width}px">${markup}</main>`);
  await page.addStyleTag({ content: css });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

async function contrastRatios(page, selector) {
  return page.locator(selector).evaluateAll(items => {
    const rgb = value => {
      const match = value.match(/^rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\)$/);
      return match ? [+match[1], +match[2], +match[3], match[4] === undefined ? 1 : +match[4]] : null;
    };
    const luminance = channels => channels.map(channel => {
      const value = channel / 255;
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    return items.map(item => {
      const foreground = rgb(getComputedStyle(item).color);
      let background = [255, 255, 255];
      const chain = [];
      for (let ancestor = item; ancestor; ancestor = ancestor.parentElement) chain.unshift(ancestor);
      for (const ancestor of chain) {
        const color = rgb(getComputedStyle(ancestor).backgroundColor);
        if (color) background = color.slice(0, 3).map((channel, index) => channel * color[3] + background[index] * (1 - color[3]));
      }
      const painted = foreground.slice(0, 3).map((channel, index) => channel * foreground[3] + background[index] * (1 - foreground[3]));
      const a = luminance(painted), b = luminance(background);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    });
  });
}
for (const theme of ["light"]) {
  it.each([390, 768, 1440])(`keeps officer question targets contained in ${theme} at %i px`, async width => {
    const title = "When does overtime start after a forced stay?"; // mi1-member-qa-ui fixture
    const onOpen = vi.fn();
    const { container } = render(<div className="cwk-plane"><OfficerQaQueue actor={actor} questions={[{ id: "question", title, body: "Night shift was held two hours past the posted end without a written order.", authorDisplayName: "Sam O." }]} onOpen={onOpen} /></div>);
    const page = await pageFor(browserMarkup(container), width, theme);
    try {
      const button = page.locator('[data-qa-surface="officer-queue"] .cwk-email > .cwk-btn--ghost');
      for (const state of ["default", "hover", "focus"]) {
        if (state === "hover") await button.hover();
        if (state === "focus") await button.focus();
        const box = await button.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        const audit = classifyVisualMeasurements(await page.evaluate(collectVisualMeasurements));
        expect(audit.failures.filter(row => ["clipped-interactive", "horizontal-overflow"].includes(row.rule))).toEqual([]);
      }
      // The maximum legal unbroken title also wraps on phones.
      if (width === 390) {
        await button.evaluate(node => { node.textContent = "x".repeat(200); });
        const box = await button.boundingBox();
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(await button.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      }
    } finally { await page.close(); }
    fireEvent.click(within(container).getByRole("button", { name: title }));
    expect(onOpen).toHaveBeenCalledWith("question");
  });
  for (const dense of [true, false]) it.each([390, 768, 1440])(`keeps ${dense ? "25-node seed" : "3-node preview"} charts separated and editable in ${theme} at %i px`, async width => {
    fixture.dense = dense;
    const sourceBefore = JSON.stringify(nodes);
    const { container } = render(<OrganizationIntelligenceView actor={actor} preview />);
    await waitFor(() => expect(container.querySelectorAll(".oi-map__node")).toHaveLength(dense ? 50 : 6));
    const savedEdges = [...container.querySelectorAll(".oi-map__lines")].map(svg => svg.innerHTML);
    const page = await pageFor(browserMarkup(container), width, theme);
    try {
      expect(classifyVisualMeasurements(await page.evaluate(collectVisualMeasurements)).failures).toEqual([]);
      for (const chart of await page.locator(".oi-map--chart").all()) {
        const boxes = await chart.locator(".oi-map__node").evaluateAll(items => items.map(node => {
          const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        }));
        for (let i = 0; i < boxes.length; i++) {
          expect(boxes[i].height).toBeGreaterThanOrEqual(44);
          for (let j = i + 1; j < boxes.length; j++) {
            const overlapX = Math.min(boxes[i].right, boxes[j].right) - Math.max(boxes[i].left, boxes[j].left);
            const overlapY = Math.min(boxes[i].bottom, boxes[j].bottom) - Math.max(boxes[i].top, boxes[j].top);
            expect(overlapX <= 0 || overlapY <= 0, `node ${i} collides with ${j}`).toBe(true);
          }
        }
        expect(await chart.locator("line").count()).toBe(dense ? 24 : 2);
        for (const control of await chart.locator("button").all()) {
          await control.focus();
          await control.scrollIntoViewIfNeeded();
          // Trial click checks actual hit testing without replacing React behavior.
          await control.click({ trial: true });
          const contained = await control.evaluate(node => {
            const r = node.getBoundingClientRect(), clip = node.closest(".oi-map-scroll").getBoundingClientRect();
            return r.left >= clip.left - .5 && r.right <= clip.right + .5;
          });
          expect(contained).toBe(true);
        }
      }
      for (const control of await page.locator(".oi-tree .oi-link, .oi-form button").all()) await control.click({ trial: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(classifyVisualMeasurements(await page.evaluate(collectVisualMeasurements)).failures).toEqual([]);
    } finally { await page.close(); }
    // Opening and saving an existing node retains its saved coordinates/parent.
    const target = dense ? nodes[24] : null;
    const control = container.querySelectorAll(".oi-map__node")[dense ? 24 : 2];
    fireEvent.click(control);
    const form = container.querySelector(".oi-form");
    const values = ["Parent", "Horizontal position", "Vertical position"].map(label => within(form).getByLabelText(label).value);
    if (target) expect(values).toEqual([target.parentId, String(target.positionX), String(target.positionY)]);
    fireEvent.submit(form);
    await waitFor(() => expect(within(container).getByText("Saved.")).toBeInTheDocument());
    expect(container.querySelectorAll(".oi-map__node")).toHaveLength(dense ? 50 : 6);
    expect(JSON.stringify(nodes)).toBe(sourceBefore);
    expect([...container.querySelectorAll(".oi-map__lines")].map(svg => svg.innerHTML)).toEqual(savedEdges);
  }, 30000);

  it.each([390, 768, 1440])("keeps capped relationship role and 25 roster labels above AA at %i px", async width => {
    fixture.dense = true;
    const { container, unmount } = render(<OrganizationIntelligenceView actor={actor} preview />);
    await waitFor(() => expect(container.querySelector(".oi-tabs")).toBeInTheDocument());
    fireEvent.click(within(container).getByRole("button", { name: "Neuro Map" }));
    // The map draws every person who has a relationship, on rows past a ring's worth
    // (BUG-UG-WEB-NEURO-MAP-DRAWS-EVERYONE-ON-ONE-RING-20261002).
    await waitFor(() => expect(container.querySelectorAll(".oi-map__person")).toHaveLength(relationshipNodes.length));
    const page = await pageFor(browserMarkup(container), width, theme);
    try {
      expect(await page.locator(".oi-map__person small").count()).toBe(relationshipNodes.length);
      expect(await page.locator(".oi-person small").count()).toBe(25);
      for (const selector of [".oi-map__person small", ".oi-person small"]) {
        const ratios = await contrastRatios(page, selector);
        expect(ratios).toEqual(expect.arrayContaining([expect.any(Number)]));
        expect(ratios.every(ratio => ratio >= 4.5), `${selector}: ${ratios.join(", ")}`).toBe(true);
      }
      expect(classifyVisualMeasurements(await page.evaluate(collectVisualMeasurements)).failures).toEqual([]);
    } finally { await page.close(); unmount(); }
  });

  it.each([390, 768, 1440])("keeps 25 timeline badges clear of titles and source labels above AA at %i px", async width => {
    fixture.dense = true;
    const { container, unmount } = render(<OrganizationIntelligenceView actor={actor} preview />);
    await waitFor(() => expect(container.querySelector(".oi-tabs")).toBeInTheDocument());
    fireEvent.click(within(container).getByRole("button", { name: "Leadership & payroll" }));
    await waitFor(() => expect(container.querySelectorAll(".oi-timeline article")).toHaveLength(25));
    const page = await pageFor(browserMarkup(container), width, theme);
    try {
      expect(await page.locator(".oi-timeline .oi-badge").count()).toBe(25);
      expect(await page.locator(".oi-timeline small").count()).toBeGreaterThan(0);
      expect((await contrastRatios(page, ".oi-timeline small")).every(ratio => ratio >= 4.5)).toBe(true);
      const collisions = await page.locator(".oi-timeline article").evaluateAll(items => items.filter(item => {
        const badge = item.querySelector(".oi-badge").getBoundingClientRect();
        const title = item.querySelector("h3").getBoundingClientRect();
        return Math.min(badge.right, title.right) > Math.max(badge.left, title.left)
          && Math.min(badge.bottom, title.bottom) > Math.max(badge.top, title.top);
      }).length);
      expect(collisions).toBe(0);
      expect(classifyVisualMeasurements(await page.evaluate(collectVisualMeasurements)).failures).toEqual([]);
    } finally { await page.close(); unmount(); }
  });
}
