import { ArrowUp, Check, ChevronsDown, ChevronsUp, Diamond, Flag, Minus, RotateCcw, Waypoints } from "lucide-react";
import { STATUS_IDS, statusCycle, taskKey } from "../lib/kanban.js";
import { localeFor } from "../lib/i18n.js";
import "./trackerRow.css";

function initials(value) {
  return String(value || "").split(/\s+/).slice(0, 2).map((word) => word[0] || "").join("").toUpperCase();
}

export function TrackerRow({ task, chapterId, t, lang, onOpenTask, onCycleStatus, depCount, subtaskCount, urgency }) {
  const key = taskKey(task, chapterId);
  const cycle = statusCycle(task.status);
  const CycleIcon = cycle.action === "advance" ? ArrowUp : cycle.action === "complete" ? Check : RotateCcw;
  const PriorityIcon = task.priority === "high" ? ChevronsUp : task.priority === "low" ? ChevronsDown : Minus;
  // Every layout receives a precomputed local-date urgency; malformed due keys
  // classify "undated" and are not formatted.
  const dated = urgency !== "undated" && Boolean(task.dueDate);
  const dateLabel = dated
    ? new Intl.DateTimeFormat(localeFor(lang), { month: "short", day: "numeric" }).format(new Date(`${task.dueDate}T12:00:00`))
    : "";
  const overdue = urgency === "overdue";
  const circleLabel = cycle.action === "advance"
    ? t("kanban.advanceTo", { status: t(`tasks.status.${cycle.to}`) })
    : cycle.action === "complete" ? t("kanban.complete") : t("kanban.reopen");
  const statusIndex = STATUS_IDS.indexOf(task.status);
  const priorityText = t(`tasks.priority${task.priority[0].toUpperCase()}${task.priority.slice(1)}`);
  const milestonePercent = task.progress || 0;
  const signalClauses = [];
  // WCAG 2.5.3: the visible signals stay contiguous in the name. Label-in-name
  // checks ignore the parenthetical; screen readers still announce it.
  if (task.milestone) signalClauses.push(`${milestonePercent}% (${t("kanban.milestoneProgress")})`);
  if (depCount > 0) signalClauses.push(t("kanban.dependencyCount", { count: depCount }));
  if (subtaskCount?.total > 0) signalClauses.push(t("kanban.subtaskCount", subtaskCount));
  const openName = [task.title, task.unitName || null, ...signalClauses].filter(Boolean).join(", ");

  return (
    <li>
      <article className={`kan-listrow kan-listrow--${task.status} sg-tracker-row`}>
        <span className={`kan-pri kan-pri--${task.priority}`} title={priorityText}>
          <span className={`sg-tracker-ring sg-tracker-ring--${overdue ? "late" : task.status}`} aria-hidden="true" />
          <PriorityIcon size={15} aria-hidden="true" />
          <span className="visually-hidden">{priorityText}</span>
        </span>
        <span className="kan-card__key">{key || ""}</span>
        <button type="button" className="kan-listrow__title" aria-label={openName} onClick={() => onOpenTask(task)}>
          <strong>{task.title}</strong>{" "}
          {task.unitName && <span>{task.unitName}</span>}
          <span className="kan-listrow__signals">
            {task.milestone && (
              <span>
                <Diamond size={12} aria-hidden="true" />
                {" "}
                <span className="visually-hidden">{t("kanban.milestoneProgress")} </span>
                {`${milestonePercent}%`}
              </span>
            )}{" "}
            {depCount > 0 && <span><Waypoints size={12} aria-hidden="true" /> {t("kanban.dependencyCount", { count: depCount })}</span>}{" "}
            {subtaskCount?.total > 0 && <span>{t("kanban.subtaskCount", subtaskCount)}</span>}
          </span>
        </button>
        <span className={`kan-listrow__status kan-status-pill kan-status-pill--${task.status}`}>
          <span className="kan-listrow__ladder" aria-hidden="true">
            {STATUS_IDS.map((status, index) => <i className={index <= statusIndex ? "is-on" : undefined} key={status} />)}
          </span>
          {t(`tasks.status.${task.status}`)}
        </span>
        <span className="kan-listrow__assignee">
          {task.assigneeName ? <><i className="kan-av" aria-hidden="true">{initials(task.assigneeName)}</i><span>{task.assigneeName}</span></> : <span>{t("tasks.unassigned")}</span>}
        </span>
        <time
          className={overdue ? "kan-listrow__due kan-listrow__due--overdue" : "kan-listrow__due"}
          dateTime={dated ? task.dueDate : undefined}
          data-urgency={urgency}
        >
          {dated && <Flag size={12} aria-hidden="true" />} {dateLabel}
        </time>
        <button type="button" className="kan-listrow__cycle" onClick={() => onCycleStatus(task)} aria-label={circleLabel}>
          <CycleIcon size={15} aria-hidden="true" />
        </button>
      </article>
    </li>
  );
}
