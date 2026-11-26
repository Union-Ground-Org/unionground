import { stubSessionWriter } from '../testing/stubSessionWriter';
import { getSupabaseClient as protocolTestClient } from '../services/supabase';
const testWriter = stubSessionWriter(protocolTestClient);
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResponseQueue } from '../../../../tests/helpers/responseQueue.js';
import { StaleResponseError } from '../lib/requestGeneration';

const backend = vi.hoisted(() => {
  const defaultRows: Record<string, unknown[]> = {
    chapter_spaces: [{ id: 'space-1', name: 'general', name_es: null, description: 'Campaign updates', description_es: null, visibility: 'chapter' }],
    chapter_threads: [{ id: 'thread-1', space_id: 'space-1', created_at: '2026-08-20T12:00:00.000Z' }],
    chapter_space_reads: [],
    chapter_channel_polls: [],
    chapter_thread_posts: [{
      id: 'post-1',
      thread_id: 'thread-1',
      // A chapter peer's post: the signed-in member-a's own posts are never
      // unread for them (BUG-UG-OWN-POSTS-COUNT-AS-UNREAD-20261111).
      author_id: 'member-b',
      body: 'Private campaign update',
      body_es: null,
      author_name: 'Worker B',
      author_initials: 'MB',
      author_role: null,
      created_at: '2026-08-20T12:00:00.000Z',
    }],
    member_message_reactions: [],
  };

  const rows: Record<string, unknown[]> = {};
  const tableErrors: Record<string, unknown> = {};
  let rpcResult: { data: unknown; error: unknown } = { data: null, error: null };
  let rpcThrows: unknown = null;

  function cloneRows(): Record<string, unknown[]> {
    return {
      chapter_spaces: [...(defaultRows.chapter_spaces ?? [])],
      chapter_threads: [...(defaultRows.chapter_threads ?? [])],
      chapter_space_reads: [...(defaultRows.chapter_space_reads ?? [])],
      chapter_channel_polls: [...(defaultRows.chapter_channel_polls ?? [])],
      chapter_thread_posts: [...(defaultRows.chapter_thread_posts ?? [])],
      member_message_reactions: [...(defaultRows.member_message_reactions ?? [])],
    };
  }

  const identifierFilters: { table: string; column: string; count: number }[] = [];
  const rowReads: { table: string; count: number }[] = [];
  const projections: { table: string; columns: string }[] = [];

  function reset() {
    const next = cloneRows();
    for (const key of Object.keys(rows)) delete rows[key];
    Object.assign(rows, next);
    for (const key of Object.keys(tableErrors)) delete tableErrors[key];
    identifierFilters.length = 0;
    rowReads.length = 0;
    projections.length = 0;
    rpcResult = { data: null, error: null };
    rpcThrows = null;
  }
  reset();

  function query(table: string) {
    // The identifier filters are applied the way PostgREST applies them, so a
    // batched read returns each row once instead of once per request. `limit`
    // and `order` match PostgREST too: the channel-post cap is a real row
    // bound, not a source-string grep over a no-op mock.
    const applied: { column: string; values: Set<unknown> }[] = [];
    const appliedIs: { column: string; value: unknown }[] = [];
    let appliedLimit: number | null = null;
    const appliedOrder: { column: string; ascending: boolean }[] = [];
    let columns: string[] | null = null;
    const equalities: { column: string; value: unknown }[] = [];
    // The (created_at, id) cursor of an earlier-history page, as PostgREST
    // reads `created_at.lt.X,and(created_at.eq.X,id.lt.Y)`.
    let before: { createdAt: string; id: string } | null = null;
    function matchesNestedIs(row: Record<string, unknown>, column: string, value: unknown): boolean {
      // PostgREST `!inner` + nested `is` excludes parent rows with no match.
      if (table === 'chapter_thread_posts'
        && column === 'chapter_threads.chapter_spaces.archived_at'
        && value === null) {
        const thread = (rows.chapter_threads ?? []).find(
          (candidate) => (candidate as { id: unknown }).id === row.thread_id,
        ) as { space_id?: unknown } | undefined;
        if (!thread) return false;
        const space = (rows.chapter_spaces ?? []).find(
          (candidate) => (candidate as { id: unknown }).id === thread.space_id,
        ) as { archived_at?: unknown } | undefined;
        if (!space) return false;
        return space.archived_at == null;
      }
      return true;
    }
    function settle(): { data: unknown; error: unknown; status?: unknown } {
      const failure = tableErrors[table];
      if (failure && typeof failure === 'object' && 'error' in failure) {
        return failure as { data: unknown; error: unknown; status?: unknown };
      }
      if (failure) return { data: null, error: failure };
      let selected = (rows[table] ?? []).filter((row) => {
        const record = row as Record<string, unknown>;
        if (!applied.every((filter) => filter.values.has(record[filter.column]))) return false;
        // A row that carries the column must equal it; fixtures without the
        // column (reactions without source_kind) keep passing.
        if (!equalities.every(({ column, value }) => !(column in record) || record[column] === value)) return false;
        if (before) {
          const at = String(record.created_at);
          if (!(at < before.createdAt || (at === before.createdAt && String(record.id) < before.id))) return false;
        }
        for (const check of appliedIs) {
          if (check.column.includes('.')) {
            if (!matchesNestedIs(record, check.column, check.value)) return false;
            continue;
          }
          const actual = record[check.column];
          if (check.value === null ? actual != null : actual !== check.value) return false;
        }
        return true;
      });
      if (appliedOrder.length) {
        selected = selected.slice().sort((left, right) => {
          for (const { column, ascending } of appliedOrder) {
            const a = String((left as Record<string, unknown>)[column] ?? '');
            const b = String((right as Record<string, unknown>)[column] ?? '');
            if (a === b) continue;
            const cmp = a < b ? -1 : 1;
            return ascending ? cmp : -cmp;
          }
          return 0;
        });
      }
      if (appliedLimit != null) selected = selected.slice(0, appliedLimit);
      rowReads.push({ table, count: selected.length });
      if (columns) {
        const keys = columns;
        selected = selected.map((row) => Object.fromEntries(Object.entries(row as Record<string, unknown>)
          .filter(([key]) => keys.includes(key))));
      }
      return { data: selected, error: null };
    }
    const builder = {
      select: (value: string) => {
        projections.push({ table, columns: value });
        columns = value === '*' ? null : value.split(',');
        return builder;
      },
      is: (column: string, value: unknown) => {
        appliedIs.push({ column, value });
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        identifierFilters.push({ table, column, count: values.length });
        applied.push({ column, values: new Set(values) });
        return builder;
      },
      eq: (column: string, value: unknown) => { equalities.push({ column, value }); return builder; },
      or: (filter: string) => {
        const match = /^created_at\.lt\.(".*?"),and\(created_at\.eq\.(".*?"),id\.lt\.(".*?")\)$/.exec(filter);
        if (!match || match[1] !== match[2]) throw new Error(`unexpected or filter ${filter}`);
        before = { createdAt: JSON.parse(match[1]!) as string, id: JSON.parse(match[3]!) as string };
        return builder;
      },
      maybeSingle: () => {
        const result = settle();
        const data = result.data as Record<string, unknown>[] | null;
        return Promise.resolve({ ...result, data: data?.find((row) => equalities.every(({ column, value }) => row[column] === value)) ?? null });
      },
      limit: (value: number) => {
        appliedLimit = value;
        return builder;
      },
      order: (column: string, options?: { ascending?: boolean }) => {
        appliedOrder.push({ column, ascending: options?.ascending !== false });
        return builder;
      },
      then: (resolve: (value: ReturnType<typeof settle>) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(settle()).then(resolve, reject),
    };
    return builder;
  }

  const realtime = { on: vi.fn(), subscribe: vi.fn() };
  realtime.on.mockReturnValue(realtime);
  realtime.subscribe.mockReturnValue(realtime);

  return {
    rows,
    tableErrors,
    identifierFilters,
    rowReads,
    projections,
    reset,
    setRpc(result: { data: unknown; error: unknown }) { rpcResult = result; rpcThrows = null; },
    throwRpc(error: unknown) { rpcThrows = error; },
    client: {
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: 'member-a' } } } }) },
      from: vi.fn((table: string) => query(table)),
      channel: vi.fn(() => realtime),
      removeChannel: vi.fn().mockResolvedValue(undefined),
      rpc: vi.fn(() => (rpcThrows ? Promise.reject(rpcThrows) : Promise.resolve(rpcResult))),
    },
  };
});

vi.mock('../services/supabase', () => ({ getSupabaseClient: () => backend.client }));

import * as liveChannelsModule from './liveChannels';
import type { ChannelMessage } from './demoChannels';
import {
  CHANNEL_LOAD_LOG_TAG,
  readLastChannelLoadDiagnosis,
  resetChannelLoadDiagnosis,
} from '../lib/channelLoadDiagnosis';
import { channelLoadFailureNotice, inboxChannelLoadNotice, messageInboxCopy } from '../lib/messageInboxCopy';
import { MESSAGE_REACTION_KINDS } from '../lib/messagingShared';
import { channelInReaderLanguage } from '../lib/channelContent';

const { liveChannelStore, REACTION_KIND_EMOJI } = liveChannelsModule;

describe('Spanish campaign content reads (#6643)', () => {
  function bilingualRows() {
    backend.rows.chapter_spaces = [
      { id: 'space-1', name: 'general', name_es: 'general en español', description: 'Campaign updates', description_es: 'Noticias de la campaña', visibility: 'chapter' },
      { id: 'empty-space', name: 'Questions', name_es: 'Preguntas', description: 'Ask here', description_es: 'Pregunta aquí', visibility: 'chapter' },
    ];
    backend.rows.chapter_thread_posts = [{
      id: 'post-1', thread_id: 'thread-1', author_id: 'member-a', body: 'Private campaign update', body_es: 'Noticia de la campaña',
      author_name: 'Worker A', author_initials: 'MA', author_role: null, created_at: '2026-08-20T12:00:00.000Z',
    }];
  }

  function expectSpanishColumns() {
    const spaces = backend.projections.filter(({ table }) => table === 'chapter_spaces');
    const posts = backend.projections.filter(({ table }) => table === 'chapter_thread_posts');
    expect(spaces).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(spaces[0]?.columns.split(',')).toEqual(expect.arrayContaining(['name_es', 'description_es']));
    expect(posts[0]?.columns.split(',')).toContain('body_es');
  }

  it('selects and preserves both versions for untitled threads and spaces without threads', async () => {
    bilingualRows();
    liveChannelStore.acquire();
    await vi.waitFor(() => expect(liveChannelStore.status()).toBe('ready'));
    expectSpanishColumns();
    const channel = liveChannelStore.channel('thread-1')!;
    expect(channel).toMatchObject({ name: 'general', nameEs: 'general en español', topic: 'Campaign updates', topicEs: 'Noticias de la campaña' });
    expect(channel.messages[0]).toMatchObject({ body: 'Private campaign update', bodyEs: 'Noticia de la campaña' });
    expect(channelInReaderLanguage(channel, 'es')).toMatchObject({ name: 'general en español', topic: 'Noticias de la campaña', messages: [{ body: 'Noticia de la campaña' }] });
    expect(channelInReaderLanguage(channel, 'en')).toBe(channel);
    expect(channelInReaderLanguage(liveChannelStore.channel('empty-space')!, 'es')).toMatchObject({ name: 'Preguntas', topic: 'Pregunta aquí' });
    expect(liveChannelStore.channel('thread-1')?.messages[0]?.body).toBe('Private campaign update');
  });

  it('keeps a thread title while translating the space name in its topic', async () => {
    bilingualRows();
    backend.rows.chapter_threads = [{ id: 'thread-1', space_id: 'space-1', title: 'Meeting plans', status: 'open', created_at: '2026-08-20T12:00:00.000Z' }];
    liveChannelStore.acquire();
    await vi.waitFor(() => expect(liveChannelStore.status()).toBe('ready'));
    expect(channelInReaderLanguage(liveChannelStore.channel('thread-1')!, 'es')).toMatchObject({ name: 'Meeting plans', topic: 'general en español' });
  });

  it.each([null, '', '  \n '])('falls back independently for missing or blank Spanish content (%s)', async (spanish) => {
    backend.rows.chapter_spaces = [{ id: 'space-1', name: 'general', name_es: spanish, description: 'Campaign updates', description_es: spanish, visibility: 'chapter' }];
    backend.rows.chapter_thread_posts = [{
      id: 'post-1', thread_id: 'thread-1', author_id: 'member-a', body: 'Private campaign update', body_es: spanish,
      author_name: 'Worker A', author_initials: 'MA', author_role: null, created_at: '2026-08-20T12:00:00.000Z',
    }];
    liveChannelStore.acquire();
    await vi.waitFor(() => expect(liveChannelStore.status()).toBe('ready'));
    expect(channelInReaderLanguage(liveChannelStore.channel('thread-1')!, 'es')).toMatchObject({ name: 'general', topic: 'Campaign updates', messages: [{ body: 'Private campaign update' }] });
  });

  it.each([null, 'Meeting plans'])('selects and keeps Spanish content when opening an exact post with title %s', async (title) => {
    bilingualRows();
    backend.rows.chapter_threads = [{ id: 'thread-1', space_id: 'space-1', title, status: 'open' }];
    backend.setRpc({ data: { available: true }, error: null });
    await expect(liveChannelStore.hydrateSource('thread-1', 'post-1')).resolves.toBe(true);
    expectSpanishColumns();
    const channel = liveChannelStore.channel('thread-1')!;
    expect(channel.messages[0]).toMatchObject({ body: 'Private campaign update', bodyEs: 'Noticia de la campaña' });
    expect(channelInReaderLanguage(channel, 'es')).toMatchObject({ name: title ?? 'general en español', topic: 'Noticias de la campaña', messages: [{ body: 'Noticia de la campaña' }] });
    expect(channelInReaderLanguage(channel, 'en')).toMatchObject({ name: title ?? 'general', topic: 'Campaign updates', messages: [{ body: 'Private campaign update' }] });
  });

  it('preserves Spanish content on a confirmed reply before the next refresh', async () => {
    liveChannelStore.acquire();
    await vi.waitFor(() => expect(liveChannelStore.status()).toBe('ready'));
    liveChannelStore.acceptConfirmedReply('thread-1', {
      id: 'reply-1', thread_id: 'thread-1', author_id: 'member-a', body: 'Confirmed reply', body_es: 'Respuesta confirmada',
      author_name: 'Worker A', author_initials: 'MA', author_role: null, created_at: '2026-08-20T12:01:00.000Z', parent_post_id: 'post-1',
    });
    const channel = liveChannelStore.channel('thread-1')!;
    expect(channel.messages[1]).toMatchObject({ body: 'Confirmed reply', bodyEs: 'Respuesta confirmada' });
    expect(channelInReaderLanguage(channel, 'es').messages[1]?.body).toBe('Respuesta confirmada');
  });
});

afterEach(() => {
  liveChannelStore.release();
  backend.reset();
  resetChannelLoadDiagnosis();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// Reads the argument of every `.insert(...)` call in a source file, one entry
// per call site, by matching the payload's own brackets. Scoping the author
// guard to these keeps `.select(...)` projections of author_name out of it.
function insertPayloads(source: string): string[] {
  const payloads: string[] = [];
  const opener = /\.insert\(\s*/g;
  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    const start = match.index + match[0].length;
    const first = source[start];
    if (first !== '{' && first !== '[') {
      const close = source.indexOf(')', start);
      payloads.push(source.slice(start, close === -1 ? undefined : close));
      continue;
    }
    let depth = 0;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) {
          payloads.push(source.slice(start, index + 1));
          opener.lastIndex = index + 1;
          break;
        }
      }
    }
  }
  return payloads;
}

