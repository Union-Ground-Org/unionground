import { stubSessionWriter } from '../testing/stubSessionWriter';
// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { clearHeldDrafts } from '../testing/retainedDraftHarness';
import { getExposed, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import type { MemberCase, MemberCaseDetail } from '../models/member';
import palette from '../theme/palette.json';

// BUG-UG-NATIVE-IOS-STEWARD-CANNOT-WORK-AN-ASSIGNED-CASE-20261117
// (#9091), part 1: a steward who opens a case assigned to them on the phone
// adds a case note through the website's own routine, and the reloaded case
// shows it in the case timeline. Nobody else gets the control.
const port = vi.hoisted(() => ({
  app: {} as Record<string, unknown>,
  loadCaseDetail: vi.fn<(userID: string, caseID: string, staff: boolean) => Promise<MemberCaseDetail | null>>(),
  rpc: vi.fn(),
  reads: [] as [string, string][][],
  // #9120 access-history entries the screen writes, and whether they fail.
  access: [] as [string, string][],
  accessFails: false,
}));
// record_member_access_event answers here; every other routine goes to port.rpc.
function rpc(name: string, args: Record<string, unknown>) {
  if (name !== 'record_member_access_event') return port.rpc(name, args);
  port.access.push([String(args.p_action), String(args.p_subject_user_id)]);
  return Promise.resolve({ data: null, error: port.accessFails ? { code: '42501', message: 'denied' } : null });
}
// member_cases answers a row only for the case's assigned steward, as its row
// security and the steward_user_id filter do.
function from(table: string) {
  const filters: [string, string][] = [];
  const query = {
    select: () => query,
    eq: (column: string, value: string) => { filters.push([column, value]); return query; },
    maybeSingle: async () => {
      port.reads.push(filters);
      const own = table === 'member_cases' && filters.some(([c, v]) => c === 'id' && v === 'case-1') && filters.some(([c, v]) => c === 'steward_user_id' && v === STEWARD);
      return { data: own ? { id: 'case-1' } : null, error: null };
    },
  };
  return query;
}
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('expo-crypto', () => ({ randomUUID: () => `attempt-${Math.random().toString(36).slice(2)}` }));
vi.mock('../components/ui', async () => {
  const ui = await import('../testing/uiStandIn');
  return { ...ui, StatusPill: ({ label }: { label: string }) => h('span', null, label), StateMessage: ({ title, body }: { title: string; body?: string }) => h('section', null, title, body) };
});
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'case-1' }), useRouter: () => ({ push: vi.fn() }), Redirect: () => null }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
// #9240 PR E: the case cards' drafts wait in the draft holder; sync this
// fixture into it on each render, as the provider does, and start each
// test with nothing held.
vi.mock('../state/AppProvider', async () => {
  const { syncedApp } = await import('../testing/retainedDraftHarness');
  return { useApp: () => syncedApp(port.app) };
});
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: { user: { id: string } } | null) => stubSessionWriter(() => ({ rpc, from }), session?.user.id ?? 'signed-out'), loadCaseDetail: port.loadCaseDetail, getSupabaseClient: () => ({ rpc, from }) }));
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: ({ children }: { children?: ReactNode }) => h('div', null, children) }));
vi.mock('../components/AttachmentPanel', () => ({ AttachmentPanel: () => null }));
vi.mock('../components/CompassCaseHelp', () => ({ CompassCaseHelp: () => null }));
vi.mock('./CaseRowTopicCards', () => ({ CaseRowTopicCard: () => null }));
vi.mock('./CoordinatorCaseWritesCard', () => ({ CoordinatorCaseWritesCard: () => null }));

const { default: CaseDetailScreen } = await import('../../app/issue/[id]');

const STEWARD = 'steward-a';
const assigned: MemberCase = {
  id: 'case-1', ownerID: 'member-b', reference: 'GR-2026-41960', title: 'Overtime assignment out of order',
  deadline: '2026-12-01', caseType: 'Pay', step: 'intake', status: 'active', updatedAt: '2026-11-10T12:00:00Z',
};
const filed = { id: 'u1', caseID: 'case-1', body: 'Filed with the employer.', createdAt: '2026-11-10T12:00:00Z' };

