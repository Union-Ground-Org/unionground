-- Union Ground mobile ship-complete workflows.
--
-- This migration turns the remaining visual-only mobile concepts into
-- chapter-scoped state machines. It contains no organization, credential,
-- agreement, health, or provider fixtures. Empty tenants stay empty.

set local lock_timeout = '5s';

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
  select public.member_has_role(p_roles) and exists (
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
            and rc.chapter_id = p_chapter_id
            and m.status = 'active'
        )
      )
  );
$function$;

revoke all on function private.member_has_chapter_role(text, text[])
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------- two-sided handshake

create table public.chapter_union_org_bindings (
  chapter_id text primary key references public.chapters(id) on update cascade on delete restrict,
  union_org_id text not null unique references public.union_orgs(id) on update cascade on delete restrict,
  status text not null default 'requested' check (status in ('requested', 'verified', 'rejected')),
  requested_by uuid not null references auth.users(id) on delete restrict,
  requested_at timestamptz not null default pg_catalog.now(),
  verified_by uuid references auth.users(id) on delete set null,
  verified_at timestamptz,
  public_note text not null default '' check (pg_catalog.char_length(public_note) <= 500),
  constraint chapter_union_org_bindings_verification_complete check (
    (status = 'requested' and verified_by is null and verified_at is null)
    or (status = 'verified' and verified_at is not null)
    or status = 'rejected'
  )
);

alter table public.chapter_handshakes
  add column receiving_chapter_id text references public.chapters(id) on update cascade on delete restrict,
  add column requester_signed_by uuid references auth.users(id) on delete set null,
  add column requester_signed_at timestamptz,
  add column receiver_signed_by uuid references auth.users(id) on delete set null,
  add column receiver_signed_at timestamptz,
  add constraint chapter_handshakes_distinct_chapters
    check (receiving_chapter_id is null or receiving_chapter_id <> chapter_id),
  add constraint chapter_handshakes_requester_signature_complete check (
    (requester_signed_by is null and requester_signed_at is null)
    or (requester_signed_by is not null and requester_signed_at is not null)
  ),
  add constraint chapter_handshakes_receiver_signature_complete check (
    (receiver_signed_by is null and receiver_signed_at is null)
    or (receiver_signed_by is not null and receiver_signed_at is not null)
  );

create index chapter_handshakes_receiving_status_idx
  on public.chapter_handshakes (receiving_chapter_id, status, updated_at desc)
  where receiving_chapter_id is not null;

create table public.chapter_handshake_events (
  id uuid primary key default extensions.gen_random_uuid(),
  handshake_id uuid not null references public.chapter_handshakes(id) on delete cascade,
  idempotency_key uuid not null unique,
  actor uuid references auth.users(id) on delete set null,
  actor_chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  transition text not null check (transition in ('requested', 'accepted', 'declined', 'countersigned', 'activated', 'closed', 'document_shared')),
  from_status text,
  to_status text not null,
  detail jsonb not null default '{}'::jsonb check (pg_catalog.length(detail::text) <= 2000),
  created_at timestamptz not null default pg_catalog.now()
);

create index chapter_handshake_events_handshake_idx
  on public.chapter_handshake_events (handshake_id, created_at, id);

create table public.chapter_handshake_documents (
  handshake_id uuid not null references public.chapter_handshakes(id) on delete cascade,
  document_id uuid not null references public.chapter_documents(id) on delete restrict,
  shared_by uuid references auth.users(id) on delete set null,
  shared_at timestamptz not null default pg_catalog.now(),
  primary key (handshake_id, document_id)
);

alter table public.chapter_union_org_bindings enable row level security;
alter table public.chapter_handshake_events enable row level security;
alter table public.chapter_handshake_documents enable row level security;

create policy chapter_union_org_bindings_read_onboarded
  on public.chapter_union_org_bindings for select to authenticated
  using (
    chapter_id = private.current_member_chapter()
    or (status = 'verified' and private.member_has_chapter_role(
      private.current_member_chapter(), array['steward','coordinator','advisor','admin','vp']))
  );
create policy chapter_handshake_events_read_participant
  on public.chapter_handshake_events for select to authenticated
  using (
    private.member_has_chapter_role(
      private.current_member_chapter(), array['steward','coordinator','advisor','admin','vp'])
    and exists (
      select 1 from public.chapter_handshakes h
      where h.id = handshake_id
        and private.current_member_chapter() in (h.chapter_id, h.receiving_chapter_id)
    )
  );
