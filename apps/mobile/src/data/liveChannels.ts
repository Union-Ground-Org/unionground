import type { MobileSessionWriter, MobileWriteAcknowledgement } from '../services/supabase';
// Live chapter channels for authenticated members, backed by the real
// backend: chapter_spaces / chapter_threads / chapter_thread_posts,
// member_message_reactions (source_kind 'channel'), chapter_channel_polls
// with RPC-guarded votes, chapter_space_reads unread cursors, and the
// insert-only realtime stream on chapter_thread_posts.
//
// The store exposes the same surface as the seeded demo channelStore
// (src/data/demoChannels.ts), so the channel surfaces swap stores by mode.

import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

import type { ChannelMessage, ChannelPoll, ChannelReaction, DemoChannel } from './demoChannels';
import type { MessageHistoryCursor } from '../models/member';
import { channelPollIsClosed } from '../lib/channelPoll';
import { getSupabaseClient } from '../services/supabase';
import { createRequestGeneration, type RequestGeneration } from '../lib/requestGeneration';
import { isAuthoritativeReadRefusal, isReadRefusal } from '../lib/readRefusal';
import { reconcileOwnReactions } from '../../../../src/features/messaging/reactions.js';
import {
  classifyChannelActionError,
  classifyChannelLoadError,
  classifyMarkReadError,
  isMarkReadSpaceUnavailable,
  readLastChannelLoadDiagnosis,
  recordChannelLoadDiagnosis,
  resetChannelLoadDiagnosis,
  type ChannelLoadDiagnosis,
  type ChannelLoadFault,
} from '../lib/channelLoadDiagnosis';
import { channelLoadFailureNotice, messageInboxCopy } from '../lib/messageInboxCopy';
import {
  MESSAGE_REACTIONS,
  MESSAGE_REACTION_GLYPHS,
  isMessageReactionKind,
  isChannelPostUnread,
} from '../lib/messagingShared';

// BUG-UG-MESSAGE-REACTION-PARITY-20260904: this file used to carry its own
// kind→emoji map, which is how the phone and the browser ended up offering
// different reactions than the database allows. The map now comes from the
// generated contract, so it cannot drift from
// member_message_reactions_reaction_check.
export const REACTION_KIND_EMOJI: Record<string, string> = MESSAGE_REACTION_GLYPHS;
const MAX_CHANNEL_POSTS = 1_000;
// BUG-UG-NATIVE-CHANNEL-HIDES-POSTS-PAST-NEWEST-1000-20261110: the
// window above is the chapter's newest posts across every thread. When it is
// full, each thread pages back from the window's oldest post, one bounded page
// per read (useConversationHistory keeps what the screen opened).
export const CHANNEL_HISTORY_PAGE = 200;
const POST_COLUMNS = 'id,thread_id,author_id,body,body_es,author_name,author_initials,author_role,created_at,parent_post_id,mentioned_user_ids,chapter_threads!inner(id,space_id,chapter_spaces!inner(archived_at))';
// BUG-UG-MOBILE-CHAPTER-CHANNELS-CLASS-UNKNOWN-ON-DEVICE-20260918: a
// PostgREST identifier filter (`?column=in.(…)`) travels in the request line.
// The workspace gateway refuses a request line past roughly 24 KB with a
// plain-text `400 Bad Request` that never reaches PostgREST and therefore
// carries no PostgREST code. One chapter's channel history is already past
// that: the seeded SAMPLE chapter answers 700 posts, whose identifiers alone
// build a 26 KB request line, so every authorized member with a real chapter
// lost the whole surface to one refused request. Identifier lists are sent in
// bounded batches instead, so the request line stays the same small size
// whatever the chapter's size.
//
// The bound has a second, independent reason to stay small: the gateway echoes
// the whole query back in the response's `Content-Location` header, so a long
// request line also builds a long response header block. A 650-identifier read
// already overflows a strict HTTP client's header limit before any body is
// read, which is a client-side failure with no status at all. Raising this
// number therefore reintroduces two distinct faults, not one.
const MAX_FILTER_IDS_PER_REQUEST = 100;

type SpaceRow = { id: string; name: string; name_es?: string | null; description: string; description_es?: string | null; visibility: string };
type ThreadRow = { id: string; space_id: string; title?: string | null; status?: string | null; created_at: string; pinned_at?: string | null };
type PostRow = {
  id: string;
  thread_id: string;
  author_id: string;
  parent_post_id?: string | null;
  body: string;
  body_es?: string | null;
  author_name: string;
  author_initials: string;
  author_role: string | null;
  created_at: string;
  mentioned_user_ids?: string[] | null;
};
type ReactionRow = { channel_post_id: string; reaction: string; actor_id: string };
type ReadRow = { space_id: string; last_read_at: string };
type PollRow = { id: string; space_id: string; post_id: string | null; question: string; closes_at: string | null; created_at: string };
type TallyOption = { id: string; label: string; position: number; votes: number | null };
type Tally = { poll_id: string; question: string; closes_at: string | null; total: number | null; mine: string | null; options: TallyOption[] };

type LivePoll = ChannelPoll & { id: string; optionIDs: string[] };
export type ChannelLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

type ChannelRouteStore = {
  status(): ChannelLoadStatus;
  error(): string | null;
  loadFault?(): ChannelLoadFault | null;
  channel(id: string): DemoChannel | null;
};

export type ChannelRouteState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'missing' }
  | { kind: 'ready'; channel: DemoChannel };

export function resolveChannelRoute(store: ChannelRouteStore, id: string): ChannelRouteState {
  const channel = store.channel(id);
  if (channel) return { kind: 'ready', channel };
  if (store.status() === 'error') {
    return { kind: 'error', message: store.error() ?? 'Campaign channels could not be loaded.' };
  }
  if (store.status() === 'idle' || store.status() === 'loading') return { kind: 'loading' };
  return { kind: 'missing' };
}

let version = 0;
const listeners = new Set<() => void>();
function emit() {
  version += 1;
  listeners.forEach((listener) => listener());
}

// BUG-UG-WEB-TREATS-EACH-CHAPTER-THREAD-AS-ITS-OWN-INBOX-CONVERSATION-MOBILE-FLATTENS-20260921:
// one channel row per chapter_threads row, the same identity the browser's
// Messages inbox uses, so a member's reply lands in the thread they opened.
// The store used to flatten every thread of a space into one row and post
// every new message into the space's oldest thread. A space with no thread yet
// keeps one row under its own id so the composer can start the first thread.
let channels: DemoChannel[] = [];
// Channel (thread, or thread-less space) id → its chapter space id.
let spaceByChannel = new Map<string, string>();
// Thread-less space id → the thread this session's first send created in it.
let createdThreadBySpace = new Map<string, string>();
// Thread id → where its earlier posts start, while the newest window is full.
let earlierCursorByChannel = new Map<string, MessageHistoryCursor>();
// Post id → the thread and the latest copy of an earlier post this session
// read (or reacted to), so actions on a post shown from earlier history reach
// it. It only ever names posts the member's own reads returned.
// `step` is the newest information applied to the post's reactions (a read's
// start or a confirmed reaction), so a read that started earlier, landing
// late, never rolls them back.
let earlierPostByID = new Map<string, { channelID: string; message: LiveChannelMessage; step?: number }>();
let earlierStep = 0;
let windowReadStep = 0;
let activePoll: LivePoll | null = null;
// The channel whose message carries `activePoll`. Only that channel renders
// the poll, so a failed vote belongs to it.
let activePollChannelID: string | null = null;
let status: ChannelLoadStatus = 'idle';
let loadError: string | null = null;
let loadFault: ChannelLoadFault | null = null;
let readRefused = false;
let authoritativeReadRefused = false;
let consumers = 0;
let realtime: RealtimeChannel | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let loadSequence = 0;
const loadRequests = createRequestGeneration();
type HistoryReadLane = { before: MessageHistoryCursor; step: number; requests: RequestGeneration };
const historyRequests = new Map<string, Map<string, HistoryReadLane>>();

