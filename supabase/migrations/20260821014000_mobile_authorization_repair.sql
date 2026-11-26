-- Restore the two authorization boundaries used by the mobile ship-complete
-- workflows. This migration changes no tenant or member data.

set local lock_timeout = '5s';

-- Preserve every settled action while admitting the two audited membership
-- transitions introduced by 20260821010000_mobile_multichapter_identity.sql.
alter table public.member_admin_audit
  drop constraint if exists member_admin_audit_action_check;
alter table public.member_admin_audit
  add constraint member_admin_audit_action_check
  check (action in (
    'grant_role', 'revoke_role',
    'create_event', 'update_event', 'cancel_event', 'restore_event', 'delete_event',
    'reset_mfa',
    'claim_reward', 'grant_reward', 'revoke_reward', 'fulfill_reward',
    'set_staff_mfa_policy',
    'set_compass_ai_enabled', 'set_compass_ai_role_limit', 'attest_compass_ai_provider',
    'create_campaign', 'update_campaign_draft', 'publish_campaign', 'close_campaign',
    'recover_signin_address', 'recover_signin_address_failed',
    'review_email_intake',
    'create_chapter', 'update_chapter',
    'grant_chapter_membership', 'revoke_chapter_membership'
  ));

-- Authenticated RLS policies invoke this private SECURITY DEFINER predicate.
-- PostgreSQL checks EXECUTE before evaluating the policy expression, so the
-- helper must be callable by that role while remaining unavailable to anon,
-- public, and direct service-role calls.
revoke all on function private.member_has_chapter_role(text, text[])
  from public, anon, authenticated, service_role;
grant execute on function private.member_has_chapter_role(text, text[])
  to authenticated;
