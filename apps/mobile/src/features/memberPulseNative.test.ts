// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveTheme } from '../theme/tokens';
import { rankWhatMattersNow } from '../lib/whatMattersShared';
import type { MemberDashboard } from '../models/member';
import type { MemberPulse } from '../services/memberPulse';
import type { PulseCard } from '../lib/pulseCatalog';
import { READ_DEADLINE_MS } from '../lib/readDeadline';
import { memberStatisticsCards } from '../lib/memberPulse';

const runtime = vi.hoisted(() => ({
  appState: 'active', appStateListeners: new Set<(state: string) => void>(),
  app: { mode: 'authenticated', session: { user: { id: '10000000-0000-4000-8000-000000000001' } }, organizationID: 'org-a', dashboard: null as MemberDashboard | null, sessionRestricted: false, refresh: vi.fn(), error: null as string | null },
  load: vi.fn(), history: vi.fn(), preference: vi.fn(), save: vi.fn(), push: vi.fn(), version: 0, listener: () => {}, refreshPoll: vi.fn(), pollChannel: null as string | null,
  fontScale: 1,
  announce: vi.fn(),
  poll: { question: 'Meeting night', options: [{ label: 'Tuesday', votes: 14 as number | null }], mine: null as number | null },
}));
vi.mock('../services/memberPulse', () => ({ loadMemberPulse: runtime.load }));
vi.mock('../services/pulseHistory', () => ({ loadPulseHistory: runtime.history }));
vi.mock('./SavedPulseCharts', () => ({ SavedChartSlot: () => null, useSavedPulseChartCount: () => 0 }));
vi.mock('../services/pulseOpeningPreference', () => ({ loadPulseOpening: runtime.preference, savePulseOpening: runtime.save }));
vi.mock('../state/AppProvider', () => ({ useApp: () => runtime.app }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => resolveTheme('union-ground') }));
vi.mock('../lib/chrome', () => ({ screenBottomInset: () => 0, useNativeTabContentInset: () => 24 }));
vi.mock('../lib/reduceMotion', () => ({ useReduceMotion: () => true }));
vi.mock('../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => runtime.announce }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('../data/useChannels', () => ({ useChannelStore: () => ({
  subscribe: (listener: () => void) => { runtime.listener = listener; return () => {}; }, getVersion: () => runtime.version,
  poll: () => runtime.poll, status: () => 'ready', refresh: runtime.refreshPoll,
  channels: () => runtime.pollChannel ? [{ id: runtime.pollChannel, messages: [{ poll: true }] }] : [],
}) }));
vi.mock('expo-router', async () => {
  const react = await import('react');
  return { useRouter: () => ({ push: runtime.push }), useFocusEffect: (callback: () => (() => void) | void) => react.useEffect(callback, [callback]) };
});
vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const AppState = { get currentState() { return runtime.appState; }, addEventListener: (_event: string, listener: (state: string) => void) => { runtime.appStateListeners.add(listener); return { remove: () => runtime.appStateListeners.delete(listener) }; } };
  const text = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return { AppState, View: text, Text: text, ScrollView: text,
    Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => visible ? h('div', { role: 'dialog' }, children) : null,
    Pressable: ({ children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, disabled }: { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string; accessibilityRole?: string; accessibilityState?: { checked?: boolean }; disabled?: boolean }) => h('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel, ...(accessibilityRole === 'radio' ? { role: 'radio', 'aria-checked': accessibilityState?.checked } : {}) }, children),
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 }, useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: runtime.fontScale ?? 1 }),
  };
});
vi.mock('react-native-svg', async () => {
  const h = (await import('react')).createElement;
  return { default: ({ children }: { children?: ReactNode }) => h('svg', null, children), Line: () => null, Path: ({ fill }: { fill?: string }) => h('i', { 'data-column': fill }), Rect: () => null, Text: () => null };
});
vi.mock('../components/ui', async () => {
  const { createElement: h } = await import('react');
  const text = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return { Body: text, Heading: text, Card: text, Screen: text,
    Button: ({ label, onPress, disabled, variant = 'primary' }: { label: string; onPress: () => void; disabled?: boolean; variant?: string }) => h('button', { onClick: onPress, disabled, 'data-variant': variant }, label),
    StateMessage: ({ title, body, action }: { title: string; body: string; action?: ReactNode }) => h('div', null, title, body, action),
  };
});
// This week's gold and quiet actions (#8926); the spring is PressableScale's own test.
vi.mock('../components/PressableScale', async () => {
  const h = (await import('react')).createElement;
  return { PressableScale: ({ children, onPress, accessibilityLabel, accessibilityState, testID }: { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string; accessibilityState?: { expanded?: boolean }; testID?: string }) =>
    h('button', { onClick: onPress, 'aria-label': accessibilityLabel, 'aria-expanded': accessibilityState?.expanded, 'data-testid': testID }, children) };
});
// The guide decides for itself (GuideLayers.test.ts); here only where it mounts.
vi.mock('./guideLayers/GuideLayers', () => ({
  NativeFeatureGuide: ({ feature }: { feature: string }) => createElement('aside', { 'data-feature-guide': feature }),
}));
import MemberPulseScreen from './MemberPulseScreen';
import { OpeningChoice, PulseOpeningPreferenceCard } from './PulseOpeningPreference';
import { HomeGuidePreference } from './HomeGuidePreference';
import { recordFeatureMark } from './guideLayers/guideLayersData';

