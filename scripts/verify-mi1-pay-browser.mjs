/* global document, getComputedStyle */
import { chromium } from "@playwright/test";
import path from "node:path";
import { resolveProofOutputDir, writeProofFile } from "./lib/proof-output-dir.mjs";

const baseUrl = process.env.MI1_PAY_BROWSER_BASE_URL || "http://127.0.0.1:4176";
const outputDir = await resolveProofOutputDir(process.env.MI1_PAY_BROWSER_OUTPUT_DIR, "mi1-pay-browser-proof");
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
    const surface = document.querySelector('[data-mi1-surface="pay-tools"]');
    if (!surface) return false;
    const visibleContent = [
      surface,
      ...surface.querySelectorAll("h1, label, button, input, strong, p, small, th, td"),
    ].filter((element) => {
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
      return opacity >= 0.999;
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
      return Math.round(opacity * 1000) / 1000;
    }
    const root = document.querySelector('[data-mi1-surface="pay-tools"]');
    const controls = [...(root?.querySelectorAll("button, input") || [])]
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          height: Math.round(rect.height),
          label: element.getAttribute("aria-label")
            || element.labels?.[0]?.textContent?.trim()
            || element.textContent?.trim().slice(0, 60)
            || element.tagName,
          width: Math.round(rect.width),
        };
      });
    const contrast = [...(root?.querySelectorAll("h1, label, button, input, strong, p, small, th, td") || [])]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((element) => ({
        label: element.getAttribute("aria-label")
          || element.textContent?.trim().slice(0, 60)
          || element.tagName,
        opacity: opacityFor(element),
        ...contrastFor(element),
      }));
    return {
      clientWidth: document.documentElement.clientWidth,
      contrast,
      controls,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      inertElements: document.querySelectorAll("[inert]").length,
      scrollWidth: document.documentElement.scrollWidth,
      welcomeLayers: document.querySelectorAll(".demo-welcome-layer").length,
    };
  });
}

function assertClean(label, measurements, errors) {
  assert(measurements.scrollWidth <= measurements.clientWidth, `${label} overflow: ${JSON.stringify(measurements)}`);
  assert(
    measurements.dialogs === 0 && measurements.inertElements === 0 && measurements.welcomeLayers === 0,
    `${label} modal cleanup failed: ${JSON.stringify(measurements)}`,
  );
  assert(
    measurements.controls.every(({ height, width }) => height >= 44 && width >= 44),
    `${label} undersized controls: ${JSON.stringify(measurements.controls)}`,
  );
  assert(
    measurements.contrast.every(({ opacity, ratio }) => opacity >= 0.999 && ratio != null && ratio >= 4.5),
    `${label} contrast or opacity failure: ${JSON.stringify(measurements.contrast)}`,
  );
  assert(errors.length === 0, `${label} browser errors: ${errors.join(" | ")}`);
}

async function enterCalculation(page, labels) {
  await page.getByLabel(labels.regularHours, { exact: true }).fill("40");
  await page.getByLabel(labels.hourlyRate, { exact: true }).fill("25");
  await page.getByLabel(labels.amountPaid, { exact: true }).fill("800");
  await page.getByLabel(labels.overtimeHours, { exact: true }).fill("1");
  await page.getByRole("button", { name: labels.calculate, exact: true }).click();
  await page.getByText(labels.rulesUnset).waitFor();
  await page.getByLabel(labels.overtimeMultiplier, { exact: true }).fill("1.5");
  await page.getByRole("button", { name: labels.calculate, exact: true }).click();
  await page.getByText("$1037.50", { exact: true }).waitFor();
  await page.getByLabel(labels.overtimeMultiplier, { exact: true }).fill("");
  await page.getByLabel(labels.overtimeHours, { exact: true }).fill("0");
  await page.getByRole("button", { name: labels.calculate, exact: true }).click();
  await page.locator("p").filter({ hasText: labels.grossOwed })
    .getByText("$1000.00", { exact: true }).waitFor();
  await page.locator("p").filter({ hasText: labels.backPay })
    .getByText("$200.00", { exact: true }).waitFor();
}

