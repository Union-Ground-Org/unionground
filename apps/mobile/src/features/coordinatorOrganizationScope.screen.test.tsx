// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppStateStatus } from 'react-native';
import { press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import palette from '../theme/palette.json';

// BUG-UG-NATIVE-COORDINATOR-ROLE-SHOWS-NO-CASE-QUEUE-20261118:
// a person who holds Grievance Coordinator (and President) organization-wide
// and Steward only for their chapter's unit chose "Working as Grievance
// Coordinator". The Work tab listed only Organization analytics and
// Organization map, and the Case queue route refused, because the coordinator
// desk asked for a chapter-scoped coordinator grant. The server reads the
// chapter's cases and step deadlines for an organization-wide coordinator, so
// the phone now opens the desk at either scope. This runs the real role
// narrowing, Work list and route gate, then the Case queue screen over a
// stand-in database.
const port = vi.hoisted(() => ({ app: {} as Record<string, unknown>, push: vi.fn(), stateListeners: new Set<(state: AppStateStatus) => void>() }));
// The stand-in database: each table filters, orders and pages its rows.
const db = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const tables: Record<string, Row[]> = { member_cases: [], casework_deadlines: [] };
  const from = (name: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    const orders: [string, boolean][] = [];
    const answer = (first: number, last: number) => {
      const rows = (tables[name] ?? []).filter((row) => filters.every((keep) => keep(row)));
      rows.sort((a, b) => {
        for (const [column, ascending] of orders) {
          const x = String(a[column] ?? '');
          const y = String(b[column] ?? '');
          if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
        }
        return 0;
      });
      return { data: rows.slice(first, last + 1), error: null };
    };
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return query; },
      in: (column: string, values: unknown[]) => { filters.push((row) => values.includes(row[column])); return query; },
      order: (column: string, options: { ascending: boolean }) => { orders.push([column, options.ascending]); return query; },
      limit: async (count: number) => answer(0, count - 1),
      range: async (first: number, last: number) => answer(first, last),
    };
    return query;
  };
  return { tables, backend: { from, rpc: async () => ({ data: [], error: null }) } };
});

