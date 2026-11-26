-- UB-VOTE-01: staff-authored ballots and pulses.
-- Drafts never enter member reads. Staff scope is derived from the caller's
-- member chapter and matching role rows; a client never supplies a chapter id.
-- Ballot choices remain the voterless four-column store from UB-VOTE-04.

set local lock_timeout = '5s';

alter table public.member_ballots
  add column title_es text,
  add column body text not null default '',
  add column body_es text,
  add column campaign_state text not null default 'draft'
    check (campaign_state in ('draft', 'open', 'closed')),
  add column created_by uuid references auth.users(id) on delete set null,
  add column published_at timestamptz,
  add column closed_at timestamptz;

alter table public.member_surveys
  add column title_es text,
  add column body text not null default '',
  add column body_es text,
  add column campaign_state text not null default 'draft'
    check (campaign_state in ('draft', 'open', 'closed')),
  add column chapter_id text references public.chapters(id) on delete set null,
  add column created_by uuid references auth.users(id) on delete set null,
  add column published_at timestamptz,
  add column closed_at timestamptz;

alter table public.member_ballot_options add column label_es text;
alter table public.member_survey_options add column label_es text;

-- Nothing predating this migration was a draft. Preserve its visible state.
update public.member_ballots
set campaign_state = case when active then 'open' else 'closed' end;
update public.member_surveys
set campaign_state = case when active then 'open' else 'closed' end;

alter table public.member_ballots
  add constraint member_ballots_campaign_state_active_check
  check ((campaign_state = 'open') = active);
alter table public.member_surveys
  add constraint member_surveys_campaign_state_active_check
  check ((campaign_state = 'open') = active);

create index member_ballots_staff_campaign_idx
  on public.member_ballots (chapter_id, campaign_state, closes_at desc);
create index member_surveys_staff_campaign_idx
  on public.member_surveys (chapter_id, campaign_state, closes_at desc);

comment on column public.member_ballots.campaign_state is
  'Authoring lifecycle. Draft rows are inactive and member-invisible; open/closed content is immutable.';
comment on column public.member_surveys.chapter_id is
  'Eligibility scope: null = union-wide pulse; otherwise only members of this chapter can read/respond.';

-- Scope authorization remains private because exposing a boolean for arbitrary
-- scope ids would create an oracle. It ANDs member_has_role, retaining MFA.
create function private.can_manage_vote_scope(p_chapter_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    and case
      when p_chapter_id is null then exists (
        select 1 from public.member_roles r
        where r.user_id = (select auth.uid())
          and r.role in ('admin', 'vp')
          and r.chapter_id is null)
      else p_chapter_id = private.current_member_chapter()
        and exists (
          select 1 from public.member_roles r
          where r.user_id = (select auth.uid())
            and r.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
            and (r.chapter_id is null or r.chapter_id = p_chapter_id))
    end;
$$;
revoke all on function private.can_manage_vote_scope(text) from public, anon, authenticated;

-- Member catalog policies: published eligibility only. Staff drafts travel
-- through get_staff_vote_campaigns, never through a permissive table policy.
drop policy member_ballots_read_eligible on public.member_ballots;
create policy member_ballots_read_eligible on public.member_ballots
  for select to authenticated
  using (
    campaign_state <> 'draft'
    and (chapter_id is null or chapter_id = private.current_member_chapter())
  );

drop policy member_ballot_options_read_eligible on public.member_ballot_options;
create policy member_ballot_options_read_eligible on public.member_ballot_options
  for select to authenticated
  using (exists (
    select 1 from public.member_ballots b
    where b.id = member_ballot_options.ballot_id
      and b.campaign_state <> 'draft'
      and (b.chapter_id is null or b.chapter_id = private.current_member_chapter())
  ));

drop policy member_surveys_read_authenticated on public.member_surveys;
create policy member_surveys_read_eligible on public.member_surveys
  for select to authenticated
  using (
    campaign_state <> 'draft'
    and (chapter_id is null or chapter_id = private.current_member_chapter())
  );

drop policy member_survey_options_read_authenticated on public.member_survey_options;
create policy member_survey_options_read_eligible on public.member_survey_options
  for select to authenticated
  using (exists (
    select 1 from public.member_surveys s
    where s.id = member_survey_options.survey_id
      and s.campaign_state <> 'draft'
      and (s.chapter_id is null or s.chapter_id = private.current_member_chapter())
  ));

create function public.get_staff_vote_campaigns()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
    where private.can_manage_vote_scope(b.chapter_id)
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
    where private.can_manage_vote_scope(s.chapter_id)
  ) c;

  return pg_catalog.jsonb_build_object(
    'campaigns', campaigns,
    'canManageUnion', can_union,
    'chapterId', caller_chapter);
