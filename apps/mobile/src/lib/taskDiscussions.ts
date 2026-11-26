// Task references and the person's own task discussions for the Messages tab.
//
// BUG-UG-NATIVE-CASE-ROWS-AND-TASK-TITLES-DO-NOT-OPEN-20261111: the
// phone named a task UG-6 where the web names it FLEET-MAINTENANCE-6, and a
// task discussion could not be reached from Messages at all. The web lists the
// caller's task threads in Messages from their own task messages
// (src/features/messages/MessagesView.jsx); this is the same list for the phone.

import { foldMessageSearch } from './messageInbox';

// The web's task reference (src/lib/kanban.js taskKey): the chapter id in
// capitals and the chapter's own task number. Either half missing means the
// task has no reference yet, and the phone shows the plain "TASK" label.
export function nativeTaskReference(chapterID: unknown, taskNumber: unknown): string {
  const chapter = typeof chapterID === 'string' ? chapterID.trim() : '';
  const number = typeof taskNumber === 'number' ? taskNumber : typeof taskNumber === 'string' && taskNumber.trim() ? Number(taskNumber) : Number.NaN;
  if (!chapter || !Number.isSafeInteger(number) || number <= 0) return 'TASK';
  return `${chapter.toUpperCase()}-${number}`;
}

export type TaskDiscussionMessageRow = { task_id: string; body: string; created_at: string; sender_id: string };
export type TaskDiscussionTaskRow = { id: string; title: string; chapter_id: string | null; task_number: number | null };

export type TaskDiscussion = {
  taskID: string;
  title: string;
  reference: string;
  latestAt: string;
  latestPreview: string;
  latestFromYou: boolean;
};

// The web's task-message window (src/lib/memberApi.js reads 1,000 rows).
export const TASK_DISCUSSION_MESSAGE_LIMIT = 1000;
const PREVIEW_LENGTH = 120;

type EmbeddedTask = TaskDiscussionTaskRow & { deleted_at?: string | null };
// A task message as read with its task embedded (chapter_tasks!inner), so a
// deleted or unreadable task is dropped by the query before the row limit.
export type TaskDiscussionEmbeddedRow = TaskDiscussionMessageRow & { chapter_tasks: EmbeddedTask | readonly EmbeddedTask[] | null };

// The rows a task-message read returned, or none when it returned no list.
export function taskDiscussionRowList(value: unknown): TaskDiscussionEmbeddedRow[] {
  return Array.isArray(value) ? value as TaskDiscussionEmbeddedRow[] : [];
}

// PostgREST returns a many-to-one embed as one object; accept a one-item list too.
function embeddedTask(value: TaskDiscussionEmbeddedRow['chapter_tasks']): EmbeddedTask | null {
  if (value === null) return null;
  if ('id' in value) return value;
  return value[0] ?? null;
}

export function taskDiscussionsFromRows(rows: readonly TaskDiscussionEmbeddedRow[], userID: string): TaskDiscussion[] {
  const tasks = new Map<string, TaskDiscussionTaskRow>();
  const messages: TaskDiscussionMessageRow[] = [];
  for (const row of rows) {
    const task = embeddedTask(row.chapter_tasks);
    if (!task || task.deleted_at) continue;
    tasks.set(task.id, { id: task.id, title: task.title, chapter_id: task.chapter_id, task_number: task.task_number });
    messages.push({ task_id: row.task_id, body: row.body, created_at: row.created_at, sender_id: row.sender_id });
  }
  return buildTaskDiscussions(messages, [...tasks.values()], userID);
}

// One row per task the person can still read, newest message first. A task
// missing from `tasks` (deleted, or no longer in the person's chapter) is left
// out, so the list never names a task the screen would refuse.
export function buildTaskDiscussions(
  messages: readonly TaskDiscussionMessageRow[],
  tasks: readonly TaskDiscussionTaskRow[],
  userID: string,
): TaskDiscussion[] {
  const byID = new Map(tasks.map((task) => [task.id, task]));
  const latest = new Map<string, TaskDiscussionMessageRow>();
  for (const message of messages) {
    const current = latest.get(message.task_id);
    if (!current || message.created_at > current.created_at) latest.set(message.task_id, message);
  }
  return [...latest.values()]
    .filter((message) => byID.has(message.task_id))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.task_id.localeCompare(b.task_id))
    .map((message) => {
      const task = byID.get(message.task_id)!;
      const body = message.body.replace(/\s+/g, ' ').trim();
      return {
        taskID: task.id,
        title: task.title,
        reference: nativeTaskReference(task.chapter_id, task.task_number),
        latestAt: message.created_at,
        latestPreview: body.length > PREVIEW_LENGTH ? `${body.slice(0, PREVIEW_LENGTH - 1)}…` : body,
        latestFromYou: message.sender_id === userID,
      };
    });
}

// Messages search covers task discussions by title, reference and latest
// message, with the inbox's own rule.
export function filterTaskDiscussions(items: readonly TaskDiscussion[], query: string, locale?: string): TaskDiscussion[] {
  const needle = foldMessageSearch(query.trim(), locale);
  if (!needle) return [...items];
  return items.filter((item) => foldMessageSearch(`${item.title} ${item.reference} ${item.latestPreview}`, locale).includes(needle));
}

// The signed-in scope a task-discussion list belongs to: the person, their
// organization and the selected chapter. Null while signed out or while the
// workspace is reloading (a chapter switch clears the dashboard first), so no
// list is shown or loaded until the new chapter's own read (gate G6-8264 FINAL P1).
export function taskDiscussionScope(userID: string | null | undefined, organizationID: string | null | undefined, chapterID: string | null | undefined): string | null {
  if (!userID || !chapterID) return null;
  return JSON.stringify([userID, organizationID ?? null, chapterID]);
}

// Messages filter counts with task discussions in "All" (they are neither
// direct nor channel rows, so only All includes them; gate G6-8264 FINAL P2).
export function countWithTaskDiscussions<T extends { all: number }>(counts: T, taskDiscussions: number): T {
  return { ...counts, all: counts.all + taskDiscussions };
}
