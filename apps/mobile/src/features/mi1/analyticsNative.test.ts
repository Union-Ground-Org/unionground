// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act, createElement, type PropsWithChildren } from 'react';

import { describe, expect, it, vi } from 'vitest';

import { canOpenFeature, isStaffOnlyFeatureKey } from '../../lib/featureCatalog';
import {
  authorizeAnalyticsAccess,
  buildNativeActor,
  composeAnalyticsCore,
  createAnalyticsCoreAdapter,
  MI1_ANALYTICS_NATIVE_PERSISTENCE,
} from '../../lib/mi1AnalyticsShared';
import { routeFromNotification } from '../../lib/routes';
import { getExposed, press, render } from '../../testing/reactNativeStandIn';
import { resolveTheme } from '../../theme/tokens';
import { AnalyticsCoreScreen } from './AnalyticsCoreScreen';

const language = vi.hoisted(() => ({ current: 'en' }));
const refreshPress = vi.hoisted(() => ({ handler: undefined as (() => void) | undefined }));
vi.mock('react-native', () => import('../../testing/reactNativeStandIn'));
vi.mock('../../components/ui', async () => {
  const ui = await import('../../testing/uiStandIn');
  return {
    ...ui,
    Button: (props: Parameters<typeof ui.Button>[0]) => {
      if (props.label === 'Refresh') refreshPress.handler = props.onPress;
      return createElement('div', { 'aria-busy': props.busy }, createElement(ui.Button, props));
    },
  };
});
vi.mock('../../components/QuarterlySurveyGate', () => ({ QuarterlySurveyGate: ({ children }: PropsWithChildren) => children }));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => resolveTheme('union-ground') }));
vi.mock('../../state/AppProvider', () => ({ useApp: () => ({ memberLanguage: language.current }) }));
vi.mock('../../services/haptics', () => ({ haptics: { select: vi.fn() } }));
// Mobile CI installs only apps/mobile. Use the shared implementation without
// requiring the web re-export's package link in root node_modules.
vi.mock('../../../../../src/lib/featureSwitches.js', () => import('../../../../../src/lib/shared-core/featureSwitches.js'));

function source(relativeFromThisFile: string): string {
  return readFileSync(fileURLToPath(new URL(relativeFromThisFile, import.meta.url)), 'utf8');
}

// Pins the argument order of the composeAnalyticsCore call without pinning the casts,
// so dropping `as any` stays green but swapping snapshot and workspace does not.
const COMPOSE_ANALYTICS_CORE_CALL =
  /composeAnalyticsCore\(\{\s*snapshot:\s*snapshot(?:\s+as\s+\w+)?,\s*workspace:\s*workspace(?:\s+as\s+\w+)?,\s*viewer\s*\}\)/;

