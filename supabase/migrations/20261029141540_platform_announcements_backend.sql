-- REQ-UG-PLATFORM-ANNOUNCEMENTS-IMPLEMENTATION-20261020 (#4993).
-- Private, in-app-only backend. No default consent, publisher or hosted data.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

create table private.platform_announcement_publishers (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 revoked_at timestamptz,
 primary key(organization_id,user_id)
);
create table private.platform_organization_follows (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 platform_organization_id uuid not null references public.organizations(id) on delete cascade,
 generation bigint not null check(generation>0),
 consent_version text not null check(consent_version='platform-updates-v1'),
 followed_at timestamptz not null default clock_timestamp(),
 revoked_at timestamptz,
 primary key(organization_id,platform_organization_id,generation),
 check(organization_id<>platform_organization_id)
);
-- Keep historical generations as FK parents; never revive old copies.
create unique index platform_organization_follows_one_active
 on private.platform_organization_follows(organization_id) where revoked_at is null;
create table private.platform_announcements (
 id uuid primary key default extensions.gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 revision integer not null default 1 check(revision>0),
 title_en text not null check(char_length(btrim(title_en)) between 1 and 120),
 title_es text not null check(char_length(btrim(title_es)) between 1 and 120),
 body_en text not null check(char_length(btrim(body_en)) between 1 and 4000),
 body_es text not null check(char_length(btrim(body_es)) between 1 and 4000),
 state text not null default 'draft' check(state in ('draft','reviewed','published','withdrawn')),
 reviewed_at timestamptz,
 published_at timestamptz,
 expires_at timestamptz not null,
 supersedes_id uuid references private.platform_announcements(id) on delete set null,
 unique(organization_id,id,revision),
 check(state not in ('reviewed','published') or reviewed_at is not null),
 check(state<>'published' or (published_at is not null and expires_at>published_at)),
 check(title_en !~ '[[:cntrl:]]' and title_es !~ '[[:cntrl:]]')
);
create table private.platform_announcement_delivery_jobs (
 organization_id uuid not null,
 announcement_id uuid not null,
 revision integer not null,
 cursor_organization_id uuid,
 state text not null default 'pending' check(state in ('pending','complete','failed')),
 failures integer not null default 0 check(failures between 0 and 5),
 primary key(announcement_id,revision),
 foreign key(organization_id,announcement_id,revision)
 references private.platform_announcements(organization_id,id,revision) on delete cascade
);
create table private.organization_platform_announcements (
 id uuid primary key default extensions.gen_random_uuid(),
 organization_id uuid not null,
 platform_organization_id uuid not null,
 announcement_id uuid not null,
 revision integer not null,
 generation bigint not null,
 title_en text not null, title_es text not null, body_en text not null, body_es text not null,
 published_at timestamptz not null, expires_at timestamptz not null,
 hidden boolean not null default false,
 unique(organization_id,announcement_id,revision,generation),
 foreign key(platform_organization_id,announcement_id,revision)
 references private.platform_announcements(organization_id,id,revision) on delete cascade,
 foreign key(organization_id,platform_organization_id,generation)
 references private.platform_organization_follows(organization_id,platform_organization_id,generation) on delete cascade
);
create index organization_platform_announcements_feed
 on private.organization_platform_announcements(organization_id,published_at desc,id desc);
create table private.platform_announcement_preferences (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 hidden boolean not null,
 primary key(organization_id,user_id)
);
create table private.platform_announcement_audit (
 id bigint generated always as identity primary key,
 organization_id uuid not null references public.organizations(id) on delete cascade,
 actor_user_id uuid references auth.users(id) on delete set null,
 action text not null check(action in ('follow','revoke','draft','review','publish','withdraw','hide')),
 publisher_assurance text check(publisher_assurance='aal2'),
 announcement_id uuid, revision integer, generation bigint,
 occurred_at timestamptz not null default clock_timestamp(),
 check((action in ('draft','review','publish','withdraw'))=(publisher_assurance is not null))
);

create function private.platform_announcement_platform(p_containment boolean default false)
returns uuid language sql stable security definer set search_path='' as $function$
 select id from public.organizations where kind='platform' and (status='active' or p_containment);
$function$;
create function private.platform_announcement_context(p_platform boolean,p_admin boolean default false,p_containment boolean default false)
returns uuid language plpgsql stable security definer set search_path='' as $function$
declare org uuid := private.current_mobile_staff_organization();
begin
 if auth.uid() is null or not coalesce(private.mfa_satisfied(),false) then
  raise exception 'platform updates unavailable' using errcode='42501';
 end if;
 if p_platform and not coalesce(
   (auth.jwt()->>'aal')='aal2' and private.has_second_factor(auth.uid()) and exists(
    select 1 from auth.users u join auth.sessions s on s.user_id=u.id
    left join private.member_mfa_reset_boundaries b on b.user_id=u.id
    where u.id=auth.uid() and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now())
     and s.id::text=auth.jwt()->>'session_id' and (s.aal='aal2' or private.verified_key_session(u.id,s.id))
     and (s.not_after is null or s.not_after>now())
     and s.created_at>coalesce(b.invalid_before,'-infinity'::timestamptz)
     and not exists(select 1 from private.member_mfa_recovery_locks l where l.user_id=u.id)),false) then
  raise exception 'platform updates unavailable' using errcode='42501';
 end if;
 -- The established resolver preserves selected-chapter precedence, permits
 -- one chapterless organization and denies an ambiguous organization scope.
 -- Containment keeps that scope after loss of organization eligibility; it
 -- never accepts a caller-supplied tenant ID or picks among memberships.
 if org is null and p_containment then
  if private.current_member_chapter() is not null then
   select c.organization_id into org from public.chapters c
    where c.id=private.current_member_chapter();
  else
   select case when count(distinct m.organization_id)=1 then min(m.organization_id::text)::uuid else null end into org
    from public.organization_memberships m where m.user_id=auth.uid() and m.status='active' and m.revoked_at is null;
  end if;
 end if;
 if org is null or not exists(select 1 from public.organizations o
  join public.organization_memberships m on m.organization_id=o.id
  where o.id=org and m.user_id=auth.uid() and m.status='active' and m.revoked_at is null
   and o.kind=case when p_platform then 'platform' else 'union' end
   and (p_containment or (o.status='active' and (p_platform or private.organization_clears_signup_boundary(org))))) then
  raise exception 'platform updates unavailable' using errcode='42501';
 end if;
 if p_admin and not (case when p_containment then
   exists(select 1 from public.organization_role_grants g where g.organization_id=org and g.user_id=auth.uid() and g.role='admin')
    and (not private.staff_mfa_required(org) or private.has_second_factor(auth.uid()))
   else private.has_organization_role(org,array['admin']) end) then
  raise exception 'platform updates unavailable' using errcode='42501';
 end if;
 if p_platform and not exists(select 1 from private.platform_announcement_publishers p
   where p.organization_id=org and p.user_id=auth.uid() and p.revoked_at is null) then
  raise exception 'platform updates unavailable' using errcode='42501';
 end if;
 return org;
