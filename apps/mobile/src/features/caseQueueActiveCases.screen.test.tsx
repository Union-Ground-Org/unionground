// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import palette from '../theme/palette.json';

// BUG-UG-NATIVE-FORMS-STALE-SHEETS-AND-CASE-LIMITS-20261117 (#9033),
// ledger 173 (gate stage 118 on #8668): the coordinator's Case queue took its
// active cases, and the cases whose open deadlines it lists, from the newest
// 100 cases of every status. A chapter with more than 100 recently closed
// cases then showed no active case and an empty deadline queue. The screen
// runs over a stand-in database that filters, orders and pages as PostgREST
// does, so the read itself is what is tested.
const port = vi.hoisted(() => ({ app: {} as Record<string, unknown>, push: vi.fn() }));
// The stand-in database: each table filters, orders and pages its rows.
const db = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const tables: Record<string, Row[]> = { member_cases: [], casework_deadlines: [] };
  // failActive: the every-active-case read answers an error (ledger 474).
  const mode = { failActive: false };
  const from = (name: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    const orders: [string, boolean][] = [];
    let activeOnly = false;
    const answer = (first: number, last: number) => {
      if (activeOnly && mode.failActive) return { data: null, error: { message: 'canceling statement due to statement timeout' } };
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
      eq: (column: string, value: unknown) => { if (column === 'status' && value === 'active') activeOnly = true; filters.push((row) => row[column] === value); return query; },
      // The keyset filter loadChapterActiveCases sends after its first page (ledger 473).
      or: (filter: string) => {
        const match = /^updated_at\.lt\.(".*?"),and\(updated_at\.eq\.(".*?"),id\.gt\.(".*?")\)$/.exec(filter);
        if (!match) throw new Error(`unexpected filter ${filter}`);
        const at = JSON.parse(match[1]!) as string;
        const id = JSON.parse(match[3]!) as string;
        filters.push((row) => String(row.updated_at) < at || (row.updated_at === at && String(row.id) > id));
        return query;
      },
      in: (column: string, values: unknown[]) => { filters.push((row) => values.includes(row[column])); return query; },
      order: (column: string, options: { ascending: boolean }) => { orders.push([column, options.ascending]); return query; },
      limit: async (count: number) => answer(0, count - 1),
      range: async (first: number, last: number) => answer(first, last),
    };
    return query;
  };
  return { tables, mode, backend: { from, rpc: async () => ({ data: [], error: null }) } };
});

// The survey card, the unit editors (#9240 pull request D), the campaign draft and Be heard (pull request C) import the shared draft hook, whose attempt keys come from expo-crypto.
vi.mock('expo-crypto', () => ({ randomUUID: () => 'attempt-key' }));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
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
vi.mock('../lib/hatFunctions', () => ({ STAFF_HAT_FUNCTIONS: { steward: [] } }));
// Modules the screen file imports for its other screens, which reach native code.
vi.mock('../services/attachments', () => ({ pickAuthorizedDocument: vi.fn() }));
vi.mock('../services/privateFileAccess', () => ({ PrivateFileError: class extends Error {}, requestPrivateFileInspection: vi.fn(), downloadPrivateObjectToFile: vi.fn(), privateFileApiOrigin: () => 'https://sample.unionground.example' }));
vi.mock('../components/SignaturePad', () => ({ SignaturePad: () => null }));
vi.mock('../services/unitSettings', () => ({ loadNativeUnitSettings: vi.fn(), loadNativeUnitEditor: vi.fn(), saveNativeUnitWorkload: vi.fn(), saveNativeUnitOverrides: vi.fn(), saveNativeChapterUnitSettings: vi.fn() }));

import { LiveCaseQueueScreen } from './LiveFeatureScreens';

const day = (offset: number) => new Date(Date.UTC(2026, 10, 15) - offset * 86_400_000).toISOString();

