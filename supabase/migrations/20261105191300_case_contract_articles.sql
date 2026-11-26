-- BUG-UG-OPEN-CASE-ARTICLES-READ-ONLY-NO-INPUT-20261105
-- Reserved by . Existing five-argument callers retain their articles.
begin;
set local lock_timeout = '5s';

drop function public.coordinator_update_case(uuid, text, text, date, text);
create function public.coordinator_update_case(
  p_case_id uuid, p_status text, p_step text, p_deadline date, p_reason text,
  p_articles text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  old_case public.member_cases%rowtype;
  changed public.member_cases%rowtype;
  clean_reason text;
  clean_articles text;
begin
  perform private.lock_case_graph(array[auth.uid()], array[p_case_id]);
  perform private.casework_require_mfa();
  -- Staff who already work this case may edit only its articles. Lock and
  -- compare with the stored row; a stale form cannot overwrite other fields.
  select c.* into old_case from public.member_cases c
  where c.id = p_case_id and private.casework_staff_can_access(c.id)
  for update of c;
  if old_case.id is null
     or p_status is distinct from old_case.status
     or p_deadline is distinct from old_case.deadline
     or (p_step is not null and p_step is distinct from old_case.step) then
    -- Keep the existing coordinator gate for every status/deadline edit.
    -- Do not widen its shared helper, used by unrelated coordinator writers.
    old_case := private.coordinator_case_for_update(p_case_id);
  end if;
  if p_status is null or p_status not in ('active','resolved') then raise exception 'invalid status' using errcode = '22023'; end if;
  if p_step is not null and p_step is distinct from old_case.step then raise exception 'step changes go through the procedure transition' using errcode = '22023'; end if;
  clean_reason := pg_catalog.btrim(coalesce(p_reason, ''));
  if pg_catalog.char_length(clean_reason) not between 1 and 1000 then raise exception 'reason must be 1-1000 characters' using errcode = '22023'; end if;
  if old_case.deadline is not null and (p_deadline is null or p_deadline < old_case.deadline) then
    raise exception 'deadline may only be extended' using errcode = '22023';
  end if;
  clean_articles := case when p_articles is null then old_case.articles else pg_catalog.btrim(p_articles) end;
  if p_articles is not null and pg_catalog.char_length(clean_articles) > 500 then
    raise exception 'contract articles too long (500 characters max)' using errcode = '22023';
  end if;
  update public.member_cases set status=p_status, deadline=p_deadline, articles=clean_articles
  where id=old_case.id returning * into changed;
  insert into public.coordinator_case_audit(case_id,user_id,actor_id,action,before_value,after_value,reason)
  values (old_case.id,old_case.user_id,(select auth.uid()),'case_updated',
    pg_catalog.jsonb_build_object('status',old_case.status,'step',old_case.step,'deadline',old_case.deadline,'articles',old_case.articles),
    pg_catalog.jsonb_build_object('status',changed.status,'step',changed.step,'deadline',changed.deadline,'articles',changed.articles),clean_reason);
  perform private.learning_case_journal('case_edit', changed.id, null);
  return pg_catalog.jsonb_build_object('id',changed.id,'status',changed.status,'step',changed.step,'deadline',changed.deadline,'articles',changed.articles);
end;
end;
$function$;
revoke all on function public.coordinator_update_case(uuid, text, text, date, text, text) from public, anon, authenticated, service_role;
grant execute on function public.coordinator_update_case(uuid, text, text, date, text, text) to authenticated;
-- The invoker history feed already reads these audit rows. Retain one
-- permissive SELECT policy, keeping the original coordinator branch intact.
alter policy coordinator_case_audit_select_coordinator on public.coordinator_case_audit
  using (
    (public.staff_can_see_user(user_id, 'coordinator') and exists (
      select 1 from public.member_cases c where c.id = coordinator_case_audit.case_id
    ))
    or (action = 'case_updated' and after_value ? 'articles'
      and private.casework_staff_can_access(case_id))
  );
comment on policy coordinator_case_audit_select_coordinator on public.coordinator_case_audit is
  'Coordinators retain scoped parent-visible audit reads. Scoped case editors may also read article-bearing updates in the existing history feed. Ordinary members remain excluded and restrictive MFA still applies.';
notify pgrst, 'reload schema';
commit;
