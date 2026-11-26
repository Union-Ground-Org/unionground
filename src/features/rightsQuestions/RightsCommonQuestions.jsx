import { useId } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import "./rights-questions.css";
import "../../lib/i18n/features/rightsQuestionsStrings.js";

// Common questions on Know your rights
// (REQ-UG-RIGHTS-CONTRACT-AND-LIBRARY-CONTENT-20261030, findings 100
// and 117): card-signing protections, a supervisor asking about cards, who
// sees a signed card, part-timers and the card goal, and where international
// members take visa questions. General information with a referral line; the
// statements of law cite the agency page they rest on.
const RIGHTS_QUESTIONS = Object.freeze([
  { key: "cardProtection", sources: [["sourceNlrbInterfering", "https://www.nlrb.gov/about-nlrb/rights-we-protect/the-law/interfering-with-employee-rights-section-7-8a1"]] },
  { key: "supervisorAsks", sources: [["sourceNlrbInterfering", "https://www.nlrb.gov/about-nlrb/rights-we-protect/the-law/interfering-with-employee-rights-section-7-8a1"]] },
  { key: "whoSees", sources: [["sourceNlrbForm", "https://www.nlrb.gov/about-nlrb/rights-we-protect/the-law/employees/your-right-to-form-a-union"]] },
  { key: "partTime", sources: [] },
  { key: "visa", sources: [["sourceStudyInTheStates", "https://studyinthestates.dhs.gov/"]] },
]);

export function RightsCommonQuestions({ onAskSteward = null }) {
  const { t } = useLang();
  const titleId = useId();
  return <section className="rights-questions" aria-labelledby={titleId}>
    <h2 id={titleId}>{t("rightsQuestions.title")}</h2>
    <p className="rights-questions__sub">{t("rightsQuestions.sub")}</p>
    {RIGHTS_QUESTIONS.map(({ key, sources }) => <details key={key} className="rights-questions__item">
      <summary>{t(`rightsQuestions.${key}.q`)}</summary>
      <p>{t(`rightsQuestions.${key}.a`)}</p>
      {sources.map(([label, href]) => <p key={href} className="rights-questions__source">
        {t("rightsQuestions.source")}: <a href={href} target="_blank" rel="noopener noreferrer">{t(`rightsQuestions.${label}`)}</a>
      </p>)}
    </details>)}
    <p className="rights-questions__referral">{t("rightsQuestions.referral")}</p>
    {onAskSteward && <button type="button" className="outline-pill" onClick={onAskSteward}>{t("rightsQuestions.askSteward")}</button>}
  </section>;
}
