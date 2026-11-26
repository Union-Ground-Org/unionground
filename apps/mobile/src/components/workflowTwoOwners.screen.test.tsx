// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import { exposedElements, getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import { syncResumeDraftContext, type ResumeDraftReads } from '../lib/resumeDraftHolder';
import { connectedActionsCopy } from '../lib/connectedWorkflowsCopy';
import palette from '../theme/palette.json';

// Two mounted owners of one task's held message share its
// keys. Opening a task from the Tasks list pushes the task's own view
// (/feature/tasks?source=<id>, src/lib/connectedWorkflowRoutes.ts) over the
// list, so the list's card and the task's card both mount WorkflowActions for
// the same task. When one owner's send succeeds (or its Discard retires an
// unknown send), the other owner must not keep the old body and send it again
// as a new first send.

type ConnectedWorkflowModule = typeof import('../lib/connectedWorkflows');

const port = vi.hoisted(() => ({ context: vi.fn(), recipients: vi.fn(), send: vi.fn(), createTask: vi.fn(), organizerCandidates: vi.fn(), sequence: 0 }));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../services/supabase', () => ({ getSupabaseClient: () => null }));
vi.mock('./EventDiscussionReader', () => ({ EventDiscussionReader: () => null }));
vi.mock('./ConnectedTaskEditor', () => ({ ConnectedTaskEditor: () => null }));
vi.mock('./NativeMessageActions', () => ({ NativeMessageActions: () => null }));
vi.mock('./ReminderPicker', () => ({ ReminderPicker: () => null }));
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
const { WorkflowActions } = await import('./WorkflowActions');

const copy = connectedActionsCopy.en;
let kind: 'task' | 'event' = 'task';
const context = () => ({ available: true, canMessage: true, canRemind: false, canCreateTask: false,
  reference: { kind, id: `${kind}-a` }, linkedTask: null, sourceLinks: [], organizer: null, canManageOrganizer: false, canContactOptIn: false });
const page = () => ({ status: 'available', items: [{ id: 'alex', label: 'Alex' }], nextCursor: null });
const TYPED = 'Can you bring the sign-in sheet? / ¿la hoja?';

// The Tasks list's card, and then the task's own card pushed over it: both
// stay mounted, as on the stack.
// Events work the same way (/feature/events?source=<id>).
const tree = (pushed = true) => h('div', null,
  h('div', { 'data-owner': 'list' }, h(WorkflowActions, { kind, id: `${kind}-a`, recordTitle: 'Review notes' })),
  pushed ? h('div', { 'data-owner': 'task' }, h(WorkflowActions, { kind, id: `${kind}-a`, recordTitle: 'Review notes' })) : null);
let screen: Rendered | null = null;
const owner = (name: 'list' | 'task') => screen!.container.querySelector<HTMLElement>(`[data-owner="${name}"]`)!;
// A control by the name a screen reader announces, or null.
const named = (name: 'list' | 'task', label: string) => exposedElements(owner(name)).find((element) => (element.getAttribute('aria-label') ?? element.textContent ?? '').trim() === label) ?? null;
const body = (name: 'list' | 'task') => owner(name).querySelector<HTMLTextAreaElement>(`[aria-label="${copy.messageBody}"]`);
async function settle() { for (let round = 0; round < 12; round += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

// The person writes on the list's card, then opens the task: the task's card
// opens on the held message and restores it.
async function bothComposing() {
  screen = await render(tree(false));
  await press(getExposed(owner('list'), `${kind === 'event' ? copy.eventActions : copy.taskActions}: Review notes`)); await settle();
  await press(getExposed(owner('list'), 'Message…')); await settle();
  await type(getExposed(owner('list'), copy.messageBody), TYPED);
  await press(getExposed(owner('list'), 'Alex')); await settle();
  await screen.rerender(tree()); await settle();
  expect(body('list')?.value).toBe(TYPED);
  expect(body('task')?.value).toBe(TYPED);
}

beforeEach(() => {
  syncResumeDraftContext({ mode: 'anonymous', session: null, organizationID: null });
  app = initialApp(); port.sequence = 0; kind = 'task';
  vi.clearAllMocks(); port.context.mockResolvedValue(context()); port.recipients.mockResolvedValue(page()); port.send.mockResolvedValue({});
});
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); });

