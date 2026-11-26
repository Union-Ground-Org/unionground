// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { leadershipPulse, type LeadershipHat } from '../lib/leadershipPulse';
import { READ_DEADLINE_MS } from '../lib/readDeadline';
import { resolveTheme } from '../theme/tokens';
const runtime = vi.hoisted(() => ({ app: { mode: 'authenticated', session: { access_token: 'captured', user: { id: 'person-a' } }, organizationID: 'org-a', dashboard: { member: { chapterID: 'chapter-a' } }, sessionRestricted: false, authorizedRoles: [] as string[], previewHat: null as string | null, memberLanguage: 'en' as 'en' | 'es' },
  load: vi.fn(), history: vi.fn(), push: vi.fn(), opening: 'week', preferenceFailed: false, theme: 'union-ground', listeners: new Set<(state: string) => void>(),
  layoutRpc: vi.fn<(name: string, args: Record<string, unknown>) => Promise<unknown>>(), layoutClients: [] as unknown[], chartStatus: 'known' as 'pending' | 'failed' | 'known', os: 'ios' as 'ios' | 'android', charts: null as null | { id: string; title: string; pinned: boolean; figures: { rows: { label: string; value: number }[] } }[], focus: vi.fn(),
}));
vi.mock('../services/leadershipPulse', () => ({ loadLeadershipPulse: runtime.load }));
vi.mock('../services/pulseHistory', () => ({ loadPulseHistory: runtime.history }));
vi.mock('./SavedPulseCharts', () => ({ SavedChartSlot: ({ position, order }: { position: string; order?: string[] | null }) => createElement('span', null, `Saved ${position}${order ? ` order [${order.join(',')}]` : ''}`),
  useSavedPulseCharts: () => runtime.charts, useSavedPulseChartsStatus: () => runtime.chartStatus,
  Sheet: ({ children, title, onClose }: { children?: ReactNode; title: string; onClose: () => void }) => createElement('div', { role: 'dialog' }, createElement('button', { onClick: onClose }, 'Close'), createElement('h1', null, title), children) }));
vi.mock('../services/supabase', () => ({ createCapturedSessionRpcClient: vi.fn() }));
vi.mock('../services/pulseLayout', async (importOriginal) => ({ ...(await importOriginal() as typeof import('../services/pulseLayout')),
  pulseLayoutClient: (session: unknown) => { runtime.layoutClients.push(session); return { rpc: (name: string, args: Record<string, unknown>) => runtime.layoutRpc(name, args) }; } }));
