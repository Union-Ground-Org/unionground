-- BUG-UG-VOTE-CAMPAIGN-AUTHORITY-IGNORES-ORGANIZATION-GRANTS-20260920
--
-- private.can_manage_vote_scope and the matching inline checks in
-- public.save_vote_campaign_draft only accepted a public.member_roles row.
-- public.set_member_organization_role writes public.organization_role_grants
-- and never public.member_roles, and private.forbid_new_ownerless_member_roles
-- refuses the organization-wide member_roles shape for a real tenant. An
-- organization admin granted the supported way therefore cleared
-- public.member_has_role and was then refused every campaign scope.
--
-- Each branch now accepts either the legacy member_roles row (so SAMPLE and
-- remaining ownerless hats keep today's authority) or the supported grant
-- helper: private.has_organization_role for union/admin-vp, and
-- private.member_has_chapter_role for the caller's selected chapter. A
-- chapter-scoped grant still cannot satisfy the union branch.
-- public.save_vote_campaign_draft calls this one predicate instead of
-- repeating the member_roles exists() blocks. get_staff_vote_campaigns
-- already routes through the predicate. The draft writer is re-emitted
-- with the 20260907151000 case-graph lock preamble first, because it
-- writes created_by columns that reference auth.users.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function private.can_manage_vote_scope(p_chapter_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    and case
      when p_chapter_id is null then (
        exists (
          select 1 from public.member_roles r
          where r.user_id = (select auth.uid())
            and r.role in ('admin', 'vp')
            and r.chapter_id is null)
        or private.has_organization_role(
          private.current_member_organization(),
          array['admin', 'vp']))
      else p_chapter_id = private.current_member_chapter()
        and (
          exists (
            select 1 from public.member_roles r
            where r.user_id = (select auth.uid())
              and r.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
              and (r.chapter_id is null or r.chapter_id = p_chapter_id))
          or private.member_has_chapter_role(
            p_chapter_id,
            array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
    end;
$function$;

revoke all on function private.can_manage_vote_scope(text) from public, anon, authenticated;
comment on function private.can_manage_vote_scope(text) is
  'Staff campaign-scope predicate. Union scope requires an organization-wide admin or vp grant from a legacy public.member_roles row or private.has_organization_role; chapter scope requires the caller''s selected chapter plus a matching legacy member_roles row or private.member_has_chapter_role. member_has_role retains MFA. No client execute.';

create or replace function public.save_vote_campaign_draft(
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
as $function$
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
end;
$function$;

comment on function public.save_vote_campaign_draft(text, text, text, text, text, timestamptz, integer, text, text, jsonb) is
  'UB-VOTE-01 sole content write: acquires the case-graph lock, then derives chapter/union scope through private.can_manage_vote_scope, requires complete bounded bilingual copy and options, enforces ballot-only quorum, and can edit only drafts.';

notify pgrst, 'reload schema';

commit;
