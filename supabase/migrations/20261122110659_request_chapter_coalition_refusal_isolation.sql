-- #9277: inaccessible targets have the complete missing-target refusal.
-- Restated from Main's installed definitions, preserving its lifecycle locks,
-- MFA/role checks, steward-unit grant path and Eastern-day validation.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Source guards match newest Main prosrc; retain the complete-definition
-- guards too, so a changed security/header setting cannot be overwritten.
do $c300_predecessors$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.decide_member_request(uuid,text,uuid)'::regprocedure)
    is distinct from '174c2cc5152931f19f000b848c27acd6' then
    raise exception 'unreviewed predecessor body: public.decide_member_request(uuid,text,uuid)' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.decide_member_request(uuid,text)'::regprocedure)
    is distinct from 'b82e82b120101c27fb5e8728e924e5bc' then
    raise exception 'unreviewed predecessor body: public.decide_member_request(uuid,text)' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.approve_member_request_invitation(uuid,text,text,text)'::regprocedure)
    is distinct from '339ed7bbfa5323e953e85ae599c4a8e5' then
    raise exception 'unreviewed predecessor body: public.approve_member_request_invitation(uuid,text,text,text)' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.update_admin_chapter(text,text,text,integer)'::regprocedure)
    is distinct from '7fb4e25899487fba8ca1c9461318d2a0' then
    raise exception 'unreviewed predecessor body: public.update_admin_chapter(text,text,text,integer)' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.vote_organization_coalition_decision(uuid,text,text,uuid)'::regprocedure)
    is distinct from 'b1d0d7c175925c687a80da974a150740' then
    raise exception 'unreviewed predecessor body: public.vote_organization_coalition_decision(uuid,text,text,uuid)' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.validate_member_operations_import(uuid,uuid)'::regprocedure)
    is distinct from '0b0b2f0d6ed5f637bea06072cc147496' then
    raise exception 'unreviewed predecessor body: public.validate_member_operations_import(uuid,uuid)' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.update_chapter_document_content(uuid,text,text,text,text,text,text)'::regprocedure)
    is distinct from 'cd446fe2f1d178a243a716ee95426cfc' then
    raise exception 'unreviewed predecessor body: public.update_chapter_document_content(uuid,text,text,text,text,text,text)' using errcode='55000';
  end if;
  if (select pg_catalog.md5(pg_catalog.pg_get_functiondef('public.decide_member_request(uuid,text,uuid)'::regprocedure))) is distinct from 'c338dd59f324a9509f738f873414731d' then
    raise exception 'unreviewed predecessor: public.decide_member_request' using errcode='55000';
  end if;
  if (select pg_catalog.md5(pg_catalog.pg_get_functiondef('public.decide_member_request(uuid,text)'::regprocedure))) is distinct from 'e7de6f025b609754d3f2afa5352cc143' then
    raise exception 'unreviewed predecessor: public.decide_member_request' using errcode='55000';
  end if;
  if (select pg_catalog.md5(pg_catalog.pg_get_functiondef('public.approve_member_request_invitation(uuid,text,text,text)'::regprocedure))) is distinct from 'b75b366824891bc5f41cf02cf2e8c63d' then
    raise exception 'unreviewed predecessor: public.approve_member_request_invitation' using errcode='55000';
  end if;
  if (select pg_catalog.md5(pg_catalog.pg_get_functiondef('public.update_admin_chapter(text,text,text,integer)'::regprocedure))) is distinct from '5f00aafab88f43ff9c4e25029de344c6' then
    raise exception 'unreviewed predecessor: public.update_admin_chapter' using errcode='55000';
  end if;
  if (select pg_catalog.md5(pg_catalog.pg_get_functiondef('public.vote_organization_coalition_decision(uuid,text,text,uuid)'::regprocedure))) is distinct from '58f61df43fa2be5763822d6d134620fb' then
    raise exception 'unreviewed predecessor: public.vote_organization_coalition_decision' using errcode='55000';
  end if;
  if (select pg_catalog.md5(pg_catalog.pg_get_functiondef('public.validate_member_operations_import(uuid,uuid)'::regprocedure))) is distinct from '0f4d10545ea67df3e0c194d02678e11a' then
    raise exception 'unreviewed predecessor: public.validate_member_operations_import' using errcode='55000';
  end if;
  if (select pg_catalog.md5(pg_catalog.pg_get_functiondef('public.update_chapter_document_content(uuid,text,text,text,text,text,text)'::regprocedure))) is distinct from '767a3f38f03602757c95869a303ffa83' then
    raise exception 'unreviewed predecessor: public.update_chapter_document_content' using errcode='55000';
  end if;
