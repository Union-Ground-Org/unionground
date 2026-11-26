import { describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), auth: {} }));

vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => backend, processLock: vi.fn() }));
vi.mock('../lib/config', () => ({
  mobileConfig: { backendConfigured: true, supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'publishable-test-key' },
}));
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));

import { loadMobileConnectionReadiness } from './supabase';

// Gate round 1 on #8641: the readiness rows follow the server's current
// chapter through their read policy, which another session can switch, so
// each row says which chapter it belongs to and Chapter admin records a
// decision only against that chapter.
describe('connection readiness rows', () => {
  it('return the campaign each row belongs to', async () => {
    const calls: unknown[][] = [];
    const rows = [
      { chapter_id: 'springfield', capability: 'sms', status: 'active', provider_label: 'Provider B', public_message: '', updated_at: null },
      { capability: 'cba', status: 'unset', provider_label: '', public_message: '', updated_at: null },
    ];
    backend.from.mockImplementation((table: string) => {
      calls.push(['from', table]);
      const query = {
        select: (...args: unknown[]) => { calls.push(['select', ...args]); return query; },
        order: async (...args: unknown[]) => { calls.push(['order', ...args]); return { data: rows, error: null }; },
      };
      return query;
    });
    const readiness = await loadMobileConnectionReadiness();
    expect(calls).toContainEqual(['from', 'chapter_connection_readiness']);
    expect(calls.some(([method, columns]) => method === 'select' && typeof columns === 'string' && columns.split(',').includes('chapter_id'))).toBe(true);
    expect(readiness.map(({ capability, chapterID }) => ({ capability, chapterID }))).toEqual([
      { capability: 'sms', chapterID: 'springfield' },
      { capability: 'cba', chapterID: null },
    ]);
  });
});
