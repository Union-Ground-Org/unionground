-- SEC-UG-CASE-CSV-EXPORT-UNAUDITED-UNBOUNDED-20260917
--
-- The casework desks export the rows they are already rendering to CSV in the
-- browser. That construction stays: the rows are in hand, so the file creates
-- no new server read and no new authorization surface. What was missing is the
-- record that the export happened, and any bound on how much left in one go.
--
-- This migration adds both halves of that control.
--
-- 1. public.casework_audit_events.event_type gains one member, 'cases_exported'.
--    The enumeration is re-emitted exactly the way
--    20260917144000_casework_macros_case_note_mentions.sql re-emits it: drop the
--    CHECK, add it back with every previous member preserved plus the new one.
--
-- 2. public.casework_record_case_export writes exactly ONE audit row per export
--    and refuses the export otherwise. It is the only writer of that member.
--
-- WHY THE ROW CAN NEVER CARRY FREE TEXT
--
-- Every value that reaches the audit row is derived, never copied from a
-- caller-supplied string:
--
--   * actor_user_id  -- (select auth.uid()), not an argument;
--   * organization_id / chapter_id -- read from public.member_cases for the
--     exported ids, not from an argument;
--   * metadata.rowCount -- pg_catalog.cardinality() of the id array;
--   * metadata.scope -- constrained to exactly 'selection' or 'visible';
--   * metadata.caseIds -- uuid[] cast to jsonb, and uuids cannot hold prose;
--   * metadata.filterKeys -- constrained to the six facet NAMES the case list
--     publishes (step, caseType, assignee, deadline, status, chapter). The
--     facet's VALUE is never accepted, so the free-text search box and a
--     member's name can never enter the row even by accident;
--   * entity_id -- a fresh uuid minted here for the export itself.
--
-- There is no text argument whose contents survive into the row. The two text
-- inputs (p_scope, p_filter_keys) are both checked against closed literal
-- vocabularies and refused, not truncated or escaped, when they do not match.
-- Case titles, note bodies, member names and reference strings are never read
-- by this routine at all.
--
-- WHY THE READ GATE IS THE SHARED PREDICATE
--
-- Authorization is private.casework_staff_can_access(uuid) -- the same
-- predicate the casework RLS policies and every sibling casework routine use --
-- applied to every id in the request. No second predicate is introduced here:
-- an actor who cannot read a case cannot name it in an export, and the whole
-- request is refused rather than silently narrowed, so a partially authorized
-- export never produces a row that understates what left the browser.
--
-- WHY 500, AND WHY 100 FOR A SELECTION
--
-- The cap is a desk cap, not a data-volume cap. A coordinator queue page is a
-- few dozen cards and the loaded window is bounded by the desk loader; 500 rows
-- is already several screens of caseload and far more than any single review a
-- coordinator performs by hand, so it leaves an ordinary desk export untouched
-- while turning "take the whole caseload" into a refusal that has to be
-- repeated deliberately and is audited each time. A selection export is capped
-- at 100 to match src/lib/caseSelection.js SELECTION_LIMIT and
-- casework_bulk_update_cases, and because a selection is the one scope whose
-- ids are recorded: 100 uuids stay well inside the existing
-- casework_audit_metadata_bounded limit of 8192 bytes, where 500 would not.
-- A visible-slice export therefore records its filter facets and its count, and
-- a selection export records the ids -- exactly what each scope can honestly
-- name.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- casework_audit_events.event_type is a closed enumeration. The export needs
-- one more member; every existing value is preserved.
alter table public.casework_audit_events
  drop constraint casework_audit_events_event_type_check;
alter table public.casework_audit_events
  add constraint casework_audit_events_event_type_check check (event_type in (
    'strength_scored','deadline_requested','deadline_decided','checklist_created','checklist_item_changed',
    'step_advanced','restriction_changed','access_granted','access_revoked',
    'alert_created','alert_acknowledged','alert_escalated','behavior_logged',
    'retaliation_submitted','retaliation_withdrawn','pattern_detected',
    'draft_saved','bulk_updated','entity_linked','reminder_changed',
    'bargaining_changed','behavior_addendum_added','pattern_reviewed',
    'macro_saved','macro_applied','note_added','note_mentioned','case_assigned',
    'cases_exported'
  ));

