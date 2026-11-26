// The prototype's Chapters pages (pages/chapters.js: the directory and a
// chapter's own page) as the alternate shell's My chapter
// (REQ-UG-ALT-PORT-MEMBER-PAGES-20261030, E2). The hero, figures
// row, chapter cards, the 90-day timeline and the split of panels carry over,
// each on the member's own snapshot: their chapter memberships (and the live
// chapter switch App hands the hub), the chapter's channels and issue
// threads, its record entries, upcoming meetings, stewards and contract
// documents. The hub's own sections, staff controls included, sit in the
// "Chapter workspace" panel unchanged. The directory's other chapters are
// the organization's chapters the member can read and does not belong to
// (data.chapterDirectory, REQ-UG-ALT-MEMBER-PAGES-SERVER-DATA-20261030);
// they are listed by name and open nothing, since a member has
// no page for a chapter they are not in. Surfaces the prototype draws from
// sample data with no backend here (the card campaign, the chapter's About
// text) keep their place and say so.
import { BusyButton } from "../../components/BusyControls.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";
import { postBody, spaceName } from "../../lib/bilingualContent.js";
import { normalizeLiveChapters } from "../../lib/chapterRail.js";
import { localeFor } from "../../lib/i18n.js";
import { ChapterAvatar, Icon } from "../icons.jsx";
import { formatClock, formatDay, formatShortDay, relativeTime, toDate } from "../format.js";
import { DAY, dayKey } from "../recordIndex.js";
import AltPageKpis from "../AltPageKpis.jsx";
import AltCrumbs from "./AltCrumbs.jsx";
import "../../lib/i18n/features/altRecordPagesStrings.js";

const TIMELINE_DAYS = 90;
const LATEST = 8;
const MEETINGS = 3;
const SETTLED_RECORDS = new Set(["decision", "milestone"]);
const THREAD_TAG = { issue: "ug-t-rights", decision: "ug-t-vote", topic: "ug-t-meeting" };
// chapter_threads.status is open, resolved or closed.
const STATUS_TAG = { open: "ug-t-rights", resolved: "ug-t-win", closed: "ug-t-action" };

function threadAt(thread) {
  const times = [thread.updated_at, thread.created_at, ...(thread.posts || []).map((post) => post.created_at)]
    .map(toDate)
    .filter(Boolean)
    .map((date) => date.getTime());
  return times.length ? new Date(Math.max(...times)) : null;
}

function initials(name) {
  return String(name || "").split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
}

function upcomingMeetings(events, now) {
  return (events || [])
    .filter((event) => !event.cancelledAt && event.isPast !== true && (event.eventKind ?? "meeting") === "meeting")
    .map((event) => ({ event, at: toDate(event.startsAt) ?? toDate(event.eventDate) }))
    .filter((row) => row.at && row.at.getTime() >= dayKey(now))
    .sort((left, right) => left.at - right.at)
    .slice(0, MEETINGS);
}

