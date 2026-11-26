-- #6676: Chapter-only Treasurer financial authority, building on #6665.
-- Published reports are chapter-readable; requests stay subject/finance-private.
begin;

do $predecessors$ begin
if md5(pg_get_functiondef('public.set_member_chapter_role(uuid,text,text,boolean)'::regprocedure)) is distinct from '0883c2082fef5b0d069b62e5468a9c65' then raise exception 'unreviewed finance predecessor: public.set_member_chapter_role' using errcode='55000'; end if;
if md5(pg_get_functiondef('public.create_member_invitation(text,text,text,text,text,text)'::regprocedure)) is distinct from '195b52a439ca793609e954dbb99c2bf2' then raise exception 'unreviewed finance predecessor: public.create_member_invitation' using errcode='55000'; end if;
if md5(pg_get_functiondef('private.chapter_budget_context(uuid,text)'::regprocedure)) is distinct from 'c4163de80c1e7922879e601bf61e37ac' then raise exception 'unreviewed finance predecessor: private.chapter_budget_context' using errcode='55000'; end if;
if md5(pg_get_functiondef('public.get_chapter_budget_access(uuid,text,integer)'::regprocedure)) is distinct from '930df077f221e2ee09be66ce7f1e50b4' then raise exception 'unreviewed finance predecessor: public.get_chapter_budget_access' using errcode='55000'; end if;
if md5(pg_get_functiondef('private.chapter_leadership_people(uuid,text)'::regprocedure)) is distinct from '61fe98366fd0210cc0f144ab0742389d' then raise exception 'unreviewed finance predecessor: private.chapter_leadership_people' using errcode='55000'; end if;
if md5(pg_get_functiondef('public.get_chapter_leadership()'::regprocedure)) is distinct from 'ba03f87d3697422d928ac3e773cfa559' then raise exception 'unreviewed finance predecessor: public.get_chapter_leadership' using errcode='55000'; end if;
if md5(pg_get_functiondef('private.account_lifecycle_export_additional_domains(uuid)'::regprocedure)) is distinct from 'ea98a1d7fdfe3b55212d94eae3bbf6f5' then raise exception 'unreviewed finance predecessor: private.account_lifecycle_export_additional_domains' using errcode='55000'; end if;
end; $predecessors$;


