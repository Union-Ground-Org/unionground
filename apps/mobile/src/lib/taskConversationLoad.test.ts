import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// Universal links are off in the shipped policy; enable one fictional
// verified domain so the https form of the link is exercised.
vi.mock('./appLinkHosts', () => ({ APP_LINK_HOSTS: Object.freeze(['app.unionground.example']) }));

import { redirectSystemPath } from '../../app/+native-intent';
import { appRouteFromRouterPath, parseAppRoute, routerPath } from './routes';
import {
  TASK_CONVERSATION_UNAVAILABLE,
  canReplyToTask,
  isTaskConversationRefusal,
  loadTaskConversation,
  type TaskConversationSource,
  type TaskMessage,
} from './taskConversationLoad';

// REQ-UNION-GROUND-MOBILE-MEMBER-TASK-CONVERSATION-ENTRY-20261111: a member
// messaged on a chapter task had no way into this screen. The #8124 SAMPLE
// fixture is bot-49 (member) and bot-14 (coordinator) on one chapter task.
const taskID = '5b0d6c2e-7f41-4c39-9a52-1f3e8d7c6b10';
const otherTaskID = '9e2f4a61-0c8d-4b7e-8f13-6a5d2c1b0e94';
const member = '1c4e7a90-3b2d-4f6e-8a1c-5d9b0e7f2a36';
const coordinator = '7f3a1b2c-9d8e-4c5f-a6b7-0e1d2c3b4a59';

const row = (id: string, minute: number, from = coordinator, to = member): TaskMessage => ({
  id,
  body: `message ${id}`,
  created_at: `2026-11-11T14:${String(minute).padStart(2, '0')}:00.000Z`,
  sender_id: from,
  recipient_id: to,
});

// A fake server: the context check answers only for tasks the member's chapter
// can read; a missing task and an unreadable task get the same answer, the
// way private.cw_resolve_source returns {ok:false} for both.
function server(readable: Record<string, TaskMessage[]>, participants: { created_by: string | null; assignee_id: string | null } = { created_by: coordinator, assignee_id: member }): TaskConversationSource & { calls: string[] } {
  const calls: string[] = [];
  const messageTask = new Map(Object.entries(readable).flatMap(([task, rows]) => rows.map((message) => [message.id, task] as const)));
  return {
    calls,
    context: async ({ kind, id }) => {
      calls.push(`context:${kind}`);
      const task = kind === 'task' ? id : messageTask.get(id);
      return { available: Boolean(task && readable[task]) };
    },
    messages: async ({ taskID: task, userID, limit }) => {
      calls.push('messages');
      const rows = (readable[task] ?? []).filter((message) => message.sender_id === userID || message.recipient_id === userID);
      return { data: [...rows].reverse().slice(0, limit), error: null };
    },
    message: async ({ taskID: task, userID, messageID }) => {
      calls.push('message');
      const found = (readable[task] ?? []).find((message) => message.id === messageID && (message.sender_id === userID || message.recipient_id === userID));
      return { data: found ?? null, error: null };
    },
    task: async (request) => {
      calls.push('task');
      return { data: readable[request.taskID] ? { id: request.taskID, ...participants } : null, error: null };
    },
  };
}

const conversation = [row('a1', 1), row('a2', 2, member, coordinator), row('a3', 3)];

describe('task conversation deep link', () => {
  const link = `unionground://task-conversation/${taskID}`;

  it('routes a task-conversation link on both schemes to the task conversation screen', () => {
    expect(parseAppRoute(link)).toEqual({ kind: 'taskConversation', id: taskID });
    expect(parseAppRoute(`https://app.unionground.example/app/task-conversation/${taskID}`)).toEqual({ kind: 'taskConversation', id: taskID });
    expect(routerPath({ kind: 'taskConversation', id: taskID })).toBe(`/task-conversation/${taskID}`);
    for (const initial of [true, false]) {
      expect(redirectSystemPath({ path: link, initial })).toBe(`/task-conversation/${taskID}`);
    }
  });

  it('keeps the destination across sign-in like any other signed-in record', () => {
    // rootLayoutNavigation stores appRouteFromRouterPath(pathname) while signed
    // out and replays routerPath() after sign-in.
    const pending = appRouteFromRouterPath(`/task-conversation/${taskID}`);
    expect(pending).toEqual({ kind: 'taskConversation', id: taskID });
    expect(routerPath(pending!)).toBe(`/task-conversation/${taskID}`);
  });

  it('refuses malformed task links without echoing them', () => {
    for (const bad of [
      'unionground://task-conversation/not-a-uuid',
      `unionground://task-conversation/${taskID}/extra`,
      `unionground://task-conversation/${taskID}?message=${otherTaskID}`,
      `unionground://task-conversation/${taskID}#x`,
      'unionground://task-conversation',
    ]) {
      expect(parseAppRoute(bad)).toBeNull();
      expect(redirectSystemPath({ path: bad, initial: true })).not.toContain('task-conversation');
    }
  });
});

