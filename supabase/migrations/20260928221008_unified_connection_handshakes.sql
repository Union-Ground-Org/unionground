-- REQ-UG-UNIFIED-UNION-NETWORK-20260928.
-- Integrates the published registry from 20260928103000 / 20260928103100
-- with the existing 20260821012000 two-sided handshake lifecycle. Existing
-- request/response/signature/document contracts remain authoritative.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Public organizational registry identity only; never a tenant/member id.
create or replace function private.chapter_connection_identity(
  p_chapter_id text,
  p_declared_local_key text,
  p_declared_union_family_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  verified record;
  family text;
begin
  select u.id, u.olms_file_number, u.affiliation into verified
  from public.chapter_union_org_bindings b
  join public.union_orgs u on u.id = b.union_org_id
  where b.chapter_id = p_chapter_id
    and b.status = 'verified';
  if found then
    family := nullif(pg_catalog.left(pg_catalog.btrim(
      pg_catalog.regexp_replace(pg_catalog.lower(coalesce(verified.affiliation, '')), '[^a-z0-9]+', '-', 'g'),
      '-'), 40), '');
    if family in ('unaff', 'unaffiliated', 'independent', 'none') then family := null; end if;
    return pg_catalog.jsonb_build_object(
      'partnerOrgId', verified.id,
      'localKey', 'olms-' || verified.olms_file_number::text,
      'localKeySource', 'verified',
      'unionFamilyKey', family,
      'unionFamilyKeySource', case when family is null then null else 'verified' end
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'partnerOrgId', null,
    'localKey', p_declared_local_key,
    'localKeySource', case when p_declared_local_key is null then null else 'declared' end,
    'unionFamilyKey', case when p_declared_union_family_key in ('unaff','unaffiliated','independent','none') then null else p_declared_union_family_key end,
    'unionFamilyKeySource', case when p_declared_union_family_key is null then null else 'declared' end
  );
end;
$function$;

create or replace function private.chapter_connection_profile_projection(
  p_row private.chapter_connection_profiles,
  p_display_name text
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  identity jsonb;
begin
  identity := private.chapter_connection_identity(
    p_row.chapter_id, p_row.declared_local_key, p_row.declared_union_family_key);
  return pg_catalog.jsonb_build_object(
    'id', p_row.chapter_id,
    'kind', p_row.kind,
    'displayName', p_display_name,
    'profileRevision', p_row.profile_revision,
    'publication', pg_catalog.jsonb_build_object(
      'status', p_row.publication_status,
      'version', p_row.publication_version,
      'publishedAt', p_row.published_at,
      'expiresAt', p_row.expires_at
    ),
    'location', pg_catalog.jsonb_build_object(
      'country', p_row.location_country,
      'state', p_row.location_state,
      'metro', p_row.location_metro
    ),
    'sectorKeys', pg_catalog.to_jsonb(p_row.sector_keys),
    'issuePriorities', private.chapter_connection_issue_priorities(p_row),
    'expertiseOffered', pg_catalog.to_jsonb(p_row.expertise_offered),
    'localKey', identity -> 'localKey',
    'unionFamilyKey', identity -> 'unionFamilyKey',
    'identityProvenance', pg_catalog.jsonb_build_object(
      'localKey', identity -> 'localKeySource',
      'unionFamilyKey', identity -> 'unionFamilyKeySource'
    ),
    'handshake', pg_catalog.jsonb_build_object(
      'eligible', identity ->> 'partnerOrgId' is not null,
      'partnerOrgId', identity -> 'partnerOrgId'
    ),
    'sourceAsOf', p_row.updated_at
  );
end;
$function$;

create or replace function private.chapter_connection_workspace(
  p_organization_id uuid,
  p_chapter_id text,
  p_can_publish boolean
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  row_data private.chapter_connection_profiles%rowtype;
  chapter_name text;
  has_row boolean;
  quarter record;
  latest_period text;
  latest_frozen_at timestamptz;
  profile jsonb;
  draft jsonb;
  analysis jsonb;
begin
  select c.name into chapter_name from public.chapters c where c.id = p_chapter_id;
  select * into row_data
  from private.chapter_connection_profiles p
  where p.chapter_id = p_chapter_id and p.organization_id = p_organization_id;
  has_row := found;

  profile := case
    when has_row
      and row_data.publication_status = 'published'
      and row_data.expires_at > pg_catalog.now()
    then private.chapter_connection_profile_projection(row_data, chapter_name)
    else null
  end;

  draft := case when has_row then pg_catalog.jsonb_build_object(
    'kind', row_data.kind,
    'location', pg_catalog.jsonb_build_object(
      'country', row_data.location_country,
      'state', row_data.location_state,
      'metro', row_data.location_metro
    ),
    'sectorKeys', pg_catalog.to_jsonb(row_data.sector_keys),
    'expertiseOffered', pg_catalog.to_jsonb(row_data.expertise_offered),
    'declaredIssueKeys', pg_catalog.to_jsonb(row_data.declared_issue_keys),
    'declaredLocalKey', row_data.declared_local_key,
    'declaredUnionFamilyKey', row_data.declared_union_family_key,
    'shareAnalyzedIssues', row_data.share_analyzed_issues,
    'profileRevision', row_data.profile_revision,
    'publication', pg_catalog.jsonb_build_object(
      'status', row_data.publication_status,
      'version', row_data.publication_version,
      'publishedAt', row_data.published_at,
      'expiresAt', row_data.expires_at,
      'withdrawnAt', row_data.withdrawn_at,
      'expired', row_data.publication_status = 'published' and row_data.expires_at <= pg_catalog.now()
    ),
    'consent', pg_catalog.jsonb_build_object(
      'version', row_data.consent_version,
      'recordedAt', row_data.consent_recorded_at,
      'hat', row_data.consent_hat
    ),
    'updatedAt', row_data.updated_at
  ) else null end;

  select * into quarter from private.chapter_connection_previous_quarter();
  select r.period_key, r.frozen_at into latest_period, latest_frozen_at
  from private.chapter_connection_aggregate_runs r
  where r.chapter_id = p_chapter_id
  order by r.period_key desc
  limit 1;
  analysis := pg_catalog.jsonb_build_object(
    'nextPeriodKey', quarter.period_key,
    'nextPeriodFrozen', exists (
      select 1 from private.chapter_connection_aggregate_runs r
      where r.chapter_id = p_chapter_id and r.period_key = quarter.period_key
    ),
    'latest', case when latest_period is null then null else pg_catalog.jsonb_build_object(
      'periodKey', latest_period,
      'frozenAt', latest_frozen_at,
      'topics', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('key', a.topic_key, 'band', a.band) order by a.topic_key)
        from private.chapter_connection_issue_aggregates a
        where a.chapter_id = p_chapter_id and a.period_key = latest_period
      ), '[]'::jsonb)
    ) end
  );

  return pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id,
    'chapterId', p_chapter_id,
    'chapterName', chapter_name,
    'profile', profile,
    'draft', draft,
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', c.id, 'name', c.name) order by c.order_index, c.name, c.id)
      from public.chapters c
      where c.organization_id = p_organization_id
    ), '[]'::jsonb),
    'canPublish', coalesce(p_can_publish, false),
    'canRequestHandshake', coalesce(
      p_chapter_id = private.current_member_chapter()
      and private.member_has_chapter_role(p_chapter_id, array['steward','coordinator','advisor','admin','vp']),
      false
    ),
    'hiddenChapterIds', coalesce((
      select pg_catalog.jsonb_agg(h.hidden_chapter_id order by h.hidden_chapter_id)
      from private.chapter_connection_hides h
      where h.chapter_id = p_chapter_id
    ), '[]'::jsonb),
    'analysis', analysis,
    'taxonomy', pg_catalog.jsonb_build_object(
      'issueKeys', pg_catalog.to_jsonb(private.chapter_connection_issue_keys()),
      'sectorKeys', pg_catalog.to_jsonb(private.chapter_connection_sector_keys()),
      'expertiseKeys', pg_catalog.to_jsonb(private.chapter_connection_expertise_keys()),
      'bands', pg_catalog.jsonb_build_array('some', 'many', 'most'),
      'consentVersion', private.chapter_connection_consent_version(),
      'publicationDays', private.chapter_connection_publication_days()
    )
  );
