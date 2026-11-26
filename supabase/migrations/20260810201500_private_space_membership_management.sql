-- UB-HUB-05: staff-managed membership for private chapter spaces.

create or replace function private.assert_space_manager(p_space_id uuid)
returns public.chapter_spaces
language plpgsql security definer set search_path = '' stable as $$
declare caller uuid := (select auth.uid()); space public.chapter_spaces%rowtype;
begin
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'staff role required' using errcode='42501';
  end if;
  select s.* into space from public.chapter_spaces s
   where s.id=p_space_id and s.chapter_id=private.current_member_chapter() and s.archived_at is null;
  if space.id is null then raise exception 'space unavailable' using errcode='22023'; end if;
  return space;
end $$;

create or replace function public.list_chapter_space_members(p_space_id uuid)
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare space public.chapter_spaces := private.assert_space_manager(p_space_id);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('userId',p.id,'fullName',p.full_name,'initials',p.initials,'role',case when p.id=space.created_by then 'creator' else sm.role end) order by (p.id=space.created_by) desc,p.full_name)
    from public.member_profiles p left join public.chapter_space_members sm on sm.space_id=space.id and sm.user_id=p.id
    where p.id=space.created_by or sm.user_id is not null),'[]'::jsonb);
end $$;

create or replace function public.search_chapter_space_members(p_space_id uuid,p_query text,p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare space public.chapter_spaces := private.assert_space_manager(p_space_id); clean text:=btrim(coalesce(p_query,''));
begin
  if char_length(clean)<2 then raise exception 'query too short' using errcode='22023'; end if;
  return coalesce((select jsonb_agg(x.obj order by x.name) from (select p.full_name name,jsonb_build_object('userId',p.id,'fullName',p.full_name,'initials',p.initials) obj
    from public.member_profiles p where p.chapter_id=space.chapter_id and p.id<>space.created_by
      and p.full_name ilike '%'||clean||'%' and not exists(select 1 from public.chapter_space_members sm where sm.space_id=space.id and sm.user_id=p.id)
    order by p.full_name limit least(greatest(coalesce(p_limit,20),1),50)) x),'[]'::jsonb);
end $$;

create or replace function public.set_chapter_space_member(p_space_id uuid,p_user_id uuid,p_add boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare space public.chapter_spaces := private.assert_space_manager(p_space_id); changed integer;
begin
  if p_user_id=space.created_by and not p_add then raise exception 'space creator cannot be removed' using errcode='22023'; end if;
  if not exists(select 1 from public.member_profiles p where p.id=p_user_id and p.chapter_id=space.chapter_id) then raise exception 'member unavailable' using errcode='22023'; end if;
  if p_add then insert into public.chapter_space_members(space_id,user_id,role) values(space.id,p_user_id,'member') on conflict(space_id,user_id) do nothing;
  else delete from public.chapter_space_members sm where sm.space_id=space.id and sm.user_id=p_user_id; end if;
  get diagnostics changed=row_count;
  return jsonb_build_object('spaceId',space.id,'userId',p_user_id,'member',p_add,'changed',changed>0);
end $$;

revoke all on function private.assert_space_manager(uuid) from public,anon,authenticated;
revoke all on function public.list_chapter_space_members(uuid) from public,anon,authenticated;
revoke all on function public.search_chapter_space_members(uuid,text,integer) from public,anon,authenticated;
revoke all on function public.set_chapter_space_member(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.list_chapter_space_members(uuid) to authenticated;
grant execute on function public.search_chapter_space_members(uuid,text,integer) to authenticated;
grant execute on function public.set_chapter_space_member(uuid,uuid,boolean) to authenticated;
