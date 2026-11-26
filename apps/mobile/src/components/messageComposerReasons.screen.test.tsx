// @vitest-environment jsdom
import { act, createElement as h, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import { AccessibilityInfo, getExposed, press, render, setPlatform, type, type Rendered, TextInput } from '../testing/reactNativeStandIn';
import { syncResumeDraftContext, type ResumeDraftReads } from '../lib/resumeDraftHolder';
import { connectedActionsCopy } from '../lib/connectedWorkflowsCopy';
import palette from '../theme/palette.json';

type ConnectedWorkflowModule = typeof import('../lib/connectedWorkflows');

const port = vi.hoisted(() => ({ context: vi.fn(), recipients: vi.fn(), send: vi.fn(), createTask: vi.fn(), organizerCandidates: vi.fn(), sequence: 0 }));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../services/supabase', () => ({ getSupabaseClient: () => null }));
vi.mock('./EventDiscussionReader', () => ({ EventDiscussionReader: () => null }));
vi.mock('./ConnectedTaskEditor', () => ({ ConnectedTaskEditor: () => {
  const [value, onChangeText] = useState('');
  return h(TextInput, { accessibilityLabel: 'Task title', value, onChangeText });
} }));
vi.mock('./NativeMessageActions', () => ({ NativeMessageActions: () => null }));
vi.mock('./ReminderPicker', () => ({ ReminderPicker: ({ visible }: { visible: boolean }) => {
  const [value, onChangeText] = useState('');
  return visible ? h(TextInput, { accessibilityLabel: 'Reminder note', value, onChangeText }) : null;
} }));
vi.mock('../lib/connectedWorkflows', async (original) => {
  const actual = await original<ConnectedWorkflowModule>();
  return {
    ...actual,
    connectedWorkflowApi: () => ({ context: port.context, recipients: port.recipients, send: port.send, createTask: port.createTask, eventOrganizerCandidates: port.organizerCandidates }),
    newConnectedRequestId: () => `workflow-attempt-${++port.sequence}`,
  };
});
const session = { access_token: 'test-session-a', user: { id: 'member-a' } } as Session;
const initialApp = () => ({ mode: 'authenticated', session: session as Session | null, organizationID: 'org-a',
  dashboard: { member: { chapterID: 'chapter-a', language: 'en' } } as { member: { chapterID: string; language: string } } | null,
  chapterMemberships: [{ chapterID: 'chapter-a', selected: true }], authorizedRoles: [] as string[], chapterRoles: [] as string[], organizationRoles: [] as string[],
  resumeDraftReads: { dashboard: true, memberships: true, staff: true } as ResumeDraftReads });
let app = initialApp();
vi.mock('../state/AppProvider', () => ({ useApp: () => { syncResumeDraftContext(app); return app; } }));
import { WorkflowActions } from './WorkflowActions';

const context = () => ({ available: true, canMessage: true, canRemind: false, canCreateTask: false,
  reference: { kind: 'task', id: 'task-a' }, linkedTask: null, sourceLinks: [], organizer: null, canManageOrganizer: false, canContactOptIn: false });
const page = () => ({ status: 'available', items: [{ id: 'alex', label: 'Alex' }], nextCursor: null });
let screen: Rendered | null = null;
let sourceID = 'task-a';
let sourceKind: 'task' | 'event' = 'task';
const tree = () => h(WorkflowActions, { kind: sourceKind, id: sourceID, recordTitle: 'Review notes' });
const copy = () => connectedActionsCopy[app.dashboard?.member.language === 'es' ? 'es' : 'en'];

// #9959 (M1-8 of #9470): Send looked active and did nothing until a
// recipient and a message were in, and the 12-recipient limit was unstated.
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `person-${i + 1}`, label: `Fictional Person ${i + 1}` }));
async function openComposer() {
  screen = await render(tree());
  await press(getExposed(screen.container, `${sourceKind === 'event' ? copy().eventActions : copy().taskActions}: Review notes`));
  await press(getExposed(screen.container, 'Message…'));
}
const sendButton = () => getExposed(screen!.container, copy().send);
beforeEach(() => {
  syncResumeDraftContext({ mode: 'anonymous', session: null, organizationID: null });
  app = initialApp(); sourceID = 'task-a'; sourceKind = 'task'; port.sequence = 0;
  vi.clearAllMocks(); port.context.mockResolvedValue(context()); port.recipients.mockResolvedValue(page()); port.send.mockResolvedValue({});
});
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); });

