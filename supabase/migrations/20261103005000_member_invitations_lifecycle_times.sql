-- BUG-UG-ACCEPTED-INVITATIONS-SHOW-EXPIRY-20261102 (#6816): the
-- invitation lists showed the link's expiry on accepted and revoked rows. Each
-- listed invitation now also carries when it was accepted (accepted_at, always
-- set on an accepted row) and when it was revoked (revoked_at, null where a
-- revocation recorded no time), so the lists show the time that matches the
-- status. The caller gate, chapter scope, cap and every other field are
-- unchanged from 20261022171700.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

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
        'createdAt', s.created_at,
        'acceptedAt', s.accepted_at,
        'revokedAt', s.revoked_at
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
  from public, anon, authenticated, service_role;
grant execute on function public.get_member_invitations(integer)
  to authenticated;

commit;
