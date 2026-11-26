import { stubSessionWriter } from '../../testing/stubSessionWriter';
// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exposedNames, getExposed, press, render, setPlatform, type Rendered } from '../../testing/reactNativeStandIn';

// REQ-UG-NEURO-MAP-ORGANIZATION-SWITCH-20261112 (#8437): the
// organization switch features.intelligence.neuro_map hides the Neuro Map tab
// of the phone's organization map on iPhone and Android. On, nothing changes;
// the offline preview keeps it on.
const app = vi.hoisted(() => ({ mode: 'authenticated', token: 'token-0' }));
const api = vi.hoisted(() => ({ snapshot: vi.fn(), configuration: vi.fn() }));
vi.mock('react-native', () => import('../../testing/reactNativeStandIn'));
vi.mock('../../components/ui', async () => ({ ...await import('../../testing/uiStandIn'), OptionPicker: () => null }));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('../../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => () => undefined }));
vi.mock('./ConnectionSuggestionsPanel', () => ({ ConnectionSuggestionsPanel: () => null }));
vi.mock('../../state/AppProvider', () => ({ useApp: () => ({
  mode: app.mode, session: app.mode === 'authenticated' ? { user: { id: 'member-a' }, access_token: app.token } : null,
  dashboard: { member: { id: 'admin-1', chapterID: 'chapter-1' } }, previewHat: app.mode === 'preview' ? 'admin' : null, authorizedRoles: ['admin'],
  chapterMemberships: [{ chapterID: 'chapter-1', organizationID: 'org-1', selected: true }], organizationID: 'org-1', organizationRoles: ['admin'],
}) }));
vi.mock('../../services/supabase', () => ({ captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => null, session?.user?.id ?? 'member-a'),
  createCapturedSessionRpcClient: () => ({ rpc: api.configuration }),
  loadMobileOrganizationIntelligenceSnapshot: api.snapshot,
  loadMobileCollectiveActions: vi.fn(), saveMobileCollectiveAction: vi.fn(), requestMobileCollectiveActionExport: vi.fn(), saveMobileOrganizationChartNode: vi.fn(),
  saveMobileOrganizationRelationship: vi.fn(), saveMobileOrganizationTimelineEvent: vi.fn(), saveMobileOrganizationTopicProgress: vi.fn(),
  toggleMobileCollectiveActionParticipation: vi.fn(),
}));

import { NEURO_MAP_SWITCH_KEY, OrganizationIntelligenceScreen } from './OrganizationIntelligenceScreens';

const snapshot = {
  organizationId: 'org-1', generatedAt: '2026-11-12T12:00:00Z', chartNodes: [], timeline: [],
  relationshipNodes: [{ id: 'sam', label: 'Sam Okafor' }, { id: 'maya', label: 'Maya Chen' }],
  relationships: [{ id: 'r1', sourceId: 'sam', targetId: 'maya', kind: 'works_with', strength: 4 }],
  topicProgress: [],
};

let screen: Rendered | null = null;
let tokens = 0;
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); app.mode = 'authenticated'; api.snapshot.mockReset(); api.configuration.mockReset(); });

async function open(switches: Record<string, unknown>, mode = 'authenticated') {
  app.mode = mode;
  app.token = `token-${tokens += 1}`; // the switch read is cached per access token
  api.snapshot.mockResolvedValue(snapshot);
  api.configuration.mockResolvedValue({ data: { switches }, error: null });
  screen = await render(h(OrganizationIntelligenceScreen));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return screen;
}

