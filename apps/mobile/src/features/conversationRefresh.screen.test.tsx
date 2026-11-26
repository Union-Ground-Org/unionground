import { stubSessionWriter } from '../testing/stubSessionWriter';
// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import type { MemberConversationThread } from '../models/member';

// BUG-UG-NATIVE-CONVERSATION-REFRESH-FAILURE-HIDES-LOADED-MESSAGES-20261115 (#8769):
// both native conversation screens refresh every 30 seconds. One failed or
// timed-out background refresh used to replace a loaded conversation with the
// unavailable state. Now it keeps the loaded messages with a not-updated
// notice, a later success clears the notice, a refusal still clears the
// conversation, and only a failed first load shows the unavailable state.
const port = vi.hoisted(() => ({
  app: {} as Record<string, unknown>,
  params: {} as Record<string, string>,
  loadThread: vi.fn(),
  loadTask: vi.fn(),
  sendThread: vi.fn(),
  compose: null as null | ((kind: 'reply' | 'edit') => void),
}));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('react-native-svg', () => { const Shape = () => null; return { default: Shape, Circle: Shape, Line: Shape, Path: Shape, Polygon: Shape, Rect: Shape }; });
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => port.params, useRouter: () => ({ push: vi.fn() }), Redirect: () => null }));
vi.mock('../components/ui', async () => {
  const ui = await import('../testing/uiStandIn');
  return { ...ui, Avatar: () => null, StateMessage: ({ title, body, action }: { title: string; body?: string; action?: ReactNode }) => h('section', null, title, ' ', body, action) };
});
vi.mock('../components/PinnedHeader', () => ({
  PinnedHeaderScreen: ({ children, title }: { children?: ReactNode; title?: string }) => h('div', null, h('header', null, title), children),
  usePinnedHeaderChrome: () => null,
  useScreenNameAlreadySpoken: () => ({ duplicate: false, hiddenProps: {} }),
}));
vi.mock('../components/TopChrome', () => ({ TopRamp: () => null }));
vi.mock('../components/WorkflowActions', () => ({ WorkflowActions: () => null, WorkflowMessageActions: ({ children, onCompose }: { children?: ReactNode; onCompose?: (kind: 'reply' | 'edit') => void }) => { port.compose = onCompose ?? null; return h('div', null, children); } }));
vi.mock('../components/MessageReactions', () => ({ AddReactionChip: () => null, MessageReactionButton: () => null, MessageReactionPicker: () => null }));
vi.mock('../components/NativeMessageActions', () => ({ NativeMessageActions: ({ children }: { children?: ReactNode }) => h('div', null, children) }));
vi.mock('../components/MessageReplies', () => ({ MessageReplies: () => null, ParentMessageControl: () => null, ReplyCountControl: () => null, useMessageReplyCounts: () => ({}) }));
vi.mock('./SavedPulseCharts', () => ({ LiveChartMessage: () => null }));
vi.mock('./guideLayers/staffGuidesData', () => ({ finishStaffGuide: vi.fn(), liveStaffGuideHat: () => null }));
vi.mock('./useConversationHistory', () => ({
  conversationHistoryCopy: { failed: 'Earlier messages did not load.', tryAgain: 'Try again', loadingEarlier: 'Loading', showEarlier: 'Show earlier' },
  useConversationHistory: ({ thread }: { thread: MemberConversationThread | null }) => ({ messages: thread?.messages ?? [], status: 'idle', hasEarlier: false, started: false }),
}));
vi.mock('./prependAnchor', () => ({ usePrependAnchor: () => ({ laidOut: () => 'unchanged', scrolled: () => undefined }) }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: { user: { id: string } } | null) => stubSessionWriter(() => null, session?.user.id ?? 'signed-out'),
  getSupabaseClient: () => null,
  loadConversationThread: port.loadThread,
  loadEarlierConversationMessages: vi.fn(),
  markConversationRead: vi.fn(async () => undefined),
  reactToConversationMessage: vi.fn(),
  sendMemberMessage: port.sendThread,
  sendStewardReply: vi.fn(),
}));
vi.mock('../services/haptics', () => ({ haptics: { success: vi.fn(), light: vi.fn(), selection: vi.fn(), warning: vi.fn() } }));
vi.mock('../services/stewardDirectInbox', () => ({ nativeDirectAudience: () => 'member' }));
vi.mock('../lib/announce', () => ({ announceForAccessibility: vi.fn() }));
vi.mock('../lib/connectedWorkflows', () => ({ connectedStaffAccess: () => false, connectedWorkflowApi: () => null }));
type TaskLoad = typeof import('../lib/taskConversationLoad');
vi.mock('../lib/taskConversationLoad', async (original) => ({ ...await original<TaskLoad>(), loadTaskConversation: port.loadTask }));
vi.mock('../state/AppProvider', () => ({ useApp: () => port.app }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));

