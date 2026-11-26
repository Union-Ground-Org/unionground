import { stubSessionWriter } from '../testing/stubSessionWriter';
// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHeldDrafts } from '../testing/retainedDraftHarness';
import { press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import type { MemberCase, MemberCaseDetail } from '../models/member';
import palette from '../theme/palette.json';
import { CASE_UPDATE_NOT_LOGGED, CASE_VIEW_NOT_LOGGED } from '../services/caseAccessHistory';

// BUG-UG-NATIVE-STAFF-CASE-ACCESS-NEVER-RECORDED-IN-MEMBER-ACCESS-HISTORY-20261118
// (#9120): a steward or coordinator who opens or changes another member's case
// on the phone leaves the website's access-history entries; their own case
// leaves none. The access-history write runs for real against a fake backend,
// so the RPC name and arguments checked here are the ones the server receives.
type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };
const port = vi.hoisted(() => ({
  app: {} as Record<string, unknown>,
  loadCaseDetail: vi.fn<(userID: string, caseID: string, staff: boolean) => Promise<MemberCaseDetail | null>>(),
  rpc: vi.fn<(name: string, args: Record<string, unknown>) => Promise<RpcResult>>(),
  attachment: null as null | { canWrite: boolean; onChanged?: () => void },
}));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('expo-crypto', () => ({ randomUUID: () => `attempt-${Math.random().toString(36).slice(2)}` }));
vi.mock('../components/ui', async () => {
  const ui = await import('../testing/uiStandIn');
  return {
    ...ui,
    StatusPill: ({ label }: { label: string }) => h('span', null, label),
    StateMessage: ({ title, body, action }: { title: string; body?: string; action?: ReactNode }) => h('section', null, title, body, action),
  };
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
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: { user: { id: string } } | null) => stubSessionWriter(() => ({ rpc: port.rpc }), session?.user.id ?? 'signed-out'),
  loadCaseDetail: port.loadCaseDetail,
  getSupabaseClient: () => ({ rpc: port.rpc }),
}));
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: ({ children }: { children?: ReactNode }) => h('div', null, children) }));
// The panel's own upload and removal paths call onChanged after a write
// succeeds (AttachmentPanel.test.ts); here a button stands in for that write.
vi.mock('../components/AttachmentPanel', () => ({
  AttachmentPanel: (props: { canWrite: boolean; onChanged?: () => void }) => {
    port.attachment = props;
    return props.canWrite ? h('button', { 'aria-label': 'Attach an issue document', onClick: () => props.onChanged?.() }, 'Attach') : null;
  },
}));
vi.mock('../components/CompassCaseHelp', () => ({ CompassCaseHelp: () => null }));
vi.mock('./CaseRowTopicCards', () => ({ CaseRowTopicCard: () => null }));
// #9098 part 2: the coordinator's steward assignment calls onSaved after
// assign_member_case succeeds (CaseStewardAssignment.test.ts); here a button
// stands in for that save.
vi.mock('./CaseStewardAssignment', () => ({
  CaseStewardAssignment: (props: { onSaved?: () => void }) => h('button', { 'aria-label': 'Save assignment', onClick: () => props.onSaved?.() }, 'Save assignment'),
}));

const { default: CaseDetailScreen } = await import('../../app/issue/[id]');

