-- History alias for 20261019174000_password_signin_success_refunds.sql.
-- This file carried the same reservation ledger and refund functions, ported
-- before the upstream migration was imported under its own, earlier version.
-- Keep this file as a no-op so a replay creates them once.
-- The transaction keeps the wrapper every migration carries; the one
-- read-only select names the alias, so no two no-op versions are identical.
begin;
select 'history alias of 20261019174000_password_signin_success_refunds' as history_alias;
commit;
