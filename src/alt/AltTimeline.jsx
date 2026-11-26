// The Home timeline (REQ-UG-ALT-PORT-SHELL-MOTION-HOME-20261030),
// ported from the prototype's components.js C.timeline and the controls in
// pages/home.js: one track per row, a tick per record with its tooltip, the
// 30/60/90-day range and an axis of month starts. The prototype's rows are
// chapters' wins; a member's snapshot holds their own record, so the rows
// are its kinds (updates, meetings, votes, case notes).
import { useEffect, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { Icon } from "./icons.jsx";
import { formatShortDay } from "./format.js";
import { DAY, RECORD_COLOR, RECORD_TYPES, dayKey, itemsInLastDays, timelineDaysFor } from "./recordIndex.js";
import "./styles/timeline.css";

const ROW_ICON = { update: "megaphone", event: "calendar", vote: "ballot", case: "briefcase" };
const RANGES = [30, 60, 90];

function axisMarks(days, now, lang, width) {
  const end = dayKey(now);
  const from = end - (days - 1) * DAY;
  const span = days * DAY;
  const gap = width < 760 ? 34 : width < 1080 ? 18 : 10;
  const marks = [{ p: 0, label: formatShortDay(new Date(from), lang) }];
  for (let day = from + DAY; day < end; day += DAY) {
    const date = new Date(day);
    if (date.getDate() !== 1) continue;
    const p = ((day - from) / span) * 100;
    if (p - marks[marks.length - 1].p >= gap && p <= 100 - gap) marks.push({ p, label: formatShortDay(date, lang) });
  }
  marks.push({ p: 100, label: null });
  return { from, span, marks };
}

// Records of one row grouped by their local day, oldest first.
function groupByDay(rows) {
  const groups = new Map();
  for (const item of rows) {
    const key = dayKey(item.at);
    if (!groups.has(key)) groups.set(key, { key, at: item.at, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}

export default function AltTimeline({ items, now = new Date(), width = typeof window === "undefined" ? 1280 : window.innerWidth, onOpenItem = null, onOpenType = null }) {
  const { t, lang } = useLang();
  const [days, setDays] = useState(() => timelineDaysFor(width));
  const [openDay, setOpenDay] = useState(null);
  const recent = itemsInLastDays(items, days, now);
  const { from, span, marks } = axisMarks(days, now, lang, width);
  // An open day list closes on a press anywhere else, as the prototype's
  // flyouts do (core.js: the chapter rail's pointerdown and focusout).
  useEffect(() => {
    if (!openDay) return undefined;
    const onPointerDown = (event) => {
      if (!event.target?.closest?.(`[data-ug-day="${openDay}"]`)) setOpenDay(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openDay]);
  const position = (date) => Math.max(0.6, Math.min(99.4, ((dayKey(date) - from + DAY / 2) / span) * 100));

  return (
    <div className="ug-wrap">
      <section className="ug-tl" aria-labelledby="ug-tl-h">
        <div className="ug-tl-head">
          <h2 id="ug-tl-h">{t("altShell.tlTitle", { days })}</h2>
          <div className="ug-tl-tools">
            <div className="ug-legend">
              {RECORD_TYPES.map((type) => <span key={type}><i style={{ background: RECORD_COLOR[type] }} />{t(`altShell.type_${type}`)}</span>)}
            </div>
            <div className="ug-seg" role="group" aria-label={t("altShell.tlRange")}>
              {RANGES.map((range) => (
                <button key={range} type="button" aria-pressed={range === days} onClick={() => setDays(range)}>{t("altShell.tlDays", { days: range })}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="ug-tl-rows">
          {RECORD_TYPES.map((type) => {
            const rows = recent.filter((item) => item.type === type);
            const label = t(`altShell.type_${type}`);
            return (
              <div className="ug-tl-row" key={type}>
                {onOpenType ? (
                  <button type="button" className="ug-tl-name ug-as-link" onClick={() => onOpenType(type)}>
                    <span className="ug-av ug-av-sm" aria-hidden="true" style={{ background: RECORD_COLOR[type], color: "#fff" }}><Icon name={ROW_ICON[type]} /></span><span>{label}</span>
                  </button>
                ) : (
                  <span className="ug-tl-name"><span className="ug-av ug-av-sm" aria-hidden="true" style={{ background: RECORD_COLOR[type], color: "#fff" }}><Icon name={ROW_ICON[type]} /></span><span>{label}</span></span>
                )}
                <div className="ug-tl-track" role="group" aria-label={t("altShell.tlTrack", { label, count: rows.length, days })}>
                  {/* The dated marks retain the chart. Equivalent named day
                      controls below it stay large enough even for dense dates. */}
                  <div className="ug-tl-marks" aria-hidden="true">
                    {groupByDay(rows).map(({ key, at }) => <span key={key} className="ug-tick" style={{ left: `${position(at).toFixed(2)}%`, background: RECORD_COLOR[type] }} />)}
                  </div>
                  <div className="ug-tl-record-controls">
                  {/* One tick per day: records that share a day share a slot, so
                      a busy day is one control that lists every record on it. */}
                  {groupByDay(rows).map(({ key, at, items: dayItems }) => {
                    const day = formatShortDay(at, lang);
                    if (dayItems.length === 1) {
                      const item = dayItems[0];
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className="ug-tl-record-control"
                          data-tip={`${day}: ${label}`}
                          data-tip-sub={item.title}
                          aria-label={`${day}, ${label}: ${item.title}`}
                          onClick={onOpenItem ? () => onOpenItem(item) : undefined}
                        >{day}</button>
                      );
                    }
                    const popKey = `${type}-${key}`;
                    const open = openDay === popKey;
                    const popId = `ug-tl-pop-${popKey}`;
                    return (
                      <span
                        key={popKey}
                        className="ug-tl-record-day"
                        data-ug-day={popKey}
                        // Focus moving to another control closes it; a press on a
                        // row (no relatedTarget in Safari) is left to the click.
                        onBlur={(event) => { if (open && event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpenDay(null); }}
                      >
                        <button
                          type="button"
                          className="ug-tl-record-control ug-tick-many"
                          data-tip={`${day}: ${t("altShell.tlDayCount", { count: dayItems.length, label })}`}
                          aria-label={`${day}, ${t("altShell.tlDayCount", { count: dayItems.length, label })}`}
                          aria-expanded={open}
                          aria-controls={open ? popId : undefined}
                          onClick={() => setOpenDay(open ? null : popKey)}
                          onKeyDown={(event) => { if (event.key === "Escape" && open) { event.preventDefault(); setOpenDay(null); } }}
                        >{day} · {dayItems.length}</button>
                        {open ? (
                          <ul className="ug-tl-pop" id={popId} aria-label={`${day}, ${label}`} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setOpenDay(null); event.currentTarget.previousElementSibling?.focus(); } }}>
                            {dayItems.map((item) => (
                              <li key={item.id}>
                                <button type="button" onClick={() => { setOpenDay(null); onOpenItem?.(item); }}>{item.title}</button>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </span>
                    );
                  })}
                  </div>
                </div>
                <div className="ug-tl-count ug-tnum"><span>{rows.length}</span></div>
              </div>
            );
          })}
        </div>
        <div className="ug-tl-axis" aria-hidden="true">
          <span />
          <div className="ug-ax">{marks.map((mark) => <span key={mark.p} style={{ left: `${mark.p}%` }}>{mark.label ?? t("altShell.today")}</span>)}</div>
          <span />
        </div>
        {recent.length === 0 ? <p className="ug-tl-empty">{t("altShell.tlEmpty", { days })}</p> : null}
      </section>
    </div>
  );
}
