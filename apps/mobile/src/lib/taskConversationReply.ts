// A reply in a chapter task's conversation (app/task-conversation/[id].tsx).
//
// BUG-UG-NATIVE-IOS-TASK-DISCUSSION-HAS-NO-REPLY-FIELD-20261117
// (#9081): the phone screen listed a task's messages but had no way to answer
// them. A reply goes through public.send_chapter_task_message, the function the
// website's task conversation uses (src/lib/memberApi.js
// sendChapterTaskMessage). The server picks the recipient (the assignee writes
// to the creator, the creator to the assignee), checks both are in the task's
// chapter, trims the text and refuses anything outside 1 to 2,000 characters.

import type { TaskMessage } from './taskConversationLoad';

export const TASK_REPLY_LIMIT = 2000;

export type TaskReplyRpc = (
  name: 'send_chapter_task_message',
  args: { p_task_id: string; p_body: string },
) => PromiseLike<{ data: unknown; error: unknown }>;

export class TaskReplyNotSent extends Error {
  constructor() { super('Task reply not sent'); this.name = 'TaskReplyNotSent'; }
}

// The text that would be sent, or null when there is nothing to send or it is
// over the limit.
export function taskReplyBody(draft: string): string | null {
  const body = draft.trim();
  return body && body.length <= TASK_REPLY_LIMIT ? body : null;
}

// Posts the reply and returns the saved row in the screen's message shape. A
// server error or a missing row throws TaskReplyNotSent, never the server's
// own message.
export async function sendTaskReply(rpc: TaskReplyRpc | null, taskID: string, draft: string): Promise<TaskMessage> {
  const body = taskReplyBody(draft);
  if (!rpc || !body) throw new TaskReplyNotSent();
  const { data, error } = await rpc('send_chapter_task_message', { p_task_id: taskID, p_body: body });
  const saved = (Array.isArray(data) ? data[0] : data) as {
    id?: unknown; body?: unknown; createdAt?: unknown; senderId?: unknown; recipientId?: unknown;
  } | null;
  if (error || !saved || typeof saved.id !== 'string' || typeof saved.createdAt !== 'string') throw new TaskReplyNotSent();
  return {
    id: saved.id,
    body: typeof saved.body === 'string' ? saved.body : body,
    created_at: saved.createdAt,
    sender_id: typeof saved.senderId === 'string' ? saved.senderId : '',
    recipient_id: typeof saved.recipientId === 'string' ? saved.recipientId : '',
  };
}
