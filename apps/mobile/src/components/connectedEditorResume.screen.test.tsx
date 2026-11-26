// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import { createRequire } from 'node:module';
import { getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import { syncResumeDraftContext, type ResumeDraftReads } from '../lib/resumeDraftHolder';
import { connectedActionsCopy, connectedContactCopy } from '../lib/connectedWorkflowsCopy';
import { READ_DEADLINE_MS } from '../lib/readDeadline';
import palette from '../theme/palette.json';
type WorkflowModule = typeof import('../lib/connectedWorkflows');
const port = vi.hoisted(() => ({ context: vi.fn(), candidates: vi.fn(), remind: vi.fn(), organizer: vi.fn(), contact: vi.fn(), recipients: vi.fn(), send: vi.fn(), push: vi.fn(), pickedTime: 0 }));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: port.push }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../services/supabase', () => ({ getSupabaseClient: () => null }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn() } }));
vi.mock('./EventDiscussionReader', () => ({ EventDiscussionReader: () => null }));
vi.mock('./ConnectedTaskEditor', () => ({ ConnectedTaskEditor: () => null }));
vi.mock('./NativeMessageActions', () => ({ NativeMessageActions: () => null }));
vi.mock('../lib/connectedWorkflows', async (original) => {
  const actual = await original<WorkflowModule>();
  return { ...actual, connectedWorkflowApi: () => ({ context: port.context, recipients: port.recipients, send: port.send, remind: port.remind,
    eventOrganizerCandidates: port.candidates, setEventOrganizer: port.organizer, setEventContactOptIn: port.contact }) };
});
const session = { access_token: 'editor-token-a', user: { id: 'member-a' } } as Session;
const initial = () => ({ mode: 'authenticated', session: session as Session | null, organizationID: 'org-a', memberLanguage: 'en',
  dashboard: { member: { id: 'member-a', chapterID: 'chapter-a', language: 'en' } } as { member: { id: string; chapterID: string; language: string } } | null,
  chapterMemberships: [{ chapterID: 'chapter-a', organizationID: 'org-a', selected: true }], authorizedRoles: ['admin'], chapterRoles: ['admin'], organizationRoles: [] as string[],
  resumeDraftReads: { dashboard: true, memberships: true, staff: true } as ResumeDraftReads });
let app = initial();
vi.mock('../state/AppProvider', () => ({ useApp: () => { syncResumeDraftContext(app); return app; } }));
import { WorkflowActions } from './WorkflowActions';
const context = () => ({ available: true, canMessage: false, canRemind: true, canManageOrganizer: true, canContactOptIn: true,
  contactOptIn: false, eventVersion: 1, organizer: { id: 'alex', label: 'Alex' }, reference: { kind: 'event', id: 'event-a' }, sourceLinks: [] });
