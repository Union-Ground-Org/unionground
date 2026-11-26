import { describe, expect, it, vi } from 'vitest';
import { POSTGREST_MAX_ROWS, boundedRows, cappedLimit } from '../src/lib/boundedPage.js';
import { CHANNEL_HISTORY_PAGE, CHANNEL_WINDOW, channelHistoryApi, channelWindow, loadEarlierChannelPosts } from '../src/features/messaging/channelHistory.js';
import { loadMemberApp } from '../src/lib/memberApi.js';
import { expectNoSilentTruncation, postgrestPage } from './helpers/silentTruncation.js';

// BUG-UG-WEB-CHANNEL-HIDES-POSTS-PAST-NEWEST-1000-20261110 and the
// SILENT-TRUNCATION guard: a capped read says when more exist, and a web
// channel thread pages back past the chapter's newest 1,000 posts. Fictional
// Tamarack posts only.

const BASE = Date.UTC(2026, 8, 1, 12);
const at = (minute) => new Date(BASE + minute * 60_000).toISOString();
const post = (id, threadId, createdAt, extra = {}) => ({ id, thread_id: threadId, author_id: 'member-b', body: `Tamarack update ${id}`, body_es: null, created_at: createdAt, deleted_at: null, ...extra });
const newestFirst = (left, right) => (left.created_at === right.created_at ? (left.id < right.id ? 1 : -1) : left.created_at < right.created_at ? 1 : -1);

