-- REQ-UG-STEWARDS-REQUIRE-A-UNIT-20261109 (#7663).
-- Decision 20261110-0906: keep old coverage on the assignment, never copy
-- members between units. Runtime callers cannot create a carry-over mark.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
set local search_path=pg_catalog,public,extensions;
-- Fence role grants and membership changes before the schema/backfill begins.
select private.lock_case_graph(array[]::uuid[],array[]::uuid[]);


do $predecessors$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.member_has_chapter_role(text, text[])'))) is distinct from 'd7e1ac3cfef488d30e79146e218da2fb' then raise exception 'unreviewed predecessor: private.member_has_chapter_role' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.actor_role_covers_member(uuid, text, text, uuid, boolean)'))) is distinct from '160293d93c2aae927896b6964c1dd3b2' then raise exception 'unreviewed predecessor: private.actor_role_covers_member' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.actor_case_scope_and_identity_allowed(uuid, member_cases)'))) is distinct from '46d833ed14d1abcc29aae8a843db7a3a' then raise exception 'unreviewed predecessor: private.actor_case_scope_and_identity_allowed' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.chapter_case_intake_role_allows(uuid, text)'))) is distinct from '292ab71c7f878eccb127d746ba247ec0' then raise exception 'unreviewed predecessor: private.chapter_case_intake_role_allows' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.chapter_record_manageable(text, uuid, uuid)'))) is distinct from 'dbffd2de972ed90a72c841ea34556e84' then raise exception 'unreviewed predecessor: private.chapter_record_manageable' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.draft_steward_covers_member(uuid, uuid, text)'))) is distinct from '837ee9e7b245402f41f1ac2ffd02f312' then raise exception 'unreviewed predecessor: private.draft_steward_covers_member' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.search_member_cases(text, integer)'))) is distinct from '50e777ee84fdfc33dffe0f57f28d3ed6' then raise exception 'unreviewed predecessor: private.search_member_cases' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_advisor_overview()'))) is distinct from '63ca323a2ca8bdca2aee4d6ada22c7b9' then raise exception 'unreviewed predecessor: public.get_advisor_overview' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_vp_overview()'))) is distinct from '9efd45b194357137efb0dc5a75a14625' then raise exception 'unreviewed predecessor: public.get_vp_overview' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_organization_analytics_workspace()'))) is distinct from 'c6e06a4dfc16f0245411f49e8656d2e9' then raise exception 'unreviewed predecessor: public.get_organization_analytics_workspace' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.list_contract_clause_grievance_counts()'))) is distinct from '27843868924a162fcb9d6b02de02ec14' then raise exception 'unreviewed predecessor: public.list_contract_clause_grievance_counts' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.staff_can_see_user(uuid, text)'))) is distinct from 'd1eac871faef33ce0ae1f9693989678e' then raise exception 'unreviewed predecessor: public.staff_can_see_user' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.chapter_scoped_role_allows(text, text, uuid, boolean)'))) is distinct from 'bfb08ed7e045c22cf0610f6c590ac715' then raise exception 'unreviewed predecessor: private.chapter_scoped_role_allows' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.chapter_scope_member_allowed(text, uuid, uuid, uuid)'))) is distinct from 'dc5ac8ee7b517018cfe739de67737e03' then raise exception 'unreviewed predecessor: private.chapter_scope_member_allowed' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.chapter_scope_recipient_allowed(text, uuid, uuid, uuid)'))) is distinct from '8bed7081769f33462b0eaba99f8d93d7' then raise exception 'unreviewed predecessor: private.chapter_scope_recipient_allowed' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.member_scoped_notice_in_audience(uuid, member_broadcasts)'))) is distinct from '7552a6031e1406da43e831318487ad87' then raise exception 'unreviewed predecessor: private.member_scoped_notice_in_audience' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_broadcast_read_counts()'))) is distinct from 'a70e084228e33d4d4512a85d697cb5fd' then raise exception 'unreviewed predecessor: public.get_broadcast_read_counts' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_broadcast_read_counts_for(text[])'))) is distinct from 'e1490cad50fe2ae042991d470221bd4a' then raise exception 'unreviewed predecessor: public.get_broadcast_read_counts_for' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.chapter_scoped_member_ids(text)'))) is distinct from '204ec0acae534a7a935ffa6405d5225d' then raise exception 'unreviewed predecessor: private.chapter_scoped_member_ids' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_chapter_access_workspace(text, integer, integer, integer, text)'))) is distinct from '743bfe456b4375b1b7531f76bcc2003e' then raise exception 'unreviewed predecessor: public.get_chapter_access_workspace' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.chapter_unit_rows(uuid)'))) is distinct from 'a8186a75a6f8e862b988eaca3466eec6' then raise exception 'unreviewed predecessor: private.chapter_unit_rows' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.account_lifecycle_export_additional_domains(uuid)'))) is distinct from '241da2337992ad06a655df710a7cf3ea' then raise exception 'unreviewed predecessor: private.account_lifecycle_export_additional_domains' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.set_member_chapter_role(uuid, text, text, boolean)'))) is distinct from '55fa29f934f90051c244c4f53895f4d1' then raise exception 'unreviewed predecessor: public.set_member_chapter_role' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.set_member_organization_role(uuid, text, boolean)'))) is distinct from '0689840560015c0355260e7351ad8bd5' then raise exception 'unreviewed predecessor: public.set_member_organization_role' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.set_member_access_role(uuid, text, text, boolean, uuid, uuid)'))) is distinct from '44d1f30d486e16efa50ba13e401c23bb' then raise exception 'unreviewed predecessor: public.set_member_access_role' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.create_member_invitation(text, text, text, text, text, text)'))) is distinct from '454e9a614720747d8914d41f6ffe3839' then raise exception 'unreviewed predecessor: public.create_member_invitation' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.finalize_member_invitation(uuid, uuid)'))) is distinct from 'db708826198676a2368a4bfc071d087d' then raise exception 'unreviewed predecessor: public.finalize_member_invitation' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.staff_visible_member_ids(text)'))) is distinct from '527e10cef97ac2c1d65803081cf38b2f' then raise exception 'unreviewed predecessor: private.staff_visible_member_ids' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.chapter_records_scope_memo(text)'))) is distinct from '8e98c0f1ec09a77f5a6e01087aab7599' then raise exception 'unreviewed predecessor: private.chapter_records_scope_memo' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_institutional_records_workspace()'))) is distinct from '31b9655e11cdfc7763fbfa509b4367b1' then raise exception 'unreviewed predecessor: public.get_institutional_records_workspace' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.save_scoped_institutional_record(uuid, text, text, text, timestamp with time zone, text, text, boolean, text, integer, jsonb, uuid, uuid, text, uuid)'))) is distinct from '419bf85ebc0ddbec1154aeaa6caa4119' then raise exception 'unreviewed predecessor: public.save_scoped_institutional_record' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.chapter_contact_entry_allowed(text,uuid,uuid)'))) is distinct from 'f6bf07892b19c7100bee5f3f65efa721' then raise exception 'unreviewed predecessor: private.chapter_contact_entry_allowed' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.chapter_seniority_member_allowed(text,uuid)'))) is distinct from 'd3d8f16101c67b9955c84e102930682a' then raise exception 'unreviewed predecessor: private.chapter_seniority_member_allowed' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.import_chapter_seniority(text, jsonb, boolean)'))) is distinct from '3b91e0c60157b8087c177b6c4c471411' then raise exception 'unreviewed predecessor: public.import_chapter_seniority' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.list_chapter_seniority(text, date, uuid, integer)'))) is distinct from '1ad8fa8e93dbc78a5e2f1f70fdb5b196' then raise exception 'unreviewed predecessor: public.list_chapter_seniority' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.search_chapter_seniority_members(text, text)'))) is distinct from '5a79bbabd75ffc6d2978c1e901931048' then raise exception 'unreviewed predecessor: public.search_chapter_seniority_members' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.save_chapter_seniority_entry(text, uuid, date, text, text)'))) is distinct from 'd465e95ad9b211c01821da76a4b0c3b8' then raise exception 'unreviewed predecessor: public.save_chapter_seniority_entry' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.list_chapter_bid_windows(text, integer, integer)'))) is distinct from '4ccc7715701fe427a1962f9e3f4356cc' then raise exception 'unreviewed predecessor: public.list_chapter_bid_windows' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.record_chapter_bid(uuid, uuid, text)'))) is distinct from '5580a3073b8b607293b3281ffbb40419' then raise exception 'unreviewed predecessor: public.record_chapter_bid' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.list_chapter_bid_window_bids(uuid, integer, integer)'))) is distinct from '5aab9a6a74c58de772920c7e5a0571ad' then raise exception 'unreviewed predecessor: public.list_chapter_bid_window_bids' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.chapter_staff_member_allowed(text,uuid,text[])'))) is distinct from 'd49ea601aec799aab32c98702d2c51cb' then raise exception 'unreviewed predecessor: private.chapter_staff_member_allowed' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.delete_chapter_seniority_entry(uuid)'))) is distinct from '7565ffe1f60ac204e4fa7bff6be5e210' then raise exception 'unreviewed predecessor: public.delete_chapter_seniority_entry' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.answer_chapter_seniority_question(uuid, text)'))) is distinct from 'aa017f6ef680b12c9f1f830509cc7fac' then raise exception 'unreviewed predecessor: public.answer_chapter_seniority_question' using errcode='55000'; end if;
  if (select pg_catalog.md5(pg_catalog.pg_get_expr(polqual,polrelid)) from pg_catalog.pg_policy where polrelid='public.chapter_records'::regclass and polname='chapter_records_select') is distinct from '0a766f52eb8ab5f4134a9eb5b4c14f42' then raise exception 'unreviewed predecessor: chapter_records_select' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.chapter_officer_can(text, text)'))) is distinct from 'faacca8f266007345050428eee1c7783' then raise exception 'unreviewed predecessor: private.chapter_officer_can' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.staff_actor_can_see_user(uuid, uuid)'))) is distinct from '0312090793c235cfaaf0883eb2dbeada' then raise exception 'unreviewed predecessor: private.staff_actor_can_see_user' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.set_scim_group_role(uuid, text)'))) is distinct from '782615a8de72d29d8cbb0130fafe3a07' then raise exception 'unreviewed predecessor: public.set_scim_group_role' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.learning_undo_organization_role(text, jsonb)'))) is distinct from '2f90699306b88f719478ecd5a2d79399' then raise exception 'unreviewed predecessor: private.learning_undo_organization_role' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.learning_undo_chapter_role(text, jsonb)'))) is distinct from 'e6beda15a979b69a8eecc705c29d02c8' then raise exception 'unreviewed predecessor: private.learning_undo_chapter_role' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.chapter_grievance_steward_scope(text, uuid)'))) is distinct from 'bab7bc4db0323e849f16298843e950db' then raise exception 'unreviewed predecessor: private.chapter_grievance_steward_scope' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.decide_member_request(uuid, text)'))) is distinct from 'd887641859822b1c9757514fb06e19fb' then raise exception 'unreviewed predecessor: public.decide_member_request' using errcode='55000'; end if;
end;
$predecessors$;

alter table private.chapter_units add column is_default boolean not null default false;
create unique index chapter_units_one_default on private.chapter_units(chapter_id) where is_default;
alter table private.chapter_role_scopes add column legacy_chapter_coverage boolean not null default false;
-- Existing organization-only stewards retain their original grant as the
-- authority. No membership or chapter-role row is manufactured for them.
-- These additional keys strengthen the new relation; every existing FK stays.
alter table private.chapter_units add constraint chapter_units_grant_scope_key unique(id,chapter_id,organization_id);
create table private.organization_steward_unit_assignments (
  organization_id uuid not null,
  user_id uuid not null constraint organization_steward_assignment_user_fkey references auth.users(id) on delete cascade,
  role text not null default 'steward' constraint organization_steward_assignment_role_check check(role='steward'),
  chapter_id text not null,
  unit_id uuid not null,
  legacy_chapter_coverage boolean not null default false,
  primary key(user_id,chapter_id),
  constraint organization_steward_assignment_grant_fkey foreign key(organization_id,user_id,role) references public.organization_role_grants(organization_id,user_id,role) on update cascade on delete cascade,
  constraint organization_steward_assignment_unit_fkey foreign key(unit_id,chapter_id,organization_id) references private.chapter_units(id,chapter_id,organization_id) on update cascade on delete no action deferrable initially deferred
);
create index organization_steward_unit_assignments_unit_idx on private.organization_steward_unit_assignments(unit_id,chapter_id,organization_id);
create index organization_steward_unit_assignments_grant_idx on private.organization_steward_unit_assignments(organization_id,user_id,role);
create index organization_steward_unit_assignments_chapter_idx on private.organization_steward_unit_assignments(chapter_id,user_id);
alter table private.organization_steward_unit_assignments enable row level security;
alter table private.organization_steward_unit_assignments force row level security;
revoke all on table private.organization_steward_unit_assignments from public,anon,authenticated,service_role;
create policy mfa_assurance on private.organization_steward_unit_assignments as restrictive for all to authenticated using(private.mfa_satisfied()) with check(private.mfa_satisfied());
comment on policy mfa_assurance on private.organization_steward_unit_assignments is 'Require MFA as defense in depth for migrated organization-grant-backed assignments. No client privilege or permissive policy is granted; reviewed bounded definer readers retain the grant authority.';
-- No permissive client policy or privilege: only reviewed definer paths read it.
create trigger a00_case_graph_lock before insert or update or delete on private.organization_steward_unit_assignments
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.organization_steward_unit_assignments
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
insert into private.account_lifecycle_manifest
  (schema_name,table_name,user_column,delete_disposition,export_disposition,export_projection,export_inventory_basis,export_projection_version,export_domain,export_columns,note)
values('private','organization_steward_unit_assignments','user_id','cascade','included','additional_domains','auth_user_fk',1,'additionalDomains.organization_steward_unit_assignments',array['organization_id','user_id','role','chapter_id','unit_id','legacy_chapter_coverage'],'Existing organization-grant-backed steward assignments; no new membership or chapter role. Grant and account removal cascade; only the subject exports their identifiers.');

-- A committee-only steward did not have whole-chapter coverage. Do not
-- silently widen such a grant under a ruling about formerly unscoped ones.
do $committee_preflight$
declare
  blocking_grants bigint;
begin
  select count(*) into blocking_grants from private.chapter_role_scopes
  where role='steward' and unit_id is null and committee_id is not null;
  if blocking_grants>0 then
    raise exception 'steward_unit_migration_blocked: % committee-only steward grants; an administrator must choose a chapter unit for each before this migration',blocking_grants using errcode='55000';
  end if;
end;
$committee_preflight$;

-- BEGIN MIGRATION-ONLY BACKFILL (retained verbatim for the rollback proof).
create temporary table c69_legacy_stewards on commit drop as
select distinct on(user_id,chapter_id) user_id,chapter_id,organization_id,granted_by,(priority=1) organization_grant_only
from (
  select grant_row.user_id,grant_row.chapter_id,chapter.organization_id,grant_row.granted_by,0 priority
  from public.member_role_chapters grant_row
  join public.chapters chapter on chapter.id=grant_row.chapter_id
  where grant_row.role='steward' and chapter.organization_id is not null
    and not exists(select 1 from private.chapter_role_scopes scope
      where scope.user_id=grant_row.user_id and scope.chapter_id=grant_row.chapter_id and scope.role='steward')
  union all
  select grant_row.user_id,chapter.id,grant_row.organization_id,grant_row.granted_by,1
  from public.organization_role_grants grant_row
  -- Organization-wide grants previously cover chapters even without a
  -- personal chapter membership. Snapshot each existing chapter, without
  -- adding or changing any member's memberships.
  join public.chapters chapter on chapter.organization_id=grant_row.organization_id
  where grant_row.role='steward'
    and not exists(select 1 from private.chapter_role_scopes scope
      where scope.user_id=grant_row.user_id and scope.chapter_id=chapter.id and scope.role='steward')
) candidates order by user_id,chapter_id,priority;

create temporary table c69_default_unit_chapters on commit drop as
select chapter.id,chapter.organization_id,
  coalesce(nullif(pg_catalog.left(pg_catalog.regexp_replace(chapter.name,'[[:cntrl:]<>]','','g'),120),''),pg_catalog.left(chapter.id,120)) unit_name
from public.chapters chapter where chapter.organization_id is not null
  and (not exists(select 1 from private.chapter_units unit where unit.chapter_id=chapter.id)
    or exists(select 1 from pg_temp.c69_legacy_stewards legacy where legacy.chapter_id=chapter.id));
-- #8589 round 2: the default is always a new unit. An existing unit, even
-- one named after the chapter, keeps its physical meaning; marking it default
-- would add every member without a physical unit to its scoped stewards.
-- The first unused name: the chapter's, then "(all members)", then numbered.
insert into private.chapter_units(organization_id,chapter_id,name,kind,is_default)
select needed.organization_id,needed.id,chosen.name,'unit',true
from pg_temp.c69_default_unit_chapters needed
cross join lateral (
  select candidate.name from (
    select 0 as rank,needed.unit_name as name
    union all select 1,pg_catalog.left(needed.unit_name,100)||' (all members)'
    union all select number,pg_catalog.left(needed.unit_name,100)||' (all members '||number||')'
      from pg_catalog.generate_series(2,1000) number
  ) candidate
  where not exists(select 1 from private.chapter_units unit
    where unit.chapter_id=needed.id and pg_catalog.lower(unit.name)=pg_catalog.lower(candidate.name))
  order by candidate.rank limit 1
) chosen
where not exists(select 1 from private.chapter_units unit where unit.chapter_id=needed.id and unit.is_default);

insert into public.member_roles(user_id,role,chapter_id,granted_by)
select user_id,'steward',chapter_id,granted_by from pg_temp.c69_legacy_stewards where not organization_grant_only
on conflict(user_id,role) do nothing;
insert into public.member_role_chapters(user_id,role,chapter_id,granted_by)
select user_id,'steward',chapter_id,granted_by from pg_temp.c69_legacy_stewards where not organization_grant_only
on conflict(user_id,role,chapter_id) do nothing;
with migrated_chapter as (
  insert into private.chapter_role_scopes(user_id,chapter_id,role,unit_id,legacy_chapter_coverage)
  select legacy.user_id,legacy.chapter_id,'steward',unit.id,true
  from pg_temp.c69_legacy_stewards legacy
  join private.chapter_units unit on unit.chapter_id=legacy.chapter_id and unit.is_default
  where not legacy.organization_grant_only
  on conflict(user_id,chapter_id,role) do nothing
  returning user_id,chapter_id,unit_id
), migrated_organization as (
  insert into private.organization_steward_unit_assignments(organization_id,user_id,chapter_id,unit_id,legacy_chapter_coverage)
  select legacy.organization_id,legacy.user_id,legacy.chapter_id,unit.id,true
  from pg_temp.c69_legacy_stewards legacy
  join private.chapter_units unit on unit.chapter_id=legacy.chapter_id and unit.is_default
  where legacy.organization_grant_only
  on conflict(user_id,chapter_id) do nothing
  returning user_id,chapter_id,unit_id
), migrated as (
  select * from migrated_chapter union all select * from migrated_organization
)
insert into public.member_admin_audit(actor,action,target_user,detail)
select null,'role_scope_updated',migrated.user_id,pg_catalog.jsonb_build_object(
  'chapterId',migrated.chapter_id,'role','steward','unitId',migrated.unit_id,
  'legacyChapterCoverage',true,'organizationGrantOnly',legacy.organization_grant_only,'source','migration-7663')
from migrated join pg_temp.c69_legacy_stewards legacy
  on legacy.user_id=migrated.user_id and legacy.chapter_id=migrated.chapter_id;
-- END MIGRATION-ONLY BACKFILL.
-- #8589 final: settle this block's pending deferred checks before any DDL on
-- the tables it wrote (ALTER TABLE refuses pending trigger events, 55006),
-- then restore deferred mode for the rest of the migration.
set constraints all immediate;
set constraints all deferred;

alter table private.chapter_role_scopes add constraint steward_scope_requires_unit
  check(role<>'steward' or (unit_id is not null and committee_id is null));
alter table private.chapter_role_scopes add constraint carry_over_only_for_steward
  check(not legacy_chapter_coverage or (role='steward' and unit_id is not null and committee_id is null));