function invalidateLoads() {
  loadSequence += 1;
  loadRequests.invalidate();
}

// A full window answers for its range only. Older pages remain readable
// during ordinary refreshes; pages overlapping a newer window are retired.
function retireHistoryReads(channelID: string, coveredFrom?: MessageHistoryCursor | null, readStep = Infinity) {
  const lanes = historyRequests.get(channelID);
  if (!lanes) return;
  for (const [key, lane] of lanes) {
    if (lane.step > readStep) continue;
    const before = lane.before;
    if (coveredFrom && (before.createdAt < coveredFrom.createdAt
      || (before.createdAt === coveredFrom.createdAt && before.id <= coveredFrom.id))) continue;
    lane.requests.dispose();
    lanes.delete(key);
  }
  if (!lanes.size) historyRequests.delete(channelID);
}

function beginHistoryRead(channelID: string, before: MessageHistoryCursor) {
  const step = ++earlierStep;
  let lanes = historyRequests.get(channelID);
  if (!lanes) {
    lanes = new Map();
    historyRequests.set(channelID, lanes);
  }
  const key = JSON.stringify([before.createdAt, before.id]);
  let lane = lanes.get(key);
  if (!lane) {
    lane = { before: { ...before }, step, requests: createRequestGeneration() };
    lanes.set(key, lane);
  }
  lane.step = step;
  const owner = lanes;
  const current = lane;
  const ticket = current.requests.begin();
  return {
    ...ticket,
    step,
    finish() {
      if (!ticket.isCurrent() || owner.get(key) !== current) return;
      current.requests.dispose();
      owner.delete(key);
      if (!owner.size && historyRequests.get(channelID) === owner) historyRequests.delete(channelID);
    },
  };
}
// Session-scoped token for in-flight member writes (mark-read, reaction).
// Unrelated loadSequence bumps (refresh, realtime, confirmed reaction/reply)
// must not discard the acknowledgement; only a cache/session reset invalidates
// a pending write, so a response that lands after sign-out or an account switch
// cannot repopulate or clear the next session's state.
let sessionGeneration = 0;
const pendingReactions = new Map<string, number>();
// Per-space write sequence so a stale overlapping mark-read cannot overwrite
// a later success (or failure) for the same channel.
const markReadRequestBySpace = new Map<string, number>();
// load() sequences that started at or before a successful mark-read. Those
// fetches keep their posts/reactions/polls, but their unread cursor is stale.
// `cursor` is the newest server post timestamp the device held when the
// request started; only messages at or before it are treated as read.
type MarkReadAck = { loadSeq: number; cursor: string };
const markReadAckBySpace = new Map<string, MarkReadAck>();
// Per-space mark-read failures. load()/poll completion resets the shared
// diagnosis slot and must not hide these.
const markReadFaultBySpace = new Map<string, ChannelLoadDiagnosis>();
const threadCreationBySpace = new Map<string, Promise<string>>();

function dayLabel(iso: string): string {
  if (!Number.isFinite(Date.parse(iso))) return '';
  const date = new Date(iso);
  const today = new Date();
  const oneDay = 24 * 60 * 60 * 1000;
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = startOf(today) - startOf(date);
  if (diff <= 0) return 'Today';
  if (diff <= oneDay) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(date);
}

