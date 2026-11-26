// @vitest-environment jsdom
// TEST-UG-NATIVE-OWN-CASES-DONUT-PROOF-20261102: the Pulse tab route
// for valid signed-in role sets, driven through the shipped normalization
// (loadMobileStaffScope -> deriveLiveStaffRoles -> narrowLiveStaffRoles) into
// the real PulseScreen. Only the network client and the leaf screens are
// stubbed. Every set lands on a per-hat screen; none reaches the sampled
// demo charts or a retired own-cases screen.
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveTheme } from '../theme/tokens';

const runtime = vi.hoisted(() => ({
  app: { mode: 'authenticated', dashboard: null as unknown, previewDesk: null, sessionRestricted: false, previewHat: null as string | null, authorizedRoles: [] as string[] },
  rpcData: null as unknown,
}));
vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('@supabase/supabase-js', () => ({
  processLock: async (_name: string, _timeout: number, fn: () => unknown) => fn(),
  createClient: () => ({
    rpc: async () => ({ data: runtime.rpcData, error: null }),
    auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  }),
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, supabaseUrl: 'https://fixture.invalid', supabasePublishableKey: 'fixture-key', backend: 'fixture' } }));
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({ getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }) }));
vi.mock('../services/authFetch', () => ({ createFailClosedAuthFetch: () => fetch }));
vi.mock('../state/AppProvider', () => ({ useApp: () => runtime.app }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => resolveTheme('union-ground') }));
vi.mock('./MemberPulseScreen', () => ({ default: () => createElement('span', null, 'ROUTE:member') }));
vi.mock('./StewardPulseScreen', () => ({ default: () => createElement('span', null, 'ROUTE:steward') }));
vi.mock('./LeadershipPulseScreen', () => ({ default: ({ hat }: { hat: string }) => createElement('span', null, `ROUTE:leadership:${hat}`) }));
vi.mock('./guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null }));
vi.mock('../lib/chrome', () => ({ screenBottomInset: () => 0, useNativeTabContentInset: () => 24, contentStartInset: () => 0 }));
vi.mock('../components/PinnedHeader', () => ({ usePinnedHeaderChrome: () => null, useScreenNameAlreadySpoken: () => ({ hiddenProps: {} }) }));
vi.mock('../components/TopChrome', () => ({ TopRamp: () => null }));
vi.mock('../components/NumberFlow', () => ({ NumberFlow: () => null }));
vi.mock('../components/charts', () => ({ ActivityRings: () => null, ClusterBadges: () => null, DonutChart: () => null, DualLineChart: () => null, PeriodBarChart: () => null, StackedAreaChart: () => null, TrendSpotlight: () => null }));
vi.mock('../data/demoChannels', () => ({ channelStore: { subscribe: () => () => {}, getVersion: () => 0, poll: () => ({ options: [] }), pollTotal: () => 0 }, pollShares: () => [] }));
vi.mock('../services/haptics', () => ({ haptics: { select: async () => {} } }));
vi.mock('expo-router', () => ({ Redirect: ({ href }: { href: string }) => createElement('span', null, `ROUTE:redirect:${href}`) }));
vi.mock('react-native-safe-area-context', async () => {
  const { createElement: h } = await import('react');
  return { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }), SafeAreaView: ({ children }: { children?: ReactNode }) => h('div', null, children) };
});
vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const box = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return { View: box, Text: box, ScrollView: box, Pressable: box, StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 } };
});
vi.mock('../components/ui', async () => {
  const { createElement: h } = await import('react');
  const box = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return { Screen: box, SparkBars: () => null, StateMessage: ({ title }: { title: string }) => h('div', null, `STATE:${title}`) };
});
vi.mock('../lib/nativeAuthGate', () => ({ nativeAuthGate: { canWrite: () => true } }));
import { loadMobileStaffScope } from '../services/supabase';
import { deriveLiveStaffRoles, narrowLiveStaffRoles, type LiveStaffRole } from '../lib/hatFunctions';
import PulseScreen from './PulseScreen';

