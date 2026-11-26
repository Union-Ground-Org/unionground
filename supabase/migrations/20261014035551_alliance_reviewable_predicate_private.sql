-- SEC-UG-ALLIANCE-REVIEWABLE-PREDICATE-PRIVATE-20261013
-- This owner-context lookup is an RLS helper, not a public RPC. Keep its
-- existing semantics while removing the cross-tenant submission-state oracle.
begin;

create function private.form_is_alliance_reviewable(p_form_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.member_forms
                 where id = p_form_id
                   and template_key = 'alliance_grievance'
                   and status in ('submitted','in_review'));
$$;

revoke all on function private.form_is_alliance_reviewable(uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.form_is_alliance_reviewable(uuid) to authenticated;

-- The filer and invitee policies do not call this helper and stay unchanged.
-- Retain both the accepted-only filter and the chapter/tenant reviewer scope.
alter policy member_form_cosigners_select_steward on public.member_form_cosigners
  using (status = 'accepted'
         and private.form_is_alliance_reviewable(form_id)
         and public.form_owner_in_steward_scope(form_id));
comment on policy member_form_cosigners_select_steward on public.member_form_cosigners is
  'Only accepted co-signers of reviewable alliance forms in the caller''s steward scope; the review-state lookup stays private to avoid a public cross-tenant oracle.';

revoke all on function public.form_is_alliance_reviewable(uuid)
  from public, anon, authenticated, service_role;
drop function public.form_is_alliance_reviewable(uuid);

commit;
