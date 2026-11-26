// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mount the production view and adapter: static HTML cannot exercise their
// ResizeObservers or label measurements. All data and requests stay local.
const fixtureSource = `
import React from "react";
import { createRoot } from "react-dom/client";
import { OrganizationIntelligenceView } from "/src/views/OrganizationIntelligenceView.jsx";
import { CollectiveActionsView } from "/src/views/CollectiveActionsView.jsx";
import { createOrganizationIntelligenceAdapter } from "/src/features/organizationIntelligence/adapter.js";
import { ORGANIZATION_INTELLIGENCE_PREVIEW_SNAPSHOT as base } from "/tests/fixtures/retired-pre-bot/src/features/organizationIntelligence/preview.js";
import { nodes as chartNodes } from "/tests/fixtures/pr1815-chart-nodes.js";
import "/src/sg-tokens.css";
import "/src/styles.css";
const query = new URLSearchParams(location.search);
const people = Number(query.get("people") || 5000);
// hub: person-0 knows 250 people, so a focus neighbourhood is larger than the cap.
const hub = query.has("hub");
const edges = hub ? 250 : Math.min(100, people - 1);
let fixtureNodes = chartNodes;
if (query.has("rootless")) {
  fixtureNodes = chartNodes.slice(0, 2).map((node, index, pair) => ({
    ...node, positionX: 80 + index * 20, parentId: pair[1 - index].id,
  }));
} else if (query.has("titles")) {
  fixtureNodes = chartNodes.map(node => node.parentId ? node : {
    ...node, subtitle: "CrossDepartmentalOperationsAndWorkplaceCoordination Representative",
  });
}
const snapshot = { ...base, chartNodes: fixtureNodes,
  relationshipNodes: Array.from({ length: people }, (_, i) => ({
    id: "person-" + i,
    // long: one connected person, past the first roster and relationship pages, has an unbroken 160-character name.
    label: query.has("unbroken") || (query.has("long") && i === 60) ? "A".repeat(155) + String(i).padStart(5, "0") : "Alexandra Stephanie Montgomery Williamson " + i,
    roleLabel: "Member",
  })),
  relationships: Array.from({ length: edges }, (_, i) => ({ id: "edge-" + i, sourceId: hub ? "person-0" : "person-" + i, targetId: "person-" + (i + 1), kind: "works_with", strength: 3 })),
  topicProgress: [],
};
const actor = { userId: "fictional-reflow-reader", organizationId: base.organizationId, selectedHat: "steward", organizationRoles: ["steward"], membershipStatus: "active", organizationStatus: "active", mfaSatisfied: true };
const adapter = createOrganizationIntelligenceAdapter({ fetchIntelligence: async () => snapshot });
const actionsClient = { rpc: async (name) => ({
  data: name === "get_collective_actions"
    ? { organizationId: base.organizationId, actions: [
      { id: "other", kind: "other", status: "published", title: "Worksite action" },
      { id: "petition", kind: "petition", status: "published", title: "Public petition" },
      { id: "closed", kind: "picket", status: "closed", title: "Past picket" },
    ] }
    : [{ selected: true, organizationId: base.organizationId, organizationRoles: [], chapterRoles: [] }],
  error: null,
}) };
const view = query.has("actions")
  ? React.createElement(CollectiveActionsView, { actor: { ...actor, selectedHat: "member", organizationRoles: [] }, client: actionsClient })
  : React.createElement(OrganizationIntelligenceView, { actor, adapter });
createRoot(document.getElementById("root")).render(React.createElement("main", { className: "sg-app", "data-workspace-theme": query.get("theme"), style: { width: "100%" } }, view));
`;

let server, browser, cacheDir, origin;
beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "org-map-reflow-"));
  const fixtureId = join(process.cwd(), "__org-map-reflow-fixture.jsx");
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    cacheDir,
    optimizeDeps: { include: ["react", "react-dom/client"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
    plugins: [react(), {
      name: "org-map-local-reflow-fixture",
      resolveId(id) { if (id === "/__org-map-reflow-fixture.jsx") return fixtureId; },
      load(id) { if (id === fixtureId) return fixtureSource; },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url?.split("?")[0] !== "/__org-map-reflow") return next();
          try {
            const html = await vite.transformIndexHtml("/__org-map-reflow", '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__org-map-reflow-fixture.jsx"></script></body></html>');
            response.setHeader("Content-Type", "text/html");
            response.end(html);
          } catch (error) { next(error); }
        });
      },
    }],
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
}, BROWSER_HOOK_TIMEOUT);
afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
});