function app(userID: string, roles: string[], language: 'en' | 'es' = 'en') {
  return {
    mode: 'authenticated', session: { user: { id: userID } }, sessionRestricted: false, organizationID: 'org-a',
    authorizedRoles: roles, memberLanguage: language,
    dashboard: { member: { id: userID, chapterID: 'chapter-a', language }, cases: [] },
  };
}

let screen: Rendered | null = null;
afterEach(async () => {
  await screen?.unmount(); screen = null; setPlatform('ios');
  port.loadCaseDetail.mockReset(); port.rpc.mockReset(); port.reads = []; port.access = []; port.accessFails = false;
});

async function write(value: string) {
  const input = getExposed(screen!.container, 'Issue note');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => { clearHeldDrafts(); });
describe.each<'ios' | 'android'>(['ios', 'android'])('committee member issue note on %s', (os) => {
  it('adds a note to the assigned issue and shows it in the reloaded timeline', async () => {
    setPlatform(os);
    port.app = app(STEWARD, ['steward']);
    port.loadCaseDetail.mockResolvedValueOnce({ item: assigned, updates: [filed] });
    screen = await render(h(CaseDetailScreen));
    expect(port.loadCaseDetail).toHaveBeenLastCalledWith(STEWARD, 'case-1', true);
    expect(port.reads[0]).toEqual([['id', 'case-1'], ['steward_user_id', STEWARD]]);
    expect(screen.container.textContent).toContain('Add an issue note');

    const saved = { id: 'u2', caseID: 'case-1', body: 'Met the supervisor; Step 1 meeting set for Friday.', createdAt: '2026-11-18T17:00:00Z' };
    port.rpc.mockResolvedValueOnce({ data: { id: 'u2' }, error: null });
    port.loadCaseDetail.mockResolvedValueOnce({ item: assigned, updates: [filed, saved] });
    await write('  Met the supervisor; Step 1 meeting set for Friday.  ');
    await press(getExposed(screen.container, 'Save issue note'));

    expect(port.rpc).toHaveBeenCalledTimes(1);
    expect(port.rpc).toHaveBeenCalledWith('steward_add_case_note', {
      p_case_id: 'case-1', p_body: 'Met the supervisor; Step 1 meeting set for Friday.', p_occurred_on: null,
    });
    expect(port.loadCaseDetail).toHaveBeenCalledTimes(2);
    // Opening the member's case wrote viewed_case; the saved note writes
    // updated_case, as the website's steward case dialog does (#9120).
    expect(port.access).toEqual([['viewed_case', 'member-b'], ['updated_case', 'member-b']]);
    expect(screen.container.textContent).toContain('Issue note saved. It is in the issue timeline.');
    expect(screen.container.textContent).toContain('Met the supervisor; Step 1 meeting set for Friday.');
    expect((getExposed(screen.container, 'Issue note') as HTMLTextAreaElement).value).toBe('');
  });
});

it.each<'ios' | 'android'>(['ios', 'android'])('Refresh shows the saved note without a second history entry on %s', async (os) => {
  setPlatform(os);
  port.app = app(STEWARD, ['steward']);
  port.loadCaseDetail.mockResolvedValueOnce({ item: assigned, updates: [filed] });
  screen = await render(h(CaseDetailScreen));
  const saved = { id: 'u2', caseID: 'case-1', body: 'Step 1 meeting set for Friday.', createdAt: '2026-11-18T17:00:00Z' };
  port.rpc.mockResolvedValueOnce({ data: { id: 'u2' }, error: null });
  port.loadCaseDetail.mockRejectedValueOnce(new Error('Network request failed'));
  await write('Step 1 meeting set for Friday.');
  await press(getExposed(screen.container, 'Save issue note'));
  expect(screen.container.textContent).toContain('Issue note saved, but the issue timeline could not be updated.');
  expect(screen.container.textContent).not.toContain('It is in the issue timeline');
  expect(screen.container.textContent).toContain('Filed with the employer.');

  port.loadCaseDetail.mockResolvedValueOnce({ item: assigned, updates: [filed, saved] });
  await press(getExposed(screen.container, 'Refresh the issue'));
  expect(port.rpc).toHaveBeenCalledTimes(1);
  expect(port.loadCaseDetail).toHaveBeenCalledTimes(3);
  expect(screen.container.textContent).toContain('Issue note saved. It is in the issue timeline.');
  expect(screen.container.textContent).toContain('Step 1 meeting set for Friday.');
  expect(port.access).toEqual([['viewed_case', 'member-b'], ['updated_case', 'member-b']]);
});

