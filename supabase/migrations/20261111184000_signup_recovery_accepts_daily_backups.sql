-- REQ-UG-SIGNUP-RECOVERY-GATE-ACCEPTS-DAILY-BACKUPS-20261111 (#8273)
-- Project decision, November 10, 2026 (#4856): production point-in-time recovery
-- stays off and daily backups are the recovery path. Owner direction,
-- November 11, 2026: the signup recovery gate accepts them. A readiness check
-- now records its recovery method. A daily-backup check passes while its
-- newest completed backup is at most 26 hours old; a point-in-time check keeps
-- the 24-hour rule. Every other condition is unchanged.
-- Applying this migration supplies no evidence and never opens signup.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Every check written before this migration attested point-in-time recovery.
alter table private.open_signup_recovery_checks
  add column recovery_method text not null default 'pitr'
    constraint open_signup_recovery_checks_recovery_method_check
    check (recovery_method in ('pitr', 'daily-backup'));

comment on column private.open_signup_recovery_checks.recovery_method is
  'pitr: point-in-time recovery was enabled and its newest recovery point was current. daily-backup: point-in-time recovery was off and the newest completed daily backup was current.';

create or replace function private.open_signup_recovery_ready()
returns boolean language sql stable security definer set search_path = ''
as $function$
  select coalesce((
    select ((r.recovery_method = 'pitr' and r.pitr_enabled
          and r.latest_recovery_at >= pg_catalog.now() - interval '24 hours')
        or (r.recovery_method = 'daily-backup' and not r.pitr_enabled
          and r.latest_recovery_at >= pg_catalog.now() - interval '26 hours'))
      and r.system_identifier = (select system_identifier::text from pg_catalog.pg_control_system())
      and r.verified_at <= pg_catalog.now()
      and r.expires_at > pg_catalog.now()
      and r.restore_verified_at >= pg_catalog.now() - interval '30 days'
      and r.storage_verified_at >= pg_catalog.now() - interval '30 days'
      and r.storage_backup_verified_at >= pg_catalog.now() - interval '24 hours'
      and private.open_signup_launch_evidence_ready(r.launch_requirements, pg_catalog.now())
    from private.open_signup_recovery_checks r
    order by r.id desc limit 1
  ), false);
$function$;
revoke all on function private.open_signup_recovery_ready() from public, anon, authenticated, service_role;

-- Reviewed trigger surface (account lifecycle inventory): the changed predicate.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'function' and schema_name = 'private' and object_name = 'open_signup_recovery_ready()'
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_recovery_gate_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the daily-backup recovery gate: %',
      (select pg_catalog.string_agg(i.schema_name || '.' || i.table_name || '.' || i.trigger_name, ', ')
       from private.account_lifecycle_referential_action_trigger_issues() i);
  end if;
end;
$assert_recovery_gate_lifecycle$;
commit;
