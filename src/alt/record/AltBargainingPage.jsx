// The prototype's Bargaining page (pages/bargaining.js) as the alternate
// shell's Pay tools page (REQ-UG-ALT-PORT-MEMBER-PAGES-20261030, E2).
// Its hero, figures row, split of panels and the dark "from the table" card
// carry over. The figures and the Pay tools panel are the view's live pay
// catalog and its calculator, tables, comparison, contract and (for leaders)
// bargaining tabs. The proposals with their status and the session history
// are the chapter's casework bargaining sessions
// (REQ-UG-ALT-MEMBER-PAGES-SERVER-DATA-20261030), which RLS opens
// to chapter leaders only; for everyone else, and while nothing is posted,
// each surface keeps its place and says so rather than showing sample rounds.
// The session feed (live notes and reactions) has no member backend and
// keeps its "nothing posted" card.
import { useLang } from "../../lib/LanguageContext.jsx";
import { Icon } from "../icons.jsx";
import { formatDay, formatNumber, toDate } from "../format.js";
import AltCrumbs from "./AltCrumbs.jsx";
import "../../lib/i18n/features/altRecordPagesStrings.js";

// Figures from the published pay-scale rows; null while the catalog is not
// readable, so the row shows a dash instead of a zero it does not know.
function payKpis(tables) {
  const rows = tables?.state === "success" ? tables.rows ?? [] : null;
  if (tables?.state === "empty") return { grades: 0, steps: 0, latest: null };
  if (!rows) return { grades: null, steps: null, latest: null };
  const dates = rows.map((row) => row.effectiveOn).filter(Boolean).sort();
  return {
    grades: new Set(rows.map((row) => row.grade)).size,
    steps: rows.length,
    latest: dates.length ? dates[dates.length - 1] : null,
  };
}

const PROPOSAL_TAG = { draft: "ug-t-action", proposed: "ug-t-meeting", countered: "ug-t-rights", tentative: "ug-t-bargaining", accepted: "ug-t-win", rejected: "ug-t-rights", withdrawn: "ug-t-action" };
const SESSION_TAG = { planning: "ug-t-meeting", live: "ug-t-win", paused: "ug-t-action", tentative_agreement: "ug-t-bargaining", closed: "ug-t-action" };

// The session the page leads with: the newest one still open (sessions come
// newest-updated first), else the newest. Null when there are none.
export function currentSession(sessions) {
  const rows = Array.isArray(sessions) ? sessions : [];
  return rows.find((row) => row.status !== "closed") ?? rows[0] ?? null;
}

function sessionAt(session) {
  return toDate(session.starts_at) ?? toDate(session.created_at);
}