describe.each<'ios' | 'android'>(['ios', 'android'])('two mounted owners of one held message on %s', (platform) => {
  beforeEach(() => setPlatform(platform));

  it('clears the other owner\'s copy once one owner\'s send succeeds, so it cannot be sent again', async () => {
    await bothComposing();
    await press(getExposed(owner('task'), copy.send)); await settle();
    expect(port.send).toHaveBeenCalledTimes(1);
    expect(body('task')).toBeNull();
    // The list's card sends nothing again (on Main its Send sent the old body
    // as a new first send), and no longer holds the sent text.
    const send = named('list', copy.send);
    if (send) { await press(send); await settle(); }
    expect(port.send).toHaveBeenCalledTimes(1);
    expect(body('list')?.value ?? '').toBe('');
  });

  it('clears the other owner\'s copy once one owner discards an unconfirmed send', async () => {
    await bothComposing();
    port.send.mockRejectedValueOnce(new TypeError('Network request failed'));
    await press(getExposed(owner('task'), copy.send)); await settle();
    expect(port.send).toHaveBeenCalledTimes(1);
    await press(getExposed(owner('task'), copy.discard)); await settle();
    const send = named('list', copy.send);
    if (send) { await press(send); await settle(); }
    expect(port.send).toHaveBeenCalledTimes(1);
    expect(body('list')?.value ?? '').toBe('');
  });

  it('clears the other meeting card\'s copy once one meeting card\'s send succeeds', async () => {
    kind = 'event';
    await bothComposing();
    await press(getExposed(owner('task'), copy.send)); await settle();
    const send = named('list', copy.send);
    if (send) { await press(send); await settle(); }
    expect(port.send).toHaveBeenCalledTimes(1);
    expect(body('list')?.value ?? '').toBe('');
  });

  // The read R-612 (F1): the other card ticks a person on a later recipient
  // page. The following card reads the pages that person is on before it can
  // send, so the message goes to exactly the people ticked, once, and is never
  // discarded for a person it had not loaded.
  it.each([['only the later-page person', ['blair']], ['both people', ['alex', 'blair']]])('sends once to %s ticked in the other card', async (_label, expected) => {
    port.recipients.mockImplementation(async (_reference: unknown, cursor?: string | null) => (cursor === 'page-2'
      ? { status: 'available', items: [{ id: 'blair', label: 'Blair' }], nextCursor: null }
      : { status: 'available', items: [{ id: 'alex', label: 'Alex' }], nextCursor: 'page-2' }));
    await bothComposing();
    await press(getExposed(owner('task'), copy.more)); await settle();
    await press(getExposed(owner('task'), 'Blair')); await settle();
    if (expected.length === 1) { await press(getExposed(owner('task'), 'Alex')); await settle(); }
    await press(getExposed(owner('list'), copy.send)); await settle();
    expect(port.send).toHaveBeenCalledTimes(1);
    const [, ids, text] = port.send.mock.calls[0] as [unknown, string[], string];
    expect([...ids].sort()).toEqual(expected);
    expect(text).toBe(TYPED);
    expect(owner('list').textContent).not.toContain(copy.unavailable);
  });

  // Gate round 1 (stage 494): the second card's Cancel lands while the first
  // card's follow-triggered recipient restore is still reading. Cancel keeps
  // the held draft (only a send or a Discard clears the other card), so the
  // first card finishes reading the ticked people's pages and its Send sends
  // once to exactly them; the cancelling card's own composer stays closed.
  it('still sends once from the first card when the second card cancels during its recipient restore', async () => {
    const pageFor = (cursor?: string | null) => (cursor === 'page-2'
      ? { status: 'available', items: [{ id: 'blair', label: 'Blair' }], nextCursor: null }
      : { status: 'available', items: [{ id: 'alex', label: 'Alex' }], nextCursor: 'page-2' });
    port.recipients.mockImplementation(async (_reference: unknown, cursor?: string | null) => pageFor(cursor));
    await bothComposing();
    await press(getExposed(owner('task'), copy.more)); await settle();
    // Hold every further recipient read until released, so the list card's
    // follow-triggered restore is still in flight when Cancel is pressed.
    const gate = { release: () => {} };
    const readsHeld = new Promise<void>((resolve) => { gate.release = resolve; });
    port.recipients.mockImplementation(async (_reference: unknown, cursor?: string | null) => { await readsHeld; return pageFor(cursor); });
    await press(getExposed(owner('task'), 'Blair')); await settle();
    // The composer footer's Cancel (the scrim shares the announced name).
    const cancel = exposedElements(owner('task')).find((element) => (element.textContent ?? '').trim() === copy.cancel);
    expect(cancel).toBeTruthy();
    await press(cancel!); await settle();
    gate.release();
    port.recipients.mockImplementation(async (_reference: unknown, cursor?: string | null) => pageFor(cursor));
    await settle();
    expect(body('task')).toBeNull();
    expect(body('list')?.value).toBe(TYPED);
    await press(getExposed(owner('list'), copy.send)); await settle();
    expect(port.send).toHaveBeenCalledTimes(1);
    const [, ids, text] = port.send.mock.calls[0] as [unknown, string[], string];
    expect([...ids].sort()).toEqual(['alex', 'blair']);
    expect(text).toBe(TYPED);
    expect(owner('list').textContent).not.toContain(copy.unavailable);
  });

  it('keeps the other owner following the held message while it is written', async () => {
    await bothComposing();
    await type(getExposed(owner('task'), copy.messageBody), `${TYPED} more`);
    await settle();
    expect(body('list')?.value).toBe(`${TYPED} more`);
  });

  it('keeps the shared message through a read refresh (the holder conceals, it does not retire)', async () => {
    await bothComposing();
    app = { ...initialApp(), resumeDraftReads: { dashboard: false, memberships: false, staff: false } };
    await screen!.rerender(tree()); await settle();
    app = initialApp();
    await screen!.rerender(tree()); await settle();
    expect(body('list')?.value).toBe(TYPED);
    expect(port.send).not.toHaveBeenCalled();
  });
});
