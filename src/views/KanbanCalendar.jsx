import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Diamond,
  Minus,
  Plus,
  Settings2,
} from "lucide-react";
import { localeFor } from "../lib/i18n.js";
import { taskKey } from "../lib/kanban.js";
import {
  addLocalDays as addDays,
  calendarMonthGrid,
  calendarWeekGrid,
  daysBetweenLocalDates as daysBetween,
  localDateKey as isoDate,
  parseLocalDateKey as localDate,
  shiftTaskDateSpan,
  taskDateSpan,
  weekStartOnOrBefore,
} from "../lib/taskSchedule.js";
import { useTransitionPresence } from "../lib/useTransitionPresence.js";
import { DRAG_LIFT_PX, TOUCH_HOLD_MS } from "./KanbanBoard.jsx";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { BusyButton, BusyInput } from "../components/BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { limitTaskTitle } from "../lib/taskTitle.js";

// The t0ggles calendar, on the kanban design language: Monday-first grid,
// week rows that lay their tasks out in LANES so a multi-day span renders as
// one continuous chip instead of a copy per day, status-tinted chips with the
// card anatomy (priority glyph, mono key, title, avatar/diamond), and
// drag-to-reschedule that shifts start and due TOGETHER — span preserved,
// exactly the semantics the reference documents. Chips also answer Alt+arrow
// keys (±1 day, ±7 days) so rescheduling never requires a pointer, and a
// plain click opens the task modal where the date fields remain the fallback.
//
// No "+N more" truncation on purpose: a heavy week grows taller instead of
// hiding work behind an expander. The board window caps a chapter at 500
// loaded cards, which bounds how tall a week can get.

const TOUCH_SLOP_PX = 10;

function safeCalendarAnchor(value, fallback) {
  try {
    localDate(value);
    return value;
  } catch {
    return fallback;
  }
}

// Monday of the week containing `value` — shared with calendarMonthGrid /
// calendarWeekGrid so phone and desktop keep the same weekday columns.
export function weekStart(value) {
  return weekStartOnOrBefore(value);
}

