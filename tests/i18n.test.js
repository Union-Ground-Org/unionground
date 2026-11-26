import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { templateFromDbRow } from "../src/lib/formTemplates.js";
import { catalogue, countKey, t, dateTimeFormat, formatDateTime, localeFor } from "../src/lib/i18n.js";
import { DATE_TIME_STAMP_OPTIONS } from "../src/lib/i18n/format.js";
import { qaCatalogue, qaT } from "../src/lib/i18n/qa.js";
import { qaCountKey, qaText } from "../src/features/qa/copy.js";
import { connectionCopy, connectionSuggestionsCatalogue, connectionSuggestionsT } from "../src/lib/i18n/connectionSuggestions.js";
import { lookup } from "../src/lib/i18n/runtime.js";

// The catalogue used to be assembled by spreading a second module over this
// one, which made a key defined on both sides silently last-wins and invisible
// to every assertion below (they only ever see the merged result). Both halves
// now live in ONE object literal per locale, so the collision is a source-level
// fact: this reads the literal back and pins each key to exactly one line.
//
// PERF-UG-MOBILE-QA-BUNDLES-FULL-WEB-CATALOGUE-20260917 added namespace
// CHUNKS under src/lib/i18n/ — whole namespaces lifted out so a React Native
// screen can reach one of them instead of the whole web catalogue — and the barrel
// spreads each chunk back in at the position its keys used to hold. That is the
// same "spread a second module over this one" shape, so the scan below reads the
// chunks too, from their own literals, and the duplicate assertion runs over the
// union: a key declared in BOTH a chunk and the barrel is still a source-level
// fact this test refuses, which is the guarantee `no-dupe-keys` cannot give
// across two files.
const i18nSource = readFileSync(resolve(process.cwd(), "src/lib/i18n.js"), "utf8");
// PERF-UG-WEB-SHELL-AND-PER-LANGUAGE-BUNDLES-20261011 moved the
// Spanish barrel literal, verbatim, into its own on-demand chunk; it is still
// the barrel's `es:` block for every assertion below.
const barrelSources = {
  en: i18nSource,
  es: readFileSync(resolve(process.cwd(), "src/lib/i18n/es.js"), "utf8"),
};
// Discovered by the imported BINDING, not by the path: a chunk is exactly a
// module the barrel imports a `<namespace>Catalogue` from. src/lib/i18n/ also
// holds catalogue-free modules (runtime.js, format.js) that have no locale block
// and must not be scanned. This still fails CLOSED — a chunk imported in some
// other shape drops its keys out of the scanned set, and the key-set equality
// below then fails rather than passing quietly.
// REQ-UG-WEB-ENTRY-CHUNK-CARRIES-WHOLE-ENGLISH-CATALOGUE-20261109: a
// feature namespace is not imported by the barrel; its registration module
// (src/lib/i18n/features/<name>Strings.js) imports it in the same shape.
const featureStringSources = readdirSync(resolve(process.cwd(), "src/lib/i18n/features"))
  .map((file) => readFileSync(resolve(process.cwd(), "src/lib/i18n/features", file), "utf8"))
  .flatMap((source) => [...source.matchAll(/^import \{ ?\w+Catalogue ?\} from "\.\.\/([\w-]+)\.js";$/gm)].map((match) => `i18n/${match[1]}`));
const chunkSources = [...[...i18nSource.matchAll(/^import \{ ?\w+Catalogue ?\} from "\.\/(i18n\/[\w-]+)\.js";$/gm)].map((match) => match[1]), ...featureStringSources]
  .map((name) => {
    const source = readFileSync(resolve(process.cwd(), `src/lib/${name}.js`), "utf8");
    const spanish = source.match(/from "\.\/locales\/es\/namespaces\/([\w-]+)\.js"/);
    return { source, spanish: spanish && readFileSync(resolve(process.cwd(), `src/lib/i18n/locales/es/namespaces/${spanish[1]}.js`), "utf8") };
  });
