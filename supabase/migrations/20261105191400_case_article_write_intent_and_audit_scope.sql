-- Follow-up to #7127; stamp reserved by .
-- Preserve omitted workflow fields and keep unrelated coordinator reasons private.
begin;
set local lock_timeout = '5s';

create or replace function public.coordinator_update_case(
  p_case_id uuid, p_status text default null, p_step text default null,
  p_deadline date default '-infinity'::date, p_reason text default null,
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
  next_status text;
  next_deadline date;
  article_before jsonb := '{}'::jsonb;
  article_after jsonb := '{}'::jsonb;
begin
  perform private.lock_case_graph(array[auth.uid()], array[p_case_id]);
  perform private.casework_require_mfa();
  -- Omitted fields preserve the current locked row, rather than replaying
  -- a browser snapshot. Explicit null deadlines retain the old clear refusal.
  select c.* into old_case from public.member_cases c
  where c.id = p_case_id and private.casework_staff_can_access(c.id)
  for update of c;
  if old_case.id is null then
    old_case := private.coordinator_case_for_update(p_case_id);
  end if;
  next_status := coalesce(p_status, old_case.status);
  next_deadline := case when p_deadline = '-infinity'::date then old_case.deadline else p_deadline end;
  if next_status is distinct from old_case.status
     or next_deadline is distinct from old_case.deadline
     or (p_step is not null and p_step is distinct from old_case.step) then
    -- Keep the existing coordinator gate for every status/deadline edit.
    -- Do not widen its shared helper, used by unrelated coordinator writers.
    old_case := private.coordinator_case_for_update(p_case_id);
  end if;
  if next_status is null or next_status not in ('active','resolved') then raise exception 'invalid status' using errcode = '22023'; end if;
  if p_step is not null and p_step is distinct from old_case.step then raise exception 'step changes go through the procedure transition' using errcode = '22023'; end if;
  clean_reason := pg_catalog.btrim(coalesce(p_reason, ''));
  if pg_catalog.char_length(clean_reason) not between 1 and 1000 then raise exception 'reason must be 1-1000 characters' using errcode = '22023'; end if;
  if old_case.deadline is not null and (next_deadline is null or next_deadline < old_case.deadline) then
    raise exception 'deadline may only be extended' using errcode = '22023';
  end if;
  clean_articles := case when p_articles is null then old_case.articles else pg_catalog.btrim(p_articles) end;
  if p_articles is not null and pg_catalog.char_length(clean_articles) > 500 then
    raise exception 'contract articles too long (500 characters max)' using errcode = '22023';
  end if;
  update public.member_cases set status=next_status, deadline=next_deadline, articles=clean_articles
  where id=old_case.id returning * into changed;
  if old_case.articles is distinct from changed.articles then
    article_before := pg_catalog.jsonb_build_object('articles',old_case.articles);
    article_after := pg_catalog.jsonb_build_object('articles',changed.articles);
  end if;
  insert into public.coordinator_case_audit(case_id,user_id,actor_id,action,before_value,after_value,reason)
  values (old_case.id,old_case.user_id,(select auth.uid()),'case_updated',
    pg_catalog.jsonb_build_object('status',old_case.status,'step',old_case.step,'deadline',old_case.deadline) || article_before,
    pg_catalog.jsonb_build_object('status',changed.status,'step',changed.step,'deadline',changed.deadline) || article_after,clean_reason);
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
    or (action = 'case_updated' and before_value ? 'articles' and after_value ? 'articles'
      and before_value -> 'articles' is distinct from after_value -> 'articles'
      and (before_value - 'articles') is not distinct from (after_value - 'articles')
      and private.casework_staff_can_access(case_id))
  );
comment on policy coordinator_case_audit_select_coordinator on public.coordinator_case_audit is
  'Coordinators retain scoped parent-visible audit reads. Scoped editors may read only actual article-only changes; key presence never grants access to unchanged or mixed coordinator reasons. Restrictive MFA still applies.';
notify pgrst, 'reload schema';
commit;