import { ReadDeadlineError } from '../lib/readDeadline';
import { TaskConversationRefused, type TaskConversationSource } from '../lib/taskConversationLoad';
import ConversationScreen from '../../app/conversation/[id]';
import TaskConversationRoute from '../../app/task-conversation/[id]';

const member = '1c4e7a90-3b2d-4f6e-8a1c-5d9b0e7f2a36';
const privateField = () => screen!.container.querySelector<HTMLTextAreaElement>('textarea[placeholder="Conversation reply"]')!;
const notUpdated = 'Not updated. Showing the messages that loaded earlier; this tries again shortly.';

function thread(body: string): MemberConversationThread {
  return {
    conversation: { id: 'conversation-1', title: 'Tamarack committee member desk', initials: 'TS', createdAt: '2026-11-01T15:00:00Z', updatedAt: '2026-11-14T15:00:00Z', unreadCount: 0, latestMessage: body },
    readerIsStaff: false,
    messages: [{ id: 'message-1', conversationID: 'conversation-1', senderKind: 'steward', senderName: 'Tamarack committee member', body, createdAt: '2026-11-14T15:00:00Z', readAt: null, parentMessageID: null }],
  };
}
const taskMessages = (body: string) => ({ messages: [{ id: 'task-message-1', body, created_at: '2026-11-14T15:00:00Z', sender_id: 'coordinator', recipient_id: member }], more: false });

let screen: Rendered | null = null;
const text = () => screen!.container.textContent ?? '';
// Run the screen's next 30-second refresh and let its read settle. Only the
// interval timers are fake, so promises and the stand-in's own work run as usual.
async function tick() { await act(async () => { vi.advanceTimersByTime(30000); }); await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  port.app = { mode: 'authenticated', session: { user: { id: member } }, sessionRestricted: false, authorizedRoles: [], organizationRoles: [], chapterRoles: [], organizationID: 'org-tamarack', memberLanguage: 'en', refresh: vi.fn(), dashboard: { member: { id: member, chapterID: 'chapter-a', language: 'en' } } };
});
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); vi.useRealTimers(); port.loadThread.mockReset(); port.loadTask.mockReset(); port.sendThread.mockReset(); port.compose = null; });