// #9440 successor: a refusal code does not prove the note was not saved (a
// gateway can answer with it after a commit), so the note stays, locked as
// unconfirmed, and the screen does not reread.
it('keeps the draft locked as unconfirmed when the server answers with a refusal code', async () => {
  port.app = app(STEWARD, ['steward']);
  port.loadCaseDetail.mockResolvedValue({ item: assigned, updates: [filed] });
  screen = await render(h(CaseDetailScreen));
  port.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'issue not found or not yours' } });
  await write('Called the worker back.');
  await press(getExposed(screen.container, 'Save issue note'));
  expect(screen.container.textContent).toContain('We could not confirm this issue note was saved.');
  expect(screen.container.textContent).not.toContain('This issue is not assigned to you as committee member');
  expect(getExposed(screen.container, 'Save again')).toBeTruthy();
  expect((getExposed(screen.container, 'Issue note') as HTMLTextAreaElement).value).toBe('Called the worker back.');
  expect(port.loadCaseDetail).toHaveBeenCalledTimes(1);
});

it('sends nothing for an empty note', async () => {
  port.app = app(STEWARD, ['steward']);
  port.loadCaseDetail.mockResolvedValue({ item: assigned, updates: [] });
  screen = await render(h(CaseDetailScreen));
  await write('   ');
  await press(getExposed(screen.container, 'Save issue note'));
  expect(port.rpc).not.toHaveBeenCalled();
  expect(screen.container.textContent).toContain('Write a note of 1 to 4,000 characters.');
});

it.each([
  ['another committee member', 'steward-z', ['steward']],
  ['the worker who owns the issue', 'member-b', []],
  ['a campaign lead', 'coordinator-c', ['coordinator']],
])('offers no issue note to %s', async (_who, userID, roles) => {
  port.app = app(userID, roles);
  port.loadCaseDetail.mockResolvedValue({ item: assigned, updates: [filed] });
  screen = await render(h(CaseDetailScreen));
  expect(screen.container.textContent).toContain('Filed with the employer.');
  expect(screen.container.textContent).not.toContain('Add an issue note');
  // Only the steward hat asks whether the case is assigned to them.
  expect(port.reads.filter((filters) => filters.some(([column]) => column === 'steward_user_id'))).toHaveLength(roles.includes('steward') ? 1 : 0);
});

it('speaks Spanish for a Spanish profile', async () => {
  port.app = app(STEWARD, ['steward'], 'es');
  port.loadCaseDetail.mockResolvedValue({ item: assigned, updates: [] });
  screen = await render(h(CaseDetailScreen));
  expect(screen.container.textContent).toContain('Agregar una nota al asunto');
  expect(getExposed(screen.container, 'Guardar nota del asunto')).toBeTruthy();
  expect(getExposed(screen.container, 'Nota del asunto')).toBeTruthy();
});

it('says so when the saved note could not be logged in the worker\'s access history', async () => {
  port.app = app(STEWARD, ['steward']);
  port.loadCaseDetail.mockResolvedValue({ item: assigned, updates: [filed] });
  screen = await render(h(CaseDetailScreen));
  port.accessFails = true;
  port.rpc.mockResolvedValueOnce({ data: { id: 'u2' }, error: null });
  await write('Step 1 meeting set for Friday.');
  await press(getExposed(screen.container, 'Save issue note'));
  expect(port.access).toEqual([['viewed_case', 'member-b'], ['updated_case', 'member-b']]);
  expect(screen.container.textContent).toContain('The issue was saved, but its access-history entry could not be logged.');
  // The note itself was saved once and is not sent again.
  expect(port.rpc).toHaveBeenCalledTimes(1);
});

