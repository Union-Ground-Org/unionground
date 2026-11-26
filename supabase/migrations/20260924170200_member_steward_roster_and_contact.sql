-- Versioned migration. Dependency order: 20260924170000_organization_structure_import
-- -> 20260924170100_appointment_organization_boundary -> this file ->
-- 20260924170300_member_organization_structure.
--
-- REQ-UG-MEMBER-FIND-MY-STEWARD-HOME-ENTRY-20260922.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. One copy of the chapter predicate.
--
-- private.member_stewards_for_chapter and private.appointment_stewards_for_chapter
-- are defined once, in 20260924170100_appointment_organization_boundary.sql,
-- which is applied first. This migration consumes the shared helper and never
-- redefines it.

-- Home retains its additional profile-chapter organization restriction.
-- The shared helper already requires active, non-revoked tenant membership;
-- this additional projection restriction does not widen appointment eligibility.
create function private.member_roster_stewards_for_chapter(p_chapter text)
returns table (steward_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select e.steward_id
  from private.member_stewards_for_chapter(p_chapter) e
  join public.member_profiles sp on sp.id = e.steward_id
  join public.chapters steward_chapter on steward_chapter.id = sp.chapter_id
  join public.chapters caller_chapter on caller_chapter.id = p_chapter
  where steward_chapter.organization_id is not null
    and steward_chapter.organization_id = caller_chapter.organization_id
    -- Membership, not merely a profile pointing at a chapter of the tenant.
    and exists (
      select 1 from public.organization_memberships om
      where om.organization_id = caller_chapter.organization_id
        and om.user_id = e.steward_id
        and om.status = 'active'
    )
    -- The steward's own active membership of THIS chapter. A legacy role row
    -- can outlive the chapter it names (revocation keeps it while another
    -- chapter grant remains), so a steward revoked from, or never admitted to,
    -- this chapter is never published on its roster or bindable from it.
    and exists (
      select 1 from public.member_chapter_memberships scm
      where scm.user_id = e.steward_id
        and scm.chapter_id = p_chapter
        and scm.status = 'active'
    )
$$;

revoke all on function private.member_roster_stewards_for_chapter(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Steward contact visibility. Default is no row, which is no direct channel:
-- the in-app conversation is the only contact affordance until a steward
-- publishes one themselves. There is no writer that takes a steward id, so no
-- caller can publish another steward's address or number.
create table public.steward_contact_preferences (
  steward_user_id uuid primary key references auth.users(id) on delete cascade,
  share_email boolean not null default false,
  share_phone boolean not null default false,
  contact_email text,
  contact_phone text,
  updated_at timestamptz not null default pg_catalog.now(),
  constraint steward_contact_preferences_email_bounded check (
    contact_email is null or (
      pg_catalog.char_length(pg_catalog.btrim(contact_email)) between 3 and 320
      and contact_email !~ '[[:cntrl:]]'
      and contact_email like '%_@_%'
    )
  ),
  constraint steward_contact_preferences_phone_bounded check (
    contact_phone is null or (
      pg_catalog.char_length(pg_catalog.btrim(contact_phone)) between 7 and 40
      and contact_phone ~ '^[0-9+().\- ]+$'
    )
  ),
  -- A shared channel must have a value. This is the same refusal the writer
  -- raises, pinned in the schema so no future writer can bypass it.
  constraint steward_contact_preferences_email_present check (
    not share_email or contact_email is not null
  ),
  constraint steward_contact_preferences_phone_present check (
    not share_phone or contact_phone is not null
  )
);

alter table public.steward_contact_preferences enable row level security;

-- Self-only read, kept as a policy so the table is never accidentally readable
-- if a grant is added later. No insert/update/delete policy and NO grant of any
-- kind: both RPCs below are security definer, so there is no direct client path
-- to this table at all, and a member never reads it even for their own steward.
create policy steward_contact_preferences_select_own on public.steward_contact_preferences
  for select to authenticated
  using ((select auth.uid()) = steward_user_id);

comment on policy steward_contact_preferences_select_own on public.steward_contact_preferences is
  'Self-only read of a steward''s own contact preference. Defense in depth: the table has no '
  'client grant and is reached only through the security definer member contact RPCs; members '
  'never read it, even for their own steward.';

revoke all on public.steward_contact_preferences from public, anon, authenticated, service_role;

create function private.caller_is_steward()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.member_roles r
    where r.user_id = (select auth.uid()) and r.role = 'steward'
  )
$$;

revoke all on function private.caller_is_steward() from public, anon, authenticated;

create function public.get_my_steward_contact_visibility()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  row_found public.steward_contact_preferences%rowtype;
begin
  -- Reading one's own row needs only an MFA-assured session. A steward who has
  -- lost the chapter, the organization or the role must still be able to see
  -- what they shared so they can withdraw it; nobody else's row is reachable.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into row_found from public.steward_contact_preferences p where p.steward_user_id = caller;
  return pg_catalog.jsonb_build_object(
    'shareEmail', coalesce(row_found.share_email, false),
    'sharePhone', coalesce(row_found.share_phone, false),
    'contactEmail', row_found.contact_email,
    'contactPhone', row_found.contact_phone
  );
end;
$$;

revoke all on function public.get_my_steward_contact_visibility() from public, anon;
grant execute on function public.get_my_steward_contact_visibility() to authenticated;

create function public.set_my_steward_contact_visibility(
  p_share_email boolean,
  p_share_phone boolean,
  p_contact_email text,
  p_contact_phone text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  clean_email text := nullif(pg_catalog.btrim(coalesce(p_contact_email, '')), '');
  clean_phone text := nullif(pg_catalog.btrim(coalesce(p_contact_phone, '')), '');
  share_email boolean := coalesce(p_share_email, false);
  share_phone boolean := coalesce(p_share_phone, false);
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if share_email and clean_email is null then
    raise exception 'an email address is required to share email' using errcode = '22023';
  end if;
  if share_phone and clean_phone is null then
    raise exception 'a phone number is required to share phone' using errcode = '22023';
  end if;

  -- Withdrawal outlives eligibility. A caller who can no longer publish (no
  -- current organization, chapter or steward role) may still turn both
  -- channels off and clear the stored values on their own existing row. It
  -- never creates a row and never publishes anything.
  if private.current_member_organization() is null or not private.caller_is_steward() then
    if share_email or share_phone then
      raise exception 'not authorized' using errcode = '42501';
    end if;
    update public.steward_contact_preferences p
    set share_email = false,
        share_phone = false,
        contact_email = clean_email,
        contact_phone = clean_phone,
        updated_at = pg_catalog.now()
    where p.steward_user_id = caller;
    return public.get_my_steward_contact_visibility();
  end if;

  insert into public.steward_contact_preferences as p (
    steward_user_id, share_email, share_phone, contact_email, contact_phone, updated_at
  ) values (caller, share_email, share_phone, clean_email, clean_phone, pg_catalog.now())
  on conflict (steward_user_id) do update set
    share_email = excluded.share_email,
    share_phone = excluded.share_phone,
    contact_email = excluded.contact_email,
    contact_phone = excluded.contact_phone,
    updated_at = excluded.updated_at;

  return public.get_my_steward_contact_visibility();
end;
end;
$$;

revoke all on function public.set_my_steward_contact_visibility(boolean, boolean, text, text) from public, anon;
grant execute on function public.set_my_steward_contact_visibility(boolean, boolean, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The Find-my-steward roster.
--
-- A sibling projection over the same chapter scoping, not a second copy of it.
-- It returns the caller's own chapter only, and a contact channel only where
-- the steward opted in; the in-app conversation is always offered.
create function public.get_member_chapter_stewards()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  chapter_label text;
begin
  if caller is null or not private.mfa_satisfied()
     or private.current_member_organization() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    raise exception 'member chapter required' using errcode = '22023';
  end if;
  select c.name into chapter_label from public.chapters c where c.id = caller_chapter;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', e.steward_id,
      'name', profile.full_name,
      'roleLabel', 'steward',
      'chapterId', caller_chapter,
      'chapterLabel', chapter_label,
      'acceptsAppointments', exists (
        select 1 from public.member_appointment_schedules s
        where s.steward_id = e.steward_id and s.accepting
      ),
      'contact', pg_catalog.jsonb_build_object(
        'conversation', true,
        'email', case when coalesce(pref.share_email, false) then pref.contact_email end,
        'phone', case when coalesce(pref.share_phone, false) then pref.contact_phone end
      )
    ) order by profile.full_name, e.steward_id)
    from private.member_roster_stewards_for_chapter(caller_chapter) e
    left join public.member_profiles profile on profile.id = e.steward_id
    left join public.steward_contact_preferences pref on pref.steward_user_id = e.steward_id
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_member_chapter_stewards() from public, anon;
grant execute on function public.get_member_chapter_stewards() to authenticated;

comment on function public.get_member_chapter_stewards() is
  'Find my steward: the caller''s own chapter stewards with opted-in contact channels. '
  'Widens past private.appointment_stewards_for_chapter''s accepting subset on purpose so a '
  'member can reach a steward who takes no appointments; both read one chapter predicate in '
  'private.member_stewards_for_chapter, and the roster adds the organization predicate that '
  'stops a null-chapter steward row from crossing tenants.';

-- ---------------------------------------------------------------------------
-- 4. Selected-steward conversation binding.
--
-- Null means "opened outside a steward card" and is what every existing row
-- keeps, so the canonical member<->steward thread behaves exactly as before.
alter table public.member_conversations
  add column steward_user_id uuid references auth.users(id) on delete set null;

create index member_conversations_user_steward_idx
  on public.member_conversations (user_id, steward_user_id);

comment on column public.member_conversations.steward_user_id is
  'The steward a member chose from a steward card. Null for the canonical thread and for '
  'every conversation opened outside a card; a per-steward Contact control resolves on this '
  'column so each card reaches its own thread. Routing only, not a visibility boundary: '
  'member_conversations_select_steward still lets every steward who can see the member read '
  'every thread of that member, bound or not.';

-- Conversation and first message stay one transaction, so a steward-bound
-- conversation can never be stranded empty. The two outer blocks are the same
-- case-graph and message-lifecycle wrappers every installed conversation
-- writer carries, so this writer takes the global locks in the same order. Unlike start_member_conversation
-- the uniqueness guard is per (member, steward): the canonical thread does not
-- block a bound thread, and a repeat Contact returns the existing one.
create function public.start_member_steward_conversation(p_steward_user_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  caller uuid := (select auth.uid());
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''), ' ' || pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(12) || pg_catalog.chr(11));
  caller_chapter text;
  conversation_id uuid;
  steward_name text;
  created boolean := false;
  sent jsonb;
