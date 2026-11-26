// The prototype's All updates page (pages/updates.js) on the member's own
// record (REQ-UG-ALT-PORT-MEMBER-PAGES-20261030): its hero with the
// search, time range and type chips, the counted grid of event cards, Show
// more and the "Nothing matches" state. The records are recordIndex.js's:
// the union's messages to the member, their events, ballots and the notes
// on their own cases. Each card opens the record where the app keeps it.
// The chapter filter (REQ-UG-ALT-MEMBER-PAGES-SERVER-DATA-20261030)
// reads the chapter each event and ballot names from the snapshot, and the
// chapter of each broadcast and case from loadRecordChapters when the page
// opens, with the names from the organization's chapter directory; a
// broadcast sent to the whole organization (its audience) and a ballot,
// event or case naming no chapter sit under "Whole organization". A row
// whose chapter is not known stays under "Every chapter" only. The chips
// show only when the records name more than one place, and never name a
// chapter the directory does not. The prototype's per-record page has no counterpart: each card
// opens the record where the app keeps it.
import { useEffect, useMemo, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { loadRecordChapters } from "../lib/memberApi.js";
import { Icon } from "./icons.jsx";
import { formatClock, formatDay, formatNumber, relativeTime } from "./format.js";
import { DAY, RECORD_TYPES, dayKey } from "./recordIndex.js";

export const UPDATES_PAGE = 24;
export const UPDATE_RANGES = ["30", "90", "365", "all"];
// Chapter filter values are tagged, so a chapter whose id is "all" or "org"
// (create_admin_chapter accepts any text id) never reads as a scope.
export const EVERY_CHAPTER = "scope:all";
export const WHOLE_ORGANIZATION = "scope:org";
export const chapterFilter = (id) => `chapter:${id}`;
const TYPE_ICON = { update: "rss", event: "calendar", vote: "ballot", case: "briefcase" };
const TYPE_TAG = { update: "ug-t-action", event: "ug-t-meeting", vote: "ug-t-vote", case: "ug-t-win" };

const plainClick = (event) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

function recordBody(item) {
  const source = item.source ?? {};
  if (item.type === "update") return source.body ?? "";
  if (item.type === "event") return source.summary ?? "";
  if (item.type === "vote") return source.action ?? "";
  return item.sub ?? "";
}

function recordWho(item) {
  if (item.type === "case") return item.source?.reference ?? "";
  return item.sub ?? "";
}

// The places the records name, in the directory's order, each with its
// name: the chapters the directory knows, then the whole organization when
// any row names no chapter. Fewer than two places means there is nothing to
// filter between, so the page draws no chapter chips.
export function updateChapters(items, directory) {
  if (!Array.isArray(directory)) return [];
  const named = new Set(items.filter((item) => item.chapterId !== undefined).map((item) => item.chapterId));
  const places = directory.filter((chapter) => chapter?.id && chapter?.name && named.has(chapter.id)).map((chapter) => ({ id: chapterFilter(chapter.id), name: chapter.name }));
  if (named.has(null)) places.push({ id: WHOLE_ORGANIZATION, name: null });
  return places.length > 1 ? places : [];
}

function inChapter(item, chapter) {
  if (chapter === EVERY_CHAPTER) return true;
  if (chapter === WHOLE_ORGANIZATION) return item.chapterId === null;
  return typeof item.chapterId === "string" && chapterFilter(item.chapterId) === chapter;
}

// The item's chapter from the snapshot, else from the page's own lookup of
// broadcast and case chapters; undefined while neither says. A broadcast
// sent to the whole organization still stores its publisher's chapter, so
// its audience, not its chapter, places it (member_broadcasts'
// audience_scope; null on quarantined rows, which stay unknown).
export function withChapter(item, lookup) {
  if (item.chapterId !== undefined) return item;
  if (item.type === "update") {
    const audience = item.source?.audience ?? null;
    if (audience === "organization") return { ...item, chapterId: null };
    if (audience !== "chapter") return item;
  }
  const table = item.type === "update" ? lookup?.broadcasts : item.type === "case" ? lookup?.cases : null;
  const id = item.source?.id;
  return table && id != null && Object.hasOwn(table, id) ? { ...item, chapterId: table[id] } : item;
}

// The prototype's filtered(): type, range back from today (no upper bound,
// so what is coming stays listed), chapter and every search word.
export function filterUpdates(items, { type = "all", range = "90", q = "", chapter = EVERY_CHAPTER } = {}, now = new Date()) {
  const from = range === "all" ? -Infinity : dayKey(now) - (Number(range) - 1) * DAY;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => (type === "all" || item.type === type)
    && inChapter(item, chapter)
    && item.at.getTime() >= from
    && (!terms.length || terms.every((term) => `${item.title} ${recordWho(item)} ${recordBody(item)}`.toLowerCase().includes(term))));
}