CREATE FUNCTION private.steward_assignment_scopes(p_actor uuid, p_chapter text DEFAULT NULL::text)
 RETURNS TABLE(user_id uuid, chapter_id text, role text, unit_id uuid, committee_id uuid, legacy_chapter_coverage boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select s.user_id,s.chapter_id,s.role,s.unit_id,s.committee_id,s.legacy_chapter_coverage from private.chapter_role_scopes s where s.user_id=p_actor and (p_chapter is null or s.chapter_id=p_chapter)
  union all
  select s.user_id,s.chapter_id,s.role,s.unit_id,null::uuid,s.legacy_chapter_coverage from private.organization_steward_unit_assignments s where s.user_id=p_actor and (p_chapter is null or s.chapter_id=p_chapter);
$function$;
revoke all on function private.steward_assignment_scopes(uuid,text) from public,anon,authenticated,service_role;

CREATE FUNCTION private.reject_new_organization_steward_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  raise exception 'organization-backed steward assignments are migration-only' using errcode='42501';
end;
$function$;
revoke all on function private.reject_new_organization_steward_assignment() from public,anon,authenticated,service_role;

CREATE FUNCTION private.enforce_one_steward_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.role='steward' and exists(select 1 from private.chapter_role_scopes chapter_scope
    join private.organization_steward_unit_assignments organization_scope
      on organization_scope.user_id=chapter_scope.user_id and organization_scope.chapter_id=chapter_scope.chapter_id
    where chapter_scope.role='steward' and chapter_scope.user_id=new.user_id and chapter_scope.chapter_id=new.chapter_id) then
    raise exception 'a steward has exactly one assignment per chapter' using errcode='23514';
  end if;
  return null;
end;
$function$;
revoke all on function private.enforce_one_steward_assignment() from public,anon,authenticated,service_role;

CREATE FUNCTION private.chapter_unit_has_member(p_unit uuid, p_chapter text, p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists(select 1 from private.chapter_units unit
    where unit.id=p_unit and unit.chapter_id=p_chapter
      and (exists(select 1 from private.chapter_unit_members membership
        where membership.unit_id=unit.id and membership.chapter_id=p_chapter and membership.user_id=p_user)
        or (unit.is_default and exists(select 1 from public.member_chapter_memberships membership
          join public.organization_memberships organization_membership
            on organization_membership.user_id=membership.user_id and organization_membership.organization_id=unit.organization_id
           and organization_membership.status='active'
          where membership.user_id=p_user and membership.chapter_id=p_chapter and membership.status='active')
          and not exists(select 1 from private.chapter_unit_members membership
            where membership.user_id=p_user and membership.chapter_id=p_chapter))));
$function$;
revoke all on function private.chapter_unit_has_member(uuid,text,uuid) from public,anon,authenticated,service_role;

CREATE FUNCTION private.chapter_unit_member_ids(p_unit uuid, p_chapter text)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select membership.user_id from private.chapter_unit_members membership
    where membership.unit_id=p_unit and membership.chapter_id=p_chapter
  union
  select membership.user_id from private.chapter_units unit
  join public.member_chapter_memberships membership on membership.chapter_id=unit.chapter_id and membership.status='active'
  join public.organization_memberships organization_membership on organization_membership.user_id=membership.user_id
    and organization_membership.organization_id=unit.organization_id and organization_membership.status='active'
  where unit.id=p_unit and unit.chapter_id=p_chapter and unit.is_default
    and not exists(select 1 from private.chapter_unit_members physical
      where physical.user_id=membership.user_id and physical.chapter_id=p_chapter);
$function$;
revoke all on function private.chapter_unit_member_ids(uuid,text) from public,anon,authenticated,service_role;

CREATE FUNCTION private.reject_steward_carry_over_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.legacy_chapter_coverage then
    raise exception 'carry-over coverage is migration-only and cannot be set or restored' using errcode='42501';
  end if;
  return new;
end;
$function$;
revoke all on function private.reject_steward_carry_over_write() from public,anon,authenticated,service_role;

CREATE FUNCTION private.clear_steward_carry_over_on_choice()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  new.legacy_chapter_coverage:=false;
  return new;
end;
$function$;
revoke all on function private.clear_steward_carry_over_on_choice() from public,anon,authenticated,service_role;

CREATE FUNCTION private.enforce_steward_unit_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_op<>'INSERT' and old.role='steward'
     and exists(select 1 from public.member_role_chapters grant_row join public.chapters chapter on chapter.id=grant_row.chapter_id
       where grant_row.user_id=old.user_id and grant_row.chapter_id=old.chapter_id and grant_row.role='steward' and chapter.organization_id is not null)
     and not exists(select 1 from private.chapter_role_scopes scope
       join private.chapter_units unit on unit.id=scope.unit_id and unit.chapter_id=scope.chapter_id
       where scope.user_id=old.user_id and scope.chapter_id=old.chapter_id and scope.role='steward' and scope.committee_id is null) then
    raise exception 'steward requires a unit in their chapter' using errcode='23514';
  end if;
  -- #8589 round 1: a surviving organization steward grant keeps needing an
  -- assignment in this chapter; removing the last one would leave the grant
  -- with no unit there. Revoke the organization grant first.
  if tg_op<>'INSERT' and old.role='steward'
     and exists(select 1 from public.chapters chapter join public.organization_role_grants grant_row
       on grant_row.organization_id=chapter.organization_id and grant_row.user_id=old.user_id and grant_row.role='steward'
       where chapter.id=old.chapter_id)
     and not exists(select 1 from private.steward_assignment_scopes(old.user_id,old.chapter_id) scope
       join private.chapter_units unit on unit.id=scope.unit_id and unit.chapter_id=scope.chapter_id
       where scope.user_id=old.user_id and scope.chapter_id=old.chapter_id and scope.role='steward' and scope.committee_id is null) then
    raise exception 'organization steward requires a unit in each covered chapter' using errcode='23514';
  end if;
  if tg_op<>'DELETE' and new.role='steward'
     and exists(select 1 from public.member_role_chapters grant_row join public.chapters chapter on chapter.id=grant_row.chapter_id
       where grant_row.user_id=new.user_id and grant_row.chapter_id=new.chapter_id and grant_row.role='steward' and chapter.organization_id is not null)
     and not exists(select 1 from private.chapter_role_scopes scope
       join private.chapter_units unit on unit.id=scope.unit_id and unit.chapter_id=scope.chapter_id
       where scope.user_id=new.user_id and scope.chapter_id=new.chapter_id and scope.role='steward' and scope.committee_id is null) then
    raise exception 'steward requires a unit in their chapter' using errcode='23514';
  end if;
  return null;
end;
$function$;
revoke all on function private.enforce_steward_unit_assignment() from public,anon,authenticated,service_role;

CREATE FUNCTION private.enforce_organization_steward_units()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.role='steward'
     and exists(select 1 from public.organization_role_grants grant_row
       where grant_row.user_id=new.user_id and grant_row.organization_id=new.organization_id and grant_row.role='steward')
     and exists(select 1 from public.chapters chapter
       where chapter.organization_id=new.organization_id
         and not exists(select 1 from private.steward_assignment_scopes(new.user_id,chapter.id) scope
           join private.chapter_units unit on unit.id=scope.unit_id and unit.chapter_id=chapter.id
           where scope.user_id=new.user_id and scope.chapter_id=chapter.id and scope.role='steward' and scope.committee_id is null)) then
    raise exception 'organization steward requires an explicit unit assignment in every covered chapter' using errcode='23514';
  end if;
  return null;
end;
$function$;
revoke all on function private.enforce_organization_steward_units() from public,anon,authenticated,service_role;

CREATE FUNCTION private.create_chapter_default_unit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
begin
  if new.organization_id is not null and not exists(select 1 from private.chapter_units where chapter_id=new.id) then
    insert into private.chapter_units(organization_id,chapter_id,name,kind,is_default)
    values(new.organization_id,new.id,coalesce(nullif(pg_catalog.left(pg_catalog.regexp_replace(new.name,'[[:cntrl:]<>]','','g'),120),''),pg_catalog.left(new.id,120)),'unit',true);
  end if;
  return new;
end;
end;
$function$;
revoke all on function private.create_chapter_default_unit() from public,anon,authenticated,service_role;

CREATE FUNCTION private.enforce_chapter_has_unit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if exists(select 1 from public.chapters where id=old.chapter_id and organization_id is not null)
     and not exists(select 1 from private.chapter_units where chapter_id=old.chapter_id) then
    raise exception 'a chapter must keep at least one unit' using errcode='23514';
  end if;
  return null;
end;
$function$;
revoke all on function private.enforce_chapter_has_unit() from public,anon,authenticated,service_role;

CREATE FUNCTION private.member_invitation_selected_unit(p_invitation uuid, p_chapter text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with recursive chain(id,replaces_id,depth) as (
    select id,replaces_id,0 from public.member_invitations where id=p_invitation and chapter_id=p_chapter
    union all
    select invitation.id,invitation.replaces_id,chain.depth+1 from chain
    join public.member_invitations invitation on invitation.id=chain.replaces_id
      and invitation.chapter_id=p_chapter where chain.depth<20
  )
  select unit.id from chain join private.member_invitation_units link on link.invitation_id=chain.id
    join private.chapter_units unit on unit.id=link.unit_id and unit.chapter_id=p_chapter
  order by chain.depth limit 1;
$function$;
revoke all on function private.member_invitation_selected_unit(uuid,text) from public,anon,authenticated,service_role;

CREATE FUNCTION public.get_steward_unit_assignment(p_user uuid, p_chapter text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not private.mfa_satisfied() or private.member_pin_session_restricted()
     or not coalesce(private.chapter_access_leadership(p_chapter),false)
     or (not private.has_organization_role(private.current_member_organization(),array['admin'])
       and p_chapter is distinct from private.current_member_chapter()) then
    raise exception 'own chapter leadership required' using errcode='42501';
  end if;
  return pg_catalog.jsonb_build_object('userId',p_user,'chapterId',p_chapter,
    'unitId',(select unit_id from private.steward_assignment_scopes(p_user,p_chapter) where user_id=p_user and chapter_id=p_chapter and role='steward'),
    'legacyChapterCoverage',coalesce((select legacy_chapter_coverage from private.steward_assignment_scopes(p_user,p_chapter)
      where user_id=p_user and chapter_id=p_chapter and role='steward'),false));
end;
$function$;
revoke all on function public.get_steward_unit_assignment(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.get_steward_unit_assignment(uuid,text) to authenticated;

-- These helpers preserve the old organization-wide steward arm only while
-- the exact chapter assignment retains its migration-only carry-over mark.
-- A scoped assignment never supplies chapter-wide authority, including when
-- the actor has no personal membership in that chapter.
CREATE FUNCTION private.organization_steward_scope_allows(p_actor uuid, p_chapter text, p_target uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists(select 1 from public.chapters chapter
    join public.organizations organization on organization.id=chapter.organization_id and organization.status='active'
    join public.organization_role_grants grant_row on grant_row.organization_id=chapter.organization_id
      and grant_row.user_id=p_actor and grant_row.role='steward'
    join public.organization_memberships membership on membership.organization_id=chapter.organization_id
      and membership.user_id=p_actor and membership.status='active'
    join private.steward_assignment_scopes(p_actor,p_chapter) scope on scope.chapter_id=chapter.id
      and scope.user_id=p_actor and scope.role='steward'
    where chapter.id=p_chapter
      and (not private.staff_mfa_required(chapter.organization_id) or private.has_second_factor(p_actor))
      and (scope.legacy_chapter_coverage or (p_target is not null
        and exists(select 1 from public.member_chapter_memberships target
          join public.organization_memberships target_org on target_org.user_id=target.user_id
            and target_org.organization_id=chapter.organization_id and target_org.status='active'
          where target.user_id=p_target and target.chapter_id=chapter.id and target.status='active')
        and private.chapter_unit_has_member(scope.unit_id,scope.chapter_id,p_target))));
$function$;
revoke all on function private.organization_steward_scope_allows(uuid,text,uuid) from public,anon,authenticated,service_role;

-- #8589 stage 148: the one test for "the organization steward grant is the
-- actor's only steward authority in this chapter". True when the actor holds
-- that grant, has no steward assignment in the chapter, holds no higher
-- organization role, and holds no live chapter role that authorizes case
-- access there (an office role such as Secretary never counts). A scoped
-- chapter role still limits the actor through the shared case predicate.
CREATE FUNCTION private.organization_steward_unassigned(p_actor uuid, p_chapter text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists(select 1 from public.organization_role_grants grant_row join public.chapters chapter on chapter.organization_id=grant_row.organization_id
      where chapter.id=p_chapter and grant_row.user_id=p_actor and grant_row.role='steward')
    and not exists(select 1 from private.steward_assignment_scopes(p_actor,p_chapter) scope
      where scope.user_id=p_actor and scope.chapter_id=p_chapter and scope.role='steward')
    and not exists(select 1 from public.organization_role_grants grant_row join public.chapters chapter on chapter.organization_id=grant_row.organization_id
      where chapter.id=p_chapter and grant_row.user_id=p_actor and grant_row.role=any(array['coordinator','advisor','admin','vp']))
    and not exists(select 1 from public.member_role_chapters grant_row
      join public.member_chapter_memberships membership on membership.user_id=grant_row.user_id
        and membership.chapter_id=grant_row.chapter_id and membership.status='active'
      where grant_row.user_id=p_actor and grant_row.chapter_id=p_chapter
        and grant_row.role=any(array['steward','coordinator','advisor','admin','vp']));
$function$;
revoke all on function private.organization_steward_unassigned(uuid,text) from public,anon,authenticated,service_role;

CREATE FUNCTION private.chapter_organization_role_allowed(p_chapter text, p_roles text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select private.mfa_satisfied() and exists(select 1 from public.chapters chapter
    where chapter.id=p_chapter and chapter.organization_id=private.current_mobile_staff_organization()
      and (private.has_organization_role(chapter.organization_id,pg_catalog.array_remove(p_roles,'steward'))
        or ('steward'=any(p_roles)
          and private.organization_steward_scope_allows((select auth.uid()),chapter.id,null))));
$function$;
revoke all on function private.chapter_organization_role_allowed(text,text[]) from public,anon,authenticated,service_role;
-- The reviewed chapter_records_select RLS policy calls this helper directly.
grant execute on function private.chapter_organization_role_allowed(text,text[]) to authenticated;

CREATE FUNCTION private.enforce_organization_steward_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if exists(select 1 from public.organization_role_grants grant_row
      where grant_row.organization_id=old.organization_id and grant_row.user_id=old.user_id and grant_row.role='steward')
    and exists(select 1 from public.chapters chapter where chapter.id=old.chapter_id and chapter.organization_id=old.organization_id)
    and not exists(select 1 from private.steward_assignment_scopes(old.user_id,old.chapter_id) scope
      where scope.user_id=old.user_id and scope.chapter_id=old.chapter_id and scope.role='steward') then
    raise exception 'organization steward requires a unit in each covered chapter' using errcode='23514';
  end if;
  return null;
end;
$function$;
revoke all on function private.enforce_organization_steward_assignment() from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.member_has_chapter_role(p_chapter_id text, p_roles text[])
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return (
select (select auth.uid()) is not null
    and (select private.mfa_satisfied())
    and exists (
    select 1
    from public.chapters c
    where c.id = p_chapter_id
      and (
        (
          c.organization_id is not null
          and c.organization_id = (select private.current_member_organization())
          and exists (
            select 1
            from public.organization_memberships om
            where om.user_id = (select auth.uid())
              and om.organization_id = c.organization_id
              and om.status = 'active'
          )
          and exists (
            select 1
            from public.member_chapter_memberships m
            where m.user_id = (select auth.uid())
              and m.chapter_id = c.id
              and m.status = 'active'
          )
          and (
            not private.staff_mfa_required(c.organization_id)
            or private.has_second_factor((select auth.uid()))
          )
          and (
            private.chapter_organization_role_allowed(c.id,p_roles)
            or exists (
              select 1
              from public.member_role_chapters rc
              join public.member_chapter_memberships m
                on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id
              where rc.user_id = (select auth.uid())
                and rc.role = any(p_roles)
                and not exists(select 1 from (select * from private.steward_assignment_scopes((select auth.uid()),null) where not legacy_chapter_coverage) scope where scope.user_id=rc.user_id and scope.chapter_id=rc.chapter_id and scope.role=rc.role)
                and rc.chapter_id = c.id
                and m.status = 'active'
            )
          )
        )
        or (
          c.organization_id is null
          and (select private.current_member_organization()) is null
          and public.member_has_role(p_roles)
          and exists (
            select 1
            from public.member_roles r
            where r.user_id = (select auth.uid())
              and r.role = any(p_roles)
              and (
                r.chapter_id is null
                or exists (
                  select 1
                  from public.member_role_chapters rc
                  join public.member_chapter_memberships m
                    on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id
                  where rc.user_id = r.user_id
                    and rc.role = r.role
                    and not exists(select 1 from (select * from private.steward_assignment_scopes((select auth.uid()),null) where not legacy_chapter_coverage) scope where scope.user_id=rc.user_id and scope.chapter_id=rc.chapter_id and scope.role=rc.role)
                    and rc.chapter_id = p_chapter_id
                    and m.status = 'active'
                )
              )
          )
        )
      )
  )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.actor_role_covers_member(p_actor uuid, p_chapter text, p_role text, p_target uuid, p_grievance boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return (
select exists(select 1 from public.chapters c
    join public.organizations organization on organization.id=c.organization_id and organization.status='active'
    join public.organization_memberships actor_org on actor_org.organization_id=c.organization_id and actor_org.user_id=p_actor and actor_org.status='active'
    left join public.organization_memberships target_org on target_org.organization_id=c.organization_id and target_org.user_id=p_target and target_org.status='active'
    left join public.member_chapter_memberships target on target.chapter_id=c.id and target.user_id=p_target and target.status='active'
    where c.id=p_chapter
      and (not private.staff_mfa_required(c.organization_id) or private.has_second_factor(p_actor))
      and (p_target is null or (target_org.user_id is not null and target.user_id is not null)) and (
      exists(select 1 from public.organization_role_grants r where r.organization_id=c.organization_id and r.user_id=p_actor and r.role=p_role and (p_role<>'steward' or private.organization_steward_scope_allows(p_actor,c.id,p_target)))
      or exists(select 1 from public.member_role_chapters r
        join public.member_chapter_memberships actor on actor.user_id=r.user_id and actor.chapter_id=r.chapter_id and actor.status='active'
        left join (select * from private.steward_assignment_scopes(p_actor,null) where not legacy_chapter_coverage) scope on scope.user_id=r.user_id and scope.chapter_id=r.chapter_id and scope.role=r.role
        where r.user_id=p_actor and r.chapter_id=c.id and r.role=p_role and (
          scope.user_id is null
          or private.chapter_unit_has_member(scope.unit_id,c.id,p_target)
          or exists(select 1 from private.chapter_committees committee
            join private.chapter_committee_members m on m.committee_id=committee.id and m.chapter_id=committee.chapter_id
            where committee.id=scope.committee_id and committee.chapter_id=c.id and m.user_id=p_target
              and committee.starts_on<=current_date and (committee.ends_on is null or committee.ends_on>=current_date)
              and (not p_grievance or committee.grievance_access))))))
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.actor_case_scope_and_identity_allowed(p_actor uuid, p_case member_cases)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- Existing unscoped, unmarked cases keep their established read cost. CASE
  -- makes the expensive role composition conditional even under SQL planning.
  select coalesce(case when p_case.user_id=p_actor then true
    -- #8589 re-final and stage 148: an organization steward grant with no
    -- assignment in the case's chapter (one created after the backfill) is not
    -- coverage there, unless a live case-access chapter role, a higher
    -- organization role or an explicit grant to this case reaches it.
    when private.organization_steward_unassigned(p_actor,p_case.chapter_id)
      and not exists(select 1 from public.casework_access_grants access_grant
        where access_grant.case_id=p_case.id and access_grant.grantee_user_id=p_actor and access_grant.revoked_at is null) then false
    when not exists(select 1 from (select * from private.steward_assignment_scopes(p_actor,null) where not legacy_chapter_coverage) s where s.user_id=p_actor)
      and not exists(select 1 from private.case_identity_privacy privacy where privacy.case_id=p_case.id) then true
    else (
    (not exists(select 1 from (select * from private.steward_assignment_scopes(p_actor,null) where not legacy_chapter_coverage) s where s.user_id=p_actor)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'steward',p_case.user_id,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'coordinator',p_case.user_id,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'advisor',p_case.user_id,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'admin',p_case.user_id,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'vp',p_case.user_id,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'steward',null,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'coordinator',null,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'advisor',null,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'admin',null,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'vp',null,true))
    -- A separate chapter-wide grant continues to cover retained cases whose
    -- owner no longer has a live membership. Scoped grants never cover null.
    and (not exists(select 1 from private.case_identity_privacy privacy where privacy.case_id=p_case.id)
      or (p_case.steward_user_id=p_actor and (private.actor_role_covers_member(p_actor,p_case.chapter_id,'steward',p_case.user_id,true) or private.actor_role_covers_member(p_actor,p_case.chapter_id,'steward',null,true)))
      or (p_case.coordinator_user_id=p_actor and (private.actor_role_covers_member(p_actor,p_case.chapter_id,'coordinator',p_case.user_id,true) or private.actor_role_covers_member(p_actor,p_case.chapter_id,'coordinator',null,true)))
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'advisor',p_case.user_id,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'admin',p_case.user_id,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'vp',p_case.user_id,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'advisor',null,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'admin',null,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'vp',null,true))) end,false);
$function$;

CREATE OR REPLACE FUNCTION private.chapter_case_intake_role_allows(p_member uuid, p_role text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select private.mfa_satisfied() and not private.member_pin_session_restricted()
    and public.staff_can_see_user(p_member,p_role)
    and (not exists(select 1 from (select * from private.steward_assignment_scopes((select auth.uid()),null) where not legacy_chapter_coverage) scope
      join public.chapters c on c.id=scope.chapter_id
      where scope.user_id=(select auth.uid()) and scope.role=p_role
        and c.organization_id=private.current_member_organization())
      or exists(select 1 from public.member_profiles target
        where target.id=p_member and private.actor_role_covers_member((select auth.uid()),target.chapter_id,p_role,p_member,true)));
$function$;

CREATE OR REPLACE FUNCTION private.chapter_record_manageable(p_chapter text, p_unit uuid, p_committee uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select private.member_has_chapter_role(p_chapter,array['steward','coordinator','advisor','admin','vp'])
    or exists (
      select 1 from private.chapter_role_capabilities capability
      left join private.chapter_role_settings setting on setting.chapter_id=p_chapter
        and setting.role=capability.role and setting.capability=capability.capability
      where capability.capability='records'
        and capability.role=any(array['steward','coordinator','advisor','admin','vp'])
        and coalesce(setting.enabled,true)
        and private.member_has_chapter_staff_grant(p_chapter,array[capability.role])
      and (
        (p_unit is null and p_committee is null)
        or exists (
          select 1 from (select * from private.steward_assignment_scopes((select auth.uid()),null) where not legacy_chapter_coverage) scope
          left join private.chapter_committees committee on committee.id = scope.committee_id
          where scope.user_id = (select auth.uid()) and scope.chapter_id = p_chapter
            and scope.role=capability.role
            and (
              (p_unit is not null and p_committee is null and scope.unit_id = p_unit)
              or (p_unit is null and p_committee is not null and scope.committee_id = p_committee
                and (committee.starts_on is null or committee.starts_on <= current_date)
                and (committee.ends_on is null or committee.ends_on >= current_date))
            )
        )
      )
    )
    or private.chapter_officer_can_for_scope(p_chapter,'records',p_unit,p_committee);
$function$;

CREATE OR REPLACE FUNCTION private.draft_steward_covers_member(p_steward uuid, p_owner uuid, p_chapter text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists(select 1 from public.chapters c
    join public.member_chapter_memberships recipient on recipient.chapter_id=c.id and recipient.user_id=p_steward and recipient.status='active'
    join public.member_chapter_memberships owner_member on owner_member.chapter_id=c.id and owner_member.user_id=p_owner and owner_member.status='active'
    join public.organization_memberships recipient_org on recipient_org.organization_id=c.organization_id and recipient_org.user_id=p_steward and recipient_org.status='active'
    join public.organization_memberships owner_org on owner_org.organization_id=c.organization_id and owner_org.user_id=p_owner and owner_org.status='active'
    where c.id=p_chapter and c.organization_id=private.current_member_organization()
      and (private.organization_steward_scope_allows(p_steward,c.id,p_owner)
        or exists(select 1 from public.member_role_chapters r
          left join (select * from private.steward_assignment_scopes(p_steward,null) where not legacy_chapter_coverage) s on s.user_id=r.user_id and s.chapter_id=r.chapter_id and s.role=r.role
          where r.user_id=p_steward and r.chapter_id=c.id and r.role='steward'
            and (s.user_id is null
              or (s.unit_id is not null and private.chapter_unit_has_member(s.unit_id,c.id,p_owner))
              or (s.committee_id is not null and exists(select 1 from private.chapter_committees committee
                join private.chapter_committee_members m on m.committee_id=committee.id and m.chapter_id=committee.chapter_id
                where committee.id=s.committee_id and committee.starts_on<=current_date and (committee.ends_on is null or committee.ends_on>=current_date) and m.user_id=p_owner))))));
$function$;

CREATE OR REPLACE FUNCTION private.search_member_cases(p_query text, p_limit integer DEFAULT 20)
 RETURNS TABLE(case_id uuid, reference text, title text, case_type text, articles text, step text, status text, deadline date, updated_at timestamp with time zone, rank real, headline text, headline_source text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
begin
  perform private.member_pin_require_full_session();

declare
  v_query tsquery := pg_catalog.websearch_to_tsquery(
    'pg_catalog.english'::pg_catalog.regconfig, coalesce(p_query, ''));
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_actor uuid := (select auth.uid());
begin
  -- An anonymous caller and an empty or stop-word-only query are the same
  -- answer: nothing. Returning early keeps both off the indexes entirely.
  -- Both tests read the request's JWT and the argument, never the database, so
  -- deciding them before the statement below costs the boundary nothing.
  if v_actor is null or pg_catalog.numnode(v_query) = 0 then
    return;
  end if;

  return query
  -- Everything that depends only on the caller, resolved exactly once, in this
  -- statement's snapshot — the same snapshot the row reads below use, which is
  -- what RLS gives the policies. MATERIALIZED is load-bearing: a single-row CTE
  -- referenced once would be inlined and these helpers would run per row again.
  with actor_scope as materialized (
    select
      exists(select 1 from (select * from private.steward_assignment_scopes(v_actor,null) where not legacy_chapter_coverage) s where s.user_id=v_actor) as has_scoped_grants,
      -- #8589 stage 148: chapters where the organization steward grant is the
      -- caller's only steward authority take the shared case oracle.
      array(select ch.id from public.organization_role_grants grant_row
        join public.chapters ch on ch.organization_id=grant_row.organization_id
        where grant_row.user_id=v_actor and grant_row.role='steward'
          and private.organization_steward_unassigned(v_actor,ch.id)) as unassigned_chapters,
      array(
        select ch.id from public.chapters ch
        left join private.chapter_access_policies target_policy on target_policy.chapter_id=ch.id
        where ch.organization_id=private.current_member_organization()
          and coalesce(target_policy.steward_grievances,true)
          and (not private.staff_mfa_required(ch.organization_id) or private.has_second_factor(v_actor))
          and (private.chapter_organization_role_allowed(ch.id,array['steward'])
            or private.member_has_chapter_role(ch.id,array['steward'])
            or exists(select 1 from public.member_role_chapters r
              join public.chapters source on source.id=r.chapter_id and source.organization_id=ch.organization_id
              join public.member_chapter_memberships actor on actor.chapter_id=r.chapter_id and actor.user_id=r.user_id and actor.status='active'
              join private.chapter_access_policies policy on policy.chapter_id=r.chapter_id and policy.steward_breadth='local' and policy.steward_grievances
              where r.user_id=v_actor and r.role='steward' and private.member_has_chapter_role(r.chapter_id,array['steward'])))
      ) as default_steward_chapters,
      -- mfa_assurance, the RESTRICTIVE policy both case tables carry. It ANDs
      -- over every permissive branch, so it gates the whole `visible` CTE.
      (select private.mfa_satisfied()) as mfa_satisfied,
      -- member_cases_select_steward's second conjunct.
      public.member_has_role(array['steward']) as steward_hat,
      -- public.staff_can_see_user(user_id, 'coordinator') as a set of chapters.
      array(select private.staff_visible_chapter_scope('coordinator')) as coordinator_chapters,
      -- private.has_organization_role(organization_id, array['advisor','admin','vp'])
      -- is false unless organization_id is this organization, so the grant test
      -- is a constant and the per-row test is a column comparison.
      (select private.current_mobile_staff_organization()) as staff_organization,
      coalesce((select private.has_organization_role(
        (select private.current_mobile_staff_organization()),
        array['advisor','admin','vp'])), false) as organization_officer,
      -- private.casework_actor_has_active_grant(id), as the set it tests.
      array(
        select g.case_id
        from public.casework_access_grants g
        where g.grantee_user_id = v_actor
          and g.revoked_at is null
      ) as granted_cases
  ),
  -- The candidate list is what makes the two GIN indexes load-bearing, and it
  -- is not a micro-optimisation. `<case document> @@ v_query OR note.body is
  -- not null` sits above a LEFT JOIN LATERAL, so the planner cannot push the
  -- case-side predicate into the scan: driving straight off public.member_cases
  -- reads EVERY row of a table this deployment sizes at ~400k and runs the
  -- lateral once per row. Selecting the candidate ids through the indexes first
  -- and joining back on the primary key returns the same set: the union is a
  -- superset of the final predicate, and every row it adds is re-tested below.
  --
  -- The two expressions in this CTE are the two index expressions verbatim,
  -- down to the argument order and the weight letters, because an expression
  -- index only serves a query whose expression matches it. Changing one without
  -- the other silently returns this statement to a sequential scan;
  -- tests/member-case-search-db.test.js pins the equality and EXPLAINs the
  -- statement cut out of this file.
  --
  -- Which arm matched is carried forward instead of recomputed: `case_hit` IS
  -- `<case document> @@ v_query` for that row, so the WHERE clause below needs
  -- no second evaluation of a four-call tsvector expression, and `note_hit` is
  -- false exactly when no note on the case can match, which turns the note
  -- lateral into a one-time filter for those rows.
  candidate_hits as (
    select c.id as candidate_id, true as case_hit, false as note_hit
    from public.member_cases c
    where c.learning_undone_at is null and (
      pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.reference, '')), 'A')
      || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.title, '')), 'A')
      || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.case_type, '')), 'B')
      || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.articles, '')), 'C')
    ) @@ v_query
    union all
    select u.case_id as candidate_id, false as case_hit, true as note_hit
    from public.member_case_updates u
    where u.learning_undone_at is null and (
      pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(u.body, ''))
    ) @@ v_query
  ),
  candidates as (
    select
      candidate_id,
      pg_catalog.bool_or(case_hit) as case_hit,
      pg_catalog.bool_or(note_hit) as note_hit
    from candidate_hits
    group by candidate_id
  ),
  -- member_cases_select_coordinator, as a set. No function call per row: the
  -- staff scope is the chapter array resolved once above, the organization
  -- officer test is a column comparison against the one organization
  -- private.has_organization_role can accept, and the access grant is an array
  -- membership test. A caller with no coordinator scope produces this set
  -- without reading public.member_profiles at all.
  --
  -- Every actor_scope value below is read through a scalar subquery rather
  -- than a join to the CTE, here and in the `visible` CTE and the note
  -- lateral. That is deliberate and load-bearing: an uncorrelated scalar
  -- subquery becomes an InitPlan the executor runs once, so each scope value
  -- reaches the row predicates as a constant. Joining actor_scope in instead
  -- makes those values ordinary columns, and the planner is then free to drive
  -- this join from public.member_profiles and re-derive the whole set per outer
  -- row: measured at 48,006 primary-key lookups over an 8,001-candidate
  -- corpus, and unbounded on a deployment where the caller's chapter scope
  -- holds thousands of members. The same rewrite turned the note lateral's
  -- author lookup from a rescan of public.member_profiles per note into one
  -- hashed probe for the statement.
  --
  -- `offset 0` is the optimisation fence explained above the same construct in
  -- the `visible` CTE below: it keeps the candidate list the driving relation
  -- so this CTE reads one case row per candidate and never scans the table.
  staff_visible as (
    select k.candidate_id
    from candidates k
    cross join lateral (
      select row_case.user_id, row_case.is_restricted, row_case.coordinator_user_id,
             row_case.organization_id, row_case.id
      from public.member_cases row_case
      where row_case.id = k.candidate_id and row_case.learning_undone_at is null
      offset 0
    ) c
    join public.member_profiles case_owner on case_owner.id = c.user_id
    where (select s.coordinator_chapters from actor_scope s) <> '{}'::text[]
      and case_owner.chapter_id = any((select s.coordinator_chapters from actor_scope s)::text[])
      and (
        not c.is_restricted
        or c.coordinator_user_id = v_actor
        or (
          c.organization_id is not null
          and c.organization_id = (select s.staff_organization from actor_scope s)
          and (select s.organization_officer from actor_scope s)
        )
        or c.id = any((select s.granted_cases from actor_scope s)::uuid[])
      )
  ),
  -- The mirror itself: mfa_assurance ANDed over the three permissive SELECT
  -- policies, the first two as column tests and the third as a semijoin.
  visible as (
    select
      k.case_hit,
      k.note_hit,
      c.id,
      c.reference,
      c.title,
      c.case_type,
      c.articles,
      c.step,
      c.status,
      c.deadline,
      c.updated_at,
      c.user_id,
      c.steward_user_id
    from candidates k
    cross join lateral (
      select
        row_case as authorization_case,
        row_case.is_restricted, row_case.organization_id, row_case.chapter_id,
        row_case.id,
        row_case.reference,
        row_case.title,
        row_case.case_type,
        row_case.articles,
        row_case.step,
        row_case.status,
        row_case.deadline,
        row_case.updated_at,
        row_case.user_id,
        row_case.steward_user_id
      from public.member_cases row_case
      where row_case.id = k.candidate_id and row_case.learning_undone_at is null
      -- `offset 0` is the standard PostgreSQL optimisation fence, and it is
      -- load-bearing rather than decorative. Without it the planner flattens
      -- this LATERAL back into an ordinary join, and because a GIN @@
      -- selectivity estimate over a CTE defaults to 200 rows it then prices a
      -- sequential scan of the whole case table plus a hash join below this
      -- primary-key lookup: measured at 79,999 rows removed by filter for a
      -- query with ONE candidate. The fence keeps the candidate list the
      -- driving relation, so the work is one primary-key probe per candidate
      -- and nothing in this function ever reads a case row the two GIN indexes
      -- did not name.
      offset 0
    ) c
    -- Preserve the established set-wise mirror for unscoped, unmarked cases.
    -- Scoped grants and private identities use the full shared row oracle;
    -- the CASE prevents expensive per-case role queries on the ordinary path.
    where (select s.mfa_satisfied from actor_scope s)
      and case when (select s.has_scoped_grants from actor_scope s)
        or c.chapter_id=any((select s.unassigned_chapters from actor_scope s)::text[])
        or exists(select 1 from private.case_identity_privacy privacy where privacy.case_id=c.id)
      then private.chapter_case_readable(c.authorization_case)
      else (
        c.user_id=v_actor
        or (c.steward_user_id=v_actor and (select s.steward_hat from actor_scope s))
        or c.id in (select candidate_id from staff_visible)
        or (not c.is_restricted and c.chapter_id=any((select s.default_steward_chapters from actor_scope s)::text[])
          and exists(select 1 from public.member_chapter_memberships member
            join public.organization_memberships om on om.user_id=member.user_id and om.organization_id=private.current_member_organization() and om.status='active'
            where member.user_id=c.user_id and member.chapter_id=c.chapter_id and member.status='active'))
      ) end
  ),
  scored as (
    select
      c.id,
      c.reference,
      c.title,
      c.case_type,
      c.articles,
      c.step,
      c.status,
      c.deadline,
      c.updated_at,
      note.body as note_body,
      pg_catalog.ts_rank(
        pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.reference, '')), 'A')
        || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.title, '')), 'A')
        || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.case_type, '')), 'B')
        || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.articles, '')), 'C'),
        v_query)
        + coalesce(note.note_rank, 0) * 0.5 as rank_value
    from visible c
    left join lateral (
      select
        n.body,
        pg_catalog.ts_rank(n.note_document, v_query) as note_rank
      from (
        select
          u.body,
          u.user_id,
          u.created_at,
          u.id,
          pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(u.body, '')) as note_document
        from public.member_case_updates u
        where c.note_hit
          and u.case_id = c.id and u.learning_undone_at is null
      ) n
      where n.note_document @@ v_query
        -- The visible parent supplies the same authorization as the scoped-parent notes policy.

      order by note_rank desc, n.created_at desc, n.id
      limit 1
    ) note on true
    -- `case_hit` is the case-document match the candidate CTE already made.
    where c.case_hit or note.body is not null
  ),
  -- Rank and cut FIRST, then build the snippets. ts_headline is by far the most
  -- expensive expression in this function and a projection is evaluated before
  -- the sort, so leaving it in `scored` would have built one snippet per
  -- visible candidate instead of at most p_limit of them.
  ranked as (
    select r.*
    from scored r
    order by r.rank_value desc, r.updated_at desc, r.id
    limit v_limit
  )
  select
    r.id,
    r.reference,
    r.title,
    r.case_type,
    r.articles,
    r.step,
    r.status,
    r.deadline,
    r.updated_at,
    r.rank_value::real,
    pg_catalog.ts_headline(
      'pg_catalog.english'::pg_catalog.regconfig,
      case
        when r.note_body is not null then r.note_body
        when coalesce(r.articles, '') <> '' then r.articles
        else r.title
      end,
      v_query,
      'StartSel="[[",StopSel="]]",MaxFragments=1,MaxWords=28,MinWords=8,ShortWord=2'),
    case
      when r.note_body is not null then 'update'
      when coalesce(r.articles, '') <> '' then 'articles'
      else 'title'
    end
  from ranked r
  order by r.rank_value desc, r.updated_at desc, r.id;
