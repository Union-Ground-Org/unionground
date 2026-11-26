-- REQ-UG-UNION-LIFECYCLE-20260723
--
-- Canonical, consent-bound sources for the participation ladder. Browser
-- callers cannot invent a member, chapter, activity, verifier, source, or
-- timestamp. They can only act through bounded RPCs that resolve those facts
-- from typed records and write the completion, participation receipt, and audit
-- event atomically.
--
-- Reconciled with the current schema on 2026-10-14 (this file ran at
-- 20260724053131 against an earlier schema). No earlier object has these
-- names. Member-scope foreign keys that referenced member_profiles(id,
-- chapter_id) now reference member_chapter_memberships(user_id,
-- chapter_id), and "member belongs to the chapter" checks read an active
-- membership there, because member_profiles.chapter_id is only the member's
-- currently selected chapter in the multi-chapter model. Staff
-- authority still comes from private.lifecycle_scope_chapter.

-- Session-scoped, not SET LOCAL: the CLI applies each migration file outside an
-- explicit transaction, where SET LOCAL raises WARNING 25P01 and silently does
-- nothing. As written this guard never bounded a single lock wait.
set lock_timeout = '5s';

-- 1. Typed source records ----------------------------------------------------

create table public.member_learning_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on delete restrict,
  learning_kind text not null
    check (learning_kind in ('orientation', 'training', 'meeting', 'leadership_training')),
  title text not null check (pg_catalog.char_length(title) between 3 and 180),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'open'
    check (status in ('open', 'closed', 'cancelled')),
  created_by uuid not null references auth.users(id) on delete restrict,
  request_id uuid not null,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  check (ends_at > starts_at),
  unique (created_by, request_id),
  unique (id, chapter_id, learning_kind),
  constraint member_learning_sessions_creator_scope_fkey
    foreign key (created_by, chapter_id)
    references public.member_chapter_memberships(user_id, chapter_id)
    on delete restrict
);

create table public.member_learning_assignments (
  id uuid primary key default extensions.gen_random_uuid(),
  session_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on delete restrict,
  learning_kind text not null,
  activity_kind text generated always as (
    case learning_kind
      when 'orientation' then 'orientation_complete'
      when 'training' then 'training_complete'
      when 'meeting' then 'meeting_verified'
      when 'leadership_training' then 'leadership_training_complete'
    end
  ) stored,
  rung text generated always as (
    case learning_kind
      when 'meeting' then 'attend'
      when 'leadership_training' then 'lead'
      else 'learn'
    end
  ) stored,
  status text not null default 'offered'
    check (status in ('offered', 'accepted', 'declined', 'completed')),
  assigned_by uuid not null references auth.users(id) on delete restrict,
  request_id uuid not null,
  response_request_id uuid,
  responded_at timestamptz,
  completion_request_id uuid,
  completed_at timestamptz,
  verified_by uuid references auth.users(id) on delete restrict,
  verified_at timestamptz,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  unique (assigned_by, request_id),
  unique (session_id, user_id),
  unique (id, user_id, chapter_id, activity_kind, rung),
  constraint member_learning_assignments_session_scope_fkey
    foreign key (session_id, chapter_id, learning_kind)
    references public.member_learning_sessions(id, chapter_id, learning_kind)
    on delete restrict,
  constraint member_learning_assignments_member_scope_fkey
    foreign key (user_id, chapter_id)
    references public.member_chapter_memberships(user_id, chapter_id)
    on delete cascade,
  constraint member_learning_assignments_assigner_scope_fkey
    foreign key (assigned_by, chapter_id)
    references public.member_chapter_memberships(user_id, chapter_id)
    on delete restrict,
  constraint member_learning_assignments_verifier_scope_fkey
    foreign key (verified_by, chapter_id)
    references public.member_chapter_memberships(user_id, chapter_id)
    on delete restrict,
  check (verified_by is null or verified_by <> user_id),
  check (
    (status = 'offered'
      and responded_at is null
      and completed_at is null
      and verified_by is null
      and verified_at is null)
    or (status in ('accepted', 'declined')
      and responded_at is not null
      and completed_at is null
      and verified_by is null
      and verified_at is null)
    or (status = 'completed'
      and responded_at is not null
      and completed_at is not null
      and verified_by is not null
      and verified_at is not null)
  ),
  check (verified_at is null or verified_at >= responded_at)
);

create unique index member_learning_assignments_response_request_idx
  on public.member_learning_assignments(user_id, response_request_id)
  where response_request_id is not null;