create policy chapter_handshake_documents_read_participant
  on public.chapter_handshake_documents for select to authenticated
  using (
    private.member_has_chapter_role(
      private.current_member_chapter(), array['steward','coordinator','advisor','admin','vp'])
    and exists (
      select 1 from public.chapter_handshakes h
      where h.id = handshake_id and h.status = 'active'
        and private.current_member_chapter() in (h.chapter_id, h.receiving_chapter_id)
    )
  );

create policy mfa_assurance on public.chapter_union_org_bindings
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.chapter_handshake_events
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.chapter_handshake_documents
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));

drop policy if exists chapter_handshakes_read on public.chapter_handshakes;
drop policy if exists chapter_handshakes_staff_create on public.chapter_handshakes;
drop policy if exists chapter_handshakes_staff_write on public.chapter_handshakes;
create policy chapter_handshakes_read_participant
  on public.chapter_handshakes for select to authenticated
  using (
    private.current_member_chapter() in (chapter_id, receiving_chapter_id)
    and private.member_has_chapter_role(
      private.current_member_chapter(), array['steward','coordinator','advisor','admin','vp'])
  );

-- A shared record must be useful, not just disclose an otherwise unreadable UUID.
-- Preserve the chapter's current published/draft policy, including the explicit
-- President draft-read grant added by 20260808040000_vp_draft_documents_read,
-- and add only published documents attached to an active handshake for
-- authorized staff in either participant chapter. Ordinary members never gain
-- handshake or document read.
alter policy chapter_documents_read on public.chapter_documents
  using (
    (
      chapter_id = private.current_member_chapter()
      and (
        (status = 'published' and (
          visibility = 'chapter'
          or public.member_has_role(array['steward','coordinator','advisor','admin','vp'])
        ))
        or public.member_has_role(array['steward','coordinator','advisor','admin','vp'])
      )
    )
    or (
      status = 'published'
      and private.member_has_chapter_role(
        private.current_member_chapter(), array['steward','coordinator','advisor','admin','vp'])
      and exists (
        select 1
        from public.chapter_handshake_documents hd
        join public.chapter_handshakes h on h.id = hd.handshake_id
        where hd.document_id = chapter_documents.id
          and h.status = 'active'
          and private.current_member_chapter() in (h.chapter_id, h.receiving_chapter_id)
      )
    )
  );

revoke all on public.chapter_union_org_bindings from public, anon, authenticated;
revoke all on public.chapter_handshake_events from public, anon, authenticated;
revoke all on public.chapter_handshake_documents from public, anon, authenticated;
revoke all on public.chapter_handshakes from authenticated;
grant select on public.chapter_handshakes to authenticated;
grant select on public.chapter_union_org_bindings to authenticated;
grant select on public.chapter_handshake_events to authenticated;
grant select on public.chapter_handshake_documents to authenticated;

