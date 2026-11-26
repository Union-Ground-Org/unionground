// @vitest-environment jsdom
import { createElement as h, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from '../../testing/reactNativeStandIn';

// BUG-UG-COUNTS-AND-STATUSES-DISAGREE-BETWEEN-PAGES-20261122 (#9533),
// iOS demo walk of Nov 24, 2026: the Steward's Organization analytics >
// Statistics read "Open cases 0" when no group of cases had reached the
// privacy floor. The tab now shows no number and the website's reason.
const port = vi.hoisted(() => ({ app: { memberLanguage: 'en' } as Record<string, unknown> }));
vi.mock('react-native', () => import('../../testing/reactNativeStandIn'));
vi.mock('../../components/ui', async () => {
  const ui = await import('../../testing/uiStandIn');
  return { ...ui, StateMessage: ({ title, body, action }: { title: string; body?: string; action?: ReactNode }) => h('section', null, title, body, action) };
});
vi.mock('../../state/AppProvider', () => ({ useApp: () => port.app }));
vi.mock('../../services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn() } }));
vi.mock('../../components/QuarterlySurveyGate', () => ({ QuarterlySurveyGate: ({ children }: { children: ReactNode }) => children }));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => ({}) }));
// Mobile CI installs only apps/mobile. Use the shared implementation without
// requiring the web re-export's package link in root node_modules (as
// analyticsNative.test.ts does).
vi.mock('../../../../../src/lib/featureSwitches.js', () => import('../../../../../src/lib/shared-core/featureSwitches.js'));

import { AnalyticsTab } from './AnalyticsCoreScreen';

const desk = (overview: Record<string, unknown>) => ({ stats: { overview: { chapterCount: 6, ...overview } } });
let screen: Rendered | null = null;
afterEach(async () => { await screen?.unmount(); screen = null; port.app = { memberLanguage: 'en' }; });

describe('Organization analytics > Statistics (#9533)', () => {
  it.each([
    ['en', "No issue figures to show yet. Issue groups can appear only when they meet the organization's privacy minimum (at least 25 people)."],
    ['es', 'Todavía no hay cifras de asuntos para mostrar. Los grupos de asuntos solo pueden mostrarse si alcanzan el mínimo de privacidad de la organización (al menos 25 personas).'],
  ])('shows no issue number and the reason when no group reached the floor (%s)', async (language, reason) => {
    port.app = { memberLanguage: language };
    screen = await render(h(AnalyticsTab, { desk: desk({ caseGroups: 0, openCases: 0, resolvedCases: 0, resolutionRate: null }), tab: 'stats' }));
    const text = screen.container.textContent ?? '';
    expect(text).toContain(reason);
    expect(text).not.toMatch(/Open cases0/u);
    expect(text).toContain('Open issues—');
  });

  it('shows the numbers when issue groups are published', async () => {
    screen = await render(h(AnalyticsTab, { desk: desk({ caseGroups: 4, openCases: 31, resolvedCases: 9, resolutionRate: 23 }), tab: 'stats' }));
    const text = screen.container.textContent ?? '';
    expect(text).toContain('Open issues31');
    expect(text).toContain('Resolution rate23%');
    expect(text).not.toContain('No issue figures to show yet');
  });

  it.each([
    ['en', 'In 3 of 6 campaigns', 'Hidden while a campaign has fewer than 25 workers'],
    ['es', 'En 3 de 6 campañas', 'Oculto mientras una campaña tenga menos de 25 trabajadores'],
  ])('shows published campaign totals with their scope and no hidden-figure reason (%s)', async (language, scope, hidden) => {
    port.app = { memberLanguage: language };
    const overview = { caseGroups: 3, openCases: null, resolvedCases: null, resolutionRate: null, casesSuppressed: true, publishedChapterTotals: { chapters: 3, of: 6, openCases: 40, resolvedCases: 10, resolutionRate: 20 } };
    screen = await render(h(AnalyticsTab, { desk: desk(overview), tab: 'stats' }));
    const text = screen.container.textContent ?? '';
    expect(text).toContain('Open issues40');
    expect(text).toContain('Resolution rate20%');
    expect(text).toContain(scope);
    expect(text).not.toContain(hidden);
  });

  it('says why when the organization total is hidden and no campaign totals are published', async () => {
    screen = await render(h(AnalyticsTab, { desk: desk({ caseGroups: 3, openCases: null, resolvedCases: null, resolutionRate: null, casesSuppressed: true }), tab: 'stats' }));
    const text = screen.container.textContent ?? '';
    expect(text).toContain('Hidden while a campaign has fewer than 25 workers. Campaigns shows the rest.');
    expect(text).toContain('Open issues—');
    expect(text).not.toMatch(/In \d+ of \d+ chapters/u);
  });
});
