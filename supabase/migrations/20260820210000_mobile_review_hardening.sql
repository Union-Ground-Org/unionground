-- Exact-head review hardening for the native chapter-channel and messaging
-- summary work. This migration is deliberately additive except for two RLS
-- policy replacements; no member content is rewritten.

-- The dashboard needs an exact latest-message and unread count for each of its
-- bounded conversation rows. A security-invoker view keeps the existing
-- member_conversations/member_messages RLS boundary in force and explicitly
-- narrows the caller to auth.uid().
create view public.member_conversation_summaries
with (security_invoker = true)
as
select
  c.id as conversation_id,
  latest.body as latest_message,
  coalesce(unread.unread_count, 0)::integer as unread_count
from public.member_conversations c
left join lateral (
  select m.body
  from public.member_messages m
  where m.conversation_id = c.id
    and m.user_id = (select auth.uid())
  order by m.created_at desc, m.id desc
  limit 1
) latest on true
left join lateral (
  select count(*)::integer as unread_count
  from public.member_messages m
  where m.conversation_id = c.id
    and m.user_id = (select auth.uid())
    and m.sender_kind = 'steward'
    and m.read_at is null
) unread on true
where c.user_id = (select auth.uid());

comment on view public.member_conversation_summaries is
  'Invoker-rights, caller-scoped mobile dashboard summaries; underlying conversation and message RLS remains authoritative.';

revoke all on public.member_conversation_summaries from public, anon, authenticated;
grant select on public.member_conversation_summaries to authenticated;

-- A poll-linked channel post must belong to a thread in the same space. The
-- identity trigger already makes space_id/chapter_id/created_by immutable.
drop policy chapter_channel_polls_staff_create on public.chapter_channel_polls;
create policy chapter_channel_polls_staff_create on public.chapter_channel_polls
  for insert to authenticated with check (
    chapter_id = private.current_member_chapter()
    and created_by = (select auth.uid())
    and public.member_has_role(array['steward','coordinator','advisor','admin','vp'])
    and exists (
      select 1
      from public.chapter_spaces space
      where space.id = chapter_channel_polls.space_id
        and private.can_read_chapter_space(space)
    )
    and (
      chapter_channel_polls.post_id is null
      or exists (
        select 1
        from public.chapter_thread_posts post
        join public.chapter_threads thread on thread.id = post.thread_id
        where post.id = chapter_channel_polls.post_id
          and thread.space_id = chapter_channel_polls.space_id
          and post.deleted_at is null
      )
    )
  );

-- Only the poll's author may add its immutable option set, and only while the
-- poll is still open. There are intentionally no option UPDATE/DELETE grants.
drop policy chapter_channel_poll_options_staff_create on public.chapter_channel_poll_options;
create policy chapter_channel_poll_options_staff_create on public.chapter_channel_poll_options
  for insert to authenticated with check (
    public.member_has_role(array['steward','coordinator','advisor','admin','vp'])
    and exists (
      select 1
      from public.chapter_channel_polls poll
      join public.chapter_spaces space on space.id = poll.space_id
      where poll.id = chapter_channel_poll_options.poll_id
        and poll.created_by = (select auth.uid())
        and (poll.closes_at is null or poll.closes_at > now())
        and private.can_read_chapter_space(space)
    )
  );

-- FK and dashboard access paths reported by the production advisor after the
-- chapter-channel migration. All are ordinary non-unique indexes and safe to
-- recreate through an idempotent migration retry.
create index chapter_space_reads_user_idx
  on public.chapter_space_reads (user_id, last_read_at desc);
create index chapter_channel_polls_space_created_idx
  on public.chapter_channel_polls (space_id, created_at desc);
create index chapter_channel_polls_chapter_idx
  on public.chapter_channel_polls (chapter_id);
create index chapter_channel_polls_post_idx
  on public.chapter_channel_polls (post_id)
  where post_id is not null;
create index chapter_channel_polls_created_by_idx
  on public.chapter_channel_polls (created_by);
create index chapter_channel_poll_votes_option_poll_idx
  on public.chapter_channel_poll_votes (option_id, poll_id);
create index chapter_channel_poll_votes_user_idx
  on public.chapter_channel_poll_votes (user_id, poll_id);
