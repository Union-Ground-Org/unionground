// The catalogue-free half of the app's date and time rendering.
//
// PERF-UG-MOBILE-QA-BUNDLES-FULL-WEB-CATALOGUE-20260917. A React Native
// screen that needs a localised date used to reach src/lib/i18n.js for it, and
// that module holds the whole web catalogue, which Metro cannot tree-shake — so
// one `formatDateTime` import put the whole web catalogue in the app bundle. Everything here is free of the catalogue, so a native screen can
// import a localised date without it.
//
// The split follows the ONE seam that matters: `localeFor`, the two constants
// and the plain formatter need no strings, while the LONG-ZONE-NAME decision
// (owner 2026-09-18, UX-UG-PUBLIC-EVENT-DETAIL-SPANISH-TIMEZONE-LABEL-20260917)
// reads a key out of the catalogue and therefore stays in the barrel, wrapping
// `dateTimeFormatCore` below. This module must NEVER import src/lib/i18n.js:
// that would be an import cycle AND would put the catalogue straight back into
// the native bundle through this file. `scripts/verify-static-quality.mjs` (0
// import cycles) and the mobile budget in
// tests/mi1-member-qa-mobile-wiring.test.js both fail if it ever does.

// The LOCALE half of the answer. Spanish resolves to plain `es`, which is the
// tag PR #2122 unified every DATE formatter onto: `4 mar 2026`, `mié, 4 mar`,
// short `4/3/26`. `es-US` would move all three (`4 de mar`, `4/3/2026`), so
// date-only callers keep calling this directly and their output never moves.
export function localeFor(lang) {
  return lang === "es" ? "es" : "en-US";
}

// The CLOCK half. Owner 2026-09-17 decision 16.2: 12-hour everywhere for the
// US local. Plain `es` has a 24-hour hour cycle (17:05), so every formatter
// that renders a time asks for h12 explicitly, through here — the core below
// and the barrel's wrapper around it are the only places the app constructs a
// time-rendering Intl.DateTimeFormat, and tests/i18n-coverage.test.jsx fails
// the build if a call site builds its own.
//
// Why the option and not the locale tag: `es-u-hc-h12` reads better and was
// the first shape of this repair, but WebKit 610 — Safari 14.0 and iOS/iPadOS
// 14.0-14.4, which vite.config.mjs:126 pins as a deliberate support floor for
// this PWA — honours the `hc` extension by rewriting hour symbols in the FINAL
// pattern instead of in the skeleton, so ICU never adds the day-period field:
// 17:05 and 05:05 both render "5:05". Given hourCycle as an OPTION the same
// engine takes its `hour12 == TriState::True` branch, builds the skeleton with
// 'h' and gets "h:mm a" back. WebKit 611 (Safari 14.1) fixed the extension
// path; 610 is still in support, so the option form is the portable one.
// `hourCycle: "h12"` rather than `hour12: true` because h12 is stated outright
// instead of derived from the locale's hour-cycle default, which engines have
// resolved differently (h11 vs h12) for a locale whose default is h23.
export const TWELVE_HOUR_CLOCK = "h12";

// `toLocaleString(locale)` with no options means "date and time" — the six
// bare stamps in the app rely on that — while `new Intl.DateTimeFormat(locale)`
// with no options means date only. Spelling the stamp out keeps this helper's
// no-argument case equal to the former, byte for byte, in both languages.
export const DATE_TIME_STAMP_OPTIONS = Object.freeze({
  year: "numeric", month: "numeric", day: "numeric",
  hour: "numeric", minute: "numeric", second: "numeric",
});

// The plain formatter, exactly as dateTimeFormat built it before the zone-name
// decision was layered on top: the member's locale, the app's 12-hour clock,
// and whatever else the caller asked for. The barrel's dateTimeFormat returns
// THIS object unchanged for every call that does not ask for a long zone name,
// which is every call in the app but the public event detail's.
export function dateTimeFormatCore(lang, options = DATE_TIME_STAMP_OPTIONS) {
  return new Intl.DateTimeFormat(localeFor(lang), { ...options, hourCycle: TWELVE_HOUR_CLOCK });
}

// formatDateTime asks for dateStyle/timeStyle and never for a zone name, so it
// takes the core directly and is byte-identical to the barrel-routed version.
export function formatDateTime(value, lang) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return dateTimeFormatCore(lang, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