-- Prepared for #6676; assemble into its own stamped migration after A is ready.
-- No transfer, payment, account, bank, dues or external service integration.
create table private.chapter_financial_documents (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete cascade,
  kind text not null check(kind in ('financial_report','meeting_report','financial_notice','budget')),
  title text not null check(char_length(btrim(title)) between 1 and 160),
  body text not null check(char_length(btrim(body)) between 1 and 100000),
  budget_snapshot jsonb,
  status text not null default 'draft' check(status in ('draft','published','archived')),
  revision integer not null default 1 check(revision>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  check((kind='budget')=(budget_snapshot is not null))
);
create index chapter_financial_documents_scope_idx on private.chapter_financial_documents(organization_id,chapter_id,created_at desc,id desc);
create index chapter_financial_documents_chapter_idx on private.chapter_financial_documents(chapter_id);

create table private.chapter_financial_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete cascade,
  subject_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check(kind in ('expense','reimbursement')),
  title text not null check(char_length(btrim(title)) between 1 and 160),
  description text not null check(char_length(btrim(description)) between 1 and 4000),
  amount numeric(12,2) not null check(amount>0 and amount<=9999999999.99),
  currency text not null default 'USD' check(currency='USD'),
  status text not null default 'pending' check(status in ('pending','approved','declined')),
  decision_note text not null default '' check(char_length(decision_note)<=2000),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index chapter_financial_requests_scope_idx on private.chapter_financial_requests(organization_id,chapter_id,created_at desc,id desc);
create index chapter_financial_requests_chapter_idx on private.chapter_financial_requests(chapter_id);
create index chapter_financial_requests_subject_idx on private.chapter_financial_requests(subject_id);

alter table private.chapter_financial_documents enable row level security;
alter table private.chapter_financial_documents force row level security;
alter table private.chapter_financial_requests enable row level security;
alter table private.chapter_financial_requests force row level security;
revoke all on private.chapter_financial_documents,private.chapter_financial_requests from public,anon,authenticated,service_role;
create policy mfa_assurance on private.chapter_financial_documents as restrictive for all to authenticated using(private.mfa_satisfied()) with check(private.mfa_satisfied());
create policy mfa_assurance on private.chapter_financial_requests as restrictive for all to authenticated using(private.mfa_satisfied()) with check(private.mfa_satisfied());
comment on policy mfa_assurance on private.chapter_financial_documents is 'RPC-only chapter financial content; restrictive session assurance, no direct client grants.';
comment on policy mfa_assurance on private.chapter_financial_requests is 'RPC-only subject-owned expense records; restrictive session assurance, no direct client grants.';

create function private.chapter_finance_can(p_chapter text,p_capability text)
returns boolean language sql stable security definer set search_path='' as $function$
  select not private.member_pin_session_restricted() and p_capability in ('finance_records','finance_documents','finance_publish','finance_roster')
    and private.chapter_officer_can(p_chapter,p_capability)
    and (private.member_has_chapter_role(p_chapter,array['admin'])
      or private.has_organization_role(private.current_member_organization(),array['admin'])
      or (private.member_has_chapter_role(p_chapter,array['treasurer'])
        and exists(select 1 from private.chapter_role_capabilities cap
          where cap.role='treasurer' and cap.capability=p_capability)
        and not exists(select 1 from private.chapter_role_settings setting
          where setting.chapter_id=p_chapter and setting.role='treasurer'
            and setting.capability=p_capability and not setting.enabled)));
$function$;
revoke all on function private.chapter_finance_can(text,text) from public,anon,authenticated,service_role;

create function private.chapter_finance_context(p_org uuid,p_chapter text)
returns void language plpgsql stable security definer set search_path='' as $function$
begin
  if auth.uid() is null or not private.mfa_satisfied()
    or p_org is distinct from private.current_member_organization()
    or p_chapter is distinct from private.current_member_chapter()
    or not exists(select 1 from public.organizations o where o.id=p_org and o.status='active')
    or not exists(select 1 from public.chapters c where c.id=p_chapter and c.organization_id=p_org)
    or not exists(select 1 from public.organization_memberships m where m.organization_id=p_org and m.user_id=auth.uid() and m.status='active')
    or not exists(select 1 from public.member_chapter_memberships m where m.chapter_id=p_chapter and m.user_id=auth.uid() and m.status='active')
    then
    raise exception 'chapter finance context required' using errcode='42501';
  end if;
end;
$function$;
revoke all on function private.chapter_finance_context(uuid,text) from public,anon,authenticated,service_role;

create function public.get_chapter_finance_workspace(p_org uuid,p_chapter text,p_page integer default 0,p_request_page integer default 0,p_authoring boolean default false)
returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare records boolean; documents boolean; publishing boolean; roster boolean;
begin
  perform private.chapter_finance_context(p_org,p_chapter);
  if p_page is null or p_page not between 0 and 10000 or p_request_page is null or p_request_page not between 0 and 10000 then raise exception 'invalid finance page' using errcode='22023'; end if;
  records:=coalesce(p_authoring,false) and private.chapter_finance_can(p_chapter,'finance_records');
  documents:=coalesce(p_authoring,false) and private.chapter_finance_can(p_chapter,'finance_documents');
  publishing:=coalesce(p_authoring,false) and private.chapter_finance_can(p_chapter,'finance_publish');
  roster:=coalesce(p_authoring,false) and private.chapter_finance_can(p_chapter,'finance_roster');
  return pg_catalog.jsonb_build_object('chapterId',p_chapter,'organizationId',p_org,
    'canRecords',records,'canDocuments',documents,'canPublish',publishing,'canRoster',roster,
    'canSubmit',not private.member_pin_session_restricted(),
    'documents',coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at desc,d.id desc) from (
      select * from private.chapter_financial_documents d where d.organization_id=p_org and d.chapter_id=p_chapter
        and (documents or d.status='published')
      order by d.created_at desc,d.id desc limit 21 offset p_page*20) d),'[]'::jsonb),
    'requests',coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc,r.id desc) from (
      select r.*,p.full_name as subject_name from private.chapter_financial_requests r
      left join public.member_profiles p on p.id=r.subject_id
      where r.organization_id=p_org and r.chapter_id=p_chapter
        and not private.member_pin_session_restricted() and (records or r.subject_id=auth.uid())
      order by r.created_at desc,r.id desc limit 21 offset p_request_page*20) r),'[]'::jsonb));
