import { ConfirmActionDialog } from "../components/ConfirmActionDialog.jsx";
import { quorumProgress, quorumProgressText } from "../lib/quorumProgress.js";
import { openOrganizationSurveys } from "../lib/voiceAvailability.js";
import { WorkspaceSection, WorkspaceOverview, useWorkspace, useWorkspaceTitle } from "../components/WorkspacePages.jsx";
import { CalendarClock, Gavel, TrendingUp, Users } from "lucide-react";
import { EmptyState, SectionTitle } from "../components/Primitives.jsx";
import { PlaneHeader, PlaneKpi } from "../components/PlaneHeader.jsx";
import { StaffRoster } from "../components/StaffRoster.jsx";
import { PresidentInvitations } from "../components/PresidentInvitations.jsx";
import { OfficerMemberDirectory } from "../components/OfficerMemberDirectory.jsx";
import { AutomationWorkspaceLink } from "../components/AutomationWorkspaceLink.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { useDesk } from "../lib/useDesk.js";
import { PLANE_CARD_CLASS } from "../lib/staffPlaneStyles.js";
import { ArrivalCount, ChartArrival, arriveAt } from "../components/ChartArrival.jsx";
import { dateTimeFormat, formatDateWithYear } from "../lib/i18n.js";
import { downloadEventIcs } from "../lib/ics.js";
import { captureSanitizedDiagnostic } from "../lib/deferredObservability.js";
import { useRef, useState } from "react";
import { BusyButton } from "../components/BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";

// VP / President — real, role-gated plane over get_vp_overview +
// get_staff_roster. Every number is a live chapter aggregate; the demo cards
// with no backing (dues, campaign percentages, org chart) were removed rather
// than faked. Attention reviews are durable, chapter-scoped leadership records.

// A focused page already names its section in the page heading above it, so
// the section keeps only its explanatory line there instead of repeating the
// same words as a second heading. Without a page heading (no workspace pages)
// the section heading stays.
function VpSectionTitle({ title, sub, pageTitle }) {
  if (pageTitle !== title) return <SectionTitle sub={sub}>{title}</SectionTitle>;
  return <header className="section-title section-title--sub-only"><p>{sub}</p></header>;
}

// get_vp_overview's priorities read member_ballots and member_surveys only, so
// an organization survey (Engagement studio) open to this viewer was missing
// and the section said "No open votes or surveys" while Voice listed one
// (BUG-UG-OPEN-SURVEY-UNREACHABLE-FROM-HOME-AND-PHONE-20261111). Add
// the viewer's own open organization surveys, once each.
export function vpPriorities(priorities, organizationSurveys, now = Date.now()) {
  const listed = Array.isArray(priorities) ? priorities : [];
  const ids = new Set(listed.map((item) => item?.id));
  const surveys = openOrganizationSurveys(organizationSurveys, now)
    .filter((item) => item?.id && !ids.has(item.id))
    .map((item) => ({ id: item.id, title: item.title, kind: "survey" }));
  return [...listed, ...surveys];
}

