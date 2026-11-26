import { useEffect, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { templateFromDbRow } from "../../lib/formTemplates.js";
import { FormAnswerReview } from "../../components/FormAnswerReview.jsx";
import "./chapterAccess.css";

export function StewardSharedAccessPanel({ api }) {
  const { t, lang } = useLang();
  const [state, setState] = useState({ phase: "loading", drafts: [], cases: [] });
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setState({ phase: "loading", drafts: [], cases: [] });
    Promise.all([api.sharedDrafts(), api.privateGrievances()]).then(([drafts, cases]) => {
      if (current === generation.current) setState({ phase: "ready", drafts, cases });
    }).catch(() => { if (current === generation.current) setState({ phase: "error", drafts: [], cases: [] }); });
    return () => { generation.current += 1; };
  }, [api, revision]);
  // REQ-UG-APPOINTMENTS-EMPTY-STATE-20261102: this section sits above
  // every steward page, so it speaks only when something is shared or the
  // read failed; a loading or empty section no longer leads the page.
  if (state.phase === "loading" || (state.phase === "ready" && state.drafts.length === 0 && state.cases.length === 0)) return null;
  return <section className="institutional-section chapter-access" aria-label={t("access.sharedDrafts")}>
    <h3>{t("access.sharedDrafts")}</h3>
    {state.phase === "error" && <p role="alert">{t("access.error")} <button type="button" onClick={() => setRevision((value) => value + 1)}>{t("access.retry")}</button></p>}
    {state.phase === "ready" && state.drafts.length === 0 && <p>{t("access.empty")}</p>}
    {state.drafts.map((draft) => {
      const template = templateFromDbRow(draft.template, lang);
      return <details key={draft.id} className="institutional-card"><summary>{t(template.titleKey)}</summary><FormAnswerReview template={template} answers={draft.answers} t={t} lead={false} /></details>;
    })}
    {state.cases.length > 0 && <><h3>{t("access.privateCases")}</h3><ul>{state.cases.map((item) => <li key={item.id}>{t("access.privateCase")} · {t(item.status === "resolved" ? "cases.statusResolved" : "cases.statusActive")}</li>)}</ul></>}
  </section>;
}