end;
$function$;
revoke all on function public.get_chapter_finance_workspace(uuid,text,integer,integer,boolean) from public,anon,authenticated,service_role;
grant execute on function public.get_chapter_finance_workspace(uuid,text,integer,integer,boolean) to authenticated;

create function public.list_chapter_finance_members(p_org uuid,p_chapter text,p_page integer default 0,p_query text default '')
returns jsonb language plpgsql stable security definer set search_path='' as $function$
begin
  perform private.member_pin_require_full_session();
  perform private.chapter_finance_context(p_org,p_chapter);
  if not private.chapter_finance_can(p_chapter,'finance_roster') then raise exception 'finance roster access required' using errcode='42501'; end if;
  if p_page is null or p_page not between 0 and 10000 or p_query is null or char_length(p_query)>120 then raise exception 'invalid member page' using errcode='22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',m.user_id,'name',m.full_name) order by m.user_id) from (
    select cm.user_id,p.full_name from public.member_chapter_memberships cm
    join public.organization_memberships om on om.user_id=cm.user_id and om.organization_id=p_org and om.status='active'
    join public.member_profiles p on p.id=cm.user_id
    where cm.chapter_id=p_chapter and cm.status='active' and p.full_name ilike '%'||p_query||'%'
    order by cm.user_id limit 21 offset p_page*20) m),'[]'::jsonb);
