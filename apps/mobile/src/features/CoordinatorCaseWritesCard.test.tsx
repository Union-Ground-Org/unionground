// @vitest-environment jsdom
import { stubSessionWriter } from '../testing/stubSessionWriter';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessibilityInfo, getExposed, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';

// BUG-UG-NATIVE-IOS-STEWARD-CANNOT-WORK-AN-ASSIGNED-CASE-20261117
// (#9091), part 4: the coordinator's case writes on their own: each goes
// through the website's coordinator routine, then hands the case screen its
// onChanged, which writes the updated_case access-history entry (#9120) and
// rereads the case (coordinatorCaseWrites.screen.test.tsx).
const port = vi.hoisted(() => ({
  rpc: vi.fn<(name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>>(),
  language: 'en' as 'en' | 'es',
  pick: 0,
  check: vi.fn<() => Promise<'current' | 'unavailable' | 'changed'>>(),
  deadlineMs: null as number | null,
  // The session writer refuses before sending (its own WriterSessionChanged).
  writerRefuses: false,
}));
// #9440 round 1: a shorter write deadline for the timeout rows only.
type ReadDeadlineModule = typeof import('../lib/readDeadline');
vi.mock('../lib/readDeadline', async (original) => {
  const actual = await original<ReadDeadlineModule>();
  return { ...actual, withReadDeadline: <T,>(request: Promise<T>, ms?: number) => actual.withReadDeadline(request, port.deadlineMs ?? ms) };
});
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../components/ui', async () => {
  const ui = await import('../testing/uiStandIn');
  const { Pressable, Text } = await import('../testing/reactNativeStandIn');
  return {
    ...ui,
    Button: ({ label, onPress, disabled, busy, selected, accessibilityLabel }: { label: string; onPress?: () => void; disabled?: boolean; busy?: boolean; selected?: boolean; accessibilityLabel?: string }) =>
      h(Pressable, { accessibilityLabel: accessibilityLabel ?? label, onPress, disabled: disabled || busy, accessibilityRole: selected === undefined ? 'button' : 'radio', accessibilityState: { disabled: disabled || busy, busy, selected } }, h(Text, null, label)),
  };
});
vi.mock('../lib/nativeDateTimePicker', async () => {
  const { Pressable, Text } = await import('../testing/reactNativeStandIn');
  return {
    loadNativeDateTimePicker: () => ({ mode, onChange }: { mode: string; onChange: (event: { type: string; nativeEvent: { timestamp: number } }) => void }) =>
      h(Pressable, { accessibilityLabel: `Pick ${mode}`, onPress: () => onChange({ type: 'set', nativeEvent: { timestamp: port.pick } }) }, h(Text, null, mode)),
  };
});
// #9240 PR E: the one signed-in fixture (src/testing/retainedDraftHarness),
// synced into the draft holder before each render as the provider does.
vi.mock('../state/AppProvider', async () => {
  const { appProviderStandIn } = await import('../testing/retainedDraftHarness');
  return { useApp: () => ({ ...appProviderStandIn.useApp(), memberLanguage: port.language }) };
});
vi.mock('expo-crypto', () => ({ randomUUID: () => `attempt-${Math.random().toString(36).slice(2)}` }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({ foreground: '#21152C', input: '#FFFFFF', border: '#827486', primary: '#3D2A4F', destructive: '#9A1B1B', mutedForeground: '#615568', appearance: 'light' }) }));
vi.mock('../services/supabase', async () => {
  const fixture = await (() => ({ getSupabaseClient: () => ({ rpc: port.rpc }) }))();
  return { ...fixture, captureSessionWriter: () => ({ ...stubSessionWriter(() => { if (port.writerRefuses) throw new WriterSessionChanged(); return fixture.getSupabaseClient(); }), check: port.check }) };
});
import { WriterSessionChanged } from '../../../../src/lib/sessionBoundWriter.js';
import { CoordinatorCaseWritesCard } from './CoordinatorCaseWritesCard';
import { useApp } from '../state/AppProvider';
import { boot, leaveChapter, leaveOrganization, mfa, otherAccount, restore, signIn, signOut, unconfirmReads } from '../testing/retainedDraftHarness';
import type { MemberCaseDetail } from '../models/member';

