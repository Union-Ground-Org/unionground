-- REQ-UG-HOME-OVERRIDE-UNREAD-STEWARD-MESSAGE-20261001
--
-- Restore-everything campaign,. The old member home put the
-- newest unread steward direct message and the newest unread chapter
-- broadcast at the top of the page until the member read them
-- (de7df4b57c^:components/home/lib/load-member-home.ts
-- loadConditionalGateOverrides, components/home/override-slot-client.tsx,
-- "Mark read" on the direct-message card). The current product shows
-- broadcasts only inside the date-ordered Home feed (src/lib/homeFeed.js).
--
-- This migration adds:
--   * the organization switch features.home.unread_message_takeover
--     (member_visible, category home). Default ON: the old flag
--     redesign_member_home_conditional_enabled was created 'false' by
--     de7df4b57c^:supabase/migrations/0319_redesign_member_home_conditional_flag.sql:2
--     and forced to 'true' for every deployment by
--     de7df4b57c^:supabase/migrations/0480_force_redesign_settings.sql:18,
--     which is the effective production value the campaign restores (D2).
--   * public.get_member_home_takeover(), the one read both web and native call.
--     The server enforces the switch: with it off the RPC returns no content.
--
-- Boundaries kept:
--   * The caller reads only what they can already read through RLS: their own
--     steward messages (member_messages.user_id = caller) and broadcasts in
--     private.visible_member_broadcast_ids(), the exact predicate behind the
--     member_broadcasts SELECT policy. Nothing new becomes readable.
--   * A removed (redacted) message is never returned; its body no longer
--     exists (Message body lifecycle contract).
--   * A broadcast published before the caller joined the selected
--     organization is not a takeover: the old card was driven by per-member
--     notifications created at send time, so it never surfaced history from
--     before the member existed. Those rows stay in the Home feed.
--   * Read state uses the existing writers only (member_messages.read_at via
--     markConversationRead, member_broadcast_receipts via markBroadcastRead).
--     No table, column, or per-user log is added.

begin;

set local lock_timeout = '5s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  -- Old effective default ON: 0480_force_redesign_settings.sql:18 (see header).
  ('features.home.unread_message_takeover', 'boolean', 'Unread steward message takes over Home',
   'Show the newest unread steward message and the newest unread broadcast at the top of member Home until the member marks them read.',
   'true'::jsonb, null, null, null, 1300, 'home', true)
on conflict (key) do nothing;

create function public.get_member_home_takeover()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid;
  joined_at timestamptz;
  message_item jsonb;
  broadcast_item jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  org := private.current_member_organization();
  if org is null or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  if not private.organization_feature_enabled(org, 'features.home.unread_message_takeover') then
    return pg_catalog.jsonb_build_object('enabled', false, 'message', null, 'broadcast', null);
  end if;

  -- Newest unread steward direct message to the caller. Bounded preview: the
  -- full thread opens in Messages.
  select pg_catalog.jsonb_build_object(
      'id', m.id,
      'conversationId', m.conversation_id,
      'senderName', m.sender_name,
      'body', pg_catalog.left(m.body, 600),
      'truncated', pg_catalog.char_length(m.body) > 600,
      'createdAt', m.created_at
    )
  into message_item
  from public.member_messages m
  join public.member_conversations c on c.id = m.conversation_id and c.user_id = caller
  where m.user_id = caller
    and m.sender_kind = 'steward'
    and m.read_at is null
    and m.redacted_at is null
  order by m.created_at desc, m.id desc
  limit 1;

  select membership.created_at into joined_at
  from public.organization_memberships membership
  where membership.organization_id = org
    and membership.user_id = caller
    and membership.status = 'active';

  -- Newest unread broadcast the caller can see, published since they joined.
  select pg_catalog.jsonb_build_object(
      'id', b.id,
      'sender', b.sender,
      'title', b.title,
      'body', pg_catalog.left(b.body, 600),
      'truncated', pg_catalog.char_length(b.body) > 600,
      'publishedAt', b.published_at,
      'audience', b.audience_scope
    )
  into broadcast_item
  from public.member_broadcasts b
  where b.id in (select private.visible_member_broadcast_ids())
    and b.organization_id = org
    and b.retracted_at is null
    and b.published_at <= pg_catalog.now()
    and (joined_at is null or b.published_at >= joined_at)
    and not exists (
      select 1 from public.member_broadcast_receipts r
      where r.broadcast_id = b.id and r.user_id = caller
    )
  order by b.published_at desc, b.id desc
  limit 1;

  return pg_catalog.jsonb_build_object(
    'enabled', true,
    'message', message_item,
    'broadcast', broadcast_item
  );
end;
$function$;

revoke all on function public.get_member_home_takeover() from public, anon, authenticated, service_role;
grant execute on function public.get_member_home_takeover() to authenticated;

comment on function public.get_member_home_takeover() is
  'REQ-UG-HOME-OVERRIDE-UNREAD-STEWARD-MESSAGE-20261001: newest unread steward direct message and newest unread visible broadcast for member Home. MFA-guarded, bounded to the caller''s own messages and the member_broadcasts SELECT predicate; returns no content when features.home.unread_message_takeover is off.';

notify pgrst, 'reload schema';

commit;
