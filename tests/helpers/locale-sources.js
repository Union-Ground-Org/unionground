import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The source text of one language's catalogue literal: its barrel
// (src/lib/i18n.js or src/lib/i18n/es.js) followed by its per-area modules
// under src/lib/i18n/locales/<locale>/
// (OPS-UG-I18N-PER-AREA-LOCALE-MODULES-20261109). For tests that pin a
// string's source line rather than its looked-up value.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BARRELS = { en: "src/lib/i18n.js", es: "src/lib/i18n/es.js" };

export function localeSourcePaths(locale) {
  const dir = `src/lib/i18n/locales/${locale}`;
  const areas = readdirSync(join(root, dir)).filter((file) => file.endsWith(".js")).sort();
  return [BARRELS[locale], ...areas.map((file) => `${dir}/${file}`)];
}

export function localeSource(locale) {
  return localeSourcePaths(locale).map((path) => readFileSync(join(root, path), "utf8")).join("\n");
}