vi.mock('../state/AppProvider', () => ({ useApp: () => runtime.app }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => resolveTheme('union-ground', runtime.theme === 'union-ground-dark') }));
vi.mock('./PulseOpeningPreference', () => ({ usePulseOpening: () => ({ value: { opening: runtime.opening }, failed: runtime.preferenceFailed }) }));
vi.mock('../lib/chrome', () => ({ useNativeTabContentInset: () => 24, screenBottomInset: () => 0 }));
vi.mock('../components/PinnedHeader', () => ({ usePinnedHeaderChrome: () => ({}), useScreenNameAlreadySpoken: () => false }));
vi.mock('../components/TopChrome', () => ({ TopRamp: () => null }));
vi.mock('../components/NumberFlow', () => ({ NumberFlow: () => null }));
vi.mock('../components/charts', () => ({ ActivityRings: () => null, ClusterBadges: () => null, DonutChart: () => null, DualLineChart: () => null, PeriodBarChart: () => null, StackedAreaChart: () => null, TrendSpotlight: () => null }));
vi.mock('../data/demoChannels', () => ({ channelStore: { subscribe: () => () => {}, getVersion: () => 0 }, pollShares: () => [] }));
vi.mock('../data/useChannels', () => ({ useChannelStore: () => ({}) }));
vi.mock('../services/haptics', () => ({ haptics: {} }));
vi.mock('./MemberPulseScreen', () => ({ default: () => createElement('span', null, 'Worker route') }));
vi.mock('./StewardPulseScreen', () => ({ default: () => createElement('span', null, 'Committee route') }));
vi.mock('./guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null }));
vi.mock('../lib/reduceMotion', () => ({ useReduceMotion: () => true }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('expo-router', async () => { const react = await import('react'); return { useRouter: () => ({ push: runtime.push }), useFocusEffect: (callback: () => (() => void) | void) => react.useEffect(callback, [callback]) }; });
vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const text = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return { View: text, Text: text, ScrollView: text, Modal: ({ children }: { children?: ReactNode }) => h('div', { role: 'dialog' }, children),
    Pressable: ({ children, onPress, accessibilityLabel }: { children?: ReactNode; onPress: () => void; accessibilityLabel?: string }) => h('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
    StyleSheet: { create: <T,>(value: T) => value }, useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
    Platform: { get OS() { return runtime.os; }, select: <T,>(options: { ios?: T; android?: T; default?: T }) => options[runtime.os] ?? options.default },
    AccessibilityInfo: { sendAccessibilityEvent: (node: unknown, kind: string) => runtime.focus(node, kind) },
    AppState: { addEventListener: (_: string, listener: (state: string) => void) => { runtime.listeners.add(listener); return { remove: () => runtime.listeners.delete(listener) }; } },
  };
});
vi.mock('react-native-svg', async () => { const h = (await import('react')).createElement; return { default: ({ children }: { children?: ReactNode }) => h('svg', null, children), Line: () => null, Path: () => null, Rect: () => null, Text: () => null }; });
vi.mock('../components/ui', async () => {
  const { createElement: h } = await import('react');
  const text = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return { Body: text, Heading: text, Card: text, Screen: ({ children, onRefresh }: { children?: ReactNode; onRefresh: () => void }) => h('div', null, h('button', { onClick: onRefresh }, 'Pull to refresh'), children), Button: ({ label, accessibilityLabel, onPress, disabled, focusRef }: { label: string; accessibilityLabel?: string; onPress: () => void; disabled?: boolean; focusRef?: (node: unknown) => void }) => h('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel, ref: focusRef }, label), StateMessage: ({ title, body, action }: { title: string; body: string; action?: ReactNode }) => h('div', null, title, body, action) };
});
import LeadershipPulseScreen from './LeadershipPulseScreen';
import PulseScreen from './PulseScreen';
let root: Root, host: HTMLDivElement;
const date = new Date('2026-11-01T12:00:00-05:00');
function result(hat: LeadershipHat = 'advisor', count = 1) { return leadershipPulse(hat, { floors: { privacy: 25, chapterHealth: 25 }, health: { error: null, data: Array.from({ length: count }, (_, index) => ({ chapterName: `Tamarack campaign ${String(index).padStart(2, '0')}`, memberCount: 25, cohortProtected: false, measuredOn: '2026-10-31', score: 50 })) } }, date); }
async function render(hat: LeadershipHat = 'advisor') { await act(async () => { root.render(createElement(LeadershipPulseScreen, { hat })); }); }
async function click(label: string) { const button = Array.from(host.querySelectorAll('button')).find((row) => row.textContent === label || row.getAttribute('aria-label') === label); expect(button, label).toBeTruthy(); await act(async () => { button!.click(); }); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.resetAllMocks(); runtime.listeners.clear(); runtime.opening = 'week'; runtime.preferenceFailed = false; runtime.theme = 'union-ground';
  runtime.app.mode = 'authenticated'; runtime.app.session = { access_token: 'captured', user: { id: 'person-a' } }; runtime.app.organizationID = 'org-a'; runtime.app.dashboard = { member: { chapterID: 'chapter-a' } }; runtime.app.sessionRestricted = false; runtime.app.authorizedRoles = []; runtime.app.previewHat = null; runtime.app.memberLanguage = 'en';
  runtime.load.mockResolvedValue(result()); runtime.history.mockResolvedValue([]);
  runtime.layoutClients = []; runtime.charts = null; runtime.chartStatus = 'known'; runtime.os = 'ios'; vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 0; });
  runtime.layoutRpc.mockImplementation(async (name: string) => name === 'get_pulse_layout' ? { data: { customized: false, entries: [], options: ['fixed:health'] }, error: null } : { data: null, error: null });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('native leadership Pulse', () => {
  it('adds stored weekly trends for the held hat', async () => {
    runtime.history.mockResolvedValue([{ id: 'history-chapter-meeting_checkins', number: 'W1', title: 'Meeting check-ins by week', category: 'meetings', period: 'Since the week of Nov 2 · ET', countedFrom: 'stored weeks.', notCounted: 'Drafts excluded.', rows: [{ label: 'Nov 2', value: 27 }], message: 'Up from the week before.' }]);
    await render();
    expect(runtime.history).toHaveBeenCalledWith(runtime.app.session, expect.any(String));
    expect(host.textContent).toContain('Meeting check-ins by week');
    runtime.history.mockRejectedValue(new Error('offline')); await click('Refresh leadership Pulse');
    expect(host.textContent).toContain('Weekly history didn’t load');
  });
  it.each(['union-ground', 'union-ground-dark'])('opens the dated weekly answer, tier words and chart/table expansion in %s', async (theme) => {
    runtime.theme = theme; await render();
    expect(host.textContent!.indexOf('Saved pinned')).toBeLessThan(host.textContent!.indexOf('This week'));
    expect(host.textContent).toContain('Saved catalogue');
    expect(host.textContent).toContain('Lowest recorded health: Tamarack campaign 00'); expect(host.textContent).toContain('Updated 12:00 PM ET');
    for (const label of ['Critical', 'Concerning', 'Moderate', 'Healthy', 'Excellent']) expect(host.textContent).toContain(label);
    await click('Open your desk'); expect(runtime.push).toHaveBeenCalledWith('/feature/chapter-health');
    // The shared Mock A frame (#8926) reaches the leadership cards too.
    expect(host.querySelector('[aria-label="01. Campaign health portfolio. Expand chart"]')?.textContent).toContain('tap to expand ›');
    await click('01. Campaign health portfolio. Expand chart'); expect(host.querySelector('[role=dialog]')?.textContent).toContain('What this does not count');
    await click('Table view'); expect(host.querySelector('[role=dialog]')?.textContent).toContain('Tamarack campaign 00'); await click('Close chart');
    await click('Refresh leadership Pulse'); expect(runtime.load).toHaveBeenCalledTimes(2);
  });
  it('shows the Spanish health tiers in the weekly summary, legend and expanded portfolio', async () => {
    runtime.app.memberLanguage = 'es';
    await render();
    expect(host.textContent).toContain('Moderado · 50/100');
    expect(host.textContent).toContain('Tamarack campaign 00 · Moderado · 31 oct 2026');
    expect(host.textContent).toContain('Niveles de salud');
    for (const label of ['Crítico · 0–24', 'Preocupante · 25–44', 'Moderado · 45–64', 'Saludable · 65–84', 'Excelente · 85–100']) {
      expect(host.textContent).toContain(label);
    }
    await click('01. Campaign health portfolio. Ampliar gráfico');
    await click('Ver tabla');
    const table = host.querySelector('[role=dialog]');
    expect(table?.textContent).toContain('Tamarack campaign 00 · Moderado · 31 oct 2026');
    expect(table?.textContent).toContain('Crítico, Preocupante, Moderado, Saludable y Excelente');
    expect(host.textContent).not.toMatch(/\b(?:Critical|Concerning|Moderate|Healthy|Excellent)\b/);
  });
  it('pages a capped portfolio and keeps the existing charts-first preference', async () => {
    runtime.opening = 'charts'; runtime.load.mockResolvedValue(result('advisor', 25)); await render();
    expect(host.textContent).not.toContain('Lowest recorded health:'); await click('Show This week'); expect(host.textContent).toContain('Lowest recorded health:'); await click('Hide This week');
    expect(host.textContent).toContain('Campaign page 1 of 2'); expect(host.textContent).not.toContain('Tamarack campaign 24');
    await click('Next campaigns'); expect(host.textContent).toContain('Tamarack campaign 24'); expect(host.textContent).not.toContain('Tamarack campaign 00');
    await click('Previous campaigns'); expect(host.textContent).toContain('Tamarack campaign 00');
  });
  it('retries failures without treating private or unreadable lists as zero', async () => {
    runtime.load.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(leadershipPulse('admin', {}, date)); await render('admin');
    expect(host.textContent).toContain('Leadership Pulse could not load'); await click('Retry leadership Pulse');
    expect(host.textContent).toContain('does not treat them as zero'); expect(host.textContent).toContain('These figures didn’t load');
    await click('Open your desk'); expect(runtime.push).toHaveBeenCalledWith('/feature/admin');
  });
  it('withdraws data/sheets in the background and ignores a late previous-account response', async () => {
    await render(); await click('01. Campaign health portfolio. Expand chart');
    await act(async () => { for (const listener of runtime.listeners) listener('background'); });
    expect(host.textContent).not.toContain('Tamarack campaign'); expect(host.querySelector('[role=dialog]')).toBeNull();
    await act(async () => { for (const listener of [...runtime.listeners]) listener('active'); }); expect(host.textContent).toContain('Tamarack campaign');
    let resolve!: (value: ReturnType<typeof result>) => void; runtime.load.mockReturnValueOnce(new Promise<ReturnType<typeof result>>((done) => { resolve = done; }));
    await click('Refresh leadership Pulse'); runtime.app.session = { access_token: 'other', user: { id: 'person-b' } }; runtime.app.organizationID = 'org-b';
    runtime.load.mockResolvedValue(leadershipPulse('admin', {}, date)); await render('admin');
    await act(async () => { resolve(result()); }); expect(host.textContent).not.toContain('Tamarack campaign');
    expect(runtime.load.mock.calls.at(-1)?.[3]).toBe('chapter-a');
  });
  it('keeps preview and restricted states free of invented or previous figures', async () => {
    runtime.app.mode = 'preview'; await render(); expect(host.textContent).toContain('No preview records'); expect(runtime.load).not.toHaveBeenCalled();
    runtime.app.mode = 'authenticated'; runtime.app.sessionRestricted = true; await render(); expect(runtime.load).not.toHaveBeenCalled();
    runtime.app.sessionRestricted = false; runtime.preferenceFailed = true; runtime.opening = 'charts'; await render(); expect(host.textContent).toContain('opening choice could not be checked'); expect(host.textContent).toContain('This week');
    await click('Pull to refresh'); expect(runtime.load).toHaveBeenCalledTimes(2);
  });
  it('shows leadership and missing-workspace state without calling the figure reads', async () => {
    runtime.app.dashboard = null as never; await render('vp'); expect(host.textContent).toContain('Campaign chair and VP'); expect(host.textContent).toContain('getting ready'); expect(runtime.load).not.toHaveBeenCalled();
  });
  it('loads the organization-wide advisor portfolio without a selected campaign', async () => {
    runtime.app.dashboard = { member: { chapterID: null } } as never; await render('advisor');
    expect(runtime.load).toHaveBeenCalledWith(runtime.app.session, 'advisor', 'org-a', null, expect.any(AbortSignal));
    // Weekly history is per chapter: no read, and no failure notice.
    expect(runtime.history).not.toHaveBeenCalled(); expect(host.textContent).not.toContain('Weekly history didn’t load');
    expect(host.textContent).toContain('Tamarack campaign 00'); expect(host.textContent).not.toContain('Choose a campaign');
  });
  it.each<LeadershipHat>(['president', 'vp', 'coordinator', 'admin'])('tells a chapterless %s to choose a campaign instead of painting a blank Pulse', async (hat) => {
    runtime.app.dashboard = { member: { chapterID: null } } as never; await render(hat);
    expect(host.textContent).toContain('Choose a campaign to see these figures'); expect(host.textContent).not.toContain('getting ready');
    await click('Pull to refresh');
    expect(runtime.load).not.toHaveBeenCalled(); expect(host.textContent).not.toContain('Checking your current role');
  });
  // #9459 M3-2: a read that never answers used to keep "Checking your
  // current role and reporting populations…" on screen for good.
  it('ends a hung read at the deadline with the failure and Retry, stops it, and ignores its late reply', async () => {
    vi.useFakeTimers();
    let answer!: (value: ReturnType<typeof result>) => void; runtime.load.mockReturnValueOnce(new Promise<ReturnType<typeof result>>((done) => { answer = done; }));
    await render();
    expect(host.textContent).toContain('Checking your current role and reporting populations…');
    const signal = runtime.load.mock.calls[0]![4] as AbortSignal; expect(signal.aborted).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS); });
    expect(host.textContent).not.toContain('Checking your current role and reporting populations…');
    expect(host.textContent).toContain('Leadership Pulse could not load'); expect(signal.aborted).toBe(true);
    await act(async () => { answer(result('advisor', 1)); });
    expect(host.textContent).not.toContain('Tamarack campaign 00');
    await click('Retry leadership Pulse'); await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(host.textContent).toContain('Tamarack campaign 00'); expect(host.textContent).not.toContain('Leadership Pulse could not load');
  });
  it('does not paint a late failure after the app goes to the background', async () => {
    let reject!: (reason: Error) => void; runtime.load.mockReturnValueOnce(new Promise<ReturnType<typeof result>>((_, fail) => { reject = fail; }));
    await render(); await act(async () => { for (const listener of runtime.listeners) listener('background'); reject(new Error('old account')); });
    expect(host.textContent).not.toContain('Leadership Pulse could not load');
  });
  it('routes the real Pulse tab by the explicit held hat and withdraws leadership on ambiguity', async () => {
    runtime.app.authorizedRoles = ['steward']; await act(async () => { root.render(createElement(PulseScreen)); });
    expect(host.textContent).toContain('Committee route'); expect(runtime.load).not.toHaveBeenCalled();
    runtime.app.mode = 'preview'; runtime.app.previewHat = 'steward';
    await act(async () => { root.render(createElement(PulseScreen)); }); expect(host.textContent).toContain('Committee route');
    runtime.app.mode = 'authenticated'; runtime.app.previewHat = null;
    for (const hat of ['president', 'vp', 'advisor', 'coordinator', 'admin']) {
      runtime.app.authorizedRoles = [hat]; await act(async () => { root.render(createElement(PulseScreen)); });
      expect(runtime.load).toHaveBeenLastCalledWith(runtime.app.session, hat, 'org-a', 'chapter-a', expect.any(AbortSignal));
      expect(host.textContent).not.toContain('Worker route');
    }
    const calls = runtime.load.mock.calls.length;
    runtime.app.authorizedRoles = ['admin', 'vp']; await act(async () => { root.render(createElement(PulseScreen)); });
    expect(host.textContent).toContain('Worker route'); expect(runtime.load).toHaveBeenCalledTimes(calls);
    runtime.app.authorizedRoles = ['admin']; runtime.app.mode = 'preview'; runtime.app.previewHat = 'vp'; await act(async () => { root.render(createElement(PulseScreen)); });
    expect(host.textContent).toContain('No preview records'); expect(runtime.load).toHaveBeenCalledTimes(calls);
    runtime.app.previewHat = null; runtime.app.dashboard = null as never; await act(async () => { root.render(createElement(PulseScreen)); });
    expect(host.textContent).toContain('Campaign pulse');
  });
});

