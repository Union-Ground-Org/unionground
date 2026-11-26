// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { READ_DEADLINE_MS } from '../lib/readDeadline';
import { resolveTheme } from '../theme/tokens';
import type { StewardPulse } from '../services/stewardPulse';

const runtime = vi.hoisted(() => ({
  app: { mode: 'authenticated', session: { user: { id: 'steward-a' } }, organizationID: 'org-a', dashboard: { member: { chapterID: 'chapter-a' } }, sessionRestricted: false },
  load: vi.fn(), people: vi.fn(), preference: vi.fn(), save: vi.fn(), push: vi.fn(), opening: 'week', openingFailed: false, theme: 'union-ground',
}));
vi.mock('../services/stewardPulse', () => ({ loadStewardPulse: runtime.load, loadPulsePeople: runtime.people, loadPulseScorePreference: runtime.preference, savePulseScorePreference: runtime.save }));
vi.mock('./SavedPulseCharts', () => ({ SavedChartSlot: ({ position }: { position: string }) => createElement('span', null, `Saved ${position}`) }));
vi.mock('./PulseOpeningPreference', () => ({ usePulseOpening: () => ({ value: { opening: runtime.opening }, failed: runtime.openingFailed }) }));
vi.mock('../state/AppProvider', () => ({ useApp: () => runtime.app }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => resolveTheme('union-ground', runtime.theme === 'union-ground-dark') }));
vi.mock('../lib/chrome', () => ({ screenBottomInset: () => 0, useNativeTabContentInset: () => 24 }));
vi.mock('../lib/reduceMotion', () => ({ useReduceMotion: () => true }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('expo-router', async () => {
  const react = await import('react');
  return { useRouter: () => ({ push: runtime.push }), useFocusEffect: (callback: () => (() => void) | void) => react.useEffect(callback, [callback]) };
});
vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const text = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return {
    View: text, Text: text, ScrollView: text,
    Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => visible ? h('div', { role: 'dialog' }, children) : null,
    Pressable: ({ children, onPress, accessibilityLabel, accessibilityRole, accessibilityState }: { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string; accessibilityRole?: string; accessibilityState?: { checked?: boolean } }) => h('button', { onClick: onPress, 'aria-label': accessibilityLabel, ...(accessibilityRole === 'radio' ? { role: 'radio', 'aria-checked': accessibilityState?.checked } : {}) }, children),
    Switch: ({ value, disabled, onValueChange, accessibilityLabel }: { value: boolean; disabled: boolean; onValueChange: (next: boolean) => void; accessibilityLabel: string }) => h('input', { type: 'checkbox', checked: value, disabled, 'aria-label': accessibilityLabel, onChange: () => onValueChange(!value) }),
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 }, useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
  };
});
vi.mock('react-native-svg', async () => {
  const { createElement: h } = await import('react');
  const graphic = ({ children }: { children?: ReactNode }) => h('svg', null, children);
  return { default: graphic, Line: () => null, Path: () => null, Rect: () => null, Text: () => null };
});
vi.mock('../components/ui', async () => {
  const { createElement: h } = await import('react');
  const text = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return {
    Body: text, Heading: text, Card: text, Screen: text,
    Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => h('button', { onClick: onPress, disabled }, label),
    StateMessage: ({ title, body, action }: { title: string; body: string; action?: ReactNode }) => h('div', null, title, body, action),
  };
});

import StewardPulseScreen from './StewardPulseScreen';
import { PulseScorePrivacyCard } from './PulseScorePrivacyCard';