describe('live channels store (authenticated mode backend wiring)', () => {
  const live = readFileSync(fileURLToPath(new URL('./liveChannels.ts', import.meta.url)), 'utf8');
  const hook = readFileSync(fileURLToPath(new URL('./useChannels.ts', import.meta.url)), 'utf8');

  it('writes only through the guarded RPCs, never direct table writes', () => {
    expect(live).toContain("rpc('cast_channel_poll_vote'");
    expect(live).toContain("rpc('get_channel_poll_tally'");
    expect(live).toContain("rpc('mark_chapter_space_read'");
    expect(live).toContain("rpc('toggle_member_message_reaction'");
    expect(live).not.toContain(".from('chapter_channel_poll_votes').insert");
    expect(live).not.toContain(".from('member_message_reactions').insert");
    expect(live).not.toContain(".from('chapter_space_reads')" + '.insert');
  });

  it('carries the campaign space id and the closed state on each thread row for the reply RPCs', async () => {
    // BUG-UG-MOBILE-CHANNEL-REPLIES-TARGET-THREAD-ID-AND-RESOLVED-THREAD-COMPOSE-20260926
    backend.rows.chapter_threads = [
      { id: 'thread-1', space_id: 'space-1', title: 'Open thread', status: 'open', created_at: '2026-08-20T12:00:00.000Z' },
      { id: 'thread-2', space_id: 'space-1', title: 'Resolved thread', status: 'resolved', created_at: '2026-08-21T12:00:00.000Z' },
    ];
    liveChannelStore.acquire();
    await vi.waitFor(() => expect(liveChannelStore.status()).toBe('ready'));
    expect(live).toContain(".select('id,space_id,title,status,created_at,pinned_at')");
    expect(liveChannelStore.channel('thread-1')).toMatchObject({ spaceID: 'space-1' });
    expect(liveChannelStore.channel('thread-1')?.closed).toBeUndefined();
    expect(liveChannelStore.channel('thread-2')).toMatchObject({ spaceID: 'space-1', closed: true });
    liveChannelStore.release();
  });

  it('names a closed thread only from a fresh status reading, never from the refusal code alone', async () => {
    // BUG-UG-MOBILE-CHANNEL-REPLIES-TARGET-THREAD-ID-AND-RESOLVED-THREAD-COMPOSE-20260926
    backend.rows.chapter_threads = [
      { id: 'thread-1', space_id: 'space-1', title: 'Open thread', status: 'open', created_at: '2026-08-20T12:00:00.000Z' },
    ];
    liveChannelStore.acquire();
    await vi.waitFor(() => expect(liveChannelStore.status()).toBe('ready'));
    await expect(liveChannelStore.threadClosed('thread-1')).resolves.toBe(false);
    expect(liveChannelStore.channel('thread-1')?.closed).toBeUndefined();
    // The thread was resolved after the rows loaded: the fresh reading closes it.
    backend.rows.chapter_threads = [
      { id: 'thread-1', space_id: 'space-1', title: 'Open thread', status: 'resolved', created_at: '2026-08-20T12:00:00.000Z' },
    ];
    await expect(liveChannelStore.threadClosed('thread-1')).resolves.toBe(true);
    expect(liveChannelStore.channel('thread-1')?.closed).toBe(true);
    // A row the caller can no longer read answers false: lost access is not a closed thread.
    backend.rows.chapter_threads = [];
    await expect(liveChannelStore.threadClosed('thread-1')).resolves.toBe(false);
    liveChannelStore.release();
  });

  it('purges authorized channel rows when the last signed-in consumer releases the store', async () => {
    liveChannelStore.acquire();
    await vi.waitFor(() => expect(liveChannelStore.status()).toBe('ready'));
    expect(liveChannelStore.channel('space-1')?.messages[0]?.body).toBe('Private campaign update');
    expect(liveChannelStore.channel('space-1')?.members).toBeUndefined();

    liveChannelStore.release();

    expect(liveChannelStore.channels()).toEqual([]);
    expect(liveChannelStore.poll()).toBeNull();
    expect(liveChannelStore.status()).toBe('idle');
  });

  it('represents confirmed menu reactions through stale reads and replaces them on a newer snapshot', async () => {
    liveChannelStore.acquire();
    await vi.waitFor(() => expect(liveChannelStore.status()).toBe('ready'));
    let finish: ((value: { data: { session: { user: { id: string } } } }) => void) | undefined;
    backend.client.auth.getSession.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const stale = liveChannelStore.refresh();
    liveChannelStore.acceptConfirmedActions('space-1', 'post-1', ['solidarity', 'strength']);
    finish?.({ data: { session: { user: { id: 'member-a' } } } });
    await stale;
    expect(liveChannelStore.channel('space-1')?.messages[0]?.reactions?.filter((entry) => entry.mine).map((entry) => entry.kind)).toEqual(['solidarity', 'strength']);
    await liveChannelStore.refresh();
    expect(liveChannelStore.channel('space-1')?.messages[0]?.reactions ?? []).toEqual([]);
  });

  it('retains a confirmed reply until an authoritative snapshot replaces it', async () => {
    liveChannelStore.acquire();
    await vi.waitFor(() => expect(liveChannelStore.status()).toBe('ready'));
    liveChannelStore.acceptConfirmedReply('space-1', { id: 'reply-1', thread_id: 'thread-1', author_id: 'member-a',
      body: 'Confirmed reply', author_name: 'Worker A', author_initials: 'MA', author_role: null,
      created_at: '2026-08-20T12:01:00.000Z', parent_post_id: 'post-1' });
    expect(liveChannelStore.channel('space-1')?.messages.map((message) => message.id)).toEqual(['post-1', 'reply-1']);
    liveChannelStore.resetForSession();
    await vi.waitFor(() => expect(liveChannelStore.status()).toBe('ready'));
    expect(liveChannelStore.channel('space-1')?.messages.map((message) => message.id)).toEqual(['post-1']);
  });

  it('purges and reloads authorized rows when auth replaces one user with another', async () => {
    liveChannelStore.acquire();
    await vi.waitFor(() => expect(liveChannelStore.status()).toBe('ready'));
    expect(liveChannelStore.channel('space-1')?.messages[0]?.body).toBe('Private campaign update');

    liveChannelStore.resetForSession();

    expect(liveChannelStore.channels()).toEqual([]);
    await vi.waitFor(() => expect(liveChannelStore.status()).toBe('ready'));
    expect(backend.client.removeChannel).toHaveBeenCalled();
  });

  it('keeps loading, authorization failures, and missing channels distinct', async () => {
    const module = liveChannelsModule as unknown as Record<string, unknown>;
    expect(typeof module.resolveChannelRoute).toBe('function');
    const resolve = module.resolveChannelRoute as (
      state: { status(): string; error(): string | null; channel(id: string): unknown },
      id: string,
    ) => { kind: string; message?: string };
    const channel = { id: 'space-1' };

    expect(resolve({ status: () => 'loading', error: () => null, channel: () => null }, 'space-1')).toEqual({ kind: 'loading' });
    expect(resolve({ status: () => 'error', error: () => 'Access denied', channel: () => null }, 'space-1')).toEqual({ kind: 'error', message: 'Access denied' });
    expect(resolve({ status: () => 'ready', error: () => null, channel: () => null }, 'missing')).toEqual({ kind: 'missing' });
    expect(resolve({ status: () => 'ready', error: () => null, channel: () => channel }, 'space-1')).toEqual({ kind: 'ready', channel });
  });

  it('subscribes to the insert-only realtime stream on chapter_thread_posts', () => {
    expect(live).toContain("event: 'INSERT'");
    expect(live).toContain("table: 'chapter_thread_posts'");
    expect(live).not.toContain("meeting: 'UPDATE'");
    expect(live).not.toContain("meeting: '*'");
  });

  // BUG-UG-MESSAGE-REACTION-PARITY-20260904: this file used to declare its
  // own kind→emoji map, which is how the phone could offer a different set than
  // the browser or the database. The map is now the shared contract's, and the
  // store must not reintroduce a local one.
  it('takes the reaction kinds from the shared contract instead of a local map', () => {
    expect(live).toContain("from '../lib/messagingShared'");
    expect(live).toContain('REACTION_KIND_EMOJI: Record<string, string> = MESSAGE_REACTION_GLYPHS');
    expect(live).not.toContain('EMOJI_REACTION_KIND');
    expect(live).not.toMatch(/like: '\S+',/);
  });

  it('exposes exactly the database-bounded reaction kinds', () => {
    expect(Object.keys(REACTION_KIND_EMOJI).sort())
      .toEqual([...MESSAGE_REACTION_KINDS].sort());
    for (const kind of MESSAGE_REACTION_KINDS) {
      expect(REACTION_KIND_EMOJI[kind], kind).toBeTruthy();
    }
  });

  it('toggles by contract kind, so an unmapped value never reaches the RPC', () => {
    expect(live).toContain('toggleReaction(writer: MobileSessionWriter, channelID: string, messageID: string, kind: string)');
    expect(live).toContain('isMessageReactionKind(kind)');
    expect(live).toContain("p_reaction: kind");
  });

  it('lets the server own author identity on send', () => {
    // Every insert payload in the store is read on its own: the post payload
    // carries only thread_id and body, and no payload may name an author
    // column (reads of author_name in select projections are fine).
    // REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001 adds only the structured
    // mention list, which the database sanitizes; still no author column.
    expect(live).toContain('.insert({ thread_id: target, body: clean, ...(mentionIDs.length > 0 ? { mentioned_user_ids: [...mentionIDs] } : {}) })');
    const payloads = insertPayloads(live);
    expect(payloads).toContain('{ thread_id: target, body: clean, ...(mentionIDs.length > 0 ? { mentioned_user_ids: [...mentionIDs] } : {}) }');
    for (const payload of payloads) {
      // A payload assembled elsewhere cannot be read here, so inserts must
      // stay inline literals for this guard to mean anything.
      expect(payload, payload).toMatch(/^[{[]/);
      expect(payload, payload).not.toMatch(/author/);
    }
  });

  // TEST-UG-MOBILE-LIVE-CHANNELS-INSERT-AUTHOR-GUARD-ESCAPE-20260920: the
  // guard above used to be one whole-file scan whose character class stopped
  // at the first ')', so a payload with a call, a leading space or a row array
  // before its author column slipped past. The per-payload reader sees them.
  it('reads author columns from each insert payload whatever it carries', () => {
    const escapes = [
      '.insert({ thread_id: target, body: sanitize(clean), author_id: me })',
      '.insert( { thread_id: target, author_name: displayName } )',
      ".insert([{ thread_id: target, body: clean }, { thread_id: other, author_role: 'committee member' }])",
    ];
    for (const source of escapes) {
      expect(insertPayloads(source).join('\n'), source).toMatch(/author/);
    }
    // Author columns in a read projection are not an insert payload, and each
    // call site is read on its own rather than as one run of the file.
    expect(insertPayloads(".select('id,author_name').insert({ body: clean }).select('author_role')"))
      .toEqual(['{ body: clean }']);
    expect(insertPayloads('.insert({ a: 1 })\n.insert({ b: 2 })')).toEqual(['{ a: 1 }', '{ b: 2 }']);
  });

  it('returns channel-send success to the composer and keeps backend errors private', () => {
    const channelScreen = readFileSync(fileURLToPath(new URL('../../app/channel/[id].tsx', import.meta.url)), 'utf8');
    expect(live).toContain('async send(');
    expect(live).not.toContain("loadError = 'Your message could not be sent securely. Try again.'");
    expect(live).toContain("op: 'send'");
    expect(channelScreen).toContain('const sent = await store.send');
    expect(channelScreen).toContain("if (sent) setDraft('')");
    expect(channelScreen).toContain('sendError ?');
  });

  it('does not issue redundant read RPCs or retain zero-count reactions', () => {
    expect(live).toContain('if (!channel || channel.unread === 0) return');
    expect(live).toContain('if (count) current.reactions.push');
    expect(live).toContain('Math.max(0, (reaction?.count ?? 0)');
  });

  it('loads only a bounded recent channel window and restores chronological display order', () => {
    expect(live).toContain(".order('created_at', { ascending: false })");
    expect(live).toContain(".order('id', { ascending: false })");
    expect(live).toContain('chapter_threads!inner');
    expect(live).toContain(".is('chapter_threads.chapter_spaces.archived_at', null)");
    expect(live).toContain('.limit(MAX_CHANNEL_POSTS)');
    expect(live).toContain('.slice(0, MAX_CHANNEL_POSTS).reverse()');
  });

  it('keeps SAMPLE-only summaries and locked staff channels away from the worker view', () => {
    const messages = readFileSync(fileURLToPath(new URL('../../app/messages.tsx', import.meta.url)), 'utf8');
    expect(messages).toContain('() => buildMessageInbox(conversations, channels, copy, locale, pinningOn, peerConversations.items)');
    // The store updates a row's unread count in place, so the inbox takes a
    // fresh (filtered) array each render rather than the store's own; the
    // preview worker never sees a locked staff channel.
    expect(messages).toContain("const channels = store.channels().filter((channel) => mode !== 'preview' || previewHat !== 'member' || !channel.locked);");
  });

  it('uses classified channel load copy instead of displaying raw backend errors', () => {
    expect(live).toContain('classifyChannelLoadError(error)');
    expect(live).toContain("op: 'load'");
    expect(live).toContain("op: 'poll-tally'");
    expect(live).toContain("op: 'mark_read'");
    expect(live).not.toContain('.then(() => load(), () => load())');
    expect(live).not.toContain('error instanceof Error ? error.message');
    expect(live).toContain('} catch (error) {');
  });

  it('swaps stores by mode with a ref-counted lifecycle', () => {
    expect(hook).toContain("mode === 'authenticated'");
    expect(hook).toContain('liveChannelStore.acquire()');
    expect(hook).toContain('liveChannelStore.release()');
    const channelScreen = readFileSync(fileURLToPath(new URL('../../app/channel/[id].tsx', import.meta.url)), 'utf8');
    const messages = readFileSync(fileURLToPath(new URL('../../app/messages.tsx', import.meta.url)), 'utf8');
    for (const source of [channelScreen, messages]) {
      expect(source).toContain('useChannelStore');
      expect(source).not.toMatch(/channelStore\./);
    }
    expect(messages).toContain('store.refresh()');
  });
});

describe('live chapter-channel load classification', () => {
  async function loadUntilSettled() {
    liveChannelStore.acquire();
    await vi.waitFor(() => expect(liveChannelStore.status()).not.toBe('loading'));
    await vi.waitFor(() => expect(liveChannelStore.status()).not.toBe('idle'));
  }

  it('treats an authorized empty chapter-space read as ready, not a load failure', async () => {
    backend.rows.chapter_spaces = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadUntilSettled();
    expect(liveChannelStore.status()).toBe('ready');
    expect(liveChannelStore.error()).toBeNull();
    expect(liveChannelStore.loadFault()).toBeNull();
    expect(liveChannelStore.channels()).toEqual([]);
    expect(readLastChannelLoadDiagnosis()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats a row-level-security denial as an authorized empty result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    backend.tableErrors.chapter_spaces = { code: '42501', status: 403 };
    await loadUntilSettled();
    expect(liveChannelStore.status()).toBe('ready');
    expect(liveChannelStore.error()).toBeNull();
    expect(liveChannelStore.loadFault()).toBeNull();
    expect(liveChannelStore.channels()).toEqual([]);
    expect(readLastChannelLoadDiagnosis()).toEqual({ class: 'authorized-empty', op: 'load' });
    expect(warn).toHaveBeenCalledWith(`${CHANNEL_LOAD_LOG_TAG} class=authorized-empty op=load`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('42501');
  });

  // BUG-UG-MOBILE-CHANNEL-CODELESS-403-READS-AS-AUTHORIZED-EMPTY-20260918:
  // a gateway 403 with no PostgREST code used to paint an empty channel list
  // with status ready and no notice. That masked a refusal as an authorized
  // empty inbox.
  it('does not treat a codeless 403 as an authorized empty channel list', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    warn.mockClear();
    backend.tableErrors.chapter_spaces = {
      data: null,
      error: { message: 'Forbidden' },
      status: 403,
      statusText: 'Forbidden',
    };
    await loadUntilSettled();
    expect(liveChannelStore.status()).not.toBe('ready');
    expect(liveChannelStore.status()).toBe('error');
    expect(liveChannelStore.loadFault()).toBe('request');
    expect(liveChannelStore.error()).toBe(messageInboxCopy.en.channelError.request);
    expect(liveChannelStore.error()).not.toBeNull();
    expect(liveChannelStore.channels()).toEqual([]);
    expect(readLastChannelLoadDiagnosis()).toEqual({ class: 'request', op: 'load' });
    expect(warn).toHaveBeenCalledWith(`${CHANNEL_LOAD_LOG_TAG} class=request op=load`);
    expect(warn).not.toHaveBeenCalledWith(`${CHANNEL_LOAD_LOG_TAG} class=authorized-empty op=load`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Forbidden');
  });

  it('classifies a missing relation as a schema fault with distinct copy', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    backend.tableErrors.chapter_spaces = { code: '42P01', message: 'relation chapter_spaces does not exist' };
    await loadUntilSettled();
    expect(liveChannelStore.status()).toBe('error');
    expect(liveChannelStore.loadFault()).toBe('schema');
    expect(liveChannelStore.error()).toBe(messageInboxCopy.en.channelError.schema);
    expect(liveChannelStore.error()).not.toBe(messageInboxCopy.en.channelError.transport);
    expect(liveChannelStore.error()).not.toContain('relation chapter_spaces');
    expect(readLastChannelLoadDiagnosis()).toEqual({ class: 'schema', op: 'load' });
    expect(warn).toHaveBeenCalledWith(`${CHANNEL_LOAD_LOG_TAG} class=schema op=load`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('chapter_spaces');
  });

  it('classifies a PostgREST missing-column answer as a schema fault', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    backend.tableErrors.chapter_threads = { code: 'PGRST204' };
    await loadUntilSettled();
    expect(liveChannelStore.status()).toBe('error');
    expect(liveChannelStore.loadFault()).toBe('schema');
    expect(readLastChannelLoadDiagnosis()).toEqual({ class: 'schema', op: 'load' });
  });

  it('classifies AbortError and 5xx as transport faults', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    backend.tableErrors.chapter_spaces = { name: 'AbortError' };
    await loadUntilSettled();
    expect(liveChannelStore.loadFault()).toBe('transport');
    expect(liveChannelStore.error()).toBe(messageInboxCopy.en.channelError.transport);
    expect(readLastChannelLoadDiagnosis()).toEqual({ class: 'transport', op: 'load' });

    liveChannelStore.release();
    backend.reset();
    backend.tableErrors.chapter_space_reads = { status: 503 };
    await loadUntilSettled();
    expect(liveChannelStore.loadFault()).toBe('transport');
  });

  it('classifies an uncoded failure as unknown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    backend.tableErrors.chapter_spaces = { message: 'unexpected worker abort' };
    await loadUntilSettled();
    expect(liveChannelStore.status()).toBe('error');
    expect(liveChannelStore.loadFault()).toBe('unknown');
    expect(liveChannelStore.error()).toBe(messageInboxCopy.en.channelError.unknown);
    expect(liveChannelStore.error()).not.toContain('unexpected worker abort');
    expect(readLastChannelLoadDiagnosis()).toEqual({ class: 'unknown', op: 'load' });
  });

  it('classifies an unreachable PostgREST response as transport from response-level status', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    backend.tableErrors.chapter_spaces = { data: null, error: { code: '' }, status: 0 };
    await loadUntilSettled();
    expect(liveChannelStore.status()).toBe('error');
    expect(liveChannelStore.loadFault()).toBe('transport');
    expect(liveChannelStore.error()).toBe(messageInboxCopy.en.channelError.transport);
    expect(readLastChannelLoadDiagnosis()).toEqual({ class: 'transport', op: 'load' });
  });

  it('classifies an expired JWT as an authentication fault instead of authorized empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    backend.tableErrors.chapter_spaces = { code: 'PGRST301', status: 401 };
    await loadUntilSettled();
    expect(liveChannelStore.status()).toBe('error');
    expect(liveChannelStore.loadFault()).toBe('authentication');
    expect(liveChannelStore.error()).toBe(messageInboxCopy.en.channelError.authentication);
    expect(liveChannelStore.channels()).toEqual([]);
    expect(readLastChannelLoadDiagnosis()).toEqual({ class: 'authentication', op: 'load' });
    expect(warn).toHaveBeenCalledWith(`${CHANNEL_LOAD_LOG_TAG} class=authentication op=load`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PGRST301');
  });

  it('surfaces a failed poll tally as per-channel poll unavailable without failing the load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    backend.rows.chapter_channel_polls = [{
      id: 'poll-1',
      space_id: 'space-1',
      post_id: 'post-1',
      question: 'Which night?',
      closes_at: null,
      created_at: '2026-08-20T12:00:00.000Z',
    }];
    backend.setRpc({ data: null, error: { code: 'PGRST202', message: 'function missing' } });
    await loadUntilSettled();
    expect(liveChannelStore.status()).toBe('ready');
    expect(liveChannelStore.error()).toBeNull();
    expect(liveChannelStore.channel('space-1')?.pollUnavailable).toBe(true);
    expect(liveChannelStore.channel('space-1')?.messages[0]?.poll).toBe(true);
    expect(liveChannelStore.poll()).toBeNull();
    expect(readLastChannelLoadDiagnosis()).toEqual({ class: 'schema', op: 'poll-tally' });
    expect(warn).toHaveBeenCalledWith(`${CHANNEL_LOAD_LOG_TAG} class=schema op=poll-tally`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('function missing');
    const channelScreen = readFileSync(fileURLToPath(new URL('../../app/channel/[id].tsx', import.meta.url)), 'utf8');
    expect(channelScreen).toContain('copy.pollUnavailable');
    expect(channelScreen).toContain('message.poll ? (');
  });

  it('records a poll-tally diagnosis only after the load sequence wins', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    backend.rows.chapter_channel_polls = [{
      id: 'poll-1',
      space_id: 'space-1',
      post_id: 'post-1',
      question: 'Which night?',
      closes_at: null,
      created_at: '2026-08-20T12:00:00.000Z',
    }];
    let settleStale: ((value: { data: null; error: { code: string } }) => void) | undefined;
    const staleRpc = new Promise<{ data: null; error: { code: string } }>((resolve) => { settleStale = resolve; });
    backend.client.rpc.mockImplementationOnce(() => staleRpc);

    liveChannelStore.acquire();
    await vi.waitFor(() => expect(backend.client.rpc).toHaveBeenCalledTimes(1));

    liveChannelStore.resetForSession();
    await vi.waitFor(() => expect(liveChannelStore.status()).toBe('ready'));
    expect(readLastChannelLoadDiagnosis()).toBeNull();
    expect(liveChannelStore.channel('space-1')?.pollUnavailable).toBeUndefined();

    warn.mockClear();
    settleStale?.({ data: null, error: { code: 'PGRST202' } });
    await staleRpc;
    await Promise.resolve();
    expect(readLastChannelLoadDiagnosis()).toBeNull();
    expect(liveChannelStore.channel('space-1')?.pollUnavailable).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  // BUG-UG-MOBILE-CHAPTER-CHANNELS-CLASS-UNKNOWN-ON-DEVICE-20260918: the
  // seeded SAMPLE chapter answers 700 posts, whose identifiers alone build a
  // 26 KB request line; the workspace gateway refused it with a plain-text 400
  // and the whole surface failed on both phones. No single request may carry
  // an unbounded identifier list again.
  it('reads campaign history in bounded identifier batches so no request line can be refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    backend.rows.chapter_thread_posts = Array.from({ length: 250 }, (_unused, index) => ({
      id: `post-${String(index).padStart(3, '0')}`,
      thread_id: 'thread-1',
      author_id: 'member-a',
      body: `Campaign update ${index}`,
      author_name: 'Worker A',
      author_initials: 'MA',
      author_role: null,
      created_at: new Date(Date.UTC(2026, 7, 20, 12, 0, index)).toISOString(),
    }));
    await loadUntilSettled();

    expect(liveChannelStore.status()).toBe('ready');
    expect(liveChannelStore.loadFault()).toBeNull();
    expect(liveChannelStore.channel('space-1')?.messages).toHaveLength(250);
    expect(liveChannelStore.channel('space-1')?.messages[0]?.id).toBe('post-000');
    expect(liveChannelStore.channel('space-1')?.messages.at(-1)?.id).toBe('post-249');

    const batched = backend.identifierFilters.filter((filter) => filter.table === 'member_message_reactions');
    expect(batched).toHaveLength(3);
    for (const filter of backend.identifierFilters) {
      expect(filter.count, `${filter.table}.${filter.column}`).toBeLessThanOrEqual(100);
    }
    expect(readLastChannelLoadDiagnosis()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  // PERF-UG-MOBILE-CHANNEL-POSTS-LIMIT-APPLIED-PER-BATCH-20260918: 900 of
  // the newest 1000 posts sit in the first 100-thread identifier batch and the
  // remaining 100 newest sit in later batches, with extra older posts behind
  // them. A per-batch limit would download more than MAX_CHANNEL_POSTS (and a
  // smaller per-batch cap would drop newer posts from the busy batch). The
  // assembled ids must equal the global newest-1000 set, and the rows read
  // must not grow with the number of thread batches.
  it('assembles the global newest post window without multiplying the download by thread batches', async () => {
    const threadCount = 250;
    const newestInFirstBatch = 900;
    const newestInLaterBatches = 100;
    const olderInSecondBatch = 900;
    const olderInThirdBatch = 200;
    const iso = (tick: number) => new Date(Date.UTC(2026, 8, 1, 0, 0, 0) + tick * 1000).toISOString();
    const threadId = (index: number) => `thread-${String(index).padStart(3, '0')}`;
    const post = (id: string, threadIndex: number, tick: number) => ({
      id,
      thread_id: threadId(threadIndex),
      author_id: 'member-a',
      body: `Campaign update ${id}`,
      author_name: 'Worker A',
      author_initials: 'MA',
      author_role: null,
      created_at: iso(tick),
    });

    backend.rows.chapter_threads = Array.from({ length: threadCount }, (_unused, index) => ({
      id: threadId(index),
      space_id: 'space-1',
      created_at: iso(index),
    }));

    let tick = 100_000;
    const newestIds: string[] = [];
    const posts: ReturnType<typeof post>[] = [];
    for (let index = 0; index < newestInFirstBatch; index += 1) {
      const id = `post-first-${index}`;
      newestIds.push(id);
      posts.push(post(id, index % 100, tick));
      tick -= 1;
    }
    for (let index = 0; index < newestInLaterBatches; index += 1) {
      const id = `post-later-${index}`;
      newestIds.push(id);
      posts.push(post(id, 100 + (index % 150), tick));
      tick -= 1;
    }
    for (let index = 0; index < olderInSecondBatch; index += 1) {
      posts.push(post(`post-old-second-${index}`, 100 + (index % 100), tick));
      tick -= 1;
    }
    for (let index = 0; index < olderInThirdBatch; index += 1) {
      posts.push(post(`post-old-third-${index}`, 200 + (index % 50), tick));
      tick -= 1;
    }
    backend.rows.chapter_thread_posts = posts;

    await loadUntilSettled();

    // One row per thread: the window is the union of every thread row's
    // messages, restored to chronological order.
    const assembled = liveChannelStore.channels()
      .flatMap((channel) => channel.messages)
      .sort((left, right) => (left.createdAt ?? '').localeCompare(right.createdAt ?? ''))
      .map((message) => message.id);
    expect(assembled).toEqual(newestIds.slice().reverse());
    expect(assembled).toHaveLength(newestInFirstBatch + newestInLaterBatches);
    expect(new Set(assembled)).toEqual(new Set(newestIds));

    const postReads = backend.rowReads.filter((read) => read.table === 'chapter_thread_posts');
    const downloaded = postReads.reduce((sum, read) => sum + read.count, 0);
    expect(postReads).toHaveLength(1);
    expect(downloaded).toBe(1000);
    expect(backend.identifierFilters.filter((filter) => filter.table === 'chapter_thread_posts')).toEqual([]);

    liveChannelStore.release();
    backend.reset();
    backend.rows.chapter_threads = Array.from({ length: 101 }, (_unused, index) => ({
      id: threadId(index),
      space_id: 'space-1',
      created_at: iso(index),
    }));
    // Same bodies, remapped onto the 101 loaded threads so the scoped
    // newest-1000 window still fills. An unscoped reload would also stay
    // at 1000; the assertion is that two thread batches do not download
    // more than three did.
    backend.rows.chapter_thread_posts = posts.map((entry, index) => ({
      ...entry,
      thread_id: threadId(index % 101),
    }));
    await loadUntilSettled();
    const secondReads = backend.rowReads.filter((read) => read.table === 'chapter_thread_posts');
    const secondDownloaded = secondReads.reduce((sum, read) => sum + read.count, 0);
    expect(secondReads).toHaveLength(1);
    expect(secondDownloaded).toBe(downloaded);
  });

  // HIGH (reviewer counter-example): archived-space posts are RLS-readable
  // and occupy an unscoped newest-1000 window, so the loaded channel can
  // keep zero of its own history. The retained set must equal the newest
  // 1000 posts of the scoped (non-archived) threads.
  it('keeps the newest posts of loaded threads when newer archived-space posts fill the cap', async () => {
    const iso = (tick: number) => new Date(Date.UTC(2026, 8, 1, 0, 0, 0) + tick * 1000).toISOString();
    const post = (id: string, threadId: string, tick: number) => ({
      id,
      thread_id: threadId,
      author_id: 'member-a',
      body: `Campaign update ${id}`,
      author_name: 'Worker A',
      author_initials: 'MA',
      author_role: null,
      created_at: iso(tick),
    });
    backend.rows.chapter_spaces = [
      { id: 'space-1', name: 'general', description: 'Campaign updates', visibility: 'chapter' },
      {
        id: 'space-archived',
        name: 'archived',
        description: 'Former channel',
        visibility: 'chapter',
        archived_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    backend.rows.chapter_threads = [
      { id: 'thread-1', space_id: 'space-1', created_at: iso(0) },
      { id: 'thread-archived', space_id: 'space-archived', created_at: iso(1) },
    ];
    const loadedIds: string[] = [];
    const posts: ReturnType<typeof post>[] = [];
    for (let index = 0; index < 1000; index += 1) {
      posts.push(post(`post-archived-${String(index).padStart(4, '0')}`, 'thread-archived', 10_000 - index));
    }
    for (let index = 0; index < 1000; index += 1) {
      const id = `post-loaded-${String(index).padStart(4, '0')}`;
      loadedIds.push(id);
      posts.push(post(id, 'thread-1', 1_000 - index));
    }
    backend.rows.chapter_thread_posts = posts;

    await loadUntilSettled();

    expect(liveChannelStore.status()).toBe('ready');
    expect(liveChannelStore.channels().map((channel) => channel.id)).toEqual(['thread-1']);
    const assembled = liveChannelStore.channel('space-1')?.messages.map((message) => message.id) ?? [];
    expect(assembled).toEqual(loadedIds.slice().reverse());
    expect(assembled).toHaveLength(1000);
    expect(assembled.some((id) => id.startsWith('post-archived-'))).toBe(false);
    const postReads = backend.rowReads.filter((read) => read.table === 'chapter_thread_posts');
    expect(postReads).toHaveLength(1);
    expect(postReads.reduce((sum, read) => sum + read.count, 0)).toBe(1000);
    expect(backend.identifierFilters.filter((filter) => filter.table === 'chapter_thread_posts')).toEqual([]);
  });

  // MEDIUM (reviewer counter-example): 1001 known-thread posts share one
  // timestamp. Ordering only by created_at lets the database keep post-0000
  // and drop post-1000, opposite the (created_at, id) tie-break.
  it('applies the id tie-break in the query so equal timestamps at the cap are deterministic', async () => {
    const sameTime = '2026-09-01T12:00:00.000Z';
    backend.rows.chapter_thread_posts = Array.from({ length: 1001 }, (_unused, index) => ({
      id: `post-${String(index).padStart(4, '0')}`,
      thread_id: 'thread-1',
      author_id: 'member-a',
      body: `Campaign update ${index}`,
      author_name: 'Worker A',
      author_initials: 'MA',
      author_role: null,
      created_at: sameTime,
    }));

    await loadUntilSettled();

    const assembled = liveChannelStore.channel('space-1')?.messages.map((message) => message.id) ?? [];
    expect(assembled).toHaveLength(1000);
    expect(assembled).not.toContain('post-0000');
    expect(assembled[0]).toBe('post-0001');
    expect(assembled.at(-1)).toBe('post-1000');
    expect(assembled).toEqual(
      Array.from({ length: 1000 }, (_unused, index) => `post-${String(index + 1).padStart(4, '0')}`),
    );
  });

  // The merged batches are ordered by byte comparison, not by collation: ICU
  // ranks '.' after '+', so a whole-second timestamp compared against a
  // sub-second one through localeCompare answers "later" and the channel reads
  // in a locale-dependent order.
  it('orders a sub-second post after the whole-second post it follows', async () => {
    const post = (id: string, createdAt: string) => ({
      id,
      thread_id: 'thread-1',
      author_id: 'member-a',
      body: `Campaign update ${id}`,
      author_name: 'Worker A',
      author_initials: 'MA',
      author_role: null,
      created_at: createdAt,
    });
    backend.rows.chapter_thread_posts = [
      post('post-sub-second', '2026-08-20T12:00:23.500+00:00'),
      post('post-whole-second', '2026-08-20T12:00:23+00:00'),
      post('post-next-minute', '2026-08-20T12:01:00+00:00'),
    ];
    await loadUntilSettled();

    expect(liveChannelStore.status()).toBe('ready');
    expect(liveChannelStore.channel('space-1')?.messages.map((message) => message.id))
      .toEqual(['post-whole-second', 'post-sub-second', 'post-next-minute']);
  });

  // The exact answer both phones met at 7afda61a6: a status with a plain-text
  // body the gateway produced ahead of PostgREST, so no PostgREST code exists.
  it('names a codeless refusal of the load request instead of the catch-all class', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    backend.tableErrors.member_message_reactions = {
      data: null,
      error: { message: 'Bad Request' },
      status: 400,
      statusText: 'Bad Request',
    };
    await loadUntilSettled();

    expect(liveChannelStore.status()).toBe('error');
    expect(liveChannelStore.loadFault()).toBe('request');
    expect(liveChannelStore.error()).toBe(messageInboxCopy.en.channelError.request);
    expect(liveChannelStore.error()).not.toBe(messageInboxCopy.en.channelError.unknown);
    expect(readLastChannelLoadDiagnosis()).toEqual({ class: 'request', op: 'load' });
    expect(warn).toHaveBeenCalledWith(`${CHANNEL_LOAD_LOG_TAG} class=request op=load`);
    expect(warn).not.toHaveBeenCalledWith(`${CHANNEL_LOAD_LOG_TAG} class=unknown op=load`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Bad Request');
  });

  it('does not treat a send failure as a chapter-channel load fault', async () => {
    await loadUntilSettled();
    expect(liveChannelStore.status()).toBe('ready');
    expect(liveChannelStore.loadFault()).toBeNull();
    const sent = await liveChannelStore.send(testWriter, 'space-1', 'hello', 'Worker A', 'MA');
    expect(sent).toBe(false);
    expect(liveChannelStore.error()).toBeNull();
    expect(liveChannelStore.loadFault()).toBeNull();
    expect(liveChannelStore.status()).toBe('ready');
    expect(inboxChannelLoadNotice(messageInboxCopy.en, liveChannelStore.loadFault(), liveChannelStore.status() === 'error')).toBeNull();
    expect(inboxChannelLoadNotice(messageInboxCopy.es, liveChannelStore.loadFault(), liveChannelStore.status() === 'error')).toBeNull();
  });

  it('retains an authoritative read refusal through transport failure, until fresh access succeeds', async () => {
    await loadUntilSettled();
    expect(liveChannelStore.readRefused()).toBe(false);
    backend.tableErrors.chapter_spaces = { data: null, error: { code: 'PGRST303' }, status: 400 };
    await liveChannelStore.refresh();
    expect(liveChannelStore.readRefused()).toBe(true);
    expect(liveChannelStore.loadFault()).toBe('schema');
    backend.tableErrors.chapter_spaces = { data: null, error: { name: 'TypeError' }, status: 0 };
    await liveChannelStore.refresh();
    expect(liveChannelStore.readRefused()).toBe(true);
    expect(liveChannelStore.loadFault()).toBe('transport');
    delete backend.tableErrors.chapter_spaces;
    await liveChannelStore.refresh();
    expect(liveChannelStore.readRefused()).toBe(false);
    expect(liveChannelStore.loadFault()).toBeNull();
  });
});

describe('inbox notice vs authorized empty campaign channels', () => {
  it('does not render a failure notice for an authorized worker with no channels', () => {
    const messages = readFileSync(fileURLToPath(new URL('../../app/messages.tsx', import.meta.url)), 'utf8');
    expect(messages).toContain('inboxChannelLoadNotice(copy, store.loadFault(), store.status() === \'error\')');
    expect(messages).toContain('{channelsError ? <Notice>{channelsError}</Notice> : null}');
    expect(messages).toContain('copy.noMessagesBody');
    expect(messages).toContain('copy.caughtUpTitle');
    expect(messages).not.toContain('?? store.error()');
    expect(messages).not.toContain('{channelsError ? <Notice>{copy.channelError}</Notice> : null}');
    expect(channelLoadFailureNotice(messageInboxCopy.en, 'authorized-empty')).toBeNull();
    expect(channelLoadFailureNotice(messageInboxCopy.en, null)).toBeNull();
    expect(channelLoadFailureNotice(messageInboxCopy.es, 'schema')).toBe(messageInboxCopy.es.channelError.schema);
    expect(channelLoadFailureNotice(messageInboxCopy.en, 'transport')).toBe(messageInboxCopy.en.channelError.transport);
    expect(channelLoadFailureNotice(messageInboxCopy.en, 'unknown')).toBe(messageInboxCopy.en.channelError.unknown);
    expect(channelLoadFailureNotice(messageInboxCopy.en, 'authentication')).toBe(messageInboxCopy.en.channelError.authentication);
    expect(channelLoadFailureNotice(messageInboxCopy.es, 'authentication')).toBe(messageInboxCopy.es.channelError.authentication);
    expect(messageInboxCopy.en.channelError.schema).not.toBe(messageInboxCopy.en.channelError.transport);
    expect(messageInboxCopy.es.channelError.schema).not.toBe(messageInboxCopy.es.channelError.unknown);
    expect(messageInboxCopy.en.channelError.authentication).not.toBe(messageInboxCopy.en.channelError.unknown);
    expect(messageInboxCopy.en.markReadError).toContain('could not be marked read');
    expect(messageInboxCopy.es.markReadError).toContain('marcar este canal como leído');
  });
});

describe('markRead read-cursor write', () => {
  async function loadUntilReady() {
    liveChannelStore.acquire();
    await vi.waitFor(() => expect(liveChannelStore.status()).toBe('ready'));
    expect(liveChannelStore.channel('space-1')?.unread).toBeGreaterThan(0);
  }

  it('records a diagnosis when the read cursor write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadUntilReady();
    const fromCalls = backend.client.from.mock.calls.length;
    const unread = liveChannelStore.channel('space-1')!.unread;

    backend.throwRpc({ name: 'AbortError' });
    liveChannelStore.markRead(testWriter, 'space-1');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.diagnosis()).not.toBeNull());

    expect(liveChannelStore.diagnosis()).toEqual({ class: 'transport', op: 'mark_read', spaceId: 'space-1' });
    expect(liveChannelStore.markReadFault('space-1')).toEqual({ class: 'transport', op: 'mark_read', spaceId: 'space-1' });
    expect(liveChannelStore.error()).toBe(messageInboxCopy.en.markReadError);
    expect(liveChannelStore.channel('space-1')?.unread).toBe(unread);
    expect(liveChannelStore.status()).toBe('ready');
    expect(liveChannelStore.loadFault()).toBeNull();
    expect(backend.client.from.mock.calls.length).toBe(fromCalls);
    expect(warn).toHaveBeenCalledWith(`${CHANNEL_LOAD_LOG_TAG} class=transport op=mark_read`);

    liveChannelStore.release();
    backend.reset();
    resetChannelLoadDiagnosis();
    await loadUntilReady();
    const secondFromCalls = backend.client.from.mock.calls.length;
    backend.setRpc({ data: null, error: { code: 'PGRST202', message: 'function missing' } });
    liveChannelStore.markRead(testWriter, 'space-1');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.diagnosis()?.op).toBe('mark_read'));

    expect(liveChannelStore.diagnosis()).toEqual({ class: 'schema', op: 'mark_read', spaceId: 'space-1' });
    expect(liveChannelStore.error()).toBe(messageInboxCopy.en.markReadError);
    expect(liveChannelStore.channel('space-1')?.unread).toBeGreaterThan(0);
    expect(backend.client.from.mock.calls.length).toBe(secondFromCalls);
    expect(warn).toHaveBeenCalledWith(`${CHANNEL_LOAD_LOG_TAG} class=schema op=mark_read`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('function missing');
    const channelScreen = readFileSync(fileURLToPath(new URL('../../app/channel/[id].tsx', import.meta.url)), 'utf8');
    expect(channelScreen).toContain('store.markReadFault(channel.id)');
    expect(channelScreen).toContain('copy.markReadError');
    expect(channelScreen).toMatch(/Platform\.OS === 'ios'\) \{\s*announceForAccessibility\(copy\.markReadError\);/);
  });

  it('classifies the RPC 42501 denial as authentication and keeps the space id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadUntilReady();
    backend.setRpc({ data: null, error: { code: '42501', message: 'authentication required' } });
    liveChannelStore.markRead(testWriter, 'space-1');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.diagnosis()?.op).toBe('mark_read'));
    expect(liveChannelStore.diagnosis()).toEqual({ class: 'authentication', op: 'mark_read', spaceId: 'space-1' });
    expect(liveChannelStore.error()).toBe(messageInboxCopy.en.markReadError);
    expect(warn).toHaveBeenCalledWith(`${CHANNEL_LOAD_LOG_TAG} class=authentication op=mark_read`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('authentication required');
  });

  it('applies mark-read success after an unrelated loadSequence bump', async () => {
    await loadUntilReady();
    const unread = liveChannelStore.channel('space-1')!.unread;
    let settleMarkRead: ((value: { data: unknown; error: unknown }) => void) | undefined;
    const pending = new Promise<{ data: unknown; error: unknown }>((resolve) => { settleMarkRead = resolve; });
    backend.client.rpc.mockImplementationOnce(() => pending);

    liveChannelStore.markRead(testWriter, 'space-1');
    await Promise.resolve();
    liveChannelStore.acceptConfirmedActions('space-1', 'post-1', []);
    expect(liveChannelStore.channel('space-1')?.unread).toBe(unread);

    settleMarkRead?.({ data: null, error: null });
    await pending;
    await vi.waitFor(() => expect(liveChannelStore.channel('space-1')?.unread).toBe(0));
    expect(liveChannelStore.diagnosis()).toBeNull();
  });

  it('records a mark-read failure after an unrelated refresh', async () => {
    await loadUntilReady();
    const unread = liveChannelStore.channel('space-1')!.unread;
    let settleMarkRead: ((value: { data: unknown; error: unknown }) => void) | undefined;
    const pending = new Promise<{ data: unknown; error: unknown }>((resolve) => { settleMarkRead = resolve; });
    backend.client.rpc.mockImplementationOnce(() => pending);

    liveChannelStore.markRead(testWriter, 'space-1');
    await Promise.resolve();
    await liveChannelStore.refresh();
    expect(liveChannelStore.channel('space-1')?.unread).toBe(unread);

    settleMarkRead?.({ data: null, error: { name: 'AbortError' } });
    await pending;
    await vi.waitFor(() => expect(liveChannelStore.diagnosis()?.op).toBe('mark_read'));
    expect(liveChannelStore.diagnosis()).toEqual({ class: 'transport', op: 'mark_read', spaceId: 'space-1' });
    expect(liveChannelStore.channel('space-1')?.unread).toBe(unread);
  });

  it('does not apply a mark-read result after the session cache is cleared', async () => {
    await loadUntilReady();
    let settleMarkRead: ((value: { data: unknown; error: unknown }) => void) | undefined;
    const pending = new Promise<{ data: unknown; error: unknown }>((resolve) => { settleMarkRead = resolve; });
    backend.client.rpc.mockImplementationOnce(() => pending);

    liveChannelStore.markRead(testWriter, 'space-1');
    await Promise.resolve();
    liveChannelStore.release();
    expect(liveChannelStore.channel('space-1')).toBeNull();

    settleMarkRead?.({ data: null, error: { name: 'AbortError' } });
    await pending;
    await Promise.resolve();
    expect(liveChannelStore.diagnosis()).toBeNull();
    expect(liveChannelStore.markReadFault('space-1')).toBeNull();
    expect(liveChannelStore.channel('space-1')).toBeNull();
  });

  it('zeroes the badge and clears the NEW divider without a reload on success', async () => {
    await loadUntilReady();
    expect(liveChannelStore.channel('space-1')?.messages.some((message) => message.newDivider)).toBe(true);
    const fromCalls = backend.client.from.mock.calls.length;
    const version = liveChannelStore.getVersion();
    backend.setRpc({ data: null, error: null });
    liveChannelStore.markRead(testWriter, 'space-1');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.channel('space-1')?.unread).toBe(0));
    expect(liveChannelStore.channel('space-1')?.messages.some((message) => message.newDivider)).toBe(false);
    expect(liveChannelStore.getVersion()).toBeGreaterThan(version);
    expect(backend.client.from.mock.calls.length).toBe(fromCalls);
    expect(liveChannelStore.diagnosis()).toBeNull();
    expect(liveChannelStore.error()).toBeNull();
  });

  it('keeps an in-flight refresh after mark-read success and still zeroes unread', async () => {
    await loadUntilReady();
    let settleSession: ((value: { data: { session: { user: { id: string } } } }) => void) | undefined;
    const pendingSession = new Promise<{ data: { session: { user: { id: string } } } }>((resolve) => {
      settleSession = resolve;
    });
    backend.client.auth.getSession.mockImplementationOnce(() => pendingSession);

    const refresh = liveChannelStore.refresh();
    const posts = backend.rows.chapter_thread_posts ?? [];
    backend.rows.chapter_thread_posts = posts;
    posts.push({
      id: 'post-2',
      thread_id: 'thread-1',
      author_id: 'member-b',
      body: 'Earlier campaign update',
      author_name: 'Worker B',
      author_initials: 'MB',
      author_role: null,
      created_at: '2026-08-20T11:00:00.000Z',
    });
    backend.setRpc({ data: null, error: null });
    liveChannelStore.markRead(testWriter, 'space-1');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.channel('space-1')?.unread).toBe(0));

    settleSession?.({ data: { session: { user: { id: 'member-a' } } } });
    await refresh;
    expect(liveChannelStore.channel('space-1')?.messages.map((message) => message.id)).toEqual(['post-2', 'post-1']);
    expect(liveChannelStore.channel('space-1')?.unread).toBe(0);
    expect(liveChannelStore.channel('space-1')?.messages.some((message) => message.newDivider)).toBe(false);
  });

  it('keeps posts newer than the mark-read cursor unread after an in-flight refresh', async () => {
    await loadUntilReady();
    let settleSession: ((value: { data: { session: { user: { id: string } } } }) => void) | undefined;
    const pendingSession = new Promise<{ data: { session: { user: { id: string } } } }>((resolve) => {
      settleSession = resolve;
    });
    backend.client.auth.getSession.mockImplementationOnce(() => pendingSession);

    const refresh = liveChannelStore.refresh();
    const posts = backend.rows.chapter_thread_posts ?? [];
    // Past on the device clock but newer than every post held when the
    // request began, so a response-time client cursor would hide it.
    const newerAt = '2026-08-20T13:00:00.000Z';
    posts.push({
      id: 'post-newer',
      thread_id: 'thread-1',
      author_id: 'member-b',
      body: 'Posted after the read cursor',
      author_name: 'Worker B',
      author_initials: 'MB',
      author_role: null,
      created_at: newerAt,
    });
    backend.setRpc({ data: null, error: null });
    liveChannelStore.markRead(testWriter, 'space-1');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.channel('space-1')?.unread).toBe(0));

    settleSession?.({ data: { session: { user: { id: 'member-a' } } } });
    await refresh;
    const channel = liveChannelStore.channel('space-1');
    expect(channel?.messages.map((message) => message.id)).toEqual(['post-1', 'post-newer']);
    expect(channel?.unread).toBe(1);
    expect(channel?.messages.find((message) => message.id === 'post-1')?.newDivider).toBeUndefined();
    expect(channel?.messages.find((message) => message.id === 'post-newer')?.newDivider).toBe(true);
  });

  it('retains a mark-read failure after a concurrent load completes', async () => {
    await loadUntilReady();
    let settleSession: ((value: { data: { session: { user: { id: string } } } }) => void) | undefined;
    const pendingSession = new Promise<{ data: { session: { user: { id: string } } } }>((resolve) => {
      settleSession = resolve;
    });
    backend.client.auth.getSession.mockImplementationOnce(() => pendingSession);

    const refresh = liveChannelStore.refresh();
    backend.throwRpc({ name: 'AbortError' });
    liveChannelStore.markRead(testWriter, 'space-1');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.markReadFault('space-1')?.op).toBe('mark_read'));
    expect(liveChannelStore.diagnosis()).toEqual({ class: 'transport', op: 'mark_read', spaceId: 'space-1' });

    settleSession?.({ data: { session: { user: { id: 'member-a' } } } });
    await refresh;
    expect(liveChannelStore.markReadFault('space-1')).toEqual({
      class: 'transport',
      op: 'mark_read',
      spaceId: 'space-1',
    });
    expect(liveChannelStore.diagnosis()?.op).not.toBe('mark_read');
  });

  it('clears a mark-read failure once a later load shows the channel read', async () => {
    await loadUntilReady();
    backend.throwRpc({ name: 'AbortError' });
    liveChannelStore.markRead(testWriter, 'space-1');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.markReadFault('space-1')?.op).toBe('mark_read'));

    backend.rows.chapter_space_reads = [{ space_id: 'space-1', last_read_at: '2026-08-20T12:30:00.000Z' }];
    await liveChannelStore.refresh();
    expect(liveChannelStore.channel('space-1')?.unread).toBe(0);
    expect(liveChannelStore.markReadFault('space-1')).toBeNull();
    expect(liveChannelStore.error()).toBeNull();
  });

  it('ignores a stale overlapping mark-read rejection after a later success', async () => {
    await loadUntilReady();
    let settleFirst: ((value: { data: unknown; error: unknown }) => void) | undefined;
    let settleSecond: ((value: { data: unknown; error: unknown }) => void) | undefined;
    const first = new Promise<{ data: unknown; error: unknown }>((resolve) => { settleFirst = resolve; });
    const second = new Promise<{ data: unknown; error: unknown }>((resolve) => { settleSecond = resolve; });
    backend.client.rpc
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);

    liveChannelStore.markRead(testWriter, 'space-1');
    await Promise.resolve();
    liveChannelStore.markRead(testWriter, 'space-1');
    await Promise.resolve();
    settleSecond?.({ data: null, error: null });
    await second;
    await vi.waitFor(() => expect(liveChannelStore.channel('space-1')?.unread).toBe(0));

    settleFirst?.({ data: null, error: { name: 'AbortError' } });
    await first;
    await Promise.resolve();
    expect(liveChannelStore.diagnosis()).toBeNull();
    expect(liveChannelStore.channel('space-1')?.unread).toBe(0);
    expect(liveChannelStore.error()).toBeNull();
  });

  it('evicts the cached space when the RPC reports it unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadUntilReady();
    expect(liveChannelStore.channel('space-1')).not.toBeNull();
    backend.setRpc({ data: null, error: { code: '22023', message: 'space unavailable' } });
    liveChannelStore.markRead(testWriter, 'space-1');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.channel('space-1')).toBeNull());
    expect(liveChannelStore.diagnosis()).toEqual({ class: 'request', op: 'mark_read', spaceId: 'space-1' });
    expect(liveChannelStore.error()).toBe(messageInboxCopy.en.markReadError);
    expect(liveChannelStore.status()).toBe('ready');
    expect(warn).toHaveBeenCalledWith(`${CHANNEL_LOAD_LOG_TAG} class=request op=mark_read`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('space unavailable');
  });
});

