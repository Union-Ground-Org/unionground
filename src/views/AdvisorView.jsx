import { useMemo } from "react";
import { quorumProgress, quorumProgressText } from "../lib/quorumProgress.js";
import { WorkspaceCardTitle, WorkspaceSection, WorkspaceOverview, useWorkspace, useWorkspaceTitle } from "../components/WorkspacePages.jsx";
import { EmptyState } from "../components/Primitives.jsx";
import { ClockAlert, ShieldAlert } from "lucide-react";
import { PlaneHeader, PlaneKpi } from "../components/PlaneHeader.jsx";
import { StaffRoster } from "../components/StaffRoster.jsx";
import { ChapterAppointmentsPanel } from "../components/ChapterAppointmentsPanel.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { configuredWorkloadCategories, withConfiguredWorkloadCategories } from "../lib/workloadConfiguration.js";
import { useDesk } from "../lib/useDesk.js";
import { advisorOverviewOnly } from "../lib/deskPrefetch.js";
import { PLANE_CARD_CLASS } from "../lib/staffPlaneStyles.js";
import { ArrivalCount, ChartArrival, arriveAt } from "../components/ChartArrival.jsx";

// Chapter advisor — real, role-gated plane over get_advisor_overview +
// get_workload_stats + get_staff_roster. Read-only analytics by design. The
// demo fictions (multi-chapter portfolio, dues, mobilization phases, org
// chart, coverage units, "Act"/"Recruit" toasts) had no backing in the
// single-chapter schema and were removed rather than faked.
//
// Wave 2e restyles the plane to the prototype's Chapter 360 screen. Its
// remaining fictions went the same way as the first set: the health score and
// its chip, the scored "health drivers" (the real anonymized workload
// categories take that slot), the 12-week engagement trend, the coaching log,
// the seats-vacant chip, the full-roster link and the two header buttons all
// describe data this schema does not have.

export function AdvisorView(props) {
  const section = useWorkspace()?.section;
  const overviewOnly = advisorOverviewOnly(section);
  return <AdvisorDesk key={overviewOnly ? "overview" : "desk"} {...props} overviewOnly={overviewOnly} />;
}