create function public.request_chapter_union_org_binding(p_union_org_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
begin
  if caller is null or chapter is null
     or not private.member_has_chapter_role(chapter, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.union_orgs o where o.id = p_union_org_id) then
    raise exception 'organization unavailable' using errcode = '22023';
  end if;
  insert into public.chapter_union_org_bindings
    (chapter_id, union_org_id, status, requested_by)
  values (chapter, p_union_org_id, 'requested', caller)
  on conflict (chapter_id) do update
    set union_org_id = excluded.union_org_id, status = 'requested',
        requested_by = caller, requested_at = pg_catalog.clock_timestamp(),
        verified_by = null, verified_at = null, public_note = '';
  return pg_catalog.jsonb_build_object('requested', true, 'chapterId', chapter);
end;
$function$;

create function public.verify_chapter_union_org_binding(
  p_chapter_id text,
  p_union_org_id text,
  p_verified boolean,
  p_public_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare changed integer;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  update public.chapter_union_org_bindings
  set status = case when p_verified then 'verified' else 'rejected' end,
      verified_by = null,
      verified_at = case when p_verified then pg_catalog.clock_timestamp() else null end,
      public_note = pg_catalog.left(coalesce(p_public_note, ''), 500)
  where chapter_id = p_chapter_id and union_org_id = p_union_org_id and status = 'requested';
  get diagnostics changed = row_count;
  if changed = 0 then raise exception 'binding unavailable' using errcode = '22023'; end if;
  return pg_catalog.jsonb_build_object('verified', p_verified, 'chapterId', p_chapter_id);
end;
$function$;

create function private.notify_handshake_staff(
  p_chapter_id text,
  p_title text,
  p_body text
)
returns void
language sql
security definer
set search_path = ''
as $function$
  insert into public.member_notifications (user_id, title, body, kind)
  select distinct recipients.user_id, p_title, p_body, 'general'
  from (
    select rc.user_id
    from public.member_role_chapters rc
    join public.member_chapter_memberships m
      on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id and m.status = 'active'
    where rc.chapter_id = p_chapter_id
      and rc.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
    union
    select r.user_id from public.member_roles r
    where r.chapter_id is null and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  ) recipients;
$function$;

revoke all on function private.notify_handshake_staff(text, text, text)
  from public, anon, authenticated, service_role;

create function public.request_chapter_handshake(
  p_partner_org_id text,
  p_title text,
  p_purpose text,
  p_data_scope text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  receiving text;
  created public.chapter_handshakes%rowtype;
  prior_event public.chapter_handshake_events%rowtype;
begin
  if caller is null or chapter is null
     or not private.member_has_chapter_role(chapter, array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_idempotency_key is null or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title,''))) not between 1 and 160
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_purpose,''))) not between 1 and 4000
     or p_data_scope not in ('docs_only','no_member_data','aggregate_only') then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  select b.chapter_id into receiving
  from public.chapter_union_org_bindings b
  where b.union_org_id = p_partner_org_id and b.status = 'verified';
  if receiving is null or receiving = chapter then
    raise exception 'partner is not onboarded for two-sided requests' using errcode = '22023';
  end if;
  select * into prior_event from public.chapter_handshake_events e
  where e.idempotency_key = p_idempotency_key;
  if found then
    select h.* into created from public.chapter_handshakes h
    where h.id = prior_event.handshake_id;
    if prior_event.transition <> 'requested' or prior_event.actor <> caller
       or created.chapter_id <> chapter or created.receiving_chapter_id <> receiving
       or created.partner_org_id <> p_partner_org_id
       or created.title <> pg_catalog.btrim(p_title)
       or created.purpose <> pg_catalog.btrim(p_purpose)
       or created.data_scope <> p_data_scope then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return pg_catalog.to_jsonb(created);
  end if;
  insert into public.chapter_handshakes
    (chapter_id, receiving_chapter_id, partner_org_id, title, purpose, data_scope,
     status, requested_by, requested_at)
  values (chapter, receiving, p_partner_org_id, pg_catalog.btrim(p_title),
    pg_catalog.btrim(p_purpose), p_data_scope, 'requested', caller, pg_catalog.clock_timestamp())
  returning * into created;
  insert into public.chapter_handshake_events
    (handshake_id, idempotency_key, actor, actor_chapter_id, transition, from_status, to_status)
  values (created.id, p_idempotency_key, caller, chapter, 'requested', 'draft', 'requested');
  perform private.notify_handshake_staff(receiving, 'Partnership request received',
    'An authorized chapter sent a two-sided partnership request for review.');
  return pg_catalog.to_jsonb(created);
end;
$function$;