// A table read that applies eq, is, or (the (created_at, id) cursor), in, the
// order, the limit and the 1,000-row answer ceiling the way PostgREST does.
function tableClient(tables) {
  const reads = [];
  const from = (table) => {
    const filters = [];
    let limit = Infinity;
    const builder = {
      select: () => builder,
      eq: (column, value) => { filters.push((row) => row[column] === value); return builder; },
      is: (column, value) => { filters.push((row) => (value === null ? row[column] == null : row[column] === value)); return builder; },
      in: (column, values) => { filters.push((row) => values.includes(row[column])); return builder; },
      or: (filter) => {
        const match = /^created_at\.lt\.(".*?"),and\(created_at\.eq\.(".*?"),id\.lt\.(".*?")\)$/.exec(filter);
        if (!match || match[1] !== match[2]) throw new Error(`unexpected or filter ${filter}`);
        const [createdAt, id] = [JSON.parse(match[1]), JSON.parse(match[3])];
        filters.push((row) => row.created_at < createdAt || (row.created_at === createdAt && row.id < id));
        return builder;
      },
      order: () => builder,
      limit: (value) => { limit = value; return builder; },
      then: (resolve) => {
        const data = postgrestPage((tables[table] || []).filter((row) => filters.every((keep) => keep(row))).sort(table === 'chapter_thread_posts' ? newestFirst : () => 0), limit);
        reads.push({ table, limit, count: data.length });
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return builder;
  };
  return { client: { from }, reads };
}

describe('the shared silent-truncation guard', () => {
  it('reads one past the cap and reports more exist only past it', async () => {
    expect(cappedLimit(200)).toBe(201);
    // The probe row must fit the API's 1,000-row answer, or it never arrives.
    expect(POSTGREST_MAX_ROWS).toBe(1000);
    expect(cappedLimit(999)).toBe(1000);
    expect(() => cappedLimit(1000)).toThrow(RangeError);
    expect(() => cappedLimit(0)).toThrow(RangeError);
    await expectNoSilentTruncation({ cap: 5, read: async (total) => {
      const source = Array.from({ length: total }, (_unused, index) => index);
      const { rows, more } = boundedRows(source.slice(0, cappedLimit(5)), 5);
      return { shown: rows.length, more };
    } });
    expect(boundedRows(null, 5)).toEqual({ rows: [], more: false });
  });

  it('fails a read that stops at its cap without saying so', async () => {
    await expect(expectNoSilentTruncation({ cap: 5, read: async (total) => ({ shown: Math.min(total, 5), more: false }) })).rejects.toThrow(/must say more exist/);
  });

  it('the web channel window reports where earlier posts start once it is full', async () => {
    await expectNoSilentTruncation({ cap: CHANNEL_WINDOW, read: async (total) => {
      const source = Array.from({ length: total }, (_unused, index) => post(`p-${String(index).padStart(5, '0')}`, 'thread-1', at(index))).sort(newestFirst);
      const window = channelWindow({ data: postgrestPage(source, cappedLimit(CHANNEL_WINDOW)), error: null });
      return { shown: window.data.length, more: window.earlierBefore !== null };
    } });
    const failed = channelWindow({ data: null, error: { message: 'offline' } });
    expect(failed).toMatchObject({ error: { message: 'offline' }, earlierBefore: null });
  });
});

describe('earlier web channel posts', () => {
  it('reports more past each page, under the same contract', async () => {
    await expectNoSilentTruncation({ cap: CHANNEL_HISTORY_PAGE, read: async (total) => {
      const { client } = tableClient({ chapter_thread_posts: Array.from({ length: total }, (_unused, index) => post(`p-${String(index).padStart(5, '0')}`, 'thread-1', at(index))) });
      const page = await loadEarlierChannelPosts(client, { threadId: 'thread-1', before: { createdAt: at(100_000), id: '' } });
      return { shown: page.posts.length, more: page.earlierCursor !== null };
    } });
  });

  it('pages a thread back to its first post across equal times, without deleted posts or another thread', async () => {
    const quiet = [
      ...Array.from({ length: 101 }, (_unused, index) => post(`q-a-${String(index).padStart(3, '0')}`, 'thread-quiet', at(10))),
      ...Array.from({ length: 349 }, (_unused, index) => post(`q-b-${String(index).padStart(3, '0')}`, 'thread-quiet', at(11 + index))),
    ];
    const rows = [...quiet, post('q-deleted', 'thread-quiet', at(200), { deleted_at: at(900) }), post('other', 'thread-busy', at(300))];
    const { client, reads } = tableClient({
      chapter_thread_posts: rows,
      member_message_reactions: [{ id: 'r1', actor_id: 'member-a', source_kind: 'channel', channel_post_id: 'q-b-000', reaction: 'like', created_at: at(500) }],
    });
    const read = [];
    let cursor = { createdAt: at(1_000), id: '' };
    let pages = 0;
    while (cursor) {
      const page = await loadEarlierChannelPosts(client, { threadId: 'thread-quiet', before: cursor });
      read.unshift(...page.posts.map((row) => row.id));
      cursor = page.earlierCursor;
      pages += 1;
      if (page.posts.some((row) => row.id === 'q-b-000')) expect(page.posts.find((row) => row.id === 'q-b-000')).toMatchObject({ reactions: [expect.objectContaining({ reaction: 'like' })], saved: false, reminder: null });
    }
    expect(pages).toBe(3);
    expect(read).toEqual([...quiet].sort(newestFirst).reverse().map((row) => row.id));
    expect(reads.filter((entry) => entry.table === 'chapter_thread_posts').map((entry) => [entry.limit, entry.count])).toEqual([[201, 201], [201, 201], [201, 50]]);
  });
});

describe('the member load', () => {
  // Every read answers at most its limit and never more than 1,000 rows.
  function client(posts) {
    const chainable = (result) => {
      let limit = Infinity;
      const proxy = new Proxy(function () {}, { get(_target, prop) {
        if (prop === 'then') {
          const answer = Array.isArray(result.data) ? { ...result, data: postgrestPage(result.data, limit) } : result;
          return (...args) => Promise.resolve(answer).then(...args);
        }
        if (prop === 'limit') return (value) => { limit = value; return proxy; };
        return () => proxy;
      } });
      return proxy;
    };
    const tables = {
      member_profiles: { data: { id: 'user-1', first_name: 'Darnell', full_name: 'Darnell Foster', initials: 'DF', role_line: 'Member', member_since: 2023, language: 'en', notification_prefs: {}, chapter_id: 'wor' }, error: null },
      chapters: { data: [{ id: 'wor', name: 'Tamarack Valley' }], error: null },
      chapter_spaces: { data: [{ id: 'space-1', name: 'General' }], error: null },
      chapter_threads: { data: [{ id: 'thread-1', space_id: 'space-1', title: 'Discussion' }], error: null },
      chapter_thread_posts: { data: posts, error: null },
    };
    return {
      from: (table) => chainable(tables[table] ?? { data: [], error: null }),
      rpc: () => Promise.resolve({ data: null, error: null }),
    };
  }

  it('gives each thread the window\'s oldest post as its earlier cursor only when the window was full', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // More posts than one API answer can carry.
    const rows = Array.from({ length: 1_500 }, (_unused, index) => post(`p-${String(index).padStart(5, '0')}`, 'thread-1', at(2_000 - index)));
    const full = await loadMemberApp(client(rows), { id: 'user-1', email: 'proof@example.invalid' });
    const thread = full.product.spaces[0].threads[0];
    expect(thread.posts).toHaveLength(CHANNEL_WINDOW);
    expect(thread.earlierCursor).toEqual({ createdAt: rows[CHANNEL_WINDOW - 1].created_at, id: rows[CHANNEL_WINDOW - 1].id });
    expect(thread.posts.some((row) => row.id === rows[CHANNEL_WINDOW].id)).toBe(false);
    const whole = await loadMemberApp(client(rows.slice(0, CHANNEL_WINDOW)), { id: 'user-1', email: 'proof@example.invalid' });
    expect(whole.product.spaces[0].threads[0].earlierCursor).toBeNull();
    vi.restoreAllMocks();
  });

  it('runs the earlier-page read through the messaging api like its other reads', async () => {
    const { client: reader } = tableClient({ chapter_thread_posts: [post('p-1', 'thread-1', at(1))] });
    const operation = { run: vi.fn((work) => work()), wait: vi.fn((promise) => promise) };
    const page = await channelHistoryApi(reader, operation).loadEarlierChannelPosts({ threadId: 'thread-1', before: { createdAt: at(5), id: '' } });
    expect(page).toMatchObject({ posts: [expect.objectContaining({ id: 'p-1' })], earlierCursor: null });
    expect(operation.run).toHaveBeenCalledTimes(1);
    expect(operation.wait).toHaveBeenCalledTimes(1);
  });
});
