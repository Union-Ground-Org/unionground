-- UX-UG-ROSTER-IMPORT-TAKES-DAYS-20261018
-- A chapter administrator bringing in a roster from CSV gets its own limits and
-- longer links. Values set by a project decision of October 21, 2026:
--   roster import: 100 invitations per administrator per hour, 500 per chapter per
--   day, links valid 7 days (a resend of a roster invitation keeps 7 days);
--   ad-hoc invitations unchanged: 10 per administrator per hour, 50 per chapter per
--   day, links valid 15 minutes.
-- public.create_member_invitation is not re-emitted. A refusal at a roster limit
-- names the limit and when the next batch can go.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

alter table public.member_invitations
  add column source text not null default 'adhoc'
  constraint member_invitations_source_check check (source in ('adhoc', 'roster'));

-- The roster counters are their own windows in the existing throttle table.
alter table private.member_invitation_admin_limits
  drop constraint member_invitation_admin_limits_operation_check,
  add constraint member_invitation_admin_limits_operation_check
    check (operation in ('create-hour', 'chapter-day', 'resend-hour', 'invitation-resend-hour', 'roster-hour', 'roster-day', 'roster-lookup-hour'));

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum,
   allowed_values, sort_order, category, member_visible)
values
  ('limits.security.invitation_roster_admin_hourly', 'integer', 'Roster import invitations per admin per hour',
   'Maximum roster-import invitation attempts by one chapter admin in an hour. Ad-hoc invitations keep their own limit.', '100'::jsonb, 1, 500, null, 2681, 'security', false),
  ('limits.security.invitation_roster_chapter_daily', 'integer', 'Roster import invitations per chapter per day',
   'Maximum roster-import invitation attempts for one chapter in a day. Ad-hoc invitations keep their own limit.', '500'::jsonb, 1, 2500, null, 2682, 'security', false),
  ('limits.security.invitation_roster_lookup_hourly', 'integer', 'Roster import rows checked per admin per hour',
   'Maximum roster rows one chapter admin can check in an hour, including rows already invited or with an account. Twice the 500-row CSV, so re-sending a whole roster never stops on it.', '1000'::jsonb, 1, 5000, null, 2683, 'security', false)
on conflict (key) do nothing;

-- When a refused window opens again. The refusal rolls back its own count, so
-- this reads the window the earlier, committed attempts opened.
create function private.member_invitation_limit_retry_at(p_scope_key text, p_operation text, p_window interval)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $function$
  select l.window_started_at + p_window
  from private.member_invitation_admin_limits l
  where l.scope_key = p_scope_key and l.operation = p_operation
$function$;

revoke all on function private.member_invitation_limit_retry_at(text, text, interval)
  from public, anon, authenticated, service_role;

create function public.create_roster_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_locale text, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_inviter_chapter();
  target_chapter text := pg_catalog.btrim(coalesce(p_chapter_id, ''));
  clean_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  clean_name text := pg_catalog.btrim(coalesce(p_full_name, ''));
  clean_locale text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_locale, '')));
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  organization uuid;
  name_parts text[];
  clean_first text;
  clean_initials text;
  invitation_row public.member_invitations%rowtype;
  expired_row public.member_invitations%rowtype;
  refused_limit text;
  refused_scope text;
  refused_operation text;
  refused_window interval;
  day_retry timestamptz;
  refused_retry timestamptz;
