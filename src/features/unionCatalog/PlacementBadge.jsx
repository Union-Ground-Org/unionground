import { BadgeCheck } from "lucide-react";
import { useLang } from "../../lib/LanguageContext.jsx";

// The one badge for an organization's placement under a catalog parent
// . The state is carried by the visible text; the check
// glyph on "Verified" is decoration. Phase 4a only ever produces
// "self_reported"; Phase 3a feeds "verified" once verification passes.
export function PlacementBadge({ state }) {
  const { t } = useLang();
  if (state === "verified") {
    return <span className="xus-chip xus-chip--on" title={t("unions.verification.verifiedHelp")}>
      <BadgeCheck size={12} aria-hidden="true" />{t("unions.verification.verified")}
      <span className="visually-hidden"> ({t("unions.verification.verifiedHelp")})</span>
    </span>;
  }
  if (state === "self_reported") {
    return <span className="xus-chip xus-chip--note" title={t("unions.verification.selfReportedHelp")}>{t("unions.verification.selfReported")}<span className="visually-hidden"> ({t("unions.verification.selfReportedHelp")})</span></span>;
  }
  return null;
}
