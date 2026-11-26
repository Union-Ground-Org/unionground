import { createContext, useContext, useEffect, useMemo } from "react";
import { catalogue, t as translate } from "./i18n.js";
import { WORKLOAD_CATEGORY_LABEL_KEYS } from "./workloadCategories.js";

const LanguageContext = createContext({ lang: "en", t: (key, vars) => translate("en", key, vars) });

export const ORGANIZATION_LABEL_KEYS = Object.freeze([
  "nav.home", "nav.myCases", "nav.messages", "nav.inbox", "nav.knowRights",
  "nav.myChapter", "nav.settings", "staff.chapterWork", "nav.casework",
  "admin.title", "coordinator.title", "advisor.title", "vp.title",
]);
// BUG-UG-ORG-LABEL-OVERRIDES-NOT-LOCALIZED-20261106: a menu or page
// name override is saved in one language (the admin writes it in English), so
// it replaces the English label only; any other language keeps the product's
// own translation instead of showing one English item among translated ones.
const menuLabelKeys = new Set(ORGANIZATION_LABEL_KEYS);
// REQ-UG-WORKLOAD-CATEGORY-LABELS-VISIBILITY-ORDER-20261103: the
// organization's names for the eight workload categories replace the
// catalogue name wherever a category is shown, in either language.
const categoryLabelKeys = new Set(WORKLOAD_CATEGORY_LABEL_KEYS);

function overrideApplies(lang, key) {
  return categoryLabelKeys.has(key) || (lang === "en" && menuLabelKeys.has(key));
}

// REQ-UG-CHAPTER-UNITS-WORKSITES-AND-LOCAL-PROFILE-20261030: the
// organization's own words for "chapter" and "worksite", saved through the
// same label overrides. They replace the default word inside every catalogue
// string (titles, buttons, menus, messages) in either language. A missing
// plural is the singular plus "s".
export const TERM_LABEL_KEYS = Object.freeze(["term.chapter", "term.chapters", "term.worksite", "term.worksites"]);
const TERM_PAIRS = [["term.chapters", "term.chapter"], ["term.worksites", "term.worksite"]];
const TERM_VALUE = /^\p{L}[\p{L} '&-]{0,29}$/u;

function termValue(overrides, key) {
  const value = overrides?.[key];
  return typeof value === "string" && TERM_VALUE.test(value.trim()) ? value.trim() : null;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The matched word's case decides the replacement's first letter, so "Add
// chapter" becomes "Add shop" and "Chapter" becomes "Shop"; a replacement that
// starts with an acronym ("DCF unit") keeps its capitals.
function matchCase(found, replacement) {
  const first = found.charAt(0);
  if (first !== first.toLowerCase()) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  const firstWord = replacement.split(" ")[0];
  if (firstWord.length > 1 && firstWord === firstWord.toUpperCase()) return replacement;
  return replacement.charAt(0).toLowerCase() + replacement.slice(1);
}

// One rule set for one pass: every renamed word in a single alternation, so
// one rule's output is never read by another ("chapter" -> "Worksite" stays
// Worksite even when "worksite" is renamed too).
export function termRules(lang, overrides) {
  const words = [];
  for (const [pluralKey, singularKey] of TERM_PAIRS) {
    const singular = termValue(overrides, singularKey);
    const plural = termValue(overrides, pluralKey) ?? (singular ? `${singular}s` : null);
    if (plural) words.push({ word: translate(lang, pluralKey), replacement: plural });
    if (singular) words.push({ word: translate(lang, singularKey), replacement: singular });
  }
  if (!words.length) return [];
  // Longest first, so "chapters" is never read as "chapter" + "s".
  words.sort((a, b) => b.word.length - a.word.length);
  const byWord = new Map(words.map((entry) => [entry.word.toLocaleLowerCase(lang), entry.replacement]));
  return [{
    pattern: new RegExp(`(?<!\\p{L})(?:${words.map((entry) => escapeRegExp(entry.word)).join("|")})(?!\\p{L})`, "giu"),
    replace: (found) => matchCase(found, byWord.get(found.toLocaleLowerCase(lang)) ?? found),
  }];
}

// Vars are swapped for sentinels while the terms are replaced, so a member's
// own text ("Worcester Chapter") passed into a string is never rewritten.
export function translateWithTerms(lang, key, vars, rules) {
  // Only the app's own catalogue copy is renamed. A key missing from both
  // tables comes back verbatim (organization-authored form titles and field
  // labels travel this path), and that text stays exactly as written.
  if (!rules.length || TERM_LABEL_KEYS.includes(key)
      || !(Object.hasOwn(catalogue.en, key) || Object.hasOwn(catalogue[lang] ?? {}, key))) return translate(lang, key, vars);
  const names = vars && typeof vars === "object" ? Object.keys(vars) : [];
  const sentinelVars = Object.fromEntries(names.map((name, index) => [name, vars[name] == null ? null : `\uE000${index}\uE001`]));
  const text = translate(lang, key, sentinelVars);
  if (typeof text !== "string") return text;
  const renamed = rules.reduce((current, rule) => current.replace(rule.pattern, rule.replace), text);
  return renamed.replace(/\uE000(\d+)\uE001/g, (_, index) => String(vars[names[Number(index)]]));
}

// Shared by the provider and App's shell, which builds labels above it.
export function organizationTranslator(lang, labelOverrides) {
  const rules = termRules(lang, labelOverrides);
  return (key, vars) => {
    const override = overrideApplies(lang, key) ? labelOverrides?.[key] : null;
    return typeof override === "string" && override.trim().length > 0 && override.length <= 40
      ? override
      : translateWithTerms(lang, key, vars, rules);
  };
}

export function LanguageProvider({ lang, labelOverrides = null, children }) {
  const value = useMemo(() => ({ lang, labelOverrides, t: organizationTranslator(lang, labelOverrides) }), [lang, labelOverrides]);

  // index.html hardcodes <html lang="en"> and nothing ever changed it, so every
  // Spanish screen in the app was announced to a screen reader under English
  // pronunciation rules — and the browser's own native validation messages came
  // out in the wrong language too. This is the one place that knows the answer.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = lang === "es" ? "es" : "en";
  }, [lang]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLang() {
  return useContext(LanguageContext);
}

// Some reusable screens accept an explicit language, including outside the
// provider. Keep that language while carrying the current organization's words.
export function useOrganizationTranslator(lang) {
  const context = useLang();
  const language = lang ?? context.lang;
  return useMemo(() => organizationTranslator(language, context.labelOverrides), [language, context.labelOverrides]);
}
