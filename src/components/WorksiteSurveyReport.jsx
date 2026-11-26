import { useEffect, useRef, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import "./workplace-roster.css";

function surveyAnswerLabel(value) {
  if (typeof value === "string") return value;
  return value == null ? "—" : JSON.stringify(value);
}

export function WorksiteSurveyReport({ surveyId, client }) {
  const { t } = useLang();
  const [report, setReport] = useState(null);
  const [state, setState] = useState("");
  const active = useRef(0);
  useEffect(() => {
    active.current += 1;
    setReport(null);
    setState("");
    return () => { active.current += 1; };
  }, [surveyId, client]);
  async function load() {
    const ticket = ++active.current;
    setState("loading");
    setReport(null);
    try {
      const { data, error } = await client.rpc("get_organization_survey_worksites", { p_survey_id: surveyId });
      if (error || !Array.isArray(data?.groups)) throw error || new Error("report");
      if (active.current === ticket) { setReport(data); setState(""); }
    } catch (error) {
      if (active.current === ticket) setState(error?.code === "42501" ? "adminOnly" : "error");
    }
  }
  return <section className="eng-report worksite-report" aria-label={t("roster.surveyTitle")}>
    <button type="button" className="eng-btn eng-btn--quiet" onClick={load} disabled={state === "loading"}>{t("roster.surveyTitle")}</button>
    {state && <p role={state === "error" ? "alert" : "status"}>{t(`roster.survey.${state}`)}</p>}
    {report && <>
      <p>{t("roster.surveyHelp", { minimum: report.privacyMinResponses })}</p>
      {report.releaseChanged ? <p role="status">{t("roster.surveyChanged")}</p> : <>
        {report.withheld && <p>{t("roster.surveyHidden")}</p>}
        {report.groups.length === 0 && <p>{t("roster.surveyEmpty")}</p>}
      </>}
      {report.groups.map((group) => <div key={group.worksite}>
        <h4>{group.worksite} · {t("roster.responses", { count: group.responseCount })}</h4>
        {group.questions.map((question) => <p key={question.id}><strong>{question.label}: </strong>{question.available
          ? question.distribution.map((cell) => `${surveyAnswerLabel(cell.value)}: ${cell.count}`).join(" · ") || t("roster.noAnswers")
          : t("roster.answersHidden")}</p>)}
      </div>)}
    </>}
  </section>;
}
