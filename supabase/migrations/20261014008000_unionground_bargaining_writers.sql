-- Add the bounded Union Ground first-contract docket. This migration is
-- fresh/offline only: stop application traffic before applying it to any
-- dedicated hosted target.
--
-- Bargaining content and external evidence stay in ungranted tables. Public
-- clients receive only the role-shaped projection near the end of this file.
--
-- Reconciled with the current schema on 2026-10-14 (this file ran at
-- 20260724110000 against an earlier schema). No earlier bargaining docket
-- exists under these names. Role reads that used legacy member_roles now use
-- the chapter-scoped member_role_chapters, and the writer lock
-- also share-locks the caller's active member_chapter_memberships row and
-- rechecks private.member_has_chapter_role (see 20261014001000 for why).

-- 1. Harden the existing bargaining records --------------------------------

do $migration_preflight$
begin
  if exists (
    select 1
    from public.organizing_bargaining_proposals
    where status = 'tentative_agreement'
  ) then
    raise exception
      'migration requires manual agreement-package classification for existing tentative-agreement proposals'
      using errcode = '55000';
  end if;
end
$migration_preflight$;

alter table public.organizing_bargaining_cycles
  add column current_ratification_id uuid,
  add column ratification_integrity_hold boolean not null default false,
  add constraint organizing_bargaining_cycles_revision_check
    check (revision > 0) not valid,
  add constraint organizing_bargaining_cycles_date_shape_check
    check (
      (
        phase in ('preparing', 'proposal_development')
        or bargaining_started_on is not null
      )
      and (
        first_contract_signed_on is null
        or bargaining_started_on is null
        or first_contract_signed_on >= bargaining_started_on
      )
      and (
        phase <> 'complete'
        or first_contract_signed_on is not null
      )
    ) not valid,
  add constraint organizing_bargaining_cycles_scope_key
    unique (id, campaign_id, chapter_id),
  add constraint organizing_bargaining_cycles_ratification_hold_check
    check (
      not ratification_integrity_hold
      or current_ratification_id is null
    ) not valid;

alter table public.organizing_bargaining_cycles
  validate constraint organizing_bargaining_cycles_revision_check,
  validate constraint organizing_bargaining_cycles_date_shape_check,
  validate constraint organizing_bargaining_cycles_ratification_hold_check;

alter table public.organizing_bargaining_proposals
  add column campaign_id uuid,
  add column chapter_id text,
  add column relation_kind text,
  add column record_kind text not null default 'article',
  add column included_proposal_ids uuid[] not null default '{}'::uuid[],
  add column document_sha256 text,
  add column revision integer not null default 1,
  add column create_request_id uuid,
  add column updated_at timestamptz not null default now();

update public.organizing_bargaining_proposals p
set campaign_id = c.campaign_id,
    chapter_id = c.chapter_id,
    relation_kind = case
      when p.parent_proposal_id is null then null
      else 'revision'
    end,
    create_request_id = extensions.gen_random_uuid()
from public.organizing_bargaining_cycles c
where c.id = p.cycle_id;

alter table public.organizing_bargaining_proposals
  alter column campaign_id set not null,
  alter column chapter_id set not null,
  alter column create_request_id set not null,
  add constraint organizing_bargaining_proposals_topic_check
    check (pg_catalog.char_length(pg_catalog.btrim(topic)) between 1 and 120)
    not valid,
  add constraint organizing_bargaining_proposals_title_check
    check (pg_catalog.char_length(pg_catalog.btrim(title)) between 3 and 200)
    not valid,
  add constraint organizing_bargaining_proposals_summary_check
    check (
      member_summary is null
      or pg_catalog.char_length(member_summary) <= 2000
    ) not valid,
  add constraint organizing_bargaining_proposals_notes_check
    check (
      internal_notes is null
      or pg_catalog.char_length(internal_notes) <= 12000
    ) not valid,
  add constraint organizing_bargaining_proposals_relation_check
    check (
      (
        parent_proposal_id is null
        and relation_kind is null
        and version = 1
      )
      or (
        parent_proposal_id is not null
        and relation_kind is not null
        and relation_kind in ('revision', 'counter', 'replacement')
        and version > 1
      )
    ) not valid,
  add constraint organizing_bargaining_proposals_record_shape_check
    check (
      (
        record_kind = 'article'
        and pg_catalog.cardinality(included_proposal_ids) = 0
        and document_sha256 is null
      )
      or (
        record_kind = 'agreement_package'
        and pg_catalog.cardinality(included_proposal_ids) > 0
        and document_sha256 is not null
        and document_sha256 ~ '^[0-9a-f]{64}$'
      )
    ) not valid,
  add constraint organizing_bargaining_proposals_revision_check
    check (revision > 0) not valid,
  add constraint organizing_bargaining_proposals_cycle_scope_fkey
    foreign key (cycle_id, campaign_id, chapter_id)
    references public.organizing_bargaining_cycles(id, campaign_id, chapter_id)
    on delete cascade,
  add constraint organizing_bargaining_proposals_scope_key
    unique (id, cycle_id, campaign_id, chapter_id),
  add constraint organizing_bargaining_proposals_document_scope_key
    unique (id, cycle_id, campaign_id, chapter_id, document_sha256),
  add constraint organizing_bargaining_proposals_creator_request_key
    unique (created_by, chapter_id, create_request_id);

alter table public.organizing_bargaining_proposals
  validate constraint organizing_bargaining_proposals_topic_check,
  validate constraint organizing_bargaining_proposals_title_check,
  validate constraint organizing_bargaining_proposals_summary_check,
  validate constraint organizing_bargaining_proposals_notes_check,
  validate constraint organizing_bargaining_proposals_relation_check,
  validate constraint organizing_bargaining_proposals_record_shape_check,
  validate constraint organizing_bargaining_proposals_revision_check;

alter table public.organizing_bargaining_proposals
  add constraint organizing_bargaining_proposals_parent_scope_fkey
    foreign key (
      parent_proposal_id,
      cycle_id,
      campaign_id,
      chapter_id
    )
    references public.organizing_bargaining_proposals(
      id,
      cycle_id,
      campaign_id,
      chapter_id
    )
    on delete restrict;

create unique index organizing_bargaining_proposals_linear_lineage_idx
  on public.organizing_bargaining_proposals(parent_proposal_id)
  where parent_proposal_id is not null;

create unique index organizing_bargaining_proposals_current_ta_idx
  on public.organizing_bargaining_proposals(cycle_id)
  where status = 'tentative_agreement'
    and record_kind = 'agreement_package';

alter table public.organizing_bargaining_sessions
  add column campaign_id uuid,
  add column chapter_id text,
  add column revision integer not null default 1,
  add column create_request_id uuid,
  add column outcome_reason text,
  add column updated_at timestamptz not null default now();

update public.organizing_bargaining_sessions s
set campaign_id = c.campaign_id,
    chapter_id = c.chapter_id,
    create_request_id = extensions.gen_random_uuid(),
    member_update = coalesce(s.member_update, '')
from public.organizing_bargaining_cycles c
where c.id = s.cycle_id;

alter table public.organizing_bargaining_sessions
  alter column campaign_id set not null,
  alter column chapter_id set not null,
  alter column create_request_id set not null,
  alter column member_update set default '',
  alter column member_update set not null,
  add constraint organizing_bargaining_sessions_revision_check
    check (revision > 0) not valid,
  add constraint organizing_bargaining_sessions_time_check
    check (ends_at is null or ends_at >= starts_at) not valid,
  add constraint organizing_bargaining_sessions_location_check
    check (
      location is null
      or pg_catalog.char_length(location) <= 240
    ) not valid,
  add constraint organizing_bargaining_sessions_agenda_check
    check (
      agenda is null
      or pg_catalog.char_length(agenda) <= 12000
    ) not valid,
  add constraint organizing_bargaining_sessions_minutes_check
    check (
      internal_minutes is null
      or pg_catalog.char_length(internal_minutes) <= 20000
    ) not valid,
  add constraint organizing_bargaining_sessions_member_update_check
    check (pg_catalog.char_length(member_update) <= 2000) not valid,
  add constraint organizing_bargaining_sessions_outcome_reason_check
    check (
      outcome_reason is null
      or pg_catalog.char_length(outcome_reason) <= 2000
    ) not valid,
  add constraint organizing_bargaining_sessions_status_shape_check
    check (
      (
        status = 'scheduled'
        and ends_at is null
        and member_update = ''
        and outcome_reason is null
      )
      or (
        status = 'held'
        and ends_at is not null
        and pg_catalog.char_length(pg_catalog.btrim(member_update))
          between 3 and 2000
      )
      or (
        status = 'cancelled'
        and ends_at is null
        and member_update = ''
        and outcome_reason is not null
        and pg_catalog.char_length(pg_catalog.btrim(outcome_reason))
          between 1 and 2000
      )
    ) not valid,
  add constraint organizing_bargaining_sessions_cycle_scope_fkey
    foreign key (cycle_id, campaign_id, chapter_id)
    references public.organizing_bargaining_cycles(id, campaign_id, chapter_id)
    on delete cascade,
  add constraint organizing_bargaining_sessions_scope_key
    unique (id, cycle_id, campaign_id, chapter_id),
  add constraint organizing_bargaining_sessions_creator_request_key
    unique (created_by, chapter_id, create_request_id);

alter table public.organizing_bargaining_sessions
  validate constraint organizing_bargaining_sessions_revision_check,
  validate constraint organizing_bargaining_sessions_time_check,
  validate constraint organizing_bargaining_sessions_location_check,
  validate constraint organizing_bargaining_sessions_agenda_check,
  validate constraint organizing_bargaining_sessions_minutes_check,
  validate constraint organizing_bargaining_sessions_member_update_check,
  validate constraint organizing_bargaining_sessions_outcome_reason_check,
  validate constraint organizing_bargaining_sessions_status_shape_check;

create trigger organizing_bargaining_proposals_touch_updated_at
  before update on public.organizing_bargaining_proposals
  for each row execute function private.touch_updated_at();

create trigger organizing_bargaining_sessions_touch_updated_at
  before update on public.organizing_bargaining_sessions
  for each row execute function private.touch_updated_at();

-- A proposal version is a content snapshot. Only its workflow fields may
-- change after insert; later content is a child lineage row.
create function private.preserve_bargaining_proposal_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.cycle_id is distinct from old.cycle_id
     or new.campaign_id is distinct from old.campaign_id
     or new.chapter_id is distinct from old.chapter_id
     or new.parent_proposal_id is distinct from old.parent_proposal_id
     or new.relation_kind is distinct from old.relation_kind
     or new.record_kind is distinct from old.record_kind
     or new.included_proposal_ids is distinct from old.included_proposal_ids
     or new.document_sha256 is distinct from old.document_sha256
     or new.topic is distinct from old.topic
     or new.title is distinct from old.title
     or new.side is distinct from old.side
     or new.version is distinct from old.version
     or new.member_summary is distinct from old.member_summary
     or new.internal_notes is distinct from old.internal_notes
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.create_request_id is distinct from old.create_request_id then
    raise exception 'proposal version content is immutable' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.preserve_bargaining_proposal_snapshot()
  from public, anon, authenticated, service_role;

-- 6. Bargaining-session commands -------------------------------------------

create function public.schedule_organizing_bargaining_session(
  p_cycle_id uuid,
  p_expected_cycle_revision integer,
  p_starts_at timestamptz,
  p_request_id uuid,
  p_location text default null,
  p_agenda text default null
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
  target record;
  campaign record;
  cycle record;
  receipt record;
  session_id uuid;
  next_session_number integer;
  fingerprint text;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_location text := nullif(pg_catalog.btrim(coalesce(p_location, '')), '');
  normalized_agenda text := nullif(pg_catalog.btrim(coalesce(p_agenda, '')), '');
begin
  if caller is null or p_cycle_id is null or p_request_id is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;
  if p_expected_cycle_revision is null or p_expected_cycle_revision <= 0 then
    raise exception 'cycle revision is required' using errcode = '22023';
  end if;
  if p_starts_at is null then
    raise exception 'session start is required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(normalized_location, '')) > 240
     or pg_catalog.char_length(coalesce(normalized_agenda, '')) > 12000 then
    raise exception 'session fields are invalid' using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.session.scheduled',
    pg_catalog.jsonb_build_object(
      'cycleId', p_cycle_id,
      'expectedCycleRevision', p_expected_cycle_revision,
      'startsAt', private.bargaining_canonical_instant(p_starts_at),
      'location', normalized_location,
      'agenda', normalized_agenda
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select c.campaign_id, c.chapter_id
  into target
  from public.organizing_bargaining_cycles c
  where c.id = p_cycle_id;

  if not found then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = p_cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       false
     ) is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.session.scheduled'
       or receipt.campaign_id is distinct from campaign.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'cycleId', cycle.id,
      'cycleRevision', (receipt.safe_metadata ->> 'cycleRevision')::integer,
      'sessionId', receipt.entity_id,
      'sessionNumber', (receipt.safe_metadata ->> 'sessionNumber')::integer,
      'status', receipt.to_state,
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if cycle.revision <> p_expected_cycle_revision then
    raise exception 'bargaining cycle changed; reload and try again'
      using errcode = '40001';
  end if;
  if campaign.status <> 'active' or cycle.phase = 'complete' then
    raise exception 'bargaining cycle is not editable' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.max(s.session_number), 0) + 1
  into next_session_number
  from public.organizing_bargaining_sessions s
  where s.cycle_id = cycle.id;

  insert into public.organizing_bargaining_sessions (
    cycle_id,
    campaign_id,
    chapter_id,
    session_number,
    starts_at,
    location,
    status,
    agenda,
    member_update,
    revision,
    create_request_id,
    created_by,
    created_at,
    updated_at
  ) values (
    cycle.id,
    campaign.id,
    campaign.chapter_id,
    next_session_number,
    p_starts_at,
    normalized_location,
    'scheduled',
    normalized_agenda,
    '',
    1,
    p_request_id,
    caller,
    event_time,
    event_time
  ) returning id into session_id;

  update public.organizing_bargaining_cycles
  set revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.session.scheduled',
    'bargaining_session',
    session_id,
    'scheduled',
    pg_catalog.jsonb_build_object(
      'cycleRevision',
      cycle.revision + 1,
      'sessionNumber',
      next_session_number
    ),
    p_request_id,
    fingerprint,
    1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'cycleId', cycle.id,
    'cycleRevision', cycle.revision + 1,
    'sessionId', session_id,
    'sessionNumber', next_session_number,
    'status', 'scheduled',
    'revision', 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- 8. Safe bargaining projection --------------------------------------------

create function public.get_bargaining_workspace()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  scope_chapter text := private.lifecycle_scope_chapter(
    array['organizer', 'coordinator', 'advisor', 'vp']
  );
  chapter_wide boolean;
  aggregate_view boolean;
  strict_mfa boolean;
