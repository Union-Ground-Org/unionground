-- REQ-UG-STEWARD-NOTICES-LIMITED-TO-UNIT-20261109 (#7664)
-- Reuse durable notice audiences and the existing leadership oracle. No
-- chapter-wide role predicate is widened; unit membership grants no staff hat.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
set local search_path=pg_catalog,public,extensions;
do $predecessors$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.publish_member_broadcast(text, text, text, text)'))) is distinct from '8cd48e1085e9358e465943eaae36ea43' then
    raise exception 'unreviewed predecessor: public.publish_member_broadcast' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.publish_chapter_office_notice(text, text, text, text, uuid, uuid)'))) is distinct from '2e0289a4c3a98e1900750c0b7889b8f7' then
    raise exception 'unreviewed predecessor: public.publish_chapter_office_notice' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.retract_member_broadcast(text)'))) is distinct from 'dbfbbdf7f3bab8460def16bde91ef224' then
    raise exception 'unreviewed predecessor: public.retract_member_broadcast' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.list_my_member_notices(integer, timestamp with time zone, text)'))) is distinct from 'f97c9eb97d7f49ecf71c8f380102cea7' then
    raise exception 'unreviewed predecessor: public.list_my_member_notices' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_member_notice_receipts(text)'))) is distinct from 'd17b341d11e9aa17dca82e8f74a63b3e' then
    raise exception 'unreviewed predecessor: public.get_member_notice_receipts' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_broadcast_read_counts()'))) is distinct from 'dd87d623f53ec09a125d97256da64ba2' then
    raise exception 'unreviewed predecessor: public.get_broadcast_read_counts' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_broadcast_read_counts_for(text[])'))) is distinct from 'beb0be85c091556c0513d2b006e5d207' then
    raise exception 'unreviewed predecessor: public.get_broadcast_read_counts_for' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_chapter_office_access()'))) is distinct from '78e3658017cf998f5f728001e0b48416' then
    raise exception 'unreviewed predecessor: public.get_chapter_office_access' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.list_steward_broadcasts(text, text, timestamp with time zone, text, integer)'))) is distinct from '098eaaad3c5395e2a97b6543de4060fe' then
    raise exception 'unreviewed predecessor: public.list_steward_broadcasts' using errcode='55000';
  end if;
end;
$predecessors$;

CREATE OR REPLACE FUNCTION private.chapter_notice_scope_allowed(p_chapter text, p_unit uuid, p_committee uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (select auth.uid()) is not null
    and private.mfa_satisfied() and not private.member_pin_session_restricted()
    and not (p_unit is not null and p_committee is not null)
    and exists (
      select 1 from public.chapters chapter
      where chapter.id=p_chapter
        and chapter.organization_id=private.current_member_organization()
        and private.is_organization_member(chapter.organization_id)
        and (p_unit is null or exists (
          select 1 from private.chapter_units unit
          where unit.id=p_unit and unit.chapter_id=p_chapter))
        and (p_committee is null or exists (
          select 1 from private.chapter_committees committee
          where committee.id=p_committee and committee.chapter_id=p_chapter
            and committee.starts_on<=current_date
            and (committee.ends_on is null or committee.ends_on>=current_date)))
        and (
          private.chapter_access_leadership(p_chapter)
          or (
            private.chapter_office_role_present(p_chapter,'notices')
            and exists (
              select 1 from public.member_role_chapters grant_row
              join private.chapter_role_capabilities capability
                on capability.role=grant_row.role and capability.capability='notices'
              left join private.chapter_role_settings setting
                on setting.chapter_id=grant_row.chapter_id and setting.role=grant_row.role
               and setting.capability='notices'
              where grant_row.user_id=(select auth.uid()) and grant_row.chapter_id=p_chapter
                and coalesce(setting.enabled,true)
                -- a project decision: only steward offices require
                -- a container; an unscoped enabled office keeps Main's reach.
                and (grant_row.role<>'steward' or p_unit is not null or p_committee is not null)
                and (
                  exists (
                    select 1 from private.steward_assignment_scopes((select auth.uid()),p_chapter) scope
                    where scope.user_id=grant_row.user_id and scope.chapter_id=grant_row.chapter_id
                      and scope.role=grant_row.role
                      and ((p_unit is not null and scope.unit_id=p_unit)
                        or (p_committee is not null and scope.committee_id=p_committee)))
                  or (grant_row.role<>'steward' and not exists (
                    select 1 from private.steward_assignment_scopes((select auth.uid()),p_chapter) scope
                    where scope.user_id=grant_row.user_id and scope.chapter_id=grant_row.chapter_id
                      and scope.role=grant_row.role))
                )
            )
          )
          -- #7664: an organization steward grant reaches only the unit it is
          -- assigned to in this chapter, under the chapter's steward notices
          -- setting, never the whole chapter or organization.
          or (
            p_unit is not null and p_committee is null
            and private.has_organization_role(chapter.organization_id,array['steward'])
            and exists (
              select 1 from private.organization_steward_unit_assignments assignment
              join private.chapter_role_capabilities capability
                on capability.role=assignment.role and capability.capability='notices'
              left join private.chapter_role_settings setting
                on setting.chapter_id=assignment.chapter_id and setting.role=assignment.role
               and setting.capability='notices'
              where assignment.user_id=(select auth.uid()) and assignment.chapter_id=p_chapter
                and assignment.organization_id=chapter.organization_id and assignment.unit_id=p_unit
                and coalesce(setting.enabled,true)
            )
          )
        )
    );
$function$;
revoke all on function private.chapter_notice_scope_allowed(text,uuid,uuid) from public,anon,authenticated,service_role;

-- public.publish_member_broadcast (canonical owned predecessor; #7664)
CREATE OR REPLACE FUNCTION public.publish_member_broadcast(p_title text, p_body text, p_locale text DEFAULT 'en'::text, p_audience_scope text DEFAULT 'chapter'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
     and not private.has_organization_role(publisher_org, array['admin','vp']) then
    raise exception 'organization-wide steward role required' using errcode = '42501';
  end if;
  if clean_scope = 'chapter'
     and not private.chapter_notice_scope_allowed(publisher_chapter,null,null) then
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

-- public.publish_chapter_office_notice (canonical owned predecessor; #7664)
CREATE OR REPLACE FUNCTION public.publish_chapter_office_notice(p_chapter text, p_title text, p_body text, p_locale text DEFAULT 'en'::text, p_unit uuid DEFAULT NULL::uuid, p_committee uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  publisher_org uuid := private.current_member_organization();
  publisher_chapter text := private.current_member_chapter();
  clean_title text := pg_catalog.btrim(coalesce(p_title, ''));
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''));
  clean_locale text := coalesce(nullif(pg_catalog.btrim(coalesce(p_locale, '')), ''), 'en');
  clean_scope text := pg_catalog.lower(pg_catalog.btrim('chapter'));
  recent integer;
  new_id text;
  next_index integer;
  attempts integer := 0;
  sender_label text;
begin
  if not private.mfa_satisfied() or private.member_pin_session_restricted() or p_chapter is distinct from publisher_chapter or not private.chapter_notice_scope_allowed(p_chapter,p_unit,p_committee) then raise exception 'chapter notice access required' using errcode='42501'; end if;
  if p_unit is not null and p_committee is not null then raise exception 'choose one notice scope' using errcode='22023'; end if;
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
     and not private.has_organization_role(publisher_org, array['admin','vp']) then
    raise exception 'organization-wide steward role required' using errcode = '42501';
  end if;
  if clean_scope = 'chapter'
     and not private.chapter_notice_scope_allowed(p_chapter,p_unit,p_committee) then
    raise exception 'chapter steward role required' using errcode = '42501';
  end if;
  -- Members read the sender line. A steward keeps the existing sender; an
  -- admin or president who is not a steward in that scope posts as officers.
  sender_label := case
    when (clean_scope = 'organization' and private.has_organization_role(publisher_org, array['steward']))
      or (clean_scope = 'chapter' and private.member_has_chapter_staff_grant(publisher_chapter, array['steward']))
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
        organization_id, chapter_id, audience_scope, access_unit_id, access_committee_id
      )
      values (
        new_id, sender_label, clean_title, clean_body, now(), next_index, caller, clean_locale,
        publisher_org, publisher_chapter, clean_scope, p_unit, p_committee
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

-- public.retract_member_broadcast (canonical owned predecessor; #7664)
CREATE OR REPLACE FUNCTION public.retract_member_broadcast(p_broadcast_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  publisher_org uuid := private.current_member_organization();
  updated integer;
begin
  -- #7664 gate stage 155 (): retraction follows authorship, not the
  -- caller's current publishing scope, so a notice sent before this
  -- migration (or before a scope change) is never stranded. Only a verified
  -- session in the notice's organization may retract.
  if caller is null or not private.mfa_satisfied() or private.member_pin_session_restricted() then
    raise exception 'verified session required' using errcode = '42501';
  end if;
  if publisher_org is null then
    raise exception 'organization required' using errcode = '42501';
  end if;

  update public.member_broadcasts
  set retracted_at = now()
  where id = p_broadcast_id
    and retracted_at is null
    and organization_id = publisher_org
    -- The author always; chapter leadership (organization admin, chapter
    -- admin or VP) for any notice in its own chapter.
    and (created_by = caller
      or (audience_scope = 'chapter' and chapter_id is not null and private.chapter_access_leadership(chapter_id)));
  get diagnostics updated = row_count;
  if updated = 0 then
    raise exception 'broadcast not found, not yours, or already retracted' using errcode = '22023';
  end if;

  return pg_catalog.jsonb_build_object('broadcastId', p_broadcast_id, 'retracted', true);
end;
end;
$function$;

-- public.list_steward_broadcasts (canonical owned predecessor 20260826140000; #7664 gate stage 155)
CREATE OR REPLACE FUNCTION public.list_steward_broadcasts(p_filter text DEFAULT 'all'::text, p_search text DEFAULT NULL::text, p_after_published timestamp with time zone DEFAULT NULL::timestamp with time zone, p_after_id text DEFAULT NULL::text, p_limit integer DEFAULT 20)
 RETURNS TABLE(id text, sender text, title text, body text, published_at timestamp with time zone, retracted_at timestamp with time zone, locale text, audience_scope text, chapter_id text, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  page_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  needle text := nullif(pg_catalog.btrim(coalesce(p_search, '')), '');
  desk_org uuid := private.current_member_organization();
  pattern text;
  total bigint;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_filter not in ('all', 'active', 'retracted') then
    raise exception 'unknown broadcast filter' using errcode = '22023';
  end if;
  if (p_after_id is null) <> (p_after_published is null) then
    raise exception 'incomplete cursor' using errcode = '22023';
  end if;
  -- An orphan or organization-less session has no desk feed.
  if desk_org is null then
    return;
  end if;
  pattern := case when needle is null then null
    else '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(needle, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;

  -- #7664 gate stage 155 (): the desk shows what the caller reads as a
  -- member (the two member_broadcasts read policies, restated here because a
  -- definer bypasses them; the visible set is still evaluated once per
  -- statement) plus the caller's own notices, so an author
  -- outside the unit it sent to still sees that notice and can retract it.
  -- Nothing else beyond the caller's member audience is returned or counted.
  select count(*) into total
  from public.member_broadcasts b
  where b.organization_id = desk_org
    and ((b.id in (select private.visible_member_broadcast_ids())
        and ((b.access_unit_id is null and b.access_committee_id is null)
          or private.chapter_scope_member_allowed(b.chapter_id, b.access_unit_id, b.access_committee_id, caller)))
      or (b.created_by is not null and b.created_by = caller))
    and (p_filter = 'all'
      or (p_filter = 'active' and b.retracted_at is null)
      or (p_filter = 'retracted' and b.retracted_at is not null))
    and (pattern is null or b.title ilike pattern or b.body ilike pattern);

  return query
  select b.id, b.sender, b.title, b.body, b.published_at, b.retracted_at,
         b.locale, b.audience_scope, b.chapter_id, total
  from public.member_broadcasts b
  where b.organization_id = desk_org
    and ((b.id in (select private.visible_member_broadcast_ids())
        and ((b.access_unit_id is null and b.access_committee_id is null)
          or private.chapter_scope_member_allowed(b.chapter_id, b.access_unit_id, b.access_committee_id, caller)))
      or (b.created_by is not null and b.created_by = caller))
    and (p_filter = 'all'
      or (p_filter = 'active' and b.retracted_at is null)
      or (p_filter = 'retracted' and b.retracted_at is not null))
    and (pattern is null or b.title ilike pattern or b.body ilike pattern)
    and (p_after_id is null or (b.published_at, b.id) < (p_after_published, p_after_id))
  order by b.published_at desc, b.id desc
  limit page_limit;
end;
$function$;

-- public.list_my_member_notices (canonical owned predecessor; #7664)
CREATE OR REPLACE FUNCTION public.list_my_member_notices(p_limit integer DEFAULT 20, p_before_published timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  chapter text := private.current_member_chapter();
  page_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  rows jsonb;
  more boolean;
begin
  if caller is null or org is null or chapter is null
     or not (private.member_has_chapter_role(chapter, array['steward', 'admin', 'vp']) or private.chapter_office_role_present(chapter,'notices') or exists(select 1 from private.organization_steward_unit_assignments notice_assignment where notice_assignment.user_id=(select auth.uid()) and notice_assignment.chapter_id=chapter and private.chapter_notice_scope_allowed(chapter,notice_assignment.unit_id,null))) then
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
      'audienceCount', private.member_scoped_notice_audience_count(n.id)
    ) order by n.published_at desc, n.id desc), '[]'::jsonb)
    into rows
  from (
    select b.id, b.title, b.body, b.locale, b.audience_scope, b.chapter_id,
           b.organization_id, b.published_at, b.retracted_at
    from public.member_broadcasts b
    where b.created_by = caller
      and b.organization_id = org
      and ((b.audience_scope='chapter' and private.chapter_notice_scope_allowed(b.chapter_id,b.access_unit_id,b.access_committee_id)) or (b.audience_scope='organization' and private.has_organization_role(org,array['admin','vp'])))
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
      and ((b.audience_scope='chapter' and private.chapter_notice_scope_allowed(b.chapter_id,b.access_unit_id,b.access_committee_id)) or (b.audience_scope='organization' and private.has_organization_role(org,array['admin','vp'])))
      and (p_before_published is null or (b.published_at, b.id) < (p_before_published, p_before_id))
    order by b.published_at desc, b.id desc
    offset page_limit
  ) into more;

  return pg_catalog.jsonb_build_object('notices', rows, 'hasMore', more);
end;
$function$;

-- public.get_member_notice_receipts (canonical owned predecessor; #7664)
CREATE OR REPLACE FUNCTION public.get_member_notice_receipts(p_broadcast_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  chapter text := private.current_member_chapter();
  notice record;
  readers jsonb;
begin
  if caller is null or org is null or chapter is null
     or not (private.member_has_chapter_role(chapter, array['steward', 'admin', 'vp']) or private.chapter_office_role_present(chapter,'notices') or exists(select 1 from private.organization_steward_unit_assignments notice_assignment where notice_assignment.user_id=(select auth.uid()) and notice_assignment.chapter_id=chapter and private.chapter_notice_scope_allowed(chapter,notice_assignment.unit_id,null))) then
    raise exception 'notice publisher role required' using errcode = '42501';
  end if;

  select b.id, b.organization_id, b.chapter_id, b.audience_scope
    into notice
  from public.member_broadcasts b
  where b.id = p_broadcast_id
    and b.created_by = caller
    and b.organization_id = org
      and ((b.audience_scope='chapter' and private.chapter_notice_scope_allowed(b.chapter_id,b.access_unit_id,b.access_committee_id)) or (b.audience_scope='organization' and private.has_organization_role(org,array['admin','vp'])));
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
      and private.member_scoped_notice_in_audience(receipt.user_id,(select b from public.member_broadcasts b where b.id=notice.id))
    order by receipt.read_at desc, receipt.user_id
    limit 500
  ) r
  left join public.member_profiles p on p.id = r.user_id;

  return pg_catalog.jsonb_build_object(
    'id', notice.id,
    'readCount', private.member_notice_read_count(notice.id),
    'audienceCount', private.member_scoped_notice_audience_count(notice.id),
    'readers', readers
  );
end;
$function$;

-- public.get_broadcast_read_counts (canonical owned predecessor; #7664)
CREATE OR REPLACE FUNCTION public.get_broadcast_read_counts()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  result jsonb;
  publisher_org uuid := private.current_member_organization();
begin
  if (select auth.uid()) is null
     or not (private.member_has_chapter_role(private.current_member_chapter(), array['steward', 'admin', 'vp']) or private.chapter_office_role_present(private.current_member_chapter(),'notices') or exists(select 1 from private.organization_steward_unit_assignments notice_assignment where notice_assignment.user_id=(select auth.uid()) and notice_assignment.chapter_id=private.current_member_chapter() and private.chapter_notice_scope_allowed(private.current_member_chapter(),notice_assignment.unit_id,null))) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if publisher_org is null then
    return '[]'::jsonb;
  end if;

  with candidate as materialized (
    -- Candidates from the selected organization; the audience gate
    -- follows the cached publisher decisions below.
    select b.id, b.published_at, b.chapter_id, b.audience_scope, b.access_unit_id, b.access_committee_id, b.created_by
    from public.member_broadcasts b
    where b.organization_id = publisher_org

  ),
  publisher_scope as materialized (
    -- The chapter publisher checks once per chapter, unit and committee.
    select s.chapter_id, s.access_unit_id, s.access_committee_id,
      private.chapter_notice_scope_allowed(s.chapter_id,s.access_unit_id,s.access_committee_id) as allowed
    from (
      select distinct candidate.chapter_id, candidate.access_unit_id, candidate.access_committee_id
      from candidate
      where candidate.audience_scope = 'chapter'
    ) s
  ),
  organization_publisher as materialized (
    select private.has_organization_role(publisher_org,array['admin','vp']) as allowed
  ),
  readable as materialized (
    -- Membership readers and the author with current publisher authority.
    -- The latter may serve a unit without belonging to its member audience.
    -- Both publisher decisions are cached by distinct scope, never per row.
    select b.* from candidate b
    left join publisher_scope s
      on b.audience_scope='chapter' and s.chapter_id=b.chapter_id
     and s.access_unit_id is not distinct from b.access_unit_id
     and s.access_committee_id is not distinct from b.access_committee_id
    cross join organization_publisher o
    where b.id in (select private.visible_member_broadcast_ids())
       or (b.created_by is not null and b.created_by=(select auth.uid())
         and ((b.audience_scope='chapter' and s.allowed)
           or (b.audience_scope='organization' and o.allowed)))
  ),
  recent as materialized (
    select b.id, b.published_at, b.chapter_id, b.audience_scope, b.access_unit_id, b.access_committee_id
    from readable b
    left join publisher_scope s
      on b.audience_scope = 'chapter'
     and s.chapter_id = b.chapter_id
     and s.access_unit_id is not distinct from b.access_unit_id
     and s.access_committee_id is not distinct from b.access_committee_id
    cross join organization_publisher o
    where (b.audience_scope = 'chapter' and s.allowed) or (b.audience_scope = 'organization' and o.allowed)
    order by b.published_at desc
    limit 20
  ),
  reads as (
    -- Receipts from readers still in the notice's audience: the predicate of
    -- private.member_scoped_notice_in_audience, counted in one pass.
    select b.id, pg_catalog.count(*) as read_count
    from recent b
    join public.member_broadcast_receipts r on r.broadcast_id = b.id
    where exists (
        select 1
        from public.organization_memberships om
        where om.user_id = r.user_id
          and om.organization_id = publisher_org
          and om.status = 'active'
      )
      and (
        b.audience_scope = 'organization'
        or exists (
          select 1
          from public.member_chapter_memberships m
          where m.user_id = r.user_id
            and m.chapter_id = b.chapter_id
            and m.status = 'active'
        )
      )
      and (
        (b.access_unit_id is null and b.access_committee_id is null)
        or (exists (
          select 1
          from private.chapter_unit_members m
          where m.unit_id = b.access_unit_id
            and m.chapter_id = b.chapter_id
            and m.user_id = r.user_id
        ) or exists(select 1 from private.chapter_units default_unit where default_unit.id=b.access_unit_id and default_unit.chapter_id=b.chapter_id and default_unit.is_default and not exists(select 1 from private.chapter_unit_members physical_unit_member where physical_unit_member.chapter_id=b.chapter_id and physical_unit_member.user_id=r.user_id)))
        or exists (
          select 1
          from private.chapter_committees c
          join private.chapter_committee_members m on m.committee_id = c.id and m.chapter_id = c.chapter_id
          where c.id = b.access_committee_id
            and c.chapter_id = b.chapter_id
            and m.user_id = r.user_id
            and c.starts_on <= current_date
            and (c.ends_on is null or c.ends_on >= current_date)
        )
      )
    group by b.id
  )
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'broadcastId', recent.id,
      'readCount', coalesce(reads.read_count, 0)
    ) order by recent.published_at desc
  ), '[]'::jsonb)
  into result
  from recent
  left join reads on reads.id = recent.id;

  return result;
end;
$function$;

-- public.get_broadcast_read_counts_for (canonical owned predecessor; #7664)
CREATE OR REPLACE FUNCTION public.get_broadcast_read_counts_for(p_broadcast_ids text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  result jsonb;
  publisher_org uuid := private.current_member_organization();
begin
  if (select auth.uid()) is null
     or not (private.member_has_chapter_role(private.current_member_chapter(), array['steward', 'admin', 'vp']) or private.chapter_office_role_present(private.current_member_chapter(),'notices') or exists(select 1 from private.organization_steward_unit_assignments notice_assignment where notice_assignment.user_id=(select auth.uid()) and notice_assignment.chapter_id=private.current_member_chapter() and private.chapter_notice_scope_allowed(private.current_member_chapter(),notice_assignment.unit_id,null))) then
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

  with candidate as materialized (
    -- Candidates among the requested ids in the selected organization;
    -- the audience gate follows the cached publisher decisions below.
    select b.id, b.published_at, b.chapter_id, b.audience_scope, b.access_unit_id, b.access_committee_id, b.created_by
    from public.member_broadcasts b
    where b.id = any(p_broadcast_ids)
      and b.organization_id = publisher_org

  ),
  publisher_scope as materialized (
    -- The chapter publisher checks once per chapter, unit and committee.
    select s.chapter_id, s.access_unit_id, s.access_committee_id,
      private.chapter_notice_scope_allowed(s.chapter_id,s.access_unit_id,s.access_committee_id) as allowed
    from (
      select distinct candidate.chapter_id, candidate.access_unit_id, candidate.access_committee_id
      from candidate
      where candidate.audience_scope = 'chapter'
    ) s
  ),
  organization_publisher as materialized (
    select private.has_organization_role(publisher_org,array['admin','vp']) as allowed
  ),
  readable as materialized (
    -- Membership readers and the author with current publisher authority.
    -- The latter may serve a unit without belonging to its member audience.
    -- Both publisher decisions are cached by distinct scope, never per row.
    select b.* from candidate b
    left join publisher_scope s
      on b.audience_scope='chapter' and s.chapter_id=b.chapter_id
     and s.access_unit_id is not distinct from b.access_unit_id
     and s.access_committee_id is not distinct from b.access_committee_id
    cross join organization_publisher o
    where b.id in (select private.visible_member_broadcast_ids())
       or (b.created_by is not null and b.created_by=(select auth.uid())
         and ((b.audience_scope='chapter' and s.allowed)
           or (b.audience_scope='organization' and o.allowed)))
  ),
  asked as materialized (
    select b.id, b.published_at, b.chapter_id, b.audience_scope, b.access_unit_id, b.access_committee_id
    from readable b
    left join publisher_scope s
      on b.audience_scope = 'chapter'
     and s.chapter_id = b.chapter_id
     and s.access_unit_id is not distinct from b.access_unit_id
     and s.access_committee_id is not distinct from b.access_committee_id
    cross join organization_publisher o
    where (b.audience_scope = 'chapter' and s.allowed) or (b.audience_scope = 'organization' and o.allowed)
  ),
  reads as (
    -- Receipts from readers still in the notice's audience: the predicate of
    -- private.member_scoped_notice_in_audience, counted in one pass.
    select b.id, pg_catalog.count(*) as read_count
    from asked b
    join public.member_broadcast_receipts r on r.broadcast_id = b.id
    where exists (
        select 1
        from public.organization_memberships om
        where om.user_id = r.user_id
          and om.organization_id = publisher_org
          and om.status = 'active'
      )
      and (
        b.audience_scope = 'organization'
        or exists (
          select 1
          from public.member_chapter_memberships m
          where m.user_id = r.user_id
            and m.chapter_id = b.chapter_id
            and m.status = 'active'
        )
      )
      and (
        (b.access_unit_id is null and b.access_committee_id is null)
        or (exists (
          select 1
          from private.chapter_unit_members m
          where m.unit_id = b.access_unit_id
            and m.chapter_id = b.chapter_id
            and m.user_id = r.user_id
        ) or exists(select 1 from private.chapter_units default_unit where default_unit.id=b.access_unit_id and default_unit.chapter_id=b.chapter_id and default_unit.is_default and not exists(select 1 from private.chapter_unit_members physical_unit_member where physical_unit_member.chapter_id=b.chapter_id and physical_unit_member.user_id=r.user_id)))
        or exists (
          select 1
          from private.chapter_committees c
          join private.chapter_committee_members m on m.committee_id = c.id and m.chapter_id = c.chapter_id
          where c.id = b.access_committee_id
            and c.chapter_id = b.chapter_id
            and m.user_id = r.user_id
            and c.starts_on <= current_date
            and (c.ends_on is null or c.ends_on >= current_date)
        )
      )
    group by b.id
  )
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'broadcastId', b.id,
      'readCount', coalesce(reads.read_count, 0)
    ) order by b.published_at desc
  ), '[]'::jsonb)
  into result
  from asked b
  left join reads on reads.id = b.id;

  return result;
end;
$function$;

-- public.get_chapter_office_access (canonical owned predecessor; #7664)
CREATE OR REPLACE FUNCTION public.get_chapter_office_access()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare chapter text:=private.current_member_chapter();
begin
  if chapter is null or not private.mfa_satisfied() or private.member_pin_session_restricted() then raise exception 'chapter context required' using errcode='42501'; end if;
  return pg_catalog.jsonb_build_object('chapterId',chapter,
    'records',private.chapter_office_role_present(chapter,'records'),
    'documents',private.chapter_office_role_present(chapter,'documents'),
    'notices',(private.chapter_notice_scope_allowed(chapter,null,null) or exists (select 1 from private.steward_assignment_scopes((select auth.uid()),chapter) notice_scope where private.chapter_notice_scope_allowed(chapter,notice_scope.unit_id,notice_scope.committee_id))),
    'unscopedNotices',private.chapter_notice_scope_allowed(chapter,null,null),
    'unscopedRecords',private.chapter_officer_can(chapter,'records'),
    'unscopedDocuments',private.chapter_officer_can(chapter,'documents'),
    'scopes',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('role',s.role,'unitId',s.unit_id,'committeeId',s.committee_id,'name',coalesce(u.name,c.name),
      'records',exists(select 1 from private.chapter_role_capabilities cap where cap.role=s.role and cap.capability='records' and not exists(select 1 from private.chapter_role_settings setting where setting.chapter_id=chapter and setting.role=s.role and setting.capability='records' and not setting.enabled)),
      'notices',exists(select 1 from private.chapter_role_capabilities cap where cap.role=s.role and cap.capability='notices' and not exists(select 1 from private.chapter_role_settings setting where setting.chapter_id=chapter and setting.role=s.role and setting.capability='notices' and not setting.enabled)),
      'documents',exists(select 1 from private.chapter_role_capabilities cap where cap.role=s.role and cap.capability='documents' and not exists(select 1 from private.chapter_role_settings setting where setting.chapter_id=chapter and setting.role=s.role and setting.capability='documents' and not setting.enabled))))
      from private.chapter_role_scopes s left join private.chapter_units u on u.id=s.unit_id left join private.chapter_committees c on c.id=s.committee_id
      where s.user_id=(select auth.uid()) and s.chapter_id=chapter
        and (s.committee_id is null or (c.starts_on<=current_date and (c.ends_on is null or c.ends_on>=current_date)))),'[]'::jsonb)
      -- #7664: an organization steward's assigned unit is a notice audience
      -- only; it carries no chapter records or documents office.
      || coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('role',a.role,'unitId',a.unit_id,'committeeId',null,'name',u.name,
        'records',false,'notices',private.chapter_notice_scope_allowed(chapter,a.unit_id,null),'documents',false))
      from private.organization_steward_unit_assignments a join private.chapter_units u on u.id=a.unit_id and u.chapter_id=a.chapter_id
      where a.user_id=(select auth.uid()) and a.chapter_id=chapter
        and private.has_organization_role(a.organization_id,array['steward'])),'[]'::jsonb));
end;
$function$;

-- Preserve the reviewed lifecycle graph after these exact publisher changes.
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select surface.kind,surface.schema_name,surface.table_name,surface.object_name,surface.definition_hash
from private.account_lifecycle_trigger_surface() surface
join (values
    ('public','publish_member_broadcast'),
    ('public','publish_chapter_office_notice'),
    ('public','retract_member_broadcast'),
    ('public','list_my_member_notices'),
    ('public','get_member_notice_receipts'),
    ('public','get_broadcast_read_counts'),
    ('public','get_broadcast_read_counts_for'),
    ('public','get_chapter_office_access'),
    ('private','chapter_notice_scope_allowed')
) changed(schema_name,function_name)
  on changed.schema_name=surface.schema_name
 and changed.function_name=pg_catalog.split_part(surface.object_name,'(',1)
where surface.kind='function'
on conflict(kind,schema_name,table_name,object_name)
do update set definition_hash=excluded.definition_hash;
commit;
