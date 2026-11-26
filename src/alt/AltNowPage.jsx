// The design's "Now" front page on the member's live snapshot
// (REQ-UG-ALT-SHELL-FOUNDATION-20261015). It replaces TodayView
// when the alternate shell is on and takes TodayView's props, so App.jsx
// wires both the same way. Content parity with the classic Home: the latest
// update, the member's chapters, rewards and open cases, every open plan item
// (ballots, surveys, tasks, forms, lessons) through the same onPlanAction,
// upcoming events with the same .ics export, stewards with the same contact
// handler, tasks assigned to the member, notifications and the feature cards
// the classic Home mounts (What matters now, nudges, takeover, welcome back,
// learning). Only the arrangement and the styling are the design's.
import { useEffect, useMemo, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { localeFor } from "../lib/i18n.js";
import { buildHomeFeed, homeRelevantEvents } from "../lib/homeFeed.js";
import { buildIcsCalendar, downloadEventIcs } from "../lib/ics.js";
import { eventDisplayDate, eventIsPast, eventModelLabels, compareEventSchedule } from "../lib/eventModel.js";
import { taskKey } from "../lib/kanban.js";
import { homeEmptyStewardKey, stewardContactChannels, stewardsForViewer } from "../lib/stewardConversations.js";
import { WhatMattersNowCard } from "../features/memberHome/WhatMattersNowCard.jsx";
import { HomeGuidanceSlot } from "../features/memberHome/ChoosePasswordCard.jsx";
import { HomeNudgeSlot } from "../features/memberHome/HomeNudgeSlot.jsx";
import { HomeTakeover } from "../features/memberHome/HomeTakeover.jsx";
import { WelcomeBackScreen, useWelcomeBack } from "../features/memberHome/WelcomeBack.jsx";
import { LearningHomeCard } from "../features/learningContent/LearningHomeCard.jsx";
import { SetupTwoStepNotice } from "../features/orgSetup/SetupTwoStepNotice.jsx";
import { IssueSignalBanner } from "../features/issueIntelligence/IssueSignals.jsx";
import { myOpenTasks } from "../views/TodayView.jsx";
import { useAltShell } from "./altShellContext.js";
import { ChapterAvatar, Icon } from "./icons.jsx";
import { calendarDaysBetween, formatDay, formatClock, formatNumber, formatShortDay, relativeTime, toDate } from "./format.js";
import DotGrid from "./DotGrid.jsx";
import AltCalendar from "./AltCalendar.jsx";
import AltMarquee from "./AltMarquee.jsx";
import AltTimeline from "./AltTimeline.jsx";
import { Typewriter } from "./motion.jsx";
import { recordItems, recordTarget } from "./recordIndex.js";
import { seededRoleLine } from "../lib/seededLabels.js";

const PLAN_KINDS = ["ballot", "pulse", "task", "form", "lesson", "case"];
const KIND_TAG = { ballot: "ug-t-vote", pulse: "ug-t-action", task: "ug-t-bargaining", form: "ug-t-program", lesson: "ug-t-rights", case: "ug-t-meeting" };
const KIND_ICON = { ballot: "ballot", pulse: "megaphone", task: "check", form: "edit", lesson: "book", case: "briefcase" };
const NOW_CHAPTER_ROWS = 5;
const CHAPTER_CARDS = 6;
const STRIP_CELLS = 24;

function eventWhen(event, lang) {
  if (event.startsAt || event.eventDate) return eventModelLabels(event, lang).startsLabel;
  return event.startsLabel ?? [event.dateLabel, event.timeLabel].filter(Boolean).join(" · ");
}

function eventStart(event) {
  if (event.startsAt || event.eventDate) return eventDisplayDate(event);
  return null;
}

function upcomingEvents(data, now) {
  return homeRelevantEvents(data)
    .filter((event) => event.isPast !== true && !event.cancelledAt)
    .map((event) => ({ event, at: eventStart(event) }))
    // The snapshot's isPast flag may predate this visit, so re-check it with
    // the shared model: a date-only item stays through its whole day and a
    // meeting stays while it runs, as memberApi computes isPast.
    .filter(({ event, at }) => !at || !eventIsPast(event, now.getTime()))
    .sort((left, right) => compareEventSchedule(left.event, right.event));
}

function downloadAllIcs(events, doc = document) {
  const blob = new Blob([buildIcsCalendar(events)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = doc.createElement("a");
  link.href = url;
  link.download = "union-ground-events.ics";
  doc.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function CalendarDownloadCard({ events }) {
  const { t } = useLang();
  const label = t("altShell.chanCalendar");
  const unavailable = events.length === 0;
  const reason = unavailable ? t("altShell.chanCalendarEmpty") : "";
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => { setAnnouncement(reason); }, [reason]);

  return <>
    {unavailable ? (
      <div className="ug-chan" aria-disabled="true">
        <span className="ug-ci"><Icon name="calendar" /></span><b>{label}</b>
        <span aria-hidden="true">{reason}</span>
      </div>
    ) : (
      <button type="button" className="ug-chan ug-as-link" onClick={() => downloadAllIcs(events)}>
        <span className="ug-ci"><Icon name="calendar" /></span><b>{label}</b>
        <span>{t("altShell.chanCalendarSub")}</span><em>{t("altShell.download")}</em>
      </button>
    )}
    <span className="sr-only" role="status" aria-label={label}>{announcement}</span>
  </>;
}

function initialsOf(name) {
  return String(name || "").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "UG";
}

export default function AltNowPage({
  data: snapshot,
  stewardMessageAvailable = null,
  sessionRestricted = false,
  compassPins = null,
  orgSetup = null,
  onPlanAction,
  onAssistant = null,
  onRewards = null,
  onOpenReports = null,
  onOpenSearch = null,
  onOpenEvents = null,
  onOpenWorkload = null,
  onOpenCases = null,
  onOpenMessages = null,
  onOpenUpdates = null,
  onOpenBroadcast = null,
  onDemoTour = null,
  onContactSteward = null,
  onOpenOrgStructure = null,
  learningContent = null,
  homeTakeover = null,
  welcomeBack = null,
  homeNudges = null,
  choosePassword = null,
  onboardingHud = null,
  homeGuides = null,
  issueSignals = null,
  onNavigate = null,
  onSwitchHat = null,
  chapters = [],
  selectedChapterId = null,
  onSelectChapter = null,
}) {
  const { t, lang } = useLang();
  const shell = useAltShell();
  // Hide cached case inputs immediately when the session changes to a PIN,
  // exactly as TodayView does.
  const data = useMemo(() => sessionRestricted ? { ...snapshot, cases: [], conversations: [], metrics: { ...snapshot.metrics, openCases: 0 } } : snapshot, [snapshot, sessionRestricted]);
  const [selectedPlanFilter, setPlanFilter] = useState("all");
  const [showAll, setShowAll] = useState({ plan: false, tasks: false, stewards: false });
  const welcome = useWelcomeBack({ data, transport: learningContent });
  const now = new Date();
  const member = data.member ?? {};
  const planItems = data.planItems ?? [];
  const rewards = data.rewards ?? null;
  const go = (key, path, sectionId = "") => () => onNavigate?.(key, path, sectionId);

  if (welcome.show) {
    return (
      <div className="ug-wrap ug-legacy">
        <WelcomeBackScreen
          data={data}
          onDismiss={welcome.dismiss}
          onOpenUpdates={welcomeBack?.onOpenUpdates ?? onOpenMessages ?? null}
          onVote={onPlanAction ?? null}
          onOpenEvents={onOpenEvents ?? null}
          onOpenCase={onOpenCases ? (caseId) => onOpenCases(caseId) : null}
          onOpenRights={welcomeBack?.onOpenRights ?? null}
        />
      </div>
    );
  }

  const chapterRows = chapters.length ? chapters : (member.chapterId ? [{ id: member.chapterId, name: member.chapterName || member.chapterId }] : []);
  const currentChapter = chapterRows.find((chapter) => chapter.id === (selectedChapterId ?? member.chapterId)) ?? chapterRows[0] ?? null;
  // The current chapter leads; the panel and the chapter cards show a handful,
  // the rail (Change chapters) has the whole list.
  const orderedChapters = currentChapter ? [currentChapter, ...chapterRows.filter((chapter) => chapter !== currentChapter)] : chapterRows;
  const nowChapters = orderedChapters.slice(0, NOW_CHAPTER_ROWS);
  const heroWords = [...new Set(orderedChapters.map((chapter) => chapter.name).filter(Boolean))];
  // The member's own record, day-indexed for the timeline, marquee and calendar.
  const record = recordItems(data);
  const openRecord = (item) => {
    if (item.type === "update") (onOpenBroadcast ? onOpenBroadcast(item.source) : onOpenMessages?.());
    else if (item.type === "event") onOpenEvents?.(item.source);
    else if (item.type === "vote") {
      const target = recordTarget(item);
      if (target.navigate) onNavigate?.(...target.navigate);
      else onPlanAction?.(target.planItem);
    }
    else if (item.type === "case") onOpenCases?.(item.source.id);
  };
  const openRecordType = (type) => {
    if (type === "update") onOpenMessages?.();
    else if (type === "event") onOpenEvents?.();
    else if (type === "vote") onNavigate?.("voting", "/m/voting", "");
    else onOpenCases?.();
  };
  const lessonRecords = Array.isArray(data.rights?.lessonRecords) ? data.rights.lessonRecords.filter((lesson) => lesson?.id && lesson?.label) : [];
  const chapterCards = orderedChapters.slice(0, CHAPTER_CARDS);
  const feed = buildHomeFeed({ ...data, events: (data.events ?? []).map((event) => {
    return eventStart(event) && eventIsPast(event, now.getTime()) ? { ...event, isPast: true } : event;
  }) });
  const latest = (data.broadcasts ?? [])
    .map((row) => ({ row, at: toDate(row.publishedAt) }))
    .filter((entry) => entry.at)
    .sort((left, right) => right.at - left.at)[0] ?? null;
  const lastRecordAt = [latest?.at?.getTime(), feed[0]?.at].filter((value) => Number.isFinite(value)).sort((a, b) => b - a)[0] ?? null;
  const events = upcomingEvents(data, now);
  const calendarEvents = events.filter(({ at }) => at).map(({ event }) => event);
  // The snapshot's events are the member's own chapter plus union-wide ones,
  // so another chapter's row only ever shows a union-wide event; its own
  // calendar is visible after switching to it.
  const nextEventFor = (chapterId) => events.find(({ event, at }) => at && (
    event.chapterId === chapterId || event.isPublicAcrossAgencies === true
    || (!event.chapterId && chapterId === currentChapter?.id)
  )) ?? null;

  const actionPlanItems = planItems.filter((item) => !item.closed || (item.kind !== "ballot" && item.kind !== "pulse"));
  const actionBallots = actionPlanItems.filter((item) => item.kind === "ballot");
  const openBallots = actionBallots.filter((item) => !item.receiptCode);
  const receiptBallot = planItems.find((item) => item.kind === "ballot" && item.receiptCode) ?? null;
  const hasPastBallots = planItems.some((item) => item.kind === "ballot" && item.closed);
  const quorumBallot = openBallots.find((item) => item.quorum?.quorumTarget) ?? null;
  const quorumLeft = quorumBallot ? Math.max(0, quorumBallot.quorum.quorumTarget - quorumBallot.quorum.totalVotes) : 0;
  const quorumShare = quorumBallot ? Math.min(1, quorumBallot.quorum.totalVotes / quorumBallot.quorum.quorumTarget) : 0;
  const weekly = data.weekly ?? null;
  const kindsPresent = PLAN_KINDS.filter((kind) => actionPlanItems.some((item) => item.kind === kind));
  const planFilter = kindsPresent.includes(selectedPlanFilter) ? selectedPlanFilter : "all";
  // Lists are capped like the design's, with a show-all control so nothing
  // the classic Home can expand is lost here.
  const toggleShowAll = (key) => setShowAll((state) => ({ ...state, [key]: !state[key] }));
  const showAllButton = (key, total, shown) => total > shown || showAll[key] ? (
    <button type="button" className="ug-link-btn" aria-expanded={showAll[key]} onClick={() => toggleShowAll(key)}>
      {showAll[key] ? t("altShell.showFewer") : t("altShell.showAll", { count: total })}
    </button>
  ) : null;
  const matchingPlan = actionPlanItems.filter((item) => planFilter === "all" || item.kind === planFilter);
  const filteredPlan = showAll.plan ? matchingPlan : matchingPlan.slice(0, 6);
  const activeCase = (data.cases ?? []).find((item) => item.status === "active") ?? null;
  const openCases = data.metrics?.openCases ?? (data.cases ?? []).filter((item) => item.status === "active").length;
  // A PIN-restricted session hides the steward card and the notification
  // previews exactly as the classic Home does (names, contacts, bodies).
  // Like the classic card, nobody is named when no steward could receive a
  // message (#6971).
  const { others: stewards, self: onlySelfSteward, unavailable: stewardsUnavailable } = stewardsForViewer(sessionRestricted ? [] : data.chapterStewards, member.id, stewardMessageAvailable);
  const allTasks = myOpenTasks(data.tasks, member.id);
  const myTasks = showAll.tasks ? allTasks : allTasks.slice(0, 5);
  const lessons = Array.isArray(data.rights?.lessons) ? data.rights.lessons.slice(0, 6) : [];
  const notifications = sessionRestricted ? [] : (data.notifications ?? []).filter((item) => !item.read_at).slice(0, 3);
  const unreadMessages = (data.conversations ?? []).reduce((sum, row) => sum + (Number(row.unread) || 0), 0);
  const alertsPath = "/m/settings/notifications";

  const nowPanel = (
    <section className="ug-now" aria-labelledby="ug-now-h">
      <div className="ug-now-head"><h2 id="ug-now-h">{t("altShell.now")}</h2><span className="ug-ago">{formatClock(now, lang)}</span></div>
      <ul className="ug-now-list">
        {nowChapters.map((chapter) => {
          const next = nextEventFor(chapter.id);
          const days = next?.at ? calendarDaysBetween(next.at, now) : null;
          const selected = chapter.id === currentChapter?.id;
          const noEvent = selected ? t("altShell.noMeeting") : t("altShell.switchToSee");
          const big = days == null ? "—" : days <= 0 ? t("altShell.today") : String(days);
          const small = days == null ? noEvent : days <= 0 ? (next.event.title || "") : (days === 1 ? t("altShell.day") : t("altShell.days"));
          return (
            <li key={chapter.id}>
              <button
                type="button"
                className="ug-now-row ug-as-link"
                aria-label={`${chapter.name}: ${days == null ? noEvent : `${t("altShell.nextMeeting")} ${relativeTime(next.at, t, now)}`}`}
                onClick={selected || !onSelectChapter ? (onOpenEvents ?? undefined) : (event) => onSelectChapter(chapter, event.currentTarget)}
              >
                <ChapterAvatar chapter={chapter} />
                <span><span className="ug-nm">{chapter.abbreviation || chapter.name}</span><br /><span className="ug-sub">{selected ? t("altShell.currentChapter") : chapter.name}</span></span>
                <span className="ug-val"><b className="ug-tnum">{big}</b><span>{small}</span></span>
                <Icon name="right" className="ug-go" />
              </button>
            </li>
          );
        })}
      </ul>
      <div className="ug-now-foot">
        <span>{lastRecordAt ? t("altShell.lastRecordUpdate", { ago: relativeTime(new Date(lastRecordAt), t, now) }) : t("altShell.noUpdates")}</span>
        {shell?.openRail && chapterRows.length > 1 ? <button type="button" onClick={shell.openRail}>{t("altShell.changeChapters")}</button> : null}
      </div>
    </section>
  );

  const hero = (
    <section className="ug-hero">
      <DotGrid />
      <div className="ug-wrap ug-hero-grid">
        <div>
          <span className="ug-eyebrow-pill"><span className="ug-live-dot" aria-hidden="true" />{t("altShell.eyebrow")}</span>
          {/* The prototype's typewriter cycles the member's chapters, current first; screen readers get the list once. */}
          <h1>{t("altShell.heroLead")} {heroWords.length ? <><Typewriter words={heroWords} /><span className="ug-sr">{heroWords.join(", ")}</span></> : <span className="ug-accent ug-tw">{t("altShell.heroNoChapter")}</span>}</h1>
          {member.fullName ? <p>{t("today.welcomeBack", { name: member.fullName })}</p> : null}
          {latest ? (
            <button type="button" className="ug-latest ug-as-link" onClick={onOpenBroadcast ? () => onOpenBroadcast(latest.row) : onOpenMessages ?? undefined} aria-label={`${t("altShell.latestUpdate")}: ${latest.row.title}, ${relativeTime(latest.at, t, now)}`}>
              <span className="ug-av ug-av-lg" aria-hidden="true">{initialsOf(latest.row.sender)}</span>
              <div>
                <div className="ug-lbl">{t("altShell.latestUpdate")}</div>
                <div className="ug-big">{relativeTime(latest.at, t, now)}</div>
                <div className="ug-when">{latest.row.sender} · {formatDay(latest.at, lang)} · {formatClock(latest.at, lang)}</div>
                <p className="ug-quote"><b>{latest.row.title}.</b> {latest.row.body}</p>
              </div>
            </button>
          ) : (
            <div className="ug-latest">
              <span className="ug-av ug-av-lg" aria-hidden="true">UG</span>
              <div><div className="ug-lbl">{t("altShell.noUpdates")}</div><p className="ug-quote">{t("altShell.noUpdatesBody")}</p></div>
            </div>
          )}
          <div className="ug-btn-row">
            {shell?.openMenu ? <button type="button" className="ug-btn ug-btn-soft" onClick={shell.openMenu}>{t("cardnav.features")}</button> : null}
            {onDemoTour ? <button type="button" className="ug-btn ug-btn-ghost" onClick={onDemoTour}>{t("demo.chip")}</button> : null}
            <button type="button" className="ug-btn ug-btn-dark" onClick={go("settings", alertsPath)}>{t("altShell.getAlerts")}</button>
            {onOpenUpdates ?? onOpenMessages ? <button type="button" className="ug-btn ug-btn-soft" onClick={onOpenUpdates ?? onOpenMessages}>{t("altShell.allUpdates")}</button> : null}
            {onContactSteward && stewards[0] ? <button type="button" className="ug-btn ug-btn-ghost" onClick={() => onContactSteward(stewards[0])}><Icon name="msg" />{t("altShell.talkToSteward")}</button>
              : onOpenMessages ? <button type="button" className="ug-btn ug-btn-ghost" onClick={onOpenMessages}><Icon name="msg" />{t("altShell.talkToSteward")}</button> : null}
          </div>
        </div>
        <div>{nowPanel}</div>
      </div>
    </section>
  );

  const stripCells = Array.from({ length: STRIP_CELLS }, (_, index) => {
    const share = quorumBallot ? quorumShare : (weekly?.goal ? Math.min(1, weekly.done / weekly.goal) : 0);
    const filled = index < Math.round(share * STRIP_CELLS);
    return <i key={index} className={`ug-cell${filled ? " ug-win" : ""}${index === Math.round(share * STRIP_CELLS) - 1 ? " ug-today" : ""}`} />;
  });

  const tiles = (
    <div className="ug-wrap">
      <div className="ug-tiles">
        {/* Union Ground has no points economy: no tier or points tile (as on the classic Home). */}
        {/* #9465: a PIN session cannot read cases, so no "0 open cases" tile. */}
        {sessionRestricted ? null : <button type="button" className="ug-tile ug-as-link" onClick={onOpenCases ? () => onOpenCases() : undefined}>
          <Icon name="briefcase" />
          <span><b>{openCases === 1 ? t("altShell.tileCasesOne") : t("altShell.tileCases", { count: openCases })}</b><span>{activeCase ? `${activeCase.reference ?? ""} ${activeCase.title ?? ""}`.trim() : t("altShell.tileCasesSub")}</span></span>
        </button>}
        <button type="button" className="ug-tile ug-as-link" onClick={go("memberSupport", "/m/support")}>
          <Icon name="hand" />
          <span><b>{t("altShell.tileSupport")}</b><span>{t("altShell.tileSupportSub")}</span></span>
        </button>
      </div>
      {rewards || weekly ? <dl className="ug-now-stats">
        {rewards ? <>{rewards.actionsYtd != null ? <div><dt>{t("today.actionsYtd")}</dt><dd>{formatNumber(rewards.actionsYtd, lang)}</dd></div> : null}
          {Number.isSafeInteger(rewards.recruitedYtd) ? <div><dt>{t("today.recruitedYtd")}</dt><dd>{formatNumber(rewards.recruitedYtd, lang)}</dd></div> : null}</> : null}
        {weekly ? <div><dt>{t("today.weekActions")}</dt><dd>{weekly.done} / {weekly.goal}</dd></div> : null}
      </dl> : null}
      {quorumBallot ? (
        <button type="button" className="ug-strip ug-as-link" onClick={() => onPlanAction?.(quorumBallot)} aria-label={`${t("altShell.quorumLabel")}: ${quorumBallot.quorum.totalVotes} / ${quorumBallot.quorum.quorumTarget}`}>
          <Icon name="ballot" className="ug-strip-ic" />
          <span className="ug-t"><b>{quorumBallot.title}</b><span>{quorumLeft > 0 ? t("altShell.quorumSub", { votes: quorumBallot.quorum.totalVotes, target: quorumBallot.quorum.quorumTarget, left: quorumLeft }) : t("altShell.quorumReached", { votes: quorumBallot.quorum.totalVotes, target: quorumBallot.quorum.quorumTarget })}</span></span>
          <span className="ug-cells" aria-hidden="true">{stripCells}</span>
          <Icon name="right" className="ug-go" />
        </button>
      ) : weekly?.goal ? (
        <button type="button" className="ug-strip ug-as-link" onClick={onRewards ?? undefined}>
          <Icon name="zap" className="ug-strip-ic" />
          <span className="ug-t"><b>{t("altShell.weeklyStrip")}</b><span>{t("altShell.weeklySub", { done: weekly.done, goal: weekly.goal })}</span></span>
          <span className="ug-cells" aria-hidden="true">{stripCells}</span>
          <Icon name="right" className="ug-go" />
        </button>
      ) : null}
    </div>
  );

  const planCard = (item) => {
    const closesAt = toDate(item.closesAt);
    const done = Boolean(item.receiptCode || item.selectedOption);
    return (
      <button
        key={item.id}
        type="button"
        className="ug-ev ug-ev-btn ug-as-link"
        disabled={Boolean(item.closed) && !done}
        onClick={() => onPlanAction?.(item)}
      >
        <div className="ug-ev-who">
          <span className="ug-av ug-av-sm" aria-hidden="true"><Icon name={KIND_ICON[item.kind] ?? "info"} /></span>
          <span><b>{t(`altShell.kind_${item.kind}`)}</b><span>{item.meta ?? ""}</span></span>
        </div>
        <div className="ug-ev-kind">
          <span className={`ug-tag ${KIND_TAG[item.kind] ?? ""}`}>{item.closed ? t("altShell.closed") : t("altShell.open")}</span>
          {done ? <><span className="ug-dotsep">·</span><span className="ug-confirmed">{t("altShell.voted")}</span></> : null}
        </div>
        <h3>{item.title}</h3>
        {item.action ? <p>{item.action}</p> : null}
        {closesAt ? (
          <div className="ug-ev-meta">
            <div><Icon name="calendar" /><span>{item.closed ? t("altShell.closed") : t("altShell.open")}<b>{formatDay(closesAt, lang)} · {formatClock(closesAt, lang)}</b><span>{relativeTime(closesAt, t, now)}</span></span></div>
          </div>
        ) : null}
      </button>
    );
  };

  const takePart = (
    <section className="ug-band ug-band-dark" aria-labelledby="ug-feed-h">
      <div className="ug-wrap">
        <div className="ug-band-head"><h2 id="ug-feed-h">{t("altShell.takePartLead")} <span className="ug-accent">{t("altShell.takePartAccent")}</span></h2><p>{t("altShell.takePartSub")}</p></div>
        <div className="ug-chips" role="group" aria-label={t("altShell.groupTakePart")}>
          <button className="ug-chip" type="button" aria-pressed={planFilter === "all"} onClick={() => setPlanFilter("all")}>{t("altShell.filterAll")} <span className="ug-n">{actionPlanItems.length}</span></button>
          {kindsPresent.map((kind) => (
            <button key={kind} className="ug-chip" type="button" aria-pressed={planFilter === kind} onClick={() => setPlanFilter(kind)}>
              {t(`altShell.kind_${kind}`)} <span className="ug-n">{actionPlanItems.filter((item) => item.kind === kind).length}</span>
            </button>
          ))}
        </div>
        <div className="ug-ev-grid">
          {receiptBallot && (planFilter === "all" || planFilter === "ballot") ? (
            <div className="ug-ev" key="receipt">
              <div className="ug-ev-kind"><span className="ug-tag ug-t-win">{t("altShell.voted")}</span></div>
              <h3>{receiptBallot.title}</h3>
              <p>{t("altShell.receipt", { code: receiptBallot.receiptCode })} <a href="/verify" target="_blank" rel="noopener">{t("altShell.verify")}</a></p>
            </div>
          ) : null}
          {filteredPlan.filter((item) => item.kind !== "ballot").map(planCard)}
          {filteredPlan.length === 0 && !receiptBallot ? <div className="ug-empty" style={{ gridColumn: "1/-1" }}><b>{t("altShell.nothingOpen")}</b>{t("altShell.nothingOpenBody")}</div> : null}
        </div>
        {actionBallots.length > 0 && (planFilter === "all" || planFilter === "ballot") ? <div className="ug-ballot-list" role="group" aria-label={t("altShell.ballotList")}>
          {actionBallots.map((item) => (
            <button key={item.id} type="button" className="ug-ev ug-as-link"
              aria-label={`${t(item.receiptCode ? "data.voted" : "altShell.kind_ballot")}: ${item.title}`}
              onClick={() => onPlanAction?.(item)}>
              <span><strong>{item.title}</strong>{!item.receiptCode && item.action ? <span>{item.action}</span> : null}
                {item.receiptCode && item !== receiptBallot ? <span>{t("altShell.receipt", { code: item.receiptCode })}</span> : null}
                {toDate(item.closesAt) ? <span>{relativeTime(item.closesAt, t, now)}</span> : null}</span>
              <span>{t(item.receiptCode ? "altShell.voted" : "altShell.kind_ballot")} ›</span>
            </button>
          ))}
        </div> : null}
        <div className="ug-band-foot">
          {showAllButton("plan", matchingPlan.length, 6)}
          {openBallots[0] && onPlanAction ? <button type="button" className="ug-btn ug-btn-white" onClick={() => onPlanAction(openBallots[0])}>{t("today.castVote")}</button> : null}
          {openBallots[0] && onPlanAction ? <button type="button" className="ug-btn ug-btn-ghost" onClick={() => onPlanAction(openBallots[0])}>{t("today.readSummary")}</button> : null}
          <button type="button" className="ug-btn ug-btn-white" onClick={go("voting", "/m/voting")}>{t("nav.voting")}{openBallots.length ? ` · ${openBallots.length}` : ""}</button>
          {hasPastBallots && onNavigate ? <button type="button" className="ug-btn ug-btn-ghost" onClick={go("voting", "/m/voting/past")}>{t("voting.pastTitle")}</button> : null}
          <button type="button" className="ug-btn ug-btn-ghost" onClick={go("voice", "/m/voice")}>{t("morehub.beHeard")}</button>
        </div>
      </div>
    </section>
  );

  const homeCards = (
    <section className="ug-section" aria-labelledby="ug-matters-h">
      <div className="ug-wrap">
        <div className="ug-section-head"><h2 id="ug-matters-h">{t("altShell.whatMatters")}</h2></div>
        <div className="ug-home-cards ug-legacy-cards">
          <SetupTwoStepNotice staffMfa={data.staffMfa} />
          {issueSignals ? <IssueSignalBanner issueSignals={issueSignals} surface="today" /> : null}
          {compassPins}
          {!sessionRestricted && homeTakeover ? <HomeTakeover data={data} transport={learningContent} {...homeTakeover} /> : null}
          <WhatMattersNowCard
            data={data}
            orgSetup={orgSetup}
            onOpenOrgSetup={onSwitchHat ? () => onSwitchHat("admin") : null}
            onOpenCase={onOpenCases ? (caseId) => onOpenCases(caseId) : null}
            onMessageSteward={onOpenMessages ?? null}
            onVote={onPlanAction ?? null}
            onOpenEvents={onOpenEvents ? () => onOpenEvents() : null}
            onOpenNotices={onOpenBroadcast ? (noticeId) => onOpenBroadcast({ id: noticeId }) : onOpenMessages ?? null}
            onOpenTasks={onNavigate ? () => onNavigate("work", "/m/work") : null}
            // UX-UG-ALT-HOME-STEWARD-BUTTON-DEMO-HAT-SWITCH-20261019:
            // the same hat handoff TodayView uses. railNavigate skips the hat
            // switch under ?demo=1, so navigating alone left the demo wearer
            // on Member while the URL said Steward.
            onOpenStewardDesk={onSwitchHat ? () => onSwitchHat("steward") : onNavigate ? () => onNavigate("steward", "/m/steward") : null}
          />
          <HomeGuidanceSlot choosePassword={choosePassword} onboardingHud={onboardingHud}>
            {homeNudges ? <HomeNudgeSlot data={data} transport={learningContent} {...homeNudges} /> : null}
          </HomeGuidanceSlot>
          {learningContent ? <LearningHomeCard {...learningContent} /> : null}
        </div>
      </div>
    </section>
  );

  const calendar = (
    <section className="ug-band ug-band-grey" aria-labelledby="ug-cal-h">
      <div className="ug-wrap">
        <div className="ug-band-head"><h2 id="ug-cal-h">{t("altShell.calendarLead")} <span className="ug-accent">{t("altShell.calendarAccent")}</span></h2><p>{t("altShell.calendarSub")}</p></div>
        <AltCalendar items={record} now={now} onOpenItem={openRecord} />
        <h3 className="ug-cal-next">{t("altShell.comingUp")}</h3>
        <div className="ug-ev-grid">
          {(showAll.events ? events : events.slice(0, 6)).map(({ event, at }) => (
            <div className="ug-ev ug-on-light" key={event.id}>
              <div className="ug-ev-who">
                <span className="ug-av ug-av-sm" aria-hidden="true"><Icon name="calendar" /></span>
                <span><b>{event.chapterName || member.chapterName || ""}</b><span>{event.location || ""}</span></span>
              </div>
              <div className="ug-ev-kind"><span>{t("altShell.scheduled")}</span>{event.rsvpCount != null ? <><span className="ug-dotsep">·</span><span className="ug-confirmed">{t("altShell.rsvps", { count: event.rsvpCount })}</span></> : null}</div>
              <h3>{event.title}</h3>
              {event.summary ? <p>{event.summary}</p> : null}
              <div className="ug-ev-meta">
                <div><Icon name="clock" /><span>{eventWhen(event, lang)}{at ? <b>{relativeTime(at, t, now)}</b> : null}</span></div>
              </div>
              <div className="ug-btn-row">
                {onOpenEvents ? <button type="button" className="ug-btn ug-btn-dark ug-btn-sm" aria-label={t("altShell.openEvent", { title: event.title })} onClick={() => onOpenEvents(event)}>{t("altShell.openEventLabel")}</button> : null}
                {at ? <button type="button" className="ug-btn ug-btn-ghost ug-btn-sm" onClick={() => downloadEventIcs(event)}><Icon name="download" />{t("altShell.addToCalendar")}</button> : null}
              </div>
            </div>
          ))}
          {events.length === 0 ? <div className="ug-empty" style={{ gridColumn: "1/-1" }}><b>{t("altShell.noEvents")}</b>{t("altShell.noEventsBody")}</div> : null}
        </div>
        <div className="ug-btn-row" style={{ marginTop: 26 }}>
          {showAllButton("events", events.length, 6)}
          {onOpenEvents ? <button type="button" className="ug-btn ug-btn-dark" onClick={onOpenEvents}>{t("altShell.openCalendar")}</button> : null}
          {calendarEvents.length > 0 ? <button type="button" className="ug-btn ug-btn-ghost" onClick={() => downloadAllIcs(calendarEvents)}><Icon name="download" />{t("altShell.downloadAll")}</button> : null}
          {onOpenReports ? <button type="button" className="ug-btn ug-btn-ghost" onClick={onOpenReports}>{t("nav.myReports")}</button> : null}
        </div>
      </div>
    </section>
  );

  const chaptersSection = (
    <section className="ug-section" aria-labelledby="ug-ch-h">
      <div className="ug-wrap">
        <div className="ug-section-head"><h2 id="ug-ch-h">{t("altShell.chaptersLead")} <span className="ug-accent">{t("altShell.chaptersAccent")}</span></h2><p>{t("altShell.chaptersSub")}</p></div>
        <div className="ug-ch-grid">
          {chapterCards.map((chapter) => {
            const next = nextEventFor(chapter.id);
            const selected = chapter.id === currentChapter?.id;
            return (
              <button
                key={chapter.id}
                type="button"
                className="ug-ch-card ug-as-link"
                onClick={selected || !onSelectChapter ? go("hub", "/m/organize") : (event) => onSelectChapter(chapter, event.currentTarget)}
              >
                <div className="ug-ch-top"><ChapterAvatar chapter={chapter} /><span><b>{chapter.name}</b><span>{selected ? t("altShell.currentChapter") : (chapter.abbreviation || "")}</span></span></div>
                <div className="ug-ch-note"><Icon name="calendar" /><span><b>{next ? t("altShell.nextMeeting") : selected ? t("altShell.noMeeting") : t("altShell.switchToSee")}</b><span>{next ? `${next.event.title} · ${eventWhen(next.event, lang)}` : t("altShell.noEventsBody")}</span></span></div>
                <div className="ug-ch-nums">
                  {chapter.memberCount != null ? <span><small>{t("altShell.chapterMembers")}</small><b className="ug-tnum">{formatNumber(chapter.memberCount, lang)}</b></span> : null}
                  {chapter.staffCount != null ? <span><small>{t("altShell.chapterStaff")}</small><b className="ug-tnum">{formatNumber(chapter.staffCount, lang)}</b></span> : null}
                  <span><small>{t("altShell.openChapter")}</small><b>{t("nav.myChapter")}</b></span>
                </div>
              </button>
            );
          })}
        </div>
        <div className="ug-btn-row" style={{ marginTop: 24 }}>
          <button type="button" className="ug-btn ug-btn-soft" onClick={go("hub", "/m/organize")}>{t("altShell.chapterDirectory")}</button>
          {onOpenOrgStructure ? <button type="button" className="ug-btn ug-btn-ghost" onClick={onOpenOrgStructure}>{t("nav.orgStructure")}</button> : null}
          {shell?.openRail && chapterRows.length > 1 ? <button type="button" className="ug-btn ug-btn-ghost" onClick={shell.openRail}>{t("altShell.switchChapter")}</button> : null}
        </div>
      </div>
    </section>
  );

  const help = (
    <section className="ug-section" aria-labelledby="ug-help-h">
      <div className="ug-wrap ug-help-hero">
        <div>
          <h2 id="ug-help-h">{t("altShell.helpLead")} <span className="ug-accent">{t("altShell.helpAccent")}</span></h2>
          <p>{t("altShell.helpSub")}</p>
          <div className="ug-btn-row">
            <button type="button" className="ug-btn ug-btn-dark" onClick={go("memberSupport", "/m/support")}>{t("altShell.findProgram")}</button>
            <button type="button" className="ug-btn ug-btn-soft" onClick={go("rights", "/m/rights")}>{t("altShell.knowRights")}</button>
            {onAssistant && !sessionRestricted ? <button type="button" className="ug-btn ug-btn-ghost" onClick={onAssistant}><Icon name="compass" />{t("altShell.askCompass")}</button> : null}
          </div>
        </div>
        <div className="ug-float-stage" aria-hidden="true">
          <div className="ug-float-card ug-fc1"><Icon name="shield" /><span><small>{t("altShell.knowRights")}</small><b>{lessons[0] ?? t("nav.knowRights")}</b></span></div>
          <div className="ug-float-card ug-fc2"><Icon name="hand" /><span><small>{t("altShell.tileSupport")}</small><b>{t("nav.memberSupport")}</b></span></div>
          <div className="ug-float-card ug-fc3"><Icon name="zap" /><span><small>{t("altShell.logWorkload")}</small><b>{t("nav.workload")}</b></span></div>
        </div>
      </div>
      <div className="ug-wrap" style={{ marginTop: 110 }}>
        <div className="ug-src-grid">
          {/* A restricted session hides the roster, so it says nothing about
              whether one exists rather than "No steward is listed". */}
          {!sessionRestricted && <div className="ug-src-card">
            <h3>{t("altShell.yourStewards")}</h3>
            {stewards.length === 0 ? <p>{t(stewardsUnavailable ? "altShell.stewardsUnavailable" : onlySelfSteward ? "altShell.onlySelfSteward" : homeEmptyStewardKey(data, "altShell.noStewards"))}</p> : (
              <ul className="ug-checks">
                {(showAll.stewards ? stewards : stewards.slice(0, 4)).map((steward) => {
                  const channels = stewardContactChannels(steward);
                  return (
                    <li key={steward.id}>
                      <Icon name="user" />
                      <span>
                        <b>{steward.name}</b>{steward.chapterLabel ? ` · ${steward.chapterLabel}` : ""}
                        <span className="ug-btn-row" style={{ marginTop: 6 }}>
                          {onContactSteward ? <button type="button" className="ug-btn ug-btn-soft ug-btn-sm" aria-label={t("today.contactStewardNamed", { name: steward.name })} onClick={() => onContactSteward(steward)}>{t("altShell.contact")}</button> : null}
                          {channels.email ? <a className="ug-btn ug-btn-ghost ug-btn-sm" aria-label={t("today.stewardEmailNamed", { name: steward.name })} href={`mailto:${channels.email}`}><Icon name="mail" />{t("altShell.chanEmail")}</a> : null}
                          {channels.phone ? <a className="ug-btn ug-btn-ghost ug-btn-sm" aria-label={t("today.stewardPhoneNamed", { name: steward.name })} href={`tel:${channels.phone}`}><Icon name="phone" />{t("today.stewardPhone")}</a> : null}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {showAllButton("stewards", stewards.length, 4)}
          </div>}
          <div className="ug-src-card">
            <h3>{t("altShell.myTasks")}</h3>
            {myTasks.length === 0 ? <p>{t("altShell.nothingOpenBody")}</p> : (
              <ul className="ug-checks">
                {myTasks.map((task) => {
                  const due = task.dueDate ? new Date(`${task.dueDate}T00:00:00`).toLocaleDateString(localeFor(lang), { month: "short", day: "numeric" }) : null;
                  return (
                    <li key={task.id}><Icon name="check" /><span><b>{task.title}</b> · {taskKey(task, member.chapterId)}{due ? ` · ${t("altShell.due", { date: due })}` : ""}{task.blocked ? ` · ${t("altShell.blocked")}` : ""}</span></li>
                  );
                })}
              </ul>
            )}
            {showAllButton("tasks", allTasks.length, 5)}
            {onOpenWorkload ? <div className="ug-btn-row" style={{ marginTop: 12 }}><button type="button" className="ug-btn ug-btn-soft ug-btn-sm" onClick={onOpenWorkload}><Icon name="zap" />{t("altShell.logWorkload")}</button></div> : null}
          </div>
          <div className="ug-src-card">
            <h3>{t("altShell.rightsLessons")}</h3>
            {lessons.length === 0 ? <p>{t("altShell.nothingOpenBody")}</p> : (
              <div className="ug-chips">
                {lessons.map((lesson) => {
                  const title = typeof lesson === "string" ? lesson : (lesson?.title ?? lesson?.id ?? "");
                  return <button key={title} type="button" className="ug-chip" onClick={go("rights", "/m/rights")}>{title}</button>;
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );

  const alerts = (
    <section className="ug-section" aria-labelledby="ug-alerts-h">
      <div className="ug-wrap"><div className="ug-notif">
        <div>
          <h2 id="ug-alerts-h">{t("altShell.alertsLead")} <span className="ug-accent">{t("altShell.alertsAccent")}</span></h2>
          <p>{t("altShell.alertsSub")}</p>
          <ul className="ug-checks">
            <li><Icon name="check" /><span>{t("altShell.alertsCheck1")}</span></li>
            <li><Icon name="check" /><span>{t("altShell.alertsCheck2")}</span></li>
            <li><Icon name="check" /><span>{t("altShell.alertsCheck3")}</span></li>
          </ul>
          <button type="button" className="ug-btn ug-btn-dark" onClick={go("settings", alertsPath)}>{t("altShell.setUpAlerts")}</button>
        </div>
        <div className="ug-bot-stage" aria-hidden="true">
          {notifications.length ? notifications.map((item, index) => (
            <div className={`ug-bot ug-b${index + 1}`} key={item.id}>
              <div className="ug-bot-h"><Icon name="bell" />Union Ground <span>{t("altShell.notifications").toLowerCase()}</span></div>
              <b>{item.title}</b>
              <div style={{ marginTop: 4 }}>{item.body}</div>
              {item.created_at ? <div className="ug-ft" style={{ marginTop: 8 }}><span>{formatShortDay(item.created_at, lang)}</span></div> : null}
            </div>
          )) : (
            <div className="ug-bot ug-b1"><div className="ug-bot-h"><Icon name="bell" />Union Ground <span>{t("altShell.notifications").toLowerCase()}</span></div><b>{t("altShell.nothingOpen")}</b></div>
          )}
        </div>
        <div className="ug-channels">
          <button type="button" className="ug-chan ug-as-link" onClick={go("settings", alertsPath)}><span className="ug-ci"><Icon name="mail" /></span><b>{t("altShell.chanEmail")}</b><span>{t("altShell.chanEmailSub")}</span><em>{t("altShell.setUp")}</em></button>
          <button type="button" className="ug-chan ug-as-link" onClick={go("settings", alertsPath)}><span className="ug-ci"><Icon name="msg" /></span><b>{t("altShell.chanSms")}</b><span>{t("altShell.chanSmsSub")}</span><em>{t("altShell.setUp")}</em></button>
          <button type="button" className="ug-chan ug-as-link" onClick={go("settings", alertsPath)}><span className="ug-ci"><Icon name="browser" /></span><b>{t("altShell.chanPush")}</b><span>{t("altShell.chanPushSub")}</span><em>{t("altShell.setUp")}</em></button>
          <CalendarDownloadCard events={calendarEvents} />
          <a className="ug-chan" href="/get-app"><span className="ug-ci"><Icon name="phone" /></span><b>{t("altShell.chanApp")}</b><span>{t("altShell.chanAppSub")}</span><em>{t("altShell.getApp")}</em></a>
        </div>
      </div></div>
    </section>
  );

  const sources = (
    <section className="ug-section" aria-labelledby="ug-src-h">
      <div className="ug-wrap">
        <div className="ug-section-head"><h2 id="ug-src-h">{t("altShell.sourcesLead")} <span className="ug-accent">{t("altShell.sourcesAccent")}</span></h2></div>
        <div className="ug-src-grid">
          <div className="ug-src-card"><h3>{t("altShell.srcSources")}</h3><p>{t("altShell.srcSourcesBody")}</p></div>
          <div className="ug-src-card"><h3>{t("altShell.srcVerification")}</h3><p>{t("altShell.srcVerificationBody")}</p></div>
          <div className="ug-src-card"><h3>{t("altShell.srcPrivacy")}</h3><p>{t("altShell.srcPrivacyBody")}</p></div>
        </div>
        <div className="ug-src-grid" style={{ marginTop: 16 }}>
          <a className="ug-src-link" href="/verify"><Icon name="lock" /><span><b>{t("altShell.verifyReceipt")}</b><span>{t("altShell.srcPrivacy")}</span></span></a>
        </div>
        <div className="ug-btn-row" style={{ marginTop: 20 }}>
          <a className="ug-btn ug-btn-soft" href="/about">{t("altShell.footerAbout")}</a>
          <a className="ug-btn ug-btn-soft" href="/privacy">{t("altShell.privacy")}</a>
          {onOpenSearch ? <button type="button" className="ug-btn ug-btn-ghost" onClick={onOpenSearch}><Icon name="search" />{t("nav.search")}</button> : null}
          {unreadMessages > 0 && onOpenMessages ? <button type="button" className="ug-btn ug-btn-ghost" onClick={onOpenMessages}><Icon name="msg" />{t("altShell.unread", { count: unreadMessages })}</button> : null}
        </div>
      </div>
    </section>
  );

  const roleLine = [seededRoleLine(member.roleLine, t), member.sinceYear ? t("today.memberSince", { year: member.sinceYear }) : null].filter(Boolean).join(" · ");

  const history = feed.length ? <section className="ug-section" aria-label={t("today.feedTitle")}>
    <div className="ug-wrap">
      <h2>{t("today.feedTitle")}</h2>
      <div className="ug-history-list">
        {(showAll.history ? feed : feed.slice(0, 12)).map((item) => {
          const event = item.kind === "event" ? (data.events ?? []).find((row) => `feed-evt-${row.id}` === item.id) : null;
          const broadcast = item.kind === "broadcast" ? (data.broadcasts ?? []).find((row) => `feed-bc-${row.id}` === item.id) : null;
          const run = event && onOpenEvents ? () => onOpenEvents(event)
            : broadcast && onOpenBroadcast ? () => onOpenBroadcast(broadcast)
              : broadcast && onOpenMessages ? onOpenMessages : null;
          const Row = run ? "button" : "div";
          return <Row key={item.id} className="ug-src-card ug-as-link" {...(run ? { type: "button", onClick: run } : {})}>
            <strong>{item.title}</strong><span>{formatDay(item.at, lang, { year: true })} · {item.body}</span>
            {item.attended ? <span>{t("today.feedAttended")} ✓</span> : null}
          </Row>;
        })}
      </div>
      {showAllButton("history", feed.length, 12)}
    </div>
  </section> : null;

  return (
    <div className="ug-now-page" data-ug-page="now">
      {hero}
      {roleLine ? <p className="ug-sr">{roleLine}</p> : null}
      {tiles}
      <AltTimeline items={record} now={now} onOpenItem={openRecord} onOpenType={openRecordType} />
      <AltMarquee items={record} lessons={lessonRecords} onOpenItem={openRecord} onOpenLesson={() => onNavigate?.("rights", "/m/rights", "")} />
      {takePart}
      {homeCards}
      {calendar}
      {history}
      {chaptersSection}
      {help}
      {alerts}
      {sources}
      {homeGuides}
    </div>
  );
}
