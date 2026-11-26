import { BusyInput, BusySelect, BusyTextarea } from "../../components/BusyControls.jsx";
import { useEffect, useId, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { dateTimeFormat } from "../../lib/i18n.js";
import { CASE_TYPES } from "../../lib/caseRowLine.js";
import "./case-intake.css";
import "../../lib/i18n/features/caseIntakeStrings.js";
import { CaseTextLimit } from "./CaseTextLimit.jsx";

export { CASE_TYPES };

// The longest remedy and contract-articles text the boxes take; the help line
// under each states the same number (#9467 W8-11).
const REMEDY_MAX = 2000;
const ARTICLES_MAX = 500;

// The intake fields both the member's own form and a steward's "Open a case
// for a member" form carry (REQ-UG-STEWARD-CASEWORK-GAPS-20261030).
// Uncontrolled inputs; caseFieldsFromForm reads them back out of FormData.
// `grouped` (the steward's "Open a case for a member" form,
// REQ-UG-CASE-FORM-LAYOUT-20261102) sets the same fields, in the same
// order, into named groups with the dates and short selectors paired at a
// bounded width. The member's own form keeps the plain stack. `own` (the
// member's own form) words the remedy hint to the member, not about them.
export function CaseDetailsFields({ pending: pendingWrite = false, disabled = false, grouped = false, own = false }) {
  const { t } = useLang();
  const id = useId();
  const remedyField = useRef(null);
  const [remedyLength, setRemedyLength] = useState(0);
  const [articlesLength, setArticlesLength] = useState(0);
  useEffect(() => {
    const form = remedyField.current?.form;
    if (!form) return undefined;
    const resetLengths = () => { setRemedyLength(0); setArticlesLength(0); };
    form.addEventListener("reset", resetLengths);
    return () => form.removeEventListener("reset", resetLengths);
  }, []);
  const title = <>
    <label>{t("caseIntake.title")}<BusyInput pending={pendingWrite} name="title" maxLength={200} required disabled={disabled} aria-describedby={`${id}-title`} /></label>
    <small id={`${id}-title`} className="case-intake__help">{t("caseIntake.titleHelp")}</small>
  </>;
  const description = <>
    <label>{t("caseIntake.description")}<BusyTextarea pending={pendingWrite} name="description" maxLength={10000} disabled={disabled} aria-describedby={`${id}-description`} /></label>
    <small id={`${id}-description`} className="case-intake__help">{t("caseIntake.descriptionHelp")}</small>
  </>;
  const caseType = <label>{t("cases.caseType")}<BusySelect pending={pendingWrite} name="caseType" disabled={disabled}>
    {CASE_TYPES.map((type) => <option key={type} value={type}>{t(`cases.type${type}`)}</option>)}
  </BusySelect></label>;
  const incidentDate = <label>{t("caseIntake.incidentDate")}<BusyInput pending={pendingWrite} name="incidentDate" type="date" disabled={disabled} /></label>;
  const remedy = <>
    <label>{t("caseIntake.remedy")}<BusyTextarea ref={remedyField} pending={pendingWrite} name="remedySought" maxLength={REMEDY_MAX} disabled={disabled} aria-describedby={`${id}-remedy`} onInput={(event) => setRemedyLength(event.currentTarget.value.length)} /></label>
    <CaseTextLimit id={`${id}-remedy`} className="case-intake__help" count={remedyLength} max={REMEDY_MAX}>{t(own ? "caseIntake.remedyHelpOwn" : "caseIntake.remedyHelp")}</CaseTextLimit>
  </>;
  const filing = <label>{t("caseIntake.filingStatus")}<BusySelect pending={pendingWrite} name="filingStatus" defaultValue="" disabled={disabled}>
    <option value="">{t("caseIntake.filingUnset")}</option>
    <option value="informal">{t("caseIntake.filingInformal")}</option>
    <option value="filed">{t("caseIntake.filingFiled")}</option>
  </BusySelect></label>;
  const deadline = <label>{t("cases.deadlineField")}<BusyInput pending={pendingWrite} name="deadline" type="date" disabled={disabled} /></label>;
  const articles = <>
    <label>{t("cases.contractArticles")}<BusyTextarea pending={pendingWrite} name="articles" maxLength={ARTICLES_MAX} placeholder={t("cases.articlesPlaceholder")} disabled={disabled} aria-describedby={`${id}-articles`} onInput={(event) => setArticlesLength(event.currentTarget.value.length)} /></label>
    <CaseTextLimit id={`${id}-articles`} className="case-intake__help" count={articlesLength} max={ARTICLES_MAX} />
  </>;
  // A worker's own issue carries no contract articles in this edition; the
  // field stays on the staff intake only.
  if (!grouped) return <>{title}{description}{caseType}{incidentDate}{remedy}{filing}{deadline}{own ? null : articles}</>;
  return <>
    <fieldset className="case-intake__group"><legend>{t("caseIntake.groupFacts")}</legend>
      {title}{description}
      <div className="case-intake__pair">{caseType}{incidentDate}</div>
    </fieldset>
    <fieldset className="case-intake__group"><legend>{t("caseIntake.groupRemedy")}</legend>{remedy}</fieldset>
    <fieldset className="case-intake__group"><legend>{t("caseIntake.groupFiling")}</legend>
      <div className="case-intake__pair">{filing}{deadline}</div>
    </fieldset>
    <fieldset className="case-intake__group"><legend>{t("caseIntake.groupContract")}</legend>{articles}</fieldset>
  </>;
}

export function caseFieldsFromForm(form) {
  const read = (name) => String(form.get(name) ?? "");
  return {
    title: read("title"),
    description: read("description"),
    caseType: read("caseType"),
    incidentDate: read("incidentDate"),
    remedySought: read("remedySought"),
    filingStatus: read("filingStatus"),
    deadline: read("deadline"),
    // A worker's own form has no articles field; send articles only when asked.
    ...(form.has("articles") ? { articles: read("articles") } : {}),
  };
}

function dateOnly(value, lang) {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) ? new Date(`${value}T12:00:00`) : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? dateTimeFormat(lang, { year: "numeric", month: "short", day: "numeric" }).format(parsed)
    : null;
}

