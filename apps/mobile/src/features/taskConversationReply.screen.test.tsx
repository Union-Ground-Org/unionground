import { stubSessionWriter } from '../testing/stubSessionWriter';
// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';

// BUG-UG-NATIVE-IOS-TASK-DISCUSSION-HAS-NO-REPLY-FIELD-20261117:
// on iPhone the steward assigned a chapter task opened its conversation and
// found the officer's message but no field and no Send button. This opens the
// real task conversation screen as that steward, on both phones, against a fake
// Supabase client whose send_chapter_task_message applies the server's rules
// (only the creator and the assignee may write; the server picks the
// recipient and trims the text), posts a reply and reads the saved row.
type Row = Record<string, unknown>;
const port = vi.hoisted(() => ({
  app: {} as Record<string, unknown>,
  params: {} as Record<string, string>,
  client: null as unknown,
  reveal: vi.fn(),
  release: vi.fn(),
  context: vi.fn(),
}));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => port.params, useRouter: () => ({ push: vi.fn() }), Redirect: () => null }));
vi.mock('../components/ui', async () => {
  const ui = await import('../testing/uiStandIn');
  return { ...ui, StateMessage: ({ title, body }: { title: string; body?: string }) => h('section', null, title, ' ', body) };
});
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: ({ children }: { children?: ReactNode }) => h('div', null, children) }));
vi.mock('../components/ScreenKeyboardReveal', () => ({ useRevealAboveKeyboard: () => ({ reveal: port.reveal, release: port.release }) }));
vi.mock('../components/WorkflowActions', () => ({ WorkflowActions: () => null }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: () => stubSessionWriter(() => port.client), getSupabaseClient: () => port.client }));
vi.mock('../lib/connectedWorkflows', () => ({ connectedWorkflowApi: () => ({ context: port.context }) }));
vi.mock('../state/AppProvider', () => ({ useApp: () => port.app }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));

import TaskConversationRoute from '../../app/task-conversation/[id]';

const taskID = '5b0d6c2e-7f41-4c39-9a52-1f3e8d7c6b10';
const chapter = 'c0a8e1f2-3b4d-4e5f-8a6b-7c8d9e0f1a2b';
const officer = '7f3a1b2c-9d8e-4c5f-a6b7-0e1d2c3b4a59';
const steward = '1c4e7a90-3b2d-4f6e-8a1c-5d9b0e7f2a36';
const bystander = '2d5f8b1e-6c3a-4e9d-b7f0-1a4c8e2d6b93';

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
const text = () => screen!.container.textContent ?? '';
async function open(caller: string, db: Db, options?: { failSend?: boolean; language?: 'en' | 'es'; sending?: Promise<void> }) {
  const language = options?.language ?? 'en';
  port.client = fakeClient(db, caller, options);
  port.app = { mode: 'authenticated', session: { user: { id: caller } }, authorizedRoles: ['steward'], organizationID: 'org-tamarack', memberLanguage: language, dashboard: { member: { id: caller, chapterID: chapter, language } } };
  screen = await render(h(TaskConversationRoute));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

beforeEach(() => { port.params = { id: taskID }; port.context.mockReset().mockResolvedValue({ available: true }); });
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); port.reveal.mockReset(); port.release.mockReset(); });

