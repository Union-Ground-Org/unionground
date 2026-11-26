import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { waitForFullStyles } from "../src/lib/fullStylesReady.js";

afterEach(() => { document.head.innerHTML = ""; vi.useRealTimers(); });

function slot() {
  document.head.innerHTML = '<link rel="stylesheet" href="/critical.css"><link rel="preload" as="style" href="/full.css" data-full-styles><link rel="stylesheet" href="/route.css">';
  return document.querySelector("[data-full-styles]");
}

it.each(["load", "error"])("permits the first commit on full's %s, preserving its slot", async (event) => {
  const link = slot(), render = vi.fn();
  const ready = waitForFullStyles(document).then(render);
  await Promise.resolve();
  expect(render).not.toHaveBeenCalled();
  expect(link.rel).toBe("stylesheet");
  expect([...document.querySelectorAll("link")].map((item) => item.getAttribute("href"))).toEqual(["/critical.css", "/full.css", "/route.css"]);
  link.dispatchEvent(new Event(event));
  await ready;
  expect(render).toHaveBeenCalledTimes(1);
});

it("holds the first commit through a five-second full-sheet delay", async () => {
  vi.useFakeTimers();
  const link = slot(), render = vi.fn();
  const ready = waitForFullStyles(document).then(render);
  await vi.advanceTimersByTimeAsync(5000);
  expect(render).not.toHaveBeenCalled();
  link.dispatchEvent(new Event("load"));
  await ready;
  expect(render).toHaveBeenCalledTimes(1);
});

it("works without a build slot and with an already active cached sheet", async () => {
  await expect(waitForFullStyles(document)).resolves.toBeUndefined();
  const link = slot();
  Object.defineProperty(link, "sheet", { value: {} });
  await expect(waitForFullStyles(document)).resolves.toBeUndefined();
});

it("gates the actual bootstrap alongside language without adding an inline handler", () => {
  const main = readFileSync("src/main.jsx", "utf8");
  expect(main).toContain("Promise.all([loadLanguage(bootLanguage()), waitForFullStyles(document)]).then(() => createRoot");
  expect(readFileSync("scripts/lib/critical-full-styles.mjs", "utf8")).not.toMatch(/onload=|onerror=/);
});
