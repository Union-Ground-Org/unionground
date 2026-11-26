-- REQ-UG-OFFICER-NOTICES-WITH-READ-RECEIPTS-20261030
--
-- Officers could not post a notice that members mark as read. Every layer of
-- the existing member broadcasts (publish, retract, read counts and the event
-- announcement drafts) admitted only the steward role, so an admin or
-- president had no path at all, and the poster never saw who had read it.
--
-- This migration keeps the broadcast tables, receipts and RLS unchanged and:
--   1. lets the steward, admin and president (vp) roles publish, retract and
--      read counts, inside the same organization or chapter audience the
--      existing role helpers already bound (organization-wide needs an
--      organization grant; chapter needs that role in the selected chapter);
--   2. lets the same roles list and resolve the selected chapter's event
--      announcement drafts, so "Draft an announcement for new events" reaches
--      the officer who created the event;
--   3. adds list_my_member_notices (the caller's own notices with read and
--      audience counts) and get_member_notice_receipts (who has read one of
--      the caller's own notices, and when).
-- Bodies 1-2 are the live definitions (20260822010000 and 20261003032000, as
-- wrapped by 20260907151000's account-lifecycle entry lock, which publish,
-- retract and resolve keep ahead of every authorization read)
-- with only the role arrays and the sender line changed; the refusal texts
-- stay as they were so existing clients and proofs keep matching them.

begin;

create or replace function public.publish_member_broadcast(
  p_title text,
  p_body text,
  p_locale text default 'en',
  p_audience_scope text default 'chapter'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  publisher_org uuid := private.current_member_organization();
  publisher_chapter text := private.current_member_chapter();
  clean_title text := pg_catalog.btrim(coalesce(p_title, ''));
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''));
  clean_locale text := coalesce(nullif(pg_catalog.btrim(coalesce(p_locale, '')), ''), 'en');
  clean_scope text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_audience_scope, 'chapter')));
  recent integer;
  new_id text;
  next_index integer;
  attempts integer := 0;
  sender_label text;
begin
  if caller is null then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if publisher_org is null or publisher_chapter is null then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.chapters c
    where c.id = publisher_chapter and c.organization_id = publisher_org
  ) then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if clean_scope not in ('chapter', 'organization') then
    raise exception 'audience_scope must be chapter or organization' using errcode = '22023';
  end if;
  if clean_scope = 'organization'
     and not private.has_organization_role(publisher_org, array['steward', 'admin', 'vp']) then
    raise exception 'organization-wide steward role required' using errcode = '42501';
  end if;
  if clean_scope = 'chapter'
     and not private.member_has_chapter_role(publisher_chapter, array['steward', 'admin', 'vp']) then
    raise exception 'chapter steward role required' using errcode = '42501';
  end if;
  -- Members read the sender line. A steward keeps the existing sender; an
  -- admin or president who is not a steward in that scope posts as officers.
  sender_label := case
    when (clean_scope = 'organization' and private.has_organization_role(publisher_org, array['steward']))
      or (clean_scope = 'chapter' and private.member_has_chapter_role(publisher_chapter, array['steward']))
    then 'Chapter steward'
    else 'Union officers'
  end;

  if clean_title = '' or pg_catalog.char_length(clean_title) > 120 then
    raise exception 'title must be between 1 and 120 characters' using errcode = '22023';
  end if;
  if clean_title ~ '[[:cntrl:]]' then
    raise exception 'title contains unsupported control characters' using errcode = '22023';
  end if;
  if clean_body = '' or pg_catalog.char_length(clean_body) > 4000 then
    raise exception 'body must be between 1 and 4000 characters' using errcode = '22023';
  end if;
  if pg_catalog.regexp_replace(clean_body, '[' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9) || ']', '', 'g') ~ '[[:cntrl:]]' then
    raise exception 'body contains unsupported control characters' using errcode = '22023';
  end if;
  if clean_locale not in ('en', 'es') then
    raise exception 'locale must be en or es' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-broadcast-publish:' || caller::text, 509));

  select count(*) into recent
  from public.member_broadcasts
  where created_by = caller
    and published_at >= now() - interval '24 hours';
  if recent >= 5 then
    raise exception 'broadcast limit reached: 5 per steward per day' using errcode = '54000';
  end if;

  loop
    begin
      new_id := 'bc-' || extensions.gen_random_uuid();
      select coalesce(min(order_index), 1) - 1 into next_index from public.member_broadcasts;
      insert into public.member_broadcasts (
        id, sender, title, body, published_at, order_index, created_by, locale,
        organization_id, chapter_id, audience_scope
      )
      values (
        new_id, sender_label, clean_title, clean_body, now(), next_index, caller, clean_locale,
        publisher_org, publisher_chapter, clean_scope
      );
      exit;
    exception when unique_violation then
      attempts := attempts + 1;
      if attempts >= 3 then
        raise;
      end if;
    end;
  end loop;

  return pg_catalog.jsonb_build_object('broadcastId', new_id);