vi.mock('./guideLayers/guideLayersData', () => ({ recordFeatureMark: vi.fn(async () => undefined) }));

let root: Root, host: HTMLDivElement;
const now = new Date('2026-11-01T18:40:00-05:00');
const cases = [{ id: 'c1', reference: 'GR-1', status: 'active', step: 'Step 2', deadline: '2026-11-02' }];
function card(id: string, number: string, category: PulseCard['category']): PulseCard { return { id, number, title: `${id} figures`, category, period: 'Today', countedFrom: 'Authorized records.', notCounted: 'Other organizations excluded.', rows: [{ label: 'Recorded', value: 12 }] }; }
function result(overrides: Partial<MemberPulse> = {}): MemberPulse {
  return { updatedAt: now, cards: [card('actions', '01', 'chapter'), card('meetings', '02', 'meetings'), card('week', '03', 'chapter'), card('outcomes', '04', 'cases')],
    next: rankWhatMattersNow({ cases, ballots: [], events: [], now }), nextAvailable: true, statisticsLocked: false,
    surveys: ['Scheduling'], notice: { title: 'Recorded notice', unread: 1, limited: false }, ...overrides };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function render(node: ReactNode = createElement(MemberPulseScreen)) { await act(async () => { root.render(node); }); }
async function click(label: string) {
  const button = Array.from(host.querySelectorAll('button')).find((row) => row.textContent === label || row.getAttribute('aria-label') === label);
  expect(button, label).toBeTruthy(); await act(async () => { button!.click(); });
}
beforeEach(() => {
  runtime.appState = 'active';
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  runtime.app.mode = 'authenticated'; runtime.app.session = { user: { id: '10000000-0000-4000-8000-000000000001' } }; runtime.app.organizationID = 'org-a'; runtime.app.error = null; runtime.app.sessionRestricted = false;
  runtime.app.dashboard = { member: { id: runtime.app.session.user.id, firstName: 'Fictional', fullName: 'Fictional Worker', initials: 'FM', roleLine: 'Worker', memberSince: null, chapterID: 'test-chapter', language: 'en' }, cases: [], notifications: [], conversations: [], weeklyActions: [] };
  runtime.load.mockReset().mockResolvedValue(result()); runtime.history.mockReset().mockResolvedValue([]); runtime.preference.mockReset().mockResolvedValue({ opening: 'week', setupComplete: false });
  runtime.save.mockReset().mockImplementation(async (_user: string, opening: string) => ({ opening, setupComplete: true }));
  runtime.announce.mockClear();
  runtime.push.mockReset(); runtime.app.refresh.mockReset(); runtime.refreshPoll.mockReset(); runtime.version = 0;
  runtime.pollChannel = null; runtime.fontScale = 1;
  runtime.poll = { question: 'Meeting night', options: [{ label: 'Tuesday', votes: 14 }], mine: null };
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); expect(runtime.appStateListeners.size).toBe(0); if (vi.isFakeTimers()) expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });

describe('native worker Pulse catalogue', () => {
  it('offers Retry Pulse after an unanswered read, ignores its late reply, and recovers', async () => {
    vi.useFakeTimers();
    const late = deferred<MemberPulse>();
    runtime.load.mockReturnValueOnce(late.promise);
    await render();
    expect(host.textContent).toContain('Loading your figures');
    expect((runtime.load.mock.calls[0]![2] as AbortSignal).aborted).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS); });
    expect(host.textContent).not.toContain('Loading your figures');
    expect(host.textContent).toContain('Pulse could not load');
    // #8769: the abandoned read is stopped once its deadline passes.
    expect((runtime.load.mock.calls[0]![2] as AbortSignal).aborted).toBe(true);
    await act(async () => late.resolve(result({ surveys: ['Expired reply'] })));
    expect(host.textContent).not.toContain('Expired reply');
    await click('Retry Pulse');
    expect(host.textContent).toContain('actions figures');
    expect(host.textContent).not.toContain('Pulse could not load');
  });
  // BUG-UG-PULSE-THIS-WEEK-CAUGHT-UP-WITH-OPEN-ITEMS-20261103.
  it.each<[string, boolean, boolean, string]>([
    ['an open survey', true, false, 'Seasonal check-in'],
    ['an unread notice', false, true, 'Crew meeting moved'],
    ['both', true, true, 'Seasonal check-in'],
    ['neither', false, false, 'Nothing needs your attention right now.'],
  ])('heads This week with %s and never says caught up above a listed item', async (_label, open, unread, headline) => {
    const surveys = open ? [{ id: 's1', title: 'Seasonal check-in', closesAt: null, answered: false }] : [];
    const notices = unread ? [{ id: 'n1', title: 'Crew meeting moved', unread: true }] : [];
    runtime.load.mockResolvedValue(result({ next: rankWhatMattersNow({ cases: [], ballots: [], events: [], surveys, notices, now }),
      surveys: surveys.map((row) => row.title), notice: unread ? { title: 'Crew meeting moved', unread: 1, limited: false } : null }));
    await render();
    expect(host.textContent).toContain(headline);
    if (open || unread) expect(host.textContent).not.toContain('Nothing needs your attention');
    expect(host.textContent?.includes('1 survey to answer')).toBe(open);
    expect(host.textContent?.includes('1 unread notice')).toBe(unread);
  });
  it('shows stored weekly trends for the worker hat and a failed history read as unverified', async () => {
    runtime.history.mockResolvedValue([{ id: 'history-chapter-meeting_checkins', number: 'W1', title: 'Meeting check-ins by week', category: 'meetings', period: 'Since the week of Nov 2 · ET', countedFrom: 'stored weeks.', notCounted: 'Drafts excluded.', rows: [{ label: 'Nov 2', value: 27 }], message: 'Up from the week before.' }]);
    await render();
    expect(runtime.history).toHaveBeenCalledWith(runtime.app.session, 'member');
    expect(host.textContent).toContain('Meeting check-ins by week'); expect(host.textContent).toContain('Up from the week before.');
    runtime.history.mockRejectedValue(new Error('offline')); await click('Refresh Pulse');
    expect(host.textContent).toContain('Weekly history didn’t load'); expect(host.textContent).not.toContain('Meeting check-ins by week');
  });
  it('keeps the live Pulse action before the optional feature guide', async () => {
    // BUG-UG-NATIVE-FEATURE-GUIDE-MARKS-AND-PULSE-20261102.
    await render();
    expect(host.querySelector('[data-feature-guide]')?.getAttribute('data-feature-guide')).toBe('pulse');
    const action = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Review issue')!;
    expect(action.compareDocumentPosition(host.querySelector('[data-feature-guide]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('uses the Home action, five expandable cards, filters, live poll and authorized links', async () => {
    await render();
    expect(host.textContent).toContain('Updated 6:40 PM ET'); expect(host.textContent).toContain('GR-1');
    // #8926: the most urgent item takes the screen's one gold action; every other action is secondary.
    const gold = host.querySelectorAll('[data-testid="pulse-week-gold-action"]');
    expect(gold).toHaveLength(1); expect(gold[0]!.textContent).toBe('Review issue');
    expect(Array.from(host.querySelectorAll('button[data-variant="primary"]')).map((button) => button.textContent)).toEqual([]);
    await click('Review issue'); expect(runtime.push).toHaveBeenCalledWith('/issue/c1');
    // Folded, the survey and notice are listed without their actions; See all 3 opens them.
    expect(host.textContent).toContain('1 survey to answer · Scheduling'); expect(host.textContent).toContain('1 unread notice · Recorded notice');
    expect(host.textContent).not.toContain('Open surveys'); expect(host.textContent).not.toContain('Open notices');
    await click('See all 3'); expect(host.querySelector('[aria-label="Show fewer"]')?.getAttribute('aria-expanded')).toBe('true');
    await click('Open surveys'); expect(runtime.push).toHaveBeenCalledWith('/feature/voting');
    await click('Open notices'); expect(runtime.push).toHaveBeenCalledWith('/messages');
    await click('Open campaign poll'); expect(runtime.push).toHaveBeenCalledWith('/messages');
    runtime.pollChannel = 'test-poll'; await render(); await click('Open campaign poll'); expect(runtime.push).toHaveBeenCalledWith('/channel/test-poll');
    await click('01. actions figures. Expand chart'); expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Other organizations excluded.');
    await click('Table view'); expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Recorded12');
    await click('Chart view'); await click('Close chart');
    expect(Array.from(host.querySelectorAll('[role="radio"]')).map((pill) => pill.textContent)).toEqual(['All', 'Campaign', 'Issues', 'Meetings', 'Voice']);
    await click('Issues'); expect(host.textContent).toContain('outcomes figures'); expect(host.textContent).not.toContain('actions figures');
    expect(host.querySelector('[aria-label="Issues"]')?.getAttribute('aria-checked')).toBe('true');
    // Voice holds the campaign poll and nothing else.
    await click('Voice'); expect(host.textContent).toContain('Meeting night'); expect(host.textContent).not.toContain('actions figures'); expect(host.textContent).not.toContain('outcomes figures');
    await click('All'); expect(host.textContent).toContain('Meeting night'); expect(host.textContent).not.toContain('Your charts');
    await click('Refresh Pulse'); expect(runtime.app.refresh).toHaveBeenCalledWith('user-refresh'); expect(runtime.refreshPoll).toHaveBeenCalled();
  });
  it('counts See all from the week\'s items and keeps a lone item\'s action in reach', async () => {
    // Headline only: no See all, nothing folded away.
    runtime.load.mockResolvedValue(result({ surveys: [], notice: null })); await render();
    expect(host.textContent).not.toContain('See all'); expect(host.querySelectorAll('[data-testid="pulse-week-gold-action"]')).toHaveLength(1);
    // A headline that is a survey is counted once, among the surveys: two surveys and the notices make See all 3.
    const surveys = [{ id: 's1', title: 'Seasonal check-in', closesAt: null, answered: false }, { id: 's2', title: 'Overtime', closesAt: null, answered: false }];
    runtime.load.mockResolvedValue(result({ next: rankWhatMattersNow({ cases: [], ballots: [], events: [], surveys, notices: [], now }), surveys: ['Seasonal check-in', 'Overtime'], notice: { title: 'Crew meeting moved', unread: 2, limited: true } }));
    await click('Refresh Pulse');
    expect(host.textContent).toContain('2 surveys to answer · Seasonal check-in'); expect(host.textContent).toContain('2 unread notices among your latest twenty · Crew meeting moved');
    await click('See all 3'); await click('Open notices'); expect(runtime.push).toHaveBeenCalledWith('/messages');
    await click('Show fewer'); expect(host.textContent).not.toContain('Open notices');
    // Only a survey and no headline action: its action stays on the card.
    runtime.load.mockResolvedValue(result({ next: null, nextAvailable: false, surveys: ['Overtime'], notice: null })); await click('Refresh Pulse');
    expect(host.textContent).not.toContain('See all'); expect(host.querySelectorAll('[data-testid="pulse-week-gold-action"]')).toHaveLength(0);
    await click('Open surveys'); expect(runtime.push).toHaveBeenLastCalledWith('/feature/voting');
  });
  it('reads the worker Pulse in Spanish from the native catalogue', async () => {
    runtime.app.dashboard = { ...runtime.app.dashboard!, member: { ...runtime.app.dashboard!.member, language: 'es' } };
    await render();
    expect(runtime.load.mock.calls[0]![3]).toBe('es');
    expect(Array.from(host.querySelectorAll('[role="radio"]')).map((pill) => pill.textContent)).toEqual(['Todo', 'Campaña', 'Asuntos', 'Reuniones', 'Voz']);
    expect(host.textContent).toContain('Esta semana'); expect(host.textContent).toContain('Ver los 3'); expect(host.textContent).toContain('toca para ampliar ›');
    expect(host.textContent).toContain('1 encuesta por responder · Scheduling'); expect(host.textContent).toContain('Actualizar Pulso');
    await click('01. actions figures. Ampliar gráfico'); expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Lo que esto no cuenta');
  });
  it('opens charts first on each mount while keeping This week reachable', async () => {
    runtime.preference.mockResolvedValue({ opening: 'charts', setupComplete: true }); await render();
    expect(host.textContent).not.toContain('GR-1'); expect(host.textContent).toContain('actions figures');
    await click('Show This week'); expect(host.textContent).toContain('GR-1'); await click('Hide This week'); expect(host.textContent).not.toContain('GR-1');
  });
  it('withdraws hidden poll totals from an already open expand sheet', async () => {
    await render(); await click('05. Meeting night. Expand chart'); expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Tuesday14');
    await act(async () => { runtime.poll.options[0]!.votes = null; runtime.version++; runtime.listener(); });
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('not published');
    expect(host.querySelector('[role="dialog"]')?.textContent).not.toContain('Tuesday14');
  });
  it('makes Your charts conditional on actual supplied saved charts', async () => {
    const saved = card('saved', '06', 'chapter'); await render(createElement(MemberPulseScreen, { customCards: [saved] }));
    await click('Your charts'); expect(host.textContent).toContain('saved figures'); expect(host.textContent).not.toContain('actions figures');
  });
  it('retries failures and never calls an unverified next action caught up', async () => {
    runtime.load.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(result({ nextAvailable: false, next: null, statisticsLocked: true }));
    await render(); expect(host.textContent).toContain('Pulse could not load'); await click('Retry Pulse');
    expect(host.textContent).toContain('Your next action didn’t load'); await click('Retry next action');
    await click('Complete the quarterly survey'); expect(runtime.push).toHaveBeenCalledWith('/feature/voting');
  });
  it('keeps late responses from another account and organization off the screen', async () => {
    const old = deferred<MemberPulse>(); runtime.load.mockReturnValueOnce(old.promise); await render();
    runtime.app.session = { user: { id: '10000000-0000-4000-8000-000000000002' } }; runtime.app.organizationID = 'org-b';
    runtime.load.mockResolvedValue(result({ next: null, notice: null, surveys: [] })); await render();
    await act(async () => { old.resolve(result({ notice: { title: 'Old private notice', unread: 1, limited: false } })); });
    expect(host.textContent).not.toContain('Old private notice'); expect(host.textContent).not.toContain('GR-1');
  });
  it('retires fixture charts in preview and exposes an honest opening-preference retry', async () => {
    runtime.app.mode = 'preview'; await render(); expect(runtime.load).not.toHaveBeenCalled(); expect(host.textContent).toContain('No preview records');
    runtime.app.mode = 'authenticated'; runtime.preference.mockRejectedValueOnce(new Error('storage')); await render();
    expect(host.textContent).toContain('Opening choice unavailable'); await click('Retry opening choice');
  });
  it('keeps Pulse and an open chart through a conversation poll, and reloads when its own records change', async () => {
    // BUG-UG-MEMBER-PULSE-RESETS-ON-CONVERSATION-POLL-20261102
    await render(); expect(runtime.load).toHaveBeenCalledTimes(1);
    await click('01. actions figures. Expand chart');
    const polled = { ...runtime.app.dashboard!, conversations: [] };
    runtime.app.dashboard = polled; await render();
    runtime.app.dashboard = { ...polled, conversations: [] }; await render();
    expect(runtime.load).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Other organizations excluded.');
    runtime.app.dashboard = { ...polled, cases: [...polled.cases] }; await render();
    expect(runtime.load).toHaveBeenCalledTimes(2);
    expect(runtime.load.mock.calls[1]![1]).toBe(runtime.app.dashboard);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
  it('offers a real member-record retry before the dashboard has loaded', async () => {
    runtime.app.dashboard = null; await render(); expect(runtime.load).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Your worker records have not loaded yet'); await click('Retry worker records');
    expect(runtime.app.refresh).toHaveBeenCalledWith('user-refresh');
  });
});

describe('card 01 as the Pulse design\'s Mock A draws it (#8926)', () => {
  const counts = [62, 66, 60, 70, 77, 74, 82, 79, 92, 86, 98, 148];
  // November 2025 through October 2026, as the server writes them.
  const months = counts.map((count, index) => ({ month: index < 2 ? `2025-${11 + index}` : `2026-${String(index - 1).padStart(2, '0')}`, count }));
  const statistics = { available: true, privacyFloor: 25, actions: { withheld: false, months }, outcomes: { withheld: false, rows: [] } };
  it('leads with the newest month, draws it in ink beside series-green columns, and keeps the figures one tap away', async () => {
    const theme = resolveTheme('union-ground');
    runtime.load.mockResolvedValue(result({ cards: memberStatisticsCards(statistics, 'open') }));
    await render();
    const card = host.querySelector('[aria-label="01. Workers taking action. 148 in October. Expand chart"]');
    expect(card).toBeTruthy();
    for (const words of ['Workers taking action', 'actions by month · 12 months', '148', 'October', 'actions', 'this month', 'tap to expand ›']) expect(card!.textContent).toContain(words);
    // The floor the server returned (25 here), never a fixed number.
    expect(card!.textContent).toContain('Published only when every month counts at least 25 people.');
    const columns = Array.from(card!.querySelectorAll('[data-column]')).map((column) => column.getAttribute('data-column'));
    expect(columns).toEqual([...Array(11).fill(theme.chartSeries1), theme.foreground]);
    // The columns carry the months; the card lists no month under them.
    expect(card!.textContent).not.toContain('2026-10'); expect(card!.textContent).not.toContain('October 2026');
    await click('01. Workers taking action. 148 in October. Expand chart'); await click('Table view');
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('November 202562');
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('October 2026148');
  });
  it('puts the figure under the title at large text sizes, so the title keeps its width', async () => {
    runtime.load.mockResolvedValue(result({ cards: memberStatisticsCards(statistics, 'open') }));
    const besideTitle = async () => {
      await render();
      const subtitle = Array.from(host.querySelectorAll('div')).find((node) => node.textContent === 'actions by month · 12 months')!;
      return !subtitle.parentElement!.textContent!.includes('148');
    };
    expect(await besideTitle()).toBe(true);
    runtime.fontScale = 2; await act(async () => root.unmount()); root = createRoot(host);
    expect(await besideTitle()).toBe(false);
  });
  // #8945 review: with no floor from the server (a locked gate makes no
  // statistics call; a failed read; a missing or invalid floor) the cards name
  // no number and carry no privacy sentence.
  const noFloor: [string, unknown, 'open' | 'locked' | 'error', string][] = [
    ['locked', { available: false, locked: true }, 'locked', 'quarterly survey'],
    ['failed', null, 'error', 'didn’t load'],
    ['missing floor', { ...statistics, privacyFloor: undefined }, 'open', 'didn’t load'],
    ['invalid floor', { ...statistics, privacyFloor: 5 }, 'open', 'didn’t load'],
  ];
  it.each(noFloor)('names no privacy number when the read is %s, in English', async (_state, value, gate, line) => {
    runtime.load.mockResolvedValue(result({ cards: memberStatisticsCards(value, gate) }));
    await render();
    for (const label of ['01. Workers taking action. Expand chart', '04. How issues end. Expand chart']) {
      const card = host.querySelector(`[aria-label="${label}"]`);
      expect(card, label).toBeTruthy();
      expect(card!.textContent).toContain(line);
      expect(card!.textContent).not.toMatch(/\d+ (different )?people/);
      expect(card!.textContent).not.toContain('Published only'); expect(card!.textContent).not.toContain('Every count shown');
    }
  });
  it.each(noFloor)('names no privacy number when the read is %s, in Spanish', async (_state, value, gate) => {
    runtime.app.dashboard = { ...runtime.app.dashboard!, member: { ...runtime.app.dashboard!.member, language: 'es' } };
    runtime.load.mockResolvedValue(result({ cards: memberStatisticsCards(value, gate, 'es') }));
    await render();
    for (const label of ['01. Trabajadores que actúan. Ampliar gráfico', '04. Cómo terminan los asuntos. Ampliar gráfico']) {
      const card = host.querySelector(`[aria-label="${label}"]`);
      expect(card, label).toBeTruthy();
      expect(card!.textContent).toMatch(gate === 'locked' ? /encuesta trimestral/ : /No se cargaron/);
      expect(card!.textContent).not.toMatch(/\d+ personas/);
      expect(card!.textContent).not.toContain('Se publica solo'); expect(card!.textContent).not.toContain('Cada cifra');
    }
  });
  it('states a higher server floor and names the months in Spanish', async () => {
    runtime.app.dashboard = { ...runtime.app.dashboard!, member: { ...runtime.app.dashboard!.member, language: 'es' } };
    runtime.load.mockResolvedValue(result({ cards: memberStatisticsCards({ ...statistics, privacyFloor: 40 }, 'open', 'es') }));
    await render();
    const card = host.querySelector('[aria-label="01. Trabajadores que actúan. 148 en Octubre. Ampliar gráfico"]');
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain('Se publica solo cuando cada mes cuenta al menos 40 personas.');
    expect(card!.textContent).toContain('acciones por mes · 12 meses'); expect(card!.textContent).toContain('este mes');
  });
});

describe('Pulse Account opening choice', () => {
  it('clears a completed save receipt when the account changes without remounting the open card', async () => {
    const firstAccount = runtime.app.session;
    const receipt = 'Pulse opening choice saved.';
    await render(createElement(OpeningChoice));
    await click('Pulse opens withThis week first');
    await click('Charts first'); await click('Save Pulse choice');
    expect(host.textContent).toContain(receipt);
    expect(runtime.save).toHaveBeenCalledWith(firstAccount.user.id, 'charts');
    expect(runtime.announce).toHaveBeenCalledWith(receipt);
    const saveButton = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Save Pulse choice');

    runtime.app.session = { user: { id: 'another-account' } };
    await render(createElement(OpeningChoice));
    expect(runtime.preference).toHaveBeenLastCalledWith('another-account');
    expect(host.contains(saveButton ?? null)).toBe(true);
    expect(host.textContent).not.toContain(receipt);
    expect(runtime.save).toHaveBeenCalledTimes(1);
    expect(runtime.announce).toHaveBeenCalledTimes(1);

    runtime.app.session = firstAccount;
    await render(createElement(OpeningChoice));
    expect(host.textContent).not.toContain(receipt);
  });

  it.each<['en' | 'es', string, string, string, string, string, string, string]>([
    ['en', 'Pulse opens withThis week first', 'Pulse opens withCharts first', 'Charts first', 'This week first',
      'Save Pulse choice', 'Close Pulse choice', 'Pulse opening choice saved.'],
    ['es', 'Pulso se abre conEsta semana primero', 'Pulso se abre conGráficos primero', 'Gráficos primero', 'Esta semana primero',
      'Guardar la elección de Pulso', 'Cerrar la elección de Pulso', 'Se guardó la elección de apertura de Pulso.'],
  ])('confirms a successful save inside the open card in %s', async (language, row, savedRow, charts, week, save, close, receipt) => {
    runtime.app.dashboard!.member.language = language;
    const pending = deferred<{ opening: 'charts'; setupComplete: boolean }>();
    runtime.save.mockReturnValueOnce(pending.promise);
    await render(createElement(PulseOpeningPreferenceCard));
    await click(row); await click(charts); await click(save);
    expect(host.textContent).not.toContain(receipt);
    expect(runtime.announce).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ opening: 'charts', setupComplete: true }));
    expect(host.textContent).toContain(receipt);
    expect(runtime.announce).toHaveBeenCalledWith(receipt);
    await click(week);
    expect(host.textContent).not.toContain(receipt);
    await click(charts); await click(save);
    expect(host.textContent).toContain(receipt);
    expect(runtime.announce).toHaveBeenCalledTimes(2);
    await click(close); await click(savedRow);
    expect(host.textContent).not.toContain(receipt);
  });

  it('does not show or announce a late receipt when the worker closed and reopened the card', async () => {
    const pending = deferred<{ opening: 'charts'; setupComplete: boolean }>();
    runtime.save.mockReturnValueOnce(pending.promise);
    await render(createElement(PulseOpeningPreferenceCard));
    await click('Pulse opens withThis week first');
    await click('Charts first'); await click('Save Pulse choice'); await click('Close Pulse choice');
    await click('Pulse opens withThis week first');
    await act(async () => pending.resolve({ opening: 'charts', setupComplete: true }));
    expect(host.textContent).toContain('Charts first');
    expect(host.textContent).not.toContain('Pulse opening choice saved.');
    expect(runtime.announce).not.toHaveBeenCalled();
  });

  it('saves a choice from the compact settings row and keeps it available after closing', async () => {
    await render(createElement(PulseOpeningPreferenceCard));
    expect(host.textContent).not.toContain('How should Pulse open?');
    await click('Pulse opens withThis week first');
    await click('Charts first'); await click('Save Pulse choice');
    expect(runtime.save).toHaveBeenCalledWith(runtime.app.session.user.id, 'charts');
    await click('Close Pulse choice');
    expect(host.textContent).not.toContain('How should Pulse open?');
    expect(host.textContent).toContain('Charts first');
    await click('Pulse opens withCharts first');
    expect(host.textContent).toContain('How should Pulse open?');
  });
  it('keeps the default, reports settings errors and supports retry', async () => {
    runtime.save.mockRejectedValueOnce(new Error('storage'));
    await render(createElement(PulseOpeningPreferenceCard));
    await click('Pulse opens withThis week first');
    await click('Save Pulse choice'); expect(host.textContent).toContain('previous saved choice');
    expect(host.textContent).not.toContain('Pulse opening choice saved.');
    expect(runtime.announce).not.toHaveBeenCalled();
    await click('Retry Pulse choice'); await click('Save Pulse choice');
    expect(runtime.save).toHaveBeenCalledWith(runtime.app.session.user.id, 'week');
  });
  it('does not label an unsaved choice as the saved opening when its settings row is closed', async () => {
    await render(createElement(PulseOpeningPreferenceCard));
    await click('Pulse opens withThis week first'); await click('Charts first');
    await click('Pulse opens withThis week first');
    expect(host.textContent).not.toContain('Charts first');
    expect(runtime.save).not.toHaveBeenCalled();
    await click('Pulse opens withThis week first');
    expect(host.querySelector('[aria-label="This week first"]')?.getAttribute('aria-checked')).toBe('true');
  });
  it('closes the expanded row at an account switch and rejects the old account’s late save result', async () => {
    const saved = deferred<{ opening: 'charts'; setupComplete: boolean }>();
    runtime.save.mockReturnValueOnce(saved.promise);
    await render(createElement(PulseOpeningPreferenceCard));
    await click('Pulse opens withThis week first'); await click('Charts first'); await click('Save Pulse choice');
    runtime.app.session = { user: { id: 'another-account' } };
    await render(createElement(PulseOpeningPreferenceCard));
    await act(async () => { saved.resolve({ opening: 'charts', setupComplete: true }); });
    expect(host.textContent).not.toContain('How should Pulse open?');
    expect(host.textContent).not.toContain('Charts first');
    expect(host.textContent).toContain('This week first');
    expect(runtime.save).toHaveBeenCalledWith('10000000-0000-4000-8000-000000000001', 'charts');
  });
  it('offers the same compact Pulse choices in Spanish', async () => {
    runtime.app.dashboard!.member.language = 'es';
    await render(createElement(PulseOpeningPreferenceCard));
    await click('Pulso se abre conEsta semana primero');
    expect(host.textContent).toContain('¿Cómo debe abrirse Pulso?');
    await click('Gráficos primero'); await click('Guardar la elección de Pulso');
    expect(runtime.save).toHaveBeenCalledWith(runtime.app.session.user.id, 'charts');
    await click('Cerrar la elección de Pulso');
    expect(host.textContent).not.toContain('¿Cómo debe abrirse Pulso?');
  });
});

