// @vitest-environment node
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium } from "@playwright/test";
import { renderToString } from "react-dom/server";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { loadLanguage } from "../src/lib/i18n.js";
import { OrgStartGuide } from "../src/features/onboardingGuideEngine/OrgStartGuide.jsx";
import { OrgStartGuideCard } from "../src/features/onboardingGuideEngine/OrgStartGuideCard.jsx";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";

const sheets = ["sg-tokens.css", "styles.css", "coordinator-theme.css", "features/onboardingGuideEngine/MemberGuideLayers.css", "features/onboardingGuideEngine/OrgStartGuide.css"];
const css = (await Promise.all(sheets.map((path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8")))).join("\n");
const guide = {
  kind: "guide", canAct: true, milestones: [],
  title: { key: "guideEngine.org.cardTitle", params: { org: "Tamarack Valley" } },
  eyebrow: { key: "guideEngine.org.title" },
  ring: { percent: 0, done: 0, total: 7, text: { key: "guideEngine.org.ring", params: { done: 0, total: 7 } } },
  next: { id: "structure", line: { key: "guideEngine.org.next", params: { title: { key: "guideEngine.org.structure" } } } },
};
const variants = [guide, { ...guide, canAct: false }, {
  kind: "celebrate", title: { key: "guideEngine.org.live" }, body: { key: "guideEngine.org.sharedLine" },
}];
let browser;
const receipts = [];
beforeAll(async () => {
  await loadLanguage("es");
  browser = await chromium.launch({ headless: true });
}, BROWSER_HOOK_TIMEOUT);
afterAll(async () => {
  await browser?.close();
  if (process.env.ORG_START_GUIDE_EVIDENCE) await writeFile(join(process.env.ORG_START_GUIDE_EVIDENCE, "guide-layout.json"), JSON.stringify(receipts, null, 2));
});

for (const theme of ["union-ground"]) {
  for (const lang of ["en", "es"]) {
    it.each([320, 768, 1440])(`reserves every collapsed guide's height in ${theme}/${lang} at %i px`, async (width) => {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      try {
        await page.route("**/*", (route) => route.abort());
        for (const view of variants) {
          const render = (node) => renderToString(<LanguageProvider lang={lang}>{node}</LanguageProvider>);
          const pending = render(<OrgStartGuideCard view={view} pending />);
          const ready = render(<OrgStartGuide guide={{ view }} />);
          await page.setContent(`<div class="sg-app" data-workspace-theme="${theme}"><div id="card">${pending}</div><p id="following">Staff home content</p></div>`);
          await page.addStyleTag({ content: css });
          const measure = () => page.evaluate(() => {
            const card = document.querySelector(".org-start");
            const following = document.getElementById("following");
            const luminance = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number)
              .map((value) => value / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
              .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
            const ink = luminance(getComputedStyle(card.querySelector("h2")).color);
            const paper = luminance(getComputedStyle(card).backgroundColor);
            return { height: card.getBoundingClientRect().height, followingTop: following.getBoundingClientRect().top,
              inkContrast: (Math.max(ink, paper) + .05) / (Math.min(ink, paper) + .05),
              overflow: document.documentElement.scrollWidth > innerWidth };
          });
          const before = await measure();
          await page.locator("#card").evaluate((node, markup) => { node.innerHTML = markup; }, ready);
          const after = await measure();
          expect(after).toEqual(before);
          expect(after.height).toBeGreaterThan(80);
          expect(after.inkContrast).toBeGreaterThanOrEqual(4.5);
          expect(after.overflow).toBe(false);
          receipts.push({ theme, lang, width, kind: view.kind, canAct: view.canAct, before, after });
        }
      } finally { await page.close(); }
    });
  }
}