// The calendar day a post belongs to: older days share a weekday label, so
// day lines compare this key, never the label.
function dayKey(iso: string): string {
  if (!Number.isFinite(Date.parse(iso))) return '';
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function timeLabel(iso: string): string {
  if (!Number.isFinite(Date.parse(iso))) return '';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

type IdentifiedRow = { id: string; created_at: string };
type BatchedResult<Row> = { data: Row[] | null; error: unknown };

function identifierBatches(ids: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += MAX_FILTER_IDS_PER_REQUEST) {
    batches.push(ids.slice(index, index + MAX_FILTER_IDS_PER_REQUEST));
  }
  return batches;
}

// Ordering is a byte comparison, never a collation. An ISO-8601 timestamp with
// a fixed offset already sorts lexicographically, while `localeCompare` ranks
// the separators by the active locale's rules: ICU orders '.' after '+', so a
// whole-second `…:23+00:00` compared against a sub-second `…:23.500+00:00`
// answers "later" and the merged batches come back in a locale-dependent order.
function newestFirst(left: IdentifiedRow, right: IdentifiedRow): number {
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? 1 : -1;
  if (left.id !== right.id) return left.id < right.id ? 1 : -1;
  return 0;
}

function oldestFirst(left: IdentifiedRow, right: IdentifiedRow): number {
  return -newestFirst(left, right);
}

/**
 * Read every row matching an identifier list without ever building a request
 * line the workspace can refuse. An empty list issues no request at all, and a
 * failed batch throws the whole response — never `result.error` alone — so the
 * classifier still sees the HTTP status PostgREST keeps beside the error body.
 */
async function selectByIdentifiers<Row>(
  ids: readonly string[],
  select: (batch: string[]) => PromiseLike<BatchedResult<Row>>,
): Promise<Row[]> {
  const batches = identifierBatches(ids);
  if (!batches.length) return [];
  const results = await Promise.all(batches.map((batch) => select(batch)));
  const rows: Row[] = [];
  for (const result of results) {
    if (result.error) throw result;
    rows.push(...(result.data ?? []));
  }
  return rows;
}

async function fetchWorkspace(client: SupabaseClient, userID: string | null) {
  const spacesResult = await client.from('chapter_spaces')
    .select('id,name,name_es,description,description_es,visibility')
    .is('archived_at', null)
    .order('name');
  if (spacesResult.error) throw spacesResult;
  const spaces = (spacesResult.data ?? []) as SpaceRow[];
  const spaceIDs = spaces.map((space) => space.id);

  const [threadRows, readsResult, pollRows] = await Promise.all([
    selectByIdentifiers<ThreadRow>(spaceIDs, (batch) => client.from('chapter_threads')
      .select('id,space_id,title,status,created_at,pinned_at').in('space_id', batch).order('created_at')),
    client.from('chapter_space_reads').select('space_id,last_read_at'),
    selectByIdentifiers<PollRow>(spaceIDs, (batch) => client.from('chapter_channel_polls')
      .select('id,space_id,post_id,question,closes_at,created_at').in('space_id', batch)
      .order('created_at', { ascending: false })),
  ]);
  if (readsResult.error) throw readsResult;
  const reads = (readsResult.data ?? []) as ReadRow[];
  // Batching moves ordering off the server for merged lists, so the merged
  // rows are re-ordered here: the first thread of a space and the newest poll
  // stay the rows one unbounded request would have produced.
  const threads = threadRows.slice().sort(oldestFirst);
  const polls = pollRows.slice().sort(newestFirst);

  const threadIDs = threads.map((thread) => thread.id);
  const knownThreadIDs = new Set(threadIDs);
  // PERF-UG-MOBILE-CHANNEL-POSTS-LIMIT-APPLIED-PER-BATCH-20260918: a
  // per-batch `.limit(MAX_CHANNEL_POSTS)` on the 100-thread identifier split
  // downloaded ceil(threads/100)×1000 bodies to keep 1000. The recent window
  // is one globally ordered read of the same non-archived spaces this load
  // kept; the inner join applies that scope before the cap so archived-space
  // posts cannot occupy the window. Order is (created_at, id) in the query
  // itself so equal timestamps at the cap are deterministic. Identifier-list
  // batching stays on threads, polls, and reactions, whose request lines
  // still carry the ids.
  const postsResult = await client.from('chapter_thread_posts')
    .select(POST_COLUMNS)
    .is('deleted_at', null)
    .is('chapter_threads.chapter_spaces.archived_at', null)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(MAX_CHANNEL_POSTS);
  if (postsResult.error) throw postsResult;
  const windowRows = (postsResult.data ?? []) as PostRow[];
  // A full window may have cut older posts off every thread: each one starts
  // its earlier history at the window's oldest post.
  const windowOldest = windowRows.length >= MAX_CHANNEL_POSTS ? windowRows[windowRows.length - 1] : undefined;
  const earlierBefore: MessageHistoryCursor | null = windowOldest ? { createdAt: windowOldest.created_at, id: windowOldest.id } : null;
  const postRows = windowRows.filter((post) => knownThreadIDs.has(post.thread_id));
  // Newest first across every loaded thread, capped at MAX_CHANNEL_POSTS, then
  // restored to display order. The server already used (created_at, id).
  const posts = postRows.slice().sort(newestFirst).slice(0, MAX_CHANNEL_POSTS).reverse();

  const postIDs = posts.map((post) => post.id);
  const reactions = await selectByIdentifiers<ReactionRow>(postIDs, (batch) => client.from('member_message_reactions')
    .select('channel_post_id,reaction,actor_id')
    .eq('source_kind', 'channel')
    .in('channel_post_id', batch));

  const openPoll = polls.find((poll) => !poll.closes_at || new Date(poll.closes_at).getTime() > Date.now()) ?? polls[0] ?? null;
  let tally: Tally | null = null;
  let pollUnavailable = false;
  let pollDiagnosis: ChannelLoadDiagnosis | null = null;
  if (openPoll) {
    try {
      const tallyResult = await client.rpc('get_channel_poll_tally', { p_poll_id: openPoll.id });
      if (tallyResult.error) {
        pollDiagnosis = {
          class: classifyChannelLoadError(tallyResult),
          op: 'poll-tally',
        };
        pollUnavailable = true;
      } else {
        tally = tallyResult.data as Tally;
      }
    } catch (error) {
      pollDiagnosis = {
        class: classifyChannelLoadError(error),
        op: 'poll-tally',
      };
      pollUnavailable = true;
    }
  }

  return { spaces, threads, reads, posts, reactions, openPoll, tally, pollUnavailable, pollDiagnosis, userID, earlierBefore };
}

function reactionsByPostID(rows: readonly ReactionRow[], userID: string | null): Map<string, ChannelReaction[]> {
  const reactionsByPost = new Map<string, ChannelReaction[]>();
  for (const row of rows) {
    if (!isMessageReactionKind(row.reaction)) continue;
    const emoji = REACTION_KIND_EMOJI[row.reaction] ?? '•';
    const list = reactionsByPost.get(row.channel_post_id) ?? [];
    const existing = list.find((entry) => entry.kind === row.reaction);
    const mine = userID != null && row.actor_id === userID;
    if (existing) {
      existing.count += 1;
      existing.mine = existing.mine || mine;
    } else {
      list.push({ kind: row.reaction, emoji, count: 1, mine });
      reactionsByPost.set(row.channel_post_id, list);
    }
  }
  // Contract order, not arrival order, so a message reads the same on every
  // device and after every refetch.
  for (const list of reactionsByPost.values()) {
    list.sort((left, right) => MESSAGE_REACTIONS.findIndex((entry) => entry.kind === left.kind)
      - MESSAGE_REACTIONS.findIndex((entry) => entry.kind === right.kind));
  }
  return reactionsByPost;
}

/** A live channel message always carries its server time; earlier history orders by it. */
export type LiveChannelMessage = ChannelMessage & { createdAt: string };

// The fields a post shows wherever it was read; the window adds the day line,
// the unread divider and the poll marker.
function postMessage(post: PostRow, reactions: ChannelReaction[] | undefined, userID: string | null): LiveChannelMessage {
  return {
    id: post.id,
    author: post.author_name || 'Campaign worker',
    initials: post.author_initials || '·',
    role: post.author_role === 'president' ? 'CAMPAIGN CHAIR' : post.author_role === 'steward' ? 'COMMITTEE' : undefined,
    time: timeLabel(post.created_at),
    createdAt: post.created_at,
    body: post.body,
    bodyEs: post.body_es,
    parentMessageID: post.parent_post_id ?? null,
    // An accepted empty read must override a kept page's older reactions.
    reactions: reactions ?? [],
    mentionsMe: userID != null && Array.isArray(post.mentioned_user_ids) && post.mentioned_user_ids.includes(userID) ? true : undefined,
    // The viewer's own post is never unread for them, including when a later
    // mark-read overlay recounts this message without the author column.
    mine: userID != null && post.author_id === userID ? true : undefined,
  };
}

/**
 * The day line once per day across a thread's merged history: a page read
 * earlier and the window above it may both start on the same day.
 */
export function withChannelDayLines<Message extends ChannelMessage>(messages: readonly Message[]): Message[] {
  let previous: string | null = null;
  return messages.map((message) => {
    if (!message.createdAt) return message;
    const key = dayKey(message.createdAt);
    const shown = key === previous ? undefined : dayLabel(message.createdAt);
    previous = key;
    return message.day === shown ? message : { ...message, day: shown };
  });
}

function assemble(data: Awaited<ReturnType<typeof fetchWorkspace>>, readStep: number) {
  const previousChannels = channels;
  const previousWindowStep = windowReadStep;
  windowReadStep = readStep;
  // The raw cursor value travels to the shared contract, which owns the
  // parsing rule as well as the comparison.
  const lastReadBySpace = new Map(data.reads.map((row) => [row.space_id, row.last_read_at]));
  const spaceByThread = new Map(data.threads.map((thread) => [thread.id, thread.space_id]));
  const threadsBySpace = new Map<string, ThreadRow[]>();
  for (const thread of data.threads) {
    const list = threadsBySpace.get(thread.space_id) ?? [];
    list.push(thread);
    threadsBySpace.set(thread.space_id, list);
  }

  const reactionsByPost = reactionsByPostID(data.reactions, data.userID);

  const pollPostID = data.openPoll?.post_id ?? null;
  const postsByThread = new Map<string, PostRow[]>();
  for (const post of data.posts) {
    if (!spaceByThread.has(post.thread_id)) continue;
    const list = postsByThread.get(post.thread_id) ?? [];
    list.push(post);
    postsByThread.set(post.thread_id, list);
  }
  // The poll renders in the thread holding its post; a poll without a loaded
  // post belongs to the first row of its space.
  const pollSpaceID = data.openPoll?.space_id ?? null;
  const pollPostThread = pollPostID ? data.posts.find((post) => post.id === pollPostID)?.thread_id : undefined;
  const pollChannelID = !pollSpaceID
    ? null
    : pollPostThread && spaceByThread.get(pollPostThread) === pollSpaceID
      ? pollPostThread
      : threadsBySpace.get(pollSpaceID)?.[0]?.id ?? pollSpaceID;

  const nextSpaceByChannel = new Map<string, string>();
  // BUG-UG-MOBILE-CHANNEL-REPLIES-TARGET-THREAD-ID-AND-RESOLVED-THREAD-COMPOSE-20260926:
  // a thread whose status is not `open` refuses posts and replies (RLS on
  // chapter_thread_posts and reply_to_member_message). The row carries that so
  // the screen can close its composer instead of inviting a refused write.
  const rows: { id: string; name: string; nameEs?: string | null; topic: string; topicEs?: string | null; space: SpaceRow; spacePosts: PostRow[]; closed: boolean; pinnedAt: string | null }[] = [];
  for (const space of data.spaces) {
    const spaceThreads = threadsBySpace.get(space.id) ?? [];
    if (!spaceThreads.length) {
      rows.push({ id: space.id, name: space.name, nameEs: space.name_es, topic: space.description, topicEs: space.description_es, space, spacePosts: [], closed: false, pinnedAt: null });
    }
    for (const thread of spaceThreads) {
      const title = thread.title?.trim();
      rows.push({
        id: thread.id,
        name: title || space.name,
        nameEs: title && title !== space.name ? null : space.name_es,
        topic: title ? space.name : space.description,
        topicEs: title ? space.name_es : space.description_es,
        space,
        spacePosts: postsByThread.get(thread.id) ?? [],
        closed: thread.status != null && thread.status !== 'open',
        pinnedAt: thread.pinned_at ?? null,
      });
    }
  }

  channels = rows.map(({ id, name, nameEs, topic, topicEs, space, spacePosts, closed, pinnedAt }) => {
    nextSpaceByChannel.set(id, space.id);
    // The read cursor is the space's (mark_chapter_space_read); each thread
    // row counts its own posts against it, exactly as the browser does, so a
    // badge always matches the cursor on both clients.
    const lastRead = lastReadBySpace.get(space.id) ?? null;
    let unread = 0;
    let dividerPlaced = false;
    let previousDay: string | null = null;
    const messages: ChannelMessage[] = spacePosts.map((post) => {
      // TEST-UG-SHARED-UNREAD-CONTRACT: the cursor comparison, its
      // exactly-equal tie-break and its unparseable-timestamp behaviour all come
      // from the shared module the browser uses.
      const isUnread = isChannelPostUnread(post, lastRead, data.userID);
      if (isUnread) unread += 1;
      const day = dayKey(post.created_at);
      const message: ChannelMessage = {
        ...postMessage(post, reactionsByPost.get(post.id), data.userID),
        day: day === previousDay ? undefined : dayLabel(post.created_at),
        newDivider: isUnread && !dividerPlaced ? true : undefined,
        poll: post.id === pollPostID ? true : undefined,
      };
      const known = earlierPostByID.get(post.id);
      if (known?.channelID === id && (known.step ?? 0) > readStep) message.reactions = known.message.reactions;
      if (isUnread) dividerPlaced = true;
      previousDay = day;
      return message;
    });
    return {
      id,
      name,
      nameEs,
      locked: space.visibility !== 'chapter' ? true : undefined,
      unread,
      topic,
      topicEs,
      messages,
      // The reply RPCs take the chapter_spaces id, never this row's thread id.
      spaceID: space.id,
      closed: closed ? true : undefined,
      pinnedAt: pinnedAt ?? undefined,
      pollUnavailable: data.pollUnavailable && pollChannelID === id ? true : undefined,
    };
  });

  spaceByChannel = nextSpaceByChannel;
  // Every thread row (never a thread-less space row) may hold posts older
  // than a full window.
  const before = data.earlierBefore;
  earlierCursorByChannel = new Map(before ? rows.filter((row) => row.id !== row.space.id).map((row) => [row.id, before]) : []);
  // A thread this load no longer shows keeps none of its earlier posts.
  const shownChannels = new Set(rows.map((row) => row.id));
  for (const channelID of historyRequests.keys()) {
    if (shownChannels.has(channelID)) retireHistoryReads(channelID, before, readStep);
    else retireHistoryReads(channelID);
  }
  const windowMessages = new Map(channels.map((channel) => [channel.id, new Map(channel.messages.map((message) => [message.id, message]))]));
  // Preserve the ordering fence when an earlier post reenters the window.
  // A covered post omitted by the window is gone and loses its action target.
  for (const [postID, entry] of earlierPostByID) {
    const at = entry.message.createdAt;
    if (!shownChannels.has(entry.channelID)) { earlierPostByID.delete(postID); continue; }
    if (!before || at > before.createdAt || (at === before.createdAt && postID >= before.id)) {
      const current = windowMessages.get(entry.channelID)?.get(postID);
      if (current?.createdAt === undefined) earlierPostByID.delete(postID);
      else earlierPostByID.set(postID, { channelID: entry.channelID, message: { ...current, createdAt: current.createdAt }, step: Math.max(entry.step ?? 0, readStep) });
    }
  }
  // A window post that a fuller window pushed out (older than its oldest post)
  // can stay on screen in the thread's opened history, so it stays an action
  // target; one that left inside the window's range was removed and does not.
  if (before) {
    const windowIDs = new Map(channels.map((channel) => [channel.id, new Set(channel.messages.map((message) => message.id))]));
    for (const previous of previousChannels) {
      const stillShown = windowIDs.get(previous.id);
      if (!stillShown) continue;
      for (const message of previous.messages) {
        const at = message.createdAt;
        if (stillShown.has(message.id) || at === undefined || earlierPostByID.has(message.id)) continue;
        if (at < before.createdAt || (at === before.createdAt && message.id < before.id)) {
          earlierPostByID.set(message.id, { channelID: previous.id, message: { ...message, createdAt: at }, step: previousWindowStep });
        }
      }
    }
  }
  for (const spaceID of createdThreadBySpace.keys()) {
    if (nextSpaceByChannel.get(spaceID) !== spaceID) createdThreadBySpace.delete(spaceID);
  }
  activePoll = data.tally
    ? {
        id: data.tally.poll_id,
        question: data.tally.question,
        closesAt: data.tally.closes_at,
        options: data.tally.options.map((option) => ({ label: option.label, votes: option.votes })),
        optionIDs: data.tally.options.map((option) => option.id),
        mine: data.tally.mine ? data.tally.options.findIndex((option) => option.id === data.tally?.mine) : null,
      }
    : null;
  activePollChannelID = activePoll ? pollChannelID : null;
  if (activePoll && activePoll.mine === -1) activePoll.mine = null;
}

function applyTally(tally: Tally) {
  activePoll = {
    id: tally.poll_id,
    question: tally.question,
    closesAt: tally.closes_at,
    options: tally.options.map((option) => ({ label: option.label, votes: option.votes })),
    optionIDs: tally.options.map((option) => option.id),
    mine: tally.mine ? tally.options.findIndex((option) => option.id === tally.mine) : null,
  };
  if (activePoll.mine === -1) activePoll.mine = null;
  emit();
}

function applyLoadFault(fault: ChannelLoadFault, message: string) {
  status = channels.length ? 'ready' : 'error';
  loadFault = fault;
  loadError = message;
}

/**
 * A route may still name a chapter space (an older link, or a space with no
 * thread yet). It resolves to that space's only row. A space with several
 * threads is ambiguous and resolves to nothing, so no send, reaction or read
 * can land in a thread the member did not open.
 */
function resolveChannel(id: string): DemoChannel | null {
  const exact = channels.find((entry) => entry.id === id);
  if (exact) return exact;
  const inSpace = channels.filter((entry) => spaceByChannel.get(entry.id) === id);
  return inSpace.length === 1 ? inSpace[0]! : null;
}

function channelsInSpace(spaceID: string): DemoChannel[] {
  return channels.filter((entry) => spaceByChannel.get(entry.id) === spaceID);
}

function overlayAcknowledgedUnread(channel: DemoChannel, cursor: string) {
  let unread = 0;
  let dividerPlaced = false;
  for (const message of channel.messages) {
    const isUnread = isChannelPostUnread(message, cursor);
    if (isUnread) unread += 1;
    message.newDivider = isUnread && !dividerPlaced ? true : undefined;
    if (isUnread) dividerPlaced = true;
  }
  channel.unread = unread;
}

function forgetEarlierHistory(channelID: string) {
  retireHistoryReads(channelID);
  earlierCursorByChannel.delete(channelID);
  for (const [postID, entry] of earlierPostByID) if (entry.channelID === channelID) earlierPostByID.delete(postID);
}

// A post the member sees in this thread: in the window, or on an earlier page
// this session read for it.
function shownPost(channelID: string, messageID: string): ChannelMessage | null {
  const channel = resolveChannel(channelID);
  if (!channel) return null;
  const inWindow = channel.messages.find((entry) => entry.id === messageID);
  if (inWindow) return inWindow;
  const earlier = earlierPostByID.get(messageID);
  return earlier && earlier.channelID === channel.id ? earlier.message : null;
}

// A confirmed reaction keeps its fence even while its post moves into and
// out of the newest window. Earlier reads cannot roll it back.
function rememberConfirmedReaction(channelID: string, messageID: string, message: ChannelMessage) {
  const channel = resolveChannel(channelID);
  if (!channel || message.createdAt === undefined) return;
  earlierPostByID.set(messageID, { channelID: channel.id, message: { ...message, createdAt: message.createdAt }, step: ++earlierStep });
}

function evictSpace(id: string) {
  for (const entry of channels) if (spaceByChannel.get(entry.id) === id) forgetEarlierHistory(entry.id);
  channels = channels.filter((entry) => spaceByChannel.get(entry.id) !== id);
  createdThreadBySpace.delete(id);
  threadCreationBySpace.delete(id);
  markReadAckBySpace.delete(id);
  markReadRequestBySpace.delete(id);
}

function applyAcknowledgedMarkReads(loadSeq: number) {
  for (const [spaceId, ack] of markReadAckBySpace) {
    if (loadSeq > ack.loadSeq) {
      markReadAckBySpace.delete(spaceId);
      continue;
    }
    for (const channel of channelsInSpace(spaceId)) overlayAcknowledgedUnread(channel, ack.cursor);
  }
}

function applyMarkReadFault(value: unknown, spaceId: string) {
  const classified = classifyMarkReadError(value);
  const diagnosis: ChannelLoadDiagnosis = { class: classified, op: 'mark_read', spaceId };
  markReadFaultBySpace.set(spaceId, diagnosis);
  recordChannelLoadDiagnosis(diagnosis);
  loadError = messageInboxCopy.en.markReadError;
  if (isMarkReadSpaceUnavailable(value)) evictSpace(spaceId);
  emit();
}

// The RPC stores database now() for the whole space and returns nothing. Every
// post this device already holds in that space predates that cursor, so the
// newest held post timestamp (a server value) bounds the overlay without
// trusting the device clock.
function markReadBoundary(spaceID: string): string {
  let latest = '';
  for (const channel of channelsInSpace(spaceID)) {
    for (const message of channel.messages) {
      const at = message.createdAt;
      if (at && (!latest || Date.parse(at) > Date.parse(latest))) latest = at;
    }
  }
  return latest;
}

function applyMarkReadSuccess(id: string, cursor: string) {
  const spaceChannels = channelsInSpace(id);
  if (!spaceChannels.length) return;
  // Remember this load generation so an in-flight refresh can keep its
  // posts/reactions/polls without resurrecting the pre-mark unread count.
  // Posts newer than the boundary stay unread until a later load (or the
  // screen's next markRead) confirms them.
  markReadAckBySpace.set(id, { loadSeq: loadSequence, cursor });
  for (const channel of spaceChannels) overlayAcknowledgedUnread(channel, cursor);
  markReadFaultBySpace.delete(id);
  const last = readLastChannelLoadDiagnosis();
  if (last?.op === 'mark_read' && last.spaceId === id) {
    resetChannelLoadDiagnosis();
  }
  if (!markReadFaultBySpace.size && loadError === messageInboxCopy.en.markReadError) {
    loadError = null;
  }
  emit();
}

async function load() {
  const sequence = ++loadSequence;
  const request = loadRequests.begin();
  const readStep = ++earlierStep;
  const client = getSupabaseClient();
  if (!client) {
    recordChannelLoadDiagnosis({ class: 'unknown', op: 'load' });
    applyLoadFault(
      'unknown',
      channelLoadFailureNotice(messageInboxCopy.en, 'unknown')
        ?? 'Campaign channels could not be loaded securely. Pull to refresh and try again.',
    );
    emit();
    return;
  }
  status = channels.length ? 'ready' : 'loading';
  emit();
  try {
    const session = await client.auth.getSession();
    if (!request.isCurrent()) return;
    const userID = session.data.session?.user.id ?? null;
    const data = await fetchWorkspace(client, userID);
    if (!request.isCurrent()) return;
    assemble(data, readStep);
    applyAcknowledgedMarkReads(sequence);
    // A write whose response was lost may still have committed; once the
    // loaded cursor shows nothing unread, the failure notice is stale.
    for (const spaceId of markReadFaultBySpace.keys()) {
      const spaceChannels = channelsInSpace(spaceId);
      if (spaceChannels.length && spaceChannels.every((entry) => entry.unread === 0)) markReadFaultBySpace.delete(spaceId);
    }
    status = 'ready';
    loadError = null;
    loadFault = null;
    readRefused = false;
    authoritativeReadRefused = false;
    if (data.pollDiagnosis) recordChannelLoadDiagnosis(data.pollDiagnosis);
    else resetChannelLoadDiagnosis();
  } catch (error) {
    if (!request.isCurrent()) return;
    // Preserve the authoritative decision separately from diagnostic classes:
    // a codeless 403 is a request fault, but still refuses this read. Transport
    // failures do not retire a draft or undo an earlier refusal.
    if (isReadRefusal(error) || (typeof error === 'object' && error !== null && 'error' in error && isReadRefusal(error.error))) readRefused = true;
    if (isAuthoritativeReadRefusal(error) || (typeof error === 'object' && error !== null && 'error' in error && isAuthoritativeReadRefusal(error.error))) authoritativeReadRefused = true;
    const classified = classifyChannelLoadError(error);
    recordChannelLoadDiagnosis({ class: classified, op: 'load' });
    if (classified === 'authorized-empty') {
      for (const channelID of historyRequests.keys()) retireHistoryReads(channelID);
      channels = [];
      spaceByChannel = new Map();
      earlierCursorByChannel = new Map();
      earlierPostByID = new Map();
      createdThreadBySpace = new Map();
      threadCreationBySpace.clear();
      activePoll = null;
      activePollChannelID = null;
      status = 'ready';
      loadError = null;
      loadFault = null;
    } else {
      applyLoadFault(
        classified,
        channelLoadFailureNotice(messageInboxCopy.en, classified) ?? 'Campaign channels could not be loaded securely. Pull to refresh and try again.',
      );
    }
  }
  emit();
}

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void load();
  }, 400);
}