async function verifyCatalogDateGate(page, labels) {
  await page.getByLabel(labels.grade, { exact: true }).fill("A");
  await page.getByLabel(labels.step, { exact: true }).fill("1");
  await page.getByRole("button", { name: labels.calculate, exact: true }).click();
  await page.getByText(labels.dateRequired).waitFor();
  await page.getByLabel(labels.calculationDate, { exact: true }).fill("2026-08-25");
  await page.getByRole("button", { name: labels.calculate, exact: true }).click();
  await page.getByText(labels.scaleNotFound).waitFor();
  await page.getByLabel(labels.calculationDate, { exact: true }).fill("");
  await page.getByLabel(labels.grade, { exact: true }).fill("");
  await page.getByLabel(labels.step, { exact: true }).fill("");
}

async function verifyComparisonForm(page, labels) {
  await page.getByRole("button", { name: labels.compareTab, exact: true }).click();
  await page.getByLabel(labels.leftGrade, { exact: true }).fill("A");
  await page.getByLabel(labels.leftStep, { exact: true }).fill("1");
  await page.getByLabel(labels.leftDate, { exact: true }).fill("2025-12-31");
  await page.getByLabel(labels.rightGrade, { exact: true }).fill("A");
  await page.getByLabel(labels.rightStep, { exact: true }).fill("2");
  await page.getByLabel(labels.rightDate, { exact: true }).fill("2026-12-31");
  await page.getByLabel(labels.hoursPerYear, { exact: true }).fill("2000");
  await page.getByLabel(labels.checksPerYear, { exact: true }).fill("25");
  await page.getByRole("button", { name: labels.compare, exact: true }).click();
  const empty = page.getByText(labels.scaleNotFound);
  await empty.waitFor();
  await waitForSettledSurface(page);
  return { empty, geometry: await geometry(page) };
}

const browser = await chromium.launch({ headless: true });

