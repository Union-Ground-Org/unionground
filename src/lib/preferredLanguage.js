// The saved choice wins over the device's, for every pre-auth standalone route.
//
// Union Ground persists the language toggle under unionground-lang. The
// legacy sg-lang key remains a read-only migration fallback for browsers that
// saved a preference before the product rename. A member who follows /reset or
// /verify should keep that saved choice outside the signed-in app shell.
//
// Kept deliberately tiny and window-injectable so it is trivial to unit-test
// under jsdom without stubbing globals.
export function preferredLanguage(win = typeof window === "undefined" ? null : window) {
  try {
    for (const key of ["unionground-lang", "sg-lang"]) {
      const stored = win?.localStorage?.getItem(key);
      if (stored === "es" || stored === "en") return stored;
    }
  } catch {
    // Private mode / blocked storage: fall through to the device language.
  }
  const device = win?.navigator?.language || (typeof navigator !== "undefined" ? navigator.language : "");
  return String(device || "").startsWith("es") ? "es" : "en";
}