function startRealtime() {
  const client = getSupabaseClient();
  if (!client || realtime) return;
  // Insert-only stream (see 20260820150000 privacy review); RLS scopes each
  // payload to subscribers who can read the space. Any insert triggers a
  // debounced refetch, which also refreshes reactions and poll tallies.
  realtime = client
    .channel('chapter-thread-posts')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chapter_thread_posts' }, () => {
      scheduleRefresh();
    })
    .subscribe();
}

function stopRealtime() {
  const client = getSupabaseClient();
  if (client && realtime) void client.removeChannel(realtime).catch(() => undefined);
  realtime = null;
}

function clearAuthorizedCache() {
  // This module outlives the authenticated React tree. Invalidate any pending
  // load and purge every user-scoped row before another session can mount.
  invalidateLoads();
  for (const channelID of historyRequests.keys()) retireHistoryReads(channelID);
  windowReadStep = 0;
  sessionGeneration += 1;
  pendingReactions.clear();
  markReadRequestBySpace.clear();
  markReadAckBySpace.clear();
  markReadFaultBySpace.clear();
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  channels = [];
  spaceByChannel = new Map();
  earlierCursorByChannel = new Map();
  earlierPostByID = new Map();
  createdThreadBySpace = new Map();
  threadCreationBySpace.clear();
  activePoll = null;
  activePollChannelID = null;
  status = 'idle';
  loadError = null;
  loadFault = null;
  readRefused = false;
  authoritativeReadRefused = false;
  // A send/reaction/vote notice belongs to the session that raised it; the next
  // account must not inherit it.
  lastSendDiagnosis = null;
  clearActionFailure();
  resetChannelLoadDiagnosis();
  emit();
}