let screen: Rendered | null = null;
beforeEach(() => {
  db.mode.failActive = false;
  port.app = { memberLanguage: 'en', session: { user: { id: 'coordinator-a' } }, dashboard: { member: { id: 'coordinator-a', chapterID: 'chapter-a', language: 'en' } } };
  // 150 cases closed this month, every one newer than the three active cases
  // opened in 2024, which still carry open step deadlines.
  db.tables.member_cases = [
    ...Array.from({ length: 150 }, (_, index) => ({ id: `closed-${String(index).padStart(3, '0')}`, reference: `GR-C-${index}`, case_type: 'Pay', step: 'Closed', status: 'closed', updated_at: day(index % 14), chapter_id: 'chapter-a' })),
    ...[1, 2, 3].map((index) => ({ id: `active-${index}`, reference: `GR-A-${index}`, case_type: 'Discipline', step: 'Step 2', status: 'active', updated_at: `2024-0${index}-10T15:00:00.000Z`, chapter_id: 'chapter-a' })),
    { id: 'other-chapter', reference: 'GR-X-1', case_type: 'Pay', step: 'Step 1', status: 'active', updated_at: day(0), chapter_id: 'chapter-b' },
  ];
  db.tables.casework_deadlines = [
    ...[1, 2, 3].map((index) => ({ id: `deadline-${index}`, case_id: `active-${index}`, label: `Step 2 answer ${index}`, due_at: `2026-12-0${index}T17:00:00.000Z`, status: 'active' })),
    { id: 'deadline-closed', case_id: 'closed-000', label: 'Closed issue step', due_at: '2026-12-04T17:00:00.000Z', status: 'met' },
  ];
});
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); });

