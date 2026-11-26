-- MI1 CR-062 / CR-064 completion: explicit coalition approval rules and the
-- real public chapter hierarchy's editor, attachment, and takeover paths.
-- Sequenced after the coordination workflow migration on current Main.
--
-- This follows the coordination foundation migrations. Organization scope is
-- always derived from the authenticated session. Anonymous readers cross only
-- the bounded microsite projection; they never receive table privileges.

set local lock_timeout = '5s';

create table public.organization_coalition_decisions (
  id uuid primary key default extensions.gen_random_uuid(),
  campaign_id uuid not null
    references public.organization_coordination_records(id) on delete cascade,
  subject_record_id uuid not null
    references public.organization_coordination_records(id) on delete restrict,
  proposing_organization_id uuid not null
    references public.organizations(id) on update cascade on delete restrict,
  title text not null,
  rationale text not null default '',
  action text not null check (action in (
    'authorize_work', 'pause_work', 'complete_work'
  )),
  status text not null default 'open' check (status in (
    'open', 'approved', 'rejected', 'withdrawn'
  )),
  required_approvals integer not null check (required_approvals between 1 and 100),
  proposed_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  idempotency_key uuid not null unique,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_coalition_decision_title_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(title)) between 2 and 160
      and title !~ '[[:cntrl:]]'
  ),
  constraint organization_coalition_decision_rationale_bounded check (
    pg_catalog.char_length(rationale) <= 4000
  ),
  constraint organization_coalition_decision_resolution_stamp check (
    (status = 'open' and resolved_at is null)
    or (status <> 'open' and resolved_at is not null)
  )
);

create index organization_coalition_decisions_campaign_idx
  on public.organization_coalition_decisions
  (campaign_id, status, created_at desc, id desc);
create index organization_coalition_decisions_subject_idx
  on public.organization_coalition_decisions
  (subject_record_id, created_at desc, id desc);
create index organization_coalition_decisions_organization_idx
  on public.organization_coalition_decisions
  (proposing_organization_id, created_at desc, id desc);
create index organization_coalition_decisions_proposer_idx
  on public.organization_coalition_decisions
  (proposed_by, created_at desc) where proposed_by is not null;

create table public.organization_coalition_decision_votes (
  id uuid primary key default extensions.gen_random_uuid(),
  decision_id uuid not null
    references public.organization_coalition_decisions(id) on delete cascade,
  organization_id uuid not null
    references public.organizations(id) on update cascade on delete restrict,
  voter_user_id uuid references auth.users(id) on delete set null,
  vote text not null check (vote in ('approve', 'reject', 'abstain')),
  comment text not null default '',
  idempotency_key uuid not null unique,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_coalition_decision_vote_comment_bounded check (
    pg_catalog.char_length(comment) <= 1000
  ),
  unique (decision_id, organization_id)
);

create index organization_coalition_decision_votes_decision_idx
  on public.organization_coalition_decision_votes
  (decision_id, vote, updated_at desc, id desc);
create index organization_coalition_decision_votes_actor_idx
  on public.organization_coalition_decision_votes
  (voter_user_id, updated_at desc) where voter_user_id is not null;

create table public.public_chapter_page_attachments (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  chapter_code text not null,
  section_slug text not null,
  page_slug text not null,
  chapter_document_id uuid not null
    references public.chapter_documents(id) on delete restrict,
  label text not null,
  attached_by uuid references auth.users(id) on delete set null,
  attached_at timestamptz not null default pg_catalog.now(),
  foreign key (organization_id, chapter_code, section_slug, page_slug)
    references public.public_chapter_pages (
      organization_id, chapter_code, section_slug, slug
    ) on update cascade on delete cascade,
  constraint public_chapter_page_attachment_label_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(label)) between 2 and 160
      and label !~ '[[:cntrl:]]'
  ),
  unique (
    organization_id, chapter_code, section_slug, page_slug, chapter_document_id
  )
);

create index public_chapter_page_attachments_page_idx
  on public.public_chapter_page_attachments
  (organization_id, chapter_code, section_slug, page_slug, attached_at, id);
create index public_chapter_page_attachments_document_idx
  on public.public_chapter_page_attachments (chapter_document_id, id);