create unique index member_learning_assignments_completion_request_idx
  on public.member_learning_assignments(verified_by, completion_request_id)
  where completion_request_id is not null;

create table public.member_capacity_commitments (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on delete restrict,
  commitment_kind text not null
    check (commitment_kind in ('peer_outreach', 'committee', 'voluntary')),
  activity_kind text generated always as (
    case commitment_kind
      when 'peer_outreach' then 'peer_outreach_complete'
      when 'committee' then 'committee_commitment_complete'
      when 'voluntary' then 'commitment_complete'
    end
  ) stored,
  rung text generated always as (
    case commitment_kind
      when 'voluntary' then 'volunteer'
      else 'organize'
    end
  ) stored,
  title text not null check (pg_catalog.char_length(title) between 3 and 180),
  status text not null default 'offered'
    check (status in ('offered', 'accepted', 'declined', 'in_progress', 'completed')),
  offered_by uuid not null references auth.users(id) on delete restrict,
  request_id uuid not null,
  response_request_id uuid,
  responded_at timestamptz,
  started_at timestamptz,
  completion_request_id uuid,
  completed_at timestamptz,
  verified_by uuid references auth.users(id) on delete restrict,
  verified_at timestamptz,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  unique (offered_by, request_id),
  unique (id, user_id, chapter_id, activity_kind, rung),
  constraint member_capacity_commitments_member_scope_fkey
    foreign key (user_id, chapter_id)
    references public.member_chapter_memberships(user_id, chapter_id)
    on delete cascade,
  constraint member_capacity_commitments_offeror_scope_fkey
    foreign key (offered_by, chapter_id)
    references public.member_chapter_memberships(user_id, chapter_id)
    on delete restrict,
  constraint member_capacity_commitments_verifier_scope_fkey
    foreign key (verified_by, chapter_id)
    references public.member_chapter_memberships(user_id, chapter_id)
    on delete restrict,
  check (verified_by is null or verified_by <> user_id),
  check (
    (status = 'offered'
      and responded_at is null
      and started_at is null
      and completed_at is null
      and verified_by is null
      and verified_at is null)
    or (status = 'accepted'
      and responded_at is not null
      and started_at is null
      and completed_at is null
      and verified_by is null
      and verified_at is null)
    or (status = 'declined'
      and responded_at is not null
      and started_at is null
      and completed_at is null
      and verified_by is null
      and verified_at is null)
    or (status = 'in_progress'
      and responded_at is not null
      and started_at is not null
      and completed_at is null
      and verified_by is null
      and verified_at is null)
    or (status = 'completed'
      and responded_at is not null
      and completed_at is not null
      and verified_by is not null
      and verified_at is not null)
  ),
  check (started_at is null or started_at >= responded_at),
  check (verified_at is null or verified_at >= responded_at),
  check (verified_at is null or started_at is null or verified_at >= started_at)
);

create unique index member_capacity_commitments_response_request_idx
  on public.member_capacity_commitments(user_id, response_request_id)
  where response_request_id is not null;
create unique index member_capacity_commitments_completion_request_idx
  on public.member_capacity_commitments(verified_by, completion_request_id)
  where completion_request_id is not null;

create table public.member_participation_completions (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on delete restrict,
  activity_kind text not null
    check (activity_kind in (
      'training_complete',
      'orientation_complete',
      'meeting_verified',
      'peer_outreach_complete',
      'committee_commitment_complete',
      'commitment_complete',
      'leadership_training_complete'
    )),
  rung text not null check (rung in ('learn', 'attend', 'volunteer', 'organize', 'lead')),
  learning_assignment_id uuid,
  capacity_commitment_id uuid,
  occurred_at timestamptz not null,
  verified_by uuid not null references auth.users(id) on delete restrict,
  verified_at timestamptz not null,
  verification_request_id uuid not null,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  unique (verified_by, verification_request_id),
  unique (id, user_id, chapter_id, activity_kind, rung, verified_by, verified_at),
  check (pg_catalog.num_nonnulls(learning_assignment_id, capacity_commitment_id) = 1),
  check (verified_by <> user_id),
  check (occurred_at = verified_at),
  constraint member_participation_completions_member_scope_fkey
    foreign key (user_id, chapter_id)
    references public.member_chapter_memberships(user_id, chapter_id)
    on delete cascade,
  constraint member_participation_completions_verifier_scope_fkey
    foreign key (verified_by, chapter_id)
    references public.member_chapter_memberships(user_id, chapter_id)
    on delete restrict,
  constraint member_participation_completions_learning_source_fkey
    foreign key (learning_assignment_id, user_id, chapter_id, activity_kind, rung)
    references public.member_learning_assignments(id, user_id, chapter_id, activity_kind, rung)
    on delete restrict,
  constraint member_participation_completions_commitment_source_fkey
    foreign key (capacity_commitment_id, user_id, chapter_id, activity_kind, rung)
    references public.member_capacity_commitments(id, user_id, chapter_id, activity_kind, rung)
    on delete restrict
);