begin
  if caller is null or scope_chapter is null then
    raise exception 'lifecycle staff role required' using errcode = '42501';
  end if;

  chapter_wide := exists (
    select 1
    from public.member_role_chapters r
    where r.user_id = caller
      and r.chapter_id = scope_chapter
      and r.role = 'coordinator'
  );
  aggregate_view := exists (
    select 1
    from public.member_role_chapters r
    where r.user_id = caller
      and r.chapter_id = scope_chapter
      and r.role in ('advisor', 'vp')
  ) and not chapter_wide and not exists (
    select 1
    from public.member_role_chapters r
    where r.user_id = caller
      and r.chapter_id = scope_chapter
      and r.role = 'organizer'
  );
  if aggregate_view then
    return pg_catalog.jsonb_build_object(
      'canOpenCampaignIds', '[]'::jsonb,
      'bargaining', '[]'::jsonb
    );
  end if;
  strict_mfa := private.bargaining_strict_mfa_satisfied();

  return pg_catalog.jsonb_build_object(
    'canOpenCampaignIds',
    coalesce((
      select pg_catalog.jsonb_agg(campaign.id)
      from public.organizing_campaigns campaign
      where strict_mfa
        and campaign.chapter_id = scope_chapter
        and campaign.status = 'active'
        and campaign.stage in ('recognition', 'certification', 'bargaining')
        and not exists (
          select 1
          from public.organizing_bargaining_cycles cycle
          where cycle.campaign_id = campaign.id
        )
        and exists (
          select 1
          from public.organizing_campaign_assignments a
          join public.member_role_chapters r
            on r.user_id = a.user_id
           and r.chapter_id = a.chapter_id
          where a.campaign_id = campaign.id
            and a.chapter_id = campaign.chapter_id
            and a.user_id = caller
            and a.status = 'active'
            and (
              (
                r.role = 'coordinator'
                and a.assignment_role = 'coordinator'
              )
              or (
                r.role = 'organizer'
                and a.assignment_role in ('lead_organizer', 'organizer')
              )
            )
        )
    ), '[]'::jsonb),
    'bargaining',
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', c.id,
          'campaignId', c.campaign_id,
          'title', c.title,
          'phase', c.phase,
          'status', c.phase,
          'revision', c.revision,
          'bargainingStartedOn', c.bargaining_started_on,
          'firstContractTargetOn', c.target_first_contract_on,
          'firstContractSignedOn', c.first_contract_signed_on,
          'nextAction', c.next_action,
          'nextDeadlineAt', c.next_deadline_at,
          'ratificationIntegrityHold', c.ratification_integrity_hold,
          'surveyReturnRate', null,
          'surveyReturnAvailability',
            'Not shown without a verified denominator and suppression check.',
          'canWrite',
            strict_mfa
            and c.phase not in ('execution', 'complete')
            and exists (
              select 1
              from public.organizing_campaigns active_campaign
              where active_campaign.id = c.campaign_id
                and active_campaign.chapter_id = c.chapter_id
                and active_campaign.status = 'active'
            )
            and exists (
              select 1
              from public.organizing_campaign_assignments a
              join public.member_role_chapters r
                on r.user_id = a.user_id
               and r.chapter_id = a.chapter_id
              where a.campaign_id = c.campaign_id
                and a.chapter_id = c.chapter_id
                and a.user_id = caller
                and a.status = 'active'
                and (
                  (
                    r.role = 'coordinator'
                    and a.assignment_role = 'coordinator'
                  )
                  or (
                    r.role = 'organizer'
                    and a.assignment_role in ('lead_organizer', 'organizer')
                  )
                )
            ),
          'canCertify',
            strict_mfa
            and c.phase <> 'complete'
            and exists (
              select 1
              from public.organizing_campaigns active_campaign
              where active_campaign.id = c.campaign_id
                and active_campaign.chapter_id = c.chapter_id
                and active_campaign.status = 'active'
            )
            and exists (
              select 1
              from public.organizing_campaign_assignments a
              join public.member_role_chapters r
                on r.user_id = a.user_id
               and r.chapter_id = a.chapter_id
               and r.role = 'coordinator'
              where a.campaign_id = c.campaign_id
                and a.chapter_id = c.chapter_id
                and a.user_id = caller
                and a.status = 'active'
                and a.assignment_role = 'coordinator'
            ),
          'canRecordSessionOutcome',
            strict_mfa
            and c.phase <> 'complete'
            and exists (
              select 1
              from public.organizing_campaigns active_campaign
              where active_campaign.id = c.campaign_id
                and active_campaign.chapter_id = c.chapter_id
                and active_campaign.status = 'active'
            )
            and exists (
              select 1
              from public.organizing_campaign_assignments a
              join public.member_role_chapters r
                on r.user_id = a.user_id
               and r.chapter_id = a.chapter_id
              where a.campaign_id = c.campaign_id
                and a.chapter_id = c.chapter_id
                and a.user_id = caller
                and a.status = 'active'
                and (
                  (
                    r.role = 'coordinator'
                    and a.assignment_role = 'coordinator'
                  )
                  or (
                    r.role = 'organizer'
                    and a.assignment_role in ('lead_organizer', 'organizer')
                  )
                )
            ),
          'canAdvanceToRatification',
            not c.ratification_integrity_hold
            and exists (
              select 1
              from public.organizing_bargaining_proposals agreement_package
              where agreement_package.cycle_id = c.id
                and agreement_package.campaign_id = c.campaign_id
                and agreement_package.chapter_id = c.chapter_id
                and agreement_package.record_kind = 'agreement_package'
                and agreement_package.status = 'tentative_agreement'
                and agreement_package.document_sha256 is not null
                and agreement_package.presented_on is not null
                and not exists (
                  select 1
                  from public.organizing_bargaining_proposals child
                  where child.parent_proposal_id = agreement_package.id
                )
                and not exists (
                  select 1
                  from pg_catalog.unnest(
                    agreement_package.included_proposal_ids
                  ) included_id
                  left join public.organizing_bargaining_proposals included
                    on included.id = included_id
                   and included.cycle_id = c.id
                   and included.campaign_id = c.campaign_id
                   and included.chapter_id = c.chapter_id
                   and included.record_kind = 'article'
                  where included.id is null
                     or included.status <> 'accepted'
                     or included.presented_on is null
                     or included.presented_on > agreement_package.presented_on
                     or exists (
                       select 1
                       from public.organizing_bargaining_proposals child
                       where child.parent_proposal_id = included.id
                     )
                )
                and not exists (
                  select 1
                  from public.organizing_bargaining_proposals current_article
                  where current_article.cycle_id = c.id
                    and current_article.campaign_id = c.campaign_id
                    and current_article.chapter_id = c.chapter_id
                    and current_article.record_kind = 'article'
                    and current_article.status = 'accepted'
                    and not exists (
                      select 1
                      from public.organizing_bargaining_proposals child
                      where child.parent_proposal_id = current_article.id
                    )
                    and not (
                      current_article.id
                        = any(agreement_package.included_proposal_ids)
                    )
                )
                and not exists (
                  select 1
                  from public.organizing_bargaining_proposals unresolved_article
                  where unresolved_article.cycle_id = c.id
                    and unresolved_article.campaign_id = c.campaign_id
                    and unresolved_article.chapter_id = c.chapter_id
                    and unresolved_article.record_kind = 'article'
                    and unresolved_article.status not in (
                      'accepted',
                      'rejected',
                      'withdrawn',
                      'superseded'
                    )
                    and not exists (
                      select 1
                      from public.organizing_bargaining_proposals child
                      where child.parent_proposal_id = unresolved_article.id
                    )
                )
            ),
          'canRecordFirstContract',
            strict_mfa
            and c.phase = 'execution'
            and not c.ratification_integrity_hold
            and not exists (
              select 1
              from public.organizing_bargaining_sessions pending_session
              where pending_session.cycle_id = c.id
                and pending_session.campaign_id = c.campaign_id
                and pending_session.chapter_id = c.chapter_id
                and pending_session.status = 'scheduled'
            )
            and exists (
              select 1
              from public.organizing_bargaining_ratifications current_result
               where current_result.id = c.current_ratification_id
                 and current_result.cycle_id = c.id
                 and current_result.execution_authorized
                 and not exists (
                   select 1
                   from public.organizing_bargaining_ratification_corrections correction
                   where correction.ratification_id = current_result.id
                 )
            )
            and exists (
              select 1
              from public.organizing_campaigns active_campaign
              where active_campaign.id = c.campaign_id
                and active_campaign.chapter_id = c.chapter_id
                and active_campaign.status = 'active'
            )
            and exists (
              select 1
              from public.organizing_campaign_assignments a
              join public.member_role_chapters r
                on r.user_id = a.user_id
               and r.chapter_id = a.chapter_id
               and r.role = 'coordinator'
              where a.campaign_id = c.campaign_id
                and a.chapter_id = c.chapter_id
                and a.user_id = caller
                and a.status = 'active'
                and a.assignment_role = 'coordinator'
            ),
          'canCorrectRatification',
            strict_mfa
            and c.current_ratification_id is not null
            and c.phase in ('at_table', 'ratification', 'execution', 'complete')
            and exists (
              select 1
              from public.organizing_campaigns correction_campaign
              where correction_campaign.id = c.campaign_id
                and correction_campaign.chapter_id = c.chapter_id
                and (
                  correction_campaign.status = 'active'
                  or (
                    correction_campaign.status = 'closed'
                    and correction_campaign.stage = 'established'
                    and correction_campaign.outcome = 'established'
                  )
                )
            )
            and exists (
              select 1
              from public.organizing_campaign_assignments a
              join public.member_role_chapters r
                on r.user_id = a.user_id
               and r.chapter_id = a.chapter_id
               and r.role = 'coordinator'
              where a.campaign_id = c.campaign_id
                and a.chapter_id = c.chapter_id
                and a.user_id = caller
                and a.status = 'active'
                and a.assignment_role = 'coordinator'
            ),
          'proposals',
            coalesce((
              select pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                  'id', p.id,
                  'parentProposalId', p.parent_proposal_id,
                  'relationKind', p.relation_kind,
                  'recordKind', p.record_kind,
                  'includedProposalCount', pg_catalog.cardinality(p.included_proposal_ids),
                  'topic', p.topic,
                  'title', p.title,
                  'side', p.side,
                  'status', p.status,
                  'version', p.version,
                  'revision', p.revision,
                  'memberSummary', case
                    when p.status <> 'draft' then p.member_summary
                    else null
                  end,
                  'presentedOn', p.presented_on,
                  'canMarkTentativeAgreement',
                    p.record_kind = 'agreement_package'
                    and p.status in ('presented', 'countered')
                    and nullif(
                      pg_catalog.btrim(coalesce(p.member_summary, '')),
                      ''
                    ) is not null
                    and p.presented_on is not null
                    and not exists (
                      select 1
                      from public.organizing_bargaining_proposals other_package
                      where other_package.cycle_id = c.id
                        and other_package.campaign_id = c.campaign_id
                        and other_package.chapter_id = c.chapter_id
                        and other_package.record_kind = 'agreement_package'
                        and other_package.status = 'tentative_agreement'
                        and other_package.id <> p.id
                    )
                    and not exists (
                      select 1
                      from public.organizing_bargaining_proposals child
                      where child.parent_proposal_id = p.id
                    )
                    and not exists (
                      select 1
                      from pg_catalog.unnest(p.included_proposal_ids) included_id
                      left join public.organizing_bargaining_proposals included
                        on included.id = included_id
                       and included.cycle_id = c.id
                       and included.campaign_id = c.campaign_id
                       and included.chapter_id = c.chapter_id
                       and included.record_kind = 'article'
                      where included.id is null
                         or included.status <> 'accepted'
                         or included.presented_on is null
                         or included.presented_on > p.presented_on
                         or exists (
                           select 1
                           from public.organizing_bargaining_proposals child
                           where child.parent_proposal_id = included.id
                         )
                    )
                    and not exists (
                      select 1
                      from public.organizing_bargaining_proposals current_article
                      where current_article.cycle_id = c.id
                        and current_article.campaign_id = c.campaign_id
                        and current_article.chapter_id = c.chapter_id
                        and current_article.record_kind = 'article'
                        and current_article.status = 'accepted'
                        and not exists (
                          select 1
                          from public.organizing_bargaining_proposals child
                          where child.parent_proposal_id = current_article.id
                        )
                        and not (
                          current_article.id = any(p.included_proposal_ids)
                        )
                    )
                    and not exists (
                      select 1
                      from public.organizing_bargaining_proposals unresolved_article
                      where unresolved_article.cycle_id = c.id
                        and unresolved_article.campaign_id = c.campaign_id
                        and unresolved_article.chapter_id = c.chapter_id
                        and unresolved_article.record_kind = 'article'
                        and unresolved_article.status not in (
                          'accepted',
                          'rejected',
                          'withdrawn',
                          'superseded'
                        )
                        and not exists (
                          select 1
                          from public.organizing_bargaining_proposals child
                          where child.parent_proposal_id = unresolved_article.id
                        )
                    )
                )
                order by p.created_at, p.version
              )
              from public.organizing_bargaining_proposals p
              where p.cycle_id = c.id
            ), '[]'::jsonb),
          'sessions',
            coalesce((
              select pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                  'id', s.id,
                  'sessionNumber', s.session_number,
                  'startsAt', s.starts_at,
                  'endsAt', s.ends_at,
                  'location', s.location,
                  'status', s.status,
                  'revision', s.revision,
                  'summary', s.member_update
                )
                order by s.starts_at desc
              )
              from public.organizing_bargaining_sessions s
              where s.cycle_id = c.id
            ), '[]'::jsonb),
          'ratifications',
            coalesce((
              select pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                   'id', r.id,
                   'supersedesRatificationId', r.supersedes_ratification_id,
                  'agreementProposalId', r.agreement_proposal_id,
                  'decisionMethod', r.decision_method,
                   'outcome', case
                     when exists (
                       select 1
                       from public.organizing_bargaining_ratification_corrections correction
                       where correction.ratification_id = r.id
                     ) then 'corrected'
                     when r.decision_method = 'vote' and r.eligible_count < 5
                       then 'suppressed'
                     else r.computed_outcome
                   end,
                   'suppressed',
                     coalesce(
                       r.decision_method = 'vote' and r.eligible_count < 5,
                       false
                     ),
                   'current', coalesce(c.current_ratification_id = r.id, false),
                   'corrected', exists (
                     select 1
                     from public.organizing_bargaining_ratification_corrections correction
                     where correction.ratification_id = r.id
                   ),
                   'correctionReasonCode', (
                     select correction.reason_code
                     from public.organizing_bargaining_ratification_corrections correction
                     where correction.ratification_id = r.id
                   ),
                  'heldOn', r.held_on,
                  'verification',
                    'staff_recorded_external_aggregate'
                )
                order by r.created_at desc
              )
              from public.organizing_bargaining_ratifications r
              where r.cycle_id = c.id
            ), '[]'::jsonb),
          'firstContract',
            (
              select pg_catalog.jsonb_build_object(
                'id', f.id,
                'status', case
                  when c.ratification_integrity_hold then 'integrity_hold'
                  else f.verification_status
                end,
                'disputed', c.ratification_integrity_hold,
                'signedOn', f.signed_on,
                'effectiveOn', f.effective_on,
                'expiresOn', f.expires_on,
                'verification', case
                  when c.ratification_integrity_hold
                    then 'corrected_ratification_requires_governed_resolution'
                  else 'staff_recorded_executed_agreement'
                end
              )
              from public.organizing_first_contracts f
              where f.cycle_id = c.id
            )
        )
        order by c.created_at desc
      )
      from public.organizing_bargaining_cycles c
      where c.chapter_id = scope_chapter
        and (
          chapter_wide
          or exists (
            select 1
            from public.organizing_campaign_assignments a
            where a.campaign_id = c.campaign_id
              and a.chapter_id = c.chapter_id
              and a.user_id = caller
              and a.status = 'active'
              and a.assignment_role in (
                'lead_organizer',
                'organizer',
                'coordinator',
                'legal_reviewer',
                'viewer'
              )
          )
        )
    ), '[]'::jsonb)
  );
