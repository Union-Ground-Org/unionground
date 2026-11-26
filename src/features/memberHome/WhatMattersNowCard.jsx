import { useId } from "react";
import { CalendarDays, CircleCheck, ClipboardList, FolderKanban, Inbox, ListChecks, Megaphone, TriangleAlert, Vote } from "lucide-react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { localeFor } from "../../lib/i18n.js";
import { isFeatureEnabled } from "../../lib/featureSwitches.js";
import { homeRelevantEvents } from "../../lib/homeFeed.js";
import { WHAT_MATTERS_SWITCH, assignedTasksOf, rankWhatMattersNow } from "./whatMattersNow.js";
import { useEasternCalendarDay } from "../../lib/useLocalCalendarDay.js"; // fixed-zone: see the day hook below
import "./whatMattersNow.css";

// The member snapshot (src/lib/memberApi.js) in the ranking's input shape.
export function whatMattersInputs(data, now = new Date()) {
  return {
    cases: data?.cases ?? [],
    ballots: (data?.planItems ?? [])
      .filter((item) => item?.kind === "ballot")
      .map((item) => ({ id: item.id, title: item.title, closed: Boolean(item.closed), voted: Boolean(item.receiptCode), closesAt: item.closesAt ?? null, planItem: item })),
    events: homeRelevantEvents(data)
      .filter((item) => item?.isPast !== true)
      .map((item) => ({ id: item.id, title: item.title, startsAt: item.startsAt, cancelled: Boolean(item.cancelledAt), responded: Boolean(item.rsvpStatus) })),
    surveys: (data?.planItems ?? [])
      .filter((item) => item?.kind === "pulse")
      .map((item) => ({ id: item.id, title: item.title, closed: Boolean(item.closed), answered: Boolean(item.selectedOption), closesAt: item.closesAt ?? null, planItem: item }))
      .concat((data?.organizationSurveys ?? []).map((item) => ({ id: item.id, title: item.title, closed: false, answered: Boolean(item.answered), closesAt: item.closesAt ?? null, planItem: { id: item.id, kind: "organization_survey", title: item.title, closed: false } }))),
    notices: (data?.broadcasts ?? []).map((item) => ({ id: item?.id, title: item?.title, unread: item?.unread === true })),
    tasks: assignedTasksOf(data?.tasks, data?.member?.id),
    now,
  };
}

const ICONS = {
  filing_deadline: TriangleAlert,
  case_in_progress: FolderKanban,
  assigned_task: ListChecks,
  open_vote: Vote,
  rsvp: CalendarDays,
  open_survey: ClipboardList,
  unread_notice: Megaphone,
  steward_queue: Inbox,
  caught_up: CircleCheck,
};

function shortDate(value, lang) {
  if (!value) return "";
  const [year, month, day] = String(value).slice(0, 10).split("-").map(Number);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? new Date(year, month - 1, day) : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(localeFor(lang), { month: "short", day: "numeric" }) : "";
}

function dayPhrase(t, days) {
  if (days === -1) return t("whatMatters.daysOverdueOne");
  if (days < 0) return t("whatMatters.daysOverdue", { count: Math.abs(days) });
  if (days === 0) return t("whatMatters.dueToday");
  if (days === 1) return t("whatMatters.dueTomorrow");
  return t("whatMatters.dueInDays", { count: days });
}

// Null badges (RPC absent or degraded) count as zero, matching the rail,
// which renders no badge rather than a fake number.
function stewardQueueCount(data) {
  const badges = data?.stewardBadges;
  if (!badges) return 0;
  return Math.max(0, Number(badges.openRequests) || 0) + Math.max(0, Number(badges.formsInbox) || 0);
}

function caseName(t, item) {
  return item?.reference || item?.title || t("whatMatters.yourCase");
}

