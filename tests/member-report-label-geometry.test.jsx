import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { browserMarkup } from "./helpers/browserMarkup.js";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { render } from "@testing-library/react";
import { afterAll, beforeAll, expect, it } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { NumbersView } from "../src/views/NumbersView.jsx";

// Functional reflow of real report markup and the shipped CSS in Chromium.
const css = (await Promise.all(["sg-tokens.css", "styles.css"]
  .map(path => readFile(resolve("src", path), "utf8")))).join("\n");
let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

async function reportPage(width) {
  const data = {
    member: { initials: "FG" },
    metrics: { caseTypes: [{ label: "PIP / Accuracy Notice", value: 1 }] },
  };
  const view = render(<LanguageProvider lang="en">
    <main className="sg-app" data-workspace-theme="union-ground"><NumbersView data={data} /></main>
  </LanguageProvider>);
  const page = await browser.newPage({ viewport: { width, height: 920 } });
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return /^\/assets\/.*\.woff2$/.test(url.pathname)
      ? route.fulfill({ path: resolve("public", url.pathname.slice(1)), contentType: "font/woff2" })
      : route.abort();
  });
  await page.setContent(`<base href="http://127.0.0.1/">${browserMarkup(view.container)}`);
  view.unmount();
  await page.addStyleTag({ content: css });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

it.each([1680, 320])("keeps both report labels readable at %i CSS px", async width => {
  const page = await reportPage(width);
  try {
    // The points card's tier label left with the points economy; the case
    // type label is the report row that remains.
    for (const text of ["PIP / Accuracy Notice"]) {
      const label = page.getByText(text, { exact: true }).and(page.locator(".reports-row__label"));
      const fits = await label.evaluate(node => node.scrollWidth <= node.clientWidth + 1);
      expect(fits, text).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  } finally { await page.close(); }
});
