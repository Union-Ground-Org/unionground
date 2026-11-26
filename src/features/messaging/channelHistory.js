import { boundedRows, cappedLimit } from "../../lib/boundedPage.js";
import { postProjection } from "../connectedWorkflows/landing.js";
import { earlierPageMarks } from "./earlierMarks.js";

// BUG-UG-WEB-CHANNEL-HIDES-POSTS-PAST-NEWEST-1000-20261110: the member
// load reads the chapter's newest posts across every thread (999 of them, so
// the probe row fits the API's 1,000-row answer). It asks for one post past
// the window (lib/boundedPage.js), so a full window says so: each
// thread then pages back from the window's oldest post, one bounded page per
// read, under the reader's own row access. The native app does the same
// (apps/mobile/src/data/liveChannels.ts, #8077).

// 999 shown and one probe row: the API answers at most 1,000 rows
// (POSTGREST_MAX_ROWS), so a full window must leave room for the probe.
export const CHANNEL_WINDOW = 999;
export const CHANNEL_HISTORY_PAGE = 200;
// A reactions read names its posts in the request line; keep it short.
const REACTION_BATCH = 100;

/** The member load's channel post read: newest first, (created_at, id), one past the window. */
export function channelWindowRead(client) {
  return client.from("chapter_thread_posts").select("*").is("deleted_at", null)
    .order("created_at", { ascending: false }).order("id", { ascending: false })
    .limit(cappedLimit(CHANNEL_WINDOW));
}

/**
 * The window to show from that read, and where every thread's earlier posts
 * start when the window cut some off (its oldest post), else null.
 */
export function channelWindow(result) {
  if (!result || result.error) return { ...result, earlierBefore: null };
  const { rows, more } = boundedRows(result.data, CHANNEL_WINDOW);
  const oldest = rows[rows.length - 1];
  return { ...result, data: rows, earlierBefore: more && oldest ? { createdAt: oldest.created_at, id: oldest.id } : null };
}

async function readReactions(client, ids) {
  const rows = [];
  for (let index = 0; index < ids.length; index += REACTION_BATCH) {
    const { data, error } = await client.from("member_message_reactions")
      .select("id,actor_id,source_kind,channel_post_id,reaction,created_at")
      .eq("source_kind", "channel")
      .in("channel_post_id", ids.slice(index, index + REACTION_BATCH));
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

/**
 * The web messaging api's earlier-page read, run like its other reads.
 * @param {object} client a Supabase client for the signed-in reader
 * @param {{ run: (work: () => Promise<unknown>) => Promise<unknown>, wait: (promise: Promise<unknown>) => Promise<unknown> }} operation
 */
export function channelHistoryApi(client, operation, userId) {
  return {
    loadEarlierChannelPosts: (reference) => operation.run(() => operation.wait(loadEarlierChannelPosts(client, { ...reference, userId }))),
  };
}

/**
 * One bounded page of a thread's posts strictly before `before`, oldest
 * first, with the next cursor when more exist past the page.
 * @param {object} client a Supabase client for the signed-in reader
 * @param {{ threadId: string, before: { createdAt: string, id: string }, userId?: string }} ref
 *   userId: the reader, whose saved and reminder marks the page carries
 */
export async function loadEarlierChannelPosts(client, { threadId, before, userId }) {
  const at = JSON.stringify(before.createdAt);
  const id = JSON.stringify(before.id);
  const read = await client.from("chapter_thread_posts").select("*")
    .eq("thread_id", threadId).is("deleted_at", null)
    .or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${id})`)
    .order("created_at", { ascending: false }).order("id", { ascending: false })
    .limit(cappedLimit(CHANNEL_HISTORY_PAGE));
  if (read.error) throw read.error;
  const { rows, more } = boundedRows((read.data || []).filter((row) => row.thread_id === threadId), CHANNEL_HISTORY_PAGE);
  const ids = rows.map((row) => row.id);
  const [reactions, marksFor] = await Promise.all([
    ids.length ? readReactions(client, ids) : [],
    // The reader's saved and reminder marks, as the member load reads them (ledger 770).
    earlierPageMarks(client, { sourceKind: "channel", userId, ids }),
  ]);
  const oldest = rows[rows.length - 1];
  return {
    posts: [...rows].reverse().map((row) => ({ ...postProjection(row, reactions.filter((reaction) => reaction.channel_post_id === row.id)), ...marksFor(row.id) })),
    earlierCursor: more && oldest ? { createdAt: oldest.created_at, id: oldest.id } : null,
  };
}
