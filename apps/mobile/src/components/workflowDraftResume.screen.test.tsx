// @vitest-environment jsdom
import { act, createElement as h, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import { getExposed, press, render, setPlatform, type, type Rendered, TextInput } from '../testing/reactNativeStandIn';
import { readResumeDraft, resumeDraftKey, syncResumeDraftContext, type ResumeDraftReads } from '../lib/resumeDraftHolder';
import { connectedActionsCopy, connectedContactCopy } from '../lib/connectedWorkflowsCopy';
import palette from '../theme/palette.json';
import { READ_DEADLINE_MS } from '../lib/readDeadline';

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
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const copy = () => connectedActionsCopy[app.dashboard?.member.language === 'es' ? 'es' : 'en'];
async function draft() {
  screen = await render(tree());
  await press(getExposed(screen.container, `${sourceKind === 'event' ? copy().eventActions : copy().taskActions}: Review notes`));
  await press(getExposed(screen.container, 'Message…'));
  await type(getExposed(screen.container, copy().messageBody), '  Exact unfinished work / borrador\n  ');
  await press(getExposed(screen.container, 'Alex'));
}
async function boot() {
  app = { ...app, mode: 'booting', dashboard: null, chapterMemberships: [], authorizedRoles: [], resumeDraftReads: { dashboard: false, memberships: false, staff: false } };
  await screen!.rerender(tree());
  expect(screen!.container.textContent).toBe('');
  expect(screen!.container.querySelector('input,textarea,button')).toBeNull();
}
async function restore(language = 'en') {
  app = initialApp(); app.dashboard!.member.language = language;
  await screen!.rerender(tree());
}
beforeEach(() => {
  syncResumeDraftContext({ mode: 'anonymous', session: null, organizationID: null });
  app = initialApp(); sourceID = 'task-a'; sourceKind = 'task'; port.sequence = 0;
  vi.clearAllMocks(); port.context.mockResolvedValue(context()); port.recipients.mockResolvedValue(page()); port.send.mockResolvedValue({});
});
afterEach(async () => { await screen?.unmount(); screen = null; vi.useRealTimers(); setPlatform('ios'); });

describe.each<'ios' | 'android'>(['ios', 'android'])('connected composer resume on %s', (platform) => {
  beforeEach(() => setPlatform(platform));
  it.each<'en' | 'es'>(['en', 'es'])('restores text, compose mode and recipients after fresh source and recipient access in %s', async (language) => {
    app.dashboard!.member.language = language;
    await draft(); await boot();
    const read = deferred<ReturnType<typeof context>>(); port.context.mockReturnValue(read.promise);
    await restore(language);
    expect(screen!.container.querySelector('textarea')).toBeNull();
    await act(async () => read.resolve(context()));
    expect((getExposed(screen!.container, copy().messageBody) as HTMLTextAreaElement).value).toBe('  Exact unfinished work / borrador\n  ');
    expect(getExposed(screen!.container, 'Alex').getAttribute('aria-checked')).toBe('true');
    expect(port.send).not.toHaveBeenCalled();
  });
  it.each(['account', 'organization', 'chapter', 'roles', 'item', 'signout'])('retires work after %s changes', async (change) => {
    await draft(); await boot();
    app = initialApp();
    if (change === 'account') app.session = { ...session, user: { ...session.user, id: 'member-b' } };
    if (change === 'organization') app.organizationID = 'org-b';
    if (change === 'chapter') { app.dashboard!.member.chapterID = 'chapter-b'; app.chapterMemberships[0]!.chapterID = 'chapter-b'; }
    if (change === 'roles') app.authorizedRoles = ['steward'];
    if (change === 'item') sourceID = 'task-b';
    if (change === 'signout') { app.mode = 'anonymous'; app.session = null; }
    await screen!.rerender(tree());
    expect(screen!.container.querySelector('textarea')).toBeNull();
    expect(port.send).not.toHaveBeenCalled();
  });
  it.each(['missing', 'denied', 'recipient'])('retires work permanently after fresh %s refusal', async (failure) => {
    await draft(); await boot();
    if (failure === 'missing') port.context.mockResolvedValue({ ...context(), available: false });
    if (failure === 'denied') port.context.mockRejectedValue({ code: '42501' });
    if (failure === 'recipient') port.recipients.mockResolvedValue({ ...page(), items: [] });
    await restore();
    expect(screen!.container.querySelector('textarea')).toBeNull();
    port.context.mockResolvedValue(context()); port.recipients.mockResolvedValue(page());
    await screen!.unmount(); screen = await render(tree());
    expect(screen.container.querySelector('textarea')).toBeNull();
    expect(port.send).not.toHaveBeenCalled();
  });
  it('keeps pending sends busy through remount and consumes the accepted attempt', async () => {
    const sending = deferred<object>(); port.send.mockReturnValue(sending.promise);
    await draft(); await press(getExposed(screen!.container, copy().send));
    expect(port.send).toHaveBeenCalledTimes(1);
    await boot(); await restore();
    expect(getExposed(screen!.container, copy().send).getAttribute('aria-disabled')).toBe('true');
    await press(getExposed(screen!.container, copy().send));
    expect(port.send).toHaveBeenCalledTimes(1);
    await act(async () => sending.resolve({}));
    expect(screen!.container.querySelector('textarea')).toBeNull();
    expect(port.send).toHaveBeenCalledTimes(1);
  });
  it('keeps work concealed on a temporary read failure and restores it on explicit retry', async () => {
    await draft(); await boot(); port.context.mockRejectedValueOnce(new Error('offline'));
    await restore();
    expect(screen!.container.querySelector('textarea')).toBeNull();
    await press(getExposed(screen!.container, copy().retry));
    expect((getExposed(screen!.container, copy().messageBody) as HTMLTextAreaElement).value).toContain('Exact unfinished work');
    expect(port.send).not.toHaveBeenCalled();
  });
  it('checks later recipient pages before restoring a retained selection', async () => {
    await draft(); await boot();
    port.recipients.mockResolvedValueOnce({ ...page(), items: [{ id: 'other', label: 'Other' }], nextCursor: 'page-2' });
    await restore();
    expect(port.recipients).toHaveBeenLastCalledWith(expect.any(Object), 'page-2');
    expect(getExposed(screen!.container, 'Alex').getAttribute('aria-checked')).toBe('true');
  });
  it('does not dispatch a preflight that finishes after leaving the app', async () => {
    await draft(); const check = deferred<ReturnType<typeof context>>(); port.context.mockReturnValueOnce(check.promise);
    await press(getExposed(screen!.container, copy().send)); await boot();
    await act(async () => check.resolve(context()));
    await restore();
    expect((getExposed(screen!.container, copy().messageBody) as HTMLTextAreaElement).value).toContain('Exact unfinished work');
    expect(port.send).not.toHaveBeenCalled();
  });
  it('keeps a failed pending send for explicit retry with its original request id', async () => {
    const sending = deferred<object>(); port.send.mockReturnValueOnce(sending.promise);
    await draft(); await press(getExposed(screen!.container, copy().send)); await boot();
    // Resolve the transport with a rejecting promise, as an offline response.
    await act(async () => sending.resolve(Promise.reject(new Error('offline'))));
    await restore();
    expect(screen!.container.textContent).toContain(copy().failed);
    expect(port.send).toHaveBeenCalledTimes(1);
    await press(getExposed(screen!.container, copy().send));
    expect(port.send).toHaveBeenCalledTimes(2);
    expect(port.send.mock.calls[1]?.[3]).toBe(port.send.mock.calls[0]?.[3]);
  });
  it('cannot resurrect a refused pending send when the old screen is gone', async () => {
    const sending = deferred<object>(); port.send.mockReturnValueOnce(sending.promise);
    await draft(); await press(getExposed(screen!.container, copy().send)); await boot();
    await act(async () => sending.resolve(Promise.reject({ code: 'recipient_unavailable' })));
    await restore();
    expect(screen!.container.querySelector('textarea')).toBeNull();
    expect(port.send).toHaveBeenCalledTimes(1);
  });
  it.each(['chapter', 'organization'])('drops local composition when only the %s grant changes without boot', async (grant) => {
    await draft();
    if (grant === 'chapter') app.chapterRoles = ['steward'];
    else app.organizationRoles = ['steward'];
    await screen!.rerender(tree());
    expect(screen!.container.querySelector('textarea')).toBeNull();
    expect(port.send).not.toHaveBeenCalled();
  });
  it('conceals local composition on a bearer refresh until its fresh read finishes', async () => {
    await draft();
    const read = deferred<ReturnType<typeof context>>(); port.context.mockReturnValueOnce(read.promise);
    app.session = { ...session, access_token: 'test-refreshed-a' };
    await screen!.rerender(tree());
    expect(screen!.container.querySelector('textarea')).toBeNull();
    await act(async () => read.resolve(context()));
    expect((getExposed(screen!.container, copy().messageBody) as HTMLTextAreaElement).value).toContain('Exact unfinished work');
    expect(port.send).not.toHaveBeenCalled();
  });
  it.each(['recipient missing', 'page unavailable', 'canMessage false', 'read refused'])('keeps an unknown dispatched attempt through %s and later reuses its id', async (projection) => {
    port.send.mockRejectedValueOnce(new Error('Reply lost'));
    await draft(); await press(getExposed(screen!.container, copy().send));
    const firstID: unknown = port.send.mock.calls[0]?.[3];
    await boot();
    if (projection === 'recipient missing') port.recipients.mockResolvedValueOnce({ ...page(), items: [] });
    if (projection === 'page unavailable') port.recipients.mockResolvedValueOnce({ ...page(), status: 'unavailable' });
    if (projection === 'canMessage false') port.context.mockResolvedValueOnce({ ...context(), canMessage: false });
    if (projection === 'read refused') port.context.mockRejectedValueOnce({ code: '42501' });
    await restore();
    expect(screen!.container.querySelector('textarea')).toBeNull();
    expect(readResumeDraft(resumeDraftKey(app, 'workflow', 'task:task-a'))?.value.attempt?.id).toBe(firstID);
    expect(port.send).toHaveBeenCalledTimes(1);
    await press(getExposed(screen!.container, copy().retry));
    await press(getExposed(screen!.container, copy().send));
    expect(port.send).toHaveBeenCalledTimes(2);
    expect(port.send.mock.calls[1]?.[3]).toBe(firstID);
    expect(port.send.mock.calls[1]?.slice(0, 3)).toEqual(port.send.mock.calls[0]?.slice(0, 3));
  });
  it.each([{ code: '42501' }, { status: 403 }])('keeps the earlier unknown send after a refused retry: %j', async (refusal) => {
    port.send.mockRejectedValueOnce(new Error('Reply lost')).mockRejectedValueOnce(refusal);
    await draft(); await press(getExposed(screen!.container, copy().send));
    const firstID: unknown = port.send.mock.calls[0]?.[3];
    await press(getExposed(screen!.container, copy().send));
    expect(readResumeDraft(resumeDraftKey(app, 'workflow', 'task:task-a'))?.value.attempt?.id).toBe(firstID);
    await boot(); await restore();
    await press(getExposed(screen!.container, copy().send));
    expect(port.send).toHaveBeenCalledTimes(3);
    expect(port.send.mock.calls[2]?.[3]).toBe(firstID);
  });
  it.each<'en' | 'es'>(['en', 'es'])('lets the owner discard a settled unknown send after Cancel in %s', async (language) => {
    app.dashboard!.member.language = language;
    port.context.mockResolvedValue({ ...context(), canRemind: true });
    port.send.mockRejectedValueOnce(new Error('Reply lost after dispatch'));
    await draft(); await press(getExposed(screen!.container, copy().send));
    await press(getExposed(screen!.container, copy().cancel));
    expect(readResumeDraft(resumeDraftKey(app, 'workflow', 'task:task-a'))?.value.attempt).toBeTruthy();
    await press(getExposed(screen!.container, `${copy().taskActions}: Review notes`));
    const discard = language === 'es' ? 'Descartar' : 'Discard';
    await press(getExposed(screen!.container, discard));
    expect(readResumeDraft(resumeDraftKey(app, 'workflow', 'task:task-a'))).toBeNull();
    expect(readResumeDraft(resumeDraftKey(app, 'workflowSend', 'task:task-a'))).toBeNull();
    expect(port.send).toHaveBeenCalledTimes(1);
    await press(getExposed(screen!.container, `${copy().taskActions}: Review notes`));
    await press(getExposed(screen!.container, 'Remind me…'));
    getExposed(screen!.container, 'Reminder note');
  });
  it.each<'en' | 'es'>(['en', 'es'])('keeps Discard reachable when a removed recipient conceals the unknown attempt in %s', async (language) => {
    app.dashboard!.member.language = language;
    port.send.mockRejectedValueOnce(new Error('Reply lost after dispatch'));
    await draft(); await press(getExposed(screen!.container, copy().send)); await boot();
    port.recipients.mockResolvedValue({ ...page(), items: [] });
    await restore(language);
    expect(screen!.container.querySelector('textarea')).toBeNull();
    expect(readResumeDraft(resumeDraftKey(app, 'workflow', 'task:task-a'))?.value.attempt).toBeTruthy();
    await press(getExposed(screen!.container, language === 'es' ? 'Descartar' : 'Discard'));
    expect(readResumeDraft(resumeDraftKey(app, 'workflow', 'task:task-a'))).toBeNull();
    expect(readResumeDraft(resumeDraftKey(app, 'workflowSend', 'task:task-a'))).toBeNull();
    expect(port.send).toHaveBeenCalledTimes(1);
    port.recipients.mockResolvedValue(page());
    await press(getExposed(screen!.container, `${copy().taskActions}: Review notes`));
    await press(getExposed(screen!.container, 'Message…'));
    expect((getExposed(screen!.container, copy().messageBody) as HTMLTextAreaElement).value).toBe('');
  });
  it('does not offer Discard while the original dispatch is still pending', async () => {
    const sending = deferred<object>(); port.send.mockReturnValueOnce(sending.promise);
    await draft(); await press(getExposed(screen!.container, copy().send));
    expect(screen!.container.textContent).not.toContain('Discard');
    await boot(); await restore();
    expect(screen!.container.textContent).not.toContain('Discard');
    await act(async () => sending.resolve({}));
  });
  it('exposes Discard when a pending dispatch fails while recipient access conceals it', async () => {
    const sending = deferred<object>(); port.send.mockReturnValueOnce(sending.promise);
    await draft(); await press(getExposed(screen!.container, copy().send)); await boot();
    port.recipients.mockResolvedValue({ ...page(), items: [] });
    await restore();
    expect(screen!.container.querySelector('textarea')).toBeNull();
    expect(screen!.container.textContent).not.toContain('Discard');
    await act(async () => sending.resolve(Promise.reject(new Error('Reply lost after dispatch'))));
    await press(getExposed(screen!.container, 'Discard'));
    expect(readResumeDraft(resumeDraftKey(app, 'workflow', 'task:task-a'))).toBeNull();
    expect(readResumeDraft(resumeDraftKey(app, 'workflowSend', 'task:task-a'))).toBeNull();
    expect(port.send).toHaveBeenCalledTimes(1);
  });
  async function unknownSend() {
    port.send.mockRejectedValueOnce(new Error('Reply lost after dispatch'));
    await draft(); await press(getExposed(screen!.container, copy().send));
  }
  function pendingRestoration(read: 'context' | 'first recipient' | 'later recipient') {
    const source = deferred<ReturnType<typeof context>>();
    const people = deferred<ReturnType<typeof page>>();
    if (read === 'context') port.context.mockReturnValueOnce(source.promise);
    else {
      if (read === 'later recipient') port.recipients.mockResolvedValueOnce({ ...page(), items: [{ id: 'other', label: 'Other' }], nextCursor: 'page-2' });
      port.recipients.mockReturnValueOnce(people.promise);
    }
    return () => { source.resolve(context()); people.resolve(page()); };
  }
  it.each<'context' | 'first recipient' | 'later recipient'>(['context', 'first recipient', 'later recipient'])('discards immediately during a pending %s read and ignores its late answer', async (read) => {
    await unknownSend(); await boot();
    const finish = pendingRestoration(read);
    await restore();
    expect(screen!.container.querySelector('textarea')).toBeNull();
    expect(getExposed(screen!.container, 'Discard').getAttribute('aria-disabled')).not.toBe('true');
    await press(getExposed(screen!.container, 'Discard'));
    expect(readResumeDraft(resumeDraftKey(app, 'workflow', 'task:task-a'))).toBeNull();
    expect(readResumeDraft(resumeDraftKey(app, 'workflowSend', 'task:task-a'))).toBeNull();
    await press(getExposed(screen!.container, `${copy().taskActions}: Review notes`));
    await press(getExposed(screen!.container, 'Message…'));
    await type(getExposed(screen!.container, copy().messageBody), 'Replacement after Discard');
    await act(async () => finish());
    expect((getExposed(screen!.container, copy().messageBody) as HTMLTextAreaElement).value).toBe('Replacement after Discard');
    expect(port.send).toHaveBeenCalledTimes(1);
  });
  it.each<'context' | 'first recipient' | 'later recipient'>(['context', 'first recipient', 'later recipient'])('ends a stalled %s read at the existing deadline without losing the unknown attempt', async (read) => {
    await unknownSend(); await boot();
    vi.useFakeTimers();
    const finish = pendingRestoration(read);
    await restore();
    await act(async () => { await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS - 1); });
    expect(screen!.container.textContent).not.toContain(copy().failed);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen!.container.textContent).toContain(copy().failed);
    expect(getExposed(screen!.container, copy().retry).getAttribute('aria-disabled')).not.toBe('true');
    expect(readResumeDraft(resumeDraftKey(app, 'workflow', 'task:task-a'))?.value.attempt).toBeTruthy();
    await act(async () => finish());
    expect(screen!.container.querySelector('textarea')).toBeNull();
    await press(getExposed(screen!.container, 'Discard'));
    expect(readResumeDraft(resumeDraftKey(app, 'workflow', 'task:task-a'))).toBeNull();
    expect(port.send).toHaveBeenCalledTimes(1);
  });
  it.each(['read refused', 'source missing', 'recipient gone', 'page unavailable', 'canMessage false'])('discards a concealed unknown attempt after %s without waiting for recovery', async (state) => {
    await unknownSend(); await boot();
    if (state === 'read refused') port.context.mockRejectedValueOnce({ code: '42501' });
    if (state === 'source missing') port.context.mockResolvedValueOnce({ ...context(), available: false });
    if (state === 'canMessage false') port.context.mockResolvedValueOnce({ ...context(), canMessage: false });
    if (state === 'recipient gone') port.recipients.mockResolvedValueOnce({ ...page(), items: [] });
    if (state === 'page unavailable') port.recipients.mockResolvedValueOnce({ ...page(), status: 'unavailable' });
    await restore();
    expect(screen!.container.querySelector('textarea')).toBeNull();
    await press(getExposed(screen!.container, 'Discard'));
    expect(readResumeDraft(resumeDraftKey(app, 'workflow', 'task:task-a'))).toBeNull();
    expect(readResumeDraft(resumeDraftKey(app, 'workflowSend', 'task:task-a'))).toBeNull();
    expect(port.send).toHaveBeenCalledTimes(1);
  });
  it.each(['Close', 'Cancel'])('keeps the unknown attempt on %s and allows Discard during the reopened access read', async (button) => {
    await unknownSend();
    await press(getExposed(screen!.container, button));
    expect(readResumeDraft(resumeDraftKey(app, 'workflow', 'task:task-a'))?.value.attempt).toBeTruthy();
    const finish = pendingRestoration('context');
    await press(getExposed(screen!.container, `${copy().taskActions}: Review notes`));
    await press(getExposed(screen!.container, 'Discard'));
    await act(async () => finish());
    expect(readResumeDraft(resumeDraftKey(app, 'workflow', 'task:task-a'))).toBeNull();
    expect(port.send).toHaveBeenCalledTimes(1);
  });
  it('allows Discard during a token-change access read', async () => {
    await unknownSend(); const finish = pendingRestoration('context');
    app.session = { ...session, access_token: 'changed-during-unknown-attempt' };
    await screen!.rerender(tree());
    expect(screen!.container.querySelector('textarea')).toBeNull();
    await press(getExposed(screen!.container, 'Discard'));
    await act(async () => finish());
    expect(readResumeDraft(resumeDraftKey(app, 'workflow', 'task:task-a'))).toBeNull();
    expect(port.send).toHaveBeenCalledTimes(1);
  });
  it('allows Discard during retry preflight because no second dispatch is pending', async () => {
    await unknownSend(); const finish = pendingRestoration('context');
    await press(getExposed(screen!.container, copy().send));
    expect(port.send).toHaveBeenCalledTimes(1);
    // Resolve in the same event, before relying on the sheet's unmount cleanup.
    await act(async () => { getExposed(screen!.container, 'Discard').click(); finish(); });
    expect(readResumeDraft(resumeDraftKey(app, 'workflow', 'task:task-a'))).toBeNull();
    expect(readResumeDraft(resumeDraftKey(app, 'workflowSend', 'task:task-a'))).toBeNull();
    expect(port.send).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('keeps a recipient More read from blocking Discard (waitForDeadline=%s)', async (waitForDeadline) => {
    port.recipients.mockResolvedValueOnce({ ...page(), nextCursor: 'page-2' });
    await unknownSend();
    const people = deferred<ReturnType<typeof page>>(); port.recipients.mockReturnValueOnce(people.promise);
    if (waitForDeadline) vi.useFakeTimers();
    await press(getExposed(screen!.container, copy().more));
    expect(getExposed(screen!.container, 'Discard').getAttribute('aria-disabled')).not.toBe('true');
    if (waitForDeadline) {
      await act(async () => { await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS); });
      expect(screen!.container.textContent).toContain(copy().failed);
    }
    await press(getExposed(screen!.container, 'Discard'));
    await act(async () => people.resolve(page()));
    expect(readResumeDraft(resumeDraftKey(app, 'workflow', 'task:task-a'))).toBeNull();
    expect(port.send).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])('settles a real pending dispatch while restoration is still pending (accepted=%s)', async (accepted) => {
    const sending = deferred<object>(); port.send.mockReturnValueOnce(sending.promise);
    await draft(); await press(getExposed(screen!.container, copy().send)); await boot();
    const finish = pendingRestoration('context');
    await restore();
    expect(screen!.container.textContent).not.toContain('Discard');
    await act(async () => sending.resolve(accepted ? {} : Promise.reject(new Error('Reply lost'))));
    if (accepted) expect(readResumeDraft(resumeDraftKey(app, 'workflow', 'task:task-a'))).toBeNull();
    else await press(getExposed(screen!.container, 'Discard'));
    await act(async () => finish());
    expect(readResumeDraft(resumeDraftKey(app, 'workflow', 'task:task-a'))).toBeNull();
    expect(port.send).toHaveBeenCalledTimes(1);
  });
  it('does not let another record read block Discard of an unknown meeting message', async () => {
    sourceKind = 'event'; app.authorizedRoles = ['admin']; app.chapterRoles = ['admin'];
    port.context.mockResolvedValue({ ...context(), reference: { kind: 'event', id: sourceID }, canManageOrganizer: true });
    await unknownSend();
    const people = deferred<ReturnType<typeof page>>(); port.organizerCandidates.mockReturnValueOnce(people.promise);
    await press(getExposed(screen!.container, connectedContactCopy.en.edit));
    await press(getExposed(screen!.container, 'Discard'));
    await act(async () => people.resolve(page()));
    expect(readResumeDraft(resumeDraftKey(app, 'workflow', 'event:task-a'))).toBeNull();
    expect(readResumeDraft(resumeDraftKey(app, 'workflowSend', 'event:task-a'))).toBeNull();
    expect(screen!.container.textContent).not.toContain(connectedContactCopy.en.save);
    expect(port.send).toHaveBeenCalledTimes(1);
  });
  it.each(['reminder', 'task'])('preserves the nested %s owner through bearer refresh', async (editor) => {
    app.authorizedRoles = ['admin']; app.chapterRoles = ['admin'];
    port.context.mockResolvedValue({ ...context(), canRemind: true, canCreateTask: true });
    port.createTask.mockResolvedValue({ task: { id: 'linked-a' }, created: true });
    screen = await render(tree());
    await press(getExposed(screen.container, `${copy().taskActions}: Review notes`));
    await press(getExposed(screen.container, editor === 'reminder' ? 'Remind me…' : 'Create follow-up task'));
    const label = editor === 'reminder' ? 'Reminder note' : 'Task title';
    await type(getExposed(screen.container, label), 'Keep nested unfinished input');
    app.session = { ...session, access_token: 'refreshed-nested-a' };
    await screen.rerender(tree());
    expect((getExposed(screen.container, label) as HTMLInputElement).value).toBe('Keep nested unfinished input');
  });
  it.each([true, false])('cannot settle into replacement-account work (accepted=%s)', async (accepted) => {
    const sending = deferred<object>(); port.send.mockReturnValueOnce(sending.promise);
    await draft(); await press(getExposed(screen!.container, copy().send)); await boot();
    app = initialApp(); app.session = { ...session, user: { ...session.user, id: 'member-b' } };
    await screen!.rerender(tree());
    await press(getExposed(screen!.container, `${copy().taskActions}: Review notes`));
    await press(getExposed(screen!.container, 'Message…'));
    await type(getExposed(screen!.container, copy().messageBody), 'Replacement account draft');
    await act(async () => sending.resolve(accepted ? {} : Promise.reject(new Error('Reply lost'))));
    expect((getExposed(screen!.container, copy().messageBody) as HTMLTextAreaElement).value).toBe('Replacement account draft');
    expect(port.send).toHaveBeenCalledTimes(1);
  });
});