create unique index member_participation_completions_learning_source_idx
  on public.member_participation_completions(learning_assignment_id)
  where learning_assignment_id is not null;
create unique index member_participation_completions_commitment_source_idx
  on public.member_participation_completions(capacity_commitment_id)
  where capacity_commitment_id is not null;

-- Candidate lifecycle tables are unshipped. Refuse to attach a made-up source
-- to any unexpected pre-existing receipt.
do $$
begin
  if exists (select 1 from public.member_participation_events limit 1) then
    raise exception
      'canonical participation migration requires an explicit backfill for existing receipts'
      using errcode = '23514';
  end if;
end
$$;

alter table public.member_participation_events
  add column canonical_completion_id uuid,
  add column verified_at timestamptz not null default pg_catalog.statement_timestamp();

alter table public.member_participation_events
  alter column canonical_completion_id set not null,
  add constraint member_participation_events_completion_unique
    unique (canonical_completion_id),
  add constraint member_participation_events_recognition_identity_unique
    unique (
      id,
      user_id,
      chapter_id,
      activity_kind,
      source_kind,
      source_id,
      canonical_completion_id
    ),
  add constraint member_participation_events_canonical_source_check
    check (
      source_kind in ('learning_assignment', 'capacity_commitment')
      and source_id = canonical_completion_id::text
    ),
  add constraint member_participation_events_canonical_completion_fkey
    foreign key (
      canonical_completion_id,
      user_id,
      chapter_id,
      activity_kind,
      rung,
      verified_by,
      verified_at
    )
    references public.member_participation_completions (
      id,
      user_id,
      chapter_id,
      activity_kind,
      rung,
      verified_by,
      verified_at
    )
    on delete restrict;

create function private.prevent_canonical_participation_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'verified participation is immutable' using errcode = '42501';
end;
$$;

create trigger member_participation_completions_no_update
  before update on public.member_participation_completions
  for each row execute function private.prevent_canonical_participation_update();
create trigger member_participation_events_no_update
  before update on public.member_participation_events
  for each row execute function private.prevent_canonical_participation_update();

-- 2. Default-deny source ACLs and assurance coverage ------------------------

alter table public.member_learning_sessions enable row level security;
alter table public.member_learning_assignments enable row level security;
alter table public.member_capacity_commitments enable row level security;
alter table public.member_participation_completions enable row level security;

do $$
declare
  target regclass;
begin
  foreach target in array array[
    'public.member_learning_sessions'::regclass,
    'public.member_learning_assignments'::regclass,
    'public.member_capacity_commitments'::regclass,
    'public.member_participation_completions'::regclass
  ]
  loop
    execute pg_catalog.format(
      'create policy mfa_assurance on %s as restrictive for all to authenticated '
      || 'using ((select private.mfa_satisfied())) '
      || 'with check ((select private.mfa_satisfied()))',
      target
    );
  end loop;
end
$$;

revoke all on table
  public.member_learning_sessions,
  public.member_learning_assignments,
  public.member_capacity_commitments,
  public.member_participation_completions
from public, anon, authenticated;

-- 3. Learning workflow -------------------------------------------------------

