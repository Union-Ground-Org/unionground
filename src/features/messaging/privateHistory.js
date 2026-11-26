import { POSTGREST_MAX_ROWS, boundedRows, cappedLimit } from "../../lib/boundedPage.js";
import { earlierPageMarks } from "./earlierMarks.js";

// BUG-UG-WEB-DROPS-THE-NEWEST-MESSAGES-PAST-1000-20261122: the member
// load read every private message oldest first, and the API answers at most
// 1,000 rows, so past 1,000 the newest messages were the missing ones, with
// no word. It now reads the member's newest 1,000 (every row one answer can
// carry, so a member with exactly 1,000 still sees all of them) and, only
// when the answer is full, asks separately for each conversation, within a
// short deadline, whether it has a message older than the window.

export const PRIVATE_MESSAGE_WINDOW = POSTGREST_MAX_ROWS;
// A conversation that lost rows pages back from the window's oldest message,
// this many at a time, as a channel thread does (channelHistory.js,).
export const PRIVATE_HISTORY_PAGE = 200;
// A reactions read names its messages in the request line; keep it short.
const REACTION_BATCH = 100;
// Reaction rows read per request, one probe row past it.
export const REACTION_PAGE = 500;

// Newest first by (created_at, id). The session loader appends a confirmed
// reply at the end of the answer, so the window sorts rather than trusting
// the answer's order.
function newestFirst(left, right) {
  const byTime = Date.parse(right.created_at) - Date.parse(left.created_at);
  if (byTime) return byTime;
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? 1 : -1;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

// The probes are optional: the member load never waits longer than this for
// them. A probe that has not answered by then counts as a
// failed one.
export const OLDER_PROBE_DEADLINE_MS = 2_000;

// One of the member's own messages in this conversation older than `before`
// by (created_at, id)? A probe that fails cannot say none exists: yes.
function olderMessageExists(client, userId, conversationId, before) {
  const at = JSON.stringify(before.createdAt);
  const id = JSON.stringify(before.id);
  return Promise.resolve().then(() => client.from("member_messages").select("id")
    .eq("user_id", userId).eq("conversation_id", conversationId)
    .or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${id})`)
    .limit(1))
    .then((answer) => Boolean(answer?.error) || !Array.isArray(answer?.data) || answer.data.length > 0, () => true);
}

// At most this many probes are in flight at once ( unit 2): a
// member with hundreds of conversations never starts hundreds of requests.
export const OLDER_PROBE_CONCURRENCY = 6;

/**
 * The conversations that may have messages older than a full window's oldest
 * (`before`), one probe each, at most `concurrency` at a time, all inside one
 * deadline. A conversation whose probe fails, has not answered by the
 * deadline or never started counts as one that may; a late answer is dropped.
 * @param {object} client the member load's client
 * @param {string} userId the signed-in member
 * @param {string[]} conversationIds the member's conversations
 * @param {{ createdAt: string, id: string }} before the window's oldest message
 * @param {{ deadlineMs?: number, concurrency?: number }} [options]
 * @returns {Promise<Set<string>>}
 */
export async function conversationsWithOlderMessages(client, userId, conversationIds, before, { deadlineMs = OLDER_PROBE_DEADLINE_MS, concurrency = OLDER_PROBE_CONCURRENCY } = {}) {
  const answers = new Map();
  let next = 0;
  let expired = false;
  const worker = async () => {
    while (!expired && next < conversationIds.length) {
      const conversationId = conversationIds[next++];
      const older = await olderMessageExists(client, userId, conversationId, before);
      if (!expired) answers.set(conversationId, older);
    }
  };
  const probes = Promise.all(Array.from({ length: Math.min(concurrency, conversationIds.length) }, worker));
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, deadlineMs); });
  try {
    await Promise.race([probes, deadline]);
  } finally {
    expired = true;
    clearTimeout(timer);
  }
  return new Set(conversationIds.filter((conversationId) => answers.get(conversationId) !== false));
}

/**
 * The window to show from the member load's newest-first read, oldest first,
 * and its oldest message when the answer was full (older messages may exist
 * past it), else null. A failed read passes through untouched.
 * @param {{ data?: object[] | null, error?: unknown } | undefined} result
 */
export function privateMessageWindow(result) {
  if (!result || result.error || !Array.isArray(result.data)) return { ...result, earlierBefore: null };
  const rows = [...result.data].sort(newestFirst);
  const oldest = rows[rows.length - 1];
  const full = rows.length >= PRIVATE_MESSAGE_WINDOW && oldest;
  return { ...result, data: rows.reverse(), earlierBefore: full ? { createdAt: oldest.created_at, id: oldest.id } : null };
}

// Every reaction on the given messages. A batch bounds the ids in the request
// line, not the rows that come back, so each batch reads in pages of
// REACTION_PAGE by reaction id until a page says no more (lib/boundedPage.js):
// a full answer never cuts reactions off (Sol,  unit 3).
async function readReactions(client, ids) {
  const rows = [];
  for (let index = 0; index < ids.length; index += REACTION_BATCH) {
    let after = null;
    for (;;) {
      let query = client.from("member_message_reactions")
        .select("id,actor_id,source_kind,private_message_id,reaction,created_at")
        .eq("source_kind", "private")
        .in("private_message_id", ids.slice(index, index + REACTION_BATCH));
      if (after !== null) query = query.gt("id", after);
      const { data, error } = await query.order("id").limit(cappedLimit(REACTION_PAGE));
      if (error) throw error;
      const page = boundedRows(data, REACTION_PAGE);
      rows.push(...page.rows);
      if (!page.more) break;
      after = page.rows[page.rows.length - 1].id;
    }
  }
  return rows;
}

/**
 * The web messaging api's earlier-page read, run like its other reads.
 * @param {object} client a Supabase client for the signed-in member
 * @param {{ run: (work: () => Promise<unknown>) => Promise<unknown>, wait: (promise: Promise<unknown>) => Promise<unknown> }} operation
 * @param {string} userId the signed-in member
 */
export function privateHistoryApi(client, operation, userId) {
  return {
    loadEarlierPrivateMessages: (reference) => operation.run(() => operation.wait(loadEarlierPrivateMessages(client, { ...reference, userId }))),
  };
}

/**
 * One bounded page of a conversation's messages strictly before `before`,
 * oldest first, with the next cursor when more exist past the page. Scoped to
 * the member's own rows like the member load (a steward-role account reads
 * more under its policies).
 * @param {object} client a Supabase client for the signed-in member
 * @param {{ userId: string, conversationId: string, before: { createdAt: string, id: string } }} ref
 */
export async function loadEarlierPrivateMessages(client, { userId, conversationId, before }) {
  // No signed-in member: nothing to read (never a query with no member).
  if (!userId) return { messages: [], earlierCursor: null };
  const at = JSON.stringify(before.createdAt);
  const id = JSON.stringify(before.id);
  const read = await client.from("member_messages").select("*")
    .eq("user_id", userId).eq("conversation_id", conversationId)
    .or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${id})`)
    .order("created_at", { ascending: false }).order("id", { ascending: false })
    .limit(cappedLimit(PRIVATE_HISTORY_PAGE));
  if (read.error) throw read.error;
  const { rows, more } = boundedRows((read.data || []).filter((row) => row.conversation_id === conversationId && row.user_id === userId), PRIVATE_HISTORY_PAGE);
  const ids = rows.map((row) => row.id);
  const [reactions, marksFor] = await Promise.all([
    ids.length ? readReactions(client, ids) : [],
    // Saved, reminder and shared-document marks, as the member load reads them (ledger 770).
    earlierPageMarks(client, { sourceKind: "private", userId, ids }),
  ]);
  const oldest = rows[rows.length - 1];
  return {
    messages: [...rows].reverse().map((row) => ({
      ...row,
      reactions: reactions.filter((reaction) => reaction.private_message_id === row.id),
      ...marksFor(row.id),
    })),
    earlierCursor: more && oldest ? { createdAt: oldest.created_at, id: oldest.id } : null,
  };
}
