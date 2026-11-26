// #9460: what a Questions field still needs before its post button opens, on
// web and phone. Kept beside the rule (as #9452 kept the password reasons) and
// out of src/lib/i18n, whose phone budget is nearly spent. Counts trimmed text.
// An empty field gets the plain rule; a count starts only once something is typed.
const TEXT = Object.freeze({
  en: Object.freeze({ rule: "At least {minimum} characters.", one: "At least {minimum} characters: {short} more needed.", other: "At least {minimum} characters: {short} more needed.", met: "Long enough." }),
  es: Object.freeze({ rule: "Al menos {minimum} caracteres.", one: "Al menos {minimum} caracteres: falta {short}.", other: "Al menos {minimum} caracteres: faltan {short}.", met: "Longitud suficiente." }),
});

// The line beside the field, or "" once the field meets its minimum.
/** @param {string} lang @param {unknown} value @param {number} minimum @returns {string} */
export function qaLengthHint(lang, value, minimum) {
  const length = String(value ?? "").trim().length;
  const short = Math.max(0, minimum - length);
  if (short === 0) return "";
  const forms = lang === "es" ? TEXT.es : TEXT.en;
  return (length === 0 ? forms.rule : short === 1 ? forms.one : forms.other)
    .replace("{minimum}", String(minimum))
    .replace("{short}", String(short));
}

// Said once, politely, when a typed field reaches its minimum.
/** @param {string} lang @returns {string} */
export function qaLengthMet(lang) {
  return lang === "es" ? TEXT.es.met : TEXT.en.met;
}