end;
$$;

-- 7. Staff-verified external ratification and executed-contract commands ----

create function public.record_organizing_ratification(
  p_cycle_id uuid,
  p_expected_cycle_revision integer,
  p_expected_campaign_revision integer,
  p_agreement_proposal_id uuid,
  p_agreement_sha256 text,
  p_decision_method text,
  p_held_on date,
  p_source_reported_outcome text,
  p_source_kind text,
  p_source_reference text,
  p_source_sha256 text,
  p_rule_summary text,
  p_eligibility_source text,
  p_eligible_count integer,
  p_ballots_cast integer,
  p_approve_count integer,
  p_reject_count integer,
  p_abstain_count integer,
  p_invalid_count integer,
  p_quorum_required_count integer,
  p_threshold_numerator integer,
  p_threshold_denominator integer,
  p_approval_comparator text,
  p_approval_denominator text,
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
  target record;
  campaign record;
  cycle record;
  proposal record;
  receipt record;
  ratification_id uuid;
  denominator_count bigint;
  computed_outcome text;
  next_phase text;
  next_campaign_stage text;
  campaign_revision integer;
  fingerprint text;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_agreement_sha text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_agreement_sha256, '')));
  normalized_source_reference text := pg_catalog.btrim(coalesce(p_source_reference, ''));
  normalized_source_sha text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_source_sha256, '')));
  normalized_rule_summary text := pg_catalog.btrim(coalesce(p_rule_summary, ''));
  normalized_eligibility_source text := pg_catalog.btrim(coalesce(p_eligibility_source, ''));
begin
  if caller is null
     or p_cycle_id is null
     or p_agreement_proposal_id is null
     or p_request_id is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;
  if p_expected_cycle_revision is null or p_expected_cycle_revision <= 0
     or p_expected_campaign_revision is null
     or p_expected_campaign_revision <= 0 then
    raise exception 'current revisions are required' using errcode = '22023';
  end if;
  if normalized_agreement_sha !~ '^[0-9a-f]{64}$'
     or normalized_source_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'evidence hashes must be lowercase SHA-256 values'
      using errcode = '22023';
  end if;
  if p_held_on is null or p_held_on > current_date then
    raise exception 'ratification date is invalid' using errcode = '22023';
  end if;
  if p_decision_method is null or p_decision_method not in ('vote', 'not_required')
     or p_source_kind is null
     or p_source_kind not in (
       'union_report',
       'independent_tally',
       'meeting_minutes',
       'written_rule',
       'other'
     ) then
    raise exception 'ratification source is invalid' using errcode = '22023';
  end if;
  if pg_catalog.char_length(normalized_source_reference) not between 3 and 1000
     or pg_catalog.char_length(normalized_rule_summary) not between 3 and 2000
     or pg_catalog.char_length(normalized_eligibility_source) not between 3 and 1000 then
    raise exception 'ratification source fields are invalid' using errcode = '22023';
  end if;

  if p_decision_method = 'vote' then
    if p_source_reported_outcome is null
       or p_source_reported_outcome not in ('approved', 'rejected', 'no_quorum')
       or p_eligible_count is null
       or p_eligible_count not between 1 and 10000000
       or p_ballots_cast is null
       or p_ballots_cast not between 0 and p_eligible_count
       or p_approve_count is null
       or p_approve_count < 0
       or p_reject_count is null
       or p_reject_count < 0
       or p_abstain_count is null
       or p_abstain_count < 0
       or p_invalid_count is null
       or p_invalid_count < 0
       or p_approve_count > p_ballots_cast
       or p_reject_count > p_ballots_cast
       or p_abstain_count > p_ballots_cast
       or p_invalid_count > p_ballots_cast
       or p_approve_count::bigint
          + p_reject_count::bigint
          + p_abstain_count::bigint
          + p_invalid_count::bigint
          <> p_ballots_cast::bigint
       or p_quorum_required_count is null
       or p_quorum_required_count not between 0 and p_eligible_count
       or p_threshold_numerator is null
       or p_threshold_denominator is null
       or p_threshold_numerator not between 1 and p_threshold_denominator
       or p_threshold_denominator not between 1 and 10000000
       or p_approval_comparator is null
       or p_approval_comparator not in ('at_least', 'more_than')
       or p_approval_denominator is null
       or p_approval_denominator not in (
         'eligible',
         'ballots_cast',
         'non_abstaining'
       ) then
      raise exception 'ratification aggregate or rule is invalid'
        using errcode = '22023';
    end if;

    denominator_count := case p_approval_denominator
      when 'eligible' then p_eligible_count
      when 'ballots_cast' then p_ballots_cast
      when 'non_abstaining' then p_approve_count + p_reject_count
    end;

    computed_outcome := case
      when p_ballots_cast < p_quorum_required_count then 'no_quorum'
      when denominator_count <= 0 then 'indeterminate'
      when p_approval_comparator = 'at_least'
       and p_approve_count::bigint * p_threshold_denominator::bigint
           >= denominator_count * p_threshold_numerator::bigint
        then 'approved'
      when p_approval_comparator = 'more_than'
       and p_approve_count::bigint * p_threshold_denominator::bigint
           > denominator_count * p_threshold_numerator::bigint
        then 'approved'
      else 'rejected'
    end;

    -- A mismatch never advances the campaign. Staff must reconcile the
    -- external source and the explicitly entered rule.
    if computed_outcome is distinct from p_source_reported_outcome then
      computed_outcome := 'indeterminate';
    end if;
  else
    if p_source_reported_outcome is distinct from 'not_required'
       or p_eligible_count is not null
       or p_ballots_cast is not null
       or p_approve_count is not null
       or p_reject_count is not null
       or p_abstain_count is not null
       or p_invalid_count is not null
       or p_quorum_required_count is not null
       or p_threshold_numerator is not null
       or p_threshold_denominator is not null
       or p_approval_comparator is not null
       or p_approval_denominator is not null then
      raise exception 'not-required record cannot contain a vote tally'
        using errcode = '22023';
    end if;
    computed_outcome := 'not_required';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.ratification.recorded',
    pg_catalog.jsonb_build_object(
      'cycleId', p_cycle_id,
      'expectedCycleRevision', p_expected_cycle_revision,
      'expectedCampaignRevision', p_expected_campaign_revision,
      'agreementProposalId', p_agreement_proposal_id,
      'agreementSha256', normalized_agreement_sha,
      'decisionMethod', p_decision_method,
      'heldOn', p_held_on,
      'sourceReportedOutcome', p_source_reported_outcome,
      'sourceKind', p_source_kind,
      'sourceReference', normalized_source_reference,
      'sourceSha256', normalized_source_sha,
      'ruleSummary', normalized_rule_summary,
      'eligibilitySource', normalized_eligibility_source,
      'eligibleCount', p_eligible_count,
      'ballotsCast', p_ballots_cast,
      'approveCount', p_approve_count,
      'rejectCount', p_reject_count,
      'abstainCount', p_abstain_count,
      'invalidCount', p_invalid_count,
      'quorumRequiredCount', p_quorum_required_count,
      'thresholdNumerator', p_threshold_numerator,
      'thresholdDenominator', p_threshold_denominator,
      'approvalComparator', p_approval_comparator,
      'approvalDenominator', p_approval_denominator
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select c.campaign_id, c.chapter_id
  into target
  from public.organizing_bargaining_cycles c
  where c.id = p_cycle_id;

  if not found then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = p_cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  select *
  into proposal
  from public.organizing_bargaining_proposals
  where id = p_agreement_proposal_id
    and cycle_id = cycle.id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for share;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       true
     ) is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.ratification.recorded'
       or receipt.campaign_id is distinct from campaign.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'campaignRevision', (receipt.safe_metadata ->> 'campaignRevision')::integer,
      'campaignStage', receipt.safe_metadata ->> 'campaignStage',
      'cycleId', cycle.id,
      'phase', receipt.safe_metadata ->> 'phase',
      'revision', receipt.result_revision,
      'ratificationId', receipt.entity_id,
      'outcome', receipt.to_state,
      'decisionMethod', receipt.safe_metadata ->> 'decisionMethod',
      'auditEventId', receipt.id
    );
  end if;

  if campaign.revision <> p_expected_campaign_revision
     or cycle.revision <> p_expected_cycle_revision then
    raise exception 'bargaining record changed; reload and try again'
      using errcode = '40001';
  end if;
  if campaign.status <> 'active'
     or campaign.stage <> 'bargaining'
     or cycle.phase not in ('tentative_agreement', 'ratification')
     or proposal.status <> 'tentative_agreement'
     or proposal.record_kind <> 'agreement_package'
     or proposal.document_sha256 is distinct from normalized_agreement_sha
     or cycle.bargaining_started_on is null
     or proposal.presented_on is null
     or p_held_on < cycle.bargaining_started_on
     or p_held_on < proposal.presented_on
     or exists (
       select 1
       from public.organizing_bargaining_proposals child
       where child.parent_proposal_id = proposal.id
     )
     or exists (
       select 1
       from pg_catalog.unnest(proposal.included_proposal_ids) included_id
       left join public.organizing_bargaining_proposals included
         on included.id = included_id
        and included.cycle_id = cycle.id
        and included.record_kind = 'article'
        where included.id is null
           or included.status <> 'accepted'
           or included.presented_on is null
           or included.presented_on > proposal.presented_on
           or included.presented_on > p_held_on
          or exists (
            select 1
            from public.organizing_bargaining_proposals child
            where child.parent_proposal_id = included.id
          )
     )
     or exists (
       select 1
       from public.organizing_bargaining_ratifications current_result
       where current_result.id = cycle.current_ratification_id
         and current_result.cycle_id = cycle.id
         and current_result.campaign_id = campaign.id
         and current_result.chapter_id = campaign.chapter_id
         and (
           current_result.execution_authorized
           or p_held_on < current_result.held_on
         )
     )
     or exists (
       select 1
       from public.organizing_bargaining_proposals current_article
       where current_article.cycle_id = cycle.id
         and current_article.campaign_id = campaign.id
         and current_article.chapter_id = campaign.chapter_id
         and current_article.record_kind = 'article'
         and current_article.status = 'accepted'
         and not exists (
           select 1
           from public.organizing_bargaining_proposals child
           where child.parent_proposal_id = current_article.id
         )
         and not (
           current_article.id = any(proposal.included_proposal_ids)
          )
      )
     or exists (
       select 1
       from public.organizing_bargaining_proposals unresolved_article
       where unresolved_article.cycle_id = cycle.id
         and unresolved_article.campaign_id = campaign.id
         and unresolved_article.chapter_id = campaign.chapter_id
         and unresolved_article.record_kind = 'article'
         and unresolved_article.status not in (
           'accepted',
           'rejected',
           'withdrawn',
           'superseded'
         )
         and not exists (
           select 1
           from public.organizing_bargaining_proposals child
           where child.parent_proposal_id = unresolved_article.id
         )
     )
     or cycle.ratification_integrity_hold then
    raise exception 'ratification record is not eligible' using errcode = '22023';
  end if;

  insert into public.organizing_bargaining_ratifications (
    cycle_id,
    campaign_id,
    chapter_id,
    supersedes_ratification_id,
    agreement_proposal_id,
    agreement_sha256,
    decision_method,
    held_on,
    source_reported_outcome,
    computed_outcome,
    source_kind,
    source_reference,
    source_sha256,
    rule_summary,
    eligibility_source,
    eligible_count,
    ballots_cast,
    approve_count,
    reject_count,
    abstain_count,
    invalid_count,
    quorum_required_count,
    threshold_numerator,
    threshold_denominator,
    approval_comparator,
    approval_denominator,
    recorded_by,
    create_request_id,
    created_at
  ) values (
    cycle.id,
    campaign.id,
    campaign.chapter_id,
    cycle.current_ratification_id,
    proposal.id,
    normalized_agreement_sha,
    p_decision_method,
    p_held_on,
    p_source_reported_outcome,
    computed_outcome,
    p_source_kind,
    normalized_source_reference,
    normalized_source_sha,
    normalized_rule_summary,
    normalized_eligibility_source,
    p_eligible_count,
    p_ballots_cast,
    p_approve_count,
    p_reject_count,
    p_abstain_count,
    p_invalid_count,
    p_quorum_required_count,
    p_threshold_numerator,
    p_threshold_denominator,
    p_approval_comparator,
    p_approval_denominator,
    caller,
    p_request_id,
    event_time
  ) returning id into ratification_id;

  next_phase := case
    when computed_outcome in ('approved', 'not_required') then 'execution'
    when computed_outcome = 'rejected' then 'at_table'
    when computed_outcome = 'no_quorum' then 'ratification'
    else 'ratification'
  end;

  update public.organizing_bargaining_cycles
  set phase = next_phase,
      current_ratification_id = ratification_id,
      ratification_integrity_hold = false,
      revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  campaign_revision := campaign.revision;
  next_campaign_stage := campaign.stage;
  if computed_outcome in ('approved', 'not_required') then
    update public.organizing_campaigns
    set stage = 'first_contract',
        stage_started_at = event_time,
        revision = campaign.revision + 1,
        updated_at = event_time
    where id = campaign.id;

    insert into public.organizing_stage_events (
      campaign_id,
      chapter_id,
      from_stage,
      to_stage,
      actor_id,
      source_kind,
      note,
      occurred_at
    ) values (
      campaign.id,
      campaign.chapter_id,
      campaign.stage,
      'first_contract',
      caller,
      'document_verified',
      'Staff-recorded sourced ratification authorization recorded',
      event_time
    );

    campaign_revision := campaign.revision + 1;
    next_campaign_stage := 'first_contract';
  end if;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.ratification.recorded',
    'bargaining_ratification',
    ratification_id,
    null,
    computed_outcome,
    pg_catalog.jsonb_build_object(
      'campaignRevision',
      campaign_revision,
      'campaignStage',
      next_campaign_stage,
      'cycleRevision',
      cycle.revision + 1,
      'phase',
      next_phase,
      'decisionMethod',
      p_decision_method
    ),
    p_request_id,
    fingerprint,
    cycle.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'campaignRevision', campaign_revision,
    'campaignStage', next_campaign_stage,
    'cycleId', cycle.id,
    'phase', next_phase,
    'revision', cycle.revision + 1,
    'ratificationId', ratification_id,
    'outcome', computed_outcome,
    'decisionMethod', p_decision_method,
    'auditEventId', audit_id
  );
end;
end;
$$;

