// Whole counts read in the viewer's language: "1,506 members", not "1506".
// Anything that is not a whole number ("74%", "—", 36.5) passes through
// unchanged, so callers can hand over whatever the tile already shows.
export function formatCount(value, lang = "en") {
  if (!Number.isInteger(value)) return value;
  try {
    return new Intl.NumberFormat(lang, { useGrouping: true }).format(value);
  } catch {
    return String(value);
  }
}
