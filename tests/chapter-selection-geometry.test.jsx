import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { browserMarkup } from "./helpers/browserMarkup.js";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { render } from "@testing-library/react";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ChapterBindingCard } from "../src/components/ChapterLifecycleAdmin.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

// Functional reflow in desktop Chromium using real component markup and
// shipped CSS. This is not a mobile-browser design or device acceptance gate.
const css = (await Promise.all(["sg-tokens.css", "styles.css"]
  .map(path => readFile(resolve("src", path), "utf8")))).join("\n");
let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

async function pickerPage(width, lang = "en", name = "Harborview Care Boston") {
  const view = render(<LanguageProvider lang={lang}>
    <main className="sg-app xus-body" data-workspace-theme="collected">
      <ChapterBindingCard lifecycle={{ chapterId: null, memberships: [
        { chapterId: "wor", name: "Harborview Care United" }, { chapterId: "bos", name },
      ] }} organization={{ scope: "organization" }} api={{ switchMyChapter: vi.fn() }} reload={vi.fn()} onNotice={vi.fn()} />
    </main>
  </LanguageProvider>);
  const page = await browser.newPage({ viewport: { width, height: 900 } });
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

it.each([1280, 390, 320])("gives chapter selection controls 48px targets at %i CSS px", async width => {
  const page = await pickerPage(width);
  try {
    const controls = await page.getByRole("button", { name: /^Manage / }).all();
    expect(controls).toHaveLength(2);
    for (const button of controls) expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(48);
  } finally { await page.close(); }
});

for (const lang of ["en", "es"]) {
  for (const name of ["Massachusetts Department of Developmental Services Central Massachusetts Chapter", "Chapter".repeat(30)]) {
    it.each([390, 320])(`keeps the entire ${lang} chapter label inside its control at %i CSS px (${name.slice(0, 16)})`, async width => {
      const page = await pickerPage(width, lang, name);
      try {
        const button = page.getByRole("button", { name: `${lang === "en" ? "Manage" : "Administrar"} ${name}`, exact: true });
        const geometry = await button.evaluate(node => {
          const box = node.getBoundingClientRect();
          const body = node.closest(".xus-cardbody").getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(node);
          const label = range.getBoundingClientRect();
          return { left: box.left, right: box.right, labelLeft: label.left, labelRight: label.right,
            labelTop: label.top, labelBottom: label.bottom, top: box.top, bottom: box.bottom,
            bodyLeft: body.left, bodyRight: body.right,
            documentWidth: document.documentElement.scrollWidth, viewport: innerWidth };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(geometry.bodyLeft);
        expect(geometry.right).toBeLessThanOrEqual(geometry.bodyRight);
        expect(geometry.labelLeft).toBeGreaterThanOrEqual(geometry.left);
        expect(geometry.labelRight).toBeLessThanOrEqual(geometry.right);
        expect(geometry.labelTop).toBeGreaterThanOrEqual(geometry.top);
        expect(geometry.labelBottom).toBeLessThanOrEqual(geometry.bottom);
        expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport);
      } finally { await page.close(); }
    });
  }
}
