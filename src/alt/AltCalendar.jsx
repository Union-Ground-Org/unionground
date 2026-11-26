// The calendar widget (REQ-UG-ALT-PORT-SHELL-MOTION-HOME-20261030),
// ported from the prototype's components.js (C.calHtml, C.dayPanelHtml,
// C.monthStatsHtml, C.calBind): a Monday-first month grid with up to three
// marks a day, arrow-key day moves, month paging, type chips, the selected
// day's records and the month's statistics. It reads the member's record
// index (recordIndex.js); the prototype's "announced two weeks ahead" donut
// needs an announcement date events do not carry, so the donut shows the
// share of the month's held meetings the member checked in to; deadlines and
// date-only entries are calendar records but never count as meetings.
import { useEffect, useRef, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { localeFor } from "../lib/i18n.js";
import { eventTypeText } from "../lib/i18n/eventTypes.js";
import { Icon } from "./icons.jsx";
import { RECORD_COLOR, RECORD_TYPES, dayIndex, dayKey } from "./recordIndex.js";

const MARKS_PER_DAY = 3;

function monthLabel(year, month, lang) {
  return new Date(year, month, 1).toLocaleDateString(localeFor(lang), { month: "long", year: "numeric" });
}

function longDay(time, lang) {
  return new Date(time).toLocaleDateString(localeFor(lang), { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function clock(date, lang) {
  return date.toLocaleTimeString(localeFor(lang), { hour: "numeric", minute: "2-digit" });
}

export default function AltCalendar({ items, now = new Date(), onOpenItem = null, idPrefix = "ug-cal" }) {
  const { t, lang } = useLang();
  const today = dayKey(now);
  const [state, setState] = useState(() => ({ year: now.getFullYear(), month: now.getMonth(), sel: today, types: new Set(RECORD_TYPES) }));
  const focusSel = useRef(false);
  const gridRef = useRef(null);
  const index = dayIndex(items);
  const visible = (item) => state.types.has(item.type);

  useEffect(() => {
    if (!focusSel.current) return;
    focusSel.current = false;
    gridRef.current?.querySelector(`[data-day="${state.sel}"]`)?.focus();
  }, [state.sel, state.month, state.year]);

  const select = (time, focus = true) => {
    const date = new Date(time);
    focusSel.current = focus;
    setState((current) => ({ ...current, sel: time, year: date.getFullYear(), month: date.getMonth() }));
  };
  const page = (step) => setState((current) => {
    const first = new Date(current.year, current.month + step, 1);
    const end = new Date(first.getFullYear(), first.getMonth() + 1, 1).getTime();
    return { ...current, year: first.getFullYear(), month: first.getMonth(), sel: today >= first.getTime() && today < end ? today : first.getTime() };
  });
  const toggleType = (type) => setState((current) => {
    const types = new Set(current.types);
    if (types.has(type) && types.size > 1) types.delete(type); else types.add(type);
    return { ...current, types };
  });
  const onKeyDown = (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (!step) return;
    event.preventDefault();
    const date = new Date(state.sel);
    select(new Date(date.getFullYear(), date.getMonth(), date.getDate() + step).getTime());
  };

  const first = new Date(state.year, state.month, 1);
  const lead = (first.getDay() + 6) % 7;
  const daysIn = new Date(state.year, state.month + 1, 0).getDate();
  const cells = [];
  for (let index_ = 0; index_ < lead; index_ += 1) cells.push(<div key={`blank-${index_}`} className="ug-cal-day ug-blank" aria-hidden="true" />);
  for (let day = 1; day <= daysIn; day += 1) {
    const time = new Date(state.year, state.month, day).getTime();
    const dayItems = (index.get(time) ?? []).filter(visible);
    const selected = time === state.sel;
    const label = `${longDay(time, lang)}${time === today ? `, ${t("altShell.today")}` : ""}: ${dayItems.length ? t("altShell.calItems", { count: dayItems.length }) : t("altShell.calNothing")}`;
    cells.push(
      <button
        key={time}
        type="button"
        data-day={time}
        className={["ug-cal-day", time < today ? "ug-past" : "", time === today ? "ug-today" : "", selected ? "ug-sel" : ""].filter(Boolean).join(" ")}
        aria-label={label}
        aria-pressed={selected}
        tabIndex={selected ? 0 : -1}
        onClick={() => select(time)}
      >
        <span>{day}</span>
        <span className="ug-marks" aria-hidden="true">
          {dayItems.slice(0, MARKS_PER_DAY).map((item) => <span key={item.id} className="ug-cal-mark" style={{ background: RECORD_COLOR[item.type] }}>{t(`altShell.typeMark_${item.type}`)}</span>)}
          {dayItems.length > MARKS_PER_DAY ? <span className="ug-cal-mark ug-more">+{dayItems.length - MARKS_PER_DAY}</span> : null}
        </span>
      </button>,
    );
  }
  const weekdays = Array.from({ length: 7 }, (_, offset) => new Date(2026, 0, 5 + offset).toLocaleDateString(localeFor(lang), { weekday: "short" }));

  const selItems = (index.get(state.sel) ?? []).filter(visible);
  const monthStart = first.getTime();
  const monthEnd = new Date(state.year, state.month + 1, 1).getTime();
  const inMonth = items.filter((item) => item.at.getTime() >= monthStart && item.at.getTime() < monthEnd && visible(item));
  const counts = Object.fromEntries(RECORD_TYPES.map((type) => [type, inMonth.filter((item) => item.type === type).length]));
  const heldMeetings = items.filter((item) => item.type === "event" && item.kind === "meeting" && item.at.getTime() >= monthStart && item.at.getTime() < monthEnd && item.at.getTime() < now.getTime());
  const attended = heldMeetings.filter((item) => item.source?.checkedIn === true).length;
  const pct = heldMeetings.length ? Math.round((attended / heldMeetings.length) * 100) : 0;
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const month = monthLabel(state.year, state.month, lang);

  return (
    <div className="ug-cal-grid">
      <div>
        <div className="ug-cal">
          <div className="ug-cal-top">
            <button className="ug-cal-nav" type="button" aria-label={t("altShell.calPrev")} onClick={() => page(-1)}><Icon name="left" /></button>
            <h3 aria-live="polite">{month}</h3>
            <button className="ug-cal-nav" type="button" aria-label={t("altShell.calNext")} onClick={() => page(1)}><Icon name="right" /></button>
            <button className="ug-btn ug-btn-soft ug-btn-xs" type="button" onClick={() => select(today)}>{t("altShell.today")}</button>
          </div>
          <div className="ug-cal-dow" aria-hidden="true">{weekdays.map((day) => <div key={day}>{day}</div>)}</div>
          {/* Arrow keys move between the day buttons, as in the prototype (C.calBind). */}
          <div ref={gridRef} className="ug-cal-days" role="group" aria-label={month} onKeyDown={onKeyDown}>{cells}</div>
          <div className="ug-cal-legend">
            {RECORD_TYPES.map((type) => (
              <button key={type} type="button" className="ug-chip ug-cal-chip" aria-pressed={state.types.has(type)} onClick={() => toggleType(type)}>
                <i style={{ background: RECORD_COLOR[type] }} />{t(`altShell.typePlural_${type}`)}
              </button>
            ))}
          </div>
          <div className="ug-cal-tz">{t("altShell.calTz")}</div>
        </div>
        <div className="ug-day-panel" aria-live="polite" id={`${idPrefix}-day`}>
          <h4>{longDay(state.sel, lang)}{state.sel === today ? ` · ${t("altShell.today")}` : ""}</h4>
          {selItems.length ? selItems.map((item) => (
            <button key={item.id} type="button" className="ug-day-ev ug-as-link" aria-label={t("altShell.calOpen", { type: t(`altShell.type_${item.type}`), title: item.title })} onClick={onOpenItem ? () => onOpenItem(item) : undefined}>
              <span className="ug-av ug-av-sm" aria-hidden="true" style={{ background: RECORD_COLOR[item.type], color: "#fff" }}>{t(`altShell.typeMark_${item.type}`)}</span>
              <span><b>{item.title}</b><span>{[item.type === "event" && item.kind !== "meeting" ? eventTypeText(lang, item.kind) : clock(item.at, lang), item.sub].filter(Boolean).join(" · ")}</span></span>
              <span className="ug-tag">{t(`altShell.type_${item.type}`)}</span>
            </button>
          )) : <p className="ug-day-none">{t("altShell.calNothingDay")}</p>}
        </div>
      </div>
      <div className="ug-cal-side">
        <h4>{t("altShell.calStats", { month })}</h4>
        <div className="ug-stat-row">
          <div className="ug-stat">
            <h5>{t("altShell.calRecords")}</h5>
            <div className="ug-n ug-tnum">{inMonth.length}</div>
            <div className="ug-stackbar" aria-hidden="true">{RECORD_TYPES.map((type) => <i key={type} style={{ flex: counts[type] || 0.001, background: RECORD_COLOR[type] }} />)}</div>
            <div className="ug-kv">{RECORD_TYPES.map((type) => <span key={type}>{t(`altShell.typePlural_${type}`)}<span>{counts[type]}</span></span>)}</div>
          </div>
          <div className="ug-stat">
            <h5>{t("altShell.calAttended")}</h5>
            <div className="ug-donut-wrap">
              <svg className="ug-donut" viewBox="0 0 84 84" role="img" aria-label={t("altShell.calAttendedLabel", { pct })}>
                <circle cx="42" cy="42" r={radius} fill="none" stroke="var(--ug-panel)" strokeWidth="12" />
                <circle cx="42" cy="42" r={radius} fill="none" stroke="var(--ug-hero)" strokeWidth="12" strokeDasharray={`${((pct / 100) * circumference).toFixed(1)} ${circumference.toFixed(1)}`} transform="rotate(-90 42 42)" strokeLinecap="round" />
                <text x="42" y="47" textAnchor="middle" style={{ font: "600 16px var(--ug-display)", fill: "var(--ug-ink)" }}>{pct}%</text>
              </svg>
              <p>{t("altShell.calAttendedBody", { attended, total: heldMeetings.length })}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
