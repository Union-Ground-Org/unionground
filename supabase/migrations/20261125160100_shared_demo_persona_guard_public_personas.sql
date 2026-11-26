-- The shared demo persona guard names this edition's demo personas.
--
-- private.is_shared_demo_persona_email (20261107120000) still listed the six
-- upstream entry personas, while this edition's demo entry (api/demo-session.js)
-- signs visitors in as the seven fictional personas in config/sample-backend.json
-- samplePersonas, one per hat. So none of those seven accounts had its email,
-- password, phone, factors or passkeys guarded, and the guard named addresses
-- this edition never seeds. The function is re-created with exactly the seven
-- addresses, in samplePersonas order; it stays immutable, owner-only, and its
-- callers (the account guard triggers of 20261107120000 and the session guard
-- of 20261107163700) are unchanged.
begin;
set local search_path = pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function private.is_shared_demo_persona_email(p_email text)
returns boolean language sql immutable set search_path = ''
as $function$
  select pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, ''))) = any (array[
    'darnell.foster@example.invalid',
    'elena.cruz@example.invalid',
    'maya.thompson@example.invalid',
    'andre.lewis@example.invalid',
    'priya.shah@example.invalid',
    'rosa.martinez@example.invalid',
    'jordan.kim@example.invalid'
  ]::text[]);
$function$;
revoke all on function private.is_shared_demo_persona_email(text) from public, anon, authenticated, service_role;
comment on function private.is_shared_demo_persona_email(text) is
  'Whether an address is one of the seven shared demo entry personas (config/sample-backend.json samplePersonas).';

-- The account lifecycle trigger surface reviews this function's definition;
-- record the new one and require a clean review.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where s.kind = 'function' and s.schema_name = 'private' and s.table_name = ''
  and s.object_name = 'is_shared_demo_persona_email(p_email text)'
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;
do $assert_shared_demo_persona_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the shared demo persona list';
  end if;
end;
$assert_shared_demo_persona_review$;

commit;
