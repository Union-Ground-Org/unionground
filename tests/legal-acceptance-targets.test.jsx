// @vitest-environment node
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
// tests/setup.js registers Spanish only for DOM files; this node file reads it.
import "../src/lib/i18n/allLanguages.js";
import { LegalAcceptancePrompt } from "../src/components/LegalAcceptancePrompt.jsx";
import { ResidenceAgeFields } from "../src/components/ResidenceAgeFields.jsx";
import { CARD_CLASS } from "../src/components/Surfaces.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { classifyVisualMeasurements, collectVisualMeasurements } from "../scripts/visual-audit.mjs";

const styles = ["src/sg-tokens.css", "src/styles.css"].map((path) => readFileSync(path, "utf8")).join("\n");

describe("legal acceptance interactive target sizes", () => {
  it("keeps the checkboxes, state select and submit usable through reflow, tablet and desktop", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      for (const lang of ["en", "es"]) {
        const prompt = renderToStaticMarkup(
          <LanguageProvider lang={lang}><LegalAcceptancePrompt instruments={["terms-of-use"]} /></LanguageProvider>,
        );
        // The prompt shows the terms checkbox, the state select, the age checkbox
        // (on the page from the start, disabled until a state is chosen:
        // REQ-UG-INVITE-TERMS-AGE-STATE-FORM-CLARITY-20261030) and
        // submit. Static markup cannot choose a state, so a second card renders
        // the enabled age checkbox with the longer (D-03 B band) sentence.
        const chosen = renderToStaticMarkup(
          <LanguageProvider lang={lang}><aside className={`${CARD_CLASS} legal-acceptance`}>
            <ResidenceAgeFields idPrefix="legal-acceptance-chosen" residenceState="OH"
              onResidenceState={() => {}} ageAttested={false} onAgeAttested={() => {}} />
          </aside></LanguageProvider>,
        );
        for (const [width, theme] of [320, 768, 1023, 1280, 1440].flatMap((width) =>
          ["union-ground"].map((theme) => [width, theme]))) {
          await page.setViewportSize({ width, height: 1024 });
          const shell = width >= 768 && width <= 1023 ? "sg-app sg-app--tablet" : "sg-app";
          await page.setContent(`<html lang="${lang}"><body><div class="${shell}" data-workspace-theme="${theme}"><main class="app-column">${prompt}${chosen}</main></div></body></html>`);
          await page.addStyleTag({ content: styles });
          const controls = page.locator("aside input, aside select, aside button");
          // Prompt: agree, state, age (disabled), submit. Chosen card: state, age.
          expect(await controls.count()).toBe(6);
          expect(await page.locator("#legal-acceptance-age").isDisabled()).toBe(true);
          for (const control of await controls.all()) {
            const bounds = await control.boundingBox();
            expect(bounds.width, `${lang} ${width}: control width`).toBeGreaterThanOrEqual(48);
            expect(bounds.height, `${lang} ${width}: control height`).toBeGreaterThanOrEqual(48);
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
          // Labels still activate the native inputs, and Space still toggles them.
          for (const id of ["legal-acceptance-agree", "legal-acceptance-chosen-age"]) {
            await page.locator(`label[for="${id}"]`).click();
            await expect.poll(() => page.locator(`#${id}`).isChecked()).toBe(true);
            await page.locator(`#${id}`).press("Space");
            expect(await page.locator(`#${id}`).isChecked()).toBe(false);
          }
          const measured = { ...await page.evaluate(collectVisualMeasurements), route: "/m" };
          const result = classifyVisualMeasurements(measured, []);
          expect(result.failures.filter((finding) => finding.rule === "small-target")).toEqual([]);
        }
      }
    } finally {
      await browser.close();
    }
  }, 30000);
});
