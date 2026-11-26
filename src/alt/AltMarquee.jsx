// The Home marquee (REQ-UG-ALT-PORT-SHELL-MOTION-HOME-20261030),
// ported from the prototype's pages/home.js: two endless tracks running in
// opposite directions (70 s and 90 s), paused on hover or focus, with a
// pause control. The first track is the member's recent record; the second
// is their rights lessons, the help the snapshot actually carries. Each
// track is drawn twice for the loop; the copy is hidden and unfocusable.
// design.css's reduced-motion rule stops both tracks.
import { useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { Icon } from "./icons.jsx";
import { formatShortDay } from "./format.js";
import { RECORD_COLOR } from "./recordIndex.js";

const RECENT_ITEMS = 14;
const TYPE_ICON = { update: "megaphone", event: "calendar", vote: "ballot", case: "briefcase" };

export default function AltMarquee({ items = [], lessons = [], onOpenItem = null, onOpenLesson = null }) {
  const { t, lang } = useLang();
  const [paused, setPaused] = useState(false);
  const recent = items.filter((item) => item.type !== "case").slice(-RECENT_ITEMS).reverse();
  if (!recent.length && !lessons.length) return null;

  const recordItem = (item, copy) => (
    <button
      key={`${copy ? "copy-" : ""}${item.id}`}
      type="button"
      className="ug-mq-item ug-as-link"
      tabIndex={copy ? -1 : undefined}
      aria-hidden={copy ? "true" : undefined}
      onClick={onOpenItem ? () => onOpenItem(item) : undefined}
    >
      <span className="ug-av ug-av-xs" aria-hidden="true" style={{ background: RECORD_COLOR[item.type], color: "#fff" }}><Icon name={TYPE_ICON[item.type]} /></span>
      <b>{item.title}</b><span>{t(`altShell.type_${item.type}`).toLowerCase()} · {formatShortDay(item.at, lang)}</span>
    </button>
  );
  const lessonItem = (lesson, copy) => (
    <button
      key={`${copy ? "copy-" : ""}${lesson.id}`}
      type="button"
      className="ug-mq-item ug-as-link"
      tabIndex={copy ? -1 : undefined}
      aria-hidden={copy ? "true" : undefined}
      onClick={onOpenLesson ? () => onOpenLesson(lesson) : undefined}
    >
      <span className="ug-av ug-av-xs" aria-hidden="true" style={{ background: "#fff", color: "var(--ug-ink)" }}><Icon name="shield" /></span>
      <b>{lesson.label}</b><span>{t("altShell.knowRights").toLowerCase()}</span>
    </button>
  );
  const trackStyle = (seconds) => ({ "--ug-mq-dur": `${seconds}s`, animationPlayState: paused ? "paused" : undefined });

  return (
    <div className={`ug-marquee${paused ? " ug-paused" : ""}`} role="region" aria-label={t("altShell.mqLabel")}>
      {recent.length ? <div className="ug-mq-track" style={trackStyle(70)}>{recent.map((item) => recordItem(item, false))}{recent.map((item) => recordItem(item, true))}</div> : null}
      {lessons.length ? <div className="ug-mq-track ug-rev" style={trackStyle(90)}>{lessons.map((lesson) => lessonItem(lesson, false))}{lessons.map((lesson) => lessonItem(lesson, true))}</div> : null}
      <button type="button" className="ug-mq-pause ug-as-link" onClick={() => setPaused((value) => !value)}>
        {paused ? t("altShell.mqResume") : t("altShell.mqPause")}
      </button>
    </div>
  );
}
