import { chromium } from "@playwright/test";
import path from "node:path";
import { resolveProofOutputDir, writeProofFile } from "./lib/proof-output-dir.mjs";

const baseUrl = process.env.WORKLOAD_BROWSER_BASE_URL || "http://127.0.0.1:4173";
const outputDir = await resolveProofOutputDir(process.env.WORKLOAD_BROWSER_OUTPUT_DIR, "ub-wkl-03-browser");

const browser = await chromium.launch({ headless: true });
const results = [];

async function withPage({ lang, viewport }, exercise) {
  const context = await browser.newContext({
    locale: lang === "es" ? "es-ES" : "en-US",
    viewport,
  });
  await context.addInitScript((value) => localStorage.setItem("sg-lang", value), lang);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console:${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page:${error.message}`));

  try {
    await exercise(page, errors);
  } finally {
    await context.close();
  }
}

async function verifyMember(label, viewport, lang) {
  await withPage({ lang, viewport }, async (page, errors) => {
    await page.goto(`${baseUrl}/m/workload?demo=1`, { waitUntil: "networkidle" });
    await page.locator(".mwl-head").waitFor();

    const remindersName = lang === "es" ? "Recordatorios" : "Reminders";
    await page.getByRole("button", { exact: true, name: remindersName }).click();
    const reminderTitle = lang === "es"
      ? "Recordatorios de carga de trabajo"
      : "Workload reminders";
    await page.getByText(reminderTitle, { exact: true }).waitFor();
    await page.getByRole("button", { exact: true, name: remindersName })
      .waitFor({ state: "visible" });
    await page.waitForFunction((name) => [...document.querySelectorAll(".mwl-tab")]
      .some((tab) => tab.getAttribute("aria-pressed") === "true" && tab.textContent.trim() === name), remindersName);
    await page.waitForTimeout(500);
    await page.keyboard.press("Tab");

    const geometry = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      focused: {
        tag: document.activeElement?.tagName,
        text: document.activeElement?.textContent?.trim().slice(0, 80),
      },
      htmlLang: document.documentElement.lang,
      scrollWidth: document.documentElement.scrollWidth,
      undersized: [...document.querySelectorAll(".mwl-body button, .mwl-tabs button")]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            height: Math.round(rect.height),
            text: element.textContent.trim().slice(0, 40),
            width: Math.round(rect.width),
          };
        })
        .filter(({ height, width }) => width < 44 || height < 44),
    }));
    if (geometry.scrollWidth > geometry.clientWidth) {
      throw new Error(`${label}-${lang}: horizontal overflow ${geometry.scrollWidth}/${geometry.clientWidth}`);
    }
    if (geometry.undersized.length > 0) {
      throw new Error(`${label}-${lang}: undersized targets ${JSON.stringify(geometry.undersized)}`);
    }
    await page.screenshot({
      fullPage: true,
      path: path.join(outputDir, `${label}-${lang}-reminders.png`),
    });

    const statsName = lang === "es" ? "Estadísticas" : "Stats";
    await page.getByRole("button", { exact: true, name: statsName }).click();
    const legend = lang === "es"
      ? "Promedio · Mediana · Percentil 90"
      : "Average · Median · 90th percentile";
    await page.getByText(legend, { exact: true }).waitFor();
    await page.waitForFunction((name) => [...document.querySelectorAll(".mwl-tab")]
      .some((tab) => tab.getAttribute("aria-pressed") === "true" && tab.textContent.trim() === name), statsName);
    await page.waitForTimeout(500);
    const statsText = await page.locator(".mwl-statsgrid").innerText();
    if (/25 contributors|25 participantes/i.test(statsText)) {
      throw new Error(`${label}-${lang}: exact cohort size leaked`);
    }
    await page.screenshot({
      fullPage: true,
      path: path.join(outputDir, `${label}-${lang}-stats.png`),
    });

    results.push({
      errors,
      label,
      lang,
      legend,
      reminderTitle,
      surface: "member",
      viewport,
      ...geometry,
    });
  });
}

async function verifySteward(label, viewport, lang) {
  await withPage({ lang, viewport }, async (page, errors) => {
    await page.goto(`${baseUrl}/m/steward?demo=1`, { waitUntil: "networkidle" });
    const title = lang === "es"
      ? "Inteligencia de carga de trabajo"
      : "Workload intelligence";
    await page.getByRole("heading", { exact: true, name: title }).waitFor();
    const panel = page.locator(".cwk-workload");
    const panelText = await panel.innerText();
    const privacy = lang === "es"
      ? "Las tendencias usan agregados del capítulo con al menos 25 miembros por semana. El reequilibrio usa conteos de casos asignados y nunca registros privados de carga de miembros."
      : "Trends use chapter aggregates with at least 25 members per week. Rebalancing uses assigned-case counts and never private member workload logs.";
    if (!panelText.includes(privacy)) throw new Error(`${label}-${lang}: missing privacy copy`);
    if (/grievance narrative|member note|protected document/i.test(panelText)) {
      throw new Error(`${label}-${lang}: sensitive preview content rendered`);
    }

    const geometry = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      htmlLang: document.documentElement.lang,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    if (geometry.scrollWidth > geometry.clientWidth) {
      throw new Error(`${label}-${lang}: horizontal overflow ${geometry.scrollWidth}/${geometry.clientWidth}`);
    }
    await page.screenshot({
      fullPage: true,
      path: path.join(outputDir, `${label}-${lang}-steward.png`),
    });
    results.push({ errors, label, lang, privacy, surface: "steward", title, viewport, ...geometry });
  });
}

try {
  await verifyMember("desktop", { height: 900, width: 1280 }, "en");
  await verifyMember("desktop", { height: 900, width: 1280 }, "es");
  await verifyMember("phone", { height: 844, width: 390 }, "en");
  await verifyMember("phone", { height: 844, width: 390 }, "es");
  await verifySteward("desktop", { height: 900, width: 1280 }, "en");
  await verifySteward("phone", { height: 844, width: 390 }, "es");

  const browserErrors = results.flatMap((result) => result.errors);
  if (browserErrors.length > 0) throw new Error(`browser errors: ${JSON.stringify(browserErrors)}`);
  const report = { cases: results.length, ok: true, results };
  await writeProofFile(path.join(outputDir, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