create function public.correct_organizing_ratification(
  p_ratification_id uuid,
  p_expected_cycle_revision integer,
  p_expected_campaign_revision integer,
  p_reason_code text,
  p_source_kind text,
  p_source_reference text,
  p_source_sha256 text,
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
  target record;
  campaign record;
  cycle record;
  ratification record;
  receipt record;
  correction_id uuid;
  campaign_revision integer;
  contract_exists boolean := false;
  next_phase text;
  next_campaign_stage text;
  agreement_proposal_status text;
  agreement_proposal_revision integer;
  restored_ratification_id uuid;
  restored_ratification_outcome text;
  fingerprint text;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_source_reference text := pg_catalog.btrim(
    coalesce(p_source_reference, '')
  );
  normalized_source_sha text := pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_source_sha256, ''))
  );
begin
  if caller is null
     or p_ratification_id is null
     or p_request_id is null then
    raise exception 'ratification record not found' using errcode = '22023';
  end if;
  if p_expected_cycle_revision is null
     or p_expected_cycle_revision <= 0
     or p_expected_campaign_revision is null
     or p_expected_campaign_revision <= 0 then
    raise exception 'current revisions are required' using errcode = '22023';
  end if;
  if p_reason_code is null
     or p_reason_code not in (
       'source_error',
       'tally_error',
       'rule_error',
       'wrong_agreement',
       'duplicate_record',
       'other'
     )
     or p_source_kind is null
     or p_source_kind not in (
       'union_report',
       'independent_tally',
       'meeting_minutes',
       'written_rule',
       'official_record',
       'other'
     )
     or pg_catalog.char_length(normalized_source_reference) not between 3 and 1000
     or normalized_source_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'correction source is invalid' using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.ratification.corrected',
    pg_catalog.jsonb_build_object(
      'ratificationId', p_ratification_id,
      'expectedCycleRevision', p_expected_cycle_revision,
      'expectedCampaignRevision', p_expected_campaign_revision,
      'reasonCode', p_reason_code,
      'sourceKind', p_source_kind,
      'sourceReference', normalized_source_reference,
      'sourceSha256', normalized_source_sha
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:mfa-reset:' || caller::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:'
        || caller::text
        || ':'
        || p_request_id::text,
      0
    )
  );

  select
    r.cycle_id,
    r.campaign_id,
    r.chapter_id
  into target
  from public.organizing_bargaining_ratifications r
  where r.id = p_ratification_id;

  if not found then
    raise exception 'ratification record not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = target.cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  select *
  into ratification
  from public.organizing_bargaining_ratifications
  where id = p_ratification_id
    and cycle_id = cycle.id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for share;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       true
     ) is null then
    raise exception 'ratification record not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.ratification.corrected'
       or receipt.campaign_id is distinct from campaign.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'campaignRevision',
        (receipt.safe_metadata ->> 'campaignRevision')::integer,
      'campaignStage', receipt.safe_metadata ->> 'campaignStage',
      'cycleId', cycle.id,
      'phase', receipt.safe_metadata ->> 'phase',
      'revision', receipt.result_revision,
      'ratificationId',
        (receipt.safe_metadata ->> 'ratificationId')::uuid,
      'correctionId', receipt.entity_id,
      'corrected', true,
      'reasonCode', receipt.safe_metadata ->> 'reasonCode',
      'restoredRatificationId',
        (receipt.safe_metadata ->> 'restoredRatificationId')::uuid,
      'integrityHold',
        (receipt.safe_metadata ->> 'integrityHold')::boolean,
      'auditEventId', receipt.id
    );
  end if;

  contract_exists := exists (
    select 1
    from public.organizing_first_contracts contract
    where contract.cycle_id = cycle.id
      and contract.campaign_id = campaign.id
      and contract.chapter_id = campaign.chapter_id
      and contract.ratification_id = ratification.id
  );

  if campaign.revision <> p_expected_campaign_revision
     or cycle.revision <> p_expected_cycle_revision then
    raise exception 'bargaining record changed; reload and try again'
      using errcode = '40001';
  end if;
  if not (
       (
         campaign.status = 'active'
         and campaign.stage in ('bargaining', 'first_contract')
       )
       or (
         campaign.status = 'closed'
         and campaign.stage = 'established'
         and campaign.outcome = 'established'
       )
     )
     or cycle.phase not in ('at_table', 'ratification', 'execution', 'complete')
     or cycle.current_ratification_id is distinct from ratification.id
     or exists (
       select 1
       from public.organizing_bargaining_ratification_corrections prior
       where prior.ratification_id = ratification.id
     )
     or (
       ratification.execution_authorized
       and (
         (
           not contract_exists
           and (
             campaign.stage <> 'first_contract'
             or cycle.phase <> 'execution'
           )
         )
         or (
           contract_exists
           and cycle.phase <> 'complete'
         )
       )
     ) then
    raise exception 'ratification correction is not eligible'
      using errcode = '22023';
  end if;

  set constraints public.organizing_bargaining_corrections_detach_current deferred;

  insert into public.organizing_bargaining_ratification_corrections (
    ratification_id,
    cycle_id,
    campaign_id,
    chapter_id,
    reason_code,
    source_kind,
    source_reference,
    source_sha256,
    corrected_by,
    create_request_id,
    created_at
  ) values (
    ratification.id,
    cycle.id,
    campaign.id,
    campaign.chapter_id,
    p_reason_code,
    p_source_kind,
    normalized_source_reference,
    normalized_source_sha,
    caller,
    p_request_id,
    event_time
  ) returning id into correction_id;

  campaign_revision := campaign.revision;
  if contract_exists then
    next_phase := cycle.phase;
    next_campaign_stage := campaign.stage;
    update public.organizing_bargaining_cycles
    set current_ratification_id = null,
        ratification_integrity_hold = true,
        revision = cycle.revision + 1,
        updated_at = event_time
    where id = cycle.id;
  else
    if p_reason_code = 'duplicate_record'
       and ratification.supersedes_ratification_id is not null then
      select prior.id, prior.computed_outcome
      into restored_ratification_id, restored_ratification_outcome
      from public.organizing_bargaining_ratifications prior
      join public.organizing_bargaining_proposals prior_proposal
        on prior_proposal.id = prior.agreement_proposal_id
       and prior_proposal.cycle_id = prior.cycle_id
       and prior_proposal.campaign_id = prior.campaign_id
       and prior_proposal.chapter_id = prior.chapter_id
       and prior_proposal.document_sha256 = prior.agreement_sha256
      where prior.id = ratification.supersedes_ratification_id
        and prior.cycle_id = cycle.id
        and prior.campaign_id = campaign.id
        and prior.chapter_id = campaign.chapter_id
        and not prior.execution_authorized
        and prior.agreement_proposal_id = ratification.agreement_proposal_id
        and prior.agreement_sha256 = ratification.agreement_sha256
        and prior_proposal.status = 'tentative_agreement'
        and not exists (
          select 1
          from public.organizing_bargaining_proposals child
          where child.parent_proposal_id = prior_proposal.id
        )
        and not exists (
          select 1
          from public.organizing_bargaining_ratification_corrections correction
          where correction.ratification_id = prior.id
        )
      for share;
    end if;

    next_phase := case
      when p_reason_code = 'wrong_agreement' then 'at_table'
      when p_reason_code = 'duplicate_record'
        and restored_ratification_id is not null
        and restored_ratification_outcome = 'rejected' then 'at_table'
      when p_reason_code = 'duplicate_record'
        and restored_ratification_id is not null then 'ratification'
      when ratification.execution_authorized then 'ratification'
      else cycle.phase
    end;
    next_campaign_stage := 'bargaining';
    if p_reason_code = 'wrong_agreement' then
      update public.organizing_bargaining_proposals
      set status = 'withdrawn',
          revision = revision + 1,
          updated_at = event_time
      where id = ratification.agreement_proposal_id
        and cycle_id = cycle.id
        and campaign_id = campaign.id
        and chapter_id = campaign.chapter_id
        and status = 'tentative_agreement'
      returning status, revision
      into agreement_proposal_status, agreement_proposal_revision;

      if not found then
        select proposal.status, proposal.revision
        into agreement_proposal_status, agreement_proposal_revision
        from public.organizing_bargaining_proposals proposal
        where proposal.id = ratification.agreement_proposal_id
          and proposal.cycle_id = cycle.id
          and proposal.campaign_id = campaign.id
          and proposal.chapter_id = campaign.chapter_id;
      end if;
    end if;
    update public.organizing_bargaining_cycles
    set phase = next_phase,
        current_ratification_id = case
          when p_reason_code = 'duplicate_record'
            then restored_ratification_id
          else null
        end,
        ratification_integrity_hold = false,
        revision = cycle.revision + 1,
        updated_at = event_time
    where id = cycle.id;

    if campaign.stage = 'first_contract' then
      update public.organizing_campaigns
      set stage = next_campaign_stage,
          stage_started_at = event_time,
          revision = campaign.revision + 1,
          updated_at = event_time
      where id = campaign.id;

      insert into public.organizing_stage_events (
        campaign_id,
        chapter_id,
        from_stage,
        to_stage,
        actor_id,
        source_kind,
        note,
        occurred_at
      ) values (
        campaign.id,
        campaign.chapter_id,
        campaign.stage,
        next_campaign_stage,
        caller,
        'document_verified',
        'Prior sourced ratification authorization corrected before execution',
        event_time
      );

      campaign_revision := campaign.revision + 1;
    end if;
  end if;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.ratification.corrected',
    'bargaining_ratification_correction',
    correction_id,
    ratification.computed_outcome,
    'corrected',
    pg_catalog.jsonb_build_object(
      'campaignRevision', campaign_revision,
      'campaignStage', next_campaign_stage,
      'cycleRevision', cycle.revision + 1,
      'phase', next_phase,
      'ratificationId', ratification.id,
      'reasonCode', p_reason_code,
      'agreementProposalId', ratification.agreement_proposal_id,
      'agreementProposalStatus', agreement_proposal_status,
      'agreementProposalRevision', agreement_proposal_revision,
      'restoredRatificationId', restored_ratification_id,
      'integrityHold', contract_exists
    ),
    p_request_id,
    fingerprint,
    cycle.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'campaignRevision', campaign_revision,
    'campaignStage', next_campaign_stage,
    'cycleId', cycle.id,
    'phase', next_phase,
    'revision', cycle.revision + 1,
    'ratificationId', ratification.id,
    'correctionId', correction_id,
    'corrected', true,
    'reasonCode', p_reason_code,
    'restoredRatificationId', restored_ratification_id,
    'integrityHold', contract_exists,
    'auditEventId', audit_id
  );
end;
end;
$$;

create function public.record_organizing_first_contract(
  p_cycle_id uuid,
  p_expected_cycle_revision integer,
  p_expected_campaign_revision integer,
  p_ratification_id uuid,
  p_agreement_sha256 text,
  p_signed_on date,
  p_request_id uuid,
  p_source_kind text,
  p_source_reference text,
  p_source_sha256 text,
  p_expected_signatory_count integer,
  p_verified_signatory_count integer,
  p_effective_on date default null,
  p_expires_on date default null
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
  target record;
  campaign record;
  cycle record;
  ratification record;
  receipt record;
  contract_id uuid;
  fingerprint text;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_agreement_sha text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_agreement_sha256, '')));
  normalized_source_reference text := pg_catalog.btrim(coalesce(p_source_reference, ''));
  normalized_source_sha text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_source_sha256, '')));
begin
  if caller is null
     or p_cycle_id is null
     or p_ratification_id is null
     or p_request_id is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;
  if p_expected_cycle_revision is null or p_expected_cycle_revision <= 0
     or p_expected_campaign_revision is null
     or p_expected_campaign_revision <= 0 then
    raise exception 'current revisions are required' using errcode = '22023';
  end if;
  if normalized_agreement_sha !~ '^[0-9a-f]{64}$'
     or normalized_source_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'evidence hashes must be lowercase SHA-256 values'
      using errcode = '22023';
  end if;
  if p_signed_on is null or p_signed_on > current_date then
    raise exception 'signature date is invalid' using errcode = '22023';
  end if;
  if p_expires_on is not null
     and (
       p_expires_on < p_signed_on
       or (
         p_effective_on is not null
         and p_expires_on < p_effective_on
       )
     ) then
    raise exception 'expiration cannot precede signature or effective date'
      using errcode = '22023';
  end if;
  if p_source_kind is null
     or p_source_kind not in (
       'executed_contract',
       'signed_memorandum',
       'official_record',
       'other'
     )
     or pg_catalog.char_length(normalized_source_reference) not between 3 and 1000 then
    raise exception 'contract source is invalid' using errcode = '22023';
  end if;
  if p_expected_signatory_count is null
     or p_expected_signatory_count not between 1 and 1000
     or p_verified_signatory_count is null
     or p_verified_signatory_count <> p_expected_signatory_count then
    raise exception 'the source must record every expected signatory'
      using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.first_contract.recorded',
    pg_catalog.jsonb_build_object(
      'cycleId', p_cycle_id,
      'expectedCycleRevision', p_expected_cycle_revision,
      'expectedCampaignRevision', p_expected_campaign_revision,
      'ratificationId', p_ratification_id,
      'agreementSha256', normalized_agreement_sha,
      'signedOn', p_signed_on,
      'sourceKind', p_source_kind,
      'sourceReference', normalized_source_reference,
      'sourceSha256', normalized_source_sha,
      'expectedSignatoryCount', p_expected_signatory_count,
      'verifiedSignatoryCount', p_verified_signatory_count,
      'effectiveOn', p_effective_on,
      'expiresOn', p_expires_on
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select c.campaign_id, c.chapter_id
  into target
  from public.organizing_bargaining_cycles c
  where c.id = p_cycle_id;

  if not found then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = p_cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  select *
  into ratification
  from public.organizing_bargaining_ratifications
  where id = p_ratification_id
    and cycle_id = cycle.id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for share;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       true
     ) is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.first_contract.recorded'
       or receipt.campaign_id is distinct from campaign.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'campaignRevision', (receipt.safe_metadata ->> 'campaignRevision')::integer,
      'cycleId', cycle.id,
      'phase', receipt.to_state,
      'revision', receipt.result_revision,
      'contractId', receipt.entity_id,
      'status', receipt.safe_metadata ->> 'status',
      'signedOn', receipt.safe_metadata ->> 'signedOn',
      'auditEventId', receipt.id
    );
  end if;

  if campaign.revision <> p_expected_campaign_revision
     or cycle.revision <> p_expected_cycle_revision then
    raise exception 'bargaining record changed; reload and try again'
      using errcode = '40001';
  end if;
  if campaign.status <> 'active'
     or campaign.stage <> 'first_contract'
     or cycle.phase <> 'execution'
     or cycle.current_ratification_id is distinct from ratification.id
     or cycle.ratification_integrity_hold
     or not ratification.execution_authorized
     or exists (
       select 1
       from public.organizing_bargaining_ratification_corrections correction
       where correction.ratification_id = ratification.id
     )
     or ratification.agreement_sha256 is distinct from normalized_agreement_sha
     or p_signed_on < ratification.held_on
     or exists (
       select 1
       from public.organizing_first_contracts prior
       where prior.cycle_id = cycle.id
     )
     or exists (
       select 1
       from public.organizing_bargaining_sessions pending_session
       where pending_session.cycle_id = cycle.id
         and pending_session.campaign_id = campaign.id
         and pending_session.chapter_id = campaign.chapter_id
         and pending_session.status = 'scheduled'
     ) then
    raise exception 'first-contract record is not eligible'
      using errcode = '22023';
  end if;

  insert into public.organizing_first_contracts (
    cycle_id,
    campaign_id,
    chapter_id,
    ratification_id,
    agreement_proposal_id,
    agreement_sha256,
    ratification_authorized,
    verification_status,
    signed_on,
    effective_on,
    expires_on,
    source_kind,
    source_reference,
    source_sha256,
    expected_signatory_count,
    verified_signatory_count,
    recorded_by,
    create_request_id,
    created_at
  ) values (
    cycle.id,
    campaign.id,
    campaign.chapter_id,
    ratification.id,
    ratification.agreement_proposal_id,
    normalized_agreement_sha,
    true,
    'source_recorded_fully_signed',
    p_signed_on,
    p_effective_on,
    p_expires_on,
    p_source_kind,
    normalized_source_reference,
    normalized_source_sha,
    p_expected_signatory_count,
    p_verified_signatory_count,
    caller,
    p_request_id,
    event_time
  ) returning id into contract_id;

  update public.organizing_bargaining_cycles
  set phase = 'complete',
      first_contract_signed_on = p_signed_on,
      revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.first_contract.recorded',
    'first_contract',
    contract_id,
    cycle.phase,
    'complete',
    pg_catalog.jsonb_build_object(
      'campaignRevision',
      campaign.revision,
      'status',
      'source_recorded_fully_signed',
      'signedOn',
      p_signed_on
    ),
    p_request_id,
    fingerprint,
    cycle.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'campaignRevision', campaign.revision,
    'cycleId', cycle.id,
    'phase', 'complete',
    'revision', cycle.revision + 1,
    'contractId', contract_id,
    'status', 'source_recorded_fully_signed',
    'signedOn', p_signed_on,
    'auditEventId', audit_id
  );
