-- MI1 CR-068 contract clause quick reference.
-- Empty on reset. Callers never supply an authoritative organization_id.
-- Writes send the expected selected organization as a compare-and-set token.

set local lock_timeout = '5s';

alter table public.organization_audit_events
  drop constraint organization_audit_events_event_type_check,
  drop constraint organization_audit_events_metadata_keys;

alter table public.organization_audit_events
  add constraint organization_audit_events_event_type_check check (event_type in (
    'first_organization_bootstrap',
    'organization_membership_granted',
    'organization_membership_revoked',
    'organization_role_granted',
    'organization_role_revoked',
    'staff_mfa_policy_changed',
    'qa_question_asked',
    'qa_official_replied',
    'qa_follow_up_replied',
    'qa_answer_accepted',
    'qa_answer_unaccepted',
    'qa_vote_toggled',
    'qa_edited',
    'qa_deleted',
    'analytics_snapshot_read',
    'analytics_export_requested',
    'pay_scale_grade_upserted',
    'pay_scale_step_upserted',
    'integration_provider_changed',
    'integration_webhook_changed',
    'integration_api_key_changed',
    'organization_job_acknowledged',
    'organization_job_retry_requested',
    'survey_draft_saved',
    'survey_published',
    'survey_closed',
    'survey_reopened',
    'survey_session_saved',
    'survey_session_submitted',
    'case_deadline_extension_requested',
    'case_deadline_change_reviewed',
    'case_deadline_applied',
    'case_checklist_patched',
    'case_step_advanced',
    'case_restriction_toggled',
    'case_restriction_access_changed',
    'case_alert_acknowledged',
    'case_alert_escalated',
    'case_reminder_created',
    'case_reminder_disposed',
    'knowledge_file_uploaded',
    'knowledge_file_reviewed',
    'knowledge_file_published_to_catalog',
    'knowledge_file_downloaded',
    'knowledge_source_retried',
    'knowledge_source_chunks_cleared',
    'member_handoff_initiated',
    'member_handoff_acknowledged',
    'member_handoff_declined',
    'member_handoff_cancelled',
    'contract_clause_created',
    'contract_clause_updated',
    'contract_clause_retired',
    'contract_clause_restored'
  )),
  add constraint organization_audit_events_metadata_keys check (
    metadata - array[
      'organizationId', 'chapterId', 'slug', 'name', 'role', 'userId',
      'status', 'requireStaffMfa', 'questionId', 'replyId', 'targetKind',
      'voted', 'kind', 'surface', 'exportFormat', 'rowCount', 'suppressedCount',
      'expiresAt', 'grade', 'stepNumber', 'effectiveOn', 'action', 'provider',
      'host', 'events', 'entityType', 'entityId', 'fromStatus', 'toStatus',
      'fromRole', 'toRole', 'eventType', 'domain', 'jobName', 'runId',
      'remediation', 'outcome', 'count', 'fieldsChanged', 'reasonCode',
      'exportType', 'cadence', 'surveyId', 'sessionId', 'privacyMinResponses',
      'caseId', 'fromStep', 'toStep', 'previousDeadline', 'newDeadline',
      'alertId', 'reminderId', 'restricted', 'fileId', 'sourceId', 'category',
      'library', 'reviewStatus', 'indexStatus', 'byteSize', 'action',
      'handoffId', 'fromStewardId', 'toStewardId', 'clauseId', 'article'
    ] = '{}'::jsonb
  );