begin
  -- Roster import is for chapter administrators only; a chapter President keeps
  -- the ad-hoc invitation and its limits.
  if caller is null or not private.member_has_chapter_role(caller_chapter, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if not private.member_invitation_chapter_administrable(target_chapter) then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  -- A malformed request is refused before any lookup or charge, the same way
  -- for every address. Validating after the account probe let an unknown
  -- address raise (rolling back its lookup charge) while an existing one
  -- answered 202, which is free probing.
  name_parts := pg_catalog.regexp_split_to_array(clean_name, '[[:space:]]+');
  clean_first := name_parts[1];
  clean_initials := pg_catalog.upper(
    pg_catalog.left(clean_first, 1)
    || case when pg_catalog.array_length(name_parts, 1) > 1
       then pg_catalog.left(name_parts[pg_catalog.array_length(name_parts, 1)], 1)
       else '' end
  );
  if pg_catalog.char_length(clean_email) not between 3 and 254
     or clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or pg_catalog.char_length(clean_name) not between 2 and 120
     or clean_name ~ '[[:cntrl:]]'
     or pg_catalog.char_length(coalesce(clean_first, '')) not between 1 and 80
     or clean_hash !~ '^[0-9a-f]{64}$'
     or clean_locale not in ('en', 'es') then
    raise exception 'invalid invitation request' using errcode = '22023';
  end if;

  -- Every row is charged to the roster lookup throttle before any lookup can
  -- shape the answer, so the endpoint stays bounded for address probing
  -- (count-before-lookup, as in the ad-hoc create). An address that already
  -- has an account or a live invitation is then answered without touching the
  -- sending allowance, so re-sending a roster that lists current members, or
  -- people already invited, never exhausts it (project decision 20261021-2220,
  -- option b). A failed delivery is not a no-op: re-sending it creates a new
  -- invitation and email, and that counts as a send.
  organization := private.current_member_organization();
  if not private.consume_member_invitation_admin_limit(
    'admin:' || caller::text, 'roster-lookup-hour', private.organization_limit(organization, 'limits.security.invitation_roster_lookup_hourly'), interval '1 hour'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001',
      detail = pg_catalog.jsonb_build_object(
        'limit', 'limits.security.invitation_roster_lookup_hourly',
        'retryAt', private.member_invitation_limit_retry_at('admin:' || caller::text, 'roster-lookup-hour', interval '1 hour')
      )::text;
  end if;
  -- Everything after the lookup charge runs in one subtransaction. Only an
  -- unknown address reaches the sending charges, the expiry update and the
  -- insert, so any error there (a constraint, a reused token hash, an audit
  -- write) must not roll the charge back: it is caught here, only this block
  -- is undone, and a refusal is returned with the charge committed for every
  -- address.
  begin
  if exists (
    select 1 from auth.users u
    where pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))) = clean_email
  ) or exists (
    select 1 from public.member_invitations i
    where i.normalized_email = clean_email
      and (i.status = 'accepting' or (i.status = 'pending' and i.expires_at > clock_timestamp()))
  ) then
    return pg_catalog.jsonb_build_object('accepted', true, 'send', false);
  end if;

  -- The sending charges run in their own subtransaction. A refusal rolls back
  -- only roster-hour and roster-day; the lookup charge above stays committed,
  -- and the refusal is returned as a result (the API answers 429). A RAISE
  -- here would also undo the lookup charge, so once the sending allowance was
  -- spent an unknown address would cost nothing while an existing one cost a
  -- lookup: free probing for accounts.
  begin
    if not private.consume_member_invitation_admin_limit(
      'admin:' || caller::text, 'roster-hour', private.organization_limit(organization, 'limits.security.invitation_roster_admin_hourly'), interval '1 hour'
    ) then
      refused_limit := 'limits.security.invitation_roster_admin_hourly';
      refused_scope := 'admin:' || caller::text;
      refused_operation := 'roster-hour';
      refused_window := interval '1 hour';
    elsif not private.consume_member_invitation_admin_limit(
      'chapter:' || target_chapter, 'roster-day', private.organization_limit(organization, 'limits.security.invitation_roster_chapter_daily'), interval '1 day'
    ) then
      refused_limit := 'limits.security.invitation_roster_chapter_daily';
      refused_scope := 'chapter:' || target_chapter;
      refused_operation := 'roster-day';
      refused_window := interval '1 day';
    end if;
    -- An hourly stop while the chapter's daily window is also spent reports the
    -- later of the two, so the retry time is when sending can actually resume.
    if refused_operation = 'roster-hour' then
      select l.window_started_at + interval '1 day' into day_retry
      from private.member_invitation_admin_limits l
      where l.scope_key = 'chapter:' || target_chapter and l.operation = 'roster-day'
        and l.window_started_at + interval '1 day' > clock_timestamp()
        and l.request_count >= private.organization_limit(organization, 'limits.security.invitation_roster_chapter_daily');
      if day_retry is not null
         and day_retry > private.member_invitation_limit_retry_at(refused_scope, refused_operation, refused_window) then
        refused_limit := 'limits.security.invitation_roster_chapter_daily';
        refused_scope := 'chapter:' || target_chapter;
        refused_operation := 'roster-day';
        refused_window := interval '1 day';
      end if;
    end if;
    if refused_limit is not null then
      refused_retry := private.member_invitation_limit_retry_at(refused_scope, refused_operation, refused_window);
      raise exception 'invitation rate limited' using errcode = 'P0001';
    end if;
  exception when sqlstate 'P0001' then
    if refused_limit is null then
      raise;
    end if;
    return pg_catalog.jsonb_build_object(
      'accepted', false, 'send', false, 'rateLimited', true,
      'limit', refused_limit, 'retryAt', refused_retry);
  end;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-email:' || clean_email, 509)
  );

  for expired_row in
    update public.member_invitations
    set status = 'expired', token_hash = null, failure_code = null
    where normalized_email = clean_email
      and status = 'pending'
      and expires_at <= clock_timestamp()
    returning *
  loop
    perform private.audit_member_invitation(
      expired_row.id, expired_row.chapter_id, caller, 'invite_expired',
      pg_catalog.jsonb_build_object('chapterId', expired_row.chapter_id,
        'deliveryVersion', expired_row.delivery_version)
    );
  end loop;

  if exists (
    select 1 from auth.users u
    where pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))) = clean_email
  ) or exists (
    select 1 from public.member_invitations i
    where i.normalized_email = clean_email and i.status in ('pending', 'accepting')
  ) then
    return pg_catalog.jsonb_build_object('accepted', true, 'send', false);
  end if;

  insert into public.member_invitations
    (normalized_email, full_name, first_name, initials, chapter_id,
     initial_role, locale, token_hash, status, delivery_version, invited_by,
     expires_at, source)
  values
    (clean_email, clean_name, clean_first, clean_initials, target_chapter,
     null, clean_locale, clean_hash, 'pending', 1, caller,
     clock_timestamp() + interval '7 days', 'roster')
  returning * into invitation_row;

  perform private.audit_member_invitation(
    invitation_row.id, target_chapter, caller, 'invite_requested',
    pg_catalog.jsonb_build_object('chapterId', target_chapter,
      'initialRole', null, 'locale', clean_locale, 'source', 'roster',
      'deliveryVersion', invitation_row.delivery_version)
  );

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'send', true,
    'invitationId', invitation_row.id,
    'deliveryVersion', invitation_row.delivery_version,
    'expiresAt', invitation_row.expires_at,
    'source', 'roster'
  );
  exception when others then
    return pg_catalog.jsonb_build_object('accepted', false, 'send', false, 'unavailable', true);
  end;
