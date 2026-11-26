-- Chapter channel live polls, unread tracking, author display stamping, wider
-- reactions, and realtime for channel posts. Backs the mobile redesign's
-- Slack-style channels (apps/mobile: messages/channel/pulse surfaces), turning
-- the seeded demo (src/data/demoChannels.ts) into a real feature for
-- authenticated members. Builds ON the existing chapter_spaces /
-- chapter_threads / chapter_thread_posts system and the polymorphic
-- member_message_reactions table — no parallel messaging tables.
--
-- DESIGN DECISION — channel polls are NOT ballots. member_ballot_choices is
-- deliberately unlinkable (no user_id, no policies, tally-only DEFINER read)
-- because governance votes carry a secrecy guarantee. Channel polls are
-- logistics questions ("which night works for the meeting?") whose live
-- per-option counts update as members tap; they store a normal user-linked
-- vote row (readable ONLY by its owner; counts exposed only in aggregate via
-- get_channel_poll_tally). Anything governance-grade must keep using the
-- ballot system. This boundary is intentional and reviewed.
--
-- REALTIME PRIVACY REVIEW (required by db-contract.json exclusiveNote):
-- chapter_thread_posts joins the insert-only supabase_realtime publication.
-- - The publication is already insert-only (member_notifications,
--   chapter_task_messages); the guard below refuses to commit otherwise, so no
--   DELETE/UPDATE payload can ever replay a post edit or deletion.
-- - Realtime enforces the table's SELECT policy per subscriber; the policy
--   routes through private.can_read_chapter_space, so a post in a staff or
--   private space is only delivered to subscribers who could read it anyway.
-- - The new author_name/author_initials/author_role columns are stamped
--   server-side and are part of the row a reader is already authorized to
--   see; posting to a chapter space is a to-the-chapter act by design.

-- 1. Widen the bounded reaction set for the channel surfaces. ✊ (solidarity)
-- and 💪 (strength) join like/support/celebrate; the client maps emoji to
-- these kinds. The RPC allow-list below is updated in lockstep.
alter table public.member_message_reactions
  drop constraint member_message_reactions_reaction_check;
alter table public.member_message_reactions
  add constraint member_message_reactions_reaction_check
  check (reaction in ('like','support','celebrate','solidarity','strength'));

create or replace function public.toggle_member_message_reaction(
  p_source_kind text,
  p_message_id uuid,
  p_reaction text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  removed integer;
  new_id uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_source_kind not in ('private','channel','task')
     or p_reaction not in ('like','support','celebrate','solidarity','strength')
     or not private.can_read_message_source(
       caller, p_source_kind,
       case when p_source_kind = 'private' then p_message_id end,
       case when p_source_kind = 'channel' then p_message_id end,
       case when p_source_kind = 'task' then p_message_id end) then
    raise exception 'message unavailable' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('message-reaction:' || caller::text || ':' || p_message_id::text || ':' || p_reaction, 509));
  delete from public.member_message_reactions r
  where r.actor_id = caller and r.source_kind = p_source_kind and r.reaction = p_reaction
    and coalesce(r.private_message_id, r.channel_post_id, r.task_message_id) = p_message_id;
  get diagnostics removed = row_count;
  if removed > 0 then
    return pg_catalog.jsonb_build_object('reacted', false);
  end if;

  insert into public.member_message_reactions(
    actor_id, source_kind, private_message_id, channel_post_id, task_message_id, reaction)
  values (
    caller, p_source_kind,
    case when p_source_kind = 'private' then p_message_id end,
    case when p_source_kind = 'channel' then p_message_id end,
    case when p_source_kind = 'task' then p_message_id end,
    p_reaction)
  returning id into new_id;
  return pg_catalog.jsonb_build_object('reacted', true, 'id', new_id);
end;
$$;

-- 2. Author display stamping on channel posts. Members cannot read peers'
-- member_profiles (by design), so the post row itself carries its display
-- identity, resolved server-side at write time — the same pattern as
-- chapter_tasks.assignee_name. The columns are server-owned: they are absent
-- from the column-scoped INSERT grant, and the trigger overwrites any value.
alter table public.chapter_thread_posts
  add column author_name text not null default '',
  add column author_initials text not null default '',
  add column author_role text check (author_role in ('steward','president'));