end;
$function$;

-- The selected source is fixed to the real session chapter because the
-- existing lifecycle uses that chapter for requests, signatures and reads.
create function public.request_chapter_connection_handshake(
  p_selected_hat text,
  p_chapter_id text,
  p_target_chapter_id text,
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
  org uuid;
  chapter text;
  target text;
  partner text;
  registry_epoch bigint;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_selected_organization();
  chapter := private.chapter_connection_require_chapter(org, p_chapter_id);
  perform private.chapter_connection_require_hat(org, p_selected_hat, chapter,
    array['steward','coordinator','advisor','admin','vp']);
  if chapter is distinct from private.current_member_chapter()
     or not private.member_has_chapter_role(chapter, array[p_selected_hat]) then
    raise exception 'select the source chapter before requesting a handshake' using errcode = '42501';
  end if;
  if p_idempotency_key is null
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title,''))) not between 1 and 160
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_purpose,''))) not between 1 and 4000
     or p_data_scope is null or p_data_scope not in ('docs_only','no_member_data','aggregate_only') then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  target := nullif(pg_catalog.btrim(coalesce(p_target_chapter_id, '')), '');
  if target is null or target = chapter then
    raise exception 'target chapter unavailable' using errcode = '22023';
  end if;

  -- Serialize retries before taking the registry lock. The legacy event's
  -- globally unique key remains the durable idempotency authority.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_idempotency_key::text, 509281));
  -- Every eligibility dependency advances this row in the existing registry
  -- triggers. SHARE prevents a withdrawal/hide/rebind/quarantine from
  -- committing between the following fresh read and the legacy request.
  -- Do not take target-row locks: registry writers lock those before epoch.
  select e.epoch into registry_epoch
  from private.chapter_connection_registry_epoch e where e.singleton for share;
  if registry_epoch is null then
    raise exception 'target chapter unavailable' using errcode = '22023';
  end if;
  select b.union_org_id into partner
  from private.chapter_connection_profiles p
  join public.chapters c on c.id = p.chapter_id and c.organization_id = p.organization_id
  join public.organizations o on o.id = p.organization_id and o.status = 'active'
  join public.chapter_union_org_bindings b on b.chapter_id = p.chapter_id and b.status = 'verified'
  join public.union_orgs u on u.id = b.union_org_id
  where p.chapter_id = target
    and p.publication_status = 'published'
    and p.expires_at > pg_catalog.clock_timestamp()
    and not exists (
      select 1 from private.chapter_connection_hides h
      where (h.chapter_id = chapter and h.hidden_chapter_id = target)
         or (h.chapter_id = target and h.hidden_chapter_id = chapter)
    );
  if partner is null then
    raise exception 'target chapter unavailable' using errcode = '22023';
  end if;
  -- union_org_id is UNIQUE in chapter_union_org_bindings. Under the registry
  -- lock the legacy resolver must select this exact receiving chapter.
  return public.request_chapter_handshake(partner, p_title, p_purpose, p_data_scope, p_idempotency_key);
end;
$function$;

revoke all on function public.request_chapter_connection_handshake(text,text,text,text,text,text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.request_chapter_connection_handshake(text,text,text,text,text,text,uuid) to authenticated;
revoke all on function private.chapter_connection_identity(text,text,text) from public, anon, authenticated, service_role;
revoke all on function private.chapter_connection_profile_projection(private.chapter_connection_profiles,text) from public, anon, authenticated, service_role;
revoke all on function private.chapter_connection_workspace(uuid,text,boolean) from public, anon, authenticated, service_role;
comment on function public.request_chapter_connection_handshake(text,text,text,text,text,text,uuid) is
  'Request an existing two-sided chapter handshake from an exact consenting published connection. Requires selected chapter/hat/MFA and a current verified receiving binding; publication and reciprocal privacy are rechecked before every call including retries.';

commit;