// OPS-UG-I18N-PER-AREA-LOCALE-MODULES-20261109: the barrels' inline keys
// live in per-area modules, src/lib/i18n/locales/<locale>/<area>.js, each one
// flat `export const <area>Strings = {` literal its barrel spreads. They are
// declared sources like the chunks, so the duplicate scan reads them too.
const LOCALES = ["en", "es"];
const localeDir = (locale) => resolve(process.cwd(), "src/lib/i18n/locales", locale);
const areaFiles = (locale) => readdirSync(localeDir(locale)).filter((file) => file.endsWith(".js")).sort();
const areaNames = areaFiles("en").map((file) => file.slice(0, -".js".length));
const areaSources = Object.fromEntries(LOCALES.map((locale) => [
  locale,
  Object.fromEntries(areaNames.map((area) => [area, readFileSync(resolve(localeDir(locale), `${area}.js`), "utf8")])),
]));
const areaBarrelImport = { en: "./i18n/locales/en", es: "./locales/es" };
// The keys scripts/lib/legal-release.mjs hashes, line by line, in the barrels.
const LEGAL_RELEASE_KEY = /^(legal\..+|landing\.interestConsent|landing\.aiDisclosure)$/;

function areaKeys(source) {
  return [...source.matchAll(/^ {2}"([\w.]+)":/gm)].map((match) => match[1]);
}

function keysIn(source, locale, indent) {
  const open = `\n${indent}${locale}: {\n`;
  const start = source.indexOf(open);
  if (start < 0) return null;
  const end = source.indexOf(`\n${indent}},\n`, start);
  const body = source.slice(start + open.length, end);
  // A release's changelog keys name the instrument id, hyphen included
  // (legal.changelog.note.release.<migration>.privacy-policy).
  const pattern = new RegExp(`^ {${indent.length + 2}}"([\\w.-]+)":`, "gm");
  return [...body.matchAll(pattern)].map((match) => match[1]);
}

function declaredKeys(locale) {
  const barrel = keysIn(barrelSources[locale], locale, "  ");
  expect(barrel, `no ${locale} block in the ${locale} barrel literal`).not.toBeNull();
  const chunked = chunkSources.map(({ source, spanish }) => {
    const keys = locale === "es" && spanish
      ? [...spanish.matchAll(/^ {2}"([\w.-]+)":/gm)].map((match) => match[1])
      : keysIn(source, locale, "  ");
    expect(keys, `a src/lib/i18n chunk has no ${locale} block`).not.toBeNull();
    expect(keys.length, `a src/lib/i18n chunk has an empty ${locale} block`).toBeGreaterThan(0);
    return keys;
  });
  return [...barrel, ...chunked.flat(), ...Object.values(areaSources[locale]).flatMap(areaKeys)];
}

