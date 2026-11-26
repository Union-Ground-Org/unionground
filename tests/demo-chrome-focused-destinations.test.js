// @vitest-environment node
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { observeRailGeometry } from "../scripts/verify-demo-chrome-covenant.mjs";
import { STAFF_ROLE_NAVIGATION } from "../src/lib/staffNavigation.js";
import { TAB_PAGE_GROUPS } from "../src/lib/workspacePages.js";

// Independently retained from PR1820's live rail and approved routed Work UI.
// Never generate these fixtures from the covenant's expected destinations.
const stewardPaths = ["/m/steward", "/m/steward/caseload", "/m/steward/requests",
  "/m/steward/appointments", "/m/steward/forms", "/m/steward/messages",
  "/m/steward/checkins", "/m/steward/broadcasts", "/m/steward/qa",
  "/m/steward/email-intake", "/m/steward/workload", "/m/steward/casework-hub"];
const workspacePaths = ["/m/messages", "/m/organize", "/m/events-desk", "/m/campaigns",
  "/m/coordination", "/m/support", "/m/analytics", "/m/organization-map", "/m/actions",
  "/m/qa-queue", "/m/tasks"];
const workTabs = ["board", "list", "timeline", "calendar", "deadlines", "field_notes", "progress", "report"];
const workLabels = {
  en: ["Board", "List", "Timeline", "Calendar", "Deadlines", "Field notes", "Progress", "Report"],
  es: ["Tablero", "Lista", "Cronograma", "Calendario", "Plazos", "Notas de campo", "Progreso", "Informe"],
};
const viewport = { name: "wide-1440x900", width: 1440, height: 900 };
let server, origin, browser;
beforeAll(async () => {
  server = createServer((_request, response) => response.end("<!doctype html><html><body></body></html>"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
}, BROWSER_HOOK_TIMEOUT);
afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

const fixture = (language) => `<style>
  * { box-sizing: border-box; } body { margin: 0; font: 12px Arial; }
  .desktop-rail { display: none; }
  .kan-views { display:flex; } .kan-pill { display:flex; align-items:center; gap:4px;
    position:relative; width:160px; height:44px; padding:8px; color:black; }
  .kan-pill__label { display:block; white-space:nowrap; }
  .kan-pill__measure { position:absolute; visibility:hidden; white-space:nowrap; }
  </style><nav class="desktop-rail">${[...stewardPaths, ...workspacePaths].map((path) =>
    `<a href="${path}"><span class="desktop-rail__label">${path.endsWith("appointments") ? (language === "es" ? "Citas" : "Appointments") : path}</span></a>`).join("")}</nav>
  <div class="tasks-screen"><div class="kan-topbar"><div role="tablist" data-labels-visible="true" class="kan-views">
  ${workTabs.map((tab, index) => `<a class="kan-pill" role="tab" href="/m/tasks/${tab}" aria-label="${workLabels[language][index]}">
    <svg width="16" height="16"></svg><span class="kan-pill__label">${workLabels[language][index]}</span><span class="kan-pill__measure" aria-hidden="true">${workLabels[language][index]}</span></a>`).join("")}
  </div></div></div>`;

async function observe(language, hat, mutate = async () => {}) {
  const page = await browser.newPage({ viewport });
  try {
    await page.goto(origin);
    await page.setContent(fixture(language));
    await mutate(page);
    return await observeRailGeometry(page, { viewport, language, railState: "collapsed",
      hat: { key: hat, minControls: 1 }, route: hat === "steward" ? "/m/steward" : "/m/tasks" });
  } finally { await page.close(); }
}

describe("focused destination covenant browser regression", () => {
  it("pins the retained destinations to the approved product registry", () => {
    expect(STAFF_ROLE_NAVIGATION.steward.filter((entry) => entry.viewKey === "steward").map((entry) => entry.path)).toEqual(stewardPaths);
    expect(TAB_PAGE_GROUPS.tasks.tabs).toEqual(workTabs);
  });
  it.each(["en", "es"])("measures all eight routed Work controls in %s", async (language) => {
    const result = await observe(language, "coordinator");
    expect(result.workTabCount).toBe(8);
    expect(result.findings).toEqual([]);
  });
  it.each(["en", "es"])("requires the complete focused Steward rail in %s", async (language) => {
    expect((await observe(language, "steward")).findings).toEqual([]);
  });
  it.each(["remove", "legacy", "external", "duplicate"])("rejects a %s Work destination", async (fault) => {
    const result = await observe("en", "coordinator", (page) => page.locator(".kan-pill").last().evaluate((node, value) => {
      if (value === "remove") node.remove();
      if (value === "legacy") node.setAttribute("href", "/m/tasks#report");
      if (value === "external") node.setAttribute("href", "https://wrong.example/m/tasks/report");
      if (value === "duplicate") node.setAttribute("href", "/m/tasks/board");
    }, fault));
    expect(result.findings.map((entry) => entry.rule)).toContain("work-tab-destinations-incomplete");
  });
  it.each(["missing", "legacy", "external"])("rejects %s focused Appointments", async (fault) => {
    const result = await observe("en", "steward", (page) => page.locator('a[href="/m/steward/appointments"]').evaluate((node, value) => {
      if (value === "missing") node.remove();
      if (value === "legacy") node.setAttribute("href", "/m/steward#steward-appointments");
      if (value === "external") node.setAttribute("href", "https://wrong.example/m/steward/appointments");
    }, fault));
    expect(result.findings.map((entry) => entry.rule)).toContain("appointments-destination-missing");
  });
  it.each([
    ["hidden", "work-tab-painted-label-mismatch"],
    ["clipped", "work-tab-label-clipped"],
    ["short", "work-tab-below-target-floor"],
  ])("still rejects %s Work controls", async (fault, rule) => {
    const result = await observe("es", "coordinator", (page) => page.locator(".kan-pill").first().evaluate((node, value) => {
      if (value === "hidden") node.querySelector(".kan-pill__label").style.visibility = "hidden";
      if (value === "clipped") Object.assign(node.querySelector(".kan-pill__label").style, { width: "8px", overflow: "hidden" });
      if (value === "short") node.style.height = "30px";
    }, fault));
    expect(result.findings.map((entry) => entry.rule)).toContain(rule);
  });
});
