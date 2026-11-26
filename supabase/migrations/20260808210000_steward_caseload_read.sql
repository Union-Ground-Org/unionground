-- REQ-UNION-BASE-STEWARD-CASELOAD-READ-20260808 (role-map record UB-CASE-05)
--
-- The data contract has forbidden every steward read of member_cases since
-- 20260728170500_member_case_assignees ("a steward read here would widen the
-- caseload plane"): a steward could BE assigned to a case through
-- assign_member_case but had no list, queue, or detail view of it — the
-- assignment was invisible to the person carrying it.
--
-- recorded in the role-function map (UB-CASE-05)
-- requires stewards to see their
-- own caseload. The grant is ASSIGNEE-scoped — deliberately narrower than the
-- coordinator's chapter-wide staff_can_see_user widening. The scope predicate
-- is the assignment column itself, steward_user_id = auth.uid(), nothing
-- chapter-wide; the two policiesForbidden pins in scripts/db-contract.json
-- retire in the same commit and are replaced by policy pins whose
-- qualExcludes forbid staff_can_see_user from ever entering these two
-- policies.
--
-- member_has_role(array['steward']) rides in both quals so a revoked steward
-- hat loses the read even while stale assignment rows linger, and because
-- member_has_role embeds private.mfa_satisfied() the step-up factor applies
-- on top of the tables' restrictive mfa_assurance policies. The partial index
-- member_cases_steward_idx (20260728170500) already serves the predicate.

create policy member_cases_select_steward on public.member_cases
  for select to authenticated
  using (
    steward_user_id = (select auth.uid())
    and public.member_has_role(array['steward'])
  );

-- The timeline read rides the same assignee scope: an update row is visible
-- exactly when its parent case is an assigned one. The EXISTS subquery is the
-- member_case_updates_select_own shape with the ownership predicate swapped
-- for the assignment predicate; the parent-row visibility it depends on is
-- granted by member_cases_select_steward above.
create policy member_case_updates_select_steward on public.member_case_updates
  for select to authenticated
  using (
    public.member_has_role(array['steward'])
    and exists (
      select 1 from public.member_cases c
      where c.id = case_id
        and c.steward_user_id = (select auth.uid())
    )
  );
