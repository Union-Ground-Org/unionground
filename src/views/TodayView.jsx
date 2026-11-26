import { quorumTurnoutText } from "../lib/quorumTurnout.js";
import { eventDisplayDate, eventModelLabels } from "../lib/eventModel.js";
import { useId, useMemo, useRef, useState } from "react";
import {
  BookOpenCheck, CalendarDays, ChartNoAxesColumnIncreasing, Compass,
  Flag, FolderKanban, ListChecks, Mail, Megaphone, Network, Phone, Search,
  TimerReset, UserRoundSearch, Vote,
} from "lucide-react";
import { useLang } from "../lib/LanguageContext.jsx";
import { localeFor } from "../lib/i18n.js";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { HomeGuidanceSlot } from "../features/memberHome/ChoosePasswordCard.jsx";
import { currentHomeFeed, homeRelevantEvents, HOME_FEED_PAGE } from "../lib/homeFeed.js";
import { WhatMattersNowCard } from "../features/memberHome/WhatMattersNowCard.jsx";
import { taskKey } from "../lib/kanban.js";
import { HomeNudgeSlot } from "../features/memberHome/HomeNudgeSlot.jsx";
import { homeEmptyStewardKey, stewardContactChannels } from "../lib/stewardConversations.js";
import { SetupTwoStepNotice } from "../features/orgSetup/SetupTwoStepNotice.jsx";
import { WelcomeBackScreen, useWelcomeBack } from "../features/memberHome/WelcomeBack.jsx";
import { LearningHomeCard } from "../features/learningContent/LearningHomeCard.jsx";
import { HomeTakeover } from "../features/memberHome/HomeTakeover.jsx";
import "./homeStewardRoster.css";
import { IssueSignalBanner } from "../features/issueIntelligence/IssueSignals.jsx";
import { homeGreetingKey } from "../lib/homeGreeting.js";
import { voiceAvailabilityLabel } from "../lib/voiceAvailability.js";
import { highestOfficeKey } from "../lib/staffPlaneStyles.js";
import { seededRoleLine } from "../lib/seededLabels.js";
import { campaignStageLabel } from "../lib/lifecycleMetrics.js";

// Union Ground marks a campaign pulse with a flag and carries organizing
// meetings as plan items too.
const PLAN_ICON_BY_KIND = { ballot: Vote, pulse: Flag, lesson: BookOpenCheck, meeting: CalendarDays };

function PlanKindIcon({ kind, size = 18 }) {
  const Icon = PLAN_ICON_BY_KIND[kind] ?? ListChecks;
  return <Icon size={size} strokeWidth={2} />;
}

// Phone Home greets by the member's own clock. Boundaries, stated once here:
// 00:00–11:59 morning, 12:00–17:59 afternoon, 18:00–23:59 evening. The small
// hours read as morning because that is how both catalogues greet them —
// "Good morning" / "Buenos días" is the ordinary greeting before noon in
// either language, and neither carries a late-night variant.
export function greetingKeyForHour(hour) {
  if (hour < 12) return "today.greetingMorning";
  if (hour < 18) return "today.greetingAfternoon";
  return "today.greetingEvening";
}

// One label for both event shapes in the data: fallback's member event carries
// dateLabel/timeLabel, staff-authored events carry startsLabel.
function eventWhen(event, lang) {
  if (event.eventKind || event.endsAt) return eventModelLabels(event, lang).startsLabel;
  return event.startsLabel ?? [event.dateLabel, event.timeLabel].filter(Boolean).join(" · ");
}

// The design's Coming-up date badge (18 / JUN). Staff events carry a raw
// startsAt; the demo fallback rows carry only "Jul 30"-style labels, so the
// label is the fallback parse rather than an invented date.
function eventBadge(event, lang) {
  if (event.startsAt || event.eventDate) {
    const date = eventDisplayDate(event);
    return { day: String(date.getDate()), month: date.toLocaleDateString(localeFor(lang), { month: "short" }) };
  }
  const [month, day] = String(event.dateLabel || "").split(" ");
  return day ? { day, month } : null;
}

// UB-CW-07. A member can be assigned a chapter task, and the assignment fires
// a `task.assigned` notification whose copy says "Open Tasks to see what is on
// your list" — but the Tasks view is a staff TOOL and never mounts for them
// (App.jsx gates it on canUseStaffTools). The row was always readable:
// chapter_tasks_select_chapter grants SELECT on chapter membership alone, with
// no role or assignee predicate, and the snapshot already loads it. Only the
// surface was missing.
//
// This is that surface, and UB-CW-03 decided the BOARD stays staff-only, so it
// lives here on Home instead — read-only by construction, matching the RLS: a
// member holds no write grant on chapter_tasks, so there is nothing to offer
// them but the truth about what they have been handed.
const MY_TASK_LIMIT = 5;

function assigneeIdsOf(task) {
  return Array.isArray(task.assigneeIds) && task.assigneeIds.length
    ? task.assigneeIds
    : task.assigneeId ? [task.assigneeId] : [];
}

