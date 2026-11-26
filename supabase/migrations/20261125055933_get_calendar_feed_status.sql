begin;

-- The subscription URL remains mint-only. This read uses the member's
-- existing column grant and own-row RLS on the token table.
create function public.get_calendar_feed_status()
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() or private.member_pin_session_restricted() then
    raise exception 'full member session required' using errcode = '42501';
  end if;
  return exists (
    select 1 from public.member_calendar_feed_tokens
    where user_id = caller
  );
end;
$function$;

revoke all on function public.get_calendar_feed_status() from public, anon, authenticated, service_role;
grant execute on function public.get_calendar_feed_status() to authenticated;

commit;