let root: Root;
let host: HTMLDivElement;
const now = new Date('2026-10-31T18:40:00-04:00');
function result(overrides: Partial<StewardPulse> = {}): StewardPulse {
  return {
    updatedAt: now, casesTruncated: false, deadlinesAvailable: true,
    cases: [{ id: 'c1', reference: 'GR-1', title: 'Schedule issue', deadline: '2026-11-01', status: 'active' }], deadlines: [],
    cards: [{ id: 'cases', number: '01', title: 'Your caseload', category: 'cases', period: 'Today', countedFrom: 'Assigned issue records.', notCounted: 'Other committee members are excluded.', rows: [{ label: 'Active', value: 2 }] }, { id: 'requests', number: '02', title: 'Worker requests', category: 'chapter', period: 'Today', countedFrom: 'Desk KPIs.', notCounted: 'Closed requests excluded.', rows: [{ label: 'Requests', value: 3 }] }],
    ...overrides,
  };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function render(node = createElement(StewardPulseScreen)) { await act(async () => { root.render(node); }); }
async function click(label: string) {
  const button = Array.from(host.querySelectorAll('button')).find((item) => item.getAttribute('aria-label') === label || item.textContent === label);
  expect(button, label).toBeTruthy(); await act(async () => { button!.click(); });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  runtime.opening = 'week'; runtime.openingFailed = false; runtime.theme = 'union-ground';
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  runtime.app.mode = 'authenticated'; runtime.app.session = { user: { id: 'steward-a' } }; runtime.app.sessionRestricted = false;
  runtime.load.mockReset().mockResolvedValue(result()); runtime.people.mockReset().mockImplementation(async (level: string) => ({ level, floor: 25, members: level === 'steward' ? [{ id: 'm', name: 'Fictional worker', score: null, scoreHidden: true, lastActivity: null }] : [], groups: level === 'steward' ? [] : [{ id: 'chapter-a', name: 'Fictional campaign', count: null, score: null, withheld: true }] }));
  runtime.preference.mockReset().mockResolvedValue(true); runtime.save.mockReset().mockImplementation(async (_id: string, value: boolean) => value); runtime.push.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

describe('native committee member Pulse interactions', () => {
  it('offers Try again after an unanswered read, ignores its late reply, and recovers', async () => {
    vi.useFakeTimers();
    const late = deferred<StewardPulse>();
    runtime.load.mockReturnValueOnce(late.promise);
    await render();
    expect(host.textContent).toContain('Loading your figures');
    expect((runtime.load.mock.calls[0]![1] as AbortSignal).aborted).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS); });
    expect(host.textContent).not.toContain('Loading your figures');
    expect(host.textContent).toContain('Pulse could not load');
    // #8769: the abandoned read is stopped once its deadline passes.
    expect((runtime.load.mock.calls[0]![1] as AbortSignal).aborted).toBe(true);
    await act(async () => late.resolve(result({ cases: [{ ...result().cases[0]!, title: 'Expired reply' }] })));
    expect(host.textContent).not.toContain('Expired reply');
    await click('Try again');
    expect(host.textContent).toContain('Your caseload');
    expect(host.textContent).not.toContain('Pulse could not load');
  });
  it('bounds People separately and offers Retry People without dropping the loaded Pulse', async () => {
    vi.useFakeTimers();
    const late = deferred<unknown>(); runtime.people.mockReturnValueOnce(late.promise);
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS); });
    expect(host.textContent).toContain('Your caseload');
    expect(host.textContent).toContain('People could not load');
    await click('Retry People');
    await act(async () => late.resolve({ level: 'steward', members: [{ id: 'late', name: 'Expired person' }], groups: [] }));
    expect(host.textContent).toContain('Fictional worker');
    expect(host.textContent).not.toContain('Expired person');
  });
  it.each(['union-ground', 'union-ground-dark'])('honors Charts first and lets the committee member show and hide This week in %s', async theme => {
    runtime.theme = theme; runtime.opening = 'charts';
    await render();
    expect(host.textContent).toContain('Your caseload'); expect(host.textContent).not.toContain('Schedule issue');
    await click('Show This week'); expect(host.textContent).toContain('Schedule issue');
    await click('Hide This week'); expect(host.textContent).not.toContain('Schedule issue');
  });
  it('falls back to This week when its saved opening choice cannot be verified', async () => {
    runtime.opening = 'charts'; runtime.openingFailed = true; await render();
    expect(host.textContent).toContain('Your opening choice could not be checked');
    expect(host.textContent).toContain('Schedule issue');
  });
  it('renders a response deadline on the previous Eastern date with its time', async () => {
    runtime.load.mockResolvedValue(result({
      cases: [{ id: 'c1', reference: 'GR-1', title: 'Response due', deadline: null, status: 'active' }],
      deadlines: [{ caseID: 'c1', label: 'Step response', dueAt: '2026-11-01T02:00:00+00:00' }],
    }));
    await render();
    expect(host.textContent).toContain('Step response · Oct 31, 2026 · 10:00 PM ET');
  });
  it('loads live cards, expands the same figures and source, switches table view, filters, and opens the ranked issue', async () => {
    await render();
    expect(host.textContent).toContain('Updated 6:40 PM ET'); expect(host.textContent).toContain('Schedule issue'); expect(host.textContent).toContain('Score hidden');
    expect(host.textContent!.indexOf('Saved pinned')).toBeLessThan(host.textContent!.indexOf('This week'));
    expect(host.textContent).toContain('Saved catalogue');
    await click('Open GR-1'); expect(runtime.push).toHaveBeenCalledWith('/issue/c1');
    // The shared Mock A frame (#8926): a non-period breakdown keeps its labelled figures on the card.
    const caseload = host.querySelector('[aria-label="01. Your caseload. Expand chart"]');
    expect(caseload?.textContent).toContain('Active2'); expect(caseload?.textContent).toContain('tap to expand ›');
    await click('01. Your caseload. Expand chart');
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Other committee members are excluded.');
    await click('Table view'); expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Active2');
    await click('Chart view'); await click('Close chart'); expect(host.querySelector('[role="dialog"]')).toBeNull();
    await click('cases'); expect(host.textContent).not.toContain('Worker requests');
    await click('all'); expect(host.textContent).toContain('Worker requests');
    await click('chapter'); expect(host.textContent).toContain('Worker requests');
  });
  it('never calls a failed deadline read caught up and provides the real Issue work route', async () => {
    runtime.load.mockResolvedValue(result({ deadlinesAvailable: false })); await render();
    expect(host.textContent).toContain('Some deadlines could not be checked'); expect(host.textContent).not.toContain('No recorded issue deadline');
    await click('Open Issue work'); expect(runtime.push).toHaveBeenCalledWith('/feature/steward');
  });
  it('shows the caught-up and read-failure states honestly, with a working retry', async () => {
    runtime.load.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(result({ cases: [] })); await render();
    expect(host.textContent).toContain('Pulse could not load'); await click('Try again');
    expect(host.textContent).toContain('No recorded issue deadline');
  });
  it('clears personal rows immediately when moving to aggregates, including a failed or slow read', async () => {
    await render(); const wait = deferred<unknown>(); runtime.people.mockReturnValueOnce(wait.promise);
    await click('chapter'); // chart category, not People level; select the last chapter radio below
    const chapters = host.querySelectorAll('button[aria-label="chapter"]');
    await act(async () => { (chapters[chapters.length - 1] as HTMLButtonElement).click(); });
    expect(host.textContent).not.toContain('Fictional worker'); expect(host.textContent).toContain('Loading People');
    await act(async () => wait.resolve({ level: 'chapter', floor: 25, members: [], groups: [{ id: 'g', name: 'Protected group', count: null, score: null, withheld: true }] }));
    expect(host.textContent).toContain('Withheld · group too small to share safely');
    runtime.people.mockRejectedValueOnce(new Error('offline')); await click('local'); expect(host.textContent).toContain('People could not load');
    await click('Retry People'); expect(host.textContent).toContain('Fictional campaign');
  });
  it.each([25, 50])('explains private groups and scores without guessing their size at a server floor of %i', async floor => {
    runtime.people.mockImplementation(async (level: string) => ({ level, floor, members: [], groups: level === 'steward' ? [] : [
      { id: 'private-group', name: 'Protected campaign', count: null, score: null, withheld: true },
      { id: 'private-score', name: 'Score-protected campaign', count: 60, score: null, withheld: false },
      { id: 'visible', name: 'Visible campaign', count: 60, score: 72, withheld: false },
    ] }));
    await render(); await click('local');
    expect(host.textContent).toContain('Withheld · group too small to share safely');
    expect(host.textContent).toContain('Score withheld · not enough visible scores to share safely');
    expect(host.textContent).toContain("Groups that do not meet the organization's privacy minimum are withheld.");
    expect(host.textContent).toContain('60 workers');
    expect(host.textContent).toContain('72 · Healthy');
    expect(host.textContent).not.toMatch(/fewer than ten|under ten|null members/);
  });
  it('drops old requests and sheets on an account switch, and never reads the backend from offline preview', async () => {
    const wait = deferred<StewardPulse>(); runtime.load.mockReturnValueOnce(wait.promise); await render();
    runtime.app.session = { user: { id: 'steward-b' } }; await render();
    await act(async () => wait.resolve(result({ cards: [{ ...result().cards[0]!, title: 'Wrong account secret' }] })));
    expect(host.textContent).not.toContain('Wrong account secret');
    runtime.app.mode = 'preview'; runtime.load.mockClear(); runtime.people.mockClear(); await render();
    expect(host.textContent).toContain('No preview records'); expect(runtime.load).not.toHaveBeenCalled(); expect(runtime.people).not.toHaveBeenCalled();
  });
  it('labels visible score bands and activity, paginates the roster, and keeps unavailable card values out of the sheet', async () => {
    runtime.people.mockResolvedValue({ level: 'steward', floor: 25, groups: [], members: Array.from({ length: 26 }, (_, index) => ({ id: String(index), name: `Person ${index}`, score: index === 0 ? 99 : null, scoreHidden: false, lastActivity: index === 0 ? '2026-10-30T12:00:00-04:00' : null })) });
    runtime.load.mockResolvedValue(result({ cards: [{ ...result().cards[0]!, unavailable: true, privacy: 'Protected figures', rows: [{ label: 'Do not reveal', value: 999 }] }] }));
    await render(); expect(host.textContent).toContain('99 · Excellent'); expect(host.textContent).toContain('Last activity Oct 30, 2026');
    expect(host.textContent).toContain('Not enough activity'); expect(host.textContent).not.toContain('Do not reveal');
    await click('Next workers'); expect(host.textContent).toContain('Person 25'); expect(host.textContent).not.toContain('Person 0');
    await click('Previous workers'); expect(host.textContent).toContain('Person 0');
    await click('01. Your caseload. Expand chart'); await click('Table view');
    expect(host.querySelector('[role="dialog"]')?.textContent).not.toContain('Do not reveal'); expect(host.textContent).toContain('Protected figures');
  });
});

