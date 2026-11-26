begin;

-- REQ-UG-SPANISH-SPACES-AND-POSTS-20261030 (#6632, finding 103 of
-- the Oct 29-30, 2026 production role-play run): a chapter space can carry a
-- Spanish name and description, and a channel post a Spanish body, beside the
-- original. Readers on the Spanish view see the Spanish version where one
-- exists and the original otherwise (src/lib/bilingualContent.js).
--
-- Every surface that guards the original columns covers the new ones:
--   1. Bounds: the same limits as name (1-80 after trim), description (1000)
--      and body (1-8000 after trim); null means "no Spanish version".
--   2. Column grants: INSERT on chapter_spaces.name_es and description_es
--      beside name and description (the chapter staff create policy and the
--      MFA policy still decide every row) and on chapter_thread_posts.body_es
--      beside body. No UPDATE is granted on any of them: a space's Spanish
--      version changes only through public.update_chapter_space_content,
--      together with the rest of the space in one transaction, and posts
--      keep the outright UPDATE revoke of 20260907120000.
--   3. The body-mutation guard refuses a change to body_es from every role,
--      service_role and the table owner included, exactly as it refuses body.
--   4. Message-briefing invalidation fires on body_es as on body.
--   5. The account lifecycle export carries the author's body_es.
-- The production cleanup content invariant
-- (scripts/lib/production-cleanup-content-invariant.mjs) fingerprints whole
-- rows (row::text), so the new columns are inside it without a change, and
-- supabase_realtime publishes chapter_thread_posts without a column list, so
-- an inserted post carries body_es to subscribers like body.
--   6. public.update_chapter_space_content takes p_name_es and
--      p_description_es. Omitted (null) keeps what the space holds, so a
--      caller that predates this migration keeps working; an empty string
--      clears it.
--   7. Channel alerts (private.produce_channel_post_alerts) match keywords
--      and @here in body_es as in body.
--   8. Mention search (public.search_my_channel_mentions) finds a Spanish
--      @here like the alert producer, and returns the Spanish versions.

alter table public.chapter_spaces
  add column name_es text,
  add column description_es text;
alter table public.chapter_spaces
  add constraint chapter_spaces_name_es_bounded
    check (name_es is null or pg_catalog.char_length(pg_catalog.btrim(name_es)) between 1 and 80),
  add constraint chapter_spaces_description_es_bounded
    check (description_es is null or pg_catalog.char_length(description_es) <= 1000);
comment on column public.chapter_spaces.name_es is
  'REQ-UG-SPANISH-SPACES-AND-POSTS-20261030: the space name in Spanish, or null when the space has none.';
comment on column public.chapter_spaces.description_es is
  'REQ-UG-SPANISH-SPACES-AND-POSTS-20261030: the space description in Spanish, or null when the space has none.';

alter table public.chapter_thread_posts
  add column body_es text;
alter table public.chapter_thread_posts
  add constraint chapter_thread_posts_body_es_bounded
    check (body_es is null or pg_catalog.char_length(pg_catalog.btrim(body_es)) between 1 and 8000);
comment on column public.chapter_thread_posts.body_es is
  'REQ-UG-SPANISH-SPACES-AND-POSTS-20261030: the post body in Spanish, written with the post and never changed afterwards (private.guard_chapter_post_body_mutation).';

grant insert (name_es, description_es) on public.chapter_spaces to authenticated;
grant insert (body_es) on public.chapter_thread_posts to authenticated;

-- 3. The guard: body_es joins body, edited_at and deleted_at. Identity
-- columns stay out of it for the referential-maintenance reasons recorded in
-- 20260907120000 and pinned by tests/chapter-post-referential-maintenance-db.test.js.
create or replace function private.guard_chapter_post_body_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if private.chapter_post_edit_contract_active() then
    return new;
  end if;
  -- SCOPE: the post's content and tombstone columns (body, body_es,
  -- edited_at, deleted_at). Identity columns are deliberately not compared:
  -- author_id, parent_post_id and chapter_id carry referential actions that
  -- PostgreSQL performs as row-trigger-firing UPDATEs (account deletion, the
  -- deletion of a post with replies, a change of chapter id), and
  -- private.stamp_product_identity plus the revoked UPDATE grant keep them
  -- immutable.
  if new.body is distinct from old.body
     or new.body_es is distinct from old.body_es
     or new.edited_at is distinct from old.edited_at
     or new.deleted_at is distinct from old.deleted_at then
    raise exception 'chapter post body mutation is not permitted'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