create table public.contract_clauses (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  article text not null,
  section text,
  category text not null,
  title text not null,
  summary text not null,
  full_text text,
  keywords text[] not null default '{}'::text[],
  sort_order integer not null default 0,
  status text not null default 'published' check (status in ('published', 'retired')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint contract_clauses_article_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(article)) between 1 and 32
    and article !~ '[[:cntrl:]]'
  ),
  constraint contract_clauses_section_bounded check (
    section is null
    or (
      pg_catalog.char_length(pg_catalog.btrim(section)) between 1 and 32
      and section !~ '[[:cntrl:]]'
    )
  ),
  constraint contract_clauses_category_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(category)) between 1 and 80
    and category !~ '[[:cntrl:]]'
  ),
  constraint contract_clauses_title_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 200
    and title !~ '[[:cntrl:]]'
  ),
  constraint contract_clauses_summary_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(summary)) between 1 and 2000
    and summary !~ '[[:cntrl:]]'
  ),
  constraint contract_clauses_full_text_bounded check (
    full_text is null
    or (
      pg_catalog.char_length(pg_catalog.btrim(full_text)) between 1 and 20000
      and full_text !~ '[[:cntrl:]]'
    )
  ),
  constraint contract_clauses_keywords_bounded check (
    pg_catalog.cardinality(keywords) <= 24
  ),
  constraint contract_clauses_sort_order_bounded check (sort_order between 0 and 99999)
);

create unique index contract_clauses_org_article_section_idx
  on public.contract_clauses (
    organization_id,
    pg_catalog.lower(pg_catalog.btrim(article)),
    pg_catalog.lower(pg_catalog.btrim(coalesce(section, '')))
  );

create index contract_clauses_org_status_idx
  on public.contract_clauses (organization_id, status, sort_order, article);

alter table public.contract_clauses enable row level security;

create policy contract_clauses_select_member on public.contract_clauses
  for select to authenticated
  using (
    private.is_organization_member(organization_id)
    and (
      status = 'published'
      or private.has_organization_role(
        organization_id,
        array['steward', 'coordinator', 'advisor', 'admin', 'vp']
      )
    )
  );

create policy mfa_assurance on public.contract_clauses
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on public.contract_clauses from public, anon, authenticated;
grant select on public.contract_clauses to authenticated;

create function public.list_contract_clauses()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  staff boolean;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  staff := private.has_organization_role(
    org,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  );
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id,
      'organizationId', c.organization_id,
      'article', c.article,
      'section', c.section,
      'category', c.category,
      'title', c.title,
      'summary', c.summary,
      'fullText', c.full_text,
      'keywords', c.keywords,
      'sortOrder', c.sort_order,
      'status', c.status
    ) order by c.sort_order, c.article)
    from public.contract_clauses c
    where c.organization_id = org
      and (staff or c.status = 'published')
  ), '[]'::jsonb);
end;
$function$;

create function public.list_contract_clause_grievance_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'article', counts.article,
      'count', counts.n
    ) order by counts.article)
    from (
      select pg_catalog.lower(pg_catalog.btrim(c.article)) as article,
             pg_catalog.count(*)::integer as n
      from public.contract_clauses c
      join public.member_cases cs
        on cs.organization_id = c.organization_id
       and cs.articles is not null
       and pg_catalog.btrim(cs.articles) <> ''
       and (
         ',' || pg_catalog.regexp_replace(
           pg_catalog.lower(pg_catalog.btrim(cs.articles)),
           '[[:space:]]*[,;/]+[[:space:]]*',
           ',',
           'g'
         ) || ','
       ) like '%,' || pg_catalog.lower(pg_catalog.btrim(c.article)) || ',%'
      where c.organization_id = org
      group by pg_catalog.lower(pg_catalog.btrim(c.article))
    ) counts
  ), '[]'::jsonb);
end;
$function$;