// Review R-9228, P2-2: a reread that succeeds without the saved note says only
// that it was saved, never that it is in the timeline.
it('does not claim the note is in the timeline when the reread does not hold it', async () => {
  port.app = app(STEWARD, ['steward']);
  port.loadCaseDetail.mockResolvedValue({ item: assigned, updates: [filed] });
  screen = await render(h(CaseDetailScreen));
  port.rpc.mockResolvedValueOnce({ data: { id: 'u1001' }, error: null });
  await write('Step 1 meeting set for Friday.');
  await press(getExposed(screen.container, 'Save issue note'));
  expect(port.loadCaseDetail).toHaveBeenCalledTimes(2);
  expect(screen.container.textContent).toContain('Issue note saved.');
  expect(screen.container.textContent).not.toContain('It is in the issue timeline');
});

// Review R-9228, P2-1: a reread that answers after the steward role was
// removed never puts the member's case back on screen.
it('drops a late reread after the committee member role is removed', async () => {
  port.app = app(STEWARD, ['steward']);
  port.loadCaseDetail.mockResolvedValueOnce({ item: assigned, updates: [filed] });
  screen = await render(h(CaseDetailScreen));
  let answer: (detail: MemberCaseDetail | null) => void = () => {};
  port.loadCaseDetail.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
  port.rpc.mockResolvedValueOnce({ data: { id: 'u2' }, error: null });
  await write('Step 1 meeting set for Friday.');
  await press(getExposed(screen.container, 'Save issue note'));
  // The role is removed while the reread is in flight; the member reload finds no case.
  port.loadCaseDetail.mockResolvedValueOnce(null);
  port.app = app(STEWARD, []);
  await screen.rerender(h(CaseDetailScreen));
  expect(screen.container.textContent).toContain('Issue not available');
  const saved = { id: 'u2', caseID: 'case-1', body: 'Step 1 meeting set for Friday.', createdAt: '2026-11-18T17:00:00Z' };
  await act(async () => { answer({ item: assigned, updates: [filed, saved] }); });
  expect(screen.container.textContent).toContain('Issue not available');
  expect(screen.container.textContent).not.toContain('Overtime assignment out of order');
  expect(screen.container.textContent).not.toContain('Filed with the employer.');
});

// As the website's caseload, which leaves out the steward's own cases.
it('offers no issue note on the committee member\'s own issue', async () => {
  port.app = app(STEWARD, ['steward']);
  port.loadCaseDetail.mockResolvedValue({ item: { ...assigned, ownerID: STEWARD }, updates: [filed] });
  screen = await render(h(CaseDetailScreen));
  expect(screen.container.textContent).toContain('Filed with the employer.');
  expect(screen.container.textContent).not.toContain('Add an issue note');
});

// Review R-9228b, P2-1: a reread held across a change of session or selection
// is dropped even when the values come back to what they were at the save,
// because the route's authorization generation only moves forward.
function scoped(userID = STEWARD, chapterID = 'chapter-a') {
  const sid = userID === STEWARD ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
  const token = `e30.${btoa(JSON.stringify({ session_id: sid }))}.sig`;
  return { ...app(userID, ['steward']), session: { user: { id: userID }, access_token: token }, chapterMemberships: [{ chapterID, selected: true }] };
}

async function saveWithHeldReread() {
  port.app = scoped();
  port.loadCaseDetail.mockResolvedValueOnce({ item: assigned, updates: [filed] });
  screen = await render(h(CaseDetailScreen));
  let answer: (detail: MemberCaseDetail | null) => void = () => {};
  port.loadCaseDetail.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
  port.rpc.mockResolvedValueOnce({ data: { id: 'u2' }, error: null });
  await write('Held note reread.');
  await press(getExposed(screen.container, 'Save issue note'));
  expect(port.loadCaseDetail).toHaveBeenCalledTimes(2);
  return async () => {
    await act(async () => { answer({ item: assigned, updates: [filed, { ...filed, id: 'u2', body: 'Held note reread.' }] }); });
  };
}