end;
$function$;

create function private.platform_announcement_row_guard(p_table text,p_op text,n jsonb,o jsonb)
returns void language plpgsql security definer set search_path='' as $function$
declare org uuid := (n->>'organization_id')::uuid; platform uuid; a private.platform_announcements;
begin
 if p_table in ('platform_announcement_publishers','platform_announcements','platform_announcement_delivery_jobs') then
  if org is distinct from private.platform_announcement_platform(true) then
   raise exception 'platform updates unavailable' using errcode='42501';
  end if;
  if p_table='platform_announcement_publishers' and n->>'revoked_at' is not null then return; end if;
  if p_table='platform_announcements' and p_op='UPDATE' and n->>'state'='withdrawn'
    and n-'state'=o-'state' then return; end if;
  if p_table='platform_announcement_delivery_jobs' and n->>'state' in ('complete','failed') then return; end if;
  if org is distinct from private.platform_announcement_platform(false) then
   raise exception 'platform updates unavailable' using errcode='42501';
  end if;
 elsif p_table='platform_organization_follows' then
  if p_op='UPDATE' and n->>'revoked_at' is not null and o->>'revoked_at' is null
   and n-'revoked_at'=o-'revoked_at' then return; end if;
  platform:=(n->>'platform_organization_id')::uuid;
  if platform is distinct from private.platform_announcement_platform(false)
   or not exists(select 1 from public.organizations where id=org and kind='union' and status='active')
   or not private.organization_clears_signup_boundary(org) then
   raise exception 'platform updates unavailable' using errcode='42501';
  end if;
 elsif p_table='organization_platform_announcements' then
  if p_op='UPDATE' and n->>'hidden'='true' and n-'hidden'=o-'hidden' then return; end if;
  select * into a from private.platform_announcements where id=(n->>'announcement_id')::uuid
   and revision=(n->>'revision')::integer and organization_id=(n->>'platform_organization_id')::uuid;
  if a.id is null or a.state<>'published' or a.expires_at<=now()
    or a.organization_id is distinct from private.platform_announcement_platform(false)
    or not private.organization_clears_signup_boundary(org)
    or not exists(select 1 from public.organizations where id=org and kind='union' and status='active')
    or not exists(select 1 from private.platform_organization_follows f where f.organization_id=org
      and f.platform_organization_id=a.organization_id and f.generation=(n->>'generation')::bigint
      and f.revoked_at is null and f.followed_at<=a.published_at)
    or n->>'title_en' is distinct from a.title_en or n->>'title_es' is distinct from a.title_es
    or n->>'body_en' is distinct from a.body_en or n->>'body_es' is distinct from a.body_es
    or (n->>'published_at')::timestamptz is distinct from a.published_at
    or (n->>'expires_at')::timestamptz is distinct from a.expires_at then
   raise exception 'platform updates unavailable' using errcode='42501';
  end if;
 elsif p_table='platform_announcement_preferences' then
  if not exists(select 1 from public.organizations where id=org and kind='union') then
   raise exception 'platform updates unavailable' using errcode='42501';
  end if;
 elsif p_table='platform_announcement_audit' then
  if not exists(select 1 from public.organizations where id=org and kind in ('union','platform')) then
   raise exception 'platform updates unavailable' using errcode='42501';
  end if;
 else raise exception 'platform update boundary not configured';
 end if;
 if p_table='platform_announcements' and p_op='UPDATE' and o->>'state' in ('published','withdrawn')
  and n is distinct from o then raise exception 'published platform update is immutable' using errcode='42501'; end if;
end;
$function$;

-- Re-emit the current dispatch with a named case per new table. Existing
-- branches and the Auth detachment exception are preserved verbatim.
create or replace function private.enforce_unverified_organization_boundary()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  row_data jsonb;
  subject_org uuid;
  other_org uuid;
  attribution text;