describe('R1 r2s1: Pulse collapsed summaries name the effective fallback honestly', () => {
  const languages: Array<'en' | 'es'> = ['en', 'es'];
  it.each(languages)('names the fallback while checking a saved charts choice in %s', async language => {
    runtime.app.dashboard!.member.language = language;
    const pending = deferred<{ opening: 'charts'; setupComplete: boolean }>();
    runtime.preference.mockReturnValue(pending.promise);
    await render(createElement(PulseOpeningPreferenceCard));
    expect(host.textContent).toContain(language === 'es'
      ? 'Esta semana primero · Comprobando la elección guardada…'
      : 'This week first · Checking saved choice…');
    expect(host.textContent).not.toContain(language === 'es' ? 'Gráficos primero' : 'Charts first');
    await act(async () => pending.resolve({ opening: 'charts', setupComplete: true }));
    expect(host.textContent).toContain(language === 'es' ? 'Gráficos primero' : 'Charts first');
    expect(host.textContent).not.toContain(language === 'es' ? 'Comprobando' : 'Checking');
  });
  it.each(languages)('names the fallback and the unavailable saved choice without expanding in %s', async language => {
    runtime.app.dashboard!.member.language = language;
    runtime.preference.mockRejectedValue(new Error('stored charts choice cannot be read'));
    await render(createElement(PulseOpeningPreferenceCard));
    expect(host.textContent).toContain(language === 'es'
      ? 'Esta semana primero · Elección guardada no disponible'
      : 'This week first · Saved choice unavailable');
    expect(host.textContent).not.toContain(language === 'es' ? '¿Cómo debe abrirse Pulso?' : 'How should Pulse open?');
    expect(runtime.save).not.toHaveBeenCalled();
  });
  it.each(languages)('keeps a known effective choice after an unsaved edit and both row exits in %s', async language => {
    runtime.app.dashboard!.member.language = language;
    runtime.preference.mockResolvedValue({ opening: 'charts', setupComplete: true });
    runtime.save.mockRejectedValue(new Error('cannot save draft'));
    await render(createElement(PulseOpeningPreferenceCard));
    const row = language === 'es' ? 'Pulso se abre conGráficos primero' : 'Pulse opens withCharts first';
    await click(row); await click(language === 'es' ? 'Esta semana primero' : 'This week first');
    await click(language === 'es' ? 'Guardar la elección de Pulso' : 'Save Pulse choice');
    await click(language === 'es' ? 'Cerrar la elección de Pulso' : 'Close Pulse choice');
    expect(host.textContent).toContain(language === 'es' ? 'Gráficos primero' : 'Charts first');
    expect(host.textContent).not.toContain(language === 'es' ? 'no disponible' : 'unavailable');
    await click(row); await click(language === 'es' ? 'Esta semana primero' : 'This week first'); await click(row);
    expect(host.textContent).toContain(language === 'es' ? 'Gráficos primero' : 'Charts first');
    expect(host.textContent).not.toContain(language === 'es' ? 'Esta semana primero' : 'This week first');
  });
});