comment on function private.guard_chapter_post_body_mutation() is
  'SEC-UG-POST-BODY-MUTATION-AUDIT: refuses every content and tombstone mutation on chapter_thread_posts (body, body_es, edited_at, deleted_at), from any role including service_role, until the edit contract switch is true. It deliberately does not inspect identity columns: author_id, parent_post_id and chapter_id carry referential actions that PostgreSQL performs as row-trigger-firing UPDATEs, so comparing them would refuse account deletion, the deletion of a post that has replies, and a change of chapter id. private.stamp_product_identity restores thread_id/chapter_id/author_id/created_at on every ordinary UPDATE; parent_post_id is protected by the revoked grant alone. body_es: REQ-UG-SPANISH-SPACES-AND-POSTS-20261030.';

revoke all on function private.guard_chapter_post_body_mutation()
  from public, anon, authenticated, service_role;

-- 4. Briefing invalidation. The function serves three tables; only channel
-- posts carry body_es, so it is read by name from the row's JSON (null for
-- the other two tables) instead of as a record field they do not have.
create or replace function private.invalidate_message_briefings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare kind text; target uuid;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if tg_op = 'UPDATE' and old.body is not distinct from new.body
     and (pg_catalog.to_jsonb(old) -> 'body_es') is not distinct from (pg_catalog.to_jsonb(new) -> 'body_es') then
    return new;
  end if;
  if tg_table_name = 'member_messages' then kind := 'private'; target := old.conversation_id;
  elsif tg_table_name = 'chapter_thread_posts' then kind := 'channel'; target := old.thread_id;
  else kind := 'task'; target := old.task_id; end if;
  delete from public.compass_message_briefings where source_kind = kind and target_id = target;
  if kind = 'private' then
    update public.compass_workspace_actions set title = 'Follow up on member message'
      where source_kind = 'message' and source_id in
        (select m.id::text from public.member_messages m where m.conversation_id = target
         union select old.id::text);
  end if;
  return null;
end;
$function$;

revoke all on function private.invalidate_message_briefings()
  from public, anon, authenticated, service_role;

do $briefing_trigger$
begin
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.chapter_thread_posts'::regclass and t.tgname = 'invalidate_message_briefings'
      and not t.tgisinternal and t.tgenabled = 'O'
      and pg_catalog.pg_get_triggerdef(t.oid) =
        'CREATE TRIGGER invalidate_message_briefings AFTER DELETE OR UPDATE OF body ON public.chapter_thread_posts FOR EACH ROW EXECUTE FUNCTION private.invalidate_message_briefings()'
  ) then
    raise exception 'unreviewed chapter_thread_posts invalidate_message_briefings definition' using errcode = '55000';
  end if;
end;
$briefing_trigger$;
drop trigger invalidate_message_briefings on public.chapter_thread_posts;
create trigger invalidate_message_briefings
  after delete or update of body, body_es on public.chapter_thread_posts
  for each row execute function private.invalidate_message_briefings();

-- 5. The author's export carries body_es.
update private.account_lifecycle_manifest
set export_columns = export_columns || array['body_es']::text[]
where schema_name = 'public' and table_name = 'chapter_thread_posts' and user_column = 'author_id'
  and not ('body_es' = any(export_columns));
create or replace function private.account_lifecycle_export_chapter_thread_posts(p_caller uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', t.id, 'thread_id', t.thread_id, 'chapter_id', t.chapter_id, 'author_id', t.author_id,
    'body', t.body, 'parent_post_id', t.parent_post_id, 'created_at', t.created_at,
    'edited_at', t.edited_at, 'deleted_at', t.deleted_at, 'author_name', t.author_name,
    'author_initials', t.author_initials, 'author_role', t.author_role, 'body_es', t.body_es)), '[]'::jsonb)
  from public.chapter_thread_posts t where t.author_id = p_caller;
$$;
revoke all on function private.account_lifecycle_export_chapter_thread_posts(uuid)
  from public, anon, authenticated, service_role;