begin
  if caller is null or not private.mfa_satisfied()
     or private.current_member_organization() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_steward_user_id is null then
    raise exception 'a steward is required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_body) not between 1 and 4000 then
    raise exception 'message must be between 1 and 4000 characters' using errcode = '22023';
  end if;

  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    raise exception 'member chapter required' using errcode = '22023';
  end if;

  -- The member may only bind a conversation to a steward the roster would have
  -- shown them. Same organization-scoped helper the roster reads, so the write
  -- can never reach one steward further than the read.
  if not exists (
    select 1 from private.member_roster_stewards_for_chapter(caller_chapter) e
    where e.steward_id = p_steward_user_id
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(caller::text || ':' || p_steward_user_id::text, 0));

  select c.id into conversation_id
  from public.member_conversations c
  where c.user_id = caller and c.steward_user_id = p_steward_user_id
  limit 1;

  if conversation_id is null then
    select p.full_name into steward_name
    from public.member_profiles p where p.id = p_steward_user_id;
    steward_name := coalesce(nullif(pg_catalog.btrim(coalesce(steward_name, '')), ''), 'Chapter steward');
    -- Two-argument pg_catalog.substring(string, pattern): the SQL `substring(x
    -- from y)` spelling cannot be schema-qualified, and search_path is ''.
    insert into public.member_conversations (user_id, title, initials, steward_user_id)
    values (
      caller,
      steward_name,
      pg_catalog.upper(
        pg_catalog.left(steward_name, 1)
        || coalesce(pg_catalog.substring(steward_name, ' (.)'), 'S')),
      p_steward_user_id
    )
    returning id into conversation_id;
    created := true;
  end if;

  -- Reuse the sole message writer so trimming, sender derivation, points
  -- minting and the conversation touch keep one definition.
  sent := public.send_member_message(conversation_id, clean_body);
  return sent || pg_catalog.jsonb_build_object(
    'conversationId', conversation_id,
    'stewardUserId', p_steward_user_id,
    'created', created);