describe.each<'ios' | 'android'>(['ios', 'android'])('worker conversation refresh on %s', (os) => {
  beforeEach(() => { setPlatform(os); port.params = { id: 'conversation-1' }; });

  it('keeps the loaded messages through a failed refresh and a timed-out one, and a later success clears the notice', async () => {
    port.loadThread.mockResolvedValueOnce(thread('Your meeting is Tuesday.'));
    screen = await render(h(ConversationScreen));
    expect(text()).toContain('Your meeting is Tuesday.');
    port.loadThread.mockRejectedValueOnce(new Error('offline'));
    await tick();
    expect(text()).toContain('Your meeting is Tuesday.');
    expect(text()).toContain(notUpdated);
    expect(text()).not.toContain('Conversation not available');
    port.loadThread.mockRejectedValueOnce(new ReadDeadlineError());
    await tick();
    expect(text()).toContain('Your meeting is Tuesday.');
    expect(text()).toContain(notUpdated);
    port.loadThread.mockResolvedValueOnce(thread('Your meeting moved to Wednesday.'));
    await tick();
    expect(text()).toContain('Your meeting moved to Wednesday.');
    expect(text()).not.toContain(notUpdated);
  });

  // Review P1-1 on #8798: a server refusal (a permission error, or a session
  // the server no longer accepts) clears the thread like a removal does.
  it.each([{ code: '42501', message: 'permission denied' }, { code: 'PGRST301', message: 'JWT expired' }])('clears the conversation when a refresh is refused with $code', async (refusal) => {
    port.loadThread.mockResolvedValueOnce(thread('Your meeting is Tuesday.'));
    screen = await render(h(ConversationScreen));
    port.loadThread.mockRejectedValueOnce(refusal);
    await tick();
    expect(text()).not.toContain('Your meeting is Tuesday.');
    expect(text()).not.toContain(notUpdated);
    expect(text()).toContain('Conversation not available');
  });

  it('still clears the conversation when a refresh says it was removed or access changed', async () => {
    port.loadThread.mockResolvedValueOnce(thread('Your meeting is Tuesday.'));
    screen = await render(h(ConversationScreen));
    port.loadThread.mockResolvedValueOnce(null);
    await tick();
    expect(text()).not.toContain('Your meeting is Tuesday.');
    expect(text()).toContain('Conversation not available');
  });

  it('shows the unavailable state only for a failed first load, and a later successful refresh clears it without Try again', async () => {
    port.loadThread.mockRejectedValueOnce(new ReadDeadlineError());
    screen = await render(h(ConversationScreen));
    expect(text()).toContain('Conversation not available');
    expect(text()).toContain('could not be loaded securely');
    port.loadThread.mockResolvedValueOnce(thread('Your meeting is Tuesday.'));
    await tick();
    expect(text()).toContain('Your meeting is Tuesday.');
    expect(text()).not.toContain('Conversation not available');
    expect(text()).not.toContain(notUpdated);
  });

  async function boot() {
    const actor = port.app;
    port.app = { ...actor, mode: 'booting', dashboard: null, organizationID: null, authorizedRoles: [] };
    await screen!.rerender(h(ConversationScreen));
    expect(text()).not.toContain('Your meeting is Tuesday.');
    expect(screen!.container.querySelector('textarea')).toBeNull();
    expect(screen!.container.querySelector('header')!.textContent).toBe('Messages');
    return actor;
  }

  it.each<'plain' | 'reply' | 'edit'>(['plain', 'reply', 'edit'])('holds the %s draft and its choice through resume, hidden until a fresh read succeeds', async (choice) => {
    port.loadThread.mockResolvedValue(thread('Your meeting is Tuesday.'));
    screen = await render(h(ConversationScreen));
    if (choice !== 'plain') await act(async () => { port.compose!(choice); });
    await type(privateField(), 'Unfinished private reply');
    const actor = await boot();
    let finish!: (value: MemberConversationThread) => void;
    port.loadThread.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    port.app = actor;
    await screen.rerender(h(ConversationScreen));
    expect(screen.container.querySelector('textarea')).toBeNull();
    expect(screen.container.querySelector('header')!.textContent).toBe('Messages');
    expect(text()).not.toContain('Your meeting is Tuesday.');
    await act(async () => { finish(thread('Your meeting is Tuesday.')); });
    expect((privateField() as HTMLTextAreaElement).value).toBe('Unfinished private reply');
    if (choice !== 'plain') getExposed(screen.container, choice === 'edit' ? 'Cancel editing' : 'Cancel reply');
    if (choice !== 'plain') expect(port.loadThread).toHaveBeenCalledWith(member, 'conversation-1', { messageID: 'message-1', staff: false });
    expect(port.sendThread).not.toHaveBeenCalled();
  });

  it.each<'reply' | 'edit'>(['reply', 'edit'])('retires a held %s when its message is removed but the conversation remains readable', async (choice) => {
    port.loadThread.mockResolvedValue(thread('Your meeting is Tuesday.'));
    screen = await render(h(ConversationScreen));
    await act(async () => { port.compose!(choice); });
    await type(privateField(), 'Draft for a removed message');
    const actor = await boot();
    port.loadThread.mockImplementation((_user: string, _id: string, options: { messageID?: string }) => Promise.resolve(options.messageID ? null : thread('Fresh permitted conversation')));
    port.app = actor;
    await screen.rerender(h(ConversationScreen));
    expect(text()).toContain('Fresh permitted conversation');
    expect(privateField().value).toBe('');
    expect(text()).not.toContain(choice === 'edit' ? 'Cancel editing' : 'Cancel reply');
    expect(port.sendThread).not.toHaveBeenCalled();
  });

  it('keeps the private send busy through resume and settles it once', async () => {
    port.loadThread.mockResolvedValue(thread('Your meeting is Tuesday.'));
    let finish!: () => void;
    port.sendThread.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    screen = await render(h(ConversationScreen));
    await type(privateField(), 'Send once');
    await press(getExposed(screen.container, 'Send message'));
    port.app = await boot();
    await screen.rerender(h(ConversationScreen));
    expect(getExposed(screen.container, 'Sending message').getAttribute('aria-disabled')).toBe('true');
    expect((privateField() as HTMLTextAreaElement).value).toBe('Send once');
    await act(async () => { finish(); });
    expect((privateField() as HTMLTextAreaElement).value).toBe('');
    expect(port.sendThread).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userId: member }), 'conversation-1', 'Send once');
  });

  it.each([false, true])('ignores a retired private send after authoritative removal and restored access (failed=%s)', async (failed) => {
    port.loadThread.mockResolvedValue(thread('Your meeting is Tuesday.'));
    let finish!: () => void;
    port.sendThread.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { finish = () => failed ? reject(new Error('Unconfirmed old send')) : resolve(); }));
    screen = await render(h(ConversationScreen));
    await type(privateField(), 'Old pending private reply');
    await press(getExposed(screen.container, 'Send message'));
    const actor = await boot();
    port.loadThread.mockResolvedValue(null);
    port.app = actor;
    await screen.rerender(h(ConversationScreen));
    expect(text()).toContain('Conversation not available');
    port.loadThread.mockResolvedValue(thread('Access restored'));
    await tick();
    expect(privateField().value).toBe('');
    await type(privateField(), 'New private draft after access returns');
    const reads = port.loadThread.mock.calls.length;
    await act(async () => { finish(); });
    expect(privateField().value).toBe('New private draft after access returns');
    expect(port.loadThread).toHaveBeenCalledTimes(reads);
    expect(text()).not.toContain('Your message was not confirmed');
  });

  it('drops the private draft and ignores its pending completion after another account signs in', async () => {
    port.loadThread.mockResolvedValue(thread('Your meeting is Tuesday.'));
    let finish!: () => void;
    port.sendThread.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    screen = await render(h(ConversationScreen));
    await type(privateField(), 'First account only');
    await press(getExposed(screen.container, 'Send message'));
    port.app = { ...port.app, mode: 'signedOut', session: null, dashboard: null };
    await screen.rerender(h(ConversationScreen));
    port.app = { ...port.app, mode: 'authenticated', session: { user: { id: 'another-member' } }, dashboard: { member: { chapterID: 'chapter-b' } } };
    port.loadThread.mockResolvedValue(thread('New account conversation'));
    await screen.rerender(h(ConversationScreen));
    const reads = port.loadThread.mock.calls.length;
    await act(async () => { finish(); });
    expect(port.loadThread).toHaveBeenCalledTimes(reads);
    expect(text()).toContain('New account conversation');
    expect(text()).not.toContain('Your meeting is Tuesday.');
    expect((privateField() as HTMLTextAreaElement).value).toBe('');
  });

  it.each<'removed' | 'refused' | 'role changed' | 'campaign changed' | 'organization changed'>(['removed', 'refused', 'role changed', 'campaign changed', 'organization changed'])('does not restore the private draft when %s', async (change) => {
    port.loadThread.mockResolvedValue(thread('Your meeting is Tuesday.'));
    screen = await render(h(ConversationScreen));
    await act(async () => { port.compose!('reply'); });
    await type(privateField(), 'No stale choice');
    const actor = await boot();
    if (change === 'removed') port.loadThread.mockResolvedValue(null);
    if (change === 'refused') port.loadThread.mockRejectedValue({ code: '42501' });
    port.app = { ...actor,
      ...(change === 'role changed' ? { authorizedRoles: ['steward'] } : {}),
      ...(change === 'campaign changed' ? { dashboard: { member: { chapterID: 'chapter-b' } } } : {}),
      ...(change === 'organization changed' ? { organizationID: 'org-b' } : {}),
    };
    await screen.rerender(h(ConversationScreen));
    expect(screen.container.querySelector('textarea')?.value ?? '').toBe('');
    expect(text()).not.toContain('Cancel reply');
    expect(port.sendThread).not.toHaveBeenCalled();
  });

  it('drops the private draft and edit choice if the route changes during booting', async () => {
    port.loadThread.mockResolvedValue(thread('Your meeting is Tuesday.'));
    screen = await render(h(ConversationScreen));
    await act(async () => { port.compose!('edit'); });
    await type(privateField(), 'Old conversation only');
    const actor = await boot();
    port.params = { id: 'conversation-2' };
    await screen.rerender(h(ConversationScreen));
    port.app = actor;
    port.loadThread.mockResolvedValue(thread('Different conversation'));
    await screen.rerender(h(ConversationScreen));
    expect(privateField().value).toBe('');
    expect(text()).not.toContain('Cancel editing');
    expect(text()).not.toContain('Your meeting is Tuesday.');
  });
});

