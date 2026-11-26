-- BUG-UG-STAFF-BOOT-LOAD-SLOW-RECORDS-AND-REACTIONS-READS-20261106 (#7210).
-- At about 1,000 accounts every staff screen's first load waited 5-6 s on two
-- reads: chapter_records (newest 300) and member_message_reactions (no filter).
-- Both tables' read policies called security-definer helpers once per row.
--
-- chapter_records: each helper depends only on the row's chapter (or its
-- chapter, unit and committee) and the caller. private.chapter_records_scope_memo
-- evaluates the SAME helper once per distinct value present in the table, once
-- per statement, and each policy reads its answer from that map. A value the
-- map does not hold (a row an INSERT or UPDATE is writing) falls through to the
-- helper itself, so every row gets exactly the answer it got before.
--
-- member_message_reactions: private.current_actor_readable_message_reactions
-- lists, once per statement, the reactions the caller can read through the
-- three plain branches of private.can_read_message_source (own conversation,
-- chapter channel, own task message). Every other row, including a steward's
-- read of a member's conversation, is still decided by
-- private.current_actor_can_read_message_source per row. The list only ever
-- contains rows that predicate would accept, so visibility is unchanged.
-- public.list_member_message_reactions lets the web boot read only the
-- reactions on the messages it loaded, through the same policy, and three
-- source-column indexes let that filter (and the source tables' cascading
-- deletes) reach the rows without a table scan.
begin;

set local lock_timeout = '5s';

-- Replace only the exact predecessors 20260812200000 and 20261102005607 installed.
do $preflight$
begin
  if (select pg_catalog.pg_get_expr(p.polqual, p.polrelid) from pg_catalog.pg_policy p
       where p.polrelid = 'public.chapter_records'::regclass and p.polname = 'chapter_records_select')
     is distinct from '(((private.chapter_record_publication(record_type) = ''chapter_members''::text) AND (lifecycle_status = ''published''::text) AND (visibility = ''chapter''::text) AND (archived_at IS NULL) AND private.can_read_chapter_member_record(chapter_id)) OR ((archived_at IS NULL) AND private.can_read_chapter_contact_record(chapter_id)) OR ((private.chapter_record_publication(record_type) = ''chapter_members''::text) AND private.chapter_officer_can_for_scope(chapter_id, ''records''::text, access_unit_id, access_committee_id)))' then
    raise exception 'unreviewed predecessor: chapter_records_select' using errcode = '55000';
  end if;
  if (select pg_catalog.pg_get_expr(p.polqual, p.polrelid) from pg_catalog.pg_policy p
       where p.polrelid = 'public.chapter_records'::regclass and p.polname = 'chapter_records_container_scope')
     is distinct from '(((access_unit_id IS NULL) AND (access_committee_id IS NULL)) OR private.chapter_record_manageable(chapter_id, access_unit_id, access_committee_id) OR private.chapter_scope_member_allowed(chapter_id, access_unit_id, access_committee_id, ( SELECT auth.uid() AS uid)))' then
    raise exception 'unreviewed predecessor: chapter_records_container_scope' using errcode = '55000';
  end if;
  if (select pg_catalog.pg_get_expr(p.polqual, p.polrelid) from pg_catalog.pg_policy p
       where p.polrelid = 'public.member_message_reactions'::regclass and p.polname = 'member_message_reactions_read')
     is distinct from 'private.current_actor_can_read_message_source(source_kind, private_message_id, channel_post_id, task_message_id)' then
    raise exception 'unreviewed predecessor: member_message_reactions_read' using errcode = '55000';
  end if;
end;
$preflight$;

