-- REQ-UG-UNION-LIFECYCLE-20260723
--
-- Retire the legacy points economy. Filing a case, reporting retaliation,
-- voting, asking for help, messaging a steward, sharing evidence, signing a
-- card, or recording workload must never carry a reward or penalty.
--
-- Historical point rows remain intact for audit. No new points can be minted.
-- The replacement is bounded recognition of an existing, verifier-backed
-- participation record. Callers cannot invent source identifiers or dates.
--
-- Reconciled with the current schema on 2026-10-14 (this file ran at
-- 20260724053134 against an earlier schema). Kept as a deliberate change:
-- the earlier schema runs a points economy (award triggers, a reward store,
-- tiers, admin point-rule and form-template point editors). Rewards are not
-- on the product's left-out list, but paying points for
-- filing an issue, reporting retaliation, signing a card or messaging the
-- committee is what this product refuses, so the minting paths stay closed:
--   * private.award_member_points and its trigger are dropped;
--   * every member_point_rules row and form_templates.points is pinned to 0
--     by check constraints, which also makes the existing
--     private.award_steward_interaction (reads rules with points > 0) and its
--     admin editors (save_reward_point_rule, upsert_form_template) unable to
--     mint; a nonzero edit now fails with a check violation;
--   * clients lose action-log writes and point-table reads.
-- The existing reward tables, store and effects are kept (inert), not
-- dropped. get_member_rewards_summary keeps its existing key set so its
-- client parses the neutral reply. Recognition foreign keys now reference
-- member_chapter_memberships(user_id, chapter_id) instead of
-- member_profiles(id, chapter_id).

drop trigger if exists member_action_log_award_points on public.member_action_log;
drop function if exists private.award_member_points();

update public.member_point_rules
set points = 0;

alter table public.member_point_rules
  add constraint member_point_rules_points_retired_check
  check (points = 0);

update public.form_templates
set points = 0
where points <> 0;

alter table public.form_templates
  add constraint form_templates_points_retired_check
  check (points = 0);

drop policy if exists member_action_log_insert_own on public.member_action_log;
drop policy if exists member_action_log_update_own on public.member_action_log;
revoke all on public.member_action_log from public, anon, authenticated;
grant select on public.member_action_log to authenticated;

revoke all on table
  public.member_point_rules,
  public.member_reward_tiers,
  public.member_point_events
from public, anon, authenticated;

create or replace function private.form_points(p_template_key text)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select 0;
$$;

revoke all on function private.form_points(text) from public, anon, authenticated;

create table public.member_recognition_rules (
  recognition_kind text primary key
    check (recognition_kind in (
      'training_complete',
      'orientation_complete',
      'peer_outreach_complete',
      'committee_commitment_complete',
      'commitment_complete'
    )),
  label_en text not null check (pg_catalog.char_length(label_en) between 3 and 100),
  label_es text not null check (pg_catalog.char_length(label_es) between 3 and 120),
  description_en text not null check (pg_catalog.char_length(description_en) between 3 and 300),
  description_es text not null check (pg_catalog.char_length(description_es) between 3 and 320),
  weekly_cap integer not null check (weekly_cap between 1 and 10),
  active boolean not null default true
);

insert into public.member_recognition_rules (
  recognition_kind,
  label_en,
  label_es,
  description_en,
  description_es,
  weekly_cap
) values
  (
    'training_complete',
    'Completed training',
    'Capacitación completada',
    'A facilitator verified completion of a chapter-approved training.',
    'Una persona facilitadora verificó una capacitación aprobada por el capítulo.',
    2
  ),
  (
    'orientation_complete',
    'Completed orientation',
    'Orientación completada',
    'A facilitator verified completion of member or volunteer orientation.',
    'Una persona facilitadora verificó la orientación de membresía o voluntariado.',
    1
  ),
  (
    'peer_outreach_complete',
    'Completed peer outreach',
    'Alcance entre colegas completado',
    'An assigned, consensual outreach commitment was completed and verified.',
    'Se completó y verificó un compromiso de alcance asignado y consensuado.',
    5
  ),
  (
    'committee_commitment_complete',
    'Completed committee commitment',
    'Compromiso de comité completado',
    'A voluntary committee commitment was completed and verified.',
    'Se completó y verificó un compromiso voluntario de comité.',
    2
  ),
  (
    'commitment_complete',
    'Completed voluntary commitment',
    'Compromiso voluntario completado',
    'A specific, voluntary chapter commitment was completed and verified.',
    'Se completó y verificó un compromiso voluntario específico del capítulo.',
    5
  );