describe.each<'ios' | 'android'>(['ios', 'android'])('replying in a task conversation on %s', (os) => {
  beforeEach(() => { setPlatform(os); });

  it('lets the assigned committee member post a reply that is saved for the officer and shown in the conversation', async () => {
    const db = database();
    await open(steward, db);
    expect(text()).toContain('Please collect the sign-up sheets by Friday.');
    const field = getExposed(screen!.container, 'Reply in this task');
    expect(getExposed(screen!.container, 'Send message').getAttribute('aria-disabled')).toBe('true');
    await type(field, '  The sheets are in the committee member box.  ');
    const send = getExposed(screen!.container, 'Send message');
    expect(send.getAttribute('aria-disabled')).toBeNull();
    await press(send);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(db.chapter_task_messages).toHaveLength(2);
    expect(db.chapter_task_messages[1]).toMatchObject({ task_id: taskID, chapter_id: chapter, sender_id: steward, recipient_id: officer, body: 'The sheets are in the committee member box.' });
    expect(text()).toContain('The sheets are in the committee member box.');
    expect(text()).toContain('Reply sent.');
    expect((getExposed(screen!.container, 'Reply in this task') as HTMLTextAreaElement).value).toBe('');
  });

  it('lifts the field and its Send button above the keyboard while the field has focus', async () => {
    await open(steward, database());
    const field = getExposed(screen!.container, 'Reply in this task');
    await act(async () => { field.focus(); });
    expect(port.reveal).toHaveBeenCalledTimes(1);
    await act(async () => { field.blur(); });
    expect(port.release).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft and says so when the reply is not sent', async () => {
    const db = database();
    await open(steward, db, { failSend: true });
    await type(getExposed(screen!.container, 'Reply in this task'), 'The sheets are in the committee member box.');
    await press(getExposed(screen!.container, 'Send message'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(db.chapter_task_messages).toHaveLength(1);
    expect(text()).toContain('That message could not be sent. Your draft is still here.');
    expect((getExposed(screen!.container, 'Reply in this task') as HTMLTextAreaElement).value).toBe('The sheets are in the committee member box.');
  });

  // The composer was English for a
  // Spanish member. Every word of it now follows the member's language.
  it('speaks Spanish to a Spanish worker: field, placeholder, Send, sent and not-sent notices', async () => {
    const db = database();
    await open(steward, db, { language: 'es' });
    const field = getExposed(screen!.container, 'Responder en esta tarea') as HTMLTextAreaElement;
    expect(field.placeholder).toBe('Escriba una actualización privada sobre esta tarea…');
    await type(field, 'Las hojas están en el buzón del integrante del comité.');
    await press(getExposed(screen!.container, 'Enviar mensaje'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(db.chapter_task_messages[1]).toMatchObject({ sender_id: steward, recipient_id: officer, body: 'Las hojas están en el buzón del integrante del comité.' });
    expect(text()).toContain('Respuesta enviada.');
    expect(text()).not.toContain('Reply sent.');
    await screen!.unmount(); screen = null;
    await open(steward, database(), { failSend: true, language: 'es' });
    await type(getExposed(screen!.container, 'Responder en esta tarea'), 'Las hojas están en el buzón del integrante del comité.');
    await press(getExposed(screen!.container, 'Enviar mensaje'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(text()).toContain('No se pudo enviar ese mensaje. Tu borrador sigue aquí.');
    expect(text()).not.toMatch(/Reply in this task|Write a private update|Send message|could not be sent/);
  });

  it('offers no field to a campaign worker who neither created nor holds the task', async () => {
    const db = database();
    db.chapter_task_messages[0] = { ...db.chapter_task_messages[0], recipient_id: bystander };
    await open(bystander, db);
    expect(text()).toContain('Please collect the sign-up sheets by Friday.');
    expect(() => getExposed(screen!.container, 'Reply in this task')).toThrow();
    expect(() => getExposed(screen!.container, 'Send message')).toThrow();
  });

  // The foreground check keeps the session's user but clears the protected
  // workspace. Exercise that real screen input, including its fresh access read.
  async function boot() {
    const actor = port.app;
    port.app = { ...actor, mode: 'booting', dashboard: null, organizationID: null, authorizedRoles: [] };
    await screen!.rerender(h(TaskConversationRoute));
    expect(text()).not.toContain('Please collect');
    expect(screen!.container.querySelector('textarea')).toBeNull();
    return actor;
  }

  it('holds the exact task draft through resume, hidden until the fresh task read succeeds', async () => {
    await open(steward, database());
    await type(getExposed(screen!.container, 'Reply in this task'), 'Unfinished task reply');
    const actor = await boot();
    let allow!: (value: { available: boolean }) => void;
    port.context.mockImplementationOnce(() => new Promise((resolve) => { allow = resolve; }));
    port.app = actor;
    await screen!.rerender(h(TaskConversationRoute));
    expect(text()).not.toContain('Please collect');
    expect(screen!.container.querySelector('textarea')).toBeNull();
    await act(async () => { allow({ available: true }); });
    expect((getExposed(screen!.container, 'Reply in this task') as HTMLTextAreaElement).value).toBe('Unfinished task reply');
  });

  it('keeps a pending task send busy across resume and lands its completion once', async () => {
    let finish!: () => void;
    const sending = new Promise<void>((resolve) => { finish = resolve; });
    const db = database();
    await open(steward, db, { sending });
    await type(getExposed(screen!.container, 'Reply in this task'), 'Send this once');
    await press(getExposed(screen!.container, 'Send message'));
    port.app = await boot();
    await screen!.rerender(h(TaskConversationRoute));
    expect(getExposed(screen!.container, 'Sending message').getAttribute('aria-disabled')).toBe('true');
    expect((getExposed(screen!.container, 'Reply in this task') as HTMLTextAreaElement).value).toBe('Send this once');
    await act(async () => { finish(); });
    expect(db.chapter_task_messages).toHaveLength(2);
    expect(text()).toContain('Reply sent.');
    expect((getExposed(screen!.container, 'Reply in this task') as HTMLTextAreaElement).value).toBe('');
  });

  it.each([false, true])('ignores a retired task send after authoritative refusal and restored access (failed=%s)', async (failSend) => {
    let finish!: () => void;
    await open(steward, database(), { failSend, sending: new Promise<void>((resolve) => { finish = resolve; }) });
    await type(getExposed(screen!.container, 'Reply in this task'), 'Old pending task reply');
    await press(getExposed(screen!.container, 'Send message'));
    const actor = await boot();
    port.context.mockResolvedValue({ available: false });
    port.app = actor;
    await screen!.rerender(h(TaskConversationRoute));
    expect(text()).toContain('Conversation unavailable');
    port.context.mockResolvedValue({ available: true });
    await press(getExposed(screen!.container, 'Try again'));
    const field = getExposed(screen!.container, 'Reply in this task') as HTMLTextAreaElement;
    expect(field.value).toBe('');
    await type(field, 'New task draft after access returns');
    await act(async () => { finish(); });
    expect(field.value).toBe('New task draft after access returns');
    expect(text()).not.toContain('Reply sent.');
    expect(text()).not.toContain('That message could not be sent');
  });

  it('drops the task draft on another account and ignores the old pending completion', async () => {
    let finish!: () => void;
    const db = database();
    await open(steward, db, { sending: new Promise<void>((resolve) => { finish = resolve; }) });
    await type(getExposed(screen!.container, 'Reply in this task'), 'Only the first account');
    await press(getExposed(screen!.container, 'Send message'));
    port.app = { ...port.app, mode: 'signedOut', session: null, dashboard: null };
    await screen!.rerender(h(TaskConversationRoute));
    port.client = fakeClient(db, officer);
    port.app = { ...port.app, mode: 'authenticated', session: { user: { id: officer } }, dashboard: { member: { id: officer, chapterID: chapter, language: 'en' } } };
    await screen!.rerender(h(TaskConversationRoute));
    await act(async () => { finish(); });
    expect((getExposed(screen!.container, 'Reply in this task') as HTMLTextAreaElement).value).toBe('');
    expect(text()).not.toContain('Reply sent.');
  });

  it.each<'removed' | 'no longer assigned' | 'campaign changed' | 'organization changed' | 'role changed'>(['removed', 'no longer assigned', 'campaign changed', 'organization changed', 'role changed'])('retires the held task draft when %s after resume', async (change) => {
    const db = database();
    await open(steward, db);
    await type(getExposed(screen!.container, 'Reply in this task'), 'Do not carry this over');
    const actor = await boot();
    if (change === 'removed') port.context.mockResolvedValue({ available: false });
    if (change === 'no longer assigned') db.chapter_tasks[0]!.assignee_id = bystander;
    port.app = { ...actor,
      ...(change === 'campaign changed' ? { dashboard: { member: { id: steward, chapterID: 'another-chapter', language: 'en' } } } : {}),
      ...(change === 'role changed' ? { authorizedRoles: [] } : {}),
      ...(change === 'organization changed' ? { organizationID: 'another-org' } : {}),
    };
    await screen!.rerender(h(TaskConversationRoute));
    expect(screen!.container.querySelector('textarea')?.value ?? '').toBe('');
    expect(text()).not.toContain('Do not carry this over');
    expect(db.chapter_task_messages).toHaveLength(1);
  });

  it('drops the draft when the task route changes during the foreground check', async () => {
    const db = database();
    await open(steward, db);
    await type(getExposed(screen!.container, 'Reply in this task'), 'Old task only');
    const actor = await boot();
    const nextID = '9b0d6c2e-7f41-4c39-9a52-1f3e8d7c6b10';
    db.chapter_tasks.push({ ...db.chapter_tasks[0], id: nextID });
    port.params = { id: nextID };
    await screen!.rerender(h(TaskConversationRoute));
    port.app = actor;
    await screen!.rerender(h(TaskConversationRoute));
    expect((getExposed(screen!.container, 'Reply in this task') as HTMLTextAreaElement).value).toBe('');
    expect(text()).not.toContain('Please collect');
  });
});
