// @vitest-environment jsdom
// BUG-UG-NATIVE-HOME-FIRST-RENDER-CAUGHT-UP-BEFORE-ITEMS-LOAD-20261103:
// live Home says caught up only after every what-matters read has settled,
// never while one is pending or after one has failed.
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveTheme } from '../../theme/tokens';

const runtime = vi.hoisted(() => ({
  appState: 'active', appStateListeners: new Set<(state: string) => void>(),
  includePersonalCases: true,
  app: {
    mode: 'authenticated',
    session: { access_token: 'token', user: { id: '10000000-0000-4000-8000-000000000001' } } as { access_token: string; user: { id: string } } | null,
    dashboard: { member: { chapterID: 'chapter-a' }, cases: [] } as { member: { chapterID: string }; cases: unknown[] } | null,
  },
  ballots: vi.fn(), events: vi.fn(), surveys: vi.fn(), notices: vi.fn(), tasks: vi.fn(), toggle: vi.fn(), push: vi.fn(),
}));
vi.mock('../../services/memberHomeAttention', () => ({
  loadWhatMattersBallots: runtime.ballots, loadWhatMattersEvents: runtime.events,
  loadWhatMattersSurveys: runtime.surveys, loadWhatMattersNotices: runtime.notices, loadWhatMattersSwitch: runtime.toggle,
  loadWhatMattersTasks: runtime.tasks,
}));
vi.mock('../../state/AppProvider', () => ({ useApp: () => runtime.app }));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => resolveTheme('union-ground') }));
vi.mock('../../services/haptics', () => ({ haptics: { select: async () => {} } }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: runtime.push }) }));
vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const AppState = { get currentState() { return runtime.appState; }, addEventListener: (_event: string, listener: (state: string) => void) => { runtime.appStateListeners.add(listener); return { remove: () => runtime.appStateListeners.delete(listener) }; } };
  const text = ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) => h('div', { 'aria-label': accessibilityLabel }, children);
  return {
    AppState, View: text, Text: text,
    Pressable: ({ children, onPress, accessibilityLabel }: { children?: ReactNode | ((state: { pressed: boolean }) => ReactNode); onPress?: () => void; accessibilityLabel?: string }) => h('button', { onClick: onPress, 'aria-label': accessibilityLabel }, typeof children === 'function' ? children({ pressed: false }) : children),
    StyleSheet: { create: <T,>(value: T) => value },
  };
});
vi.mock('../../components/ui', async () => {
  const { createElement: h } = await import('react');
  const text = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return {
    Body: text, Heading: text, Card: text,
    Button: ({ label, onPress, variant = 'primary' }: { label: string; onPress: () => void; variant?: string }) => h('button', { onClick: onPress, 'data-variant': variant }, label),
  };
});
import { WhatMattersNowSection, useWhatMattersNow } from './WhatMattersNow';

const caughtUp = /caught up|Nothing needs your attention right now/i;
const survey = { id: 's1', title: 'Seasonal check-in', closesAt: null, answered: false };
let root: Root, host: HTMLDivElement;
let observed: ReturnType<ReturnType<typeof useWhatMattersNow>['rank']> | null = null;

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function Home() {
  const whatMatters = useWhatMattersNow({ includePersonalCases: runtime.includePersonalCases });
  const ranking = whatMatters.rank();
  observed = ranking;
  return createElement(WhatMattersNowSection, { item: ranking.item, status: ranking.status, onRetry: whatMatters.retry });
}
async function render() { await act(async () => { root.render(createElement(Home)); }); }
async function settle() { await act(async () => { await Promise.resolve(); }); }
function settledInputs() {
  runtime.ballots.mockResolvedValue([]); runtime.events.mockResolvedValue([]);
  runtime.surveys.mockResolvedValue([]); runtime.notices.mockResolvedValue([]); runtime.tasks.mockResolvedValue([]);
}

beforeEach(() => {
  runtime.appState = 'active';
  runtime.includePersonalCases = true;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  runtime.app.mode = 'authenticated';
  runtime.app.session = { access_token: 'token', user: { id: '10000000-0000-4000-8000-000000000001' } };
  runtime.app.dashboard = { member: { chapterID: 'chapter-a' }, cases: [] };
  runtime.toggle.mockResolvedValue(true);
  settledInputs();
  observed = null;
});
afterEach(() => { act(() => root.unmount()); host.remove(); expect(runtime.appStateListeners.size).toBe(0); if (vi.isFakeTimers()) expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); vi.clearAllMocks(); });

