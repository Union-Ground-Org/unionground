/* global document, getComputedStyle */
import { chromium } from "@playwright/test";
import path from "node:path";
import { resolveProofOutputDir, writeProofFile } from "./lib/proof-output-dir.mjs";

const baseUrl = process.env.MI1_QA_BROWSER_BASE_URL || "http://127.0.0.1:4176";
const outputDir = await resolveProofOutputDir(process.env.MI1_QA_BROWSER_OUTPUT_DIR, "mi1-qa-browser-proof");
const results = [];

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function dismissTour(page) {
  const choice = page.getByRole("button", { name: /Explore on my own|Explorar por mi cuenta/i });
  if (await choice.isVisible().catch(() => false)) await choice.click();
}

async function waitForSettledSurface(page) {
  await page.waitForFunction(() => {
    const surface = document.querySelector('[data-mi1-surface="member-qa"]');
    if (!surface) return false;
    const visibleContent = [surface, ...surface.querySelectorAll("h1, label, button, input, select, textarea, strong, p, small")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    return visibleContent.every((element) => {
      let current = element;
      let opacity = 1;
      while (current) {
        opacity *= Number.parseFloat(getComputedStyle(current).opacity || "1");
        current = current.parentElement;
      }
      return opacity >= 0.99;
    });
  });
}

async function geometry(page) {
  return page.evaluate(() => {
    function channels(value) {
      const match = value.match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/i);
      return match ? match.slice(1, 4).map(Number) : null;
    }
    function luminance(value) {
      const rgb = channels(value);
      if (!rgb) return null;
      const linear = rgb.map((part) => {
        const channel = part / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    }
    function backgroundFor(element) {
      let current = element;
      while (current) {
        const value = getComputedStyle(current).backgroundColor;
        if (value && value !== "transparent" && !value.endsWith(", 0)")) return value;
        current = current.parentElement;
      }
      return "rgb(255, 255, 255)";
    }
    function contrastFor(element) {
      const foreground = getComputedStyle(element).color;
      const background = backgroundFor(element);
      const foregroundLuminance = luminance(foreground);
      const backgroundLuminance = luminance(background);
      const ratio = foregroundLuminance == null || backgroundLuminance == null
        ? null
        : (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
          / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
      return { background, foreground, ratio: ratio == null ? null : Math.round(ratio * 100) / 100 };
    }
    function opacityFor(element) {
      let current = element;
      let opacity = 1;
      while (current) {
        opacity *= Number.parseFloat(getComputedStyle(current).opacity || "1");
        current = current.parentElement;
      }
      return Math.round(opacity * 100) / 100;
    }
    const root = document.querySelector('[data-mi1-surface="member-qa"]');
    const controls = [...(root?.querySelectorAll("button, input, select, textarea") || [])]
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          height: Math.round(rect.height),
          label: element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 60) || element.tagName,
          width: Math.round(rect.width),
        };
      });
    return {
      clientWidth: document.documentElement.clientWidth,
      controls,
      contrast: [...(root?.querySelectorAll("h1, label, button, input, select, textarea, strong, p, small") || [])]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((element) => ({
          label: element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 60) || element.tagName,
          opacity: opacityFor(element),
          ...contrastFor(element),
        })),
      hiddenElements: document.querySelectorAll('[aria-hidden="true"]').length,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      inertElements: document.querySelectorAll('[inert]').length,
      scrollWidth: document.documentElement.scrollWidth,
      welcomeLayers: document.querySelectorAll('.demo-welcome-layer').length,
    };
  });
}

const browser = await chromium.launch({ headless: true });

