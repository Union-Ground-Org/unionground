import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { render } from "@testing-library/react";
import { afterAll, beforeAll, expect, it } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { buildPayActor } from "../src/lib/mi1PayWiring.js";
import { FormsView } from "../src/views/FormsView.jsx";
import { PayToolsView } from "../src/views/PayToolsView.jsx";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { browserMarkup } from "./helpers/browserMarkup.js";

const css = (await Promise.all(["sg-tokens.css", "styles.css", "components/freeCosmetics.css"]
  .map(path => readFile(resolve("src", path), "utf8")))).join("\n");
let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

async function fixture(node, width) {
  const view = render(<LanguageProvider lang="en">
    <main className="sg-app" data-workspace-theme="union-ground">{node}</main>
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

it.each([[1680, true], [320, false]])("fits the Pay calculator at %i CSS px", async (width, twoColumns) => {
  const actor = buildPayActor({
    userId: "fictional-member", organizationId: "11111111-1111-4111-8111-111111111111", membershipStatus: "active",
  });
  const page = await fixture(<PayToolsView actor={actor} />, width);
  try {
    const regular = await page.getByLabel("Regular hours").boundingBox();
    const overtime = await page.getByLabel("Overtime hours").boundingBox();
    expect(Math.abs(regular.y - overtime.y) < 1).toBe(twoColumns);
    expect(regular.width).toBeLessThanOrEqual(twoColumns ? 384 : width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  } finally { await page.close(); }
});

it.each([
  ["Forms", "Official filing copy", <FormsView demo desktop data={{
    member: { initials: "FG" },
    forms: [{ id: "approved-form", templateKey: "filing_fixture", templateVersion: 1, status: "approved", answers: {} }],
    formTemplates: [{ key: "filing_fixture", titleKey: "Fictional approved form", version: 1, steps: [] }],
  }} />],
])("keeps the %s page title above its %s heading in type size", async (title, section, node) => {
  const page = await fixture(node, 1680);
  try {
    const size = label => page.getByRole("heading", { name: label, exact: true })
      .evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize));
    expect(await size(title)).toBeGreaterThanOrEqual(await size(section));
  } finally { await page.close(); }
});