end;
end;
end;
$$;

revoke all on function public.start_member_steward_conversation(uuid, text) from public, anon;
grant execute on function public.start_member_steward_conversation(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The general steward thread coexists with selected-steward threads.
--
-- Re-emitted from the INSTALLED definition, not from
-- 20260810220000_member_start_conversation.sql: 20260907122000 and
-- 20260907150000 wrapped it in the message-lifecycle and case-graph locks, and
-- both wrappers are kept byte-for-byte. The only change is that the one-thread
-- refusal counts only the general thread (steward_user_id is null). Before
-- this change a member who first used a steward card could never open the
-- general "Chapter steward" thread.
create or replace function public.start_member_conversation(p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  caller uuid := (select auth.uid());
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''), ' ' || pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(12) || pg_catalog.chr(11));
  conversation_id uuid;
  sent jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_body) not between 1 and 4000 then
    raise exception 'message must be between 1 and 4000 characters' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text, 0));
  if exists (
    select 1 from public.member_conversations c
    where c.user_id = caller and c.steward_user_id is null
  ) then
    raise exception 'a direct conversation already exists' using errcode = '23505';
  end if;

  insert into public.member_conversations (user_id, title, initials)
  values (caller, 'Chapter steward', 'CS')
  returning id into conversation_id;

  -- Reuse the current sole message writer so trimming, sender derivation,
  -- points minting, and the conversation touch retain one definition.
  sent := public.send_member_message(conversation_id, clean_body);
  return sent || pg_catalog.jsonb_build_object('conversationId', conversation_id);
