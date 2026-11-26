import type { Session } from '@supabase/supabase-js';
import * as Crypto from 'expo-crypto';

import HomeWidgetsModule from '../../modules/home-widgets/src/HomeWidgetsModule';
import { messageTimestamp } from '../lib/messagingShared';
import { createCapturedSessionRpcClient, getSupabaseClient } from './supabase';
import { createHomeWidgetController, widgetSnapshot, type HomeWidgetScope } from './homeWidgetSnapshot';

const unavailable = async () => { throw new Error('Install a native build with home-screen widgets.'); };
export const homeWidgetsAvailable = HomeWidgetsModule !== null;
export const homeWidgets = createHomeWidgetController(HomeWidgetsModule ?? {
  resetAsync: async () => undefined,
  publishAsync: unavailable,
}, () => Crypto.randomUUID());

export function purgeHomeWidgets(): void {
  void homeWidgets.disable().catch(() => undefined);
}

export function suspendHomeWidgets(): void {
  void homeWidgets.suspend().catch(() => undefined);
}

const MAX_ROWS = 1_000;
const SPACE_COUNT_BATCH = 8;
type Membership = { chapterId: string; organizationId: string; selected: boolean };
type HeadCount = { count: number | null; error: unknown };

function exactCount(result: HeadCount): number {
  if (result.error || typeof result.count !== 'number') throw new Error('Widget counts unavailable.');
  return result.count;
}

export async function readHomeWidgetSnapshot(session: Session, scope: HomeWidgetScope) {
  const readStartedAt = Date.now();
  const auth = getSupabaseClient();
  if (!auth || session.user.id !== scope.userID) throw new Error('Widget counts unavailable.');
  const { data: identity, error: identityError } = await auth.auth.getUser(session.access_token);
  if (identityError || identity.user?.id !== scope.userID) throw new Error('Widget counts unavailable.');
  const client = createCapturedSessionRpcClient(session);
  const confirmScope = async () => {
    const result = await client.rpc('get_my_chapter_memberships');
    if (result.error || !Array.isArray(result.data) || !(result.data as Membership[]).some((row) => (
      row.selected === true && row.chapterId === scope.chapterID && row.organizationId === scope.organizationID
    ))) throw new Error('Widget counts unavailable.');
  };
  await confirmScope();
  const date = new Date(readStartedAt);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const [tasks, conversations, spaces, reads] = await Promise.all([
    client.from('chapter_tasks').select('id', { count: 'exact', head: true })
      .eq('chapter_id', scope.chapterID).eq('due_date', day).neq('status', 'done'),
    client.from('member_conversations').select('id', { count: 'exact' }).eq('user_id', scope.userID)
      .eq('organization_id', scope.organizationID).limit(MAX_ROWS + 1),
    client.from('chapter_spaces').select('id', { count: 'exact' }).eq('chapter_id', scope.chapterID)
      .is('archived_at', null).limit(MAX_ROWS + 1),
    client.from('chapter_space_reads').select('space_id,last_read_at', { count: 'exact' }).eq('user_id', scope.userID).limit(MAX_ROWS + 1),
  ]);
  for (const result of [tasks, conversations, spaces, reads]) if (result.error) throw new Error('Widget counts unavailable.');
  if (tasks.count == null || [conversations, spaces, reads].some((result) => result.count == null || result.count !== result.data?.length || result.count > MAX_ROWS)) {
    throw new Error('Widget counts unavailable.');
  }
  const conversationIDs = (conversations.data ?? []).map((row: { id: string }) => row.id);
  const cursors = new Map((reads.data ?? []).map((row: { space_id: string; last_read_at: string }) => [row.space_id, row.last_read_at]));
  // BUG-UG-UNREAD-WIDGET-FAILS-PAST-1000-CHANNEL-POSTS-20261106: the
  // chapter's post history grows without bound, so unread threads are counted
  // on the server, one exact head count per visible space: threads with a live
  // post newer than that space's cursor (any live post when never read, the
  // shared readCursor rule). No post or thread rows leave the server.
  const unreadThreadCount = (spaceID: string) => {
    const cursor = cursors.get(spaceID) ?? null;
    const query = client.from('chapter_threads').select('id,chapter_thread_posts!inner(id)', { count: 'exact', head: true })
      .eq('chapter_id', scope.chapterID).eq('space_id', spaceID).is('chapter_thread_posts.deleted_at', null)
      // The person's own posts are never unread for them (shared channel rule,
      // BUG-UG-OWN-POSTS-COUNT-AS-UNREAD-20261111). A deleted
      // author's posts keep a null author_id, and SQL never treats null as
      // not equal, so they are matched explicitly, as isOwnChannelPost does
      // (BUG-UG-NATIVE-HOME-WIDGET-UNREAD-SKIPS-POSTS-BY-DELETED-AUTHORS-20261115).
      .or(`author_id.is.null,author_id.neq.${scope.userID}`, { referencedTable: 'chapter_thread_posts' });
    return messageTimestamp(cursor) == null ? query : query.gt('chapter_thread_posts.created_at', cursor);
  };
  const spaceIDs = (spaces.data ?? []).map((row: { id: string }) => row.id);
  const threadCounts: HeadCount[] = [];
  for (let index = 0; index < spaceIDs.length; index += SPACE_COUNT_BATCH) {
    const batch = spaceIDs.slice(index, index + SPACE_COUNT_BATCH);
    threadCounts.push(...await Promise.all(batch.map(unreadThreadCount)));
  }
  // Only the caller's unread summaries are needed, which keeps this read bounded too.
  const summaries = await client.from('member_conversation_summaries').select('conversation_id,unread_count', { count: 'exact' })
    .gt('unread_count', 0).limit(MAX_ROWS + 1);
  if (summaries.error || summaries.count == null || summaries.count !== summaries.data?.length || summaries.count > MAX_ROWS) {
    throw new Error('Widget counts unavailable.');
  }
  const owned = new Set(conversationIDs);
  const direct = (summaries.data ?? []).filter((row: { conversation_id: string; unread_count: number }) => (
    owned.has(row.conversation_id) && row.unread_count > 0
  )).length;
  const unreadThreads = threadCounts.reduce((total, result) => total + exactCount(result), 0);
  await confirmScope();
  // A result spanning midnight belongs to yesterday, never to a new Today snapshot.
  if (new Date().toDateString() !== date.toDateString()) throw new Error('Widget counts unavailable.');
  return widgetSnapshot(tasks.count, direct + unreadThreads, readStartedAt);
}