let lastSendDiagnosis: ChannelLoadDiagnosis | null = null;
// Each failed reaction or vote is retained under the action it belongs to:
// its kind, the chapter space it was attempted in, and its target (the poll for
// a vote, the message and reaction for a reaction). A success clears only the
// entry with the same key, so an unrelated reaction, or an action in another
// channel, cannot erase a vote that was never saved. Every attempt takes the
// next number and the latest attempt on a key wins, so an earlier completion
// cannot erase the newer failure the member has not seen yet.
type ActionOutcome = { attempt: number; spaceID: string | null; diagnosis: ChannelLoadDiagnosis | null };
const actionOutcomes = new Map<string, ActionOutcome>();
let actionSequence = 0;

function actionKey(op: 'reaction' | 'vote', spaceID: string | null, target: string): string {
  return JSON.stringify([op, spaceID, target]);
}

// Actions are scoped to the channel row, whichever id (thread or its space)
// the caller used to name it.
function channelScope(id: string): string {
  return resolveChannel(id)?.id ?? id;
}

type ChannelActionResult = { data?: unknown; error?: unknown };

function rememberSendFailure(error: unknown): ChannelLoadDiagnosis {
  lastSendDiagnosis = recordChannelLoadDiagnosis({
    class: classifyChannelLoadError(error),
    op: 'send',
  });
  return lastSendDiagnosis;
}