// REQ-UG-MEMBER-WHAT-MATTERS-NOW-20261001: ONE ranked next action per
// Home visit. The ranking reads only the member's own snapshot; the
// organization switch (member-visible) decides whether the card appears.
export function WhatMattersNowCard({ data, onOpenCase, onVote, onOpenEvents, onOpenNotices, onOpenTasks, onOpenStewardDesk }) {
  const { t, lang } = useLang();
  const titleId = useId();
  // Re-ranks when the calendar day turns, so a mounted Home never shows
  // yesterday's day counts.
  // fixed-zone: Home counts calendar days in the same zone as the deadlines it ranks (whatMattersNow.js).
  const now = useEasternCalendarDay();
  if (!isFeatureEnabled(data?.organizationConfiguration, WHAT_MATTERS_SWITCH, true)) return null;
  const inputs = whatMattersInputs(data, now);
  const item = rankWhatMattersNow(inputs);
  // A waiting steward queue replaces the "caught up" state.
  let kind = item.kind;
  let urgency = item.urgency;

  let reason;
  let line;
  let meta = null;
  let action = null;
  switch (item.kind) {
    case "filing_deadline":
      reason = t(item.days < 0 ? "whatMatters.reasonFilingPassed" : "whatMatters.reasonFiling");
      line = t("whatMatters.lineFiling", { when: dayPhrase(t, item.days), case: caseName(t, item.case) });
      meta = t("whatMatters.deadlineOn", { date: shortDate(item.deadline, lang) });
      if (onOpenCase) action = { label: t("whatMatters.actionReviewCase"), run: () => onOpenCase(item.action.caseId) };
      break;
    case "case_in_progress":
      reason = t("whatMatters.reasonCase");
      line = t("whatMatters.lineCase", { case: caseName(t, item.case) });
      // Union Ground issues carry no grievance step, so the meta line is
      // the deadline alone.
      meta = item.deadline ? t("whatMatters.deadlineOn", { date: shortDate(item.deadline, lang) }) : null;
      if (onOpenCase) action = { label: t("whatMatters.actionReviewCase"), run: () => onOpenCase(item.action.caseId) };
      break;
    case "assigned_task":
      reason = t(item.days < 0 ? "whatMatters.reasonTaskOverdue" : "whatMatters.reasonTask");
      line = t("whatMatters.lineTask", { task: item.task.title, when: dayPhrase(t, item.days) });
      meta = item.deadline ? t("whatMatters.taskDueOn", { date: shortDate(item.deadline, lang) }) : null;
      if (onOpenTasks) action = { label: t("whatMatters.actionTasks"), run: () => onOpenTasks(item.action.taskId) };
      break;
    case "open_vote": {
      reason = t("whatMatters.reasonVote");
      line = item.ballot.title;
      meta = item.ballot.closesAt ? t("whatMatters.closesOn", { date: shortDate(item.ballot.closesAt, lang) }) : null;
      const ballot = inputs.ballots.find((row) => String(row.id) === item.ballot.id);
      if (onVote && ballot) action = { label: t("whatMatters.actionVote"), run: () => onVote(ballot.planItem) };
      break;
    }
    case "rsvp":
      reason = t("whatMatters.reasonRsvp");
      line = item.event.title;
      meta = shortDate(item.event.startsAt, lang);
      if (onOpenEvents) action = { label: t("whatMatters.actionRsvp"), run: () => onOpenEvents(item.event.id) };
      break;
    case "open_survey": {
      reason = t("whatMatters.reasonSurvey");
      line = item.survey.title;
      meta = item.survey.closesAt ? t("whatMatters.closesOn", { date: shortDate(item.survey.closesAt, lang) }) : null;
      const survey = inputs.surveys.find((row) => String(row.id) === item.survey.id);
      if (onVote && survey) action = { label: t("whatMatters.actionSurvey"), run: () => onVote(survey.planItem) };
      break;
    }
    case "unread_notice":
      reason = item.unread === 1 ? t("whatMatters.reasonNoticeOne") : t("whatMatters.reasonNotice", { count: item.unread });
      line = item.notice.title;
      if (onOpenNotices) action = { label: t("whatMatters.actionNotice"), run: () => onOpenNotices(item.notice.id) };
      break;
    default: {
      // BUG-UG-ATTENTION-COUNTS-CONTRADICT-THE-PAGES-THEY-OPEN-20261006:
      // "caught up" is only true when nothing else on Home or in the rail is
      // asking for this person. Use the same queue total as the rail.
      const stewardQueue = stewardQueueCount(data);
      if (stewardQueue > 0) {
        kind = "steward_queue";
        urgency = "info";
        reason = t("whatMatters.reasonStewardQueue");
        line = stewardQueue === 1 ? t("whatMatters.lineStewardQueueOne") : t("whatMatters.lineStewardQueue", { count: stewardQueue });
        // UX-UG-GIVE-HOME-STEWARD-REQUESTS-WAITING-LINE-BUTTON-OPENS-20261013:
        // the line names work waiting on a desk this hat cannot see, so the
        // card's one action is the way onto that desk.
        if (onOpenStewardDesk) action = { label: t("whatMatters.actionStewardQueue"), run: () => onOpenStewardDesk() };
      } else {
        reason = t("whatMatters.reasonCaughtUp");
        line = t("whatMatters.lineCaughtUp");
      }
    }
  }

  const Icon = ICONS[kind] ?? CircleCheck;
  return (
    <section className={`home-card what-matters what-matters--${urgency}`} aria-labelledby={titleId} data-kind={kind}>
      <header className="what-matters__head">
        <span className="what-matters__icon" aria-hidden="true"><Icon size={18} /></span>
        <h2 id={titleId}>{t("whatMatters.title")}</h2>
      </header>
      <p className="what-matters__reason">{reason}</p>
      <p className="what-matters__line">{line}</p>
      {meta ? <p className="what-matters__meta">{meta}</p> : null}
      {action ? <button type="button" className="what-matters__action" onClick={action.run}>{action.label}</button> : null}
    </section>
  );
}
