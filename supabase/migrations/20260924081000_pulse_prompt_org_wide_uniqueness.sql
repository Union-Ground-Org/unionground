-- BUG-UG-PULSE-PROMPT-DOUBLE-SUBMIT-AND-NULL-CHAPTER-DUPES-20260920
--
-- PostgreSQL UNIQUE (organization_id, chapter_id, event_key) treats NULLs as
-- distinct, so two organization-wide pulse prompts (chapter_id IS NULL) can
-- share an event_key. Keep that table unique for chapter-scoped rows and add a
-- partial unique index that collides only on org-wide rows. Deduplicate any
-- existing org-wide collisions first, keeping the newest updated_at row.
-- organization_pulse_events.prompt_id is ON DELETE CASCADE, so remapping and
-- merging child events onto the keeper must finish before the doomed prompt
-- rows are deleted. Hold a write lock across the snapshot and index build so a
-- concurrent save cannot insert a duplicate the unique index would then reject.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

lock table public.organization_pulse_events, public.organization_pulse_prompts
  in share row exclusive mode;

create temporary table pulse_prompt_org_wide_dupes on commit drop as
with ranked as (
  select
    id,
    pg_catalog.first_value(id) over (
      partition by organization_id, event_key
      order by updated_at desc, id desc
    ) as keep_id,
    pg_catalog.row_number() over (
      partition by organization_id, event_key
      order by updated_at desc, id desc
    ) as keep_rank
  from public.organization_pulse_prompts
  where chapter_id is null
)
select id as drop_id, keep_id
from ranked
where keep_rank > 1;

-- One surviving event per (keep_id, user_id, context_key). Rank payload by
-- state then the selected row's updated_at (not max(updated_at) across the
-- group), but store the group's latest updated_at: evaluate_contextual_pulse
-- measures cooldown from organization_pulse_events.updated_at. Prefer the keeper row as the physical survivor when it exists so
-- two discarded rows with the same key cannot both remap onto it.
create temporary table pulse_event_plan on commit drop as
with candidates as (
  select
    d.keep_id,
    e.id as event_id,
    e.user_id,
    e.context_key,
    e.state,
    e.response_value,
    e.shown_at,
    e.responded_at,
    e.updated_at,
    false as is_keeper
  from pg_temp.pulse_prompt_org_wide_dupes d
  join public.organization_pulse_events e
    on e.prompt_id = d.drop_id
  union all
  select
    k.keep_id,
    e.id,
    e.user_id,
    e.context_key,
    e.state,
    e.response_value,
    e.shown_at,
    e.responded_at,
    e.updated_at,
    true
  from (select distinct keep_id from pg_temp.pulse_prompt_org_wide_dupes) k
  join public.organization_pulse_events e
    on e.prompt_id = k.keep_id
),
ranked as (
  select
    keep_id,
    user_id,
    context_key,
    event_id,
    is_keeper,
    state,
    response_value,
    shown_at,
    responded_at,
    updated_at,
    pg_catalog.row_number() over (
      partition by keep_id, user_id, context_key
      order by
        case state when 'responded' then 3 when 'dismissed' then 2 else 1 end desc,
        updated_at desc,
        event_id desc
    ) as payload_rank,
    pg_catalog.row_number() over (
      partition by keep_id, user_id, context_key
      order by is_keeper desc,
        case state when 'responded' then 3 when 'dismissed' then 2 else 1 end desc,
        updated_at desc,
        event_id desc
    ) as survivor_rank,
    pg_catalog.min(shown_at) over (
      partition by keep_id, user_id, context_key
    ) as earliest_shown_at,
    pg_catalog.max(updated_at) over (
      partition by keep_id, user_id, context_key
    ) as latest_updated_at
  from candidates
)
select
  survivor.keep_id,
  survivor.event_id as survivor_id,
  payload.state as best_state,
  payload.response_value as best_response_value,
  payload.responded_at as best_responded_at,
  survivor.earliest_shown_at,
  survivor.latest_updated_at
from ranked survivor
join ranked payload
  on payload.keep_id = survivor.keep_id
 and payload.user_id = survivor.user_id
 and payload.context_key = survivor.context_key
 and payload.payload_rank = 1
where survivor.survivor_rank = 1
  and exists (
    select 1
    from ranked discarded
    where discarded.keep_id = survivor.keep_id
      and discarded.user_id = survivor.user_id
      and discarded.context_key = survivor.context_key
      and discarded.is_keeper = false
  );

update public.organization_pulse_events as target
set
  state = plan.best_state,
  response_value = plan.best_response_value,
  shown_at = plan.earliest_shown_at,
  responded_at = plan.best_responded_at,
  updated_at = plan.latest_updated_at,
  prompt_id = plan.keep_id
from pg_temp.pulse_event_plan as plan
where target.id = plan.survivor_id;

delete from public.organization_pulse_prompts
where id in (select drop_id from pg_temp.pulse_prompt_org_wide_dupes);

create unique index organization_pulse_prompts_org_wide_event_key_idx
  on public.organization_pulse_prompts (organization_id, event_key)
  where chapter_id is null;

comment on index public.organization_pulse_prompts_org_wide_event_key_idx is
  'One organization-wide pulse prompt per event_key; chapter-scoped uniqueness stays on UNIQUE (organization_id, chapter_id, event_key).';

commit;