end;
$$;

create function public.save_vote_campaign_draft(
  p_kind text,
  p_campaign_id text,
  p_scope text,
  p_title_en text,
  p_title_es text,
  p_closes_at timestamptz,
  p_quorum_target integer,
  p_body_en text,
  p_body_es text,
  p_options jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
    if not exists (
      select 1 from public.member_roles r
      where r.user_id = caller and r.role in ('admin', 'vp') and r.chapter_id is null
    ) then
      raise exception 'campaign scope unavailable' using errcode = '42501';
    end if;
    target_chapter := null;
  elsif p_scope = 'chapter' and caller_chapter is not null then
    if not exists (
      select 1 from public.member_roles r
      where r.user_id = caller
        and r.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
        and (r.chapter_id is null or r.chapter_id = caller_chapter)
    ) then
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
        and private.can_manage_vote_scope(b.chapter_id);
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
        and private.can_manage_vote_scope(s.chapter_id);
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
$$;

create function public.publish_vote_campaign(p_kind text, p_campaign_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
    where b.id = p_campaign_id and private.can_manage_vote_scope(b.chapter_id)
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
    where s.id = p_campaign_id and private.can_manage_vote_scope(s.chapter_id)
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
$$;

create function public.close_vote_campaign(p_kind text, p_campaign_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
    where b.id = p_campaign_id and private.can_manage_vote_scope(b.chapter_id)
    for update;
    if not found or campaign.campaign_state <> 'open' then raise exception 'campaign not found' using errcode = '22023'; end if;
    update public.member_ballots set campaign_state = 'closed', active = false, closed_at = now()
    where id = p_campaign_id;
  elsif p_kind = 'pulse' then
    select s.id, s.chapter_id, s.campaign_state into campaign
    from public.member_surveys s
    where s.id = p_campaign_id and private.can_manage_vote_scope(s.chapter_id)
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
$$;

-- Existing audit table has a closed vocabulary; extend it without dropping any
-- settled action from the current reward-management generation.
alter table public.member_admin_audit drop constraint if exists member_admin_audit_action_check;
alter table public.member_admin_audit add constraint member_admin_audit_action_check
  check (action in ('grant_role', 'revoke_role', 'create_event', 'update_event', 'reset_mfa',
                    'claim_reward', 'grant_reward', 'revoke_reward', 'fulfill_reward',
                    'create_campaign', 'update_campaign_draft', 'publish_campaign', 'close_campaign'));

-- Current member ballot write, extended only by the published-state predicate.
create or replace function public.submit_ballot_vote(p_ballot_id text, p_option_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
    and (b.chapter_id is null or b.chapter_id = private.current_member_chapter());
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
$$;

create or replace function public.submit_survey_response(p_survey_id text, p_option_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
    and (s.chapter_id is null or s.chapter_id = private.current_member_chapter());
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
$$;

create or replace function public.get_ballot_tally(p_ballot_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
    and (chapter_id is null or chapter_id = private.current_member_chapter());
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
$$;

revoke all on function public.get_staff_vote_campaigns() from public, anon;
grant execute on function public.get_staff_vote_campaigns() to authenticated;
revoke all on function public.save_vote_campaign_draft(text, text, text, text, text, timestamptz, integer, text, text, jsonb) from public, anon;
grant execute on function public.save_vote_campaign_draft(text, text, text, text, text, timestamptz, integer, text, text, jsonb) to authenticated;
revoke all on function public.publish_vote_campaign(text, text) from public, anon;
grant execute on function public.publish_vote_campaign(text, text) to authenticated;
revoke all on function public.close_vote_campaign(text, text) from public, anon;
grant execute on function public.close_vote_campaign(text, text) to authenticated;

revoke insert, update, delete on public.member_ballots, public.member_ballot_options from authenticated;
revoke insert, update, delete on public.member_surveys, public.member_survey_options from authenticated;

-- Authorship is an audit fact for scoped staff, not member catalog data.
-- Replace the platform's table-wide SELECT on the two parent rows with the
-- exact columns the eligible member catalog needs; the staff registry remains
-- the only path that returns created_by.
revoke select on public.member_ballots, public.member_surveys from authenticated;
grant select (id, title, title_es, body, body_es, closes_at, active, order_index,
              quorum_target, chapter_id, campaign_state, published_at, closed_at)
  on public.member_ballots to authenticated;
grant select (id, title, title_es, body, body_es, closes_at, active, order_index,
              chapter_id, campaign_state, published_at, closed_at)
  on public.member_surveys to authenticated;
