-- REQ-UG-DESIGN-BACKEND-P2-20260721: steward hat — role model, request
-- triage, DM replies, broadcast authoring.
-- Roles are provisioned service-side only (no client write path), steward
-- read access widens exactly four tables via role-gated select policies, and
-- every steward write goes through a security-definer RPC that re-checks the
-- role server-side. Steward-authored rows never touch member_action_log, so
-- the phase-1 point economy gains no new minting surface. Steward identity on
-- the wire is always the canon generic 'Chapter steward', never the
-- self-editable profile name, so replies cannot impersonate other roles and
-- do not expose a steward's legal name on member-readable rows.

create table public.member_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('steward', 'coordinator', 'advisor', 'admin')),
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users(id) on delete set null,
  primary key (user_id, role)
);

alter table public.member_steward_requests
  add column acknowledged_at timestamptz,
  add column closed_at timestamptz,
  add column handled_by uuid references auth.users(id) on delete set null;

alter table public.member_broadcasts
  add column created_by uuid references auth.users(id) on delete set null,
  add column retracted_at timestamptz;

-- advisor-flagged unindexed foreign keys on the tables this phase touches,
-- plus the triage queue's hot path.
create index member_steward_requests_user_idx on public.member_steward_requests(user_id);
create index member_steward_requests_lesson_idx on public.member_steward_requests(lesson_id);
create index member_steward_requests_status_created_idx on public.member_steward_requests(status, created_at desc);
create index member_broadcast_receipts_user_idx on public.member_broadcast_receipts(user_id);

-- role membership check used inside policies and rpcs. security definer so
-- policy evaluation on member_roles itself can never recurse, and so the
-- check always reads the live table (revoking a role takes effect on the
-- next statement, with no cached-claim window).
create function public.member_has_role(p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.member_roles
    where user_id = (select auth.uid())
      and role = any(p_roles)
  );
$$;

alter table public.member_roles enable row level security;

create policy member_roles_select_own on public.member_roles
  for select to authenticated using ((select auth.uid()) = user_id);

-- steward read widening: exactly these four tables and nothing else. cases,
-- case updates, notifications, guide threads, votes, survey responses,
-- receipts, point events, and the action log stay self-scoped.
create policy member_steward_requests_select_steward on public.member_steward_requests
  for select to authenticated using (public.member_has_role(array['steward']));

create policy member_conversations_select_steward on public.member_conversations
  for select to authenticated using (public.member_has_role(array['steward']));

create policy member_messages_select_steward on public.member_messages
  for select to authenticated using (public.member_has_role(array['steward']));

create policy member_profiles_select_steward on public.member_profiles
  for select to authenticated using (public.member_has_role(array['steward']));

-- triage is a single conditional update so two stewards racing on the same
-- request cannot double-stamp it; the allowed pre-states encode the
-- forward-only machine requested -> acknowledged -> closed.
create function public.triage_steward_request(p_request_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  updated integer;
  row_out record;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  if p_action = 'acknowledge' then
    update public.member_steward_requests
    set status = 'acknowledged', acknowledged_at = now(), handled_by = caller
    where id = p_request_id and status = 'requested';
  elsif p_action = 'close' then
    update public.member_steward_requests
    set status = 'closed', closed_at = now(), handled_by = caller
    where id = p_request_id and status in ('requested', 'acknowledged');
  else
    raise exception 'unknown triage action' using errcode = '22023';
  end if;

  get diagnostics updated = row_count;
  if updated = 0 then
    raise exception 'request not found or already past this step' using errcode = '22023';
  end if;

  select id, status, acknowledged_at, closed_at into row_out
  from public.member_steward_requests where id = p_request_id;

  return pg_catalog.jsonb_build_object(
    'id', row_out.id,
    'status', row_out.status,
    'acknowledgedAt', row_out.acknowledged_at,
    'closedAt', row_out.closed_at
  );
end;
$$;

-- steward reply lands under the conversation owner so the member's existing
-- self-scoped read policy sees it, exactly like the signup-seeded steward
-- messages. this function must never write member_action_log: the message
-- point backing keys off conversation ownership, and a steward-triggered log
-- row could mint points the member never earned.
create function public.send_steward_reply(p_conversation_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''));
  convo record;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  if clean_body = '' or pg_catalog.char_length(clean_body) > 4000 then
    raise exception 'reply must be between 1 and 4000 characters' using errcode = '22023';
  end if;

  if pg_catalog.regexp_replace(clean_body, '[' || pg_catalog.chr(10) || pg_catalog.chr(9) || ']', '', 'g') ~ '[[:cntrl:]]' then
    raise exception 'reply contains unsupported control characters' using errcode = '22023';
  end if;

  select id, user_id into convo
  from public.member_conversations
  where id = p_conversation_id;

  if not found then
    raise exception 'conversation not found' using errcode = '22023';
  end if;

  insert into public.member_messages (conversation_id, user_id, sender_kind, sender_name, body)
  values (convo.id, convo.user_id, 'steward', 'Chapter steward', clean_body);

  update public.member_conversations set updated_at = now() where id = convo.id;

  return pg_catalog.jsonb_build_object('conversationId', convo.id);