const C1 = '11111111-1111-4111-8111-111111111111';
const OPTIONS = ['fixed:actions', 'fixed:outcomes', 'fixed:poll', 'fixed:membership', 'fixed:meetings', 'fixed:turnout', 'fixed:reach', 'fixed:history-chapter-meeting_checkins', `saved:${C1}`];
const TITLES: Record<'membership' | 'meetings' | 'turnout' | 'reach', string> = { membership: 'Campaign membership', meetings: 'Can the campaign act?', turnout: 'Latest vote turnout', reach: 'Your published notice reach' };
type Entry = { key: string; pinned: boolean };
const entry = (key: string, pinned = false): Entry => ({ key, pinned });
// The standard set as entries: the cards and built charts drawn, then every
// other offered key, so no entry depends on what has loaded yet (r3s1 walk).
const EXTRA = ['fixed:actions', 'fixed:outcomes', 'fixed:poll', 'fixed:history-chapter-meeting_checkins'].map((key) => entry(key));
const STANDARD = [...['fixed:membership', 'fixed:meetings', 'fixed:turnout', 'fixed:reach', `saved:${C1}`].map((key) => entry(key)), ...EXTRA];
// Membership and meetings have figures; turnout is withheld under the floor and
// reach has nothing recorded, so neither may be drawn on a saved layout.
function president() {
  return leadershipPulse('president', { floors: { privacy: 25, chapterHealth: 25 },
    overview: { error: null, data: { memberCount: 60, newThisYear: 30, turnout: { totalVotes: 10, quorumTarget: 30 } } },
    events: { error: null, data: [{ id: 'e1', title: 'October meeting' }] }, quorum: { error: null, data: [{ eventId: 'e1', checkedIn: 30, quorum: 40 }] },
    notices: { error: null, data: [] }, receipts: { error: null, data: [] } }, date);
}
function answer(customized: boolean, entries: Entry[] = [], options = OPTIONS) { return { data: { customized, entries, options }, error: null }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function serve(read: () => unknown, write: (args: Record<string, unknown>) => unknown = () => ({ data: null, error: null })) {
  runtime.layoutRpc.mockImplementation((name: string, args: Record<string, unknown>) => Promise.resolve(name === 'get_pulse_layout' ? read() : write(args)));
}
const calls = (name: string) => runtime.layoutRpc.mock.calls.filter(([called]) => called === name).map(([, args]) => args);
const saves = () => calls('save_pulse_layout').map((args) => args.p_entries);
function outside() { const copy = host.cloneNode(true) as HTMLElement; copy.querySelectorAll('[role=dialog]').forEach((node) => node.remove()); return copy.textContent ?? ''; }
function drawn() { return Object.entries(TITLES).filter(([, title]) => Array.from(host.querySelectorAll('button')).some((button) => !button.closest('[role=dialog]') && (button.getAttribute('aria-label') ?? '').endsWith(`${title}. Expand chart`)))
  .map(([id, title]): [string, number] => [id, Array.from(host.querySelectorAll('button')).findIndex((button) => !button.closest('[role=dialog]') && (button.getAttribute('aria-label') ?? '').endsWith(`${title}. Expand chart`))])
  .sort((a, b) => a[1] - b[1]).map(([id]) => id); }
const sheet = () => host.querySelector('[role=dialog]')?.textContent ?? '';
const focused = () => (runtime.focus.mock.calls.at(-1)?.[0] as HTMLElement | undefined)?.getAttribute('aria-label') ?? (runtime.focus.mock.calls.at(-1)?.[0] as HTMLElement | undefined)?.textContent;
async function background() { await act(async () => { for (const listener of [...runtime.listeners]) listener('background'); }); }
async function resume() { await act(async () => { for (const listener of [...runtime.listeners]) listener('active'); }); }
async function settle() { await act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); }); }