end;
end;
end;
$function$;

revoke all on function public.start_member_conversation(text) from public, anon;
grant execute on function public.start_member_conversation(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Account-lifecycle registration.
--
-- BUG-UG-ACCOUNT-LIFECYCLE-REGRESSION-20260831 owns every deletion and
-- export disposition. This migration adds two direct auth.users links.

-- Both steward keys join the row lock set account deletion takes: the
-- preference row cascades with its steward, and a bound conversation detaches
-- its steward reference (ON DELETE SET NULL) when that steward is deleted.
create trigger a00_case_graph_lock before insert or update or delete on public.steward_contact_preferences
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.steward_contact_preferences
for each row execute function private.lock_case_graph_row_keys('{steward_user_id}', '');

drop trigger z99_case_graph_keys on public.member_conversations;
create trigger z99_case_graph_keys before insert or update or delete on public.member_conversations
for each row execute function private.lock_case_graph_row_keys('{steward_user_id},{user_id}', '');

insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition,
   export_disposition, export_projection, export_inventory_basis,
   export_projection_version, export_domain, export_columns,
   exclusion_reason, note, reviewed_at)
values
  ('public', 'steward_contact_preferences', 'steward_user_id', 'cascade',
   'included', 'additional_domains', 'auth_user_fk',
   1, 'additionalDomains.steward_contact_preferences',
   array['steward_user_id','share_email','share_phone','contact_email','contact_phone','updated_at']::text[],
   null,
   'The steward''s own published contact choices and values. Exported only to that steward; deleted with the account.',
   date '2026-09-23'),
  ('public', 'member_conversations', 'steward_user_id', 'pseudonymize',
   'excluded_with_reason', null, 'auth_user_fk',
   null, null, null,
   'The conversation is the member''s. It is exported to the member under the canonical conversations projection, which now carries stewardUserId; the steward''s own authored messages are exported to the steward by sender identity.',
   'Installed action is ON DELETE SET NULL; a departed steward detaches from the member''s thread, which survives.',
   date '2026-09-23');

create function private.account_lifecycle_export_steward_contact_preferences(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('steward_user_id', t.steward_user_id, 'share_email', t.share_email, 'share_phone', t.share_phone, 'contact_email', t.contact_email, 'contact_phone', t.contact_phone, 'updated_at', t.updated_at)), '[]'::jsonb) from public.steward_contact_preferences t where t.steward_user_id = p_caller; $export$; revoke all on function private.account_lifecycle_export_steward_contact_preferences(uuid) from public, anon, authenticated, service_role;

