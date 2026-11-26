-- BUG-UG-INVITE-STARTING-ACCESS-NO-OFFICER-TITLES-20261003
--
-- Owner decision, October 4, 2026 (12:57 PM ET): officer titles are a
-- "display title plus separately assigned access". A chapter membership can
-- now carry a display title (for example Secretary-Treasurer) that an admin of
-- that chapter sets; access is still granted only through the existing roles.
--
--   * public.member_chapter_memberships.display_title: nullable, 1-60
--     characters, trimmed, no control characters. Members can read their own
--     row as before; the authenticated role has no UPDATE on the table.
--   * public.set_member_chapter_display_title(p_user_id, p_chapter_id, p_title):
--     an admin of that chapter in the selected organization (the invitation
--     target-chapter rule) sets or clears the title of an active membership,
--     with a member_admin_audit row (new action set_chapter_display_title).
--   * public.get_admin_member_directory returns the located membership's
--     displayTitle and displayTitleEditable, the setter's own chapter check,
--     so the directory offers the editor only where a save is permitted.
--   * The account lifecycle export of member_chapter_memberships carries
--     display_title with the other member-owned membership columns.
--
-- A title grants nothing: no policy or function reads display_title for an
-- access decision, and setting one changes no role row.
--
-- Hosted application: SAMPLE first, then production; needs its own owner
-- authorization (not part of the October 4 three-migration grant).

begin;
set local lock_timeout = '5s';

alter table public.member_chapter_memberships
  add column display_title text;
alter table public.member_chapter_memberships
  add constraint member_chapter_memberships_display_title_check
  check (display_title is null or (
    pg_catalog.char_length(display_title) between 1 and 60
    and display_title = pg_catalog.btrim(display_title)
    and display_title !~ '[[:cntrl:]]'));

comment on column public.member_chapter_memberships.display_title is
  'Display-only officer title for this chapter membership, set by an admin of the chapter. Grants nothing: no policy or function reads it for access.';

-- Existing audit table has a closed vocabulary; extend it by the one new
-- action without dropping any settled action from 20260925980000.
alter table public.member_admin_audit drop constraint if exists member_admin_audit_action_check;
alter table public.member_admin_audit add constraint member_admin_audit_action_check
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
    'grant_chapter_membership', 'revoke_chapter_membership',
    'event_checkin_lockout',
    'set_chapter_display_title'
  ));

