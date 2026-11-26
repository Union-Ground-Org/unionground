// TEST-UG-SMALL-NEW-ORGANIZATION-FIXTURE-AND-WEB-ROUTE-JOURNEYS-20261111
// (#8318): React's duplicate-key warning fails a test (tests/helpers/
// browser-setup.js). Two children with one key is how the forms page showed
// two editors at once (#8212). These files already raised the warning on Main
// when the check arrived; they may keep raising it until fixed. The list may
// only shrink: fix the duplicate keys, delete the line, and lower the ceiling
// in tests/duplicate-key-offenders.test.js. Never add a file.
export const DUPLICATE_KEY_OFFENDERS = Object.freeze([
  "tests/admin-overview-goals-activity.test.jsx",
  "tests/connection-suggestions-ui.test.jsx",
  "tests/mention-picker-namesakes.test.jsx",
  "tests/partner-offices-ui.test.jsx",
]);
