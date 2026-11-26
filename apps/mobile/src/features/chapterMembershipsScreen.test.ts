// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MobileAdminScope, MobileChapterUnit } from '../lib/chapterAdministration';
import { READ_DEADLINE_MS } from '../lib/readDeadline';
import type { MobileDirectoryPage } from '../services/supabase';
import { AccessibilityInfo, getExposed, press, render, type, type Rendered } from '../testing/reactNativeStandIn';
import { stubSessionWriter } from '../testing/stubSessionWriter';
import palette from '../theme/palette.json';
import { ChapterMembershipsScreen } from './ChapterMembershipsScreen';

const port = vi.hoisted(() => ({
  language: 'en' as 'en' | 'es',
  loadScope: vi.fn<() => Promise<MobileAdminScope | null>>(),
  loadUnits: vi.fn<() => Promise<MobileChapterUnit[]>>(),
  searchDirectory: vi.fn<() => Promise<MobileDirectoryPage>>(),
}));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaView: ({ children }: { children?: ReactNode }) => h('div', null, children),
}));
vi.mock('react-native-screens/experimental', () => ({ ScrollViewMarker: () => null }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useRouter: () => ({}) }));
vi.mock('../components/TopChrome', () => ({ TopRamp: () => null }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../state/AppProvider', () => ({
  useApp: () => ({
    mode: 'authenticated', session: { user: { id: 'admin-a' } }, organizationID: 'org-a',
    chapterRoles: [], organizationRoles: ['admin'],
    dashboard: { member: { id: 'admin-a', chapterID: 'chapter-a', language: port.language } },
  }),
}));
vi.mock('../services/supabase', () => ({
  captureSessionWriter: () => stubSessionWriter(() => null),
  loadMobileAdminChapterScope: port.loadScope,
  loadMobileChapterUnits: port.loadUnits,
  searchMobileAdminMemberDirectory: port.searchDirectory,
}));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn() } }));
vi.mock('./NativeUnitSettings', () => ({ NativeUnitSettingsEditor: () => null }));