end;

end;
$function$;

CREATE OR REPLACE FUNCTION public.get_advisor_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  caller_org uuid := private.current_member_organization();
  members_covered integer;
  open_cases integer;
  resolved_cases integer;
  overdue_cases integer;
  steward_count integer;
  turnout jsonb;
  mfa_ok boolean := false;
  mobile_org uuid;
  elevated_org uuid;
  caller_has_scopes boolean := false;
  staff_chapters text[] := '{}'::text[];
  coordinator_ids uuid[] := '{}'::uuid[];
begin
  if caller is null or not public.member_has_role(array['advisor', 'admin']) then
    raise exception 'advisor role required' using errcode = '42501';
  end if;
  -- A legacy advisor on an ownerless chapter resolves no organization; only a
  -- platform caller is refused, and only platform-owned rows leave the totals.
  if private.organization_is_platform(caller_org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  -- The selected workspace, never a NULL legacy role row, sets the scope.
  -- Keep an explicitly selected ownerless legacy chapter isolated as well.
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null or not exists (
    select 1 from public.chapters chapter where chapter.id = caller_chapter
      and chapter.organization_id is not distinct from caller_org
  ) then
    raise exception 'organization or legacy chapter required' using errcode = '42501';
  end if;

  -- Caller-constant half of the staff case read. SQL CASE below stops before
  -- the coordinator and grievance branches when an elevated organization role
  -- already admits the row, which is the desk that was paying once per case.
  mfa_ok := private.mfa_satisfied();
  mobile_org := private.current_mobile_staff_organization();
  if mobile_org is not null
    and private.has_organization_role(mobile_org, array['advisor', 'admin', 'vp']) then
    elevated_org := mobile_org;
  end if;
  caller_has_scopes := exists (
    select 1 from (select * from private.steward_assignment_scopes(caller,null) where not legacy_chapter_coverage) scope_row
    where scope_row.user_id = caller
  );
  select coalesce(pg_catalog.array_agg(chapter.id), '{}'::text[])
    into staff_chapters
  from public.chapters chapter
  where private.actor_has_chapter_staff_role(caller, chapter.id);
  select coalesce(pg_catalog.array_agg(visible.id), '{}'::uuid[])
    into coordinator_ids
  from private.staff_visible_member_ids('coordinator') visible(id);

  select pg_catalog.count(*)
  into members_covered
  from (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p
  where p.chapter_id = caller_chapter
    and not private.chapter_belongs_to_platform(p.chapter_id);

  with base as materialized (
    select c.status, c.deadline
    from public.member_cases c
    join (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p on p.id = c.user_id
    where c.organization_id is not distinct from caller_org
      and c.chapter_id = caller_chapter
      and not private.organization_is_platform(c.organization_id)
      and (
        (c.organization_id is null and caller_org is null)
        or (
          c.learning_undone_at is null
          and mfa_ok
          and case
            when c.user_id = caller then true
            when c.organization_id is not null
              and c.chapter_id is not null
              and case
                when c.user_id = caller then true
                when not caller_has_scopes
                  and not exists (
                    select 1 from private.case_identity_privacy privacy
                    where privacy.case_id = c.id
                  )
                  then true
                else private.actor_case_scope_and_identity_allowed(caller, c)
              end
              and case
                when c.chapter_id = any (staff_chapters)
                  and (
                    c.steward_user_id = caller
                    or c.coordinator_user_id = caller
                    or (elevated_org is not null and c.organization_id = elevated_org)
                    or c.user_id = any (coordinator_ids)
                  )
                  and (
                    not c.is_restricted
                    or c.steward_user_id = caller
                    or c.coordinator_user_id = caller
                    or (elevated_org is not null and c.organization_id = elevated_org)
                    or private.casework_actor_has_active_grant(c.id)
                  )
                  then true
                when c.organization_id = caller_org
                  and private.actor_role_covers_member(caller, c.chapter_id, 'coordinator', c.user_id, true)
                  and (
                    not c.is_restricted
                    or c.coordinator_user_id = caller
                    or private.casework_actor_has_active_grant(c.id)
                  )
                  then true
                else false
              end
              then true
            when c.user_id <> caller
              and not c.is_restricted
              and c.organization_id = caller_org
              and coalesce((select policy.steward_grievances from private.chapter_access_policies policy where policy.chapter_id = c.chapter_id), true)
              and private.chapter_grievance_steward_scope(c.chapter_id, c.user_id)
              and private.member_case_row_visible(c)
              then true
            else false
          end
        )
      )
  )
  select
    pg_catalog.count(*) filter (where b.status = 'active'),
    pg_catalog.count(*) filter (where b.status = 'resolved'),
    pg_catalog.count(*) filter (where b.status = 'active'
      and b.deadline is not null
      and b.deadline < current_date)
  into open_cases, resolved_cases, overdue_cases
  from base b;

  -- Resolve chapter and organization grants through the same live scope
  -- projection as the staff roster. Membership in a second tenant never
  -- transfers a steward grant there.
  if caller_org is not null then
    select pg_catalog.count(*) into steward_count
    from public.organization_memberships membership
    where membership.organization_id = caller_org and membership.status = 'active'
      and private.organization_member_roles(membership.user_id, caller_org, caller_chapter) @> '["steward"]'::jsonb;
  else
    -- No organization-wide NULL role can be attributed to an ownerless
    -- chapter. Its exact chapter steward remains valid, including #6369.
    select pg_catalog.count(distinct r.user_id) into steward_count
    from public.member_roles r
    where r.role = 'steward' and r.chapter_id = caller_chapter;
  end if;

  select pg_catalog.jsonb_build_object(
      'title', b.title,
      'totalVotes', v.n,
      'quorumTarget', b.quorum_target)
  into turnout
  from public.member_ballots b
  left join lateral (
    select pg_catalog.count(*) as n
    from public.member_ballot_choices
    where ballot_id = b.id
  ) v on true
  where (b.active = false or b.closes_at < pg_catalog.now())
    and b.organization_id is not distinct from caller_org
    and (b.chapter_id = caller_chapter or (caller_org is not null and b.chapter_id is null))
    and b.campaign_state <> 'draft'
    and not private.organization_is_platform(b.organization_id)
  order by b.closes_at desc, b.id
  limit 1;

  return pg_catalog.jsonb_build_object(
    'membersCovered', members_covered,
    'openGrievances', open_cases,
    'resolvedGrievances', resolved_cases,
    'stewardCount', steward_count,
    'coverageRatio', case when steward_count = 0 then null
      else pg_catalog.round(members_covered::numeric / steward_count) end,
    'resolutionRate', case when open_cases + resolved_cases = 0 then null
      else pg_catalog.round(100.0 * resolved_cases / (open_cases + resolved_cases)) end,
    'turnout', turnout,
    'atRisk', pg_catalog.jsonb_build_object(
      'overdueCases', overdue_cases,
      'unstaffed', steward_count = 0));
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_vp_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid;
  caller_chapter text;
  member_count integer;
  new_this_year integer;
  active_grievances integer;
  turnout jsonb;
  attention jsonb;
  upcoming jsonb;
  priorities jsonb;
  trend jsonb;
  leadership_open boolean := false;
  caller_has_scopes boolean := false;
begin
  if caller is null or not public.member_has_role(array['vp', 'admin']) then
    raise exception 'vp role required' using errcode = '42501';
  end if;

  -- Fail closed: no selected organization or chapter means no tenant to
  -- report on, never a database-wide scan.
  caller_org := private.current_member_organization();
  caller_chapter := private.current_member_chapter();
  if caller_org is null or caller_chapter is null then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if not private.organization_is_union(caller_org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  -- The leadership read's caller-constant gates, once for this statement. The
  -- outer reads already require the case organization and chapter to be the
  -- caller's, so the role and staff-factor checks do not vary per case. A
  -- closed gate is zero grievances and an empty attention list.
  leadership_open := private.mfa_satisfied()
    and not private.member_pin_session_restricted()
    and (not private.staff_mfa_required(caller_org) or private.has_second_factor(caller))
    and (
      private.member_has_chapter_role(caller_chapter, array['admin', 'vp'])
      or private.has_organization_role(caller_org, array['admin', 'vp'])
    );
  caller_has_scopes := exists (
    select 1 from (select * from private.steward_assignment_scopes(caller,null) where not legacy_chapter_coverage) scope_row
    where scope_row.user_id = caller
  );

  select
    pg_catalog.count(*),
    pg_catalog.count(*) filter (where p.member_since = pg_catalog.date_part('year', pg_catalog.now())::int)
  into member_count, new_this_year
  from (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p
  where p.chapter_id = caller_chapter;

  if leadership_open then
    select pg_catalog.count(*)
    into active_grievances
    from public.member_cases c
    where c.status = 'active'
      and c.organization_id is not null
      and c.learning_undone_at is null
      and case
        when c.user_id = caller then true
        when not caller_has_scopes
          and not exists (
            select 1 from private.case_identity_privacy privacy
            where privacy.case_id = c.id
          )
          then true
        else private.actor_case_scope_and_identity_allowed(caller, c)
      end
      and c.organization_id = caller_org
      and c.chapter_id = caller_chapter;

    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', s.id,
        'reference', s.reference,
        'title', s.title,
        'step', s.step,
        'deadline', s.deadline,
        'memberName', s.member_name) order by s.deadline, s.id), '[]'::jsonb)
    into attention
    from (
      select c.id, c.reference, c.title, c.step, c.deadline, p.full_name as member_name
      from public.member_cases c
      join (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p on p.id = c.user_id
      where c.status = 'active'
        and c.deadline is not null
        and c.deadline < current_date
        and c.organization_id is not null
        and c.chapter_id is not null
        and c.learning_undone_at is null
        and case
          when c.user_id = caller then true
          when not caller_has_scopes
            and not exists (
              select 1 from private.case_identity_privacy privacy
              where privacy.case_id = c.id
            )
            then true
          else private.actor_case_scope_and_identity_allowed(caller, c)
        end
        and c.organization_id = caller_org
        and c.chapter_id = caller_chapter
      order by c.deadline
      limit 6
    ) s;
  else
    active_grievances := 0;
    attention := '[]'::jsonb;
  end if;

  select pg_catalog.jsonb_build_object(
      'title', b.title,
      'totalVotes', v.n,
      'quorumTarget', b.quorum_target)
  into turnout
  from public.member_ballots b
  left join lateral (
    select pg_catalog.count(*) as n
    from public.member_ballot_choices
    where ballot_id = b.id
  ) v on true
  where (b.active = false or b.closes_at < pg_catalog.now())
    and b.campaign_state <> 'draft'
    and b.organization_id = caller_org
    and (b.chapter_id is null or b.chapter_id = caller_chapter)
  order by b.closes_at desc
  limit 1;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', e.id,
      'title', e.title,
      'startsAt', e.starts_at,
      'location', e.location,
      'summary', e.summary) order by e.starts_at, e.id), '[]'::jsonb)
  into upcoming
  from (
    select ev.id, ev.title, ev.starts_at, ev.location, ev.summary
    from public.member_events ev
    join public.chapters event_chapter
      on event_chapter.id = ev.chapter_id
     and event_chapter.organization_id = caller_org
    where ev.starts_at >= pg_catalog.now()
      and ev.cancelled_at is null
      and private.member_event_scope_allows(
        (select private.member_event_caller_scope()),
        ev.chapter_id,
        ev.is_public,
        ev.is_public_across_agencies)
    order by ev.starts_at
    limit 5
  ) e;

  -- The aggregate-level ORDER BY is the guarantee; the subquery's ORDER BY
  -- only picks WHICH 8 survive the limit.
  select coalesce(pg_catalog.jsonb_agg(x.obj order by x.order_index), '[]'::jsonb)
  into priorities
  from (
    select pg_catalog.jsonb_build_object('id', id, 'title', title, 'kind', 'ballot') as obj, order_index
    from public.member_ballots
    where active = true
      and campaign_state <> 'draft'
      and organization_id = caller_org
      and (chapter_id is null or chapter_id = caller_chapter)
    union all
    select pg_catalog.jsonb_build_object('id', id, 'title', title, 'kind', 'survey'), order_index
    from public.member_surveys
    where active = true
      and campaign_state <> 'draft'
      and organization_id = caller_org
      and (chapter_id is null or chapter_id = caller_chapter)
    order by order_index
    limit 8
  ) x;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'year', y.yr, 'count', y.cumulative) order by y.yr), '[]'::jsonb)
  into trend
  from (
    select g.yr, pg_catalog.sum(g.n) over (order by g.yr) as cumulative
    from (
      select p.member_since as yr, pg_catalog.count(*) as n
      from (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p
      where p.chapter_id = caller_chapter
      group by p.member_since
    ) g
  ) y
  where y.yr >= pg_catalog.date_part('year', pg_catalog.now())::int - 5;

  return pg_catalog.jsonb_build_object(
    'memberCount', member_count,
    'newThisYear', new_this_year,
    'activeGrievances', active_grievances,
    'turnout', turnout,
    'attention', attention,
    'upcomingEvents', upcoming,
    'priorities', priorities,
    'membershipTrend', trend);
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_organization_analytics_workspace()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph_read();
  perform private.member_pin_require_full_session();
declare
  org uuid := private.mi1_require_selected_organization();
  generated timestamptz := pg_catalog.now();
  privacy_threshold integer := private.organization_limit(org, 'limits.analytics.anonymity_floor');
  health_threshold integer := private.organization_limit(org, 'limits.analytics.chapter_health_cohort_floor');
  actor uuid := (select auth.uid());
  may_read_unassigned boolean;
  scoped_actor boolean;
  default_steward_chapters text[];
  org_case_reader boolean;
  staff_chapters text[];
  roster_limited boolean;
  roster_chapters text[];
begin
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if org is null then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Necessary candidate condition only, never an authorization result.
  -- Deliberately retain roles in ANY tenant/chapter (including inactive or
  -- otherwise unusable grants): false positives still reach the shared final
  -- predicate. All current organization, chapter and legacy role sources are
  -- included. Assignment is checked per case below.
  may_read_unassigned := exists (
    select 1 from public.organization_role_grants g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  ) or exists (
    select 1 from public.member_role_chapters g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  ) or exists (
    select 1 from public.member_roles g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  );

  -- Cached ordinary-steward authorization. The enclosing roster query
  -- already proves the target's active chapter and organization memberships.
  -- Scoped actors, private identities and legacy exceptions use the oracle.
  scoped_actor := exists(select 1 from (select * from private.steward_assignment_scopes(actor,null) where not legacy_chapter_coverage) scope where scope.user_id=actor);
  default_steward_chapters := array(
        select ch.id from public.chapters ch
        left join private.chapter_access_policies target_policy on target_policy.chapter_id=ch.id
        where ch.organization_id=org
          and coalesce(target_policy.steward_grievances,true)
          and (not private.staff_mfa_required(ch.organization_id) or private.has_second_factor(actor))
          and (private.chapter_organization_role_allowed(ch.id,array['steward'])
            or private.member_has_chapter_role(ch.id,array['steward'])
            or exists(select 1 from public.member_role_chapters r
              join public.chapters source on source.id=r.chapter_id and source.organization_id=ch.organization_id
              join public.member_chapter_memberships source_member on source_member.chapter_id=r.chapter_id and source_member.user_id=r.user_id and source_member.status='active'
              join private.chapter_access_policies policy on policy.chapter_id=r.chapter_id and policy.steward_breadth='local' and policy.steward_grievances
              where r.user_id=actor and r.role='steward' and private.member_has_chapter_role(r.chapter_id,array['steward'])))
      );

  -- BUG-UG-SAMPLE-ANALYTICS-PANELS-TIME-OUT-20261030: for an
  -- organization advisor, administrator or leader, every per-case clause of
  -- private.casework_staff_can_access except the chapter staff-role test is
  -- already met by that organization role, so the per-case call (about 16 ms
  -- each at Tamarack scale, one per active case) reduces to membership in
  -- the chapters where private.actor_has_chapter_staff_role holds. Both are
  -- read once here, after lock_case_graph_read, with the same helpers and
  -- arguments the shared predicate uses; every other caller keeps the shared
  -- predicate per case.
  -- Scoped access: the shortcut applies only to an unscoped actor and a case
  -- with no identity privacy, where private.case_scope_and_identity_allowed
  -- is already true; every other case keeps the read oracle below.
  org_case_reader := private.has_organization_role(org, array['advisor','admin','vp']);
  -- #8589 rounds 1-2: a caller admitted only by an organization steward
  -- grant sees named members only where an assignment covers them: whole
  -- chapters for steward carry-over and for live, unscoped chapter-level
  -- higher roles; otherwise the unit, default-unit or committee members of
  -- each scoped steward, coordinator or advisor assignment; and themselves.
  roster_limited := not private.has_organization_role(org, array['coordinator','advisor','admin','vp']);
  roster_chapters := array(
    select scope.chapter_id from private.steward_assignment_scopes(actor,null) scope
    where roster_limited and scope.role='steward' and scope.legacy_chapter_coverage
    union
    select grant_row.chapter_id from public.member_role_chapters grant_row
    join public.chapters chapter on chapter.id=grant_row.chapter_id and chapter.organization_id=org
    join public.member_chapter_memberships membership on membership.user_id=grant_row.user_id
      and membership.chapter_id=grant_row.chapter_id and membership.status='active'
    where roster_limited and grant_row.user_id=actor and grant_row.role=any(array['coordinator','advisor','admin','vp'])
      and not exists(select 1 from private.chapter_role_scopes scope
        where scope.user_id=grant_row.user_id and scope.chapter_id=grant_row.chapter_id and scope.role=grant_row.role));
  select coalesce(pg_catalog.array_agg(c.id), array[]::text[]) into staff_chapters
  from public.chapters c
  where c.organization_id = org
    and private.actor_has_chapter_staff_role(actor, c.id);

  perform private.mi1_write_tenant_audit(org, 'analytics_snapshot_read', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surface', 'analytics_parity_workspace'
  ));

  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'generatedAt', generated,
    'privacyThreshold', privacy_threshold,
    'chapterHealthFloor', health_threshold,
    'members', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org,
        'id', m.user_id::text || ':' || m.chapter_id,
        'name', p.full_name,
        'chapterId', c.id,
        'chapterName', c.name,
        'participationScore', case when privacy.shown then least(100, activity.event_count * 10) end,
        'profileReadiness', case when privacy.shown then
          (case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end) + 50 end,
        'followThrough', case when privacy.shown then least(100, activity.follow_count * 20) end,
        'overallScore', case when privacy.shown then pg_catalog.round((
          least(100, activity.event_count * 10)
          + ((case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end) + 50)
          + least(100, activity.follow_count * 20)
        )::numeric / 3) end,
        'scoreHidden', not privacy.shown,
        'attention', case
          when cases.overdue_cases > 0 then 'urgent'
          when not privacy.shown then null
          when activity.event_count = 0 then 'support'
          when activity.event_count < 5 then 'watch'
          else 'steady'
        end,
        'activeCases', cases.active_cases,
        'overdueCases', cases.overdue_cases,
        'lastActivityAt', case when privacy.shown then activity.last_activity end
      ) order by c.name, p.full_name, m.user_id)
      from public.member_chapter_memberships m
      join public.chapters c on c.id = m.chapter_id and c.organization_id = org
      join public.organization_memberships om
        on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
      join public.member_profiles p on p.id = m.user_id
      -- #6774: a member who hides their Pulse score keeps their row; only the
      -- activity-derived fields are withheld, and their activity is not read.
      cross join lateral (select p.pulse_score_visible or m.user_id = actor as shown) privacy
      cross join lateral (
        select
          pg_catalog.count(*)::integer as event_count,
          pg_catalog.count(*) filter (
            where e.event_type in ('authorized_contact', 'survey_response', 'event_rsvp')
              and e.occurred_at >= generated - interval '90 days'
          )::integer as follow_count,
          pg_catalog.max(e.occurred_at) as last_activity
        from public.organization_engagement_events e
        where privacy.shown
          and e.organization_id = org
          and e.user_id = m.user_id
          -- Preserve train 2a participation semantics: page views are telemetry.
          and e.event_type <> 'page_view'
          and e.occurred_at >= generated - interval '180 days'
      ) activity
      cross join lateral (
        select
          pg_catalog.count(*) filter (where cs.status = 'active')::integer as active_cases,
          pg_catalog.count(*) filter (
            where cs.status = 'active' and cs.deadline < generated::date
          )::integer as overdue_cases
        from public.member_cases cs
        where cs.organization_id = org
          and cs.chapter_id = c.id
          and cs.user_id = m.user_id
          and cs.status = 'active'
          and case
            when org_case_reader and not scoped_actor
              and cs.chapter_id = any(staff_chapters)
              and (may_read_unassigned or cs.steward_user_id=actor or cs.coordinator_user_id=actor
                or cs.chapter_id=any(default_steward_chapters))
              and not exists(select 1 from private.case_identity_privacy privacy where privacy.case_id=cs.id)
            then true
            when not scoped_actor and not cs.is_restricted and cs.user_id<>actor
              and cs.chapter_id=any(default_steward_chapters)
              and not exists(select 1 from private.case_identity_privacy privacy where privacy.case_id=cs.id)
            then true
            else case when may_read_unassigned or cs.steward_user_id=actor or cs.coordinator_user_id=actor
                or cs.chapter_id=any(default_steward_chapters)
              then private.casework_staff_can_read(cs.id) else false end
          end
      ) cases
      where m.status = 'active'
        and (not roster_limited or m.user_id = actor or m.chapter_id = any(roster_chapters)
          or exists(select 1 from (
              select steward_scope.unit_id,steward_scope.committee_id
              from private.steward_assignment_scopes(actor,m.chapter_id) steward_scope
              where steward_scope.role='steward' and not steward_scope.legacy_chapter_coverage and steward_scope.chapter_id=m.chapter_id
              union all
              select role_scope.unit_id,role_scope.committee_id
              from private.chapter_role_scopes role_scope
              join public.member_role_chapters grant_row on grant_row.user_id=role_scope.user_id
                and grant_row.chapter_id=role_scope.chapter_id and grant_row.role=role_scope.role
              join public.member_chapter_memberships membership on membership.user_id=role_scope.user_id
                and membership.chapter_id=role_scope.chapter_id and membership.status='active'
              where role_scope.user_id=actor and role_scope.chapter_id=m.chapter_id
                and role_scope.role=any(array['coordinator','advisor'])) scope
            where ((scope.unit_id is not null and (
                  exists(select 1 from private.chapter_unit_members physical
                    where physical.unit_id=scope.unit_id and physical.chapter_id=m.chapter_id and physical.user_id=m.user_id)
                  or (exists(select 1 from private.chapter_units unit
                      where unit.id=scope.unit_id and unit.chapter_id=m.chapter_id and unit.is_default)
                    and not exists(select 1 from private.chapter_unit_members physical
                      where physical.user_id=m.user_id and physical.chapter_id=m.chapter_id))))
                or (scope.committee_id is not null and exists(select 1 from private.chapter_committees committee
                  join private.chapter_committee_members member on member.committee_id=committee.id and member.chapter_id=committee.chapter_id
                  where committee.id=scope.committee_id and committee.chapter_id=m.chapter_id and member.user_id=m.user_id
                    and committee.starts_on<=current_date and (committee.ends_on is null or committee.ends_on>=current_date))))))
    ), '[]'::jsonb),
    'chapterHealth', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org,
        'chapterId', c.id,
        'chapterName', c.name,
        'memberCount', totals.member_count,
        'protected', totals.member_count < health_threshold
          or (latest.id is not null and latest.member_count < health_threshold),
        'score', case when totals.member_count >= health_threshold and latest.member_count >= health_threshold
          then latest.score else null end,
        'drivers', case when totals.member_count >= health_threshold and latest.member_count >= health_threshold
          then pg_catalog.jsonb_build_object(
            'participation', latest.participation,
            'caseTimeliness', latest.case_timeliness,
            'stewardCapacity', latest.steward_capacity,
            'trainingCoverage', latest.training_coverage,
            'communicationReach', latest.communication_reach,
            'governanceReadiness', latest.governance_readiness
          ) else null end,
        'trend', case when totals.member_count >= health_threshold then coalesce(trend.points, '[]'::jsonb) else '[]'::jsonb end
      ) order by c.name)
      from public.chapters c
      cross join lateral (
        select pg_catalog.count(*)::integer as member_count
        from public.member_chapter_memberships m
        join public.organization_memberships om
          on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
        where m.chapter_id = c.id and m.status = 'active'
      ) totals
      left join lateral (
        select s.* from public.chapter_health_snapshots s
        where s.chapter_id = c.id order by s.measured_on desc limit 1
      ) latest on true
      left join lateral (
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'measuredOn', history.measured_on, 'score', history.score
        ) order by history.measured_on) as points
        from (
          select s.measured_on, s.score
          from public.chapter_health_snapshots s
          where s.chapter_id = c.id and s.member_count >= health_threshold
          order by s.measured_on desc limit 36
        ) history
      ) trend on true
      where c.organization_id = org
    ), '[]'::jsonb),
    'datasets', coalesce((
      select pg_catalog.jsonb_agg(dataset.value order by dataset.sort_key)
      from (
        select 0 as sort_key, pg_catalog.jsonb_build_object(
          'organizationId', org,
          'id', 'organization:chapter-health',
          'label', 'Chapter health',
          'description', 'Latest protected chapter health score.',
          'scope', 'organization',
          'chapterId', null,
          'rows', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'label', qualified.name, 'value', qualified.score
          ) order by qualified.name), '[]'::jsonb)
        ) as value
        from (
          select c.name, latest.score
          from public.chapters c
          cross join lateral (
            select pg_catalog.count(*)::integer as member_count
            from public.member_chapter_memberships m
            join public.organization_memberships om
              on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
            where m.chapter_id = c.id and m.status = 'active'
          ) totals
          join lateral (
            select s.score, s.member_count from public.chapter_health_snapshots s
            where s.chapter_id = c.id order by s.measured_on desc limit 1
          ) latest on true
          where c.organization_id = org and totals.member_count >= health_threshold
            and latest.member_count >= health_threshold
        ) qualified
        union all
        select 100 + c.order_index, pg_catalog.jsonb_build_object(
          'organizationId', org,
          'id', 'chapter:' || c.id || ':health-trend',
          'label', c.name || ' health trend',
          'description', 'Protected chapter score history.',
          'scope', 'chapter',
          'chapterId', c.id,
          'rows', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'label', s.measured_on::text, 'value', s.score
            ) order by s.measured_on)
            from public.chapter_health_snapshots s
            where s.chapter_id = c.id and s.member_count >= greatest(privacy_threshold, health_threshold)
          ), '[]'::jsonb)
        )
        from public.chapters c
        where c.organization_id = org
          and (select pg_catalog.count(*) from public.member_chapter_memberships m
               join public.organization_memberships om
                 on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
               where m.chapter_id = c.id and m.status = 'active') >= privacy_threshold
      ) dataset
    ), '[]'::jsonb),
    'layouts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', l.id,
        'organizationId', l.organization_id,
        'name', l.name,
        'scope', l.scope,
        'chapterId', l.chapter_id,
        'spec', l.spec,
        'canEdit', l.owner_user_id = (select auth.uid())
          or private.has_organization_role(org, array['admin']),
        'updatedAt', l.updated_at
      ) order by l.updated_at desc)
      from public.organization_analytics_layouts l
      where l.organization_id = org
        and (
          (l.scope = 'personal' and l.owner_user_id = (select auth.uid()))
          or l.scope in ('chapter', 'organization')
        )
    ), '[]'::jsonb)
  );
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.list_contract_clause_grievance_counts()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();