try {
  const desktop = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
  const page = await desktop.newPage();
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console:${message.text()}`); });
  page.on("pageerror", (error) => errors.push(`page:${error.message}`));
  await page.goto(`${baseUrl}/m/pay?demo=1`, { waitUntil: "networkidle" });
  await dismissTour(page);
  await page.locator(".demo-welcome-layer").waitFor({ state: "detached" });
  await page.getByRole("heading", { name: "Pay tools" }).waitFor();
  await verifyCatalogDateGate(page, {
    calculate: "Calculate",
    calculationDate: "Calculation date",
    dateRequired: "Enter a calculation date when using a published grade and step.",
    grade: "Grade",
    scaleNotFound: "No published rate matches those inputs for the selected organization.",
    step: "Step",
  });
  await enterCalculation(page, {
    amountPaid: "Amount already paid",
    backPay: "Back pay",
    calculate: "Calculate",
    grossOwed: "Gross owed",
    hourlyRate: "Hourly rate",
    overtimeHours: "Overtime hours",
    overtimeMultiplier: "Overtime multiplier",
    regularHours: "Regular hours",
    rulesUnset: "Enter the organization-provided contract rules used by this estimate.",
  });
  await waitForSettledSurface(page);
  const calculationGeometry = await geometry(page);
  assertClean("desktop calculation", calculationGeometry, errors);
  await page.screenshot({ path: path.join(outputDir, "pay-tools-desktop-en.png"), fullPage: true });

  await page.getByRole("button", { name: "Pay-scale tables", exact: true }).click();
  const emptyCatalog = page.getByText(/This organization has not added its contract pay rates yet/i);
  await emptyCatalog.waitFor();
  await waitForSettledSurface(page);
  const tableGeometry = await geometry(page);
  const emptyCatalogMessage = await emptyCatalog.textContent();
  assertClean("desktop tables", tableGeometry, errors);
  const desktopComparison = await verifyComparisonForm(page, {
    checksPerYear: "Paychecks per year",
    compare: "Compare",
    compareTab: "Compare rates",
    hoursPerYear: "Annual hours",
    leftDate: "From date",
    leftGrade: "From grade",
    leftStep: "From step",
    rightDate: "To date",
    rightGrade: "To grade",
    rightStep: "To step",
    scaleNotFound: "No published rate matches those inputs for the selected organization.",
  });
  assertClean("desktop comparison", desktopComparison.geometry, errors);
  await page.screenshot({ path: path.join(outputDir, "pay-tools-comparison-desktop-en.png"), fullPage: true });
  results.push({
    calculation: { amountPaid: "$800.00", backPay: "$200.00", grossOwed: "$1000.00", hourlyRate: "$25.00", regularHours: 40 },
    errors,
    label: "desktop-en",
    states: {
      calculation: calculationGeometry,
      calculationDateRequired: true,
      calculationRulesUnset: true,
      comparison: desktopComparison.geometry,
      tables: tableGeometry,
    },
    comparison: { empty: true, message: await desktopComparison.empty.textContent() },
    tables: { empty: true, message: emptyCatalogMessage },
    viewport: { height: 900, width: 1280 },
  });
  await desktop.close();

  const mobile = await browser.newContext({ locale: "es-ES", viewport: { width: 390, height: 844 } });
  await mobile.addInitScript(() => localStorage.setItem("sg-lang", "es"));
  const mobilePage = await mobile.newPage();
  const mobileErrors = [];
  mobilePage.on("console", (message) => { if (message.type() === "error") mobileErrors.push(`console:${message.text()}`); });
  mobilePage.on("pageerror", (error) => mobileErrors.push(`page:${error.message}`));
  await mobilePage.goto(`${baseUrl}/m/pay?demo=1`, { waitUntil: "networkidle" });
  await dismissTour(mobilePage);
  await mobilePage.locator(".demo-welcome-layer").waitFor({ state: "detached" });
  await mobilePage.getByRole("heading", { name: "Herramientas de pago" }).waitFor();
  await verifyCatalogDateGate(mobilePage, {
    calculate: "Calcular",
    calculationDate: "Fecha del cálculo",
    dateRequired: "Ingresa una fecha de cálculo al usar un grado y escalón publicados.",
    grade: "Grado",
    scaleNotFound: "Ninguna tarifa publicada coincide con esos datos para la organización seleccionada.",
    step: "Escalón",
  });
  await enterCalculation(mobilePage, {
    amountPaid: "Monto ya pagado",
    backPay: "Retroactivo",
    calculate: "Calcular",
    grossOwed: "Total adeudado",
    hourlyRate: "Tarifa por hora",
    overtimeHours: "Horas extra",
    overtimeMultiplier: "Multiplicador de horas extra",
    regularHours: "Horas regulares",
    rulesUnset: "Ingresa las reglas contractuales proporcionadas por la organización que usa este estimado.",
  });
  await waitForSettledSurface(mobilePage);
  const mobileCalculationGeometry = await geometry(mobilePage);
  assertClean("mobile calculation", mobileCalculationGeometry, mobileErrors);

  await mobilePage.getByRole("button", { name: "Tablas salariales", exact: true }).click();
  const mobileEmptyCatalog = mobilePage.getByText(/Esta organización aún no tiene una escala salarial publicada/i);
  await mobileEmptyCatalog.waitFor();
  await waitForSettledSurface(mobilePage);
  const mobileTableGeometry = await geometry(mobilePage);
  const mobileEmptyCatalogMessage = await mobileEmptyCatalog.textContent();
  assertClean("mobile tables", mobileTableGeometry, mobileErrors);
  await mobilePage.screenshot({ path: path.join(outputDir, "pay-tools-mobile-es.png"), fullPage: true });
  const mobileComparison = await verifyComparisonForm(mobilePage, {
    checksPerYear: "Cheques de pago por año",
    compare: "Comparar",
    compareTab: "Comparar tarifas",
    hoursPerYear: "Horas anuales",
    leftDate: "Fecha inicial",
    leftGrade: "Grado inicial",
    leftStep: "Escalón inicial",
    rightDate: "Fecha final",
    rightGrade: "Grado final",
    rightStep: "Escalón final",
    scaleNotFound: "Ninguna tarifa publicada coincide con esos datos para la organización seleccionada.",
  });
  assertClean("mobile comparison", mobileComparison.geometry, mobileErrors);
  await mobilePage.screenshot({ path: path.join(outputDir, "pay-tools-comparison-mobile-es.png"), fullPage: true });
  results.push({
    calculation: { amountPaid: "$800.00", backPay: "$200.00", grossOwed: "$1000.00", hourlyRate: "$25.00", regularHours: 40 },
    errors: mobileErrors,
    label: "mobile-es",
    states: {
      calculation: mobileCalculationGeometry,
      calculationDateRequired: true,
      calculationRulesUnset: true,
      comparison: mobileComparison.geometry,
      tables: mobileTableGeometry,
    },
    comparison: { empty: true, message: await mobileComparison.empty.textContent() },
    tables: { empty: true, message: mobileEmptyCatalogMessage },
    viewport: { height: 844, width: 390 },
  });
  await mobile.close();

  await writeProofFile(path.join(outputDir, "proof.json"), `${JSON.stringify({ baseUrl, results }, null, 2)}\n`);
  process.stdout.write(`MI1 pay browser verification passed: ${outputDir}\n`);
} finally {
  await browser.close();
}