create table public.member_recognition_events (
  id uuid primary key default extensions.gen_random_uuid(),
  participation_event_id uuid not null unique,
  canonical_completion_id uuid not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on delete restrict,
  recognition_kind text not null references public.member_recognition_rules(recognition_kind) on delete restrict,
  source_kind text not null
    check (source_kind in ('learning_assignment', 'capacity_commitment')),
  source_id text not null check (pg_catalog.char_length(source_id) between 1 and 160),
  source_label text check (source_label is null or pg_catalog.char_length(source_label) <= 180),
  occurred_at timestamptz not null,
  verified_by uuid not null references auth.users(id) on delete restrict,
  verified_at timestamptz not null default pg_catalog.statement_timestamp(),
  created_at timestamptz not null default now(),
  unique (user_id, chapter_id, recognition_kind, source_kind, source_id),
  check (verified_by <> user_id),
  check (occurred_at <= verified_at + interval '5 minutes'),
  check (occurred_at >= verified_at - interval '1 year'),
  constraint member_recognition_events_member_scope_fkey
    foreign key (user_id, chapter_id)
    references public.member_chapter_memberships(user_id, chapter_id)
    on delete cascade,
  constraint member_recognition_events_verifier_scope_fkey
    foreign key (verified_by, chapter_id)
    references public.member_chapter_memberships(user_id, chapter_id)
    on delete restrict,
  constraint member_recognition_events_participation_fkey
    foreign key (
      participation_event_id,
      user_id,
      chapter_id,
      recognition_kind,
      source_kind,
      source_id,
      canonical_completion_id
    ) references public.member_participation_events (
      id,
      user_id,
      chapter_id,
      activity_kind,
      source_kind,
      source_id,
      canonical_completion_id
    ) on delete restrict
);

create index member_recognition_events_user_idx
  on public.member_recognition_events(user_id, occurred_at desc);
create index member_recognition_events_chapter_idx
  on public.member_recognition_events(chapter_id, recognition_kind, occurred_at desc);

create table private.member_recognition_week_totals (
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start_utc date not null,
  used_count smallint not null check (used_count between 1 and 10),
  updated_at timestamptz not null default pg_catalog.statement_timestamp(),
  primary key (user_id, week_start_utc),
  check (extract(isodow from week_start_utc) = 1)
);

create table private.member_recognition_week_kind_totals (
  user_id uuid not null,
  week_start_utc date not null,
  recognition_kind text not null
    references public.member_recognition_rules(recognition_kind)
    on delete restrict,
  used_count smallint not null check (used_count between 1 and 10),
  updated_at timestamptz not null default pg_catalog.statement_timestamp(),
  primary key (user_id, week_start_utc, recognition_kind),
  foreign key (user_id, week_start_utc)
    references private.member_recognition_week_totals(user_id, week_start_utc)
    on delete cascade,
  check (extract(isodow from week_start_utc) = 1)
);

alter table private.member_recognition_week_totals enable row level security;
alter table private.member_recognition_week_kind_totals enable row level security;
revoke all on table
  private.member_recognition_week_totals,
  private.member_recognition_week_kind_totals
from public, anon, authenticated;

create function private.enforce_member_recognition_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  kind_cap integer;
  total_after integer;
  kind_after integer;
  week_start date := pg_catalog.date_trunc(
    'week',
    new.verified_at at time zone 'UTC'
  )::date;
