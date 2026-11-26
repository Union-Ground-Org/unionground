// One source of the operative legal instruments behind the five published
// summaries: their routes, their versions, their effective dates, and whether
// a published change was material. The web pages (src/views/LegalView.jsx,
// src/components/LegalChangeNotice.jsx) and the native legal reader
// (apps/mobile/src/lib/legalDocuments.ts) both read this module, so an
// instrument's version cannot differ between platforms.
//
// (statement retained at
// 20261010-owner-data-policy-decisions/statement.md):
//   D-13 (a) layered: the five summary routes stay and each links its
//        operative instrument at a versioned route.
//   D-14 (a) each instrument carries a version and an effective date, a public
//        changelog lists every change, and material changes trigger in-product
//        notice and re-acceptance.
//   D-08 (a) versioned clickwrap at invitation acceptance and at first sign-in
//        after a material change; until it ships the pack is not published as
//        operative. The prompt itself is
//        REQ-UG-VERSIONED-TERMS-ACCEPTANCE-20261010; this module is
//        the version source and the material flag that record consumes.
//
// This edition does not publish an operator's operative instruments. Every
// instrument keeps its version register and change history (the database
// acceptance validator pins the same versions), but none is operative: there
// is no effective date, each route says it is not in effect, and the text
// section says the text is not published yet. An operator completes and
// publishes its own text before any instrument takes effect.

// The date of the 1.0.0 entry in the version register.
const REGISTER_1_0_0_DATE = "2026-10-17";

export const LEGAL_CHANGELOG_PATH = "/legal/changelog";

// The five summary routes of D-13, each with the instrument behind it. The
// route is stable and the version is published on it and in the changelog: a
// per-version URL would publish a version number over text that has not been
// versioned yet, and the changelog is the version history.
// Version 1.0.0 of every instrument's register. Material: every account is
// asked once.
const FIRST_OPERATIVE = Object.freeze({
  version: "1.0.0",
  date: REGISTER_1_0_0_DATE,
  material: true,
  noteKey: "legal.changelog.note.firstOperative",
});

// [titleKey, bodyKey] pairs, in reading order, for the catalogue sections an
// instrument route renders: the statement that the text is not published here.
const UNPUBLISHED_TEXT = [["legal.instrument.text.title", "legal.instrument.text.body"]];

// The five summary routes of D-13, each with the instrument behind it. The
// route is stable and the version is published on it and in the changelog,
// which is the version history.
export const LEGAL_INSTRUMENTS = Object.freeze([
  instrument("privacy-policy", "privacy", "/privacy", "/legal/privacy", "legal.privacy.title", "Privacy", UNPUBLISHED_TEXT, [
    FIRST_OPERATIVE,
    // Disclosure-only correction of existing collection and its existing
    // switch; no new collection, purpose, recipient or control. Nonmaterial:
    // earlier 1.0.0 acceptances stay valid, while new acceptances name 1.0.1.
    { version: "1.0.1", date: "2026-10-18", material: false, noteKey: "legal.changelog.note.analyticsClarification" },
    // Functional authentication storage gains per-flow verifier slots and an
    // index; purpose, recipients and controls are unchanged. Nonmaterial.
    { version: "1.0.2", date: "2026-10-26", material: false, noteKey: "legal.changelog.note.pkceStorage" },
    { version: "1.1.0", date: "2026-10-27", material: true, noteKey: "legal.changelog.note.compassTraining" },
    //  (MAIN 119 ruling, October 28): PostHog product analytics on the
    // member product, on by default, where 1.1.0 excluded authenticated
    // sessions. Material: every 1.1.0 acceptance is asked again.
    { version: "1.2.0", date: "2026-10-28", material: true, noteKey: "legal.changelog.note.memberProductAnalytics" },
    // New public-page collection is disclosed before its separate activation.
    { version: "1.2.1", date: "2026-10-29", material: true, noteKey: "legal.changelog.note.publicPageHeatmaps" },
    { version: "1.3.0", date: "2026-10-29", material: true, noteKey: "legal.changelog.note.platformAnnouncements" },
    // A device-only menu pin key joins the existing navigation-ranking
    // storage; purpose, recipients and controls are unchanged. Nonmaterial.
    { version: "1.3.1", date: "2026-10-30", material: false, noteKey: "legal.changelog.note.navigationPins" },
    // REQ-UG-OFFICER-MEMBER-ROSTER-AND-EXPORT-20261030: officers may
    // export the member list they already see, within the existing chapter
    // and role limits; no new collection, recipient or purpose. Nonmaterial.
    { version: "1.3.2", date: "2026-10-30", material: false, noteKey: "legal.changelog.note.officerRosterExport" },
    // Optional chart pictures use the existing explicit export/share boundary.
    { version: "1.3.3", date: "2026-11-01", material: false, noteKey: "legal.changelog.note.nativePulseCharts" },
      { version: "1.4.0", date: "2026-11-15", material: true, noteKey: "legal.changelog.note.release.20261113125500.privacy-policy" },
    ]),
  // (about 7:20 PM ET): Union Ground is for
  // adults 18 and over, replacing the D-03 B band. The rule changes who may
  // hold an account, so it is material: an account that accepted 0.1.0 is asked
  // again, with the 18-or-older attestation, at its next sign-in.
  // (about 12:50 PM ET) narrows it: 18 and
  // over only in the app-store age-law states (src/lib/residenceRegions.js),
  // the D-03 B band everywhere else, and the person's state is asked and
  // recorded. Material again, so every account answers at its next sign-in.
  instrument("terms-of-use", "terms", "/terms", "/legal/terms", "legal.terms.title", "Terms of use", UNPUBLISHED_TEXT, [
    { version: "0.2.0", date: "2026-10-12", material: true, noteKey: "legal.changelog.note.adultsOnly" },
    { version: "0.3.0", date: "2026-10-16", material: true, noteKey: "legal.changelog.note.appStoreStates" },
    FIRST_OPERATIVE,
    // Clarifies the existing invitation-only free pilot; no new commercial
    // obligation and no change to the last material version.
    { version: "1.0.1", date: "2026-10-23", material: false, noteKey: "legal.changelog.note.freePilotClarification" },
    { version: "1.1.0", date: "2026-10-27", material: true, noteKey: "legal.changelog.note.compassTraining" },
      { version: "1.1.1", date: "2026-11-15", material: false, noteKey: "legal.changelog.note.release.20261113125500.terms-of-use" },
    ]),
  instrument("accessibility-statement", "accessibility", "/accessibility", "/legal/accessibility", "legal.accessibility.title", "Accessibility", UNPUBLISHED_TEXT, [
    FIRST_OPERATIVE,
  ]),
  instrument("ai-disclosure", "aiDisclosure", "/ai-disclosure", "/legal/ai-disclosure", "legal.aiDisclosure.title", "How the Guide uses AI", UNPUBLISHED_TEXT, [
    FIRST_OPERATIVE,
    { version: "1.1.0", date: "2026-10-27", material: true, noteKey: "legal.changelog.note.compassTraining" },
      { version: "1.1.1", date: "2026-11-15", material: false, noteKey: "legal.changelog.note.release.20261113125500.ai-disclosure" },
    ]),
  instrument("retention-schedule", "retention", "/retention", "/legal/retention", "legal.retention.title", "Data retention schedule", UNPUBLISHED_TEXT, [
    FIRST_OPERATIVE,
    { version: "1.1.0", date: "2026-10-27", material: true, noteKey: "legal.changelog.note.compassTraining" },
  ]),
]);