describe('MI1 native analytics wiring', () => {
  it.each<[string, string]>([
    ['en', 'Refresh'],
    ['es', 'Actualizar'],
  ])('offers a refresh action for a non-ready snapshot in %s', async (lang, refresh) => {
    language.current = lang;
    const actor = buildNativeActor({
      userId: 'operator-1', organizationId: 'org-a', roles: ['admin'], organizationRoles: ['admin'],
      selectedHat: 'admin', authenticated: true, mfaSatisfied: true,
    });
    const loadSnapshot = vi.fn(async () => ({}));
    const loadWorkspace = vi.fn(async () => ({}));
    const screen = await render(createElement(AnalyticsCoreScreen, { actor, loadSnapshot, loadWorkspace }));
    try {
      expect(loadSnapshot).toHaveBeenCalledTimes(1);
      expect(loadWorkspace).toHaveBeenCalledTimes(1);
      await press(getExposed(screen.container, refresh));
      expect(loadSnapshot).toHaveBeenCalledTimes(2);
      expect(loadWorkspace).toHaveBeenCalledTimes(2);
    } finally { await screen.unmount(); }
  });

  it('accepts only one retry from two rapid Refresh presses while the loader is pending', async () => {
    language.current = 'en';
    const actor = buildNativeActor({
      userId: 'operator-1', organizationId: 'org-a', roles: ['admin'], organizationRoles: ['admin'],
      selectedHat: 'admin', authenticated: true, mfaSatisfied: true,
    });
    let resolveSnapshot!: (value: Record<string, unknown>) => void;
    const pending = new Promise<Record<string, unknown>>((resolve) => { resolveSnapshot = resolve; });
    const loadSnapshot = vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValueOnce({}).mockReturnValue(pending);
    const loadWorkspace = vi.fn(async () => ({}));
    const screen = await render(createElement(AnalyticsCoreScreen, { actor, loadSnapshot, loadWorkspace }));
    try {
      const refresh = getExposed(screen.container, 'Refresh');
      const queuedPress = refreshPress.handler;
      expect(queuedPress).toBeTypeOf('function');
      await press(refresh);
      // A second tap can already be queued with the handler from the same render.
      await act(async () => queuedPress?.());
      expect(loadSnapshot).toHaveBeenCalledTimes(2);
      expect(loadWorkspace).toHaveBeenCalledTimes(2);
      expect(getExposed(screen.container, 'Refresh')).toBe(refresh);
      expect(refresh.getAttribute('aria-disabled')).toBe('true');
      expect(refresh.parentElement?.getAttribute('aria-busy')).toBe('true');

      await act(async () => resolveSnapshot({}));
      expect(refresh.hasAttribute('aria-disabled')).toBe(false);
      expect(refresh.parentElement?.getAttribute('aria-busy')).toBe('false');
    } finally { await screen.unmount(); }
  });

  it('registers Organization analytics as a staff-only destination', () => {
    expect(canOpenFeature('preview', 'analytics', 'member')).toBe(false);
    expect(canOpenFeature('preview', 'analytics', 'steward')).toBe(true);
    expect(isStaffOnlyFeatureKey('analytics')).toBe(true);
    expect(routeFromNotification({ screen: 'analytics' })).toBeNull();
  });

  it('uses an explicit selected organization and never invents a tenant', () => {
    expect(MI1_ANALYTICS_NATIVE_PERSISTENCE.analyticsSnapshot).toBe(true);
    expect(MI1_ANALYTICS_NATIVE_PERSISTENCE.analyticsWorkspace).toBe(true);
    expect(MI1_ANALYTICS_NATIVE_PERSISTENCE.memberReportCard).toBe(true);

    const empty = buildNativeActor({
      userId: 'member-1',
      chapterId: 'wor',
      roles: ['admin'],
      organizationRoles: ['admin'],
      selectedHat: 'admin',
      authenticated: true,
    });
    expect(empty.organizationId).toBeNull();
    expect(authorizeAnalyticsAccess({
      organizationId: empty.organizationId,
      selectedHat: 'admin',
      roles: ['admin'],
      organizationRoles: ['admin'],
    }).ok).toBe(false);

    const scoped = buildNativeActor({
      userId: 'member-1',
      organizationId: 'org-a',
      chapterId: 'wor',
      roles: ['admin'],
      organizationRoles: ['admin'],
      selectedHat: 'admin',
      authenticated: true,
    });
    expect(authorizeAnalyticsAccess({
      organizationId: scoped.organizationId,
      selectedHat: scoped.selectedHat,
      roles: scoped.roles,
      organizationRoles: scoped.organizationRoles,
    }).ok).toBe(true);

    const desk = composeAnalyticsCore({
      snapshot: null,
      viewer: { organizationId: null, selectedHat: 'steward', roles: ['steward'] },
    });
    expect(desk.state).toBe('empty');
    expect(desk.stats).toBeNull();

    const adapter = createAnalyticsCoreAdapter();
    expect(adapter.requestedRpcs.snapshot).toBe('get_organization_analytics_snapshot');
  });

  it('reuses shared engines and backed preview history without mounting the web desk', () => {
    const shared = source('../../lib/mi1AnalyticsShared.ts');
    const analytics = source('./AnalyticsCoreScreen.tsx');
    const wrapper = source('./Mi1AnalyticsScreen.tsx');
    const service = source('../../services/supabase.ts');
    const feature = source('../FeatureScreen.tsx');

    expect(shared).toContain("from '../../../../src/features/analytics/contract.js'");
    expect(shared).not.toContain('AnalyticsCoreDesk');
    expect(shared).toContain('createPreviewAnalyticsSnapshot');
    expect(wrapper).toContain("mode === 'preview'");
    expect(shared).not.toContain('createQaRpcAdapter');
    expect(analytics).toMatch(COMPOSE_ANALYTICS_CORE_CALL);
    expect(analytics).toContain('<AnalyticsTab desk={desk} tab={tab} />');
    expect(analytics).toContain('paginateAnalyticsLayouts(layouts, page)');
    expect(analytics).toContain('paginateAnalyticsMembers(members, page)');
    expect(analytics).toContain('<PaginatedMembers members={desk.workspace.members}');
    expect(analytics).not.toContain('workspace.workers.slice(0, 50)');
    expect(analytics).toContain('<PaginatedLayouts key="studio"');
    expect(analytics).toContain('<PaginatedLayouts key="chapter-charts"');
    expect(analytics).toContain('label="Next page"');
    expect(shared).toContain('paginateAnalyticsLayouts');
    expect(shared).toContain('paginateAnalyticsMembers');
    expect(analytics).toContain("import { useAccessibilityAnnouncementQueue } from '../../lib/announce'");
    expect(analytics).toContain('accessibilityLiveRegion="polite"');
    expect(analytics).toContain('queueAnnouncement(pageAnnouncement(nextPage, pageCount))');
    expect(analytics).toContain('ANALYTICS_TAB_LABELS[item]');
    expect(wrapper).toContain('loadMobileOrganizationAnalyticsSnapshot');
    expect(wrapper).toContain('organizationID, organizationRoles, chapterRoles } = useApp()');
    expect(service).toContain("supabase.rpc('get_organization_analytics_snapshot')");
    expect(service).toContain("supabase.rpc('get_organization_analytics_workspace')");
    expect(feature).toContain("if (featureKey === 'analytics')");
    expect(feature).toContain('<Mi1AnalyticsScreen />');
  });
});
