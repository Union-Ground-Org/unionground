-- #8927 slice 1: a layout is private presentation state, separate from saved
-- chart definitions (which may be shared). Array order is display order.
-- NULL on save removes the override; [] deliberately selects no charts.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function private.pulse_layout_entries_valid(p_entries jsonb)
returns boolean language plpgsql immutable security invoker set search_path = '' as $function$
declare entry jsonb; keys text[] := array[]::text[];
begin
  if pg_catalog.jsonb_typeof(p_entries) is distinct from 'array'
    or pg_catalog.octet_length(p_entries::text) > 16384 then return false; end if;
  if pg_catalog.jsonb_array_length(p_entries) > 64 then return false; end if;
  for entry in select value from pg_catalog.jsonb_array_elements(p_entries) loop
    if pg_catalog.jsonb_typeof(entry) is distinct from 'object'
      or not (entry ?& array['key','pinned'])
      or (entry - array['key','pinned']) <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(entry->'key') is distinct from 'string'
      or pg_catalog.char_length(entry->>'key') not between 1 and 80
      or (entry->>'key') !~ '^[a-z0-9:_-]+$'
      or pg_catalog.jsonb_typeof(entry->'pinned') is distinct from 'boolean'
      or (entry->>'key') = any(keys) then return false; end if;
    keys := pg_catalog.array_append(keys,entry->>'key');
  end loop;
  return true;
end;
$function$;
revoke all on function private.pulse_layout_entries_valid(jsonb) from public,anon,authenticated,service_role;

create table private.pulse_layouts (
  owner_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on update cascade on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete cascade,
  entries jsonb not null check (private.pulse_layout_entries_valid(entries)),
  primary key(owner_id,chapter_id)
);
create index pulse_layouts_organization_idx on private.pulse_layouts(organization_id);
create index pulse_layouts_chapter_idx on private.pulse_layouts(chapter_id);
alter table private.pulse_layouts enable row level security;
alter table private.pulse_layouts force row level security;
revoke all on private.pulse_layouts from public,anon,authenticated,service_role;

-- No staff/admin override, including under an accidental future table grant.
create policy pulse_layout_owner on private.pulse_layouts for all to authenticated
using (owner_id = (select auth.uid())
  and organization_id = private.current_member_organization()
  and chapter_id = private.current_member_chapter())
with check (owner_id = (select auth.uid())
  and organization_id = private.current_member_organization()
  and chapter_id = private.current_member_chapter());
create policy mfa_assurance on private.pulse_layouts as restrictive for all to authenticated
using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy pulse_layout_owner on private.pulse_layouts is 'Only the owner in their current organization and selected chapter; staff and administrators cannot read or change another person''s layout. Table grants remain revoked.';
comment on policy mfa_assurance on private.pulse_layouts is 'Restrictive session assurance in addition to the RPC full-session and current chapter checks.';
create trigger a00_case_graph_lock before insert or update or delete on private.pulse_layouts
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.pulse_layouts
for each row execute function private.lock_case_graph_row_keys('{owner_id}', '');

create function private.pulse_layout_context(p_chapter_id text,p_hat text)
returns uuid language plpgsql stable security definer set search_path = '' as $function$
declare org uuid;
begin
  org := private.pulse_chart_context(p_hat);
  -- Check caller scope before looking for a layout. Foreign and missing chapter
  -- identifiers have the identical refusal, independent of stored rows.
  if p_chapter_id is null or p_chapter_id is distinct from private.current_member_chapter()
    or not exists (select 1 from public.chapters c where c.id = p_chapter_id and c.organization_id = org)
    or not (exists (select 1 from public.member_chapter_memberships m
      where m.user_id = auth.uid() and m.chapter_id = p_chapter_id and m.status = 'active')
      or (p_hat <> 'member' and private.has_organization_role(org,array[p_hat]))) then
    raise exception 'layout unavailable' using errcode = '42501';
  end if;
  return org;
end;
$function$;
revoke all on function private.pulse_layout_context(text,text) from public,anon,authenticated,service_role;

