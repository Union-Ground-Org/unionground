import { legalInstrument } from "./legalInstruments.js";

// New signup links record the terms-of-use version on the screen. Links
// already issued stored the legal review date instead. A date maps to the
// newest terms changelog entry whose date is strictly earlier than the
// stored day. The same calendar day can carry a later terms release, and
// that later version is not what the in-flight link showed. A date earlier
// than every terms version keeps the stored token value so the link still
// confirms. A privacy-only release does not change the terms version, so
// it does not change either receipt.
export function displayedTermsVersion(terms = legalInstrument("terms-of-use")) {
  return terms.version;
}

export function signupTermsReceipt(stored, terms = legalInstrument("terms-of-use")) {
  const value = String(stored || "");
  if (/^\d+\.\d+\.\d+$/.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const inForce = terms.changelog.filter((change) => change.date < value);
    return inForce.at(-1)?.version || value;
  }
  return value;
}
