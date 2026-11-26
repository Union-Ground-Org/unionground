import { PublicDocumentShell } from "../components/PublicDocumentShell.jsx";
import { OfficialServiceBadge } from "../components/ServiceIdentity.jsx";
import { BRAND, officialServiceMarkShown } from "../lib/brand.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { runtimeOperator } from "../lib/operator.js";
import { usePageMetadata } from "../lib/pageMetadata.js";

// "Who runs this server" (/operator). Anyone may run a copy of this software;
// this page names the operator this server reports (OPERATOR_* settings,
// served by /api/runtime-config) and says plainly that it is not Union Ground
// LLC unless this is the official service on one of its own hosts.
export function OperatorView({ operator = runtimeOperator(), hostname }) {
  const { t } = useLang();
  usePageMetadata("/operator");
  const official = officialServiceMarkShown(hostname);
  const sections = [
    { id: "operator-details", heading: t("operator.detailsTitle") },
    { id: "operator-source", heading: t("operator.sourceTitle") },
  ];

  return (
    <PublicDocumentShell
      eyebrow={t("operator.eyebrow")}
      title={t("operator.title")}
      intro={t("operator.intro")}
      sections={sections}
    >
      <OfficialServiceBadge hostname={hostname} />
      <section id="operator-details" aria-labelledby="operator-details-title">
        <h2 id="operator-details-title">{t("operator.detailsTitle")}</h2>
        {operator ? (
          <>
            <p className="operator-page__statement">
              {official ? t("operator.official") : t("operator.notOfficial", { operator: operator.name })}
            </p>
            <dl className="company-page__identity">
              <div><dt>{t("operator.runBy")}</dt><dd>{operator.name}</dd></div>
              <div><dt>{t("operator.contact")}</dt><dd><a href={`mailto:${operator.contactEmail}`}>{operator.contactEmail}</a></dd></div>
              {operator.url && <div><dt>{t("operator.website")}</dt><dd><a href={operator.url} rel="noreferrer">{operator.url}</a></dd></div>}
              {operator.jurisdiction && <div><dt>{t("operator.jurisdiction")}</dt><dd>{operator.jurisdiction}</dd></div>}
            </dl>
          </>
        ) : (
          <p className="operator-page__statement operator-page__statement--unset" role="note">{t("operator.unset")}</p>
        )}
      </section>
      <section id="operator-source" aria-labelledby="operator-source-title">
        <h2 id="operator-source-title">{t("operator.sourceTitle")}</h2>
        <p>{t("source.license")} <a href={BRAND.sourceCodeUrl} rel="noreferrer">{BRAND.sourceCodeUrl}</a></p>
        <p>{t("source.operatorNote")}</p>
      </section>
    </PublicDocumentShell>
  );
}