// Soonest real deadline first, then blocked work, then everything undated.
// `done` is excluded rather than sorted last: a finished task is not something
// on your list, and the snapshot deliberately keeps recent done rows loaded.
export function myOpenTasks(tasks, memberId) {
  if (!memberId || !Array.isArray(tasks)) return [];
  return tasks
    .filter((task) => task.status !== "done" && assigneeIdsOf(task).includes(memberId))
    .sort((a, b) => {
      if (a.dueDate !== b.dueDate) {
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate < b.dueDate ? -1 : 1;
      }
      if (a.blocked !== b.blocked) return a.blocked ? -1 : 1;
      return 0;
    });
}

// The feed's icon per row kind — the same lucide language the rest of Home
// speaks (megaphone broadcasts, calendar events, ballot votes).
function HomeFeedSection({ data, onOpenMessages }) {
  const { t, lang } = useLang();
  const feed = useMemo(() => currentHomeFeed(data), [data]);
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (feed.length === 0) return null;
  const thisYear = new Date().getFullYear();
  const dateLabel = (at) => {
    const date = new Date(at);
    return date.toLocaleDateString(localeFor(lang), {
      month: "short", day: "numeric", ...(date.getFullYear() !== thisYear ? { year: "numeric" } : {}),
    });
  };
  return (
    <section className="home-feed" aria-label={t("today.feedTitle")}>
      <div className="home-section-label">{t("today.feedTitle")}</div>
      <div className="home-rows" id={listId}>
        {(expanded ? feed : feed.slice(0, HOME_FEED_PAGE)).map((item) => {
          const Row = onOpenMessages ? "button" : "div";
          const meta = [dateLabel(item.at), t("today.feedBroadcast"), item.body].filter(Boolean).join(" · ");
          return (
            <Row className="home-row" key={item.id} {...(onOpenMessages ? { type: "button", onClick: onOpenMessages } : {})}>
              <span className="home-row__icon" aria-hidden="true"><Megaphone size={18} /></span>
              <span className="home-row__copy"><strong>{item.title}</strong><small>{meta}</small></span>
              {onOpenMessages && <span className="home-row__chev" aria-hidden="true">›</span>}
            </Row>
          );
        })}
      </div>
      {feed.length > HOME_FEED_PAGE && (
        <button type="button" className="home-feed__more" aria-controls={listId} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? t("today.feedShowRecent") : t("today.feedShowAll", { count: feed.length })}
        </button>
      )}
    </section>
  );
}

// Find my steward / Contact my steward (owner order 2026-09-22). This is the
// member's entry to representation, so it renders identically on desktop and
// phone — a desktop-only card would recreate exactly the dead end the record
// describes.
//
// Contact is per steward, not per chapter. Each button carries that steward's
// id, and the handler resolves the conversation bound to THAT steward
// (member_conversations.steward_user_id) rather than the first steward-role
// thread, which is how two stewards in one chapter stop sharing one inbox.
//
// Direct channels are opt-in: the roster RPC returns null for every email or
// phone a steward has not published themselves, so the in-app conversation is
// the only affordance until a steward writes their own preference.
//
// BUG-UG-WEB-HOME-STEWARD-LIST-UNCAPPED-20261002: Home shows the first
// STEWARD_HOME_CAP rows of the roster, so its height no longer grows with the
// chapter. "See all N" opens the whole roster in place (the roster is already
// loaded, so every steward stays reachable) and "Show fewer" closes it again.
const STEWARD_HOME_CAP = 3;

