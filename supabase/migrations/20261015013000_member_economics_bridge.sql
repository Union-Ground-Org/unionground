-- REQ-UG-MEMBER-ECONOMICS-BRIDGE-20261012
--
-- Build-it-all campaign (project decision of October 12, 2026: "BUILD IT
-- ALL / EVERYTHING MUST ALWAYS CARRY ITS PROVANONCE"). An organization's own
-- economics (contract salary schedules, pay by position title, payroll,
-- overtime and budget figures, the bargaining brief, and the member
-- explainer) reach Union Ground only through an organization admin's import
-- and publish, never through a migration or a hard-coded list: no real
-- organization exists yet (Tenancy and launch onboarding contract).
--
-- Every item carries its provenance record (docs/conventions/provenance.md)
-- and the full records of the inputs it cites, so the source line under every
-- figure can name the publisher, the retrieval date and each input.
--   * import_member_economics_items: admin, advisor or vp of the selected
--     organization with MFA, bound to the organization the page rendered.
--     Refuses an item unless every prov- id it, its payload or any carried
--     record cites travels with it as a complete record, a pay schedule
--     without plans, grades and steps, and a pay-by-title cell under five
--     people. A re-imported item whose content changed returns to draft, so
--     changed figures are never live until published again.
--   * set_member_economics_item_status: the same roles publish or withdraw,
--     bound to the rendered organization the same way.
--   * list_member_economics_items: 'member' scope returns published member
--     items to any member; 'leader' scope returns published member and leader
--     items to advisors, admins and vps, the staff hats that reach Pay tools
--     (a coordinator hat has no Pay destination); 'manage' scope returns
--     every item, drafts included, to the importing roles.
-- No user id is stored; the tenant audit records the actor. The writers take
-- the case-graph entry lock first, like every audited writer.

begin;

set local lock_timeout = '5s';

create table private.content_member_economics_items (
  id uuid primary key default extensions.gen_random_uuid(),
  -- No foreign key: rows are written only by the RPCs below for the caller's
  -- selected organization, and organizations are never deleted (restrict).
  organization_id uuid not null,
  kind text not null check (kind in (
    'pay_schedule', 'pay_by_title', 'chapter_economics', 'bargaining_brief', 'member_explainer'
  )),
  item_key text not null check (item_key ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  chapter_code text check (chapter_code is null or chapter_code ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,31}$'),
  audience text not null check (audience in ('member', 'leader')),
  status text not null default 'draft' check (status in ('draft', 'published')),
  as_of date not null,
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object' and pg_catalog.octet_length(payload::text) <= 524288
  ),
  source_records jsonb not null check (
    jsonb_typeof(source_records) = 'array' and jsonb_array_length(source_records) <= 256
  ),
  imported_at timestamptz not null default pg_catalog.now(),
  status_changed_at timestamptz,
  provenance pg_catalog.jsonb not null,
  constraint content_member_economics_items_provenance_complete check (
    jsonb_typeof(provenance) = 'object'
    and coalesce(provenance ->> 'provenance_id', '') ~ '^prov-[0-9a-f]{64}$'
    and pg_catalog.btrim(coalesce(provenance -> 'source' ->> 'url', '')) ~ '^https?://'
    and pg_catalog.btrim(coalesce(provenance -> 'source' ->> 'publisher', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance ->> 'retrieved_at', '')) <> ''
    and coalesce(provenance ->> 'content_sha256', '') ~ '^[0-9a-f]{64}$'
    and pg_catalog.btrim(coalesce(provenance -> 'capture' ->> 'method', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance ->> 'as_of', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance -> 'review' ->> 'status', '')) <> ''
  ),
  constraint content_member_economics_items_key unique (organization_id, kind, item_key),
  -- The bargaining brief and the chapter payroll, overtime and budget figures
  -- are internal bargaining material: never member-facing.
  constraint content_member_economics_items_leader_kinds_only check (
    kind not in ('bargaining_brief', 'chapter_economics') or audience = 'leader'
  )
);

create index content_member_economics_items_scope_idx
  on private.content_member_economics_items (organization_id, audience, status, kind);

alter table private.content_member_economics_items enable row level security;
alter table private.content_member_economics_items force row level security;
revoke all on private.content_member_economics_items from public, anon, authenticated, service_role;
comment on table private.content_member_economics_items is
  'REQ-UG-MEMBER-ECONOMICS-BRIDGE-20261012: an organization''s imported economics items, each with its provenance record and cited input records; read and written only through the member economics RPCs.';

-- Admit the two member economics events. Keep every previously admitted type in
-- Main's newest order (20260925550500) and append the new tokens; the metadata
-- keys used (organizationId, entityType, entityId, action, status, fromStatus,
-- toStatus) are already admitted.
alter table public.organization_audit_events
  drop constraint organization_audit_events_event_type_check;

alter table public.organization_audit_events
  add constraint organization_audit_events_event_type_check check (event_type in (
    'first_organization_bootstrap', 'organization_membership_granted',
    'organization_membership_revoked', 'organization_role_granted',
    'organization_role_revoked', 'staff_mfa_policy_changed',
    'qa_question_asked', 'qa_official_replied', 'qa_follow_up_replied',
    'qa_answer_accepted', 'qa_answer_unaccepted', 'qa_vote_toggled',
    'qa_edited', 'qa_deleted', 'analytics_snapshot_read',
    'analytics_export_requested', 'pay_scale_grade_upserted',
    'pay_scale_step_upserted', 'integration_provider_changed',
    'integration_webhook_changed', 'integration_api_key_changed',
    'organization_job_acknowledged', 'organization_job_retry_requested',
    'survey_draft_saved', 'survey_published', 'survey_closed',
    'survey_reopened', 'survey_session_saved', 'survey_session_submitted',
    'case_deadline_extension_requested', 'case_deadline_change_reviewed',
    'case_deadline_applied', 'case_checklist_patched', 'case_step_advanced',
    'case_restriction_toggled', 'case_restriction_access_changed',
    'case_alert_acknowledged', 'case_alert_escalated',
    'case_reminder_created', 'case_reminder_disposed',
    'knowledge_file_uploaded', 'knowledge_file_reviewed',
    'knowledge_file_published_to_catalog', 'knowledge_file_downloaded',
    'knowledge_source_retried', 'knowledge_source_chunks_cleared',
    'contract_clause_created', 'contract_clause_updated',
    'contract_clause_retired', 'contract_clause_restored',
    'member_access_recorded', 'knowledge_collection_changed',
    'knowledge_collection_item_changed', 'knowledge_revision_restored',
    'knowledge_ingest_authorized', 'google_drive_operation_authorized',
    'member_handoff_initiated', 'member_handoff_acknowledged',
    'member_handoff_declined', 'member_handoff_cancelled',
    'member_profile_updated', 'member_profiles_bulk_updated',
    'welcome_campaign_saved', 'welcome_messages_queued',
    'member_operations_import_committed', 'dues_assessment_issued',
    'dues_manual_payment_recorded', 'dues_credit_event_applied',
    'dues_reminder_queued', 'dues_financial_identity_selected',
    'dues_financial_identity_provisioned', 'dues_stripe_connected',
    'dues_stripe_oauth_deferred', 'dues_stripe_oauth_failed',
    'dues_checkout_attention_resolved', 'dues_stripe_oauth_recovery_required',
    'organization_export_completed', 'public_interest_leads_read',
    'dues_stripe_disconnect_requested', 'dues_stripe_disconnected',
    'dues_stripe_disconnect_attention', 'chapter_space_controls_updated',
    'survey_reminders_queued', 'survey_privacy_floor_changed',
    'survey_operations_configured', 'survey_task_updated',
    'survey_response_review_updated', 'pulse_prompt_saved',
    'weekly_question_reviewed', 'weekly_question_policy_saved',
    'weekly_question_selection_run', 'live_poll_saved',
    'live_poll_transitioned',
    'member_operations_import_discarded',
    'welcome_campaign_step_saved', 'welcome_member_enrolled',
    'welcome_enrollment_transitioned',
    'member_economics_items_imported', 'member_economics_item_status_changed'
  ));

-- The provenance contract's required fields (docs/conventions/provenance.md),
-- applied to every record an item carries, not only to the item's own.
create function private.member_economics_record_complete(p_record jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_typeof(p_record) = 'object'
    and coalesce(p_record ->> 'provenance_id', '') ~ '^prov-[0-9a-f]{64}$'
    and coalesce(p_record -> 'source' ->> 'url', '') ~ '^https?://[^/?#@[:space:]]+([/?#][^[:space:]]*)?$'
    and pg_catalog.length(coalesce(p_record -> 'source' ->> 'url', '')) <= 2048
    and pg_catalog.btrim(coalesce(p_record -> 'source' ->> 'publisher', '')) <> ''
    -- What the shared SourceLine can date (src/lib/sourceLine.js): a real UTC
    -- timestamp. CASE runs the cast only on the matching shape; an impossible
    -- date such as February 30 raises 22008 and the import is refused.
    and case when coalesce(p_record ->> 'retrieved_at', '') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$'
      then (p_record ->> 'retrieved_at')::timestamptz is not null else false end
    and coalesce(p_record ->> 'content_sha256', '') ~ '^[0-9a-f]{64}$'
    and pg_catalog.btrim(coalesce(p_record -> 'capture' ->> 'method', '')) <> ''
    and pg_catalog.btrim(coalesce(p_record ->> 'as_of', '')) <> ''
    and pg_catalog.btrim(coalesce(p_record -> 'review' ->> 'status', '')) <> ''
    and pg_catalog.jsonb_typeof(coalesce(p_record -> 'derived_from', '[]'::jsonb)) = 'array'
$function$;

-- What the pages need to render, and the pay-by-title privacy floor: a
-- position-title cell under five people would show one person's pay.
create function private.member_economics_payload_valid(p_kind text, p_payload jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  -- CASE guards each length and cast: AND/OR operands have no evaluation order.
  select case p_kind
    when 'pay_schedule' then
      case when pg_catalog.jsonb_typeof(p_payload -> 'plans') = 'array'
        and pg_catalog.jsonb_typeof(p_payload -> 'effective_on') = 'string'
        and pg_catalog.jsonb_typeof(p_payload -> 'bargaining_units') = 'array' then
        pg_catalog.jsonb_array_length(p_payload -> 'plans') > 0
        and not exists (
          select 1 from pg_catalog.jsonb_array_elements(p_payload -> 'plans') p(plan)
           where case when pg_catalog.jsonb_typeof(p.plan -> 'grades') = 'array'
             and pg_catalog.jsonb_typeof(p.plan -> 'plan') = 'string' then
             pg_catalog.jsonb_array_length(p.plan -> 'grades') = 0
             or exists (
               select 1 from pg_catalog.jsonb_array_elements(p.plan -> 'grades') g(grade)
                where case when pg_catalog.jsonb_typeof(g.grade -> 'steps') = 'array'
                  and pg_catalog.jsonb_typeof(g.grade -> 'grade') in ('string', 'number') then
                  pg_catalog.jsonb_array_length(g.grade -> 'steps') = 0
                  or exists (
                    select 1 from pg_catalog.jsonb_array_elements(g.grade -> 'steps') s(step)
                     where pg_catalog.jsonb_typeof(s.step -> 'step') is distinct from 'number'
                        or pg_catalog.jsonb_typeof(s.step -> 'biweekly_cents') is distinct from 'number'
                  )
                else true end
             )
           else true end
        )
      else false end
    when 'pay_by_title' then
      case when pg_catalog.jsonb_typeof(p_payload -> 'titles') = 'array' then
        not exists (
          select 1 from pg_catalog.jsonb_array_elements(p_payload -> 'titles') t(title)
           where pg_catalog.jsonb_typeof(t.title -> 'title') is distinct from 'string'
        )
        and not exists (
          select 1
            from pg_catalog.jsonb_array_elements(p_payload -> 'titles') t(title)
            cross join lateral pg_catalog.jsonb_array_elements(
              case when pg_catalog.jsonb_typeof(t.title -> 'years') = 'array' then t.title -> 'years' else '[null]'::jsonb end
            ) y(cell)
           where case when pg_catalog.jsonb_typeof(y.cell -> 'headcount') = 'number'
             then (y.cell ->> 'headcount')::numeric < 5 else true end
        )
      else false end
    when 'member_explainer' then
      case when pg_catalog.jsonb_typeof(p_payload -> 'sections') = 'array'
        and pg_catalog.jsonb_typeof(p_payload -> 'title' -> 'en') = 'string'
        and (not (p_payload -> 'title' ? 'es') or pg_catalog.jsonb_typeof(p_payload -> 'title' -> 'es') = 'string') then
        pg_catalog.jsonb_array_length(p_payload -> 'sections') > 0
        and not exists (
          select 1 from pg_catalog.jsonb_array_elements(p_payload -> 'sections') x(section)
           where case when pg_catalog.jsonb_typeof(x.section -> 'en' -> 'body') = 'array'
             and pg_catalog.jsonb_typeof(x.section -> 'en' -> 'heading') = 'string'
             and pg_catalog.jsonb_typeof(x.section -> 'figures') = 'array'
             and pg_catalog.jsonb_typeof(x.section -> 'quotes') = 'array'
             and (not (x.section ? 'es') or (pg_catalog.jsonb_typeof(x.section -> 'es' -> 'body') = 'array'
               and pg_catalog.jsonb_typeof(x.section -> 'es' -> 'heading') = 'string'))
             -- The record each section's source line shows.
             and (not (x.section ? 'provenance') or private.member_economics_record_complete(x.section -> 'provenance')) then
             exists (
               select 1 from pg_catalog.jsonb_array_elements(x.section -> 'en' -> 'body') b(paragraph)
                where pg_catalog.jsonb_typeof(b.paragraph) <> 'string'
             )
             or exists (
               select 1 from pg_catalog.jsonb_array_elements(coalesce(x.section -> 'es' -> 'body', '[]'::jsonb)) b(paragraph)
                where pg_catalog.jsonb_typeof(b.paragraph) <> 'string'
             )
             or exists (
               select 1 from pg_catalog.jsonb_array_elements(x.section -> 'figures') f(figure)
                where pg_catalog.jsonb_typeof(f.figure -> 'en') is distinct from 'string'
                   or (f.figure ? 'es' and pg_catalog.jsonb_typeof(f.figure -> 'es') is distinct from 'string')
             )
             or exists (
               select 1 from pg_catalog.jsonb_array_elements(x.section -> 'quotes') q(quote)
                where pg_catalog.jsonb_typeof(q.quote -> 'text') is distinct from 'string'
             )
           else true end
        )
      else false end
    else true
  end
$function$;

revoke all on function private.member_economics_record_complete(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.member_economics_payload_valid(text, jsonb) from public, anon, authenticated, service_role;

create function public.import_member_economics_items(p_bundle jsonb, p_expected_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  item jsonb;
  missing text;
  imported integer;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  perform private.member_pin_require_full_session();
  -- Each call names the organization the page rendered, so a batch sent after
  -- the session switched account or organization is refused, not re-scoped.
  org := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p_bundle) is distinct from 'object'
     or p_bundle ->> 'format' is distinct from 'union-ground.member-economics/1'
     or pg_catalog.jsonb_typeof(p_bundle -> 'items') is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_bundle -> 'items') not between 1 and 200 then
    raise exception 'invalid member economics bundle' using errcode = '22023';
  end if;
  imported := 0;
  for item in select e.value from pg_catalog.jsonb_array_elements(p_bundle -> 'items') e loop
    if pg_catalog.jsonb_typeof(item -> 'provenance') is distinct from 'object'
       or pg_catalog.jsonb_typeof(item -> 'payload') is distinct from 'object'
       or pg_catalog.jsonb_typeof(item -> 'source_records') is distinct from 'array'
       or pg_catalog.jsonb_typeof(coalesce(item -> 'provenance' -> 'derived_from', '[]'::jsonb)) is distinct from 'array' then
      raise exception 'invalid member economics item' using errcode = '22023';
    end if;
    if not private.member_economics_record_complete(item -> 'provenance')
       or exists (
         select 1 from pg_catalog.jsonb_array_elements(item -> 'source_records') s(record)
          where not private.member_economics_record_complete(s.record)
       ) then
      raise exception 'member economics item carries an incomplete provenance record' using errcode = '22023';
    end if;
    if not private.member_economics_payload_valid(item ->> 'kind', item -> 'payload') then
      raise exception 'member economics item payload is not renderable or shows a cell under five people' using errcode = '22023';
    end if;
    -- Fail closed: every prov- id the item, its payload or any carried record
    -- cites must travel with it, so the whole chain resolves, not one level.
    select r.reference into missing
      from (
        select d.reference
          from pg_catalog.jsonb_array_elements_text(coalesce(item -> 'provenance' -> 'derived_from', '[]'::jsonb)) d(reference)
        union all
        select d.reference
          from pg_catalog.jsonb_array_elements(item -> 'source_records') s(record)
          cross join lateral pg_catalog.jsonb_array_elements_text(coalesce(s.record -> 'derived_from', '[]'::jsonb)) d(reference)
        union all
        select v #>> '{}'
          from pg_catalog.jsonb_path_query(item -> 'payload', 'lax $.**.provenance_id') v
        union all
        select v #>> '{}'
          from pg_catalog.jsonb_path_query(item -> 'payload', 'lax $.**.derived_from[*]') v
      ) r(reference)
     where r.reference like 'prov-%'
       and r.reference is distinct from item -> 'provenance' ->> 'provenance_id'
       and not exists (
         select 1 from pg_catalog.jsonb_array_elements(item -> 'source_records') s(record)
          where s.record ->> 'provenance_id' = r.reference
       )
     limit 1;
    if missing is not null then
      raise exception 'member economics item cites an input without its source record' using errcode = '22023';
    end if;
    insert into private.content_member_economics_items as t (
      organization_id, kind, item_key, chapter_code, audience, as_of, payload, source_records, provenance
    ) values (
      org, item ->> 'kind', item ->> 'item_key', nullif(item ->> 'chapter_code', ''), item ->> 'audience',
      (item ->> 'as_of')::date, item -> 'payload', item -> 'source_records', item -> 'provenance'
    )
    on conflict (organization_id, kind, item_key) do update
      set chapter_code = excluded.chapter_code,
          audience = excluded.audience,
          as_of = excluded.as_of,
          payload = excluded.payload,
          source_records = excluded.source_records,
          provenance = excluded.provenance,
          imported_at = pg_catalog.now(),
          -- Only a byte-identical re-import keeps its status; any change to
          -- what members would see, or to its sources, returns it to draft.
          status = case
            when (t.chapter_code, t.audience, t.as_of, t.payload, t.source_records, t.provenance)
                 is not distinct from
                 (excluded.chapter_code, excluded.audience, excluded.as_of, excluded.payload, excluded.source_records, excluded.provenance)
              then t.status
            else 'draft'
          end,
          status_changed_at = case
            when (t.chapter_code, t.audience, t.as_of, t.payload, t.source_records, t.provenance)
                 is not distinct from
                 (excluded.chapter_code, excluded.audience, excluded.as_of, excluded.payload, excluded.source_records, excluded.provenance)
              then t.status_changed_at
            else pg_catalog.now()
          end;
    imported := imported + 1;
  end loop;
  perform private.mi1_w2_write_audit(org, 'member_economics_items_imported', pg_catalog.jsonb_build_object(
    'organizationId', org, 'entityType', 'member_economics_bundle', 'action', 'import', 'status', 'draft'
  ));
  return pg_catalog.jsonb_build_object('ok', true, 'organizationId', org, 'imported', imported);
end;
$function$;

create function public.set_member_economics_item_status(p_item_id uuid, p_status text, p_expected_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  previous text;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  perform private.member_pin_require_full_session();
  org := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('draft', 'published') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  select i.status into previous
    from private.content_member_economics_items i
   where i.id = p_item_id and i.organization_id = org
   for update;
  if not found then
    raise exception 'item not found' using errcode = 'P0002';
  end if;
  update private.content_member_economics_items i
     set status = p_status, status_changed_at = pg_catalog.now()
   where i.id = p_item_id and i.organization_id = org;
  perform private.mi1_w2_write_audit(org, 'member_economics_item_status_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'entityType', 'member_economics_item', 'entityId', p_item_id,
    'fromStatus', previous, 'toStatus', p_status
  ));
  return pg_catalog.jsonb_build_object('ok', true, 'id', p_item_id, 'status', p_status);
end;
$function$;

create function public.list_member_economics_items(p_scope text default 'member', p_kind text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
begin
  perform private.member_pin_require_full_session();
  org := private.mi1_require_selected_organization();
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_scope = 'member' then
    if not private.is_organization_member(org) then
      raise exception 'not authorized' using errcode = '42501';
    end if;
  elsif p_scope = 'leader' then
    if not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
      raise exception 'not authorized' using errcode = '42501';
    end if;
  elsif p_scope = 'manage' then
    if not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
      raise exception 'not authorized' using errcode = '42501';
    end if;
  else
    raise exception 'invalid scope' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', i.id,
      'kind', i.kind,
      'itemKey', i.item_key,
      'chapterCode', i.chapter_code,
      'audience', i.audience,
      'status', i.status,
      'asOf', i.as_of,
      'payload', i.payload,
      'sourceRecords', i.source_records,
      'provenance', i.provenance,
      'importedAt', i.imported_at,
      'statusChangedAt', i.status_changed_at
    ) order by i.kind, i.chapter_code nulls first, i.item_key)
    from private.content_member_economics_items i
    where i.organization_id = org
      and (p_kind is null or i.kind = p_kind)
      and (
        p_scope = 'manage'
        or (i.status = 'published' and (i.audience = 'member' or p_scope = 'leader'))
      )
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.import_member_economics_items(jsonb, uuid) from public, anon, authenticated, service_role;
revoke all on function public.set_member_economics_item_status(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_member_economics_items(text, text) from public, anon, authenticated, service_role;
grant execute on function public.import_member_economics_items(jsonb, uuid) to authenticated;
grant execute on function public.set_member_economics_item_status(uuid, text, uuid) to authenticated;
grant execute on function public.list_member_economics_items(text, text) to authenticated;

commit;