export function VpView({ data, api, onProfile, onAssistant, automationControl = null, invitationApi = null, directoryClient = null }) {
  const pageTitle = useWorkspaceTitle(null);
  const { t, lang } = useLang();
  const workspace = useWorkspace();
  const { desk, error, load } = useDesk(api, "app.loadFailed", workspace?.section);
  const [reviewingId, setReviewingId] = useState("");
  // Record 8435: a synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const [reviewFailedCaseId, setReviewFailedCaseId] = useState("");
  // "Mark reviewed" records a leadership review; it opens a confirmation that
  // says what is recorded and what does not change (APP-VP-01).
  const [confirmReview, setConfirmReview] = useState(null);

  // Dates carry their year and event times their zone (APP-VP-04).
  const dateFmt = (value) => formatDateWithYear(value, lang);
  const eventFmt = (value) => dateTimeFormat(lang, { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value));

  function markReviewed(id) {
    return runBusyWrite(busyWriteRef, "review", () => markReviewedNow(id));
  }

  async function markReviewedNow(id) {
    setReviewFailedCaseId("");
    setReviewingId(id);
    try {
      await api.markReviewed(id);
      setReviewFailedCaseId("");
      await load();
    } catch (err) {
      // Keep driver text off the page and out of the member console. The
      // translated vp.reviewFailed copy is the only user-facing text; label,
      // details, and hint go through the operator-only sanitized channel.
      captureSanitizedDiagnostic({
        kind: "vp_mark_reviewed_failure",
        code: err?.code ?? null,
        name: err?.name ?? null,
        label: err?.label ?? null,
        details: err?.details ?? null,
        hint: err?.hint ?? null,
      });
      setReviewFailedCaseId(id);
    } finally {
      setReviewingId((current) => (current === id ? "" : current));
    }
  }

  const overview = desk?.overview || {};
  const priorities = vpPriorities(overview.priorities, data?.organizationSurveys);
  const reviewsByCase = new Map((desk?.reviews || []).map((item) => [item.caseId, item]));
  const trend = overview.membershipTrend || [];
  const maxTrend = Math.max(1, ...trend.map((item) => item.count));
  const quorum = quorumProgress(overview.turnout?.totalVotes, overview.turnout?.quorumTarget);

  return (
    <div className="screen">
      {/* The shared 28 px serif page title every other staff desk uses, with
          the desk's line as its purpose, as Admin and Advisor do
          (UB-UG-STAFF-DESK-TITLE-TREATMENT-PER-HAT-20261106). */}
      <PlaneHeader chapterName={data.member?.chapterName} title={pageTitle || t("vp.title")} sub={t("vp.eyebrow")} initials={data.member.initials} onProfile={onProfile} onAssistant={onAssistant} />

      {/* The same inset content column every other staff desk uses (Advisor's
          .ach-body, Admin's .xus-body), so the header, stat row and section
          list line up on one width and rhythm. */}
      <div className="vp-body">
        <WorkspaceSection name="vp-automation-control">{automationControl ?? <AutomationWorkspaceLink id="vp-automation-control" />}</WorkspaceSection>

        {error && (
          <EmptyState>
            <p role="alert">{error}</p>
            <button type="button" className="outline-pill" onClick={load}>{t("app.tryAgain")}</button>
          </EmptyState>
        )}

        {!error && !desk && <p className="empty-state" role="status">{t("vp.loading")}</p>}

        {!error && desk && (
          <>
            <WorkspaceSection name="overview"><div className="pkpi-grid" role="group" aria-label={t("vp.title")}>
              <PlaneKpi label={t("vp.kpiMembers")} value={overview.memberCount ?? 0} tone="green" />
              <PlaneKpi label={t("vp.kpiNewYear")} value={overview.newThisYear ?? 0} tone="green" />
              <PlaneKpi label={t("vp.kpiChapterGrievances")} value={overview.activeGrievances ?? 0} tone="gold" />
              {quorum
                ? <PlaneKpi label={t("vp.kpiTurnout")} value={quorum.percent} suffix={t("vp.turnoutPctOfQuorum")} sub={quorumProgressText(t, quorum)} tone="green" />
                : <PlaneKpi label={t("vp.kpiTurnout")} value={overview.turnout?.totalVotes ?? 0} sub={overview.turnout?.title || t("vp.noVote")} tone="green" />}
            </div></WorkspaceSection>
              <WorkspaceOverview />

            <WorkspaceSection name="vp-trend"><section id="vp-trend" className="message-section role-section-target" tabIndex="-1">
              <VpSectionTitle title={t("vp.trendTitle")} sub={t("vp.trendSub")} pageTitle={pageTitle} />
              <article className={`${PLANE_CARD_CLASS} vp-trend-card`}>
                <TrendingUp className="vp-trend-card__icon" size={18} aria-hidden="true" />
                {/* Members with no join year on their record are not counted, so
                    the series can be empty; say so instead of drawing an empty
                    chart (BUG-UG-LEADERSHIP-MEMBERSHIP-TREND-CHART-BLANK-20261111). */}
                {trend.some((item) => item.count > 0) ? (
                  <ChartArrival
                    name="vp:trend"
                    className="vp-trend-chart"
                    role="img"
                    aria-label={t("vp.trendChartLabel", { series: trend.map((item) => `${item.year}: ${item.count}`).join(", ") })}
                  >
                    {trend.map((item, index) => (
                      <div className="vp-trend-chart__column" key={item.year}>
                        <strong><ArrivalCount value={item.count} index={index} /></strong>
                        <span className={index === trend.length - 1 ? "is-current arrive-y" : "arrive-y"} style={arriveAt(index, { height: `${Math.max(8, Math.round((item.count / maxTrend) * 112))}px` })} />
                        <small>{item.year}</small>
                      </div>
                    ))}
                  </ChartArrival>
                ) : <p className="empty-state" role="status">{t("vp.trendEmpty")}</p>}
              </article>
            </section></WorkspaceSection>

            <WorkspaceSection name="vp-attention"><section id="vp-attention" className="message-section role-section-target" tabIndex="-1">
              <VpSectionTitle title={t("vp.attentionTitle")} sub={t("vp.attentionSub")} pageTitle={pageTitle} />
              <article className={PLANE_CARD_CLASS} style={{ padding: 16, marginTop: 12 }}>
                <Gavel className="vp-attention-card__icon" size={16} color="var(--terra)" aria-hidden="true" />
                {(overview.attention || []).length === 0 && <p style={{ margin: "10px 0 0", color: "var(--muted-foreground)", fontSize: 12 }}>{t("vp.attentionEmpty")}</p>}
                <div style={{ marginTop: 6, display: "flex", flexDirection: "column" }}>
                  {/* #7682: the RPC step stays locale-neutral. Canonical Step N
                      and Intake use the shared workflow labels; an
                      organization-authored step name is shown as stored. */}
                  {(overview.attention || []).map((item) => {
                    const review = reviewsByCase.get(item.id);
                    const isReviewed = Boolean(review);
                    return (
                      <div key={item.id} data-attention-case={item.id} style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, flexWrap: "wrap", padding: "10px 0", borderTop: "1px solid var(--track)" }}>
                        <div style={{ minWidth: 0, flex: "1 1 200px" }}>
                          <strong style={{ fontFamily: "var(--display)", fontSize: 12.5, color: isReviewed ? "var(--muted-foreground)" : "var(--foreground)" }}>{item.title}</strong>
                          <p style={{ margin: "4px 0 0", color: "var(--muted-foreground)", fontSize: 11.5, lineHeight: 1.4 }}>
                            {/* The date alone: Union Ground issues carry no
                                grievance step (owner decision, 2026-10-13). */}
                            {item.memberName ? `${item.memberName} · ` : ""}{item.reference} · {t("mcases.due", { date: dateFmt(`${item.deadline}T12:00:00`) })}
                          </p>
                          {review && <p style={{ margin: "4px 0 0", color: "var(--green)", fontSize: 11 }}>{t("vp.reviewedBy", { name: review.reviewerName, date: dateFmt(review.reviewedAt) })}</p>}
                          {reviewFailedCaseId === item.id && (
                            <p role="alert" style={{ margin: "6px 0 0", color: "var(--danger)", fontSize: 12 }}>{t("vp.reviewFailed")}</p>
                          )}
                        </div>
                        <BusyButton type="button" className="outline-pill" style={{ minHeight: 44, padding: "6px 12px", fontSize: 12, flex: "0 0 auto" }} pending={Boolean(reviewingId)} disabled={isReviewed} onClick={() => setConfirmReview(item)}>
                          {isReviewed ? t("vp.reviewed") : reviewingId === item.id ? t("vp.reviewing") : t("vp.markReviewed")}
                        </BusyButton>
                      </div>
                    );
                  })}
                </div>
              </article>
            </section></WorkspaceSection>

            <WorkspaceSection name="vp-leadership"><section id="vp-leadership" className="message-section role-section-target" tabIndex="-1">
              <VpSectionTitle title={t("vp.rosterTitle")} sub={t("vp.rosterSub")} pageTitle={pageTitle} />
              <StaffRoster roster={desk.roster} />
            </section></WorkspaceSection>

            <WorkspaceSection name="vp-priorities"><section id="vp-priorities" className="message-section role-section-target" tabIndex="-1">
              <VpSectionTitle title={t("vp.prioritiesTitle")} sub={t("vp.prioritiesSub")} pageTitle={pageTitle} />
              <div className={PLANE_CARD_CLASS} style={{ marginTop: 12, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
                {priorities.length === 0 && <p style={{ margin: 0, color: "var(--muted-foreground)", fontSize: 12 }}>{t("vp.prioritiesEmpty")}</p>}
                {priorities.map((item) => (
                  <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <span className={`reward-chip ${item.kind === "ballot" ? "reward-chip--points" : "reward-chip--tier"}`}>
                      {item.kind === "ballot" ? t("vp.kindBallot") : t("vp.kindSurvey")}
                    </span>
                    <strong style={{ fontFamily: "var(--display)", fontSize: 13 }}>{item.title}</strong>
                  </div>
                ))}
              </div>
            </section></WorkspaceSection>

            {confirmReview && <ConfirmActionDialog
              eyebrow={t("vp.attentionTitle")}
              title={t("vp.reviewConfirmTitle", { reference: confirmReview.reference })}
              effects={[t("vp.reviewEffectRecord"), t("vp.reviewEffectCase")]}
              affected={t("vp.reviewAffected")}
              undo={t("vp.reviewUndo")}
              confirmLabel={t("vp.markReviewed")}
              onClose={() => setConfirmReview(null)}
              onConfirm={() => { const item = confirmReview; setConfirmReview(null); void markReviewed(item.id); }}
            />}
            <WorkspaceSection name="vp-events"><section id="vp-events" className="message-section role-section-target" tabIndex="-1">
              <VpSectionTitle title={t("vp.agendaTitle")} sub={t("vp.agendaSub")} pageTitle={pageTitle} />
              <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
                {(overview.upcomingEvents || []).length === 0 && <EmptyState><p>{t("vp.agendaEmpty")}</p></EmptyState>}
                {(overview.upcomingEvents || []).map((item) => (
                  <article key={item.id} className={PLANE_CARD_CLASS} style={{ padding: 16, display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <span style={{ display: "grid", placeItems: "center", width: 40, height: 40, borderRadius: 13, background: "var(--green-soft)", color: "var(--green)", flex: "0 0 auto" }}>
                      {item.id.includes("delegate") ? <Users size={18} /> : <CalendarClock size={18} />}
                    </span>
                    <div style={{ flex: "1 1 180px", minWidth: 0 }}>
                      <strong style={{ display: "block", fontFamily: "var(--display)", fontSize: 14 }}>{item.title}</strong>
                      <small style={{ display: "block", marginTop: 2, color: "var(--muted-foreground)", fontSize: 11.5 }}>{eventFmt(item.startsAt)} · {item.location}</small>
                      <p style={{ margin: "6px 0 0", color: "var(--muted-foreground)", fontSize: 11.5, lineHeight: 1.4 }}>{item.summary}</p>
                    </div>
                    <button type="button" className="outline-pill" style={{ minHeight: 44, padding: "8px 14px", fontSize: 12, flex: "0 0 auto" }} onClick={() => downloadEventIcs(item)}>
                      {t("events.addToCalendar")}
                    </button>
                  </article>
                ))}
              </div>
            </section></WorkspaceSection>

            {/* The chapter's member directory and its CSV export through the
                President's office (REQ-UG-OFFICER-MEMBER-ROSTER-AND-EXPORT-20261030). */}
            <WorkspaceSection name="vp-member-directory"><OfficerMemberDirectory client={directoryClient} sectionName="vp-member-directory" /></WorkspaceSection>

            {/* Invitations for a chapter or organization-wide President; renders
                nothing unless the database lists a chapter this President may
                invite into. Also its own page, /m/vp/invitations. */}
            <WorkspaceSection name={["overview", "vp-invitations"]}><PresidentInvitations api={invitationApi} /></WorkspaceSection>
          </>
        )}
      </div>
    </div>
  );
}
