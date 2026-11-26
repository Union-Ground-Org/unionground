import { useId } from "react";
import { Clock3 } from "lucide-react";
import { taskKey } from "../lib/kanban.js";
import { localeFor } from "../lib/i18n.js";
import {
  classifyDeadline,
  localDateKey,
  parseLocalDateKey,
} from "../lib/taskSchedule.js";

const DEADLINE_BUCKETS = [
  ["overdue", "tasks.deadline.overdue"],
  ["today", "tasks.deadline.today"],
  ["next-seven-days", "tasks.deadline.nextSeven"],
  ["later", "tasks.deadline.later"],
  ["completed", "tasks.deadline.completed"],
];

function formatShortDate(value, lang) {
  return new Intl.DateTimeFormat(localeFor(lang), { month: "short", day: "numeric" })
    .format(parseLocalDateKey(value));
}

function taskNumberRank(task) {
  return Number.isFinite(task.taskNumber) ? task.taskNumber : Number.MAX_SAFE_INTEGER;
}

function compareRows(a, b) {
  return a.task.dueDate.localeCompare(b.task.dueDate)
    || taskNumberRank(a.task) - taskNumberRank(b.task)
    || String(a.task.id).localeCompare(String(b.task.id));
}

function assigneeText(task, unassigned) {
  const names = Array.isArray(task.assigneeNames)
    ? task.assigneeNames.filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim())
    : [];
  if (names.length) return names.join(", ");
  if (typeof task.assigneeName === "string" && task.assigneeName.trim()) return task.assigneeName.trim();
  return unassigned;
}

export function TaskDeadlinesView({
  tasks,
  chapterId,
  doneVisible,
  lang,
  t,
  onOpen,
  onCreate,
  today = new Date(),
}) {
  const headingPrefix = useId();
  const todayKey = localDateKey(today);
  const rows = tasks
    .filter((task) => doneVisible || task.status !== "done")
    .flatMap((task) => {
      try {
        if (!task.dueDate) return [];
        parseLocalDateKey(task.dueDate);
        const state = classifyDeadline(task, todayKey);
        return state === "undated" ? [] : [{ task, state }];
      } catch {
        return [];
      }
    });
  const groupedRows = new Map(DEADLINE_BUCKETS.map(([state]) => [
    state,
    rows.filter((row) => row.state === state).sort(compareRows),
  ]));

  return (
    <section className="tasks-work-docket tasks-deadlines-view" aria-label={t("tasks.view.deadlines")}>
      <header className="tasks-work-docket__head">
        <div>
          <h2 className="task-owned" data-workspace-focus="">{t("tasks.deadlinesTitle")}</h2>
          <p className="task-owned">{t("tasks.deadlinesSubtitle")}</p>
        </div>
        <span>{t(rows.length === 1 ? "tasks.datedTaskOne" : "tasks.datedTaskCount", { count: rows.length })}</span>
      </header>
      {rows.length > 0 ? (
        <div className="tasks-deadline-buckets">
          {DEADLINE_BUCKETS.map(([state, labelKey]) => {
            const bucketRows = groupedRows.get(state);
            if (!bucketRows.length) return null;
            const headingId = `${headingPrefix}-${state}`;
            const urgency = t(labelKey);
            return (
              <section
                className="tasks-deadline-bucket"
                data-urgency={state}
                role="group"
                aria-labelledby={headingId}
                key={state}
              >
                <header className="tasks-deadline-bucket__head">
                  <h3 className="tasks-deadline-bucket__title" id={headingId}>{urgency}</h3>
                  <span aria-hidden="true">{bucketRows.length}</span>
                </header>
                <div className="tasks-work-docket__rows">
                  {bucketRows.map(({ task }) => {
                    const key = taskKey(task, chapterId);
                    return (
                      <article className="tasks-work-row" key={task.id} data-status={task.status} data-urgency={state}>
                        <time dateTime={task.dueDate}>
                          <Clock3 className="tasks-work-row__clock" size={13} aria-hidden="true" />
                          {formatShortDate(task.dueDate, lang)}
                        </time>
                        <span className="tasks-work-row__copy">
                          <strong>{task.title}</strong>
                          {task.unitName && <span>{task.unitName}</span>}
                          <small>{[key, task.workstream, t(`tasks.status.${task.status}`)].filter(Boolean).join(" · ")}</small>
                          <span className="tasks-work-row__assignee">
                            {assigneeText(task, t("tasks.unassigned"))}
                          </span>
                          <span className="tasks-work-row__urgency">{urgency}</span>
                        </span>
                        <button type="button" onClick={() => onOpen(task)} aria-label={t("tasks.openNamedTask", { task: task.title })}>
                          {t("tasks.openTask")}
                        </button>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="tasks-work-empty">
          <p className="task-owned">{t("tasks.deadlinesEmpty")}</p>
          <button type="button" onClick={onCreate}>{t("tasks.new")}</button>
        </div>
      )}
    </section>
  );
}