describe.each(['ios', 'android'] as const)('Neuro Map switch on %s', (os) => {
  it('shows the Neuro Map tab and its relationships with the switch on', async () => {
    setPlatform(os);
    const view = await open({ [NEURO_MAP_SWITCH_KEY]: true });
    expect(exposedNames(view.container)).toEqual(expect.arrayContaining(['Charts', 'Neuro Map', 'Timeline']));
    await press(getExposed(view.container, 'Neuro Map'));
    expect(view.container.textContent).toContain('Sam Okafor → Maya Chen · works with · 4/5');
  });

  it('offers no Neuro Map tab with the switch off', async () => {
    setPlatform(os);
    const view = await open({ [NEURO_MAP_SWITCH_KEY]: false });
    const names = exposedNames(view.container);
    expect(names).toEqual(expect.arrayContaining(['Charts', 'Timeline']));
    expect(names).not.toContain('Neuro Map');
    expect(view.container.textContent).not.toContain('Sam Okafor');
  });

  it('keeps the tab when the organization never set the switch', async () => {
    setPlatform(os);
    const view = await open({});
    expect(exposedNames(view.container)).toContain('Neuro Map');
  });

  // The configuration is cached per access token, so after an administrator
  // changes the switch only the snapshot, read on every open, is current.
  it.each([
    ['shows', false, true],
    ['hides', true, false],
  ] as const)('%s the tab as soon as the snapshot says so, on the same access token', async (_verb, cached, current) => {
    setPlatform(os);
    const first = await open({ [NEURO_MAP_SWITCH_KEY]: cached });
    expect(exposedNames(first.container).includes('Neuro Map')).toBe(cached);
    await first.unmount();
    api.snapshot.mockResolvedValue({ ...snapshot, neuroMapEnabled: current });
    screen = await render(h(OrganizationIntelligenceScreen));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(api.configuration).toHaveBeenCalledTimes(1);
    expect(exposedNames(screen.container).includes('Neuro Map')).toBe(current);
  });

  it('keeps the tab on in the offline preview', async () => {
    setPlatform(os);
    const view = await open({ [NEURO_MAP_SWITCH_KEY]: false }, 'preview');
    expect(api.configuration).not.toHaveBeenCalled();
    expect(exposedNames(view.container)).toContain('Neuro Map');
  });
});

// BUG-UG-HELD-FEATURE-TRACES-PACKET-LIMIT-AND-MAP-SUBTITLE-20261113
// (#8598): held for its release day, the switch map and the snapshot both say
// off. Signed in, neither the tab nor the subtitle names the Neuro Map until a
// read says it is on, so nothing shows it while the reads are in flight.
const FULL = 'Agency and organization charts, relationship strength, topic readiness, and sourced leadership history.';
const WITHOUT_NEURO_MAP = 'Agency and organization charts and sourced leadership history.';

describe.each(['ios', 'android'] as const)('the Power map while the Neuro Map is held, on %s', (os) => {
  async function openWhile(configuration: Promise<unknown>, snapshotRead: Promise<unknown>) {
    setPlatform(os);
    app.mode = 'authenticated';
    app.token = `token-${tokens += 1}`;
    api.configuration.mockReturnValue(configuration);
    api.snapshot.mockReturnValue(snapshotRead);
    screen = await render(h(OrganizationIntelligenceScreen));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    return screen;
  }
  const never = () => new Promise(() => {});

  it('draws no Neuro Map tab and does not name it before either read lands', async () => {
    const view = await openWhile(never(), never());
    expect(exposedNames(view.container)).not.toContain('Neuro Map');
    expect(view.container.textContent).toContain(WITHOUT_NEURO_MAP);
    expect(view.container.textContent).not.toMatch(/relationship|topic readiness/i);
  });

  it('does not name it once the switch map reports it held, while the snapshot is in flight', async () => {
    const view = await openWhile(Promise.resolve({ data: { switches: { [NEURO_MAP_SWITCH_KEY]: false } }, error: null }), never());
    expect(exposedNames(view.container)).not.toContain('Neuro Map');
    expect(view.container.textContent).not.toMatch(/relationship|topic readiness/i);
  });

  it('does not name it after the switch map read fails', async () => {
    const view = await openWhile(Promise.resolve({ data: null, error: { message: 'offline' } }), never());
    expect(exposedNames(view.container)).not.toContain('Neuro Map');
    expect(view.container.textContent).toContain(WITHOUT_NEURO_MAP);
  });

  it('does not name it when the snapshot says off', async () => {
    const view = await openWhile(Promise.resolve({ data: { switches: { [NEURO_MAP_SWITCH_KEY]: false } }, error: null }), Promise.resolve({ ...snapshot, neuroMapEnabled: false }));
    expect(exposedNames(view.container)).not.toContain('Neuro Map');
    expect(view.container.textContent).toContain(WITHOUT_NEURO_MAP);
    expect(view.container.textContent).not.toContain(FULL);
  });

  it('reads exactly as before once released', async () => {
    const view = await openWhile(Promise.resolve({ data: { switches: { [NEURO_MAP_SWITCH_KEY]: true } }, error: null }), Promise.resolve({ ...snapshot, neuroMapEnabled: true }));
    expect(exposedNames(view.container)).toEqual(expect.arrayContaining(['Charts', 'Neuro Map', 'Timeline']));
    expect(view.container.textContent).toContain(FULL);
  });

  it('names it as soon as the switch map says on, before the snapshot lands', async () => {
    const view = await openWhile(Promise.resolve({ data: { switches: { [NEURO_MAP_SWITCH_KEY]: true } }, error: null }), never());
    expect(exposedNames(view.container)).toContain('Neuro Map');
    expect(view.container.textContent).toContain(FULL);
  });
});
