-- BUG-UG-CONVERSATION-STAMP-CHAPTERLESS-SOLE-MEMBERSHIP-20261013
-- Stamp new conversations with the organization for members who have no
-- chapter.
--
-- private.stamp_member_conversation_organization() (20261002135600) stamps a
-- new conversation with private.current_member_organization(), which resolves
-- the organization through member_profiles.chapter_id. A creator with no
-- selected chapter therefore got organization_id null even when they belong
-- to exactly one active organization. Null never matches, so the conversation
-- never took over Home and, since 20261013040000, the Compass source context
-- refuses it before any reservation.
--
-- The INSERT branch now resolves the creator's organization the way
-- private.mi1_w2_selected_organization() (20260903040000) does: with a
-- selected chapter, the chapter's organization exactly as before; with no
-- selected chapter, the creator's sole active membership in an active
-- organization. A chaptered creator whose chapter does not resolve, two or
-- more memberships, or no membership still stamp null and are still refused
-- downstream. The UPDATE branch keeps the stored organization_id, and a
-- trusted server context with no signed-in caller keeps the value it wrote.
-- Existing rows, including every null row, are not touched: no backfill.
--
-- Unchanged: SECURITY DEFINER, empty search_path, no client EXECUTE, the
-- trigger b10_member_conversations_organization and its events.
--
-- public.get_member_home_takeover() selected the caller's organization through
-- the chapter as well, so it is re-emitted below with the same resolution;
-- otherwise a chapterless member's stamped conversation still never reached
-- Home.
--
-- Account lifecycle: the function body changes, so its reviewed
-- referential-action trigger surface rows are re-recorded below. The trigger
-- only reads member_profiles, organization_memberships and organizations and
-- assigns the new row's organization_id. It writes no table, so it fires no
-- nested trigger and adds no depth to the auth.users delete cascade stack,
-- and it never blocks a cascade from auth.users.
--
-- Hosted application: SAMPLE first, then production, by the sole authorized
-- applier.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function private.stamp_member_conversation_organization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if (select auth.uid()) is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.organization_id := private.current_member_organization();
    if new.organization_id is null and not exists (
      select 1
      from public.member_profiles profile
      where profile.id = (select auth.uid())
        and profile.chapter_id is not null
    ) then
      select case when pg_catalog.count(distinct membership.organization_id) = 1
        then pg_catalog.min(membership.organization_id::text)::uuid
        else null
      end into new.organization_id
      from public.organization_memberships membership
      join public.organizations organization
        on organization.id = membership.organization_id
       and organization.status = 'active'
      where membership.user_id = (select auth.uid())
        and membership.status = 'active';
    end if;
  else
    new.organization_id := old.organization_id;
  end if;
  return new;
end;
$function$;

revoke all on function private.stamp_member_conversation_organization() from public, anon, authenticated, service_role;

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select surface.kind, surface.schema_name, surface.table_name, surface.object_name, surface.definition_hash
from private.account_lifecycle_trigger_surface() surface
join (values
  ('function', 'private', '', 'stamp_member_conversation_organization()'),
  ('trigger', 'public', 'member_conversations', 'b10_member_conversations_organization')
) as changed(kind, schema_name, table_name, object_name)
  on surface.kind = changed.kind and surface.schema_name = changed.schema_name
 and surface.table_name = changed.table_name and surface.object_name = changed.object_name
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_chapterless_conversation_stamp_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the chapterless conversation stamp';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after the chapterless conversation stamp';
  end if;
end;
$assert_chapterless_conversation_stamp_lifecycle$;

-- The Home reader selects the caller's organization the same way. It used
-- private.current_member_organization(), so a chapterless caller was refused
-- with 42501 before the conversation filter (round 1 gate). Re-emitted
-- from its newest definition (20261003040000) with one change: the
-- organization comes from private.current_mobile_staff_organization()
-- (20260902050000), the selected chapter's organization first and otherwise
-- the sole active membership in an active organization, which is the
-- resolution the stamp above uses. The PIN full-session guard, MFA, the
-- membership check, the switch and both bounded reads are unchanged.
create or replace function public.get_member_home_takeover()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();

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
  org := private.current_mobile_staff_organization();
  if org is null or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  if not private.organization_feature_enabled(org, 'features.home.unread_message_takeover') then
    return pg_catalog.jsonb_build_object('enabled', false, 'message', null, 'broadcast', null);
  end if;

  -- Newest unread steward direct message to the caller in a conversation of
  -- the selected organization (member_conversations.organization_id, stamped
  -- at creation). A conversation without an organization never matches.
  -- Bounded preview: the full thread opens in Messages.
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
    and c.organization_id = org
    and m.sender_kind = 'steward'
    and m.sender_id is distinct from caller
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

end;
$function$;

revoke all on function public.get_member_home_takeover() from public, anon, authenticated, service_role;
grant execute on function public.get_member_home_takeover() to authenticated;

commit;
