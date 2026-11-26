import { useMemo, useRef, useState } from "react";
import { BusyButton } from "../components/BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { ChevronLeft, ChevronRight, Diamond } from "lucide-react";
import { localeFor } from "../lib/i18n.js";
import { taskKey } from "../lib/kanban.js";
import {
  addLocalDays,
  classifyDeadline,
  clipTaskDateSpan,
  localDateKey,
  monthDateWindow,
  parseLocalDateKey,
  shiftTaskDateSpan,
  taskDateSpan,
} from "../lib/taskSchedule.js";

function formatMonth(dateKey, lang) {
  return new Intl.DateTimeFormat(localeFor(lang), { month: "long", year: "numeric" })
    .format(parseLocalDateKey(dateKey));
}

function formatDay(dateKey, lang) {
  return new Intl.DateTimeFormat(localeFor(lang), { month: "short", day: "numeric" })
    .format(parseLocalDateKey(dateKey));
}

function formatWeekday(dateKey, lang) {
  return new Intl.DateTimeFormat(localeFor(lang), { weekday: "short" })
    .format(parseLocalDateKey(dateKey));
}

function urgencyLabel(urgency, t) {
  if (urgency === "completed") return t("tasks.timeline.completed");
  if (urgency === "overdue") return t("tasks.overdue");
  if (urgency === "today") return t("tasks.timeline.dueToday");
  if (urgency === "next-seven-days") return t("tasks.timeline.dueSoon");
  return null;
}

function emptyCopy(tasks, datedCount, t) {
  if (tasks.length === 0) return t("tasks.timeline.empty");
  if (datedCount === 0) return t("tasks.timeline.undated");
  return t("tasks.timeline.outside");
}