create index public_chapter_page_attachments_actor_idx
  on public.public_chapter_page_attachments
  (attached_by, attached_at desc) where attached_by is not null;

create table public.public_chapter_page_takeovers (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  chapter_code text not null,
  section_slug text not null,
  page_slug text not null,
  previous_owner_id uuid references auth.users(id) on delete set null,
  new_owner_id uuid references auth.users(id) on delete set null,
  reason text not null,
  idempotency_key uuid not null unique,
  taken_over_at timestamptz not null default pg_catalog.now(),
  foreign key (organization_id, chapter_code, section_slug, page_slug)
    references public.public_chapter_pages (
      organization_id, chapter_code, section_slug, slug
    ) on update cascade on delete cascade,
  constraint public_chapter_page_takeover_reason_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(reason)) between 4 and 500
      and reason !~ '[[:cntrl:]]'
  )
);

create index public_chapter_page_takeovers_page_idx
  on public.public_chapter_page_takeovers
  (organization_id, chapter_code, section_slug, page_slug, taken_over_at desc, id desc);
create index public_chapter_page_takeovers_actor_idx
  on public.public_chapter_page_takeovers
  (new_owner_id, taken_over_at desc) where new_owner_id is not null;
create index public_chapter_page_takeovers_previous_owner_idx
  on public.public_chapter_page_takeovers
  (previous_owner_id, taken_over_at desc) where previous_owner_id is not null;

alter table public.organization_coalition_decisions enable row level security;
alter table public.organization_coalition_decision_votes enable row level security;
alter table public.public_chapter_page_attachments enable row level security;
alter table public.public_chapter_page_takeovers enable row level security;

create function private.inherit_organization_coordination_participants()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.parent_id is null then
    return new;
  end if;
  insert into public.organization_coordination_organization_participants (
    record_id, organization_id, role, status, invited_by, responded_by
  )
  select new.id, participant.organization_id,
    case when participant.organization_id = new.organization_id
      then 'owner' else participant.role end,
    participant.status,
    new.created_by,
    case when participant.status = 'active' then new.created_by else null end
  from public.organization_coordination_organization_participants participant
  where participant.record_id = new.parent_id
    and participant.status in ('active', 'invited')
  on conflict (record_id, organization_id) do update
    set role = excluded.role,
        status = case
          when excluded.status = 'active' then 'active'
          else public.organization_coordination_organization_participants.status
        end,
        responded_by = case
          when excluded.status = 'active' then excluded.responded_by
          else public.organization_coordination_organization_participants.responded_by
        end,
        updated_at = pg_catalog.clock_timestamp();
  return new;
end;
$function$;

create trigger inherit_organization_coordination_participants
after insert on public.organization_coordination_records
for each row execute function private.inherit_organization_coordination_participants();

create function private.validate_organization_coalition_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  campaign public.organization_coordination_records%rowtype;
  subject public.organization_coordination_records%rowtype;
begin
  select * into campaign
  from public.organization_coordination_records record
  where record.id = new.campaign_id;
  select * into subject
  from public.organization_coordination_records record
  where record.id = new.subject_record_id;

  if campaign.id is null or campaign.kind <> 'coalition_campaign'
    or campaign.status not in ('active', 'paused') then
    raise exception 'coalition campaign unavailable' using errcode = '23514';
  end if;
  if subject.id is null or subject.kind <> 'coalition_work_item'
    or subject.parent_id <> campaign.id then
    raise exception 'coalition work item unavailable' using errcode = '23514';
  end if;
  if not exists (
    select 1
    from public.organization_coordination_organization_participants participant
    where participant.record_id = campaign.id
      and participant.organization_id = new.proposing_organization_id
      and participant.status = 'active'
  ) then
    raise exception 'active coalition organization required' using errcode = '23514';
  end if;
  return new;
end;
$function$;

create trigger validate_organization_coalition_decision
before insert or update of campaign_id, subject_record_id, proposing_organization_id
on public.organization_coalition_decisions
for each row execute function private.validate_organization_coalition_decision();

