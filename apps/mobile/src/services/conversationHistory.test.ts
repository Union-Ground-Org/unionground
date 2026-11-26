import { stubSessionWriter } from '../testing/stubSessionWriter';
import { getSupabaseClient as protocolTestClient } from './supabase';
const testWriter = stubSessionWriter(protocolTestClient);
import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => backend, processLock: vi.fn() }));
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, supabaseUrl: 'http://localhost', supabasePublishableKey: 'test' } }));
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));

import { loadConversationThread, loadEarlierConversationMessages, sendStewardReply, THREAD_MESSAGE_PAGE } from './supabase';
import { mergeConversationHistory } from '../features/useConversationHistory';
import type { MemberMessage } from '../models/member';

// BUG-UG-NATIVE-DIRECT-THREAD-HIDES-OLDER-MESSAGES-20261109: 201
// fictional Tamarack exchanges in one conversation, the first 101 sharing one
// timestamp, behind a stub that applies the owner filter, the cursor filter,
// the (created_at, id) order and the page limit the way the server does.
type Row = { id: string; user_id: string; conversation_id: string; sender_kind: string; sender_name: string; body: string; read_at: null; created_at: string; redacted_at: string | null; redaction_reason: string | null; edited_at: null; parent_message_id: null };
const SAME = '2026-11-02T14:00:00.000Z';
let messages: Row[];
let failHistory = false;
const queries: { table: string; filters: string[]; limit: number | null }[] = [];

function message(number: number, overrides: Partial<Row> = {}): Row {
  const label = String(number).padStart(3, '0');
  const minute = Math.max(0, number - 101);
  return {
    id: `00000000-0000-4000-8000-000000000${label}`,
    user_id: 'marcus',
    conversation_id: 'marcus-thread',
    sender_kind: number % 2 ? 'member' : 'steward',
    sender_name: number % 2 ? 'Marcus Greene' : 'Dylan Committee',
    body: `Exchange ${label}`,
    read_at: null,
    created_at: number <= 101 ? SAME : new Date(Date.parse(SAME) + minute * 60_000).toISOString(),
    redacted_at: null,
    redaction_reason: null,
    edited_at: null,
    parent_message_id: null,
    ...overrides,
  };
}

function before(row: Row, cursor: { at: string; id: string }) {
  return row.created_at < cursor.at || (row.created_at === cursor.at && row.id < cursor.id);
}

beforeEach(() => {
  messages = Array.from({ length: 201 }, (_, index) => message(index + 1));
  messages[4] = message(5, { body: '', redacted_at: '2026-11-03T00:00:00.000Z', redaction_reason: 'staff_removed' });
  failHistory = false;
  queries.length = 0;
  backend.rpc.mockReset().mockResolvedValue({ data: { ok: true }, error: null });
  backend.from.mockReset().mockImplementation((table: string) => {
    const filters: string[] = [];
    const eq: [string, unknown][] = [];
    let cursor: { at: string; id: string } | null = null;
    let limit: number | null = null;
    let single = false;
    const record = { table, filters, limit: null as number | null };
    queries.push(record);
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => { eq.push([column, value]); filters.push(`${column}=${String(value)}`); return builder; },
      or: (expression: string) => {
        filters.push(`or:${expression}`);
        const match = /^created_at\.lt\.("[^"]+"),and\(created_at\.eq\.("[^"]+"),id\.lt\.("[^"]+")\)$/.exec(expression);
        if (!match) throw new Error(`unexpected cursor filter ${expression}`);
        cursor = { at: JSON.parse(match[1]!) as string, id: JSON.parse(match[3]!) as string };
        return builder;
      },
      order: () => builder,
      in: () => builder,
      limit: (value: number) => { limit = value; record.limit = value; return builder; },
      maybeSingle: () => { single = true; return builder; },
      then: (resolve: (value: unknown) => unknown) => {
        const matches = (row: Record<string, unknown>) => eq.every(([column, value]) => row[column] === value);
        if (table === 'member_conversations') {
          const rows = [{ id: 'marcus-thread', user_id: 'marcus', steward_user_id: 'dylan', title: 'Schedule', initials: 'SC', created_at: SAME, updated_at: SAME }].filter(matches);
          return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve);
        }
        if (table === 'member_messages') {
          if (failHistory && cursor) return Promise.resolve({ data: null, error: { message: 'server detail' } }).then(resolve);
          const ordered = messages.filter(matches).filter((row) => !cursor || before(row, cursor))
            .sort((a, b) => (a.created_at === b.created_at ? b.id.localeCompare(a.id) : b.created_at.localeCompare(a.created_at)));
          return Promise.resolve({ data: ordered.slice(0, limit ?? ordered.length), error: null }).then(resolve);
        }
        return Promise.resolve({ data: [], error: null }).then(resolve);
      },
    };
    return builder;
  });
});