begin
  row_data := pg_catalog.to_jsonb(new);

  -- Auth deletion may only detach one actual ON DELETE SET NULL attribution
  -- FK, nested beneath the deletion of that exact user. Direct edits, content
  -- changes and publication changes still pass through the platform guard.
  if tg_op = 'UPDATE' and tg_table_schema = 'public'
     and tg_table_name in ('public_site_records', 'organization_network_directory_profiles') then
    for attribution in
      select a.attname from pg_catalog.pg_constraint fk
      join pg_catalog.pg_attribute a on a.attrelid = fk.conrelid and a.attnum = fk.conkey[1]
      where fk.conrelid = tg_relid and fk.contype = 'f' and fk.confdeltype = 'n'
        and fk.confrelid = 'auth.users'::regclass and pg_catalog.cardinality(fk.conkey) = 1
    loop
      if row_data - attribution = to_jsonb(old) - attribution
         and private.account_lifecycle_is_nested_auth_detachment(
           (to_jsonb(old) ->> attribution)::uuid, (row_data ->> attribution)::uuid) then
        return new;
      end if;
    end loop;
  end if;


  case tg_table_schema || '.' || tg_table_name
    when 'private.platform_announcement_publishers' then
      perform private.platform_announcement_row_guard('platform_announcement_publishers',tg_op,row_data,case when tg_op='UPDATE' then to_jsonb(old) else null end);

    when 'private.platform_organization_follows' then
      perform private.platform_announcement_row_guard('platform_organization_follows',tg_op,row_data,case when tg_op='UPDATE' then to_jsonb(old) else null end);

    when 'private.platform_announcements' then
      perform private.platform_announcement_row_guard('platform_announcements',tg_op,row_data,case when tg_op='UPDATE' then to_jsonb(old) else null end);

    when 'private.platform_announcement_delivery_jobs' then
      perform private.platform_announcement_row_guard('platform_announcement_delivery_jobs',tg_op,row_data,case when tg_op='UPDATE' then to_jsonb(old) else null end);

    when 'private.organization_platform_announcements' then
      perform private.platform_announcement_row_guard('organization_platform_announcements',tg_op,row_data,case when tg_op='UPDATE' then to_jsonb(old) else null end);

    when 'private.platform_announcement_preferences' then
      perform private.platform_announcement_row_guard('platform_announcement_preferences',tg_op,row_data,case when tg_op='UPDATE' then to_jsonb(old) else null end);

    when 'private.platform_announcement_audit' then
      perform private.platform_announcement_row_guard('platform_announcement_audit',tg_op,row_data,case when tg_op='UPDATE' then to_jsonb(old) else null end);

    when 'public.chapter_union_org_bindings' then
      select c.organization_id into subject_org
      from public.chapters c where c.id = row_data ->> 'chapter_id';
      if subject_org is not null and not private.organization_clears_signup_boundary(subject_org) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.chapter_handshakes' then
      select c.organization_id into subject_org
      from public.chapters c where c.id = row_data ->> 'chapter_id';
      select c.organization_id into other_org
      from public.chapters c where c.id = row_data ->> 'receiving_chapter_id';
      if (subject_org is not null and not private.organization_clears_signup_boundary(subject_org))
         or (other_org is not null and not private.organization_clears_signup_boundary(other_org)) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;
      -- A later insert trigger stamps the requesting chapter from the
      -- caller's session, so the caller's own organization is checked too.
      if tg_op = 'INSERT' then
        subject_org := private.current_member_organization();
        if subject_org is not null and not private.organization_clears_signup_boundary(subject_org) then
          raise exception 'organization verification required' using errcode = '42501';
        end if;
      end if;

    when 'public.organization_coordination_records' then
      subject_org := (row_data ->> 'organization_id')::uuid;
      other_org := (row_data ->> 'partner_organization_id')::uuid;
      if other_org is not null
         and (not private.organization_clears_signup_boundary(subject_org)
              or not private.organization_clears_signup_boundary(other_org)) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.organization_coordination_organization_participants' then
      other_org := (row_data ->> 'organization_id')::uuid;
      select r.organization_id into subject_org
      from public.organization_coordination_records r
      where r.id = (row_data ->> 'record_id')::uuid;
      -- The owning organization's own participant row stays inside its walls.
      if other_org is distinct from subject_org
         and (not private.organization_clears_signup_boundary(subject_org)
              or not private.organization_clears_signup_boundary(other_org)) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.organization_network_permission_grants' then
      if not private.organization_clears_signup_boundary((row_data ->> 'grantor_organization_id')::uuid)
         or not private.organization_clears_signup_boundary((row_data ->> 'grantee_organization_id')::uuid) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.organization_network_directory_profiles' then
      if not private.organization_clears_signup_boundary((row_data ->> 'organization_id')::uuid)
         and (row_data ->> 'visibility' is distinct from 'private'
              or row_data ->> 'parent_organization_id' is not null) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.public_site_records' then
      subject_org := (row_data ->> 'organization_id')::uuid;
      if subject_org is not null and not private.organization_clears_signup_boundary(subject_org) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'private.dues_stripe_oauth_states', 'public.dues_provider_connections' then
      if not private.organization_clears_signup_boundary((row_data ->> 'organization_id')::uuid) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.member_invitations' then
      select c.organization_id into subject_org
      from public.chapters c where c.id = row_data ->> 'chapter_id';
      -- The a00_case_graph_lock statement trigger already holds the case-graph
      -- lock for this statement, so concurrent invitations count serially.
      if subject_org is not null and not private.organization_clears_signup_boundary(subject_org) then
        if (select pg_catalog.count(*)
              from public.member_invitations i
              join public.chapters c on c.id = i.chapter_id
             where c.organization_id = subject_org
               and i.created_at > pg_catalog.now() - interval '24 hours') >= 20
           or (select pg_catalog.count(*)
                 from public.member_invitations i
                 join public.chapters c on c.id = i.chapter_id
                where c.organization_id = subject_org) >= 200 then
          raise exception 'invitation rate limited' using errcode = 'P0001';
        end if;
      end if;

    when 'private.chapter_connection_profiles' then
      -- A draft stays inside the organization; a published profile reaches
      -- every other organization's staff.
      if row_data ->> 'publication_status' = 'published'
         and not private.organization_clears_signup_boundary((row_data ->> 'organization_id')::uuid) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'private.chapter_connection_hides' then
      -- A hide names another organization's published chapter and is
      -- reciprocal, so it changes what that chapter sees.
      if not private.organization_clears_signup_boundary((row_data ->> 'organization_id')::uuid) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    else
      raise exception 'organization boundary not configured' using errcode = '55000';
  end case;

  return new;
