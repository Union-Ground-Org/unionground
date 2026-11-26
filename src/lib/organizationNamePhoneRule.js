// BUG-UG-ORGANIZATION-NAME-WITH-A-LOCAL-NUMBER-AND-A-DATE-REFUSED-AS-A-PHONE-NUMBER-20261118 (#9164)
//
// The one phone-number rule for organization names, cities and catalog
// names, shared by the self-serve organization form (src/lib/openSignup.js),
// the catalog placement and claim forms (src/features/unionCatalog) and the
// claim API (api/_lib/organizationClaim.js). The database applies the same
// rule (supabase/migrations/20261118200200_organization_name_phone_rule_dates_and_years.sql,
// whose header says it in plain words); tests/helpers/organizationNamePhoneExamples.js
// holds every surface to the same answer.
//
// A text holds a phone number when it has seven or more digits in a row once
// spaces, brackets, dots, slashes, plus signs, underscores and dashes between
// them are dropped. Read apart first, so they never join the digits beside
// them: a calendar date written with dashes, slashes or dots (year-month-day,
// or month-day-year with a two or four digit year), and a year from 1900 to
// 2099 right after a number of four or five digits, after a space or "(".
//
// `anyScriptDigits` counts digits of every script, as the catalog forms and
// the claim API always have; without it only 0-9 count, as the self-serve
// form and the database do. Dates and years are only ever read in 0-9, so a
// digit of another script never loosens the rule.
const SEPARATOR_CHARS = String.raw`\s().+/_\u2010-\u2015\u2212\uff0d-`;
const SEPARATORS = new RegExp(`[${SEPARATOR_CHARS}]`, "gu");

function rule(digit) {
  return {
    date: new RegExp(`(^|[^${digit}./-]|[^${digit}][./-])((?:19|20)[0-9]{2}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12][0-9]|3[01])`
      + `|(?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12][0-9]|3[01])[-/.](?:(?:19|20)[0-9]{2}|[0-9]{2}))(?![-/.]?[${digit}])`, "gu"),
    year: new RegExp(`(^|[^${digit}${SEPARATOR_CHARS}])([${SEPARATOR_CHARS}]*[0-9]{4,5})(\\s+|\\s*\\()(?:19|20)[0-9]{2}(?![${SEPARATOR_CHARS}]*[${digit}])`, "gu"),
    run: new RegExp(`[${digit}]{7,}`, "u"),
  };
}
const ASCII = rule("0-9");
const ANY_SCRIPT = rule(String.raw`\p{Nd}`);

export function holdsPhoneNumber(text, { anyScriptDigits = false } = {}) {
  const { date, year, run } = anyScriptDigits ? ANY_SCRIPT : ASCII;
  return run.test(text.replace(date, "$1|").replace(year, "$1$2|").replace(SEPARATORS, ""));
}