end;
$function$;
revoke all on function public.list_chapter_finance_members(uuid,text,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.list_chapter_finance_members(uuid,text,integer,text) to authenticated;

create function public.save_chapter_financial_document(p_org uuid,p_chapter text,p_id uuid,p_revision integer,p_kind text,p_title text,p_body text,p_status text,p_budget uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare target private.chapter_financial_documents%rowtype; snapshot jsonb;
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  perform private.member_pin_require_full_session();
  perform private.chapter_finance_context(p_org,p_chapter);
  if not private.chapter_finance_can(p_chapter,'finance_documents') then raise exception 'financial document access required' using errcode='42501'; end if;
  if p_status is null or p_status not in ('draft','published','archived') or p_kind is null or p_kind not in ('budget','financial_report','meeting_report','financial_notice')
    or p_title is null or char_length(btrim(p_title)) not between 1 and 160 or p_body is null or char_length(btrim(p_body)) not between 1 and 100000 then raise exception 'invalid financial document' using errcode='22023'; end if;
  if p_id is not null then
    select * into target from private.chapter_financial_documents d where d.id=p_id and d.organization_id=p_org and d.chapter_id=p_chapter for update;
    if not found or target.revision is distinct from p_revision then raise exception 'financial document conflict' using errcode='40001'; end if;
    -- Editing a published report also changes what members see immediately.
    if (p_status='published' or target.status='published') and not private.chapter_finance_can(p_chapter,'finance_publish') then raise exception 'financial publication access required' using errcode='42501'; end if;
  elsif p_revision is distinct from 0 then raise exception 'financial document conflict' using errcode='40001';
  end if;
  if p_status='published' and not private.chapter_finance_can(p_chapter,'finance_publish') then raise exception 'financial publication access required' using errcode='42501'; end if;
  -- A budget stays protected when the requested update changes its kind.
  if (p_kind='budget' or target.kind='budget') and not private.chapter_finance_can(p_chapter,'finance_records') then
    raise exception 'financial record access required' using errcode='42501';
  end if;
  if p_kind='budget' then
    select jsonb_build_object('title',b.title,'periodStart',b.period_start,'periodEnd',b.period_end,'notes',b.notes,'items',b.items,'revision',b.revision) into snapshot
      from private.chapter_budgets b where b.id=p_budget and b.organization_id=p_org and b.chapter_id=p_chapter for share;
    if not found then raise exception 'budget unavailable' using errcode='42501'; end if;
  elsif p_budget is not null then raise exception 'budget kind required' using errcode='22023'; end if;
  if p_id is null then
    insert into private.chapter_financial_documents(organization_id,chapter_id,kind,title,body,budget_snapshot,status,published_at)
      values(p_org,p_chapter,p_kind,btrim(p_title),p_body,snapshot,p_status,case when p_status='published' then now() end) returning * into target;
  else
    update private.chapter_financial_documents set kind=p_kind,title=btrim(p_title),body=p_body,budget_snapshot=snapshot,status=p_status,
      revision=revision+1,updated_at=now(),published_at=case when p_status='published' then coalesce(published_at,now()) else published_at end
      where id=p_id returning * into target;
  end if;
  insert into public.organization_audit_ledger(organization_id,domain,event_type,action,actor_user_id,entity_type,entity_id,idempotency_key,metadata)
  values(p_org,'administration','chapter_financial_document',case when p_id is null then 'create' else 'update' end,auth.uid(),'document',target.id::text,extensions.gen_random_uuid(),jsonb_build_object('chapterId',p_chapter,'sourceKind',p_kind,'status',p_status));
  return to_jsonb(target);
end;
$function$;
revoke all on function public.save_chapter_financial_document(uuid,text,uuid,integer,text,text,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.save_chapter_financial_document(uuid,text,uuid,integer,text,text,text,text,uuid) to authenticated;

create function public.submit_chapter_financial_request(p_org uuid,p_chapter text,p_subject uuid,p_kind text,p_title text,p_description text,p_amount numeric)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare target private.chapter_financial_requests%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid(),p_subject],array[]::uuid[]);
  perform private.member_pin_require_full_session();
  perform private.chapter_finance_context(p_org,p_chapter);
  if p_subject is distinct from auth.uid() and not (private.chapter_finance_can(p_chapter,'finance_records') and private.chapter_finance_can(p_chapter,'finance_roster')) then raise exception 'finance attribution access required' using errcode='42501'; end if;
  if not exists(select 1 from public.member_chapter_memberships cm join public.organization_memberships om on om.user_id=cm.user_id and om.organization_id=p_org and om.status='active' where cm.user_id=p_subject and cm.chapter_id=p_chapter and cm.status='active') then raise exception 'active chapter member required' using errcode='42501'; end if;
  if p_kind is null or p_kind not in ('expense','reimbursement') or p_title is null or char_length(btrim(p_title)) not between 1 and 160
    or p_description is null or char_length(btrim(p_description)) not between 1 and 4000 or p_amount is null or p_amount<=0 or p_amount>9999999999.99 or p_amount<>round(p_amount,2) then raise exception 'invalid financial request' using errcode='22023'; end if;
  insert into private.chapter_financial_requests(organization_id,chapter_id,subject_id,kind,title,description,amount)
    values(p_org,p_chapter,p_subject,p_kind,btrim(p_title),p_description,p_amount) returning * into target;
  insert into public.organization_audit_ledger(organization_id,domain,event_type,action,actor_user_id,entity_type,entity_id,idempotency_key,metadata)
  values(p_org,'administration','chapter_financial_request','create',auth.uid(),'document',target.id::text,extensions.gen_random_uuid(),jsonb_build_object('chapterId',p_chapter,'sourceKind',p_kind));
  return to_jsonb(target);
end;
$function$;
revoke all on function public.submit_chapter_financial_request(uuid,text,uuid,text,text,text,numeric) from public,anon,authenticated,service_role;
grant execute on function public.submit_chapter_financial_request(uuid,text,uuid,text,text,text,numeric) to authenticated;

create function public.decide_chapter_financial_request(p_org uuid,p_chapter text,p_id uuid,p_revision integer,p_decision text,p_note text)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare target private.chapter_financial_requests%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  perform private.member_pin_require_full_session();
  perform private.chapter_finance_context(p_org,p_chapter);
  if not private.chapter_finance_can(p_chapter,'finance_records') then raise exception 'financial record access required' using errcode='42501'; end if;
  if p_decision is null or p_decision not in ('approved','declined') or p_note is null or char_length(btrim(p_note)) not between 1 and 2000 then raise exception 'invalid financial decision' using errcode='22023'; end if;
  update private.chapter_financial_requests set status=p_decision,decision_note=p_note,revision=revision+1,decided_at=now()
    where id=p_id and organization_id=p_org and chapter_id=p_chapter and status='pending' and revision=p_revision returning * into target;
  if not found then raise exception 'financial request conflict' using errcode='40001'; end if;
  insert into public.organization_audit_ledger(organization_id,domain,event_type,action,actor_user_id,entity_type,entity_id,idempotency_key,metadata)
  values(p_org,'administration','chapter_financial_request','update',auth.uid(),'document',target.id::text,extensions.gen_random_uuid(),jsonb_build_object('chapterId',p_chapter,'status',p_decision));
  return to_jsonb(target);
end;
$function$;
revoke all on function public.decide_chapter_financial_request(uuid,text,uuid,integer,text,text) from public,anon,authenticated,service_role;
grant execute on function public.decide_chapter_financial_request(uuid,text,uuid,integer,text,text) to authenticated;



alter table public.member_roles drop constraint member_roles_role_check;
alter table public.member_roles add constraint member_roles_role_check check(role in ('steward','organizer','coordinator','advisor','admin','vp','secretary','records','treasurer'));
alter table public.member_role_chapters drop constraint member_role_chapters_role_check;
alter table public.member_role_chapters add constraint member_role_chapters_role_check check(role in ('steward','organizer','coordinator','advisor','admin','vp','secretary','records','treasurer'));
alter table public.member_invitations drop constraint member_invitations_initial_role_check;
alter table public.member_invitations add constraint member_invitations_initial_role_check check(initial_role is null or initial_role in ('steward','organizer','coordinator','advisor','admin','vp','secretary','records','treasurer'));
insert into private.chapter_role_capabilities(role,capability) values
 ('treasurer','finance_records'),('treasurer','finance_documents'),('treasurer','finance_publish'),('treasurer','finance_roster');

CREATE OR REPLACE FUNCTION public.set_member_chapter_role(p_user_id uuid, p_chapter_id text, p_role text, p_enabled boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if p_role is null or p_role not in ('steward', 'organizer', 'coordinator', 'advisor', 'admin', 'vp', 'secretary', 'records', 'treasurer') then
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
  if not org_admin and not (private.member_has_chapter_role(p_chapter_id, array['admin']) or (p_role in ('secretary','records','treasurer') and private.member_has_chapter_role(p_chapter_id,array['vp']))) then
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
  if not org_admin and not (private.member_has_chapter_role(p_chapter_id, array['admin']) or (p_role in ('secretary','records','treasurer') and private.member_has_chapter_role(p_chapter_id,array['vp']))) then
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

CREATE OR REPLACE FUNCTION public.create_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_initial_role text, p_locale text, p_token_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
     or (clean_role is not null and clean_role not in ('steward', 'organizer', 'coordinator', 'advisor', 'vp', 'admin', 'secretary', 'records', 'treasurer')) then
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

CREATE OR REPLACE FUNCTION private.chapter_budget_context(p_expected_org uuid, p_expected_chapter text)
 RETURNS TABLE(organization_id uuid, chapter_id text, can_read boolean, can_assign boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := private.current_member_organization();
  chapter text := private.current_member_chapter();
  caller uuid := (select auth.uid());
begin
  perform private.member_pin_require_full_session();
  if caller is null or not private.mfa_satisfied()
     or org is null or chapter is null
     or (private.staff_mfa_required(org) and not private.has_second_factor(caller))
     or org is distinct from p_expected_org or chapter is distinct from p_expected_chapter
     or not exists (select 1 from public.organizations o where o.id = org and o.status = 'active')
     or not exists (select 1 from public.chapters c where c.id = chapter and c.organization_id = org)
     or not exists (select 1 from public.organization_memberships m where m.user_id = caller and m.organization_id = org and m.status = 'active')
     or not exists (select 1 from public.member_chapter_memberships m where m.user_id = caller and m.chapter_id = chapter and m.status = 'active') then
    raise exception 'budget context required' using errcode = '42501';
  end if;
  return query select org, chapter,
    (private.chapter_finance_can(chapter,'finance_records') or exists (select 1 from public.member_role_chapters r where r.user_id = caller and r.chapter_id = chapter and r.role = 'vp')
     or exists (select 1 from public.member_chapter_memberships m where m.user_id = caller and m.chapter_id = chapter and m.status = 'active' and m.budget_office is not null)),
    exists (select 1 from public.member_role_chapters r where r.user_id = caller and r.chapter_id = chapter and r.role = 'admin');
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_chapter_budget_access(p_expected_org uuid, p_expected_chapter text, p_page integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  ctx record;
  people jsonb := '[]'::jsonb;
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
begin
  -- This mount-time capability probe reveals nothing to ordinary members.
  -- Only callers with a chapter grant or explicit office need staff step-up.
  if not exists (select 1 from public.organization_role_grants g
      where g.user_id=caller and g.organization_id=private.current_member_organization() and g.role='admin')
     and not exists (select 1 from public.member_role_chapters r
      where r.user_id = caller and r.chapter_id = chapter and r.role in ('vp', 'admin', 'treasurer'))
     and not exists (select 1 from public.member_chapter_memberships m
      where m.user_id = caller and m.chapter_id = chapter and m.status = 'active' and m.budget_office is not null) then
    return pg_catalog.jsonb_build_object('canRead', false, 'canAssign', false, 'members', people);
  end if;
  perform private.member_pin_require_full_session();
  if not private.mfa_satisfied() then raise exception 'MFA required' using errcode = '42501'; end if;
  select * into ctx from private.chapter_budget_context(p_expected_org, p_expected_chapter);
  if p_page is null or p_page < 0 or p_page > 10000 then raise exception 'invalid page' using errcode = '22023'; end if;
  if ctx.can_assign then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', m.user_id, 'name', p.full_name, 'office', m.budget_office) order by m.user_id), '[]'::jsonb)
    into people from (select cm.user_id, cm.budget_office from public.member_chapter_memberships cm
      join public.organization_memberships om on om.user_id = cm.user_id and om.organization_id = ctx.organization_id and om.status = 'active'
      where cm.chapter_id = ctx.chapter_id and cm.status = 'active'
      order by cm.user_id limit 21 offset p_page * 20) m
      join public.member_profiles p on p.id = m.user_id;
  end if;
  return pg_catalog.jsonb_build_object('canRead', ctx.can_read, 'canAssign', ctx.can_assign, 'members', people,
    'legacyRead',exists(select 1 from public.member_role_chapters r where r.user_id=caller and r.chapter_id=chapter and r.role='vp') or exists(select 1 from public.member_chapter_memberships m where m.user_id=caller and m.chapter_id=chapter and m.status='active' and m.budget_office is not null));
end;
$function$;

CREATE OR REPLACE FUNCTION private.chapter_leadership_people(p_org uuid, p_chapter text)
 RETURNS TABLE(id uuid, full_name text, display_title text, chapter_president boolean, chapter_admin boolean, organization_admin boolean, chapter_member boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select people.id, profile.full_name, people.display_title,
    scoped.chapter_president, scoped.chapter_admin, scoped.organization_admin,
    people.chapter_member
  from (
    select cm.user_id as id, cm.display_title, true as chapter_member
    from public.member_chapter_memberships cm
    join public.organization_memberships om
      on om.user_id = cm.user_id
     and om.organization_id = p_org
     and om.status = 'active'
    where cm.chapter_id = p_chapter
      and cm.status = 'active'
    union
    select g.user_id, null::text, false
    from public.organization_role_grants g
    join public.organization_memberships om
      on om.user_id = g.user_id
     and om.organization_id = g.organization_id
     and om.status = 'active'
    where g.organization_id = p_org
      and g.role = 'admin'
      and not exists (
        select 1 from public.member_chapter_memberships own
        where own.user_id = g.user_id
          and own.chapter_id = p_chapter
          and own.status = 'active'
      )
  ) people
  join public.member_profiles profile on profile.id = people.id
  cross join lateral (
    select
      exists (
        select 1 from public.member_role_chapters rc
        where rc.user_id = people.id
          and rc.chapter_id = p_chapter
          and rc.role = 'vp'
      ) as chapter_president,
      exists (
        select 1 from public.member_role_chapters rc
        where rc.user_id = people.id
          and rc.chapter_id = p_chapter
          and rc.role = 'admin'
      ) as chapter_admin,
      exists (
        select 1 from public.organization_role_grants g
        where g.user_id = people.id
          and g.organization_id = p_org
          and g.role = 'admin'
      ) as organization_admin
  ) scoped
  where exists(select 1 from public.member_role_chapters r where r.user_id=people.id and r.chapter_id=p_chapter and r.role='treasurer' and people.chapter_member)
     or people.display_title is not null
     or scoped.chapter_president
     or scoped.chapter_admin
     or scoped.organization_admin
$function$;

CREATE OR REPLACE FUNCTION public.get_chapter_leadership()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  caller_chapter text;
  chapter_label text;
begin
  if caller is null or not private.mfa_satisfied() or caller_org is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  -- The caller's own active membership of a chapter of the selected
  -- organization; a profile pointer alone is not membership.
  select c.name into chapter_label
  from public.chapters c
  join public.member_chapter_memberships cm
    on cm.chapter_id = c.id
   and cm.user_id = caller
   and cm.status = 'active'
  where c.id = caller_chapter
    and c.organization_id = caller_org;
  if chapter_label is null then
    raise exception 'member chapter required' using errcode = '22023';
  end if;

  return pg_catalog.jsonb_build_object(
    'chapterId', caller_chapter,
    'chapterName', chapter_label,
    'people', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', ranked.id,
        'name', ranked.full_name,
        'title', ranked.display_title,
        'treasurer',exists(select 1 from public.member_role_chapters r where r.user_id=ranked.id and r.chapter_id=caller_chapter and r.role='treasurer' and ranked.chapter_member),
        'president', ranked.chapter_president,
        'administrator', ranked.chapter_admin,
        'organizationAdministrator', ranked.organization_admin,
        'canMessage', exists (
          select 1 from private.member_contactable_officer_ids() as reachable(id)
          where reachable.id = ranked.id
        ),
        -- Only what the officer chose to share with members, and only to the
        -- members of a chapter the officer belongs to (a steward card's
        -- audience).
        'contact', pg_catalog.jsonb_build_object(
          'email', case when ranked.chapter_member and coalesce(pref.share_email, false) then pref.contact_email end,
          'phone', case when ranked.chapter_member and coalesce(pref.share_phone, false) then pref.contact_phone end
        )
      ) order by ranked.rank, ranked.full_name, ranked.id)
      from (
        select leader.id, leader.full_name, leader.display_title,
          leader.chapter_president, leader.chapter_admin, leader.organization_admin,
          leader.chapter_member,
          case
            when leader.chapter_president then 0
            when leader.display_title is not null then 1
            when leader.chapter_admin then 2
            else 3
          end as rank
        from private.chapter_leadership_people(caller_org, caller_chapter) leader
        order by 8, leader.full_name, leader.id
        limit 100
      ) ranked
      left join public.steward_contact_preferences pref on pref.steward_user_id = ranked.id
    ), '[]'::jsonb)
  );
end;

end;
$function$;

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
  ) || jsonb_build_object('chapter_financial_requests',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'organization_id',r.organization_id,'chapter_id',r.chapter_id,'subject_id',r.subject_id,'kind',r.kind,'title',r.title,'description',r.description,'amount',r.amount,'currency',r.currency,'status',r.status,'decision_note',r.decision_note,'revision',r.revision,'created_at',r.created_at,'decided_at',r.decided_at) order by r.created_at,r.id) from private.chapter_financial_requests r where r.subject_id=p_caller),'[]'::jsonb))
  || pg_catalog.jsonb_build_object(
    'member_capacity_commitments', private.account_lifecycle_export_member_capacity_commitments(p_caller), 'member_learning_assignments', private.account_lifecycle_export_member_learning_assignments(p_caller), 'member_membership_periods', private.account_lifecycle_export_member_membership_periods(p_caller), 'member_onboarding_steps', private.account_lifecycle_export_member_onboarding_steps(p_caller), 'member_participation_completions', private.account_lifecycle_export_member_participation_completions(p_caller), 'member_participation_events', private.account_lifecycle_export_member_participation_events(p_caller), 'member_recognition_events', private.account_lifecycle_export_member_recognition_events(p_caller)
  );
