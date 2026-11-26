// The languages Union Ground ships, in one list
// (REQ-UG-LANGUAGES-ARE-A-PAIR-NOT-A-LIST-20261122). A reader that
// accepts, refuses or normalises a language code takes it from here, so adding
// a language is translation work plus one entry in this list, not an edit in
// every reader. The owner's ruling of November 22, 2026 ("languages as a
// list") keeps the shipped list to English and Spanish: no entry is added
// without his word. No imports: the API and the phone import this module too.
export const SHIPPED_LANGUAGES = Object.freeze(["en", "es"]);
export const DEFAULT_LANGUAGE = "en";

export function isShippedLanguage(code, languages = SHIPPED_LANGUAGES) {
  return typeof code === "string" && languages.includes(code);
}

// An outside language tag (an identity provider's preferredLanguage, "es-MX",
// "en_US") as a shipped code: the first shipped code the tag starts with,
// otherwise the default.
export function languageFromTag(tag, languages = SHIPPED_LANGUAGES) {
  const text = typeof tag === "string" ? tag.trim().toLowerCase() : "";
  return languages.find((code) => text.startsWith(code)) ?? DEFAULT_LANGUAGE;
}