create function public.respond_chapter_handshake(
  p_handshake_id uuid,
  p_decision text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  item public.chapter_handshakes%rowtype;
  prior_event public.chapter_handshake_events%rowtype;
  next_status text;
begin
  if caller is null or chapter is null
     or not private.member_has_chapter_role(chapter, array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_decision not in ('accept','decline') or p_idempotency_key is null then
    raise exception 'invalid response' using errcode = '22023';
  end if;
  select * into item from public.chapter_handshakes where id = p_handshake_id for update;
  if not found or item.receiving_chapter_id <> chapter then
    raise exception 'request unavailable' using errcode = '42501';
  end if;
  select * into prior_event from public.chapter_handshake_events
  where idempotency_key = p_idempotency_key;
  if found then
    if prior_event.handshake_id <> item.id or prior_event.actor <> caller
       or prior_event.transition <> (case when p_decision = 'accept' then 'accepted' else 'declined' end) then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return pg_catalog.to_jsonb(item);
  end if;
  if item.status <> 'requested' then raise exception 'request already resolved' using errcode = '22023'; end if;
  next_status := case when p_decision = 'accept' then 'accepted' else 'declined' end;
  update public.chapter_handshakes
  set status = next_status,
      receiver_signed_by = case when p_decision = 'accept' then caller else null end,
      receiver_signed_at = case when p_decision = 'accept' then pg_catalog.clock_timestamp() else null end,
      countersigned_by = case when p_decision = 'accept' then caller else null end,
      countersigned_at = case when p_decision = 'accept' then pg_catalog.clock_timestamp() else null end
  where id = item.id returning * into item;
  insert into public.chapter_handshake_events
    (handshake_id, idempotency_key, actor, actor_chapter_id, transition, from_status, to_status)
  values (item.id, p_idempotency_key, caller, chapter,
    case when p_decision = 'accept' then 'accepted' else 'declined' end,
    'requested', next_status);
  perform private.notify_handshake_staff(item.chapter_id,
    case when p_decision = 'accept' then 'Partnership request accepted' else 'Partnership request declined' end,
    case when p_decision = 'accept'
      then 'The receiving chapter accepted. An authorized requester must countersign before activation.'
      else 'The receiving chapter declined the request.' end);
  return pg_catalog.to_jsonb(item);
end;
$function$;

create function public.countersign_chapter_handshake(
  p_handshake_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  item public.chapter_handshakes%rowtype;
  prior_event public.chapter_handshake_events%rowtype;
begin
  if caller is null or chapter is null
     or not private.member_has_chapter_role(chapter, array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_idempotency_key is null then raise exception 'idempotency key required' using errcode = '22023'; end if;
  select * into item from public.chapter_handshakes where id = p_handshake_id for update;
  if not found or item.chapter_id <> chapter then raise exception 'request unavailable' using errcode = '42501'; end if;
  select * into prior_event from public.chapter_handshake_events
  where idempotency_key = p_idempotency_key;
  if found then
    if prior_event.handshake_id <> item.id or prior_event.actor <> caller
       or prior_event.transition <> 'activated' then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return pg_catalog.to_jsonb(item);
  end if;
  if item.status <> 'accepted' or item.receiver_signed_by is null then
    raise exception 'receiving signature required' using errcode = '22023';
  end if;
  update public.chapter_handshakes
  set requester_signed_by = caller, requester_signed_at = pg_catalog.clock_timestamp(), status = 'active'
  where id = item.id returning * into item;
  insert into public.chapter_handshake_events
    (handshake_id, idempotency_key, actor, actor_chapter_id, transition, from_status, to_status)
  values (item.id, p_idempotency_key, caller, chapter, 'activated', 'accepted', 'active');
  perform private.notify_handshake_staff(item.receiving_chapter_id, 'Partnership request activated',
    'Both chapters countersigned. Only the approved data scope is now available.');
  return pg_catalog.to_jsonb(item);
end;
$function$;

create function public.close_chapter_handshake(
  p_handshake_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  item public.chapter_handshakes%rowtype;
  previous_status text;
  prior_event public.chapter_handshake_events%rowtype;
begin
  if p_idempotency_key is null then raise exception 'idempotency key required' using errcode = '22023'; end if;
  select * into item from public.chapter_handshakes where id = p_handshake_id for update;
  if caller is null or not found
     or (chapter is distinct from item.chapter_id and chapter is distinct from item.receiving_chapter_id)
     or not private.member_has_chapter_role(chapter, array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'request unavailable' using errcode = '42501';
  end if;
  select * into prior_event from public.chapter_handshake_events
  where idempotency_key = p_idempotency_key;
  if found then
    if prior_event.handshake_id <> item.id or prior_event.actor <> caller
       or prior_event.transition <> 'closed' then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return pg_catalog.to_jsonb(item);
  end if;
  if item.status not in ('requested','accepted','active') then
    raise exception 'request cannot be closed' using errcode = '22023';
  end if;
  previous_status := item.status;
  update public.chapter_handshakes set status = 'closed' where id = item.id returning * into item;
  insert into public.chapter_handshake_events
    (handshake_id, idempotency_key, actor, actor_chapter_id, transition, from_status, to_status)
  values (item.id, p_idempotency_key, caller, chapter, 'closed', previous_status, 'closed');
  perform private.notify_handshake_staff(
    case when chapter = item.chapter_id then item.receiving_chapter_id else item.chapter_id end,
    'Partnership request closed', 'The other participating chapter closed this request.');
  return pg_catalog.to_jsonb(item);
end;
$function$;

create function public.share_chapter_handshake_document(
  p_handshake_id uuid,
  p_document_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  item public.chapter_handshakes%rowtype;
  prior_event public.chapter_handshake_events%rowtype;
begin
  if p_idempotency_key is null then raise exception 'idempotency key required' using errcode = '22023'; end if;
  select * into item from public.chapter_handshakes where id = p_handshake_id for update;
  if caller is null or not found or item.status <> 'active' or item.data_scope <> 'docs_only'
     or (chapter is distinct from item.chapter_id and chapter is distinct from item.receiving_chapter_id)
     or not private.member_has_chapter_role(chapter, array['steward','coordinator','advisor','admin','vp'])
     or not exists (
       select 1 from public.chapter_documents d
       where d.id = p_document_id and d.chapter_id = chapter and d.status = 'published'
     ) then
    raise exception 'document exchange unavailable' using errcode = '42501';
  end if;
  select * into prior_event from public.chapter_handshake_events
  where idempotency_key = p_idempotency_key;
  if found then
    if prior_event.handshake_id <> item.id or prior_event.actor <> caller
       or prior_event.transition <> 'document_shared'
       or prior_event.detail ->> 'documentId' is distinct from p_document_id::text then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('shared', true, 'handshakeId', item.id, 'documentId', p_document_id);
  end if;
  insert into public.chapter_handshake_documents (handshake_id, document_id, shared_by)
  values (item.id, p_document_id, caller) on conflict do nothing;
  insert into public.chapter_handshake_events
    (handshake_id, idempotency_key, actor, actor_chapter_id, transition, from_status, to_status,
     detail)
  values (item.id, p_idempotency_key, caller, chapter, 'document_shared', 'active', 'active',
    pg_catalog.jsonb_build_object('documentId', p_document_id));
  return pg_catalog.jsonb_build_object('shared', true, 'handshakeId', item.id, 'documentId', p_document_id);
end;
$function$;

-- ---------------------------------------------------------- chapter health

create table public.chapter_health_snapshots (
  id uuid primary key default extensions.gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  measured_on date not null,
  member_count integer not null check (member_count >= 0),
  participation integer not null check (participation between 0 and 100),
  case_timeliness integer not null check (case_timeliness between 0 and 100),
  steward_capacity integer not null check (steward_capacity between 0 and 100),
  training_coverage integer not null check (training_coverage between 0 and 100),
  communication_reach integer not null check (communication_reach between 0 and 100),
  governance_readiness integer not null check (governance_readiness between 0 and 100),
  score integer not null check (score between 0 and 100),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  unique (chapter_id, measured_on)
);

create table public.chapter_health_coaching (
  id uuid primary key default extensions.gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  author_id uuid references auth.users(id) on delete set null,
  summary text not null check (pg_catalog.char_length(pg_catalog.btrim(summary)) between 8 and 1000),
  next_action text not null default '' check (pg_catalog.char_length(next_action) <= 500),
  attention_level text not null check (attention_level in ('watch','support','urgent','resolved')),
  created_at timestamptz not null default pg_catalog.now()
);

create index chapter_health_snapshots_chapter_date_idx
  on public.chapter_health_snapshots (chapter_id, measured_on desc);
create index chapter_health_coaching_chapter_created_idx
  on public.chapter_health_coaching (chapter_id, created_at desc);

alter table public.chapter_health_snapshots enable row level security;
alter table public.chapter_health_coaching enable row level security;
create policy chapter_health_snapshots_leadership_read
  on public.chapter_health_snapshots for select to authenticated
  using (private.member_has_chapter_role(chapter_id, array['advisor','admin','vp']));
create policy chapter_health_coaching_leadership_read
  on public.chapter_health_coaching for select to authenticated
  using (private.member_has_chapter_role(chapter_id, array['advisor','admin','vp']));
create policy mfa_assurance on public.chapter_health_snapshots
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.chapter_health_coaching
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
revoke all on public.chapter_health_snapshots from public, anon, authenticated;
revoke all on public.chapter_health_coaching from public, anon, authenticated;
grant select on public.chapter_health_snapshots to authenticated;
grant select on public.chapter_health_coaching to authenticated;

create function public.record_chapter_health_snapshot(
  p_chapter_id text,
  p_measured_on date,
  p_participation integer,
  p_case_timeliness integer,
  p_steward_capacity integer,
  p_training_coverage integer,
  p_communication_reach integer,
  p_governance_readiness integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  members integer;
  calculated integer;
  saved public.chapter_health_snapshots%rowtype;
begin
  if caller is null or not private.member_has_chapter_role(p_chapter_id, array['advisor','admin','vp']) then
    raise exception 'leadership role required' using errcode = '42501';
  end if;
  if p_measured_on is null or p_measured_on > current_date
     or p_participation not between 0 and 100 or p_case_timeliness not between 0 and 100
     or p_steward_capacity not between 0 and 100 or p_training_coverage not between 0 and 100
     or p_communication_reach not between 0 and 100 or p_governance_readiness not between 0 and 100 then
    raise exception 'invalid health drivers' using errcode = '22023';
  end if;
  select pg_catalog.count(*)::integer into members
  from public.member_chapter_memberships m
  where m.chapter_id = p_chapter_id and m.status = 'active';
  calculated := pg_catalog.round((p_participation + p_case_timeliness + p_steward_capacity
    + p_training_coverage + p_communication_reach + p_governance_readiness)::numeric / 6)::integer;
  insert into public.chapter_health_snapshots
    (chapter_id, measured_on, member_count, participation, case_timeliness,
     steward_capacity, training_coverage, communication_reach, governance_readiness,
     score, created_by)
  values (p_chapter_id, p_measured_on, members, p_participation, p_case_timeliness,
    p_steward_capacity, p_training_coverage, p_communication_reach, p_governance_readiness,
    calculated, caller)
  on conflict (chapter_id, measured_on) do update
    set member_count = excluded.member_count, participation = excluded.participation,
        case_timeliness = excluded.case_timeliness, steward_capacity = excluded.steward_capacity,
        training_coverage = excluded.training_coverage, communication_reach = excluded.communication_reach,
        governance_readiness = excluded.governance_readiness, score = excluded.score,
        created_by = caller, created_at = pg_catalog.clock_timestamp()
  returning * into saved;
  return pg_catalog.to_jsonb(saved);
end;
$function$;

create function public.add_chapter_health_coaching(
  p_chapter_id text,
  p_summary text,
  p_next_action text,
  p_attention_level text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare caller uuid := (select auth.uid()); saved public.chapter_health_coaching%rowtype;
begin
  if caller is null or not private.member_has_chapter_role(p_chapter_id, array['advisor','admin','vp']) then
    raise exception 'leadership role required' using errcode = '42501';
  end if;
  if p_attention_level not in ('watch','support','urgent','resolved') then
    raise exception 'invalid attention level' using errcode = '22023';
  end if;
  insert into public.chapter_health_coaching
    (chapter_id, author_id, summary, next_action, attention_level)
  values (p_chapter_id, caller, pg_catalog.btrim(p_summary),
    pg_catalog.btrim(coalesce(p_next_action,'')), p_attention_level)
  returning * into saved;
  return pg_catalog.to_jsonb(saved);
end;
$function$;

create function public.get_chapter_health_portfolio()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'chapterId', c.id,
    'chapterName', c.name,
    'measuredOn', latest.measured_on,
    'cohortProtected', coalesce(latest.member_count, 0) < 10,
    'memberCount', case when coalesce(latest.member_count, 0) >= 10 then latest.member_count else null end,
    'score', case when coalesce(latest.member_count, 0) >= 10 then latest.score else null end,
    'drivers', case when coalesce(latest.member_count, 0) >= 10 then pg_catalog.jsonb_build_object(
      'participation', latest.participation,
      'caseTimeliness', latest.case_timeliness,
      'stewardCapacity', latest.steward_capacity,
      'trainingCoverage', latest.training_coverage,
      'communicationReach', latest.communication_reach,
      'governanceReadiness', latest.governance_readiness
    ) else null end,
    'trend', case when coalesce(latest.member_count, 0) >= 10 then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'measuredOn', trend.measured_on, 'score', trend.score
      ) order by trend.measured_on)
      from (
        select s.measured_on, s.score from public.chapter_health_snapshots s
        where s.chapter_id = c.id and s.member_count >= 10
        order by s.measured_on desc limit 12
      ) trend
    ), '[]'::jsonb) else '[]'::jsonb end,
    'coaching', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', coaching.id, 'summary', coaching.summary, 'nextAction', coaching.next_action,
        'attentionLevel', coaching.attention_level, 'createdAt', coaching.created_at
      ) order by coaching.created_at desc)
      from (select * from public.chapter_health_coaching h where h.chapter_id = c.id order by h.created_at desc limit 20) coaching
    ), '[]'::jsonb)
  ) order by latest.score nulls last, c.name), '[]'::jsonb)
  from public.chapters c
  left join lateral (
    select * from public.chapter_health_snapshots s
    where s.chapter_id = c.id order by s.measured_on desc limit 1
  ) latest on true
  where private.member_has_chapter_role(c.id, array['advisor','admin','vp']);