/** Retain a failure under its action key unless a newer attempt on that key already settled. */
function rememberActionFailure(
  op: 'reaction' | 'vote',
  error: unknown,
  spaceID: string | null,
  target: string,
  attempt: number,
): boolean {
  const key = actionKey(op, spaceID, target);
  if ((actionOutcomes.get(key)?.attempt ?? 0) > attempt) return false;
  actionOutcomes.set(key, {
    attempt,
    spaceID,
    diagnosis: recordChannelLoadDiagnosis({
      // Both write RPCs raise 42501 for an absent caller or an unsatisfied MFA,
      // which the load classifier would report as an authorized-empty inbox.
      class: classifyChannelActionError(error),
      op,
    }),
  });
  return true;
}

/** A success clears only its own action's failure, and only if no newer attempt on it settled. */
function clearActionFailureOnSuccess(
  op: 'reaction' | 'vote',
  spaceID: string | null,
  target: string,
  attempt: number,
): boolean {
  const key = actionKey(op, spaceID, target);
  const retained = actionOutcomes.get(key);
  if ((retained?.attempt ?? 0) > attempt) return false;
  actionOutcomes.set(key, { attempt, spaceID, diagnosis: null });
  return Boolean(retained?.diagnosis);
}

function clearActionFailure() {
  actionOutcomes.clear();
}

/** The most recent retained failure, optionally only those attempted in `spaceID`. */
function latestActionFailure(spaceID?: string): ChannelLoadDiagnosis | null {
  let latest: ActionOutcome | null = null;
  for (const outcome of actionOutcomes.values()) {
    if (!outcome.diagnosis) continue;
    if (spaceID !== undefined && outcome.spaceID !== channelScope(spaceID)) continue;
    if (!latest || outcome.attempt > latest.attempt) latest = outcome;
  }
  return latest?.diagnosis ?? null;
}