export default function AltUpdatesPage({ items: rawItems = [], chapters = null, client = null, memberId = null, onOpenItem = null, onOpenHome = null, now: nowProp = null }) {
  const { t, lang } = useLang();
  const now = nowProp ?? new Date();
  const [type, setType] = useState("all");
  const [range, setRange] = useState("90");
  const [q, setQ] = useState("");
  const [chapter, setChapter] = useState(EVERY_CHAPTER);
  const [lookup, setLookup] = useState(null);
  const wantsLookup = Boolean(client) && Array.isArray(chapters);
  useEffect(() => {
    if (!wantsLookup) return undefined;
    let active = true;
    loadRecordChapters(client, memberId).then((value) => { if (active) setLookup(value); }, () => {});
    return () => { active = false; };
  }, [wantsLookup, client, memberId]);
  const items = useMemo(() => rawItems.map((item) => withChapter(item, lookup)), [rawItems, lookup]);
  const [shown, setShown] = useState(UPDATES_PAGE);
  // Newest first, as the prototype's feed.
  const newest = useMemo(() => [...items].sort((left, right) => right.at - left.at), [items]);
  const places = useMemo(() => updateChapters(items, chapters), [items, chapters]);
  // A chosen place the records no longer name falls back to every chapter.
  const where = places.some((place) => place.id === chapter) ? chapter : EVERY_CHAPTER;
  const base = filterUpdates(newest, { range, q, chapter: where }, now);
  const placeCount = (id) => filterUpdates(newest, { range, q, chapter: id }, now).filter((item) => type === "all" || item.type === type).length;
  const list = type === "all" ? base : base.filter((item) => item.type === type);
  const reset = (apply) => (value) => { apply(value); setShown(UPDATES_PAGE); };

  const card = (item) => {
    const past = item.at.getTime() < now.getTime();
    const body = recordBody(item);
    return (
      <button key={item.id} type="button" className="ug-ev ug-on-light ug-as-link" onClick={() => onOpenItem?.(item)}>
        <div className="ug-ev-who">
          <span className="ug-av ug-av-sm" aria-hidden="true"><Icon name={TYPE_ICON[item.type]} /></span>
          <span><b>{t(`altShell.type_${item.type}`)}</b><span>{recordWho(item)}</span></span>
        </div>
        <div className="ug-ev-kind"><span className={`ug-tag ${TYPE_TAG[item.type]}`}>{t(`altShell.typeMark_${item.type}`)}</span></div>
        <h3>{item.title}</h3>
        {body ? <p>{body}</p> : null}
        <div className="ug-ev-meta">
          <div><Icon name="calendar" /><span>{t(`altShell.updatesWhen_${item.type}${past ? "" : "Next"}`)}<b>{formatDay(item.at, lang, { year: true })} · {formatClock(item.at, lang)}</b><span>{relativeTime(item.at, t, now)}</span></span></div>
        </div>
      </button>
    );
  };

  return (
    <>
      <section className="ug-page-hero ug-alt-updates-hero">
        <div className="ug-wrap">
          <nav className="ug-crumbs" aria-label={t("altShell.crumbs")}>
            {onOpenHome ? <a href="/m" onClick={(event) => { if (!plainClick(event)) return; event.preventDefault(); onOpenHome(); }}>{t("altShell.now")}</a> : <span>{t("altShell.now")}</span>}
            <Icon name="right" /><span aria-current="page">{t("altShell.allUpdates")}</span>
          </nav>
          <h1>{t("altShell.updatesH1Lead")}<span className="ug-accent">{t("altShell.updatesH1Accent")}</span>{t("altShell.updatesH1Tail")}</h1>
          <p className="ug-lede">{t("altShell.pageLede_updates")}</p>
          <div className="ug-toolbar">
            <label className="ug-search-in">
              <span className="ug-sr">{t("altShell.updatesSearch")}</span>
              <Icon name="search" />
              <input type="search" placeholder={t("altShell.updatesSearch")} value={q} onChange={(event) => reset(setQ)(event.target.value)} />
            </label>
            <div className="ug-seg" role="group" aria-label={t("altShell.tlRange")}>
              {UPDATE_RANGES.map((value) => (
                <button key={value} type="button" aria-pressed={range === value} onClick={() => reset(setRange)(value)}>{t(`altShell.updatesRange_${value}`)}</button>
              ))}
            </div>
          </div>
          <div className="ug-chips ug-alt-updates-chips" role="group" aria-label={t("altShell.updatesType")}>
            <button className="ug-chip" type="button" aria-pressed={type === "all"} onClick={() => reset(setType)("all")}>{t("altShell.filterAll")} <span className="ug-n">{base.length}</span></button>
            {RECORD_TYPES.map((value) => (
              <button key={value} className="ug-chip" type="button" aria-pressed={type === value} onClick={() => reset(setType)(value)}>
                {t(`altShell.typePlural_${value}`)} <span className="ug-n">{base.filter((item) => item.type === value).length}</span>
              </button>
            ))}
          </div>
          {places.length ? (
            <div className="ug-chips ug-alt-updates-chips ug-alt-updates-places" role="group" aria-label={t("altShell.updatesChapter")}>
              <button className="ug-chip" type="button" aria-pressed={where === EVERY_CHAPTER} onClick={() => reset(setChapter)(EVERY_CHAPTER)}>{t("altShell.updatesChapterAll")}</button>
              {places.map((place) => (
                <button key={place.id} className="ug-chip" type="button" aria-pressed={where === place.id} onClick={() => reset(setChapter)(place.id)}>
                  {place.name ?? t("altShell.updatesChapterOrg")} <span className="ug-n">{placeCount(place.id)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </section>
      <section className="ug-wrap ug-alt-updates">
        <p className="ug-alt-updates-count" aria-live="polite">{list.length ? t("altShell.updatesShowing", { shown: formatNumber(Math.min(shown, list.length), lang), total: formatNumber(list.length, lang) }) : ""}</p>
        <div className="ug-ev-grid">
          {list.length ? list.slice(0, shown).map(card) : (
            <div className="ug-empty ug-alt-updates-empty"><b>{t("altShell.updatesNone")}</b>{t("altShell.updatesNoneBody")}</div>
          )}
        </div>
        {list.length > shown ? (
          <div className="ug-btn-row ug-alt-updates-more"><button className="ug-btn ug-btn-soft" type="button" onClick={() => setShown((count) => count + UPDATES_PAGE)}>{t("altShell.showMore")}</button></div>
        ) : null}
      </section>
    </>
  );
}
