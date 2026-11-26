// TEST-UG-SMALL-NEW-ORGANIZATION-FIXTURE-AND-WEB-ROUTE-JOURNEYS-20261111
// (#8318): what tests/helpers/browser-setup.js does after a test that made
// React warn about two children with the same key. Report mode only records:
// with a report path, the file is appended to it and the test still fails
// unless the file is on the offender list. No setting turns the failure off,
// so CI cannot pass a duplicate key by setting UG_DUPLICATE_KEY_REPORT.
export const DUPLICATE_KEY_WARNING = /Encountered two children with the same key/;

export function settleDuplicateKeyWarnings({ warnings, file, testName, offenders, reportPath = "", append }) {
  if (warnings.length === 0) return;
  if (reportPath) append(reportPath, `${file}\n`);
  if (offenders.has(file)) return;
  throw new Error(`React warned about two children with the same key in ${file} (${testName}). `
    + `Give each child its own key; a shared key can leave two copies on screen (#8212).\n${warnings[0]}`);
}
