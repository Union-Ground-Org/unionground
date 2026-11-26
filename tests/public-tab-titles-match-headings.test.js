// @vitest-environment node
// #9540 (C-12): a public page's browser tab names the page the way its own
// first heading does. The Privacy and Terms pages said "Privacy summary" and
// "Terms summary" over the headings "Privacy" and "Terms of use", and /verify
// said "ballot receipt" over "Verify a vote receipt". The headings are read
// from the same catalogue keys the pages render (LegalView's PAGES table and
// VerifyReceiptView's h1), so the two cannot drift apart again.
import { describe, expect, it } from "vitest";
import { t } from "../src/lib/i18n/allLanguages.js";
import { metadataForPath } from "../src/lib/publicPageMetadata.js";

const PAGES = [
  ["/privacy", "legal.privacy.title"],
  ["/terms", "legal.terms.title"],
  ["/verify", "verify.title"],
];

describe.each(["en", "es"])("public tab titles (%s)", (lang) => {
  it.each(PAGES)("titles %s with its own heading", (path, headingKey) => {
    expect(metadataForPath(path, lang).title).toBe(`${t(lang, headingKey)} | Union Ground`);
  });
});
