import { beforeEach, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => backend, processLock: vi.fn() }));
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, supabaseUrl: 'http://localhost', supabasePublishableKey: 'test' } }));
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));
import { loadConversationThread } from './supabase';

type Row = Record<string, unknown>;
let rows: Record<string, Row[]>;
beforeEach(() => {
  rows = {
    member_conversations: [{ id: 'conversation', user_id: 'member', title: 'Conversation', created_at: '2026-09-01', updated_at: '2026-09-29' }],
    member_messages: Array.from({ length: 205 }, (_, index) => ({ id: `message-${index}`, user_id: 'member', conversation_id: 'conversation', sender_kind: 'member', sender_name: 'Worker', body: `Body ${index}`, created_at: new Date(1800000000000 + index * 1000).toISOString() })),
    member_message_reactions: [],
  };
  backend.rpc.mockReset().mockResolvedValue({ data: { available: true, state: 'active' }, error: null });
  backend.from.mockReset().mockImplementation((table: string) => {
    const filters: [string, unknown][] = []; let limit = Infinity; let single = false;
    const q = {
      select: () => q, eq: (key: string, value: unknown) => { filters.push([key, value]); return q; },
      order: () => q, in: () => q, limit: (value: number) => { limit = value; return q; },
      maybeSingle: () => { single = true; return q; },
      then: (resolve: (value: unknown) => unknown) => {
        const selected = (rows[table] ?? []).filter((row) => filters.every(([key, value]) => row[key] === value)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
        return Promise.resolve({ data: single ? selected[0] ?? null : selected, error: null }).then(resolve);
      },
    }; return q;
  });
});
it('hydrates the exact old message outside the newest 200-message window', async () => {
  const result = await loadConversationThread('member', 'conversation', { messageID: 'message-0' });
  expect(result?.messages).toHaveLength(201);
  expect(result?.messages[0]?.id).toBe('message-0');
  expect(backend.rpc).toHaveBeenCalledWith('get_connected_workflow_context', { p_kind: 'private_message', p_id: 'message-0' });
});
it('does not use a staff-readable conversation in a worker reader', async () => {
  expect(await loadConversationThread('other-member', 'conversation', { messageID: 'message-0' })).toBeNull();
  const staff = await loadConversationThread('steward', 'conversation', { messageID: 'message-0', staff: true });
  expect(staff?.readerIsStaff).toBe(true);
});
it('rechecks source access on reopening and never shows a mismatched or removed source', async () => {
  expect(await loadConversationThread('member', 'conversation', { messageID: 'missing' })).toBeNull();
  rows.member_messages![0]!.redacted_at = '2026-09-29';
  expect(await loadConversationThread('member', 'conversation', { messageID: 'message-0' })).toBeNull();
  backend.rpc.mockResolvedValue({ data: { available: false }, error: null });
  backend.from.mockClear();
  expect(await loadConversationThread('member', 'conversation', { messageID: 'message-1' })).toBeNull();
  expect(backend.from).not.toHaveBeenCalled();
});