create function private.validate_public_chapter_page_attachment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not exists (
    select 1
    from public.chapter_documents document
    join public.chapters chapter on chapter.id = document.chapter_id
    where document.id = new.chapter_document_id
      and document.chapter_id = new.chapter_code
      and document.status = 'published'
      and chapter.organization_id = new.organization_id
  ) then
    raise exception 'published same-chapter document required' using errcode = '23514';
  end if;
  return new;
end;
$function$;

create trigger validate_public_chapter_page_attachment
before insert or update of organization_id, chapter_code, chapter_document_id
on public.public_chapter_page_attachments
for each row execute function private.validate_public_chapter_page_attachment();

revoke all on function private.validate_organization_coalition_decision()
  from public, anon, authenticated, service_role;
revoke all on function private.validate_public_chapter_page_attachment()
  from public, anon, authenticated, service_role;
revoke all on function private.inherit_organization_coordination_participants()
  from public, anon, authenticated, service_role;

create policy organization_coalition_decisions_read
  on public.organization_coalition_decisions for select to authenticated
  using (private.organization_coordination_can_read(campaign_id));
create policy organization_coalition_decision_votes_read
  on public.organization_coalition_decision_votes for select to authenticated
  using (exists (
    select 1 from public.organization_coalition_decisions decision
    where decision.id = decision_id
      and private.organization_coordination_can_read(decision.campaign_id)
  ));
create policy public_chapter_page_attachments_staff_read
  on public.public_chapter_page_attachments for select to authenticated
  using (private.has_organization_role(
    organization_id, array['steward','coordinator','advisor','admin','vp']
  ));
create policy public_chapter_page_takeovers_staff_read
  on public.public_chapter_page_takeovers for select to authenticated
  using (private.has_organization_role(
    organization_id, array['coordinator','admin','vp']
  ));

do $block$
declare table_name text;
begin
  foreach table_name in array array[
    'organization_coalition_decisions',
    'organization_coalition_decision_votes',
    'public_chapter_page_attachments',
    'public_chapter_page_takeovers'
  ] loop
    execute pg_catalog.format(
      'create policy mfa_assurance on public.%I as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()))',
      table_name
    );
    execute pg_catalog.format(
      'revoke all on public.%I from public, anon, authenticated', table_name
    );
    execute pg_catalog.format(
      'grant select on public.%I to authenticated', table_name
    );
  end loop;
end;
$block$;

create function public.propose_organization_coalition_decision(
  p_campaign_id uuid,
  p_subject_record_id uuid,
  p_title text,
  p_rationale text default '',
  p_action text default 'authorize_work',
  p_required_approvals integer default null,
  p_idempotency_key uuid default extensions.gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  campaign public.organization_coordination_records%rowtype;
  eligible_count integer;
  required_count integer;
  decision_id uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.organization_coordination_is_staff(organization) then
    raise exception 'coalition decision role required' using errcode = '42501';
  end if;
  select * into campaign
  from public.organization_coordination_records record
  where record.id = p_campaign_id and record.kind = 'coalition_campaign'
    and record.status in ('active', 'paused') for update;
  if not found or not private.organization_coordination_can_read(campaign.id)
    or not exists (
      select 1
      from public.organization_coordination_organization_participants participant
      where participant.record_id = campaign.id
        and participant.organization_id = organization
        and participant.status = 'active'
    ) then
    raise exception 'active coalition campaign unavailable' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.organization_coordination_records work
    where work.id = p_subject_record_id
      and work.kind = 'coalition_work_item'
      and work.parent_id = campaign.id
      and work.status in ('draft', 'active', 'paused')
  ) then
    raise exception 'coalition work item unavailable' using errcode = '22023';
  end if;
  if p_action not in ('authorize_work', 'pause_work', 'complete_work') then
    raise exception 'coalition decision action unavailable' using errcode = '22023';
  end if;
  select pg_catalog.count(*)::integer into eligible_count
  from public.organization_coordination_organization_participants participant
  where participant.record_id = campaign.id and participant.status = 'active';
  required_count := coalesce(p_required_approvals, (eligible_count / 2) + 1);
  if required_count not between 1 and eligible_count then
    raise exception 'coalition approval threshold unavailable' using errcode = '22023';
  end if;

  insert into public.organization_coalition_decisions (
    campaign_id, subject_record_id, proposing_organization_id, title,
    rationale, action, required_approvals, proposed_by, idempotency_key
  ) values (
    campaign.id, p_subject_record_id, organization,
    pg_catalog.btrim(p_title), coalesce(p_rationale, ''), p_action,
    required_count, caller, p_idempotency_key
  )
  on conflict (idempotency_key) do update
    set idempotency_key = excluded.idempotency_key
  returning id into decision_id;

  insert into public.organization_coordination_events (
    record_id, organization_id, actor_user_id, event_type, metadata,
    idempotency_key
  ) values (
    campaign.id, organization, caller, 'coalition_decision_proposed',
    pg_catalog.jsonb_build_object(
      'decisionId', decision_id,
      'subjectRecordId', p_subject_record_id,
      'action', p_action,
      'requiredApprovals', required_count
    ), extensions.gen_random_uuid()
  );
  return pg_catalog.jsonb_build_object(
    'decisionId', decision_id, 'status', 'open',
    'requiredApprovals', required_count, 'eligibleOrganizations', eligible_count
  );