export function TaskDesktopTimeline({
  tasks,
  chapterId,
  t,
  lang,
  onOpenTask,
  onUpdateTask,
  onCreateDefault,
}) {
  const todayKey = localDateKey();
  const [anchorKey, setAnchorKey] = useState(todayKey);
  const [pending, setPending] = useState(() => new Set());
  const busyWriteRef = useRef(new Set());
  const monthWindow = useMemo(() => monthDateWindow(anchorKey), [anchorKey]);
  const rows = useMemo(() => tasks.map((task) => ({
    task,
    span: taskDateSpan(task),
    clipped: clipTaskDateSpan(task, monthWindow.startDate, monthWindow.endDate),
    urgency: classifyDeadline(task, todayKey),
  })), [monthWindow.endDate, monthWindow.startDate, tasks, todayKey]);
  const scheduled = rows.filter((row) => row.clipped);
  const datedCount = rows.filter((row) => row.span).length;
  const todayInMonth = todayKey >= monthWindow.startDate && todayKey <= monthWindow.endDate;

  function moveMonth(amount) {
    setAnchorKey(amount < 0
      ? addLocalDays(monthWindow.startDate, -1)
      : addLocalDays(monthWindow.endDate, 1));
  }

  // Synchronous per-task lock (#8435): a second move of the same task is
  // refused before React commits its pending state.
  function shift(task, amount) {
    return runBusyWrite(busyWriteRef, `shift:${task.id}`, () => shiftNow(task, amount));
  }

  async function shiftNow(task, amount) {
    const patch = shiftTaskDateSpan(task, amount);
    if (!patch || pending.has(task.id)) return;
    setPending((current) => new Set(current).add(task.id));
    try {
      await onUpdateTask(task.id, patch);
    } catch {
      // TasksView owns optimistic rollback and the shared alert. This catch is
      // only the promise boundary that prevents an unhandled rejection.
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    }
  }

  return (
    <section className="kan-timeline" aria-label={t("tasks.timeline.title")}>
      <header className="kan-timeline__head">
        <div>
          <span className="eyebrow">{t("tasks.timeline.eyebrow")}</span>
          <h3 className="task-owned">{formatMonth(monthWindow.startDate, lang)}</h3>
        </div>
        <nav className="kan-timeline__nav" aria-label={t("tasks.timeline.monthNavigation")}>
          <button className="task-owned" type="button" onClick={() => moveMonth(-1)} aria-label={t("tasks.timeline.previousMonth")}>
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <button className="task-owned" type="button" onClick={() => setAnchorKey(todayKey)}>{t("tasks.timeline.today")}</button>
          <button className="task-owned" type="button" onClick={() => moveMonth(1)} aria-label={t("tasks.timeline.nextMonth")}>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        </nav>
      </header>

      <div className="kan-timeline__scroll">
        <div className="kan-timeline__canvas" style={{ "--timeline-days": monthWindow.dayCount }}>
          <div className="kan-timeline__calendar-head">
            <span>{t("tasks.task")}</span>
            <div className="kan-timeline__days">
              {monthWindow.dates.map((dateKey) => {
                const date = parseLocalDateKey(dateKey);
                const weekend = date.getDay() === 0 || date.getDay() === 6;
                const isToday = todayInMonth && dateKey === todayKey;
                return (
                  <span
                    key={dateKey}
                    className={`kan-timeline__day${weekend ? " kan-timeline__day--weekend" : ""}${isToday ? " kan-timeline__day--today" : ""}`}
                    data-testid={`timeline-day-${dateKey}`}
                    data-date={dateKey}
                    data-weekend={String(weekend)}
                    data-today={isToday ? "true" : undefined}
                  >
                    <small className="task-owned">{formatWeekday(dateKey, lang)}</small>
                    <strong className="task-owned">{date.getDate()}</strong>
                  </span>
                );
              })}
            </div>
          </div>

          {scheduled.length === 0 ? (
            <div className="kan-timeline__empty">
              <p>{emptyCopy(tasks, datedCount, t)}</p>
              <button className="task-owned" type="button" onClick={onCreateDefault}>{t("tasks.new")}</button>
            </div>
          ) : (
            <div className="kan-timeline__rows">
              {scheduled.map(({ task, clipped, urgency }) => {
                const busy = pending.has(task.id);
                const key = taskKey(task, chapterId);
                const continuation = [
                  clipped.clippedStart ? t("tasks.timeline.continuesBefore") : null,
                  clipped.clippedEnd ? t("tasks.timeline.continuesAfter") : null,
                ].filter(Boolean);
                // The bar shows the key (or the title when there is none).
                const barTask = key ? `${key} ${task.title}` : task.title;
                const openLabel = clipped.halfDated
                  ? t("tasks.timeline.openDay", { task: barTask, date: formatDay(clipped.startDate, lang) })
                  : t("tasks.timeline.openSpan", {
                    task: barTask,
                    start: formatDay(clipped.startDate, lang),
                    end: formatDay(clipped.endDate, lang),
                  });
                const fullBarLabel = continuation.length > 0
                  ? `${openLabel}. ${continuation.join(". ")}`
                  : openLabel;
                const stateLabel = urgencyLabel(urgency, t);
                const visibleDates = clipped.endDate !== clipped.startDate
                  ? `${formatDay(clipped.startDate, lang)} – ${formatDay(clipped.endDate, lang)}`
                  : formatDay(clipped.startDate, lang);
                return (
                  <article
                    className="kan-timeline__row"
                    key={task.id}
                    data-task-id={task.id}
                    data-urgency={urgency}
                  >
                    <div className="kan-timeline__meta">
                      <button
                        type="button"
                        className="kan-timeline__open"
                        onClick={() => onOpenTask(task)}
                        aria-label={t("tasks.openNamedTask", { task: `${[key, task.title, task.unitName || null].filter(Boolean).join(" ")}, ${visibleDates}` })}
                      >
                        <span className="kan-timeline__identity">
                          {task.milestone && <Diamond size={14} aria-label={t("tasks.milestone")} />}
                          {key && <><span className="kan-timeline__key">{key}</span>{" "}</>}
                          <strong className="task-owned">{task.title}</strong>
                          {task.unitName && <span>{task.unitName}</span>}
                        </span>{" "}
                        <span className="kan-timeline__dates">{visibleDates}</span>
                      </button>
                      <div className="kan-timeline__signals">
                        {continuation.map((label) => <span className="kan-timeline__continuation" key={label}>{label}</span>)}
                        {stateLabel && <span className={`kan-timeline__urgency kan-timeline__urgency--${urgency}`}>{stateLabel}</span>}
                      </div>
                      <span className="kan-timeline__shift">
                        <BusyButton className="task-owned" type="button" pending={busy} onClick={() => shift(task, -1)} aria-label={t("tasks.shiftEarlier", { task: task.title })}>−1</BusyButton>
                        <BusyButton className="task-owned" type="button" pending={busy} onClick={() => shift(task, 1)} aria-label={t("tasks.shiftLater", { task: task.title })}>+1</BusyButton>
                      </span>
                    </div>
                    <div className="kan-timeline__track">
                      {monthWindow.dates.map((dateKey) => {
                        const date = parseLocalDateKey(dateKey);
                        const weekend = date.getDay() === 0 || date.getDay() === 6;
                        return <i key={dateKey} className={weekend ? "kan-timeline__cell--weekend" : ""} aria-hidden="true" />;
                      })}
                      <button
                        type="button"
                        className={`kan-timeline__bar kan-timeline__bar--${task.status}${task.milestone ? " kan-timeline__bar--milestone" : ""}`}
                        style={{ gridColumn: `${clipped.startOffsetDays + 1} / span ${clipped.visibleDayCount}` }}
                        onClick={() => onOpenTask(task)}
                        aria-label={fullBarLabel}
                        data-start-date={clipped.startDate}
                        data-end-date={clipped.endDate}
                        data-visible-days={clipped.visibleDayCount}
                        data-half-dated={String(clipped.halfDated)}
                        data-milestone={task.milestone ? "true" : undefined}
                      >
                        {task.milestone && <Diamond size={14} aria-hidden="true" />}
                        <span>{key || task.title}</span>
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <p className="kan-timeline__hint">{t("tasks.timelineHint")}</p>
    </section>
  );
}