$function$;



create trigger a00_case_graph_lock before insert or update or delete on private.chapter_financial_documents
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.chapter_financial_documents
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger a00_case_graph_lock before insert or update or delete on private.chapter_financial_requests
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.chapter_financial_requests
for each row execute function private.lock_case_graph_row_keys('{subject_id}', '');

insert into private.account_lifecycle_manifest
 (schema_name,table_name,user_column,delete_disposition,export_disposition,export_projection,export_inventory_basis,export_projection_version,export_domain,export_columns,note)
values ('private','chapter_financial_requests','subject_id','cascade','included','additional_domains','auth_user_fk',1,'additionalDomains.chapter_financial_requests',array['id','organization_id','chapter_id','subject_id','kind','title','description','amount','currency','status','decision_note','revision','created_at','decided_at'],
 'Subject-owned expense and reimbursement records and decisions; no payment action or other person attribution. Account deletion removes the requests; account export includes only the caller own requests.');

insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select s.kind,s.schema_name,s.table_name,s.object_name,s.definition_hash from private.account_lifecycle_trigger_surface() s
where (s.kind='function' and ((s.schema_name='public' and split_part(s.object_name,'(',1) in ('set_member_chapter_role','create_member_invitation','get_chapter_budget_access','get_chapter_leadership','get_chapter_finance_workspace','list_chapter_finance_members','save_chapter_financial_document','submit_chapter_financial_request','decide_chapter_financial_request')) or (s.schema_name='private' and split_part(s.object_name,'(',1) in ('chapter_budget_context','chapter_leadership_people','account_lifecycle_export_additional_domains','chapter_finance_can','chapter_finance_context'))))
 or (s.kind='trigger' and s.schema_name='private' and s.table_name in ('chapter_financial_documents','chapter_financial_requests') and s.object_name in ('a00_case_graph_lock','z99_case_graph_keys'))
on conflict(kind,schema_name,table_name,object_name) do update set definition_hash=excluded.definition_hash;

commit;
