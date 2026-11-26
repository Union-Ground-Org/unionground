// Where invited people get Union Ground: the website, plus the phone apps once
// a downloadable build exists. The invitation emails and the public /get-app page
// both read this one table.
//
// List a phone app only when anyone with the link can install it and it signs
// in to the Union Ground production backend. The current TestFlight/store
// profiles pin the SAMPLE project (apps/mobile/app.config.ts), so an invited
// member could not sign in with them. Until then, both stay null and every
// surface points phones at the website instead of showing a dead link.
export const APP_DOWNLOADS = Object.freeze({
  ios: null,
  android: null,
});

const APP_STORE_HOSTS = Object.freeze({
  ios: ["apps.apple.com", "testflight.apple.com"],
  android: ["play.google.com"],
});

/** The configured download URL for `platform`, or null. */
export function appDownloadUrl(platform, downloads = APP_DOWNLOADS) {
  const value = downloads?.[platform];
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && APP_STORE_HOSTS[platform]?.includes(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

// Not "/app": the Android app claims https://<host>/app links
// (apps/mobile/app.config.ts), so a phone with a build installed would open
// the app instead of this page.
const GET_APP_PATH = "/get-app";

/** The /get-app page on `origin` — what the invitation QR code opens. */
export function getAppPageUrl(origin) {
  return new URL(GET_APP_PATH, origin).toString();
}