const page = () => ({ status: 'available', items: [{ id: 'alex', label: 'Alex' }, { id: 'bob', label: 'Bob' }], nextCursor: null });
let screen: Rendered | null = null;
let itemID = 'event-a';
let itemKind: 'event' | 'task' = 'event';
const tree = () => h(WorkflowActions, { kind: itemKind, id: itemID, recordTitle: 'Planning' });
const copy = () => connectedActionsCopy[app.memberLanguage === 'es' ? 'es' : 'en'];
const contactCopy = () => connectedContactCopy[app.memberLanguage === 'es' ? 'es' : 'en'];
const contactToggle = () => screen!.container.querySelector('[role="checkbox"]')!;
const setReminder = () => screen!.container.querySelector('[role="button"][aria-label="Set reminder"]')!;
const nativeRequire = createRequire(import.meta.url);
const pickerPath = nativeRequire.resolve('@react-native-community/datetimepicker');
const previousPicker = nativeRequire.cache[pickerPath];
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
async function open() { screen = await render(tree()); await press(getExposed(screen.container, `${itemKind === 'task' ? copy().taskActions : copy().eventActions}: Planning`)); }
async function boot() {
  app = { ...app, mode: 'booting', dashboard: null, chapterMemberships: [], authorizedRoles: [], resumeDraftReads: { dashboard: false, memberships: false, staff: false } };
  await screen!.rerender(tree()); expect(screen!.container.textContent).toBe('');
}
async function restore() { const language = app.memberLanguage; app = initial(); app.memberLanguage = language; app.dashboard!.member.language = language; await screen!.rerender(tree()); }
async function chooseTime(os: 'ios' | 'android') {
  await press(getExposed(screen!.container, /^Reminder time, currently /));
  await press(getExposed(screen!.container, `Native ${os === 'ios' ? 'datetime' : 'date'}`));
  if (os === 'android') await press(getExposed(screen!.container, 'Native time'));
}
beforeEach(() => {
  Object.defineProperty(nativeRequire.cache, pickerPath, { configurable: true, writable: true, value: { id: pickerPath, filename: pickerPath, loaded: true,
    exports: { default: ({ mode, onChange }: { mode: string; onChange: (event: unknown) => void }) =>
      h('button', { 'aria-label': `Native ${mode}`, onClick: () => onChange({ type: 'set', nativeEvent: { timestamp: port.pickedTime } }) }, mode) } } });
  syncResumeDraftContext({ mode: 'signedOut', session: null, organizationID: null }); app = initial(); itemID = 'event-a'; itemKind = 'event';
  vi.resetAllMocks(); port.context.mockResolvedValue(context()); port.candidates.mockResolvedValue(page());
  port.remind.mockResolvedValue({}); port.organizer.mockResolvedValue({}); port.contact.mockResolvedValue({});
  port.recipients.mockResolvedValue(page()); port.send.mockResolvedValue({});
  port.pickedTime = Date.now() + 172800000;
});
afterEach(async () => { await screen?.unmount(); screen = null; vi.useRealTimers(); setPlatform('ios');
  if (previousPicker) Object.defineProperty(nativeRequire.cache, pickerPath, { configurable: true, writable: true, value: previousPicker });
  else Reflect.deleteProperty(nativeRequire.cache, pickerPath);
});
describe.each<'ios' | 'android'>(['ios', 'android'])('connected editor resume on %s', (os) => {
  beforeEach(() => setPlatform(os));
  type Editor = 'reminder' | 'organizer' | 'contact';
  async function prepare(editor: Editor) {
    await open();
    if (editor === 'reminder') {
      await press(getExposed(screen!.container, copy().remind)); await chooseTime(os);
      await type(getExposed(screen!.container, 'Reminder note'), 'Held exact reminder');
    } else if (editor === 'organizer') {
      await press(getExposed(screen!.container, contactCopy().edit)); await press(getExposed(screen!.container, 'Bob'));
    } else await press(contactToggle());
  }
  const mutation = (editor: Editor) => editor === 'reminder' ? port.remind : editor === 'organizer' ? port.organizer : port.contact;
  async function submit(editor: Editor) {
    await press(editor === 'reminder' ? setReminder() : getExposed(screen!.container, editor === 'organizer' ? contactCopy().save : contactCopy().update));
  }
  function expectHeld(editor: Editor) {
    if (editor === 'reminder') expect((getExposed(screen!.container, 'Reminder note') as HTMLTextAreaElement).value).toBe('Held exact reminder');
    else if (editor === 'organizer') expect(getExposed(screen!.container, 'Bob').getAttribute('aria-selected')).toBe('true');
    else expect(contactToggle().getAttribute('aria-checked')).toBe('true');
  }
  it.each(['fresh', 'resumed'])('R1 explains lost reminder permission at Set in a %s sheet', async (state) => {
    await prepare('reminder');
    if (state === 'resumed') { await boot(); await restore(); }
    port.context.mockResolvedValue({ ...context(), canRemind: false }); await submit('reminder');
    expect(screen!.container.textContent).toContain(copy().unavailable);
    expect(screen!.container.querySelector('textarea')).toBeNull(); expect(port.remind).not.toHaveBeenCalled();
  });
  it('R2 shows organizer success without a false failure for an unsaved opt-in toward the old organizer', async () => {
    await prepare('organizer'); await press(contactToggle());
    port.organizer.mockImplementationOnce(async () => {
      port.context.mockResolvedValue({ ...context(), organizer: { id: 'bob', label: 'Bob' }, eventVersion: 2 });
      return {};
    });
    await submit('organizer');
    expect(screen!.container.textContent).toContain(contactCopy().organizerSaved);
    expect(screen!.container.textContent).not.toContain(copy().failed);
    expect(contactToggle().getAttribute('aria-checked')).toBe('false');
    expect(port.contact).not.toHaveBeenCalled(); expect(port.organizer).toHaveBeenCalledTimes(1);
  });
  it.each(['none', 'first page', 'later page'])('R3 keeps the Main organizer default with %s selected', async (selection) => {
    if (selection === 'none') port.context.mockResolvedValue({ ...context(), organizer: null });
    if (selection === 'later page') port.candidates.mockResolvedValue({ ...page(), items: [page().items[1]!], nextCursor: 'later' });
    await open(); await press(getExposed(screen!.container, contactCopy().edit));
    expect(getExposed(screen!.container, contactCopy().save).getAttribute('aria-disabled')).not.toBe('true');
    await submit('organizer'); expect(port.organizer).toHaveBeenCalledWith('event-a', selection === 'none' ? null : 'alex', 1);
  });
  it('R5 keeps the held message when a contact preflight sees a different meeting version', async () => {
    port.context.mockResolvedValue({ ...context(), canMessage: true }); await open();
    await press(getExposed(screen!.container, copy().message)); await type(getExposed(screen!.container, 'Message'), 'Keep this separate message');
    await press(getExposed(screen!.container, 'Alex')); await press(contactToggle());
    port.context.mockResolvedValue({ ...context(), canMessage: true, eventVersion: 2 });
    await submit('contact');
    expect((getExposed(screen!.container, 'Message') as HTMLTextAreaElement).value).toBe('Keep this separate message');
    await boot(); await restore();
    expect((getExposed(screen!.container, 'Message') as HTMLTextAreaElement).value).toBe('Keep this separate message');
    expect(port.contact).not.toHaveBeenCalled(); expect(port.send).not.toHaveBeenCalled();
  });
  // Gate round 1 r1s1/r2s1: a Message draft keeps the sheet mounted, so
  // Discard must clear every in-memory copy of what it retires.
  async function openMessage() {
    await press(getExposed(screen!.container, copy().message)); await type(getExposed(screen!.container, copy().messageBody), 'Separate message');
  }
  const messageField = () => getExposed(screen!.container, copy().messageBody) as HTMLTextAreaElement;
  const retries = () => [...screen!.container.querySelectorAll('[role="button"]')].filter(button => button.textContent === copy().retry);
  function expectOneNotice() {
    expect(screen!.container.textContent!.split(copy().failed).length - 1).toBe(1); expect(retries()).toHaveLength(1);
  }
  const onlyRetry = () => retries()[0]!;
  const alerts = () => [...screen!.container.querySelectorAll('[role="alert"]')];
  function expectOneAlert(text: string) {
    expect(alerts()).toHaveLength(1); expect(alerts()[0]!.textContent).toContain(text); expect(retries()).toHaveLength(1);
  }
  it('A discards the organizer choice while a Message draft keeps the sheet open', async () => {
    port.context.mockResolvedValue({ ...context(), canMessage: true }); await open(); await openMessage();
    await press(getExposed(screen!.container, contactCopy().edit)); await press(getExposed(screen!.container, 'Bob'));
    await press(getExposed(screen!.container, copy().discardContact));
    expect(messageField().value).toBe('Separate message');
    expect(screen!.container.querySelector('[role="radio"]')).toBeNull();
    expect(screen!.container.textContent).not.toContain(copy().discardContact);
    const save = [...screen!.container.querySelectorAll('[role="button"]')].find(button => button.textContent === contactCopy().save);
    if (save) await press(save);
    expect(port.organizer).not.toHaveBeenCalled(); expect(port.send).not.toHaveBeenCalled();
  });
  it('A discards the contact choice while a Message draft keeps the sheet open', async () => {
    port.context.mockResolvedValue({ ...context(), canMessage: true }); await open(); await openMessage();
    await press(contactToggle()); expect(contactToggle().getAttribute('aria-checked')).toBe('true');
    await press(getExposed(screen!.container, copy().discardContact));
    expect(messageField().value).toBe('Separate message');
    expect(contactToggle().getAttribute('aria-checked')).toBe('false');
    expect(getExposed(screen!.container, contactCopy().update).getAttribute('aria-disabled')).toBe('true');
    await press(getExposed(screen!.container, contactCopy().update));
    expect(port.contact).not.toHaveBeenCalled(); expect(port.send).not.toHaveBeenCalled();
  });
  it('A discards the reminder without closing a separate Message draft', async () => {
    port.context.mockResolvedValue({ ...context(), canMessage: true }); await prepare('reminder'); await press(getExposed(screen!.container, 'Cancel'));
    await openMessage(); await press(getExposed(screen!.container, copy().discardReminder));
    expect(messageField().value).toBe('Separate message');
    await press(getExposed(screen!.container, copy().remind));
    expect((getExposed(screen!.container, 'Reminder note') as HTMLTextAreaElement).value).toBe('');
    expect(getExposed(screen!.container, /^Reminder time, currently /).getAttribute('aria-label')).toContain('not selected');
    expect(port.remind).not.toHaveBeenCalled(); expect(port.send).not.toHaveBeenCalled();
  });
  // Gate round 1 r1s2: losing only the capability retires a known-unsent
  // choice, as losing the record's access does.
  it.each<'organizer' | 'contact'>(['organizer', 'contact'])('B retires the unsent %s choice when only its capability is lost', async (editor) => {
    await prepare(editor);
    port.context.mockResolvedValue({ ...context(), ...(editor === 'organizer' ? { canManageOrganizer: false } : { canContactOptIn: false }) });
    await submit(editor); expect(mutation(editor)).not.toHaveBeenCalled();
    port.context.mockResolvedValue(context());
    expectOneNotice(); await press(onlyRetry());
    expect(screen!.container.querySelector('[role="radio"][aria-selected="true"]')).toBeNull();
    expect(contactToggle().getAttribute('aria-checked')).toBe('false');
    expect(screen!.container.textContent).not.toContain(copy().discardContact);
    await boot(); await restore();
    expect(screen!.container.querySelector('[role="radio"]')).toBeNull();
    expect(mutation(editor)).not.toHaveBeenCalled();
  });
  // Controller read R-9362R R1: losing ONE capability retires only that
  // unsent choice and keeps the other, still-allowed one.
  it.each<'organizer' | 'contact'>(['organizer', 'contact'])('R1 keeps the other held choice when only the %s capability is lost', async (lost) => {
    await prepare('organizer'); await press(contactToggle());
    port.context.mockResolvedValue({ ...context(), ...(lost === 'organizer' ? { canManageOrganizer: false } : { canContactOptIn: false }) });
    await submit(lost); expect(mutation(lost)).not.toHaveBeenCalled();
    port.context.mockResolvedValue(context());
    expectOneNotice(); await press(onlyRetry());
    if (lost === 'organizer') {
      expect(screen!.container.querySelector('[role="radio"]')).toBeNull();
      expect(contactToggle().getAttribute('aria-checked')).toBe('true');
    } else {
      expect(getExposed(screen!.container, 'Bob').getAttribute('aria-selected')).toBe('true');
      expect(contactToggle().getAttribute('aria-checked')).toBe('false');
    }
    await boot(); await restore();
    if (lost === 'organizer') expect(contactToggle().getAttribute('aria-checked')).toBe('true');
    else expect(getExposed(screen!.container, 'Bob').getAttribute('aria-selected')).toBe('true');
    expect(port.organizer).not.toHaveBeenCalled(); expect(port.contact).not.toHaveBeenCalled();
  });
  // Controller read R-9362R R2: save-time drift shows one notice, and its one
  // Try again re-reads the source, clears the error and re-runs the editor.
  it('R2 explains a lost opt-in once to a worker whose contact editor disappears', async () => {
    app.authorizedRoles = ['member']; app.chapterRoles = ['member']; await prepare('contact');
    port.context.mockResolvedValue({ ...context(), canManageOrganizer: false, canContactOptIn: false });
    await submit('contact'); expect(port.contact).not.toHaveBeenCalled();
    expect(screen!.container.querySelector('[role="checkbox"]')).toBeNull(); expectOneNotice();
    port.context.mockResolvedValue({ ...context(), canManageOrganizer: false }); await press(onlyRetry());
    expect(screen!.container.textContent).not.toContain(copy().failed);
    expect(contactToggle().getAttribute('aria-checked')).toBe('false'); expect(port.contact).not.toHaveBeenCalled();
  });
  it.each<'organizer' | 'contact'>(['organizer', 'contact'])('R2 shows one notice for %s save-time drift and its Try again re-reads the source', async (editor) => {
    await prepare(editor); port.context.mockResolvedValue({ ...context(), eventVersion: 2 });
    await submit(editor); expect(mutation(editor)).not.toHaveBeenCalled();
    expectOneNotice(); const reads = port.context.mock.calls.length;
    await press(onlyRetry());
    expect(port.context.mock.calls.length).toBe(reads + 1);
    expect(screen!.container.textContent).not.toContain(copy().failed);
    expect(screen!.container.querySelector('[role="radio"]')).toBeNull();
    expect(contactToggle().getAttribute('aria-checked')).toBe('false');
  });
  // Gate round 1 r2s2: an organizer save that leaves the organizer unchanged
  // keeps the unsaved contact preference typed against that organizer.
  it('C keeps an unsaved contact preference through an organizer save that changes nothing', async () => {
    await open(); await press(contactToggle()); await press(getExposed(screen!.container, contactCopy().edit));
    await submit('organizer');
    expect(port.organizer).toHaveBeenCalledWith('event-a', 'alex', 1);
    expect(screen!.container.textContent).toContain(contactCopy().organizerSaved);
    expect(screen!.container.textContent).not.toContain(copy().failed);
    expect(contactToggle().getAttribute('aria-checked')).toBe('true');
    await submit('contact');
    expect(port.contact).toHaveBeenCalledWith('event-a', true, 'alex');
  });
  it('C keeps an unsaved organizer choice through a contact save (guard)', async () => {
    await prepare('organizer'); await press(contactToggle()); await submit('contact');
    expect(screen!.container.textContent).toContain(contactCopy().contactSaved);
    expect(getExposed(screen!.container, 'Bob').getAttribute('aria-selected')).toBe('true');
    await submit('organizer'); expect(port.organizer).toHaveBeenCalledWith('event-a', 'bob', 1);
  });
  it.each<Editor>(['reminder', 'organizer'])('N1 hides sheet-level Discard after cancelling an empty %s editor', async (editor) => {
    await open();
    if (editor === 'reminder') { await press(getExposed(screen!.container, copy().remind)); await press(getExposed(screen!.container, 'Cancel')); }
    else {
      await press(getExposed(screen!.container, contactCopy().edit));
      const cancel = [...screen!.container.querySelectorAll('[role="button"]')].filter(button => button.textContent === copy().cancel).at(-1)!;
      await press(cancel);
    }
    expect(screen!.container.textContent).not.toContain(editor === 'reminder' ? copy().discardReminder : copy().discardContact);
  });
  it.each<Editor>(['reminder', 'organizer', 'contact'])('keeps a pending %s write through resume and consumes its success once', async (editor) => {
    await prepare(editor); const response = deferred<object>(); mutation(editor).mockReturnValueOnce(response.promise);
    await submit(editor); expect(mutation(editor)).toHaveBeenCalledTimes(1);
    await boot(); await restore(); expectHeld(editor);
    await submit(editor); expect(mutation(editor)).toHaveBeenCalledTimes(1);
    await act(async () => response.resolve({}));
    expect(screen!.container.textContent).toContain(editor === 'reminder' ? copy().reminderSet : editor === 'organizer' ? contactCopy().organizerSaved : contactCopy().contactSaved);
    await boot(); await restore();
    expect(mutation(editor)).toHaveBeenCalledTimes(1);
    if (editor === 'reminder') expect(screen!.container.querySelector('textarea')).toBeNull();
    if (editor === 'organizer') expect(screen!.container.querySelector('[role="radio"]')).toBeNull();
  });
  it.each<Editor>(['reminder', 'organizer', 'contact'])('keeps an unknown %s write on refused restoration until explicit Discard', async (editor) => {
    await prepare(editor); const response = deferred<object>(); mutation(editor).mockReturnValueOnce(response.promise);
    await submit(editor); await boot();
    await act(async () => response.reject(new Error('Response lost after dispatch')));
    port.context.mockRejectedValueOnce({ status: 403 }); await restore();
    expect(screen!.container.querySelector('textarea')).toBeNull();
    const discard = editor === 'reminder' ? copy().discardReminder : copy().discardContact;
    await press(getExposed(screen!.container, discard));
    await press(getExposed(screen!.container, `${copy().eventActions}: Planning`));
    expect(screen!.container.textContent).not.toContain(discard);
    expect(mutation(editor)).toHaveBeenCalledTimes(1);
  });
  it.each<Editor>(['reminder', 'organizer', 'contact'])('retries an unknown %s write only by explicit action with the exact original arguments', async (editor) => {
    await prepare(editor); mutation(editor).mockRejectedValueOnce(new Error('Response lost'));
    await submit(editor); const original = mutation(editor).mock.calls[0];
    await boot(); await restore(); expectHeld(editor); expect(mutation(editor)).toHaveBeenCalledTimes(1);
    if (editor === 'reminder') await press(getExposed(screen!.container, copy().retry));
    else await submit(editor);
    expect(mutation(editor)).toHaveBeenCalledTimes(2); expect(mutation(editor).mock.calls[1]).toEqual(original);
  });
  it.each<Editor>(['reminder', 'organizer', 'contact'])('conceals the %s on temporary and bearer failures and restores only after explicit fresh read', async (editor) => {
    await prepare(editor); await boot(); port.context.mockRejectedValueOnce(new Error('Offline')); await restore();
    expect(screen!.container.querySelector('textarea')).toBeNull(); expect(screen!.container.querySelector('[role="radio"]')).toBeNull();
    await press(getExposed(screen!.container, copy().retry)); expectHeld(editor);
    await boot(); port.context.mockRejectedValueOnce({ code: 'PGRST303' }); await restore();
    expect(screen!.container.querySelector('textarea')).toBeNull(); expect(screen!.container.querySelector('[role="radio"]')).toBeNull();
    await press(getExposed(screen!.container, copy().retry)); expectHeld(editor);
    expect(mutation(editor)).not.toHaveBeenCalled();
  });
  it.each<Editor>(['reminder', 'organizer', 'contact'])('retires known-unsent %s work on authoritative source refusal', async (editor) => {
    await prepare(editor); await boot(); port.context.mockRejectedValueOnce({ status: 403 }); await restore();
    expectOneAlert(copy().failed); await press(onlyRetry());
    expect(screen!.container.querySelector('textarea')).toBeNull(); expect(screen!.container.querySelector('[role="radio"]')).toBeNull();
    expect(contactToggle().getAttribute('aria-checked')).toBe('false'); expect(mutation(editor)).not.toHaveBeenCalled();
  });
  it.each(['account', 'organization', 'chapter', 'role', 'signout', 'item'])('never restores either editor across a confirmed %s change', async (change) => {
    await prepare('reminder'); await press(getExposed(screen!.container, 'Cancel'));
    await press(getExposed(screen!.container, contactCopy().edit)); await press(getExposed(screen!.container, 'Bob')); await press(contactToggle());
    await boot(); app = initial();
    if (change === 'account') app.session = { ...session, user: { ...session.user, id: 'member-b' } };
    if (change === 'organization') { app.organizationID = 'org-b'; app.chapterMemberships[0]!.organizationID = 'org-b'; }
    if (change === 'chapter') { app.dashboard!.member.chapterID = 'chapter-b'; app.chapterMemberships[0]!.chapterID = 'chapter-b'; }
    if (change === 'role') app.authorizedRoles = ['staff'];
    if (change === 'item') itemID = 'event-b';
    if (change === 'signout') { app.mode = 'signedOut'; app.session = null; await screen!.rerender(tree()); app = initial(); }
    await screen!.rerender(tree());
    await press(getExposed(screen!.container, `${copy().eventActions}: Planning`));
    expect(screen!.container.querySelector('textarea')).toBeNull(); expect(screen!.container.querySelector('[role="radio"]')).toBeNull();
    expect(port.remind).not.toHaveBeenCalled(); expect(port.organizer).not.toHaveBeenCalled(); expect(port.contact).not.toHaveBeenCalled();
  });
  it('conceals both editors until fresh access after a token refresh', async () => {
    await prepare('reminder'); await press(getExposed(screen!.container, 'Cancel'));
    await press(getExposed(screen!.container, contactCopy().edit)); await press(getExposed(screen!.container, 'Bob'));
    const read = deferred<ReturnType<typeof context>>(); port.context.mockReturnValueOnce(read.promise);
    app.session = { ...session, access_token: 'replacement-token' }; await screen!.rerender(tree());
    expect(screen!.container.querySelector('textarea')).toBeNull(); expect(screen!.container.querySelector('[role="radio"]')).toBeNull();
    await act(async () => read.resolve(context())); expect(getExposed(screen!.container, 'Bob').getAttribute('aria-selected')).toBe('true');
    await press(getExposed(screen!.container, copy().remind)); expectHeld('reminder');
    expect(port.remind).not.toHaveBeenCalled(); expect(port.organizer).not.toHaveBeenCalled();
  });
  it.each(['organizer', 'version', 'candidate', 'permission'])('retires the unsent organizer choice when fresh %s changes', async (changed) => {
    await prepare('organizer'); await boot();
    if (changed === 'organizer') port.context.mockResolvedValue({ ...context(), organizer: { id: 'new', label: 'New organizer' } });
    if (changed === 'version') port.context.mockResolvedValue({ ...context(), eventVersion: 2 });
    if (changed === 'permission') port.context.mockResolvedValue({ ...context(), canManageOrganizer: false });
    if (changed === 'candidate') port.candidates.mockResolvedValue({ ...page(), items: [page().items[0]!] });
    await restore();
    expect(screen!.container.querySelector('[role="radio"]')).toBeNull(); expect(port.organizer).not.toHaveBeenCalled();
    expectOneAlert(copy().failed);
    if (changed !== 'permission') { await press(onlyRetry()); await press(getExposed(screen!.container, contactCopy().edit)); }
    expect(screen!.container.querySelector('[role="radio"][aria-selected="true"]')?.textContent).not.toBe('Bob');
  });
  it('allows Discard while a restoration candidate page is stalled and ignores its late answer', async () => {
    await prepare('organizer'); await boot(); const read = deferred<ReturnType<typeof page>>(); port.candidates.mockReturnValueOnce(read.promise);
    await restore(); await press(getExposed(screen!.container, copy().discardContact));
    await act(async () => read.resolve(page()));
    await press(getExposed(screen!.container, `${copy().eventActions}: Planning`));
    expect(screen!.container.querySelector('[role="radio"]')).toBeNull(); expect(port.organizer).not.toHaveBeenCalled();
  });
  it('keeps an unknown organizer attempt discardable when its candidate disappears', async () => {
    await prepare('organizer'); port.organizer.mockRejectedValueOnce(new Error('Response lost')); await submit('organizer');
    await boot(); port.candidates.mockResolvedValue({ ...page(), items: [page().items[0]!] }); await restore();
    expect(screen!.container.querySelector('[role="radio"]')).toBeNull();
    await press(getExposed(screen!.container, copy().discardContact));
    await press(getExposed(screen!.container, `${copy().eventActions}: Planning`));
    expect(screen!.container.textContent).not.toContain(copy().discardContact); expect(port.organizer).toHaveBeenCalledTimes(1);
  });
  it('ends a stalled restoration candidate page at the read deadline while keeping its unknown attempt', async () => {
    await prepare('organizer'); port.organizer.mockRejectedValueOnce(new Error('Response lost')); await submit('organizer');
    await boot(); vi.useFakeTimers(); port.candidates.mockReturnValueOnce(new Promise(() => {})); await restore();
    await act(async () => { await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS); });
    expect(screen!.container.querySelector('[role="radio"]')).toBeNull();
    await press(getExposed(screen!.container, copy().discardContact)); expect(port.organizer).toHaveBeenCalledTimes(1);
  });
  it.each<Editor>(['reminder', 'organizer', 'contact'])('ignores a late %s acknowledgement after replacement-account work starts', async (editor) => {
    await prepare(editor); const response = deferred<object>(); mutation(editor).mockReturnValueOnce(response.promise);
    await submit(editor); await boot();
    app = initial(); app.session = { ...session, user: { ...session.user, id: 'replacement-person' } }; await screen!.rerender(tree());
    await press(getExposed(screen!.container, `${copy().eventActions}: Planning`));
    await press(getExposed(screen!.container, copy().remind));
    await type(getExposed(screen!.container, 'Reminder note'), 'Replacement account work');
    await act(async () => response.resolve({}));
    expect((getExposed(screen!.container, 'Reminder note') as HTMLTextAreaElement).value).toBe('Replacement account work');
    expect(screen!.container.textContent).not.toContain(copy().reminderSet);
    expect(screen!.container.textContent).not.toContain(contactCopy().organizerSaved);
    expect(screen!.container.textContent).not.toContain(contactCopy().contactSaved);
    expect(mutation(editor)).toHaveBeenCalledTimes(1);
  });
  it.each<Editor>(['reminder', 'organizer', 'contact'])('never dispatches %s after Discard during its preflight read', async (editor) => {
    await prepare(editor); const read = deferred<ReturnType<typeof context>>(); port.context.mockReturnValueOnce(read.promise);
    await submit(editor);
    await press(getExposed(screen!.container, editor === 'reminder' ? copy().discardReminder : copy().discardContact));
    await act(async () => read.resolve(context())); expect(mutation(editor)).not.toHaveBeenCalled();
    await press(getExposed(screen!.container, `${copy().eventActions}: Planning`));
    expect(screen!.container.querySelector('textarea')).toBeNull(); expect(screen!.container.querySelector('[role="radio"]')).toBeNull();
  });
  it('retires reminder work when fresh reminder permission is refused before dispatch', async () => {
    await prepare('reminder'); port.context.mockResolvedValue({ ...context(), canRemind: false }); await submit('reminder');
    await boot(); port.context.mockResolvedValue(context()); await restore();
    await press(getExposed(screen!.container, `${copy().eventActions}: Planning`)); await press(getExposed(screen!.container, copy().remind));
    expect((getExposed(screen!.container, 'Reminder note') as HTMLTextAreaElement).value).toBe(''); expect(port.remind).not.toHaveBeenCalled();
  });
  it('restores Spanish reminder and contact work with localized controls and no automatic write', async () => {
    app.memberLanguage = 'es'; app.dashboard!.member.language = 'es'; await open();
    await press(getExposed(screen!.container, 'Remind me…')); await type(getExposed(screen!.container, 'Nota del recordatorio'), 'Texto sin enviar');
    await press(getExposed(screen!.container, 'Cancelar')); await press(getExposed(screen!.container, contactCopy().edit)); await press(getExposed(screen!.container, 'Bob'));
    await boot(); await restore(); expect(getExposed(screen!.container, 'Bob').getAttribute('aria-selected')).toBe('true');
    getExposed(screen!.container, copy().discardContact); await press(getExposed(screen!.container, 'Remind me…'));
    expect((getExposed(screen!.container, 'Nota del recordatorio') as HTMLTextAreaElement).value).toBe('Texto sin enviar'); getExposed(screen!.container, copy().discardReminder);
    expect(port.remind).not.toHaveBeenCalled(); expect(port.organizer).not.toHaveBeenCalled();
  });
  it('restores the exact reminder note and chosen time only after fresh source access', async () => {
    await open(); await press(getExposed(screen!.container, 'Remind me…')); await chooseTime(os);
    await type(getExposed(screen!.container, 'Reminder note'), '  Unsaved reminder\nexact text  '); await boot();
    const read = deferred<ReturnType<typeof context>>(); port.context.mockReturnValueOnce(read.promise); await restore();
    expect(screen!.container.querySelector('textarea')).toBeNull();
    await act(async () => read.resolve(context()));
    expect((getExposed(screen!.container, 'Reminder note') as HTMLTextAreaElement).value).toBe('  Unsaved reminder\nexact text  ');
    expect(getExposed(screen!.container, /^Reminder time, currently /).getAttribute('aria-label')).not.toContain('not selected');
    expect(port.remind).not.toHaveBeenCalled();
    await press(setReminder());
    expect(port.remind).toHaveBeenCalledWith(expect.any(Object), new Date(port.pickedTime).toISOString(), 'Unsaved reminder\nexact text');
  });
  it('retains the native picker step through resume', async () => {
    await open(); await press(getExposed(screen!.container, 'Remind me…'));
    await press(getExposed(screen!.container, /^Reminder time, currently /));
    if (os === 'android') await press(getExposed(screen!.container, 'Native date'));
    await boot(); await restore();
    getExposed(screen!.container, `Native ${os === 'ios' ? 'datetime' : 'time'}`);
    expect(port.remind).not.toHaveBeenCalled();
  });
  it('restores the organizer and contact choices after fresh context and later candidate pages', async () => {
    await open(); await press(getExposed(screen!.container, contactCopy().edit)); await press(getExposed(screen!.container, 'Bob'));
    await press(contactToggle()); await boot();
    const people = deferred<ReturnType<typeof page>>();
    port.candidates.mockResolvedValueOnce({ ...page(), items: [page().items[0]!], nextCursor: 'page-2' }).mockReturnValueOnce(people.promise);
    await restore(); expect(screen!.container.textContent).not.toContain('Bob');
    await act(async () => people.resolve(page()));
    expect(getExposed(screen!.container, 'Bob').getAttribute('aria-selected')).toBe('true');
    expect(contactToggle().getAttribute('aria-checked')).toBe('true');
    expect(port.candidates).toHaveBeenLastCalledWith('event-a', 'page-2');
    expect(port.organizer).not.toHaveBeenCalled(); expect(port.contact).not.toHaveBeenCalled();
  });
  // a review note and 627 (gate stage 446 r3s1/r4s1 and r3s2/r4s2): a held
  // choice that restoration or a save retires, narrows or meets drift with is
  // explained by exactly one notice with one Try again, never two and never none.
  async function restoreAs(roles?: string[]) {
    app = initial();
    if (roles) { app.authorizedRoles = roles; app.chapterRoles = roles; }
    await screen!.rerender(tree());
  }
  type Loss = 'capability' | 'version' | 'candidate' | 'unavailable' | 'refused';
  it.each<[Editor, Loss]>([
    ['reminder', 'capability'], ['reminder', 'unavailable'], ['reminder', 'refused'],
    ['organizer', 'capability'], ['organizer', 'version'], ['organizer', 'candidate'], ['organizer', 'unavailable'], ['organizer', 'refused'],
    ['contact', 'capability'], ['contact', 'version'], ['contact', 'unavailable'], ['contact', 'refused'],
  ])('626 explains once when restoration retires the only held %s choice (%s)', async (editor, loss) => {
    await prepare(editor); await boot();
    const lost = editor === 'reminder' ? { canRemind: false } : editor === 'organizer' ? { canManageOrganizer: false } : { canContactOptIn: false };
    if (loss === 'capability') port.context.mockResolvedValue({ ...context(), ...lost });
    if (loss === 'version') port.context.mockResolvedValue({ ...context(), eventVersion: 2 });
    if (loss === 'candidate') port.candidates.mockResolvedValue({ ...page(), items: [page().items[0]!] });
    if (loss === 'unavailable') port.context.mockResolvedValue({ ...context(), available: false });
    if (loss === 'refused') port.context.mockRejectedValueOnce({ status: 403 });
    await restoreAs();
    // A reminder retired for lost permission is named by its one plain line
    // (the event is still there); every other loss gets the one alert.
    if (editor === 'reminder' && loss === 'capability') {
      expect(screen!.container.textContent!.split(copy().reminderRemoved).length - 1).toBe(1);
      expect(alerts()).toHaveLength(0); expect(retries()).toHaveLength(0); expect(screen!.container.textContent).not.toContain(copy().unavailable);
    } else expectOneAlert(loss === 'unavailable' ? copy().unavailable : copy().failed);
    expect(screen!.container.querySelector('textarea')).toBeNull(); expect(screen!.container.querySelector('[role="radio"]')).toBeNull();
    expect(screen!.container.textContent).not.toContain(editor === 'reminder' ? copy().discardReminder : copy().discardContact);
    expect(mutation(editor)).not.toHaveBeenCalled();
  });
  it('626 explains once to a worker whose only held opt-in is retired by restoration', async () => {
    app.authorizedRoles = ['member']; app.chapterRoles = ['member']; await prepare('contact'); await boot();
    port.context.mockResolvedValue({ ...context(), canManageOrganizer: false, canContactOptIn: false });
    await restoreAs(['member']);
    expectOneAlert(copy().failed); expect(screen!.container.querySelector('[role="checkbox"]')).toBeNull();
    port.context.mockResolvedValue({ ...context(), canManageOrganizer: false }); await press(onlyRetry());
    expect(alerts()).toHaveLength(0);
    expect(contactToggle().getAttribute('aria-checked')).toBe('false'); expect(port.contact).not.toHaveBeenCalled();
  });
  it.each<'staff' | 'member'>(['staff', 'member'])('626 explains once when a %s save on a resumed sheet retires the only held opt-in', async (who) => {
    const roles = who === 'member' ? ['member'] : undefined;
    if (roles) { app.authorizedRoles = roles; app.chapterRoles = roles; }
    await prepare('contact'); await boot(); await restoreAs(roles); expectHeld('contact');
    port.context.mockResolvedValue({ ...context(), canContactOptIn: false });
    await submit('contact');
    expectOneAlert(copy().failed); expect(port.contact).not.toHaveBeenCalled();
  });
  it.each<['organizer' | 'contact', 'candidate' | 'version']>([['organizer', 'candidate'], ['organizer', 'version'], ['contact', 'version']])(
    '627 shows one notice for a failed %s receipt and a restoration error (%s)', async (editor, drift) => {
      await prepare(editor); mutation(editor).mockRejectedValueOnce(new Error('Response lost')); await submit(editor);
      await boot();
      if (drift === 'candidate') port.candidates.mockResolvedValue({ ...page(), items: [page().items[0]!] });
      else port.context.mockResolvedValue({ ...context(), eventVersion: 2 });
      await restoreAs();
      expectOneAlert(copy().failed); getExposed(screen!.container, copy().discardContact);
      const reads = port.context.mock.calls.length; await press(onlyRetry());
      expect(port.context.mock.calls.length).toBe(reads + 1); expectOneAlert(copy().failed);
      expect(mutation(editor)).toHaveBeenCalledTimes(1);
    });
  // Ledger: a cancelled reminder that is still held (its Discard reminder
  // showing) and is retired by another action's preflight is named once,
  // with no alert and no reminder write.
  const removedCount = () => screen!.container.textContent!.split(copy().reminderRemoved).length - 1;
  async function holdCancelledReminder(state: string) {
    await prepare('reminder'); await press(getExposed(screen!.container, 'Cancel'));
    getExposed(screen!.container, copy().discardReminder);
    // A cancelled reminder is held closed, so the resumed sheet is reopened by its trigger.
    if (state === 'resumed') { await boot(); await restore(); await press(getExposed(screen!.container, `${copy().eventActions}: Planning`)); getExposed(screen!.container, copy().discardReminder); }
  }
  it.each(['fresh', 'resumed'])('names once a cancelled held reminder that a Message preflight retires in a %s sheet', async (state) => {
    port.context.mockResolvedValue({ ...context(), canMessage: true }); await holdCancelledReminder(state);
    port.context.mockResolvedValue({ ...context(), canMessage: true, canRemind: false });
    await press(getExposed(screen!.container, copy().message));
    expect(removedCount()).toBe(1); expect(alerts()).toHaveLength(0); expect(retries()).toHaveLength(0);
    expect(screen!.container.textContent).not.toContain(copy().discardReminder); messageField();
    expect(port.remind).not.toHaveBeenCalled(); expect(port.send).not.toHaveBeenCalled();
    expect(port.organizer).not.toHaveBeenCalled(); expect(port.contact).not.toHaveBeenCalled();
    // The composer's own Cancel keeps the sheet and its one line; closing the sheet clears it.
    const composerCancel = [...screen!.container.querySelectorAll('[role="button"]')].filter(button => button.textContent === copy().cancel).at(-1)!;
    await press(composerCancel); expect(screen!.container.querySelector('textarea')).toBeNull(); expect(removedCount()).toBe(1);
    await press(getExposed(screen!.container, copy().close)); expect(removedCount()).toBe(0);
  });
  it.each<'organizer' | 'contact'>(['organizer', 'contact'])('names once a cancelled held reminder that a %s save preflight retires', async (editor) => {
    await holdCancelledReminder('fresh');
    if (editor === 'organizer') { await press(getExposed(screen!.container, contactCopy().edit)); await press(getExposed(screen!.container, 'Bob')); }
    else await press(contactToggle());
    port.context.mockResolvedValue({ ...context(), canRemind: false }); await submit(editor);
    expect(removedCount()).toBe(1); expect(alerts()).toHaveLength(0);
    expect(screen!.container.textContent).not.toContain(copy().discardReminder);
    expect(port.remind).not.toHaveBeenCalled(); expect(mutation(editor)).toHaveBeenCalledTimes(1);
  });
  // Gate stage 449 r1s1: an action whose check retires the held reminder and
  // would then leave the sheet stays on the sheet for that one run, so the
  // line is seen; the same action, pressed again, opens its screen.
  it.each<'openTask' | 'discussion'>(['openTask', 'discussion'])('names once a cancelled held reminder that a navigating %s check retires, then opens on the next press', async (action) => {
    const fresh = action === 'openTask'
      ? { ...context(), linkedTask: { id: 'task-new', title: 'Follow up on meeting', status: 'backlog' } }
      : { ...context(), reference: { kind: 'task', id: 'task-a' }, discussionHref: '/m/tasks?task=task-a', canManageOrganizer: false, canContactOptIn: false, organizer: null };
    if (action === 'discussion') { itemKind = 'task'; itemID = 'task-a'; }
    port.context.mockResolvedValue(fresh); await prepare('reminder'); await press(getExposed(screen!.container, 'Cancel'));
    getExposed(screen!.container, copy().discardReminder);
    port.context.mockResolvedValue({ ...fresh, canRemind: false });
    const label = action === 'openTask' ? copy().openTask : copy().discussion;
    await press(getExposed(screen!.container, label));
    expect(port.push).not.toHaveBeenCalled();
    expect(removedCount()).toBe(1); expect(alerts()).toHaveLength(0); expect(retries()).toHaveLength(0);
    expect(screen!.container.textContent).not.toContain(copy().discardReminder);
    await press(getExposed(screen!.container, label));
    expect(port.push).toHaveBeenCalledTimes(1); expect(removedCount()).toBe(0);
    expect(port.remind).not.toHaveBeenCalled(); expect(port.send).not.toHaveBeenCalled();
  });
  // a review note and 630 (a): a token refresh during an action queues a restore
  // that runs as that action ends; it must not wipe the line the action owes.
  const refreshToken = async () => { app.session = { ...session, access_token: 'refreshed-token' }; await screen!.rerender(tree()); };
  it('635 keeps the removed-reminder line when a restore is queued during a pending Open linked task check', async () => {
    const fresh = { ...context(), linkedTask: { id: 'task-new', title: 'Follow up on meeting', status: 'backlog' } };
    port.context.mockResolvedValue(fresh); await prepare('reminder'); await press(getExposed(screen!.container, 'Cancel'));
    getExposed(screen!.container, copy().discardReminder);
    const check = deferred<typeof fresh>(); port.context.mockReturnValueOnce(check.promise);
    port.context.mockResolvedValue({ ...fresh, canRemind: false });
    await press(getExposed(screen!.container, copy().openTask)); await refreshToken();
    await act(async () => { check.resolve({ ...fresh, canRemind: false }); await check.promise; });
    expect(port.push).not.toHaveBeenCalled();
    expect(removedCount()).toBe(1); expect(alerts()).toHaveLength(0);
    expect(screen!.container.textContent).not.toContain(copy().discardReminder);
    await press(getExposed(screen!.container, copy().openTask));
    expect(port.push).toHaveBeenCalledTimes(1); expect(port.remind).not.toHaveBeenCalled();
  });
  it('630 (a) keeps Message sent when the token changes during the send', async () => {
    port.context.mockResolvedValue({ ...context(), canMessage: true }); await open(); await openMessage();
    await press(getExposed(screen!.container, 'Alex'));
    const sent = deferred<object>(); port.send.mockReturnValueOnce(sent.promise);
    await press(getExposed(screen!.container, copy().send)); await refreshToken();
    await act(async () => { sent.resolve({}); await sent.promise; });
    expect(screen!.container.textContent!.split(copy().sent).length - 1).toBe(1);
    expect(alerts()).toHaveLength(0); expect(screen!.container.querySelector('textarea')).toBeNull();
    expect(port.send).toHaveBeenCalledTimes(1);
  });
  it('630 (a) keeps Message sent above the one alert of a queued restore that fails', async () => {
    port.context.mockResolvedValue({ ...context(), canMessage: true }); await open(); await openMessage();
    await press(getExposed(screen!.container, 'Alex'));
    const sent = deferred<object>(); port.send.mockReturnValueOnce(sent.promise);
    await press(getExposed(screen!.container, copy().send)); await refreshToken();
    port.context.mockRejectedValueOnce(new Error('Offline'));
    await act(async () => { sent.resolve({}); await sent.promise; });
    expect(screen!.container.textContent!.split(copy().sent).length - 1).toBe(1);
    expectOneAlert(copy().failed);
    expect(screen!.container.textContent!.indexOf(copy().sent)).toBeLessThan(screen!.container.textContent!.indexOf(copy().failed));
    expect(port.send).toHaveBeenCalledTimes(1);
  });
  it('630 (a) keeps the failure line of a Message read that fails while the token changes', async () => {
    port.context.mockResolvedValue({ ...context(), canMessage: true }); await open();
    const people = deferred<ReturnType<typeof page>>(); port.recipients.mockReturnValueOnce(people.promise);
    await press(getExposed(screen!.container, copy().message)); await refreshToken();
    await act(async () => { people.reject(new Error('Offline')); await people.promise.catch(() => undefined); });
    expectOneAlert(copy().failed); expect(screen!.container.querySelector('textarea')).toBeNull();
    expect(port.send).not.toHaveBeenCalled();
  });
  // Gate stage 472 r1s1/r2s1: the queued restore keeps only what a finished
  // person-started action owes; a failure alert a restore raised is cleared
  // when a later restore succeeds.
  it('472 clears the alert of a failed opening restore when the restore queued behind it succeeds', async () => {
    const read = deferred<ReturnType<typeof context>>(); port.context.mockReturnValueOnce(read.promise);
    await open(); await refreshToken();
    await act(async () => { read.reject(new Error('Offline')); await read.promise.catch(() => undefined); });
    expect(alerts()).toHaveLength(0); expect(retries()).toHaveLength(0);
    getExposed(screen!.container, copy().remind);
  });
  it('472 clears the alert of a failed restore when an overlapping token refresh restores', async () => {
    await open(); getExposed(screen!.container, copy().remind);
    const read = deferred<ReturnType<typeof context>>(); port.context.mockReturnValueOnce(read.promise);
    await refreshToken(); app.session = { ...session, access_token: 'second-token' }; await screen!.rerender(tree());
    await act(async () => { read.reject(new Error('Offline')); await read.promise.catch(() => undefined); });
    expect(alerts()).toHaveLength(0); expect(retries()).toHaveLength(0);
    getExposed(screen!.container, copy().remind);
  });
  it('472 keeps Message sent and drops a failed queued restore alert once a later restore succeeds', async () => {
    port.context.mockResolvedValue({ ...context(), canMessage: true }); await open(); await openMessage();
    await press(getExposed(screen!.container, 'Alex'));
    const sent = deferred<object>(); port.send.mockReturnValueOnce(sent.promise);
    await press(getExposed(screen!.container, copy().send)); await refreshToken();
    const read = deferred<ReturnType<typeof context>>(); port.context.mockReturnValueOnce(read.promise);
    await act(async () => { sent.resolve({}); await sent.promise; });
    app.session = { ...session, access_token: 'second-token' }; await screen!.rerender(tree());
    await act(async () => { read.reject(new Error('Offline')); await read.promise.catch(() => undefined); });
    expect(screen!.container.textContent!.split(copy().sent).length - 1).toBe(1);
    expect(alerts()).toHaveLength(0); expect(port.send).toHaveBeenCalledTimes(1);
  });
  it('472 keeps one alert when an action fails and the restore queued behind it fails too', async () => {
    port.context.mockResolvedValue({ ...context(), canMessage: true }); await open();
    const people = deferred<ReturnType<typeof page>>(); port.recipients.mockReturnValueOnce(people.promise);
    await press(getExposed(screen!.container, copy().message)); await refreshToken();
    port.context.mockRejectedValueOnce(new Error('Offline'));
    await act(async () => { people.reject(new Error('Offline')); await people.promise.catch(() => undefined); });
    expectOneAlert(copy().failed); expect(port.send).not.toHaveBeenCalled();
  });
  it('keeps Set on its one unavailable alert and names a restoration loss only with the removed-reminder line', async () => {
    await prepare('reminder'); port.context.mockResolvedValue({ ...context(), canRemind: false }); await submit('reminder');
    expect(removedCount()).toBe(0); expectOneAlert(copy().unavailable);
    await screen!.unmount(); screen = null; port.context.mockResolvedValue(context());
    await prepare('reminder'); await boot(); port.context.mockResolvedValue({ ...context(), canRemind: false }); await restoreAs();
    expect(removedCount()).toBe(1); expect(alerts()).toHaveLength(0); expect(screen!.container.textContent).not.toContain(copy().unavailable);
    expect(port.remind).not.toHaveBeenCalled();
  });
  // Read r-c365 (2) P3: Discard during the restoration read is the person's
  // own choice, so nothing afterwards speaks about that reminder.
  it.each(['still allowed', 'no longer allowed'])('says nothing about a reminder the person discards during the restoration read (%s)', async (permission) => {
    await prepare('reminder'); await press(getExposed(screen!.container, 'Cancel')); await press(contactToggle());
    await boot(); const read = deferred<ReturnType<typeof context>>(); port.context.mockReturnValueOnce(read.promise);
    await restoreAs(); await press(getExposed(screen!.container, copy().discardReminder));
    await act(async () => { read.resolve({ ...context(), canRemind: permission === 'still allowed' }); await read.promise; });
    expect(removedCount()).toBe(0); expect(alerts()).toHaveLength(0);
    expect(screen!.container.textContent).not.toContain(copy().unavailable); expect(screen!.container.textContent).not.toContain(copy().discardReminder);
    expect(contactToggle().getAttribute('aria-checked')).toBe('true');
    expect(port.remind).not.toHaveBeenCalled(); expect(port.contact).not.toHaveBeenCalled();
  });
  it.each(['first', 'more'])('bounds a stalled %s organizer page with the existing read deadline', async (which) => {
    await open();
    if (which === 'more') { port.candidates.mockResolvedValueOnce({ ...page(), nextCursor: 'page-2' }); await press(getExposed(screen!.container, contactCopy().edit)); }
    vi.useFakeTimers(); port.candidates.mockReturnValueOnce(new Promise(() => {}));
    await press(getExposed(screen!.container, which === 'first' ? contactCopy().edit : contactCopy().more));
    await act(async () => { await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS); });
    const retry = getExposed(screen!.container, copy().retry);
    expect(retry.getAttribute('aria-disabled')).not.toBe('true');
    expect(port.organizer).not.toHaveBeenCalled();
  });
});
