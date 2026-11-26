-- BUG-UG-MEMBER-ECONOMICS-IMPORT-NOT-ATOMIC-20261014
--
-- The publisher's page sends a large bundle as several
-- import_member_economics_items calls, and each call commits on its own. When
-- a later call was refused, the earlier ones stayed saved (and any of their
-- published items whose content changed had already returned to draft), yet
-- the publisher saw only one failure message.
--
-- Each call now also returns what it did to every item: its kind, item key,
-- stored status, and whether this write took a published item back to draft.
-- The page adds these up across calls and, when a call fails, tells the
-- publisher exactly which items were saved, which of those were withdrawn
-- from readers, and which were not saved. Only the function's result changes;
-- every check, the write itself and the audit event are as in
-- 20261015013000_member_economics_bridge.sql.

begin;

set local lock_timeout = '5s';

create or replace function public.import_member_economics_items(p_bundle jsonb, p_expected_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  item jsonb;
  missing text;
  imported integer;
  previous text;
  saved text;
  outcomes jsonb;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  perform private.member_pin_require_full_session();
  -- Each call names the organization the page rendered, so a batch sent after
  -- the session switched account or organization is refused, not re-scoped.
  org := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p_bundle) is distinct from 'object'
     or p_bundle ->> 'format' is distinct from 'union-ground.member-economics/1'
     or pg_catalog.jsonb_typeof(p_bundle -> 'items') is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_bundle -> 'items') not between 1 and 200 then
    raise exception 'invalid member economics bundle' using errcode = '22023';
  end if;
  imported := 0;
  outcomes := '[]'::jsonb;
  for item in select e.value from pg_catalog.jsonb_array_elements(p_bundle -> 'items') e loop
    if pg_catalog.jsonb_typeof(item -> 'provenance') is distinct from 'object'
       or pg_catalog.jsonb_typeof(item -> 'payload') is distinct from 'object'
       or pg_catalog.jsonb_typeof(item -> 'source_records') is distinct from 'array'
       or pg_catalog.jsonb_typeof(coalesce(item -> 'provenance' -> 'derived_from', '[]'::jsonb)) is distinct from 'array' then
      raise exception 'invalid member economics item' using errcode = '22023';
    end if;
    if not private.member_economics_record_complete(item -> 'provenance')
       or exists (
         select 1 from pg_catalog.jsonb_array_elements(item -> 'source_records') s(record)
          where not private.member_economics_record_complete(s.record)
       ) then
      raise exception 'member economics item carries an incomplete provenance record' using errcode = '22023';
    end if;
    if not private.member_economics_payload_valid(item ->> 'kind', item -> 'payload') then
      raise exception 'member economics item payload is not renderable or shows a cell under five people' using errcode = '22023';
    end if;
    -- Fail closed: every prov- id the item, its payload or any carried record
    -- cites must travel with it, so the whole chain resolves, not one level.
    select r.reference into missing
      from (
        select d.reference
          from pg_catalog.jsonb_array_elements_text(coalesce(item -> 'provenance' -> 'derived_from', '[]'::jsonb)) d(reference)
        union all
        select d.reference
          from pg_catalog.jsonb_array_elements(item -> 'source_records') s(record)
          cross join lateral pg_catalog.jsonb_array_elements_text(coalesce(s.record -> 'derived_from', '[]'::jsonb)) d(reference)
        union all
        select v #>> '{}'
          from pg_catalog.jsonb_path_query(item -> 'payload', 'lax $.**.provenance_id') v
        union all
        select v #>> '{}'
          from pg_catalog.jsonb_path_query(item -> 'payload', 'lax $.**.derived_from[*]') v
      ) r(reference)
     where r.reference like 'prov-%'
       and r.reference is distinct from item -> 'provenance' ->> 'provenance_id'
       and not exists (
         select 1 from pg_catalog.jsonb_array_elements(item -> 'source_records') s(record)
          where s.record ->> 'provenance_id' = r.reference
       )
     limit 1;
    if missing is not null then
      raise exception 'member economics item cites an input without its source record' using errcode = '22023';
    end if;
    -- The stored status before this write, so the caller learns which
    -- published items this import withdrew.
    select i.status into previous
      from private.content_member_economics_items i
     where i.organization_id = org and i.kind = item ->> 'kind' and i.item_key = item ->> 'item_key'
     for update;
    insert into private.content_member_economics_items as t (
      organization_id, kind, item_key, chapter_code, audience, as_of, payload, source_records, provenance
    ) values (
      org, item ->> 'kind', item ->> 'item_key', nullif(item ->> 'chapter_code', ''), item ->> 'audience',
      (item ->> 'as_of')::date, item -> 'payload', item -> 'source_records', item -> 'provenance'
    )
    on conflict (organization_id, kind, item_key) do update
      set chapter_code = excluded.chapter_code,
          audience = excluded.audience,
          as_of = excluded.as_of,
          payload = excluded.payload,
          source_records = excluded.source_records,
          provenance = excluded.provenance,
          imported_at = pg_catalog.now(),
          -- Only a byte-identical re-import keeps its status; any change to
          -- what members would see, or to its sources, returns it to draft.
          status = case
            when (t.chapter_code, t.audience, t.as_of, t.payload, t.source_records, t.provenance)
                 is not distinct from
                 (excluded.chapter_code, excluded.audience, excluded.as_of, excluded.payload, excluded.source_records, excluded.provenance)
              then t.status
            else 'draft'
          end,
          status_changed_at = case
            when (t.chapter_code, t.audience, t.as_of, t.payload, t.source_records, t.provenance)
                 is not distinct from
                 (excluded.chapter_code, excluded.audience, excluded.as_of, excluded.payload, excluded.source_records, excluded.provenance)
              then t.status_changed_at
            else pg_catalog.now()
          end
    returning t.status into saved;
    imported := imported + 1;
    outcomes := outcomes || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'kind', item ->> 'kind', 'itemKey', item ->> 'item_key', 'status', saved,
      'returnedToDraft', previous is not distinct from 'published' and saved = 'draft'
    ));
  end loop;
  perform private.mi1_w2_write_audit(org, 'member_economics_items_imported', pg_catalog.jsonb_build_object(
    'organizationId', org, 'entityType', 'member_economics_bundle', 'action', 'import', 'status', 'draft'
  ));
  return pg_catalog.jsonb_build_object('ok', true, 'organizationId', org, 'imported', imported, 'items', outcomes);
end;
$function$;

revoke all on function public.import_member_economics_items(jsonb, uuid) from public, anon, authenticated, service_role;
grant execute on function public.import_member_economics_items(jsonb, uuid) to authenticated;

commit;