describe.each<'en' | 'es'>(['en', 'es'])('message composer reasons in %s', (language) => {
  beforeEach(() => { app.dashboard!.member.language = language; });

  it('says why Send cannot send yet, and Send reports itself unavailable with that reason', async () => {
    await openComposer();
    const text = () => screen!.container.textContent ?? '';
    expect(text()).toContain(copy().sendNeedsRecipient);
    expect(sendButton().getAttribute('aria-disabled')).toBe('true');
    expect(sendButton().getAttribute('aria-description')).toBe(copy().sendNeedsRecipient);
    await press(getExposed(screen!.container, 'Alex'));
    expect(text()).not.toContain(copy().sendNeedsRecipient);
    expect(text()).toContain(copy().sendNeedsMessage);
    expect(sendButton().getAttribute('aria-description')).toBe(copy().sendNeedsMessage);
    expect(sendButton().getAttribute('aria-disabled')).toBe('true');
    await type(getExposed(screen!.container, copy().messageBody), 'Fictional update for the team.');
    expect(text()).not.toContain(copy().sendNeedsMessage);
    expect(sendButton().getAttribute('aria-disabled')).not.toBe('true');
    await press(sendButton());
    expect(port.send).toHaveBeenCalledTimes(1);
  });

  it('shows neither line nor a hint while an unknown send is held, and the retry sends the original once', async () => {
    port.send.mockRejectedValueOnce(new Error('Reply lost after dispatch'));
    await openComposer();
    await type(getExposed(screen!.container, copy().messageBody), 'Fictional update for the team.');
    await press(getExposed(screen!.container, 'Alex'));
    await press(sendButton());
    expect(port.send).toHaveBeenCalledTimes(1);
    const text = screen!.container.textContent ?? '';
    expect(text).not.toContain(copy().recipientLimit.replace('{max}', '12').replace('{count}', '1'));
    for (const reason of [copy().sendNeedsRecipient, copy().sendNeedsMessage]) expect(text).not.toContain(reason);
    expect(sendButton().getAttribute('aria-description')).toBeNull();
    await press(sendButton());
    expect(port.send).toHaveBeenCalledTimes(2);
    expect(port.send.mock.calls[1]?.[3]).toBe(port.send.mock.calls[0]?.[3]);
  });

  it('states the 12-recipient limit where people are picked, and says when it is reached', async () => {
    port.recipients.mockResolvedValue({ status: 'available', items: people(13), nextCursor: null });
    await openComposer();
    const text = () => screen!.container.textContent ?? '';
    const line = (count: number) => copy().recipientLimit.replace('{max}', '12').replace('{count}', String(count));
    expect(text()).toContain(line(0));
    for (let i = 1; i <= 12; i += 1) await press(getExposed(screen!.container, `Fictional Person ${i}`));
    expect(text()).toContain(copy().recipientLimitReached.replace('{max}', '12'));
    expect(getExposed(screen!.container, 'Fictional Person 13').getAttribute('aria-disabled')).toBe('true');
    await press(getExposed(screen!.container, 'Fictional Person 12'));
    expect(text()).toContain(line(11));
  });

  // #9963 gate round 1, r2g1: the at-limit line told the person to remove
  // someone while a send or a More recipients read had the rows disabled.
  it('hides the limit line while a send is in flight and while more recipients load', async () => {
    let finishSend!: (value: object) => void;
    port.send.mockImplementationOnce(() => new Promise((resolve) => { finishSend = resolve; }));
    let finishMore!: (value: unknown) => void;
    port.recipients.mockResolvedValueOnce({ status: 'available', items: people(12), nextCursor: 'page-2' })
      .mockImplementationOnce(() => new Promise((resolve) => { finishMore = resolve; }));
    await openComposer();
    const reached = copy().recipientLimitReached.replace('{max}', '12');
    const text = () => screen!.container.textContent ?? '';
    for (let i = 1; i <= 12; i += 1) await press(getExposed(screen!.container, `Fictional Person ${i}`));
    expect(text()).toContain(reached);
    await press(getExposed(screen!.container, copy().more));
    expect(text()).not.toContain(reached);
    await act(async () => { finishMore({ status: 'available', items: people(13).slice(12), nextCursor: null }); });
    expect(text()).toContain(reached);
    await type(getExposed(screen!.container, copy().messageBody), 'Fictional update for the team.');
    await press(sendButton());
    expect(port.send).toHaveBeenCalledTimes(1);
    expect(text()).not.toContain(reached);
    await act(async () => { finishSend({}); });
  });

  // #9963 gate round 1, r1s1: VoiceOver does not read accessibilityLiveRegion,
  // so on iOS each change of the two lines goes through the announcement queue,
  // once per change and never for the text the composer opened with.
  it('announces each change of the lines once on iOS, and never the text they open with', async () => {
    const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const ios = vi.spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions');
    const android = vi.spyOn(AccessibilityInfo, 'announceForAccessibility');
    setPlatform('ios');
    await openComposer();
    await flush();
    expect(ios).not.toHaveBeenCalled();
    await press(getExposed(screen!.container, 'Alex'));
    await flush();
    expect(ios).toHaveBeenCalledTimes(1);
    const spokenAt = (index: number) => String((ios.mock.calls as unknown[][])[index]?.[0]);
    const spoken = spokenAt(0);
    expect(spoken).toContain(copy().recipientLimit.replace('{max}', '12').replace('{count}', '1'));
    expect(spoken).toContain(copy().sendNeedsMessage);
    await flush();
    expect(ios).toHaveBeenCalledTimes(1);
    // Typing removes the reason (nothing spoken); clearing the message brings
    // it back, which is a change and is spoken once.
    await type(getExposed(screen!.container, copy().messageBody), 'Fictional update.');
    await flush();
    expect(ios).toHaveBeenCalledTimes(1);
    await type(getExposed(screen!.container, copy().messageBody), '');
    await flush();
    expect(ios).toHaveBeenCalledTimes(2);
    expect(spokenAt(1)).toBe(copy().sendNeedsMessage);
    expect(android).not.toHaveBeenCalled();
    ios.mockRestore(); android.mockRestore();
  });

  it('leaves Android to its live regions and queues nothing there', async () => {
    const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const ios = vi.spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions');
    const android = vi.spyOn(AccessibilityInfo, 'announceForAccessibility');
    setPlatform('android');
    await openComposer();
    await press(getExposed(screen!.container, 'Alex'));
    await flush();
    expect(ios).not.toHaveBeenCalled();
    expect(android).not.toHaveBeenCalled();
    expect(screen!.container.textContent).toContain(copy().sendNeedsMessage);
    ios.mockRestore(); android.mockRestore();
  });
});
