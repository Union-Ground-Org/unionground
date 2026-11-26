-- SEC-UG-COMPASS-SOURCE-ORGANIZATION-SCOPE-20261012
-- Keep AI source context and saved briefings in their actual organization.
--
-- get_compass_ai_context labels every envelope with the caller's Compass
-- organization, and api/guide.js and api/civic-draft.js authorize, charge and
-- cache the dispatch against that label. The briefing and civic sources were
-- read without asking which organization they belong to:
--
-- * A private conversation is readable by its owner in any organization, and
--   by staff who can see its member. A member of A and B who is staff in B
--   could brief their A conversation while B was selected; the A messages
--   went out under B's label, B's AI switches, quota and cache scope, even
--   with A's assistant turned off. persist_compass_message_briefing then
--   saved the A-derived summary as a B row.
-- * civic_is_org_member admits any active chapter membership, so an active A
--   campaign was returned under B's label while B was selected.
--
-- private.compass_source_in_organization resolves the source's own
-- organization (the conversation's stamped organization_id; a channel
-- thread's or a task's chapter; a campaign's chapter) and is true only when it
-- is the given organization. Unknown or null scope, including a conversation
-- whose organization was never stamped, never matches. The context wrapper
-- refuses a foreign or unscoped briefing source with not found before reading
-- it and resolves a foreign campaign as no campaign, so neither route
-- reserves or dispatches. Briefing persistence applies the same check against
-- the selected organization, so a direct RPC call cannot store a derivative
-- under another organization. Owner and staff read rules, the message source
-- revision check, MFA, roles and the organization AI switches are unchanged.
--
-- No new table or trigger, and no data change: existing briefing rows stay as
-- they are. Hosted application: SAMPLE first, then production, by the sole
-- authorized applier.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function private.compass_source_in_organization(
  p_source_kind text,
  p_target_id uuid,
  p_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_organization_id is not null and coalesce(case p_source_kind
    when 'private' then (
      select conversation.organization_id = p_organization_id
      from public.member_conversations conversation
      where conversation.id = p_target_id
    )
    when 'channel' then (
      select chapter.organization_id = p_organization_id
      from public.chapter_threads thread
      join public.chapter_spaces space on space.id = thread.space_id and space.chapter_id = thread.chapter_id
      join public.chapters chapter on chapter.id = thread.chapter_id
      where thread.id = p_target_id
    )
    when 'task' then (
      select chapter.organization_id = p_organization_id
      from public.chapter_tasks task
      join public.chapters chapter on chapter.id = task.chapter_id
      where task.id = p_target_id
    )
    when 'civic' then (
      select chapter.organization_id = p_organization_id
      from public.civic_campaigns campaign
      join public.chapters chapter on chapter.id = campaign.org_id
      where campaign.id = p_target_id
    )
  end, false)
$function$;

-- get_compass_ai_context runs as the caller, so the caller needs EXECUTE; the
-- private schema is not exposed through the API.
revoke all on function private.compass_source_in_organization(text, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function private.compass_source_in_organization(text, uuid, uuid) to authenticated;

comment on function private.compass_source_in_organization(text, uuid, uuid) is
  'SEC-UG-COMPASS-SOURCE-ORGANIZATION-SCOPE-20261012: true only when the briefing or civic source belongs to the given organization; null or unknown scope never matches.';

create or replace function public.get_compass_ai_context(p_kind text, p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  org uuid := private.compass_context_organization();
  data jsonb; campaign jsonb; official jsonb; address jsonb; bill jsonb;
begin
  if p_kind = 'portal' then
    data := public.get_member_guide_context();
  elsif p_kind = 'lexical' then
    select coalesce(pg_catalog.jsonb_agg(projected.source order by r.ordinal), '[]'::jsonb) into data
    from public.search_member_kb(p_args ->> 'p_query', 4) with ordinality r(source_id, kind, title, ref, snippet, ordinal)
    cross join lateral (select private.compass_classified_source(pg_catalog.to_jsonb(r) - 'ordinal') as source) projected
    where projected.source is not null;
  elsif p_kind = 'hybrid' then
    select coalesce(pg_catalog.jsonb_agg(projected.source order by r.ordinal), '[]'::jsonb) into data
    from public.search_member_kb_hybrid(p_args ->> 'p_query', (p_args ->> 'p_embedding')::extensions.vector, 4) with ordinality r(source_id, kind, title, ref, snippet, ordinal)
    cross join lateral (select private.compass_classified_source(pg_catalog.to_jsonb(r) - 'ordinal') as source) projected
    where projected.source is not null;
  elsif p_kind = 'hybrid_ready' then
    -- The semantic lane's own gates, without a query vector: one current chunk
    -- of an eligible article in the active organization's scope is enough.
    select pg_catalog.to_jsonb(exists (
      select 1
      from public.member_kb_article_embeddings e
      join public.member_kb_articles a on a.id = e.article_id
      where a.compass_organization_id = org
        and e.compass_organization_id = org
        and e.model = 'bge-m3'
        and e.digest = 'sha256:7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab'
        and private.compass_article_scope_current(a)
        and private.compass_scope_specificity(a.compass_organization_id, a.compass_scope_path, a.compass_scope_level) > 0
        and not a.is_sample
        and a.status = 'published'
        and a.verified_by is not null
        and a.verified_at is not null
        and private.knowledge_article_content_current(a)
        and private.compass_article_classification_current(a)
        and e.compass_scope_path = a.compass_scope_path
        and e.classification_sha256 = a.compass_classification ->> 'input_sha256'
        and e.body_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(a.body, 'UTF8')), 'hex')
    )) into data;
  elsif p_kind = 'briefing' then
    -- The thread must belong to the organization this envelope is labelled
    -- with; an owner or staff read in another organization is not enough.
    if p_args ->> 'p_source_kind' in ('private', 'channel', 'task')
       and not private.compass_source_in_organization(p_args ->> 'p_source_kind', (p_args ->> 'p_target_id')::uuid, org) then
      raise exception 'not found' using errcode = 'P0002';
    end if;
    data := public.get_message_briefing_context(p_args ->> 'p_source_kind', (p_args ->> 'p_target_id')::uuid);
  elsif p_kind = 'civic' then
    select pg_catalog.jsonb_build_object('id', c.id, 'topic', c.topic, 'summary', c.summary,
      'talking_points', c.talking_points, 'union_position', c.union_position, 'bill_key', c.bill_key,
      'target_offices', c.target_offices) into campaign
    from public.civic_campaigns c where c.id = (p_args ->> 'campaignId')::uuid and c.status = 'active'
      and private.compass_source_in_organization('civic', c.id, org);
    select pg_catalog.jsonb_build_object('full_name', o.full_name, 'office', o.office) into official
    from public.civic_member_officials_keyed o
    where o.user_id = (select auth.uid()) and o.official_key = p_args ->> 'officialKey' limit 1;
    select pg_catalog.jsonb_build_object('city', a.city, 'state', a.state) into address
    from public.civic_member_addresses a limit 1;
    select pg_catalog.jsonb_build_object('identifier', b.identifier, 'title', b.title) into bill
    from public.civic_bills b where b.bill_key = campaign ->> 'bill_key' limit 1;
    data := pg_catalog.jsonb_build_object('campaign', campaign, 'official', official,
      'address', coalesce(address, '{}'::jsonb), 'bill', bill);
  else raise exception 'context kind invalid' using errcode = '22023';
  end if;
  if p_kind in ('lexical', 'hybrid') then
    return pg_catalog.jsonb_build_object('organization_id', org, 'data', data,
      'scope', private.compass_retrieval_scope_summary(p_args ->> 'p_query', data));
  end if;
  return pg_catalog.jsonb_build_object('organization_id', org, 'data', data);
end;
$$;

create or replace function public.persist_compass_message_briefing(
  p_source_kind text,
  p_target_id uuid,
  p_summary text,
  p_action_items jsonb,
  p_source_revision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  actor uuid;
  saved public.compass_message_briefings%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  org := private.engagement_selected_organization();
  actor := (select auth.uid());
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if not private.engagement_can_read_message_target(p_source_kind, p_target_id)
     or not private.compass_source_in_organization(p_source_kind, p_target_id, org) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_summary, ''))) not between 1 and 4000
     or pg_catalog.jsonb_typeof(p_action_items) <> 'array'
     or pg_catalog.jsonb_array_length(p_action_items) > 12 then
    raise exception 'invalid briefing result' using errcode = '22023';
  end if;
  perform private.lock_message_lifecycle();
  if p_source_revision is null or p_source_revision is distinct from
    (public.get_message_briefing_context(p_source_kind, p_target_id)->>'sourceRevision') then
    raise exception 'message source changed; request a new briefing' using errcode = '40001';
  end if;
  insert into public.compass_message_briefings (
    organization_id, requested_by, source_kind, target_id, summary, action_items
  ) values (
    org, actor, p_source_kind, p_target_id,
    pg_catalog.btrim(p_summary), p_action_items
  ) returning * into saved;
  return pg_catalog.jsonb_build_object(
    'id', saved.id, 'sourceKind', saved.source_kind,
    'targetId', saved.target_id, 'summary', saved.summary,
    'actionItems', saved.action_items, 'createdAt', saved.created_at
  );
end;
$function$;

notify pgrst, 'reload schema';
commit;