end;
$function$;

create function public.get_platform_announcement_follow_settings()
returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare org uuid:=private.platform_announcement_context(false,true,true); f private.platform_organization_follows;
begin
 select * into f from private.platform_organization_follows where organization_id=org order by generation desc limit 1;
 return jsonb_build_object('enabled',f.organization_id is not null and f.revoked_at is null,
  'generation',coalesce(f.generation,0),'consentVersion','platform-updates-v1',
  'platformOrganizationId',case when f.revoked_at is null then f.platform_organization_id end);
end;
$function$;
create function public.set_platform_announcement_follow(p_enabled boolean,p_expected_generation bigint,p_consent_version text)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare org uuid; platform uuid; f private.platform_organization_follows;
begin
 perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
 if p_enabled is null or p_expected_generation is null or p_expected_generation<0 then raise exception 'invalid platform update control' using errcode='22023'; end if;
 org:=private.platform_announcement_context(false,true,not p_enabled);
 select * into f from private.platform_organization_follows where organization_id=org order by generation desc limit 1 for update;
 if p_expected_generation<>coalesce(f.generation,0) then raise exception 'platform update generation changed' using errcode='40001'; end if;
 if p_enabled then
  if p_consent_version is distinct from 'platform-updates-v1' then raise exception 'invalid platform update consent' using errcode='22023'; end if;
  platform:=private.platform_announcement_platform(false);
  if platform is null then raise exception 'platform updates unavailable' using errcode='42501'; end if;
  if f.organization_id is not null and f.revoked_at is null then return public.get_platform_announcement_follow_settings(); end if;
  insert into private.platform_organization_follows(organization_id,platform_organization_id,generation,consent_version)
   values(org,platform,coalesce(f.generation,0)+1,p_consent_version) returning * into f;
 else
  if f.organization_id is null or f.revoked_at is not null then return public.get_platform_announcement_follow_settings(); end if;
  update private.platform_organization_follows set revoked_at=clock_timestamp()
   where organization_id=org and generation=f.generation;
 end if;
 insert into private.platform_announcement_audit(organization_id,actor_user_id,action,generation)
  values(org,auth.uid(),case when p_enabled then 'follow' else 'revoke' end,f.generation);
 return public.get_platform_announcement_follow_settings();
end;
$function$;
create function public.set_my_platform_announcement_preference(p_hidden boolean)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare org uuid;
begin
 perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
 org:=private.platform_announcement_context(false,false,true);
 if p_hidden is null then raise exception 'invalid platform update preference' using errcode='22023'; end if;
 insert into private.platform_announcement_preferences(organization_id,user_id,hidden) values(org,auth.uid(),p_hidden)
  on conflict(organization_id,user_id) do update set hidden=excluded.hidden;
 return jsonb_build_object('hidden',p_hidden);
end;
$function$;

