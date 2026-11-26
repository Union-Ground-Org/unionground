-- BUG-UG-LEGACY-CHAPTER-HANDSHAKE-20261023 (#5940)
-- Preserve eligible legacy chapter handshakes.
--
-- 20261023050348_bot_organization_directory_visibility.sql added a receiving
-- chapter predicate to public.request_chapter_handshake:
--   c.organization_id = caller_organization
--   or private.organization_visible_in_directory(c.organization_id)
-- Both arms are false or null for a legacy chapter whose organization_id is
-- null, so a verified binding to a real registry row stopped resolving and
-- the caller got the not-onboarded answer the predecessor never gave.
--
-- A legacy receiving chapter is admitted again when it is not on the bot
-- ledger as a chapter. The registry row's own fictional flag is still
-- refused by private.catalog_registry_identity_visible, organization-backed
-- targets keep the fictional-organization exclusion, and the staff role,
-- signup boundary and idempotency checks are unchanged. No rows change.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Refuse a stale re-emission if another migration changed the reader first.
do $predecessor$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure('public.request_chapter_handshake(text,text,text,text,uuid)'))
     is distinct from '89e72acff6f66ecd8374e5ad16be519f' then
    raise exception 'legacy chapter handshake predecessor changed: public.request_chapter_handshake';
  end if;
end;
$predecessor$;

-- Previous definition: 20261023050348_bot_organization_directory_visibility.sql
create or replace function public.request_chapter_handshake(p_partner_org_id text, p_title text, p_purpose text, p_data_scope text, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  receiving text;
  created public.chapter_handshakes%rowtype;
  prior_event public.chapter_handshake_events%rowtype;
  caller_organization uuid;
begin
  if caller is null or chapter is null
     or not private.member_has_chapter_role(chapter, array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_idempotency_key is null or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title,''))) not between 1 and 160
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_purpose,''))) not between 1 and 4000
     or p_data_scope not in ('docs_only','no_member_data','aggregate_only') then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  -- An unverified self-created organization cannot hand-shake, so it gets
  -- the not-onboarded answer before any registry binding is read: the answer
  -- never depends on whether the partner has a verified binding. A legacy
  -- chapter with no organization keeps its previous behaviour.
  caller_organization := private.current_member_organization();
  if caller_organization is not null
     and not private.organization_clears_signup_boundary(caller_organization) then
    raise exception 'partner is not onboarded for two-sided requests' using errcode = '22023';
  end if;
  select b.chapter_id into receiving
  from public.chapter_union_org_bindings b
  where b.union_org_id = p_partner_org_id and b.status = 'verified'
    and private.catalog_registry_identity_visible(p_partner_org_id)
    and exists (select 1 from public.chapters c where c.id = b.chapter_id
      and (c.organization_id = caller_organization
        or private.organization_visible_in_directory(c.organization_id)
        or (c.organization_id is null and not exists (select 1 from private.bot_production_marks m
          where m.kind = 'chapter' and m.record_id = c.id))));
  if receiving is null or receiving = chapter then
    raise exception 'partner is not onboarded for two-sided requests' using errcode = '22023';
  end if;
  select * into prior_event from public.chapter_handshake_events e
  where e.idempotency_key = p_idempotency_key;
  if found then
    select h.* into created from public.chapter_handshakes h
    where h.id = prior_event.handshake_id;
    if prior_event.transition <> 'requested' or prior_event.actor <> caller
       or created.chapter_id <> chapter or created.receiving_chapter_id <> receiving
       or created.partner_org_id <> p_partner_org_id
       or created.title <> pg_catalog.btrim(p_title)
       or created.purpose <> pg_catalog.btrim(p_purpose)
       or created.data_scope <> p_data_scope then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return pg_catalog.to_jsonb(created);
  end if;
  insert into public.chapter_handshakes
    (chapter_id, receiving_chapter_id, partner_org_id, title, purpose, data_scope,
     status, requested_by, requested_at)
  values (chapter, receiving, p_partner_org_id, pg_catalog.btrim(p_title),
    pg_catalog.btrim(p_purpose), p_data_scope, 'requested', caller, pg_catalog.clock_timestamp())
  returning * into created;
  insert into public.chapter_handshake_events
    (handshake_id, idempotency_key, actor, actor_chapter_id, transition, from_status, to_status)
  values (created.id, p_idempotency_key, caller, chapter, 'requested', 'draft', 'requested');
  perform private.notify_handshake_staff(receiving, 'Partnership request received',
    'An authorized chapter sent a two-sided partnership request for review.');
  return pg_catalog.to_jsonb(created);
end;
end;
$function$;

insert into private.account_lifecycle_trigger_review
  (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where s.kind = 'function' and s.schema_name = 'public' and s.table_name = ''
  and pg_catalog.split_part(s.object_name, '(', 1) = 'request_chapter_handshake'
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $inventory$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review incomplete after legacy chapter handshake repair: %',
      (select pg_catalog.jsonb_agg(i) from private.account_lifecycle_referential_action_trigger_issues() i);
  end if;
end;
$inventory$;

notify pgrst, 'reload schema';
commit;
