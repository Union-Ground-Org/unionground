// The language a visitor gets before any session says otherwise: the saved
// sg-lang choice, else the browser's own hint. main.jsx reads it to fetch that
// catalogue before the first paint; App reads it for the pre-auth surfaces.
export function bootLanguage() {
  try {
    // Union Ground's own key first, then the legacy shared key.
    for (const key of ["unionground-lang", "sg-lang"]) {
      const stored = window.localStorage.getItem(key);
      if (stored === "en" || stored === "es") return stored;
    }
  } catch {
    // localStorage may be unavailable; fall through to the navigator hint.
  }
  return typeof navigator !== "undefined" && navigator.language && navigator.language.startsWith("es") ? "es" : "en";
}
