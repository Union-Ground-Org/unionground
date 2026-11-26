// @vitest-environment jsdom
import { createElement as h, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { clearHeldDrafts } from '../testing/retainedDraftHarness';
import { getExposed, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import type { MemberCase, MemberCaseDetail } from '../models/member';
import palette from '../theme/palette.json';
import { stubSessionWriter } from '../testing/stubSessionWriter';

// BUG-UG-NATIVE-IOS-STEWARD-CANNOT-WORK-AN-ASSIGNED-CASE-20261117
// (#9091), part 4: who gets the coordinator's case writes on the phone case
// screen: the coordinator hat only, as on the website's coordinator case
// panel. The card itself has its own test (CoordinatorCaseWritesCard.test.tsx).
const port = vi.hoisted(() => ({
  app: {} as Record<string, unknown>,
  loadCaseDetail: vi.fn<(userID: string, caseID: string, staff: boolean) => Promise<MemberCaseDetail | null>>(),
  rpc: vi.fn(),
  reads: [] as [string, string][][],
  access: [] as string[],
  accessFails: false,
  shown: null as boolean | null,
}));
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
// #9120 access-history entries the screen writes; every other routine goes to port.rpc.
function rpc(name: string, args: Record<string, unknown>) {
  if (name !== 'record_member_access_event') return port.rpc(name, args);
  port.access.push(String(args.p_action));
  return Promise.resolve({ data: null, error: port.accessFails ? { code: '57014', message: 'timeout' } : null });
}
vi.mock('../services/supabase', () => ({
  captureSessionWriter: (session: { user: { id: string } } | null) => stubSessionWriter(() => ({ rpc, from }), session?.user.id ?? 'signed-out'),
  loadCaseDetail: port.loadCaseDetail,
  getSupabaseClient: () => ({ rpc, from }),
}));
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: ({ children }: { children?: ReactNode }) => h('div', null, children) }));
vi.mock('../components/AttachmentPanel', () => ({ AttachmentPanel: () => null }));
vi.mock('../components/CompassCaseHelp', () => ({ CompassCaseHelp: () => null }));
vi.mock('./CaseRowTopicCards', () => ({ CaseRowTopicCard: () => null }));
// The stand-in card offers one button that reports a saved write, so the
// screen's after-write step can be checked without the real card.
vi.mock('./CoordinatorCaseWritesCard', () => ({
  CoordinatorCaseWritesCard: ({ caseID, onChanged }: { caseID: string; onChanged: () => Promise<unknown> }) => h('section', null,
    `Campaign lead writes for ${caseID}`,
    h('button', { 'aria-label': 'Report a saved campaign lead write', onClick: () => { void onChanged().then((reread) => { port.shown = reread !== null; }); } }, 'saved'),
  ),
}));
vi.mock('./StewardCaseNoteCard', () => ({ StewardCaseNoteCard: () => null }));

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
  port.loadCaseDetail.mockReset(); port.rpc.mockReset(); port.reads = []; port.access = []; port.accessFails = false; port.shown = null;
});

beforeEach(() => { clearHeldDrafts(); });
describe.each<'ios' | 'android'>(['ios', 'android'])('campaign lead issue writes on %s', (os) => {
  it.each([
    ['a campaign lead', 'coordinator-c', ['coordinator'], true],
    ['the assigned committee member', STEWARD, ['steward'], false],
    ['the worker who owns the issue', 'member-b', [], false],
  ])('shows them to %s: %s', async (_who, userID, roles, shown) => {
    setPlatform(os);
    port.app = app(userID as string, roles as string[]);
    port.loadCaseDetail.mockResolvedValue({ item: assigned, updates: [filed] });
    screen = await render(h(CaseDetailScreen));
    expect(screen.container.textContent).toContain('Filed with the employer.');
    expect(screen.container.textContent.includes('Campaign lead writes for case-1')).toBe(shown);
  });
});

it('logs a campaign lead write in the worker\'s access history, then rereads the issue', async () => {
  port.app = app('coordinator-c', ['coordinator']);
  port.loadCaseDetail.mockResolvedValue({ item: assigned, updates: [filed] });
  screen = await render(h(CaseDetailScreen));
  await press(getExposed(screen.container, 'Report a saved campaign lead write'));
  // As the website's coordinator case panel does after each write (#9120).
  expect(port.access).toEqual(['viewed_case', 'updated_case']);
  expect(port.loadCaseDetail).toHaveBeenCalledTimes(2);
  expect(port.shown).toBe(true);
  expect(screen.container.textContent).not.toContain('its access-history entry could not be logged');
});

it('says so on the issue screen when the write could not be logged', async () => {
  port.app = app('coordinator-c', ['coordinator']);
  port.loadCaseDetail.mockResolvedValue({ item: assigned, updates: [filed] });
  screen = await render(h(CaseDetailScreen));
  port.accessFails = true;
  await press(getExposed(screen.container, 'Report a saved campaign lead write'));
  expect(port.access).toEqual(['viewed_case', 'updated_case']);
  expect(screen.container.textContent).toContain('The issue was saved, but its access-history entry could not be logged.');
});