declare
  org uuid := private.mi1_require_selected_organization();
  v_actor uuid := (select auth.uid());
  staff boolean;
  steward_hat boolean;
  coordinator_chapters text[];
  staff_organization uuid;
  organization_officer boolean;
  granted_cases uuid[];
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- A platform organization's per-article case counts are platform results.
  if private.organization_is_platform(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  -- Same clause visibility as public.list_contract_clauses.
  staff := private.has_organization_role(
    org,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  );

  -- Caller-only inputs of the member_cases SELECT policies, resolved once.
  -- mfa_assurance is already satisfied by the gate above.
  steward_hat := coalesce(public.member_has_role(array['steward']), false);
  coordinator_chapters := array(select private.staff_visible_chapter_scope('coordinator'));
  staff_organization := private.current_mobile_staff_organization();
  organization_officer := coalesce(
    private.has_organization_role(staff_organization, array['advisor', 'admin', 'vp']),
    false
  );
  granted_cases := array(
    select g.case_id
    from public.casework_access_grants g
    where g.grantee_user_id = v_actor
      and g.revoked_at is null
  );

  -- Each visible case's articles are normalized and split into tokens ONCE,
  -- then joined to the caller-visible clause articles on equality. The
  -- 20260925110500 body re-ran the regexp_replace for every (clause, case)
  -- pair as a LIKE join filter, so its cost grew with clauses x cases.
  return coalesce((
    with actor_scope as materialized (
    select
      exists(select 1 from (select * from private.steward_assignment_scopes(v_actor,null) where not legacy_chapter_coverage) s where s.user_id=v_actor) as has_scoped_grants,
      -- #8589 stage 148: chapters where the organization steward grant is the
      -- caller's only steward authority take the shared case oracle.
      array(select ch.id from public.chapters ch
        where ch.organization_id=org
          and private.organization_steward_unassigned(v_actor,ch.id)) as unassigned_chapters,
      array(
        select ch.id from public.chapters ch
        left join private.chapter_access_policies target_policy on target_policy.chapter_id=ch.id
        where ch.organization_id=org
          and coalesce(target_policy.steward_grievances,true)
          and (not private.staff_mfa_required(ch.organization_id) or private.has_second_factor(v_actor))
          and (private.chapter_organization_role_allowed(ch.id,array['steward'])
            or private.member_has_chapter_role(ch.id,array['steward'])
            or exists(select 1 from public.member_role_chapters r
              join public.chapters source on source.id=r.chapter_id and source.organization_id=ch.organization_id
              join public.member_chapter_memberships actor on actor.chapter_id=r.chapter_id and actor.user_id=r.user_id and actor.status='active'
              join private.chapter_access_policies policy on policy.chapter_id=r.chapter_id and policy.steward_breadth='local' and policy.steward_grievances
              where r.user_id=v_actor and r.role='steward' and private.member_has_chapter_role(r.chapter_id,array['steward'])))
      ) as default_steward_chapters
    ), visible_cases as (
      select cs.id,
             ',' || pg_catalog.regexp_replace(
               pg_catalog.lower(pg_catalog.btrim(cs.articles)),
               '[[:space:]]*[,;/]+[[:space:]]*',
               ',',
               'g'
             ) || ',' as line
      from public.member_cases cs
      left join public.member_profiles case_owner
        on coordinator_chapters <> '{}'::text[]
       and case_owner.id = cs.user_id
      where cs.organization_id = org
        and cs.articles is not null
        and pg_catalog.btrim(cs.articles) <> ''
        and case when (select s.has_scoped_grants from actor_scope s)
          or cs.chapter_id=any((select s.unassigned_chapters from actor_scope s)::text[])
          or exists(select 1 from private.case_identity_privacy privacy where privacy.case_id=cs.id)
        then private.chapter_case_readable(cs)
        else (
          cs.user_id = v_actor
          or (cs.steward_user_id = v_actor and steward_hat)
          or (case_owner.chapter_id = any(coordinator_chapters) and (
            not cs.is_restricted or cs.coordinator_user_id = v_actor
            or (cs.organization_id = staff_organization and organization_officer)
            or cs.id = any(granted_cases)))
          or (not cs.is_restricted
            and cs.chapter_id=any((select s.default_steward_chapters from actor_scope s)::text[])
            and exists(select 1 from public.member_chapter_memberships member
              join public.organization_memberships om on om.user_id=member.user_id and om.organization_id=org and om.status='active'
              where member.user_id=cs.user_id and member.chapter_id=cs.chapter_id and member.status='active'))
        ) end

    ),
    case_articles as (
      select v.id as case_id, token.article
      from visible_cases v
      cross join lateral pg_catalog.unnest(
        pg_catalog.string_to_array(pg_catalog.btrim(v.line, ','), ',')
      ) as token(article)
      where token.article <> ''
    ),
    -- Counted per token before the clause join and materialized, so the join
    -- only ever sees distinct tokens: the planner cannot rescan member_cases
    -- (or re-run the regexp) once per clause article when statistics are thin.
    token_counts as materialized (
      select ca.article, pg_catalog.count(distinct ca.case_id)::integer as n
      from case_articles ca
      group by ca.article
    ),
    visible_articles as (
      select distinct pg_catalog.lower(pg_catalog.btrim(c.article)) as article
      from public.contract_clauses c
      where c.organization_id = org
        and (staff or c.status = 'published')
    )
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'article', counts.article,
      'count', counts.n
    ) order by counts.article)
    from (
      select a.article, t.n
      from visible_articles a
      join token_counts t on t.article = a.article
    ) counts
  ), '[]'::jsonb);
end;

end;
$function$;

-- #8382 shared private-message boundary plus #7663 assignment authority.
CREATE OR REPLACE FUNCTION private.staff_actor_can_see_user(p_actor uuid, p_target uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.member_profiles target
    join public.chapters target_chapter on target_chapter.id = target.chapter_id
    where target.id = p_target
      and (
        (
          target_chapter.organization_id is not null
          and exists (
            select 1
            from public.member_profiles actor_profile
            join public.chapters actor_chapter
              on actor_chapter.id = actor_profile.chapter_id
             and actor_chapter.organization_id = target_chapter.organization_id
            join public.member_chapter_memberships actor_membership
              on actor_membership.user_id = actor_profile.id
             and actor_membership.chapter_id = actor_chapter.id
             and actor_membership.status = 'active'
            where actor_profile.id = p_actor
          )
          and exists (
            select 1
            from public.organizations o
            where o.id = target_chapter.organization_id
              and o.status = 'active'
          )
          and exists (
            select 1
            from public.organization_memberships om
            where om.organization_id = target_chapter.organization_id
              and om.user_id = p_actor
              and om.status = 'active'
          )
          and (
            exists (
              select 1 from public.organization_role_grants g
              where g.organization_id = target_chapter.organization_id
                and g.user_id = p_actor
                and g.role = 'steward'
                and private.organization_steward_scope_allows(p_actor,target_chapter.id,p_target)
            )
            or exists (
              select 1
              from public.member_role_chapters rc
              join public.member_chapter_memberships cm
                on cm.user_id = rc.user_id
               and cm.chapter_id = rc.chapter_id
               and cm.status = 'active'
              where rc.user_id = p_actor
                and rc.chapter_id = target_chapter.id
                and rc.role = 'steward'
                and (
                  -- Migration-only carry-over keeps existing coverage. An explicit
                  -- unit choice is honored for chapter and organization grants.
                  not exists (
                    select 1
                    from (select * from private.steward_assignment_scopes(p_actor,target_chapter.id) where not legacy_chapter_coverage) scope
                    where scope.user_id = rc.user_id
                      and scope.chapter_id = rc.chapter_id
                      and scope.role = rc.role
                  )
                  -- A steward limited to units or committees covers only their
                  -- members (#6682), the rule row-level security applies.
                  or private.actor_role_covers_member(p_actor, target_chapter.id, 'steward', p_target)
                )
            )
          )
          and (
            not private.staff_mfa_required(target_chapter.organization_id)
            or private.has_second_factor(p_actor)
          )
        )
        or (
          target_chapter.organization_id is null
          and exists (
            select 1
            from public.member_profiles actor_profile
            left join public.chapters actor_chapter
              on actor_chapter.id = actor_profile.chapter_id
            where actor_profile.id = p_actor
              and (actor_chapter.id is null or actor_chapter.organization_id is null)
          )
          and exists (
            select 1
            from public.member_roles r
            where r.user_id = p_actor
              and r.role = 'steward'
              and (r.chapter_id is null or r.chapter_id = target_chapter.id)
          )
          and (
            not private.staff_mfa_required()
            or private.has_second_factor(p_actor)
          )
        )
      )
  );
$function$;

CREATE OR REPLACE FUNCTION public.staff_can_see_user(p_target uuid, p_role text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return (
select case
    when (select auth.uid()) is null or p_target is null or p_role is null or p_role not in ('steward','coordinator','advisor','admin','vp') then false
    when not (select private.mfa_satisfied()) then false
    else exists (
      select 1
      from public.member_profiles target
      join public.chapters target_chapter on target_chapter.id = target.chapter_id
      where target.id = p_target
        and (
          (
            target_chapter.organization_id is not null
            and target_chapter.organization_id = (select private.current_member_organization())
            and (
              (private.chapter_organization_role_allowed(target_chapter.id,array[p_role]) or (p_role='steward' and private.organization_steward_scope_allows((select auth.uid()),target_chapter.id,p_target)))
              or private.member_has_chapter_role(target_chapter.id, array[p_role])
              or exists(select 1 from (select * from private.steward_assignment_scopes((select auth.uid()),null) where not legacy_chapter_coverage) scope where scope.user_id=(select auth.uid()) and scope.role=p_role and private.chapter_scoped_role_allows(scope.chapter_id,p_role,p_target,false))
            )
          )
          or (
            target_chapter.organization_id is null
            and (select private.current_member_organization()) is null
            and exists (
              select 1
              from public.member_profiles caller_profile
              left join public.chapters caller_chapter
                on caller_chapter.id = caller_profile.chapter_id
              where caller_profile.id = (select auth.uid())
                and (caller_chapter.id is null or caller_chapter.organization_id is null)
            )
            and (
              not (select private.staff_mfa_required())
              or (select private.has_second_factor((select auth.uid())))
            )
            and exists (
              select 1
              from public.member_roles r
              where r.user_id = (select auth.uid())
                and r.role = p_role
                and (
                  r.chapter_id is null
                  or exists (
                    select 1
                    from public.member_role_chapters rc
                    join public.member_chapter_memberships m
                      on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id
                    join public.chapters mapped on mapped.id = rc.chapter_id
                    where rc.user_id = r.user_id
                      and rc.role = r.role
                      and rc.chapter_id = target.chapter_id
                      and mapped.organization_id is null
                      and m.status = 'active'
                  )
                )
            )
          )
        )
    )
  end
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.chapter_scoped_role_allows(p_chapter text, p_role text, p_target uuid, p_grievance boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (select auth.uid()) is not null and private.mfa_satisfied() and not private.member_pin_session_restricted()
    and exists (
      select 1 from private.steward_assignment_scopes((select auth.uid()),p_chapter) s
      join public.chapters c on c.id=s.chapter_id and c.organization_id=private.current_member_organization()
      join public.member_profiles target_profile on target_profile.id=p_target
      join public.chapters target_context on target_context.id=target_profile.chapter_id and target_context.organization_id=c.organization_id
      left join public.member_chapter_memberships actor on actor.user_id=s.user_id and actor.chapter_id=s.chapter_id and actor.status='active'
      join public.member_chapter_memberships target on target.user_id=p_target and target.chapter_id=s.chapter_id and target.status='active'
      join public.organization_memberships ao on ao.user_id=s.user_id and ao.organization_id=c.organization_id and ao.status='active'
      join public.organization_memberships mo on mo.user_id=p_target and mo.organization_id=c.organization_id and mo.status='active'
      where s.user_id=(select auth.uid()) and s.chapter_id=p_chapter and s.role=p_role
        and (actor.user_id is not null or (p_role='steward' and exists(select 1 from public.organization_role_grants grant_row where grant_row.organization_id=c.organization_id and grant_row.user_id=s.user_id and grant_row.role='steward')))
        and (not private.staff_mfa_required(c.organization_id) or private.has_second_factor((select auth.uid())))
        and (
          s.legacy_chapter_coverage or (s.unit_id is not null and private.chapter_unit_has_member(s.unit_id,s.chapter_id,p_target))
          or (s.committee_id is not null and exists (
            select 1 from private.chapter_committees cm
            join private.chapter_committee_members member on member.committee_id=cm.id and member.chapter_id=cm.chapter_id
            where cm.id=s.committee_id and cm.chapter_id=s.chapter_id and member.user_id=p_target
              and cm.starts_on<=current_date and (cm.ends_on is null or cm.ends_on>=current_date)
              and (not p_grievance or cm.grievance_access)
          ))
        )
    );
$function$;

CREATE OR REPLACE FUNCTION private.chapter_scope_member_allowed(p_chapter text, p_unit uuid, p_committee uuid, p_member uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists(select 1 from public.member_chapter_memberships member
    join public.chapters c on c.id=member.chapter_id and c.organization_id=private.current_member_organization()
    join public.organization_memberships om on om.organization_id=c.organization_id and om.user_id=member.user_id and om.status='active'
    where member.user_id=p_member and member.chapter_id=p_chapter and member.status='active' and (
      (p_unit is null and p_committee is null)
      or private.chapter_unit_has_member(p_unit,p_chapter,p_member)
      or exists(select 1 from private.chapter_committees committee
        join private.chapter_committee_members m on m.committee_id=committee.id and m.chapter_id=committee.chapter_id
        where committee.id=p_committee and committee.chapter_id=p_chapter and m.user_id=p_member
          and committee.starts_on<=current_date and (committee.ends_on is null or committee.ends_on>=current_date))));
$function$;

CREATE OR REPLACE FUNCTION private.chapter_scope_recipient_allowed(p_chapter text, p_unit uuid, p_committee uuid, p_member uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists(select 1 from public.member_chapter_memberships member
    join public.chapters c on c.id=member.chapter_id
    join public.organizations o on o.id=c.organization_id and o.status='active'
    join public.organization_memberships om on om.organization_id=c.organization_id and om.user_id=member.user_id and om.status='active'
    where member.user_id=p_member and member.chapter_id=p_chapter and member.status='active' and (
      (p_unit is null and p_committee is null)
      or private.chapter_unit_has_member(p_unit,p_chapter,p_member)
      or exists(select 1 from private.chapter_committees committee
        join private.chapter_committee_members m on m.committee_id=committee.id and m.chapter_id=committee.chapter_id
        where committee.id=p_committee and committee.chapter_id=p_chapter and m.user_id=p_member
          and committee.starts_on<=current_date and (committee.ends_on is null or committee.ends_on>=current_date))));
$function$;

CREATE OR REPLACE FUNCTION private.member_scoped_notice_in_audience(p_user uuid, p_notice member_broadcasts)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select private.member_notice_in_audience(p_user,p_notice.organization_id,p_notice.chapter_id,p_notice.audience_scope)
    and ((p_notice.access_unit_id is null and p_notice.access_committee_id is null)
      or private.chapter_unit_has_member(p_notice.access_unit_id,p_notice.chapter_id,p_user)
      or exists(select 1 from private.chapter_committees c join private.chapter_committee_members m on m.committee_id=c.id and m.chapter_id=c.chapter_id
        where c.id=p_notice.access_committee_id and c.chapter_id=p_notice.chapter_id and m.user_id=p_user and c.starts_on<=current_date and (c.ends_on is null or c.ends_on>=current_date)));
$function$;

CREATE OR REPLACE FUNCTION public.get_broadcast_read_counts()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  result jsonb;
  publisher_org uuid := private.current_member_organization();
begin
  if (select auth.uid()) is null
     or not (private.member_has_chapter_role(private.current_member_chapter(), array['steward', 'admin', 'vp']) or private.chapter_office_role_present(private.current_member_chapter(),'notices')) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if publisher_org is null then
    return '[]'::jsonb;
  end if;

  with readable as materialized (
    
    
    select b.id, b.published_at, b.chapter_id, b.audience_scope, b.access_unit_id, b.access_committee_id
    from public.member_broadcasts b
    where b.organization_id = publisher_org
      and b.id in (select private.visible_member_broadcast_ids())
  ),
  publisher_scope as materialized (
    
    select s.chapter_id, s.access_unit_id, s.access_committee_id,
      (private.member_has_chapter_role(s.chapter_id,array['steward','admin','vp']) or private.chapter_officer_can_for_scope(s.chapter_id,'notices',s.access_unit_id,s.access_committee_id)) as allowed
    from (
      select distinct readable.chapter_id, readable.access_unit_id, readable.access_committee_id
      from readable
      where readable.audience_scope = 'chapter'
    ) s
  ),
  organization_publisher as materialized (
    select private.has_organization_role(publisher_org,array['steward','admin','vp']) as allowed
  ),
  recent as materialized (
    select b.id, b.published_at, b.chapter_id, b.audience_scope, b.access_unit_id, b.access_committee_id
    from readable b
    left join publisher_scope s
      on b.audience_scope = 'chapter'
     and s.chapter_id = b.chapter_id
     and s.access_unit_id is not distinct from b.access_unit_id
     and s.access_committee_id is not distinct from b.access_committee_id
    cross join organization_publisher o
    where (b.audience_scope = 'chapter' and s.allowed) or (b.audience_scope = 'organization' and o.allowed)
    order by b.published_at desc
    limit 20
  ),
  reads as (
    
    
    select b.id, pg_catalog.count(*) as read_count
    from recent b
    join public.member_broadcast_receipts r on r.broadcast_id = b.id
    where exists (
        select 1
        from public.organization_memberships om
        where om.user_id = r.user_id
          and om.organization_id = publisher_org
          and om.status = 'active'
      )
      and (
        b.audience_scope = 'organization'
        or exists (
          select 1
          from public.member_chapter_memberships m
          where m.user_id = r.user_id
            and m.chapter_id = b.chapter_id
            and m.status = 'active'
        )
      )
      and (
        (b.access_unit_id is null and b.access_committee_id is null)
        or (exists (
          select 1
          from private.chapter_unit_members m
          where m.unit_id = b.access_unit_id
            and m.chapter_id = b.chapter_id
            and m.user_id = r.user_id
        ) or exists(select 1 from private.chapter_units default_unit where default_unit.id=b.access_unit_id and default_unit.chapter_id=b.chapter_id and default_unit.is_default and not exists(select 1 from private.chapter_unit_members physical_unit_member where physical_unit_member.chapter_id=b.chapter_id and physical_unit_member.user_id=r.user_id)))
        or exists (
          select 1
          from private.chapter_committees c
          join private.chapter_committee_members m on m.committee_id = c.id and m.chapter_id = c.chapter_id
          where c.id = b.access_committee_id
            and c.chapter_id = b.chapter_id
            and m.user_id = r.user_id
            and c.starts_on <= current_date
            and (c.ends_on is null or c.ends_on >= current_date)
        )
      )
    group by b.id
  )
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'broadcastId', recent.id,
      'readCount', coalesce(reads.read_count, 0)
    ) order by recent.published_at desc
  ), '[]'::jsonb)
  into result
  from recent
  left join reads on reads.id = recent.id;

  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_broadcast_read_counts_for(p_broadcast_ids text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  result jsonb;
  publisher_org uuid := private.current_member_organization();
begin
  if (select auth.uid()) is null
     or not (private.member_has_chapter_role(private.current_member_chapter(), array['steward', 'admin', 'vp']) or private.chapter_office_role_present(private.current_member_chapter(),'notices')) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_broadcast_ids is null
     or pg_catalog.cardinality(p_broadcast_ids) < 1
     or pg_catalog.cardinality(p_broadcast_ids) > 100 then
    raise exception 'between 1 and 100 broadcast ids' using errcode = '22023';
  end if;
  if publisher_org is null then
    return '[]'::jsonb;
  end if;

  with readable as materialized (
    
    
    select b.id, b.published_at, b.chapter_id, b.audience_scope, b.access_unit_id, b.access_committee_id
    from public.member_broadcasts b
    where b.id = any(p_broadcast_ids)
      and b.organization_id = publisher_org
      and b.id in (select private.visible_member_broadcast_ids())
  ),
  publisher_scope as materialized (
    
    select s.chapter_id, s.access_unit_id, s.access_committee_id,
      (private.member_has_chapter_role(s.chapter_id,array['steward','admin','vp']) or private.chapter_officer_can_for_scope(s.chapter_id,'notices',s.access_unit_id,s.access_committee_id)) as allowed
    from (
      select distinct readable.chapter_id, readable.access_unit_id, readable.access_committee_id
      from readable
      where readable.audience_scope = 'chapter'
    ) s
  ),
  organization_publisher as materialized (
    select private.has_organization_role(publisher_org,array['steward','admin','vp']) as allowed
  ),
  asked as materialized (
    select b.id, b.published_at, b.chapter_id, b.audience_scope, b.access_unit_id, b.access_committee_id
    from readable b
    left join publisher_scope s
      on b.audience_scope = 'chapter'
     and s.chapter_id = b.chapter_id
     and s.access_unit_id is not distinct from b.access_unit_id
     and s.access_committee_id is not distinct from b.access_committee_id
    cross join organization_publisher o
    where (b.audience_scope = 'chapter' and s.allowed) or (b.audience_scope = 'organization' and o.allowed)
  ),
  reads as (
    
    
    select b.id, pg_catalog.count(*) as read_count
    from asked b
    join public.member_broadcast_receipts r on r.broadcast_id = b.id
    where exists (
        select 1
        from public.organization_memberships om
        where om.user_id = r.user_id
          and om.organization_id = publisher_org
          and om.status = 'active'
      )
      and (
        b.audience_scope = 'organization'
        or exists (
          select 1
          from public.member_chapter_memberships m
          where m.user_id = r.user_id
            and m.chapter_id = b.chapter_id
            and m.status = 'active'
        )
      )
      and (
        (b.access_unit_id is null and b.access_committee_id is null)
        or (exists (
          select 1
          from private.chapter_unit_members m
          where m.unit_id = b.access_unit_id
            and m.chapter_id = b.chapter_id
            and m.user_id = r.user_id
        ) or exists(select 1 from private.chapter_units default_unit where default_unit.id=b.access_unit_id and default_unit.chapter_id=b.chapter_id and default_unit.is_default and not exists(select 1 from private.chapter_unit_members physical_unit_member where physical_unit_member.chapter_id=b.chapter_id and physical_unit_member.user_id=r.user_id)))
        or exists (
          select 1
          from private.chapter_committees c
          join private.chapter_committee_members m on m.committee_id = c.id and m.chapter_id = c.chapter_id
          where c.id = b.access_committee_id
            and c.chapter_id = b.chapter_id
            and m.user_id = r.user_id
            and c.starts_on <= current_date
            and (c.ends_on is null or c.ends_on >= current_date)
        )
      )
    group by b.id
  )
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'broadcastId', b.id,
      'readCount', coalesce(reads.read_count, 0)
    ) order by b.published_at desc
  ), '[]'::jsonb)
  into result
  from asked b
  left join reads on reads.id = b.id;

  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION private.chapter_scoped_member_ids(p_role text)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- Relational equivalent of the enumeration filtered by
  -- chapter_scoped_role_allows(chapter_id,p_role,user_id,false). Keep the
  -- enumeration and qualifying scopes independent: EXISTS may authorize a
  -- candidate through another matching assignment. Caller/scope gates are
  -- evaluated once, with every target-side membership and container gate
  -- retained below. The scalar helper remains the differential-test oracle.
  with caller as materialized (
    select (select auth.uid()) uid,
      (select private.current_member_organization()) organization_id,
      (select private.mfa_satisfied()) mfa_satisfied,
      (select private.member_pin_session_restricted()) pin_restricted
  ), scopes as materialized (
    select scope.* from caller
    cross join lateral private.steward_assignment_scopes(caller.uid,null) scope
    where scope.user_id=caller.uid and scope.role=p_role
  ), eligible_scopes as materialized (
    select scope.*,chapter.organization_id
    from scopes scope
    cross join caller
    join public.chapters chapter on chapter.id=scope.chapter_id
      and chapter.organization_id=caller.organization_id
    join public.organization_memberships actor_org on actor_org.user_id=scope.user_id
      and actor_org.organization_id=chapter.organization_id and actor_org.status='active'
    where caller.uid is not null and caller.mfa_satisfied and not caller.pin_restricted
      and (exists(select 1 from public.member_chapter_memberships actor
        where actor.user_id=scope.user_id and actor.chapter_id=scope.chapter_id and actor.status='active')
        or (p_role='steward' and exists(select 1 from public.organization_role_grants grant_row
          where grant_row.organization_id=chapter.organization_id and grant_row.user_id=scope.user_id
            and grant_row.role='steward')))
      and (not private.staff_mfa_required(chapter.organization_id)
        or (select private.has_second_factor((select auth.uid()))))
  ), covered as (
    -- One pass over the active memberships of the eligible scopes' chapters,
    -- with each scope's coverage tested inline: chapter_unit_has_member's and
    -- the committee arm's exact predicates, without a per-candidate call.
    select membership.user_id,scope.organization_id
    from eligible_scopes scope
    join public.member_chapter_memberships membership on membership.chapter_id=scope.chapter_id and membership.status='active'
    where scope.role=p_role and (scope.legacy_chapter_coverage
      or (scope.unit_id is not null and (
        exists(select 1 from private.chapter_unit_members physical
          where physical.unit_id=scope.unit_id and physical.chapter_id=scope.chapter_id and physical.user_id=membership.user_id)
        or (exists(select 1 from private.chapter_units unit
            where unit.id=scope.unit_id and unit.chapter_id=scope.chapter_id and unit.is_default)
          and not exists(select 1 from private.chapter_unit_members physical
            where physical.user_id=membership.user_id and physical.chapter_id=scope.chapter_id))))
      or (scope.committee_id is not null and exists (
        select 1 from private.chapter_committees committee
        join private.chapter_committee_members member on member.committee_id=committee.id
          and member.chapter_id=committee.chapter_id
        where committee.id=scope.committee_id and committee.chapter_id=scope.chapter_id
          and member.user_id=membership.user_id and committee.starts_on<=current_date
          and (committee.ends_on is null or committee.ends_on>=current_date))))
  ), organization_members as (
    select target_org.user_id from public.organization_memberships target_org
    where target_org.organization_id=(select caller.organization_id from caller) and target_org.status='active'
  ), organization_profiles as (
    select target_profile.id from public.member_profiles target_profile
    join public.chapters target_context on target_context.id=target_profile.chapter_id
    where target_context.organization_id=(select caller.organization_id from caller)
  )
  select distinct covered.user_id
  from covered
  where covered.user_id in (select user_id from organization_members)
    and covered.user_id in (select id from organization_profiles);
$function$;

CREATE OR REPLACE FUNCTION public.get_chapter_access_workspace(p_chapter text, p_member_page integer DEFAULT 0, p_unit_page integer DEFAULT 0, p_committee_page integer DEFAULT 0, p_query text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not private.mfa_satisfied() or not private.chapter_access_leadership(p_chapter) then raise exception 'chapter leadership required' using errcode='42501'; end if;
  if p_member_page is null or p_unit_page is null or p_committee_page is null
    or p_member_page not between 0 and 10000 or p_unit_page not between 0 and 10000 or p_committee_page not between 0 and 10000
    or pg_catalog.char_length(coalesce(p_query,''))>120 then raise exception 'invalid access page' using errcode='22023'; end if;
  return (with members as materialized (
    select m.user_id,p.full_name from public.member_chapter_memberships m join public.member_profiles p on p.id=m.user_id
    join public.organization_memberships om on om.user_id=m.user_id and om.organization_id=private.current_member_organization() and om.status='active'
    where m.chapter_id=p_chapter and m.status='active' and p.full_name ilike '%'||coalesce(p_query,'')||'%'
    order by m.user_id limit 31 offset p_member_page*30
  ), visible_members as materialized (select * from members order by user_id limit 30),
  units as materialized (select * from private.chapter_units where chapter_id=p_chapter order by id limit 31 offset p_unit_page*30),
  committees as materialized (select * from private.chapter_committees where chapter_id=p_chapter order by id limit 31 offset p_committee_page*30),
  organization_stewards as materialized (select s.*,profile.full_name from private.organization_steward_unit_assignments s join public.member_profiles profile on profile.id=s.user_id where s.chapter_id=p_chapter and s.organization_id=private.current_member_organization() and profile.full_name ilike '%'||coalesce(p_query,'')||'%' order by s.user_id limit 31 offset p_member_page*30)
  select pg_catalog.jsonb_build_object(
    'chapterId',p_chapter,'memberPage',p_member_page,'unitPage',p_unit_page,'committeePage',p_committee_page,
    'grantableRoles',(select pg_catalog.jsonb_agg(role order by role) from (
      select distinct role from private.chapter_role_capabilities where role not in ('steward','coordinator','advisor','admin','vp')
      union select value from pg_catalog.unnest(case when private.member_has_chapter_role(p_chapter,array['admin']) or private.has_organization_role(private.current_member_organization(),array['admin']) then array['steward','coordinator','advisor','admin','vp'] else array[]::text[] end) value) allowed),
    'hasMoreMembers',((select pg_catalog.count(*)>30 from members) or (select pg_catalog.count(*)>30 from organization_stewards)),
    'hasMoreUnits',(select pg_catalog.count(*)>30 from units),
    'hasMoreCommittees',(select pg_catalog.count(*)>30 from committees),
    'policy',coalesce((select pg_catalog.to_jsonb(p) from private.chapter_access_policies p where chapter_id=p_chapter),pg_catalog.jsonb_build_object('steward_grievances',true,'steward_breadth','chapter')),
    'roles',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('role',role,'capability',capability) order by role,capability) from private.chapter_role_capabilities where role not in ('steward','coordinator','advisor','admin','vp')),
    'settings',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s)) from private.chapter_role_settings s where s.chapter_id=p_chapter),'[]'::jsonb),
    'members',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',m.user_id,'name',m.full_name) order by m.user_id) from visible_members m),'[]'::jsonb),
    'grants',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('userId',r.user_id,'role',r.role,'unitId',s.unit_id,'committeeId',s.committee_id,'legacyChapterCoverage',coalesce(s.legacy_chapter_coverage,false),
      'scopeName',coalesce((select name from private.chapter_units u where u.id=s.unit_id),(select name from private.chapter_committees c where c.id=s.committee_id))))
      from public.member_role_chapters r join visible_members m on m.user_id=r.user_id
      left join private.chapter_role_scopes s on s.user_id=r.user_id and s.chapter_id=r.chapter_id and s.role=r.role where r.chapter_id=p_chapter),'[]'::jsonb) || coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId',s.user_id,'name',s.full_name,'role','steward','unitId',s.unit_id,'committeeId',null,
      'legacyChapterCoverage',s.legacy_chapter_coverage,'organizationGrantBacked',true,
      'scopeName',(select name from private.chapter_units unit where unit.id=s.unit_id)) order by s.user_id)
      from (select * from organization_stewards order by user_id limit 30) s),'[]'::jsonb),
    'units',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',u.id,'name',u.name,'isDefault',u.is_default,
      'members',coalesce((select pg_catalog.jsonb_agg(m.user_id) from private.chapter_unit_member_ids(u.id,p_chapter) m(user_id) join visible_members v on v.user_id=m.user_id),'[]'::jsonb)) order by u.id)
      from (select * from units order by id limit 30) u),'[]'::jsonb),
    'committees',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c)||pg_catalog.jsonb_build_object('members',coalesce((select pg_catalog.jsonb_agg(m.user_id) from private.chapter_committee_members m join visible_members v on v.user_id=m.user_id where m.committee_id=c.id),'[]'::jsonb)) order by c.id)
      from (select * from committees order by id limit 30) c),'[]'::jsonb)
  ));
