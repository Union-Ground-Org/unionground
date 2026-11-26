import { useId, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { starterRecommendationsT } from "../../lib/i18n/starterRecommendations.js";
import { useWorkspace, workspaceHref } from "../../components/WorkspacePages.jsx";
import { useIssueSignals } from "../issueIntelligence/IssueSignals.jsx";
import { buildStarterRecommendations } from "./starterRecommendations.js";
import { formatCatalogDate } from "../unionCatalog/catalogSearch.js";
import "./starterRecommendations.css";

export function StarterRecommendations({ catalog = null, issueSignals = null }) {
  const { lang } = useLang();
  const tr = (key) => starterRecommendationsT(lang, key);
  const id = useId();
  const workspace = useWorkspace();
  const [answers, setAnswers] = useState({ focus: "", multiUnit: "" });
  const { status, result } = useIssueSignals(issueSignals, "admin");
  const items = buildStarterRecommendations({ catalog, answers, caseSignals: status === "ready" ? result : null });
  return <section className="starter-recommendations xus-cardbody xus-form" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`} className="xus-etitle">{tr("title")}</h3>
    <p>{tr("intro")}</p>
    {catalog && <p className="xus-note">{tr(`source.${catalog.confidence}`)}</p>}
    <p className="xus-note" id={`${id}-help`}>{tr("temporary")}</p>
    <label className="xus-field">{tr("focus")}
      <select className="xus-input" aria-describedby={`${id}-help`} value={answers.focus} onChange={(event) => setAnswers({ ...answers, focus: event.target.value })}>
        <option value="">{tr("choose")}</option>
        {["contract", "support", "learning"].map((focus) => <option key={focus} value={focus}>{tr(`focus.${focus}`)}</option>)}
      </select>
    </label>
    <label className="xus-field">{tr("multiUnit")}
      <select className="xus-input" value={answers.multiUnit} onChange={(event) => setAnswers({ ...answers, multiUnit: event.target.value })}>
        <option value="">{tr("choose")}</option><option value="yes">{tr("yes")}</option><option value="no">{tr("no")}</option>
      </select>
    </label>
    {status === "loading" && <p role="status">{tr("loading")}</p>}
    {status === "error" && <p role="status">{tr("unavailable")}</p>}
    {items.length === 0 ? <p>{tr("empty")}</p> : <ul className="starter-recommendations__list">
      {items.map((item) => <li key={item.id}>
        <h4>{tr(`title.${item.id}`)}</h4>
        {item.reasons.map((reason) => <p key={reason}>{tr(`reason.${reason}`)}</p>)}
        {item.documents.length > 0 && <ul>{item.documents.map((doc) => <li key={doc.href}><a href={doc.href} lang="en" target="_blank" rel="noopener noreferrer nofollow">{doc.title}</a> · {doc.asOf ? formatCatalogDate(doc.asOf, lang) : tr("undated")}</li>)}</ul>}
        <a className="xus-btn" href={workspaceHref(item.href)} onClick={(event) => {
          if (workspace && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
            event.preventDefault();
            workspace.open(item.href, item.id === "library" ? "hub" : "admin");
          }
        }}>{tr(`action.${item.id}`)}</a>
      </li>)}
    </ul>}
  </section>;
}
