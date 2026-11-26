-- Keep a newly provisioned account honest and quiet before organization
-- onboarding. The tenant-scoped implementations remain unchanged; these
-- wrappers only short-circuit the no-organization state without inventing
-- memberships, presence, prompts, or other engagement records.

set local lock_timeout = '5s';

alter function public.evaluate_contextual_pulse(text, text) set schema private;
alter function private.evaluate_contextual_pulse(text, text)
  rename to engagement_evaluate_contextual_pulse_scoped;

alter function public.heartbeat_member_presence(text) set schema private;
alter function private.heartbeat_member_presence(text)
  rename to engagement_heartbeat_member_presence_scoped;

alter function public.get_member_engagement_snapshot() set schema private;
alter function private.get_member_engagement_snapshot()
  rename to engagement_member_snapshot_scoped;

revoke all on function private.engagement_evaluate_contextual_pulse_scoped(text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.engagement_heartbeat_member_presence_scoped(text)
  from public, anon, authenticated, service_role;
revoke all on function private.engagement_member_snapshot_scoped()
  from public, anon, authenticated, service_role;

create function public.evaluate_contextual_pulse(
  p_event_key text,
  p_context_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := (select auth.uid());
  org uuid := private.current_member_organization();
begin
  if actor is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if pg_catalog.lower(pg_catalog.btrim(coalesce(p_event_key, ''))) !~ '^[a-z0-9._:-]{1,80}$'
     or pg_catalog.btrim(coalesce(p_context_key, '')) !~ '^[a-zA-Z0-9._:-]{1,120}$' then
    raise exception 'invalid pulse context' using errcode = '22023';
  end if;
  if org is null then
    return null;
  end if;
  if not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  return private.engagement_evaluate_contextual_pulse_scoped(p_event_key, p_context_key);
end;
$function$;

create function public.heartbeat_member_presence(p_status text default 'online')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := (select auth.uid());
  org uuid := private.current_member_organization();
begin
  if actor is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_status not in ('online', 'away', 'offline') then
    raise exception 'invalid presence status' using errcode = '22023';
  end if;
  if org is null then
    return pg_catalog.jsonb_build_object('status', 'unavailable', 'lastSeenAt', null);
  end if;
  if not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  return private.engagement_heartbeat_member_presence_scoped(p_status);
end;
$function$;

create function public.get_member_engagement_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  actor uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  current_period text := pg_catalog.to_char(current_date, 'YYYY')
    || '-Q' || pg_catalog.date_part('quarter', current_date)::integer;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if org is null then
    return pg_catalog.jsonb_build_object(
      'quarterlyGate', pg_catalog.jsonb_build_object(
        'periodKey', current_period,
        'surveyId', null,
        'required', false,
        'completed', false,
        'unlocked', true
      ),
      'surveys', '[]'::jsonb,
      'pulsePrompts', '[]'::jsonb,
      'livePolls', '[]'::jsonb,
      'workspace', pg_catalog.jsonb_build_object(
        'moduleOrder', '["inbox","surveys","tasks","cases"]'::jsonb,
        'hiddenModules', '[]'::jsonb
      ),
      'actions', '[]'::jsonb,
      'keywordHits', '[]'::jsonb,
      'briefings', '[]'::jsonb
    );
  end if;
  if not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  return private.engagement_member_snapshot_scoped();
end;
$function$;

revoke all on function public.evaluate_contextual_pulse(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.heartbeat_member_presence(text)
  from public, anon, authenticated, service_role;
revoke all on function public.get_member_engagement_snapshot()
  from public, anon, authenticated, service_role;

grant execute on function public.evaluate_contextual_pulse(text, text) to authenticated;
grant execute on function public.heartbeat_member_presence(text) to authenticated;
grant execute on function public.get_member_engagement_snapshot() to authenticated;

notify pgrst, 'reload schema';