// The survey card, the unit editors ( pull request D), the campaign draft and Be heard (pull request C) import the shared draft hook, whose attempt keys come from expo-crypto.
vi.mock('expo-crypto', () => ({ randomUUID: () => 'attempt-key' }));
vi.mock('react-native', async () => ({
  ...await import('../testing/reactNativeStandIn'),
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: AppStateStatus) => void) => {
      port.stateListeners.add(listener);
      return { remove: () => { port.stateListeners.delete(listener); } };
    },
  },
}));
vi.mock('../components/ui', async () => {
  const ui = await import('../testing/uiStandIn');
  return { ...ui, StateMessage: ({ title, body, action }: { title: string; body?: string; action?: ReactNode }) => h('section', null, title, body, action) };
});
vi.mock('expo-router', () => ({ useRouter: () => ({ push: port.push }) }));
// The client is the stand-in; readStepDeadlinePages is services/supabase.ts's
// own paging (1,000 rows a page, at most 20 pages, a failed page answers no
// rows), copied because that module's imports reach native code.
vi.mock('../services/supabase', () => ({
  getSupabaseClient: () => db.backend,
  readStepDeadlinePages: async (fetchPage: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>) => {
    const rows: unknown[] = [];
    try {
      for (let page = 0; page < 20; page += 1) {
        const { data, error } = await fetchPage(page * 1000, page * 1000 + 999);
        if (error || !Array.isArray(data)) return [];
        rows.push(...data);
        if (data.length < 1000) return rows;
      }
      return [];
    } catch {
      return [];
    }
  },
}));
vi.mock('../state/AppProvider', () => ({ useApp: () => port.app }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn() } }));
vi.mock('../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => vi.fn() }));
// Modules the screen file imports for its other screens, which reach native code.
vi.mock('../services/attachments', () => ({ pickAuthorizedDocument: vi.fn() }));
vi.mock('../services/privateFileAccess', () => ({ PrivateFileError: class extends Error {}, requestPrivateFileInspection: vi.fn(), downloadPrivateObjectToFile: vi.fn(), privateFileApiOrigin: () => 'https://sample.unionground.example' }));
vi.mock('../components/SignaturePad', () => ({ SignaturePad: () => null }));

import { canOpenFeature } from '../lib/featureCatalog';
import { featureGroupsForRoles, narrowLiveStaffRoles, selectableLiveStaffRoles, workItemsForRoles, type LiveStaffRoles } from '../lib/hatFunctions';
import { LiveCaseQueueScreen } from './LiveFeatureScreens';

// The persona's grants as the server confirms them: Coordinator and President
// organization-wide, Steward for the chapter.
const persona: LiveStaffRoles = { organizationRoles: ['coordinator', 'vp'], chapterRoles: ['steward'], authorizedRoles: ['steward', 'coordinator', 'vp'] };

let screen: Rendered | null = null;
beforeEach(() => {
  port.app = { memberLanguage: 'en', session: { user: { id: 'coordinator-a' } }, dashboard: { member: { id: 'coordinator-a', chapterID: 'chapter-a', language: 'en' } } };
  db.tables.member_cases = [
    ...Array.from({ length: 9 }, (_, index) => ({ id: `case-${index + 1}`, reference: `GR-H-${index + 1}`, case_type: 'Discipline', step: 'Step 1', status: 'active', updated_at: `2026-11-1${index % 7}T15:00:00.000Z`, chapter_id: 'chapter-a' })),
    { id: 'other-chapter', reference: 'GR-X-1', case_type: 'Pay', step: 'Step 1', status: 'active', updated_at: '2026-11-17T15:00:00.000Z', chapter_id: 'chapter-b' },
  ];
  db.tables.casework_deadlines = [
    { id: 'deadline-1', case_id: 'case-4', label: 'Step 1 answer due', due_at: '2026-11-24T17:00:00.000Z', status: 'active' },
  ];
});
afterEach(async () => {
  await screen?.unmount(); screen = null; setPlatform('ios');
  vi.useRealTimers(); vi.restoreAllMocks(); port.stateListeners.clear();
});

async function settle() {
  for (let round = 0; round < 6; round += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('an organization-wide Campaign lead on the phone (#9098)', () => {
  const working = narrowLiveStaffRoles(persona, 'coordinator');

  it('works as Campaign lead with the campaign lead grant held only organization-wide', () => {
    expect(selectableLiveStaffRoles(persona)).toContain('coordinator');
    expect(working).toEqual({ organizationRoles: ['coordinator'], chapterRoles: [], authorizedRoles: ['coordinator'] });
  });

  it('lists Issue queue, Active issues and Follow-up dates on Work and opens the desk', () => {
    const work = workItemsForRoles(working.chapterRoles, working.organizationRoles).map((item) => item.label);
    for (const label of ['Issue queue', 'Active issues', 'Follow-up dates']) expect(work).toContain(label);
    // The rows with no view on the Case queue stay chapter-scoped.
    for (const label of ['Escalation funnel', 'By article cited']) expect(work).not.toContain(label);
    const desks = featureGroupsForRoles(working.chapterRoles, working.organizationRoles).find((group) => group.key === 'staff');
    expect(desks?.items.map((item) => item.label)).toContain('Issue queue');
    expect(canOpenFeature('authenticated', 'coordinator', null, working.chapterRoles, working.organizationRoles)).toBe(true);
    // Only the desk widens: the chapter tools still need a chapter grant, and
    // the Steward desk still needs its chapter.
    for (const key of ['tasks', 'events-desk', 'campaigns']) {
      expect(canOpenFeature('authenticated', key as 'tasks', null, working.chapterRoles, working.organizationRoles)).toBe(false);
    }
    expect(canOpenFeature('authenticated', 'steward', null, [], ['steward'])).toBe(false);
    // A chapter-scoped coordinator keeps the desk.
    expect(canOpenFeature('authenticated', 'coordinator', null, ['coordinator'], [])).toBe(true);
  });

  it.each<'ios' | 'android'>(['ios', 'android'])('shows the campaign\'s active issues and deadlines in the Issue queue on %s', async (os) => {
    setPlatform(os);
    screen = await render(h(LiveCaseQueueScreen));
    await settle();
    const text = screen.container.textContent ?? '';
    expect(text).toContain('Active issues in this campaign (9)');
    for (let index = 1; index <= 9; index += 1) expect(text).toContain(`GR-H-${index}`);
    expect(text).toContain('Step 1 answer due');
    expect(text).not.toContain('GR-X-1');
  });

  describe.each<'ios' | 'android'>(['ios', 'android'])('deadline urgency on %s', (os) => {
    async function openCrossingClock(language: 'en' | 'es') {
      setPlatform(os);
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      vi.setSystemTime(new Date('2026-11-19T17:00:00.000Z'));
      port.app = { ...port.app, memberLanguage: language };
      db.tables.casework_deadlines = [
        { id: 'crossing', case_id: 'case-4', label: 'Crossing clock', due_at: '2026-11-19T17:00:01.000Z', status: 'active' },
        { id: 'future', case_id: 'case-4', label: 'Future clock', due_at: '2026-11-20T17:00:00.000Z', status: 'active' },
      ];
      screen = await render(h(LiveCaseQueueScreen));
      await settle();
      return (label = 'Crossing clock') => Array.from(screen!.container.querySelectorAll('[role="button"]')).find((row) => row.textContent?.includes(label))!;
    }

    it.each<'en' | 'es'>(['en', 'es'])('updates the visible and spoken state while mounted in %s, without rereading data, and cleans up', async (language) => {
      const reads = vi.spyOn(db.backend, 'from');
      const rpc = vi.spyOn(db.backend, 'rpc');
      const row = await openCrossingClock(language);
      const overdue = language === 'es' ? 'Vencido' : 'Overdue';
      const counts = { reads: reads.mock.calls.length, rpc: rpc.mock.calls.length };
      expect(row().textContent).not.toContain(overdue);
      expect(row().getAttribute('aria-label')).not.toContain(overdue);
      await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
      expect(row().textContent).toContain(overdue);
      expect(row().getAttribute('aria-label')).toContain(overdue);
      expect(row('Future clock').textContent).not.toContain(overdue);
      expect({ reads: reads.mock.calls.length, rpc: rpc.mock.calls.length }).toEqual(counts);
      await screen!.unmount(); screen = null;
      expect(vi.getTimerCount()).toBe(0);
      expect(port.stateListeners.size).toBe(0);
    });

    it.each<'en' | 'es'>(['en', 'es'])('refreshes the visible and spoken state immediately on foreground in %s without running suspended timers or rereading data', async (language) => {
      const reads = vi.spyOn(db.backend, 'from');
      const rpc = vi.spyOn(db.backend, 'rpc');
      const row = await openCrossingClock(language);
      const overdue = language === 'es' ? 'Vencido' : 'Overdue';
      const counts = { reads: reads.mock.calls.length, rpc: rpc.mock.calls.length };
      await act(async () => { for (const listener of port.stateListeners) listener('background'); });
      vi.setSystemTime(new Date('2026-11-19T17:05:00.000Z'));
      expect(row().textContent).not.toContain(overdue);
      await act(async () => { for (const listener of port.stateListeners) listener('active'); });
      expect(row().textContent).toContain(overdue);
      expect(row().getAttribute('aria-label')).toContain(overdue);
      expect(row('Future clock').textContent).not.toContain(overdue);
      expect({ reads: reads.mock.calls.length, rpc: rpc.mock.calls.length }).toEqual(counts);
    });

    it.each<'en' | 'es'>(['en', 'es'])('marks past instants and missed clocks in %s, keeping future clocks unmarked and rows usable', async (language) => {
      setPlatform(os);
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-19T17:00:00.000Z'));
      port.app = { ...port.app, memberLanguage: language };
      const fixtures = [
        { label: 'October answer', due_at: '2026-10-27T21:00:00Z', status: 'active', overdue: true },
        { label: 'Earlier today', due_at: '2026-11-19T16:59:59.999Z', status: 'active', overdue: true },
        { label: 'Due now', due_at: '2026-11-19T17:00:00.000Z', status: 'active', overdue: false },
        { label: 'Later today', due_at: '2026-11-19T17:00:00.001Z', status: 'extended', overdue: false },
        { label: 'Missed clock', due_at: '2026-11-20T17:00:00Z', status: 'missed', overdue: true },
        { label: 'Offset clock', due_at: '2026-11-19T13:00:00-05:00', status: 'active', overdue: false },
        { label: 'Met answer', due_at: '2026-10-27T21:00:00Z', status: 'met', overdue: false },
        { label: 'Waived answer', due_at: '2026-10-27T21:00:00Z', status: 'waived', overdue: false },
      ];
      db.tables.casework_deadlines = fixtures.map((item, index) => ({ ...item, id: `deadline-${index}`, case_id: 'case-4' }));
      screen = await render(h(LiveCaseQueueScreen));
      await settle();
      const overdue = language === 'es' ? 'Vencido' : 'Overdue';
      for (const item of fixtures.slice(0, 6)) {
        const row = Array.from(screen.container.querySelectorAll('[role="button"]')).find((element) => element.textContent?.includes(item.label));
        expect(row, item.label).toBeDefined();
        expect(row!.textContent?.includes(overdue), item.label).toBe(item.overdue);
        expect(row!.getAttribute('aria-label')?.includes(overdue), item.label).toBe(item.overdue);
        expect(row!.textContent).toContain(language === 'es' ? 'Vence el ' : 'Due ');
      }
      expect(screen.container.textContent).not.toContain('Met answer');
      expect(screen.container.textContent).not.toContain('Waived answer');
      const first = Array.from(screen.container.querySelectorAll('[role="button"]')).find((element) => element.textContent?.includes('October answer'))!;
      port.push.mockClear();
      await press(first as HTMLElement);
      expect(port.push).toHaveBeenCalledWith('/issue/case-4');
    });
  });
});
