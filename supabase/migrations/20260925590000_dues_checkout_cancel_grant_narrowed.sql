-- DEBT-UG-CANCEL-DUES-CHECKOUT-RESERVATION-GRANTED-AUTHENTICATED-NAMED-DUES-20260921
--
-- public.cancel_dues_checkout_reservation(uuid) was granted to authenticated
-- (20260901200000) and named in the Dues client contract, but no client can
-- call it: neither createDuesAdapter, the web Dues view nor the native Dues and
-- pay screens reach it, and get_my_dues_workspace never returns a reservation
-- id a member could pass. The half-wired grant read as supported member
-- cancellation that does not exist.
--
-- This takes the record's second branch: the contract key is removed and the
-- grant is narrowed to match. The function body is unchanged (its
-- account-deletion body digest still holds); only the direct Data API path
-- closes. service_role already lost it in 20260901200000, and the stalled
-- reservation path stays with the reconciliation worker and the Stripe
-- session expiry, as it does today.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

revoke all on function public.cancel_dues_checkout_reservation(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
