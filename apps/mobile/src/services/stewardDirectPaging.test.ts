import { stubSessionWriter } from '../testing/stubSessionWriter';
import { getSupabaseClient as protocolTestClient } from './supabase';
const testWriter = stubSessionWriter(protocolTestClient);
import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => backend, processLock: vi.fn() }));
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, supabaseUrl: 'http://localhost', supabasePublishableKey: 'test' } }));
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));

import { loadConversationSummaries, loadStewardDirectPage, sendStewardReply } from './supabase';
import { mergeStewardDirectRows, projectStewardDirectPage, pruneStewardDirectRows, setNativeDirectAudience, STEWARD_DIRECT_PAGE } from './stewardDirectInbox';

// BUG-UG-NATIVE-STEWARD-DIRECT-INBOX-STOPS-AT-100-20261109: 101
// fictional Tamarack conversations, every one updated at the same instant, so
// the id is the only tie-break. The stub serves the server's order and cursor.
type Row = { id: string; member_name: string; member_initials: string; updated_at: string; last_body: string; last_sender_kind: string };
const UPDATED = '2026-11-09T15:00:00.000Z';
const catalog: Row[] = Array.from({ length: 101 }, (_, index) => {
  const number = String(index + 1).padStart(3, '0');
  return {
    id: `00000000-0000-4000-8000-000000000${number}`,
    member_name: `Tamarack Worker ${number}`,
    member_initials: 'TM',
    updated_at: UPDATED,
    last_body: `Question ${number}`,
    last_sender_kind: 'member',
  };
});

type Args = { p_filter: string; p_search: string | null; p_after_updated: string | null; p_after_id: string | null; p_limit: number };
let failAfterFirstPage = false;
const calls: Args[] = [];

function serve(args: Args) {
  const ordered = [...catalog].sort((a, b) => (a.updated_at === b.updated_at ? b.id.localeCompare(a.id) : b.updated_at.localeCompare(a.updated_at)));
  const needle = args.p_search?.toLowerCase() ?? null;
  const matching = needle ? ordered.filter((row) => row.member_name.toLowerCase().includes(needle)) : ordered;
  const after = args.p_after_id && args.p_after_updated
    ? matching.filter((row) => row.updated_at < args.p_after_updated! || (row.updated_at === args.p_after_updated && row.id < args.p_after_id!))
    : matching;
  const limit = Math.min(Math.max(args.p_limit, 1), 100);
  return after.slice(0, limit).map((row) => ({ ...row, total_count: matching.length }));
}

beforeEach(() => {
  setNativeDirectAudience('steward');
  failAfterFirstPage = false;
  calls.length = 0;
  backend.rpc.mockReset().mockImplementation((name: string, args: Args) => {
    if (name === 'list_steward_conversations') {
      calls.push(args);
      if (failAfterFirstPage && args.p_after_id) return Promise.resolve({ data: null, error: { code: 'XX000', message: 'server detail' } });
      return Promise.resolve({ data: serve(args), error: null });
    }
    if (name === 'send_steward_reply') return Promise.resolve({ data: { ok: true }, error: null });
    return Promise.resolve({ data: null, error: null });
  });
});

describe('Committee Direct paging', () => {
  it('reaches conversation 101 through the server cursor with no duplicate or missing row', async () => {
    const first = await loadStewardDirectPage();
    expect(first.rows).toHaveLength(STEWARD_DIRECT_PAGE);
    expect(first.total).toBe(101);
    expect(first.next).toEqual({ updatedAt: UPDATED, id: first.rows[99]!.id });
    const second = await loadStewardDirectPage({ after: first.next });
    expect(calls[1]).toMatchObject({ p_filter: 'all', p_search: null, p_after_updated: UPDATED, p_after_id: first.rows[99]!.id, p_limit: 100 });
    expect(second.rows.map((row) => row.title)).toEqual(['Tamarack Worker 001']);
    expect(second.next).toBeNull();
    const all = mergeStewardDirectRows(first.rows, second.rows);
    expect(all).toHaveLength(101);
    expect(new Set(all.map((row) => row.id)).size).toBe(101);
    expect(all[0]!.title).toBe('Tamarack Worker 101');
    expect(all[100]!.title).toBe('Tamarack Worker 001');
  });

  it('asks the server to search, so the final conversation is found without paging', async () => {
    const page = await loadStewardDirectPage({ search: '  worker 001 ' });
    expect(calls[0]).toMatchObject({ p_search: 'worker 001', p_after_id: null, p_after_updated: null });
    expect(page.rows.map((row) => row.id)).toEqual([catalog[0]!.id]);
    expect(page.next).toBeNull();
    await sendStewardReply(testWriter, page.rows[0]!.id, 'I can meet Thursday.');
    expect(backend.rpc).toHaveBeenLastCalledWith('send_steward_reply', { p_conversation_id: catalog[0]!.id, p_body: 'I can meet Thursday.' });
  });

  it('fails a later page without a server message and leaves the first page to the caller', async () => {
    const first = await loadStewardDirectPage();
    failAfterFirstPage = true;
    await expect(loadStewardDirectPage({ after: first.next })).rejects.toThrow('Worker conversations did not load. Try again.');
    failAfterFirstPage = false;
    const retried = await loadStewardDirectPage({ after: first.next });
    expect(retried.rows).toHaveLength(1);
  });

  it('keeps the summary refresh to one bounded first page', async () => {
    const rows = await loadConversationSummaries('steward-1');
    expect(rows).toHaveLength(100);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ p_after_id: null, p_limit: 100 });
  });

  it('treats a short page as the end and a full page as possibly more', () => {
    expect(projectStewardDirectPage(serve({ p_filter: 'all', p_search: null, p_after_updated: null, p_after_id: null, p_limit: 100 }), 100).next).not.toBeNull();
    expect(projectStewardDirectPage(catalog.slice(0, 3), 100).next).toBeNull();
    expect(projectStewardDirectPage(null, 100)).toEqual({ rows: [], next: null, total: null });
  });

  it('turns a removed committee member role on a later page into an end, not the previous rows', async () => {
    backend.rpc.mockImplementation(() => Promise.resolve({ data: null, error: { code: '42501', message: 'committee member role required' } }));
    await expect(loadStewardDirectPage({ after: { updatedAt: UPDATED, id: catalog[1]!.id } })).resolves.toEqual({ rows: [], next: null, total: 0, refused: true });
  });

  it('prunes cached rows a first page no longer lists, keeping older ones', () => {
    const at = (id: string, updatedAt: string) => ({ id, updatedAt });
    const cached = [at('c', '2026-11-09T15:03:00.000Z'), at('b', '2026-11-09T15:02:00.000Z'), at('a', '2026-11-09T15:01:00.000Z')];
    // Short first page: the whole list; only listed rows stay.
    expect(pruneStewardDirectRows(cached, [at('c', '2026-11-09T15:03:00.000Z')], 3).map((row) => row.id)).toEqual(['c']);
    // Full first page ending at b: c above it and missing is dropped, a below it stays.
    expect(pruneStewardDirectRows(cached, [at('d', '2026-11-09T15:04:00.000Z'), at('e', '2026-11-09T15:03:30.000Z'), at('b', '2026-11-09T15:02:00.000Z')], 3).map((row) => row.id)).toEqual(['b', 'a']);
    // Nothing to drop returns the same array.
    expect(pruneStewardDirectRows(cached, cached, 3)).toBe(cached);
  });
});
