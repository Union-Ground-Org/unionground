import type { MobileSessionWriter } from './supabase';
// The phone's task form for a follow-up task (BUG-UNIONGROUND-NATIVE-IOS-EVENT-
// FOLLOW-UP-TASK-OPENS-NOTHING-20261117, #9080): read one task through the
// chapter_tasks read policy, list the people it may be given to, and save its
// title, assignee and due date. Every write goes through the same journalled,
// server-checked RPC the web task editor uses (update_chapter_task_fields), with
// the task's last-seen updated_at so a save never overwrites a newer change.

import { getSupabaseClient } from './supabase';

export const TASK_TITLE_MAX = 160;

export type EditableTask = {
  id: string;
  title: string;
  assigneeId: string | null;
  assigneeName: string;
  startDate: string | null;
  dueDate: string | null;
  updatedAt: string;
};

export type TaskAssignee = { id: string; label: string };

export type TaskEdits = { title: string; assigneeId: string | null; dueDate: string | null };

// Why a read or save did not go through, so the form can say which.
export type TaskEditFailure = 'changed' | 'not_allowed' | 'dates' | 'unavailable' | 'failed';

export class TaskEditError extends Error {
  readonly reason: TaskEditFailure;
  constructor(reason: TaskEditFailure) {
    super(`Task edit ${reason}`);
    this.reason = reason;
  }
}

const COLUMNS = 'id,title,assignee_id,assignee_name,start_date,due_date,updated_at';

function client() {
  const supabase = getSupabaseClient();
  if (!supabase) throw new TaskEditError('failed');
  return supabase;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function taskFromRow(row: Record<string, unknown> | null | undefined): EditableTask | null {
  if (!row || typeof row.id !== 'string' || typeof row.updated_at !== 'string') return null;
  return {
    id: row.id,
    title: typeof row.title === 'string' ? row.title : '',
    assigneeId: text(row.assignee_id),
    assigneeName: typeof row.assignee_name === 'string' ? row.assignee_name : '',
    startDate: text(row.start_date),
    dueDate: text(row.due_date),
    updatedAt: row.updated_at,
  };
}

/** The failure a PostgREST error stands for (codes from update_chapter_task_fields). */
export function taskEditFailure(error: unknown): TaskEditFailure {
  if (error instanceof TaskEditError) return error.reason;
  const code = String((error as { code?: unknown } | null)?.code ?? '');
  // PT409 since 20261106220000; 40001 before it.
  if (code === 'PT409' || code === '40001') return 'changed';
  if (code === '42501') return 'not_allowed';
  // chapter_tasks_dates_ordered: a due date before the task's start date.
  if (code === '23514') return 'dates';
  // 'task unavailable' (deleted, or outside the person's chapter).
  if (code === '22023') return 'unavailable';
  return 'failed';
}

/** A calendar date written YYYY-MM-DD that exists (no 2026-02-30). */
export function isTaskDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isTaskTitle(value: string): boolean {
  const title = value.trim();
  return title.length >= 1 && title.length <= TASK_TITLE_MAX;
}

export async function loadEditableTask(taskId: string): Promise<EditableTask> {
  const { data, error } = await client().from('chapter_tasks').select(COLUMNS)
    .eq('id', taskId).is('deleted_at', null).maybeSingle();
  if (error) throw new TaskEditError(taskEditFailure(error));
  const task = taskFromRow(data as Record<string, unknown> | null);
  if (!task) throw new TaskEditError('unavailable');
  return task;
}

/** Everyone in the person's chapter the task may be given to, by name. */
export async function loadTaskAssignees(): Promise<TaskAssignee[]> {
  const { data, error } = await client().rpc('list_chapter_task_assignees');
  if (error) throw new TaskEditError(taskEditFailure(error));
  if (!Array.isArray(data)) return [];
  return (data as Record<string, unknown>[]).flatMap((row) => (
    typeof row.user_id === 'string' && typeof row.full_name === 'string' && row.full_name.trim()
      ? [{ id: row.user_id, label: row.full_name.trim() }]
      : []
  ));
}

export async function saveTaskEdits(writer: MobileSessionWriter, task: EditableTask, edits: TaskEdits): Promise<EditableTask> {
  const title = edits.title.trim();
  if (!isTaskTitle(title) || (edits.dueDate !== null && !isTaskDate(edits.dueDate))) throw new TaskEditError('failed');
  const { data, error } = await (await writer.client()).rpc('update_chapter_task_fields', {
    p_task_id: task.id,
    p_fields: { title, assignee_id: edits.assigneeId, due_date: edits.dueDate },
    p_expected_updated_at: task.updatedAt,
  });
  if (error) throw new TaskEditError(taskEditFailure(error));
  const row = Array.isArray(data) ? data[0] : data;
  const saved = taskFromRow(row as Record<string, unknown> | null);
  if (!saved) throw new TaskEditError('failed');
  return saved;
}