$function$;

-- ----------------------------------------------------- appointment history

create function public.get_appointment_history(
  p_appointment_id uuid,
  p_before timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  appointment public.member_appointments%rowtype;
  history_items jsonb;
  history_count integer;
  next_before timestamptz;
  next_before_id uuid;
begin
  if caller is null or not private.mfa_satisfied()
     or p_appointment_id is null or p_limit not between 1 and 50
     or ((p_before is null) <> (p_before_id is null)) then
    raise exception 'history unavailable' using errcode = '22023';
  end if;
  select * into appointment from public.member_appointments where id = p_appointment_id;
  if not found or not (
    caller in (appointment.user_id, appointment.steward_id)
    or (appointment.chapter_id = private.current_member_chapter()
        and private.member_has_chapter_role(appointment.chapter_id, array['steward','coordinator','advisor','admin']))
  ) then
    raise exception 'history unavailable' using errcode = '42501';
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', e.id, 'action', e.action, 'createdAt', e.created_at,
      'actorKind', case when e.actor is null then 'system'
                        when e.actor = appointment.user_id then 'member'
                        when e.actor = appointment.steward_id then 'steward'
                        else 'chapter-staff' end,
      'detail', e.detail - 'calendarReason' - 'busyReason'
    ) order by e.created_at desc, e.id desc), '[]'::jsonb),
    pg_catalog.count(*)::integer,
    pg_catalog.min(e.created_at),
    (pg_catalog.array_agg(e.id order by e.created_at asc, e.id asc))[1]
  into history_items, history_count, next_before, next_before_id
  from (
    select * from public.member_appointment_events history
    where history.appointment_id = appointment.id
      and (p_before is null or (history.created_at, history.id) < (p_before, p_before_id))
    order by history.created_at desc, history.id desc limit p_limit
  ) e;

  return pg_catalog.jsonb_build_object(
    'appointment', pg_catalog.jsonb_build_object(
      'id', appointment.id, 'startsAt', appointment.starts_at, 'endsAt', appointment.ends_at,
      'status', appointment.status, 'appointmentType', appointment.appointment_type,
      'reasonCategory', appointment.reason_category
    ),
    'items', history_items,
    'nextBefore', case when history_count = p_limit then next_before else null end,
    'nextBeforeID', case when history_count = p_limit then next_before_id else null end
  );
