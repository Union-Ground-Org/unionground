import { beforeEach, describe, expect, it, vi } from 'vitest';

// BUG-UG-NATIVE-SEVEN-FEATURE-KEYS-OPEN-ONLY-THE-GENERIC-SCREEN-20261113
// (#8630): Casework and the Case queue read the chapter's cases through this
// service. These are the guarantees the generic evidence read carried for the
// two desks (moved from services/supabase.test.ts), plus the queue's deadlines.
const backend = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('./supabase', async (original) => ({ ...await original<object>(), getSupabaseClient: () => backend }));
vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => backend, processLock: vi.fn() }));
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'publishable-test-key' } }));
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));

import { CHAPTER_ACTIVE_CASE_PAGE, CHAPTER_CASE_LIMIT, CHAPTER_DEADLINE_CASE_CHUNK, loadChapterActiveCases, loadChapterCaseDeadlines, loadChapterCases } from './chapterCaseQueue';

type Call = [string, ...unknown[]];

function recordingQuery(calls: Call[], answer: { data: unknown; error: unknown }) {
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'order']) {
    query[method] = (...args: unknown[]) => { calls.push([method, ...args]); return query; };
  }
  query.limit = async (...args: unknown[]) => { calls.push(['limit', ...args]); return answer; };
  query.range = async (...args: unknown[]) => { calls.push(['range', ...args]); return answer; };
  return query;
}

beforeEach(() => {
  backend.from.mockReset();
  backend.rpc.mockReset();
  backend.rpc.mockResolvedValue({ data: [], error: null });
});

describe('campaign issue work read', () => {
  it('reads only member_cases in the selected campaign, bounded, naming rows by type and step', async () => {
    const calls: Call[] = [];
    backend.from.mockImplementation((table: string) => {
      calls.push(['from', table]);
      return recordingQuery(calls, { data: [{ id: 'case-1', reference: 'C-1', case_type: 'Pay', step: 'Step 1', status: 'active', updated_at: '2026-09-20T00:00:00Z' }], error: null });
    });
    const rows = await loadChapterCases('chapter-509');
    expect(calls).toContainEqual(['from', 'member_cases']);
    expect(calls).toContainEqual(['eq', 'chapter_id', 'chapter-509']);
    // #7015: the row names the case by type and step; the topic is never read.
    expect(calls).toContainEqual(['select', 'id,reference,case_type,step,status,updated_at']);
    expect(calls).toContainEqual(['limit', CHAPTER_CASE_LIMIT]);
    expect(rows).toEqual([{ id: 'case-1', reference: 'C-1', title: 'Pay · Step 1', status: 'active', meta: 'Updated Sep 19, 2026 · 8:00 PM ET' }]);
  });

  it('names a row by its topic only where the server says a switch shows it (#7043)', async () => {
    backend.from.mockImplementation(() => recordingQuery([], { data: [{ id: 'case-1', reference: 'C-1', case_type: 'Pay', step: 'Step 1', status: 'active', updated_at: null }, { id: 'case-2', reference: 'C-2', case_type: 'Pay', step: '', status: 'active', updated_at: null }], error: null }));
    backend.rpc.mockResolvedValueOnce({ data: [{ id: 'case-1', title: 'Overtime withheld', topicShown: true }], error: null });
    const rows = await loadChapterCases('chapter-509');
    expect(backend.rpc).toHaveBeenLastCalledWith('list_case_row_titles', { p_case_ids: ['case-1', 'case-2'] });
    expect(rows.map((row) => row.title)).toEqual(['Overtime withheld', 'Pay']);
    expect(rows[0]?.meta).toBe('Update time unavailable');
  });

  it('changes the read when the campaign changes instead of refetching the same list', async () => {
    const calls: Call[] = [];
    backend.from.mockImplementation(() => recordingQuery(calls, { data: [], error: null }));
    await loadChapterCases('chapter-a');
    await loadChapterCases('chapter-b');
    expect(calls.filter(([method]) => method === 'eq')).toEqual([['eq', 'chapter_id', 'chapter-a'], ['eq', 'chapter_id', 'chapter-b']]);
  });

  it('refuses to read issue work without a selected campaign rather than listing every readable issue', async () => {
    await expect(loadChapterCases(null)).rejects.toThrow('Select a campaign');
    await expect(loadChapterCases(undefined)).rejects.toThrow('Select a campaign');
    expect(backend.from).not.toHaveBeenCalled();
  });
});