end;
$function$;

CREATE OR REPLACE FUNCTION private.chapter_unit_rows(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', u.id,
      'chapterId', u.chapter_id,
      'chapterName', c.name,
      'name', u.name,
      'kind', u.kind,
      'isDefault', u.is_default,
      'headcount', u.headcount)
    order by c.order_index, c.name, u.kind, pg_catalog.lower(u.name), u.id), '[]'::jsonb)
  from private.chapter_units u
  join public.chapters c on c.id = u.chapter_id
  where u.organization_id = p_organization_id;
$function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_additional_domains(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select pg_catalog.jsonb_build_object(
    'pulse_saved_charts', private.account_lifecycle_export_pulse_saved_charts(p_caller), 'chapter_bid_entries', private.account_lifecycle_export_chapter_bid_entries(p_caller), 'chapter_seniority_entries', private.account_lifecycle_export_chapter_seniority_entries(p_caller), 'chapter_channel_poll_votes', private.account_lifecycle_export_chapter_channel_poll_votes(p_caller), 'chapter_space_notification_settings', private.account_lifecycle_export_chapter_space_notification_settings(p_caller), 'chapter_task_watchers', private.account_lifecycle_export_chapter_task_watchers(p_caller), 'chapter_thread_posts', private.account_lifecycle_export_chapter_thread_posts(p_caller), 'chapter_threads', private.account_lifecycle_export_chapter_threads(p_caller), 'compass_message_briefings', private.account_lifecycle_export_compass_message_briefings(p_caller), 'compass_workspace_preferences', private.account_lifecycle_export_compass_workspace_preferences(p_caller), 'member_ballot_votes', private.account_lifecycle_export_member_ballot_votes(p_caller), 'member_broadcast_receipts', private.account_lifecycle_export_member_broadcast_receipts(p_caller), 'member_chapter_memberships', private.account_lifecycle_export_member_chapter_memberships(p_caller), 'member_emergency_checklists', private.account_lifecycle_export_member_emergency_checklists(p_caller), 'member_event_contact_links', private.account_lifecycle_export_member_event_contact_links(p_caller), 'member_event_contact_opt_ins', private.account_lifecycle_export_member_event_contact_opt_ins(p_caller), 'member_message_reactions', private.account_lifecycle_export_member_message_reactions(p_caller), 'member_message_reminders', private.account_lifecycle_export_member_message_reminders(p_caller), 'member_message_resources', private.account_lifecycle_export_member_message_resources(p_caller), 'member_profile_details', private.account_lifecycle_export_member_profile_details(p_caller), 'member_qa_votes', private.account_lifecycle_export_member_qa_votes(p_caller), 'member_report_preferences', private.account_lifecycle_export_member_report_preferences(p_caller), 'member_reward_tier_attainment', private.account_lifecycle_export_member_reward_tier_attainment(p_caller), 'member_saved_messages', private.account_lifecycle_export_member_saved_messages(p_caller), 'member_weekly_question_promotions', private.account_lifecycle_export_member_weekly_question_promotions(p_caller), 'member_weekly_question_supports', private.account_lifecycle_export_member_weekly_question_supports(p_caller), 'member_weekly_questions', private.account_lifecycle_export_member_weekly_questions(p_caller), 'organization_engagement_events', private.account_lifecycle_export_organization_engagement_events(p_caller), 'organization_live_poll_votes', private.account_lifecycle_export_organization_live_poll_votes(p_caller), 'organization_memberships', private.account_lifecycle_export_organization_memberships(p_caller), 'organization_pulse_events', private.account_lifecycle_export_organization_pulse_events(p_caller), 'steward_contact_preferences', private.account_lifecycle_export_steward_contact_preferences(p_caller), 'steward_private_reminders', private.account_lifecycle_export_steward_private_reminders(p_caller), 'compass_training_member_consents', private.account_lifecycle_export_compass_training_member_consents(p_caller), 'compass_training_samples', private.account_lifecycle_export_compass_training_samples(p_caller)
  ) || pg_catalog.jsonb_build_object(
    'chapter_unit_members',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('user_id',m.user_id,'chapter_id',m.chapter_id,'unit_id',m.unit_id) order by m.chapter_id,m.unit_id) from private.chapter_unit_members m where m.user_id=p_caller),'[]'::jsonb),
    'chapter_committee_members',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('user_id',m.user_id,'chapter_id',m.chapter_id,'committee_id',m.committee_id) order by m.chapter_id,m.committee_id) from private.chapter_committee_members m where m.user_id=p_caller),'[]'::jsonb),
    'organization_steward_unit_assignments',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('organization_id',m.organization_id,'user_id',m.user_id,'role',m.role,'chapter_id',m.chapter_id,'unit_id',m.unit_id,'legacy_chapter_coverage',m.legacy_chapter_coverage) order by m.chapter_id) from private.organization_steward_unit_assignments m where m.user_id=p_caller),'[]'::jsonb),
    'chapter_role_scopes',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('user_id',m.user_id,'chapter_id',m.chapter_id,'role',m.role,'unit_id',m.unit_id,'committee_id',m.committee_id,'legacy_chapter_coverage',m.legacy_chapter_coverage) order by m.chapter_id,m.role) from private.chapter_role_scopes m where m.user_id=p_caller),'[]'::jsonb)
  ) || jsonb_build_object('chapter_financial_requests',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'organization_id',r.organization_id,'chapter_id',r.chapter_id,'subject_id',r.subject_id,'kind',r.kind,'title',r.title,'description',r.description,'amount',r.amount,'currency',r.currency,'status',r.status,'decision_note',r.decision_note,'revision',r.revision,'created_at',r.created_at,'decided_at',r.decided_at) order by r.created_at,r.id) from private.chapter_financial_requests r where r.subject_id=p_caller),'[]'::jsonb))
  || pg_catalog.jsonb_build_object(
    'member_capacity_commitments', private.account_lifecycle_export_member_capacity_commitments(p_caller), 'member_learning_assignments', private.account_lifecycle_export_member_learning_assignments(p_caller), 'member_membership_periods', private.account_lifecycle_export_member_membership_periods(p_caller), 'member_onboarding_steps', private.account_lifecycle_export_member_onboarding_steps(p_caller), 'member_participation_completions', private.account_lifecycle_export_member_participation_completions(p_caller), 'member_participation_events', private.account_lifecycle_export_member_participation_events(p_caller), 'member_recognition_events', private.account_lifecycle_export_member_recognition_events(p_caller)
  );
$function$;

CREATE OR REPLACE FUNCTION public.set_member_chapter_role(p_user_id uuid, p_chapter_id text, p_role text, p_enabled boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid(),p_user_id],array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target_org uuid;
  org_admin boolean;
  role_key text := p_user_id::text || ':' || p_role || ':' || p_chapter_id;
  before_state jsonb;
begin
  if caller is null then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('steward', 'organizer', 'coordinator', 'advisor', 'admin', 'vp', 'secretary', 'records', 'treasurer') then
    raise exception 'unknown role' using errcode = '22023';
  end if;
  select c.organization_id into target_org
  from public.chapters c
  where c.id = p_chapter_id;
  if target_org is null then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  -- Reject implausible callers without letting them wait on an admin lock.
  org_admin := private.has_organization_role(target_org, array['admin']);
  if not org_admin and p_chapter_id is distinct from private.current_member_chapter() then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not org_admin and not (private.member_has_chapter_role(p_chapter_id, array['admin']) or (p_role in ('secretary','records','treasurer') and private.member_has_chapter_role(p_chapter_id,array['vp']))) then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || target_org::text, 509));

  -- All authoritative authorization and target-membership checks occur after
  -- the tenant authorization lock. This prevents a queued chapter-admin grant
  -- from restoring authority revoked by the transaction ahead of it.
  org_admin := private.has_organization_role(target_org, array['admin']);
  if not org_admin and p_chapter_id is distinct from private.current_member_chapter() then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not org_admin and not (private.member_has_chapter_role(p_chapter_id, array['admin']) or (p_role in ('secretary','records','treasurer') and private.member_has_chapter_role(p_chapter_id,array['vp']))) then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.member_chapter_memberships m
    where m.user_id = p_user_id and m.chapter_id = p_chapter_id and m.status = 'active'
  ) then
    raise exception 'active chapter membership required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.organization_memberships om
    where om.user_id = p_user_id and om.organization_id = target_org and om.status = 'active'
  ) then
    raise exception 'active organization membership required' using errcode = '22023';
  end if;
  if p_role='steward' and coalesce(p_enabled,false) then
    raise exception 'steward requires an explicit chapter unit; use set_member_access_role' using errcode='22023';
  end if;
  before_state := private.learning_membership_state('public.member_role_chapters', role_key);

  if coalesce(p_enabled, false) then
    insert into public.member_roles (user_id, role, granted_by, chapter_id)
    values (p_user_id, p_role, caller, p_chapter_id)
    on conflict (user_id, role) do nothing;
    insert into public.member_role_chapters (user_id, role, chapter_id, granted_by)
    values (p_user_id, p_role, p_chapter_id, caller)
    on conflict (user_id, role, chapter_id) do nothing;
  else
    if p_role = 'admin' and p_user_id = caller and p_chapter_id = private.current_member_chapter() then
      raise exception 'an admin cannot remove the active admin role from this session' using errcode = '22023';
    end if;
    delete from public.member_role_chapters
    where user_id = p_user_id and role = p_role and chapter_id = p_chapter_id;
    -- #8311: drop or repoint a legacy role row whose chapter lost the role.
    perform private.reconcile_legacy_member_roles(p_user_id, p_role);
  end if;

  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (caller, case when coalesce(p_enabled, false) then 'grant_role' else 'revoke_role' end,
    p_user_id, pg_catalog.jsonb_build_object('role', p_role, 'chapterId', p_chapter_id));
  if coalesce(pg_catalog.current_setting('sg.learning_role_scope_writer', true), '') <> '1' then
    if coalesce(p_enabled, false) then
      perform private.learning_membership_journal('chapter_role_grant', 'public.member_role_chapters', role_key, before_state);
    else
      perform private.learning_membership_journal('chapter_role_revoke', 'public.member_role_chapters', role_key, before_state);
    end if;
  end if;
  return pg_catalog.jsonb_build_object(
    'userId', p_user_id, 'chapterId', p_chapter_id, 'role', p_role,
    'enabled', coalesce(p_enabled, false));
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_member_organization_role(p_user_id uuid, p_role text, p_enabled boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[(select auth.uid()), p_user_id], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  locked_org uuid := private.current_member_organization();
  target_org uuid;
  changed integer := 0;
  role_key text;
  before_state jsonb;
begin
  if caller is null or locked_org is null then
    raise exception 'organization admin required' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('steward', 'coordinator', 'advisor', 'admin', 'vp') then
    raise exception 'unknown role' using errcode = '22023';
  end if;
  if not private.has_organization_role(locked_org, array['admin']) then
    raise exception 'organization admin required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || locked_org::text, 509));

  -- Re-derive and reauthorize under the lock. In particular, a self-regrant
  -- queued behind revocation cannot reuse its pre-lock admin authority.
  target_org := private.current_member_organization();
  if target_org is distinct from locked_org
     or not private.has_organization_role(locked_org, array['admin']) then
    raise exception 'organization admin required' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.organization_memberships om
    where om.organization_id = locked_org
      and om.user_id = p_user_id
      and om.status = 'active'
  ) then
    raise exception 'active organization membership required' using errcode = '22023';
  end if;

  if p_role='steward' and coalesce(p_enabled,false) then
    raise exception 'steward access requires a chapter and unit' using errcode='22023';
  end if;
  target_org := locked_org;
  role_key := target_org::text || ':' || p_user_id::text || ':' || p_role;
  before_state := private.learning_membership_state('public.organization_role_grants', role_key);

  if coalesce(p_enabled, false) then
    insert into public.organization_role_grants
      (organization_id, user_id, role, granted_by)
    values (target_org, p_user_id, p_role, caller)
    on conflict (organization_id, user_id, role) do nothing;
    get diagnostics changed = row_count;
  else
    if p_role = 'admin'
       and exists (
         select 1 from public.organization_role_grants g
         where g.organization_id = target_org
           and g.user_id = p_user_id
           and g.role = 'admin'
       )
       and (
         select pg_catalog.count(*)
         from public.organization_role_grants g
         where g.organization_id = target_org and g.role = 'admin'
       ) <= 1 then
      raise exception 'cannot remove the last organization admin' using errcode = '22023';
    end if;

    delete from public.organization_role_grants g
    where g.organization_id = target_org
      and g.user_id = p_user_id
      and g.role = p_role;
    get diagnostics changed = row_count;
    -- #8589 round 1: a chapter steward grant (with its unit) is removed where
    -- it was given; never report "no change" while that access remains.
    if p_role = 'steward' and changed = 0 and exists (
      select 1 from public.member_role_chapters grant_row
      join public.chapters chapter on chapter.id = grant_row.chapter_id and chapter.organization_id = target_org
      where grant_row.user_id = p_user_id and grant_row.role = 'steward') then
      raise exception 'steward access is granted per chapter: remove it under Roles, units and committees' using errcode = '22023';
    end if;
  end if;

  if changed > 0 then
    insert into public.organization_audit_events (
      organization_id, event_type, actor_user_id, idempotency_key, metadata
    ) values (
      target_org,
      case when coalesce(p_enabled, false)
        then 'organization_role_granted'
        else 'organization_role_revoked'
      end,
      caller,
      extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object(
        'organizationId', target_org::text,
        'userId', p_user_id::text,
        'role', p_role
      )
    );
    if coalesce(p_enabled, false) then
      perform private.learning_membership_journal('organization_role_grant', 'public.organization_role_grants', role_key, before_state);
    else
      perform private.learning_membership_journal('organization_role_revoke', 'public.organization_role_grants', role_key, before_state);
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', target_org,
    'userId', p_user_id,
    'role', p_role,
    'enabled', coalesce(p_enabled, false),
    'changed', changed > 0
  );
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_member_access_role(p_user uuid, p_chapter text, p_role text, p_enabled boolean, p_unit uuid DEFAULT NULL::uuid, p_committee uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid(),p_user],array[]::uuid[]);
declare
  role_key text := p_user::text || ':' || p_role || ':' || p_chapter;
  before_state jsonb;
  existing_steward boolean;
  org uuid;
begin
  if not private.mfa_satisfied() or not private.chapter_access_leadership(p_chapter) then raise exception 'chapter leadership required' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:'||private.current_member_organization()::text,509));
  if not private.mfa_satisfied() or not private.chapter_access_leadership(p_chapter) then raise exception 'chapter leadership required' using errcode='42501'; end if;
  org:=private.current_member_organization();
  if not private.has_organization_role(org,array['admin']) and p_chapter is distinct from private.current_member_chapter() then
    raise exception 'own chapter required' using errcode='42501';
  end if;
  if p_role='steward' and coalesce(p_enabled,false) and (p_unit is null or p_committee is not null) then
    raise exception 'steward requires one chapter unit' using errcode='22023';
  end if;
  if p_unit is not null and p_committee is not null then raise exception 'choose one role scope' using errcode='22023'; end if;
  if (p_unit is not null or p_committee is not null) and p_role not in ('steward','coordinator','advisor','secretary','records') then raise exception 'role does not support that scope' using errcode='22023'; end if;
  if p_unit is not null and not exists(select 1 from private.chapter_units where id=p_unit and chapter_id=p_chapter) then raise exception 'unit outside chapter' using errcode='42501'; end if;
  if p_committee is not null and not exists(select 1 from private.chapter_committees where id=p_committee and chapter_id=p_chapter) then raise exception 'committee outside chapter' using errcode='42501'; end if;
  -- #8589 round 1: while an organization steward grant survives, the chapter
  -- steward unit is what limits it here; refuse removing it with a clear answer.
  if p_role='steward' and not coalesce(p_enabled,false)
     and exists(select 1 from public.organization_role_grants where organization_id=org and user_id=p_user and role='steward') then
    raise exception 'revoke the organization steward grant through organization administration' using errcode='22023';
  end if;
  -- Existing organization-only stewards keep their organization grant.
  -- This path can only update a migrated assignment, never create one.
  if p_role='steward' and exists(select 1 from private.organization_steward_unit_assignments
      where user_id=p_user and chapter_id=p_chapter and organization_id=org) then
    if not coalesce(p_enabled,false) then
      raise exception 'revoke the organization steward grant through organization administration' using errcode='22023';
    end if;
    if not exists(select 1 from public.organization_memberships
        where organization_id=org and user_id=p_user and status='active') then
      raise exception 'active organization membership required' using errcode='42501';
    end if;
    update private.organization_steward_unit_assignments
      set unit_id=p_unit,legacy_chapter_coverage=false
      where user_id=p_user and chapter_id=p_chapter and organization_id=org;
    insert into public.member_admin_audit(actor,action,target_user,detail)
      values(auth.uid(),'role_scope_updated',p_user,pg_catalog.jsonb_build_object(
        'chapterId',p_chapter,'role','steward','unitId',p_unit,
        'organizationGrantBacked',true,'legacyChapterCoverage',false,'enabled',true));
    return pg_catalog.jsonb_build_object('updated',true);
  end if;
  before_state := private.learning_membership_state('public.member_role_chapters', role_key);
  -- The inner role change leaves its journalling to this call, which
  -- journals the role and its scope as one change below.
  perform pg_catalog.set_config('sg.learning_role_scope_writer', '1', true);
  if p_role='steward' and coalesce(p_enabled,false) then
    if not exists(select 1 from public.member_chapter_memberships where user_id=p_user and chapter_id=p_chapter and status='active')
       or not exists(select 1 from public.organization_memberships where user_id=p_user and organization_id=org and status='active') then
      raise exception 'active membership required' using errcode='22023';
    end if;
    -- #8589 stage 148: only a steward grant in this chapter is existing
    -- authority. The organization grant alone is not (a migrated assignment
    -- was updated above), so a first assignment needs an Admin.
    existing_steward:=exists(select 1 from public.member_role_chapters where user_id=p_user and chapter_id=p_chapter and role='steward');
    -- The new chapter-lead path only narrows an existing steward's scope.
    -- A fresh role still requires the same admin authority as the nested setter.
    if not existing_steward and not (private.has_organization_role(org,array['admin']) or private.member_has_chapter_role(p_chapter,array['admin'])) then
      raise exception 'admin required for a new steward grant' using errcode='42501';
    end if;
    insert into public.member_roles(user_id,role,chapter_id,granted_by)
    values(p_user,'steward',p_chapter,auth.uid()) on conflict(user_id,role) do nothing;
    insert into public.member_role_chapters(user_id,role,chapter_id,granted_by)
    values(p_user,'steward',p_chapter,auth.uid()) on conflict(user_id,role,chapter_id) do nothing;
    if not existing_steward then
      insert into public.member_admin_audit(actor,action,target_user,detail)
      values(auth.uid(),'grant_role',p_user,pg_catalog.jsonb_build_object('chapterId',p_chapter,'role','steward'));
    end if;
  else
    perform public.set_member_chapter_role(p_user,p_chapter,p_role,p_enabled);
  end if;
  perform pg_catalog.set_config('sg.learning_role_scope_writer', '', true);
  if coalesce(p_enabled,false) and (p_unit is not null or p_committee is not null) then
    insert into private.chapter_role_scopes(user_id,chapter_id,role,unit_id,committee_id)
    values(p_user,p_chapter,p_role,p_unit,p_committee)
    on conflict(user_id,chapter_id,role) do update set unit_id=excluded.unit_id,committee_id=excluded.committee_id,legacy_chapter_coverage=false;
  else
    delete from private.chapter_role_scopes where user_id=p_user and chapter_id=p_chapter and role=p_role;
  end if;
  insert into public.member_admin_audit(actor,action,target_user,detail) values(auth.uid(),'role_scope_updated',p_user,
    pg_catalog.jsonb_build_object('chapterId',p_chapter,'role',p_role,'unitId',p_unit,'committeeId',p_committee,'enabled',coalesce(p_enabled,false)));
  if not coalesce((before_state ->> 'granted')::boolean, false) and coalesce(p_enabled, false) then
    perform private.learning_membership_journal('chapter_role_grant', 'public.member_role_chapters', role_key, before_state);
  elsif not coalesce(p_enabled, false) then
    perform private.learning_membership_journal('chapter_role_revoke', 'public.member_role_chapters', role_key, before_state);
  else
    perform private.learning_membership_journal('chapter_role_scope', 'public.member_role_chapters', role_key, before_state);
  end if;
  return pg_catalog.jsonb_build_object('updated',true);
end;
end;
$function$;

CREATE FUNCTION public.create_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_initial_role text, p_locale text, p_token_hash text, p_unit_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_inviter_chapter();
  target_chapter text := pg_catalog.btrim(coalesce(p_chapter_id, ''));
  clean_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  clean_name text := pg_catalog.btrim(coalesce(p_full_name, ''));
  clean_role text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_initial_role, ''))), '');
  clean_locale text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_locale, '')));
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  name_parts text[];
  clean_first text;
  clean_initials text;
  invitation_row public.member_invitations%rowtype;
  expired_row public.member_invitations%rowtype;
  as_admin boolean;
