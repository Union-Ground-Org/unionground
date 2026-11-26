import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "@playwright/test";
import { fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { MemberGuidePage } from "./fixtures/member-actions-browser.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { forgetGuideCompleteDismissedThisSession } from "../src/lib/onboardingGuide.js";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";

const sheets = ["src/sg-tokens.css", "src/styles.css", "src/components/OnboardingHud.css", "src/features/onboardingGuideEngine/MemberGuideLayers.css"];
const css = (await Promise.all(sheets.map((path) => readFile(path, "utf8")))).join("\n");
let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

describe.each([320, 1440])("one page guide at %i CSS px", (width) => {
  it.each(["light", "dark"])("keeps content visible with %s device appearance", async (colorScheme) => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    try {
      for (const onboarding of [true, false]) {
        localStorage.clear(); forgetGuideCompleteDismissedThisSession();
        const html = renderToString(<LanguageProvider><MemberGuidePage onboarding={onboarding} desktop={width >= 1000}/></LanguageProvider>);
        await page.route("**/*", (route) => route.abort());
        await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
        await page.addStyleTag({ content: css });
        expect(await page.locator('.onboarding-hud, [data-guide-surface="feature-guide"]').count()).toBe(1);
        expect((await page.getByTestId("working-content").boundingBox()).y).toBeLessThan(844);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    } finally { await page.close(); }
  }, 60_000);
});

it("remembers both guide dismissals after returning to the website", () => {
  localStorage.clear(); forgetGuideCompleteDismissedThisSession();
  const tree = <LanguageProvider><MemberGuidePage/></LanguageProvider>;
  const first = render(tree);
  expect(first.container.querySelectorAll('.onboarding-hud, [data-guide-surface="feature-guide"]')).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(first.container.querySelector('.onboarding-hud')).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Got it" }));
  expect(first.container.querySelector('[data-guide-surface="feature-guide"]')).toBeNull();
  first.unmount();
  const second = render(tree);
  expect(second.container.querySelector('.onboarding-hud, [data-guide-surface="feature-guide"]')).toBeNull();
  expect(screen.getByTestId("working-content")).toBeInTheDocument();
});