end;
end;
$$;


create function public.record_organizing_bargaining_session_outcome(
  p_session_id uuid,
  p_expected_revision integer,
  p_expected_cycle_revision integer,
  p_status text,
  p_request_id uuid,
  p_ends_at timestamptz default null,
  p_member_update text default null,
  p_internal_minutes text default null,
  p_reason text default null
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
  target record;
  campaign record;
  cycle record;
  session_row record;
  receipt record;
  fingerprint text;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_member_update text := nullif(pg_catalog.btrim(coalesce(p_member_update, '')), '');
  normalized_internal_minutes text := nullif(pg_catalog.btrim(coalesce(p_internal_minutes, '')), '');
  normalized_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
begin
  if caller is null or p_session_id is null or p_request_id is null then
    raise exception 'bargaining session not found' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision <= 0
     or p_expected_cycle_revision is null
     or p_expected_cycle_revision <= 0 then
    raise exception 'current revisions are required' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('held', 'cancelled') then
    raise exception 'unknown session outcome' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(normalized_member_update, '')) > 2000
     or pg_catalog.char_length(coalesce(normalized_internal_minutes, '')) > 20000
     or pg_catalog.char_length(coalesce(normalized_reason, '')) > 2000 then
    raise exception 'session outcome fields are invalid' using errcode = '22023';
  end if;
  if p_status = 'held'
     and (p_ends_at is null or normalized_member_update is null) then
    raise exception 'held session requires an end time and member-safe update'
      using errcode = '22023';
  end if;
  if p_status = 'cancelled'
     and (
       normalized_reason is null
       or p_ends_at is not null
     ) then
    raise exception 'cancelled session fields are invalid'
      using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.session.outcome_recorded',
    pg_catalog.jsonb_build_object(
      'sessionId', p_session_id,
      'expectedRevision', p_expected_revision,
      'expectedCycleRevision', p_expected_cycle_revision,
      'status', p_status,
      'endsAt', private.bargaining_canonical_instant(p_ends_at),
      'memberUpdate', normalized_member_update,
      'internalMinutes', normalized_internal_minutes,
      'reason', normalized_reason
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select s.cycle_id, s.campaign_id, s.chapter_id
  into target
  from public.organizing_bargaining_sessions s
  where s.id = p_session_id;

  if not found then
    raise exception 'bargaining session not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = target.cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  select *
  into session_row
  from public.organizing_bargaining_sessions
  where id = p_session_id
    and cycle_id = cycle.id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       false
     ) is null then
    raise exception 'bargaining session not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.session.outcome_recorded'
       or receipt.entity_id <> session_row.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'cycleId', cycle.id,
      'cycleRevision', (receipt.safe_metadata ->> 'cycleRevision')::integer,
      'sessionId', session_row.id,
      'status', receipt.to_state,
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if cycle.revision <> p_expected_cycle_revision
     or session_row.revision <> p_expected_revision then
    raise exception 'bargaining session changed; reload and try again'
      using errcode = '40001';
  end if;
  if campaign.status <> 'active'
     or cycle.phase = 'complete'
     or session_row.status <> 'scheduled' then
    raise exception 'bargaining session is not editable' using errcode = '22023';
  end if;
  if p_status = 'held'
     and (
       cycle.bargaining_started_on is null
       or cycle.phase in ('preparing', 'proposal_development')
       or session_row.starts_at
          < (cycle.bargaining_started_on::timestamp at time zone 'UTC')
     ) then
    raise exception 'a held session requires a verified bargaining start'
      using errcode = '22023';
  end if;
  if p_ends_at is not null and p_ends_at < session_row.starts_at then
    raise exception 'session end cannot precede its start' using errcode = '22023';
  end if;
  if p_status = 'held'
     and (
       session_row.starts_at > event_time
       or p_ends_at > event_time
     ) then
    raise exception 'a held session cannot be recorded before it ends'
      using errcode = '22023';
  end if;

  update public.organizing_bargaining_sessions
  set status = p_status,
      ends_at = case when p_status = 'held' then p_ends_at else null end,
      member_update = case
        when p_status = 'held' then normalized_member_update
        else ''
      end,
      internal_minutes = normalized_internal_minutes,
      outcome_reason = normalized_reason,
      revision = session_row.revision + 1,
      updated_at = event_time
  where id = session_row.id;

  update public.organizing_bargaining_cycles
  set revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.session.outcome_recorded',
    'bargaining_session',
    session_row.id,
    session_row.status,
    p_status,
    pg_catalog.jsonb_build_object(
      'cycleRevision',
      cycle.revision + 1
    ),
    p_request_id,
    fingerprint,
    session_row.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'cycleId', cycle.id,
    'cycleRevision', cycle.revision + 1,
    'sessionId', session_row.id,
    'status', p_status,
    'revision', session_row.revision + 1,
    'auditEventId', audit_id
  );
end;
end;
$$;


-- 5. Immutable proposal-version commands -----------------------------------

create function public.create_organizing_bargaining_proposal(
  p_cycle_id uuid,
  p_expected_cycle_revision integer,
  p_topic text,
  p_title text,
  p_side text,
  p_request_id uuid,
  p_record_kind text default 'article',
  p_included_proposal_ids uuid[] default '{}'::uuid[],
  p_document_sha256 text default null,
  p_parent_proposal_id uuid default null,
  p_parent_expected_revision integer default null,
  p_relation_kind text default null,
  p_member_summary text default null,
  p_internal_notes text default null
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
  target record;
  campaign record;
  cycle record;
  parent record;
  receipt record;
  proposal_id uuid;
  proposal_version integer := 1;
  fingerprint text;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_topic text := pg_catalog.btrim(coalesce(p_topic, ''));
  normalized_title text := pg_catalog.btrim(coalesce(p_title, ''));
  normalized_member_summary text := nullif(pg_catalog.btrim(coalesce(p_member_summary, '')), '');
  normalized_internal_notes text := nullif(pg_catalog.btrim(coalesce(p_internal_notes, '')), '');
  normalized_included_ids uuid[] := coalesce(p_included_proposal_ids, '{}'::uuid[]);
  normalized_document_sha text := nullif(
    pg_catalog.lower(pg_catalog.btrim(coalesce(p_document_sha256, ''))),
    ''
  );
begin
  if caller is null or p_cycle_id is null or p_request_id is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;
  if p_expected_cycle_revision is null or p_expected_cycle_revision <= 0 then
    raise exception 'cycle revision is required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(normalized_topic) not between 1 and 120
     or pg_catalog.char_length(normalized_title) not between 3 and 200
     or pg_catalog.char_length(coalesce(normalized_member_summary, '')) > 2000
     or pg_catalog.char_length(coalesce(normalized_internal_notes, '')) > 12000 then
    raise exception 'proposal fields are invalid' using errcode = '22023';
  end if;
  if p_side is null or p_side not in ('union', 'employer', 'joint') then
    raise exception 'proposal side is invalid' using errcode = '22023';
  end if;
  if p_record_kind is null or p_record_kind not in ('article', 'agreement_package')
     or pg_catalog.array_position(normalized_included_ids, null) is not null
     or (
       select pg_catalog.count(*) <> pg_catalog.count(distinct item)
       from pg_catalog.unnest(normalized_included_ids) item
     )
     or (
       p_record_kind = 'article'
       and (
         pg_catalog.cardinality(normalized_included_ids) <> 0
         or normalized_document_sha is not null
       )
     )
     or (
       p_record_kind = 'agreement_package'
       and (
         pg_catalog.cardinality(normalized_included_ids) = 0
         or normalized_document_sha is null
         or normalized_document_sha !~ '^[0-9a-f]{64}$'
       )
     ) then
    raise exception 'proposal record shape is invalid' using errcode = '22023';
  end if;
  if (
    p_parent_proposal_id is null
    and (
      p_parent_expected_revision is not null
      or p_relation_kind is not null
    )
  ) or (
    p_parent_proposal_id is not null
    and (
      p_parent_expected_revision is null
      or p_parent_expected_revision <= 0
      or p_relation_kind is null
      or p_relation_kind not in ('revision', 'counter', 'replacement')
    )
  ) then
    raise exception 'proposal lineage is invalid' using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.proposal.created',
    pg_catalog.jsonb_build_object(
      'cycleId', p_cycle_id,
      'expectedCycleRevision', p_expected_cycle_revision,
      'topic', normalized_topic,
      'title', normalized_title,
      'side', p_side,
      'recordKind', p_record_kind,
      'includedProposalIds', normalized_included_ids,
      'documentSha256', normalized_document_sha,
      'parentProposalId', p_parent_proposal_id,
      'parentExpectedRevision', p_parent_expected_revision,
      'relationKind', p_relation_kind,
      'memberSummary', normalized_member_summary,
      'internalNotes', normalized_internal_notes
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select c.campaign_id, c.chapter_id
  into target
  from public.organizing_bargaining_cycles c
  where c.id = p_cycle_id;

  if not found then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = p_cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  if private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       false
     ) is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  if p_parent_proposal_id is not null then
    select *
    into parent
    from public.organizing_bargaining_proposals
    where id = p_parent_proposal_id
      and cycle_id = cycle.id
      and campaign_id = campaign.id
      and chapter_id = campaign.chapter_id
    for update;

    if not found then
      raise exception 'bargaining cycle not found' using errcode = '22023';
    end if;
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.proposal.created'
       or receipt.campaign_id is distinct from campaign.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'cycleId', cycle.id,
      'cycleRevision', (receipt.safe_metadata ->> 'cycleRevision')::integer,
      'proposalId', receipt.entity_id,
      'recordKind', receipt.safe_metadata ->> 'recordKind',
      'version', (receipt.safe_metadata ->> 'version')::integer,
      'status', receipt.to_state,
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if cycle.revision <> p_expected_cycle_revision then
    raise exception 'bargaining cycle changed; reload and try again'
      using errcode = '40001';
  end if;
  if campaign.status <> 'active'
     or cycle.phase in ('ratification', 'execution', 'complete') then
    raise exception 'bargaining cycle is not editable' using errcode = '22023';
  end if;

  if p_record_kind = 'agreement_package'
     and (
       (
         select pg_catalog.count(*) <> pg_catalog.cardinality(normalized_included_ids)
         from public.organizing_bargaining_proposals included
         where included.id = any(normalized_included_ids)
           and included.cycle_id = cycle.id
           and included.campaign_id = campaign.id
           and included.chapter_id = campaign.chapter_id
           and included.record_kind = 'article'
           and included.status = 'accepted'
           and not exists (
             select 1
             from public.organizing_bargaining_proposals child
             where child.parent_proposal_id = included.id
           )
          )
       or exists (
         select 1
         from public.organizing_bargaining_proposals current_article
         where current_article.cycle_id = cycle.id
           and current_article.campaign_id = campaign.id
           and current_article.chapter_id = campaign.chapter_id
           and current_article.record_kind = 'article'
           and current_article.status = 'accepted'
           and not exists (
             select 1
             from public.organizing_bargaining_proposals child
             where child.parent_proposal_id = current_article.id
           )
           and not (current_article.id = any(normalized_included_ids))
       )
       or exists (
         select 1
         from public.organizing_bargaining_proposals unresolved_article
         where unresolved_article.cycle_id = cycle.id
           and unresolved_article.campaign_id = campaign.id
           and unresolved_article.chapter_id = campaign.chapter_id
           and unresolved_article.record_kind = 'article'
           and unresolved_article.status not in (
             'accepted',
             'rejected',
             'withdrawn',
             'superseded'
           )
           and not exists (
             select 1
             from public.organizing_bargaining_proposals child
             where child.parent_proposal_id = unresolved_article.id
           )
       )
     ) then
    raise exception 'agreement package contains an ineligible proposal version'
      using errcode = '22023';
  end if;

  if p_parent_proposal_id is not null then
    if parent.revision <> p_parent_expected_revision then
      raise exception 'proposal changed; reload and try again' using errcode = '40001';
    end if;
    if parent.status in ('rejected', 'withdrawn', 'superseded')
       or (
         parent.status = 'accepted'
         and not (
           parent.record_kind = 'article'
           and p_relation_kind = 'replacement'
           and cycle.phase in (
             'at_table',
             'mediation',
             'fact_finding',
             'impasse'
           )
         )
       )
       or parent.record_kind <> p_record_kind
       or exists (
         select 1
         from public.organizing_bargaining_proposals child
         where child.parent_proposal_id = parent.id
       ) then
      raise exception 'proposal lineage is closed' using errcode = '22023';
    end if;
    proposal_version := parent.version + 1;
  end if;

  insert into public.organizing_bargaining_proposals (
    cycle_id,
    campaign_id,
    chapter_id,
    parent_proposal_id,
    relation_kind,
    record_kind,
    included_proposal_ids,
    document_sha256,
    topic,
    title,
    side,
    status,
    version,
    revision,
    member_summary,
    internal_notes,
    create_request_id,
    created_by,
    created_at,
    updated_at
  ) values (
    cycle.id,
    campaign.id,
    campaign.chapter_id,
    p_parent_proposal_id,
    p_relation_kind,
    p_record_kind,
    normalized_included_ids,
    normalized_document_sha,
    normalized_topic,
    normalized_title,
    p_side,
    'draft',
    proposal_version,
    1,
    normalized_member_summary,
    normalized_internal_notes,
    p_request_id,
    caller,
    event_time,
    event_time
  ) returning id into proposal_id;

  if p_parent_proposal_id is not null then
    update public.organizing_bargaining_proposals
    set status = 'superseded',
        revision = parent.revision + 1,
        updated_at = event_time
    where id = parent.id;
  end if;

  update public.organizing_bargaining_cycles
  set revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.proposal.created',
    'bargaining_proposal',
    proposal_id,
    'draft',
    pg_catalog.jsonb_build_object(
      'cycleRevision',
      cycle.revision + 1,
      'recordKind',
      p_record_kind,
      'version',
      proposal_version
    ),
    p_request_id,
    fingerprint,
    1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'cycleId', cycle.id,
    'cycleRevision', cycle.revision + 1,
    'proposalId', proposal_id,
    'recordKind', p_record_kind,
    'version', proposal_version,
    'status', 'draft',
    'revision', 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

create function public.transition_organizing_bargaining_proposal(
  p_proposal_id uuid,
  p_expected_revision integer,
  p_expected_cycle_revision integer,
  p_next_status text,
  p_request_id uuid,
  p_presented_on date default null,
  p_reason text default null
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
  target record;
  campaign record;
  cycle record;
  proposal record;
  receipt record;
  fingerprint text;
  allowed boolean;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
begin
  if caller is null or p_proposal_id is null or p_request_id is null then
    raise exception 'proposal not found' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision <= 0
     or p_expected_cycle_revision is null
     or p_expected_cycle_revision <= 0 then
    raise exception 'current revisions are required' using errcode = '22023';
  end if;
  if p_next_status is null or p_next_status not in (
    'approved',
    'presented',
    'countered',
    'tentative_agreement',
    'accepted',
    'rejected',
    'withdrawn'
  ) then
    raise exception 'unknown proposal status' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(normalized_reason, '')) > 2000 then
    raise exception 'proposal reason is too long' using errcode = '22023';
  end if;
  if p_presented_on is not null and p_presented_on > current_date then
    raise exception 'presentation date cannot be in the future' using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.proposal.transitioned',
    pg_catalog.jsonb_build_object(
      'proposalId', p_proposal_id,
      'expectedRevision', p_expected_revision,
      'expectedCycleRevision', p_expected_cycle_revision,
      'nextStatus', p_next_status,
      'presentedOn', p_presented_on,
      'reason', normalized_reason
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select p.cycle_id, p.campaign_id, p.chapter_id
  into target
  from public.organizing_bargaining_proposals p
  where p.id = p_proposal_id;

  if not found then
    raise exception 'proposal not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = target.cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  select *
  into proposal
  from public.organizing_bargaining_proposals
  where id = p_proposal_id
    and cycle_id = cycle.id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       false
     ) is null then
    raise exception 'proposal not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.proposal.transitioned'
       or receipt.entity_id <> proposal.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'cycleId', cycle.id,
      'cycleRevision', (receipt.safe_metadata ->> 'cycleRevision')::integer,
      'proposalId', proposal.id,
      'status', receipt.to_state,
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if cycle.revision <> p_expected_cycle_revision
     or proposal.revision <> p_expected_revision then
    raise exception 'proposal changed; reload and try again' using errcode = '40001';
  end if;
  if campaign.status <> 'active'
     or cycle.phase in ('ratification', 'execution', 'complete')
     or exists (
       select 1
       from public.organizing_bargaining_proposals child
       where child.parent_proposal_id = proposal.id
     ) then
    raise exception 'proposal is not editable' using errcode = '22023';
  end if;

  allowed := case
    when proposal.status = 'draft' then
      p_next_status in ('approved', 'withdrawn')
    when proposal.status = 'approved' then
      p_next_status in ('presented', 'withdrawn')
    when proposal.status = 'presented' then
      p_next_status in (
        'countered',
        'tentative_agreement',
        'accepted',
        'rejected',
        'withdrawn'
      )
    when proposal.status = 'countered' then
      p_next_status in (
        'tentative_agreement',
        'accepted',
        'rejected',
        'withdrawn'
      )
    when proposal.status = 'tentative_agreement' then
      p_next_status = 'withdrawn'
    else false
  end;

  if proposal.record_kind = 'agreement_package'
     and p_next_status in ('accepted', 'rejected') then
    allowed := false;
  end if;
  if proposal.record_kind = 'article'
     and p_next_status = 'tentative_agreement' then
    allowed := false;
  end if;

  if not allowed then
    raise exception 'invalid proposal transition' using errcode = '22023';
  end if;
  if p_presented_on is not null
     and p_next_status not in (
       'presented',
       'countered',
       'tentative_agreement',
       'accepted',
       'rejected'
     ) then
    raise exception 'presentation date is not valid for this transition'
      using errcode = '22023';
  end if;
  if p_next_status in (
       'presented',
       'countered',
       'tentative_agreement',
       'accepted',
       'rejected'
     )
     and proposal.presented_on is null
     and p_presented_on is null then
    raise exception 'presentation date is required' using errcode = '22023';
  end if;
  if p_next_status in (
       'presented',
       'countered',
       'tentative_agreement',
       'accepted',
       'rejected'
     )
     and (
       cycle.bargaining_started_on is null
       or cycle.phase not in (
         'at_table',
         'mediation',
         'fact_finding',
         'impasse',
         'tentative_agreement'
       )
       or coalesce(proposal.presented_on, p_presented_on)
          < cycle.bargaining_started_on
     ) then
    raise exception 'formal proposal status requires active bargaining chronology'
      using errcode = '22023';
  end if;
  if p_next_status = 'tentative_agreement'
     and (
       proposal.record_kind <> 'agreement_package'
       or nullif(pg_catalog.btrim(coalesce(proposal.member_summary, '')), '') is null
       or exists (
         select 1
         from pg_catalog.unnest(proposal.included_proposal_ids) included_id
         left join public.organizing_bargaining_proposals included
           on included.id = included_id
          and included.cycle_id = cycle.id
          and included.campaign_id = campaign.id
          and included.chapter_id = campaign.chapter_id
          and included.record_kind = 'article'
         where included.id is null
            or included.status <> 'accepted'
            or included.presented_on is null
            or included.presented_on > coalesce(
              proposal.presented_on,
              p_presented_on
            )
            or exists (
              select 1
              from public.organizing_bargaining_proposals child
              where child.parent_proposal_id = included.id
            )
       )
       or exists (
         select 1
         from public.organizing_bargaining_proposals current_article
         where current_article.cycle_id = cycle.id
           and current_article.campaign_id = campaign.id
           and current_article.chapter_id = campaign.chapter_id
           and current_article.record_kind = 'article'
           and current_article.status = 'accepted'
           and not exists (
             select 1
             from public.organizing_bargaining_proposals child
             where child.parent_proposal_id = current_article.id
           )
           and not (
             current_article.id = any(proposal.included_proposal_ids)
           )
       )
       or exists (
         select 1
         from public.organizing_bargaining_proposals unresolved_article
         where unresolved_article.cycle_id = cycle.id
           and unresolved_article.campaign_id = campaign.id
           and unresolved_article.chapter_id = campaign.chapter_id
           and unresolved_article.record_kind = 'article'
           and unresolved_article.status not in (
             'accepted',
             'rejected',
             'withdrawn',
             'superseded'
           )
           and not exists (
             select 1
             from public.organizing_bargaining_proposals child
             where child.parent_proposal_id = unresolved_article.id
           )
       )
     ) then
    raise exception 'tentative agreement requires a whole agreement package and member-safe summary'
      using errcode = '22023';
  end if;

  update public.organizing_bargaining_proposals
  set status = p_next_status,
      presented_on = coalesce(proposal.presented_on, p_presented_on),
      revision = proposal.revision + 1,
      updated_at = event_time
  where id = proposal.id;

  update public.organizing_bargaining_cycles
  set revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.proposal.transitioned',
    'bargaining_proposal',
    proposal.id,
    proposal.status,
    p_next_status,
    pg_catalog.jsonb_build_object(
      'cycleRevision',
      cycle.revision + 1
    ),
    p_request_id,
    fingerprint,
    proposal.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'cycleId', cycle.id,
    'cycleRevision', cycle.revision + 1,
    'proposalId', proposal.id,
    'status', p_next_status,
    'revision', proposal.revision + 1,
    'auditEventId', audit_id
  );
