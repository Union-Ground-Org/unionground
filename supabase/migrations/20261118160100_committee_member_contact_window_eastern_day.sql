-- BUG-UG-COMMITTEE-MEMBER-CONTACT-CHECK-USES-THE-UTC-DAY-20261118 (#9130)
--
-- private.chapter_member_contact_container_allowed (20261113147000, #8962)
-- decides whether a contact-capable staff assignment limited to one unit or
-- one committee reaches that container's member-contact records. Its
-- committee arm still compared the committee's starts_on and ends_on with
-- current_date, the session's day; the hosted projects run in UTC. #8962
-- merged after #8568 part A (20261113143000) had moved every other committee
-- window reader to the Eastern day, and its comment deferred to #8568, which
-- is closed. So on a committee's last day, from 7 PM Eastern (8 PM in
-- daylight time), this helper failed while private.chapter_record_manageable
-- (Eastern day) still passed: a coordinator, advisor, admin or VP whose only
-- scope is that committee lost its member-contact records from the records
-- workspace and the chapter_records_select policy, and a save was refused
-- with "contact access required". Nothing was exposed early: every caller
-- also requires an Eastern-day check.
--
-- The helper is restated from its live definition with only those two
-- comparisons changed, to (select private.eastern_day()) like the eighteen
-- readers 20261113143000 moved, and their utc-day comments removed. Language,
-- volatility, security mode, search_path, signature and grants (kept by
-- CREATE OR REPLACE) do not change. A predecessor guard refuses to run unless
-- the live definition and its lifecycle receipt are the reviewed ones.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

do $predecessor$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.chapter_member_contact_container_allowed(text, uuid, uuid)'))) is distinct from '554c07f286a91bd8b7724f83a6c5abd9' then
    raise exception 'unreviewed predecessor: private.chapter_member_contact_container_allowed' using errcode = '55000';
  end if;
  if exists (select 1 from private.account_lifecycle_trigger_review where kind = 'function' and schema_name = 'private'
      and pg_catalog.split_part(object_name, '(', 1) = 'chapter_member_contact_container_allowed' and definition_hash <> '554c07f286a91bd8b7724f83a6c5abd9') then
    raise exception 'stale trigger receipt: private.chapter_member_contact_container_allowed' using errcode = '55000';
  end if;
end;
$predecessor$;

CREATE OR REPLACE FUNCTION private.chapter_member_contact_container_allowed(p_chapter text, p_unit uuid, p_committee uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (p_unit is not null or p_committee is not null)
    and private.can_read_chapter_contact_record(p_chapter)
    and exists (
      select 1 from private.chapter_role_capabilities capability
      left join private.chapter_role_settings setting on setting.chapter_id=p_chapter
        and setting.role=capability.role and setting.capability=capability.capability
      where capability.capability='records'
        and capability.role=any(array['steward','coordinator','advisor','admin','vp'])
        and coalesce(setting.enabled,true)
        and private.member_has_chapter_staff_grant(p_chapter,array[capability.role])
        and exists (
          select 1 from private.steward_assignment_scopes((select auth.uid()),p_chapter) scope
          where scope.user_id=(select auth.uid()) and scope.chapter_id=p_chapter
            and scope.role=capability.role and not scope.legacy_chapter_coverage
            and (
              (p_unit is not null and p_committee is null and scope.unit_id=p_unit
                and private.unit_capability_enabled(p_chapter,p_unit,capability.role,'records'))
              or (p_unit is null and p_committee is not null and scope.committee_id=p_committee
                and exists (select 1 from private.chapter_committees committee
                  where committee.id=p_committee and committee.chapter_id=p_chapter
                    and (committee.starts_on is null or committee.starts_on<=(select private.eastern_day()))
                    and (committee.ends_on is null or committee.ends_on>=(select private.eastern_day()))))
            )
        )
    );
$function$;

-- Reviewed call-graph change (account lifecycle inventory): the restated
-- helper keeps its receipt, refreshed to the new definition.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'function' and schema_name = 'private'
  and pg_catalog.split_part(object_name, '(', 1) = 'chapter_member_contact_container_allowed'
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

notify pgrst, 'reload schema';

commit;
