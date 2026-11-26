// The prototype's KPI row (`.kpis` on its Votes, Calendar, Statistics,
// Chapters, Help and Account pages) for the member pages the alternate shell
// mounts (REQ-UG-ALT-PORT-MEMBER-PAGES-20261030). Every figure is
// counted from the member's own snapshot; a page whose prototype figures have
// no backing data (live bargaining, the campaign's day count) gets no row
// rather than an invented number.
import { useLang } from "../lib/LanguageContext.jsx";
import { formatNumber } from "./format.js";

function ballots(data) {
  return (data?.planItems ?? []).filter((item) => item.kind === "ballot");
}

function lessonDone(lesson) {
  const steps = Array.isArray(lesson?.steps) ? lesson.steps.length : 0;
  const done = Array.isArray(lesson?.completedSteps) ? lesson.completedSteps.length : 0;
  return steps > 0 && done >= steps;
}

// [{ key, value, sub }] for a view, or null when the prototype page has no
// figures this snapshot can back.
export function pageKpis(view, data, now = new Date()) {
  const year = now.getFullYear();
  const events = (data?.events ?? []).filter((event) => !event.cancelledAt);
  switch (view) {
    case "voting": {
      const rows = ballots(data);
      return [
        { key: "open", value: rows.filter((item) => !item.closed && !item.receiptCode).length },
        { key: "voted", value: rows.filter((item) => item.receiptCode).length },
        { key: "closed", value: rows.filter((item) => item.closed).length },
        { key: "surveys", value: (data?.planItems ?? []).filter((item) => item.kind === "pulse" && !item.closed).length },
      ];
    }
    case "events": {
      const upcoming = events.filter((event) => event.isPast !== true);
      return [
        { key: "upcoming", value: upcoming.length },
        { key: "going", value: upcoming.filter((event) => event.rsvpStatus === "going").length },
        { key: "attended", value: events.filter((event) => event.checkedIn === true && String(event.startsAt ?? event.eventDate ?? "").startsWith(String(year))).length },
        // A date-only event is a calendar day, not a deadline.
        { key: "deadlines", value: upcoming.filter((event) => event.eventKind === "deadline").length },
      ];
    }
    case "numbers": {
      const metrics = data?.metrics ?? {};
      return [
        { key: "cases", value: metrics.casesHandled ?? 0 },
        { key: "openCases", value: metrics.openCases ?? 0 },
        { key: "resolved", value: metrics.resolvedCases ?? 0 },
        { key: "actions", value: metrics.tasksDone ?? 0 },
      ];
    }
    case "hub": {
      const memberships = data?.member?.chapterMemberships ?? [];
      return [
        { key: "chapters", value: Array.isArray(memberships) && memberships.length ? memberships.length : data?.member?.chapterId ? 1 : 0 },
        { key: "stewards", value: Array.isArray(data?.chapterStewards) ? data.chapterStewards.length : 0 },
        { key: "meetings", value: events.filter((event) => event.isPast !== true && (event.eventKind ?? "meeting") === "meeting").length },
        { key: "since", value: data?.member?.sinceYear ?? null },
      ];
    }
    case "memberSupport":
    case "rights": {
      const lessons = Array.isArray(data?.rights?.lessonRecords) ? data.rights.lessonRecords : [];
      return [
        { key: "lessons", value: lessons.length },
        { key: "lessonsDone", value: lessons.filter(lessonDone).length },
        { key: "stewards", value: Array.isArray(data?.chapterStewards) ? data.chapterStewards.length : 0 },
        { key: "openCases", value: data?.metrics?.openCases ?? 0 },
      ];
    }
    case "settings": {
      const rewards = data?.rewards ?? null;
      return [
        { key: "openCases", value: data?.metrics?.openCases ?? 0 },
        { key: "voted", value: ballots(data).filter((item) => item.receiptCode).length },
        { key: "points", value: rewards?.totalPoints ?? null },
        { key: "since", value: data?.member?.sinceYear ?? null },
      ];
    }
    default:
      return null;
  }
}

export default function AltPageKpis({ view, data, now }) {
  const { t, lang } = useLang();
  const kpis = pageKpis(view, data, now ?? new Date());
  if (!kpis) return null;
  return (
    <section className="ug-wrap ug-alt-page-kpis" aria-label={t("altShell.kpisLabel")}>
      <dl className="ug-kpis">
        {kpis.map(({ key, value }) => (
          <div className="ug-kpi" key={key}>
            <dt><small>{t(`altShell.kpi_${key}`)}</small></dt>
            <dd><b className="ug-tnum">{value == null ? "—" : key === "since" ? value : formatNumber(value, lang)}</b></dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
