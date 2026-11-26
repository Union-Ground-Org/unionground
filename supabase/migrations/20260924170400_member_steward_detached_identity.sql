-- Detached selected-steward conversations stop naming the departed steward.
--
-- 20260924170200 binds a member's thread to a chosen steward and titles it with
-- that steward's name and initials. The binding is ON DELETE SET NULL, so when
-- the steward's account is deleted the thread survives as a general
-- (steward_user_id is null) thread but kept the departed steward's identity.
-- This trigger rewrites only that transition, bound -> null, to the general
-- "Chapter steward" identity that start_member_conversation writes. Threads
-- that were never bound, and every other column, are untouched. The function
-- only assigns NEW: it takes no lock and reads no row, so the case-graph lock
-- order of the FK action (a00 statement lock, z99 row keys) is unchanged.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function private.member_conversations_detach_steward_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  new.title := 'Chapter steward';
  new.initials := 'CS';
  return new;
end;
$function$;

revoke all on function private.member_conversations_detach_steward_identity()
  from public, anon, authenticated, service_role;

comment on function private.member_conversations_detach_steward_identity() is
  'Gives a member conversation whose selected steward detached (bound -> null, including the ON DELETE SET NULL action) the general Chapter steward title and initials.';

create trigger member_conversations_detach_steward_identity
before update of steward_user_id on public.member_conversations
for each row
when (old.steward_user_id is not null and new.steward_user_id is null)
execute function private.member_conversations_detach_steward_identity();

insert into private.account_lifecycle_trigger_review
  (kind, schema_name, table_name, object_name, definition_hash)
values
  ('function', 'private', '', 'member_conversations_detach_steward_identity()', '617a81ae27c007c9d0c356700f8427f5'),
  ('trigger', 'public', 'member_conversations', 'member_conversations_detach_steward_identity', 'e2b05455eecdf0fd8458257ac3c09c91')
on conflict (kind, schema_name, table_name, object_name) do update
set definition_hash = excluded.definition_hash;

do $assert_account_lifecycle_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the detached steward identity trigger';
  end if;
end;
$assert_account_lifecycle_trigger_review$;

commit;