export function weekDates(value) {
  const monday = weekStart(value);
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

// Every full week the month touches, as week-arrays of iso dates. Dynamic
// height: a four-week February and a six-week August each get exactly their
// own rows, no 42-cell padding.
export function monthWeeks(year, month) {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const weeks = [];
  let cursor = weekStart(isoDate(first));
  const end = isoDate(last);
  while (cursor <= end) {
    weeks.push(weekDates(cursor));
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

// Lane assignment for one week. A task occupies [startDate, dueDate] clamped
// to the week; laid greedily into the first lane with no column overlap after
// sorting by start (earlier first) then span (longer first) — the classic
// calendar packing that keeps long bars on top and slots singles around them.
// clipStart/clipEnd mark spans that continue into neighbouring weeks so the
// chip can drop its rounding on the cut side.
export function assignCalendarLanes(tasks, week) {
  const first = week[0];
  const last = week[week.length - 1];
  const spans = [];
  for (const task of tasks || []) {
    const start = task.startDate || task.dueDate;
    const due = task.dueDate || task.startDate;
    if (!start || !due || due < first || start > last) continue;
    const lo = start < first ? first : start;
    const hi = due > last ? last : due;
    spans.push({
      task,
      start: daysBetween(first, lo),
      end: daysBetween(first, hi),
      clipStart: start < first,
      clipEnd: due > last,
    });
  }
  spans.sort((a, b) => a.start - b.start
    || (b.end - b.start) - (a.end - a.start)
    || String(a.task.createdAt || "").localeCompare(String(b.task.createdAt || "")));
  const lanes = [];
  for (const span of spans) {
    let lane = lanes.findIndex((occupied) => span.start > occupied);
    if (lane === -1) {
      lane = lanes.length;
      lanes.push(span.end);
    } else {
      lanes[lane] = span.end;
    }
    span.lane = lane;
  }
  return { segments: spans, laneCount: lanes.length };
}

// The one write shape a reschedule produces: both dates move by the same
// delta, so the span survives and the pair guard (due >= start) cannot trip.
export function shiftTaskDates(task, deltaDays) {
  const start = task.startDate || task.dueDate;
  const due = task.dueDate || task.startDate;
  return { startDate: addDays(start, deltaDays), dueDate: addDays(due, deltaDays) };
}

export function calendarPopoverPosition(anchor, panel, boundary, viewport) {
  const margin = 12;
  const gap = 6;
  const panelWidth = panel.width || Math.min(304, viewport.width - (margin * 2));
  const panelHeight = panel.height || 0;
  const safeLeft = Math.max(margin, (boundary?.left ?? 0) + margin);
  const safeRight = Math.min(viewport.width - margin, (boundary?.right ?? viewport.width) - margin);
  const below = anchor.bottom + gap;
  const fitsBelow = below + panelHeight <= viewport.height - margin;
  return {
    top: fitsBelow ? below : Math.max(margin, anchor.top - panelHeight - gap),
    left: Math.min(
      Math.max(safeLeft, anchor.left),
      Math.max(safeLeft, safeRight - panelWidth),
    ),
    origin: `${fitsBelow ? "top" : "bottom"} ${anchor.left < (safeLeft + safeRight) / 2 ? "left" : "right"}`,
  };
}

const PRIORITY_ICONS = { high: ChevronsUp, medium: Minus, low: ChevronsDown };

function CalendarPopover({ open, anchorRef, label, onClose, autoFocus = false, children }) {
  const panelRef = useRef(null);
  const [position, setPosition] = useState(null);
  const presence = useTransitionPresence(open, {
    exitMs: 200,
    onExited: () => {
      const active = document.activeElement;
      if (active === document.body || active === document.documentElement || panelRef.current?.contains(active)) {
        anchorRef.current?.focus?.();
      }
    },
  });

  useLayoutEffect(() => {
    if (!presence.mounted || !anchorRef.current || !panelRef.current) return;
    const measure = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const panelElement = panelRef.current;
      const panelRect = panelElement?.getBoundingClientRect();
      const panel = panelRect && {
        width: panelElement.offsetWidth || panelRect.width,
        height: panelElement.offsetHeight || panelRect.height,
      };
      if (!anchor || !panel) return;
      const boundary = anchorRef.current.closest(".kan-cal")?.getBoundingClientRect();
      setPosition(calendarPopoverPosition(anchor, panel, boundary, {
        width: window.innerWidth,
        height: window.innerHeight,
      }));
    };
    measure();
    // The retained panel mounts before its width has settled in the desktop
    // companion layout. Measure once more after paint so the phone preview can
    // never cover the right-edge settings controls.
    const frame = window.requestAnimationFrame(measure);
    return () => window.cancelAnimationFrame(frame);
  }, [anchorRef, presence.mounted, open]);

  // Escape must arm on the requested-open mount, not the two-frame settled
  // `open` phase. Stryker's dry-run can fire the key in the same turn the
  // dialog becomes visible, and a user can cancel during the appear animation.
  useLayoutEffect(() => {
    if (!open || !presence.mounted) return undefined;
    function onKeyDown(event) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }
    // Capture lets the overlay claim Escape before TasksView's earlier
    // window-bubble shortcut listener can treat it as an exit from focus mode.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, open, presence.mounted]);

  useEffect(() => {
    if (!open || presence.phase !== "open") return undefined;
    if (autoFocus) panelRef.current?.querySelector("input")?.focus?.();
    function onPointerDown(event) {
      if (!panelRef.current?.contains(event.target) && !anchorRef.current?.contains(event.target)) onClose();
    }
    function onViewportChange(event) {
      if (event?.target instanceof Node && panelRef.current?.contains(event.target)) return;
      onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
    };
  }, [anchorRef, autoFocus, onClose, open, presence.phase]);

  if (!presence.mounted) return null;
  return (
    <div
      ref={panelRef}
      className="kan-popover kan-cal-popover"
      style={position ? {
        position: "fixed",
        top: position.top,
        left: position.left,
        right: "auto",
        transformOrigin: position.origin,
      } : { position: "fixed", top: 12, left: 12, right: "auto" }}
      role="dialog"
      aria-label={label}
      aria-hidden={presence.closing || undefined}
      data-state={presence.phase}
      inert={presence.closing ? true : undefined}
      onTransitionEnd={presence.onTransitionEnd}
    >
      <p className="kan-popover__title" aria-hidden="true">{label}</p>
      {children}
    </div>
  );
}

export function KanbanCalendar({
  tasks,
  chapterId,
  t,
  lang,
  onOpenTask,
  onUpdate,
  onCreateDate,
  liveAnnounce,
  desktopWork = false,
}) {
  const rootRef = useRef(null);
  const sessionRef = useRef(null);
  const pendingFocusRef = useRef(null);
  const suppressClickRef = useRef(false);
  const dateAnchorRef = useRef(null);
  const createInputRef = useRef(null);
  const settingsAnchorRef = useRef(null);
  const [scale, setScale] = useDeviceParityState("tasks.calendar.scale", "month");
  const [anchor, setAnchor] = useDeviceParityState("tasks.calendar.anchor", () => isoDate(new Date()));
  const [dropDate, setDropDate] = useState(null);
  const [createDate, setCreateDate] = useState(null);
  const [createTitle, setCreateTitle] = useState("");
  const [creating, setCreating] = useState(false);
  // Record 8435: a synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const [draftFocusRequest, setDraftFocusRequest] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [itemScope, setItemScope] = useState("all");
  const [showDetails, setShowDetails] = useState(true);
  const today = isoDate(new Date());
  const calendarAnchor = safeCalendarAnchor(anchor, today);

  useEffect(() => () => sessionRef.current?.cleanup?.(), []);
  useLayoutEffect(() => {
    if (draftFocusRequest > 0 && !creating && createDate) createInputRef.current?.focus?.();
  }, [createDate, creating, draftFocusRequest]);

  const anchorDate = localDate(calendarAnchor);
  const weeks = useMemo(
    () => {
      if (desktopWork) {
        const dates = scale === "week" ? calendarWeekGrid(calendarAnchor) : calendarMonthGrid(calendarAnchor);
        const groups = [];
        for (let index = 0; index < dates.length; index += 7) groups.push(dates.slice(index, index + 7));
        return groups;
      }
      return scale === "week"
        ? [weekDates(calendarAnchor)]
        : monthWeeks(anchorDate.getFullYear(), anchorDate.getMonth());
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- anchorDate is derived from calendarAnchor every render
    [calendarAnchor, desktopWork, scale],
  );

  const monthLabel = new Intl.DateTimeFormat(localeFor(lang), { month: "long", year: "numeric" }).format(anchorDate);
  const shortDate = new Intl.DateTimeFormat(localeFor(lang), { month: "short", day: "numeric" });
  const longDate = new Intl.DateTimeFormat(localeFor(lang), { month: "long", day: "numeric", year: "numeric" });
  const label = scale === "week"
    ? `${shortDate.format(localDate(weeks[0][0]))} – ${shortDate.format(localDate(weeks[0][6]))}`
    : monthLabel;

  const dowLabels = useMemo(() => {
    const format = new Intl.DateTimeFormat(localeFor(lang), { weekday: "short" });
    const start = weeks[0]?.[0];
    if (!start) return [];
    return Array.from({ length: 7 }, (_, index) => format.format(localDate(addDays(start, index))));
  }, [lang, weeks]);

  const visibleTasks = useMemo(() => tasks.filter((task) => {
    if (itemScope === "open") return task.status !== "done";
    if (itemScope === "milestones") return Boolean(task.milestone);
    return true;
  }), [itemScope, tasks]);
  const geometryTasks = useMemo(
    () => (desktopWork ? visibleTasks.filter((task) => taskDateSpan(task) !== null) : visibleTasks),
    [desktopWork, visibleTasks],
  );

  // Alt+Arrow remounts the chip under a new week-row key; restore focus after that layout.
  useLayoutEffect(() => {
    const taskId = pendingFocusRef.current;
    if (!taskId) return;
    pendingFocusRef.current = null;
    const chip = rootRef.current?.querySelector(`[data-task-id="${taskId}"]`);
    if (!chip) return;
    chip.focus();
  }, [geometryTasks]);

  function openDateComposer(date, trigger) {
    if (desktopWork && creating) return;
    if (settingsOpen) setSettingsOpen(false);
    dateAnchorRef.current = trigger;
    setCreateDate(date);
    setCreateTitle("");
  }

  function submitDateComposer(event) {
    return runBusyWrite(busyWriteRef, "calendar-create", () => submitDateComposerNow(event), event);
  }

  async function submitDateComposerNow(event) {
    event.preventDefault();
    const title = createTitle.trim();
    if (!title || !createDate || creating) return;
    const submittedDate = createDate;
    let restoreDraftFocus = false;
    setCreating(true);
    try {
      const created = await onCreateDate(createDate, title);
      // Nothing was created: keep the title, with focus back on it on every
      // shell; the parent says why (#9469).
      if (!created) {
        restoreDraftFocus = true;
        return;
      }
      if (desktopWork) {
        liveAnnounce(t("kanban.calendarAdded", { date: shortDate.format(localDate(submittedDate)) }));
        setCreateDate(null);
        setCreateTitle("");
        // TasksView captures document.activeElement as the modal return point.
        // Hand it the stable date opener, not the composer submit button that
        // is about to unmount behind the editor.
        dateAnchorRef.current?.focus?.();
        onOpenTask(created);
        return;
      }
      liveAnnounce(t("kanban.calendarAdded", { date: shortDate.format(localDate(createDate)) }));
      setCreateDate(null);
      setCreateTitle("");
    } catch {
      // The parent keeps the title visible and surfaces the shared save error.
      restoreDraftFocus = desktopWork;
    } finally {
      setCreating(false);
      if (restoreDraftFocus) setDraftFocusRequest((current) => current + 1);
    }
  }

  function move(amount) {
    if (scale === "week") {
      setAnchor((current) => addDays(safeCalendarAnchor(current, today), amount * 7));
    } else {
      const date = localDate(calendarAnchor);
      setAnchor(isoDate(new Date(date.getFullYear(), date.getMonth() + amount, 1)));
    }
  }

  function announceReschedule(task, patch) {
    liveAnnounce(t("kanban.rescheduled", {
      start: shortDate.format(localDate(patch.startDate)),
      due: shortDate.format(localDate(patch.dueDate)),
    }));
  }

  async function commitShift(task, deltaDays) {
    if (!deltaDays) return;
    const patch = desktopWork ? shiftTaskDateSpan(task, deltaDays) : shiftTaskDates(task, deltaDays);
    if (!patch) return;
    try {
      await onUpdate(task.id, patch);
      announceReschedule(task, patch);
    } catch {
      // The parent rolled back and surfaced the error.
    }
  }

  // Same engine philosophy as the board: pointer events, a lift threshold so
  // clicks never drag, a touch hold so panning stays a pan, Esc aborts. The
  // grabbed CELL is the anchor — dropping three cells right means +3 days no
  // matter where inside the span the grab landed.
  function startChipDrag(event, task) {
    if (sessionRef.current || event.button !== 0) return;
    const session = {
      task,
      el: event.currentTarget,
      pointerId: event.pointerId,
      pointerType: event.pointerType || "mouse",
      startX: event.clientX,
      startY: event.clientY,
      last: { x: event.clientX, y: event.clientY },
      lifted: false,
      cells: null,
      anchorDate: null,
      target: null,
      holdTimer: 0,
    };
    sessionRef.current = session;

    const blockTouchScroll = (touchEvent) => {
      if (session.lifted) touchEvent.preventDefault();
    };

    const cellAt = (point) => (session.cells || []).find((cell) =>
      point.x >= cell.rect.left && point.x <= cell.rect.right
      && point.y >= cell.rect.top && point.y <= cell.rect.bottom) || null;

    const lift = () => {
      if (session.lifted) return;
      session.lifted = true;
      try {
        session.el.setPointerCapture(session.pointerId);
      } catch { /* jsdom: window listeners track the drag anyway */ }
      session.cells = [...(rootRef.current?.querySelectorAll("[data-cal-date]") || [])].map((el) => {
        const rect = el.getBoundingClientRect();
        return { date: el.dataset.calDate, rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } };
      });
      session.anchorDate = cellAt({ x: session.startX, y: session.startY })?.date
        || session.task.startDate || session.task.dueDate;
      session.el.classList.add("kan-chip--drag");
      window.addEventListener("touchmove", blockTouchScroll, { passive: false });
      session.removeTouchBlock = () => window.removeEventListener("touchmove", blockTouchScroll);
    };

    const onMove = (moveEvent) => {
      if (moveEvent.pointerId !== session.pointerId) return;
      session.last = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (!session.lifted) {
        const travelled = Math.hypot(moveEvent.clientX - session.startX, moveEvent.clientY - session.startY);
        if (session.pointerType === "touch") {
          if (!session.held && travelled > TOUCH_SLOP_PX) {
            session.cleanup();
            return;
          }
        } else if (travelled > DRAG_LIFT_PX) {
          lift();
        }
        if (!session.lifted) return;
      }
      const cell = cellAt(session.last);
      session.target = cell;
      setDropDate(cell?.date || null);
    };

    const onUp = (upEvent) => {
      if (upEvent.pointerId !== session.pointerId) return;
      const { lifted, target, task: dragged, anchorDate: grabbed } = session;
      session.cleanup();
      if (!lifted) return;
      suppressClickRef.current = true;
      if (target?.date && grabbed) commitShift(dragged, daysBetween(grabbed, target.date));
      else liveAnnounce(t("kanban.dragCancelled"));
    };

    const onCancel = (cancelEvent) => {
      if (cancelEvent.pointerId !== session.pointerId) return;
      const wasLifted = session.lifted;
      session.cleanup();
      if (wasLifted) {
        suppressClickRef.current = true;
        liveAnnounce(t("kanban.dragCancelled"));
      }
    };

    const onKey = (keyEvent) => {
      if (keyEvent.key !== "Escape") return;
      if (!session.lifted && session.pointerType !== "touch") return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      onCancel({ pointerId: session.pointerId });
    };

    session.cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      session.removeTouchBlock?.();
      window.clearTimeout(session.holdTimer);
      session.el.classList.remove("kan-chip--drag");
      try {
        session.el.releasePointerCapture(session.pointerId);
      } catch { /* capture may never have been taken */ }
      sessionRef.current = null;
      setDropDate(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    if (session.pointerType === "touch") {
      session.holdTimer = window.setTimeout(() => {
        session.held = true;
        lift();
      }, TOUCH_HOLD_MS);
    }
  }

  function onChipClick(task) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onOpenTask(task);
  }

  function onChipKeyDown(event, task) {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    const deltas = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    pendingFocusRef.current = task.id;
    commitShift(task, delta);
  }

  return (
    <section className={`kan-cal${desktopWork ? " kan-cal--desktop-work" : ""}`} ref={rootRef} aria-label={t("tasks.view.calendar")}>
      <header className="kan-cal__bar">
        <strong className="kan-cal__label">{label}</strong>
        <span className="kan-cal__spacer" />
        <button type="button" className="kan-pill" onClick={() => setAnchor(isoDate(new Date()))}>
          {t("kanban.today")}
        </button>
        <button
          type="button"
          className="kan-pill kan-pill--icon"
          aria-label={scale === "week" ? t("tasks.earlier") : t("tasks.previousMonth")}
          onClick={() => move(-1)}
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="kan-pill kan-pill--icon"
          aria-label={scale === "week" ? t("tasks.later") : t("tasks.nextMonth")}
          onClick={() => move(1)}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
        <div className="kan-seg" role="group" aria-label={t("kanban.calendarScale")}>
          <button className="task-owned" type="button" aria-pressed={scale === "month"} onClick={() => setScale("month")}>
            {t("kanban.calendarMonth")}
          </button>
          <button className="task-owned"
            type="button"
            aria-pressed={scale === "week"}
            onClick={() => {
              // Entering week scale lands on today's week when today is in
              // view-month; otherwise on the shown month's first week.
              setScale("week");
              setAnchor((current) => {
                const monthOf = localDate(safeCalendarAnchor(current, today));
                const now = new Date();
                return monthOf.getFullYear() === now.getFullYear() && monthOf.getMonth() === now.getMonth()
                  ? isoDate(now)
                  : isoDate(new Date(monthOf.getFullYear(), monthOf.getMonth(), 1));
              });
            }}
          >
            {t("kanban.calendarWeek")}
          </button>
        </div>
        <span className="kan-anchor">
          <button
            ref={settingsAnchorRef}
            type="button"
            className="kan-pill kan-pill--icon"
            aria-label={t("kanban.calendarSettings")}
            aria-expanded={settingsOpen}
            onClick={() => {
              if (desktopWork && creating) return;
              if (createDate) setCreateDate(null);
              setSettingsOpen((current) => !current);
            }}
          >
            <Settings2 size={16} aria-hidden="true" />
          </button>
        </span>
      </header>

      <CalendarPopover
        open={Boolean(createDate)}
        anchorRef={dateAnchorRef}
        label={createDate ? t("kanban.calendarAddOn", { date: longDate.format(localDate(createDate)) }) : t("kanban.calendarAdd")}
        onClose={() => {
          if (!desktopWork || !creating) setCreateDate(null);
        }}
        autoFocus
      >
        <form className="kan-cal-add" onSubmit={submitDateComposer} aria-busy={creating || undefined}>
          <BusyInput className="task-owned"
            ref={createInputRef}
            type="text"
            value={createTitle}
            onChange={(event) => setCreateTitle(limitTaskTitle(event.target.value, createTitle))}
            aria-label={t("kanban.calendarAddTitle")}
            placeholder={t("kanban.calendarAddTitle")}
            // The task title limit (chapter_tasks_title_bounded), as on the
            // board and list composers; a longer title is refused (#8526).
            // limitTaskTitle counts trimmed code points as the check does (#9042).
            pending={desktopWork && creating}
          />
          <div className="kan-cal-add__actions">
            <BusyButton type="button" className="kan-pill task-owned" pending={creating} onClick={() => setCreateDate(null)}>
              {t("kanban.calendarCancel")}
            </BusyButton>
            <BusyButton type="submit" className="kan-pill kan-cal-add__submit task-owned" pending={creating} disabled={!createTitle.trim()}>
              {t("kanban.calendarAdd")}
            </BusyButton>
          </div>
        </form>
      </CalendarPopover>

      <CalendarPopover
        open={settingsOpen}
        anchorRef={settingsAnchorRef}
        label={t("kanban.calendarSettings")}
        onClose={() => setSettingsOpen(false)}
      >
        <div className="kan-popover__section">
          <span className="kan-popover__label">{t("kanban.calendarItemsShown")}</span>
          <div className="kan-popover__list" role="group" aria-label={t("kanban.calendarItemsShown")}>
            {[
              ["all", t("kanban.calendarShowAll")],
              ["open", t("kanban.calendarShowOpen")],
              ["milestones", t("kanban.calendarShowMilestones")],
            ].map(([value, labelText]) => (
              <button
                key={value}
                type="button"
                className={`kan-popover__opt${itemScope === value ? " kan-popover__opt--on" : ""}`}
                aria-pressed={itemScope === value}
                onClick={() => setItemScope(value)}
              >
                <span>{labelText}</span>
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          className={`kan-popover__opt${showDetails ? " kan-popover__opt--on" : ""}`}
          aria-pressed={showDetails}
          onClick={() => setShowDetails((current) => !current)}
        >
          <span>{t("kanban.calendarDetails")}</span>
        </button>
      </CalendarPopover>

      <div className="kan-cal__dow" aria-hidden="true">
        {dowLabels.map((name) => <span className="task-owned" key={name}>{name}</span>)}
      </div>

      <div className="kan-cal__weeks">
        {weeks.map((week) => {
          const { segments, laneCount } = assignCalendarLanes(geometryTasks, week);
          return (
            <div
              className="kan-cal__week"
              key={week[0]}
              data-week-start={desktopWork ? week[0] : undefined}
              style={{ gridTemplateRows: `48px repeat(${Math.max(laneCount, scale === "week" ? 3 : 1)}, minmax(44px, auto))` }}
            >
              {week.map((date, column) => {
                const day = localDate(date);
                const outside = scale === "month" && day.getMonth() !== anchorDate.getMonth();
                const isToday = date === today;
                const dayText = desktopWork
                  ? (day.getDate() === 1 ? shortDate.format(day) : day.getDate())
                  : (day.getDate() === 1 || isToday ? shortDate.format(day) : day.getDate());
                const dayClass = `kan-cal__day${outside ? " kan-cal__day--out" : ""}${dropDate === date ? " kan-cal__day--drop" : ""}`;
                const dateLabel = t("kanban.calendarAddOn", { date: longDate.format(day) });
                // The full-height cell is the column's PAINT and its drop
                // target, and nothing else: it is decorative, so the acceptance
                // audit stops measuring it as a visible element overlapping
                // every chip that crosses the week. Its date stays readable to
                // the pointer through data-cal-date, which is what the drag
                // session hit-tests. The controls live in the header row, where
                // a 44 px target fits without reaching into a lane.
                const fill = (
                  <span
                    key={`${date}:cell`}
                    aria-hidden="true"
                    className={`${dayClass} kan-cal__day--fill`}
                    data-cal-date={date}
                    style={{ gridColumn: column + 1, gridRow: "1 / -1" }}
                  />
                );
                if (desktopWork) return (
                  <Fragment key={date}>
                    {fill}
                    <div className="kan-cal__daybar" style={{ gridColumn: column + 1, gridRow: 1 }}>
                      <span aria-hidden="true" className={isToday ? "kan-cal__num kan-cal__num--today" : "kan-cal__num"}>
                        {dayText}
                      </span>
                      <button
                        type="button"
                        className="kan-cal__add-date"
                        aria-label={dateLabel}
                        onClick={(event) => openDateComposer(date, event.currentTarget)}
                      >
                        <Plus size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </Fragment>
                );
                return (
                  <Fragment key={date}>
                    {fill}
                    <button
                      type="button"
                      className={`kan-cal__day kan-cal__daybtn${outside ? " kan-cal__day--out" : ""}`}
                      style={{ gridColumn: column + 1, gridRow: 1 }}
                      aria-label={dateLabel}
                      onClick={(event) => openDateComposer(date, event.currentTarget)}
                    >
                      <span aria-hidden="true" className={isToday ? "kan-cal__num kan-cal__num--today" : "kan-cal__num"}>
                        {dayText}
                      </span>
                    </button>
                  </Fragment>
                );
              })}
              {segments.map((segment) => {
                const task = segment.task;
                const key = taskKey(task, chapterId);
                const PriIcon = PRIORITY_ICONS[task.priority] || Minus;
                const initials = String(task.assigneeName || "")
                  .split(/\s+/).slice(0, 2).map((word) => word[0] || "").join("").toUpperCase();
                return (
                  <button
                    key={`${task.id}:${week[0]}`}
                    type="button"
                    data-task-id={task.id}
                    className={`kan-chip kan-chip--${task.status}${showDetails ? "" : " kan-chip--compact"}${segment.end - segment.start < 2 ? " kan-chip--short-segment" : ""}${segment.clipStart ? " kan-chip--clip-l" : ""}${segment.clipEnd ? " kan-chip--clip-r" : ""}`}
                    style={{ gridColumn: `${segment.start + 1} / ${segment.end + 2}`, gridRow: segment.lane + 2 }}
                    aria-label={`${task.title}${key ? `, ${key}` : ""}${task.unitName ? `, ${task.unitName}` : ""}, ${shortDate.format(localDate(task.startDate || task.dueDate))} – ${shortDate.format(localDate(task.dueDate || task.startDate))}`}
                    onClick={() => onChipClick(task)}
                    onPointerDown={(event) => startChipDrag(event, task)}
                    onKeyDown={(event) => onChipKeyDown(event, task)}
                  >
                    {task.milestone ? (
                      <span className="kan-chip__diamond" aria-hidden="true"><Diamond size={12} /></span>
                    ) : (initials && <span className="kan-av kan-chip__av" aria-hidden="true" data-glyph={initials} />)}
                    {/* The title leads the bar; the key follows in the small
                        meta row (UX-UG-DEVELOPER-AND-MACHINE-TEXT-SHOWN-TO-PEOPLE-20261122). */}
                    <span className="kan-chip__body" aria-hidden="true">
                      <span className="kan-chip__title">{task.title}</span>{" "}
                      <span className="kan-chip__meta">
                        <PriIcon size={11} />
                        {key && <span className="kan-card__key">{key}</span>}
                      </span>
                      {task.unitName && <span>{task.unitName}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}
