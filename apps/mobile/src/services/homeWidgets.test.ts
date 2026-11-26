import type { Session } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, rpc, getUser, filters, rows } = vi.hoisted(() => ({
  query: vi.fn(), rpc: vi.fn(), getUser: vi.fn(), filters: [] as unknown[][],
  rows: {} as Record<string, { data?: unknown; count?: number | null; error?: unknown }>,
}));
vi.mock('../../modules/home-widgets/src/HomeWidgetsModule', () => ({ default: null }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'nonce' }));
vi.mock('./supabase', () => ({
  getSupabaseClient: () => ({ auth: { getUser } }),
  createCapturedSessionRpcClient: () => ({ from: query, rpc }),
}));
import { readHomeWidgetSnapshot } from './homeWidgets';

const scope = { userID: 'user-a', sessionID: 'session-a', organizationID: 'org-a', chapterID: 'chapter-a' };
const session = { user: { id: 'user-a' }, access_token: 'captured-token' } as Session;
const memberships = [{ chapterId: 'chapter-a', organizationId: 'org-a', selected: true }];
type Row = Record<string, unknown>;
// A small PostgREST stand-in: equality, null, greater-than, `or` and
// inner-embed filters are applied to `rows[table].data` with SQL's null rule
// (null is never equal and never not equal), `count` is exact over the
// filtered rows, and a response body never carries more than MAX_ROWS rows,
// like the server's max_rows cap.
const MAX_ROWS = 1_000;
const field = (row: Row, column: string) => column.split('.').reduce<unknown>((value, key) => (value as Row | undefined)?.[key], row);
function evaluate(table: string, steps: unknown[][]) {
  const row = rows[table];
  if (!row || row.error || !Array.isArray(row.data)) return { ...row, count: row?.count ?? null };
  const select = steps.find((step) => step[0] === 'select') ?? [];
  const head = (select[2] as { head?: boolean } | undefined)?.head === true;
  const embed = /(\w+)!inner/.exec(String(select[1] ?? ''))?.[1];
  let data = (row.data as Row[]).map((item) => (embed && table === 'chapter_threads'
    ? { ...item, [embed]: postsOf(item.id) } : item));
  const known = (value: unknown) => value !== null && value !== undefined;
  const clause = (item: Row, column: string, operator: string, value: unknown) => operator === 'eq' ? known(item[column]) && item[column] === value
    : operator === 'neq' ? known(item[column]) && item[column] !== value
      : operator === 'is' ? (item[column] ?? null) === value
        : operator === 'gt' ? Date.parse(String(item[column])) > Date.parse(String(value)) : true;
  for (const [name, column, value] of steps) {
    if (name === 'or') {
      // `.or('a.is.null,a.neq.x', { referencedTable })`: any clause matches.
      const parts = String(column).split(',').map((part): [string, string, string | null] => { const [key = '', operator = '', ...rest] = part.split('.'); const raw = rest.join('.'); return [key, operator, raw === 'null' ? null : raw]; });
      const test = (item: Row) => parts.some(([key, operator, raw]) => clause(item, key, operator, raw));
      const parent = (value as { referencedTable?: string } | undefined)?.referencedTable;
      data = parent ? data.map((item) => ({ ...item, [parent]: (item[parent] as Row[]).filter(test) })) : data.filter(test);
      continue;
    }
    const path = String(column);
    const [parent, child] = path.includes('.') ? path.split('.') : [null, path];
    const test = (item: Row) => clause(item, child!, String(name), value);
    if (!['eq', 'neq', 'is', 'gt'].includes(String(name))) continue;
    data = parent
      ? data.map((item) => ({ ...item, [parent]: (item[parent] as Row[]).filter(test) }))
      : data.filter(test);
  }
  if (embed) data = data.filter((item) => (item[embed] as Row[]).length > 0);
  const limit = steps.find((step) => step[0] === 'limit')?.[1] as number | undefined;
  const body = head ? null : data.slice(0, Math.min(limit ?? MAX_ROWS, MAX_ROWS));
  return { data: body, count: row.count !== undefined ? row.count : data.length, error: null };
}
const postsOf = (threadID: unknown) => ((rows.chapter_thread_posts?.data ?? []) as Row[]).filter((post) => post.thread_id === threadID);
const post = (thread: string, created: string, deleted: string | null = null, author: string | null = 'member-b') => ({ thread_id: thread, chapter_id: 'chapter-a', created_at: created, deleted_at: deleted, author_id: author });
beforeEach(() => {
  vi.clearAllMocks();
  filters.length = 0;
  for (const key of Object.keys(rows)) delete rows[key];
  getUser.mockResolvedValue({ data: { user: { id: 'user-a' } }, error: null });
  rpc.mockResolvedValue({ data: memberships, error: null });
  Object.assign(rows, {
    chapter_tasks: { count: 2 },
    member_conversations: { data: [{ id: 'own', user_id: 'user-a', organization_id: 'org-a' }] },
    member_conversation_summaries: { data: [{ conversation_id: 'own', unread_count: 3 }, { conversation_id: 'foreign', unread_count: 99 }] },
    chapter_spaces: { data: [{ id: 'space-a', chapter_id: 'chapter-a', archived_at: null }] },
    chapter_threads: { data: [{ id: 'thread-a', space_id: 'space-a', chapter_id: 'chapter-a' }, { id: 'foreign-thread', space_id: 'foreign-space', chapter_id: 'chapter-a' }] },
    chapter_space_reads: { data: [] },
    chapter_thread_posts: { data: [post('thread-a', '2026-10-29T12:00:00-04:00'), post('foreign-thread', '2026-10-29T12:00:00-04:00')] },
  });
  query.mockImplementation((table: string) => {
    const steps: unknown[][] = [];
    const chain: Record<string, unknown> = {};
    for (const name of ['select', 'eq', 'neq', 'is', 'gt', 'or', 'limit']) chain[name] = (...args: unknown[]) => { filters.push([table, name, ...args]); steps.push([name, ...args]); return chain; };
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(evaluate(table, steps)).then(resolve);
    return chain;
  });
});
describe('fresh captured-session widget reads', () => {
  it('minimizes authorized due-today and unread inbox counts, ignoring foreign rows', async () => {
    const result = await readHomeWidgetSnapshot(session, scope);
    expect(result).toMatchObject({ today: 2, unread: 2 });
    expect(Object.keys(result).sort()).toEqual(['expiresAt', 'today', 'unread', 'updatedAt']);
    expect(getUser).toHaveBeenCalledWith('captured-token');
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(filters).toContainEqual(['member_conversations', 'eq', 'organization_id', 'org-a']);
    expect(filters).toContainEqual(['chapter_tasks', 'eq', 'chapter_id', 'chapter-a']);
    for (const filter of filters.filter((row) => row[1] === 'select')) {
      expect(filter[2]).not.toMatch(/title|body|name|attachment|access_token|refresh_token/);
    }
  });
  it('rejects another account before any protected read', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'other' } }, error: null });
    await expect(readHomeWidgetSnapshot(session, scope)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects another organization or changed selected campaign', async () => {
    rpc.mockResolvedValue({ data: [{ ...memberships[0], organizationId: 'other' }], error: null });
    await expect(readHomeWidgetSnapshot(session, scope)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects scope revocation during the protected read', async () => {
    rpc.mockResolvedValueOnce({ data: memberships, error: null }).mockResolvedValueOnce({ data: [], error: null });
    await expect(readHomeWidgetSnapshot(session, scope)).rejects.toThrow();
  });
  it('does not fabricate counts from an error or truncated source', async () => {
    rows.chapter_tasks = { count: null, error: { code: 'denied' } };
    await expect(readHomeWidgetSnapshot(session, scope)).rejects.toThrow();
    rows.chapter_tasks = { count: 0 };
    rows.chapter_spaces = { data: Array.from({ length: 1001 }, (_, index) => ({ id: `space-${index}`, chapter_id: 'chapter-a', archived_at: null })) };
    await expect(readHomeWidgetSnapshot(session, scope)).rejects.toThrow();
  });
  it('fails closed when a per-space unread count errors or comes back without a count', async () => {
    rows.chapter_threads = { error: { code: 'denied' } };
    await expect(readHomeWidgetSnapshot(session, scope)).rejects.toThrow('Widget counts unavailable.');
    rows.chapter_threads = { data: [], count: null };
    await expect(readHomeWidgetSnapshot(session, scope)).rejects.toThrow('Widget counts unavailable.');
  });
  it('fails closed on a truncated unread-summary read', async () => {
    rows.member_conversation_summaries = { data: Array.from({ length: 1001 }, (_, index) => ({ conversation_id: `c-${index}`, unread_count: 1 })) };
    await expect(readHomeWidgetSnapshot(session, scope)).rejects.toThrow('Widget counts unavailable.');
  });
});