alter table public.chapter_thread_posts
  add constraint chapter_thread_posts_author_name_bounded check (char_length(author_name) <= 120),
  add constraint chapter_thread_posts_author_initials_bounded check (char_length(author_initials) <= 8);

create or replace function private.stamp_channel_post_author()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- BEFORE-trigger name ordering runs this ahead of stamp_product_identity,
  -- so author_id may still be unset here; resolve the author the same way it
  -- will be stamped.
  post_author uuid := coalesce(new.author_id, (select auth.uid()));
  display_name text;
  display_initials text;
  display_role text;
begin
  if tg_op = 'UPDATE' then
    -- Author identity is immutable once written.
    new.author_name := old.author_name;
    new.author_initials := old.author_initials;
    new.author_role := old.author_role;
    return new;
  end if;

  select p.full_name, p.initials into display_name, display_initials
  from public.member_profiles p
  where p.id = post_author;

  select case
      when exists (
        select 1 from public.member_roles r
        where r.user_id = post_author and r.role = 'vp'
      ) then 'president'
      when exists (
        select 1 from public.member_roles r
        where r.user_id = post_author and r.role = 'steward'
      ) then 'steward'
    end into display_role;

  new.author_name := coalesce(display_name, 'Chapter member');
  new.author_initials := coalesce(display_initials, '·');
  new.author_role := display_role;
  return new;
end;
$$;

revoke all on function private.stamp_channel_post_author() from public, anon, authenticated;

-- Backfill display identity for existing posts BEFORE the trigger exists —
-- its UPDATE branch deliberately preserves old values, so a post-trigger
-- backfill would be a no-op.
update public.chapter_thread_posts posts
set author_name = coalesce(profiles.full_name, 'Chapter member'),
    author_initials = coalesce(profiles.initials, '·'),
    author_role = (
      select case
          when exists (select 1 from public.member_roles r where r.user_id = posts.author_id and r.role = 'vp') then 'president'
          when exists (select 1 from public.member_roles r where r.user_id = posts.author_id and r.role = 'steward') then 'steward'
        end
    )
from public.member_profiles profiles
where profiles.id = posts.author_id and posts.author_name = '';

create trigger chapter_thread_posts_stamp_author
  before insert or update on public.chapter_thread_posts
  for each row execute function private.stamp_channel_post_author();

-- 3. Per-member unread tracking for spaces. Read models compare a space's
-- post timestamps against the member's last_read_at; writes go through the
-- RPC so the row is always self-scoped and gated by space visibility.
create table public.chapter_space_reads (
  space_id uuid not null references public.chapter_spaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (space_id, user_id)
);

alter table public.chapter_space_reads enable row level security;

create policy chapter_space_reads_select_own on public.chapter_space_reads
  for select to authenticated using (user_id = (select auth.uid()));
create policy mfa_assurance on public.chapter_space_reads as restrictive
  for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));

revoke all on public.chapter_space_reads from public, anon, authenticated;
grant select on public.chapter_space_reads to authenticated;

create function public.mark_chapter_space_read(p_space_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.chapter_spaces s
    where s.id = p_space_id and private.can_read_chapter_space(s)
  ) then
    raise exception 'space unavailable' using errcode = '22023';
  end if;

  insert into public.chapter_space_reads(space_id, user_id, last_read_at)
  values (p_space_id, caller, now())
  on conflict (space_id, user_id) do update set last_read_at = now();
end;
$$;

revoke all on function public.mark_chapter_space_read(uuid) from public, anon, authenticated;
grant execute on function public.mark_chapter_space_read(uuid) to authenticated;

