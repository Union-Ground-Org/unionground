-- SEC-UG-AUTOMATION-PREVIEW-UNBOUNDED-CALL-RATE-20260920
--
-- public.mi1_preview_automation_definition (live body 20260911070000) and
-- public.preview_organization_automation_run (live body 20260910045839) each
-- re-ran the candidate scan and unconditionally wrote an
-- organization_automation_runs 'preview' row plus an automation_run_previewed
-- organization_audit_ledger row on every call, with no cap or cooldown.
--
-- Both now call private.automation_preview_admit(org, actor) right after the
-- organization is resolved and before the candidate scan or any write. The
-- documented bound is 60 previews per (organization, actor) per rolling
-- 10 minutes, counted from the actor's own mode = 'preview' run rows, so both
-- entry points share one allowance, another actor's allowance is untouched,
-- and manual and scheduled runs are never counted. A call over the bound is
-- refused with errcode 54000 and writes nothing. A per-(organization, actor)
-- transaction advisory lock serializes the count so concurrent calls cannot
-- both pass at the bound; a partial index keys the rolling-window lookup.
-- Headroom: the connected-automation verifier, one admin exercising every
-- recipe in one session, previews 26 times.
--
-- Everything else in each body is unchanged, including the case-graph lock
-- statement (the installed wrapper on preview_organization_automation_run).
-- Grants on both RPCs are preserved by CREATE OR REPLACE.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create index if not exists organization_automation_runs_preview_actor_idx
  on public.organization_automation_runs (organization_id, initiated_by, created_at)
  where mode = 'preview';

create or replace function private.automation_preview_admit(p_org uuid, p_actor uuid)
returns void
language plpgsql
set search_path = ''
as $function$
declare
  recent_previews integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if p_org is null or p_actor is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('automation-preview:' || p_org::text || ':' || p_actor::text, 509)
  );
  select count(*)::integer into recent_previews
  from public.organization_automation_runs r
  where r.organization_id = p_org
    and r.initiated_by = p_actor
    and r.mode = 'preview'
    and r.created_at > pg_catalog.now() - interval '10 minutes';
  -- 60 previews per organization and actor per rolling 10 minutes.
  if recent_previews >= 60 then
    raise exception 'automation preview limit reached: 60 per 10 minutes' using errcode = '54000';
  end if;
end;
$function$;

revoke all on function private.automation_preview_admit(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.mi1_preview_automation_definition(p_definition_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid;
  org uuid;
  definition_row public.organization_automation_definitions%rowtype;
  run_row public.organization_automation_runs%rowtype;
  candidate_total integer;
  effect_limit integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  actor := (select auth.uid());
  org := private.automation_v3_require_author();
  perform private.automation_preview_admit(org, actor);
  effect_limit := 20;
  select d.* into definition_row
  from public.organization_automation_definitions d
  where d.id = p_definition_id
    and d.organization_id = org
    and d.status <> 'archived'
    and private.automation_v3_definition_visible(d, actor, org);
  if definition_row.id is null then raise exception 'automation definition unavailable' using errcode = '42501'; end if;
  select count(*)::integer into candidate_total
  from private.automation_v2_candidates(definition_row.id) c
  where private.automation_v3_source_visible(actor, org, c.source_kind, c.source_id);
  select coalesce(s.max_effects_per_run, 20) into effect_limit
  from (select 1) seed left join public.organization_automation_settings s on s.organization_id = org;
  run_row.id := extensions.gen_random_uuid();
  run_row.confirmation_phrase := 'RUN ' || pg_catalog.upper(pg_catalog.left(run_row.id::text, 8));
  insert into public.organization_automation_runs (
    id, organization_id, definition_id, definition_version, mode, status,
    candidates_count, effects_skipped, confirmation_phrase, initiated_by, completed_at, definition_snapshot
  ) values (
    run_row.id, org, definition_row.id, definition_row.version, 'preview', 'previewed',
    candidate_total, greatest(candidate_total - effect_limit, 0), run_row.confirmation_phrase, actor, pg_catalog.now(),
    private.automation_v2_definition_json(definition_row)
  ) returning * into run_row;
  perform private.cr108_record_audit(org, 'automation_run_previewed', 'read', 'automation_run', run_row.id::text, actor,
    pg_catalog.jsonb_build_object('runId', run_row.id, 'count', candidate_total), extensions.gen_random_uuid());
  return pg_catalog.jsonb_build_object(
    'id', run_row.id, 'definitionId', definition_row.id, 'definitionName', definition_row.name,
    'mode', 'preview', 'status', 'previewed', 'candidatesCount', candidate_total,
    'willCreate', least(candidate_total, effect_limit),
    'effectsSkipped', greatest(candidate_total - effect_limit, 0),
    'confirmationPhrase', run_row.confirmation_phrase,
    'settingsEnabled', coalesce((select s.enabled from public.organization_automation_settings s where s.organization_id = org), false)
  );
end;
$function$;

create or replace function public.preview_organization_automation_run(p_definition_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  actor uuid := (select auth.uid());
  org uuid := private.cr108_require_operator();
  definition_row public.organization_automation_definitions%rowtype;
  run_row public.organization_automation_runs%rowtype;
  candidate_total integer;
  effect_limit integer := 20;
begin
  perform private.automation_preview_admit(org, actor);
  select d.* into definition_row
  from public.organization_automation_definitions d
  where d.id = p_definition_id
    and d.organization_id = org
    and d.status <> 'archived';
  if definition_row.id is null then
    raise exception 'automation definition unavailable' using errcode = '22023';
  end if;

  select coalesce(s.max_effects_per_run, 20) into effect_limit
  from (select 1) seed
  left join public.organization_automation_settings s
    on s.organization_id = org;

  candidate_total := private.cr108_candidate_count(
    org, definition_row.id, definition_row.trigger_kind, definition_row.threshold_days
  );

  insert into public.organization_automation_runs (
    organization_id, definition_id, definition_version, mode, status,
    candidates_count, effects_skipped, confirmation_phrase, initiated_by,
    completed_at, definition_snapshot
  ) values (
    org, definition_row.id, definition_row.version, 'preview', 'previewed',
    candidate_total, greatest(candidate_total - effect_limit, 0),
    null, actor, pg_catalog.now(), private.automation_v2_definition_json(definition_row)
  ) returning * into run_row;

  run_row.confirmation_phrase := 'RUN ' || pg_catalog.upper(pg_catalog.left(run_row.id::text, 8));
  update public.organization_automation_runs
     set confirmation_phrase = run_row.confirmation_phrase
   where id = run_row.id;

  perform private.cr108_record_audit(
    org, 'automation_run_previewed', 'read', 'automation_run',
    run_row.id::text, actor,
    pg_catalog.jsonb_build_object(
      'runId', run_row.id, 'status', 'previewed',
      'count', candidate_total, 'cadence', definition_row.cadence
    ),
    extensions.gen_random_uuid()
  );

  return pg_catalog.jsonb_build_object(
    'id', run_row.id,
    'definitionId', definition_row.id,
    'definitionName', definition_row.name,
    'mode', 'preview',
    'status', 'previewed',
    'candidatesCount', candidate_total,
    'willCreate', least(candidate_total, effect_limit),
    'effectsSkipped', greatest(candidate_total - effect_limit, 0),
    'confirmationPhrase', run_row.confirmation_phrase,
    'settingsEnabled', coalesce((
      select s.enabled from public.organization_automation_settings s
      where s.organization_id = org
    ), false)
  );
end;
end;
$function$;

commit;
