import { stubSessionWriter } from '../testing/stubSessionWriter';
import { getSupabaseClient as protocolTestClient } from './supabase';
const testWriter = stubSessionWriter(protocolTestClient);
import { beforeEach, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => backend, processLock: vi.fn() }));
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, supabaseUrl: 'http://localhost', supabasePublishableKey: 'test' } }));
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));
import { loadConversationThread, reactToConversationMessage } from './supabase';
import { MESSAGE_REACTION_KINDS } from '../lib/messagingShared';
let deniedRead = false;
beforeEach(() => {
  deniedRead = false;
  backend.rpc.mockReset().mockResolvedValue({ data: { reacted: true }, error: null });
  backend.from.mockReset().mockImplementation((table: string) => {
    const data = table === 'member_conversations' ? { id: 'c1', title: 'Conversation', updated_at: '2026-09-01' }
      : table === 'member_messages' ? [{ id: 'm1', conversation_id: 'c1', sender_kind: 'member', body: 'Hello', created_at: '2026-09-01' }]
      : [{ private_message_id: 'm1', actor_id: 'me', reaction: 'like' }, { private_message_id: 'm1', actor_id: 'peer', reaction: 'like' }];
    const result = { data, error: deniedRead ? { code: '42501' } : null };
    const q: Record<string, unknown> = {};
    for (const key of ['select', 'eq', 'in', 'order', 'limit', 'maybeSingle']) q[key] = vi.fn(() => q);
    q.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return q;
  });
});
it('loads and aggregates private reactions through the conversation consumer', async () => {
  const thread = await loadConversationThread('me', 'c1');
  expect(thread?.messages[0]?.reactions?.find(row => row.kind === 'like')).toMatchObject({ count: 2, mine: true });
});
it('sends all five private-source kinds then reloads the authorized aggregate', async () => {
  for (const kind of MESSAGE_REACTION_KINDS) {
    const result = await reactToConversationMessage(testWriter, 'me', 'c1', 'm1', kind);
    expect(result.failed).toBe(false);
    expect(result.thread?.messages[0]?.reactions?.find(row => row.kind === 'like')?.count).toBe(2);
    expect(backend.rpc).toHaveBeenLastCalledWith('toggle_member_message_reaction', { p_source_kind: 'private', p_message_id: 'm1', p_reaction: kind });
  }
});
it('reconciles denial and clears inaccessible conversation data', async () => {
  backend.rpc.mockResolvedValue({ error: { code: '42501' } });
  expect((await reactToConversationMessage(testWriter, 'me', 'c1', 'm1', 'like')).thread).not.toBeNull();
  deniedRead = true;
  expect(await reactToConversationMessage(testWriter, 'me', 'c1', 'm1', 'like')).toEqual({ failed: true, thread: null });
});

it('conversation loader keeps only delivered rows and never loads scheduled copies', async () => {
  const thread = await loadConversationThread('me', 'c1');
  expect(thread).not.toHaveProperty('scheduled');
  expect(thread?.conversation).not.toHaveProperty('scheduled');
  expect(backend.from.mock.calls.map(([table]) => table)).toEqual([
    'member_conversations', 'member_messages', 'member_message_reactions',
  ]);
});