describe('About Home in Account', () => {
  it('opens deliberately, keeps both previous actions and stays closed on re-entry and another account', async () => {
    await render(createElement(HomeGuidePreference));
    expect(host.textContent).not.toContain("See your next step and what's new.");
    await click('About Home, Show Home guide');
    expect(host.textContent).toContain("See your next step and what's new.");
    expect(host.textContent).toContain('Ask the committee for help with a problem at work.');
    expect(host.textContent).toContain("Never post a coworker's health, discipline or personal details.");
    await click('Got it');
    expect(recordFeatureMark).toHaveBeenCalledWith(runtime.app.session.user.id, 'got', 'home', expect.any(Number));
    await render(createElement('div')); await render(createElement(HomeGuidePreference));
    expect(host.textContent).not.toContain("See your next step and what's new.");
    await click('About Home, Show Home guide'); await click("See what's next");
    expect(recordFeatureMark).toHaveBeenCalledWith(runtime.app.session.user.id, 'acted', 'home', expect.any(Number));
    expect(runtime.push).toHaveBeenCalledWith('/(tabs)/home');
    await click('About Home, Show Home guide');
    runtime.app.session = { user: { id: 'another-account' } };
    await render(createElement(HomeGuidePreference));
    expect(host.textContent).not.toContain("See your next step and what's new.");
  });
  it('keeps the guide and its controls complete in Spanish', async () => {
    runtime.app.dashboard!.member.language = 'es';
    await render(createElement(HomeGuidePreference)); await click('Acerca de Inicio, Mostrar guía de Inicio');
    expect(host.textContent).toContain('Consulta tu próximo paso y las novedades.');
    expect(host.textContent).toContain('Nunca publiques información');
    await click('Entendido');
    expect(host.textContent).not.toContain('Consulta tu próximo paso y las novedades.');
  });
});

