-- Steward rail badge counts (design: "Casework · 4").
--
-- Today the desk KPIs are computed client-side from capped list fetches
-- (loadStewardDesk caps requests at 200 rows because chapter-scoped RLS
-- evaluates staff_can_see_user per candidate row). The rail badge must not
-- pay that price on every member-shell boot, so this is one cheap definer
-- aggregate: two chapter-scoped counts, no rows shipped, no cap distortion.
--
-- Gate and chapter-scope copied from get_steward_chapter_member_count
-- (20260723040000): member_has_role includes private.mfa_satisfied, and a
-- steward role row without a chapter_id scopes to the whole org — the same
-- semantics the desk itself uses.

create or replace function public.get_steward_badge_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  scope_chapter text;
  open_requests integer;
  forms_inbox integer;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  select r.chapter_id into scope_chapter
  from public.member_roles r
  where r.user_id = caller and r.role = 'steward'
  limit 1;

  select count(*)::integer into open_requests
  from public.member_steward_requests sr
  join public.member_profiles p on p.id = sr.user_id
  where sr.status <> 'closed'
    and (scope_chapter is null or p.chapter_id = scope_chapter);

  select count(*)::integer into forms_inbox
  from public.member_forms f
  join public.member_profiles p on p.id = f.user_id
  where f.status in ('submitted', 'in_review')
    and (scope_chapter is null or p.chapter_id = scope_chapter);

  return pg_catalog.jsonb_build_object(
    'openRequests', coalesce(open_requests, 0),
    'formsInbox', coalesce(forms_inbox, 0),
    'generatedAt', now()
  );
end;
$$;

revoke all on function public.get_steward_badge_counts() from public, anon;
grant execute on function public.get_steward_badge_counts() to authenticated;