end;
end;
$function$;

create or replace function public.retract_member_broadcast(p_broadcast_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  publisher_org uuid := private.current_member_organization();
  updated integer;
begin
  if caller is null
     or not private.member_has_chapter_role(private.current_member_chapter(), array['steward', 'admin', 'vp']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if publisher_org is null then
    raise exception 'organization required' using errcode = '42501';
  end if;

  update public.member_broadcasts
  set retracted_at = now()
  where id = p_broadcast_id
    and created_by = caller
    and retracted_at is null
    and organization_id = publisher_org;
  get diagnostics updated = row_count;
  if updated = 0 then
    raise exception 'broadcast not found, not yours, or already retracted' using errcode = '22023';
  end if;

  return pg_catalog.jsonb_build_object('broadcastId', p_broadcast_id, 'retracted', true);
end;
end;
$function$;

create or replace function public.get_broadcast_read_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  result jsonb;
  publisher_org uuid := private.current_member_organization();
begin
  if (select auth.uid()) is null
     or not private.member_has_chapter_role(private.current_member_chapter(), array['steward', 'admin', 'vp']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if publisher_org is null then
    return '[]'::jsonb;
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'broadcastId', recent.id,
      'readCount', (select count(*) from public.member_broadcast_receipts reads where reads.broadcast_id = recent.id)
    ) order by recent.published_at desc
  ), '[]'::jsonb)
  into result
  from (
    select b.id, b.published_at
    from public.member_broadcasts b
    where b.organization_id = publisher_org
      and private.can_read_member_broadcast(b.id)
    order by b.published_at desc
    limit 20
  ) recent;

  return result;
end;
$function$;

create or replace function public.get_broadcast_read_counts_for(p_broadcast_ids text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  result jsonb;
  publisher_org uuid := private.current_member_organization();
begin
  if (select auth.uid()) is null
     or not private.member_has_chapter_role(private.current_member_chapter(), array['steward', 'admin', 'vp']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_broadcast_ids is null
     or pg_catalog.cardinality(p_broadcast_ids) < 1
     or pg_catalog.cardinality(p_broadcast_ids) > 100 then
    raise exception 'between 1 and 100 broadcast ids' using errcode = '22023';
  end if;
  if publisher_org is null then
    return '[]'::jsonb;
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'broadcastId', b.id,
      'readCount', (select count(*) from public.member_broadcast_receipts reads where reads.broadcast_id = b.id)
    ) order by b.published_at desc
  ), '[]'::jsonb)
  into result
  from public.member_broadcasts b
  where b.id = any(p_broadcast_ids)
    and b.organization_id = publisher_org
    and private.can_read_member_broadcast(b.id);

  return result;
end;
$function$;

