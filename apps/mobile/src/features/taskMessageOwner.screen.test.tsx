// @vitest-environment jsdom
import { syncResumeDraftContext } from '../lib/resumeDraftHolder';
import type { ConnectedSourceRef } from '../lib/connectedWorkflows';
import palette from '../theme/palette.json';
import { stubSessionWriter } from '../testing/stubSessionWriter';
import { act, createElement as h, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';

// #9240 / ledger 612: selected-message and timeline presentations must not
// leave separate editable owners for the same retained connected message.
type Row = Record<string, unknown>;
const port = vi.hoisted(() => ({
  app: {} as Record<string, unknown>,
  params: {} as Record<string, string>,
  client: null as unknown,
  reveal: vi.fn(),
  release: vi.fn(),
  context: vi.fn(), send: vi.fn(), recipients: vi.fn(), sequence: 0,
}));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock('../components/EventDiscussionReader', () => ({ EventDiscussionReader: () => null }));
vi.mock('../components/ConnectedTaskEditor', () => ({ ConnectedTaskEditor: () => null }));
vi.mock('../components/NativeMessageActions', () => ({ NativeMessageActions: () => null }));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => port.params, useRouter: () => ({ push: vi.fn() }), Redirect: () => null }));
vi.mock('../components/ui', async () => {
  const ui = await import('../testing/uiStandIn');
  return { ...ui, StateMessage: ({ title, body }: { title: string; body?: string }) => h('section', null, title, ' ', body) };
});
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: ({ children }: { children?: ReactNode }) => h('div', null, children) }));
vi.mock('../components/ScreenKeyboardReveal', () => ({ useRevealAboveKeyboard: () => ({ reveal: port.reveal, release: port.release }) }));
type WorkflowModule = typeof import('../components/WorkflowActions');
vi.mock('../components/WorkflowActions', async (original) => { const actual = await original<WorkflowModule>(); return { WorkflowActions: (props: Parameters<typeof actual.WorkflowActions>[0]) => h('section', { 'data-workflow': `${props.kind}:${props.id}` }, h(actual.WorkflowActions, props)) }; });
vi.mock('../services/supabase', () => ({ captureSessionWriter: () => stubSessionWriter(() => port.client), getSupabaseClient: () => port.client }));
type ConnectedModule = typeof import('../lib/connectedWorkflows');
vi.mock('../lib/connectedWorkflows', async (original) => { const actual = await original<ConnectedModule>(); return { ...actual, connectedWorkflowApi: () => ({ context: port.context, recipients: port.recipients, send: port.send }), newConnectedRequestId: () => `owner-attempt-${++port.sequence}` }; });
vi.mock('../state/AppProvider', () => ({ useApp: () => { syncResumeDraftContext(port.app as Parameters<typeof syncResumeDraftContext>[0]); return port.app; } }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));

import TaskConversationRoute from '../../app/task-conversation/[id]';

const taskID = '5b0d6c2e-7f41-4c39-9a52-1f3e8d7c6b10';
const chapter = 'c0a8e1f2-3b4d-4e5f-8a6b-7c8d9e0f1a2b';
const officer = '7f3a1b2c-9d8e-4c5f-a6b7-0e1d2c3b4a59';
const steward = '1c4e7a90-3b2d-4f6e-8a1c-5d9b0e7f2a36';

type Db = { chapter_tasks: Row[]; chapter_task_messages: Row[] };

// A small PostgREST stand-in: the reads the screen makes, newest first for
// messages, and the send function with the server's participant rules.
function fakeClient(db: Db, caller: string, options: { failSend?: boolean; sending?: Promise<void> } = {}) {
  class Query implements PromiseLike<{ data: unknown; error: unknown }> {
    private filters: ((row: Row) => boolean)[] = [];
    private count = Infinity;
    private one = false;
    constructor(private table: keyof Db) {}
    select() { return this; }
    order() { return this; }
    eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
    or(expression: string) {
      const options = expression.split(',').map((part) => part.split('.eq.') as [string, string]);
      this.filters.push((row) => options.some(([column, value]) => row[column] === value));
      return this;
    }
    limit(count: number) { this.count = count; return this; }
    maybeSingle() { this.one = true; return this; }
    then<A, B>(done?: ((value: { data: unknown; error: unknown }) => A | PromiseLike<A>) | null, failed?: ((reason: unknown) => B | PromiseLike<B>) | null) {
      const rows = db[this.table].filter((row) => this.filters.every((filter) => filter(row)))
        .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
      const data = this.one ? rows[0] ?? null : rows.slice(0, this.count);
      return Promise.resolve({ data, error: null }).then(done, failed);
    }
  }
  return {
    from: (table: keyof Db) => new Query(table),
    rpc: async (name: string, args: { p_task_id: string; p_body: string }) => {
      await options.sending;
      if (name !== 'send_chapter_task_message' || options.failSend) return { data: null, error: { code: '57014', message: 'canceling statement' } };
      const task = db.chapter_tasks.find((row) => row.id === args.p_task_id);
      if (!task || (caller !== task.created_by && caller !== task.assignee_id)) return { data: null, error: { code: '22023', message: 'task unavailable' } };
      const recipient = caller === task.assignee_id ? task.created_by : task.assignee_id;
      const body = args.p_body.trim();
      if (!recipient || recipient === caller || body.length < 1 || body.length > 2000) return { data: null, error: { code: '22023', message: 'refused' } };
      const saved = { id: `saved-${db.chapter_task_messages.length + 1}`, task_id: task.id, chapter_id: task.chapter_id, sender_id: caller, recipient_id: recipient, body, created_at: '2026-11-17T23:50:00.000Z' };
      db.chapter_task_messages.push(saved);
      return { data: { id: saved.id, taskId: saved.task_id, chapterId: saved.chapter_id, senderId: saved.sender_id, recipientId: saved.recipient_id, body: saved.body, createdAt: saved.created_at }, error: null };
    },
  };
}

