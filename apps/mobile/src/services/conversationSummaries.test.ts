import { beforeEach, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => backend, processLock: vi.fn() }));
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, supabaseUrl: 'http://localhost', supabasePublishableKey: 'test' } }));
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));
import { loadConversationSummaries } from './supabase';
import { findNativeStewardConversation } from '../lib/messageWorkflow';

const conversations = [
  { id: 'named', user_id: 'member', steward_user_id: 'steward-a', title: 'Named committee member', initials: 'NS', created_at: '2026-10-01', updated_at: '2026-10-09' },
  { id: 'general', user_id: 'member', steward_user_id: null, title: 'General committee member', initials: 'GS', created_at: '2026-10-01', updated_at: '2026-10-08' },
  { id: 'other-member', user_id: 'someone-else', steward_user_id: null, title: 'Other worker', initials: 'OM', created_at: '2026-10-01', updated_at: '2026-10-09' },
];
beforeEach(() => {
  backend.from.mockReset().mockImplementation((table: string) => {
    let columns: string[] = [];
    let userID: string | undefined;
    const builder = {
      select: (value: string) => { columns = value.split(','); return builder; },
      eq: (column: string, value: string) => { if (column === 'user_id') userID = value; return builder; },
      order: () => builder,
      limit: () => builder,
      in: () => builder,
      then: (resolve: (result: { data: unknown[]; error: null }) => unknown) => {
        // Apply the requested projection: an omitted binding really disappears.
        const data = table === 'member_conversations'
          ? conversations.filter((row) => row.user_id === userID).map((row) => Object.fromEntries(
            columns.map((column) => [column, row[column as keyof typeof row]]),
          ))
          : [{ conversation_id: 'named', unread_count: 2, latest_message: 'Hello' }];
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return builder;
  });
});
it('preserves named and general committee member routing after the foreground poll replaces the dashboard rows', async () => {
  const refreshed = await loadConversationSummaries('member');
  expect(refreshed.map((row) => row.id)).toEqual(['named', 'general']);
  expect(refreshed[0]).toMatchObject({ stewardUserId: 'steward-a', counterpartRole: 'steward', unreadCount: 2, latestMessage: 'Hello' });
  expect(refreshed[1]).toMatchObject({ stewardUserId: null, counterpartRole: 'steward', unreadCount: 0 });
  expect(findNativeStewardConversation(refreshed)?.id).toBe('general');
  expect(findNativeStewardConversation(refreshed, 'steward-a')?.id).toBe('named');
  expect(findNativeStewardConversation(refreshed, 'steward-b')).toBeNull();
});