function StewardCard({ stewards, emptyKey = "today.findStewardEmpty", onContactSteward, onOpenOrgStructure }) {
  const { t } = useLang();
  const listId = useId();
  const [showAll, setShowAll] = useState(false);
  const list = Array.isArray(stewards) ? stewards : [];
  const capped = list.length > STEWARD_HOME_CAP;
  const shown = capped && !showAll ? list.slice(0, STEWARD_HOME_CAP) : list;
  return (
    <section className="home-card home-steward" aria-labelledby="home-steward-title">
      <header className="home-steward__head">
        <span className="home-steward__icon" aria-hidden="true"><UserRoundSearch size={18} /></span>
        <div>
          <h2 id="home-steward-title">{t("today.findSteward")}</h2>
          <p>{t("today.findStewardSub")}</p>
        </div>
      </header>
      {list.length === 0 ? (
        <p className="home-steward__empty">{t(emptyKey)}</p>
      ) : (
        <div className="home-steward__list" id={listId}>
          {shown.map((steward) => {
            const name = steward.name ?? t("inbox.chapterSteward");
            const channels = stewardContactChannels(steward);
            const meta = [
              t(`today.stewardRole_${steward.roleLabel === "steward" ? "steward" : "other"}`),
              steward.chapterLabel,
            ].filter(Boolean).join(" · ");
            return (
              <article className="home-steward__row" key={steward.id}>
                <span className="home-steward__copy">
                  <strong>{name}</strong>
                  <small>{meta}</small>
                </span>
                <span className="home-steward__actions">
                  {onContactSteward && (
                    <button
                      className="home-steward__contact"
                      type="button"
                      onClick={() => onContactSteward(steward)}
                      aria-label={t("today.contactStewardNamed", { name })}
                    >
                      {t("today.contactSteward")}
                    </button>
                  )}
                  {channels.email && (
                    <a className="home-steward__channel" href={`mailto:${channels.email}`} aria-label={t("today.stewardEmailNamed", { name })}>
                      <Mail size={15} aria-hidden="true" />{t("today.stewardEmail")}
                    </a>
                  )}
                  {channels.phone && (
                    <a className="home-steward__channel" href={`tel:${channels.phone}`} aria-label={t("today.stewardPhoneNamed", { name })}>
                      <Phone size={15} aria-hidden="true" />{t("today.stewardPhone")}
                    </a>
                  )}
                </span>
              </article>
            );
          })}
        </div>
      )}
      {capped && (
        <button className="home-steward__org home-steward__more" type="button" aria-expanded={showAll} aria-controls={listId} onClick={() => setShowAll((open) => !open)}>
          {showAll ? t("today.stewardShowFewer") : t("today.stewardSeeAll", { count: list.length })}
        </button>
      )}
      {onOpenOrgStructure && (
        <button className="home-steward__org" type="button" onClick={onOpenOrgStructure}>
          <Network size={16} aria-hidden="true" />{t("today.seeOrgStructure")}
        </button>
      )}
      {/* Says plainly why a steward may show no address or number: the channel
          is the steward's to publish, and the app will not guess one. */}
      <p className="home-steward__note">{t("today.findStewardNote")}</p>
    </section>
  );
}

// onProfile / onNotifications are gone from this signature on purpose: the
// avatar and bell they drove moved into the shell's global mobile top bar,
// which the App wires directly. Nothing else about this screen changed.
// learningContent carries the governed quote/mini-lesson card's App wiring
// (session client, session, selected organization and chapter, language).
// Absent, Home renders no card.
export const WEEK_ACTIONS_CLOSED_ROWS = 3;
export const WEEK_ACTIONS_RECENT_MS = 7 * 24 * 60 * 60 * 1000;
export function weekActionRows(planItems, now = Date.now()) {
  const open = planItems.filter((item) => !item.closed);
  const closed = planItems
    .map((item, index) => ({ item, index, at: Date.parse(item.closesAt ?? "") || 0 }))
    .filter(({ item }) => item.closed)
    .sort((a, b) => b.at - a.at || a.index - b.index);
  const recent = closed.filter(({ at }) => at > 0 && at <= now && now - at <= WEEK_ACTIONS_RECENT_MS);
  const shownClosed = (open.length + recent.length > 0 ? recent : closed)
    .slice(0, WEEK_ACTIONS_CLOSED_ROWS)
    .map(({ item }) => item);
  return [...open, ...shownClosed];
}

