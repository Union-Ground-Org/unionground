// @vitest-environment node
// REQ-UG-TENANT-ORG-CHART-BASELINE-20261030. The owner-selected
// reference charts set the functional baseline: hierarchy, expand and collapse,
// filtering and reflow. Under the supported-functional mobile-web policy in
// AGENTS.md this is a focused desktop-browser check, not a phone-browser lane:
// it mounts the production member view in desktop Chromium with a synthetic
// chart (no organization's people or structure) and checks reflow at 320 CSS
// pixels (WCAG 1.4.10), disclosure and target sizes at 320 and 1440 pixels.
// Phone proof stays with the native device windows.
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractText } from "unpdf";

const fixtureSource = `
import React from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "/src/lib/LanguageContext.jsx";
import { loadLanguage } from "/src/lib/i18n.js";
import { OrgStructureView } from "/src/views/OrgStructureView.jsx";
import { normalizeOrganizationStructure } from "/src/lib/memberApi.js";
import "/src/sg-tokens.css";
import "/src/styles.css";
const query = new URLSearchParams(location.search);
await loadLanguage(query.get("lang") || "en");
const long = "Synthetic regional coordination and member engagement seat with an unusually long title";
const nodes = [{ id: "root", parentId: null, nodeKind: "organization", label: "Synthetic council", seatStatus: "confirmed", seatStatusReviewedOn: "2026-10-01" }];
for (let d = 0; d < 6; d += 1) {
  const division = "division-" + d;
  nodes.push({ id: division, parentId: "root", nodeKind: "division", label: "Synthetic division " + d, collapsedByDefault: d > 1 });
  for (let s = 0; s < 6; s += 1) {
    const seat = division + "-seat-" + s;
    nodes.push({ id: seat, parentId: division, nodeKind: "role", label: s === 0 ? long : "Synthetic seat " + d + "." + s,
      vacant: s === 2, seatStatus: s === 3 ? "unknown" : s === 4 ? "stale" : "unconfirmed",
      sourceLabel: "Synthetic roster", sourceAsOf: "2026-10-01" });
    if (s === 1) nodes.push({ id: seat + "-deep", parentId: seat, nodeKind: "person", label: "Synthetic deep seat " + d });
  }
}
const structure = normalizeOrganizationStructure({ organizationId: "org-synthetic", chapterId: "chapter-synthetic",
  charts: [{ chartKind: "union", nodes, edges: [] }, { chartKind: "agency", nodes: [{ id: "agency", label: "Synthetic employer" }], edges: [] }] });
if (query.get("short")) structure.charts[0].nodes = structure.charts[0].nodes.slice(0, 3);
const view = React.createElement(LanguageProvider, { lang: query.get("lang") || "en" }, React.createElement(OrgStructureView, { structure }));
createRoot(document.getElementById("root")).render(query.has("print") ? React.createElement("div", { className: "sg-app sg-app--desktop", "data-workspace-theme": query.get("theme"), style: { width: "100%", minHeight: "100vh" } },
  React.createElement("a", { className: "skip-link", href: "#main" }, "SHELL SKIP LINK"),
  React.createElement("nav", null, "SHELL NAVIGATION"),
  React.createElement("div", { className: "sg-shell-body", style: { height: "100vh", overflow: "auto" } },
    React.createElement("aside", null, "SHELL TOUR AND ROLE CONTROLS"),
    React.createElement("main", { id: "main", className: "app-column" },
      React.createElement("div", { role: "status" }, "SHELL LEARNING BANNER"),
      view)),
  React.createElement("footer", null, "SHELL FOOTER")) : React.createElement("main", { className: "sg-app", "data-workspace-theme": query.get("theme"), style: { width: "100%" } }, view));
`;

