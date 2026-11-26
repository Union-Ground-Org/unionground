-- SEC-UG-UNIT-STEWARD-CHANNEL-SEARCH-SHOWS-OTHER-UNITS-MEMBERS-20261115 (#8850).
--
-- A steward limited to one unit (a scope row in private.chapter_role_scopes
-- or private.organization_steward_unit_assignments) got the whole chapter's
-- members, name and id, from two channel functions, including members of
-- another unit who are not in the channel:
-- - public.search_chapter_space_members (the channel's add-people search)
--   matched every member profile of the space's chapter;
-- - public.list_channel_mention_candidates gave any staff caller every
--   active member of the chapter who can read the channel.
-- The rule since #8589 (20261113115000) is that a steward limited to a unit
-- sees only their own unit's members. Found by the non-interference proof of
-- #8359 batch 11 (tests/non-interference-db.test.js, the unit pair).
--
-- Both functions now take the member set from the one helper the
-- member_profiles row policy and the staff overviews already use,
-- private.staff_visible_member_ids(role) over the five staff roles (the
-- overviews' form, 20261113115000). That helper carries the #8589 scope
-- rule: a chapter lead, an organization administrator and a steward with no
-- unit limit get the whole chapter, a steward limited to a unit gets that
-- unit's members (private.chapter_scoped_member_ids, the set form of
-- private.chapter_scoped_role_allows). No second version of the rule is
-- written here.
-- - search_chapter_space_members: a match must also be a member the caller
--   may see, or the caller's own profile, as the member_profiles row policy
--   allows (a steward who covers one unit but personally belongs to another
--   can still find themselves to re-join a channel; gate round 1, stage 218).
--   Everything else is unchanged.
-- - The mention list never offers the caller themselves, so it needs no
--   such exception.
-- - list_channel_mention_candidates: the staff arm keeps the chapter's
--   active members the caller may see, plus the channel's own members (its
--   creator and chapter_space_members rows), whom every participant may know
--   are in it. Channel authors and the published chapter stewards stay
--   candidates for every caller, as for an ordinary member. A caller who is
--   not staff gets exactly what they got before.
-- The filter is applied before the limit, so a hidden member leaves no gap,
-- no count and no different error. Signatures, return shapes, ordering,
-- SECURITY DEFINER, search_path and grants are unchanged (CREATE OR REPLACE
-- keeps each ACL); nothing new is granted. Each body is otherwise the live
-- definition (20260810201500 and 20261003034000), guarded by its digest.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

do $predecessors$ begin
if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid = 'public.search_chapter_space_members(uuid,text,integer)'::regprocedure) is distinct from 'b11416d6f9b9ff1369fd2fd78f7dd472' then
  raise exception 'unreviewed search_chapter_space_members predecessor' using errcode = '55000';
end if;
if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid = 'public.list_channel_mention_candidates(uuid,text,integer)'::regprocedure) is distinct from '1624b3293a095a8f682d458e5436498d' then
  raise exception 'unreviewed list_channel_mention_candidates predecessor' using errcode = '55000';
end if;
end; $predecessors$;

create or replace function public.search_chapter_space_members(p_space_id uuid,p_query text,p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare space public.chapter_spaces := private.assert_space_manager(p_space_id); clean text:=btrim(coalesce(p_query,''));
begin
  if char_length(clean)<2 then raise exception 'query too short' using errcode='22023'; end if;
  return coalesce((select jsonb_agg(x.obj order by x.name) from (select p.full_name name,jsonb_build_object('userId',p.id,'fullName',p.full_name,'initials',p.initials) obj
    from public.member_profiles p where p.chapter_id=space.chapter_id and p.id<>space.created_by
      and p.full_name ilike '%'||clean||'%' and not exists(select 1 from public.chapter_space_members sm where sm.space_id=space.id and sm.user_id=p.id)
      and (p.id = (select auth.uid())
        or p.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))
    order by p.full_name limit least(greatest(coalesce(p_limit,20),1),50)) x),'[]'::jsonb);
end $$;

create or replace function public.list_channel_mention_candidates(p_space_id uuid, p_query text default null, p_limit integer default 8)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  space public.chapter_spaces%rowtype;
  org uuid;
  needle text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_query, '')));
  cap integer := least(greatest(coalesce(p_limit, 8), 1), 10);
  staff boolean;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(needle) > 60 then
    raise exception 'query too long' using errcode = '22023';
  end if;
  org := private.channel_settings_target(p_space_id);
  select s.* into space from public.chapter_spaces s where s.id = p_space_id;
  if not private.organization_feature_enabled(org, 'features.messaging.mentions') then
    return '[]'::jsonb;
  end if;
  needle := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(needle, '\', '\\'), '%', '\%'), '_', '\_');
  staff := public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']);
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', picked.id, 'name', picked.name, 'initials', picked.initials) order by picked.name, picked.id)
    from (
      select p.id, coalesce(nullif(pg_catalog.btrim(p.full_name), ''), 'Chapter member') as name,
        coalesce(nullif(pg_catalog.btrim(p.initials), ''), '·') as initials
      from public.member_profiles p
      where p.id <> caller
        and (
          (staff and exists (
            select 1 from public.member_chapter_memberships cm
            where cm.user_id = p.id and cm.chapter_id = space.chapter_id and cm.status = 'active')
            and (
              p.id in (select private.staff_visible_member_ids(readable_role)
                from pg_catalog.unnest(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) readable_role)
              or p.id = space.created_by
              or exists (
                select 1 from public.chapter_space_members sm
                where sm.space_id = space.id and sm.user_id = p.id)))
          or exists (
            select 1 from public.chapter_thread_posts post
            join public.chapter_threads thread on thread.id = post.thread_id
            where thread.space_id = space.id and post.author_id = p.id and post.deleted_at is null)
          or exists (
            select 1 from private.member_roster_stewards_for_chapter(space.chapter_id) roster
            where roster.steward_id = p.id)
        )
        and (needle = ''
          or pg_catalog.lower(coalesce(p.full_name, '')) like needle || '%' escape '\'
          or pg_catalog.lower(coalesce(p.full_name, '')) like '% ' || needle || '%' escape '\')
        and private.channel_member_can_read_space(p.id, space.id)
      order by pg_catalog.lower(coalesce(p.full_name, '')), p.id
      limit cap
    ) picked
  ), '[]'::jsonb);
end;
$function$;

commit;