describe('BUG-UG-UNREAD-WIDGET-FAILS-PAST-1000-CHANNEL-POSTS-20261106', () => {
  const readAt = '2026-11-06T09:00:00.000Z';
  beforeEach(() => {
    const threads = Array.from({ length: 30 }, (_, index) => ({ id: `thread-${index}`, space_id: 'space-a', chapter_id: 'chapter-a' }));
    const history = Array.from({ length: 1_500 }, (_, index) => post(`thread-${index % 30}`, new Date(Date.parse(readAt) - (index + 1) * 60_000).toISOString()));
    Object.assign(rows, {
      chapter_spaces: { data: [{ id: 'space-a', chapter_id: 'chapter-a', archived_at: null }, { id: 'space-b', chapter_id: 'chapter-a', archived_at: null }] },
      chapter_threads: { data: [...threads, { id: 'thread-b', space_id: 'space-b', chapter_id: 'chapter-a' }] },
      chapter_space_reads: { data: [{ space_id: 'space-a', user_id: 'user-a', last_read_at: readAt }, { space_id: 'space-b', user_id: 'user-a', last_read_at: readAt }] },
      chapter_thread_posts: { data: [
        ...history,
        post('thread-3', '2026-11-06T10:00:00.000Z'),
        post('thread-3', '2026-11-06T10:05:00.000Z'),
        post('thread-b', '2026-11-06T11:00:00.000Z'),
        post('thread-7', '2026-11-06T12:00:00.000Z', '2026-11-06T12:01:00.000Z'),
      ] },
    });
  });
  it('counts two unread threads among 1,500 read posts instead of failing', async () => {
    await expect(readHomeWidgetSnapshot(session, scope)).resolves.toMatchObject({ today: 2, unread: 1 + 2 });
    expect(filters.some((row) => row[0] === 'chapter_thread_posts')).toBe(false);
    expect(filters).toContainEqual(['chapter_threads', 'select', 'id,chapter_thread_posts!inner(id)', { count: 'exact', head: true }]);
    expect(filters).toContainEqual(['chapter_threads', 'gt', 'chapter_thread_posts.created_at', readAt]);
    expect(filters).toContainEqual(['chapter_threads', 'is', 'chapter_thread_posts.deleted_at', null]);
    expect(filters).toContainEqual(['member_conversation_summaries', 'gt', 'unread_count', 0]);
  });
  // BUG-UG-OWN-POSTS-COUNT-AS-UNREAD-20261111: a reply the member
  // wrote after reading does not make its thread unread for them.
  it("leaves out the worker's own posts", async () => {
    (rows.chapter_thread_posts!.data as Row[]).push({ ...post('thread-9', '2026-11-06T13:00:00.000Z'), author_id: 'user-a' });
    (rows.chapter_thread_posts!.data as Row[]).push({ ...post('thread-3', '2026-11-06T13:05:00.000Z'), author_id: 'user-a' });
    await expect(readHomeWidgetSnapshot(session, scope)).resolves.toMatchObject({ unread: 1 + 2 });
    expect(filters).toContainEqual(['chapter_threads', 'or', 'author_id.is.null,author_id.neq.user-a', { referencedTable: 'chapter_thread_posts' }]);
  });
  // BUG-UG-NATIVE-HOME-WIDGET-UNREAD-SKIPS-POSTS-BY-DELETED-AUTHORS-20261115 (#8774):
  // a deleted account's posts keep a null author and are still unread, as in
  // the channel list (isOwnChannelPost), while the member's own posts are not.
  it('counts a thread whose unread post has a deleted author, beside own and other workers\' posts', async () => {
    const posts = rows.chapter_thread_posts!.data as Row[];
    posts.push(post('thread-9', '2026-11-06T13:00:00.000Z', null, null));
    posts.push(post('thread-10', '2026-11-06T13:01:00.000Z', null, 'user-a'));
    posts.push(post('thread-11', '2026-11-06T13:02:00.000Z', null, 'member-c'));
    // thread-3 and thread-b (another member), thread-9 (deleted author) and
    // thread-11 (another member) are unread; thread-10 holds only the member's own post.
    await expect(readHomeWidgetSnapshot(session, scope)).resolves.toMatchObject({ unread: 1 + 4 });
    const { isOwnChannelPost } = await import('../../../../src/features/messaging/unread.js');
    const unreadByChannelRule = new Set(posts.filter((row) => !row.deleted_at && Date.parse(String(row.created_at)) > Date.parse(readAt) && !isOwnChannelPost(row, 'user-a')).map((row) => row.thread_id));
    expect(unreadByChannelRule.size).toBe(4);
  });
  it('counts every thread with a live post in a never-read space, past 1,000 posts', async () => {
    rows.chapter_space_reads = { data: [{ space_id: 'space-b', user_id: 'user-a', last_read_at: 'not a date' }] };
    await expect(readHomeWidgetSnapshot(session, scope)).resolves.toMatchObject({ unread: 1 + 30 + 1 });
    expect(filters.filter((row) => row[0] === 'chapter_threads' && row[1] === 'gt')).toEqual([]);
  });
});
