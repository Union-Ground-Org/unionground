// @vitest-environment jsdom
import { act, createElement as h, Fragment, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exposedNames, getExposed, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';

// BUG-UG-NATIVE-FEATURE-SEARCH-MISSES-EXISTING-FEATURES-20261111
// (#8231), executed on the shared stand-in (#8319): All features search
// matched only the row's label, so the words people typed ("Civic",
// "Compass", "Sign out") found nothing.
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ memberLanguage: 'en' }) }));
vi.mock('./ui', () => import('../testing/uiStandIn'));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
// Real defaults: a pinned destination appears once before search and remains
// searchable after search replaces the rail with matching directory rows.
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn() } }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('./FontScaleRelayout', () => ({ FontScaleRelayout: ({ children }: { children?: ReactNode }) => h(Fragment, null, children) }));
vi.mock('./RowHighlight', () => ({
  HighlightList: ({ children }: { children?: ReactNode }) => h(Fragment, null, children),
  HighlightRow: ({ children }: { children?: ReactNode }) => h(Fragment, null, children),
}));

import { MEMBER_FEATURE_GROUPS, withMyCampaignGroup } from '../lib/hatFunctions';
import { FunctionDeck } from './FunctionDeck';

const groups = withMyCampaignGroup(MEMBER_FEATURE_GROUPS);
const labelOf = (key: string) => groups.flatMap((group) => group.items).find((item) => item.key === key)?.label ?? key;

let screen: Rendered | null = null;
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); });

describe.each(['ios', 'android'] as const)('All features search on %s', (os) => {
  it.each([
    ['Compass', 'rights'],
    ['Sign out', 'settings'],
  ])('keeps the row people mean when they type %s', async (query, key) => {
    setPlatform(os);
    screen = await render(h(FunctionDeck, { width: 390, height: 844, topPad: 0, bottomPad: 0, groups, onHome: vi.fn(), shortcutScope: 'test' }));
    await act(async () => { await Promise.resolve(); });
    const label = labelOf(key);
    // Exactly one control by that name, before and during search.
    const named = () => exposedNames(screen!.container).filter((name) => name === label);
    expect(named()).toHaveLength(1);
    await type(getExposed(screen.container, 'Search features'), query);
    expect(named()).toHaveLength(1);
  });
});
