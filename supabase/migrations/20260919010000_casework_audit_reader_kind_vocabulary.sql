-- BUG-UG-CASEWORK-AUDIT-READER-KIND-VOCABULARY-DRIFT-20260918
--
-- public.casework_audit_events.event_type CHECK grew five members in
-- 20260917144000 (macro_saved, macro_applied, note_added, note_mentioned,
-- case_assigned). public.list_casework_audit_events still hardcoded the
-- original 23 kinds from 20260828210000 and raised 22023 for the new ones, so
-- the operations audit log could not filter them.
--
-- Re-emit the reader so p_kind is validated against
-- casework_audit_events_event_type_check via private.casework_audit_event_kinds(),
-- which reads pg_get_constraintdef. Grants, SECURITY DEFINER, empty
-- search_path, bound helper, and both authorization branches stay the same.
-- This migration does not add cases_exported; a sibling delivery owns that
-- member and the fold unions the readers.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function private.casework_audit_event_kinds()
returns text[]
language plpgsql
stable
set search_path = ''
as $function$
declare
  def text;
  kinds text[];
begin
  select pg_catalog.pg_get_constraintdef(c.oid)
    into def
  from pg_catalog.pg_constraint c
  join pg_catalog.pg_class rel on rel.oid = c.conrelid
  join pg_catalog.pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'casework_audit_events'
    and c.conname = 'casework_audit_events_event_type_check'
    and c.contype = 'c';

  if def is null then
    return array[]::text[];
  end if;

  select coalesce(pg_catalog.array_agg(m[1] order by m[1]), array[]::text[])
    into kinds
  from pg_catalog.regexp_matches(def, $re$'([a-z][a-z0-9_]*)'$re$, 'g') as m;

  return kinds;
end;
$function$;

revoke all on function private.casework_audit_event_kinds()
  from public, anon, authenticated, service_role;

comment on function private.casework_audit_event_kinds() is
  'Closed casework audit event_type vocabulary taken from casework_audit_events_event_type_check via pg_get_constraintdef; only definer readers may call it.';

create or replace function public.list_casework_audit_events(
  p_limit integer default 50,
  p_before timestamptz default null,
  p_before_id bigint default null,
  p_kind text default null,
  p_since timestamptz default null,
  p_until timestamptz default null,
  p_case_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  clamped integer;
begin
  if p_kind is not null
     and p_kind <> all (private.casework_audit_event_kinds()) then
    raise exception 'unknown casework audit event kind' using errcode = '22023';
  end if;
  clamped := private.audit_sink_read_bounds(p_limit, p_before, p_before_id is not null, p_since, p_until);

  return coalesce((
    select pg_catalog.jsonb_agg(page.item order by page.created_at desc, page.id desc)
    from (
      select
        a.created_at,
        a.id,
        pg_catalog.jsonb_build_object(
          'id', a.id,
          'source', 'casework_audit_events',
          'organizationId', a.organization_id,
          'chapterId', a.chapter_id,
          'kind', a.event_type,
          'caseId', a.case_id,
          'entityId', a.entity_id,
          'actorUserId', a.actor_user_id,
          'createdAt', a.created_at
        ) as item
      from public.casework_audit_events a
      where a.organization_id = org
        and (p_case_id is null or a.case_id = p_case_id)
        and (p_kind is null or a.event_type = p_kind)
        and (p_since is null or a.created_at >= p_since)
        and (p_until is null or a.created_at <= p_until)
        and (p_before is null or (a.created_at, a.id) < (p_before, p_before_id))
        and (
          private.has_organization_role(a.organization_id, array['coordinator', 'advisor', 'admin', 'vp'])
          or (a.case_id is not null and private.casework_staff_can_access(a.case_id))
        )
      order by a.created_at desc, a.id desc
      limit clamped
    ) page
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_casework_audit_events(integer, timestamptz, bigint, text, timestamptz, timestamptz, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_casework_audit_events(integer, timestamptz, bigint, text, timestamptz, timestamptz, uuid)
  to authenticated;

comment on function public.list_casework_audit_events(integer, timestamptz, bigint, text, timestamptz, timestamptz, uuid) is
  'Paged organization-scoped read of the casework audit event sink; p_kind is the table CHECK vocabulary, never a parallel list, and the bounded metadata payload is never returned.';

notify pgrst, 'reload schema';

commit;