create function public.create_learning_session(
  p_learning_kind text,
  p_title text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  scope_chapter text;
  clean_title text := pg_catalog.btrim(coalesce(p_title, ''));
  session_id uuid;
  existing public.member_learning_sessions%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  scope_chapter := private.lifecycle_scope_chapter(
    array['steward', 'organizer', 'coordinator', 'admin']
  );
  if scope_chapter is null then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'request id required' using errcode = '22023';
  end if;
  if p_learning_kind is null
     or p_learning_kind not in ('orientation', 'training', 'meeting', 'leadership_training') then
    raise exception 'unknown learning kind' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_title) not between 3 and 180
     or p_starts_at is null
     or p_ends_at is null
     or p_ends_at <= p_starts_at then
    raise exception 'invalid learning session' using errcode = '22023';
  end if;

  insert into public.member_learning_sessions (
    chapter_id,
    learning_kind,
    title,
    starts_at,
    ends_at,
    created_by,
    request_id
  ) values (
    scope_chapter,
    p_learning_kind,
    clean_title,
    p_starts_at,
    p_ends_at,
    caller,
    p_request_id
  )
  on conflict (created_by, request_id) do nothing
  returning id into session_id;

  if session_id is null then
    select s.* into existing
    from public.member_learning_sessions s
    where s.created_by = caller and s.request_id = p_request_id;
    if existing.id is null then
      raise exception 'learning session outcome not visible; retry transaction'
        using errcode = '40001';
    end if;
    if existing.chapter_id <> scope_chapter
       or existing.learning_kind <> p_learning_kind
       or existing.title <> clean_title
       or existing.starts_at <> p_starts_at
       or existing.ends_at <> p_ends_at then
      raise exception 'request id already used for different learning session'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'sessionId', existing.id,
      'status', existing.status
    );
  end if;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    to_state,
    safe_metadata
  ) values (
    scope_chapter,
    caller,
    'learning.session_created',
    'member_learning_session',
    session_id,
    'open',
    pg_catalog.jsonb_build_object('learningKind', p_learning_kind)
  );

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'sessionId', session_id,
    'status', 'open'
  );
end;
end;
$$;

create function public.assign_learning_session(
  p_session_id uuid,
  p_user_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  scope_chapter text;
  learning_session public.member_learning_sessions%rowtype;
  assignment_id uuid;
  existing public.member_learning_assignments%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  scope_chapter := private.lifecycle_scope_chapter(
    array['steward', 'organizer', 'coordinator', 'admin']
  );
  if scope_chapter is null then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_session_id is null or p_user_id is null or p_request_id is null then
    raise exception 'session, member, and request id required' using errcode = '22023';
  end if;

  select s.* into learning_session
  from public.member_learning_sessions s
  where s.id = p_session_id
    and s.chapter_id = scope_chapter
  for key share;
  if learning_session.id is null or learning_session.status <> 'open' then
    raise exception 'learning session not available' using errcode = '22023';
  end if;
  -- Chapter belonging is Union Ground's active chapter membership, not the
  -- member's currently selected chapter on member_profiles.
  if not exists (
    select 1 from public.member_chapter_memberships m
    where m.user_id = p_user_id
      and m.chapter_id = scope_chapter
      and m.status = 'active'
  ) then
    raise exception 'member not found' using errcode = '22023';
  end if;

  insert into public.member_learning_assignments (
    session_id,
    user_id,
    chapter_id,
    learning_kind,
    assigned_by,
    request_id
  ) values (
    learning_session.id,
    p_user_id,
    scope_chapter,
    learning_session.learning_kind,
    caller,
    p_request_id
  )
  on conflict do nothing
  returning id into assignment_id;

  if assignment_id is null then
    -- Resolve the idempotency key first. A natural-key collision from a
    -- different request must not be reported as success without consuming the
    -- new request key; otherwise that key can later produce a second outcome.
    select a.* into existing
    from public.member_learning_assignments a
    where a.assigned_by = caller and a.request_id = p_request_id;
    if existing.id is not null then
      if existing.session_id <> learning_session.id
         or existing.user_id <> p_user_id
         or existing.chapter_id <> scope_chapter then
        raise exception 'request id already used for different learning assignment'
          using errcode = '22023';
      end if;
      return pg_catalog.jsonb_build_object(
        'changed', false,
        'assignmentId', existing.id,
        'status', existing.status,
        'revision', existing.revision
      );
    end if;

    if exists (
      select 1
      from public.member_learning_assignments a
      where a.session_id = learning_session.id and a.user_id = p_user_id
    ) then
      raise exception 'learning assignment already exists'
        using errcode = '22023';
    end if;

    raise exception 'learning assignment outcome not visible; retry transaction'
      using errcode = '40001';
  end if;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    to_state,
    safe_metadata
  ) values (
    scope_chapter,
    caller,
    'learning.assignment_offered',
    'member_learning_assignment',
    assignment_id,
    'offered',
    pg_catalog.jsonb_build_object('learningKind', learning_session.learning_kind)
  );

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'assignmentId', assignment_id,
    'status', 'offered',
    'revision', 1
  );
end;
end;
$$;

