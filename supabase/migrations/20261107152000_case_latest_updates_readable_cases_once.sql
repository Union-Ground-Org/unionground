-- BUG-UG-STEWARD-CASE-LATEST-UPDATES-ROW-POLICY-SLOW-AT-SCALE-20261106 (#7360).
-- public.list_case_latest_updates is security invoker, so its read of
-- public.member_case_updates goes through member_case_updates_select:
-- exists (a member_cases row the caller may read with chapter_case_readable).
-- The planner runs that uncorrelated EXISTS as one hashed set over every case
-- in the database, and each case pays chapter_case_readable twice (once from
-- the policy, once from member_cases' own member_cases_select or
-- chapter_access_scope). On a Tamarack-seeded stack that is 517 calls for a
-- 200-case steward desk, and it grows with every case in every organization,
-- not with the desk.
--
-- For a caller under the authenticated policies, the function now reads
-- through private.case_latest_updates_readable, which evaluates
-- chapter_case_readable once for each requested case only, and carries the
-- remaining read policies of the three tables it touches verbatim:
--   member_cases:        member_cases_select and chapter_access_scope
--                        (both chapter_case_readable), mfa_assurance,
--                        member_pin_step_up;
--   member_case_updates: member_case_updates_select (its parent case is one
--                        of the readable cases above; a readable case row
--                        already satisfies chapter_case_readable through
--                        chapter_access_scope), member_case_updates_learning_undone,
--                        mfa_assurance, member_pin_step_up;
--   member_profiles:     member_profiles_select (own row, or in the
--                        steward or coordinator visible set), mfa_assurance.
-- Every other caller (service_role, the table owner) bypasses row security
-- and keeps the unchanged invoker query. The preflight refuses to run unless
-- the read policies of all three tables are exactly the reviewed ones, so a
-- policy change cannot silently diverge from the copy here;
-- tests/case-latest-updates-setwise-db.test.js pins the same digests.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
declare
  reviewed constant jsonb := jsonb_build_object(
    'public.member_case_updates', 'd76d00553b955bb152a1e351c069570b',
    'public.member_cases', 'f0515710857e41930ad54b767d05edf1',
    'public.member_profiles', '8178be60ab8a4a8132b40605961805c7');
  installed jsonb;
begin
  -- pg_get_expr qualifies every non-catalog name under this path, exactly as
  -- under an empty one (pg_catalog is always searched), so the digests are stable.
  set local search_path = pg_catalog;
  select jsonb_object_agg(t.tbl, t.digest) into installed from (
    select p.polrelid::regclass::text tbl, md5(string_agg(concat_ws(':', p.polname, p.polcmd, p.polpermissive,
        p.polroles::regrole[]::text, pg_get_expr(p.polqual, p.polrelid)), chr(10) order by p.polname)) digest
    from pg_policy p
    where p.polrelid in ('public.member_cases'::regclass, 'public.member_case_updates'::regclass, 'public.member_profiles'::regclass)
      and p.polcmd in ('r', '*')
    group by 1) t;
  if installed is distinct from reviewed then
    raise exception 'unreviewed read policies on member_cases, member_case_updates or member_profiles: %', installed using errcode = '55000';
  end if;
  if exists (select 1 from pg_class c
      where c.oid in ('public.member_cases'::regclass, 'public.member_case_updates'::regclass, 'public.member_profiles'::regclass)
        and not c.relrowsecurity) then
    raise exception 'row security is off on member_cases, member_case_updates or member_profiles' using errcode = '55000';
  end if;
end;
$preflight$;

create function private.case_latest_updates_readable(p_case_ids uuid[], p_per_case integer)
returns table (case_id uuid, id uuid, body text, created_at timestamptz, total_count bigint, mentions jsonb)
language sql
stable
security definer
set search_path = ''
as $readable$
  -- member_cases as an authenticated caller reads it, once per requested case.
  with readable as materialized (
    select c.id
    from public.member_cases c
    where c.id = any(p_case_ids)
      and (select private.mfa_satisfied())
      and not (select private.member_pin_session_restricted())
      and private.chapter_case_readable(c.*)
  )
  select ranked.case_id, ranked.id, ranked.body, ranked.created_at, ranked.total_count, ranked.mentions
  from (
    select u.case_id, u.id, u.body, u.created_at,
      pg_catalog.row_number() over (partition by u.case_id order by u.created_at desc, u.id desc) as rn,
      pg_catalog.count(*) over (partition by u.case_id) as total_count,
      coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object('userId', p.id, 'fullName', p.full_name)
          order by p.full_name)
        from public.member_profiles p
        where p.id = any(u.mentioned_user_ids)
          and (select private.mfa_satisfied())
          and ((select auth.uid()) = p.id
            or p.id in (select private.staff_visible_member_ids('steward'))
            or p.id in (select private.staff_visible_member_ids('coordinator')))
      ), '[]'::jsonb) as mentions
    from public.member_case_updates u
    where u.case_id in (select r.id from readable r)
      and u.learning_undone_at is null
      and (select private.mfa_satisfied())
      and not (select private.member_pin_session_restricted())
  ) ranked
  where ranked.rn <= least(greatest(coalesce(p_per_case, 20), 1), 100)
  order by ranked.case_id, ranked.created_at, ranked.id;
