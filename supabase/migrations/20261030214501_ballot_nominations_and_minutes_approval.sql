-- REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030 (#6573).
--
-- The October 29-30, 2026 role-play run (findings 49 and 94):
--   * an election committee had no nominations: no period, no seconder and no
--     export for the committee;
--   * minutes had no location and no approved status, and attendance did not
--     come from the meeting's check-ins.
--
-- 1. Nominations feed a standard ballot draft. Staff who may manage the
--    ballot (private.can_manage_vote_campaign, the publish_vote_campaign
--    predicate) open a nominations period by setting
--    member_ballots.nominations_close_at. While the ballot is still an
--    unpublished draft and the period is open, a member the ballot will be
--    open to (private.can_read_vote_campaign) nominates a person by name with
--    an optional statement, and another eligible member seconds it. Members
--    see the nominee names and whether each is seconded, never who nominated
--    or seconded. The election committee (ballot managers) exports every
--    nomination with its nominator and seconder. Votes stay exactly as
--    before: ballot secrecy and tallies are untouched.
-- 2. Minutes carry a location and an approved status with approver, date and
--    the version approved: an edit that makes a new version leaves the
--    approval on the old version, so the client shows it as approved only
--    when approved_version = version. Staff of the chapter save minutes with
--    their location through public.save_chapter_minutes (the record and its
--    location in one version-checked transaction) and the approval through
--    public.set_chapter_minutes_approval, which approves only the version the
--    approver was shown; attendance can be filled from the linked meeting's
--    check-ins through public.get_minutes_meeting_checkins.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Minutes location and approval
-- ---------------------------------------------------------------------------

alter table public.chapter_records
  add column location text,
  add column approved_at timestamptz,
  add column approved_by uuid references auth.users(id) on delete set null,
  add column approved_version integer;

alter table public.chapter_records
  add constraint chapter_records_location_bounded check (
    location is null or (
      pg_catalog.char_length(pg_catalog.btrim(location)) between 1 and 200
      and location !~ '[[:cntrl:]]'
    )
  ),
  add constraint chapter_records_approval_shape check (
    (approved_at is null and approved_by is null and approved_version is null)
    or (approved_at is not null and approved_version is not null and approved_version > 0)
  );

comment on column public.chapter_records.location is
  'REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: where the meeting took place. Set through save_chapter_minutes, with the record it belongs to.';
comment on column public.chapter_records.approved_at is
  'When the minutes were marked approved (for example at the next meeting); with approved_by and approved_version. Set through set_chapter_minutes_approval.';
comment on column public.chapter_records.approved_by is
  'Staff member who marked the minutes approved; set null when that account is deleted.';
comment on column public.chapter_records.approved_version is
  'The minutes version that was approved. A later edit makes a new version, which is not approved until it is approved again.';

-- The new auth.users column joins the record's case-graph row keys.
drop trigger z99_case_graph_keys on public.chapter_records;
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_records
for each row execute function private.lock_case_graph_row_keys('{approved_by},{created_by}', '{case_id}');

create function public.save_chapter_minutes(
  p_record_id uuid,
  p_title text,
  p_body text,
  p_occurred_at timestamptz,
  p_location text,
  p_visibility text default 'chapter',
  p_action text default 'save',
  p_pinned boolean default false,
  p_gap_note text default null,
  p_expected_version integer default null,
  p_attendance jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  ctx record;
  saved jsonb;
  clean text := nullif(pg_catalog.btrim(coalesce(p_location, '')), '');
begin
  select * into ctx from private.institutional_context(true);
  -- The record save runs every existing guard (the expected version,
  -- attendance, publication, dispatch and audit). The location is written in
  -- the same transaction, so a refused save leaves the location untouched
  -- and a stale edit cannot overwrite a newer version's location.
  saved := public.save_institutional_record(p_record_id, 'minutes', p_title, p_body, p_occurred_at,
    p_visibility, p_action, p_pinned, p_gap_note, p_expected_version, p_attendance);
  if p_action is distinct from 'archive' then
    update public.chapter_records r
    set location = clean
    where r.id = (saved ->> 'id')::uuid and r.chapter_id = ctx.chapter_id
      and r.record_type = 'minutes' and r.archived_at is null;
    if not found then raise exception 'minutes not found' using errcode = 'P0002'; end if;
  end if;
  return saved || pg_catalog.jsonb_build_object('location', case when p_action is distinct from 'archive' then clean else saved ->> 'location' end);
end;
end;
$function$;

revoke all on function public.save_chapter_minutes(uuid, text, text, timestamptz, text, text, text, boolean, text, integer, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.save_chapter_minutes(uuid, text, text, timestamptz, text, text, text, boolean, text, integer, jsonb) to authenticated;
comment on function public.save_chapter_minutes(uuid, text, text, timestamptz, text, text, text, boolean, text, integer, jsonb) is
  'REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: chapter staff save a minutes record and where its meeting took place together: save_institutional_record with every guard, then the location, in one transaction. Archiving leaves the location as it was. The approval is not touched here.';

create function public.set_chapter_minutes_approval(p_record_id uuid, p_expected_version integer, p_approved boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  ctx record;
  target public.chapter_records%rowtype;
begin
  select * into ctx from private.institutional_context(true);
  if p_approved is null then raise exception 'approval state required' using errcode = '22023'; end if;
  select * into target from public.chapter_records r
  where r.id = p_record_id and r.chapter_id = ctx.chapter_id
    and r.record_type = 'minutes' and r.archived_at is null
  for update;
  if not found then raise exception 'minutes not found' using errcode = 'P0002'; end if;
  -- Approve or withdraw only what the approver was shown: a newer version
  -- refuses, so nobody approves an edit they have not read.
  if p_expected_version is distinct from target.version then
    raise exception 'minutes changed since they were opened' using errcode = '40001';
  end if;
  if p_approved and target.lifecycle_status <> 'published' then
    raise exception 'only published minutes can be approved' using errcode = '22023';
  end if;
  update public.chapter_records
  set approved_at = case
        when not p_approved then null
        when target.approved_version is not distinct from target.version then target.approved_at
        else pg_catalog.now() end,
      approved_by = case
        when not p_approved then null
        when target.approved_version is not distinct from target.version then target.approved_by
        else ctx.caller_id end,
      approved_version = case when p_approved then target.version else null end,
      updated_at = pg_catalog.now()
  where id = target.id
  returning * into target;
  return pg_catalog.jsonb_build_object(
    'id', target.id, 'approvedAt', target.approved_at, 'approvedBy', target.approved_by,
    'approvedVersion', target.approved_version, 'version', target.version);
end;
end;
$function$;

revoke all on function public.set_chapter_minutes_approval(uuid, integer, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_chapter_minutes_approval(uuid, integer, boolean) to authenticated;
comment on function public.set_chapter_minutes_approval(uuid, integer, boolean) is
  'REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: chapter staff mark the published minutes version they were shown approved (approver and time kept per version) or withdraw the approval; a version mismatch refuses with 40001.';

create function public.get_minutes_meeting_checkins(p_record_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  ctx record;
  target public.chapter_records%rowtype;
begin
  select * into ctx from private.institutional_context(true);
  select * into target from public.chapter_records r
  where r.id = p_record_id and r.chapter_id = ctx.chapter_id
    and r.record_type = 'minutes' and r.archived_at is null;
  if not found then raise exception 'minutes not found' using errcode = 'P0002'; end if;
  return pg_catalog.jsonb_build_object(
    'eventId', target.event_id,
    'checkedIn', coalesce((
      select pg_catalog.jsonb_agg(checkin.user_id order by checkin.user_id)
      from (
        select distinct c.user_id
        from public.member_event_checkins c
        join public.member_events e on e.id = c.event_id and e.chapter_id = ctx.chapter_id
        join public.member_chapter_memberships cm
          on cm.user_id = c.user_id and cm.chapter_id = ctx.chapter_id and cm.status = 'active'
        where target.event_id is not null and c.event_id = target.event_id
      ) checkin
    ), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.get_minutes_meeting_checkins(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_minutes_meeting_checkins(uuid) to authenticated;
comment on function public.get_minutes_meeting_checkins(uuid) is
  'REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: for chapter staff, the active chapter members checked in to the meeting a minutes record is attached to, so attendance can be filled from check-ins.';

-- ---------------------------------------------------------------------------
-- 2. Ballot nominations
-- ---------------------------------------------------------------------------

alter table public.member_ballots
  add column nominations_close_at timestamptz;

comment on column public.member_ballots.nominations_close_at is
  'REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: end of the nominations period for a standard ballot draft; null when the ballot takes no nominations. Set through set_ballot_nominations_period.';

create table public.ballot_nominations (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete cascade,
  ballot_id text not null references public.member_ballots(id) on delete cascade,
  nominee_name text not null,
  statement text,
  nominated_by uuid references auth.users(id) on delete set null,
  seconded_by uuid references auth.users(id) on delete set null,
  seconded_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  constraint ballot_nominations_nominee_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(nominee_name)) between 2 and 120
    and nominee_name !~ '[[:cntrl:]]'
  ),
  constraint ballot_nominations_statement_bounded check (
    statement is null or (
      pg_catalog.char_length(pg_catalog.btrim(statement)) between 1 and 1000
      and pg_catalog.translate(statement, pg_catalog.chr(10) || pg_catalog.chr(13), '') !~ '[[:cntrl:]]'
    )
  ),
  constraint ballot_nominations_second_shape check (
    (seconded_at is null and seconded_by is null) or seconded_at is not null
  )
);

create index ballot_nominations_ballot_idx on public.ballot_nominations (ballot_id, created_at, id);

alter table public.ballot_nominations enable row level security;
revoke all on table public.ballot_nominations from public, anon, authenticated, service_role;
create policy mfa_assurance on public.ballot_nominations
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
comment on policy mfa_assurance on public.ballot_nominations is
  'Restrictive two-step assurance carried by every RLS table in public. No client role holds a grant on this table, so this is defence in depth: nominations are read and written only through the ballot nomination functions.';

comment on table public.ballot_nominations is
  'REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: nominations for a standard ballot draft, each with its nominator and seconder. No client table grant; read and written only through the ballot nomination functions.';

-- The table references auth.users, so it joins the account case graph.
create trigger a00_case_graph_lock before insert or update or delete on public.ballot_nominations
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.ballot_nominations
for each row execute function private.lock_case_graph_row_keys('{nominated_by},{seconded_by}', '');

-- The ballot a nomination may be made on now: a standard, never-published
-- draft whose nominations period is open, in the caller's selected
-- organization and readable by the caller once published.
create function private.ballot_nominations_open(p_ballot_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1 from public.member_ballots b
    where b.id = p_ballot_id
      and b.ballot_type = 'standard'
      and b.campaign_state = 'draft' and b.published_at is null
      and b.nominations_close_at is not null and b.nominations_close_at > pg_catalog.now()
      and b.organization_id is not null
      and b.organization_id = private.current_member_organization()
      and private.can_read_vote_campaign(b.organization_id, b.chapter_id)
  )
$function$;

revoke all on function private.ballot_nominations_open(text) from public, anon, authenticated, service_role;

create function public.set_ballot_nominations_period(p_ballot_id text, p_close_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  ballot record;
begin
  if caller is null
     or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select b.id, b.chapter_id into ballot
  from public.member_ballots b
  where b.id = p_ballot_id
    and private.can_manage_vote_campaign(b.organization_id, b.chapter_id)
    and b.ballot_type = 'standard'
    and b.campaign_state = 'draft' and b.published_at is null
  for update;
  if not found then raise exception 'campaign not found' using errcode = '22023'; end if;
  update public.member_ballots set nominations_close_at = p_close_at where id = p_ballot_id;
  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'update_campaign_draft', pg_catalog.jsonb_build_object(
    'campaignId', p_ballot_id, 'kind', 'ballot',
    'scope', case when ballot.chapter_id is null then 'union' else 'chapter' end,
    'state', 'draft', 'nominationsCloseAt', p_close_at));
  return pg_catalog.jsonb_build_object('id', p_ballot_id, 'nominationsCloseAt', p_close_at);
end;
end;
$function$;

revoke all on function public.set_ballot_nominations_period(text, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.set_ballot_nominations_period(text, timestamptz) to authenticated;
comment on function public.set_ballot_nominations_period(text, timestamptz) is
  'REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: ballot managers open (close time ahead), end (close time past) or remove (null) the nominations period of a standard, never-published ballot draft.';

create function public.get_open_ballot_nominations()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'ballotId', b.id, 'title', b.title, 'titleEs', b.title_es,
      'nominationsCloseAt', b.nominations_close_at,
      'nominations', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', n.id, 'nomineeName', n.nominee_name, 'statement', n.statement,
          'seconded', n.seconded_at is not null,
          'mine', n.nominated_by = caller
        ) order by n.created_at, n.id)
        from public.ballot_nominations n where n.ballot_id = b.id
      ), '[]'::jsonb)
    ) order by b.nominations_close_at, b.id)
    from public.member_ballots b
    where private.ballot_nominations_open(b.id)
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.get_open_ballot_nominations() from public, anon, authenticated, service_role;
grant execute on function public.get_open_ballot_nominations() to authenticated;
comment on function public.get_open_ballot_nominations() is
  'REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: the ballots now taking nominations that the caller may take part in, with nominee names, statements and whether each is seconded; never who nominated or seconded, except a mine flag on the caller''s own.';

create function public.nominate_for_ballot(p_ballot_id text, p_nominee_name text, p_statement text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  org uuid;
  saved public.ballot_nominations%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select b.organization_id into org from public.member_ballots b
  where b.id = p_ballot_id and private.ballot_nominations_open(b.id)
  for update;
  if not found then raise exception 'nominations are not open' using errcode = '22023'; end if;
  if (select pg_catalog.count(*) from public.ballot_nominations n
      where n.ballot_id = p_ballot_id and n.nominated_by = caller) >= 10 then
    raise exception 'nomination limit reached' using errcode = '54000';
  end if;
  insert into public.ballot_nominations (organization_id, ballot_id, nominee_name, statement, nominated_by)
  values (org, p_ballot_id, pg_catalog.btrim(coalesce(p_nominee_name, '')),
          nullif(pg_catalog.btrim(coalesce(p_statement, '')), ''), caller)
  returning * into saved;
  return pg_catalog.jsonb_build_object('id', saved.id, 'ballotId', saved.ballot_id, 'nomineeName', saved.nominee_name, 'seconded', false);
end;
end;
$function$;

revoke all on function public.nominate_for_ballot(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.nominate_for_ballot(text, text, text) to authenticated;
comment on function public.nominate_for_ballot(text, text, text) is
  'REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: an eligible member nominates a person by name, with an optional statement, while the ballot''s nominations period is open; at most ten nominations per member per ballot.';

create function public.second_ballot_nomination(p_nomination_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  target public.ballot_nominations%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into target from public.ballot_nominations n
  where n.id = p_nomination_id and private.ballot_nominations_open(n.ballot_id)
  for update;
  if not found then raise exception 'nomination not found' using errcode = 'P0002'; end if;
  if target.nominated_by is not distinct from caller then
    raise exception 'a nominator cannot second their own nomination' using errcode = '22023';
  end if;
  if target.seconded_at is not null then
    raise exception 'nomination already seconded' using errcode = '23505';
  end if;
  update public.ballot_nominations
  set seconded_by = caller, seconded_at = pg_catalog.now()
  where id = target.id;
  return pg_catalog.jsonb_build_object('id', target.id, 'seconded', true);
end;
end;
$function$;

revoke all on function public.second_ballot_nomination(uuid) from public, anon, authenticated, service_role;
grant execute on function public.second_ballot_nomination(uuid) to authenticated;
comment on function public.second_ballot_nomination(uuid) is
  'REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: another eligible member seconds an open nomination once; the nominator cannot second their own.';

create function public.export_ballot_nominations(p_ballot_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  ballot record;
begin
  if caller is null
     or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select b.id, b.title, b.nominations_close_at into ballot
  from public.member_ballots b
  where b.id = p_ballot_id
    and private.can_manage_vote_campaign(b.organization_id, b.chapter_id)
    and b.ballot_type = 'standard';
  if not found then raise exception 'campaign not found' using errcode = '22023'; end if;
  return pg_catalog.jsonb_build_object(
    'ballotId', ballot.id, 'title', ballot.title, 'nominationsCloseAt', ballot.nominations_close_at,
    'generatedAt', pg_catalog.now(),
    'nominations', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', n.id, 'nomineeName', n.nominee_name, 'statement', n.statement,
        'nominatedBy', nominator.full_name, 'nominatedAt', n.created_at,
        'secondedBy', seconder.full_name, 'secondedAt', n.seconded_at
      ) order by n.created_at, n.id)
      from public.ballot_nominations n
      left join public.member_profiles nominator on nominator.id = n.nominated_by
      left join public.member_profiles seconder on seconder.id = n.seconded_by
      where n.ballot_id = ballot.id
    ), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.export_ballot_nominations(text) from public, anon, authenticated, service_role;
grant execute on function public.export_ballot_nominations(text) to authenticated;
comment on function public.export_ballot_nominations(text) is
  'REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: for the ballot''s managers (the election committee), every nomination with its statement, nominator, seconder and times, for export.';

-- ---------------------------------------------------------------------------
-- 3. Account lifecycle: the three new auth.users columns
-- ---------------------------------------------------------------------------

insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition, export_inventory_basis,
   exclusion_reason, note, reviewed_at)
values
  ('public', 'chapter_records', 'approved_by', 'not_applicable', 'excluded_with_reason', 'auth_user_fk',
   'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.',
   'Staff member who marked minutes approved; set null when that account is deleted.', date '2026-10-30'),
  ('public', 'ballot_nominations', 'nominated_by', 'not_applicable', 'excluded_with_reason', 'auth_user_fk',
   'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.',
   'Member who made a ballot nomination; set null when that account is deleted, and the nomination stays with the election record.', date '2026-10-30'),
  ('public', 'ballot_nominations', 'seconded_by', 'not_applicable', 'excluded_with_reason', 'auth_user_fk',
   'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.',
   'Member who seconded a ballot nomination; set null when that account is deleted.', date '2026-10-30');

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'public' and (
        (table_name = 'chapter_records' and object_name = 'z99_case_graph_keys')
        or (table_name = 'ballot_nominations' and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys')))
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_nominations_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after nominations: %',
      (select pg_catalog.string_agg(i.schema_name || '.' || i.table_name || '.' || i.trigger_name, ', ')
       from private.account_lifecycle_referential_action_trigger_issues() i);
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after nominations';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle export ownership inventory is incomplete after nominations';
  end if;
end;
$assert_nominations_lifecycle$;

notify pgrst, 'reload schema';

commit;
