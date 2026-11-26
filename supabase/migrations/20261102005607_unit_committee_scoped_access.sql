-- REQ-UG-UNIT-AND-COMMITTEE-SCOPED-ACCESS-20261031 (#6665).
-- Complements 20261031103908_chapter_creator_membership without repeating it.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- The hosted runner applies under an empty search_path; replay the same way.
-- pg_catalog alone resolves names exactly as an empty path does (it is always searched first).
set local search_path = pg_catalog;

alter table public.member_admin_audit drop constraint member_admin_audit_action_check;
alter table public.member_admin_audit add constraint member_admin_audit_action_check check(action in (
  'grant_role','revoke_role','create_event','update_event','cancel_event','restore_event','delete_event','reset_mfa',
  'claim_reward','grant_reward','revoke_reward','fulfill_reward','set_staff_mfa_policy','set_compass_ai_enabled','set_compass_ai_role_limit','attest_compass_ai_provider',
  'create_campaign','update_campaign_draft','publish_campaign','close_campaign','recover_signin_address','recover_signin_address_failed','review_email_intake',
  'create_chapter','update_chapter','grant_chapter_membership','revoke_chapter_membership','event_checkin_lockout','set_chapter_display_title','self_service_password_reset',
  'committee_updated','access_membership_updated','access_policy_updated','role_capability_updated','role_scope_updated','grievance_identity_visibility_updated'
));

create table private.chapter_role_capabilities (
  role text not null,
  capability text not null,
  primary key (role, capability)
);
insert into private.chapter_role_capabilities values
  ('secretary','records'), ('secretary','documents'), ('secretary','notices'),
  ('records','records'), ('records','documents');

create table private.chapter_access_policies (
  chapter_id text primary key references public.chapters(id) on update cascade on delete cascade,
  steward_grievances boolean not null default true,
  steward_breadth text not null default 'chapter' check (steward_breadth in ('chapter','local'))
);

create table private.chapter_role_settings (
  chapter_id text not null references public.chapters(id) on update cascade on delete cascade,
  role text not null,
  capability text not null,
  enabled boolean not null,
  primary key (chapter_id, role, capability),
  foreign key (role, capability) references private.chapter_role_capabilities(role, capability) on delete cascade
);

create table private.chapter_committees (
  id uuid primary key default extensions.gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on update cascade on delete cascade,
  name text not null check (pg_catalog.char_length(pg_catalog.btrim(name)) between 1 and 120 and name !~ '[[:cntrl:]<>]'),
  purpose text not null check (pg_catalog.char_length(pg_catalog.btrim(purpose)) between 1 and 2000 and purpose !~ '[<>]'),
  starts_on date not null default current_date,
  ends_on date,
  grievance_access boolean not null default false,
  created_at timestamptz not null default pg_catalog.now(),
  unique (id, chapter_id),
  check (ends_on is null or ends_on >= starts_on)
);
create index chapter_committees_chapter_idx on private.chapter_committees(chapter_id);

alter table private.chapter_units add constraint chapter_units_id_chapter_key unique (id, chapter_id);
create table private.chapter_unit_members (
  unit_id uuid not null,
  chapter_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (unit_id, user_id),
  foreign key (unit_id, chapter_id) references private.chapter_units(id, chapter_id) on update cascade on delete cascade,
  foreign key (user_id, chapter_id) references public.member_chapter_memberships(user_id, chapter_id) on update cascade on delete cascade
);
create index chapter_unit_members_user_idx on private.chapter_unit_members(user_id, chapter_id);

create table private.chapter_committee_members (
  committee_id uuid not null,
  chapter_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (committee_id, user_id),
  foreign key (committee_id, chapter_id) references private.chapter_committees(id, chapter_id) on update cascade on delete cascade,
  foreign key (user_id, chapter_id) references public.member_chapter_memberships(user_id, chapter_id) on update cascade on delete cascade
);
create index chapter_committee_members_user_idx on private.chapter_committee_members(user_id, chapter_id);

create table private.chapter_role_scopes (
  user_id uuid not null references auth.users(id) on delete cascade,
  chapter_id text not null,
  role text not null check (role in ('steward','coordinator','advisor','secretary','records')),
  unit_id uuid,
  committee_id uuid,
  primary key (user_id, chapter_id, role),
  foreign key (user_id, role, chapter_id) references public.member_role_chapters(user_id, role, chapter_id) on update cascade on delete cascade,
  -- Deleting a container must never silently widen its grant to the chapter.
  foreign key (unit_id, chapter_id) references private.chapter_units(id, chapter_id) on update cascade on delete no action deferrable initially deferred,
  foreign key (committee_id, chapter_id) references private.chapter_committees(id, chapter_id) on update cascade on delete no action deferrable initially deferred,
  check ((unit_id is not null)::integer + (committee_id is not null)::integer = 1)
);
create index chapter_role_scopes_unit_idx on private.chapter_role_scopes(unit_id);
create index chapter_role_scopes_committee_idx on private.chapter_role_scopes(committee_id);

create table private.member_draft_steward_shares (
  form_id uuid not null references public.member_forms(id) on delete cascade,
  steward_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete cascade,
  primary key (form_id, steward_id)
);
create index member_draft_steward_shares_steward_idx on private.member_draft_steward_shares(steward_id);

-- RPC-only storage: no direct table grants, including service-role grants.
alter table private.chapter_role_capabilities enable row level security;
alter table private.chapter_role_capabilities force row level security;
revoke all on table private.chapter_role_capabilities from public,anon,authenticated,service_role;
create policy mfa_assurance on private.chapter_role_capabilities as restrictive for all to authenticated using(private.mfa_satisfied()) with check(private.mfa_satisfied());
-- Immutable capability catalogue: runtime clients hold no table privileges.
-- It has no Auth/case FK path and is not a case-graph relation.

alter table private.chapter_access_policies enable row level security;
alter table private.chapter_access_policies force row level security;
revoke all on table private.chapter_access_policies from public,anon,authenticated,service_role;
create policy mfa_assurance on private.chapter_access_policies as restrictive for all to authenticated using(private.mfa_satisfied()) with check(private.mfa_satisfied());
create trigger a00_case_graph_lock before insert or update or delete on private.chapter_access_policies
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.chapter_access_policies
for each row execute function private.lock_case_graph_row_keys('', '');

alter table private.chapter_role_settings enable row level security;
alter table private.chapter_role_settings force row level security;
revoke all on table private.chapter_role_settings from public,anon,authenticated,service_role;
create policy mfa_assurance on private.chapter_role_settings as restrictive for all to authenticated using(private.mfa_satisfied()) with check(private.mfa_satisfied());
create trigger a00_case_graph_lock before insert or update or delete on private.chapter_role_settings
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.chapter_role_settings
for each row execute function private.lock_case_graph_row_keys('', '');

alter table private.chapter_committees enable row level security;
alter table private.chapter_committees force row level security;
revoke all on table private.chapter_committees from public,anon,authenticated,service_role;
create policy mfa_assurance on private.chapter_committees as restrictive for all to authenticated using(private.mfa_satisfied()) with check(private.mfa_satisfied());
create trigger a00_case_graph_lock before insert or update or delete on private.chapter_committees
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.chapter_committees
for each row execute function private.lock_case_graph_row_keys('', '');

alter table private.chapter_unit_members enable row level security;
alter table private.chapter_unit_members force row level security;
revoke all on table private.chapter_unit_members from public,anon,authenticated,service_role;
create policy mfa_assurance on private.chapter_unit_members as restrictive for all to authenticated using(private.mfa_satisfied()) with check(private.mfa_satisfied());
create trigger a00_case_graph_lock before insert or update or delete on private.chapter_unit_members
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.chapter_unit_members
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');

alter table private.chapter_committee_members enable row level security;
alter table private.chapter_committee_members force row level security;
revoke all on table private.chapter_committee_members from public,anon,authenticated,service_role;
create policy mfa_assurance on private.chapter_committee_members as restrictive for all to authenticated using(private.mfa_satisfied()) with check(private.mfa_satisfied());
create trigger a00_case_graph_lock before insert or update or delete on private.chapter_committee_members
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.chapter_committee_members
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');

alter table private.chapter_role_scopes enable row level security;
alter table private.chapter_role_scopes force row level security;
revoke all on table private.chapter_role_scopes from public,anon,authenticated,service_role;
create policy mfa_assurance on private.chapter_role_scopes as restrictive for all to authenticated using(private.mfa_satisfied()) with check(private.mfa_satisfied());
create trigger a00_case_graph_lock before insert or update or delete on private.chapter_role_scopes
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.chapter_role_scopes
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');

alter table private.member_draft_steward_shares enable row level security;
alter table private.member_draft_steward_shares force row level security;
revoke all on table private.member_draft_steward_shares from public,anon,authenticated,service_role;
create policy mfa_assurance on private.member_draft_steward_shares as restrictive for all to authenticated using(private.mfa_satisfied()) with check(private.mfa_satisfied());
create trigger a00_case_graph_lock before insert or update or delete on private.member_draft_steward_shares
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.member_draft_steward_shares
for each row execute function private.lock_case_graph_row_keys('{steward_id}', '');


create function private.chapter_access_leadership(p_chapter text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select (select auth.uid()) is not null and private.mfa_satisfied() and not private.member_pin_session_restricted()
    and exists (select 1 from public.chapters c where c.id=p_chapter
      and c.organization_id=private.current_member_organization()
      and (private.has_organization_role(c.organization_id,array['admin'])
        or private.member_has_chapter_role(c.id,array['admin','vp'])));
$function$;
revoke all on function private.chapter_access_leadership(text) from public, anon, authenticated, service_role;

-- A scoped grant is never a chapter-wide grant. This helper deliberately
-- reads the grant table, not member_has_chapter_role, so it can be used by
-- target-aware readers after that older chapter-wide predicate is narrowed.
create function private.chapter_scoped_role_allows(p_chapter text, p_role text, p_target uuid, p_grievance boolean default false)
returns boolean language sql stable security definer set search_path = '' as $function$
  select (select auth.uid()) is not null and private.mfa_satisfied() and not private.member_pin_session_restricted()
    and exists (
      select 1 from private.chapter_role_scopes s
      join public.chapters c on c.id=s.chapter_id and c.organization_id=private.current_member_organization()
      join public.member_profiles target_profile on target_profile.id=p_target
      join public.chapters target_context on target_context.id=target_profile.chapter_id and target_context.organization_id=c.organization_id
      join public.member_chapter_memberships actor on actor.user_id=s.user_id and actor.chapter_id=s.chapter_id and actor.status='active'
      join public.member_chapter_memberships target on target.user_id=p_target and target.chapter_id=s.chapter_id and target.status='active'
      join public.organization_memberships ao on ao.user_id=s.user_id and ao.organization_id=c.organization_id and ao.status='active'
      join public.organization_memberships mo on mo.user_id=p_target and mo.organization_id=c.organization_id and mo.status='active'
      where s.user_id=(select auth.uid()) and s.chapter_id=p_chapter and s.role=p_role
        and (not private.staff_mfa_required(c.organization_id) or private.has_second_factor((select auth.uid())))
        and (
          (s.unit_id is not null and exists (select 1 from private.chapter_unit_members u where u.unit_id=s.unit_id and u.chapter_id=s.chapter_id and u.user_id=p_target))
          or (s.committee_id is not null and exists (
            select 1 from private.chapter_committees cm
            join private.chapter_committee_members member on member.committee_id=cm.id and member.chapter_id=cm.chapter_id
            where cm.id=s.committee_id and cm.chapter_id=s.chapter_id and member.user_id=p_target
              and cm.starts_on<=current_date and (cm.ends_on is null or cm.ends_on>=current_date)
              and (not p_grievance or cm.grievance_access)
          ))
        )
    );
$function$;
revoke all on function private.chapter_scoped_role_allows(text,text,uuid,boolean) from public, anon, authenticated, service_role;

-- Start from the explicitly scoped containers rather than checking every
-- profile in a large tenant. The scalar helper remains the authorization
-- oracle, so scalar and set-wise callers enforce the same membership rules.
create function private.chapter_scoped_member_ids(p_role text)
returns setof uuid language sql stable security definer set search_path = '' as $function$
  select distinct candidate.user_id
  from private.chapter_role_scopes scope
  cross join lateral (
    select m.user_id from private.chapter_unit_members m
      where m.unit_id=scope.unit_id and m.chapter_id=scope.chapter_id
    union
    select m.user_id from private.chapter_committee_members m
      where m.committee_id=scope.committee_id and m.chapter_id=scope.chapter_id
  ) candidate
  where scope.user_id=(select auth.uid()) and scope.role=p_role
    and private.chapter_scoped_role_allows(scope.chapter_id,p_role,candidate.user_id,false);
$function$;
revoke all on function private.chapter_scoped_member_ids(text) from public, anon, authenticated, service_role;

create function private.chapter_officer_can(p_chapter text, p_capability text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select (select auth.uid()) is not null and private.mfa_satisfied() and not private.member_pin_session_restricted()
    and exists (select 1 from public.chapters c
      where c.id=p_chapter and c.organization_id=private.current_member_organization()
        and exists(select 1 from public.member_chapter_memberships m where m.user_id=(select auth.uid()) and m.chapter_id=c.id and m.status='active')
        and exists(select 1 from public.organization_memberships m where m.user_id=(select auth.uid()) and m.organization_id=c.organization_id and m.status='active')
        and (not private.staff_mfa_required(c.organization_id) or private.has_second_factor((select auth.uid())))
        and (private.has_organization_role(c.organization_id,array['admin'])
          or private.member_has_chapter_role(c.id,array['admin','vp'])
          or exists(select 1 from private.chapter_role_capabilities cap
            join public.member_role_chapters r on r.role=cap.role and r.chapter_id=c.id and r.user_id=(select auth.uid())
            left join private.chapter_role_settings setting on setting.chapter_id=c.id and setting.role=cap.role and setting.capability=cap.capability
            where cap.capability=p_capability and coalesce(setting.enabled,true)
              and not exists(select 1 from private.chapter_role_scopes s where s.user_id=r.user_id and s.chapter_id=r.chapter_id and s.role=r.role))));
$function$;
revoke all on function private.chapter_officer_can(text,text) from public, anon, authenticated, service_role;

create function public.save_chapter_committee(p_id uuid, p_chapter text, p_name text, p_purpose text, p_starts_on date, p_ends_on date, p_grievance_access boolean)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
declare result private.chapter_committees%rowtype;
begin
  if not private.mfa_satisfied() or not private.chapter_access_leadership(p_chapter) then raise exception 'chapter leadership required' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:'||private.current_member_organization()::text,509));
  if not private.mfa_satisfied() or not private.chapter_access_leadership(p_chapter) then raise exception 'chapter leadership required' using errcode='42501'; end if;
  if p_id is null then
    insert into private.chapter_committees(chapter_id,name,purpose,starts_on,ends_on,grievance_access)
    values(p_chapter,pg_catalog.btrim(p_name),pg_catalog.btrim(p_purpose),p_starts_on,p_ends_on,coalesce(p_grievance_access,false)) returning * into result;
  else
    update private.chapter_committees set name=pg_catalog.btrim(p_name),purpose=pg_catalog.btrim(p_purpose),starts_on=p_starts_on,ends_on=p_ends_on,grievance_access=coalesce(p_grievance_access,false)
    where id=p_id and chapter_id=p_chapter returning * into result;
    if not found then raise exception 'committee not found' using errcode='P0002'; end if;
  end if;
  insert into public.member_admin_audit(actor,action,detail) values(auth.uid(),'committee_updated',pg_catalog.jsonb_build_object('committeeId',result.id,'chapterId',p_chapter));
  return pg_catalog.to_jsonb(result);
end;
end;
$function$;
revoke all on function public.save_chapter_committee(uuid,text,text,text,date,date,boolean) from public, anon, authenticated, service_role;
grant execute on function public.save_chapter_committee(uuid,text,text,text,date,date,boolean) to authenticated;

create function public.set_chapter_access_member(p_chapter text, p_user uuid, p_unit uuid, p_committee uuid, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid(),p_user],array[]::uuid[]);
begin
  if not private.mfa_satisfied() or not private.chapter_access_leadership(p_chapter) then raise exception 'chapter leadership required' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:'||private.current_member_organization()::text,509));
  if not private.mfa_satisfied() or not private.chapter_access_leadership(p_chapter) then raise exception 'chapter leadership required' using errcode='42501'; end if;
  if (p_unit is null)=(p_committee is null) or not exists(select 1 from public.member_chapter_memberships m
    join public.organization_memberships om on om.user_id=m.user_id and om.organization_id=private.current_member_organization() and om.status='active'
    where m.user_id=p_user and m.chapter_id=p_chapter and m.status='active') then
    raise exception 'active chapter member and one scope required' using errcode='22023';
  end if;
  if p_unit is not null then
    if not exists(select 1 from private.chapter_units where id=p_unit and chapter_id=p_chapter) then raise exception 'unit outside chapter' using errcode='42501'; end if;
    if coalesce(p_enabled,false) then
      insert into private.chapter_unit_members(unit_id,chapter_id,user_id) values(p_unit,p_chapter,p_user) on conflict do nothing;
    else delete from private.chapter_unit_members where unit_id=p_unit and chapter_id=p_chapter and user_id=p_user; end if;
  else
    if not exists(select 1 from private.chapter_committees where id=p_committee and chapter_id=p_chapter) then raise exception 'committee outside chapter' using errcode='42501'; end if;
    if coalesce(p_enabled,false) then
      insert into private.chapter_committee_members(committee_id,chapter_id,user_id) values(p_committee,p_chapter,p_user) on conflict do nothing;
    else delete from private.chapter_committee_members where committee_id=p_committee and chapter_id=p_chapter and user_id=p_user; end if;
  end if;
  insert into public.member_admin_audit(actor,action,target_user,detail) values(auth.uid(),'access_membership_updated',p_user,
    pg_catalog.jsonb_build_object('chapterId',p_chapter,'unitId',p_unit,'committeeId',p_committee,'enabled',coalesce(p_enabled,false)));
  return pg_catalog.jsonb_build_object('updated',true);
end;
end;
$function$;
revoke all on function public.set_chapter_access_member(text,uuid,uuid,uuid,boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_chapter_access_member(text,uuid,uuid,uuid,boolean) to authenticated;

create function public.set_chapter_access_policy(p_chapter text, p_steward_grievances boolean, p_steward_breadth text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
begin
  if not private.mfa_satisfied() or not private.chapter_access_leadership(p_chapter) then raise exception 'chapter leadership required' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:'||private.current_member_organization()::text,509));
  if not private.mfa_satisfied() or not private.chapter_access_leadership(p_chapter) then raise exception 'chapter leadership required' using errcode='42501'; end if;
  insert into private.chapter_access_policies(chapter_id,steward_grievances,steward_breadth) values(p_chapter,p_steward_grievances,p_steward_breadth)
  on conflict(chapter_id) do update set steward_grievances=excluded.steward_grievances,steward_breadth=excluded.steward_breadth;
  insert into public.member_admin_audit(actor,action,detail) values(auth.uid(),'access_policy_updated',pg_catalog.jsonb_build_object('chapterId',p_chapter,'stewardGrievances',p_steward_grievances,'stewardBreadth',p_steward_breadth));
  return pg_catalog.jsonb_build_object('updated',true);
end;
end;
$function$;
revoke all on function public.set_chapter_access_policy(text,boolean,text) from public, anon, authenticated, service_role;
grant execute on function public.set_chapter_access_policy(text,boolean,text) to authenticated;

create function public.set_chapter_role_capability(p_chapter text, p_role text, p_capability text, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
begin
  if not private.mfa_satisfied() or not private.chapter_access_leadership(p_chapter) then raise exception 'chapter leadership required' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:'||private.current_member_organization()::text,509));
  if not private.mfa_satisfied() or not private.chapter_access_leadership(p_chapter) then raise exception 'chapter leadership required' using errcode='42501'; end if;
  insert into private.chapter_role_settings(chapter_id,role,capability,enabled) values(p_chapter,p_role,p_capability,p_enabled)
  on conflict(chapter_id,role,capability) do update set enabled=excluded.enabled;
  insert into public.member_admin_audit(actor,action,detail) values(auth.uid(),'role_capability_updated',pg_catalog.jsonb_build_object('chapterId',p_chapter,'role',p_role,'capability',p_capability,'enabled',p_enabled));
  return pg_catalog.jsonb_build_object('updated',true);
end;
end;
$function$;
revoke all on function public.set_chapter_role_capability(text,text,text,boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_chapter_role_capability(text,text,text,boolean) to authenticated;

create function public.set_member_access_role(p_user uuid, p_chapter text, p_role text, p_enabled boolean, p_unit uuid default null, p_committee uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid(),p_user],array[]::uuid[]);
begin
  if not private.mfa_satisfied() or not private.chapter_access_leadership(p_chapter) then raise exception 'chapter leadership required' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:'||private.current_member_organization()::text,509));
  if not private.mfa_satisfied() or not private.chapter_access_leadership(p_chapter) then raise exception 'chapter leadership required' using errcode='42501'; end if;
  if p_unit is not null and p_committee is not null then raise exception 'choose one role scope' using errcode='22023'; end if;
  if (p_unit is not null or p_committee is not null) and p_role not in ('steward','coordinator','advisor','secretary','records') then raise exception 'role does not support that scope' using errcode='22023'; end if;
  if p_unit is not null and not exists(select 1 from private.chapter_units where id=p_unit and chapter_id=p_chapter) then raise exception 'unit outside chapter' using errcode='42501'; end if;
  if p_committee is not null and not exists(select 1 from private.chapter_committees where id=p_committee and chapter_id=p_chapter) then raise exception 'committee outside chapter' using errcode='42501'; end if;
  perform public.set_member_chapter_role(p_user,p_chapter,p_role,p_enabled);
  if coalesce(p_enabled,false) and (p_unit is not null or p_committee is not null) then
    insert into private.chapter_role_scopes(user_id,chapter_id,role,unit_id,committee_id)
    values(p_user,p_chapter,p_role,p_unit,p_committee)
    on conflict(user_id,chapter_id,role) do update set unit_id=excluded.unit_id,committee_id=excluded.committee_id;
  else
    delete from private.chapter_role_scopes where user_id=p_user and chapter_id=p_chapter and role=p_role;
  end if;
  insert into public.member_admin_audit(actor,action,target_user,detail) values(auth.uid(),'role_scope_updated',p_user,
    pg_catalog.jsonb_build_object('chapterId',p_chapter,'role',p_role,'unitId',p_unit,'committeeId',p_committee,'enabled',coalesce(p_enabled,false)));
  return pg_catalog.jsonb_build_object('updated',true);
end;
end;
$function$;
revoke all on function public.set_member_access_role(uuid,text,text,boolean,uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.set_member_access_role(uuid,text,text,boolean,uuid,uuid) to authenticated;


do $predecessors$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.account_lifecycle_export_additional_domains(uuid)'::regprocedure)) <> '7b31f5c38b3f1c5f18364c122b5842a4' then raise exception 'unreviewed predecessor: private.account_lifecycle_export_additional_domains' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='account_lifecycle_export_additional_domains(p_caller uuid)' and definition_hash<>'e96bd948c2450e5b77f4ef72971b8538') then raise exception 'stale trigger receipt: private.account_lifecycle_export_additional_domains' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.account_lifecycle_retained_case_scope_allows(text,text,text)'::regprocedure)) <> '51fbc2ae3b2e1da5a1326702a1bf8de6' then raise exception 'unreviewed predecessor: private.account_lifecycle_retained_case_scope_allows' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='account_lifecycle_retained_case_scope_allows(p_kind text, p_record_id text, p_chapter_id text)' and definition_hash<>'51fbc2ae3b2e1da5a1326702a1bf8de6') then raise exception 'stale trigger receipt: private.account_lifecycle_retained_case_scope_allows' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.actor_has_chapter_staff_role(uuid,text)'::regprocedure)) <> 'ed0b9613c428626340cc995378b13fcc' then raise exception 'unreviewed predecessor: private.actor_has_chapter_staff_role' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='actor_has_chapter_staff_role(p_actor uuid, p_chapter text)' and definition_hash<>'ed0b9613c428626340cc995378b13fcc') then raise exception 'stale trigger receipt: private.actor_has_chapter_staff_role' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.apply_member_invitation_unit()'::regprocedure)) <> '22e5897af39c320a7c35774fdd056746' then raise exception 'unreviewed predecessor: private.apply_member_invitation_unit' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='apply_member_invitation_unit()' and definition_hash<>'22e5897af39c320a7c35774fdd056746') then raise exception 'stale trigger receipt: private.apply_member_invitation_unit' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.automation_v2_case_visible(uuid,uuid,uuid)'::regprocedure)) <> '6159991d7c723802ae149f7b56829a59' then raise exception 'unreviewed predecessor: private.automation_v2_case_visible' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='automation_v2_case_visible(p_actor uuid, p_org uuid, p_case uuid)' and definition_hash<>'6159991d7c723802ae149f7b56829a59') then raise exception 'stale trigger receipt: private.automation_v2_case_visible' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.can_read_member_broadcast(text)'::regprocedure)) <> 'a6fee0672d48697c91ae227bd008fb9f' then raise exception 'unreviewed predecessor: private.can_read_member_broadcast' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='can_read_member_broadcast(p_broadcast_id text)' and definition_hash<>'a6fee0672d48697c91ae227bd008fb9f') then raise exception 'stale trigger receipt: private.can_read_member_broadcast' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.can_read_member_case_object(text,text)'::regprocedure)) <> 'a88ac8bf8f19a76965796d44adf904cd' then raise exception 'unreviewed predecessor: private.can_read_member_case_object' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='can_read_member_case_object(p_bucket text, p_name text)' and definition_hash<>'a88ac8bf8f19a76965796d44adf904cd') then raise exception 'stale trigger receipt: private.can_read_member_case_object' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.can_read_member_form_object(text,text)'::regprocedure)) <> '9a003114ce58330dfde82a4d1170b51f' then raise exception 'unreviewed predecessor: private.can_read_member_form_object' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='can_read_member_form_object(p_bucket text, p_name text)' and definition_hash<>'9a003114ce58330dfde82a4d1170b51f') then raise exception 'stale trigger receipt: private.can_read_member_form_object' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.casework_actor_has_active_grant(uuid)'::regprocedure)) <> 'bc54b72a8024fe5516a927cf3db0db39' then raise exception 'unreviewed predecessor: private.casework_actor_has_active_grant' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='casework_actor_has_active_grant(p_case_id uuid)' and definition_hash<>'bc54b72a8024fe5516a927cf3db0db39') then raise exception 'stale trigger receipt: private.casework_actor_has_active_grant' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.casework_can_read(uuid)'::regprocedure)) <> '3f16c20bbb7fb64e1bf92af056dd9249' then raise exception 'unreviewed predecessor: private.casework_can_read' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='casework_can_read(p_case_id uuid)' and definition_hash<>'3f16c20bbb7fb64e1bf92af056dd9249') then raise exception 'stale trigger receipt: private.casework_can_read' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.casework_dashboard_open_cases()'::regprocedure)) <> 'bebfef5f45f668bf157901eb5c17d10f' then raise exception 'unreviewed predecessor: private.casework_dashboard_open_cases' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='casework_dashboard_open_cases()' and definition_hash<>'bebfef5f45f668bf157901eb5c17d10f') then raise exception 'stale trigger receipt: private.casework_dashboard_open_cases' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.casework_reminder_owner_can_read(uuid,uuid)'::regprocedure)) <> '816c323a2181c4eef2fc2fd4d8b68748' then raise exception 'unreviewed predecessor: private.casework_reminder_owner_can_read' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='casework_reminder_owner_can_read(p_owner uuid, p_case_id uuid)' and definition_hash<>'816c323a2181c4eef2fc2fd4d8b68748') then raise exception 'stale trigger receipt: private.casework_reminder_owner_can_read' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.casework_staff_can_access(uuid)'::regprocedure)) <> '56528952191b6f5f2b73cfb7312086f4' then raise exception 'unreviewed predecessor: private.casework_staff_can_access' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='casework_staff_can_access(p_case_id uuid)' and definition_hash<>'56528952191b6f5f2b73cfb7312086f4') then raise exception 'stale trigger receipt: private.casework_staff_can_access' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.dispatch_minutes_pre_event_notices(integer)'::regprocedure)) <> '7923120aee4f3424632012f16732d7a0' then raise exception 'unreviewed predecessor: private.dispatch_minutes_pre_event_notices' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='dispatch_minutes_pre_event_notices(p_limit integer)' and definition_hash<>'7923120aee4f3424632012f16732d7a0') then raise exception 'stale trigger receipt: private.dispatch_minutes_pre_event_notices' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.engagement_delivery_recipient_eligible(uuid,uuid,text,text)'::regprocedure)) <> '69ddbb8a8ea0b0aa215a28ac2ec6fd63' then raise exception 'unreviewed predecessor: private.engagement_delivery_recipient_eligible' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='engagement_delivery_recipient_eligible(p_organization_id uuid, p_recipient_user_id uuid, p_source_kind text, p_source_id text)' and definition_hash<>'69ddbb8a8ea0b0aa215a28ac2ec6fd63') then raise exception 'stale trigger receipt: private.engagement_delivery_recipient_eligible' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.institutional_context(boolean)'::regprocedure)) <> 'ca0d94634f2e0c08dcecc423d3c213be' then raise exception 'unreviewed predecessor: private.institutional_context' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='institutional_context(p_require_staff boolean)' and definition_hash<>'ca0d94634f2e0c08dcecc423d3c213be') then raise exception 'stale trigger receipt: private.institutional_context' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.member_case_row_visible(public.member_cases)'::regprocedure)) <> 'e07a48576c586967d9eca33d4f4cfc0a' then raise exception 'unreviewed predecessor: private.member_case_row_visible' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='member_case_row_visible(p_case member_cases)' and definition_hash<>'288136448c97620c1591a897c9548e71') then raise exception 'stale trigger receipt: private.member_case_row_visible' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.member_has_chapter_role(text,text[])'::regprocedure)) <> 'e917789913d479c474688f837846d81b' then raise exception 'unreviewed predecessor: private.member_has_chapter_role' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='member_has_chapter_role(p_chapter_id text, p_roles text[])' and definition_hash<>'e917789913d479c474688f837846d81b') then raise exception 'stale trigger receipt: private.member_has_chapter_role' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.member_notice_in_audience(uuid,uuid,text,text)'::regprocedure)) <> '5a5a1624d1c6ad35a46b69087e091b2a' then raise exception 'unreviewed predecessor: private.member_notice_in_audience' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='member_notice_in_audience(p_user_id uuid, p_organization_id uuid, p_chapter_id text, p_audience_scope text)' and definition_hash<>'5a5a1624d1c6ad35a46b69087e091b2a') then raise exception 'stale trigger receipt: private.member_notice_in_audience' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.member_notice_read_count(text)'::regprocedure)) <> 'fda19dba392453d213a649f4333b0738' then raise exception 'unreviewed predecessor: private.member_notice_read_count' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='member_notice_read_count(p_broadcast_id text)' and definition_hash<>'fda19dba392453d213a649f4333b0738') then raise exception 'stale trigger receipt: private.member_notice_read_count' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.queue_member_broadcast_delivery()'::regprocedure)) <> '85bd1a5e6e89972a6673b7a334f3db64' then raise exception 'unreviewed predecessor: private.queue_member_broadcast_delivery' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='queue_member_broadcast_delivery()' and definition_hash<>'85bd1a5e6e89972a6673b7a334f3db64') then raise exception 'stale trigger receipt: private.queue_member_broadcast_delivery' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.staff_visible_member_ids(text)'::regprocedure)) <> 'a58dec796fa56a91c6c2bd4f54f39c30' then raise exception 'unreviewed predecessor: private.staff_visible_member_ids' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='staff_visible_member_ids(p_role text)' and definition_hash<>'a58dec796fa56a91c6c2bd4f54f39c30') then raise exception 'stale trigger receipt: private.staff_visible_member_ids' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.visible_member_broadcast_ids()'::regprocedure)) <> '9499b778bf019bef833cd54cd80aae43' then raise exception 'unreviewed predecessor: private.visible_member_broadcast_ids' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and object_name='visible_member_broadcast_ids()' and definition_hash<>'9499b778bf019bef833cd54cd80aae43') then raise exception 'stale trigger receipt: private.visible_member_broadcast_ids' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.approve_form(uuid,text)'::regprocedure)) <> '071137394ebbac4937a3c763d5a30270' then raise exception 'unreviewed predecessor: public.approve_form' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='approve_form(p_form_id uuid, p_note text)' and definition_hash<>'071137394ebbac4937a3c763d5a30270') then raise exception 'stale trigger receipt: public.approve_form' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.assign_member_case(uuid,uuid,uuid)'::regprocedure)) <> 'b147317999433372a2a16819d30bf043' then raise exception 'unreviewed predecessor: public.assign_member_case' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='assign_member_case(p_case_id uuid, p_steward uuid, p_coordinator uuid)' and definition_hash<>'b147317999433372a2a16819d30bf043') then raise exception 'stale trigger receipt: public.assign_member_case' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.attach_minutes_to_meeting(uuid,text)'::regprocedure)) <> '019bf5e8980be05054aa448e426a7cd1' then raise exception 'unreviewed predecessor: public.attach_minutes_to_meeting' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='attach_minutes_to_meeting(p_record_id uuid, p_event_id text)' and definition_hash<>'019bf5e8980be05054aa448e426a7cd1') then raise exception 'stale trigger receipt: public.attach_minutes_to_meeting' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.can_access_form_filing(uuid)'::regprocedure)) <> '6b01131c31df8d4b123622a0636aaba3' then raise exception 'unreviewed predecessor: public.can_access_form_filing' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='can_access_form_filing(p_form_id uuid)' and definition_hash<>'6b01131c31df8d4b123622a0636aaba3') then raise exception 'stale trigger receipt: public.can_access_form_filing' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.casework_case_history(uuid,integer,timestamp with time zone)'::regprocedure)) <> '241bdbbef2b92a1ef38c96573a76bb27' then raise exception 'unreviewed predecessor: public.casework_case_history' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='casework_case_history(p_case_id uuid, p_limit integer, p_before timestamp with time zone)' and definition_hash<>'241bdbbef2b92a1ef38c96573a76bb27') then raise exception 'stale trigger receipt: public.casework_case_history' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.casework_dashboard_median_days_per_step()'::regprocedure)) <> '81263816b85d00dfbc46de6437f1a5c3' then raise exception 'unreviewed predecessor: public.casework_dashboard_median_days_per_step' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='casework_dashboard_median_days_per_step()' and definition_hash<>'81263816b85d00dfbc46de6437f1a5c3') then raise exception 'stale trigger receipt: public.casework_dashboard_median_days_per_step' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.casework_list_case_retaliation_flags(uuid)'::regprocedure)) <> 'ee6f53bec2fb3351b9b82391f4d33626' then raise exception 'unreviewed predecessor: public.casework_list_case_retaliation_flags' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='casework_list_case_retaliation_flags(p_case_id uuid)' and definition_hash<>'ee6f53bec2fb3351b9b82391f4d33626') then raise exception 'stale trigger receipt: public.casework_list_case_retaliation_flags' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.casework_list_ulp_deadlines(integer)'::regprocedure)) <> '3791a7b7ed663d84fbccc50b10748b18' then raise exception 'unreviewed predecessor: public.casework_list_ulp_deadlines' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='casework_list_ulp_deadlines(p_limit integer)' and definition_hash<>'3791a7b7ed663d84fbccc50b10748b18') then raise exception 'stale trigger receipt: public.casework_list_ulp_deadlines' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.casework_suggest_case_strength(uuid,text)'::regprocedure)) <> '77bf8e506c02853ca97572e58d91ec72' then raise exception 'unreviewed predecessor: public.casework_suggest_case_strength' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='casework_suggest_case_strength(p_case_id uuid, p_evidence_type text)' and definition_hash<>'77bf8e506c02853ca97572e58d91ec72') then raise exception 'stale trigger receipt: public.casework_suggest_case_strength' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.clear_minutes_pre_event_notice(uuid)'::regprocedure)) <> 'eaa666fe6b558b68fd1268d1ed33e875' then raise exception 'unreviewed predecessor: public.clear_minutes_pre_event_notice' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='clear_minutes_pre_event_notice(p_record_id uuid)' and definition_hash<>'eaa666fe6b558b68fd1268d1ed33e875') then raise exception 'stale trigger receipt: public.clear_minutes_pre_event_notice' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.convert_member_intake_report(uuid,text,uuid)'::regprocedure)) <> '1cd2910a5e45cfaba23bf614656a95ba' then raise exception 'unreviewed predecessor: public.convert_member_intake_report' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='convert_member_intake_report(p_report_id uuid, p_target text, p_space_id uuid)' and definition_hash<>'1cd2910a5e45cfaba23bf614656a95ba') then raise exception 'stale trigger receipt: public.convert_member_intake_report' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.create_member_contact_note(uuid,text,uuid)'::regprocedure)) <> 'f01ee115c7ce32ef8c1fb65e324ad841' then raise exception 'unreviewed predecessor: public.create_member_contact_note' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='create_member_contact_note(p_conversation_id uuid, p_note text, p_source_message_id uuid)' and definition_hash<>'f01ee115c7ce32ef8c1fb65e324ad841') then raise exception 'stale trigger receipt: public.create_member_contact_note' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.create_member_invitation(text,text,text,text,text,text)'::regprocedure)) <> '54ee62b3b8301e1c56f4f18de818599e' then raise exception 'unreviewed predecessor: public.create_member_invitation' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='create_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_initial_role text, p_locale text, p_token_hash text)' and definition_hash<>'59a62570bf7c44e5e36f9cc4d9a962ee') then raise exception 'stale trigger receipt: public.create_member_invitation' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.form_owner_in_steward_scope(uuid)'::regprocedure)) <> '53d4d8e9d2a0a2bd5dcbaff82ec750d9' then raise exception 'unreviewed predecessor: public.form_owner_in_steward_scope' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='form_owner_in_steward_scope(p_form_id uuid)' and definition_hash<>'53d4d8e9d2a0a2bd5dcbaff82ec750d9') then raise exception 'stale trigger receipt: public.form_owner_in_steward_scope' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_advisor_overview()'::regprocedure)) <> 'c9730f18a33b974be531befd21309de0' then raise exception 'unreviewed predecessor: public.get_advisor_overview' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_advisor_overview()' and definition_hash<>'c9730f18a33b974be531befd21309de0') then raise exception 'stale trigger receipt: public.get_advisor_overview' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_broadcast_read_counts()'::regprocedure)) <> 'fd0beb17fedb237c537899fc81966e10' then raise exception 'unreviewed predecessor: public.get_broadcast_read_counts' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_broadcast_read_counts()' and definition_hash<>'fd0beb17fedb237c537899fc81966e10') then raise exception 'stale trigger receipt: public.get_broadcast_read_counts' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_broadcast_read_counts_for(text[])'::regprocedure)) <> '02afd4c66c7d85cb1ee9ef4adc0ead4c' then raise exception 'unreviewed predecessor: public.get_broadcast_read_counts_for' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_broadcast_read_counts_for(p_broadcast_ids text[])' and definition_hash<>'02afd4c66c7d85cb1ee9ef4adc0ead4c') then raise exception 'stale trigger receipt: public.get_broadcast_read_counts_for' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_case_queue_next_actions(text,integer)'::regprocedure)) <> 'b162d989b3f15b266f609887bef6e284' then raise exception 'unreviewed predecessor: public.get_case_queue_next_actions' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_case_queue_next_actions(p_selected_hat text, p_limit integer)' and definition_hash<>'b162d989b3f15b266f609887bef6e284') then raise exception 'stale trigger receipt: public.get_case_queue_next_actions' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_compass_staff_data_context(text[])'::regprocedure)) <> 'cec6506ab28557279325b8124040c899' then raise exception 'unreviewed predecessor: public.get_compass_staff_data_context' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_compass_staff_data_context(p_topics text[])' and definition_hash<>'cec6506ab28557279325b8124040c899') then raise exception 'stale trigger receipt: public.get_compass_staff_data_context' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_coordinator_kpis()'::regprocedure)) <> '724e6a3eecaaf80c97f75f4c3e3c0ab7' then raise exception 'unreviewed predecessor: public.get_coordinator_kpis' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_coordinator_kpis()' and definition_hash<>'724e6a3eecaaf80c97f75f4c3e3c0ab7') then raise exception 'stale trigger receipt: public.get_coordinator_kpis' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_engagement_delivery_payload(uuid,uuid)'::regprocedure)) <> 'b3488d1979157d700e0bb78994c5e656' then raise exception 'unreviewed predecessor: public.get_engagement_delivery_payload' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_engagement_delivery_payload(p_delivery_id uuid, p_lease_token uuid)' and definition_hash<>'b3488d1979157d700e0bb78994c5e656') then raise exception 'stale trigger receipt: public.get_engagement_delivery_payload' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_form_filing_payload(uuid,uuid)'::regprocedure)) <> '123a6a17b3bff1e3491a6245ff08d0ba' then raise exception 'unreviewed predecessor: public.get_form_filing_payload' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_form_filing_payload(p_form_id uuid, p_user_id uuid)' and definition_hash<>'123a6a17b3bff1e3491a6245ff08d0ba') then raise exception 'stale trigger receipt: public.get_form_filing_payload' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_form_filing_status(uuid)'::regprocedure)) <> 'ac9313d7bc8e0e91d649a3d07f7b8d01' then raise exception 'unreviewed predecessor: public.get_form_filing_status' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_form_filing_status(p_form_id uuid)' and definition_hash<>'ac9313d7bc8e0e91d649a3d07f7b8d01') then raise exception 'stale trigger receipt: public.get_form_filing_status' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_institutional_records_workspace()'::regprocedure)) <> '35ff987088d9e52990716fbc3d5f838e' then raise exception 'unreviewed predecessor: public.get_institutional_records_workspace' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_institutional_records_workspace()' and definition_hash<>'35ff987088d9e52990716fbc3d5f838e') then raise exception 'stale trigger receipt: public.get_institutional_records_workspace' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_member_notice_receipts(text)'::regprocedure)) <> '1e257d3e97058bec20726475d94009bc' then raise exception 'unreviewed predecessor: public.get_member_notice_receipts' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_member_notice_receipts(p_broadcast_id text)' and definition_hash<>'1e257d3e97058bec20726475d94009bc') then raise exception 'stale trigger receipt: public.get_member_notice_receipts' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_minutes_meeting_checkins(uuid)'::regprocedure)) <> '2eb17e873de185cf4fd3ff5da337b869' then raise exception 'unreviewed predecessor: public.get_minutes_meeting_checkins' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_minutes_meeting_checkins(p_record_id uuid)' and definition_hash<>'2eb17e873de185cf4fd3ff5da337b869') then raise exception 'stale trigger receipt: public.get_minutes_meeting_checkins' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_minutes_pre_event_notices()'::regprocedure)) <> '1b87ecc562d7b3ddfee287582ceffa1d' then raise exception 'unreviewed predecessor: public.get_minutes_pre_event_notices' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_minutes_pre_event_notices()' and definition_hash<>'1b87ecc562d7b3ddfee287582ceffa1d') then raise exception 'stale trigger receipt: public.get_minutes_pre_event_notices' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_organization_analytics_snapshot()'::regprocedure)) <> '0174de77a51e3c1a4ccac7eff1bd5b1c' then raise exception 'unreviewed predecessor: public.get_organization_analytics_snapshot' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_organization_analytics_snapshot()' and definition_hash<>'af861e2ebdf3935ad14ba172d13b384c') then raise exception 'stale trigger receipt: public.get_organization_analytics_snapshot' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_organization_analytics_workspace()'::regprocedure)) <> '6b351b22265a94e418352632a4ce8736' then raise exception 'unreviewed predecessor: public.get_organization_analytics_workspace' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_organization_analytics_workspace()' and definition_hash<>'6b351b22265a94e418352632a4ce8736') then raise exception 'stale trigger receipt: public.get_organization_analytics_workspace' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_organization_derived_graph(text)'::regprocedure)) <> '9d949687c1eb3c5e043b43fb8ddb3962' then raise exception 'unreviewed predecessor: public.get_organization_derived_graph' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_organization_derived_graph(p_selected_hat text)' and definition_hash<>'9d949687c1eb3c5e043b43fb8ddb3962') then raise exception 'stale trigger receipt: public.get_organization_derived_graph' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_staff_engagement_snapshot()'::regprocedure)) <> '78f6432871751e4107cc1c6e8894f8d9' then raise exception 'unreviewed predecessor: public.get_staff_engagement_snapshot' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_staff_engagement_snapshot()' and definition_hash<>'78f6432871751e4107cc1c6e8894f8d9') then raise exception 'stale trigger receipt: public.get_staff_engagement_snapshot' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_staff_roster()'::regprocedure)) <> '30d101df2fc331faa6477b5173868612' then raise exception 'unreviewed predecessor: public.get_staff_roster' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_staff_roster()' and definition_hash<>'30d101df2fc331faa6477b5173868612') then raise exception 'stale trigger receipt: public.get_staff_roster' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_steward_badge_counts()'::regprocedure)) <> 'e0dd162696e60e151438d0d94ea8b020' then raise exception 'unreviewed predecessor: public.get_steward_badge_counts' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_steward_badge_counts()' and definition_hash<>'e0dd162696e60e151438d0d94ea8b020') then raise exception 'stale trigger receipt: public.get_steward_badge_counts' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_steward_chapter_member_count()'::regprocedure)) <> '38d7bb127664b495da3102987aaa1eb4' then raise exception 'unreviewed predecessor: public.get_steward_chapter_member_count' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_steward_chapter_member_count()' and definition_hash<>'38d7bb127664b495da3102987aaa1eb4') then raise exception 'stale trigger receipt: public.get_steward_chapter_member_count' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_vp_overview()'::regprocedure)) <> 'e4ae8c368553a7d998cd8ad0d5d18139' then raise exception 'unreviewed predecessor: public.get_vp_overview' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_vp_overview()' and definition_hash<>'e4ae8c368553a7d998cd8ad0d5d18139') then raise exception 'stale trigger receipt: public.get_vp_overview' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.list_announcement_drafts()'::regprocedure)) <> 'aedb486615530e64bcf29f190fc72bb2' then raise exception 'unreviewed predecessor: public.list_announcement_drafts' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='list_announcement_drafts()' and definition_hash<>'aedb486615530e64bcf29f190fc72bb2') then raise exception 'stale trigger receipt: public.list_announcement_drafts' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.list_case_note_mention_candidates(uuid)'::regprocedure)) <> 'd2eed1d37e69f9871be96ded8ef053c6' then raise exception 'unreviewed predecessor: public.list_case_note_mention_candidates' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='list_case_note_mention_candidates(p_case_id uuid)' and definition_hash<>'d2eed1d37e69f9871be96ded8ef053c6') then raise exception 'stale trigger receipt: public.list_case_note_mention_candidates' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.list_casework_audit_events(integer,timestamp with time zone,bigint,text,timestamp with time zone,timestamp with time zone,uuid)'::regprocedure)) <> 'ee7fc4dd57be25771193316016489829' then raise exception 'unreviewed predecessor: public.list_casework_audit_events' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='list_casework_audit_events(p_limit integer, p_before timestamp with time zone, p_before_id bigint, p_kind text, p_since timestamp with time zone, p_until timestamp with time zone, p_case_id uuid)' and definition_hash<>'ee7fc4dd57be25771193316016489829') then raise exception 'stale trigger receipt: public.list_casework_audit_events' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.list_contract_clause_grievance_counts()'::regprocedure)) <> '24055ccab38a8d53a236ed356dbbaab1' then raise exception 'unreviewed predecessor: public.list_contract_clause_grievance_counts' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='list_contract_clause_grievance_counts()' and definition_hash<>'24055ccab38a8d53a236ed356dbbaab1') then raise exception 'stale trigger receipt: public.list_contract_clause_grievance_counts' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.list_coordinator_case_audit(integer,timestamp with time zone,bigint,text,timestamp with time zone,timestamp with time zone,uuid)'::regprocedure)) <> 'f5f10199a5075026222db9cdfa7d7287' then raise exception 'unreviewed predecessor: public.list_coordinator_case_audit' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='list_coordinator_case_audit(p_limit integer, p_before timestamp with time zone, p_before_id bigint, p_kind text, p_since timestamp with time zone, p_until timestamp with time zone, p_case_id uuid)' and definition_hash<>'f5f10199a5075026222db9cdfa7d7287') then raise exception 'stale trigger receipt: public.list_coordinator_case_audit' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.list_intake_triage_owners()'::regprocedure)) <> '1cf77a8e6611b597ac5b7c15112639fd' then raise exception 'unreviewed predecessor: public.list_intake_triage_owners' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='list_intake_triage_owners()' and definition_hash<>'1cf77a8e6611b597ac5b7c15112639fd') then raise exception 'stale trigger receipt: public.list_intake_triage_owners' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.list_member_case_assignment_audit(integer,timestamp with time zone,bigint,text,timestamp with time zone,timestamp with time zone,uuid)'::regprocedure)) <> 'f59ce1d3a2e4b9b5a04d1d375f5fcf8c' then raise exception 'unreviewed predecessor: public.list_member_case_assignment_audit' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='list_member_case_assignment_audit(p_limit integer, p_before timestamp with time zone, p_before_id bigint, p_kind text, p_since timestamp with time zone, p_until timestamp with time zone, p_case_id uuid)' and definition_hash<>'f59ce1d3a2e4b9b5a04d1d375f5fcf8c') then raise exception 'stale trigger receipt: public.list_member_case_assignment_audit' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.list_member_case_assignment_candidates(uuid)'::regprocedure)) <> '89d74c964f1cebced75ba7fc18e0a423' then raise exception 'unreviewed predecessor: public.list_member_case_assignment_candidates' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='list_member_case_assignment_candidates(p_case_id uuid)' and definition_hash<>'89d74c964f1cebced75ba7fc18e0a423') then raise exception 'stale trigger receipt: public.list_member_case_assignment_candidates' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.list_my_member_notices(integer,timestamp with time zone,text)'::regprocedure)) <> '48cc7076b4e6969dde3cd0dcfa78e386' then raise exception 'unreviewed predecessor: public.list_my_member_notices' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='list_my_member_notices(p_limit integer, p_before_published timestamp with time zone, p_before_id text)' and definition_hash<>'48cc7076b4e6969dde3cd0dcfa78e386') then raise exception 'stale trigger receipt: public.list_my_member_notices' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.list_share_case_destinations(integer)'::regprocedure)) <> 'ee32ebfb18eafcc576af2d868b7476f7' then raise exception 'unreviewed predecessor: public.list_share_case_destinations' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='list_share_case_destinations(p_limit integer)' and definition_hash<>'ee32ebfb18eafcc576af2d868b7476f7') then raise exception 'stale trigger receipt: public.list_share_case_destinations' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.list_vp_case_reviews()'::regprocedure)) <> 'ee08e95a5e91a8e70d3300850e0cbf16' then raise exception 'unreviewed predecessor: public.list_vp_case_reviews' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='list_vp_case_reviews()' and definition_hash<>'ee08e95a5e91a8e70d3300850e0cbf16') then raise exception 'stale trigger receipt: public.list_vp_case_reviews' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.open_form_as_case(uuid)'::regprocedure)) <> '4ccef9bee56ea3196454e9c130315f9a' then raise exception 'unreviewed predecessor: public.open_form_as_case' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='open_form_as_case(p_form_id uuid)' and definition_hash<>'4ccef9bee56ea3196454e9c130315f9a') then raise exception 'stale trigger receipt: public.open_form_as_case' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.publish_member_broadcast(text,text,text,text)'::regprocedure)) <> 'c43440c9848a2339c43441039ff45fdb' then raise exception 'unreviewed predecessor: public.publish_member_broadcast' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='publish_member_broadcast(p_title text, p_body text, p_locale text, p_audience_scope text)' and definition_hash<>'c43440c9848a2339c43441039ff45fdb') then raise exception 'stale trigger receipt: public.publish_member_broadcast' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.resolve_announcement_draft(uuid,text)'::regprocedure)) <> 'c35719ab4c997f87fb6bfbdc0ab3d8c6' then raise exception 'unreviewed predecessor: public.resolve_announcement_draft' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='resolve_announcement_draft(p_draft_id uuid, p_state text)' and definition_hash<>'c35719ab4c997f87fb6bfbdc0ab3d8c6') then raise exception 'stale trigger receipt: public.resolve_announcement_draft' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.retract_member_broadcast(text)'::regprocedure)) <> '8bfb31d6a9702f9c3970ce6fa614c34c' then raise exception 'unreviewed predecessor: public.retract_member_broadcast' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='retract_member_broadcast(p_broadcast_id text)' and definition_hash<>'8bfb31d6a9702f9c3970ce6fa614c34c') then raise exception 'stale trigger receipt: public.retract_member_broadcast' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.return_form(uuid,text)'::regprocedure)) <> '1adb0cdd34c1b232525e8d28080eba61' then raise exception 'unreviewed predecessor: public.return_form' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='return_form(p_form_id uuid, p_note text)' and definition_hash<>'1adb0cdd34c1b232525e8d28080eba61') then raise exception 'stale trigger receipt: public.return_form' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.save_chapter_contact_log(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,uuid,uuid,uuid,boolean)'::regprocedure)) <> '297c6b30e5c46dc98b665b5dae1ae0e7' then raise exception 'unreviewed predecessor: public.save_chapter_contact_log' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='save_chapter_contact_log(p_contact_id uuid, p_contact_kind text, p_channel text, p_purpose text, p_summary text, p_outcome text, p_occurred_at timestamp with time zone, p_follow_up_at timestamp with time zone, p_subject_user_id uuid, p_case_id uuid, p_task_id uuid, p_archive boolean)' and definition_hash<>'297c6b30e5c46dc98b665b5dae1ae0e7') then raise exception 'stale trigger receipt: public.save_chapter_contact_log' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.save_institutional_record(uuid,text,text,text,timestamp with time zone,text,text,boolean,text,integer,jsonb)'::regprocedure)) <> 'e8dd10d274430e9638937e541eaf9789' then raise exception 'unreviewed predecessor: public.save_institutional_record' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='save_institutional_record(p_record_id uuid, p_record_type text, p_title text, p_body text, p_occurred_at timestamp with time zone, p_visibility text, p_action text, p_pinned boolean, p_gap_note text, p_expected_version integer, p_attendance jsonb)' and definition_hash<>'e8dd10d274430e9638937e541eaf9789') then raise exception 'stale trigger receipt: public.save_institutional_record' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.save_minutes_pre_event_notice(uuid,text,text,integer)'::regprocedure)) <> 'a646b2c3c03c1ce15c7b452d2a97f558' then raise exception 'unreviewed predecessor: public.save_minutes_pre_event_notice' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='save_minutes_pre_event_notice(p_record_id uuid, p_event_id text, p_audience text, p_hours_before integer)' and definition_hash<>'a646b2c3c03c1ce15c7b452d2a97f558') then raise exception 'stale trigger receipt: public.save_minutes_pre_event_notice' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.search_member_cases(text,integer)'::regprocedure)) <> '74d54d46fe31423f97982aa53a93de01' then raise exception 'unreviewed predecessor: public.search_member_cases' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='search_member_cases(p_query text, p_limit integer)' and definition_hash<>'74d54d46fe31423f97982aa53a93de01') then raise exception 'stale trigger receipt: public.search_member_cases' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.set_chapter_minutes_approval(uuid,integer,boolean)'::regprocedure)) <> '3a49253a8babad620303a92a64685d96' then raise exception 'unreviewed predecessor: public.set_chapter_minutes_approval' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='set_chapter_minutes_approval(p_record_id uuid, p_expected_version integer, p_approved boolean)' and definition_hash<>'3a49253a8babad620303a92a64685d96') then raise exception 'stale trigger receipt: public.set_chapter_minutes_approval' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.set_member_chapter_role(uuid,text,text,boolean)'::regprocedure)) <> '12062637fdfaaa0fbcb70680018b2001' then raise exception 'unreviewed predecessor: public.set_member_chapter_role' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='set_member_chapter_role(p_user_id uuid, p_chapter_id text, p_role text, p_enabled boolean)' and definition_hash<>'98c87d6d4d576e4374cedce43e59de0c') then raise exception 'stale trigger receipt: public.set_member_chapter_role' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.staff_can_see_user(uuid,text)'::regprocedure)) <> '3b2d156f7a96145af243ef4074a37f5c' then raise exception 'unreviewed predecessor: public.staff_can_see_user' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='staff_can_see_user(p_target uuid, p_role text)' and definition_hash<>'3b2d156f7a96145af243ef4074a37f5c') then raise exception 'stale trigger receipt: public.staff_can_see_user' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.steward_start_review(uuid)'::regprocedure)) <> 'a452b0f20237d3deb56b5bc515e46cc5' then raise exception 'unreviewed predecessor: public.steward_start_review' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='steward_start_review(p_form_id uuid)' and definition_hash<>'a452b0f20237d3deb56b5bc515e46cc5') then raise exception 'stale trigger receipt: public.steward_start_review' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.update_chapter_document_content(uuid,text,text,text,text,text,text)'::regprocedure)) <> '5367207d2eca02ebb28051632e09c9cc' then raise exception 'unreviewed predecessor: public.update_chapter_document_content' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='update_chapter_document_content(p_id uuid, p_title text, p_document_type text, p_summary text, p_body text, p_visibility text, p_action text)' and definition_hash<>'5367207d2eca02ebb28051632e09c9cc') then raise exception 'stale trigger receipt: public.update_chapter_document_content' using errcode='55000'; end if;
end;
$predecessors$;

-- Scope follows the record itself, including its versions and attachments.
alter table public.chapter_records
  add column access_unit_id uuid,
  add column access_committee_id uuid,
  add constraint chapter_records_access_unit_fk foreign key(access_unit_id,chapter_id) references private.chapter_units(id,chapter_id) on update cascade on delete no action deferrable initially deferred,
  add constraint chapter_records_access_committee_fk foreign key(access_committee_id,chapter_id) references private.chapter_committees(id,chapter_id) on update cascade on delete no action deferrable initially deferred,
  add constraint chapter_records_one_access_scope check(access_unit_id is null or access_committee_id is null);
alter table public.chapter_documents
  add column access_unit_id uuid,
  add column access_committee_id uuid,
  add constraint chapter_documents_access_unit_fk foreign key(access_unit_id,chapter_id) references private.chapter_units(id,chapter_id) on update cascade on delete no action deferrable initially deferred,
  add constraint chapter_documents_access_committee_fk foreign key(access_committee_id,chapter_id) references private.chapter_committees(id,chapter_id) on update cascade on delete no action deferrable initially deferred,
  add constraint chapter_documents_one_access_scope check(access_unit_id is null or access_committee_id is null);
create index chapter_records_access_unit_idx on public.chapter_records(access_unit_id);
create index chapter_records_access_committee_idx on public.chapter_records(access_committee_id);
create index chapter_documents_access_unit_idx on public.chapter_documents(access_unit_id);
create index chapter_documents_access_committee_idx on public.chapter_documents(access_committee_id);

insert into private.chapter_role_capabilities(role,capability) values
  ('steward','records'),('steward','documents'),('coordinator','records'),('coordinator','documents'),('advisor','records'),('advisor','documents');

create function private.chapter_office_role_present(p_chapter text,p_capability text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select private.chapter_officer_can(p_chapter,p_capability) or (
    (select auth.uid()) is not null and private.mfa_satisfied() and not private.member_pin_session_restricted()
    and exists(select 1 from public.chapters c
      join public.member_chapter_memberships m on m.chapter_id=c.id and m.user_id=(select auth.uid()) and m.status='active'
      join public.organization_memberships om on om.organization_id=c.organization_id and om.user_id=m.user_id and om.status='active'
      join public.member_role_chapters r on r.user_id=m.user_id and r.chapter_id=m.chapter_id
      join private.chapter_role_scopes scope on scope.user_id=r.user_id and scope.chapter_id=r.chapter_id and scope.role=r.role
      left join private.chapter_committees committee on committee.id=scope.committee_id and committee.chapter_id=scope.chapter_id
      join private.chapter_role_capabilities cap on cap.role=r.role and cap.capability=p_capability
      left join private.chapter_role_settings setting on setting.chapter_id=c.id and setting.role=r.role and setting.capability=cap.capability
      where c.id=p_chapter and c.organization_id=private.current_member_organization()
        and coalesce(setting.enabled,true)
        and (scope.unit_id is not null or (committee.starts_on<=current_date and (committee.ends_on is null or committee.ends_on>=current_date)))
        and (not private.staff_mfa_required(c.organization_id) or private.has_second_factor((select auth.uid())))));
$function$;
revoke all on function private.chapter_office_role_present(text,text) from public,anon,authenticated,service_role;

create function private.chapter_officer_can_for_scope(p_chapter text,p_capability text,p_unit uuid,p_committee uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select private.chapter_officer_can(p_chapter,p_capability) or (
    private.chapter_office_role_present(p_chapter,p_capability)
    and exists(select 1 from private.chapter_role_scopes scope
      join private.chapter_role_capabilities cap on cap.role=scope.role and cap.capability=p_capability
      left join private.chapter_role_settings setting on setting.chapter_id=scope.chapter_id and setting.role=cap.role and setting.capability=cap.capability
      where scope.user_id=(select auth.uid()) and scope.chapter_id=p_chapter and coalesce(setting.enabled,true)
        and ((p_unit is not null and p_committee is null and scope.unit_id=p_unit)
          or (p_committee is not null and p_unit is null and scope.committee_id=p_committee and exists(
            select 1 from private.chapter_committees c where c.id=p_committee and c.chapter_id=p_chapter
              and c.starts_on<=current_date and (c.ends_on is null or c.ends_on>=current_date))))));
$function$;
revoke all on function private.chapter_officer_can_for_scope(text,text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.chapter_officer_can_for_scope(text,text,uuid,uuid) to authenticated;

create function private.chapter_record_manageable(p_chapter text,p_unit uuid,p_committee uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select private.member_has_chapter_role(p_chapter,array['steward','coordinator','advisor','admin','vp'])
    or private.chapter_officer_can_for_scope(p_chapter,'records',p_unit,p_committee);
$function$;
revoke all on function private.chapter_record_manageable(text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.chapter_record_manageable(text,uuid,uuid) to authenticated;

-- Background dispatch has no selected-member session. Revalidate the named
-- recipient against the record's actual chapter and current container.
create function private.chapter_scope_recipient_allowed(p_chapter text,p_unit uuid,p_committee uuid,p_member uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists(select 1 from public.member_chapter_memberships member
    join public.chapters c on c.id=member.chapter_id
    join public.organizations o on o.id=c.organization_id and o.status='active'
    join public.organization_memberships om on om.organization_id=c.organization_id and om.user_id=member.user_id and om.status='active'
    where member.user_id=p_member and member.chapter_id=p_chapter and member.status='active' and (
      (p_unit is null and p_committee is null)
      or exists(select 1 from private.chapter_unit_members m where m.unit_id=p_unit and m.chapter_id=p_chapter and m.user_id=p_member)
      or exists(select 1 from private.chapter_committees committee
        join private.chapter_committee_members m on m.committee_id=committee.id and m.chapter_id=committee.chapter_id
        where committee.id=p_committee and committee.chapter_id=p_chapter and m.user_id=p_member
          and committee.starts_on<=current_date and (committee.ends_on is null or committee.ends_on>=current_date))));
$function$;
revoke all on function private.chapter_scope_recipient_allowed(text,uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function private.chapter_scope_member_allowed(p_chapter text,p_unit uuid,p_committee uuid,p_member uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists(select 1 from public.member_chapter_memberships member
    join public.chapters c on c.id=member.chapter_id and c.organization_id=private.current_member_organization()
    join public.organization_memberships om on om.organization_id=c.organization_id and om.user_id=member.user_id and om.status='active'
    where member.user_id=p_member and member.chapter_id=p_chapter and member.status='active' and (
      (p_unit is null and p_committee is null)
      or exists(select 1 from private.chapter_unit_members m where m.unit_id=p_unit and m.chapter_id=p_chapter and m.user_id=p_member)
      or exists(select 1 from private.chapter_committees committee
        join private.chapter_committee_members m on m.committee_id=committee.id and m.chapter_id=committee.chapter_id
        where committee.id=p_committee and committee.chapter_id=p_chapter and m.user_id=p_member
          and committee.starts_on<=current_date and (committee.ends_on is null or committee.ends_on>=current_date))));
$function$;
revoke all on function private.chapter_scope_member_allowed(text,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.chapter_scope_member_allowed(text,uuid,uuid,uuid) to authenticated;

create policy chapter_records_container_scope on public.chapter_records as restrictive for select to authenticated using(
  (access_unit_id is null and access_committee_id is null)
  or private.chapter_record_manageable(chapter_id,access_unit_id,access_committee_id)
  or private.chapter_scope_member_allowed(chapter_id,access_unit_id,access_committee_id,(select auth.uid())));
create policy chapter_documents_container_scope on public.chapter_documents as restrictive for select to authenticated using(
  (access_unit_id is null and access_committee_id is null)
  or private.member_has_chapter_role(chapter_id,array['steward','coordinator','advisor','admin','vp'])
  or private.chapter_officer_can_for_scope(chapter_id,'documents',access_unit_id,access_committee_id)
  or private.chapter_scope_member_allowed(chapter_id,access_unit_id,access_committee_id,(select auth.uid())));

create function public.get_chapter_office_access()
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare chapter text:=private.current_member_chapter();
begin
  if chapter is null or not private.mfa_satisfied() or private.member_pin_session_restricted() then raise exception 'chapter context required' using errcode='42501'; end if;
  return pg_catalog.jsonb_build_object('chapterId',chapter,
    'records',private.chapter_office_role_present(chapter,'records'),
    'documents',private.chapter_office_role_present(chapter,'documents'),
    'notices',private.chapter_office_role_present(chapter,'notices'),
    'unscopedNotices',private.chapter_officer_can(chapter,'notices'),
    'unscopedRecords',private.chapter_officer_can(chapter,'records'),
    'unscopedDocuments',private.chapter_officer_can(chapter,'documents'),
    'scopes',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('role',s.role,'unitId',s.unit_id,'committeeId',s.committee_id,'name',coalesce(u.name,c.name),
      'records',exists(select 1 from private.chapter_role_capabilities cap where cap.role=s.role and cap.capability='records' and not exists(select 1 from private.chapter_role_settings setting where setting.chapter_id=chapter and setting.role=s.role and setting.capability='records' and not setting.enabled)),
      'notices',exists(select 1 from private.chapter_role_capabilities cap where cap.role=s.role and cap.capability='notices' and not exists(select 1 from private.chapter_role_settings setting where setting.chapter_id=chapter and setting.role=s.role and setting.capability='notices' and not setting.enabled)),
      'documents',exists(select 1 from private.chapter_role_capabilities cap where cap.role=s.role and cap.capability='documents' and not exists(select 1 from private.chapter_role_settings setting where setting.chapter_id=chapter and setting.role=s.role and setting.capability='documents' and not setting.enabled))))
      from private.chapter_role_scopes s left join private.chapter_units u on u.id=s.unit_id left join private.chapter_committees c on c.id=s.committee_id
      where s.user_id=(select auth.uid()) and s.chapter_id=chapter
        and (s.committee_id is null or (c.starts_on<=current_date and (c.ends_on is null or c.ends_on>=current_date)))),'[]'::jsonb));
end;
$function$;
revoke all on function public.get_chapter_office_access() from public,anon,authenticated,service_role;
grant execute on function public.get_chapter_office_access() to authenticated;

-- Notice audiences follow the same durable unit/committee identities as
-- records and documents. Existing chapter and organization notices stay broad.
alter table public.member_broadcasts
  add column access_unit_id uuid,
  add column access_committee_id uuid,
  add constraint member_broadcasts_access_unit_fk foreign key(access_unit_id,chapter_id) references private.chapter_units(id,chapter_id) on update cascade on delete no action deferrable initially deferred,
  add constraint member_broadcasts_access_committee_fk foreign key(access_committee_id,chapter_id) references private.chapter_committees(id,chapter_id) on update cascade on delete no action deferrable initially deferred,
  add constraint member_broadcasts_one_access_scope check(access_unit_id is null or access_committee_id is null),
  add constraint member_broadcasts_scoped_chapter check((access_unit_id is null and access_committee_id is null) or audience_scope='chapter');
create index member_broadcasts_access_unit_idx on public.member_broadcasts(access_unit_id);
create index member_broadcasts_access_committee_idx on public.member_broadcasts(access_committee_id);
insert into private.chapter_role_capabilities(role,capability) values('steward','notices');

create function private.member_scoped_notice_in_audience(p_user uuid,p_notice public.member_broadcasts)
returns boolean language sql stable security definer set search_path = '' as $function$
  select private.member_notice_in_audience(p_user,p_notice.organization_id,p_notice.chapter_id,p_notice.audience_scope)
    and ((p_notice.access_unit_id is null and p_notice.access_committee_id is null)
      or exists(select 1 from private.chapter_unit_members m where m.unit_id=p_notice.access_unit_id and m.chapter_id=p_notice.chapter_id and m.user_id=p_user)
      or exists(select 1 from private.chapter_committees c join private.chapter_committee_members m on m.committee_id=c.id and m.chapter_id=c.chapter_id
        where c.id=p_notice.access_committee_id and c.chapter_id=p_notice.chapter_id and m.user_id=p_user and c.starts_on<=current_date and (c.ends_on is null or c.ends_on>=current_date)));
$function$;
revoke all on function private.member_scoped_notice_in_audience(uuid,public.member_broadcasts) from public,anon,authenticated,service_role;

create function private.member_scoped_notice_audience_count(p_broadcast text)
returns bigint language sql stable security definer set search_path = '' as $function$
  select pg_catalog.count(*) from public.member_broadcasts b
    join public.organization_memberships m on m.organization_id=b.organization_id and m.status='active'
    where b.id=p_broadcast and private.member_scoped_notice_in_audience(m.user_id,b);
$function$;
revoke all on function private.member_scoped_notice_audience_count(text) from public,anon,authenticated,service_role;

create policy chapter_notice_container_scope on public.member_broadcasts as restrictive for select to authenticated
  using((access_unit_id is null and access_committee_id is null)
    or private.chapter_scope_member_allowed(chapter_id,access_unit_id,access_committee_id,(select auth.uid())));

CREATE OR REPLACE FUNCTION private.can_read_member_broadcast(p_broadcast_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case
    when (select auth.uid()) is null or p_broadcast_id is null then false
    when not (select private.mfa_satisfied()) then false
    else exists (
      select 1
      from public.member_broadcasts b
      where b.id = p_broadcast_id
        and private.member_scoped_notice_in_audience((select auth.uid()),b)
        and b.organization_id is not null
        and b.organization_id = (select private.current_member_organization())
        and (select private.is_organization_member(b.organization_id))
        and (
          b.audience_scope = 'organization'
          or (
            b.audience_scope = 'chapter'
            and exists (
              select 1
              from public.member_chapter_memberships m
              where m.user_id = (select auth.uid())
                and m.chapter_id = b.chapter_id
                and m.status = 'active'
            )
          )
        )
    )
  end;
$function$;

CREATE OR REPLACE FUNCTION private.member_notice_read_count(p_broadcast_id text)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select pg_catalog.count(*)
  from public.member_broadcast_receipts r
  join public.member_broadcasts b on b.id = r.broadcast_id
  where r.broadcast_id = p_broadcast_id
    and private.member_scoped_notice_in_audience(r.user_id,b);
$function$;

CREATE OR REPLACE FUNCTION private.visible_member_broadcast_ids()
 RETURNS SETOF text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with caller as materialized (
    select
      (select auth.uid()) as uid,
      (select private.mfa_satisfied()) as mfa,
      (select private.current_member_organization()) as organization_id,
      (select private.is_organization_member(private.current_member_organization())) as is_member
  ),
  active_chapters as materialized (
    select membership.chapter_id
    from public.member_chapter_memberships membership
    cross join caller
    where membership.user_id = caller.uid
      and membership.status = 'active'
  )
  select broadcast.id
  from public.member_broadcasts broadcast
  cross join caller
  where caller.uid is not null
    and caller.mfa
    and private.member_scoped_notice_in_audience(caller.uid,broadcast)
    and broadcast.organization_id is not null
    and broadcast.organization_id = caller.organization_id
    and caller.is_member
    and (
      broadcast.audience_scope = 'organization'
      or (
        broadcast.audience_scope = 'chapter'
        and broadcast.chapter_id in (select active_chapters.chapter_id from active_chapters)
      )
    );
$function$;

CREATE OR REPLACE FUNCTION private.queue_member_broadcast_delivery()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  if new.organization_id is null then return new; end if;
  insert into public.engagement_delivery_outbox (
    organization_id, recipient_user_id, delivery_kind, source_kind, source_id, locale
  )
  select new.organization_id, membership.user_id, 'broadcast', 'broadcast', new.id, new.locale
  from public.organization_memberships membership
  left join public.member_profiles profile on profile.id = membership.user_id
  where membership.organization_id = new.organization_id
    and membership.status = 'active'
    and membership.revoked_at is null
    and (((new.access_unit_id is null and new.access_committee_id is null) and (new.audience_scope = 'organization' or profile.chapter_id = new.chapter_id)) or ((new.access_unit_id is not null or new.access_committee_id is not null) and private.member_scoped_notice_in_audience(membership.user_id,new)))
    and not private.engagement_email_opted_out(membership.user_id, 'broadcast')
  on conflict (delivery_kind, source_id, recipient_user_id) do nothing;
  return new;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION private.engagement_delivery_recipient_eligible(p_organization_id uuid, p_recipient_user_id uuid, p_source_kind text, p_source_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
      select 1
      from public.organization_memberships membership
      where membership.organization_id = p_organization_id
        and membership.user_id = p_recipient_user_id
        and membership.status = 'active'
        and membership.revoked_at is null
    )
    and case p_source_kind
      when 'broadcast' then not exists (
        select 1
        from public.member_broadcasts broadcast
        left join public.member_profiles profile on profile.id = p_recipient_user_id
        where broadcast.id = p_source_id
          and broadcast.organization_id = p_organization_id
          and (((broadcast.access_unit_id is null and broadcast.access_committee_id is null) and broadcast.audience_scope <> 'organization' and profile.chapter_id is distinct from broadcast.chapter_id) or ((broadcast.access_unit_id is not null or broadcast.access_committee_id is not null) and not private.member_scoped_notice_in_audience(p_recipient_user_id,broadcast)))
      )
      when 'survey' then not exists (
        select 1
        from public.organization_surveys survey
        left join public.member_profiles profile on profile.id = p_recipient_user_id
        where survey.id::text = p_source_id
          and survey.organization_id = p_organization_id
          and survey.chapter_id is not null
          and profile.chapter_id is distinct from survey.chapter_id
      )
      else true
    end
$function$;

CREATE OR REPLACE FUNCTION public.get_engagement_delivery_payload(p_delivery_id uuid, p_lease_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  row public.engagement_delivery_outbox%rowtype;
  email text;
  title text;
  body text;
  action_path text;
  category text;
  unsubscribe_token text;
begin
  select * into row from public.engagement_delivery_outbox
  where id = p_delivery_id and state = 'leased' and lease_token = p_lease_token
    and lease_expires_at >= pg_catalog.now();
  if not found then raise exception 'delivery lease not found' using errcode = 'P0002'; end if;
  -- The member may have opted out after this row was queued.
  if private.engagement_email_opted_out(row.recipient_user_id, row.delivery_kind) then
    return pg_catalog.jsonb_build_object('available', false, 'suppressed', true, 'reason', 'recipient_opted_out');
  end if;
  -- The newest Main contract rechecks active membership and the current
  -- broadcast or survey audience at send time. Revoked rows are terminally
  -- suppressed by complete_engagement_delivery.
  if not private.engagement_delivery_recipient_eligible(
    row.organization_id, row.recipient_user_id, row.source_kind, row.source_id
  ) then
    return pg_catalog.jsonb_build_object('available', false, 'suppressed', true, 'reason', 'recipient_access_revoked');
  end if;
  category := private.engagement_email_category(row.delivery_kind);
  unsubscribe_token := private.engagement_email_unsubscribe_token(row.recipient_user_id, category);
  select user_row.email into email from auth.users user_row where user_row.id = row.recipient_user_id;
  if row.source_kind = 'broadcast' then
    select broadcast.title, broadcast.body, '/m/messages?broadcast=' || row.source_id into title, body, action_path
    from public.member_broadcasts broadcast where broadcast.id = row.source_id
      and broadcast.organization_id = row.organization_id and broadcast.retracted_at is null
      and ((broadcast.access_unit_id is null and broadcast.access_committee_id is null) or private.member_scoped_notice_in_audience(row.recipient_user_id,broadcast));
  elsif row.source_kind = 'survey' then
    select survey.title, case row.delivery_kind when 'survey_reminder'
      then 'A survey is still waiting for your response in Union Ground.'
      else 'A survey is ready for you in Union Ground.' end,
      '/m/voice?survey=' || row.source_id into title, body, action_path
    from public.organization_surveys survey where survey.id = row.source_id::uuid
      and survey.organization_id = row.organization_id and survey.status = 'open'
      -- An email queued before the close time is not sent after it.
      and (survey.closes_at is null or survey.closes_at > pg_catalog.now());
  elsif row.source_kind = 'first_signin_welcome' then
    -- Restored first-sign-in welcome (20261003031000): sent only while the
    -- member still belongs to the organization.
    select row.subject_snapshot, row.body_snapshot, row.action_path_snapshot into title, body, action_path
    from public.organization_memberships membership
    where membership.organization_id = row.organization_id
      and membership.user_id = row.recipient_user_id
      and membership.status = 'active' and membership.revoked_at is null;
  else
    select row.subject_snapshot, row.body_snapshot, row.action_path_snapshot into title, body, action_path
    from public.member_welcome_enrollments enrollment
    join public.organization_memberships membership
      on membership.organization_id = enrollment.organization_id
      and membership.user_id = enrollment.member_user_id
    where enrollment.id = pg_catalog.split_part(row.source_id, ':', 1)::uuid
      and enrollment.organization_id = row.organization_id and enrollment.member_user_id = row.recipient_user_id
      and enrollment.state in ('active','completed')
      and membership.status = 'active' and membership.revoked_at is null;
  end if;
  if email is null or title is null or unsubscribe_token is null then
    return pg_catalog.jsonb_build_object('available', false);
  end if;
  return pg_catalog.jsonb_build_object(
    'available', true, 'email', email, 'locale', row.locale,
    'subject', title, 'body', body, 'path', action_path,
    'category', category, 'transactional', false,
    'unsubscribeToken', unsubscribe_token
  );
end;
$function$;


alter table public.member_roles drop constraint member_roles_role_check;
alter table public.member_roles add constraint member_roles_role_check check(role in ('steward','organizer','coordinator','advisor','admin','vp','secretary','records'));
alter table public.member_role_chapters drop constraint member_role_chapters_role_check;
alter table public.member_role_chapters add constraint member_role_chapters_role_check check(role in ('steward','organizer','coordinator','advisor','admin','vp','secretary','records'));
alter table public.member_invitations drop constraint member_invitations_initial_role_check;
alter table public.member_invitations add constraint member_invitations_initial_role_check check(initial_role is null or initial_role in ('steward','organizer','coordinator','advisor','admin','vp','secretary','records'));

create or replace function private.member_has_chapter_role(
  p_chapter_id text,
  p_roles text[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select auth.uid()) is not null
    and (select private.mfa_satisfied())
    and exists (
    select 1
    from public.chapters c
    where c.id = p_chapter_id
      and (
        (
          c.organization_id is not null
          and c.organization_id = (select private.current_member_organization())
          and exists (
            select 1
            from public.organization_memberships om
            where om.user_id = (select auth.uid())
              and om.organization_id = c.organization_id
              and om.status = 'active'
          )
          and exists (
            select 1
            from public.member_chapter_memberships m
            where m.user_id = (select auth.uid())
              and m.chapter_id = c.id
              and m.status = 'active'
          )
          and (
            not private.staff_mfa_required(c.organization_id)
            or private.has_second_factor((select auth.uid()))
          )
          and (
            private.has_organization_role(c.organization_id, p_roles)
            or exists (
              select 1
              from public.member_role_chapters rc
              join public.member_chapter_memberships m
                on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id
              where rc.user_id = (select auth.uid())
                and rc.role = any(p_roles)
                and not exists(select 1 from private.chapter_role_scopes scope where scope.user_id=rc.user_id and scope.chapter_id=rc.chapter_id and scope.role=rc.role)
                and rc.chapter_id = c.id
                and m.status = 'active'
            )
          )
        )
        or (
          c.organization_id is null
          and (select private.current_member_organization()) is null
          and public.member_has_role(p_roles)
          and exists (
            select 1
            from public.member_roles r
            where r.user_id = (select auth.uid())
              and r.role = any(p_roles)
              and (
                r.chapter_id is null
                or exists (
                  select 1
                  from public.member_role_chapters rc
                  join public.member_chapter_memberships m
                    on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id
                  where rc.user_id = r.user_id
                    and rc.role = r.role
                    and not exists(select 1 from private.chapter_role_scopes scope where scope.user_id=rc.user_id and scope.chapter_id=rc.chapter_id and scope.role=rc.role)
                    and rc.chapter_id = p_chapter_id
                    and m.status = 'active'
                )
              )
          )
        )
      )
  );
$function$;

revoke all on function private.member_has_chapter_role(text,text[]) from public, anon, authenticated, service_role;

grant execute on function private.member_has_chapter_role(text,text[]) to authenticated;

create or replace function public.staff_can_see_user(p_target uuid, p_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when (select auth.uid()) is null or p_target is null or p_role is null or p_role not in ('steward','coordinator','advisor','admin','vp') then false
    when not (select private.mfa_satisfied()) then false
    else exists (
      select 1
      from public.member_profiles target
      join public.chapters target_chapter on target_chapter.id = target.chapter_id
      where target.id = p_target
        and (
          (
            target_chapter.organization_id is not null
            and target_chapter.organization_id = (select private.current_member_organization())
            and (
              private.has_organization_role(target_chapter.organization_id, array[p_role])
              or private.member_has_chapter_role(target_chapter.id, array[p_role])
              or exists(select 1 from private.chapter_role_scopes scope where scope.user_id=(select auth.uid()) and scope.role=p_role and private.chapter_scoped_role_allows(scope.chapter_id,p_role,p_target,false))
            )
          )
          or (
            target_chapter.organization_id is null
            and (select private.current_member_organization()) is null
            and exists (
              select 1
              from public.member_profiles caller_profile
              left join public.chapters caller_chapter
                on caller_chapter.id = caller_profile.chapter_id
              where caller_profile.id = (select auth.uid())
                and (caller_chapter.id is null or caller_chapter.organization_id is null)
            )
            and (
              not (select private.staff_mfa_required())
              or (select private.has_second_factor((select auth.uid())))
            )
            and exists (
              select 1
              from public.member_roles r
              where r.user_id = (select auth.uid())
                and r.role = p_role
                and (
                  r.chapter_id is null
                  or exists (
                    select 1
                    from public.member_role_chapters rc
                    join public.member_chapter_memberships m
                      on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id
                    join public.chapters mapped on mapped.id = rc.chapter_id
                    where rc.user_id = r.user_id
                      and rc.role = r.role
                      and rc.chapter_id = target.chapter_id
                      and mapped.organization_id is null
                      and m.status = 'active'
                  )
                )
            )
          )
        )
    )
  end;
$function$;

revoke all on function public.staff_can_see_user(uuid,text) from public, anon, authenticated, service_role;

grant execute on function public.staff_can_see_user(uuid,text) to authenticated, service_role;

create or replace function private.staff_visible_member_ids(p_role text)
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_role is null or p_role not in ('steward','coordinator','advisor','admin','vp') then return; end if;
  return query
  with caller as materialized (
    select
      (select auth.uid()) as uid,
      (select private.current_member_organization()) as organization_id
  ),
  organization_role as materialized (
    select case when caller.uid is not null and p_role is not null
      and caller.organization_id is not null and (select private.mfa_satisfied())
      then private.has_organization_role(caller.organization_id, array[p_role])
      else false end as allowed
    from caller
  ),
  visible_chapters as materialized (
    select chapter.id
    from public.chapters chapter
    cross join caller
    cross join organization_role
    where caller.uid is not null
      and p_role is not null
      and (select private.mfa_satisfied())
      and (
        (
          chapter.organization_id is not null
          and chapter.organization_id = caller.organization_id
          and (
            organization_role.allowed
            or private.member_has_chapter_role(
              chapter.id,
              array[p_role]
            )
          )
        )
        or (
          chapter.organization_id is null
          and caller.organization_id is null
          and exists (
            select 1
            from public.member_profiles caller_profile
            left join public.chapters caller_chapter
              on caller_chapter.id = caller_profile.chapter_id
            where caller_profile.id = caller.uid
              and (
                caller_chapter.id is null
                or caller_chapter.organization_id is null
              )
          )
          and (
            not (select private.staff_mfa_required())
            or (select private.has_second_factor(caller.uid))
          )
          and exists (
            select 1
            from public.member_roles role_grant
            where role_grant.user_id = caller.uid
              and role_grant.role = p_role
              and (
                role_grant.chapter_id is null
                or exists (
                  select 1
                  from public.member_role_chapters role_chapter
                  join public.member_chapter_memberships membership
                    on membership.user_id = role_chapter.user_id
                   and membership.chapter_id = role_chapter.chapter_id
                  join public.chapters mapped_chapter
                    on mapped_chapter.id = role_chapter.chapter_id
                  where role_chapter.user_id = role_grant.user_id
                    and role_chapter.role = role_grant.role
                    and role_chapter.chapter_id = chapter.id
                    and mapped_chapter.organization_id is null
                    and membership.status = 'active'
                )
              )
          )
        )
      )
  )
  select profile.id
  from public.member_profiles profile
  where profile.chapter_id = any (array(select visible_chapters.id from visible_chapters))
    or profile.id in (select private.chapter_scoped_member_ids(p_role));
end;
$function$;

revoke all on function private.staff_visible_member_ids(text) from public, anon, authenticated, service_role;

grant execute on function private.staff_visible_member_ids(text) to authenticated, service_role;

create or replace function public.set_member_chapter_role(
  p_user_id uuid,
  p_chapter_id text,
  p_role text,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid(),p_user_id],array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target_org uuid;
  org_admin boolean;
begin
  if caller is null then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('steward', 'organizer', 'coordinator', 'advisor', 'admin', 'vp', 'secretary', 'records') then
    raise exception 'unknown role' using errcode = '22023';
  end if;
  select c.organization_id into target_org
  from public.chapters c
  where c.id = p_chapter_id;
  if target_org is null then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  -- Reject implausible callers without letting them wait on an admin lock.
  org_admin := private.has_organization_role(target_org, array['admin']);
  if not org_admin and p_chapter_id is distinct from private.current_member_chapter() then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not org_admin and not (private.member_has_chapter_role(p_chapter_id, array['admin']) or (p_role in ('secretary','records') and private.member_has_chapter_role(p_chapter_id,array['vp']))) then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || target_org::text, 509));

  -- All authoritative authorization and target-membership checks occur after
  -- the tenant authorization lock. This prevents a queued chapter-admin grant
  -- from restoring authority revoked by the transaction ahead of it.
  org_admin := private.has_organization_role(target_org, array['admin']);
  if not org_admin and p_chapter_id is distinct from private.current_member_chapter() then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not org_admin and not (private.member_has_chapter_role(p_chapter_id, array['admin']) or (p_role in ('secretary','records') and private.member_has_chapter_role(p_chapter_id,array['vp']))) then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.member_chapter_memberships m
    where m.user_id = p_user_id and m.chapter_id = p_chapter_id and m.status = 'active'
  ) then
    raise exception 'active chapter membership required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.organization_memberships om
    where om.user_id = p_user_id and om.organization_id = target_org and om.status = 'active'
  ) then
    raise exception 'active organization membership required' using errcode = '22023';
  end if;

  if coalesce(p_enabled, false) then
    insert into public.member_roles (user_id, role, granted_by, chapter_id)
    values (p_user_id, p_role, caller, p_chapter_id)
    on conflict (user_id, role) do nothing;
    insert into public.member_role_chapters (user_id, role, chapter_id, granted_by)
    values (p_user_id, p_role, p_chapter_id, caller)
    on conflict (user_id, role, chapter_id) do nothing;
  else
    if p_role = 'admin' and p_user_id = caller and p_chapter_id = private.current_member_chapter() then
      raise exception 'an admin cannot remove the active admin role from this session' using errcode = '22023';
    end if;
    delete from public.member_role_chapters
    where user_id = p_user_id and role = p_role and chapter_id = p_chapter_id;
    delete from public.member_roles r
    where r.user_id = p_user_id and r.role = p_role and r.chapter_id is not null
      and not exists (
        select 1 from public.member_role_chapters rc
        where rc.user_id = r.user_id and rc.role = r.role
      );
  end if;

  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (caller, case when coalesce(p_enabled, false) then 'grant_role' else 'revoke_role' end,
    p_user_id, pg_catalog.jsonb_build_object('role', p_role, 'chapterId', p_chapter_id));
  return pg_catalog.jsonb_build_object(
    'userId', p_user_id, 'chapterId', p_chapter_id, 'role', p_role,
    'enabled', coalesce(p_enabled, false));
end;
end;
$function$;

revoke all on function public.set_member_chapter_role(uuid,text,text,boolean) from public, anon, authenticated, service_role;

grant execute on function public.set_member_chapter_role(uuid,text,text,boolean) to authenticated;

create or replace function public.create_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_initial_role text, p_locale text, p_token_hash text)
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
  clean_role text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_initial_role, ''))), '');
  clean_locale text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_locale, '')));
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  name_parts text[];
  clean_first text;
  clean_initials text;
  invitation_row public.member_invitations%rowtype;
  expired_row public.member_invitations%rowtype;
  as_admin boolean;
begin
  if caller is null
     or not (private.member_has_chapter_role(caller_chapter, array['admin'])
             or private.member_invitation_chapter_presided(caller_chapter)) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  -- An admin may invite into any chapter they administer in the selected
  -- organization. A chapter President may invite only into a chapter they
  -- preside over, and only as a plain member (project decision, October 4,
  -- 2026). The desk gate above already holds the organization-role lock.
  as_admin := private.member_invitation_chapter_administrable(target_chapter);
  if not as_admin and (clean_role is not null
     or not private.member_invitation_chapter_presided(target_chapter)) then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  if clean_role is not null and (coalesce(auth.jwt()->>'aal','')<>'aal2' or not private.has_second_factor(caller)) then raise exception 'two-step sign-in required for starting access' using errcode='42501'; end if;

  -- Count before duplicate/existing-account branches. Those branches must not
  -- be a free unbounded address-probing endpoint.
  if not private.consume_member_invitation_admin_limit(
    'admin:' || caller::text, 'create-hour', private.organization_limit(private.current_member_organization(), 'limits.security.invitation_admin_hourly'), interval '1 hour'
  ) or not private.consume_member_invitation_admin_limit(
    'chapter:' || target_chapter, 'chapter-day', private.organization_limit(private.current_member_organization(), 'limits.security.invitation_chapter_daily'), interval '1 day'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001';
  end if;

  if pg_catalog.char_length(clean_email) not between 3 and 254
     or clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or pg_catalog.char_length(clean_name) not between 2 and 120
     or clean_name ~ '[[:cntrl:]]'
     or clean_hash !~ '^[0-9a-f]{64}$'
     or clean_locale not in ('en', 'es')
     or (clean_role is not null and clean_role not in ('steward', 'organizer', 'coordinator', 'advisor', 'vp', 'admin', 'secretary', 'records')) then
    raise exception 'invalid invitation request' using errcode = '22023';
  end if;

  name_parts := pg_catalog.regexp_split_to_array(clean_name, '[[:space:]]+');
  clean_first := name_parts[1];
  clean_initials := pg_catalog.upper(
    pg_catalog.left(clean_first, 1)
    || case when pg_catalog.array_length(name_parts, 1) > 1
       then pg_catalog.left(name_parts[pg_catalog.array_length(name_parts, 1)], 1)
       else '' end
  );

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
     expires_at)
  values
    (clean_email, clean_name, clean_first, clean_initials, target_chapter,
     clean_role, clean_locale, clean_hash, 'pending', 1, caller,
     clock_timestamp() + interval '15 minutes')
  returning * into invitation_row;

  perform private.audit_member_invitation(
    invitation_row.id, target_chapter, caller, 'invite_requested',
    pg_catalog.jsonb_build_object('chapterId', target_chapter,
      'initialRole', clean_role, 'locale', clean_locale,
      'deliveryVersion', invitation_row.delivery_version)
  );

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'send', true,
    'invitationId', invitation_row.id,
    'deliveryVersion', invitation_row.delivery_version,
    'expiresAt', invitation_row.expires_at
  );
end;
end;
$function$;

revoke all on function public.create_member_invitation(text,text,text,text,text,text) from public, anon, authenticated, service_role;

grant execute on function public.create_member_invitation(text,text,text,text,text,text) to authenticated;

create or replace function private.apply_member_invitation_unit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[new.auth_user_id], array[]::uuid[]);
declare
  unit_name text;
  selected_unit uuid;
begin
  if new.auth_user_id is null then
    return null;
  end if;
  with recursive chain(id, replaces_id, depth) as (
    select i.id, i.replaces_id, 0 from public.member_invitations i where i.id = new.id
    union all
    select i.id, i.replaces_id, chain.depth + 1
    from public.member_invitations i
    join chain on i.id = chain.replaces_id
    where chain.depth < 20
  )
  select u.id,u.name into selected_unit,unit_name
  from chain
  join private.member_invitation_units link on link.invitation_id = chain.id
  join private.chapter_units u on u.id = link.unit_id and u.chapter_id = new.chapter_id
  order by chain.depth
  limit 1;
  if unit_name is null then
    return null;
  end if;
  insert into private.chapter_unit_members(unit_id,chapter_id,user_id) values(selected_unit,new.chapter_id,new.auth_user_id) on conflict do nothing;
  insert into public.member_profile_details as d (user_id, worksite)
  values (new.auth_user_id, unit_name)
  on conflict (user_id) do update
    set worksite = excluded.worksite, updated_at = pg_catalog.now()
    where d.worksite is null;
  return null;
end;
end;
$function$;

create or replace function public.update_chapter_document_content(p_id uuid, p_title text, p_document_type text, p_summary text, p_body text, p_visibility text, p_action text DEFAULT 'save'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare row public.chapter_documents%rowtype; chapter text := private.current_member_chapter();
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() or private.member_pin_session_restricted() then raise exception 'authentication required' using errcode='42501'; end if;
  if p_action not in ('save','republish','archive') then raise exception 'invalid document action' using errcode='22023'; end if;
  if p_document_type not in ('contract','policy','minutes','training','template','other') or p_visibility not in ('chapter','staff') then raise exception 'invalid document fields' using errcode='22023'; end if;
  select d.* into row from public.chapter_documents d where d.id=p_id and d.chapter_id=chapter for update;
  if row.id is null then raise exception 'document unavailable' using errcode='22023'; end if;
  if not (private.member_has_chapter_role(chapter,array['steward','coordinator','advisor','admin','vp']) or private.chapter_officer_can_for_scope(chapter,'documents',row.access_unit_id,row.access_committee_id)) then raise exception 'document outside access scope' using errcode='42501'; end if;
  if p_action='save' and row.status='published' then raise exception 'published document requires a new version or archive' using errcode='55000'; end if;
  update public.chapter_documents d set title=btrim(p_title), document_type=p_document_type, summary=coalesce(p_summary,''), body=coalesce(p_body,''), visibility=p_visibility,
    status=case when p_action='archive' then 'archived' when p_action='republish' then 'published' else d.status end,
    version=case when p_action='republish' then d.version+1 else d.version end,
    published_at=case when p_action='republish' then now() else d.published_at end
  where d.id=p_id and d.chapter_id=chapter returning d.* into row;
  if row.id is null then raise exception 'document unavailable' using errcode='22023'; end if;
  return to_jsonb(row);
end;
end;
end;
$function$;

create or replace function private.institutional_context(p_require_staff boolean default true)
returns table (organization_id uuid, chapter_id text, caller_id uuid, staff boolean)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.current_member_organization();
  chapter text := private.current_member_chapter();
  caller uuid := (select auth.uid());
  is_staff boolean := (private.member_has_chapter_role(chapter,array['steward','coordinator','advisor','admin','vp']) or private.chapter_office_role_present(chapter,'records'));
begin
  if caller is null or org is null or chapter is null or not private.mfa_satisfied() then
    raise exception 'organization chapter context required' using errcode = '42501';
  end if;
  if p_require_staff and not is_staff then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  return query select org, chapter, caller, is_staff;
end;
$function$;

revoke all on function private.institutional_context(boolean) from public, anon, authenticated, service_role;

create or replace function public.get_institutional_records_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  ctx record;
begin
  select * into ctx from private.institutional_context(false);
  return pg_catalog.jsonb_build_object(
    'canManage', ctx.staff,
    'chapterId',ctx.chapter_id,'organizationId',ctx.organization_id,
    'canContacts', private.can_read_chapter_contact_record(ctx.chapter_id),
    'canManageUnscoped', private.chapter_record_manageable(ctx.chapter_id,null,null),
    'recordScopes', case when private.member_pin_session_restricted() then '[]'::jsonb else public.get_chapter_office_access()->'scopes' end,
    'canExport', private.has_organization_role(ctx.organization_id, array['admin','vp']),
    'records', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) || pg_catalog.jsonb_build_object(
        'canManage', private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id),
        'versions', case when private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id) then coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(v) order by v.version desc) from public.chapter_record_versions v where v.record_id = r.id), '[]'::jsonb) else '[]'::jsonb end,
        'attendance', case when private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id) then coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('userId', a.user_id, 'status', a.attendance_status) order by p.full_name) from public.meeting_attendance a join public.member_profiles p on p.id = a.user_id where a.record_id = r.id), '[]'::jsonb) else '[]'::jsonb end,
        'dispatch', case when private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id) then coalesce((select pg_catalog.jsonb_build_object('delivered', pg_catalog.count(*) filter (where d.status = 'delivered'), 'failed', pg_catalog.count(*) filter (where d.status = 'failed')) from public.meeting_minutes_dispatches d where d.record_id = r.id and d.version = r.version), pg_catalog.jsonb_build_object('delivered', 0, 'failed', 0)) else pg_catalog.jsonb_build_object('delivered', 0, 'failed', 0) end
      ) order by r.pinned_at desc nulls last, r.occurred_at desc, r.id)
      from public.chapter_records r
      where r.chapter_id = ctx.chapter_id
        and r.archived_at is null
        and (private.chapter_record_publication(r.record_type)='chapter_members' or private.can_read_chapter_contact_record(ctx.chapter_id))
        and ((private.chapter_record_publication(r.record_type)='chapter_members' and private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id)) or private.can_read_chapter_contact_record(ctx.chapter_id) or (r.lifecycle_status='published' and r.visibility='chapter' and private.chapter_record_publication(r.record_type)='chapter_members' and private.chapter_scope_member_allowed(r.chapter_id,r.access_unit_id,r.access_committee_id,(select auth.uid()))))
    ), '[]'::jsonb),
    'contacts', case when private.can_read_chapter_contact_record(ctx.chapter_id) then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(l) || pg_catalog.jsonb_build_object('subjectName', p.full_name) order by l.occurred_at desc, l.id)
      from public.chapter_contact_log l
      left join public.member_profiles p on p.id = l.subject_user_id
      where l.organization_id = ctx.organization_id and l.chapter_id = ctx.chapter_id and l.archived_at is null
    ), '[]'::jsonb) else '[]'::jsonb end,
    'roster', case when ctx.staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('userId', p.id, 'name', p.full_name) order by p.full_name)
      from public.member_chapter_memberships cm
      join public.member_profiles p on p.id = cm.user_id
      where cm.chapter_id = ctx.chapter_id and cm.status = 'active'
        and (private.member_has_chapter_role(ctx.chapter_id,array['steward','coordinator','advisor','admin','vp']) or exists(select 1 from private.chapter_role_capabilities cap left join private.chapter_role_settings setting on setting.chapter_id=ctx.chapter_id and setting.role=cap.role and setting.capability=cap.capability where cap.capability='records' and coalesce(setting.enabled,true) and private.actor_role_covers_member((select auth.uid()),ctx.chapter_id,cap.role,cm.user_id,false)))
    ), '[]'::jsonb) else '[]'::jsonb end,
    'exportRuns', case when private.has_organization_role(ctx.organization_id, array['admin','vp']) then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) order by e.created_at desc)
      from (select * from public.organization_data_export_runs where organization_id = ctx.organization_id order by created_at desc limit 20) e
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$function$;

revoke all on function public.get_institutional_records_workspace() from public, anon, authenticated, service_role;

grant execute on function public.get_institutional_records_workspace() to authenticated;

create or replace function public.save_chapter_contact_log(
  p_contact_id uuid,
  p_contact_kind text,
  p_channel text,
  p_purpose text,
  p_summary text,
  p_outcome text,
  p_occurred_at timestamptz,
  p_follow_up_at timestamptz default null,
  p_subject_user_id uuid default null,
  p_case_id uuid default null,
  p_task_id uuid default null,
  p_archive boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
declare ctx record; saved public.chapter_contact_log%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into ctx from private.institutional_context(true);
  if not private.can_read_chapter_contact_record(ctx.chapter_id) then raise exception 'contact access required' using errcode='42501'; end if;
  if p_contact_kind not in ('member','management','community','provider','other')
     or p_channel not in ('in_person','phone','email','message','meeting','other')
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_purpose, ''))) not between 1 and 160
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_summary, ''))) not between 1 and 4000
     or pg_catalog.char_length(coalesce(p_outcome, '')) > 1000
     or p_occurred_at is null or (p_follow_up_at is not null and p_follow_up_at < p_occurred_at) then
    raise exception 'invalid contact log' using errcode = '22023';
  end if;
  if p_subject_user_id is not null and not exists (
    select 1 from public.member_chapter_memberships cm where cm.chapter_id = ctx.chapter_id and cm.user_id = p_subject_user_id and cm.status = 'active'
  ) then raise exception 'contact subject is outside this chapter' using errcode = '42501'; end if;
  if p_case_id is not null and not exists (
    select 1 from public.member_cases c join public.member_profiles p on p.id = c.user_id
    where c.id = p_case_id and p.chapter_id = ctx.chapter_id
  ) then raise exception 'case is outside this chapter' using errcode = '42501'; end if;
  if p_task_id is not null and not exists (
    select 1 from public.chapter_tasks t where t.id = p_task_id and t.chapter_id = ctx.chapter_id
  ) then raise exception 'task is outside this chapter' using errcode = '42501'; end if;

  if p_contact_id is null then
    insert into public.chapter_contact_log (
      organization_id, chapter_id, subject_user_id, contact_kind, channel, purpose, summary,
      outcome, occurred_at, follow_up_at, case_id, task_id, created_by, updated_by, archived_at
    ) values (
      ctx.organization_id, ctx.chapter_id, p_subject_user_id, p_contact_kind, p_channel,
      pg_catalog.btrim(p_purpose), pg_catalog.btrim(p_summary), nullif(pg_catalog.btrim(p_outcome), ''),
      p_occurred_at, p_follow_up_at, p_case_id, p_task_id, ctx.caller_id, ctx.caller_id,
      case when p_archive then pg_catalog.now() end
    ) returning * into saved;
    insert into public.chapter_contact_log_versions (
      contact_id, chapter_id, version, subject_user_id, contact_kind, channel, purpose, summary,
      outcome, occurred_at, follow_up_at, case_id, task_id, archived_at, changed_by, changed_at
    ) values (
      saved.id, saved.chapter_id, 1, saved.subject_user_id, saved.contact_kind, saved.channel,
      saved.purpose, saved.summary, saved.outcome, saved.occurred_at, saved.follow_up_at,
      saved.case_id, saved.task_id, saved.archived_at, ctx.caller_id, pg_catalog.now()
    );
    insert into private.chapter_contact_log_audit (contact_id, actor_id, action, created_at)
    values (saved.id, ctx.caller_id, 'created', pg_catalog.now());
  else
    with pre as (
      select *
      from public.chapter_contact_log l
      where l.id = p_contact_id
        and l.organization_id = ctx.organization_id
        and l.chapter_id = ctx.chapter_id
      for update
    ),
    written as (
      update public.chapter_contact_log l set
        subject_user_id = p_subject_user_id, contact_kind = p_contact_kind, channel = p_channel,
        purpose = pg_catalog.btrim(p_purpose), summary = pg_catalog.btrim(p_summary),
        outcome = nullif(pg_catalog.btrim(p_outcome), ''), occurred_at = p_occurred_at,
        follow_up_at = p_follow_up_at, case_id = p_case_id, task_id = p_task_id,
        updated_by = ctx.caller_id, updated_at = pg_catalog.now(),
        archived_at = case when p_archive then pg_catalog.now() else null end
      from pre
      where l.id = pre.id
      returning l.*
    ),
    versioned as (
      insert into public.chapter_contact_log_versions (
        contact_id, chapter_id, version, subject_user_id, contact_kind, channel, purpose, summary,
        outcome, occurred_at, follow_up_at, case_id, task_id, archived_at, changed_by, changed_at
      )
      select
        pre.id,
        pre.chapter_id,
        (select coalesce(max(v.version), 0) + 1 from public.chapter_contact_log_versions v where v.contact_id = pre.id),
        pre.subject_user_id, pre.contact_kind, pre.channel, pre.purpose, pre.summary, pre.outcome,
        pre.occurred_at, pre.follow_up_at, pre.case_id, pre.task_id, pre.archived_at,
        ctx.caller_id, pg_catalog.now()
      from pre
      returning contact_id
    ),
    audited as (
      insert into private.chapter_contact_log_audit (contact_id, actor_id, action, created_at)
      select
        written.id,
        ctx.caller_id,
        case
          when pre.archived_at is null and written.archived_at is not null then 'archived'
          when pre.archived_at is not null and written.archived_at is null then 'unarchived'
          else 'edited'
        end,
        pg_catalog.now()
      from pre
      cross join written
      returning contact_id
    )
    select written.* into saved
    from written
    left join versioned on true
    left join audited on true;
    if saved.id is null then raise exception 'contact log not found' using errcode = 'P0002'; end if;
  end if;
  return pg_catalog.to_jsonb(saved);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_steward_chapter_member_count()
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  result integer;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  select pg_catalog.count(*)::integer into result from private.staff_visible_member_ids('steward');

  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_steward_badge_counts()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  open_requests integer;
  forms_inbox integer;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;


  select count(*)::integer into open_requests
  from public.member_steward_requests sr
  join public.member_profiles p on p.id = sr.user_id
  where sr.status <> 'closed'
    and public.staff_can_see_user(p.id,'steward');

  select count(*)::integer into forms_inbox
  from public.member_forms f
  join public.member_profiles p on p.id = f.user_id
  where f.status in ('submitted', 'in_review') and private.member_form_scope_and_identity_allowed(f)
    and public.staff_can_see_user(p.id,'steward');

  return pg_catalog.jsonb_build_object(
    'openRequests', coalesce(open_requests, 0),
    'formsInbox', coalesce(forms_inbox, 0),
    'generatedAt', now()
  );
end;
$function$;

create or replace function public.publish_member_broadcast(
  p_title text,
  p_body text,
  p_locale text default 'en',
  p_audience_scope text default 'chapter'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  publisher_org uuid := private.current_member_organization();
  publisher_chapter text := private.current_member_chapter();
  clean_title text := pg_catalog.btrim(coalesce(p_title, ''));
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''));
  clean_locale text := coalesce(nullif(pg_catalog.btrim(coalesce(p_locale, '')), ''), 'en');
  clean_scope text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_audience_scope, 'chapter')));
  recent integer;
  new_id text;
  next_index integer;
  attempts integer := 0;
  sender_label text;
begin
  if caller is null then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if publisher_org is null or publisher_chapter is null then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.chapters c
    where c.id = publisher_chapter and c.organization_id = publisher_org
  ) then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if clean_scope not in ('chapter', 'organization') then
    raise exception 'audience_scope must be chapter or organization' using errcode = '22023';
  end if;
  if clean_scope = 'organization'
     and not private.has_organization_role(publisher_org, array['steward', 'admin', 'vp']) then
    raise exception 'organization-wide steward role required' using errcode = '42501';
  end if;
  if clean_scope = 'chapter'
     and not (private.member_has_chapter_role(publisher_chapter, array['steward', 'admin', 'vp']) or private.chapter_officer_can(publisher_chapter,'notices')) then
    raise exception 'chapter steward role required' using errcode = '42501';
  end if;
  -- Members read the sender line. A steward keeps the existing sender; an
  -- admin or president who is not a steward in that scope posts as officers.
  sender_label := case
    when (clean_scope = 'organization' and private.has_organization_role(publisher_org, array['steward']))
      or (clean_scope = 'chapter' and private.member_has_chapter_role(publisher_chapter, array['steward']))
    then 'Chapter steward'
    else 'Union officers'
  end;

  if clean_title = '' or pg_catalog.char_length(clean_title) > 120 then
    raise exception 'title must be between 1 and 120 characters' using errcode = '22023';
  end if;
  if clean_title ~ '[[:cntrl:]]' then
    raise exception 'title contains unsupported control characters' using errcode = '22023';
  end if;
  if clean_body = '' or pg_catalog.char_length(clean_body) > 4000 then
    raise exception 'body must be between 1 and 4000 characters' using errcode = '22023';
  end if;
  if pg_catalog.regexp_replace(clean_body, '[' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9) || ']', '', 'g') ~ '[[:cntrl:]]' then
    raise exception 'body contains unsupported control characters' using errcode = '22023';
  end if;
  if clean_locale not in ('en', 'es') then
    raise exception 'locale must be en or es' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-broadcast-publish:' || caller::text, 509));

  select count(*) into recent
  from public.member_broadcasts
  where created_by = caller
    and published_at >= now() - interval '24 hours';
  if recent >= 5 then
    raise exception 'broadcast limit reached: 5 per steward per day' using errcode = '54000';
  end if;

  loop
    begin
      new_id := 'bc-' || extensions.gen_random_uuid();
      select coalesce(min(order_index), 1) - 1 into next_index from public.member_broadcasts;
      insert into public.member_broadcasts (
        id, sender, title, body, published_at, order_index, created_by, locale,
        organization_id, chapter_id, audience_scope
      )
      values (
        new_id, sender_label, clean_title, clean_body, now(), next_index, caller, clean_locale,
        publisher_org, publisher_chapter, clean_scope
      );
      exit;
    exception when unique_violation then
      attempts := attempts + 1;
      if attempts >= 3 then
        raise;
      end if;
    end;
  end loop;

  return pg_catalog.jsonb_build_object('broadcastId', new_id);
end;
end;
$function$;

create or replace function public.retract_member_broadcast(p_broadcast_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  publisher_org uuid := private.current_member_organization();
  updated integer;
begin
  if caller is null
     or not (private.member_has_chapter_role(private.current_member_chapter(), array['steward', 'admin', 'vp']) or private.chapter_office_role_present(private.current_member_chapter(),'notices')) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if publisher_org is null then
    raise exception 'organization required' using errcode = '42501';
  end if;

  update public.member_broadcasts
  set retracted_at = now()
  where id = p_broadcast_id
    and created_by = caller
    and retracted_at is null
    and organization_id = publisher_org
    and ((audience_scope='chapter' and (private.member_has_chapter_role(chapter_id,array['steward','admin','vp']) or private.chapter_officer_can_for_scope(chapter_id,'notices',access_unit_id,access_committee_id))) or (audience_scope='organization' and private.has_organization_role(publisher_org,array['steward','admin','vp'])));
  get diagnostics updated = row_count;
  if updated = 0 then
    raise exception 'broadcast not found, not yours, or already retracted' using errcode = '22023';
  end if;

  return pg_catalog.jsonb_build_object('broadcastId', p_broadcast_id, 'retracted', true);
end;
end;
$function$;

create or replace function public.get_broadcast_read_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  result jsonb;
  publisher_org uuid := private.current_member_organization();
begin
  if (select auth.uid()) is null
     or not (private.member_has_chapter_role(private.current_member_chapter(), array['steward', 'admin', 'vp']) or private.chapter_office_role_present(private.current_member_chapter(),'notices')) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if publisher_org is null then
    return '[]'::jsonb;
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'broadcastId', recent.id,
      'readCount', private.member_notice_read_count(recent.id)
    ) order by recent.published_at desc
  ), '[]'::jsonb)
  into result
  from (
    select b.id, b.published_at
    from public.member_broadcasts b
    where b.organization_id = publisher_org
      and ((b.audience_scope='chapter' and (private.member_has_chapter_role(b.chapter_id,array['steward','admin','vp']) or private.chapter_officer_can_for_scope(b.chapter_id,'notices',b.access_unit_id,b.access_committee_id))) or (b.audience_scope='organization' and private.has_organization_role(publisher_org,array['steward','admin','vp'])))
      and private.can_read_member_broadcast(b.id)
    order by b.published_at desc
    limit 20
  ) recent;

  return result;
end;
$function$;

create or replace function public.get_broadcast_read_counts_for(p_broadcast_ids text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  result jsonb;
  publisher_org uuid := private.current_member_organization();
begin
  if (select auth.uid()) is null
     or not (private.member_has_chapter_role(private.current_member_chapter(), array['steward', 'admin', 'vp']) or private.chapter_office_role_present(private.current_member_chapter(),'notices')) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_broadcast_ids is null
     or pg_catalog.cardinality(p_broadcast_ids) < 1
     or pg_catalog.cardinality(p_broadcast_ids) > 100 then
    raise exception 'between 1 and 100 broadcast ids' using errcode = '22023';
  end if;
  if publisher_org is null then
    return '[]'::jsonb;
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'broadcastId', b.id,
      'readCount', private.member_notice_read_count(b.id)
    ) order by b.published_at desc
  ), '[]'::jsonb)
  into result
  from public.member_broadcasts b
  where b.id = any(p_broadcast_ids)
    and b.organization_id = publisher_org
      and ((b.audience_scope='chapter' and (private.member_has_chapter_role(b.chapter_id,array['steward','admin','vp']) or private.chapter_officer_can_for_scope(b.chapter_id,'notices',b.access_unit_id,b.access_committee_id))) or (b.audience_scope='organization' and private.has_organization_role(publisher_org,array['steward','admin','vp'])))
    and private.can_read_member_broadcast(b.id);

  return result;
end;
$function$;

create or replace function public.list_my_member_notices(
  p_limit integer default 20,
  p_before_published timestamptz default null,
  p_before_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  chapter text := private.current_member_chapter();
  page_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  rows jsonb;
  more boolean;
begin
  if caller is null or org is null or chapter is null
     or not (private.member_has_chapter_role(chapter, array['steward', 'admin', 'vp']) or private.chapter_office_role_present(chapter,'notices')) then
    raise exception 'notice publisher role required' using errcode = '42501';
  end if;
  if (p_before_published is null) <> (p_before_id is null) then
    raise exception 'incomplete cursor' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', n.id,
      'title', n.title,
      'body', n.body,
      'locale', n.locale,
      'audience', n.audience_scope,
      'chapterId', n.chapter_id,
      'publishedAt', n.published_at,
      'retractedAt', n.retracted_at,
      'readCount', private.member_notice_read_count(n.id),
      'audienceCount', private.member_scoped_notice_audience_count(n.id)
    ) order by n.published_at desc, n.id desc), '[]'::jsonb)
    into rows
  from (
    select b.id, b.title, b.body, b.locale, b.audience_scope, b.chapter_id,
           b.organization_id, b.published_at, b.retracted_at
    from public.member_broadcasts b
    where b.created_by = caller
      and b.organization_id = org
      and ((b.audience_scope='chapter' and (private.member_has_chapter_role(b.chapter_id,array['steward','admin','vp']) or private.chapter_officer_can_for_scope(b.chapter_id,'notices',b.access_unit_id,b.access_committee_id))) or (b.audience_scope='organization' and private.has_organization_role(org,array['steward','admin','vp'])))
      and (p_before_published is null or (b.published_at, b.id) < (p_before_published, p_before_id))
    order by b.published_at desc, b.id desc
    limit page_limit
  ) n;

  -- One row past the page says whether an older page exists.
  select exists (
    select 1
    from public.member_broadcasts b
    where b.created_by = caller
      and b.organization_id = org
      and ((b.audience_scope='chapter' and (private.member_has_chapter_role(b.chapter_id,array['steward','admin','vp']) or private.chapter_officer_can_for_scope(b.chapter_id,'notices',b.access_unit_id,b.access_committee_id))) or (b.audience_scope='organization' and private.has_organization_role(org,array['steward','admin','vp'])))
      and (p_before_published is null or (b.published_at, b.id) < (p_before_published, p_before_id))
    order by b.published_at desc, b.id desc
    offset page_limit
  ) into more;

  return pg_catalog.jsonb_build_object('notices', rows, 'hasMore', more);
end;
$function$;

create or replace function public.get_member_notice_receipts(p_broadcast_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  chapter text := private.current_member_chapter();
  notice record;
  readers jsonb;
begin
  if caller is null or org is null or chapter is null
     or not (private.member_has_chapter_role(chapter, array['steward', 'admin', 'vp']) or private.chapter_office_role_present(chapter,'notices')) then
    raise exception 'notice publisher role required' using errcode = '42501';
  end if;

  select b.id, b.organization_id, b.chapter_id, b.audience_scope
    into notice
  from public.member_broadcasts b
  where b.id = p_broadcast_id
    and b.created_by = caller
    and b.organization_id = org
      and ((b.audience_scope='chapter' and (private.member_has_chapter_role(b.chapter_id,array['steward','admin','vp']) or private.chapter_officer_can_for_scope(b.chapter_id,'notices',b.access_unit_id,b.access_committee_id))) or (b.audience_scope='organization' and private.has_organization_role(org,array['steward','admin','vp'])));
  if not found then
    raise exception 'notice not found or not yours' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', nullif(pg_catalog.btrim(coalesce(p.full_name, '')), ''),
      'readAt', r.read_at
    ) order by r.read_at desc, r.user_id), '[]'::jsonb)
    into readers
  from (
    select receipt.user_id, receipt.read_at
    from public.member_broadcast_receipts receipt
    where receipt.broadcast_id = notice.id
      and private.member_scoped_notice_in_audience(receipt.user_id,(select b from public.member_broadcasts b where b.id=notice.id))
    order by receipt.read_at desc, receipt.user_id
    limit 500
  ) r
  left join public.member_profiles p on p.id = r.user_id;

  return pg_catalog.jsonb_build_object(
    'id', notice.id,
    'readCount', private.member_notice_read_count(notice.id),
    'audienceCount', private.member_scoped_notice_audience_count(notice.id),
    'readers', readers
  );
end;
$function$;

create or replace function public.list_announcement_drafts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  chapter text;
  rows jsonb;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  org := private.current_member_organization();
  chapter := private.current_member_chapter();
  if org is null or chapter is null or not (private.member_has_chapter_role(chapter, array['steward', 'admin', 'vp']) or private.chapter_officer_can(chapter,'notices')) then
    raise exception 'chapter steward role required' using errcode = '42501';
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', f.id, 'title', f.title, 'body', f.body, 'eventId', f.source_id, 'createdAt', f.created_at
    ) order by f.created_at desc, f.id), '[]'::jsonb)
    into rows
  from (
    select f.* from private.engagement_follow_ups f
    join public.member_events e on e.id = f.source_id and e.chapter_id = f.chapter_id and e.cancelled_at is null
    where f.organization_id = org and f.chapter_id = chapter
      and f.kind = 'announcement_draft' and f.state = 'draft'
    order by f.created_at desc, f.id
    limit 20
  ) f;
  return pg_catalog.jsonb_build_object('organizationId', org, 'drafts', rows);
end;
$function$;

create or replace function public.resolve_announcement_draft(p_draft_id uuid, p_state text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  actor uuid := (select auth.uid());
  org uuid;
  chapter text;
  resolved uuid;
begin
  if actor is null or not private.mfa_satisfied() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  if p_state is null or p_state not in ('published', 'dismissed') then
    raise exception 'invalid draft state' using errcode = '22023';
  end if;
  org := private.current_member_organization();
  chapter := private.current_member_chapter();
  if org is null or chapter is null or not (private.member_has_chapter_role(chapter, array['steward', 'admin', 'vp']) or private.chapter_officer_can(chapter,'notices')) then
    raise exception 'chapter steward role required' using errcode = '42501';
  end if;
  update private.engagement_follow_ups f
     set state = p_state, resolved_at = pg_catalog.now()
   where f.id = p_draft_id and f.organization_id = org and f.chapter_id = chapter
     and f.kind = 'announcement_draft' and f.state = 'draft'
  returning f.id into resolved;
  if resolved is null then
    raise exception 'draft unavailable' using errcode = '22023';
  end if;
  perform private.cr108_record_audit(
    org, 'announcement_draft_resolved', 'update', 'broadcast', resolved::text, actor,
    pg_catalog.jsonb_build_object('status', p_state), extensions.gen_random_uuid()
  );
  return pg_catalog.jsonb_build_object('organizationId', org, 'id', resolved, 'state', p_state);
end;
end;
$function$;

create table private.case_identity_privacy (
  -- Retain the privacy instruction when a case moves to account-lifecycle
  -- history. It carries no user identifier or case text. The writer validates
  -- and locks its live case; no client can create an orphan mark directly.
  case_id uuid primary key
);
alter table private.case_identity_privacy enable row level security;
alter table private.case_identity_privacy force row level security;
revoke all on private.case_identity_privacy from public, anon, authenticated, service_role;
create policy mfa_assurance on private.case_identity_privacy as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
-- The only runtime writer locks its live case through lock_case_graph before
-- touching this RPC-only, identifier-only table. It deliberately has no FK:
-- the privacy instruction survives the case's move into retained history.

-- Shared actor-aware checks for background delivery and assignment. These
-- functions are not client RPCs and never take a role from JWT metadata.
create function private.actor_role_covers_member(p_actor uuid,p_chapter text,p_role text,p_target uuid,p_grievance boolean default false)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists(select 1 from public.chapters c
    join public.organizations organization on organization.id=c.organization_id and organization.status='active'
    join public.organization_memberships actor_org on actor_org.organization_id=c.organization_id and actor_org.user_id=p_actor and actor_org.status='active'
    left join public.organization_memberships target_org on target_org.organization_id=c.organization_id and target_org.user_id=p_target and target_org.status='active'
    left join public.member_chapter_memberships target on target.chapter_id=c.id and target.user_id=p_target and target.status='active'
    where c.id=p_chapter
      and (not private.staff_mfa_required(c.organization_id) or private.has_second_factor(p_actor))
      and (p_target is null or (target_org.user_id is not null and target.user_id is not null)) and (
      exists(select 1 from public.organization_role_grants r where r.organization_id=c.organization_id and r.user_id=p_actor and r.role=p_role)
      or exists(select 1 from public.member_role_chapters r
        join public.member_chapter_memberships actor on actor.user_id=r.user_id and actor.chapter_id=r.chapter_id and actor.status='active'
        left join private.chapter_role_scopes scope on scope.user_id=r.user_id and scope.chapter_id=r.chapter_id and scope.role=r.role
        where r.user_id=p_actor and r.chapter_id=c.id and r.role=p_role and (
          scope.user_id is null
          or exists(select 1 from private.chapter_unit_members m where m.unit_id=scope.unit_id and m.chapter_id=c.id and m.user_id=p_target)
          or exists(select 1 from private.chapter_committees committee
            join private.chapter_committee_members m on m.committee_id=committee.id and m.chapter_id=committee.chapter_id
            where committee.id=scope.committee_id and committee.chapter_id=c.id and m.user_id=p_target
              and committee.starts_on<=current_date and (committee.ends_on is null or committee.ends_on>=current_date)
              and (not p_grievance or committee.grievance_access))))));
$function$;
revoke all on function private.actor_role_covers_member(uuid,text,text,uuid,boolean) from public,anon,authenticated,service_role;

create function private.actor_case_scope_and_identity_allowed(p_actor uuid,p_case public.member_cases)
returns boolean language sql stable security definer set search_path = '' as $function$
  -- Existing unscoped, unmarked cases keep their established read cost. CASE
  -- makes the expensive role composition conditional even under SQL planning.
  select coalesce(case when p_case.user_id=p_actor then true
    when not exists(select 1 from private.chapter_role_scopes s where s.user_id=p_actor)
      and not exists(select 1 from private.case_identity_privacy privacy where privacy.case_id=p_case.id) then true
    else (
    (not exists(select 1 from private.chapter_role_scopes s where s.user_id=p_actor)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'steward',p_case.user_id,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'coordinator',p_case.user_id,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'advisor',p_case.user_id,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'admin',p_case.user_id,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'vp',p_case.user_id,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'steward',null,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'coordinator',null,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'advisor',null,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'admin',null,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'vp',null,true))
    -- A separate chapter-wide grant continues to cover retained cases whose
    -- owner no longer has a live membership. Scoped grants never cover null.
    and (not exists(select 1 from private.case_identity_privacy privacy where privacy.case_id=p_case.id)
      or (p_case.steward_user_id=p_actor and (private.actor_role_covers_member(p_actor,p_case.chapter_id,'steward',p_case.user_id,true) or private.actor_role_covers_member(p_actor,p_case.chapter_id,'steward',null,true)))
      or (p_case.coordinator_user_id=p_actor and (private.actor_role_covers_member(p_actor,p_case.chapter_id,'coordinator',p_case.user_id,true) or private.actor_role_covers_member(p_actor,p_case.chapter_id,'coordinator',null,true)))
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'advisor',p_case.user_id,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'admin',p_case.user_id,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'vp',p_case.user_id,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'advisor',null,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'admin',null,true)
      or private.actor_role_covers_member(p_actor,p_case.chapter_id,'vp',null,true))) end,false);
$function$;
revoke all on function private.actor_case_scope_and_identity_allowed(uuid,public.member_cases) from public,anon,authenticated,service_role;

create function private.chapter_grievance_steward_scope(p_chapter text, p_target uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select (select auth.uid()) is not null and private.mfa_satisfied()
    and exists(select 1 from public.chapters c
      join public.organization_memberships om on om.organization_id=c.organization_id and om.user_id=p_target and om.status='active'
      join public.member_chapter_memberships cm on cm.chapter_id=c.id and cm.user_id=p_target and cm.status='active'
      where c.id=p_chapter and c.organization_id=private.current_member_organization()
        and (not private.staff_mfa_required(c.organization_id) or private.has_second_factor((select auth.uid())))
        and (private.has_organization_role(c.organization_id,array['steward'])
          or private.member_has_chapter_role(p_chapter,array['steward'])
          or private.actor_role_covers_member((select auth.uid()),p_chapter,'steward',p_target,true)
          or exists(select 1 from public.member_role_chapters r
            join public.chapters source on source.id=r.chapter_id and source.organization_id=c.organization_id
            join public.member_chapter_memberships m on m.chapter_id=r.chapter_id and m.user_id=r.user_id and m.status='active'
            join private.chapter_access_policies policy on policy.chapter_id=r.chapter_id and policy.steward_breadth='local' and policy.steward_grievances
            where r.user_id=(select auth.uid()) and r.role='steward'
              and private.member_has_chapter_role(r.chapter_id,array['steward']))));
$function$;
revoke all on function private.chapter_grievance_steward_scope(text,uuid) from public, anon, authenticated, service_role;

-- Raw case rows retain the owner, Steward and Coordinator read boundary.
-- Administrative tool/aggregate authority is checked by its own RPC above
-- this shared scope and identity conjunct.
create function private.chapter_case_readable(p_case public.member_cases)
returns boolean language sql stable security definer set search_path = '' as $function$
  select private.mfa_satisfied() and private.member_case_row_visible(p_case)
    and (p_case.user_id=(select auth.uid())
      or (p_case.steward_user_id=(select auth.uid()) and public.member_has_role(array['steward']))
      or public.staff_can_see_user(p_case.user_id,'coordinator')
      or (not p_case.is_restricted
        and coalesce((select policy.steward_grievances from private.chapter_access_policies policy where policy.chapter_id=p_case.chapter_id),true)
        and private.chapter_grievance_steward_scope(p_case.chapter_id,p_case.user_id)));
$function$;
revoke all on function private.chapter_case_readable(public.member_cases) from public,anon,authenticated,service_role;
grant execute on function private.chapter_case_readable(public.member_cases) to authenticated;

-- Visibility grants reads. The existing staff mutation predicate below
-- retains assignments, coordination and oversight as its authority boundary.
create function private.casework_staff_can_read(p_case_id uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select private.casework_staff_can_access(p_case_id)
    or exists(select 1 from public.member_cases c where c.id=p_case_id
      and c.user_id<>(select auth.uid()) and not c.is_restricted
      and c.organization_id=private.current_member_organization()
      and coalesce((select p.steward_grievances from private.chapter_access_policies p where p.chapter_id=c.chapter_id),true)
      and private.chapter_grievance_steward_scope(c.chapter_id,c.user_id)
      and private.member_case_row_visible(c));
$function$;
revoke all on function private.casework_staff_can_read(uuid) from public,anon,authenticated,service_role;
grant execute on function private.casework_staff_can_read(uuid) to authenticated;

-- The definer uses the existing by-id staff authorization oracle. Its owner
-- bypasses table RLS, so this does not recurse through the parent policy.
create function private.chapter_case_staff_readable(p_case public.member_cases)
returns boolean language sql stable security definer set search_path = '' as $function$
  select private.mfa_satisfied() and (p_case.user_id=(select auth.uid())
    or private.casework_staff_can_read(p_case.id));
$function$;
revoke all on function private.chapter_case_staff_readable(public.member_cases) from public, anon, authenticated, service_role;

-- The President's existing overview is a chapter-leadership projection, not
-- an assignment/mutation desk. Keep that authority while composing the new
-- scope and identity rules and the organization's staff-factor requirement.
create function private.chapter_case_leadership_readable(p_case public.member_cases)
returns boolean language sql stable security definer set search_path = '' as $function$
  select private.mfa_satisfied() and not private.member_pin_session_restricted()
    and p_case.organization_id=private.current_member_organization()
    and (not private.staff_mfa_required(p_case.organization_id) or private.has_second_factor((select auth.uid())))
    and (private.member_has_chapter_role(p_case.chapter_id,array['admin','vp'])
      or private.has_organization_role(p_case.organization_id,array['admin','vp']))
    and private.actor_case_scope_and_identity_allowed((select auth.uid()),p_case);
$function$;
revoke all on function private.chapter_case_leadership_readable(public.member_cases) from public,anon,authenticated,service_role;



create function public.set_grievance_identity_private(p_case uuid, p_private boolean)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[p_case]);
declare target public.member_cases%rowtype;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() or private.member_pin_session_restricted() then raise exception 'authentication required' using errcode='42501'; end if;
  select * into target from public.member_cases where id=p_case and steward_user_id=(select auth.uid()) and private.chapter_grievance_steward_scope(chapter_id,user_id) for update;
  if not found or target.steward_user_id is distinct from (select auth.uid())
    or not private.chapter_grievance_steward_scope(target.chapter_id,target.user_id) then
    raise exception 'assigned steward required' using errcode='42501';
  end if;
  if coalesce(p_private,false) then insert into private.case_identity_privacy(case_id) values(p_case) on conflict do nothing;
  else delete from private.case_identity_privacy where case_id=p_case; end if;
  insert into public.member_admin_audit(actor,action,detail) values(auth.uid(),'grievance_identity_visibility_updated',pg_catalog.jsonb_build_object('caseId',p_case,'private',coalesce(p_private,false)));
  return pg_catalog.jsonb_build_object('updated',true);
end;
end;
$function$;
revoke all on function public.set_grievance_identity_private(uuid,boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_grievance_identity_private(uuid,boolean) to authenticated;

create function public.get_grievance_identity_visibility(p_case uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare target public.member_cases%rowtype;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() or private.member_pin_session_restricted() then raise exception 'authentication required' using errcode='42501'; end if;
  select * into target from public.member_cases c where c.id=p_case and private.chapter_case_readable(c);
  if not found then raise exception 'case unavailable' using errcode='42501'; end if;
  return pg_catalog.jsonb_build_object('private',exists(select 1 from private.case_identity_privacy where case_id=p_case),
    'canChange',target.steward_user_id=(select auth.uid()) and private.chapter_grievance_steward_scope(target.chapter_id,target.user_id));
end;
$function$;
revoke all on function public.get_grievance_identity_visibility(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_grievance_identity_visibility(uuid) to authenticated;

-- Raw rows and children remain inaccessible for a sealed identity. The safe
-- list deliberately omits title, body, member, assignments, timestamps and
-- free text; those fields can themselves identify the person.
create function public.list_private_grievance_summaries()
returns jsonb language sql stable security definer set search_path = '' as $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',entry.id,'status',entry.status)),'[]'::jsonb)
  from (
    select c.id,c.status from public.member_cases c
    join private.case_identity_privacy privacy on privacy.case_id=c.id
    where private.mfa_satisfied() and c.organization_id=private.current_member_organization()
      and private.chapter_grievance_steward_scope(c.chapter_id,c.user_id)
      and not c.is_restricted
      and coalesce((select p.steward_grievances from private.chapter_access_policies p where p.chapter_id=c.chapter_id),true)
      and not private.chapter_case_readable(c)
    order by c.id limit 100
  ) entry;
$function$;
revoke all on function public.list_private_grievance_summaries() from public, anon, authenticated, service_role;
grant execute on function public.list_private_grievance_summaries() to authenticated;

create function private.case_scope_and_identity_allowed(p_case public.member_cases)
returns boolean language sql stable security definer set search_path = '' as $function$
  select private.actor_case_scope_and_identity_allowed((select auth.uid()),p_case);
$function$;
revoke all on function private.case_scope_and_identity_allowed(public.member_cases) from public, anon, authenticated, service_role;

-- Keep the established restriction-only contract for callers without a new
-- scope or privacy mark. Existing by-id callers add their own role boundary.
create or replace function private.member_case_row_visible(p_case public.member_cases)
returns boolean language sql stable security definer set search_path = '' as $function$
  select private.case_scope_and_identity_allowed(p_case) and (
    not p_case.is_restricted
    or p_case.user_id = (select auth.uid())
    or (p_case.steward_user_id = (select auth.uid()) and public.member_has_role(array['steward']))
    or p_case.coordinator_user_id = (select auth.uid())
    or private.has_organization_role(p_case.organization_id, array['advisor','admin','vp'])
    or private.casework_actor_has_active_grant(p_case.id));
$function$;
revoke all on function private.member_case_row_visible(public.member_cases) from public, anon, authenticated, service_role;
grant execute on function private.member_case_row_visible(public.member_cases) to authenticated;

create or replace function private.casework_staff_can_access(p_case_id uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists(select 1 from public.member_cases c where c.id=p_case_id
    and c.organization_id is not null and c.chapter_id is not null
    and private.case_scope_and_identity_allowed(c)
    and (
      (private.actor_has_chapter_staff_role((select auth.uid()),c.chapter_id)
        and (c.steward_user_id=(select auth.uid()) or c.coordinator_user_id=(select auth.uid())
          or public.staff_can_see_user(c.user_id,'coordinator')
          or private.has_organization_role(c.organization_id,array['advisor','admin','vp']))
        and (not c.is_restricted or c.steward_user_id=(select auth.uid()) or c.coordinator_user_id=(select auth.uid())
          or private.has_organization_role(c.organization_id,array['advisor','admin','vp'])
          or private.casework_actor_has_active_grant(c.id)))
      or (c.organization_id=private.current_member_organization()
        and private.actor_role_covers_member((select auth.uid()),c.chapter_id,'coordinator',c.user_id,true)
        and (not c.is_restricted or c.coordinator_user_id=(select auth.uid()) or private.casework_actor_has_active_grant(c.id)))
    ));
$function$;
revoke all on function private.casework_staff_can_access(uuid) from public, anon, authenticated, service_role;
grant execute on function private.casework_staff_can_access(uuid) to authenticated;

drop policy member_cases_select on public.member_cases;
create policy member_cases_select on public.member_cases for select to authenticated using (private.chapter_case_readable(member_cases));

-- Existing child predicates all ultimately reach this by-id helper or their
-- visible parent row. A restrictive gate covers the parent even when an old
-- permissive UPDATE/INSERT rule would allow an assigned steward.
create policy chapter_access_scope on public.member_cases as restrictive for all to authenticated
  using (private.chapter_case_readable(member_cases))
  with check (private.chapter_case_readable(member_cases));

-- Notes and attachment metadata follow the same parent read authority as
-- attachment bytes. This adds the leadership-enabled ordinary steward read
-- while private identities, restrictions and container bounds still narrow it.
create policy member_case_updates_scoped_parent on public.member_case_updates for select to authenticated
  using(exists(select 1 from public.member_cases c where c.id=member_case_updates.case_id and private.chapter_case_readable(c)));
create policy member_case_files_scoped_parent on public.member_case_files for select to authenticated
  using(confirmed_at is not null and removal_requested_at is null
    and exists(select 1 from public.member_cases c where c.id=member_case_files.case_id and private.chapter_case_readable(c)));

create function private.chapter_member_readable(p_member uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select p_member=(select auth.uid())
    or public.staff_can_see_user(p_member,'steward')
    or public.staff_can_see_user(p_member,'coordinator')
    or public.staff_can_see_user(p_member,'advisor')
    or public.staff_can_see_user(p_member,'admin')
    or public.staff_can_see_user(p_member,'vp');
$function$;
revoke all on function private.chapter_member_readable(uuid) from public, anon, authenticated, service_role;




























-- GENERATED READERS

CREATE OR REPLACE FUNCTION public.get_advisor_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  caller_org uuid := private.current_member_organization();
  members_covered integer;
  open_cases integer;
  resolved_cases integer;
  overdue_cases integer;
  steward_count integer;
  turnout jsonb;
begin
  if caller is null or not public.member_has_role(array['advisor', 'admin']) then
    raise exception 'advisor role required' using errcode = '42501';
  end if;
  -- A legacy advisor on an ownerless chapter resolves no organization; only a
  -- platform caller is refused, and only platform-owned rows leave the totals.
  if private.organization_is_platform(caller_org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  select r.chapter_id into caller_chapter
  from public.member_roles r
  where r.user_id = caller and r.role in ('advisor', 'admin')
  order by case r.role when 'advisor' then 0 else 1 end
  limit 1;

  select pg_catalog.count(*)
  into members_covered
  from (select access_row.* from public.member_profiles access_row where (private.chapter_member_readable(access_row.id))) p
  where (caller_chapter is null or p.chapter_id = caller_chapter)
    and not private.chapter_belongs_to_platform(p.chapter_id);

  with base as materialized (
    select c.status, c.deadline
    from (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c
    join (select access_row.* from public.member_profiles access_row where (private.chapter_member_readable(access_row.id))) p on p.id = c.user_id
    where (caller_chapter is null or p.chapter_id = caller_chapter)
    and not private.organization_is_platform(c.organization_id)
  )
  select
    pg_catalog.count(*) filter (where b.status = 'active'),
    pg_catalog.count(*) filter (where b.status = 'resolved'),
    pg_catalog.count(*) filter (where b.status = 'active'
      and b.deadline is not null
      and b.deadline < current_date)
  into open_cases, resolved_cases, overdue_cases
  from base b;

  -- An org-wide steward (NULL chapter role row) covers every chapter, so it
  -- counts toward any caller's scope. A role on an ownerless chapter has no
  -- organization to place it, so only union-owned and org-wide rows are
  -- placed by membership.
  select pg_catalog.count(distinct r.user_id)
  into steward_count
  from public.member_roles r
  where r.role = 'steward'
    and not private.chapter_belongs_to_platform(r.chapter_id)
    and (exists (select 1 from public.chapters c
        where c.id = r.chapter_id and c.organization_id is null)
      or exists (select 1 from public.organization_memberships m
        where m.user_id = r.user_id and m.status = 'active' and private.organization_is_union(m.organization_id))
      or not exists (select 1 from public.organization_memberships m
        where m.user_id = r.user_id and m.status = 'active' and private.organization_is_platform(m.organization_id)))
    and (caller_chapter is null or r.chapter_id is null or r.chapter_id = caller_chapter);

  select pg_catalog.jsonb_build_object(
      'title', b.title,
      'totalVotes', v.n,
      'quorumTarget', b.quorum_target)
  into turnout
  from public.member_ballots b
  left join lateral (
    select pg_catalog.count(*) as n
    from public.member_ballot_choices
    where ballot_id = b.id
  ) v on true
  where (b.active = false or b.closes_at < pg_catalog.now())
    and not private.organization_is_platform(b.organization_id)
  order by b.closes_at desc
  limit 1;

  return pg_catalog.jsonb_build_object(
    'membersCovered', members_covered,
    'openGrievances', open_cases,
    'resolvedGrievances', resolved_cases,
    'stewardCount', steward_count,
    'coverageRatio', case when steward_count = 0 then null
      else pg_catalog.round(members_covered::numeric / steward_count) end,
    'resolutionRate', case when open_cases + resolved_cases = 0 then null
      else pg_catalog.round(100.0 * resolved_cases / (open_cases + resolved_cases)) end,
    'turnout', turnout,
    'atRisk', pg_catalog.jsonb_build_object(
      'overdueCases', overdue_cases,
      'unstaffed', steward_count = 0));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_vp_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid;
  caller_chapter text;
  member_count integer;
  new_this_year integer;
  active_grievances integer;
  turnout jsonb;
  attention jsonb;
  upcoming jsonb;
  priorities jsonb;
  trend jsonb;
begin
  if caller is null or not public.member_has_role(array['vp', 'admin']) then
    raise exception 'vp role required' using errcode = '42501';
  end if;

  -- Fail closed: no selected organization or chapter means no tenant to
  -- report on, never a database-wide scan.
  caller_org := private.current_member_organization();
  caller_chapter := private.current_member_chapter();
  if caller_org is null or caller_chapter is null then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if not private.organization_is_union(caller_org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  select
    pg_catalog.count(*),
    pg_catalog.count(*) filter (where p.member_since = pg_catalog.date_part('year', pg_catalog.now())::int)
  into member_count, new_this_year
  from (select access_row.* from public.member_profiles access_row where (private.chapter_member_readable(access_row.id))) p
  where p.chapter_id = caller_chapter;

  select pg_catalog.count(*)
  into active_grievances
  from (select access_row.* from public.member_cases access_row where (private.chapter_case_leadership_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c
  where c.status = 'active'
    and c.organization_id is not null
    and c.chapter_id is not null
    and c.organization_id = caller_org
    and c.chapter_id = caller_chapter;

  select pg_catalog.jsonb_build_object(
      'title', b.title,
      'totalVotes', v.n,
      'quorumTarget', b.quorum_target)
  into turnout
  from public.member_ballots b
  left join lateral (
    select pg_catalog.count(*) as n
    from public.member_ballot_choices
    where ballot_id = b.id
  ) v on true
  where (b.active = false or b.closes_at < pg_catalog.now())
    and b.campaign_state <> 'draft'
    and b.organization_id = caller_org
    and (b.chapter_id is null or b.chapter_id = caller_chapter)
  order by b.closes_at desc
  limit 1;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', s.id,
      'reference', s.reference,
      'title', s.title,
      'step', s.step,
      'deadline', s.deadline,
      'memberName', s.member_name)), '[]'::jsonb)
  into attention
  from (
    select c.id, c.reference, c.title, c.step, c.deadline, p.full_name as member_name
    from (select access_row.* from public.member_cases access_row where (private.chapter_case_leadership_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c
    join (select access_row.* from public.member_profiles access_row where (private.chapter_member_readable(access_row.id))) p on p.id = c.user_id
    where c.status = 'active'
      and c.deadline is not null
      and c.deadline < current_date
      and c.organization_id is not null
      and c.chapter_id is not null
      and c.organization_id = caller_org
      and c.chapter_id = caller_chapter
    order by c.deadline
    limit 6
  ) s;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', e.id,
      'title', e.title,
      'startsAt', e.starts_at,
      'location', e.location,
      'summary', e.summary)), '[]'::jsonb)
  into upcoming
  from (
    select ev.id, ev.title, ev.starts_at, ev.location, ev.summary
    from public.member_events ev
    join public.chapters event_chapter
      on event_chapter.id = ev.chapter_id
     and event_chapter.organization_id = caller_org
    where ev.starts_at >= pg_catalog.now()
      and ev.cancelled_at is null
      and private.member_can_access_event_scope(ev.chapter_id, ev.is_public, ev.is_public_across_agencies)
    order by ev.starts_at
    limit 5
  ) e;

  -- The aggregate-level ORDER BY is the guarantee; the subquery's ORDER BY
  -- only picks WHICH 8 survive the limit.
  select coalesce(pg_catalog.jsonb_agg(x.obj order by x.order_index), '[]'::jsonb)
  into priorities
  from (
    select pg_catalog.jsonb_build_object('id', id, 'title', title, 'kind', 'ballot') as obj, order_index
    from public.member_ballots
    where active = true
      and campaign_state <> 'draft'
      and organization_id = caller_org
      and (chapter_id is null or chapter_id = caller_chapter)
    union all
    select pg_catalog.jsonb_build_object('id', id, 'title', title, 'kind', 'survey'), order_index
    from public.member_surveys
    where active = true
      and campaign_state <> 'draft'
      and organization_id = caller_org
      and (chapter_id is null or chapter_id = caller_chapter)
    order by order_index
    limit 8
  ) x;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'year', y.yr, 'count', y.cumulative) order by y.yr), '[]'::jsonb)
  into trend
  from (
    select g.yr, pg_catalog.sum(g.n) over (order by g.yr) as cumulative
    from (
      select p.member_since as yr, pg_catalog.count(*) as n
      from (select access_row.* from public.member_profiles access_row where (private.chapter_member_readable(access_row.id))) p
      where p.chapter_id = caller_chapter
      group by p.member_since
    ) g
  ) y
  where y.yr >= pg_catalog.date_part('year', pg_catalog.now())::int - 5;

  return pg_catalog.jsonb_build_object(
    'memberCount', member_count,
    'newThisYear', new_this_year,
    'activeGrievances', active_grievances,
    'turnout', turnout,
    'attention', attention,
    'upcomingEvents', upcoming,
    'priorities', priorities,
    'membershipTrend', trend);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.list_vp_case_reviews()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  payload jsonb;
begin
  if caller is null or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role with MFA required' using errcode = '42501';
  end if;

  select r.chapter_id into caller_chapter
  from public.member_roles r
  where r.user_id = caller
    and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  order by r.chapter_id
  limit 1;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'caseId', v.case_id,
    'reviewedAt', v.reviewed_at,
    'reviewedBy', v.reviewed_by,
    'reviewerName', p.full_name,
    'caseReference', c.reference,
    'caseTitle', c.title
  ) order by v.reviewed_at desc), '[]'::jsonb)
  into payload
  from public.member_vp_case_reviews v
  join (select access_row.* from public.member_profiles access_row where (private.chapter_member_readable(access_row.id))) p on p.id = v.reviewed_by
  join (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c on c.id = v.case_id
  where v.chapter_id = caller_chapter;

  return payload;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.list_coordinator_case_audit(p_limit integer DEFAULT 50, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id bigint DEFAULT NULL::bigint, p_kind text DEFAULT NULL::text, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_case_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := private.mi1_require_selected_organization();
  clamped integer;
begin
  if p_kind is not null
     and p_kind <> all (array['case_updated', 'note_added', 'contact_logged', 'outcome_recorded']) then
    raise exception 'unknown coordinator case audit kind' using errcode = '22023';
  end if;
  clamped := private.audit_sink_read_bounds(p_limit, p_before, p_before_id is not null, p_since, p_until);

  return coalesce((
    select pg_catalog.jsonb_agg(page.item order by page.created_at desc, page.id desc)
    from (
      select
        a.created_at,
        a.id,
        pg_catalog.jsonb_build_object(
          'id', a.id,
          'source', 'coordinator_case_audit',
          'organizationId', c.organization_id,
          'chapterId', c.chapter_id,
          'kind', a.action,
          'caseId', a.case_id,
          'entityId', a.case_id,
          'memberUserId', a.user_id,
          'actorUserId', a.actor_id,
          'createdAt', a.created_at
        ) as item
      from public.coordinator_case_audit a
      join (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c on c.id = a.case_id
      where c.organization_id = org
        and (p_case_id is null or a.case_id = p_case_id)
        and (p_kind is null or a.action = p_kind)
        and (p_since is null or a.created_at >= p_since)
        and (p_until is null or a.created_at <= p_until)
        and (p_before is null or (a.created_at, a.id) < (p_before, p_before_id))
        -- Exactly the table's SELECT policy (coordinator_case_audit_select_coordinator).
        and public.staff_can_see_user(a.user_id, 'coordinator')
      order by a.created_at desc, a.id desc
      limit clamped
    ) page
  ), '[]'::jsonb);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.list_member_case_assignment_audit(p_limit integer DEFAULT 50, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id bigint DEFAULT NULL::bigint, p_kind text DEFAULT NULL::text, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_case_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := private.mi1_require_selected_organization();
  clamped integer;
begin
  -- The table stores two assignment images and no kind column. The kind is
  -- derived from whether the case gained, changed, or lost its staff, so the
  -- filter never needs the images themselves to reach the caller.
  if p_kind is not null
     and p_kind <> all (array['assigned', 'reassigned', 'unassigned']) then
    raise exception 'unknown case assignment audit kind' using errcode = '22023';
  end if;
  clamped := private.audit_sink_read_bounds(p_limit, p_before, p_before_id is not null, p_since, p_until);

  return coalesce((
    select pg_catalog.jsonb_agg(page.item order by page.created_at desc, page.id desc)
    from (
      select
        a.created_at,
        a.id,
        pg_catalog.jsonb_build_object(
          'id', a.id,
          'source', 'member_case_assignment_audit',
          'organizationId', c.organization_id,
          'chapterId', c.chapter_id,
          'kind', derived.kind,
          'caseId', a.case_id,
          'entityId', a.case_id,
          'memberUserId', c.user_id,
          'actorUserId', a.actor_id,
          'createdAt', a.created_at
        ) as item
      from public.member_case_assignment_audit a
      join (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c on c.id = a.case_id
      cross join lateral (values (
        case
          when a.after_assignment->>'stewardUserId' is null
               and a.after_assignment->>'coordinatorUserId' is null then 'unassigned'
          when a.before_assignment->>'stewardUserId' is null
               and a.before_assignment->>'coordinatorUserId' is null then 'assigned'
          else 'reassigned'
        end
      )) as derived(kind)
      where c.organization_id = org
        and (p_case_id is null or a.case_id = p_case_id)
        and (p_kind is null or derived.kind = p_kind)
        and (p_since is null or a.created_at >= p_since)
        and (p_until is null or a.created_at <= p_until)
        and (p_before is null or (a.created_at, a.id) < (p_before, p_before_id))
        -- Exactly the table's SELECT policy (member_case_assignment_audit_select_coordinator)
        -- for rows that have a case; the retained-case clause covers only case-less rows,
        -- which the member_cases join already excludes.
        and public.staff_can_see_user(c.user_id, 'coordinator')
      order by a.created_at desc, a.id desc
      limit clamped
    ) page
  ), '[]'::jsonb);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.list_member_case_assignment_candidates(p_case_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  case_owner uuid;
  case_chapter text;
begin
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['coordinator', 'admin']) then
    raise exception 'coordinator role and MFA required' using errcode = '42501';
  end if;

  select c.user_id, p.chapter_id into case_owner, case_chapter
  from (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c
  join (select access_row.* from public.member_profiles access_row where (private.chapter_member_readable(access_row.id))) p on p.id = c.user_id
  where c.id = p_case_id;
  if not found then raise exception 'case not found' using errcode = 'P0002'; end if;
  if not public.staff_can_see_user(case_owner, 'coordinator') then
    raise exception 'member outside your scope' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', eligible.user_id,
      'fullName', eligible.full_name,
      'roles', eligible.roles
    ) order by eligible.full_name, eligible.user_id)
    from (
      select r.user_id, p.full_name,
             pg_catalog.jsonb_agg(r.role order by r.role) as roles
      from public.member_roles r
      join (select access_row.* from public.member_profiles access_row where (private.chapter_member_readable(access_row.id))) p on p.id = r.user_id
      where r.role in ('steward', 'coordinator')
        and (r.chapter_id is null or r.chapter_id = case_chapter)
      group by r.user_id, p.full_name
      order by p.full_name, r.user_id
      limit 200
    ) eligible
  ), '[]'::jsonb);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_compass_staff_data_context(p_topics text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();
declare
  caller uuid;
  org uuid;
  chapter text;
  topics text[];
  data jsonb;
  part jsonb;
  tally jsonb;
  snapshot jsonb;
  snapshot_read boolean;
begin
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'sign in required' using errcode = '42501';
  end if;
  -- The Compass organization: the quota organization the dispatch gate binds.
  org := private.member_organization_for(caller);
  chapter := private.current_member_chapter();
  if org is null
     or not (
       private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
       or private.actor_has_chapter_staff_role(caller, chapter)
     ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if private.organization_is_platform(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(org, 'features.ai_assistant.enabled')
     or not private.organization_feature_enabled(org, 'features.ai_assistant.staff_data_answers') then
    raise exception 'staff data answers are turned off' using errcode = '55000';
  end if;
  data := '{}'::jsonb;
  snapshot_read := false;

  select coalesce(pg_catalog.array_agg(distinct topic order by topic), array[]::text[]) into topics
  from pg_catalog.unnest(coalesce(p_topics, array[]::text[])) topic;
  if pg_catalog.cardinality(topics) not between 1 and 5
     or not topics <@ array['caseload', 'outcomes', 'membership', 'health', 'bargaining'] then
    raise exception 'topics invalid' using errcode = '22023';
  end if;

  if 'caseload' = any(topics) then
    begin
      select pg_catalog.jsonb_build_object(
        'openByStep', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'step', s.step, 'cases', s.case_count) order by s.case_count desc, s.step), '[]'::jsonb)
          from public.casework_dashboard_open_cases_by_step() s),
        'overdue', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'kind', o.kind, 'deadlines', o.deadline_count, 'cases', o.case_count,
            'oldestDaysOverdue', pg_catalog.floor(extract(epoch from (pg_catalog.now() - o.oldest_due_at)) / 86400.0)::integer
          ) order by o.kind), '[]'::jsonb)
          from public.casework_dashboard_overdue_deadlines() o),
        'dueSoon', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'daysOut', d.days_out, 'deadlines', d.deadline_count, 'cases', d.case_count) order by d.days_out), '[]'::jsonb)
          from public.casework_dashboard_deadlines_due_soon() d),
        'medianDaysPerStep', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'step', m.step, 'medianDays', m.median_days, 'transitions', m.transition_count) order by m.step), '[]'::jsonb)
          from public.casework_dashboard_median_days_per_step() m)
      ) into part;
    exception when insufficient_privilege then
      part := pg_catalog.jsonb_build_object('unavailable', true);
    end;
    data := data || pg_catalog.jsonb_build_object('caseload', part);
  end if;

  if 'outcomes' = any(topics) then
    begin
      part := public.get_coordinator_kpis();
      part := pg_catalog.jsonb_build_object(
        'openCases', part -> 'openCases', 'resolved', part -> 'resolved',
        'resolutionRate', part -> 'resolutionRate', 'inArbitration', part -> 'inArbitration',
        'byStep', part -> 'byStep', 'byArticle', part -> 'byArticle');
      -- Recorded outcomes under get_coordinator_kpis' own two bounds (tenant:
      -- the caller's organization and chapter, or a case the caller holds an
      -- active grant for while staff_can_see_user admits them (20261022171901,
      -- #5748); visibility:
      -- private.casework_staff_can_access per case), reached only after that
      -- coordinator-only call succeeded. The bucket is the closed outcome
      -- vocabulary, never the summary.
      select coalesce(pg_catalog.jsonb_object_agg(counted.outcome, counted.total), '{}'::jsonb) into tally
      from (
        select outcome_row.outcome, pg_catalog.count(*) as total
        from public.member_case_outcomes outcome_row
        join (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) case_row on case_row.id = outcome_row.case_id
        where (
            (case_row.organization_id = org and case_row.chapter_id = chapter)
            or (
              case_row.id in (
                select g.case_id
                from public.casework_access_grants g
                where g.grantee_user_id = (select auth.uid())
                  and g.revoked_at is null
              )
              and public.staff_can_see_user(case_row.user_id, 'coordinator')
            )
          )
          and private.casework_staff_can_read(case_row.id)
          and not private.organization_is_platform(case_row.organization_id)
        group by outcome_row.outcome
      ) counted;
      part := part || pg_catalog.jsonb_build_object('byOutcome', tally);
    exception when insufficient_privilege then
      part := pg_catalog.jsonb_build_object('unavailable', true);
    end;
    data := data || pg_catalog.jsonb_build_object('outcomes', part);
  end if;

  if 'membership' = any(topics) or 'health' = any(topics) then
    begin
      snapshot := public.get_organization_analytics_snapshot();
      snapshot_read := (snapshot ->> 'organizationId')::uuid is not distinct from org;
    exception when others then
      snapshot_read := false;
    end;
  end if;

  if 'membership' = any(topics) then
    data := data || pg_catalog.jsonb_build_object('membership', case when snapshot_read then
      pg_catalog.jsonb_build_object(
        'privacyThreshold', snapshot -> 'privacyThreshold',
        'chapters', snapshot -> 'chapters',
        'usageWindows', snapshot -> 'usageWindows')
      else pg_catalog.jsonb_build_object('unavailable', true) end);
  end if;

  if 'health' = any(topics) then
    begin
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'chapterId', item ->> 'chapterId', 'label', item ->> 'chapterName',
          'memberCount', item -> 'memberCount', 'score', item -> 'score',
          'drivers', item -> 'drivers',
          'trend', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'measuredOn', point ->> 'measuredOn', 'score', point -> 'score')), '[]'::jsonb)
            from pg_catalog.jsonb_array_elements(coalesce(item -> 'trend', '[]'::jsonb)) point)
        )), '[]'::jsonb) into part
      from pg_catalog.jsonb_array_elements(coalesce(public.get_chapter_health_portfolio(), '[]'::jsonb)) item
      join public.chapters chapter on chapter.id = item ->> 'chapterId' and chapter.organization_id = org;
    exception when insufficient_privilege then
      part := null;
    end;
    data := data || pg_catalog.jsonb_build_object('health', pg_catalog.jsonb_build_object(
      'privacyThreshold', case when snapshot_read then snapshot -> 'privacyThreshold' else null end,
      'chapters', coalesce(part, '[]'::jsonb),
      'series', case when snapshot_read then snapshot -> 'series' else '[]'::jsonb end,
      'chapterLabels', case when snapshot_read then (
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', chapter_row ->> 'id', 'label', chapter_row ->> 'label')), '[]'::jsonb)
        from pg_catalog.jsonb_array_elements(coalesce(snapshot -> 'chapters', '[]'::jsonb)) chapter_row
      ) else '[]'::jsonb end,
      'engagementCounts', case when snapshot_read then snapshot -> 'engagementCounts' else '[]'::jsonb end,
      'unavailable', part is null and not snapshot_read));
  end if;

  if 'bargaining' = any(topics) then
    -- Status counts over the workspaces the caller could read: the
    -- casework_bargaining_*_staff policy predicate (chapter staff of the
    -- workspace's chapter), applied explicitly. Titles and bodies are never read.
    select pg_catalog.jsonb_build_object(
      'workspacesByStatus', coalesce((
        select pg_catalog.jsonb_object_agg(counted.status, counted.total)
        from (
          select workspace.status, pg_catalog.count(*) as total
          from public.casework_bargaining_workspaces workspace
          where workspace.organization_id = org
            and private.member_has_chapter_role(workspace.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
          group by workspace.status
        ) counted), '{}'::jsonb),
      'proposalsBySideAndStatus', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'side', counted.side, 'status', counted.status, 'proposals', counted.total)
          order by counted.side, counted.status)
        from (
          select proposal.side, proposal.status, pg_catalog.count(*) as total
          from public.casework_bargaining_proposals proposal
          join public.casework_bargaining_workspaces workspace
            on workspace.id = proposal.workspace_id and workspace.organization_id = proposal.organization_id
          where proposal.organization_id = org
            and private.member_has_chapter_role(workspace.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
          group by proposal.side, proposal.status
        ) counted), '[]'::jsonb),
      'responsesDueWithin7Days', (
        select pg_catalog.count(*)
        from public.casework_bargaining_proposals proposal
        join public.casework_bargaining_workspaces workspace
          on workspace.id = proposal.workspace_id and workspace.organization_id = proposal.organization_id
        where proposal.organization_id = org
          and private.member_has_chapter_role(workspace.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
          and proposal.status in ('proposed', 'countered')
          and proposal.response_due_at >= pg_catalog.now()
          and proposal.response_due_at < pg_catalog.now() + interval '7 days'),
      'responsesOverdue', (
        select pg_catalog.count(*)
        from public.casework_bargaining_proposals proposal
        join public.casework_bargaining_workspaces workspace
          on workspace.id = proposal.workspace_id and workspace.organization_id = proposal.organization_id
        where proposal.organization_id = org
          and private.member_has_chapter_role(workspace.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
          and proposal.status in ('proposed', 'countered')
          and proposal.response_due_at < pg_catalog.now())
    ) into part;
    data := data || pg_catalog.jsonb_build_object('bargaining', part);
  end if;

  return pg_catalog.jsonb_build_object('organization_id', org, 'topics', pg_catalog.to_jsonb(topics), 'data', data);
end;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_coordinator_kpis()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  open_cases integer;
  due_week integer;
  in_arb integer;
  resolved_cases integer;
  by_step jsonb;
  by_article jsonb;
begin
  if caller is null or not public.member_has_role(array['coordinator']) then
    raise exception 'coordinator role required' using errcode = '42501';
  end if;
  if private.organization_is_platform(private.current_member_organization()) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  -- Bound 1, TENANT: the caller's own organization and chapter, or a case the
  -- caller holds an active grant for while staff_can_see_user admits them
  -- (20261022053100), copied from
  -- private.casework_dashboard_open_cases (20260917142000) minus its
  -- status = 'active' filter, because `resolved` and resolutionRate need the
  -- resolved half of the same scope.
  -- Bound 2, VISIBILITY: the casework suite's own per-case helper, run over the
  -- tenant-bounded set only.
  -- The CTEs are materialized so both run once per call and the count filters
  -- plus the two grouped tallies read the same set, instead of three
  -- independent scans. Due window is current_date + 6: seven days inclusive of
  -- today (public.list_coordinator_cases mirrors it exactly).
  with tenant as materialized (
    select c.id, c.status, c.step, c.articles, c.deadline
    from public.member_cases c
    where (select private.mfa_satisfied())
      and private.organization_is_union(c.organization_id)
      and c.chapter_id is not null
      and (
        (c.organization_id = (select private.current_member_organization())
          and c.chapter_id = (select private.current_member_chapter()))
        or (
          c.id in (
            select g.case_id
            from public.casework_access_grants g
            where g.grantee_user_id = (select auth.uid())
              and g.revoked_at is null
          )
          and public.staff_can_see_user(c.user_id, 'coordinator')
          and private.casework_staff_can_read(c.id)
        )
      )
  ),
  base as materialized (
    select t.status, t.step, t.articles, t.deadline
    from tenant t
    where private.casework_staff_can_read(t.id)
  )
  select
    pg_catalog.count(*) filter (where b.status = 'active'),
    pg_catalog.count(*) filter (where b.status = 'active'
      and b.deadline is not null
      and b.deadline between current_date and current_date + 6),
    pg_catalog.count(*) filter (where b.status = 'active'
      and (b.step ~* 'arb' or b.step = 'Step 4')),
    pg_catalog.count(*) filter (where b.status = 'resolved'),
    (select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('step', s.step, 'count', s.n) order by s.n desc, s.step), '[]'::jsonb)
     from (
       select step, pg_catalog.count(*) as n
       from base
       where status = 'active'
       group by step
     ) s),
    (select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('articles', a.articles, 'count', a.n) order by a.n desc, a.articles), '[]'::jsonb)
     from (
       select articles, pg_catalog.count(*) as n
       from base
       where status = 'active' and articles <> ''
       group by articles
     ) a)
  into open_cases, due_week, in_arb, resolved_cases, by_step, by_article
  from base b;

  return pg_catalog.jsonb_build_object(
    'openCases', open_cases,
    'dueThisWeek', due_week,
    'inArbitration', in_arb,
    'resolved', resolved_cases,
    'resolutionRate', case when open_cases + resolved_cases = 0 then null
      else pg_catalog.round(100.0 * resolved_cases / (open_cases + resolved_cases)) end,
    'byStep', by_step,
    'byArticle', by_article);
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_case_queue_next_actions(p_selected_hat text, p_limit integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.case_signals_staff_organization(p_selected_hat);
  hat text := pg_catalog.btrim(p_selected_hat);
  today date := (pg_catalog.now() at time zone 'America/New_York')::date;
  lookahead integer;
  critical_days integer;
  high_days integer;
  stale_days integer;
  evidence_days integer;
  weak_below integer;
  bounded integer := greatest(1, least(coalesce(p_limit, 25), 100));
  items jsonb;
begin
  if not (select private.mfa_satisfied()) then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(org, 'features.casework.next_action_queue') then
    return pg_catalog.jsonb_build_object('enabled', false, 'items', '[]'::jsonb,
      'summary', pg_catalog.jsonb_build_object('total', 0, 'urgent', 0, 'missingOwner', 0));
  end if;
  lookahead := private.organization_limit(org, 'limits.casework.deadline_lookahead_days');
  critical_days := private.organization_limit(org, 'limits.casework.deadline_risk_critical_days');
  high_days := private.organization_limit(org, 'limits.casework.deadline_risk_high_days');
  stale_days := private.organization_limit(org, 'limits.casework.stale_contact_days');
  evidence_days := private.organization_limit(org, 'limits.casework.evidence_deadline_days');
  weak_below := private.organization_limit(org, 'limits.casework.weak_strength_threshold');

  with cases as (
    select c.id, c.user_id, c.reference, c.step, c.steward_user_id,
      private.case_signals_next_due(c.id, c.deadline) as next_due
    from (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c
    where c.organization_id = org
      and c.status = 'active'
      and c.user_id <> caller
      and (hat <> 'steward' or c.steward_user_id = caller)
      and private.casework_staff_can_read(c.id)
  ),
  enriched as (
    select cs.*,
      case when cs.next_due is null then null else cs.next_due - today end as due_days,
      exists (
        select 1 from public.member_case_files f
        where f.case_id = cs.id and f.confirmed_at is not null and f.removal_requested_at is null
      ) as has_evidence,
      (
        select a.score from public.casework_strength_analyses a
        where a.case_id = cs.id
        order by a.created_at desc, a.id desc
        limit 1
      ) as strength
    from cases cs
  ),
  members as (
    select e.user_id,
      pg_catalog.count(*) as open_cases,
      (pg_catalog.array_agg(e.id order by e.due_days nulls last, e.reference))[1] as top_case,
      (pg_catalog.array_agg(e.reference order by e.due_days nulls last, e.reference))[1] as top_reference,
      greatest(
        (select pg_catalog.max(n.created_at) from public.member_contact_notes n
          join public.chapters ch on ch.id = n.chapter_id and ch.organization_id = org
          where n.member_user_id = e.user_id),
        (select pg_catalog.max(m.created_at) from public.member_messages m
          join public.member_conversations conversation
            on conversation.id = m.conversation_id and conversation.organization_id = org
          where m.user_id = e.user_id and m.sender_kind = 'steward')
      ) as last_contact
    from enriched e
    group by e.user_id
  ),
  raw_items as (
    -- Deadline risk (workflow-queues.ts:322-361): due within the lookahead,
    -- overdue always included.
    select pg_catalog.jsonb_build_object(
        'id', 'deadline_risk:' || e.id, 'kind', 'deadline_risk',
        'severity', case when e.due_days <= critical_days then 'critical' when e.due_days <= high_days then 'high' else 'medium' end,
        'caseId', e.id, 'reference', e.reference, 'step', e.step, 'memberId', e.user_id,
        'memberName', private.member_support_member_label(e.user_id),
        'dueDate', e.next_due, 'days', e.due_days) as item,
      case when e.due_days <= 0 then 500 + pg_catalog.abs(e.due_days) else 360 - e.due_days end::numeric as score
    from enriched e
    where e.due_days is not null and e.due_days <= lookahead
    union all
    -- Owner gap (unassigned case), for queue owners only.
    select pg_catalog.jsonb_build_object(
        'id', 'missing_owner:' || e.id, 'kind', 'missing_owner', 'severity', 'high',
        'caseId', e.id, 'reference', e.reference, 'step', e.step, 'memberId', e.user_id,
        'memberName', private.member_support_member_label(e.user_id),
        'dueDate', e.next_due, 'days', e.due_days),
      330::numeric
    from enriched e
    where hat <> 'steward' and e.steward_user_id is null
    union all
    -- Stale member contact (workflow-queues.ts:468-541), one item per member.
    select pg_catalog.jsonb_build_object(
        'id', 'stale_contact:' || mb.user_id, 'kind', 'stale_contact', 'severity', 'medium',
        'caseId', mb.top_case, 'reference', mb.top_reference, 'memberId', mb.user_id,
        'memberName', private.member_support_member_label(mb.user_id),
        'openCases', mb.open_cases,
        'lastContactDays', case when mb.last_contact is null then null
          else today - (mb.last_contact at time zone 'America/New_York')::date end),
      210 + coalesce(today - (mb.last_contact at time zone 'America/New_York')::date, stale_days + 1)::numeric / 100
    from members mb
    where mb.last_contact is null
       or today - (mb.last_contact at time zone 'America/New_York')::date > stale_days
    union all
    -- Missing evidence before a deadline (workflow-queues.ts:543-590).
    select pg_catalog.jsonb_build_object(
        'id', 'missing_evidence:' || e.id, 'kind', 'missing_evidence',
        'severity', case when e.due_days <= 0 then 'critical' else 'high' end,
        'caseId', e.id, 'reference', e.reference, 'step', e.step, 'memberId', e.user_id,
        'memberName', private.member_support_member_label(e.user_id),
        'dueDate', e.next_due, 'days', e.due_days),
      case when e.due_days <= 0 then 440 + least(pg_catalog.abs(e.due_days), 9) else 348 - e.due_days end::numeric
    from enriched e
    where e.due_days is not null and e.due_days <= evidence_days and not e.has_evidence
    union all
    -- Weak case strength (workflow-queues.ts:603-645): scored cases only.
    select pg_catalog.jsonb_build_object(
        'id', 'weak_strength:' || e.id, 'kind', 'weak_strength',
        'severity', case when e.strength < weak_below / 2.0 then 'high' else 'medium' end,
        'caseId', e.id, 'reference', e.reference, 'step', e.step, 'memberId', e.user_id,
        'memberName', private.member_support_member_label(e.user_id),
        'dueDate', e.next_due, 'days', e.due_days, 'strength', e.strength),
      200 + greatest(0, weak_below - e.strength)::numeric / 100
    from enriched e
    where e.strength is not null and e.strength < weak_below
  ),
  ranked as (
    select r.item, r.score,
      case r.item ->> 'severity' when 'critical' then 4 when 'high' then 3 when 'medium' then 2 else 1 end as severity_rank
    from raw_items r
  )
  select pg_catalog.jsonb_build_object(
    'enabled', true,
    'items', coalesce((
      select pg_catalog.jsonb_agg(top.item order by top.score desc, top.severity_rank desc, top.item ->> 'dueDate' nulls last, top.item ->> 'id')
      from (select * from ranked order by score desc, severity_rank desc, item ->> 'dueDate' nulls last, item ->> 'id' limit bounded) top
    ), '[]'::jsonb),
    'summary', pg_catalog.jsonb_build_object(
      'total', (select pg_catalog.count(*) from ranked),
      'urgent', (select pg_catalog.count(*) from ranked where severity_rank >= 3),
      'missingOwner', (select pg_catalog.count(*) from ranked where item ->> 'kind' = 'missing_owner'),
      'staleContact', (select pg_catalog.count(*) from ranked where item ->> 'kind' = 'stale_contact'),
      'missingEvidence', (select pg_catalog.count(*) from ranked where item ->> 'kind' = 'missing_evidence'),
      'weakStrength', (select pg_catalog.count(*) from ranked where item ->> 'kind' = 'weak_strength')
    ),
    'settings', pg_catalog.jsonb_build_object('staleContactDays', stale_days, 'evidenceDays', evidence_days, 'weakStrengthBelow', weak_below)
  ) into items;
  return items;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.casework_dashboard_median_days_per_step()
 RETURNS TABLE(step text, median_days numeric, transition_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.casework_dashboard_require_staff();
  return query
  with tenant as (
    select distinct transition.case_id
    from public.casework_step_transitions transition
    where transition.created_at >= pg_catalog.now() - interval '90 days'
      and (
        (transition.organization_id = (select private.current_member_organization())
          and transition.chapter_id = (select private.current_member_chapter()))
        or (
          transition.case_id in (
            select g.case_id
            from public.casework_access_grants g
            where g.grantee_user_id = (select auth.uid())
              and g.revoked_at is null
          )
          and public.staff_can_see_user((select c.user_id from (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c where c.id = transition.case_id), 'coordinator')
        )
      )
  ),
  visible as (
    select tenant.case_id
    from tenant
    where private.casework_staff_can_read(tenant.case_id)
      and not private.organization_is_platform(
        (select c.organization_id from (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c where c.id = tenant.case_id))
  ),
  history as (
    select
      transition.case_id,
      transition.from_step,
      transition.created_at,
      lag(transition.created_at) over (
        partition by transition.case_id
        order by transition.created_at, transition.id
      ) as entered_at
    from public.casework_step_transitions transition
    join visible on visible.case_id = transition.case_id
  ),
  measured as (
    select
      history.from_step,
      extract(epoch from (
        history.created_at - coalesce(history.entered_at, opened.created_at)
      )) / 86400.0 as days_in_step
    from history
    join (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) opened on opened.id = history.case_id
    where history.created_at >= pg_catalog.now() - interval '90 days'
  )
  select
    measured.from_step,
    pg_catalog.round(
      (pg_catalog.percentile_cont(0.5) within group (order by measured.days_in_step))::numeric,
      2
    ),
    pg_catalog.count(*)
  from measured
  group by measured.from_step
  order by pg_catalog.count(*) desc, measured.from_step asc;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_organization_derived_graph(p_selected_hat text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := private.mi1_require_selected_organization();
  derived_on boolean;
  progress_on boolean;
  floor_size integer;
  edges jsonb := '[]'::jsonb;
  readiness jsonb := '[]'::jsonb;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  -- Same hats as get_organization_intelligence_snapshot.
  if p_selected_hat not in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
     or not private.has_organization_role(org, array[p_selected_hat]) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  derived_on := private.organization_feature_enabled(org, 'features.intelligence.neuro_map_derived_graph');
  progress_on := private.organization_feature_enabled(org, 'features.intelligence.neuro_map_auto_progress');
  floor_size := greatest(5, coalesce(private.organization_limit(org, 'limits.intelligence.neuro_map_topic_min_members'), 5));

  if derived_on then
    with visible_cases as (
      select c.id, c.user_id, c.steward_user_id, c.coordinator_user_id, c.case_type, c.articles
      from (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c
      join public.organization_memberships m
        on m.organization_id = org and m.user_id = c.user_id and m.status = 'active'
      where c.organization_id = org
        and c.status = 'active'
        and private.casework_staff_can_read(c.id)
    ),
    represents as (
      select staff_id as source_id, vc.user_id as target_id, pg_catalog.count(*)::integer as cases
      from visible_cases vc
      cross join lateral (values (vc.steward_user_id), (vc.coordinator_user_id)) as staff(staff_id)
      join public.organization_memberships sm
        on sm.organization_id = org and sm.user_id = staff.staff_id and sm.status = 'active'
      where staff.staff_id is not null and staff.staff_id <> vc.user_id
      group by staff_id, vc.user_id
    ),
    concepts as (
      select distinct vc.user_id, concept
      from visible_cases vc
      cross join lateral pg_catalog.unnest(
        array[pg_catalog.lower(pg_catalog.btrim(coalesce(vc.case_type, '')))] || private.neuro_map_article_concepts(vc.articles)
      ) as concept
      where concept <> '' and concept <> 'other'
    ),
    bounded_concepts as (
      select concept from concepts group by concept having pg_catalog.count(*) between 2 and 12
    ),
    shares as (
      select least(a.user_id, b.user_id) as source_id, greatest(a.user_id, b.user_id) as target_id,
        pg_catalog.count(distinct a.concept)::integer as shared
      from concepts a
      join concepts b on b.concept = a.concept and a.user_id < b.user_id
      join bounded_concepts bc on bc.concept = a.concept
      group by 1, 2
    ),
    all_edges as (
      select 'represents' as kind, r.source_id, r.target_id, least(5, r.cases) as strength from represents r
      union all
      select 'shares_issue', s.source_id, s.target_id, least(5, s.shared) from shares s
    )
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', 'derived:' || e.kind || ':' || e.source_id || ':' || e.target_id,
      'kind', e.kind, 'sourceId', e.source_id, 'targetId', e.target_id, 'strength', e.strength
    ) order by e.kind, e.strength desc, e.source_id, e.target_id), '[]'::jsonb)
    into edges
    from (select * from all_edges order by kind, strength desc, source_id, target_id limit 500) e;
  end if;

  if progress_on then
    with lesson_progress as (
      select l.id as lesson_id, l.label, l.order_index,
        case
          when pg_catalog.jsonb_array_length(l.steps) > 0
            and pg_catalog.cardinality(p.completed_steps) >= pg_catalog.jsonb_array_length(l.steps) then 'ready'
          when pg_catalog.jsonb_array_length(l.steps) > 0
            and pg_catalog.cardinality(p.completed_steps) * 2 >= pg_catalog.jsonb_array_length(l.steps) then 'developing'
          else 'introduced' end as state
      from public.member_rights_progress p
      join public.member_rights_lessons l on l.id = p.lesson_id
      join public.organization_memberships m
        on m.organization_id = org and m.user_id = p.user_id and m.status = 'active'
    ),
    per_lesson as (
      select lesson_id, label, order_index,
        pg_catalog.count(*)::integer as members,
        pg_catalog.count(*) filter (where state = 'introduced')::integer as introduced,
        pg_catalog.count(*) filter (where state = 'developing')::integer as developing,
        pg_catalog.count(*) filter (where state = 'ready')::integer as ready
      from lesson_progress
      group by lesson_id, label, order_index
      having pg_catalog.count(*) >= floor_size
    )
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'topicKey', 'rights-' || pg_catalog.left(pg_catalog.md5(pl.lesson_id), 12),
      'topicLabel', pl.label,
      'members', pl.members, 'introduced', pl.introduced, 'developing', pl.developing, 'ready', pl.ready
    ) order by pl.order_index, pl.label), '[]'::jsonb)
    into readiness
    from per_lesson pl;
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'derivedEnabled', derived_on,
    'autoProgressEnabled', progress_on,
    'edges', edges,
    'topicReadiness', readiness
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_organization_analytics_snapshot()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph_read();
  perform private.member_pin_require_full_session();
  if not private.organization_is_union(private.mi1_require_selected_organization()) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
declare
  org uuid := private.mi1_require_selected_organization();
  generated timestamptz := pg_catalog.now();
  period_end timestamptz := pg_catalog.date_trunc('month', generated);
  period_start timestamptz := pg_catalog.date_trunc('month', generated) - interval '6 months';
  privacy_threshold integer := private.organization_limit(org, 'limits.analytics.anonymity_floor');
  attendance_start timestamptz := generated - interval '180 days';
  result jsonb;
  snapshot_id uuid := extensions.gen_random_uuid();
  published_rows integer;
  withheld_rows integer;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  result := pg_catalog.jsonb_build_object(
    'organizationId', org,
    'generatedAt', generated,
    'privacyThreshold', privacy_threshold,
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'label', c.name,
        'memberCount', case when member_totals.value >= privacy_threshold
          then (pg_catalog.floor(member_totals.value / 5.0) * 5)::integer else null end,
        'memberCountSuppressed', member_totals.value < privacy_threshold,
        'stewardCount', case when steward_totals.value >= privacy_threshold
          and member_totals.value - steward_totals.value >= privacy_threshold
          then (pg_catalog.floor(steward_totals.value / 5.0) * 5)::integer else null end,
        'stewardCountSuppressed', steward_totals.value < privacy_threshold
          or member_totals.value - steward_totals.value < privacy_threshold
      ) order by c.name, c.id)
      from public.chapters c
      cross join lateral (
        select pg_catalog.count(*) as value from public.member_chapter_memberships m
        where m.chapter_id = c.id and m.status = 'active'
      ) member_totals
      cross join lateral (
        select pg_catalog.count(distinct rc.user_id) as value
        from public.member_role_chapters rc
        join public.member_chapter_memberships m
          on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id and m.status = 'active'
        where rc.chapter_id = c.id and rc.role = 'steward'
      ) steward_totals
      where c.organization_id = org
    ), '[]'::jsonb),
    'cases', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'chapterId', counted.chapter_id, 'status', counted.status,
        'step', counted.step_bucket, 'workplaceKey', counted.case_type,
        'count', (pg_catalog.floor(counted.person_count / 5.0) * 5)::integer
      ) order by counted.chapter_id, counted.status, counted.case_type, counted.step_bucket)
      from (
        select cs.chapter_id, cs.status,
          case when cs.step in ('Intake', 'intake') then 0 else 2 end as step_bucket,
          cs.case_type, pg_catalog.count(distinct cs.user_id) as person_count
        from (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) cs
        where cs.organization_id = org and cs.chapter_id is not null
          and cs.created_at >= period_start and cs.created_at < period_end
        group by cs.chapter_id, cs.status, step_bucket, cs.case_type
        having pg_catalog.count(distinct cs.user_id) >= privacy_threshold
      ) counted
    ), '[]'::jsonb),
    -- OPS-UG-ANALYTICS-READ-SIDE-SHIPPED-BUT-NOTHING-IN-PRODUCTION-WRITES-ORGANIZATION-ENGAGEMENT-EVENTS-20260921
    -- (project decision 2026-09-25, AUTHENTICATED PAGE-VIEW PRODUCER):
    -- public.record_workspace_page_view fills organization_page_views and
    -- writes one page_view engagement event per (person, path, minute). A
    -- (path, hat, day) total is published, rounded down to 5, only when it is
    -- itself at least privacy_threshold and at least privacy_threshold
    -- distinct people viewed that path that day (the page_view events carry
    -- the path before '|'), so a request total never stands in for a small
    -- person cohort.
    'usageViews', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'path', v.path, 'hat', v.hat, 'day', v.day,
        'count', (pg_catalog.floor(v.view_count / 5.0) * 5)::integer
      ) order by v.day, v.path, v.hat)
      from public.organization_page_views v
      where v.organization_id = org
        and v.day > ((generated - interval '30 days') at time zone 'UTC')::date
        and v.day <= (generated at time zone 'UTC')::date
        and v.view_count >= privacy_threshold
        and (
          select pg_catalog.count(distinct e.user_id)
          from public.organization_engagement_events e
          where e.organization_id = org and e.event_type = 'page_view'
            and e.occurred_at >= (v.day::timestamp at time zone 'UTC')
            and e.occurred_at < ((v.day + 1)::timestamp at time zone 'UTC')
            and pg_catalog.split_part(e.source_id, '|', 1) = v.path
        ) >= privacy_threshold
    ), '[]'::jsonb),
    'usageWindows', (
      select pg_catalog.jsonb_build_object(
        'organizationId', org,
        -- Distinct people with any engagement event (page views included) in
        -- the last day / 7 days / 30 days, rounded down to 5. Nested windows
        -- permit complement differencing, so an outer window is published only
        -- when the people it adds over the nearest published inner window also
        -- clear the floor.
        'dau', case when windows.dau_ok then (pg_catalog.floor(windows.dau / 5.0) * 5)::integer else null end,
        'wau', case when windows.wau_ok then (pg_catalog.floor(windows.wau / 5.0) * 5)::integer else null end,
        'mau', case when windows.mau_ok then (pg_catalog.floor(windows.mau / 5.0) * 5)::integer else null end,
        'suppressed', pg_catalog.jsonb_build_object(
          'dau', not windows.dau_ok,
          'wau', not windows.wau_ok,
          'mau', not windows.mau_ok
        )
      ) from (
        select gated.dau, gated.wau, gated.mau, gated.dau_ok, gated.wau_ok,
          gated.mau >= privacy_threshold
            and case
              when gated.wau_ok then gated.mau - gated.wau >= privacy_threshold
              when gated.dau_ok then gated.mau - gated.dau >= privacy_threshold
              else true
            end as mau_ok
        from (
          select counted.dau, counted.wau, counted.mau,
            counted.dau >= privacy_threshold as dau_ok,
            counted.wau >= privacy_threshold
              and (counted.dau < privacy_threshold or counted.wau - counted.dau >= privacy_threshold) as wau_ok
          from (
            select
              pg_catalog.count(distinct user_id) filter (where occurred_at >= generated - interval '1 day') as dau,
              pg_catalog.count(distinct user_id) filter (where occurred_at >= generated - interval '7 days') as wau,
              pg_catalog.count(distinct user_id) filter (where occurred_at >= generated - interval '30 days') as mau
            from public.organization_engagement_events where organization_id = org
          ) counted
        ) gated
      ) windows
    ),
    'series', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'chapterId', c.id,
        'openCases', case when case_totals.value >= privacy_threshold and case_totals.minimum_cell >= privacy_threshold
          then (pg_catalog.floor(case_totals.value / 5.0) * 5)::integer else null end,
        'openCasesSuppressed', case_totals.value < privacy_threshold or case_totals.minimum_cell < privacy_threshold,
        -- Share of recorded roster slots marked present over 180 days; guests
        -- are not on the roster. Published only when both the attending and
        -- the non-attending cohorts clear the person floor, so the rate cannot
        -- disclose a small absent cohort by complement.
        'attendanceRate', case when attendance_totals.present_people >= privacy_threshold
          and attendance_totals.missed_people >= privacy_threshold
          and attendance_totals.roster_rows > 0
          then pg_catalog.round(100.0 * attendance_totals.present_rows / attendance_totals.roster_rows, 0)
          else null end,
        -- Mean per-member engagement score (the client taxonomy's caps and
        -- weights, 180 days) over the chapter's active members.
        'engagementMean', case when engagement_totals.members >= privacy_threshold
          then pg_catalog.round(engagement_totals.mean_score, 1) else null end,
        -- Page-view totals are not person-level, so chapter portal use is the
        -- rounded 30-day distinct-person cohort of active members seen online.
        'usageViews', case when usage_totals.value >= privacy_threshold
          then (pg_catalog.floor(usage_totals.value / 5.0) * 5)::integer else null end
      ) order by c.id)
      from public.chapters c
      cross join lateral (
        select totals.value, minima.minimum_cell
        from (
          select pg_catalog.count(distinct cs.user_id) as value
          from (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) cs
          where cs.organization_id = org and cs.chapter_id = c.id and cs.status = 'active'
            and cs.created_at >= period_start and cs.created_at < period_end
        ) totals
        cross join (
          select coalesce(pg_catalog.min(cell.cell_people), 0) as minimum_cell
          from (
            select pg_catalog.count(distinct cs.user_id) as cell_people
            from (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) cs
            where cs.organization_id = org and cs.chapter_id = c.id and cs.status = 'active'
              and cs.created_at >= period_start and cs.created_at < period_end
            group by cs.case_type, case when cs.step in ('Intake', 'intake') then 0 else 2 end
          ) cell
        ) minima
      ) case_totals
      cross join lateral (
        select
          pg_catalog.count(distinct ma.user_id) filter (where ma.attendance_status = 'present') as present_people,
          pg_catalog.count(distinct ma.user_id) filter (where ma.attendance_status <> 'present') as missed_people,
          pg_catalog.count(*) as roster_rows,
          pg_catalog.count(*) filter (where ma.attendance_status = 'present') as present_rows
        from public.meeting_attendance ma
        join public.chapter_records r on r.id = ma.record_id and r.chapter_id = ma.chapter_id
        where ma.chapter_id = c.id
          and ma.attendance_status in ('present', 'absent', 'excused')
          and r.lifecycle_status <> 'archived'
          and r.occurred_at >= attendance_start and r.occurred_at <= generated
      ) attendance_totals
      cross join lateral (
        select pg_catalog.count(*) as members,
          coalesce(pg_catalog.avg(coalesce(scored.score, 0)), 0) as mean_score
        from public.member_chapter_memberships m
        left join (
          select per_type.user_id,
            least(100, pg_catalog.sum(least(per_type.event_count::numeric / weights.cap, 1) * weights.weight)) as score
          from (
            select e.user_id, e.event_type, pg_catalog.count(*) as event_count
            from public.organization_engagement_events e
            where e.organization_id = org and e.chapter_id = c.id
              and e.occurred_at >= generated - interval '180 days'
            group by e.user_id, e.event_type
          ) per_type
          join (values
            ('meeting_check_in', 10, 30),
            ('qa_contribution', 15, 25),
            ('poll_vote', 5, 10),
            ('survey_response', 3, 10),
            ('event_rsvp', 8, 15),
            ('authorized_contact', 5, 10)
          ) as weights(event_type, cap, weight) on weights.event_type = per_type.event_type
          group by per_type.user_id
        ) scored on scored.user_id = m.user_id
        where m.chapter_id = c.id and m.status = 'active'
      ) engagement_totals
      cross join lateral (
        select pg_catalog.count(distinct p.user_id) as value
        from public.member_presence p
        join public.member_chapter_memberships m
          on m.user_id = p.user_id and m.chapter_id = c.id and m.status = 'active'
        where p.organization_id = org and p.last_seen_at >= generated - interval '30 days'
      ) usage_totals
      where c.organization_id = org
    ), '[]'::jsonb),
    'heatmapPoints', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'kind', 'grievance', 'rowKey', counted.chapter_id,
        'colKey', counted.case_type,
        'count', (pg_catalog.floor(counted.person_count / 5.0) * 5)::integer
      ) order by counted.chapter_id, counted.case_type)
      from (
        with scoped as (
          select cs.user_id, cs.chapter_id, cs.case_type, cs.status,
            case when cs.step in ('Intake', 'intake') then 0 else 2 end as step_bucket
          from (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) cs
          where cs.organization_id = org and cs.chapter_id is not null
            and cs.created_at >= period_start and cs.created_at < period_end
        ), totals as (
          select scoped.chapter_id, scoped.case_type,
            pg_catalog.count(distinct scoped.user_id) as person_count
          from scoped group by scoped.chapter_id, scoped.case_type
        ), minima as (
          select cells.chapter_id, cells.case_type, pg_catalog.min(cells.cell_people) as minimum_cell
          from (
            select scoped.chapter_id, scoped.case_type, scoped.status, scoped.step_bucket,
              pg_catalog.count(distinct scoped.user_id) as cell_people
            from scoped
            group by scoped.chapter_id, scoped.case_type, scoped.status, scoped.step_bucket
          ) cells
          group by cells.chapter_id, cells.case_type
        )
        select totals.chapter_id, totals.case_type, totals.person_count
        from totals join minima using (chapter_id, case_type)
        where totals.person_count >= privacy_threshold and minima.minimum_cell >= privacy_threshold
      ) counted
    ), '[]'::jsonb),
    'engagementCounts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'chapterId', counted.chapter_id,
        'eventType', counted.event_type,
        'count', (pg_catalog.floor(counted.person_count / 5.0) * 5)::integer
      ) order by counted.chapter_id, counted.event_type)
      from (
        select e.chapter_id, e.event_type, pg_catalog.count(distinct e.user_id) as person_count
        from public.organization_engagement_events e
        where e.organization_id = org
          and e.event_type <> 'page_view'
          and e.occurred_at >= generated - interval '180 days'
        group by e.chapter_id, e.event_type
        having pg_catalog.count(distinct e.user_id) >= privacy_threshold
      ) counted
    ), '[]'::jsonb),
    'engagementHistogram', pg_catalog.jsonb_build_object(
      'organizationId', org, 'privacyThreshold', privacy_threshold
    ),
    -- One row per recorded meeting in the last 180 days (newest 200). Counts
    -- are distinct people (one attendance row per record and member), rounded
    -- down to 5 and withheld below the person floor. The roster (rsvpGoing) is
    -- published only when the non-attending cohort also clears the floor, so
    -- rsvpGoing minus checkIns cannot disclose a small absent cohort.
    'attendanceEvents', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'id', counted.record_id, 'chapterId', counted.chapter_id,
        'startsAt', counted.occurred_at,
        'checkIns', case when counted.present_people >= privacy_threshold
          then (pg_catalog.floor(counted.present_people / 5.0) * 5)::integer else null end,
        'rsvpGoing', case when counted.present_people >= privacy_threshold
          and counted.roster_people - counted.present_people >= privacy_threshold
          then (pg_catalog.floor(counted.roster_people / 5.0) * 5)::integer else null end
      ) order by counted.occurred_at desc, counted.record_id)
      from (
        select r.id as record_id, r.chapter_id, r.occurred_at,
          pg_catalog.count(*) filter (where ma.attendance_status = 'present') as present_people,
          pg_catalog.count(*) filter (where ma.attendance_status in ('present', 'absent', 'excused')) as roster_people
        from public.chapter_records r
        join public.chapters c on c.id = r.chapter_id and c.organization_id = org
        join public.meeting_attendance ma on ma.record_id = r.id and ma.chapter_id = r.chapter_id
        where r.lifecycle_status <> 'archived'
          and r.occurred_at >= attendance_start and r.occurred_at <= generated
        group by r.id, r.chapter_id, r.occurred_at
        order by r.occurred_at desc, r.id
        limit 200
      ) counted
    ), '[]'::jsonb),
    'attendanceCohorts', pg_catalog.jsonb_build_object(
      'organizationId', org, 'firstTime', null, 'repeat', null, 'suppressed', true
    )
  );
  -- Server-derived export counts for this issued snapshot: every published
  -- row, and the rows that carry at least one withheld (null) measure.
  select pg_catalog.count(*)::integer,
    (pg_catalog.count(*) filter (where exists (
      select 1 from pg_catalog.jsonb_each(published.value) field
      where field.value = 'null'::jsonb
    )))::integer
  into published_rows, withheld_rows
  from pg_catalog.jsonb_array_elements(
    (result -> 'chapters') || (result -> 'cases') || (result -> 'series')
      || (result -> 'heatmapPoints') || (result -> 'engagementCounts')
      || (result -> 'attendanceEvents')
  ) published;
  result := result || pg_catalog.jsonb_build_object('snapshotId', snapshot_id);
  perform private.mi1_write_tenant_audit(org, 'analytics_snapshot_read', pg_catalog.jsonb_build_object(
    'organizationId', org, 'surface', 'organization_analytics_snapshot',
    'entityId', snapshot_id, 'rowCount', published_rows, 'suppressedCount', withheld_rows
  ));
  return result;
end;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_staff_roster()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  caller_chapter text := private.current_member_chapter();
  caller_org_wide boolean := private.has_organization_role(
    caller_org, array['admin', 'coordinator', 'advisor', 'vp']
  );
begin
  if caller is null or caller_org is null or caller_chapter is null
     or not (
       caller_org_wide
       or private.member_has_chapter_role(
         caller_chapter, array['admin', 'coordinator', 'advisor', 'vp']
       )
     ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', s.id,
      'fullName', s.full_name,
      'initials', s.initials,
      'memberSince', s.member_since,
      'chapterId', s.chapter_id,
      'chapterName', s.chapter_name,
      'roles', s.roles
    ) order by s.full_name, s.id)
    from (
      select p.id, p.full_name, p.initials, p.member_since,
        located.chapter_id, located.chapter_name,
        private.organization_member_roles(
          p.id, caller_org, case when caller_org_wide then null else caller_chapter end
        ) as roles
      from (select access_row.* from public.member_profiles access_row where (private.chapter_member_readable(access_row.id))) p
      join public.organization_memberships om
        on om.user_id = p.id
       and om.organization_id = caller_org
       and om.status = 'active'
      join lateral (
        select c.id as chapter_id, c.name as chapter_name
        from public.member_chapter_memberships cm
        join public.chapters c
          on c.id = cm.chapter_id
         and c.organization_id = caller_org
        where cm.user_id = p.id
          and cm.status = 'active'
          and (caller_org_wide or c.id = caller_chapter)
        order by (c.id = p.chapter_id) desc, c.order_index, c.id
        limit 1
      ) located on true
      where private.organization_member_roles(
        p.id, caller_org, case when caller_org_wide then null else caller_chapter end
      ) <> '[]'::jsonb
      order by p.full_name, p.id
      limit 200
    ) s
  ), '[]'::jsonb);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.list_intake_triage_owners()
 RETURNS TABLE(user_id uuid, full_name text, initials text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator']) then
    raise exception 'intake staff role required' using errcode = '42501';
  end if;

  select p.chapter_id into caller_chapter
  from (select access_row.* from public.member_profiles access_row where (private.chapter_member_readable(access_row.id))) p
  where p.id = caller;

  if caller_chapter is null then
    raise exception 'member chapter required' using errcode = '42501';
  end if;

  return query
  select p.id, p.full_name, p.initials
  from (select access_row.* from public.member_profiles access_row where (private.chapter_member_readable(access_row.id))) p
  where p.chapter_id = caller_chapter
    and exists (
      select 1
      from public.member_roles r
      where r.user_id = p.id
        and r.role = any(array['steward', 'coordinator'])
    )
  order by p.full_name, p.id;
end
$function$
;

CREATE OR REPLACE FUNCTION public.create_member_contact_note(p_conversation_id uuid, p_note text, p_source_message_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  conversation public.member_conversations%rowtype;
  member_chapter text;
  new_id uuid;
begin
  if caller is null or not public.member_has_role(array['steward'])
     or not private.can_actor_send_private_message(caller, p_conversation_id, 'steward') then
    raise exception 'conversation unavailable' using errcode = '22023';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_note, ''))) not between 1 and 2000 then
    raise exception 'note must be between 1 and 2000 characters' using errcode = '22023';
  end if;
  select c.* into conversation from public.member_conversations c where c.id = p_conversation_id;
  select p.chapter_id into member_chapter from (select access_row.* from public.member_profiles access_row where (private.chapter_member_readable(access_row.id))) p where p.id = conversation.user_id;
  if member_chapter is null then raise exception 'conversation unavailable' using errcode = '22023'; end if;
  if p_source_message_id is not null and not exists (
    select 1 from public.member_messages m
    where m.id = p_source_message_id and m.conversation_id = conversation.id
  ) then raise exception 'message unavailable' using errcode = '22023'; end if;
  insert into public.member_contact_notes(
    conversation_id, member_user_id, chapter_id, author_id, source_message_id, note)
  values (
    conversation.id, conversation.user_id, member_chapter, caller,
    p_source_message_id, pg_catalog.btrim(p_note))
  returning id into new_id;
  return pg_catalog.jsonb_build_object('id', new_id, 'created', true);
end;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.convert_member_intake_report(p_report_id uuid, p_target text, p_space_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  caller uuid := (select auth.uid());
  report_row public.member_intake_reports%rowtype;
  updated public.member_intake_reports%rowtype;
  target_id uuid;
  attachment_id uuid;
  ref text;
  attempts integer := 0;
  case_type text;
  outcome_owner uuid;
  outcome_owner_name text;
  outcome_owner_is_steward boolean := false;
  outcome_owner_is_coordinator boolean := false;
  task_workstream text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator']) then
    raise exception 'intake staff role required' using errcode = '42501';
  end if;
  if p_target is null or p_target not in ('case', 'task', 'thread') then
    raise exception 'invalid intake conversion target' using errcode = '22023';
  end if;

  select r.* into report_row
  from public.member_intake_reports r
  join (select access_row.* from public.member_profiles access_row where (private.chapter_member_readable(access_row.id))) caller_profile
    on caller_profile.id = caller
   and caller_profile.chapter_id = r.chapter_id
  where r.id = p_report_id
  for update of r;

  if report_row.id is null then
    raise exception 'intake report unavailable' using errcode = '22023';
  end if;
  -- A retried request is safe. Repeating the same target returns the existing
  -- result; changing targets after conversion is refused.
  if pg_catalog.num_nonnulls(report_row.case_id, report_row.task_id, report_row.thread_id) > 0 then
    target_id := case p_target
      when 'case' then report_row.case_id
      when 'task' then report_row.task_id
      when 'thread' then report_row.thread_id
    end;
    if target_id is null then
      raise exception 'intake report already converted to another target' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'report', pg_catalog.to_jsonb(report_row),
      'target', p_target,
      'targetId', target_id
    );
  end if;
  if report_row.status = 'closed' then
    raise exception 'closed intake reports cannot be converted' using errcode = '22023';
  end if;

  if p_target = 'case' then
    case_type := case report_row.category when 'safety' then 'Safety' else 'Other' end;
    outcome_owner := coalesce(report_row.assigned_to, caller);
    select p.full_name,
           exists (select 1 from public.member_roles r where r.user_id = p.id and r.role = 'steward'),
           exists (select 1 from public.member_roles r where r.user_id = p.id and r.role = 'coordinator')
      into outcome_owner_name, outcome_owner_is_steward, outcome_owner_is_coordinator
    from (select access_row.* from public.member_profiles access_row where (private.chapter_member_readable(access_row.id))) p
    where p.id = outcome_owner and p.chapter_id = report_row.chapter_id;
    loop
      attempts := attempts + 1;
      ref := 'GR-' || pg_catalog.to_char(now(), 'YYYY') || '-' || private.member_case_suffix();
      begin
        insert into public.member_cases (
          user_id, reference, title, case_type, articles, step, status,
          steward_user_id, steward_name, coordinator_user_id, coordinator_name, assigned_at
        ) values (
          report_row.reporter_id,
          ref,
          pg_catalog.left('Intake follow-up: ' || report_row.title, 200),
          case_type,
          '',
          'Intake',
          'active',
          case when outcome_owner_is_steward then outcome_owner else null end,
          case when outcome_owner_is_steward then outcome_owner_name else null end,
          case when outcome_owner_is_coordinator then outcome_owner else null end,
          case when outcome_owner_is_coordinator then outcome_owner_name else null end,
          case when outcome_owner_is_steward or outcome_owner_is_coordinator then now() else null end
        ) returning id into target_id;
        exit;
      exception when unique_violation then
        if attempts >= 5 then
          raise exception 'could not allocate a case reference' using errcode = '23505';
        end if;
      end;
    end loop;
  elsif p_target = 'task' then
    -- Standard Task defaults are deliberate. Sensitive report text is not
    -- copied into the card; the attachment is an authorized in-app link whose
    -- destination remains protected by intake RLS.
    -- `General` is preferred while it exists, but workstream rename is a
    -- supported chapter operation. Lock the chosen row so a concurrent rename
    -- cannot invalidate it between selection and the task trigger's check.
    select w.name into task_workstream
    from public.chapter_workstreams w
    where w.chapter_id = report_row.chapter_id
    order by (w.name = 'General') desc, w.name, w.id
    limit 1
    for key share of w;

    if task_workstream is null then
      raise exception 'chapter has no available task workstream' using errcode = '22023';
    end if;

    insert into public.chapter_tasks (
      title, description, status, priority, task_type, workstream,
      assignee_id, start_date, due_date, progress, blocked, milestone, order_index
    ) values (
      'Follow up on intake report', '', 'to_do', 'medium', 'general', task_workstream,
      null, null, null, 0, false, false, 0
    ) returning id into target_id;

    insert into public.chapter_task_attachments (
      task_id, chapter_id, label, record_url, created_by
    ) values (
      target_id,
      report_row.chapter_id,
      'Authorized intake report',
      '/m/organize?intake=' || report_row.id::text,
      caller
    ) returning id into attachment_id;

    insert into public.chapter_task_activity (
      task_id, chapter_id, actor_id, action, to_value
    ) values (
      target_id, report_row.chapter_id, caller, 'attachment_added', attachment_id::text
    );
  else
    if p_space_id is null or not exists (
      select 1
      from public.chapter_spaces s
      where s.id = p_space_id
        and s.chapter_id = report_row.chapter_id
        and s.archived_at is null
        and private.can_read_chapter_space(s)
    ) then
      raise exception 'choose an available same-chapter space' using errcode = '22023';
    end if;

    insert into public.chapter_threads (space_id, title, kind)
    values (p_space_id, 'Intake follow-up', 'intake')
    returning id into target_id;
  end if;

  update public.member_intake_reports r
     set status = 'in_progress',
         assigned_to = coalesce(r.assigned_to, caller),
         case_id = case when p_target = 'case' then target_id else null end,
         task_id = case when p_target = 'task' then target_id else null end,
         thread_id = case when p_target = 'thread' then target_id else null end
   where r.id = report_row.id
  returning r.* into updated;

  return pg_catalog.jsonb_build_object(
    'report', pg_catalog.to_jsonb(updated),
    'target', p_target,
    'targetId', target_id
  );
end;
end;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_staff_engagement_snapshot()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := private.engagement_selected_organization();
  survey_page jsonb;
begin
  perform private.engagement_require_staff(org);
  survey_page := private.staff_engagement_survey_page(org, null, null, 20);
  return pg_catalog.jsonb_build_object(
    'surveys', survey_page -> 'surveys',
    'surveyCounts', survey_page -> 'counts',
    'surveyCursor', survey_page -> 'nextCursor',
    'pulsePrompts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', prompt.id, 'chapterId', prompt.chapter_id,
        'eventKey', prompt.event_key, 'question', prompt.question,
        'options', prompt.options, 'active', prompt.active,
        'cooldownHours', prompt.cooldown_hours,
        'shown', case when private.organization_is_union(prompt.organization_id) then (select pg_catalog.count(*) from public.organization_pulse_events event where event.prompt_id = prompt.id) else null end,
        'responded', case when private.organization_is_union(prompt.organization_id) then (select pg_catalog.count(*) from public.organization_pulse_events event where event.prompt_id = prompt.id and event.state = 'responded') else null end
      ) order by prompt.updated_at desc)
      from public.organization_pulse_prompts prompt where prompt.organization_id = org
    ), '[]'::jsonb),
    'livePolls', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', poll.id, 'title', poll.title, 'description', poll.description,
        'state', poll.state, 'eligibility', poll.eligibility,
        'resultsVisibility', poll.results_visibility,
        'scheduledAt', poll.scheduled_at, 'opensAt', poll.opens_at,
        'closesAt', poll.closes_at, 'closedAt', poll.closed_at,
        'quorumTarget', poll.quorum_target, 'voteCount', case when private.organization_is_union(poll.organization_id) then poll.vote_count else null end,
        'results', case when private.organization_is_union(poll.organization_id) then poll.result_cache else '[]'::jsonb end,
        'options', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', option.id, 'label', option.label, 'sortIndex', option.sort_index
          ) order by option.sort_index)
          from public.organization_live_poll_options option where option.poll_id = poll.id
        ), '[]'::jsonb),
        'attendance', case when private.organization_is_union(poll.organization_id) then pg_catalog.jsonb_build_object(
          'roster', (select pg_catalog.count(*) from public.organization_live_poll_attendance attendance where attendance.poll_id = poll.id and attendance.eligible),
          'rsvpYes', (select pg_catalog.count(*) from public.organization_live_poll_attendance attendance where attendance.poll_id = poll.id and attendance.rsvp = 'yes'),
          'checkedIn', (select pg_catalog.count(*) from public.organization_live_poll_attendance attendance where attendance.poll_id = poll.id and attendance.checked_in_at is not null)
        ) else null end
      ) order by coalesce(poll.opens_at, poll.scheduled_at, poll.created_at) desc)
      from public.organization_live_polls poll where poll.organization_id = org
    ), '[]'::jsonb),
    'delivery', coalesce((
      select pg_catalog.jsonb_object_agg(summary.state, summary.count)
      from (
        select outbox.state, pg_catalog.count(*)::integer as count
        from public.engagement_delivery_outbox outbox
        where outbox.organization_id = org group by outbox.state
      ) summary
    ), '{}'::jsonb),
    'presence', pg_catalog.jsonb_build_object(
      'online', (select pg_catalog.count(*) from public.member_presence presence where presence.organization_id = org and presence.status = 'online' and presence.last_seen_at >= pg_catalog.now() - interval '2 minutes'),
      'away', (select pg_catalog.count(*) from public.member_presence presence where presence.organization_id = org and presence.last_seen_at >= pg_catalog.now() - interval '15 minutes')
    ),
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', chapter.id, 'name', chapter.name
      ) order by chapter.order_index, chapter.name, chapter.id)
      from public.chapters chapter
      where chapter.organization_id = org
    ), '[]'::jsonb),
    'members', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', membership.user_id,
        'name', coalesce(profile.full_name, 'Member'),
        'chapterId', profile.chapter_id
      ) order by coalesce(profile.full_name, ''), membership.user_id)
      from public.organization_memberships membership
      left join (select access_row.* from public.member_profiles access_row where (private.chapter_member_readable(access_row.id))) profile on profile.id = membership.user_id
      where membership.organization_id = org
        and membership.status = 'active' and membership.revoked_at is null
    ), '[]'::jsonb),
    'channels', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'spaceId', space.id, 'name', space.name,
        'chapterId', chapter.id, 'chapterName', chapter.name,
        'postingMode', coalesce(control.posting_mode, 'members'),
        'slowModeSeconds', coalesce(control.slow_mode_seconds, 0),
        'approvalsRequired', coalesce(control.approvals_required, false)
      ) order by chapter.order_index, chapter.name, chapter.id, space.name, space.id)
      from public.chapter_spaces space
      join public.chapters chapter on chapter.id = space.chapter_id and chapter.organization_id = org
      left join public.chapter_space_controls control on control.space_id = space.id
      where space.archived_at is null
    ), '[]'::jsonb)
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.search_member_cases(p_query text, p_limit integer DEFAULT 20)
 RETURNS TABLE(case_id uuid, reference text, title text, case_type text, articles text, step text, status text, deadline date, updated_at timestamp with time zone, rank real, headline text, headline_source text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
begin
  perform private.member_pin_require_full_session();

declare
  v_query tsquery := pg_catalog.websearch_to_tsquery(
    'pg_catalog.english'::pg_catalog.regconfig, coalesce(p_query, ''));
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_actor uuid := (select auth.uid());
begin
  -- An anonymous caller and an empty or stop-word-only query are the same
  -- answer: nothing. Returning early keeps both off the indexes entirely.
  -- Both tests read the request's JWT and the argument, never the database, so
  -- deciding them before the statement below costs the boundary nothing.
  if v_actor is null or pg_catalog.numnode(v_query) = 0 then
    return;
  end if;

  return query
  -- Everything that depends only on the caller, resolved exactly once, in this
  -- statement's snapshot — the same snapshot the row reads below use, which is
  -- what RLS gives the policies. MATERIALIZED is load-bearing: a single-row CTE
  -- referenced once would be inlined and these helpers would run per row again.
  with actor_scope as materialized (
    select
      exists(select 1 from private.chapter_role_scopes s where s.user_id=v_actor) as has_scoped_grants,
      array(
        select ch.id from public.chapters ch
        left join private.chapter_access_policies target_policy on target_policy.chapter_id=ch.id
        where ch.organization_id=private.current_member_organization()
          and coalesce(target_policy.steward_grievances,true)
          and (not private.staff_mfa_required(ch.organization_id) or private.has_second_factor(v_actor))
          and (private.has_organization_role(ch.organization_id,array['steward'])
            or private.member_has_chapter_role(ch.id,array['steward'])
            or exists(select 1 from public.member_role_chapters r
              join public.chapters source on source.id=r.chapter_id and source.organization_id=ch.organization_id
              join public.member_chapter_memberships actor on actor.chapter_id=r.chapter_id and actor.user_id=r.user_id and actor.status='active'
              join private.chapter_access_policies policy on policy.chapter_id=r.chapter_id and policy.steward_breadth='local' and policy.steward_grievances
              where r.user_id=v_actor and r.role='steward' and private.member_has_chapter_role(r.chapter_id,array['steward'])))
      ) as default_steward_chapters,
      -- mfa_assurance, the RESTRICTIVE policy both case tables carry. It ANDs
      -- over every permissive branch, so it gates the whole `visible` CTE.
      (select private.mfa_satisfied()) as mfa_satisfied,
      -- member_cases_select_steward's second conjunct.
      public.member_has_role(array['steward']) as steward_hat,
      -- public.staff_can_see_user(user_id, 'coordinator') as a set of chapters.
      array(select private.staff_visible_chapter_scope('coordinator')) as coordinator_chapters,
      -- private.has_organization_role(organization_id, array['advisor','admin','vp'])
      -- is false unless organization_id is this organization, so the grant test
      -- is a constant and the per-row test is a column comparison.
      (select private.current_mobile_staff_organization()) as staff_organization,
      coalesce((select private.has_organization_role(
        (select private.current_mobile_staff_organization()),
        array['advisor','admin','vp'])), false) as organization_officer,
      -- private.casework_actor_has_active_grant(id), as the set it tests.
      array(
        select g.case_id
        from public.casework_access_grants g
        where g.grantee_user_id = v_actor
          and g.revoked_at is null
      ) as granted_cases
  ),
  -- The candidate list is what makes the two GIN indexes load-bearing, and it
  -- is not a micro-optimisation. `<case document> @@ v_query OR note.body is
  -- not null` sits above a LEFT JOIN LATERAL, so the planner cannot push the
  -- case-side predicate into the scan: driving straight off public.member_cases
  -- reads EVERY row of a table this deployment sizes at ~400k and runs the
  -- lateral once per row. Selecting the candidate ids through the indexes first
  -- and joining back on the primary key returns the same set: the union is a
  -- superset of the final predicate, and every row it adds is re-tested below.
  --
  -- The two expressions in this CTE are the two index expressions verbatim,
  -- down to the argument order and the weight letters, because an expression
  -- index only serves a query whose expression matches it. Changing one without
  -- the other silently returns this statement to a sequential scan;
  -- tests/member-case-search-db.test.js pins the equality and EXPLAINs the
  -- statement cut out of this file.
  --
  -- Which arm matched is carried forward instead of recomputed: `case_hit` IS
  -- `<case document> @@ v_query` for that row, so the WHERE clause below needs
  -- no second evaluation of a four-call tsvector expression, and `note_hit` is
  -- false exactly when no note on the case can match, which turns the note
  -- lateral into a one-time filter for those rows.
  candidate_hits as (
    select c.id as candidate_id, true as case_hit, false as note_hit
    from public.member_cases c
    where (
      pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.reference, '')), 'A')
      || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.title, '')), 'A')
      || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.case_type, '')), 'B')
      || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.articles, '')), 'C')
    ) @@ v_query
    union all
    select u.case_id as candidate_id, false as case_hit, true as note_hit
    from public.member_case_updates u
    where (
      pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(u.body, ''))
    ) @@ v_query
  ),
  candidates as (
    select
      candidate_id,
      pg_catalog.bool_or(case_hit) as case_hit,
      pg_catalog.bool_or(note_hit) as note_hit
    from candidate_hits
    group by candidate_id
  ),
  -- member_cases_select_coordinator, as a set. No function call per row: the
  -- staff scope is the chapter array resolved once above, the organization
  -- officer test is a column comparison against the one organization
  -- private.has_organization_role can accept, and the access grant is an array
  -- membership test. A caller with no coordinator scope produces this set
  -- without reading public.member_profiles at all.
  --
  -- Every actor_scope value below is read through a scalar subquery rather
  -- than a join to the CTE, here and in the `visible` CTE and the note
  -- lateral. That is deliberate and load-bearing: an uncorrelated scalar
  -- subquery becomes an InitPlan the executor runs once, so each scope value
  -- reaches the row predicates as a constant. Joining actor_scope in instead
  -- makes those values ordinary columns, and the planner is then free to drive
  -- this join from public.member_profiles and re-derive the whole set per outer
  -- row: measured at 48,006 primary-key lookups over an 8,001-candidate
  -- corpus, and unbounded on a deployment where the caller's chapter scope
  -- holds thousands of members. The same rewrite turned the note lateral's
  -- author lookup from a rescan of public.member_profiles per note into one
  -- hashed probe for the statement.
  --
  -- `offset 0` is the optimisation fence explained above the same construct in
  -- the `visible` CTE below: it keeps the candidate list the driving relation
  -- so this CTE reads one case row per candidate and never scans the table.
  staff_visible as (
    select k.candidate_id
    from candidates k
    cross join lateral (
      select row_case.user_id, row_case.is_restricted, row_case.coordinator_user_id,
             row_case.organization_id, row_case.id
      from public.member_cases row_case
      where row_case.id = k.candidate_id
      offset 0
    ) c
    join public.member_profiles case_owner on case_owner.id = c.user_id
    where (select s.coordinator_chapters from actor_scope s) <> '{}'::text[]
      and case_owner.chapter_id = any((select s.coordinator_chapters from actor_scope s)::text[])
      and (
        not c.is_restricted
        or c.coordinator_user_id = v_actor
        or (
          c.organization_id is not null
          and c.organization_id = (select s.staff_organization from actor_scope s)
          and (select s.organization_officer from actor_scope s)
        )
        or c.id = any((select s.granted_cases from actor_scope s)::uuid[])
      )
  ),
  -- The mirror itself: mfa_assurance ANDed over the three permissive SELECT
  -- policies, the first two as column tests and the third as a semijoin.
  visible as (
    select
      k.case_hit,
      k.note_hit,
      c.id,
      c.reference,
      c.title,
      c.case_type,
      c.articles,
      c.step,
      c.status,
      c.deadline,
      c.updated_at,
      c.user_id,
      c.steward_user_id
    from candidates k
    cross join lateral (
      select
        row_case as authorization_case,
        row_case.is_restricted, row_case.organization_id, row_case.chapter_id,
        row_case.id,
        row_case.reference,
        row_case.title,
        row_case.case_type,
        row_case.articles,
        row_case.step,
        row_case.status,
        row_case.deadline,
        row_case.updated_at,
        row_case.user_id,
        row_case.steward_user_id
      from public.member_cases row_case
      where row_case.id = k.candidate_id
      -- `offset 0` is the standard PostgreSQL optimisation fence, and it is
      -- load-bearing rather than decorative. Without it the planner flattens
      -- this LATERAL back into an ordinary join, and because a GIN @@
      -- selectivity estimate over a CTE defaults to 200 rows it then prices a
      -- sequential scan of the whole case table plus a hash join below this
      -- primary-key lookup: measured at 79,999 rows removed by filter for a
      -- query with ONE candidate. The fence keeps the candidate list the
      -- driving relation, so the work is one primary-key probe per candidate
      -- and nothing in this function ever reads a case row the two GIN indexes
      -- did not name.
      offset 0
    ) c
    -- Preserve the established set-wise mirror for unscoped, unmarked cases.
    -- Scoped grants and private identities use the full shared row oracle;
    -- the CASE prevents expensive per-case role queries on the ordinary path.
    where (select s.mfa_satisfied from actor_scope s)
      and case when (select s.has_scoped_grants from actor_scope s)
        or exists(select 1 from private.case_identity_privacy privacy where privacy.case_id=c.id)
      then private.chapter_case_readable(c.authorization_case)
      else (
        c.user_id=v_actor
        or (c.steward_user_id=v_actor and (select s.steward_hat from actor_scope s))
        or c.id in (select candidate_id from staff_visible)
        or (not c.is_restricted and c.chapter_id=any((select s.default_steward_chapters from actor_scope s)::text[])
          and exists(select 1 from public.member_chapter_memberships member
            join public.organization_memberships om on om.user_id=member.user_id and om.organization_id=private.current_member_organization() and om.status='active'
            where member.user_id=c.user_id and member.chapter_id=c.chapter_id and member.status='active'))
      ) end
  ),
  scored as (
    select
      c.id,
      c.reference,
      c.title,
      c.case_type,
      c.articles,
      c.step,
      c.status,
      c.deadline,
      c.updated_at,
      note.body as note_body,
      pg_catalog.ts_rank(
        pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.reference, '')), 'A')
        || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.title, '')), 'A')
        || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.case_type, '')), 'B')
        || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.articles, '')), 'C'),
        v_query)
        + coalesce(note.note_rank, 0) * 0.5 as rank_value
    from visible c
    left join lateral (
      select
        n.body,
        pg_catalog.ts_rank(n.note_document, v_query) as note_rank
      from (
        select
          u.body,
          u.user_id,
          u.created_at,
          u.id,
          pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(u.body, '')) as note_document
        from public.member_case_updates u
        where c.note_hit
          and u.case_id = c.id
      ) n
      where n.note_document @@ v_query
        -- The visible parent supplies the same authorization as the scoped-parent notes policy.

      order by note_rank desc, n.created_at desc, n.id
      limit 1
    ) note on true
    -- `case_hit` is the case-document match the candidate CTE already made.
    where c.case_hit or note.body is not null
  ),
  -- Rank and cut FIRST, then build the snippets. ts_headline is by far the most
  -- expensive expression in this function and a projection is evaluated before
  -- the sort, so leaving it in `scored` would have built one snippet per
  -- visible candidate instead of at most p_limit of them.
  ranked as (
    select r.*
    from scored r
    order by r.rank_value desc, r.updated_at desc, r.id
    limit v_limit
  )
  select
    r.id,
    r.reference,
    r.title,
    r.case_type,
    r.articles,
    r.step,
    r.status,
    r.deadline,
    r.updated_at,
    r.rank_value::real,
    pg_catalog.ts_headline(
      'pg_catalog.english'::pg_catalog.regconfig,
      case
        when r.note_body is not null then r.note_body
        when coalesce(r.articles, '') <> '' then r.articles
        else r.title
      end,
      v_query,
      'StartSel="[[",StopSel="]]",MaxFragments=1,MaxWords=28,MinWords=8,ShortWord=2'),
    case
      when r.note_body is not null then 'update'
      when coalesce(r.articles, '') <> '' then 'articles'
      else 'title'
    end
  from ranked r
  order by r.rank_value desc, r.updated_at desc, r.id;
end;

end;
$function$
;

CREATE OR REPLACE FUNCTION public.list_contract_clause_grievance_counts()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();

declare
  org uuid := private.mi1_require_selected_organization();
  v_actor uuid := (select auth.uid());
  staff boolean;
  steward_hat boolean;
  coordinator_chapters text[];
  staff_organization uuid;
  organization_officer boolean;
  granted_cases uuid[];
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- A platform organization's per-article case counts are platform results.
  if private.organization_is_platform(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  -- Same clause visibility as public.list_contract_clauses.
  staff := private.has_organization_role(
    org,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  );

  -- Caller-only inputs of the member_cases SELECT policies, resolved once.
  -- mfa_assurance is already satisfied by the gate above.
  steward_hat := coalesce(public.member_has_role(array['steward']), false);
  coordinator_chapters := array(select private.staff_visible_chapter_scope('coordinator'));
  staff_organization := private.current_mobile_staff_organization();
  organization_officer := coalesce(
    private.has_organization_role(staff_organization, array['advisor', 'admin', 'vp']),
    false
  );
  granted_cases := array(
    select g.case_id
    from public.casework_access_grants g
    where g.grantee_user_id = v_actor
      and g.revoked_at is null
  );

  -- Each visible case's articles are normalized and split into tokens ONCE,
  -- then joined to the caller-visible clause articles on equality. The
  -- 20260925110500 body re-ran the regexp_replace for every (clause, case)
  -- pair as a LIKE join filter, so its cost grew with clauses x cases.
  return coalesce((
    with actor_scope as materialized (
    select
      exists(select 1 from private.chapter_role_scopes s where s.user_id=v_actor) as has_scoped_grants,
      array(
        select ch.id from public.chapters ch
        left join private.chapter_access_policies target_policy on target_policy.chapter_id=ch.id
        where ch.organization_id=org
          and coalesce(target_policy.steward_grievances,true)
          and (not private.staff_mfa_required(ch.organization_id) or private.has_second_factor(v_actor))
          and (private.has_organization_role(ch.organization_id,array['steward'])
            or private.member_has_chapter_role(ch.id,array['steward'])
            or exists(select 1 from public.member_role_chapters r
              join public.chapters source on source.id=r.chapter_id and source.organization_id=ch.organization_id
              join public.member_chapter_memberships actor on actor.chapter_id=r.chapter_id and actor.user_id=r.user_id and actor.status='active'
              join private.chapter_access_policies policy on policy.chapter_id=r.chapter_id and policy.steward_breadth='local' and policy.steward_grievances
              where r.user_id=v_actor and r.role='steward' and private.member_has_chapter_role(r.chapter_id,array['steward'])))
      ) as default_steward_chapters
    ), visible_cases as (
      select cs.id,
             ',' || pg_catalog.regexp_replace(
               pg_catalog.lower(pg_catalog.btrim(cs.articles)),
               '[[:space:]]*[,;/]+[[:space:]]*',
               ',',
               'g'
             ) || ',' as line
      from public.member_cases cs
      left join public.member_profiles case_owner
        on coordinator_chapters <> '{}'::text[]
       and case_owner.id = cs.user_id
      where cs.organization_id = org
        and cs.articles is not null
        and pg_catalog.btrim(cs.articles) <> ''
        and case when (select s.has_scoped_grants from actor_scope s)
          or exists(select 1 from private.case_identity_privacy privacy where privacy.case_id=cs.id)
        then private.chapter_case_readable(cs)
        else (
          cs.user_id = v_actor
          or (cs.steward_user_id = v_actor and steward_hat)
          or (case_owner.chapter_id = any(coordinator_chapters) and (
            not cs.is_restricted or cs.coordinator_user_id = v_actor
            or (cs.organization_id = staff_organization and organization_officer)
            or cs.id = any(granted_cases)))
          or (not cs.is_restricted
            and cs.chapter_id=any((select s.default_steward_chapters from actor_scope s)::text[])
            and exists(select 1 from public.member_chapter_memberships member
              join public.organization_memberships om on om.user_id=member.user_id and om.organization_id=org and om.status='active'
              where member.user_id=cs.user_id and member.chapter_id=cs.chapter_id and member.status='active'))
        ) end

    ),
    case_articles as (
      select v.id as case_id, token.article
      from visible_cases v
      cross join lateral pg_catalog.unnest(
        pg_catalog.string_to_array(pg_catalog.btrim(v.line, ','), ',')
      ) as token(article)
      where token.article <> ''
    ),
    -- Counted per token before the clause join and materialized, so the join
    -- only ever sees distinct tokens: the planner cannot rescan member_cases
    -- (or re-run the regexp) once per clause article when statistics are thin.
    token_counts as materialized (
      select ca.article, pg_catalog.count(distinct ca.case_id)::integer as n
      from case_articles ca
      group by ca.article
    ),
    visible_articles as (
      select distinct pg_catalog.lower(pg_catalog.btrim(c.article)) as article
      from public.contract_clauses c
      where c.organization_id = org
        and (staff or c.status = 'published')
    )
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'article', counts.article,
      'count', counts.n
    ) order by counts.article)
    from (
      select a.article, t.n
      from visible_articles a
      join token_counts t on t.article = a.article
    ) counts
  ), '[]'::jsonb);
end;

end;
$function$;

CREATE OR REPLACE FUNCTION public.list_share_case_destinations(p_limit integer DEFAULT 100)
 RETURNS TABLE(id uuid, user_id uuid, reference text, title text, status text, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();
declare
  v_actor uuid := (select auth.uid());
  v_limit integer := least(greatest(coalesce(p_limit,100),1),100);
begin
  if v_actor is null then return; end if;
  return query
  with actor_scope as materialized (
    select
      -- mfa_assurance, the RESTRICTIVE policy both case tables carry. It ANDs
      -- over every permissive branch, so it gates the whole `visible` CTE.
      (select private.mfa_satisfied()) as mfa_satisfied,
      -- member_cases_select_steward's second conjunct.
      public.member_has_role(array['steward']) as steward_hat,
      -- public.staff_can_see_user(user_id, 'coordinator') as a set of chapters.
      array(select private.staff_visible_chapter_scope('coordinator')) as coordinator_chapters,
      -- private.has_organization_role(organization_id, array['advisor','admin','vp'])
      -- is false unless organization_id is this organization, so the grant test
      -- is a constant and the per-row test is a column comparison.
      (select private.current_mobile_staff_organization()) as staff_organization,
      coalesce((select private.has_organization_role(
        (select private.current_mobile_staff_organization()),
        array['advisor','admin','vp'])), false) as organization_officer,
      -- private.casework_actor_has_active_grant(id), as the set it tests.
      array(
        select g.case_id
        from public.casework_access_grants g
        where g.grantee_user_id = v_actor
          and g.revoked_at is null
      ) as granted_cases
  ),
  staff_visible as (
    select c.id
    from public.member_profiles case_owner
    join (select access_row.* from public.member_cases access_row where (private.chapter_case_readable(access_row))) c on c.user_id = case_owner.id
    where (select s.coordinator_chapters from actor_scope s) <> '{}'::text[]
      and case_owner.chapter_id = any((select s.coordinator_chapters from actor_scope s)::text[])
      and (
        not c.is_restricted or c.coordinator_user_id = v_actor
        or (c.organization_id is not null
          and c.organization_id = (select s.staff_organization from actor_scope s)
          and (select s.organization_officer from actor_scope s))
        or c.id = any((select s.granted_cases from actor_scope s)::uuid[])
      )
  ), visible_ids as (
    select c.id from (select access_row.* from public.member_cases access_row where (private.chapter_case_readable(access_row))) c where private.chapter_case_readable(c)
    union
    select c.id from (select access_row.* from public.member_cases access_row where (private.chapter_case_readable(access_row))) c where c.user_id = v_actor
    union
    select c.id from (select access_row.* from public.member_cases access_row where (private.chapter_case_readable(access_row))) c
      where c.steward_user_id = v_actor and (select s.steward_hat from actor_scope s)
    union
    select s.id from staff_visible s
  )
  select c.id, c.user_id, c.reference, c.title, c.status, c.updated_at
  from visible_ids v join (select access_row.* from public.member_cases access_row where (private.chapter_case_readable(access_row))) c on c.id = v.id
  where (select s.mfa_satisfied from actor_scope s)
  order by c.updated_at desc, c.id
  limit v_limit;
end;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.assign_member_case(p_case_id uuid, p_steward uuid DEFAULT NULL::uuid, p_coordinator uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
begin
  perform private.lock_message_lifecycle();
declare
  caller uuid := (select auth.uid());
  unchanged uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  case_row public.member_cases%rowtype;
  case_chapter text;
  steward_label text;
  coordinator_label text;
  actor_label text;
  before_value jsonb;
  after_value jsonb;
  new_steward uuid;
  new_coordinator uuid;
begin
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['coordinator', 'admin']) then
    raise exception 'coordinator role and MFA required' using errcode = '42501';
  end if;

  select c.* into case_row from public.member_cases c where c.id = p_case_id for update;
  if not found then raise exception 'case not found' using errcode = 'P0002'; end if;
  if not public.staff_can_see_user(case_row.user_id, 'coordinator') or not private.chapter_case_staff_readable(case_row) then
    raise exception 'member outside your scope' using errcode = '42501';
  end if;
  select p.chapter_id into case_chapter from public.member_profiles p where p.id = case_row.user_id;

  -- The leave-unchanged intent is resolved against the locked row before any
  -- validation: a role the caller did not name is carried over byte-for-byte,
  -- never re-checked, never re-labelled, and never written as a null.
  new_steward := case when p_steward = unchanged then case_row.steward_user_id else p_steward end;
  new_coordinator := case when p_coordinator = unchanged then case_row.coordinator_user_id else p_coordinator end;

  -- Scope checks run only for a role that is actually being written. The
  -- stored display name follows the same three-way intent as the user id: a
  -- named person is looked up, the leave-unchanged sentinel keeps the existing
  -- label, and an explicit null clears the label with the id.
  if p_steward is not null and p_steward <> unchanged then
    select p.full_name into steward_label
    from public.member_roles r join public.member_profiles p on p.id = r.user_id
    where r.user_id = p_steward and r.role = 'steward'
      and (r.chapter_id is null or r.chapter_id = case_chapter)
      and private.actor_role_covers_member(r.user_id,case_chapter,r.role,case_row.user_id,true);
    if not found then raise exception 'steward is outside case scope or lacks role' using errcode = '23514'; end if;
  elsif p_steward = unchanged then
    steward_label := case_row.steward_name;
  else
    steward_label := null;
  end if;
  if p_coordinator is not null and p_coordinator <> unchanged then
    select p.full_name into coordinator_label
    from public.member_roles r join public.member_profiles p on p.id = r.user_id
    where r.user_id = p_coordinator and r.role = 'coordinator'
      and (r.chapter_id is null or r.chapter_id = case_chapter)
      and private.actor_role_covers_member(r.user_id,case_chapter,r.role,case_row.user_id,true);
    if not found then raise exception 'coordinator is outside case scope or lacks role' using errcode = '23514'; end if;
  elsif p_coordinator = unchanged then
    coordinator_label := case_row.coordinator_name;
  else
    coordinator_label := null;
  end if;

  before_value := pg_catalog.jsonb_build_object(
    'stewardUserId', case_row.steward_user_id, 'stewardName', case_row.steward_name,
    'coordinatorUserId', case_row.coordinator_user_id, 'coordinatorName', case_row.coordinator_name
  );
  after_value := pg_catalog.jsonb_build_object(
    'stewardUserId', new_steward, 'stewardName', steward_label,
    'coordinatorUserId', new_coordinator, 'coordinatorName', coordinator_label
  );
  if before_value = after_value then return; end if;

  update public.member_cases set
    steward_user_id = new_steward, steward_name = steward_label,
    coordinator_user_id = new_coordinator, coordinator_name = coordinator_label,
    assigned_at = case when new_steward is null and new_coordinator is null then null else now() end
  where id = p_case_id;

  actor_label := coalesce(
    (select p.full_name from public.member_profiles p where p.id = caller),
    'Staff member'
  );
  insert into public.member_case_assignment_audit
    (case_id, actor_id, actor_name, before_assignment, after_assignment)
  values (p_case_id, caller, actor_label, before_value, after_value);
end;
end;
end;
$function$
;

CREATE OR REPLACE FUNCTION private.casework_reminder_owner_can_read(p_owner uuid, p_case_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with org_staff as (
    select c.id as case_id,
      exists (
        select 1
        from public.organizations o
        join public.organization_memberships m
          on m.organization_id = o.id and m.user_id = p_owner and m.status = 'active'
        join public.organization_role_grants g
          on g.organization_id = o.id and g.user_id = p_owner and g.role in ('advisor', 'admin', 'vp')
        where o.id = c.organization_id
          and o.status = 'active'
          and (not private.staff_mfa_required(o.id) or private.has_second_factor(p_owner))
      ) as elevated
    from public.member_cases c
    where c.id = p_case_id and private.actor_case_scope_and_identity_allowed(p_owner,c)
  )
  select p_owner is not null and exists (
    select 1
    from public.member_cases c
    join org_staff s on s.case_id = c.id
    where c.id = p_case_id and private.actor_case_scope_and_identity_allowed(p_owner,c)
      and (
        c.user_id = p_owner
        or (
          c.organization_id is not null
          and c.chapter_id is not null
          and private.actor_has_chapter_staff_role(p_owner, c.chapter_id)
          and (
            c.steward_user_id = p_owner
            or c.coordinator_user_id = p_owner
            or s.elevated
            or exists (
              select 1
              from public.member_roles r
              join public.member_profiles target on target.id = c.user_id
              where r.user_id = p_owner
                and r.role = 'coordinator'
                and (
                  r.chapter_id is null
                  or exists (
                    select 1
                    from public.member_role_chapters rc
                    join public.member_chapter_memberships cm
                      on cm.user_id = rc.user_id and cm.chapter_id = rc.chapter_id
                    where rc.user_id = r.user_id
                      and rc.role = r.role
                      and rc.chapter_id = target.chapter_id
                      and cm.status = 'active'
                  )
                )
            )
          )
          and (
            not c.is_restricted
            or c.steward_user_id = p_owner
            or c.coordinator_user_id = p_owner
            or s.elevated
            or exists (
              select 1
              from public.casework_access_grants ag
              where ag.case_id = c.id
                and ag.grantee_user_id = p_owner
                and ag.revoked_at is null
            )
          )
        )
      )
  );
$function$
;

CREATE OR REPLACE FUNCTION private.account_lifecycle_retained_case_scope_allows(p_kind text, p_record_id text, p_chapter_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(case when p_kind = 'assignment_audit' then
    private.account_lifecycle_staff_can_see_chapter((case when exists(select 1 from public.member_profiles where id=c.owner_id) then (select chapter_id from public.member_profiles where id=c.owner_id) else c.owner_chapter_id end), 'coordinator')
    -- The original policy's EXISTS also invokes member_cases SELECT RLS.
    and (
      c.owner_id = (select auth.uid())
      or (c.steward_user_id = (select auth.uid()) and public.member_has_role(array['steward']))
      or (
        not c.is_restricted
        or c.coordinator_user_id = (select auth.uid())
        or private.has_organization_role(c.organization_id, array['advisor','admin','vp'])
        or exists (select 1 from pg_catalog.jsonb_to_recordset(c.grants) as g(grantee_user_id uuid, revoked_at timestamptz)
          where g.grantee_user_id = (select auth.uid()) and g.revoked_at is null)
      )
    )
  else
    (p_kind = 'deadline_extension' and c.owner_id = (select auth.uid()))
    or (
      c.organization_id is not null
      and c.chapter_id is not null
      and private.actor_has_chapter_staff_role((select auth.uid()), c.chapter_id)
      and (
        c.steward_user_id = (select auth.uid())
        or c.coordinator_user_id = (select auth.uid())
        or private.account_lifecycle_staff_can_see_chapter((case when exists(select 1 from public.member_profiles where id=c.owner_id) then (select chapter_id from public.member_profiles where id=c.owner_id) else c.owner_chapter_id end), 'coordinator')
        or private.has_organization_role(c.organization_id, array['advisor','admin','vp'])
      )
      and (
        not c.is_restricted
        or c.steward_user_id = (select auth.uid())
        or c.coordinator_user_id = (select auth.uid())
        or private.has_organization_role(c.organization_id, array['advisor','admin','vp'])
        or exists (
          select 1 from pg_catalog.jsonb_to_recordset(c.grants) as g(grantee_user_id uuid, revoked_at timestamptz)
          where g.grantee_user_id = (select auth.uid()) and g.revoked_at is null
        )
      )
    )
  end, false)
  from private.account_lifecycle_history_scope h
  join private.account_lifecycle_case_scope c on c.case_id = h.case_id
  where h.kind = p_kind and h.record_id = p_record_id
    and private.actor_case_scope_and_identity_allowed((select auth.uid()),pg_catalog.jsonb_populate_record(null::public.member_cases,pg_catalog.jsonb_build_object('id',c.case_id,'user_id',c.owner_id,'organization_id',c.organization_id,'chapter_id',c.chapter_id,'steward_user_id',c.steward_user_id,'coordinator_user_id',c.coordinator_user_id,'is_restricted',c.is_restricted)));
$function$
;

CREATE OR REPLACE FUNCTION private.automation_v2_case_visible(p_actor uuid, p_org uuid, p_case uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 select exists(select 1 from public.member_cases c
 join public.member_profiles subject on subject.id=c.user_id
 join public.chapters ch on ch.id=subject.chapter_id and ch.organization_id=p_org
 where c.id=p_case and c.organization_id=p_org and private.actor_case_scope_and_identity_allowed(p_actor,c)
 and (c.user_id=p_actor or
   (c.steward_user_id=p_actor and exists(select 1 from public.member_role_chapters g where g.user_id=p_actor and g.chapter_id=c.chapter_id and g.role='steward')) or
   exists(select 1 from public.organization_role_grants g where g.user_id=p_actor and g.organization_id=p_org and g.role='coordinator') or
   exists(select 1 from public.member_role_chapters g join public.member_chapter_memberships m on m.user_id=g.user_id and m.chapter_id=g.chapter_id and m.status='active' where g.user_id=p_actor and g.chapter_id=subject.chapter_id and g.role='coordinator')));
$function$
;

CREATE OR REPLACE FUNCTION private.casework_can_read(p_case_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select not private.member_pin_session_restricted()
    and (private.casework_member_owns(p_case_id) or private.casework_staff_can_read(p_case_id));
$function$
;

CREATE OR REPLACE FUNCTION public.get_organization_analytics_workspace()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph_read();
  perform private.member_pin_require_full_session();
declare
  org uuid := private.mi1_require_selected_organization();
  generated timestamptz := pg_catalog.now();
  privacy_threshold integer := private.organization_limit(org, 'limits.analytics.anonymity_floor');
  health_threshold integer := private.organization_limit(org, 'limits.analytics.chapter_health_cohort_floor');
  actor uuid := (select auth.uid());
  may_read_unassigned boolean;
  scoped_actor boolean;
  default_steward_chapters text[];
  org_case_reader boolean;
  staff_chapters text[];
begin
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if org is null then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Necessary candidate condition only, never an authorization result.
  -- Deliberately retain roles in ANY tenant/chapter (including inactive or
  -- otherwise unusable grants): false positives still reach the shared final
  -- predicate. All current organization, chapter and legacy role sources are
  -- included. Assignment is checked per case below.
  may_read_unassigned := exists (
    select 1 from public.organization_role_grants g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  ) or exists (
    select 1 from public.member_role_chapters g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  ) or exists (
    select 1 from public.member_roles g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  );

  -- Cached ordinary-steward authorization. The enclosing roster query
  -- already proves the target's active chapter and organization memberships.
  -- Scoped actors, private identities and legacy exceptions use the oracle.
  scoped_actor := exists(select 1 from private.chapter_role_scopes scope where scope.user_id=actor);
  default_steward_chapters := array(
        select ch.id from public.chapters ch
        left join private.chapter_access_policies target_policy on target_policy.chapter_id=ch.id
        where ch.organization_id=org
          and coalesce(target_policy.steward_grievances,true)
          and (not private.staff_mfa_required(ch.organization_id) or private.has_second_factor(actor))
          and (private.has_organization_role(ch.organization_id,array['steward'])
            or private.member_has_chapter_role(ch.id,array['steward'])
            or exists(select 1 from public.member_role_chapters r
              join public.chapters source on source.id=r.chapter_id and source.organization_id=ch.organization_id
              join public.member_chapter_memberships source_member on source_member.chapter_id=r.chapter_id and source_member.user_id=r.user_id and source_member.status='active'
              join private.chapter_access_policies policy on policy.chapter_id=r.chapter_id and policy.steward_breadth='local' and policy.steward_grievances
              where r.user_id=actor and r.role='steward' and private.member_has_chapter_role(r.chapter_id,array['steward'])))
      );

  -- BUG-UG-SAMPLE-ANALYTICS-PANELS-TIME-OUT-20261030: for an
  -- organization advisor, administrator or leader, every per-case clause of
  -- private.casework_staff_can_access except the chapter staff-role test is
  -- already met by that organization role, so the per-case call (about 16 ms
  -- each at Tamarack scale, one per active case) reduces to membership in
  -- the chapters where private.actor_has_chapter_staff_role holds. Both are
  -- read once here, after lock_case_graph_read, with the same helpers and
  -- arguments the shared predicate uses; every other caller keeps the shared
  -- predicate per case.
  -- Scoped access: the shortcut applies only to an unscoped actor and a case
  -- with no identity privacy, where private.case_scope_and_identity_allowed
  -- is already true; every other case keeps the read oracle below.
  org_case_reader := private.has_organization_role(org, array['advisor','admin','vp']);
  select coalesce(pg_catalog.array_agg(c.id), array[]::text[]) into staff_chapters
  from public.chapters c
  where c.organization_id = org
    and private.actor_has_chapter_staff_role(actor, c.id);

  perform private.mi1_write_tenant_audit(org, 'analytics_snapshot_read', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surface', 'analytics_parity_workspace'
  ));

  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'generatedAt', generated,
    'privacyThreshold', privacy_threshold,
    'chapterHealthFloor', health_threshold,
    'members', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org,
        'id', m.user_id::text || ':' || m.chapter_id,
        'name', p.full_name,
        'chapterId', c.id,
        'chapterName', c.name,
        'participationScore', least(100, activity.event_count * 10),
        'profileReadiness',
          (case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end) + 50,
        'followThrough', least(100, activity.follow_count * 20),
        'overallScore', pg_catalog.round((
          least(100, activity.event_count * 10)
          + ((case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end) + 50)
          + least(100, activity.follow_count * 20)
        )::numeric / 3),
        'attention', case
          when cases.overdue_cases > 0 then 'urgent'
          when activity.event_count = 0 then 'support'
          when activity.event_count < 5 then 'watch'
          else 'steady'
        end,
        'activeCases', cases.active_cases,
        'overdueCases', cases.overdue_cases,
        'lastActivityAt', activity.last_activity
      ) order by c.name, p.full_name, m.user_id)
      from public.member_chapter_memberships m
      join public.chapters c on c.id = m.chapter_id and c.organization_id = org
      join public.organization_memberships om
        on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
      join public.member_profiles p on p.id = m.user_id
      cross join lateral (
        select
          pg_catalog.count(*)::integer as event_count,
          pg_catalog.count(*) filter (
            where e.event_type in ('authorized_contact', 'survey_response', 'event_rsvp')
              and e.occurred_at >= generated - interval '90 days'
          )::integer as follow_count,
          pg_catalog.max(e.occurred_at) as last_activity
        from public.organization_engagement_events e
        where e.organization_id = org
          and e.user_id = m.user_id
          -- Preserve train 2a participation semantics: page views are telemetry.
          and e.event_type <> 'page_view'
          and e.occurred_at >= generated - interval '180 days'
      ) activity
      cross join lateral (
        select
          pg_catalog.count(*) filter (where cs.status = 'active')::integer as active_cases,
          pg_catalog.count(*) filter (
            where cs.status = 'active' and cs.deadline < generated::date
          )::integer as overdue_cases
        from public.member_cases cs
        where cs.organization_id = org
          and cs.chapter_id = c.id
          and cs.user_id = m.user_id
          and cs.status = 'active'
          and case
            when org_case_reader and not scoped_actor
              and cs.chapter_id = any(staff_chapters)
              and (may_read_unassigned or cs.steward_user_id=actor or cs.coordinator_user_id=actor
                or cs.chapter_id=any(default_steward_chapters))
              and not exists(select 1 from private.case_identity_privacy privacy where privacy.case_id=cs.id)
            then true
            when not scoped_actor and not cs.is_restricted and cs.user_id<>actor
              and cs.chapter_id=any(default_steward_chapters)
              and not exists(select 1 from private.case_identity_privacy privacy where privacy.case_id=cs.id)
            then true
            else case when may_read_unassigned or cs.steward_user_id=actor or cs.coordinator_user_id=actor
                or cs.chapter_id=any(default_steward_chapters)
              then private.casework_staff_can_read(cs.id) else false end
          end
      ) cases
      where m.status = 'active'
        and (p.pulse_score_visible or m.user_id = actor)
    ), '[]'::jsonb),
    'chapterHealth', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org,
        'chapterId', c.id,
        'chapterName', c.name,
        'memberCount', totals.member_count,
        'protected', totals.member_count < health_threshold,
        'score', case when totals.member_count >= health_threshold then latest.score else null end,
        'drivers', case when totals.member_count >= health_threshold and latest.id is not null
          then pg_catalog.jsonb_build_object(
            'participation', latest.participation,
            'caseTimeliness', latest.case_timeliness,
            'stewardCapacity', latest.steward_capacity,
            'trainingCoverage', latest.training_coverage,
            'communicationReach', latest.communication_reach,
            'governanceReadiness', latest.governance_readiness
          ) else null end,
        'trend', case when totals.member_count >= health_threshold then coalesce(trend.points, '[]'::jsonb) else '[]'::jsonb end
      ) order by c.name)
      from public.chapters c
      cross join lateral (
        select pg_catalog.count(*)::integer as member_count
        from public.member_chapter_memberships m
        join public.organization_memberships om
          on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
        where m.chapter_id = c.id and m.status = 'active'
      ) totals
      left join lateral (
        select s.* from public.chapter_health_snapshots s
        where s.chapter_id = c.id order by s.measured_on desc limit 1
      ) latest on true
      left join lateral (
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'measuredOn', history.measured_on, 'score', history.score
        ) order by history.measured_on) as points
        from (
          select s.measured_on, s.score
          from public.chapter_health_snapshots s
          where s.chapter_id = c.id
          order by s.measured_on desc limit 36
        ) history
      ) trend on true
      where c.organization_id = org
    ), '[]'::jsonb),
    'datasets', coalesce((
      select pg_catalog.jsonb_agg(dataset.value order by dataset.sort_key)
      from (
        select 0 as sort_key, pg_catalog.jsonb_build_object(
          'organizationId', org,
          'id', 'organization:chapter-health',
          'label', 'Chapter health',
          'description', 'Latest protected chapter health score.',
          'scope', 'organization',
          'chapterId', null,
          'rows', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'label', qualified.name, 'value', qualified.score
          ) order by qualified.name), '[]'::jsonb)
        ) as value
        from (
          select c.name, latest.score
          from public.chapters c
          cross join lateral (
            select pg_catalog.count(*)::integer as member_count
            from public.member_chapter_memberships m
            join public.organization_memberships om
              on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
            where m.chapter_id = c.id and m.status = 'active'
          ) totals
          join lateral (
            select s.score from public.chapter_health_snapshots s
            where s.chapter_id = c.id order by s.measured_on desc limit 1
          ) latest on true
          where c.organization_id = org and totals.member_count >= health_threshold
        ) qualified
        union all
        select 100 + c.order_index, pg_catalog.jsonb_build_object(
          'organizationId', org,
          'id', 'chapter:' || c.id || ':health-trend',
          'label', c.name || ' health trend',
          'description', 'Protected chapter score history.',
          'scope', 'chapter',
          'chapterId', c.id,
          'rows', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'label', s.measured_on::text, 'value', s.score
            ) order by s.measured_on)
            from public.chapter_health_snapshots s where s.chapter_id = c.id
          ), '[]'::jsonb)
        )
        from public.chapters c
        where c.organization_id = org
          and (select pg_catalog.count(*) from public.member_chapter_memberships m
               join public.organization_memberships om
                 on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
               where m.chapter_id = c.id and m.status = 'active') >= privacy_threshold
      ) dataset
    ), '[]'::jsonb),
    'layouts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', l.id,
        'organizationId', l.organization_id,
        'name', l.name,
        'scope', l.scope,
        'chapterId', l.chapter_id,
        'spec', l.spec,
        'canEdit', l.owner_user_id = (select auth.uid())
          or private.has_organization_role(org, array['admin']),
        'updatedAt', l.updated_at
      ) order by l.updated_at desc)
      from public.organization_analytics_layouts l
      where l.organization_id = org
        and (
          (l.scope = 'personal' and l.owner_user_id = (select auth.uid()))
          or l.scope in ('chapter', 'organization')
        )
    ), '[]'::jsonb)
  );
end;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.casework_suggest_case_strength(p_case_id uuid, p_evidence_type text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_case public.member_cases%rowtype;
  v_answers jsonb;
  v_words text[];
  v_word_count integer;
  v_matches jsonb;
  v_max integer;
  v_contract integer;
  v_evidence_type text;
  v_inferred boolean;
  v_evidence integer;
  v_incident date;
  v_window integer;
  v_warning_days integer;
  v_days_since integer;
  v_procedural integer;
  v_days_remaining integer;
  v_due date;
  v_overall integer;
begin
  perform private.casework_require_mfa();
  if p_case_id is null or not private.casework_staff_can_read(p_case_id) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  if p_evidence_type is not null and p_evidence_type not in ('witness_statements', 'documents', 'photos', 'none') then
    raise exception 'invalid evidence type' using errcode = '22023';
  end if;
  select * into strict v_case from public.member_cases where id = p_case_id;
  if not private.organization_feature_enabled(v_case.organization_id, 'features.casework.strength_auto_suggest') then
    raise exception 'strength suggestion is turned off' using errcode = '55000';
  end if;
  select f.answers into v_answers from public.member_forms f
  where f.case_id = v_case.id and f.user_id = v_case.user_id
    and (f.user_id=(select auth.uid()) or f.status in ('submitted','in_review','approved') or private.member_draft_shared_to_caller(f))
  order by f.created_at, f.id limit 1;
  v_answers := coalesce(v_answers, '{}'::jsonb);

  -- Old words(): lower case, drop non-alphanumerics, split, keep >= 3 chars.
  select coalesce(array_agg(w), '{}'::text[]) into v_words
  from pg_catalog.regexp_split_to_table(
    pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.concat_ws(' ',
      v_case.title, v_case.articles, v_answers ->> 'summary', v_answers ->> 'articles', v_answers ->> 'narrative')),
      '[^a-z0-9[:space:]]', '', 'g'),
    '[[:space:]]+') w
  where pg_catalog.char_length(w) >= 3;
  v_word_count := pg_catalog.cardinality(v_words);

  with scored as (
    select c.id, c.article, c.title, c.sort_order,
      (select pg_catalog.count(*)::integer from pg_catalog.unnest(v_words) w
        where pg_catalog.strpos(
          pg_catalog.lower(pg_catalog.array_to_string(c.keywords, ' ') || ' ' || coalesce(c.summary, '')), w) > 0
      ) as match_count
    from public.contract_clauses c
    where c.organization_id = v_case.organization_id and c.status = 'published'
  ), ranked as (
    select s.*, row_number() over (order by s.match_count desc, s.sort_order, s.article, s.id) as position
    from scored s where s.match_count > 0
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', r.id, 'article', r.article, 'title', r.title, 'matchCount', r.match_count,
      'tag', case when r.position = 1 then 'Primary' else 'Supporting' end) order by r.position)
      filter (where r.position <= 3), '[]'::jsonb),
    coalesce(max(r.match_count), 0)
  into v_matches, v_max
  from ranked r;
  v_contract := case when v_max > 0
    then least(100, round(v_max::numeric / greatest(v_word_count, 1) * 100))::integer else 0 end;

  v_inferred := p_evidence_type is null;
  v_evidence_type := coalesce(p_evidence_type, case
    when nullif(pg_catalog.btrim(coalesce(v_answers ->> 'witnesses', '')), '') is not null then 'witness_statements'
    when exists (select 1 from public.member_case_files mf where mf.case_id = v_case.id and mf.removal_id is null
      and mf.mime_type not like 'image/%') then 'documents'
    when exists (select 1 from public.member_case_files mf where mf.case_id = v_case.id and mf.removal_id is null
      and mf.mime_type like 'image/%') then 'photos'
    else 'none' end);
  v_evidence := private.organization_limit(v_case.organization_id, case v_evidence_type
    when 'witness_statements' then 'limits.casework.strength_evidence_witness'
    when 'documents' then 'limits.casework.strength_evidence_documents'
    when 'photos' then 'limits.casework.strength_evidence_photos'
    else 'limits.casework.strength_evidence_none' end);

  v_window := private.organization_limit(v_case.organization_id, 'limits.casework.strength_filing_window_days');
  v_warning_days := private.organization_limit(v_case.organization_id, 'limits.casework.strength_deadline_warning_days');
  if coalesce(v_answers ->> 'incident_date', '') ~ '^\d{4}-\d{2}-\d{2}$' then
    v_incident := (v_answers ->> 'incident_date')::date;
  end if;
  v_procedural := 100;
  if v_incident is not null then
    v_days_since := greatest(0, current_date - v_incident);
    v_procedural := greatest(0, round(100 - v_days_since::numeric / v_window * 100))::integer;
    v_days_remaining := greatest(0, v_window - v_days_since);
  end if;
  select (min(d.due_at) at time zone 'UTC')::date into v_due
  from public.casework_deadlines d
  where d.case_id = v_case.id and d.kind in ('filing', 'procedure') and d.status in ('active', 'extended');
  if v_due is not null then
    v_days_remaining := greatest(0, v_due - current_date);
  end if;

  v_overall := round(v_contract * 0.4 + v_evidence * 0.35 + v_procedural * 0.25)::integer;
  return pg_catalog.jsonb_build_object(
    'overallScore', v_overall,
    'band', case when v_overall < 45 then 'needs_evidence' when v_overall < 75 then 'developing' else 'strong' end,
    'contractScore', v_contract,
    'evidenceScore', v_evidence,
    'proceduralScore', v_procedural,
    'evidenceType', v_evidence_type,
    'evidenceInferred', v_inferred,
    'matchedClauses', v_matches,
    'daysRemaining', v_days_remaining,
    'deadlineWarning', case
      when v_days_remaining is null then null
      when v_days_remaining <= 0 then 'passed'
      when v_days_remaining <= v_warning_days then 'soon' end,
    'warningDays', v_warning_days,
    'suggestedInputs', pg_catalog.jsonb_build_object(
      'contract_support', least(5, round(v_contract / 20.0))::integer,
      'documentation', least(5, round(v_evidence / 20.0))::integer,
      'timeliness', least(5, round(v_procedural / 20.0))::integer,
      'witnesses', case when v_evidence_type = 'witness_statements' then 5 else 0 end));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.casework_list_ulp_deadlines(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare org uuid := private.mi1_require_selected_organization();
begin
  perform private.casework_require_mfa();
  return coalesce((
    select pg_catalog.jsonb_agg(row_data order by deadline, flag_id)
    from (
      select case when f.safety_deadline >= current_date and f.safety_deadline < f.ulp_deadline
          then f.safety_deadline else f.ulp_deadline end as deadline,
        f.id as flag_id,
        pg_catalog.jsonb_build_object(
          'flagId', f.id,
          'caseId', c.id,
          'reference', c.reference,
          'title', c.title,
          'source', f.source,
          'status', f.status,
          'incidentOn', f.incident_on,
          'ulpDeadline', f.ulp_deadline,
          'daysLeft', f.ulp_deadline - current_date,
          'warningDays', t.warning_days,
          'criticalDays', t.critical_days,
          'protectedActivityCategory', f.protected_activity_category,
          'safetyDeadline', f.safety_deadline,
          'safetyRoute', private.casework_safety_retaliation_route(f.organization_id)) as row_data
      from public.casework_retaliation_flags f
      join public.member_cases c on c.id = f.case_id
      cross join lateral private.casework_ulp_thresholds(f.organization_id) t
      where f.status in ('open', 'confirmed')
        and f.organization_id = org
        and private.casework_staff_can_read(f.case_id)
        and private.organization_feature_enabled(f.organization_id, 'features.casework.ulp_deadline')
      order by case when f.safety_deadline >= current_date and f.safety_deadline < f.ulp_deadline
          then f.safety_deadline else f.ulp_deadline end, f.id
      limit least(greatest(coalesce(p_limit, 50), 1), 200)
    ) rows
  ), '[]'::jsonb);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.casework_case_history(p_case_id uuid, p_limit integer DEFAULT 50, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(event_id text, kind text, at timestamp with time zone, actor_user_id uuid, actor_name text, actor_role text, details jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with events as (
    -- The note author is readable by anyone the row's own RLS already admits.
    -- A note carries its writer in author_user_id (20260925110300); a note
    -- written before that column existed, or by a job with no session, keeps
    -- the case member attribution it always had.
    select 'note:' || n.id event_id, 'note'::text kind, n.created_at at, coalesce(n.author_user_id, n.user_id) actor_user_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('body', n.body, 'occurredOn', n.occurred_on)) details
    from public.member_case_updates n where n.case_id = p_case_id
    union all
    select 'transition:' || s.id, 'transition', s.created_at, s.transitioned_by,
      pg_catalog.jsonb_build_object('from_step', s.from_step, 'to_step', s.to_step, 'outcome', s.outcome)
    from public.casework_step_transitions s where s.case_id = p_case_id
    union all
    select 'assignment:' || a.id, 'assignment', a.created_at, a.actor_id,
      pg_catalog.jsonb_build_object('before', a.before_assignment, 'after', a.after_assignment)
    from public.member_case_assignment_audit a where a.case_id = p_case_id
      and private.casework_staff_can_read(p_case_id)
    union all
    select 'coordinator:' || a.id, 'coordinator', a.created_at, a.actor_id,
      pg_catalog.jsonb_build_object('action', a.action, 'before', a.before_value, 'after', a.after_value, 'reason', a.reason)
    from public.coordinator_case_audit a where a.case_id = p_case_id
      and private.casework_staff_can_read(p_case_id)
    union all
    select 'audit:' || a.id, 'audit', a.created_at, a.actor_user_id,
      pg_catalog.jsonb_build_object('action', a.event_type, 'metadata', a.metadata)
    from public.casework_audit_events a where a.case_id = p_case_id
      and private.casework_staff_can_read(p_case_id)
    union all
    select * from private.casework_history_versions(p_case_id)
  ), page as (
    select * from events where private.casework_can_read(p_case_id)
      and (p_before is null or events.at < p_before)
    order by events.at desc
    fetch first (greatest(1, least(coalesce(p_limit, 50), 100))) rows with ties
  -- Attribution is resolved under the CALLER's own visibility and nothing
  -- wider. public.member_profiles answers only for the accounts
  -- private.staff_visible_member_ids (the set-wise public.staff_can_see_user)
  -- already exposes, plus the caller's own row; the assignee labels stamped on
  -- public.member_cases are exactly the two staff names a member may already
  -- read on their own case, which is where the case detail's assignee line
  -- comes from. A member therefore names their own steward, their own
  -- coordinator and themselves, and no other staff account. An actor the
  -- caller may not name carries a role label instead: the uuid is never a
  -- display value.
  ), subject as (
    select c.user_id member_user_id, c.steward_user_id, c.steward_name,
      c.coordinator_user_id, c.coordinator_name
    from public.member_cases c where c.id = p_case_id
  -- A ROLE IS NOT ATTRIBUTION. The subject CTE above stays INVOKER because it
  -- carries the two assignee NAMES; a caller who cannot read the case row gets
  -- no names from it, which is the design. The role label is different: it says
  -- only which of three positions an actor the caller is ALREADY looking at
  -- occupies on this case. Deriving it from the same empty INVOKER read made an
  -- organization advisor see every event as 'staff', including the member's own
  -- note. private.casework_case_actor_roles is the definer helper that answers
  -- it, from the case row the existing definer read boundary already consults,
  -- for exactly the actor ids on this caller's own page and nothing else.
  ), roles as (
    select r.actor_user_id role_user_id, r.actor_role role_label
    from private.casework_case_actor_roles(
      p_case_id,
      -- `fetch first N rows with ties` can return more than the clamped page
      -- size, so the distinct actor list is capped here too. The helper's own
      -- guard is the authority; this keeps the reader provably inside it, and
      -- an id beyond the cap degrades to the historical 'staff' fallback below
      -- instead of raising in the feed.
      (select pg_catalog.array_agg(candidate.actor_user_id) from (
        select distinct page.actor_user_id from page
        where page.actor_user_id is not null limit 100
      ) candidate)
    ) r
  )
  select page.event_id, page.kind, page.at, page.actor_user_id,
    nullif(pg_catalog.btrim(coalesce(
      (select p.full_name from public.member_profiles p where p.id = page.actor_user_id),
      (select s.steward_name from subject s where s.steward_user_id = page.actor_user_id),
      (select s.coordinator_name from subject s where s.coordinator_user_id = page.actor_user_id),
      '')), ''),
    case
      when page.actor_user_id is null then null
      else coalesce((select r.role_label from roles r where r.role_user_id = page.actor_user_id), 'staff')
    end,
    page.details
  from page order by page.at desc, page.event_id desc;
$function$
;

CREATE OR REPLACE FUNCTION public.casework_list_case_retaliation_flags(p_case_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_case public.member_cases%rowtype;
  v_enabled boolean;
  v_warning integer;
  v_critical integer;
  v_jurisdiction jsonb;
begin
  perform private.casework_require_mfa();
  if p_case_id is null or not private.casework_staff_can_read(p_case_id) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  select * into strict v_case from public.member_cases where id = p_case_id;
  v_enabled := private.organization_feature_enabled(v_case.organization_id, 'features.casework.ulp_deadline');
  select t.warning_days, t.critical_days into v_warning, v_critical
  from private.casework_ulp_thresholds(v_case.organization_id) t;
  select pg_catalog.jsonb_build_object(
      'code', r.jurisdiction,
      'name', r.jurisdiction_name,
      'periodValue', r.period_value,
      'periodUnit', r.period_unit,
      'periodText', r.period_text,
      'trigger', r.trigger_text,
      'extension', r.extension_text,
      'pinpoint', r.pinpoint,
      'provenance', r.provenance)
    into v_jurisdiction
  from private.reference_ulp_limitation_periods r
  where r.jurisdiction = private.organization_setting_text(v_case.organization_id, 'limits.casework.ulp_jurisdiction');
  return pg_catalog.jsonb_build_object(
    'enabled', v_enabled,
    'windowDays', private.organization_limit(v_case.organization_id, 'limits.casework.ulp_window_days'),
    'jurisdiction', v_jurisdiction,
    'safetyRoute', private.casework_safety_retaliation_route(v_case.organization_id),
    'warningDays', v_warning,
    'criticalDays', v_critical,
    'flags', coalesce((
      select pg_catalog.jsonb_agg(private.casework_retaliation_flag_json(f, v_enabled)
        order by f.ulp_deadline, f.created_at, f.id)
      from public.casework_retaliation_flags f
      where f.case_id = v_case.id
    ), '[]'::jsonb));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.list_case_note_mention_candidates(p_case_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_case public.member_cases%rowtype;
  v_chapter text;
begin
  perform private.casework_require_mfa();
  if not private.casework_staff_can_read(p_case_id) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  select * into strict v_case from public.member_cases where id = p_case_id;
  select p.chapter_id into v_chapter from public.member_profiles p where p.id = v_case.user_id;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', eligible.user_id,
      'fullName', eligible.full_name,
      'roles', eligible.roles
    ) order by eligible.full_name, eligible.user_id)
    from (
      select r.user_id, p.full_name,
             pg_catalog.jsonb_agg(r.role order by r.role) as roles
      from public.member_roles r
      join public.member_profiles p on p.id = r.user_id
      where r.role in ('steward', 'coordinator')
        and (r.chapter_id is null or r.chapter_id = v_chapter)
      group by r.user_id, p.full_name
      order by p.full_name, r.user_id
      limit 200
    ) eligible
  ), '[]'::jsonb);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.list_casework_audit_events(p_limit integer DEFAULT 50, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id bigint DEFAULT NULL::bigint, p_kind text DEFAULT NULL::text, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_case_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := private.mi1_require_selected_organization();
  clamped integer;
begin
  if p_kind is not null
     and p_kind <> all (private.casework_audit_event_kinds()) then
    raise exception 'unknown casework audit event kind' using errcode = '22023';
  end if;
  clamped := private.audit_sink_read_bounds(p_limit, p_before, p_before_id is not null, p_since, p_until);

  return coalesce((
    select pg_catalog.jsonb_agg(page.item order by page.created_at desc, page.id desc)
    from (
      select
        a.created_at,
        a.id,
        pg_catalog.jsonb_build_object(
          'id', a.id,
          'source', 'casework_audit_events',
          'organizationId', a.organization_id,
          'chapterId', a.chapter_id,
          'kind', a.event_type,
          'caseId', a.case_id,
          'entityId', a.entity_id,
          'actorUserId', a.actor_user_id,
          'createdAt', a.created_at
        ) as item
      from public.casework_audit_events a
      where a.organization_id = org
        and (p_case_id is null or a.case_id = p_case_id)
        and (p_kind is null or a.event_type = p_kind)
        and (p_since is null or a.created_at >= p_since)
        and (p_until is null or a.created_at <= p_until)
        and (p_before is null or (a.created_at, a.id) < (p_before, p_before_id))
        and (
          private.has_organization_role(a.organization_id, array['advisor', 'admin', 'vp'])
          or (
            private.has_organization_role(a.organization_id, array['coordinator'])
            and (
              a.case_id is null
              or (
                exists (
                  select 1
                  from public.member_cases c
                  where c.id = a.case_id
                    and public.staff_can_see_user(c.user_id, 'coordinator')
                )
                and private.member_case_visible_to_caller(a.case_id)
              )
            )
          )
          or (a.case_id is not null and private.casework_staff_can_read(a.case_id))
        )
      order by a.created_at desc, a.id desc
      limit clamped
    ) page
  ), '[]'::jsonb);
end;
$function$
;

alter policy casework_alert_acknowledgements_read on public.casework_alert_acknowledgements using ((EXISTS ( SELECT 1
   FROM public.casework_alerts a
  WHERE ((a.id = casework_alert_acknowledgements.alert_id) AND (a.organization_id = casework_alert_acknowledgements.organization_id) AND private.casework_staff_can_read(a.case_id)))));
alter policy casework_alerts_read on public.casework_alerts using (private.casework_staff_can_read(case_id));
alter policy casework_audit_events_staff_read on public.casework_audit_events using ((private.has_organization_role(organization_id, ARRAY['advisor'::text, 'admin'::text, 'vp'::text]) OR (private.has_organization_role(organization_id, ARRAY['coordinator'::text]) AND ((case_id IS NULL) OR (EXISTS ( SELECT 1
   FROM public.member_cases c
  WHERE (c.id = casework_audit_events.case_id))))) OR ((case_id IS NOT NULL) AND private.casework_staff_can_read(case_id)) OR ((case_id IS NULL) AND private.account_lifecycle_retained_case_scope_allows('casework_audit'::text, (id)::text, chapter_id))));
alter policy casework_deadlines_select on public.casework_deadlines using ((private.casework_can_read(case_id) OR private.casework_staff_can_read(case_id)));
alter policy casework_entity_links_read on public.casework_entity_links using ((private.casework_staff_can_read(source_case_id) AND ((target_case_id IS NULL) OR private.casework_staff_can_read(target_case_id))));
alter policy casework_management_addenda_staff on public.casework_management_addenda using ((EXISTS ( SELECT 1
   FROM public.casework_management_entries entry
  WHERE ((entry.id = casework_management_addenda.entry_id) AND (entry.organization_id = casework_management_addenda.organization_id) AND private.member_has_chapter_role(entry.chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]) AND (((entry.case_id IS NOT NULL) AND private.casework_staff_can_read(entry.case_id)) OR ((entry.case_id IS NULL) AND COALESCE(private.account_lifecycle_retained_case_scope_allows('management_entry'::text, (entry.id)::text, entry.chapter_id), true)))))));
alter policy casework_management_entries_staff on public.casework_management_entries using ((private.member_has_chapter_role(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]) AND (((case_id IS NOT NULL) AND private.casework_staff_can_read(case_id)) OR ((case_id IS NULL) AND COALESCE(private.account_lifecycle_retained_case_scope_allows('management_entry'::text, (id)::text, chapter_id), true)))));
alter policy casework_retaliation_reports_read on public.casework_retaliation_reports using (((reporter_user_id = ( SELECT auth.uid() AS uid)) OR (private.member_has_chapter_role(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]) AND (((case_id IS NOT NULL) AND private.casework_staff_can_read(case_id)) OR ((case_id IS NULL) AND COALESCE(private.account_lifecycle_retained_case_scope_allows('retaliation_report'::text, (id)::text, chapter_id), true))))));
alter policy casework_strength_read on public.casework_strength_analyses using (private.casework_staff_can_read(case_id));
CREATE OR REPLACE FUNCTION private.casework_dashboard_open_cases()
 RETURNS TABLE(case_id uuid, step_name text, steward_id uuid, steward_label text, coordinator_id uuid, coordinator_label text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    c.id,
    c.step,
    c.steward_user_id,
    c.steward_name,
    c.coordinator_user_id,
    c.coordinator_name
  from public.member_cases c
  where c.status = 'active'
    and c.organization_id is not null
    and c.chapter_id is not null
    and (
      (c.organization_id = (select private.current_member_organization())
        and c.chapter_id = (select private.current_member_chapter()))
      or (
        c.id in (
          select g.case_id
          from public.casework_access_grants g
          where g.grantee_user_id = (select auth.uid())
            and g.revoked_at is null
        )
        and public.staff_can_see_user(c.user_id, 'coordinator')
        and private.casework_staff_can_read(c.id)
      )
    )
    and private.casework_staff_can_read(c.id)
    and not private.organization_is_platform(c.organization_id);
$function$
;

-- Recipient lookup is private and accepts an explicit steward so a member can
-- validate a sharing choice without impersonating that steward's session.
create function private.draft_steward_covers_member(p_steward uuid, p_owner uuid, p_chapter text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists(select 1 from public.chapters c
    join public.member_chapter_memberships recipient on recipient.chapter_id=c.id and recipient.user_id=p_steward and recipient.status='active'
    join public.member_chapter_memberships owner_member on owner_member.chapter_id=c.id and owner_member.user_id=p_owner and owner_member.status='active'
    join public.organization_memberships recipient_org on recipient_org.organization_id=c.organization_id and recipient_org.user_id=p_steward and recipient_org.status='active'
    join public.organization_memberships owner_org on owner_org.organization_id=c.organization_id and owner_org.user_id=p_owner and owner_org.status='active'
    where c.id=p_chapter and c.organization_id=private.current_member_organization()
      and (exists(select 1 from public.organization_role_grants r where r.organization_id=c.organization_id and r.user_id=p_steward and r.role='steward')
        or exists(select 1 from public.member_role_chapters r
          left join private.chapter_role_scopes s on s.user_id=r.user_id and s.chapter_id=r.chapter_id and s.role=r.role
          where r.user_id=p_steward and r.chapter_id=c.id and r.role='steward'
            and (s.user_id is null
              or (s.unit_id is not null and exists(select 1 from private.chapter_unit_members m where m.unit_id=s.unit_id and m.chapter_id=c.id and m.user_id=p_owner))
              or (s.committee_id is not null and exists(select 1 from private.chapter_committees committee
                join private.chapter_committee_members m on m.committee_id=committee.id and m.chapter_id=committee.chapter_id
                where committee.id=s.committee_id and committee.starts_on<=current_date and (committee.ends_on is null or committee.ends_on>=current_date) and m.user_id=p_owner))))));
$function$;
revoke all on function private.draft_steward_covers_member(uuid,uuid,text) from public, anon, authenticated, service_role;

create function private.member_draft_shared_to_caller(p_form public.member_forms)
returns boolean language sql stable security definer set search_path = '' as $function$
  select (select auth.uid()) is not null and private.mfa_satisfied()
    and not private.member_pin_session_restricted()
    and p_form.status in ('draft','returned')
    and not private.form_template_is_sealed(p_form.template_key)
    and exists(select 1 from private.member_draft_steward_shares share
      where share.form_id=p_form.id and share.steward_id=(select auth.uid())
        and share.organization_id=private.current_member_organization()
        and share.chapter_id=private.current_member_chapter()
        and share.chapter_id=(select chapter_id from public.member_profiles where id=p_form.user_id))
    and exists(select 1 from public.member_profiles owner_profile
      where owner_profile.id=p_form.user_id
        and private.draft_steward_covers_member((select auth.uid()),p_form.user_id,owner_profile.chapter_id)
        and (not private.staff_mfa_required(private.current_member_organization()) or private.has_second_factor((select auth.uid()))));
$function$;
revoke all on function private.member_draft_shared_to_caller(public.member_forms) from public, anon, authenticated, service_role;
grant execute on function private.member_draft_shared_to_caller(public.member_forms) to authenticated;

create function public.set_member_draft_steward_share(p_form uuid, p_steward uuid, p_shared boolean)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid(),p_steward],array[]::uuid[]);
declare target public.member_forms%rowtype; chapter text;
begin
  perform private.member_pin_require_full_session();
  if (select auth.uid()) is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode='42501'; end if;
  select * into target from public.member_forms where id=p_form and user_id=(select auth.uid()) for update;
  if not found or target.status not in ('draft','returned') then raise exception 'own draft required' using errcode='42501'; end if;
  if private.form_template_is_sealed(target.template_key) then raise exception 'sensitive draft sharing unavailable' using errcode='42501'; end if;
  select chapter_id into chapter from public.member_profiles where id=(select auth.uid());
  if coalesce(p_shared,false) then
    if p_steward is null or p_steward=(select auth.uid()) or not private.draft_steward_covers_member(p_steward,target.user_id,chapter) then raise exception 'steward outside draft scope' using errcode='42501'; end if;
    insert into private.member_draft_steward_shares(form_id,steward_id,organization_id,chapter_id) values(p_form,p_steward,private.current_member_organization(),chapter)
    on conflict(form_id,steward_id) do update set organization_id=excluded.organization_id,chapter_id=excluded.chapter_id;
  else
    delete from private.member_draft_steward_shares where form_id=p_form and steward_id=p_steward;
  end if;
  return pg_catalog.jsonb_build_object('updated',true);
end;
end;
$function$;
revoke all on function public.set_member_draft_steward_share(uuid,uuid,boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_member_draft_steward_share(uuid,uuid,boolean) to authenticated;

create function public.list_member_draft_sharing(p_form uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare chapter text;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() or private.member_pin_session_restricted()
    or not exists(select 1 from public.member_forms f where f.id=p_form and f.user_id=(select auth.uid()) and f.status in ('draft','returned') and not private.form_template_is_sealed(f.template_key)) then
    raise exception 'own shareable draft required' using errcode='42501';
  end if;
  select chapter_id into chapter from public.member_profiles where id=(select auth.uid());
  return coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',person.id,'name',person.full_name,'shared',exists(select 1 from private.member_draft_steward_shares share where share.form_id=p_form and share.steward_id=person.id and share.organization_id=private.current_member_organization() and share.chapter_id=chapter)) order by person.full_name,person.id)
    from (select p.id,p.full_name from public.member_profiles p where p.id<>(select auth.uid())
      and private.draft_steward_covers_member(p.id,(select auth.uid()),chapter) order by p.full_name,p.id limit 100) person),'[]'::jsonb);
end;
$function$;
revoke all on function public.list_member_draft_sharing(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_member_draft_sharing(uuid) to authenticated;

create function public.list_shared_member_drafts()
returns jsonb language sql stable security invoker set search_path = '' as $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(draft)),'[]'::jsonb)
  from (select f.id,f.template_key,f.user_id,f.answers,f.updated_at,pg_catalog.to_jsonb(template) as template
    from public.member_forms f join public.form_template_registry template on template.key=f.template_key and template.version=f.template_version
    where private.member_draft_shared_to_caller(f)
    order by f.updated_at desc,f.id limit 100) draft;
$function$;
revoke all on function public.list_shared_member_drafts() from public, anon, authenticated, service_role;
grant execute on function public.list_shared_member_drafts() to authenticated;

create policy member_forms_explicit_draft_share on public.member_forms for select to authenticated using(private.member_draft_shared_to_caller(member_forms));

-- Explicit shares never grant edits, signing, submission, or a sealed form's
-- encryption envelope. Object authorization also revalidates the live share.
-- Service filing revalidates the explicitly supplied actor rather than the
-- service credential's empty auth.uid(). The caller-token preflight still
-- supplies the session and two-step boundary before this service-only RPC.
create function private.member_form_actor_scope_and_identity_allowed(p_actor uuid,p_form public.member_forms)
returns boolean language sql stable security definer set search_path = '' as $function$
  select p_actor is not null and (p_form.user_id=p_actor or (
    exists(select 1 from public.member_profiles owner_profile
      where owner_profile.id=p_form.user_id
        and private.actor_role_covers_member(p_actor,owner_profile.chapter_id,'steward',p_form.user_id,p_form.template_key in ('grievance','alliance_grievance')))
    and (p_form.case_id is null or exists(select 1 from public.member_cases c
      where c.id=p_form.case_id and private.actor_case_scope_and_identity_allowed(p_actor,c)
        and private.actor_role_covers_member(p_actor,c.chapter_id,'steward',c.user_id,true)))));
$function$;
revoke all on function private.member_form_actor_scope_and_identity_allowed(uuid,public.member_forms) from public,anon,authenticated,service_role;

-- A filed grievance form must not reveal the case/member link after its
-- identity is made private. Owners and explicitly consenting co-signers or
-- draft recipients retain the separate authority they already hold.
create function private.member_form_scope_and_identity_allowed(p_form public.member_forms)
returns boolean language sql stable security definer set search_path = '' as $function$
  select p_form.user_id=(select auth.uid())
    or (p_form.template_key='alliance_grievance' and public.caller_is_accepted_cosigner(p_form.id))
    or private.member_draft_shared_to_caller(p_form)
    or (p_form.case_id is null and (p_form.template_key not in ('grievance','alliance_grievance')
      or exists(select 1 from public.member_profiles owner_profile where owner_profile.id=p_form.user_id
        and private.actor_role_covers_member((select auth.uid()),owner_profile.chapter_id,'steward',p_form.user_id,true))))
    or exists(select 1 from public.member_cases c where c.id=p_form.case_id and private.chapter_case_readable(c));
$function$;
revoke all on function private.member_form_scope_and_identity_allowed(public.member_forms) from public,anon,authenticated,service_role;
grant execute on function private.member_form_scope_and_identity_allowed(public.member_forms) to authenticated;

create function private.member_form_case_readable(p_form uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select coalesce((select private.member_form_scope_and_identity_allowed(f) from public.member_forms f where f.id=p_form),false);
$function$;
revoke all on function private.member_form_case_readable(uuid) from public,anon,authenticated,service_role;

create policy member_forms_case_identity_scope on public.member_forms as restrictive for select to authenticated
  using(private.member_form_scope_and_identity_allowed(member_forms));

create or replace function private.can_read_member_form_object(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select not private.member_pin_session_restricted() and exists (
    select 1 from public.member_form_files ff join public.member_forms f on f.id=ff.form_id
    where ff.bucket_id=p_bucket and ff.object_name=p_name and ff.confirmed_at is not null
      and private.member_form_scope_and_identity_allowed(f)
      and (f.user_id=(select auth.uid())
        or (f.status in ('submitted','in_review','approved') and public.member_has_role(array['steward']) and public.staff_can_see_user(f.user_id,'steward'))
        or private.member_draft_shared_to_caller(f)));
$function$;
revoke all on function private.can_read_member_form_object(text,text) from public, anon, authenticated, service_role;
grant execute on function private.can_read_member_form_object(text,text) to authenticated;

create or replace function private.can_read_member_case_object(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select not private.member_pin_session_restricted() and exists (
    select 1 from public.member_case_files f where f.bucket_id=p_bucket and f.object_name=p_name and f.confirmed_at is not null and f.removal_requested_at is null
      and (f.user_id=(select auth.uid()) or exists(select 1 from public.member_cases c where c.id=f.case_id and private.chapter_case_readable(c))));
$function$;
revoke all on function private.can_read_member_case_object(text,text) from public, anon, authenticated, service_role;
grant execute on function private.can_read_member_case_object(text,text) to authenticated;

CREATE OR REPLACE FUNCTION public.form_owner_in_steward_scope(p_form_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(
    (select public.staff_can_see_user(f.user_id, 'steward')
     from (select scope_form.* from public.member_forms scope_form where private.member_form_scope_and_identity_allowed(scope_form)) f
     where f.id = p_form_id),
    false);
$function$;

CREATE OR REPLACE FUNCTION public.steward_start_review(p_form_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  updated integer;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  update public.member_forms
    set status = 'in_review', reviewed_by = caller, updated_at = now()
    where id = p_form_id and private.member_form_case_readable(p_form_id) and status = 'submitted' and user_id <> caller
      and public.staff_can_see_user(user_id, 'steward');
  get diagnostics updated = row_count;
  if updated = 0 then
    raise exception 'form not found, not awaiting review, or your own' using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object('formId', p_form_id, 'status', 'in_review');
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.return_form(p_form_id uuid, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  clean_note text := pg_catalog.btrim(coalesce(p_note, ''));
  rec record;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if clean_note = '' or pg_catalog.char_length(clean_note) > 4000 then
    raise exception 'return note must be between 1 and 4000 characters' using errcode = '22023';
  end if;
  if pg_catalog.regexp_replace(clean_note, '[' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9) || ']', '', 'g') ~ '[[:cntrl:]]' then
    raise exception 'note contains unsupported control characters' using errcode = '22023';
  end if;

  select f.id, f.user_id, f.status, f.template_key, f.template_version, coalesce(p.language, 'en') as lang into rec
    from (select scope_form.* from public.member_forms scope_form where private.member_form_scope_and_identity_allowed(scope_form)) f
    left join public.member_profiles p on p.id = f.user_id
    where f.id = p_form_id for update of f;
  if not found or rec.status not in ('submitted', 'in_review') or rec.user_id = caller
     or not public.staff_can_see_user(rec.user_id, 'steward') then
    raise exception 'form not found, not reviewable, or your own' using errcode = '22023';
  end if;

  -- the one-active-per-template partial index covers draft+returned: if the
  -- member started a NEW draft of this template after submitting this row,
  -- flipping it to returned would collide. Surface a clean error instead of a
  -- unique_violation 500 — the steward can approve, or the member finishes
  -- the newer draft first.
  begin
    update public.member_forms
      set status = 'returned', review_note = clean_note, reviewed_by = caller, reviewed_at = now(), updated_at = now()
      where id = p_form_id and private.member_form_case_readable(p_form_id);
  exception when unique_violation then
    raise exception 'member already has an active draft of this template; approve instead or ask them to finish it' using errcode = '23505';
  end;

  if rec.lang = 'es' then
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Formulario devuelto',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang) || ' — devuelto por tu delegado para cambios. Nota: ' || clean_note, 'forms');
  else
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Form returned',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang) || ' — returned by your steward for changes. Note: ' || clean_note, 'forms');
  end if;

  return pg_catalog.jsonb_build_object('formId', p_form_id, 'status', 'returned');
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.approve_form(p_form_id uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  clean_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  rec record;
  signature record;
  current_digest text;
  approved_time timestamptz := now();
  frozen_digest text;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if clean_note is not null and (pg_catalog.char_length(clean_note) > 4000
      or pg_catalog.regexp_replace(clean_note,
        '[' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9) || ']', '', 'g') ~ '[[:cntrl:]]') then
    raise exception 'note is invalid' using errcode = '22023';
  end if;
  perform private.lock_member_form(p_form_id);
  select f.id, f.user_id, f.status, f.template_key, f.template_version,
         coalesce(p.language, 'en') as lang into rec
    from (select scope_form.* from public.member_forms scope_form where private.member_form_scope_and_identity_allowed(scope_form)) f left join public.member_profiles p on p.id = f.user_id
    where f.id = p_form_id for update of f;
  if not found or rec.status not in ('submitted', 'in_review') or rec.user_id = caller
     or not public.staff_can_see_user(rec.user_id, 'steward') then
    raise exception 'form not found, not reviewable, or your own' using errcode = '22023';
  end if;
  if exists (select 1 from public.member_form_files
             where form_id = p_form_id and deletion_requested_at is not null) then
    raise exception 'form has a pending attachment deletion' using errcode = '22023';
  end if;
  if exists (select 1 from public.member_form_files
             where form_id = p_form_id and confirmed_at is null) then
    raise exception 'form has an unfinished attachment' using errcode = '22023';
  end if;
  if exists (select 1 from public.member_form_files ff
             where ff.form_id = p_form_id and ff.deletion_requested_at is null
               and not private.private_upload_is_current(ff.bucket_id, ff.object_name)) then
    raise exception 'form has an attachment without a current inspection' using errcode = '22023';
  end if;
  current_digest := private.form_content_digest(p_form_id);
  select content_digest, signature_digest, strokes into signature
    from private.member_form_signatures
    where form_id = p_form_id and signer_kind = 'filer' and signer_user_id = rec.user_id;
  if signature.signature_digest is null
     or signature.content_digest <> current_digest
     or signature.signature_digest <> private.form_signature_digest(
       current_digest, rec.user_id, signature.strokes) then
    raise exception 'form does not have a current filer signature' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.member_form_cosigners c
    where c.form_id = p_form_id and c.status = 'accepted'
      and (c.signature_digest is null or not exists (
        select 1 from private.member_form_signatures s
        where s.cosigner_id = c.id and s.signer_kind = 'cosigner'
          and s.content_digest = current_digest
          and s.signature_digest = c.signature_digest
          and s.signature_digest = private.form_signature_digest(
            current_digest, c.id, s.strokes)
      ))
  ) then
    raise exception 'form has an invalid co-signature' using errcode = '22023';
  end if;
  frozen_digest := private.form_artifact_digest(
    p_form_id, current_digest, signature.signature_digest,
    clean_note, caller, approved_time);
  update public.member_forms set
    status = 'approved', review_note = clean_note, reviewed_by = caller,
    reviewed_at = approved_time, content_digest = current_digest,
    artifact_digest = frozen_digest, artifact_approved_at = approved_time,
    artifact_approved_by = caller, updated_at = approved_time
  where id = p_form_id and private.member_form_case_readable(p_form_id);
  if rec.lang = 'es' then
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Formulario aprobado',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang)
        || ' — revisado y aprobado por tu delegado. Ya puedes descargar tu copia oficial de Union Base.'
        || coalesce(' Nota: ' || clean_note, ''), 'forms');
  else
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Form approved',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang)
        || ' — reviewed and approved by your steward. Your Union Base official filing copy is ready to download.'
        || coalesce(' Note: ' || clean_note, ''), 'forms');
  end if;
  return pg_catalog.jsonb_build_object(
    'formId', p_form_id, 'status', 'approved',
    'artifactDigest', frozen_digest, 'approvedAt', approved_time);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.open_form_as_case(p_form_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  caller uuid := (select auth.uid());
  rec record;
  new_case uuid;
  ref text;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  select f.id, f.user_id, f.status, f.template_key, f.template_version, f.answers, f.case_id, coalesce(p.language, 'en') as lang into rec
    from (select scope_form.* from public.member_forms scope_form where private.member_form_scope_and_identity_allowed(scope_form)) f
    left join public.member_profiles p on p.id = f.user_id
    where f.id = p_form_id for update of f;
  -- Not-found, the caller's own form, member-private states (draft/returned
  -- are never steward-visible), and out-of-chapter-scope targets all collapse
  -- to one generic error so a steward holding a guessed form UUID cannot use
  -- the status-specific raises below as an existence oracle for another
  -- member's in-progress filing.
  if not found or rec.user_id = caller or rec.status in ('draft', 'returned')
     or not public.staff_can_see_user(rec.user_id, 'steward') then
    raise exception 'form not found or your own' using errcode = '22023';
  end if;
  if rec.status <> 'approved' then
    raise exception 'only approved forms can be opened as cases' using errcode = '22023';
  end if;
  if rec.template_key not in ('grievance', 'alliance_grievance') then
    raise exception 'only grievance forms can be opened as cases' using errcode = '22023';
  end if;
  if rec.case_id is not null then
    raise exception 'this form already has a case' using errcode = '22023';
  end if;

  -- server-generated reference (pre-mortem #3): the form id is member-visible,
  -- so a member could pre-insert its derived reference and permanently block
  -- this call. A fresh uuid is unknowable to the member; 8 hex chars kill the
  -- intra-user birthday collision. The case_id-null guard makes this
  -- single-shot, and any residual unique_violation surfaces as a clean error
  -- rather than a duplicate case. No action-log write here: steward actions
  -- never mint member points.
  new_case := extensions.gen_random_uuid();
  ref := 'GR-' || pg_catalog.to_char(now(), 'YYYY') || '-F' || pg_catalog.substr(pg_catalog.replace(new_case::text, '-', ''), 1, 8);
  begin
    insert into public.member_cases (id, user_id, reference, title, case_type, articles, step)
    values (
      new_case,
      rec.user_id,
      ref,
      coalesce(nullif(pg_catalog.btrim(pg_catalog.left(coalesce(rec.answers->>'summary', ''), 200)), ''), 'Grievance from submitted form'),
      'Grievance',
      pg_catalog.btrim(pg_catalog.left(coalesce(rec.answers->>'articles', ''), 200)),
      'Intake')
    returning id into new_case;
  exception when unique_violation then
    raise exception 'a case with this reference already exists for the member' using errcode = '23505';
  end;

  update public.member_forms set case_id = new_case, updated_at = now() where id = p_form_id and private.member_form_case_readable(p_form_id);

  if rec.lang = 'es' then
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Caso de queja abierto',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang) || ' — tu delegado abrió el caso ' || ref || ' a partir de tu formulario aprobado. Síguelo en Casos.', 'cases');
  else
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Grievance case opened',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang) || ' — your steward opened case ' || ref || ' from your approved form. Track it under Cases.', 'cases');
  end if;

  return new_case;
end;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.can_access_form_filing(p_form_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (select auth.uid()) is not null and private.mfa_satisfied()
    and not private.member_pin_session_restricted()
    and exists (
      select 1 from (select scope_form.* from public.member_forms scope_form where private.member_form_scope_and_identity_allowed(scope_form)) f
      where f.id = p_form_id and f.status = 'approved'
        and (f.user_id = (select auth.uid())
          or (public.member_has_role(array['steward'])
            and public.staff_can_see_user(f.user_id, 'steward')))
    );
$function$;

CREATE OR REPLACE FUNCTION public.get_form_filing_status(p_form_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  rec record;
  current_digest text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select f.* into rec from (select scope_form.* from public.member_forms scope_form where private.member_form_scope_and_identity_allowed(scope_form)) f where f.id = p_form_id;
  if not found or not (public.form_is_owned_by_caller(p_form_id)
    or (rec.status in ('submitted', 'in_review', 'approved')
      and public.member_has_role(array['steward'])
      and public.staff_can_see_user(rec.user_id, 'steward'))) then
    raise exception 'form unavailable' using errcode = '22023';
  end if;
  current_digest := private.form_content_digest(p_form_id);
  return pg_catalog.jsonb_build_object(
    'formId', rec.id, 'status', rec.status,
    'filerSigned', exists (select 1 from private.member_form_signatures s
      where s.form_id = rec.id and s.signer_kind = 'filer'
        and s.signer_user_id = rec.user_id and s.content_digest = current_digest),
    'filerSignedAt', rec.filer_signed_at,
    'contentDigest', rec.content_digest,
    'artifactDigest', rec.artifact_digest,
    'artifactApprovedAt', rec.artifact_approved_at,
    'attachments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', ff.id, 'bucketId', ff.bucket_id, 'objectName', ff.object_name,
      'filename', ff.filename, 'mimeType', ff.mime_type,
      'sizeBytes', ff.size_bytes, 'confirmedAt', ff.confirmed_at,
      'scanCurrent', private.private_upload_is_current(ff.bucket_id, ff.object_name))
      order by ff.created_at, ff.id) from public.member_form_files ff
      where ff.form_id = rec.id), '[]'::jsonb));
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_form_filing_payload(p_form_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  payload jsonb;
  rec record;
  current_digest text;
  filer_digest text;
  revalidated_digest text;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select f.*, p.chapter_id as owner_chapter into rec
  from (select scope_form.* from public.member_forms scope_form where private.member_form_actor_scope_and_identity_allowed(p_user_id,scope_form)) f
  left join public.member_profiles p on p.id = f.user_id
  where p_user_id is not null
    and f.id = p_form_id
    and f.status = 'approved'
    and f.artifact_digest is not null
    and (f.user_id = p_user_id or exists (
      select 1 from public.member_roles r
      where r.user_id = p_user_id
        and r.role = 'steward'
        and (r.chapter_id is null or r.chapter_id = p.chapter_id)
    ));
  if not found then raise exception 'filing unavailable' using errcode = '22023'; end if;

  current_digest := private.form_content_digest(p_form_id);
  select s.signature_digest into filer_digest
  from private.member_form_signatures s
  where s.form_id = p_form_id
    and s.signer_kind = 'filer'
    and s.signer_user_id = rec.user_id
    and s.content_digest = current_digest
    and s.signature_digest = rec.filer_signature_digest
    and s.signature_digest = private.form_signature_digest(
      current_digest, rec.user_id, s.strokes);
  if current_digest is null
     or rec.content_digest is distinct from current_digest
     or filer_digest is null then
    raise exception 'filing integrity check failed' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.member_form_cosigners c
    where c.form_id = p_form_id and c.status = 'accepted'
      and (c.signature_digest is null or not exists (
        select 1 from private.member_form_signatures s
        where s.cosigner_id = c.id
          and s.signer_kind = 'cosigner'
          and s.signature_digest = c.signature_digest
          and s.content_digest = current_digest
          and s.signature_digest = private.form_signature_digest(
            current_digest, c.id, s.strokes)
      ))
  ) then
    raise exception 'filing integrity check failed' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.member_form_files ff
    where ff.form_id = p_form_id and ff.confirmed_at is not null
      and ff.deletion_requested_at is null
      and not private.private_upload_is_current(ff.bucket_id, ff.object_name)
  ) then
    raise exception 'filing integrity check failed' using errcode = '22023';
  end if;
  revalidated_digest := private.form_artifact_digest(
    p_form_id, current_digest, filer_digest, rec.review_note,
    rec.artifact_approved_by, rec.artifact_approved_at);
  if rec.artifact_digest is distinct from revalidated_digest then
    raise exception 'filing integrity check failed' using errcode = '22023';
  end if;

  select pg_catalog.jsonb_build_object(
    'form', pg_catalog.to_jsonb(f),
    'template', pg_catalog.to_jsonb(t),
    'filer', pg_catalog.jsonb_build_object('id', p.id, 'name', p.full_name),
    'filerSignature', (select pg_catalog.jsonb_build_object(
      'strokes', s.strokes, 'signedAt', s.consented_at,
      'signatureDigest', s.signature_digest)
      from private.member_form_signatures s
      where s.form_id = f.id and s.signer_kind = 'filer'
        and s.signature_digest = f.filer_signature_digest
        and s.content_digest = f.content_digest),
    'cosigners', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id, 'email', c.invited_email, 'status', c.status,
      'signedAt', c.signed_at, 'signatureDigest', c.signature_digest,
      'strokes', cs.strokes)
      order by c.invited_at, c.id)
      from public.member_form_cosigners c
      left join private.member_form_signatures cs on cs.cosigner_id = c.id
        and cs.signature_digest = c.signature_digest
        and cs.content_digest = f.content_digest
      where c.form_id = f.id), '[]'::jsonb),
    'attachments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ff)
      order by ff.created_at, ff.id) from public.member_form_files ff
      where ff.form_id = f.id and ff.confirmed_at is not null
        and private.private_upload_is_current(ff.bucket_id, ff.object_name)), '[]'::jsonb),
    'approval', pg_catalog.jsonb_build_object(
      'approvedBy', f.artifact_approved_by, 'approvedAt', f.artifact_approved_at,
      'reviewerName', rp.full_name, 'note', f.review_note,
      'artifactDigest', f.artifact_digest)
  ) into payload
  from (select scope_form.* from public.member_forms scope_form where private.member_form_actor_scope_and_identity_allowed(p_user_id,scope_form)) f
  join public.form_templates t on t.key = f.template_key and t.version = f.template_version
  left join public.member_profiles p on p.id = f.user_id
  left join public.member_profiles rp on rp.id = f.artifact_approved_by
  where p_user_id is not null
    and f.id = p_form_id
    and f.status = 'approved'
    and f.artifact_digest is not null
    and (f.user_id = p_user_id or exists (
      select 1 from public.member_roles r
      where r.user_id = p_user_id
        and r.role = 'steward'
         and (r.chapter_id is null or r.chapter_id = p.chapter_id)
     ));
  if payload is null then raise exception 'filing unavailable' using errcode = '22023'; end if;
  return payload;
end
$function$;

create function public.save_scoped_institutional_record(
  p_record_id uuid,
  p_record_type text,
  p_title text,
  p_body text,
  p_occurred_at timestamptz,
  p_visibility text default 'chapter',
  p_action text default 'save',
  p_pinned boolean default false,
  p_gap_note text default null,
  p_expected_version integer default null,
  p_attendance jsonb default '[]'::jsonb,
  p_access_unit_id uuid default null,
  p_access_committee_id uuid default null,
  p_expected_chapter text default null,
  p_expected_organization uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
declare
  ctx record;
  target public.chapter_records%rowtype;
  next_status text;
  next_version integer;
  attendee jsonb;
  recipient record;
  delivered integer := 0;
begin
  if not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:'||private.current_member_organization()::text,509));
  select * into ctx from private.institutional_context(false);
  if (p_expected_chapter is not null and p_expected_chapter is distinct from ctx.chapter_id)
    or (p_expected_organization is not null and p_expected_organization is distinct from ctx.organization_id) then
    raise exception 'chapter context changed' using errcode='42501';
  end if;
  if not private.chapter_record_manageable(ctx.chapter_id,p_access_unit_id,p_access_committee_id)
    or (p_access_unit_id is not null and p_access_committee_id is not null)
    or (p_access_unit_id is not null and not exists(select 1 from private.chapter_units where id=p_access_unit_id and chapter_id=ctx.chapter_id))
    or (p_access_committee_id is not null and not exists(select 1 from private.chapter_committees where id=p_access_committee_id and chapter_id=ctx.chapter_id)) then
    raise exception 'record outside access scope' using errcode='42501';
  end if;
  if p_record_type in ('management_contact','member_contact') and not private.can_read_chapter_contact_record(ctx.chapter_id) then raise exception 'contact access required' using errcode='42501'; end if;
  if p_record_type not in ('minutes','decision','milestone','management_contact','member_contact')
     or p_visibility not in ('chapter','staff')
     or p_action not in ('save','publish','archive')
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title, ''))) not between 1 and 200
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_body, ''))) not between 1 and 20000
     or p_occurred_at is null
     or pg_catalog.char_length(coalesce(p_gap_note, '')) > 1000
     or pg_catalog.jsonb_typeof(coalesce(p_attendance, '[]'::jsonb)) <> 'array'
     or pg_catalog.jsonb_array_length(coalesce(p_attendance, '[]'::jsonb)) > 1000 then
    raise exception 'invalid institutional record' using errcode = '22023';
  end if;

  next_status := case p_action when 'publish' then 'published' when 'archive' then 'archived' else 'draft' end;
  if p_record_id is null then
    insert into public.chapter_records (
      chapter_id, record_type, title, body, occurred_at, created_by,
      lifecycle_status, visibility, version, published_at, updated_at, pinned_at, gap_note, archived_at, access_unit_id, access_committee_id
    ) values (
      ctx.chapter_id, p_record_type, pg_catalog.btrim(p_title), pg_catalog.btrim(p_body), p_occurred_at, ctx.caller_id,
      next_status, p_visibility, 1,
      case when next_status = 'published' then pg_catalog.now() end,
      pg_catalog.now(), case when p_pinned then pg_catalog.now() end, nullif(pg_catalog.btrim(p_gap_note), ''),
      case when next_status = 'archived' then pg_catalog.now() end, p_access_unit_id, p_access_committee_id
    ) returning * into target;
  else
    select * into target from public.chapter_records r
    where r.id = p_record_id and r.chapter_id = ctx.chapter_id
    for update;
    if target.id is null then raise exception 'record not found' using errcode = 'P0002'; end if;
    if not private.chapter_record_manageable(target.chapter_id,target.access_unit_id,target.access_committee_id)
      or (target.record_type in ('management_contact','member_contact') and not private.can_read_chapter_contact_record(ctx.chapter_id)) then
      raise exception 'record outside access scope' using errcode='42501';
    end if;
    if p_expected_version is null or target.version <> p_expected_version then
      raise exception 'record changed; reload before saving' using errcode = '40001';
    end if;
    next_version := target.version + 1;
    update public.chapter_records r set
      access_unit_id=p_access_unit_id, access_committee_id=p_access_committee_id,
      record_type = p_record_type,
      title = pg_catalog.btrim(p_title),
      body = pg_catalog.btrim(p_body),
      occurred_at = p_occurred_at,
      lifecycle_status = next_status,
      visibility = p_visibility,
      version = next_version,
      published_at = case when next_status = 'published' then pg_catalog.now() else r.published_at end,
      updated_at = pg_catalog.now(),
      pinned_at = case when p_pinned then coalesce(r.pinned_at, pg_catalog.now()) end,
      gap_note = nullif(pg_catalog.btrim(p_gap_note), ''),
      archived_at = case when next_status = 'archived' then pg_catalog.now() end
    where r.id = target.id
    returning * into target;
  end if;

  insert into public.chapter_record_versions (
    record_id, chapter_id, version, record_type, title, body, occurred_at,
    lifecycle_status, visibility, gap_note, changed_by
  ) values (
    target.id, target.chapter_id, target.version, target.record_type, target.title, target.body,
    target.occurred_at, target.lifecycle_status, target.visibility, target.gap_note, ctx.caller_id
  );

  delete from public.meeting_attendance where record_id = target.id;
  if target.record_type = 'minutes' then
    for attendee in select value from pg_catalog.jsonb_array_elements(p_attendance)
    loop
      if attendee->>'status' not in ('present','absent','excused','guest') or not exists (
        select 1 from public.member_chapter_memberships cm
        where cm.chapter_id = ctx.chapter_id and cm.user_id = (attendee->>'userId')::uuid and cm.status = 'active'
          and private.chapter_scope_member_allowed(ctx.chapter_id,p_access_unit_id,p_access_committee_id,cm.user_id)
      ) then raise exception 'invalid meeting attendance' using errcode = '22023'; end if;
      insert into public.meeting_attendance (record_id, chapter_id, user_id, attendance_status, recorded_by)
      values (target.id, ctx.chapter_id, (attendee->>'userId')::uuid, attendee->>'status', ctx.caller_id);
    end loop;

    if p_action = 'publish' and target.visibility = 'chapter' then
      for recipient in
        select cm.user_id from public.member_chapter_memberships cm
        join public.organization_memberships om on om.user_id = cm.user_id and om.organization_id = ctx.organization_id and om.status = 'active'
        where cm.chapter_id = ctx.chapter_id and cm.status = 'active'
          and private.chapter_scope_member_allowed(ctx.chapter_id,p_access_unit_id,p_access_committee_id,cm.user_id)
      loop
        begin
          perform private.notify_member(recipient.user_id, 'institutional.minutes.published', pg_catalog.jsonb_build_object('title', target.title), 'general');
          insert into public.meeting_minutes_dispatches (record_id, chapter_id, version, recipient_id, status, delivered_at)
          values (target.id, ctx.chapter_id, target.version, recipient.user_id, 'delivered', pg_catalog.now());
          delivered := delivered + 1;
        exception when others then
          insert into public.meeting_minutes_dispatches (record_id, chapter_id, version, recipient_id, status, error_code)
          values (target.id, ctx.chapter_id, target.version, recipient.user_id, 'failed', 'notification-write-failed');
        end;
      end loop;
    end if;
  end if;

  return pg_catalog.to_jsonb(target) || pg_catalog.jsonb_build_object('delivered', delivered);
end;
end;
$function$;

revoke all on function public.save_scoped_institutional_record(uuid,text,text,text,timestamptz,text,text,boolean,text,integer,jsonb,uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.save_scoped_institutional_record(uuid,text,text,text,timestamptz,text,text,boolean,text,integer,jsonb,uuid,uuid,text,uuid) to authenticated;

create or replace function public.save_institutional_record(p_record_id uuid,p_record_type text,p_title text,p_body text,p_occurred_at timestamptz,p_visibility text default 'chapter',p_action text default 'save',p_pinned boolean default false,p_gap_note text default null,p_expected_version integer default null,p_attendance jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
declare scope_unit uuid; scope_committee uuid;
begin
  if not private.mfa_satisfied() then raise exception 'authentication required' using errcode='42501'; end if;
  select access_unit_id,access_committee_id into scope_unit,scope_committee from public.chapter_records where id=p_record_id and chapter_id=private.current_member_chapter();
  return public.save_scoped_institutional_record(p_record_id,p_record_type,p_title,p_body,p_occurred_at,p_visibility,p_action,p_pinned,p_gap_note,p_expected_version,p_attendance,scope_unit,scope_committee);
end;
end;
$function$;
revoke all on function public.save_institutional_record(uuid,text,text,text,timestamptz,text,text,boolean,text,integer,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.save_institutional_record(uuid,text,text,text,timestamptz,text,text,boolean,text,integer,jsonb) to authenticated;

-- Secretary and records-only permissions are a narrowly named capability.
-- They do not become general staff publishers or acquire contact-log access.
create policy chapter_documents_officer_read on public.chapter_documents for select to authenticated
  using(chapter_id=private.current_member_chapter() and private.chapter_officer_can_for_scope(chapter_id,'documents',access_unit_id,access_committee_id));
create policy chapter_documents_officer_create on public.chapter_documents for insert to authenticated
  with check(chapter_id=private.current_member_chapter() and created_by=(select auth.uid()) and private.chapter_officer_can_for_scope(chapter_id,'documents',access_unit_id,access_committee_id));
create policy chapter_documents_officer_write on public.chapter_documents for update to authenticated
  using(chapter_id=private.current_member_chapter() and private.chapter_officer_can_for_scope(chapter_id,'documents',access_unit_id,access_committee_id))
  with check(chapter_id=private.current_member_chapter() and private.chapter_officer_can_for_scope(chapter_id,'documents',access_unit_id,access_committee_id));

create policy chapter_records_officer_read on public.chapter_records for select to authenticated
  using(private.chapter_record_publication(record_type)='chapter_members' and private.chapter_officer_can_for_scope(chapter_id,'records',access_unit_id,access_committee_id));

-- The helper is invoked from policies but stays outside the exposed schema.
grant execute on function private.chapter_officer_can(text,text) to authenticated;

alter policy chapter_documents_read on public.chapter_documents using ((((chapter_id = private.current_member_chapter()) AND (((status = 'published'::text) AND ((visibility = 'chapter'::text) OR private.member_has_chapter_role(chapter_id,ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]))) OR private.member_has_chapter_role(chapter_id,ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]))) OR ((status = 'published'::text) AND private.member_has_chapter_role(private.current_member_chapter(), ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]) AND (EXISTS ( SELECT 1
   FROM (public.chapter_handshake_documents hd
     JOIN public.chapter_handshakes h ON ((h.id = hd.handshake_id)))
  WHERE ((hd.document_id = chapter_documents.id) AND (h.status = 'active'::text) AND ((private.current_member_chapter() = h.chapter_id) OR (private.current_member_chapter() = h.receiving_chapter_id))))))));
alter policy chapter_documents_staff_create on public.chapter_documents with check (((chapter_id = private.current_member_chapter()) AND (created_by = ( SELECT auth.uid() AS uid)) AND private.member_has_chapter_role(chapter_id,ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text])));
alter policy chapter_documents_staff_write on public.chapter_documents using (((chapter_id = private.current_member_chapter()) AND private.member_has_chapter_role(chapter_id,ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]))) with check (((chapter_id = private.current_member_chapter()) AND private.member_has_chapter_role(chapter_id,ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text])));

create policy member_form_files_explicit_draft_share on public.member_form_files for select to authenticated
  using(exists(select 1 from public.member_forms f where f.id=form_id and private.member_draft_shared_to_caller(f)));

-- Historical bodies remain RPC-only. The workspace projects versions only
-- when chapter_record_manageable authorizes their parent scope.

-- Backfill only an explicit unit selected on an accepted invitation or its
-- exact replacement chain; never infer a unit from free-text worksite labels.
with recursive chain(accepted_id,id,replaces_id,user_id,chapter_id,depth) as (
  select i.id,i.id,i.replaces_id,i.auth_user_id,i.chapter_id,0
  from public.member_invitations i where i.auth_user_id is not null and i.status='accepted'
  union all
  select chain.accepted_id,i.id,i.replaces_id,chain.user_id,chain.chapter_id,chain.depth+1
  from chain join public.member_invitations i on i.id=chain.replaces_id
  where chain.depth<20 and i.chapter_id=chain.chapter_id
), selected as (
  select distinct on(chain.accepted_id) chain.user_id,chain.chapter_id,u.id unit_id
  from chain join private.member_invitation_units link on link.invitation_id=chain.id
  join private.chapter_units u on u.id=link.unit_id and u.chapter_id=chain.chapter_id
  join public.member_chapter_memberships m on m.user_id=chain.user_id and m.chapter_id=chain.chapter_id and m.status='active'
  order by chain.accepted_id,chain.depth
)
insert into private.chapter_unit_members(unit_id,chapter_id,user_id)
  select unit_id,chapter_id,user_id from selected on conflict do nothing;

create function public.get_chapter_access_workspace(p_chapter text,p_member_page integer default 0,p_unit_page integer default 0,p_committee_page integer default 0,p_query text default '')
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
begin
  if not private.mfa_satisfied() or not private.chapter_access_leadership(p_chapter) then raise exception 'chapter leadership required' using errcode='42501'; end if;
  if p_member_page is null or p_unit_page is null or p_committee_page is null
    or p_member_page not between 0 and 10000 or p_unit_page not between 0 and 10000 or p_committee_page not between 0 and 10000
    or pg_catalog.char_length(coalesce(p_query,''))>120 then raise exception 'invalid access page' using errcode='22023'; end if;
  return (with members as materialized (
    select m.user_id,p.full_name from public.member_chapter_memberships m join public.member_profiles p on p.id=m.user_id
    join public.organization_memberships om on om.user_id=m.user_id and om.organization_id=private.current_member_organization() and om.status='active'
    where m.chapter_id=p_chapter and m.status='active' and p.full_name ilike '%'||coalesce(p_query,'')||'%'
    order by m.user_id limit 31 offset p_member_page*30
  ), visible_members as materialized (select * from members order by user_id limit 30),
  units as materialized (select * from private.chapter_units where chapter_id=p_chapter order by id limit 31 offset p_unit_page*30),
  committees as materialized (select * from private.chapter_committees where chapter_id=p_chapter order by id limit 31 offset p_committee_page*30)
  select pg_catalog.jsonb_build_object(
    'chapterId',p_chapter,'memberPage',p_member_page,'unitPage',p_unit_page,'committeePage',p_committee_page,
    'grantableRoles',(select pg_catalog.jsonb_agg(role order by role) from (
      select distinct role from private.chapter_role_capabilities where role not in ('steward','coordinator','advisor','admin','vp')
      union select value from pg_catalog.unnest(case when private.member_has_chapter_role(p_chapter,array['admin']) or private.has_organization_role(private.current_member_organization(),array['admin']) then array['steward','coordinator','advisor','admin','vp'] else array[]::text[] end) value) allowed),
    'hasMoreMembers',(select pg_catalog.count(*)>30 from members),
    'hasMoreUnits',(select pg_catalog.count(*)>30 from units),
    'hasMoreCommittees',(select pg_catalog.count(*)>30 from committees),
    'policy',coalesce((select pg_catalog.to_jsonb(p) from private.chapter_access_policies p where chapter_id=p_chapter),pg_catalog.jsonb_build_object('steward_grievances',true,'steward_breadth','chapter')),
    'roles',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('role',role,'capability',capability) order by role,capability) from private.chapter_role_capabilities where role not in ('steward','coordinator','advisor','admin','vp')),
    'settings',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s)) from private.chapter_role_settings s where s.chapter_id=p_chapter),'[]'::jsonb),
    'members',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',m.user_id,'name',m.full_name) order by m.user_id) from visible_members m),'[]'::jsonb),
    'grants',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('userId',r.user_id,'role',r.role,'unitId',s.unit_id,'committeeId',s.committee_id,
      'scopeName',coalesce((select name from private.chapter_units u where u.id=s.unit_id),(select name from private.chapter_committees c where c.id=s.committee_id))))
      from public.member_role_chapters r join visible_members m on m.user_id=r.user_id
      left join private.chapter_role_scopes s on s.user_id=r.user_id and s.chapter_id=r.chapter_id and s.role=r.role where r.chapter_id=p_chapter),'[]'::jsonb),
    'units',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',u.id,'name',u.name,
      'members',coalesce((select pg_catalog.jsonb_agg(m.user_id) from private.chapter_unit_members m join visible_members v on v.user_id=m.user_id where m.unit_id=u.id),'[]'::jsonb)) order by u.id)
      from (select * from units order by id limit 30) u),'[]'::jsonb),
    'committees',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c)||pg_catalog.jsonb_build_object('members',coalesce((select pg_catalog.jsonb_agg(m.user_id) from private.chapter_committee_members m join visible_members v on v.user_id=m.user_id where m.committee_id=c.id),'[]'::jsonb)) order by c.id)
      from (select * from committees order by id limit 30) c),'[]'::jsonb)
  ));
end;
$function$;
revoke all on function public.get_chapter_access_workspace(text,integer,integer,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.get_chapter_access_workspace(text,integer,integer,integer,text) to authenticated;

create function public.create_chapter_office_document(p_chapter text,p_title text,p_body text,p_summary text,p_unit uuid default null,p_committee uuid default null,p_published boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
declare document public.chapter_documents%rowtype;
begin
  if not private.mfa_satisfied() or private.member_pin_session_restricted()
    or p_chapter is distinct from private.current_member_chapter()
    or not private.chapter_officer_can_for_scope(p_chapter,'documents',p_unit,p_committee) then
    raise exception 'document access required' using errcode='42501';
  end if;
  if p_unit is not null and p_committee is not null then raise exception 'choose one document scope' using errcode='22023'; end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title,''))) not between 1 and 200
    or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_body,''))) not between 1 and 100000
    or pg_catalog.char_length(coalesce(p_summary,''))>1000 then raise exception 'invalid document content' using errcode='22023'; end if;
  insert into public.chapter_documents(chapter_id,title,body,summary,document_type,visibility,status,published_at,created_by,access_unit_id,access_committee_id)
  values(p_chapter,pg_catalog.btrim(p_title),pg_catalog.btrim(p_body),pg_catalog.btrim(coalesce(p_summary,'')),'other','chapter',case when coalesce(p_published,false) then 'published' else 'draft' end,
    case when coalesce(p_published,false) then pg_catalog.now() end,(select auth.uid()),p_unit,p_committee)
  returning * into document;
  return pg_catalog.to_jsonb(document);
end;
end;
$function$;
revoke all on function public.create_chapter_office_document(text,text,text,text,uuid,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function public.create_chapter_office_document(text,text,text,text,uuid,uuid,boolean) to authenticated;

create function public.list_chapter_office_documents(p_chapter text,p_page integer default 0)
returns jsonb language plpgsql stable security invoker set search_path = '' as $function$
begin
  if p_page is null or p_page not between 0 and 10000 or p_chapter is distinct from private.current_member_chapter() then raise exception 'invalid office page' using errcode='22023'; end if;
  return coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(document)) from (
    select d.* from public.chapter_documents d where d.chapter_id=p_chapter
      and private.chapter_officer_can_for_scope(d.chapter_id,'documents',d.access_unit_id,d.access_committee_id)
    order by d.updated_at desc,d.id limit 21 offset p_page*20) document),'[]'::jsonb);
end;
$function$;
revoke all on function public.list_chapter_office_documents(text,integer) from public,anon,authenticated,service_role;
grant execute on function public.list_chapter_office_documents(text,integer) to authenticated;


CREATE OR REPLACE FUNCTION public.get_minutes_pre_event_notices()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  ctx record;
begin
  if not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into ctx from private.institutional_context(true);
  return pg_catalog.jsonb_build_object(
    'enabled', private.organization_feature_enabled(ctx.organization_id, 'features.automation.minutes_pre_event_notice'),
    'defaultHours', private.organization_limit(ctx.organization_id, 'limits.automation.minutes_pre_event_hours'),
    'notices', coalesce((
      select pg_catalog.jsonb_agg(private.minutes_pre_event_notice_json(n) order by n.updated_at desc)
      from private.meeting_minutes_event_notices n
      where n.organization_id = ctx.organization_id and n.chapter_id = ctx.chapter_id
        and exists(select 1 from public.chapter_records r where r.id=n.record_id and private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id))
    ), '[]'::jsonb),
    'events', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', upcoming.id, 'title', upcoming.title, 'startsAt', upcoming.starts_at
      ) order by upcoming.starts_at, upcoming.id)
      from (
        select e.id, e.title, e.starts_at
        from public.member_events e
        where e.chapter_id = ctx.chapter_id
          and e.cancelled_at is null
          and e.starts_at > pg_catalog.now()
        order by e.starts_at, e.id
        limit 50
      ) upcoming
    ), '[]'::jsonb)
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.save_minutes_pre_event_notice(p_record_id uuid, p_event_id text, p_audience text, p_hours_before integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  ctx record;
  target public.chapter_records%rowtype;
  meeting public.member_events%rowtype;
  existing private.meeting_minutes_event_notices%rowtype;
  saved private.meeting_minutes_event_notices%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into ctx from private.institutional_context(true);
  if not private.organization_feature_enabled(ctx.organization_id, 'features.automation.minutes_pre_event_notice') then
    raise exception 'pre-meeting notices are turned off for this organization' using errcode = '42501';
  end if;
  if p_audience is null or p_audience not in ('all_members', 'stewards_only')
     or (p_hours_before is not null and p_hours_before not between 1 and 336) then
    raise exception 'invalid pre-meeting notice' using errcode = '22023';
  end if;

  select * into target from public.chapter_records r
  where r.id = p_record_id and r.chapter_id = ctx.chapter_id
    and private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id)
  for update;
  if target.id is null or target.record_type <> 'minutes' or target.archived_at is not null then
    raise exception 'minutes record not found' using errcode = 'P0002';
  end if;
  -- Members can only open a chapter-visible record, so a staff-only record can
  -- only be announced to staff.
  if p_audience = 'all_members' and target.visibility <> 'chapter' then
    raise exception 'a staff-only record can only be announced to stewards' using errcode = '22023';
  end if;

  select * into meeting from public.member_events e
  where e.id = p_event_id and e.chapter_id = ctx.chapter_id;
  if meeting.id is null or meeting.cancelled_at is not null or meeting.starts_at <= pg_catalog.now() then
    raise exception 'upcoming meeting not found' using errcode = 'P0002';
  end if;

  select * into existing from private.meeting_minutes_event_notices n
  where n.record_id = target.id
  for update;
  if existing.record_id is not null and existing.status = 'sent' and existing.event_id = meeting.id then
    raise exception 'this notice was already sent for that meeting' using errcode = '22023';
  end if;

  insert into private.meeting_minutes_event_notices (
    record_id, organization_id, chapter_id, event_id, audience, hours_before
  ) values (
    target.id, ctx.organization_id, ctx.chapter_id, meeting.id, p_audience, p_hours_before
  )
  on conflict (record_id) do update set
    event_id = excluded.event_id,
    audience = excluded.audience,
    hours_before = excluded.hours_before,
    status = 'scheduled',
    outcome = null,
    recipient_count = 0,
    failed_count = 0,
    processed_at = null,
    updated_at = pg_catalog.now()
  returning * into saved;

  return private.minutes_pre_event_notice_json(saved);
end;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.clear_minutes_pre_event_notice(p_record_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  ctx record;
  removed integer;
begin
  if not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into ctx from private.institutional_context(true);
  delete from private.meeting_minutes_event_notices n
  where n.record_id = p_record_id
    and n.organization_id = ctx.organization_id
    and n.chapter_id = ctx.chapter_id
    and exists(select 1 from public.chapter_records r where r.id=n.record_id and private.chapter_record_manageable(r.chapter_id,r.access_unit_id,r.access_committee_id));
  get diagnostics removed = row_count;
  return pg_catalog.jsonb_build_object('recordId', p_record_id, 'removed', removed > 0);
end;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.attach_minutes_to_meeting(p_record_id uuid, p_event_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  ctx record;
  rec public.chapter_records%rowtype;
  target public.member_events%rowtype;
  clean_event text := nullif(pg_catalog.btrim(coalesce(p_event_id, '')), '');
begin
  -- Same assurance gate as save_institutional_record, ahead of the context.
  if not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into ctx from private.institutional_context(true);

  select * into rec from public.chapter_records
  where id = p_record_id and chapter_id = ctx.chapter_id
    and record_type = 'minutes' and archived_at is null
    and private.chapter_record_manageable(chapter_id,access_unit_id,access_committee_id)
  for update;
  if not found then
    raise exception 'unknown minutes record' using errcode = '22023';
  end if;

  if clean_event is not null then
    select * into target from public.member_events
    where id = clean_event and chapter_id = ctx.chapter_id;
    if not found then
      raise exception 'unknown event' using errcode = '22023';
    end if;
  end if;

  if clean_event is distinct from rec.event_id then
    update public.chapter_records set event_id = clean_event
    where id = rec.id and chapter_id = ctx.chapter_id;

    -- Detaching names the meeting the record leaves.
    if clean_event is null then
      select * into target from public.member_events where id = rec.event_id;
    end if;
    insert into public.member_admin_audit (actor, action, detail)
    values (ctx.caller_id, 'update_event', pg_catalog.jsonb_build_object(
      'eventId', coalesce(clean_event, rec.event_id), 'title', target.title,
      'chapterId', ctx.chapter_id,
      'fields', pg_catalog.jsonb_build_array('minutes'),
      'recordId', rec.id, 'attached', clean_event is not null));
  end if;

  return pg_catalog.jsonb_build_object('updated', clean_event is distinct from rec.event_id, 'eventId', clean_event);
end;
end;
$function$
;

-- set_chapter_minutes_approval and get_minutes_meeting_checkins (20261030214501)
-- found the record by chapter alone; institutional_context now admits
-- unit- and committee-scoped records offices, so both also require the
-- record's own container (chapter_record_manageable), as attach does. The
-- check-ins listed are only those of members inside that container.
create or replace function public.set_chapter_minutes_approval(p_record_id uuid, p_expected_version integer, p_approved boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  ctx record;
  target public.chapter_records%rowtype;
begin
  select * into ctx from private.institutional_context(true);
  if p_approved is null then raise exception 'approval state required' using errcode = '22023'; end if;
  select * into target from public.chapter_records r
  where r.id = p_record_id and r.chapter_id = ctx.chapter_id
    and r.record_type = 'minutes' and r.archived_at is null
    and private.chapter_record_manageable(r.chapter_id, r.access_unit_id, r.access_committee_id)
  for update;
  if not found then raise exception 'minutes not found' using errcode = 'P0002'; end if;
  -- Approve or withdraw only what the approver was shown: a newer version
  -- refuses, so nobody approves an edit they have not read.
  if p_expected_version is distinct from target.version then
    raise exception 'minutes changed since they were opened' using errcode = '40001';
  end if;
  if p_approved and target.lifecycle_status <> 'published' then
    raise exception 'only published minutes can be approved' using errcode = '22023';
  end if;
  update public.chapter_records
  set approved_at = case
        when not p_approved then null
        when target.approved_version is not distinct from target.version then target.approved_at
        else pg_catalog.now() end,
      approved_by = case
        when not p_approved then null
        when target.approved_version is not distinct from target.version then target.approved_by
        else ctx.caller_id end,
      approved_version = case when p_approved then target.version else null end,
      updated_at = pg_catalog.now()
  where id = target.id
  returning * into target;
  return pg_catalog.jsonb_build_object(
    'id', target.id, 'approvedAt', target.approved_at, 'approvedBy', target.approved_by,
    'approvedVersion', target.approved_version, 'version', target.version);
end;
end;
$function$;

create or replace function public.get_minutes_meeting_checkins(p_record_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  ctx record;
  target public.chapter_records%rowtype;
begin
  select * into ctx from private.institutional_context(true);
  select * into target from public.chapter_records r
  where r.id = p_record_id and r.chapter_id = ctx.chapter_id
    and r.record_type = 'minutes' and r.archived_at is null
    and private.chapter_record_manageable(r.chapter_id, r.access_unit_id, r.access_committee_id);
  if not found then raise exception 'minutes not found' using errcode = 'P0002'; end if;
  return pg_catalog.jsonb_build_object(
    'eventId', target.event_id,
    'checkedIn', coalesce((
      select pg_catalog.jsonb_agg(checkin.user_id order by checkin.user_id)
      from (
        select distinct c.user_id
        from public.member_event_checkins c
        join public.member_events e on e.id = c.event_id and e.chapter_id = ctx.chapter_id
        join public.member_chapter_memberships cm
          on cm.user_id = c.user_id and cm.chapter_id = ctx.chapter_id and cm.status = 'active'
        where target.event_id is not null and c.event_id = target.event_id
          and private.chapter_scope_member_allowed(target.chapter_id, target.access_unit_id, target.access_committee_id, c.user_id)
      ) checkin
    ), '[]'::jsonb)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.dispatch_minutes_pre_event_notices(p_limit integer DEFAULT 200)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  notice record;
  recipient record;
  processed integer := 0;
  sent integer;
  failed integer;
  reason text;
begin
  for notice in
    select n.record_id, n.organization_id, n.chapter_id, n.audience,
      e.title as event_title, e.starts_at, e.cancelled_at,
      r.title as record_title, r.lifecycle_status, r.visibility, r.archived_at,
      r.access_unit_id, r.access_committee_id,
      private.organization_feature_enabled(n.organization_id, 'features.automation.minutes_pre_event_notice') as enabled
    from private.meeting_minutes_event_notices n
    join public.member_events e on e.id = n.event_id
    join public.chapter_records r on r.id = n.record_id
    where n.status = 'scheduled'
      and (
        e.cancelled_at is not null
        or e.starts_at <= pg_catalog.now()
        or e.starts_at - pg_catalog.make_interval(hours => coalesce(
          n.hours_before,
          private.organization_limit(n.organization_id, 'limits.automation.minutes_pre_event_hours')
        )) <= pg_catalog.now()
      )
    order by e.starts_at, n.record_id
    limit greatest(1, least(coalesce(p_limit, 200), 1000))
    for update of n,r skip locked
  loop
    reason := case
      when notice.cancelled_at is not null then 'event_cancelled'
      when notice.archived_at is not null or notice.lifecycle_status = 'archived' then 'record_archived'
      when notice.starts_at <= pg_catalog.now() and notice.lifecycle_status <> 'published' then 'record_not_published'
      when notice.starts_at <= pg_catalog.now() then 'event_started'
      when notice.audience = 'all_members' and notice.visibility <> 'chapter' then 'record_staff_only'
    end;
    if reason is null and (not notice.enabled or notice.lifecycle_status <> 'published') then
      continue;
    end if;
    if reason is not null then
      update private.meeting_minutes_event_notices
        set status = 'expired', outcome = reason, processed_at = pg_catalog.now(), updated_at = pg_catalog.now()
        where record_id = notice.record_id;
      processed := processed + 1;
      continue;
    end if;

    sent := 0;
    failed := 0;
    for recipient in
      select cm.user_id
      from public.member_chapter_memberships cm
      join public.organization_memberships om
        on om.user_id = cm.user_id
       and om.organization_id = notice.organization_id
       and om.status = 'active'
      where cm.chapter_id = notice.chapter_id
        and cm.status = 'active'
        and private.chapter_scope_recipient_allowed(notice.chapter_id,notice.access_unit_id,notice.access_committee_id,cm.user_id)
        and (notice.audience = 'all_members'
             or private.actor_has_chapter_staff_role(cm.user_id, notice.chapter_id))
    loop
      begin
        perform private.notify_member(
          recipient.user_id,
          'institutional.minutes.pre_event',
          pg_catalog.jsonb_build_object('record', notice.record_title, 'event', notice.event_title),
          'events'
        );
        sent := sent + 1;
      exception when others then
        failed := failed + 1;
      end;
    end loop;

    update private.meeting_minutes_event_notices
      set status = 'sent',
          outcome = case when sent + failed = 0 then 'no_audience' else 'delivered' end,
          recipient_count = sent,
          failed_count = failed,
          processed_at = pg_catalog.now(),
          updated_at = pg_catalog.now()
      where record_id = notice.record_id;
    processed := processed + 1;
  end loop;
  return processed;
end;
end;
$function$
;

-- Intake landed on Main while #6665 was in review. The body pins below
-- authenticate those four exact predecessors without copying its migration.
create function private.chapter_case_intake_role_allows(p_member uuid,p_role text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select private.mfa_satisfied() and not private.member_pin_session_restricted()
    and public.staff_can_see_user(p_member,p_role)
    and (not exists(select 1 from private.chapter_role_scopes scope
      join public.chapters c on c.id=scope.chapter_id
      where scope.user_id=(select auth.uid()) and scope.role=p_role
        and c.organization_id=private.current_member_organization())
      or exists(select 1 from public.member_profiles target
        where target.id=p_member and private.actor_role_covers_member((select auth.uid()),target.chapter_id,p_role,p_member,true)));
$function$;
revoke all on function private.chapter_case_intake_role_allows(uuid,text) from public,anon,authenticated,service_role;

do $intake_predecessor$ begin if (select md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.open_member_case(uuid,text,text,text,date,text,date,text,text,boolean)'::regprocedure) <> '44bfa17b9903962080ee41b2e4d7d823' then raise exception 'unreviewed intake predecessor: open_member_case' using errcode='55000'; end if; end; $intake_predecessor$;
create or replace function public.open_member_case(
  p_member_id uuid,
  p_title text,
  p_case_type text,
  p_articles text,
  p_deadline date,
  p_description text,
  p_incident_date date,
  p_remedy_sought text,
  p_filing_status text,
  p_assign_self boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
begin
  perform private.lock_message_lifecycle();
declare
  caller uuid;
  clean_title text;
  clean_articles text;
  clean_description text;
  clean_remedy text;
  steward_scope boolean;
  assign boolean;
  steward_label text;
  actor_label text;
  created jsonb;
  ref text;
  new_case uuid;
  attempts integer;
begin
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  clean_description := nullif(pg_catalog.btrim(coalesce(p_description, '')), '');
  clean_remedy := nullif(pg_catalog.btrim(coalesce(p_remedy_sought, '')), '');
  -- Bounds are raised, never clipped, as in public.create_member_case.
  if pg_catalog.char_length(clean_description) > 10000 then
    raise exception 'case description too long (10000 characters max)' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_remedy) > 2000 then
    raise exception 'remedy sought too long (2000 characters max)' using errcode = '22023';
  end if;
  if p_filing_status is not null and p_filing_status not in ('informal', 'filed') then
    raise exception 'invalid filing status' using errcode = '22023';
  end if;
  if p_incident_date is not null
     and (p_incident_date < current_date - 3650 or p_incident_date > current_date + 1) then
    raise exception 'incident date out of range' using errcode = '22023';
  end if;

  -- The member's own intake keeps every rule, reference and award of
  -- public.create_member_case and adds the details to that same row.
  if p_member_id is null or p_member_id = caller then
    created := public.create_member_case(p_title, p_deadline, p_case_type, p_articles);
    update public.member_cases set
      description = clean_description,
      incident_date = p_incident_date,
      remedy_sought = clean_remedy,
      filing_status = p_filing_status
    where id = (created->>'caseId')::uuid and user_id = caller;
    return created || pg_catalog.jsonb_build_object('assigned', false);
  end if;

  -- A case opened for another member: staff in the member's scope only.
  if not public.member_has_role(array['steward', 'coordinator', 'admin']) then
    raise exception 'steward, coordinator or admin role required' using errcode = '42501';
  end if;
  steward_scope := private.chapter_case_intake_role_allows(p_member_id, 'steward');
  if not (steward_scope
          or private.chapter_case_intake_role_allows(p_member_id, 'coordinator')
          or private.chapter_case_intake_role_allows(p_member_id, 'admin')) then
    raise exception 'member outside your scope' using errcode = '42501';
  end if;

  clean_title := pg_catalog.btrim(coalesce(p_title, ''));
  clean_articles := pg_catalog.btrim(coalesce(p_articles, ''));
  if pg_catalog.char_length(clean_title) < 1 then
    raise exception 'case title is required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_title) > 200 then
    raise exception 'case title too long (200 characters max)' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_articles) > 500 then
    raise exception 'contract articles too long (500 characters max)' using errcode = '22023';
  end if;
  if p_case_type is null
     or p_case_type not in ('Discipline', 'Scheduling', 'Telework', 'Safety', 'Pay', 'Other') then
    raise exception 'invalid case type' using errcode = '22023';
  end if;
  if p_deadline is not null
     and (p_deadline < current_date - 3650 or p_deadline > current_date + 3650) then
    raise exception 'deadline out of range' using errcode = '22023';
  end if;

  -- A steward who opens the case is its steward, so it is on their caseload.
  assign := coalesce(p_assign_self, true) and steward_scope;
  if assign then
    select p.full_name into steward_label from public.member_profiles p where p.id = caller;
  end if;

  attempts := 0;
  loop
    attempts := attempts + 1;
    ref := 'GR-' || pg_catalog.to_char(pg_catalog.now(), 'YYYY') || '-' || private.member_case_suffix();
    begin
      insert into public.member_cases (
        user_id, reference, title, deadline, case_type, articles, step,
        description, incident_date, remedy_sought, filing_status,
        steward_user_id, steward_name, assigned_at)
      values (
        p_member_id, ref, clean_title, p_deadline, p_case_type, clean_articles, 'Intake',
        clean_description, p_incident_date, clean_remedy, p_filing_status,
        case when assign then caller end,
        case when assign then coalesce(steward_label, 'Steward') end,
        case when assign then pg_catalog.now() end)
      returning id into new_case;
      exit;
    exception when unique_violation then
      if attempts >= 5 then
        raise exception 'could not allocate a case reference' using errcode = '23505';
      end if;
    end;
  end loop;

  if assign then
    actor_label := coalesce(steward_label, 'Staff member');
    insert into public.member_case_assignment_audit
      (case_id, actor_id, actor_name, before_assignment, after_assignment)
    values (new_case, caller, actor_label,
      pg_catalog.jsonb_build_object('stewardUserId', null, 'stewardName', null,
        'coordinatorUserId', null, 'coordinatorName', null),
      pg_catalog.jsonb_build_object('stewardUserId', caller, 'stewardName', coalesce(steward_label, 'Steward'),
        'coordinatorUserId', null, 'coordinatorName', null));
  end if;

  return pg_catalog.jsonb_build_object('caseId', new_case, 'reference', ref, 'assigned', assign);
end;
end;
end;
$function$;
revoke all on function public.open_member_case(uuid,text,text,text,date,text,date,text,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.open_member_case(uuid,text,text,text,date,text,date,text,text,boolean) to authenticated;
do $intake_predecessor$ begin if (select md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.claim_member_case(uuid)'::regprocedure) <> 'f1e187acab199386d41cbc2d9da10d2f' then raise exception 'unreviewed intake predecessor: claim_member_case' using errcode='55000'; end if; end; $intake_predecessor$;
create or replace function public.claim_member_case(p_case_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
begin
  perform private.lock_message_lifecycle();
declare
  caller uuid;
  case_row public.member_cases%rowtype;
  steward_label text;
begin
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['steward']) then
    raise exception 'steward role and MFA required' using errcode = '42501';
  end if;

  select c.* into case_row from public.member_cases c where c.id = p_case_id for update;
  -- Not found, out of scope and restricted collapse to one refusal, so a
  -- guessed id is no existence oracle. Scope is the case's own organization
  -- and chapter, not only the member's current profile: a member who moved
  -- to another organization must not carry an old case into its stewards'
  -- reach (gate round 1, r1s1).
  if not found
     or case_row.organization_id is distinct from (select private.current_member_organization())
     or not (private.has_organization_role(case_row.organization_id, array['steward'])
             or private.member_has_chapter_role(case_row.chapter_id, array['steward'])
             or private.chapter_scoped_role_allows(case_row.chapter_id,'steward',case_row.user_id,true))
     or not private.chapter_case_intake_role_allows(case_row.user_id, 'steward')
     or case_row.is_restricted or private.chapter_case_readable(case_row) is not true then
    raise exception 'case not found or outside your scope' using errcode = '42501';
  end if;
  if case_row.user_id = caller then
    raise exception 'a steward cannot take their own case' using errcode = '22023';
  end if;
  if case_row.status <> 'active' then
    raise exception 'only an active case can be taken' using errcode = '22023';
  end if;
  if case_row.steward_user_id = caller then
    return pg_catalog.jsonb_build_object('caseId', case_row.id, 'reference', case_row.reference, 'assigned', true);
  end if;
  if case_row.steward_user_id is not null then
    raise exception 'this case already has a steward' using errcode = '23505';
  end if;

  select p.full_name into steward_label from public.member_profiles p where p.id = caller;
  steward_label := coalesce(steward_label, 'Steward');
  update public.member_cases set
    steward_user_id = caller, steward_name = steward_label, assigned_at = pg_catalog.now()
  where id = case_row.id;

  insert into public.member_case_assignment_audit
    (case_id, actor_id, actor_name, before_assignment, after_assignment)
  values (case_row.id, caller, steward_label,
    pg_catalog.jsonb_build_object('stewardUserId', null, 'stewardName', null,
      'coordinatorUserId', case_row.coordinator_user_id, 'coordinatorName', case_row.coordinator_name),
    pg_catalog.jsonb_build_object('stewardUserId', caller, 'stewardName', steward_label,
      'coordinatorUserId', case_row.coordinator_user_id, 'coordinatorName', case_row.coordinator_name));

  return pg_catalog.jsonb_build_object('caseId', case_row.id, 'reference', case_row.reference, 'assigned', true);
end;
end;
end;
$function$;
revoke all on function public.claim_member_case(uuid) from public,anon,authenticated,service_role;
grant execute on function public.claim_member_case(uuid) to authenticated;
do $intake_predecessor$ begin if (select md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.list_unassigned_chapter_cases()'::regprocedure) <> '5b541df84d36871875f7f263a62e1259' then raise exception 'unreviewed intake predecessor: list_unassigned_chapter_cases' using errcode='55000'; end if; end; $intake_predecessor$;
create or replace function public.list_unassigned_chapter_cases()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['steward']) then
    raise exception 'steward role and MFA required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', open_case.id,
      'reference', open_case.reference,
      'title', open_case.title,
      'caseType', open_case.case_type,
      'step', open_case.step,
      'deadline', open_case.deadline,
      'filingStatus', open_case.filing_status,
      'createdAt', open_case.created_at,
      'memberName', open_case.full_name
    ) order by open_case.deadline nulls last, open_case.created_at, open_case.id)
    from (
      select c.id, c.reference, c.title, c.case_type, c.step, c.deadline,
             c.filing_status, c.created_at, p.full_name
      from public.member_cases c
      join public.member_profiles p on p.id = c.user_id
      where c.status = 'active'
        and c.steward_user_id is null
        and not c.is_restricted
        and c.user_id <> caller
        and private.chapter_case_readable(c)
        and c.organization_id = (select private.current_member_organization())
        and (private.has_organization_role(c.organization_id, array['steward'])
             or private.member_has_chapter_role(c.chapter_id, array['steward'])
             or private.chapter_scoped_role_allows(c.chapter_id,'steward',c.user_id,true))
        and private.chapter_case_intake_role_allows(c.user_id, 'steward')
      order by c.deadline nulls last, c.created_at, c.id
      limit 50
    ) open_case
  ), '[]'::jsonb);
end;
$function$;
revoke all on function public.list_unassigned_chapter_cases() from public,anon,authenticated,service_role;
grant execute on function public.list_unassigned_chapter_cases() to authenticated;
do $intake_predecessor$ begin if (select md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.list_case_member_candidates(text)'::regprocedure) <> '176643374150a10a8ff2dc650f5b902d' then raise exception 'unreviewed intake predecessor: list_case_member_candidates' using errcode='55000'; end if; end; $intake_predecessor$;
create or replace function public.list_case_member_candidates(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  needle text := pg_catalog.btrim(coalesce(p_query, ''));
begin
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['steward', 'coordinator', 'admin']) then
    raise exception 'steward, coordinator or admin role required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(needle) < 2 or pg_catalog.char_length(needle) > 100 then
    raise exception 'query must be 2 to 100 characters' using errcode = '22023';
  end if;
  needle := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
    needle, '\', '\\'), '%', '\%'), '_', '\_');
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', found.id, 'fullName', found.full_name, 'chapterName', found.chapter_name
    ) order by found.full_name, found.id)
    from (
      select p.id, p.full_name, ch.name as chapter_name
      from public.member_profiles p
      join public.chapters ch
        on ch.id = p.chapter_id
       and ch.organization_id = (select private.current_member_organization())
      join public.organization_memberships om
        on om.user_id = p.id
       and om.organization_id = ch.organization_id
       and om.status = 'active'
      where p.id <> caller
        and p.full_name ilike '%' || needle || '%' escape '\'
        and (private.chapter_case_intake_role_allows(p.id, 'steward')
             or private.chapter_case_intake_role_allows(p.id, 'coordinator')
             or private.chapter_case_intake_role_allows(p.id, 'admin'))
      order by p.full_name, p.id
      limit 20
    ) found
  ), '[]'::jsonb);
end;
$function$;
revoke all on function public.list_case_member_candidates(text) from public,anon,authenticated,service_role;
grant execute on function public.list_case_member_candidates(text) to authenticated;
CREATE OR REPLACE FUNCTION public.publish_chapter_office_notice(p_chapter text,p_title text,p_body text,p_locale text default 'en',p_unit uuid default null,p_committee uuid default null)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  publisher_org uuid := private.current_member_organization();
  publisher_chapter text := private.current_member_chapter();
  clean_title text := pg_catalog.btrim(coalesce(p_title, ''));
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''));
  clean_locale text := coalesce(nullif(pg_catalog.btrim(coalesce(p_locale, '')), ''), 'en');
  clean_scope text := pg_catalog.lower(pg_catalog.btrim('chapter'));
  recent integer;
  new_id text;
  next_index integer;
  attempts integer := 0;
  sender_label text;
begin
  if not private.mfa_satisfied() or private.member_pin_session_restricted() or p_chapter is distinct from publisher_chapter or not private.chapter_officer_can_for_scope(p_chapter,'notices',p_unit,p_committee) then raise exception 'chapter notice access required' using errcode='42501'; end if;
  if p_unit is not null and p_committee is not null then raise exception 'choose one notice scope' using errcode='22023'; end if;
  if caller is null then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if publisher_org is null or publisher_chapter is null then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.chapters c
    where c.id = publisher_chapter and c.organization_id = publisher_org
  ) then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if clean_scope not in ('chapter', 'organization') then
    raise exception 'audience_scope must be chapter or organization' using errcode = '22023';
  end if;
  if clean_scope = 'organization'
     and not private.has_organization_role(publisher_org, array['steward', 'admin', 'vp']) then
    raise exception 'organization-wide steward role required' using errcode = '42501';
  end if;
  if clean_scope = 'chapter'
     and not private.chapter_officer_can_for_scope(p_chapter,'notices',p_unit,p_committee) then
    raise exception 'chapter steward role required' using errcode = '42501';
  end if;
  -- Members read the sender line. A steward keeps the existing sender; an
  -- admin or president who is not a steward in that scope posts as officers.
  sender_label := case
    when (clean_scope = 'organization' and private.has_organization_role(publisher_org, array['steward']))
      or (clean_scope = 'chapter' and private.member_has_chapter_role(publisher_chapter, array['steward']))
    then 'Chapter steward'
    else 'Union officers'
  end;

  if clean_title = '' or pg_catalog.char_length(clean_title) > 120 then
    raise exception 'title must be between 1 and 120 characters' using errcode = '22023';
  end if;
  if clean_title ~ '[[:cntrl:]]' then
    raise exception 'title contains unsupported control characters' using errcode = '22023';
  end if;
  if clean_body = '' or pg_catalog.char_length(clean_body) > 4000 then
    raise exception 'body must be between 1 and 4000 characters' using errcode = '22023';
  end if;
  if pg_catalog.regexp_replace(clean_body, '[' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9) || ']', '', 'g') ~ '[[:cntrl:]]' then
    raise exception 'body contains unsupported control characters' using errcode = '22023';
  end if;
  if clean_locale not in ('en', 'es') then
    raise exception 'locale must be en or es' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-broadcast-publish:' || caller::text, 509));

  select count(*) into recent
  from public.member_broadcasts
  where created_by = caller
    and published_at >= now() - interval '24 hours';
  if recent >= 5 then
    raise exception 'broadcast limit reached: 5 per steward per day' using errcode = '54000';
  end if;

  loop
    begin
      new_id := 'bc-' || extensions.gen_random_uuid();
      select coalesce(min(order_index), 1) - 1 into next_index from public.member_broadcasts;
      insert into public.member_broadcasts (
        id, sender, title, body, published_at, order_index, created_by, locale,
        organization_id, chapter_id, audience_scope, access_unit_id, access_committee_id
      )
      values (
        new_id, sender_label, clean_title, clean_body, now(), next_index, caller, clean_locale,
        publisher_org, publisher_chapter, clean_scope, p_unit, p_committee
      );
      exit;
    exception when unique_violation then
      attempts := attempts + 1;
      if attempts >= 3 then
        raise;
      end if;
    end;
  end loop;

  return pg_catalog.jsonb_build_object('broadcastId', new_id);
end;
end;
$function$;

revoke all on function public.publish_chapter_office_notice(text,text,text,text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.publish_chapter_office_notice(text,text,text,text,uuid,uuid) to authenticated;

-- The existing export composition stays intact; append only caller-owned identifiers.
CREATE OR REPLACE FUNCTION private.account_lifecycle_export_additional_domains(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select pg_catalog.jsonb_build_object(
    'pulse_saved_charts', private.account_lifecycle_export_pulse_saved_charts(p_caller), 'chapter_bid_entries', private.account_lifecycle_export_chapter_bid_entries(p_caller), 'chapter_seniority_entries', private.account_lifecycle_export_chapter_seniority_entries(p_caller), 'chapter_channel_poll_votes', private.account_lifecycle_export_chapter_channel_poll_votes(p_caller), 'chapter_space_notification_settings', private.account_lifecycle_export_chapter_space_notification_settings(p_caller), 'chapter_task_watchers', private.account_lifecycle_export_chapter_task_watchers(p_caller), 'chapter_thread_posts', private.account_lifecycle_export_chapter_thread_posts(p_caller), 'chapter_threads', private.account_lifecycle_export_chapter_threads(p_caller), 'compass_message_briefings', private.account_lifecycle_export_compass_message_briefings(p_caller), 'compass_workspace_preferences', private.account_lifecycle_export_compass_workspace_preferences(p_caller), 'member_ballot_votes', private.account_lifecycle_export_member_ballot_votes(p_caller), 'member_broadcast_receipts', private.account_lifecycle_export_member_broadcast_receipts(p_caller), 'member_chapter_memberships', private.account_lifecycle_export_member_chapter_memberships(p_caller), 'member_emergency_checklists', private.account_lifecycle_export_member_emergency_checklists(p_caller), 'member_event_contact_links', private.account_lifecycle_export_member_event_contact_links(p_caller), 'member_event_contact_opt_ins', private.account_lifecycle_export_member_event_contact_opt_ins(p_caller), 'member_message_reactions', private.account_lifecycle_export_member_message_reactions(p_caller), 'member_message_reminders', private.account_lifecycle_export_member_message_reminders(p_caller), 'member_message_resources', private.account_lifecycle_export_member_message_resources(p_caller), 'member_profile_details', private.account_lifecycle_export_member_profile_details(p_caller), 'member_qa_votes', private.account_lifecycle_export_member_qa_votes(p_caller), 'member_report_preferences', private.account_lifecycle_export_member_report_preferences(p_caller), 'member_reward_tier_attainment', private.account_lifecycle_export_member_reward_tier_attainment(p_caller), 'member_saved_messages', private.account_lifecycle_export_member_saved_messages(p_caller), 'member_weekly_question_promotions', private.account_lifecycle_export_member_weekly_question_promotions(p_caller), 'member_weekly_question_supports', private.account_lifecycle_export_member_weekly_question_supports(p_caller), 'member_weekly_questions', private.account_lifecycle_export_member_weekly_questions(p_caller), 'organization_engagement_events', private.account_lifecycle_export_organization_engagement_events(p_caller), 'organization_live_poll_votes', private.account_lifecycle_export_organization_live_poll_votes(p_caller), 'organization_memberships', private.account_lifecycle_export_organization_memberships(p_caller), 'organization_pulse_events', private.account_lifecycle_export_organization_pulse_events(p_caller), 'steward_contact_preferences', private.account_lifecycle_export_steward_contact_preferences(p_caller), 'steward_private_reminders', private.account_lifecycle_export_steward_private_reminders(p_caller), 'compass_training_member_consents', private.account_lifecycle_export_compass_training_member_consents(p_caller), 'compass_training_samples', private.account_lifecycle_export_compass_training_samples(p_caller)
  ) || pg_catalog.jsonb_build_object(
    'chapter_unit_members',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('user_id',m.user_id,'chapter_id',m.chapter_id,'unit_id',m.unit_id) order by m.chapter_id,m.unit_id) from private.chapter_unit_members m where m.user_id=p_caller),'[]'::jsonb),
    'chapter_committee_members',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('user_id',m.user_id,'chapter_id',m.chapter_id,'committee_id',m.committee_id) order by m.chapter_id,m.committee_id) from private.chapter_committee_members m where m.user_id=p_caller),'[]'::jsonb),
    'chapter_role_scopes',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('user_id',m.user_id,'chapter_id',m.chapter_id,'role',m.role,'unit_id',m.unit_id,'committee_id',m.committee_id) order by m.chapter_id,m.role) from private.chapter_role_scopes m where m.user_id=p_caller),'[]'::jsonb)
  )
  || pg_catalog.jsonb_build_object(
    'member_capacity_commitments', private.account_lifecycle_export_member_capacity_commitments(p_caller), 'member_learning_assignments', private.account_lifecycle_export_member_learning_assignments(p_caller), 'member_membership_periods', private.account_lifecycle_export_member_membership_periods(p_caller), 'member_onboarding_steps', private.account_lifecycle_export_member_onboarding_steps(p_caller), 'member_participation_completions', private.account_lifecycle_export_member_participation_completions(p_caller), 'member_participation_events', private.account_lifecycle_export_member_participation_events(p_caller), 'member_recognition_events', private.account_lifecycle_export_member_recognition_events(p_caller)
  );
$function$
;

comment on policy mfa_assurance on private.chapter_role_capabilities is 'Restrictive two-step assurance on RPC-only private access metadata; no direct permissive client path.';
comment on policy mfa_assurance on private.chapter_access_policies is 'Restrictive two-step assurance on RPC-only private access metadata; no direct permissive client path.';
comment on policy mfa_assurance on private.chapter_role_settings is 'Restrictive two-step assurance on RPC-only private access metadata; no direct permissive client path.';
comment on policy mfa_assurance on private.chapter_committees is 'Restrictive two-step assurance on RPC-only private access metadata; no direct permissive client path.';
comment on policy mfa_assurance on private.chapter_unit_members is 'Restrictive two-step assurance on RPC-only private access metadata; no direct permissive client path.';
comment on policy mfa_assurance on private.chapter_committee_members is 'Restrictive two-step assurance on RPC-only private access metadata; no direct permissive client path.';
comment on policy mfa_assurance on private.chapter_role_scopes is 'Restrictive two-step assurance on RPC-only private access metadata; no direct permissive client path.';
comment on policy mfa_assurance on private.member_draft_steward_shares is 'Restrictive two-step assurance on RPC-only private access metadata; no direct permissive client path.';
comment on policy chapter_records_container_scope on public.chapter_records is 'Limit every existing read and write path to active chapter and container authority; private grievance identities require an assigned or oversight role.';
comment on policy chapter_documents_container_scope on public.chapter_documents is 'Limit every existing read and write path to active chapter and container authority; private grievance identities require an assigned or oversight role.';
comment on policy chapter_notice_container_scope on public.member_broadcasts is 'Limit every existing read and write path to active chapter and container authority; private grievance identities require an assigned or oversight role.';
comment on policy mfa_assurance on private.case_identity_privacy is 'Restrictive two-step assurance on RPC-only private access metadata; no direct permissive client path.';
comment on policy member_cases_select on public.member_cases is 'Limit every existing read and write path to active chapter and container authority; private grievance identities require an assigned or oversight role.';
comment on policy chapter_access_scope on public.member_cases is 'Limit every existing read and write path to active chapter and container authority; private grievance identities require an assigned or oversight role.';
comment on policy member_case_updates_scoped_parent on public.member_case_updates is 'Limit every existing read and write path to active chapter and container authority; private grievance identities require an assigned or oversight role.';
comment on policy member_case_files_scoped_parent on public.member_case_files is 'Limit every existing read and write path to active chapter and container authority; private grievance identities require an assigned or oversight role.';
comment on policy casework_alert_acknowledgements_read on public.casework_alert_acknowledgements is 'Limit every existing read and write path to active chapter and container authority; private grievance identities require an assigned or oversight role.';
comment on policy casework_alerts_read on public.casework_alerts is 'Limit every existing read and write path to active chapter and container authority; private grievance identities require an assigned or oversight role.';
comment on policy casework_audit_events_staff_read on public.casework_audit_events is 'Limit every existing read and write path to active chapter and container authority; private grievance identities require an assigned or oversight role.';
comment on policy casework_deadlines_select on public.casework_deadlines is 'Limit every existing read and write path to active chapter and container authority; private grievance identities require an assigned or oversight role.';
comment on policy casework_entity_links_read on public.casework_entity_links is 'Limit every existing read and write path to active chapter and container authority; private grievance identities require an assigned or oversight role.';
comment on policy casework_management_addenda_staff on public.casework_management_addenda is 'Limit every existing read and write path to active chapter and container authority; private grievance identities require an assigned or oversight role.';
comment on policy casework_management_entries_staff on public.casework_management_entries is 'Limit every existing read and write path to active chapter and container authority; private grievance identities require an assigned or oversight role.';
comment on policy casework_retaliation_reports_read on public.casework_retaliation_reports is 'Limit every existing read and write path to active chapter and container authority; private grievance identities require an assigned or oversight role.';
comment on policy casework_strength_read on public.casework_strength_analyses is 'Limit every existing read and write path to active chapter and container authority; private grievance identities require an assigned or oversight role.';
comment on policy member_forms_explicit_draft_share on public.member_forms is 'Explicit individual draft sharing grants reads only while the owner share and recipient steward scope remain active; sealed drafts remain excluded.';
comment on policy member_forms_case_identity_scope on public.member_forms is 'Limit every existing read and write path to active chapter and container authority; private grievance identities require an assigned or oversight role.';
comment on policy chapter_documents_officer_read on public.chapter_documents is 'Chapter office access is capability-bound to the content unit or committee; live membership, tenant, and two-step checks remain mandatory.';
comment on policy chapter_documents_officer_create on public.chapter_documents is 'Chapter office access is capability-bound to the content unit or committee; live membership, tenant, and two-step checks remain mandatory.';
comment on policy chapter_documents_officer_write on public.chapter_documents is 'Chapter office access is capability-bound to the content unit or committee; live membership, tenant, and two-step checks remain mandatory.';
comment on policy chapter_records_officer_read on public.chapter_records is 'Chapter office access is capability-bound to the content unit or committee; live membership, tenant, and two-step checks remain mandatory.';
comment on policy chapter_documents_read on public.chapter_documents is 'Limit every existing read and write path to active chapter and container authority; private grievance identities require an assigned or oversight role.';
comment on policy chapter_documents_staff_create on public.chapter_documents is 'Limit every existing read and write path to active chapter and container authority; private grievance identities require an assigned or oversight role.';
comment on policy chapter_documents_staff_write on public.chapter_documents is 'Limit every existing read and write path to active chapter and container authority; private grievance identities require an assigned or oversight role.';
comment on policy member_form_files_explicit_draft_share on public.member_form_files is 'Explicit individual draft sharing grants reads only while the owner share and recipient steward scope remain active; sealed drafts remain excluded.';
-- The new subject-owned metadata follows deletion and the generic privacy-safe
-- account export. It carries only the caller's own container identifiers.
insert into private.account_lifecycle_manifest
  (schema_name,table_name,user_column,delete_disposition,export_disposition,export_projection,export_inventory_basis,export_projection_version,export_domain,export_columns,note)
values
  ('private','chapter_unit_members','user_id','cascade','included','additional_domains','auth_user_fk',1,'additionalDomains.chapter_unit_members',array['user_id','chapter_id','unit_id'],'Unit membership metadata; only the subject exports it; removed with the account or chapter membership.'),
  ('private','chapter_committee_members','user_id','cascade','included','additional_domains','auth_user_fk',1,'additionalDomains.chapter_committee_members',array['user_id','chapter_id','committee_id'],'Committee membership metadata; only the subject exports it; removed with the account or chapter membership.'),
  ('private','chapter_role_scopes','user_id','cascade','included','additional_domains','auth_user_fk',1,'additionalDomains.chapter_role_scopes',array['user_id','chapter_id','role','unit_id','committee_id'],'The subject exports their own access scope identifiers; role revocation and account deletion remove the scope.');
insert into private.account_lifecycle_manifest
  (schema_name,table_name,user_column,delete_disposition,export_disposition,export_inventory_basis,exclusion_reason,note)
values ('private','member_draft_steward_shares','steward_id','cascade','excluded_with_reason','auth_user_fk',
  'A revocable authorization another member granted over their own draft, not content owned by the receiving steward.',
  'Deleting the steward or form deletes the read-only grant. No draft content is copied into the grant.');


-- r6s1: reading a grievance never grants authority to request its extension.
do $extension_predecessor$ begin
  if md5(pg_get_functiondef('public.casework_request_deadline_extension(uuid,timestamptz,text,uuid)'::regprocedure)) <> '388ca5ca2b6acb431531a63fe9930543' then raise exception 'unreviewed deadline extension predecessor' using errcode='55000'; end if;
end; $extension_predecessor$;
CREATE OR REPLACE FUNCTION public.casework_request_deadline_extension(p_deadline_id uuid, p_requested_due_at timestamp with time zone, p_reason text, p_idempotency_key uuid)
 RETURNS public.casework_deadline_extensions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_deadline public.casework_deadlines%rowtype; v_row public.casework_deadline_extensions%rowtype;
begin
  perform private.casework_require_mfa();
  select * into strict v_deadline from public.casework_deadlines where id = p_deadline_id for share;
  if not private.casework_can_read(v_deadline.case_id) or not (private.casework_member_owns(v_deadline.case_id) or private.casework_staff_can_access(v_deadline.case_id)) then raise exception 'deadline not found' using errcode = 'P0002'; end if;
  if p_requested_due_at <= v_deadline.due_at or pg_catalog.char_length(pg_catalog.btrim(p_reason)) not between 8 and 2000 then raise exception 'invalid extension request' using errcode = '22023'; end if;
  insert into public.casework_deadline_extensions(deadline_id, organization_id, requested_by, previous_due_at, requested_due_at, reason, idempotency_key)
  values (v_deadline.id, v_deadline.organization_id, (select auth.uid()), v_deadline.due_at, p_requested_due_at, pg_catalog.btrim(p_reason), p_idempotency_key)
  on conflict (organization_id, requested_by, idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_deadline.organization_id, v_deadline.chapter_id, v_deadline.case_id, (select auth.uid()), 'deadline_requested', 'deadline_extension', v_row.id, pg_catalog.jsonb_build_object('deadlineId', v_deadline.id));
  return v_row;
end;
end;
$function$
;


-- r7s1: the event desk applies the same minute-container boundary as SELECT.
do $event_minutes_predecessor$ begin
  if md5(pg_get_functiondef('public.get_admin_events()'::regprocedure)) <> '13a700cc75ff4153dd6068cf325134dd' then raise exception 'unreviewed event minutes predecessor' using errcode='55000'; end if;
end; $event_minutes_predecessor$;
CREATE OR REPLACE FUNCTION public.get_admin_events()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', e.id, 'title', e.title, 'startsAt', e.starts_at,
      'endsAt', e.ends_at, 'eventKind', e.event_kind, 'eventDate', e.event_date,
      'seriesId', e.series_id, 'checkInOffered', e.check_in_offered,
      'location', e.location, 'summary', e.summary,
      'checkInCode', e.check_in_code, 'orderIndex', e.order_index,
      'chapterId', e.chapter_id, 'chapterName', c.name,
      'isPublic', e.is_public,
      'isPublicAcrossAgencies', e.is_public_across_agencies,
      'cancelledAt', e.cancelled_at,
      'cancelledReason', e.cancelled_reason,
      'rsvpOpen', e.rsvp_open,
      'rsvpCount', coalesce(r.n, 0), 'checkinCount', coalesce(k.n, 0),
      'checkinLockouts24h', coalesce(l.n, 0),
      'agenda', e.agenda,
      'minutes', coalesce(mr.items, '[]'::jsonb)
    ) order by e.order_index)
    from public.member_events e
    join public.chapters c on c.id = e.chapter_id
    left join (
      select event_id, pg_catalog.count(*) as n
      from public.member_event_rsvps where status = 'going' group by event_id
    ) r on r.event_id = e.id
    left join (
      select event_id, pg_catalog.count(*) as n
      from public.member_event_checkins group by event_id
    ) k on k.event_id = e.id
    left join (
      select a.detail ->> 'eventId' as event_id, pg_catalog.count(*) as n
      from public.member_admin_audit a
      where a.action = 'event_checkin_lockout'
        and a.created_at >= now() - interval '24 hours'
      group by a.detail ->> 'eventId'
    ) l on l.event_id = e.id
    left join lateral (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', cr.id, 'title', cr.title)
               order by cr.occurred_at desc, cr.id) as items
      from public.chapter_records cr
      where cr.event_id = e.id and cr.chapter_id = caller_chapter
        and cr.record_type = 'minutes' and cr.archived_at is null
        and (private.chapter_record_manageable(cr.chapter_id,cr.access_unit_id,cr.access_committee_id)
          or (cr.lifecycle_status = 'published' and cr.visibility = 'chapter'
            and private.chapter_record_publication(cr.record_type) = 'chapter_members'
            and private.can_read_chapter_member_record(cr.chapter_id)
            and private.chapter_scope_member_allowed(cr.chapter_id,cr.access_unit_id,cr.access_committee_id,caller)))
    ) mr on true
    where e.chapter_id = caller_chapter
  ), '[]'::jsonb);
end;
$function$
;

-- Bounded form read: preserve invoker RLS and every existing scope decision.
do $form_read_predecessors$ begin
  if md5(pg_get_functiondef('public.list_steward_forms(text,text,text,timestamp with time zone,uuid,integer)'::regprocedure)) is distinct from '7ec0744f7c8ce1a12bbeb75c01d90b5c' then raise exception 'unreviewed form read predecessor: public.list_steward_forms' using errcode='55000'; end if;
  if md5(pg_get_functiondef('private.member_form_scope_and_identity_allowed(public.member_forms)'::regprocedure)) is distinct from 'a9b3e3778954c831aa02353d346075c4' then raise exception 'unreviewed form read predecessor: private.member_form_scope_and_identity_allowed' using errcode='55000'; end if;
end; $form_read_predecessors$;

CREATE OR REPLACE FUNCTION private.member_form_scope_and_identity_allowed(p_form public.member_forms)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- Ordinary case-less forms already pass this restrictive predicate. Avoid
  -- consulting draft-sharing or role scopes for that unconditional branch.
  select case when p_form.case_id is null and p_form.template_key not in ('grievance','alliance_grievance')
    then true else (p_form.user_id=(select auth.uid())
    or (p_form.template_key='alliance_grievance' and public.caller_is_accepted_cosigner(p_form.id))
    or private.member_draft_shared_to_caller(p_form)
    or (p_form.case_id is null and (p_form.template_key not in ('grievance','alliance_grievance')
      or exists(select 1 from public.member_profiles owner_profile where owner_profile.id=p_form.user_id
        and private.actor_role_covers_member((select auth.uid()),owner_profile.chapter_id,'steward',p_form.user_id,true))))
    or exists(select 1 from public.member_cases c where c.id=p_form.case_id and private.chapter_case_readable(c))) end;
$function$;

CREATE OR REPLACE FUNCTION public.list_steward_forms(p_status text DEFAULT 'all'::text, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'oldest'::text, p_after_submitted timestamp with time zone DEFAULT NULL::timestamp with time zone, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50)
 RETURNS TABLE(id uuid, user_id uuid, template_key text, template_version integer, status text, answers jsonb, step integer, submitted_at timestamp with time zone, member_name text, member_initials text, total_count bigint)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  page_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  needle text := nullif(trim(coalesce(p_search, '')), '');
  pattern text;
begin
  if (select auth.uid()) is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_status not in ('all', 'submitted', 'in_review') then
    raise exception 'unknown status filter' using errcode = '22023';
  end if;
  if p_sort not in ('oldest', 'newest') then
    raise exception 'unknown sort' using errcode = '22023';
  end if;
  pattern := case when needle is null then null
    else '%' || replace(replace(replace(needle, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;

  -- Materialize the RLS-authorized rows once for both count and page. No
  -- definer shortcut: the caller's existing form/profile policies still apply.
  return query
  with visible_forms as materialized (
    select f.*
    from public.member_forms f
    where f.status in ('submitted','in_review')
      and (p_status='all' or f.status=p_status)
      and (pattern is null or exists(select 1 from public.member_profiles search_profile
        where search_profile.id=f.user_id and search_profile.full_name ilike pattern))
  ), totals as (select count(*) as count from visible_forms),
  page as (
    select f.* from visible_forms f
    where p_after_id is null
      or (p_after_submitted is not null and (
        (p_sort='oldest' and f.submitted_at>p_after_submitted)
        or (p_sort is distinct from 'oldest' and f.submitted_at<p_after_submitted)
        or (f.submitted_at=p_after_submitted and (
          (p_sort='oldest' and f.id>p_after_id) or (p_sort is distinct from 'oldest' and f.id<p_after_id)))
        or f.submitted_at is null))
      or (p_after_submitted is null and f.submitted_at is null and (
        (p_sort='oldest' and f.id>p_after_id) or (p_sort is distinct from 'oldest' and f.id<p_after_id)))
    order by case when p_sort='oldest' then f.submitted_at end asc nulls last,
      case when p_sort is distinct from 'oldest' then f.submitted_at end desc nulls last,
      case when p_sort='oldest' then f.id end asc,
      case when p_sort is distinct from 'oldest' then f.id end desc
    limit page_limit
  )
  select f.id,f.user_id,f.template_key,f.template_version,f.status,f.answers,
    f.step::integer,f.submitted_at,pr.full_name,pr.initials,totals.count
  from page f cross join totals left join public.member_profiles pr on pr.id=f.user_id
  order by case when p_sort='oldest' then f.submitted_at end asc nulls last,
    case when p_sort is distinct from 'oldest' then f.submitted_at end desc nulls last,
    case when p_sort='oldest' then f.id end asc,
    case when p_sort is distinct from 'oldest' then f.id end desc;
end;
$function$;

-- Explicitly reviewed call-graph changes only. The preflight authenticates
-- every replaced predecessor and its retained receipt before any replacement.
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select s.kind,s.schema_name,s.table_name,s.object_name,s.definition_hash
from private.account_lifecycle_trigger_surface() s
where s.kind='function' and ((s.schema_name='public' and pg_catalog.split_part(s.object_name,'(',1) in ('approve_form','assign_member_case','attach_minutes_to_meeting','can_access_form_filing','casework_case_history','casework_dashboard_median_days_per_step','casework_list_case_retaliation_flags','casework_list_ulp_deadlines','casework_request_deadline_extension','casework_suggest_case_strength','claim_member_case','clear_minutes_pre_event_notice','convert_member_intake_report','create_chapter_office_document','create_member_contact_note','create_member_invitation','form_owner_in_steward_scope','get_advisor_overview','get_admin_events','get_broadcast_read_counts','get_broadcast_read_counts_for','get_case_queue_next_actions','get_chapter_access_workspace','get_chapter_office_access','get_compass_staff_data_context','get_coordinator_kpis','get_engagement_delivery_payload','get_form_filing_payload','get_form_filing_status','get_grievance_identity_visibility','get_institutional_records_workspace','get_member_notice_receipts','get_minutes_meeting_checkins','get_minutes_pre_event_notices','get_organization_analytics_snapshot','get_organization_analytics_workspace','get_organization_derived_graph','get_staff_engagement_snapshot','get_staff_roster','get_steward_badge_counts','get_steward_chapter_member_count','get_vp_overview','list_announcement_drafts','list_case_member_candidates','list_case_note_mention_candidates','list_casework_audit_events','list_chapter_office_documents','list_contract_clause_grievance_counts','list_coordinator_case_audit','list_intake_triage_owners','list_member_case_assignment_audit','list_member_case_assignment_candidates','list_member_draft_sharing','list_my_member_notices','list_private_grievance_summaries','list_share_case_destinations','list_shared_member_drafts','list_steward_forms','list_unassigned_chapter_cases','list_vp_case_reviews','open_form_as_case','open_member_case','publish_chapter_office_notice','publish_member_broadcast','resolve_announcement_draft','retract_member_broadcast','return_form','save_chapter_committee','save_chapter_contact_log','save_institutional_record','save_minutes_pre_event_notice','save_scoped_institutional_record','search_member_cases','set_chapter_access_member','set_chapter_access_policy','set_chapter_minutes_approval','set_chapter_role_capability','set_grievance_identity_private','set_member_access_role','set_member_chapter_role','set_member_draft_steward_share','staff_can_see_user','steward_start_review','update_chapter_document_content')) or (s.schema_name='private' and pg_catalog.split_part(s.object_name,'(',1) in ('account_lifecycle_export_additional_domains','account_lifecycle_retained_case_scope_allows','actor_case_scope_and_identity_allowed','actor_has_chapter_staff_role','actor_role_covers_member','apply_member_invitation_unit','automation_v2_case_visible','can_read_member_broadcast','can_read_member_case_object','can_read_member_form_object','case_scope_and_identity_allowed','casework_actor_has_active_grant','casework_can_read','casework_dashboard_open_cases','casework_reminder_owner_can_read','casework_staff_can_access','casework_staff_can_read','chapter_access_leadership','chapter_case_intake_role_allows','chapter_case_leadership_readable','chapter_case_readable','chapter_case_staff_readable','chapter_grievance_steward_scope','chapter_member_readable','chapter_office_role_present','chapter_officer_can','chapter_officer_can_for_scope','chapter_record_manageable','chapter_scope_member_allowed','chapter_scope_recipient_allowed','chapter_scoped_member_ids','chapter_scoped_role_allows','dispatch_minutes_pre_event_notices','draft_steward_covers_member','engagement_delivery_recipient_eligible','institutional_context','member_case_row_visible','member_draft_shared_to_caller','member_form_actor_scope_and_identity_allowed','member_form_case_readable','member_form_scope_and_identity_allowed','member_has_chapter_role','member_notice_in_audience','member_notice_read_count','member_scoped_notice_audience_count','member_scoped_notice_in_audience','queue_member_broadcast_delivery','staff_visible_member_ids','visible_member_broadcast_ids')))
on conflict(kind,schema_name,table_name,object_name) do update set definition_hash=excluded.definition_hash;

-- Retire only the authenticated predecessor receipt when no longer reachable.
delete from private.account_lifecycle_trigger_review r where r.kind='function' and r.schema_name='private' and r.object_name='actor_has_chapter_staff_role(p_actor uuid, p_chapter text)' and r.definition_hash='ed0b9613c428626340cc995378b13fcc' and not exists(select 1 from private.account_lifecycle_trigger_surface() s where s.kind=r.kind and s.schema_name=r.schema_name and s.table_name=r.table_name and s.object_name=r.object_name);

-- Retire only the authenticated predecessor receipt when no longer reachable.
delete from private.account_lifecycle_trigger_review r where r.kind='function' and r.schema_name='public' and r.object_name='staff_can_see_user(p_target uuid, p_role text)' and r.definition_hash='3b2d156f7a96145af243ef4074a37f5c' and not exists(select 1 from private.account_lifecycle_trigger_surface() s where s.kind=r.kind and s.schema_name=r.schema_name and s.table_name=r.table_name and s.object_name=r.object_name);

insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select s.kind,s.schema_name,s.table_name,s.object_name,s.definition_hash
from private.account_lifecycle_trigger_surface() s
where s.kind='trigger' and s.schema_name='private'
  and s.table_name in ('chapter_role_capabilities','chapter_access_policies','chapter_role_settings','chapter_committees','chapter_unit_members','chapter_committee_members','chapter_role_scopes','member_draft_steward_shares','case_identity_privacy')
  and s.object_name in ('a00_case_graph_lock','z99_case_graph_keys');

-- Preserve the OR of each existing and added permission in one policy.
alter policy chapter_documents_staff_create on public.chapter_documents with check ((((chapter_id = private.current_member_chapter()) AND (created_by = ( SELECT auth.uid() AS uid)) AND private.member_has_chapter_role(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]))) OR (((chapter_id = private.current_member_chapter()) AND (created_by = ( SELECT auth.uid() AS uid)) AND private.chapter_officer_can_for_scope(chapter_id, 'documents'::text, access_unit_id, access_committee_id))));
drop policy chapter_documents_officer_create on public.chapter_documents;
alter policy chapter_documents_read on public.chapter_documents using (((((chapter_id = private.current_member_chapter()) AND (((status = 'published'::text) AND ((visibility = 'chapter'::text) OR private.member_has_chapter_role(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]))) OR private.member_has_chapter_role(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]))) OR ((status = 'published'::text) AND private.member_has_chapter_role(private.current_member_chapter(), ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]) AND (EXISTS ( SELECT 1
   FROM (public.chapter_handshake_documents hd
     JOIN public.chapter_handshakes h ON ((h.id = hd.handshake_id)))
  WHERE ((hd.document_id = chapter_documents.id) AND (h.status = 'active'::text) AND ((private.current_member_chapter() = h.chapter_id) OR (private.current_member_chapter() = h.receiving_chapter_id)))))))) OR (((chapter_id = private.current_member_chapter()) AND private.chapter_officer_can_for_scope(chapter_id, 'documents'::text, access_unit_id, access_committee_id))));
drop policy chapter_documents_officer_read on public.chapter_documents;
alter policy chapter_documents_staff_write on public.chapter_documents using ((((chapter_id = private.current_member_chapter()) AND private.member_has_chapter_role(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]))) OR (((chapter_id = private.current_member_chapter()) AND private.chapter_officer_can_for_scope(chapter_id, 'documents'::text, access_unit_id, access_committee_id)))) with check ((((chapter_id = private.current_member_chapter()) AND private.member_has_chapter_role(chapter_id, ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]))) OR (((chapter_id = private.current_member_chapter()) AND private.chapter_officer_can_for_scope(chapter_id, 'documents'::text, access_unit_id, access_committee_id))));
drop policy chapter_documents_officer_write on public.chapter_documents;
alter policy chapter_records_select on public.chapter_records using (((((private.chapter_record_publication(record_type) = 'chapter_members'::text) AND (lifecycle_status = 'published'::text) AND (visibility = 'chapter'::text) AND (archived_at IS NULL) AND private.can_read_chapter_member_record(chapter_id)) OR ((archived_at IS NULL) AND private.can_read_chapter_contact_record(chapter_id)))) OR (((private.chapter_record_publication(record_type) = 'chapter_members'::text) AND private.chapter_officer_can_for_scope(chapter_id, 'records'::text, access_unit_id, access_committee_id))));
drop policy chapter_records_officer_read on public.chapter_records;
alter policy member_case_files_select_owner_or_coordinator on public.member_case_files using ((((confirmed_at IS NOT NULL) AND (removal_requested_at IS NULL) AND ((user_id = ( SELECT auth.uid() AS uid)) OR (public.staff_can_see_user(user_id, 'coordinator'::text) AND (EXISTS ( SELECT 1
   FROM public.member_cases c
  WHERE (c.id = member_case_files.case_id))))))) OR (((confirmed_at IS NOT NULL) AND (removal_requested_at IS NULL) AND (EXISTS ( SELECT 1
   FROM public.member_cases c
  WHERE ((c.id = member_case_files.case_id) AND private.chapter_case_readable(c.*)))))));
drop policy member_case_files_scoped_parent on public.member_case_files;
alter policy member_case_updates_select on public.member_case_updates using (((((( SELECT auth.uid() AS uid) = user_id) AND (EXISTS ( SELECT 1
   FROM public.member_cases c
  WHERE ((c.id = member_case_updates.case_id) AND (c.user_id = ( SELECT auth.uid() AS uid)))))) OR (public.member_has_role(ARRAY['steward'::text]) AND (EXISTS ( SELECT 1
   FROM public.member_cases c
  WHERE ((c.id = member_case_updates.case_id) AND (c.steward_user_id = ( SELECT auth.uid() AS uid)))))) OR (public.staff_can_see_user(user_id, 'coordinator'::text) AND (EXISTS ( SELECT 1
   FROM public.member_cases c
  WHERE (c.id = member_case_updates.case_id)))))) OR ((EXISTS ( SELECT 1
   FROM public.member_cases c
  WHERE ((c.id = member_case_updates.case_id) AND private.chapter_case_readable(c.*))))));
drop policy member_case_updates_scoped_parent on public.member_case_updates;
alter policy member_form_files_select_authorized on public.member_form_files using (((( SELECT private.mfa_satisfied() AS mfa_satisfied) AND (EXISTS ( SELECT 1
   FROM public.member_forms f
  WHERE ((f.id = member_form_files.form_id) AND ((f.user_id = ( SELECT auth.uid() AS uid)) OR ((f.status = ANY (ARRAY['submitted'::text, 'in_review'::text, 'approved'::text])) AND public.member_has_role(ARRAY['steward'::text]) AND public.staff_can_see_user(f.user_id, 'steward'::text)))))))) OR ((EXISTS ( SELECT 1
   FROM public.member_forms f
  WHERE ((f.id = member_form_files.form_id) AND private.member_draft_shared_to_caller(f.*))))));
drop policy member_form_files_explicit_draft_share on public.member_form_files;
alter policy member_forms_select on public.member_forms using ((((( SELECT auth.uid() AS uid) = user_id) OR ((template_key = 'alliance_grievance'::text) AND public.caller_is_accepted_cosigner(id)) OR ((status = ANY (ARRAY['submitted'::text, 'in_review'::text])) AND (user_id IN ( SELECT private.staff_visible_member_ids('steward'::text) AS staff_visible_member_ids))))) OR (private.member_draft_shared_to_caller(member_forms.*)));
drop policy member_forms_explicit_draft_share on public.member_forms;
-- Newly reachable messaging parents obey the same first statement lock.
create trigger message_lifecycle_statement before insert or update or delete on private.chapter_units for each statement execute function private.lock_message_lifecycle_statement();
create trigger message_lifecycle_statement before insert or update or delete on private.chapter_committees for each statement execute function private.lock_message_lifecycle_statement();
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash) select kind,schema_name,table_name,object_name,definition_hash from private.account_lifecycle_trigger_surface() where kind='trigger' and schema_name='private' and table_name in ('chapter_units','chapter_committees') and object_name='message_lifecycle_statement' on conflict(kind,schema_name,table_name,object_name) do update set definition_hash=excluded.definition_hash;

comment on policy chapter_records_select on public.chapter_records is 'Combine member/staff and capability-bound officer reads in one permissive policy. Restrictive tenant and container-scope guards continue to apply to every branch.';
comment on policy member_case_files_select_owner_or_coordinator on public.member_case_files is 'Combine established owner/coordinator file reads with confirmed, unremoved files on a readable scoped parent. Parent case and session restrictions remain authoritative.';
comment on policy member_case_updates_select on public.member_case_updates is 'Combine established update reads with notes on a readable scoped parent. The parent case enforces tenant, role, unit, committee and private-identity boundaries.';
comment on policy member_form_files_select_authorized on public.member_form_files is 'Combine established file reads with an active, individual steward draft share. The shared helper excludes sealed drafts and requires current steward scope.';
comment on policy member_forms_select on public.member_forms is 'Combine established form reads with active individual draft sharing. Restrictive form scope and private-identity guards apply to both branches; sealed drafts remain excluded from sharing.';

notify pgrst,'reload schema';
commit;