const dashboard = { member: { chapterID: 'chapter-a' }, cases: [{ id: 'c1', status: 'active', step: 'Intake' }], conversations: [], weeklyActions: [], notifications: [] };
let root: Root, host: HTMLDivElement;
async function pulseRoute(wire: { roles: string[]; chapterRoles?: string[]; staffAuthorized?: boolean }, pick: LiveStaffRole | null = null) {
  runtime.rpcData = { organizationId: 'org-a', roles: wire.roles, chapterRoles: wire.chapterRoles ?? [], staffAuthorized: wire.staffAuthorized ?? true };
  const live = deriveLiveStaffRoles({ mode: 'authenticated', previewRoles: [], organizationStaffScope: await loadMobileStaffScope() });
  runtime.app.authorizedRoles = narrowLiveStaffRoles(live, pick).authorizedRoles;
  await act(async () => { root.render(createElement(PulseScreen)); });
  const text = host.textContent ?? '';
  // The sampled board's hero reads STRONG; it must never paint for a live account.
  expect(text).not.toContain('STRONG');
  return text.match(/ROUTE:[a-z:/-]+/)?.[0] ?? text.slice(0, 80);
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  Object.assign(runtime.app, { mode: 'authenticated', dashboard, sessionRestricted: false, previewHat: null, authorizedRoles: [] });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('native Pulse tab routing for signed-in role sets', () => {
  it.each<[string, { roles: string[]; chapterRoles?: string[]; staffAuthorized?: boolean }, LiveStaffRole | null, string]>([
    ['no staff role', { roles: [] }, null, 'ROUTE:member'],
    ['roles the client never projects', { roles: ['member', 'president', 'Committee'] }, null, 'ROUTE:member'],
    ['staff roles without server authorization', { roles: ['steward', 'admin'], staffAuthorized: false }, null, 'ROUTE:member'],
    ['a sole committee member, duplicated across scopes', { roles: ['steward'], chapterRoles: ['steward'] }, null, 'ROUTE:steward'],
    ['a sole campaign lead', { roles: [], chapterRoles: ['coordinator'] }, null, 'ROUTE:leadership:coordinator'],
    ['a sole advisor', { roles: ['advisor'] }, null, 'ROUTE:leadership:advisor'],
    ['a sole administrator', { roles: ['admin'] }, null, 'ROUTE:leadership:admin'],
    ['a sole campaign chair (vp)', { roles: ['vp'] }, null, 'ROUTE:leadership:vp'],
    ['several roles and no pick', { roles: ['admin'], chapterRoles: ['steward'] }, null, 'ROUTE:member'],
    ['several roles narrowed to committee member', { roles: ['admin'], chapterRoles: ['steward'] }, 'steward', 'ROUTE:steward'],
    ['several roles narrowed to admin', { roles: ['admin', 'vp'], chapterRoles: ['steward'] }, 'admin', 'ROUTE:leadership:admin'],
    ['several roles with a stale pick', { roles: ['admin'], chapterRoles: ['steward'] }, 'vp', 'ROUTE:member'],
  ])('%s', async (_name, wire, pick, expected) => {
    expect(await pulseRoute(wire, pick)).toBe(expected);
  });

  it('sends a signed-in account outside every per-hat route to Worker Pulse, even before the workspace loads', async () => {
    // Normalization never yields this pair; it is the only input that reached
    // the retired own-cases screen, and it now falls to the member hat.
    runtime.app.authorizedRoles = ['coordinator', 'member'];
    await act(async () => { root.render(createElement(PulseScreen)); });
    expect(host.textContent).toBe('ROUTE:member');
    runtime.app.dashboard = null;
    expect(await pulseRoute({ roles: [] })).toBe('ROUTE:member');
  });
});
