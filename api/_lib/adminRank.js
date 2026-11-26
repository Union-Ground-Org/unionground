// Admin rank guard for the account-recovery endpoints (sign-in address
// change, password reissue, MFA reset).
//
// The rule lives in the database (supabase/migrations/
// 20261125120100_admin_rank_guard_on_account_takeover.sql): an administrator
// may run these actions on another account only when that account holds no
// admin rank in the organization, or the actor's rank is strictly higher
// (organization-wide admin over chapter admin). A refusal arrives as the
// RPC's ordinary 42501 (HTTP 403).
//
// The authorizing RPC also answers `adminRank: "checked"`. The endpoints
// refuse to continue without that marker, so this code never changes another
// account on a database that predates the guard.
export const ADMIN_RANK_CHECKED = "checked";

export function adminRankChecked(payload) {
  return payload?.adminRank === ADMIN_RANK_CHECKED;
}
