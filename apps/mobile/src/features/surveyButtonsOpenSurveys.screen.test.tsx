// @vitest-environment jsdom
import { createRoot } from 'react-dom/client';
import { act, createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';

// BUG-UG-OPEN-SURVEY-UNREACHABLE-FROM-HOME-AND-PHONE-20261111
// (#8209), executed on the shared stand-in (#8319): Pulse's "Open surveys"
// and "Complete the quarterly survey" opened /feature/voice, which for a
// signed-in member is Be heard's generic screen with no survey list. Each
// button is pressed on the real Pulse screen, and the address it opens is run
// through the real route table, which must reach a screen of its own.
const runtime = vi.hoisted(() => ({ push: vi.fn(), load: vi.fn(), app: {
  mode: 'authenticated', session: { user: { id: 'member-1' } }, organizationID: 'org-1', sessionRestricted: false, refresh: vi.fn(), error: null,
  dashboard: { member: { id: 'member-1', chapterID: 'chapter-1' } }, previewDesk: null, previewHat: 'member', authorizedRoles: ['member'],
  staffRoleChoices: [], chosenStaffRole: null, chapterRoles: [], organizationRoles: [], chapterMemberships: [], locked: false, assuranceUnavailable: false,
} }));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../components/ui', () => import('../testing/uiStandIn'));
vi.mock('expo-router', async () => {
  const react = await import('react');
  return { useRouter: () => ({ push: runtime.push }), useFocusEffect: (callback: () => (() => void) | void) => react.useEffect(callback, [callback]) };
});
vi.mock('expo-crypto', () => ({}));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => undefined }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-svg', () => ({}));
// One stable app value, as the provider gives: a new object per render would
// restart the screen's effects on every render.
vi.mock('../state/AppProvider', () => ({ useApp: () => runtime.app }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('../services/memberPulse', () => ({ loadMemberPulse: runtime.load }));
vi.mock('../services/pulseHistory', () => ({ loadPulseHistory: async () => [] }));
vi.mock('../services/pulseOpeningPreference', () => ({ loadPulseOpening: async () => null, savePulseOpening: async () => undefined }));
vi.mock('../lib/chrome', () => ({ screenBottomInset: () => 0, useNativeTabContentInset: () => 0 }));
vi.mock('../components/PulseCatalog', () => ({ PulseCatalogCard: () => null, PulseExpandSheet: () => null }));
vi.mock('./SavedPulseCharts', () => ({ SavedChartSlot: () => null, useSavedPulseChartCount: () => 0 }));
vi.mock('./guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null }));
vi.mock('../data/useChannels', () => ({ useChannelStore: () => ({
  subscribe: () => () => {}, getVersion: () => 0, poll: () => null, status: () => 'ready', refresh: vi.fn(), channels: () => [],
}) }));
// The route table: FeatureScreen decides which screen an address opens. Its
// own screens are stubs here; the check reads which one it chose, with the
// role gate held open for a permitted signed-in member.
vi.mock('../lib/featureCatalog', async (original) => ({ ...await original<object>(), canOpenFeature: () => true }));
vi.mock('../services/analyticsPreference', () => ({ useProductAnalyticsEnabled: () => false, gatePageViewRecorder: () => () => undefined }));
vi.mock('../lib/useFeaturePageView', () => ({ useFeaturePageView: () => undefined }));
vi.mock('./forms/keptFormEditor', () => ({ useKeptFormEditor: () => ({ read: () => null, write: () => undefined }) }));
vi.mock('./noticePendingSend', async original => ({ ...(await original() as typeof import('./noticePendingSend')), usePendingNoticeSend: () => null }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: () => ({ userId: 'member-a' }) }));
vi.mock('../services/governance', () => ({}));
vi.mock('../services/observability', () => ({ captureNativeScreen: () => undefined }));
vi.mock('../services/ssoRelease', () => ({ useSsoReleased: () => false }));
vi.mock('../services/haptics', () => ({ haptics: {} }));
vi.mock('../components/AskCompassButton', () => ({}));
vi.mock('../components/TransactionalAction', () => ({}));
vi.mock('../components/CaseRowPressable', () => ({}));
vi.mock('../components/PressableScale', () => ({}));
vi.mock('../components/ChapterVerificationControls', () => ({}));
vi.mock('../components/NumberFlow', () => ({}));
vi.mock('../components/StaffRolePicker', () => ({}));
vi.mock('./LiveAppointmentsFeature', () => ({}));
vi.mock('./LiveLivedInScreens', () => ({}));
vi.mock('./MemberSupportScreen', () => ({}));
vi.mock('./ChapterMembershipsScreen', () => ({}));
vi.mock('./ChapterInvitationsScreen', () => ({}));
vi.mock('./OrgStructureScreen', () => ({}));
vi.mock('./mi1/PayToolsScreen', () => ({}));
vi.mock('./mi1/Mi1FeatureScreen', () => ({}));
vi.mock('./mi1/Mi1AnalyticsScreen', () => ({}));
vi.mock('./mi1/ConnectionSuggestionsPanel', () => ({}));
vi.mock('./mi1/OrganizationIntelligenceScreens', () => ({}));
vi.mock('./mi1/Mi1QaFeatureScreen', () => ({}));
vi.mock('./learning/LearningContentManager', () => ({}));
vi.mock('./learning/LearningLibrarySection', () => ({}));
vi.mock('./StewardDeskSectionsScreen', () => ({}));
vi.mock('../theme/elevation', () => ({ elevation: {} }));

import type { FeatureKey } from '../lib/featureCatalog';
import { FeatureScreen } from './FeatureScreen';
import MemberPulseScreen from './MemberPulseScreen';

// The screen the route table opens for /feature/<key>.
function screenFor(href: string): string {
  const key = href.replace(/^\/feature\//, '').split('?')[0] as FeatureKey;
  let element: ReturnType<typeof FeatureScreen> | null = null;
  function Probe() { element = FeatureScreen({ featureKey: key }); return null; }
  const host = document.createElement('div'); const root = createRoot(host);
  act(() => { root.render(h(Probe)); }); act(() => root.unmount());
  const routed = element as { type: unknown } | null;
  if (!routed) return 'nothing';
  return typeof routed.type === 'string' ? routed.type : (routed.type as { name: string }).name;
}

const pulse = (statisticsLocked: boolean) => ({
  updatedAt: new Date('2026-11-11T18:00:00Z'), cards: [], next: null, nextAvailable: false, statisticsLocked,
  surveys: ['Scheduling'], notice: null,
});

let screen: Rendered | null = null;
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); runtime.push.mockReset(); runtime.load.mockReset(); });

describe.each(['ios', 'android'] as const)('Pulse survey buttons on %s', (os) => {
  it.each([
    ['Open surveys', false],
    ['Complete the quarterly survey', true],
  ])('"%s" opens a screen that lists the surveys', async (label, statisticsLocked) => {
    setPlatform(os);
    runtime.load.mockResolvedValue(pulse(statisticsLocked));
    screen = await render(h(MemberPulseScreen));
    await press(getExposed(screen.container, label));
    expect(runtime.push).toHaveBeenCalledTimes(1);
    const href = String(runtime.push.mock.calls[0]?.[0]);
    expect(href).toMatch(/^\/feature\//);
    expect(screenFor(href)).toBe('LiveVotingFeature');
  });
});
