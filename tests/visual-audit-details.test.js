// @vitest-environment node
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { collectVisualMeasurements } from "../scripts/visual-audit.mjs";

it("measures closed disclosure summaries while excluding their unpainted descendants", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<details id="outer"><summary id="summary"><span id="label">Pages</span></summary>
      <div id="panel"><button id="action">Open page</button>
        <details id="inner" open><summary id="inner-summary">More</summary><button id="inner-action">Nested page</button></details>
      </div></details>`);
    // Chromium builds differ on whether closed disclosure content keeps layout
    // boxes; the audit must exclude that unpainted content either way.
    const selectors = async () => (await page.evaluate(collectVisualMeasurements)).elements.map(row => row.selector);
    const closed = await selectors();
    expect(closed).toEqual(expect.arrayContaining(["#outer", "#summary", "#label"]));
    for (const id of ["#panel", "#action", "#inner", "#inner-summary", "#inner-action"]) expect(closed).not.toContain(id);
    await page.locator("#summary").click();
    expect(await selectors()).toEqual(expect.arrayContaining(["#panel", "#action", "#inner-summary", "#inner-action"]));
    await page.locator("#inner-summary").click();
    const nestedClosed = await selectors();
    expect(nestedClosed).toContain("#inner-summary");
    expect(nestedClosed).not.toContain("#inner-action");
  } finally { await browser.close(); }
});