let server, browser, cacheDir, origin;
beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "org-chart-reflow-"));
  const fixtureId = join(process.cwd(), "__org-chart-reflow-fixture.jsx");
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    cacheDir,
    optimizeDeps: { include: ["react", "react-dom/client"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
    plugins: [react(), {
      name: "org-chart-local-reflow-fixture",
      resolveId(id) { if (id === "/__org-chart-reflow-fixture.jsx") return fixtureId; },
      load(id) { if (id === fixtureId) return fixtureSource; },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url?.split("?")[0] !== "/__org-chart-reflow") return next();
          try {
            const html = await vite.transformIndexHtml("/__org-chart-reflow", '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__org-chart-reflow-fixture.jsx"></script></body></html>');
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

function layout() {
  const outline = document.querySelector(".orgstructure-tree");
  const controls = [...document.querySelectorAll(".orgstructure button, .orgstructure select, .orgstructure input")]
    .filter((element) => element.offsetParent !== null && !element.closest(".oi-map-scroll"));
  const small = controls.filter((element) => {
    const box = element.getBoundingClientRect();
    return box.height < 44 || box.width < 44;
  }).map((element) => element.textContent || element.getAttribute("aria-label"));
  const clipped = [...document.querySelectorAll(".orgstructure-tree__node")].filter((element) => element.scrollWidth > element.clientWidth + 1).length;
  return {
    pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    outlineOverflow: outline.scrollWidth > outline.clientWidth + 1,
    small,
    clipped,
    rows: document.querySelectorAll(".orgstructure-tree__node").length,
  };
}

it.each(["en", "es"])("prints only the complete outline in Letter PDFs (%s)", async (lang) => {
  for (const short of [true, false]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${origin}/__org-chart-reflow?print=1&lang=${lang}${short ? "&short=1" : ""}`);
      const print = page.getByRole("button", { name: lang === "en" ? "Print chart" : "Imprimir organigrama" });
      await print.waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => { window.print = () => { window.__chartPrinted = true; }; });
      // Reach Print from its next action using the keyboard, retaining visible focus.
      await page.locator(".orgstructure__actions button").last().focus();
      await page.keyboard.press("Shift+Tab");
      await expect.poll(() => print.evaluate((button) => button === document.activeElement && getComputedStyle(button).outlineStyle !== "none")).toBe(true);
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => window.__chartPrinted)).toBe(true);
      await page.emulateMedia({ media: "print" });
      const layout = await page.locator(".orgstructure").evaluate((chart) => ({
        color: getComputedStyle(chart.querySelector("strong")).color,
        background: getComputedStyle(chart).backgroundColor,
        pageBackground: getComputedStyle(document.documentElement).backgroundColor,
        clipped: [...chart.querySelectorAll(".orgstructure-tree__node")].some((node) => node.scrollWidth > node.clientWidth + 1),
      }));
      expect(layout).toEqual({ color: "rgb(0, 0, 0)", background: "rgb(255, 255, 255)", pageBackground: "rgb(255, 255, 255)", clipped: false });
      const labels = await page.locator(".orgstructure-tree__node strong").allTextContents();
      expect(labels).toHaveLength(short ? 3 : 49);
      const name = `org-chart-print-${lang}-${short ? "short" : "long"}.pdf`;
      const pdf = await page.pdf({ format: "Letter", preferCSSPageSize: true, printBackground: true,
        ...(process.env.ORG_CHART_SCREENSHOT_DIR ? { path: join(process.env.ORG_CHART_SCREENSHOT_DIR, name) } : {}) });
      const { text, totalPages } = await extractText(new Uint8Array(pdf), { mergePages: false });
      if (short) expect(totalPages).toBe(1);
      else expect(totalPages).toBeGreaterThan(1);
      expect(text.every((value) => value.trim().length > 0)).toBe(true);
      const content = text.join("\n");
      expect(content).not.toContain("SHELL");
      expect(content).toContain(lang === "en" ? "Org structure" : "Estructura organizativa");
      expect(content).toContain(lang === "en" ? "Vacant" : "Vacante");
      expect(content).not.toContain(lang === "en" ? "Download chart" : "Descargar organigrama");
      for (const label of labels) expect(content.replaceAll(/\s+/g, " ")).toContain(label);
    } finally { await page.close(); }
  }
}, BROWSER_HOOK_TIMEOUT);

for (const theme of ["union-ground"]) {
  it.each([320, 1440])(`reflows the chart outline without page scroll at %ipx in ${theme}`, async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/__org-chart-reflow?theme=${theme}`);
    await page.getByRole("button", { name: "Expand all" }).waitFor();
    await page.evaluate(() => document.fonts.ready);

    const initial = await page.evaluate(layout);
    expect(initial.pageOverflow).toBe(false);
    expect(initial.outlineOverflow).toBe(false);
    expect(initial.clipped).toBe(0);
    expect(initial.small).toEqual([]);

    await page.getByRole("button", { name: "Expand all" }).click();
    const expanded = await page.evaluate(layout);
    expect(expanded.rows).toBe(1 + 6 + 36 + 6);
    expect(expanded.pageOverflow).toBe(false);
    expect(expanded.outlineOverflow).toBe(false);
    expect(expanded.clipped).toBe(0);

    await page.getByRole("button", { name: "Collapse all" }).click();
    expect((await page.evaluate(layout)).rows).toBe(1);
    await page.getByRole("button", { name: "Show 6 positions under Synthetic council" }).click();
    expect((await page.evaluate(layout)).rows).toBe(7);

    await page.getByRole("combobox", { name: "Show" }).selectOption("vacant");
    expect((await page.evaluate(layout)).rows).toBe(6);
    expect((await page.evaluate(layout)).pageOverflow).toBe(false);
    if (process.env.ORG_CHART_SCREENSHOT_DIR) {
      await page.getByRole("combobox", { name: "Show" }).selectOption("all");
      await page.getByRole("button", { name: "Expand all" }).click();
      await page.screenshot({ path: join(process.env.ORG_CHART_SCREENSHOT_DIR, `org-chart-${theme}-${width}.png`), fullPage: width < 1440 });
    }
    await page.close();
  });
}