describe('live channel send, reaction, and vote diagnosis', () => {
  async function loadUntilSettled() {
    liveChannelStore.acquire();
    await vi.waitFor(() => expect(liveChannelStore.status()).not.toBe('loading'));
    await vi.waitFor(() => expect(liveChannelStore.status()).not.toBe('idle'));
  }

  function postsInsert(result: { data: unknown; error: unknown; status?: number }) {
    backend.client.from.mockImplementationOnce((table: string) => {
      expect(table).toBe('chapter_thread_posts');
      const builder = {
        insert: () => builder,
        select: () => builder,
        is: () => builder,
        in: () => builder,
        eq: () => builder,
        or: () => builder,
        limit: () => builder,
        order: () => builder,
        single: () => Promise.resolve(result),
        maybeSingle: () => Promise.resolve({ data: null, error: result.error }),
        then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
      };
      return builder;
    });
  }

  const pollTally = {
    poll_id: 'poll-1',
    question: 'Which night?',
    closes_at: null,
    total: 1,
    mine: 'opt-a',
    options: [
      { id: 'opt-a', label: 'Tue', position: 0, votes: 1 },
      { id: 'opt-b', label: 'Wed', position: 1, votes: 0 },
    ],
  };

  async function loadWithPoll() {
    backend.rows.chapter_channel_polls = [{
      id: 'poll-1',
      space_id: 'space-1',
      post_id: 'post-1',
      question: 'Which night?',
      closes_at: null,
      created_at: '2026-08-20T12:00:00.000Z',
    }];
    backend.setRpc({ data: pollTally, error: null });
    await loadUntilSettled();
  }

  it('preserves withheld counts through load, cast and clear', async () => {
    await loadWithPoll();
    const withheld = { ...pollTally, total: null, options: pollTally.options.map(option => ({ ...option, votes: null })) };
    backend.setRpc({ data: withheld, error: null });
    await liveChannelStore.refresh();
    expect(liveChannelStore.poll()).toMatchObject({ mine: 0, options: [{ votes: null }, { votes: null }] });
    expect(liveChannelStore.pollTotal()).toBeNull();
    backend.setRpc({ data: { ...withheld, mine: 'opt-b' }, error: null });
    liveChannelStore.vote(testWriter, 1);
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.poll()?.mine).toBe(1));
    expect(liveChannelStore.poll()?.options.every(option => option.votes === null)).toBe(true);
    backend.setRpc({ data: { ...withheld, mine: null }, error: null });
    liveChannelStore.vote(testWriter, 1);
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.poll()?.mine).toBeNull());
    expect(backend.client.rpc).toHaveBeenLastCalledWith('cast_channel_poll_vote', { p_poll_id: 'poll-1', p_option_id: null });
    expect(liveChannelStore.pollTotal()).toBeNull();
  });

  it('keeps final results and the deadline when every campaign poll is closed, without casting a vote', async () => {
    const closesAt = '2020-10-04T12:00:00-04:00';
    backend.rows.chapter_channel_polls = [
      { id: 'older-poll', space_id: 'space-1', post_id: 'post-1', question: 'Older?', closes_at: closesAt, created_at: '2020-09-01' },
      { id: 'poll-1', space_id: 'space-1', post_id: 'post-1', question: 'Which night?', closes_at: closesAt, created_at: '2020-10-01' },
    ];
    backend.setRpc({ data: { ...pollTally, closes_at: closesAt }, error: null });
    await loadUntilSettled();
    expect(backend.client.rpc).toHaveBeenCalledWith('get_channel_poll_tally', { p_poll_id: 'poll-1' });
    expect(liveChannelStore.poll()).toMatchObject({ closesAt, question: 'Which night?', mine: 0, options: [{ label: 'Tue', votes: 1 }, { label: 'Wed', votes: 0 }] });
    expect(liveChannelStore.channel('space-1')?.messages[0]?.poll).toBe(true);
    backend.client.rpc.mockClear();
    liveChannelStore.vote(testWriter, 1);
    await Promise.resolve();
    expect(backend.client.rpc).not.toHaveBeenCalled();
  });

  it('rejects the insert RPC and classifies sendDiagnosis while loadError stays null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadUntilSettled();
    expect(liveChannelStore.error()).toBeNull();
    postsInsert({
      data: null,
      error: { code: '42P01', message: 'relation chapter_thread_posts does not exist' },
      status: 404,
    });
    const sent = await liveChannelStore.send(testWriter, 'space-1', 'hello', 'Worker A', 'MA');
    expect(sent).toBe(false);
    expect(liveChannelStore.error()).toBeNull();
    expect(liveChannelStore.loadFault()).toBeNull();
    expect(liveChannelStore.status()).toBe('ready');
    expect(liveChannelStore.sendDiagnosis()).toEqual({ class: 'schema', op: 'send' });
    expect(readLastChannelLoadDiagnosis()).toEqual({ class: 'schema', op: 'send' });
    expect(warn).toHaveBeenCalledWith(`${CHANNEL_LOAD_LOG_TAG} class=schema op=send`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('chapter_thread_posts');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('does not exist');
    expect(messageInboxCopy.en.channelActionError.send).toContain('could not be sent');
    expect(messageInboxCopy.es.channelActionError.send).toContain('forma segura');
    const live = readFileSync(fileURLToPath(new URL('./liveChannels.ts', import.meta.url)), 'utf8');
    const sendSource = live.slice(live.indexOf('async send('));
    expect(sendSource).not.toContain('loadError');
  });

  it('does not overwrite a real loadError when send fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    backend.tableErrors.chapter_spaces = { code: '42P01', message: 'relation chapter_spaces does not exist' };
    await loadUntilSettled();
    const loadMessage = liveChannelStore.error();
    expect(liveChannelStore.loadFault()).toBe('schema');
    expect(loadMessage).toBe(messageInboxCopy.en.channelError.schema);
    const sent = await liveChannelStore.send(testWriter, 'space-1', 'hello', 'Worker A', 'MA');
    expect(sent).toBe(false);
    expect(liveChannelStore.error()).toBe(loadMessage);
    expect(liveChannelStore.loadFault()).toBe('schema');
    expect(liveChannelStore.sendDiagnosis()?.op).toBe('send');
  });

  it('appends a successful send and clears sendDiagnosis without touching loadError', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadUntilSettled();
    postsInsert({
      data: {
        id: 'post-sent',
        thread_id: 'thread-1',
        author_id: 'member-a',
        body: 'hello',
        author_name: 'Worker A',
        author_initials: 'MA',
        author_role: null,
        created_at: '2026-08-20T12:02:00.000Z',
        parent_post_id: null,
      },
      error: null,
    });
    const sent = await liveChannelStore.send(testWriter, 'space-1', 'hello', 'Worker A', 'MA');
    expect(sent).toBe(true);
    expect(liveChannelStore.error()).toBeNull();
    expect(liveChannelStore.sendDiagnosis()).toBeNull();
    expect(liveChannelStore.channel('space-1')?.messages.some((message) => message.id === 'post-sent')).toBe(true);
  });

  it('classifies a rejected reaction RPC and surfaces the localized notice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadUntilSettled();
    backend.setRpc({ data: null, error: { code: 'PGRST202', message: 'function missing' } });
    liveChannelStore.toggleReaction(testWriter, 'space-1', 'post-1', 'like');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis()).toEqual({ class: 'schema', op: 'reaction' }));
    expect(readLastChannelLoadDiagnosis()).toEqual({ class: 'schema', op: 'reaction' });
    expect(warn).toHaveBeenCalledWith(`${CHANNEL_LOAD_LOG_TAG} class=schema op=reaction`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('function missing');
    expect(messageInboxCopy.en.channelActionError.reaction).toContain('reaction');
    expect(messageInboxCopy.es.channelActionError.reaction).toContain('reacción');
  });

  it('keeps a successful reaction from scheduling a refresh', async () => {
    await loadUntilSettled();
    backend.client.rpc.mockClear();
    backend.client.from.mockClear();
    backend.setRpc({ data: { reacted: true }, error: null });
    vi.useFakeTimers();
    try {
      liveChannelStore.toggleReaction(testWriter, 'space-1', 'post-1', 'like');
    await Promise.resolve();
      await vi.runAllTimersAsync();
      expect(liveChannelStore.actionDiagnosis()).toBeNull();
      expect(backend.client.rpc).toHaveBeenCalledWith(
        'toggle_member_message_reaction',
        { p_source_kind: 'channel', p_message_id: 'post-1', p_reaction: 'like' },
      );
      expect(backend.client.from).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies a rejected vote RPC and surfaces the localized notice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadWithPoll();
    backend.setRpc({ data: null, error: { code: 'PGRST202', message: 'function missing' } });
    liveChannelStore.vote(testWriter, 1);
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis()).toEqual({ class: 'schema', op: 'vote' }));
    expect(readLastChannelLoadDiagnosis()).toEqual({ class: 'schema', op: 'vote' });
    expect(warn).toHaveBeenCalledWith(`${CHANNEL_LOAD_LOG_TAG} class=schema op=vote`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('function missing');
    expect(messageInboxCopy.en.channelActionError.vote).toContain('vote');
    expect(messageInboxCopy.es.channelActionError.vote).toContain('voto');
  });

  it('applies a successful vote tally without scheduling a refresh', async () => {
    await loadWithPoll();
    expect(liveChannelStore.poll()?.mine).toBe(0);
    backend.client.from.mockClear();
    backend.setRpc({
      data: {
        ...pollTally,
        mine: 'opt-b',
        total: 1,
        options: [
          { id: 'opt-a', label: 'Tue', position: 0, votes: 0 },
          { id: 'opt-b', label: 'Wed', position: 1, votes: 1 },
        ],
      },
      error: null,
    });
    vi.useFakeTimers();
    try {
      liveChannelStore.vote(testWriter, 1);
    await Promise.resolve();
      await vi.runAllTimersAsync();
      expect(liveChannelStore.poll()?.mine).toBe(1);
      expect(liveChannelStore.actionDiagnosis()).toBeNull();
      expect(backend.client.from).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies a rejected vote promise as a transport fault and still refreshes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadWithPoll();
    backend.client.from.mockClear();
    backend.throwRpc({ name: 'AbortError' });
    vi.useFakeTimers();
    try {
      liveChannelStore.vote(testWriter, 1);
    await Promise.resolve();
      await vi.runAllTimersAsync();
      expect(liveChannelStore.actionDiagnosis()).toEqual({ class: 'transport', op: 'vote' });
      expect(warn).toHaveBeenCalledWith(`${CHANNEL_LOAD_LOG_TAG} class=transport op=vote`);
      expect(backend.client.from).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  function addSecondSpace() {
    backend.rows.chapter_spaces = [
      ...(backend.rows.chapter_spaces ?? []),
      { id: 'space-2', name: 'stewards', description: 'Committee notes', visibility: 'chapter' },
    ];
    backend.rows.chapter_threads = [
      ...(backend.rows.chapter_threads ?? []),
      { id: 'thread-2', space_id: 'space-2', created_at: '2026-08-20T12:00:00.000Z' },
    ];
  }

  it('scopes a failed reaction notice to the channel it was attempted in', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    addSecondSpace();
    await loadUntilSettled();
    backend.setRpc({ data: null, error: { code: 'PGRST202', message: 'function missing' } });
    liveChannelStore.toggleReaction(testWriter, 'space-1', 'post-1', 'like');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis('space-1'))
      .toEqual({ class: 'schema', op: 'reaction' }));
    // Pushing to another channel must not inherit channel one's notice.
    expect(liveChannelStore.actionDiagnosis('space-2')).toBeNull();
  });

  it('scopes a failed vote notice to the channel that renders the poll', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    addSecondSpace();
    await loadWithPoll();
    backend.setRpc({ data: null, error: { code: 'PGRST202', message: 'function missing' } });
    liveChannelStore.vote(testWriter, 1);
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis('space-1'))
      .toEqual({ class: 'schema', op: 'vote' }));
    expect(liveChannelStore.actionDiagnosis('space-2')).toBeNull();
  });

  it('keeps the newer failure notice when an earlier reaction succeeds after it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadUntilSettled();
    // The first reaction is still in flight when the second one is tapped.
    let settleFirst: (value: { data: unknown; error: unknown }) => void = () => undefined;
    const first = new Promise<{ data: unknown; error: unknown }>((resolve) => { settleFirst = resolve; });
    backend.client.rpc.mockImplementationOnce(() => first);
    liveChannelStore.toggleReaction(testWriter, 'space-1', 'post-1', 'like');
    await Promise.resolve();
    backend.setRpc({ data: null, error: { code: 'PGRST202', message: 'function missing' } });
    liveChannelStore.toggleReaction(testWriter, 'space-1', 'post-1', 'support');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis('space-1'))
      .toEqual({ class: 'schema', op: 'reaction' }));
    // The earlier attempt finally succeeds. It must not erase the newer
    // failure, which the member has not been told about yet.
    settleFirst({ data: { reacted: true }, error: null });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(liveChannelStore.actionDiagnosis('space-1')).toEqual({ class: 'schema', op: 'reaction' });
  });

  it('clears the notice when a later retry of the same reaction succeeds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadUntilSettled();
    backend.setRpc({ data: null, error: { code: 'PGRST202', message: 'function missing' } });
    liveChannelStore.toggleReaction(testWriter, 'space-1', 'post-1', 'like');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis('space-1'))
      .toEqual({ class: 'schema', op: 'reaction' }));
    backend.setRpc({ data: { reacted: true }, error: null });
    liveChannelStore.toggleReaction(testWriter, 'space-1', 'post-1', 'like');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis('space-1')).toBeNull());
    expect(liveChannelStore.actionDiagnosis()).toBeNull();
  });

  function addSecondSpaceWithPost() {
    addSecondSpace();
    backend.rows.chapter_thread_posts = [
      ...(backend.rows.chapter_thread_posts ?? []),
      {
        id: 'post-2',
        thread_id: 'thread-2',
        author_id: 'member-a',
        body: 'Committee note',
        author_name: 'Worker A',
        author_initials: 'MA',
        author_role: null,
        created_at: '2026-08-20T12:00:00.000Z',
      },
    ];
  }

  function deferredRpc() {
    let settle: (value: { data: unknown; error: unknown }) => void = () => undefined;
    const pending = new Promise<{ data: unknown; error: unknown }>((resolve) => { settle = resolve; });
    backend.client.rpc.mockImplementationOnce(() => pending);
    return (value: { data: unknown; error: unknown }) => settle(value);
  }

  const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });

  it('suppresses duplicate in-flight toggles and changes counts only after confirmation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadUntilSettled();
    backend.client.rpc.mockClear();
    const before = JSON.stringify(liveChannelStore.channel('space-1')?.messages[0]?.reactions);
    const settleFirst = deferredRpc();
    liveChannelStore.toggleReaction(testWriter, 'space-1', 'post-1', 'care');
    await Promise.resolve();
    expect(liveChannelStore.reactionPending('post-1', 'care')).toBe(true);
    expect(JSON.stringify(liveChannelStore.channel('space-1')?.messages[0]?.reactions)).toBe(before);
    liveChannelStore.toggleReaction(testWriter, 'space-1', 'post-1', 'care');
    await Promise.resolve();
    expect(backend.client.rpc).toHaveBeenCalledTimes(1);
    settleFirst({ data: { reacted: true }, error: null });
    await flush();
    expect(liveChannelStore.reactionPending('post-1')).toBe(false);
    expect(liveChannelStore.channel('space-1')?.messages[0]?.reactions?.find(row => row.kind === 'care')).toMatchObject({ count: 1, mine: true });
    backend.setRpc({ data: null, error: { code: 'PGRST202', message: 'function missing' } });
    liveChannelStore.toggleReaction(testWriter, 'space-1', 'post-1', 'care');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis('space-1'))
      .toEqual({ class: 'schema', op: 'reaction' }));
    expect(liveChannelStore.channel('space-1')?.messages[0]?.reactions?.find(row => row.kind === 'care')).toMatchObject({ count: 1, mine: true });
  });

  it('keeps a failed vote when a later reaction in another channel succeeds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    addSecondSpaceWithPost();
    await loadWithPoll();
    expect(liveChannelStore.channel('space-2')?.messages.some((message) => message.id === 'post-2')).toBe(true);
    // Vote in channel one (attempt 1), then react in channel two (attempt 2).
    const settleVote = deferredRpc();
    liveChannelStore.vote(testWriter, 1);
    await Promise.resolve();
    const settleReaction = deferredRpc();
    liveChannelStore.toggleReaction(testWriter, 'space-2', 'post-2', 'like');
    await Promise.resolve();
    // The vote fails while the reaction is still in flight, then the reaction
    // succeeds. The vote was never saved, so channel one keeps its notice.
    settleVote({ data: null, error: { code: '22023', message: 'poll closed' } });
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis('space-1'))
      .toEqual({ class: 'request', op: 'vote' }));
    settleReaction({ data: { reacted: true }, error: null });
    await flush();
    expect(liveChannelStore.actionDiagnosis('space-1')).toEqual({ class: 'request', op: 'vote' });
    expect(liveChannelStore.actionDiagnosis('space-2')).toBeNull();
  });

  it('keeps a failed vote when a later reaction in the same channel succeeds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadWithPoll();
    backend.setRpc({ data: null, error: { code: '22023', message: 'poll closed' } });
    liveChannelStore.vote(testWriter, 1);
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis('space-1'))
      .toEqual({ class: 'request', op: 'vote' }));
    backend.setRpc({ data: { reacted: true }, error: null });
    liveChannelStore.toggleReaction(testWriter, 'space-1', 'post-1', 'like');
    await Promise.resolve();
    await flush();
    expect(liveChannelStore.actionDiagnosis('space-1')).toEqual({ class: 'request', op: 'vote' });
  });

  it('keeps a failed reaction when a different reaction on the same message succeeds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadUntilSettled();
    backend.setRpc({ data: null, error: { code: 'PGRST202', message: 'function missing' } });
    liveChannelStore.toggleReaction(testWriter, 'space-1', 'post-1', 'like');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis('space-1'))
      .toEqual({ class: 'schema', op: 'reaction' }));
    backend.setRpc({ data: { reacted: true }, error: null });
    liveChannelStore.toggleReaction(testWriter, 'space-1', 'post-1', 'support');
    await Promise.resolve();
    await flush();
    expect(liveChannelStore.actionDiagnosis('space-1')).toEqual({ class: 'schema', op: 'reaction' });
  });

  it('keeps channel one\'s failed reaction when the same reaction succeeds in channel two', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    addSecondSpaceWithPost();
    await loadUntilSettled();
    backend.setRpc({ data: null, error: { code: 'PGRST202', message: 'function missing' } });
    liveChannelStore.toggleReaction(testWriter, 'space-1', 'post-1', 'like');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis('space-1'))
      .toEqual({ class: 'schema', op: 'reaction' }));
    backend.setRpc({ data: { reacted: true }, error: null });
    liveChannelStore.toggleReaction(testWriter, 'space-2', 'post-2', 'like');
    await Promise.resolve();
    await flush();
    expect(liveChannelStore.actionDiagnosis('space-1')).toEqual({ class: 'schema', op: 'reaction' });
    expect(liveChannelStore.actionDiagnosis('space-2')).toBeNull();
  });

  it('keeps channel one\'s failed vote when channel two\'s reaction fails after it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    addSecondSpaceWithPost();
    await loadWithPoll();
    backend.setRpc({ data: null, error: { code: '22023', message: 'poll closed' } });
    liveChannelStore.vote(testWriter, 1);
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis('space-1'))
      .toEqual({ class: 'request', op: 'vote' }));
    backend.setRpc({ data: null, error: { code: 'PGRST202', message: 'function missing' } });
    liveChannelStore.toggleReaction(testWriter, 'space-2', 'post-2', 'like');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis('space-2'))
      .toEqual({ class: 'schema', op: 'reaction' }));
    // Each channel keeps its own unsaved action.
    expect(liveChannelStore.actionDiagnosis('space-1')).toEqual({ class: 'request', op: 'vote' });
  });

  it('clears a failed vote when a retry on the same poll succeeds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadWithPoll();
    backend.setRpc({ data: null, error: { code: '22023', message: 'poll closed' } });
    liveChannelStore.vote(testWriter, 1);
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis('space-1'))
      .toEqual({ class: 'request', op: 'vote' }));
    backend.setRpc({ data: { ...pollTally, mine: 'opt-b' }, error: null });
    liveChannelStore.vote(testWriter, 1);
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis('space-1')).toBeNull());
    expect(liveChannelStore.actionDiagnosis()).toBeNull();
  });

  it('ignores an earlier vote failure that settles after a newer vote on the same poll succeeded', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadWithPoll();
    const settleFirst = deferredRpc();
    liveChannelStore.vote(testWriter, 1);
    await Promise.resolve();
    backend.setRpc({ data: { ...pollTally, mine: 'opt-b' }, error: null });
    liveChannelStore.vote(testWriter, 1);
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.poll()?.mine).toBe(1));
    settleFirst({ data: null, error: { code: '22023', message: 'poll closed' } });
    await flush();
    expect(liveChannelStore.actionDiagnosis('space-1')).toBeNull();
  });

  it('shows the older failure again once the newer one in that channel is repaired', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadWithPoll();
    backend.setRpc({ data: null, error: { code: '22023', message: 'poll closed' } });
    liveChannelStore.vote(testWriter, 1);
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis('space-1'))
      .toEqual({ class: 'request', op: 'vote' }));
    backend.setRpc({ data: null, error: { code: 'PGRST202', message: 'function missing' } });
    liveChannelStore.toggleReaction(testWriter, 'space-1', 'post-1', 'like');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis('space-1'))
      .toEqual({ class: 'schema', op: 'reaction' }));
    backend.setRpc({ data: { reacted: true }, error: null });
    liveChannelStore.toggleReaction(testWriter, 'space-1', 'post-1', 'like');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis('space-1'))
      .toEqual({ class: 'request', op: 'vote' }));
  });

  it('classifies a 42501 reaction refusal as authentication, not an authorized-empty inbox', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadUntilSettled();
    // toggle_member_message_reaction raises 42501 when the caller is absent or
    // private.mfa_satisfied() is false.
    backend.setRpc({ data: null, error: { code: '42501', message: 'authentication required' } });
    liveChannelStore.toggleReaction(testWriter, 'space-1', 'post-1', 'like');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis('space-1'))
      .toEqual({ class: 'authentication', op: 'reaction' }));
    expect(warn).toHaveBeenCalledWith(`${CHANNEL_LOAD_LOG_TAG} class=authentication op=reaction`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('authorized-empty');
  });

  it('classifies a 42501 vote refusal as authentication and a 22023 refusal as a request fault', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadWithPoll();
    backend.setRpc({ data: null, error: { code: '42501', message: 'authentication required' } });
    liveChannelStore.vote(testWriter, 1);
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis('space-1'))
      .toEqual({ class: 'authentication', op: 'vote' }));
    // cast_channel_poll_vote raises 22023 for a closed or unavailable poll.
    backend.setRpc({ data: null, error: { code: '22023', message: 'poll closed' } });
    liveChannelStore.vote(testWriter, 0);
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis('space-1'))
      .toEqual({ class: 'request', op: 'vote' }));
  });

  it('records a rejected vote even when an unrelated refresh lands first', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadWithPoll();
    let settleVote: (value: { data: unknown; error: unknown }) => void = () => undefined;
    const pending = new Promise<{ data: unknown; error: unknown }>((resolve) => { settleVote = resolve; });
    backend.client.rpc.mockImplementationOnce(() => pending);
    liveChannelStore.vote(testWriter, 1);
    await Promise.resolve();
    // A realtime insert's confirmed write bumps loadSequence while the vote is
    // in flight. The poll and the session are unchanged, so the member must
    // still be told the vote failed.
    liveChannelStore.acceptConfirmedActions('space-1', 'post-1', ['like']);
    settleVote({ data: null, error: { code: 'PGRST202', message: 'function missing' } });
    await vi.waitFor(() => expect(liveChannelStore.actionDiagnosis('space-1'))
      .toEqual({ class: 'schema', op: 'vote' }));
  });

  it('drops a vote completion that settles after a session reset', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadWithPoll();
    let settleVote: (value: { data: unknown; error: unknown }) => void = () => undefined;
    const pending = new Promise<{ data: unknown; error: unknown }>((resolve) => { settleVote = resolve; });
    backend.client.rpc.mockImplementationOnce(() => pending);
    liveChannelStore.vote(testWriter, 1);
    await Promise.resolve();
    liveChannelStore.resetForSession();
    settleVote({ data: null, error: { code: 'PGRST202', message: 'function missing' } });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(liveChannelStore.actionDiagnosis()).toBeNull();
    expect(liveChannelStore.actionDiagnosis('space-1')).toBeNull();
  });

  it('drops a reaction completion that settles after a session reset', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadUntilSettled();
    backend.setRpc({ data: null, error: { code: 'PGRST202', message: 'function missing' } });
    liveChannelStore.toggleReaction(testWriter, 'space-1', 'post-1', 'like');
    await Promise.resolve();
    // Sign-out or an account switch lands before the reaction RPC settles.
    liveChannelStore.resetForSession();
    backend.setRpc({ data: null, error: null });
    await vi.waitFor(() => expect(liveChannelStore.status()).not.toBe('loading'));
    await vi.waitFor(() => expect(liveChannelStore.status()).not.toBe('idle'));
    expect(liveChannelStore.actionDiagnosis()).toBeNull();
    expect(liveChannelStore.actionDiagnosis('space-1')).toBeNull();
  });
});