-- 4. Channel polls: question + options + one changeable user-linked vote per
-- member. Staff author polls (directly, column-scoped like chapter_spaces);
-- members vote only through the RPC. Votes are readable solely by their
-- owner; everyone else sees aggregate counts from get_channel_poll_tally.
create table public.chapter_channel_polls (
  id uuid primary key default extensions.gen_random_uuid(),
  space_id uuid not null references public.chapter_spaces(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  post_id uuid references public.chapter_thread_posts(id) on delete set null,
  question text not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  closes_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chapter_channel_polls_question_bounded check (char_length(btrim(question)) between 1 and 300)
);

create table public.chapter_channel_poll_options (
  id uuid primary key default extensions.gen_random_uuid(),
  poll_id uuid not null references public.chapter_channel_polls(id) on delete cascade,
  label text not null,
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  constraint chapter_channel_poll_options_label_bounded check (char_length(btrim(label)) between 1 and 120),
  unique (poll_id, position),
  unique (id, poll_id)
);

create table public.chapter_channel_poll_votes (
  poll_id uuid not null references public.chapter_channel_polls(id) on delete cascade,
  option_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (poll_id, user_id),
  -- The composite FK guarantees a vote can only point at an option of its own
  -- poll, so a forged cross-poll option id cannot corrupt a tally.
  constraint chapter_channel_poll_votes_option_belongs
    foreign key (option_id, poll_id) references public.chapter_channel_poll_options(id, poll_id) on delete cascade
);

alter table public.chapter_channel_polls enable row level security;
alter table public.chapter_channel_poll_options enable row level security;
alter table public.chapter_channel_poll_votes enable row level security;

create policy chapter_channel_polls_read on public.chapter_channel_polls
  for select to authenticated using (
    exists (select 1 from public.chapter_spaces s where s.id = space_id and private.can_read_chapter_space(s))
  );
create policy chapter_channel_polls_staff_create on public.chapter_channel_polls
  for insert to authenticated with check (
    chapter_id = private.current_member_chapter()
    and created_by = (select auth.uid())
    and public.member_has_role(array['steward','coordinator','advisor','admin','vp'])
    and exists (select 1 from public.chapter_spaces s where s.id = space_id and private.can_read_chapter_space(s))
  );
create policy chapter_channel_polls_staff_update on public.chapter_channel_polls
  for update to authenticated
  using (chapter_id = private.current_member_chapter() and public.member_has_role(array['steward','coordinator','advisor','admin','vp']))
  with check (chapter_id = private.current_member_chapter() and public.member_has_role(array['steward','coordinator','advisor','admin','vp']));
create policy mfa_assurance on public.chapter_channel_polls as restrictive
  for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));

create policy chapter_channel_poll_options_read on public.chapter_channel_poll_options
  for select to authenticated using (
    exists (
      select 1 from public.chapter_channel_polls p
      join public.chapter_spaces s on s.id = p.space_id
      where p.id = poll_id and private.can_read_chapter_space(s)
    )
  );
create policy chapter_channel_poll_options_staff_create on public.chapter_channel_poll_options
  for insert to authenticated with check (
    public.member_has_role(array['steward','coordinator','advisor','admin','vp'])
    and exists (
      select 1 from public.chapter_channel_polls p
      join public.chapter_spaces s on s.id = p.space_id
      where p.id = poll_id and private.can_read_chapter_space(s)
    )
  );
create policy mfa_assurance on public.chapter_channel_poll_options as restrictive
  for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));

create policy chapter_channel_poll_votes_select_own on public.chapter_channel_poll_votes
  for select to authenticated using (user_id = (select auth.uid()));
create policy mfa_assurance on public.chapter_channel_poll_votes as restrictive
  for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));

-- Server-owned identity for polls (chapter_id, created_by) via the shared
-- stamping pattern; updated_at freshness via the shared touch helper.
create or replace function private.stamp_channel_poll_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  space_chapter text;
begin
  if tg_op = 'UPDATE' then
    new.space_id := old.space_id;
    new.chapter_id := old.chapter_id;
    new.post_id := old.post_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    return new;
  end if;
  select s.chapter_id into space_chapter from public.chapter_spaces s where s.id = new.space_id;
  new.chapter_id := space_chapter;
  new.created_by := (select auth.uid());
  return new;
end;
$$;

revoke all on function private.stamp_channel_poll_identity() from public, anon, authenticated;

create trigger chapter_channel_polls_stamp_identity
  before insert or update on public.chapter_channel_polls
  for each row execute function private.stamp_channel_poll_identity();

create trigger chapter_channel_polls_touch_updated_at
  before update on public.chapter_channel_polls
  for each row execute function private.touch_updated_at();

revoke all on public.chapter_channel_polls from public, anon, authenticated;
grant select on public.chapter_channel_polls to authenticated;
grant insert (space_id, post_id, question, closes_at) on public.chapter_channel_polls to authenticated;
grant update (question, closes_at) on public.chapter_channel_polls to authenticated;

revoke all on public.chapter_channel_poll_options from public, anon, authenticated;
grant select on public.chapter_channel_poll_options to authenticated;
grant insert (poll_id, label, position) on public.chapter_channel_poll_options to authenticated;

revoke all on public.chapter_channel_poll_votes from public, anon, authenticated;
grant select on public.chapter_channel_poll_votes to authenticated;