describe("i18n catalogue integrity", () => {
  it("shares connection labels across runtimes with a readable unknown-key fallback", () => {
    expect(connectionCopy()("contract-enforcement")).toBe("Enforcing workplace policies");
    expect(connectionCopy("es")("contract-enforcement")).toBe(connectionSuggestionsCatalogue.es["connectionSuggestions.contract_enforcement"]);
    expect(connectionCopy("es")("new-topic")).toBe("new-topic");
  });

  it("declares every key exactly once per locale (no silent last-wins collision)", () => {
    for (const locale of ["en", "es"]) {
      const keys = declaredKeys(locale);
      const duplicates = [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];
      expect(
        duplicates,
        `${locale} keys declared more than once (barrel literal + src/lib/i18n chunks): ${duplicates.join(", ")}`
          + " — a chunked namespace is declared ONLY in its chunk file"
          + " (qa.* -> src/lib/i18n/qa.js);"
          + " delete the copy in the src/lib/i18n.js literal",
      ).toEqual([]);
      // and the source literals are the whole catalogue — nothing is merged in
      // from somewhere this scan cannot see. A chunk the barrel does not import,
      // or an import shape this scan cannot read, shows up here as a key set
      // mismatch rather than as a silent blind spot.
      expect([...keys].sort()).toEqual(Object.keys(catalogue[locale]).sort());
    }
  });

  it("has identical key sets for en and es (no orphan or missing translation)", () => {
    const en = Object.keys(catalogue.en).sort();
    const es = Object.keys(catalogue.es).sort();
    const missingEs = en.filter((k) => !(k in catalogue.es));
    const missingEn = es.filter((k) => !(k in catalogue.en));
    expect(missingEs, `keys missing a Spanish translation: ${missingEs.join(", ")}`).toEqual([]);
    expect(missingEn, `keys missing an English source: ${missingEn.join(", ")}`).toEqual([]);
    expect(es).toEqual(en);
  });

  it("assembles every area module, in both languages, from the same set of areas", async () => {
    expect(areaNames.length, "src/lib/i18n/locales/en has no area modules").toBeGreaterThan(9);
    expect(areaFiles("es"), "src/lib/i18n/locales/es must hold exactly the English areas").toEqual(areaFiles("en"));
    for (const locale of LOCALES) {
      for (const area of areaNames) {
        expect(barrelSources[locale], `${locale} barrel imports ${area}`).toContain(`import { ${area}Strings } from "${areaBarrelImport[locale]}/${area}.js";`);
        expect(barrelSources[locale], `${locale} barrel spreads ${area}`).toContain(`\n    ...${area}Strings,\n`);
        const table = (await import(pathToFileURL(resolve(localeDir(locale), `${area}.js`)).href))[`${area}Strings`];
        // The scan reads the whole module, and nothing spread later in the
        // barrel replaces one of its strings.
        expect(areaKeys(areaSources[locale][area]), `${locale}/${area}.js scan`).toEqual(Object.keys(table));
        for (const [key, value] of Object.entries(table)) expect(catalogue[locale][key], `${locale} ${key}`).toBe(value);
      }
    }
  });

  it("keeps each first key segment in one area module, the same one in both languages", () => {
    const owners = Object.fromEntries(LOCALES.map((locale) => {
      const owner = new Map();
      for (const area of areaNames) {
        for (const prefix of new Set(areaKeys(areaSources[locale][area]).map((key) => key.split(".")[0]))) {
          owner.set(prefix, [...(owner.get(prefix) || []), area]);
        }
      }
      const split = [...owner].filter(([, areas]) => areas.length > 1).map(([prefix, areas]) => `${prefix}: ${areas.join(", ")}`);
      expect(split, `${locale} first key segments split across area modules; add a key to the module that already holds its segment`).toEqual([]);
      return [locale, Object.fromEntries([...owner].sort())];
    }));
    expect(owners.es, "a first key segment lives in different areas in English and Spanish").toEqual(owners.en);
  });

  it("declares the same keys in each English and Spanish area module", () => {
    for (const area of areaNames) {
      const en = areaKeys(areaSources.en[area]);
      const es = areaKeys(areaSources.es[area]);
      expect(en.filter((key) => !es.includes(key)), `keys in locales/en/${area}.js missing from locales/es/${area}.js`).toEqual([]);
      expect(es.filter((key) => !en.includes(key)), `keys in locales/es/${area}.js missing from locales/en/${area}.js`).toEqual([]);
    }
  });

  it("reaches the Spanish area modules only through the on-demand es.js chunk", () => {
    const importers = readdirSync(resolve(process.cwd(), "src"), { recursive: true })
      .filter((path) => /\.(?:jsx?|mjs|tsx?)$/.test(path) && path.replaceAll("\\", "/") !== "lib/i18n/es.js")
      .filter((path) => /["'][^"']*locales\/es\/[\w-]+\.js["']/.test(readFileSync(resolve(process.cwd(), "src", path), "utf8")));
    expect(importers, "a static import of a Spanish area module puts Spanish back in the entry chunk").toEqual([]);
  });

  it("keeps the legal release keys, and only those, inline in the two barrels", () => {
    for (const locale of LOCALES) {
      const moved = Object.values(areaSources[locale]).flatMap(areaKeys).filter((key) => LEGAL_RELEASE_KEY.test(key));
      expect(moved, `${locale} legal release keys belong in the barrel literal, where the release tooling hashes them`).toEqual([]);
      const inline = keysIn(barrelSources[locale], locale, "  ");
      expect(inline.filter((key) => LEGAL_RELEASE_KEY.test(key)).length).toBeGreaterThan(80);
      expect(inline.filter((key) => !LEGAL_RELEASE_KEY.test(key)), `${locale} keys added to the assembled file; add them to their area module under src/lib/i18n/locales/${locale}/`).toEqual([]);
    }
  });

  it("has non-empty string values on both sides", () => {
    for (const key of Object.keys(catalogue.en)) {
      expect(typeof catalogue.en[key], `${key} en`).toBe("string");
      expect(catalogue.en[key].length, `${key} en empty`).toBeGreaterThan(0);
      expect(typeof catalogue.es[key], `${key} es`).toBe("string");
      expect(catalogue.es[key].length, `${key} es empty`).toBeGreaterThan(0);
    }
  });

  // The chunks are only safe because they are TOTAL: qaT resolves a qa.* key
  // exactly as the barrel's t() does only while every qa.* key is declared in
  // the chunk and nowhere else. A key added to the barrel literal under a
  // chunked namespace would still resolve on the web and silently fall back to
  // the raw key on the phone, so that is the failure this pins.
  it("keeps each namespace chunk the sole and complete home of its namespace", () => {
    const chunks = [
      ["qa", qaCatalogue, qaT],
      ["connectionSuggestions", connectionSuggestionsCatalogue, connectionSuggestionsT],
    ];
    const vars = { count: 3, points: 0, label: "L", name: "N", from: "f", to: "t" };
    for (const [namespace, chunk, translate] of chunks) {
      for (const locale of ["en", "es"]) {
        const merged = Object.keys(catalogue[locale]).filter((key) => key.startsWith(`${namespace}.`)).sort();
        expect(merged.length, `${namespace} has no keys`).toBeGreaterThan(0);
        expect(
          Object.keys(chunk[locale]).sort(),
          `${namespace}.${locale} chunk is not the whole namespace — declare the missing key in`
            + ` src/lib/i18n/${namespace}.js, not at the src/lib/i18n.js tail, or it resolves on the`
            + " web and falls back to the raw key on the phone",
        ).toEqual(merged);
      }
      // …and the chunk translator answers byte for byte as the barrel does, for
      // every key and for the es -> en -> key fallback on a key it cannot find.
      for (const locale of ["en", "es", "fr"]) {
        for (const key of Object.keys(chunk.en)) {
          expect(translate(locale, key, vars), `${namespace} ${locale} ${key}`).toBe(t(locale, key, vars));
        }
        expect(translate(locale, `${namespace}.no.such.key`)).toBe(t(locale, `${namespace}.no.such.key`));
      }
    }
  });

  it("keeps catalogue byte sizes out of the chunk-boundary comments", () => {
    // DEBT-UG-I18N-CATALOGUE-SIZE-COMMENT-DRIFT-20260920: the size is
    // recorded once, dated, beside MOBILE_CATALOGUE_BYTE_BUDGET; a quoted
    // figure anywhere else goes stale the next time a key lands.
    const comments = [
      "src/lib/i18n.js",
      "src/lib/i18n/runtime.js",
      "src/lib/i18n/format.js",
      "src/features/qa/copy.js",
      "tests/i18n.test.js",
    ];
    // Union Ground's native MemberCaseworkProgress.tsx carried such a comment.
    // Union Ground's native app has no copy of it; if one arrives in a
    // later sync, it joins the list above.
    expect(existsSync(resolve(process.cwd(), "apps/mobile/src/components/MemberCaseworkProgress.tsx"))).toBe(false);
    for (const path of comments) {
      const lines = readFileSync(resolve(process.cwd(), path), "utf8").split("\n");
      const sized = lines.filter((line) => /^\s*\/\//.test(line) && /\d\s*(?:KB|KiB|kB)\b/.test(line));
      expect(sized, path).toEqual([]);
    }
  });

  it("keeps interpolation slots identical between en and es", () => {
    const slots = (str) => (str.match(/\{(\w+)\}/g) || []).sort();
    for (const key of Object.keys(catalogue.en)) {
      expect(slots(catalogue.es[key]), `${key} interpolation slots differ`).toEqual(slots(catalogue.en[key]));
    }
  });
});

describe("t() lookup", () => {
  it("returns the requested language string", () => {
    expect(t("en", "nav.today")).toBe("Today");
    expect(t("es", "nav.today")).toBe("Hoy");
    expect(t("en", "settings.topicVotes")).toBe("Votes & polls");
    expect(t("es", "settings.topicVotes")).toBe("Votaciones y encuestas");
    // Union Ground leaves dues out: the old Dues topic has no copy left.
    expect(t("en", "settings.topicDues")).toBe("settings.topicDues");
    expect(t("es", "settings.topicDues")).toBe("settings.topicDues");
  });

  it("falls back es -> en -> key", () => {
    expect(t("es", "no.such.key.exists")).toBe("no.such.key.exists");
    expect(t("es", "settings.publicMeta")).toBe("Sitio público de Union Ground");
  });

  // These use toast.voteSavedReceipt and offline.syncedMany because they carry
  // a real {slot}. A key with no slot cannot tell substitution from a no-op, so
  // it proves nothing about the replace() at src/lib/i18n.js:1398.
  it("substitutes a slot in either language", () => {
    expect(t("en", "toast.voteSavedReceipt", { code: "ABC123" })).toBe("Vote saved — receipt ABC123");
    expect(t("es", "toast.voteSavedReceipt", { code: "ABC123" })).toBe("Voto guardado — comprobante ABC123");
  });

  it("stringifies a non-string var rather than rendering [object Object]", () => {
    expect(t("en", "offline.syncedMany", { count: 3 })).toBe("Synced 3 changes made offline");
  });

  // A missing var must resolve to nothing, never to a literal "{code}". Braces
  // on a member's screen read as a broken app, and on the ballot receipt toast
  // they would read as a broken receipt.
  it("strips an unresolved slot instead of leaking braces", () => {
    expect(t("en", "toast.voteSavedReceipt")).toBe("Vote saved — receipt ");
    expect(t("en", "toast.voteSavedReceipt", {})).toBe("Vote saved — receipt ");
    expect(t("en", "toast.voteSavedReceipt", { unrelated: "x" })).toBe("Vote saved — receipt ");
    expect(t("es", "toast.voteSavedReceipt")).toBe("Voto guardado — comprobante ");
  });

  it("leaves a key with no slots untouched whether or not vars are passed", () => {
    expect(t("en", "nav.today", { points: 40 })).toBe("Today");
  });

  it("strips a slot whose var is present but nullish instead of printing it", () => {
    expect(t("en", "toast.rsvpSavedPoints", { points: undefined })).toBe("RSVP saved — + points");
    expect(t("en", "toast.rsvpSavedPoints", { points: null })).toBe("RSVP saved — + points");
    // falsy-but-real values still render
    expect(t("en", "toast.rsvpSavedPoints", { points: 0 })).toBe("RSVP saved — +0 points");
  });

  // Database form-template labels are passed to t() as unknown keys so they
  // return unchanged. That fallback is a second contract: it must not run the
  // catalogue interpolator, or brace-delimited admin copy is silently deleted.
  it("returns a missing key byte-for-byte in both locales, including brace-delimited words", () => {
    expect(t("en", "Nombre {completo}")).toBe("Nombre {completo}");
    expect(t("es", "Nombre {completo}")).toBe("Nombre {completo}");
  });

  it("does not interpolate a missing key even when vars are supplied", () => {
    expect(t("en", "Nombre {completo}", { completo: "X" })).toBe("Nombre {completo}");
    expect(t("es", "Nombre {completo}", { completo: "X" })).toBe("Nombre {completo}");
  });

  it("returns a missing key with no braces unchanged in both locales", () => {
    expect(t("en", "Nombre completo")).toBe("Nombre completo");
    expect(t("es", "Nombre completo")).toBe("Nombre completo");
  });

  it("still substitutes vars on a resolved catalogue key", () => {
    expect(t("en", "qa.votes", { count: 3 })).toBe("3 votes");
    expect(t("es", "qa.votes", { count: 3 })).toBe("3 votos");
  });

  it("still strips an absent or nullish catalogue slot instead of printing undefined", () => {
    expect(t("en", "qa.votes")).toBe(" votes");
    expect(t("en", "qa.votes", { count: null })).toBe(" votes");
    expect(t("en", "qa.votes", { count: undefined })).toBe(" votes");
    expect(t("es", "qa.votes")).toBe(" votos");
    expect(t("es", "qa.votes", { count: null })).toBe(" votos");
  });
});

// Database form-template labels ride t()'s verbatim-key fallback. A label that
// matches an Object.prototype name used to resolve to the inherited
// function/object (table["constructor"] is Object) instead of the key string.
const INHERITED_PROPERTY_KEYS = [
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "__proto__",
  "isPrototypeOf",
];

describe("t() / lookup() ignore inherited Object.prototype names", () => {
  it("returns each prototype name as a string key from t() in both locales", () => {
    for (const lang of ["en", "es"]) {
      for (const key of INHERITED_PROPERTY_KEYS) {
        const result = t(lang, key);
        expect(typeof result, `${lang} ${key}`).toBe("string");
        expect(result, `${lang} ${key}`).toBe(key);
      }
    }
  });

  it("returns each prototype name as a string key from lookup() on a namespace chunk", () => {
    for (const lang of ["en", "es"]) {
      for (const key of INHERITED_PROPERTY_KEYS) {
        const result = lookup(qaCatalogue, lang, key);
        expect(typeof result, `qa ${lang} ${key}`).toBe("string");
        expect(result, `qa ${lang} ${key}`).toBe(key);
      }
    }
  });

  it("round-trips prototype-named form-template labels through templateFromDbRow and t()", () => {
    const row = {
      key: "inherited_labels",
      version: 1,
      label_en: "constructor",
      label_es: "constructor",
      blurb_en: "toString",
      blurb_es: "toString",
      icon: "📄",
      points: 0,
      field_schema: {
        steps: [{
          title: { en: "valueOf", es: "valueOf" },
          fields: INHERITED_PROPERTY_KEYS.map((name) => ({
            key: name,
            type: "text",
            label: { en: name, es: name },
            required: false,
          })),
        }],
      },
    };
    for (const lang of ["en", "es"]) {
      const tpl = templateFromDbRow(row, lang);
      expect(t(lang, tpl.titleKey)).toBe("constructor");
      expect(t(lang, tpl.blurbKey)).toBe("toString");
      expect(t(lang, tpl.steps[0].titleKey)).toBe("valueOf");
      for (const field of tpl.steps[0].fields) {
        const translated = t(lang, field.labelKey);
        expect(typeof translated, `${lang} field ${field.key}`).toBe("string");
        expect(translated, `${lang} field ${field.key}`).toBe(field.key);
      }
    }
  });

  it("still returns a catalogue-owned non-string without going through the verbatim fallback", () => {
    const owned = { en: { owned: 42 }, es: { owned: 42 } };
    expect(lookup(owned, "en", "owned")).toBe(42);
    expect(lookup(owned, "es", "owned")).toBe(42);
  });
});

describe("locale helpers", () => {
  const instant = "2026-03-04T17:05:00Z";
  const utc = { timeZone: "UTC" };

  it("maps language to a plain Intl locale — the date half never moves", () => {
    // Deliberately plain. The clock is an option on dateTimeFormat, not a tag
    // on the locale: `es-u-hc-h12` is ignored correctly only from WebKit 611
    // (Safari 14.1) up, and vite.config.mjs pins safari14.
    expect(localeFor("es")).toBe("es");
    expect(localeFor("en")).toBe("en-US");
    expect(localeFor("fr")).toBe("en-US");
    expect(localeFor("es")).not.toMatch(/-u-/);
  });

  it("carries the 12-hour clock as an option, not as a locale extension", () => {
    const resolved = dateTimeFormat("es", { hour: "numeric", minute: "2-digit", ...utc }).resolvedOptions();
    expect(resolved.locale).toBe("es");
    expect(resolved.hourCycle).toBe("h12");
    expect(resolved.hour12).toBe(true);
    const english = dateTimeFormat("en", { hour: "numeric", minute: "2-digit", ...utc }).resolvedOptions();
    expect(english.locale).toBe("en-US");
    expect(english.hourCycle).toBe("h12");
  });

  it("leaves DATE-only output on the plain locale untouched", () => {
    const optionSets = [
      { dateStyle: "medium", ...utc },
      { dateStyle: "long", ...utc },
      { year: "numeric", month: "short", day: "numeric", ...utc },
      { weekday: "short", month: "short", day: "numeric", ...utc },
    ];
    for (const options of optionSets) {
      expect(new Intl.DateTimeFormat(localeFor("es"), options).format(new Date(instant)), JSON.stringify(options))
        .toBe(new Intl.DateTimeFormat("es", options).format(new Date(instant)));
      expect(new Intl.DateTimeFormat(localeFor("en"), options).format(new Date(instant)), JSON.stringify(options))
        .toBe(new Intl.DateTimeFormat("en-US", options).format(new Date(instant)));
    }
  });

  it("prints a 12-hour Spanish clock and leaves English unchanged", () => {
    const timeOptions = { hour: "numeric", minute: "2-digit", ...utc };
    const spanish = dateTimeFormat("es", timeOptions).format(new Date(instant));
    const english = dateTimeFormat("en", timeOptions).format(new Date(instant));
    expect(spanish).toMatch(/[ap]\.?\s*m\.?/i);
    expect(spanish).not.toMatch(/(?:^|[^\d])(?:1[3-9]|2[0-3]):[0-5]\d/);
    expect(english).toBe(new Intl.DateTimeFormat("en-US", timeOptions).format(new Date(instant)));
    expect(formatDateTime(instant, "es")).toMatch(/[ap]\.?\s*m\.?/i);
    expect(formatDateTime(instant, "en")).toBe(new Date(instant).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }));
  });

  it("its no-argument case equals toLocaleString(locale) byte for byte", () => {
    // The six bare stamps (admin login inbox, steward inbox, casework hub)
    // used to call toLocaleString(localeFor(lang)) with no options.
    for (const iso of ["2026-03-04T17:05:00Z", "2026-03-04T00:30:00Z", "2026-07-30T18:00:00Z"]) {
      expect(dateTimeFormat("en").format(new Date(iso))).toBe(new Date(iso).toLocaleString("en-US"));
      const spanish = dateTimeFormat("es").format(new Date(iso));
      expect(spanish.split(",")[0]).toBe(new Date(iso).toLocaleString("es").split(",")[0]);
      expect(spanish).toMatch(/[ap]\.?\s*m\.?/i);
    }
  });

  it("formats a datetime without throwing for either language", () => {
    expect(formatDateTime("2026-07-30T18:00:00Z", "en")).toBeTruthy();
    expect(formatDateTime("2026-07-30T18:00:00Z", "es")).toBeTruthy();
    expect(formatDateTime(null, "en")).toBe("");
  });
});