describe('native Home what matters before its reads settle', () => {
  it('keeps a survey available after switching from worker to staff Home', async () => {
    // This edition has no legal-deadline kinds; the worker's own open issue
    // leads worker Home instead.
    runtime.app.dashboard!.cases = [{ id: 'c1', reference: 'GR-1', status: 'active', step: 'Step 2', deadline: null }];
    runtime.surveys.mockResolvedValue([survey]);
    await render();
    await settle();
    expect(observed?.item?.kind).not.toBe('open_survey');
    expect(host.textContent).toContain('Review issue');

    runtime.includePersonalCases = false;
    await render();
    expect(observed?.item?.kind).toBe('open_survey');
    expect(host.textContent).toContain('Seasonal check-in');
    expect(host.textContent).not.toContain('Review issue');
  });

  it('uses one named action button for the same issue opened from Pulse', async () => {
    runtime.app.dashboard!.cases = [{ id: 'c1', reference: 'GR-1', status: 'active', step: 'Step 2', deadline: null }];
    await render();
    await settle();
    const buttons = Array.from(host.querySelectorAll('button'));
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe('Review issue');
    expect(buttons[0]!.getAttribute('data-variant')).toBe('primary');
    expect(buttons[0]!.querySelector('button')).toBeNull();
    await act(async () => { buttons[0]!.click(); });
    expect(runtime.push).toHaveBeenCalledWith('/issue/c1');
  });

  it('shows a neutral loading state, never caught up, while any read is pending', async () => {
    const surveys = deferred<typeof survey[]>();
    runtime.surveys.mockReturnValue(surveys.promise);
    await render();
    await settle();
    expect(observed?.status).toBe('loading');
    expect(host.textContent).toContain('Checking what needs your attention…');
    expect(host.textContent).not.toMatch(caughtUp);
    await act(async () => { surveys.resolve([survey]); });
    expect(observed?.status).toBe('ready');
    expect(host.textContent).toContain('A survey is waiting for your answer'.toLocaleUpperCase('en-US'));
    expect(host.textContent).toContain('Seasonal check-in');
    expect(host.textContent).not.toMatch(caughtUp);
    await act(async () => { host.querySelector('button')!.click(); });
    expect(runtime.push).toHaveBeenCalledWith('/feature/voting');
  });

  it('says it could not check, never caught up, when one read fails, and retries', async () => {
    runtime.notices.mockRejectedValueOnce(new Error('offline'));
    await render();
    await settle();
    expect(observed?.status).toBe('failed');
    expect(host.textContent).toContain('Could not check what needs your attention');
    expect(host.textContent).toContain('could not be read. Retry to check again.');
    expect(host.textContent).not.toMatch(caughtUp);
    const retry = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Retry');
    expect(retry).toBeTruthy();
    runtime.surveys.mockResolvedValue([survey]);
    await act(async () => { retry!.click(); });
    await settle();
    expect(observed?.status).toBe('ready');
    expect(observed?.item?.kind).toBe('open_survey');
    expect(runtime.notices).toHaveBeenCalledTimes(2);
  });

  it('says caught up only once every read has settled with nothing waiting', async () => {
    await render();
    await settle();
    expect(observed?.status).toBe('ready');
    expect(observed?.item?.kind).toBe('caught_up');
    expect(host.textContent).toContain('Nothing needs your attention right now.');
  });

  it('never ranks a previous worker\'s settled reads after a fresh sign-in', async () => {
    runtime.surveys.mockResolvedValue([survey]);
    await render();
    await settle();
    expect(observed?.item?.kind).toBe('open_survey');
    const next = deferred<typeof survey[]>();
    runtime.surveys.mockReturnValue(next.promise);
    runtime.app.session = { access_token: 'token-b', user: { id: '10000000-0000-4000-8000-000000000002' } };
    await render();
    await settle();
    expect(observed?.status).toBe('loading');
    expect(host.textContent).not.toContain('Seasonal check-in');
    await act(async () => { next.resolve([]); });
    expect(observed?.item?.kind).toBe('caught_up');
  });

  // Device run on #6912: every foreground passes the secure-session check,
  // which remounts Home and re-runs the four reads.
  it('never says caught up while a foreground re-read is in flight, remounted or not', async () => {
    const notice = { id: 'n1', title: 'Union position: Bistro tip pool', unread: true };
    runtime.notices.mockResolvedValue([notice]);
    await render();
    await settle();
    expect(observed?.item?.kind).toBe('unread_notice');

    // Same mount, refreshed session and dashboard: the last settled ranking stays.
    const refreshed = deferred<typeof notice[]>();
    runtime.notices.mockReturnValue(refreshed.promise);
    runtime.app.session = { access_token: 'token-refreshed', user: { id: '10000000-0000-4000-8000-000000000001' } };
    runtime.app.dashboard = { member: { chapterID: 'chapter-a' }, cases: [] };
    await render();
    await settle();
    expect(runtime.notices).toHaveBeenCalledTimes(2);
    expect(observed?.item?.kind).toBe('unread_notice');
    expect(host.textContent).not.toMatch(caughtUp);

    // Remount after the secure-session check: pending until the reads settle.
    const remounted = deferred<typeof notice[]>();
    runtime.notices.mockReturnValue(remounted.promise);
    act(() => root.unmount());
    root = createRoot(host);
    await render();
    await settle();
    expect(observed?.status).toBe('loading');
    expect(host.textContent).toContain('Checking what needs your attention…');
    expect(host.textContent).not.toMatch(caughtUp);
    await act(async () => { remounted.resolve([notice]); });
    expect(observed?.item?.kind).toBe('unread_notice');
    expect(host.textContent).not.toMatch(caughtUp);
  });

  // PR #6917 gate r1g3: the conversation poll replaces the dashboard every
  // 30 s, so one transient failure must not flip a good card.
  it('keeps the last good card when a re-read for the same worker fails', async () => {
    runtime.surveys.mockResolvedValue([survey]);
    await render();
    await settle();
    expect(observed?.item?.kind).toBe('open_survey');
    runtime.events.mockRejectedValueOnce(new Error('timeout'));
    runtime.app.dashboard = { member: { chapterID: 'chapter-a' }, cases: [] };
    await render();
    await settle();
    expect(runtime.events).toHaveBeenCalledTimes(2);
    expect(observed?.status).toBe('ready');
    expect(observed?.item?.kind).toBe('open_survey');
    expect(host.textContent).not.toContain('Could not check what needs your attention');
  });

  // PR #6917 gate r1s1: a dashboard replacement mid-read no longer cancels
  // it, and a read older than one that has landed is dropped.
  it('lets a slow read outlive dashboard replacements and never lands an older read over a newer one', async () => {
    const first = deferred<typeof survey[]>(), second = deferred<typeof survey[]>(), third = deferred<typeof survey[]>();
    runtime.surveys.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    await render();
    for (const _tick of [1, 2]) {
      runtime.app.dashboard = { member: { chapterID: 'chapter-a' }, cases: [] };
      await render();
    }
    expect(runtime.surveys).toHaveBeenCalledTimes(3);
    await act(async () => { first.resolve([survey]); });
    expect(observed?.item?.kind).toBe('open_survey');
    await act(async () => { third.resolve([]); });
    expect(observed?.item?.kind).toBe('caught_up');
    await act(async () => { second.resolve([survey]); });
    expect(observed?.item?.kind).toBe('caught_up');
  });

  // PR #6917 gate r2s2/r2g1: a newer read whose input fails fast must not
  // discard an older read's input that succeeds later.
  it('keeps a slow success when a newer read for the same input fails first', async () => {
    const slow = deferred<typeof survey[]>();
    runtime.surveys.mockReturnValueOnce(slow.promise).mockRejectedValueOnce(new Error('timeout'));
    await render();
    runtime.app.dashboard = { member: { chapterID: 'chapter-a' }, cases: [] };
    await render();
    await settle();
    expect(runtime.surveys).toHaveBeenCalledTimes(2);
    expect(observed?.status).toBe('failed');
    await act(async () => { slow.resolve([survey]); });
    expect(observed?.status).toBe('ready');
    expect(observed?.item?.kind).toBe('open_survey');
    expect(host.textContent).not.toContain('Could not check what needs your attention');
  });

  // PR #6917 gate r2s3/r2g2: the read belongs to one member in one chapter.
  it('never ranks the previous campaign\'s meetings after a campaign switch', async () => {
    const event = { id: 'e1', title: 'Campaign A meeting', startsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), cancelled: false, responded: false };
    const chapterB = deferred<typeof event[]>();
    runtime.events.mockImplementation(async (_user: string, chapter: string) => (chapter === 'chapter-a' ? [event] : chapterB.promise));
    await render();
    await settle();
    expect(observed?.item?.kind).toBe('rsvp');
    runtime.app.dashboard = { member: { chapterID: 'chapter-b' }, cases: [] };
    await render();
    await settle();
    expect(observed?.status).toBe('loading');
    expect(host.textContent).not.toContain('Campaign A meeting');
    // Chapter B's events read never succeeds: nothing from chapter A stands in.
    runtime.events.mockImplementation(async () => { throw new Error('offline'); });
    runtime.app.dashboard = { member: { chapterID: 'chapter-b' }, cases: [] };
    await render();
    await settle();
    expect(observed?.status).toBe('failed');
    expect(host.textContent).not.toContain('Campaign A meeting');
  });

  // PR #6917 gate r2s1: what the inputs that did succeed found still lands.
  it('shows a survey a re-read found even when another input of that read failed', async () => {
    await render();
    await settle();
    expect(observed?.item?.kind).toBe('caught_up');
    runtime.surveys.mockResolvedValueOnce([survey]);
    runtime.notices.mockRejectedValueOnce(new Error('timeout'));
    runtime.app.dashboard = { member: { chapterID: 'chapter-a' }, cases: [] };
    await render();
    await settle();
    expect(observed?.status).toBe('ready');
    expect(observed?.item?.kind).toBe('open_survey');
  });

  it('reads nothing and stays loading without a signed-in dashboard', async () => {
    runtime.app.dashboard = null;
    await render();
    await settle();
    expect(observed?.status).toBe('loading');
    expect(runtime.ballots).not.toHaveBeenCalled();
    expect(host.textContent).not.toMatch(caughtUp);
  });

  it('treats a ready section without an item as loading', async () => {
    await act(async () => { root.render(createElement(WhatMattersNowSection, { item: null, status: 'ready', onRetry: vi.fn() })); });
    expect(host.textContent).toContain('Checking what needs your attention…');
    expect(host.querySelector('button')).toBeNull();
  });
});