export default function AltBargainingPage({ tables, bargaining = null, tabs, onOpenHome = null, children }) {
  const { t, lang } = useLang();
  const figures = payKpis(tables);
  const count = (value) => (value == null ? "—" : formatNumber(value, lang));
  const sessions = bargaining?.state === "success" ? bargaining.sessions : [];
  const session = currentSession(sessions);
  const proposals = session?.proposals ?? [];
  const tableUnavailable = bargaining?.state === "error";
  const label = (group, token) => t(`casework.hub.${group}.${token}`);
  return (
    <>
      <section className="ug-page-hero ug-rec-hero">
        <div className="ug-wrap">
          <AltCrumbs title={t("pay.title")} onOpenHome={onOpenHome} />
          <span className="ug-eyebrow-pill ug-rec-pill">{session ? t("altRecordPages.bargPillSession", { status: label("session", session.status) }) : t("altRecordPages.bargPill")}</span>
          <h1 className="ug-rec-h1-gap">{t("altRecordPages.bargH1Lead")}<span className="ug-accent">{t("altRecordPages.bargH1Accent")}</span></h1>
          <p className="ug-lede">{t("altRecordPages.bargLede")}</p>
        </div>
      </section>
      <section className="ug-wrap ug-rec-kpis" aria-label={t("altShell.kpisLabel")}>
        <dl className="ug-kpis">
          <div className="ug-kpi"><dt><small>{t("altRecordPages.bargKpiGrades")}</small></dt><dd><b className="ug-tnum">{count(figures.grades)}</b><span>{t("altRecordPages.bargKpiGradesSub")}</span></dd></div>
          <div className="ug-kpi"><dt><small>{t("altRecordPages.bargKpiSteps")}</small></dt><dd><b className="ug-tnum">{count(figures.steps)}</b><span>{t("altRecordPages.bargKpiStepsSub")}</span></dd></div>
          <div className="ug-kpi"><dt><small>{t("altRecordPages.bargKpiLatest")}</small></dt><dd><b className="ug-tnum ug-rec-kpi-date">{figures.latest ? formatDay(`${figures.latest}T12:00:00`, lang, { year: true }) : "—"}</b><span>{t("altRecordPages.bargKpiLatestSub")}</span></dd></div>
          <div className="ug-kpi"><dt><small>{t("altRecordPages.bargKpiTable")}</small></dt><dd><b className="ug-tnum">{session ? formatNumber(proposals.length, lang) : "—"}</b><span>{session ? t("altRecordPages.bargKpiTableSession", { title: session.title }) : t("altRecordPages.bargKpiTableSub")}</span></dd></div>
        </dl>
      </section>
      <section className="ug-wrap ug-split ug-rec-split">
        <div className="ug-rec-col">
          <div className="ug-panel">
            <h2>{t("pay.title")}</h2>
            <p className="ug-rec-sub">{t("pay.sub")}</p>
            {tabs}
            <div className="ug-legacy ug-rec-tool">{children}</div>
          </div>
          <div className="ug-panel">
            <h2>{t("altRecordPages.bargProposalsH2")}</h2>
            {proposals.length ? (
              <ul className="ug-list ug-rec-barg-list">
                {proposals.map((proposal) => (
                  <li key={proposal.id} className="ug-li ug-li-tag">
                    <span className={`ug-tag ${PROPOSAL_TAG[proposal.status] ?? "ug-t-meeting"}`}>{label("proposal", proposal.status)}</span>
                    <span><b>{proposal.title}</b><span>{[label("side", proposal.side), proposal.response_due_at ? t("altRecordPages.bargResponseDue", { date: formatDay(proposal.response_due_at, lang, { year: true }) }) : ""].filter(Boolean).join(" · ")}</span></span>
                  </li>
                ))}
              </ul>
            ) : <div className="ug-empty ug-rec-empty"><b>{t("altRecordPages.bargProposalsNone")}</b><span>{t(tableUnavailable ? "altRecordPages.bargTableUnavailable" : session ? "altRecordPages.bargProposalsNoneSession" : "altRecordPages.bargProposalsNoneBody")}</span></div>}
          </div>
          <div className="ug-panel">
            <h2>{t("altRecordPages.bargHistoryH2")}</h2>
            {sessions.length ? (
              <ul className="ug-list ug-rec-barg-list">
                {sessions.map((row) => {
                  const at = sessionAt(row);
                  return (
                    <li key={row.id} className="ug-li ug-li-tag">
                      <span className={`ug-tag ${SESSION_TAG[row.status] ?? "ug-t-meeting"}`}>{label("session", row.status)}</span>
                      <span><b>{row.title}</b><span>{[at ? formatDay(at, lang, { year: true }) : "", t(row.proposals.length === 1 ? "altRecordPages.bargProposalsOne" : "altRecordPages.bargProposalsMany", { count: formatNumber(row.proposals.length, lang) })].filter(Boolean).join(" · ")}</span></span>
                    </li>
                  );
                })}
              </ul>
            ) : <div className="ug-empty ug-rec-empty"><b>{t("altRecordPages.bargHistoryNone")}</b><span>{t(tableUnavailable ? "altRecordPages.bargTableUnavailable" : "altRecordPages.bargHistoryNoneBody")}</span></div>}
          </div>
        </div>
        <aside className="ug-rec-aside ug-rec-sticky">
          <div className="ug-script">
            <small>{t("altRecordPages.bargFeedEyebrow")}</small>
            <h2 className="ug-rec-script-h">{t("altRecordPages.bargFeedH2")}</h2>
            <p className="ug-rec-script-p">{t("altRecordPages.bargFeedNone")}</p>
          </div>
          <div className="ug-note"><Icon name="ballot" /><span>{t("altRecordPages.bargVoteNote")}</span></div>
        </aside>
      </section>
    </>
  );
}