begin
  select r.weekly_cap into kind_cap
  from public.member_recognition_rules r
  where r.recognition_kind = new.recognition_kind
    and r.active
  for share;
  if kind_cap is null then
    raise exception 'recognition kind is unavailable' using errcode = '22023';
  end if;

  -- Stable lock order: global bucket first, then the per-kind bucket.
  insert into private.member_recognition_week_totals as totals (
    user_id,
    week_start_utc,
    used_count,
    updated_at
  ) values (
    new.user_id,
    week_start,
    1,
    new.verified_at
  )
  on conflict (user_id, week_start_utc) do update
  set used_count = (totals.used_count + 1)::smallint,
      updated_at = excluded.updated_at
  where totals.used_count < 10
  returning used_count into total_after;
  if total_after is null then
    raise exception 'recognition verification cap reached' using errcode = '22023';
  end if;

  insert into private.member_recognition_week_kind_totals as kinds (
    user_id,
    week_start_utc,
    recognition_kind,
    used_count,
    updated_at
  ) values (
    new.user_id,
    week_start,
    new.recognition_kind,
    1,
    new.verified_at
  )
  on conflict (user_id, week_start_utc, recognition_kind) do update
  set used_count = (kinds.used_count + 1)::smallint,
      updated_at = excluded.updated_at
  where kinds.used_count < kind_cap
  returning used_count into kind_after;
  if kind_after is null then
    -- Raising rolls back the global increment and the recognition insert.
    raise exception 'recognition verification cap reached' using errcode = '22023';
  end if;

  return null;
end;
end;
$$;

create trigger member_recognition_events_enforce_cap
  after insert on public.member_recognition_events
  for each row execute function private.enforce_member_recognition_cap();

alter table public.member_recognition_rules enable row level security;
alter table public.member_recognition_events enable row level security;

create policy mfa_assurance on public.member_recognition_rules
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.member_recognition_events
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

create policy member_recognition_rules_select_all
  on public.member_recognition_rules
  for select to authenticated
  using (active);

create policy member_recognition_events_select_own
  on public.member_recognition_events
  for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table
  public.member_recognition_rules,
  public.member_recognition_events
from public, anon, authenticated;

grant select on public.member_recognition_rules to authenticated;
grant select (
  id,
  user_id,
  recognition_kind,
  source_label,
  occurred_at,
  verified_at
) on public.member_recognition_events to authenticated;