export function TodayView({ data, desktop = false, campaign = null, onOpenCampaign, compassPins = null, onboardingHud = null, choosePassword = null, homeGuides = null, onPlanAction, onAssistant, onRewards, onOpenReports, onOpenSearch, onOpenEvents, onOpenWorkload, onOpenCases, onOpenMessages, onContactSteward, onOpenOrgStructure, learningContent = null, homeTakeover = null, welcomeBack = null, homeNudges = null, issueSignals = null, onSwitchHat = null }) {
  const { t, lang } = useLang();
  const { member, planItems } = data;
  const actionPlanItems = planItems.filter((item) => !item.closed || (item.kind !== "ballot" && item.kind !== "pulse"));
  const [showAllActions, setShowAllActions] = useState(false);
  const actionsListId = useId();
  const [laterDismissed, setLaterDismissed] = useDeviceParityState("today.laterDismissed", false);
  const [myTasksExpanded, setMyTasksExpanded] = useState(false);
  const myTasksListId = useId();
  const myTasksRef = useRef(null);
  // REQ-UG-REACTIVATION-WELCOME-BACK-20261001: after a long absence the
  // first Home of the session is one calm welcome-back screen instead of the
  // full dashboard. The server decides; the member can go straight on.
  const welcome = useWelcomeBack({ data, transport: learningContent });
  if (welcome.show) {
    return (
      <div className={`screen screen--today home${desktop ? " home--desktop" : ""}`}>
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

  // Sentence-case date line, per the design ("Tuesday, June 16") — the old
  // uppercase eyebrow treatment was an audited defect. The date line and the
  // phone greeting read the SAME instant, so they can never disagree about
  // which day it is at a midnight render.
  const now = new Date();
  const todayLabel = now.toLocaleDateString(localeFor(lang), { weekday: "long", month: "long", day: "numeric" });
  const officeKey = highestOfficeKey(member, data.roles);
  const rolesPaused = data.staffMfa?.blocked === true && data.staffMfa?.holdsStaffRole === true;
  const office = officeKey ? t(officeKey) : null;
  const officeLabel = office && rolesPaused ? `${office} (${t("today.rolePaused")})` : office;
  const [profileRole, ...profileDetails] = (member.roleLine ?? "").split(" · ");
  const adminLabels = ["Admin", "Administrator", "Administrador", "Administrador/a", "Administradora"];
  const duplicatesOffice = office && (profileRole.trim() === office
    || (officeKey === "demo.hatAdmin" && adminLabels.includes(profileRole.trim())));
  const profileLine = duplicatesOffice ? profileDetails.join(" · ") : seededRoleLine(member.roleLine, t);
  const chapterName = member.chapterName?.trim();
  const identityLabels = [
    officeLabel,
    profileLine,
    member.chapterId && chapterName && chapterName !== member.chapterId ? t("today.chapterContext", { chapter: chapterName }) : null,
  ].filter((label) => label?.trim());
  const greetingKey = greetingKeyForHour(now.getHours());

  // The ballots behind the design's card set. Hero = first still-open, not-yet
  // voted ballot; the second dark card is the next open ballot, else an open
  // unanswered pulse (the live app's chapter-poll equivalent). A ballot the
  // member voted on renders as the receipt card instead — the SG- receipt is
  // the artifact that must survive close.
  const openBallots = planItems.filter((item) => item.kind === "ballot" && !item.closed && !item.receiptCode);
  const heroBallot = openBallots[0] ?? null;
  const secondVote = openBallots[1] ?? planItems.find((item) => item.kind === "pulse" && !item.closed && !item.selectedOption) ?? null;
  const receiptBallot = planItems.find((item) => item.kind === "ballot" && item.receiptCode) ?? null;
  const quorumBallot = openBallots.find((item) => item.quorum?.quorumTarget) ?? null;
  const quorumLeft = quorumBallot ? Math.max(0, quorumBallot.quorum.quorumTarget - quorumBallot.quorum.totalVotes) : 0;
  const quorumPct = quorumBallot ? Math.min(100, Math.round((quorumBallot.quorum.totalVotes / quorumBallot.quorum.quorumTarget) * 100)) : 0;

  // Everything not already surfaced by a dark card or the receipt card lands
  // in "Next 2 minutes". A
  // "Later"-dismissed second vote falls back into this list rather than
  // vanishing from the screen entirely.
  const quickItems = actionPlanItems.filter((item) => item !== heroBallot && (item !== secondVote || laterDismissed) && item !== receiptBallot);
  const activeCase = (data.cases ?? []).find((item) => item.status === "active") ?? null;
  // The paired desktop/phone page must expose the same event content. The
  // previous 4-vs-3 display caps made the fourth real event desktop-only.
  // The member loader now returns the whole chapter archive so the Events
  // screen can show attendance history, so "Coming up" has to drop the rows
  // it flags as past — an already-held meeting is not something coming up.
  const comingUp = homeRelevantEvents(data).filter((item) => item.isPast !== true);
  const coverage = campaign && campaign.eligibleEstimate
    ? Math.round((campaign.contactedCount / campaign.eligibleEstimate) * 100)
    : null;
  // Union Ground has no points economy, so the
  // overview counts organizing work only — never points, tiers, or streaks.
  const overviewTiles = [
    { key: "cases", value: data.metrics.openCases, label: t("today.openIssues") },
    coverage === null
      ? { key: "committee", value: data.metrics.resolvedCases, label: t("today.committeeReady") }
      : { key: "coverage", value: `${coverage}%`, label: t("today.contactCoverage") },
  ];

  // Union Ground's voluntary-participation card and the campaign card that
  // opens the Organize plane. Both render on desktop and phone (content
  // parity); the campaign card only when the worker belongs to a campaign.
  const participationCard = (
    <section className="week-hero" aria-labelledby="voluntary-participation-title">
      <div className="week-hero__copy">
        <span className="eyebrow">{t("today.participationEyebrow")}</span>
        <h2 id="voluntary-participation-title">{t("today.participationTitle")}</h2>
        <p>{t("today.participationSub")}</p>
        {onRewards && <button type="button" className="outline-pill" onClick={onRewards}>{t("today.viewRewards")}</button>}
      </div>
    </section>
  );
  const campaignCard = campaign && (
    <button className="campaign-card" type="button" onClick={onOpenCampaign}>
      <span className="eyebrow">{t("today.campaignEyebrow")}</span>
      <h2>{campaign.name}</h2>
      <p>{campaign.nextAction}</p>
      <div className="campaign-card__meta">
        <span>{t("today.campaignStage", { stage: campaign.stageLabel || campaignStageLabel(campaign.stage, lang) })}</span>
        {campaign.nextActionDue && (
          <span>{t("today.campaignDue", { date: new Date(`${campaign.nextActionDue}T12:00:00`).toLocaleDateString(localeFor(lang), { month: "short", day: "numeric" }) })}</span>
        )}
      </div>
    </button>
  );

  const heroVoteCard = heroBallot && (
    <article className="home-vote-hero" aria-label={heroBallot.title}>
      <div className="home-vote-hero__tag"><span className="home-live-dot" aria-hidden="true" /><span>{t("today.liveTag")} · {heroBallot.meta} · {t("today.details")} ›</span></div>
      <h2>{heroBallot.title}</h2>
      {heroBallot.quorum?.quorumTarget ? (
        <p className="home-vote-hero__meta">
          {t("today.secretQuorum", { turnout: quorumTurnoutText(t, heroBallot.quorum) })}
        </p>
      ) : null}
      <button className="home-vote-hero__cta" type="button" onClick={() => onPlanAction(heroBallot)}>{t("today.castYourVote")}</button>
      <p className="home-vote-hero__foot">{t("today.voteFootnote")}</p>
    </article>
  );

  const receiptCard = receiptBallot && (
    <article className="home-receipt">
      <span className="home-receipt__check" aria-hidden="true">✓</span>
      <div>
        <strong>{t(receiptBallot.closed ? "today.closedBallotReceipt" : "today.ballotIn")}</strong>
        <small>{receiptBallot.title}</small>
        <small>
          {receiptBallot.closed
            ? `${t("today.receipt", { code: receiptBallot.receiptCode })} ·`
            : t("today.ballotInMeta", { code: receiptBallot.receiptCode })}{" "}
          <a href="/verify" target="_blank" rel="noopener">{t("today.verifyIt")}</a>
        </small>
      </div>
    </article>
  );

  const secondVoteCard = secondVote && !laterDismissed && (
    <article className="home-vote-hero home-vote-hero--second" aria-label={secondVote.title}>
      <div className="home-vote-hero__tag"><span className="home-vote-hero__badge">{t(secondVote.kind === "pulse" ? "today.openSurvey" : "today.openVote")}</span><span className="home-vote-hero__tagmeta">{t(secondVote.kind === "pulse" ? "voting.surveysKicker" : "today.chapterVote")} · {secondVote.meta}</span></div>
      <h2>{secondVote.title}</h2>
      <div className="home-vote-hero__row">
        <button className="home-vote-hero__cta" type="button" onClick={() => onPlanAction(secondVote)}>{t(secondVote.kind === "pulse" ? "dialogs.submitAnswer" : "today.castMyVote")}</button>
        <button className="home-vote-hero__later" type="button" onClick={() => setLaterDismissed(true)}>{t("today.later")}</button>
      </div>
    </article>
  );

  const quorumCard = quorumBallot && (
    <button className="home-quorum" type="button" onClick={() => onPlanAction(quorumBallot)} aria-label={`${t("today.chapterQuorum")} — ${quorumBallot.quorum.totalVotes} / ${quorumBallot.quorum.quorumTarget}`}>
      <span className="home-quorum__top"><strong>{t("today.chapterQuorum")} <i aria-hidden="true">›</i></strong><b>{quorumBallot.quorum.totalVotes} / {quorumBallot.quorum.quorumTarget}</b></span>
      <span className="home-quorum__track" aria-hidden="true"><span style={{ width: `${quorumPct}%` }} /></span>
      <small>{quorumLeft > 0 ? t("today.quorumMore", { count: quorumLeft }) : t("today.quorumReached")}</small>
    </button>
  );

  // Today is the MEMBER hat's home. Steward work — including the review
  // queue — lives entirely behind the Steward hat, so no queue card here.

  // UB-CW-07. Rendered identically on desktop and phone: this is the only
  // place a member can see what they have been assigned, so it cannot be a
  // desktop-only card without re-creating the same dead end on the phone.
  const myTasks = myOpenTasks(data.tasks, member.id);
  const visibleMyTasks = myTasksExpanded ? myTasks : myTasks.slice(0, MY_TASK_LIMIT);
  const myTasksCanExpand = myTasks.length > MY_TASK_LIMIT;
  const myTasksCard = myTasks.length > 0 && (
    <section ref={myTasksRef} tabIndex={-1} className="home-card home-mytasks" aria-label={t("today.myTasks")}>
      <h2>{t("today.myTasks")}</h2>
      <p className="home-mytasks__summary" aria-live="polite">
        {t("today.myTasksSummary", { visible: visibleMyTasks.length, count: myTasks.length })}
      </p>
      <div className="home-mytasks__list" id={myTasksListId}>
        {visibleMyTasks.map((task) => {
          const key = taskKey(task, member.chapterId);
          const due = task.dueDate
            ? new Date(`${task.dueDate}T00:00:00`).toLocaleDateString(localeFor(lang), { month: "short", day: "numeric" })
            : null;
          const meta = [
            key,
            t(`tasks.status.${task.status}`),
            due ? t("today.myTasksDue", { date: due }) : null,
          ].filter(Boolean).join(" · ");
          return (
            <article className="home-mytask" key={task.id}>
              <span className="home-mytask__icon" aria-hidden="true"><ListChecks size={18} /></span>
              <span className="home-mytask__copy">
                <strong>{task.title}</strong>
                <small>{meta}</small>
              </span>
              {task.blocked ? <span className="home-mytask__blocked">{t("today.myTasksBlocked")}</span> : null}
            </article>
          );
        })}
      </div>
      {myTasksCanExpand ? (
        <button
          className="home-mytasks__toggle"
          type="button"
          aria-controls={myTasksListId}
          aria-expanded={myTasksExpanded}
          onClick={() => setMyTasksExpanded((expanded) => !expanded)}
        >
          {myTasksExpanded
            ? t("today.myTasksShowFewer")
            : t("today.myTasksShowAll", { count: myTasks.length })}
        </button>
      ) : null}
      {/* Says plainly why there is no control here. A member holds no write
          grant on chapter_tasks, so an affordance would only fail. */}
      <p className="home-mytasks__note">{t("today.myTasksNote")}</p>
    </section>
  );

  // REQ-UG-MEMBER-WHAT-MATTERS-NOW-20261001: one ranked next action per
  // visit, the same on desktop and phone. A case action opens that case.
  const whatMattersCard = (
    <WhatMattersNowCard
      data={data}
      onOpenCase={onOpenCases ? (caseId) => onOpenCases(caseId) : null}
      onVote={onPlanAction ?? null}
      onOpenEvents={onOpenEvents ? () => onOpenEvents() : null}
      onOpenNotices={homeTakeover?.onOpenBroadcast ?? onOpenMessages}
      onOpenTasks={myTasks.length ? (taskId) => {
        if (!visibleMyTasks.some((task) => String(task.id) === taskId)) setMyTasksExpanded(true);
        myTasksRef.current?.scrollIntoView?.({ block: "start" });
        myTasksRef.current?.focus({ preventScroll: true });
      } : null}
      onOpenStewardDesk={onSwitchHat ? () => onSwitchHat("steward") : null}
    />
  );
  // REQ-UG-HOME-NUDGES-20261001: at most one nudge (onboarding, then
  // passkey), never during the welcome tour, the same on desktop and phone.
  const guidance = (
    <HomeGuidanceSlot choosePassword={choosePassword} onboardingHud={onboardingHud}>
      {homeNudges ? <HomeNudgeSlot data={data} transport={learningContent} {...homeNudges} /> : null}
    </HomeGuidanceSlot>
  );

  // One compact card, the same on desktop and phone (content parity).
  const learningCard = learningContent ? <LearningHomeCard {...learningContent} /> : null;

  const stewardCard = (
    <StewardCard
      // A member with no campaign, or an admin who can name one, gets the step
      // that applies to them instead of the generic empty line.
      emptyKey={homeEmptyStewardKey(data, "today.findStewardEmpty")}
      stewards={data.chapterStewards}
      onContactSteward={onContactSteward}
      onOpenOrgStructure={onOpenOrgStructure}
    />
  );

  const parityActions = (onAssistant || onOpenWorkload || (activeCase && onOpenCases)) && (
    <section className="home-card home-parity-actions" aria-label={t("today.nextTwo")}>
      {onOpenWorkload && (
        <button className="home-row" type="button" onClick={onOpenWorkload}>
          <span className="home-row__icon" aria-hidden="true"><TimerReset size={18} /></span>
          <span className="home-row__copy"><strong>{t("today.logWorkload")}</strong><small>{t("today.logWorkloadSub")}</small></span>
        </button>
      )}
      {onAssistant && (
        <button className="home-row home-row--compass" type="button" onClick={onAssistant}>
          <span className="home-row__icon" aria-hidden="true"><Compass size={18} /></span>
          <span className="home-row__copy"><strong>{t("today.askCompass")}</strong><small>{t("today.askCompassSub")}</small></span>
          <span className="home-row__chev" aria-hidden="true">›</span>
        </button>
      )}
      {activeCase && onOpenCases && (
        <button className="home-row" type="button" onClick={onOpenCases}>
          <span className="home-row__icon" aria-hidden="true"><FolderKanban size={18} /></span>
          <span className="home-row__copy"><strong>{t("today.checkCase")}</strong><small>{[activeCase.reference, activeCase.deadline].filter(Boolean).join(" · ")}</small></span>
          <i className="home-row__alert" aria-hidden="true" />
        </button>
      )}
    </section>
  );

  // ---- Desktop: the prototype's dashboard canvas ----
  if (desktop) {
    const openVote = heroBallot;
    const weeklyRows = weekActionRows(actionPlanItems, now.getTime());
    return (
      <div className="screen screen--today home home--desktop">
        <header className="home-ph">
          <div>
            <h1>{t(homeGreetingKey(data), { name: member.firstName })}</h1>
            <p className="today-identity">{[todayLabel, ...identityLabels].join(" · ")}</p>
            <p className="today-identity">{voiceAvailabilityLabel(planItems, t, data.organizationSurveys)}</p>
          </div>
          {onOpenSearch && <button className="home-search" type="button" onClick={onOpenSearch}><Search size={16} aria-hidden="true" />{t("today.searchLocal")}</button>}
        </header>
        <SetupTwoStepNotice staffMfa={data.staffMfa} home />
        {/* REQ-UG-HOME-OVERRIDE-UNREAD-STEWARD-MESSAGE-20261001 */}
        {homeTakeover && <HomeTakeover data={data} transport={learningContent} {...homeTakeover} />}
        {issueSignals && <IssueSignalBanner issueSignals={issueSignals} surface="today" />}
        {compassPins}

        <section className="home-mobile-overview" aria-label={t("today.participationEyebrow")}>
          {overviewTiles.map((tile) => <article className="home-tile" key={tile.key}><strong>{tile.value}</strong><span>{tile.label}</span></article>)}
        </section>
        {campaignCard}
        {participationCard}
        {whatMattersCard}

        <div className={weeklyRows.length > 0 ? "home-grid" : undefined}>
          {weeklyRows.length > 0 && (
            <section className="home-card home-actions" aria-label={t("today.weekActions")}>
              <header className="home-actions__head">
                <h2>{t("today.weekActions")}</h2>
              </header>
              <div id={actionsListId}>
                {(showAllActions ? actionPlanItems : weeklyRows).map((item) => (
                  <article className="home-action-row" key={item.id}>
                    <span className="home-action-row__icon" aria-hidden="true"><PlanKindIcon kind={item.kind} /></span>
                    <div>
                      <strong className={item.closed ? "home-action-row--done" : undefined}>{item.title}</strong>
                      <small>{item.meta}</small>
                      {item.quorum?.quorumTarget ? <small className="plan-row__quorum">{t("today.quorumVoted", { votes: item.quorum.totalVotes, target: item.quorum.quorumTarget })}</small> : null}
                      {item.receiptCode ? <small className="plan-row__receipt">{t("today.receipt", { code: item.receiptCode })}</small> : null}
                    </div>
                    <button className="home-action-row__cta" type="button" disabled={Boolean(item.closed)} onClick={() => onPlanAction(item)}>{item.kind === "ballot" && item.receiptCode ? t("data.voted") : item.action} ›</button>
                  </article>
                ))}
              </div>
              {!showAllActions && actionPlanItems.length > weeklyRows.length && (
                <button type="button" className="dialog-secondary" aria-expanded={false} aria-controls={actionsListId} onClick={() => setShowAllActions(true)}>
                  {t("today.feedShowAll", { count: actionPlanItems.length })}
                </button>
              )}
            </section>
          )}

          <aside className="home-side" aria-label={t("today.comingUp")}>
            {openVote && (
              <section className="home-card home-vote" aria-label={t("today.openVote")}>
                <div className="home-vote__head"><Vote size={17} aria-hidden="true" /><strong>{t("today.openVote")}</strong><span className="home-vote__closes">{openVote.meta}</span></div>
                <h2>{openVote.title}</h2>
                <div className="home-vote__row">
                  <button className="home-vote__cta" type="button" onClick={() => onPlanAction(openVote)}>{t("today.castVote")}</button>
                  <button className="home-vote__alt" type="button" onClick={() => onPlanAction(openVote)}>{t("today.readSummary")}</button>
                </div>
                {openVote.quorum?.quorumTarget ? <p className="home-vote__caption">{t("today.quorumVoted", { votes: openVote.quorum.totalVotes, target: openVote.quorum.quorumTarget })} · {t("today.tapForDetails")} ›</p> : null}
              </section>
            )}
            {receiptCard}
            {guidance}
            {learningCard}
            {stewardCard}
            {myTasksCard}
            {comingUp.length > 0 && (
              <section className="home-card home-coming">
                <h2>{t("today.comingUp")}</h2>
                <div className="home-coming__list">
                  {comingUp.map((event) => {
                    const badge = eventBadge(event, lang);
                    const Row = onOpenEvents ? "button" : "div";
                    return (
                      <Row className="home-event" key={event.id} {...(onOpenEvents ? { type: "button", onClick: onOpenEvents } : {})}>
                        <span className="home-event__badge" aria-hidden="true">{badge ? <><b>{badge.day}</b><small>{badge.month}</small></> : <CalendarDays size={18} />}</span>
                        <span className="home-event__copy"><strong>{event.title}</strong><small>{eventWhen(event, lang)}{event.location ? ` · ${event.location}` : ""}</small></span>
                        <span className="home-event__chev" aria-hidden="true">›</span>
                      </Row>
                    );
                  })}
                </div>
                {onOpenEvents && <button className="home-allevents" type="button" onClick={onOpenEvents}>{t("today.allEvents")} ›</button>}
              </section>
            )}
          </aside>
        </div>
        {parityActions}
        <HomeFeedSection data={data} onOpenMessages={onOpenMessages} />
        {homeGuides}
      </div>
    );
  }

  // ---- Phone: the prototype's native mobile Home ----
  return (
    <div className="screen screen--today home">
      {/* No .home-topbar here: the logo, organization-and-role line, steward hat
          pill, bell and avatar are the SHELL's global mobile top bar now, and
          the prototype's mpg.home page content (line 522 ff.) starts straight
          at the date line + greeting — everything below is page content. */}
      <SetupTwoStepNotice staffMfa={data.staffMfa} home />
      {compassPins}
      <div className="home-greet">
        <span className="home-date">{todayLabel}</span>
        <h1>{t(greetingKey, { name: member.firstName })} 👋</h1>
        <p>{[t("today.greetSub"), ...identityLabels].join(" · ")}</p>
        <p>{voiceAvailabilityLabel(planItems, t, data.organizationSurveys)}</p>
        <div className="home-chips">
          {onOpenReports && <button className="home-chip home-chip--dark" type="button" onClick={onOpenReports}><ChartNoAxesColumnIncreasing size={16} aria-hidden="true" /> {t("today.myReports")}</button>}
          {onOpenSearch && <button className="home-chip" type="button" onClick={onOpenSearch}><Search size={16} aria-hidden="true" /> {t("today.searchLocal")}</button>}
        </div>
      </div>
      {/* REQ-UG-HOME-OVERRIDE-UNREAD-STEWARD-MESSAGE-20261001 */}
      {homeTakeover && <HomeTakeover data={data} transport={learningContent} {...homeTakeover} />}

      <section className="home-mobile-overview" aria-label={t("today.participationEyebrow")}>
        {overviewTiles.map((tile) => <article className="home-tile" key={tile.key}><strong>{tile.value}</strong><span>{tile.label}</span></article>)}
      </section>

      {campaignCard}
      {participationCard}
      {whatMattersCard}
      {issueSignals && <IssueSignalBanner issueSignals={issueSignals} surface="today" />}
      {heroVoteCard}
      {receiptCard}
      {secondVoteCard}
      {quorumCard}
      {/* BUG-UG-PHONE-WEB-HOME-HIDES-ONBOARDING-GUIDE-20261018: the
          onboarding guide card rides in the prompt slot, as on desktop (the
          server already suppresses the onboarding nudge while the guide is
          active). */}
      {guidance}
      {learningCard}
      {stewardCard}
      {myTasksCard}

      {(quickItems.length > 0 || onAssistant || (activeCase && onOpenCases) || onOpenWorkload) && (
        <section aria-label={t("today.nextTwo")}>
          <div className="home-section-label">{t("today.nextTwo")}</div>
          <div className="home-rows">
            {onOpenWorkload && (
              <button className="home-row" type="button" onClick={onOpenWorkload}>
                <span className="home-row__icon" aria-hidden="true"><TimerReset size={18} /></span>
                <span className="home-row__copy"><strong>{t("today.logWorkload")}</strong><small>{t("today.logWorkloadSub")}</small></span>
              </button>
            )}
            {quickItems.map((item) => (
              <button className="home-row" type="button" key={item.id} disabled={Boolean(item.closed)} onClick={() => onPlanAction(item)}>
                <span className="home-row__icon" aria-hidden="true"><PlanKindIcon kind={item.kind} /></span>
                <span className="home-row__copy"><strong>{item.title}</strong>{" "}<small>{item.kind === "ballot" && item.receiptCode ? t("data.voted") : item.meta}</small></span>
                <span className="home-row__chev" aria-hidden="true">›</span>
              </button>
            ))}
            {onAssistant && (
              <button className="home-row home-row--compass" type="button" onClick={onAssistant}>
                <span className="home-row__icon" aria-hidden="true"><Compass size={18} /></span>
                <span className="home-row__copy"><strong>{t("today.askCompass")}</strong><small>{t("today.askCompassSub")}</small></span>
                <span className="home-row__chev" aria-hidden="true">›</span>
              </button>
            )}
            {activeCase && onOpenCases && (
              <button className="home-row" type="button" onClick={onOpenCases}>
                <span className="home-row__icon" aria-hidden="true"><FolderKanban size={18} /></span>
                <span className="home-row__copy"><strong>{t("today.checkCase")}</strong><small>{[activeCase.reference, activeCase.deadline].filter(Boolean).join(" · ")}</small></span>
                <i className="home-row__alert" aria-hidden="true" />
              </button>
            )}
          </div>
        </section>
      )}

      {comingUp.length > 0 && (
        <section aria-label={t("today.thisWeek")}>
          <div className="home-section-label">{t("today.thisWeek")}</div>
          <div className="home-rows">
            {comingUp.map((event) => {
              const Row = onOpenEvents ? "button" : "div";
              return (
                <Row className="home-row" key={event.id} {...(onOpenEvents ? { type: "button", onClick: onOpenEvents } : {})}>
                  <span className="home-row__icon" aria-hidden="true"><CalendarDays size={18} /></span>
                  <span className="home-row__copy"><strong>{event.title}</strong><small>{eventWhen(event, lang)}{event.location ? ` · ${event.location}` : ""}</small></span>
                  {event.rsvpStatus === "going" && <span className="home-row__rsvp">{t("today.rsvpd")} ✓</span>}
                  <span className="home-row__chev" aria-hidden="true">›</span>
                </Row>
              );
            })}
          </div>
        </section>
      )}

      <HomeFeedSection data={data} onOpenMessages={onOpenMessages} />
      {homeGuides}
    </div>
  );
}