end;
end;
$function$;

revoke all on function public.create_roster_member_invitation(text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.create_roster_member_invitation(text, text, text, text, text)
  to authenticated;

-- A resend keeps the original's lifetime: 7 days for a roster invitation, 15
-- minutes for an ad-hoc one. Otherwise unchanged from 20261004040000.
create or replace function public.resend_member_invitation(p_invitation_id uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Installed Main carries this routine wrapped by the reviewed case-graph
  -- entry block of 20260907151000 (gate before declaration initializers);
  -- re-emitting it keeps that outer gate.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_inviter_chapter();
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  old_row public.member_invitations%rowtype;
  new_row public.member_invitations%rowtype;
begin
  if caller is null
     or not (private.member_has_chapter_role(caller_chapter, array['admin'])
             or private.member_invitation_chapter_presided(caller_chapter)) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;
  if not private.consume_member_invitation_admin_limit(
    'admin:' || caller::text, 'resend-hour', private.organization_limit(private.current_member_organization(), 'limits.security.invitation_resend_admin_hourly'), interval '1 hour'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001';
  end if;
  if clean_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid invitation request' using errcode = '22023';
  end if;

  -- An invitation of any chapter the caller administers in the selected
  -- organization; every other id gets the same no-op answer as a missing one.
  select * into old_row
  from public.member_invitations
  where id = p_invitation_id
    and (private.member_invitation_chapter_administrable(chapter_id)
         or (initial_role is null and kind = 'provision'
             and private.member_invitation_chapter_presided(chapter_id)))
  for update;
  if not found or old_row.status not in ('pending', 'delivery_failed', 'expired') then
    return pg_catalog.jsonb_build_object('accepted', true, 'send', false);
  end if;
  if not private.consume_member_invitation_admin_limit(
    'invitation:' || old_row.id::text, 'invitation-resend-hour', private.organization_limit(private.current_member_organization(), 'limits.security.invitation_resend_per_invite_hourly'), interval '1 hour'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001';
  end if;

  update public.member_invitations
  set status = 'superseded', token_hash = null, failure_code = null
  where id = old_row.id;

  insert into public.member_invitations
    (normalized_email, full_name, first_name, initials, chapter_id,
     initial_role, locale, token_hash, status, delivery_version, invited_by,
     replaces_id, expires_at, kind, source)
  values
    (old_row.normalized_email, old_row.full_name, old_row.first_name,
     old_row.initials, old_row.chapter_id, old_row.initial_role, old_row.locale,
     clean_hash, 'pending', old_row.delivery_version + 1, caller, old_row.id,
     clock_timestamp() + case when old_row.source = 'roster' then interval '7 days' else interval '15 minutes' end,
     old_row.kind, old_row.source)
  returning * into new_row;

  perform private.audit_member_invitation(
    new_row.id, new_row.chapter_id, caller, 'invite_resent',
    pg_catalog.jsonb_build_object('chapterId', new_row.chapter_id,
      'deliveryVersion', new_row.delivery_version,
      'replacesInvitationId', old_row.id)
  );

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'send', true,
    'invitationId', new_row.id,
    'deliveryVersion', new_row.delivery_version,
    'expiresAt', new_row.expires_at,
    'normalizedEmail', new_row.normalized_email,
    'fullName', new_row.full_name,
    'locale', new_row.locale,
    'source', new_row.source
  );
end;
end;
$function$;

revoke all on function public.resend_member_invitation(uuid, text)
  from public, anon, authenticated;
grant execute on function public.resend_member_invitation(uuid, text)
  to authenticated;

-- The desk lists every actionable invitation, not only the newest 100 per
-- chapter (gate on #5696: roster imports leave many live for 7 days).
-- Otherwise unchanged from 20261004040000.
create or replace function public.get_member_invitations(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_inviter_chapter();
  cap integer := greatest(1, least(coalesce(p_limit, 50), 100));
  chapter_name text;
  caller_org uuid;
  administrable text[];
  presided text[];
begin
  if caller is null
     or not (private.member_has_chapter_role(caller_chapter, array['admin'])
             or private.member_invitation_chapter_presided(caller_chapter)) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select p.chapter_id, c.name, c.organization_id into caller_chapter, chapter_name, caller_org
  from public.member_profiles p
  join public.chapters c on c.id = p.chapter_id
  where p.id = caller;
  if caller_chapter is null or caller_org is null then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  -- Chapters the caller administers (every invitation, any starting access)
  -- and, separately, chapters the caller presides over without administering
  -- them (plain-member invitations only).
  select coalesce(pg_catalog.array_agg(c.id order by c.order_index, c.name, c.id), array[]::text[])
    into administrable
  from public.chapters c
  where c.organization_id = caller_org
    and private.member_invitation_chapter_administrable(c.id);
  select coalesce(pg_catalog.array_agg(c.id order by c.order_index, c.name, c.id), array[]::text[])
    into presided
  from public.chapters c
  where c.organization_id = caller_org
    and not (c.id = any(administrable))
    and private.member_invitation_chapter_presided(c.id);

  return pg_catalog.jsonb_build_object(
    'chapter', pg_catalog.jsonb_build_object('id', caller_chapter, 'name', chapter_name),
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', c.id, 'name', c.name,
          'grantsAccess', c.id = any(administrable))
        order by c.order_index, c.name, c.id)
      from public.chapters c
      where c.id = any(administrable) or c.id = any(presided)
    ), '[]'::jsonb),
    'items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', s.id,
        'kind', s.kind,
        'normalizedEmail', s.normalized_email,
        'fullName', s.full_name,
        'chapterId', s.chapter_id,
        'chapterName', s.chapter_name,
        'initialRole', s.initial_role,
        'locale', s.locale,
        'status', case when s.status = 'pending' and s.expires_at <= clock_timestamp()
                  then 'expired' else s.status end,
        'deliveryVersion', s.delivery_version,
        'expiresAt', s.expires_at,
        'createdAt', s.created_at
      ) order by s.created_at desc, s.id)
      -- The cap applies per chapter to history, as it did when the desk saw one
      -- chapter; actionable rows are never pushed out by it.
      from pg_catalog.unnest(administrable || presided) as a(chapter_id)
      cross join lateral (
        select i.*, c.name as chapter_name
        from public.member_invitations i
        join public.chapters c on c.id = i.chapter_id
        where i.chapter_id = a.chapter_id and i.status <> 'superseded'
          and (a.chapter_id = any(administrable)
               or (i.initial_role is null and i.kind = 'provision'))
          -- Newest history up to the cap, plus every invitation still
          -- actionable (live, accepting or failed delivery): a roster import
          -- keeps hundreds live for 7 days, and each must stay revocable.
          and (i.id in (
                 select newest.id from public.member_invitations newest
                 where newest.chapter_id = a.chapter_id and newest.status <> 'superseded'
                   and (a.chapter_id = any(administrable)
                        or (newest.initial_role is null and newest.kind = 'provision'))
                 order by newest.created_at desc, newest.id
                 limit cap)
               or i.status in ('accepting', 'delivery_failed')
               or (i.status = 'pending' and i.expires_at > clock_timestamp()))
        order by i.created_at desc, i.id
      ) s
    ), '[]'::jsonb)
  );
end;
end;
$function$;


revoke all on function public.get_member_invitations(integer)
  from public, anon, authenticated;
grant execute on function public.get_member_invitations(integer)
  to authenticated;

commit;
