-- DEBT-UG-SUPABASE-CLI-2121-ADOPTION-20261026 (#6090).
-- GoTrue 2.197 adds recovery-code and SCIM identity relations below auth.users.
-- Coordinate their statements before target tuples, as for the existing Auth
-- graph relations. The SSO provider DELETE parent enters the graph before its
-- SCIM cascade can acquire a child tuple, then takes the Auth bookkeeping lock
-- in the same order as auth.oauth_clients.
begin;

create trigger a00_case_graph_lock before insert or update or delete on auth.mfa_recovery_code_sets
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on auth.mfa_recovery_code_sets
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');

create trigger a00_case_graph_lock before insert or update or delete on auth.mfa_recovery_codes
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on auth.mfa_recovery_codes
for each row execute function private.lock_case_graph_row_keys('', '');

create trigger a00_case_graph_lock before insert or update or delete on auth.scim_users
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on auth.scim_users
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');

create trigger a00_case_graph_lock before delete on auth.sso_providers
for each statement execute function private.lock_case_graph_statement();
create trigger a01_auth_bookkeeping_exclusive before delete on auth.sso_providers
for each statement execute function private.lock_auth_bookkeeping_exclusive();

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'auth'
  and ((table_name in ('mfa_recovery_code_sets', 'mfa_recovery_codes', 'scim_users')
        and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys'))
    or (table_name = 'sso_providers'
        and object_name in ('a00_case_graph_lock', 'a01_auth_bookkeeping_exclusive')));

do $assert_auth_adoption$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'Auth 2.197 trigger review is incomplete';
  end if;
end;
$assert_auth_adoption$;

commit;