const scope: MobileAdminScope = {
  scope: 'organization',
  chapterID: null,
  chapters: [{ id: 'chapter-a', name: 'Tamarack Transit' }],
};
let mountedView: Rendered | undefined;
afterEach(async () => {
  await mountedView?.unmount();
  mountedView = undefined;
  port.language = 'en';
  port.loadScope.mockReset();
  port.loadUnits.mockReset();
  port.searchDirectory.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each<['en' | 'es', string, string, string]>([
  ['en', 'Find a worker by name', 'Search workers', 'No worker matched that search.'],
  ['es', 'Buscar a un trabajador por nombre', 'Buscar trabajadores', 'Ningún trabajador coincide con esa búsqueda.'],
])('shows an empty result only after a successful directory search in %s', async (language, input, search, empty) => {
  port.language = language;
  port.loadScope.mockResolvedValue(scope);
  port.loadUnits.mockResolvedValue([]);
  let finish!: (page: MobileDirectoryPage) => void;
  port.searchDirectory.mockReturnValue(new Promise<MobileDirectoryPage>((resolvePage) => { finish = resolvePage; }));
  const view = await render(h(ChapterMembershipsScreen));
  mountedView = view;
  expect(view.container.textContent).not.toContain(empty);
  await type(getExposed(view.container, input), 'No match');
  expect(view.container.textContent).not.toContain(empty);
  await press(getExposed(view.container, search));
  expect(port.searchDirectory).toHaveBeenCalledExactlyOnceWith('No match', null);
  expect(view.container.textContent).not.toContain(empty);
  await act(async () => { finish({ members: [], nextCursor: null, truncated: false }); });
  expect(view.container.textContent).toContain(empty);
});

it('shows a search error without an empty result when the directory rejects the search', async () => {
  port.loadScope.mockResolvedValue(scope);
  port.loadUnits.mockResolvedValue([]);
  port.searchDirectory.mockRejectedValueOnce(new Error('Directory search denied'));
  const view = await render(h(ChapterMembershipsScreen));
  mountedView = view;
  await type(getExposed(view.container, 'Find a worker by name'), 'Alex');
  await press(getExposed(view.container, 'Search workers'));
  expect(port.searchDirectory).toHaveBeenCalledExactlyOnceWith('Alex', null);
  expect(view.container.textContent).toContain('The worker directory could not be searched through your current authorization.');
  expect(view.container.textContent).not.toContain('No worker matched that search.');
});

it.each<['en' | 'es', string, string, string]>([
  ['en', 'Your administrator scope could not be confirmed through this campaign.', 'Try again', 'Find a worker by name'],
  ['es', 'No se pudo confirmar su alcance de administración en esta campaña.', 'Reintentar', 'Buscar a un trabajador por nombre'],
])('announces a failed campaign check and retries it in %s', async (language, warning, retry, search) => {
  port.language = language;
  port.loadScope.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(scope);
  port.loadUnits.mockResolvedValue([]);
  const announce = vi.spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions');
  const view = await render(h(ChapterMembershipsScreen));
  mountedView = view;
  expect(view.container.textContent).toContain(warning);
  const button = getExposed(view.container, retry);
  await vi.waitFor(() => expect(announce).toHaveBeenCalledWith(warning, { queue: true }));
  await press(button);
  expect(port.loadScope).toHaveBeenCalledTimes(2);
  expect(port.loadUnits).toHaveBeenCalledOnce();
  expect(view.container.textContent).not.toContain(warning);
  expect(getExposed(view.container, search)).toBeTruthy();
});

it('ends a hung campaign check and discards its result after a successful retry', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let finishFirst!: (value: MobileAdminScope) => void;
  const first = new Promise<MobileAdminScope>((resolve) => { finishFirst = resolve; });
  port.loadScope.mockReturnValueOnce(first).mockResolvedValue(scope);
  port.loadUnits.mockResolvedValue([]);
  const view = await render(h(ChapterMembershipsScreen));
  mountedView = view;
  expect(view.container.textContent).toContain('Checking your administrator scope');
  await act(async () => { await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS); });
  await press(getExposed(view.container, 'Try again'));
  expect(port.loadScope).toHaveBeenCalledTimes(2);
  await act(async () => { finishFirst({ ...scope, chapters: [{ id: 'late', name: 'Late campaign' }] }); });
  expect(view.container.textContent).not.toContain('Late campaign');
  expect(port.loadUnits).toHaveBeenCalledExactlyOnceWith('chapter-a');
});

it('keeps the scope warning when a timed-out read answers before retry', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let finishRead!: (value: MobileAdminScope) => void;
  const pending = new Promise<MobileAdminScope>((resolveRead) => { finishRead = resolveRead; });
  port.loadScope.mockReturnValueOnce(pending);
  const view = await render(h(ChapterMembershipsScreen));
  mountedView = view;
  await act(async () => { await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS); });
  const retry = getExposed(view.container, 'Try again');
  await act(async () => { finishRead(scope); });
  expect(view.container.textContent).toContain('Your administrator scope could not be confirmed through this campaign.');
  expect(getExposed(view.container, 'Try again')).toBe(retry);
  expect(port.loadScope).toHaveBeenCalledTimes(1);
  expect(port.loadUnits).not.toHaveBeenCalled();
});

const screenPath = resolve(dirname(fileURLToPath(import.meta.url)), 'ChapterMembershipsScreen.tsx');
const screen = readFileSync(screenPath, 'utf8');