end;
$c300_predecessors$;

CREATE OR REPLACE FUNCTION public.decide_member_request(p_request_id uuid, p_decision text, p_unit_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  clean_decision text := pg_catalog.btrim(coalesce(p_decision, ''));
  found_row public.member_requests%rowtype;
  saved public.member_requests%rowtype;
  chapter_name text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if clean_decision not in ('approved', 'declined') then
    raise exception 'invalid decision' using errcode = '22023';
  end if;

  select * into found_row
  from public.member_requests r
  where r.id = p_request_id and r.organization_id = org and r.status = 'pending'
    and private.member_request_decidable(r.kind, r.organization_id, r.chapter_id)
  for update of r;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;

  if found_row.kind = 'invitation_suggestion' then
    -- Approving a suggestion creates its invitation in the same transaction:
    -- public.approve_member_request_invitation, through the invitation route.
    if clean_decision = 'approved' then
      raise exception 'approve through the invitation route' using errcode = '22023';
    end if;
    -- A suggestion whose address already has an open invitation in that
    -- chapter (from the invitation page) cannot be declined: that invitation
    -- stands until it is revoked there. An invitation accepted in the past is
    -- history, not an open invitation, and blocks nothing.
    if exists (
      select 1 from public.member_invitations i
      where i.normalized_email = found_row.invitee_email and i.chapter_id = found_row.chapter_id
        and (i.status = 'accepting' or (i.status = 'pending' and i.expires_at > pg_catalog.now()))
    ) then
      raise exception 'invitation already sent' using errcode = '55000';
    end if;
  end if;

  -- An approved access request grants the role through the existing writer,
  -- which checks the caller's authority and the member's membership again.
  -- #7663: a steward is granted only with the unit the decider chose.
  if clean_decision = 'approved' and found_row.requested_role = 'steward' then
    if p_unit_id is null then
      raise exception 'steward approval requires a chapter unit' using errcode = '22023';
    end if;
    perform public.set_member_access_role(found_row.requester_user_id, found_row.chapter_id, 'steward', true, p_unit_id, null::uuid);
  elsif clean_decision = 'approved' then
    perform public.set_member_chapter_role(found_row.requester_user_id, found_row.chapter_id, found_row.requested_role, true);
  end if;

  update public.member_requests r
  set status = clean_decision, decided_at = pg_catalog.now(), decided_by = caller
  where r.id = found_row.id
  returning * into saved;

  select c.name into chapter_name from public.chapters c where c.id = saved.chapter_id;
  perform private.notify_member(saved.requester_user_id,
    'requests.' || case saved.kind when 'invitation_suggestion' then 'suggestion' else 'access' end || '.' || clean_decision,
    pg_catalog.jsonb_build_object('name', coalesce(saved.invitee_name, ''), 'chapter', coalesce(chapter_name, saved.chapter_id)),
    'general');

  return private.member_request_json(saved);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.decide_member_request(p_request_id uuid, p_decision text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return public.decide_member_request(p_request_id, p_decision, null::uuid);
end;
$function$;

CREATE OR REPLACE FUNCTION public.approve_member_request_invitation(p_request_id uuid, p_email text, p_locale text, p_token_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  found_row public.member_requests%rowtype;
  created jsonb;
  chapter_name text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into found_row
  from public.member_requests r
  where r.id = p_request_id and r.organization_id = org
    and r.kind = 'invitation_suggestion' and r.status = 'pending'
    and private.member_request_decidable(r.kind, r.organization_id, r.chapter_id)
  for update of r;
  -- 22023 reaches the route as request-unavailable: nothing was created.
  if not found then
    raise exception 'request not found' using errcode = '22023';
  end if;
  -- The route checks the address it will send to before calling; it must be
  -- this request's address.
  if pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, ''))) <> found_row.invitee_email then
    raise exception 'invalid invitation request' using errcode = '22023';
  end if;

  -- The invitation itself, with every check, limit and answer of the
  -- invitation page. Any refusal raises, and the request stays pending.
  created := public.create_member_invitation(found_row.invitee_email, found_row.invitee_name,
    found_row.chapter_id, null, p_locale, p_token_hash);
  update public.member_requests r
  set status = 'approved', decided_at = pg_catalog.now(), decided_by = caller
  where r.id = found_row.id;

  select c.name into chapter_name from public.chapters c where c.id = found_row.chapter_id;
  perform private.notify_member(found_row.requester_user_id, 'requests.suggestion.approved',
    pg_catalog.jsonb_build_object('name', found_row.invitee_name, 'chapter', coalesce(chapter_name, found_row.chapter_id)),
    'general');
  return created;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.update_admin_chapter(p_chapter_id text, p_name text, p_region text DEFAULT NULL::text, p_order_index integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  caller uuid := (select auth.uid());
  org_id uuid := private.current_member_organization();
  org_admin boolean;
  chapter_row record;
  clean_name text := pg_catalog.btrim(coalesce(p_name, ''));
  clean_region text := nullif(pg_catalog.btrim(coalesce(p_region, '')), '');
  clean_order integer := p_order_index;
  changed text[] := '{}'::text[];
begin
  if caller is null then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_name) < 2
     or pg_catalog.char_length(clean_name) > 120
     or clean_name ~ '[[:cntrl:]]'
     or (clean_region is not null and (pg_catalog.char_length(clean_region) > 120 or clean_region ~ '[[:cntrl:]]'))
     or clean_order is null or clean_order < 1 or clean_order > 10000 then
    raise exception 'invalid chapter' using errcode = '22023';
  end if;

  org_admin := private.has_organization_role(org_id, array['admin']);
  select c.* into chapter_row
  from public.chapters c
  where c.id = p_chapter_id and c.organization_id = org_id
    and (org_admin or (c.id = private.current_member_chapter()
      and private.member_has_chapter_role(c.id, array['admin'])))
  for update of c;
  if not found then
    raise exception 'chapter unavailable' using errcode = '22023';
  end if;
  if not org_admin and (
       clean_region is distinct from chapter_row.region
       or clean_order is distinct from chapter_row.order_index
     ) then
    raise exception 'organization admin required for chapter structure' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.chapters c
    where c.organization_id = org_id
      and c.id <> p_chapter_id
      and pg_catalog.lower(c.name) = pg_catalog.lower(clean_name)
  ) then
    raise exception 'chapter already exists' using errcode = '23505';
  end if;
  if clean_name is distinct from chapter_row.name then changed := pg_catalog.array_append(changed, 'name'); end if;
  if clean_region is distinct from chapter_row.region then changed := pg_catalog.array_append(changed, 'region'); end if;
  if clean_order is distinct from chapter_row.order_index then changed := pg_catalog.array_append(changed, 'orderIndex'); end if;

  if pg_catalog.cardinality(changed) > 0 then
    update public.chapters
    set name = clean_name, region = clean_region, order_index = clean_order
    where id = p_chapter_id;
    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_chapter', pg_catalog.jsonb_build_object(
      'chapterId', p_chapter_id, 'fields', pg_catalog.to_jsonb(changed)));
  end if;

  return pg_catalog.jsonb_build_object(
    'id', p_chapter_id, 'name', clean_name, 'region', clean_region,
    'isDefault', chapter_row.is_default, 'orderIndex', clean_order,
    'updated', pg_catalog.cardinality(changed) > 0);
