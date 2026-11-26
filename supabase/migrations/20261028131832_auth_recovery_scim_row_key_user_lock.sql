-- BUG-UG-AUTH-RECOVERY-SCIM-ROW-KEY-LOCK-ARGUMENTS-20261027 (#6155).
-- 20261027011927 passed '{user_id}' to private.lock_case_graph_row_keys for
-- the recovery-code sets and SCIM users. The helper reads each comma-separated
-- argument as a column name, so it looked up the field "{user_id}", got NULL
-- and took no user advisory lock. That migration is applied, so this forward
-- repair replaces only the two row-key gates with the plain column name.
-- CREATE OR REPLACE needs only the TRIGGER privilege the adoption used; DROP
-- would need ownership of the GoTrue-owned tables (42501).
-- The a00 statement gates, the trigger names and the lock order are unchanged.
begin;

create or replace trigger z99_case_graph_keys before insert or update or delete on auth.mfa_recovery_code_sets
for each row execute function private.lock_case_graph_row_keys('user_id', '');

create or replace trigger z99_case_graph_keys before insert or update or delete on auth.scim_users
for each row execute function private.lock_case_graph_row_keys('user_id', '');

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'auth'
  and table_name in ('mfa_recovery_code_sets', 'scim_users') and object_name = 'z99_case_graph_keys'
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;

do $assert_row_key_repair$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'Auth recovery and SCIM row-key trigger review is incomplete';
  end if;
end;
$assert_row_key_repair$;

commit;