describe('issue queue deadlines', () => {
  it('reads the open step deadlines on the given issues, in due order', async () => {
    const calls: Call[] = [];
    backend.from.mockImplementation((table: string) => {
      calls.push(['from', table]);
      return recordingQuery(calls, { data: [{ case_id: 'case-1', id: 'd-1', label: 'Step 2 answer due', due_at: '2026-11-20T17:00:00Z', status: 'open', time_zone: 'America/Chicago' }, { case_id: 'case-1', id: '', label: 'broken', due_at: null, status: 'open' }], error: null });
    });
    const rows = await loadChapterCaseDeadlines(['case-1', 'case-1']);
    expect(calls).toContainEqual(['from', 'casework_deadlines']);
    expect(calls).toContainEqual(['select', 'case_id,id,label,due_at,status,time_zone']);
    expect(calls).toContainEqual(['in', 'case_id', ['case-1']]);
    expect(calls).toContainEqual(['order', 'due_at', { ascending: true }]);
    expect(rows).toEqual([{ id: 'd-1', caseID: 'case-1', label: 'Step 2 answer due', dueAt: '2026-11-20T17:00:00Z', status: 'open', timeZone: 'America/Chicago' }]);
  });

  it('keeps "did not load" apart from "none open", and reads nothing for no issues', async () => {
    backend.from.mockImplementation(() => recordingQuery([], { data: null, error: { message: 'timeout' } }));
    expect(await loadChapterCaseDeadlines(['case-1'])).toBeNull();
    backend.from.mockImplementation(() => { throw new Error('offline'); });
    expect(await loadChapterCaseDeadlines(['case-1'])).toBeNull();
    backend.from.mockReset();
    expect(await loadChapterCaseDeadlines([])).toEqual([]);
    expect(backend.from).not.toHaveBeenCalled();
  });
});

