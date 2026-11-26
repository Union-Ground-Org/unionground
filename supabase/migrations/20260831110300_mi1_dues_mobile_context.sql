-- The Expo app receives an already-validated Dues context. It never writes a
-- financial identity and it never infers one from a deep link, role list, or
-- preview selection in an authenticated session.

create or replace function public.get_mobile_dues_context()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.current_member_organization();
  selected text;
begin
  if org is null or (select auth.uid()) is null then
    raise exception 'dues authorization required' using errcode = '42501';
  end if;
  select selection.selected_hat into selected
  from private.dues_financial_identity_selections selection
  where selection.organization_id = org and selection.user_id = (select auth.uid());
  if selected is not null and not private.has_organization_role(org, array[selected]) then
    delete from private.dues_financial_identity_selections
      where organization_id = org and user_id = (select auth.uid());
    selected := null;
  end if;
  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'chapterId', private.current_member_chapter(),
    'activeFinancialHat', selected
  );
end;
$function$;

revoke all on function public.get_mobile_dues_context() from public, anon;
grant execute on function public.get_mobile_dues_context() to authenticated;
