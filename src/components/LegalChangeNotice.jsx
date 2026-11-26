import { useLang } from "../lib/LanguageContext.jsx";
import { CARD_CLASS } from "./Surfaces.jsx";
import { LEGAL_CHANGELOG_PATH, legalChangeNotice, legalInstrument } from "../lib/legalInstruments.js";
import { recordedLegalAcceptances } from "../lib/legalAcceptance.js";

// D-14: a change marked material in src/lib/legalInstruments.js tells the
// signed-in reader so in the product, and the same state carries
// reacceptanceRequired for the prompt of
// REQ-UG-VERSIONED-TERMS-ACCEPTANCE-20261010. Nothing renders while
// the accepted versions are unknown or current.
export function LegalChangeNotice({ accepted = recordedLegalAcceptances() }) {
  const { t } = useLang();
  const state = legalChangeNotice(accepted);
  if (!state.notice) return null;
  const names = state.instruments
    .map((key) => t(legalInstrument(key).summaryTitleKey))
    .join(", ");
  return (
    <aside className={CARD_CLASS} aria-label={t("legal.changeNotice.label")}>
      <h2>{t("legal.changeNotice.title")}</h2>
      <p>{t("legal.changeNotice.body", { instruments: names })}</p>
      <p><a href={LEGAL_CHANGELOG_PATH}>{t("legal.changeNotice.changelog")}</a></p>
    </aside>
  );
}
