import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// TEST-UG-CONTRACT-CHECKS-A-FALLBACK-CANNOT-SATISFY-20261111 (#8324):
// every address the phone can open must reach a screen of its own for a
// signed-in person who may open it, not the screen FeatureScreen falls back to
// (the generic "evidence" list until #8630, UnbuiltFeatureScreen since). This
// runs the shipped route table; it replaces the #8262 guard, which passed for
// any registered key.
const stub = vi.hoisted(() => (extra: Record<string, unknown> = {}) => new Proxy(extra, {
  get: (target, key) => (key in target ? target[key as string] : key === '__esModule' ? true : key === 'then' ? undefined : String(key)),
  has: () => true,
}));

vi.mock('react', async (original) => ({ ...await original<object>(), useMemo: (factory: () => unknown) => factory() }));
vi.mock('../lib/useBusinessWriter', () => ({ useBusinessWriter: () => ({ userId: 'm1' }) }));
vi.mock('react-native', () => stub({ StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1, absoluteFill: {} }, Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default } }));
vi.mock('expo-router', () => stub({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-crypto', () => stub());
vi.mock('@expo/vector-icons', () => stub());
vi.mock('expo-secure-store', () => stub());
vi.mock('expo-linking', () => stub());
vi.mock('expo-blur', () => stub());
vi.mock('expo-audio', () => stub());
vi.mock('expo-linear-gradient', () => stub());
vi.mock('expo-constants', () => stub({ default: { expoConfig: { extra: {} } } }));
vi.mock('expo-apple-authentication', () => stub());
vi.mock('expo-web-browser', () => stub());
vi.mock('react-native-safe-area-context', () => stub({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-svg', () => stub());
vi.mock('react-native-screens/experimental', () => stub());
vi.mock('@react-native-masked-view/masked-view', () => stub());
vi.mock('posthog-react-native', () => stub());
vi.mock('@supabase/supabase-js', () => stub());
// A live session that has loaded its dashboard. The role gate is held open so
// the check reads the screen a permitted person reaches.
vi.mock('../state/AppProvider', () => stub({ useApp: () => ({ dashboard: { member: { id: 'm1', chapterID: 'c1' } }, mode: 'authenticated', previewDesk: null, previewHat: 'member', authorizedRoles: ['member'], staffRoleChoices: [], chosenStaffRole: null, chapterRoles: [], organizationRoles: [], organizationID: 'o1', chapterMemberships: [], locked: false, assuranceUnavailable: false }) }));
vi.mock('../lib/featureCatalog', async (original) => ({ ...await original<object>(), canOpenFeature: () => true }));
vi.mock('../services/analyticsPreference', () => stub({ useProductAnalyticsEnabled: () => false, gatePageViewRecorder: () => () => undefined }));
vi.mock('../lib/useFeaturePageView', () => stub({ useFeaturePageView: () => undefined }));
vi.mock('./forms/keptFormEditor', () => stub({ useKeptFormEditor: () => ({ read: () => null, write: () => undefined }) }));
// This calls the route table outside a renderer, with no pending notice.
vi.mock('./noticePendingSend', async original => ({ ...(await original() as typeof import('./noticePendingSend')), usePendingNoticeSend: () => null }));
vi.mock('../services/supabase', () => stub());
vi.mock('../services/governance', () => stub());
vi.mock('../services/observability', () => stub());
vi.mock('../services/ssoRelease', () => stub({ useSsoReleased: () => false }));
vi.mock('../services/haptics', () => stub({ haptics: {} }));
// Every screen and component FeatureScreen can hand a key to is a named stub:
// the check reads which one the route table chose, not what it renders.
vi.mock('../components/AskCompassButton', () => stub());
vi.mock('../components/TransactionalAction', () => stub());
vi.mock('../components/CaseRowPressable', () => stub());
vi.mock('../components/PressableScale', () => stub());
vi.mock('../components/ChapterVerificationControls', () => stub());
vi.mock('../components/NumberFlow', () => stub());
vi.mock('../components/ui', () => stub());
vi.mock('../components/StaffRolePicker', () => stub());
vi.mock('./LiveAppointmentsFeature', () => stub());
vi.mock('./LiveLivedInScreens', () => stub());
vi.mock('./MemberSupportScreen', () => stub());
vi.mock('./ChapterMembershipsScreen', () => stub());
vi.mock('./OrgStructureScreen', () => stub());
vi.mock('./mi1/PayToolsScreen', () => stub());
vi.mock('./mi1/Mi1FeatureScreen', () => stub());
vi.mock('./mi1/Mi1AnalyticsScreen', () => stub());
vi.mock('./mi1/ConnectionSuggestionsPanel', () => stub());
vi.mock('./mi1/OrganizationIntelligenceScreens', () => stub());
vi.mock('./mi1/Mi1QaFeatureScreen', () => stub());
vi.mock('./learning/LearningContentManager', () => stub());
vi.mock('./learning/LearningLibrarySection', () => stub());
vi.mock('./guideLayers/GuideLayers', () => stub());
vi.mock('./StewardDeskSectionsScreen', () => stub());
vi.mock('./LiveFeatureScreens', () => stub());
vi.mock('../data/useChannels', () => stub());
vi.mock('../theme/ThemeProvider', () => stub());
vi.mock('../theme/elevation', () => stub({ elevation: {} }));

import { FEATURE_KEYS, isFeatureKey, type FeatureKey } from '../lib/featureCatalog';
import { STAFF_HAT_FUNCTIONS, type LiveStaffRole } from '../lib/hatFunctions';
import { appRouteFromRouterPath } from '../lib/routes';
import { staffDeskNumberDestination, staffDeskNumberLabels } from '../lib/staffDeskNumbers';
import { FeatureScreen } from './FeatureScreen';

const GENERIC_SCREEN = 'UnbuiltFeatureScreen';

// Keys that open only the generic screen, each with the record that will build
// or remove it. Both lists are empty since #8630 gave the last seven keys
// screens of their own (the generic evidence list is gone; UnbuiltFeatureScreen
// is the fallback now), and nothing may join them: a new address ships with
// its screen.
const FROZEN_GENERIC_ONLY: readonly string[] = [];
const GENERIC_ONLY: Partial<Record<FeatureKey, string>> = {};

function screenFor(key: string): string {
  const element: { type: unknown } | null = FeatureScreen({ featureKey: key as FeatureKey });
  if (!element) return 'nothing';
  return typeof element.type === 'string' ? element.type : (element.type as { name: string }).name;
}

// The addresses that reach only the generic screen and are not listed.
function unbuiltAddresses(keys: Iterable<string>, listed: Partial<Record<string, string>>): string[] {
  return [...new Set(keys)].filter((key) => screenFor(key) === GENERIC_SCREEN && !listed[key]).sort();
}

// Every `/feature/<key>` address the shipped phone code (not its tests) pushes,
// in single, double or back quotes (ledger 70).
const mobileRoot = fileURLToPath(new URL('../..', import.meta.url));
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
const pushedKeys = [...new Set(['src', 'app'].flatMap((dir) => sourceFiles(join(mobileRoot, dir)))
  .flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/['"`]\/feature\/([a-z0-9-]+)/g)].flatMap((match) => (match[1] ? [match[1]] : []))))].sort();

const roles: LiveStaffRole[] = ['steward', 'coordinator', 'advisor', 'admin', 'vp'];
const staffHrefs = roles.flatMap((role) => [
  ...STAFF_HAT_FUNCTIONS[role].map((item) => item.href),
  ...staffDeskNumberLabels(role).map((label) => staffDeskNumberDestination(role, label).href),
]);
const featureKeyOf = (href: string) => href.startsWith('/feature/') ? href.slice('/feature/'.length) : null;

describe('every phone address opens a screen of its own (route table executed)', () => {
  it('reaches a named screen for each registered feature key, apart from the listed ones', () => {
    expect(unbuiltAddresses(FEATURE_KEYS, GENERIC_ONLY)).toEqual([]);
  });

  it('lists only keys that still open the generic screen, each with its record, and the list never grows', () => {
    for (const [key, record] of Object.entries(GENERIC_ONLY)) {
      expect(screenFor(key), `${key} has a screen now; remove it from GENERIC_ONLY`).toBe(GENERIC_SCREEN);
      expect(record, key).toMatch(/^#\d+$/);
      expect(FROZEN_GENERIC_ONLY as readonly string[], `${key} may not join the list`).toContain(key);
    }
    expect(Object.keys(GENERIC_ONLY).sort(), 'a key that leaves GENERIC_ONLY leaves FROZEN_GENERIC_ONLY too').toEqual([...FROZEN_GENERIC_ONLY].sort());
  });

  it('opens each of the seven former generic-only addresses on a screen of its own (#8630)', () => {
    expect(screenFor('admin')).toBe('ChapterAdminScreen');
    expect(screenFor('campaigns')).toBe('LiveCampaignsScreen');
    expect(screenFor('voice')).toBe('LiveBeHeardScreen');
    expect(screenFor('search')).toBe('LiveSearchScreen');
    expect(screenFor('steward')).toBe('LiveCaseworkDeskScreen');
    expect(screenFor('coordinator')).toBe('LiveCaseQueueScreen');
    expect(screenFor('forms')).toBe('LiveFormsScreen');
    expect(Object.keys(GENERIC_ONLY)).toEqual([]);
    expect(FROZEN_GENERIC_ONLY).toEqual([]);
  });

  it('reaches a named screen for every /feature address the phone code pushes', () => {
    expect(pushedKeys.length).toBeGreaterThan(30);
    expect(pushedKeys.filter((key) => !isFeatureKey(key))).toEqual([]);
    expect(unbuiltAddresses(pushedKeys, GENERIC_ONLY)).toEqual([]);
  });

  it('reaches a real screen from every staff desk row and desk number', () => {
    const featureKeys = staffHrefs.map(featureKeyOf).filter((key): key is string => key !== null);
    expect(featureKeys.filter((key) => !isFeatureKey(key))).toEqual([]);
    expect(unbuiltAddresses(featureKeys, GENERIC_ONLY)).toEqual([]);
    expect(staffHrefs.filter((href) => featureKeyOf(href) === null && appRouteFromRouterPath(href) === null)).toEqual([]);
  });

  it('fails on a seeded violation: a key with no screen, or one taken off the list', () => {
    expect(unbuiltAddresses(['seeded-key-with-no-screen', 'cases'], GENERIC_ONLY)).toEqual(['seeded-key-with-no-screen']);
    // A listed key is exempt only while it is listed (a synthetic key, so no
    // real route has to stay generic for this control to hold).
    expect(unbuiltAddresses(['seeded-key-with-no-screen'], { 'seeded-key-with-no-screen': '#1' })).toEqual([]);
    expect(unbuiltAddresses(['seeded-key-with-no-screen'], {})).toEqual(['seeded-key-with-no-screen']);
  });
});
