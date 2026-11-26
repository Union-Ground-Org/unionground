-- SEC-UG-CROSS-TENANT-VOTE-CAMPAIGNS-20260920
--
-- public.member_ballots and public.member_surveys predate the organization
-- scope foundation (20260822010000) and never gained an owner. Their member
-- read policies, the option policies, the submit_ballot_vote /
-- submit_survey_response / get_ballot_tally lookups and the staff registry,
-- draft, publish and close paths authorized on chapter alone, and the
-- organization-wide branch (chapter_id is null) reached every tenant.
--
-- Both tables now carry organization_id, following the member_broadcasts
-- precedent: a nullable owner where NULL marks a quarantined legacy row.
--   * Backfill: a chapter-scoped row takes its chapter's organization; an
--     organization-wide row takes the organization of its creator's selected
--     chapter. An organization-wide row with no derivable owner (the early
--     seed campaigns carry no created_by) stays NULL and is visible to and
--     manageable by no one: it is quarantined, never platform-wide.
--   * Write guard: an insert derives the owner from the chapter, else from the
--     caller's selected organization, else from created_by's selected
--     organization, and refuses an organization-wide row that still has no
--     owner. The owner is immutable and a chapter must belong to it.
--   * Reads: private.can_read_vote_campaign requires the caller's selected
--     organization for an organization-wide row, and the caller's chapter plus
--     the same (or, for a legacy ownerless chapter, equally absent)
--     organization for a chapter row. The four read policies and the three
--     member RPC lookups use it and keep their existing not-found refusals, so
--     an out-of-organization id is refused exactly like an out-of-chapter id.
--   * Management: private.can_manage_vote_campaign adds the same organization
--     bound to private.can_manage_vote_scope for the staff registry, draft
--     edit, publish and close row lookups.
-- The writer RPCs are re-emitted with the case-graph lock preamble first.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.member_ballots
  add column organization_id uuid references public.organizations(id) on update cascade on delete restrict;
alter table public.member_surveys
  add column organization_id uuid references public.organizations(id) on update cascade on delete restrict;

update public.member_ballots b
set organization_id = c.organization_id
from public.chapters c
where c.id = b.chapter_id
  and c.organization_id is not null;

update public.member_ballots b
set organization_id = c.organization_id
from public.member_profiles p
join public.chapters c on c.id = p.chapter_id
where b.chapter_id is null
  and p.id = b.created_by
  and c.organization_id is not null;

update public.member_surveys s
set organization_id = c.organization_id
from public.chapters c
where c.id = s.chapter_id
  and c.organization_id is not null;

update public.member_surveys s
set organization_id = c.organization_id
from public.member_profiles p
join public.chapters c on c.id = p.chapter_id
where s.chapter_id is null
  and p.id = s.created_by
  and c.organization_id is not null;

create index member_ballots_organization_campaign_idx
  on public.member_ballots (organization_id, chapter_id, campaign_state);
create index member_surveys_organization_campaign_idx
  on public.member_surveys (organization_id, chapter_id, campaign_state);

comment on column public.member_ballots.organization_id is
  'Owning organization, derived server-side from the chapter or the author. NULL marks a quarantined legacy organization-wide ballot that no member or staff member can read or manage.';
comment on column public.member_surveys.organization_id is
  'Owning organization, derived server-side from the chapter or the author. NULL marks a quarantined legacy organization-wide pulse that no member or staff member can read or manage.';

-- The option policies read the parent row inside an ordinary permission-checked
-- sub-select, so the member column grant gains the owner column. It names only
-- the organization of a campaign the caller may already read.
grant select (organization_id) on public.member_ballots to authenticated;
grant select (organization_id) on public.member_surveys to authenticated;