end;
$function$;

-- ----------------------------------------- optional activation + SMS consent

create table public.chapter_connection_readiness (
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  capability text not null check (capability in ('sms','calendar_google','calendar_microsoft','cba','notion','enterprise')),
  status text not null default 'unset' check (status in ('unset','configuring','active','error','disabled')),
  provider_label text not null default '' check (pg_catalog.char_length(provider_label) <= 100),
  public_message text not null default '' check (pg_catalog.char_length(public_message) <= 500),
  requested_by uuid references auth.users(id) on delete set null,
  verified_at timestamptz,
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (chapter_id, capability),
  constraint chapter_connection_readiness_verified check (
    (status = 'active' and verified_at is not null) or status <> 'active'
  )
);

create table private.member_sms_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  consented boolean not null default false,
  consented_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz not null default pg_catalog.now(),
  constraint member_sms_preferences_consent_complete check (
    (consented and consented_at is not null and revoked_at is null)
    or (not consented and consented_at is null)
  )
);

alter table public.chapter_connection_readiness enable row level security;
create policy chapter_connection_readiness_read_current
  on public.chapter_connection_readiness for select to authenticated
  using (chapter_id = private.current_member_chapter());
create policy mfa_assurance on public.chapter_connection_readiness
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
revoke all on public.chapter_connection_readiness from public, anon, authenticated;
grant select on public.chapter_connection_readiness to authenticated;
revoke all on private.member_sms_preferences from public, anon, authenticated, service_role;

