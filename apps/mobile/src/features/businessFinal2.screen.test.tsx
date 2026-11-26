// @vitest-environment jsdom
// Family 1 (finance/settings) of part B, record 9254: extracted without changing assertions from businessFinal2.screen.test.tsx
// at e3e2edf61c6383a861124363beb7cdd770b5d3ad. Only Part B families retained; all selected cases keep their original assertions. Part A cases already shipped independently.
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exposedNames, getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import { stubSessionWriter } from '../testing/stubSessionWriter';
import palette from '../theme/palette.json';
import { buildNativeQaActor, qaText } from '../lib/mi1QaShared';
import { notificationPreferencesCopy, notificationPreferencesFromRow } from '../lib/notificationPreferences';
import { learningPeriodText as lp } from '../lib/learningPeriodCopy';
import { createLearningPeriodApi } from '../../../../src/features/learningPeriod/api.js';

const port = vi.hoisted(() => ({
  phase: 'ready', proof: 'current' as 'current' | 'unavailable', chapter: 'chapter-a', token: 'fixture-a', used: false, serial: 0, topicShown: false, qaRows: false,
  asks: [] as Record<string, unknown>[], waits: [] as Promise<void>[], wait: null as Promise<void> | null,
  announce: () => () => {},
  rpc: vi.fn<(name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: null }>>(),
}));
const client = { rpc: port.rpc };
const sessions = new Map<string, { user: { id: string }; access_token: string }>();
function context() {
  const ready = port.phase === 'ready';
  if (!sessions.has(port.token)) sessions.set(port.token, { user: { id: 'person-a' }, access_token: port.token });
  return { mode: ready ? 'authenticated' : 'booting', session: sessions.get(port.token)!,
    organizationID: ready ? 'org-a' : null, dashboard: ready ? { member: { id: 'person-a', chapterID: port.chapter, language: 'en' } } : null,
    chapterMemberships: ready ? [{ chapterID: port.chapter, selected: true }] : [], authorizedRoles: ready ? ['admin'] : [],
    memberLanguage: 'en', resumeDraftReads: { dashboard: ready, memberships: ready, staff: ready } };
}
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../components/ui', () => import('../testing/uiStandIn'));
vi.mock('../state/AppProvider', () => ({ useApp: context }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../services/haptics', () => ({ haptics: { success: vi.fn(async () => {}), warning: vi.fn(async () => {}), select: vi.fn(async () => {}) } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `00000000-0000-4000-8000-${String(++port.serial).padStart(12, '0')}` }));
vi.mock('../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => port.announce, queueAccessibilityAnnouncement: vi.fn() }));
vi.mock('./ContextualPulseCard', () => ({ ContextualPulseCard: () => null, useNativeContextualPulse: () => ({ onScrollProgress: () => {} }) }));
vi.mock('../services/caseRowTopic', () => ({
  loadCaseRowTopic: async () => ({ canChange: true, shown: port.topicShown, chapterShown: false }),
  loadChapterCaseRowTopic: async () => ({ canChange: true, enabled: port.topicShown }),
  saveCaseRowTopic: async () => { if (port.wait) await port.wait; port.topicShown = true; },
  saveChapterCaseRowTopic: async () => { if (port.wait) await port.wait; port.topicShown = true; },
}));
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return { useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]), useRouter: () => ({ push: vi.fn() }) };
});
vi.mock('../services/supabase', () => ({
  getSupabaseClient: () => client,
  captureSessionWriter: (session: { user?: { id?: string } } | null) => ({ ...stubSessionWriter(() => client, session?.user?.id ?? 'signed-out'), check: async () => port.proof }),
  createCapturedSessionRpcClient: () => client,
  loadMemberNotificationPreferences: async () => notificationPreferencesFromRow({}),
  saveMemberNotificationPreferences: async () => { if (port.wait) await port.wait; return notificationPreferencesFromRow({ dnd_enabled: true }); },
}));
import { MemberQaScreen } from './mi1/MemberQaScreen';
import { NotificationPreferencesCard } from './NotificationPreferencesCard';
import { NativeLearningPeriodCard, NativePracticeHistory } from './NativeLearningPeriod';

