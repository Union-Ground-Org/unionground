// Locale is evidence, never a country-to-language/timezone inference.
// Assigned ISO codes are pinned in config/catalog-iso-codes.json (iso-codes).
import { readFileSync } from "node:fs";

const codes = JSON.parse(readFileSync(new URL("../../config/catalog-iso-codes.json", import.meta.url), "utf8"));
const countries = new Set(codes.countries);
const subdivisions = new Set(codes.subdivisions);
const timezones = new Set(JSON.parse(readFileSync(new URL("../../config/catalog-iana-zones.json", import.meta.url), "utf8")).zones);
export const LOCALE_FIELDS = Object.freeze(["country", "subdivision", "postal_code", "language", "timezone"]);
export const LOCALE_COLUMNS = Object.freeze([...LOCALE_FIELDS, "locale_unknowns"]);
export const LOCALE_TABLES = Object.freeze([
  "organizations", "edges", "subunits", "seat_outlines", "contacts", "documents", "research_facts", "research_categories",
]);
export const UNKNOWN_REASONS = Object.freeze(["not_published", "not_applicable", "unconfirmed", "legacy_not_recorded"]);

export function validCountry(value) { return countries.has(value); }
export function validSubdivision(value, country) { return subdivisions.has(value) && value.startsWith(`${country}-`); }
export function validLanguage(value) {
  if (typeof value !== "string" || value.length > 80 || !/^(?:[A-Za-z]{2,3}(?:-[A-Za-z]{3}){0,3}|[A-Za-z]{4}|[A-Za-z]{5,8})(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?(?:-(?:[A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*(?:-[0-9A-WY-Za-wy-z](?:-[A-Za-z0-9]{2,8})+)*(?:-x(?:-[A-Za-z0-9]{1,8})+)?$/.test(value)) return false;
  try { return Intl.getCanonicalLocales(value).length === 1; } catch { return false; }
}
export function validTimezone(value) {
  if (typeof value !== "string" || !timezones.has(value) || value.length > 100 || !/^(?:[A-Za-z_+-]+\/)+[A-Za-z0-9_+/-]+$|^UTC$/.test(value)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; }
}

export function hasLocale(row) { return LOCALE_COLUMNS.some((column) => Object.hasOwn(row, column)); }

// Used only at the SQL materialization boundary. Legacy artifacts and their
// hashes/staging bytes stay untouched; omitted country on those means US.
export function legacyLocale() {
  return { country: "US", subdivision: null, postal_code: null, language: null, timezone: null,
    locale_unknowns: Object.fromEntries(LOCALE_FIELDS.slice(1).map((field) => [field, "legacy_not_recorded"])) };
}

export function localeViolations(row) {
  if (!hasLocale(row)) return [];
  const out = [];
  for (const column of LOCALE_COLUMNS) if (!Object.hasOwn(row, column)) out.push(`${column} is missing from locale bundle`);
  if (row.country !== null && !validCountry(row.country)) out.push("country is not an assigned ISO 3166-1 code");
  if (row.subdivision !== null && !validSubdivision(row.subdivision, row.country)) out.push("subdivision is not an assigned ISO 3166-2 code in country");
  if (row.postal_code !== null && (typeof row.postal_code !== "string" || !/^[\p{L}\p{N}][\p{L}\p{N} -]{0,31}$/u.test(row.postal_code))) out.push("postal_code is not bounded postal text");
  if (row.language !== null && !validLanguage(row.language)) out.push("language is not a BCP 47 tag");
  if (row.timezone !== null && !validTimezone(row.timezone)) out.push("timezone is not an IANA zone");
  const reasons = row.locale_unknowns;
  if (!reasons || typeof reasons !== "object" || Array.isArray(reasons)) out.push("locale_unknowns is not an object");
  else {
    for (const [field, reason] of Object.entries(reasons)) {
      if (!LOCALE_FIELDS.includes(field) || row[field] !== null || !UNKNOWN_REASONS.includes(reason)) out.push("locale_unknowns carries an invalid field or reason");
    }
    for (const field of LOCALE_FIELDS) if (row[field] === null && !Object.hasOwn(reasons, field)) out.push(`${field} is unknown without a reason`);
  }
  return out;
}

// The research v1 country field predates the full bundle. Retain it and
// explicitly mark the other missing evidence, rather than inventing values.
export function researchLocale(row) {
  if (!hasLocale(row)) return {};
  const locale = Object.fromEntries(LOCALE_FIELDS.map((field) => [field, row[field] ?? null]));
  locale.locale_unknowns = row.locale_unknowns ?? Object.fromEntries(LOCALE_FIELDS.filter((field) => locale[field] === null).map((field) => [field, "legacy_not_recorded"]));
  const problems = localeViolations(locale);
  if (problems.length) throw new Error(`invalid research locale: ${problems.join("; ")}`);
  return locale;
}