try {
  const desktop = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
  const page = await desktop.newPage();
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console:${message.text()}`); });
  page.on("pageerror", (error) => errors.push(`page:${error.message}`));
  await page.goto(`${baseUrl}/m/qa?demo=1`, { waitUntil: "networkidle" });
  await dismissTour(page);
  await page.locator('.demo-welcome-layer').waitFor({ state: "detached" });
  await page.getByRole("heading", { name: "Member questions" }).waitFor();
  await page.getByText("No questions yet. Ask the first one for this chapter.").waitFor();

  const title = "When is the next chapter meeting?";
  await page.getByRole("button", { name: "Ask a question" }).click();
  await page.getByLabel("Question title").fill(title);
  await page.getByLabel("Details").fill("I want to confirm the date and location for the next chapter meeting.");
  await page.getByRole("button", { name: "Post question" }).click();
  await page.getByRole("heading", { name: title }).waitFor();
  const vote = page.getByRole("button", { name: /Upvote · 0 votes/i });
  await vote.click();
  await page.getByRole("button", { name: /Upvoted · 1 votes/i }).waitFor();
  await page.getByRole("button", { name: "All questions" }).click();
  await page.getByLabel("Search questions").fill("next chapter");
  await page.locator('[data-qa-surface="list"]').getByText(title, { exact: true }).waitFor();
  await waitForSettledSurface(page);
  const desktopGeometry = await geometry(page);
  assert(desktopGeometry.scrollWidth <= desktopGeometry.clientWidth, `desktop overflow: ${JSON.stringify(desktopGeometry)}`);
  assert(desktopGeometry.dialogs === 0 && desktopGeometry.inertElements === 0 && desktopGeometry.welcomeLayers === 0, `desktop modal cleanup failed: ${JSON.stringify(desktopGeometry)}`);
  assert(desktopGeometry.controls.every(({ height, width }) => height >= 44 && width >= 44), `desktop undersized controls: ${JSON.stringify(desktopGeometry.controls)}`);
  assert(desktopGeometry.contrast.every(({ opacity, ratio }) => opacity >= 0.99 && ratio != null && ratio >= 4.5), `desktop contrast failure: ${JSON.stringify(desktopGeometry.contrast)}`);
  assert(errors.length === 0, `desktop browser errors: ${errors.join(" | ")}`);
  await page.screenshot({ path: path.join(outputDir, "member-qa-desktop.png"), fullPage: true });
  results.push({ label: "desktop-en", errors, geometry: desktopGeometry, persistedQuestion: title, voteCount: 1 });
  await desktop.close();

  const mobile = await browser.newContext({ locale: "es-ES", viewport: { width: 390, height: 844 } });
  await mobile.addInitScript(() => localStorage.setItem("sg-lang", "es"));
  const mobilePage = await mobile.newPage();
  const mobileErrors = [];
  mobilePage.on("console", (message) => { if (message.type() === "error") mobileErrors.push(`console:${message.text()}`); });
  mobilePage.on("pageerror", (error) => mobileErrors.push(`page:${error.message}`));
  await mobilePage.goto(`${baseUrl}/m/qa?demo=1`, { waitUntil: "networkidle" });
  await dismissTour(mobilePage);
  await mobilePage.locator('.demo-welcome-layer').waitFor({ state: "detached" });
  await mobilePage.getByRole("heading", { name: "Preguntas de afiliados" }).waitFor();
  await waitForSettledSurface(mobilePage);
  const mobileGeometry = await geometry(mobilePage);
  assert(mobileGeometry.scrollWidth <= mobileGeometry.clientWidth, `mobile overflow: ${JSON.stringify(mobileGeometry)}`);
  assert(mobileGeometry.dialogs === 0 && mobileGeometry.inertElements === 0 && mobileGeometry.welcomeLayers === 0, `mobile modal cleanup failed: ${JSON.stringify(mobileGeometry)}`);
  assert(mobileGeometry.controls.every(({ height, width }) => height >= 44 && width >= 44), `mobile undersized controls: ${JSON.stringify(mobileGeometry.controls)}`);
  assert(mobileGeometry.contrast.every(({ opacity, ratio }) => opacity >= 0.99 && ratio != null && ratio >= 4.5), `mobile contrast failure: ${JSON.stringify(mobileGeometry.contrast)}`);
  assert(mobileErrors.length === 0, `mobile browser errors: ${mobileErrors.join(" | ")}`);
  await mobilePage.screenshot({ path: path.join(outputDir, "member-qa-mobile-es.png"), fullPage: true });
  results.push({ label: "mobile-es", errors: mobileErrors, geometry: mobileGeometry });
  await mobile.close();

  await writeProofFile(path.join(outputDir, "proof.json"), `${JSON.stringify({ baseUrl, results }, null, 2)}\n`);
  process.stdout.write(`MI1 Q&A browser verification passed: ${outputDir}\n`);
} finally {
  await browser.close();
}