-- One map per policy helper, keyed by the helper's arguments as they occur in
-- the table: 'member' and 'contact' by chapter id, 'officer' and 'container'
-- by jsonb_build_array(chapter_id, access_unit_id, access_committee_id)::text.
-- 'container' only holds rows with a unit or committee, the only rows whose
-- container policy reaches its helpers.
create function private.chapter_records_scope_memo(p_kind text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case p_kind
    when 'member' then (
      select coalesce(pg_catalog.jsonb_object_agg(d.chapter_id,
        private.can_read_chapter_member_record(d.chapter_id)), '{}'::jsonb)
      from (select distinct r.chapter_id from public.chapter_records r) d
    )
    when 'contact' then (
      select coalesce(pg_catalog.jsonb_object_agg(d.chapter_id,
        private.can_read_chapter_contact_record(d.chapter_id)), '{}'::jsonb)
      from (select distinct r.chapter_id from public.chapter_records r) d
    )
    when 'officer' then (
      select coalesce(pg_catalog.jsonb_object_agg(
        pg_catalog.jsonb_build_array(d.chapter_id, d.access_unit_id, d.access_committee_id)::text,
        private.chapter_officer_can_for_scope(d.chapter_id, 'records', d.access_unit_id, d.access_committee_id)), '{}'::jsonb)
      from (select distinct r.chapter_id, r.access_unit_id, r.access_committee_id from public.chapter_records r) d
    )
    when 'container' then (
      select coalesce(pg_catalog.jsonb_object_agg(
        pg_catalog.jsonb_build_array(d.chapter_id, d.access_unit_id, d.access_committee_id)::text,
        private.chapter_record_manageable(d.chapter_id, d.access_unit_id, d.access_committee_id)
          or private.chapter_scope_member_allowed(d.chapter_id, d.access_unit_id, d.access_committee_id, (select auth.uid()))), '{}'::jsonb)
      from (select distinct r.chapter_id, r.access_unit_id, r.access_committee_id from public.chapter_records r
             where r.access_unit_id is not null or r.access_committee_id is not null) d
    )
    else '{}'::jsonb
  end
$$;

-- The reactions private.can_read_message_source accepts for the caller through
-- its member-conversation, chapter-channel and task-message branches, each
-- condition as that function states it. actor_has_chapter_staff_role is asked
-- once: the channel branch only reaches posts in the caller's own chapter.
create function private.current_actor_readable_message_reactions()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with actor as materialized (
    select profile.id, profile.chapter_id,
      private.actor_has_chapter_staff_role(profile.id, profile.chapter_id) as chapter_staff
    from public.member_profiles profile
    where profile.id = (select auth.uid())
  ),
  readable as (
    -- private.can_actor_send_private_message(actor, conversation, 'member').
    select reaction.id
    from actor
    join public.member_conversations conversation on conversation.user_id = actor.id
    join public.member_messages message
      on message.conversation_id = conversation.id
     and message.learning_removal_held_at is null
    join public.member_message_reactions reaction
      on reaction.source_kind = 'private'
     and reaction.private_message_id = message.id
    union all
    select reaction.id
    from actor
    join public.chapter_thread_posts post
      on post.chapter_id = actor.chapter_id
     and post.deleted_at is null
    join public.chapter_threads thread on thread.id = post.thread_id
    join public.chapter_spaces space on space.id = thread.space_id
    join public.member_message_reactions reaction
      on reaction.source_kind = 'channel'
     and reaction.channel_post_id = post.id
    where space.visibility = 'chapter'
       or space.created_by = actor.id
       or exists (
         select 1 from public.chapter_space_members membership
         where membership.space_id = space.id and membership.user_id = actor.id
       )
       or (space.visibility = 'staff' and actor.chapter_staff)
    union all
    select reaction.id
    from actor
    join public.chapter_task_messages message
      on message.chapter_id = actor.chapter_id
     and actor.id in (message.sender_id, message.recipient_id)
    join public.member_message_reactions reaction
      on reaction.source_kind = 'task'
     and reaction.task_message_id = message.id
  )
  select coalesce(pg_catalog.jsonb_object_agg(readable.id, true), '{}'::jsonb)
  from readable
$$;

-- RLS evaluates both helpers as the querying role.
revoke all on function private.chapter_records_scope_memo(text) from public, anon, authenticated, service_role;
grant execute on function private.chapter_records_scope_memo(text) to authenticated;
revoke all on function private.current_actor_readable_message_reactions() from public, anon, authenticated, service_role;
grant execute on function private.current_actor_readable_message_reactions() to authenticated;

alter policy chapter_records_select on public.chapter_records using (
  ((private.chapter_record_publication(record_type) = 'chapter_members'
    and lifecycle_status = 'published'
    and visibility = 'chapter'
    and archived_at is null
    and coalesce(((select private.chapter_records_scope_memo('member')) ->> chapter_id)::boolean,
      private.can_read_chapter_member_record(chapter_id)))
  or (archived_at is null
    and coalesce(((select private.chapter_records_scope_memo('contact')) ->> chapter_id)::boolean,
      private.can_read_chapter_contact_record(chapter_id)))
  or (private.chapter_record_publication(record_type) = 'chapter_members'
    and coalesce(((select private.chapter_records_scope_memo('officer'))
        ->> pg_catalog.jsonb_build_array(chapter_id, access_unit_id, access_committee_id)::text)::boolean,
      private.chapter_officer_can_for_scope(chapter_id, 'records', access_unit_id, access_committee_id))))
);

alter policy chapter_records_container_scope on public.chapter_records using (
  (access_unit_id is null and access_committee_id is null)
  or coalesce(((select private.chapter_records_scope_memo('container'))
      ->> pg_catalog.jsonb_build_array(chapter_id, access_unit_id, access_committee_id)::text)::boolean,
    private.chapter_record_manageable(chapter_id, access_unit_id, access_committee_id)
      or private.chapter_scope_member_allowed(chapter_id, access_unit_id, access_committee_id, (select auth.uid())))
);

alter policy member_message_reactions_read on public.member_message_reactions using (
  coalesce(((select private.current_actor_readable_message_reactions()) ->> id::text)::boolean,
    private.current_actor_can_read_message_source(source_kind,
      private_message_id, channel_post_id, task_message_id))
);

comment on policy chapter_records_select on public.chapter_records is 'Combine member/staff and capability-bound officer reads in one permissive policy. Restrictive tenant and container-scope guards continue to apply to every branch. #7210 (20261106210000): each helper answer comes from private.chapter_records_scope_memo, which asks the same helper once per distinct chapter or scope in the table per statement; a value it does not hold falls through to the helper itself.';
comment on policy chapter_records_container_scope on public.chapter_records is 'Limit every existing read and write path to active chapter and container authority; private grievance identities require an assigned or oversight role. #7210 (20261106210000): the helper answer for a unit or committee row comes from private.chapter_records_scope_memo once per statement; a scope it does not hold falls through to the helpers themselves.';
comment on policy member_message_reactions_read on public.member_message_reactions is 'A reaction is readable exactly when its source message is (private.current_actor_can_read_message_source). #7210 (20261106210000): reactions private.current_actor_readable_message_reactions lists once per statement through the same predicate''s own-conversation, chapter-channel and task branches are accepted without the per-row call; every other row still makes it.';

-- Not partial: the ON DELETE CASCADE from each source table probes these
-- columns without a source_kind predicate, and a partial index cannot serve it.
create index member_message_reactions_private_message_idx
  on public.member_message_reactions (private_message_id);
create index member_message_reactions_channel_post_idx
  on public.member_message_reactions (channel_post_id);
create index member_message_reactions_task_message_idx
  on public.member_message_reactions (task_message_id);

-- The reactions on the messages a screen loaded, read as the caller (security
-- invoker: member_message_reactions_read and mfa_assurance apply unchanged).
-- One jsonb value, so PostgREST's 1,000-row response cap cannot cut it short.
create function public.list_member_message_reactions(
  p_private_message_ids uuid[],
  p_channel_post_ids uuid[],
  p_task_message_ids uuid[]
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform private.require_member_session();
  if coalesce(pg_catalog.cardinality(p_private_message_ids), 0) > 1000
     or coalesce(pg_catalog.cardinality(p_channel_post_ids), 0) > 1000
     or coalesce(pg_catalog.cardinality(p_task_message_ids), 0) > 1000 then
    raise exception 'at most 1000 message ids of each kind' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.created_at, t.id)
    from (
      select r.id, r.actor_id, r.source_kind, r.private_message_id, r.channel_post_id,
        r.task_message_id, r.reaction, r.created_at
      from public.member_message_reactions r
      where (r.source_kind = 'private' and r.private_message_id = any(p_private_message_ids))
         or (r.source_kind = 'channel' and r.channel_post_id = any(p_channel_post_ids))
         or (r.source_kind = 'task' and r.task_message_id = any(p_task_message_ids))
    ) t
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_member_message_reactions(uuid[], uuid[], uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.list_member_message_reactions(uuid[], uuid[], uuid[]) to authenticated;

notify pgrst, 'reload schema';

commit;