function AdvisorDesk({ data, api, onNotice, onProfile, onAssistant, overviewOnly }) {
  const pageTitle = useWorkspaceTitle(null);
  const { t, lang } = useLang();
  const workspace = useWorkspace();
  const deskApi = useMemo(() => overviewOnly ? { loadDesk: () => api.loadDesk({ overviewOnly: true }) } : api, [api, overviewOnly]);
  const { desk, error, load } = useDesk(deskApi, "app.loadFailed", workspace?.section);

  const overview = desk?.overview || {};
  const workload = desk?.workload;
  // An applied workload configuration names and hides categories here too.
  const categories = workload?.enoughData
    ? withConfiguredWorkloadCategories(workload.categories || [], configuredWorkloadCategories(data?.workload?.configuration, lang))
    : [];
  const maxCategory = Math.max(1, ...categories.map((row) => row.avg));
  const quorum = quorumProgress(overview.turnout?.totalVotes, overview.turnout?.quorumTarget);
  const atRisk = overview.atRisk || {};
  const hasRisks = Boolean(atRisk.unstaffed) || (atRisk.overdueCases ?? 0) > 0;

  return (
    <div className="screen">
      <PlaneHeader chapterName={data.member?.chapterName} title={pageTitle || t("advisor.title")} sub={t("advisor.eyebrow")}>
        {onAssistant && (
          <button className="icon-button phead__btn--assistant" type="button" aria-label={t("header.assistant")} onClick={onAssistant}>
            <span aria-hidden="true">✦</span>
          </button>
        )}
        <button className="avatar" type="button" aria-label={`${data.member.initials} ${t("header.profile")}`} onClick={onProfile}>{data.member.initials}</button>
      </PlaneHeader>

      <div className="ach-body">
        {error && (
          <EmptyState>
            <p>{error}</p>
            <button type="button" className="outline-pill" onClick={load}>{t("app.tryAgain")}</button>
          </EmptyState>
        )}

        {!error && !desk && <p className="empty-state" role="status">{t("advisor.loading")}</p>}

        {!error && desk && (
          <>
            <WorkspaceSection name="overview"><div className="ach-kpi-grid" role="group" aria-label={t("advisor.title")}>
              <PlaneKpi label={t("advisor.kpiCoveragePeople")} value={overview.membersCovered ?? 0} tone="green" />
              <PlaneKpi label={t("advisor.kpiOpen")} value={overview.openGrievances ?? 0} tone="gold" />
              <PlaneKpi label={t("advisor.kpiResolved")} value={overview.resolvedGrievances ?? 0} tone="green" />
              {/* null rates mean "no resolved+open cases yet" / "no stewards yet" — an em-dash is honest. */}
              <PlaneKpi label={t("advisor.kpiResolution")} value={typeof overview.resolutionRate === "number" ? `${overview.resolutionRate}%` : "—"} tone="gold" />
              <PlaneKpi label={t("advisor.kpiStewards")} value={overview.stewardCount ?? 0} tone="green" />
              <PlaneKpi label={t("advisor.kpiCoverage")} value={typeof overview.coverageRatio === "number" ? overview.coverageRatio : "—"} tone="gold" />
            </div></WorkspaceSection>
            <WorkspaceOverview />

            <div className="ach-split">
              <div className="ach-col">
                <WorkspaceSection name="advisor-workload"><article id="advisor-workload" className={`${PLANE_CARD_CLASS} ach-card role-section-target`} tabIndex="-1">
                  <WorkspaceCardTitle className="ach-card__title">{t("advisor.workloadTitle")}</WorkspaceCardTitle>
                  <p className="ach-card__sub">
                    {workload?.enoughData
                      ? t("advisor.workloadPeriod", { period: workload.period, band: workload.submittersBand })
                      : t("advisor.workloadSub")}
                  </p>
                  {/* null = the stats RPC failed; only a real enoughData:false
                      payload may claim submissions are below the K-anonymity
                      threshold — a transient error is not a fact about turnout. */}
                  {!workload && (
                    <p className="ach-note" role="status">{t("advisor.workloadUnavailable")}</p>
                  )}
                  {workload && !workload.enoughData && (
                    <p className="ach-note" role="status">
                      {t("advisor.workloadNotEnough", { min: workload.minSubmitters ?? 25 })}
                    </p>
                  )}
                  {workload?.enoughData && (
                    <>
                      <ChartArrival name="advisor:workload" className="ach-bars">
                        {categories.map((row, index) => (
                          <div key={row.key}>
                            <div className="ach-bar__head">
                              <span className="ach-bar__name">{row.name ?? t(`workload.cat.${row.key}`)}</span>
                              <span className="ach-bar__value"><ArrivalCount value={row.avg} index={index} /></span>
                            </div>
                            <div className="ach-track"><span className="arrive-x" style={arriveAt(index, { width: `${Math.round((row.avg / maxCategory) * 100)}%` })} /></div>
                          </div>
                        ))}
                      </ChartArrival>
                      <div className="ach-tiles">
                        <div className="ach-tile">
                          <div className="ach-tile__label">{t("workload.fullTime")}</div>
                          <div className="ach-tile__value">{workload.tiles?.pctFullTime == null ? "—" : `${workload.tiles.pctFullTime}%`}</div>
                        </div>
                        <div className="ach-tile">
                          <div className="ach-tile__label">{t("workload.partTime")}</div>
                          <div className="ach-tile__value">{workload.tiles?.pctPartTime == null ? "—" : `${workload.tiles.pctPartTime}%`}</div>
                        </div>
                        <div className="ach-tile">
                          <div className="ach-tile__label">{t("workload.otHours")}</div>
                          <div className="ach-tile__value">{workload.tiles?.avgOtHours ?? "—"}</div>
                        </div>
                      </div>
                    </>
                  )}
                </article></WorkspaceSection>

                <WorkspaceSection name="advisor-turnout"><article id="advisor-turnout" className={`${PLANE_CARD_CLASS} ach-card ach-turnout role-section-target`} tabIndex="-1">
                  <WorkspaceCardTitle className="ach-card__title">{t("advisor.turnoutTitle")}</WorkspaceCardTitle>
                  <p className="ach-card__sub">{t("advisor.turnoutSub")}</p>
                  <div className="ach-turnout__ballot">{overview.turnout?.title || t("vp.noVote")}</div>
                  {overview.turnout && (
                    <div className="ach-turnout__row">
                      <span className="ach-turnout__label">{quorum
                        ? quorumProgressText(t, quorum)
                        : t("vp.turnoutVotes", { votes: overview.turnout.totalVotes ?? 0 })}</span>
                      {/* No quorum target on the ballot → no percentage exists; a
                          full bar would visually assert 100% turnout (VpView makes
                          the same call with a numberless StatCard). */}
                      {/* The bar is capped at full; the figure beside it is
                          not, so 828 of 602 reads as 138% of quorum. */}
                      {quorum && (
                        <>
                          <ChartArrival name="advisor:turnout" className="ach-track" aria-hidden="true"><span className="arrive-meter" style={{ width: `${quorum.bar}%` }} /></ChartArrival>
                          <strong className="ach-turnout__pct">{t("vp.turnoutPctLabel", { percent: quorum.percent })}</strong>
                        </>
                      )}
                    </div>
                  )}
                </article></WorkspaceSection>
              </div>

              <div className="ach-col">
                <WorkspaceSection name="advisor-risks"><article id="advisor-risks" className={`${PLANE_CARD_CLASS} ach-card ach-card--risk role-section-target`} tabIndex="-1">
                  <WorkspaceCardTitle className="ach-card__title">{t("advisor.atRiskTitle")}</WorkspaceCardTitle>
                  <p className="ach-card__sub">{t("advisor.atRiskSub")}</p>
                  {!hasRisks && <p className="ach-note" role="status">{t("advisor.riskNone")}</p>}
                  {hasRisks && (
                    <div className="ach-risks">
                      {(atRisk.overdueCases ?? 0) > 0 && (
                        <div className="ach-risk">
                          <span className="ach-risk__icon" aria-hidden="true"><ClockAlert size={17} /></span>
                          <div className="ach-risk__copy">
                            <div className="ach-risk__title">{t("ach.riskOverdueTitle")}</div>
                            <p className="ach-risk__note">{t("advisor.riskOverdue", { count: atRisk.overdueCases })}</p>
                          </div>
                        </div>
                      )}
                      {Boolean(atRisk.unstaffed) && (
                        <div className="ach-risk">
                          <span className="ach-risk__icon" aria-hidden="true"><ShieldAlert size={17} /></span>
                          <div className="ach-risk__copy">
                            <div className="ach-risk__title">{t("ach.riskNoStewardsTitle")}</div>
                            <p className="ach-risk__note">{t("advisor.riskNoStewards")}</p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </article></WorkspaceSection>
              </div>
            </div>

            <WorkspaceSection name="advisor-leadership"><section id="advisor-leadership" className="ach-roster-wrap role-section-target" tabIndex="-1" aria-label={t("vp.rosterTitle")}>
              <div className="ach-roster-head">
                <WorkspaceCardTitle className="ach-roster-head__title">{t("vp.rosterTitle")}</WorkspaceCardTitle>
                <p className="ach-roster-head__sub">{t("vp.rosterSub")}</p>
              </div>
              <StaffRoster roster={desk.roster} />
            </section></WorkspaceSection>
            <WorkspaceSection name="advisor-appointments"><ChapterAppointmentsPanel api={api} onNotice={onNotice} /></WorkspaceSection>
          </>
        )}
      </div>
    </div>
  );
}
