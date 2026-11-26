import { LANDING_CHROME_COPYSpanish } from "./locales/es/namespaces/landingChromeCopy.js";
// Short labels for the public landing's lower page
// (UB-UG-LANDING-LOWER-PAGE-RHYTHM-20261107): the footer's link
// group names, the Follow block's words
// (REQ-UG-PUBLIC-SITE-FOLLOW-US-SOCIAL-ACCOUNTS-20261112: `followUs`
// and `followOn` are the words the phone apps' sign-in screen shows too;
// `followRow`
// is the heading of the website footer's own row, since November 17, 2026) and the company card's eyebrow, which used to read as the
// internal "Company identity". Labels, not sentences; web only, outside the
// src/lib/i18n.js barrel, which changes only in a legal release.
export const LANDING_CHROME_COPY = Object.freeze({
  en: Object.freeze({
    companyEyebrow: "The company",
    footerCompany: "Company",
    footerProduct: "Product",
    footerLegal: "Privacy and legal",
    footerContact: "Email us",
    followUs: "Follow us",
    followRow: "Follow Union Ground",
    followOn: "Union Ground on {network}",
    siteNav: "Site",
    menu: "Menu",
  }),
  get es() { return LANDING_CHROME_COPYSpanish; },
});

export function landingChrome(lang) {
  return LANDING_CHROME_COPY[lang] ?? LANDING_CHROME_COPY.en;
}