end;
$function$;

create function public.vote_organization_coalition_decision(
  p_decision_id uuid,
  p_vote text,
  p_comment text default '',
  p_idempotency_key uuid default extensions.gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  decision public.organization_coalition_decisions%rowtype;
  campaign public.organization_coordination_records%rowtype;
  eligible_count integer;
  approval_count integer;
  rejection_count integer;
  next_status text := 'open';
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.organization_coordination_is_staff(organization) then
    raise exception 'coalition vote role required' using errcode = '42501';
  end if;
  if p_vote not in ('approve', 'reject', 'abstain')
    or pg_catalog.char_length(coalesce(p_comment, '')) > 1000 then
    raise exception 'coalition vote unavailable' using errcode = '22023';
  end if;
  select * into decision
  from public.organization_coalition_decisions item
  where item.id = p_decision_id for update;
  if not found or decision.status <> 'open' then
    raise exception 'open coalition decision unavailable' using errcode = '22023';
  end if;
  select * into campaign
  from public.organization_coordination_records record
  where record.id = decision.campaign_id;
  if not found or not private.organization_coordination_can_read(campaign.id)
    or not exists (
      select 1
      from public.organization_coordination_organization_participants participant
      where participant.record_id = campaign.id
        and participant.organization_id = organization
        and participant.status = 'active'
    ) then
    raise exception 'active coalition organization required' using errcode = '42501';
  end if;

  insert into public.organization_coalition_decision_votes (
    decision_id, organization_id, voter_user_id, vote, comment,
    idempotency_key
  ) values (
    decision.id, organization, caller, p_vote, coalesce(p_comment, ''),
    p_idempotency_key
  ) on conflict (decision_id, organization_id) do update
    set voter_user_id = caller,
        vote = excluded.vote,
        comment = excluded.comment,
        idempotency_key = excluded.idempotency_key,
        updated_at = pg_catalog.clock_timestamp();

  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) filter (where vote.vote = 'approve')::integer,
    pg_catalog.count(*) filter (where vote.vote = 'reject')::integer
  into eligible_count, approval_count, rejection_count
  from public.organization_coordination_organization_participants participant
  left join public.organization_coalition_decision_votes vote
    on vote.decision_id = decision.id
      and vote.organization_id = participant.organization_id
  where participant.record_id = campaign.id and participant.status = 'active';

  if approval_count >= decision.required_approvals then
    next_status := 'approved';
  elsif eligible_count - rejection_count < decision.required_approvals then
    next_status := 'rejected';
  end if;

  if next_status <> 'open' then
    update public.organization_coalition_decisions
    set status = next_status,
        resolved_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    where id = decision.id;
  else
    update public.organization_coalition_decisions
    set updated_at = pg_catalog.clock_timestamp()
    where id = decision.id;
  end if;

  if next_status = 'approved' then
    update public.organization_coordination_records
    set status = case decision.action
          when 'authorize_work' then 'active'
          when 'pause_work' then 'paused'
          when 'complete_work' then 'completed'
        end,
        updated_at = pg_catalog.clock_timestamp()
    where id = decision.subject_record_id;
  end if;

  insert into public.organization_coordination_events (
    record_id, organization_id, actor_user_id, event_type, to_status,
    metadata, idempotency_key
  ) values (
    campaign.id, organization, caller, 'coalition_decision_voted', next_status,
    pg_catalog.jsonb_build_object(
      'decisionId', decision.id, 'vote', p_vote,
      'approvals', approval_count, 'rejections', rejection_count,
      'requiredApprovals', decision.required_approvals
    ), extensions.gen_random_uuid()
  );
  return pg_catalog.jsonb_build_object(
    'decisionId', decision.id, 'status', next_status,
    'approvals', approval_count, 'rejections', rejection_count,
    'requiredApprovals', decision.required_approvals,
    'eligibleOrganizations', eligible_count
  );
