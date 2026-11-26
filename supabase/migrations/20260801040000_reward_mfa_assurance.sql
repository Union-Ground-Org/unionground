-- The reward tables were born after the mfa_assurance DO loop ran
-- (20260724030000), so they need the restrictive step-up policy explicitly —
-- the exact gap the live contract sweep exists to catch, and it did. Without
-- this, an aal1 session belonging to a member who HAS a verified TOTP factor
-- could read the catalog and their own grant ledger before completing the
-- challenge. Same shape as union_orgs' explicit copy (20260726164045).

set local lock_timeout = '5s';

create policy mfa_assurance
  on public.member_reward_items
  as restrictive
  for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

create policy mfa_assurance
  on public.member_reward_grants
  as restrictive
  for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

notify pgrst, 'reload schema';