-- Registry for CURRENT fixed cards, not the later ready-made chart reads.
-- fixed:<native card id> and saved:<owned chart uuid> are disjoint namespaces.
-- This returns identifiers only: never call a figures RPC to build the list.
create function private.pulse_layout_options(p_chapter_id text,p_hat text)
returns text[] language plpgsql stable security definer set search_path = '' as $function$
declare org uuid; chart record; keys text[] := array['fixed:actions','fixed:outcomes','fixed:poll'];
begin
  org := private.pulse_layout_context(p_chapter_id,p_hat);
  if p_hat = 'member' then
    keys := keys || array['fixed:week','fixed:meetings'];
  elsif p_hat in ('vp','president') then
    keys := keys || array['fixed:membership','fixed:meetings','fixed:turnout','fixed:reach'];
  elsif p_hat = 'advisor' then keys := keys || array['fixed:health'];
  elsif p_hat = 'coordinator' then keys := keys || array['fixed:workload','fixed:flow','fixed:unassigned'];
  elsif p_hat = 'admin' then keys := keys || array['fixed:access','fixed:attention','fixed:events','fixed:forms'];
  elsif p_hat = 'steward' then
    keys := keys || array['fixed:caseload','fixed:requests','fixed:forms','fixed:unassigned','fixed:workload','fixed:ulp','fixed:quorum'];
  end if;
  -- The existing history read exposes this chapter series only to an active
  -- chapter member or an organization-wide hat, and has no local series.
  if private.member_can_access_event_scope(p_chapter_id,false,false) then
    keys := keys || array['fixed:history-chapter-meeting_checkins'];
  end if;
  for chart in select c.id,c.spec from private.pulse_saved_charts c
    where c.owner_id = auth.uid() and c.organization_id = org and c.chapter_id = p_chapter_id
      and c.deleted_at is null order by c.id limit 30 loop
    begin
      perform private.pulse_chart_spec(chart.spec,p_hat,p_chapter_id);
      keys := pg_catalog.array_append(keys,'saved:' || chart.id::text);
    exception when insufficient_privilege or invalid_parameter_value then
      -- Revoked roles, removed units and unavailable specs withdraw the key.
      null;
    end;
  end loop;
  return keys;
end;
$function$;
revoke all on function private.pulse_layout_options(text,text) from public,anon,authenticated,service_role;

create function public.get_pulse_layout(p_chapter_id text,p_hat text default 'member')
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare org uuid; keys text[]; entries jsonb; customized boolean;
begin
  perform private.lock_case_graph_read();
  if auth.uid() is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  org := private.pulse_layout_context(p_chapter_id,p_hat);
  keys := private.pulse_layout_options(p_chapter_id,p_hat);
  select l.entries into entries from private.pulse_layouts l
    where l.owner_id = auth.uid() and l.organization_id = org and l.chapter_id = p_chapter_id;
  customized := found;
  return pg_catalog.jsonb_build_object('customized',customized,
    'entries',coalesce((select pg_catalog.jsonb_agg(e.value order by e.ordinality)
      from pg_catalog.jsonb_array_elements(coalesce(entries,'[]'::jsonb)) with ordinality e(value,ordinality)
      where (e.value->>'key') = any(keys)),'[]'::jsonb),
    'options',pg_catalog.to_jsonb(keys));
end;
$function$;

create function public.save_pulse_layout(p_chapter_id text,p_entries jsonb default null,p_hat text default 'member')
returns void language plpgsql security definer set search_path = '' as $function$
declare org uuid; keys text[];
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  if auth.uid() is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  org := private.pulse_layout_context(p_chapter_id,p_hat);
  if p_entries is null then
    delete from private.pulse_layouts l
      where l.owner_id = auth.uid() and l.organization_id = org and l.chapter_id = p_chapter_id;
    return;
  end if;
  if not private.pulse_layout_entries_valid(p_entries) then
    raise exception 'invalid layout' using errcode = '22023';
  end if;
  keys := private.pulse_layout_options(p_chapter_id,p_hat);
  if exists (select 1 from pg_catalog.jsonb_array_elements(p_entries) e
    where not ((e->>'key') = any(keys))) then
    -- Unknown, deleted, foreign-owned and currently unauthorized keys all
    -- receive the same refusal; stored chart existence is never disclosed.
    raise exception 'layout unavailable' using errcode = '42501';
  end if;
  insert into private.pulse_layouts(owner_id,organization_id,chapter_id,entries)
    values(auth.uid(),org,p_chapter_id,p_entries)
    on conflict(owner_id,chapter_id) do update set entries = excluded.entries,organization_id = excluded.organization_id;
