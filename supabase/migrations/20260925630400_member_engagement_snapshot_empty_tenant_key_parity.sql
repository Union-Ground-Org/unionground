-- DEBT-UG-EMPTY-TENANT-SNAPSHOT-RETURNS-RETIRED-KEYWORD-HITS-20260921
--
-- 20260907122000_retire_dormant_channel_controls.sql retired keyword alerts:
-- it dropped the keyword-hit table, its policy and its RPCs, and rewrote
-- private.engagement_member_snapshot_scoped without the keyword-hit key. The
-- no-organization branch of public.get_member_engagement_snapshot, created in
-- 20260829020000_member_engagement_empty_tenant_boundary.sql, was not
-- rewritten, so a caller with no organization still received an empty
-- keyword-hit array that an onboarded member no longer gets. The snapshot's
-- contract depended on whether the caller had an organization, and the next
-- reader of that branch would conclude keyword monitoring was still a product.
--
-- This re-emits the 20260829020000 body with that one line removed. The
-- empty-tenant branch now returns exactly the top-level keys the scoped
-- snapshot returns (quarterlyGate, surveys, pulsePrompts, livePolls,
-- workspace, actions, briefings). Authentication, MFA, the membership gate and
-- the empty-state values are unchanged, and create or replace keeps the
-- existing authenticated-only execute grant.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.get_member_engagement_snapshot()
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
      'briefings', '[]'::jsonb
    );
  end if;
  if not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  return private.engagement_member_snapshot_scoped();
end;
$function$;

notify pgrst, 'reload schema';

commit;