create function public.respond_learning_assignment(
  p_assignment_id uuid,
  p_accept boolean,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  assignment public.member_learning_assignments%rowtype;
  next_status text := case when p_accept then 'accepted' else 'declined' end;
  changed boolean := false;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_assignment_id is null or p_accept is null or p_request_id is null then
    raise exception 'assignment, response, and request id required' using errcode = '22023';
  end if;

  select a.* into assignment
  from public.member_learning_assignments a
  where a.id = p_assignment_id and a.user_id = caller
  for update;
  if assignment.id is null then
    raise exception 'learning assignment not found' using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.member_learning_assignments a
    where a.user_id = caller
      and a.response_request_id = p_request_id
      and a.id <> assignment.id
  ) then
    raise exception 'request id already used for a different learning response'
      using errcode = '22023';
  end if;
  if assignment.status = next_status then
    if assignment.response_request_id is distinct from p_request_id then
      raise exception 'learning assignment already answered by a different request'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'assignmentId', assignment.id,
      'status', assignment.status,
      'revision', assignment.revision
    );
  end if;
  if assignment.status <> 'offered' then
    raise exception 'learning assignment can no longer be answered' using errcode = '22023';
  end if;

  update public.member_learning_assignments
  set status = next_status,
      response_request_id = p_request_id,
      responded_at = pg_catalog.statement_timestamp(),
      revision = revision + 1
  where id = assignment.id
  returning revision into assignment.revision;
  changed := true;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state
  ) values (
    assignment.chapter_id,
    caller,
    'learning.assignment_responded',
    'member_learning_assignment',
    assignment.id,
    'offered',
    next_status
  );

  return pg_catalog.jsonb_build_object(
    'changed', changed,
    'assignmentId', assignment.id,
    'status', next_status,
    'revision', assignment.revision
  );
end;
end;
$$;

create function public.verify_learning_completion(
  p_assignment_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  scope_chapter text;
  assignment public.member_learning_assignments%rowtype;
  session_status text;
  session_ends_at timestamptz;
  completion_id uuid;
  participation_id uuid;
  verified_time timestamptz;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'verification role required' using errcode = '42501';
  end if;
  scope_chapter := private.lifecycle_scope_chapter(
    array['steward', 'organizer', 'coordinator', 'admin']
  );
  if scope_chapter is null then
    raise exception 'verification role required' using errcode = '42501';
  end if;
  if p_assignment_id is null or p_request_id is null then
    raise exception 'assignment and request id required' using errcode = '22023';
  end if;

  select a.* into assignment
  from public.member_learning_assignments a
  where a.id = p_assignment_id and a.chapter_id = scope_chapter
  for update;
  if assignment.id is null then
    raise exception 'learning assignment not found' using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.member_learning_assignments a
    where a.verified_by = caller
      and a.completion_request_id = p_request_id
      and a.id <> assignment.id
  ) then
    raise exception 'request id already used for a different learning completion'
      using errcode = '22023';
  end if;
  if assignment.user_id = caller then
    raise exception 'self-verification is not allowed' using errcode = '22023';
  end if;
  if assignment.status = 'completed' then
    if assignment.completion_request_id is distinct from p_request_id then
      raise exception 'learning assignment already completed by a different request'
        using errcode = '22023';
    end if;
    select c.id into completion_id
    from public.member_participation_completions c
    where c.learning_assignment_id = assignment.id;
    if completion_id is null then
      raise exception 'completed learning assignment is missing its receipt'
        using errcode = '23514';
    end if;
    select e.id into participation_id
    from public.member_participation_events e
    where e.canonical_completion_id = completion_id;
    if participation_id is null then
      raise exception 'completed learning assignment is missing its participation record'
        using errcode = '23514';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'completionId', completion_id,
      'participationEventId', participation_id
    );
  end if;
  if assignment.status <> 'accepted' then
    raise exception 'accepted learning assignment required' using errcode = '22023';
  end if;
  select s.status, s.ends_at into session_status, session_ends_at
  from public.member_learning_sessions s
  where s.id = assignment.session_id
  for key share;
  -- Capture factual verification time only after all source locks are held.
  -- statement_timestamp() is fixed before a lock wait and can predate consent.
  verified_time := pg_catalog.clock_timestamp();
  if session_status is distinct from 'open'
     or session_ends_at is null
     or session_ends_at > verified_time then
    raise exception 'completed learning session required' using errcode = '22023';
  end if;

  update public.member_learning_assignments
  set status = 'completed',
      completion_request_id = p_request_id,
      completed_at = verified_time,
      verified_by = caller,
      verified_at = verified_time,
      revision = revision + 1
  where id = assignment.id;

  insert into public.member_participation_completions (
    user_id,
    chapter_id,
    activity_kind,
    rung,
    learning_assignment_id,
    occurred_at,
    verified_by,
    verified_at,
    verification_request_id
  ) values (
    assignment.user_id,
    assignment.chapter_id,
    assignment.activity_kind,
    assignment.rung,
    assignment.id,
    verified_time,
    caller,
    verified_time,
    p_request_id
  )
  returning id into completion_id;

  insert into public.member_participation_events (
    user_id,
    chapter_id,
    rung,
    activity_kind,
    source_kind,
    source_id,
    occurred_at,
    verified_by,
    canonical_completion_id,
    verified_at
  ) values (
    assignment.user_id,
    assignment.chapter_id,
    assignment.rung,
    assignment.activity_kind,
    'learning_assignment',
    completion_id::text,
    verified_time,
    caller,
    completion_id,
    verified_time
  )
  returning id into participation_id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    to_state,
    safe_metadata
  ) values (
    assignment.chapter_id,
    caller,
    'participation.verified',
    'member_participation_completion',
    completion_id,
    assignment.activity_kind,
    pg_catalog.jsonb_build_object(
      'participationEventId', participation_id,
      'sourceFamily', 'learning_assignment'
    )
  );

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'completionId', completion_id,
    'participationEventId', participation_id
  );