// What happened, the incident date, the remedy and the filing status of one
// case, read on open. Hidden entirely where the details are not available
// (null) or none of the four was recorded (cases opened before the columns,
// #7980), and shown as "Not recorded" field by field otherwise.
export function CaseDetailsSummary({ caseId, loadDetails }) {
  const { t, lang } = useLang();
  const [state, setState] = useState({ caseId: null, details: undefined, failed: false });
  useEffect(() => {
    if (!caseId || !loadDetails) return undefined;
    let live = true;
    loadDetails(caseId).then(
      (details) => { if (live) setState({ caseId, details, failed: false }); },
      () => { if (live) setState({ caseId, details: undefined, failed: true }); },
    );
    return () => { live = false; };
  }, [caseId, loadDetails]);
  if (!loadDetails || state.caseId !== caseId) return null;
  if (state.failed) return <p className="case-intake__help" role="status">{t("caseIntake.detailsUnavailable")}</p>;
  const details = state.details;
  if (!details || !(details.description || details.incidentDate || details.remedySought || details.filingStatus)) return null;
  const none = t("caseIntake.notRecorded");
  const filing = details.filingStatus === "informal" ? t("caseIntake.filingInformal")
    : details.filingStatus === "filed" ? t("caseIntake.filingFiled") : none;
  return <section className="case-intake__details" aria-label={t("caseIntake.detailsTitle")}>
    <h3>{t("caseIntake.detailsTitle")}</h3>
    <dl>
      <dt>{t("caseIntake.description")}</dt><dd className="case-intake__description">{details.description || none}</dd>
      <dt>{t("caseIntake.incidentDate")}</dt><dd>{dateOnly(details.incidentDate, lang) || none}</dd>
      <dt>{t("caseIntake.remedy")}</dt><dd>{details.remedySought || none}</dd>
      <dt>{t("caseIntake.filingStatus")}</dt><dd>{filing}</dd>
    </dl>
  </section>;
}