export default function AltChapterPage({
  data,
  product = {},
  chapterSwitch = null,
  onOpenThread,
  onOpenDocument,
  onAssistant = null,
  onOpenHome = null,
  workspace = null,
  now: nowProp = null,
}) {
  const { t, lang } = useLang();
  const now = nowProp ?? new Date();
  // App's live chapter switch carries the rail's memberships and the guarded
  // selector; without it (the fixture demo) the member's own memberships show.
  const switchProps = chapterSwitch?.props ?? {};
  const chapters = Array.isArray(switchProps.chapters) ? switchProps.chapters : normalizeLiveChapters(data?.member);
  const onSelect = typeof switchProps.onSelect === "function" && chapters.length > 1 ? switchProps.onSelect : null;
  const selectedId = switchProps.selectedId ?? data?.member?.chapterId ?? chapters[0]?.id ?? null;
  const chapter = chapters.find((row) => row.id === selectedId) ?? chapters[0] ?? null;
  const name = chapter?.name || "";

  const spaces = product.spaces || [];
  const threads = spaces.flatMap((space) => (space.threads || []).map((thread) => ({ thread, space, at: threadAt(thread) })));
  const latest = [...threads].sort((left, right) => (right.at?.getTime() ?? 0) - (left.at?.getTime() ?? 0)).slice(0, LATEST);
  const issues = threads.filter((row) => row.thread.kind === "issue");
  const meetings = upcomingMeetings(data?.events, now);
  const stewards = Array.isArray(data?.chapterStewards) ? data.chapterStewards : [];
  const contracts = (product.documents || []).filter((document) => document.document_type === "contract");
  // Null while the directory is unknown (a failed read, the fixture demo):
  // the card then says the directory is not available rather than "none".
  const mine = new Set(chapters.map((row) => row.id));
  const others = Array.isArray(data?.chapterDirectory)
    ? data.chapterDirectory.filter((row) => row?.id && row?.name && !mine.has(row.id))
    : null;

  const end = dayKey(now);
  const from = end - (TIMELINE_DAYS - 1) * DAY;
  const span = TIMELINE_DAYS * DAY;
  const records = (product.records || [])
    .map((record) => ({ record, at: toDate(record.occurred_at) }))
    .filter((row) => row.at && dayKey(row.at) >= from && dayKey(row.at) <= end)
    .sort((left, right) => left.at - right.at);
  const settled = records.filter((row) => SETTLED_RECORDS.has(row.record.record_type)).length;
  const position = (at) => Math.max(0.6, Math.min(99.4, ((dayKey(at) - from + DAY / 2) / span) * 100));
  const lastRecord = records[records.length - 1] ?? null;

  return (
    <>
      <section className="ug-page-hero ug-rec-hero">
        <div className="ug-wrap">
          <AltCrumbs title={t("nav.myChapter")} onOpenHome={onOpenHome} />
          <div className="ug-rec-ch-head">
            {chapter ? <ChapterAvatar chapter={chapter} size="av-xl" /> : null}
            <div className="ug-rec-ch-title">
              {name
                ? <h1>{name}</h1>
                : <h1>{t("altRecordPages.chH1Lead")}<span className="ug-accent">{t("altRecordPages.chH1Accent")}</span></h1>}
              <p className="ug-lede">{t("altShell.pageLede_chapters")}</p>
            </div>
            {onAssistant ? (
              <div className="ug-btn-row">
                <button className="ug-btn ug-btn-dark" type="button" onClick={onAssistant}><Icon name="sparkle" />{t("header.assistant")}</button>
              </div>
            ) : null}
          </div>
        </div>
      </section>
      <AltPageKpis view="hub" data={data} now={now} />
      <section className="ug-wrap ug-rec-dir" aria-labelledby="ug-rec-dir-h">
        <h2 id="ug-rec-dir-h" className="ug-rec-section-h">{t("altRecordPages.chYours")}</h2>
        <div className="ug-ch-grid ug-rec-ch-grid">
          {chapters.map((row) => {
            const selected = row.id === selectedId;
            const body = (
              <>
                <span className="ug-ch-top"><ChapterAvatar chapter={row} /><span><b>{row.name}</b><span>{t(selected ? "altRecordPages.chSelected" : onSelect ? "altRecordPages.chSwitch" : "altRecordPages.chMember")}</span></span></span>
                {selected ? <span className="ug-tag ug-t-win ug-rec-ch-mark"><Icon name="check" />{t("altRecordPages.chOpenNow")}</span> : null}
              </>
            );
            return onSelect ? (
              <BusyButton key={row.id} type="button" className="ug-ch-card ug-rec-ch-card" aria-pressed={selected} pending={switchProps.busy === true} aria-label={t("chapterRail.open", { name: row.name })} onClick={() => onSelect(row)}>{body}</BusyButton>
            ) : (
              <div key={row.id} className="ug-ch-card ug-rec-ch-card ug-rec-static">{body}</div>
            );
          })}
          {chapters.length ? null : <div className="ug-ch-card ug-rec-static ug-rec-ch-none"><b>{t("altRecordPages.chNone")}</b><span>{t("altRecordPages.chNoneBody")}</span></div>}
        </div>
      </section>
      <section className="ug-wrap ug-rec-dir" aria-labelledby="ug-rec-dir-others-h">
        <h2 id="ug-rec-dir-others-h" className="ug-rec-section-h">{t("altRecordPages.chOthers")}</h2>
        <div className="ug-ch-grid ug-rec-ch-grid">
          {(others ?? []).map((row) => (
            <div key={row.id} className="ug-ch-card ug-rec-ch-card ug-rec-static ug-rec-ch-other">
              <span className="ug-ch-top"><ChapterAvatar chapter={row} /><span><b>{row.name}</b><span>{t("altRecordPages.chOtherNoRegion")}</span></span></span>
            </div>
          ))}
          {others?.length ? null : <div className="ug-ch-card ug-rec-static ug-rec-ch-none"><span>{t(others ? "altRecordPages.chOthersNone" : "altRecordPages.chOthersBody")}</span></div>}
        </div>
      </section>
      <section className="ug-wrap">
        <div className="ug-tl ug-rec-tl">
          <div className="ug-tl-head">
            <h2>{t("altRecordPages.chTimelineH2", { days: TIMELINE_DAYS })}</h2>
            <div className="ug-legend"><span><i className="ug-rec-key-win" />{t("altRecordPages.chKeySettled")}</span><span><i className="ug-rec-key-act" />{t("altRecordPages.chKeyNotes")}</span></div>
          </div>
          <div className="ug-tl-rows">
            <div className="ug-tl-row">
              <span className="ug-tl-name">{chapter ? <ChapterAvatar chapter={chapter} size="av-sm" /> : null}<span>{name || t("nav.myChapter")}</span></span>
              <div className="ug-tl-track" role="img" aria-label={t("altRecordPages.chTrackLabel", { count: records.length, days: TIMELINE_DAYS })}>
                {records.map(({ record, at }) => (
                  <span
                    key={record.id}
                    className={`ug-tick${SETTLED_RECORDS.has(record.record_type) ? "" : " ug-act"}`}
                    style={{ left: `${position(at).toFixed(2)}%` }}
                    data-tip={`${formatDay(at, lang)}: ${t(`records.type.${record.record_type}`)}`}
                    data-tip-sub={record.title || ""}
                    aria-hidden="true"
                  />
                ))}
              </div>
              <div className="ug-tl-count ug-tnum"><span>{settled}</span>{records.length - settled ? <span className="ug-plus">+{records.length - settled}</span> : null}</div>
            </div>
          </div>
          <div className="ug-tl-axis" aria-hidden="true"><span /><div className="ug-ax"><span style={{ left: "0%" }}>{formatShortDay(new Date(from), lang)}</span><span style={{ left: "100%" }}>{t("altRecordPages.chToday")}</span></div><span /></div>
          <p className="ug-rec-tl-sum">{lastRecord
            ? t("altRecordPages.chTimelineLast", { date: formatDay(lastRecord.at, lang, { year: true }), ago: relativeTime(lastRecord.at, t, now), count: records.length })
            : t("altRecordPages.chTimelineNone", { days: TIMELINE_DAYS })}</p>
        </div>
      </section>
      <section className="ug-wrap ug-split ug-rec-split">
        <div className="ug-rec-col">
          <div className="ug-panel">
            <h2>{name ? t("altRecordPages.chLatestFrom", { name }) : t("altRecordPages.chLatest")}</h2>
            {latest.length ? (
              <ul className="ug-list">
                {latest.map(({ thread, space, at }) => (
                  <li key={thread.id}>
                    <button type="button" className="ug-li ug-li-tag ug-rec-li-btn" onClick={() => onOpenThread?.(thread)}>
                      <span className={`ug-tag ${THREAD_TAG[thread.kind] ?? "ug-t-bargaining"}`}>{t(THREAD_TAG[thread.kind] ? `hub.kind.${thread.kind}` : `altRecordPages.chKind_${thread.kind}`)}</span>
                      <span><b>{thread.title}</b><span>{[spaceName(space, lang), t((thread.posts?.length || 0) === 1 ? "altRecordPages.chPostsOne" : "altRecordPages.chPostsMany", { count: thread.posts?.length || 0 }), at ? relativeTime(at, t, now) : ""].filter(Boolean).join(" · ")}</span></span>
                      <Icon name="right" className="ug-rec-go" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : <div className="ug-empty ug-rec-empty"><b>{t("altRecordPages.chLatestNone")}</b><span>{t("altRecordPages.chLatestNoneBody")}</span></div>}
          </div>
          <div className="ug-panel">
            <h2>{t("altRecordPages.chIssuesH2")}</h2>
            {issues.length ? (
              <div className="ug-rec-issues">
                {issues.map(({ thread }) => (
                  <button key={thread.id} type="button" className="ug-rec-issue" onClick={() => onOpenThread?.(thread)}>
                    <span className="ug-rec-issue-top"><b>{thread.title}</b><span className={`ug-tag ${STATUS_TAG[thread.status] ?? STATUS_TAG.open}`}>{t(`altRecordPages.chStatus_${STATUS_TAG[thread.status] ? thread.status : "open"}`)}</span></span>
                    {thread.posts?.[0]?.body ? <span className="ug-rec-issue-body">{postBody(thread.posts[0], lang)}</span> : null}
                  </button>
                ))}
              </div>
            ) : <div className="ug-empty ug-rec-empty"><b>{t("altRecordPages.chIssuesNone")}</b><span>{t("altRecordPages.chIssuesNoneBody")}</span></div>}
          </div>
          <div className="ug-panel">
            <h2>{t("altRecordPages.chWorkspaceH2")}</h2>
            <div className="ug-legacy ug-rec-workspace">{workspace}</div>
          </div>
          <div className="ug-panel">
            <h2>{t("altRecordPages.chAboutH2")}</h2>
            <p className="ug-rec-muted">{t("altRecordPages.chAboutNone")}</p>
          </div>
        </div>
        <aside className="ug-rec-aside">
          <div className="ug-panel-w">
            <h3>{t("altRecordPages.chMeetingsH3")}</h3>
            {meetings.length ? (
              <ul className="ug-list">
                {meetings.map(({ event, at }) => (
                  <li key={event.id} className="ug-li ug-rec-li-two">
                    <span className="ug-av ug-av-sm ug-rec-date" aria-hidden="true"><span>{at.toLocaleDateString(localeFor(lang), { month: "short" })}</span><span>{at.getDate()}</span></span>
                    <span><b>{event.title}</b><span>{formatDay(at, lang)} · {formatClock(at, lang)}</span></span>
                  </li>
                ))}
              </ul>
            ) : <p className="ug-rec-muted">{t("altRecordPages.chMeetingsNone")}</p>}
          </div>
          <div className="ug-panel">
            <h3>{t("altRecordPages.chCampaignH3")}</h3>
            <p className="ug-rec-muted">{t("altRecordPages.chCampaignNone")}</p>
          </div>
          <div className="ug-panel">
            <h3>{t("altRecordPages.chLeadersH3")}</h3>
            {stewards.length ? (
              <ul className="ug-list">
                {stewards.map((steward) => (
                  <li key={steward.id} className="ug-li ug-rec-li-two">
                    <span className="ug-person" aria-hidden="true">{initials(steward.name) || <Icon name="user" />}</span>
                    <span><b>{steward.name || t("altRecordPages.chStewardUnnamed")}</b><span>{t(`today.stewardRole_${steward.roleLabel === "steward" ? "steward" : "other"}`)}</span></span>
                  </li>
                ))}
              </ul>
            ) : <p className="ug-rec-muted">{t("altRecordPages.chLeadersNone")}</p>}
          </div>
          <div className="ug-panel">
            <h3>{t("altRecordPages.chContractH3")}</h3>
            {contracts.length ? (
              <ul className="ug-list">
                {contracts.map((document) => (
                  <li key={document.id}>
                    <button type="button" className="ug-li ug-rec-li-btn ug-rec-li-two" onClick={() => onOpenDocument?.(document)}>
                      <Icon name="file" className="ug-rec-doc" />
                      <span><b>{document.title}</b>{document.summary ? <span>{document.summary}</span> : null}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="ug-rec-muted">{t("altRecordPages.chContractNone")}</p>}
          </div>
        </aside>
      </section>
    </>
  );
}