begin
  if caller is null
     or not (private.member_has_chapter_role(caller_chapter, array['admin'])
             or private.member_invitation_chapter_presided(caller_chapter)) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  -- An admin may invite into any chapter they administer in the selected
  -- organization. A chapter President may invite only into a chapter they
  -- preside over, and only as a plain member (project decision, October 4,
  -- 2026). The desk gate above already holds the organization-role lock.
  as_admin := private.member_invitation_chapter_administrable(target_chapter);
  if not as_admin and (clean_role is not null
     or not private.member_invitation_chapter_presided(target_chapter)) then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  if clean_role is not null and (coalesce(auth.jwt()->>'aal','')<>'aal2' or not private.has_second_factor(caller)) then raise exception 'two-step sign-in required for starting access' using errcode='42501'; end if;

  if clean_role='steward' and p_unit_id is null then
    raise exception 'steward invitation requires a chapter unit' using errcode='22023';
  end if;
  if p_unit_id is not null and not exists(select 1 from private.chapter_units
      where id=p_unit_id and chapter_id=target_chapter and organization_id=private.current_member_organization()) then
    raise exception 'unit outside invitation chapter' using errcode='42501';
  end if;
  -- Count before duplicate/existing-account branches. Those branches must not
  -- be a free unbounded address-probing endpoint.
  if not private.consume_member_invitation_admin_limit(
    'admin:' || caller::text, 'create-hour', private.organization_limit(private.current_member_organization(), 'limits.security.invitation_admin_hourly'), interval '1 hour'
  ) or not private.consume_member_invitation_admin_limit(
    'chapter:' || target_chapter, 'chapter-day', private.organization_limit(private.current_member_organization(), 'limits.security.invitation_chapter_daily'), interval '1 day'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001';
  end if;

  if pg_catalog.char_length(clean_email) not between 3 and 254
     or clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or pg_catalog.char_length(clean_name) not between 2 and 120
     or clean_name ~ '[[:cntrl:]]'
     or clean_hash !~ '^[0-9a-f]{64}$'
     or clean_locale not in ('en', 'es')
     or (clean_role is not null and clean_role not in ('steward', 'organizer', 'coordinator', 'advisor', 'vp', 'admin', 'secretary', 'records', 'treasurer')) then
    raise exception 'invalid invitation request' using errcode = '22023';
  end if;

  name_parts := pg_catalog.regexp_split_to_array(clean_name, '[[:space:]]+');
  clean_first := name_parts[1];
  clean_initials := pg_catalog.upper(
    pg_catalog.left(clean_first, 1)
    || case when pg_catalog.array_length(name_parts, 1) > 1
       then pg_catalog.left(name_parts[pg_catalog.array_length(name_parts, 1)], 1)
       else '' end
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-email:' || clean_email, 509)
  );

  for expired_row in
    update public.member_invitations
    set status = 'expired', token_hash = null, failure_code = null
    where normalized_email = clean_email
      and status = 'pending'
      and expires_at <= clock_timestamp()
    returning *
  loop
    perform private.audit_member_invitation(
      expired_row.id, expired_row.chapter_id, caller, 'invite_expired',
      pg_catalog.jsonb_build_object('chapterId', expired_row.chapter_id,
        'deliveryVersion', expired_row.delivery_version)
    );
  end loop;

  if exists (
    select 1 from auth.users u
    where pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))) = clean_email
  ) or exists (
    select 1 from public.member_invitations i
    where i.normalized_email = clean_email and i.status in ('pending', 'accepting')
  ) then
    return pg_catalog.jsonb_build_object('accepted', true, 'send', false);
  end if;

  insert into public.member_invitations
    (normalized_email, full_name, first_name, initials, chapter_id,
     initial_role, locale, token_hash, status, delivery_version, invited_by,
     expires_at)
  values
    (clean_email, clean_name, clean_first, clean_initials, target_chapter,
     clean_role, clean_locale, clean_hash, 'pending', 1, caller,
     clock_timestamp() + interval '15 minutes')
  returning * into invitation_row;
  if p_unit_id is not null then
    insert into private.member_invitation_units(invitation_id,unit_id) values(invitation_row.id,p_unit_id);
  end if;
  perform private.learning_journal_append('invitation_send', 'public.member_invitations', invitation_row.id::text);

  perform private.audit_member_invitation(
    invitation_row.id, target_chapter, caller, 'invite_requested',
    pg_catalog.jsonb_build_object('chapterId', target_chapter,
      'initialRole', clean_role, 'locale', clean_locale,
      'deliveryVersion', invitation_row.delivery_version)
  );

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'send', true,
    'invitationId', invitation_row.id,
    'deliveryVersion', invitation_row.delivery_version,
    'expiresAt', invitation_row.expires_at
  );
end;
end;
$function$;

revoke all on function public.create_member_invitation(text,text,text,text,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.create_member_invitation(text,text,text,text,text,text,uuid) to authenticated;

CREATE OR REPLACE FUNCTION public.create_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_initial_role text, p_locale text, p_token_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  if not private.mfa_satisfied() then
    raise exception 'two-step verification required' using errcode='42501';
  end if;
  return public.create_member_invitation(p_email,p_full_name,p_chapter_id,p_initial_role,p_locale,p_token_hash,null::uuid);
end;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_member_invitation(p_invitation_id uuid, p_auth_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  invitation_row public.member_invitations%rowtype;
  selected_unit uuid;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into invitation_row
  from public.member_invitations
  where id = p_invitation_id and status = 'accepting'
  for update;
  if not found then
    raise exception 'invitation unavailable' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from auth.users u
    where u.id = p_auth_user_id
      and pg_catalog.lower(u.email) = invitation_row.normalized_email
      and u.raw_user_meta_data ->> 'union_base_invitation_id' = invitation_row.id::text
      and u.raw_user_meta_data ->> 'chapter_id' = invitation_row.chapter_id
      and u.raw_app_meta_data ->> 'union_ground_provisioning' = 'pending'
      and u.banned_until > pg_catalog.clock_timestamp()
  ) or not exists (
    select 1
    from public.member_profiles p
    where p.id = p_auth_user_id and p.chapter_id = invitation_row.chapter_id
  ) or not exists (
    select 1
    from public.member_chapter_memberships m
    where m.user_id = p_auth_user_id
      and m.chapter_id = invitation_row.chapter_id
      and m.status = 'active'
  ) then
    raise exception 'invitation identity mismatch' using errcode = '22023';
  end if;

  if invitation_row.initial_role='steward' then
    selected_unit:=private.member_invitation_selected_unit(invitation_row.id,invitation_row.chapter_id);
    if selected_unit is null then raise exception 'steward invitation requires a unit' using errcode='22023'; end if;
  end if;
  if invitation_row.initial_role is not null then
    insert into public.member_roles (user_id, role, chapter_id, granted_by)
    values (
      p_auth_user_id, invitation_row.initial_role,
      invitation_row.chapter_id, invitation_row.invited_by
    )
    on conflict (user_id, role) do nothing;
    insert into public.member_role_chapters
      (user_id, role, chapter_id, granted_by)
    values (
      p_auth_user_id, invitation_row.initial_role,
      invitation_row.chapter_id, invitation_row.invited_by
    )
    on conflict (user_id, role, chapter_id) do nothing;
  end if;

  if invitation_row.initial_role='steward' then
    insert into private.chapter_role_scopes(user_id,chapter_id,role,unit_id)
    values(p_auth_user_id,invitation_row.chapter_id,'steward',selected_unit)
    on conflict(user_id,chapter_id,role) do update set unit_id=excluded.unit_id,committee_id=null,legacy_chapter_coverage=false;
  end if;

  update public.member_invitations
  set auth_user_id = p_auth_user_id, failure_code = null
  where id = invitation_row.id;

  return pg_catalog.jsonb_build_object('prepared', true, 'userId', p_auth_user_id);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION private.staff_visible_member_ids(p_role text)
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if p_role is null or p_role not in ('steward','coordinator','advisor','admin','vp') then return; end if;
  return query
  with caller as materialized (
    select
      (select auth.uid()) as uid,
      (select private.current_member_organization()) as organization_id
  ),
  organization_role as materialized (
    select case when caller.uid is not null and p_role is not null
      and caller.organization_id is not null and (select private.mfa_satisfied())
      then private.has_organization_role(caller.organization_id, array[p_role])
      else false end as allowed
    from caller
  ),
  visible_chapters as materialized (
    select chapter.id
    from public.chapters chapter
    cross join caller
    cross join organization_role
    where caller.uid is not null
      and p_role is not null
      and (select private.mfa_satisfied())
      and (
        (
          chapter.organization_id is not null
          and chapter.organization_id = caller.organization_id
          and (
            (organization_role.allowed and (p_role<>'steward' or private.organization_steward_scope_allows(caller.uid,chapter.id,null)))
            or private.member_has_chapter_role(
              chapter.id,
              array[p_role]
            )
          )
        )
        or (
          chapter.organization_id is null
          and caller.organization_id is null
          and exists (
            select 1
            from public.member_profiles caller_profile
            left join public.chapters caller_chapter
              on caller_chapter.id = caller_profile.chapter_id
            where caller_profile.id = caller.uid
              and (
                caller_chapter.id is null
                or caller_chapter.organization_id is null
              )
          )
          and (
            not (select private.staff_mfa_required())
            or (select private.has_second_factor(caller.uid))
          )
          and exists (
            select 1
            from public.member_roles role_grant
            where role_grant.user_id = caller.uid
              and role_grant.role = p_role
              and (
                role_grant.chapter_id is null
                or exists (
                  select 1
                  from public.member_role_chapters role_chapter
                  join public.member_chapter_memberships membership
                    on membership.user_id = role_chapter.user_id
                   and membership.chapter_id = role_chapter.chapter_id
                  join public.chapters mapped_chapter
                    on mapped_chapter.id = role_chapter.chapter_id
                  where role_chapter.user_id = role_grant.user_id
                    and role_chapter.role = role_grant.role
                    and role_chapter.chapter_id = chapter.id
                    and mapped_chapter.organization_id is null
                    and membership.status = 'active'
                )
              )
          )
        )
      )
  )
  select profile.id
  from public.member_profiles profile
  where profile.chapter_id = any (array(select visible_chapters.id from visible_chapters))
    or profile.id in (select private.chapter_scoped_member_ids(p_role));
end;
$function$;

CREATE OR REPLACE FUNCTION private.chapter_records_scope_memo(p_kind text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case p_kind
    when 'member' then (
      select coalesce(pg_catalog.jsonb_object_agg(d.chapter_id,
        private.can_read_chapter_member_record(d.chapter_id)), '{}'::jsonb)
      from (select distinct r.chapter_id from public.chapter_records r) d
    )
    when 'contact' then (
      select coalesce(pg_catalog.jsonb_object_agg(d.chapter_id,
        private.can_read_chapter_contact_record(d.chapter_id)), '{}'::jsonb)
      from (select distinct r.chapter_id from public.chapter_records r) d
    )
    when 'officer' then (
      select coalesce(pg_catalog.jsonb_object_agg(
        pg_catalog.jsonb_build_array(d.chapter_id, d.access_unit_id, d.access_committee_id)::text,
        private.chapter_officer_can_for_scope(d.chapter_id, 'records', d.access_unit_id, d.access_committee_id)), '{}'::jsonb)
      from (select distinct r.chapter_id, r.access_unit_id, r.access_committee_id from public.chapter_records r) d
    )
    when 'manageable' then (
      select coalesce(pg_catalog.jsonb_object_agg(
        pg_catalog.jsonb_build_array(d.chapter_id, d.access_unit_id, d.access_committee_id)::text,
        private.chapter_record_manageable(d.chapter_id, d.access_unit_id, d.access_committee_id)), '{}'::jsonb)
      from (select distinct r.chapter_id, r.access_unit_id, r.access_committee_id from public.chapter_records r
            where r.access_unit_id is not null or r.access_committee_id is not null) d
    )
    when 'broad-staff' then (
      select coalesce(pg_catalog.jsonb_object_agg(d.chapter_id,
        (private.member_has_chapter_role(d.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.chapter_organization_role_allowed(d.chapter_id, array['steward','coordinator','advisor','admin','vp']))), '{}'::jsonb)
      from (select distinct r.chapter_id from public.chapter_records r) d
    )
    when 'container' then (
      select coalesce(pg_catalog.jsonb_object_agg(
        pg_catalog.jsonb_build_array(d.chapter_id, d.access_unit_id, d.access_committee_id)::text,
        private.chapter_record_manageable(d.chapter_id, d.access_unit_id, d.access_committee_id)
          or private.chapter_scope_member_allowed(d.chapter_id, d.access_unit_id, d.access_committee_id, (select auth.uid()))), '{}'::jsonb)
      from (select distinct r.chapter_id, r.access_unit_id, r.access_committee_id from public.chapter_records r
             where r.access_unit_id is not null or r.access_committee_id is not null) d
    )
    else '{}'::jsonb
  end
$function$;

CREATE OR REPLACE FUNCTION public.get_institutional_records_workspace()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  ctx record;
begin
  select * into ctx from private.institutional_context(false);
  return pg_catalog.jsonb_build_object(
    'canManage', ctx.staff,
    'chapterId',ctx.chapter_id,'organizationId',ctx.organization_id,
    'canContacts', private.can_read_chapter_contact_record(ctx.chapter_id),
    'canManageUnscoped', private.chapter_record_manageable(ctx.chapter_id,null,null),
    'recordScopes', case when private.member_pin_session_restricted() then '[]'::jsonb else public.get_chapter_office_access()->'scopes' end,
    'canExport', private.has_organization_role(ctx.organization_id, array['admin','vp']),
    'records', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) || pg_catalog.jsonb_build_object(
        'canManage', private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id),
        'versions', case when private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id) then coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(v) order by v.version desc) from public.chapter_record_versions v where v.record_id = r.id and (v.record_type <> 'member_contact' or coalesce((((select private.chapter_records_scope_memo('broad-staff')) ->> v.chapter_id))::boolean, (private.member_has_chapter_role(v.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.chapter_organization_role_allowed(v.chapter_id, array['steward','coordinator','advisor','admin','vp']))))), '[]'::jsonb) else '[]'::jsonb end,
        'attendance', case when private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id) then coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('userId', a.user_id, 'status', a.attendance_status) order by p.full_name) from public.meeting_attendance a join public.member_profiles p on p.id = a.user_id where a.record_id = r.id and private.chapter_records_member_allowed(r.chapter_id, a.user_id)), '[]'::jsonb) else '[]'::jsonb end,
        'dispatch', case when private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id) then coalesce((select pg_catalog.jsonb_build_object('delivered', pg_catalog.count(*) filter (where d.status = 'delivered'), 'failed', pg_catalog.count(*) filter (where d.status = 'failed')) from public.meeting_minutes_dispatches d where d.record_id = r.id and d.version = r.version), pg_catalog.jsonb_build_object('delivered', 0, 'failed', 0)) else pg_catalog.jsonb_build_object('delivered', 0, 'failed', 0) end
      ) order by r.pinned_at desc nulls last, r.occurred_at desc, r.id)
      from public.chapter_records r
      where r.chapter_id = ctx.chapter_id
        and r.archived_at is null
        and (r.record_type <> 'member_contact' or coalesce((((select private.chapter_records_scope_memo('broad-staff')) ->> r.chapter_id))::boolean, (private.member_has_chapter_role(r.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.chapter_organization_role_allowed(r.chapter_id, array['steward','coordinator','advisor','admin','vp']))))
        and ((r.access_unit_id is null and r.access_committee_id is null) or coalesce((((select private.chapter_records_scope_memo('manageable')) ->> pg_catalog.jsonb_build_array(r.chapter_id, r.access_unit_id, r.access_committee_id)::text))::boolean, private.chapter_record_manageable(r.chapter_id, r.access_unit_id, r.access_committee_id)) or (((r.access_unit_id is null and r.access_committee_id is null) or coalesce((((select private.chapter_records_scope_memo('container')) ->> pg_catalog.jsonb_build_array(r.chapter_id, r.access_unit_id, r.access_committee_id)::text))::boolean, (private.chapter_record_manageable(r.chapter_id, r.access_unit_id, r.access_committee_id) or private.chapter_scope_member_allowed(r.chapter_id, r.access_unit_id, r.access_committee_id, (select auth.uid()))))) and (coalesce((((select private.chapter_records_scope_memo('broad-staff')) ->> r.chapter_id))::boolean, (private.member_has_chapter_role(r.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.chapter_organization_role_allowed(r.chapter_id, array['steward','coordinator','advisor','admin','vp']))) or (private.chapter_record_publication(r.record_type)='chapter_members' and r.lifecycle_status='published' and r.visibility='chapter'))))
        and (private.chapter_record_publication(r.record_type)='chapter_members' or private.can_read_chapter_contact_record(ctx.chapter_id))
        and ((private.chapter_record_publication(r.record_type)='chapter_members' and private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id)) or private.can_read_chapter_contact_record(ctx.chapter_id) or (r.lifecycle_status='published' and r.visibility='chapter' and private.chapter_record_publication(r.record_type)='chapter_members' and private.chapter_scope_member_allowed(r.chapter_id,r.access_unit_id,r.access_committee_id,(select auth.uid()))))
    ), '[]'::jsonb),
    'contacts', case when private.can_read_chapter_contact_record(ctx.chapter_id) then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(l) || pg_catalog.jsonb_build_object('subjectName', p.full_name) order by l.occurred_at desc, l.id)
      from public.chapter_contact_log l
      left join public.member_profiles p on p.id = l.subject_user_id
      where l.organization_id = ctx.organization_id and l.chapter_id = ctx.chapter_id and l.archived_at is null and private.chapter_contact_entry_allowed(l.chapter_id, l.subject_user_id, l.case_id)
    ), '[]'::jsonb) else '[]'::jsonb end,
    'roster', case when ctx.staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('userId', p.id, 'name', p.full_name) order by p.full_name)
      from public.member_chapter_memberships cm
      join public.member_profiles p on p.id = cm.user_id
      where cm.chapter_id = ctx.chapter_id and cm.status = 'active'
        and private.chapter_records_member_allowed(ctx.chapter_id, cm.user_id)
    ), '[]'::jsonb) else '[]'::jsonb end,
    'exportRuns', case when private.has_organization_role(ctx.organization_id, array['admin','vp']) then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) order by e.created_at desc)
      from (select * from public.organization_data_export_runs where organization_id = ctx.organization_id order by created_at desc limit 20) e
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.save_scoped_institutional_record(p_record_id uuid, p_record_type text, p_title text, p_body text, p_occurred_at timestamp with time zone, p_visibility text DEFAULT 'chapter'::text, p_action text DEFAULT 'save'::text, p_pinned boolean DEFAULT false, p_gap_note text DEFAULT NULL::text, p_expected_version integer DEFAULT NULL::integer, p_attendance jsonb DEFAULT '[]'::jsonb, p_access_unit_id uuid DEFAULT NULL::uuid, p_access_committee_id uuid DEFAULT NULL::uuid, p_expected_chapter text DEFAULT NULL::text, p_expected_organization uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
declare
  ctx record;
  target public.chapter_records%rowtype;
  next_status text;
  next_version integer;
  attendee jsonb;
  recipient record;
  delivered integer := 0;
begin
  if not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:'||private.current_member_organization()::text,509));
  select * into ctx from private.institutional_context(false);
  if (p_expected_chapter is not null and p_expected_chapter is distinct from ctx.chapter_id)
    or (p_expected_organization is not null and p_expected_organization is distinct from ctx.organization_id) then
    raise exception 'chapter context changed' using errcode='42501';
  end if;
  if not private.chapter_record_manageable(ctx.chapter_id,p_access_unit_id,p_access_committee_id)
    or (p_access_unit_id is not null and p_access_committee_id is not null)
    or (p_access_unit_id is not null and not exists(select 1 from private.chapter_units where id=p_access_unit_id and chapter_id=ctx.chapter_id))
    or (p_access_committee_id is not null and not exists(select 1 from private.chapter_committees where id=p_access_committee_id and chapter_id=ctx.chapter_id)) then
    raise exception 'record outside access scope' using errcode='42501';
  end if;
  if p_record_type = 'member_contact' and not (private.member_has_chapter_role(ctx.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.chapter_organization_role_allowed(ctx.chapter_id, array['steward','coordinator','advisor','admin','vp'])) then
    raise exception 'contact access required' using errcode='42501';
  end if;
  if p_record_type in ('management_contact','member_contact') and not private.can_read_chapter_contact_record(ctx.chapter_id) then raise exception 'contact access required' using errcode='42501'; end if;
  if p_record_type not in ('minutes','decision','milestone','management_contact','member_contact')
     or p_visibility not in ('chapter','staff')
     or p_action not in ('save','publish','archive')
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title, ''))) not between 1 and 200
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_body, ''))) not between 1 and 20000
     or p_occurred_at is null
     or pg_catalog.char_length(coalesce(p_gap_note, '')) > 1000
     or pg_catalog.jsonb_typeof(coalesce(p_attendance, '[]'::jsonb)) <> 'array'
     or pg_catalog.jsonb_array_length(coalesce(p_attendance, '[]'::jsonb)) > 1000 then
    raise exception 'invalid institutional record' using errcode = '22023';
  end if;

  next_status := case p_action when 'publish' then 'published' when 'archive' then 'archived' else 'draft' end;
  if p_record_id is null then
    insert into public.chapter_records (
      chapter_id, record_type, title, body, occurred_at, created_by,
      lifecycle_status, visibility, version, published_at, updated_at, pinned_at, gap_note, archived_at, access_unit_id, access_committee_id
    ) values (
      ctx.chapter_id, p_record_type, pg_catalog.btrim(p_title), pg_catalog.btrim(p_body), p_occurred_at, ctx.caller_id,
      next_status, p_visibility, 1,
      case when next_status = 'published' then pg_catalog.now() end,
      pg_catalog.now(), case when p_pinned then pg_catalog.now() end, nullif(pg_catalog.btrim(p_gap_note), ''),
      case when next_status = 'archived' then pg_catalog.now() end, p_access_unit_id, p_access_committee_id
    ) returning * into target;
  else
    select * into target from public.chapter_records r
    where r.id = p_record_id and r.chapter_id = ctx.chapter_id
    for update;
    if target.id is null then raise exception 'record not found' using errcode = 'P0002'; end if;
    if not private.chapter_record_manageable(target.chapter_id,target.access_unit_id,target.access_committee_id)
      or (target.record_type = 'member_contact' and not (private.member_has_chapter_role(ctx.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.chapter_organization_role_allowed(ctx.chapter_id, array['steward','coordinator','advisor','admin','vp'])))
      or (target.record_type in ('management_contact','member_contact') and not private.can_read_chapter_contact_record(ctx.chapter_id)) then
      raise exception 'record outside access scope' using errcode='42501';
    end if;
    if p_expected_version is null or target.version <> p_expected_version then
      raise exception 'record changed; reload before saving' using errcode = 'PT409';
    end if;
    next_version := target.version + 1;
    update public.chapter_records r set
      access_unit_id=p_access_unit_id, access_committee_id=p_access_committee_id,
      record_type = p_record_type,
      title = pg_catalog.btrim(p_title),
      body = pg_catalog.btrim(p_body),
      occurred_at = p_occurred_at,
      lifecycle_status = next_status,
      visibility = p_visibility,
      version = next_version,
      published_at = case when next_status = 'published' then pg_catalog.now() else r.published_at end,
      updated_at = pg_catalog.now(),
      pinned_at = case when p_pinned then coalesce(r.pinned_at, pg_catalog.now()) end,
      gap_note = nullif(pg_catalog.btrim(p_gap_note), ''),
      archived_at = case when next_status = 'archived' then pg_catalog.now() end
    where r.id = target.id
    returning * into target;
  end if;

  insert into public.chapter_record_versions (
    record_id, chapter_id, version, record_type, title, body, occurred_at,
    lifecycle_status, visibility, gap_note, changed_by
  ) values (
    target.id, target.chapter_id, target.version, target.record_type, target.title, target.body,
    target.occurred_at, target.lifecycle_status, target.visibility, target.gap_note, ctx.caller_id
  );

  delete from public.meeting_attendance where record_id = target.id
    and private.chapter_records_member_allowed(ctx.chapter_id, user_id);
  if target.record_type = 'minutes' then
    for attendee in select value from pg_catalog.jsonb_array_elements(p_attendance)
    loop
      if attendee->>'status' not in ('present','absent','excused','guest') or not exists (
        select 1 from public.member_chapter_memberships cm
        where cm.chapter_id = ctx.chapter_id and cm.user_id = (attendee->>'userId')::uuid and cm.status = 'active'
          and private.chapter_scope_member_allowed(ctx.chapter_id,p_access_unit_id,p_access_committee_id,cm.user_id)
          and private.chapter_records_member_allowed(ctx.chapter_id, cm.user_id)
      ) then raise exception 'invalid meeting attendance' using errcode = '22023'; end if;
      insert into public.meeting_attendance (record_id, chapter_id, user_id, attendance_status, recorded_by)
      values (target.id, ctx.chapter_id, (attendee->>'userId')::uuid, attendee->>'status', ctx.caller_id);
    end loop;

    if p_action = 'publish' and target.visibility = 'chapter' then
      for recipient in
        select cm.user_id from public.member_chapter_memberships cm
        join public.organization_memberships om on om.user_id = cm.user_id and om.organization_id = ctx.organization_id and om.status = 'active'
        where cm.chapter_id = ctx.chapter_id and cm.status = 'active'
          and private.chapter_scope_member_allowed(ctx.chapter_id,p_access_unit_id,p_access_committee_id,cm.user_id)
      loop
        begin
          perform private.notify_member(recipient.user_id, 'institutional.minutes.published', pg_catalog.jsonb_build_object('title', target.title), 'general');
          insert into public.meeting_minutes_dispatches (record_id, chapter_id, version, recipient_id, status, delivered_at)
          values (target.id, ctx.chapter_id, target.version, recipient.user_id, 'delivered', pg_catalog.now());
          delivered := delivered + 1;
        exception when others then
          insert into public.meeting_minutes_dispatches (record_id, chapter_id, version, recipient_id, status, error_code)
          values (target.id, ctx.chapter_id, target.version, recipient.user_id, 'failed', 'notification-write-failed');
        end;
      end loop;
    end if;
  end if;

  return pg_catalog.to_jsonb(target) || pg_catalog.jsonb_build_object('delivered', delivered);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION private.chapter_contact_entry_allowed(p_chapter text, p_subject uuid, p_case uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (select private.mfa_satisfied())
    and private.can_read_chapter_contact_record(p_chapter)
    and (
      private.member_has_chapter_role(p_chapter, array['steward','coordinator','advisor','admin','vp'])
      or private.chapter_organization_role_allowed(p_chapter,array['steward','coordinator','advisor','admin','vp'])
      or private.chapter_staff_member_allowed(
        p_chapter, p_subject, array['steward','coordinator','advisor','admin','vp'])
    )
    and (p_case is null or private.casework_can_read(p_case));
$function$;

CREATE OR REPLACE FUNCTION private.chapter_seniority_member_allowed(p_chapter text, p_target uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select p_target is not null
    and private.seniority_staff_can_manage(p_chapter)
    and private.seniority_chapter_member(p_chapter, p_target)
    and (
      private.member_has_chapter_role(p_chapter, array['steward','coordinator'])
      or private.chapter_organization_role_allowed(p_chapter,array['steward','coordinator'])
      or private.chapter_staff_member_allowed(p_chapter, p_target, array['steward','coordinator'])
      or (private.has_organization_role((select private.current_mobile_staff_organization()),array['steward'])
        and private.organization_steward_scope_allows((select auth.uid()),p_chapter,p_target))
    );
$function$;

CREATE OR REPLACE FUNCTION public.import_chapter_seniority(p_chapter_id text, p_rows jsonb, p_apply boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();

declare
  result jsonb;
begin
  if not private.seniority_staff_can_manage(p_chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_rows is null or pg_catalog.jsonb_typeof(p_rows) <> 'array' or pg_catalog.jsonb_array_length(p_rows) not between 1 and 500 then
    raise exception 'between 1 and 500 rows are required' using errcode = '22023', detail = 'seniority_import_size';
  end if;

  with permitted_members as materialized (
    select membership.user_id
    from public.member_chapter_memberships membership
    join public.chapters chapter on chapter.id = membership.chapter_id
    join public.organization_memberships organization_membership
      on organization_membership.user_id = membership.user_id
     and organization_membership.organization_id = chapter.organization_id
     and organization_membership.status = 'active'
    where membership.chapter_id = p_chapter_id and membership.status = 'active'
      and private.seniority_staff_can_manage(p_chapter_id)
      and (
        private.member_has_chapter_role(p_chapter_id, array['steward','coordinator'])
        or private.chapter_organization_role_allowed(p_chapter_id,array['steward','coordinator'])
        or (private.has_organization_role((select private.current_mobile_staff_organization()),array['steward'])
          and private.organization_steward_scope_allows((select auth.uid()),p_chapter_id,membership.user_id))
      )
    union
    select member.user_id from private.staff_visible_member_ids('steward') member(user_id)
      where private.member_has_chapter_staff_grant(p_chapter_id, array['steward'])
    union
    select member.user_id from private.staff_visible_member_ids('coordinator') member(user_id)
      where private.member_has_chapter_staff_grant(p_chapter_id, array['coordinator'])
), source as (
    select item.ordinality::integer as row_number,
      pg_catalog.lower(pg_catalog.btrim(coalesce(item.value ->> 'email', ''))) as email,
      coalesce(item.value ->> 'seniorityDate', '') as raw_date,
      nullif(pg_catalog.left(pg_catalog.btrim(coalesce(item.value ->> 'classification', '')), 120), '') as classification,
      nullif(pg_catalog.left(pg_catalog.btrim(coalesce(item.value ->> 'tieBreakNote', '')), 300), '') as tie_break_note
    from pg_catalog.jsonb_array_elements(p_rows) with ordinality as item(value, ordinality)
  ), shaped as (
    -- Built from the month's first day plus the day number, which never
    -- raises: an impossible day (February 30) rolls into the next month and
    -- fails the round trip below instead of aborting the whole file.
    select source.*,
      case when source.raw_date ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$'
        then pg_catalog.to_date(pg_catalog.substr(source.raw_date, 1, 7) || '-01', 'YYYY-MM-DD')
          + (pg_catalog.substr(source.raw_date, 9, 2)::integer - 1) end as candidate
    from source
  ), dated as (
    select shaped.*,
      case when pg_catalog.to_char(shaped.candidate, 'YYYY-MM-DD') = shaped.raw_date then shaped.candidate end as seniority_date
    from shaped
  ), members as (
    -- Active members of this chapter of its organization, by sign-in email.
    select account.id, pg_catalog.lower(account.email) as email, profile.full_name
    from public.member_chapter_memberships membership
    join public.chapters chapter on chapter.id = membership.chapter_id
    join public.organization_memberships organization_membership
      on organization_membership.user_id = membership.user_id
     and organization_membership.organization_id = chapter.organization_id
     and organization_membership.status = 'active'
    join auth.users account on account.id = membership.user_id
    join public.member_profiles profile on profile.id = membership.user_id
    where membership.chapter_id = p_chapter_id
      and membership.status = 'active'
      and account.id in (select user_id from permitted_members)
  ), matched as (
    select dated.*, members.id as user_id, members.full_name as name,
      pg_catalog.row_number() over (partition by members.id order by dated.row_number) as copy
    from dated
    left join members on members.email = dated.email and dated.email <> ''
  ), judged as (
    select matched.*,
      case
        when matched.seniority_date is null then 'invalid_date'
        when matched.user_id is null then 'no_member'
        when matched.copy > 1 then 'duplicate'
        else 'ready'
      end as outcome
    from matched
  ), saved as (
    insert into private.chapter_seniority_entries as e
      (organization_id, chapter_id, user_id, seniority_date, classification, tie_break_note)
    select chapter.organization_id, chapter.id, judged.user_id, judged.seniority_date, judged.classification, judged.tie_break_note
    from judged
    join public.chapters chapter on chapter.id = p_chapter_id
    where coalesce(p_apply, false) and judged.outcome = 'ready'
    on conflict (chapter_id, user_id) do update set
      seniority_date = excluded.seniority_date,
      classification = excluded.classification,
      tie_break_note = excluded.tie_break_note,
      updated_at = pg_catalog.now()
    returning 1
  )
  select pg_catalog.jsonb_build_object(
    'applied', coalesce(p_apply, false),
    'saved', (select pg_catalog.count(*)::integer from saved),
    'rows', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'row', judged.row_number,
      'outcome', judged.outcome,
      'userId', case when judged.outcome in ('ready', 'duplicate') then judged.user_id end,
      'name', case when judged.outcome in ('ready', 'duplicate') then judged.name end,
      'seniorityDate', judged.seniority_date,
      'classification', judged.classification
    ) order by judged.row_number) from judged), '[]'::jsonb)
  ) into result;
  return result;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.list_chapter_seniority(p_chapter_id text, p_after_date date DEFAULT NULL::date, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();

declare
  cap integer := greatest(1, least(coalesce(p_limit, 50), 200));
  result jsonb;
begin
  if not private.seniority_staff_can_manage(p_chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if (p_after_date is null) <> (p_after_id is null) then
    raise exception 'invalid cursor' using errcode = '22023';
  end if;

  with permitted_members as materialized (
    select membership.user_id
    from public.member_chapter_memberships membership
    join public.chapters chapter on chapter.id = membership.chapter_id
    join public.organization_memberships organization_membership
      on organization_membership.user_id = membership.user_id
     and organization_membership.organization_id = chapter.organization_id
     and organization_membership.status = 'active'
    where membership.chapter_id = p_chapter_id and membership.status = 'active'
      and private.seniority_staff_can_manage(p_chapter_id)
      and (
        private.member_has_chapter_role(p_chapter_id, array['steward','coordinator'])
        or private.chapter_organization_role_allowed(p_chapter_id,array['steward','coordinator'])
        or (private.has_organization_role((select private.current_mobile_staff_organization()),array['steward'])
          and private.organization_steward_scope_allows((select auth.uid()),p_chapter_id,membership.user_id))
      )
    union
    select member.user_id from private.staff_visible_member_ids('steward') member(user_id)
      where private.member_has_chapter_staff_grant(p_chapter_id, array['steward'])
    union
    select member.user_id from private.staff_visible_member_ids('coordinator') member(user_id)
      where private.member_has_chapter_staff_grant(p_chapter_id, array['coordinator'])

    union
    select retained.user_id from private.chapter_seniority_entries retained
    where retained.chapter_id=p_chapter_id
      and private.seniority_staff_can_manage(p_chapter_id)
      and (private.member_has_chapter_role(p_chapter_id,array['steward','coordinator'])
        or private.chapter_organization_role_allowed(p_chapter_id,array['steward','coordinator']))
), page as materialized (
    select e.*, profile.full_name,
      (select pg_catalog.count(*) from private.chapter_seniority_entries earlier
        where earlier.chapter_id = e.chapter_id
          and (earlier.seniority_date, earlier.id) < (e.seniority_date, e.id))::integer + 1 as position
    from private.chapter_seniority_entries e
    left join public.member_profiles profile on profile.id = e.user_id
    where e.chapter_id = p_chapter_id
      and e.user_id in (select user_id from permitted_members)
      and (p_after_date is null or (e.seniority_date, e.id) > (p_after_date, p_after_id))
    order by e.seniority_date, e.id
    limit cap + 1
  )
  select pg_catalog.jsonb_build_object(
    'items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', p.id,
        'userId', p.user_id,
        'name', coalesce(nullif(pg_catalog.btrim(coalesce(p.full_name, '')), ''), 'Member'),
        'position', p.position,
        'seniorityDate', p.seniority_date,
        'classification', p.classification,
        'tieBreakNote', p.tie_break_note,
        'question', case when p.question_status is null then null else pg_catalog.jsonb_build_object(
          'status', p.question_status, 'note', p.question_note, 'askedAt', p.questioned_at,
          'answer', p.answer_note, 'answeredAt', p.answered_at) end
      ) order by p.seniority_date, p.id)
      from (select * from page order by seniority_date, id limit cap) p
    ), '[]'::jsonb),
    'nextCursor', case when (select pg_catalog.count(*) from page) > cap then (
      select pg_catalog.jsonb_build_object('afterDate', last_row.seniority_date, 'afterId', last_row.id)
      from (select seniority_date, id from page order by seniority_date, id offset cap - 1 limit 1) last_row
    ) end,
    'openQuestions', (select pg_catalog.count(*)::integer from private.chapter_seniority_entries q
      where q.chapter_id = p_chapter_id and q.question_status = 'open'
        and q.user_id in (select user_id from permitted_members))
  ) into result;
  return result;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.search_chapter_seniority_members(p_chapter_id text, p_query text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();

declare
  needle text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_query, '')));
