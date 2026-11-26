// Pure local-date schedule math for the desktop Work views. Civil dates only:
// keys are round-trippable YYYY-MM-DD strings, arithmetic runs on local-noon
// dates and calendar ordinals, and nothing here touches toISOString(), UTC
// serialization, elapsed milliseconds, React, or the browser. Strict helpers
// throw RangeError; task-facing helpers fail closed (null / "undated") so a
// malformed legacy or offline task value can never crash a view. Responsive
// and desktop task surfaces share these helpers so local-midnight behavior
// cannot drift between layouts.

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parsedComponents(dateKey) {
  if (typeof dateKey !== "string") throw new RangeError(`Expected a YYYY-MM-DD date key, got ${typeof dateKey}`);
  const match = DATE_KEY_PATTERN.exec(dateKey);
  if (!match) throw new RangeError(`Malformed date key: ${dateKey}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(year, month - 1, day, 12);
  if (candidate.getFullYear() !== year || candidate.getMonth() !== month - 1 || candidate.getDate() !== day) {
    throw new RangeError(`Impossible date key: ${dateKey}`);
  }
  return { year, month, day };
}

export function localDateKey(value = new Date()) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError("localDateKey requires a valid Date");
  }
  // Years outside 100–9999 cannot round-trip through DATE_KEY_PATTERN
  // (padStart(4) mangles negative years; five-digit years never re-parse), so
  // the strict contract throws here and the fail-closed task helpers catch.
  if (value.getFullYear() < 100 || value.getFullYear() > 9999) {
    throw new RangeError(`Date year ${value.getFullYear()} is outside the round-trippable 100-9999 range`);
  }
  const year = String(value.getFullYear()).padStart(4, "0");
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseLocalDateKey(dateKey) {
  const { year, month, day } = parsedComponents(dateKey);
  return new Date(year, month - 1, day, 12);
}

export function addLocalDays(dateKey, amount) {
  if (!Number.isInteger(amount)) throw new RangeError(`addLocalDays requires an integer amount, got ${amount}`);
  const date = parseLocalDateKey(dateKey);
  date.setDate(date.getDate() + amount);
  return localDateKey(date);
}

export function daysBetweenLocalDates(startKey, endKey) {
  const start = parsedComponents(startKey);
  const end = parsedComponents(endKey);
  const startOrdinal = Date.UTC(start.year, start.month - 1, start.day);
  const endOrdinal = Date.UTC(end.year, end.month - 1, end.day);
  return Math.round((endOrdinal - startOrdinal) / 86_400_000);
}

function safeDateKey(value) {
  try {
    parsedComponents(value);
    return value;
  } catch {
    return null;
  }
}

export function taskDateSpan(task) {
  if (!task || typeof task !== "object") return null;
  const hasStart = task.startDate !== null && task.startDate !== undefined && task.startDate !== "";
  const hasDue = task.dueDate !== null && task.dueDate !== undefined && task.dueDate !== "";
  if (!hasStart && !hasDue) return null;
  const startKey = hasStart ? safeDateKey(task.startDate) : null;
  const dueKey = hasDue ? safeDateKey(task.dueDate) : null;
  if ((hasStart && startKey === null) || (hasDue && dueKey === null)) return null;
  if (startKey && dueKey) {
    if (daysBetweenLocalDates(startKey, dueKey) < 0) return null;
    return { startDate: startKey, endDate: dueKey, halfDated: false };
  }
  const only = startKey ?? dueKey;
  return { startDate: only, endDate: only, halfDated: true };
}

export function shiftTaskDateSpan(task, amount) {
  const span = taskDateSpan(task);
  if (span === null || !Number.isInteger(amount)) return null;
  try {
    return {
      startDate: addLocalDays(span.startDate, amount),
      dueDate: addLocalDays(span.endDate, amount),
    };
  } catch {
    return null;
  }
}

export function monthDateWindow(anchorKey) {
  const { year, month } = parsedComponents(anchorKey);
  const dayCount = new Date(year, month, 0).getDate();
  const dates = [];
  for (let day = 1; day <= dayCount; day += 1) {
    dates.push(localDateKey(new Date(year, month - 1, day, 12)));
  }
  return { startDate: dates[0], endDate: dates[dayCount - 1], dayCount, dates };
}

// Monday-first, matching the phone Kanban calendar. There is no user first-day
// setting yet; both desktop and phone Work calendars consume this helper so a
// due date stays in the same weekday column across viewports.
const CALENDAR_WEEK_START_DAY = 1; // Monday-first for every viewport (BUG-UG-WEB-TASKS-CALENDAR-WEEK-START-DIFFERS-BY-VIEWPORT-20260914)

export function weekStartOnOrBefore(dateKey, weekStartDay = CALENDAR_WEEK_START_DAY) {
  const offset = (parseLocalDateKey(dateKey).getDay() - weekStartDay + 7) % 7;
  return addLocalDays(dateKey, -offset);
}

export function calendarMonthGrid(anchorKey) {
  const window = monthDateWindow(anchorKey);
  const gridStart = weekStartOnOrBefore(window.startDate);
  const grid = [];
  for (let index = 0; index < 42; index += 1) {
    grid.push(addLocalDays(gridStart, index));
  }
  return grid;
}

export function calendarWeekGrid(anchorKey) {
  const start = weekStartOnOrBefore(anchorKey);
  const week = [];
  for (let index = 0; index < 7; index += 1) {
    week.push(addLocalDays(start, index));
  }
  return week;
}

export function clipTaskDateSpan(task, windowStartDate, windowEndDate) {
  const span = taskDateSpan(task);
  if (span === null) return null;
  const windowStart = safeDateKey(windowStartDate);
  const windowEnd = safeDateKey(windowEndDate);
  if (windowStart === null || windowEnd === null) return null;
  if (daysBetweenLocalDates(windowStart, windowEnd) < 0) return null;
  if (daysBetweenLocalDates(span.endDate, windowStart) > 0) return null;
  if (daysBetweenLocalDates(windowEnd, span.startDate) > 0) return null;
  const visibleStartDate = daysBetweenLocalDates(windowStart, span.startDate) < 0 ? windowStart : span.startDate;
  const visibleEndDate = daysBetweenLocalDates(windowEnd, span.endDate) > 0 ? windowEnd : span.endDate;
  return {
    startDate: span.startDate,
    endDate: span.endDate,
    visibleStartDate,
    visibleEndDate,
    startOffsetDays: daysBetweenLocalDates(windowStart, visibleStartDate),
    visibleDayCount: daysBetweenLocalDates(visibleStartDate, visibleEndDate) + 1,
    totalDayCount: daysBetweenLocalDates(span.startDate, span.endDate) + 1,
    clippedStart: visibleStartDate !== span.startDate,
    clippedEnd: visibleEndDate !== span.endDate,
    halfDated: span.halfDated,
  };
}

export function classifyDeadline(task, todayKey = localDateKey()) {
  if (!task || typeof task !== "object") return "undated";
  const dueKey = task.dueDate === null || task.dueDate === undefined || task.dueDate === ""
    ? null
    : safeDateKey(task.dueDate);
  if (dueKey === null) return "undated";
  const today = safeDateKey(todayKey);
  if (today === null) return "undated";
  if (task.status === "done") return "completed";
  const distance = daysBetweenLocalDates(today, dueKey);
  if (distance < 0) return "overdue";
  if (distance === 0) return "today";
  if (distance <= 7) return "next-seven-days";
  return "later";
}
