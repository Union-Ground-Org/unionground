-- BUG-UG-COMPASS-OUTCOME-ORGANIZATION-ATTRIBUTION-20261013
-- Bind aggregate outcome attribution to the governed request reservation.
-- Account-lifecycle review: no new relations, triggers, references or retention
-- paths. These RPC/helpers are not reachable from a referential-action trigger.
-- Identity/lifecycle admission precedes member-ai-global, request row and
-- organization row locks, as in reserve/dispatch. FOR SHARE serializes outcome
-- writes with archive/delete, preserving aggregate erasure and reactivation's
-- full-week floor. No member data is added to the aggregate stores.
-- Hosted rollout must install this migration before deploying the new API.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Without a reservation the historical entry point cannot attribute an outcome.
-- Keep its signature inert during rollout; never guess its organization.
create or replace function public.record_compass_ai_outcome(p_user_id uuid, p_outcome text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  -- Explicitly consume the compatibility arguments without reading or writing
  -- any data; plpgsql_check must not add unused-parameter warnings.
  perform p_user_id, p_outcome;
  return;
end;
$$;
revoke all on function public.record_compass_ai_outcome(uuid, text)
  from public, anon, authenticated, service_role;

create function public.record_compass_ai_request_outcome(
  p_request_id uuid,
  p_user_id uuid,
  p_outcome text
)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[p_user_id], array[]::uuid[]);
declare
  request_row public.member_ai_requests%rowtype;
  org uuid;
  week date := (pg_catalog.date_trunc('week', pg_catalog.now()::timestamp))::date;
begin
  if p_request_id is null or p_user_id is null or p_outcome is null
     or p_outcome not in ('answered', 'no_source') then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-ai-global', 509));
  select r.* into request_row from public.member_ai_requests r
    where r.id = p_request_id and r.user_id = p_user_id for update;
  if request_row.id is null or request_row.compass_role is null
     or request_row.compass_limit is null
     or (p_outcome = 'answered' and request_row.dispatch_authorized_at is null) then return; end if;
  org := request_row.compass_organization_id;
  if org is null then return; end if;

  -- Serialize with archive/delete so a late outcome cannot restore usage rows.
  perform 1 from public.organizations o where o.id = org and o.status = 'active' for share;
  if not found then return; end if;
  if exists (select 1 from private.mesh_agency_usage_start s
    where s.organization_id = org and s.counting_from > week) then return; end if;
  insert into private.mesh_agency_usage_counters (organization_id, period_start, metric, value)
    values (org, week, 'compass_' || p_outcome, 1)
  on conflict (organization_id, period_start, metric) do update
    set value = private.mesh_agency_usage_counters.value + 1, updated_at = pg_catalog.now();
end;
end;
$$;
revoke all on function public.record_compass_ai_request_outcome(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_compass_ai_request_outcome(uuid, uuid, text) to service_role;

-- Request/rate-limit ticks run under the governance lock. Use the same resolver
-- as reservation/dispatch so a chapterless single-organization member counts.
create or replace function private.mesh_usage_bump(p_user_id uuid, p_metric text)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  org uuid;
  week date := (pg_catalog.date_trunc('week', pg_catalog.now()::timestamp))::date;
begin
  select q.organization_id into org from private.compass_quota_organization(p_user_id) q
    where q.resolution not in ('ambiguous', 'unresolved');
  if org is null then return; end if;
  if exists (select 1 from private.mesh_agency_usage_start s
    where s.organization_id = org and s.counting_from > week) then return; end if;
  insert into private.mesh_agency_usage_counters (organization_id, period_start, metric, value)
    values (org, week, p_metric, 1)
  on conflict (organization_id, period_start, metric) do update
    set value = private.mesh_agency_usage_counters.value + 1, updated_at = pg_catalog.now();
exception when others then return;
end;
$$;
revoke all on function private.mesh_usage_bump(uuid, text)
  from public, anon, authenticated, service_role;
do $assert_account_lifecycle_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after Compass outcome attribution';
  end if;
end;
$assert_account_lifecycle_trigger_review$;

notify pgrst, 'reload schema';
commit;