create function public.record_member_recognition(
  p_participation_event_id uuid
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
  caller_chapter text;
  participation public.member_participation_events%rowtype;
  source_label text;
  existing_id uuid;
  recognition_id uuid;
  audit_id uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'recognition verifier role required' using errcode = '42501';
  end if;

  -- Union Ground's chapter-scoped grant in the caller's selected chapter,
  -- with an active membership there and Union Ground's own role predicate
  -- (organization membership, staff-MFA policy) in agreement.
  select p.chapter_id into caller_chapter
  from public.member_profiles p
  join public.member_chapter_memberships m
    on m.user_id = p.id
   and m.chapter_id = p.chapter_id
   and m.status = 'active'
  where p.id = caller
    and exists (
      select 1
      from public.member_role_chapters r
      where r.user_id = p.id
        and r.chapter_id = p.chapter_id
        and r.role in ('steward', 'organizer', 'coordinator')
    )
    and private.member_has_chapter_role(
      p.chapter_id, array['steward', 'organizer', 'coordinator']
    );
  if caller is null or caller_chapter is null then
    raise exception 'recognition verifier role required' using errcode = '42501';
  end if;
  if p_participation_event_id is null then
    raise exception 'verified participation record required' using errcode = '22023';
  end if;

  select pe.* into participation
  from public.member_participation_events pe
  where pe.id = p_participation_event_id
  for key share;

  if participation.id is null or participation.chapter_id <> caller_chapter then
    raise exception 'verified participation record not found' using errcode = '22023';
  end if;
  if participation.user_id = caller then
    raise exception 'self-recognition is not allowed' using errcode = '22023';
  end if;
  if participation.occurred_at > pg_catalog.statement_timestamp() + interval '5 minutes'
     or participation.occurred_at < pg_catalog.statement_timestamp() - interval '1 year' then
    raise exception 'recognition date is invalid' using errcode = '22023';
  end if;

  if participation.canonical_completion_id is null
     or participation.activity_kind not in (
       'training_complete',
       'orientation_complete',
       'peer_outreach_complete',
       'committee_commitment_complete',
       'commitment_complete'
     )
     or participation.source_kind not in ('learning_assignment', 'capacity_commitment') then
    raise exception 'participation source is not eligible for recognition' using errcode = '22023';
  end if;

  select coalesce(s.title, c.title) into source_label
  from public.member_participation_completions pc
  left join public.member_learning_assignments a
    on a.id = pc.learning_assignment_id
  left join public.member_learning_sessions s
    on s.id = a.session_id
  left join public.member_capacity_commitments c
    on c.id = pc.capacity_commitment_id
  where pc.id = participation.canonical_completion_id;
  if source_label is null then
    raise exception 'canonical participation source not found' using errcode = '23514';
  end if;

  insert into public.member_recognition_events (
    participation_event_id,
    canonical_completion_id,
    user_id,
    chapter_id,
    recognition_kind,
    source_kind,
    source_id,
    source_label,
    occurred_at,
    verified_by
  ) values (
    participation.id,
    participation.canonical_completion_id,
    participation.user_id,
    participation.chapter_id,
    participation.activity_kind,
    participation.source_kind,
    participation.source_id,
    source_label,
    participation.occurred_at,
    caller
  )
  on conflict (participation_event_id) do nothing
  returning id into recognition_id;

  if recognition_id is null then
    select e.id into existing_id
    from public.member_recognition_events e
    where e.participation_event_id = participation.id;
    if existing_id is null then
      raise exception 'recognition outcome not visible; retry transaction'
        using errcode = '40001';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'recognitionId', existing_id
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
    participation.chapter_id,
    caller,
    'participation.recognized',
    'member_recognition',
    recognition_id,
    participation.activity_kind,
    pg_catalog.jsonb_build_object(
      'participationEventId', participation.id,
      'sourceKind', participation.source_kind
    )
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'recognitionId', recognition_id,
    'auditEventId', audit_id
  );
end;
end;
$$;

create function public.get_member_recognition_summary()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  total_verified integer := 0;
  recent_verified integer := 0;
  current_rung text := 'learn';
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) filter (
      where occurred_at >= now() - interval '90 days'
    )::integer
  into total_verified, recent_verified
  from public.member_recognition_events
  where user_id = caller;

  -- Ladder position is factual participation, not the smaller set of
  -- acknowledgements that happen to be recognition-eligible.
  select e.rung into current_rung
  from public.member_participation_events e
  where e.user_id = caller
  order by case
    when e.rung = 'lead' then 5
    when e.rung = 'organize' then 4
    when e.rung = 'volunteer' then 3
    when e.rung = 'attend' then 2
    else 1
  end desc, e.occurred_at desc
  limit 1;

  return pg_catalog.jsonb_build_object(
    'totalVerified', coalesce(total_verified, 0),
    'recentVerified', coalesce(recent_verified, 0),
    'currentRung', coalesce(current_rung, 'learn'),
    'retiredPointsHidden', true
  );
end;
$$;

-- Compatibility for older clients: never expose the retired point balance as
-- an active incentive system.
create or replace function public.get_member_rewards_summary()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'totalPoints', 0,
    'tierNumber', 1,
    'tierName', 'Contributions',
    'nextTierName', null,
    'pointsToGo', null,
    'weekStreak', 0,
    'actionsYtd', 0,
    'retired', true
  )
  where (select auth.uid()) is not null;
$$;

revoke all on function private.enforce_member_recognition_cap() from public, anon, authenticated;
revoke all on function public.record_member_recognition(uuid) from public, anon, authenticated;
revoke all on function public.get_member_recognition_summary() from public, anon, authenticated;
revoke all on function public.get_member_rewards_summary() from public, anon, authenticated;
grant execute on function public.record_member_recognition(uuid) to authenticated;
grant execute on function public.get_member_recognition_summary() to authenticated;
grant execute on function public.get_member_rewards_summary() to authenticated;