create function public.create_contract_clause(
  p_expected_organization_id uuid,
  p_article text,
  p_section text,
  p_category text,
  p_title text,
  p_summary text,
  p_full_text text,
  p_keywords text[],
  p_sort_order integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  saved public.contract_clauses%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(
    org,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  insert into public.contract_clauses (
    organization_id, article, section, category, title, summary, full_text, keywords, sort_order, created_by
  ) values (
    org,
    pg_catalog.btrim(p_article),
    nullif(pg_catalog.btrim(coalesce(p_section, '')), ''),
    pg_catalog.btrim(p_category),
    pg_catalog.btrim(p_title),
    pg_catalog.btrim(p_summary),
    nullif(pg_catalog.btrim(coalesce(p_full_text, '')), ''),
    coalesce(p_keywords, '{}'::text[]),
    coalesce(p_sort_order, 0),
    (select auth.uid())
  )
  returning * into saved;
  perform private.mi1_write_tenant_audit(org, 'contract_clause_created', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'clauseId', saved.id,
    'article', saved.article,
    'action', 'create',
    'status', saved.status
  ));
  return pg_catalog.jsonb_build_object('ok', true, 'id', saved.id, 'organizationId', org);
end;
$function$;

create function public.update_contract_clause(
  p_expected_organization_id uuid,
  p_id uuid,
  p_article text,
  p_section text,
  p_category text,
  p_title text,
  p_summary text,
  p_full_text text,
  p_keywords text[],
  p_sort_order integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  saved public.contract_clauses%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(
    org,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update public.contract_clauses c
  set article = pg_catalog.btrim(p_article),
      section = nullif(pg_catalog.btrim(coalesce(p_section, '')), ''),
      category = pg_catalog.btrim(p_category),
      title = pg_catalog.btrim(p_title),
      summary = pg_catalog.btrim(p_summary),
      full_text = nullif(pg_catalog.btrim(coalesce(p_full_text, '')), ''),
      keywords = coalesce(p_keywords, '{}'::text[]),
      sort_order = coalesce(p_sort_order, 0),
      updated_at = pg_catalog.now()
  where c.id = p_id
    and c.organization_id = org
  returning * into saved;
  if saved.id is null then
    raise exception 'clause not found' using errcode = 'P0002';
  end if;
  perform private.mi1_write_tenant_audit(org, 'contract_clause_updated', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'clauseId', saved.id,
    'article', saved.article,
    'action', 'update',
    'status', saved.status
  ));
  return pg_catalog.jsonb_build_object('ok', true, 'id', saved.id, 'organizationId', org);
end;
$function$;

create function public.set_contract_clause_status(
  p_expected_organization_id uuid,
  p_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  saved public.contract_clauses%rowtype;
  event_name text;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(
    org,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_status not in ('published', 'retired') then
    raise exception 'invalid clause status' using errcode = '22023';
  end if;
  update public.contract_clauses c
  set status = p_status,
      updated_at = pg_catalog.now()
  where c.id = p_id
    and c.organization_id = org
  returning * into saved;
  if saved.id is null then
    raise exception 'clause not found' using errcode = 'P0002';
  end if;
  event_name := case when p_status = 'retired' then 'contract_clause_retired' else 'contract_clause_restored' end;
  perform private.mi1_write_tenant_audit(org, event_name, pg_catalog.jsonb_build_object(
    'organizationId', org,
    'clauseId', saved.id,
    'article', saved.article,
    'action', case when p_status = 'retired' then 'retire' else 'restore' end,
    'status', saved.status
  ));
  return pg_catalog.jsonb_build_object('ok', true, 'id', saved.id, 'organizationId', org, 'status', saved.status);
end;
$function$;

revoke all on function public.list_contract_clauses() from public, anon;
revoke all on function public.list_contract_clause_grievance_counts() from public, anon;
revoke all on function public.create_contract_clause(uuid, text, text, text, text, text, text, text[], integer) from public, anon;
revoke all on function public.update_contract_clause(uuid, uuid, text, text, text, text, text, text, text[], integer) from public, anon;
revoke all on function public.set_contract_clause_status(uuid, uuid, text) from public, anon;

grant execute on function public.list_contract_clauses() to authenticated;
grant execute on function public.list_contract_clause_grievance_counts() to authenticated;
grant execute on function public.create_contract_clause(uuid, text, text, text, text, text, text, text[], integer) to authenticated;
grant execute on function public.update_contract_clause(uuid, uuid, text, text, text, text, text, text, text[], integer) to authenticated;
grant execute on function public.set_contract_clause_status(uuid, uuid, text) to authenticated;