end;
$$;

-- feed-only broadcast authoring. rate-capped per steward so one compromised
-- account cannot flood every member's feed, and new rows take the smallest
-- order_index so legacy ascending readers still see newest first.
create function public.publish_member_broadcast(p_title text, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  clean_title text := pg_catalog.btrim(coalesce(p_title, ''));
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''));
  recent integer;
  new_id text := 'bc-' || extensions.gen_random_uuid();
  next_index integer;
  attempts integer := 0;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  if clean_title = '' or pg_catalog.char_length(clean_title) > 120 then
    raise exception 'title must be between 1 and 120 characters' using errcode = '22023';
  end if;

  if clean_title ~ '[[:cntrl:]]' then
    raise exception 'title contains unsupported control characters' using errcode = '22023';
  end if;

  if clean_body = '' or pg_catalog.char_length(clean_body) > 4000 then
    raise exception 'body must be between 1 and 4000 characters' using errcode = '22023';
  end if;

  if pg_catalog.regexp_replace(clean_body, '[' || pg_catalog.chr(10) || pg_catalog.chr(9) || ']', '', 'g') ~ '[[:cntrl:]]' then
    raise exception 'body contains unsupported control characters' using errcode = '22023';
  end if;

  select count(*) into recent
  from public.member_broadcasts
  where created_by = caller
    and published_at >= now() - interval '24 hours';

  if recent >= 5 then
    raise exception 'broadcast limit reached: 5 per steward per day' using errcode = '54000';
  end if;

  loop
    begin
      select coalesce(min(order_index), 1) - 1 into next_index from public.member_broadcasts;
      insert into public.member_broadcasts (id, sender, title, body, published_at, order_index, created_by)
      values (new_id, 'Chapter steward', clean_title, clean_body, now(), next_index, caller);
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
$$;

-- author-only retraction so a bad broadcast is reversible without service
-- role sql; readers filter retracted rows out of the member feed.
create function public.retract_member_broadcast(p_broadcast_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  updated integer;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  update public.member_broadcasts
  set retracted_at = now()
  where id = p_broadcast_id and created_by = caller and retracted_at is null;

  get diagnostics updated = row_count;
  if updated = 0 then
    raise exception 'broadcast not found, not yours, or already retracted' using errcode = '22023';
  end if;

  return pg_catalog.jsonb_build_object('broadcastId', p_broadcast_id, 'retracted', true);
end;
$$;

-- privacy: counts only, never reader identities. this definer body must not
-- reference receipt reader columns beyond the broadcast key; the repository
-- test pins that contract.
create function public.get_broadcast_read_counts()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'broadcastId', recent.id,
      'readCount', (select count(*) from public.member_broadcast_receipts reads where reads.broadcast_id = recent.id)
    ) order by recent.published_at desc
  ), '[]'::jsonb)
  from (
    select id, published_at
    from public.member_broadcasts
    order by published_at desc
    limit 20
  ) recent
  where public.member_has_role(array['steward']);
$$;

revoke all on public.member_roles from anon, authenticated;
grant select on public.member_roles to authenticated;

-- members keep insert on their own steward requests, but the select grant
-- becomes column-scoped so the triaging steward's identity (handled_by) is
-- never member-readable; status and timestamps remain visible.
revoke select on public.member_steward_requests from authenticated;
grant select (id, user_id, lesson_id, status, created_at, acknowledged_at, closed_at) on public.member_steward_requests to authenticated;

revoke all on function public.member_has_role(text[]) from public, anon;
revoke all on function public.triage_steward_request(uuid, text) from public, anon;
revoke all on function public.send_steward_reply(uuid, text) from public, anon;
revoke all on function public.publish_member_broadcast(text, text) from public, anon;
revoke all on function public.retract_member_broadcast(text) from public, anon;
revoke all on function public.get_broadcast_read_counts() from public, anon;

grant execute on function public.member_has_role(text[]) to authenticated;
grant execute on function public.triage_steward_request(uuid, text) to authenticated;
grant execute on function public.send_steward_reply(uuid, text) to authenticated;
grant execute on function public.publish_member_broadcast(text, text) to authenticated;
grant execute on function public.retract_member_broadcast(text) to authenticated;
grant execute on function public.get_broadcast_read_counts() to authenticated;
