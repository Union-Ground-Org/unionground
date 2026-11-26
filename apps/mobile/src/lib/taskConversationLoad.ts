// One task conversation, for the signed-in participant
// (app/task-conversation/[id].tsx).
//
// REQ-UNION-GROUND-MOBILE-MEMBER-TASK-CONVERSATION-ENTRY-20261111: a member
// can now reach this screen from a unionground://task-conversation/<id> link,
// so every refusal must look the same. No client, no live member, a task the
// caller's chapter membership cannot read, a task that does not exist, and a
// selected message that is not theirs all throw TASK_CONVERSATION_UNAVAILABLE,
// and the screen draws one "Conversation unavailable" state for it. The
// server's context check already answers a missing and an unreadable task
// alike (private.cw_resolve_source returns {ok:false} for both).

import { isReadRefusal } from './readRefusal';

export type TaskMessage = { id: string; body: string; created_at: string; sender_id: string; recipient_id: string };

export type TaskConversationRows = { data: unknown; error: unknown };

export type TaskConversationSource = {
  // get_connected_workflow_context for the task or the selected task message.
  context: (reference: { kind: 'task' | 'task_message'; id: string }) => Promise<{ available: boolean } | null | undefined>;
  // Newest first, limited to messages the member sent or received.
  messages: (input: { taskID: string; userID: string; limit: number }) => Promise<TaskConversationRows>;
  // The selected message, under the same participant filter.
  message: (input: { taskID: string; userID: string; messageID: string }) => Promise<TaskConversationRows>;
  // The task's creator and assignee (chapter_tasks id, created_by, assignee_id),
  // the two people send_chapter_task_message lets write in it.
  task: (input: { taskID: string }) => Promise<TaskConversationRows>;
};

export type TaskParticipants = { created_by?: string | null; assignee_id?: string | null };

// BUG-UG-NATIVE-IOS-TASK-DISCUSSION-HAS-NO-REPLY-FIELD-20261117
// (#9081): whether this member can post in the task's conversation, by the
// same rule as public.send_chapter_task_message: the member created the task
// or is assigned to it, and the other one of the two is someone else. The
// server still decides; this only keeps the field from people it refuses.
export function canReplyToTask(task: TaskParticipants | null | undefined, userID: string): boolean {
  if (!task) return false;
  const creator = task.created_by ?? null;
  const assignee = task.assignee_id ?? null;
  if (userID !== creator && userID !== assignee) return false;
  const recipient = userID === assignee ? creator : assignee;
  return Boolean(recipient) && recipient !== userID;
}

export const TASK_CONVERSATION_UNAVAILABLE = 'Unavailable';

const memberIdPattern = /^[0-9a-f-]{36}$/i;

// BUG-UG-NATIVE-CONVERSATION-REFRESH-FAILURE-HIDES-LOADED-MESSAGES-20261115
// (#8769): a refusal is the server's answer that the task, the selected
// message or the member's access is gone, and it clears a loaded conversation.
// Any other failure (a read that errored, threw or timed out) is not a
// refusal: a background refresh keeps what loaded. A permission error or a
// refused session from any of the reads is a refusal too (isReadRefusal,
// review P1-1 on #8798). Both carry the same
// message, so the screen still draws one unavailable state for a first load.
export class TaskConversationRefused extends Error {
  constructor() { super(TASK_CONVERSATION_UNAVAILABLE); this.name = 'TaskConversationRefused'; }
}

export function isTaskConversationRefusal(error: unknown): boolean {
  return error instanceof TaskConversationRefused;
}

function refused(): Error {
  return new TaskConversationRefused();
}

function unavailable(): Error {
  return new Error(TASK_CONVERSATION_UNAVAILABLE);
}

export async function loadTaskConversation(
  source: TaskConversationSource | null,
  input: { taskID: string; messageID?: string; userID?: string; limit: number },
): Promise<{ messages: TaskMessage[]; more: boolean; canReply: boolean }> {
  const { taskID, messageID, userID, limit } = input;
  if (!source || !userID || !memberIdPattern.test(userID)) throw refused();
  let context: Awaited<ReturnType<TaskConversationSource['context']>>;
  try {
    context = await source.context({ kind: messageID ? 'task_message' : 'task', id: messageID || taskID });
  } catch (error) {
    throw isReadRefusal(error) ? refused() : error;
  }
  if (!context?.available) throw refused();
  const page = await source.messages({ taskID, userID, limit: limit + 1 });
  if (page.error) throw isReadRefusal(page.error) ? refused() : unavailable();
  const rows = (Array.isArray(page.data) ? page.data : []) as TaskMessage[];
  const more = rows.length > limit;
  const visible = rows.slice(0, limit);
  if (messageID) {
    const exact = await source.message({ taskID, userID, messageID });
    if (exact.error) throw isReadRefusal(exact.error) ? refused() : unavailable();
    if (!exact.data) throw refused();
    if (!visible.some((row) => row.id === messageID)) visible.push(exact.data as TaskMessage);
  }
  const task = await source.task({ taskID });
  if (task.error) throw isReadRefusal(task.error) ? refused() : unavailable();
  const canReply = canReplyToTask(task.data as TaskParticipants | null, userID);
  return { messages: visible.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)), more, canReply };
}
