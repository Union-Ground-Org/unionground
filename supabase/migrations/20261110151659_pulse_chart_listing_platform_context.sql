-- #8057: the internal platform workspace has no union charts. Its authorized
-- members should receive an empty list on Home, not an apparent sign-in error.
-- Keep the union-only chart context for figures, creation, sharing and export.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.list_pulse_charts(text)'::regprocedure))
     <> '3a4ff5c122e7efb63cf2a5e7b25dc04a' then
    raise exception 'unreviewed predecessor: public.list_pulse_charts(text)' using errcode = '55000';
  end if;
end;
$preflight$;

create or replace function public.list_pulse_charts(p_hat text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare org uuid; staff jsonb; chart record; result jsonb := '[]'::jsonb;
begin
  perform private.lock_case_graph_read();
  if not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  -- The staff resolver safely supports a chapterless platform membership;
  -- ambiguous or inactive organization selections still fail the usual gate.
  org := private.current_mobile_staff_organization();
  if private.organization_is_platform(org) then
    perform private.member_pin_require_full_session();
    if not private.is_organization_member(org) then
      raise exception 'chart unavailable' using errcode = '42501';
    end if;
    if p_hat = 'member' then return result; end if;
    staff := public.get_my_mobile_staff_scope();
    if p_hat is null or p_hat not in ('steward','coordinator','advisor','vp','president','secretary','admin','treasurer')
      or coalesce((staff->>'staffAuthorized')::boolean, false) is not true
      or staff->>'organizationId' is distinct from org::text
      or not (coalesce(staff->'roles','[]'::jsonb) ? p_hat or coalesce(staff->'chapterRoles','[]'::jsonb) ? p_hat) then
      raise exception 'chart unavailable' using errcode = '42501';
    end if;
    return result;
  end if;
  org := private.pulse_chart_context(p_hat);
  for chart in select c.id from private.pulse_saved_charts c where c.owner_id = auth.uid()
    and c.organization_id = org and c.chapter_id = private.current_member_chapter() and c.deleted_at is null
    order by c.pinned desc,c.created_at,c.id limit 30 loop
    begin result := result || pg_catalog.jsonb_build_array(public.read_pulse_chart(chart.id,p_hat));
    exception when insufficient_privilege or invalid_parameter_value then
      -- An old staff spec is unavailable after a role revocation, but remains
      -- removable by its owner; no previously fetched figures are returned.
      result := result || (select pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',c.id,'title',c.title,'spec',c.spec,'scope',c.scope,'pinned',c.pinned,'home',c.home,'owned',true,'unavailable',true)) from private.pulse_saved_charts c where c.id = chart.id);
    end;
  end loop;
  return result;
end;
$function$;

revoke all on function public.list_pulse_charts(text) from public, anon, authenticated, service_role;
grant execute on function public.list_pulse_charts(text) to authenticated;
commit;
