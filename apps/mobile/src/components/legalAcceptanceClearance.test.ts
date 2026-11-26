import * as React from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { homeContentBottomInset } from '../lib/chromeGeometry';
import { legalAcceptanceVersions, type LegalAcceptanceState } from '../lib/legalAcceptance';

const runtime = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[],
  load: vi.fn<() => Promise<LegalAcceptanceState>>(),
  record: vi.fn<(versions: Record<string, string>, adultAttested: boolean) => Promise<boolean>>(),
}));
vi.mock('react', async (original) => ({
  ...await original<typeof React>(),
  useCallback: <T,>(callback: T) => callback,
  useMemo: <T,>(factory: () => T) => factory(),
  useRef: <T,>(current: T) => {
    const index = runtime.cursor++;
    if (index >= runtime.slots.length) runtime.slots[index] = { current };
    return runtime.slots[index] as { current: T };
  },
  useEffect: (effect: () => void | (() => void)) => { runtime.effects.push(effect); },
  useState: <T,>(initial: T) => {
    const index = runtime.cursor++;
    if (index >= runtime.slots.length) runtime.slots[index] = initial;
    return [runtime.slots[index] as T, (next: T | ((previous: T) => T)) => {
      runtime.slots[index] = typeof next === 'function'
        ? (next as (previous: T) => T)(runtime.slots[index] as T) : next;
    }] as const;
  },
}));
// The card now reads the store age signal module; a node test has no native
// module, which the reader reports as an unavailable signal.
vi.mock('../../modules/store-age-signal/src/StoreAgeSignalModule', () => ({ default: null }));
vi.mock('react-native', () => ({
  Animated: { ScrollView: 'ScrollView', View: 'View', event: vi.fn() },
  Platform: { OS: 'android' },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Linking: { openURL: vi.fn() },
  View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView',
}));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));
vi.mock('react-native-screens/experimental', () => ({ ScrollViewMarker: 'ScrollViewMarker' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('../lib/announce', () => ({ queueAccessibilityAnnouncement: vi.fn() }));
vi.mock('../lib/chrome', () => ({
  contentStartInset: () => 52, screenBottomInset: () => 56,
  resetHomeScrollOffset: vi.fn(), syncHomeAwayFromTop: vi.fn(), useHomeScrollToTopRequests: () => 0,
}));
vi.mock('../lib/reduceMotion', () => ({ useReduceMotion: () => true }));
vi.mock('./PinnedHeader', () => ({ usePinnedHeaderChrome: () => null }));
vi.mock('./NumberFlow', () => ({ NumberFlow: 'NumberFlow' }));
vi.mock('./PressableScale', () => ({ PressableScale: 'PressableScale', usePressSpring: () => ({}) }));
vi.mock('./RowHighlight', () => ({ HighlightList: 'HighlightList', HighlightRow: 'HighlightRow' }));
vi.mock('./TopChrome', () => ({ TopRamp: 'TopRamp' }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({ background: '#fff' }) }));
vi.mock('../services/legalAcceptance', () => ({ loadLegalAcceptance: runtime.load, recordLegalAcceptance: runtime.record }));
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, supabaseUrl: 'https://live-project.example.test' } }));
const acceptanceSession = vi.hoisted(() => ({ user: { id: 'member-a' }, access_token: 'token-a' }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ session: acceptanceSession }) }));
vi.mock('../services/supabase', () => ({
  getSupabaseClient: () => ({ auth: { getSession: async () => ({ data: { session: acceptanceSession }, error: null }) } }),
}));

const { Screen, Button } = await import('./ui');
const { LegalAcceptanceCard } = await import('../features/LegalAcceptanceCard');

type Element = React.ReactElement<{
  children?: React.ReactNode; style?: { marginBottom?: number }; label?: string;
  accessibilityRole?: string; onPress?: () => void;
  onResidenceState?: (code: string) => void; onAgeAttested?: (value: boolean) => void;
}>;
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function renderCard(onRequiredChange: (required: boolean) => void) {
  runtime.cursor = 0;
  runtime.effects = [];
  return LegalAcceptanceCard({ onRequiredChange });
}

beforeEach(() => {
  runtime.slots = []; runtime.cursor = 0; runtime.effects = [];
  runtime.load.mockReset().mockResolvedValue({ versions: {}, acceptedAt: null });
  runtime.record.mockReset();
  vi.stubGlobal('React', React);
});
afterEach(() => vi.unstubAllGlobals());