create function public.set_member_chapter_display_title(p_user_id uuid, p_chapter_id text, p_title text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  clean_title text;
  target_org uuid;
  previous_title text;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  clean_title := nullif(pg_catalog.btrim(coalesce(p_title, '')), '');
  -- The invitation target-chapter rule: an admin of this chapter in the
  -- selected organization. A President or any title holder cannot set titles.
  if caller is null
     or not private.mfa_satisfied()
     or not private.member_invitation_chapter_administrable(p_chapter_id) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if clean_title is not null and (pg_catalog.char_length(clean_title) > 60 or clean_title ~ '[[:cntrl:]]') then
    raise exception 'invalid display title' using errcode = '22023';
  end if;
  select c.organization_id into target_org from public.chapters c where c.id = p_chapter_id;

  select m.display_title into previous_title
  from public.member_chapter_memberships m
  where m.user_id = p_user_id and m.chapter_id = p_chapter_id and m.status = 'active'
  for update;
  if not found then
    raise exception 'membership not found' using errcode = '22023';
  end if;

  update public.member_chapter_memberships
  set display_title = clean_title
  where user_id = p_user_id and chapter_id = p_chapter_id and status = 'active';

  insert into public.member_admin_audit (actor, action, target_user, detail, organization_id)
  values (caller, 'set_chapter_display_title', p_user_id,
    pg_catalog.jsonb_build_object('chapterId', p_chapter_id, 'title', clean_title,
      'previousTitle', previous_title),
    target_org);

  return pg_catalog.jsonb_build_object('updated', true, 'displayTitle', clean_title);
end;
$function$;

revoke all on function public.set_member_chapter_display_title(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.set_member_chapter_display_title(uuid, text, text)
  to authenticated;

create or replace function public.get_admin_member_directory(
  p_query text default null,
  p_after_name text default null,
  p_after_id uuid default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  caller_chapter text := private.current_member_chapter();
  org_admin boolean := private.has_organization_role(caller_org, array['admin']);
  needle text := pg_catalog.btrim(coalesce(p_query, ''));
  cap integer := coalesce(p_limit, 25);
  result jsonb;
begin
  if caller is null or caller_org is null or caller_chapter is null
     or not (org_admin or private.member_has_chapter_role(caller_chapter, array['admin'])) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if cap < 1 or cap > 50 then
    raise exception 'limit out of range' using errcode = '22023';
  end if;
  if (p_after_name is null and p_after_id is not null)
     or (p_after_name is not null and p_after_id is null) then
    raise exception 'incomplete cursor' using errcode = '22023';
  end if;
  if needle <> '' and pg_catalog.char_length(needle) < 2 then
    raise exception 'query too short' using errcode = '22023';
  end if;
  needle := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
    needle, '\', '\\'), '%', '\%'), '_', '\_');

  with candidates as materialized (
    select p.id, p.full_name, p.initials,
      p.member_since::integer as member_since_year,
      located.chapter_id, located.chapter_name, located.display_title,
      private.organization_member_roles(
        p.id, caller_org, case when org_admin then null else caller_chapter end
      ) as roles
    from public.member_profiles p
    join public.organization_memberships om
      on om.user_id = p.id
     and om.organization_id = caller_org
     and om.status = 'active'
    join lateral (
      select c.id as chapter_id, c.name as chapter_name, cm.display_title
      from public.member_chapter_memberships cm
      join public.chapters c
        on c.id = cm.chapter_id
       and c.organization_id = caller_org
      where cm.user_id = p.id
        and cm.status = 'active'
        and (org_admin or c.id = caller_chapter)
      order by (c.id = p.chapter_id) desc, c.order_index, c.id
      limit 1
    ) located on true
    where (needle = '' or p.full_name ilike '%' || needle || '%' escape '\')
      and (p_after_name is null or (p.full_name, p.id) > (p_after_name, p_after_id))
    order by p.full_name, p.id
    limit cap + 1
  ), page as (
    select * from candidates order by full_name, id limit cap
  )
  select pg_catalog.jsonb_build_object(
    'items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'userId', s.id,
        'fullName', s.full_name,
        'initials', s.initials,
        'memberSince', s.member_since_year,
        'chapterId', s.chapter_id,
        'chapterName', s.chapter_name,
        'displayTitle', s.display_title,
        'displayTitleEditable', private.member_invitation_chapter_administrable(s.chapter_id),
        'roles', s.roles
      ) order by s.full_name, s.id)
      from page s
    ), '[]'::jsonb),
    'nextCursor', case when (select pg_catalog.count(*) from candidates) > cap then (
      select pg_catalog.jsonb_build_object('name', s.full_name, 'id', s.id)
      from page s order by s.full_name desc, s.id desc limit 1
    ) else null end
  ) into result;
  return result;
end;
$function$;

revoke all on function public.get_admin_member_directory(text, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.get_admin_member_directory(text, text, uuid, integer)
  to authenticated;

-- A title is member-owned membership data, so the account export carries it
-- (20261003065000 pinned the projection's columns).
update private.account_lifecycle_manifest
set export_columns = array['user_id','chapter_id','status','pinned','last_selected_at','joined_at','revoked_at',
  'compass_unit_keys','compass_scope_verification','display_title']::text[]
where schema_name = 'public' and table_name = 'member_chapter_memberships' and user_column = 'user_id';
create or replace function private.account_lifecycle_export_member_chapter_memberships(p_caller uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'user_id', t.user_id, 'chapter_id', t.chapter_id, 'status', t.status, 'pinned', t.pinned,
    'last_selected_at', t.last_selected_at, 'joined_at', t.joined_at, 'revoked_at', t.revoked_at,
    'compass_unit_keys', t.compass_unit_keys, 'compass_scope_verification', t.compass_scope_verification,
    'display_title', t.display_title)), '[]'::jsonb)
  from public.member_chapter_memberships t where t.user_id = p_caller;
$$;
revoke all on function private.account_lifecycle_export_member_chapter_memberships(uuid)
  from public, anon, authenticated, service_role;

commit;
