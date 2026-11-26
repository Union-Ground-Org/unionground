// #9164: the one example table for the organization-name phone rule. Every
// surface that applies the rule answers it the same way: the database proof
// (tests/organization-name-phone-rule-db.test.js), the shared website and API
// rule, the self-serve form, the catalog placement and claim forms, and the
// claim API (tests/organization-name-phone-rule.test.jsx and
// tests/organization-claim-api.test.js). Fictional names only.

// The record's examples: accepted, and still refused as a phone number.
export const ACCEPTED = [
  "Harrow Bay Public Employees Union Local 3307 (2026-11-18)",
  "Harrow Bay Local 3307 2026",
  "Harrow Bay Local 1199 (11/18/2026)",
];
export const PHONE = [
  "Harrow Bay Local 3307 555-201-4477",
  "Harrow Bay (555) 201 4477",
  "Harrow Bay +1 555 201 4477",
];

// [text, holds a phone number]: the record's examples, then the edges.
export const EXAMPLES = [
  ...ACCEPTED.map((name) => [name, false]),
  ...PHONE.map((name) => [name, true]),
  ["Harrow Bay Local 3307 (2026)", false],
  ["Harrow Bay Local 33070 2026", false],
  ["Harrow Bay Local 3307 2026-11-18", false],
  ["Harrow Bay Local 3307 11/18/26", false],
  ["Harrow Bay Local 3307 2026.11.18", false],
  ["Harrow Bay Local 3307 11-18-2026", false],
  ["Harrow Bay 2026-11-18 2026-11-19", false],
  ["Harrow Bay Local 123456", false],
  ["Harrow Bay Local 555 x 1234", false],
  ["Harrow Bay Local 412, 2026", false],
  ["Harrow Bay Local 1234567", true],
  ["Harrow Bay Local 412 2026", true],
  ["Harrow Bay 555 2014", true],
  ["Harrow Bay 555-2014", true],
  ["Harrow Bay 555-201-2020", true],
  ["Harrow Bay (555) 201 2020", true],
  ["Harrow Bay 555.201.4477", true],
  ["Harrow Bay 555/201/4477", true],
  ["Harrow Bay 555_201_4477", true],
  [`Harrow Bay 555${String.fromCodePoint(0x2013)}201${String.fromCodePoint(0x2013)}4477`, true],
  ["Harrow Bay Local 3307-2026", true],
  ["Harrow Bay 1 3307 2026", true],
  ["Harrow Bay Local 3307 2026 555", true],
  ["Harrow Bay Local 3307 2026 (555) 201 4477", true],
  ["Harrow Bay Local 3307 2026-11-18 555 2014", true],
  ["Harrow Bay Local 3307-2026-11-18", true],
  ["Harrow Bay 2026-11-18-555", true],
  ["Harrow Bay Local 3307 2026-13-18", true],
  ["Harrow Bay Local 3307 13/18/2026", true],
  ["Harrow Bay Local 3307 2100", true],
];
