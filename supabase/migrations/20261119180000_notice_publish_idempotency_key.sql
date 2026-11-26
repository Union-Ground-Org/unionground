-- BUG-UG-CHAPTER-NOTICE-PUBLISH-NOT-EXACTLY-ONCE-20261119 (#9220)
-- A notice sent again after a lost reply reached members twice: both
-- publishers minted a fresh id on every call, and their per-sender lock and
-- daily limit serialize calls without deduplicating them. Each publisher now
-- takes the client's operation key (the shared helper from #8624) and answers
-- a repeat of that key with the notice it already published, through the
-- existing actor-bound receipt store (private.member_operations_replay and
-- private.member_operations_store_receipt). The same key for a different
-- notice is refused. The key is a trailing default, so a phone build that
-- sends none still publishes as before. The old signatures are dropped, not
-- overloaded, so PostgREST keeps one RPC per name.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
set local search_path=pg_catalog,public,extensions;
do $predecessors$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.publish_member_broadcast(text, text, text, text)'))) is distinct from '161a4cadb20a73994b8076a6915bccc0' then
    raise exception 'unreviewed predecessor: public.publish_member_broadcast' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.publish_chapter_office_notice(text, text, text, text, uuid, uuid)'))) is distinct from 'c86ec936469cae9cdda7d0bac3bf11f3' then
    raise exception 'unreviewed predecessor: public.publish_chapter_office_notice' using errcode='55000';
  end if;
end;
$predecessors$;

drop function public.publish_member_broadcast(text, text, text, text);
drop function public.publish_chapter_office_notice(text, text, text, text, uuid, uuid);

-- public.publish_member_broadcast (#9220: client operation key)
CREATE OR REPLACE FUNCTION public.publish_member_broadcast(p_title text, p_body text, p_locale text DEFAULT 'en'::text, p_audience_scope text DEFAULT 'chapter'::text, p_idempotency_key uuid DEFAULT NULL::uuid)
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
  request_payload jsonb;
  replayed jsonb;
  published jsonb;
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

  -- #9220: one notice per client operation key. A retry after a lost reply
  -- carries its first try's key and gets that notice back instead of a second
  -- one; the lock above holds a retry behind a first try still in flight, so
  -- the receipt that try commits is read here. A repeat is not a new notice,
  -- so it is answered before the daily limit. No key keeps the old behaviour.
  if p_idempotency_key is not null then
    request_payload := pg_catalog.jsonb_build_object('title', clean_title, 'body', clean_body,
      'locale', clean_locale, 'scope', clean_scope, 'chapter', publisher_chapter,
      'unit', null, 'committee', null);
    replayed := private.member_operations_replay(publisher_org, 'publish_notice', p_idempotency_key, request_payload);
    if replayed is not null then
      return replayed;
    end if;
  end if;

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

  published := pg_catalog.jsonb_build_object('broadcastId', new_id);
  if p_idempotency_key is not null then
    perform private.member_operations_store_receipt(publisher_org, 'publish_notice', p_idempotency_key, request_payload, published);
  end if;
  return published;
end;
end;
$function$;
revoke all on function public.publish_member_broadcast(text, text, text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.publish_member_broadcast(text, text, text, text, uuid) to authenticated, service_role;

-- public.publish_chapter_office_notice (#9220: client operation key)
CREATE OR REPLACE FUNCTION public.publish_chapter_office_notice(p_chapter text, p_title text, p_body text, p_locale text DEFAULT 'en'::text, p_unit uuid DEFAULT NULL::uuid, p_committee uuid DEFAULT NULL::uuid, p_idempotency_key uuid DEFAULT NULL::uuid)
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
  request_payload jsonb;
  replayed jsonb;
  published jsonb;
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

  -- #9220: one notice per client operation key. A retry after a lost reply
  -- carries its first try's key and gets that notice back instead of a second
  -- one; the lock above holds a retry behind a first try still in flight, so
  -- the receipt that try commits is read here. A repeat is not a new notice,
  -- so it is answered before the daily limit. No key keeps the old behaviour.
  if p_idempotency_key is not null then
    request_payload := pg_catalog.jsonb_build_object('title', clean_title, 'body', clean_body,
      'locale', clean_locale, 'scope', clean_scope, 'chapter', publisher_chapter,
      'unit', p_unit, 'committee', p_committee);
    replayed := private.member_operations_replay(publisher_org, 'publish_notice', p_idempotency_key, request_payload);
    if replayed is not null then
      return replayed;
    end if;
  end if;

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

  published := pg_catalog.jsonb_build_object('broadcastId', new_id);
  if p_idempotency_key is not null then
    perform private.member_operations_store_receipt(publisher_org, 'publish_notice', p_idempotency_key, request_payload, published);
  end if;
  return published;
end;
end;
$function$;
revoke all on function public.publish_chapter_office_notice(text, text, text, text, uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.publish_chapter_office_notice(text, text, text, text, uuid, uuid, uuid) to authenticated;

-- Preserve the reviewed lifecycle graph after these exact publisher changes.
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select surface.kind,surface.schema_name,surface.table_name,surface.object_name,surface.definition_hash
from private.account_lifecycle_trigger_surface() surface
join (values
    ('public','publish_member_broadcast'),
    ('public','publish_chapter_office_notice')
) changed(schema_name,function_name)
  on changed.schema_name=surface.schema_name
 and changed.function_name=pg_catalog.split_part(surface.object_name,'(',1)
where surface.kind='function'
on conflict(kind,schema_name,table_name,object_name)
do update set definition_hash=excluded.definition_hash;
commit;