create function private.assign_vote_campaign_organization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  chapter_org uuid;
begin
  if new.chapter_id is not null then
    select c.organization_id into chapter_org
    from public.chapters c
    where c.id = new.chapter_id;
  end if;

  if tg_op = 'UPDATE' then
    if new.organization_id is distinct from old.organization_id then
      raise exception 'campaign organization is immutable' using errcode = '42501';
    end if;
  elsif new.organization_id is null then
    if new.chapter_id is not null then
      new.organization_id := chapter_org;
    else
      new.organization_id := coalesce(
        private.current_member_organization(),
        (select c.organization_id
         from public.member_profiles p
         join public.chapters c on c.id = p.chapter_id
         where p.id = new.created_by));
      if new.organization_id is null then
        raise exception 'organization-wide campaigns require an owning organization' using errcode = '42501';
      end if;
    end if;
  end if;

  if new.chapter_id is not null and new.organization_id is distinct from chapter_org then
    raise exception 'campaign chapter is outside its organization' using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function private.assign_vote_campaign_organization() from public, anon, authenticated;
comment on function private.assign_vote_campaign_organization() is
  'SEC-UG-CROSS-TENANT-VOTE-CAMPAIGNS-20260920 write guard: derives a ballot or pulse owner from its chapter, the caller, or its author; refuses an ownerless organization-wide campaign, an owner change, and a chapter outside the owner.';

create trigger b10_vote_campaign_organization
  before insert or update on public.member_ballots
  for each row execute function private.assign_vote_campaign_organization();
create trigger b10_vote_campaign_organization
  before insert or update on public.member_surveys
  for each row execute function private.assign_vote_campaign_organization();

-- The created_by ON DELETE SET NULL action of account deletion fires the new
-- guard, so the account lifecycle trigger review records it.
insert into private.account_lifecycle_trigger_review
  (kind, schema_name, table_name, object_name, definition_hash)
values
  ('function', 'private', '', 'assign_vote_campaign_organization()', 'd6fc513cabe36900c9737478f115bf76'),
  ('trigger', 'public', 'member_ballots', 'b10_vote_campaign_organization', 'ee32d9063b191acc4d8463439eea9dca'),
  ('trigger', 'public', 'member_surveys', 'b10_vote_campaign_organization', '2f27802c1724d690a69e77786129c8c9')
on conflict (kind, schema_name, table_name, object_name) do update
set definition_hash = excluded.definition_hash;

do $assert_account_lifecycle_trigger_review$
begin
  if exists (
    select 1 from private.account_lifecycle_referential_action_trigger_issues() i
    where i.trigger_name in ('assign_vote_campaign_organization()', 'b10_vote_campaign_organization')
  ) then
    raise exception 'account lifecycle trigger review is incomplete after the vote campaign organization guard';
  end if;
end;
$assert_account_lifecycle_trigger_review$;

