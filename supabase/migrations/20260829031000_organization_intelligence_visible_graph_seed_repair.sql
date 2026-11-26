-- Keep deterministic Neuro Map evidence inside the same ordered member window
-- returned by get_organization_intelligence_snapshot. The original SAMPLE seed
-- chose users by lane ordinal while the RPC exposes the first 5,000 active
-- organization members by display name. Large lanes could therefore contain
-- 100 stored relationships but render only the few whose endpoints happened to
-- fall inside that client-visible window.

set local lock_timeout = '5s';

alter function private.demo_seed_apply_organization_intelligence(text, uuid)
  rename to demo_seed_apply_organization_intelligence_unwindowed_20260829;

create function private.demo_seed_apply_organization_intelligence(
  p_lane text,
  p_run_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.member_stress_uuid(
    p_run_id::text || case when p_lane = 'presg' then ':presg:organization' else ':ud:organization' end
  );
  actor uuid := private.demo_seed_user(p_lane, p_run_id, 1);
  visible_users uuid[];
  n integer;
begin
  perform private.demo_seed_apply_organization_intelligence_unwindowed_20260829(p_lane, p_run_id);

  select pg_catalog.array_agg(scoped.user_id order by scoped.full_name, scoped.user_id)
  into visible_users
  from (
    select membership.user_id, profile.full_name
    from public.organization_memberships membership
    join public.member_profiles profile on profile.id = membership.user_id
    where membership.organization_id = org
      and membership.status = 'active'
    order by profile.full_name, membership.user_id
    limit 101
  ) scoped;

  delete from public.organization_topic_progress where organization_id = org;
  delete from public.organization_relationships where organization_id = org;

  for n in 1..least(100, greatest(0, coalesce(pg_catalog.array_length(visible_users, 1), 0) - 1)) loop
    insert into public.organization_relationships (
      id, organization_id, source_user_id, target_user_id, relationship_kind,
      strength, created_by, updated_by
    ) values (
      private.member_stress_uuid(p_run_id::text || ':org-intelligence:relationship:' || n),
      org, visible_users[n], visible_users[n + 1],
      (array['reports_to','works_with','mentors','organizes_with','trusted_contact'])[1 + (n % 5)],
      1 + (n % 5), actor, actor
    );
  end loop;

  for n in 1..least(100, coalesce(pg_catalog.array_length(visible_users, 1), 0)) loop
    insert into public.organization_topic_progress (
      organization_id, member_user_id, topic_key, topic_label,
      progress_state, progress, updated_by
    ) values (
      org, visible_users[n], 'organization_readiness', 'Organization readiness',
      (array['introduced','developing','ready'])[1 + (n % 3)],
      20 + (n % 81), actor
    );
  end loop;
end;
$function$;

revoke all on function private.demo_seed_apply_organization_intelligence(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_apply_organization_intelligence_unwindowed_20260829(text, uuid)
  from public, anon, authenticated, service_role;

comment on function private.demo_seed_apply_organization_intelligence(text, uuid) is
  'Deterministic SAMPLE-only organization-intelligence evidence whose Neuro Map rows remain inside the snapshot RPC member window.';
comment on function private.demo_seed_apply_organization_intelligence_unwindowed_20260829(text, uuid) is
  'Historical 2026-08-29 SAMPLE seed implementation retained behind the visible-window repair wrapper.';
