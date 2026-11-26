import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { loadDemoSurveyPresentation, presentDemoSurvey as createDemoSurvey } from "../src/lib/demoSurveyPresentation.js";
import { demoSurveyReleaseFiles } from "./helpers/demo-survey-release.js";
const surveyCss = readFileSync("src/lib/demoSurveyPresentation.css", "utf8");

const presentDemoSurvey = (options) => createDemoSurvey({ ...options, files: demoSurveyReleaseFiles() });

beforeEach(() => {
  document.documentElement.lang = "en";
  document.body.innerHTML = '<main id="main-content" tabindex="-1" data-view="today"><article>Voting content</article></main>';
  sessionStorage.clear();
});
afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); document.body.innerHTML = ""; });

describe("demo feedback in reserved workspace space", () => {
  it("gives numeric rating buttons and their grid a 48px minimum", () => {
    const style = document.createElement("style");
    style.textContent = surveyCss;
    document.head.append(style);
    try {
      const rules = [...style.sheet.cssRules];
      const grid = rules.find((rule) => rule.selectorText === ".demo-survey-slot .rating-options-number");
      const rating = rules.find((rule) => rule.selectorText === ".demo-survey-slot .ph-survey .ratings-number");
      expect(grid.style.getPropertyValue("grid-template-columns")).toMatch(/minmax\(48px,\s*1fr\)/);
      expect(rating.style.getPropertyValue("min-width")).toBe("48px");
      expect(rating.style.getPropertyValue("min-height")).toBe("48px");
    } finally { style.remove(); }
  });

  it("does not offer feedback or write storage before its legal release is published", () => {
    const options = { display: vi.fn(), onDismiss: vi.fn() };
    const write = vi.spyOn(Storage.prototype, "setItem");
    expect(createDemoSurvey(options)).toBeNull();
    const files = demoSurveyReleaseFiles();
    for (const deployment of [null, { ...files.deployment, liveReleaseIds: [] }, { ...files.deployment, verifiedPackReleaseIds: [] }, { ...files.deployment, stampJson: "stale" }]) {
      expect(createDemoSurvey({ ...options, files: { ...files, deployment } })).toBeNull();
    }
    expect(write).not.toHaveBeenCalled();
    expect(document.querySelector(".demo-survey-slot")).toBeNull();
  });

  it("loads deployment proof and rechecks consent before writing or mounting", async () => {
    const files = demoSurveyReleaseFiles();
    let resolve;
    const fetcher = vi.fn(() => new Promise((answer) => { resolve = answer; }));
    let enabled = true;
    const options = { display: vi.fn(), onDismiss: vi.fn(), isEnabled: () => enabled };
    const loading = loadDemoSurveyPresentation(options, files, fetcher);
    enabled = false;
    resolve({ ok: true, json: async () => files.deployment });
    expect(await loading).toBeNull();
    expect(sessionStorage.getItem("ug:demo-survey-offered:v1")).toBeNull();
    enabled = true;
    fetcher.mockResolvedValue({ ok: true, json: async () => files.deployment });
    expect(await loadDemoSurveyPresentation(options, files, fetcher)).not.toBeNull();
    expect(fetcher).toHaveBeenCalledWith("/api/legal-pack?publication=1", expect.objectContaining({ cache: "no-store", credentials: "omit", redirect: "error" }));
  });

  it("offers feedback before content and opens inline only on request", () => {
    const display = vi.fn();
    presentDemoSurvey({ display, onDismiss: vi.fn() });
    expect(document.querySelector("main").firstElementChild).toHaveClass("demo-survey-slot");
    expect(document.querySelector("article")).toHaveTextContent("Voting content");
    const open = document.querySelector(".demo-survey-slot button");
    expect(open).toHaveTextContent("Demo feedback");
    expect(display).not.toHaveBeenCalled();
    open.click(); open.click();
    expect(display).toHaveBeenCalledExactlyOnceWith("#ug-demo-survey-slot");
    expect(open).toHaveAttribute("aria-expanded", "true");
    expect(open).not.toBeVisible();
  });

  it("dismisses by Escape, restores focus and never offers again in this tab, even after a reload", async () => {
    const onDismiss = vi.fn();
    const manager = presentDemoSurvey({ display: vi.fn(), onDismiss });
    const close = document.querySelector(".demo-survey-close");
    close.focus();
    close.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(document.querySelector(".demo-survey-slot")).not.toBeNull();
    close.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(document.querySelector(".demo-survey-slot")).toBeNull();
    expect(document.querySelector("main")).toHaveFocus();
    manager.place(); close.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".demo-survey-slot")).toBeNull();
    vi.resetModules();
    const reloaded = await import("../src/lib/demoSurveyPresentation.js");
    expect(reloaded.presentDemoSurvey({ display: vi.fn(), onDismiss, files: demoSurveyReleaseFiles() })).toBeNull();
  });

  it("supports Spanish and a mouse close without moving unrelated focus", () => {
    document.documentElement.lang = "es";
    const onDismiss = vi.fn();
    presentDemoSurvey({ display: vi.fn(), onDismiss });
    expect(document.querySelector("section")).toHaveAccessibleName("Opinión sobre la demo");
    const close = document.querySelector(".demo-survey-close");
    expect(close).toHaveTextContent("Cerrar");
    close.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps its reserved section with the workspace when routes replace main", () => {
    const manager = presentDemoSurvey({ display: vi.fn(), onDismiss: vi.fn() });
    manager.place();
    document.body.innerHTML = '<main id="main-content" class="app-column" data-view="today"><article>Next page</article></main>';
    manager.place();
    expect(document.querySelector("main").firstElementChild).toHaveClass("demo-survey-slot");
    manager.remove(); manager.place();
    expect(document.querySelector(".demo-survey-slot")).toBeNull();
  });

  // #9776 (demo walk of Nov 24, 2026): the offer stood above every page's
  // heading; it belongs on Home only and waits off screen elsewhere.
  it("stands on Home only and comes back when the visitor returns Home", () => {
    let home = false;
    const manager = presentDemoSurvey({ display: vi.fn(), onDismiss: vi.fn(), onHome: () => home });
    expect(manager).not.toBeNull();
    expect(document.querySelector(".demo-survey-slot")).toBeNull();
    home = true;
    manager.place();
    expect(document.querySelector("main").firstElementChild).toHaveClass("demo-survey-slot");
    home = false;
    manager.place();
    expect(document.querySelector(".demo-survey-slot")).toBeNull();
    expect(document.querySelector("main").firstElementChild).toHaveTextContent("Voting content");
    home = true;
    manager.place();
    expect(document.querySelectorAll(".demo-survey-slot")).toHaveLength(1);
    manager.remove(); manager.place();
    expect(document.querySelector(".demo-survey-slot")).toBeNull();
  });

  it("reads Home from the page the shell names on main", () => {
    document.querySelector("main").dataset.view = "voting";
    const manager = presentDemoSurvey({ display: vi.fn(), onDismiss: vi.fn() });
    expect(manager).not.toBeNull();
    expect(document.querySelector(".demo-survey-slot")).toBeNull();
    document.body.innerHTML = '<main id="main-content" data-view="today"><article>Home</article></main>';
    manager.place();
    expect(document.querySelector("main").firstElementChild).toHaveClass("demo-survey-slot");
    expect(readFileSync("src/App.jsx", "utf8")).toMatch(/<main\s+id="main-content"[^>]*?data-view=\{resolvedView\}/);
  });

  it("fails closed without a workspace, with duplicate slots or unavailable tab storage", () => {
    const options = { display: vi.fn(), onDismiss: vi.fn() };
    expect(presentDemoSurvey({ ...options, doc: null })).toBeNull();
    document.body.innerHTML = "";
    expect(presentDemoSurvey(options)).toBeNull();
    document.body.innerHTML = '<main id="main-content"><div id="ug-demo-survey-slot"></div></main>';
    expect(presentDemoSurvey(options)).toBeNull();
    document.body.innerHTML = '<main id="main-content"></main>';
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(presentDemoSurvey(options)).toBeNull();
    vi.restoreAllMocks();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    expect(presentDemoSurvey(options)).toBeNull();
  });

  it("cleans up when the SDK cannot render, and guards clicks after removal", () => {
    document.documentElement.lang = "";
    const manager = presentDemoSurvey({ display: () => { throw new Error("offline"); }, onDismiss: vi.fn() });
    const open = document.querySelector(".demo-survey-slot button");
    expect(open).toHaveTextContent("Demo feedback");
    open.click(); open.click(); manager.place();
    expect(document.querySelector(".demo-survey-slot")).toBeNull();
  });
});