describe('task conversation access', () => {
  it('shows a participant their messages in time order', async () => {
    const source = server({ [taskID]: conversation });
    const loaded = await loadTaskConversation(source, { taskID, userID: member, limit: 50 });
    expect(loaded.messages.map((message) => message.id)).toEqual(['a1', 'a2', 'a3']);
    expect(loaded.more).toBe(false);
  });

  it('refuses a task the worker cannot read and a task that does not exist with the same error, before any message read', async () => {
    const source = server({ [otherTaskID]: conversation });
    const unreadable = loadTaskConversation(source, { taskID: otherTaskID.replace('9e2f', '0000'), userID: member, limit: 50 }).catch((error: Error) => error.message);
    const missing = loadTaskConversation(server({}), { taskID, userID: member, limit: 50 }).catch((error: Error) => error.message);
    expect(await unreadable).toBe(TASK_CONVERSATION_UNAVAILABLE);
    expect(await missing).toBe(TASK_CONVERSATION_UNAVAILABLE);
    expect(source.calls).toEqual(['context:task']);
  });

  it('refuses a selected message that is not the worker\'s with the same error', async () => {
    const outsider = '2d5f8b1e-6c3a-4e9d-b7f0-1a4c8e2d6b93';
    const source = server({ [taskID]: [...conversation, row('x1', 4, coordinator, outsider)] });
    await expect(loadTaskConversation(source, { taskID, messageID: 'x1', userID: member, limit: 50 })).rejects.toThrow(TASK_CONVERSATION_UNAVAILABLE);
  });

  it('refuses without a live worker or a client', async () => {
    await expect(loadTaskConversation(server({ [taskID]: conversation }), { taskID, limit: 50 })).rejects.toThrow(TASK_CONVERSATION_UNAVAILABLE);
    await expect(loadTaskConversation(null, { taskID, userID: member, limit: 50 })).rejects.toThrow(TASK_CONVERSATION_UNAVAILABLE);
  });

  it('turns a failed read into the same refusal, never the server error', async () => {
    const source: TaskConversationSource = {
      context: async () => ({ available: true }),
      messages: async () => ({ data: null, error: new Error('permission denied for table chapter_task_messages') }),
      message: async () => ({ data: null, error: null }),
      task: async () => ({ data: null, error: null }),
    };
    await expect(loadTaskConversation(source, { taskID, userID: member, limit: 50 })).rejects.toThrow(TASK_CONVERSATION_UNAVAILABLE);
  });

  it('pages the newest messages and keeps a selected older one', async () => {
    const source = server({ [taskID]: conversation });
    const loaded = await loadTaskConversation(source, { taskID, messageID: 'a1', userID: member, limit: 2 });
    expect(loaded.more).toBe(true);
    expect(loaded.messages.map((message) => message.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('the screen draws one refusal state for every failure', () => {
    const screen = readFileSync(fileURLToPath(new URL('../../app/task-conversation/[id].tsx', import.meta.url)), 'utf8');
    expect(screen).toContain('loadTaskConversation(taskConversationSource(), { taskID, messageID, userID, limit })');
    expect(screen.match(/<StateMessage title="Conversation unavailable"/g)).toHaveLength(1);
    // #8769: only a refusal or a failed first load clears the conversation;
    // conversationRefresh.screen.test.tsx executes the screen.
    expect(screen).toContain('if (isTaskConversationRefusal(reason) || !loaded) { loaded = false; setMessages(null); setCanReply(false); setStale(false); setError(true); } else setStale(true);');
  });

  // BUG-UG-NATIVE-CONVERSATION-REFRESH-FAILURE-HIDES-LOADED-MESSAGES-20261115 (#8769).
  it('tells a refusal (gone or no access) from a read that failed, with the same message for both', async () => {
    const reason = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);
    const refusals = [
      await reason(loadTaskConversation(server({}), { taskID, userID: member, limit: 50 })),
      await reason(loadTaskConversation(null, { taskID, userID: member, limit: 50 })),
      await reason(loadTaskConversation(server({ [taskID]: conversation }), { taskID, limit: 50 })),
      await reason(loadTaskConversation(server({ [taskID]: conversation }), { taskID, messageID: 'missing', userID: member, limit: 50 })),
    ];
    for (const error of refusals) { expect(isTaskConversationRefusal(error)).toBe(true); expect((error as Error).message).toBe(TASK_CONVERSATION_UNAVAILABLE); }
    const failing = (overrides: Partial<TaskConversationSource>): TaskConversationSource => ({ ...server({ [taskID]: conversation }), ...overrides });
    const failures = [
      await reason(loadTaskConversation(failing({ context: async () => { throw new Error('Read timed out'); } }), { taskID, userID: member, limit: 50 })),
      await reason(loadTaskConversation(failing({ messages: async () => ({ data: null, error: new Error('fetch failed') }) }), { taskID, userID: member, limit: 50 })),
      await reason(loadTaskConversation(failing({ message: async () => ({ data: null, error: new Error('fetch failed') }) }), { taskID, messageID: 'a1', userID: member, limit: 50 })),
    ];
    for (const error of failures) expect(isTaskConversationRefusal(error)).toBe(false);
    // Review P1-1 on #8798: a permission error or a refused session is a refusal.
    const refusedReads = [
      await reason(loadTaskConversation(failing({ context: async () => { throw Object.assign(new Error('not_authorized'), { code: 'not_authorized', sqlState: '42501' }); } }), { taskID, userID: member, limit: 50 })),
      await reason(loadTaskConversation(failing({ messages: async () => ({ data: null, error: { code: '42501', message: 'permission denied' } }) }), { taskID, userID: member, limit: 50 })),
      await reason(loadTaskConversation(failing({ message: async () => ({ data: null, error: { code: 'PGRST301', message: 'JWT expired' } }) }), { taskID, messageID: 'a1', userID: member, limit: 50 })),
      // Delta review of #8798: the facade turns an expired or invalid token on the
      // access check into code "unavailable" and keeps the raw code in sqlState.
      await reason(loadTaskConversation(failing({ context: async () => { throw Object.assign(new Error('unavailable'), { code: 'unavailable', sqlState: 'PGRST301' }); } }), { taskID, userID: member, limit: 50 })),
      await reason(loadTaskConversation(failing({ context: async () => { throw Object.assign(new Error('unavailable'), { code: 'unavailable', sqlState: 'PGRST303' }); } }), { taskID, userID: member, limit: 50 })),
    ];
    for (const error of refusedReads) expect(isTaskConversationRefusal(error)).toBe(true);
    expect((failures[1] as Error).message).toBe(TASK_CONVERSATION_UNAVAILABLE);
  });
});

// BUG-UG-NATIVE-IOS-TASK-DISCUSSION-HAS-NO-REPLY-FIELD-20261117
// (#9081): the screen offers a reply field to exactly the people
// public.send_chapter_task_message accepts: the task's creator and its
// assignee, when the other one is someone else.
describe('who can reply in a task conversation', () => {
  const outsider = '2d5f8b1e-6c3a-4e9d-b7f0-1a4c8e2d6b93';

  it('lets the assignee and the creator reply, and nobody else', async () => {
    expect((await loadTaskConversation(server({ [taskID]: conversation }), { taskID, userID: member, limit: 50 })).canReply).toBe(true);
    expect((await loadTaskConversation(server({ [taskID]: conversation }), { taskID, userID: coordinator, limit: 50 })).canReply).toBe(true);
    expect((await loadTaskConversation(server({ [taskID]: conversation }), { taskID, userID: outsider, limit: 50 })).canReply).toBe(false);
  });

  it('reads the task after the messages, so a refused conversation never reads it', async () => {
    const source = server({ [taskID]: conversation });
    await loadTaskConversation(source, { taskID, userID: member, limit: 50 });
    expect(source.calls).toEqual(['context:task', 'messages', 'task']);
  });

  it('offers no field on a task with no one to write to, or a task row it cannot read', () => {
    expect(canReplyToTask({ created_by: member, assignee_id: null }, member)).toBe(false);
    expect(canReplyToTask({ created_by: member, assignee_id: member }, member)).toBe(false);
    expect(canReplyToTask({ created_by: null, assignee_id: member }, member)).toBe(false);
    expect(canReplyToTask(null, member)).toBe(false);
    expect(canReplyToTask({ created_by: coordinator, assignee_id: member }, member)).toBe(true);
  });

  it('treats a refused task read as a refusal and any other failed one as a failed read', async () => {
    const base = server({ [taskID]: conversation });
    const refusedRead: TaskConversationSource = { ...base, task: async () => ({ data: null, error: { code: '42501', message: 'permission denied' } }) };
    const failedRead: TaskConversationSource = { ...base, task: async () => ({ data: null, error: { code: '57014', message: 'canceling statement' } }) };
    const refusal = await loadTaskConversation(refusedRead, { taskID, userID: member, limit: 50 }).catch((error: unknown) => error);
    const failure = await loadTaskConversation(failedRead, { taskID, userID: member, limit: 50 }).catch((error: unknown) => error);
    expect(isTaskConversationRefusal(refusal)).toBe(true);
    expect(isTaskConversationRefusal(failure)).toBe(false);
    expect((failure as Error).message).toBe(TASK_CONVERSATION_UNAVAILABLE);
  });
});
