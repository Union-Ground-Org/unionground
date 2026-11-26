-- BUG-UG-MEMBER-FORMS-POLICY-CHECKS-EVERY-ROW-20261108 (#7502).
-- The web shell reads public.member_forms (the forms page, ordered by
-- updated_at and id) on every load and every demo role switch
-- (src/lib/memberApi.js), so the table's read policies decide its cost:
--   member_forms_select ORs private.member_draft_shared_to_caller(member_forms.*)
--   for every form the earlier branches reject, and that function rebuilds
--   the caller's MFA, PIN, organization, chapter and coverage checks per row;
--   the restrictive member_forms_case_identity_scope calls
--   private.member_form_scope_and_identity_allowed(member_forms.*) per row.
-- On a local Tamarack stack that is 398 and 400 calls for 400 forms (70 ms
-- for the demo steward); on SAMPLE (420 forms) the read took 0.5 to 0.8 s
-- alone and 1.2 s inside a demo role switch.
--
-- Every read returns the same rows:
--   member_forms_select tests the draft-sharing branch only for forms in
--   private.caller_steward_share_form_ids(), resolved once per statement: the
--   forms named by private.member_draft_steward_shares rows whose steward is
--   the caller, read from the share rows alone. member_draft_shared_to_caller
--   is true only when such a share row names the form, so every form the
--   branch admitted before is in the set, and the function still decides each
--   of them. (The existing private.caller_shared_draft_form_ids is not used: it
--   calls member_draft_shared_to_caller on its form side, which the planner
--   can evaluate for every form in the table before joining the shares.)
--   member_forms_case_identity_scope states the function's first branch in
--   the policy: member_form_scope_and_identity_allowed returns true outright
--   for a form with no case whose template is neither grievance nor
--   alliance_grievance. For any other form the function now runs only where
--   member_forms_select can admit the row: its four branches without their
--   per-row function calls (own form, alliance_grievance template, submitted
--   or in review for a member the caller sees as steward, a draft shared with
--   the caller). Each of member_forms_select's branches implies the matching
--   condition, and a row is read only when both policies hold, so every read
--   returns exactly what it returned before. That needs member_forms_select to
--   be the table's only permissive read policy; the preflight checks it.
-- The functions, the other branches and the other policies on the table are
-- untouched.
--
-- The preflight refuses to run unless both predecessor policies and the two
-- functions are exactly the ones the reviewed migrations installed, and
-- member_forms_select is the only permissive policy that applies to reads.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- pg_get_expr qualifies every non-catalog name under this path, exactly as
-- under an empty one (pg_catalog is always searched), so the md5 is stable.
set local search_path = pg_catalog;

do $preflight$
begin
  if (select pg_catalog.md5(pg_catalog.pg_get_expr(p.polqual, p.polrelid)) from pg_catalog.pg_policy p
      where p.polrelid = 'public.member_forms'::regclass and p.polname = 'member_forms_select'
        and p.polpermissive and p.polcmd = 'r') is distinct from '1a76efe2b86643d42e15798138d5551b' then
    raise exception 'unreviewed predecessor: member_forms_select' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(pg_catalog.pg_get_expr(p.polqual, p.polrelid)) from pg_catalog.pg_policy p
      where p.polrelid = 'public.member_forms'::regclass and p.polname = 'member_forms_case_identity_scope'
        and not p.polpermissive and p.polcmd = 'r') is distinct from '086f71161ad5b6527b8ecf2ca82d98d0' then
    raise exception 'unreviewed predecessor: member_forms_case_identity_scope' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
      where p.oid = 'private.member_draft_shared_to_caller(public.member_forms)'::regprocedure)
      is distinct from 'a1fec0d0f0721e258183ad2bcf3cf7e0' then
    raise exception 'unreviewed predecessor: private.member_draft_shared_to_caller' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
      where p.oid = 'private.member_form_scope_and_identity_allowed(public.member_forms)'::regprocedure)
      is distinct from 'f4730607b5b9c5bdb450b25db543e263' then
    raise exception 'unreviewed predecessor: private.member_form_scope_and_identity_allowed' using errcode = '55000';
  end if;
  if (select pg_catalog.array_agg(p.polname order by p.polname) from pg_catalog.pg_policy p
      where p.polrelid = 'public.member_forms'::regclass and p.polpermissive and p.polcmd in ('r', '*'))
      is distinct from array['member_forms_select']::name[] then
    raise exception 'unreviewed permissive read policies on public.member_forms' using errcode = '55000';
  end if;
end;
$preflight$;

create function private.caller_steward_share_form_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.array_agg(distinct share.form_id), '{}'::uuid[])
  from private.member_draft_steward_shares share
  where share.steward_id = (select auth.uid());
$function$;

revoke all on function private.caller_steward_share_form_ids() from public, anon, authenticated, service_role;
grant execute on function private.caller_steward_share_form_ids() to authenticated;

comment on function private.caller_steward_share_form_ids() is
  'The forms any private.member_draft_steward_shares row shares with the caller as steward, from the share rows alone: a necessary condition of private.member_draft_shared_to_caller. The member_forms read policies resolve it once per statement before that per-row check.';

alter policy member_forms_select on public.member_forms using (
  ((select auth.uid()) = user_id)
  or (template_key = 'alliance_grievance' and public.caller_is_accepted_cosigner(id))
  or (status = any (array['submitted', 'in_review']) and user_id in (select private.staff_visible_member_ids('steward')))
  or (id = any ((select private.caller_steward_share_form_ids())::uuid[])
    and private.member_draft_shared_to_caller(member_forms.*))
);

alter policy member_forms_case_identity_scope on public.member_forms using (
  (case_id is null and template_key <> all (array['grievance', 'alliance_grievance']))
  or (
    ((select auth.uid()) = user_id
      or template_key = 'alliance_grievance'
      or (status = any (array['submitted', 'in_review']) and user_id in (select private.staff_visible_member_ids('steward')))
      or id = any ((select private.caller_steward_share_form_ids())::uuid[]))
    and private.member_form_scope_and_identity_allowed(member_forms.*)
  )
);

comment on policy member_forms_select on public.member_forms is
  'Combine established form reads with active individual draft sharing. Restrictive form scope and private-identity guards apply to both branches; sealed drafts remain excluded from sharing. #7502: the draft-sharing check runs only for forms shared with the caller as steward (private.caller_steward_share_form_ids, resolved once per statement), not for every form.';

comment on policy member_forms_case_identity_scope on public.member_forms is
  'Limit every existing read and write path to active chapter and container authority; private grievance identities require an assigned or oversight role. #7502: a form with no case whose template is neither grievance nor alliance_grievance passes outright, as it does in private.member_form_scope_and_identity_allowed; any other form is checked only where member_forms_select can admit it (its branches without their per-row function calls), which leaves every read unchanged while member_forms_select is the only permissive read policy on the table.';

commit;