export const liveChannelStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  getVersion: () => version,
  status: () => status,
  error: () => loadError,
  loadFault: () => loadFault,
  readRefused: () => readRefused,
  authoritativeReadRefused: () => authoritativeReadRefused,
  diagnosis: () => readLastChannelLoadDiagnosis(),
  markReadFault: (id: string) => {
    const channel = resolveChannel(id);
    const spaceID = channel ? spaceByChannel.get(channel.id) ?? id : id;
    return markReadFaultBySpace.get(spaceID) ?? null;
  },
  // Lifecycle: screens acquire on mount (authenticated mode only) and release
  // on unmount; realtime and cached data live while any consumer is mounted.
  acquire() {
    consumers += 1;
    if (consumers === 1) {
      void load();
      startRealtime();
    } else if (status === 'error') {
      void load();
    }
  },
  release() {
    consumers = Math.max(0, consumers - 1);
    if (consumers === 0) {
      stopRealtime();
      clearAuthorizedCache();
    }
  },
  resetForSession() {
    stopRealtime();
    clearAuthorizedCache();
    if (consumers > 0) {
      void load();
      startRealtime();
    }
  },
  async hydrateSource(threadID: string, postID: string): Promise<boolean> {
    const client = getSupabaseClient();
    if (!client) return false;
    const sequence = loadSequence;
    const unavailable = () => {
      if (sequence === loadSequence && channels.some((row) => row.id === threadID)) {
        channels = channels.filter((row) => row.id !== threadID);
        spaceByChannel.delete(threadID);
        forgetEarlierHistory(threadID);
        emit();
      }
      return false;
    };
    const context: { data: unknown; error: unknown } = await client.rpc('get_connected_workflow_context', { p_kind: 'channel_post', p_id: postID });
    if (context.error) throw context.error;
    const source = context.data as { available?: boolean; state?: string } | null;
    if (!source?.available || source.state === 'removed') return unavailable();
    const [postResult, threadResult] = await Promise.all([
      client.from('chapter_thread_posts').select('id,thread_id,author_id,parent_post_id,body,body_es,author_name,author_initials,author_role,created_at').eq('id', postID).eq('thread_id', threadID).is('deleted_at', null).maybeSingle<PostRow>(),
      client.from('chapter_threads').select('id,space_id,title,status').eq('id', threadID).maybeSingle<ThreadRow>(),
    ]);
    if (postResult.error) throw postResult.error;
    if (threadResult.error) throw threadResult.error;
    if (!postResult.data || !threadResult.data) return unavailable();
    const spaceResult = await client.from('chapter_spaces').select('id,name,name_es,description,description_es,visibility').eq('id', threadResult.data.space_id).maybeSingle<SpaceRow>();
    if (spaceResult.error) throw spaceResult.error;
    if (!spaceResult.data || sequence !== loadSequence) return false;
    const post = postResult.data as PostRow;
    const prior = channels.find((row) => row.id === threadID);
    const exact: ChannelMessage = {
      id: post.id, author: post.author_name || 'Coworker', initials: post.author_initials || '·',
      body: post.body, bodyEs: post.body_es, createdAt: post.created_at, time: timeLabel(post.created_at), parentMessageID: post.parent_post_id,
      reactions: prior?.messages.find((row) => row.id === postID)?.reactions,
    };
    const space = spaceResult.data as SpaceRow;
    const title = threadResult.data.title?.trim();
    const landed: DemoChannel = {
      ...(prior ?? { unread: 0 }), id: threadID, name: title || space.name,
      nameEs: title && title !== space.name ? null : space.name_es,
      topic: space.description, topicEs: space.description_es, locked: space.visibility !== 'chapter', spaceID: space.id,
      closed: threadResult.data.status !== 'open',
      messages: [...(prior?.messages ?? []).filter((row) => row.id !== postID), exact]
        .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id)),
    };
    if (JSON.stringify(prior) !== JSON.stringify(landed)) {
      channels = [...channels.filter((row) => row.id !== threadID), landed];
      spaceByChannel.set(threadID, space.id);
      emit();
    }
    return true;
  },
  acceptConfirmedActions(channelID: string, messageID: string, reactions: string[]) {
    const message = shownPost(channelID, messageID);
    if (!message) return;
    invalidateLoads();
    message.reactions = reconcileOwnReactions(message.reactions ?? [], reactions).map((entry) => ({ ...entry, emoji: entry.glyph }));
    rememberConfirmedReaction(channelID, messageID, message);
    emit();
  },
  acceptConfirmedReply(channelID: string, post: PostRow) {
    const channel = resolveChannel(channelID);
    if (!channel || channel.messages.some((message) => message.id === post.id)) return;
    // Invalidate reads started before the write acknowledgement.
    invalidateLoads();
    channel.messages.push({ id: post.id, author: post.author_name, initials: post.author_initials,
      time: timeLabel(post.created_at), createdAt: post.created_at, body: post.body, bodyEs: post.body_es, parentMessageID: post.parent_post_id });
    channel.messages.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));
    emit();
  },
  refresh: () => load(),
  /** The reactions on a post shown from earlier history, as last read or confirmed. */
  earlierReactions: (messageID: string): ChannelReaction[] | undefined => earlierPostByID.get(messageID)?.message.reactions,
  /** Where this thread's earlier posts start, or null when the window holds them all. */
  earlierCursor: (channelID: string): MessageHistoryCursor | null => {
    const channel = resolveChannel(channelID);
    return channel ? earlierCursorByChannel.get(channel.id) ?? null : null;
  },
  // BUG-UG-NATIVE-CHANNEL-HIDES-POSTS-PAST-NEWEST-1000-20261110: one
  // bounded page of the thread's posts strictly before `before`, oldest first,
  // with the next cursor when the page was full. It reads exactly what the
  // window reads (the member's own row access, the same thread, posts not
  // deleted, spaces not archived) and nothing that landed after a sign-out or
  // an account change.
  async earlierPosts(channelID: string, before: MessageHistoryCursor): Promise<{ messages: LiveChannelMessage[]; earlierCursor: MessageHistoryCursor | null }> {
    const channel = resolveChannel(channelID);
    const request = beginHistoryRead(channel?.id ?? channelID, before);
    try {
      const client = getSupabaseClient();
      if (!client || !channel || channel.id === spaceByChannel.get(channel.id)) throw new Error('Earlier messages did not load. Try again.');
      const readStep = request.step;
      const session = await client.auth.getSession();
      request.assertCurrent();
      const userID = session.data.session?.user.id ?? null;
      const at = JSON.stringify(before.createdAt);
      const id = JSON.stringify(before.id);
      const result = await client.from('chapter_thread_posts')
        .select(POST_COLUMNS)
        .eq('thread_id', channel.id)
        .is('deleted_at', null)
        .is('chapter_threads.chapter_spaces.archived_at', null)
        .or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${id})`)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(CHANNEL_HISTORY_PAGE);
      request.assertCurrent();
      if (result.error) throw result;
      const newestFirst = ((result.data ?? []) as PostRow[]).filter((post) => post.thread_id === channel.id);
      const reactions = await selectByIdentifiers<ReactionRow>(newestFirst.map((post) => post.id), (batch) => client.from('member_message_reactions')
        .select('channel_post_id,reaction,actor_id')
        .eq('source_kind', 'channel')
        .in('channel_post_id', batch));
      request.assertCurrent();
      const byPost = reactionsByPostID(reactions, userID);
      const oldest = newestFirst[newestFirst.length - 1];
      const messages = [...newestFirst].reverse().map((post) => postMessage(post, byPost.get(post.id), userID));
      // This page is the thread's posts strictly before `before` and, when it
      // is full, back to its oldest post: a remembered post in that range that
      // it no longer returns was removed or hidden, so it stops being a target.
      const returned = new Set(messages.map((message) => message.id));
      const inPage = (message: LiveChannelMessage) => (message.createdAt < before.createdAt || (message.createdAt === before.createdAt && message.id < before.id))
        && (newestFirst.length < CHANNEL_HISTORY_PAGE || !oldest || message.createdAt > oldest.created_at || (message.createdAt === oldest.created_at && message.id >= oldest.id));
      for (const [postID, entry] of earlierPostByID) {
        if (entry.channelID === channel.id && !returned.has(postID) && inPage(entry.message) && (entry.step ?? 0) <= readStep) earlierPostByID.delete(postID);
      }
      for (const message of messages) {
        const prior = earlierPostByID.get(message.id);
        const newerKnown = prior?.step !== undefined && prior.step > readStep;
        earlierPostByID.set(message.id, newerKnown && prior
          ? { channelID: channel.id, message: { ...message, reactions: prior.message.reactions }, step: prior.step }
          : { channelID: channel.id, message, step: readStep });
      }
      return {
        messages,
        earlierCursor: newestFirst.length >= CHANNEL_HISTORY_PAGE && oldest ? { createdAt: oldest.created_at, id: oldest.id } : null,
      };
    } catch (error) {
      request.assertCurrent();
      throw error;
    } finally {
      request.finish();
    }
  },
  // BUG-UG-MOBILE-CHANNEL-REPLIES-TARGET-THREAD-ID-AND-RESOLVED-THREAD-COMPOSE-20260926: a 42501 on a
  // reply send is not proof that the thread was resolved. reply_to_member_message
  // returns it through get_member_message_actions for a missing session, expired
  // MFA or lost read access, and for lost chapter access, so the screen asks for
  // the thread's current status before naming the closed thread. Only a fresh
  // status other than `open` answers true; a row hidden by lost access answers
  // false and keeps the generic notice. A closed reading also closes the row so
  // the composer leaves the screen.
  async threadClosed(channelID: string): Promise<boolean> {
    const client = getSupabaseClient();
    const channel = resolveChannel(channelID);
    if (!client || !channel || (spaceByChannel.get(channel.id) ?? channel.id) === channel.id) return false;
    const result = await client.from('chapter_threads').select('id,status').in('id', [channel.id]);
    if (result.error || !Array.isArray(result.data)) return false;
    const row = (result.data as { id: string; status?: string | null }[]).find((entry) => entry.id === channel.id);
    const closed = Boolean(row && row.status != null && row.status !== 'open');
    if (closed && !channel.closed) { channel.closed = true; emit(); }
    return closed;
  },
  channels: () => channels,
  channel: (id: string) => resolveChannel(id),
  poll: (): ChannelPoll | null => activePoll,
  pollTotal: () => (activePoll ? activePoll.options.some((option) => option.votes === null)
    ? null : activePoll.options.reduce((sum, option) => sum + (option.votes ?? 0), 0) : 0),
  markRead(writer: MobileSessionWriter, channelID: string) {
    const channel = liveChannelStore.channel(channelID);
    if (!channel || channel.unread === 0) return;
    // The read cursor is per space: reading one thread stamps its whole space.
    const id = spaceByChannel.get(channel.id) ?? channel.id;
    const generation = sessionGeneration;
    const boundary = markReadBoundary(id);
    const request = (markReadRequestBySpace.get(id) ?? 0) + 1;
    markReadRequestBySpace.set(id, request);
    return writer.client().then((client) => client.rpc('mark_chapter_space_read', { p_space_id: id }))
      .then((result: { data: unknown; error: unknown }) => {
        if (generation !== sessionGeneration) return;
        if (markReadRequestBySpace.get(id) !== request) return;
        if (result.error) applyMarkReadFault(result, id);
        else applyMarkReadSuccess(id, boundary);
      }, (error: unknown) => {
        if (generation !== sessionGeneration) return;
        if (markReadRequestBySpace.get(id) !== request) return;
        applyMarkReadFault(error, id);
      });
  },
  reactionPending(messageID: string, kind?: string) {
    return kind ? pendingReactions.has(JSON.stringify([messageID, kind]))
      : [...pendingReactions.keys()].some((key) => JSON.parse(key)[0] === messageID);
  },
  toggleReaction(writer: MobileSessionWriter, channelID: string, messageID: string, kind: string) {
    const reactionChannel = liveChannelStore.channel(channelID);
    const message = shownPost(channelID, messageID);
    if (!isMessageReactionKind(kind) || !reactionChannel || !message) return;
    const scope = reactionChannel.id;
    const target = JSON.stringify([messageID, kind]);
    if (pendingReactions.has(target)) return;
    const generation = sessionGeneration;
    const attempt = ++actionSequence;
    pendingReactions.set(target, attempt);
    emit();
    return writer.client().then((client) => client.rpc('toggle_member_message_reaction', { p_source_kind: 'channel', p_message_id: messageID, p_reaction: kind }))
      .then((result: ChannelActionResult) => {
        if (generation !== sessionGeneration) return;
        pendingReactions.delete(target);
        if (result.error) {
          rememberActionFailure('reaction', result, scope, target, attempt);
          emit(); scheduleRefresh(); return;
        }
        const confirmed = result.data && typeof result.data === 'object' && 'reacted' in result.data
          ? (result.data as { reacted: unknown }).reacted : null;
        // Unknown response shapes are not confirmations. Re-read authoritative
        // rows; never animate a guessed count after an unconfirmed mutation.
        if (typeof confirmed !== 'boolean') { emit(); scheduleRefresh(); return; }
        const current = shownPost(channelID, messageID);
        if (!current) { emit(); return; }
        invalidateLoads();
        const list = current.reactions ?? (current.reactions = []);
        const reaction = list.find((entry) => entry.kind === kind);
        const count = Math.max(0, (reaction?.count ?? 0) - (reaction?.mine ? 1 : 0) + (confirmed ? 1 : 0));
        current.reactions = list.filter((entry) => entry.kind !== kind);
        if (count) current.reactions.push({ kind, emoji: MESSAGE_REACTION_GLYPHS[kind] ?? '•', count, mine: confirmed });
        rememberConfirmedReaction(channelID, messageID, current);
        clearActionFailureOnSuccess('reaction', scope, target, attempt);
        emit();
      }, (error: unknown) => {
        if (generation !== sessionGeneration) return;
        pendingReactions.delete(target);
        rememberActionFailure('reaction', error, scope, target, attempt);
        emit(); scheduleRefresh();
      });
  },
  vote(writer: MobileSessionWriter, index: number) {
    if (!activePoll || channelPollIsClosed(activePoll)) return;
    const clearing = activePoll.mine === index;
    const optionID = clearing ? null : activePoll.optionIDs[index];
    if (!clearing && !optionID) return;
    // A vote completion is invalidated by a session reset or by the open poll
    // being replaced — not by an unrelated workspace refresh. Guarding on
    // `loadSequence` dropped the rejection whenever a realtime insert or a
    // scheduled refresh landed first, which is the silent vote this change
    // exists to end.
    const generation = sessionGeneration;
    const pollID = activePoll.id;
    const spaceID = activePollChannelID;
    const attempt = ++actionSequence;
    const stale = () => generation !== sessionGeneration || activePoll?.id !== pollID;
    return writer.client().then((client) => client.rpc('cast_channel_poll_vote', { p_poll_id: pollID, p_option_id: optionID }))
      .then((result: ChannelActionResult) => {
        if (stale()) return;
        if (!result.error && result.data) {
          clearActionFailureOnSuccess('vote', spaceID, pollID, attempt);
          applyTally(result.data as Tally);
        } else {
          if (rememberActionFailure('vote', result, spaceID, pollID, attempt)) emit();
          scheduleRefresh();
        }
      }, (error: unknown) => {
        if (stale()) return;
        if (rememberActionFailure('vote', error, spaceID, pollID, attempt)) emit();
        scheduleRefresh();
      });
  },
  async send(writer: MobileSessionWriter, channelID: string, body: string, author: string, initials: string, mentionIDs: readonly string[] = []): Promise<boolean> {
    return (await liveChannelStore.sendOutcome(writer, channelID, body, author, initials, mentionIDs)).acknowledged;
  },
  async sendOutcome(writer: MobileSessionWriter, channelID: string, body: string, _author: string, _initials: string, mentionIDs: readonly string[] = []): Promise<MobileWriteAcknowledgement<PostRow> | { acknowledged: false; continuationCurrent: boolean }> {
    // Author identity is stamped server-side; the caller-provided display
    // strings are demo-store interface compatibility only.
    const clean = body.trim();
    // The post goes into the thread this row is. A space id naming several
    // threads resolves to no row, so a send can never fall back to the
    // space's oldest thread.
    const channel = resolveChannel(channelID);
    const spaceID = channel ? spaceByChannel.get(channel.id) : undefined;
    if (!clean || !channel || !spaceID) {
      rememberSendFailure(null);
      emit();
      return { acknowledged: false, continuationCurrent: await writer.isCurrent() };
    }
    const sequence = loadSequence;
    let accepted: MobileWriteAcknowledgement<PostRow> | null = null;
    try {
      const client = await writer.client();
      let target = channel.id !== spaceID ? channel.id : createdThreadBySpace.get(spaceID);
      if (!target) {
        let pending = threadCreationBySpace.get(spaceID);
        if (!pending) {
          pending = (async () => {
            const created = await client.from('chapter_threads')
              // The first post must not rename its space after a refresh.
              .insert({ space_id: spaceID, title: channel.name, kind: 'topic' })
              .select('id')
              .single();
            if (created.error) throw created;
            return (created.data as { id: string }).id;
          })();
          threadCreationBySpace.set(spaceID, pending);
        }
        try {
          target = await pending;
        } finally {
          if (threadCreationBySpace.get(spaceID) === pending) threadCreationBySpace.delete(spaceID);
        }
        const current = await writer.isCurrent();
        if (!current) return { acknowledged: false, continuationCurrent: false };
        // A same-person refresh may retire the cache while the thread is
        // accepted. Finish this bound operation, but never repopulate the
        // retired cache (nor treat creating a thread alone as a sent post).
        if (sequence === loadSequence) createdThreadBySpace.set(spaceID, target);
      }
      // Structured mentions are a request: the database keeps only people who
      // can read this channel, and none while the organization switch is off.
      // Thread creation can outlast the token checked above. Recheck the same
      // composing person and use that read's token for the post itself.
      const postClient = await writer.client();
      const inserted = await postClient.from('chapter_thread_posts')
        .insert({ thread_id: target, body: clean, ...(mentionIDs.length > 0 ? { mentioned_user_ids: [...mentionIDs] } : {}) })
        .select('id,thread_id,author_id,body,body_es,author_name,author_initials,author_role,created_at,parent_post_id')
        .single();
      if (inserted.error) throw inserted;
      const post = inserted.data as PostRow | null;
      if (!post?.id) throw new Error('The channel post was not confirmed');
      const outcome = await writer.acknowledged(post);
      accepted = outcome;
      // Retirement prevents cache continuation, never acknowledgement.
      if (sequence !== loadSequence || !outcome.continuationCurrent) return { ...outcome, continuationCurrent: false };
      if (!channel.messages.some((entry) => entry.id === post.id)) {
        channel.messages.push({
          id: post.id,
          author: post.author_name || 'You',
          initials: post.author_initials || '·',
          role: post.author_role === 'president' ? 'CAMPAIGN CHAIR' : post.author_role === 'steward' ? 'COMMITTEE' : undefined,
          time: timeLabel(post.created_at),
          createdAt: post.created_at,
          body: post.body,
          bodyEs: post.body_es,
        });
      }
      lastSendDiagnosis = null;
      emit();
      return outcome;
    } catch (error: unknown) {
      if (accepted) return { ...accepted, continuationCurrent: false };
      const proof = await writer.check();
      if (sequence !== loadSequence || proof === 'changed') return { acknowledged: false, continuationCurrent: false };
      rememberSendFailure(error);
      emit();
      scheduleRefresh();
      return { acknowledged: false, continuationCurrent: proof === 'current' };
    }
  },
  sendDiagnosis() {
    if (status === 'idle') {
      lastSendDiagnosis = null;
      clearActionFailure();
    }
    return lastSendDiagnosis;
  },
  // `spaceID` is the channel asking. A notice belongs to the channel the action
  // was attempted in; every other route reads null.
  actionDiagnosis(spaceID?: string) {
    if (status === 'idle') {
      lastSendDiagnosis = null;
      clearActionFailure();
    }
    return latestActionFailure(spaceID);
  },
};
