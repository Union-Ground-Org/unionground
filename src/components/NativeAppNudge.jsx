import { useEffect, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { nativeAppHref, smartAppBannerContent, PHONE_MEDIA_QUERY, NATIVE_NUDGE_DISMISSED, APP_STORE_AVAILABLE } from "../lib/nativeAppNudge.js";
import "./NativeAppNudge.css";

export function NativeAppNudge({ enabled = true, selectedHat = "member", pathname, search = "", hash = "", appStoreAvailable = APP_STORE_AVAILABLE }) {
  const { t } = useLang();
  const [phone, setPhone] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(NATIVE_NUDGE_DISMISSED) === "1"; }
    catch { return false; }
  });
  const href = enabled && selectedHat === "member" ? nativeAppHref(pathname, search, hash) : null;
  const bannerContent = phone && !dismissed && href ? smartAppBannerContent(href, undefined, appStoreAvailable) : null;

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia(PHONE_MEDIA_QUERY);
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!bannerContent) return undefined;
    const existing = document.querySelector('meta[name="apple-itunes-app"]');
    const meta = existing || document.createElement("meta");
    const previous = meta.content;
    meta.name = "apple-itunes-app";
    meta.content = bannerContent;
    if (!existing) document.head.append(meta);
    return () => { if (existing) meta.content = previous; else meta.remove(); };
  }, [bannerContent]);

  if (!phone || dismissed || !href) return null;
  return (
    <aside className={`native-app-nudge${pathname?.replace(/\/+$/, "") === "/m" ? " native-app-nudge--home" : ""}`} aria-label={t("nativeApp.label")}>
      <p>{t("nativeApp.installedPrompt")}</p>
      <a href={href}>{t("nativeApp.open")}</a>
      <button type="button" onClick={() => {
        setDismissed(true);
        try { sessionStorage.setItem(NATIVE_NUDGE_DISMISSED, "1"); } catch { /* Dismiss still works without storage. */ }
      }}>{t("nativeApp.stay")}</button>
    </aside>
  );
}
