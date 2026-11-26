-- UB-DESK-05: a President's review of an overdue case is a durable leadership
-- record, not device-local presentation state. Writes are President-only;
-- every MFA-assured staff hat in the chapter can read the attribution.

create table public.member_vp_case_reviews (
  id uuid primary key default gen_random_uuid(),
  chapter_id text not null,
  case_id uuid not null references public.member_cases(id) on delete cascade,
  reviewed_by uuid not null references public.member_profiles(id) on delete restrict,
  reviewed_at timestamptz not null default now(),
  unique (chapter_id, case_id)
);

alter table public.member_vp_case_reviews enable row level security;

create policy mfa_assurance on public.member_vp_case_reviews
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

create policy member_vp_case_reviews_staff_read on public.member_vp_case_reviews
  for select to authenticated
  using (
    public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    and exists (
      select 1 from public.member_roles r
      where r.user_id = (select auth.uid())
        and r.chapter_id = member_vp_case_reviews.chapter_id
        and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
    )
  );

-- No direct writes: the definer RPC validates both role and case chapter.
revoke all on table public.member_vp_case_reviews from public, anon;
revoke all on table public.member_vp_case_reviews from authenticated;
grant select on table public.member_vp_case_reviews to authenticated;

create function public.mark_vp_case_reviewed(p_case_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  result_row public.member_vp_case_reviews%rowtype;
begin
  if caller is null or not public.member_has_role(array['vp']) or not (select private.mfa_satisfied()) then
    raise exception 'president role with MFA required' using errcode = '42501';
  end if;

  select r.chapter_id into caller_chapter
  from public.member_roles r
  where r.user_id = caller and r.role = 'vp'
  order by r.chapter_id
  limit 1;

  if caller_chapter is null or not exists (
    select 1
    from public.member_cases c
    join public.member_profiles p on p.id = c.user_id
    where c.id = p_case_id
      and p.chapter_id = caller_chapter
      and c.status = 'active'
      and c.deadline is not null
      and c.deadline < current_date
  ) then
    raise exception 'attention case not found' using errcode = 'P0002';
  end if;

  insert into public.member_vp_case_reviews (chapter_id, case_id, reviewed_by)
  values (caller_chapter, p_case_id, caller)
  on conflict (chapter_id, case_id) do nothing;

  select * into strict result_row
  from public.member_vp_case_reviews r
  where r.chapter_id = caller_chapter and r.case_id = p_case_id;

  return pg_catalog.jsonb_build_object(
    'caseId', result_row.case_id,
    'reviewedAt', result_row.reviewed_at,
    'reviewedBy', result_row.reviewed_by);
end;
$$;

create function public.list_vp_case_reviews()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  payload jsonb;
begin
  if caller is null or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role with MFA required' using errcode = '42501';
  end if;

  select r.chapter_id into caller_chapter
  from public.member_roles r
  where r.user_id = caller
    and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  order by r.chapter_id
  limit 1;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'caseId', v.case_id,
    'reviewedAt', v.reviewed_at,
    'reviewedBy', v.reviewed_by,
    'reviewerName', p.full_name,
    'caseReference', c.reference,
    'caseTitle', c.title
  ) order by v.reviewed_at desc), '[]'::jsonb)
  into payload
  from public.member_vp_case_reviews v
  join public.member_profiles p on p.id = v.reviewed_by
  join public.member_cases c on c.id = v.case_id
  where v.chapter_id = caller_chapter;

  return payload;
end;
$$;

revoke all on function public.mark_vp_case_reviewed(uuid) from public, anon;
revoke all on function public.list_vp_case_reviews() from public, anon;
grant execute on function public.mark_vp_case_reviewed(uuid) to authenticated;
grant execute on function public.list_vp_case_reviews() to authenticated;
