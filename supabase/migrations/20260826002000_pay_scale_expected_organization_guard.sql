-- Bind Pay catalog writes to the organization scope the editor rendered.
-- The supplied UUID is an intent/concurrency token only; authorization,
-- persistence, and audit scope remain derived from the authenticated session.

create function private.mi1_require_expected_selected_organization(p_expected_organization_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
begin
  if p_expected_organization_id is null or p_expected_organization_id is distinct from org then
    raise exception 'pay organization scope changed' using errcode = '42501';
  end if;
  return org;
end;
$function$;

revoke all on function private.mi1_require_expected_selected_organization(uuid)
from public, anon, authenticated, service_role;

drop function if exists public.upsert_pay_scale_grade(text, text, text, integer, text);
drop function if exists public.upsert_pay_scale_step(text, date, integer, integer);

create function public.upsert_pay_scale_grade(
  p_expected_organization_id uuid,
  p_grade text,
  p_title text,
  p_job_family text,
  p_step_count integer,
  p_description text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  normalized text := pg_catalog.btrim(p_grade);
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  perform 1
  from public.pay_scale_grades g
  where g.organization_id = org and g.grade = normalized
  for update;
  if p_step_count is not null and exists (
    select 1 from public.pay_scale_steps s
    where s.organization_id = org
      and s.grade = normalized
      and s.step_number > p_step_count
  ) then
    raise exception 'step count is below an existing scale step' using errcode = '22023';
  end if;
  insert into public.pay_scale_grades (
    organization_id, grade, title, job_family, step_count, description
  ) values (
    org, normalized, pg_catalog.btrim(p_title), nullif(pg_catalog.btrim(coalesce(p_job_family, '')), ''),
    p_step_count, nullif(pg_catalog.btrim(coalesce(p_description, '')), '')
  )
  on conflict (organization_id, grade) do update
    set title = excluded.title,
        job_family = excluded.job_family,
        step_count = excluded.step_count,
        description = excluded.description,
        updated_at = pg_catalog.now();
  perform private.mi1_write_tenant_audit(org, 'pay_scale_grade_upserted', pg_catalog.jsonb_build_object(
    'organizationId', org, 'grade', normalized, 'action', 'upsert_grade'
  ));
  return pg_catalog.jsonb_build_object('ok', true, 'organizationId', org, 'grade', normalized);
end;
$function$;

create function public.upsert_pay_scale_step(
  p_expected_organization_id uuid,
  p_grade text,
  p_effective_on date,
  p_step_number integer,
  p_hourly_rate_cents integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  normalized text := pg_catalog.btrim(p_grade);
  declared_step_count integer;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select g.step_count into declared_step_count
  from public.pay_scale_grades g
  where g.organization_id = org and g.grade = normalized
  for update;
  if not found or (declared_step_count is not null and p_step_number > declared_step_count) then
    raise exception 'scale or step not found' using errcode = 'P0002';
  end if;
  insert into public.pay_scale_steps (
    organization_id, grade, effective_on, step_number, hourly_rate_cents
  ) values (org, normalized, p_effective_on, p_step_number, p_hourly_rate_cents)
  on conflict (organization_id, grade, effective_on, step_number) do update
    set hourly_rate_cents = excluded.hourly_rate_cents;
  perform private.mi1_write_tenant_audit(org, 'pay_scale_step_upserted', pg_catalog.jsonb_build_object(
    'organizationId', org, 'grade', normalized, 'stepNumber', p_step_number,
    'effectiveOn', p_effective_on, 'action', 'upsert_step'
  ));
  return pg_catalog.jsonb_build_object('ok', true, 'organizationId', org, 'grade', normalized);
end;
$function$;

revoke all on function public.upsert_pay_scale_grade(uuid, text, text, text, integer, text)
from public, anon, authenticated, service_role;
revoke all on function public.upsert_pay_scale_step(uuid, text, date, integer, integer)
from public, anon, authenticated, service_role;
grant execute on function public.upsert_pay_scale_grade(uuid, text, text, text, integer, text) to authenticated;
grant execute on function public.upsert_pay_scale_step(uuid, text, date, integer, integer) to authenticated;

notify pgrst, 'reload schema';