describe('native Pulse score privacy setting', () => {
  it('loads the account setting, saves a hide, and keeps the previous choice on a failed save', async () => {
    await render(createElement(PulseScorePrivacyCard));
    const toggle = () => host.querySelector('input')!;
    expect(toggle().checked).toBe(true); await act(async () => toggle().click()); expect(runtime.save).toHaveBeenCalledWith('steward-a', false); expect(toggle().checked).toBe(false);
    runtime.save.mockRejectedValueOnce(new Error('offline')); await act(async () => toggle().click());
    expect(toggle().checked).toBe(false); expect(host.textContent).toContain('could not be saved');
    await click('Retry score preference'); expect(toggle().checked).toBe(true);
  });
  it('disables a loading or failed preference and retries without guessing, while preview stays local', async () => {
    runtime.preference.mockRejectedValueOnce(new Error('offline')); await render(createElement(PulseScorePrivacyCard));
    expect(host.querySelector('input')?.disabled).toBe(true); expect(host.textContent).toContain('could not be loaded');
    await click('Retry score preference'); expect(host.querySelector('input')?.disabled).toBe(false);
    runtime.app.mode = 'preview'; runtime.preference.mockClear(); runtime.save.mockClear(); await render(createElement(PulseScorePrivacyCard));
    await act(async () => host.querySelector('input')!.click()); expect(host.querySelector('input')?.checked).toBe(false);
    expect(runtime.preference).not.toHaveBeenCalled(); expect(runtime.save).not.toHaveBeenCalled();
    runtime.app.sessionRestricted = true; await render(createElement(PulseScorePrivacyCard)); expect(host.querySelector('input')).toBeNull();
  });
});