describe('ChapterMembershipsScreen outcome wiring', () => {
  it('routes every outcome through one reporter that queues an announcement and renders a live region', () => {
    expect(screen).toMatch(/function report\(kind: MembershipOutcomeKind, name: string\) \{\s*const next = describeMembershipOutcome\(kind, copy, name\);\s*setMessage\(next\);\s*queueAnnouncement\(next\.text\);/u);
    expect(screen).toMatch(/accessibilityLiveRegion="polite" accessibilityRole=\{message\.tone === 'error' \? 'alert' : 'text'\}/u);
    for (const kind of ['search-error', 'stale', 'directory-limit', 'refresh-failed']) expect(screen).toContain(`report('${kind}'`);
    expect(screen).toContain("'granted', 'refused-membership', 'unconfirmed-membership'");
    expect(screen).toContain("'revoked', 'refused-membership', 'unconfirmed-membership'");
    expect(screen).toContain("'role-granted', 'refused-role', 'unconfirmed-role'");
    expect(screen).toContain("'role-revoked', 'refused-role', 'unconfirmed-role'");
    expect(screen).not.toMatch(/setError\(|setNotice\(/u);
  });

  it('announces nothing for a completion that arrives after the target changed or the screen left', () => {
    expect(screen).toMatch(/const startedFor = \{ userID, chapterID \};/u);
    expect(screen).toMatch(/completionStillCurrent\(\{ startedFor, current: target\.current, mounted: mounted\.current \}\)/u);
    expect(screen.match(/if \(!current\(\)\) return;/gu)).toHaveLength(2);
    expect(screen).toContain("const proof = await checkBusinessContinuation(writer, current);\n      if (proof === 'changed') return;\n      if (proof === 'unavailable') { report('stale', name); return; }");
    expect(screen).toMatch(/useAccessibilityAnnouncementQueue\(`chapter-memberships:\$\{userID \|\| 'none'\}`\)/u);
  });

  it('separates a refusal from an unconfirmed transport outcome, attempts a re-read after the latter, and reports a failed re-read as such', () => {
    expect(screen).toMatch(/if \(classifyMembershipFailure\(failure\) === 'refused'\) \{\s*report\(refused, name\);\s*return;/u);
    expect(screen).toMatch(/report\(unconfirmed, name\);\s*if \(await checkBusinessContinuation\(writer, current\) !== 'current'\) return;\s*try \{\s*await readDirectory\(forQuery, depth\);\s*\} catch \{\s*if \(current\(\)\) report\('refresh-failed', name\);/u);
    expect(screen).not.toMatch(/catch \{ \/\* the notice already says to re-read \*\/ \}/u);
  });

  it('binds rows, cursor and refresh to the submitted query and drops reads that a newer read overtook', () => {
    expect(screen).toMatch(/const \[submittedQuery, setSubmittedQuery\] = useBusinessDraftState<string \| null>\(null\);/u);
    expect(screen).toMatch(/function editQuery\(next: string\) \{\s*setQuery\(next\);\s*if \(submittedQuery !== null && next\.trim\(\) !== submittedQuery\) setNextCursor\(null\);/u);
    expect(screen).toMatch(/onChangeText=\{editQuery\}/u);
    expect(screen).not.toMatch(/onChangeText=\{setQuery\}/u);
    expect(screen).toMatch(/loadMoreIsContinuation\(\{ draft: query, submitted: submittedQuery, cursor: nextCursor \}\)/u);
    expect(screen).toMatch(/searchMobileAdminMemberDirectory\(submittedQuery, nextCursor\)/u);
    expect(screen).toMatch(/const startedSequence = \+\+readSequence\.current;/u);
    expect(screen.match(/directoryReadIsCurrent\(\{ startedSequence, currentSequence: readSequence\.current \}\)/gu)).toHaveLength(2);
    expect(screen).toMatch(/const forQuery = submittedQuery \?\? '';/u);
    expect(screen).toMatch(/copy\.resultsFor\(submittedQuery\)/u);
  });

  it('follows the directory cursor with a bounded Load more and re-reads to the same depth after a mutation', () => {
    expect(screen).toMatch(/searchMobileAdminMemberDirectory\(forQuery, cursor\)/u);
    expect(screen).toMatch(/while \(cursor !== null && pages < Math\.min\(depth, DIRECTORY_MAX_PAGES\)\)/u);
    expect(screen).toMatch(/if \(pagesLoaded >= DIRECTORY_MAX_PAGES\) \{ report\('directory-limit', ''\); return; \}/u);
    expect(screen).toMatch(/const depth = Math\.max\(1, pagesLoaded\);/u);
    expect(screen).toMatch(/setUserID\(\(current\) => retainedMemberSelection\(collected, current\)\)/u);
    expect(screen).toMatch(/label=\{busy === 'more' \? copy\.loadingMore : copy\.loadMore\}/u);
  });
});