end;
end;
$$;


create trigger organizing_bargaining_proposals_preserve_snapshot
  before update on public.organizing_bargaining_proposals
  for each row execute function private.preserve_bargaining_proposal_snapshot();

-- 2. Typed external ratification and first-contract evidence ----------------

create table public.organizing_bargaining_ratifications (
  id uuid primary key default extensions.gen_random_uuid(),
  cycle_id uuid not null,
  campaign_id uuid not null,
  chapter_id text not null,
  supersedes_ratification_id uuid,
  agreement_proposal_id uuid not null,
  agreement_sha256 text not null
    check (agreement_sha256 ~ '^[0-9a-f]{64}$'),
  decision_method text not null
    check (decision_method in ('vote', 'not_required')),
  held_on date not null,
  source_reported_outcome text not null
    check (
      source_reported_outcome in (
        'approved',
        'rejected',
        'no_quorum',
        'not_required'
      )
    ),
  computed_outcome text not null
    check (
      computed_outcome in (
        'approved',
        'rejected',
        'no_quorum',
        'indeterminate',
        'not_required'
      )
    ),
  execution_authorized boolean generated always as (
    computed_outcome in ('approved', 'not_required')
  ) stored,
  source_kind text not null
    check (
      source_kind in (
        'union_report',
        'independent_tally',
        'meeting_minutes',
        'written_rule',
        'other'
      )
    ),
  source_reference text not null
    check (pg_catalog.char_length(pg_catalog.btrim(source_reference)) between 3 and 1000),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  rule_summary text not null
    check (pg_catalog.char_length(pg_catalog.btrim(rule_summary)) between 3 and 2000),
  eligibility_source text not null
    check (pg_catalog.char_length(pg_catalog.btrim(eligibility_source)) between 3 and 1000),
  eligible_count integer,
  ballots_cast integer,
  approve_count integer,
  reject_count integer,
  abstain_count integer,
  invalid_count integer,
  quorum_required_count integer,
  threshold_numerator integer,
  threshold_denominator integer,
  approval_comparator text
    check (
      approval_comparator is null
      or approval_comparator in ('at_least', 'more_than')
    ),
  approval_denominator text
    check (
      approval_denominator is null
      or approval_denominator in ('eligible', 'ballots_cast', 'non_abstaining')
    ),
  recorded_by uuid not null references auth.users(id) on delete restrict,
  create_request_id uuid not null,
  created_at timestamptz not null default now(),
  constraint organizing_bargaining_ratifications_vote_shape_check
    check ((
      (
        decision_method = 'vote'
        and source_reported_outcome in ('approved', 'rejected', 'no_quorum')
        and eligible_count is not null
         and eligible_count between 1 and 10000000
        and ballots_cast is not null
        and ballots_cast between 0 and eligible_count
        and approve_count is not null
        and approve_count between 0 and ballots_cast
        and reject_count is not null
        and reject_count between 0 and ballots_cast
        and abstain_count is not null
        and abstain_count between 0 and ballots_cast
        and invalid_count is not null
        and invalid_count between 0 and ballots_cast
        and approve_count::bigint
            + reject_count::bigint
            + abstain_count::bigint
            + invalid_count::bigint
            = ballots_cast::bigint
        and quorum_required_count is not null
        and quorum_required_count between 0 and eligible_count
        and threshold_numerator is not null
        and threshold_denominator is not null
        and threshold_numerator between 1 and threshold_denominator
        and threshold_denominator between 1 and 10000000
        and approval_comparator in ('at_least', 'more_than')
        and approval_denominator is not null
      )
      or (
        decision_method = 'not_required'
        and source_reported_outcome = 'not_required'
        and computed_outcome = 'not_required'
        and eligible_count is null
        and ballots_cast is null
        and approve_count is null
        and reject_count is null
        and abstain_count is null
        and invalid_count is null
        and quorum_required_count is null
        and threshold_numerator is null
        and threshold_denominator is null
        and approval_comparator is null
        and approval_denominator is null
      )
    ) is true),
  constraint organizing_bargaining_ratifications_derived_outcome_check
    check (
      computed_outcome = case
        when decision_method = 'not_required' then 'not_required'
        when ballots_cast < quorum_required_count then
          case
            when source_reported_outcome = 'no_quorum' then 'no_quorum'
            else 'indeterminate'
          end
        when (
          case approval_denominator
            when 'eligible' then eligible_count::bigint
            when 'ballots_cast' then ballots_cast::bigint
            when 'non_abstaining'
              then approve_count::bigint + reject_count::bigint
          end
        ) <= 0 then 'indeterminate'
        when (
          approval_comparator = 'at_least'
          and approve_count::bigint * threshold_denominator::bigint
              >= (
                case approval_denominator
                  when 'eligible' then eligible_count::bigint
                  when 'ballots_cast' then ballots_cast::bigint
                  when 'non_abstaining'
                    then approve_count::bigint + reject_count::bigint
                end
              ) * threshold_numerator::bigint
        ) or (
          approval_comparator = 'more_than'
          and approve_count::bigint * threshold_denominator::bigint
              > (
                case approval_denominator
                  when 'eligible' then eligible_count::bigint
                  when 'ballots_cast' then ballots_cast::bigint
                  when 'non_abstaining'
                    then approve_count::bigint + reject_count::bigint
                end
              ) * threshold_numerator::bigint
        ) then
          case
            when source_reported_outcome = 'approved' then 'approved'
            else 'indeterminate'
          end
        else
          case
            when source_reported_outcome = 'rejected' then 'rejected'
            else 'indeterminate'
          end
      end
    ),
  constraint organizing_bargaining_ratifications_cycle_scope_fkey
    foreign key (cycle_id, campaign_id, chapter_id)
    references public.organizing_bargaining_cycles(id, campaign_id, chapter_id)
    on delete restrict,
  constraint organizing_bargaining_ratifications_proposal_scope_fkey
    foreign key (
      agreement_proposal_id,
      cycle_id,
      campaign_id,
      chapter_id,
      agreement_sha256
    )
    references public.organizing_bargaining_proposals(
      id,
      cycle_id,
      campaign_id,
      chapter_id,
      document_sha256
    )
    on delete restrict,
  constraint organizing_bargaining_ratifications_supersedes_scope_fkey
    foreign key (
      supersedes_ratification_id,
      cycle_id,
      campaign_id,
      chapter_id
    )
    references public.organizing_bargaining_ratifications(
      id,
      cycle_id,
      campaign_id,
      chapter_id
    )
    on delete restrict,
  unique (id, cycle_id, campaign_id, chapter_id),
  unique (
    id,
    cycle_id,
    campaign_id,
    chapter_id,
    agreement_proposal_id,
    agreement_sha256,
    execution_authorized
  ),
  unique (recorded_by, chapter_id, create_request_id)
);

alter table public.organizing_bargaining_cycles
  add constraint organizing_bargaining_cycles_current_ratification_fkey
    foreign key (
      current_ratification_id,
      id,
      campaign_id,
      chapter_id
    )
    references public.organizing_bargaining_ratifications(
      id,
      cycle_id,
      campaign_id,
      chapter_id
    )
    on delete restrict;