async function localPage(query, width = 1440) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(`${origin}/__org-map-reflow?${query}`);
  if (query.includes("actions=1")) await page.locator(".oi-action-card .oi-badge").first().waitFor();
  else await page.getByRole("button", { name: "Neuro Map" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
}

function graphGeometry() {
  const map = document.querySelector(".oi-map--relationships");
  const bounds = map.getBoundingClientRect();
  const pills = [...map.querySelectorAll(".oi-map__person")];
  const boxes = pills.map(pill => pill.getBoundingClientRect());
  const overlaps = boxes.flatMap((a, i) => boxes.slice(i + 1).filter(b =>
    Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1
    && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1));
  const outside = boxes.filter(box => box.left < bounds.left - 1 || box.right > bounds.right + 1
    || box.top < bounds.top - 1 || box.bottom > bounds.bottom + 1);
  const overflowingLabels = pills.filter((pill, i) => {
    const range = document.createRange();
    range.selectNodeContents(pill.querySelector("strong"));
    return [...range.getClientRects()].some(rect => rect.left < boxes[i].left || rect.right > boxes[i].right
      || rect.top < boxes[i].top || rect.bottom > boxes[i].bottom);
  });
  return { overlaps: overlaps.length, outside: outside.length, overflowingLabels: overflowingLabels.length,
    count: pills.length, lines: map.querySelectorAll("line").length,
    pageOverflow: document.documentElement.scrollWidth > innerWidth };
}

for (const theme of ["union-ground"]) {
  it.each(["multipart", "unbroken"])(`contains full %s names without pill collisions across reflow in ${theme}`, async labels => {
    const page = await localPage(`theme=${theme}${labels === "unbroken" ? "&unbroken=1" : ""}`);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.getByRole("button", { name: "Neuro Map" }).click();
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await expect.poll(() => page.evaluate(graphGeometry)).toEqual({
          overlaps: 0, outside: 0, overflowingLabels: 0, count: 101, lines: 100, pageOverflow: false,
        });
      }
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
}

// Ordinary names: the seven-person ring put its two lowest pills 27.8% of the
// width apart, closer than a 30% pill (adversarial review of #3992, round 1).
it.each([5, 7])("keeps a %i-person ring of ordinary names clear of collisions at phone widths", async people => {
  const page = await localPage(`theme=union-ground&people=${people}`);
  try {
    await page.getByRole("button", { name: "Neuro Map" }).click();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => page.evaluate(graphGeometry)).toEqual({
        overlaps: 0, outside: 0, overflowingLabels: 0, count: people, lines: people - 1, pageOverflow: false,
      });
    }
  } finally { await page.close(); }
}, 30000);

it("scrolls the row frame back to the top so a focused person is in view", async () => {
  const page = await localPage("theme=union-ground&hub=1");
  try {
    await page.getByRole("button", { name: "Neuro Map" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    const frame = page.getByRole("region", { name: "Relationship map rows" });
    await expect.poll(() => frame.evaluate(node => node.querySelectorAll(".oi-map__person").length)).toBe(200);
    expect(await frame.evaluate(node => { node.scrollTop = 600; return node.scrollTop; })).toBeGreaterThan(400);
    await page.getByLabel("Focus the map on one person").fill("Williamson 7");
    await page.getByRole("button", { name: "Focus on Alexandra Stephanie Montgomery Williamson 7", exact: true }).click();
    await expect.poll(() => frame.evaluate(node => {
      const focus = node.querySelector(".oi-map__person--focus");
      const box = focus?.getBoundingClientRect(); const view = node.getBoundingClientRect();
      return { scrollTop: node.scrollTop, name: focus?.querySelector("strong")?.textContent ?? null, count: node.querySelectorAll(".oi-map__person").length,
        inView: Boolean(box) && box.top >= view.top - 1 && box.bottom <= view.bottom + 1 };
    })).toEqual({ scrollTop: 0, name: "Alexandra Stephanie Montgomery Williamson 7", count: 200, inView: true });
    // Choosing the person already in focus scrolls back up as well.
    expect(await frame.evaluate(node => { node.scrollTop = 600; return node.scrollTop; })).toBeGreaterThan(400);
    await page.getByLabel("Focus the map on one person").fill("Williamson 7");
    await page.getByRole("button", { name: "Focus on Alexandra Stephanie Montgomery Williamson 7", exact: true }).click();
    await expect.poll(() => frame.evaluate(node => ({ scrollTop: node.scrollTop, name: node.querySelector(".oi-map__person--focus strong").textContent }))).toEqual({ scrollTop: 0, name: "Alexandra Stephanie Montgomery Williamson 7" });
  } finally { await page.close(); }
}, 30000);

// The relationship rows list already makes this card about 20px wider than a
// 320px viewport (its own record); the search result and the legend must not
// widen it further and must stay inside the viewport.
it("keeps a long unbroken name inside the card in the search results and the legend", async () => {
  const page = await localPage("theme=union-ground&long=1");
  try {
    await page.getByRole("button", { name: "Neuro Map" }).click();
    await page.setViewportSize({ width: 320, height: 900 });
    await page.getByLabel("Focus the map on one person").fill("AAAAAA");
    const match = page.getByRole("button", { name: /^Focus on AAAA/ });
    await expect.poll(() => match.evaluate(node => { const box = node.getBoundingClientRect(); const card = node.closest(".oi-card").getBoundingClientRect(); return { fits: box.right <= card.right + 1 && box.left >= card.left - 1, inViewport: box.right <= innerWidth + 1, tall: box.height >= 48, pageOverflow: document.documentElement.scrollWidth > innerWidth }; })).toEqual({ fits: true, inViewport: true, tall: true, pageOverflow: false });
    await match.click();
    await expect.poll(() => page.evaluate(() => { const legend = [...document.querySelectorAll(".oi-map-hint")].at(-1); const box = legend.getBoundingClientRect(); const card = legend.closest(".oi-card").getBoundingClientRect(); return { focused: legend.textContent.startsWith("The map shows AAAA"), fits: box.right <= card.right + 1, inViewport: box.right <= innerWidth + 1, pageOverflow: document.documentElement.scrollWidth > innerWidth }; })).toEqual({ focused: true, fits: true, inViewport: true, pageOverflow: false });
  } finally { await page.close(); }
}, 30000);

it.each([2, 3, 7])("keeps tall labels contained in a %i-person connected map", async people => {
  const page = await localPage(`theme=union-ground&people=${people}&unbroken=1`);
  try {
    await page.getByRole("button", { name: "Neuro Map" }).click();
    await page.setViewportSize({ width: 320, height: 900 });
    await expect.poll(() => page.evaluate(graphGeometry)).toEqual({
      overlaps: 0, outside: 0, overflowingLabels: 0, count: people, lines: people - 1, pageOverflow: false,
    });
  } finally { await page.close(); }
}, 30000);

it("keeps both chart roots visible when their mounted frames narrow", async () => {
  const page = await localPage("theme=union-ground");
  try {
    expect(await page.locator(".oi-map-scroll").count()).toBe(2);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => page.locator(".oi-map-scroll").evaluateAll(frames => frames.every((frame, index) => {
        const name = ["Human Services Agency", "Statewide Council"][index];
        const root = [...frame.querySelectorAll(".oi-map__node")].find(node => node.textContent.includes(name));
        const bounds = frame.getBoundingClientRect(), box = root.getBoundingClientRect();
        return box.left >= bounds.left && box.right <= bounds.right;
      }))).toBe(true);
    }
  } finally { await page.close(); }
}, 30000);

