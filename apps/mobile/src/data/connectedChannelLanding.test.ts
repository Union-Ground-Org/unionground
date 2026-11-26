import { beforeEach, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../services/supabase', () => ({ getSupabaseClient: () => backend }));
import { liveChannelStore } from './liveChannels';
let available = true;
let removed = false;
let threadTitle = 'Discussion';
let spaceNameEs: string | null = null;
beforeEach(() => {
  liveChannelStore.resetForSession(); available = true; removed = false;
  threadTitle = 'Discussion'; spaceNameEs = null;
  backend.rpc.mockReset().mockImplementation(async () => ({ data: { available }, error: null }));
  backend.from.mockReset().mockImplementation((table: string) => {
    const data: Record<string, Record<string, unknown>> = {
      chapter_thread_posts: { id: 'post', thread_id: 'thread', body: 'Exact older post', author_name: 'Alex', author_initials: 'A', created_at: '2026-09-01' },
      chapter_threads: { id: 'thread', title: threadTitle, space_id: 'space', status: 'open' },
      chapter_spaces: { id: 'space', name: 'Campaign', name_es: spaceNameEs, description: 'Discussion', visibility: 'chapter' },
    };
    const filters: [string, unknown][] = [];
    const q = {
      select: () => q, is: () => q,
      eq: (column: string, value: unknown) => { filters.push([column, value]); return q; },
      maybeSingle: async () => ({ data: (table === 'chapter_thread_posts' && removed) || !filters.every(([key, value]) => data[table]?.[key] === value) ? null : data[table], error: null }),
    }; return q;
  });
});
it('hydrates an authorized exact post and its owning thread outside the loaded channel list', async () => {
  expect(liveChannelStore.channel('thread')).toBeNull();
  expect(await liveChannelStore.hydrateSource('thread', 'post')).toBe(true);
  expect(liveChannelStore.channel('thread')?.messages[0]).toMatchObject({ id: 'post', body: 'Exact older post' });
  expect(liveChannelStore.channel('thread')?.spaceID).toBe('space');
  expect(await liveChannelStore.hydrateSource('wrong-thread', 'post')).toBe(false);
});
it('withdraws the retained source when it is removed or access changes', async () => {
  await liveChannelStore.hydrateSource('thread', 'post');
  removed = true;
  expect(await liveChannelStore.hydrateSource('thread', 'post')).toBe(false);
  expect(liveChannelStore.channel('thread')).toBeNull();
  removed = false; await liveChannelStore.hydrateSource('thread', 'post');
  available = false;
  expect(await liveChannelStore.hydrateSource('thread', 'post')).toBe(false);
  expect(liveChannelStore.channel('thread')).toBeNull();
});
it('keeps the space translation when a first-post thread inherits the space name', async () => {
  threadTitle = 'Campaign'; spaceNameEs = 'Capítulo';
  expect(await liveChannelStore.hydrateSource('thread', 'post')).toBe(true);
  expect(liveChannelStore.channel('thread')).toMatchObject({ name: 'Campaign', nameEs: 'Capítulo' });
});
