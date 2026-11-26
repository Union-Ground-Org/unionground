// The phone tab bar's Work entry (REQ-UG-ALT-PORT-SHELL-MOTION-HOME-20261030).
// The prototype offers Work only to stewards and staff, with a badge counting
// what is due within two days (ws-data.js W.dueSoon, overdue included). Here
// Work is the production Tasks tool, offered only to an account whose roles
// open it, and the badge counts the member's own open tasks due by the day
// after tomorrow.
import { STAFF_TOOL_ROLES } from "../lib/staffPlanes.js";

const DUE_SOON_DAYS = 2;

function civilDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function dueSoonCount(tasks, memberId, now = new Date()) {
  if (!memberId || !Array.isArray(tasks)) return 0;
  const limit = new Date(now.getFullYear(), now.getMonth(), now.getDate() + DUE_SOON_DAYS);
  const last = civilDay(limit);
  return tasks.filter((task) => {
    if (!task || task.status === "done" || typeof task.dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(task.dueDate)) return false;
    const assignees = Array.isArray(task.assigneeIds) && task.assigneeIds.length ? task.assigneeIds : task.assigneeId ? [task.assigneeId] : [];
    return assignees.includes(memberId) && task.dueDate.slice(0, 10) <= last;
  }).length;
}

export function workTab({ roles = [], tasks = [], memberId = null, now = new Date() } = {}) {
  if (!Array.isArray(roles) || !roles.some((role) => STAFF_TOOL_ROLES.includes(role))) return null;
  const badge = dueSoonCount(tasks, memberId, now);
  return { viewKey: "tasks", path: "/m/tasks", badge: badge || null };
}
