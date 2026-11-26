import support from "../../config/mobile-web-support.json";

// Only destinations implemented by apps/mobile/src/lib/routes.ts. Never pass
// browser queries, hashes, authentication codes, staff hats or tenant choices.
const nativePaths = Object.freeze({
  "/m": "home",
  "/m/messages": "messages",
  "/m/events": "feature/events",
  "/m/rights": "feature/rights",
  "/m/cases": "feature/cases",
});

export const NATIVE_NUDGE_DISMISSED = "ug:native-nudge-dismissed:v1";
export const PHONE_MEDIA_QUERY = `(max-width: ${support.phoneMaxWidth}px)`;
export const APP_STORE_AVAILABLE = support.iosAppStoreAvailable === true;

export function nativeAppHref(pathname, search = "", hash = "") {
  if (search || hash || typeof pathname !== "string") return null;
  const path = pathname.replace(/\/+$/, "");
  const nativePath = Object.hasOwn(nativePaths, path) ? nativePaths[path] : null;
  return nativePath ? `unionground://${nativePath}` : null;
}

export function smartAppBannerContent(href = null, appStoreId = support.iosAppStoreId, available = APP_STORE_AVAILABLE) {
  if (!available) return null;
  if (!/^\d{6,12}$/.test(String(appStoreId ?? ""))) return null;
  return `app-id=${appStoreId}${href ? `, app-argument=${href}` : ""}`;
}