describe('native leadership Pulse layout (#8927 slice 3)', () => {
  beforeEach(() => { runtime.load.mockResolvedValue(president()); runtime.charts = [{ id: C1, title: 'My built chart', pinned: false, figures: { rows: [{ label: '2026-11', value: 30 }] } }]; serve(() => answer(false)); });
  it('reads this person’s layout for the selected campaign and hat, and leaves the standard Pulse as it was', async () => {
    await render('president');
    expect(calls('get_pulse_layout')).toEqual([{ p_chapter_id: 'chapter-a', p_hat: 'president' }]);
    expect(runtime.layoutClients).toEqual([runtime.app.session]);
    expect(drawn()).toEqual(['membership', 'meetings', 'turnout', 'reach']);
    expect(outside()).toContain('Saved catalogue'); expect(outside()).not.toContain('order ['); expect(outside()).not.toContain('Pinned on your Pulse');
    expect(outside()).toContain('Customize your Pulse'); expect(saves()).toEqual([]);
  });
  it('moves, pins, takes off with undo, adds and goes back to the standard set, one write per change, with focus kept', async () => {
    await render('president'); await click('Customize your Pulse');
    expect(sheet()).toContain('On your Pulse'); expect(sheet()).toContain('Add to your Pulse');
    for (const title of [...Object.values(TITLES), 'My built chart']) expect(sheet()).toContain(title);
    // Option keys the phone draws no card for (the member cards) are not listed.
    expect(sheet()).not.toMatch(/actions|outcomes|poll/i);
    expect(Array.from(host.querySelectorAll('[role=dialog] button')).every((button) => (button.getAttribute('aria-label') ?? button.textContent ?? '').trim().length > 0)).toBe(true);
    expect((host.querySelector('[aria-label="Move Campaign membership up"]') as HTMLButtonElement).disabled).toBe(true);
    await click('Move Can the campaign act? up'); await settle();
    expect(saves()).toEqual([[entry('fixed:meetings'), entry('fixed:membership'), entry('fixed:turnout'), entry('fixed:reach'), entry(`saved:${C1}`), ...EXTRA]]);
    expect(focused()).toBe('Move Can the campaign act? down');
    await click('Pin Campaign membership above This week'); await settle();
    expect(saves().at(-1)).toEqual([entry('fixed:meetings'), entry('fixed:membership', true), entry('fixed:turnout'), entry('fixed:reach'), entry(`saved:${C1}`), ...EXTRA]);
    expect(focused()).toBe('Unpin Campaign membership');
    expect(sheet()).toContain('not on your Pulse right now');
    await click('Close');
    expect(outside().indexOf('Pinned on your Pulse')).toBeLessThan(outside().indexOf('This week'));
    expect(drawn()).toEqual(['membership', 'meetings']);
    expect(outside()).not.toContain(TITLES.turnout); expect(outside()).not.toContain(TITLES.reach);
    expect(outside()).toContain(`Saved catalogue order [${C1}]`);
    await click('Customize your Pulse'); await click('Take Can the campaign act? off your Pulse'); await settle();
    expect(saves().at(-1)).toEqual([entry('fixed:membership', true), entry('fixed:turnout'), entry('fixed:reach'), entry(`saved:${C1}`), ...EXTRA]);
    expect(sheet()).toContain('Can the campaign act? is off your Pulse. Undo is available for thirty seconds.');
    expect(focused()).toBe('Put Can the campaign act? back'); expect(sheet()).toContain('Add');
    await click('Put Can the campaign act? back'); await settle();
    expect(saves().at(-1)).toEqual([entry('fixed:meetings'), entry('fixed:membership', true), entry('fixed:turnout'), entry('fixed:reach'), entry(`saved:${C1}`), ...EXTRA]);
    expect(focused()).toBe('Take Can the campaign act? off your Pulse');
    // Built charts are moved here but stay on: their pin, Home and removal stay on their own card.
    expect(host.querySelector('[aria-label="Take My built chart off your Pulse"]')).toBeNull(); expect(host.querySelector('[aria-label="Add My built chart to your Pulse"]')).toBeNull();
    expect(host.querySelector('[aria-label="Pin My built chart above This week"]')).toBeNull(); expect(sheet()).toContain('Built charts stay on your Pulse.');
    await click('Back to the standard set'); await settle();
    expect(saves().at(-1)).toBeNull(); expect(focused()).toBe('Put your layout back');
    await click('Put your layout back'); await settle();
    expect(saves().at(-1)).toEqual([entry('fixed:meetings'), entry('fixed:membership', true), entry('fixed:turnout'), entry('fixed:reach'), entry(`saved:${C1}`), ...EXTRA]);
    expect(saves()).toHaveLength(6);
    // No copy names a fixed privacy floor.
    expect(sheet()).not.toMatch(/\b(10|25)\b/);
  });
  it('expires Undo after thirty seconds instead of writing', async () => {
    await render('president'); await click('Customize your Pulse'); await click('Take Campaign membership off your Pulse'); await settle();
    const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now + 30_000);
    try { await click('Put Campaign membership back'); await settle(); } finally { clock.mockRestore(); }
    expect(saves()).toHaveLength(1); expect(sheet()).toContain('Undo expired. You can add the chart again.');
    // The removed Undo button does not keep a screen reader: focus goes to the chart's Add.
    expect(focused()).toBe('Add Campaign membership to your Pulse');
  });
  it('withdraws Undo when a fresh read lands, so an old snapshot never overwrites a newer layout', async () => {
    await render('president'); await click('Customize your Pulse'); await click('Take Campaign membership off your Pulse'); await settle();
    expect(host.querySelector('[aria-label="Put Campaign membership back"]')).toBeTruthy();
    serve(() => answer(true, [entry('fixed:turnout', true), entry('fixed:meetings')]));
    await click('Refresh leadership Pulse'); await settle(); await click('Customize your Pulse');
    expect(host.querySelector('[aria-label="Put Campaign membership back"]')).toBeNull(); expect(sheet()).not.toContain('Undo is available');
    expect(saves()).toHaveLength(1);
  });
  it('draws a saved layout with skipped cards that the person can no longer see, and counts none of them', async () => {
    serve(() => answer(true, [entry('fixed:reach', true), entry('fixed:turnout'), entry('fixed:meetings'), entry(`saved:${C1}`)]));
    runtime.charts = [{ id: C1, title: 'My built chart', pinned: false, figures: { rows: [] } }];
    await render('president');
    expect(drawn()).toEqual(['meetings']); expect(outside()).not.toContain('Pinned on your Pulse');
    // A built chart is drawn as on Main, with its own withheld note and controls.
    expect(outside()).toContain(`Saved catalogue order [${C1}]`); expect(outside()).not.toMatch(/skipped|not shown|not on your Pulse|\d+ (of your )?(charts|cards)/i);
    await click('Customize your Pulse'); expect(sheet().match(/not on your Pulse right now/g)).toHaveLength(2); await click('Close');
    serve(() => answer(true, [])); runtime.charts = [];
    await click('Refresh leadership Pulse'); await settle();
    expect(drawn()).toEqual([]); expect(outside()).toContain('Your Pulse has no charts on it. Open Customize to add some.');
  });
  it('keeps a built chart on a saved layout that does not list it yet, so a chart built later never vanishes', async () => {
    serve(() => answer(true, [entry('fixed:membership')]));
    await render('president');
    expect(drawn()).toEqual(['membership']); expect(outside()).toContain(`Saved catalogue order [${C1}]`);
    await click('Customize your Pulse'); expect(sheet()).toContain('My built chart'); expect(sheet()).toContain('Add to your Pulse');
    await click('Add Can the campaign act? to your Pulse'); await settle();
    expect(saves()).toEqual([[entry('fixed:membership'), entry(`saved:${C1}`), entry('fixed:meetings')]]);
    expect(outside()).toContain(`Saved catalogue order [${C1}]`);
  });
  it('a lost save answer leaves the last saved layout, writes nothing more, and reads again after the deadline', async () => {
    serve(() => answer(true, [entry('fixed:membership', true), entry('fixed:meetings')]), () => new Promise(() => {}));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await render('president'); await settle(); await click('Customize your Pulse');
    await click('Move Can the campaign act? up'); await settle();
    expect(sheet().indexOf(TITLES.meetings)).toBeLessThan(sheet().indexOf(TITLES.membership));
    await click('Unpin Campaign membership'); await settle();
    expect(saves()).toHaveLength(1); expect(calls('get_pulse_layout')).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS); }); await settle();
    expect(sheet()).toContain('Your change didn’t save. Your last saved layout is shown.');
    expect(sheet().indexOf(TITLES.membership)).toBeLessThan(sheet().indexOf(TITLES.meetings)); expect(host.querySelector('[role=dialog] [aria-label="Unpin Campaign membership"]')).toBeTruthy();
    expect(saves()).toHaveLength(1); expect(calls('get_pulse_layout')).toHaveLength(2);
  });
  it('a layout read that is refused or never answers leaves the standard Pulse usable with a retry', async () => {
    serve(() => ({ data: null, error: { code: '42501', message: 'layout unavailable' } }));
    await render('president');
    expect(outside()).toContain('Your Pulse layout didn’t load. The standard Pulse is shown.'); expect(outside()).not.toContain('layout unavailable');
    expect(outside()).not.toContain('Customize your Pulse'); expect(drawn()).toEqual(['membership', 'meetings', 'turnout', 'reach']);
    serve(() => answer(true, [entry('fixed:meetings', true)])); await click('Retry your Pulse layout'); await settle();
    expect(drawn()).toEqual(['meetings']); expect(outside()).toContain('Customize your Pulse');
    // The last saved layout stays when a later read runs out of time.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); serve(() => new Promise(() => {}));
    await click('Refresh leadership Pulse'); await act(async () => { await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS); }); await settle();
    expect(outside()).toContain('Your Pulse layout didn’t load. Your last saved layout is shown.'); expect(drawn()).toEqual(['meetings']);
  });
  it('undo racing a save, and a resume during a save, send each layout once and read after the write', async () => {
    const first = deferred<{ data: null; error: null }>();
    serve(() => answer(false), (args) => saves().length === 1 ? first.promise : { data: null, error: null, args });
    await render('president'); await click('Customize your Pulse');
    await click('Take Your published notice reach off your Pulse'); await click('Put Your published notice reach back'); await settle();
    expect(saves()).toHaveLength(1);
    await act(async () => { first.resolve({ data: null, error: null }); }); await settle();
    // Undo from the standard set restores the standard set (r1s3), not a customized copy of it.
    expect(saves()).toEqual([STANDARD.filter((item) => item.key !== 'fixed:reach'), null]);
    expect(sheet().indexOf(TITLES.turnout)).toBeLessThan(sheet().indexOf(TITLES.reach));
    const held = deferred<{ data: null; error: null }>();
    serve(() => answer(true, STANDARD), () => held.promise);
    await click('Move Campaign membership down'); await settle(); const reads = calls('get_pulse_layout').length;
    await background(); expect(host.querySelector('[role=dialog]')).toBeNull(); await resume(); await settle();
    expect(calls('get_pulse_layout')).toHaveLength(reads);
    await act(async () => { held.resolve({ data: null, error: null }); }); await settle();
    expect(calls('get_pulse_layout')).toHaveLength(reads + 1); expect(saves()).toHaveLength(3);
  });
  it('never shows or saves one account’s or campaign’s layout for another, and a changed role reads again', async () => {
    const held = deferred<{ data: null; error: null }>();
    serve(() => answer(true, [entry('fixed:membership', true), entry('fixed:meetings')]), () => held.promise);
    await render('president'); expect(outside()).toContain('Pinned on your Pulse');
    await click('Customize your Pulse'); await click('Move Can the campaign act? up'); await click('Unpin Campaign membership'); await settle();
    const nextRead = deferred<unknown>();
    serve(() => nextRead.promise, () => ({ data: null, error: null }));
    runtime.app.dashboard = { member: { chapterID: 'chapter-b' } }; await render('president'); await settle();
    expect(outside()).not.toContain('Pinned on your Pulse'); expect(host.querySelector('[role=dialog]')).toBeNull();
    await act(async () => { held.resolve({ data: null, error: null }); }); await settle();
    expect(calls('get_pulse_layout').at(-1)).toEqual({ p_chapter_id: 'chapter-b', p_hat: 'president' });
    await act(async () => { nextRead.resolve(answer(false)); }); await settle();
    expect(outside()).not.toContain('Pinned on your Pulse'); expect(calls('save_pulse_layout').every((args) => args.p_chapter_id === 'chapter-a')).toBe(true); expect(saves()).toHaveLength(1);
    runtime.app.session = { access_token: 'other', user: { id: 'person-b' } }; runtime.app.organizationID = 'org-b'; await render('president'); await settle();
    expect(runtime.layoutClients.at(-1)).toBe(runtime.app.session);
    await render('vp'); await settle(); expect(calls('get_pulse_layout').at(-1)).toEqual({ p_chapter_id: 'chapter-b', p_hat: 'vp' });
  });
  it('withdraws Undo and every Customize control while a fresh read is out, so nothing pressed then can overwrite it (r1s1, r2s1)', async () => {
    await render('president'); await click('Customize your Pulse'); await click('Take Campaign membership off your Pulse'); await settle(); await click('Close');
    const fresh = deferred<unknown>(); serve(() => fresh.promise);
    await click('Refresh leadership Pulse'); await settle(); await click('Customize your Pulse');
    expect(sheet()).toContain('Checking your Pulse layout…');
    for (const name of ['Put Campaign membership back', 'Move Can the campaign act? up', 'Pin Can the campaign act? above This week', 'Take Can the campaign act? off your Pulse', 'Back to the standard set']) {
      expect(Array.from(host.querySelectorAll('[role=dialog] button')).some((button) => button.getAttribute('aria-label') === name || button.textContent === name), name).toBe(false);
    }
    await act(async () => { fresh.resolve(answer(true, [entry('fixed:turnout', true)])); }); await settle();
    expect(sheet()).not.toContain('Checking your Pulse layout…'); expect(host.querySelector('[aria-label="Unpin Latest vote turnout"]')).toBeTruthy();
    expect(host.querySelector('[aria-label="Put Campaign membership back"]')).toBeNull(); expect(saves()).toHaveLength(1);
    await click('Add Can the campaign act? to your Pulse'); await settle();
    // The next change builds on the layout just read, not on the old snapshot.
    expect(saves()).toHaveLength(2); expect(saves().at(-1)).toEqual([entry('fixed:turnout', true), entry(`saved:${C1}`), entry('fixed:meetings')]);
  });
  it('reads the layout again when built charts are added or removed, and holds edits until it lands (r1s2, r2s2)', async () => {
    serve(() => answer(true, [entry('fixed:membership'), entry(`saved:${C1}`)]));
    await render('president'); expect(calls('get_pulse_layout')).toHaveLength(1);
    const after = deferred<unknown>(); serve(() => after.promise);
    runtime.charts = []; await render('president'); await settle();
    expect(calls('get_pulse_layout')).toHaveLength(2);
    await click('Customize your Pulse'); expect(sheet()).toContain('Checking your Pulse layout…'); expect(host.querySelector('[aria-label="Pin Campaign membership above This week"]')).toBeNull();
    await act(async () => { after.resolve(answer(true, [entry('fixed:membership')], OPTIONS.filter((key) => key !== `saved:${C1}`))); }); await settle();
    await click('Pin Campaign membership above This week'); await settle();
    expect(saves()).toEqual([[entry('fixed:membership', true)]]);
    await click('Close');
    const C2 = '22222222-2222-4222-8222-222222222222';
    serve(() => answer(true, [entry('fixed:membership', true)], [...OPTIONS.filter((key) => key !== `saved:${C1}`), `saved:${C2}`]));
    runtime.charts = [{ id: C2, title: 'My second chart', pinned: false, figures: { rows: [{ label: '2026-11', value: 30 }] } }]; await render('president'); await settle();
    expect(calls('get_pulse_layout')).toHaveLength(3);
    await click('Customize your Pulse'); expect(host.querySelector('[aria-label="Move My second chart up"]')).toBeTruthy();
  });
  it('withdraws Customize through the real chart-list reload, then reads again before a smaller set can be edited (r3s1, r4s1)', async () => {
    serve(() => answer(true, [entry('fixed:membership'), entry(`saved:${C1}`)]));
    await render('president'); await click('Customize your Pulse'); expect(host.querySelector('[aria-label="Pin Campaign membership above This week"]')).toBeTruthy();
    // The saved-chart list reloads after a removal: for a while it is not known.
    runtime.charts = null; runtime.chartStatus = 'pending'; await render('president'); await settle();
    // Pending: bounded by the list's read deadline, and the line names no control.
    expect(sheet()).toContain('Checking your built charts…'); expect(sheet()).not.toContain('Retry'); expect(host.querySelector('[aria-label="Pin Campaign membership above This week"]')).toBeNull();
    expect(saves()).toEqual([]); expect(calls('get_pulse_layout')).toHaveLength(1);
    const after = deferred<unknown>(); serve(() => after.promise);
    runtime.charts = []; runtime.chartStatus = 'known'; await render('president'); await settle();
    expect(calls('get_pulse_layout')).toHaveLength(2); expect(host.querySelector('[aria-label="Pin Campaign membership above This week"]')).toBeNull();
    await act(async () => { after.resolve(answer(true, [entry('fixed:membership')], OPTIONS.filter((key) => key !== `saved:${C1}`))); }); await settle();
    await click('Pin Campaign membership above This week'); await settle();
    expect(saves()).toEqual([[entry('fixed:membership', true)]]);
  });
  it('withdraws Customize through the reload before a larger set, then gives the new chart its controls (r3s1, r4s1)', async () => {
    const C2 = '22222222-2222-4222-8222-222222222222';
    serve(() => answer(true, [entry('fixed:membership'), entry(`saved:${C1}`)]));
    await render('president'); await click('Customize your Pulse');
    runtime.charts = null; runtime.chartStatus = 'pending'; await render('president'); await settle();
    expect(host.querySelector('[aria-label="Move Campaign membership down"]')).toBeNull(); expect(calls('get_pulse_layout')).toHaveLength(1);
    serve(() => answer(true, [entry('fixed:membership'), entry(`saved:${C1}`)], [...OPTIONS, `saved:${C2}`]));
    runtime.chartStatus = 'known'; runtime.charts = [{ id: C1, title: 'My built chart', pinned: false, figures: { rows: [{ label: '2026-11', value: 30 }] } }, { id: C2, title: 'My second chart', pinned: false, figures: { rows: [{ label: '2026-11', value: 30 }] } }];
    await render('president'); await settle();
    expect(calls('get_pulse_layout')).toHaveLength(2); expect(host.querySelector('[aria-label="Move My second chart up"]')).toBeTruthy();
    await click('Pin Campaign membership above This week'); await settle();
    expect(saves()).toEqual([[entry('fixed:membership', true), entry(`saved:${C1}`), entry(`saved:${C2}`)]]);
  });
  it('after a failed list read names the Retry that is on screen, and is editable again once Retry answers (#9394 r1s1)', async () => {
    serve(() => answer(true, [entry('fixed:membership'), entry(`saved:${C1}`)]));
    await render('president');
    runtime.charts = null; runtime.chartStatus = 'failed'; await render('president'); await click('Refresh leadership Pulse'); await settle(); await click('Customize your Pulse');
    expect(sheet()).toContain('Your built charts didn’t load. Close this and choose Retry saved charts.');
    expect(Array.from(host.querySelectorAll('[role=dialog] button')).map((button) => button.textContent)).toEqual(['Close']);
    expect(saves()).toEqual([]);
    // Retry saved charts answers with the same set: the layout is read again, then Customize returns.
    const reads = calls('get_pulse_layout').length;
    runtime.chartStatus = 'known'; runtime.charts = [{ id: C1, title: 'My built chart', pinned: false, figures: { rows: [{ label: '2026-11', value: 30 }] } }];
    await render('president'); await settle();
    expect(calls('get_pulse_layout')).toHaveLength(reads + 1);
    await click('Pin Campaign membership above This week'); await settle();
    expect(saves()).toEqual([[entry('fixed:membership', true), entry(`saved:${C1}`)]]);
  });
  it('a write already sent that lands during the pause is never called unsaved, and the line clears when the read shows it (probe A)', async () => {
    const sent = deferred<{ data: null; error: null }>();
    serve(() => answer(true, [entry('fixed:membership'), entry(`saved:${C1}`)]), () => sent.promise);
    await render('president'); await click('Customize your Pulse');
    await click('Pin Campaign membership above This week'); await settle();
    runtime.charts = null; runtime.chartStatus = 'pending'; await render('president'); await settle();
    expect(sheet()).toContain('Your built charts were being checked, so your last change may not have saved. Your saved layout is shown.'); expect(sheet()).not.toContain('Your change didn’t save');
    await act(async () => { sent.resolve({ data: null, error: null }); }); await settle();
    // Refresh saved charts brings back the same set; the owed read shows the pin saved.
    serve(() => answer(true, [entry('fixed:membership', true), entry(`saved:${C1}`)]));
    runtime.chartStatus = 'known'; runtime.charts = [{ id: C1, title: 'My built chart', pinned: false, figures: { rows: [{ label: '2026-11', value: 30 }] } }];
    await render('president'); await settle();
    expect(host.querySelector('[aria-label="Unpin Campaign membership"]')).toBeTruthy();
    expect(sheet()).not.toContain('may not have saved'); expect(sheet()).not.toContain('didn’t save');
  });
  it('shows no Checking line beside a failed owed read (#9394 read P3)', async () => {
    serve(() => answer(true, [entry('fixed:membership'), entry(`saved:${C1}`)]));
    await render('president'); await click('Customize your Pulse');
    runtime.charts = null; runtime.chartStatus = 'pending'; await render('president'); await settle();
    serve(() => ({ data: null, error: { code: '57014' } }));
    runtime.chartStatus = 'known'; runtime.charts = [{ id: C1, title: 'My built chart', pinned: false, figures: { rows: [{ label: '2026-11', value: 30 }] } }];
    await render('president'); await settle();
    expect(sheet()).toContain('Your Pulse layout didn’t load.'); expect(sheet()).not.toContain('Checking your Pulse layout…');
    serve(() => answer(true, [entry('fixed:membership'), entry(`saved:${C1}`)])); await click('Retry your Pulse layout'); await settle();
    expect(host.querySelector('[aria-label="Pin Campaign membership above This week"]')).toBeTruthy();
  });
  it('drops a write still queued when the chart list goes unknown, withdraws the draft and Undo with a line that is true either way, and reads before editing (#9394 r1s3)', async () => {
    const sent = deferred<{ data: null; error: null }>();
    serve(() => answer(true, [entry('fixed:membership'), entry(`saved:${C1}`)]), () => sent.promise);
    await render('president'); await click('Customize your Pulse');
    await click('Pin Campaign membership above This week'); await settle();
    await click('Take Campaign membership off your Pulse'); await settle();
    expect(saves()).toHaveLength(1); expect(host.querySelector('[aria-label="Put Campaign membership back"]')).toBeTruthy();
    runtime.charts = null; runtime.chartStatus = 'pending'; await render('president'); await settle();
    // The pause cannot know whether the write already out will land, so its line says only what is true.
    expect(sheet()).toContain('Your built charts were being checked, so your last change may not have saved. Your saved layout is shown.'); expect(sheet()).not.toContain('Your change didn’t save'); expect(host.querySelector('[aria-label="Put Campaign membership back"]')).toBeNull();
    await act(async () => { sent.resolve({ data: null, error: null }); }); await settle();
    // The queued take-off was dropped, never sent behind the write already out.
    expect(saves()).toHaveLength(1);
    serve(() => answer(true, [entry('fixed:membership', true), entry(`saved:${C1}`)]), () => ({ data: null, error: null }));
    const reads = calls('get_pulse_layout').length;
    runtime.chartStatus = 'known'; runtime.charts = [{ id: C1, title: 'My built chart', pinned: false, figures: { rows: [{ label: '2026-11', value: 30 }] } }];
    await render('president'); await settle();
    expect(calls('get_pulse_layout')).toHaveLength(reads + 1); expect(host.querySelector('[aria-label="Unpin Campaign membership"]')).toBeTruthy();
  });
  it('a first change before weekly history loads keeps the history card on (r3s1 walk: cards)', async () => {
    const weekly = deferred<unknown>(); runtime.history.mockReturnValue(weekly.promise);
    await render('president'); await click('Customize your Pulse'); await click('Take Latest vote turnout off your Pulse'); await settle();
    expect(saves().at(-1)).toContainEqual(entry('fixed:history-chapter-meeting_checkins'));
    await act(async () => { weekly.resolve([{ id: 'history-chapter-meeting_checkins', number: 'W1', title: 'Meeting check-ins by week', category: 'meetings', period: 'Since the week of Nov 2 · ET', countedFrom: 'stored weeks.', notCounted: 'Drafts excluded.', rows: [{ label: 'Nov 2', value: 27 }] }]); }); await settle();
    await click('Close'); expect(outside()).toContain('Meeting check-ins by week');
  });
  it('Take off then Undo from the standard set restores the standard set (r1s3)', async () => {
    await render('president'); await click('Customize your Pulse'); await click('Take Campaign membership off your Pulse'); await settle();
    expect(drawn()).toEqual(['meetings']);
    await click('Put Campaign membership back'); await settle();
    expect(saves()).toEqual([STANDARD.filter((item) => item.key !== 'fixed:membership'), null]);
    expect(drawn()).toEqual(['membership', 'meetings', 'turnout', 'reach']); expect(focused()).toBe('Take Campaign membership off your Pulse');
  });
  it('reads no layout and offers no Customize for a chapterless advisor or a restricted session', async () => {
    runtime.load.mockResolvedValue(result()); runtime.app.dashboard = { member: { chapterID: null } } as never; await render('advisor');
    expect(runtime.layoutRpc).not.toHaveBeenCalled(); expect(outside()).not.toContain('Customize your Pulse'); expect(outside()).not.toContain('Pulse layout');
    runtime.app.dashboard = { member: { chapterID: 'chapter-a' } }; runtime.app.sessionRestricted = true; await render('advisor');
    expect(runtime.layoutRpc).not.toHaveBeenCalled();
  });
});

