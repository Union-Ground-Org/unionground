import { stubSessionWriter } from '../testing/stubSessionWriter';
// @vitest-environment jsdom
import { createElement as h, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { clearHeldDrafts } from '../testing/retainedDraftHarness';
import { render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import type { MemberCase, MemberCaseDetail } from '../models/member';
import palette from '../theme/palette.json';

// Gate round 1 on #8693 (P1): the case screen reloads its detail when a
// dashboard refresh replaces this case's row. AppProvider.refresh changes
// neither the mode nor the account, so the dashboard row is the only signal a
// retained case route has that its status, deadline or timeline moved.
const port = vi.hoisted(() => ({
  app: {} as Record<string, unknown>,
  loadCaseDetail: vi.fn<(userID: string, caseID: string, staff: boolean) => Promise<MemberCaseDetail | null>>(),
}));
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
vi.mock('../services/supabase', () => ({ captureSessionWriter: () => stubSessionWriter(() => null), loadCaseDetail: port.loadCaseDetail }));
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: ({ children }: { children?: ReactNode }) => h('div', null, children) }));
vi.mock('../components/AttachmentPanel', () => ({ AttachmentPanel: () => null }));
vi.mock('../components/CompassCaseHelp', () => ({ CompassCaseHelp: () => null }));
vi.mock('./CaseRowTopicCards', () => ({ CaseRowTopicCard: () => null }));
vi.mock('./CoordinatorCaseWritesCard', () => ({ CoordinatorCaseWritesCard: () => null }));

const { default: CaseDetailScreen } = await import('../../app/issue/[id]');

function caseRow(deadline: string, updatedAt: string): MemberCase {
  return {
    id: 'case-1', reference: 'GR-2026-41960', title: 'Overtime assignment out of order', deadline,
    caseType: 'Pay', step: 'filed', status: 'active', updatedAt,
  };
}

function app(row: MemberCase) {
  return {
    mode: 'authenticated', session: { user: { id: 'member-a' } }, sessionRestricted: false,
    authorizedRoles: [], memberLanguage: 'en',
    dashboard: { member: { id: 'member-a', chapterID: 'chapter-a', language: 'en' }, cases: [row] },
  };
}

let screen: Rendered | null = null;
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); port.loadCaseDetail.mockReset(); });

beforeEach(() => { clearHeldDrafts(); });
describe.each<'ios' | 'android'>(['ios', 'android'])('issue detail on %s', (os) => {
  it('reloads the issue after a dashboard refresh replaces its row', async () => {
    setPlatform(os);
    const first = caseRow('2026-12-01', '2026-11-10T12:00:00Z');
    port.loadCaseDetail.mockResolvedValueOnce({ item: first, updates: [{ id: 'u1', caseID: 'case-1', body: 'Filed with the employer.', createdAt: '2026-11-10T12:00:00Z' }] });
    port.app = app(first);
    screen = await render(h(CaseDetailScreen));
    expect(port.loadCaseDetail).toHaveBeenCalledTimes(1);
    expect(screen.container.textContent).toContain('Filed with the employer.');
    expect(screen.container.textContent).not.toContain('Step 1 meeting scheduled.');

    // A successful refresh brings a new row for the same case: same mode,
    // same account, same route.
    const refreshed = caseRow('2026-12-15', '2026-11-13T12:00:00Z');
    port.loadCaseDetail.mockResolvedValueOnce({
      item: refreshed,
      updates: [
        { id: 'u2', caseID: 'case-1', body: 'Step 1 meeting scheduled.', createdAt: '2026-11-13T12:00:00Z' },
        { id: 'u1', caseID: 'case-1', body: 'Filed with the employer.', createdAt: '2026-11-10T12:00:00Z' },
      ],
    });
    port.app = app(refreshed);
    await screen.rerender(h(CaseDetailScreen));
    await screen.rerender(h(CaseDetailScreen));
    expect(port.loadCaseDetail).toHaveBeenCalledTimes(2);
    expect(port.loadCaseDetail).toHaveBeenLastCalledWith('member-a', 'case-1', false);
    expect(screen.container.textContent).toContain('Step 1 meeting scheduled.');
  });
});
