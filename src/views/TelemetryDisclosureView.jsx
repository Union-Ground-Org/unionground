import { PublicDocumentShell } from "../components/PublicDocumentShell.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { telemetry, AI_DISCLOSURE_CLAIMS } from "../lib/telemetryDisclosure.js";
import "../lib/i18n/features/subprocessorsStrings.js";
import "../lib/i18n/features/telemetryStrings.js";

export function TelemetryDisclosureView() {
  const { t } = useLang();
  const sections = ["vendors", "inventory", "cookies", "ai"].map((id) => ({ id, heading: t(`telemetry.${id}`) }));
  return <PublicDocumentShell eyebrow="Union Ground" title={t("telemetry.title")} intro={t("telemetry.intro")}
    notice={`${t("subprocessors.status")} ${t("subprocessors.date")}: ${telemetry.reviewed}.`} sections={sections}>
    <section id="vendors"><h2>{t("telemetry.vendors")}</h2>
      <p>{t("telemetry.analytics")}</p><p>{t("telemetry.diagnostics")}</p><p>{t("telemetry.relay")}</p><p>{t("telemetry.optout")}</p>
      <a href="/subprocessors">{t("telemetry.register")}</a>
    </section>
    <section id="inventory"><h2>{t("telemetry.inventory")}</h2><p>{t("telemetry.storageNote")}</p>
      {telemetry.storage.map((row) => <section key={row.id}>
        <h3>{row.storage}</h3>
        <ul>{row.keys.map((key) => <li key={key} style={{ overflowWrap: "anywhere" }}><code>{key}</code></li>)}</ul>
        <p>{t(`telemetry.storage.${row.id.replaceAll("-", "_")}.purpose`)}</p>
      </section>)}
    </section>
    <section id="cookies"><h2>{t("telemetry.cookies")}</h2><p>{t("telemetry.cookieNote")}</p>
      <ul>{telemetry.cookies.map((row, index) => <li key={row.key} style={{ overflowWrap: "anywhere" }}><code>{row.key}</code>: {t(row.purpose ? `telemetry.cookie.${index}.purpose` : "telemetry.cookiePurpose")}</li>)}</ul>
    </section>
    <section id="ai"><h2>{t("telemetry.ai")}</h2><p>{t("telemetry.attribution")}</p>
      {AI_DISCLOSURE_CLAIMS.map((key) => <p key={key}>{t(`legal.aiDisclosure.${key}.body`)}</p>)}
    </section>
  </PublicDocumentShell>;
}