// Ledger 173: the queue reads every active case, page by page, and asks for
// their deadlines a chunk of case ids at a time, in one due order.
// The page-cap case maps nearly 20,000 rows across two reads.
describe('issue queue active issues (ledger 173)', { timeout: 30_000 }, () => {
  it('reads only the campaign\'s active issues, every page, whatever their age', async () => {
    const calls: Call[] = [];
    const page = (count: number, start: number) => Array.from({ length: count }, (_, index) => ({ id: `case-${start + index}`, reference: `R-${start + index}`, case_type: 'Pay', step: 'Step 1', status: 'active', updated_at: '2026-01-01T00:00:00Z' }));
    const answers = [page(CHAPTER_ACTIVE_CASE_PAGE, 0), page(3, CHAPTER_ACTIVE_CASE_PAGE)];
    backend.from.mockImplementation(() => {
      const query = recordingQuery(calls, { data: answers.shift() ?? [], error: null });
      query.or = (...args: unknown[]) => { calls.push(['or', ...args]); return query; };
      return query;
    });
    const { rows, capped } = await loadChapterActiveCases('chapter-509');
    expect(rows).toHaveLength(CHAPTER_ACTIVE_CASE_PAGE + 3);
    expect(capped).toBe(false);
    expect(calls.filter(([method]) => method === 'eq')).toEqual([
      ['eq', 'chapter_id', 'chapter-509'], ['eq', 'status', 'active'], ['eq', 'chapter_id', 'chapter-509'], ['eq', 'status', 'active'],
    ]);
    expect(calls.filter(([method]) => method === 'limit')).toEqual([['limit', CHAPTER_ACTIVE_CASE_PAGE], ['limit', CHAPTER_ACTIVE_CASE_PAGE]]);
    expect(calls.filter(([method]) => method === 'or')).toHaveLength(1);
    // Titles are asked for at most 200 cases a call.
    const titleRequests: string[][] = backend.rpc.mock.calls.map((call) => (call[1] as { p_case_ids: string[] }).p_case_ids);
    expect(titleRequests.every((ids) => ids.length <= 200)).toBe(true);
    expect(titleRequests.flat()).toHaveLength(CHAPTER_ACTIVE_CASE_PAGE + 3);
    await expect(loadChapterActiveCases(null)).rejects.toThrow('Select a campaign');
  });

  // Ledger 473: offset pages over updated_at repeat or skip a case that changes
  // between pages. Each page after the first starts after the previous page's
  // last row on (updated_at desc, id asc), and a case already listed is listed once.
  it('pages on the (updated_at, id) keyset and lists an issue that moves between pages once', async () => {
    const calls: Call[] = [];
    const row = (index: number, updatedAt: string) => ({ id: `case-${index}`, reference: `R-${index}`, case_type: 'Pay', step: 'Step 1', status: 'active', updated_at: updatedAt });
    const first = Array.from({ length: CHAPTER_ACTIVE_CASE_PAGE }, (_, index) => row(index, `2026-11-20T17:00:00.${String(999999 - index).padStart(6, '0')}+00:00`));
    const last = first[CHAPTER_ACTIVE_CASE_PAGE - 1]!;
    // Page 2's answer repeats case-7 from page 1 (it changed between the reads).
    const answers = [first, [row(7, '2026-11-19T09:00:00+00:00'), row(900, '2026-11-19T08:00:00+00:00')]];
    backend.from.mockImplementation(() => {
      const query = recordingQuery(calls, { data: null, error: null });
      query.or = (...args: unknown[]) => { calls.push(['or', ...args]); return query; };
      query.limit = async (...args: unknown[]) => { calls.push(['limit', ...args]); return { data: answers.shift() ?? [], error: null }; };
      return query;
    });
    const { rows } = await loadChapterActiveCases('chapter-509');
    expect(rows.map((item) => item.id).filter((id) => id === 'case-7')).toEqual(['case-7']);
    expect(rows).toHaveLength(CHAPTER_ACTIVE_CASE_PAGE + 1);
    expect(new Set(rows.map((item) => item.id)).size).toBe(rows.length);
    expect(calls.filter(([method]) => method === 'range')).toEqual([]);
    expect(calls.filter(([method]) => method === 'limit')).toEqual([['limit', CHAPTER_ACTIVE_CASE_PAGE], ['limit', CHAPTER_ACTIVE_CASE_PAGE]]);
    const stamp = JSON.stringify(last.updated_at);
    expect(calls.filter(([method]) => method === 'or')).toEqual([['or', `updated_at.lt.${stamp},and(updated_at.eq.${stamp},id.gt.${JSON.stringify(last.id)})`]]);
  });

  // Ledger 472: the read stops after 20 full pages; it says so, so the queue
  // can tell the steward the list is not every active case.
  it('says when it stopped at its last page with that page full, and not when the last page is short', async () => {
    const row = (index: number) => ({ id: `case-${String(index).padStart(5, '0')}`, reference: `R-${index}`, case_type: 'Pay', step: 'Step 1', status: 'active', updated_at: `2026-01-01T00:00:00.${String(99999 - index).padStart(5, '0')}Z` });
    const serve = (pages: number, lastLength: number) => {
      let served = 0;
      backend.from.mockImplementation(() => {
        const query = recordingQuery([], { data: null, error: null });
        query.or = () => query;
        query.limit = async () => {
          const length = served === pages - 1 ? lastLength : CHAPTER_ACTIVE_CASE_PAGE;
          const data = served < pages ? Array.from({ length }, (_, index) => row(served * CHAPTER_ACTIVE_CASE_PAGE + index)) : [];
          served += 1;
          return { data, error: null };
        };
        return query;
      });
    };
    serve(20, CHAPTER_ACTIVE_CASE_PAGE);
    const full = await loadChapterActiveCases('chapter-509');
    expect(full.rows).toHaveLength(20 * CHAPTER_ACTIVE_CASE_PAGE);
    expect(full.capped).toBe(true);
    serve(20, CHAPTER_ACTIVE_CASE_PAGE - 1);
    const short = await loadChapterActiveCases('chapter-509');
    expect(short.rows).toHaveLength(20 * CHAPTER_ACTIVE_CASE_PAGE - 1);
    expect(short.capped).toBe(false);
  });

  it('asks for the deadlines of many issues a chunk at a time and keeps one due order', async () => {
    const calls: Call[] = [];
    const ids = Array.from({ length: 250 }, (_, index) => `case-${String(index).padStart(3, '0')}`);
    backend.from.mockImplementation(() => {
      const query = recordingQuery(calls, { data: [], error: null });
      const chunk: string[] = [];
      query.in = (...args: unknown[]) => { calls.push(['in', ...args]); if (args[0] === 'case_id') chunk.push(...(args[1] as string[])); return query; };
      query.range = async () => ({ data: chunk.length ? [{ case_id: chunk[0], id: `d-${chunk[0]}`, label: 'Due', due_at: `2026-12-${String(30 - chunk.length / 10).padStart(2, '0')}T17:00:00Z`, status: 'active' }] : [], error: null });
      return query;
    });
    const rows = await loadChapterCaseDeadlines(ids);
    const chunks = calls.filter(([method, column]) => method === 'in' && column === 'case_id').map(([, , value]) => (value as string[]).length);
    expect(chunks).toEqual([CHAPTER_DEADLINE_CASE_CHUNK, CHAPTER_DEADLINE_CASE_CHUNK, 50]);
    expect(rows?.map((row) => row.caseID)).toEqual(['case-000', 'case-100', 'case-200']);
    expect(rows?.map((row) => row.dueAt)).toEqual(['2026-12-20T17:00:00Z', '2026-12-20T17:00:00Z', '2026-12-25T17:00:00Z']);
  });
});
