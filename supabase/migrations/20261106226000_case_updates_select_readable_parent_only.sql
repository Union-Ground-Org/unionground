-- BUG-UG-STEWARD-CASE-LATEST-UPDATES-ROW-POLICY-SLOW-AT-SCALE-20261106 (#7360);
-- stamp reserved by . A partial:
-- it does not meet #7360's 1 s acceptance.
-- public.list_case_latest_updates is security invoker, so every update row it
-- reads goes through member_case_updates_select. That policy is the OR of four
-- branches, each requiring the parent case row in an EXISTS over
-- public.member_cases:
--   A. own update on own case,
--   B. steward assigned to the case,
--   C. public.staff_can_see_user(user_id, 'coordinator') on any visible case,
--   D. the parent case satisfies private.chapter_case_readable.
-- The EXISTS runs as the caller, under member_cases' own policies, and
-- member_cases carries the restrictive chapter_access_scope =
-- private.chapter_case_readable(member_cases.*) for every command. Any parent
-- row that A, B or C can see therefore already satisfies D, so the OR equals D
-- alone. Branch C still cost one staff_can_see_user call per update row (1,545
-- calls, 4.9 s of 8.4 s for a 200-case Tamarack steward desk).
-- The policy is now D alone. Visibility is unchanged: the preflight refuses to
-- run unless both the predecessor policy and the member_cases restrictive
-- policy are exactly the reviewed ones.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- pg_get_expr qualifies every non-catalog name under this path, exactly as
-- under an empty one (pg_catalog is always searched), so the md5s are stable.
set local search_path = pg_catalog;

do $preflight$
begin
  -- The exact predecessor 20261102005607 installed.
  if (select pg_catalog.md5(pg_catalog.pg_get_expr(p.polqual, p.polrelid)) from pg_catalog.pg_policy p
      where p.polrelid = 'public.member_case_updates'::regclass and p.polname = 'member_case_updates_select'
        and p.polpermissive and p.polcmd = 'r') is distinct from 'cfe0e26b58266f5920e5e6b236e9dc64' then
    raise exception 'unreviewed predecessor: member_case_updates_select' using errcode = '55000';
  end if;
  -- The equivalence rests on this restrictive policy covering every read.
  if not exists (select 1 from pg_catalog.pg_policy p
      where p.polrelid = 'public.member_cases'::regclass and p.polname = 'chapter_access_scope'
        and not p.polpermissive and p.polcmd = '*'
        and p.polroles = array['authenticated'::regrole]::oid[]
        and pg_catalog.md5(pg_catalog.pg_get_expr(p.polqual, p.polrelid)) = '5ae99888b5c4ecb986e655ab1c2f00c9')
     or not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.member_cases'::regclass) then
    raise exception 'member_cases no longer enforces chapter_access_scope on every read' using errcode = '55000';
  end if;
end;
$preflight$;

alter policy member_case_updates_select on public.member_case_updates using (
  exists (select 1 from public.member_cases c
    where c.id = member_case_updates.case_id and private.chapter_case_readable(c.*))
);
comment on policy member_case_updates_select on public.member_case_updates is 'A case note is readable exactly when its parent case row is readable to the caller (member_cases enforces tenant, role, unit, committee, restriction and private-identity boundaries through its own policies, including the restrictive chapter_access_scope). #7360 (20261106226000): the own, assigned-steward and coordinator branches were dropped because each already implied this one.';

commit;
