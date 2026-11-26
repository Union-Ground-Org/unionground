-- BUG-UG-STEWARD-SHARED-ACCESS-PANEL-TIMEOUT-AT-SCALE-20261106 (#7209);
-- stamp reserved by .
-- public.list_private_grievance_summaries, one of the two reads of the steward
-- desk's shared-access panel, took 12 s on SAMPLE (1,002 accounts, 274 cases,
-- no privacy-marked case) and the panel showed "Access could not be loaded".
-- The planner drove the body from public.member_cases through the
-- organization index and ran private.chapter_grievance_steward_scope and
-- private.chapter_case_readable for every case of the organization before
-- the join to private.case_identity_privacy removed them. The empty list
-- itself was correct: no case there is marked private.
-- The body now walks the marked cases of the caller's organization in id
-- order and runs the same two checks only for those, stopping once 100
-- summaries are listed. Rows, columns, order and refusals are unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Replace only the exact predecessor 20261104075000 installed.
do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.list_private_grievance_summaries()'::regprocedure)) <> '45b50db242a5fc3c330ac0206169e682' then
    raise exception 'unreviewed predecessor: public.list_private_grievance_summaries' using errcode = '55000';
  end if;
end;
$preflight$;

create or replace function public.list_private_grievance_summaries()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller_org uuid;
  marked public.member_cases;
  summaries jsonb := '[]'::jsonb;
  listed integer := 0;
begin
  if not coalesce(private.mfa_satisfied(), false) then
    return summaries;
  end if;
  caller_org := private.current_member_organization();
  if caller_org is null then
    return summaries;
  end if;
  -- Drive from the privacy marks: the steward scope and readability checks
  -- run per marked case in id order and stop once 100 summaries are listed.
  for marked in
    select c.* from private.case_identity_privacy privacy
    join public.member_cases c on c.id = privacy.case_id
    where c.organization_id = caller_org
      and not c.is_restricted and c.learning_undone_at is null
      and coalesce((select p.steward_grievances from private.chapter_access_policies p where p.chapter_id = c.chapter_id), true)
    order by c.id
  loop
    if private.chapter_grievance_steward_scope(marked.chapter_id, marked.user_id)
       and not private.chapter_case_readable(marked) then
      summaries := summaries || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id', marked.id, 'status', marked.status));
      listed := listed + 1;
      exit when listed = 100;
    end if;
  end loop;
  return summaries;
end;
$function$;
revoke all on function public.list_private_grievance_summaries() from public, anon, authenticated, service_role;
grant execute on function public.list_private_grievance_summaries() to authenticated;

notify pgrst, 'reload schema';
commit;