describe('native Worker Pulse Eastern calendar refresh', () => {
  it('refreshes a stale ranking when the app resumes on another Eastern day', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T03:59:59Z'));
    runtime.load.mockImplementation(async () => result({ next: rankWhatMattersNow({ cases: [{ id: 'c1', reference: 'GR-1', status: 'active', deadline: '2026-10-02' }], ballots: [], events: [], now: new Date() }) }));
    await render();
    expect(host.textContent).toContain('is due tomorrow');
    await act(async () => { runtime.appState = 'background'; for (const listener of runtime.appStateListeners) listener('background'); });
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(new Date('2026-10-03T04:00:00Z'));
    await act(async () => { runtime.appState = 'active'; for (const listener of runtime.appStateListeners) listener('active'); });
    expect(runtime.load).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('is 1 day overdue');
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each([
    ['2026-03-08T05:00:00Z', '2026-03-09', 23],
    ['2026-11-01T04:00:00Z', '2026-11-02', 25],
  ])('refreshes the cached ranking after %s (%s, %i hours)', async (start, deadline, hours) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(start));
    runtime.load.mockImplementation(async () => result({ next: rankWhatMattersNow({ cases: [{ id: 'c1', reference: 'GR-1', status: 'active', deadline }], ballots: [], events: [], now: new Date() }) }));
    await render();
    expect(host.textContent).toContain('A follow-up is due tomorrow on GR-1.');
    await act(async () => { await vi.advanceTimersByTimeAsync(hours * 3_600_000 - 1); });
    expect(runtime.load).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(runtime.load).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('A follow-up is due today on GR-1.');
    expect(vi.getTimerCount()).toBe(1);
  });
});
