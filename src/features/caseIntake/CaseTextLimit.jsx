import { useLang } from "../../lib/LanguageContext.jsx";
import { formatCount } from "../../lib/formatCount.js";
import "../../lib/i18n/features/caseIntakeStrings.js";

export function CaseTextLimit({ id, count = 0, max, className, pasteHint = false, children }) {
  const { t, lang } = useLang();
  const limit = formatCount(max, lang);
  const nearLimit = count >= Math.ceil(max * 0.8);
  return (
    <small id={id} className={className}>
      {children && <>{children}{" "}</>}
      {nearLimit
        ? t("caseIntake.lengthCount", { count: formatCount(count, lang), max: limit })
        : t("caseIntake.lengthLimit", { max: limit })}
      {pasteHint && <> {t("caseIntake.lengthPasteHelp")}</>}
      <span aria-live="polite">{count >= max ? ` ${t("caseIntake.lengthLimitReached")}` : ""}</span>
    </small>
  );
}