function database(): Db {
  return {
    chapter_tasks: [{ id: taskID, chapter_id: chapter, created_by: officer, assignee_id: steward }],
    chapter_task_messages: [{ id: 'officer-1', task_id: taskID, chapter_id: chapter, sender_id: officer, recipient_id: steward, body: 'Please collect the sign-up sheets by Friday.', created_at: '2026-11-17T23:40:00.000Z' }],
  };
}

let screen: Rendered | null = null;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  syncResumeDraftContext({ mode: 'signedOut', session: null, organizationID: null });
  vi.resetAllMocks(); port.sequence = 0;
  port.params = { id: taskID, message: 'officer-1' };
  port.context.mockImplementation((reference: ConnectedSourceRef) => Promise.resolve({ reference, available: true, canMessage: true, canRemind: false, canManageOrganizer: false, canContactOptIn: false, organizer: null, sourceLinks: [] }));
  port.recipients.mockResolvedValue({ status: 'available', items: [{ id: officer, label: 'Officer' }], nextCursor: null });
  port.send.mockResolvedValue({});
  port.client = fakeClient(database(), steward);
  port.app = { mode: 'authenticated', session: { access_token: 'owner-session-a', user: { id: steward } }, authorizedRoles: ['steward'], chapterRoles: ['steward'], organizationRoles: [],
    organizationID: 'org-a', memberLanguage: 'en', chapterMemberships: [{ selected: true, chapterID: chapter, organizationID: 'org-a' }],
    dashboard: { member: { id: steward, chapterID: chapter, language: 'en' } }, resumeDraftReads: { dashboard: true, memberships: true, staff: true } };
});
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); });
describe.each<'ios' | 'android'>(['ios', 'android'])('selected task message has one owner on %s', (os) => {
  it.each(['discard', 'success'])('cannot resend stale text from the second presentation after %s', async (outcome) => {
    setPlatform(os); screen = await render(h(TaskConversationRoute));
    await vi.waitFor(() => expect(screen!.container.querySelectorAll('[data-workflow="task_message:officer-1"]').length).toBeGreaterThan(0));
    const owners = screen.container.querySelectorAll('[data-workflow="task_message:officer-1"]');
    const first = owners[0]!;
    await press(getExposed(first, 'Task actions')); await press(getExposed(first, 'Message…'));
    await type(getExposed(first, 'Message'), 'Exactly one logical draft'); await press(getExposed(first, 'Officer'));
    // On Main there are two real sheets. Make both deliberate owners display
    // the same held text before completing or discarding through the first.
    if (owners[1]) {
      await press(getExposed(owners[1], 'Close'));
      await press(getExposed(owners[1], 'Task actions')); await press(getExposed(owners[1], 'Message…'));
      expect((getExposed(owners[1], 'Message') as HTMLTextAreaElement).value).toBe('Exactly one logical draft');
    }
    const response = deferred<object>(); port.send.mockReturnValueOnce(response.promise);
    await press(getExposed(first, 'Send message'));
    await act(async () => response.resolve(outcome === 'success' ? {} : Promise.reject(new Error('Reply lost'))));
    if (outcome === 'discard') await press(getExposed(first, 'Discard'));
    for (const owner of owners) {
      for (const button of owner.querySelectorAll('[role="button"]')) if (button.textContent === 'Send message') await press(button);
    }
    expect(port.send).toHaveBeenCalledTimes(1);
    expect(screen.container.querySelectorAll('[data-workflow="task_message:officer-1"]')).toHaveLength(1);
    expect([...screen.container.querySelectorAll('textarea')].some(input => input.value === 'Exactly one logical draft')).toBe(false);
  });
});