create function public.request_chapter_connection_setup(
  p_capability text,
  p_provider_label text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare caller uuid := (select auth.uid()); chapter text := private.current_member_chapter(); saved public.chapter_connection_readiness%rowtype;
begin
  if caller is null or chapter is null or not private.member_has_chapter_role(chapter, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_capability not in ('sms','calendar_google','calendar_microsoft','cba','notion','enterprise') then
    raise exception 'unknown capability' using errcode = '22023';
  end if;
  insert into public.chapter_connection_readiness
    (chapter_id, capability, status, provider_label, public_message, requested_by)
  values (chapter, p_capability, 'configuring', pg_catalog.left(pg_catalog.btrim(coalesce(p_provider_label,'')),100),
    'Setup requested. An operator must verify the chapter-owned provider before activation.', caller)
  on conflict (chapter_id, capability) do update
    set status = 'configuring', provider_label = excluded.provider_label,
        public_message = excluded.public_message, requested_by = caller,
        verified_at = null, updated_at = pg_catalog.clock_timestamp()
  returning * into saved;
  return pg_catalog.to_jsonb(saved);
end;
$function$;

create function public.verify_chapter_connection_setup(
  p_chapter_id text,
  p_capability text,
  p_status text,
  p_public_message text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare saved public.chapter_connection_readiness%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_status not in ('active','error','disabled') then
    raise exception 'invalid verification status' using errcode = '22023';
  end if;
  update public.chapter_connection_readiness
  set status = p_status, public_message = pg_catalog.left(coalesce(p_public_message,''),500),
      verified_at = case when p_status = 'active' then pg_catalog.clock_timestamp() else null end,
      updated_at = pg_catalog.clock_timestamp()
  where chapter_id = p_chapter_id and capability = p_capability and status in ('configuring','active','error','disabled')
  returning * into saved;
  if not found then raise exception 'setup request unavailable' using errcode = '22023'; end if;
  return pg_catalog.to_jsonb(saved);
end;
$function$;

create function public.get_my_sms_preference()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'activationStatus', coalesce((
      select c.status from public.chapter_connection_readiness c
      where c.chapter_id = private.current_member_chapter() and c.capability = 'sms'
    ), 'unset'),
    'publicMessage', coalesce((
      select c.public_message from public.chapter_connection_readiness c
      where c.chapter_id = private.current_member_chapter() and c.capability = 'sms'
    ), 'SMS is not configured for this chapter.'),
    'consented', coalesce(p.consented, false),
    'phoneLast4', case when p.phone_e164 is null then null else pg_catalog.right(p.phone_e164, 4) end,
    'updatedAt', p.updated_at
  )
  from (select 1 where private.mfa_satisfied()) one
  left join private.member_sms_preferences p on p.user_id = (select auth.uid());
$function$;

create function public.set_my_sms_consent(
  p_phone_e164 text,
  p_consented boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare caller uuid := (select auth.uid()); chapter text := private.current_member_chapter();
begin
  if caller is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  if coalesce(p_consented, false) and not exists (
    select 1 from public.chapter_connection_readiness c
    where c.chapter_id = chapter and c.capability = 'sms' and c.status = 'active'
  ) then
    raise exception 'sms is not active for this chapter' using errcode = '22023';
  end if;
  if coalesce(p_consented, false)
     and (p_phone_e164 is null or p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$') then
    raise exception 'valid E.164 phone required' using errcode = '22023';
  end if;
  if not coalesce(p_consented, false) and p_phone_e164 is null
     and not exists (select 1 from private.member_sms_preferences p where p.user_id = caller) then
    return public.get_my_sms_preference();
  end if;
  insert into private.member_sms_preferences
    (user_id, phone_e164, consented, consented_at, revoked_at)
  values (caller, coalesce(p_phone_e164, (
      select existing.phone_e164 from private.member_sms_preferences existing where existing.user_id = caller
    )), coalesce(p_consented,false),
    case when p_consented then pg_catalog.clock_timestamp() else null end,
    case when p_consented then null else pg_catalog.clock_timestamp() end)
  on conflict (user_id) do update
    set phone_e164 = excluded.phone_e164, consented = excluded.consented,
        consented_at = excluded.consented_at, revoked_at = excluded.revoked_at,
        updated_at = pg_catalog.clock_timestamp();
  return public.get_my_sms_preference();
end;
$function$;

-- -------------------------------------------------------------- permissions

do $block$
declare signature text;
begin
  foreach signature in array array[
    'request_chapter_union_org_binding(text)',
    'request_chapter_handshake(text,text,text,text,uuid)',
    'respond_chapter_handshake(uuid,text,uuid)',
    'countersign_chapter_handshake(uuid,uuid)',
    'close_chapter_handshake(uuid,uuid)',
    'share_chapter_handshake_document(uuid,uuid,uuid)',
    'record_chapter_health_snapshot(text,date,integer,integer,integer,integer,integer,integer)',
    'add_chapter_health_coaching(text,text,text,text)',
    'get_chapter_health_portfolio()',
    'get_appointment_history(uuid,timestamptz,uuid,integer)',
    'request_chapter_connection_setup(text,text)',
    'get_my_sms_preference()',
    'set_my_sms_consent(text,boolean)'
  ] loop
    execute 'revoke all on function public.' || signature || ' from public, anon';
    execute 'grant execute on function public.' || signature || ' to authenticated';
  end loop;
end
$block$;

revoke all on function public.verify_chapter_union_org_binding(text,text,boolean,text)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_chapter_union_org_binding(text,text,boolean,text) to service_role;
revoke all on function public.verify_chapter_connection_setup(text,text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_chapter_connection_setup(text,text,text,text) to service_role;

comment on table public.chapter_health_snapshots is
  'Transparent six-driver chapter summaries. The reader suppresses scores and drivers below a ten-member cohort; these are descriptive, not predictive.';
comment on table private.member_sms_preferences is
  'Server-only E.164 and explicit consent. Clients receive only activation state and last four digits through a definer RPC.';

notify pgrst, 'reload schema';