-- 6. The space editor saves the Spanish version atomically with the space.
-- The body is the previous one plus the two Spanish assignments.
drop function public.update_chapter_space_content(uuid, text, text, text, boolean);
create function public.update_chapter_space_content(
  p_id uuid, p_name text, p_description text, p_visibility text, p_archive boolean default false,
  p_name_es text default null, p_description_es text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare row public.chapter_spaces%rowtype; chapter text := private.assert_publisher();
begin
  if p_visibility not in ('chapter','staff','private') then raise exception 'invalid visibility' using errcode='22023'; end if;
  update public.chapter_spaces s set name=btrim(p_name), description=coalesce(p_description,''), visibility=p_visibility,
    archived_at=case when p_archive then coalesce(s.archived_at, now()) else null end,
    name_es=case when p_name_es is null then s.name_es else nullif(btrim(p_name_es), '') end,
    description_es=case when p_description_es is null then s.description_es else nullif(btrim(p_description_es), '') end
  where s.id=p_id and s.chapter_id=chapter returning s.* into row;
  if row.id is null then raise exception 'space unavailable' using errcode='22023'; end if;
  return to_jsonb(row);
end;
end;
end;
$function$;
revoke all on function public.update_chapter_space_content(uuid, text, text, text, boolean, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.update_chapter_space_content(uuid, text, text, text, boolean, text, text)
  to authenticated, service_role;

-- 7. Channel alerts: a keyword or @here in the Spanish version notifies
-- exactly as in the original, so what the hub highlights is what alerts.
-- The body is the 20261003034000 producer plus the body_es reads.
create or replace function private.produce_channel_post_alerts(p_post_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  post record;
  mentions_on boolean;
  here_on boolean;
  keywords_on boolean;
  levels_on boolean;
  here_live boolean;
  author_label text;
  candidate record;
  delivered integer;
begin
  -- Notices are case-graph writes (member_notifications): enter the gate
  -- before the first row read, as every graph writer does.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  here_live := false;
  delivered := 0;
  select p.id, p.author_id, p.body, p.body_es, p.mentioned_user_ids, p.created_at, p.author_name,
         t.space_id, c.organization_id
    into post
  from public.chapter_thread_posts p
  join public.chapter_threads t on t.id = p.thread_id
  join public.chapter_spaces s on s.id = t.space_id and s.archived_at is null
  join public.chapters c on c.id = s.chapter_id
  where p.id = p_post_id and p.deleted_at is null;
  if post.id is null or post.organization_id is null then
    return 0;
  end if;

  mentions_on := private.organization_feature_enabled(post.organization_id, 'features.messaging.mentions');
  here_on := private.organization_feature_enabled(post.organization_id, 'features.messaging.here_mentions');
  keywords_on := private.organization_feature_enabled(post.organization_id, 'features.messaging.keyword_alerts');
  levels_on := private.organization_feature_enabled(post.organization_id, 'features.messaging.channel_notification_levels');

  -- @here: the message always posts; only the ping is rate-limited. One per
  -- author per channel per ten minutes; six per hour and twenty per day per
  -- author across the organization (old here-dispatch.ts cooldown + Patch2DA).
  -- A post's Spanish version counts like its original (body_es,
  -- REQ-UG-SPANISH-SPACES-AND-POSTS-20261030), for the ping and for
  -- the earlier pings that rate-limit it.
  if here_on and (private.channel_body_has_here(post.body) or private.channel_body_has_here(post.body_es)) then
    here_live := not exists (
      select 1 from public.chapter_thread_posts earlier
      join public.chapter_threads et on et.id = earlier.thread_id
      where earlier.author_id = post.author_id and earlier.id <> post.id
        and et.space_id = post.space_id
        and earlier.created_at >= post.created_at - interval '10 minutes'
        and earlier.created_at <= post.created_at
        and ((earlier.body ilike '%@here%' and private.channel_body_has_here(earlier.body))
          or (earlier.body_es ilike '%@here%' and private.channel_body_has_here(earlier.body_es)))
    );
    if here_live then
      here_live := (
        select pg_catalog.count(*) filter (where earlier.created_at >= post.created_at - interval '1 hour') < 6
          and pg_catalog.count(*) < 20
        from public.chapter_thread_posts earlier
        join public.chapter_threads et on et.id = earlier.thread_id
        join public.chapter_spaces es on es.id = et.space_id
        join public.chapters ec on ec.id = es.chapter_id and ec.organization_id = post.organization_id
        where earlier.author_id = post.author_id and earlier.id <> post.id
          and earlier.created_at >= post.created_at - interval '24 hours'
          and earlier.created_at <= post.created_at
          and ((earlier.body ilike '%@here%' and private.channel_body_has_here(earlier.body))
            or (earlier.body_es ilike '%@here%' and private.channel_body_has_here(earlier.body_es)))
      );
    end if;
  end if;

  author_label := coalesce(nullif(pg_catalog.btrim(post.author_name), ''), 'A chapter member');

  for candidate in
    with reasons(user_id, reason, priority) as (
      select m.id, 'mention'::text, 1
      from pg_catalog.unnest(case when mentions_on then post.mentioned_user_ids else '{}'::uuid[] end) m(id)
      union all
      select online.user_id, 'here', 2
      from (
        select presence.user_id
        from public.member_presence presence
        where here_live
          and presence.organization_id = post.organization_id
          and presence.status = 'online'
          and presence.last_seen_at >= pg_catalog.now() - interval '5 minutes'
          and presence.user_id <> post.author_id
          and private.channel_member_can_read_space(presence.user_id, post.space_id)
        order by presence.last_seen_at desc, presence.user_id
        limit 200
      ) online
      union all
      select s.user_id, 'keyword', 3
      from public.chapter_space_notification_settings s
      where keywords_on
        and s.organization_id = post.organization_id and s.space_id = post.space_id
        and pg_catalog.cardinality(s.keywords) > 0
        and (private.channel_keywords_match(post.body, s.keywords)
          or (post.body_es is not null and private.channel_keywords_match(post.body_es, s.keywords)))
      union all
      select s.user_id, 'post', 4
      from public.chapter_space_notification_settings s
      where levels_on
        and s.organization_id = post.organization_id and s.space_id = post.space_id
        and s.notification_level = 'all'
    )
    select distinct on (r.user_id) r.user_id, r.reason
    from reasons r
    where r.user_id is not null and r.user_id <> post.author_id
    order by r.user_id, r.priority
    limit 1000
  loop
    continue when not private.channel_member_can_read_space(candidate.user_id, post.space_id);
    continue when private.channel_alert_decision(post.organization_id, post.space_id, candidate.user_id, candidate.reason) <> 'deliver';
    perform private.notify_member(candidate.user_id, 'channel.' || candidate.reason,
      pg_catalog.jsonb_build_object('name', author_label), 'messages');
    delivered := delivered + 1;
  end loop;
  return delivered;
end;
$function$;
revoke all on function private.produce_channel_post_alerts(uuid)
  from public, anon, authenticated, service_role;

-- 8. "Your mentions" finds what the alert producer notified: @here and the
-- search text match the Spanish version as the original, and each hit
-- carries the Spanish body and space name for a Spanish reader.
create or replace function public.search_my_channel_mentions(p_query text default null, p_limit integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  needle text := pg_catalog.btrim(coalesce(p_query, ''));
  cap integer := least(greatest(coalesce(p_limit, 30), 1), 50);
  here_on boolean;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if org is null or not private.is_organization_member(org) then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(org, 'features.messaging.mention_search') then
    perform private.raise_channel_control_disabled('Mention search');
  end if;
  if pg_catalog.char_length(needle) > 80 then
    raise exception 'query too long' using errcode = '22023';
  end if;
  needle := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(needle, '\', '\\'), '%', '\%'), '_', '\_');
  here_on := private.organization_feature_enabled(org, 'features.messaging.here_mentions');
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'postId', hit.id, 'threadId', hit.thread_id, 'spaceId', hit.space_id,
      'threadTitle', hit.thread_title, 'spaceName', hit.space_name,
      'body', hit.body, 'bodyEs', hit.body_es, 'spaceNameEs', hit.space_name_es, 'authorName', hit.author_name, 'authorInitials', hit.author_initials,
      'createdAt', hit.created_at, 'reason', hit.reason) order by hit.created_at desc, hit.id desc)
    from (
      select post.id, post.thread_id, thread.space_id, thread.title as thread_title, space.name as space_name,
        space.name_es as space_name_es, post.body, post.body_es, post.author_name, post.author_initials, post.created_at,
        case when caller = any(post.mentioned_user_ids) then 'mention' else 'here' end as reason
      from public.chapter_thread_posts post
      join public.chapter_threads thread on thread.id = post.thread_id
      join public.chapter_spaces space on space.id = thread.space_id
      join public.chapters chapter on chapter.id = space.chapter_id and chapter.organization_id = org
      where post.deleted_at is null
        and space.archived_at is null
        and private.can_read_chapter_space(space)
        and post.author_id <> caller
        and (
          caller = any(post.mentioned_user_ids)
          or (here_on and post.body ilike '%@here%' and private.channel_body_has_here(post.body))
          or (here_on and post.body_es ilike '%@here%' and private.channel_body_has_here(post.body_es))
        )
        and (needle = '' or post.body ilike '%' || needle || '%' escape '\'
          or post.body_es ilike '%' || needle || '%' escape '\')
      order by post.created_at desc, post.id desc
      limit cap
    ) hit
  ), '[]'::jsonb);
end;
$function$;

-- The lifecycle trigger review pins these exact definitions; refresh only the
-- four this delivery changed.
update private.account_lifecycle_trigger_review r
set definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))
from pg_catalog.pg_proc p
where r.kind = 'function' and r.schema_name = 'private' and r.table_name = ''
  and r.object_name = p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')'
  and p.oid in ('private.guard_chapter_post_body_mutation()'::regprocedure,
                'private.invalidate_message_briefings()'::regprocedure,
                'private.produce_channel_post_alerts(uuid)'::regprocedure);
update private.account_lifecycle_trigger_review r
set definition_hash = pg_catalog.md5(pg_catalog.pg_get_triggerdef(t.oid) || ':' || t.tgenabled::text)
from pg_catalog.pg_trigger t
where r.kind = 'trigger' and r.schema_name = 'public' and r.table_name = 'chapter_thread_posts'
  and r.object_name = 'invalidate_message_briefings'
  and t.tgrelid = 'public.chapter_thread_posts'::regclass and t.tgname = 'invalidate_message_briefings';

notify pgrst, 'reload schema';

commit;