end;
$function$;

create function public.get_organization_coalition_decisions()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if organization is null or not private.organization_coordination_is_staff(organization) then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', decision.id,
      'campaignId', decision.campaign_id,
      'subjectRecordId', decision.subject_record_id,
      'title', decision.title,
      'rationale', decision.rationale,
      'action', decision.action,
      'status', decision.status,
      'requiredApprovals', decision.required_approvals,
      'approvals', (
        select pg_catalog.count(*)::integer
        from public.organization_coalition_decision_votes vote
        where vote.decision_id = decision.id and vote.vote = 'approve'
      ),
      'rejections', (
        select pg_catalog.count(*)::integer
        from public.organization_coalition_decision_votes vote
        where vote.decision_id = decision.id and vote.vote = 'reject'
      ),
      'myVote', (
        select vote.vote
        from public.organization_coalition_decision_votes vote
        where vote.decision_id = decision.id
          and vote.organization_id = organization
        limit 1
      ),
      'createdAt', decision.created_at,
      'resolvedAt', decision.resolved_at
    ) order by decision.created_at desc, decision.id desc)
    from public.organization_coalition_decisions decision
    where private.organization_coordination_can_read(decision.campaign_id)
  ), '[]'::jsonb);
end;
$function$;

create function public.upsert_public_chapter_microsite_section(
  p_chapter_code text,
  p_slug text,
  p_title_en text,
  p_title_es text,
  p_body_en text,
  p_body_es text,
  p_sort_order integer default 0,
  p_is_published boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.organization_coordination_is_staff(organization) then
    raise exception 'chapter publishing role required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.public_site_records chapter
    where chapter.organization_id = organization
      and chapter.id = p_chapter_code and chapter.kind = 'chapter'
  ) then
    raise exception 'public chapter unavailable' using errcode = '22023';
  end if;
  insert into public.public_chapter_sections (
    organization_id, chapter_code, slug, title_en, title_es, body_en,
    body_es, sort_order, is_published, published_at, created_by
  ) values (
    organization, p_chapter_code, pg_catalog.lower(pg_catalog.btrim(p_slug)),
    pg_catalog.btrim(p_title_en), pg_catalog.btrim(p_title_es),
    pg_catalog.btrim(p_body_en), pg_catalog.btrim(p_body_es),
    p_sort_order, p_is_published,
    case when p_is_published then pg_catalog.clock_timestamp() else null end,
    caller
  ) on conflict (organization_id, chapter_code, slug) do update
    set title_en = excluded.title_en,
        title_es = excluded.title_es,
        body_en = excluded.body_en,
        body_es = excluded.body_es,
        sort_order = excluded.sort_order,
        is_published = excluded.is_published,
        published_at = case when excluded.is_published
          then coalesce(public.public_chapter_sections.published_at, pg_catalog.clock_timestamp())
          else null end,
        updated_at = pg_catalog.clock_timestamp();
  return pg_catalog.jsonb_build_object(
    'saved', true, 'chapterCode', p_chapter_code,
    'sectionSlug', pg_catalog.lower(pg_catalog.btrim(p_slug)),
    'published', p_is_published
  );
end;
$function$;