create function public.save_platform_announcement_draft(p_id uuid,p_expected_revision integer,p_title_en text,p_title_es text,p_body_en text,p_body_es text,p_expires_at timestamptz,p_supersedes_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare org uuid; a private.platform_announcements;
begin
 perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
 org:=private.platform_announcement_context(true);
 if p_expires_at is null or p_expires_at<=clock_timestamp() then raise exception 'invalid platform update expiry' using errcode='22023'; end if;
 if p_supersedes_id is not null and not exists(select 1 from private.platform_announcements where id=p_supersedes_id and organization_id=org and state='published') then raise exception 'platform updates unavailable' using errcode='42501'; end if;
 if p_id is null then
  if p_expected_revision is distinct from 0 then raise exception 'platform update revision changed' using errcode='40001'; end if;
  insert into private.platform_announcements(organization_id,title_en,title_es,body_en,body_es,expires_at,supersedes_id)
   values(org,p_title_en,p_title_es,p_body_en,p_body_es,p_expires_at,p_supersedes_id) returning * into a;
 else
  select * into a from private.platform_announcements where id=p_id and organization_id=org for update;
  if a.id is null then raise exception 'platform updates unavailable' using errcode='42501'; end if;
  if a.revision is distinct from p_expected_revision or a.state not in ('draft','reviewed') then raise exception 'platform update revision changed' using errcode='40001'; end if;
  update private.platform_announcements set revision=revision+1,title_en=p_title_en,title_es=p_title_es,
   body_en=p_body_en,body_es=p_body_es,expires_at=p_expires_at,supersedes_id=p_supersedes_id,state='draft',reviewed_at=null
   where id=a.id returning * into a;
 end if;
 insert into private.platform_announcement_audit(organization_id,actor_user_id,action,announcement_id,revision,publisher_assurance) values(org,auth.uid(),'draft',a.id,a.revision,'aal2');
 return jsonb_build_object('id',a.id,'revision',a.revision,'state',a.state);
end;
$function$;
create function public.review_platform_announcement(p_id uuid,p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare org uuid; a private.platform_announcements;
begin
 perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);org:=private.platform_announcement_context(true);
 select * into a from private.platform_announcements where id=p_id and organization_id=org for update;
 if a.id is null then raise exception 'platform updates unavailable' using errcode='42501'; end if;
 if a.revision is distinct from p_expected_revision or a.state<>'draft' or a.expires_at<=clock_timestamp() then raise exception 'platform update revision changed' using errcode='40001'; end if;
 update private.platform_announcements set state='reviewed',reviewed_at=clock_timestamp() where id=a.id;
 insert into private.platform_announcement_audit(organization_id,actor_user_id,action,announcement_id,revision,publisher_assurance) values(org,auth.uid(),'review',a.id,a.revision,'aal2');
 return jsonb_build_object('id',a.id,'revision',a.revision,'state','reviewed');
end;
$function$;
create function public.publish_platform_announcement(p_id uuid,p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare org uuid; a private.platform_announcements;
begin
 perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);org:=private.platform_announcement_context(true);
 select * into a from private.platform_announcements where id=p_id and organization_id=org for update;
 if a.id is null then raise exception 'platform updates unavailable' using errcode='42501'; end if;
 if a.revision is distinct from p_expected_revision or a.state<>'reviewed' or a.expires_at<=clock_timestamp() then raise exception 'platform update revision changed' using errcode='40001'; end if;
 update private.platform_announcements set state='published',published_at=clock_timestamp() where id=a.id;
 if a.supersedes_id is not null then
  update private.platform_announcements set state='withdrawn' where id=a.supersedes_id and organization_id=org and state='published';
  insert into private.platform_announcement_audit(organization_id,actor_user_id,action,announcement_id,revision,publisher_assurance)
   select org,auth.uid(),'withdraw',id,revision,'aal2' from private.platform_announcements where id=a.supersedes_id and organization_id=org;
 end if;
 insert into private.platform_announcement_delivery_jobs(organization_id,announcement_id,revision) values(org,a.id,a.revision);
 insert into private.platform_announcement_audit(organization_id,actor_user_id,action,announcement_id,revision,publisher_assurance) values(org,auth.uid(),'publish',a.id,a.revision,'aal2');
 return jsonb_build_object('id',a.id,'revision',a.revision,'state','published');
end;
$function$;
create function public.withdraw_platform_announcement(p_id uuid,p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare org uuid; a private.platform_announcements;
begin
 perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);org:=private.platform_announcement_context(true,false,true);
 select * into a from private.platform_announcements where id=p_id and organization_id=org for update;
 if a.id is null then raise exception 'platform updates unavailable' using errcode='42501'; end if;
 if a.revision is distinct from p_expected_revision then raise exception 'platform update revision changed' using errcode='40001'; end if;
 if a.state<>'withdrawn' then
  update private.platform_announcements set state='withdrawn' where id=a.id;
  insert into private.platform_announcement_audit(organization_id,actor_user_id,action,announcement_id,revision,publisher_assurance) values(org,auth.uid(),'withdraw',a.id,a.revision,'aal2');
 end if;
 return jsonb_build_object('id',a.id,'revision',a.revision,'state','withdrawn');
end;
$function$;

create function public.dispatch_platform_announcements(p_batch_limit integer default 50)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare j private.platform_announcement_delivery_jobs; a private.platform_announcements; f private.platform_organization_follows; scanned integer; delivered integer; inserted integer;
begin
 perform private.lock_case_graph(array[]::uuid[],array[]::uuid[]);
 scanned:=0; delivered:=0;
 if coalesce(current_setting('role',true),'')<>'service_role' then raise exception 'platform updates unavailable' using errcode='42501'; end if;
 if p_batch_limit is null or p_batch_limit not between 1 and 100 then raise exception 'invalid delivery bound' using errcode='22023'; end if;
 select * into j from private.platform_announcement_delivery_jobs where state='pending' order by announcement_id,revision limit 1 for update skip locked;
 if j.announcement_id is null then return jsonb_build_object('state','idle'); end if;
 select * into a from private.platform_announcements where id=j.announcement_id and revision=j.revision;
 if a.state<>'published' or a.expires_at<=now() or a.organization_id is distinct from private.platform_announcement_platform(false) then
  update private.platform_announcement_delivery_jobs set state='complete' where announcement_id=j.announcement_id and revision=j.revision;
  return jsonb_build_object('state','complete');
 end if;
 begin
  for f in select * from private.platform_organization_follows
   where platform_organization_id=a.organization_id and revoked_at is null and followed_at<=a.published_at
    and (j.cursor_organization_id is null or organization_id>j.cursor_organization_id)
   order by organization_id limit p_batch_limit for update loop
   scanned:=scanned+1;
   if private.organization_clears_signup_boundary(f.organization_id) and exists(select 1 from public.organizations where id=f.organization_id and kind='union' and status='active') then
    insert into private.organization_platform_announcements(organization_id,platform_organization_id,announcement_id,revision,generation,title_en,title_es,body_en,body_es,published_at,expires_at)
     values(f.organization_id,a.organization_id,a.id,a.revision,f.generation,a.title_en,a.title_es,a.body_en,a.body_es,a.published_at,a.expires_at)
     on conflict(organization_id,announcement_id,revision,generation) do nothing;
    get diagnostics inserted=row_count;
    delivered:=delivered+inserted;
   end if;
   j.cursor_organization_id:=f.organization_id;
  end loop;
  update private.platform_announcement_delivery_jobs set cursor_organization_id=j.cursor_organization_id,
   state=case when scanned<p_batch_limit then 'complete' else 'pending' end,failures=0
   where announcement_id=j.announcement_id and revision=j.revision;
 exception when others then
  update private.platform_announcement_delivery_jobs set failures=least(failures+1,5),
   state=case when failures>=4 then 'failed' else 'pending' end where announcement_id=j.announcement_id and revision=j.revision;
  return jsonb_build_object('state','retry');
 end;
 return jsonb_build_object('state',case when scanned<p_batch_limit then 'complete' else 'pending' end,'scanned',scanned,'delivered',delivered);
end;
$function$;

create function public.list_my_platform_announcements(p_locale text,p_before timestamptz default null,p_before_id uuid default null,p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare org uuid:=private.platform_announcement_context(false); items jsonb; gen bigint;
begin
 if p_locale is null or p_locale not in ('en','es') or p_limit is null or p_limit not between 1 and 50
  or (p_before is null)<>(p_before_id is null) then raise exception 'invalid platform update query' using errcode='22023'; end if;
 if exists(select 1 from private.platform_announcement_preferences where organization_id=org and user_id=auth.uid() and hidden) then return jsonb_build_object('items','[]'::jsonb,'hidden',true); end if;
 select generation into gen from private.platform_organization_follows where organization_id=org and revoked_at is null;
 select coalesce(jsonb_agg(x.item order by x.published_at desc,x.id desc),'[]') into items from (
  select d.id,d.published_at,jsonb_build_object('id',d.id,'announcementId',a.id,'revision',a.revision,
   'title',case when p_locale='es' then d.title_es else d.title_en end,
   'body',case when p_locale='es' then d.body_es else d.body_en end,'publishedAt',d.published_at,'expiresAt',d.expires_at) item
  from private.organization_platform_announcements d
  join private.platform_announcements a on a.id=d.announcement_id and a.revision=d.revision and a.organization_id=d.platform_organization_id
  join private.platform_organization_follows f on f.organization_id=d.organization_id and f.platform_organization_id=d.platform_organization_id and f.generation=d.generation
  where d.organization_id=org and d.generation=gen and f.revoked_at is null and not d.hidden
   and a.state='published' and a.expires_at>now() and d.expires_at>now()
   and a.organization_id=private.platform_announcement_platform(false)
   and (p_before is null or (d.published_at,d.id)<(p_before,p_before_id))
  order by d.published_at desc,d.id desc limit p_limit
 ) x;
 return jsonb_build_object('items',items,'hidden',false,'generation',gen);
end;
$function$;
create function public.hide_organization_platform_announcement(p_id uuid)
returns boolean language plpgsql security definer set search_path='' as $function$
declare org uuid;
begin
 perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);org:=private.platform_announcement_context(false,true,true);
 if not exists(select 1 from private.organization_platform_announcements where id=p_id and organization_id=org) then raise exception 'platform updates unavailable' using errcode='42501'; end if;
 update private.organization_platform_announcements set hidden=true where id=p_id and organization_id=org;
 insert into private.platform_announcement_audit(organization_id,actor_user_id,action,announcement_id,revision)
  select org,auth.uid(),'hide',announcement_id,revision from private.organization_platform_announcements where id=p_id and organization_id=org;
 return true;
end;
$function$;
create function public.list_platform_follow_status(p_after uuid default null,p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare org uuid:=private.platform_announcement_context(true); items jsonb;
begin
 if p_limit is null or p_limit not between 1 and 50 then raise exception 'invalid platform update query' using errcode='22023'; end if;
 select coalesce(jsonb_agg(x.item order by x.id),'[]') into items from (
  select o.id,jsonb_build_object('organizationId',o.id,'name',o.name,'status',case when f.revoked_at is null then 'active' else 'revoked' end) item
  from public.organizations o join lateral (select * from private.platform_organization_follows z
   where z.organization_id=o.id and z.platform_organization_id=org order by generation desc limit 1) f on true
  where o.kind='union' and (p_after is null or o.id>p_after) order by o.id limit p_limit
 ) x;
 return jsonb_build_object('items',items);
end;
$function$;
create function public.get_platform_announcement_publisher_workspace(p_limit integer default 20,p_after_id uuid default null,p_audit_before bigint default null)
returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare org uuid:=private.platform_announcement_context(true,false,true); posts jsonb; audit jsonb; more_posts boolean; more_audit boolean;
begin
 if p_limit is null or p_limit not between 1 and 50 or p_audit_before<=0 then raise exception 'invalid platform update query' using errcode='22023'; end if;
 with page as materialized (
  select id,revision,title_en,title_es,body_en,body_es,state,reviewed_at,published_at,expires_at,supersedes_id
  from private.platform_announcements where organization_id=org and (p_after_id is null or id>p_after_id)
  order by id limit p_limit+1
 ), visible as (select * from page order by id limit p_limit)
 select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'),(select count(*)>p_limit from page)
  into posts,more_posts from visible x;
 with page as materialized (
  select id,action,announcement_id,revision,actor_user_id,publisher_assurance,occurred_at from private.platform_announcement_audit
  where organization_id=org and (p_audit_before is null or id<p_audit_before) order by id desc limit p_limit+1
 ), visible as (select * from page order by id desc limit p_limit)
 select coalesce(jsonb_agg(to_jsonb(x) order by x.id desc),'[]'),(select count(*)>p_limit from page)
  into audit,more_audit from visible x;
 return jsonb_build_object('posts',posts,'audit',audit,'hasMorePosts',more_posts,'hasMoreAudit',more_audit,
  'nextPostId',case when more_posts then posts -> -1 ->> 'id' end,
  'nextAuditBefore',case when more_audit then audit -> -1 ->> 'id' end);
end;
$function$;

-- No table client grants, no Realtime publication and no permissive policy.
alter table private.platform_announcement_publishers enable row level security;
alter table private.platform_announcement_publishers force row level security;
revoke all on private.platform_announcement_publishers from public,anon,authenticated,service_role;
create policy mfa_assurance on private.platform_announcement_publishers as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.platform_announcement_publishers is 'Restrictive session MFA defense for RPC-only storage. No client table grants or permissive policy; every definer RPC independently checks live caller authority.';
create trigger a00_case_graph_lock before insert or update or delete on private.platform_announcement_publishers
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.platform_announcement_publishers
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger b20_unverified_organization_boundary before insert or update on private.platform_announcement_publishers for each row execute function private.enforce_unverified_organization_boundary();

alter table private.platform_organization_follows enable row level security;
alter table private.platform_organization_follows force row level security;
revoke all on private.platform_organization_follows from public,anon,authenticated,service_role;
create policy mfa_assurance on private.platform_organization_follows as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.platform_organization_follows is 'Restrictive session MFA defense for RPC-only storage. No client table grants or permissive policy; every definer RPC independently checks live caller authority.';
create trigger a00_case_graph_lock before insert or update or delete on private.platform_organization_follows
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.platform_organization_follows
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger b20_unverified_organization_boundary before insert or update on private.platform_organization_follows for each row execute function private.enforce_unverified_organization_boundary();

alter table private.platform_announcements enable row level security;
alter table private.platform_announcements force row level security;
revoke all on private.platform_announcements from public,anon,authenticated,service_role;
create policy mfa_assurance on private.platform_announcements as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.platform_announcements is 'Restrictive session MFA defense for RPC-only storage. No client table grants or permissive policy; every definer RPC independently checks live caller authority.';
create trigger a00_case_graph_lock before insert or update or delete on private.platform_announcements
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.platform_announcements
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger b20_unverified_organization_boundary before insert or update on private.platform_announcements for each row execute function private.enforce_unverified_organization_boundary();

alter table private.platform_announcement_delivery_jobs enable row level security;
alter table private.platform_announcement_delivery_jobs force row level security;
revoke all on private.platform_announcement_delivery_jobs from public,anon,authenticated,service_role;
create policy mfa_assurance on private.platform_announcement_delivery_jobs as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.platform_announcement_delivery_jobs is 'Restrictive session MFA defense for RPC-only storage. No client table grants or permissive policy; every definer RPC independently checks live caller authority.';
create trigger a00_case_graph_lock before insert or update or delete on private.platform_announcement_delivery_jobs
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.platform_announcement_delivery_jobs
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger b20_unverified_organization_boundary before insert or update on private.platform_announcement_delivery_jobs for each row execute function private.enforce_unverified_organization_boundary();

alter table private.organization_platform_announcements enable row level security;
alter table private.organization_platform_announcements force row level security;
revoke all on private.organization_platform_announcements from public,anon,authenticated,service_role;
create policy mfa_assurance on private.organization_platform_announcements as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.organization_platform_announcements is 'Restrictive session MFA defense for RPC-only storage. No client table grants or permissive policy; every definer RPC independently checks live caller authority.';
create trigger a00_case_graph_lock before insert or update or delete on private.organization_platform_announcements
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.organization_platform_announcements
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger b20_unverified_organization_boundary before insert or update on private.organization_platform_announcements for each row execute function private.enforce_unverified_organization_boundary();

alter table private.platform_announcement_preferences enable row level security;
alter table private.platform_announcement_preferences force row level security;
revoke all on private.platform_announcement_preferences from public,anon,authenticated,service_role;
create policy mfa_assurance on private.platform_announcement_preferences as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.platform_announcement_preferences is 'Restrictive session MFA defense for RPC-only storage. No client table grants or permissive policy; every definer RPC independently checks live caller authority.';
create trigger a00_case_graph_lock before insert or update or delete on private.platform_announcement_preferences
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.platform_announcement_preferences
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger b20_unverified_organization_boundary before insert or update on private.platform_announcement_preferences for each row execute function private.enforce_unverified_organization_boundary();

alter table private.platform_announcement_audit enable row level security;
alter table private.platform_announcement_audit force row level security;
revoke all on private.platform_announcement_audit from public,anon,authenticated,service_role;
create policy mfa_assurance on private.platform_announcement_audit as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.platform_announcement_audit is 'Restrictive session MFA defense for RPC-only storage. No client table grants or permissive policy; every definer RPC independently checks live caller authority.';
create trigger a00_case_graph_lock before insert or update or delete on private.platform_announcement_audit
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.platform_announcement_audit
for each row execute function private.lock_case_graph_row_keys('{actor_user_id}', '');
create trigger b20_unverified_organization_boundary before insert or update on private.platform_announcement_audit for each row execute function private.enforce_unverified_organization_boundary();
revoke all on sequence private.platform_announcement_audit_id_seq from public,anon,authenticated,service_role;

insert into private.account_lifecycle_manifest(schema_name,table_name,user_column,delete_disposition,export_disposition,export_inventory_basis,exclusion_reason,note) values
 ('private','platform_announcement_publishers','user_id','cascade','excluded_with_reason','auth_user_fk','Operator-provisioned publisher authority, not member content.','Grant is removed with the account.'),
 ('private','platform_announcement_preferences','user_id','cascade','excluded_with_reason','auth_user_fk','One own-user visibility preference, not authored content.','Removed with the account; never exported to publisher or administrator.'),
 ('private','platform_announcement_audit','actor_user_id','pseudonymize','excluded_with_reason','auth_user_fk','Organization-owned consent/editorial accountability, not personal content.','Actor becomes null on account deletion; no bodies or audience data.'),
 ('private','platform_organization_follows','organization_id','not_applicable','not_applicable',null,null,'Organization-only consent; removed with owning organization.'),
 ('private','platform_announcements','organization_id','not_applicable','not_applicable',null,null,'Platform-owned immutable editorial content; no author FK; actor retained separately in audit.'),
 ('private','platform_announcement_delivery_jobs','organization_id','not_applicable','not_applicable',null,null,'Platform-owned service job; no user or recipient inventory.'),
 ('private','organization_platform_announcements','organization_id','not_applicable','not_applicable',null,null,'Follower-owned content snapshot; no member receipt or engagement data.');

-- Close every default EXECUTE before granting the enumerated client surface.
revoke all on function private.platform_announcement_context(boolean, boolean, boolean) from public,anon,authenticated,service_role;
revoke all on function private.platform_announcement_platform(boolean) from public,anon,authenticated,service_role;
revoke all on function private.platform_announcement_row_guard(text, text, n jsonb, o jsonb) from public,anon,authenticated,service_role;
revoke all on function public.dispatch_platform_announcements(integer) from public,anon,authenticated,service_role;
grant execute on function public.dispatch_platform_announcements(integer) to service_role;
revoke all on function public.get_platform_announcement_follow_settings() from public,anon,authenticated,service_role;
grant execute on function public.get_platform_announcement_follow_settings() to authenticated;
revoke all on function public.get_platform_announcement_publisher_workspace(integer,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.get_platform_announcement_publisher_workspace(integer,uuid,bigint) to authenticated;
revoke all on function public.hide_organization_platform_announcement(uuid) from public,anon,authenticated,service_role;
grant execute on function public.hide_organization_platform_announcement(uuid) to authenticated;
revoke all on function public.list_my_platform_announcements(text, timestamp with time zone, uuid, integer) from public,anon,authenticated,service_role;
grant execute on function public.list_my_platform_announcements(text, timestamp with time zone, uuid, integer) to authenticated;
revoke all on function public.list_platform_follow_status(uuid, integer) from public,anon,authenticated,service_role;
grant execute on function public.list_platform_follow_status(uuid, integer) to authenticated;
revoke all on function public.publish_platform_announcement(uuid, integer) from public,anon,authenticated,service_role;
grant execute on function public.publish_platform_announcement(uuid, integer) to authenticated;
revoke all on function public.review_platform_announcement(uuid, integer) from public,anon,authenticated,service_role;
grant execute on function public.review_platform_announcement(uuid, integer) to authenticated;
revoke all on function public.save_platform_announcement_draft(uuid, integer, text, text, text, text, timestamp with time zone, uuid) from public,anon,authenticated,service_role;
grant execute on function public.save_platform_announcement_draft(uuid, integer, text, text, text, text, timestamp with time zone, uuid) to authenticated;
revoke all on function public.set_my_platform_announcement_preference(boolean) from public,anon,authenticated,service_role;
grant execute on function public.set_my_platform_announcement_preference(boolean) to authenticated;
revoke all on function public.set_platform_announcement_follow(boolean, bigint, text) from public,anon,authenticated,service_role;
grant execute on function public.set_platform_announcement_follow(boolean, bigint, text) to authenticated;
revoke all on function public.withdraw_platform_announcement(uuid, integer) from public,anon,authenticated,service_role;
grant execute on function public.withdraw_platform_announcement(uuid, integer) to authenticated;

insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
 select kind,schema_name,table_name,object_name,definition_hash from private.account_lifecycle_trigger_surface()
 where schema_name='private' and (table_name in ('platform_announcement_publishers','platform_organization_follows','platform_announcements',
 'platform_announcement_delivery_jobs','organization_platform_announcements','platform_announcement_preferences','platform_announcement_audit')
 or object_name like 'platform_announcement_%' or object_name='enforce_unverified_organization_boundary()')
 on conflict(kind,schema_name,table_name,object_name) do update set definition_hash=excluded.definition_hash;
notify pgrst,'reload schema';
commit;
