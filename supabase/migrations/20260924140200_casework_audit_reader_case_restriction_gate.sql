-- SEC-UG-CASEWORK-AUDIT-READER-CASE-RESTRICTION-NOT-ENFORCED-20260920
--
-- public.casework_audit_events is readable two ways. The table policy
-- casework_audit_events_staff_read (20260917103000) splits the organization-role
-- branch so a plain coordinator additionally needs the parent case row to be
-- visible under the public.member_cases SELECT policies. The SECURITY DEFINER
-- reader public.list_casework_audit_events still evaluated the pre-split
-- coordinator/advisor/admin/vp disjunction, and no table policy runs inside it.
--
-- The gate cannot be delegated the way the table policy delegates it. The
-- policy's bare `exists (select 1 from public.member_cases c where c.id = ...)`
-- is evaluated as the caller, so member_cases RLS decides it; inside this
-- reader the same EXISTS runs as the function owner, which is exempt from row
-- level security, and would be true for every case row that exists.
-- 20260917103000:87-91 records that exact reasoning for the definer Storage
-- predicate, and 20260917104000 / 20260917105000 settled the shape a definer
-- caller uses instead: the caller-aware scope predicate
-- public.staff_can_see_user(<case owner>, 'coordinator') -- which itself
-- embeds private.mfa_satisfied() -- ANDed with the definer restriction helper
-- private.member_case_visible_to_caller(<case id>), whose body is the union of
-- the three member_cases SELECT policies' restriction branches.
--
-- Re-emit the reader with that split: advisor/admin/vp unconditional,
-- coordinator gated by `a.case_id is null or (<caller-aware chapter scope> and
-- private.member_case_visible_to_caller(a.case_id))`, then the unchanged
-- private.casework_staff_can_access branch. Signature, empty search_path,
-- p_kind validation, organization bound, paging clamp, projected columns,
-- revoke/grant pair and read-only body stay the same. Null case_id rows keep
-- their current organization-role behaviour. No helper is created, replaced or
-- dropped here, and no policy is touched.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

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
          private.has_organization_role(a.organization_id, array['advisor', 'admin', 'vp'])
          or (
            private.has_organization_role(a.organization_id, array['coordinator'])
            and (
              a.case_id is null
              or (
                exists (
                  select 1
                  from public.member_cases c
                  where c.id = a.case_id
                    and public.staff_can_see_user(c.user_id, 'coordinator')
                )
                and private.member_case_visible_to_caller(a.case_id)
              )
            )
          )
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
  'Paged organization-scoped read of the casework audit event sink; p_kind is the table CHECK vocabulary, a coordinator additionally needs the parent case in chapter scope and clear of the casework restriction gate (stated here rather than delegated, because this reader is SECURITY DEFINER and exempt from member_cases RLS), and the bounded metadata payload is never returned.';

notify pgrst, 'reload schema';

commit;