it("opens a rootless chart on a visible card and keeps horizontal panning", async () => {
  const page = await localPage("theme=union-ground&rootless=1", 320);
  try {
    const frame = page.getByRole("group", { name: "Agency persisted layout" });
    const initial = await frame.evaluate(element => {
      const view = element.getBoundingClientRect();
      const card = element.querySelector(".oi-map__node").getBoundingClientRect();
      return {
        centered: Math.abs(view.left + view.right - card.left - card.right) < 3,
        scrollable: element.scrollWidth > element.clientWidth,
      };
    });
    expect(initial).toEqual({ centered: true, scrollable: true });
    await frame.evaluate(element => { element.scrollLeft = 0; });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await frame.evaluate(element => element.scrollLeft)).toBe(0);
  } finally { await page.close(); }
}, 30000);

it.each([1280, 320])("shows staff chart labels and full subtitles at %i px", async width => {
  const page = await localPage("theme=union-ground&titles=1", width);
  try {
    const roots = page.locator(".oi-map__node").filter({ hasText: /Human Services Agency|Statewide Council/ });
    expect(await roots.evaluateAll(cards => cards.map(card => {
      const title = card.querySelector("small");
      const range = document.createRange();
      range.selectNodeContents(title);
      const bounds = title.getBoundingClientRect();
      const text = [...range.getClientRects()];
      return {
        minFont: Math.min(...[...card.querySelectorAll("span, strong, small")].map(label => parseFloat(getComputedStyle(label).fontSize))),
        fullTitle: text.length > 1 && text.every(rect => rect.left >= bounds.left && rect.right <= bounds.right + 1
          && rect.top >= bounds.top && rect.bottom <= bounds.bottom + 1),
      };
    }))).toEqual([{ minFont: 11, fullTitle: true }, { minFont: 11, fullTitle: true }]);
    const outlineBadge = page.locator(".oi-tree__node").filter({ hasText: "Human Services Agency" }).locator(".oi-badge").first();
    expect(await outlineBadge.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(11);
  } finally { await page.close(); }
}, 30000);

it("keeps collective-action kind and status badges at least 11px", async () => {
  const page = await localPage("theme=union-ground&actions=1");
  try {
    const badges = page.locator(".oi-action-card :is(.oi-badge, .oi-status)");
    await expect.poll(() => badges.allTextContents()).toEqual(["Petition", "Published", "Other", "Published", "Picket", "Closed"]);
    expect(await badges.evaluateAll(elements =>
      Math.min(...elements.map(element => parseFloat(getComputedStyle(element).fontSize))))).toBeGreaterThanOrEqual(11);
    const closed = page.locator(".oi-action-card .oi-status--closed");
    expect(await closed.evaluate(element => {
      const { fontSize, color, backgroundColor } = getComputedStyle(element);
      return { fontSize, color, backgroundColor };
    })).toEqual({
      fontSize: "11px",
      color: "rgb(61, 74, 68)",
      backgroundColor: "rgb(235, 231, 220)",
    });
  } finally { await page.close(); }
}, 30000);
