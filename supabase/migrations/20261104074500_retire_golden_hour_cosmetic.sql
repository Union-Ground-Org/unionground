-- OPS-UG-GOLDEN-HOUR-COSMETIC-CATALOG-RETIRE-20261104
-- Union green is the only theme (project decision, Nov 3, 2026; decision file
-- 20261103-2010). The web (#6988) and native (#6987) apps no longer render the
-- Golden Hour theme cosmetic, so the server stops offering it.
--
-- Soft retire: existing awards reference the catalog row, and a member's award
-- history keeps showing them (FreeCosmetics renders an award whose item is no
-- longer listed as a retired item). The list RPC drops retired items from the
-- catalog it returns but keeps their awards in history; the grant and apply
-- RPCs refuse a retired key. A stored selection of a retired item is a display
-- preference nothing renders any more, so it is cleared.
--
-- Apply order: after 20261103183000_learning_period_tasks (newest on Main when
-- written) and after 20261104030000_learning_period_case_records (#7000). It
-- touches only the free cosmetic objects, so it commutes with both.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Lock order: take the shared case-graph gate before any catalog lock, the
-- order every cosmetic RPC uses (gate, then catalog). Otherwise the ALTER's
-- ACCESS EXCLUSIVE lock could be held while the DELETE's statement trigger
-- waits for a gate that a request holds while it waits for the catalog. The
-- trigger's own call below is then re-entrant.
select private.lock_case_graph(array[]::uuid[], array[]::uuid[]);

alter table private.free_cosmetic_catalog add column retired_at timestamptz;
update private.free_cosmetic_catalog set retired_at = now()
 where key = 'golden-hour' and retired_at is null;
delete from private.free_cosmetic_selections s
 using private.free_cosmetic_catalog c
 where c.key = s.item_key and c.retired_at is not null;

create or replace function public.get_free_cosmetics(p_organization_id uuid,p_search text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare org uuid; caller uuid := auth.uid(); can_grant boolean; result jsonb;
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  org := private.free_cosmetic_context();
  if org is distinct from p_organization_id then raise exception 'organization changed' using errcode='42501'; end if;
  can_grant := private.has_organization_role(org,array['admin']);
  select jsonb_build_object('organizationId',org,'canGrant',can_grant,
    'items',coalesce((select jsonb_agg(jsonb_build_object('key',c.key,'kind',c.kind,
      'labelEn',c.label_en,'labelEs',c.label_es,'earned',a.id is not null,
      'selected',s.item_key=c.key) order by c.kind,c.key)
      from private.free_cosmetic_catalog c
      left join private.free_cosmetic_awards a on a.item_key=c.key and a.organization_id=org and a.user_id=caller
      left join private.free_cosmetic_selections s on s.item_key=c.key and s.organization_id=org and s.user_id=caller
      where c.retired_at is null),'[]'::jsonb),
    'history',coalesce((select jsonb_agg(to_jsonb(h) order by h."createdAt" desc,h.id) from (
      select a.id,a.user_id as "userId",a.item_key as "itemKey",a.granted_by as "grantedBy",
        a.source,a.reason,a.created_at as "createdAt",p.full_name as "memberName"
      from private.free_cosmetic_awards a left join public.member_profiles p on p.id=a.user_id
      where a.organization_id=org and (a.user_id=caller or can_grant)
      order by a.created_at desc,a.id limit 100) h),'[]'::jsonb),
    'recipients',case when can_grant then coalesce((select jsonb_agg(to_jsonb(r) order by r.name,r.id) from (
      select m.user_id as id,coalesce(nullif(p.full_name,''),'Member') as name
      from public.organization_memberships m left join public.member_profiles p on p.id=m.user_id
      where m.organization_id=org and m.status='active' and m.revoked_at is null
        and (coalesce(p.full_name,'') ilike '%' || left(coalesce(p_search,''),100) || '%')
      order by name,m.user_id limit 100) r),'[]'::jsonb) else '[]'::jsonb end) into result;
  return result;
end;
$$;

create or replace function public.grant_free_cosmetic(p_organization_id uuid,p_user_id uuid,p_item_key text,p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare org uuid; award uuid; reason text := btrim(coalesce(p_reason,''));
begin
  perform private.lock_case_graph(array[auth.uid(),p_user_id],array[]::uuid[]);
  org := private.free_cosmetic_context();
  if org is distinct from p_organization_id then raise exception 'organization changed' using errcode='42501'; end if;
  if not private.has_organization_role(org,array['admin']) then
    raise exception 'not authorized' using errcode='42501';
  end if;
  if not exists(select 1 from public.organization_memberships m where m.organization_id=org
     and m.user_id=p_user_id and m.status='active' and m.revoked_at is null) then
    raise exception 'not authorized' using errcode='42501';
  end if;
  if char_length(reason) not between 1 and 500 or not exists(
    select 1 from private.free_cosmetic_catalog where key=p_item_key and retired_at is null) then
    raise exception 'invalid cosmetic or reason' using errcode='22023';
  end if;
  insert into private.free_cosmetic_awards(organization_id,user_id,item_key,granted_by,source,reason)
    values(org,p_user_id,p_item_key,auth.uid(),'admin',reason)
    on conflict(organization_id,user_id,item_key) do nothing returning id into award;
  if award is null then select id into award from private.free_cosmetic_awards
    where organization_id=org and user_id=p_user_id and item_key=p_item_key; end if;
  return award;
end;
$$;

create or replace function public.set_free_cosmetic(p_organization_id uuid,p_kind text,p_item_key text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare org uuid;
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  org := private.free_cosmetic_context();
  if org is distinct from p_organization_id then raise exception 'organization changed' using errcode='42501'; end if;
  if p_kind is null or p_kind not in ('theme','badge','icon') then
    raise exception 'invalid cosmetic kind' using errcode='22023';
  end if;
  if p_item_key is null then
    delete from private.free_cosmetic_selections where organization_id=org and user_id=auth.uid() and kind=p_kind;
    return;
  end if;
  if not exists(select 1 from private.free_cosmetic_awards a join private.free_cosmetic_catalog c on c.key=a.item_key
    where a.organization_id=org and a.user_id=auth.uid() and c.kind=p_kind and c.key=p_item_key
      and c.retired_at is null) then
    raise exception 'cosmetic not earned' using errcode='42501';
  end if;
  insert into private.free_cosmetic_selections(organization_id,user_id,kind,item_key)
    values(org,auth.uid(),p_kind,p_item_key)
    on conflict(organization_id,user_id,kind) do update set item_key=excluded.item_key,updated_at=now();
end;
$$;

revoke all on function public.get_free_cosmetics(uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.grant_free_cosmetic(uuid,uuid,text,text) from public,anon,authenticated,service_role;
revoke all on function public.set_free_cosmetic(uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.get_free_cosmetics(uuid,text) to authenticated;
grant execute on function public.grant_free_cosmetic(uuid,uuid,text,text) to authenticated;
grant execute on function public.set_free_cosmetic(uuid,text,text) to authenticated;
notify pgrst, 'reload schema';
commit;
