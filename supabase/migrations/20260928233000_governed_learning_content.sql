-- REQ-UG-QUOTES-MINI-LESSONS-20260928
-- Curated/authored content only. Private tables, authenticated RPCs, explicit scope.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create table private.learning_platform_editors (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now()
);
comment on table private.learning_platform_editors is 'Operator-provisioned platform content authority. No client grant or self-enrolment RPC.';

-- Match ECMAScript String.trim whitespace so a direct RPC cannot publish
-- a source or review consisting only of invisible whitespace.
create function private.learning_trim(p text) returns text
language sql immutable set search_path = '' as $$
  select btrim(p, chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279));
$$;

create function private.learning_strings_valid(p_value jsonb, p_count integer, p_length integer)
returns boolean language sql immutable set search_path = '' as $$
  select case when p_value is null or jsonb_typeof(p_value) <> 'array' then false else
    jsonb_array_length(p_value) <= p_count and not exists (
      select 1 from jsonb_array_elements(p_value) v where jsonb_typeof(v) <> 'string'
      or char_length(v #>> '{}') > p_length or private.learning_trim(v #>> '{}') = ''
    ) end;
$$;

create function private.learning_payload_valid(p jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare k text; max_len integer;
begin
  if p is null or jsonb_typeof(p) <> 'object' or octet_length(p::text) > 64000 then return false; end if;
  if not (p ?& array['kind','locale','locale_state','title','body','attribution','source','rights_note','review_note','bullets','direction','topics','audience','tone','learning_outcome','factual_claims','priority','is_default']) then return false; end if;
  if exists(select 1 from jsonb_object_keys(p) key where key <> all(array['kind','locale','locale_state','title','body','attribution','source','rights_note','review_note','bullets','direction','topics','audience','tone','learning_outcome','factual_claims','priority','is_default'])) then return false; end if;
  if p->>'kind' not in ('quote','mini_lesson') or p->>'locale' not in ('en','es')
     or p->>'locale_state' not in ('draft','reviewed') or p->>'audience' not in ('all','members','staff')
     or jsonb_typeof(p->'factual_claims') <> 'boolean' or jsonb_typeof(p->'is_default') <> 'boolean'
     or jsonb_typeof(p->'priority') <> 'number' or (p->>'priority') !~ '^[0-9]{1,3}$'
     or (p->>'priority')::int > 100 then return false; end if;
  foreach k in array array['kind','locale','locale_state','title','body','attribution','source','rights_note','review_note','direction','audience','tone','learning_outcome'] loop
    if jsonb_typeof(p->k) <> 'string' then return false; end if;
    max_len := case k when 'title' then 100 when 'body' then case when p->>'kind'='quote' then 500 else 2000 end when 'attribution' then 200 when 'tone' then 100 when 'learning_outcome' then 500 else 1000 end;
    if char_length(p->>k) > max_len or (k in ('title','body') and private.learning_trim(p->>k) = '') then return false; end if;
  end loop;
  return private.learning_strings_valid(p->'bullets',5,200) and private.learning_strings_valid(p->'topics',5,80);
end;
$$;

create table private.learning_content (
  id uuid primary key default extensions.gen_random_uuid(),
  scope text not null check (scope in ('platform','organization','chapter')),
  organization_id uuid references public.organizations(id) on delete cascade,
  chapter_id text references public.chapters(id) on delete cascade,
  payload jsonb not null check (private.learning_payload_valid(payload)),
  status text not null default 'draft' check (status in ('draft','published','scheduled','withdrawn')),
  starts_at timestamptz, ends_at timestamptz,
  revision integer not null default 1 check (revision > 0),
  provenance jsonb not null default '{}' check (jsonb_typeof(provenance)='object' and octet_length(provenance::text)<=32000),
  constraint learning_scope_identity check (
    (scope='platform' and organization_id is null and chapter_id is null) or
    (scope='organization' and organization_id is not null and chapter_id is null) or
    (scope='chapter' and organization_id is not null and chapter_id is not null)),
  constraint learning_publication_window check (
    (status in ('draft','withdrawn') and starts_at is null and ends_at is null) or
    (status in ('published','scheduled') and starts_at is not null and (ends_at is null or ends_at>starts_at))),
  constraint learning_publication_review check (status in ('draft','withdrawn') or (
    payload->>'locale_state'='reviewed' and private.learning_trim(payload->>'rights_note')<>'' and private.learning_trim(payload->>'review_note')<>''
    and ((private.learning_trim(payload->>'attribution')='' and not (payload->>'factual_claims')::boolean) or private.learning_trim(payload->>'source')<>''))),
  constraint learning_default_platform_only check (scope='platform' or not (payload->>'is_default')::boolean)
);
create index learning_content_scope_idx on private.learning_content(organization_id,chapter_id,id);
create index learning_content_publication_idx on private.learning_content(status,starts_at,ends_at);

create table private.learning_policies (
  scope_key text primary key,
  scope text not null check (scope in ('platform','organization','chapter')),
  organization_id uuid references public.organizations(id) on delete cascade,
  chapter_id text references public.chapters(id) on delete cascade,
  quotes_enabled boolean not null default true, lessons_enabled boolean not null default true,
  selected_ids uuid[], revision bigint not null default 1,
  constraint learning_policy_scope_identity check (
    (scope='platform' and organization_id is null and chapter_id is null and scope_key='platform') or
    (scope='organization' and organization_id is not null and chapter_id is null and scope_key='organization:'||organization_id::text) or
    (scope='chapter' and organization_id is not null and chapter_id is not null and scope_key='chapter:'||chapter_id)),
  constraint learning_policy_selection_bound check (selected_ids is null or (cardinality(selected_ids)<=500 and array_position(selected_ids,null) is null))
);
insert into private.learning_policies(scope_key,scope,quotes_enabled,lessons_enabled) values ('platform','platform',false,false);

create table private.learning_home_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  hidden boolean not null default false, primary key(user_id,organization_id)
);
create table private.learning_history (
  id bigint generated always as identity primary key,
  content_id uuid references private.learning_content(id) on delete cascade,
  scope_key text not null,
  revision integer not null,
  action text not null,
  changed_at timestamptz not null default now(),
  changed_by uuid references auth.users(id) on delete set null,
  snapshot jsonb not null
);
create index learning_history_content_idx on private.learning_history(content_id,id desc);

-- No direct table read/write grants. All writes go through the bounded RPCs.
alter table private.learning_platform_editors enable row level security;
alter table private.learning_platform_editors force row level security;
revoke all on table private.learning_platform_editors from public, anon, authenticated, service_role;
alter table private.learning_content enable row level security;
alter table private.learning_content force row level security;
revoke all on table private.learning_content from public, anon, authenticated, service_role;
alter table private.learning_policies enable row level security;
alter table private.learning_policies force row level security;
revoke all on table private.learning_policies from public, anon, authenticated, service_role;
alter table private.learning_home_preferences enable row level security;
alter table private.learning_home_preferences force row level security;
revoke all on table private.learning_home_preferences from public, anon, authenticated, service_role;
alter table private.learning_history enable row level security;
alter table private.learning_history force row level security;
revoke all on table private.learning_history from public, anon, authenticated, service_role;

create trigger a00_case_graph_lock before insert or update or delete on private.learning_platform_editors
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.learning_platform_editors
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger a00_case_graph_lock before insert or update or delete on private.learning_content
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.learning_content
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger a00_case_graph_lock before insert or update or delete on private.learning_policies
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.learning_policies
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger a00_case_graph_lock before insert or update or delete on private.learning_home_preferences
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.learning_home_preferences
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger a00_case_graph_lock before insert or update or delete on private.learning_history
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.learning_history
for each row execute function private.lock_case_graph_row_keys('{changed_by}', '');

create function private.learning_platform_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and private.mfa_satisfied() and exists(select 1 from private.learning_platform_editors where user_id=(select auth.uid()));
$$;
create function private.learning_scope_key(p_scope text,p_org uuid,p_chapter text) returns text
language sql immutable set search_path = '' as $$ select case p_scope when 'platform' then 'platform' when 'organization' then 'organization:'||p_org::text when 'chapter' then 'chapter:'||p_chapter end; $$;

create function private.learning_context(p_chapter text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare org uuid;
begin
  if p_chapter is null and private.learning_platform_owner() then return private.current_member_organization(); end if;
  org:=private.mi1_require_selected_organization();
  if p_chapter is null or not exists(select 1 from public.chapters c where c.id=p_chapter and c.organization_id=org) then raise exception 'chapter unavailable' using errcode='42501'; end if;
  if not (private.has_organization_role(org,array['admin','vp']) or exists(select 1 from public.member_chapter_memberships m where m.user_id=(select auth.uid()) and m.chapter_id=p_chapter and m.status='active')) then raise exception 'chapter unavailable' using errcode='42501'; end if;
  return org;
end;
$$;
create function private.learning_can_manage(p_scope text,p_org uuid,p_chapter text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when p_scope='platform' then private.learning_platform_owner()
    when p_scope='organization' then private.has_organization_role(p_org,array['admin','vp'])
    when p_scope='chapter' then private.has_organization_role(p_org,array['admin','vp']) or private.member_has_chapter_role(p_chapter,array['admin','vp']) else false end;
$$;
create function private.learning_require_manage(p_scope text,p_org uuid,p_chapter text) returns void
language plpgsql stable security definer set search_path = '' as $$ begin
  if not coalesce(private.learning_can_manage(p_scope,p_org,p_chapter),false) then raise exception 'content administration unavailable' using errcode='42501'; end if;
end; $$;
create function private.learning_projection(r private.learning_content) returns jsonb
language sql stable set search_path = '' as $$ select r.payload || (to_jsonb(r)-'payload'); $$;

create function private.learning_touch(p_scope text,p_org uuid,p_chapter text) returns void
language plpgsql security definer set search_path = '' as $$ begin
  perform private.lock_case_graph(array[(select auth.uid())],array[]::uuid[]);
  insert into private.learning_policies(scope_key,scope,organization_id,chapter_id)
    values(private.learning_scope_key(p_scope,p_org,p_chapter),p_scope,case when p_scope<>'platform' then p_org end,case when p_scope='chapter' then p_chapter end)
  on conflict(scope_key) do update set revision=private.learning_policies.revision+1;
end; $$;
create function private.learning_audit(r private.learning_content,p_action text) returns void
language plpgsql security definer set search_path = '' as $$ begin
  perform private.lock_case_graph(array[(select auth.uid())],array[]::uuid[]);
  insert into private.learning_history(content_id,scope_key,revision,action,changed_by,snapshot)
    values(r.id,private.learning_scope_key(r.scope,r.organization_id,r.chapter_id),r.revision,p_action,(select auth.uid()),private.learning_projection(r));
  perform private.learning_touch(r.scope,r.organization_id,r.chapter_id);
end; $$;

create function public.get_learning_policy(p_chapter_id text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare org uuid; p private.learning_policies; o private.learning_policies; c private.learning_policies; hidden boolean; boundary timestamptz; staff boolean;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode='42501'; end if;
  org:=private.learning_context(p_chapter_id);
  select * into p from private.learning_policies where scope_key='platform';
  select * into o from private.learning_policies where scope_key='organization:'||org::text;
  select * into c from private.learning_policies where scope_key='chapter:'||p_chapter_id;
  select h.hidden into hidden from private.learning_home_preferences h where user_id=(select auth.uid()) and organization_id=org;
  staff:=private.has_organization_role(org,array['admin','vp','advisor','coordinator','steward']) or private.member_has_chapter_role(p_chapter_id,array['admin','vp','advisor','coordinator','steward']);
  -- Scheduled activation/expiration and audience authorization change the cache token.
  -- It never requires fetching bodies for disabled modules.
  select max(b.at) into boundary from private.learning_content r
    cross join lateral (values(r.starts_at),(r.ends_at)) b(at)
    where r.status in ('published','scheduled') and b.at<=now()
      and (r.scope='platform' or (r.organization_id=org and (r.scope='organization' or r.chapter_id=p_chapter_id)));
  return jsonb_build_object('organizationId',org,'chapterId',p_chapter_id,
    'quotesEnabled',p.quotes_enabled and coalesce(o.quotes_enabled,true) and coalesce(c.quotes_enabled,true),
    'lessonsEnabled',p.lessons_enabled and coalesce(o.lessons_enabled,true) and coalesce(c.lessons_enabled,true),
    'homeHidden',coalesce(hidden,false),'canManage',private.learning_can_manage('chapter',org,p_chapter_id),
    'isPlatformOwner',private.learning_platform_owner(),'version',concat_ws(':',p.revision,coalesce(o.revision,0),coalesce(c.revision,0),coalesce(hidden,false),boundary,staff));
end; $$;

create function public.list_learning_content(p_chapter_id text,p_locale text,p_kind text default null,p_offset integer default 0,p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare org uuid; policy jsonb; ids_o uuid[]; ids_c uuid[]; staff boolean; rows jsonb;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode='42501'; end if;
  org:=private.learning_context(p_chapter_id);
  if p_locale is null or p_locale not in ('en','es') or (p_kind is not null and p_kind not in ('quote','mini_lesson')) or p_offset is null or p_offset<0 or p_offset>10000 or p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid content query' using errcode='22023'; end if;
  policy:=public.get_learning_policy(p_chapter_id);
  if not (policy->>'quotesEnabled')::boolean and not (policy->>'lessonsEnabled')::boolean then return jsonb_build_object('items','[]'::jsonb,'hasMore',false); end if;
  select selected_ids into ids_o from private.learning_policies where scope_key='organization:'||org::text;
  select selected_ids into ids_c from private.learning_policies where scope_key='chapter:'||p_chapter_id;
  staff:=private.has_organization_role(org,array['admin','vp','advisor','coordinator','steward']) or private.member_has_chapter_role(p_chapter_id,array['admin','vp','advisor','coordinator','steward']);
  select coalesce(jsonb_agg(page.item),'[]'::jsonb) into rows from (
    select private.learning_projection(r)-'provenance'-'review_note'-'rights_note'-'direction' item from private.learning_content r where
      r.status in ('published','scheduled') and r.starts_at<=now() and (r.ends_at is null or r.ends_at>now())
      and r.payload->>'locale'=p_locale and r.payload->>'locale_state'='reviewed'
      and (p_kind is null or r.payload->>'kind'=p_kind)
      and ((r.payload->>'kind'='quote' and (policy->>'quotesEnabled')::boolean) or (r.payload->>'kind'='mini_lesson' and (policy->>'lessonsEnabled')::boolean))
      and (r.payload->>'audience'='all' or (r.payload->>'audience'='staff' and staff) or (r.payload->>'audience'='members' and not staff))
      and ((r.scope='platform' and ((r.payload->>'is_default')::boolean or r.id=any(ids_o) or r.id=any(ids_c))) or
        (r.organization_id=org and (r.scope='organization' or r.chapter_id=p_chapter_id)))
      and (ids_o is null or r.id=any(ids_o)) and (ids_c is null or r.id=any(ids_c))
    order by (r.payload->>'priority')::integer desc,r.id limit p_limit+1 offset p_offset
  ) page;
  return jsonb_build_object('items',case when jsonb_array_length(rows)>p_limit then rows-p_limit else rows end,'hasMore',jsonb_array_length(rows)>p_limit);
end; $$;

create function public.get_learning_workspace(p_chapter_id text,p_scope text default 'chapter',p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare org uuid; rows jsonb; policy jsonb;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode='42501'; end if;
  org:=private.learning_context(p_chapter_id); perform private.learning_require_manage(p_scope,org,p_chapter_id);
  if p_offset is null or p_offset<0 or p_offset>10000 then raise exception 'invalid offset' using errcode='22023'; end if;
  select to_jsonb(p) into policy from private.learning_policies p where scope_key=private.learning_scope_key(p_scope,org,p_chapter_id);
  select coalesce(jsonb_agg(page.item),'[]'::jsonb) into rows from (
    select private.learning_projection(r) item from private.learning_content r
    where r.scope=p_scope and (p_scope='platform' or r.organization_id=org) and (p_scope<>'chapter' or r.chapter_id=p_chapter_id)
    order by r.id limit 41 offset p_offset
  ) page;
  return jsonb_build_object('items',case when jsonb_array_length(rows)>40 then rows-40 else rows end,'hasMore',jsonb_array_length(rows)>40,
    'policy',coalesce(policy,jsonb_build_object('quotes_enabled',true,'lessons_enabled',true,'selected_ids',null,'revision',0)),
    'canManage',true,'isPlatformOwner',private.learning_platform_owner());
end; $$;

-- Administrators can browse reviewed public choices even while a module is off.
-- This projection is separate from the member delivery gate and never includes
-- another tenant's rows or unpublished editor/provenance fields.
create function public.list_learning_choices(p_chapter_id text,p_scope text default 'chapter',p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare org uuid; rows jsonb;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode='42501'; end if;
  org:=private.learning_context(p_chapter_id); perform private.learning_require_manage(p_scope,org,p_chapter_id);
  if p_offset is null or p_offset<0 or p_offset>10000 then raise exception 'invalid offset' using errcode='22023'; end if;
  select coalesce(jsonb_agg(page.item),'[]'::jsonb) into rows from (
    select private.learning_projection(r)-'provenance'-'review_note'-'rights_note'-'direction' item from private.learning_content r
    where r.status in ('published','scheduled') and r.payload->>'locale_state'='reviewed'
      and (r.ends_at is null or r.ends_at>now())
      and (r.scope='platform' or (p_scope<>'platform' and r.organization_id=org and (r.scope='organization' or (p_scope='chapter' and r.chapter_id=p_chapter_id))))
    order by r.id limit 41 offset p_offset
  ) page;
  return jsonb_build_object('items',case when jsonb_array_length(rows)>40 then rows-40 else rows end,'hasMore',jsonb_array_length(rows)>40);
end; $$;

create function public.save_learning_policy(p_chapter_id text,p_scope text,p_quotes_enabled boolean,p_lessons_enabled boolean,p_selected_ids uuid[] default null,p_expected_revision bigint default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare org uuid; saved private.learning_policies;
begin
  perform private.lock_case_graph(array[(select auth.uid())],array[]::uuid[]);
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode='42501'; end if;
  org:=private.learning_context(p_chapter_id); perform private.learning_require_manage(p_scope,org,p_chapter_id);
  if p_expected_revision is distinct from coalesce((select revision from private.learning_policies where scope_key=private.learning_scope_key(p_scope,org,p_chapter_id)),0) then raise exception 'revision conflict' using errcode='40001'; end if;
  if p_quotes_enabled is null or p_lessons_enabled is null or cardinality(p_selected_ids)>500 or array_position(p_selected_ids,null) is not null then raise exception 'invalid content policy' using errcode='22023'; end if;
  if p_scope='platform' and p_selected_ids is not null then raise exception 'platform uses reviewed default library' using errcode='22023'; end if;
  if exists(select 1 from unnest(p_selected_ids) requested(id) where not exists(select 1 from private.learning_content r where r.id=requested.id and (r.scope='platform' or (r.organization_id=org and (r.scope='organization' or (p_scope='chapter' and r.chapter_id=p_chapter_id)))))) then raise exception 'selection outside scope' using errcode='42501'; end if;
  insert into private.learning_policies(scope_key,scope,organization_id,chapter_id,quotes_enabled,lessons_enabled,selected_ids)
  values(private.learning_scope_key(p_scope,org,p_chapter_id),p_scope,case when p_scope<>'platform' then org end,case when p_scope='chapter' then p_chapter_id end,p_quotes_enabled,p_lessons_enabled,p_selected_ids)
  on conflict(scope_key) do update set quotes_enabled=excluded.quotes_enabled,lessons_enabled=excluded.lessons_enabled,selected_ids=excluded.selected_ids,revision=private.learning_policies.revision+1
    where private.learning_policies.revision=p_expected_revision returning * into saved;
  if not found then raise exception 'revision conflict' using errcode='40001'; end if;
  insert into private.learning_history(scope_key,revision,action,changed_by,snapshot) values(saved.scope_key,saved.revision,'policy',(select auth.uid()),to_jsonb(saved));
  return to_jsonb(saved);
end; $$;

create function public.save_learning_content(p_chapter_id text,p_scope text,p_item jsonb,p_expected_revision integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare org uuid; r private.learning_content; item_id uuid; v_payload jsonb;
begin
  perform private.lock_case_graph(array[(select auth.uid())],array[]::uuid[]);
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode='42501'; end if;
  org:=private.learning_context(p_chapter_id); perform private.learning_require_manage(p_scope,org,p_chapter_id);
  if p_item is null or jsonb_typeof(p_item)<>'object' then raise exception 'invalid content' using errcode='22023'; end if;
  item_id:=nullif(p_item->>'id','')::uuid;
  v_payload:=jsonb_build_object('attribution','','source','','rights_note','','review_note','','bullets','[]'::jsonb,'direction','','topics','[]'::jsonb,'audience','all','tone','','learning_outcome','','factual_claims',p_item->>'kind'='mini_lesson','priority',0,'is_default',false,'locale_state','draft') || (p_item-'id');
  if not private.learning_payload_valid(v_payload) or (p_scope<>'platform' and (v_payload->>'is_default')::boolean) then raise exception 'invalid content limits or fields' using errcode='22023'; end if;
  if item_id is null then
    if p_expected_revision is not null then raise exception 'revision conflict' using errcode='40001'; end if;
    insert into private.learning_content(scope,organization_id,chapter_id,payload) values(p_scope,case when p_scope<>'platform' then org end,case when p_scope='chapter' then p_chapter_id end,v_payload) returning * into r;
  else
    select * into r from private.learning_content where id=item_id for update;
    if not found or r.scope is distinct from p_scope or (r.scope<>'platform' and r.organization_id is distinct from org) or (r.scope='chapter' and r.chapter_id is distinct from p_chapter_id) then raise exception 'content unavailable' using errcode='42501'; end if;
    if p_expected_revision is distinct from r.revision then raise exception 'revision conflict' using errcode='40001'; end if;
    update private.learning_content set payload=v_payload, status='draft',starts_at=null,ends_at=null,revision=revision+1 where id=item_id returning * into r;
  end if;
  perform private.learning_audit(r,'save_draft'); return private.learning_projection(r);
end; $$;

create function public.transition_learning_content(p_chapter_id text,p_id uuid,p_action text,p_expected_revision integer,p_starts_at timestamptz default null,p_ends_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare org uuid; r private.learning_content; starts timestamptz;
begin
  perform private.lock_case_graph(array[(select auth.uid())],array[]::uuid[]);
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode='42501'; end if;
  org:=private.learning_context(p_chapter_id);
  select * into r from private.learning_content where id=p_id for update;
  if not found or (r.scope<>'platform' and r.organization_id is distinct from org) or (r.scope='chapter' and r.chapter_id is distinct from p_chapter_id) then raise exception 'content unavailable' using errcode='42501'; end if;
  perform private.learning_require_manage(r.scope,org,p_chapter_id);
  if p_expected_revision is distinct from r.revision then raise exception 'revision conflict' using errcode='40001'; end if;
  if p_action is null or p_action not in ('publish','schedule','withdraw') then raise exception 'invalid publication action' using errcode='22023'; end if;
  starts:=case when p_action='publish' then now() else p_starts_at end;
  if p_action<>'withdraw' then
    if r.payload->>'locale_state'<>'reviewed' or private.learning_trim(r.payload->>'rights_note')='' or private.learning_trim(r.payload->>'review_note')='' or ((private.learning_trim(r.payload->>'attribution')<>'' or (r.payload->>'factual_claims')::boolean) and private.learning_trim(r.payload->>'source')='') then raise exception 'source, reuse rights and locale review required' using errcode='22023'; end if;
    if starts is null or (p_action='schedule' and starts<=now()) or (p_ends_at is not null and p_ends_at<=starts) then raise exception 'invalid publication window' using errcode='22023'; end if;
  end if;
  update private.learning_content set status=case p_action when 'publish' then 'published' when 'schedule' then 'scheduled' else 'withdrawn' end,
    starts_at=case when p_action<>'withdraw' then starts end, ends_at=case when p_action<>'withdraw' then p_ends_at end,revision=revision+1 where id=p_id returning * into r;
  perform private.learning_audit(r,p_action); return private.learning_projection(r);
end; $$;

create function public.get_learning_history(p_chapter_id text,p_id uuid,p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare org uuid; r private.learning_content; rows jsonb;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode='42501'; end if;
  org:=private.learning_context(p_chapter_id);
  select * into r from private.learning_content where id=p_id;
  if not found or (r.scope<>'platform' and r.organization_id is distinct from org) or (r.scope='chapter' and r.chapter_id is distinct from p_chapter_id) then raise exception 'content unavailable' using errcode='42501'; end if;
  perform private.learning_require_manage(r.scope,org,p_chapter_id);
  if p_offset is null or p_offset<0 or p_offset>10000 then raise exception 'invalid offset' using errcode='22023'; end if;
  select coalesce(jsonb_agg(page.item),'[]'::jsonb) into rows from (
    select to_jsonb(h)-'id'-'scope_key'-'content_id' item from private.learning_history h where content_id=p_id order by id desc limit 41 offset p_offset
  ) page;
  return jsonb_build_object('items',case when jsonb_array_length(rows)>40 then rows-40 else rows end,'hasMore',jsonb_array_length(rows)>40);
end; $$;
create function public.set_learning_home_hidden(p_chapter_id text,p_hidden boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare org uuid;
begin
  perform private.lock_case_graph(array[(select auth.uid())],array[]::uuid[]);
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode='42501'; end if;
  org:=private.learning_context(p_chapter_id);
  if p_hidden is null then raise exception 'hidden flag required' using errcode='22023'; end if;
  insert into private.learning_home_preferences(user_id,organization_id,hidden) values((select auth.uid()),org,p_hidden)
    on conflict(user_id,organization_id) do update set hidden=excluded.hidden;
  return jsonb_build_object('homeHidden',p_hidden);
end; $$;

-- Account export/deletion inventory and graph lock review for the new children.
insert into private.account_lifecycle_manifest(schema_name,table_name,user_column,delete_disposition,export_disposition,export_inventory_basis,exclusion_reason,note) values
 ('private','learning_platform_editors','user_id','cascade','excluded_with_reason','auth_user_fk','Platform authorization grant; not member-authored content.','Operator-managed grant removed with account.'),
 ('private','learning_home_preferences','user_id','cascade','excluded_with_reason','auth_user_fk','One UI presentation preference; contains no member-authored content.','Home visibility removed with account.'),
 ('private','learning_history','changed_by','pseudonymize','excluded_with_reason','auth_user_fk','Tenant/platform editorial audit, not personal casework; content is owned by its scope.','Audit survives account removal with anonymous actor.');
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
 select kind,schema_name,table_name,object_name,definition_hash from private.account_lifecycle_trigger_surface()
 where kind='trigger' and schema_name='private' and table_name in ('learning_platform_editors','learning_content','learning_policies','learning_home_preferences','learning_history') and object_name in ('a00_case_graph_lock','z99_case_graph_keys');

-- Enumerated grants; no helper becomes an RPC by default.
revoke all on function private.learning_trim(text) from public, anon, authenticated, service_role;
revoke all on function private.learning_strings_valid(jsonb, integer, integer) from public, anon, authenticated, service_role;
revoke all on function private.learning_payload_valid(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.learning_platform_owner() from public, anon, authenticated, service_role;
revoke all on function private.learning_scope_key(text, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.learning_context(text) from public, anon, authenticated, service_role;
revoke all on function private.learning_can_manage(text, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.learning_require_manage(text, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.learning_projection(private.learning_content) from public, anon, authenticated, service_role;
revoke all on function private.learning_touch(text, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.learning_audit(private.learning_content, text) from public, anon, authenticated, service_role;
revoke all on function public.get_learning_policy(text) from public, anon, authenticated, service_role;
grant execute on function public.get_learning_policy(text) to authenticated;
revoke all on function public.list_learning_content(text, text, text, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.list_learning_content(text, text, text, integer, integer) to authenticated;
revoke all on function public.get_learning_workspace(text, text, integer) from public, anon, authenticated, service_role;
grant execute on function public.get_learning_workspace(text, text, integer) to authenticated;
revoke all on function public.save_learning_policy(text, text, boolean, boolean, uuid[], bigint) from public, anon, authenticated, service_role;
grant execute on function public.save_learning_policy(text, text, boolean, boolean, uuid[], bigint) to authenticated;
revoke all on function public.save_learning_content(text, text, jsonb, integer) from public, anon, authenticated, service_role;
grant execute on function public.save_learning_content(text, text, jsonb, integer) to authenticated;
revoke all on function public.transition_learning_content(text, uuid, text, integer, timestamptz, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.transition_learning_content(text, uuid, text, integer, timestamptz, timestamptz) to authenticated;
revoke all on function public.get_learning_history(text, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.get_learning_history(text, uuid, integer) to authenticated;
revoke all on function public.set_learning_home_hidden(text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_learning_home_hidden(text, boolean) to authenticated;
revoke all on function public.list_learning_choices(text, text, integer) from public, anon, authenticated, service_role;
grant execute on function public.list_learning_choices(text, text, integer) to authenticated;
commit;