describe('pending terms stay above Android Home navigation', () => {
  it.each([24, 48])('reserves the occupied band in the viewport with bottom safe area %i', (bottom) => {
    const clearance = homeContentBottomInset(bottom, 'android', 24, 48);
    const tree = Screen({ bottomInset: clearance, bottomClearance: clearance });
    const scroll = elements(tree).find(node => node.type === 'ScrollView');
    // The viewport must stop above BOTH the 64pt native bar and the 72pt
    // minimized Home control. Footer padding alone leaves controls behind them
    // at intermediate scroll positions (the vc9 Pixel reproduction).
    const viewportBottom = 924 - (scroll?.props.style?.marginBottom ?? 0);
    expect(viewportBottom).toBeLessThanOrEqual(924 - bottom - 72 - 12);
    expect(viewportBottom).toBeLessThan(924 - bottom - 64);
  });

  it('leaves the ordinary full-height scroll viewport unchanged', () => {
    const scroll = elements(Screen({})).find(node => node.type === 'ScrollView');
    expect(scroll?.props.style?.marginBottom ?? 0).toBe(0);
  });

  it('ends the viewport above the measured vc9 Pixel tab bar and minimized pill', () => {
    // Controller 9: 1080 x 2424 px, density 420; full bar starts y=2150,
    // minimized pill starts y=2172. The actual form was covered in both bands.
    const clearance = homeContentBottomInset(24, 'android', 24, 48);
    const scroll = elements(Screen({ bottomClearance: clearance })).find(node => node.type === 'ScrollView');
    const bottomPixels = 2424 - (scroll?.props.style?.marginBottom ?? 0) * (420 / 160);
    expect(bottomPixels).toBeLessThan(2150);
    expect(bottomPixels).toBeLessThan(2172);
  });

  it('reports pending terms only after loading, clears on unmount, and does not imply consent', async () => {
    const notify = vi.fn();
    expect(renderCard(notify)).toBeNull();
    runtime.effects.forEach(effect => effect());
    expect(notify).toHaveBeenLastCalledWith(false);
    await Promise.resolve();
    const card = renderCard(notify);
    const cleanups = runtime.effects.map(effect => effect());
    expect(notify).toHaveBeenLastCalledWith(true);
    expect(runtime.record).not.toHaveBeenCalled();
    elements(card).find(node => node.type === Button)?.props.onPress?.();
    expect(runtime.record).not.toHaveBeenCalled();
    cleanups.forEach(cleanup => cleanup?.());
    expect(notify).toHaveBeenLastCalledWith(false);
  });

  it('releases clearance when the current terms are already accepted', async () => {
    runtime.load.mockResolvedValue({ versions: legalAcceptanceVersions(), acceptedAt: '2026-10-18T18:00:00Z' });
    const notify = vi.fn();
    renderCard(notify);
    runtime.effects.forEach(effect => effect());
    await Promise.resolve();
    expect(renderCard(notify)).toBeNull();
    runtime.effects.forEach(effect => effect());
    expect(notify).toHaveBeenLastCalledWith(false);
  });

  // The card asks for the residence state and the age attestation that
  // state's rule needs, then records them with the accepted versions.
  it('releases clearance after explicit consent, a chosen state, and successful acceptance', async () => {
    const notify = vi.fn();
    renderCard(notify);
    runtime.effects.forEach(effect => effect());
    await Promise.resolve();
    let card = renderCard(notify);
    elements(card).find(node => node.props.accessibilityRole === 'checkbox')?.props.onPress?.();
    const fields = elements(card).find(node => node.props.onResidenceState);
    fields?.props.onResidenceState?.('NY');
    fields?.props.onAgeAttested?.(true);
    card = renderCard(notify);
    runtime.record.mockResolvedValue(true);
    runtime.load.mockResolvedValue({ versions: legalAcceptanceVersions(), acceptedAt: '2026-10-18T18:00:00Z' });
    elements(card).find(node => node.type === Button)?.props.onPress?.();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(runtime.record).toHaveBeenCalledWith(legalAcceptanceVersions(), 'NY', true, acceptanceSession);
    expect(renderCard(notify)).toBeNull();
    runtime.effects.forEach(effect => effect());
    expect(notify).toHaveBeenLastCalledWith(false);
  });

  it('binds the clearance only to the Android authenticated Home card', () => {
    const home = readFileSync(new URL('../../app/(tabs)/home.tsx', import.meta.url), 'utf8');
    expect(home).toContain("bottomClearance={Platform.OS === 'android' && legalAcceptancePending ? bottomInset : 0}");
    expect(home).toContain('<LegalAcceptanceCard onRequiredChange={setLegalAcceptancePending} language={memberLanguage} />');
  });
});
