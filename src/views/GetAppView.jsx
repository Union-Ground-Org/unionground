import { useMemo } from "react";
import { BrandMark } from "../components/BrandMark.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import "../lib/i18n/features/getAppStrings.js";
import { appDownloadUrl, getAppPageUrl } from "../lib/appDownloads.js";
import { makeQrMatrix, QR_QUIET_ZONE, qrSvgPath } from "../lib/qrCode.js";

const PHONES = [
  { platform: "ios", titleKey: "getApp.iosTitle" },
  { platform: "android", titleKey: "getApp.androidTitle" },
];

// The page the invitation emails' QR code opens: every way into Union Ground
// for an invited member. A phone app that has no download yet says so instead
// of rendering a dead link (src/lib/appDownloads.js).
export function GetAppView({ origin = window.location.origin, downloads }) {
  const { t } = useLang();
  const pageUrl = getAppPageUrl(origin);
  const matrix = useMemo(() => makeQrMatrix(pageUrl), [pageUrl]);
  const size = matrix.length + QR_QUIET_ZONE * 2;
  return (
    <main className="auth-screen iac-screen">
      <section className="auth-card iac-card gapp-card" aria-labelledby="get-app-title">
        <span className="iac-brand"><BrandMark size={40} /></span>
        <span className="eyebrow">{t("getApp.eyebrow")}</span>
        <h1 id="get-app-title" className="iac-title">{t("getApp.title")}</h1>
        <div className="iac-state">
          <p>{t("getApp.intro")}</p>
        </div>
        <ul className="gapp-list">
          <li className="gapp-item">
            <h2>{t("getApp.webTitle")}</h2>
            <p>{t("getApp.webBody")}</p>
            <a className="iac-action" href="/auth">{t("getApp.webAction")}</a>
          </li>
          {PHONES.map(({ platform, titleKey }) => {
            const href = appDownloadUrl(platform, downloads);
            return (
              <li key={platform} className="gapp-item">
                <h2>{t(titleKey)}</h2>
                {href
                  ? <a className="iac-action" href={href} rel="noopener noreferrer">{t("getApp.appAction")}</a>
                  : <p>{t("getApp.appUnavailable")}</p>}
              </li>
            );
          })}
        </ul>
        <div className="gapp-qr">
          <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={t("getApp.qrLabel")} shapeRendering="crispEdges">
            {/* Pure black/white is required machine-readable QR artwork, not a
                UI color token. The four-module quiet zone is part of it. */}
            <rect width={size} height={size} fill="#fff" />
            <path d={qrSvgPath(matrix)} fill="#000" />
          </svg>
          <p>{t("getApp.qrBody")}</p>
        </div>
        <p className="iac-legal">{t("getApp.noInvitation")} <a href="/request-invite">{t("requestInvite.link")}</a></p>
        <p className="iac-legal"><a href="/privacy">{t("hub.privacy")}</a> · <a href="/terms">{t("hub.terms")}</a></p>
      </section>
    </main>
  );
}
