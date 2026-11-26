// Review metadata for the public legal summaries. This is content metadata,
// not route metadata — publicPageMetadata.js stays the SEO source of truth.
//
// LEGAL_CONTENT_LAST_REVIEWED must move forward whenever the substance of any
// legal.* string (either locale) or the landing consent line changes.
// tests/legal-page-claims.test.js pins a fingerprint of those strings against
// this file, so a copy edit without a date bump fails CI rather than shipping
// a stale "last reviewed" claim.
export const LEGAL_CONTENT_LAST_REVIEWED = "2026-11-15";

// The date the published privacy terms took effect, which is not the same fact
// as the maintainers' last pass over the copy. The privacy summary and the
// public deletion-request route both state it once there is one. Union
// Ground has published no privacy policy yet, so there is no effective date
// and the pages state none; never borrow a sibling product's date.
export const PRIVACY_EFFECTIVE_DATE = null;

// sha256 prefix over every legal.* / landing.interestConsent /
// landing.aiDisclosure catalog line in both locales. Recompute (the failing
// test prints instructions) and move the date forward in the same commit.
export const LEGAL_COPY_FINGERPRINT = "13f8885a3bc517e3";