let view: Rendered | null = null;
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const releases = new Set<() => void>();
const deferred = () => { let release = () => {}; const promise = new Promise<void>(resolve => { release = resolve; }); releases.add(release); return { promise, release }; };
function actor() { return buildNativeQaActor({ userId: 'person-a', organizationId: 'org-a', chapterId: port.chapter, authenticated: true, mfaSatisfied: true }); }
function period() {
  return { organizationId: 'org-a', used: port.used, running: port.used, periodId: port.used ? 'period-a' : null,
    lengthDays: 14, startsAt: null, endsAt: port.used ? '2026-12-01T12:00:00Z' : null, endAt: port.used ? '2026-12-01T12:00:00Z' : null,
    endedEarlyAt: null, closedAt: null, isAdmin: true };
}
beforeEach(() => {
  Object.assign(port, { phase: 'ready', proof: 'current' as 'current' | 'unavailable', chapter: 'chapter-a', token: 'fixture-a', used: false, serial: 0, topicShown: false, qaRows: false, asks: [], waits: [], wait: null });
  port.rpc.mockClear();
  port.rpc.mockImplementation(async (name, args = {}) => {
    if (name === 'ask_member_qa_question' || name === 'reply_member_qa_follow_up') {
      const index = port.asks.length; port.asks.push(args); if (port.waits[index]) await port.waits[index];
      return { data: { id: `question-${index}`, title: String(args.p_title), body: String(args.p_body), replies: [] }, error: null };
    }
    if (name === 'list_member_qa_questions' && port.qaRows) return { data: [{ id: '11111111-1111-4111-8111-111111111111', title: 'Question for campaign B', body: 'Question details', status: 'open', upvoteCount: 0, votedByMe: false, authorDisplayName: 'Worker', replyCount: 0, officialReplyCount: 0, chapterId: port.chapter, authorId: 'person-a', authoredByMe: true, replies: [] }], error: null };
    if (name === 'get_member_qa_question') return { data: { id: '11111111-1111-4111-8111-111111111111', chapterId: port.chapter, title: 'Question for campaign B', body: 'Details for the new campaign.', authoredByMe: true, authorId: 'person-a', replies: [], authorDisplayName: 'Worker', status: 'open', upvoteCount: 0, votedByMe: false, replyCount: 0, officialReplyCount: 0 }, error: null };
    if (name === 'get_organization_learning_period') return { data: period(), error: null };
    if (name === 'start_organization_learning_period') { if (port.wait) await port.wait; port.used = true; return { data: period(), error: null }; }
    if (name === 'end_organization_learning_period_early') { if (port.wait) await port.wait; port.used = false; return { data: period(), error: null }; }
    if (name === 'list_my_learning_history') return { data: { running: true, entries: [{ id: 'entry-a', actionKind: 'task_edit', domain: 'tasks', disposition: 'reverse', targetTable: 'public.chapter_tasks', targetId: 'task-a', parentEntryId: null, state: 'active', version: 1, createdAt: '2026-11-04T14:00:00Z', undoneAt: null, keptAt: null, sent: false, undoable: true }] }, error: null };
    if (name === 'undo_my_learning_action') { if (port.wait) await port.wait; return { data: { status: 'undone', undoneCount: 1 }, error: null }; }
    return { data: [], error: null };
  });
});
afterEach(async () => { await act(async () => { for (const release of releases) release(); }); releases.clear(); await view?.unmount(); view = null; setPlatform('ios'); });

describe.each<'ios' | 'android'>(['ios', 'android'])('retained business controls on %s', platform => {
  it('shows the accepted notification choice after a same-person security check', async () => {
    setPlatform(platform); const write = deferred(); port.wait = write.promise;
    view = await render(h(NotificationPreferencesCard)); await settle();
    await press(getExposed(view.container, notificationPreferencesCopy.en.dnd)); await settle();
    port.phase = 'booting'; await view.rerender(h(NotificationPreferencesCard)); await settle();
    port.phase = 'ready'; port.token = 'renewed-a'; await view.rerender(h(NotificationPreferencesCard)); await settle();
    await act(async () => write.release()); await settle();
    expect(view.container.textContent).toContain(notificationPreferencesCopy.en.saved);
  });
  it('keeps an accepted learning-period start after its API renews for the same person', async () => {
    setPlatform(platform); const write = deferred(); port.wait = write.promise;
    view = await render(h(NativeLearningPeriodCard)); await settle();
    await press(getExposed(view.container, lp('learningPeriod.offer.start'))); await settle();
    port.token = 'renewed-a'; await view.rerender(h(NativeLearningPeriodCard)); await settle();
    await act(async () => write.release()); await settle();
    expect(view.container.textContent).toContain(lp('learningPeriod.offer.started', { when: 'December 1, 2026' }).split('December')[0]);
  });
  it('keeps an accepted history undo after the API object renews', async () => {
    setPlatform(platform); const write = deferred(); port.wait = write.promise;
    const changed = vi.fn();
    const props = { api: createLearningPeriodApi(client), running: true, onChanged: changed };
    view = await render(h(NativePracticeHistory, props)); await settle();
    const undo = view.container.querySelector('[aria-label^="Undo:"]');
    expect(undo).toBeDefined(); await press(undo!); await settle();
    await press(getExposed(view.container, lp('learningPeriod.confirm.go'))); await settle();
    await view.rerender(h(NativePracticeHistory, { ...props, api: createLearningPeriodApi(client) })); await settle();
    await act(async () => write.release()); await settle();
    expect(view.container.textContent).toContain(lp('learningPeriod.done')); expect(changed).toHaveBeenCalledOnce();
  });
});

describe.each(['ios', 'android'] as const)('accepted learning controls on %s', platform => {
  it('holds an accepted start until a proven read-only Refresh confirms it', async () => {
    setPlatform(platform); view = await render(h(NativeLearningPeriodCard)); await settle();
    const reads = port.rpc.mock.calls.filter(([name]) => name === 'get_organization_learning_period').length;
    port.proof = 'unavailable';
    await press(getExposed(view.container, lp('learningPeriod.offer.start'))); await settle();
    expect(port.rpc.mock.calls.filter(([name]) => name === 'start_organization_learning_period')).toHaveLength(1);
    expect(port.rpc.mock.calls.filter(([name]) => name === 'get_organization_learning_period')).toHaveLength(reads);
    const start = getExposed(view.container, lp('learningPeriod.offer.start'));
    expect(start.getAttribute('aria-disabled')).toBe('true'); await press(start);
    expect(port.rpc.mock.calls.filter(([name]) => name === 'start_organization_learning_period')).toHaveLength(1);
    expect(getExposed(view.container, 'Refresh')).toBeDefined();
    port.proof = 'current'; await press(getExposed(view.container, 'Refresh')); await settle();
    expect(port.rpc.mock.calls.filter(([name]) => name === 'get_organization_learning_period').length).toBeGreaterThan(reads);
    expect(exposedNames(view.container)).not.toContain(lp('learningPeriod.offer.start'));
  });
});
