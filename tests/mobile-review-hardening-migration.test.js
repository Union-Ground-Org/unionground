import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260820210000_mobile_review_hardening.sql'), 'utf8').toLowerCase();

describe('mobile exact-head review database hardening', () => {
  it('keeps a poll post inside its own space and locks option creation to its author before close', () => {
    expect(sql).toContain('chapter_channel_polls.post_id');
    expect(sql).toContain('thread.space_id = chapter_channel_polls.space_id');
    expect(sql).toContain('poll.created_by = (select auth.uid())');
    expect(sql).toContain('poll.closes_at > now()');
  });

  it('provides exact bounded per-conversation dashboard summaries through an invoker-rights view', () => {
    expect(sql).toContain('create view public.member_conversation_summaries');
    expect(sql).toContain('security_invoker = true');
    expect(sql).toContain('left join lateral');
    expect(sql).toContain("sender_kind = 'steward'");
    expect(sql).toContain('c.user_id = (select auth.uid())');
    expect(sql).toContain('grant select on public.member_conversation_summaries to authenticated');
  });

  it('adds indexes for every newly reported foreign-key path', () => {
    for (const name of [
      'chapter_space_reads_user_idx',
      'chapter_channel_polls_space_created_idx',
      'chapter_channel_polls_chapter_idx',
      'chapter_channel_polls_post_idx',
      'chapter_channel_polls_created_by_idx',
      'chapter_channel_poll_votes_option_poll_idx',
      'chapter_channel_poll_votes_user_idx',
    ]) expect(sql).toContain(`create index ${name}`);
  });
});
