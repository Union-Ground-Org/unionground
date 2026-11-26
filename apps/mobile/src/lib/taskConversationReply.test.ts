import { describe, expect, it, vi } from 'vitest';

import { sendTaskReply, taskReplyBody, TaskReplyNotSent, TASK_REPLY_LIMIT, type TaskReplyRpc } from './taskConversationReply';

// BUG-UG-NATIVE-IOS-TASK-DISCUSSION-HAS-NO-REPLY-FIELD-20261117
// (#9081): a phone reply goes through the website's send function with the
// trimmed text, and comes back as the screen's message row.
const taskID = '5b0d6c2e-7f41-4c39-9a52-1f3e8d7c6b10';
const saved = { id: 'saved-1', taskId: taskID, chapterId: 'chapter-a', senderId: 'steward', recipientId: 'officer', body: 'On my way.', createdAt: '2026-11-17T23:50:00.000Z' };

describe('task conversation reply', () => {
  it('sends the trimmed text through send_chapter_task_message and returns the saved row', async () => {
    const rpc = vi.fn<TaskReplyRpc>(async () => ({ data: saved, error: null }));
    await expect(sendTaskReply(rpc, taskID, '  On my way.  ')).resolves.toEqual({ id: 'saved-1', body: 'On my way.', created_at: saved.createdAt, sender_id: 'steward', recipient_id: 'officer' });
    expect(rpc).toHaveBeenCalledWith('send_chapter_task_message', { p_task_id: taskID, p_body: 'On my way.' });
  });

  it('sends nothing for blank text, text over 2,000 characters, or no client', async () => {
    const rpc = vi.fn<TaskReplyRpc>(async () => ({ data: saved, error: null }));
    for (const draft of ['', '   ', 'x'.repeat(TASK_REPLY_LIMIT + 1)]) await expect(sendTaskReply(rpc, taskID, draft)).rejects.toBeInstanceOf(TaskReplyNotSent);
    await expect(sendTaskReply(null, taskID, 'On my way.')).rejects.toBeInstanceOf(TaskReplyNotSent);
    expect(rpc).not.toHaveBeenCalled();
    expect(taskReplyBody('x'.repeat(TASK_REPLY_LIMIT))).toHaveLength(TASK_REPLY_LIMIT);
  });

  it('reports a server refusal or a missing row as not sent, without the server text', async () => {
    const refused = vi.fn<TaskReplyRpc>(async () => ({ data: null, error: { code: '22023', message: 'task unavailable' } }));
    const empty = vi.fn<TaskReplyRpc>(async () => ({ data: null, error: null }));
    await expect(sendTaskReply(refused, taskID, 'On my way.')).rejects.toThrow('Task reply not sent');
    await expect(sendTaskReply(empty, taskID, 'On my way.')).rejects.toBeInstanceOf(TaskReplyNotSent);
  });
});