async function settle() {
  for (let round = 0; round < 6; round += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe.each<'ios' | 'android'>(['ios', 'android'])('the Issue queue on %s (ledger 173)', (os) => {
  it('counts and lists every active issue and its open deadlines when more than 100 newer issues are closed', async () => {
    setPlatform(os);
    screen = await render(h(LiveCaseQueueScreen));
    await settle();
    const text = screen.container.textContent ?? '';
    expect(text).toContain('Active issues in this campaign (3)');
    for (const index of [1, 2, 3]) {
      expect(text).toContain(`GR-A-${index}`);
      expect(text).toContain(`Step 2 answer ${index}`);
    }
    expect(text).not.toContain('No open step deadlines on active issues.');
    expect(text).not.toContain('GR-X-1');
    expect(text).not.toContain('Closed issue step');
  });
});

describe.each<'ios' | 'android'>(['ios', 'android'])('the Issue queue when its active-case read fails or stops at its cap on %s (ledger 474, 472)', (os) => {
  // Ledger 474: the newest cases loaded, then the every-active-case read
  // failed. The queue keeps the loaded list; only the active section says so.
  it('keeps the loaded newest issues and shows the error on the active section only', async () => {
    setPlatform(os);
    // An active case among the newest 100, beside the 150 closed ones.
    db.tables.member_cases!.push({ id: 'active-new', reference: 'GR-A-NEW', case_type: 'Pay', step: 'Step 1', status: 'active', updated_at: day(0), chapter_id: 'chapter-a' });
    db.mode.failActive = true;
    screen = await render(h(LiveCaseQueueScreen));
    await settle();
    const text = screen.container.textContent ?? '';
    expect(text).toContain('Older active issues didn’t load.');
    expect(text).toContain('GR-A-NEW');
    expect(text).toContain('Other issues');
    expect(text).toContain('GR-C-0');
    expect(text).toContain('The deadlines didn’t load with the active issues.');
    expect(text).not.toContain('Loading');
    expect(text).not.toContain('The campaign’s issues didn’t load.');
    // A failed read gives no count: the heading names the section only.
    expect(text).toContain('Active issues in this campaign');
    expect(text).not.toMatch(/Active cases in this chapter \(\d/u);
    // Try again reads both again; with the read back, the full queue shows.
    db.mode.failActive = false;
    await press(getExposed(screen.container, 'Try again'));
    await settle();
    const after = screen.container.textContent ?? '';
    expect(after).toContain('Active issues in this campaign (4)');
    expect(after).not.toContain('Older active issues didn’t load.');
  });

  // Ledger 472: the read stops after 20 pages of 500; the queue says the list
  // is not every active case instead of showing a bare count.
  it('says only the first 10,000 active issues are listed when the read stops at its cap', async () => {
    setPlatform(os);
    db.tables.member_cases = Array.from({ length: 10_001 }, (_, index) => ({ id: `bulk-${String(index).padStart(5, '0')}`, reference: `GR-B-${index}`, case_type: 'Pay', step: 'Step 1', status: 'active', updated_at: day(index % 400), chapter_id: 'chapter-a' }));
    db.tables.casework_deadlines = [];
    screen = await render(h(LiveCaseQueueScreen));
    await settle();
    const text = screen.container.textContent ?? '';
    // #9533 (Sol on c356143c): a capped read shows no number in the heading;
    // the notice says how many are shown.
    expect(text).toContain('Active issues in this campaign');
    expect(text).not.toContain('Active issues in this campaign (10000)');
    expect(text).toContain('Showing the first 10,000 active issues. The campaign may have more that are not listed here.');
  }, 60_000);

  // Sol on 57ec5c15: at exactly 10,000 the last page is full too, so the read
  // cannot tell whether more exist; the line says the chapter may have more.
  it('says the campaign may have more, not that it does, at exactly 10,000 active issues', async () => {
    setPlatform(os);
    db.tables.member_cases = Array.from({ length: 10_000 }, (_, index) => ({ id: `bulk-${String(index).padStart(5, '0')}`, reference: `GR-B-${index}`, case_type: 'Pay', step: 'Step 1', status: 'active', updated_at: day(index % 400), chapter_id: 'chapter-a' }));
    db.tables.casework_deadlines = [];
    screen = await render(h(LiveCaseQueueScreen));
    await settle();
    const text = screen.container.textContent ?? '';
    // #9533 (Sol on c356143c): a capped read shows no number in the heading;
    // the notice says how many are shown.
    expect(text).toContain('Active issues in this campaign');
    expect(text).not.toContain('Active issues in this campaign (10000)');
    expect(text).toContain('Showing the first 10,000 active issues. The campaign may have more that are not listed here.');
    expect(text).not.toContain('The campaign has more');
  }, 60_000);

  it('says nothing about a cap when every active issue fits', async () => {
    setPlatform(os);
    screen = await render(h(LiveCaseQueueScreen));
    await settle();
    expect(screen.container.textContent ?? '').not.toContain('Showing the first');
  });
});

// BUG-UG-COUNTS-AND-STATUSES-DISAGREE-BETWEEN-PAGES-20261122 (#9533),
// iOS demo walk of Nov 24, 2026: Coordinator Home said "246 Open cases"
// (get_coordinator_kpis: the open chapter's active cases plus cases granted
// from other chapters) while this list said "Active cases (244)" (the open
// chapter's member_cases only). The list now says it is the chapter's, and
// that cases shared from other chapters are not listed in it.
describe('the Issue queue says what its count covers (#9533)', () => {
  it.each([
    ['en', 'Active issues in this campaign (3)', 'Issues from other campaigns that are shared with you are not listed here.'],
    ['es', 'Asuntos activos de esta campaña (3)', 'Los asuntos de otras campañas compartidos contigo no aparecen aquí.'],
  ])('in %s', async (language, heading, note) => {
    port.app = { ...port.app, memberLanguage: language };
    screen = await render(h(LiveCaseQueueScreen));
    await settle();
    const text = screen.container.textContent ?? '';
    expect(text).toContain(heading);
    expect(text).toContain(note);
    expect(text).not.toContain('GR-X-1');
    expect(text).not.toMatch(/Home counts|Inicio cuenta/u);
  });
});

describe('deadline time zones in the Issue queue', () => {
  it.each([
    ['en', 'Due Jul 1, 2027, 8:15 PM CDT', 'Due Jul 1, 2027, 9:15 PM EDT'],
    ['es', 'Vence el 1 jul 2027, 8:15 p. m. CDT', 'Vence el 1 jul 2027, 9:15 p. m. EDT'],
  ])('shows the recorded deadline clock and the default when absent in %s', async (language, recorded, fallback) => {
    vi.stubEnv('TZ', 'Pacific/Honolulu');
    try {
      expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Pacific/Honolulu');
      port.app = { ...port.app, memberLanguage: language };
      db.tables.casework_deadlines = [
        { id: 'recorded', case_id: 'active-1', label: 'Recorded clock', due_at: '2027-07-02T01:15:00Z', status: 'active', time_zone: 'America/Chicago' },
        { id: 'default', case_id: 'active-2', label: 'Default clock', due_at: '2027-07-02T01:15:00Z', status: 'active' },
      ];
      screen = await render(h(LiveCaseQueueScreen));
      await settle();
      const recordedRow = getExposed(screen.container, /^GR-A-1, Recorded clock,/u);
      const fallbackRow = getExposed(screen.container, /^GR-A-2, Default clock,/u);
      expect(recordedRow.textContent).toContain(recorded);
      expect(recordedRow.getAttribute('aria-label')).toContain(recorded);
      expect(fallbackRow.textContent).toContain(fallback);
      expect(fallbackRow.getAttribute('aria-label')).toContain(fallback);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