// A Customize change that a fresh read,
// a pause or a remount withdraws before the session sends it, or whose write
// fails while it is withdrawn, never ends without a line. The line is the
// existing didn't-save line: the queued write is never sent, and a write that
// failed is the existing failed-save case. The built-charts line is kept for
// the chart-list pause, where it is the true one.
const NOT_SAVED = 'Your change didn’t save. Your last saved layout is shown.';
const MOVED = [entry('fixed:meetings'), entry('fixed:membership'), ...STANDARD.slice(2)];
describe.each<'ios' | 'android'>(['ios', 'android'])('native Pulse Customize: a withdrawn change is never dropped without a line (ledger 660) on %s', (os) => {
  beforeEach(() => { runtime.os = os; runtime.load.mockResolvedValue(president()); runtime.charts = [{ id: C1, title: 'My built chart', pinned: false, figures: { rows: [{ label: '2026-11', value: 30 }] } }]; });
  // A move is out, a pin is queued behind it; the person then does something that withdraws the pin.
  async function moveOutPinQueued() {
    const held = deferred<{ data: null; error: unknown }>();
    serve(() => answer(false), () => held.promise);
    await render('president'); await click('Customize your Pulse');
    await click('Move Campaign membership down'); await settle();
    await click('Pin Campaign membership above This week'); await settle();
    expect(saves()).toHaveLength(1);
    return held;
  }
  it('Refresh with the chart set unchanged: the queued pin is never sent, and the line says it didn’t save (r3s2)', async () => {
    const held = await moveOutPinQueued();
    serve(() => answer(true, MOVED), () => held.promise);
    await click('Refresh leadership Pulse'); await settle();
    await act(async () => { held.resolve({ data: null, error: null }); }); await settle();
    expect(saves()).toEqual([MOVED]); expect(calls('get_pulse_layout')).toHaveLength(2);
    expect(outside()).toContain(NOT_SAVED); expect(outside()).not.toContain('may not have saved');
    await click('Customize your Pulse');
    expect(sheet()).toContain(NOT_SAVED); expect(sheet().indexOf(TITLES.meetings)).toBeLessThan(sheet().indexOf(TITLES.membership));
    // The pin is not on, and pressing it again clears the line as any new change does.
    await click('Pin Campaign membership above This week'); await settle();
    expect(saves()).toHaveLength(2); expect(sheet()).not.toContain(NOT_SAVED);
  });
  it('a write already out that fails while a fresh read waits behind it gets the line; one that lands gets none', async () => {
    const failing = deferred<{ data: null; error: unknown }>();
    serve(() => answer(false), () => failing.promise);
    await render('president'); await click('Customize your Pulse'); await click('Move Campaign membership down'); await settle();
    await click('Refresh leadership Pulse'); await settle();
    await act(async () => { failing.resolve({ data: null, error: { code: '57014' } }); }); await settle();
    expect(outside()).toContain(NOT_SAVED); expect(calls('get_pulse_layout')).toHaveLength(2);
    const landing = deferred<{ data: null; error: unknown }>();
    serve(() => answer(false), () => landing.promise);
    await click('Customize your Pulse'); await click('Move Campaign membership down'); await settle();
    serve(() => answer(true, MOVED), () => landing.promise);
    await click('Refresh leadership Pulse'); await settle();
    await act(async () => { landing.resolve({ data: null, error: null }); }); await settle();
    expect(outside()).not.toContain('didn’t save'); expect(outside()).not.toContain('may not have saved');
  });
  it('going to the background drops the queued pin and the line is there on return', async () => {
    const held = await moveOutPinQueued();
    serve(() => answer(true, MOVED), () => held.promise);
    await background(); await resume();
    await act(async () => { held.resolve({ data: null, error: null }); }); await settle();
    expect(saves()).toEqual([MOVED]); expect(outside()).toContain(NOT_SAVED);
  });
  it('a token refresh remounts the screen: the queued pin is never sent and the new screen says so', async () => {
    const held = await moveOutPinQueued();
    serve(() => answer(true, MOVED), () => held.promise);
    runtime.app.session = { access_token: 'refreshed', user: { id: 'person-a' } }; await render('president'); await settle();
    expect(host.querySelector('[role=dialog]')).toBeNull();
    await act(async () => { held.resolve({ data: null, error: null }); }); await settle();
    expect(saves()).toEqual([MOVED]); expect(outside()).toContain(NOT_SAVED);
    // Another person signing in on this phone never sees it, and it is gone after.
    runtime.app.session = { access_token: 'other', user: { id: 'person-b' } }; await render('president'); await settle();
    expect(outside()).not.toContain('didn’t save');
    runtime.app.session = { access_token: 'again', user: { id: 'person-a' } }; await render('president'); await settle();
    expect(outside()).not.toContain('didn’t save');
  });
  it('a hat or campaign change shows the line on that same layout when the person is back on it, never on another', async () => {
    const held = await moveOutPinQueued();
    serve(() => answer(false), () => held.promise);
    await render('vp'); await settle();
    await act(async () => { held.resolve({ data: null, error: null }); }); await settle();
    expect(outside()).not.toContain('didn’t save');
    runtime.app.dashboard = { member: { chapterID: 'chapter-b' } }; await render('president'); await settle();
    expect(outside()).not.toContain('didn’t save');
    runtime.app.dashboard = { member: { chapterID: 'chapter-a' } }; await render('president'); await settle();
    expect(outside()).toContain(NOT_SAVED); expect(saves()).toEqual([MOVED]);
  });
  it('a line shown on a screen that then remounts before the person returns is carried, and stays while the read shows the change did not land', async () => {
    const held = await moveOutPinQueued();
    // A tab switch: the chart list reloads while the move is out, so the existing line is shown on a screen the person has left.
    runtime.charts = null; runtime.chartStatus = 'pending'; await render('president'); await settle();
    expect(outside()).toContain('may not have saved');
    await act(async () => { held.resolve({ data: null, error: null }); }); await settle();
    serve(() => answer(true, MOVED));
    runtime.app.session = { access_token: 'refreshed', user: { id: 'person-a' } }; await render('president'); await settle();
    expect(outside()).toContain('may not have saved');
    runtime.chartStatus = 'known'; runtime.charts = [{ id: C1, title: 'My built chart', pinned: false, figures: { rows: [{ label: '2026-11', value: 30 }] } }];
    await render('president'); await settle();
    // The owed read shows the move, not the pin, so the line stays.
    expect(outside()).toContain('may not have saved'); expect(saves()).toEqual([MOVED]);
  });
  it('a move that runs out of time during Refresh but that the server kept gets no didn’t-save line once the read shows it (R-660 P2-a)', async () => {
    serve(() => answer(false), () => new Promise(() => {}));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await render('president'); await settle(); await click('Customize your Pulse');
    await click('Move Campaign membership down'); await settle();
    serve(() => answer(true, MOVED), () => new Promise(() => {}));
    await click('Refresh leadership Pulse'); await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS); }); await settle();
    expect(calls('get_pulse_layout')).toHaveLength(2); expect(saves()).toEqual([MOVED]);
    expect(outside()).not.toContain('didn’t save');
    await click('Customize your Pulse'); expect(sheet().indexOf(TITLES.meetings)).toBeLessThan(sheet().indexOf(TITLES.membership));
  });
  it('a line an old session leaves after a token refresh is dropped when the new screen already saved a newer change (R-660 P2-b)', async () => {
    const held = await moveOutPinQueued();
    serve(() => answer(false));
    runtime.app.session = { access_token: 'refreshed', user: { id: 'person-a' } }; await render('president'); await settle();
    await click('Customize your Pulse'); await click('Pin Can the campaign act? above This week'); await settle();
    expect(saves()).toHaveLength(2);
    await act(async () => { held.resolve({ data: null, error: null }); }); await settle();
    expect(outside()).not.toContain('didn’t save'); expect(sheet()).not.toContain('didn’t save');
  });
  it('a carried line is shown on the next screen only, not on every later remount (R-660 P3)', async () => {
    const held = await moveOutPinQueued();
    serve(() => answer(true, MOVED), () => held.promise);
    runtime.app.session = { access_token: 'refreshed', user: { id: 'person-a' } }; await render('president'); await settle();
    await act(async () => { held.resolve({ data: null, error: null }); }); await settle();
    expect(outside()).toContain(NOT_SAVED);
    runtime.app.session = { access_token: 'refreshed-again', user: { id: 'person-a' } }; await render('president'); await settle();
    expect(outside()).not.toContain('didn’t save');
  });
  it('a failure an old screen owes after a token refresh is dropped when the new screen’s read already showed that layout saved (#9402 r1s1, r2s1)', async () => {
    serve(() => answer(false), () => new Promise(() => {}));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await render('president'); await settle(); await click('Customize your Pulse');
    // The server keeps the move, but its answer never comes.
    await click('Move Campaign membership down'); await settle();
    serve(() => answer(true, MOVED));
    runtime.app.session = { access_token: 'refreshed', user: { id: 'person-a' } }; await render('president'); await settle();
    await click('Customize your Pulse'); expect(sheet().indexOf(TITLES.meetings)).toBeLessThan(sheet().indexOf(TITLES.membership)); await click('Close');
    await act(async () => { await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS); }); await settle();
    expect(saves()).toEqual([MOVED]); expect(outside()).not.toContain('didn’t save');
  });
  it('one pin the chart-list pause names keeps that one line when a token refresh remounts before the write ahead of it settles (#9402 r1s2, r2s2)', async () => {
    const held = await moveOutPinQueued();
    runtime.charts = null; runtime.chartStatus = 'pending'; await render('president'); await settle();
    expect(outside()).toContain('may not have saved');
    runtime.app.session = { access_token: 'refreshed', user: { id: 'person-a' } }; await render('president'); await settle();
    await act(async () => { held.resolve({ data: null, error: null }); }); await settle();
    expect(saves()).toEqual([MOVED]); expect(outside()).toContain('may not have saved'); expect(outside()).not.toContain('didn’t save');
  });
  it('a carried line that a screen could not draw (its figures did not load) is carried again to the next screen (#9402 r1s3)', async () => {
    const held = await moveOutPinQueued();
    serve(() => answer(true, MOVED), () => held.promise);
    runtime.load.mockRejectedValue(new Error('figures unavailable'));
    runtime.app.session = { access_token: 'refreshed', user: { id: 'person-a' } }; await render('president'); await settle();
    await act(async () => { held.resolve({ data: null, error: null }); }); await settle();
    expect(outside()).toContain('Leadership Pulse could not load'); expect(outside()).not.toContain('didn’t save');
    runtime.load.mockResolvedValue(president());
    runtime.app.session = { access_token: 'refreshed-again', user: { id: 'person-a' } }; await render('president'); await settle();
    expect(outside()).toContain(NOT_SAVED);
  });
  // Queued edits that coalesce
  // share one refusal, but an unmounted screen owes one line, for its latest edit.
  it('pin then unpin queued behind a move, then a token refresh: no false didn’t-save over the moved layout the server holds (ledger 666)', async () => {
    const held = await moveOutPinQueued();
    await click('Unpin Campaign membership'); await settle();
    serve(() => answer(true, MOVED));
    runtime.app.session = { access_token: 'refreshed', user: { id: 'person-a' } }; await render('president'); await settle();
    await act(async () => { held.resolve({ data: null, error: null }); }); await settle();
    expect(saves()).toEqual([MOVED]); expect(outside()).not.toContain('didn’t save');
  });
  it('three edits, the last two queued, whose latest equals what the first saved: no false line after a token refresh (ledger 666)', async () => {
    const held = deferred<{ data: null; error: unknown }>();
    const PINNED = [entry('fixed:membership', true), ...STANDARD.slice(1)];
    serve(() => answer(false), () => held.promise);
    await render('president'); await click('Customize your Pulse');
    await click('Pin Campaign membership above This week'); await settle();
    await click('Unpin Campaign membership'); await settle();
    await click('Pin Campaign membership above This week'); await settle();
    expect(saves()).toEqual([PINNED]);
    serve(() => answer(true, PINNED));
    runtime.app.session = { access_token: 'refreshed', user: { id: 'person-a' } }; await render('president'); await settle();
    await act(async () => { held.resolve({ data: null, error: null }); }); await settle();
    expect(outside()).not.toContain('didn’t save');
  });
  it('a lost latest edit after several queued ones is still told, once (ledger 666)', async () => {
    const held = await moveOutPinQueued();
    await click('Unpin Campaign membership'); await settle();
    await click('Pin Can the campaign act? above This week'); await settle();
    serve(() => answer(true, MOVED));
    runtime.app.session = { access_token: 'refreshed', user: { id: 'person-a' } }; await render('president'); await settle();
    await act(async () => { held.resolve({ data: null, error: null }); }); await settle();
    expect(saves()).toEqual([MOVED]); expect(outside().split(NOT_SAVED)).toHaveLength(2);
  });
  it('move held, pin and Back to the standard set queued, token refresh, the new screen reads the standard layout, then the old move commits: the line shows (#9405 final r3s1)', async () => {
    const held = await moveOutPinQueued();
    await click('Back to the standard set'); await settle();
    serve(() => answer(false));
    runtime.app.session = { access_token: 'refreshed', user: { id: 'person-a' } }; await render('president'); await settle();
    expect(outside()).not.toContain('didn’t save');
    // The old move commits after the new screen's read: the server now holds it.
    serve(() => answer(true, MOVED));
    await act(async () => { held.resolve({ data: null, error: null }); }); await settle();
    expect(saves()).toEqual([MOVED]); expect(outside().split(NOT_SAVED)).toHaveLength(2);
  });
  it('a carried may-not-have-saved line is not cleared by a read from before the old screen’s write settled (#9405 final r3s1, class)', async () => {
    const held = deferred<{ data: null; error: unknown }>();
    serve(() => answer(true, STANDARD), () => held.promise);
    await render('president'); await click('Customize your Pulse');
    await click('Move Campaign membership down'); await settle();
    await click('Move Campaign membership up'); await settle();
    runtime.charts = null; runtime.chartStatus = 'pending'; await render('president'); await settle();
    expect(outside()).toContain('may not have saved');
    runtime.app.session = { access_token: 'refreshed', user: { id: 'person-a' } }; await render('president'); await settle();
    // This read predates the old move, so it cannot say the person's last layout is saved.
    expect(outside()).toContain('may not have saved');
    serve(() => answer(true, MOVED));
    await act(async () => { held.resolve({ data: null, error: null }); }); await settle();
    expect(saves()).toEqual([MOVED]); expect(outside()).toContain('may not have saved');
  });
  // R-9405S Q1 and its variant: two old screens with writes out. A carried
  // line is decided only once every old screen of this layout has settled.
  function writesInOrder() {
    const writes = [deferred<{ data: null; error: unknown }>(), deferred<{ data: null; error: unknown }>(), deferred<{ data: null; error: unknown }>()];
    const state = { server: answer(false) as unknown, sent: 0 };
    runtime.layoutRpc.mockImplementation((name: string) => name === 'get_pulse_layout' ? Promise.resolve(state.server) : writes[state.sent++]!.promise);
    return { writes, state };
  }
  it('two old screens with writes out: the first one settling does not clear a carried line the second still owes (R-9405S Q1)', async () => {
    const { writes, state } = writesInOrder();
    await render('president'); await click('Customize your Pulse'); await click('Move Campaign membership down'); await settle();
    runtime.app.session = { access_token: 's2', user: { id: 'person-a' } }; await render('president'); await settle();
    await click('Customize your Pulse');
    await click('Pin Can the campaign act? above This week'); await settle();
    await click('Unpin Can the campaign act?'); await settle();
    await click('Move Campaign membership down'); await settle();
    runtime.charts = null; runtime.chartStatus = 'pending'; await render('president'); await settle();
    expect(outside()).toContain('may not have saved');
    runtime.app.session = { access_token: 's3', user: { id: 'person-a' } }; await render('president'); await settle();
    state.server = answer(true, MOVED); await act(async () => { writes[0]!.resolve({ data: null, error: null }); }); await settle();
    expect(outside()).toContain('may not have saved');
    state.server = answer(true, [STANDARD[0]!, entry('fixed:meetings', true), ...STANDARD.slice(2)]);
    await act(async () => { writes[1]!.resolve({ data: null, error: null }); }); await settle();
    expect(saves()).toHaveLength(2); expect(outside()).toContain('may not have saved');
  });
  it('an older screen’s write with no line still holds the decision of a line a middle screen owes (R-9405S variant)', async () => {
    const { writes, state } = writesInOrder();
    state.server = answer(true, STANDARD);
    await render('president'); await click('Customize your Pulse'); await click('Move Campaign membership down'); await settle();
    runtime.app.session = { access_token: 's1', user: { id: 'person-a' } }; await render('president'); await settle();
    await click('Customize your Pulse');
    await click('Pin Campaign membership above This week'); await settle();
    await click('Unpin Campaign membership'); await settle();
    runtime.app.session = { access_token: 's2', user: { id: 'person-a' } }; await render('president'); await settle();
    // The middle screen's pin fails, so its unpin is refused: it owes a line for the standard set, which the server still holds.
    await act(async () => { writes[1]!.resolve({ data: null, error: { code: '57014' } }); }); await settle();
    expect(outside()).not.toContain('didn’t save');
    // The oldest screen's move then lands, so the person's last choice is not what the server holds.
    state.server = answer(true, MOVED); await act(async () => { writes[0]!.resolve({ data: null, error: null }); }); await settle();
    expect(saves()).toHaveLength(2); expect(outside().split(NOT_SAVED)).toHaveLength(2);
  });
  // #9409 r2s1: lines owed by several old screens are ordered by edit, not by arrival.
  const refreshAs = async (token: string) => { runtime.app.session = { access_token: token, user: { id: 'person-a' } }; await render('president'); await settle(); };
  async function oldScreensAB() {
    const order = writesInOrder();
    await render('president'); await click('Customize your Pulse');
    await click('Move Campaign membership down'); await settle();
    await click('Pin Campaign membership above This week'); await settle();
    await click('Unpin Campaign membership'); await settle();
    await refreshAs('b'); await click('Customize your Pulse');
    await click('Pin Campaign membership above This week'); await settle();
    await click('Unpin Campaign membership'); await settle();
    return order;
  }
  it('three screens: the oldest screen’s refusal arriving last never replaces the line owed for the newest choice (#9409 r2s1)', async () => {
    const { writes, state } = await oldScreensAB();
    await refreshAs('c');
    await act(async () => { writes[1]!.resolve({ data: null, error: { code: '57014' } }); }); await settle();
    state.server = answer(true, MOVED); await act(async () => { writes[0]!.resolve({ data: null, error: null }); }); await settle();
    expect(saves()).toHaveLength(2); expect(outside().split(NOT_SAVED)).toHaveLength(2);
  });
  it('three screens, the two refusals in the other order: the line owed for the newest choice still shows once (#9409 r2s1)', async () => {
    const { writes, state } = await oldScreensAB();
    await refreshAs('c');
    state.server = answer(true, MOVED); await act(async () => { writes[0]!.resolve({ data: null, error: null }); }); await settle();
    expect(outside()).not.toContain('didn’t save');
    await act(async () => { writes[1]!.resolve({ data: null, error: { code: '57014' } }); }); await settle();
    expect(saves()).toHaveLength(2); expect(outside().split(NOT_SAVED)).toHaveLength(2);
  });
  it('four screens: the newest choice saved, so the older refusals arriving after it show no line (#9409 r2s1)', async () => {
    const { writes, state } = await oldScreensAB();
    await refreshAs('c'); await click('Customize your Pulse');
    await click('Pin Campaign membership above This week'); await settle();
    await refreshAs('d');
    const PINNED = [entry('fixed:membership', true), ...STANDARD.slice(1)];
    state.server = answer(true, PINNED); await act(async () => { writes[2]!.resolve({ data: null, error: null }); }); await settle();
    await act(async () => { writes[1]!.resolve({ data: null, error: { code: '57014' } }); }); await settle();
    await act(async () => { writes[0]!.resolve({ data: null, error: { code: '57014' } }); }); await settle();
    expect(saves()).toHaveLength(3); expect(outside()).not.toContain('didn’t save');
  });
  it('Undo in flight behind a write that is out is withdrawn by Refresh with the line, never sent', async () => {
    const held = deferred<{ data: null; error: unknown }>();
    serve(() => answer(false), () => held.promise);
    await render('president'); await click('Customize your Pulse');
    await click('Take Campaign membership off your Pulse'); await settle();
    await click('Put Campaign membership back'); await settle();
    serve(() => answer(true, STANDARD.filter((item) => item.key !== 'fixed:membership')), () => held.promise);
    await click('Refresh leadership Pulse'); await settle();
    await act(async () => { held.resolve({ data: null, error: null }); }); await settle();
    expect(saves()).toHaveLength(1); expect(outside()).toContain(NOT_SAVED);
  });
});