describe("dateTimeFormat zone-name branches", () => {
  it("returns a plain Intl formatter when no long zone name is asked for", () => {
    expect(dateTimeFormat("es", { hour: "numeric", timeZone: "UTC" })).toBeInstanceOf(Intl.DateTimeFormat);
  });

  it("keeps ICU's own label for a zone the catalogue does not carry", () => {
    const options = { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago", timeZoneName: "long" };
    expect(dateTimeFormat("es", options).format(new Date("2026-03-04T17:05:00Z"))).toContain("hora estándar central");
    expect(dateTimeFormat("en", options).format(new Date("2026-03-04T17:05:00Z"))).toContain("Central Standard Time");
  });

  it("still keys the catalogue table by ICU's current English long name (review L2 guard)", () => {
    expect(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "long" })
      .format(new Date("2026-03-04T17:05:00Z"))).toContain("Eastern Standard Time");
  });
});

describe("unparseable timestamp values", () => {
  const invalid = ["not-a-date", NaN, new Date("x"), "2026-13-45"];
  const instant = "2026-07-30T18:00:00Z";
  // Pin Eastern so the no-argument catalogue-label assertion is host-TZ-stable.
  const longZoneOptions = { ...DATE_TIME_STAMP_OPTIONS, timeZoneName: "long", timeZone: "America/New_York" };

  it("formatDateTime returns empty for unparseable values in both languages", () => {
    for (const lang of ["en", "es"]) {
      for (const value of invalid) {
        expect(formatDateTime(value, lang), `${lang} ${String(value)}`).toBe("");
      }
    }
  });

  it("formatDateTime is unchanged for a valid ISO stamp in both languages", () => {
    expect(formatDateTime(instant, "en")).toBe(new Date(instant).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }));
    expect(formatDateTime(instant, "es")).toBe(
      new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short", hourCycle: "h12" }).format(new Date(instant)),
    );
  });

  it("long-zone format returns empty for unparseable values rather than throwing", () => {
    for (const lang of ["en", "es"]) {
      const formatter = dateTimeFormat(lang, longZoneOptions);
      for (const value of invalid) {
        expect(formatter.format(value), `${lang} ${String(value)}`).toBe("");
      }
    }
  });

  it("long-zone format() with no argument still renders now with the catalogue zone label", () => {
    for (const lang of ["en", "es"]) {
      const rendered = dateTimeFormat(lang, longZoneOptions).format();
      expect(rendered).toBeTruthy();
      expect(
        rendered.includes(catalogue[lang]["date.zoneEasternDaylight"])
          || rendered.includes(catalogue[lang]["date.zoneEasternStandard"]),
        `${lang} zone label missing from ${rendered}`,
      ).toBe(true);
    }
  });
});