// BUG-UG-WEB-TREATS-EACH-CHAPTER-THREAD-AS-ITS-OWN-INBOX-CONVERSATION-MOBILE-FLATTENS-20260921
describe('one channel row per campaign thread (web inbox parity)', () => {
  const baseFrom = backend.client.from.getMockImplementation()!;
  afterEach(() => { backend.client.from.mockImplementation(baseFrom); });

  function twoThreadSpace(cursor: string | null = null) {
    backend.rows.chapter_threads = [
      { id: 'thread-1', space_id: 'space-1', title: 'Contract questions', created_at: '2026-08-20T11:00:00.000Z' },
      { id: 'thread-2', space_id: 'space-1', title: 'Safety walk', created_at: '2026-08-20T11:30:00.000Z' },
    ];
    backend.rows.chapter_thread_posts = [
      {
        id: 'post-1', thread_id: 'thread-1', author_id: 'member-b', body: 'Older thread post',
        author_name: 'Worker B', author_initials: 'MB', author_role: null, created_at: '2026-08-20T12:00:00.000Z',
      },
      {
        id: 'post-2', thread_id: 'thread-2', author_id: 'member-b', body: 'Newer thread post',
        author_name: 'Worker B', author_initials: 'MB', author_role: null, created_at: '2026-08-20T12:05:00.000Z',
      },
    ];
    if (cursor) backend.rows.chapter_space_reads = [{ space_id: 'space-1', last_read_at: cursor }];
  }

  async function loadReady() {
    liveChannelStore.acquire();
    await vi.waitFor(() => expect(liveChannelStore.status()).toBe('ready'));
  }

  function captureInserts() {
    const inserts: { table: string; row: Record<string, unknown> }[] = [];
    const original = backend.client.from.getMockImplementation()!;
    backend.client.from.mockImplementation((table: string) => {
      if (table !== 'chapter_thread_posts' && table !== 'chapter_threads') return original(table);
      const read = original(table) as Record<string, unknown>;
      let inserted: Record<string, unknown> | null = null;
      const builder: Record<string, unknown> = {
        ...read,
        insert: (row: Record<string, unknown>) => { inserted = row; inserts.push({ table, row }); return builder; },
        select: () => (inserted ? builder : read),
        single: () => Promise.resolve(table === 'chapter_threads'
          ? { data: { id: 'thread-new' }, error: null }
          : {
              data: {
                id: `post-sent-${inserts.length}`, thread_id: inserted?.thread_id, author_id: 'member-a', body: inserted?.body,
                author_name: 'Worker A', author_initials: 'MA', author_role: null,
                created_at: '2026-08-20T12:10:00.000Z', parent_post_id: null,
              },
              error: null,
            }),
      };
      return builder as never;
    });
    return inserts;
  }

  it('lists each thread of a space as its own row, named by the thread title', async () => {
    twoThreadSpace();
    await loadReady();
    const rows = liveChannelStore.channels();
    expect(rows.map((channel) => channel.id)).toEqual(['thread-1', 'thread-2']);
    expect(rows.map((channel) => channel.name)).toEqual(['Contract questions', 'Safety walk']);
    expect(rows.map((channel) => channel.topic)).toEqual(['general', 'general']);
    expect(liveChannelStore.channel('thread-1')?.messages.map((message) => message.id)).toEqual(['post-1']);
    expect(liveChannelStore.channel('thread-2')?.messages.map((message) => message.id)).toEqual(['post-2']);
    // A space id with several threads names no single row.
    expect(liveChannelStore.channel('space-1')).toBeNull();
  });

  it('posts into the thread that was opened and never into the space\'s oldest thread', async () => {
    twoThreadSpace();
    await loadReady();
    const inserts = captureInserts();
    expect(await liveChannelStore.send(testWriter, 'thread-2', 'Reply in the newer thread', 'Worker A', 'MA')).toBe(true);
    expect(inserts).toEqual([{ table: 'chapter_thread_posts', row: { thread_id: 'thread-2', body: 'Reply in the newer thread' } }]);
    expect(liveChannelStore.channel('thread-2')?.messages.some((message) => message.body === 'Reply in the newer thread')).toBe(true);
    expect(liveChannelStore.channel('thread-1')?.messages.some((message) => message.body === 'Reply in the newer thread')).toBe(false);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await liveChannelStore.send(testWriter, 'space-1', 'Ambiguous target', 'Worker A', 'MA')).toBe(false);
    expect(inserts).toHaveLength(1);
    expect(liveChannelStore.sendDiagnosis()?.op).toBe('send');
  });

  it('starts the first thread of a thread-less space from its row', async () => {
    backend.rows.chapter_threads = [];
    backend.rows.chapter_thread_posts = [];
    await loadReady();
    expect(liveChannelStore.channels().map((channel) => channel.id)).toEqual(['space-1']);
    const inserts = captureInserts();
    expect(await liveChannelStore.send(testWriter, 'space-1', 'First post', 'Worker A', 'MA')).toBe(true);
    expect(inserts).toEqual([
      { table: 'chapter_threads', row: { space_id: 'space-1', title: 'general', kind: 'topic' } },
      { table: 'chapter_thread_posts', row: { thread_id: 'thread-new', body: 'First post' } },
    ]);
  });

  it('keeps two named campaign channels distinct after their first posts and refreshed reads', async () => {
    // Both spaces belong to the same selected chapter; neither has a thread yet.
    backend.rows.chapter_spaces = [
      { id: 'space-1', chapter_id: 'chapter-1', name: 'Welcome to Quillmere', name_es: 'Bienvenida a Quillmere', description: 'Welcome', visibility: 'chapter' },
      { id: 'space-2', chapter_id: 'chapter-1', name: 'Branch nominations', name_es: 'Nominaciones de la sección', description: 'Nominations', visibility: 'chapter' },
    ];
    backend.rows.chapter_threads = [];
    backend.rows.chapter_thread_posts = [];
    // Persist the actual insert payloads so refresh reads what send wrote,
    // rather than supplying a fixture with the expected thread name.
    let postSequence = 0;
    backend.client.from.mockImplementation((table: string) => {
      const read = baseFrom(table) as Record<string, unknown>;
      if (table !== 'chapter_threads' && table !== 'chapter_thread_posts') return read as never;
      let inserted: Record<string, unknown> | null = null;
      const builder: Record<string, unknown> = {
        ...read,
        insert: (row: Record<string, unknown>) => { inserted = row; return builder; },
        select: () => inserted ? builder : read,
        single: async () => {
          const row = table === 'chapter_threads'
            ? { ...inserted, id: `thread-${inserted?.space_id}`, status: 'open', created_at: '2026-08-20T12:10:00.000Z' }
            : { ...inserted, id: `post-created-${++postSequence}`, author_id: 'member-a', author_name: 'Worker A', author_initials: 'MA', author_role: null, created_at: '2026-08-20T12:11:00.000Z' };
          backend.rows[table]!.push(row);
          return { data: row, error: null };
        },
      };
      return builder as never;
    });
    const expected = ['Welcome to Quillmere', 'Branch nominations'];
    const expectedEs = ['Bienvenida a Quillmere', 'Nominaciones de la sección'];
    const expectNames = () => {
      expect(liveChannelStore.channels().map((channel) => channel.name).sort()).toEqual([...expected].sort());
      expect(liveChannelStore.channels().map((channel) => channelInReaderLanguage(channel, 'es').name).sort()).toEqual([...expectedEs].sort());
      for (const [index, id] of ['space-1', 'space-2'].entries()) {
        // These are the route/header lookup and inbox/list snapshot APIs.
        expect(liveChannelStore.channel(id)?.name).toBe(expected[index]);
        expect(channelInReaderLanguage(liveChannelStore.channel(id)!, 'es').name).toBe(expectedEs[index]);
      }
    };
    await loadReady();
    expectNames();
    for (const id of ['space-1', 'space-2']) {
      expect(await liveChannelStore.send(testWriter, id, `First post in ${id}`, 'Worker A', 'MA')).toBe(true);
      expectNames();
      await liveChannelStore.refresh();
      expectNames();
    }
    expect(backend.rows.chapter_threads).toHaveLength(2);
    for (const id of ['space-1', 'space-2']) {
      expect(liveChannelStore.channel(id)?.messages.map((message) => message.body)).toEqual([`First post in ${id}`]);
    }
  });

  it('counts each thread against the space read cursor, like the browser, and clears the space on read', async () => {
    twoThreadSpace('2026-08-20T12:01:00.000Z');
    await loadReady();
    expect(liveChannelStore.channel('thread-1')?.unread).toBe(0);
    expect(liveChannelStore.channel('thread-2')?.unread).toBe(1);
    // Reading a thread with nothing unread writes no cursor.
    liveChannelStore.markRead(testWriter, 'thread-1');
    await Promise.resolve();
    expect(backend.client.rpc).not.toHaveBeenCalledWith('mark_chapter_space_read', expect.anything());

    backend.setRpc({ data: null, error: null });
    liveChannelStore.markRead(testWriter, 'thread-2');
    await Promise.resolve();
    expect(backend.client.rpc).toHaveBeenCalledWith('mark_chapter_space_read', { p_space_id: 'space-1' });
    await vi.waitFor(() => expect(liveChannelStore.channel('thread-2')?.unread).toBe(0));
    expect(liveChannelStore.channel('thread-1')?.unread).toBe(0);
  });

  it('keeps a mark-read fault on every row of the space it belongs to', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    twoThreadSpace();
    await loadReady();
    backend.throwRpc({ name: 'AbortError' });
    liveChannelStore.markRead(testWriter, 'thread-2');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.markReadFault('thread-2')).not.toBeNull());
    expect(liveChannelStore.markReadFault('thread-2')).toEqual({ class: 'transport', op: 'mark_read', spaceId: 'space-1' });
    expect(liveChannelStore.markReadFault('thread-1')).toEqual({ class: 'transport', op: 'mark_read', spaceId: 'space-1' });
  });
});