create function public.upsert_public_chapter_microsite_page(
  p_chapter_code text,
  p_section_slug text,
  p_slug text,
  p_title_en text,
  p_title_es text,
  p_body_en text,
  p_body_es text,
  p_sort_order integer default 0,
  p_is_published boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.organization_coordination_is_staff(organization) then
    raise exception 'chapter publishing role required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.public_chapter_sections section
    where section.organization_id = organization
      and section.chapter_code = p_chapter_code
      and section.slug = p_section_slug
  ) then
    raise exception 'public chapter section unavailable' using errcode = '22023';
  end if;
  insert into public.public_chapter_pages (
    organization_id, chapter_code, section_slug, slug, title_en, title_es,
    body_en, body_es, sort_order, is_published, published_at, created_by
  ) values (
    organization, p_chapter_code, p_section_slug,
    pg_catalog.lower(pg_catalog.btrim(p_slug)),
    pg_catalog.btrim(p_title_en), pg_catalog.btrim(p_title_es),
    pg_catalog.btrim(p_body_en), pg_catalog.btrim(p_body_es),
    p_sort_order, p_is_published,
    case when p_is_published then pg_catalog.clock_timestamp() else null end,
    caller
  ) on conflict (organization_id, chapter_code, section_slug, slug) do update
    set title_en = excluded.title_en,
        title_es = excluded.title_es,
        body_en = excluded.body_en,
        body_es = excluded.body_es,
        sort_order = excluded.sort_order,
        is_published = excluded.is_published,
        published_at = case when excluded.is_published
          then coalesce(public.public_chapter_pages.published_at, pg_catalog.clock_timestamp())
          else null end,
        updated_at = pg_catalog.clock_timestamp();
  return pg_catalog.jsonb_build_object(
    'saved', true, 'chapterCode', p_chapter_code,
    'sectionSlug', p_section_slug,
    'pageSlug', pg_catalog.lower(pg_catalog.btrim(p_slug)),
    'published', p_is_published
  );
end;
$function$;

create function public.attach_public_chapter_page_document(
  p_chapter_code text,
  p_section_slug text,
  p_page_slug text,
  p_chapter_document_id uuid,
  p_label text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  attachment_id uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.organization_coordination_is_staff(organization) then
    raise exception 'chapter publishing role required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.public_chapter_pages page
    where page.organization_id = organization
      and page.chapter_code = p_chapter_code
      and page.section_slug = p_section_slug
      and page.slug = p_page_slug
  ) then
    raise exception 'public chapter page unavailable' using errcode = '22023';
  end if;
  insert into public.public_chapter_page_attachments (
    organization_id, chapter_code, section_slug, page_slug,
    chapter_document_id, label, attached_by
  ) values (
    organization, p_chapter_code, p_section_slug, p_page_slug,
    p_chapter_document_id, pg_catalog.btrim(p_label), caller
  ) on conflict (
    organization_id, chapter_code, section_slug, page_slug, chapter_document_id
  ) do update set
    label = excluded.label,
    attached_by = caller,
    attached_at = pg_catalog.clock_timestamp()
  returning id into attachment_id;
  return pg_catalog.jsonb_build_object(
    'attached', true, 'attachmentId', attachment_id,
    'chapterCode', p_chapter_code, 'pageSlug', p_page_slug
  );
end;
$function$;