async function readEverything(reader: string, staff: boolean): Promise<MemberMessage[]> {
  const thread = await loadConversationThread(reader, 'marcus-thread', { staff });
  expect(thread).not.toBeNull();
  let shown = thread!.messages;
  let cursor = thread!.earlierCursor ?? null;
  let pages = 0;
  while (cursor) {
    const page = await loadEarlierConversationMessages(reader, 'marcus-thread', cursor, { staff });
    shown = mergeConversationHistory(page.messages, shown);
    cursor = page.earlierCursor;
    pages += 1;
    expect(pages).toBeLessThan(5);
  }
  return shown;
}

describe('native private conversation history', () => {
  it('reads the newest bounded page with a stable cursor at its oldest row', async () => {
    const thread = await loadConversationThread('marcus', 'marcus-thread');
    expect(thread!.messages).toHaveLength(THREAD_MESSAGE_PAGE);
    expect(thread!.messages[0]!.body).toBe('Exchange 002');
    expect(thread!.messages.at(-1)!.body).toBe('Exchange 201');
    expect(thread!.earlierCursor).toEqual({ createdAt: SAME, id: message(2).id });
  });

  it('reaches the earliest exchange for the worker, in order, with no gap or duplicate', async () => {
    const shown = await readEverything('marcus', false);
    expect(shown.map((row) => row.body)).toEqual(messages.map((row) => (row.redacted_at ? '' : row.body)));
    expect(shown[0]!.body).toBe('Exchange 001');
    expect(shown[4]).toMatchObject({ body: '', redactedAt: '2026-11-03T00:00:00.000Z', redactionReason: 'staff_removed' });
    const history = queries.filter((query) => query.table === 'member_messages');
    expect(history).toHaveLength(2);
    expect(history.every((query) => query.filters.includes('user_id=marcus') && query.limit === 200)).toBe(true);
  });

  it('reaches the earliest exchange for a committee member and still replies through the committee member route', async () => {
    const shown = await readEverything('dylan', true);
    expect(shown).toHaveLength(201);
    expect(shown[0]!.body).toBe('Exchange 001');
    expect(queries.filter((query) => query.table === 'member_messages').every((query) => !query.filters.includes('user_id=dylan'))).toBe(true);
    await sendStewardReply(testWriter, 'marcus-thread', 'Following up.');
    expect(backend.rpc).toHaveBeenLastCalledWith('send_steward_reply', { p_conversation_id: 'marcus-thread', p_body: 'Following up.' });
  });

  it('keeps the worker owner filter on earlier pages, so another reader gets nothing', async () => {
    const page = await loadEarlierConversationMessages('pat', 'marcus-thread', { createdAt: SAME, id: message(2).id });
    expect(page).toEqual({ messages: [], earlierCursor: null });
  });

  it('fails an earlier page without server text, and the same cursor works on retry', async () => {
    const thread = await loadConversationThread('marcus', 'marcus-thread');
    failHistory = true;
    await expect(loadEarlierConversationMessages('marcus', 'marcus-thread', thread!.earlierCursor!)).rejects.toThrow('Earlier messages did not load. Try again.');
    failHistory = false;
    const page = await loadEarlierConversationMessages('marcus', 'marcus-thread', thread!.earlierCursor!);
    expect(page.messages.map((row) => row.body)).toEqual(['Exchange 001']);
    expect(page.earlierCursor).toBeNull();
  });

  it('keeps opened history when an incoming message slides the newest page forward', async () => {
    const first = await loadConversationThread('marcus', 'marcus-thread');
    const earlier = await loadEarlierConversationMessages('marcus', 'marcus-thread', first!.earlierCursor!);
    const opened = mergeConversationHistory(earlier.messages, first!.messages);
    messages.push(message(202));
    const refreshed = await loadConversationThread('marcus', 'marcus-thread');
    expect(refreshed!.messages[0]!.body).toBe('Exchange 003');
    const shown = mergeConversationHistory(opened, refreshed!.messages);
    expect(shown).toHaveLength(202);
    expect(shown.map((row) => row.body).slice(0, 3)).toEqual(['Exchange 001', 'Exchange 002', 'Exchange 003']);
    expect(shown.at(-1)!.body).toBe('Exchange 202');
  });

  it('gives a short conversation no earlier cursor, which is the start of the conversation', async () => {
    messages = messages.slice(0, 12);
    const thread = await loadConversationThread('marcus', 'marcus-thread');
    expect(thread!.messages).toHaveLength(12);
    expect(thread!.earlierCursor).toBeNull();
  });
});
