-- REQ-UG-QUOTES-MINI-LESSONS-20260928
-- A stale editor revision is a permanent HTTP 409 conflict. SQLSTATE 40001
-- asks PostgREST 14 to retry the transaction indefinitely. Preserve the
-- installed migrations, signatures, authorization, grants and CAS checks.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create or replace function public.save_learning_policy(p_chapter_id text,p_scope text,p_quotes_enabled boolean,p_lessons_enabled boolean,p_selected_ids uuid[] default null,p_expected_revision bigint default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare org uuid; saved private.learning_policies;
begin
  perform private.lock_case_graph(array[(select auth.uid())],array[]::uuid[]);
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode='42501'; end if;
  org:=private.learning_context(p_chapter_id); perform private.learning_require_manage(p_scope,org,p_chapter_id);
  if p_expected_revision is distinct from coalesce((select revision from private.learning_policies where scope_key=private.learning_scope_key(p_scope,org,p_chapter_id)),0) then raise exception 'revision conflict' using errcode='PT409'; end if;
  if p_quotes_enabled is null or p_lessons_enabled is null or cardinality(p_selected_ids)>500 or array_position(p_selected_ids,null) is not null then raise exception 'invalid content policy' using errcode='22023'; end if;
  if p_scope='platform' and p_selected_ids is not null then raise exception 'platform uses reviewed default library' using errcode='22023'; end if;
  if exists(select 1 from unnest(p_selected_ids) requested(id) where not exists(select 1 from private.learning_content r where r.id=requested.id and (r.scope='platform' or (r.organization_id=org and (r.scope='organization' or (p_scope='chapter' and r.chapter_id=p_chapter_id)))))) then raise exception 'selection outside scope' using errcode='42501'; end if;
  insert into private.learning_policies(scope_key,scope,organization_id,chapter_id,quotes_enabled,lessons_enabled,selected_ids)
  values(private.learning_scope_key(p_scope,org,p_chapter_id),p_scope,case when p_scope<>'platform' then org end,case when p_scope='chapter' then p_chapter_id end,p_quotes_enabled,p_lessons_enabled,p_selected_ids)
  on conflict(scope_key) do update set quotes_enabled=excluded.quotes_enabled,lessons_enabled=excluded.lessons_enabled,selected_ids=excluded.selected_ids,revision=private.learning_policies.revision+1
    where private.learning_policies.revision=p_expected_revision returning * into saved;
  if not found then raise exception 'revision conflict' using errcode='PT409'; end if;
  insert into private.learning_history(scope_key,revision,action,changed_by,snapshot) values(saved.scope_key,saved.revision,'policy',(select auth.uid()),to_jsonb(saved));
  return to_jsonb(saved);
end; $$;

create or replace function public.save_learning_content(p_chapter_id text,p_scope text,p_item jsonb,p_expected_revision integer default null) returns jsonb
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
    if p_expected_revision is not null then raise exception 'revision conflict' using errcode='PT409'; end if;
    insert into private.learning_content(scope,organization_id,chapter_id,payload) values(p_scope,case when p_scope<>'platform' then org end,case when p_scope='chapter' then p_chapter_id end,v_payload) returning * into r;
  else
    select * into r from private.learning_content where id=item_id for update;
    if not found or r.scope is distinct from p_scope or (r.scope<>'platform' and r.organization_id is distinct from org) or (r.scope='chapter' and r.chapter_id is distinct from p_chapter_id) then raise exception 'content unavailable' using errcode='42501'; end if;
    if p_expected_revision is distinct from r.revision then raise exception 'revision conflict' using errcode='PT409'; end if;
    update private.learning_content set payload=v_payload, status='draft',starts_at=null,ends_at=null,revision=revision+1 where id=item_id returning * into r;
  end if;
  perform private.learning_audit(r,'save_draft'); return private.learning_projection(r);
end; $$;

create or replace function public.transition_learning_content(p_chapter_id text,p_id uuid,p_action text,p_expected_revision integer,p_starts_at timestamptz default null,p_ends_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare org uuid; r private.learning_content; starts timestamptz;
begin
  perform private.lock_case_graph(array[(select auth.uid())],array[]::uuid[]);
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode='42501'; end if;
  org:=private.learning_context(p_chapter_id);
  select * into r from private.learning_content where id=p_id for update;
  if not found or (r.scope<>'platform' and r.organization_id is distinct from org) or (r.scope='chapter' and r.chapter_id is distinct from p_chapter_id) then raise exception 'content unavailable' using errcode='42501'; end if;
  perform private.learning_require_manage(r.scope,org,p_chapter_id);
  if p_expected_revision is distinct from r.revision then raise exception 'revision conflict' using errcode='PT409'; end if;
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

notify pgrst, 'reload schema';
commit;