end;
end;
$$;

-- Safe member projection. Typed source tables remain unselectable through
-- PostgREST; this RPC returns only the caller's own offers and no staff IDs.
create function public.get_member_participation_sources()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  return pg_catalog.jsonb_build_object(
    'learningAssignments',
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', a.id,
          'title', s.title,
          'learningKind', a.learning_kind,
          'activityKind', a.activity_kind,
          'rung', a.rung,
          'status', a.status,
          'startsAt', s.starts_at,
          'endsAt', s.ends_at,
          'revision', a.revision
        )
        order by s.starts_at desc, a.id
      )
      from public.member_learning_assignments a
      join public.member_learning_sessions s on s.id = a.session_id
      where a.user_id = caller
    ), '[]'::jsonb),
    'capacityCommitments',
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', c.id,
          'title', c.title,
          'commitmentKind', c.commitment_kind,
          'activityKind', c.activity_kind,
          'rung', c.rung,
          'status', c.status,
          'revision', c.revision
        )
        order by c.created_at desc, c.id
      )
      from public.member_capacity_commitments c
      where c.user_id = caller
    ), '[]'::jsonb)
  );
end;
$$;

-- 4. Capacity commitment workflow ------------------------------------------

create function public.offer_capacity_commitment(
  p_user_id uuid,
  p_commitment_kind text,
  p_title text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  scope_chapter text;
  clean_title text := pg_catalog.btrim(coalesce(p_title, ''));
  commitment_id uuid;
  existing public.member_capacity_commitments%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  scope_chapter := private.lifecycle_scope_chapter(
    array['steward', 'organizer', 'coordinator', 'admin']
  );
  if scope_chapter is null then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_request_id is null then
    raise exception 'member and request id required' using errcode = '22023';
  end if;
  if p_commitment_kind is null
     or p_commitment_kind not in ('peer_outreach', 'committee', 'voluntary') then
    raise exception 'unknown commitment kind' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_title) not between 3 and 180 then
    raise exception 'invalid commitment title' using errcode = '22023';
  end if;
  -- Chapter belonging is Union Ground's active chapter membership, not the
  -- member's currently selected chapter on member_profiles.
  if not exists (
    select 1 from public.member_chapter_memberships m
    where m.user_id = p_user_id
      and m.chapter_id = scope_chapter
      and m.status = 'active'
  ) then
    raise exception 'member not found' using errcode = '22023';
  end if;

  insert into public.member_capacity_commitments (
    user_id,
    chapter_id,
    commitment_kind,
    title,
    offered_by,
    request_id
  ) values (
    p_user_id,
    scope_chapter,
    p_commitment_kind,
    clean_title,
    caller,
    p_request_id
  )
  on conflict (offered_by, request_id) do nothing
  returning id into commitment_id;

  if commitment_id is null then
    select c.* into existing
    from public.member_capacity_commitments c
    where c.offered_by = caller and c.request_id = p_request_id;
    if existing.id is null then
      raise exception 'commitment outcome not visible; retry transaction'
        using errcode = '40001';
    end if;
    if existing.user_id <> p_user_id
       or existing.chapter_id <> scope_chapter
       or existing.commitment_kind <> p_commitment_kind
       or existing.title <> clean_title then
      raise exception 'request id already used for different commitment'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'commitmentId', existing.id,
      'status', existing.status,
      'revision', existing.revision
    );
  end if;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    to_state,
    safe_metadata
  ) values (
    scope_chapter,
    caller,
    'capacity.commitment_offered',
    'member_capacity_commitment',
    commitment_id,
    'offered',
    pg_catalog.jsonb_build_object('commitmentKind', p_commitment_kind)
  );

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'commitmentId', commitment_id,
    'status', 'offered',
    'revision', 1
  );