// Every instrument starts at the same first version: that change published the
// register, the routes and the change history, not a text. `material: false`
// because there is no earlier version anyone could have accepted, so nothing
// to re-accept. Later changes are listed oldest first and the newest one is
// the version in force. englishName is the public-metadata name, not display
// copy — the pages render summaryTitleKey through the catalogue in both locales.
function instrument(key, summaryPage, summaryPath, path, summaryTitleKey, englishName, sections, changes = []) {
  const changelog = [
    { version: "0.1.0", date: "2026-10-10", material: false, noteKey: "legal.changelog.note.registered" },
    ...changes,
  ].map((change) => Object.freeze({ ...change }));
  return Object.freeze({
    key,
    summaryPage,
    summaryPath,
    path,
    summaryTitleKey,
    englishName,
    version: changelog.at(-1).version,
    // No instrument is operative in this edition (see the top of this file).
    effectiveDate: null,
    status: "pending-review",
    sections: Object.freeze(sections.map((pair) => Object.freeze([...pair]))),
    changelog: Object.freeze(changelog),
  });
}

export function legalInstrument(key) {
  return LEGAL_INSTRUMENTS.find((entry) => entry.key === key) || null;
}

export function legalInstrumentForSummary(summaryPage) {
  return LEGAL_INSTRUMENTS.find((entry) => entry.summaryPage === summaryPage) || null;
}

export const LEGAL_INSTRUMENT_PATHS = Object.freeze(LEGAL_INSTRUMENTS.map((entry) => entry.path));

// key -> version in force. The acceptance record stores the version it showed
// from this map, so a recorded acceptance names a version that existed.
export function currentLegalVersions(instruments = LEGAL_INSTRUMENTS) {
  return Object.fromEntries(instruments.map((entry) => [entry.key, entry.version]));
}

// Every published change, newest first, flattened for the changelog route.
export function legalChangelog(instruments = LEGAL_INSTRUMENTS) {
  return instruments
    .flatMap((entry) => entry.changelog.map((change) => ({ ...change, instrument: entry })))
    .sort((left, right) => (left.date === right.date ? compareLegalVersions(right.version, left.version) : (left.date < right.date ? 1 : -1)));
}

export function compareLegalVersions(left, right) {
  const parts = (value) => String(value).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

// The newest version of an instrument whose publication was marked material,
// or null when no change has been material yet.
export function latestMaterialLegalVersion(entry) {
  return entry.changelog
    .filter((change) => change.material)
    .map((change) => change.version)
    .sort(compareLegalVersions)
    .at(-1) || null;
}

// The in-product notice and the re-acceptance prompt both read this.
// `accepted` is the versions recorded for the signed-in person
// ({ instrumentKey: version }); null or undefined means nothing is recorded —
// the acceptance store ships with
// REQ-UG-VERSIONED-TERMS-ACCEPTANCE-20261010 — and nothing is
// claimed about the reader until it is.
export function legalChangeNotice(accepted, instruments = LEGAL_INSTRUMENTS) {
  if (!accepted) return { notice: false, reacceptanceRequired: false, instruments: [] };
  const behind = instruments.filter((entry) => {
    const required = latestMaterialLegalVersion(entry);
    if (!required) return false;
    const held = accepted[entry.key];
    return !held || compareLegalVersions(held, required) < 0;
  });
  return {
    notice: behind.length > 0,
    reacceptanceRequired: behind.length > 0,
    instruments: behind.map((entry) => entry.key),
  };
}