const ORG = 'org-tamarack';
function caseRow(ownerID: string, updatedAt = '2026-11-10T12:00:00Z'): MemberCase {
  return {
    id: 'case-1', reference: 'GR-2026-41960', title: 'Overtime assignment out of order', deadline: '2026-12-01',
    caseType: 'Pay', step: 'filed', status: 'active', updatedAt, ownerID,
  };
}
function detail(row: MemberCase): MemberCaseDetail {
  return { item: row, updates: [{ id: 'u1', caseID: 'case-1', body: 'Filed with the employer.', createdAt: '2026-11-10T12:00:00Z' }] } as MemberCaseDetail;
}
function app(userID: string, roles: string[], row: MemberCase, organizationID: string | null = ORG, extra: {
  accessToken?: string; chapterID?: string; language?: 'en' | 'es';
} = {}) {
  const language = extra.language ?? 'en';
  return {
    mode: 'authenticated', session: { user: { id: userID }, access_token: extra.accessToken }, sessionRestricted: false,
    authorizedRoles: roles, memberLanguage: language, organizationID,
    chapterMemberships: [{ chapterID: extra.chapterID ?? 'chapter-a', selected: true }],
    dashboard: { member: { id: userID, chapterID: extra.chapterID ?? 'chapter-a', language }, cases: [row] },
  };
}
// An access token whose payload carries this sign-in's session_id; `issued`
// stands in for a refreshed token of the same sign-in.
function token(sessionID: string, issued = 1) {
  const payload = Buffer.from(JSON.stringify({ session_id: sessionID, iat: issued })).toString('base64url');
  return `header.${payload}.signature`;
}
const SIGN_IN_1 = '11111111-1111-4111-8111-111111111111';
const SIGN_IN_2 = '22222222-2222-4222-8222-222222222222';
function entry(action: 'viewed_case' | 'updated_case', subject = 'member-b') {
  return ['record_member_access_event', {
    p_expected_organization_id: ORG, p_subject_user_id: subject, p_action: action, p_entity_type: 'case', p_entity_id: 'case-1',
  }];
}
const ok: RpcResult = { data: 'event-1', error: null };
const refused: RpcResult = { data: null, error: { code: 'P0001', message: 'refused' } };
const tryAgain = (screen: Rendered) => screen.container.querySelector('[aria-label="Try again"]');
const attach = (screen: Rendered) => screen.container.querySelector('[aria-label="Attach an issue document"]');
const saveAssignment = (screen: Rendered) => screen.container.querySelector('[aria-label="Save assignment"]');

let screen: Rendered | null = null;
beforeEach(() => { clearHeldDrafts(); });
beforeEach(() => {
  port.rpc.mockReset().mockResolvedValue(ok);
  port.loadCaseDetail.mockReset();
  port.attachment = null;
});
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); });