-- The audited, bounded export receipt. Called BEFORE the browser writes the
-- file; a refusal here is a refusal to download.
--
-- security definer and the grant match the sibling casework audit writers in
-- 20260917144000 (casework_save_macro, casework_apply_macro,
-- casework_add_case_note): the routine has to insert into
-- public.casework_audit_events, whose RLS admits no client INSERT, and the
-- authorization it performs is the shared staff predicate rather than the
-- caller's own row visibility.
create or replace function public.casework_record_case_export(
  p_case_ids uuid[],
  p_scope text,
  p_filter_keys text[] default '{}'::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_scope text;
  v_filters text[];
  v_count integer;
  v_readable integer;
  v_org uuid;
  v_org_count integer;
  v_chapter text;
  v_chapter_count integer;
  v_export_id uuid;
begin
  -- Case graph gate first, before any declaration initializer, authorization
  -- read or row acquisition: this routine writes public.casework_audit_events,
  -- which carries both an auth.users and a member_cases reference.
  perform private.lock_case_graph(array[(select auth.uid())], p_case_ids);
  perform private.casework_require_mfa();

  v_scope := pg_catalog.btrim(coalesce(p_scope, ''));
  if v_scope not in ('selection', 'visible') then
    raise exception 'export scope must be selection or visible' using errcode = '22023';
  end if;

  -- The count is derived, never asserted by the caller: the number in the audit
  -- row is the number of cases the caller had to name and pass the read gate
  -- for, so it cannot understate the export.
  --
  -- DISTINCT, because the read gate below counts distinct ids: counting the
  -- raw array would let a request with a repeated id record a rowCount above
  -- the number of cases that actually left the browser, and both caps would be
  -- measured against a number that is not the export's size either.
  select pg_catalog.count(distinct entry.id) into v_count
  from pg_catalog.unnest(coalesce(p_case_ids, '{}'::uuid[])) as entry(id);
  if v_count not between 1 and 500 then
    raise exception 'an export is limited to 500 cases' using errcode = '22023';
  end if;
  if v_scope = 'selection' and v_count > 100 then
    raise exception 'a selection export is limited to 100 cases' using errcode = '22023';
  end if;
  if pg_catalog.array_position(p_case_ids, null) is not null then
    raise exception 'export case ids must not be null' using errcode = '22023';
  end if;

  -- Closed vocabulary of facet NAMES. The facet's value never travels.
  v_filters := coalesce(p_filter_keys, '{}'::text[]);
  if pg_catalog.cardinality(v_filters) > 6 then
    raise exception 'export filter keys are not recognized' using errcode = '22023';
  end if;
  if exists (
    select 1 from pg_catalog.unnest(v_filters) as entry(key)
    where entry.key is null
      or entry.key not in ('step', 'caseType', 'assignee', 'deadline', 'status', 'chapter')
  ) then
    raise exception 'export filter keys are not recognized' using errcode = '22023';
  end if;

  -- The shared staff predicate, applied to every id. Distinct ids are counted
  -- so a repeated id cannot stand in for one the actor may not read.
  select pg_catalog.count(distinct c.id), pg_catalog.count(distinct c.organization_id),
         pg_catalog.count(distinct c.chapter_id)
    into v_readable, v_org_count, v_chapter_count
  from public.member_cases c
  where c.id = any(p_case_ids)
    and private.casework_staff_can_access(c.id);
  if v_readable <> v_count then
    raise exception 'export selection is not authorized' using errcode = 'P0002';
  end if;
  -- One tenant per export, exactly as casework_apply_macro requires: the audit
  -- row carries one organization_id, so a cross-organization export could not
  -- be recorded honestly in a single row.
  if v_org_count <> 1 then
    raise exception 'an export covers one organization' using errcode = '22023';
  end if;
  -- One row is enough: v_org_count has already proved the tenant is unique.
  select c.organization_id into v_org
  from public.member_cases c where c.id = any(p_case_ids) limit 1;
  -- chapter_id is left null when the export spans chapters rather than naming
  -- one of them arbitrarily.
  if v_chapter_count = 1 then
    select c.chapter_id into v_chapter
    from public.member_cases c where c.id = any(p_case_ids) and c.chapter_id is not null limit 1;
  end if;

  v_export_id := extensions.gen_random_uuid();
  -- case_id stays null: an export is not an event on one case, and the
  -- composite member_cases reference is satisfied by the null key. The ids are
  -- recorded in metadata for a selection, where they fit the 8192-byte
  -- metadata bound; a visible-slice export records its facets and its count.
  insert into public.casework_audit_events(
    organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_org, v_chapter, null, (select auth.uid()),
    'cases_exported', 'case_export', v_export_id,
    pg_catalog.jsonb_build_object(
      'scope', v_scope,
      'rowCount', v_count,
      'filterKeys', pg_catalog.to_jsonb(v_filters))
    || (case when v_scope = 'selection'
          then pg_catalog.jsonb_build_object('caseIds',
                 (select pg_catalog.jsonb_agg(distinct entry.id)
                  from pg_catalog.unnest(p_case_ids) as entry(id)))
          else '{}'::jsonb end));

  return pg_catalog.jsonb_build_object(
    'exportId', v_export_id, 'scope', v_scope, 'rowCount', v_count,
    'limit', 500, 'selectionLimit', 100);
end;
$function$;

revoke all on function public.casework_record_case_export(uuid[], text, text[]) from public, anon;
grant execute on function public.casework_record_case_export(uuid[], text, text[]) to authenticated;

comment on function public.casework_record_case_export(uuid[], text, text[]) is
  'SEC-UG-CASE-CSV-EXPORT-UNAUDITED-UNBOUNDED-20260917: records exactly one cases_exported casework_audit_events row for a desk CSV export and refuses it above 500 cases (100 for a selection) or for any case the caller cannot read under private.casework_staff_can_access. Every recorded value is derived or drawn from a closed vocabulary, so the row can never carry case, note or member text.';

-- SEC-UG-CASE-CSV-EXPORT-UNAUDITED-UNBOUNDED-20260917, review finding M1.
--
-- public.list_casework_audit_events is the only surfaced reader of this sink,
-- and its p_kind vocabulary is a hardcoded literal array from
-- 20260828210000. A receipt nobody can filter for is not reviewable evidence,
-- so the reader is re-emitted here with exactly one new member,
-- 'cases_exported'. Nothing else in the routine changes: the same bounds
-- helper, the same organization scope, the same two-branch authorization
-- (organization role, or staff access to the row's own case), and the bounded
-- metadata payload still never leaves the function.
--
-- Only this lane's member is added. The five members that
-- 20260917144000_casework_macros_case_note_mentions.sql introduced
-- ('macro_saved', 'macro_applied', 'note_added', 'note_mentioned',
-- 'case_assigned') are also missing from this array; that is a pre-existing
-- gap in a different lane's delivery and is registered separately rather than
-- widened here, where it would travel without its own proof.
--
-- The routine is a read: it takes no row lock and writes no case-graph
-- relation, so it carries no private.lock_case_graph gate. Because this file
-- is casework-named it now owns the definition for the case-graph inventory,
-- which is why it is registered as a reviewed read-only exception in
-- scripts/account-case-graph-review.json, exactly as the sibling casework read
-- RPCs are.

create or replace function public.list_casework_audit_events(
  p_limit integer default 50,
  p_before timestamptz default null,
  p_before_id bigint default null,
  p_kind text default null,
  p_since timestamptz default null,
  p_until timestamptz default null,
  p_case_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  clamped integer;
begin
  if p_kind is not null
     and p_kind <> all (array[
       'strength_scored', 'deadline_requested', 'deadline_decided', 'checklist_created',
       'checklist_item_changed', 'step_advanced', 'restriction_changed', 'access_granted',
       'access_revoked', 'alert_created', 'alert_acknowledged', 'alert_escalated',
       'behavior_logged', 'retaliation_submitted', 'retaliation_withdrawn', 'pattern_detected',
       'draft_saved', 'bulk_updated', 'entity_linked', 'reminder_changed', 'bargaining_changed',
       'behavior_addendum_added', 'pattern_reviewed',
       'cases_exported'
     ]) then
    raise exception 'unknown casework audit event kind' using errcode = '22023';
  end if;
  clamped := private.audit_sink_read_bounds(p_limit, p_before, p_before_id is not null, p_since, p_until);

  return coalesce((
    select pg_catalog.jsonb_agg(page.item order by page.created_at desc, page.id desc)
    from (
      select
        a.created_at,
        a.id,
        pg_catalog.jsonb_build_object(
          'id', a.id,
          'source', 'casework_audit_events',
          'organizationId', a.organization_id,
          'chapterId', a.chapter_id,
          'kind', a.event_type,
          'caseId', a.case_id,
          'entityId', a.entity_id,
          'actorUserId', a.actor_user_id,
          'createdAt', a.created_at
        ) as item
      from public.casework_audit_events a
      where a.organization_id = org
        and (p_case_id is null or a.case_id = p_case_id)
        and (p_kind is null or a.event_type = p_kind)
        and (p_since is null or a.created_at >= p_since)
        and (p_until is null or a.created_at <= p_until)
        and (p_before is null or (a.created_at, a.id) < (p_before, p_before_id))
        and (
          private.has_organization_role(a.organization_id, array['coordinator', 'advisor', 'admin', 'vp'])
          or (a.case_id is not null and private.casework_staff_can_access(a.case_id))
        )
      order by a.created_at desc, a.id desc
      limit clamped
    ) page
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_casework_audit_events(integer, timestamptz, bigint, text, timestamptz, timestamptz, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_casework_audit_events(integer, timestamptz, bigint, text, timestamptz, timestamptz, uuid)
  to authenticated;

comment on function public.list_casework_audit_events(integer, timestamptz, bigint, text, timestamptz, timestamptz, uuid) is
  'Paged organization-scoped read of the casework audit event sink; mirrors the table policy and never returns the bounded metadata payload. Kind vocabulary includes cases_exported (SEC-UG-CASE-CSV-EXPORT-UNAUDITED-UNBOUNDED-20260917).';

notify pgrst, 'reload schema';

commit;
