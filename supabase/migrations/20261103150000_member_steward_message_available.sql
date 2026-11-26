-- BUG-UG-HOME-GUIDE-NAMES-PAUSED-STEWARD-20261103 (#6876): Home's
-- guide told a new member to ask the chapter's only steward, whose role was
-- paused (two-step sign-in unfinished), and the steward message box failed
-- only after Start conversation with "no steward assigned". The send path's
-- rule is private.chapter_steward_reader_exists(caller)
-- (20261006030000_chapter_steward_message_requires_reader.sql); the roster
-- (get_member_chapter_stewards) does not apply its second-factor rule, so the
-- app could not tell ahead of time.
--
-- public.get_member_steward_message_available() returns that same rule for the
-- caller, so the app names no steward and warns before the member writes when
-- nobody could read a Chapter steward message. It reveals nothing the send
-- path's refusal does not already say, names no one, and changes no existing
-- function. Guards match get_member_chapter_stewards: a full session (not a
-- PIN session), a satisfied second factor and a member organization.
--
-- Hosted application: SAMPLE first, then production; needs its own owner
-- authorization.

begin;
set local lock_timeout = '5s';

create function public.get_member_steward_message_available()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied()
     or private.current_member_organization() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return private.chapter_steward_reader_exists(caller);
end;

end;
$function$;

revoke all on function public.get_member_steward_message_available() from public, anon, service_role;
grant execute on function public.get_member_steward_message_available() to authenticated;

commit;
