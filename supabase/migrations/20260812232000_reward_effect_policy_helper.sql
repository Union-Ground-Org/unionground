-- UB-RWD-01 integration repair: RLS policies execute as the caller. The
-- reward entitlement predicate is private and returns only a boolean, but
-- authenticated callers still need EXECUTE for PostgreSQL to evaluate the
-- chapter-thread policy that invokes it.

revoke all on function private.member_reward_effect_enabled(uuid, text)
  from public, anon;
grant execute on function private.member_reward_effect_enabled(uuid, text)
  to authenticated;