create function public.take_over_public_chapter_page(
  p_chapter_code text,
  p_section_slug text,
  p_page_slug text,
  p_reason text,
  p_idempotency_key uuid default extensions.gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  page public.public_chapter_pages%rowtype;
  takeover_id uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.has_organization_role(organization, array['admin','vp']) then
    raise exception 'chapter takeover role required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_reason, ''))) not between 4 and 500 then
    raise exception 'takeover reason required' using errcode = '22023';
  end if;
  select * into page from public.public_chapter_pages record
  where record.organization_id = organization
    and record.chapter_code = p_chapter_code
    and record.section_slug = p_section_slug
    and record.slug = p_page_slug for update;
  if not found then
    raise exception 'public chapter page unavailable' using errcode = '22023';
  end if;
  insert into public.public_chapter_page_takeovers (
    organization_id, chapter_code, section_slug, page_slug,
    previous_owner_id, new_owner_id, reason, idempotency_key
  ) values (
    organization, p_chapter_code, p_section_slug, p_page_slug,
    page.created_by, caller, pg_catalog.btrim(p_reason), p_idempotency_key
  ) on conflict (idempotency_key) do update
    set idempotency_key = excluded.idempotency_key
  returning id into takeover_id;
  update public.public_chapter_pages
  set created_by = caller, updated_at = pg_catalog.clock_timestamp()
  where organization_id = organization
    and chapter_code = p_chapter_code
    and section_slug = p_section_slug and slug = p_page_slug;
  return pg_catalog.jsonb_build_object(
    'takenOver', true, 'takeoverId', takeover_id,
    'chapterCode', p_chapter_code, 'pageSlug', p_page_slug,
    'ownerId', caller
  );
end;
$function$;

create function public.get_public_chapter_microsite_editor(p_chapter_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.organization_coordination_is_staff(organization) then
    raise exception 'chapter publishing role required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.public_site_records chapter
    where chapter.organization_id = organization
      and chapter.id = p_chapter_code and chapter.kind = 'chapter'
  ) then
    return pg_catalog.jsonb_build_object(
      'state', 'missing', 'chapterCode', p_chapter_code,
      'sections', '[]'::jsonb, 'pages', '[]'::jsonb,
      'attachments', '[]'::jsonb, 'takeovers', '[]'::jsonb
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'state', 'ready', 'chapterCode', p_chapter_code,
    'sections', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'slug', section.slug,
        'titleEn', section.title_en, 'titleEs', section.title_es,
        'bodyEn', section.body_en, 'bodyEs', section.body_es,
        'sortOrder', section.sort_order,
        'published', section.is_published,
        'updatedAt', section.updated_at
      ) order by section.sort_order, section.slug)
      from public.public_chapter_sections section
      where section.organization_id = organization
        and section.chapter_code = p_chapter_code
    ), '[]'::jsonb),
    'pages', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'sectionSlug', page.section_slug, 'slug', page.slug,
        'titleEn', page.title_en, 'titleEs', page.title_es,
        'bodyEn', page.body_en, 'bodyEs', page.body_es,
        'sortOrder', page.sort_order, 'published', page.is_published,
        'updatedAt', page.updated_at
      ) order by page.section_slug, page.sort_order, page.slug)
      from public.public_chapter_pages page
      where page.organization_id = organization
        and page.chapter_code = p_chapter_code
    ), '[]'::jsonb),
    'attachments', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', attachment.id, 'sectionSlug', attachment.section_slug,
        'pageSlug', attachment.page_slug,
        'documentId', attachment.chapter_document_id,
        'label', attachment.label, 'attachedAt', attachment.attached_at
      ) order by attachment.section_slug, attachment.page_slug,
        attachment.attached_at, attachment.id)
      from public.public_chapter_page_attachments attachment
      where attachment.organization_id = organization
        and attachment.chapter_code = p_chapter_code
    ), '[]'::jsonb),
    'takeovers', case when private.has_organization_role(
      organization, array['coordinator','admin','vp']
    ) then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', takeover.id, 'sectionSlug', takeover.section_slug,
        'pageSlug', takeover.page_slug, 'reason', takeover.reason,
        'takenOverAt', takeover.taken_over_at
      ) order by takeover.taken_over_at desc, takeover.id desc)
      from public.public_chapter_page_takeovers takeover
      where takeover.organization_id = organization
        and takeover.chapter_code = p_chapter_code
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$function$;