end;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.vote_organization_coalition_decision(p_decision_id uuid, p_vote text, p_comment text DEFAULT ''::text, p_idempotency_key uuid DEFAULT extensions.gen_random_uuid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  decision public.organization_coalition_decisions%rowtype;
  campaign public.organization_coordination_records%rowtype;
  eligible_count integer;
  approval_count integer;
  rejection_count integer;
  next_status text := 'open';
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.organization_coordination_is_staff(organization) then
    raise exception 'coalition vote role required' using errcode = '42501';
  end if;
  if p_vote not in ('approve', 'reject', 'abstain')
    or pg_catalog.char_length(coalesce(p_comment, '')) > 1000 then
    raise exception 'coalition vote unavailable' using errcode = '22023';
  end if;
  select item.* into decision
  from public.organization_coalition_decisions item
  where item.id = p_decision_id and item.status = 'open'
    and private.organization_coordination_can_read(item.campaign_id)
    and exists (
      select 1 from public.organization_coordination_organization_participants participant
      where participant.record_id = item.campaign_id
        and participant.organization_id = organization
        and participant.status = 'active'
    )
  for update of item;
  if not found then
    raise exception 'open coalition decision unavailable' using errcode = '22023';
  end if;
  select * into campaign
  from public.organization_coordination_records record
  where record.id = decision.campaign_id;

  insert into public.organization_coalition_decision_votes (
    decision_id, organization_id, voter_user_id, vote, comment,
    idempotency_key
  ) values (
    decision.id, organization, caller, p_vote, coalesce(p_comment, ''),
    p_idempotency_key
  ) on conflict (decision_id, organization_id) do update
    set voter_user_id = caller,
        vote = excluded.vote,
        comment = excluded.comment,
        idempotency_key = excluded.idempotency_key,
        updated_at = pg_catalog.clock_timestamp();

  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) filter (where vote.vote = 'approve')::integer,
    pg_catalog.count(*) filter (where vote.vote = 'reject')::integer
  into eligible_count, approval_count, rejection_count
  from public.organization_coordination_organization_participants participant
  left join public.organization_coalition_decision_votes vote
    on vote.decision_id = decision.id
      and vote.organization_id = participant.organization_id
  where participant.record_id = campaign.id and participant.status = 'active';

  if approval_count >= decision.required_approvals then
    next_status := 'approved';
  elsif eligible_count - rejection_count < decision.required_approvals then
    next_status := 'rejected';
  end if;

  if next_status <> 'open' then
    update public.organization_coalition_decisions
    set status = next_status,
        resolved_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    where id = decision.id;
  else
    update public.organization_coalition_decisions
    set updated_at = pg_catalog.clock_timestamp()
    where id = decision.id;
  end if;

  if next_status = 'approved' then
    update public.organization_coordination_records
    set status = case decision.action
          when 'authorize_work' then 'active'
          when 'pause_work' then 'paused'
          when 'complete_work' then 'completed'
        end,
        updated_at = pg_catalog.clock_timestamp()
    where id = decision.subject_record_id;
  end if;

  insert into public.organization_coordination_events (
    record_id, organization_id, actor_user_id, event_type, to_status,
    metadata, idempotency_key
  ) values (
    campaign.id, organization, caller, 'coalition_decision_voted', next_status,
    pg_catalog.jsonb_build_object(
      'decisionId', decision.id, 'vote', p_vote,
      'approvals', approval_count, 'rejections', rejection_count,
      'requiredApprovals', decision.required_approvals
    ), extensions.gen_random_uuid()
  );
  return pg_catalog.jsonb_build_object(
    'decisionId', decision.id, 'status', next_status,
    'approvals', approval_count, 'rejections', rejection_count,
    'requiredApprovals', decision.required_approvals,
    'eligibleOrganizations', eligible_count
  );
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.validate_member_operations_import(p_batch_id uuid, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.require_member_operations_admin();
  batch public.organization_import_batches%rowtype;
  row_item public.organization_import_rows%rowtype;
  errors jsonb;
  member_id uuid;
  raw_member_id text;
  raw_hire_date text;
  raw_deadline text;
  valid_rows integer;
  invalid_rows integer;
  request_payload jsonb := pg_catalog.jsonb_build_object('batchId', p_batch_id);
  prior jsonb;
  result jsonb;
begin
  prior := private.member_operations_replay(
    org, 'validate_member_operations_import', p_idempotency_key, request_payload
  );
  if prior is not null then return prior; end if;
  select * into batch from public.organization_import_batches where id = p_batch_id and organization_id = org for update;
  if not found or batch.state in ('committed','discarded') then raise exception 'batch is not editable' using errcode = '55000'; end if;
  for row_item in select * from public.organization_import_rows row where row.batch_id = batch.id order by row.row_number
  loop
    errors := '[]'::jsonb;
    member_id := null;
    raw_member_id := nullif(pg_catalog.btrim(coalesce(row_item.normalized_data ->> 'member_id', '')), '');
    if raw_member_id is not null then
      if raw_member_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
        member_id := raw_member_id::uuid;
      else
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'field','member_id','code','invalid_uuid','message','Member ID must be a UUID'
        ));
      end if;
    end if;
    if member_id is null and coalesce(row_item.normalized_data ->> 'email', row_item.normalized_data ->> 'member_email') is not null then
      select membership.user_id into member_id
      from public.organization_memberships membership join auth.users user_row on user_row.id = membership.user_id
      where membership.organization_id = org and membership.status = 'active'
        and pg_catalog.lower(user_row.email) = pg_catalog.lower(coalesce(row_item.normalized_data ->> 'email', row_item.normalized_data ->> 'member_email'))
      limit 1;
    end if;
    if member_id is null or not exists (select 1 from public.organization_memberships membership
      where membership.organization_id = org and membership.user_id = member_id and membership.status = 'active') then
      -- A supplied id outside this organization is an unresolved member.
      -- Do not use it for chapter, case-reference or stored resolution lookups.
      member_id := null;
      errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','member','code','member_not_found','message','Existing active member not found'));
    end if;
    if batch.kind = 'member' then
      if pg_catalog.char_length(coalesce(row_item.normalized_data ->> 'member_number', '')) > 80 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','member_number','code','too_long','message','Member number is limited to 80 characters'));
      end if;
      if pg_catalog.char_length(coalesce(row_item.normalized_data ->> 'job_title', '')) > 160 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','job_title','code','too_long','message','Job title is limited to 160 characters'));
      end if;
      if pg_catalog.char_length(coalesce(row_item.normalized_data ->> 'department', '')) > 160 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','department','code','too_long','message','Department is limited to 160 characters'));
      end if;
      if pg_catalog.char_length(coalesce(row_item.normalized_data ->> 'work_location', '')) > 200 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','work_location','code','too_long','message','Work location is limited to 200 characters'));
      end if;
      if pg_catalog.char_length(coalesce(row_item.normalized_data ->> 'membership_class', '')) > 120 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','membership_class','code','too_long','message','Membership classification is limited to 120 characters'));
      end if;
      if pg_catalog.char_length(coalesce(row_item.normalized_data ->> 'administrative_notes', '')) > 4000 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','administrative_notes','code','too_long','message','Administrative notes are limited to 4,000 characters'));
      end if;
      if nullif(row_item.normalized_data ->> 'preferred_language', '') is not null
         and row_item.normalized_data ->> 'preferred_language' not in ('en','es') then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','preferred_language','code','invalid_language','message','Preferred language must be en or es'));
      end if;
      raw_hire_date := nullif(pg_catalog.btrim(coalesce(row_item.normalized_data ->> 'hire_date', '')), '');
      if raw_hire_date is not null then
        begin
          perform raw_hire_date::date;
        exception when others then
          errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','hire_date','code','invalid_date','message','Hire date must be a valid date'));
        end;
      end if;
      if nullif(pg_catalog.btrim(coalesce(row_item.normalized_data ->> 'member_number', '')), '') is not null and (
        exists (
          select 1 from public.organization_import_rows duplicate_row
          where duplicate_row.batch_id = batch.id and duplicate_row.row_number <> row_item.row_number
            and pg_catalog.lower(pg_catalog.btrim(duplicate_row.normalized_data ->> 'member_number'))
              = pg_catalog.lower(pg_catalog.btrim(row_item.normalized_data ->> 'member_number'))
        ) or exists (
          select 1 from public.organization_member_operational_profiles profile
          where profile.organization_id = org and profile.member_user_id is distinct from member_id
            and pg_catalog.lower(profile.member_number) = pg_catalog.lower(pg_catalog.btrim(row_item.normalized_data ->> 'member_number'))
        )
      ) then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','member_number','code','duplicate','message','Member number must be unique'));
      end if;
    else
      if pg_catalog.char_length(pg_catalog.btrim(coalesce(row_item.normalized_data ->> 'title', ''))) not between 1 and 200 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','title','code','invalid_title','message','Title is required and limited to 200 characters'));
      end if;
      if pg_catalog.char_length(pg_catalog.btrim(coalesce(row_item.normalized_data ->> 'reference', ''))) not between 1 and 120 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','reference','code','invalid_reference','message','Reference is required and limited to 120 characters'));
      end if;
      if pg_catalog.char_length(coalesce(row_item.normalized_data ->> 'articles', '')) > 500 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','articles','code','too_long','message','Articles are limited to 500 characters'));
      end if;
      if not exists (select 1 from public.chapters chapter where chapter.id = row_item.normalized_data ->> 'chapter_id' and chapter.organization_id = org) then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','chapter_id','code','chapter_not_found','message','Chapter not found'));
      end if;
      if member_id is not null and not exists (
        select 1
        from public.member_profiles profile
        where profile.id = member_id
          and profile.chapter_id = row_item.normalized_data ->> 'chapter_id'
      ) then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'field','chapter_id','code','case_owner_chapter_mismatch',
          'message','Grievance chapter must match the member case-owning chapter'
        ));
      end if;
      raw_deadline := nullif(pg_catalog.btrim(coalesce(row_item.normalized_data ->> 'deadline', '')), '');
      if raw_deadline is not null then
        begin
          perform raw_deadline::date;
          if raw_deadline::date < (select private.eastern_day()) - 3650 or raw_deadline::date > (select private.eastern_day()) + 3650 then
            errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','deadline','code','out_of_range','message','Deadline must be within 10 years'));
          end if;
        exception when others then
          errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','deadline','code','invalid_date','message','Deadline must be a valid date'));
        end;
      end if;
      if member_id is not null and nullif(pg_catalog.btrim(coalesce(row_item.normalized_data ->> 'reference', '')), '') is not null and (
        exists (
          select 1 from public.organization_import_rows duplicate_row
          where duplicate_row.batch_id = batch.id and duplicate_row.row_number <> row_item.row_number
            and duplicate_row.normalized_data ->> '_resolved_member_id' = member_id::text
            and pg_catalog.lower(pg_catalog.btrim(duplicate_row.normalized_data ->> 'reference'))
              = pg_catalog.lower(pg_catalog.btrim(row_item.normalized_data ->> 'reference'))
        ) or exists (
          select 1 from public.member_cases existing_case
          where existing_case.user_id = member_id
            and pg_catalog.lower(existing_case.reference) = pg_catalog.lower(pg_catalog.btrim(row_item.normalized_data ->> 'reference'))
        )
      ) then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','reference','code','duplicate','message','Reference already exists for this member'));
      end if;
    end if;
    update public.organization_import_rows set normalized_data = normalized_data || pg_catalog.jsonb_build_object('_resolved_member_id', member_id),
      validation_errors = errors where batch_id = batch.id and row_number = row_item.row_number;
  end loop;
  select pg_catalog.count(*) filter (where pg_catalog.jsonb_array_length(row.validation_errors) = 0),
    pg_catalog.count(*) filter (where pg_catalog.jsonb_array_length(row.validation_errors) > 0)
  into valid_rows, invalid_rows from public.organization_import_rows row where row.batch_id = batch.id;
  update public.organization_import_batches set state = 'validated', valid_count = valid_rows, error_count = invalid_rows,
    validated_at = pg_catalog.now() where id = batch.id;
  result := pg_catalog.jsonb_build_object(
    'id', batch.id, 'state', 'validated', 'validCount', valid_rows, 'errorCount', invalid_rows
  );
  perform private.member_operations_store_receipt(
    org, 'validate_member_operations_import', p_idempotency_key, request_payload, result
  );
  return result;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.update_chapter_document_content(p_id uuid, p_title text, p_document_type text, p_summary text, p_body text, p_visibility text, p_action text DEFAULT 'save'::text)
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
  select d.* into row from public.chapter_documents d
  where d.id=p_id and d.chapter_id=chapter
    and private.chapter_document_container_allows(chapter,d.access_unit_id,d.access_committee_id)
  for update of d;
  if row.id is null then raise exception 'document unavailable' using errcode='22023'; end if;
  if not ((private.member_has_chapter_staff_grant(chapter,array['steward','coordinator','advisor','admin','vp']) and private.chapter_document_container_allows(chapter,row.access_unit_id,row.access_committee_id) and private.unit_staff_capability_allows(chapter,row.access_unit_id,'documents')) or private.chapter_officer_can_for_scope(chapter,'documents',row.access_unit_id,row.access_committee_id)) then raise exception 'document outside access scope' using errcode='42501'; end if;
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

notify pgrst, 'reload schema';
commit;
