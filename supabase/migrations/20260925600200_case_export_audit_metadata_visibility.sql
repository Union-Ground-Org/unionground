-- SEC-UG-CASE-EXPORT-AUDIT-METADATA-VISIBILITY-20260921
--
-- public.casework_audit_events is a directly client-readable table:
-- 20260828210000 grants SELECT on it to authenticated, and
-- casework_audit_events_staff_read is the whole boundary. That policy gates a
-- case-scoped row on the parent case being visible under the member_cases
-- policies -- "a restricted case's audit trail requires a casework_access_grants
-- row" -- but admits a null-case row to any organization coordinator, because a
-- null-case row is a tenant event rather than a case event.
--
-- 20260918202000 records the export receipt as exactly such a null-case row,
-- deliberately: an export is not an event on one case. Its selection branch
-- also wrote the exported case ids verbatim into metadata.caseIds, so the
-- identifiers of cases the reading coordinator is not authorized for travelled
-- in a projection wider than the case-visibility boundary the policy states.
--
-- Re-emit public.casework_record_case_export unchanged except for that one
-- metadata key. A selection now records metadata.caseIdDigests: one digest per
-- distinct exported case id, salted with the receipt's own export id, which the
-- row already carries in the clear as entity_id.
--
--   digest = left(encode(digest(exportId || ':' || caseId, 'sha256'), 'hex'), 32)
--
-- What that keeps:
--   * the receipt is still one row per export, still naming the actor, the
--     tenant, the scope, the derived row count and the facet names, so the
--     export remains auditable;
--   * a reader who is authorized for a case holds its id, so they can recompute
--     the digest and settle whether that case was in the export -- an authorized
--     reviewer can still reconstruct the selection case by case;
--   * a reader who is not authorized for a case gains nothing from the row: a
--     128-bit digest of a version 4 uuid is not enumerable, and the per-export
--     salt keeps two receipts naming the same case from correlating.
--
-- Size: 32 hex characters per case is the same order as the 36-character uuid
-- it replaces, so a 100-case selection still fits inside the 8192-byte
-- casework_audit_metadata_bounded limit that the selection cap was chosen for.
--
-- Nothing else moves: the same case-graph gate ahead of every initializer, the
-- same MFA gate, the same closed scope and filter-key vocabularies, the same
-- derived distinct count, the same two caps, the same shared staff read
-- predicate applied to every id, the same one-tenant rule, the same chapter
-- derivation, the same return value and the same grants.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

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
  -- composite member_cases reference is satisfied by the null key. The row is
  -- therefore readable by an organization coordinator who is not authorized for
  -- every exported case, so a selection records one salted digest per case id
  -- rather than the id itself: a reader who already holds a case id can prove
  -- the case was in this export, and a reader who does not learns nothing. A
  -- visible-slice export records its facets and its count.
  insert into public.casework_audit_events(
    organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_org, v_chapter, null, (select auth.uid()),
    'cases_exported', 'case_export', v_export_id,
    pg_catalog.jsonb_build_object(
      'scope', v_scope,
      'rowCount', v_count,
      'filterKeys', pg_catalog.to_jsonb(v_filters))
    || (case when v_scope = 'selection'
          then pg_catalog.jsonb_build_object('caseIdDigests',
                 (select pg_catalog.jsonb_agg(distinct pg_catalog.left(
                    pg_catalog.encode(
                      extensions.digest(v_export_id::text || ':' || entry.id::text, 'sha256'),
                      'hex'), 32))
                  from pg_catalog.unnest(p_case_ids) as entry(id)))
          else '{}'::jsonb end));

  return pg_catalog.jsonb_build_object(
    'exportId', v_export_id, 'scope', v_scope, 'rowCount', v_count,
    'limit', 500, 'selectionLimit', 100);
end;
$function$;

revoke all on function public.casework_record_case_export(uuid[], text, text[]) from public, anon, service_role;
grant execute on function public.casework_record_case_export(uuid[], text, text[]) to authenticated;

comment on function public.casework_record_case_export(uuid[], text, text[]) is
  'SEC-UG-CASE-EXPORT-AUDIT-METADATA-VISIBILITY-20260921: records exactly one cases_exported casework_audit_events row for a desk CSV export and refuses it above 500 cases (100 for a selection) or for any case the caller cannot read under private.casework_staff_can_access. Every recorded value is derived or drawn from a closed vocabulary, so the row can never carry case, note or member text. The receipt is a null-case row, which a plain organization coordinator may read, so a selection records metadata.caseIdDigests -- left(encode(digest(entity_id || '':'' || caseId, ''sha256''), ''hex''), 32) per distinct case -- instead of the case ids: an authorized reader recomputes the digest from the id they already hold, an unauthorized one reads no identifier.';

notify pgrst, 'reload schema';

commit;