describe('a held reread across a session or selection change', () => {
  it('is dropped after sign-out and sign-in as another account', async () => {
    const release = await saveWithHeldReread();
    port.app = { ...scoped(), mode: 'signedOut', session: null };
    await screen!.rerender(h(CaseDetailScreen));
    port.loadCaseDetail.mockResolvedValueOnce(null);
    port.app = scoped('steward-other');
    await screen!.rerender(h(CaseDetailScreen));
    await release();
    expect(screen!.container.textContent).toContain('Issue not available');
  });

  it('is dropped after a campaign switch', async () => {
    const release = await saveWithHeldReread();
    port.loadCaseDetail.mockResolvedValueOnce(null);
    port.app = scoped(STEWARD, 'chapter-b');
    await screen!.rerender(h(CaseDetailScreen));
    await release();
    expect(screen!.container.textContent).toContain('Issue not available');
  });

  it('is dropped after the same session resumes through booting and a fresh read denies the issue', async () => {
    const release = await saveWithHeldReread();
    // Under 'booting' the app clears selection and live staff authority.
    port.app = { ...scoped(), mode: 'booting', authorizedRoles: [], dashboard: null, chapterMemberships: [] };
    await screen!.rerender(h(CaseDetailScreen));
    // Same user, sign-in, chapter and hat again; the fresh read no longer returns the case.
    port.loadCaseDetail.mockResolvedValueOnce(null);
    port.app = scoped();
    await screen!.rerender(h(CaseDetailScreen));
    expect(screen!.container.textContent).toContain('Issue not available');
    await release();
    expect(screen!.container.textContent).toContain('Issue not available');
    expect(screen!.container.textContent).not.toContain('Held note reread.');
  });

  it('is dropped after switching campaigns away and back', async () => {
    const release = await saveWithHeldReread();
    port.loadCaseDetail.mockResolvedValueOnce(null);
    port.app = scoped(STEWARD, 'chapter-b');
    await screen!.rerender(h(CaseDetailScreen));
    port.loadCaseDetail.mockResolvedValueOnce(null);
    port.app = scoped();
    await screen!.rerender(h(CaseDetailScreen));
    expect(screen!.container.textContent).toContain('Issue not available');
    await release();
    expect(screen!.container.textContent).toContain('Issue not available');
    expect(screen!.container.textContent).not.toContain('Held note reread.');
  });
});

// #9440 round 1 (record #9240 pull request E), on the real case screen and
// the real note card: a held note stays hidden through the session re-check,
// while the provider's reads are outstanding, and comes back only once they
// are confirmed and this route generation's assignment read is back.
describe.each<'ios' | 'android'>(['ios', 'android'])('a held committee member note through the session re-check on %s', (os) => {
  it('stays hidden until the session re-check returns', async () => {
    setPlatform(os);
    const flush = () => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    const signedIn = { ...app(STEWARD, ['steward']), chapterMemberships: [{ chapterID: 'chapter-a', organizationID: 'org-a', selected: true }], resumeDraftReads: { dashboard: true, memberships: true, staff: true } };
    port.app = signedIn;
    port.loadCaseDetail.mockResolvedValue({ item: assigned, updates: [filed] });
    screen = await render(h(CaseDetailScreen)); await flush();
    await write('Held through the check.');
    port.app = { ...signedIn, mode: 'booting', dashboard: null, authorizedRoles: [], resumeDraftReads: { dashboard: false, memberships: false, staff: false } };
    await screen.rerender(h(CaseDetailScreen)); await flush();
    expect(screen.container.innerHTML).not.toContain('Held through the check.');
    port.app = { ...signedIn, resumeDraftReads: { dashboard: false, memberships: false, staff: false } };
    await screen.rerender(h(CaseDetailScreen)); await flush();
    expect(screen.container.querySelector('textarea[aria-label="Issue note"]')).toBeNull();
    expect(screen.container.innerHTML).not.toContain('Held through the check.');
    port.app = signedIn;
    await screen.rerender(h(CaseDetailScreen)); await flush();
    expect((getExposed(screen.container, 'Issue note') as HTMLTextAreaElement).value).toBe('Held through the check.');
    expect(port.rpc).not.toHaveBeenCalled();
  });
});
