-- Make MFA an actual data boundary instead of a UI curtain.
--
-- PR6 shipped a TOTP challenge that holds the app shell closed at aal1. A live
-- probe showed what that was worth: the same aal1 token the UI refuses to render
-- behind reads member data straight through PostgREST.
--
--   GET /rest/v1/member_profiles?id=eq.<self>  -> 200, 1 row
--   GET /rest/v1/member_notifications?limit=3  -> 200, 3 rows
--
-- Every public table has RLS on and zero restrictive policies, so nothing
-- anywhere keys on assurance level. Against the threat TOTP is actually sold as
-- stopping — a stolen password — the gate stopped nothing; the attacker opens
-- devtools.
--
-- WHY A SECURITY DEFINER HELPER AND NOT THE POLICY FROM THE DOCS.
-- The pattern Supabase documents inlines `select ... from auth.mfa_factors`
-- directly in the USING clause. Checked live on this project:
--
--   has_table_privilege('authenticated','auth.mfa_factors','select') = false
--
-- so that policy raises permission-denied on every query, for every member, on
-- every table carrying it. It is a site-wide outage wearing the costume of a
-- security fix. The read has to happen inside a definer-owned function
-- (`postgres` does hold that privilege — also verified live).
--
-- WHY NOW. auth.mfa_factors currently holds ZERO rows, so the predicate below is
-- `not exists(...)` = true for every member alive and this migration is provably
-- inert the moment it commits. It only begins to bite as members enrol. This is
-- the safest window this change will ever have; it gets riskier every day it is
-- deferred.

-- Session-scoped, not SET LOCAL: the CLI applies each migration file outside an
-- explicit transaction, where SET LOCAL raises WARNING 25P01 and silently does
-- nothing. As written this guard never bounded a single lock wait.
set lock_timeout = '5s';

-- True when the caller has already proved their second factor, OR has no second
-- factor to prove. Members who never enrol are unaffected forever.
--
-- CASE rather than OR: `auth.jwt() ->> 'aal'` is NULL on a token without the
-- claim, and `NULL = 'aal2'` is NULL, which would make the whole OR return NULL
-- and RLS would read that as deny. The CASE sends a NULL aal to the ELSE branch,
-- where `not exists` is never NULL — so a member with no factors is admitted
-- even on a malformed token, and a member WITH factors is refused unless the
-- token actually says aal2. Deterministic in both directions.
create or replace function private.mfa_satisfied()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when (select auth.jwt() ->> 'aal') = 'aal2' then true
    else not exists (
      select 1
      from auth.mfa_factors f
      where f.user_id = (select auth.uid())
        and f.status = 'verified'
    )
  end;
$$;

comment on function private.mfa_satisfied() is
  'RLS predicate: caller is aal2, or has no verified MFA factor to prove. '
  'security definer because authenticated cannot read auth.mfa_factors.';

-- Callable by members: an RLS USING clause is evaluated as the querying role, so
-- without this grant every policy below fails permission-denied. It leaks only
-- the caller''s own MFA status, which the caller already knows.
revoke all on function private.mfa_satisfied() from public, anon;
grant execute on function private.mfa_satisfied() to authenticated;

-- One RESTRICTIVE policy per RLS-enabled public table. Restrictive policies AND
-- with the existing permissive ones, so this can only ever subtract access —
-- no existing grant is widened.
--
-- Generated rather than hand-listed so no table is missed by a typo; the
-- companion verifier asserts coverage is total, which is what catches a table
-- added later without one.
--
-- `(select private.mfa_satisfied())` — the subselect wrapper matters. It makes
-- the call an InitPlan evaluated ONCE per query instead of once per row, which
-- on member_notifications (300k rows) is the difference between a no-op and a
-- table-scan-shaped regression.
--
-- FOR ALL + both USING and WITH CHECK: USING alone would leave INSERT unguarded,
-- letting a member who owes a code still write rows they cannot read back.
do $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select c.oid::regclass as tbl
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public'
      and c.relkind = 'r'
      and c.relrowsecurity
    order by c.relname
  loop
    execute format('drop policy if exists mfa_assurance on %s', r.tbl);
    execute format(
      'create policy mfa_assurance on %s as restrictive for all to authenticated '
      'using ((select private.mfa_satisfied())) '
      'with check ((select private.mfa_satisfied()))',
      r.tbl);
    n := n + 1;
  end loop;

  if n = 0 then
    raise exception 'mfa_assurance: no RLS-enabled public tables found — refusing to apply a no-op security migration';
  end if;
  raise notice 'mfa_assurance applied to % tables', n;
end
$$;