-- Re-emitted from 20260907150000_account_lifecycle_manifest.sql with one added
-- domain; every other key is unchanged.
create or replace function private.account_lifecycle_export_additional_domains(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $export$
  select pg_catalog.jsonb_build_object(
    'chapter_channel_poll_votes', private.account_lifecycle_export_chapter_channel_poll_votes(p_caller), 'chapter_task_watchers', private.account_lifecycle_export_chapter_task_watchers(p_caller), 'chapter_thread_posts', private.account_lifecycle_export_chapter_thread_posts(p_caller), 'chapter_threads', private.account_lifecycle_export_chapter_threads(p_caller), 'compass_message_briefings', private.account_lifecycle_export_compass_message_briefings(p_caller), 'compass_workspace_preferences', private.account_lifecycle_export_compass_workspace_preferences(p_caller), 'member_ballot_votes', private.account_lifecycle_export_member_ballot_votes(p_caller), 'member_broadcast_receipts', private.account_lifecycle_export_member_broadcast_receipts(p_caller), 'member_chapter_memberships', private.account_lifecycle_export_member_chapter_memberships(p_caller), 'member_emergency_checklists', private.account_lifecycle_export_member_emergency_checklists(p_caller), 'member_message_reactions', private.account_lifecycle_export_member_message_reactions(p_caller), 'member_message_reminders', private.account_lifecycle_export_member_message_reminders(p_caller), 'member_message_resources', private.account_lifecycle_export_member_message_resources(p_caller), 'member_qa_votes', private.account_lifecycle_export_member_qa_votes(p_caller), 'member_report_preferences', private.account_lifecycle_export_member_report_preferences(p_caller), 'member_reward_tier_attainment', private.account_lifecycle_export_member_reward_tier_attainment(p_caller), 'member_saved_messages', private.account_lifecycle_export_member_saved_messages(p_caller), 'member_weekly_question_promotions', private.account_lifecycle_export_member_weekly_question_promotions(p_caller), 'member_weekly_question_supports', private.account_lifecycle_export_member_weekly_question_supports(p_caller), 'member_weekly_questions', private.account_lifecycle_export_member_weekly_questions(p_caller), 'organization_engagement_events', private.account_lifecycle_export_organization_engagement_events(p_caller), 'organization_live_poll_votes', private.account_lifecycle_export_organization_live_poll_votes(p_caller), 'organization_memberships', private.account_lifecycle_export_organization_memberships(p_caller), 'organization_pulse_events', private.account_lifecycle_export_organization_pulse_events(p_caller), 'steward_contact_preferences', private.account_lifecycle_export_steward_contact_preferences(p_caller)
  );
$export$;

revoke all on function private.account_lifecycle_export_additional_domains(uuid) from public, anon, authenticated, service_role;

-- Re-emitted from 20260907150000_account_lifecycle_manifest.sql; the only
-- change is stewardUserId on each exported conversation.
create or replace function private.member_data_export_without_peer_contact()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid;
  exported jsonb;
  records integer;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  caller := (select auth.uid());
  records := 0;
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select pg_catalog.jsonb_build_object('schemaVersion', 1,
    'generatedAt', now(),
    'account', pg_catalog.jsonb_build_object(
      'userId', caller,
      'email', (select u.email from auth.users u where u.id = caller),
      'profile', coalesce((
        select pg_catalog.jsonb_build_object(
          'firstName', p.first_name, 'fullName', p.full_name,
          'initials', p.initials, 'roleLine', p.role_line,
          'memberSince', p.member_since, 'language', p.language,
          'chapterId', p.chapter_id, 'createdAt', p.created_at,
          'updatedAt', p.updated_at)
        from public.member_profiles p where p.id = caller
      ), '{}'::jsonb),
      'roles', coalesce((select pg_catalog.jsonb_agg(r.role order by r.role)
        from public.member_roles r where r.user_id = caller), '[]'::jsonb)
    ),
    'notifications', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', n.id, 'title', n.title, 'body', n.body, 'kind', n.kind,
      'readAt', n.read_at, 'createdAt', n.created_at) order by n.created_at)
      from public.member_notifications n where n.user_id = caller), '[]'::jsonb),
    'conversations', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id, 'title', c.title, 'createdAt', c.created_at, 'updatedAt', c.updated_at,
      'stewardUserId', c.steward_user_id,
      'messages', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', m.id, 'senderKind', m.sender_kind, 'senderName', m.sender_name,
        'body', m.body, 'redactedAt', m.redacted_at, 'redactionReason', m.redaction_reason,
        'bodySha256', m.body_sha256, 'originalLength', m.original_length,
        'readAt', m.read_at, 'createdAt', m.created_at) order by m.created_at)
        from public.member_messages m
        where m.conversation_id = c.id
          and (m.user_id = caller or m.sender_id = caller)), '[]'::jsonb)
      ) order by c.created_at) from public.member_conversations c where c.user_id = caller), '[]'::jsonb),
    'cases', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id, 'reference', c.reference, 'title', c.title, 'deadline', c.deadline,
      'caseType', c.case_type, 'articles', c.articles, 'step', c.step,
      'status', c.status, 'createdAt', c.created_at, 'updatedAt', c.updated_at,
      'updates', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', u.id, 'body', u.body, 'createdAt', u.created_at) order by u.created_at)
        from public.member_case_updates u where u.case_id = c.id and u.user_id = caller), '[]'::jsonb)
      ) order by c.created_at) from public.member_cases c where c.user_id = caller), '[]'::jsonb),
    'forms', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', f.id, 'templateKey', f.template_key, 'templateVersion', f.template_version,
      'status', f.status, 'answers', f.answers, 'step', f.step,
      'reviewNote', f.review_note, 'reviewedAt', f.reviewed_at,
      'submittedAt', f.submitted_at, 'createdAt', f.created_at, 'updatedAt', f.updated_at,
      'cosigners', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'status', c.status, 'invitedAt', c.invited_at, 'respondedAt', c.responded_at)
        order by c.invited_at) from public.member_form_cosigners c where c.form_id = f.id), '[]'::jsonb)
      ) order by f.created_at) from public.member_forms f where f.user_id = caller), '[]'::jsonb),
    'participation', pg_catalog.jsonb_build_object(
      'ballotReceipts', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'ballotId', r.ballot_id, 'receiptCode', r.receipt_code,
        'counted', r.counted, 'issuedAt', r.issued_at) order by r.issued_at)
        from public.member_ballot_receipts r where r.user_id = caller), '[]'::jsonb),
      'surveyResponses', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'surveyId', s.survey_id, 'optionId', s.option_id, 'submittedAt', s.submitted_at)
        order by s.submitted_at) from public.member_survey_responses s where s.user_id = caller), '[]'::jsonb),
      'rightsProgress', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'lessonId', r.lesson_id, 'completedSteps', r.completed_steps, 'updatedAt', r.updated_at)
        order by r.updated_at) from public.member_rights_progress r where r.user_id = caller), '[]'::jsonb),
      'eventRsvps', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'eventId', r.event_id, 'status', r.status, 'createdAt', r.created_at, 'updatedAt', r.updated_at)
        order by r.created_at) from public.member_event_rsvps r where r.user_id = caller), '[]'::jsonb),
      'eventCheckins', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'eventId', c.event_id, 'checkedInAt', c.checked_in_at) order by c.checked_in_at)
        from public.member_event_checkins c where c.user_id = caller), '[]'::jsonb)
    ),
    'support', pg_catalog.jsonb_build_object(
      'stewardRequests', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'lessonId', r.lesson_id, 'status', r.status,
        'createdAt', r.created_at, 'acknowledgedAt', r.acknowledged_at, 'closedAt', r.closed_at)
        order by r.created_at) from public.member_steward_requests r where r.user_id = caller), '[]'::jsonb),
      'appointments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id, 'chapterId', a.chapter_id, 'appointmentType', a.appointment_type,
        'durationMinutes', a.duration_minutes, 'startsAt', a.starts_at, 'endsAt', a.ends_at,
        'status', a.status, 'routedVia', a.routed_via, 'reasonCategory', a.reason_category,
        'createdAt', a.created_at, 'updatedAt', a.updated_at) order by a.created_at)
        from public.member_appointments a where a.user_id = caller), '[]'::jsonb),
      'intakeReports', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', i.id, 'chapterId', i.chapter_id, 'category', i.category, 'title', i.title,
        'details', i.details, 'status', i.status, 'createdAt', i.created_at, 'updatedAt', i.updated_at)
        order by i.created_at) from public.member_intake_reports i where i.reporter_id = caller), '[]'::jsonb),
      'dataRequests', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', g.id, 'chapterId', g.chapter_id, 'requestType', g.request_type,
        'details', g.details, 'status', g.status, 'response', g.response,
        'createdAt', g.created_at, 'updatedAt', g.updated_at) order by g.created_at)
        from public.chapter_governance_requests g where g.requester_id = caller), '[]'::jsonb)
    ),
    'compass', pg_catalog.jsonb_build_object(
      'threads', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', t.id, 'title', t.title, 'createdAt', t.created_at, 'updatedAt', t.updated_at,
        'messages', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', m.id, 'role', m.role, 'body', m.body, 'sources', m.sources, 'createdAt', m.created_at)
          order by m.created_at) from public.member_guide_messages m
          where m.thread_id = t.id and m.user_id = caller), '[]'::jsonb)) order by t.created_at)
        from public.member_guide_threads t where t.user_id = caller), '[]'::jsonb),
      'requestHistory', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'createdAt', r.created_at, 'role', r.compass_role,
        'limit', r.compass_limit, 'dispatchAuthorizedAt', r.dispatch_authorized_at)
        order by r.created_at) from public.member_ai_requests r where r.user_id = caller), '[]'::jsonb)
    ),
    'activity', pg_catalog.jsonb_build_object(
      'points', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'actionKey', p.action_key, 'actionKind', p.action_kind,
        'points', p.points, 'occurredAt', p.occurred_at) order by p.occurred_at)
        from public.member_point_events p where p.user_id = caller), '[]'::jsonb),
      'rewards', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'itemKey', r.item_key, 'status', r.status, 'source', r.source,
        'reason', r.reason, 'note', r.note, 'createdAt', r.created_at, 'updatedAt', r.updated_at)
        order by r.created_at) from public.member_reward_grants r where r.user_id = caller), '[]'::jsonb),
      'workload', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(w) - 'user_id' order by w.created_at)
        from public.member_workload_logs w where w.user_id = caller), '[]'::jsonb),
      'actions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'actionKey', a.action_key, 'actionKind', a.action_kind, 'occurredAt', a.occurred_at)
        order by a.occurred_at) from public.member_action_log a where a.user_id = caller), '[]'::jsonb)
    ),
    'chapterParticipation', pg_catalog.jsonb_build_object(
      'spaceMemberships', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'spaceId', m.space_id, 'role', m.role,
        'joinedAt', m.joined_at) order by m.joined_at)
        from public.chapter_space_members m where m.user_id = caller), '[]'::jsonb),
      'taskAssignments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'taskId', a.task_id, 'chapterId', a.chapter_id, 'position', a.position, 'assignedAt', a.assigned_at)
        order by a.assigned_at) from public.chapter_task_assignments a where a.assignee_id = caller), '[]'::jsonb),
      'taskComments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'taskId', c.task_id, 'chapterId', c.chapter_id,
        'body', c.body, 'createdAt', c.created_at) order by c.created_at)
        from public.chapter_task_comments c where c.author_id = caller), '[]'::jsonb),
      'taskMessages', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', m.id, 'taskId', m.task_id, 'chapterId', m.chapter_id,
        'direction', case when m.sender_id = caller then 'sent' else 'received' end,
        'body', m.body, 'createdAt', m.created_at) order by m.created_at)
        from public.chapter_task_messages m where m.sender_id = caller or m.recipient_id = caller), '[]'::jsonb)
    )
  ) into exported;

  select coalesce(pg_catalog.sum(pg_catalog.jsonb_array_length(value)), 0)::integer
    into records
  from pg_catalog.jsonb_each(exported) section
  where pg_catalog.jsonb_typeof(value) = 'array';

  insert into private.member_account_lifecycle_audit (subject_hash, event_type, record_count)
  values (private.member_lifecycle_subject_hash(caller), 'export_generated', records);

  return exported || pg_catalog.jsonb_build_object('topLevelRecordCount', records);
end;
$$;

-- The re-created member_conversations key trigger and the two new preference
-- triggers enter the reviewed trigger surface with hashes from the surface.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger'
  and schema_name = 'public'
  and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys')
  and table_name in ('steward_contact_preferences', 'member_conversations')
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_member_steward_account_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'account lifecycle deletion inventory is incomplete after the member steward roster draft';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle export ownership inventory is incomplete after the member steward roster draft';
  end if;
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the member steward roster draft';
  end if;
end;
$assert_member_steward_account_lifecycle$;

commit;