begin
  if not private.seniority_staff_can_manage(p_chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if pg_catalog.char_length(needle) > 80 then
    raise exception 'query too long' using errcode = '22023';
  end if;
  return coalesce((
    with permitted_members as materialized (
    select membership.user_id
    from public.member_chapter_memberships membership
    join public.chapters chapter on chapter.id = membership.chapter_id
    join public.organization_memberships organization_membership
      on organization_membership.user_id = membership.user_id
     and organization_membership.organization_id = chapter.organization_id
     and organization_membership.status = 'active'
    where membership.chapter_id = p_chapter_id and membership.status = 'active'
      and private.seniority_staff_can_manage(p_chapter_id)
      and (
        private.member_has_chapter_role(p_chapter_id, array['steward','coordinator'])
        or private.chapter_organization_role_allowed(p_chapter_id,array['steward','coordinator'])
        or (private.has_organization_role((select private.current_mobile_staff_organization()),array['steward'])
          and private.organization_steward_scope_allows((select auth.uid()),p_chapter_id,membership.user_id))
      )
    union
    select member.user_id from private.staff_visible_member_ids('steward') member(user_id)
      where private.member_has_chapter_staff_grant(p_chapter_id, array['steward'])
    union
    select member.user_id from private.staff_visible_member_ids('coordinator') member(user_id)
      where private.member_has_chapter_staff_grant(p_chapter_id, array['coordinator'])
)
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', found.user_id, 'name', found.name, 'listed', found.listed) order by found.name, found.user_id)
    from (
      select membership.user_id,
        coalesce(nullif(pg_catalog.btrim(coalesce(profile.full_name, '')), ''), 'Member') as name,
        exists (select 1 from private.chapter_seniority_entries e
          where e.chapter_id = p_chapter_id and e.user_id = membership.user_id) as listed
      from public.member_chapter_memberships membership
      join public.member_profiles profile on profile.id = membership.user_id
      where membership.chapter_id = p_chapter_id
        and membership.status = 'active'
        and private.seniority_chapter_member(p_chapter_id, membership.user_id)
        and membership.user_id in (select user_id from permitted_members)
        and (needle = '' or pg_catalog.strpos(pg_catalog.lower(coalesce(profile.full_name, '')), needle) > 0)
      order by 2, 1
      limit 25
    ) found
  ), '[]'::jsonb);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.save_chapter_seniority_entry(p_chapter_id text, p_user_id uuid, p_seniority_date date, p_classification text DEFAULT NULL::text, p_tie_break_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid(), p_user_id], array[]::uuid[]);
  perform private.member_pin_require_full_session();

declare
  entry_id uuid;
begin
  if not private.seniority_staff_can_manage(p_chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not (private.chapter_seniority_member_allowed(p_chapter_id, p_user_id)
    or private.member_has_chapter_role(p_chapter_id, array['steward','coordinator'])
    or private.chapter_organization_role_allowed(p_chapter_id,array['steward','coordinator'])) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_user_id is null or p_seniority_date is null
     or not private.seniority_chapter_member(p_chapter_id, p_user_id) then
    raise exception 'member of this chapter required' using errcode = '22023', detail = 'seniority_member_required';
  end if;

  insert into private.chapter_seniority_entries as e
    (organization_id, chapter_id, user_id, seniority_date, classification, tie_break_note)
  select chapter.organization_id, chapter.id, p_user_id, p_seniority_date,
    nullif(pg_catalog.btrim(coalesce(p_classification, '')), ''),
    nullif(pg_catalog.btrim(coalesce(p_tie_break_note, '')), '')
  from public.chapters chapter where chapter.id = p_chapter_id
  on conflict (chapter_id, user_id) do update set
    seniority_date = excluded.seniority_date,
    classification = excluded.classification,
    tie_break_note = excluded.tie_break_note,
    updated_at = pg_catalog.now()
  returning e.id into entry_id;

  return pg_catalog.jsonb_build_object('id', entry_id);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.list_chapter_bid_windows(p_chapter_id text, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();

declare
  cap integer := greatest(1, least(coalesce(p_limit, 20), 50));
  skip integer := greatest(0, least(coalesce(p_offset, 0), 10000));
  total integer;
  result jsonb;
  permitted_member_ids uuid[];
begin
  if not private.seniority_staff_can_manage(p_chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select coalesce(pg_catalog.array_agg(member.user_id),'{}'::uuid[]) into permitted_member_ids
  from (
    select membership.user_id
    from public.member_chapter_memberships membership
    join public.chapters chapter on chapter.id = membership.chapter_id
    join public.organization_memberships organization_membership
      on organization_membership.user_id = membership.user_id
     and organization_membership.organization_id = chapter.organization_id
     and organization_membership.status = 'active'
    where membership.chapter_id = p_chapter_id and membership.status = 'active'
      and private.seniority_staff_can_manage(p_chapter_id)
      and (
        private.member_has_chapter_role(p_chapter_id, array['steward','coordinator'])
        or private.chapter_organization_role_allowed(p_chapter_id,array['steward','coordinator'])
        or (private.has_organization_role((select private.current_mobile_staff_organization()),array['steward'])
          and private.organization_steward_scope_allows((select auth.uid()),p_chapter_id,membership.user_id))
      )
    union
    select member.user_id from private.staff_visible_member_ids('steward') member(user_id)
      where private.member_has_chapter_staff_grant(p_chapter_id, array['steward'])
    union
    select member.user_id from private.staff_visible_member_ids('coordinator') member(user_id)
      where private.member_has_chapter_staff_grant(p_chapter_id, array['coordinator'])
) member;

  select pg_catalog.count(*)::integer into total from private.chapter_bid_windows w where w.chapter_id = p_chapter_id;

  select pg_catalog.jsonb_build_object(
    'total', total,
    'nextOffset', case when skip + cap < total then skip + cap end,
    'windows', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', w.id,
      'subject', w.subject,
      'opensAt', w.opens_at,
      'closesAt', w.closes_at,
      'status', w.status,
      'bidCount', (select pg_catalog.count(*)::integer from private.chapter_bid_entries counted where counted.window_id = w.id and counted.user_id = any(permitted_member_ids)),
      -- The 500 most senior bids beside each bidder's place on the seniority
      -- list (a bidder with no entry sorts last); bidCount says how many there are.
      'bids', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', b.id,
          'userId', b.user_id,
          'name', coalesce(nullif(pg_catalog.btrim(coalesce(profile.full_name, '')), ''), 'Member'),
          'choice', b.choice,
          'award', b.award,
          'awardedAt', b.awarded_at,
          'seniorityDate', b.seniority_date,
          'classification', b.classification
        ) order by b.seniority_date nulls last, b.entry_id nulls last, b.recorded_at, b.id)
        from (
          select x.*, entry.seniority_date, entry.classification, entry.id as entry_id
          from private.chapter_bid_entries x
          left join private.chapter_seniority_entries entry on entry.chapter_id = w.chapter_id and entry.user_id = x.user_id
          where x.window_id = w.id and x.user_id = any(permitted_member_ids)
          order by entry.seniority_date nulls last, entry.id nulls last, x.recorded_at, x.id
          limit 500
        ) b
        left join public.member_profiles profile on profile.id = b.user_id
      ), '[]'::jsonb)
    ) order by w.closes_at desc, w.id), '[]'::jsonb)
  ) into result
  from (
    select * from private.chapter_bid_windows page
    where page.chapter_id = p_chapter_id
    order by page.closes_at desc, page.id
    limit cap offset skip
  ) w;
  return result;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_chapter_bid(p_window_id uuid, p_user_id uuid, p_choice text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid(), p_user_id], array[]::uuid[]);
  perform private.member_pin_require_full_session();

declare
  target private.chapter_bid_windows%rowtype;
  clean text := pg_catalog.btrim(coalesce(p_choice, ''));
  bid_id uuid;
  prior private.chapter_bid_entries%rowtype;
  cleared boolean := false;
begin
  select * into target from private.chapter_bid_windows w where w.id = p_window_id;
  if not found or not private.seniority_staff_can_manage(target.chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- Open by status and by the clock: no bid before the window opens or
  -- after it closes, even if nobody has marked it awarded yet.
  if target.status <> 'open' or pg_catalog.now() < target.opens_at or pg_catalog.now() >= target.closes_at then
    raise exception 'bid window is not open' using errcode = '22023', detail = 'bid_window_closed';
  end if;
  if not (private.chapter_seniority_member_allowed(target.chapter_id, p_user_id)
    or private.member_has_chapter_role(target.chapter_id, array['steward','coordinator'])
    or private.chapter_organization_role_allowed(target.chapter_id,array['steward','coordinator'])) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_user_id is null or not private.seniority_chapter_member(target.chapter_id, p_user_id) then
    raise exception 'member of this chapter required' using errcode = '22023', detail = 'seniority_member_required';
  end if;
  if pg_catalog.char_length(clean) not between 1 and 200 then
    raise exception 'choice must be between 1 and 200 characters' using errcode = '22023';
  end if;

  -- The bid as it stands, locked: an award made for another choice no longer
  -- describes this bid.
  select * into prior from private.chapter_bid_entries b
  where b.window_id = target.id and b.user_id = p_user_id
  for update;
  cleared := prior.id is not null and prior.award is not null and prior.choice is distinct from clean;

  insert into private.chapter_bid_entries as b (window_id, user_id, choice)
  values (target.id, p_user_id, clean)
  on conflict (window_id, user_id) do update set
    choice = excluded.choice,
    recorded_at = pg_catalog.now(),
    award = case when b.choice is distinct from excluded.choice then null else b.award end,
    awarded_at = case when b.choice is distinct from excluded.choice then null else b.awarded_at end
  returning b.id into bid_id;
  return pg_catalog.jsonb_build_object('id', bid_id, 'awardCleared', cleared);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.list_chapter_bid_window_bids(p_window_id uuid, p_offset integer DEFAULT 0, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();

declare
  target private.chapter_bid_windows%rowtype;
  cap integer := greatest(1, least(coalesce(p_limit, 100), 500));
  -- No upper bound on the offset: every bid of a window stays reachable
  -- (gate r2s3). nextOffset is computed only below the total, so it cannot
  -- overflow.
  skip integer := greatest(0, coalesce(p_offset, 0));
  total integer;
  page jsonb;
  permitted_member_ids uuid[];
begin
  select * into target from private.chapter_bid_windows w where w.id = p_window_id;
  if not found or not private.seniority_staff_can_manage(target.chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select coalesce(pg_catalog.array_agg(member.user_id),'{}'::uuid[]) into permitted_member_ids
  from (
    select membership.user_id
    from public.member_chapter_memberships membership
    join public.chapters chapter on chapter.id = membership.chapter_id
    join public.organization_memberships organization_membership
      on organization_membership.user_id = membership.user_id
     and organization_membership.organization_id = chapter.organization_id
     and organization_membership.status = 'active'
    where membership.chapter_id = target.chapter_id and membership.status = 'active'
      and private.seniority_staff_can_manage(target.chapter_id)
      and (
        private.member_has_chapter_role(target.chapter_id, array['steward','coordinator'])
        or private.chapter_organization_role_allowed(target.chapter_id,array['steward','coordinator'])
        or (private.has_organization_role((select private.current_mobile_staff_organization()),array['steward'])
          and private.organization_steward_scope_allows((select auth.uid()),target.chapter_id,membership.user_id))
      )
    union
    select member.user_id from private.staff_visible_member_ids('steward') member(user_id)
      where private.member_has_chapter_staff_grant(target.chapter_id, array['steward'])
    union
    select member.user_id from private.staff_visible_member_ids('coordinator') member(user_id)
      where private.member_has_chapter_staff_grant(target.chapter_id, array['coordinator'])
) member;

  select pg_catalog.count(*)::integer into total from private.chapter_bid_entries counted where counted.window_id = target.id and counted.user_id = any(permitted_member_ids);

  -- The order and fields of list_chapter_bid_windows' first 500, so page
  -- offset 500 continues exactly where that list stops.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', b.id,
      'userId', b.user_id,
      'name', coalesce(nullif(pg_catalog.btrim(coalesce(profile.full_name, '')), ''), 'Member'),
      'choice', b.choice,
      'award', b.award,
      'awardedAt', b.awarded_at,
      'seniorityDate', b.seniority_date,
      'classification', b.classification
    ) order by b.seniority_date nulls last, b.entry_id nulls last, b.recorded_at, b.id), '[]'::jsonb)
  into page
  from (
    select x.*, entry.seniority_date, entry.classification, entry.id as entry_id
    from private.chapter_bid_entries x
    left join private.chapter_seniority_entries entry on entry.chapter_id = target.chapter_id and entry.user_id = x.user_id
    where x.window_id = target.id and x.user_id = any(permitted_member_ids)
    order by entry.seniority_date nulls last, entry.id nulls last, x.recorded_at, x.id
    limit cap offset skip
  ) b
  left join public.member_profiles profile on profile.id = b.user_id;

  return pg_catalog.jsonb_build_object(
    'windowId', target.id,
    'total', total,
    'nextOffset', case when skip::bigint + cap < total then skip + cap end,
    'bids', page
  );
end;
end;
$function$;

CREATE OR REPLACE FUNCTION private.chapter_staff_member_allowed(p_chapter text, p_target uuid, p_roles text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select p_target is not null
    and (select private.mfa_satisfied())
    and exists (
      select 1 from pg_catalog.unnest(p_roles) requested(role)
      where (private.member_has_chapter_staff_grant(p_chapter, array[requested.role])
        or private.chapter_organization_role_allowed(p_chapter,array[requested.role])
        or (requested.role='steward' and private.organization_steward_scope_allows((select auth.uid()),p_chapter,p_target)))
        and public.staff_can_see_user(p_target, requested.role)
    );
$function$;

CREATE OR REPLACE FUNCTION public.delete_chapter_seniority_entry(p_entry_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid(), (select e.user_id from private.chapter_seniority_entries e where e.id = p_entry_id)], array[]::uuid[]);
  perform private.member_pin_require_full_session();

declare
  target private.chapter_seniority_entries%rowtype;
begin
  select * into target from private.chapter_seniority_entries e where e.id = p_entry_id;
  if not found or not private.seniority_staff_can_manage(target.chapter_id)
    or not (private.chapter_seniority_member_allowed(target.chapter_id, target.user_id) or private.member_has_chapter_role(target.chapter_id,array['steward','coordinator']) or private.chapter_organization_role_allowed(target.chapter_id,array['steward','coordinator'])) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  delete from private.chapter_seniority_entries e where e.id = target.id;
  return pg_catalog.jsonb_build_object('deleted', true);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.answer_chapter_seniority_question(p_entry_id uuid, p_answer text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid(), (select e.user_id from private.chapter_seniority_entries e where e.id = p_entry_id)], array[]::uuid[]);
  perform private.member_pin_require_full_session();

declare
  target private.chapter_seniority_entries%rowtype;
  clean text := nullif(pg_catalog.btrim(coalesce(p_answer, '')), '');
begin
  select * into target from private.chapter_seniority_entries e where e.id = p_entry_id;
  if not found or not private.seniority_staff_can_manage(target.chapter_id)
    or not (private.chapter_seniority_member_allowed(target.chapter_id, target.user_id) or private.member_has_chapter_role(target.chapter_id,array['steward','coordinator']) or private.chapter_organization_role_allowed(target.chapter_id,array['steward','coordinator'])) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if target.question_status is distinct from 'open' then
    raise exception 'no open question' using errcode = '22023', detail = 'seniority_no_open_question';
  end if;
  if clean is null or pg_catalog.char_length(clean) > 1000 then
    raise exception 'answer must be between 1 and 1000 characters' using errcode = '22023';
  end if;
  update private.chapter_seniority_entries e
  set question_status = 'answered', answer_note = clean, answered_at = pg_catalog.now(), updated_at = pg_catalog.now()
  where e.id = target.id;
  return pg_catalog.jsonb_build_object('id', target.id, 'status', 'answered');
end;
end;
$function$;

CREATE OR REPLACE FUNCTION private.chapter_officer_can(p_chapter text, p_capability text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (select auth.uid()) is not null and private.mfa_satisfied() and not private.member_pin_session_restricted()
    and exists (select 1 from public.chapters c
      where c.id=p_chapter and c.organization_id=private.current_member_organization()
        and exists(select 1 from public.member_chapter_memberships m where m.user_id=(select auth.uid()) and m.chapter_id=c.id and m.status='active')
        and exists(select 1 from public.organization_memberships m where m.user_id=(select auth.uid()) and m.organization_id=c.organization_id and m.status='active')
        and (not private.staff_mfa_required(c.organization_id) or private.has_second_factor((select auth.uid())))
        and (private.has_organization_role(c.organization_id,array['admin'])
          or private.member_has_chapter_role(c.id,array['admin','vp'])
          or exists(select 1 from private.chapter_role_capabilities cap
            join public.member_role_chapters r on r.role=cap.role and r.chapter_id=c.id and r.user_id=(select auth.uid())
            left join private.chapter_role_settings setting on setting.chapter_id=c.id and setting.role=cap.role and setting.capability=cap.capability
            where cap.capability=p_capability and coalesce(setting.enabled,true)
              and not exists(select 1 from private.steward_assignment_scopes((select auth.uid()),p_chapter) s where s.user_id=r.user_id and s.chapter_id=r.chapter_id and s.role=r.role))));
$function$;

alter policy chapter_records_select on public.chapter_records using (((((private.chapter_record_publication(record_type) = 'chapter_members'::text) AND (lifecycle_status = 'published'::text) AND (visibility = 'chapter'::text) AND (archived_at IS NULL) AND COALESCE(((( SELECT private.chapter_records_scope_memo('member'::text) AS chapter_records_scope_memo) ->> chapter_id))::boolean, private.can_read_chapter_member_record(chapter_id))) OR ((archived_at IS NULL) AND COALESCE(((( SELECT private.chapter_records_scope_memo('contact'::text) AS chapter_records_scope_memo) ->> chapter_id))::boolean, private.can_read_chapter_contact_record(chapter_id))) OR ((private.chapter_record_publication(record_type) = 'chapter_members'::text) AND COALESCE(((( SELECT private.chapter_records_scope_memo('officer'::text) AS chapter_records_scope_memo) ->> (jsonb_build_array(chapter_id, access_unit_id, access_committee_id))::text))::boolean, private.chapter_officer_can_for_scope(chapter_id, 'records'::text, access_unit_id, access_committee_id)))) AND ((record_type <> 'member_contact'::text) OR COALESCE(((( SELECT private.chapter_records_scope_memo('broad-staff'::text) AS chapter_records_scope_memo) ->> chapter_id))::boolean, (private.member_has_chapter_role(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]) OR private.chapter_organization_role_allowed(chapter_records.chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text])))) AND (((access_unit_id IS NULL) AND (access_committee_id IS NULL)) OR COALESCE(((( SELECT private.chapter_records_scope_memo('manageable'::text) AS chapter_records_scope_memo) ->> (jsonb_build_array(chapter_id, access_unit_id, access_committee_id))::text))::boolean, private.chapter_record_manageable(chapter_id, access_unit_id, access_committee_id)) OR ((((access_unit_id IS NULL) AND (access_committee_id IS NULL)) OR COALESCE(((( SELECT private.chapter_records_scope_memo('container'::text) AS chapter_records_scope_memo) ->> (jsonb_build_array(chapter_id, access_unit_id, access_committee_id))::text))::boolean, (private.chapter_record_manageable(chapter_id, access_unit_id, access_committee_id) OR private.chapter_scope_member_allowed(chapter_id, access_unit_id, access_committee_id, ( SELECT auth.uid() AS uid))))) AND (COALESCE(((( SELECT private.chapter_records_scope_memo('broad-staff'::text) AS chapter_records_scope_memo) ->> chapter_id))::boolean, (private.member_has_chapter_role(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]) OR private.chapter_organization_role_allowed(chapter_records.chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]))) OR ((private.chapter_record_publication(record_type) = 'chapter_members'::text) AND (lifecycle_status = 'published'::text) AND (visibility = 'chapter'::text)))))));
comment on policy chapter_records_select on public.chapter_records is 'A steward retains chapter-wide legacy contact reads only while the exact assignment has its migration-only carry-over mark; an explicit unit choice narrows the memo and fallback together. Other staff and published member access keep their existing authority.';