describe.each<'ios' | 'android'>(['ios', 'android'])('staff issue access history on %s', (os) => {
  beforeEach(() => { setPlatform(os); });

  it('records one viewed_case when a committee member opens another worker\'s issue, and none on a reload of the same opening', async () => {
    const row = caseRow('member-b');
    port.loadCaseDetail.mockResolvedValue(detail(row));
    port.app = app('steward-a', ['steward'], row);
    screen = await render(h(CaseDetailScreen));
    expect(port.loadCaseDetail).toHaveBeenLastCalledWith('steward-a', 'case-1', true);
    expect(port.rpc.mock.calls).toEqual([entry('viewed_case')]);
    expect(screen.container.textContent).toContain('Filed with the employer.');
    // A dashboard refresh replaces the row: the case reloads, the opening does not repeat.
    const refreshed = caseRow('member-b', '2026-11-13T12:00:00Z');
    port.app = app('steward-a', ['steward'], refreshed);
    await screen.rerender(h(CaseDetailScreen));
    await screen.rerender(h(CaseDetailScreen));
    expect(port.loadCaseDetail).toHaveBeenCalledTimes(2);
    expect(port.rpc).toHaveBeenCalledTimes(1);
    // The steward hat cannot attach case documents on the phone today.
    expect(port.attachment?.canWrite).toBe(false);
  });

  it('records viewed_case on open and updated_case after a campaign lead attaches an issue document', async () => {
    const row = caseRow('member-b');
    port.loadCaseDetail.mockResolvedValue(detail(row));
    port.app = app('coordinator-a', ['coordinator'], row);
    screen = await render(h(CaseDetailScreen));
    expect(port.rpc.mock.calls).toEqual([entry('viewed_case')]);
    await press(attach(screen)!);
    expect(port.rpc.mock.calls).toEqual([entry('viewed_case'), entry('updated_case')]);
    expect(screen.container.textContent).not.toContain(CASE_UPDATE_NOT_LOGGED);
  });

  it('records updated_case after a campaign lead changes the committee member, says so when it could not, and writes it on Try again', async () => {
    const row = caseRow('member-b');
    port.loadCaseDetail.mockResolvedValue(detail(row));
    port.app = app('coordinator-a', ['coordinator'], row);
    screen = await render(h(CaseDetailScreen));
    await press(saveAssignment(screen)!);
    expect(port.rpc.mock.calls).toEqual([entry('viewed_case'), entry('updated_case')]);
    expect(screen.container.textContent).not.toContain(CASE_UPDATE_NOT_LOGGED);
    port.rpc.mockResolvedValueOnce(refused);
    await press(saveAssignment(screen)!);
    expect(screen.container.textContent).toContain(CASE_UPDATE_NOT_LOGGED);
    await press(tryAgain(screen)!);
    expect(port.rpc.mock.calls).toEqual([entry('viewed_case'), entry('updated_case'), entry('updated_case'), entry('updated_case')]);
    expect(screen.container.textContent).not.toContain(CASE_UPDATE_NOT_LOGGED);
  });

  it('shows the committee member assignment to the campaign lead hat only', async () => {
    const row = caseRow('member-b');
    port.loadCaseDetail.mockResolvedValue(detail(row));
    port.app = app('steward-a', ['steward'], row);
    screen = await render(h(CaseDetailScreen));
    expect(saveAssignment(screen)).toBeNull();
  });

  it('says so when the updated_case entry could not be written, and writes it on Try again', async () => {
    const row = caseRow('member-b');
    port.loadCaseDetail.mockResolvedValue(detail(row));
    port.app = app('coordinator-a', ['coordinator'], row);
    screen = await render(h(CaseDetailScreen));
    port.rpc.mockResolvedValueOnce(refused);
    await press(attach(screen)!);
    expect(screen.container.textContent).toContain(CASE_UPDATE_NOT_LOGGED);
    await press(tryAgain(screen)!);
    expect(port.rpc.mock.calls).toEqual([entry('viewed_case'), entry('updated_case'), entry('updated_case')]);
    expect(screen.container.textContent).not.toContain(CASE_UPDATE_NOT_LOGGED);
  });

  it('keeps the issue closed when its viewed_case entry could not be written, and opens it once Try again writes it', async () => {
    const row = caseRow('member-b');
    port.loadCaseDetail.mockResolvedValue(detail(row));
    port.app = app('steward-a', ['steward'], row);
    port.rpc.mockResolvedValueOnce(refused);
    screen = await render(h(CaseDetailScreen));
    expect(screen.container.textContent).toContain(CASE_VIEW_NOT_LOGGED);
    expect(screen.container.textContent).not.toContain('Filed with the employer.');
    await press(tryAgain(screen)!);
    expect(port.rpc.mock.calls).toEqual([entry('viewed_case'), entry('viewed_case')]);
    expect(screen.container.textContent).toContain('Filed with the employer.');
  });

  it('writes nothing and keeps the issue closed when the session has no organization', async () => {
    const row = caseRow('member-b');
    port.loadCaseDetail.mockResolvedValue(detail(row));
    port.app = app('steward-a', ['steward'], row, null);
    screen = await render(h(CaseDetailScreen));
    expect(port.rpc).not.toHaveBeenCalled();
    expect(screen.container.textContent).toContain(CASE_VIEW_NOT_LOGGED);
  });

  it.each([['steward'], ['coordinator']])('writes no entry when a %s opens or changes their own issue', async (role) => {
    const row = caseRow('staff-a');
    port.loadCaseDetail.mockResolvedValue(detail(row));
    port.app = app('staff-a', [role], row);
    screen = await render(h(CaseDetailScreen));
    expect(screen.container.textContent).toContain('Filed with the employer.');
    await press(attach(screen)!);
    expect(port.rpc).not.toHaveBeenCalled();
    expect(screen.container.textContent).not.toContain(CASE_UPDATE_NOT_LOGGED);
  });

  // Review R-9204 finding 3: the entry belongs to one person, sign-in,
  // organization and chapter. A retained screen that comes back for another
  // one hides the case until that one's own entry is written.
  it('hides a retained issue from another staff member until their own viewed_case is written', async () => {
    const row = caseRow('member-b');
    port.loadCaseDetail.mockResolvedValue(detail(row));
    port.app = app('coordinator-a', ['coordinator'], row);
    screen = await render(h(CaseDetailScreen));
    expect(screen.container.textContent).toContain('Filed with the employer.');
    let release!: (result: RpcResult) => void;
    port.rpc.mockReturnValueOnce(new Promise<RpcResult>((resolve) => { release = resolve; }));
    port.app = app('coordinator-c', ['coordinator'], row);
    await screen.rerender(h(CaseDetailScreen));
    expect(port.loadCaseDetail).toHaveBeenLastCalledWith('coordinator-c', 'case-1', true);
    expect(screen.container.textContent).not.toContain('Filed with the employer.');
    expect(screen.container.textContent).not.toContain('Overtime assignment out of order');
    await act(async () => release(ok));
    expect(port.rpc.mock.calls).toEqual([entry('viewed_case'), entry('viewed_case')]);
    expect(screen.container.textContent).toContain('Filed with the employer.');
  });

  it('writes a new viewed_case for a new sign-in or another campaign, and none for a token refresh', async () => {
    const row = caseRow('member-b');
    port.loadCaseDetail.mockResolvedValue(detail(row));
    port.app = app('steward-a', ['steward'], row, ORG, { accessToken: token(SIGN_IN_1, 1) });
    screen = await render(h(CaseDetailScreen));
    expect(port.rpc).toHaveBeenCalledTimes(1);
    port.app = app('steward-a', ['steward'], row, ORG, { accessToken: token(SIGN_IN_1, 2) });
    await screen.rerender(h(CaseDetailScreen));
    expect(port.rpc).toHaveBeenCalledTimes(1);
    port.app = app('steward-a', ['steward'], row, ORG, { accessToken: token(SIGN_IN_2, 1) });
    await screen.rerender(h(CaseDetailScreen));
    expect(port.rpc).toHaveBeenCalledTimes(2);
    port.app = app('steward-a', ['steward'], row, ORG, { accessToken: token(SIGN_IN_2, 1), chapterID: 'chapter-b' });
    await screen.rerender(h(CaseDetailScreen));
    expect(port.rpc.mock.calls).toEqual([entry('viewed_case'), entry('viewed_case'), entry('viewed_case')]);
    expect(screen.container.textContent).toContain('Filed with the employer.');
  });

  // Finding 4: one Try again write at a time, so one change is one entry.
  it('sends one updated_case write when Try again is pressed twice while the first is pending', async () => {
    const row = caseRow('member-b');
    port.loadCaseDetail.mockResolvedValue(detail(row));
    port.app = app('coordinator-a', ['coordinator'], row);
    screen = await render(h(CaseDetailScreen));
    port.rpc.mockResolvedValueOnce(refused);
    await press(attach(screen)!);
    let release!: (result: RpcResult) => void;
    port.rpc.mockReturnValueOnce(new Promise<RpcResult>((resolve) => { release = resolve; }));
    const retry = tryAgain(screen)!;
    await press(retry);
    await press(retry);
    expect(tryAgain(screen)?.getAttribute('aria-disabled')).toBe('true');
    await act(async () => release(ok));
    expect(port.rpc.mock.calls).toEqual([entry('viewed_case'), entry('updated_case'), entry('updated_case')]);
    expect(screen.container.textContent).not.toContain(CASE_UPDATE_NOT_LOGGED);
  });

  it('a retired receipt retry cannot clear the replacement account’s pending retry', async () => {
    const row = caseRow('member-b');
    port.loadCaseDetail.mockResolvedValue(detail(row));
    port.app = app('coordinator-a', ['coordinator'], row);
    screen = await render(h(CaseDetailScreen));
    port.rpc.mockResolvedValueOnce(refused);
    await press(attach(screen)!);
    let finishA!: (result: RpcResult) => void;
    port.rpc.mockReturnValueOnce(new Promise<RpcResult>((resolve) => { finishA = resolve; }));
    await press(tryAgain(screen)!);
    port.app = app('coordinator-c', ['coordinator'], row);
    await screen.rerender(h(CaseDetailScreen));
    port.rpc.mockResolvedValueOnce(refused);
    await press(attach(screen)!);
    let finishB!: (result: RpcResult) => void;
    port.rpc.mockReturnValueOnce(new Promise<RpcResult>((resolve) => { finishB = resolve; }));
    await press(tryAgain(screen)!);
    expect(typeof finishB).toBe('function');
    await act(async () => { finishA(ok); });
    expect(tryAgain(screen)?.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { finishB(ok); });
    expect(screen.container.textContent).not.toContain(CASE_UPDATE_NOT_LOGGED);
    expect(port.rpc.mock.calls.filter(([, args]) => args.p_action === 'updated_case')).toHaveLength(4);
  });

  it('records an accepted business write once but never rereads from an unmounted issue', async () => {
    const row = caseRow('member-b');
    port.loadCaseDetail.mockResolvedValue(detail(row));
    port.app = app('coordinator-a', ['coordinator'], row);
    screen = await render(h(CaseDetailScreen));
    const acknowledged = port.attachment!.onChanged!;
    await screen.unmount(); screen = null;
    port.loadCaseDetail.mockClear();
    await act(async () => { acknowledged(); });
    expect(port.loadCaseDetail).not.toHaveBeenCalled();
    expect(port.rpc.mock.calls).toEqual([entry('viewed_case'), entry('updated_case')]);
  });

  // Finding 6: the new messages and their Try again read in Spanish for a Spanish account.
  it('says a refused viewed_case or updated_case entry in Spanish for a Spanish account', async () => {
    const row = caseRow('member-b');
    port.loadCaseDetail.mockResolvedValue(detail(row));
    port.app = app('coordinator-a', ['coordinator'], row, ORG, { language: 'es' });
    port.rpc.mockResolvedValueOnce(refused);
    screen = await render(h(CaseDetailScreen));
    expect(screen.container.textContent).toContain('Este registro no se puede abrir porque no se pudo registrar el acceso. Vuelva a intentarlo.');
    expect(screen.container.textContent).not.toContain(CASE_VIEW_NOT_LOGGED);
    await press(screen.container.querySelector('[aria-label="Reintentar"]')!);
    expect(screen.container.textContent).toContain('Filed with the employer.');
    port.rpc.mockResolvedValueOnce(refused);
    await press(attach(screen)!);
    expect(screen.container.textContent).toContain('El asunto se guardó, pero no se pudo registrar su entrada en el historial de acceso. Vuelva a intentarlo antes de hacer otro cambio.');
    expect(screen.container.textContent).not.toContain(CASE_UPDATE_NOT_LOGGED);
    expect(screen.container.querySelector('[aria-label="Reintentar"]')).not.toBeNull();
  });

  it('writes no entry for a worker opening and changing their own issue', async () => {
    const row = caseRow('member-a');
    port.loadCaseDetail.mockResolvedValue(detail(row));
    port.app = app('member-a', [], row);
    screen = await render(h(CaseDetailScreen));
    expect(port.loadCaseDetail).toHaveBeenLastCalledWith('member-a', 'case-1', false);
    await press(attach(screen)!);
    expect(port.attachment?.onChanged).toBeUndefined();
    expect(port.rpc).not.toHaveBeenCalled();
  });
});
