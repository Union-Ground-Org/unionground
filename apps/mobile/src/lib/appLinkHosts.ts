// The hosts whose https links the app accepts as universal / App Links. This
// mirrors config/mobile-app-links.json, which app.config.ts registers with the
// platforms (appLinkHosts.test.ts pins the two together; Metro cannot bundle
// files outside src/, so the app cannot read that config itself). Links stay
// off until Union Ground has a verified domain, and a sibling product's host
// is never accepted.
export const APP_LINK_HOSTS: readonly string[] = Object.freeze([]);