create function private.can_read_vote_campaign(p_organization_id uuid, p_chapter_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when p_chapter_id is null then
      p_organization_id is not null
      and p_organization_id = private.current_member_organization()
    else
      p_chapter_id = private.current_member_chapter()
      and p_organization_id is not distinct from private.current_member_organization()
  end;
$function$;

revoke all on function private.can_read_vote_campaign(uuid, text) from public, anon;
grant execute on function private.can_read_vote_campaign(uuid, text) to authenticated;
comment on function private.can_read_vote_campaign(uuid, text) is
  'Member campaign eligibility: an organization-wide campaign needs the caller''s selected organization; a chapter campaign needs the caller''s chapter and the same organization (both absent only for a legacy ownerless chapter). A quarantined ownerless organization-wide campaign matches no one.';

create function private.can_manage_vote_campaign(p_organization_id uuid, p_chapter_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (p_chapter_id is not null or p_organization_id is not null)
    and p_organization_id is not distinct from private.current_member_organization()
    and private.can_manage_vote_scope(p_chapter_id);
$function$;

revoke all on function private.can_manage_vote_campaign(uuid, text) from public, anon, authenticated;
comment on function private.can_manage_vote_campaign(uuid, text) is
  'Staff campaign-row predicate: private.can_manage_vote_scope plus the campaign owner equal to the caller''s selected organization. A quarantined ownerless organization-wide campaign is manageable by no one. No client execute.';

drop policy member_ballots_read_eligible on public.member_ballots;
create policy member_ballots_read_eligible on public.member_ballots
  for select to authenticated
  using (
    campaign_state <> 'draft'
    and private.can_read_vote_campaign(organization_id, chapter_id)
  );

drop policy member_ballot_options_read_eligible on public.member_ballot_options;
create policy member_ballot_options_read_eligible on public.member_ballot_options
  for select to authenticated
  using (exists (
    select 1 from public.member_ballots b
    where b.id = member_ballot_options.ballot_id
      and b.campaign_state <> 'draft'
      and private.can_read_vote_campaign(b.organization_id, b.chapter_id)
  ));

drop policy member_surveys_read_eligible on public.member_surveys;
create policy member_surveys_read_eligible on public.member_surveys
  for select to authenticated
  using (
    campaign_state <> 'draft'
    and private.can_read_vote_campaign(organization_id, chapter_id)
  );

drop policy member_survey_options_read_eligible on public.member_survey_options;
create policy member_survey_options_read_eligible on public.member_survey_options
  for select to authenticated
  using (exists (
    select 1 from public.member_surveys s
    where s.id = member_survey_options.survey_id
      and s.campaign_state <> 'draft'
      and private.can_read_vote_campaign(s.organization_id, s.chapter_id)
  ));

comment on policy member_ballots_read_eligible on public.member_ballots is
  'Members read published ballots owned by their selected organization: organization-wide ones in that organization, chapter ones in their own chapter. Drafts and ownerless organization-wide ballots are never member-visible.';
comment on policy member_ballot_options_read_eligible on public.member_ballot_options is
  'Ballot options inherit the parent ballot''s lifecycle and organization-bounded eligibility.';
comment on policy member_surveys_read_eligible on public.member_surveys is
  'Members read published pulses owned by their selected organization: organization-wide ones in that organization, chapter ones in their own chapter. Drafts and ownerless organization-wide pulses are never member-visible.';
comment on policy member_survey_options_read_eligible on public.member_survey_options is
  'Pulse options inherit the parent pulse''s lifecycle and organization-bounded eligibility.';

CREATE OR REPLACE FUNCTION public.get_staff_vote_campaigns()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  can_union boolean;
  campaigns jsonb;
begin
  if caller is null
     or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  can_union := private.can_manage_vote_scope(null);

  select coalesce(pg_catalog.jsonb_agg(c.payload order by c.closes_at desc, c.id), '[]'::jsonb)
  into campaigns
  from (
    select b.id, b.closes_at,
      pg_catalog.jsonb_build_object(
        'id', b.id, 'kind', 'ballot', 'titleEn', b.title,
        'titleEs', b.title_es, 'bodyEn', b.body, 'bodyEs', b.body_es,
        'scope', case when b.chapter_id is null then 'union' else 'chapter' end,
        'chapterId', b.chapter_id, 'closesAt', b.closes_at,
        'quorumTarget', b.quorum_target, 'state', b.campaign_state,
        'active', b.active, 'publishedAt', b.published_at,
        'closedAt', b.closed_at, 'createdBy', b.created_by,
        'options', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', o.id, 'labelEn', o.label, 'labelEs', o.label_es,
            'orderIndex', o.order_index) order by o.order_index)
          from public.member_ballot_options o where o.ballot_id = b.id
        ), '[]'::jsonb)) as payload
    from public.member_ballots b
    where private.can_manage_vote_campaign(b.organization_id, b.chapter_id)
    union all
    select s.id, s.closes_at,
      pg_catalog.jsonb_build_object(
        'id', s.id, 'kind', 'pulse', 'titleEn', s.title,
        'titleEs', s.title_es, 'bodyEn', s.body, 'bodyEs', s.body_es,
        'scope', case when s.chapter_id is null then 'union' else 'chapter' end,
        'chapterId', s.chapter_id, 'closesAt', s.closes_at,
        'quorumTarget', null, 'state', s.campaign_state,
        'active', s.active, 'publishedAt', s.published_at,
        'closedAt', s.closed_at, 'createdBy', s.created_by,
        'options', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', o.id, 'labelEn', o.label, 'labelEs', o.label_es,
            'orderIndex', o.order_index) order by o.order_index)
          from public.member_survey_options o where o.survey_id = s.id
        ), '[]'::jsonb))
    from public.member_surveys s
    where private.can_manage_vote_campaign(s.organization_id, s.chapter_id)
  ) c;

  return pg_catalog.jsonb_build_object(
    'campaigns', campaigns,
    'canManageUnion', can_union,
    'chapterId', caller_chapter);
