// The lookup half of the app's i18n, with no catalogue attached.
//
// PERF-UG-MOBILE-QA-BUNDLES-FULL-WEB-CATALOGUE-20260917: `src/lib/i18n.js`
// holds the whole web catalogue (one object literal per locale, both in the one
// module), which Metro cannot tree-shake, so any React Native module that
// reaches it ships the whole web catalogue to resolve a handful of strings. Namespace chunks under this directory hold
// their own keys and call the SAME resolution function the barrel's `t()`
// calls, so a chunk and the barrel can never drift: there is one register and
// one lookup, and only the table differs.
//
// Two contracts share this function. A key present in the requested language
// table, or else in catalogue.en, is catalogue copy: `{var}` interpolation;
// a var that is absent OR nullish is stripped rather than printed (testing
// key PRESENCE instead rendered the literal "undefined"/"null" into
// member-facing copy the moment a caller passed a var it had not defaulted).
// A key that misses both tables is a verbatim fallback — `t()`'s unknown-key
// path used by database form-template labels — and returns that key
// byte-for-byte with no replace(), even when vars are supplied.
export function lookup(catalogue, lang, key, vars) {
  const table = catalogue[lang] || catalogue.en;
  // Own-property reads only: a bare `table[key]` also resolves Object.prototype
  // names (`constructor`, `toString`, ...), so a form-template label matching
  // one returned a function instead of reaching the verbatim fallback.
  let str = Object.hasOwn(table, key) ? table[key] : undefined;
  if (str == null && Object.hasOwn(catalogue.en, key)) str = catalogue.en[key];
  if (str == null) return key;
  if (typeof str !== "string") return str;
  return str.replace(/\{(\w+)\}/g, (match, name) => (vars?.[name] == null ? "" : String(vars[name])));
}