describe.each<'ios' | 'android'>(['ios', 'android'])('task conversation refresh on %s', (os) => {
  beforeEach(() => { setPlatform(os); port.params = { id: 'task-1' }; });

  it('keeps the loaded messages through a failed refresh and a timed-out one, and a later success clears the notice', async () => {
    port.loadTask.mockResolvedValueOnce(taskMessages('Bring the sign-up sheet.'));
    screen = await render(h(TaskConversationRoute));
    expect(text()).toContain('Bring the sign-up sheet.');
    port.loadTask.mockRejectedValueOnce(new Error('Unavailable'));
    await tick();
    expect(text()).toContain('Bring the sign-up sheet.');
    expect(text()).toContain(notUpdated);
    expect(text()).not.toContain('Conversation unavailable');
    port.loadTask.mockRejectedValueOnce(new ReadDeadlineError());
    await tick();
    expect(text()).toContain('Bring the sign-up sheet.');
    port.loadTask.mockResolvedValueOnce(taskMessages('The sign-up sheet is on the table.'));
    await tick();
    expect(text()).toContain('The sign-up sheet is on the table.');
    expect(text()).not.toContain(notUpdated);
  });

  // Review P1-1 on #8798: the real loader turns a refused context check or a
  // refused message read into a refusal, and the screen clears.
  it.each([
    ['context', { code: 'not_authorized', sqlState: '42501' }],
    ['messages', { code: '42501', message: 'permission denied for table chapter_task_messages' }],
  ] as [string, object][])('clears the conversation when the %s read is refused', async (read, refusal) => {
    const actual = await vi.importActual<TaskLoad>('../lib/taskConversationLoad');
    const realLoad = actual.loadTaskConversation;
    let refuse = false;
    const source: TaskConversationSource = {
      context: async () => { if (refuse && read === 'context') throw refusal; return { available: true }; },
      messages: async () => (refuse && read === 'messages' ? { data: null, error: refusal } : { data: taskMessages('Bring the sign-up sheet.').messages, error: null }),
      message: async () => ({ data: null, error: null }),
      task: async () => ({ data: null, error: null }),
    };
    port.loadTask.mockImplementation((_source: unknown, input: Parameters<TaskLoad['loadTaskConversation']>[1]) => realLoad(source, input));
    screen = await render(h(TaskConversationRoute));
    expect(text()).toContain('Bring the sign-up sheet.');
    refuse = true;
    await tick();
    expect(text()).not.toContain('Bring the sign-up sheet.');
    expect(text()).toContain('Conversation unavailable');
  });

  it('still clears the conversation on a refusal', async () => {
    port.loadTask.mockResolvedValueOnce(taskMessages('Bring the sign-up sheet.'));
    screen = await render(h(TaskConversationRoute));
    port.loadTask.mockRejectedValueOnce(new TaskConversationRefused());
    await tick();
    expect(text()).not.toContain('Bring the sign-up sheet.');
    expect(text()).toContain('Conversation unavailable');
  });

  it('shows the unavailable state for a failed first load, and a later successful refresh clears it without Try again', async () => {
    port.loadTask.mockRejectedValueOnce(new Error('Unavailable'));
    screen = await render(h(TaskConversationRoute));
    expect(text()).toContain('Conversation unavailable');
    port.loadTask.mockResolvedValueOnce(taskMessages('Bring the sign-up sheet.'));
    await tick();
    expect(text()).toContain('Bring the sign-up sheet.');
    expect(text()).not.toContain('Conversation unavailable');
  });
});
