import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogue } from "../src/lib/i18n/allLanguages.js";
import { assertPins, readPins, writePins } from "./lib/source-pins.mjs";

export const LEGAL_PINS = "config/legal-catalogue-pins";
export const LEGAL_SOURCES = { en: "src/lib/i18n.js", es: "src/lib/i18n/es.js" };
// The packet reviews legal copy, not unrelated Home or Work translations.
// Bind each reviewed value to its source path, language and exact key. New and
// removed legal keys are compared too; nothing is selected from the pin store.
export function legalCataloguePins(catalogues = catalogue) {
  return Object.fromEntries(Object.entries(LEGAL_SOURCES).flatMap(([language, source]) =>
    Object.entries(catalogues[language]).filter(([key]) => key.startsWith("legal.")
      || key === "landing.interestConsent" || key === "landing.aiDisclosure")
      .map(([key, value]) => [`${source}#${language}:${key}`, value])));
}
export function checkLegalCataloguePins() {
  assertPins(legalCataloguePins(), readPins(LEGAL_PINS), "Reviewer packet legal catalogues");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--review")) writePins(LEGAL_PINS, legalCataloguePins());
  else checkLegalCataloguePins();
}