const props = { caseID: 'case-1', currentDeadline: '2026-12-01' };
let screen: Rendered | null = null;
const onChanged = vi.fn<() => Promise<MemberCaseDetail | null>>();
const onRefresh = vi.fn<() => Promise<MemberCaseDetail | null>>();
// The case as the screen's reread returns it.
const reread: MemberCaseDetail = {
  item: { id: 'case-1', ownerID: 'member-b', reference: 'GR-2026-41960', title: 'Overtime assignment out of order', deadline: '2026-12-01', caseType: 'Pay', step: 'intake', status: 'active', updatedAt: '2026-11-19T12:00:00Z' },
  updates: [],
};
beforeEach(() => {
  signIn('chapterless');
  port.deadlineMs = null;
  port.writerRefuses = false;
  port.check.mockReset().mockResolvedValue('current');
  port.language = 'en';
  port.pick = Date.parse('2026-11-18T15:00:00Z');
  port.rpc.mockResolvedValue({ data: { id: 'row' }, error: null });
  onChanged.mockResolvedValue(reread);
  onRefresh.mockResolvedValue(reread);
});
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); port.rpc.mockReset(); onChanged.mockReset(); onRefresh.mockReset(); });

async function type(label: string, value: string) {
  const input = getExposed(screen!.container, label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const names = () => port.rpc.mock.calls.map(([name]) => name);

it('keeps accepted staff writes stale through unavailable then changed proof without follow-ups', async () => {
  screen = await render(h(CoordinatorCaseWritesCard, { ...props, onChanged, onRefresh }));
  const plain = vi.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const queued = vi.spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions');
  port.check.mockResolvedValueOnce('unavailable').mockResolvedValueOnce('changed');
  for (const text of ['First accepted note.', 'Second accepted note.']) {
    await type('Issue note', text); await press(getExposed(screen.container, 'Add issue note'));
    expect(getExposed(screen.container, 'Refresh the issue')).toBeTruthy();
    expect(screen.container.textContent).toContain('Issue note saved.');
    expect(onChanged).not.toHaveBeenCalled(); expect(onRefresh).not.toHaveBeenCalled();
    expect(plain).not.toHaveBeenCalled(); expect(queued).not.toHaveBeenCalled();
  }
  expect(names()).toEqual(['coordinator_add_case_note', 'coordinator_add_case_note']);
  expect(port.check).toHaveBeenCalledTimes(2);
  plain.mockRestore(); queued.mockRestore();
});

it('keeps the next issue draft when the previous issue acknowledges a note', async () => {
  let release!: (value: { data: unknown; error: unknown }) => void;
  screen = await render(h(CoordinatorCaseWritesCard, { ...props, onChanged, onRefresh }));
  await type('Issue note', 'First issue note.');
  port.rpc.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  await press(getExposed(screen.container, 'Add issue note'));
  const nextChanged = vi.fn(async () => reread);
  await screen.rerender(h(CoordinatorCaseWritesCard, { ...props, caseID: 'case-2', onChanged: nextChanged, onRefresh }));
  await type('Issue note', 'Second issue draft.');
  await act(async () => { release({ data: {}, error: null }); });
  expect((getExposed(screen.container, 'Issue note') as HTMLTextAreaElement).value).toBe('Second issue draft.');
  expect(onChanged).not.toHaveBeenCalled(); expect(nextChanged).not.toHaveBeenCalled();
  await press(getExposed(screen.container, 'Add issue note'));
  expect(nextChanged).toHaveBeenCalledOnce();
});

describe.each<'ios' | 'android'>(['ios', 'android'])('campaign lead issue writes on %s', (os) => {
  it('logs a contact with the employer and hands the change to the issue screen', async () => {
    setPlatform(os);
    screen = await render(h(CoordinatorCaseWritesCard, { ...props, onChanged, onRefresh }));
    await press(getExposed(screen.container, 'Meeting'));
    await press(getExposed(screen.container, 'Inbound'));
    await press(getExposed(screen.container, 'Contacted at: Choose date and time'));
    if (os === 'android') {
      await press(getExposed(screen.container, 'Pick date'));
      await press(getExposed(screen.container, 'Pick time'));
    } else {
      await press(getExposed(screen.container, 'Pick datetime'));
    }
    await type('Contact summary', ' Supervisor offered to restore the overtime slot. ');
    await press(getExposed(screen.container, 'Log contact'));
    expect(port.rpc).toHaveBeenCalledWith('coordinator_log_case_contact', {
      p_case_id: 'case-1', p_contact_type: 'meeting', p_direction: 'inbound', p_summary: 'Supervisor offered to restore the overtime slot.', p_contacted_at: '2026-11-18T15:00:00.000Z',
    });
    expect(names()).toEqual(['coordinator_log_case_contact']);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.container.textContent).toContain('Contact logged.');
  });
});

it('adds a campaign lead issue note', async () => {
  screen = await render(h(CoordinatorCaseWritesCard, { ...props, onChanged, onRefresh }));
  await type('Issue note', 'Called the worker about the Step 2 date.');
  await press(getExposed(screen.container, 'Add issue note'));
  expect(port.rpc).toHaveBeenCalledWith('coordinator_add_case_note', { p_case_id: 'case-1', p_body: 'Called the worker about the Step 2 date.' });
  expect(screen.container.textContent).toContain('Issue note saved.');
});

it('moves the issue deadline to a later calendar day with a reason, sending nothing else', async () => {
  port.pick = Date.parse('2026-12-20T17:00:00Z');
  screen = await render(h(CoordinatorCaseWritesCard, { ...props, onChanged, onRefresh }));
  await press(getExposed(screen.container, 'Next deadline: Choose a date'));
  await press(getExposed(screen.container, 'Pick date'));
  await type('Reason for change', 'Employer agreed to a later Step 2 meeting.');
  await press(getExposed(screen.container, 'Save the new deadline'));
  expect(port.rpc).toHaveBeenCalledWith('coordinator_update_case', { p_case_id: 'case-1', p_deadline: '2026-12-20', p_reason: 'Employer agreed to a later Step 2 meeting.' });
  expect(screen.container.textContent).toContain('Issue deadline changed.');
});

it('refuses an earlier deadline before asking the server', async () => {
  port.pick = Date.parse('2026-11-25T17:00:00Z');
  screen = await render(h(CoordinatorCaseWritesCard, { ...props, onChanged, onRefresh }));
  await press(getExposed(screen.container, 'Next deadline: Choose a date'));
  await press(getExposed(screen.container, 'Pick date'));
  await type('Reason for change', 'Earlier meeting.');
  await press(getExposed(screen.container, 'Save the new deadline'));
  expect(port.rpc).not.toHaveBeenCalled();
  expect(screen.container.textContent).toContain('The new deadline can’t be earlier than the current one.');
});

// Every refusal the three routines raise has its own message.
it.each([
  ['42501', 'campaign lead role required', 'Only a campaign lead can make this change, so nothing was saved.'],
  ['42501', 'issue unavailable', 'This issue is no longer available to you, so nothing was saved.'],
  ['P0002', 'issue not found', 'This issue is no longer available to you, so nothing was saved.'],
  ['42501', 'mfa required', 'This change needs two-step verification on this account, so nothing was saved.'],
  ['42501', 'step-up required', 'Sign in with your password to change this issue. Nothing was saved.'],
  ['42501', 'sensitive-data-trusted-write-required', 'You can’t change this issue, so nothing was saved.'],
  ['22023', 'note must be 1-4000 characters', 'Write a note of 1 to 4,000 characters.'],
  ['22023', 'invalid contact type', 'Choose a contact type and direction and write a summary of 1 to 2,000 characters.'],
  ['22023', 'invalid contact time', 'Choose when the contact happened; it can’t be in the future.'],
  ['22023', 'deadline may only be extended', 'The new deadline can’t be earlier than the current one. Choose a later date.'],
  ['22023', 'reason must be 1-1000 characters', 'Give a reason for the change of 1 to 1,000 characters.'],
  ['22023', 'invalid status', 'That change was not accepted, so nothing was saved.'],
  ['57014', 'canceling statement due to statement timeout', 'The issue was not saved. Try again in a moment.'],
// #9440 successor: none of these answers proves the note was not saved (a
// gateway can answer with any code or text after it committed), so each locks
// it as unconfirmed and never names it as refused.
])('locks the note as unconfirmed on the %s answer "%s", never naming it', async (code, reason, shown) => {
  port.rpc.mockResolvedValueOnce({ data: null, error: { code, message: reason } });
  screen = await render(h(CoordinatorCaseWritesCard, { ...props, onChanged, onRefresh }));
  await type('Issue note', 'Called the worker.');
  await press(getExposed(screen.container, 'Add issue note'));
  expect(screen.container.textContent).not.toContain(shown);
  expect(screen.container.textContent).toContain('We could not confirm this issue note was saved.');
  expect(getExposed(screen.container, 'Save again')).toBeTruthy();
  expect(names()).toEqual(['coordinator_add_case_note']);
  expect(onChanged).not.toHaveBeenCalled();
});

it('says the screen could not be refreshed when the reread fails, and rereads on Refresh', async () => {
  onChanged.mockResolvedValueOnce(null);
  screen = await render(h(CoordinatorCaseWritesCard, { ...props, onChanged, onRefresh }));
  await type('Issue note', 'Called the worker.');
  await press(getExposed(screen.container, 'Add issue note'));
  expect(screen.container.textContent).toContain('This screen could not be refreshed.');
  await press(getExposed(screen.container, 'Refresh the issue'));
  expect(names().filter((name) => name === 'coordinator_add_case_note')).toHaveLength(1);
  // The retry only rereads; the write's updated_case entry is written once.
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(onRefresh).toHaveBeenCalledTimes(1);
  expect(screen.container.textContent).toContain('Issue note saved.');
});

it('speaks Spanish for a Spanish profile', async () => {
  port.language = 'es';
  screen = await render(h(CoordinatorCaseWritesCard, { ...props, onChanged, onRefresh }));
  expect(screen.container.textContent).toContain('Cambios del coordinador en el asunto');
  expect(getExposed(screen.container, 'Registrar contacto')).toBeTruthy();
  expect(getExposed(screen.container, 'Guardar la nueva fecha límite')).toBeTruthy();
});

// #9240 pull request E (design R-9240D, row E): the coordinator's note,
// contact and new deadline wait in memory through a session check, keyed by
// the case, here for a chapterless (organization) coordinator. The host
// unmounts the card while the session is checked, as the case screen does.
function Host({ caseID }: { caseID: string }) {
  const { mode, dashboard } = useApp();
  if (mode !== 'authenticated' || !dashboard) return null;
  return h('div', null, h(CoordinatorCaseWritesCard, { ...props, caseID, onChanged, onRefresh }));
}
const field = (label: string) => screen!.container.querySelector(`textarea[aria-label="${label}"]`) as HTMLTextAreaElement | null;
async function check(change: () => void, caseID = 'case-1') {
  boot(); await screen!.rerender(h(Host, { caseID }));
  change(); await screen!.rerender(h(Host, { caseID }));
}
async function fill(os: 'ios' | 'android') {
  await type('Issue note', 'Spoke with the plant manager.');
  await press(getExposed(screen!.container, 'Email'));
  await press(getExposed(screen!.container, 'Inbound'));
  await press(getExposed(screen!.container, 'Contacted at: Choose date and time'));
  if (os === 'android') { await press(getExposed(screen!.container, 'Pick date')); await press(getExposed(screen!.container, 'Pick time')); }
  else await press(getExposed(screen!.container, 'Pick datetime'));
  await type('Contact summary', 'HR asked for the overtime list.');
  await type('Reason for change', 'The employer agreed to more time.');
}

describe.each<'ios' | 'android'>(['ios', 'android'])('campaign lead drafts through a session check on %s', (os) => {
  beforeEach(() => { setPlatform(os); });

  it('brings back the note, the contact and the deadline reason for the same campaign lead on the same issue', async () => {
    screen = await render(h(Host, { caseID: 'case-1' }));
    await fill(os);
    await check(restore);
    expect(field('Issue note')?.value).toBe('Spoke with the plant manager.');
    expect(field('Contact summary')?.value).toBe('HR asked for the overtime list.');
    expect(field('Reason for change')?.value).toBe('The employer agreed to more time.');
    expect(getExposed(screen.container, 'Email').getAttribute('aria-selected')).toBe('true');
    expect(getExposed(screen.container, 'Inbound').getAttribute('aria-selected')).toBe('true');
    await press(getExposed(screen.container, 'Log contact'));
    expect(port.rpc).toHaveBeenCalledWith('coordinator_log_case_contact', expect.objectContaining({ p_contact_type: 'email', p_direction: 'inbound', p_summary: 'HR asked for the overtime list.' }));
  });

  it('shows nothing it holds while the session is checked or the access reads are unconfirmed', async () => {
    screen = await render(h(Host, { caseID: 'case-1' }));
    await fill(os);
    boot(); await screen.rerender(h(Host, { caseID: 'case-1' }));
    unconfirmReads(); await screen.rerender(h(Host, { caseID: 'case-1' }));
    expect(field('Issue note')).toBeNull();
    expect(screen.container.innerHTML).not.toContain('Spoke with the plant manager.');
    restore(); await screen.rerender(h(Host, { caseID: 'case-1' }));
    expect(field('Issue note')?.value).toBe('Spoke with the plant manager.');
  });

  it('gives another issue nothing, and starts blank on returning to the first issue', async () => {
    screen = await render(h(Host, { caseID: 'case-1' }));
    await fill(os);
    await check(restore, 'case-2');
    expect(field('Issue note')?.value).toBe('');
    expect(field('Contact summary')?.value).toBe('');
    expect(field('Reason for change')?.value).toBe('');
    await screen.rerender(h(Host, { caseID: 'case-1' }));
    expect(field('Issue note')?.value).toBe('');
    expect(screen.container.innerHTML).not.toContain('Spoke with the plant manager.');
  });

  it.each<[string, () => void]>([
    ['another account', otherAccount], ['a campaign it now has', leaveChapter], ['another organization', leaveOrganization],
  ])('starts blank for %s', async (_name, change) => {
    screen = await render(h(Host, { caseID: 'case-1' }));
    await fill(os);
    await check(change);
    expect(field('Issue note')?.value).toBe('');
    expect(field('Contact summary')?.value).toBe('');
    expect(screen.container.innerHTML).not.toContain('The employer agreed to more time.');
  });

  it.each<[string, () => void]>([['sign-out', signOut], ['an MFA challenge', mfa]])('retires everything on %s', async (_name, change) => {
    screen = await render(h(Host, { caseID: 'case-1' }));
    await fill(os);
    await check(change);
    restore(); await screen.rerender(h(Host, { caseID: 'case-1' }));
    expect(field('Issue note')?.value).toBe('');
  });

  it('sends a note that was in flight at the check once, and comes back blank once it is saved', async () => {
    let answer!: (reply: { data: unknown; error: unknown }) => void;
    port.rpc.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    screen = await render(h(Host, { caseID: 'case-1' }));
    await type('Issue note', 'In flight at the check.');
    await press(getExposed(screen.container, 'Add issue note'));
    await check(restore);
    expect(field('Issue note')?.disabled).toBe(true);
    await press(getExposed(screen.container, 'Saving…'));
    await act(async () => { answer({ data: { id: 'row' }, error: null }); });
    expect(names()).toEqual(['coordinator_add_case_note']);
    expect(field('Issue note')?.value).toBe('');
  });

  it('keeps a contact answered with a refusal code after the check locked as unconfirmed', async () => {
    let answer!: (reply: { data: unknown; error: unknown }) => void;
    screen = await render(h(Host, { caseID: 'case-1' }));
    await fill(os);
    port.rpc.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    await press(getExposed(screen.container, 'Log contact'));
    await check(restore);
    await act(async () => { answer({ data: null, error: { code: '22023', message: 'invalid contact type' } }); });
    expect(field('Contact summary')?.value).toBe('HR asked for the overtime list.');
    expect(field('Contact summary')?.disabled).toBe(true);
    expect(screen.container.textContent).toContain('We could not confirm this contact was logged.');
    expect(screen.container.textContent).not.toContain('Choose a contact type and direction');
  });

  it('returns the contact as editable text when the session writer refuses before sending', async () => {
    screen = await render(h(Host, { caseID: 'case-1' }));
    await fill(os);
    await check(restore);
    port.writerRefuses = true;
    await press(getExposed(screen.container, 'Log contact'));
    expect(names()).toEqual([]);
    expect(field('Contact summary')?.value).toBe('HR asked for the overtime list.');
    expect(field('Contact summary')?.disabled).toBe(false);
    expect(screen.container.textContent).toContain('The issue was not saved. Try again in a moment.');
  });
});

// #9440 round 1: the coordinator's note, contact and deadline change have no
// key. A write with no answer, or one that runs into the 20-second deadline,
// may have gone through: its form stays locked as unconfirmed with Save again
// and Discard, nothing sends it again on its own, and Save again sends it
// exactly once more.
const waitTask = (ms = 20) => act(async () => { await new Promise((resolve) => { setTimeout(resolve, ms); }); });
type CoordinatorRow = [string, string, string, string, string, (os: 'ios' | 'android') => Promise<void>];
const coordinatorRows: CoordinatorRow[] = [
  ['note', 'coordinator_add_case_note', 'Add issue note', 'Issue note', 'We could not confirm this issue note was saved.', async () => { await type('Issue note', 'May have been saved.'); }],
  ['contact', 'coordinator_log_case_contact', 'Log contact', 'Contact summary', 'We could not confirm this contact was logged.', async (os) => {
    await press(getExposed(screen!.container, 'Contacted at: Choose date and time'));
    if (os === 'android') { await press(getExposed(screen!.container, 'Pick date')); await press(getExposed(screen!.container, 'Pick time')); }
    else await press(getExposed(screen!.container, 'Pick datetime'));
    await type('Contact summary', 'May have been saved.');
  }],
  ['deadline change', 'coordinator_update_case', 'Save the new deadline', 'Reason for change', 'We could not confirm the issue deadline was changed.', async () => {
    port.pick = Date.parse('2026-12-20T17:00:00Z');
    await press(getExposed(screen!.container, 'Next deadline: Choose a date'));
    await press(getExposed(screen!.container, 'Pick date'));
    await type('Reason for change', 'May have been saved.');
  }],
];
describe.each<'ios' | 'android'>(['ios', 'android'])('an unconfirmed campaign lead write on %s', (os) => {
  beforeEach(() => { setPlatform(os); });
  const lost = () => { port.rpc.mockResolvedValueOnce({ data: null, error: { message: 'TypeError: Network request failed' } }); };
  const hung = () => { port.deadlineMs = 5; port.rpc.mockImplementationOnce(() => new Promise(() => {})); };
  // A PostgREST-shaped 403 answer carrying 42501, as the client reports it.
  const forbidden = { data: null, error: { code: '42501', message: 'permission denied for function', details: null, hint: null }, status: 403, statusText: 'Forbidden' };
  const postgrest = () => { port.rpc.mockResolvedValueOnce(forbidden); };
  for (const [kind, routine, save, label, warning, fill] of coordinatorRows) {
    it.each<[string, () => void]>([['a lost answer', lost], ['the write deadline', hung], ['a PostgREST 403 carrying 42501', postgrest]])(`locks the ${kind} after %s, offers Save again and Discard, and sends once per press`, async (_name, fail) => {
      screen = await render(h(CoordinatorCaseWritesCard, { ...props, onChanged, onRefresh }));
      await fill(os);
      const writes = () => names().filter((name) => name === routine).length;
      fail();
      await press(getExposed(screen.container, save));
      await waitTask();
      expect(writes()).toBe(1);
      expect(field(label)?.value).toBe('May have been saved.');
      expect(field(label)?.disabled).toBe(true);
      expect(screen.container.textContent).toContain(warning);
      expect(screen.container.textContent).not.toContain('The issue was not saved.');
      await waitTask();
      expect(writes()).toBe(1);
      fail();
      await press(getExposed(screen.container, 'Save again'));
      await waitTask();
      expect(writes()).toBe(2);
      expect(field(label)?.disabled).toBe(true);
      await press(getExposed(screen.container, 'Discard'));
      expect(field(label)?.value).toBe('');
      expect(field(label)?.disabled).toBe(false);
      expect(writes()).toBe(2);
    });
  }
});

// #9443 round 1: the session writer's refusal of Save again proves only that
// the retry was not sent; the first write may have committed. The form stays
// locked with the refusal named beside Save again and Discard.
describe.each<'ios' | 'android'>(['ios', 'android'])('a refused Save again on an unconfirmed campaign lead write on %s', (os) => {
  beforeEach(() => { setPlatform(os); });
  for (const [kind, routine, save, label, warning, fill] of coordinatorRows) {
    it(`keeps the ${kind} locked and names the refusal; a later Save again sends it once`, async () => {
      screen = await render(h(CoordinatorCaseWritesCard, { ...props, onChanged, onRefresh }));
      await fill(os);
      const writes = () => names().filter((name) => name === routine).length;
      port.rpc.mockResolvedValueOnce({ data: null, error: { message: 'TypeError: Network request failed' } });
      await press(getExposed(screen.container, save));
      expect(writes()).toBe(1);
      port.writerRefuses = true;
      await press(getExposed(screen.container, 'Save again'));
      expect(writes()).toBe(1);
      expect(field(label)?.value).toBe('May have been saved.');
      expect(field(label)?.disabled).toBe(true);
      expect(screen.container.textContent).toContain(warning);
      expect(screen.container.textContent).toContain('Save again was refused before it was sent. The first save is still unconfirmed, so it stays locked.');
      expect(screen.container.textContent).not.toContain('The issue was not saved.');
      expect(getExposed(screen.container, 'Save again')).toBeTruthy();
      expect(getExposed(screen.container, 'Discard')).toBeTruthy();
      port.writerRefuses = false;
      await press(getExposed(screen.container, 'Save again'));
      expect(writes()).toBe(2);
      expect(field(label)?.value).toBe('');
    });
  }
});