create or replace function public.list_announcement_drafts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  chapter text;
  rows jsonb;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  org := private.current_member_organization();
  chapter := private.current_member_chapter();
  if org is null or chapter is null or not private.member_has_chapter_role(chapter, array['steward', 'admin', 'vp']) then
    raise exception 'chapter steward role required' using errcode = '42501';
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', f.id, 'title', f.title, 'body', f.body, 'eventId', f.source_id, 'createdAt', f.created_at
    ) order by f.created_at desc, f.id), '[]'::jsonb)
    into rows
  from (
    select f.* from private.engagement_follow_ups f
    join public.member_events e on e.id = f.source_id and e.chapter_id = f.chapter_id and e.cancelled_at is null
    where f.organization_id = org and f.chapter_id = chapter
      and f.kind = 'announcement_draft' and f.state = 'draft'
    order by f.created_at desc, f.id
    limit 20
  ) f;
  return pg_catalog.jsonb_build_object('organizationId', org, 'drafts', rows);
end;
$function$;

create or replace function public.resolve_announcement_draft(p_draft_id uuid, p_state text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  actor uuid := (select auth.uid());
  org uuid;
  chapter text;
  resolved uuid;
begin
  if actor is null or not private.mfa_satisfied() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  if p_state is null or p_state not in ('published', 'dismissed') then
    raise exception 'invalid draft state' using errcode = '22023';
  end if;
  org := private.current_member_organization();
  chapter := private.current_member_chapter();
  if org is null or chapter is null or not private.member_has_chapter_role(chapter, array['steward', 'admin', 'vp']) then
    raise exception 'chapter steward role required' using errcode = '42501';
  end if;
  update private.engagement_follow_ups f
     set state = p_state, resolved_at = pg_catalog.now()
   where f.id = p_draft_id and f.organization_id = org and f.chapter_id = chapter
     and f.kind = 'announcement_draft' and f.state = 'draft'
  returning f.id into resolved;
  if resolved is null then
    raise exception 'draft unavailable' using errcode = '22023';
  end if;
  perform private.cr108_record_audit(
    org, 'announcement_draft_resolved', 'update', 'broadcast', resolved::text, actor,
    pg_catalog.jsonb_build_object('status', p_state), extensions.gen_random_uuid()
  );
  return pg_catalog.jsonb_build_object('organizationId', org, 'id', resolved, 'state', p_state);
end;
end;
$function$;

-- Who a notice reaches: every active member of the organization, or every
-- active member of the chapter who is also an active member of the
-- organization. Reads and the audience are counted with the same predicate,
-- so a member who left is in neither. Internal to the definers below.
create or replace function private.member_notice_in_audience(
  p_user_id uuid,
  p_organization_id uuid,
  p_chapter_id text,
  p_audience_scope text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_audience_scope in ('organization', 'chapter')
    and exists (
      select 1
      from public.organization_memberships om
      where om.user_id = p_user_id
        and om.organization_id = p_organization_id
        and om.status = 'active'
    )
    and (
      p_audience_scope = 'organization'
      or exists (
        select 1
        from public.member_chapter_memberships m
        where m.user_id = p_user_id
          and m.chapter_id = p_chapter_id
          and m.status = 'active'
      )
    );
$function$;

revoke all on function private.member_notice_in_audience(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;

create or replace function private.member_notice_audience_count(
  p_organization_id uuid,
  p_chapter_id text,
  p_audience_scope text
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.count(*)
  from public.organization_memberships om
  where om.organization_id = p_organization_id
    and om.status = 'active'
    and private.member_notice_in_audience(om.user_id, p_organization_id, p_chapter_id, p_audience_scope);
$function$;

revoke all on function private.member_notice_audience_count(uuid, text, text)
  from public, anon, authenticated, service_role;

create or replace function private.member_notice_read_count(p_broadcast_id text)
returns bigint
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.count(*)
  from public.member_broadcast_receipts r
  join public.member_broadcasts b on b.id = r.broadcast_id
  where r.broadcast_id = p_broadcast_id
    and private.member_notice_in_audience(r.user_id, b.organization_id, b.chapter_id, b.audience_scope);
$function$;

revoke all on function private.member_notice_read_count(text)
  from public, anon, authenticated, service_role;

create or replace function public.list_my_member_notices(
  p_limit integer default 20,
  p_before_published timestamptz default null,
  p_before_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  chapter text := private.current_member_chapter();
  page_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  rows jsonb;
  more boolean;
begin
  if caller is null or org is null or chapter is null
     or not private.member_has_chapter_role(chapter, array['steward', 'admin', 'vp']) then
    raise exception 'notice publisher role required' using errcode = '42501';
  end if;
  if (p_before_published is null) <> (p_before_id is null) then
    raise exception 'incomplete cursor' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', n.id,
      'title', n.title,
      'body', n.body,
      'locale', n.locale,
      'audience', n.audience_scope,
      'chapterId', n.chapter_id,
      'publishedAt', n.published_at,
      'retractedAt', n.retracted_at,
      'readCount', private.member_notice_read_count(n.id),
      'audienceCount', private.member_notice_audience_count(n.organization_id, n.chapter_id, n.audience_scope)
    ) order by n.published_at desc, n.id desc), '[]'::jsonb)
    into rows
  from (
    select b.id, b.title, b.body, b.locale, b.audience_scope, b.chapter_id,
           b.organization_id, b.published_at, b.retracted_at
    from public.member_broadcasts b
    where b.created_by = caller
      and b.organization_id = org
      and (p_before_published is null or (b.published_at, b.id) < (p_before_published, p_before_id))
    order by b.published_at desc, b.id desc
    limit page_limit
  ) n;

  -- One row past the page says whether an older page exists.
  select exists (
    select 1
    from public.member_broadcasts b
    where b.created_by = caller
      and b.organization_id = org
      and (p_before_published is null or (b.published_at, b.id) < (p_before_published, p_before_id))
    order by b.published_at desc, b.id desc
    offset page_limit
  ) into more;

  return pg_catalog.jsonb_build_object('notices', rows, 'hasMore', more);
end;
$function$;

comment on function public.list_my_member_notices(integer, timestamptz, text) is
  'REQ-UG-OFFICER-NOTICES-WITH-READ-RECEIPTS-20261030: the caller''s own notices in the selected organization, newest first and paged by (published_at, id), with read and audience counts. Steward, admin or president in the selected chapter (organization grants count); 42501 otherwise.';

revoke all on function public.list_my_member_notices(integer, timestamptz, text) from public, anon;
grant execute on function public.list_my_member_notices(integer, timestamptz, text) to authenticated, service_role;

create or replace function public.get_member_notice_receipts(p_broadcast_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  chapter text := private.current_member_chapter();
  notice record;
  readers jsonb;
begin
  if caller is null or org is null or chapter is null
     or not private.member_has_chapter_role(chapter, array['steward', 'admin', 'vp']) then
    raise exception 'notice publisher role required' using errcode = '42501';
  end if;

  select b.id, b.organization_id, b.chapter_id, b.audience_scope
    into notice
  from public.member_broadcasts b
  where b.id = p_broadcast_id
    and b.created_by = caller
    and b.organization_id = org;
  if not found then
    raise exception 'notice not found or not yours' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', nullif(pg_catalog.btrim(coalesce(p.full_name, '')), ''),
      'readAt', r.read_at
    ) order by r.read_at desc, r.user_id), '[]'::jsonb)
    into readers
  from (
    select receipt.user_id, receipt.read_at
    from public.member_broadcast_receipts receipt
    where receipt.broadcast_id = notice.id
      and private.member_notice_in_audience(receipt.user_id, notice.organization_id, notice.chapter_id, notice.audience_scope)
    order by receipt.read_at desc, receipt.user_id
    limit 500
  ) r
  left join public.member_profiles p on p.id = r.user_id;

  return pg_catalog.jsonb_build_object(
    'id', notice.id,
    'readCount', private.member_notice_read_count(notice.id),
    'audienceCount', private.member_notice_audience_count(notice.organization_id, notice.chapter_id, notice.audience_scope),
    'readers', readers
  );
end;
$function$;

comment on function public.get_member_notice_receipts(text) is
  'REQ-UG-OFFICER-NOTICES-WITH-READ-RECEIPTS-20261030: who has read one of the caller''s own notices and when (newest 500), with read and audience counts. Only the notice''s publisher, while holding the steward, admin or president role in the selected organization.';

revoke all on function public.get_member_notice_receipts(text) from public, anon;
grant execute on function public.get_member_notice_receipts(text) to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