create table public.organizing_bargaining_ratification_corrections (
  id uuid primary key default extensions.gen_random_uuid(),
  ratification_id uuid not null,
  cycle_id uuid not null,
  campaign_id uuid not null,
  chapter_id text not null,
  reason_code text not null
    check (
      reason_code in (
        'source_error',
        'tally_error',
        'rule_error',
        'wrong_agreement',
        'duplicate_record',
        'other'
      )
    ),
  source_kind text not null
    check (
      source_kind in (
        'union_report',
        'independent_tally',
        'meeting_minutes',
        'written_rule',
        'official_record',
        'other'
      )
    ),
  source_reference text not null
    check (pg_catalog.char_length(pg_catalog.btrim(source_reference)) between 3 and 1000),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  corrected_by uuid not null references auth.users(id) on delete restrict,
  create_request_id uuid not null,
  created_at timestamptz not null default now(),
  constraint organizing_bargaining_ratification_corrections_scope_fkey
    foreign key (
      ratification_id,
      cycle_id,
      campaign_id,
      chapter_id
    )
    references public.organizing_bargaining_ratifications(
      id,
      cycle_id,
      campaign_id,
      chapter_id
    )
    on delete restrict,
  unique (ratification_id),
  unique (corrected_by, chapter_id, create_request_id)
);

create table public.organizing_first_contracts (
  id uuid primary key default extensions.gen_random_uuid(),
  cycle_id uuid not null,
  campaign_id uuid not null,
  chapter_id text not null,
  ratification_id uuid not null,
  agreement_proposal_id uuid not null,
  agreement_sha256 text not null
    check (agreement_sha256 ~ '^[0-9a-f]{64}$'),
  ratification_authorized boolean not null default true
    check (ratification_authorized),
  verification_status text not null default 'source_recorded_fully_signed'
    check (verification_status = 'source_recorded_fully_signed'),
  signed_on date not null,
  effective_on date,
  expires_on date,
  source_kind text not null
    check (
      source_kind in (
        'executed_contract',
        'signed_memorandum',
        'official_record',
        'other'
      )
    ),
  source_reference text not null
    check (pg_catalog.char_length(pg_catalog.btrim(source_reference)) between 3 and 1000),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  expected_signatory_count integer not null
    check (expected_signatory_count between 1 and 1000),
  verified_signatory_count integer not null
    check (verified_signatory_count between 1 and 1000),
  recorded_by uuid not null references auth.users(id) on delete restrict,
  create_request_id uuid not null,
  created_at timestamptz not null default now(),
  constraint organizing_first_contracts_date_check
    check (
      expires_on is null
      or (
        expires_on >= signed_on
        and (
          effective_on is null
          or expires_on >= effective_on
        )
      )
    ),
  constraint organizing_first_contracts_signatory_check
    check (verified_signatory_count = expected_signatory_count),
  constraint organizing_first_contracts_ratification_scope_fkey
    foreign key (
      ratification_id,
      cycle_id,
      campaign_id,
      chapter_id,
      agreement_proposal_id,
      agreement_sha256,
      ratification_authorized
    )
    references public.organizing_bargaining_ratifications(
      id,
      cycle_id,
      campaign_id,
      chapter_id,
      agreement_proposal_id,
      agreement_sha256,
      execution_authorized
    )
    on delete restrict,
  unique (cycle_id),
  unique (recorded_by, chapter_id, create_request_id)
);

create index organizing_bargaining_ratifications_cycle_idx
  on public.organizing_bargaining_ratifications(cycle_id, created_at desc);

create index organizing_bargaining_ratification_corrections_cycle_idx
  on public.organizing_bargaining_ratification_corrections(cycle_id, created_at desc);

create index organizing_bargaining_sessions_cycle_queue_idx
  on public.organizing_bargaining_sessions(cycle_id, status, starts_at);

create function private.prevent_bargaining_evidence_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'bargaining evidence is append-only' using errcode = '42501';
end;
$$;

revoke all on function private.prevent_bargaining_evidence_change()
  from public, anon, authenticated, service_role;

create function private.prevent_corrected_ratification_reactivation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.current_ratification_id is not null
     and exists (
       select 1
       from public.organizing_bargaining_ratification_corrections correction
       where correction.ratification_id = new.current_ratification_id
     ) then
    raise exception 'corrected ratification cannot become current'
      using errcode = '22023';
  end if;
  if new.ratification_integrity_hold
     and not exists (
       select 1
       from public.organizing_first_contracts contract
       join public.organizing_bargaining_ratification_corrections correction
         on correction.ratification_id = contract.ratification_id
        and correction.cycle_id = contract.cycle_id
        and correction.campaign_id = contract.campaign_id
        and correction.chapter_id = contract.chapter_id
       where contract.cycle_id = new.id
         and contract.campaign_id = new.campaign_id
         and contract.chapter_id = new.chapter_id
     ) then
    raise exception 'ratification integrity hold requires corrected contract authority'
      using errcode = '22023';
  end if;
  if tg_op = 'UPDATE'
     and old.ratification_integrity_hold
     and not new.ratification_integrity_hold then
    raise exception 'ratification integrity hold requires governed resolution'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

create function private.enforce_corrected_ratification_detached()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform 1
  from public.organizing_bargaining_cycles cycle
  where cycle.id = new.cycle_id
    and cycle.campaign_id = new.campaign_id
    and cycle.chapter_id = new.chapter_id
  for update;

  if exists (
    select 1
    from public.organizing_bargaining_cycles cycle
    where cycle.id = new.cycle_id
      and cycle.campaign_id = new.campaign_id
      and cycle.chapter_id = new.chapter_id
      and cycle.current_ratification_id = new.ratification_id
  ) then
    raise exception 'corrected ratification must not remain current'
      using errcode = '22023';
  end if;
  if exists (
       select 1
       from public.organizing_first_contracts contract
       where contract.cycle_id = new.cycle_id
         and contract.campaign_id = new.campaign_id
         and contract.chapter_id = new.chapter_id
         and contract.ratification_id = new.ratification_id
     )
     and not exists (
       select 1
       from public.organizing_bargaining_cycles cycle
       where cycle.id = new.cycle_id
         and cycle.campaign_id = new.campaign_id
         and cycle.chapter_id = new.chapter_id
         and cycle.ratification_integrity_hold
         and cycle.current_ratification_id is null
     ) then
    raise exception 'corrected contract authority requires an integrity hold'
      using errcode = '22023';
  end if;
  return new;
end;
end;
$$;

revoke all on function private.prevent_corrected_ratification_reactivation()
  from public, anon, authenticated, service_role;
revoke all on function private.enforce_corrected_ratification_detached()
  from public, anon, authenticated, service_role;

create trigger organizing_bargaining_cycles_reject_corrected_ratification
  before insert or update of current_ratification_id, ratification_integrity_hold
  on public.organizing_bargaining_cycles
  for each row execute function private.prevent_corrected_ratification_reactivation();

create trigger organizing_bargaining_ratifications_append_only
  before update or delete on public.organizing_bargaining_ratifications
  for each row execute function private.prevent_bargaining_evidence_change();

create trigger organizing_bargaining_ratification_corrections_append_only
  before update or delete
  on public.organizing_bargaining_ratification_corrections
  for each row execute function private.prevent_bargaining_evidence_change();

create constraint trigger organizing_bargaining_corrections_detach_current
  after insert on public.organizing_bargaining_ratification_corrections
  deferrable initially deferred
  for each row execute function private.enforce_corrected_ratification_detached();

create trigger organizing_first_contracts_append_only
  before update or delete on public.organizing_first_contracts
  for each row execute function private.prevent_bargaining_evidence_change();

alter table public.organizing_bargaining_ratifications enable row level security;
alter table public.organizing_bargaining_ratification_corrections enable row level security;
alter table public.organizing_first_contracts enable row level security;

create policy mfa_assurance
  on public.organizing_bargaining_ratifications
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

create policy mfa_assurance
  on public.organizing_bargaining_ratification_corrections
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

create policy mfa_assurance
  on public.organizing_first_contracts
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on table
  public.organizing_bargaining_cycles,
  public.organizing_bargaining_proposals,
  public.organizing_bargaining_sessions,
  public.organizing_bargaining_ratifications,
  public.organizing_bargaining_ratification_corrections,
  public.organizing_first_contracts
from public, anon, authenticated, service_role;

-- 3. Strict writer authorization and shared guards --------------------------

create function private.bargaining_strict_mfa_satisfied()
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  claims jsonb := (select auth.jwt());
  session_claim text := nullif(claims ->> 'session_id', '');
  session_satisfied boolean := false;
begin
  if caller is null
     or claims ->> 'aal' <> 'aal2'
     or session_claim is null
     or session_claim !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or not (select private.mfa_satisfied()) then
    return false;
  end if;

  select true
  into session_satisfied
  from auth.sessions s
  join auth.mfa_factors f
    on f.id = s.factor_id
   and f.user_id = s.user_id
  where s.id = session_claim::uuid
    and s.user_id = caller
    and s.aal = 'aal2'
    and (s.not_after is null or s.not_after > pg_catalog.clock_timestamp())
    and f.status = 'verified'
    and f.factor_type = 'totp'
  limit 1;

  return coalesce(session_satisfied, false);
end;
$$;

-- Reconciled 2026-10-14: the July body share-locked the auth.sessions and
-- auth.mfa_factors rows. The account-lifecycle protocol lets only its gated
-- Auth bookkeeping functions hold Auth tuples (behind the exclusive
-- (509, 701) lock), so the read is unlocked. Reset safety comes from the
-- shared reset boundary: private.mfa_satisfied() refuses any session created
-- before a reset, and a writer that passed this check before a concurrent
-- reset is ordered before it.
comment on function private.bargaining_strict_mfa_satisfied() is
  'Bargaining writers require a live reset-safe AAL2 session whose current verified factor is TOTP.';

create function private.lock_bargaining_campaign_writer(
  p_campaign_id uuid,
  p_chapter_id text,
  p_coordinator_only boolean default false
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  writer_kind text;
begin
  if caller is null or not (select private.bargaining_strict_mfa_satisfied()) then
    return null;
  end if;

  select a.assignment_role
  into writer_kind
  from public.member_profiles p
  join public.member_chapter_memberships m
    on m.user_id = p.id
   and m.chapter_id = p.chapter_id
   and m.status = 'active'
  join public.member_role_chapters r
    on r.user_id = p.id
   and r.chapter_id = p.chapter_id
  join public.organizing_campaign_assignments a
    on a.user_id = p.id
   and a.chapter_id = p.chapter_id
   and a.campaign_id = p_campaign_id
  where p.id = caller
    and p.chapter_id = p_chapter_id
    and a.status = 'active'
    and (
      (
        r.role = 'coordinator'
        and a.assignment_role = 'coordinator'
      )
      or (
        not p_coordinator_only
        and r.role = 'organizer'
        and a.assignment_role in ('lead_organizer', 'organizer')
      )
    )
  order by case
    when r.role = 'coordinator' then 1
    when a.assignment_role = 'lead_organizer' then 2
    else 3
  end
  limit 1
  for share of p, r, a, m;

  -- Union Ground's role predicate (organization membership, staff-MFA policy)
  -- must agree with the locked chapter grant.
  if not found
     or not (select private.bargaining_strict_mfa_satisfied())
     or not private.member_has_chapter_role(
       p_chapter_id,
       array[case when writer_kind = 'coordinator' then 'coordinator' else 'organizer' end]
     ) then
    return null;
  end if;

  return writer_kind;
end;
end;
$$;

create function private.bargaining_request_fingerprint(
  p_operation text,
  p_payload jsonb
)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(
      (
        pg_catalog.jsonb_build_object('operation', p_operation)
        || coalesce(p_payload, '{}'::jsonb)
      )::text,
      'sha256'
    ),
    'hex'
  );
$$;

create function private.bargaining_canonical_instant(p_value timestamptz)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select extract(epoch from p_value)::numeric::text;
$$;

revoke all on function private.bargaining_strict_mfa_satisfied()
  from public, anon, authenticated, service_role;
revoke all on function private.lock_bargaining_campaign_writer(uuid, text, boolean)
  from public, anon, authenticated, service_role;
revoke all on function private.bargaining_request_fingerprint(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.bargaining_canonical_instant(timestamptz)
  from public, anon, authenticated, service_role;

-- Typed records, not generic phase/date labels, guard the factual campaign
-- stages. This also hardens the pre-existing campaign-transition RPC.
create function private.enforce_typed_first_contract_stages()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.stage = 'first_contract' and new.status <> 'active' then
    raise exception 'first-contract stage requires an active campaign'
      using errcode = '22023';
  end if;

  if new.stage = 'first_contract'
     and not exists (
       select 1
       from public.organizing_bargaining_cycles c
       join public.organizing_bargaining_ratifications r
         on r.cycle_id = c.id
        and r.campaign_id = c.campaign_id
        and r.chapter_id = c.chapter_id
        where c.campaign_id = new.id
          and c.chapter_id = new.chapter_id
           and c.current_ratification_id = r.id
           and not c.ratification_integrity_hold
           and r.execution_authorized
           and not exists (
             select 1
             from public.organizing_bargaining_ratification_corrections correction
             where correction.ratification_id = r.id
           )
         and c.phase in ('execution', 'complete')
     ) then
    raise exception 'sourced ratification authorization required'
      using errcode = '22023';
  end if;

  if new.stage = 'established'
     and not exists (
       select 1
       from public.organizing_bargaining_cycles c
       join public.organizing_first_contracts f
         on f.cycle_id = c.id
        and f.campaign_id = c.campaign_id
        and f.chapter_id = c.chapter_id
        where c.campaign_id = new.id
          and c.chapter_id = new.chapter_id
           and c.phase = 'complete'
           and not c.ratification_integrity_hold
           and f.ratification_id = c.current_ratification_id
           and not exists (
             select 1
             from public.organizing_bargaining_ratification_corrections correction
             where correction.ratification_id = f.ratification_id
           )
          and c.first_contract_signed_on = f.signed_on
         and f.verification_status = 'source_recorded_fully_signed'
     ) then
    raise exception 'source-recorded fully signed first contract required'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_typed_first_contract_stages()
  from public, anon, authenticated, service_role;

create trigger organizing_campaigns_typed_first_contract_stages
  before insert or update of stage, status, outcome on public.organizing_campaigns
  for each row execute function private.enforce_typed_first_contract_stages();

do $typed_stage_preflight$
begin
  if exists (
    select 1
    from public.organizing_campaigns campaign
    where campaign.stage = 'first_contract'
      and (
        campaign.status <> 'active'
        or not exists (
          select 1
          from public.organizing_bargaining_cycles cycle
          join public.organizing_bargaining_ratifications ratification
            on ratification.cycle_id = cycle.id
           and ratification.campaign_id = cycle.campaign_id
           and ratification.chapter_id = cycle.chapter_id
          where cycle.campaign_id = campaign.id
            and cycle.chapter_id = campaign.chapter_id
            and cycle.current_ratification_id = ratification.id
            and not cycle.ratification_integrity_hold
            and ratification.execution_authorized
            and not exists (
              select 1
              from public.organizing_bargaining_ratification_corrections correction
              where correction.ratification_id = ratification.id
            )
            and cycle.phase in ('execution', 'complete')
        )
      )
  ) then
    raise exception
      'migration requires manual remediation of unsupported first-contract campaign stages'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.organizing_campaigns campaign
    where campaign.stage = 'established'
      and not exists (
        select 1
        from public.organizing_bargaining_cycles cycle
        join public.organizing_first_contracts contract
          on contract.cycle_id = cycle.id
         and contract.campaign_id = cycle.campaign_id
         and contract.chapter_id = cycle.chapter_id
        where cycle.campaign_id = campaign.id
          and cycle.chapter_id = campaign.chapter_id
          and cycle.phase = 'complete'
          and not cycle.ratification_integrity_hold
          and contract.ratification_id = cycle.current_ratification_id
          and not exists (
            select 1
            from public.organizing_bargaining_ratification_corrections correction
            where correction.ratification_id = contract.ratification_id
          )
          and cycle.first_contract_signed_on = contract.signed_on
          and contract.verification_status = 'source_recorded_fully_signed'
      )
  ) then
    raise exception
      'migration requires manual remediation of unsupported established campaign stages'
      using errcode = '55000';
  end if;