-- Voting: one changeable vote per member per poll, serialized per caller+poll,
-- rejected after closes_at. p_option_id null clears the caller's vote. The
-- same 'poll unavailable' error covers not-found and not-authorized (no
-- existence oracle).
create function public.cast_channel_poll_vote(p_poll_id uuid, p_option_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  poll public.chapter_channel_polls;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select p.* into poll
  from public.chapter_channel_polls p
  join public.chapter_spaces s on s.id = p.space_id
  where p.id = p_poll_id and private.can_read_chapter_space(s);
  if poll.id is null then
    raise exception 'poll unavailable' using errcode = '22023';
  end if;
  if poll.closes_at is not null and poll.closes_at <= now() then
    raise exception 'poll closed' using errcode = '22023';
  end if;
  if p_option_id is not null and not exists (
    select 1 from public.chapter_channel_poll_options o
    where o.id = p_option_id and o.poll_id = p_poll_id
  ) then
    raise exception 'poll unavailable' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('channel-poll:' || caller::text || ':' || p_poll_id::text, 509));

  if p_option_id is null then
    delete from public.chapter_channel_poll_votes v
    where v.poll_id = p_poll_id and v.user_id = caller;
  else
    insert into public.chapter_channel_poll_votes(poll_id, option_id, user_id)
    values (p_poll_id, p_option_id, caller)
    on conflict (poll_id, user_id) do update set option_id = excluded.option_id, updated_at = now();
  end if;

  return public.get_channel_poll_tally(p_poll_id);
end;
$$;

-- Aggregate-only tally. Exposes per-option counts, the total, and the
-- caller's own choice — never who voted for what.
create function public.get_channel_poll_tally(p_poll_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  caller uuid := (select auth.uid());
  poll public.chapter_channel_polls;
  options jsonb;
  total integer;
  mine uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select p.* into poll
  from public.chapter_channel_polls p
  join public.chapter_spaces s on s.id = p.space_id
  where p.id = p_poll_id and private.can_read_chapter_space(s);
  if poll.id is null then
    raise exception 'poll unavailable' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('id', o.id, 'label', o.label, 'position', o.position, 'votes', coalesce(counts.votes, 0))
      order by o.position), '[]'::jsonb)
    into options
  from public.chapter_channel_poll_options o
  left join (
    select v.option_id, pg_catalog.count(*)::integer as votes
    from public.chapter_channel_poll_votes v
    where v.poll_id = p_poll_id
    group by v.option_id
  ) counts on counts.option_id = o.id
  where o.poll_id = p_poll_id;

  select pg_catalog.count(*)::integer into total
  from public.chapter_channel_poll_votes v where v.poll_id = p_poll_id;

  select v.option_id into mine
  from public.chapter_channel_poll_votes v
  where v.poll_id = p_poll_id and v.user_id = caller;

  return pg_catalog.jsonb_build_object(
    'poll_id', poll.id,
    'question', poll.question,
    'closes_at', poll.closes_at,
    'total', total,
    'mine', mine,
    'options', options);
end;
$$;

revoke all on function public.cast_channel_poll_vote(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cast_channel_poll_vote(uuid, uuid) to authenticated;
revoke all on function public.get_channel_poll_tally(uuid) from public, anon, authenticated;
grant execute on function public.get_channel_poll_tally(uuid) to authenticated;

-- 5. Realtime for channel posts (privacy review at the top of this file).
-- The publication must already be insert-only — the guards refuse anything
-- else, mirroring 20260723203000_member_notifications_realtime.sql.
do $$
declare
  widened integer;
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;

  select pg_catalog.count(*) into widened
  from pg_catalog.pg_publication
  where pubname = 'supabase_realtime' and (pubdelete or pubupdate or pubtruncate);
  if widened > 0 then
    raise exception
      'supabase_realtime is no longer insert-only; chapter_thread_posts must not be published until that is resolved deliberately.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'chapter_thread_posts'
  ) then
    execute 'alter publication supabase_realtime add table public.chapter_thread_posts';
  end if;

  if exists (
    select 1 from pg_catalog.pg_publication
    where pubname = 'supabase_realtime' and (pubdelete or pubupdate or pubtruncate)
  ) then
    raise exception 'supabase_realtime is not insert-only after adding chapter_thread_posts; refusing to publish';
  end if;
end
$$;