end;
end;
$$;

create function public.respond_capacity_commitment(
  p_commitment_id uuid,
  p_accept boolean,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  commitment public.member_capacity_commitments%rowtype;
  next_status text := case when p_accept then 'accepted' else 'declined' end;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_commitment_id is null or p_accept is null or p_request_id is null then
    raise exception 'commitment, response, and request id required' using errcode = '22023';
  end if;

  select c.* into commitment
  from public.member_capacity_commitments c
  where c.id = p_commitment_id and c.user_id = caller
  for update;
  if commitment.id is null then
    raise exception 'commitment not found' using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.member_capacity_commitments c
    where c.user_id = caller
      and c.response_request_id = p_request_id
      and c.id <> commitment.id
  ) then
    raise exception 'request id already used for a different commitment response'
      using errcode = '22023';
  end if;
  if commitment.status = next_status then
    if commitment.response_request_id is distinct from p_request_id then
      raise exception 'commitment already answered by a different request'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'commitmentId', commitment.id,
      'status', commitment.status,
      'revision', commitment.revision
    );
  end if;
  if commitment.status <> 'offered' then
    raise exception 'commitment can no longer be answered' using errcode = '22023';
  end if;

  update public.member_capacity_commitments
  set status = next_status,
      response_request_id = p_request_id,
      responded_at = pg_catalog.statement_timestamp(),
      revision = revision + 1
  where id = commitment.id
  returning revision into commitment.revision;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state
  ) values (
    commitment.chapter_id,
    caller,
    'capacity.commitment_responded',
    'member_capacity_commitment',
    commitment.id,
    'offered',
    next_status
  );

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'commitmentId', commitment.id,
    'status', next_status,
    'revision', commitment.revision
  );
end;
end;
$$;

create function public.start_capacity_commitment(
  p_commitment_id uuid,
  p_expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  commitment public.member_capacity_commitments%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_commitment_id is null or p_expected_revision is null then
    raise exception 'commitment and expected revision required' using errcode = '22023';
  end if;

  select c.* into commitment
  from public.member_capacity_commitments c
  where c.id = p_commitment_id and c.user_id = caller
  for update;
  if commitment.id is null then
    raise exception 'commitment not found' using errcode = '22023';
  end if;
  if commitment.status = 'in_progress' then
    if p_expected_revision not in (commitment.revision, commitment.revision - 1) then
      raise exception 'commitment changed; reload and try again' using errcode = '40001';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'commitmentId', commitment.id,
      'status', commitment.status,
      'revision', commitment.revision
    );
  end if;
  if commitment.revision <> p_expected_revision then
    raise exception 'commitment changed; reload and try again' using errcode = '40001';
  end if;
  if commitment.status <> 'accepted' then
    raise exception 'accepted commitment required' using errcode = '22023';
  end if;

  update public.member_capacity_commitments
  set status = 'in_progress',
      -- Captured after the row lock. A statement timestamp taken before waiting
      -- can predate a concurrently committed responded_at value.
      started_at = pg_catalog.clock_timestamp(),
      revision = revision + 1
  where id = commitment.id
  returning revision into commitment.revision;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state
  ) values (
    commitment.chapter_id,
    caller,
    'capacity.commitment_started',
    'member_capacity_commitment',
    commitment.id,
    'accepted',
    'in_progress'
  );

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'commitmentId', commitment.id,
    'status', 'in_progress',
    'revision', commitment.revision
  );
end;
end;
$$;

