-- REQ-UG-NO-COST-REWARDS-THEMES-20261029
-- Cosmetics only: no points, money, dues, permissions, invented activity or backfill.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table private.free_cosmetic_catalog (
  key text primary key,
  kind text not null check (kind in ('theme','badge','icon')),
  label_en text not null,
  label_es text not null,
  unique (key,kind)
);
insert into private.free_cosmetic_catalog values
 ('golden-hour','theme','Golden Hour','Hora dorada'),
 ('learning-spark','badge','Learning Spark','Chispa de aprendizaje'),
 ('golden-mark','icon','Golden Mark','Emblema dorado');

create table private.free_cosmetic_awards (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  item_key text not null references private.free_cosmetic_catalog(key),
  granted_by uuid references auth.users(id) on delete set null,
  source text not null check (source in ('admin','rights_checklist')),
  reason text not null check (char_length(reason) between 1 and 500),
  event_key text,
  created_at timestamptz not null default now(),
  unique (organization_id,user_id,item_key)
);
create index free_cosmetic_awards_history on private.free_cosmetic_awards(organization_id,created_at desc,id);
create index free_cosmetic_awards_actor on private.free_cosmetic_awards(granted_by);
create index free_cosmetic_awards_user on private.free_cosmetic_awards(user_id);
create table private.free_cosmetic_selections (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  item_key text not null,
  updated_at timestamptz not null default now(),
  primary key(organization_id,user_id,kind),
  foreign key(item_key,kind) references private.free_cosmetic_catalog(key,kind),
  foreign key(organization_id,user_id,item_key)
    references private.free_cosmetic_awards(organization_id,user_id,item_key) on delete cascade
);
create index free_cosmetic_selections_user on private.free_cosmetic_selections(user_id);

-- RPC-only private storage. Every entry point revalidates the current tenant,
-- active membership and session assurance; no client table mutation grant.
alter table private.free_cosmetic_catalog enable row level security;
alter table private.free_cosmetic_awards enable row level security;
alter table private.free_cosmetic_selections enable row level security;
revoke all on private.free_cosmetic_catalog, private.free_cosmetic_awards,
  private.free_cosmetic_selections from public,anon,authenticated,service_role;

create function private.free_cosmetic_context()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare org uuid := private.current_mobile_staff_organization();
begin
  if auth.uid() is null or org is null or not private.mfa_satisfied()
     or not exists(select 1 from public.organization_memberships m
       where m.organization_id=org and m.user_id=auth.uid() and m.status='active' and m.revoked_at is null) then
    raise exception 'not authorized' using errcode='42501';
  end if;
  return org;
end;
$$;
revoke all on function private.free_cosmetic_context() from public,anon,authenticated,service_role;

create function public.get_free_cosmetics(p_organization_id uuid,p_search text default '')
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
      left join private.free_cosmetic_selections s on s.item_key=c.key and s.organization_id=org and s.user_id=caller),'[]'::jsonb),
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

create function public.grant_free_cosmetic(p_organization_id uuid,p_user_id uuid,p_item_key text,p_reason text)
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
    select 1 from private.free_cosmetic_catalog where key=p_item_key) then
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

create function public.set_free_cosmetic(p_organization_id uuid,p_kind text,p_item_key text default null)
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
    where a.organization_id=org and a.user_id=auth.uid() and c.kind=p_kind and c.key=p_item_key) then
    raise exception 'cosmetic not earned' using errcode='42501';
  end if;
  insert into private.free_cosmetic_selections(organization_id,user_id,kind,item_key)
    values(org,auth.uid(),p_kind,p_item_key)
    on conflict(organization_id,user_id,kind) do update set item_key=excluded.item_key,updated_at=now();
end;
$$;

-- The supported Know your rights checklist is the underlying event. Validate
-- actual step indices against the published built-in lesson, not a client
-- supplied completed flag/count. No historical progress is scanned or changed.
create function private.award_rights_checklist_cosmetic()
returns trigger language plpgsql security definer set search_path = '' as $$
declare org uuid; step_count integer;
begin
  perform private.lock_case_graph(array[auth.uid(),new.user_id],array[]::uuid[]);
  if auth.uid() is distinct from new.user_id or not private.mfa_satisfied() then return new; end if;
  select jsonb_array_length(l.steps) into step_count from public.member_rights_lessons l where l.id=new.lesson_id;
  if coalesce(step_count,0)=0 or cardinality(new.completed_steps)<>step_count
    or not (new.completed_steps @> array(select generate_series(0,step_count-1))) then return new; end if;
  if tg_op='UPDATE' and old.completed_steps @> array(select generate_series(0,step_count-1)) then return new; end if;
  org := private.free_cosmetic_context();
  insert into private.free_cosmetic_awards(organization_id,user_id,item_key,granted_by,source,reason,event_key)
    values(org,new.user_id,'learning-spark',new.user_id,'rights_checklist','rights_checklist_completed',new.lesson_id)
    on conflict(organization_id,user_id,item_key) do nothing;
  return new;
end;
$$;
create trigger free_cosmetic_rights_completion after insert or update of completed_steps on public.member_rights_progress
for each row execute function private.award_rights_checklist_cosmetic();
revoke all on function private.award_rights_checklist_cosmetic() from public,anon,authenticated,service_role;

create trigger a00_case_graph_lock before insert or update or delete on private.free_cosmetic_awards
for each statement execute function private.lock_case_graph_statement();
create or replace trigger z99_case_graph_keys before insert or update or delete on private.free_cosmetic_awards
for each row execute function private.lock_case_graph_row_keys('{granted_by},{user_id}', '');
create trigger a00_case_graph_lock before insert or update or delete on private.free_cosmetic_selections
for each statement execute function private.lock_case_graph_statement();
create or replace trigger z99_case_graph_keys before insert or update or delete on private.free_cosmetic_selections
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');

insert into private.account_lifecycle_manifest(schema_name,table_name,user_column,delete_disposition,export_disposition,export_inventory_basis,exclusion_reason,note) values
 ('private','free_cosmetic_awards','user_id','cascade','excluded_with_reason','auth_user_fk','Private organization reward administration; visible in the member reward history.','Removed with the recipient account.'),
 ('private','free_cosmetic_awards','granted_by','pseudonymize','excluded_with_reason','auth_user_fk','Organization award accountability, not content authored by the recipient.','Actor detached on account deletion.'),
 ('private','free_cosmetic_selections','user_id','cascade','excluded_with_reason','auth_user_fk','Cosmetic display preference, not authored member content.','Removed with the account.');

revoke all on function public.get_free_cosmetics(uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.grant_free_cosmetic(uuid,uuid,text,text) from public,anon,authenticated,service_role;
revoke all on function public.set_free_cosmetic(uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.get_free_cosmetics(uuid,text) to authenticated;
grant execute on function public.grant_free_cosmetic(uuid,uuid,text,text) to authenticated;
grant execute on function public.set_free_cosmetic(uuid,text,text) to authenticated;
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
 select kind,schema_name,table_name,object_name,definition_hash from private.account_lifecycle_trigger_surface()
 where (schema_name='private' and (table_name in ('free_cosmetic_awards','free_cosmetic_selections')
   or object_name in ('free_cosmetic_context()','award_rights_checklist_cosmetic()')))
   or (schema_name='public' and table_name='member_rights_progress' and object_name='free_cosmetic_rights_completion')
 on conflict(kind,schema_name,table_name,object_name) do update set definition_hash=excluded.definition_hash;
notify pgrst, 'reload schema';
commit;