end
$typed_stage_preflight$;

-- 4. Cycle commands ---------------------------------------------------------

create function public.open_organizing_bargaining_cycle(
  p_campaign_id uuid,
  p_expected_campaign_revision integer,
  p_title text,
  p_request_id uuid,
  p_target_first_contract_on date default null,
  p_next_action text default null,
  p_next_deadline_at timestamptz default null
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
  campaign record;
  receipt record;
  cycle_id uuid;
  fingerprint text;
  audit_id uuid;
  normalized_title text := pg_catalog.btrim(coalesce(p_title, ''));
  normalized_next_action text := nullif(pg_catalog.btrim(coalesce(p_next_action, '')), '');
begin
  if caller is null or p_campaign_id is null or p_request_id is null then
    raise exception 'campaign not found' using errcode = '22023';
  end if;
  if p_expected_campaign_revision is null or p_expected_campaign_revision <= 0 then
    raise exception 'campaign revision is required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(normalized_title) not between 3 and 160 then
    raise exception 'cycle title is invalid' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(normalized_next_action, '')) > 600 then
    raise exception 'next action is too long' using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.cycle.opened',
    pg_catalog.jsonb_build_object(
      'campaignId', p_campaign_id,
      'expectedCampaignRevision', p_expected_campaign_revision,
      'title', normalized_title,
      'targetFirstContractOn', p_target_first_contract_on,
      'nextAction', normalized_next_action,
      'nextDeadlineAt', private.bargaining_canonical_instant(p_next_deadline_at)
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select *
  into campaign
  from public.organizing_campaigns
  where id = p_campaign_id
  for update;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       false
     ) is null then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.cycle.opened'
       or receipt.campaign_id is distinct from campaign.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'campaignRevision', (receipt.safe_metadata ->> 'campaignRevision')::integer,
      'cycleId', receipt.entity_id,
      'phase', receipt.to_state,
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if campaign.revision <> p_expected_campaign_revision then
    raise exception 'campaign changed; reload and try again' using errcode = '40001';
  end if;
  if campaign.status <> 'active'
     or campaign.stage not in ('recognition', 'certification', 'bargaining') then
    raise exception 'campaign is not ready for bargaining' using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.organizing_bargaining_cycles c
    where c.campaign_id = campaign.id
  ) then
    raise exception 'bargaining cycle already exists' using errcode = '22023';
  end if;

  insert into public.organizing_bargaining_cycles (
    campaign_id,
    chapter_id,
    title,
    phase,
    target_first_contract_on,
    next_action,
    next_deadline_at,
    lead_id,
    created_by
  ) values (
    campaign.id,
    campaign.chapter_id,
    normalized_title,
    'preparing',
    p_target_first_contract_on,
    normalized_next_action,
    p_next_deadline_at,
    caller,
    caller
  ) returning id into cycle_id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.cycle.opened',
    'bargaining_cycle',
    cycle_id,
    'preparing',
    pg_catalog.jsonb_build_object(
      'campaignRevision',
      campaign.revision
    ),
    p_request_id,
    fingerprint,
    1
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'campaignRevision', campaign.revision,
    'cycleId', cycle_id,
    'phase', 'preparing',
    'revision', 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

create function public.transition_organizing_bargaining_cycle(
  p_cycle_id uuid,
  p_expected_revision integer,
  p_expected_campaign_revision integer,
  p_next_phase text,
  p_request_id uuid,
  p_effective_on date default null,
  p_reason text default null,
  p_next_action text default null,
  p_next_deadline_at timestamptz default null
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
  target record;
  campaign record;
  cycle record;
  receipt record;
  fingerprint text;
  allowed boolean;
  campaign_revision integer;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  normalized_next_action text := nullif(pg_catalog.btrim(coalesce(p_next_action, '')), '');
begin
  if caller is null or p_cycle_id is null or p_request_id is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision <= 0
     or p_expected_campaign_revision is null
     or p_expected_campaign_revision <= 0 then
    raise exception 'current revisions are required' using errcode = '22023';
  end if;
  if p_next_phase is null or p_next_phase not in (
    'preparing',
    'proposal_development',
    'at_table',
    'mediation',
    'fact_finding',
    'impasse',
    'tentative_agreement',
    'ratification',
    'execution',
    'complete'
  ) then
    raise exception 'unknown bargaining phase' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(normalized_reason, '')) > 1000
     or pg_catalog.char_length(coalesce(normalized_next_action, '')) > 600 then
    raise exception 'cycle text is too long' using errcode = '22023';
  end if;
  if p_effective_on is not null and p_effective_on > current_date then
    raise exception 'bargaining start cannot be in the future' using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.cycle.transitioned',
    pg_catalog.jsonb_build_object(
      'cycleId', p_cycle_id,
      'expectedRevision', p_expected_revision,
      'expectedCampaignRevision', p_expected_campaign_revision,
      'nextPhase', p_next_phase,
      'effectiveOn', p_effective_on,
      'reason', normalized_reason,
      'nextAction', normalized_next_action,
      'nextDeadlineAt', private.bargaining_canonical_instant(p_next_deadline_at)
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unionground:mfa-reset:' || caller::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:' || caller::text || ':' || p_request_id::text,
      0
    )
  );

  select c.campaign_id, c.chapter_id
  into target
  from public.organizing_bargaining_cycles c
  where c.id = p_cycle_id;

  if not found then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = p_cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       false
     ) is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.cycle.transitioned'
       or receipt.entity_id <> cycle.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'campaignRevision', (receipt.safe_metadata ->> 'campaignRevision')::integer,
      'cycleId', cycle.id,
      'phase', receipt.to_state,
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if campaign.revision <> p_expected_campaign_revision
     or cycle.revision <> p_expected_revision then
    raise exception 'bargaining record changed; reload and try again'
      using errcode = '40001';
  end if;
  if campaign.status <> 'active' then
    raise exception 'campaign is not active' using errcode = '22023';
  end if;

  allowed := case
    when cycle.phase = 'preparing' then
      p_next_phase = 'proposal_development'
    when cycle.phase = 'proposal_development' then
      p_next_phase = 'at_table'
    when cycle.phase = 'at_table' then
      p_next_phase in (
        'mediation',
        'fact_finding',
        'impasse',
        'tentative_agreement'
      )
    when cycle.phase in ('mediation', 'fact_finding', 'impasse') then
      p_next_phase in ('at_table', 'tentative_agreement')
    when cycle.phase = 'tentative_agreement' then
      p_next_phase in ('at_table', 'ratification')
    when cycle.phase = 'ratification' then
      p_next_phase = 'at_table'
    else false
  end;

  if not allowed or p_next_phase in ('execution', 'complete') then
    raise exception 'invalid bargaining phase transition' using errcode = '22023';
  end if;

  if cycle.phase = 'ratification' and p_next_phase = 'at_table' then
    if normalized_reason is null then
      raise exception 'ratification rollback reason is required'
        using errcode = '22023';
    end if;
    if private.lock_bargaining_campaign_writer(
         campaign.id,
         campaign.chapter_id,
         true
       ) is null then
      raise exception 'coordinator role required for ratification rollback'
        using errcode = '42501';
    end if;
    if exists (
         select 1
         from public.organizing_bargaining_ratifications current_result
         where current_result.id = cycle.current_ratification_id
           and current_result.cycle_id = cycle.id
           and current_result.execution_authorized
       )
       or exists (
         select 1
         from public.organizing_first_contracts contract
         where contract.cycle_id = cycle.id
       ) then
      raise exception 'authorized ratification cannot be rolled back'
        using errcode = '22023';
    end if;
  end if;

  if cycle.bargaining_started_on is null
     and p_next_phase = 'at_table'
     and p_effective_on is null then
    raise exception 'verified bargaining start date is required'
      using errcode = '22023';
  end if;

  if p_next_phase in ('tentative_agreement', 'ratification')
     and not exists (
       select 1
       from public.organizing_bargaining_proposals p
       where p.cycle_id = cycle.id
         and p.campaign_id = campaign.id
         and p.chapter_id = campaign.chapter_id
         and p.record_kind = 'agreement_package'
         and p.status = 'tentative_agreement'
         and p.document_sha256 is not null
         and not exists (
           select 1
           from public.organizing_bargaining_proposals child
           where child.parent_proposal_id = p.id
         )
         and not exists (
           select 1
           from pg_catalog.unnest(p.included_proposal_ids) included_id
           left join public.organizing_bargaining_proposals included
             on included.id = included_id
            and included.cycle_id = cycle.id
            and included.campaign_id = campaign.id
            and included.chapter_id = campaign.chapter_id
            and included.record_kind = 'article'
           where included.id is null
              or included.status <> 'accepted'
              or included.presented_on is null
              or included.presented_on > p.presented_on
              or exists (
                select 1
                from public.organizing_bargaining_proposals child
                where child.parent_proposal_id = included.id
              )
         )
         and not exists (
           select 1
           from public.organizing_bargaining_proposals current_article
           where current_article.cycle_id = cycle.id
             and current_article.campaign_id = campaign.id
             and current_article.chapter_id = campaign.chapter_id
             and current_article.record_kind = 'article'
             and current_article.status = 'accepted'
             and not exists (
               select 1
               from public.organizing_bargaining_proposals child
               where child.parent_proposal_id = current_article.id
             )
             and not (current_article.id = any(p.included_proposal_ids))
         )
         and not exists (
           select 1
           from public.organizing_bargaining_proposals unresolved_article
           where unresolved_article.cycle_id = cycle.id
             and unresolved_article.campaign_id = campaign.id
             and unresolved_article.chapter_id = campaign.chapter_id
             and unresolved_article.record_kind = 'article'
             and unresolved_article.status not in (
               'accepted',
               'rejected',
               'withdrawn',
               'superseded'
             )
             and not exists (
               select 1
               from public.organizing_bargaining_proposals child
               where child.parent_proposal_id = unresolved_article.id
             )
         )
     ) then
    raise exception 'current tentative-agreement proposal required'
      using errcode = '22023';
  end if;

  if cycle.bargaining_started_on is null
     and p_next_phase = 'at_table'
     and campaign.stage not in ('recognition', 'certification', 'bargaining') then
    raise exception 'campaign is not ready for bargaining' using errcode = '22023';
  end if;

  update public.organizing_bargaining_cycles
  set phase = p_next_phase,
      bargaining_started_on = case
        when cycle.bargaining_started_on is null and p_next_phase = 'at_table'
          then p_effective_on
        else cycle.bargaining_started_on
      end,
      next_action = normalized_next_action,
      next_deadline_at = p_next_deadline_at,
      revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  campaign_revision := campaign.revision;
  if cycle.bargaining_started_on is null
     and p_next_phase = 'at_table'
     and campaign.stage in ('recognition', 'certification') then
    update public.organizing_campaigns
    set stage = 'bargaining',
        stage_started_at = event_time,
        revision = campaign.revision + 1,
        updated_at = event_time
    where id = campaign.id;

    insert into public.organizing_stage_events (
      campaign_id,
      chapter_id,
      from_stage,
      to_stage,
      actor_id,
      source_kind,
      note,
      occurred_at
    ) values (
      campaign.id,
      campaign.chapter_id,
      campaign.stage,
      'bargaining',
      caller,
      'staff_verified',
      'Verified bargaining start recorded',
      event_time
    );

    campaign_revision := campaign.revision + 1;
  end if;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    reason,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'bargaining.cycle.transitioned',
    'bargaining_cycle',
    cycle.id,
    cycle.phase,
    p_next_phase,
    normalized_reason,
    pg_catalog.jsonb_build_object(
      'campaignRevision',
      campaign_revision
    ),
    p_request_id,
    fingerprint,
    cycle.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'campaignRevision', campaign_revision,
    'cycleId', cycle.id,
    'phase', p_next_phase,
    'revision', cycle.revision + 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- 9. Exact execution surface ------------------------------------------------

revoke all on function public.open_organizing_bargaining_cycle(
  uuid, integer, text, uuid, date, text, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function public.transition_organizing_bargaining_cycle(
  uuid, integer, integer, text, uuid, date, text, text, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function public.create_organizing_bargaining_proposal(
  uuid, integer, text, text, text, uuid, text, uuid[], text, uuid,
  integer, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.transition_organizing_bargaining_proposal(
  uuid, integer, integer, text, uuid, date, text
) from public, anon, authenticated, service_role;
revoke all on function public.schedule_organizing_bargaining_session(
  uuid, integer, timestamptz, uuid, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.record_organizing_bargaining_session_outcome(
  uuid, integer, integer, text, uuid, timestamptz, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.record_organizing_ratification(
  uuid, integer, integer, uuid, text, text, date, text, text, text,
  text, text, text, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, text, text, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.correct_organizing_ratification(
  uuid, integer, integer, text, text, text, text, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.record_organizing_first_contract(
  uuid, integer, integer, uuid, text, date, uuid, text, text, text,
  integer, integer, date, date
) from public, anon, authenticated, service_role;
revoke all on function public.get_bargaining_workspace()
  from public, anon, authenticated, service_role;

grant execute on function public.open_organizing_bargaining_cycle(
  uuid, integer, text, uuid, date, text, timestamptz
) to authenticated;
grant execute on function public.transition_organizing_bargaining_cycle(
  uuid, integer, integer, text, uuid, date, text, text, timestamptz
) to authenticated;
grant execute on function public.create_organizing_bargaining_proposal(
  uuid, integer, text, text, text, uuid, text, uuid[], text, uuid,
  integer, text, text, text
) to authenticated;
grant execute on function public.transition_organizing_bargaining_proposal(
  uuid, integer, integer, text, uuid, date, text
) to authenticated;
grant execute on function public.schedule_organizing_bargaining_session(
  uuid, integer, timestamptz, uuid, text, text
) to authenticated;
grant execute on function public.record_organizing_bargaining_session_outcome(
  uuid, integer, integer, text, uuid, timestamptz, text, text, text
) to authenticated;
grant execute on function public.record_organizing_ratification(
  uuid, integer, integer, uuid, text, text, date, text, text, text,
  text, text, text, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, text, text, uuid
) to authenticated;
grant execute on function public.correct_organizing_ratification(
  uuid, integer, integer, text, text, text, text, uuid
) to authenticated;
grant execute on function public.record_organizing_first_contract(
  uuid, integer, integer, uuid, text, date, uuid, text, text, text,
  integer, integer, date, date
) to authenticated;
grant execute on function public.get_bargaining_workspace()
  to authenticated;

notify pgrst, 'reload schema';