create or replace function public.get_public_chapter_microsite(
  p_chapter_code text,
  p_locale text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  wanted text := case when p_locale = 'es' then 'es' else 'en' end;
  chapter jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'id', record.id,
    'title', case when wanted = 'es' then record.title_es else record.title_en end,
    'body', case when wanted = 'es' then record.body_es else record.body_en end,
    'region', case when wanted = 'es' then record.region_es else record.region_en end,
    'url', record.url,
    'sections', coalesce((
      select pg_catalog.jsonb_agg(section_item.item order by section_item.sort_order, section_item.slug)
      from (
        select section.sort_order, section.slug,
          pg_catalog.jsonb_build_object(
            'id', section.slug,
            'title', case when wanted = 'es' then section.title_es else section.title_en end,
            'body', case when wanted = 'es' then section.body_es else section.body_en end,
            'pages', coalesce((
              select pg_catalog.jsonb_agg(page_item.item order by page_item.sort_order, page_item.slug)
              from (
                select page.sort_order, page.slug,
                  pg_catalog.jsonb_build_object(
                    'id', page.slug,
                    'title', case when wanted = 'es' then page.title_es else page.title_en end,
                    'body', case when wanted = 'es' then page.body_es else page.body_en end,
                    'attachments', coalesce((
                      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                        'id', attachment.id,
                        'label', attachment.label,
                        'title', document.title,
                        'summary', document.summary,
                        'documentType', document.document_type,
                        'sourceUrl', case
                          when document.source_url ~ '^https://[^[:space:]]+$'
                            then document.source_url
                          else null
                        end
                      ) order by attachment.attached_at, attachment.id)
                      from public.public_chapter_page_attachments attachment
                      join public.chapter_documents document
                        on document.id = attachment.chapter_document_id
                      where attachment.organization_id = page.organization_id
                        and attachment.chapter_code = page.chapter_code
                        and attachment.section_slug = page.section_slug
                        and attachment.page_slug = page.slug
                        and document.status = 'published'
                    ), '[]'::jsonb)
                  ) as item
                from public.public_chapter_pages page
                where page.organization_id = section.organization_id
                  and page.chapter_code = section.chapter_code
                  and page.section_slug = section.slug
                  and page.is_published
                order by page.sort_order, page.slug
                limit 24
              ) page_item
            ), '[]'::jsonb)
          ) as item
        from public.public_chapter_sections section
        where section.organization_id = record.organization_id
          and section.chapter_code = record.id
          and section.is_published
        order by section.sort_order, section.slug
        limit 24
      ) section_item
    ), '[]'::jsonb),
    'events', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', event.id,
        'title', case when wanted = 'es' then event.title_es else event.title_en end,
        'body', case when wanted = 'es' then event.body_es else event.body_en end,
        'startsAt', event.starts_at,
        'endsAt', event.ends_at,
        'location', case when wanted = 'es' then event.location_es else event.location_en end,
        'url', event.url,
        'chapterCode', event.chapter_code,
        'category', 'meeting'
      ) order by event.starts_at, event.id)
      from (
        select source.*
        from public.public_site_records source
        where source.is_published and source.kind = 'meeting'
          and source.organization_id = record.organization_id
          and source.chapter_code = record.id
        order by source.starts_at, source.id
        limit 100
      ) event
    ), '[]'::jsonb)
  ) into chapter
  from public.public_site_records record
  where record.id = p_chapter_code
    and record.is_published and record.kind = 'chapter'
    and record.organization_id is not null;
  return chapter;
end;
$function$;

revoke all on function public.propose_organization_coalition_decision(
  uuid, uuid, text, text, text, integer, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.vote_organization_coalition_decision(
  uuid, text, text, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.get_organization_coalition_decisions()
  from public, anon, authenticated, service_role;
revoke all on function public.upsert_public_chapter_microsite_section(
  text, text, text, text, text, text, integer, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.upsert_public_chapter_microsite_page(
  text, text, text, text, text, text, text, integer, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.attach_public_chapter_page_document(
  text, text, text, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.take_over_public_chapter_page(
  text, text, text, text, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.get_public_chapter_microsite_editor(text)
  from public, anon, authenticated, service_role;
revoke all on function public.get_public_chapter_microsite(text, text)
  from public, anon, authenticated, service_role;

grant execute on function public.propose_organization_coalition_decision(
  uuid, uuid, text, text, text, integer, uuid
) to authenticated;
grant execute on function public.vote_organization_coalition_decision(
  uuid, text, text, uuid
) to authenticated;
grant execute on function public.get_organization_coalition_decisions()
  to authenticated;
grant execute on function public.upsert_public_chapter_microsite_section(
  text, text, text, text, text, text, integer, boolean
) to authenticated;
grant execute on function public.upsert_public_chapter_microsite_page(
  text, text, text, text, text, text, text, integer, boolean
) to authenticated;
grant execute on function public.attach_public_chapter_page_document(
  text, text, text, uuid, text
) to authenticated;
grant execute on function public.take_over_public_chapter_page(
  text, text, text, text, uuid
) to authenticated;
grant execute on function public.get_public_chapter_microsite_editor(text)
  to authenticated;
grant execute on function public.get_public_chapter_microsite(text, text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
