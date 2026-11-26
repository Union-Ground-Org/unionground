import { BadgeCheck } from "lucide-react";
import { ATTRIBUTION_NOTICE, BRAND, officialServiceMarkShown } from "../lib/brand.js";
import { useLang } from "../lib/LanguageContext.jsx";

// How a person tells who is behind the server in front of them: the
// "Official Union Ground service" badge (official build on an official host
// only), the link to the /operator page, and the attribution and source-code
// line the AGPL and the NOTICE section 7 term require on about and legal
// screens.

export function OfficialServiceBadge({ hostname }) {
  const { t } = useLang();
  if (!officialServiceMarkShown(hostname)) return null;
  return (
    <p className="official-service-badge">
      <BadgeCheck size={16} aria-hidden="true" />
      <span>{t("operator.officialBadge")}</span>
    </p>
  );
}

export function OperatorLink({ className }) {
  const { t } = useLang();
  return <a className={className} href="/operator">{t("operator.link")}</a>;
}

// NOTICE (b): "Based on Union Ground (https://unionground.org)" stays verbatim
// and legible in every build, beside the link to this build's source code.
export function SourceAttribution() {
  const { t } = useLang();
  return (
    <p className="source-attribution">
      <span className="source-attribution__notice">{ATTRIBUTION_NOTICE}</span>
      {" · "}
      <a href={BRAND.sourceCodeUrl} rel="noreferrer">{t("source.link")}</a>
    </p>
  );
}