describe('native Home Eastern calendar refresh', () => {
  it.each([
    ['2026-03-08T05:00:00Z', '2026-03-09', 23, 'Follow up Mar 9'],
    ['2026-11-01T04:00:00Z', '2026-11-02', 25, 'Follow up Nov 2'],
  ])('keeps the mounted day current after %s (%s, %i hours)', async (start, deadline, hours, caption) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(start));
    runtime.app.dashboard!.cases = [{ id: 'c1', reference: 'GR-1', status: 'active', deadline }];
    await render(); await settle();
    expect(host.textContent).toContain('A follow-up is due tomorrow on GR-1.');
    expect(host.textContent).toContain(caption);
    await act(async () => { await vi.advanceTimersByTimeAsync(hours * 3_600_000 - 1); });
    expect(host.textContent).toContain('is due tomorrow');
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(host.textContent).toContain('A follow-up is due today on GR-1.');
    expect(host.textContent).toContain(caption);
    expect(runtime.ballots).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('catches up on foreground resume and removes its timer in the background', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T03:59:59Z'));
    runtime.app.dashboard!.cases = [{ id: 'c1', reference: 'GR-1', status: 'active', deadline: '2026-10-02' }];
    await render(); await settle();
    expect(host.textContent).toContain('is due tomorrow');
    await act(async () => { runtime.appState = 'background'; for (const listener of runtime.appStateListeners) listener('background'); });
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(new Date('2026-10-03T04:00:00Z'));
    await act(async () => { runtime.appState = 'active'; for (const listener of runtime.appStateListeners) listener('active'); });
    expect(host.textContent).toContain('is 1 day overdue');
    expect(runtime.ballots).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });
});