// BUG-UG-NATIVE-CHANNEL-HIDES-POSTS-PAST-NEWEST-1000-20261110: the
// window is the chapter's newest 1,000 posts; a full window gives each thread
// a cursor at the window's oldest post, and each thread pages back from there.
describe('earlier channel posts past the newest 1,000', () => {
  const iso = (tick: number) => new Date(Date.UTC(2026, 8, 1, 0, 0, 0) + tick * 1000).toISOString();
  type PostFixture = { id: string; thread_id: string; author_id: string; body: string; body_es: null; author_name: string; author_initials: string; author_role: null; created_at: string; mentioned_user_ids?: string[] };
  const post = (id: string, threadID: string, createdAt: string): PostFixture => ({
    id, thread_id: threadID, author_id: 'member-b', body: `Tamarack update ${id}`, body_es: null,
    author_name: 'Worker B', author_initials: 'MB', author_role: null, created_at: createdAt,
  });

  async function loadUntilSettled() {
    liveChannelStore.acquire();
    await vi.waitFor(() => expect(liveChannelStore.status()).not.toBe('loading'));
    await vi.waitFor(() => expect(liveChannelStore.status()).not.toBe('idle'));
  }

  // thread-busy fills the window; thread-quiet only has posts older than it,
  // 101 of them at one time so a page edge falls inside the tie.
  function chapter() {
    backend.rows.chapter_spaces = [
      { id: 'space-1', name: 'general', description: 'Campaign updates', visibility: 'chapter' },
      { id: 'space-empty', name: 'questions', description: 'Ask here', visibility: 'chapter' },
    ];
    backend.rows.chapter_threads = [
      { id: 'thread-busy', space_id: 'space-1', title: 'Busy', status: 'open', created_at: iso(0) },
      { id: 'thread-quiet', space_id: 'space-1', title: 'Quiet', status: 'open', created_at: iso(0) },
    ];
    const quiet = [
      ...Array.from({ length: 101 }, (_unused, index) => post(`quiet-a-${String(index).padStart(3, '0')}`, 'thread-quiet', iso(100))),
      ...Array.from({ length: 349 }, (_unused, index) => post(`quiet-b-${String(index).padStart(3, '0')}`, 'thread-quiet', iso(101 + index))),
    ];
    const busy = Array.from({ length: 1_050 }, (_unused, index) => post(`busy-${String(index).padStart(4, '0')}`, 'thread-busy', iso(1_000 + index)));
    backend.rows.chapter_thread_posts = [...quiet, ...busy, { ...post('quiet-deleted', 'thread-quiet', iso(200)), deleted_at: iso(300) }];
    backend.rows.member_message_reactions = [{ channel_post_id: 'quiet-b-000', reaction: 'like', actor_id: 'member-a', source_kind: 'channel' }];
    return { quiet: quiet.sort((left, right) => (left.created_at === right.created_at ? (left.id < right.id ? -1 : 1) : left.created_at < right.created_at ? -1 : 1)), busy };
  }

  it('gives every thread of a full window a cursor at its oldest post, and a quiet thread pages back to its first post', async () => {
    const { quiet, busy } = chapter();
    await loadUntilSettled();
    const windowOldest = busy[50]!;
    expect(liveChannelStore.channel('thread-busy')?.messages).toHaveLength(1_000);
    expect(liveChannelStore.channel('thread-quiet')?.messages).toEqual([]);
    for (const id of ['thread-busy', 'thread-quiet']) {
      expect(liveChannelStore.earlierCursor(id)).toEqual({ createdAt: windowOldest.created_at, id: windowOldest.id });
    }
    // A space with no thread has no posts to page.
    expect(liveChannelStore.earlierCursor('space-empty')).toBeNull();
    await expect(liveChannelStore.earlierPosts('space-empty', { createdAt: iso(5_000), id: 'x' })).rejects.toThrow();

    const read: string[] = [];
    let cursor = liveChannelStore.earlierCursor('thread-quiet');
    let pages = 0;
    while (cursor) {
      const page = await liveChannelStore.earlierPosts('thread-quiet', cursor);
      expect(page.messages.length).toBeLessThanOrEqual(liveChannelsModule.CHANNEL_HISTORY_PAGE);
      read.unshift(...page.messages.map((message) => message.id));
      cursor = page.earlierCursor;
      pages += 1;
    }
    expect(pages).toBe(3);
    // Oldest first, no gap or duplicate across the tie, the deleted post never read.
    expect(read).toEqual(quiet.map((row) => row.id));
    expect(new Set(read).size).toBe(450);
    expect(read).not.toContain('quiet-deleted');
    // Each read names the thread, the cursor and the bound.
    const reads = backend.rowReads.filter((entry) => entry.table === 'chapter_thread_posts');
    expect(reads.slice(1).map((entry) => entry.count)).toEqual([200, 200, 50]);
  });

  it('builds the same message an earlier page shows wherever the post was read, reactions and mentions included', async () => {
    chapter();
    (backend.rows.chapter_thread_posts ??= []).push({ ...post('quiet-mention', 'thread-quiet', iso(50)), mentioned_user_ids: ['member-a'] });
    await loadUntilSettled();
    const page = await liveChannelStore.earlierPosts('thread-quiet', { createdAt: iso(102), id: '' });
    expect(page.messages.map((message) => message.id)).toEqual(['quiet-mention', ...Array.from({ length: 101 }, (_unused, index) => `quiet-a-${String(index).padStart(3, '0')}`), 'quiet-b-000']);
    expect(page.earlierCursor).toBeNull();
    expect(page.messages[0]).toMatchObject({ author: 'Worker B', initials: 'MB', createdAt: iso(50), mentionsMe: true });
    expect(page.messages.at(-1)?.reactions).toEqual([expect.objectContaining({ kind: 'like', count: 1, mine: true })]);
    expect(page.messages.some((message) => message.day !== undefined || message.newDivider !== undefined || message.poll !== undefined)).toBe(false);
  });

  it('gives no thread a cursor while the window holds every post', async () => {
    await loadUntilSettled();
    expect(liveChannelStore.channel('thread-1')?.messages).toHaveLength(1);
    expect(liveChannelStore.earlierCursor('thread-1')).toBeNull();
  });

  it('refuses an answer that lands after the session was reset, and forgets cursors with the session', async () => {
    chapter();
    await loadUntilSettled();
    const cursor = liveChannelStore.earlierCursor('thread-quiet')!;
    let release: (value: unknown) => void = () => undefined;
    backend.client.auth.getSession.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = liveChannelStore.earlierPosts('thread-quiet', cursor);
    liveChannelStore.resetForSession();
    release({ data: { session: { user: { id: 'member-c' } } } });
    await expect(pending).rejects.toBeInstanceOf(StaleResponseError);
    expect(liveChannelStore.earlierCursor('thread-quiet')).toBeNull();
  });

  it('shows the day line once per day across a merged history', () => {
    const rows = [
      { id: 'a', author: 'A', initials: 'A', time: '', body: 'one', createdAt: '2026-09-01T15:00:00.000Z', day: 'Tue, Sep 1' },
      { id: 'b', author: 'B', initials: 'B', time: '', body: 'two', createdAt: '2026-09-01T16:00:00.000Z', day: 'Tue, Sep 1' },
      { id: 'c', author: 'C', initials: 'C', time: '', body: 'three', createdAt: '2026-09-02T16:00:00.000Z' },
    ];
    const lined = liveChannelsModule.withChannelDayLines(rows);
    expect(lined[0]?.day).toBeTruthy();
    expect(lined[1]?.day).toBeUndefined();
    expect(lined[2]?.day).toBeTruthy();
    expect(lined[2]?.day).not.toBe(lined[0]?.day);
  });

  it('sends a reaction on a post shown only from earlier history, and shows the confirmed reaction', async () => {
    chapter();
    await loadUntilSettled();
    await liveChannelStore.earlierPosts('thread-quiet', liveChannelStore.earlierCursor('thread-quiet')!);
    expect(liveChannelStore.channel('thread-quiet')?.messages.some((message) => message.id === 'quiet-b-348')).toBe(false);
    backend.setRpc({ data: { reacted: true }, error: null });
    liveChannelStore.toggleReaction(testWriter, 'thread-quiet', 'quiet-b-348', 'like');
    await Promise.resolve();
    expect(backend.client.rpc).toHaveBeenCalledWith('toggle_member_message_reaction', { p_source_kind: 'channel', p_message_id: 'quiet-b-348', p_reaction: 'like' });
    await vi.waitFor(() => expect(liveChannelStore.earlierReactions('quiet-b-348')).toEqual([expect.objectContaining({ kind: 'like', count: 1, mine: true })]));
    // Only a post this session read for that thread is a target.
    backend.client.rpc.mockClear();
    liveChannelStore.toggleReaction(testWriter, 'thread-busy', 'quiet-b-347', 'like');
    await Promise.resolve();
    expect(backend.client.rpc).not.toHaveBeenCalled();
  });

  it('stops treating an earlier post as a target once a re-read of its page no longer returns it', async () => {
    chapter();
    await loadUntilSettled();
    const first = await liveChannelStore.earlierPosts('thread-quiet', liveChannelStore.earlierCursor('thread-quiet')!);
    await liveChannelStore.earlierPosts('thread-quiet', first.earlierCursor!);
    // One post on each page is removed; only the first page is read again.
    for (const id of ['quiet-b-300', 'quiet-a-050']) {
      const row = backend.rows.chapter_thread_posts?.find((post) => (post as { id: string }).id === id) as Record<string, unknown>;
      row.deleted_at = iso(9_000);
    }
    await liveChannelStore.earlierPosts('thread-quiet', liveChannelStore.earlierCursor('thread-quiet')!);
    backend.setRpc({ data: { reacted: true }, error: null });
    backend.client.rpc.mockClear();
    liveChannelStore.toggleReaction(testWriter, 'thread-quiet', 'quiet-b-300', 'like');
    await Promise.resolve();
    expect(backend.client.rpc).not.toHaveBeenCalled();
    // Outside the page read again, the remembered post stays until its own page is.
    liveChannelStore.toggleReaction(testWriter, 'thread-quiet', 'quiet-a-050', 'like');
    await Promise.resolve();
    expect(backend.client.rpc).toHaveBeenCalledWith('toggle_member_message_reaction', { p_source_kind: 'channel', p_message_id: 'quiet-a-050', p_reaction: 'like' });
  });

  it('forgets the earlier posts of a thread a reload no longer shows', async () => {
    chapter();
    await loadUntilSettled();
    await liveChannelStore.earlierPosts('thread-quiet', liveChannelStore.earlierCursor('thread-quiet')!);
    const threads = backend.rows.chapter_threads ?? [];
    backend.rows.chapter_threads = threads.filter((thread) => (thread as { id: string }).id !== 'thread-quiet');
    await liveChannelStore.refresh();
    expect(liveChannelStore.channel('thread-quiet')).toBeNull();
    // Access returns; nothing this session read before it is a target again.
    backend.rows.chapter_threads = threads;
    await liveChannelStore.refresh();
    backend.setRpc({ data: { reacted: true }, error: null });
    backend.client.rpc.mockClear();
    liveChannelStore.toggleReaction(testWriter, 'thread-quiet', 'quiet-b-348', 'like');
    await Promise.resolve();
    expect(backend.client.rpc).not.toHaveBeenCalled();
  });

  it('keeps a window post that a fuller window pushes out as a target, with its confirmed reaction, and not one removed inside the window', async () => {
    chapter();
    await loadUntilSettled();
    backend.setRpc({ data: { reacted: true }, error: null });
    liveChannelStore.toggleReaction(testWriter, 'thread-busy', 'busy-0050', 'like');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.channel('thread-busy')?.messages.find((message) => message.id === 'busy-0050')?.reactions)
      .toEqual([expect.objectContaining({ kind: 'like', mine: true })]));
    // A new post pushes the window's oldest post out of it.
    backend.rows.chapter_thread_posts?.push(post('busy-1050', 'thread-busy', iso(2_050)));
    await liveChannelStore.refresh();
    expect(liveChannelStore.channel('thread-busy')?.messages.some((message) => message.id === 'busy-0050')).toBe(false);
    expect(liveChannelStore.earlierReactions('busy-0050')).toEqual([expect.objectContaining({ kind: 'like', mine: true })]);
    backend.client.rpc.mockClear();
    liveChannelStore.toggleReaction(testWriter, 'thread-busy', 'busy-0050', 'like');
    await Promise.resolve();
    expect(backend.client.rpc).toHaveBeenCalledWith('toggle_member_message_reaction', { p_source_kind: 'channel', p_message_id: 'busy-0050', p_reaction: 'like' });
    // Its confirmation invalidates a load started before it, so let it land.
    await vi.waitFor(() => expect(liveChannelStore.reactionPending('busy-0050')).toBe(false));
    // A post removed inside the window's range leaves the window and is no target.
    const removed = backend.rows.chapter_thread_posts?.find((row) => (row as { id: string }).id === 'busy-0500') as Record<string, unknown>;
    removed.deleted_at = iso(9_000);
    backend.rows.chapter_thread_posts?.push(post('busy-1051', 'thread-busy', iso(2_051)));
    await liveChannelStore.refresh();
    backend.client.rpc.mockClear();
    liveChannelStore.toggleReaction(testWriter, 'thread-busy', 'busy-0500', 'like');
    await Promise.resolve();
    expect(backend.client.rpc).not.toHaveBeenCalled();
  });

  it('keeps a confirmed reaction on an earlier post when a read that started before it lands later', async () => {
    chapter();
    await loadUntilSettled();
    const cursor = liveChannelStore.earlierCursor('thread-quiet')!;
    await liveChannelStore.earlierPosts('thread-quiet', cursor);
    let release: (value: unknown) => void = () => undefined;
    backend.client.auth.getSession.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const held = liveChannelStore.earlierPosts('thread-quiet', cursor);
    backend.setRpc({ data: { reacted: true }, error: null });
    liveChannelStore.toggleReaction(testWriter, 'thread-quiet', 'quiet-b-348', 'like');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.earlierReactions('quiet-b-348')).toEqual([expect.objectContaining({ kind: 'like', mine: true })]));
    release({ data: { session: { user: { id: 'member-a' } } } });
    await held;
    expect(liveChannelStore.earlierReactions('quiet-b-348')).toEqual([expect.objectContaining({ kind: 'like', mine: true })]);
  });

  it('keeps a confirmed reaction when a newer read accepts it before an older read lands', async () => {
    chapter();
    await loadUntilSettled();
    const cursor = liveChannelStore.earlierCursor('thread-quiet')!;
    await liveChannelStore.earlierPosts('thread-quiet', cursor);
    // Read A starts and is held before it reads anything.
    let release: (value: unknown) => void = () => undefined;
    backend.client.auth.getSession.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const older = liveChannelStore.earlierPosts('thread-quiet', cursor);
    backend.setRpc({ data: { reacted: true }, error: null });
    liveChannelStore.toggleReaction(testWriter, 'thread-quiet', 'quiet-b-348', 'like');
    await Promise.resolve();
    await vi.waitFor(() => expect(liveChannelStore.reactionPending('quiet-b-348')).toBe(false));
    // An independently paged, overlapping cursor still keeps the per-post
    // fence; only reads of the same cursor supersede one another wholesale.
    const saved = { channel_post_id: 'quiet-b-348', reaction: 'like', actor_id: 'member-a', source_kind: 'channel' };
    backend.rows.member_message_reactions = [...(backend.rows.member_message_reactions ?? []), saved];
    await liveChannelStore.earlierPosts('thread-quiet', { createdAt: iso(500), id: 'cut' });
    expect(liveChannelStore.earlierReactions('quiet-b-348')).toEqual([expect.objectContaining({ kind: 'like', mine: true })]);
    // Read A lands with what the server held before the reaction.
    backend.rows.member_message_reactions = (backend.rows.member_message_reactions ?? []).filter((row) => row !== saved);
    release({ data: { session: { user: { id: 'member-a' } } } });
    await older;
    expect(liveChannelStore.earlierReactions('quiet-b-348')).toEqual([expect.objectContaining({ kind: 'like', mine: true })]);
  });

  function holdReactionSnapshot(responses: ReturnType<typeof createResponseQueue<void>>, label: string) {
    const original = backend.client.from.getMockImplementation()!;
    let held = false;
    backend.client.from.mockImplementation((table: string) => {
      const builder = original(table);
      if (table === 'member_message_reactions' && !held) {
        held = true;
        const then = builder.then.bind(builder);
        builder.then = (resolve, reject) => then((value) => responses.request(label).then(() => resolve(value))).catch(reject);
      }
      return builder;
    });
    return () => backend.client.from.mockImplementation(original);
  }

  it.each([false, true])('keeps the newer window after an older window lands (older failure: %s)', async (failOld) => {
    chapter();
    await loadUntilSettled();
    const responses = createResponseQueue<void>();
    const restore = holdReactionSnapshot(responses, 'older window');
    try {
      const held = liveChannelStore.refresh();
      await vi.waitFor(() => expect(responses.pending()).toEqual(['older window']));
      const newest = backend.rows.chapter_thread_posts!.find((row) => (row as PostFixture).id === 'busy-1049') as PostFixture;
      newest.body = 'Current campaign update';
      await liveChannelStore.refresh();
      if (failOld) responses.reject('older window', new Error('old network failure'));
      else responses.resolve('older window', undefined);
      await held;
      expect(liveChannelStore.channel('thread-busy')?.messages.at(-1)?.body).toBe('Current campaign update');
      expect(liveChannelStore.error()).toBeNull();
      expect(liveChannelStore.status()).toBe('ready');
    } finally { restore(); }
  });

  it.each(['success', 'failure'])('retires a same-cursor read after a newer %s, including a late failure', async (outcome) => {
    chapter();
    await loadUntilSettled();
    const cursor = liveChannelStore.earlierCursor('thread-quiet')!;
    const responses = createResponseQueue<void>();
    const restore = holdReactionSnapshot(responses, 'older page');
    try {
      const held = liveChannelStore.earlierPosts('thread-quiet', cursor).catch((error: unknown) => error);
      await vi.waitFor(() => expect(responses.pending()).toEqual(['older page']));
      if (outcome === 'failure') {
        const error = { message: 'current network failure' };
        backend.tableErrors.chapter_thread_posts = error;
        await expect(liveChannelStore.earlierPosts('thread-quiet', cursor)).rejects.toMatchObject({ error });
        delete backend.tableErrors.chapter_thread_posts;
        responses.reject('older page', new Error('old network failure'));
      } else {
        await liveChannelStore.earlierPosts('thread-quiet', cursor);
        responses.resolve('older page', undefined);
      }
      expect(await held).toBeInstanceOf(StaleResponseError);
      if (outcome === 'failure') {
        backend.client.rpc.mockClear();
        liveChannelStore.toggleReaction(testWriter, 'thread-quiet', 'quiet-b-348', 'like');
    await Promise.resolve();
        expect(backend.client.rpc).not.toHaveBeenCalled();
      }
    } finally { restore(); }
  });

  it('lets a nonoverlapping older page finish across ordinary window refreshes', async () => {
    chapter();
    await loadUntilSettled();
    const cursor = liveChannelStore.earlierCursor('thread-quiet')!;
    const responses = createResponseQueue<void>();
    const restore = holdReactionSnapshot(responses, 'older page');
    try {
      const held = liveChannelStore.earlierPosts('thread-quiet', cursor);
      await vi.waitFor(() => expect(responses.pending()).toEqual(['older page']));
      await liveChannelStore.refresh();
      backend.rows.chapter_thread_posts?.push(post('busy-1050', 'thread-busy', iso(2_050)));
      await liveChannelStore.refresh();
      responses.resolve('older page', undefined);
      expect((await held).messages.some((row) => row.id === 'quiet-b-348')).toBe(true);
      backend.setRpc({ data: { reacted: true }, error: null });
      liveChannelStore.toggleReaction(testWriter, 'thread-quiet', 'quiet-b-348', 'like');
    await Promise.resolve();
      expect(backend.client.rpc).toHaveBeenCalledWith('toggle_member_message_reaction', expect.objectContaining({ p_message_id: 'quiet-b-348' }));
    } finally { restore(); }
  });

  it('retires a held page when its thread disappears, even if access returns before it lands', async () => {
    chapter();
    await loadUntilSettled();
    const cursor = liveChannelStore.earlierCursor('thread-quiet')!;
    const responses = createResponseQueue<void>();
    const restore = holdReactionSnapshot(responses, 'removed thread');
    try {
      const held = liveChannelStore.earlierPosts('thread-quiet', cursor).catch((error: unknown) => error);
      await vi.waitFor(() => expect(responses.pending()).toEqual(['removed thread']));
      const threads = backend.rows.chapter_threads!;
      backend.rows.chapter_threads = threads.filter((row) => (row as { id: string }).id !== 'thread-quiet');
      await liveChannelStore.refresh();
      backend.rows.chapter_threads = threads;
      await liveChannelStore.refresh();
      responses.resolve('removed thread', undefined);
      expect(await held).toBeInstanceOf(StaleResponseError);
      backend.client.rpc.mockClear();
      liveChannelStore.toggleReaction(testWriter, 'thread-quiet', 'quiet-b-348', 'like');
    await Promise.resolve();
      expect(backend.client.rpc).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it('keeps a removed Like through window reentry and eviction before a held read lands (ledger 5)', async () => {
    chapter();
    backend.rows.chapter_thread_posts?.push(post('busy-1050', 'thread-busy', iso(2_050)));
    backend.rows.member_message_reactions = [{ channel_post_id: 'busy-0050', reaction: 'like', actor_id: 'member-a', source_kind: 'channel' }];
    await loadUntilSettled();
    const cursor = liveChannelStore.earlierCursor('thread-busy')!;
    await liveChannelStore.earlierPosts('thread-busy', cursor);
    expect(liveChannelStore.earlierReactions('busy-0050')?.some((reaction) => reaction.mine)).toBe(true);
    const responses = createResponseQueue<void>();
    const restore = holdReactionSnapshot(responses, 'old Like');
    try {
      const held = liveChannelStore.earlierPosts('thread-busy', cursor).catch((error: unknown) => error);
      await vi.waitFor(() => expect(responses.pending()).toEqual(['old Like']));
      backend.setRpc({ data: { reacted: false }, error: null });
      liveChannelStore.toggleReaction(testWriter, 'thread-busy', 'busy-0050', 'like');
    await Promise.resolve();
      await vi.waitFor(() => expect(liveChannelStore.reactionPending('busy-0050')).toBe(false));
      expect(liveChannelStore.earlierReactions('busy-0050')?.some((reaction) => reaction.mine)).not.toBe(true);
      backend.rows.member_message_reactions = [];
      backend.rows.chapter_thread_posts = backend.rows.chapter_thread_posts!.filter((row) => (row as PostFixture).id !== 'busy-1050');
      await liveChannelStore.refresh();
      expect(liveChannelStore.channel('thread-busy')?.messages.some((row) => row.id === 'busy-0050')).toBe(true);
      backend.rows.chapter_thread_posts.push(post('busy-1051', 'thread-busy', iso(2_051)));
      await liveChannelStore.refresh();
      expect(liveChannelStore.channel('thread-busy')?.messages.some((row) => row.id === 'busy-0050')).toBe(false);
      responses.resolve('old Like', undefined);
      expect(await held).toBeInstanceOf(StaleResponseError);
      // The screen uses `earlierReactions(id) ?? kept.reactions`: an accepted
      // empty list must not fall back to the kept page's old Like.
      expect(liveChannelStore.earlierReactions('busy-0050')).toEqual([]);
    } finally { restore(); }
  });

  it.each([100, 600])('does not restore a deleted post after a window covers it (%i busy posts removed, ledger 7)', async (removedCount) => {
    chapter();
    await loadUntilSettled();
    const cursor = liveChannelStore.earlierCursor('thread-quiet')!;
    await liveChannelStore.earlierPosts('thread-quiet', cursor);
    const responses = createResponseQueue<void>();
    const restore = holdReactionSnapshot(responses, 'old target');
    try {
      const held = liveChannelStore.earlierPosts('thread-quiet', cursor).catch((error: unknown) => error);
      await vi.waitFor(() => expect(responses.pending()).toEqual(['old target']));
      for (const row of backend.rows.chapter_thread_posts ?? []) {
        const record = row as Record<string, unknown>;
        const id = String(record.id);
        if ((id.startsWith('busy-') && Number(id.slice(5)) < removedCount) || id === 'quiet-b-348') record.deleted_at = iso(9_000);
      }
      await liveChannelStore.refresh();
      if (removedCount === 600) expect(liveChannelStore.earlierCursor('thread-quiet')).toBeNull();
      else expect(liveChannelStore.earlierCursor('thread-quiet')).not.toBeNull();
      backend.client.rpc.mockClear();
      liveChannelStore.toggleReaction(testWriter, 'thread-quiet', 'quiet-b-348', 'like');
    await Promise.resolve();
      expect(backend.client.rpc).not.toHaveBeenCalled();
      responses.resolve('old target', undefined);
      expect(await held).toBeInstanceOf(StaleResponseError);
      backend.client.rpc.mockClear();
      liveChannelStore.toggleReaction(testWriter, 'thread-quiet', 'quiet-b-348', 'like');
    await Promise.resolve();
      expect(backend.client.rpc).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it('forgets a remembered earlier post that the window covers again and omits', async () => {
    chapter();
    await loadUntilSettled();
    await liveChannelStore.earlierPosts('thread-quiet', liveChannelStore.earlierCursor('thread-quiet')!);
    // Enough busy posts go that the window holds the whole chapter again, and
    // the remembered post is deleted inside it.
    for (const row of backend.rows.chapter_thread_posts ?? []) {
      const record = row as Record<string, unknown>;
      const id = String(record.id);
      if ((id.startsWith('busy-') && Number(id.slice(5)) < 600) || id === 'quiet-b-348') record.deleted_at = iso(9_000);
    }
    await liveChannelStore.refresh();
    expect(liveChannelStore.earlierCursor('thread-quiet')).toBeNull();
    expect(liveChannelStore.channel('thread-quiet')?.messages.some((message) => message.id === 'quiet-b-348')).toBe(false);
    backend.setRpc({ data: { reacted: true }, error: null });
    backend.client.rpc.mockClear();
    liveChannelStore.toggleReaction(testWriter, 'thread-quiet', 'quiet-b-348', 'like');
    await Promise.resolve();
    expect(backend.client.rpc).not.toHaveBeenCalled();
    // A post the window still holds stays a target through the window.
    liveChannelStore.toggleReaction(testWriter, 'thread-quiet', 'quiet-b-347', 'like');
    await Promise.resolve();
    expect(backend.client.rpc).toHaveBeenCalledWith('toggle_member_message_reaction', { p_source_kind: 'channel', p_message_id: 'quiet-b-347', p_reaction: 'like' });
  });

  it('keeps the server time on an acknowledged send, so the post stays in an opened history', async () => {
    chapter();
    await loadUntilSettled();
    const sentRow: Record<string, unknown> = {
      id: 'sent-1', thread_id: 'thread-busy', author_id: 'member-a', body: 'Meeting moved to Thursday', body_es: null,
      author_name: 'Worker A', author_initials: 'MA', author_role: null, created_at: iso(9_999), parent_post_id: null,
    };
    backend.client.from.mockImplementationOnce((table: string) => {
      expect(table).toBe('chapter_thread_posts');
      const result: { data: Record<string, unknown> | null; error: unknown } = { data: sentRow, error: null };
      const builder = {
        insert: () => builder, select: () => builder, is: () => builder, in: () => builder, eq: () => builder, or: () => builder,
        limit: () => builder, order: () => builder,
        single: () => Promise.resolve(result),
        maybeSingle: () => Promise.resolve(result),
        then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
      };
      return builder;
    });
    await expect(liveChannelStore.send(testWriter, 'thread-busy', 'Meeting moved to Thursday', 'Worker A', 'MA')).resolves.toBe(true);
    expect(liveChannelStore.channel('thread-busy')?.messages.at(-1)).toMatchObject({ id: 'sent-1', createdAt: iso(9_999) });
  });

  it('shows a day line for each calendar day, even two that share a weekday', () => {
    const at = (day: number) => new Date(2026, 8, day, 12).toISOString();
    const rows: ChannelMessage[] = [7, 7, 14].map((day, index) => ({ id: `r${index}`, author: 'A', initials: 'A', time: '', body: 'post', createdAt: at(day) }));
    const lined = liveChannelsModule.withChannelDayLines(rows);
    expect(lined.map((row) => Boolean(row.day))).toEqual([true, false, true]);
  });
});