// App Store capture, Nov 7, 2026: a single reply read "1 replies". Every
// counted reply or vote phrase has a ".one" form in both languages.
describe("counted reply and vote phrases", () => {
  it("says one reply and one vote in the singular, in English and Spanish", () => {
    expect(qaText("en", qaCountKey("replies", 1), { count: 1 })).toBe("1 reply");
    expect(qaText("en", qaCountKey("replies", 2), { count: 2 })).toBe("2 replies");
    expect(qaText("en", qaCountKey("replies", 0), { count: 0 })).toBe("0 replies");
    expect(qaText("en", qaCountKey("votes", 1), { count: 1 })).toBe("1 vote");
    expect(qaText("es", qaCountKey("replies", 1), { count: 1 })).toBe("1 respuesta");
    expect(qaText("es", qaCountKey("votes", 1), { count: 1 })).toBe("1 voto");
    expect(qaText("es", qaCountKey("votes", 3), { count: 3 })).toBe("3 votos");
  });

  it("gives the inbox thread preview a singular form", () => {
    expect(t("en", "inbox.replies.one", { kind: "Thread", n: 1 })).toBe("Thread · 1 reply");
    expect(t("es", "inbox.replies.one", { kind: "Hilo", n: 1 })).toBe("Hilo · 1 respuesta");
    expect(t("en", "inbox.replies", { kind: "Thread", n: 2 })).toBe("Thread · 2 replies");
    expect(countKey("inbox.replies", 1)).toBe("inbox.replies.one");
    expect(countKey("inbox.replies", 0)).toBe("inbox.replies");
    expect(countKey("inbox.replies", undefined)).toBe("inbox.replies");
    expect(qaCountKey("replies", undefined)).toBe("replies");
    const view = readFileSync(resolve(import.meta.dirname, "../src/views/MessagesView.jsx"), "utf8");
    expect(view).toContain('t(countKey("inbox.replies", item.posts?.length), { kind: item.kind, n: item.posts?.length || 0 })');
  });
});
