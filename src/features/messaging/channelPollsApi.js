import { MemberApiError } from "../../lib/memberApiError.js";

// Chapter channel polls on the web (BUG-UG-WEB-CHANNEL-POLL-NO-VOTE-CONTROL-20261003).
// The same pair the native app uses (apps/mobile/src/data/liveChannels.ts):
// chapter_channel_polls rows under RLS, get_channel_poll_tally for the options,
// counts and the caller's own choice, and cast_channel_poll_vote, which refuses
// a closed poll server-side and returns the fresh tally. A null option clears
// the caller's vote.

// A thread holds a handful of posts; this bounds the tally reads one dialog
// can issue to the polls attached to them.
const MAX_THREAD_POLLS = 5;

function normalizeTally(tally) {
  if (!tally || typeof tally !== "object" || !tally.poll_id) return null;
  const options = (Array.isArray(tally.options) ? tally.options : [])
    .map((option) => ({ id: option.id, label: String(option.label ?? ""), votes: option.votes === null ? null : Number(option.votes) || 0 }));
  return {
    pollId: tally.poll_id,
    question: String(tally.question ?? ""),
    closesAt: tally.closes_at ?? null,
    total: tally.total === null ? null : Number(tally.total) || 0,
    mine: tally.mine ?? null,
    options,
  };
}

export function channelPollIsClosed(poll, now = Date.now()) {
  if (!poll?.closesAt) return false;
  const closes = new Date(poll.closesAt).getTime();
  return !Number.isNaN(closes) && closes <= now;
}

// The polls attached to posts of one thread, each with its tally.
export async function loadThreadChannelPolls(client, { spaceId, postIds }) {
  const ids = new Set((postIds || []).filter(Boolean));
  if (!client || !spaceId || ids.size === 0) return [];
  // Filtered by post in the query, so the Data API's row cap applies only to
  // this thread's polls, never to the whole space's history.
  const { data, error } = await client.from("chapter_channel_polls")
    .select("id,space_id,post_id,question,closes_at,created_at")
    .eq("space_id", spaceId)
    .in("post_id", [...ids])
    .order("created_at", { ascending: false });
  if (error) throw new MemberApiError("Channel polls", error);
  const rows = (Array.isArray(data) ? data : []).filter((row) => ids.has(row.post_id)).slice(0, MAX_THREAD_POLLS);
  const polls = await Promise.all(rows.map(async (row) => {
    const result = await client.rpc("get_channel_poll_tally", { p_poll_id: row.id });
    if (result.error) throw new MemberApiError("Channel poll tally", result.error);
    const tally = normalizeTally(result.data);
    return tally ? { ...tally, postId: row.post_id } : null;
  }));
  return polls.filter(Boolean);
}

export async function castChannelPollVote(client, pollId, optionId) {
  const { data, error } = await client.rpc("cast_channel_poll_vote", { p_poll_id: pollId, p_option_id: optionId ?? null });
  if (error) {
    const refusal = new MemberApiError("Channel poll vote", error);
    if (error.code === "22023" && error.message === "poll closed") refusal.reason = "poll_closed";
    throw refusal;
  }
  return normalizeTally(data);
}
