import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { previewDashboardFor } from '../data/preview';
import { MEMBER_WORK_WIDGETS, STAFF_HAT_FUNCTIONS, widgetSourceFor, type LiveStaffRole } from '../lib/hatFunctions';
import { staffDeskNumbers } from '../lib/staffDeskNumbers';
import { nativeCatalogLabel } from '../lib/nativeUiCopy';

vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({}) }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn() } }));
vi.mock('./FunctionDeck', () => ({ functionIcons: {} }));
vi.mock('./NumberFlow', () => ({ NumberFlow: ({ value }: { value: string }) => createElement('span', null, value) }));
vi.mock('./RowHighlight', () => ({ HighlightList: ({ children }: { children: ReactNode }) => children, HighlightRow: ({ children }: { children: ReactNode }) => children }));
vi.mock('./ui', () => ({ Body: ({ children }: { children: ReactNode }) => createElement('p', null, children), Avatar: () => null }));

const { WorkWidgets, rowsFor } = await import('./WorkWidgets');
const dashboard = { ...previewDashboardFor('member'), cases: [], weeklyActions: [] };
const roles: LiveStaffRole[] = ['steward', 'coordinator', 'advisor', 'admin', 'vp'];
const replies: Record<LiveStaffRole, unknown> = {
  organizer: null,
  steward: [{ open_requests: 12, awaiting_reply: 4 }],
  coordinator: { openCases: 163, dueThisWeek: 2, inArbitration: 2 },
  advisor: { openGrievances: 18, membersCovered: 255 },
  admin: [{ roles: ['admin'] }, { roles: ['steward', 'advisor'] }],
  vp: { activeGrievances: 9, memberCount: 1001 },
};
const report = MEMBER_WORK_WIDGETS.find(item => item.key === 'numbers')!;
const allItems = [...MEMBER_WORK_WIDGETS, ...Object.values(STAFF_HAT_FUNCTIONS).flat()];
const unbacked = [...new Map(allItems
  .filter(item => !['cases', 'messages', 'numbers'].includes(widgetSourceFor(item.key)))
  .map(item => [widgetSourceFor(item.key), item])).values()];

describe('K2 Work summaries use the authorized Home desk source', () => {
  it.each(roles.flatMap(role => (['en', 'es'] as const).map(language => ({ role, language }))))('shows $role desk figures once with My reports still reachable ($language)', ({ role, language }) => {
    const numbers = staffDeskNumbers(role, { data: replies[role], error: null });
    const desk = STAFF_HAT_FUNCTIONS[role].find(item => item.key === role)!;
    const html = renderToStaticMarkup(createElement(WorkWidgets, {
      dashboard, desk: null, items: [desk, report], staffRole: role, staffNumbers: numbers, language,
    }));
    for (const number of numbers) {
      const label = `${number.value}. ${nativeCatalogLabel(language, number.label)}`;
      expect(html.split(`aria-label="${label}"`).length - 1).toBe(1);
    }
    expect(html).toContain(`aria-label="${report.label}"`);
    expect(rowsFor(report, null, dashboard, [], { role, numbers })).toMatchObject({ rows: [], hideBody: true });
  });

  it.each(roles)('%s desk shows the Home reader values instead of worker counts', role => {
    const numbers = staffDeskNumbers(role, { data: replies[role], error: null });
    const context = { role, numbers };
    const desk = STAFF_HAT_FUNCTIONS[role].find(item => item.key === role)!;
    const expected = numbers.map(number => [String(number.value), number.label]);
    const model = rowsFor(desk, null, dashboard, [], context);
    expect(model.rows.map(row => [row.primary, row.secondary])).toEqual(expected);
    expect(model.hideBody).not.toBe(true);
    if (role === 'coordinator') expect(rowsFor(desk, null, dashboard, [], context).rows[0]?.primary).toBe('163');
  });

  it.each(['en', 'es'] as const)('renders the campaign lead count and accessible label in %s', language => {
    const numbers = staffDeskNumbers('coordinator', { data: replies.coordinator, error: null });
    const desk = STAFF_HAT_FUNCTIONS.coordinator.find(item => item.key === 'coordinator')!;
    const html = renderToStaticMarkup(createElement(WorkWidgets, {
      dashboard, desk: null, items: [desk, report], staffRole: 'coordinator', staffNumbers: numbers, language,
    }));
    expect(html).toContain(language === 'es' ? 'aria-label="163. Asuntos abiertos"' : 'aria-label="163. Open issues"');
    expect(html).not.toContain('Finished this week');
    expect(html).not.toContain('Nothing in');
  });

  it.each(roles)('translates every %s summary label into Spanish', role => {
    const numbers = staffDeskNumbers(role, { data: replies[role], error: null });
    const desk = STAFF_HAT_FUNCTIONS[role].find(item => item.key === role)!;
    const labels = rowsFor(desk, null, dashboard, [], { role, numbers }, 'es').rows.map(row => row.secondary);
    expect(labels).toEqual(numbers.map(number => nativeCatalogLabel('es', number.label)));
    for (const number of numbers) expect(labels).not.toContain(number.label);
  });

  it.each(['loading', 'failed', 'unchosen'] as const)('%s staff data cannot fall back to worker report values', state => {
    const context = { role: state === 'unchosen' ? null : 'coordinator' as const, numbers: [] };
    const model = rowsFor(report, null, dashboard, [], context);
    expect(model.rows).toEqual([]);
    expect(model.hideBody).toBe(true);
  });

  it('keeps a genuine zero from a successful staff read', () => {
    const numbers = staffDeskNumbers('coordinator', { data: { openCases: 0, dueThisWeek: 0, inArbitration: 0 }, error: null });
    const desk = STAFF_HAT_FUNCTIONS.coordinator.find(item => item.key === 'coordinator')!;
    expect(rowsFor(desk, null, dashboard, [], { role: 'coordinator', numbers }).rows.map(row => row.primary)).toEqual(['0', '0', '0']);
  });

  it.each(unbacked.map(item => [widgetSourceFor(item.key), item] as const))('%s has no body when its collection is not read', (_source, item) => {
    const html = renderToStaticMarkup(createElement(WorkWidgets, { dashboard, desk: null, items: [item] }));
    expect(html).not.toContain('file-tray-outline');
    expect(html).not.toContain('<p>');
    expect(html).not.toContain('Nothing in');
  });

  it.each(allItems.filter(item => ['cases', 'messages'].includes(widgetSourceFor(item.key)) && !MEMBER_WORK_WIDGETS.includes(item) && item.key !== 'steward-messages'))('%s never claims an unread staff collection is empty', item => {
    const html = renderToStaticMarkup(createElement(WorkWidgets, { dashboard, desk: null, items: [item] }));
    expect(html).not.toContain('file-tray-outline');
    expect(html).not.toContain('Nothing in');
  });
});