$readable$;

revoke all on function private.case_latest_updates_readable(uuid[], integer) from public, anon, authenticated, service_role;
grant execute on function private.case_latest_updates_readable(uuid[], integer) to authenticated;
comment on function private.case_latest_updates_readable(uuid[], integer) is
  'list_case_latest_updates for an authenticated caller: the rows, totals and mention names that caller reads under the read policies of member_cases, member_case_updates and member_profiles (carried verbatim; 20261107152000 pins their digests), with chapter_case_readable evaluated once per requested case. #7360.';

create or replace function public.list_case_latest_updates(
  p_case_ids uuid[],
  p_per_case integer default 20
)
returns table (case_id uuid, id uuid, body text, created_at timestamptz, total_count bigint, mentions jsonb)
language plpgsql
stable
security invoker
set search_path = ''
as $updates$
declare
  per_case integer := least(greatest(coalesce(p_per_case, 20), 1), 100);
begin
  -- Bounded fan-in: the desk page is 200 cases; 500 leaves headroom without
  -- letting a caller turn this into an unbounded scan.
  if coalesce(pg_catalog.cardinality(p_case_ids), 0) > 500 then
    raise exception 'too many case ids' using errcode = '22023';
  end if;

  -- The authenticated read policies, with case readability evaluated once per
  -- requested case instead of over every case in the database (#7360).
  if current_user = 'authenticated'
     and pg_catalog.row_security_active('public.member_cases'::regclass)
     and pg_catalog.row_security_active('public.member_case_updates'::regclass)
     and pg_catalog.row_security_active('public.member_profiles'::regclass) then
    return query select * from private.case_latest_updates_readable(p_case_ids, per_case);
    return;
  end if;

  return query
  select ranked.case_id, ranked.id, ranked.body, ranked.created_at, ranked.total_count, ranked.mentions
  from (
    select u.case_id, u.id, u.body, u.created_at,
      pg_catalog.row_number() over (partition by u.case_id order by u.created_at desc, u.id desc) as rn,
      pg_catalog.count(*) over (partition by u.case_id) as total_count,
      coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object('userId', p.id, 'fullName', p.full_name)
          order by p.full_name)
        from public.member_profiles p
        where p.id = any(u.mentioned_user_ids)
      ), '[]'::jsonb) as mentions
    from public.member_case_updates u
    where u.case_id = any(p_case_ids)
  ) ranked
  where ranked.rn <= per_case
  order by ranked.case_id, ranked.created_at, ranked.id;
end;
$updates$;

revoke all on function public.list_case_latest_updates(uuid[], integer) from public, anon;
grant execute on function public.list_case_latest_updates(uuid[], integer) to authenticated, service_role;
comment on function public.list_case_latest_updates(uuid[], integer) is
  'Recent updates per case (newest kept, returned chronological), the true per-case total, and the note mentions the reader is allowed to name. Invoker security: an authenticated caller reads through private.case_latest_updates_readable, which applies the same read policies with case readability evaluated once per requested case (#7360); every other caller keeps the direct read.';

commit;