-- A mark may be inserted only by the earlier migration-only data statement.
-- Explicit mark writes run before the unit-choice trigger and cannot hide an
-- attempt to set true by changing the unit in the same statement.
create trigger a01_reject_carry_over_insert before insert on private.chapter_role_scopes
for each row execute function private.reject_steward_carry_over_write();
create trigger a01_reject_carry_over_update before update of legacy_chapter_coverage on private.chapter_role_scopes
for each row execute function private.reject_steward_carry_over_write();
create trigger a02_clear_carry_over_on_choice before update of unit_id,committee_id,user_id,chapter_id,role on private.chapter_role_scopes
for each row execute function private.clear_steward_carry_over_on_choice();
create constraint trigger steward_grant_requires_unit after insert or update on public.member_role_chapters
deferrable initially deferred for each row execute function private.enforce_steward_unit_assignment();
create constraint trigger organization_steward_requires_units after insert or update on public.organization_role_grants
deferrable initially deferred for each row execute function private.enforce_organization_steward_units();
create constraint trigger steward_scope_requires_grant_unit after delete or update on private.chapter_role_scopes
deferrable initially deferred for each row execute function private.enforce_steward_unit_assignment();
create trigger chapter_gets_default_unit after insert or update of organization_id on public.chapters
for each row execute function private.create_chapter_default_unit();
create constraint trigger chapter_keeps_one_unit after delete or update of chapter_id on private.chapter_units
deferrable initially deferred for each row execute function private.enforce_chapter_has_unit();

-- The organization-backed form may only be inserted by the earlier backfill.
create trigger a01_reject_organization_assignment_insert before insert on private.organization_steward_unit_assignments
for each row execute function private.reject_new_organization_steward_assignment();
create trigger a01_reject_organization_carry_over_update before update of legacy_chapter_coverage on private.organization_steward_unit_assignments
for each row execute function private.reject_steward_carry_over_write();
create trigger a02_clear_organization_carry_over_on_choice before update of unit_id,user_id,chapter_id,role,organization_id on private.organization_steward_unit_assignments
for each row execute function private.clear_steward_carry_over_on_choice();
create constraint trigger one_steward_chapter_assignment after insert or update on private.chapter_role_scopes
deferrable initially deferred for each row execute function private.enforce_one_steward_assignment();
create constraint trigger one_steward_organization_assignment after insert or update on private.organization_steward_unit_assignments
deferrable initially deferred for each row execute function private.enforce_one_steward_assignment();

create trigger a01_reject_organization_assignment_key_update before update of organization_id,user_id,chapter_id,role on private.organization_steward_unit_assignments
for each row execute function private.reject_new_organization_steward_assignment();
create constraint trigger organization_assignment_requires_grant_unit after update or delete on private.organization_steward_unit_assignments
deferrable initially deferred for each row execute function private.enforce_organization_steward_assignment();

-- Gate round 1 (#8589): writers that could still ask for a steward with no
-- unit. A directory (SCIM) group cannot supply a unit, so Steward is no
-- longer a mappable starting role; groups already mapped to it start no role,
-- and an admin grants Steward with a unit under Roles, units and committees.
-- An unfinished or resendable steward invitation (directory or admin) with no
-- unit anywhere in its resend chain could never be finished: the person would
-- not even join. It invites them as a plain member instead, never at a higher
-- role, with one audit row each; an admin then grants Steward with a unit.
alter table public.member_invitation_audit drop constraint member_invitation_audit_action_check,
  add constraint member_invitation_audit_action_check check (action in (
    'invite_requested','invite_sent','invite_delivery_failed',
    'invite_resent','invite_revoked','invite_claimed','invite_accepted',
    'invite_expired','reinvite_requested','reinvite_accepted','invite_restored','invite_role_cleared'));
-- BEGIN MIGRATION-ONLY UNIT-LESS STEWARD RESET (retained verbatim for its proof).
with cleared as (
  update public.scim_groups set mapped_role=null,updated_at=pg_catalog.clock_timestamp()
  where mapped_role='steward'
  returning id,organization_id
)
-- The tenant audit writer derives its organization from a session and an
-- organization-stamped admin row needs an actor; a migration has neither, so
-- this row uses the backfill's own audit shape with the organization in detail.
insert into public.member_admin_audit(actor,action,target_user,detail)
select null,'role_scope_updated',null,pg_catalog.jsonb_build_object(
  'organizationId',cleared.organization_id,'provider','scim','scimGroupId',cleared.id,'role','steward','mappedRole',null,
  'reason','steward_requires_unit','source','migration-7663')
from cleared;
with cleared as (
  update public.member_invitations invitation set initial_role=null
  where invitation.initial_role='steward'
    and invitation.status in ('pending','accepting','delivery_failed','expired')
    and private.member_invitation_selected_unit(invitation.id,invitation.chapter_id) is null
  returning invitation.id,invitation.chapter_id,invitation.delivery_version
)
select private.audit_member_invitation(cleared.id,cleared.chapter_id,null,'invite_role_cleared',pg_catalog.jsonb_build_object(
  'chapterId',cleared.chapter_id,'previousRole','steward','reason','steward_requires_unit',
  'deliveryVersion',cleared.delivery_version,'source','migration-7663'))
from cleared;
-- END MIGRATION-ONLY UNIT-LESS STEWARD RESET.
-- #8589 final: settle this block's pending deferred checks before any DDL on
-- the tables it wrote (ALTER TABLE refuses pending trigger events, 55006),
-- then restore deferred mode for the rest of the migration.
set constraints all immediate;
set constraints all deferred;
-- From here on no writer (desk, resend, directory sync or a future path)
-- can leave an open steward invitation without a unit in its resend chain.
CREATE FUNCTION private.enforce_steward_invitation_unit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.initial_role='steward' and new.status in ('pending','accepting','delivery_failed','expired')
     and exists(select 1 from public.member_invitations current_row
       where current_row.id=new.id and current_row.initial_role='steward'
         and current_row.status in ('pending','accepting','delivery_failed','expired'))
     and private.member_invitation_selected_unit(new.id,new.chapter_id) is null then
    raise exception 'steward invitation requires a unit' using errcode='23514';
  end if;
  return null;
end;
$function$;
revoke all on function private.enforce_steward_invitation_unit() from public,anon,authenticated,service_role;
create constraint trigger steward_invitation_requires_unit after insert or update of initial_role,status,replaces_id,chapter_id
on public.member_invitations deferrable initially deferred for each row execute function private.enforce_steward_invitation_unit();

-- #8589 round 2: removing a unit cascades its reservation links, which the
-- invitation check above never sees. An open steward invitation, or a resend
-- of it, keeps a unit through its resend chain until it is revoked or resent.
CREATE FUNCTION private.enforce_invitation_unit_reservation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if exists(
    with recursive dependants(id,depth) as (
      select invitation.id,0 from public.member_invitations invitation where invitation.id=old.invitation_id
      union all
      select invitation.id,dependants.depth+1 from public.member_invitations invitation
      join dependants on invitation.replaces_id=dependants.id where dependants.depth<20
    )
    select 1 from dependants join public.member_invitations invitation on invitation.id=dependants.id
    where invitation.initial_role='steward'
      and invitation.status in ('pending','accepting','delivery_failed','expired')
      and private.member_invitation_selected_unit(invitation.id,invitation.chapter_id) is null) then
    raise exception 'unit is reserved by an open steward invitation: revoke the invitation or resend it with another unit first' using errcode='23514';
  end if;
  return null;
end;
$function$;
revoke all on function private.enforce_invitation_unit_reservation() from public,anon,authenticated,service_role;
create constraint trigger invitation_unit_reservation_kept after delete or update on private.member_invitation_units
deferrable initially deferred for each row execute function private.enforce_invitation_unit_reservation();

-- #8589 re-final: the grievance scope reads an organization steward grant
-- only through the chapter's assignment, like the other steward readers.
CREATE OR REPLACE FUNCTION private.chapter_grievance_steward_scope(p_chapter text, p_target uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (select auth.uid()) is not null and private.mfa_satisfied()
    and exists(select 1 from public.chapters c
      join public.organization_memberships om on om.organization_id=c.organization_id and om.user_id=p_target and om.status='active'
      join public.member_chapter_memberships cm on cm.chapter_id=c.id and cm.user_id=p_target and cm.status='active'
      where c.id=p_chapter and c.organization_id=private.current_member_organization()
        and (not private.staff_mfa_required(c.organization_id) or private.has_second_factor((select auth.uid())))
        and (private.chapter_organization_role_allowed(p_chapter,array['steward'])
          or private.member_has_chapter_role(p_chapter,array['steward'])
          or private.actor_role_covers_member((select auth.uid()),p_chapter,'steward',p_target,true)
          or exists(select 1 from public.member_role_chapters r
            join public.chapters source on source.id=r.chapter_id and source.organization_id=c.organization_id
            join public.member_chapter_memberships m on m.chapter_id=r.chapter_id and m.user_id=r.user_id and m.status='active'
            join private.chapter_access_policies policy on policy.chapter_id=r.chapter_id and policy.steward_breadth='local' and policy.steward_grievances
            where r.user_id=(select auth.uid()) and r.role='steward'
              and private.member_has_chapter_role(r.chapter_id,array['steward']))));
$function$;

-- #8589 re-final: approving a Steward request needs the unit the decider
-- chose; the two-argument form keeps other roles working and refuses a
-- Steward approval with a clear 22023.
CREATE FUNCTION public.decide_member_request(p_request_id uuid, p_decision text, p_unit_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  clean_decision text := pg_catalog.btrim(coalesce(p_decision, ''));
  found_row public.member_requests%rowtype;
  saved public.member_requests%rowtype;
  chapter_name text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if clean_decision not in ('approved', 'declined') then
    raise exception 'invalid decision' using errcode = '22023';
  end if;

  select * into found_row
  from public.member_requests r
  where r.id = p_request_id and r.organization_id = org and r.status = 'pending'
  for update;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if not private.member_request_decidable(found_row.kind, found_row.organization_id, found_row.chapter_id) then
    raise exception 'not permitted to decide this request' using errcode = '42501';
  end if;

  if found_row.kind = 'invitation_suggestion' then
    -- Approving a suggestion creates its invitation in the same transaction:
    -- public.approve_member_request_invitation, through the invitation route.
    if clean_decision = 'approved' then
      raise exception 'approve through the invitation route' using errcode = '22023';
    end if;
    -- A suggestion whose address already has an open invitation in that
    -- chapter (from the invitation page) cannot be declined: that invitation
    -- stands until it is revoked there. An invitation accepted in the past is
    -- history, not an open invitation, and blocks nothing.
    if exists (
      select 1 from public.member_invitations i
      where i.normalized_email = found_row.invitee_email and i.chapter_id = found_row.chapter_id
        and (i.status = 'accepting' or (i.status = 'pending' and i.expires_at > pg_catalog.now()))
    ) then
      raise exception 'invitation already sent' using errcode = '55000';
    end if;
  end if;

  -- An approved access request grants the role through the existing writer,
  -- which checks the caller's authority and the member's membership again.
  -- #7663: a steward is granted only with the unit the decider chose.
  if clean_decision = 'approved' and found_row.requested_role = 'steward' then
    if p_unit_id is null then
      raise exception 'steward approval requires a chapter unit' using errcode = '22023';
    end if;
    perform public.set_member_access_role(found_row.requester_user_id, found_row.chapter_id, 'steward', true, p_unit_id, null::uuid);
  elsif clean_decision = 'approved' then
    perform public.set_member_chapter_role(found_row.requester_user_id, found_row.chapter_id, found_row.requested_role, true);
  end if;

  update public.member_requests r
  set status = clean_decision, decided_at = pg_catalog.now(), decided_by = caller
  where r.id = found_row.id
  returning * into saved;

  select c.name into chapter_name from public.chapters c where c.id = saved.chapter_id;
  perform private.notify_member(saved.requester_user_id,
    'requests.' || case saved.kind when 'invitation_suggestion' then 'suggestion' else 'access' end || '.' || clean_decision,
    pg_catalog.jsonb_build_object('name', coalesce(saved.invitee_name, ''), 'chapter', coalesce(chapter_name, saved.chapter_id)),
    'general');

  return private.member_request_json(saved);
end;
end;
$function$;
revoke all on function public.decide_member_request(uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.decide_member_request(uuid,text,uuid) to authenticated;
CREATE OR REPLACE FUNCTION public.decide_member_request(p_request_id uuid, p_decision text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return public.decide_member_request(p_request_id, p_decision, null::uuid);
end;
$function$;

-- #8589 final: moving a unit to another chapter (public.save_chapter_unit)
-- keeps its reservation links, which then no longer match the invitation's
-- chapter. Refuse the move while an open steward invitation still needs it.
CREATE FUNCTION private.enforce_reserved_unit_chapter()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.chapter_id is distinct from old.chapter_id and exists(
    with recursive dependants(id,depth) as (
      select link.invitation_id,0 from private.member_invitation_units link where link.unit_id=new.id
      union all
      select invitation.id,dependants.depth+1 from public.member_invitations invitation
      join dependants on invitation.replaces_id=dependants.id where dependants.depth<20
    )
    select 1 from dependants join public.member_invitations invitation on invitation.id=dependants.id
    where invitation.initial_role='steward'
      and invitation.status in ('pending','accepting','delivery_failed','expired')
      and private.member_invitation_selected_unit(invitation.id,invitation.chapter_id) is null) then
    raise exception 'unit is reserved by an open steward invitation: revoke the invitation or resend it with another unit before moving the unit' using errcode='23514';
  end if;
  return null;
end;
$function$;
revoke all on function private.enforce_reserved_unit_chapter() from public,anon,authenticated,service_role;
create constraint trigger reserved_unit_stays_in_chapter after update of chapter_id on private.chapter_units
deferrable initially deferred for each row execute function private.enforce_reserved_unit_chapter();

alter table public.scim_groups drop constraint scim_groups_mapped_role,
  add constraint scim_groups_mapped_role check (mapped_role is null or mapped_role in ('coordinator','advisor'));
comment on column public.scim_groups.mapped_role is
  'Starting role for new SCIM invitations of this group''s members (coordinator or advisor). Null grants nothing. Admin-only writer. Steward needs a chapter unit (#7663), which a group cannot supply.';

CREATE OR REPLACE FUNCTION public.set_scim_group_role(p_group_id uuid, p_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())]::uuid[], array[]::uuid[]);
declare
  org uuid;
  member_row record;
begin
  org := private.scim_admin_organization(true);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  -- #7663: a steward needs a chapter unit, which a directory group cannot supply.
  if p_role = 'steward' then
    raise exception 'steward needs a unit: map coordinator or advisor, or grant steward with a unit under Roles, units and committees' using errcode = '22023';
  end if;
  if p_role is not null and p_role not in ('coordinator', 'advisor') then
    raise exception 'unsupported role' using errcode = '22023';
  end if;
  update public.scim_groups
  set mapped_role = p_role, updated_at = pg_catalog.clock_timestamp()
  where id = p_group_id and organization_id = org;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  -- Re-align the starting role of open SCIM invitations of this group.
  for member_row in
    select u.id from public.scim_group_members m
    join public.scim_users u on u.id = m.user_id and u.organization_id = org
    where m.group_id = p_group_id and u.provisioning_state = 'invited' and u.active
  loop
    perform private.scim_reconcile_user(member_row.id, null);
  end loop;
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', 'scim', 'action', 'group_role_mapped', 'role', coalesce(p_role, 'none'),
    'entityId', p_group_id));
  return public.get_scim_control();
end;
end;
$function$;

CREATE OR REPLACE FUNCTION private.learning_undo_organization_role(p_mode text, p_entry jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target text := p_entry ->> 'target_id';
  org uuid := pg_catalog.split_part(p_entry ->> 'target_id', ':', 1)::uuid;
  member uuid := pg_catalog.split_part(p_entry ->> 'target_id', ':', 2)::uuid;
  role_name text := pg_catalog.split_part(p_entry ->> 'target_id', ':', 3);
  wanted boolean := (p_entry -> 'before_image' ->> 'granted')::boolean;
  holds boolean;
begin
  if p_mode = 'lock' then
    -- The forward path's tenant lock, so a queued role change waits for us.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:' || org::text, 509));
    return null;
  elsif p_mode = 'state' then
    return private.learning_membership_state('public.organization_role_grants', target);
  elsif p_mode = 'before' then
    return p_entry -> 'before_image';
  end if;
  holds := exists (select 1 from public.organization_role_grants g
    where g.organization_id = org and g.user_id = member and g.role = role_name);
  if p_mode = 'check' then
    if org is distinct from private.current_mobile_staff_organization()
       or not private.has_organization_role(org, array['admin']) then
      raise exception 'you can no longer change organization roles' using errcode = '42501';
    end if;
    if wanted and not exists (
      select 1 from public.organization_memberships om
      where om.organization_id = org and om.user_id = member and om.status = 'active'
    ) then
      raise exception 'active organization membership required' using errcode = '22023';
    end if;
    -- #7663: today's rule refuses an organization-wide steward grant; its unit
    -- assignments went with the removal and only the migration created them.
    if wanted and not holds and role_name = 'steward' then
      raise exception 'steward access requires a chapter and unit' using errcode = '22023';
    end if;
    if not wanted and holds and role_name = 'admin' and (
      select pg_catalog.count(*) from public.organization_role_grants g
      where g.organization_id = org and g.role = 'admin') <= 1 then
      raise exception 'cannot remove the last organization admin' using errcode = '22023';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if wanted and not holds then
    insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
    values (org, member, role_name, caller);
  elsif not wanted and holds then
    delete from public.organization_role_grants g
    where g.organization_id = org and g.user_id = member and g.role = role_name;
  else
    return null;
  end if;
  insert into public.organization_audit_events (organization_id, event_type, actor_user_id, idempotency_key, metadata)
  values (org, case when wanted then 'organization_role_granted' else 'organization_role_revoked' end, caller,
    extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object('organizationId', org::text, 'userId', member::text, 'role', role_name,
      'action', 'learning_undo', 'entityId', p_entry ->> 'id'));
  return null;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION private.learning_undo_chapter_role(p_mode text, p_entry jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target text := p_entry ->> 'target_id';
  member uuid := pg_catalog.split_part(p_entry ->> 'target_id', ':', 1)::uuid;
  role_name text := pg_catalog.split_part(p_entry ->> 'target_id', ':', 2);
  chapter text := pg_catalog.split_part(p_entry ->> 'target_id', ':', 3);
  image jsonb := p_entry -> 'before_image';
  wanted boolean := (p_entry -> 'before_image' ->> 'granted')::boolean;
  wanted_unit uuid := (p_entry -> 'before_image' ->> 'unit_id')::uuid;
  wanted_committee uuid := (p_entry -> 'before_image' ->> 'committee_id')::uuid;
  chapter_org uuid;
  org_admin boolean;
  current_state jsonb;
begin
  select c.organization_id into chapter_org from public.chapters c where c.id = chapter;
  if p_mode = 'lock' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:' || chapter_org::text, 509));
    return null;
  elsif p_mode = 'state' then
    return private.learning_membership_state('public.member_role_chapters', target);
  elsif p_mode = 'before' then
    return image;
  end if;
  current_state := private.learning_membership_state('public.member_role_chapters', target);
  if p_mode = 'check' then
    org_admin := private.has_organization_role(chapter_org, array['admin']);
    if chapter_org is null or chapter_org is distinct from private.current_mobile_staff_organization()
       or (not org_admin and (chapter is distinct from private.current_member_chapter()
         or not (private.member_has_chapter_role(chapter, array['admin'])
           or (role_name in ('secretary', 'records', 'treasurer') and private.member_has_chapter_role(chapter, array['vp']))))) then
      raise exception 'you can no longer change this role' using errcode = '42501';
    end if;
    -- A scope is set or cleared only by someone who may scope roles today.
    if (wanted_unit is not null or wanted_committee is not null
        or current_state ->> 'unit_id' is not null or current_state ->> 'committee_id' is not null)
       and not (private.has_organization_role(chapter_org, array['admin']) or private.chapter_access_leadership(chapter)) then
      raise exception 'chapter leadership required' using errcode = '42501';
    end if;
    if wanted then
      if not exists (select 1 from public.member_chapter_memberships m
          where m.user_id = member and m.chapter_id = chapter and m.status = 'active')
         or not exists (select 1 from public.organization_memberships om
          where om.user_id = member and om.organization_id = chapter_org and om.status = 'active') then
        raise exception 'active chapter membership required' using errcode = '22023';
      end if;
      if (wanted_unit is not null and not exists (select 1 from private.chapter_units u where u.id = wanted_unit and u.chapter_id = chapter))
         or (wanted_committee is not null and not exists (select 1 from private.chapter_committees k where k.id = wanted_committee and k.chapter_id = chapter)) then
        raise exception 'role scope no longer exists' using errcode = '22023';
      end if;
      -- #7663: a steward is restored only with exactly one chapter unit; a
      -- before-image recorded with none (or a committee) cannot be put back.
      if role_name = 'steward' and (wanted_unit is null or wanted_committee is not null) then
        raise exception 'steward access requires a chapter and unit' using errcode = '22023';
      end if;
    elsif role_name = 'admin' and member = caller and chapter = private.current_member_chapter() then
      raise exception 'an admin cannot remove the active admin role from this session' using errcode = '22023';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if wanted then
    insert into public.member_roles (user_id, role, granted_by, chapter_id)
    values (member, role_name, caller, chapter)
    on conflict (user_id, role) do nothing;
    insert into public.member_role_chapters (user_id, role, chapter_id, granted_by)
    values (member, role_name, chapter, caller)
    on conflict (user_id, role, chapter_id) do nothing;
    if wanted_unit is not null or wanted_committee is not null then
      insert into private.chapter_role_scopes (user_id, chapter_id, role, unit_id, committee_id)
      values (member, chapter, role_name, wanted_unit, wanted_committee)
      on conflict (user_id, chapter_id, role) do update set unit_id = excluded.unit_id, committee_id = excluded.committee_id;
    else
      delete from private.chapter_role_scopes s where s.user_id = member and s.chapter_id = chapter and s.role = role_name;
    end if;
  else
    delete from public.member_role_chapters rc
    where rc.user_id = member and rc.role = role_name and rc.chapter_id = chapter;
    -- #8311: repoint a legacy row that named this chapter to one that still
    -- holds the role, or drop it, as the forward revoke does.
    perform private.reconcile_legacy_member_roles(member, role_name);
  end if;
  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (caller,
    case when wanted is distinct from (current_state ->> 'granted')::boolean
      then case when wanted then 'grant_role' else 'revoke_role' end else 'role_scope_updated' end,
    member,
    pg_catalog.jsonb_build_object('role', role_name, 'chapterId', chapter, 'unitId', wanted_unit,
      'committeeId', wanted_committee, 'learningUndo', true));
  insert into public.organization_audit_events (organization_id, event_type, actor_user_id, idempotency_key, metadata)
  values (chapter_org, case when wanted then 'organization_role_granted' else 'organization_role_revoked' end, caller,
    extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object('organizationId', chapter_org::text, 'chapterId', chapter, 'userId', member::text,
      'role', role_name, 'action', 'learning_undo', 'entityId', p_entry ->> 'id'));
  return null;
end;
end;
$function$;

update private.account_lifecycle_manifest set export_columns=array_append(export_columns,'legacy_chapter_coverage') where schema_name='private' and table_name='chapter_role_scopes' and not ('legacy_chapter_coverage'=any(export_columns));

insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select surface.kind,surface.schema_name,surface.table_name,surface.object_name,surface.definition_hash
from private.account_lifecycle_trigger_surface() surface
where (surface.kind='function' and (surface.schema_name,pg_catalog.split_part(surface.object_name,'(',1)) in (values ('private','account_lifecycle_export_additional_domains'),('private','actor_case_scope_and_identity_allowed'),('private','actor_role_covers_member'),('private','chapter_case_intake_role_allows'),('private','chapter_contact_entry_allowed'),('private','chapter_organization_role_allowed'),('private','chapter_record_manageable'),('private','chapter_officer_can'),('private','chapter_records_scope_memo'),('private','chapter_scope_member_allowed'),('private','chapter_scope_recipient_allowed'),('private','chapter_scoped_member_ids'),('private','chapter_scoped_role_allows'),('private','chapter_seniority_member_allowed'),('private','chapter_staff_member_allowed'),('private','chapter_unit_has_member'),('private','chapter_unit_member_ids'),('private','chapter_unit_rows'),('private','clear_steward_carry_over_on_choice'),('private','create_chapter_default_unit'),('private','draft_steward_covers_member'),('private','enforce_chapter_has_unit'),('private','enforce_one_steward_assignment'),('private','enforce_organization_steward_assignment'),('private','enforce_organization_steward_units'),('private','enforce_invitation_unit_reservation'),('private','enforce_reserved_unit_chapter'),('private','enforce_steward_invitation_unit'),('private','enforce_steward_unit_assignment'),('private','member_has_chapter_role'),('private','member_invitation_selected_unit'),('private','member_scoped_notice_in_audience'),('private','organization_steward_scope_allows'),('private','organization_steward_unassigned'),('private','reject_new_organization_steward_assignment'),('private','reject_steward_carry_over_write'),('private','search_member_cases'),('private','staff_actor_can_see_user'),('private','staff_visible_member_ids'),('private','steward_assignment_scopes'),('public','answer_chapter_seniority_question'),('public','create_member_invitation'),('public','delete_chapter_seniority_entry'),('public','finalize_member_invitation'),('public','get_advisor_overview'),('public','get_broadcast_read_counts'),('public','get_broadcast_read_counts_for'),('public','get_chapter_access_workspace'),('public','get_institutional_records_workspace'),('public','get_organization_analytics_workspace'),('public','get_steward_unit_assignment'),('public','get_vp_overview'),('public','import_chapter_seniority'),('public','list_chapter_bid_window_bids'),('public','list_chapter_bid_windows'),('public','list_chapter_seniority'),('public','list_contract_clause_grievance_counts'),('public','record_chapter_bid'),('public','save_chapter_seniority_entry'),('public','save_scoped_institutional_record'),('public','search_chapter_seniority_members'),('public','set_member_access_role'),('public','set_member_chapter_role'),('public','set_member_organization_role'),('public','staff_can_see_user'))) or (surface.kind='trigger' and surface.schema_name='private' and surface.table_name='organization_steward_unit_assignments') or (surface.kind='trigger' and surface.object_name in ('a01_reject_carry_over_insert','a01_reject_carry_over_update','a02_clear_carry_over_on_choice','steward_grant_requires_unit','steward_scope_requires_grant_unit','organization_steward_requires_units','chapter_gets_default_unit','chapter_keeps_one_unit','a01_reject_organization_assignment_insert','a01_reject_organization_assignment_key_update','a01_reject_organization_carry_over_update','a02_clear_organization_carry_over_on_choice','one_steward_chapter_assignment','one_steward_organization_assignment','organization_assignment_requires_grant_unit','steward_invitation_requires_unit','invitation_unit_reservation_kept','reserved_unit_stays_in_chapter'))
on conflict(kind,schema_name,table_name,object_name) do update set definition_hash=excluded.definition_hash;
commit;