create function public.verify_capacity_commitment(
  p_commitment_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  scope_chapter text;
  commitment public.member_capacity_commitments%rowtype;
  completion_id uuid;
  participation_id uuid;
  verified_time timestamptz;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'verification role required' using errcode = '42501';
  end if;
  scope_chapter := private.lifecycle_scope_chapter(
    array['steward', 'organizer', 'coordinator', 'admin']
  );
  if scope_chapter is null then
    raise exception 'verification role required' using errcode = '42501';
  end if;
  if p_commitment_id is null or p_request_id is null then
    raise exception 'commitment and request id required' using errcode = '22023';
  end if;

  select c.* into commitment
  from public.member_capacity_commitments c
  where c.id = p_commitment_id and c.chapter_id = scope_chapter
  for update;
  if commitment.id is null then
    raise exception 'commitment not found' using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.member_capacity_commitments c
    where c.verified_by = caller
      and c.completion_request_id = p_request_id
      and c.id <> commitment.id
  ) then
    raise exception 'request id already used for a different commitment completion'
      using errcode = '22023';
  end if;
  if commitment.user_id = caller then
    raise exception 'self-verification is not allowed' using errcode = '22023';
  end if;
  if commitment.status = 'completed' then
    if commitment.completion_request_id is distinct from p_request_id then
      raise exception 'commitment already completed by a different request'
        using errcode = '22023';
    end if;
    select c.id into completion_id
    from public.member_participation_completions c
    where c.capacity_commitment_id = commitment.id;
    if completion_id is null then
      raise exception 'completed commitment is missing its receipt'
        using errcode = '23514';
    end if;
    select e.id into participation_id
    from public.member_participation_events e
    where e.canonical_completion_id = completion_id;
    if participation_id is null then
      raise exception 'completed commitment is missing its participation record'
        using errcode = '23514';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'completionId', completion_id,
      'participationEventId', participation_id
    );
  end if;
  if commitment.status not in ('accepted', 'in_progress') then
    raise exception 'accepted commitment required' using errcode = '22023';
  end if;
  -- Capture factual verification time only after the source row is locked and
  -- consent state is known. This prevents a blocked verifier from predating
  -- the member response that released the lock.
  verified_time := pg_catalog.clock_timestamp();

  update public.member_capacity_commitments
  set status = 'completed',
      completion_request_id = p_request_id,
      completed_at = verified_time,
      verified_by = caller,
      verified_at = verified_time,
      revision = revision + 1
  where id = commitment.id;

  insert into public.member_participation_completions (
    user_id,
    chapter_id,
    activity_kind,
    rung,
    capacity_commitment_id,
    occurred_at,
    verified_by,
    verified_at,
    verification_request_id
  ) values (
    commitment.user_id,
    commitment.chapter_id,
    commitment.activity_kind,
    commitment.rung,
    commitment.id,
    verified_time,
    caller,
    verified_time,
    p_request_id
  )
  returning id into completion_id;

  insert into public.member_participation_events (
    user_id,
    chapter_id,
    rung,
    activity_kind,
    source_kind,
    source_id,
    occurred_at,
    verified_by,
    canonical_completion_id,
    verified_at
  ) values (
    commitment.user_id,
    commitment.chapter_id,
    commitment.rung,
    commitment.activity_kind,
    'capacity_commitment',
    completion_id::text,
    verified_time,
    caller,
    completion_id,
    verified_time
  )
  returning id into participation_id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    to_state,
    safe_metadata
  ) values (
    commitment.chapter_id,
    caller,
    'participation.verified',
    'member_participation_completion',
    completion_id,
    commitment.activity_kind,
    pg_catalog.jsonb_build_object(
      'participationEventId', participation_id,
      'sourceFamily', 'capacity_commitment'
    )
  );

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'completionId', completion_id,
    'participationEventId', participation_id
  );
end;
end;
$$;

-- 5. Function exposure -------------------------------------------------------

revoke all on function private.prevent_canonical_participation_update()
  from public, anon, authenticated;
revoke all on function public.create_learning_session(text, text, timestamptz, timestamptz, uuid)
  from public, anon, authenticated;
revoke all on function public.assign_learning_session(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.respond_learning_assignment(uuid, boolean, uuid)
  from public, anon, authenticated;
revoke all on function public.verify_learning_completion(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.offer_capacity_commitment(uuid, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.respond_capacity_commitment(uuid, boolean, uuid)
  from public, anon, authenticated;
revoke all on function public.start_capacity_commitment(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.verify_capacity_commitment(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.get_member_participation_sources()
  from public, anon, authenticated;

grant execute on function public.create_learning_session(text, text, timestamptz, timestamptz, uuid)
  to authenticated;
grant execute on function public.assign_learning_session(uuid, uuid, uuid)
  to authenticated;
grant execute on function public.respond_learning_assignment(uuid, boolean, uuid)
  to authenticated;
grant execute on function public.verify_learning_completion(uuid, uuid)
  to authenticated;
grant execute on function public.offer_capacity_commitment(uuid, text, text, uuid)
  to authenticated;
grant execute on function public.respond_capacity_commitment(uuid, boolean, uuid)
  to authenticated;
grant execute on function public.start_capacity_commitment(uuid, integer)
  to authenticated;
grant execute on function public.verify_capacity_commitment(uuid, uuid)
  to authenticated;
grant execute on function public.get_member_participation_sources()
  to authenticated;