end;
$function$;

revoke all on function public.get_pulse_layout(text,text) from public,anon,authenticated,service_role;
revoke all on function public.save_pulse_layout(text,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.get_pulse_layout(text,text) to authenticated;
grant execute on function public.save_pulse_layout(text,jsonb,text) to authenticated;
-- Account export includes only the caller's layout; account deletion cascades.
-- Preserve every existing export domain and bind the predecessor before adding
-- this one. This changes no saved-chart read, writer or sharing behavior.
-- Predecessor: #8833, 20261113134500; retain its waiting-referral-payout domain.
do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.account_lifecycle_export_additional_domains(uuid)'::regprocedure))
    <> '4d924bb6eb54a37a66f446fa534c2b1d' then
    raise exception 'unreviewed layout export predecessor' using errcode = '55000';
  end if;
end;
$preflight$;

insert into private.account_lifecycle_manifest
 (schema_name,table_name,user_column,delete_disposition,export_disposition,export_projection,export_inventory_basis,export_projection_version,export_domain,export_columns,note,reviewed_at)
values ('private','pulse_layouts','owner_id','cascade','included','additional_domains','auth_user_fk',1,'additionalDomains.pulse_layouts',
 array['owner_id','organization_id','chapter_id','entries']::text[],
 'Caller-owned chapter layout keys, order and pins only. Account deletion cascades.',date '2026-11-15');

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_additional_domains(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select pg_catalog.jsonb_build_object(
    'pulse_layouts', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('owner_id',l.owner_id,'organization_id',l.organization_id,'chapter_id',l.chapter_id,'entries',l.entries) order by l.chapter_id) from private.pulse_layouts l where l.owner_id=p_caller),'[]'::jsonb),
    'pulse_saved_charts', private.account_lifecycle_export_pulse_saved_charts(p_caller), 'chapter_bid_entries', private.account_lifecycle_export_chapter_bid_entries(p_caller), 'chapter_seniority_entries', private.account_lifecycle_export_chapter_seniority_entries(p_caller), 'chapter_channel_poll_votes', private.account_lifecycle_export_chapter_channel_poll_votes(p_caller), 'chapter_space_notification_settings', private.account_lifecycle_export_chapter_space_notification_settings(p_caller), 'chapter_task_watchers', private.account_lifecycle_export_chapter_task_watchers(p_caller), 'chapter_thread_posts', private.account_lifecycle_export_chapter_thread_posts(p_caller), 'chapter_threads', private.account_lifecycle_export_chapter_threads(p_caller), 'compass_message_briefings', private.account_lifecycle_export_compass_message_briefings(p_caller), 'compass_workspace_preferences', private.account_lifecycle_export_compass_workspace_preferences(p_caller), 'member_ballot_votes', private.account_lifecycle_export_member_ballot_votes(p_caller), 'member_broadcast_receipts', private.account_lifecycle_export_member_broadcast_receipts(p_caller), 'member_chapter_memberships', private.account_lifecycle_export_member_chapter_memberships(p_caller), 'member_emergency_checklists', private.account_lifecycle_export_member_emergency_checklists(p_caller), 'member_event_contact_links', private.account_lifecycle_export_member_event_contact_links(p_caller), 'member_event_contact_opt_ins', private.account_lifecycle_export_member_event_contact_opt_ins(p_caller), 'member_message_reactions', private.account_lifecycle_export_member_message_reactions(p_caller), 'member_message_reminders', private.account_lifecycle_export_member_message_reminders(p_caller), 'member_message_resources', private.account_lifecycle_export_member_message_resources(p_caller), 'member_profile_details', private.account_lifecycle_export_member_profile_details(p_caller), 'member_qa_votes', private.account_lifecycle_export_member_qa_votes(p_caller), 'member_report_preferences', private.account_lifecycle_export_member_report_preferences(p_caller), 'member_reward_tier_attainment', private.account_lifecycle_export_member_reward_tier_attainment(p_caller), 'member_saved_messages', private.account_lifecycle_export_member_saved_messages(p_caller), 'member_weekly_question_promotions', private.account_lifecycle_export_member_weekly_question_promotions(p_caller), 'member_weekly_question_supports', private.account_lifecycle_export_member_weekly_question_supports(p_caller), 'member_weekly_questions', private.account_lifecycle_export_member_weekly_questions(p_caller), 'organization_engagement_events', private.account_lifecycle_export_organization_engagement_events(p_caller), 'organization_live_poll_votes', private.account_lifecycle_export_organization_live_poll_votes(p_caller), 'organization_memberships', private.account_lifecycle_export_organization_memberships(p_caller), 'organization_pulse_events', private.account_lifecycle_export_organization_pulse_events(p_caller), 'steward_contact_preferences', private.account_lifecycle_export_steward_contact_preferences(p_caller), 'steward_private_reminders', private.account_lifecycle_export_steward_private_reminders(p_caller), 'compass_training_member_consents', private.account_lifecycle_export_compass_training_member_consents(p_caller), 'compass_training_samples', private.account_lifecycle_export_compass_training_samples(p_caller)
  ) || pg_catalog.jsonb_build_object(
    'chapter_unit_members',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('user_id',m.user_id,'chapter_id',m.chapter_id,'unit_id',m.unit_id) order by m.chapter_id,m.unit_id) from private.chapter_unit_members m where m.user_id=p_caller),'[]'::jsonb),
    'chapter_committee_members',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('user_id',m.user_id,'chapter_id',m.chapter_id,'committee_id',m.committee_id) order by m.chapter_id,m.committee_id) from private.chapter_committee_members m where m.user_id=p_caller),'[]'::jsonb),
    'organization_steward_unit_assignments',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('organization_id',m.organization_id,'user_id',m.user_id,'role',m.role,'chapter_id',m.chapter_id,'unit_id',m.unit_id,'legacy_chapter_coverage',m.legacy_chapter_coverage) order by m.chapter_id) from private.organization_steward_unit_assignments m where m.user_id=p_caller),'[]'::jsonb),
    'chapter_role_scopes',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('user_id',m.user_id,'chapter_id',m.chapter_id,'role',m.role,'unit_id',m.unit_id,'committee_id',m.committee_id,'legacy_chapter_coverage',m.legacy_chapter_coverage) order by m.chapter_id,m.role) from private.chapter_role_scopes m where m.user_id=p_caller),'[]'::jsonb)
  ) || jsonb_build_object('chapter_financial_requests',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'organization_id',r.organization_id,'chapter_id',r.chapter_id,'subject_id',r.subject_id,'kind',r.kind,'title',r.title,'description',r.description,'amount',r.amount,'currency',r.currency,'status',r.status,'decision_note',r.decision_note,'revision',r.revision,'created_at',r.created_at,'decided_at',r.decided_at) order by r.created_at,r.id) from private.chapter_financial_requests r where r.subject_id=p_caller),'[]'::jsonb))
  || pg_catalog.jsonb_build_object('member_referral_payouts_waiting', private.account_lifecycle_export_member_referral_payouts_waiting(p_caller))
  || pg_catalog.jsonb_build_object(
    'member_capacity_commitments', private.account_lifecycle_export_member_capacity_commitments(p_caller), 'member_learning_assignments', private.account_lifecycle_export_member_learning_assignments(p_caller), 'member_membership_periods', private.account_lifecycle_export_member_membership_periods(p_caller), 'member_onboarding_steps', private.account_lifecycle_export_member_onboarding_steps(p_caller), 'member_participation_completions', private.account_lifecycle_export_member_participation_completions(p_caller), 'member_participation_events', private.account_lifecycle_export_member_participation_events(p_caller), 'member_recognition_events', private.account_lifecycle_export_member_recognition_events(p_caller)
  );
$function$;
revoke all on function private.account_lifecycle_export_additional_domains(uuid) from public,anon,authenticated,service_role;
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select s.kind,s.schema_name,s.table_name,s.object_name,s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.schema_name = 'private' and s.table_name = 'pulse_layouts')
 or (s.kind = 'function' and s.schema_name = 'private'
   and s.object_name = 'account_lifecycle_export_additional_domains(p_caller uuid)')
on conflict(kind,schema_name,table_name,object_name) do update set definition_hash = excluded.definition_hash;

commit;