end;
$function$;

CREATE OR REPLACE FUNCTION public.save_vote_campaign_draft(p_kind text, p_campaign_id text, p_scope text, p_title_en text, p_title_es text, p_closes_at timestamp with time zone, p_quorum_target integer, p_body_en text, p_body_es text, p_options jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  target_chapter text;
  campaign_id text := nullif(pg_catalog.btrim(coalesce(p_campaign_id, '')), '');
  created boolean := campaign_id is null;
  option_row record;
begin
  if caller is null
     or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  if p_scope = 'union' then
    if not private.can_manage_vote_scope(null) then
      raise exception 'campaign scope unavailable' using errcode = '42501';
    end if;
    target_chapter := null;
  elsif p_scope = 'chapter' and caller_chapter is not null then
    if not private.can_manage_vote_scope(caller_chapter) then
      raise exception 'campaign scope unavailable' using errcode = '42501';
    end if;
    target_chapter := caller_chapter;
  else
    raise exception 'campaign scope unavailable' using errcode = '42501';
  end if;

  if p_kind is null or p_kind not in ('ballot', 'pulse') then
    raise exception 'invalid campaign kind' using errcode = '22023';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title_en, ''))) not between 3 and 160
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title_es, ''))) not between 3 and 160
     or p_title_en ~ '[[:cntrl:]]' or p_title_es ~ '[[:cntrl:]]' then
    raise exception 'both campaign titles are required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_body_en, ''))) > 1000
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_body_es, ''))) > 1000 then
    raise exception 'campaign details are too long' using errcode = '22023';
  end if;
  if p_closes_at is null then
    raise exception 'close time is required' using errcode = '22023';
  end if;
  if p_kind = 'ballot' and (p_quorum_target is null or p_quorum_target not between 1 and 1000000) then
    raise exception 'ballot quorum is required' using errcode = '22023';
  end if;
  if p_kind = 'pulse' and p_quorum_target is not null then
    raise exception 'pulses do not use quorum' using errcode = '22023';
  end if;
  if coalesce(pg_catalog.jsonb_typeof(p_options), '') <> 'array' then
    raise exception 'campaigns need between 2 and 20 options' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_options) not between 2 and 20 then
    raise exception 'campaigns need between 2 and 20 options' using errcode = '22023';
  end if;
  for option_row in
    select value, ordinality from pg_catalog.jsonb_array_elements(p_options) with ordinality
  loop
    if pg_catalog.char_length(pg_catalog.btrim(coalesce(option_row.value->>'labelEn', ''))) not between 1 and 160
       or pg_catalog.char_length(pg_catalog.btrim(coalesce(option_row.value->>'labelEs', ''))) not between 1 and 160
       or (option_row.value->>'labelEn') ~ '[[:cntrl:]]'
       or (option_row.value->>'labelEs') ~ '[[:cntrl:]]' then
      raise exception 'both option labels are required' using errcode = '22023';
    end if;
  end loop;

  if campaign_id is null then
    campaign_id := p_kind || '-' || extensions.gen_random_uuid()::text;
  end if;

  if p_kind = 'ballot' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('member_ballots:order_index'));
    if created then
      insert into public.member_ballots
        (id, title, title_es, body, body_es, closes_at, active, order_index,
         quorum_target, chapter_id, campaign_state, created_by)
      values
        (campaign_id, pg_catalog.btrim(p_title_en), pg_catalog.btrim(p_title_es),
         pg_catalog.btrim(coalesce(p_body_en, '')), pg_catalog.btrim(coalesce(p_body_es, '')),
         p_closes_at, false, coalesce((select pg_catalog.max(order_index) + 1 from public.member_ballots), 1),
         p_quorum_target, target_chapter, 'draft', caller);
    else
      update public.member_ballots b
      set title = pg_catalog.btrim(p_title_en), title_es = pg_catalog.btrim(p_title_es),
          body = pg_catalog.btrim(coalesce(p_body_en, '')), body_es = pg_catalog.btrim(coalesce(p_body_es, '')),
          closes_at = p_closes_at, quorum_target = p_quorum_target, chapter_id = target_chapter
      where b.id = campaign_id and b.campaign_state = 'draft'
        and private.can_manage_vote_campaign(b.organization_id, b.chapter_id);
      if not found then raise exception 'campaign not found' using errcode = '22023'; end if;
      delete from public.member_ballot_options where ballot_id = campaign_id;
    end if;
    insert into public.member_ballot_options (id, ballot_id, label, label_es, order_index)
    select campaign_id || '-option-' || extensions.gen_random_uuid()::text, campaign_id,
      pg_catalog.btrim(value->>'labelEn'), pg_catalog.btrim(value->>'labelEs'), ordinality::integer
    from pg_catalog.jsonb_array_elements(p_options) with ordinality;
  else
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('member_surveys:order_index'));
    if created then
      insert into public.member_surveys
        (id, title, title_es, body, body_es, closes_at, active, order_index,
         chapter_id, campaign_state, created_by)
      values
        (campaign_id, pg_catalog.btrim(p_title_en), pg_catalog.btrim(p_title_es),
         pg_catalog.btrim(coalesce(p_body_en, '')), pg_catalog.btrim(coalesce(p_body_es, '')),
         p_closes_at, false, coalesce((select pg_catalog.max(order_index) + 1 from public.member_surveys), 1),
         target_chapter, 'draft', caller);
    else
      update public.member_surveys s
      set title = pg_catalog.btrim(p_title_en), title_es = pg_catalog.btrim(p_title_es),
          body = pg_catalog.btrim(coalesce(p_body_en, '')), body_es = pg_catalog.btrim(coalesce(p_body_es, '')),
          closes_at = p_closes_at, chapter_id = target_chapter
      where s.id = campaign_id and s.campaign_state = 'draft'
        and private.can_manage_vote_campaign(s.organization_id, s.chapter_id);
      if not found then raise exception 'campaign not found' using errcode = '22023'; end if;
      delete from public.member_survey_options where survey_id = campaign_id;
    end if;
    insert into public.member_survey_options (id, survey_id, label, label_es, order_index)
    select campaign_id || '-option-' || extensions.gen_random_uuid()::text, campaign_id,
      pg_catalog.btrim(value->>'labelEn'), pg_catalog.btrim(value->>'labelEs'), ordinality::integer
    from pg_catalog.jsonb_array_elements(p_options) with ordinality;
  end if;

  insert into public.member_admin_audit (actor, action, detail)
  values (caller, case when created then 'create_campaign' else 'update_campaign_draft' end,
    pg_catalog.jsonb_build_object('campaignId', campaign_id, 'kind', p_kind,
      'scope', p_scope, 'state', 'draft'));

  return pg_catalog.jsonb_build_object('id', campaign_id, 'kind', p_kind, 'state', 'draft');
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.publish_vote_campaign(p_kind text, p_campaign_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  campaign record;
  option_count integer;
begin
  if caller is null
     or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_kind = 'ballot' then
    select b.id, b.chapter_id, b.campaign_state, b.closes_at, b.quorum_target into campaign
    from public.member_ballots b
    where b.id = p_campaign_id and private.can_manage_vote_campaign(b.organization_id, b.chapter_id)
    for update;
    if not found or campaign.campaign_state <> 'draft' then raise exception 'campaign not found' using errcode = '22023'; end if;
    select count(*) into option_count from public.member_ballot_options where ballot_id = p_campaign_id;
    if campaign.quorum_target is null or campaign.closes_at <= now() or option_count < 2 then
      raise exception 'campaign is not ready to publish' using errcode = '22023';
    end if;
    update public.member_ballots set campaign_state = 'open', active = true, published_at = now(), closed_at = null
    where id = p_campaign_id;
  elsif p_kind = 'pulse' then
    select s.id, s.chapter_id, s.campaign_state, s.closes_at into campaign
    from public.member_surveys s
    where s.id = p_campaign_id and private.can_manage_vote_campaign(s.organization_id, s.chapter_id)
    for update;
    if not found or campaign.campaign_state <> 'draft' then raise exception 'campaign not found' using errcode = '22023'; end if;
    select count(*) into option_count from public.member_survey_options where survey_id = p_campaign_id;
    if campaign.closes_at <= now() or option_count < 2 then
      raise exception 'campaign is not ready to publish' using errcode = '22023';
    end if;
    update public.member_surveys set campaign_state = 'open', active = true, published_at = now(), closed_at = null
    where id = p_campaign_id;
  else
    raise exception 'invalid campaign kind' using errcode = '22023';
  end if;
  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'publish_campaign', pg_catalog.jsonb_build_object(
    'campaignId', p_campaign_id, 'kind', p_kind,
    'scope', case when campaign.chapter_id is null then 'union' else 'chapter' end,
    'state', 'open'));
  return pg_catalog.jsonb_build_object('id', p_campaign_id, 'kind', p_kind, 'state', 'open');
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.close_vote_campaign(p_kind text, p_campaign_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  campaign record;
begin
  if caller is null
     or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_kind = 'ballot' then
    select b.id, b.chapter_id, b.campaign_state into campaign
    from public.member_ballots b
    where b.id = p_campaign_id and private.can_manage_vote_campaign(b.organization_id, b.chapter_id)
    for update;
    if not found or campaign.campaign_state <> 'open' then raise exception 'campaign not found' using errcode = '22023'; end if;
    update public.member_ballots set campaign_state = 'closed', active = false, closed_at = now()
    where id = p_campaign_id;
  elsif p_kind = 'pulse' then
    select s.id, s.chapter_id, s.campaign_state into campaign
    from public.member_surveys s
    where s.id = p_campaign_id and private.can_manage_vote_campaign(s.organization_id, s.chapter_id)
    for update;
    if not found or campaign.campaign_state <> 'open' then raise exception 'campaign not found' using errcode = '22023'; end if;
    update public.member_surveys set campaign_state = 'closed', active = false, closed_at = now()
    where id = p_campaign_id;
  else
    raise exception 'invalid campaign kind' using errcode = '22023';
  end if;
  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'close_campaign', pg_catalog.jsonb_build_object(
    'campaignId', p_campaign_id, 'kind', p_kind,
    'scope', case when campaign.chapter_id is null then 'union' else 'chapter' end,
    'state', 'closed'));
  return pg_catalog.jsonb_build_object('id', p_campaign_id, 'kind', p_kind, 'state', 'closed');
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.submit_ballot_vote(p_ballot_id text, p_option_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  ballot record;
  akey text;
  awarded integer;
  logged boolean;
  code text;
begin
  if caller is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  select b.id, b.active, b.closes_at into ballot
  from public.member_ballots b
  where b.id = p_ballot_id and b.campaign_state = 'open'
    and private.can_read_vote_campaign(b.organization_id, b.chapter_id);
  if not found then raise exception 'ballot not found' using errcode = '22023'; end if;
  if not ballot.active or ballot.closes_at <= now() then raise exception 'this ballot is closed' using errcode = '22023'; end if;
  if not exists (select 1 from public.member_ballot_options o where o.id = p_option_id and o.ballot_id = p_ballot_id) then
    raise exception 'invalid option for this ballot' using errcode = '22023';
  end if;
  code := private.issue_ballot_receipt(p_ballot_id, caller);
  if code is null then raise exception 'your vote is already recorded' using errcode = '22023'; end if;
  insert into public.member_ballot_choices (ballot_id, option_id, stress_run_id)
  values (p_ballot_id, p_option_id,
    (select l.run_id from private.member_stress_ledger l where l.user_id = caller limit 1));
  akey := 'vote-' || p_ballot_id;
  insert into public.member_action_log (user_id, action_key, action_kind)
  values (caller, akey, 'vote') on conflict (user_id, action_key) do nothing returning true into logged;
  if coalesce(logged, false) then select e.points into awarded from public.member_point_events e where e.user_id = caller and e.action_key = akey; end if;
  return pg_catalog.jsonb_build_object('receiptCode', code, 'awardedPoints', coalesce(awarded, 0));
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.submit_survey_response(p_survey_id text, p_option_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  survey record;
  akey text;
  awarded integer;
  logged boolean;
begin
  if caller is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  select s.id, s.active, s.closes_at into survey
  from public.member_surveys s
  where s.id = p_survey_id and s.campaign_state = 'open'
    and private.can_read_vote_campaign(s.organization_id, s.chapter_id);
  if not found then raise exception 'pulse not found' using errcode = '22023'; end if;
  if not survey.active or survey.closes_at <= now() then raise exception 'this pulse is closed' using errcode = '22023'; end if;
  if not exists (select 1 from public.member_survey_options o where o.id = p_option_id and o.survey_id = p_survey_id) then
    raise exception 'invalid option for this pulse' using errcode = '22023';
  end if;
  insert into public.member_survey_responses (survey_id, user_id, option_id)
  values (p_survey_id, caller, p_option_id)
  on conflict (survey_id, user_id) do update set option_id = excluded.option_id;
  akey := 'survey-' || p_survey_id;
  insert into public.member_action_log (user_id, action_key, action_kind)
  values (caller, akey, 'survey') on conflict (user_id, action_key) do nothing returning true into logged;
  if coalesce(logged, false) then select e.points into awarded from public.member_point_events e where e.user_id = caller and e.action_key = akey; end if;
  return pg_catalog.jsonb_build_object('awardedPoints', coalesce(awarded, 0));
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_ballot_tally(p_ballot_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  ballot record;
  total integer;
  option_counts jsonb;
begin
  if caller is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select id, title, closes_at, active, quorum_target, campaign_state into ballot
  from public.member_ballots
  where id = p_ballot_id and campaign_state <> 'draft'
    and private.can_read_vote_campaign(organization_id, chapter_id);
  if not found then raise exception 'ballot not found' using errcode = '22023'; end if;
  select count(*) into total from public.member_ballot_choices where ballot_id = ballot.id;
  if ballot.campaign_state = 'closed' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'optionId', counts.option_id, 'label', counts.label, 'labelEs', counts.label_es,
      'votes', counts.votes) order by counts.order_index), '[]'::jsonb)
    into option_counts
    from (
      select options.id as option_id, options.label, options.label_es, options.order_index,
        count(choices.option_id) as votes
      from public.member_ballot_options options
      left join public.member_ballot_choices choices
        on choices.ballot_id = options.ballot_id and choices.option_id = options.id
      where options.ballot_id = ballot.id
      group by options.id, options.label, options.label_es, options.order_index
    ) counts;
  end if;
  return pg_catalog.jsonb_build_object('ballotId', ballot.id, 'totalVotes', total,
    'quorumTarget', ballot.quorum_target, 'closesAt', ballot.closes_at,
    'active', ballot.active, 'options', option_counts);
end;
$function$;

notify pgrst, 'reload schema';

commit;
